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
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IWebContentExtractorService, ISharedWebContentExtractorService } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';
import {
	composeArticleMarkdown,
	composeVideoMarkdown,
	detectPlatform,
	findMarkdownImageUrls,
	htmlToPlainText,
	parseMetaTags,
	planImagePath,
	rewriteMarkdownImageUrls,
	slugifyTitle,
	toSecureScheme,
	parseSubtitlesToText,
	type IKbMetaTags,
	} from './views/knowledgeBase/kbUrlScraper.js';
// 飞书云文档（2026-09-23）：正文/图片/画板的抓取与改写是纯逻辑（单测覆盖），CLI 调用走服务层
import { getLarkCliStatus, runLarkCli } from './larkCliService.js';
import { LARK_CLI_BIN } from '../common/larkCli.js';
import {
	composeFeishuDocMarkdown,
	extractFeishuMediaRefs,
	isFeishuDocUrl,
	parseFeishuDocFetch,
	planFeishuMediaKey,
	planFeishuMediaName,
	replaceFeishuMediaRefs,
} from './views/knowledgeBase/kbFeishuDoc.js';
import { DEFAULT_YTDLP, fetchVideoMeta, fetchVideoSubtitles } from './knowledge/kbVideoFetch.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IAgentChatService, IAgentStudioService } from '../common/agentStudio.js';
import type { IToolCardHandle } from '../../../common/agentStudioService.js';
import type { IChatModel } from './knowledge/llm.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { NativeChatEditorInput } from './nativeChatEditorInput.js';
import { AGENT_STUDIO_KB_VIEW_ID } from '../common/constants.js';
import { isChatProviderConfigured } from './knowledge/knowledgeAdapters.js';
import { extractSources, injectSources, normalizeSourceRef } from './knowledge/frontmatter.js';
import { canonicalizeTitle, loadKbAliases } from './knowledge/kbAliases.js';
import { dirname } from '../../../../base/common/resources.js';
import { detectCommunities } from './knowledge/communityDetection.js';
import type { CommunityEdge } from './knowledge/communityDetection.js';
import { IKBSchema, loadKbSchema, buildSchemaPromptText, sanitizeKbTopic } from './knowledge/kbSchema.js';
import type { SchemaClassifyResult } from './knowledge/classifier.js';
import type { IAgentDriverService } from '../common/agentDriver.js';
import { AGENT_STUDIO_KB_AGENTIC_BUILD } from '../common/constants.js';
import { buildFileBlockPrompt, parseFileBlocks } from '../common/fileBlockParser.js';
import { enrichWikilinks } from './knowledge/enrichWikilinks.js';
import { KB_NOTE_FORMAT_RULES } from './knowledge/obsidianNoteFormat.js';
import { summarizeCommunities } from './knowledge/communitySummaries.js';
import { refreshTopicOverviews } from './knowledge/topicOverviews.js';
// 「非文本素材 → 文本」前置转换（2026-09-23）：IPC 桥 + 通道契约（common 侧单一真源）
// ⚠ 2026-10-12 外提后这三个符号的**消费方**已搬到 `knowledge/kbVaultFs.ts`，此处不再 import
//   （仓库开了 noUnusedLocals ⇒ 留着会直接报 TS6133/TS6192）。
import {
	KB_LIBRARY_SUBPATH,
	KB_NOTES_SUBPATH,
	KB_RAW_SUBPATH,
	KB_SUBS_TMP_SUBPATH,
	SYS_INDEX_FILES,
	applyDeabstractionGating,
	cacheEntryFresh,
	collectMdFiles,
	collectPendingSources,
	isWithinVault,
	listAllNoteSubdirs,
	listEngineNoteDirs,
	parseLibCategory,
	readBuildCache,
	readNoteFrontmatterType,
	relativeFromLib,
	removeDirIfEmpty,
	reportProcessing,
	resolveActiveVaultRoot,
	runStage1Analysis,
	salvageSingleNoteToDir,
	sameFsPath,
	sanitizeFsName,
	typeDirMapping,
	writeBuildCache,
	// 下面 4 个只有**对外转发**用到（类的其余调用点已走裸名）⇒ 必须显式 import 进来 ✓
	purgeBuildCacheEntries,
	pruneMissingSources,
	listBuiltSourcePaths,
	purgeStaleBuildCacheEntries,
	writeFileBlocks,
} from './knowledge/kbVaultFs.js';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/**
 * Stage 2 系统提示词：让 LLM 按 FILE 块格式一次产出多个 Markdown 笔记，落入源文件所在目录。
 * 笔记格式约定（frontmatter/双链/callout）的唯一真源 = KB_NOTE_FORMAT_RULES
 * （knowledge/obsidianNoteFormat.ts，与内置技能 obsidian-markdown 互为同步指针；
 * 技能路径 2026-10-13 拍平到 `resources/.agents/skills/obsidian-markdown/`）。
 */
const STAGE2_SYSTEM = '你是一位笔记撰写助手。依据规划将素材落盘为结构化 Markdown 笔记。'
	+ KB_NOTE_FORMAT_RULES
	+ '使用 ---FILE: 相对路径 --- 语法一次产出多个文件，路径相对于源文件所在目录。'
	+ '只输出 FILE 块，不要额外解释。';

// ─── 主类 ────────────────────────────────────────────────────────────────────

export class KbImportController extends Disposable {

	// ─── 已外提到 `knowledge/kbVaultFs.ts` 的成员：保留同名 static **转发** ──────────────
	//
	// 为什么保留：外部（`agentStudio.contribution.ts` / `views/knowledgeBaseView.ts` 等）按
	// `KbImportController.X` 调用这些成员；外提只搬实现、**不改对外 API** ⇒ 调用方零改动 ✓。
	// 类内其余调用点已直接走 import 的裸名（不再绕类）。
	//
	// ⚠ 这里只准是**一行转发**：真源在新模块，别把实现抄回来（那会立刻产生两套口径 ✗）。

	/** @see knowledge/kbVaultFs.ts 的同名函数（真源） */
	static resolveActiveVaultRoot(storageService: IStorageService, envService: INativeEnvironmentService, logService?: ILogService): URI {
		return resolveActiveVaultRoot(storageService, envService, logService);
	}

	/** @see knowledge/kbVaultFs.ts 的同名函数（真源） */
	static isWithinVault(uri: URI, vaultRoot: URI): boolean {
		return isWithinVault(uri, vaultRoot);
	}

	/** @see knowledge/kbVaultFs.ts 的同名函数（真源） */
	static async purgeBuildCacheEntries(fileService: IFileService, vaultRoot: URI, deletedFsPaths: string[]): Promise<number> {
		return purgeBuildCacheEntries(fileService, vaultRoot, deletedFsPaths);
	}

	/** @see knowledge/kbVaultFs.ts 的同名函数（真源） */
	static async pruneMissingSources(fileService: IFileService, libDir: URI, extraNoteDirs: URI[] = []): Promise<{ notes: string[]; removed: number }> {
		return pruneMissingSources(fileService, libDir, extraNoteDirs);
	}

	/** @see knowledge/kbVaultFs.ts 的同名函数（真源） */
	static async listBuiltSourcePaths(fileService: IFileService, vaultRoot: URI): Promise<Set<string>> {
		return listBuiltSourcePaths(fileService, vaultRoot);
	}

	/** @see knowledge/kbVaultFs.ts 的同名函数（真源） */
	static async purgeStaleBuildCacheEntries(fileService: IFileService, vaultRoot: URI): Promise<number> {
		return purgeStaleBuildCacheEntries(fileService, vaultRoot);
	}

	/** @see knowledge/kbVaultFs.ts 的同名函数（真源） */
	static async applyDeabstractionGating(fileService: IFileService, libDir: URI): Promise<{ active: number; pending: number }> {
		return applyDeabstractionGating(fileService, libDir);
	}

	// 静态常量
	/** 视频字幕抓取的库内临时目录（读回后即清理，不留在知识库里）。 */
	/** P0-1 去抽象化门控：仅对这些派生知识类施加「≥2 来源才 active」约束。 */

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
		/** 可选：agentic 构建模式（AGENT_STUDIO_KB_AGENTIC_BUILD=true 时）经它跑 agent 轮次。 */
		private readonly _agentDriverService?: IAgentDriverService,
		/**
		 * 可选：聊天会话服务。
		 *
		 * ★ 2026-09-23（用户要求「构建过程在聊天框中打开知识库专家 agent 的一个新 session」）：
		 *   **只有它能让构建过程在聊天框里可见** —— agentic 那一轮改走 `sendMessage`
		 *   （它内部落历史 + 广播 `onDidStreamDelta`），而 `IAgentDriverService` 只**产流**、
		 *   不落盘、不广播 ⇒ 即使用真实 sessionId，用户在聊天框里也什么都看不到。
		 *   未注入时自动退回 headless（旧行为）；单测走的就是这条。
		 */
		private readonly _agentChatService?: IAgentChatService,
		/**
		 * 可选：编辑器组服务。
		 *
		 * ★ 2026-09-24（用户要求「构建会话在聊天框窗口的 group 中，新建一个 group」）：
		 *   有了它，`_openKbBuildChatTab` 才能在聊天框所在的 agentPart 里**新建一个编辑器组**
		 *   （与 presetAgentView「打开新聊天 tab 默认开在独立 group」同一套做法）；
		 *   未注入时退回普通 openEditor（单测走这条）。
		 */
		private readonly _editorGroupsService?: IEditorGroupsService,
	) {
		super();
	}

	/** 「知识库专家」agent id（原先散落在 `_buildNoteAgentic` 里是字面量，2026-09-23 提取）。 */
	private static readonly KB_BUILD_AGENT_ID = 'knowledge-base-expert';

	/**
	 * 本次「构建过程」对应的**聊天会话 id**（知识库专家 agent 的真实会话，聊天框里可见）。
	 *
	 * 生命周期（用户要求：构建过程开**一个**新 session）：
	 *   · 批量构建 ⇒ 整个批次**共用一个**（`buildAllPendingNotes` 先置空 ⇒ 首次使用时新建）；
	 *   · 单文件构建 ⇒ **每次新建**（`buildNotesFromLibrary` 未传 `reuseBuildSession` 时置空）。
	 * 置空只是"下次用的时候新建"，不会立刻创建 —— 真正创建在建不出来也无所谓的地方（`_ensureKbBuildChatSession`）。
	 */
	private _kbBuildSessionId: string | undefined;

	/**
	 * 该构建会话是否**已经跑过至少一个素材**（仅批量会用到）。
	 *
	 * ⚠ 为什么需要这道保护：`IAgentChatService.sendMessage` 会把该会话的**全量历史**作为
	 *   `priorMessages` 下发给本轮（`agentChatService` 里 `getHistory` → `priorMessages`，
	 *   只剔除"当前这条 user"）。若把 7 个素材都塞进同一个会话，第 2 个素材起就会把前面素材的
	 *   **整份原文 + 整份产出**再喂一遍 ⇒（一）上下文平方级膨胀、可能触发压缩；
	 *   （二）模型很可能**重复输出前几个文件的 FILE 块** ⇒ 写出重复笔记。
	 *   所以：同一会话里跑**下一个素材之前先清空历史**（`replaceHistory(…, [])`），
	 *   让每个素材的上下文与「各自独立会话」完全一致；而用户仍然只看到**一个**会话在实时工作。
	 */
	private _kbBuildSessionUsed = false;

	/** P1-4：per-vault 互斥锁 */
	private static _vaultLocks = new Map<string, Promise<void>>();

	/**
	 * ★ 2026-09-24：**「正在构建」全局标记**（UI 按钮与 agent 的 `kb_build` 工具共享）。
	 *
	 * 为什么需要：构建是**分钟级**长任务，且现在有**两个**发起方 ——
	 *   · 知识库视图「批量构建库」按钮（`_batchBuildAll`）；
	 *   · agent 的 `kb_build` 工具（`mode:'build'`）。
	 * 两者同时发起会各建一个构建会话、各自回填缓存/补链/导航 ⇒ 互相覆盖（缓存写回竞争、
	 * 导航文档抖动、笔记被重复改写）。此前只靠"用户不会连点"的假设，双击按钮就能触发。
	 * 计数语义：>0 即「有构建在跑」，供发起方**拒绝重复发起**并如实告知。
	 */
	private static _buildInFlight = 0;

	/** 是否有构建正在进行（`kb_build` 与视图按钮据此避免重复发起）。 */
	static get buildInFlight(): boolean {
		return KbImportController._buildInFlight > 0;
	}

	/** 与 knowledgeBaseView.ts 使用一致的 storage key。 */

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
	async handleFavoriteMessage(content: string, currentAgentId: string | null, vaultRootUri?: URI, sourceFile?: URI, opts?: { skipOpen?: boolean; quiet?: boolean }): Promise<boolean> {
		// 统一反馈（无通知）：徽标转圈 + 视图内状态提示
		this._reportProcessing(true, sourceFile ? `导入中：${sourceFile.path.split('/').pop() ?? ''}` : '导入中…',
			sourceFile ? [sourceFile.fsPath] : undefined);
		try {
			const vaultRoot = vaultRootUri ?? this._resolveKbRootUri();
			const libDir = this._resolveLibraryDir(vaultRoot);
			const notesDir = this._resolveNotesDir(vaultRoot);
			// ★ 分类也要 LLM（schema 分类）。未配置时**不中止**（落盘必须成功，文件不会丢），
			//   只提醒一次：分类会降级为兜底（`safeSchemaFallback`）—— 否则用户只会看到
			//   「文件进了库、但归类不对劲」，不知道是模型没配（2026-09-23 需求）。
			//   ⚠ 与构建阶段的提醒共用 5 分钟节流 ⇒ 整条导入链路最多弹一条。
			if (KbImportController.kbAgentConfigState(this._agentStudioService, this._configurationService) === 'missing') {
				KbImportController.warnKbAgentNotConfigured(this._notificationService, '自动分类归档');
			}
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
			// 批量导入（Explorer 多选「移动到知识库」）传 `quiet`：每个文件都弹一条
			// 「已保存到库/raw」会瞬间刷满通知中心，并把调用方的**进度通知**盖掉 ——
			// 那种场景下反馈由调用方统一用进度条 + 汇总通知呈现。
			if (!opts?.quiet) {
				this._notificationService.notify({
					severity: Severity.Info,
					message: `已保存到知识库「库/raw」分区（${classifyResult.typeLabel}/${topic}）。可右键库文件「构建为笔记」生成结构化笔记。`,
					source: 'agent-chat-favorite',
				});
			}
			// 通知 KB view 刷新文件树，确保新入库文件即时可见
			void this._agentStudioService.requestKbRefresh();
			// 批量导入（Explorer 多选「移动到知识库」）时不逐个打开编辑器：
			// 每个文件开一个 pinned tab 会让用户瞬间被 N 个 KB 编辑器淹没 ⇒
			// 调用方对除最后一个文件外传 `skipOpen: true`（文件树刷新照常）。
			if (!opts?.skipOpen) { void this._openKbViewAndNavigate(savedPath); }
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
	 * **统一上报知识库后台处理状态**（徽标 + 视图内进度），所有导入/构建路径共用。
	 *
	 * 为什么放在控制器里（2026-09-23 用户要求「三处反馈完全统一」）：
	 * 导入/构建有多个入口（Explorer 右键命令、知识库视图右键「构建为笔记」、工具栏「批量构建」、
	 * 聊天框 write_file 卡片、URL 导入），若各自拼反馈，观感必然不一致。
	 * 下沉到这里 ⇒ 任何入口跑起来，用户看到的都是同一套：
	 *   · activitybar「资料库」徽标转圈（结束转「有新增」）
	 *   · 知识库视图「库 / 笔记」标题右侧的 `label`
	 *   · `paths` 对应的文件节点转圈
	 *
	 * ⚠ **不发通知**（用户明确要求）；`active=false` 表示收尾（清标记 + 徽标转「有新增」）。
	 */
	private _reportProcessing(active: boolean, label?: string, paths?: string[]): void {
		reportProcessing(this._agentStudioService, this._logService, active, label, paths);
	}

	/**
	 * 「需要知识库 agent / LLM，但**没有配置 Provider 与模型**」的统一前置检查（2026-09-23 需求）。
	 *
	 * 触发时机：任何需要 KB 智能能力的动作（构建笔记 / agentic 抽取 / 分类归档）。
	 * 行为：不可用时**弹出通知**（告知去哪配置），并返回 `null` 让调用方直接中止 ——
	 *       避免 agent 轮次白跑、或静默降级成「没有产出」这种用户看不懂的结果。
	 *
	 * 判据（与多模态读的是同一份「知识库专家」模型配置）：
	 *   ① provider 可用：`lm:` 桥接已注册 或 BYOK provider 已配 key；
	 *   ② 「知识库专家」显式选了 providerId + modelId，且能解析出 chat model。
	 *
	 * ⚠ 节流：批量导入会连续调用 ⇒ 5 分钟内只提醒一次（否则 N 个文件弹 N 条）。
	 */
	static kbAgentConfigState(
		agentStudioService: IAgentStudioService, configService: IConfigurationService,
	): 'ready' | 'missing' | 'unknown' {
		const probe = agentStudioService as unknown as {
			isKbChatProviderAvailable?: () => boolean;
			_resolveKbChatModel?: () => { providerId?: string; modelId?: string } | null;
		};
		// 探测句柄不存在 ⇒ 无法判断（单测/早期启动）⇒ **放行**，绝不误伤
		if (typeof probe._resolveKbChatModel !== 'function') { return 'unknown'; }
		const providerOk = probe.isKbChatProviderAvailable?.() ?? isChatProviderConfigured(configService);
		const sel = probe._resolveKbChatModel();
		return (providerOk && !!sel?.providerId && !!sel?.modelId) ? 'ready' : 'missing';
	}

	/**
	 * 通知用户「知识库专家还没配 Provider / 模型」（2026-09-23 需求）。
	 *
	 * ⚠ 节流 5 分钟：批量构建/导入会连续触发，否则会弹出 N 条同样的提醒。
	 */
	static warnKbAgentNotConfigured(notificationService: INotificationService, scene: string): void {
		const now = Date.now();
		if (KbImportController._kbConfigWarnedAt && now - KbImportController._kbConfigWarnedAt < 5 * 60_000) { return; }
		KbImportController._kbConfigWarnedAt = now;
		notificationService.notify({
			severity: Severity.Warning,
			message: `知识库需要 AI 模型来${scene}，但「知识库专家」尚未配置 Provider 与模型。`
				+ '请在 资料库 → 设置 → 知识库 中为「知识库专家」选择 Provider 与模型后重试。',
			source: 'kb-build',
		});
	}

	/** 「未配置模型」提醒的节流时间戳。 */
	private static _kbConfigWarnedAt: number | undefined;

	async stageFileToLibrary(sourceFile: URI, vaultRootUri?: URI, opts?: { quiet?: boolean; progress?: { index: number; total: number } }): Promise<string | undefined> {
		// 统一反馈：徽标转圈 + 视图内「导入中 i/N：文件名」+ 该文件节点转圈（无通知）。
		// ⚠ 进度由**本方法**上报（而不是调用方）：否则调用方先报 i/N、这里再报「导入中：文件名」
		//   会把 i/N 覆盖掉，用户只看到文件名的来回跳。
		const baseName = sourceFile.path.split('/').pop() ?? '';
		this._reportProcessing(true,
			opts?.progress ? `导入中 ${opts.progress.index}/${opts.progress.total}：${baseName}` : `导入中：${baseName}`,
			[sourceFile.fsPath]);
		try {
			const vaultRoot = vaultRootUri ?? this._resolveKbRootUri();
			// 读一次内容**仅用于去重指纹**（`_saveFileToKbLibraryStructured` 据此判重；落盘本身是
			// 字节复制）。⚠ 不能省：传空内容会让所有文件撞成同一指纹而被误判为「重复已导入」。
			const content = (await this._fileService.readFile(sourceFile)).value.toString();
			const savedPath = await this._withVaultLock(vaultRoot,
				() => this._saveFileToKbLibraryStructured(sourceFile, content, vaultRoot));
			this._lastLibUri = URI.file(savedPath);
			this._logService.info(`[KbImportController] staged (copy only, no classify): ${savedPath}`);
			await KbImportController.appendKbLog(this._fileService, this._resolveNotesDir(vaultRoot),
				`导入 → ${savedPath.split(/[\\/]/).pop() ?? savedPath}`);
			// 刷新文件树，让新入库文件立刻可见
			void this._agentStudioService.requestKbRefresh();
			if (!opts?.quiet) {
				this._notificationService.notify({
					severity: Severity.Info,
					message: `已保存到知识库「库/raw」：${savedPath.split(/[\\/]/).pop() ?? savedPath}`,
					source: 'agent-chat-favorite',
				});
			}
			return savedPath;
		} catch (err) {
			this._logService.error('[KbImportController] stage file to library failed:', err);
			if (!opts?.quiet) {
				this._notificationService.notify({
					severity: Severity.Error,
					message: `导入知识库失败：${err instanceof Error ? err.message : String(err)}`,
					source: 'agent-chat-favorite',
				});
			}
			return undefined;
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
	async importContentAndBuild(content: string, currentAgentId: string | null, vaultRootUri?: URI, sourceFile?: URI, opts?: { skipOpen?: boolean; quiet?: boolean }): Promise<boolean> {
		try {
			const entryOk = await this.handleFavoriteMessage(content, currentAgentId, vaultRootUri, sourceFile, opts);
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
		} finally {
			// ★ 统一收尾（2026-09-23）：清掉视图内「处理中」标记，并把 activitybar 徽标从「转圈」
			//   转成「有新增」。所有走本方法的入口（Explorer 命令 / 聊天框 write_file 卡片）至此
			//   反馈**完全一致**；这与知识库视图内两个入口（右键构建 / 批量构建）用的是同一套通道。
			this._reportProcessing(false);
		}
	}

	// ─── 阶段 2：构建笔记 ────────────────────────────────────────────────────

	/**
	 * 「导入链接 / URL」（2026-09-22）：抓取网页正文 → **下载图片到知识库** → 改写引用 → 组装 markdown
	 * → 落盘 `库/raw/<slug>.md`。之后可直接「构建为笔记」，其本地图片也能被飞书同步上传
	 * （飞书链路只认本地相对引用，见 doc/kb-feishu-sync-spec.md §3）。
	 *
	 * 设计：服务由**调用方注入**（视图侧已有），不改进本类构造签名 ⇒ 避免改动 3 处 new 点与测试。
	 * 抓取优先级：`IWebContentExtractorService.extract`（主进程 reader-mode，可读强 SPA 之外的正文）
	 * → 降级 `IRequestService` 取 HTML + `htmlToPlainText` 兜底；图片二进制走
	 * `ISharedWebContentExtractorService.readImage`（共享进程读取，不受 renderer CSP 限制）。
	 */
	static async importUrl(opts: {
		url: string;
		vaultRoot: URI;
		fileService: IFileService;
		logService: ILogService;
		requestService?: IRequestService;
		extractor?: IWebContentExtractorService;
		imageReader?: ISharedWebContentExtractorService;
		/** yt-dlp 可执行名/路径（默认 PATH 里的 `yt-dlp`）；未安装时自动降级为「仅记链接」。 */
		ytdlpPath?: string;
	}): Promise<{ ok: boolean; path?: string; title?: string; images: number; message: string }> {
		const { vaultRoot, fileService, logService } = opts;
		const target = toSecureScheme((opts.url ?? '').trim());
		if (!/^https?:\/\//i.test(target)) {
			return { ok: false, images: 0, message: '请输入以 http(s):// 开头的链接。' };
		}
		const platform = detectPlatform(target);

		// ── 0. 飞书云文档（2026-09-23）：**优先**走飞书 CLI，不走网页抓取 ────────────
		//   「优先」不是优化而是必需：飞书文档在未登录的网页里只有登录墙/骨架，
		//   常规抓取必然拿不到正文，更拿不到图片、画板（思维导图）与表格。
		//   按用户要求：**没装 CLI / 没权限读取 ⇒ 明确提示「无法读取」**，
		//   而不是静默降级成网页抓取、落一个空壳 md（那样用户会以为导入成功了）。
		if (isFeishuDocUrl(target)) {
			return await KbImportController._importFeishuDoc(target, vaultRoot, fileService, logService);
		}

		// ── 1. 正文：主进程提取器优先，失败降级为「请求 HTML + 去标签」──────────
		let body = '';
		let title = '';
		let html = '';
		if (opts.extractor) {
			try {
				let r = (await opts.extractor.extract([URI.parse(target)]))[0];
				if (r?.status === 'redirect') { r = (await opts.extractor.extract([r.toURI]))[0]; }
				if (r?.status === 'error') {
					return { ok: false, images: 0, message: `抓取失败：${r.error}${r.statusCode ? ` (HTTP ${r.statusCode})` : ''}` };
				}
				if (r?.status === 'ok') {
					// ★ 2026-09-23：标题与正文**必须分开取值**。
					// 此前是 `if (r.status === 'ok' && r.result)` —— 用「有无正文」当整体开关，
					// 于是**视频页（有标题、无正文）**会把标题一起丢掉，落到「无正文也无标题」的
					// 失败分支 ⇒ 导入 B站/YouTube 链接直接报错（单测 kbImportControllerUrl.test.ts 抓到）。
					if (r.result) { body = r.result; }
					if (r.title) { title = r.title; }
				}
			} catch (e) {
				logService.warn(`[KB importUrl] extract failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (!body && opts.requestService) {
			try {
				const ctx = await opts.requestService.request(
					{ type: 'GET', url: target, timeout: 20000, callSite: 'saros.kb.importUrl' }, CancellationToken.None);
				html = (await asText(ctx)) ?? '';
			} catch (e) {
				logService.warn(`[KB importUrl] request failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		let meta: IKbMetaTags = parseMetaTags(html);
		// ── 1.5 视频元信息（yt-dlp 扩展点）：仅视频/混合平台尝试；失败只降级、不中断导入 ──
		const isVideoPlatform = platform.type === 'video' || platform.type === 'mixed';
		let videoUnavailable = '';
		if (isVideoPlatform) {
			try {
				const v = await fetchVideoMeta(target, opts.ytdlpPath ?? DEFAULT_YTDLP);
				if (v.ok) {
					// yt-dlp 的标题/时长/封面/作者/日期比 OG 元数据可靠 ⇒ 覆盖（描述保留更完整的一侧）
					meta = { ...meta, ...v.meta, description: v.meta.description ?? meta.description };
				} else {
					videoUnavailable = v.reason;
					logService.info(`[KB importUrl] yt-dlp 降级（仅记链接）：${v.reason}`);
				}
			} catch (e) {
				logService.warn(`[KB importUrl] yt-dlp failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// ── 1.6 视频字幕（yt-dlp）：用于「总结视频内容」；无字幕/未安装 ⇒ 静默降级 ──
		// ⚠ 字幕是**文件**（stdout 单次缓冲装不下）⇒ 先写进库内临时目录，读回清洗后立即清理。
		if (isVideoPlatform) {
			const tmpDir = URI.joinPath(vaultRoot, KB_LIBRARY_SUBPATH, KB_SUBS_TMP_SUBPATH);
			try {
				try { await fileService.createFolder(tmpDir); } catch { /* 已存在 */ }
				const sub = await fetchVideoSubtitles(target, tmpDir.fsPath, opts.ytdlpPath ?? DEFAULT_YTDLP);
				if (sub.ok) {
					const entries = await fileService.resolve(tmpDir);
					const subFile = (entries.children ?? []).find(c => !c.isDirectory && /\.(vtt|srt)$/i.test(c.name));
					if (subFile) {
						const text = parseSubtitlesToText((await fileService.readFile(subFile.resource)).value.toString());
						if (text) { meta = { ...meta, subtitleText: text }; }
					}
					// 清理临时文件（不在知识库里留垃圾）
					for (const c of entries.children ?? []) {
						try { await fileService.del(c.resource, { recursive: true }); } catch { /* ignore */ }
					}
				} else {
					logService.info(`[KB importUrl] 视频字幕不可用（降级为仅元信息）：${sub.reason}`);
				}
			} catch (e) {
				logService.warn(`[KB importUrl] 字幕抓取失败：${e instanceof Error ? e.message : String(e)}`);
			}
		}
		// ★ 2026-09-23：**标题双向补齐**。
		// 主进程提取器（reader-mode）成功时 HTML 根本不会被请求 ⇒ `meta`（来自 `parseMetaTags(html)`）
		// 是空的，而标题只存在于 `r.title` 里。此前只做「`title` 空 ⇒ 取 `meta.title`」这一个方向，
		// 于是 `composeArticleMarkdown` 里的 `meta.title || url` 会**退化成 URL**
		// ⇒ 导入知乎/博客后笔记的 H1 变成一串链接（单测 `kbImportControllerUrl.test.ts` 抓到）。
		if (!title) { title = meta.title ?? ''; }
		else if (!meta.title) { meta = { ...meta, title }; }
		if (!body) { body = htmlToPlainText(html); }
		// 视频页通常没有「正文」⇒ 只要拿到标题/元信息就算成功（否则才报失败）
		if (!body.trim() && !meta.title && !meta.videoUrl) {
			return {
				ok: false, images: 0,
				message: videoUnavailable
					? `未能获取内容（yt-dlp：${videoUnavailable}；且页面无可读正文）。`
					: '未能获取正文（页面可能需要登录、为强 SPA，或主进程提取器不可用）。',
			};
		}

		// ── 2. 图片本地化：下载到 库/raw/assets/<slug>/，并把正文里的远程引用改写为相对路径 ──
		const slug = slugifyTitle(title, target);
		const assetsDir = URI.joinPath(vaultRoot, KB_LIBRARY_SUBPATH, KB_RAW_SUBPATH, 'assets', slug);
		const urlMap = new Map<string, string>();
		let images = 0;
		const candidates = [...new Set([...findMarkdownImageUrls(body), ...(meta.cover ? [meta.cover] : [])])];
		if (candidates.length && opts.imageReader) {
			try { await fileService.createFolder(assetsDir); } catch { /* 已存在 */ }
			for (let i = 0; i < candidates.length; i++) {
				const remote = toSecureScheme(candidates[i]);
				try {
					const buf = await opts.imageReader.readImage(URI.parse(remote), CancellationToken.None);
					if (!buf) { continue; }
					const plan = planImagePath(slug, i + 1, remote);
					const abs = URI.joinPath(vaultRoot, KB_LIBRARY_SUBPATH, KB_RAW_SUBPATH, ...plan.rel.split('/'));
					await fileService.writeFile(abs, buf);
					urlMap.set(candidates[i], plan.rel);
					images++;
				} catch (e) {
					logService.warn(`[KB importUrl] image failed ${remote}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		} else if (candidates.length) {
			logService.info(`[KB importUrl] 图片读取器不可用 ⇒ 跳过 ${candidates.length} 张图（保留远程引用）`);
		}
		const rewrittenBody = urlMap.size ? rewriteMarkdownImageUrls(body, urlMap) : body;
		const coverLocal = meta.cover ? urlMap.get(meta.cover) : undefined;
		// 视频 / 混合平台 ⇒ 走视频块（含「未下载本体」说明 + 原文链接），并附**字幕**（供 agent 总结视频内容）。
		// ⚠ 刻意**不下载视频本体**：动辄几十 MB～GB，会拖慢索引与飞书同步（飞书同步也不处理视频）。
		const md = isVideoPlatform
			? composeVideoMarkdown({
				url: target,
				platformName: platform.name,
				meta: { ...meta, cover: coverLocal ?? meta.cover },
				downloaded: false,
			})
			+ (meta.subtitleText ? `\n\n## 字幕（用于总结视频内容）\n\n${meta.subtitleText}\n` : '')
			+ (rewrittenBody.trim().length > 80 ? `\n\n## 正文\n\n${rewrittenBody.trim()}\n` : '')
			: composeArticleMarkdown({
				url: target,
				platformName: platform.name,
				meta: { ...meta, cover: coverLocal },
				body: rewrittenBody,
			});

		// ── 3. 落盘（防覆盖：同名追加 -2 / -3 …）────────────────────────────────
		const rawDir = URI.joinPath(vaultRoot, KB_LIBRARY_SUBPATH, KB_RAW_SUBPATH);
		let dest = URI.joinPath(rawDir, `${slug}.md`);
		for (let n = 2; n <= 50 && await fileService.exists(dest); n++) {
			dest = URI.joinPath(rawDir, `${slug}-${n}.md`);
		}
		try {
			await fileService.createFolder(rawDir);
		} catch { /* 已存在 */ }
		await fileService.writeFile(dest, VSBuffer.fromString(md));
		logService.info(`[KB importUrl] ✓ ${target} → ${dest.fsPath}（图片 ${images} 张）`);
		return {
			ok: true,
			path: dest.fsPath,
			title: title || slug,
			images,
			message: `已导入「${title || slug}」（图片 ${images} 张）`,
		};
	}

	/**
	 * 飞书云文档 → `库/raw/<slug>.md`（2026-09-23，含图片与画板/思维导图）。
	 *
	 * 流程（三步，全部依赖官方 CLI `lark-cli`）：
	 *  ① `docs +fetch --doc-format markdown`：正文一次拿全（标题 / 列表 / **表格** / **超链接**
	 *     由 CLI 转换好；`--detail with-ids` 保留块 ID，便于后续精确定位）；
	 *  ② 正文里的内嵌资源（`<img token>` / `<source token>` / `<whiteboard token>`）逐个
	 *     `docs +media-download` 落到 `库/raw/assets/<slug>/`；画板（**思维导图**）用
	 *     `--type whiteboard` 取缩略图；
	 *  ③ 把资源标签**原位**替换成本地相对引用后落盘。
	 *
	 * ⚠ 失败策略（用户明确要求「无法读取就提示」）：CLI 缺失 / 无权限 / 未登录一律
	 *   返回 `ok:false` + 可读原因，**不静默降级**成网页抓取（那只会落一个空壳 md）。
	 *   单个资源下载失败不回滚整篇：在 md 里留一行可读占位（见 `replaceFeishuMediaRefs`），
	 *   并在「导入方式」那行如实报出失败数量。
	 */
	private static async _importFeishuDoc(
		url: string,
		vaultRoot: URI,
		fileService: IFileService,
		logService: ILogService,
	): Promise<{ ok: boolean; path?: string; title?: string; images: number; message: string }> {
		// ① 前置：CLI 必须可用（未安装 ⇒ 明确告知，绝不用网页抓取顶替）
		const status = await getLarkCliStatus();
		if (!status.installed) {
			const why = status.error ? `（${status.error}）` : '';
			return {
				ok: false, images: 0,
				message: `无法读取飞书文档：未检测到飞书 CLI（${LARK_CLI_BIN}）${why}。`
					+ '请在「知识库设置 → 飞书」里一键安装后重试。',
			};
		}

		// ② 正文
		const fetched = await runLarkCli(
			['docs', '+fetch', '--doc', url, '--doc-format', 'markdown', '--detail', 'with-ids'],
			{ timeoutMs: 120_000 },
		);
		if (!fetched.ok && !fetched.stdout.trim()) {
			return { ok: false, images: 0, message: `无法读取飞书文档：${fetched.error ?? 'lark-cli 执行失败'}` };
		}
		const doc = parseFeishuDocFetch(fetched.stdout, fetched.stderr);
		if (!doc.ok || !doc.content) {
			// 权限不足 / 未登录 / 文档不存在都会走到这里，原因由 `larkCliErrorText` 从 error.hint 提取
			return { ok: false, images: 0, message: `无法读取飞书文档：${doc.error ?? 'CLI 未返回文档内容'}` };
		}

		// ③ 图片 / 画板本地化 → `库/raw/assets/<slug>/`
		const libRawDir = URI.joinPath(vaultRoot, KB_LIBRARY_SUBPATH, KB_RAW_SUBPATH);
		const title = doc.title ?? url;
		const slug = slugifyTitle(title, url);
		const refs = extractFeishuMediaRefs(doc.content);
		const relByKey = new Map<string, string>();
		let images = 0;
		if (refs.length > 0) {
			const assetsDir = URI.joinPath(libRawDir, 'assets', slug);
			try { await fileService.createFolder(assetsDir); } catch { /* 已存在 */ }
			for (let i = 0; i < refs.length; i++) {
				const ref = refs[i];
				// ⚠ `--output` **不带扩展名**：CLI 会按响应 Content-Type 自动补全（事先无从知道是 png/jpg）
				const stem = planFeishuMediaName(i, ref);
				const args = ['docs', '+media-download', '--token', ref.token,
					'--output', URI.joinPath(assetsDir, stem).fsPath, '--overwrite'];
				if (ref.kind === 'whiteboard') { args.push('--type', 'whiteboard'); }
				const r = await runLarkCli(args, { timeoutMs: 120_000 });
				const real = await KbImportController._findFileByStem(fileService, assetsDir, stem);
				if (!real) {
					logService.warn(`[KB importUrl] 飞书资源下载失败：${stem}（${r.error ?? (r.stderr || r.stdout).slice(0, 200)}）`);
					continue;
				}
				relByKey.set(planFeishuMediaKey(ref), `assets/${slug}/${real}`);
				images++;
			}
		}
		const body = replaceFeishuMediaRefs(doc.content, relByKey);

		// ④ 落盘（防覆盖：同名追加 -2 / -3 …，与普通网页导入同一约定）
		try { await fileService.createFolder(libRawDir); } catch { /* 已存在 */ }
		let dest = URI.joinPath(libRawDir, `${slug}.md`);
		for (let n = 2; n <= 50 && await fileService.exists(dest); n++) {
			dest = URI.joinPath(libRawDir, `${slug}-${n}.md`);
		}
		const md = composeFeishuDocMarkdown({
			url, title, body, images, mediaFailed: refs.length - images,
		});
		await fileService.writeFile(dest, VSBuffer.fromString(md));
		logService.info(`[KB importUrl] ✓ feishu doc ${url} → ${dest.fsPath}`
			+ `（正文 ${doc.content.length} 字符，资源 ${images}/${refs.length} 已本地化）`);
		return {
			ok: true,
			path: dest.fsPath,
			title,
			images,
			message: `已导入飞书文档「${title}」（图片 ${images} 张${refs.length - images > 0 ? `，${refs.length - images} 个资源未下载` : ''}）`,
		};
	}

	/**
	 * 在目录里按「主干名」找实际文件 —— 供飞书媒体下载使用：`--output` 不带扩展名时，
	 * 扩展名由 CLI 按响应的 Content-Type 决定，调用方事先并不知道，只能下完再按前缀查。
	 */
	private static async _findFileByStem(fileService: IFileService, dir: URI, stem: string): Promise<string | undefined> {
		try {
			const stat = await fileService.resolve(dir);
			const hit = (stat.children ?? []).find(c => !c.isDirectory && c.name.toLowerCase().startsWith(`${stem.toLowerCase()}.`));
			return hit?.name;
		} catch { return undefined; }
	}

	/**
	 * 阶段 2：「构建为笔记」—— 双阶段 LLM（分析 + FILE 块生成）将库文件转为结构化笔记。
	 *
	 * P2-1 Stage 1：LLM 结构化分析（类型 / 主题 / 落盘路径规划）
	 * P2-2 Stage 2：LLM 按 FILE 块格式一次性产出多文件，确定性落盘
	 *
	 * 实例方法：由 nativeChatEditorPane 使用；自动从 `this` 获取服务依赖和 vault root。
	 */
	async buildNotesFromLibrary(libFileUri: URI, vaultRootUri?: URI, opts?: { progressLabel?: string; reuseBuildSession?: boolean }): Promise<string | null> {
		// ⚠ 这里**不做**「未配置模型」检查：agentic 构建走的是 agent driver，本身不依赖
		//   `_resolveKbChatModel`（chatModel 仅用于导航/社区摘要，失败也只是没有摘要）。
		//   配置检查放在**入口**（Explorer 命令 / 视图两个入口），一处提醒一次，避免批量刷屏。
		// 统一反馈（无通知）：徽标转圈 + 视图内 label + 该文件节点转圈。
		// ⚠ 进度 label 支持调用方覆盖（批量/阶段 B 会传 `分析中 i/N：…`）；默认「构建中：文件名」。
		// ⚠ 收尾（active=false）由调用方负责：批量/连续场景若在这里清理，会在文件之间闪断。
		// ★ 2026-09-23：单文件构建 = 聊天框里**每次一个新的**会话（见 `_kbBuildSessionId` 的说明）。
		//   批量构建会传 `reuseBuildSession: true` ⇒ 整批共用，不会被这里逐个重置成 N 个会话。
		if (!opts?.reuseBuildSession) { this._kbBuildSessionId = undefined; this._kbBuildSessionUsed = false; }
		this._reportProcessing(true,
			opts?.progressLabel ?? `构建中：${libFileUri.path.split('/').pop() ?? ''}`,
			[libFileUri.fsPath]);
		const vaultRoot = vaultRootUri ?? this._resolveKbRootUri();
		// agentic 构建模式（默认开启，!== false 口径使未显式设置时也生效）：
		// 经 AgentDriverService 以 knowledge-base-expert agent 跑一轮，
		// 获得技能注入（obsidian-markdown/kb-build 等）与工具能力；无产出/失败回退确定性直连管线。
		if (this._agentDriverService && this._configurationService.getValue<boolean>(AGENT_STUDIO_KB_AGENTIC_BUILD) !== false) {
			try {
				const agenticResult = await this._buildNoteAgentic(libFileUri, vaultRoot);
				if (agenticResult) { return agenticResult; }
				this._logService.warn('[KbImportController] agentic build produced no notes, falling back to direct pipeline');
			} catch (e) {
				this._logService.warn('[KbImportController] agentic build failed, falling back to direct pipeline:', e);
			}
		}
		return KbImportController._buildNoteCore(
			libFileUri,
			vaultRoot,
			this._fileService,
			this._configurationService,
			this._logService,
			this._notificationService,
			this._agentStudioService,
			this._requestService,
		);
	}

	/**
	 * agentic 构建路径：素材交给 AgentDriverService（agentId = knowledge-base-expert），
	 * 收集其 FILE 块文本产出，落盘/缓存/导航/门控复用与 _buildNoteCore 相同的后半段。
	 * chatOnly=true：构建产出以文本 FILE 块返回，落盘统一由本控制器完成（不写会话之外的文件）。
	 */
	private async _buildNoteAgentic(libFileUri: URI, vaultRoot: URI): Promise<string | null> {
		// 2026-10-17（5.5 前置）：`executeFromChatOptions` 的调用删了（legacy 引擎要退役 ✓）——
		//   `driver` 变量不再用（只在下面的前置检查里用 `this._agentDriverService` ✓）。
		if (!this._agentDriverService) { return null; }
		const libDir = URI.joinPath(vaultRoot, KB_LIBRARY_SUBPATH);
		if (!libFileUri.fsPath.toLowerCase().startsWith(libDir.fsPath.toLowerCase())) { return null; }
		// ★ 2026-09-23 语义变更：**库 = 数据源层，笔记区 = 知识体系层**。
		//   构建产物（提炼归纳出的笔记）落**笔记区**，库只放素材与既有的存量笔记。
		//   ⇒ 门控 / 导航 / 补链 的扫描根同步改为笔记区（否则它们会「看不见新笔记」）。
		const notesDir = URI.joinPath(vaultRoot, KB_NOTES_SUBPATH);
		const baseName = libFileUri.path.split('/').pop() ?? '';
		if (SYS_INDEX_FILES.includes(baseName)) { return null; }

		// 构建缓存（与直连管线同一缓存文件）
		const cache = await readBuildCache(this._fileService, vaultRoot);
		const cachedNote = cache[libFileUri.fsPath];
		if (cachedNote) {
			// ★ 2026-09-24：与 `_buildNoteCore` 同一口径 —— 「缓存新鲜」（笔记存在且不比素材旧）才命中；
			//   素材在构建后又被改过 ⇒ 逐出并重建（`_cacheEntryFresh` 的论证）。
			if (await cacheEntryFresh(this._fileService, libFileUri, cachedNote)) { return cachedNote; }
			delete cache[libFileUri.fsPath];
			await writeBuildCache(this._fileService, vaultRoot, cache);
		}

		const libContent = (await this._fileService.readFile(libFileUri)).value.toString();
		const schema = await KbImportController._getSchemaStatic(this._fileService, vaultRoot);
		const schemaText = buildSchemaPromptText(schema);
		const { typeToDir, defaultTypeDir } = typeDirMapping(schema);
		// ⚠ 2026-09-23 修正（基线不对称）：基线**必须是笔记区** —— 后面是 `parseFileBlocks(gen, outputDir)`，
		//   而 `outputDir = notesDir`。原先是 `libDir.fsPath`（库）⇒ 模型按「相对库」写路径、解析却按
		//   「相对笔记区」，会产出嵌套错位的目录。同时把**笔记区全部子目录**（含用户手写层级）作为候选，
		//   让落点复用既有结构（★ 用户要求：如 `01_学习/UnrealEngine/09_UI与Slate/`）。
		const formatHint = buildFileBlockPrompt(notesDir.fsPath, await listAllNoteSubdirs(this._fileService, notesDir));
		// 图片清单 + 视觉总结指令（2026-09-22）：导入链接时图片已本地化到 `库/raw/assets/<素材名>/`，
		// 这里把清单交给 agent ⇒ 它逐张调用 vision_analyze 总结图片内容（该工具一次只接受一张图）。
		// 笔记正文必须保留**相对引用**（`assets/<素材名>/<文件名>`）：预览与飞书同步都按相对路径解析。
		let assetSection = '';
		try {
			const stem = (libFileUri.path.split('/').pop() ?? '').replace(/\.md$/i, '');
			const entries = await this._fileService.resolve(URI.joinPath(dirname(libFileUri), 'assets', stem));
			const imgs = (entries.children ?? []).filter(c => !c.isDirectory && /\.(png|jpe?g|gif|webp)$/i.test(c.name));
			if (imgs.length) {
				assetSection = [
					'## 图片清单（已下载到本地，请用 vision_analyze **逐张**总结图片内容）',
					...imgs.map((c, i) => `${i + 1}. ${c.name}（相对引用：assets/${stem}/${c.name}）`),
					'',
					`要求：对以上最多 ${Math.min(imgs.length, 8)} 张图片逐张调用 vision_analyze（一次一张图），把图片要点并入笔记；`,
					'正文引用必须写**相对路径** `assets/<素材名>/<文件名>`（写绝对路径会导致预览与飞书同步都失效）。',
				].join('\n');
			}
		} catch { /* 无 assets 目录 ⇒ 该素材没有图片 */ }

		const userPrompt = [
			'请将下面这份知识库素材构建为结构化笔记（先规划，再按 FILE 块格式输出全部笔记）。',
			'', '## Schema 类型定义', schemaText,
			'', '## 原始素材', libContent,
			...(assetSection ? ['', assetSection] : []),
			'', '## 指令', '为规划出的每篇笔记输出一个 FILE 块。',
			'若素材含视频原始链接，笔记中必须保留该 URL（原文行）；若含「字幕」段，据此总结视频内容。',
			formatHint,
		].join('\n');

		const chunks: string[] = [];
		// 对齐 Hermes 合成恢复语义：discard_prior_text ⇒ 已累计文本作废
		const onDelta = (d: { type?: string; content?: unknown }): void => {
			if (d.type === 'discard_prior_text') { chunks.length = 0; return; }
			if (d.type === 'content_replace' && typeof d.content === 'string') {
				chunks.length = 0; chunks.push(d.content); return;
			}
			if (d.type === 'text' && typeof d.content === 'string') { chunks.push(d.content); }
		};
		const agentId = KbImportController.KB_BUILD_AGENT_ID;
		const sendOptions = { agentId, chatOnly: true, temperature: 0.3 };
		// ★ 2026-09-23（用户要求「构建过程在聊天框中打开知识库专家 agent 的一个新 session」）：
		//   这一轮改走 **`IAgentChatService.sendMessage`**，不再直接用 driver。原因（已核实）：
		//     · `driver.executeFromChatOptions` 只**产流** —— 不落历史、不广播任何事件
		//       ⇒ 哪怕换成**真实** sessionId，聊天页签也不会显示任何内容；
		//     · `sendMessage` 内部会落 user/assistant 消息 + fire `onDidStreamDelta`
		//       ⇒ 已打开、且绑定**同一** sessionId 的聊天页签会走它的「外部接管」分支**实时渲染**这一轮
		//         （与手机端 sarosPocket 的范式一致）。
		//   ⚠ `chatOnly: true` **保持不变**：它只过滤写文件/执行类工具（`agentTurnExecutor` 的 WRITE_TOOLS），
		//     不影响历史落盘与可见性；笔记落盘本来就由本控制器负责。
		const chatService = this._agentChatService;
		const sessionId = chatService ? await this._ensureKbBuildChatSession() : undefined;
		if (chatService && sessionId) {
			// ⚠ 同一会话里的**后续素材**：先清空历史再跑（原因见 `_kbBuildSessionUsed` 的说明 ——
			//   `sendMessage` 会把全量历史当下发上下文，不清就会把前面素材的原文+产出重复喂进去）。
			if (this._kbBuildSessionUsed) {
				try { await chatService.replaceHistory(agentId, sessionId, []); }
				catch (e) { this._logService.warn('[KbImportController] 清空构建会话历史失败（继续构建）:', e); }
			}
			this._kbBuildSessionUsed = true;
			await chatService.sendMessage(agentId, userPrompt, { ...sendOptions, agentSessionId: sessionId }, onDelta);
		} else {
			// 2026-10-17（5.5 前置）：兜底分支删了——`executeFromChatOptions` 是 legacy 引擎的入口
			//   （要退役 ✓）。chatService 不在 / 会话创建失败 ⇒ 如实不跑（返回 null——调用方按
			//   "没产出"处理 ✓），不再走 legacy 引擎的 headless 兜底 ✗。
			this._logService.warn('[KbImportController] chatService 不在 / 会话创建失败 ⇒ 本轮构建不跑（不落历史、用户看不到）——legacy 引擎的 headless 兜底已退役');
			return null;
		}
		const gen = chunks.join('');
		if (!gen.trim()) { return null; }

		// ★ 2026-09-23：**产物落笔记区**（库 = 数据源层）。兜底也落笔记区 —— 产出的是笔记，不是素材。
		const outputDir = notesDir;
		const salvageDir = notesDir;
		const blocks = parseFileBlocks(gen, outputDir);
		let written: string[];
		if (blocks.length === 0) {
			this._logService.warn(`[KbImportController] agentic stage2 no FILE blocks parsed (output len=${gen.length})`);
			const libCat = parseLibCategory(libContent, libDir, libFileUri, this._logService);
			const safeName = sanitizeFsName(libCat.topic) || '未命名';
			const salvaged = await salvageSingleNoteToDir(gen, safeName, salvageDir, this._fileService);
			written = salvaged ? [salvaged] : [];
		} else {
			written = await writeFileBlocks(blocks, outputDir, vaultRoot, this._fileService, this._logService, typeToDir, defaultTypeDir);
		}
		if (written.length === 0) { return null; }

		this._logService.info(`[KbImportController] agentic build wrote ${written.length} note(s): ${written.join('; ')}`);
		cache[libFileUri.fsPath] = written[0];
		await writeBuildCache(this._fileService, vaultRoot, cache);
		const relFromLib = relativeFromLib(libFileUri, libDir);
		await KbImportController._injectSourcesIntoFiles(this._fileService, written, relFromLib);
		// ★ 2026-09-23：补链扫描根切到笔记区（笔记的新落点）
		await KbImportController._enrichNewNotes(this._fileService, notesDir, written, this._logService);
		// 导航 + 摘要：agentic 路径尝试解析 chatModel（仅用于社区/目录摘要），失败则无摘要（同视图路径行为）
		const chatModel = await KbImportController._resolveKbChatModel(this._agentStudioService, this._configurationService, this._requestService) ?? undefined;
		// ★ 2026-09-23：导航与门控都改扫**笔记区**（笔记的新落点；库只剩素材与存量笔记）
		await KbImportController.maintainKbNavigation(this._fileService, notesDir, chatModel);
		const gate = await applyDeabstractionGating(this._fileService, notesDir);
		this._logService.info(`[KbImportController] de-abstraction gating (agentic): ${gate.active} active, ${gate.pending} pending`);
		this._agentStudioService.requestKbRefresh();
		this._notificationService.notify({ severity: Severity.Info, message: `笔记构建完成（agentic）: ${written.join('; ')}`, source: 'kb-build' });
		return written[0];
	}

	/** 构建会话的标题：`知识库构建 · 09-23 14:05`（便于在会话列表里一眼认出，且同一分钟内可区分）。 */
	private static _kbBuildSessionName(now = new Date()): string {
		const p = (n: number) => String(n).padStart(2, '0');
		return `知识库构建 · ${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
	}

	/**
	 * 确保「本次构建过程」有一个**真实登记过**的聊天会话（知识库专家 agent），并把它的页签打开。
	 *
	 * 为什么必须"真实登记"：`IAgentChatService.sendMessage` 会把消息写进该会话的历史，
	 * 而**未登记**的临时 id 只会被 append 层顺手新建一个桶（用户看不到它出现在会话列表里）
	 * ⇒ 只有 `createAgentSession` 产出的 id 才是用户在聊天框里能找到的那个会话。
	 *
	 * 幂等：`_kbBuildSessionId` 已存在就直接复用（批量构建整批共用一个会话的关键）。
	 * 失败不抛：拿不到会话只是"看不到过程"，构建本身照常（调用方会退回 headless）。
	 */
	private async _ensureKbBuildChatSession(): Promise<string | undefined> {
		const chat = this._agentChatService;
		if (!chat) { return undefined; }
		if (this._kbBuildSessionId) { return this._kbBuildSessionId; }
		const name = KbImportController._kbBuildSessionName();
		try {
			const created = await chat.createAgentSession(KbImportController.KB_BUILD_AGENT_ID, name);
			const id = String((created as { id?: unknown } | undefined)?.id ?? '');
			if (!id) {
				this._logService.warn('[KbImportController] createAgentSession 未返回 id ⇒ 本轮构建退回 headless');
				return undefined;
			}
			this._kbBuildSessionId = id;
			await this._openKbBuildChatTab(id, name);
			this._logService.info(`[KbImportController] kb build chat session: ${id} (${name})`);
			return id;
		} catch (e) {
			this._logService.warn('[KbImportController] 创建构建会话失败 ⇒ 退回 headless:', e);
			return undefined;
		}
	}

	/**
	 * 在编辑器区打开一个**绑定该会话**的聊天页签（agent = 知识库专家）。
	 *
	 * ⚠ 页签必须绑到**同一个 sessionId**：nativeChatEditorPane 在消费广播 delta 时有守卫
	 *   `if (sessionId && this._currentSessionId && this._currentSessionId !== sessionId) return;`
	 *   ⇒ 绑错了就收不到「外部接管」的流式渲染。
	 * `NativeChatEditorInput.create` 每次会生成**唯一 chatId**（⇒ 新页签），符合"开一个新 session"的预期。
	 */
	private async _openKbBuildChatTab(sessionId: string, name: string): Promise<void> {
		try {
			const input = NativeChatEditorInput.create(undefined, KbImportController.KB_BUILD_AGENT_ID, sessionId, name);
			// ★ 2026-09-24（用户要求）：构建会话开在聊天框窗口的**新建 group** 里 ——
			//   与 presetAgentView「打开新聊天 tab 默认开在独立 group」同一套做法：
			//   优先复用空 group（避免拆出「空 group + 聊天 group」两个分栏），否则向右 addGroup 新建。
			type IChatGroup = { editors: readonly unknown[]; openEditor(i: unknown, o: unknown): Promise<unknown> };
			const agentPart = (this._editorGroupsService as unknown as { agentPart?: { activeGroup?: IChatGroup; groups: readonly IChatGroup[]; addGroup(g: IChatGroup, d: number): IChatGroup } } | undefined)?.agentPart;
			if (agentPart?.activeGroup) {
				const active = agentPart.activeGroup;
				const targetGroup = active.editors.length === 0
					? active
					: (agentPart.groups.find(g => g.editors.length === 0)
						?? agentPart.addGroup(active, 3 /* GroupDirection.RIGHT */));
				await targetGroup.openEditor(input, { pinned: true });
			} else {
				await this._editorService.openEditor(input, { pinned: true });
			}
		} catch (e) {
			// 打开页签失败**不该**影响构建（用户仍能在聊天框的会话列表里找到这个会话）
			this._logService.warn('[KbImportController] 打开构建会话页签失败（不影响构建）:', e);
		}
	}

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
		/** 视图内进度文案覆盖（批量构建传 `批量构建 i/N：…`）；缺省 `构建中：文件名`。 */
		progressLabel?: string,
	): Promise<string | null> {
		const libDir = URI.joinPath(vaultRoot, KB_LIBRARY_SUBPATH);

		if (!libFileUri.fsPath.toLowerCase().startsWith(libDir.fsPath.toLowerCase())) {
			logService.warn(`[KbImportController] buildNotes: not in library: ${libFileUri.fsPath}`);
			return null;
		}

		// 系统导航文件（index/overview/insights/log 等由 maintainKbNavigation 自动维护）不作为构建源，
		// 避免「构建为笔记」/批量构建把它们当素材抽取并污染构建缓存。
		const baseName = libFileUri.path.split('/').pop() ?? '';
		// ★ 统一反馈（2026-09-23）：**所有**构建路径（视图右键 / 批量 / 阶段 B / 聊天框）最终都经过
		//   本函数 ⇒ 处理状态来源唯一，观感自然一致（徽标转圈 + 「库/笔记」标题右侧文案 + 节点转圈）。
		reportProcessing(agentStudioService, logService, true,
			progressLabel ?? `构建中：${baseName}`, [libFileUri.fsPath]);
		if (SYS_INDEX_FILES.includes(baseName)) {
			notificationService.notify({ severity: Severity.Info, message: `${baseName} 是系统导航文件，无需构建。`, source: 'kb-build' });
			return null;
		}

		const cache = await readBuildCache(fileService, vaultRoot);
		const cachedNote = cache[libFileUri.fsPath];
		if (cachedNote) {
			// ★ 2026-09-24：命中条件从「笔记存在」升级为「缓存新鲜」—— 笔记存在 **且** 不比素材旧
			//   （素材在构建后又被改过 ⇒ 逐出缓存并重建；见 `_cacheEntryFresh` 的论证）。
			//   旧的「只查存在性」会让**改过的素材**直接返回幽灵旧笔记。
			if (await cacheEntryFresh(fileService, libFileUri, cachedNote)) {
				logService.info(`[KbImportController] build cache hit: ${libFileUri.fsPath} → ${cachedNote}`);
				notificationService.notify({ severity: Severity.Info, message: `已构建: ${cachedNote}`, source: 'kb-build' });
				return cachedNote;
			}
			delete cache[libFileUri.fsPath];
			await writeBuildCache(fileService, vaultRoot, cache);
			logService.info(`[KbImportController] build cache stale (note missing or source newer), evicted: ${cachedNote}`);
		}

		// lm 感知的前置判断：lm: 桥接 provider 已注册即可用，否则要求 BYOK provider 已配 key。
		// ★ 通知文案（2026-09-23 需求）：点明是「知识库专家」没配 Provider/模型，并给出配置路径
		//   （旧文案只说「请先配置 Chat Provider」，用户不知道去哪配、也不知道和「知识库专家」有关）。
		const kbChatAvailable = (agentStudioService as unknown as { isKbChatProviderAvailable?: () => boolean }).isKbChatProviderAvailable?.()
			?? isChatProviderConfigured(configService);
		if (!kbChatAvailable) {
			KbImportController.warnKbAgentNotConfigured(notificationService, '构建笔记');
			return null;
		}

		const chatModel = await KbImportController._resolveKbChatModel(agentStudioService, configService, requestService);
		if (!chatModel) {
			KbImportController.warnKbAgentNotConfigured(notificationService, '构建笔记');
			return null;
		}

		try {
			// FILE 块落盘锚点 = **笔记区**（2026-09-23 语义变更：库 = 数据源层，笔记区 = 知识体系层）。
			// LLM 按 prompt 依据**笔记区当前目录结构**自行决定相对路径（如 `内存管理/GC机制分析.md`）。
			// ⚠ 不能再锚定「源文件所在目录」：那会把路径嵌进 库/raw（库/raw/内存管理/…），
			//   既污染素材区，也让「知识体系」散落在数据源里。
			const notesDir = URI.joinPath(vaultRoot, KB_NOTES_SUBPATH);
			const outputDir = notesDir;
			// 兜底锚点同笔记区：salvage 没有路径信息，落笔记区根而不是素材旁
			const salvageDir = notesDir;
			const libContent = (await fileService.readFile(libFileUri)).value.toString();
			const schema = await KbImportController._getSchemaStatic(fileService, vaultRoot);
			const schemaText = buildSchemaPromptText(schema);
		// 类型 → 目录映射（含 id / label / dir 三种键）：模型未按 prompt 输出类型前缀时，
		// 依据笔记 frontmatter 的 type 字段二次归类到 库/<typeDir>/，避免笔记平铺到库根。
		const { typeToDir, defaultTypeDir } = typeDirMapping(schema);
		// ★ 2026-09-23：目录候选取自**笔记区**，且**只含引擎产出目录**（排除用户手写的 01_学习 等，
		//   用户明确要求「只把 LLM 自己建的目录作为候选」）—— LLM 据此决定新笔记的落点
		// ★ 2026-09-23（用户要求变更，**与旧口径相反**）：候选目录由「**只含引擎产出目录**」改为**全部子目录**
		//   —— 用户现在明确要求复用他自己的目录层级（如 `01_学习/UnrealEngine/09_UI与Slate/`），
		//   而不是让 LLM 另起一棵平行树（`UI优化与性能/`）。旧口径见 `_listEngineNoteDirs` 的说明。
		//   排序：**引擎产出目录在前**（LLM 自己建过的位置优先沿用），随后是所有其它目录（含手写层级）。
		const engineDirs = await listEngineNoteDirs(fileService, notesDir);
		const engineSet = new Set(engineDirs);
		const allDirs = await listAllNoteSubdirs(fileService, notesDir);
		const dirCandidates = [...engineDirs, ...allDirs.filter(d => !engineSet.has(d))];
			const dirCandidateList = dirCandidates.length
				? dirCandidates.map(s => `  - ${s}`).join('\n')
				: '  (none)';

			// Stage 1：结构化分析
			const analysis = await runStage1Analysis(libContent, schemaText, dirCandidateList, chatModel, logService);

			// Stage 2：FILE 块格式一次性多文件生成（相对 outputDir）
			// 传入笔记区**现有目录结构** ⇒ 模型「优先复用、必要时才新建」（见 buildFileBlockPrompt）
			const formatHint = buildFileBlockPrompt(outputDir.fsPath, dirCandidates);
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
				const libCat = parseLibCategory(libContent, libDir, libFileUri, logService);
				const safeName = sanitizeFsName(libCat.topic) || '未命名';
				const salvaged = await salvageSingleNoteToDir(gen, safeName, salvageDir, fileService);
				written = salvaged ? [salvaged] : [];
			} else {
				written = await writeFileBlocks(blocks, outputDir, vaultRoot, fileService, logService, typeToDir, defaultTypeDir);
			}

			if (written.length === 0) {
				notificationService.notify({ severity: Severity.Warning, message: 'LLM 未生成可写笔记（请检查模型输出格式）。', source: 'kb-build' });
				return null;
			}

			// 构建结果留痕：成功路径此前完全静默（仅瞬时通知），排查「笔记是否生成」只能靠猜。
			logService.info(`[KbImportController] buildNotes wrote ${written.length} note(s): ${written.join('; ')}`);

			cache[libFileUri.fsPath] = written[0];
			await writeBuildCache(fileService, vaultRoot, cache);
			// 构造完整的库内相对路径作为双链 target（而非仅文件名）
			const relFromLib = relativeFromLib(libFileUri, libDir);
			// 仅注入本次新写笔记（outputDir 已为库根，全库扫描注入会误伤无关笔记）
			await KbImportController._injectSourcesIntoFiles(fileService, written, relFromLib);
			// P2-2 确定性补链：对本次新写笔记扫描全库标题互链（零 LLM 成本），增强图谱连通性
			// ★ 2026-09-23：三处扫描根同步切到**笔记区**（笔记的新落点）
			await KbImportController._enrichNewNotes(fileService, notesDir, written, logService);
			// 传入 chatModel ⇒ insights.md 附带社区语义摘要（指纹缓存，失败回退纯列表）
			await KbImportController.maintainKbNavigation(fileService, notesDir, chatModel);
			// P0-1 去抽象化门控：派生类笔记按 distinct sources 数决定 pending/active
			const gate = await applyDeabstractionGating(fileService, notesDir);
			logService.info(`[KbImportController] de-abstraction gating: ${gate.active} active, ${gate.pending} pending`);
			agentStudioService.requestKbRefresh();
			notificationService.notify({ severity: Severity.Info, message: `笔记构建完成: ${written.join('; ')}`, source: 'kb-build' });
			return written[0];
		} catch (err) {
			logService.error('[KbImportController] buildNotesFromLibrary failed:', err);
			return null;
		}
	}

	/** 批量构建所有未处理的库文件（实例方法）。★ 2026-09-23：默认走 **agent 多轮**（见下面的 buildOne）。 */
	async buildAllPendingNotes(vaultRootUri?: URI): Promise<number> {
		const vaultRoot = vaultRootUri ?? this._resolveKbRootUri();
		// ★ 2026-09-23：一次批量 = 聊天框里**一个**新会话（用户要求「构建过程开一个新 session」）。
		//   置空 ⇒ 首次进入 agentic 时新建；之后每个素材都**复用**它（不会刷出 N 个页签）。
		this._kbBuildSessionId = undefined;
		this._kbBuildSessionUsed = false;
		return KbImportController._buildAllPendingCore(
			vaultRoot,
			this._fileService,
			this._configurationService,
			this._logService,
			this._notificationService,
			this._agentStudioService,
			this._requestService,
			// ★ 批量也要享受 agent 多轮：把「单篇构建」交给**实例方法** `buildNotesFromLibrary` ——
			//   它内部按 `AGENT_STUDIO_KB_AGENTIC_BUILD !== false`（默认开）调 `_buildNoteAgentic`
			//   （以 knowledge-base-expert agent 跑一轮，带技能注入与工具能力），
			//   失败 / 无产出时**自动回落**直连 `_buildNoteCore`。
			//   ⇒ 批量与单文件右键「构建为笔记」走的是**同一条**路径（含进度 label 透传）。
			//   `reuseBuildSession: true` ⇒ 整批**共用**一个聊天会话（否则每个素材都会新建一个页签）
			(file, label) => this.buildNotesFromLibrary(file, vaultRoot, { progressLabel: label, reuseBuildSession: true }),
		);
	}

	/**
	 * ★ 2026-09-24：**只读预检** —— 列出当前待构建的素材（相对「库」的路径）。
	 *
	 * 供 agent 的 `kb_build` 工具（`mode:'preview'`）使用，也是「要不要构建到笔记」
	 * 这句询问的事实依据：让 agent 给出**准确数字与清单**，而不是"大概有几份"。
	 *
	 * ⚠ 与真实构建**共用** `_collectPendingSources` ⇒ 口径天然一致（导航文件、已构建过的源、
	 *   本身就是产出的笔记都会被正确排除）。副作用仅限「PDF/docx → 同名 .md」的素材暂存
	 *   （真实构建同样要做这一步，不是额外副作用）。
	 */
	static async previewPendingSources(
		fileService: IFileService, vaultRoot: URI, logService: ILogService,
		notificationService: INotificationService, agentStudioService: IAgentStudioService,
	): Promise<string[]> {
		const { libDir, pending } = await collectPendingSources(
			fileService, vaultRoot, logService, notificationService, agentStudioService,
		);
		return pending.map(u => relativeFromLib(u, libDir));
	}

	/**
	 * ★ 2026-09-23（用户需求）：**一个 agent 会话搞定整批 —— 宿主只给路径，agent 自己读、自己写**。
	 *
	 * 与 `_buildAllPendingCore`（宿主读文件 → 解析 FILE 块 → **宿主落盘**）的本质区别：
	 *   · 宿主只把**素材路径清单**交给 agent，由 agent 用 `file_read` **依次读取**原文；
	 *   · agent 用 `file_write` / `patch` **自己把笔记写进 `笔记/`** ⇒ 所以这一轮**绝不能**再传
	 *     `chatOnly: true`（它会过滤掉写文件类工具）。写入落在沙箱允许根内（vault 已注册在
	 *     `agentStudio.kb.vaults` 的 customPath 里），默认 `edit: auto` 策略对**沙箱内的写**免审批
	 *     ⇒ 无人值守也能跑完（⚠ 提示词里明确禁用 `terminal`：execute 档会弹审批）。
	 *   · 多文件 ⇒ **一条** prompt（不是每个文件一条），上下文由 agent 自己的阅读节奏决定。
	 *
	 * 随后在**同一会话**追加第二条 prompt：让 agent 依据 `笔记/` 现有**目录与文件**
	 * 创建/完善**知识体系文档**（`笔记/知识体系.md`）—— 即「帮助用户构建知识体系」。
	 *
	 * 产出识别（宿主侧双保险，因为落盘不再经过宿主）：
	 *   ① 流里的工具结果：`file_write` 返回 `wrote N chars to <绝对路径>`（coreTools 的实现）；
	 *   ② `笔记/` 目录**前后快照 diff**（新增文件）。
	 * 收尾与旧路径一致：按新笔记 frontmatter 的 `sources` 反查来源 → 写构建缓存 → 补链 → 门控 → 导航。
	 *
	 * 降级：没有 chat 服务 / 会话建不出来 ⇒ 自动回落 `buildAllPendingNotes`（宿主逐篇落盘）。
	 */
	async buildPendingAsAgentSession(
		vaultRootUri?: URI,
		/** 可选：合成工具卡句柄（视图传入；构建在聊天里呈现为**一次工具调用**，并由视图在 finally 收尾）。 */
		toolCard?: IToolCardHandle,
	): Promise<{ pending: number; built: number; skipped: number; systemDoc: string | null; usedFallback: boolean }> {
		KbImportController._buildInFlight++;
		try {
			return await this._buildPendingAsAgentSessionInner(vaultRootUri, toolCard);
		} finally {
			KbImportController._buildInFlight--;
		}
	}

	private async _buildPendingAsAgentSessionInner(
		vaultRootUri?: URI,
		toolCard?: IToolCardHandle,
	): Promise<{ pending: number; built: number; skipped: number; systemDoc: string | null; usedFallback: boolean }> {
		const vaultRoot = vaultRootUri ?? this._resolveKbRootUri();
		const { libDir, notesDir, pending, cache } = await collectPendingSources(
			this._fileService, vaultRoot, this._logService, this._notificationService, this._agentStudioService,
		);
		if (pending.length === 0) {
			// 用户主动点了按钮却"没有任何反应"是最糟的反馈 ⇒ 空结果必须可见（与 _buildAllPendingCore 同文案）
			this._logService.info('[KbImportController] agent build: nothing pending');
			this._notificationService.notify({
				severity: Severity.Info,
				message: '批量构建：「库」中没有待构建的素材。'
					+ '（已构建过的笔记，以及 index / overview / insights / 知识体系 等导航文件会被自动跳过；'
					+ '可用「导入链接 / URL」或右键导入素材后再试。）',
				source: 'kb-build',
			});
			return { pending: 0, built: 0, skipped: 0, systemDoc: null, usedFallback: false };
		}

		// ⚠ 一次交给 agent 的素材数量**封顶**：这是无人工介入的长任务，路径太多会跑很久、烧很多 token
		//   （剩余的下次构建会继续处理 —— 它们仍在 pending 里）。
		const MAX_ASSETS = 20;
		const assets = pending.slice(0, MAX_ASSETS);
		const skipped = pending.length - assets.length;

		const chat = this._agentChatService;
		// 新会话（用户要求「构建过程在聊天框里开一个 session」）
		this._kbBuildSessionId = undefined;
		this._kbBuildSessionUsed = false;
		const sessionId = chat ? await this._ensureKbBuildChatSession() : undefined;
		if (!chat || !sessionId) {
			this._logService.warn('[KbImportController] agent 自主构建不可用（无 chat 服务 / 会话创建失败）⇒ 回落宿主逐篇落盘');
			const built = await this.buildAllPendingNotes(vaultRoot);
			return { pending: pending.length, built, skipped: 0, systemDoc: null, usedFallback: true };
		}

		// ── 聊天呈现：**一张合成工具卡**（`kb_build`），而不是把清单/目录树刷成用户气泡 ──────────
		// ★ 2026-09-24（用户要求：「点构建按钮后聊天框显示大量文本 ⇒ 优雅些，封装成一次工具调用」）：
		//   ① 两条 prompt 改为 `hidden`（只喂模型、不落盘不渲染，见下 `sendOptions`）—— 数据仍完整到达 agent；
		//   ② 这里开一张 `kb_build` 合成卡（通用工具卡：标题=displayName、运行中转圈、progressText 显进度、
		//      终态显 result），里程碑进度由下面的 `report()` 推进；
		//   ③ 终态**由调用方收尾**（视图在 `finally` 里用 `toolCard` 句柄关卡片）⇒ 抛异常也不会卡在「执行中」。
		const toolCallId = `kb_build_${Date.now().toString(36)}`;
		if (toolCard) { toolCard.toolCallId = toolCallId; }
		this._agentStudioService.requestToolCard({
			toolCallId,
			name: 'kb_build',
			displayName: '构建知识库',
			args: JSON.stringify({ assets: assets.length, skipped, vault: vaultRoot.fsPath }),
		});
		const report = (progressText: string, progress?: number): void => {
			this._logService.info(`[KbImportController] kb build: ${progressText}`);
			this._agentStudioService.toolCardProgress({ toolCallId, progress, progressText });
		};
		report(`准备中（${assets.length} 份素材${skipped > 0 ? `，本次先处理 ${assets.length} 份` : ''}）`, 5);

		const before = new Set((await collectMdFiles(this._fileService, notesDir))
			.map(u => u.fsPath.toLowerCase()));
		const agentId = KbImportController.KB_BUILD_AGENT_ID;
		const toolWrites = new Set<string>();
		const orgMoved: { from: string; to: string }[] = [];
		const onDelta = (d: { type?: string; content?: unknown }): void => {
			if (d.type !== 'tool_end' && d.type !== 'tool_result') { return; }
			if (typeof d.content !== 'string') { return; }
			// `file_write` 的结果串自带落地路径：`wrote N chars to <path>`
			const m = /wrote\s+\d+\s+chars\s+to\s+(.+?)\s*$/im.exec(d.content);
			if (m) { toolWrites.add(m[1].replace(/^["'`]|["'`]$/g, '')); }
			// `kb_organize` 的结果带机器可读行（宿主据此修正构建缓存 —— 笔记被移动后，缓存里的旧路径会失效）
			const org = /KB_ORGANIZE_RESULT\s+(\{.*\})/.exec(d.content);
			if (org) {
				try {
					const parsed = JSON.parse(org[1]) as { moved?: { from?: unknown; to?: unknown }[] };
					for (const mv of parsed.moved ?? []) {
						if (typeof mv.from === 'string' && typeof mv.to === 'string') { orgMoved.push({ from: mv.from, to: mv.to }); }
					}
				} catch { /* 解析失败不影响构建 */ }
			}
		};
		// ★ 2026-09-24：`hidden: true` ⇒ 这两条 prompt **只喂模型，不落盘、不广播、不渲染为用户气泡**
		//   （此前「素材清单 + 笔记区目录树」作为用户消息显示在聊天框里 ⇒ 用户反馈「显示了大量文本」）。
		//   聊天里的可见呈现改为上面的 `kb_build` 合成工具卡。
		const sendOptions = { agentId, agentSessionId: sessionId, temperature: 0.3, hidden: true };
		// ★ 2026-09-23（用户要求「构建时发送太多消息 ⇒ 抽象成技能」）：规则**全部移进技能 `kb-build`**
		//   （`resources/.agents/skills/kb-build/SKILL.md`），消息只带**数据**（素材清单 + 目录树快照 + 路径）；
		//   经 `explicitSkillIds` 把技能挂载进本轮（它会作为独立 user message 注入）。
		//   schema 文件仍由宿主确保存在 —— agent 会用 file_read 自己读它（`_getSchemaStatic` 缺省时写默认值）。
		await KbImportController._getSchemaStatic(this._fileService, vaultRoot);
		const treeText = await KbImportController._describeNoteTree(this._fileService, notesDir);
		const skillOptions = { ...sendOptions, explicitSkillIds: ['kb-build'] };

		// ── Phase 1：素材路径清单 → agent 自行 read + write（注意：**不传 chatOnly** ⇒ 允许写工具）
		report('Phase 1：读取素材并写入笔记…', 15);
		await chat.sendMessage(agentId, KbImportController._kbAgentBuildPrompt(assets, libDir, notesDir, treeText), skillOptions, onDelta);

		// ── Phase 2：同一会话里发一句话触发技能的 Phase 2（知识体系文档 + 结构重构；规则全在技能里）
		const phase2Text: string[] = [];
		const onPhase2Delta = (d: { type?: string; content?: unknown }): void => {
			onDelta(d);   // 工具结果照旧收集（用于识别「知识体系.md」的写入）
			if (d.type === 'discard_prior_text') { phase2Text.length = 0; return; }
			if (d.type === 'content_replace' && typeof d.content === 'string') { phase2Text.length = 0; phase2Text.push(d.content); return; }
			if (d.type === 'text' && typeof d.content === 'string') { phase2Text.push(d.content); }
		};
		report('Phase 2：构建知识体系文档…', 70);
		await chat.sendMessage(agentId, KbImportController._kbSystemDocPrompt(), skillOptions, onPhase2Delta);

		// ── 收尾：找出本次产出（工具自报路径 ∪ 目录快照新增），再照旧做缓存/补链/门控/导航
		const written = new Set<string>();
		for (const p of toolWrites) {
			if (p.toLowerCase().startsWith(notesDir.fsPath.toLowerCase())) { written.add(p); }
		}
		for (const u of await collectMdFiles(this._fileService, notesDir)) {
			if (!before.has(u.fsPath.toLowerCase())) { written.add(u.fsPath); }
		}
		// 「知识体系.md」是导航类文档（已加入 SYS_INDEX_FILES），**不算**笔记 ⇒ 不参与缓存/补链
		const docName = '知识体系.md';
		const systemDoc = [...written].find(p => p.toLowerCase().endsWith(docName)) ?? null;
		const notePaths = [...written].filter(p => !p.toLowerCase().endsWith(docName));

		// 缓存回填：按**新笔记自己的 frontmatter `sources`** 反查来源 —— agent 直接写盘后，宿主只
		// 能靠这条线索建立「素材 → 笔记」映射（口径用 `normalizeSourceRef`，与门控/体检完全一致）。
		const libByRef = new Map<string, URI>();
		for (const u of pending) { libByRef.set(normalizeSourceRef(relativeFromLib(u, libDir)), u); }
		for (const notePath of notePaths) {
			try {
				const text = (await this._fileService.readFile(URI.file(notePath))).value.toString();
				for (const s of extractSources(text)) {
					const src = libByRef.get(normalizeSourceRef(s));
					if (src) { cache[src.fsPath] = notePath; }
				}
			} catch { /* 单篇读失败不影响其它 */ }
		}
		await writeBuildCache(this._fileService, vaultRoot, cache);
		// agent 用 `kb_organize` 自己动了目录 ⇒ 缓存里指向旧路径的值必须跟着改，否则下次构建按幽灵路径跳过
		if (orgMoved.length > 0) {
			let fixed = 0;
			for (const [k, v] of Object.entries(cache)) {
				const hit = orgMoved.find(mv => mv.from.toLowerCase() === v.toLowerCase());
				if (hit) { cache[k] = hit.to; fixed++; }
			}
			if (fixed > 0) { await writeBuildCache(this._fileService, vaultRoot, cache); }
			this._logService.info(`[KbImportController] kb_organize: ${orgMoved.length} 项移动（构建缓存修正 ${fixed} 条）`);
		}
		report('收尾：构建缓存 / 补链 / 导航维护…', 88);
		await KbImportController._enrichNewNotes(this._fileService, notesDir, notePaths, this._logService);
		const gate = await applyDeabstractionGating(this._fileService, notesDir);
		this._logService.info(
			`[KbImportController] agent 自主构建：pending=${pending.length} 笔记=${notePaths.length} 体系文档=${systemDoc ?? '无'}；`
			+ `门控 ${gate.active} active / ${gate.pending} pending`,
		);
		const chatModel = await KbImportController._resolveKbChatModel(this._agentStudioService, this._configurationService, this._requestService) ?? undefined;
		await KbImportController.maintainKbNavigation(this._fileService, notesDir, chatModel);
		this._agentStudioService.requestKbRefresh();
		this._notificationService.notify({
			severity: Severity.Info,
			message: `知识库构建完成（agent 自主读取素材并写盘）：新增/更新 ${notePaths.length} 篇笔记`
				+ `${systemDoc ? '，并已创建/完善知识体系文档' : ''}`
				+ `${skipped > 0 ? `（本次先处理 ${assets.length} 份素材，剩余 ${skipped} 份可再次构建）` : ''}`,
			source: 'kb-build',
		});
		// ── 结构重构（用户要求「LLM 也可以完善补充，甚至重构」）：解析 Phase 2 文本里的 KB_REORG 计划，
		//    **先备份、再请用户确认**，确认后由宿主执行（agent 没有移动/删除工具 ⇒ 只能出计划）。
		const plan = await KbImportController._parseReorgPlan(phase2Text.join(''), vaultRoot, notesDir, this._fileService, this._logService);
		if (plan.moves.length > 0) {
			const head = plan.moves.slice(0, 3).map(mv => `· ${mv.fromRel} → ${mv.toRel}`).join('\n');
			this._notificationService.prompt(Severity.Info,
				`agent 提出 ${plan.moves.length} 项目录重构建议${plan.reason ? `：${plan.reason}` : ''}\n${head}`
					+ `${plan.moves.length > 3 ? `\n…（共 ${plan.moves.length} 项）` : ''}\n应用前会自动备份到 vault 之外。`,
				[
					{ label: '应用重构', run: () => { void this._applyReorgPlan(plan, vaultRoot, notesDir); } },
					{ label: '跳过', isSecondary: true, run: () => undefined },
				]);
		}
		// 合成工具卡的**成功摘要**（由视图在 finally 里连同 toolCallId 一起提交，见 `_batchBuildAll`）
		if (toolCard) {
			toolCard.summary = `新增/更新 ${notePaths.length} 篇笔记`
				+ `${systemDoc ? '，并已创建/完善知识体系文档' : ''}`
				+ `${skipped > 0 ? `（本次处理 ${assets.length} 份，剩余 ${skipped} 份可再次构建）` : ''}`;
		}
		report('完成', 100);
		return { pending: pending.length, built: notePaths.length, skipped, systemDoc, usedFallback: false };
	}

	/** Phase 2 文本里的「重构计划」块：`<!-- KB_REORG {…json…} -->`。 */
	private static readonly KB_REORG_RE = /<!--\s*KB_REORG\s*([\s\S]*?)-->/i;

	/** 一次重构最多接受多少项（防模型失控输出上千条）。 */
	private static readonly KB_REORG_MAX_MOVES = 50;

	/**
	 * 解析 Phase 2 输出里的 `<!-- KB_REORG {…} -->` 计划，并做**安全校验**（不通过就丢弃该项 —— 绝不猜）。
	 *
	 * 为什么必须由**宿主**执行：agent 的工具集里**没有**移动/删除类工具（只有
	 * `file_read / file_write / patch / search_files / terminal / kb_search / vision_analyze`）⇒ 它没法真正搬运
	 * 文件；而 `terminal` 属 execute 档、会逐次弹审批，不适合无人值守。所以「允许 LLM 重构」落地为：
	 * **LLM 出计划 → 宿主先备份 → 用户确认 → 宿主执行**（用户要求：「LLM 也可以完善补充，甚至重构」）。
	 *
	 * 校验规则（任一不满足即跳过该项）：
	 *   · `from` / `to` 都必须落在**笔记区**内（保护「库」与 vault 其它内容）；
	 *   · `from` 必须**已存在**、`to` 必须**尚不存在**（避免覆盖）；
	 *   · 拒绝含 `..` 的路径；`from === to` 跳过；最多 `KB_REORG_MAX_MOVES` 项。
	 */
	private static async _parseReorgPlan(
		text: string, vaultRoot: URI, notesDir: URI, fileService: IFileService, logService: ILogService,
	): Promise<{ reason: string; moves: { from: URI; to: URI; fromRel: string; toRel: string }[] }> {
		const moves: { from: URI; to: URI; fromRel: string; toRel: string }[] = [];
		const m = KbImportController.KB_REORG_RE.exec(text);
		if (!m) { return { reason: '', moves }; }
		let raw: { reason?: unknown; moves?: unknown };
		try { raw = JSON.parse(m[1].trim()); }
		catch (e) { logService.warn('[KbImportController] KB_REORG 计划 JSON 解析失败:', e); return { reason: '', moves }; }

		const rel = (u: URI) => u.path.replace(vaultRoot.path, '').replace(/^\//, '');
		const resolve = (p: unknown): URI | undefined => {
			if (typeof p !== 'string' || !p.trim()) { return undefined; }
			const s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
			if (s.includes('..')) { return undefined; }
			return /^[a-zA-Z]:\//.test(s) || s.startsWith('/') ? URI.file(s) : URI.joinPath(vaultRoot, ...s.split('/'));
		};
		const notesPrefix = notesDir.fsPath.toLowerCase();
		const list = Array.isArray(raw.moves) ? raw.moves.slice(0, KbImportController.KB_REORG_MAX_MOVES) : [];
		for (const item of list) {
			const it = item as { from?: unknown; to?: unknown };
			const from = resolve(it.from);
			const to = resolve(it.to);
			if (!from || !to) { continue; }
			const f = from.fsPath.toLowerCase(), t = to.fsPath.toLowerCase();
			if (f === t) { continue; }
			if (!f.startsWith(notesPrefix) || !t.startsWith(notesPrefix)) {
				logService.warn(`[KbImportController] 重构项越出笔记区，已跳过: ${from.fsPath} → ${to.fsPath}`);
				continue;
			}
			try { await fileService.resolve(from); } catch { continue; }        // from 必须存在
			let exists = false;
			try { await fileService.resolve(to); exists = true; } catch { /* 目标不存在 = 可用 */ }
			if (exists) { logService.warn(`[KbImportController] 重构目标已存在，已跳过: ${to.fsPath}`); continue; }
			moves.push({ from, to, fromRel: rel(from), toRel: rel(to) });
		}
		return { reason: typeof raw.reason === 'string' ? raw.reason : '', moves };
	}

	/**
	 * 执行重构计划（**宿主代 agent 执行**）：
	 *   ① **先备份**到 vault **之外**；② 逐个 `move`（自动建父目录）；③ 修正构建缓存里指向旧路径的值；
	 *   ④ 重跑导航 / 门控并通知结果。
	 *
	 * ⚠ 备份目录**绝不能放进 vault 内**：知识库文件树会把 vault 内的一切列出来、备份文件还能被点开
	 *   （此前踩过这个坑）⇒ 放 `<vault 的父目录>/<vault 名>-backup-kbreorg-<ts>/`。
	 * ⚠ **备份失败就不搬这个文件**：宁可少搬几项，也不能让用户失去还原能力。
	 */
	private async _applyReorgPlan(
		plan: { reason: string; moves: { from: URI; to: URI; fromRel: string; toRel: string }[] },
		vaultRoot: URI, notesDir: URI,
	): Promise<void> {
		const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
		const vaultName = vaultRoot.path.split('/').pop() ?? 'vault';
		const backupDir = URI.joinPath(dirname(vaultRoot), `${vaultName}-backup-kbreorg-${stamp}`);
		let backedUp = 0, moved = 0;
		const failed: string[] = [];
		for (const mv of plan.moves) {
			try {
				await this._fileService.copy(mv.from, URI.joinPath(backupDir, ...mv.fromRel.split('/')), true);
				backedUp++;
			} catch (e) {
				failed.push(`${mv.fromRel}（备份失败：${String(e)}）`);
				continue;
			}
			try {
				await this._fileService.createFolder(dirname(mv.to));
				await this._fileService.move(mv.from, mv.to, false);
				moved++;
			} catch (e) {
				failed.push(`${mv.fromRel} → ${mv.toRel}（${String(e)}）`);
			}
		}
		// 缓存里的「值」是笔记的绝对路径 ⇒ 搬完必须跟着改，否则下次构建会按幽灵路径跳过
		try {
			const cache = await readBuildCache(this._fileService, vaultRoot);
			let fixed = 0;
			for (const [k, v] of Object.entries(cache)) {
				const hit = plan.moves.find(mv => mv.from.fsPath.toLowerCase() === v.toLowerCase());
				if (hit) { cache[k] = hit.to.fsPath; fixed++; }
			}
			if (fixed > 0) { await writeBuildCache(this._fileService, vaultRoot, cache); }
		} catch (e) { this._logService.warn('[KbImportController] 重构后修正构建缓存失败:', e); }

		const chatModel = await KbImportController._resolveKbChatModel(this._agentStudioService, this._configurationService, this._requestService) ?? undefined;
		await KbImportController.maintainKbNavigation(this._fileService, notesDir, chatModel).catch(() => undefined);
		await applyDeabstractionGating(this._fileService, notesDir).catch(() => undefined);
		this._agentStudioService.requestKbRefresh();
		this._notificationService.notify({
			severity: failed.length ? Severity.Warning : Severity.Info,
			message: `目录重构完成：移动 ${moved} 项${backedUp ? `（已备份 ${backedUp} 份到 ${backupDir.fsPath}）` : ''}`
				+ `${failed.length ? `；${failed.length} 项失败：${failed.slice(0, 3).join('；')}` : ''}`,
			source: 'kb-build',
		});
		this._logService.info(`[KbImportController] reorg applied: moved=${moved} failed=${failed.length} backup=${backupDir.fsPath} reason=${plan.reason}`);
	}

	/**
	 * 渲染「笔记区现有目录树」文本，供构建提示词使用。
	 *
	 * ★ 2026-09-23（用户要求）：落点要**依据笔记里已有的目录结构**，例如把 UI 优化笔记放进
	 *   `笔记/01_学习/UnrealEngine/09_UI与Slate/`，而不是凭空新建 `笔记/UI优化与性能/` 这种平行树。
	 *
	 * ⚠ 与 `_listEngineNoteDirs()` 的口径**相反**：那个函数刻意**排除**手写区（`01_学习/…` 这类数字前缀
	 *   目录），依据是当时「只把 LLM 自己建的目录作为候选」的旧要求；用户现在明确要求复用他自己的层级
	 *   ⇒ 本函数**包含全部目录**（手写区也进树）。
	 *
	 * 预算控制（prompt 不能被超大 vault 撑爆）：深度 ≤ 4 层、总行数 ≤ 400、每个目录最多列 6 个文件名。
	 */
	private static async _describeNoteTree(fileService: IFileService, notesDir: URI): Promise<string> {
		const out: string[] = [];
		const MAX_LINES = 400, MAX_DEPTH = 4, MAX_FILES = 6;
		let lines = 0;
		const walk = async (dir: URI, depth: number): Promise<void> => {
			if (depth > MAX_DEPTH || lines >= MAX_LINES) { return; }
			let children: readonly IFileStat[];
			try { children = (await fileService.resolve(dir)).children ?? []; } catch { return; }
			const subdirs = children.filter(c => c.isDirectory && !c.name.startsWith('.'));
			const files = children.filter(c => !c.isDirectory && c.name.endsWith('.md') && !SYS_INDEX_FILES.includes(c.name));
			if (depth > 0) {
				const shown = files.slice(0, MAX_FILES).map(f => f.name).join('、');
				const noteInfo = files.length
					? `  （${files.length} 篇：${shown}${files.length > MAX_FILES ? '、…' : ''}）`
					: '';
				out.push(`${'  '.repeat(depth - 1)}- ${dir.path.split('/').pop() ?? ''}/${noteInfo}`);
				lines++;
			}
			for (const d of subdirs) {
				if (lines >= MAX_LINES) { out.push('  …（目录过多，已截断）'); break; }
				await walk(d.resource, depth + 1);
			}
		};
		await walk(notesDir, 0);
		return out.join('\n');
	}

	/**
	 * Phase 1 提示词：**只给路径**，让 agent 自己 `file_read` + `file_write`（与宿主落盘路径的本质差异）。
	 * 素材路径给的是**绝对路径**（`file_read` 可直接解析），而 `sources` 引用给的是**相对「库」的路径**
	 * （与 wikilink / 门控 / 体检的口径一致）。
	 *
	 * ★ 2026-09-23（用户要求「产物满足 schema 类别 + 依据已有目录结构」）：
	 *   · 把**真实目录树**（`treeText`，含用户手写层级）交给 agent，落点**优先复用已有目录**；
	 *   · `type` 必须取自 schema（类别合规靠 frontmatter；schema 的 `dir` 只在无从归属时兜底）。
	 */
	private static _kbAgentBuildPrompt(assets: readonly URI[], libDir: URI, notesDir: URI, treeText: string): string {
		const rows = assets.map((u, i) => `${i + 1}. 素材文件：${u.fsPath}\n   （sources 引用：${relativeFromLib(u, libDir)}）`);
		return [
			'执行技能 **kb-build** 的 Phase 1（把素材构建为结构化笔记）。完整手册见技能本体，本消息只带数据：',
			'', `## 素材清单（共 ${assets.length} 份，按顺序全部处理完才算完成）`,
			...rows,
			'', '## 笔记区现有目录树（落点优先复用这里的目录）',
			treeText || `（${notesDir.fsPath} 目前还没有任何目录）`,
			'', 			`笔记区路径：${notesDir.fsPath}`,
			'', '**三条硬约束**：① 落点优先复用上面的已有目录（能复用绝不新建）；② frontmatter 的 `sources` 必须用上面给出的引用；',
			'③ 正文里的图片用相对路径 `assets/<素材名>/…`（绝对路径会让预览与同步失效）。其余全部按技能执行。',
		].join('\n');
	}

	/**
	 * Phase 2 消息：一句话触发 —— 知识体系文档 + 结构重构的完整约定在技能 `kb-build` 的 Phase 2 里
	 * （★ 2026-09-23「规则移进技能」：消息只带触发语，不再重复整份规则）。
	 */
	private static _kbSystemDocPrompt(): string {
		return '执行技能 **kb-build** 的 Phase 2：依据笔记区当前真实的目录与文件，创建或完善 `知识体系.md`，'
			+ '并按需提交结构重构（小规模直接 kb_organize，大规模输出 KB_REORG 计划）。';
	}

	/**
	 * 批量构建（**静态**入口：直连管线，**不跑 agent**）。
	 *
	 * ★ 2026-09-23：UI 的「批量构建库」已改走**实例版** `buildAllPendingNotes` 以获得 agent 多轮；
	 *   本静态入口保留给「无控制器实例」的场景与单测（行为与旧版一致：逐篇直连 `_buildNoteCore`）。
	 */
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

	/**
	 * 计算「待构建素材」清单 —— **两条批量路径共用**（宿主逐篇落盘 / agent 自主读写），口径必须一致：
	 *   ① 先把 PDF/docx 落成同目录同名 `.md`（`_stageDocSourcesToText`，**必须在枚举之前**）；
	 *   ② 读构建缓存 `<vault>/.kb-build-cache.json`；
	 *   ③ 递归枚举「库」内 `.md`，排除系统导航文件（index/overview/insights/知识体系…）；
	 *   ④ 过滤掉「已构建过的源」（缓存键）与「本身就是别人产出的笔记」（缓存值）。
	 *
	 * @returns `libDir` = `<vault>/库`；`notesDir` = `<vault>/笔记`；`pending` = 待构建素材；`cache` = 当前缓存内容
	 */


	private static async _buildAllPendingCore(
		vaultRoot: URI,
		fileService: IFileService,
		configService: IConfigurationService,
		logService: ILogService,
		notificationService: INotificationService,
		agentStudioService: IAgentStudioService,
		requestService?: IRequestService,
		/**
		 * 单篇构建回调（可选，2026-09-23 新增）。
		 *
		 * 存在的意义：让批量构建也能享受 **agent 多轮**。回调由**实例**调用方传入
		 * （实例 `buildAllPendingNotes` 传的是实例方法 `buildNotesFromLibrary` ⇒ 它内部按
		 * `AGENT_STUDIO_KB_AGENTIC_BUILD` 决定走 `_buildNoteAgentic`，失败/无产出再自动回落直连管线）。
		 *
		 * · 传了 ⇒ 用回调（agentic 或直连，由回调自己决定）；
		 * · 没传（静态入口 / 单测）⇒ 保持旧行为，直接调 `_buildNoteCore` 直连管线。
		 *
		 * @param file 待构建的库素材
		 * @param progressLabel 视图内进度文案（`批量构建 i/N：文件名`）
		 * @returns 产出的**首篇笔记绝对路径**；失败/无产出 = `null`
		 */
		buildOne?: (file: URI, progressLabel: string) => Promise<string | null>,
	): Promise<number> {
		// ★ 2026-09-23（用户需求）：pending 计算已提取为 `_collectPendingSources` —— 现在有**两条**
		//   批量路径要用它（宿主逐篇落盘 / agent 自主读写），口径必须完全一致，不能再各写一份。
		const { notesDir, pending } = await collectPendingSources(
			fileService, vaultRoot, logService, notificationService, agentStudioService,
		);
		if (pending.length === 0) {
			// ★ 2026-09-23 修「点『批量构建笔记』没有任何反应」：
			//   原先此分支**完全静默**（只写日志）⇒ 用户主动点了按钮却看不到任何反馈
			//   （实测日志只有一行 `batch build: nothing pending`，看起来就像命令没生效）。
			//   这类「用户操作的空结果」必须可见 ⇒ 发一条 Info 通知说明**为什么没东西可构建**。
			//   （与「批量构建成功时不逐个文件发通知」的既有约定不冲突：它只在完全无素材时出现一次。）
			logService.info('[KbImportController] batch build: nothing pending');
			notificationService.notify({
				severity: Severity.Info,
				message: '批量构建：「库」中没有待构建的素材。'
					+ '（已构建过的笔记，以及 index / overview / insights 等导航文件会被自动跳过；'
					+ '可用「导入链接 / URL」或右键导入素材后再试。）',
				source: 'kb-build',
			});
			reportProcessing(agentStudioService, logService, false);
			return 0;
		}
		let built = 0;
		for (let i = 0; i < pending.length; i++) {
			const f = pending[i];
			// 进度 label 交给单篇构建方法统一上报（两处都报会互相覆盖）
			const label = `批量构建 ${i + 1}/${pending.length}：${f.path.split('/').pop() ?? ''}`;
			// ★ 2026-09-23：优先用调用方给的 `buildOne`（实例版传入的是 `buildNotesFromLibrary`
			//   ⇒ 默认开启 agent 多轮，失败/无产出自动回落直连管线）；没给则用直连 `_buildNoteCore`。
			const notePath = buildOne
				? await buildOne(f, label)
				: await KbImportController._buildNoteCore(f, vaultRoot, fileService, configService, logService, notificationService, agentStudioService, requestService, label);
			if (notePath) { built++; }
		}
		// P0-1 去抽象化门控（统一收敛一次）。★ 2026-09-23：笔记落点已改为笔记区 ⇒ 扫笔记区
		const gate = await applyDeabstractionGating(fileService, notesDir);
		logService.info(`[KbImportController] de-abstraction gating (batch): ${gate.active} active, ${gate.pending} pending`);
		reportProcessing(agentStudioService, logService, false);
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
		const libDir = URI.joinPath(root, KB_LIBRARY_SUBPATH);
		// 清理 topic 中的非法文件名字符（Windows: < > : " / \ | ? *）并限长
		const safeTopic = sanitizeFsName(topic);
		const safeTypeDir = sanitizeFsName(typeDir);
		// 导入的原始材料统一落到 <vault>/库/raw/（不再按 schema 分 typeDir/topic 子目录），
		// 分类交由后续「构建为笔记」阶段处理；raw 即未加工的原始落盘区。
		const targetDir = URI.joinPath(libDir, KB_RAW_SUBPATH);
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
		if (!sameFsPath(cachedPath, relocatedUri.fsPath)) {
			try {
				await this._fileService.move(URI.file(cachedPath), relocatedUri, true);
				cache[dedupKey] = relocatedUri.fsPath;
				await this._writeIngestCache(cacheUri, cache);
				this._logService.info(`[KbImportController] relocated cached lib file: ${cachedPath} -> ${relocatedUri.fsPath}`);
				await removeDirIfEmpty(this._fileService, URI.file(cachedPath.slice(0, cachedPath.length - fileBase.length - 1)));
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
		const libDir = URI.joinPath(root, KB_LIBRARY_SUBPATH);
		const targetDir = URI.joinPath(libDir, KB_RAW_SUBPATH);
		await this._fileService.createFolder(targetDir);
		const hash = Math.abs(content.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)).toString(36);
		const dedupKey = `${hash}:${content.length}`;
		const cacheUri = URI.joinPath(root, '.kb-ingest-cache.json');
		const cache = await this._readIngestCache(cacheUri);
		const dedupHit = await this._handleDedupHit(dedupKey, targetDir, cacheUri, cache);
		if (dedupHit) { return dedupHit; }

		// 原始文件名（保留扩展名）；同名不同内容时追加 -2/-3 后缀
		const origName = sanitizeFsName(sourceFile.fsPath.split(/[\\/]/).pop() ?? 'import.bin');
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








	private _resolveKbRootUri(): URI {
		return resolveActiveVaultRoot(this._storageService, this._envService, this._logService);
	}

	private _resolveLibraryDir(vaultRootUri?: URI): URI {
		return URI.joinPath(vaultRootUri ?? this._resolveKbRootUri(), KB_LIBRARY_SUBPATH);
	}

	private _resolveNotesDir(vaultRootUri?: URI): URI {
		return URI.joinPath(vaultRootUri ?? this._resolveKbRootUri(), KB_NOTES_SUBPATH);
	}

	/**
	 * `uri` 是否落在 vault 根之内（**含根自身**）。大小写不敏感（Windows/macOS 友好）。
	 *
	 * ⚠ 必须比对**目录边界**（`=== root` 或 `root + '/'` 前缀）：早先用裸 `startsWith`，
	 *   会把 `…/kb-backup/a.md` 误判成在 `…/kb` 之内；该判定现在同时用于「右键导入前置
	 *   过滤（跳过库内文件）」，误判会直接导致**该导入的被跳过 / 库文件被搬走**。
	 */

	private _isWithinVault(uri: URI, vaultRoot: URI): boolean {
		return isWithinVault(uri, vaultRoot);
	}


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




	private async _readIngestCache(uri: URI): Promise<Record<string, string>> {
		try { return JSON.parse((await this._fileService.readFile(uri)).value.toString()); } catch { return {}; }
	}

	private async _writeIngestCache(uri: URI, cache: Record<string, string>): Promise<void> {
		try { await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(cache, null, 2))); } catch { /* ignore */ }
	}

	private async _writeLegacyFavorite(content: string): Promise<void> {
		// 降级兜底：写入本地备份文件（dev 下 userDataPath 为 ~/.vssaros-dev，跟随 dev）
		const dir = URI.joinPath(URI.file(this._envService.userDataPath), 'favorites');
		await this._fileService.createFolder(dir);
		const ts = Date.now();
		await this._fileService.writeFile(
			URI.joinPath(dir, `favorite_${ts}.md`),
			VSBuffer.fromString(content)
		);
	}

	/** 给本次新写笔记注入来源双链（仅这批文件，避免全库扫描误注入无关笔记）。 */
	private static async _injectSourcesIntoFiles(fileService: IFileService, notePaths: string[], sourceRel: string): Promise<void> {
		for (const p of notePaths) {
			try {
				const f = URI.file(p);
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
			const allNotes = await collectMdFiles(fileService, allNotesDir);
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
			// ★ 只对**可预览**的文件打开编辑器（2026-09-23 修「库里 PDF 显示乱码」）：
			//   · 文本类（md/txt/json…）⇒ 普通编辑器
			//   · PDF / Word ⇒ 注册好的只读查看器（resolver 自动路由）
			//   · 其余非文本（zip / 图片 / 音视频…）⇒ **不自动打开**（丢给编辑器就是满屏乱码）
			const isText = /\.(md|markdown|txt|json|ya?ml|log|csv)$/i.test(filePath);
			const isDocViewer = /\.(pdf|docx)$/i.test(filePath);
			if (!isText && !isDocViewer) { return; }
			const uri = URI.file(filePath);
			void this._editorService.openEditor({ resource: uri, options: { pinned: true, preserveFocus: true } });
		} catch (err) { this._logService.warn(`[KbImportController] _openKbViewAndNavigate failed: ${err}`); }
	}

	// ─── 静态方法：导航维护 ──────────────────────────────────────────────────

	/** 统一维护入口：index + overview + insights。传入 chatModel 时 insights 附带社区语义摘要 + 各目录 `.overview.md` 中间层。 */
	static async maintainKbNavigation(fileService: IFileService, notesDir: URI, chatModel?: IChatModel): Promise<void> {
		await Promise.all([
			KbImportController.maintainKbIndex(fileService, notesDir),
			KbImportController.maintainKbOverview(fileService, notesDir),
		]);
		await KbImportController.maintainKbInsights(fileService, notesDir, chatModel);
		// P1-3 目录摘要中间层（仅构建路径传 chatModel 时；freshness ≥10% 才重算，内部不抛）
		if (chatModel) {
			await refreshTopicOverviews(fileService, notesDir, chatModel);
		}
	}

	static async maintainKbIndex(fileService: IFileService, notesDir: URI): Promise<void> {
		const notes = await collectMdFiles(fileService, notesDir, SYS_INDEX_FILES);
		const groups = new Map<string, { rel: string; name: string }[]>();
		const root = notesDir.fsPath.replace(/\\/g, '/');
		for (const n of notes) {
			const p = n.fsPath.replace(/\\/g, '/');
			const rel = p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
			const relNoExt = rel.replace(/\.md$/i, '');
			const segs = relNoExt.split('/');
			const dirType = segs.length > 1 ? segs[0] : '(root)';
			const name = segs[segs.length - 1];
			const type = await readNoteFrontmatterType(fileService, n) || dirType;
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
		const notes = await collectMdFiles(fileService, notesDir, SYS_INDEX_FILES);
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
			const type = await readNoteFrontmatterType(fileService, n) || dirType;
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

	static async maintainKbInsights(fileService: IFileService, notesDir: URI, chatModel?: IChatModel): Promise<void> {
		const notes = await collectMdFiles(fileService, notesDir, SYS_INDEX_FILES);
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

		// P0-2 社区语义摘要（对齐 GraphRAG community reports）：仅当调用方提供 chatModel 时启用，
		// 缓存按成员指纹命中，失败回退纯成员列表（summarizeCommunities 内部不抛）。
		const summaries = await summarizeCommunities(
			fileService,
			notesDir,
			communityEntries.map(([id, members]) => ({ id, members })),
			chatModel,
		);

		const out: string[] = [
			'# 知识图谱洞察', '',
			`> ${notes.length} 篇笔记，${edges.length} 条链接，${communityEntries.length} 个社区。`, '',
		];
		for (const [cid, comNodes] of communityEntries) {
			const s = summaries.get(cid);
			out.push(`## 社区 ${cid}（${comNodes.length} 节点）${s?.topic ? `：${s.topic}` : ''}`);
			if (s?.summary) { out.push(`> ${s.summary.replace(/\n+/g, ' ')}`, ''); }
			for (const nd of comNodes.slice(0, 20)) { out.push(`- [[${nd}]]`); }
			if (comNodes.length > 20) { out.push(`- ... 还有 ${comNodes.length - 20} 个节点`); }
			out.push('');
		}
		out.push('---', '', '*由 KbImportController 自动维护，基于 Louvain 社区检测算法生成。*');
		const insightsUri = URI.joinPath(notesDir, 'insights.md');
		await KbImportController._writeIfChanged(fileService, insightsUri, out.join('\n'));
	}

	static async appendKbLog(fileService: IFileService, targetDir: URI, entry: string): Promise<void> {
		try {
			const logUri = URI.joinPath(targetDir, 'log.md');
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



	static async _writeIfChanged(fileService: IFileService, uri: URI, content: string): Promise<void> {
		try {
			const existing = (await fileService.readFile(uri)).value.toString();
			if (existing === content) { return; }
		} catch { /* file doesn't exist yet */ }
		await fileService.writeFile(uri, VSBuffer.fromString(content));
	}

	public static async _collectAgentNotesUnderTargetDir(fileService: IFileService, targetDir: URI): Promise<URI[]> {
		return collectMdFiles(fileService, targetDir, SYS_INDEX_FILES);
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
