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
import { resolveChatModel, createEmbedder, isChatProviderConfigured } from './knowledgeAdapters.js';
import type { IChatModel } from './engine/llm.js';
import type { IEmbedder } from './engine/embedder.js';
import { createFileStorageAdapter } from './knowledgeStorage.js';
import { getPrompt } from './engine/i18nPrompts.js';
import type { JsonSchema } from './engine/types.js';
import { buildFolderRag, stableRepoSessionId, searchAcrossRepos, aggregateItems, classifyRepoStrategy, type BuildFolderOptions } from './engine/folderRagBuild.js';
export type { BuildFolderOptions } from './engine/folderRagBuild.js';
import { FsGitRepoProbe } from '../../common/fsGitRepoProbe.js';
import { appendKbOpLog, type IKbOpLogEntry, type KbOpStatus } from './kbOpLog.js';

export { classifyContentViaSchema, safeSchemaFallback } from './classifier.js';
export type { SchemaClassifyResult } from './classifier.js';

export interface KnowledgeToolDeps {
	readonly fileService: IFileService;
	readonly configurationService: IConfigurationService;
	readonly embeddingService: IAiEmbeddingVectorService;
	/** Resolve the base dir used to resolve relative source/output file paths (workspace root). */
	readonly resolveBaseDir: () => Promise<string>;
	/** Resolve the KB storage root (`<userHome>/.saros/kb` by default, config-overridable). */
	readonly resolveStorageRoot: () => Promise<string>;
	/**
	 * Resolve the target notes directory for raw/LLM-summary imports.
	 * When provided, notes are written under this path (resolved from the active vault's
	 * notes section). When omitted, falls back to `<storageRoot>/notes/`.
	 */
	readonly resolveNotesDir?: () => Promise<string>;
	/**
	 * Resolve the knowledge-base agent's currently configured provider + model.
	 * When provided, `kb_*` tools use the KB agent's own provider/model (instead of
	 * the hardcoded openrouter default). Tool-level `provider`/`model` args still win.
	 */
	readonly resolveKbModel?: () => Promise<{ providerId: string; modelId: string }> | { providerId: string; modelId: string };
	/**
	 * 经 AgentOS provider 传输构建 KB chat 模型（与 Agent Chat 同一管线：
	 * `lm:` 桥接 provider 经扩展宿主调用，无渲染进程 CORS 限制、鉴权由 provider 托管）。
	 * 提供时优先于旧的 OpenAI 兼容直连路径（resolveChatModel）。
	 */
	readonly createKbChatModel?: (opts: { providerId: string; modelId: string; agentId?: string }) => IChatModel | null | Promise<IChatModel | null>;
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

/**
 * 判断给定 provider 是否可用于 KB chat 调用。
 *   - `lm:` 桥接 provider：鉴权由 provider 扩展托管（无 BYOK key 概念），有构建器即可用；
 *   - 其余 BYOK provider：必须已配 base URL + API key。
 */
function isKbChatUsable(deps: KnowledgeToolDeps, providerId: string | undefined, modelId?: string): boolean {
	if (!providerId) { return false; }
	if (providerId.startsWith('lm:')) { return !!deps.createKbChatModel; }
	return isChatProviderConfigured(deps.configurationService, { providerId, modelId });
}

/**
 * 构建 KB chat 模型：优先 `deps.createKbChatModel`（AgentOS provider 传输，lm: 无 CORS），
 * 未提供/未命中时回退旧的 OpenAI 兼容直连路径。
 */
async function resolveKbChatModelViaDeps(deps: KnowledgeToolDeps, opts: { providerId?: string; modelId?: string }): Promise<IChatModel> {
	if (opts.providerId && deps.createKbChatModel) {
		const m = await deps.createKbChatModel({ providerId: opts.providerId, modelId: opts.modelId ?? '' });
		if (m) { return m; }
	}
	return resolveChatModel(deps.configurationService, opts);
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

export interface ImportToKbOptions {
	/** Pre-derived title (defaults to the first non-empty line of the content). */
	title?: string;
	/** Force a fresh `kb_build` even if a matching favorite already exists. */
	forceBuild?: boolean;
	/** Originating agent id (stored in the note's frontmatter `agentid`). */
	agentId?: string;
	/** Origin label (stored in the note's frontmatter `source`). Defaults to `agent-chat-import`. */
	source?: string;
	/** Optional category (stored in the note's frontmatter `category`). */
	category?: string;
	/** Optional tags (stored in the note's frontmatter `tags`). */
	tags?: string[];
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
 * With `kb_build`/`kb_ingest` removed from agent tools (kb entry point reserved for
 * Settings UI only), this function delegates directly to
 * `summarizeMessageToKnowledgeBase` — the LLM-only summary path that writes a
 * structured note WITHOUT building a `KnowledgeManager` / embedding index.
 *
 * De-duplication is handled by a sidecar `.fav-index.json`, same as before.
 */
export async function importMessageToKnowledgeBase(
	deps: KnowledgeToolDeps,
	content: string,
	opts: ImportToKbOptions = {},
): Promise<ImportToKbResult> {
	// With kb_build/kb_ingest removed from the tool surface, delegate to the
	// LLM-only summary path which produces the same structured notes_summary output
	// without requiring a KnowledgeManager / embedding provider.
	const result = await summarizeMessageToKnowledgeBase(deps, content, opts);
	if (!result.success) { return result; }

	// Persist de-dup index so re-imports don't create duplicate notes
	try {
		const root = await deps.resolveStorageRoot();
		const favIndexUri = URI.file(join(root, FAV_INDEX_FILE));
		let favIndex: Record<string, { id: string; title: string }> = {};
		try {
			const raw = await deps.fileService.readFile(favIndexUri);
			favIndex = JSON.parse(raw.value.toString()) as Record<string, { id: string; title: string }>;
		} catch { /* no index yet */ }
		if (result.id && result.title) {
			favIndex[titleKeyOf(result.title)] = { id: result.id, title: result.title };
		}
		await deps.fileService.writeFile(favIndexUri, VSBuffer.fromString(JSON.stringify(favIndex, null, 2)));
	} catch { /* best-effort */ }

	return result;
}

/**
 * LLM-only summary import — the lightweight analogue of `importMessageToKnowledgeBase`.
 *
 * Unlike `importMessageToKnowledgeBase`, this NEVER builds a `KnowledgeManager` /
 * embedder, so it works WITHOUT an embedding provider. It uses the KB agent's chat
 * LLM to summarize the message (the `notes_summary` template) and writes a structured
 * note to `<storage-root>/notes/<key>.md`. This is the preferred path for the chat
 * "导入知识库" button when vector retrieval (semantic search) is not needed.
 */
export async function summarizeMessageToKnowledgeBase(
	deps: KnowledgeToolDeps,
	content: string,
	opts: ImportToKbOptions = {},
): Promise<ImportToKbResult> {
	try {
		if (!content?.trim()) {
			return { success: false, error: 'Empty content' };
		}

		const kb = (typeof deps.resolveKbModel === 'function') ? await deps.resolveKbModel() : undefined;

		// 纯 LLM 总结：需要 chat provider，但不需要 embedding provider。
		if (!isKbChatUsable(deps, kb?.providerId, kb?.modelId)) {
			return {
				success: false,
				error: '未配置 LLM Provider，无法生成总结。请在 Settings → Agent Studio → Model Providers 中配置 Chat Provider（API key + base URL）。',
			};
		}
		const chatModel = await resolveKbChatModelViaDeps(deps, {
			providerId: kb?.providerId,
			modelId: kb?.modelId,
		});

		const title = opts.title?.trim() || deriveTitle(content);
		const key = titleKeyOf(title);

		const prompt = getPrompt('template.notes_summary').replace(/\{source_text\}/g, content);

		const schema: JsonSchema = {
			type: 'object',
			properties: {
				title: { type: 'string', description: '简短标题（中文）' },
				summary: { type: 'string', description: '一句话/一段总结（中文）' },
				tags: { type: 'array', items: { type: 'string' }, description: '关键词标签' },
				category: { type: 'string', description: '分类，如 code_example/experience/concept/doc' },
				key_points: { type: 'array', items: { type: 'string' }, description: '要点列表' },
			},
			required: ['title', 'summary', 'tags', 'category', 'key_points'],
		};

		const parsed = await chatModel.extract<{
			title: string;
			summary: string;
			tags: string[];
			category: string;
			key_points: string[];
		}>({ prompt, schema });

		const note = renderSummaryNote(parsed, content);
		const root = await deps.resolveStorageRoot();
		const notesDir = URI.file(join(root, 'notes'));
		let noteUri = URI.joinPath(notesDir, `${key}.md`);
		// 避免覆盖已有笔记：同名则追加时间戳后缀
		if (await deps.fileService.exists(noteUri)) {
			noteUri = URI.joinPath(notesDir, `${key}_${Date.now()}.md`);
		}
		await deps.fileService.createFolder(notesDir);
		await deps.fileService.writeFile(noteUri, VSBuffer.fromString(note));

		return {
			success: true,
			action: 'build',
			id: key,
			note: key,
			notePath: noteUri.fsPath,
			title: parsed.title || title,
			template: 'notes_summary',
		};
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Raw-import the message **as-is** into the knowledge base.
 *
 * Writes the original content verbatim into the vault's notes directory (resolved via
 * `deps.resolveNotesDir`, falling back to `<storage-root>/notes/`), prefixed with a
 * YAML frontmatter header carrying metadata (date / source / agentid / category /
 * tags). The title is LLM-generated from the content when a chat provider is
 * available, falling back to the first non-empty line otherwise.
 *
 * Unlike `importMessageToKnowledgeBase`, this does NOT build a vector/embedding index.
 * This is the preferred path for the chat "导入知识库" button.
 */
export async function importMessageRawToKnowledgeBase(
	deps: KnowledgeToolDeps,
	content: string,
	opts: ImportToKbOptions = {},
): Promise<ImportToKbResult> {
	try {
		if (!content?.trim()) {
			return { success: false, error: 'Empty content' };
		}

		// Resolve the target notes directory: prefer the active vault's notes dir
		// so the document appears in the knowledge-base view (which scans
		// <vaultId>/笔记/). Fall back to legacy <storageRoot>/notes/.
		let notesDir: URI;
		if (typeof deps.resolveNotesDir === 'function') {
			try {
				notesDir = URI.file(await deps.resolveNotesDir());
			} catch {
				notesDir = URI.file(join(await deps.resolveStorageRoot(), 'notes'));
			}
		} else {
			notesDir = URI.file(join(await deps.resolveStorageRoot(), 'notes'));
		}
		await deps.fileService.createFolder(notesDir);

		const now = new Date();
		const dateStr = now.toISOString().slice(0, 10);
		const hash = simpleHash(content);
		const key = `${dateStr}_${hash}`;

		const source = opts.source ?? 'agent-chat-import';
		const agentId = opts.agentId ?? 'unknown';

		// LLM title generation: ask the chat model for a short title
		const title = opts.title?.trim() || await deriveTitleFromLLM(deps, content);

		const md = renderRawNote(content, {
			date: now.toISOString(),
			source,
			agentId,
			category: opts.category,
			tags: opts.tags,
			title,
		});

		const noteUri = URI.joinPath(notesDir, `${key}.md`);
		await deps.fileService.writeFile(noteUri, VSBuffer.fromString(md));

		return {
			success: true,
			action: 'build',
			id: key,
			note: key,
			notePath: noteUri.fsPath,
			title,
		};
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Generate a short title from the content via the KB chat LLM.
 * Falls back to `deriveTitle` (first non-empty line) when no chat provider
 * is configured or the LLM call fails.
 */
async function deriveTitleFromLLM(deps: KnowledgeToolDeps, content: string): Promise<string> {
	// Check if a chat provider is available
	try {
		const kb =
			typeof deps.resolveKbModel === 'function' ? await deps.resolveKbModel() : undefined;
		if (!kb || !isKbChatUsable(deps, kb.providerId, kb.modelId)) {
			return deriveTitle(content);
		}

		const chatModel = await resolveKbChatModelViaDeps(deps, {
			providerId: kb.providerId,
			modelId: kb.modelId,
		});

		const titleSchema: JsonSchema = {
			type: 'object',
			properties: {
				title: { type: 'string', description: '简短标题，不超过50个字符，用中文概括内容主题' },
			},
			required: ['title'],
		};

		const prompt = [
			'你是一个标题提取助手。请阅读以下内容，用**不超过50个字符的中文**概括它的主题，只输出标题文本，不要任何额外解释。',
			'如果内容是技术讨论/代码/配置，标题应体现技术主题（如 "React useEffect 依赖数组最佳实践"）。',
			'如果内容是对话或问题解答，标题应体现问题或答案要点（如 "Python 协程与多线程的区别"）。',
			'',
			'--- 内容 ---',
			content.slice(0, 3000),
		].join('\n');

		const parsed = await chatModel.extract<{ title: string }>({
			prompt,
			schema: titleSchema,
		});

		const llmTitle = parsed?.title?.trim();
		if (llmTitle && llmTitle.length > 0) {
			return llmTitle.length > 80 ? llmTitle.slice(0, 77) + '...' : llmTitle;
		}
	} catch {
		// LLM unavailable → fall through to deriveTitle
	}
	return deriveTitle(content);
}

/** Render the raw message into a markdown note with a metadata frontmatter header. */
function renderRawNote(
	content: string,
	meta: { date: string; source: string; agentId: string; category?: string; tags?: string[]; title: string },
): string {
	const lines: string[] = ['---'];
	lines.push(`title: ${JSON.stringify(meta.title)}`);
	lines.push(`date: ${meta.date}`);
	lines.push(`source: ${meta.source}`);
	lines.push(`agentid: ${meta.agentId}`);
	if (meta.category) { lines.push(`category: ${meta.category}`); }
	if (meta.tags?.length) { lines.push(`tags: [${meta.tags.join(', ')}]`); }
	lines.push('---');
	lines.push('');
	// 原样存档：不修改、不总结正文内容
	lines.push(content.trimEnd());
	lines.push('');
	return lines.join('\n');
}

/** Deterministic short base36 hash (for de-dup / filename uniqueness). */
function simpleHash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (h << 5) - h + s.charCodeAt(i);
		h |= 0;
	}
	return Math.abs(h).toString(36);
}

/** Render an LLM summary into a clean, cross-linkable markdown note (no embeddings). */
function renderSummaryNote(
	p: { title: string; summary: string; tags: string[]; category: string; key_points: string[] },
	original: string,
): string {
	const tags = Array.isArray(p.tags) ? p.tags : [];
	const points = Array.isArray(p.key_points) && p.key_points.length
		? p.key_points.map(k => `- ${k}`).join('\n')
		: '- （无）';
	return [
		'---',
		`title: ${JSON.stringify(p.title || '未命名')}`,
		`summary: ${JSON.stringify(p.summary || '')}`,
		`category: ${p.category || 'note'}`,
		`tags: [${tags.join(', ')}]`,
		'source: agent-chat-import',
		`created_at: ${new Date().toISOString()}`,
		'---',
		'',
		`# ${p.title || '未命名'}`,
		'',
		`> ${p.summary || ''}`,
		'',
		'## 关键要点',
		points,
		'',
		'## 原文',
		'```text',
		original,
		'```',
		'',
	].join('\n');
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

	const chatModel = await resolveKbChatModelViaDeps(deps, {
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

	const embeddingEnabled = () => deps.embeddingService.isEnabled();
	const available = embeddingEnabled;

	// ── Note ──
	// `kb_build`, `kb_ingest`, `kb_list_templates`, `kb_list_methods` are intentionally NOT
	// registered as agent tools. The structured KB knowledge graph / vector index build entry
	// point is retained ONLY in the KB Settings UI (`🔄 重新构建向量索引` button →
	// `rebuildVectorIndex()`). The primary chat-agent → KB pipeline uses the structured
	// extraction flow (🧩 button → knowledge-base-expert agent + [skill:structured-extract])
	// or the lightweight `importMessageRawToKnowledgeBase` path (chat "导入知识库" button).
	// ──────────────────────────────────────────────────

	const descriptors: IKbToolDescriptor[] = [

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
					// P0-2：token 预算封顶，防检索结果撑爆 LLM 上下文
					const result = await manager.search(session, query, topK, { maxTokens: 4000 });
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
				inputSchema: { type: 'object', properties: { _no_params: { type: 'boolean', description: 'No parameters needed' } } },
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
