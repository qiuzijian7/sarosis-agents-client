/*---------------------------------------------------------------------------------------------
 *  executionGraph — pure graph analysis for workflow-wide Comfy execution (P0).
 *
 *  Given the framework-agnostic store nodes/edges, compute a topological
 *  execution order and per-node upstream dependencies so the Run button can
 *  execute the whole canvas upstream-first, with media outputs landing in the
 *  shared snapshot store before their downstream consumers run.
 *
 *  All functions are pure and DOM-free → unit/e2e testable.
 *--------------------------------------------------------------------------------------------*/

export interface ExecutionNodeLike {
	id: string;
	type?: string;
}

export interface ExecutionEdgeLike {
	source: string;
	target: string;
	/** W2 端口感知路由：出边端口名（store 持久化 sourceHandle；缺省=always-active 兼容存量图） */
	sourceHandle?: string;
	/** W2 端口感知路由：入边端口名（当前路由判定只消费 sourceHandle，保留透传） */
	targetHandle?: string;
}

export interface ExecutionOrder {
	/** Node ids in a valid dependency order (upstream first). */
	order: string[];
	/** True when the graph contains a cycle — order is then only the acyclic prefix. */
	hasCycle: boolean;
}

/**
 * Kahn's algorithm. Pure. Returns node ids in execution order (upstream first).
 * Dangling edges (unknown source/target) are ignored.
 */
export function computeExecutionOrder(nodes: ExecutionNodeLike[], edges: ExecutionEdgeLike[]): ExecutionOrder {
	const indegree = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const n of nodes) {
		indegree.set(n.id, 0);
		adj.set(n.id, []);
	}
	for (const e of edges) {
		if (!adj.has(e.source) || !indegree.has(e.target)) { continue; }
		adj.get(e.source)!.push(e.target);
		indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
	}
	const queue: string[] = [];
	for (const [id, deg] of indegree) {
		if (deg === 0) { queue.push(id); }
	}
	const order: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift()!;
		order.push(id);
		for (const next of adj.get(id) ?? []) {
			const d = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, d);
			if (d === 0) { queue.push(next); }
		}
	}
	return { order, hasCycle: order.length < nodes.length };
}

/** Direct upstream node ids (nodes with an edge → nodeId). Pure. */
export function collectUpstreamNodeIds(nodeId: string, edges: ExecutionEdgeLike[]): string[] {
	const result: string[] = [];
	for (const e of edges) {
		if (e.target === nodeId && !result.includes(e.source)) { result.push(e.source); }
	}
	return result;
}

/** One node selected for execution. */
export interface ExecutableStep {
	id: string;
	type: string;
	/** upstream node ids connected into this node (snapshot flow, P1+) */
	upstreams: string[];
}

export interface ExecutionPlan {
	/** Executable nodes in execution order. */
	steps: ExecutableStep[];
	/** True when the whole graph contains a cycle (execution must stop). */
	hasCycle: boolean;
	/** Node ids that were filtered out (not executable, e.g. Saros orchestration). */
	skipped: string[];
}

/**
 * Build a workflow-wide execution plan:
 *  1. topological order over ALL nodes (upstream-first),
 *  2. keep only executable nodes (per `isExecutable`),
 *  3. attach each step's direct upstreams (for future snapshot injection).
 * Pure.
 */
export function buildExecutionPlan(
	nodes: ExecutionNodeLike[],
	edges: ExecutionEdgeLike[],
	isExecutable: (type: string) => boolean,
): ExecutionPlan {
	const { order, hasCycle } = computeExecutionOrder(nodes, edges);
	const steps: ExecutableStep[] = [];
	const skipped: string[] = [];
	for (const id of order) {
		const node = nodes.find(n => n.id === id);
		if (!node) { continue; }
		if (isExecutable(node.type ?? '')) {
			steps.push({ id, type: node.type ?? '', upstreams: collectUpstreamNodeIds(id, edges) });
		} else {
			skipped.push(id);
		}
	}
	return { steps, hasCycle, skipped };
}

// ─── W2: port-aware branch routing (n8n/Rivet style) ─────────────────────────
//
// 语义（对照设计文档 doc/workflow-hybrid-controlflow-analysis.md §3 W2）：
//   * gate 节点（Saros.IfElse 双输出 true/false）执行后给出 branch 结果；
//   * 出边带 sourceHandle 时，仅 handle === branch 的边"点火"；
//   * 无 sourceHandle 的边 = always-active（存量图零迁移，行为不变）；
//   * 非_gate_ 源节点的边 = always-active（数据流边不受路由影响）；
//   * 节点 active 判定 = 存在至少一条「active 且 source 未被 skip」的入边；
//     无入边节点恒 active。skip 沿拓扑序单遍传播。
// 纯函数、DOM-free → 可单测。

/**
 * 单条边在当前 gate 路由状态下是否激活。
 * @param branchOf gate 节点 id → 已判定的分支名（'true'/'false'/case 名）
 * @param gateNodeIds 已知 gate 节点集合（仅对 gate 源消费 branch）
 */
export function isEdgeActive(
	edge: ExecutionEdgeLike,
	branchOf: ReadonlyMap<string, string>,
	gateNodeIds: ReadonlySet<string>,
): boolean {
	if (!gateNodeIds.has(edge.source)) { return true; }
	const branch = branchOf.get(edge.source);
	if (branch === undefined) { return true; } // gate 尚未执行 → 视为 active（顺序到达时已执行）
	if (edge.sourceHandle === undefined || edge.sourceHandle === '') { return true; } // 兼容存量
	return edge.sourceHandle === branch;
}

/**
 * 计算给定路由状态下的节点激活表（skip 传播）。
 * 返回 inactive 节点集合 = 应被跳过的节点（含传导下游）。
 * 仅传播，不执行；调用方（调度器）在每步执行前查询。
 */
export function computeInactiveNodes(
	nodes: ExecutionNodeLike[],
	edges: ExecutionEdgeLike[],
	branchOf: ReadonlyMap<string, string>,
	gateNodeIds: ReadonlySet<string>,
): Set<string> {
	const order = computeExecutionOrder(nodes, edges).order;
	const inactive = new Set<string>();
	for (const id of order) {
		const inbound = edges.filter(e => e.target === id);
		if (inbound.length === 0) { continue; } // 无入边 → 恒 active
		const hasActive = inbound.some(e => isEdgeActive(e, branchOf, gateNodeIds) && !inactive.has(e.source));
		if (!hasActive) { inactive.add(id); }
	}
	return inactive;
}

// ─── Parallel execution plan (docs/Agent-画布编排设计方案.md P1) ─────────────

/**
 * Parallel execution layers. Each layer is a set of steps that are mutually
 * independent (no edges among them given a valid topological ordering), so they
 * MAY run concurrently. Layers must be run as barriers: all steps in layer i
 * finish before any step in layer i+1 starts — this preserves the "upstream
 * snapshots are available before downstream consumers run" invariant.
 *
 * The layer list preserves Kahn's ordering: within a layer the original
 * topological order is kept (deterministic), across layers every edge goes from
 * an earlier layer to a later one.
 */
export interface ParallelExecutionPlan {
	/** Layers of executable step ids, in execution order (barrier between layers). */
	layers: ExecutableStep[][];
	hasCycle: boolean;
	skipped: string[];
}

/**
 * Build a parallel execution plan by grouping the topological order into
 * "waves" of independent steps:
 *   - layer 0 = all nodes with indegree 0,
 *   - layer k = nodes whose every upstream is in layers < k.
 *
 * Runs in O(V + E) via a modified Kahn pass that records the max upstream layer.
 * Pure + DOM-free.
 */
export function buildParallelExecutionPlan(
	nodes: ExecutionNodeLike[],
	edges: ExecutionEdgeLike[],
	isExecutable: (type: string) => boolean,
): ParallelExecutionPlan {
	const indegree = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const n of nodes) {
		indegree.set(n.id, 0);
		adj.set(n.id, []);
	}
	for (const e of edges) {
		if (!adj.has(e.source) || !indegree.has(e.target)) { continue; }
		adj.get(e.source)!.push(e.target);
		indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
	}

	const layerOf = new Map<string, number>();
	const queue: string[] = [];
	for (const [id, deg] of indegree) {
		if (deg === 0) { queue.push(id); layerOf.set(id, 0); }
	}

	let orderCount = 0;
	while (queue.length > 0) {
		const id = queue.shift()!;
		orderCount++;
		for (const next of adj.get(id) ?? []) {
			const d = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, d);
			if (d === 0) { queue.push(next); }
			// A node's layer = max(layer of its already-processed upstreams) + 1.
			const candidate = (layerOf.get(id) ?? 0) + 1;
			layerOf.set(next, Math.max(layerOf.get(next) ?? 0, candidate));
		}
	}

	const hasCycle = orderCount < nodes.length;
	if (hasCycle) {
		return { layers: [], hasCycle, skipped: nodes.map(n => n.id) };
	}

	// Group executable nodes by layer (keeping topological order within layers).
	const maxLayer = [...layerOf.values()].reduce((a, b) => Math.max(a, b), -1);
	const layerBuckets: Array<{ step: ExecutableStep }>[] = [];
	for (let i = 0; i <= maxLayer; i++) { layerBuckets.push([]); }
	const skipped: string[] = [];
	for (const n of nodes) {
		const l = layerOf.get(n.id) ?? 0;
		const executable = isExecutable(n.type ?? '');
		if (executable) {
			const step: ExecutableStep = { id: n.id, type: n.type ?? '', upstreams: collectUpstreamNodeIds(n.id, edges) };
			layerBuckets[l].push({ step });
		} else {
			skipped.push(n.id);
		}
	}

	const layers = layerBuckets
		.filter(b => b.length > 0)
		.map(b => b.map(x => x.step));

	return { layers, hasCycle, skipped };
}
