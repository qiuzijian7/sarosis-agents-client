/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — VS Code tool descriptors (`kb_*` tools)
 *
 *  Registers a set of built-in tools that expose the knowledge engine to
 *  the agent. Mirrors Hyper-Extract's `he parse` / `he search` / `he ask`
 *  CLI surface as agent-callable tools. All tools are stateless: each call
 *  rebuilds a `KnowledgeManager` (cheap) and loads/persists the KB to disk.
 *
 *  Tools are named `kb_*` so they auto-map to the `knowledge` toolset
 *  (see toolsetConfig.ts). They are wired into `BuiltinToolProvider`
 *  via `_registerKnowledgeTools()`.
 *--------------------------------------------------------------------------------------------*/

import type { IToolDefinition, IToolResultContent } from '../../common/providers.js';
import { URI } from '../../../../../base/common/uri.js';
import { join } from '../../../../../base/common/path.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IAiEmbeddingVectorService } from '../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { KnowledgeManager } from './engine/knowledgeManager.js';
import { listMethods } from './engine/methodRegistry.js';
import { resolveChatModel, createEmbedder } from './knowledgeAdapters.js';
import type { IEmbedder } from './engine/embedder.js';
import { createFileStorageAdapter } from './knowledgeStorage.js';
import { buildFolderRag, stableRepoSessionId, searchAcrossRepos, aggregateItems, classifyRepoStrategy, type BuildFolderOptions } from './engine/folderRagBuild.js';
export type { BuildFolderOptions } from './engine/folderRagBuild.js';
import { FsGitRepoProbe } from '../../common/fsGitRepoProbe.js';
import { appendKbOpLog, type IKbOpLogEntry, type KbOpStatus } from './kbOpLog.js';

export { classifyByKeywords, classifyContentViaLLM } from './classifier.js';
export type { ClassifyResult } from './classifier.js';

export interface KnowledgeToolDeps {
	readonly fileService: IFileService;
	readonly configurationService: IConfigurationService;
	readonly embeddingService: IAiEmbeddingVectorService;
	/** Resolve the base dir used to resolve relative source/output file paths (workspace root). */
	readonly resolveBaseDir: () => Promise<string>;
	/** Resolve the KB storage root (`<userHome>/.saros/kb` by default, config-overridable). */
	readonly resolveStorageRoot: () => Promise<string>;
	/**
	 * Resolve the knowledge-base agent's currently configured provider + model.
	 * When provided, `kb_*` tools use the KB agent's own provider/model (instead of
	 * the hardcoded openrouter default). Tool-level `provider`/`model` args still win.
	 */
	readonly resolveKbModel?: () => Promise<{ providerId: string; modelId: string }> | { providerId: string; modelId: string };
	/**
	 * Build an embedder for the KB agent's provider (provider follows the KB agent,
	 * embedding model is supplied by the caller). When provided, KB embedding uses
	 * the KB agent's provider rather than the global embedding service.
	 */
	readonly createKbEmbedder?: (providerId: string) => IEmbedder | Promise<IEmbedder>;
	/**
	 * Optional override for constructing the `KnowledgeManager` used by `kb_build` /
	 * `kb_ingest`. Test seam: inject a deterministic manager (mock LLM + embedder +
	 * in-memory storage) instead of the real resolver. When omitted, the real
	 * `resolveChatModel` + `createEmbedder` path is used (production).
	 */
	readonly createManager?: (opts: { model?: string; provider?: string }) => Promise<KnowledgeManager>;
	/**
	 * Read the global folder-RAG index (`repoRoot → sessionId`) aggregated across all
	 * imported folders. Used by `kb_search_repo` to fan-out a query over every imported
	 * repository session. Optional (tests that don't exercise folder RAG can omit it).
	 */
	readonly readFolderRagIndex?: () => Promise<Record<string, string>>;
}

interface IKbToolDescriptor {
	readonly definition: IToolDefinition;
	readonly handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[] | { content: IToolResultContent[]; details?: Record<string, unknown> }>;
	/** Optional function: returns false to hide this tool (e.g. when embeddings are disabled). */
	readonly available?: () => boolean;
}

function txt(s: string): IToolResultContent[] {
	return [{ type: 'text', text: s }];
}

/** A note-export target's dependency surface (decoupled from the `buildKnowledgeToolDescriptors` closure so it is unit-testable). */
export interface ExportToNotesDeps {
	readonly fileService: IFileService;
	readonly resolveStorageRoot: () => Promise<string>;
	readonly logKbTool?: (op: string, status: KbOpStatus, extra?: { source?: string; target?: string; detail?: Record<string, unknown>; error?: string }) => void | Promise<void>;
}

/**
 * Decide whether `kb_build` / `kb_ingest` should auto-export a note after parsing.
 * Default-on for the `notes_summary` template (import → cross-linkable note in one
 * call); otherwise requires an explicit `export_notes: true`. Pure + unit-tested.
 */
export function shouldAutoExportNotes(args: Record<string, unknown>, templateId: string): boolean {
	return args['export_notes'] === true
		|| (args['export_notes'] === undefined && templateId === 'notes_summary');
}

/**
 * Export a built KB as an Obsidian-style note ([[wikilinks]]) into
 * `<storage-root>/notes/<name>.md` (Hyper-Extract `export_to_obsidian` analogue).
 * Shared by `kb_export_notes` and the auto-export path of `kb_build`/`kb_ingest`.
 * Returns the on-disk note metadata, or undefined if export failed. Pure-ish
 * (only `deps.fileService` / `resolveStorageRoot` are touched) so it is unit-testable.
 */
export async function exportToNotes(
	deps: ExportToNotesDeps,
	manager: KnowledgeManager,
	session: { id: string; title?: string },
	args: Record<string, unknown>,
): Promise<{ path: string; bytes: number; note: string } | undefined> {
	try {
		const md = manager.exportMarkdown(session as any, {
			title: (session.title as string) || session.id,
			mermaid: args['mermaid'] !== false,
			wikilinks: args['wikilinks'] !== false,
		});
		const root = await deps.resolveStorageRoot();
		const rawName = (args['note_name'] as string) || (session.title as string) || session.id;
		const safeName = (rawName.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 120)) || session.id;
		const notesDir = URI.file(join(root, 'notes'));
		const noteUri = URI.joinPath(notesDir, `${safeName}.md`);
		await deps.fileService.createFolder(notesDir);
		await deps.fileService.writeFile(noteUri, VSBuffer.fromString(md));
		void deps.logKbTool?.('kb_export_notes', 'success', { target: noteUri.fsPath, detail: { id: session.id, bytes: md.length } });
		return { path: noteUri.fsPath, bytes: md.length, note: safeName };
	} catch (err) {
		void deps.logKbTool?.('kb_export_notes', 'failure', { target: session.id, error: err instanceof Error ? err.message : String(err) });
		return undefined;
	}
}

/** Extract the `text` payload from a `kb_*` tool result (the handlers return `[{ type: 'text', text }]`). */
function firstText(out: IToolResultContent[] | { content: IToolResultContent[]; details?: Record<string, unknown> }): string {
	const arr = Array.isArray(out) ? out : out.content;
	const t = arr.find(c => c.type === 'text');
	return t && 'text' in t ? (t as { text: string }).text : '';
}

export interface ImportToKbOptions {
	/** Pre-derived title (defaults to the first non-empty line of the content). */
	title?: string;
	/** Force a fresh `kb_build` even if a matching favorite already exists. */
	forceBuild?: boolean;
}

export interface ImportToKbResult {
	success: boolean;
	/** Whether the import created a new KB (build) or merged into an existing one (ingest). */
	action?: 'build' | 'ingest';
	/** Knowledge base id (for follow-up `kb_ingest` / `kb_search` / `kb_ask`). */
	id?: string;
	/** Note file base name (without .md). */
	note?: string;
	/** Absolute on-disk note path (<storage-root>/notes/<note>.md). */
	notePath?: string;
	title?: string;
	template?: string;
	itemCount?: number;
	error?: string;
}

/** Sidecar index mapping a normalized title key → kb id, persisted at `<root>/.fav-index.json`. */
const FAV_INDEX_FILE = '.fav-index.json';

function deriveTitle(content: string): string {
	const firstLine = content.split('\n').find(l => l.trim().length > 0)?.trim() || '收藏';
	return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
}

function titleKeyOf(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, '_').replace(/[<>:"/\\|?*\n\r]/g, '').slice(0, 100);
}

/**
 * Wire the chat "收藏到知识库" button to the KB engine.
 *
 * - First import of a topic → `kb_build(template_id='notes_summary')` auto-summarizes
 *   the message and writes a structured Obsidian note.
 * - Re-import of the same topic (matched by a normalized title key, persisted in
 *   `<root>/.fav-index.json`) → `kb_ingest(same id)` merges the new content into the
 *   existing KB and **re-exports the SAME note** (improved, not duplicated).
 *
 * This is the user-facing analogue of the `knowledge-base-expert` agent flow; the
 * manager is built from the same `KnowledgeToolDeps` (injectable for tests).
 */
export async function importMessageToKnowledgeBase(
	deps: KnowledgeToolDeps,
	content: string,
	opts: ImportToKbOptions = {},
): Promise<ImportToKbResult> {
	try {
		if (!content || !content.trim()) {
			return { success: false, error: 'Empty content' };
		}
		const title = opts.title ?? deriveTitle(content);
		const key = titleKeyOf(title);

		const root = await deps.resolveStorageRoot();
		const favIndexUri = URI.file(join(root, FAV_INDEX_FILE));
		let favIndex: Record<string, { id: string; title: string }> = {};
		try {
			const raw = await deps.fileService.readFile(favIndexUri);
			favIndex = JSON.parse(raw.value.toString()) as Record<string, { id: string; title: string }>;
		} catch {
			// no index yet — fresh import
		}

		const descriptors = buildKnowledgeToolDescriptors(deps);
		const buildDesc = descriptors.find(d => d.definition.name === 'kb_build')!;
		const ingestDesc = descriptors.find(d => d.definition.name === 'kb_ingest')!;

		// ── Improve existing note (kb_ingest) ──────────────────────────────────
		const existing = !opts.forceBuild ? favIndex[key] : undefined;
		if (existing?.id) {
			const out = await ingestDesc.handler({
				id: existing.id,
				text: content,
				// keep the same note name so the improved note lands at the same path
				note_name: key,
			});
			const r = JSON.parse(firstText(out));
			if (r.success) {
				return {
					success: true,
					action: 'ingest',
					id: r.id,
					note: r.note?.note,
					notePath: r.note?.path,
					title,
					template: 'notes_summary',
					itemCount: r.itemCount,
				};
			}
			// KB missing/corrupt → fall through to a fresh build.
		}

		// ── Generate a new note (kb_build) ─────────────────────────────────────
		const out = await buildDesc.handler({
			template_id: 'notes_summary',
			title,
			text: content,
			note_name: key,
		});
		const r = JSON.parse(firstText(out));
		if (!r.success) {
			return { success: false, error: r.error };
		}
		favIndex[key] = { id: r.id, title };
		try {
			await deps.fileService.writeFile(favIndexUri, VSBuffer.fromString(JSON.stringify(favIndex, null, 2)));
		} catch {
			// best-effort; the note is still created even if the index write fails
		}
		return {
			success: true,
			action: 'build',
			id: r.id,
			note: r.note?.note,
			notePath: r.note?.path,
			title,
			template: r.template,
			itemCount: r.itemCount,
		};
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Build a `KnowledgeManager` for KB operations. Extracted from the old
 * `buildManager` closure so it can be reused by both the `kb_*` tool descriptors
 * and the folder→RAG import path (`importFolderToRag`).
 */
export async function buildKbManager(
	deps: KnowledgeToolDeps,
	opts: { model?: string; provider?: string },
): Promise<KnowledgeManager> {
	// Test seam: allow injecting a deterministic manager (mock LLM/embedder).
	if (deps.createManager) { return deps.createManager(opts); }

	// 知识库 agent 当前配置的 provider/model（工具级 provider/model 覆盖优先）。
	const kb = (typeof deps.resolveKbModel === 'function')
		? await deps.resolveKbModel()
		: undefined;
	const providerId = opts.provider || kb?.providerId;
	const modelId = opts.model || kb?.modelId;

	const chatModel = resolveChatModel(deps.configurationService, {
		providerId,
		modelId,
	});

	// Embedding：优先用 KB agent 的 provider 专属 embedder；否则回退全局服务。
	const embedder = (deps.createKbEmbedder && (opts.provider || kb?.providerId))
		? await deps.createKbEmbedder(opts.provider || kb!.providerId!)
		: createEmbedder(deps.embeddingService);

	const storageRoot = await deps.resolveStorageRoot();
	const storage = createFileStorageAdapter(deps.fileService, storageRoot);
	return new KnowledgeManager({ llm: chatModel, embedder, storage, verbose: true });
}

/** Serializable result of `importFolderToRag` (Maps flattened for storage / IPC). */
export interface FolderRagResult {
	/** repoRoot (absolute fsPath) → sessionId — one session per git repository. */
	sessions: Record<string, string>;
	/** sessionId of the optional unversioned session, or null. */
	unversionedSessionId: string | null;
	/** repoRoot → error message (fault isolation: one repo failing doesn't abort the rest). */
	errors: Record<string, string>;
}

/**
 * Production entry point for "import a folder as per-repo RAG" (Option A):
 * one git repository → one KnowledgeSession. Builds a real `KnowledgeManager`
 * (LLM + embedder + file storage) and a real `IGitRepoProbe` over `IFileService`,
 * then delegates the pure pipeline to `buildFolderRag`.
 *
 * Sessions are persisted to disk via the storage adapter (same root as `kb_build`),
 * so they can be re-queried later via `kb_search` / `kb_ask` or re-ingested after a
 * `git pull` using the stable `stableRepoSessionId` mapping.
 */
export async function importFolderToRag(
	deps: KnowledgeToolDeps,
	folderPath: string,
	opts: BuildFolderOptions = {},
): Promise<FolderRagResult> {
	const manager = await buildKbManager(deps, {});
	const probe = new FsGitRepoProbe(deps.fileService);
	const res = await buildFolderRag(folderPath, { manager, probe }, {
		idForRepo: stableRepoSessionId,
		// Per-repo strategy differentiation: code-heavy repos → `light_rag`,
		// docs-heavy repos → `notes_summary` (an explicit templateId/method on
		// `opts` still overrides this). Callers may pass their own selector.
		chooseStrategy: classifyRepoStrategy,
		...opts,
	});
	const sessions: Record<string, string> = {};
	for (const [k, v] of res.sessions) { sessions[k] = v; }
	const errors: Record<string, string> = {};
	for (const [k, v] of res.errors) { errors[k] = v instanceof Error ? v.message : String(v); }
	return { sessions, unversionedSessionId: res.unversionedSessionId, errors };
}

/** Serializable result of `searchFolderRag` (cross-repo fan-out aggregation). */
export interface FolderRagSearchResult {
	query: string;
	/** Number of repository sessions included in the fan-out. */
	repoCount: number;
	/** Aggregated, de-duplicated, score-ranked items (each carries `_repoRoot`). */
	results: Array<Record<string, unknown>>;
	/** Per-repo load/search failures (fault isolation). */
	errors: Array<Record<string, unknown>>;
}

/**
 * Cross-repo semantic search over every imported folder's RAG sessions (Option A).
 *
 * Reads the global `repoRoot → sessionId` index (provided by the host via
 * `deps.readFolderRagIndex`), loads each session into a real `KnowledgeManager`,
 * fans the query out via `searchAcrossRepos`, and flattens/ranks the hits with
 * `aggregateItems`. One repo failing to load/search is isolated into `errors`
 * and does not abort the rest.
 */
export async function searchFolderRag(
	deps: KnowledgeToolDeps,
	query: string,
	topK = 5,
): Promise<FolderRagSearchResult> {
	const index = (typeof deps.readFolderRagIndex === 'function')
		? await deps.readFolderRagIndex()
		: {};
	const map = new Map<string, string>(Object.entries(index));
	if (map.size === 0) {
		return { query, repoCount: 0, results: [], errors: [] };
	}
	const manager = await buildKbManager(deps, {});
	const loadErrors: Array<{ repoRoot: string; error: string }> = [];
	for (const [repoRoot, sid] of map) {
		try {
			await manager.load(sid);
		} catch (e) {
			loadErrors.push({ repoRoot, error: e instanceof Error ? e.message : String(e) });
		}
	}
	const across = await searchAcrossRepos(manager, map, query, topK);
	const results = aggregateItems(across, topK);
	const errors = [
		...loadErrors,
		...across.errors.map(e => ({
			repoRoot: e.repoRoot,
			error: e.error instanceof Error ? e.error.message : String(e.error),
		})),
	];
	return { query, repoCount: map.size, results, errors };
}

export function buildKnowledgeToolDescriptors(deps: KnowledgeToolDeps): IKbToolDescriptor[] {

	async function buildManager(opts: { model?: string; provider?: string }): Promise<KnowledgeManager> {
		return buildKbManager(deps, opts);
	}

	function resolveFileUri(baseDir: string, filePath?: unknown): URI | undefined {
		const p = (filePath as string | undefined)?.trim();
		if (!p) { return undefined; }
		const isAbs = p.includes(':') || p.startsWith('/') || /^[A-Za-z]:/.test(p);
		return URI.file(isAbs ? p : join(baseDir, p));
	}

	/** Best-effort operation log for `kb_*` tools → `<kbRoot>/.op-log.jsonl`. */
	async function logKbTool(
		op: string, status: KbOpStatus,
		extra?: { source?: string; target?: string; detail?: Record<string, unknown>; error?: string },
	): Promise<void> {
		try {
			const root = await deps.resolveStorageRoot();
			await appendKbOpLog(deps.fileService, root, {
				ts: new Date().toISOString(), op, status, channel: 'engine',
				source: extra?.source, target: extra?.target,
				detail: extra?.detail, error: extra?.error,
			} as IKbOpLogEntry);
		} catch {
			// logging must never break the tool call
		}
	}

	async function readSource(args: Record<string, unknown>): Promise<string> {
		const text = (args['text'] as string | undefined)?.trim();
		if (text) { return text; }
		const fp = (args['file_path'] as string | undefined)?.trim();
		if (fp) {
			const baseDir = await deps.resolveBaseDir();
			const uri = resolveFileUri(baseDir, fp);
			if (uri) {
				try {
					const stat = await deps.fileService.readFile(uri);
					const content = stat.value.toString();
					if (content.trim()) { return content; }
				} catch {
					// fall through to empty
				}
			}
		}
		return '';
	}

	const embeddingEnabled = () => deps.embeddingService.isEnabled();
	const available = embeddingEnabled;

	const descriptors: IKbToolDescriptor[] = [
		// ── kb_list_templates ──────────────────────────────
		{
			definition: {
				name: 'kb_list_templates',
				description: 'List available knowledge-base templates (e.g. knowledge_graph, entity_list, faq). Call this first to discover which template id to pass to kb_build.',
				inputSchema: { type: 'object', properties: {} },
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			handler: async () => {
				const tmpls = KnowledgeManager.availableTemplates();
				return txt(JSON.stringify(tmpls, null, 2));
			},
		},

		// ── kb_list_methods ──────────────────────────────
		{
			definition: {
				name: 'kb_list_methods',
				description: 'List available extraction methods (fine-tuned strategies like light_rag, itext2kg, atom). Call this to discover which `method` to pass to kb_build for tuning how entities/relationships are extracted.',
				inputSchema: { type: 'object', properties: {} },
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			handler: async () => {
				const methods = listMethods();
				return txt(JSON.stringify(
					methods.map(m => ({ name: m.name, kind: m.kind, description: m.description, domain: m.domain })),
					null, 2,
				));
			},
		},

		// ── kb_build ──────────────────────────────────────
		{
			definition: {
				name: 'kb_build',
				description: 'Build a knowledge base from a document. Extracts entities/relationships (or a list) via LLM, embeds them, and persists the index. Returns the kb id for later kb_search / kb_ask. Provide either `text` or `file_path`. With `template_id="notes_summary"` (or `export_notes: true`) it also auto-writes a structured Obsidian note to the KB notes vault (<storage-root>/notes), so a single call turns a document into a cross-linkable note.',
				inputSchema: {
					type: 'object',
					properties: {
						title: { type: 'string', description: 'Human-readable title for the knowledge base' },
						template_id: { type: 'string', description: 'Template id from kb_list_templates (default: knowledge_graph)' },
						method: { type: 'string', description: 'Optional extraction method to fine-tune how entities/relationships are extracted. Use kb_list_methods to discover available methods (e.g. light_rag, itext2kg, atom, hyper_rag). When set, the method overrides the template\'s default extraction strategy.' },
						text: { type: 'string', description: 'Raw document text to parse' },
						file_path: { type: 'string', description: 'Path to a text/markdown file to parse (relative to the workspace root)' },
						model: { type: 'string', description: 'Optional model id overriding the default LLM' },
						provider: { type: 'string', description: 'Optional BYOK provider id (default: openrouter)' },
						export_notes: { type: 'boolean', description: 'Auto-export a structured Obsidian note (with [[wikilinks]]) into the KB notes vault after building. Default: true when template_id=notes_summary, otherwise false.' },
						note_name: { type: 'string', description: 'Optional note file name (without .md) when export_notes is true. Defaults to a sanitized KB title.' },
						mermaid: { type: 'boolean', description: 'Include the ```mermaid graph block when export_notes is true (graph templates only). Default: true.' },
						wikilinks: { type: 'boolean', description: 'Use Obsidian [[wikilinks]] for node names when export_notes is true. Default: true.' },
					},
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
		handler: async (args) => {
			const templateId = (args['template_id'] as string) || 'knowledge_graph';
			const method = (args['method'] as string) || undefined;
			const title = (args['title'] as string) || (method ?? templateId);
			const filePath = (args['file_path'] as string)?.trim();
		// 导入即自动总结落笔记目录：notes_summary 模板默认导出，其他模板需显式开启
		const exportNotes = shouldAutoExportNotes(args, templateId);
			try {
				const source = await readSource(args);
					if (!source.trim()) {
						return txt(JSON.stringify({ success: false, error: 'Provide `text` or `file_path`.' }));
					}
					const manager = await buildManager({ model: args['model'] as string, provider: args['provider'] as string });
					const session = manager.create(templateId, { title, method });
					await manager.parseText(session, source);
					// 记录来源文件路径（用于 kb_list 展示）
					if (filePath) { (session as any)._sourcePath = filePath; }
					await manager.persist(session);
					void logKbTool('kb_build', 'success', { target: session.id, detail: { title, template: templateId, method, kind: session.kind, itemCount: session.meta.itemCount, source: filePath } });
					const result: Record<string, unknown> = {
						success: true,
						id: session.id,
						title: session.title,
						template: templateId,
						kind: session.kind,
						itemCount: session.meta.itemCount,
					};
					if (method) { result['method'] = method; }
					if (exportNotes) {
						const note = await exportToNotes({ fileService: deps.fileService, resolveStorageRoot: deps.resolveStorageRoot, logKbTool }, manager, session, args);
						if (note) { result['note'] = note; }
					}
					return txt(JSON.stringify(result, null, 2));
				} catch (err) {
					void logKbTool('kb_build', 'failure', { detail: { title, template: templateId, method }, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_ingest ───────────────────────────────────
		{
			definition: {
				name: 'kb_ingest',
				description: 'Add more documents to an existing knowledge base (by id). Re-extracts and merges with the existing index. Provide either `text` or `file_path`.',
				inputSchema: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Knowledge base id returned by kb_build' },
						text: { type: 'string', description: 'Raw document text to parse' },
						file_path: { type: 'string', description: 'Path to a text/markdown file to parse (relative to the workspace root)' },
						model: { type: 'string', description: 'Optional model id overriding the default LLM' },
						provider: { type: 'string', description: 'Optional BYOK provider id (default: openrouter)' },
						export_notes: { type: 'boolean', description: 'Re-export the updated KB as an Obsidian note into the notes vault after ingesting. Default: true when the KB template is notes_summary, otherwise false.' },
						note_name: { type: 'string', description: 'Optional note file name (without .md) when export_notes is true. Defaults to a sanitized KB title.' },
						mermaid: { type: 'boolean', description: 'Include the ```mermaid graph block when export_notes is true (graph templates only). Default: true.' },
						wikilinks: { type: 'boolean', description: 'Use Obsidian [[wikilinks]] for node names when export_notes is true. Default: true.' },
					},
					required: ['id'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
		handler: async (args) => {
			const id = args['id'] as string;
			try {
				if (!id) { return txt(JSON.stringify({ success: false, error: '`id` is required' })); }
				const source = await readSource(args);
					if (!source.trim()) {
						return txt(JSON.stringify({ success: false, error: 'Provide `text` or `file_path`.' }));
					}
					const manager = await buildManager({ model: args['model'] as string, provider: args['provider'] as string });
					const session = await manager.load(id);
					const templateId = session.templateId;
					const exportNotes = shouldAutoExportNotes(args, templateId);
					await manager.parseText(session, source);
					await manager.persist(session);
					void logKbTool('kb_ingest', 'success', { target: session.id, detail: { itemCount: session.meta.itemCount } });
					const result: Record<string, unknown> = {
						success: true, id: session.id, itemCount: session.meta.itemCount,
					};
					if (exportNotes) {
						const note = await exportToNotes({ fileService: deps.fileService, resolveStorageRoot: deps.resolveStorageRoot, logKbTool }, manager, session, args);
						if (note) { result['note'] = note; }
					}
					return txt(JSON.stringify(result, null, 2));
				} catch (err) {
					void logKbTool('kb_ingest', 'failure', { target: id, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_search ───────────────────────────────────
		{
			definition: {
				name: 'kb_search',
				description: 'Semantic search over a built knowledge base (by id). Returns the most relevant entities/relationships or list items for a query.',
				inputSchema: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Knowledge base id' },
						query: { type: 'string', description: 'Search query' },
						top_k: { type: 'number', description: 'Number of results (default: 5)' },
					},
					required: ['id', 'query'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
		handler: async (args) => {
			const id = args['id'] as string;
			const query = args['query'] as string;
			try {
				if (!id || !query) {
					return txt(JSON.stringify({ success: false, error: '`id` and `query` are required' }));
				}
				const topK = typeof args['top_k'] === 'number' ? Math.min(Math.max(1, args['top_k'] as number), 50) : 5;
				const manager = await buildManager({});
					const session = await manager.load(id);
					const result = await manager.search(session, query, topK);
					void logKbTool('kb_search', 'success', { target: id, detail: { query, topK } });
					return txt(JSON.stringify({ success: true, ...result }, null, 2));
				} catch (err) {
					void logKbTool('kb_search', 'failure', { target: id, detail: { query }, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_ask ──────────────────────────────────────
		{
			definition: {
				name: 'kb_ask',
				description: 'RAG question answering over a built knowledge base (by id). Retrieves relevant items and asks the LLM to answer grounded in them.',
				inputSchema: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Knowledge base id' },
						query: { type: 'string', description: 'The question to answer' },
						top_k: { type: 'number', description: 'Number of retrieved items to ground the answer (default: 5)' },
						model: { type: 'string', description: 'Optional model id for the answer synthesis' },
						provider: { type: 'string', description: 'Optional BYOK provider id (default: openrouter)' },
					},
					required: ['id', 'query'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
		handler: async (args) => {
			const id = args['id'] as string;
			const query = args['query'] as string;
			try {
				if (!id || !query) {
					return txt(JSON.stringify({ success: false, error: '`id` and `query` are required' }));
				}
				const topK = typeof args['top_k'] === 'number' ? Math.min(Math.max(1, args['top_k'] as number), 50) : 5;
				const manager = await buildManager({ model: args['model'] as string, provider: args['provider'] as string });
					const session = await manager.load(id);
					const { text, retrieved } = await manager.chat(session, query, topK);
					void logKbTool('kb_ask', 'success', { target: id, detail: { query, topK, chars: text.length } });
					// 返回自然文本回答 + 检索来源（便于 Agent 理解）
					return [
						{ type: 'text', text },
						{ type: 'text', text: `\n\n---\n📎 Retrieved ${retrieved?.nodes?.length ?? retrieved?.items?.length ?? 0} items from "${session.title}" (id: ${id})` },
					];
				} catch (err) {
					void logKbTool('kb_ask', 'failure', { target: id, detail: { query }, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_search_repo (cross-repo folder RAG search) ─
		{
			definition: {
				name: 'kb_search_repo',
				description: 'Cross-repository semantic search over ALL folders imported as per-repo RAG (one session per git repo). Fans the query out across every imported repository and returns de-duplicated, score-ranked items (each tagged with its source `_repoRoot`). Use this to find code/docs across the whole workspace linked/copied folders at once — unlike `kb_search` which targets a single knowledge base by id.',
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Search query' },
						top_k: { type: 'number', description: 'Number of results per repo (default: 5, capped at 50)' },
					},
					required: ['query'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
			handler: async (args) => {
				const query = args['query'] as string;
				if (!query || !query.trim()) {
					return txt(JSON.stringify({ success: false, error: '`query` is required' }));
				}
				const topK = typeof args['top_k'] === 'number' ? Math.min(Math.max(1, args['top_k'] as number), 50) : 5;
				try {
					const res = await searchFolderRag(deps, query, topK);
					void logKbTool('kb_search_repo', 'success', { detail: { query, repoCount: res.repoCount, hits: res.results.length } });
					return txt(JSON.stringify({ success: true, ...res }, null, 2));
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					void logKbTool('kb_search_repo', 'failure', { detail: { query }, error: msg });
					return txt(JSON.stringify({ success: false, error: msg }));
				}
			},
		},

		// ── kb_export ───────────────────────────────────
	{
		definition: {
			name: 'kb_export',
			description: 'Export a built knowledge base to a Markdown file (Obsidian-style: [[wikilinks]] for nodes + a ```mermaid graph for graph templates; bullet/list rendering for list/model/set/hypergraph templates). Provide an `output_path` to write the .md file, or omit it to return the markdown inline.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Knowledge base id returned by kb_build' },
					output_path: { type: 'string', description: 'Optional path to write the .md file (absolute, or relative to the workspace root). Omit to return markdown inline.' },
					title: { type: 'string', description: 'Optional document title (defaults to the KB title).' },
					mermaid: { type: 'boolean', description: 'Include the ```mermaid graph block. Default: true.' },
					wikilinks: { type: 'boolean', description: 'Use Obsidian [[wikilinks]] for node names. Default: true.' },
				},
				required: ['id'],
			},
			category: 'knowledge',
			source: 'saros.knowledge',
		},
		handler: async (args) => {
			const id = args['id'] as string;
			try {
				if (!id) { return txt(JSON.stringify({ success: false, error: '`id` is required' })); }
				const manager = await buildManager({});
				const session = await manager.load(id);
				const md = manager.exportMarkdown(session, {
					title: (args['title'] as string) || session.title,
					mermaid: args['mermaid'] !== false,
					wikilinks: args['wikilinks'] !== false,
				});
				const outArg = args['output_path'] as string | undefined;
				if (outArg) {
					const baseDir = await deps.resolveBaseDir();
					const uri = resolveFileUri(baseDir, outArg);
					if (!uri) { return txt(JSON.stringify({ success: false, error: '`output_path` is invalid' })); }
					await deps.fileService.createFolder(URI.joinPath(uri, '..'));
					await deps.fileService.writeFile(uri, VSBuffer.fromString(md));
					void logKbTool('kb_export', 'success', { target: uri.fsPath, detail: { id, bytes: md.length } });
					return txt(JSON.stringify({ success: true, path: uri.fsPath, bytes: md.length }, null, 2));
				}
				void logKbTool('kb_export', 'success', { target: 'inline', detail: { id, bytes: md.length } });
				return txt(JSON.stringify({ success: true, markdown: md }, null, 2));
			} catch (err) {
				void logKbTool('kb_export', 'failure', { target: id, error: err instanceof Error ? err.message : String(err) });
				return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
			}
		},
	},

	// ── kb_export_notes ───────────────────────────
	{
		definition: {
			name: 'kb_export_notes',
			description: 'Export a built knowledge base as an Obsidian-style Markdown note (with [[wikilinks]]) into the KB notes vault (<storage-root>/notes). Mirrors Hyper-Extract `export_to_obsidian`: each KB becomes a cross-linkable note. Returns the note path so downstream tools can reference it via [[wikilinks]]. Provide an optional `note_name` to override the auto-derived file name.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Knowledge base id returned by kb_build' },
					note_name: { type: 'string', description: 'Optional note file name (without .md). Defaults to a sanitized KB title.' },
					mermaid: { type: 'boolean', description: 'Include the ```mermaid graph block (graph templates only). Default: true.' },
					wikilinks: { type: 'boolean', description: 'Use Obsidian [[wikilinks]] for node names. Default: true.' },
				},
				required: ['id'],
			},
			category: 'knowledge',
			source: 'saros.knowledge',
		},
		handler: async (args) => {
			const id = args['id'] as string;
			try {
				if (!id) { return txt(JSON.stringify({ success: false, error: '`id` is required' })); }
				const manager = await buildManager({});
				const session = await manager.load(id);
				const note = await exportToNotes({ fileService: deps.fileService, resolveStorageRoot: deps.resolveStorageRoot, logKbTool }, manager, session, args);
				if (!note) { return txt(JSON.stringify({ success: false, error: 'Failed to export note' })); }
				return txt(JSON.stringify({ success: true, ...note }, null, 2));
			} catch (err) {
				void logKbTool('kb_export_notes', 'failure', { target: id, error: err instanceof Error ? err.message : String(err) });
				return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
			}
		},
	},

	// ── kb_list ─────────────────────────────────────
		{
			definition: {
				name: 'kb_list',
				description: 'List all persisted knowledge bases in this workspace.',
				inputSchema: { type: 'object', properties: {} },
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			handler: async () => {
				try {
					const manager = await buildManager({});
					const list = await manager.listStored();
					void logKbTool('kb_list', 'success', { detail: { count: (list as unknown[]).length } });
					return txt(JSON.stringify({ success: true, knowledgeBases: list }, null, 2));
				} catch (err) {
					void logKbTool('kb_list', 'failure', { error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_delete ───────────────────────────────────
		{
			definition: {
				name: 'kb_delete',
				description: 'Delete a knowledge base (by id) and its persisted index.',
				inputSchema: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Knowledge base id' },
					},
					required: ['id'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
		handler: async (args) => {
			const id = args['id'] as string;
			try {
				if (!id) { return txt(JSON.stringify({ success: false, error: '`id` is required' })); }
				const manager = await buildManager({});
				await manager.delete(id);
					void logKbTool('kb_delete', 'success', { target: id });
					return txt(JSON.stringify({ success: true, deleted: id }, null, 2));
				} catch (err) {
					void logKbTool('kb_delete', 'failure', { target: id, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},
	];

	return descriptors;
}
