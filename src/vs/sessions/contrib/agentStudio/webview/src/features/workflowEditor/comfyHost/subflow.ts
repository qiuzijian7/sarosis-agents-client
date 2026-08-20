/*---------------------------------------------------------------------------------------------
 *  Subflow — reusable sub-graph composition (P2).
 *
 *  Docs: docs/Agent-画布编排设计方案.md P2 → 5.2 Subflow 组合节点.
 *  Aligned with TapCanvas subflow (dynamic handles).
 *
 *  A Subflow encapsulates an internal graph (its own nodes/edges). External
 *  ports are DERIVED from the internal graph:
 *   - input ports  ← internal nodes whose upstreams are empty ("sources"),
 *   - output ports ← internal nodes with no downstream ("sinks").
 *
 *  This module is the pure model layer:
 *   - buildSubflowFromGraph extracts a subflow from an existing node/edge list
 *     (e.g. the current canvas selection).
 *   - getSubflowPorts derives external ports from the internal graph.
 *   - substituteSubflow expands a subflow node back into its internal graph
 *     with external connections remapped (used by execution / export).
 *   - isValidSubflowConnection validates a port-type match against the ports.
 *
 *  All pure + DOM-free.
 *--------------------------------------------------------------------------------------------*/

export interface SubflowNodeLike {
	id: string;
	type: string;
	data?: Record<string, unknown>;
}

export interface SubflowEdgeLike {
	id?: string;
	source: string;
	target: string;
	/** W2 端口感知路由：非 subflow 边原样保留（flattenSubflows plainEdges 保引用） */
	sourceHandle?: string;
	targetHandle?: string;
}

export interface SubflowDefinition {
	id: string;
	/** Display name (also the node label). */
	name: string;
	nodes: SubflowNodeLike[];
	edges: SubflowEdgeLike[];
	/** Internal node ids exposed as input ports (sources). */
	entryIds: string[];
	/** Internal node ids exposed as output ports (sinks). */
	exitIds: string[];
}

export interface SubflowPort {
	/** Port name used in connections (derived from the internal node id). */
	name: string;
	/** Port type (IMAGE/TEXT/...). */
	type: string;
	/** The internal node id this port maps to. */
	nodeId: string;
}

export interface SubflowPorts {
	inputs: SubflowPort[];
	outputs: SubflowPort[];
}

// ─── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build a subflow definition from a set of nodes + edges (typically the canvas
 * selection). Every selected node becomes part of the internal graph; edges
 * between selected nodes are internal; edges crossing the boundary are dropped
 * (the caller re-wires externally).
 *
 * Entry ids = selected nodes with no incoming internal edge (sources); exit ids
 * = selected nodes with no outgoing internal edge (sinks). Deterministic order
 * (keeps the input node order).
 */
export function buildSubflowFromGraph(
	subflowId: string,
	name: string,
	selected: SubflowNodeLike[],
	allEdges: SubflowEdgeLike[],
): SubflowDefinition {
	const selectedIds = new Set(selected.map(n => n.id));
	// Keep only edges that are fully inside the selection.
	const internalEdges = allEdges.filter(e => selectedIds.has(e.source) && selectedIds.has(e.target));

	const hasIncoming = new Set<string>();
	const hasOutgoing = new Set<string>();
	for (const e of internalEdges) {
		hasIncoming.add(e.target);
		hasOutgoing.add(e.source);
	}

	const entryIds = selected.filter(n => !hasIncoming.has(n.id)).map(n => n.id);
	const exitIds = selected.filter(n => !hasOutgoing.has(n.id)).map(n => n.id);

	return {
		id: subflowId,
		name,
		nodes: selected.map(n => ({ ...n })),
		edges: internalEdges.map(e => ({ ...e })),
		entryIds,
		exitIds,
	};
}

// ─── Ports ─────────────────────────────────────────────────────────────────────

/**
 * Derive external ports from a subflow definition. Port name = the internal
 * node id; port type = the node's primary output type (inputs) or primary
 * input type (outputs) — the first element of the corresponding arrays.
 *
 * `portTypesFor(nodeType)` resolves a node type → { inputs, outputs } types.
 * When unresolved, falls back to 'ANY'.
 */
export function getSubflowPorts(
	def: SubflowDefinition,
	portTypesFor: (nodeType: string) => { inputs: string[]; outputs: string[] } | undefined,
): SubflowPorts {
	const inputs: SubflowPort[] = [];
	const outputs: SubflowPort[] = [];

	for (const id of def.entryIds) {
		const node = def.nodes.find(n => n.id === id);
		if (!node) { continue; }
		const types = portTypesFor(node.type);
		inputs.push({ name: id, type: types?.outputs[0] ?? 'ANY', nodeId: id });
	}
	for (const id of def.exitIds) {
		const node = def.nodes.find(n => n.id === id);
		if (!node) { continue; }
		const types = portTypesFor(node.type);
		outputs.push({ name: id, type: types?.inputs[0] ?? 'ANY', nodeId: id });
	}
	return { inputs, outputs };
}

// ─── Connection validation ─────────────────────────────────────────────────────

/** Validate a connection between two subflow ports (type match or ANY). */
export function isValidSubflowConnection(
	sourceType: string,
	targetType: string,
	isCompatible: (a: string, b: string) => boolean,
): boolean {
	return isCompatible(sourceType, targetType);
}

// ─── Substitution (expand back into the graph) ─────────────────────────────────

export interface SubstitutionResult {
	nodes: SubflowNodeLike[];
	edges: SubflowEdgeLike[];
	/** Internal node id → the external node id that feeds its input (remapped sources). */
	remap: Map<string, string>;
}

/**
 * Expand a subflow node back into its internal graph, remapping external
 * connections:
 *   - For every external edge `externalSource → subflowNode[port=entryNodeId]`,
 *     the internal entry node's incoming edge is replaced by an edge from the
 *     external source to the internal node (new unique id).
 *   - For every external edge `subflowNode[port=exitNodeId] → externalTarget`,
 *     an edge from the internal exit node to the external target is added.
 *
 * Returns the internal nodes (ids prefixed to avoid collisions) plus the new
 * edges that connect to external nodes. Pure.
 */
export function substituteSubflow(
	subflowNodeId: string,
	def: SubflowDefinition,
	externalEdges: SubflowEdgeLike[],
	idPrefix: string,
): SubstitutionResult {
	const prefixed = (id: string) => `${idPrefix}:${id}`;
	const nodes = def.nodes.map(n => ({ ...n, id: prefixed(n.id) }));

	const edges: SubflowEdgeLike[] = [];
	const remap = new Map<string, string>();

	// Edges crossing INTO the subflow: external → subflow-entry.
	const incoming = externalEdges.filter(e => e.target === subflowNodeId);
	for (const e of incoming) {
		const entryId = e.source ?? ''; // source is external node id (port ignored)
		const internalEntry = def.entryIds[0]; // first entry receives external inputs
		if (!internalEntry) { continue; }
		// W2b: 外部 gate → subflow 的边保留 sourceHandle（gate 路由跨 subflow 边界
		// 依然生效：分支未命中时整个 subflow 被 skip）。targetHandle 是 subflow
		// 输入端口名（= entry id），展平后语义失效 → 丢弃。
		edges.push({ source: entryId, target: prefixed(internalEntry), ...(e.sourceHandle !== undefined ? { sourceHandle: e.sourceHandle } : {}) });
		remap.set(entryId, prefixed(internalEntry));
	}

	// Internal edges.
	for (const e of def.edges) {
		// W2b: 内部边透传端口（subflow 内部的 IfElse 路由在展平后正常工作）
		edges.push({ source: prefixed(e.source), target: prefixed(e.target), ...(e.sourceHandle !== undefined ? { sourceHandle: e.sourceHandle } : {}), ...(e.targetHandle !== undefined ? { targetHandle: e.targetHandle } : {}) });
	}

	// Edges crossing OUT of the subflow: subflow-exit → external.
	const outgoing = externalEdges.filter(e => e.source === subflowNodeId);
	for (const e of outgoing) {
		const internalExit = def.exitIds[0];
		if (!internalExit) { continue; }
		// W2: 外部边保留 targetHandle（subflow 内部出口的 sourceHandle 语义
		// 在边界处丢弃 → always-active，见 W2b）
		edges.push({ source: prefixed(internalExit), target: e.target, ...(e.targetHandle !== undefined ? { targetHandle: e.targetHandle } : {}) });
	}

	return { nodes, edges, remap };
}

// ─── Flattening (export/execution pre-pass) ───────────────────────────────────

/**
 * Flatten a graph by expanding every subflow node (a node whose data.subflow is
 * a SubflowDefinition) into its internal sub-graph via substituteSubflow.
 *
 * Used as a pre-pass before export / execution: the subflow composition is a
 * design-time convenience; the flattened graph is what actually runs.
 *
 * Pure — returns a NEW graph; the input is untouched. Node ids in the output
 * are either unchanged (non-subflow) or prefixed with `${subflowNodeId}:`.
 */
export function flattenSubflows(
	nodes: SubflowNodeLike[],
	edges: SubflowEdgeLike[],
): { nodes: SubflowNodeLike[]; edges: SubflowEdgeLike[] } {
	const subflowIds = new Set(
		nodes.filter(n => (n.data as { subflow?: SubflowDefinition } | undefined)?.subflow).map(n => n.id),
	);

	// Edges NOT touching any subflow node are plain and kept as-is.
	const plainEdges = edges.filter(e => !subflowIds.has(e.source) && !subflowIds.has(e.target));
	// Edges touching a subflow node are handed to substitution for remapping.
	const subflowEdges = edges.filter(e => subflowIds.has(e.source) || subflowIds.has(e.target));

	let resultNodes: SubflowNodeLike[] = [];
	const resultEdges: SubflowEdgeLike[] = [...plainEdges];

	for (const n of nodes) {
		const def = (n.data as { subflow?: SubflowDefinition } | undefined)?.subflow;
		if (!def) {
			resultNodes.push({ ...n });
			continue;
		}
		const substitution = substituteSubflow(n.id, def, subflowEdges, n.id);
		resultNodes.push(...substitution.nodes);
		resultEdges.push(...substitution.edges);
	}

	return { nodes: resultNodes, edges: resultEdges };
}
