/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — AutoGraph
 *
 *  Faithul port of `hyperextract/types/graph.py::AutoGraph`.
 *  Extracts knowledge graphs (nodes + edges) with:
 *    - one_stage   : nodes+edges in a single LLM call
 *    - two_stage   : nodes first, then edges with node context (more accurate)
 *    - dangling-edge pruning (every edge must connect existing nodes)
 *    - per-type OMem stores (keyed dedup + vector index) for nodes & edges
 *    - semantic search returning (nodes, edges) + RAG chat
 *--------------------------------------------------------------------------------------------*/

import { BaseAutoType } from './base.js';
import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';
import { OMem } from './omem.js';
import { IMerger, MergeStrategy } from './merge.js';
import { batch } from './base.js';
import {
	AutoTypeConfig, EdgeEndpoints, JsonSchema, KeyExtractor, KnowledgeItem,
	LabelExtractor, filterValidItems, graphSchema, listSchema,
} from './types.js';
import {
	CommunityDetectionResult, CommunityEdge, detectCommunities,
} from './communityDetection.js';
import { CommunitySummary, summarizeCommunities } from './communitySummary.js';
import { getPrompt } from './i18nPrompts.js';

export type GraphData = {
	nodes: KnowledgeItem[];
	edges: KnowledgeItem[];
};

export interface AutoGraphDeps {
	llm: IChatModel;
	embedder: IEmbedder;
	nodeSchema: JsonSchema;
	edgeSchema: JsonSchema;
	nodeKeyExtractor: KeyExtractor;
	edgeKeyExtractor: KeyExtractor;
	nodesInEdgeExtractor: EdgeEndpoints;
	config?: AutoTypeConfig;
	extractionMode?: 'one_stage' | 'two_stage';
	nodeStrategy?: MergeStrategy | IMerger<KnowledgeItem>;
	edgeStrategy?: MergeStrategy | IMerger<KnowledgeItem>;
	nodeFieldsForIndex?: string[];
	edgeFieldsForIndex?: string[];
	nodeLabelExtractor?: LabelExtractor;
	edgeLabelExtractor?: LabelExtractor;
	promptForNodeExtraction?: string;
	promptForEdgeExtraction?: string;
	/**
	 * Extra variables injected into every prompt via `render()`. Used by
	 * Temporal/Spatial graph templates to inject `observation_time` /
	 * `observation_location` so the LLM can resolve relative expressions
	 * (e.g. "last year" → absolute year). Mirrors `AutoTemporalGraph` /
	 * `AutoSpatialGraph` prompt injection in Hyper-Extract Python.
	 */
	contextVars?: Record<string, string>;
	/**
	 * P3 — GraphRAG community detection. When true, after ingestion the
	 * manager (or `ensureCommunityEnrichment`) runs Louvain community
	 * detection over the extracted graph and asks the LLM to summarize
	 * each community (hierarchical retrieval). Mirrors GraphRAG's
	 * community reports.
	 */
	communityAware?: boolean;
	/** Louvain resolution γ (higher → more, smaller communities). Default 1.0. */
	communityResolution?: number;
	/** Custom prompt used to summarize each community. */
	communitySummaryPrompt?: string;
}

/** Options for `AutoGraph.toMarkdown`. */
export interface MarkdownExportOptions {
	/** Document title (defaults to "Knowledge Graph"). */
	title?: string;
	/** Emit the mermaid graph block. Default: true. */
	mermaid?: boolean;
	/** Emit Obsidian [[wikilinks]] for node names. Default: true. */
	wikilinks?: boolean;
}

// Default graph/node/edge prompts now live in the i18n catalog (i18nPrompts.ts),
// keyed `default.graph` / `default.node` / `default.edge`.

function render(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

export class AutoGraph extends BaseAutoType<GraphData> {
	private readonly nodeSchema: JsonSchema;
	private readonly edgeSchema: JsonSchema;
	private readonly nodeKeyExtractor: KeyExtractor;
	private readonly edgeKeyExtractor: KeyExtractor;
	private readonly nodesInEdgeExtractor: EdgeEndpoints;
	private readonly mode: 'one_stage' | 'two_stage';
	private readonly nodePrompt: string;
	private readonly edgePrompt: string;
	/** Extra prompt variables (e.g. observation_time for temporal graphs). */
	private readonly ctxVars: Record<string, string>;
	// ── P3: community detection state ─────────
	private readonly _communityAware: boolean;
	private readonly communityResolution: number;
	private readonly communitySummaryPrompt: string;
	private detected?: CommunityDetectionResult;
	private summaries: CommunitySummary[] = [];
	private nodeMemory!: OMem<KnowledgeItem>;
	private edgeMemory!: OMem<KnowledgeItem>;

	constructor(private readonly gdeps: AutoGraphDeps) {
		super({ llm: gdeps.llm, embedder: gdeps.embedder, config: gdeps.config });
		this.nodeSchema = gdeps.nodeSchema;
		this.edgeSchema = gdeps.edgeSchema;
		this.nodeKeyExtractor = gdeps.nodeKeyExtractor;
		this.edgeKeyExtractor = gdeps.edgeKeyExtractor;
		this.nodesInEdgeExtractor = gdeps.nodesInEdgeExtractor;
		this.mode = gdeps.extractionMode ?? 'one_stage';
		this.nodePrompt = gdeps.promptForNodeExtraction ?? getPrompt('default.node');
		this.edgePrompt = gdeps.promptForEdgeExtraction ?? getPrompt('default.edge');
		this.ctxVars = gdeps.contextVars ?? {};
		this._communityAware = gdeps.communityAware ?? false;
		this.communityResolution = gdeps.communityResolution ?? 1.0;
		this.communitySummaryPrompt = gdeps.communitySummaryPrompt ?? '';

	this.nodeMemory = new OMem<KnowledgeItem>({
			keyExtractor: this.nodeKeyExtractor,
			itemSchema: this.nodeSchema,
			llm: gdeps.llm,
			embedder: gdeps.embedder,
			strategy: gdeps.nodeStrategy ?? MergeStrategy.BALANCED,
			fieldsForIndex: gdeps.nodeFieldsForIndex,
		});
		this.edgeMemory = new OMem<KnowledgeItem>({
			keyExtractor: this.edgeKeyExtractor,
			itemSchema: this.edgeSchema,
			llm: gdeps.llm,
			embedder: gdeps.embedder,
			strategy: gdeps.edgeStrategy ?? MergeStrategy.BALANCED,
			fieldsForIndex: gdeps.edgeFieldsForIndex,
		});
		this._initDataState();
		this._initIndexState();
	}

	protected _defaultPrompt(): string { return getPrompt('default.graph'); }

	get data(): GraphData {
		return { nodes: this.nodeMemory.all, edges: this.edgeMemory.all };
	}

	get nodes(): KnowledgeItem[] { return this.nodeMemory.all; }
	get edges(): KnowledgeItem[] { return this.edgeMemory.all; }

	empty(): boolean { return this.nodeMemory.empty(); }

	// ── P3: GraphRAG community detection ─────────────────────────────

	get communityAware(): boolean { return this._communityAware; }
	get communitySummaries(): CommunitySummary[] { return this.summaries; }
	get detectedCommunities(): CommunityDetectionResult | undefined { return this.detected; }

	/**
	 * Run Louvain community detection over the CURRENT graph (nodes + edges).
	 * Assigns each node a `community` field (community id) and caches the
	 * result for export / summarization. Pure (no LLM).
	 */
	async detectCommunities(): Promise<CommunityDetectionResult> {
		const nodeIds = this.nodes.map(n => this.nodeKeyExtractor(n));
		const edges: CommunityEdge[] = this.edges.map(e => {
			const [s, t] = this.nodesInEdgeExtractor(e);
			return { source: s, target: t };
		});
		const result = detectCommunities(nodeIds, edges, { resolution: this.communityResolution });
		const byKey = new Map<string, KnowledgeItem>();
		for (const n of this.nodes) { byKey.set(this.nodeKeyExtractor(n), n); }
		for (const [key, cid] of result.nodeCommunity) {
			const node = byKey.get(key);
			if (node) { node['community'] = cid; }
		}
		this.detected = result;
		// Summaries reference the previous partition; invalidate.
		this.summaries = [];
		return result;
	}

	/**
	 * Ensure the graph is community-enriched: detect (if needed) and LLM-summarize
	 * each community (once). No-ops unless `communityAware` was set at build.
	 * Safe to call repeatedly after incremental `feedText`.
	 */
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
					return this.edges
						.filter(e => {
							const [s, t] = this.nodesInEdgeExtractor(e);
							return map.get(s) === cid && map.get(t) === cid;
						})
						.map(e => ({
							source: String(e['source'] ?? ''),
							target: String(e['target'] ?? ''),
							relation: e['relation'] ? String(e['relation']) : undefined,
						}));
				},
				prompt: this.communitySummaryPrompt || undefined,
			});
		}
	}

	protected _initDataState(): void {
		this.nodeMemory?.clear();
		this.edgeMemory?.clear();
	}

	protected async _setDataState(data: GraphData): Promise<void> {
		this.nodeMemory.clear();
		this.edgeMemory.clear();
		if (data.nodes?.length) { await this.nodeMemory.add(data.nodes); }
		if (data.edges?.length) { await this.edgeMemory.add(data.edges); }
		this.clearIndex();
	}

	protected async _updateDataState(data: GraphData): Promise<void> {
		if (this.empty()) {
			await this._setDataState(data);
			return;
		}
		if (data.nodes?.length) { await this.nodeMemory.add(data.nodes); }
		if (data.edges?.length) { await this.edgeMemory.add(data.edges); }
		this.clearIndex();
	}

	protected _initIndexState(): void {
		this.nodeMemory?.clearIndex();
		this.edgeMemory?.clearIndex();
	}

	protected async _extractOne(text: string): Promise<GraphData | null> {
		return this._extractGraphOnce(text);
	}

	// ── Extraction pipeline (overrides base generic) ─────────────────────────────

	protected override async _extractData(text: string): Promise<GraphData> {
		const g = this.mode === 'two_stage'
			? await this._extractTwoStage(text)
			: await this._extractOneStage(text);
		return this._pruneDangling(g);
	}

	private async _extractOneStage(text: string): Promise<GraphData> {
		if (text.length <= this.chunkSize) {
			const g = await this._extractGraphOnce(text);
			return g ?? { nodes: [], edges: [] };
		}
		const chunks = this.splitter.withOverlap(this.splitter.splitText(text));
		const list = await batch(chunks, this.maxWorkers, (c) => this._extractGraphOnce(c));
		const filtered = list.filter((x): x is GraphData => x !== null);
		return this.mergeBatchData(filtered);
	}

	private async _extractTwoStage(text: string): Promise<GraphData> {
		const chunks = text.length <= this.chunkSize
			? [text]
			: this.splitter.withOverlap(this.splitter.splitText(text));

		const nodeLists = await batch(chunks, this.maxWorkers, (c) => this._extractNodeList(c));
		const edgeLists = await batch(chunks, this.maxWorkers, (c, i) =>
			this._extractEdgeList(c, nodeLists[i]?.items ?? []));

		const partial: [KnowledgeItem[][], KnowledgeItem[][]] = [
			nodeLists.map(n => n.items),
			edgeLists.map(e => e.items),
		];
		return this.mergeBatchData(partial);
	}

	private async _extractGraphOnce(text: string): Promise<GraphData | null> {
		const rendered = render(this.prompt, { source_text: text, ...this.ctxVars });
		const schema = graphSchema(this.nodeSchema, this.edgeSchema, 'Extracted knowledge graph');
		try {
			const g = await this.llm.extract<GraphData>({ prompt: rendered, schema });
			// Drop malformed records (missing required fields) before they enter OMem.
			return {
				nodes: filterValidItems(g?.nodes, this.nodeSchema),
				edges: filterValidItems(g?.edges, this.edgeSchema),
			};
		} catch (e) {
			if (this.verbose) { console.warn('[AutoGraph] one-stage extract failed:', e); }
			return null;
		}
	}

	private async _extractNodeList(text: string): Promise<{ items: KnowledgeItem[] }> {
		const rendered = render(this.nodePrompt, { source_text: text, ...this.ctxVars });
		try {
			const r = await this.llm.extract<{ items: KnowledgeItem[] }>({
				prompt: rendered, schema: listSchema(this.nodeSchema, 'Extracted nodes'),
			});
			return { items: filterValidItems(r?.items, this.nodeSchema) };
		} catch {
			return { items: [] };
		}
	}

	private async _extractEdgeList(text: string, nodes: KnowledgeItem[]): Promise<{ items: KnowledgeItem[] }> {
		const known = nodes.length
			? nodes.map(n => this.nodeKeyExtractor(n)).join('\n- ')
			: 'No specific entities identified in this chunk.';
		const rendered = render(this.edgePrompt, { source_text: text, known_nodes: known, ...this.ctxVars });
		try {
			const r = await this.llm.extract<{ items: KnowledgeItem[] }>({
				prompt: rendered, schema: listSchema(this.edgeSchema, 'Extracted edges'),
			});
			return { items: filterValidItems(r?.items, this.edgeSchema) };
		} catch {
			return { items: [] };
		}
	}

	private _pruneDangling(graph: GraphData): GraphData {
		const validKeys = new Set<string>(graph.nodes.map(n => this.nodeKeyExtractor(n)));
		const memoryKeys = this.nodeMemory.keys();
		const refined = graph.edges.filter(edge => {
			const [src, dst] = this.nodesInEdgeExtractor(edge);
			const ok = (k: string) => validKeys.has(k) || memoryKeys.has(k);
			return ok(src) && ok(dst);
		});
		if (this.verbose && refined.length !== graph.edges.length) {
			console.log(`[AutoGraph] pruned ${graph.edges.length - refined.length} dangling edges`);
		}
		return { nodes: graph.nodes, edges: refined };
	}

	// ── Merge ─────────────────────────────

	mergeBatchData(
		data: GraphData[] | [KnowledgeItem[][], KnowledgeItem[][]],
	): GraphData {
		let allNodes: KnowledgeItem[];
		let allEdges: KnowledgeItem[];
		if (Array.isArray(data) && !this._isGraphData(data[0])) {
			const [nodeLists, edgeLists] = data as [KnowledgeItem[][], KnowledgeItem[][]];
			allNodes = nodeLists.flat();
			allEdges = edgeLists.flat();
		} else {
			const list = data as GraphData[];
			allNodes = list.flatMap(g => g.nodes ?? []);
			allEdges = list.flatMap(g => g.edges ?? []);
		}
		// Deduplication is performed by OMem.add during _set/_update; here we only
		// collapse into a single GraphData for the prune/return path.
		return { nodes: allNodes, edges: allEdges };
	}

	private _isGraphData(x: unknown): x is GraphData {
		return !!x && typeof x === 'object' && 'nodes' in (x as object) && 'edges' in (x as object);
	}

	// ── Indexing / search / chat ─────────────────────────────

	async buildIndex(): Promise<void> {
		if (this.empty()) { return; }
		await this.nodeMemory.buildIndex();
		await this.edgeMemory.buildIndex();
	}

	async searchNodes(query: string, topK = 3): Promise<KnowledgeItem[]> {
		if (!this.nodeMemory.hasIndex()) {
			throw new Error('Node index not built. Call buildIndex() first.');
		}
		return this.nodeMemory.search(query, topK);
	}

	async searchEdges(query: string, topK = 3): Promise<KnowledgeItem[]> {
		if (!this.edgeMemory.hasIndex()) {
			throw new Error('Edge index not built. Call buildIndex() first.');
		}
		return this.edgeMemory.search(query, topK);
	}

	/** Graph-specific search returning typed { nodes, edges }. */
	async searchGraph(
		query: string,
		topKNodes = 3,
		topKEdges = 3,
	): Promise<{ nodes: KnowledgeItem[]; edges: KnowledgeItem[] }> {
		const nodes = topKNodes > 0 ? await this.searchNodes(query, topKNodes) : [];
		const edges = topKEdges > 0 ? await this.searchEdges(query, topKEdges) : [];
		return { nodes, edges };
	}

	// Base-compatible overrides ——————————————————————————————————————

	override async search(query: string, topK = 3): Promise<unknown[]> {
		return this.searchNodes(query, topK);
	}

	override async chat(query: string, topK = 3): Promise<{ text: string; retrieved: unknown[] }> {
		const { nodes, edges } = await this.searchGraph(query, topK, topK);
		const parts: string[] = [];
		if (nodes.length) {
			parts.push('=== Relevant Nodes ===');
			for (const n of nodes) { parts.push(JSON.stringify(n, null, 2)); }
		}
		if (edges.length) {
			parts.push('=== Relevant Edges ===');
			for (const e of edges) { parts.push(JSON.stringify(e, null, 2)); }
		}
		const context = parts.length
			? parts.join('\n\n')
			: 'No relevant information found in the knowledge graph.';
		const text = await this.llm.complete(
			'Based on the following Graph Knowledge, answer the user\'s question.',
			`Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
		);
		return { text, retrieved: [...nodes, ...edges] };
	}

	/** Full graph chat with typed return (for callers that need node/edge separation). */
	async chatGraph(query: string, topKNodes = 3, topKEdges = 3): Promise<{ text: string; retrieved: { nodes: KnowledgeItem[]; edges: KnowledgeItem[] } }> {
		const { nodes, edges } = await this.searchGraph(query, topKNodes, topKEdges);
		const parts: string[] = [];
		if (nodes.length) {
			parts.push('=== Relevant Nodes ===');
			for (const n of nodes) { parts.push(JSON.stringify(n, null, 2)); }
		}
		if (edges.length) {
			parts.push('=== Relevant Edges ===');
			for (const e of edges) { parts.push(JSON.stringify(e, null, 2)); }
		}
		const context = parts.length
			? parts.join('\n\n')
			: 'No relevant information found in the knowledge graph.';
		const text = await this.llm.complete(
			'Based on the following Graph Knowledge, answer the user\'s question.',
			`Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
		);
		return { text, retrieved: { nodes, edges } };
	}

	// ── Export (Obsidian / Markdown / Mermaid) ─────────────────────────────
	//
	// Mirrors Hyper-Extract's `export_obsidian`: turn the extracted
	// knowledge graph into a portable Markdown document. Node names become
	// Obsidian [[wikilinks]] so the export cross-references cleanly, and a
	// `mermaid` block renders the graph for any MD viewer with Mermaid support.

	/** Graph data as portable Markdown (Obsidian-style). */
	override toMarkdown(opts: MarkdownExportOptions = {}): string {
		const title = opts.title ?? 'Knowledge Graph';
		const useMermaid = opts.mermaid ?? true;
		const useWiki = opts.wikilinks ?? true;
		const nodes = this.nodes;
		const edges = this.edges;

		const link = (name: unknown): string => {
			const s = String(name ?? '').trim();
			return useWiki && s ? `[[${s}]]` : s;
		};

		const lines: string[] = [];
		lines.push(`# ${title}`, '');
		lines.push(`> 由 Hyper-Extract (TS) 知识引擎自动导出 · 节点 ${nodes.length} · 关系 ${edges.length}`, '');

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

		lines.push('## 关系 (Edges)', '');
		if (edges.length === 0) {
			lines.push('_（暂无关系）_', '');
		} else {
			for (const e of edges) {
				const src = link(e['source']);
				const tgt = link(e['target']);
				const rel = e['relation'] ? `\`${String(e['relation'])}\`` : 'relates to';
				const desc = e['description'] ? ` — ${String(e['description'])}` : '';
				lines.push(`- ${src} --${rel}--> ${tgt}${desc}`);
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
				const title = sum?.title ?? cid;
				lines.push(`### ${title} (\`${cid}\`, ${members.length} 节点)`, '');
				if (sum?.summary) { lines.push(sum.summary, ''); }
				lines.push(members.map(m => `- ${link(m)}`).join('\n'), '');
			}
		}

		return lines.join('\n');
	}

	/** Graph as a `mermaid` flowchart block (no fences). */
	toMermaid(): string {
		const nodes = this.nodes;
		const edges = this.edges;

		// Map node key (lowercased name) -> stable mermaid id `n0`, `n1` ...
		const idByKey = new Map<string, string>();
		const id = (name: unknown): string => {
			const key = this.nodeKeyExtractor({ name } as KnowledgeItem);
			let id = idByKey.get(key);
			if (!id) {
				id = `n${idByKey.size}`;
				idByKey.set(key, id);
			}
			return id;
		};

		const lines: string[] = ['graph LR'];
		nodes.forEach((n, i) => {
			const nid = `n${i}`;
			idByKey.set(this.nodeKeyExtractor(n), nid);
			const label = String(n['name'] ?? `Node ${i}`).replace(/"/g, "'");
			const type = n['type'] ? `:::${String(n['type']).replace(/\W+/g, '')}` : '';
			lines.push(`  ${nid}["${label}"]${type}`);
		});
		for (const e of edges) {
			const s = id(e['source']);
			const t = id(e['target']);
			const rel = e['relation'] ? String(e['relation']).replace(/"/g, "'") : 'rel';
			lines.push(`  ${s} -->|${rel}| ${t}`);
		}
		return lines.join('\n');
	}

	/**
	 * Export the knowledge graph as an Obsidian vault: a Map of
	 * filename → Markdown content.
	 *
	 * Each node becomes its own `.md` note with:
	 *   - YAML front-matter (`title` / `type` / `tags`)
	 *   - node attributes as body text
	 *   - ``[[wikilink]]`` backlinks from incident edges
	 *
	 * An `_index.md` index page lists all nodes and edges, and a
	 * `_graph.md` Mermaid diagram ties everything together.
	 *
	 * Mirrors `hyperextract/utils/obsidian.py::export_to_obsidian`.
	 */
	toObsidianVault(opts?: { title?: string }): Map<string, string> {
		const files = new Map<string, string>();
		const title = opts?.title ?? 'Knowledge Graph';
		const nodes = this.nodes;
		const edges = this.edges;

		// Sanitize a node name into a safe filename.
		const safe = (s: string) => s.replace(/[\\/:*?"<>|\[\]#^]/g, '_').replace(/\s+/g, '_').slice(0, 200) || '_unnamed';

		// Quote a YAML scalar if needed.
		const yq = (v: string): string => {
			if (!v || /[{}\[\]:#>|@`"'!%&*]/.test(v) || v.trim() !== v) { return `"${v.replace(/"/g, '\\"')}"`; }
			return /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9 _.\/\-()]*$/.test(v) ? v : `"${v}"`;
		};

		// Build backlink map: node name → list of edges mentioning it.
		const backlinks = new Map<string, KnowledgeItem[]>();
		for (const e of edges) {
			for (const k of ['source', 'target'] as const) {
				const name = String(e[k] ?? '').trim();
				if (!name) { continue; }
				const list = backlinks.get(name);
				if (list) { list.push(e); } else { backlinks.set(name, [e]); }
			}
		}

		// ── One note per node ─────────────────────────────────
		for (const n of nodes) {
			const name = String(n['name'] ?? '').trim();
			if (!name) { continue; }
			const file = `${safe(name)}.md`;
			const lines: string[] = [];
			// YAML front-matter
			lines.push('---');
			lines.push(`title: ${yq(name)}`);
			if (n['type']) { lines.push(`type: ${yq(String(n['type']))}`); }
			const tags: string[] = [];
			if (n['type']) { tags.push(String(n['type']).toLowerCase().replace(/\s+/g, '-')); }
			if (tags.length) { lines.push(`tags: [${tags.map(t => yq(t)).join(', ')}]`); }
			lines.push('---', '');
			// Body
			if (n['description']) { lines.push(String(n['description']), ''); }
			// Other fields
			for (const [k, v] of Object.entries(n)) {
				if (['name', 'description', 'type', '__proto__'].includes(k)) { continue; }
				if (v === undefined || v === null || v === '') { continue; }
				if (Array.isArray(v)) {
					lines.push(`**${k}**: ${(v as unknown[]).map(String).join(', ')}`);
				} else {
					lines.push(`**${k}**: ${String(v)}`);
				}
			}
			// Backlinks
			const bls = backlinks.get(name);
			if (bls && bls.length) {
				lines.push('', '## Relationships');
				for (const e of bls) {
					const src = String(e['source'] ?? '').trim();
					const tgt = String(e['target'] ?? '').trim();
					const rel = String(e['relation'] ?? 'related');
					const other = src === name ? tgt : src;
					if (!other) { continue; }
					lines.push(`- **${rel}** → [[${other}]]`);
				}
				lines.push('');
			}
			files.set(file, lines.join('\n'));
		}

		// ── Index page ───────────────────────────────────────
		const il: string[] = [];
		il.push(`# ${title}`, '');
		il.push(`> ${nodes.length} nodes · ${edges.length} edges`, '');
		il.push('## Nodes', '');
		for (const n of nodes) {
			const name = String(n['name'] ?? '').trim();
			if (!name) { continue; }
			const type = n['type'] ? ` (${String(n['type'])})` : '';
			const desc = n['description'] ? `: ${String(n['description'])}` : '';
			il.push(`- [[${name}]]${type}${desc}`);
		}
		il.push('', '## Edges', '');
		for (const e of edges) {
			const src = String(e['source'] ?? '').trim();
			const tgt = String(e['target'] ?? '').trim();
			if (!src || !tgt) { continue; }
			const rel = e['relation'] ? `\`${String(e['relation'])}\`` : 'relates to';
			il.push(`- [[${src}]] --${rel}--> [[${tgt}]]`);
		}
		il.push('');
		files.set('_index.md', il.join('\n'));

		// ── Mermaid diagram ──────────────────────────────────
		files.set('_graph.md', ['# Graph View', '', '```mermaid', this.toMermaid(), '```', ''].join('\n'));

		// P3: GraphRAG community report.
		if (this.detected && this.detected.communities.size > 0) {
			const cl: string[] = ['# Communities', ''];
			cl.push(`> ${this.detected.communities.size} communities · modularity Q=${this.detected.modularity.toFixed(3)}`, '');
			for (const [cid, members] of this.detected.communities) {
				const sum = this.summaries.find(s => s.id === cid);
				const title = sum?.title ?? cid;
				cl.push(`## ${title} (\`${cid}\`, ${members.length} nodes)`, '');
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
		return { nodes: this.nodeMemory.dumpData(), edges: this.edgeMemory.dumpData() };
	}

	protected _loadData(data: unknown): void {
		const d = (data ?? {}) as GraphData;
		this.nodeMemory.clear();
		this.edgeMemory.clear();
		if (d.nodes?.length) { void this.nodeMemory.add(d.nodes); }
		if (d.edges?.length) { void this.edgeMemory.add(d.edges); }
		this.clearIndex();
	}

	protected async _dumpIndex(): Promise<unknown | undefined> {
		if (!this.nodeMemory.hasIndex() && !this.edgeMemory.hasIndex()) { return undefined; }
		return {
			nodeIndex: this.nodeMemory.dumpIndex(),
			edgeIndex: this.edgeMemory.dumpIndex(),
		};
	}

	protected async _loadIndex(data: unknown): Promise<void> {
		const d = (data ?? {}) as { nodeIndex?: any; edgeIndex?: any };
		if (d.nodeIndex) { this.nodeMemory.loadIndex(d.nodeIndex); }
		if (d.edgeIndex) { this.edgeMemory.loadIndex(d.edgeIndex); }
	}

	protected override _createEmptyInstance(): BaseAutoType<GraphData> {
		return new AutoGraph(this.gdeps);
	}
}
