/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — Template registry
 *
 *  TS-native analogue of `hyperextract/utils/template_engine` (the 80+ YAML
 *  presets). Instead of parsing YAML at runtime we declare a set of
 *  built-in templates as typed objects; each knows how to build a configured
 *  AutoType (AutoGraph or AutoList) from injected LLM + embedder deps.
 *
 *  Ported from the upstream Hyper-Extract preset catalog (6 domains, 38 templates):
 *    general / finance / medicine / tcm / industry / legal
 *  The upstream engine supports 8 AutoTypes; this TS port implements two
 *  (graph → AutoGraph, list/model/set/hypergraph → AutoList), so non-graph
 *  types are mapped onto the nearest supported AutoType:
 *    - graph / temporal_graph / spatial_graph / spatio_temporal_graph → AutoGraph
 *      (temporal/spatial add `time` / `location` fields to edges)
 *    - list / model / set / hypergraph → AutoList
 *      (hypergraph's multi-participant hyperedge is modeled as a list item
 *       with a `participants` array field)
 *
 *  Adding a new domain preset = add one entry to `TEMPLATES`. The shape mirrors
 *  the Python template fields (schema, key/label extractors, prompts) but uses
 *  JSON-Schema + plain functions instead of Pydantic + Callables.
 *--------------------------------------------------------------------------------------------*/

import { getPrompt } from './i18nPrompts.js';
import { AutoGraph, GraphData } from './autoGraph.js';
import { AutoList } from './autoList.js';
import { BaseAutoType } from './base.js';
import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';
import { MergeStrategy } from './merge.js';
import { AutoTypeConfig, JsonSchema, KnowledgeItem, KeyExtractor } from './types.js';

export type TemplateKind = 'graph' | 'list';

export interface KnowledgeTemplate {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly kind: TemplateKind;
	/** Domain grouping for UI (general / finance / medicine / tcm / industry / legal). */
	readonly domain?: string;
	/** Build a configured, empty AutoType from injected deps. */
	build(llm: IChatModel, embedder: IEmbedder, config?: AutoTypeConfig): BaseAutoType<any>;
}

// ── Shared schema helpers ────────────────────────────────────────────────

const str = (description: string): JsonSchema => ({ type: 'string', description });

/** An array-of-strings field (used by hypergraph `participants`, lists of metrics, etc.). */
const arr = (description: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description });

function objSchema(props: Record<string, JsonSchema>, required: string[], description: string): JsonSchema {
	return { type: 'object', description, properties: props, required };
}

const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();

// ── Generic graph (knowledge_graph) ─────────────────────────────────────

const GENERIC_NODE = objSchema(
	{
		name: str('Canonical entity name'),
		type: str('Entity category, e.g. Person / Org / Concept / Event'),
		description: str('Concise description of the entity'),
	},
	['name'],
	'A knowledge-graph entity (node)',
);

const GENERIC_EDGE = objSchema(
	{
		source: str('Source entity name (must match a node name)'),
		target: str('Target entity name (must match a node name)'),
		relation: str('Relationship label, e.g. works_at / part_of / causes'),
		description: str('Optional description of the relationship'),
	},
	['source', 'target', 'relation'],
	'A knowledge-graph relationship (edge)',
);

const nodeKey: KeyExtractor = (n: KnowledgeItem) => lc(n['name']);
const edgeKey: KeyExtractor = (e: KnowledgeItem) =>
	`${lc(e['source'])}|${lc(e['relation'])}|${lc(e['target'])}`;
const edgeEndpoints = (e: KnowledgeItem): [string, string] => [lc(e['source']), lc(e['target'])];

// ── Generic list (entity_list) ────────────────────────────────────────

const GENERIC_ITEM = objSchema(
	{
		title: str('Short title / name of the item'),
		content: str('The item body / fact / definition'),
		category: str('Optional grouping category'),
	},
	['title', 'content'],
	'A knowledge list item',
);

const itemKey: KeyExtractor = (it: KnowledgeItem) => lc(it['title']);

// ── FAQ ─────────────────────────────────────────────────────────────────

const FAQ_ITEM = objSchema(
	{
		question: str('The question'),
		answer: str('The answer'),
	},
	['question', 'answer'],
	'A question/answer pair',
);

const faqKey: KeyExtractor = (it: KnowledgeItem) => lc(it['question']);

// ── Reusable graph builder ─────────────────────────────────────────────

interface GraphSpec {
	id: string;
	label: string;
	description: string;
	nodeSchema: JsonSchema;
	edgeSchema: JsonSchema;
	nodeKey?: KeyExtractor;
	edgeKey?: KeyExtractor;
	nodeFields?: string[];
	edgeFields?: string[];
	prompt: string;
	/** When set, edge key & endpoints include this field. */
	edgeExtra?: string;
	/**
	 * Extra prompt variables injected at build time. Temporal/Spatial
	 * templates use this to inject `observation_time` / `observation_location`
	 * so the LLM resolves relative expressions (e.g. "last year" → 2025).
	 */
	contextVars?: Record<string, string>;
}

function graphTemplate(spec: GraphSpec): KnowledgeTemplate {
	const edgeKey = spec.edgeKey ?? ((e: KnowledgeItem) =>
		spec.edgeExtra
			? `${lc(e['source'])}|${lc(e['relation'])}|${lc(e['target'])}|${lc(e[spec.edgeExtra])}`
			: `${lc(e['source'])}|${lc(e['relation'])}|${lc(e['target'])}`);
	return {
		id: spec.id,
		label: spec.label,
		description: spec.description,
		kind: 'graph',
		build: (llm, embedder, config) => new AutoGraph({
			llm, embedder, config,
			nodeSchema: spec.nodeSchema,
			edgeSchema: spec.edgeSchema,
			nodeKeyExtractor: spec.nodeKey ?? nodeKey,
			edgeKeyExtractor: edgeKey,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.SIMPLE,
			nodeFieldsForIndex: spec.nodeFields ?? ['name', 'type', 'description'],
			edgeFieldsForIndex: spec.edgeFields ?? ['source', 'relation', 'target', 'description'],
			contextVars: spec.contextVars,
		}),
	};
}

// ── Reusable list builder (list / model / set / hypergraph) ───────────

interface ListSpec {
	id: string;
	label: string;
	description: string;
	itemSchema: JsonSchema;
	key: KeyExtractor;
	prompt: string;
	fieldsForIndex?: string[];
	strategy?: MergeStrategy;
}

function listTemplate(spec: ListSpec): KnowledgeTemplate {
	return {
		id: spec.id,
		label: spec.label,
		description: spec.description,
		kind: 'list',
		build: (llm, embedder, config) => new AutoList({
			llm, embedder, config,
			itemSchema: spec.itemSchema,
			keyExtractor: spec.key,
			strategy: spec.strategy ?? MergeStrategy.BALANCED,
			fieldsForIndex: spec.fieldsForIndex ?? ['title', 'content', 'name', 'description', 'question', 'term'],
			prompt: spec.prompt,
		}),
	};
}

// ── Entity / edge schema fragments ──────────────────────────────────────

const ENTITY_NODE = objSchema(
	{
		name: str('Entity / node name, using the most explicit, stable designation in the text'),
		type: str('Node type, e.g. Person / Org / Concept / Location / Event / Product'),
		description: str('Brief description of the entity identity or role'),
	},
	['name', 'type'],
	'An identifiable entity / concept / location node',
);

const REL_EDGE = (extra: Record<string, JsonSchema> = {}, extraReq: string[] = []) => objSchema(
	{
		source: str('Source entity name (must match a node name)'),
		target: str('Target entity name (must match a node name)'),
		relation: str('Relationship label, e.g. owns / part_of / causes / related_to'),
		description: str('Optional description of the relationship'),
		...extra,
	},
	['source', 'target', 'relation', ...extraReq],
	'A binary relation edge between two entities',
);

// ── Registry ─────────────────────────────────────────────────────────────

export const TEMPLATES: readonly KnowledgeTemplate[] = [

	// ═══ Existing general-purpose defaults (kept for backward compatibility) ═══

	{
		id: 'knowledge_graph',
		label: 'Knowledge Graph',
		description: 'General-purpose entity/relationship graph extraction (two-stage, accurate). ' +
			'Best for documents describing people, organizations, concepts and how they relate.',
		kind: 'graph',
		build: (llm, embedder, config) => new AutoGraph({
			llm, embedder, config,
			nodeSchema: GENERIC_NODE,
			edgeSchema: GENERIC_EDGE,
			nodeKeyExtractor: nodeKey,
			edgeKeyExtractor: edgeKey,
			nodesInEdgeExtractor: edgeEndpoints,
			extractionMode: 'two_stage',
			nodeStrategy: MergeStrategy.BALANCED,
			edgeStrategy: MergeStrategy.SIMPLE,
			nodeFieldsForIndex: ['name', 'type', 'description'],
			edgeFieldsForIndex: ['source', 'relation', 'target', 'description'],
		}),
	},
	{
		id: 'entity_list',
		label: 'Entity List',
		description: 'Flat list of items/facts/definitions (title + content). ' +
			'Best for glossaries, requirement lists, notes and simple fact banks.',
		kind: 'list',
		build: (llm, embedder, config) => new AutoList({
			llm, embedder, config,
			itemSchema: GENERIC_ITEM,
			keyExtractor: itemKey,
			strategy: MergeStrategy.BALANCED,
			fieldsForIndex: ['title', 'content', 'category'],
		}),
	},
	{
		id: 'faq',
		label: 'FAQ',
		description: 'Question/answer pairs. Best for support docs and Q&A knowledge bases.',
		kind: 'list',
		build: (llm, embedder, config) => new AutoList({
			llm, embedder, config,
			itemSchema: FAQ_ITEM,
			keyExtractor: faqKey,
			strategy: MergeStrategy.BALANCED,
			fieldsForIndex: ['question', 'answer'],
			prompt:
		getPrompt('template.faq'),
		}),
	},

	// ═══ General domain (Hyper-Extract presets) ═══

	graphTemplate({
		id: 'graph',
		label: 'General Graph',
		description: 'HE general/graph — extract entity nodes and binary relations from any text.',
		nodeSchema: GENERIC_NODE,
		edgeSchema: GENERIC_EDGE,
		prompt:
		getPrompt('template.graph'),
	}),

	listTemplate({
		id: 'list',
		label: 'General List',
		description: 'HE general/list — extract a list of items (keywords, tags, points, fragments).',
		itemSchema: objSchema(
			{
				item: str('List item content, quoted or summarized from the source'),
				type: str('Optional category label of the item'),
				description: str('Specific description or attributes of the item'),
			},
			['item'],
			'A generic list item',
		),
		key: (it: KnowledgeItem) => lc(it['item']),
		fieldsForIndex: ['item', 'type', 'description'],
		prompt:
		getPrompt('template.list'),
	}),

	listTemplate({
		id: 'model',
		label: 'General Model',
		description: 'HE general/model — extract a single structured object (name + description + type).',
		itemSchema: objSchema(
			{
				name: str('Object name / title, using the most stable designation'),
				description: str('Brief description of the object identity or role'),
				type: str('Optional type/category label'),
			},
			['name', 'description'],
			'A single structured object',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'description', 'type'],
		prompt:
		getPrompt('template.model'),
	}),

	listTemplate({
		id: 'set',
		label: 'General Set',
		description: 'HE general/set — identify key entities and aggregate them into a reusable registry (deduplicated).',
		itemSchema: objSchema(
			{
				name: str('Entity name, using the most stable designation'),
				type: str('Entity type, e.g. Person / Org / Location / Concept'),
				description: str('Brief description of the entity'),
			},
			['name', 'type'],
			'A deduped entity registry entry',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'type', 'description'],
		prompt:
		getPrompt('template.set'),
	}),

	// ── Document-level summary note (Hyper-Extract earnings_summary / model analogue) ──
	listTemplate({
		id: 'notes_summary',
		label: 'Notes Summary',
		description: 'HE general/notes_summary — turn any article into a single structured knowledge note (title + summary + tags + category + key points). Best for building a retrieval-friendly notes vault.',
		itemSchema: objSchema(
			{
				title: str('Note title / document name, using the most stable designation'),
				summary: str('One-paragraph abstract of the whole document (2-5 sentences, no preamble like "This document…")'),
				tags: arr('3-8 keyword tags for retrieval and categorization'),
				category: str('Single category id best matching the document: code_example / api_doc / architecture / bug_fix / config / tutorial / performance / security / devops / database / general'),
				key_points: arr('Up to 8 bullet-style key takeaways (concise, each <=30 chars)'),
			},
			['title', 'summary'],
			'A structured knowledge note',
		),
		key: (it: KnowledgeItem) => lc(it['title']),
		fieldsForIndex: ['title', 'summary', 'tags', 'category', 'key_points'],
		// Long docs are chunked; fuse all chunk notes into ONE via LLM.
		strategy: MergeStrategy.LLM,
		prompt:
		getPrompt('template.notes_summary'),
	}),

	graphTemplate({
		id: 'temporal_graph',
		label: 'Temporal Graph',
		description: 'HE general/temporal_graph — relations with an optional `time` attribute when the text provides time info.',
		nodeSchema: GENERIC_NODE,
		edgeSchema: REL_EDGE(
			{ time: str('Optional time of the relation, e.g. 2024 / at_age_20 / during_tenure; leave empty if none') },
			['time'],
		),
		edgeExtra: 'time',
		prompt:
		getPrompt('template.temporal_graph'),
		contextVars: { observation_time: new Date().toLocaleDateString('zh-CN') },
	}),

	graphTemplate({
		id: 'spatial_graph',
		label: 'Spatial Graph',
		description: 'HE general/spatial_graph — relations with an optional `location` attribute.',
		nodeSchema: GENERIC_NODE,
		edgeSchema: REL_EDGE(
			{ location: str('Optional location associated with the relation; leave empty if none') },
			['location'],
		),
		edgeExtra: 'location',
		prompt:
		getPrompt('template.spatial_graph'),
		contextVars: { observation_location: '未指定（请从文本推断）' },
	}),

	graphTemplate({
		id: 'spatio_temporal_graph',
		label: 'Spatio-Temporal Graph',
		description: 'HE general/spatio_temporal_graph — relations with optional `time` and `location` attributes.',
		nodeSchema: GENERIC_NODE,
		edgeSchema: REL_EDGE(
			{
				time: str('Optional time of the relation; leave empty if none'),
				location: str('Optional location of the relation; leave empty if none'),
			},
			['time', 'location'],
		),
		edgeExtra: 'time',
		prompt:
		getPrompt('template.spatio_temporal_graph'),
		contextVars: {
			observation_time: new Date().toLocaleDateString('zh-CN'),
			observation_location: '未指定（请从文本推断）',
		},
	}),

	graphTemplate({
		id: 'doc_structure',
		label: 'Document Structure',
		description: 'HE general/doc_structure — chapter hierarchy and cross-reference relations from docs/papers/reports.',
		nodeSchema: objSchema(
			{
				title: str('Chapter / section title or content identifier'),
				node_type: str('Node type: chapter/section/subsection/paragraph/code_block/table/figure/appendix/reference'),
				level: { type: 'integer', description: 'Hierarchy level starting from 1 (1=chapter)' },
				summary: str('Core content summary of the chapter (<=50 chars)'),
			},
			['title', 'node_type', 'level'],
			'A document chapter / content node',
		),
		edgeSchema: objSchema(
			{
				source: str('Source node title'),
				target: str('Target node title'),
				type: str('Relation type: contains/references/precedes/follows/relates_to/explains'),
				reference_context: str('Reference context, e.g. "as shown in Figure 3.2"'),
			},
			['source', 'target', 'type'],
			'A containment / cross-reference edge',
		),
		nodeKey: (n: KnowledgeItem) => lc(n['title']),
		nodeFields: ['title', 'node_type', 'level', 'summary'],
		edgeFields: ['source', 'target', 'type', 'reference_context'],
		prompt:
		getPrompt('template.doc_structure'),
	}),

	graphTemplate({
		id: 'concept_graph',
		label: 'Concept Graph',
		description: 'HE general/concept_graph — conceptual hierarchies and relations (textbooks, encyclopedias, papers).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.concept_graph'),
	}),

	graphTemplate({
		id: 'biography_graph',
		label: 'Biography Graph',
		description: 'HE general/biography_graph — life events with timestamps (biographies, memoirs, year timelines).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(
			{ time: str('Optional time of the event/relation; leave empty if none') },
			['time'],
		),
		edgeExtra: 'time',
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.biography_graph'),
	}),

	listTemplate({
		id: 'workflow_graph',
		label: 'Workflow Graph',
		description: 'HE general/workflow_graph — ordered workflow steps and execution order (skills, SOPs, agent workflows).',
		itemSchema: objSchema(
			{
				step: str('Workflow step name / action'),
				order: { type: 'integer', description: 'Step order index (starting from 1)' },
				role: str('Optional role / actor executing the step'),
				description: str('What the step does'),
			},
			['step', 'order'],
			'A workflow step',
		),
		key: (it: KnowledgeItem) => lc(it['step']),
		fieldsForIndex: ['step', 'role', 'description'],
		prompt:
		getPrompt('template.workflow_graph'),
	}),

	// ═══ Finance domain ═══

	graphTemplate({
		id: 'ownership_graph',
		label: 'Ownership Graph',
		description: 'HE finance/ownership_graph — shareholder ownership & control structure (IPO prospectuses, annual reports).',
		nodeSchema: objSchema(
			{
				name: str('Shareholder or company name'),
				shareholder_type: str('Shareholder type: institutional investor/individual/related party/public company'),
				description: str('Shareholder or company description'),
			},
			['name', 'shareholder_type'],
			'A shareholder / company entity',
		),
		edgeSchema: objSchema(
			{
				source: str('Controlling shareholder name'),
				target: str('Controlled company name'),
				type: str('Relation type: controls/belongs_to/holds_shares/acting_in_concert'),
				ownership_percentage: str('Ownership percentage'),
				description: str('Optional note'),
			},
			['source', 'target', 'type'],
			'A shareholding / control edge',
		),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		nodeFields: ['name', 'shareholder_type', 'description'],
		edgeFields: ['source', 'target', 'type', 'ownership_percentage'],
		prompt:
		getPrompt('template.ownership_graph'),
	}),

	listTemplate({
		id: 'earnings_summary',
		label: 'Earnings Summary',
		description: 'HE finance/earnings_summary — extract earnings-call key metrics (model → single structured object).',
		itemSchema: objSchema(
			{
				name: str('Company / report name'),
				description: str('Brief summary of the earnings highlights'),
				key_metrics: arr('Key financial metrics extracted, e.g. revenue / EPS / guidance'),
			},
			['name', 'description'],
			'An earnings summary object',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'description'],
		prompt:
		getPrompt('template.earnings_summary'),
	}),

	listTemplate({
		id: 'sentiment_model',
		label: 'Sentiment Model',
		description: 'HE finance/sentiment_model — quantify market sentiment & themes (model → structured object).',
		itemSchema: objSchema(
			{
				name: str('Subject / aspect being assessed'),
				sentiment: str('Sentiment polarity: positive / neutral / negative'),
				description: str('Rationale or evidence for the sentiment'),
			},
			['name', 'sentiment'],
			'A sentiment assessment object',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'sentiment', 'description'],
		prompt:
		getPrompt('template.sentiment_model'),
	}),

	listTemplate({
		id: 'event_timeline',
		label: 'Event Timeline',
		description: 'HE finance/event_timeline — company event timelines (8-K filings, news).',
		itemSchema: objSchema(
			{
				event: str('Event name / description'),
				time: str('When the event occurred, e.g. 2024 / 2024-03 / during_tenure'),
				description: str('Details of the event'),
			},
			['event', 'time'],
			'A timeline event',
		),
		key: (it: KnowledgeItem) => `${lc(it['event'])}|${lc(it['time'])}`,
		fieldsForIndex: ['event', 'time', 'description'],
		prompt:
		getPrompt('template.event_timeline'),
	}),

	listTemplate({
		id: 'risk_factor_set',
		label: 'Risk Factor Set',
		description: 'HE finance/risk_factor_set — catalog risk factors by category (set → deduplicated).',
		itemSchema: objSchema(
			{
				name: str('Risk factor name'),
				category: str('Risk category, e.g. market / credit / operational / regulatory'),
				description: str('Description of the risk'),
			},
			['name', 'category'],
			'A risk factor entry',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'category', 'description'],
		prompt:
		getPrompt('template.risk_factor_set'),
	}),

	// ═══ Medicine domain ═══

	graphTemplate({
		id: 'drug_interaction',
		label: 'Drug Interaction',
		description: 'HE medicine/drug_interaction — map drug interaction networks.',
		nodeSchema: ENTITY_NODE,
		edgeSchema: objSchema(
			{
				source: str('Source drug name'),
				target: str('Target drug name'),
				relation: str('Interaction type, e.g. potentiates / inhibits / contraindicated'),
				severity: str('Severity: mild / moderate / severe / unknown'),
				description: str('Mechanism or clinical note'),
			},
			['source', 'target', 'relation'],
			'A drug-interaction edge',
		),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		nodeFields: ['name', 'type', 'description'],
		edgeFields: ['source', 'target', 'relation', 'severity'],
		prompt:
		getPrompt('template.drug_interaction'),
	}),

	graphTemplate({
		id: 'anatomy_graph',
		label: 'Anatomy Graph',
		description: 'HE medicine/anatomy_graph — anatomical hierarchies (textbooks, surgical records).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.anatomy_graph'),
	}),

	listTemplate({
		id: 'treatment_map',
		label: 'Treatment Map',
		description: 'HE medicine/treatment_map — diagnosis→treatment→outcome mappings (hypergraph → list with participants).',
		itemSchema: objSchema(
			{
				name: str('Diagnosis / condition name'),
				type: str('Entry type: diagnosis / treatment / outcome'),
				participants: arr('Related treatments / outcomes / entities participating in this mapping'),
				description: str('Description of the diagnosis-treatment-outcome mapping'),
			},
			['name', 'type'],
			'A treatment-mapping entry',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'type', 'description'],
		prompt:
		getPrompt('template.treatment_map'),
	}),

	listTemplate({
		id: 'hospital_timeline',
		label: 'Hospital Timeline',
		description: 'HE medicine/hospital_timeline — patient admission timelines (discharge summaries, progress notes).',
		itemSchema: objSchema(
			{
				event: str('Clinical event / note'),
				time: str('When it occurred, e.g. 2024-05-12 / day_3 / during_admission'),
				description: str('Details of the event'),
			},
			['event', 'time'],
			'A hospital-timeline event',
		),
		key: (it: KnowledgeItem) => `${lc(it['event'])}|${lc(it['time'])}`,
		fieldsForIndex: ['event', 'time', 'description'],
		prompt:
		getPrompt('template.hospital_timeline'),
	}),

	listTemplate({
		id: 'discharge_instruction',
		label: 'Discharge Instruction',
		description: 'HE medicine/discharge_instruction — structured patient discharge info (model → object).',
		itemSchema: objSchema(
			{
				name: str('Patient / case identifier'),
				description: str('Summary of diagnosis and discharge condition'),
				instructions: arr('Discharge instructions / follow-up / medications'),
			},
			['name', 'description'],
			'A discharge-instruction object',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'description'],
		prompt:
		getPrompt('template.discharge_instruction'),
	}),

	// ═══ TCM domain ═══

	graphTemplate({
		id: 'meridian_graph',
		label: 'Meridian Graph',
		description: 'HE tcm/meridian_graph — acupoint-meridian relationships.',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.meridian_graph'),
	}),

	graphTemplate({
		id: 'herb_relation',
		label: 'Herb Relation',
		description: 'HE tcm/herb_relation — herb compatibility (七情) networks.',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(
			{ compatibility: str('Compatibility: 相须/相使/相畏/相恶/相反/相杀') },
			['compatibility'],
		),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.herb_relation'),
	}),

	listTemplate({
		id: 'herb_property',
		label: 'Herb Property',
		description: 'HE tcm/herb_property — herb properties (四气五味) (model → object).',
		itemSchema: objSchema(
			{
				name: str('Herb name'),
				description: str('Brief description / indication'),
				properties: arr('Properties: 四气 (寒/热/温/凉) / 五味 (酸/苦/甘/辛/咸) / 归经'),
			},
			['name', 'description'],
			'A herb-property object',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'description'],
		prompt:
		getPrompt('template.herb_property'),
	}),

	listTemplate({
		id: 'formula_composition',
		label: 'Formula Composition',
		description: 'HE tcm/formula_composition — formula composition 君臣佐使 (hypergraph → list with participants).',
		itemSchema: objSchema(
			{
				name: str('Formula name'),
				type: str('Entry type: formula / herb / role'),
				participants: arr('Herbs in the formula and their 君臣佐使 roles'),
				description: str('Description / indication of the formula'),
			},
			['name', 'type'],
			'A formula-composition entry',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'type', 'description'],
		prompt:
		getPrompt('template.formula_composition'),
	}),

	listTemplate({
		id: 'syndrome_reasoning',
		label: 'Syndrome Reasoning',
		description: 'HE tcm/syndrome_reasoning — syndrome-treatment reasoning (hypergraph → list with participants).',
		itemSchema: objSchema(
			{
				name: str('Syndrome / 证 name'),
				type: str('Entry type: syndrome / treatment / symptom'),
				participants: arr('Related symptoms / pathogenesis / treatments'),
				description: str('Reasoning of the syndrome-treatment mapping'),
			},
			['name', 'type'],
			'A syndrome-reasoning entry',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'type', 'description'],
		prompt:
		getPrompt('template.syndrome_reasoning'),
	}),

	// ═══ Industry domain ═══

	graphTemplate({
		id: 'operation_flow',
		label: 'Operation Flow',
		description: 'HE industry/operation_flow — operation steps and outcomes (SOPs, operation manuals).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(
			{ outcome: str('Outcome of the operation step') },
			['outcome'],
		),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.operation_flow'),
	}),

	graphTemplate({
		id: 'safety_control',
		label: 'Safety Control',
		description: 'HE industry/safety_control — hazard-risk-control relationships (safety handbooks).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.safety_control'),
	}),

	graphTemplate({
		id: 'failure_case',
		label: 'Failure Case',
		description: 'HE industry/failure_case — failure phenomenon-causes-solutions (failure analysis reports).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(
			{ cause: str('Root cause of the failure') },
			['cause'],
		),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.failure_case'),
	}),

	graphTemplate({
		id: 'equipment_topology',
		label: 'Equipment Topology',
		description: 'HE industry/equipment_topology — equipment hierarchies and connections (equipment manuals).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.equipment_topology'),
	}),

	graphTemplate({
		id: 'emergency_response',
		label: 'Emergency Response',
		description: 'HE industry/emergency_response — emergency scenarios and responses (emergency plans).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.emergency_response'),
	}),

	// ═══ Legal domain ═══

	listTemplate({
		id: 'contract_obligation',
		label: 'Contract Obligation',
		description: 'HE legal/contract_obligation — party-obligation relationships (hypergraph → list with participants).',
		itemSchema: objSchema(
			{
				name: str('Obligation / clause name'),
				type: str('Entry type: obligation / party / condition'),
				participants: arr('Parties / conditions involved in the obligation'),
				description: str('Description of the obligation'),
			},
			['name', 'type'],
			'A contract-obligation entry',
		),
		key: (it: KnowledgeItem) => lc(it['name']),
		fieldsForIndex: ['name', 'type', 'description'],
		prompt:
		getPrompt('template.contract_obligation'),
	}),

	listTemplate({
		id: 'case_fact_timeline',
		label: 'Case Fact Timeline',
		description: 'HE legal/case_fact_timeline — case fact timelines (court judgments).',
		itemSchema: objSchema(
			{
				event: str('Case fact / event'),
				time: str('When it occurred, e.g. 2023-06 / during_contract'),
				description: str('Details of the fact'),
			},
			['event', 'time'],
			'A case-fact event',
		),
		key: (it: KnowledgeItem) => `${lc(it['event'])}|${lc(it['time'])}`,
		fieldsForIndex: ['event', 'time', 'description'],
		prompt:
		getPrompt('template.case_fact_timeline'),
	}),

	graphTemplate({
		id: 'case_citation',
		label: 'Case Citation',
		description: 'HE legal/case_citation — case citation relationships (opinions, case law).',
		nodeSchema: ENTITY_NODE,
		edgeSchema: REL_EDGE(
			{ citation: str('Citation type: 引用/被引用/参照/推翻') },
			['citation'],
		),
		nodeKey: (n: KnowledgeItem) => lc(n['name']),
		prompt:
		getPrompt('template.case_citation'),
	}),

	listTemplate({
		id: 'compliance_list',
		label: 'Compliance List',
		description: 'HE legal/compliance_list — structured compliance requirements (manuals, audit reports).',
		itemSchema: objSchema(
			{
				item: str('Compliance requirement / clause'),
				type: str('Category: 数据保护/反洗钱/信息披露/内控 etc.'),
				description: str('Description / obligation of the requirement'),
			},
			['item', 'type'],
			'A compliance requirement',
		),
		key: (it: KnowledgeItem) => lc(it['item']),
		fieldsForIndex: ['item', 'type', 'description'],
		prompt:
		getPrompt('template.compliance_list'),
	}),

	listTemplate({
		id: 'defined_term_set',
		label: 'Defined Term Set',
		description: 'HE legal/defined_term_set — catalog defined terms (contracts, opinions) (set → deduplicated).',
		itemSchema: objSchema(
			{
				term: str('Defined term'),
				definition: str('Definition of the term'),
				category: str('Optional category'),
			},
			['term', 'definition'],
			'A defined-term entry',
		),
		key: (it: KnowledgeItem) => lc(it['term']),
		fieldsForIndex: ['term', 'definition', 'category'],
		prompt:
		getPrompt('template.defined_term_set'),
	}),
];

export function getTemplate(id: string): KnowledgeTemplate | undefined {
	return TEMPLATES.find(t => t.id === id);
}

/**
 * Domain each template belongs to (mirrors the HE preset catalog's 6 domains).
 * Centralized so adding a preset requires no extra wiring; unknown ids fall back
 * to `'general'`.
 */
const TEMPLATE_DOMAIN: Record<string, string> = {
	// general
	knowledge_graph: 'general', entity_list: 'general', faq: 'general',
	graph: 'general', list: 'general', model: 'general', set: 'general', notes_summary: 'general',
	temporal_graph: 'general', spatial_graph: 'general', spatio_temporal_graph: 'general',
	doc_structure: 'general', concept_graph: 'general', biography_graph: 'general', workflow_graph: 'general',
	// finance
	ownership_graph: 'finance', earnings_summary: 'finance', sentiment_model: 'finance',
	event_timeline: 'finance', risk_factor_set: 'finance',
	// medicine
	drug_interaction: 'medicine', anatomy_graph: 'medicine', treatment_map: 'medicine',
	hospital_timeline: 'medicine', discharge_instruction: 'medicine',
	// tcm
	meridian_graph: 'tcm', herb_relation: 'tcm', herb_property: 'tcm',
	formula_composition: 'tcm', syndrome_reasoning: 'tcm',
	// industry
	operation_flow: 'industry', safety_control: 'industry', failure_case: 'industry',
	equipment_topology: 'industry', emergency_response: 'industry',
	// legal
	contract_obligation: 'legal', case_fact_timeline: 'legal', case_citation: 'legal',
	compliance_list: 'legal', defined_term_set: 'legal',
};
const DEFAULT_DOMAIN = 'general';

/** Resolve a template's domain (falls back to `general`). */
export function templateDomain(id: string): string {
	return TEMPLATE_DOMAIN[id] ?? DEFAULT_DOMAIN;
}

export interface TemplateListFilter {
	/** Filter by AutoType kind. */
	kind?: TemplateKind;
	/** Filter by domain (general / finance / medicine / tcm / industry / legal). */
	domain?: string;
}

export interface TemplateSummary {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly kind: TemplateKind;
	readonly domain: string;
}

/** List template summaries, optionally filtered by kind and/or domain. */
export function listTemplates(filter?: TemplateListFilter): TemplateSummary[] {
	return TEMPLATES
		.map(({ id, label, description, kind }) => ({ id, label, description, kind, domain: templateDomain(id) }))
		.filter(t => (!filter?.kind || t.kind === filter.kind) && (!filter?.domain || t.domain === filter.domain));
}

export type { GraphData };
