/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — Knowledge Manager ("解析" orchestration)
 *
 *  The top-level orchestrator that sits above the AutoTypes and below the
 *  VS Code glue. Responsibilities (port of `hyperextract`'s `Manager` /
 *  the `he parse` + `he chat` commands):
 *    - resolve a template → build a configured AutoType
 *    - parse documents (feed text → extract → dedup-merge → build index)
 *    - register/search/chat/delete a named knowledge base ("session")
 *    - serialize/deserialize a session through an injected storage adapter
 *
 *  The engine stays dependency-free: persistence is delegated to a
 *  `KBStorageAdapter` supplied by the VS Code glue (which writes to
 *  `.saros/kb/<id>/`). No `vs/` imports here.
 *--------------------------------------------------------------------------------------------*/

import { BaseAutoType, SerializedKB } from './base.js';
import { AutoGraph } from './autoGraph.js';
import { IChatModel } from './llm.js';
import { IEmbedder } from './embedder.js';
import { getTemplate, listTemplates, KnowledgeTemplate } from './templates.js';
import { getMethod, listMethods } from './methodRegistry.js';
import { AutoTypeConfig } from './types.js';
import { HybridSearchHit, IGraphSignal, rerankWithGraphSignals, clampToTokenBudget } from './hybridSearch.js';

export interface KnowledgeSessionMeta {
	readonly id: string;
	readonly templateId: string;
	readonly title: string;
	readonly kind: 'graph' | 'list';
	readonly itemCount: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface CreateOptions {
	title?: string;
	/** Override the template's default AutoType config. */
	config?: AutoTypeConfig;
	/** Provide an explicit id (else a uuid-like id is generated). */
	id?: string;
	/**
	 * Use a named extraction METHOD instead of (or on top of) the template's
	 * default AutoType. A method is a preset that builds a fully configured
	 * AutoType (schema + prompts + merge strategy); when set, the method's
	 * `build` overrides the template's default build. Mirrors selecting a
	 * `method` in `hyperextract` `methods/registry.py`.
	 */
	method?: string;
}

export interface SearchResult {
	readonly type: 'graph' | 'list';
	readonly nodes?: unknown[];
	readonly edges?: unknown[];
	readonly items?: unknown[];
	/** P0-2：结果因 token 预算被截断 */
	readonly truncated?: boolean;
}

export interface SearchOptions {
	/**
	 * P0-2 token 预算封顶：结果序列化后估算 token 超过该值时截断
	 * （保序、至少保 1 条）。undefined = 不封顶。
	 */
	maxTokens?: number;
}

export interface ChatResult {
	readonly text: string;
	readonly retrieved: SearchResult;
}

/**
 * Storage contract injected by the VS Code glue. The engine never touches
 * the filesystem directly.
 */
export interface KBStorageAdapter {
	/** Load a previously serialized KB, or undefined if absent. */
	read(id: string): Promise<SerializedKB | undefined>;
	/** Persist a serialized KB. */
	write(id: string, payload: SerializedKB): Promise<void>;
	/** Delete a persisted KB. */
	remove(id: string): Promise<void>;
	/**
	 * Enumerate persisted KBs (optional). If the adapter can list stored
	 * payloads it should return their metadata; otherwise return [].
	 */
	list?(): Promise<KnowledgeSessionMeta[]>;
}

let _seq = 0;
function genId(): string {
	_seq += 1;
	const rand = Math.random().toString(36).slice(2, 8);
	const time = Date.now().toString(36);
	return `kb-${time}-${rand}${_seq.toString(36)}`;
}

export class KnowledgeSession {
	readonly id: string;
	templateId: string;
	title: string;
	readonly kind: 'graph' | 'list';
	readonly autoType: BaseAutoType<any>;
	createdAt: string;
	updatedAt: string;

	constructor(opts: {
		id: string;
		templateId: string;
		title: string;
		kind: 'graph' | 'list';
		autoType: BaseAutoType<any>;
		createdAt?: string;
		updatedAt?: string;
	}) {
		this.id = opts.id;
		this.templateId = opts.templateId;
		this.title = opts.title;
		this.kind = opts.kind;
		this.autoType = opts.autoType;
		this.createdAt = opts.createdAt ?? new Date().toISOString();
		this.updatedAt = opts.updatedAt ?? this.createdAt;
	}

	get meta(): KnowledgeSessionMeta {
		return {
			id: this.id,
			templateId: this.templateId,
			title: this.title,
			kind: this.kind,
			itemCount: this._itemCount(),
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
		};
	}

	private _itemCount(): number {
		const d = this.autoType.data;
		if (this.kind === 'graph') { return (d?.nodes?.length ?? 0) + (d?.edges?.length ?? 0); }
		return (d?.items?.length ?? 0);
	}

	touch(): void { this.updatedAt = new Date().toISOString(); }
}

export interface ManagerDeps {
	llm: IChatModel;
	embedder: IEmbedder;
	storage?: KBStorageAdapter;
	verbose?: boolean;
}

export class KnowledgeManager {
	private readonly llm: IChatModel;
	private readonly embedder: IEmbedder;
	private readonly storage?: KBStorageAdapter;
	private readonly verbose: boolean;
	private readonly sessions = new Map<string, KnowledgeSession>();

	constructor(deps: ManagerDeps) {
		this.llm = deps.llm;
		this.embedder = deps.embedder;
		this.storage = deps.storage;
		this.verbose = deps.verbose ?? false;
	}

	// ── Template discovery ─────────────────────────────

	static availableTemplates() {
		return listTemplates();
	}

	// ── Session lifecycle ─────────────────────────────

	/** Create a new (empty) knowledge base from a template (or a named method). */
	create(templateId: string, opts: CreateOptions = {}): KnowledgeSession {
		const id = opts.id ?? genId();

		// A named extraction METHOD overrides the template's default AutoType build.
		if (opts.method) {
			const m = getMethod(opts.method);
			if (!m) {
				throw new Error(`Unknown extraction method: "${opts.method}". ` +
					`Available: ${listMethods().map(x => x.name).join(', ')}`);
			}
			const autoType = m.build(this.llm, this.embedder);
			const session = new KnowledgeSession({
				id,
				templateId: m.name,
				title: opts.title ?? m.description,
				kind: m.kind,
				autoType,
			});
			this.sessions.set(id, session);
			return session;
		}

		const tpl = getTemplate(templateId);
		if (!tpl) {
			throw new Error(`Unknown knowledge template: "${templateId}". ` +
				`Available: ${KnowledgeManager.availableTemplates().map(t => t.id).join(', ')}`);
		}
		const autoType = tpl.build(this.llm, this.embedder, opts.config);
		const session = new KnowledgeSession({
			id,
			templateId,
			title: opts.title ?? tpl.label,
			kind: tpl.kind,
			autoType,
		});
		this.sessions.set(id, session);
		return session;
	}

	get(id: string): KnowledgeSession | undefined { return this.sessions.get(id); }

	list(): KnowledgeSessionMeta[] {
		return [...this.sessions.values()].map(s => s.meta);
	}

	/** Enumerate persisted KBs via the storage adapter (if it supports listing). */
	async listStored(): Promise<KnowledgeSessionMeta[]> {
		if (this.storage?.list) { return this.storage.list(); }
		return [];
	}

	// ── 解析 (parse / ingest) ─────────────────────────────

	/**
	 * Parse one document into a session: extract → dedup-merge → build index.
	 * Mirrors `he parse`. Multiple calls (on the same session) accumulate.
	 */
	async parseText(session: KnowledgeSession, text: string): Promise<KnowledgeSession> {
		if (this.verbose) { console.log(`[KnowledgeManager] parsing into "${session.id}" (${text.length} chars)`); }
		await session.autoType.feedText(text);
		session.touch();
		await this.buildIndex(session);
		// P3: community-aware methods (graph_rag / cog_rag / hypergraph_rag)
		// run Louvain detection + LLM community summaries after ingestion.
		const enriched = session.autoType as unknown as {
			communityAware?: boolean;
			ensureCommunityEnrichment?: (llm: IChatModel) => Promise<void>;
		};
		if (enriched.communityAware && enriched.ensureCommunityEnrichment) {
			try {
				await enriched.ensureCommunityEnrichment(this.llm);
				session.touch();
			} catch (e) {
				if (this.verbose) { console.warn('[KnowledgeManager] community enrichment failed:', e); }
			}
		}
		return session;
	}

	/** Parse several documents in sequence (e.g. a folder of markdown files). */
	async parseMany(session: KnowledgeSession, texts: string[]): Promise<KnowledgeSession> {
		for (const t of texts) {
			if (t && t.trim()) { await this.parseText(session, t); }
		}
		return session;
	}

	async buildIndex(session: KnowledgeSession): Promise<void> {
		await session.autoType.buildIndex();
		session.touch();
	}

	/**
	 * Merge two knowledge bases of the same kind into a new one. All items
	 * (nodes + edges for graphs; items for lists/sets) from both sessions
	 * are combined and federated through the OMem dedup pipeline so
	 * duplicates get merged according to the session's strategy.
	 *
	 * Mirrors `ka3 = ka1 + ka2` (`__add__`) in Hyper-Extract Python.
	 */
	async merge(idA: string, idB: string, opts?: { title?: string }): Promise<KnowledgeSession> {
		const sA = await this.get(idA) ?? (this.storage ? await this.load(idA) : undefined);
		const sB = await this.get(idB) ?? (this.storage ? await this.load(idB) : undefined);
		if (!sA || !sB) { throw new Error('Both sessions must exist (loaded or in memory).'); }
		if (sA.kind !== sB.kind) {
			throw new Error(`Cannot merge different kinds: ${sA.kind} vs ${sB.kind}`);
		}

		const pA = await sA.autoType.serialize();
		const pB = await sB.autoType.serialize();
		const mergedData: Record<string, unknown> = sA.kind === 'graph'
			? {
				nodes: [...((pA.data as any).nodes ?? []), ...((pB.data as any).nodes ?? [])],
				edges: [...((pA.data as any).edges ?? []), ...((pB.data as any).edges ?? [])],
			}
			: {
				items: [...(((pA.data as any).items ?? [])), ...(((pB.data as any).items ?? []))],
			};

		const sC = this.create(sA.templateId, {
			title: opts?.title ?? `${sA.title} + ${sB.title}`,
		});
		await sC.autoType.deserialize({ data: mergedData, metadata: {} });
		await this.buildIndex(sC);
		if (this.storage) { await this.persist(sC); }
		return sC;
	}

	// ── Retrieval ─────────────────────────────

	async search(session: KnowledgeSession, query: string, topK = 5, opts?: SearchOptions): Promise<SearchResult> {
		if (session.kind === 'graph') {
			// Graph sessions retrieve BOTH nodes and edges; AutoGraph.searchGraph
			// returns them separately so edges are no longer lost in RAG context.
			const g = session.autoType as AutoGraph;
			const { nodes, edges } = await g.searchGraph(query, topK, topK);
			// P0-2：图信号重排（度数加成 + 社区多样化，对齐 llm_wiki 图信号检索纪律）
			const rerankedNodes = this._rerankGraphNodes(g, nodes as unknown[]);
			// P0-2：token 预算封顶（nodes 优先占预算，剩余给 edges）
			if (opts?.maxTokens && opts.maxTokens > 0) {
				const textOf = (x: unknown) => JSON.stringify(x);
				const nodeClamp = clampToTokenBudget(rerankedNodes, textOf, opts.maxTokens);
				const edgeBudget = opts.maxTokens - nodeClamp.estTokens;
				const edgeClamp = edgeBudget > 0
					? clampToTokenBudget(edges as unknown[], textOf, edgeBudget)
					: { items: [] as unknown[], truncated: (edges as unknown[]).length > 0, estTokens: 0 };
				return { type: 'graph', nodes: nodeClamp.items, edges: edgeClamp.items, truncated: nodeClamp.truncated || edgeClamp.truncated };
			}
			return { type: 'graph', nodes: rerankedNodes, edges };
		}
		const items = await session.autoType.search(query, topK);
		if (opts?.maxTokens && opts.maxTokens > 0) {
			const clamp = clampToTokenBudget(items as unknown[], x => JSON.stringify(x), opts.maxTokens);
			return { type: 'list', items: clamp.items, truncated: clamp.truncated };
		}
		return { type: 'list', items };
	}

	/**
	 * P0-2：用图结构信号（度数 + Louvain 社区）对检索到的节点重排。
	 * 度数从当前图 edges 计算；社区 id 读节点的 `community` 字段
	 * （由 `detectCommunities()` 写入，未跑社区检测时为 undefined）。
	 */
	private _rerankGraphNodes(g: AutoGraph, nodes: unknown[]): unknown[] {
		if (nodes.length <= 1) { return nodes; }
		try {
			const data = (g as unknown as { data?: { edges?: Record<string, unknown>[] } }).data;
			const degree = new Map<string, number>();
			for (const e of data?.edges ?? []) {
				for (const k of ['source', 'target'] as const) {
					const name = String(e[k] ?? '').trim();
					if (name) { degree.set(name, (degree.get(name) ?? 0) + 1); }
				}
			}
			// 无图信号可用（如空图）时保持原序
			if (degree.size === 0) { return nodes; }
			const hits: HybridSearchHit<unknown>[] = nodes.map((n, i) => ({
				item: n,
				id: String((n as Record<string, unknown>)['name'] ?? i),
				vectorScore: -1,
				ftsScore: -1,
				rrfScore: 1 / (60 + i + 1), // 用原始排名构造 RRF 基分
			}));
			const getSignal = (h: HybridSearchHit<unknown>): IGraphSignal => {
				const rec = h.item as Record<string, unknown>;
				const name = String(rec['name'] ?? '');
				const community = rec['community'];
				return {
					degree: degree.get(name) ?? 0,
					communityId: typeof community === 'number' || typeof community === 'string' ? community : undefined,
				};
			};
			return rerankWithGraphSignals(hits, getSignal).map(h => h.item);
		} catch {
			return nodes; // 重排失败按原序兜底
		}
	}

	async chat(session: KnowledgeSession, query: string, topK = 5): Promise<ChatResult> {
		if (session.kind === 'graph') {
			// Use AutoGraph.chatGraph so retrieved context includes edges too.
			const g = session.autoType as AutoGraph;
			const r = await g.chatGraph(query, topK, topK);
			return {
				text: r.text,
				retrieved: { type: 'graph', nodes: r.retrieved.nodes, edges: r.retrieved.edges },
			};
		}
		const r = await session.autoType.chat(query, topK);
		return { text: r.text, retrieved: { type: 'list', items: r.retrieved as unknown[] } };
	}

	/** Export a built knowledge base as portable Markdown (Obsidian-style). */
	exportMarkdown(session: KnowledgeSession, opts?: { title?: string; mermaid?: boolean; wikilinks?: boolean }): string {
		return session.autoType.toMarkdown(opts);
	}

	// ── Persistence ─────────────────────────────

	async persist(session: KnowledgeSession): Promise<void> {
		if (!this.storage) { throw new Error('KnowledgeManager has no storage adapter configured.'); }
		const payload = await session.autoType.serialize();
		payload.metadata = {
			...(payload.metadata as Record<string, unknown> ?? {}),
			id: session.id,
			templateId: session.templateId,
			title: session.title,
			kind: session.kind,
		};
		await this.storage.write(session.id, payload);
		if (this.verbose) { console.log(`[KnowledgeManager] persisted "${session.id}"`); }
	}

	async load(id: string): Promise<KnowledgeSession> {
		if (!this.storage) { throw new Error('KnowledgeManager has no storage adapter configured.'); }
		const payload = await this.storage.read(id);
		if (!payload) { throw new Error(`Knowledge base not found: "${id}"`); }
		const meta = payload.metadata as Record<string, unknown> ?? {};
		const templateId = (meta['templateId'] as string) ?? 'knowledge_graph';
		// A stored KB may have been built from a template OR a named method
		// (method names are persisted as templateId). Resolve accordingly.
		const tpl: KnowledgeTemplate | undefined = getTemplate(templateId);
		const session = tpl
			? this.create(templateId, { id, title: (meta['title'] as string) ?? tpl.label })
			: (() => {
			const m = getMethod(templateId);
			if (!m) { throw new Error(`Stored KB references unknown template/method "${templateId}".`); }
			return this.create(templateId, { id, title: (meta['title'] as string) ?? m.description, method: templateId });
			})();
		await session.autoType.deserialize(payload);
		session.createdAt = (meta['createdAt'] as string) ?? session.createdAt;
		session.updatedAt = (meta['updatedAt'] as string) ?? session.updatedAt;
		this.sessions.set(id, session);
		return session;
	}

	async delete(id: string): Promise<void> {
		this.sessions.delete(id);
		if (this.storage) { await this.storage.remove(id); }
	}

	/** Rebuild the index of a loaded/created session (e.g. after load). */
	async rebuildIndex(session: KnowledgeSession): Promise<void> {
		await this.buildIndex(session);
	}
}

export type { KnowledgeTemplate };
export type { SerializedKB };
