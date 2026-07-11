/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — Extraction Method Registry
 *
 *  TS analogue of `hyperextract/methods/registry.py`. Each extraction
 *  "method" is a configurable *preset*: it builds a ready-to-use AutoType
 *  (AutoGraph for graph methods, AutoList for list methods) by composing
 *  a JSON schema + prompts + a merge strategy. No new AutoType classes are
 *  needed — methods reuse the two ported AutoTypes and only tune their knobs,
 *  exactly like the upstream registry maps each method onto an AutoType +
 *  default prompt.
 *
 *  Ported catalog (prompt-layer strategies only):
 *    rag/    : light_rag, itext2kg, itext2kg_star, atom, kg_gen
 *    typical/: hyper_rag (participants[] n-ary hyperedges)
 *    graphrag: graph_rag, cog_rag, hypergraph_rag — community-aware
 *              (Louvain detection + LLM community summaries, see
 *              communityDetection.ts / communitySummary.ts)
 *
 *  Community detection is implemented in pure TS (Louvain), so the three
 *  GraphRAG-style methods are fully ported: they set `communityAware`
 *  and the KnowledgeManager runs detection + summarization after ingestion.
 *--------------------------------------------------------------------------------------------*/

import { getPrompt } from './i18nPrompts.js';
import { AutoGraph } from './autoGraph.js';
import { AutoHypergraph } from './autoHypergraph.js';
import { AutoTemporalGraph } from './autoTemporalGraph.js';
import { BaseAutoType } from './base.js';
import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';
import { MergeStrategy } from './merge.js';
import { JsonSchema, KnowledgeItem, KeyExtractor, EdgeEndpoints } from './types.js';

export type MethodKind = 'graph' | 'list';

export interface MethodDef {
	readonly name: string;
	readonly kind: MethodKind;
	readonly description: string;
	/** Domain hint for UI grouping (mirrors TEMPLATE_DOMAIN in templates.ts). */
	readonly domain?: string;
	/** Build a configured, empty AutoType for this method. */
	build(llm: IChatModel, embedder: IEmbedder): BaseAutoType<any>;
	/**
	 * P3 — GraphRAG community detection flag. When true, the built AutoType
	 * runs Louvain community detection + LLM summaries after ingestion.
	 */
	readonly communityAware?: boolean;
}

const REGISTRY = new Map<string, MethodDef>();

/** Register (or overwrite) an extraction method. */
export function registerMethod(def: MethodDef): void {
	REGISTRY.set(def.name, def);
}

/** Look up a method by name. */
export function getMethod(name: string): MethodDef | undefined {
	return REGISTRY.get(name);
}

/** List registered methods, optionally filtered by kind and/or domain. */
export function listMethods(filter?: { kind?: MethodKind; domain?: string }): MethodDef[] {
	return [...REGISTRY.values()].filter(m =>
		(!filter?.kind || m.kind === filter.kind) &&
		(!filter?.domain || m.domain === filter.domain));
}

// ── Schema / extractor helpers ──────────────────────────────────────────────

const str = (d: string): JsonSchema => ({ type: 'string', description: d });
const arr = (d: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description: d });
function obj(props: Record<string, JsonSchema>, required: string[], description: string): JsonSchema {
	return { type: 'object', description, properties: props, required };
}
const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();

const nodeKey: KeyExtractor = (n: KnowledgeItem) => lc(n['name']);
const edgeKey: KeyExtractor = (e: KnowledgeItem) =>
	`${lc(e['source'])}|${lc(e['relation'])}|${lc(e['target'])}`;
const edgeEndpoints: EdgeEndpoints = (e: KnowledgeItem): [string, string] => [lc(e['source']), lc(e['target'])];

// ── Prompts (method-specific prompt-layer strategies) ────────────────────────

const LIGHT_NODE_PROMPT = getPrompt('method.light_rag.node');

const LIGHT_EDGE_PROMPT = getPrompt('method.light_rag.edge');

const IKG_NODE_PROMPT = getPrompt('method.itext2kg.node');

const IKG_EDGE_PROMPT = getPrompt('method.itext2kg.edge');

const IKG_STAR_NODE_PROMPT = getPrompt('method.itext2kg_star.node');

const IKG_STAR_EDGE_PROMPT = getPrompt('method.itext2kg_star.edge');

const ATOM_EDGE_PROMPT = getPrompt('method.atom.edge');

const KG_GEN_NODE_PROMPT = getPrompt('method.kg_gen.node');

const KG_GEN_EDGE_PROMPT = getPrompt('method.kg_gen.edge');

const HYPER_PROMPT = getPrompt('method.hyper_rag.prompt');

// ── P3: GraphRAG-style community-aware prompts ──────────────────────────────

const GRAPH_RAG_NODE_PROMPT = getPrompt('method.graph_rag.node');

const GRAPH_RAG_EDGE_PROMPT = getPrompt('method.graph_rag.edge');

const GRAPH_RAG_COMM_PROMPT = getPrompt('method.graph_rag.community');

const COG_RAG_NODE_PROMPT = getPrompt('method.cog_rag.node');

const COG_RAG_EDGE_PROMPT = getPrompt('method.cog_rag.edge');

const COG_RAG_COMM_PROMPT = getPrompt('method.cog_rag.community');

// ── Built-in method presets ───────────────────────────────────────────────────

function registerBuiltinMethods(): void {
	// light_rag — graph, binary edges (relation deemphasized), two-stage.
	registerMethod({
		name: 'light_rag',
		kind: 'graph',
		description: 'Lightweight graph: salient entities + binary edges (relation optional).',
		domain: 'general',
		build: (llm, embedder) => new AutoGraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical entity name'),
					type: str('Entity category (Person / Org / Concept / Place / ...)'),
					description: str('Concise description'),
				},
				['name'],
				'A knowledge-graph entity (node)',
			),
			edgeSchema: obj(
				{
					source: str('Source entity name (must match a node)'),
					target: str('Target entity name (must match a node)'),
					relation: str('Optional relationship label; may be omitted for a plain link'),
					description: str('Optional description'),
				},
				['source', 'target'],
				'A lightweight binary relationship (edge)',
			),
			nodeKeyExtractor: nodeKey,
			edgeKeyExtractor: (e: KnowledgeItem) => `${lc(e['source'])}|${lc(e['target'])}`,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.SIMPLE,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			edgeFieldsForIndex: ['source', 'target', 'relation'],
			promptForNodeExtraction: LIGHT_NODE_PROMPT,
			promptForEdgeExtraction: LIGHT_EDGE_PROMPT,
		}),
	});

	// itext2kg — graph, strict (entity, relation, entity) triples.
	registerMethod({
		name: 'itext2kg',
		kind: 'graph',
		description: 'Strict (entity, relation, entity) triple extraction. Relations mandatory.',
		domain: 'general',
		build: (llm, embedder) => new AutoGraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical entity name'),
					type: str('Entity category'),
					description: str('Concise description'),
				},
				['name'],
				'A knowledge-graph entity (node)',
			),
			edgeSchema: obj(
				{
					source: str('Source entity name (must match a node)'),
					target: str('Target entity name (must match a node)'),
					relation: str('Relationship label — REQUIRED for every edge'),
					description: str('Optional description'),
				},
				['source', 'target', 'relation'],
				'A strict triple (edge)',
			),
			nodeKeyExtractor: nodeKey,
			edgeKeyExtractor: edgeKey,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.BALANCED,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			edgeFieldsForIndex: ['source', 'target', 'relation', 'description'],
			promptForNodeExtraction: IKG_NODE_PROMPT,
			promptForEdgeExtraction: IKG_EDGE_PROMPT,
		}),
	});

	// itext2kg_star — graph, high-quality enriched triples.
	registerMethod({
		name: 'itext2kg_star',
		kind: 'graph',
		description: 'High-recall enriched triples: rich node attributes + described relations.',
		domain: 'general',
		build: (llm, embedder) => new AutoGraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical entity name (merge aliases)'),
					type: str('Fine-grained entity category'),
					description: str('Concise description'),
					properties: arr('Notable attributes / aliases of the entity'),
				},
				['name'],
				'A richly described entity (node)',
			),
			edgeSchema: obj(
				{
					source: str('Source entity name (must match a node)'),
					target: str('Target entity name (must match a node)'),
					relation: str('Descriptive relationship label — REQUIRED'),
					description: str('Description of the relationship'),
				},
				['source', 'target', 'relation'],
				'A high-quality triple (edge)',
			),
			nodeKeyExtractor: nodeKey,
			edgeKeyExtractor: edgeKey,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.BALANCED,
			nodeFieldsForIndex: ['name', 'type', 'description', 'properties'],
			edgeFieldsForIndex: ['source', 'target', 'relation', 'description'],
			promptForNodeExtraction: IKG_STAR_NODE_PROMPT,
			promptForEdgeExtraction: IKG_STAR_EDGE_PROMPT,
		}),
	});

	// atom — temporal graph, edges carry time + evidence (temporal provenance).
	registerMethod({
		name: 'atom',
		kind: 'graph',
		description: 'Temporal KG: every edge records time + evidence provenance.',
		domain: 'general',
		build: (llm, embedder) => new AutoTemporalGraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical entity name'),
					type: str('Entity category'),
					description: str('Concise description'),
				},
				['name'],
				'A knowledge-graph entity (node)',
			),
			edgeSchema: obj(
				{
					source: str('Source entity name (must match a node)'),
					target: str('Target entity name (must match a node)'),
					relation: str('Relationship label — REQUIRED'),
					time: str('When the relationship holds (date / phrase) — REQUIRED'),
					evidence: str('Supporting quote or reference from the text — REQUIRED'),
				},
				['source', 'target', 'relation', 'time', 'evidence'],
				'A temporal, evidenced relationship (edge)',
			),
			nodeKeyExtractor: nodeKey,
			edgeKeyExtractor: edgeKey,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.BALANCED,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			edgeFieldsForIndex: ['source', 'target', 'relation', 'time', 'evidence'],
			promptForNodeExtraction: IKG_NODE_PROMPT,
			promptForEdgeExtraction: ATOM_EDGE_PROMPT,
		}),
	});

	// kg_gen — graph, community / cluster emphasis.
	registerMethod({
		name: 'kg_gen',
		kind: 'graph',
		description: 'Community-aware graph: edge hints reveal cluster cohesion / bridges.',
		domain: 'general',
		build: (llm, embedder) => new AutoGraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical entity name'),
					type: str('Entity category / community it belongs to'),
					description: str('Concise description'),
				},
				['name'],
				'A knowledge-graph entity (node)',
			),
			edgeSchema: obj(
				{
					source: str('Source entity name (must match a node)'),
					target: str('Target entity name (must match a node)'),
					relation: str('Relationship label — REQUIRED'),
					description: str('Optional description'),
				},
				['source', 'target', 'relation'],
				'A community-revealing relationship (edge)',
			),
			nodeKeyExtractor: nodeKey,
			edgeKeyExtractor: edgeKey,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.BALANCED,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			edgeFieldsForIndex: ['source', 'target', 'relation', 'description'],
			promptForNodeExtraction: KG_GEN_NODE_PROMPT,
			promptForEdgeExtraction: KG_GEN_EDGE_PROMPT,
		}),
	});

	// hyper_rag — graph (hypergraph), real N-ary hyperedges via a participants[]
	// array. Uses AutoHypergraph (not AutoList) so participant completeness is
	// strictly enforced and hyperedge keys are order-independent.
	registerMethod({
		name: 'hyper_rag',
		kind: 'graph',
		description: 'N-ary hyperedges: a participants[] array + a single relation label.',
		domain: 'general',
		build: (llm, embedder) => new AutoHypergraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical entity name (participant of a hyperedge)'),
					type: str('Entity category'),
					description: str('Concise description'),
				},
				['name'],
				'A knowledge-graph entity (hypergraph node)',
			),
			hyperedgeSchema: obj(
				{
					participants: arr('Entity names that participate in this hyperedge (≥2) — MUST match nodes'),
					relation: str('Label summarizing the group interaction — REQUIRED'),
					description: str('Optional description of the hyperedge'),
				},
				['participants', 'relation'],
				'An N-ary hyperedge (multi-participant fact)',
			),
			nodeKeyExtractor: nodeKey,
			incidentNodesExtractor: (he: KnowledgeItem) => {
				const ps = Array.isArray(he['participants'])
					? (he['participants'] as unknown[]).map(lc)
					: [lc(he['participants'])];
				return ps.filter((p): p is string => !!p);
			},
			extractionMode: 'one_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			hyperedgeStrategy: MergeStrategy.BALANCED,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			hyperedgeFieldsForIndex: ['participants', 'relation', 'description'],
			promptForNodeExtraction: HYPER_PROMPT,
			promptForHyperedgeExtraction: HYPER_PROMPT,
		}),
	});

	// ── P3: GraphRAG-style community-aware methods ────────────────────────
	// Each sets `communityAware: true`; the KnowledgeManager runs Louvain
	// detection + LLM community summaries after ingestion.

	// graph_rag — AutoGraph + community detection (resolution 1.0, normal granularity).
	registerMethod({
		name: 'graph_rag',
		kind: 'graph',
		description: 'GraphRAG: graph extraction + Louvain community detection + LLM community summaries.',
		domain: 'general',
		communityAware: true,
		build: (llm, embedder) => new AutoGraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical entity name (note its community in `type`)'),
					type: str('Entity category / community it belongs to'),
					description: str('Concise description'),
				},
				['name'],
				'A knowledge-graph entity (node)',
			),
			edgeSchema: obj(
				{
					source: str('Source entity name (must match a node)'),
					target: str('Target entity name (must match a node)'),
					relation: str('Relationship label — REQUIRED'),
					description: str('Optional description'),
				},
				['source', 'target', 'relation'],
				'A community-revealing relationship (edge)',
			),
			nodeKeyExtractor: nodeKey,
			edgeKeyExtractor: edgeKey,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.BALANCED,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			edgeFieldsForIndex: ['source', 'target', 'relation', 'description'],
			promptForNodeExtraction: GRAPH_RAG_NODE_PROMPT,
			promptForEdgeExtraction: GRAPH_RAG_EDGE_PROMPT,
			communityAware: true,
			communityResolution: 1.0,
			communitySummaryPrompt: GRAPH_RAG_COMM_PROMPT,
		}),
	});

	// cog_rag — AutoGraph + COARSE community detection (resolution 0.7):
	// cognnee-style high-level "gist" communities (fewer, bigger).
	registerMethod({
		name: 'cog_rag',
		kind: 'graph',
		description: 'Cognee-style RAG: high-level concept graph + coarse (big-picture) community summaries.',
		domain: 'general',
		communityAware: true,
		build: (llm, embedder) => new AutoGraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical high-level concept / actor name'),
					type: str('Broad theme the concept belongs to'),
					description: str('Concise description'),
				},
				['name'],
				'A high-level knowledge-graph entity (node)',
			),
			edgeSchema: obj(
				{
					source: str('Source entity name (must match a node)'),
					target: str('Target entity name (must match a node)'),
					relation: str('Relationship label — REQUIRED'),
					description: str('Optional description'),
				},
				['source', 'target', 'relation'],
				'A broad conceptual relationship (edge)',
			),
			nodeKeyExtractor: nodeKey,
			edgeKeyExtractor: edgeKey,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.BALANCED,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			edgeFieldsForIndex: ['source', 'target', 'relation', 'description'],
			promptForNodeExtraction: COG_RAG_NODE_PROMPT,
			promptForEdgeExtraction: COG_RAG_EDGE_PROMPT,
			communityAware: true,
			communityResolution: 0.7,
			communitySummaryPrompt: COG_RAG_COMM_PROMPT,
		}),
	});

	// hypergraph_rag — AutoHypergraph + community detection over the
	// projected pairwise graph of each N-ary hyperedge.
	registerMethod({
		name: 'hypergraph_rag',
		kind: 'graph',
		description: 'HypergraphRAG: N-ary hyperedges + Louvain community detection over projected pairs.',
		domain: 'general',
		communityAware: true,
		build: (llm, embedder) => new AutoHypergraph({
			llm, embedder,
			nodeSchema: obj(
				{
					name: str('Canonical entity name (participant of a hyperedge)'),
					type: str('Entity category'),
					description: str('Concise description'),
				},
				['name'],
				'A knowledge-graph entity (hypergraph node)',
			),
			hyperedgeSchema: obj(
				{
					participants: arr('Entity names that participate in this hyperedge (≥2) — MUST match nodes'),
					relation: str('Label summarizing the group interaction — REQUIRED'),
					description: str('Optional description of the hyperedge'),
				},
				['participants', 'relation'],
				'An N-ary hyperedge (multi-participant fact)',
			),
			nodeKeyExtractor: nodeKey,
			incidentNodesExtractor: (he: KnowledgeItem) => {
				const ps = Array.isArray(he['participants'])
					? (he['participants'] as unknown[]).map(lc)
					: [lc(he['participants'])];
				return ps.filter((p): p is string => !!p);
			},
			extractionMode: 'one_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			hyperedgeStrategy: MergeStrategy.BALANCED,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			hyperedgeFieldsForIndex: ['participants', 'relation', 'description'],
			promptForNodeExtraction: HYPER_PROMPT,
			promptForHyperedgeExtraction: HYPER_PROMPT,
			communityAware: true,
			communityResolution: 1.0,
			communitySummaryPrompt: GRAPH_RAG_COMM_PROMPT,
		}),
	});
}

registerBuiltinMethods();
