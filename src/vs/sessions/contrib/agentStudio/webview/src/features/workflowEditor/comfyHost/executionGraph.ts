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
	/** Node ids that were filtered out (not executable, e.g. Sarosis orchestration). */
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
