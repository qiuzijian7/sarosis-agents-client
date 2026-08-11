/*---------------------------------------------------------------------------------------------
 *  DAG Layout — layered auto-layout for the workflow canvas (P2).
 *
 *  Docs: docs/Agent-画布编排设计方案.md P2 → 5.5 自动布局.
 *
 *  computeDagLayout(nodes, edges) groups nodes into topological layers (Kahn)
 *  and lays them left→right with configurable spacing. It returns a stable
 *  Map<nodeId, {x,y}>; nodes are placed layer-by-layer, and within a layer they
 *  are stacked vertically centered.
 *
 *  Pure + DOM-free. Cycle edges are ignored (nodes still get a deterministic
 *  placement based on the acyclic prefix), matching the "don't hang on cycles"
 *  contract of the other graph functions.
 *--------------------------------------------------------------------------------------------*/

export interface LayoutNodeLike { id: string; }
export interface LayoutEdgeLike { source: string; target: string; }

export interface DagLayoutOptions {
	/** Horizontal gap between layers (default 260). */
	columnGap?: number;
	/** Vertical gap between nodes within a layer (default 140). */
	rowGap?: number;
	/** Initial x for layer 0 (default 0). */
	originX?: number;
	/** Initial y for the first node of a layer (default 0). */
	originY?: number;
}

export type DagLayout = Map<string, { x: number; y: number }>;

/**
 * Compute a layered layout. Returns a Map of nodeId → position.
 *
 * Algorithm:
 *   1. Kahn pass to assign each node a layer index (max upstream layer + 1).
 *   2. Cycle edges (those pointing to a node with a lower-or-equal layer that
 *      is already processed) are ignored for layer assignment but nodes still
 *      appear.
 *   3. Place each layer as a column; within a column, nodes stack vertically
 *      with rowGap, centered around originY.
 */
export function computeDagLayout(
	nodes: LayoutNodeLike[],
	edges: LayoutEdgeLike[],
	options: DagLayoutOptions = {},
): DagLayout {
	const { columnGap = 260, rowGap = 140, originX = 0, originY = 0 } = options;

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
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const next of adj.get(id) ?? []) {
			const d = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, d);
			if (d === 0) { queue.push(next); }
			const candidate = (layerOf.get(id) ?? 0) + 1;
			layerOf.set(next, Math.max(layerOf.get(next) ?? 0, candidate));
		}
	}

	// Nodes that never got a layer (cycle remainder) go to a fallback layer.
	const maxKnown = [...layerOf.values()].reduce((a, b) => Math.max(a, b), -1);
	for (const n of nodes) {
		if (!layerOf.has(n.id)) { layerOf.set(n.id, maxKnown + 1); }
	}

	// Group by layer.
	const byLayer = new Map<number, string[]>();
	for (const n of nodes) {
		const l = layerOf.get(n.id) ?? 0;
		const arr = byLayer.get(l) ?? [];
		arr.push(n.id);
		byLayer.set(l, arr);
	}

	const layout: DagLayout = new Map();
	for (const [layer, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
		const x = originX + layer * columnGap;
		const totalHeight = (ids.length - 1) * rowGap;
		ids.forEach((id, i) => {
			layout.set(id, { x, y: originY + i * rowGap - totalHeight / 2 });
		});
	}
	return layout;
}
