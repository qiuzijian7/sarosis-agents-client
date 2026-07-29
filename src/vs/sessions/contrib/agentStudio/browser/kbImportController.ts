/*---------------------------------------------------------------------------------------------
 *  KbImportController — 知识库导入控制器
 *  负责聊天消息导入知识库的完整生命周期：分类、落盘库、构建笔记、维护导航。
 *
 *  两阶段工作流（对齐 llm_wiki）：
 *   阶段1 (import):  导入按钮 → schema分类 → 库/<typeDir>/<topic>/<date>_<hash>.md
 *   阶段2 (build):   用户点击构建 → Agent读库文件 → 笔记/用户目录或LLM创建
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { IChatModel } from './knowledge/engine/llm.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { AGENT_STUDIO_KB_VIEW_ID } from '../common/constants.js';
import { isChatProviderConfigured } from './knowledge/knowledgeAdapters.js';
import { extractSources, injectSources, setStatus, parseFrontmatter, STATUS_ACTIVE, STATUS_PENDING } from './knowledge/frontmatter.js';
import { canonicalizeTitle, loadKbAliases } from './knowledge/kbAliases.js';
import { dirname } from '../../../../base/common/resources.js';
import { detectCommunities } from './knowledge/engine/communityDetection.js';
import type { CommunityEdge } from './knowledge/engine/communityDetection.js';
import { IKBSchema, loadKbSchema, buildSchemaPromptText, sanitizeKbTopic } from './knowledge/kbSchema.js';
import type { SchemaClassifyResult } from './knowledge/classifier.js';
import { buildFileBlockPrompt, parseFileBlocks } from '../common/fileBlockParser.js';
import { enrichWikilinks } from './knowledge/enrichWikilinks.js';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** Stage 2 系统提示词：让 LLM 按 FILE 块格式一次产出多个 Markdown 笔记，落入源文件所在目录。 */
const STAGE2_SYSTEM = '你是一位笔记撰写助手。依据规划将素材落盘为结构化 Markdown 笔记。'
	+ '每个文件必须包含 YAML frontmatter（type / title / created）。'
	+ '使用 ---FILE: 相对路径 --- 语法一次产出多个文件，路径相对于源文件所在目录。'
	+ '在相关笔记正文里，用 [[其他笔记的 title]] 语法引用本批次相关笔记，建立双链（关系图谱依赖这些链接）。'
	+ '只输出 FILE 块，不要额外解释。';

// ─── 主类 ────────────────────────────────────────────────────────────────────

export class KbImportController extends Disposable {

	// 静态常量
	private static readonly KB_ROOT_SUBPATH = '.vssaros/knowledge-base';
	static readonly KB_LIBRARY_SUBPATH = '库';
	static readonly KB_RAW_SUBPATH = 'raw';
	static readonly KB_NOTES_SUBPATH = '笔记';
	static readonly SYS_INDEX_FILES: readonly string[] = ['index.md', 'overview.md', 'insights.md', 'log.md', 'lint-report.md', 'dedup-report.md'];
	static readonly SKILL_DIR = '.kb-skills';
	/** P0-1 去抽象化门控：仅对这些派生知识类施加「≥2 来源才 active」约束。 */
	static readonly GATED_TYPES = new Set(['concept', 'comparison', 'synthesis', 'entity']);

	// 依赖注入
	constructor(
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
		private readonly _fileService: IFileService,
		private readonly _envService: INativeEnvironmentService,
		private readonly _storageService: IStorageService,
		private readonly _agentStudioService: IAgentStudioService,
		private readonly _viewsService: IViewsService,
		private readonly _editorService: IEditorService,
		private readonly _notificationService: INotificationService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();
	}

	/** P1-4：per-vault 互斥锁 */
	private static _vaultLocks = new Map<string, Promise<void>>();

	/** 与 knowledgeBaseView.ts 使用一致的 storage key。 */
	private static readonly STORAGE_KB_DIR = 'agentStudio.kb.kbDir';
	private static readonly STORAGE_VAULTS = 'agentStudio.kb.vaults';
	private static readonly STORAGE_ACTIVE = 'agentStudio.kb.active';

	/** 懒加载的 schema */
	private _kbSchema: IKBSchema | null = null;

	/** 最近一次「入口」阶段落盘的库文件 URI，供「抽取」阶段链式调用。 */
	private _lastLibUri: URI | undefined = undefined;

	// ─── 阶段 1：导入 ────────────────────────────────────────────────────────

	/**
	 * 阶段 1：「导入知识库」—— 立即落盘到「库」分区（按 schema 类型目录组织）。
	 *
	 * 1. schema 分类 → typeDir + topic
	 * 2. 落盘到 <vault>/库/<typeDir>/<topic>/<topic>-<YYYY-MM-DD>.md（同名不同内容追加 -2/-3）
	 * 3. 通知用户，打开 KB view
	 */
	/**
	 * @param vaultRootUri 可选：显式指定目标仓库根目录。
	 *        不传则自动从 KB 视图的活动仓库（vault）推导，若未配置则回退到存储根目录。
	 * @param sourceFile 可选：原始文件 URI（文件导入场景）。传入后库分区保存的是
	 *        **原始文件的副本**（保留原文件名与内容），而非 frontmatter 包裹的 .md；
	 *        落盘到 库/raw/ 下（库/raw/<原始文件名>），分类交由后续「构建为笔记」阶段处理。
	 */
	async handleFavoriteMessage(content: string, currentAgentId: string | null, vaultRootUri?: URI, sourceFile?: URI): Promise<boolean> {
		try {
			const vaultRoot = vaultRootUri ?? this._resolveKbRootUri();
			const libDir = this._resolveLibraryDir(vaultRoot);
			const notesDir = this._resolveNotesDir(vaultRoot);
			const { classifyResult } = await this._computeTargetCategory(content, libDir, notesDir);
			const typeDir = classifyResult.typeDir;
			const topic = classifyResult.topic;
			const savedPath = await this._withVaultLock(vaultRoot,
				() => sourceFile
					? this._saveFileToKbLibraryStructured(sourceFile, content, vaultRoot)
					: this._saveToKbLibraryStructured(content, currentAgentId, typeDir, topic, vaultRoot));
			this._lastLibUri = URI.file(savedPath);
			this._logService.info(`[KbImportController] imported to KB library [raw]: ${savedPath}`);
			await KbImportController.appendKbLog(this._fileService, this._resolveNotesDir(vaultRoot),
				`导入 → ${savedPath.split(/[\\/]/).pop() ?? savedPath}`);
			this._notificationService.notify({
				severity: Severity.Info,
				message: `已保存到知识库「库/raw」分区（${classifyResult.typeLabel}/${topic}）。可右键库文件「构建为笔记」生成结构化笔记。`,
				source: 'agent-chat-favorite',
			});
			// 通知 KB view 刷新文件树，确保新入库文件即时可见
			void this._agentStudioService.requestKbRefresh();
			void this._openKbViewAndNavigate(savedPath);
			return true;
		} catch (err) {
			this._logService.error('[KbImportController] KB library save failed:', err);
			// 弹出错误通知，避免用户看不到后台失败
			const errMsg = err instanceof Error ? err.message : String(err);
			const isCors = /CORS|Failed to fetch|net::ERR/i.test(errMsg);
			this._notificationService.notify({
				severity: Severity.Error,
				message: isCors
					? `导入知识库失败：LLM 请求被 CORS 拦截（${errMsg}）。请检查 Chat Provider 配置或网络代理。`
					: `导入知识库失败：${errMsg}`,
				source: 'agent-chat-favorite',
			});
			try { await this._writeLegacyFavorite(content); } catch { /* ignore */ }
			return false;
		}
	}

	/**
	 * 组合入口：「入口」(落盘到库) + 「抽取」(构建为结构化笔记)。
	 *
	 * 供聊天框 write_file 卡片、工作区文件右键「导入知识库」等一键操作调用：
	 * 先走 `handleFavoriteMessage` 落盘到「库」分区（阶段 1 入口），
	 * 再立即对刚落盘的库文件调用 `buildNotesFromLibrary` 生成笔记（阶段 2 抽取）。
	 *
	 * @param sourceFile 可选：原始文件 URI（文件导入场景）。传入后库分区保存原始文件副本
	 *        （保留原文件名），抽取阶段读取该副本生成结构化笔记。
	 * @returns 抽取阶段是否成功（入口失败时直接返回 false）。
	 */
	async importContentAndBuild(content: string, currentAgentId: string | null, vaultRootUri?: URI, sourceFile?: URI): Promise<boolean> {
		const entryOk = await this.handleFavoriteMessage(content, currentAgentId, vaultRootUri, sourceFile);
		if (!entryOk) { return false; }
		const libUri = this._lastLibUri;
		if (!libUri) { return true; } // 入口成功但没有可抽取的库文件，视为成功
		try {
			this._logService.info(`[KbImportController] starting stage2 buildNotes: ${libUri.fsPath}`);
			const notePath = await this.buildNotesFromLibrary(libUri, vaultRootUri);
			this._logService.info(`[KbImportController] stage2 buildNotes done, notes path: ${notePath ?? '(none)'}`);
			return notePath !== null;
		} catch (err) {
			this._logService.error('[KbImportController] extraction (build) failed:', err);
			this._notificationService.notify({
				severity: Severity.Warning,
				message: `内容已保存到知识库「库」分区，但自动构建笔记失败：${err instanceof Error ? err.message : String(err)}`,
				source: 'agent-chat-favorite',
			});
			return false;
		}
	}

	// ─── 阶段 2：构建笔记 ────────────────────────────────────────────────────

	/**
	 * 阶段 2：「构建为笔记」—— 双阶段 LLM（分析 + FILE 块生成）将库文件转为结构化笔记。
	 *
	 * P2-1 Stage 1：LLM 结构化分析（类型 / 主题 / 落盘路径规划）
	 * P2-2 Stage 2：LLM 按 FILE 块格式一次性产出多文件，确定性落盘
	 *
	 * 实例方法：由 nativeChatEditorPane 使用；自动从 `this` 获取服务依赖和 vault root。
	 */
	async buildNotesFromLibrary(libFileUri: URI, vaultRootUri?: URI): Promise<string | null> {
		return KbImportController._buildNoteCore(
			libFileUri,
			vaultRootUri ?? this._resolveKbRootUri(),
			this._fileService,
			this._configurationService,
			this._logService,
			this._notificationService,
			this._agentStudioService,
			this._requestService,
		);
	}

	/**
	 * 静态方法：由 knowledgeBaseView 使用，需要显式传入所有依赖和 vault root。
	 * vaultRootUri 必须提供（在 view 端取自活动仓库根目录）。
	 */
	static async buildNotesFromLibrary(
		libFileUri: URI,
		vaultRootUri: URI,
		deps: { fileService: IFileService; configService: IConfigurationService; logService: ILogService; notificationService: INotificationService; agentStudioService: IAgentStudioService; requestService?: IRequestService },
	): Promise<string | null> {
		return KbImportController._buildNoteCore(
			libFileUri,
			vaultRootUri,
			deps.fileService,
			deps.configService,
			deps.logService,
			deps.notificationService,
			deps.agentStudioService,
			deps.requestService,
		);
	}

	/** 核心构建逻辑（实例方法和静态方法共享）。 */
	private static async _buildNoteCore(
		libFileUri: URI,
		vaultRoot: URI,
		fileService: IFileService,
		configService: IConfigurationService,
		logService: ILogService,
		notificationService: INotificationService,
		agentStudioService: IAgentStudioService,
		requestService?: IRequestService,
	): Promise<string | null> {
		const libDir = URI.joinPath(vaultRoot, KbImportController.KB_LIBRARY_SUBPATH);

		if (!libFileUri.fsPath.toLowerCase().startsWith(libDir.fsPath.toLowerCase())) {
			logService.warn(`[KbImportController] buildNotes: not in library: ${libFileUri.fsPath}`);
			return null;
		}

		const cache = await KbImportController._readBuildCache(fileService, vaultRoot);
		if (cache[libFileUri.fsPath]) {
			notificationService.notify({ severity: Severity.Info, message: `已构建: ${cache[libFileUri.fsPath]}`, source: 'kb-build' });
			return cache[libFileUri.fsPath];
		}

		// lm 感知的前置判断：lm: 桥接 provider 已注册即可用，否则要求 BYOK provider 已配 key。
		const kbChatAvailable = (agentStudioService as unknown as { isKbChatProviderAvailable?: () => boolean }).isKbChatProviderAvailable?.()
			?? isChatProviderConfigured(configService);
		if (!kbChatAvailable) {
			notificationService.notify({ severity: Severity.Warning, message: '请先配置 Chat Provider。', source: 'kb-build' });
			return null;
		}

		const chatModel = await KbImportController._resolveKbChatModel(agentStudioService, configService, requestService);
		if (!chatModel) {
			notificationService.notify({ severity: Severity.Warning, message: '无法解析 Chat 模型（请检查 KB 模型配置）。', source: 'kb-build' });
			return null;
		}

		try {
			// 抽取结果写入源文件所在的库目录（与源文件同在 库/ 下，方便定位与管理）
			const outputDir = URI.joinPath(libFileUri, '..');
			const libContent = (await fileService.readFile(libFileUri)).value.toString();
			const schema = await KbImportController._getSchemaStatic(fileService, vaultRoot);
			const schemaText = buildSchemaPromptText(schema);
			const typeDirs = new Set(schema.types.map(t => t.dir)); // 方案A 平铺：用于剥掉 FILE 块路径中的类型目录前缀
			const dirCandidates = await KbImportController._listAllNoteSubdirs(fileService, libDir);
			const dirCandidateList = dirCandidates.length
				? dirCandidates.map(s => `  - ${s}`).join('\n')
				: '  (none)';

			// Stage 1：结构化分析
			const analysis = await KbImportController._runStage1Analysis(libContent, schemaText, dirCandidateList, chatModel, logService);

			// Stage 2：FILE 块格式一次性多文件生成（相对 outputDir）
			const formatHint = buildFileBlockPrompt(outputDir.fsPath);
			const genPrompt = [
				'## 结构化规划', analysis,
				'', '## Schema 类型定义', schemaText,
				'', '## 原始素材', libContent,
				'', '## 指令', '按下方 FILE 块格式，为规划出的每篇笔记输出一个 FILE 块。',
				'', formatHint,
			].join('\n');
			const gen = await chatModel.complete(STAGE2_SYSTEM, genPrompt, 0.3);
			const blocks = parseFileBlocks(gen, outputDir);
			let written: string[];
			if (blocks.length === 0) {
				// 诊断：记录模型原始输出开头，便于排查格式偏差（此前失败时无任何线索）。
				logService.warn(`[KbImportController] stage2 no FILE blocks parsed (output len=${gen.length}), head: ${gen.slice(0, 300).replace(/\s+/g, ' ')}`);
				// 兜底：模型未按 FILE 块格式输出时，将原始输出落为单篇笔记到源文件目录
				const libCat = KbImportController._parseLibCategory(libContent, libDir, libFileUri);
				const safeName = KbImportController._sanitizeFsName(libCat.topic) || '未命名';
				const salvaged = await KbImportController._salvageSingleNoteToDir(gen, safeName, outputDir, fileService);
				written = salvaged ? [salvaged] : [];
			} else {
				written = await KbImportController._writeFileBlocks(blocks, outputDir, vaultRoot, fileService, logService, typeDirs);
			}

			if (written.length === 0) {
				notificationService.notify({ severity: Severity.Warning, message: 'LLM 未生成可写笔记（请检查模型输出格式）。', source: 'kb-build' });
				return null;
			}

			// 构建结果留痕：成功路径此前完全静默（仅瞬时通知），排查「笔记是否生成」只能靠猜。
			logService.info(`[KbImportController] buildNotes wrote ${written.length} note(s): ${written.join('; ')}`);

			cache[libFileUri.fsPath] = written[0];
			await KbImportController._writeBuildCache(fileService, vaultRoot, cache);
			// 构造完整的库内相对路径作为双链 target（而非仅文件名）
			const relFromLib = KbImportController._relativeFromLib(libFileUri, libDir);
			await KbImportController._injectSourcesUnder(fileService, outputDir, relFromLib);
			// P2-2 确定性补链：对本次新写笔记扫描全库标题互链（零 LLM 成本），增强图谱连通性
			await KbImportController._enrichNewNotes(fileService, libDir, written, logService);
			await KbImportController.maintainKbNavigation(fileService, libDir);
			// P0-1 去抽象化门控：派生类笔记按 distinct sources 数决定 pending/active
			const gate = await KbImportController.applyDeabstractionGating(fileService, libDir);
			logService.info(`[KbImportController] de-abstraction gating: ${gate.active} active, ${gate.pending} pending`);
			agentStudioService.requestKbRefresh();
			notificationService.notify({ severity: Severity.Info, message: `笔记构建完成: ${written.join('; ')}`, source: 'kb-build' });
			return written[0];
		} catch (err) {
			logService.error('[KbImportController] buildNotesFromLibrary failed:', err);
			return null;
		}
	}

	/** 批量构建所有未处理的库文件（实例方法）。 */
	async buildAllPendingNotes(vaultRootUri?: URI): Promise<number> {
		return KbImportController._buildAllPendingCore(
			vaultRootUri ?? this._resolveKbRootUri(),
			this._fileService,
			this._configurationService,
			this._logService,
			this._notificationService,
			this._agentStudioService,
			this._requestService,
		);
	}

	/** 批量构建（静态方法，供 knowledgeBaseView 使用）。 */
	static async buildAllPendingNotes(
		vaultRootUri: URI,
		deps: { fileService: IFileService; configService: IConfigurationService; logService: ILogService; notificationService: INotificationService; agentStudioService: IAgentStudioService; requestService?: IRequestService },
	): Promise<number> {
		return KbImportController._buildAllPendingCore(
			vaultRootUri,
			deps.fileService,
			deps.configService,
			deps.logService,
			deps.notificationService,
			deps.agentStudioService,
			deps.requestService,
		);
	}

	private static async _buildAllPendingCore(
		vaultRoot: URI,
		fileService: IFileService,
		configService: IConfigurationService,
		logService: ILogService,
		notificationService: INotificationService,
		agentStudioService: IAgentStudioService,
		requestService?: IRequestService,
	): Promise<number> {
		const libDir = URI.joinPath(vaultRoot, KbImportController.KB_LIBRARY_SUBPATH);
		const cache = await KbImportController._readBuildCache(fileService, vaultRoot);
		const libFiles = await KbImportController._collectMdFiles(fileService, libDir);
		const pending = libFiles.filter(f => !cache[f.fsPath]);
		if (pending.length === 0) { notificationService.notify({ severity: Severity.Info, message: '所有库文件已构建。', source: 'kb-build' }); return 0; }
		notificationService.notify({ severity: Severity.Info, message: `批量构建 ${pending.length} 篇笔记...`, source: 'kb-build' });
		let built = 0;
		for (const f of pending) {
			if (await KbImportController._buildNoteCore(f, vaultRoot, fileService, configService, logService, notificationService, agentStudioService, requestService)) {
				built++;
			}
		}
		// P0-1 去抽象化门控（全库统一收敛一次）
		const gate = await KbImportController.applyDeabstractionGating(fileService, libDir);
		logService.info(`[KbImportController] de-abstraction gating (batch): ${gate.active} active, ${gate.pending} pending`);
		notificationService.notify({ severity: Severity.Info, message: `完成: ${built}/${pending.length}`, source: 'kb-build' });
		return built;
	}

	// ─── 分类计算（schema 驱动）────────────────────────────────────────────────

	private async _getSchema(): Promise<IKBSchema> {
		if (!this._kbSchema) { this._kbSchema = await KbImportController._getSchemaStatic(this._fileService, this._resolveKbRootUri()); }
		return this._kbSchema;
	}

	private static async _getSchemaStatic(fileService: IFileService, vaultRoot: URI): Promise<IKBSchema> {
		return loadKbSchema(fileService, vaultRoot);
	}

	private async _computeTargetCategory(content: string, libDir: URI, notesDir: URI): Promise<{
		category: string; type: string; topic: string; candidates: string[]; classifyResult: SchemaClassifyResult;
	}> {
		const schema = await this._getSchema();
		const candidates = await this._collectCategoryCandidates(libDir, notesDir);
		// P1 同义归一：加载 aliases.json 改善既有目录匹配（让「GC机制」「垃圾回收」等归一到同一目录）
		const aliases = await loadKbAliases(this._fileService, dirname(libDir));
		const classifyResult = await this._classifyWithSchema(content, schema, candidates);
		// 清洗分类产出的 topic（去 HTML 标签 / Markdown 记号 / 非法文件名字符）；
		// 无效（纯标记/符号）时置空，交给既有目录匹配与「未分类」兜底。
		const cleanTopic = sanitizeKbTopic(classifyResult.topic ?? '');
		const matchedTopic = (cleanTopic ? this._matchCategory(cleanTopic, candidates, aliases.aliases) : null)
			?? this._matchCategory(content, candidates, aliases.aliases);

		if (matchedTopic) {
			return { category: matchedTopic, type: matchedTopic.split('/')[0], topic: matchedTopic, candidates, classifyResult };
		}
		const topic = cleanTopic ?? '未分类';
		return {
			category: `${classifyResult.typeDir}/${topic}`,
			type: classifyResult.typeDir,
			topic,
			candidates,
			classifyResult,
		};
	}

	private async _classifyWithSchema(content: string, schema: IKBSchema, candidates?: string[]): Promise<SchemaClassifyResult> {
		const { classifyContentViaSchema: cfn, safeSchemaFallback } = await import('./knowledge/classifier.js');
		try {
			// 统一经 AgentStudioService.createKbChatModel：优先 AgentOS provider 传输
			// （lm: 桥接 provider 无 CORS、鉴权由 provider 托管）。
			const chatModel = (this._agentStudioService as unknown as { createKbChatModel?: () => IChatModel | null }).createKbChatModel?.();
			if (chatModel) {
				// 传入既有主题目录，引导 LLM 优先复用（避免同主题分裂出多目录）
				return await cfn(chatModel, schema, content, undefined, candidates);
			}
		} catch { /* fall through to safe fallback */ }
		// LLM 不可用时安全降级默认类型（misc + 未分类），不做关键词猜测（对齐 llm_wiki）。
		return safeSchemaFallback(schema);
	}

	private async _collectCategoryCandidates(libDir: URI, notesDir: URI): Promise<string[]> {
		const schema = await this._getSchema();
		const typeDirs = new Set(schema.types.map(t => t.dir));
		const set = new Set<string>();
		const collect = async (dir: URI): Promise<void> => {
			try {
				const stat = await this._fileService.resolve(dir);
				if (!stat.children) { return; }
				for (const child of stat.children) {
					if (child.isDirectory && !child.name.startsWith('.') && typeDirs.has(child.name)) {
						set.add(child.name);
						try {
							const sub = await this._fileService.resolve(child.resource);
							if (sub.children) for (const cc of sub.children) {
								if (cc.isDirectory && !cc.name.startsWith('.')) set.add(`${child.name}/${cc.name}`);
							}
						} catch { /* ignore */ }
					}
				}
			} catch { /* ignore */ }
		};
		await Promise.all([collect(libDir), collect(notesDir)]);
		return [...set].sort();
	}

	private _matchCategory(query: string, candidates: string[], aliasMap?: Record<string, string[]>): string | null {
		if (!query || !candidates.length) { return null; }
		// 统一分词（query 和 candidate 均用 / - _ 空格 分割，修复此前不对称导致连字符 topic 永远不命中）
		const DELIM = /[\s\/\-_]+/;
		const tokens = new Set<string>();
		for (const seg of query.split(DELIM)) {
			const s = seg.trim().toLowerCase();
			if (s.length >= 2) { tokens.add(s); }
		}
		let best: string | null = null;
		let bestScore = 0;
		for (const c of candidates) {
			const cTokens = c.split(DELIM).map(t => t.toLowerCase()).filter(t => t.length >= 2);
			let score = 0;
			// 精确 token 匹配（原逻辑）
			for (const ct of cTokens) { if (tokens.has(ct)) { score += 2; } }
			// 子串包含评分（解决「GC机制」vs「GC」部分匹配问题）
			for (const ct of cTokens) {
				for (const t of tokens) { if (t.includes(ct) || ct.includes(t)) { score += 1; } }
			}
			// 同义归一加分（alias 辅助：若 query 的 canonical 与某 candidate 的 canonical 一致，强加分）
			if (aliasMap && Object.keys(aliasMap).length > 0) {
				try {
					const qCanon = canonicalizeTitle(query, { aliases: aliasMap });
					const cCanon = canonicalizeTitle(c.split('/').pop() ?? c, { aliases: aliasMap });
					if (qCanon && cCanon && qCanon === cCanon) { score += 10; }
				} catch { /* 归一失败不阻断 */ }
			}
			if (score > bestScore) { bestScore = score; best = c; }
		}
		// 阈值门控：至少有 1 个精确 token 匹配或 2 个子串匹配才认为命中（避免弱误匹配）
		return bestScore >= 2 ? best : null;
	}

	// ─── 库文件落盘 ───────────────────────────────────────────────────────────

	private async _saveToKbLibraryStructured(content: string, currentAgentId: string | null, typeDir: string, topic: string, vaultRoot?: URI): Promise<string> {
		const root = vaultRoot ?? this._resolveKbRootUri();
		const libDir = URI.joinPath(root, KbImportController.KB_LIBRARY_SUBPATH);
		// 清理 topic 中的非法文件名字符（Windows: < > : " / \ | ? *）并限长
		const safeTopic = KbImportController._sanitizeFsName(topic);
		const safeTypeDir = KbImportController._sanitizeFsName(typeDir);
		// 导入的原始材料统一落到 <vault>/库/raw/（不再按 schema 分 typeDir/topic 子目录），
		// 分类交由后续「构建为笔记」阶段处理；raw 即未加工的原始落盘区。
		const targetDir = URI.joinPath(libDir, KbImportController.KB_RAW_SUBPATH);
		await this._fileService.createFolder(targetDir);
		const now = new Date();
		const dateStr = now.toISOString().slice(0, 10);
		const hash = Math.abs(content.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)).toString(36);
		const dedupKey = `${hash}:${content.length}`;
		const cacheUri = URI.joinPath(root, '.kb-ingest-cache.json');
		const cache = await this._readIngestCache(cacheUri);
		const dedupHit = await this._handleDedupHit(dedupKey, targetDir, cacheUri, cache);
		if (dedupHit) { return dedupHit; }
		// 语义可读文件名：<topic>-<YYYY-MM-DD>.md（hash 仅用于去重，不进文件名）；
		// 同名不同内容追加 -2/-3 后缀（同内容由上方去重缓存拦截：返回/迁移既有文件）。
		const stem = `${safeTopic || 'untitled'}-${dateStr}`;
		let libUri = URI.joinPath(targetDir, `${stem}.md`);
		for (let i = 2; await this._existsQuiet(libUri); i++) {
			libUri = URI.joinPath(targetDir, `${stem}-${i}.md`);
		}
		const md = [
			'---',
			`title: "聊天消息导入 - ${dateStr}"`,
			`date: ${now.toISOString()}`,
			`source: agent-chat-import`,
			`agentid: ${currentAgentId ?? 'unknown'}`,
			`type: ${safeTypeDir}`,
			`topic: ${safeTopic}`,
			`imported_at: ${now.toISOString()}`,
			'---', '', content.trimEnd(), '',
		].join('\n');
		if (!this._isWithinVault(libUri, root)) {
			throw new Error(`[KbImportController] refused to write outside vault: ${libUri.fsPath}`);
		}
		await this._fileService.writeFile(libUri, VSBuffer.fromString(md));
		cache[dedupKey] = libUri.fsPath;
		await this._writeIngestCache(cacheUri, cache);
		return libUri.fsPath;
	}

	/**
	 * 去重缓存命中处理：缓存文件存在则返回其路径（若所在目录与本次分类目录不同，
	 * 例如早期误分类到垃圾目录，则迁移到新分类目录、更新缓存并清理旧空目录）；
	 * 缓存文件已被删除时返回 undefined（调用方继续走新写入）。
	 */
	private async _handleDedupHit(dedupKey: string, targetDir: URI, cacheUri: URI, cache: Record<string, string>): Promise<string | undefined> {
		const cachedPath = cache[dedupKey];
		if (!cachedPath) { return undefined; }
		try {
			await this._fileService.readFile(URI.file(cachedPath));
		} catch { return undefined; } // 缓存文件已被删除，继续重新写入
		const fileBase = cachedPath.split(/[\\/]/).pop()!;
		const relocatedUri = URI.joinPath(targetDir, fileBase);
		if (!KbImportController._sameFsPath(cachedPath, relocatedUri.fsPath)) {
			try {
				await this._fileService.move(URI.file(cachedPath), relocatedUri, true);
				cache[dedupKey] = relocatedUri.fsPath;
				await this._writeIngestCache(cacheUri, cache);
				this._logService.info(`[KbImportController] relocated cached lib file: ${cachedPath} -> ${relocatedUri.fsPath}`);
				await KbImportController._removeDirIfEmpty(this._fileService, URI.file(cachedPath.slice(0, cachedPath.length - fileBase.length - 1)));
				return relocatedUri.fsPath;
			} catch (moveErr) {
				this._logService.warn(`[KbImportController] relocate cached lib file failed, keep old path: ${moveErr}`);
			}
		}
		return cachedPath;
	}

	/**
	 * 文件导入落盘：将原始文件**原样复制**到 <vault>/库/raw/<原始文件名>，
	 * 保留文件名与内容不变（不包 frontmatter——分类交由后续「构建为笔记」阶段处理）。
	 * 同名不同内容时自动追加 -2/-3 后缀；同内容命中去重缓存时按需迁移目录。
	 */
	private async _saveFileToKbLibraryStructured(sourceFile: URI, content: string, vaultRoot: URI): Promise<string> {
		const root = vaultRoot;
		const libDir = URI.joinPath(root, KbImportController.KB_LIBRARY_SUBPATH);
		const targetDir = URI.joinPath(libDir, KbImportController.KB_RAW_SUBPATH);
		await this._fileService.createFolder(targetDir);
		const hash = Math.abs(content.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)).toString(36);
		const dedupKey = `${hash}:${content.length}`;
		const cacheUri = URI.joinPath(root, '.kb-ingest-cache.json');
		const cache = await this._readIngestCache(cacheUri);
		const dedupHit = await this._handleDedupHit(dedupKey, targetDir, cacheUri, cache);
		if (dedupHit) { return dedupHit; }

		// 原始文件名（保留扩展名）；同名不同内容时追加 -2/-3 后缀
		const origName = KbImportController._sanitizeFsName(sourceFile.fsPath.split(/[\\/]/).pop() ?? 'import.bin');
		const dotIdx = origName.lastIndexOf('.');
		const stem = dotIdx > 0 ? origName.slice(0, dotIdx) : origName;
		const ext = dotIdx > 0 ? origName.slice(dotIdx) : '';
		let targetUri = URI.joinPath(targetDir, origName);
		for (let i = 2; await this._existsQuiet(targetUri); i++) {
			targetUri = URI.joinPath(targetDir, `${stem}-${i}${ext}`);
		}
		if (!this._isWithinVault(targetUri, root)) {
			throw new Error(`[KbImportController] refused to write outside vault: ${targetUri.fsPath}`);
		}
		// 原样复制（读写字节，保持文件内容与命名不变）
		const bytes = await this._fileService.readFile(sourceFile);
		await this._fileService.writeFile(targetUri, bytes.value);
		cache[dedupKey] = targetUri.fsPath;
		await this._writeIngestCache(cacheUri, cache);
		return targetUri.fsPath;
	}

	/** 静默存在性检查（resolve 抛错即不存在）。 */
	private async _existsQuiet(uri: URI): Promise<boolean> {
		try { await this._fileService.resolve(uri); return true; } catch { return false; }
	}

	/** 文件系统路径等价比较（忽略斜杠差异、尾部分隔符与大小写）。 */
	private static _sameFsPath(a: string, b: string): boolean {
		const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		return norm(a) === norm(b);
	}

	/** 目录为空时删除（用于迁移后清理旧的空分类目录）；非空或出错时静默忽略。 */
	private static async _removeDirIfEmpty(fileService: IFileService, dir: URI): Promise<void> {
		try {
			const stat = await fileService.resolve(dir);
			if (stat.isDirectory && (stat.children?.length ?? 0) === 0) {
				await fileService.del(dir);
			}
		} catch { /* ignore */ }
	}

	/**
	 * 从库文件解析分类（type/topic），用于兜底落笔记的分类目录：
	 *   - 消息导入：库文件为 frontmatter 包裹的 .md → 从 frontmatter 的 type/topic 读；
	 *   - 文件导入：库文件为原始文件副本（无 frontmatter）→ 从目录路径推导
	 *     （库/<typeDir>/<topic>/<原始文件名>，分类信息由入库时的目录承载）。
	 */
	private static _parseLibCategory(libContent: string, libDir?: URI, libFileUri?: URI): { typeDir: string; topic: string } {
		const fm = libContent.match(/^---\n([\s\S]*?)\n---/);
		const pick = (key: string): string | undefined => {
			const m = fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
			return m?.[1].trim();
		};
		const fmType = pick('type');
		const fmTopic = pick('topic');
		if (fmType || fmTopic) {
			return { typeDir: fmType ?? 'note', topic: sanitizeKbTopic(fmTopic ?? '') ?? '未分类' };
		}
		if (libDir && libFileUri) {
			const rel = libFileUri.path.substring(libDir.path.length).replace(/^\/+/, '');
			const segs = rel.split('/').filter(s => !!s);
			if (segs.length >= 3) {
				return {
					typeDir: decodeURIComponent(segs[0]),
					topic: sanitizeKbTopic(decodeURIComponent(segs[1])) ?? '未分类',
				};
			}
		}
		return { typeDir: 'note', topic: '未分类' };
	}

	/**
	 * 兜底（库目录版）：将原始输出落为 <outputDir>/<safeName>.md（不附加 typeDir 前缀，
	 * 因 outputDir 的路径已暗示所属类型）。内容过短（<100 字符）返回 undefined。
	 */
	private static async _salvageSingleNoteToDir(raw: string, safeName: string, outputDir: URI, fileService: IFileService): Promise<string | undefined> {
		const body = raw
			.replace(/^```(?:markdown|md|text)?\s*\n/i, '')
			.replace(/\n```\s*$/m, '')
			.trim();
		if (body.length < 100) { return undefined; }
		await fileService.createFolder(outputDir);
		const fileUri = URI.joinPath(outputDir, `${KbImportController._sanitizeFsName(safeName) || '未命名'}.md`);
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const content = body.startsWith('---')
			? body
			: ['---', 'type: note', `title: ${safeName}`, `created: ${date}`, '---', '', body].join('\n');
		await fileService.writeFile(fileUri, VSBuffer.fromString(content));
		return fileUri.fsPath;
	}

	// ─── 构建缓存 ─────────────────────────────────────────────────────────────

	private static async _readBuildCache(fileService: IFileService, vaultRoot: URI): Promise<Record<string, string>> {
		try { return JSON.parse((await fileService.readFile(URI.joinPath(vaultRoot, '.kb-build-cache.json'))).value.toString()); } catch { return {}; }
	}

	private static async _writeBuildCache(fileService: IFileService, vaultRoot: URI, cache: Record<string, string>): Promise<void> {
		try { await fileService.writeFile(URI.joinPath(vaultRoot, '.kb-build-cache.json'), VSBuffer.fromString(JSON.stringify(cache, null, 2))); } catch { /* ignore */ }
	}

	private static async _listAllNoteSubdirs(fileService: IFileService, notesDir: URI): Promise<string[]> {
		const set = new Set<string>();
		try {
			const st = await fileService.resolve(notesDir);
			if (st.children) {
				for (const c of st.children) {
					if (c.isDirectory && !c.name.startsWith('.')) {
						set.add(c.name);
						try {
							const sub = await fileService.resolve(c.resource);
							if (sub.children) for (const cc of sub.children) {
								if (cc.isDirectory && !cc.name.startsWith('.')) set.add(`${c.name}/${cc.name}`);
							}
						} catch { /* ignore */ }
					}
				}
			}
		} catch { /* ignore */ }
		return [...set].sort();
	}

	// ─── 路径解析 ─────────────────────────────────────────────────────────────

	private _resolveKbRootUri(): URI {
		// 获取基础根目录（用户可在 KB 视图设置面板中配置）
		const customRoot = this._storageService.get(KbImportController.STORAGE_KB_DIR, StorageScope.APPLICATION);
		const baseRoot = (typeof customRoot === 'string' && customRoot.trim())
			? URI.file(customRoot.trim())
			: URI.joinPath(this._envService.userHome, ...KbImportController.KB_ROOT_SUBPATH.split('/'));

		// 如果 KB 视图中有活动仓库（vault），导入应该落到该仓库下
		try {
			const activeId = this._storageService.get(KbImportController.STORAGE_ACTIVE, StorageScope.APPLICATION);
			if (typeof activeId === 'string' && activeId.trim()) {
				const raw = this._storageService.get(KbImportController.STORAGE_VAULTS, StorageScope.APPLICATION);
				if (typeof raw === 'string') {
					const vaults: { id: string; customPath?: string }[] = JSON.parse(raw);
					const activeVault = vaults.find(v => v.id === activeId);
					if (activeVault?.customPath) {
						return URI.file(activeVault.customPath);
					}
					// 默认 vault 路径：baseRoot/vaultId
					if (activeVault) {
						return URI.joinPath(baseRoot, activeId);
					}
				}
			}
		} catch { /* storage parse error → 回退到 baseRoot */ }

		return baseRoot;
	}

	private _resolveLibraryDir(vaultRootUri?: URI): URI {
		return URI.joinPath(vaultRootUri ?? this._resolveKbRootUri(), KbImportController.KB_LIBRARY_SUBPATH);
	}

	private _resolveNotesDir(vaultRootUri?: URI): URI {
		return URI.joinPath(vaultRootUri ?? this._resolveKbRootUri(), KbImportController.KB_NOTES_SUBPATH);
	}

	private _isWithinVault(uri: URI, vaultRoot: URI): boolean {
		return uri.fsPath.toLowerCase().startsWith(vaultRoot.fsPath.toLowerCase());
	}

	/** 清理文件系统非法字符（Windows: < > : " / \ | ? * 和控制字符），限长 80。 */
	private static _sanitizeFsName(name: string): string {
		const cleaned = (name ?? '')
			.replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // 非法字符
			.replace(/\s+/g, ' ')                   // 合并空白
			.trim()
			.replace(/[.]+$/g, '');                 // 去尾部点号（Windows 不允许）
		const out = cleaned || 'untitled';
		return out.length > 80 ? out.slice(0, 80) : out;
	}

	/**
	 * 计算库文件相对于库根目录的路径，返回 `库/<相对路径>` 格式的双链引用。
	 * 例如 libDir= `/vault/库`, file= `/vault/库/概念/UE5-GC/GC_Mechanism.html`
	 * → `库/概念/UE5-GC/GC_Mechanism.html`。
	 */
	private static _relativeFromLib(libFileUri: URI, libDir: URI): string {
		const libPrefix = libDir.fsPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		const filePath = libFileUri.fsPath.replace(/\\/g, '/').toLowerCase();
		const rel = filePath.startsWith(libPrefix + '/') ? filePath.substring(libPrefix.length + 1) : filePath;
		return `库/${rel}`;
	}

	// ─── vault 锁 ─────────────────────────────────────────────────────────────

	private async _withVaultLock(vaultRoot: URI, fn: () => Promise<string>): Promise<string> {
		const key = vaultRoot.fsPath.toLowerCase();
		while (KbImportController._vaultLocks.has(key)) {
			await KbImportController._vaultLocks.get(key);
		}
		let resolve: () => void;
		const promise = new Promise<void>(r => { resolve = r; });
		KbImportController._vaultLocks.set(key, promise);
		try {
			return await fn();
		} finally {
			resolve!();
			KbImportController._vaultLocks.delete(key);
		}
	}

	// ─── 双阶段 LLM 辅助（P2-1 / P2-2）────────────────────────────────────

	/** 解析 KB Chat Model。 */
	private static async _resolveKbChatModel(agentStudioService: IAgentStudioService, configService: IConfigurationService, requestService?: IRequestService): Promise<IChatModel | null> {
		// 优先 AgentStudioService.createKbChatModel（AgentOS provider 传输，lm: 桥接无 CORS）。
		try {
			const chatModel = (agentStudioService as unknown as { createKbChatModel?: () => IChatModel | null }).createKbChatModel?.();
			if (chatModel) { return chatModel; }
		} catch { /* fall through to legacy path */ }
		try {
			const kb = (agentStudioService as any)._resolveKbChatModel?.();
			if (!kb) { return null; }
			const { resolveChatModel } = await import('./knowledge/knowledgeAdapters.js');
			return resolveChatModel(configService, { providerId: kb.providerId, modelId: kb.modelId }, requestService);
		} catch { return null; }
	}

	/** Stage 1：LLM 结构化分析（主题 / 类型 / 路径规划）。 */
	private static async _runStage1Analysis(
		content: string, schemaText: string, candidates: string,
		chatModel: IChatModel, logService: ILogService,
	): Promise<string> {
		const system = '你是一位知识库架构师，擅长将零散素材结构化为 wiki 笔记。只输出中文纯文本分析。';
		const userPrompt = [
			'## KB Schema（笔记类型定义，落盘路径请优先使用这些 typeDir）',
			schemaText,
			'',
			'## 现有笔记目录（优先复用，含用户自建目录如 学习/工作/生活）',
			candidates || '  (none)',
			'',
			'## 待结构化素材',
			content,
			'',
			'请输出一份结构化规划（中文，纯文本），包括：',
			'1. 内容主题与核心要点（3-5 条）',
			'2. 适用的笔记类型（必须来自 KB Schema 的 type，不要自造类型）',
			'3. 建议落盘路径（优先复用现有目录；若无匹配则按 schema 的 <typeDir>/<topic> 新建）',
			'4. 将素材拆分为几篇笔记，每篇的标题与大纲',
		].join('\n');
		try {
			return await chatModel.complete(system, userPrompt, 0.4);
		} catch (e) {
			logService.warn('[KbImportController] stage1 analysis failed, proceeding without analysis:', e);
			return '';
		}
	}

	/** Stage 2：解析 FILE 块并确定性落盘到笔记分区（平铺：剥掉类型子目录前缀；同批次同名自动改名防覆盖）。 */
	private static async _writeFileBlocks(
		blocks: { path: string; content: string }[],
		notesDir: URI,
		vaultRoot: URI,
		fileService: IFileService,
		logService: ILogService,
		typeDirs?: ReadonlySet<string>,
	): Promise<string[]> {
		const written: string[] = [];
		const isWithin = (uri: URI) => uri.fsPath.toLowerCase().startsWith(vaultRoot.fsPath.toLowerCase());
		const used = new Set<string>(); // 同批次已用路径
		for (const b of blocks) {
			let rel = (b.path || '').replace(/^[\\/]+/, '');
			rel = rel.replace(/^笔记[\\/]/i, '').replace(/^notes[\\/]/i, '');
			if (!rel) { continue; }
			const segs = rel.split(/[\\/]+/).filter(s => s && s !== '.' && s !== '..');
			if (segs.length === 0) { continue; }
			// 方案A 平铺：首段是 schema 类型目录则剥掉（type 只留 frontmatter，不再嵌套类型子目录）
			if (typeDirs && segs.length > 1 && typeDirs.has(segs[0])) { segs.shift(); }
			const parentSegs = segs.slice(0, -1);
			const filename = segs[segs.length - 1];
			const stem = filename.replace(/\.md$/i, '');
			const ext = filename.slice(stem.length);
			let targetUri = URI.joinPath(notesDir, ...segs);
			if (!isWithin(targetUri)) { continue; }
			// 同批次同名冲突：自动改名 xxx_2.md，避免平铺后同名不同类笔记互相覆盖
			let finalName = filename;
			let n = 2;
			while (used.has(targetUri.toString())) {
				finalName = `${stem}_${n}${ext}`;
				targetUri = URI.joinPath(notesDir, ...parentSegs, finalName);
				n++;
			}
			used.add(targetUri.toString());
			try {
				const parentUri = URI.joinPath(notesDir, ...parentSegs);
				await fileService.createFolder(parentUri);
				await fileService.writeFile(targetUri, VSBuffer.fromString(b.content ?? ''));
				written.push(targetUri.fsPath);
			} catch (e) {
				logService.warn('[KbImportController] writeFileBlock failed:', e);
			}
		}
		return written;
	}

	private async _readIngestCache(uri: URI): Promise<Record<string, string>> {
		try { return JSON.parse((await this._fileService.readFile(uri)).value.toString()); } catch { return {}; }
	}

	private async _writeIngestCache(uri: URI, cache: Record<string, string>): Promise<void> {
		try { await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(cache, null, 2))); } catch { /* ignore */ }
	}

	private async _writeLegacyFavorite(content: string): Promise<void> {
		// 降级兜底：写入本地备份文件
		const dir = URI.joinPath(this._envService.userHome, '.vssaros', 'favorites');
		await this._fileService.createFolder(dir);
		const ts = Date.now();
		await this._fileService.writeFile(
			URI.joinPath(dir, `favorite_${ts}.md`),
			VSBuffer.fromString(content)
		);
	}

	private static async _injectSourcesUnder(fileService: IFileService, targetDir: URI, sourceRel: string): Promise<void> {
		try {
			const all = await KbImportController._collectMdFiles(fileService, targetDir);
			for (const f of all) {
				try {
					const raw = (await fileService.readFile(f)).value.toString();
					if (raw.includes(sourceRel)) { continue; }
					const refLink = `[[${sourceRel}]]`;
					const refBase = sourceRel.split(/[\\/]/).pop() || sourceRel;
					const { content: updated, changed } = injectSources(raw, refLink, refBase);
					if (changed) {
						await fileService.writeFile(f, VSBuffer.fromString(updated));
					}
				} catch { /* skip */ }
			}
		} catch { /* ignore */ }
	}

	/** P2-2 确定性补链：对本次新写笔记扫描全库标题，把整词出现的其他笔记标题包裹为 [[标题]]。 */
	private static async _enrichNewNotes(
		fileService: IFileService,
		allNotesDir: URI,
		writtenPaths: string[],
		logService: ILogService,
	): Promise<void> {
		if (writtenPaths.length === 0) { return; }
		try {
			const allNotes = await KbImportController._collectMdFiles(fileService, allNotesDir);
			const targetNotes = writtenPaths.map(p => URI.file(p));
			const results = await enrichWikilinks(fileService, targetNotes, allNotes);
			if (results.length > 0) {
				const total = results.reduce((a, r) => a + r.added.length, 0);
				logService.info(`[KbImportController] enrichWikilinks: ${results.length} note(s) enriched, ${total} link(s) added`);
			}
		} catch (e) {
			logService.warn('[KbImportController] enrichWikilinks failed:', e);
		}
	}

	private async _openKbViewAndNavigate(filePath: string): Promise<void> {
		try {
			void this._viewsService.openView(AGENT_STUDIO_KB_VIEW_ID, true);
			const uri = URI.file(filePath);
			void this._editorService.openEditor({ resource: uri, options: { pinned: true, preserveFocus: true } });
		} catch (err) { this._logService.warn(`[KbImportController] _openKbViewAndNavigate failed: ${err}`); }
	}

	// ─── 静态方法：导航维护 ──────────────────────────────────────────────────

	/** 统一维护入口：index + overview + insights */
	static async maintainKbNavigation(fileService: IFileService, notesDir: URI): Promise<void> {
		await Promise.all([
			KbImportController.maintainKbIndex(fileService, notesDir),
			KbImportController.maintainKbOverview(fileService, notesDir),
		]);
		await KbImportController.maintainKbInsights(fileService, notesDir);
	}

	static async maintainKbIndex(fileService: IFileService, notesDir: URI): Promise<void> {
		const notes = await KbImportController._collectMdFiles(fileService, notesDir, KbImportController.SYS_INDEX_FILES);
		const groups = new Map<string, { rel: string; name: string }[]>();
		const root = notesDir.fsPath.replace(/\\/g, '/');
		for (const n of notes) {
			const p = n.fsPath.replace(/\\/g, '/');
			const rel = p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
			const relNoExt = rel.replace(/\.md$/i, '');
			const segs = relNoExt.split('/');
			const dirType = segs.length > 1 ? segs[0] : '(root)';
			const name = segs[segs.length - 1];
			const type = await KbImportController._readNoteFrontmatterType(fileService, n) || dirType;
			if (!groups.has(type)) { groups.set(type, []); }
			groups.get(type)!.push({ rel: relNoExt, name });
		}
		const types = [...groups.keys()].sort();
		const out: string[] = [
			'# 知识库索引', '',
			'> 按 frontmatter `type` 语义分组。请勿手改。', '',
			'- 高层导航：[[overview]]　·　图谱洞察：[[insights]]', '',
		];
		for (const t of types) {
			out.push(`## ${t}`);
			for (const it of groups.get(t)!.sort((a, b) => a.rel.localeCompare(b.rel))) {
				out.push(`- [[${it.rel}|${it.name}]]`);
			}
			out.push('');
		}
		const indexUri = URI.joinPath(notesDir, 'index.md');
		await KbImportController._writeIfChanged(fileService, indexUri, out.join('\n'));
	}

	static async maintainKbOverview(fileService: IFileService, notesDir: URI): Promise<void> {
		const notes = await KbImportController._collectMdFiles(fileService, notesDir, KbImportController.SYS_INDEX_FILES);
		const root = notesDir.fsPath.replace(/\\/g, '/');
		const typeStats = new Map<string, { count: number; topics: Map<string, number> }>();
		let total = 0;
		for (const n of notes) {
			const p = n.fsPath.replace(/\\/g, '/');
			const rel = p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
			const relNoExt = rel.replace(/\.md$/i, '');
			const segs = relNoExt.split('/');
			const dirType = segs.length > 1 ? segs[0] : '(root)';
			const topic = segs.length > 2 ? segs[1] : '(直接)';
			const type = await KbImportController._readNoteFrontmatterType(fileService, n) || dirType;
			total++;
			let s = typeStats.get(type);
			if (!s) { s = { count: 0, topics: new Map() }; typeStats.set(type, s); }
			s.count++;
			s.topics.set(topic, (s.topics.get(topic) ?? 0) + 1);
		}
	const types = [...typeStats.keys()].sort();
	const out: string[] = [
		'# 知识库总览', '',
		'> 按 frontmatter `type` 语义分组。全量见 [[index]]，图谱洞察见 [[insights]]。', '',
		`> 共 **${total}** 篇笔记，**${types.length}** 个类型。`, '',
	];
		for (const t of types) {
			const s = typeStats.get(t)!;
			out.push(`## ${t}（${s.count} 篇）`);
			const topics = [...s.topics.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
			for (const [tp, cnt] of topics) {
				const link = tp === '(直接)' ? `[[index#${t}]]` : `[[${t}/${tp}]]`;
				out.push(`- ${tp}：${cnt} 篇 → ${link}`);
			}
			out.push('');
		}
		const overviewUri = URI.joinPath(notesDir, 'overview.md');
		await KbImportController._writeIfChanged(fileService, overviewUri, out.join('\n'));
	}

	static async maintainKbInsights(fileService: IFileService, notesDir: URI): Promise<void> {
		const notes = await KbImportController._collectMdFiles(fileService, notesDir, KbImportController.SYS_INDEX_FILES);
		if (notes.length === 0) {
			const empty = [
				'# 知识图谱洞察', '',
				'> 暂无笔记数据，导入消息后自动生成。', '',
			].join('\n');
			const insightsUri = URI.joinPath(notesDir, 'insights.md');
			await KbImportController._writeIfChanged(fileService, insightsUri, empty);
			return;
		}

		// 收集 wikilink 边 → Louvain 社区检测
		const nodes = new Set<string>();
		const edges: CommunityEdge[] = [];
		for (const n of notes) {
			try {
				const raw = (await fileService.readFile(n)).value.toString();
				const titleMatch = raw.match(/^title:\s*(.+)$/m);
				const nodeName = titleMatch?.[1]?.trim?.()?.replace(/^["']|["']$/g, '') || n.fsPath.split(/[\\/]/).pop()?.replace(/\.md$/, '') || 'unknown';
				nodes.add(nodeName);
				const wlMatches = raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
				for (const m of wlMatches) {
					const target = m[1].split('/').pop() || m[1];
					// 与 KbLinkGraph 口径对齐：仅当 target 能解析到已索引节点（md 标题）才建边，
					// 排除非 md 来源链接（如 [[库/.../xxx.html]]）造成的伪星形边。
					if (target && target !== nodeName && nodes.has(target)) {
						edges.push({ source: nodeName, target });
					}
				}
			} catch { /* skip */ }
		}

		const communityResult = detectCommunities([...nodes], edges);
		const communityEntries = [...communityResult.communities.entries()];
		const out: string[] = [
			'# 知识图谱洞察', '',
			`> ${notes.length} 篇笔记，${edges.length} 条链接，${communityEntries.length} 个社区。`, '',
		];
		for (const [cid, comNodes] of communityEntries) {
			out.push(`## 社区 ${cid}（${comNodes.length} 节点）`);
			for (const nd of comNodes.slice(0, 20)) { out.push(`- [[${nd}]]`); }
			if (comNodes.length > 20) { out.push(`- ... 还有 ${comNodes.length - 20} 个节点`); }
			out.push('');
		}
		out.push('---', '', '*由 KbImportController 自动维护，基于 Louvain 社区检测算法生成。*');
		const insightsUri = URI.joinPath(notesDir, 'insights.md');
		await KbImportController._writeIfChanged(fileService, insightsUri, out.join('\n'));
	}

	static async appendKbLog(fileService: IFileService, notesDir: URI, entry: string): Promise<void> {
		try {
			const logUri = URI.joinPath(notesDir, 'log.md');
			const ts = new Date().toISOString();
			let existing = '';
			try { existing = (await fileService.readFile(logUri)).value.toString(); } catch { /* new file */ }
			const line = `- ${ts} ${entry}\n`;
			if (!existing.includes(entry)) {
				await fileService.writeFile(logUri, VSBuffer.fromString(existing + line));
			}
		} catch { /* ignore */ }
	}

	/**
	 * P0-1 去抽象化门控：扫描全库派生类笔记，按同名概念被多少「不同来源」确认决定 status。
	 *   - ≥2 个不同来源提及同名概念 → active（正式页）
	 *   - 否则 → pending（候选，待第二次来源确认）
	 * 对齐 llm_wiki「概念需被≥2来源提及才建页」的纪律，抑制碎片噪音。
	 * 采用「跨同名笔记确认」：即便同一概念因多次导入存为多个文件，只要它们合计指向 ≥2 个不同库文件即晋升，
	 * 使门控在当前「每次导入单独建页」的存储模型下依然有效（文件级去重留待 P1 合并）。
	 * 安全：仅追加/改写 frontmatter 的 status 字段，不动 body；无 status 的旧笔记视为 active。
	 */
	static async applyDeabstractionGating(fileService: IFileService, libDir: URI): Promise<{ active: number; pending: number }> {
		const notes = await KbImportController._collectMdFiles(fileService, libDir, KbImportController.SYS_INDEX_FILES);
		// P1 同义归一：读 <kbDir>/aliases.json，让「GC机制/垃圾回收」等表述归同一 canonical 共享来源数
		const aliases = await loadKbAliases(fileService, dirname(libDir));
		// Pass1：收集所有派生类笔记的 (uri, 归一标题, 来源集合)，按「同义归一后的 canonical」聚合来源
		const collected: { uri: URI; normTitle: string; sources: string[] }[] = [];
		const byTitle = new Map<string, Set<string>>();
		for (const n of notes) {
			let raw: string;
			try { raw = (await fileService.readFile(n)).value.toString(); } catch { continue; }
			const type = (await KbImportController._readNoteFrontmatterType(fileService, n) ?? '').toLowerCase();
			if (!KbImportController.GATED_TYPES.has(type)) { continue; }
			const { frontmatter } = parseFrontmatter(raw);
			const title = (frontmatter?.['title'] ?? n.path.split(/[\\/]/).pop() ?? '').toString();
			const normTitle = canonicalizeTitle(title, aliases);
			if (!normTitle) { continue; }
			const sources = extractSources(raw).map(s => s.toLowerCase());
			collected.push({ uri: n, normTitle, sources });
			let set = byTitle.get(normTitle);
			if (!set) { set = new Set<string>(); byTitle.set(normTitle, set); }
			for (const s of sources) { set.add(s); }
		}
		// Pass2：按同 canon 来源总数决定 status 并落盘
		let active = 0;
		let pending = 0;
		for (const c of collected) {
			const distinct = byTitle.get(c.normTitle)?.size ?? 0;
			const target = distinct >= 2 ? STATUS_ACTIVE : STATUS_PENDING;
			let raw: string;
			try { raw = (await fileService.readFile(c.uri)).value.toString(); } catch { continue; }
			const { content: updated, changed } = setStatus(raw, target);
			if (changed) {
				await fileService.writeFile(c.uri, VSBuffer.fromString(updated));
			}
			if (target === STATUS_ACTIVE) { active++; } else { pending++; }
		}
		return { active, pending };
	}

	// ─── 静态辅助方法 ─────────────────────────────────────────────────────────

	static async _collectMdFiles(fileService: IFileService, dir: URI, exclude?: string | readonly string[]): Promise<URI[]> {
		const out: URI[] = [];
		const excludeSet = new Set(exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : []);
		const walk = async (current: URI): Promise<void> => {
			try {
				const stat = await fileService.resolve(current);
				if (!stat.children) { return; }
				for (const child of stat.children) {
					if (child.name.startsWith('.')) { continue; }
					if (child.isDirectory) { await walk(child.resource); }
					else if (child.name.endsWith('.md') && !excludeSet.has(child.name)) {
						out.push(child.resource);
					}
				}
			} catch { /* ignore */ }
		};
		await walk(dir);
		return out;
	}

	private static async _readNoteFrontmatterType(fileService: IFileService, uri: URI): Promise<string | undefined> {
		try {
			const raw = (await fileService.readFile(uri)).value.toString();
			const head = raw.slice(0, 2048);
			const fmMatch = head.match(/^---\s*\n([\s\S]*?)\n---/);
			if (!fmMatch) { return undefined; }
			const typeMatch = fmMatch[1].match(/^type:\s*(.+)$/m);
			if (!typeMatch) { return undefined; }
			let value = typeMatch[1].trim();
			value = value.replace(/^["']|["']$/g, '');
			value = value.replace(/\s*#.*$/, '').trim();
			return value || undefined;
		} catch { return undefined; }
	}

	static async _writeIfChanged(fileService: IFileService, uri: URI, content: string): Promise<void> {
		try {
			const existing = (await fileService.readFile(uri)).value.toString();
			if (existing === content) { return; }
		} catch { /* file doesn't exist yet */ }
		await fileService.writeFile(uri, VSBuffer.fromString(content));
	}

	public static async _collectAgentNotesUnderTargetDir(fileService: IFileService, targetDir: URI): Promise<URI[]> {
		return KbImportController._collectMdFiles(fileService, targetDir, KbImportController.SYS_INDEX_FILES);
	}

	/**
	 * 后验路径纠偏：将 agent 写到错误位置的笔记移到正确路径。
	 * 两阶段工作流下不再自动调用，但保留以兼容旧测试和手动纠偏场景。
	 */
	static async _validateAndFixNotePaths(
		fileService: IFileService, _kbRoot: URI, _notesDir: URI, _targetDir: URI, _since: number,
	): Promise<void> {
		// 两阶段工作流下，笔记由构建阶段创建，路径由 Agent 自主决定，
		// 不再强制纠偏到预计算的 targetDir。
	}

	/** 从笔记 frontmatter 解析 sources 字段（供级联删除使用）。 */
	static parseNoteSources(content: string): string[] {
		return extractSources(content);
	}

	/** 级联删除 stub（两阶段工作流下不自动删除，保留以兼容旧测试）。 */
	static async cascadeDeleteLibraryNotes(
		_fileService: IFileService, _libDir: URI, _notesDir: URI, _libFileName?: string,
	): Promise<string[]> {
		return [];
	}

	// ─── 工具方法（供测试访问）─────────────────────────────────────────────────

	static createKbImportHandler(
		kbImport: { handleFavoriteMessage(content: string, agentId: string | null): Promise<boolean> } | undefined,
		getAgentId: () => string | null,
		importedIds: Set<string>,
	): (content: string, messageId: string) => Promise<boolean> {
		return async (content: string, messageId: string): Promise<boolean> => {
			if (messageId && importedIds.has(messageId)) { return true; }
			const success = await kbImport?.handleFavoriteMessage(content, getAgentId()) ?? false;
			if (success && messageId) { importedIds.add(messageId); }
			return success;
		};
	}
}

/**
 * 纯函数工厂：聊天框「导入知识库」按钮去重处理器。
 */
export function createKbImportHandler(
	kbImport: { handleFavoriteMessage(content: string, agentId: string | null): Promise<boolean> } | undefined,
	getAgentId: () => string | null,
	importedIds: Set<string>,
): (content: string, messageId: string) => Promise<boolean> {
	return KbImportController.createKbImportHandler(kbImport, getAgentId, importedIds);
}
