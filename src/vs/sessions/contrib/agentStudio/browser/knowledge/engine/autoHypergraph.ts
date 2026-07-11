/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — AutoHypergraph
 *
 *  Faithful port of `hyperextract/types/hypergraph.py::AutoHypergraph`.
 *  Extracts N-ary HYPERGRAPHS: each fact connects ≥2 entities at once via a
 *  `participants` array + a single `relation` label. In contrast to AutoGraph
 *  (strict binary source→target edges), a hyperedge has no fixed arity.
 *
 *  Key structural guarantees (the G1 correctness gap vs the old AutoList
 *  approximation):
 *    - Each hyperedge's `participants` are stored as a FULL tuple; the edge key
 *      sorts the participants so {A,B,rel} == {B,A,rel}.
 *    - STRICT dangling pruning: a hyperedge is kept ONLY if EVERY one of its
 *      participants exists as a node. (AutoGraph's prune only checks the two
 *      endpoints; a hypergraph must check all N participants.)
 *
 *  Public surface mirrors `AutoGraph` so the KnowledgeManager graph pipeline
 *  (searchGraph / chatGraph / toMarkdown / toObsidianVault / serialize) and the
 *  `.data = { nodes, edges }` contract work unchanged — `edges` here is the
 *  native hyperedge list.
 *--------------------------------------------------------------------------------------------*/

import { BaseAutoType, batch } from './base.js';
import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';
import { OMem } from './omem.js';
import { IMerger, MergeStrategy } from './merge.js';
import {
	AutoTypeConfig, JsonSchema, KeyExtractor, KnowledgeItem, LabelExtractor,
	filterValidItems,
} from './types.js';
import {
	CommunityDetectionResult, CommunityEdge, detectCommunities,
} from './communityDetection.js';
import { CommunitySummary, summarizeCommunities } from './communitySummary.js';

export type HypergraphData = {
	nodes: KnowledgeItem[];
	hyperedges: KnowledgeItem[];
};

export interface AutoHypergraphDeps {
	llm: IChatModel;
	embedder: IEmbedder;
	nodeSchema: JsonSchema;
	hyperedgeSchema: JsonSchema;
	nodeKeyExtractor: KeyExtractor;
	/** Extract a stable key for a hyperedge: SORTED participants + relation. */
	hyperedgeKeyExtractor?: KeyExtractor;
	/** Return the participant keys of a hyperedge (for pruning / indexing). */
	incidentNodesExtractor?: (he: KnowledgeItem) => string[];
	config?: AutoTypeConfig;
	extractionMode?: 'one_stage' | 'two_stage';
	nodeStrategy?: MergeStrategy | IMerger<KnowledgeItem>;
	hyperedgeStrategy?: MergeStrategy | IMerger<KnowledgeItem>;
	nodeFieldsForIndex?: string[];
	hyperedgeFieldsForIndex?: string[];
	nodeLabelExtractor?: LabelExtractor;
	hyperedgeLabelExtractor?: LabelExtractor;
	promptForNodeExtraction?: string;
	promptForHyperedgeExtraction?: string;
	contextVars?: Record<string, string>;
	/**
	 * P3 — GraphRAG community detection (over the projected pairwise graph).
	 * When true, after ingestion Louvain community detection runs over the
	 * participants and the LLM summarizes each community. Mirrors GraphRAG.
	 */
	communityAware?: boolean;
	/** Louvain resolution γ. Default 1.0. */
	communityResolution?: number;
	/** Custom community-summarization prompt. */
	communitySummaryPrompt?: string;
}

const lc = (v: unknown): string => String(v ?? '').trim().toLowerCase();
const DEFAULT_PARTICIPANT_SEP = '|';

function participantsOf(he: KnowledgeItem): string[] {
	const p = he['participants'];
	if (Array.isArray(p)) { return (p as unknown[]).map(lc).filter(Boolean); }
	if (p === undefined || p === null || p === '') { return []; }
	return [lc(p)];
}

/** Default hyperedge key: participants sorted (order-independent) + relation. */
function defaultHyperKey(he: KnowledgeItem): string {
	const ps = participantsOf(he).sort();
	return ps.join(DEFAULT_PARTICIPANT_SEP) + DEFAULT_PARTICIPANT_SEP + lc(he['relation']);
}

const DEFAULT_HYPER_PROMPT =
	'You are an expert N-ary relation extraction assistant. ' +
	'Extract two things from the text:\n' +
	'1) nodes: the key entities/concepts (each with a canonical `name`).\n' +
	'2) hyperedges: facts that connect MULTIPLE entities at once. Each hyperedge has a ' +
	'`participants` array (≥2 entity names that MUST match nodes you extracted) and a single ' +
	'`relation` label summarizing the group interaction.\n' +
	'CRITICAL: every participant of a hyperedge must be a node you listed. ' +
	'Do not invent participants.\n\n' +
	'### Source Text:\n{source_text}';

const DEFAULT_HYPER_NODE_PROMPT =
	'You are an expert entity extraction assistant. Identify the KEY entities in the text. ' +
	'Return one record per entity with a canonical `name`.\n\n' +
	'### Source Text:\n{source_text}';

const DEFAULT_HYPER_HYPEREDGE_PROMPT =
	'You are an expert N-ary relation extraction assistant. For the provided entities, ' +
	'extract HYPEREDGES — facts connecting MULTIPLE of them at once. Each hyperedge has:\n' +
	'- `participants`: an array of ≥2 entity names from the known entity list below\n' +
	'- `relation`: a single label summarizing the group interaction\n' +
	'- optional `description`\n' +
	'CRITICAL: ONLY use entities from the known entity list. Every participant must be listed.\n\n' +
	'# Provided Entities\n{known_nodes}\n\n# Source Text:\n{source_text}';

function render(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

/** JSON-Schema for a hypergraph container (nodes + hyperedges). */
function hyperSchema(nodeSchema: JsonSchema, heSchema: JsonSchema, description: string): JsonSchema {
	return {
		type: 'object',
		description,
		properties: {
			nodes: { type: 'array', description: 'Hypergraph nodes / entities', items: nodeSchema },
			hyperedges: { type: 'array', description: 'N-ary hyperedges (multi-participant facts)', items: heSchema },
		},
		required: ['nodes', 'hyperedges'],
	};
}

export class AutoHypergraph extends BaseAutoType<HypergraphData> {
	private readonly nodeSchema: JsonSchema;
	private readonly heSchema: JsonSchema;
	private readonly nodeKeyExtractor: KeyExtractor;
	private readonly heKeyExtractor: KeyExtractor;
	private readonly incidentExtractor: (he: KnowledgeItem) => string[];
	private readonly mode: 'one_stage' | 'two_stage';
	private readonly nodePrompt: string;
	private readonly hePrompt: string;
	private readonly ctxVars: Record<string, string>;
	// ── P3: community detection state ─────────
	private readonly _communityAware: boolean;
	private readonly communityResolution: number;
	private readonly communitySummaryPrompt: string;
	private detected?: CommunityDetectionResult;
	private summaries: CommunitySummary[] = [];
	private nodeMemory!: OMem<KnowledgeItem>;
	private heMemory!: OMem<KnowledgeItem>;

	constructor(private readonly hdeps: AutoHypergraphDeps) {
		super({ llm: hdeps.llm, embedder: hdeps.embedder, config: hdeps.config });
		this.nodeSchema = hdeps.nodeSchema;
		this.heSchema = hdeps.hyperedgeSchema;
		this.nodeKeyExtractor = hdeps.nodeKeyExtractor;
		this.heKeyExtractor = hdeps.hyperedgeKeyExtractor ?? defaultHyperKey;
		this.incidentExtractor = hdeps.incidentNodesExtractor ?? participantsOf;
		this.mode = hdeps.extractionMode ?? 'one_stage';
		this.nodePrompt = hdeps.promptForNodeExtraction ?? DEFAULT_HYPER_NODE_PROMPT;
		this.hePrompt = hdeps.promptForHyperedgeExtraction ?? DEFAULT_HYPER_HYPEREDGE_PROMPT;
		this.ctxVars = hdeps.contextVars ?? {};
		this._communityAware = hdeps.communityAware ?? false;
		this.communityResolution = hdeps.communityResolution ?? 1.0;
		this.communitySummaryPrompt = hdeps.communitySummaryPrompt ?? '';

	this.nodeMemory = new OMem<KnowledgeItem>({
			keyExtractor: this.nodeKeyExtractor,
			itemSchema: this.nodeSchema,
			llm: hdeps.llm,
			embedder: hdeps.embedder,
			strategy: hdeps.nodeStrategy ?? MergeStrategy.BALANCED,
			fieldsForIndex: hdeps.nodeFieldsForIndex,
		});
		this.heMemory = new OMem<KnowledgeItem>({
			keyExtractor: this.heKeyExtractor,
			itemSchema: this.heSchema,
			llm: hdeps.llm,
			embedder: hdeps.embedder,
			strategy: hdeps.hyperedgeStrategy ?? MergeStrategy.BALANCED,
			fieldsForIndex: hdeps.hyperedgeFieldsForIndex,
		});
		this._initDataState();
		this._initIndexState();
	}

	protected _defaultPrompt(): string { return DEFAULT_HYPER_PROMPT; }

	get data(): HypergraphData {
		return { nodes: this.nodeMemory.all, hyperedges: this.heMemory.all };
	}

	/** Graph-pipeline compatible alias: `edges` === native hyperedges. */
	get edges(): KnowledgeItem[] { return this.heMemory.all; }
	get nodes(): KnowledgeItem[] { return this.nodeMemory.all; }
	get hyperedges(): KnowledgeItem[] { return this.heMemory.all; }

	empty(): boolean { return this.nodeMemory.empty() && this.heMemory.empty(); }

	// ── P3: GraphRAG community detection (over projected pairwise graph) ─────

	get communityAware(): boolean { return this._communityAware; }
	get communitySummaries(): CommunitySummary[] { return this.summaries; }
	get detectedCommunities(): CommunityDetectionResult | undefined { return this.detected; }

	/**
	 * Project the N-ary hyperedges onto a pairwise graph (every participant
	 * pair of a hyperedge becomes an undirected edge) and run Louvain
	 * community detection. Assigns a `community` field to each node.
	 */
	async detectCommunities(): Promise<CommunityDetectionResult> {
		const nodeIds = this.nodes.map(n => this.nodeKeyExtractor(n));
		const edges: CommunityEdge[] = [];
		for (const he of this.hyperedges) {
			const ps = this.incidentExtractor(he);
			for (let a = 0; a < ps.length; a++) {
				for (let b = a + 1; b < ps.length; b++) {
					edges.push({ source: ps[a], target: ps[b] });
				}
			}
		}
		const result = detectCommunities(nodeIds, edges, { resolution: this.communityResolution });
		const byKey = new Map<string, KnowledgeItem>();
		for (const n of this.nodes) { byKey.set(this.nodeKeyExtractor(n), n); }
		for (const [key, cid] of result.nodeCommunity) {
			const node = byKey.get(key);
			if (node) { node['community'] = cid; }
		}
		this.detected = result;
		this.summaries = [];
		return result;
	}

	/** Ensure community enrichment (detect + LLM-summarize once). */
	async ensureCommunityEnrichment(llm: IChatModel): Promise<void> {
		if (!this._communityAware) { return; }
		if (!this.detected) { await this.detectCommunities(); }
		if (this.detected && this.summaries.length === 0 && this.detected.communities.size > 0) {
			this.summaries = await summarizeCommunities({
				llm,
				result: this.detected,
				membersOf: (cid) => {
					const map = this.detected!.nodeCommunity;
					return this.nodes
						.filter(n => map.get(this.nodeKeyExtractor(n)) === cid)
						.map(n => ({
							id: this.nodeKeyExtractor(n),
							name: String(n['name'] ?? ''),
							description: n['description'] ? String(n['description']) : undefined,
						}));
				},
				incidentEdgesOf: (cid) => {
					const map = this.detected!.nodeCommunity;
					// Hyperedges fully contained in the community.
					return this.hyperedges
						.filter(he => {
							const ps = this.incidentExtractor(he);
							return ps.length >= 2 && ps.every(p => map.get(p) === cid);
						})
						.map(he => ({
							source: participantsOf(he)[0] ?? '',
							target: participantsOf(he)[1] ?? '',
							relation: he['relation'] ? String(he['relation']) : undefined,
						}));
				},
				prompt: this.communitySummaryPrompt || undefined,
			});
		}
	}

	protected _initDataState(): void {
		this.nodeMemory?.clear();
		this.heMemory?.clear();
	}

	protected async _setDataState(data: HypergraphData): Promise<void> {
		this.nodeMemory.clear();
		this.heMemory.clear();
		if (data.nodes?.length) { await this.nodeMemory.add(data.nodes); }
		if (data.hyperedges?.length) { await this.heMemory.add(data.hyperedges); }
		this.clearIndex();
	}

	protected async _updateDataState(data: HypergraphData): Promise<void> {
		if (this.empty()) {
			await this._setDataState(data);
			return;
		}
		if (data.nodes?.length) { await this.nodeMemory.add(data.nodes); }
		if (data.hyperedges?.length) { await this.heMemory.add(data.hyperedges); }
		this.clearIndex();
	}

	protected _initIndexState(): void {
		this.nodeMemory?.clearIndex();
		this.heMemory?.clearIndex();
	}

	protected async _extractOne(text: string): Promise<HypergraphData | null> {
		return this._extractOnce(text);
	}

	// ── Extraction pipeline ─────────────────────────────

	protected override async _extractData(text: string): Promise<HypergraphData> {
		const g = this.mode === 'two_stage'
			? await this._extractTwoStage(text)
			: await this._extractOneStage(text);
		return this._pruneDangling(g);
	}

	private async _extractOneStage(text: string): Promise<HypergraphData> {
		if (text.length <= this.chunkSize) {
			const g = await this._extractOnce(text);
			return g ?? { nodes: [], hyperedges: [] };
		}
		const chunks = this.splitter.withOverlap(this.splitter.splitText(text));
		const list = await batch(chunks, this.maxWorkers, (c) => this._extractOnce(c));
		const filtered = list.filter((x): x is HypergraphData => x !== null);
		return this.mergeBatchData(filtered);
	}

	private async _extractTwoStage(text: string): Promise<HypergraphData> {
		const chunks = text.length <= this.chunkSize
			? [text]
			: this.splitter.withOverlap(this.splitter.splitText(text));

		const nodeLists = await batch(chunks, this.maxWorkers, (c) => this._extractNodeList(c));
		const heLists = await batch(chunks, this.maxWorkers, (c, i) =>
			this._extractHyperedgeList(c, nodeLists[i]?.items ?? []));

		return this.mergeBatchData([
			nodeLists.map(n => n.items),
			heLists.map(h => h.items),
		] as unknown as HypergraphData[]);
	}

	private async _extractOnce(text: string): Promise<HypergraphData | null> {
		const rendered = render(this.prompt, { source_text: text, ...this.ctxVars });
		const schema = hyperSchema(this.nodeSchema, this.heSchema, 'Extracted hypergraph');
		try {
			const g = await this.llm.extract<HypergraphData>({ prompt: rendered, schema });
			return {
				nodes: filterValidItems(g?.nodes, this.nodeSchema),
				hyperedges: filterValidItems(g?.hyperedges, this.heSchema),
			};
		} catch (e) {
			if (this.verbose) { console.warn('[AutoHypergraph] one-stage extract failed:', e); }
			return null;
		}
	}

	private async _extractNodeList(text: string): Promise<{ items: KnowledgeItem[] }> {
		const rendered = render(this.nodePrompt, { source_text: text, ...this.ctxVars });
		try {
			const r = await this.llm.extract<{ items: KnowledgeItem[] }>({
				prompt: rendered, schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: this.nodeSchema } } },
			});
			return { items: filterValidItems(r?.items, this.nodeSchema) };
		} catch {
			return { items: [] };
		}
	}

	private async _extractHyperedgeList(text: string, nodes: KnowledgeItem[]): Promise<{ items: KnowledgeItem[] }> {
		const known = nodes.length
			? nodes.map(n => this.nodeKeyExtractor(n)).join('\n- ')
			: 'No specific entities identified in this chunk.';
		const rendered = render(this.hePrompt, { source_text: text, known_nodes: known, ...this.ctxVars });
		try {
			const r = await this.llm.extract<{ items: KnowledgeItem[] }>({
				prompt: rendered, schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: this.heSchema } } },
			});
			return { items: filterValidItems(r?.items, this.heSchema) };
		} catch {
			return { items: [] };
		}
	}

	/**
	 * STRICT dangling pruning. A hyperedge is kept only if EVERY one of its
	 * participants is present as a known node (either in this batch or already in
	 * the store). This is the core correctness guarantee that distinguishes a real
	 * hypergraph from the old AutoList approximation (which could not enforce
	 * participant completeness).
	 */
	private _pruneDangling(graph: HypergraphData): HypergraphData {
		const validKeys = new Set<string>(graph.nodes.map(n => this.nodeKeyExtractor(n)));
		const memoryKeys = this.nodeMemory.keys();
		const refined = graph.hyperedges.filter(he => {
			const parts = this.incidentExtractor(he);
			if (parts.length < 2) { return false; }
			return parts.every(p => validKeys.has(p) || memoryKeys.has(p));
		});
		if (this.verbose && refined.length !== graph.hyperedges.length) {
			console.log(`[AutoHypergraph] pruned ${graph.hyperedges.length - refined.length} dangling hyperedges`);
		}
		return { nodes: graph.nodes, hyperedges: refined };
	}

	// ── Merge ─────────────────────────────

	mergeBatchData(
		data: HypergraphData[] | [KnowledgeItem[][], KnowledgeItem[][]],
	): HypergraphData {
		let allNodes: KnowledgeItem[];
		let allHes: KnowledgeItem[];
		if (Array.isArray(data) && !this._isHyper(data[0])) {
			const [nodeLists, heLists] = data as [KnowledgeItem[][], KnowledgeItem[][]];
			allNodes = nodeLists.flat();
			allHes = heLists.flat();
		} else {
			const list = data as HypergraphData[];
			allNodes = list.flatMap(g => g.nodes ?? []);
			allHes = list.flatMap(g => g.hyperedges ?? []);
		}
		return { nodes: allNodes, hyperedges: allHes };
	}

	private _isHyper(x: unknown): x is HypergraphData {
		return !!x && typeof x === 'object' && 'nodes' in (x as object) && 'hyperedges' in (x as object);
	}

	// ── Indexing / search / chat ─────────────────────────────

	async buildIndex(): Promise<void> {
		if (this.empty()) { return; }
		await this.nodeMemory.buildIndex();
		await this.heMemory.buildIndex();
	}

	async searchNodes(query: string, topK = 3): Promise<KnowledgeItem[]> {
		if (!this.nodeMemory.hasIndex()) {
			throw new Error('Node index not built. Call buildIndex() first.');
		}
		return this.nodeMemory.search(query, topK);
	}

	/** Semantic search over hyperedges ("edges" from the graph pipeline's view). */
	async searchHyperedges(query: string, topK = 3): Promise<KnowledgeItem[]> {
		if (!this.heMemory.hasIndex()) {
			throw new Error('Hyperedge index not built. Call buildIndex() first.');
		}
		return this.heMemory.search(query, topK);
	}

	/** Graph-compatible search returning typed { nodes, edges(=hyperedges) }. */
	async searchGraph(
		query: string,
		topKNodes = 3,
		topKHes = 3,
	): Promise<{ nodes: KnowledgeItem[]; edges: KnowledgeItem[] }> {
		const nodes = topKNodes > 0 ? await this.searchNodes(query, topKNodes) : [];
		const hes = topKHes > 0 ? await this.searchHyperedges(query, topKHes) : [];
		return { nodes, edges: hes };
	}

	override async search(query: string, topK = 3): Promise<unknown[]> {
		return this.searchNodes(query, topK);
	}

	override async chat(query: string, topK = 3): Promise<{ text: string; retrieved: unknown[] }> {
		const { text, retrieved } = await this.chatGraph(query, topK, topK);
		return { text, retrieved: [...retrieved.nodes, ...retrieved.edges] };
	}

	/** Full hypergraph chat with typed return. */
	async chatGraph(query: string, topKNodes = 3, topKHes = 3): Promise<{ text: string; retrieved: { nodes: KnowledgeItem[]; edges: KnowledgeItem[] } }> {
		const { nodes, edges } = await this.searchGraph(query, topKNodes, topKHes);
		const parts: string[] = [];
		if (nodes.length) {
			parts.push('=== Relevant Nodes ===');
			for (const n of nodes) { parts.push(JSON.stringify(n, null, 2)); }
		}
		if (edges.length) {
			parts.push('=== Relevant Hyperedges (N-ary facts) ===');
			for (const e of edges) {
				const ps = participantsOf(e);
				parts.push(`(${ps.join(' | ')}) --${String(e['relation'] ?? 'relates')}--`);
			}
		}
		const context = parts.length
			? parts.join('\n\n')
			: 'No relevant information found in the hypergraph.';
		const text = await this.llm.complete(
			'Based on the following Hypergraph Knowledge, answer the user\'s question.',
			`Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
		);
		return { text, retrieved: { nodes, edges } };
	}

	// ── Export (Obsidian / Markdown / Mermaid) ─────────────────────────────

	override toMarkdown(opts: { title?: string; mermaid?: boolean; wikilinks?: boolean } = {}): string {
		const title = opts.title ?? 'Knowledge Hypergraph';
		const useMermaid = opts.mermaid ?? true;
		const useWiki = opts.wikilinks ?? true;
		const nodes = this.nodes;
		const hes = this.hyperedges;

		const link = (name: unknown): string => {
			const s = String(name ?? '').trim();
			return useWiki && s ? `[[${s}]]` : s;
		};
		const plink = (p: string): string => link(p);

		const lines: string[] = [];
		lines.push(`# ${title}`, '');
		lines.push(`> 由 Hyper-Extract (TS) 知识引擎自动导出 · 节点 ${nodes.length} · 超边 ${hes.length}`, '');

		lines.push('## 节点 (Nodes)', '');
		if (nodes.length === 0) {
			lines.push('_（暂无节点）_', '');
		} else {
			for (const n of nodes) {
				const name = String(n['name'] ?? '').trim();
				const type = n['type'] ? ` (\`${String(n['type'])}\`)` : '';
				const desc = n['description'] ? `: ${String(n['description'])}` : '';
				lines.push(`- ${link(name)}${type}${desc}`);
			}
			lines.push('');
		}

		lines.push('## 超边 (Hyperedges)', '');
		if (hes.length === 0) {
			lines.push('_（暂无超边）_', '');
		} else {
			for (const he of hes) {
				const ps = participantsOf(he).map(plink);
				const rel = he['relation'] ? `\`${String(he['relation'])}\`` : 'relates to';
				const desc = he['description'] ? ` — ${String(he['description'])}` : '';
				lines.push(`- ${ps.join(' ✕ ')} --${rel}-->${desc}`);
			}
			lines.push('');
		}

		if (useMermaid) {
			lines.push('## 图谱 (Mermaid)', '');
			lines.push('```mermaid', this.toMermaid(), '```', '');
		}

		// P3: GraphRAG communities.
		if (this.detected && this.detected.communities.size > 0) {
			lines.push('## 社区 (Communities)', '');
			lines.push(`> ${this.detected.communities.size} 个社区 · 模块化 Q=${this.detected.modularity.toFixed(3)}`, '');
			for (const [cid, members] of this.detected.communities) {
				const sum = this.summaries.find(s => s.id === cid);
				lines.push(`### ${sum?.title ?? cid} (\`${cid}\`, ${members.length} 节点)`, '');
				if (sum?.summary) { lines.push(sum.summary, ''); }
				lines.push(members.map(m => `- ${link(m)}`).join('\n'), '');
			}
		}

		return lines.join('\n');
	}

	/** Hypergraph as a `mermaid` flowchart: each hyperedge is a rhombus linked to its participants. */
	toMermaid(): string {
		const nodes = this.nodes;
		const hes = this.hyperedges;
		const idByKey = new Map<string, string>();
		const id = (name: unknown): string => {
			const key = this.nodeKeyExtractor({ name } as KnowledgeItem);
			let id = idByKey.get(key);
			if (!id) { id = `n${idByKey.size}`; idByKey.set(key, id); }
			return id;
		};

		const lines: string[] = ['graph LR'];
		nodes.forEach((n, i) => {
			const nid = `n${i}`;
			idByKey.set(this.nodeKeyExtractor(n), nid);
			const label = String(n['name'] ?? `Node ${i}`).replace(/"/g, "'");
			lines.push(`  ${nid}["${label}"]`);
		});
		hes.forEach((he, i) => {
			const hid = `he${i}`;
			const rel = String(he['relation'] ?? 'rel').replace(/"/g, "'");
			lines.push(`  ${hid}{"${rel}"}`);
			for (const p of participantsOf(he)) {
				const nid = id(p);
				lines.push(`  ${hid} --> ${nid}`);
			}
		});
		return lines.join('\n');
	}

	/** Export the hypergraph as an Obsidian vault (Map of filename → Markdown). */
	toObsidianVault(opts?: { title?: string }): Map<string, string> {
		const files = new Map<string, string>();
		const title = opts?.title ?? 'Knowledge Hypergraph';
		const nodes = this.nodes;
		const hes = this.hyperedges;

		const safe = (s: string) => s.replace(/[\\/:*?"<>|\[\]#^]/g, '_').replace(/\s+/g, '_').slice(0, 200) || '_unnamed';
		const yq = (v: string): string => {
			if (!v || /[{}\[\]:#>|@`"'!%&*]/.test(v) || v.trim() !== v) { return `"${v.replace(/"/g, '\\"')}"`; }
			return /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9 _.\/\-()]*$/.test(v) ? v : `"${v}"`;
		};

		// Backlink map: node name → hyperedges it participates in.
		const backlinks = new Map<string, KnowledgeItem[]>();
		for (const he of hes) {
			for (const p of participantsOf(he)) {
				const list = backlinks.get(p);
				if (list) { list.push(he); } else { backlinks.set(p, [he]); }
			}
		}

		for (const n of nodes) {
			const name = String(n['name'] ?? '').trim();
			if (!name) { continue; }
			const file = `${safe(name)}.md`;
			const lines: string[] = [];
			lines.push('---');
			lines.push(`title: ${yq(name)}`);
			if (n['type']) { lines.push(`type: ${yq(String(n['type']))}`); }
			const tags: string[] = [];
			if (n['type']) { tags.push(String(n['type']).toLowerCase().replace(/\s+/g, '-')); }
			if (tags.length) { lines.push(`tags: [${tags.map(t => yq(t)).join(', ')}]`); }
			lines.push('---', '');
			if (n['description']) { lines.push(String(n['description']), ''); }
			for (const [k, v] of Object.entries(n)) {
				if (['name', 'description', 'type', '__proto__'].includes(k)) { continue; }
				if (v === undefined || v === null || v === '') { continue; }
				lines.push(Array.isArray(v) ? `**${k}**: ${(v as unknown[]).map(String).join(', ')}` : `**${k}**: ${String(v)}`);
			}
			const bls = backlinks.get(name);
			if (bls && bls.length) {
				lines.push('', '## Hyperedge Memberships');
				for (const he of bls) {
					const rel = String(he['relation'] ?? 'related');
					const others = participantsOf(he).filter(p => p !== name);
					lines.push(`- **${rel}** with [[${others.join(']], [[')}]]`);
				}
				lines.push('');
			}
			files.set(file, lines.join('\n'));
		}

		const il: string[] = [];
		il.push(`# ${title}`, '');
		il.push(`> ${nodes.length} nodes · ${hes.length} hyperedges`, '');
		il.push('## Nodes', '');
		for (const n of nodes) {
			const name = String(n['name'] ?? '').trim();
			if (!name) { continue; }
			const type = n['type'] ? ` (${String(n['type'])})` : '';
			const desc = n['description'] ? `: ${String(n['description'])}` : '';
			il.push(`- [[${name}]]${type}${desc}`);
		}
		il.push('', '## Hyperedges', '');
		for (const he of hes) {
			const ps = participantsOf(he).map(p => `[[${p}]]`);
			const rel = he['relation'] ? `\`${String(he['relation'])}\`` : 'relates to';
			il.push(`- ${ps.join(' ✕ ')} --${rel}--`);
		}
		il.push('');
		files.set('_index.md', il.join('\n'));
		files.set('_graph.md', ['# Graph View', '', '```mermaid', this.toMermaid(), '```', ''].join('\n'));

		// P3: GraphRAG community report.
		if (this.detected && this.detected.communities.size > 0) {
			const cl: string[] = ['# Communities', ''];
			cl.push(`> ${this.detected.communities.size} communities · modularity Q=${this.detected.modularity.toFixed(3)}`, '');
			for (const [cid, members] of this.detected.communities) {
				const sum = this.summaries.find(s => s.id === cid);
				cl.push(`## ${sum?.title ?? cid} (\`${cid}\`, ${members.length} nodes)`, '');
				if (sum?.summary) { cl.push(sum.summary, ''); }
				for (const m of members) { cl.push(`- [[${m}]]`); }
				cl.push('');
			}
			files.set('_communities.md', cl.join('\n'));
		}

		return files;
	}

	// ── Serialization ─────────────────────────────

	protected _dumpData(): unknown {
		// Graph-pipeline shape: `edges` === native hyperedges.
		return { nodes: this.nodeMemory.dumpData(), edges: this.heMemory.dumpData() };
	}

	protected _loadData(data: unknown): void {
		const d = (data ?? {}) as { nodes?: KnowledgeItem[]; edges?: KnowledgeItem[] };
		this.nodeMemory.clear();
		this.heMemory.clear();
		if (d.nodes?.length) { void this.nodeMemory.add(d.nodes); }
		if (d.edges?.length) { void this.heMemory.add(d.edges); }
		this.clearIndex();
	}

	protected async _dumpIndex(): Promise<unknown | undefined> {
		if (!this.nodeMemory.hasIndex() && !this.heMemory.hasIndex()) { return undefined; }
		return { nodeIndex: this.nodeMemory.dumpIndex(), heIndex: this.heMemory.dumpIndex() };
	}

	protected async _loadIndex(data: unknown): Promise<void> {
		const d = (data ?? {}) as { nodeIndex?: any; heIndex?: any };
		if (d.nodeIndex) { this.nodeMemory.loadIndex(d.nodeIndex); }
		if (d.heIndex) { this.heMemory.loadIndex(d.heIndex); }
	}

	protected override _createEmptyInstance(): BaseAutoType<HypergraphData> {
		return new AutoHypergraph(this.hdeps);
	}
}
