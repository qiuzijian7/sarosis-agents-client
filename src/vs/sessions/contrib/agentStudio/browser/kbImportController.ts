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
import type { IChatModel } from './knowledge/llm.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { AGENT_STUDIO_KB_VIEW_ID } from '../common/constants.js';
import { isChatProviderConfigured } from './knowledge/knowledgeAdapters.js';
import { extractSources, injectSources } from './knowledge/frontmatter.js';
import { canonicalizeTitle, loadKbAliases } from './knowledge/kbAliases.js';
import { dirname } from '../../../../base/common/resources.js';
import { detectCommunities } from './knowledge/communityDetection.js';
import type { CommunityEdge } from './knowledge/communityDetection.js';
import { IKBSchema, loadKbSchema, buildSchemaPromptText, sanitizeKbTopic } from './knowledge/kbSchema.js';
import type { SchemaClassifyResult } from './knowledge/classifier.js';
import type { IAgentDriverService } from '../common/agentDriver.js';
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

import { DshPluginPageEditorInput } from '../../dshHarness/electron-browser/dshPluginPageEditorInput.js';

/**
 * ★ 2026-11-07（换 UI 宿主）：知识库「分析归类 / 构建笔记」的 UI 与回合统一由
 * dsh `/x/kb/` 页承载 —— `vssaros-kb` 的 `kb_build` 工具 + 会话 + 批授权 + 子代理
 * （`lib/index.js:4524`、`kbAgent.js` 的 `KB_PRESET` / `ensureKbAgent`）。
 * IDE 侧只负责把素材落盘与打开页面，不再新建 IDE 聊天 tab、不再跑 IDE agent loop。
 *
 * 与 `dshHarness.contribution.ts` 的 `case 'openModulePage'` 同一落点：容器单例输入
 * （`dshModuleContainers.ts` 的 knowledgeBase 容器），tab 名取「知识库」✓
 */
export async function openKbBuildDshPage(editorService: IEditorService): Promise<void> {
	const input = DshPluginPageEditorInput.getOrCreate('agentStudio.knowledgeBase', '知识库', '/x/kb/');
	await editorService.openEditor(input, { pinned: true });
}

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
		_agentDriverService?: IAgentDriverService,
		/**
		 * 可选：聊天会话服务。
		 *
		 * ★ 2026-09-23（用户要求「构建过程在聊天框中打开知识库专家 agent 的一个新 session」）：
		 *   **只有它能让构建过程在聊天框里可见** —— agentic 那一轮改走 `sendMessage`
		 *   （它内部落历史 + 广播 `onDidStreamDelta`），而 `IAgentDriverService` 只**产流**、
		 *   不落盘、不广播 ⇒ 即使用真实 sessionId，用户在聊天框里也什么都看不到。
		 *   未注入时自动退回 headless（旧行为）；单测走的就是这条。
		 */
		_agentChatService?: IAgentChatService,
		/**
		 * 可选：编辑器组服务。
		 *
		 * ★ 2026-09-24（用户要求「构建会话在聊天框窗口的 group 中，新建一个 group」）：
		 *   有了它，`_openKbBuildChatTab` 才能在聊天框所在的 agentPart 里**新建一个编辑器组**
		 *   （与 presetAgentView「打开新聊天 tab 默认开在独立 group」同一套做法）；
		 *   未注入时退回普通 openEditor（单测走这条）。
		 */
		_editorGroupsService?: IEditorGroupsService,
	) {
		super();
	}


	/**
	// ★ 2026-11-07（换 UI 宿主）：IDE 侧「构建会话」字段已删 —— 构建改由 dsh `/x/kb/` 的会话承载。

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
	 * 组合入口：「入口」(落盘到库) + 打开 dsh `/x/kb/` 页。
	 *
	 * ★ 2026-11-07（换 UI 宿主）：阶段 2 的「自动构建笔记」已迁到 dsh `/x/kb/` 页的
	 *   `kb_build`（工具 + 会话 + 批授权）。IDE 侧只负责把素材落盘到「库」分区并打开页面，
	 *   **不再跑任何构建**（连静态直连管线也不跑）。
	 * 供聊天框 write_file 卡片、工作区文件右键「导入知识库」等一键操作调用。
	 *
	 * @param sourceFile 可选：原始文件 URI（文件导入场景）。传入后库分区保存原始文件副本。
	 * @param opts.skipOpen 跳过打开 dsh 页（批量/静默场景）。
	 * @returns 落盘是否成功（入口失败时直接返回 false）。
	 */
	async importContentAndBuild(content: string, currentAgentId: string | null, vaultRootUri?: URI, sourceFile?: URI, opts?: { skipOpen?: boolean; quiet?: boolean }): Promise<boolean> {
		try {
			const entryOk = await this.handleFavoriteMessage(content, currentAgentId, vaultRootUri, sourceFile, opts);
			if (!entryOk) { return false; }
			const libUri = this._lastLibUri;
			this._logService.info(`[KbImportController] staged to library: ${libUri?.fsPath ?? '(none)'}`);
			// 落盘成功即算成功；构建由 dsh 页承接（skipOpen 时不打扰用户）。
			if (!opts?.skipOpen) {
				try {
					await openKbBuildDshPage(this._editorService);
				} catch (err) {
					// 页面打不开不能把「已落库」误报成失败：素材是安全的，给日志即可。
					this._logService.warn('[KbImportController] 打开 dsh 知识库页失败（素材已落库，可手动打开）：', err);
				}
			}
			return true;
		} finally {
			// 统一收尾：清「处理中」标记 + 徽标转「有新增」（所有入口同一套反馈）。
			this._reportProcessing(false);
		}
	}

	// ─── 阶段 2：构建笔记 ────────────────────────────────────────────────────

	/**
	 * 「导入链接 / URL」（2026-09-22）：抓取网页正文 → **下载图片到知识库** → 改写引用 → 组装 markdown
	 * → 落盘 `数据源/raw/<slug>.md`。之后可直接「构建为笔记」，其本地图片也能被飞书同步上传
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
	 * 飞书云文档 → `数据源/raw/<slug>.md`（2026-09-23，含图片与画板/思维导图）。
	 *
	 * 流程（三步，全部依赖官方 CLI `lark-cli`）：
	 *  ① `docs +fetch --doc-format markdown`：正文一次拿全（标题 / 列表 / **表格** / **超链接**
	 *     由 CLI 转换好；`--detail with-ids` 保留块 ID，便于后续精确定位）；
	 *  ② 正文里的内嵌资源（`<img token>` / `<source token>` / `<whiteboard token>`）逐个
	 *     `docs +media-download` 落到 `数据源/raw/assets/<slug>/`；画板（**思维导图**）用
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

		// ③ 图片 / 画板本地化 → `数据源/raw/assets/<slug>/`
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
		// ★ 2026-11-07（换 UI 宿主）：IDE 侧聊天会话/agentic 构建已退役，`reuseBuildSession`
		//   参数保留只为兼容既有调用签名（不再有可复用的会话）。
		this._reportProcessing(true,
			opts?.progressLabel ?? `构建中：${libFileUri.path.split('/').pop() ?? ''}`,
			[libFileUri.fsPath]);
		const vaultRoot = vaultRootUri ?? this._resolveKbRootUri();
		// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建分支已整体退役 ——
		//   构建改由 dsh `/x/kb/` 页的 `kb_build` 承载；这里保留**静态直连管线**
		//   （只做分类/落盘，不跑 IDE agent loop），保证「导入到知识库」仍有产物。
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

	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


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
		return KbImportController._buildAllPendingCore(
			vaultRoot,
			this._fileService,
			this._configurationService,
			this._logService,
			this._notificationService,
			this._agentStudioService,
			this._requestService,
			// ★ 批量也要享受 agent 多轮：把「单篇构建」交给**实例方法** `buildNotesFromLibrary` ——
			//   它内部走静态直连管线 `_buildNoteCore`（IDE 侧 agentic 构建已于 2026-11-07 换宿主退役）
			//   （以 knowledge-base-expert agent 跑一轮，带技能注入与工具能力），
			//   失败 / 无产出时**自动回落**直连 `_buildNoteCore`。
			//   ⇒ 批量与单文件右键「构建为笔记」走的是**同一条**路径（含进度 label 透传）。
			//   `reuseBuildSession: true` ⇒ 保持调用签名兼容（IDE 侧聊天会话已退役）
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

	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


	// ★ 2026-11-07（换 UI 宿主）：IDE 侧 agentic 构建链已整体退役 ——
	//   构建改由 dsh `/x/kb/` 页的 `kb_build` 工具 + 会话 + 批授权承接；
	//   IDE 侧只保留静态直连管线 `_buildNoteCore` / `_buildAllPendingCore` 与落盘能力。


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
	 *   ② 读构建缓存 `<vault>/.kb/build-cache.json`；
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
		 * 统一走静态直连管线 `_buildNoteCore`；完整的 LLM 构建由 dsh `/x/kb/` 页承载）。
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
		const cacheUri = URI.joinPath(root, '.kb/ingest-cache.json');
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
		const cacheUri = URI.joinPath(root, '.kb/ingest-cache.json');
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
		const indexUri = URI.joinPath(KbImportController._navDir(notesDir), 'index.md');
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
		const overviewUri = URI.joinPath(KbImportController._navDir(notesDir), 'overview.md');
		await KbImportController._writeIfChanged(fileService, overviewUri, out.join('\n'));
	}

	static async maintainKbInsights(fileService: IFileService, notesDir: URI, chatModel?: IChatModel): Promise<void> {
		const notes = await collectMdFiles(fileService, notesDir, SYS_INDEX_FILES);
		if (notes.length === 0) {
			const empty = [
				'# 知识图谱洞察', '',
				'> 暂无笔记数据，导入消息后自动生成。', '',
			].join('\n');
			const insightsUri = URI.joinPath(KbImportController._navDir(notesDir), 'insights.md');
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
		const insightsUri = URI.joinPath(KbImportController._navDir(notesDir), 'insights.md');
		await KbImportController._writeIfChanged(fileService, insightsUri, out.join('\n'));
	}

	static async appendKbLog(fileService: IFileService, targetDir: URI, entry: string): Promise<void> {
		try {
			const logUri = URI.joinPath(KbImportController._navDir(targetDir), 'log.md');
			const ts = new Date().toISOString();
			let existing = '';
			try { existing = (await fileService.readFile(logUri)).value.toString(); } catch { /* new file */ }
			const line = `- ${ts} ${entry}\n`;
			if (!existing.includes(entry)) {
				// ★ 2026-11-02：日志也在 .kb/nav/ 下 ⇒ 首次写入要先建目录
				try { await fileService.createFolder(URI.joinPath(logUri, '..')); } catch { /* 已存在 */ }
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



	/**
	 * ★ 2026-11-02：导航 / 日志这类**派生物**统一落到 `<vault>/.kb/nav/`。
	 *   `notesDir` 恒为 `<vault>/知识库列表` ⇒ 上跳一层就是库根；URL 里用 `..` 由 `URI.joinPath` 归一化。
	 *   与插件侧 `organize.js` 的 `.kb/nav` 同一口径（两边视图看到的位置一致 ✓）。
	 */
	static _navDir(notesDir: URI): URI {
		return URI.joinPath(notesDir, '..', '.kb', 'nav');
	}

	static async _writeIfChanged(fileService: IFileService, uri: URI, content: string): Promise<void> {
		try {
			const existing = (await fileService.readFile(uri)).value.toString();
			if (existing === content) { return; }
		} catch { /* file doesn't exist yet */ }
		// 写前建父目录（`.kb/nav` 首次使用时不存在；已存在会抛，忽略即可）
		try { await fileService.createFolder(URI.joinPath(uri, '..')); } catch { /* 已存在 / 只读盘 */ }
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
