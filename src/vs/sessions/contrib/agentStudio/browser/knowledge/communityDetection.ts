/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — Community Detection (Louvain)
 *
 *  Pure, dependency-free Louvain (greedy modularity optimization) over a
 *  weighted undirected graph. This is the algorithm behind GraphRAG-style
 *  community detection: after a knowledge graph is extracted, we partition
 *  its nodes into communities, then (in `communitySummary.ts`) ask the LLM
 *  to summarize each community for hierarchical retrieval.
 *
 *  - Modularity resolution γ is tunable (higher → more, smaller
 *    communities; lower → fewer, coarser communities). Mirrors the
 *    `GRAPH_RAG_COMMUNITY_LEVELS` / Leiden `resolution` knobs.
 *  - Deterministic for a given node/edge input order (no RNG), so unit
 *    tests are stable.
 *  - Only the public `detectCommunities` depends on the engine; the rest
 *    is self-contained and unit-testable without an LLM.
 *--------------------------------------------------------------------------------------------*/

export interface CommunityEdge {
	/** Source node id (already normalized/keyed by the caller). */
	source: string;
	/** Target node id. */
	target: string;
	/** Edge weight (default 1). */
	weight?: number;
}

export interface CommunityDetectionResult {
	/** node id → community id (e.g. "c0", "c1"). */
	nodeCommunity: Map<string, string>;
	/** community id → member node ids. */
	communities: Map<string, string[]>;
	/** Modularity Q of the final partition (range ≈ [-0.5, 1]). */
	modularity: number;
}

interface LGraph {
	nodes: string[];
	/** adjacency: node → (neighbor → weight). */
	adj: Map<string, Map<string, number>>;
	/** self-loop weight per node. */
	self: Map<string, number>;
	/** degree per node (k_i): Σ neighbor weights + 2·self. */
	degree: Map<string, number>;
}

function buildGraph(nodeIds: string[], edges: CommunityEdge[]): LGraph {
	const adj = new Map<string, Map<string, number>>();
	const self = new Map<string, number>();
	const degree = new Map<string, number>();
	for (const n of nodeIds) {
		adj.set(n, new Map());
		self.set(n, 0);
		degree.set(n, 0);
	}
	for (const e of edges) {
		const s = e.source;
		const t = e.target;
		if (!adj.has(s) || !adj.has(t)) { continue; }
		if (s === t) {
			const w = e.weight ?? 1;
			self.set(s, (self.get(s) ?? 0) + w);
			degree.set(s, (degree.get(s) ?? 0) + 2 * w);
			continue;
		}
		const w = e.weight ?? 1;
		const a = adj.get(s)!;
		a.set(t, (a.get(t) ?? 0) + w);
		const b = adj.get(t)!;
		b.set(s, (b.get(s) ?? 0) + w);
		degree.set(s, (degree.get(s) ?? 0) + w);
		degree.set(t, (degree.get(t) ?? 0) + w);
	}
	return { nodes: nodeIds, adj, self, degree };
}

function sumDegrees(g: LGraph): number {
	let s = 0;
	for (const k of g.degree.values()) { s += k; }
	return s;
}

/**
 * Run ONE Louvain level: local moving of nodes between communities until no
 * node can improve modularity. Returns the community assignment for the
 * level's nodes. Singleton nodes (degree 0) keep their own community.
 */
function louvainLevel(
	levelNodes: string[],
	levelEdges: CommunityEdge[],
	resolution: number,
): Map<string, string> {
	const g = buildGraph(levelNodes, levelEdges);
	const m = sumDegrees(g) / 2; // total edge weight (2m = Σk_i)
	if (m <= 0) {
		const id = new Map<string, string>();
		levelNodes.forEach((n, i) => id.set(n, `c${i}`));
		return id;
	}

	const commOf = new Map<string, string>();
	levelNodes.forEach((n, i) => commOf.set(n, `c${i}`));
	const sigmaTot = new Map<string, number>();
	levelNodes.forEach(n => sigmaTot.set(commOf.get(n)!, g.degree.get(n) ?? 0));

	let isoCounter = 0;
	let changed = true;
	let guard = 0;
	while (changed && guard++ < 100) {
		changed = false;
		for (const i of levelNodes) {
			const ki = g.degree.get(i) ?? 0;
			if (ki === 0) { continue; } // isolated → keep own singleton
			const cur = commOf.get(i)!;

			// Weight of i's edges toward each neighboring community.
			const neighComm = new Map<string, number>();
			const a = g.adj.get(i)!;
			for (const [j, w] of a) {
				const cj = commOf.get(j)!;
				neighComm.set(cj, (neighComm.get(cj) ?? 0) + w);
			}

			// Temporarily remove i from its current community.
			commOf.delete(i);
			sigmaTot.set(cur, (sigmaTot.get(cur) ?? 0) - ki);

			let bestComm = '';
			let bestGain = 0; // baseline = stay isolated (gain 0)
			for (const [c, w] of neighComm) {
				const gain = w - resolution * (sigmaTot.get(c) ?? 0) * ki / (2 * m);
				if (gain > bestGain) { bestGain = gain; bestComm = c; }
			}
			if (bestComm === '') {
				bestComm = `iso_${i}_${isoCounter++}`; // fresh empty community
			}
			commOf.set(i, bestComm);
			sigmaTot.set(bestComm, (sigmaTot.get(bestComm) ?? 0) + ki);
			if (bestComm !== cur) { changed = true; }
		}
	}
	return commOf;
}

/** Modularity Q of a partition over the ORIGINAL graph. */
function computeModularity(
	nodeIds: string[],
	edges: CommunityEdge[],
	nodeCommunity: Map<string, string>,
	resolution: number,
): number {
	const degree = new Map<string, number>();
	nodeIds.forEach(n => degree.set(n, 0));
	let m = 0;
	for (const e of edges) {
		if (!degree.has(e.source) || !degree.has(e.target)) { continue; }
		const w = e.weight ?? 1;
		m += w;
		degree.set(e.source, (degree.get(e.source) ?? 0) + w);
		degree.set(e.target, (degree.get(e.target) ?? 0) + w);
	}
	if (m <= 0) { return 0; }

	const sigmaTot = new Map<string, number>();
	for (const n of nodeIds) {
		const c = nodeCommunity.get(n)!;
		sigmaTot.set(c, (sigmaTot.get(c) ?? 0) + (degree.get(n) ?? 0));
	}
	const sumIn = new Map<string, number>();
	for (const e of edges) {
		if (!nodeCommunity.has(e.source) || !nodeCommunity.has(e.target)) { continue; }
		if (nodeCommunity.get(e.source) === nodeCommunity.get(e.target)) {
			const c = nodeCommunity.get(e.source)!;
			sumIn.set(c, (sumIn.get(c) ?? 0) + (e.weight ?? 1));
		}
	}

	let q = 0;
	for (const [c, tot] of sigmaTot) {
		const sin = sumIn.get(c) ?? 0;
		q += sin / (2 * m) - resolution * Math.pow(tot / (2 * m), 2);
	}
	return q;
}

/**
 * Detect communities via multilevel Louvain.
 *
 * @param nodeIds  all node ids (duplicates are de-duplicated).
 * @param edges    graph edges (self-loops allowed; unknown endpoints ignored).
 * @param opts.resolution  modularity resolution γ (default 1.0).
 */
export function detectCommunities(
	nodeIds: string[],
	edges: CommunityEdge[],
	opts: { resolution?: number } = {},
): CommunityDetectionResult {
	const resolution = opts.resolution ?? 1.0;
	const uniqueNodes = [...new Set(nodeIds)];
	if (uniqueNodes.length === 0) {
		return { nodeCommunity: new Map(), communities: new Map(), modularity: 0 };
	}

	// original node → current-level node/super-node id.
	const origToCurrent = new Map<string, string>();
	uniqueNodes.forEach(n => origToCurrent.set(n, n));

	let levelNodes: string[] = [...uniqueNodes];
	let levelEdges: CommunityEdge[] = edges
		.filter(e => uniqueNodes.includes(e.source) && uniqueNodes.includes(e.target))
		.map(e => ({ source: e.source, target: e.target, weight: e.weight ?? 1 }));

	const MAX_LEVELS = 20;
	for (let level = 0; level < MAX_LEVELS; level++) {
		const commOf = louvainLevel(levelNodes, levelEdges, resolution);
		const distinct = new Set(commOf.values());
		if (distinct.size === levelNodes.length) {
			// No aggregation happened at this level → stop.
			for (const [orig, cur] of origToCurrent) {
				origToCurrent.set(orig, commOf.get(cur) ?? cur);
			}
			break;
		}

		// Aggregate: each community becomes a super-node.
		const aggNodes = [...distinct];
		const aggSelf = new Map<string, number>();
		aggNodes.forEach(c => aggSelf.set(c, 0));
		const aggAdj = new Map<string, Map<string, number>>();
		aggNodes.forEach(c => aggAdj.set(c, new Map()));

		for (const e of levelEdges) {
			const cs = commOf.get(e.source)!;
			const ct = commOf.get(e.target)!;
			const w = e.weight ?? 1;
			if (cs === ct) {
				aggSelf.set(cs, (aggSelf.get(cs) ?? 0) + w); // internal → self-loop of super-node
			} else {
				const a = aggAdj.get(cs)!;
				a.set(ct, (a.get(ct) ?? 0) + w);
				const b = aggAdj.get(ct)!;
				b.set(cs, (b.get(cs) ?? 0) + w);
			}
		}

		const newEdges: CommunityEdge[] = [];
		for (const c of aggNodes) {
			const selfW = aggSelf.get(c) ?? 0;
			if (selfW > 0) { newEdges.push({ source: c, target: c, weight: selfW }); }
			const a = aggAdj.get(c)!;
			for (const [ct, w] of a) { newEdges.push({ source: c, target: ct, weight: w }); }
		}

		// Original nodes now belong to their super-node (the community id).
		for (const [orig, cur] of origToCurrent) {
			origToCurrent.set(orig, commOf.get(cur) ?? cur);
		}
		levelNodes = aggNodes;
		levelEdges = newEdges;
	}

	// Renumber communities to c0, c1, … for a stable, friendly id space.
	const rawComm = new Map<string, string>();
	for (const [orig, cur] of origToCurrent) { rawComm.set(orig, cur); }
	const remap = new Map<string, string>();
	let idx = 0;
	for (const v of rawComm.values()) {
		if (!remap.has(v)) { remap.set(v, `c${idx++}`); }
	}

	const nodeCommunity = new Map<string, string>();
	const communities = new Map<string, string[]>();
	for (const [orig, raw] of rawComm) {
		const cid = remap.get(raw)!;
		nodeCommunity.set(orig, cid);
		const arr = communities.get(cid);
		if (arr) { arr.push(orig); } else { communities.set(cid, [orig]); }
	}

	const modularity = computeModularity(uniqueNodes, edges, nodeCommunity, resolution);
	return { nodeCommunity, communities, modularity };
}
