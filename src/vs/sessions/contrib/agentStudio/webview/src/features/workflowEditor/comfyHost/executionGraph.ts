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

/**
 * 可达**下游闭包**（rootIds 自身不含）。BFS + visited，含环图也安全（不会死循环）。
 *
 * 用途：某个节点失败/被跳过时，把「连累到的下游」一次性标 skipped —— 语义与 host 引擎的
 * `_cascadeSkipDownstream`（browser/workflowExecutionService.ts）一致：**只跳失败节点的可达
 * 下游，独立并行分支不受影响**。此前 webview 侧失败后直接 return，下游卡片停在 idle，
 * 用户无法区分「没跑到」与「被上游失败连累」。Pure + DOM-free。
 */
export function collectDownstreamClosure(
	rootIds: readonly string[],
	edges: ExecutionEdgeLike[],
): Set<string> {
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		const list = adj.get(e.source);
		if (list) { list.push(e.target); } else { adj.set(e.source, [e.target]); }
	}
	const seen = new Set<string>(rootIds);
	const out = new Set<string>();
	const queue = [...rootIds];
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const next of adj.get(id) ?? []) {
			if (seen.has(next)) { continue; }
			seen.add(next);
			out.add(next);
			queue.push(next);
		}
	}
	return out;
}

/** One node selected for execution. */
export interface ExecutableStep {
	id: string;
	type: string;
	/**
	 * 数据上游（快照/文本流）：flow 边（`classifyEdge` 判定为控制流）**不**包含
	 * 在内 —— executor 侧 `store.byNode(up)` / collectUpstreamValues 按 nodeId
	 * 无差别取快照，混入控制流上游会拿错媒体/文本。
	 */
	upstreams: string[];
	/**
	 * W7-flow 控制上游（flowIn/flowOut 边）：只用于拓扑排序与 join 语义
	 * （computeExecutionOrder 本就用全量边，这里仅供诊断/UI 展示）。
	 */
	flowUpstreams: string[];
}

export interface ExecutionPlan {
	/** Executable nodes in execution order. */
	steps: ExecutableStep[];
	/** True when the whole graph contains a cycle (execution must stop). */
	hasCycle: boolean;
	/** Node ids that were filtered out (not executable, e.g. Saros orchestration). */
	skipped: string[];
	/**
	 * W7: 可执行但**不在 Start 作用域**内的节点（未接入入口 → 本次不执行）。
	 * 仅在传入 `entryScope` 时非空；与 `skipped`（类型不可执行）语义不同。
	 */
	outOfScope: string[];
}

/**
 * Build a workflow-wide execution plan:
 *  1. topological order over ALL nodes (upstream-first),
 *  2. keep only executable nodes (per `isExecutable`),
 *  3. attach each step's direct upstreams (data vs flow separated).
 *
 * `entryScope`（W7）：非空时只保留 scope 内的节点 —— 「从 Start 开始执行」的
 * 入口语义（scope 由 `resolveStartScope` 计算）。scope 外的可执行节点归入
 * `outOfScope`（**不是** `skipped`：后者语义是"类型不可执行"，调用方需要区分
 * 二者才能在卡片上给出正确状态）。
 *
 * `classifyEdge`（W7-flow）：可选。返回 true = 该边是**控制流边**（如
 * flowIn/flowOut 端口）→ 不进 `upstreams`（数据上游）、归入
 * `flowUpstreams`。拓扑排序仍用全量边（控制依赖同样决定执行顺序）。
 * Pure.
 */
export function buildExecutionPlan(
	nodes: ExecutionNodeLike[],
	edges: ExecutionEdgeLike[],
	isExecutable: (type: string) => boolean,
	entryScope?: ReadonlySet<string> | null,
	classifyEdge?: (edge: ExecutionEdgeLike) => boolean,
): ExecutionPlan {
	const { order, hasCycle } = computeExecutionOrder(nodes, edges);
	const steps: ExecutableStep[] = [];
	const skipped: string[] = [];
	const outOfScope: string[] = [];
	for (const id of order) {
		const node = nodes.find(n => n.id === id);
		if (!node) { continue; }
		if (!isExecutable(node.type ?? '')) {
			skipped.push(id);
			continue;
		}
		if (entryScope && !entryScope.has(id)) {
			outOfScope.push(id);
			continue;
		}
		steps.push({ id, type: node.type ?? '', ...splitUpstreams(id, edges, classifyEdge) });
	}
	return { steps, hasCycle, skipped, outOfScope };
}

/**
 * 按 `classifyEdge` 把 nodeId 的入边拆成数据/控制两组。Pure。
 * 未提供 classifyEdge 时全部算数据上游（向后兼容）。
 */
export function splitUpstreams(
	nodeId: string,
	edges: ExecutionEdgeLike[],
	classifyEdge?: (edge: ExecutionEdgeLike) => boolean,
): { upstreams: string[]; flowUpstreams: string[] } {
	const upstreams: string[] = [];
	const flowUpstreams: string[] = [];
	for (const e of edges) {
		if (e.target !== nodeId) { continue; }
		const bucket = classifyEdge?.(e) ? flowUpstreams : upstreams;
		if (!bucket.includes(e.source)) { bucket.push(e.source); }
	}
	return { upstreams, flowUpstreams };
}

// ─── W7: Start 入口作用域（「运行 = 从 Start 开始」的单一真源）──────────────
//
// 背景：全图 Run / 脚本导出此前都是**全图拓扑遍历**，`Saros.Start` 只提供 args
// 契约，不参与调度 —— 与 headless 侧（workflowExecutionService 强制 Start 且从
// Start DFS）语义不一致：同一张图在画布上跑全部节点、在聊天框里只跑 Start 可达
// 部分。本节把「Start 为入口」抽成纯函数，三条执行路径（画布全图 Run / 画布脚本
// 导出 / headless）共用同一套判定。
//
// 作用域 = ① Start 正向可达闭包（控制流）∪ ② ①中节点的上游闭包（数据依赖）。
// ② 不可省：媒体链的数据源（LoadImage / 素材节点）通常挂在 stage 上游而**不在**
// Start 下游，只取①会把它裁掉 → stage 报「无上游图像」。

/** 工作流入口节点类型（画布全名 + headless 归一化小写枚举）。 */
export const WORKFLOW_START_TYPES: readonly string[] = ['Saros.Start', 'start'];
/** 工作流出口节点类型（同上）。 */
export const WORKFLOW_END_TYPES: readonly string[] = ['Saros.End', 'end'];

/** 入口节点判定（跨 webview / headless 两套 type 命名）。Pure。 */
export function isWorkflowStartType(type: string | undefined): boolean {
	return !!type && WORKFLOW_START_TYPES.includes(type);
}

/** 出口节点判定。Pure。 */
export function isWorkflowEndType(type: string | undefined): boolean {
	return !!type && WORKFLOW_END_TYPES.includes(type);
}

export interface StartScopeResult {
	/**
	 * 参与本次执行的节点 id 集合；`null` = 不裁剪（全图执行）。
	 * null 出现在两种情况：图无 Start（存量图零迁移）、或 Start 未编排（degraded）。
	 */
	scope: Set<string> | null;
	/** 图中的 Start 节点 id（可多个：多入口并行起跑）。 */
	startIds: string[];
	/**
	 * Start 存在但**未编排**（无出边，或出边只到 End）→ 退化为全图执行。
	 * 若严格裁剪，这类图（如仅摆了 Start→End 而业务链独立）会一个业务节点都不跑，
	 * 属于回归。调用方应据此给出「Start 未连接业务节点，已按全图执行」提示。
	 */
	degraded: boolean;
}

/**
 * 计算「从 Start 开始」的执行作用域。Pure。
 *
 * @param isStart 入口判定（默认 `isWorkflowStartType`；测试可注入）
 * @param isEnd   出口判定（默认 `isWorkflowEndType`）——仅用于 degraded 判定
 */
export function resolveStartScope(
	nodes: ExecutionNodeLike[],
	edges: ExecutionEdgeLike[],
	isStart: (type: string | undefined) => boolean = isWorkflowStartType,
	isEnd: (type: string | undefined) => boolean = isWorkflowEndType,
): StartScopeResult {
	const startIds = nodes.filter(n => isStart(n.type)).map(n => n.id);
	if (startIds.length === 0) {
		return { scope: null, startIds, degraded: false };
	}
	const typeById = new Map(nodes.map(n => [n.id, n.type]));
	// Start 未编排判定：所有 Start 的出边目标都是 End（或没有出边）。
	const meaningfulTargets = edges.filter(e =>
		startIds.includes(e.source) && !isEnd(typeById.get(e.target)) && !isStart(typeById.get(e.target)),
	);
	if (meaningfulTargets.length === 0) {
		return { scope: null, startIds, degraded: true };
	}

	// ① 正向可达闭包（Start → 下游）
	const scope = new Set<string>(startIds);
	const forward: string[] = [...startIds];
	while (forward.length > 0) {
		const cur = forward.shift()!;
		for (const e of edges) {
			if (e.source !== cur || scope.has(e.target)) { continue; }
			if (!typeById.has(e.target)) { continue; } // 悬空边
			scope.add(e.target);
			forward.push(e.target);
		}
	}

	// ② 上游依赖补全（可达节点的数据来源必须一起跑；迭代到稳定）
	const backward: string[] = [...scope];
	while (backward.length > 0) {
		const cur = backward.shift()!;
		for (const e of edges) {
			if (e.target !== cur || scope.has(e.source)) { continue; }
			if (!typeById.has(e.source)) { continue; }
			scope.add(e.source);
			backward.push(e.source);
		}
	}

	return { scope, startIds, degraded: false };
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
	/** W7: 可执行但不在 Start 作用域内的节点（见 ExecutionPlan.outOfScope）。 */
	outOfScope: string[];
	/**
	 * P0① 写者分层：被单独拆成一层的**可写节点** id（诊断/UI 用）。
	 * 传入 `isWriteStep` 时才非空；语义见 `splitLayerByWriters`。
	 */
	serializedWriters: string[];
}

/**
 * Build a parallel execution plan by grouping the topological order into
 * "waves" of independent steps:
 *   - layer 0 = all nodes with indegree 0,
 *   - layer k = nodes whose every upstream is in layers < k.
 *
 * Runs in O(V + E) via a modified Kahn pass that records the max upstream layer.
 * `entryScope`（W7）语义同 `buildExecutionPlan`。
 * Pure + DOM-free.
 */
export function buildParallelExecutionPlan(
	nodes: ExecutionNodeLike[],
	edges: ExecutionEdgeLike[],
	isExecutable: (type: string) => boolean,
	entryScope?: ReadonlySet<string> | null,
	classifyEdge?: (edge: ExecutionEdgeLike) => boolean,
	/**
	 * P0① 写者判定（可选）：同层内**至多一个**可写节点（见 `splitLayerByWriters`）。
	 * 缺省不做拆分（存量行为零变化）。写能力信号由调用方注入 —— 画布侧从
	 * `agents.list` / `tools.list` 的 `writeCapable` 取（见 comfyHost/writeStepIds.ts）。
	 */
	isWriteStep?: (step: ExecutableStep) => boolean,
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
		return { layers: [], hasCycle, skipped: nodes.map(n => n.id), outOfScope: [], serializedWriters: [] };
	}

	// Group executable nodes by layer (keeping topological order within layers).
	const maxLayer = [...layerOf.values()].reduce((a, b) => Math.max(a, b), -1);
	const layerBuckets: Array<{ step: ExecutableStep }>[] = [];
	for (let i = 0; i <= maxLayer; i++) { layerBuckets.push([]); }
	const skipped: string[] = [];
	const outOfScope: string[] = [];
	for (const n of nodes) {
		const l = layerOf.get(n.id) ?? 0;
		if (!isExecutable(n.type ?? '')) {
			skipped.push(n.id);
			continue;
		}
		if (entryScope && !entryScope.has(n.id)) {
			outOfScope.push(n.id);
			continue;
		}
		const step: ExecutableStep = { id: n.id, type: n.type ?? '', ...splitUpstreams(n.id, edges, classifyEdge) };
		layerBuckets[l].push({ step });
	}

	const rawLayers = layerBuckets
		.filter(b => b.length > 0)
		.map(b => b.map(x => x.step));

	// P0① 写者分层：同层内至多一个可写节点（未传 isWriteStep → 不拆，存量行为不变）。
	const serializedWriters: string[] = [];
	const layers = isWriteStep
		? rawLayers.flatMap(layer => splitLayerByWriters(layer, isWriteStep, serializedWriters))
		: rawLayers;

	return { layers, hasCycle, skipped, outOfScope, serializedWriters };
}

/**
 * P0① 把一个并行层按「写者独占」拆成子层：同层内**至多一个**可写节点。
 *
 * 为什么安全：层定义保证**同层节点两两无边**（`layerOf[next] = max(上游 layer)+1`
 * 意味着有边必跨层）→ 层内顺序无语义，切分/重排不破坏依赖；子层之间仍是 barrier
 * （原层整体完成才进下一层），跨层依赖不受影响。
 *
 * 为什么需要：两个可写节点并发 = 必然写冲突（子代理**共享父 worktree**，无隔离档）。
 * 调度层 `UnifiedSubAgentDispatch` 的写互斥锁已保证**正确性**，但代价是写者在并发池里
 * **占着槽位空等**（`runConcurrent` 的 slot 被 await 阻塞）→ 计划层提前拆开，写者不占槽。
 *
 * 策略：**保持原有顺序**（遇到写者即切分），确定性优先于层数最优；只读节点仍整批并发
 * → 并行探索（主用法）零回归。
 */
export function splitLayerByWriters(
	layer: ExecutableStep[],
	isWriteStep: (step: ExecutableStep) => boolean,
	collected?: string[],
): ExecutableStep[][] {
	const out: ExecutableStep[][] = [];
	let batch: ExecutableStep[] = [];
	for (const step of layer) {
		if (!isWriteStep(step)) {
			batch.push(step);
			continue;
		}
		if (batch.length > 0) { out.push(batch); batch = []; }
		out.push([step]); // 写者独占一层
		collected?.push(step.id);
	}
	if (batch.length > 0) { out.push(batch); }
	return out;
}
