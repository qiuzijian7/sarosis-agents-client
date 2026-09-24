/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置 Tool Provider —— 见 `common/providers.ts` 中的 `IToolProvider` 契约。
 *
 * 设计借鉴 Hermes-Agent `tools/registry.py`：
 *   - 每个工具用一个常量描述符注册（schema + handler + check）。
 *   - `category` 充当 hermes 的 toolset，便于 UI 按组展示与启停。
 *   - `check_fn` 决定该工具在当前环境是否可用（例如 shell_exec 仅在桌面端）。
 *
 * 与 hermes 不同的地方：
 *   - 这里的 handler 是 TS async 函数，返回 IToolResultContent[]（更贴合 IMcpTool 风格）。
 *   - 不做 prompt-cache TTL 缓存（VSCode renderer 周期短，不必要）。
 *   - 文件操作走 IFileService，而非 Node.js fs；所以在 web 端也能跑 file_read/file_write。
 *
 * 工具集合：
 *   utility   : clarify
 *   filesystem: file_read, file_write, search_files, patch
 *   shell     : terminal (仅 desktop)
 *   web       : web_search, web_extract (需外部 provider，未配置则降级提示)
 *
 *   另外，从 Hermes-Agent 迁移了 69 个 bundled tool 定义（schema-only）。
 *   这些工具只有 schema，handler 为存根，返回"未实现"提示。
 *   实际执行需通过 MCP 服务器或后续实现的 Provider。
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IWebContentExtractorService } from '../../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ISearchService } from '../../../../../../workbench/services/search/common/search.js';
import { IKbNativeKernelService } from '../../kbNativeKernelService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../../../nls.js';
import { IAiEmbeddingVectorService } from '../../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IRequestService } from '../../../../../../platform/request/common/request.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult } from '../../../common/providers.js';
import {
	AGENT_STUDIO_UNREAL_BRIDGE_URL_SETTING,
	AGENT_STUDIO_WEB_SEARCH_PROVIDER_SETTING,
	AGENT_STUDIO_WEB_SEARCH_SEARXNG_URL_SETTING,
	AGENT_STUDIO_WEB_SEARCH_TAVILY_KEY_SETTING,
	AGENT_STUDIO_WEB_SEARCH_BRAVE_KEY_SETTING,
	AGENT_STUDIO_WEB_SEARCH_EXA_KEY_SETTING,
	AGENT_STUDIO_WEB_SEARCH_CACHE_ENABLED_SETTING,
	AGENT_STUDIO_BROWSER_CDP_ENABLED_SETTING,
	AGENT_STUDIO_BROWSER_CDP_LAUNCH_DEDICATED_SETTING,
	AGENT_STUDIO_BROWSER_CDP_PORT_SETTING,
	AGENT_STUDIO_BROWSER_COOKIES_FROM_BROWSER_SETTING,
} from '../../../common/constants.js';
import { BROWSER_CDP_CHANNEL, BrowserCdpReachabilityGate, DEFAULT_CDP_PORT, dedicatedPortFor } from '../../../common/browserCdp.js';
import type { BrowserCdpRequest, IBrowserCdpResponse, IBrowserCdpStatus } from '../../../common/browserCdp.js';
import { registerBrowserTools, type BrowserToolContext } from './browserTools.js';
import type { IBrowserCdpInvoker } from '../../browserCdpClient.js';
import { getToolsetForTool, UTILITY_BUCKET_WHITELIST } from '../../../common/toolsetConfig.js';
import { ISkillRegistry } from '../../../common/skills.js';
import { IModelSelectorService } from '../../../common/modelSelector.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { resolveToolMutationKey, withFileMutationQueue } from '../../../common/fileMutationQueue.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IAgentStudioService, ITaskOrchestrationService, IAgentTaskBoardService, IAgentChatService } from '../../../../../common/agentStudioService.js';
import { ITriageService } from '../../../common/triageService.js';
import { ISwarmService } from '../../../common/swarmService.js';
import { ICheckpointService } from '../../../common/checkpointService.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { IWorkflowStorageService } from '../../../common/workflowStorage.js';
import { resolveEffectiveWorktreeRoot } from '../../../common/worktreeBinding.js';
import { SkillManagerTool } from '../../skillManagerTool.js';
import { SkillUsageTracker } from '../../skillUsageTracker.js';
import { ICodebaseGraphService } from '../../codebaseGraphService.js';
import { AdrManager } from '../../codebaseGraphAdr.js';
import { registerCodebaseTools } from './codebaseTools.js';
import { registerKanbanTools } from './kanbanTools.js';
import { registerWorkflowTools } from './workflowTools.js';
import { registerCanvasTools } from './canvasTools.js';
import { registerImageGenTools } from './imageGenTools.js';
import { registerMindmapTools } from './mindmapTools.js';
import { createMediaStoreProxy } from '../../mediaStoreProxy.js';
import { IMainProcessService } from '../../../../../../platform/ipc/common/mainProcessService.js';
import { IPlaywrightService } from '../../../../../../platform/browserView/common/playwrightService.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
// ★ 2026-09-24：`kb_build` 要按「知识库视图」那样**造一个 KbImportController**（同一份管线、
//   同一套服务），故需 views / notification 两个服务（前者用于打开知识库视图，后者用于
//   「知识库专家未配置模型」的提醒与构建失败通知）。
import { IViewsService } from '../../../../../../workbench/services/views/common/viewsService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { ISessionsManagementService } from '../../../../../../sessions/services/sessions/common/sessionsManagement.js';
import { IKanbanRecipeService } from './kanbanRecipeService.js';
import { SearchHelpers } from './searchHelpers.js';
import { registerWebTools, type WebToolContext, type IWebPageCacheLike } from './webTools.js';
import { DEFAULT_WEB_SEARCH_CONFIG } from './webSearchProviders.js';
import { WebPageCache, type IWebCacheStore } from './webPageCache.js';
import { WebSearchMemo } from './webSearchMemo.js';
import { selectWebExtractSpillFilesToDelete, webExtractSpillFileName } from './webExtractSpill.js';
import { SarosPath, resolveSarosPath, userDataRootFromPath } from '../../../common/sarosPaths.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { registerBundledTools, type BundledToolContext } from './bundledTools.js';
import { registerUnifiedMemoryTools, type UnifiedMemoryToolContext } from './unifiedMemoryTools.js';
import { registerMemoryTools, type MemoryToolContext } from './memoryTools.js';
import { registerAdvancedMemoryTools, type AdvancedMemoryToolContext } from './advancedMemoryTools.js';
import { registerRoutineCrystalFacetTools, type RoutineCrystalFacetToolContext } from './routineCrystalFacetTools.js';
import { registerSkillTools, type SkillToolContext } from './skillTools.js';
import { registerCompatibilityTools, type CompatToolContext } from './compatibilityTools.js';
import { registerDelegationTools, type DelegationToolContext } from './delegationTools.js';
import { registerPlanExploreTool } from './planExploreTool.js';
import { registerWorkflowTool } from './workflowTool.js';
import type { UnifiedSubAgentDispatch } from '../../../common/unifiedSubAgentDispatch.js';
import { registerPlanModeTools } from './planModeTools.js';
import { createKnowledgeStorageRegistrar, type IKnowledgeStorageRegistrar } from './knowledgeStorageTools.js';
import { IMermaidInlineRenderer } from '../../mermaidInlineRenderer.js';
import { IDrawioInlineRenderer } from '../../drawioInlineRenderer.js';
import { svgToPng } from '../../knowledge/svgRasterizer.js';
import { prepareDiagramsForSync } from '../../knowledge/diagramSyncPrepare.js';
// ★ 2026-09-24：`kb_build` —— agent 发起知识库构建（此前只有视图按钮，素材落库后就断在那里）。
//   装配 KbImportController 需要 loadActiveKbVault/resolveKbRootUri（与视图同一套 vault 根解析）。
import { registerKbBuildTools } from './kbBuildTools.js';
// ★ 2026-09-24：飞书云文档工具族（读文档 / 评论 5 个）—— 从 Hermes 的 feishu_* 工具移植
//   能力（上游那套靠"评论事件注入 client"，我们改成按需调用官方 CLI，见该文件头）。
import { registerProcessTools } from './processTools.js';
import { registerFeishuDriveTools } from './feishuDriveTools.js';
// ★ 2026-09-24（P1-4）：工具依赖可用性 —— 把 `definition.availability` 接进列表路径
//   （此前 `toolAvailabilityEvaluator` 是**孤儿模块**，声明了也不生效）。策略是**标注而非隐藏**，
//   理由见该模块头注释（没有 UI 能解释"为什么不可用"，隐藏会让用户永远学不到怎么装）。
import {
	annotateToolAvailability, createCapabilityFacts,
	CAP_MEDIA_FFMPEG, CAP_MEDIA_YTDLP, CAP_FEISHU_LARK_CLI,
	type IToolCapabilityFacts,
} from './toolAvailabilityNotes.js';
import { probeMediaCapabilities } from './videoMediaPipeline.js';

/** 评论内容临时文件的命名前缀与陈旧阈值（配合上面两处回收逻辑，避免残留敏感内容）。 */
const FEISHU_CONTENT_PREFIX = 'feishu-content-';
const FEISHU_CONTENT_STALE_MS = 10 * 60_000;
import { getLarkCliStatus, runLarkCli } from '../../larkCliService.js';
// 视频工具的命令通道（主进程 vscode:execCode；与知识库同步/飞书工具同一套原语）
import { execShortCommand } from '../../knowledge/feishuSyncCore.js';
import { KbImportController } from '../../kbImportController.js';
import { loadActiveKbVault, resolveKbRootUri } from '../../knowledge/kbVaultState.js';
import { resolveAndCheckWorkspacePathImpl } from './workspaceSecurity.js';
import { registerCoreTools } from './coreTools.js';
import { executeToolImpl } from './toolExecutor.js';
import { registerHandoffTools } from './handoffTools.js';
import { registerMermaidTools } from './mermaidTools.js';
import { registerDrawioTools } from './drawioTools.js';
import { registerUnrealTools } from './unrealTools.js';
import { registerSessionSearchTools } from './sessionSearchTools.js';
import { registerVisionAnalyzeTools, readLocalImageAsBase64 } from './visionAnalyzeTools.js';
import {
	detectDevicePath, detectSensitivePath, devicePathBlockedMessage, sensitiveReadBlockedMessage,
} from './sensitivePaths.js';
import { AgentNetworkDomainSettingId } from '../../../../../../platform/networkFilter/common/settings.js';
// 主模型图片能力判定（与 agent loop 同一真源，带 provider::model 缓存 + fail-closed）
import { resolveSupportsImages } from '../../../common/toolResultImages.js';
import { registerMediaGenTools } from './mediaGenTools.js';
import { registerVideoFrameTools } from './videoFrameTools.js';
import { registerVideoAnalyzeTools } from './videoAnalyzeTools.js';
import { registerSchedulerTools } from './schedulerTools.js';
// 注意：`IAgentSchedulerService` 是 `createDecorator` 的返回值（**值**，非纯类型），
// 用作 DI 装饰器时必须用普通 import —— `import type` 会触发 TS1361
// （"cannot be used as a value because it was imported using 'import type'"）。
import { IAgentSchedulerService } from '../../../common/agentScheduler.js';
import { ToolRegistry, type IBuiltinToolRegistration } from './toolRegistry.js';

/** Config key controlling where knowledge bases are persisted. Empty = `<userHome>/.saros/kb`. */
const AGENT_STUDIO_KB_STORAGE_PATH = 'agentStudio.knowledge.storage.path';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentStudio.knowledge',
	properties: {
		[AGENT_STUDIO_KB_STORAGE_PATH]: {
			type: 'string',
			default: '',
			markdownDescription: localize('agentStudio.knowledge.storage.path', "Root directory for persisted knowledge bases. Leave empty to use the default `<userHome>/.saros/kb`. Supports `~` (user home) and absolute paths; relative paths are resolved against the user home. Changing this migrates existing knowledge bases to the new location automatically."),
			tags: ['agentStudio', 'knowledge'],
		},
	},
});



/**
 * Kanban 工具中已实现真实 handler 的名字集合。
 * 这些工具由 _registerKanbanTools() 注册，_registerBundledTools() 会跳过它们的 stub。
 */



/**
 * Module-level Emitter for AI-driven workflow changes.
 * Extracted to workflowShared.ts to break cyclic dependency with workflowTools.ts.
 */
export { workflowAppliedEmitter } from './workflowShared.js';
export { type IBuiltinToolRegistration } from './toolRegistry.js';



/**
 * 工具入参的容错解析（2026-09-21）。
 *
 * `IToolCall.arguments` 在类型上是 `Record<string, unknown>`，但真实链路上**存在字符串形态**
 * （不同 provider / 桥接层会把 arguments 序列化成 JSON 串）。文件写队列需要读 `path` 入参，
 * 解析失败时**返回 undefined 并直通**（不串行）—— 宁可少锁一次，也绝不因此把工具调用搞失败 ✗。
 */
function _parseToolArgsLenient(toolCall: IToolCall): Record<string, unknown> | undefined {
	const raw: unknown = toolCall.arguments;
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
		} catch { return undefined; }
	}
	return raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
}

/**
 * 安全沙箱违规错误 — 路径不在允许的工作区目录内时抛出。
 * 携带结构化信息（请求路径 / 允许根 / 建议路径），供 agentOSService
 * 检测并向用户弹出确认卡片（而非仅回显一段错误文本）。
 */
export class BuiltinToolProvider extends Disposable implements IToolProvider {

	readonly id: string = 'saros.builtin-tools';
	readonly name: string = 'Saros Built-in Tools';

	/** 工具注册表 —— 封装工具描述符集合、启用状态与变更事件（见 toolRegistry.ts）。 */
	private readonly _registry = new ToolRegistry(this.logService);

	readonly onDidChangeTools = this._registry.onDidChangeTools;

	/** Skill Manager 工具实例 —— 提供 skill_create 能力 */
	private _skillManagerTool!: SkillManagerTool;
	private readonly _skillUsageTracker: SkillUsageTracker;

	/** web_extract 本地页面缓存（P2）—— 懒构造，见 `_getWebPageCache`。 */
	private _webPageCache?: WebPageCache;
	/** web_search 结果备忘（内存 + TTL + 单飞）—— 懒构造，见 `_getSearchMemo`。 */
	private _searchMemo?: WebSearchMemo;

	/** Chrome CDP 可达性门控（懒建，见 `_getBrowserCdpGate`）。 */
	private _browserCdpGate?: BrowserCdpReachabilityGate;

	// v17: worktree path inherited from the parent agent's execution context.
	// Set by `setParentWorktreePath()` before each turn; cleared on turn end.
	// Used by the `delegate_task` tool to propagate the worktree to sub-agents.
	private _parentWorktreePath: string | undefined;

	/**
	 * v17: set the worktree path inherited from the parent agent's request.
	 * This is consulted by the `delegate_task` tool when dispatching
	 * sub-agents so the entire subagent tree operates in the same worktree.
	 */
	setParentWorktreePath(path: string | undefined): void {
		this._parentWorktreePath = path;
	}

	/**
	 * v17: read the currently-set parent worktree (used by delegate_task).
	 */
	getParentWorktreePath(): string | undefined {
		return this._parentWorktreePath;
	}

	/**
	 * 沙箱路径解析（委托 workspaceSecurity.resolveAndCheckWorkspacePathImpl）。
	 * 保持为实例方法，以便 ctx 直接传入函数引用并访问 this._sandboxBypassRoots。
	 * @throws SandboxViolationError 如果路径不在任何允许的工作区内
	 */
	private _resolveAndCheckWorkspacePath(agentId: string | undefined, requestedPath: string, checkSandbox: boolean = true): Promise<string> {
		return resolveAndCheckWorkspacePathImpl({
			studioService: this.studioService,
			workspaceService: this.workspaceService,
			environmentService: this.environmentService,
			configurationService: this.configurationService,
			storageService: this.storageService,
			logService: this.logService,
			fileService: this.fileService,
			sandboxBypassRoots: this._sandboxBypassRoots,
			kbStoragePathKey: AGENT_STUDIO_KB_STORAGE_PATH,
		}, agentId, requestedPath, checkSandbox);
	}

	// ─── 沙箱临时放行（对齐 agentOSService 的「允许本次」确认）────────
	// 仅本次工具调用生效：agentOSService 在重试前 addSandboxBypassRoot，
	// 重试后 removeSandboxBypassRoot，避免泄露到后续 turn。
	private readonly _sandboxBypassRoots = new Set<string>();

	/** 临时放行某个精确路径（仅本次工具调用生效）。 */
	addSandboxBypassRoot(path: string): void {
		this._sandboxBypassRoots.add(path.replace(/[\\/]+$/, ''));
	}

	/** 移除临时放行的精确路径（见 addSandboxBypassRoot）。 */
	removeSandboxBypassRoot(path: string): void {
		this._sandboxBypassRoots.delete(path.replace(/[\\/]+$/, ''));
	}

	/** 清空所有临时放行的路径（turn 结束时调用）。 */
	clearSandboxBypassRoots(): void {
		this._sandboxBypassRoots.clear();
	}

	/** Per-turn 状态重置：清空文件读取去重/重复计数 Map。 */
	resetPerTurn(): void {
		this._corePerTurnReset?.();
	}


	/** ADR Manager 实例 —— 提供 manage_adr 能力 */
	private _adrManager!: AdrManager;

	/** 搜索相关 helper 集合（从本文件抽取到 searchHelpers.ts，降低主文件体积） */
	private readonly _searchHelpers: SearchHelpers;

	/** Core tools per-turn reset 回调（清空读去重/重复计数 Map）。 */
	private _corePerTurnReset?: () => void;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAgentStudioService private readonly studioService: IAgentStudioService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IAgentSchedulerService private readonly schedulerService: IAgentSchedulerService,
		@IAgentOSService private readonly agentOS: IAgentOSService,
		@IModelSelectorService private readonly modelSelectorService: IModelSelectorService,
		@ITaskOrchestrationService private readonly orchestrationService: ITaskOrchestrationService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@ITriageService private readonly triageService: ITriageService,
		@ISwarmService private readonly swarmService: ISwarmService,
	@ICheckpointService private readonly checkpointService: ICheckpointService,
	@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
		@ICodebaseGraphService private readonly codebaseGraphService: ICodebaseGraphService,
	@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	@IEditorService private readonly editorService: IEditorService,
	@ISessionsManagementService private readonly sessionsManagement: ISessionsManagementService,
		@IKanbanRecipeService private readonly recipeService: IKanbanRecipeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IAiEmbeddingVectorService private readonly embeddingService: IAiEmbeddingVectorService,
		@IRequestService private readonly requestService: IRequestService,
		@IWebContentExtractorService private readonly webContentExtractorService: IWebContentExtractorService,
		@ISearchService private readonly searchService: ISearchService,
		@IKbNativeKernelService private readonly kbKernelService: IKbNativeKernelService,
		// ★ 2026-09-24：图表渲染器（与笔记预览 / 聊天图表卡片同一套隐藏 webview 引擎）。
		//   注入给 kb_feishu_sync 的「同步前图表准备」—— 此前该步骤只长在「知识库视图 → 同步飞书」
		//   按钮路径上，agent 走工具同步时 mermaid/drawio 源码会原样发到飞书（飞书不渲染源码）。
		@IMermaidInlineRenderer private readonly mermaidRenderer: IMermaidInlineRenderer,
		@IDrawioInlineRenderer private readonly drawioRenderer: IDrawioInlineRenderer,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		// ★ 2026-09-24：`kb_build`（agent 发起知识库构建）需要按视图同样的方式装配
		//   `KbImportController`（它有 9 个必需依赖：configuration/log/file/env/storage/
		//   studio/views/editor/notification/request）。其余所需服务本类已有。
		@IViewsService private readonly viewsService: IViewsService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._skillManagerTool = new SkillManagerTool(
			this.environmentService,
			this.fileService,
			this.skillRegistry,
			this.logService,
		);
		this._skillUsageTracker = new SkillUsageTracker(this.fileService, this.logService);
		this._adrManager = new AdrManager(this.fileService);
		this._searchHelpers = new SearchHelpers(this.fileService, this.searchService, this.logService, this.configurationService);
		// Phase 1: 注册内置 embedding provider（复用 BYOK API → /v1/embeddings）
		// 使 kb_* 工具无需扩展即可工作
		this._registerEmbeddingProvider();
		this._registerCoreTools();
		this._registerWebTools();
		// ★ P1-2：browser_* 的真实实现（必须在 _registerBundledTools 之前，否则被注册成 stub）。
		this._registerBrowserTools();
		this._registerCompatibilityTools();
		// ★ 2026-09-24（P1-5）：process 的真实实现（此前只是 compatibilityTools 里的提示占位，
		//   占位已从那里移除）。必须在 _registerBundledTools 之前 —— bundled 里有同名 stub。
		this._registerProcessTools();
		this._registerUnifiedMemoryTools(); // G12: recall/improve/forget
		this._registerMemoryTools(); // remember/search/delete/list（真实 handler，须在 bundled stub 之前注册）
		this._registerAdvancedMemoryTools(); // 接入引擎编排/治理能力：governance/team/mesh/sentinel/obsidian/cascade
		this._registerRoutineCrystalFacetTools(); // 接入高阶记忆能力：routine/crystal/facet
		this._registerSkillTools();
		// ★ 2026-09-10：image_generate 真实实现，必须在 _registerBundledTools 之前 ——
		// 后者对未注册的 bundled 定义注册 stub（isStub → listTools 跳过），
		// 先注册真实 handler 才能让 LLM 看到并调用该工具（ctx.hasTool 判据）。
		this._registerImageGenTools();
		// ★ 2026-09-11：drawio 真实实现，同样**必须在 _registerBundledTools 之前** ——
		// 否则 bundled 里的 renderDrawioDiagram 定义会因 ctx.hasTool() 未命中而被
		// 注册成 stub（isStub → listTools 跳过）→ 模型看不到该工具，整条 drawio 链路
		// （渲染器 drawioInlineRenderer / 卡片 drawioCard / 预览命令）成为永远走不到
		// 的死代码。与 _registerImageGenTools 同一模式（见其上方注释）。
		this._registerDrawioTools();
		// ★ 2026-09-20：unreal_* 真实实现（BunnySeek bridge HTTP 客户端）。
		//   此前 unrealTools.ts 只有定义、无调用点 ⇒ 7 个工具从未注册，模型看不到。
		this._registerUnrealTools();
		// ★ 2026-09-11：session_search 真实实现，同样必须在 _registerBundledTools 之前
		// —— 否则 bundled 里的 session_search 定义会被注册成 stub（isStub → listTools
		// 跳过）→ 模型永远看不到（此前正是此状态：配置项 / 工具名映射 / 白名单俱全，
		// 唯独缺 handler）。
		this._registerSessionSearchTools();
		// ★ 2026-09-11：vision_analyze 真实实现（同源半成品第 4 例），同样必须在
		// _registerBundledTools 之前 —— 否则 bundled 定义被注册成 stub 并被 listTools
		// 跳过 → 模型看不到（此前正是此状态）。
		this._registerVisionAnalyzeTools();
		// ★ 2026-09-11：video_generate / text_to_speech 真实实现（同源半成品第 5、6 例），
		// 同样必须在 _registerBundledTools 之前 —— 否则 bundled 定义被注册成 stub
		// 并被 listTools 跳过 → 模型看不到（此前正是此状态）。
		this._registerMediaGenTools();
		// ★ 2026-09-11：cronjob 真实实现（同源半成品第 7 例）—— 调度能力与视图早已
		// 齐备，唯独缺 LLM 工具入口；同样必须在 _registerBundledTools 之前注册。
		this._registerSchedulerTools();
		// ★ 2026-09-24：extract_video_frames —— 补齐「视频画面」能力（此前只有封面一张静止图，
		//   依赖画面的任务只能靠模型编造）。同样注册在 _registerBundledTools 之前；
		//   命令拼装/清理逻辑见 videoFrameTools.ts / videoMediaPipeline.ts 头注释。
		this._registerVideoFrameTools();
		// ★ 2026-09-24：video_analyze 真实实现 —— 此前只有 bundled 定义（category 'video'）无 handler，
		//   被判为 stub ⇒ listTools 跳过 ⇒ 模型**根本看不到**这个工具。
		//   它 = 抽帧 + 字幕 + 多模态模型一次给结论（与 extract_video_frames 互补，见其头注释）。
		//   同样必须在 _registerBundledTools 之前，否则 stub 会把真 handler 顶掉。
		this._registerVideoAnalyzeTools();
		this._registerBundledTools();
		this._registerDelegationTools();
		this._registerPlanExploreTool(); // WorkBuddy-style plan mode: parallel exploration
		this._registerDynamicWorkflowTool(); // dynamic workflows: 模型写 JS 脚本编排子代理
		this._registerPlanModeTools(); // MiMo-style plan_enter/plan_exit tools
		this._registerKanbanTools();
		this._registerMindmapTools();
		this._registerWorkflowTools();
		this._registerCanvasTools();
		this._registerCodebaseTools();
		this._registerKnowledgeTools(); // llm-wiki 知识内核（kb_search 工具）
		// ★ 2026-09-24：`kb_build` —— 构建此前**只有 UI 入口**（视图「批量构建库」/ 右键「构建为笔记」），
		//   于是「素材先落库、再构建」的链路（如 kb-game-teardown 把拆解写进 库/raw）走到最后一步就断了：
		//   agent 只能让用户自己去点按钮。本工具补齐该入口（走同一条 agent 会话构建路径）。
		this._registerKbBuildTools();
		// ★ 2026-09-24：飞书文档工具族（读文档 + 评论读/写）—— 同样必须在 _registerBundledTools
		//   之前：bundled 里有 5 个同名 stub，晚注册会被 stub 顶掉（真 handler 失效）。
		this._registerFeishuDriveTools();
		this._registerHandoffTools(); // supervisor 交接工具 transfer_to_agent（Step B）
		this._registerMermaidTools(); // Mermaid 图示渲染工具
		// _registerMcpBridgeTools() 已废弃 — MCP 工具统一走 tool_search/tool_describe/tool_call
		// 保留方法定义以备审计/兼容老调用
		// ★ 2026-09-21：注册收尾后做**归类自检**（unreal_* 事故的可观测信号 —— 见方法注释）
		this._warnOnUtilityBucketTools();
	}

	/**
	 * 归类自检（2026-09-21，unreal_* 事故的可观测信号）。
	 *
	 * unreal_* 事故的第一断点不是「没注册」，而是「注册了但 `toolsetConfig` 没登记 `unreal_`
	 * 前缀」⇒ `getToolsetForTool` 静默归 `utility`（Low）⇒ focus 模式整条剔除 ⇒
	 * **LLM 与 tool_search 均不可见，且全程零日志**。这类失败最毒的地方就在于"静默"。
	 *
	 * 故注册收尾后扫一遍：任何注册工具落进 utility 兜底桶（除共享白名单
	 * {@link UTILITY_BUCKET_WHITELIST}）都**立刻打 warn**，把静默不可见变成启动日志里
	 * 一眼可见。与测试侧的类级钉（`test/browser/toolRegistrationWiring.test.ts` ①）
	 * 共用同一份白名单 —— 两处**不得漂移**。
	 *
	 * 说明：显式带 `definition.toolset` 的工具尊重显式值（与 assembly Step 2 的
	 * `t.toolset ?? getToolsetForTool(name)` 同序）；stub 工具本就不可见（listTools 跳过），跳过。
	 */
	private _warnOnUtilityBucketTools(): void {
		try {
			const inUtility: string[] = [];
			for (const name of this._registry.toolNames()) {
				const desc = this._registry.resolveTool(name);
				if (!desc || desc.isStub) { continue; }
				const ts = (desc.definition as { toolset?: string }).toolset ?? getToolsetForTool(name);
				if (ts === 'utility' && !UTILITY_BUCKET_WHITELIST.has(name)) { inUtility.push(name); }
			}
			if (inUtility.length > 0) {
				this.logService.warn(
					`[BuiltinTools] ⚠ 归类自检：${inUtility.length} 个已注册工具落进 utility 兜底桶 —— ` +
					`focus 模式会把它们整条剔除（LLM 与 tool_search 均不可见）。` +
					`请到 toolsetConfig.ts 给它们登记独立 toolset（前缀/exactNames）：[${inUtility.join(', ')}]`,
				);
			}
		} catch (e) {
			// 自检失败绝不阻断注册
			this.logService.warn(`[BuiltinTools] 归类自检失败（不影响注册）：${e}`);
		}
	}

	// ─── MCP Bridge Tools (DEPRECATED) ───────────────────────────────────────
	// 2026-07-03: 统一为单套桥接 tool_search/tool_describe/tool_call（对齐 Hermes-Agent）
	// MCP 工具现在通过 'mcp' toolset 纳入 deferrable 池，
	// LLM 通过统一的 tool_search → tool_describe → tool_call 路径发现和调用。
	// 原 _registerMcpBridgeTools() 方法体已删除，MCP 桥接工具不再注册。


	// ─── IToolProvider 实现（委托 ToolRegistry）───────────────────────

	async listTools(_agentId: string): Promise<IToolDefinition[]> {
		return annotateToolAvailability(await this._registry.listTools(_agentId), this._capabilityFacts());
	}

	async getAllToolDefinitions(_agentId: string): Promise<IToolDefinition[]> {
		return annotateToolAvailability(await this._registry.getAllToolDefinitions(_agentId), this._capabilityFacts());
	}

	/**
	 * ★ 2026-09-24（P1-4）：能力事实表 + 一次性后台探测。
	 *
	 * 为什么在这里（而不是每个工具自己判断）：`availability` 的评估发生在**每次列工具**时
	 * （agent loop 热路径），只能是**同步查表**；而"ffmpeg / lark-cli 在不在"必须 spawn 才能确定。
	 * ⇒ 后台探一次、结果落表、列表时同步读；未探完之前事实为"未知" ⇒ **不标注**（fail-open）。
	 *
	 * 探测本身复用既有原语（都是进程级缓存过的，不会随对话轮次重复 spawn）：
	 *   · 媒体：`probeMediaCapabilities` → 与两个视频工具同一份解析 + 探活缓存；
	 *   · 飞书：`getLarkCliStatus()` → 与设置页/导入链路同一个探测。
	 */
	private _capabilityFacts(): IToolCapabilityFacts {
		this._ensureCapabilityProbe();
		return createCapabilityFacts(this._capabilityFactsMap);
	}

	private _ensureCapabilityProbe(): void {
		if (this._capabilityProbeStarted) { return; }
		this._capabilityProbeStarted = true;
		void (async () => {
			try {
				const media = await probeMediaCapabilities({
					fileService: this.fileService,
					logService: this.logService,
					appRoot: this.environmentService.appRoot,
					runCommand: (command, timeoutMs) => execShortCommand(command, timeoutMs),
				});
				if (typeof media.ffmpeg === 'boolean') { this._capabilityFactsMap.set(CAP_MEDIA_FFMPEG, media.ffmpeg); }
				if (typeof media.ytdlp === 'boolean') { this._capabilityFactsMap.set(CAP_MEDIA_YTDLP, media.ytdlp); }
			} catch (err) {
				// 探测失败 ⇒ 保持未知（fail-open），不标注
				this.logService.trace(`[BuiltinTools] media capability probe failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			try {
				const cli = await getLarkCliStatus();
				// ⚠ 只在**明确判为未安装**时记为 false；`available:false`（非 Electron / preload 未注入）
				//   是"探测能力缺失"，不是"CLI 没装" ⇒ 保持未知，避免误标。
				if (cli.available) { this._capabilityFactsMap.set(CAP_FEISHU_LARK_CLI, cli.installed); }
			} catch (err) {
				this.logService.trace(`[BuiltinTools] lark-cli capability probe failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			this.logService.info(`[BuiltinTools] capability facts: ${[...this._capabilityFactsMap].map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
		})();
	}

	async isToolEnabled(_agentId: string, toolName: string): Promise<boolean> {
		return this._registry.isToolEnabled(_agentId, toolName);
	}

	async enableTool(_agentId: string, toolName: string): Promise<void> {
		return this._registry.enableTool(_agentId, toolName);
	}

	async disableTool(_agentId: string, toolName: string): Promise<void> {
		return this._registry.disableTool(_agentId, toolName);
	}

	async getToolsEnabledState(_agentId: string): Promise<Record<string, boolean>> {
		return this._registry.getToolsEnabledState(_agentId);
	}

	async setToolsEnabledState(_agentId: string, state: Record<string, boolean>): Promise<void> {
		return this._registry.setToolsEnabledState(_agentId, state);
	}

	async executeTool(_agentId: string, toolCall: IToolCall, signal?: AbortSignal): Promise<IToolResult> {
		const run = (): Promise<IToolResult> => executeToolImpl({
			resolveTool: name => this._registry.resolveTool(name),
			listToolNames: () => this._registry.toolNames(),
			logService: this.logService,
		}, _agentId, toolCall, signal);
		// ★★ 2026-09-21（P0-2，对齐 pi `withFileMutationQueue`）：**文件写工具按目标文件串行**。
		//
		// 为什么在「唯一收口处」做而不是各个工具里各写一份：这里是所有内置工具调用的必经之路，
		// 一处接线即可覆盖 `patch` / `file_write`（以及将来新增的任何文件写工具），
		// 且能在这里拿到 `fileService` 做 **realpath 归一**（相对↔绝对、分隔符、Windows 大小写、
		// 符号链接别名都会落到同一个键）—— 工具内部各写一份必然遗漏别名形态。
		//
		// 当前主循环串行（`MAIN_LOOP_PARALLEL_TOOLS_ENABLED=false`）⇒ 这里的锁是**零竞争**的；
		// 它是为「恢复主循环并行」准备的正确性基建（详见 common/fileMutationQueue.ts 头注释：
		// 并行判定里的路径重叠检查是字符串级的，会漏别名 ⇒ 恢复并行即出现丢更新 ✗）。
		// 非写工具 / 无路径入参 ⇒ `key === undefined` ⇒ 直通（不引入任何额外 await 语义）。
		const key = await resolveToolMutationKey(toolCall.name, _parseToolArgsLenient(toolCall), {
			rootPath: this.workspaceService.getWorkspace().folders[0]?.uri.fsPath,
			realpath: async p => (await this.fileService.realpath(URI.file(p)))?.fsPath,
		});
		return key ? withFileMutationQueue(key, run) : run();
	}


	// ─── 公共注册接口（委托 ToolRegistry）────────────────────────────

	register(descriptor: IBuiltinToolRegistration) {
		return this._registry.register(descriptor);
	}

	// ─── Knowledge tools (llm-wiki 知识内核：kb_search) ───────────────────

	// ─── Phase 1: 内置 Embedding Provider（激活 RAG 引擎）──────────────────

	/**
	 * 注册内置 BYOK embedding provider，使 `isEnabled()` 返回 true
	 * 并解除 `createEmbedder()` 的硬错误。该 provider 复用用户已配置的
	 * OpenAI-compatible API（OpenRouter / 自定义）的 `/v1/embeddings` 端点。
	 */
	private _knowledgeStorage?: IKnowledgeStorageRegistrar;

	private _getKnowledgeStorage(): IKnowledgeStorageRegistrar {
		if (!this._knowledgeStorage) {
			this._knowledgeStorage = createKnowledgeStorageRegistrar({
				register: reg => this.register(reg),
				addDisposable: d => this._register(d),
				configurationService: this.configurationService,
				fileService: this.fileService,
				embeddingService: this.embeddingService,
				studioService: this.studioService,
				workspaceService: this.workspaceService,
				environmentService: this.environmentService,
				logService: this.logService,
				kernelService: this.kbKernelService,
				kbStoragePathKey: AGENT_STUDIO_KB_STORAGE_PATH,
				// ★ 2026-09-23：kb_organize 依赖（checkpoint 回滚 + 解析当前 vault 根）
				storageService: this.storageService,
				checkpointService: this.checkpointService,
				// ★ 2026-09-24：kb_feishu_sync 的「同步前图表准备」（mermaid/drawio/canvas → PNG）。
				//   渲染器在这里绑定；编排与视图按钮共用 knowledge/diagramSyncPrepare.ts 一份口径。
				prepareDiagrams: req => prepareDiagramsForSync({
					...req,
					fileService: this.fileService,
					logService: this.logService,
					renderMermaid: (src: string) => this.mermaidRenderer.renderToSvg(src, 'default'),
					renderDrawio: (src: string) => this.drawioRenderer.renderToSvg(src, 'default'),
					rasterize: (svg: string, scale?: number) => svgToPng(svg, { scale }),
				}),
			});
		}
		return this._knowledgeStorage;
	}

	private _registerEmbeddingProvider(): void {
		this._getKnowledgeStorage().registerEmbeddingProvider();
	}

	private _registerKnowledgeTools(): void {
		this._getKnowledgeStorage().registerKnowledgeTools();
	}


	// ─── 内置工具集 ─────────────────────────────────────────────────────

	private _registerCoreTools(): void {
		const coreControl = registerCoreTools({
			register: reg => this.register(reg),
			logService: this.logService,
			id: this.id,
			resolveAndCheckWorkspacePath: (agentId, p, req) => this._resolveAndCheckWorkspacePath(agentId, p, req),
			fileService: this.fileService,
			searchHelpers: this._searchHelpers,
			checkpointService: this.checkpointService,
			terminalService: this.terminalService,
			workspaceService: this.workspaceService,
			configurationService: this.configurationService,
			// terminal 超限输出落盘（2026-09-21）：与 execute_code 共用 `~/.vssaros/tmp/` 约定。
			environmentService: this.environmentService,
			getBoundWorktreeRoot: agentId => this._resolveBoundWorktreeRoot(agentId),
		});
		this._corePerTurnReset = coreControl.resetPerTurn;
	}

	/**
	 * 解析该 agent **实际绑定**的 worktree 根（与 workspaceSecurity 同口径：
	 * 经 `resolveEffectiveWorktreeRoot` 过滤掉「绑定目标就是主仓」的伪隔离）。
	 *
	 * 优先用本轮 turn 下推的 `_parentWorktreePath`（含任务级覆盖），再回退
	 * `AgentBinding.worktreePath`。供 file_read 判定越界读取 worktree 副本
	 * （2026-08-20，日志 1787217670299）。
	 */
	private async _resolveBoundWorktreeRoot(agentId: string | undefined): Promise<string | undefined> {
		try {
			const activeWsId = this.studioService.getActiveWorkspaceId();
			if (!activeWsId) { return this._parentWorktreePath; }
			const workspacePath = (await this.studioService.getWorkspace(activeWsId))?.path;
			let candidate = this._parentWorktreePath;
			if (!candidate && agentId) {
				candidate = (await this.studioService.getAgentBinding(activeWsId, agentId))?.worktreePath;
			}
			return resolveEffectiveWorktreeRoot(candidate, workspacePath);
		} catch {
			return this._parentWorktreePath;
		}
	}


	private _registerWebTools(): void {
		const ctx: WebToolContext = {
			register: (d) => this.register(d),
			requestService: this.requestService,
			logService: this.logService,
			webContentExtractorService: this.webContentExtractorService,
			// web_search 多后端配置（P0-2）。**每次调用现读**而不是注册时快照：
			// 用户在设置里换了 provider / 填了 key 应当下一轮立即生效，不需要重启窗口。
			getWebSearchConfig: () => ({
				provider: this.configurationService.getValue<string>(AGENT_STUDIO_WEB_SEARCH_PROVIDER_SETTING) ?? DEFAULT_WEB_SEARCH_CONFIG.provider,
				searxngUrl: this.configurationService.getValue<string>(AGENT_STUDIO_WEB_SEARCH_SEARXNG_URL_SETTING) ?? '',
				tavilyApiKey: this.configurationService.getValue<string>(AGENT_STUDIO_WEB_SEARCH_TAVILY_KEY_SETTING) ?? '',
				braveApiKey: this.configurationService.getValue<string>(AGENT_STUDIO_WEB_SEARCH_BRAVE_KEY_SETTING) ?? '',
				exaApiKey: this.configurationService.getValue<string>(AGENT_STUDIO_WEB_SEARCH_EXA_KEY_SETTING) ?? '',
			}),
			// web_extract 的本地页面缓存（P2）。同样现读设置 ⇒ 关掉缓存下一轮即失效。
			getWebCache: () => this._getWebPageCache(),
			// web_search 的结果备忘（对齐 Hermes 的 search memo）。与页面缓存共用同一个"缓存"开关。
			getSearchMemo: () => this._getSearchMemo(),
			// 超限正文落盘（与 execute_code / terminal 同一约定，见 webExtractSpill.ts）。
			writeExtractSpill: content => this._writeExtractSpill(content),
		};
		registerWebTools(ctx);
	}

	/**
	 * `web_extract` 本地页面缓存（P2）的懒构造 + 开关门控。
	 *
	 * 懒构造：窗口里可能从不抓网页，没必要在启动路径上建对象。
	 * 门控在**每次调用**读取设置（而非注册时快照）⇒ 用户在设置里关掉缓存立即生效。
	 */
	private _getWebPageCache(): IWebPageCacheLike | undefined {
		if (this.configurationService.getValue<boolean>(AGENT_STUDIO_WEB_SEARCH_CACHE_ENABLED_SETTING) === false) {
			return undefined;
		}
		this._webPageCache ??= new WebPageCache(this._webCacheStore(), this.logService);
		return this._webPageCache;
	}

	/**
	 * `web_search` 结果备忘的懒构造 + 开关门控（与页面缓存共用同一个设置）。
	 *
	 * 关掉时返回 undefined（而不是清空已有条目）：已缓存的生命周期由 TTL 自然收敛，
	 * 不必为此再加一条清理路径。
	 */
	private _getSearchMemo(): WebSearchMemo | undefined {
		if (this.configurationService.getValue<boolean>(AGENT_STUDIO_WEB_SEARCH_CACHE_ENABLED_SETTING) === false) {
			return undefined;
		}
		this._searchMemo ??= new WebSearchMemo();
		return this._searchMemo;
	}

	/** 落盘文件名序号：同一毫秒内多次落盘也不撞名（对齐 coreTools 的 `_terminalSpillSeq`）。 */
	private static _extractSpillSeq = 0;

	/** 飞书评论内容临时文件的序号（同上：同一毫秒内多次调用也不撞名）。 */
	private static _feishuContentSeq = 0;

	/**
	 * 能力事实表（依赖是否就绪），供工具列表做 `availability` 标注。见 `_capabilityFacts()`。
	 * 空白 = 尚未探到 ⇒ 一律按"可用"处理（fail-open，绝不误标可用性）。
	 */
	private readonly _capabilityFactsMap = new Map<string, boolean>();
	/** 后台能力探测是否已启动（只跑一次；结果进 `_capabilityFactsMap`）。 */
	private _capabilityProbeStarted = false;

	/**
	 * `web_extract` 超限正文落盘 —— 与 `execute_code` / `terminal` **同一约定**
	 * （为什么必须是 `~/.vssaros/tmp/`、为什么 IO 失败要能退化，见 `webExtractSpill.ts` 头注释）。
	 *
	 * **任何 IO 失败都返回 undefined**（上层退化为纯截断）：落盘只是优化，不该让一次网页抓取失败。
	 */
	private async _writeExtractSpill(content: string): Promise<string | undefined> {
		try {
			const tmpDir = resolveSarosPath(userDataRootFromPath(this.environmentService.userDataPath), SarosPath.tmp);
			await this.fileService.createFolder(tmpDir);
			// 回收：策略常量与 exec 落盘共用（避免漂移）；目录不可读时静默跳过，不阻塞结果。
			try {
				const stat = await this.fileService.resolve(tmpDir, { resolveMetadata: true });
				const files = (stat.children ?? [])
					.filter(c => !c.isDirectory)
					.map(c => ({ name: c.name, mtimeMs: c.mtime ?? 0 }));
				for (const stale of selectWebExtractSpillFilesToDelete(files, Date.now())) {
					try { await this.fileService.del(joinPath(tmpDir, stale)); } catch { /* 单个失败跳过 */ }
				}
			} catch { /* 目录列举失败 → 本轮不回收 */ }

			const target = joinPath(tmpDir, webExtractSpillFileName(new Date(), ++BuiltinToolProvider._extractSpillSeq));
			await this.fileService.writeFile(target, VSBuffer.fromString(content));
			this.logService.info(`[BuiltinTools] web_extract: page spilled to ${target.fsPath} (${content.length} chars)`);
			return target.fsPath;
		} catch (err) {
			this.logService.info(`[BuiltinTools] web_extract: spill failed (${err instanceof Error ? err.message : String(err)}) — degrading to plain truncation`);
			return undefined;
		}
	}

	/**
	 * 把 `IStorageService` 适配成缓存要的窄接口。
	 *
	 * scope = APPLICATION（同一 URL 的内容与工作区无关，跨工作区共享命中）
	 * target = MACHINE（缓存是本机产物，不该随设置同步到别的机器）。
	 */
	private _webCacheStore(): IWebCacheStore {
		return {
			get: key => this.storageService.get(key, StorageScope.APPLICATION),
			set: (key, value) => this.storageService.store(key, value, StorageScope.APPLICATION, StorageTarget.MACHINE),
			delete: key => this.storageService.remove(key, StorageScope.APPLICATION),
		};
	}

	/**
	 * `browser_*` 工具（CDP 驱动真实 Chrome，P1-2）。
	 *
	 * ⚠ 调用点必须在 `_registerBundledTools()` **之前**：bundled 定义库里同名项会被注册成
	 * `isStub: true` ⇒ `listTools` 跳过 ⇒ 模型永远看不到（这就是这 7 个工具此前"在
	 * `CORE_TOOLS` 白名单里却不可见"的原因）。
	 */
	private _registerBrowserTools(): void {
		const ctx: BrowserToolContext = {
			register: d => this.register(d),
			logService: this.logService,
			cdp: this._browserCdpInvoker(),
			isEnabled: () => this._browserToolsUsable(),
			// 「改用你自己日常的 Chrome」引导卡：用户勾完同意框后要用它切过去
			// （理由见 BrowserToolContext.recheckEndpoint 注释）。
			recheckEndpoint: () => this.recheckBrowserCdp(),
			ports: () => {
				const configuredPort = this._browserCdpConfiguredPort();
				return { configuredPort, dedicatedPort: dedicatedPortFor(configuredPort) };
			},
		};
		registerBrowserTools(ctx);
		// 预热一次探测：让首次 listTools 就有结论（用户已开远程调试时工具能第一时间出现，
		// 而不是等到第一个 30s 周期过去）。
		if (this.configurationService.getValue<boolean>(AGENT_STUDIO_BROWSER_CDP_ENABLED_SETTING) !== false) {
			this._getBrowserCdpGate().warmUp();
		}
	}

	/** 用户设置的 CDP 端口（非法值退回默认）。只读设置、不做修正 —— 与主进程 `_port()` 同一口径。 */
	private _browserCdpConfiguredPort(): number {
		const raw = this.configurationService.getValue<number>(AGENT_STUDIO_BROWSER_CDP_PORT_SETTING);
		return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 && raw <= 65535
			? Math.floor(raw) : DEFAULT_CDP_PORT;
	}

	/**
	 * 丢弃当前 CDP 连接并**立即**重探（`browser_use_my_chrome` 用户勾完同意框后调用）。
	 *
	 * 两步都不能省：
	 *   ① `{ op: 'reset' }` —— 旧连接是在用户勾选**之前**建立的，指向专属实例；不丢就切不过去
	 *      （候选顺序里"你自己的 Chrome"优先，但那只对**新建**连接生效）。
	 *   ② `gate.warmUp()` —— 绕过 30s 节流，让"刚勾好"马上反映到工具可用性判定上。
	 * 工具列表无需手动刷新：`listTools` 每轮都会重算 `isUsable()`。
	 */
	async recheckBrowserCdp(): Promise<void> {
		try {
			const invoker = this._browserCdpInvoker();
			await invoker?.({ op: 'reset' });
		} catch (err) {
			this.logService.warn(`[BuiltinTools] browser CDP reset failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		this._getBrowserCdpGate().warmUp();
	}

	/**
	 * `browser_*` 此刻该不该出现在模型的工具列表里。
	 *
	 * 两条并列的判据（前者更快、后者更强）：
	 *   ① Chrome 调试端口**已可达** —— 用用户自己开好的那个 Chrome（可能带他的登录态），不加戏；
	 *   ② 端口不可达，但开着「自动拉起调试实例」—— 仍然暴露这 7 个工具，因为**首次真正调用时**
	 *      主进程会用专属 profile 把浏览器带起来（Route B）。
	 *
	 * ② 是刻意的：工具一旦不出现，模型就永远不会调用，也就永远触发不到"首次调用" ——
	 * 那会把 Route B 困死成死代码。所以这里必须比"可达性门控"宽一档。
	 * 代价是：若拉起注定失败（例如机器上没装 Chrome），模型会撞一次失败并拿到明确的错误
	 * （"找不到 Chrome 可执行文件…"），而不是事先隐身 —— 这比"工具莫名消失、无从解释"更好。
	 *
	 * 反过来说：若把「自动拉起调试实例」关掉，本判据就退化成纯可达性门控（回到旧行为，
	 * 不会让模型白撞那次 net::ERR_CONNECTION_REFUSED）。
	 */
	private _browserToolsUsable(): boolean {
		if (this.configurationService.getValue<boolean>(AGENT_STUDIO_BROWSER_CDP_ENABLED_SETTING) === false) { return false; }
		if (this._getBrowserCdpGate().isUsable()) { return true; }
		return this.configurationService.getValue<boolean>(AGENT_STUDIO_BROWSER_CDP_LAUNCH_DEDICATED_SETTING) !== false;
	}

	/** 重探周期。取值理由见 `BrowserCdpReachabilityGate` 的类注释（太长则"刚开好调试"长时间不生效）。 */
	private static readonly _CDP_PROBE_INTERVAL_MS = 30_000;

	/**
	 * browser_* 的可达性门控（懒建）—— 语义全在 `BrowserCdpReachabilityGate` 的类注释里。
	 *
	 * 探测动作走 `_browserCdpInvoker()` 的 `status` op：主进程侧等价于
	 * 「HTTP 发现 `/json/version` + WS 建连 + `Browser.getVersion`」，成功即说明**整条 CDP
	 * 链路**可用（而不只是端口在听）。
	 */
	private _getBrowserCdpGate(): BrowserCdpReachabilityGate {
		this._browserCdpGate ??= new BrowserCdpReachabilityGate(
			async () => {
				const invoker = this._browserCdpInvoker();
				if (!invoker) { return false; }
				const res = await invoker({ op: 'status' });
				return res.ok === true && (res.result as IBrowserCdpStatus | undefined)?.ok === true;
			},
			BuiltinToolProvider._CDP_PROBE_INTERVAL_MS,
			(reachable, detail) => this.logService.info(`[BuiltinTools] browser CDP reachable=${reachable}${detail ? ` — ${detail}` : ''}`),
		);
		return this._browserCdpGate;
	}

	/**
	 * browser_* 的 CDP 调用通道。
	 *
	 * 主进程侧通道不存在时（纯 web / 测试环境）返回 undefined ⇒ 工具 `available` 为 false
	 * ⇒ 模型看不到它们。**不注册 stub**：给模型一批必然失败的伪工具比不给更糟。
	 */
	private _browserCdpInvoker(): IBrowserCdpInvoker | undefined {
		const vscodeBridge = (globalThis as { vscode?: { ipcRenderer?: { invoke?: (ch: string, payload: unknown) => Promise<unknown> } } }).vscode;
		if (typeof vscodeBridge?.ipcRenderer?.invoke !== 'function') { return undefined; }
		const invoke = vscodeBridge.ipcRenderer.invoke;
		return (req: BrowserCdpRequest) => invoke.call(vscodeBridge.ipcRenderer, BROWSER_CDP_CHANNEL, req) as Promise<IBrowserCdpResponse>;
	}

	// ─── Memory 召回工具 ─────────────────────────────────────────────

	/**
	 * 注册 Memory 相关工具。
	 *
	 * 设计动机：LLM 在 system prompt 里反复看到 “recall / 召回 / save and recall” 等字眼
	 * （来自 agentmemory-memory 扩展描述、bundledTools 描述、builtinMemoryProvider 提示等），
	 * 经常会幻觉调用一个不存在的 `recall` 工具，导致 toolCallUtils 抛出
	 * `Tool "recall" does not exist` 错误。
	 *
	 * 这里把幻觉变成实际能力：通过 IAgentOSService.getActiveMemoryProvider().searchMemory()
	 * 调用当前活跃的 Memory Provider（统一为 AgentMemoryProviderV2，renderer 代理
	 * → 网关宿主引擎 → KV 存储 + BM25/Vector/Graph 混合召回）。
	 *
	 * 懒查询：在 handler 内部解析 provider，避免构造期循环依赖（builtinToolProvider 自身
	 * 也是 IToolProvider，会被 IAgentOSService 注册）。
	 */

	/**
	 * 注册兼容性工具 — Hermes 命名对齐 + 缺失核心工具。
	 *
	 * 问题：bundledTools.ts 中某些工具名与实际 handler 注册名不一致，
	 * 或 Hermes 核心工具在 Saros 中缺少 handler。这导致 LLM 调用时
	 * 报 "Tool does not exist"。
	 *
	 * 修复策略：
	 * 1. 命名不匹配 → 注册别名 handler（schema 用 Hermes 名，handler 委托给真实实现）
	 * 2. 缺失核心工具 → 实现基础 handler（todo 用 in-memory，patch 用文件读写）
	 * 3. 平台不适用 → 返回友好提示（web_search/web_extract 建议配置 MCP server，process 建议 terminal）
	 */
	private _registerCompatibilityTools(): void {
		const folders = this.workspaceService.getWorkspace().folders;
		const workspaceRoot = folders.length > 0 ? folders[0].uri.fsPath : undefined;
		const ctx: CompatToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			fileService: this.fileService,
			logService: this.logService,
			id: this.id,
			workspaceRoot,
			resolveAndCheckWorkspacePath: (agentId, p, req) => this._resolveAndCheckWorkspacePath(agentId, p, req),
			checkpointService: this.checkpointService,
			environmentService: this.environmentService,
			configurationService: this.configurationService,
		};
		registerCompatibilityTools(ctx);
	}

	// ─── G12: Unified Memory API (recall/improve/forget) ─────────────

	/**
	 * G12: 注册统一记忆 API 工具 — 对齐 cognee remember/recall/improve/forget
	 */
	private _registerUnifiedMemoryTools(): void {
		const ctx: UnifiedMemoryToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			logService: this.logService,
		};
		registerUnifiedMemoryTools(ctx);
	}

	/**
	 * 基础记忆工具（memory_remember/search/delete/list）。
	 * 必须在 _registerBundledTools 之前注册——否则 bundled 目录中的
	 * memory_remember/memory_list 会被注册为 stub（isStub=true，LLM 不可调用）。
	 */
	private _registerMemoryTools(): void {
		const ctx: MemoryToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			logService: this.logService,
			// 记忆新增 → activitybar「资料库」徽标提示（见 libraryActivityBadge.ts）
			agentStudioService: this.studioService,
		};
		registerMemoryTools(ctx);
	}

	/**
	 * 高级记忆工具 — 接入引擎已移植但休眠的编排/治理能力：
	 * governance（删除/批量/审计）、team（共享池）、mesh（对等节点）、
	 * sentinel（条件监视）、obsidianExport（导出）、cascade（级联修复）。
	 */
	private _registerAdvancedMemoryTools(): void {
		const ctx: AdvancedMemoryToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			logService: this.logService,
		};
		registerAdvancedMemoryTools(ctx);
	}

	/**
	 * 注册高阶记忆工具：routine（可复用工作流）、crystal（行动链结晶）、facet（多维标签）。
	 * 引擎方法由 AgentMemoryProviderV2 暴露 + 网关转发，此处注册为 LLM 内置工具。
	 */
	private _registerRoutineCrystalFacetTools(): void {
		const ctx: RoutineCrystalFacetToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			logService: this.logService,
		};
		registerRoutineCrystalFacetTools(ctx);
	}

	// ─── Skill 按需读取工具（已抽到 skillTools.ts）───────────────

	private _registerSkillTools(): void {
		const tracker = this._skillUsageTracker;
		const ctx: SkillToolContext = {
			register: (d) => this.register(d),
			skillRegistry: this.skillRegistry,
			skillManagerTool: this._skillManagerTool,
			logService: this.logService,
			environmentService: this.environmentService,
			onSkillRead: (skillId, skillResource) => {
				if (skillResource) {
					tracker.recordRead(skillResource).catch(err =>
						this.logService.warn(`[BuiltinToolProvider] onSkillRead fail: ${err}`)
					);
				}
			},
			onSkillMutated: (_skillName, skillDir) => {
				if (skillDir) {
					tracker.recordPatch(skillDir).catch(err =>
						this.logService.warn(`[BuiltinToolProvider] onSkillMutated fail: ${err}`)
					);
				}
			},
		};
		registerSkillTools(ctx);
	}


	private _registerBundledTools(): void {
		const ctx: BundledToolContext = {
			register: (d) => this.register(d),
			logService: this.logService,
			hasTool: (name) => this._registry.hasTool(name),
		};
		registerBundledTools(ctx);
	}

	/**
	 * 注册委派/子代理相关工具（delegate_task, new_agent）。
	 * 这些工具需要真实的 handler，不能只是 stub。
	 */
	private _registerDelegationTools(): void {
		const ctx: DelegationToolContext = {
			register: (d) => this.register(d),
			id: this.id,
			agentOS: this.agentOS,
			orchestrationService: this.orchestrationService,
			getParentWorktreePath: () => this.getParentWorktreePath(),
			studioService: this.studioService,
			logService: this.logService,
			codebaseGraphService: this.codebaseGraphService,
			workspaceService: this.workspaceService,
		};
		registerDelegationTools(ctx);
	}

	private _registerPlanExploreTool(): void {
		registerPlanExploreTool({
			register: (d) => this.register(d),
			id: this.id,
			agentOS: this.agentOS,
			orchestrationService: this.orchestrationService,
			logService: this.logService,
			getParentWorktreePath: () => this.getParentWorktreePath(),
		});
	}

	/**
	 * 动态工作流工具（dynamic workflows）：模型写 JS 编排脚本扇出子代理。
	 * 区别于 _registerWorkflowTools()（画布工作流的 save/load 工具）。
	 */
	private _registerDynamicWorkflowTool(): void {
		registerWorkflowTool({
			register: (d) => this.register(d),
			id: this.id,
			agentOS: this.agentOS,
			orchestrationService: { subAgentDispatch: this.orchestrationService.subAgentDispatch as unknown as UnifiedSubAgentDispatch | undefined },
			logService: this.logService,
		});
	}

	private _registerPlanModeTools(): void {
		registerPlanModeTools({
			register: (d) => this.register(d),
			source: 'saros.builtin-tools',
		});
	}

	/**
	 * 注册看板（kanban）核心工具的真实 handler。
	 * 参考 Hermes-Agent 的 kanban 工具语义，落地到本项目的 IAgentTaskBoardService。
	 *
	 * 实现的 9 个工具（Hermes 全集）：
	 *  - kanban_create：创建任务卡（编排者用），默认进入 triage 待规划
	 *  - kanban_complete：标记任务完成（写入 result 摘要）
	 *  - kanban_block：阻塞任务（记录原因），状态 → blocked
	 *  - kanban_unblock：解除阻塞，状态 → todo
	 *  - kanban_show：查看单个任务详情
	 *  - kanban_list：列出当前 workspace 任务（可按状态过滤）
	 *  - kanban_heartbeat：刷新任务活跃时间（updatedAt），避免被诊断判为 stranded/stuck
	 *  - kanban_comment：向任务追加一条结构化评论（写入 description）
	 *  - kanban_link：建立父子依赖（child.dependencies += parent）
	 *
	 * agentId → workspaceId 通过 studioService.getAgent(agentId) 解析。
	 */
	private _registerKanbanTools(): void {
		registerKanbanTools({
			register: (def) => this.register(def),
			studioService: this.studioService,
			taskBoardService: this.taskBoardService,
			orchestrationService: this.orchestrationService,
			swarmService: this.swarmService,
			triageService: this.triageService,
			logService: this.logService,
			playwrightService: this.playwrightService,
			editorService: this.editorService,
			sessionsManagement: this.sessionsManagement,
			agentOS: this.agentOS,
			recipeService: this.recipeService,
		});
	}

	private _registerMindmapTools(): void {
		registerMindmapTools({
			register: (def) => this.register(def),
			logService: this.logService,
		});
	}

	private _registerWorkflowTools(): void {
		registerWorkflowTools({
			register: (def) => this.register(def),
			workflowStorageService: this.workflowStorageService,
			studioService: this.studioService,
			logService: this.logService,
		});
	}

	private _registerCanvasTools(): void {
		registerCanvasTools({
			register: (def) => this.register(def),
			logService: this.logService,
		});
	}

	/**
	 * 图片生成工具（2026-09-10）：`image_generate` 的真实 handler。
	 *
	 * 模型来源优先级：调用参数 > 当前 agent 配置（imageProviderId/imageModel，
	 * 由 agent 设置页与聊天框「图片模型」选择器共同写入）> 自动路由。
	 */
	private _registerImageGenTools(): void {
		registerImageGenTools({
			register: (def) => this.register(def),
			agentOS: this.agentOS,
			studioService: this.studioService,
			logService: this.logService,
			// 生成结果落盘到媒体资产库（renderer → 主进程 IPC）。落盘而非把 base64
			// 塞进工具结果字符串：后者会随 tool_result 进入 LLM 上下文，一张 1MP
			// PNG 的 base64 ≈ 1–2MB，直接爆掉上下文预算。
			mediaBackend: createMediaStoreProxy(this.mainProcessService),
			// 用户级图片模型默认（内置 agent 只读时 agent 配置恒为空 → 靠它兜底，
			// 否则会掉进自动路由选中不支持 Images API 的 provider）
			configurationService: this.configurationService,
		});
	}


	// ─── Codebase Tools (built-in, no external MCP binary) ─────────────────
	//
	// Extracted to codebaseTools.ts for maintainability.
	// See codebaseTools.ts for the full implementation.
	//
	private _registerCodebaseTools(): void {
		registerCodebaseTools({
			register: (def) => this.register(def),
			codebaseGraphService: this.codebaseGraphService,
			workspaceService: this.workspaceService,
			fileService: this.fileService,
			logService: this.logService,
			adrManager: this._adrManager,
			searchHelpers: this._searchHelpers,
			id: this.id,
			resolveAndCheckWorkspacePath: (agentId, p, req) => this._resolveAndCheckWorkspacePath(agentId, p, req),
			// 2026-08-09：注入 studioService，让搜索/索引根基于当前激活的 agent 工作区
			//（用户在工作区下拉中选定的 sarosis-agents-client），避免 multi-workspace folders
			// 合并把已切换走的工作区如 S1Game/UE5EA 一起带回来。
			studioService: this.studioService,
			// 2026-08-17：注入 worktree 路径（每轮 turn 前由 agentOSService 设置），
			// 让 search_code/search_files 在 agent 绑定的 worktree 分支内搜索。
			getParentWorktreePath: () => this.getParentWorktreePath(),
		});
	}

	// ── Memory helpers ──────────────────────────────────────────
	// ── Memory helpers ──────────────────────────────────────────


	// ── handoff: supervisor 交接工具（Step B, 设计 §3.3）─────────────
	// 该工具由 agentOSService 的 loop 在工具分发阶段拦截（不真正执行），
	// 生成 AgentCommand 路由到下一节点。仅多节点图模式（`request.agentGraph`
	// 节点 ≥ 2）才暴露给模型（由 _getEnabledTools 过滤），单 agent 模式不可见。
	// 实现见 handoffTools.ts（保持与其它 registerXxxTools(ctx) 模块一致）。
	private _registerMermaidTools(): void {
		registerMermaidTools({
			register: d => this.register(d),
			logService: this.logService,
			// ★ 2026-09-24：注入隐藏 webview 渲染器做「真实校验」——
			//   语法错的图此前只会让卡片报错、模型却收到 "rendered successfully"（不会重试）。
			//   现在失败会把 mermaid 报错回灌给模型，成功则附布局体检建议。
			render: (markup, theme) => this.mermaidRenderer.renderToSvg(markup, theme),
		});
	}

	/**
	 * Draw.io 图示渲染工具（与 `_registerMermaidTools` 完全对称，2026-09-11 补全）。
	 *
	 * 注意注册**时机**：调用点在 `_registerBundledTools()` 之前（见构造函数），
	 * 这样 `ctx.hasTool('renderDrawioDiagram')` 才能命中、跳过 bundled stub。
	 */
	private _registerDrawioTools(): void {
		registerDrawioTools({
			register: d => this.register(d),
			logService: this.logService,
		});
	}

	/**
	 * Unreal Engine 工具（`unreal_*`，2026-09-20 接线）。
	 *
	 * 实现见 unrealTools.ts：它是 BunnySeek 插件 bridge 的 HTTP 客户端
	 * （默认 `http://127.0.0.1:8765/bridge/*`），把工具调用转成 REST 请求，
	 * 因此**不需要知道 UE 装在哪**，也无需任何路径配置。
	 *
	 * 前置条件：Unreal Editor 已启动且启用 `BunnySeekAgent` 插件。bridge 不可达
	 * 时各工具返回可读错误文本（而非抛异常），LLM 据此可提示用户打开编辑器。
	 *
	 * 注册**时机**：`unreal_*` 不在 bundledTools 定义表中，故不受
	 * 「须在 _registerBundledTools 之前」约束；但为与其它真实实现保持一致，
	 * 调用点同样放在 `_registerBundledTools()` 之前。
	 */
	private _registerUnrealTools(): void {
		registerUnrealTools({
			register: d => this.register(d),
			logService: this.logService,
			// bridge 基址走配置（sessions.agentStudio.unreal.bridgeUrl），
			// 留空时 unrealTools 回退内置默认地址。
			getBridgeUrl: () => this.configurationService.getValue<string>(AGENT_STUDIO_UNREAL_BRIDGE_URL_SETTING) ?? '',
		});
	}

	/**
	 * 会话历史搜索工具（`session_search`，2026-09-11 补全）。
	 *
	 * 数据源复用 `IAgentChatService`（会话索引 `sessions.json` + 每会话消息文件），
	 * 因此**无需新增存储**；这里只做服务 → 工具 ctx 的适配（ctx 收窄成两个函数，
	 * 便于单测直接 mock，不必构造整个 IAgentChatService）。
	 *
	 * 注册**时机**：调用点在 `_registerBundledTools()` 之前（见构造函数），
	 * 否则 bundled 里的同名定义会先注册成 stub 并被 `listTools` 跳过。
	 */
	private _registerSessionSearchTools(): void {
		registerSessionSearchTools({
			register: d => this.register(d),
			logService: this.logService,
			listSessions: agentId => this.agentChatService.listAgentSessions(agentId),
			loadMessages: (agentId, sessionId) => this.agentChatService.getHistory(agentId, sessionId),
		});
	}

	/**
	 * 图像分析工具（`vision_analyze`，2026-09-11 补全）。
	 *
	 * 复用既有能力：`IModelProvider.chat` 的**多模态消息已完备支持**
	 * （`IChatMessage.contentParts` + `messageFormatConverter` 已实现 OpenAI /
	 * Anthropic / Gemini 三种图片格式），因此无需新建调用链，只需选模型 + 组装消息。
	 *
	 * 模型来源：设置面板「Vision（图像分析）」写入的 aux 配置 → 自动路由到
	 * 第一个 `supportsImages` 的模型。
	 */
	/**
	 * ★ 2026-09-24：`extract_video_frames` —— 从视频抽帧（yt-dlp 下载 + ffmpeg 抽帧 + 沙箱落盘）。
	 *
	 * 与 `vision_analyze` 是**组合关系**：本工具产出 PNG 路径，vision_analyze 逐张读。
	 * 默认落点 `<userDataPath>/tmp/video-frames/…`（`~/.vssaros` 属允许根、不污染用户工作区）；
	 * 调用方可传 `outDir` 落到知识库（例如 `库/<素材名>/frames/`）以便长期引用。
	 */
	private _registerVideoFrameTools(): void {
		registerVideoFrameTools({
			register: d => this.register(d),
			fileService: this.fileService,
			logService: this.logService,
			resolveAndCheckWorkspacePath: (agentId, requestedPath, checkSandbox) =>
				this._resolveAndCheckWorkspacePath(agentId, requestedPath, checkSandbox),
			defaultOutRoot: URI.joinPath(URI.file(this.environmentService.userDataPath), 'tmp').fsPath,
			// ★ 2026-09-24：二进制解析要能找到**随包内置**的 ffmpeg/ffprobe/yt-dlp
			//   （见 knowledge/mediaBinaries.ts：resourcesPath → appRoot 向上找 build/saros/bin → PATH）。
			appRoot: this.environmentService.appRoot,
			// ★★ 2026-09-24（修复）：必须注入命令通道！
			//   管线的探测**不会**自己兜底成真实执行（缺省是"无通道" ⇒ `no-channel`），
			//   而这两个工具的每一步（`-version` 探测、yt-dlp 下载、ffmpeg 抽帧、ffprobe 取时长）
			//   都要过这里。此前漏注入 ⇒ 生产环境里工具会**一律**返回
			//   `NO_CHANNEL_HINT`（"请在 VsSaros 桌面版里使用"），而单测因为都注入了 fake runner
			//   所以全绿 —— 典型的"测试通过、功能全废"。
			//   （管线那句旧注释写着"默认 execShortCommand"，与实现不符，已一并更正。）
			runCommand: (command, timeoutMs) => execShortCommand(command, timeoutMs),
			// 需登录才给流的站点（小红书等）：yt-dlp 自身不带登录态，靠用户显式开启的设置借用
			// 浏览器 cookie。默认关 ⇒ 返回 undefined/空串 ⇒ 一个参数都不加（见 cookiesFromBrowserArgs）。
			cookiesFromBrowser: () => this.configurationService.getValue<string>(AGENT_STUDIO_BROWSER_COOKIES_FROM_BROWSER_SETTING),
		});
	}

	/**
	 * ★ 2026-09-24：`kb_build` —— agent 发起知识库构建（`mode:'preview'` 只读预检 / `mode:'build'` 发起）。
	 *
	 * 装配方式刻意与 `agentStudio.contribution`（工作区树右键导入）**逐项对齐**：同一份
	 * `KbImportController` 管线、同一套服务、同一套 vault 根解析口径 —— 三处任一漂移都会让
	 * 「agent 构建的库」与「按钮构建的库」指向不同目录。
	 *
	 * 两点取舍：
	 *  · `agentDriverService` 传 `undefined`：agentic 构建改由 `agentChatService` 驱动 ⇒
	 *    构建过程在**知识库专家的聊天会话里可见**（用户能看到进度，而不是"点完没反应"）；
	 *  · 每次调用新建控制器、构建结束后 `dispose()`：控制器只持有 `_kbBuildSessionId` 这类
	 *    「本次构建」的状态，不该跨调用累积（构建缓存/目录则都在磁盘上，天然持久）。
	 */
	private _registerKbBuildTools(): void {
		registerKbBuildTools({
			register: d => this.register(d),
			logService: this.logService,
			configurationService: this.configurationService,
			notificationService: this.notificationService,
			studioService: this.studioService,
			// vault 根：与 `knowledgeBaseView.vaultUri` 同一口径（customPath 优先，否则 <kbDir>/<vaultId>）。
			// 没有激活的库 ⇒ undefined，由工具提示用户去知识库视图选/建一个（而不是在错误目录上"空跑"）。
			resolveVaultRoot: async () => {
				const vault = loadActiveKbVault(this.storageService);
				if (!vault) { return undefined; }
				return vault.customPath
					? URI.file(vault.customPath)
					: URI.joinPath(resolveKbRootUri(this.storageService, this.environmentService), vault.id);
			},
			createRunner: vaultRoot => {
				const controller = new KbImportController(
					this.configurationService, this.logService, this.fileService, this.environmentService,
					this.storageService, this.studioService, this.viewsService, this.editorService,
					this.notificationService, this.requestService,
					undefined,                 // agentDriverService：见方法注释（构建要在聊天会话里可见）
					this.agentChatService,
				);
				return {
					preview: () => KbImportController.previewPendingSources(
						this.fileService, vaultRoot, this.logService, this.notificationService, this.studioService,
					),
					start: () => controller.buildPendingAsAgentSession(vaultRoot)
						.finally(() => controller.dispose()),
					isInFlight: () => KbImportController.buildInFlight,
				};
			},
		});
	}

	/**
	 * ★ 2026-09-24（P1-5）：`process` —— 后台任务管理面（list/output/terminate/wait）。
	 *
	 * 薄封装主进程 `vscode:execCode` 的后台注册表（`_bgExecs`）：启动归 `execute_code`
	 * （background:true），本工具只管"已经在跑的"。主进程侧新增了 `action:'list'`
	 * （见 `src/vs/code/electron-main/app.ts`，顺带回收落定超 30 分钟的条目）。
	 */
	private _registerProcessTools(): void {
		registerProcessTools({ register: d => this.register(d), logService: this.logService });
	}

	/**
	 * ★ 2026-09-24：飞书云文档工具族（`feishu_doc_read` + 4 个评论工具）。
	 *
	 * 走**官方 CLI**（`lark-cli`）—— 与知识库「飞书文档 → markdown 导入」同一条链路
	 * （`kbImportController` 也用 `runLarkCli`），所以不引入任何新凭证/Token 管理；
	 * CLI 自带登录态、URL 解析与 Wiki token 解包。
	 *
	 * 为什么用 `getLarkCliStatus` 先探一次：CLI 是**可选依赖**，未装时要么给安装指引、
	 * 要么让工具在列表阶段就隐藏（后者需要接线 `toolAvailabilityEvaluator`，尚未做）。
	 * 探测结果在工具内部有 30s 记忆化（见 `feishuDriveTools.LARK_CLI_STATUS_TTL_MS`），
	 * 避免一次对话里连续调用 5 个飞书工具就 spawn 5 次 `lark-cli --version`。
	 */
	private _registerFeishuDriveTools(): void {
		registerFeishuDriveTools({
			register: d => this.register(d),
			logService: this.logService,
			getCliStatus: () => getLarkCliStatus(),
			runLarkCli: (args, opts) => runLarkCli(args, opts),
			// ★ 评论内容走 `@file`（见 feishuDriveTools 的 ctx 注释）：内联 JSON 里的引号/&
			//   会在主进程的 cmd + `.cmd` shim 路径上被解析破坏（实测 `--content` 收到截断串）。
			//   落点与 `_writeExtractSpill` 同一 tmp 目录，沿用"下次调用时回收陈旧文件"的纪律 ——
			//   评论内容可能敏感，不能指望崩溃后残留的文件自己消失。
			createTempJsonFile: async (json: string) => {
				const tmpDir = resolveSarosPath(userDataRootFromPath(this.environmentService.userDataPath), SarosPath.tmp);
				await this.fileService.createFolder(tmpDir);
				try {
					const stat = await this.fileService.resolve(tmpDir, { resolveMetadata: true });
					const stale = (stat.children ?? [])
						.filter(c => !c.isDirectory && c.name.startsWith(FEISHU_CONTENT_PREFIX)
							&& Date.now() - (c.mtime ?? 0) > FEISHU_CONTENT_STALE_MS)
						.map(c => c.name);
					for (const name of stale) {
						try { await this.fileService.del(joinPath(tmpDir, name)); } catch { /* 单个失败跳过 */ }
					}
				} catch { /* 目录列举失败 → 本轮不回收 */ }
				const target = joinPath(tmpDir, `${FEISHU_CONTENT_PREFIX}${Date.now()}-${++BuiltinToolProvider._feishuContentSeq}.json`);
				await this.fileService.writeFile(target, VSBuffer.fromString(json));
				return target.fsPath;
			},
			deleteTempFile: async (path: string) => {
				try { await this.fileService.del(URI.file(path)); } catch { /* 清理失败不致命（下次调用会回收） */ }
			},
		});
	}

	/**
	 * ★ 2026-09-24：`video_analyze` —— 视频理解（抽帧 + 字幕 + 多模态模型一次给结论）。
	 *
	 * 依赖与 `extract_video_frames` 完全同源（`videoMediaPipeline`），模型选择与
	 * `vision_analyze` 同源（`visionModelSelect`）—— 两处都不重复实现，避免口径漂移。
	 *
	 * ⚠ 帧图由**我们自己的 ffmpeg** 写入已过沙箱校验的产物目录，再读回来发给模型；
	 *   因此这里直接用 `readLocalImageAsBase64`（只读我们产出的文件），
	 *   不需要 `vision_analyze.loadLocalImage` 那套「任意用户路径」的读守卫三件套。
	 */
	private _registerVideoAnalyzeTools(): void {
		registerVideoAnalyzeTools({
			register: d => this.register(d),
			fileService: this.fileService,
			logService: this.logService,
			resolveAndCheckWorkspacePath: (agentId, requestedPath, checkSandbox) =>
				this._resolveAndCheckWorkspacePath(agentId, requestedPath, checkSandbox),
			defaultOutRoot: URI.joinPath(URI.file(this.environmentService.userDataPath), 'tmp').fsPath,
			appRoot: this.environmentService.appRoot,
			// 命令通道：同上（`video_analyze` 也要下载/抽帧/取字幕，缺了同样恒报 no-channel）
			runCommand: (command, timeoutMs) => execShortCommand(command, timeoutMs),
			// cookie 来源：同上（两条工具共用同一份 yt-dlp 下载参数构造）
			cookiesFromBrowser: () => this.configurationService.getValue<string>(AGENT_STUDIO_BROWSER_COOKIES_FROM_BROWSER_SETTING),
			configurationService: this.configurationService,
			getModelProviders: () => this.agentOS.getModelProviders(),
			// 与 `_registerVisionAnalyzeTools` 读**同一个 key**（多模态默认模型 = 知识库专家配置的模型）
			getKbExpertModel: () => {
				const sel = this.modelSelectorService.getExplicitSelectionForAgent('knowledge-base-expert');
				return (sel?.providerId && sel.modelId)
					? { providerId: sel.providerId, modelId: sel.modelId }
					: undefined;
			},
		});
	}

	private _registerVisionAnalyzeTools(): void {
		registerVisionAnalyzeTools({
			register: d => this.register(d),
			logService: this.logService,
			configurationService: this.configurationService,
			getModelProviders: () => this.agentOS.getModelProviders(),
			// ★ 2026-09-13：主模型是否支持图片输入 —— 决定 `mode:auto` 走「附上图像」还是
			// 「aux 模型给文本答案」。复用 `toolResultImages.resolveSupportsImages`
			// （按 provider::model 缓存 + fail-closed），与 agent loop 里的判定**同一真源**。
			mainModelSupportsImages: async () => {
				const sel = this.agentOS.getActiveModelSelection();
				const provider = this.agentOS.getModelProviders().find(p => p.id === sel?.providerId);
				return resolveSupportsImages(provider, sel?.modelId);
			},
			// ★ 2026-09-22：多模态的**默认**模型 = 「知识库专家」配置的模型。
			//
			// 需求：用户在知识库专家里配了看图能力强的模型，图片分析就应当用它 ——
			// 此前两者完全脱节（本工具只读 Vision 辅助设置 + 自动路由）。
			//
			// ⚠ 只取**显式配置**的选择（`getExplicitSelectionForAgent`，与
			//   `agentStudioService._resolveKbChatModel` 读同一个 key）：未配置时返回 undefined，
			//   由 `visionAnalyzeTools` 继续走自动路由 ⇒ 无专家配置时行为与改动前**完全一致**。
			// ⚠ 是否支持图片由 `visionAnalyzeTools` 侧校验（专家可能配的是纯文本模型）。
			getKbExpertModel: () => {
				const sel = this.modelSelectorService.getExplicitSelectionForAgent('knowledge-base-expert');
				return (sel?.providerId && sel.modelId)
					? { providerId: sel.providerId, modelId: sel.modelId }
					: undefined;
			},
			// ★ 2026-09-13：本地图片路径支持 —— **复用 `file_read` 的同一套读护栏**
			// （沙箱路径解析 / 设备伪文件系统 / 敏感路径读守卫）。
			//
			// 为什么必须同源：本工具把字节**发给外部模型 provider**，与 `file_read` 的
			// 出网面完全一致。若这里不跑那三件套，它就成了一条**绕过读守卫的通道**
			// （image 后缀不在敏感名表里，但目录级敏感项如 `.ssh/` `.aws/` `.config/gcloud/`
			// 仍会被 `detectSensitivePath` 命中 —— 漏掉就是又一个「另一条出口没挂检查」，
			// 那是今天最高频的缺陷形态）。
			loadLocalImage: async (requestedPath, agentId) => {
				// 读操作：与 `file_read` 一致，只解析、不触发沙箱拒绝（checkSandbox=false）
				const resolved = await this._resolveAndCheckWorkspacePath(agentId, requestedPath, false);
				const deviceHit = detectDevicePath(resolved);
				if (deviceHit) {
					throw new Error(devicePathBlockedMessage(deviceHit, 'read'));
				}
				const guardEnabled = this.configurationService.getValue<boolean>(
					AgentNetworkDomainSettingId.SensitiveReadGuard,
				) ?? true;
				if (guardEnabled) {
					const sensitiveHit = detectSensitivePath(resolved);
					if (sensitiveHit) {
						this.logService.warn(
							`[BuiltinTools] vision_analyze BLOCKED: ${requestedPath} matches sensitive ${sensitiveHit.kind} "${sensitiveHit.matched}"`,
						);
						throw new Error(sensitiveReadBlockedMessage(sensitiveHit));
					}
				}
				return readLocalImageAsBase64(this.fileService, resolved);
			},
		});
	}

	/**
	 * 视频 / 语音生成工具（`video_generate`、`text_to_speech`，2026-09-11 补全）。
	 *
	 * 底层能力早已实现（`IModelProvider.generateVideo/generateAudio` + 扩展命令转发 +
	 * host RPC + 画布节点），此前仅缺 LLM 工具入口 —— 与 `image_generate` 完全对称
	 * （后者 2026-09-10 已补），故此处照同一模式接线。
	 *
	 * 注册**时机**：调用点在 `_registerBundledTools()` 之前（见构造函数）。
	 */
	private _registerMediaGenTools(): void {
		registerMediaGenTools({
			register: d => this.register(d),
			logService: this.logService,
			getModelProviders: () => this.agentOS.getModelProviders(),
		});
	}

	/**
	 * 定时任务工具（`cronjob`，2026-09-11 补全）。
	 *
	 * 底层 `IAgentSchedulerService` 早已实现（含 Cron 解析、执行策略、执行历史、
	 * 定时任务视图），此前仅缺 LLM 工具入口 —— 模型无法用自然语言创建定时任务。
	 *
	 * 注册**时机**：调用点在 `_registerBundledTools()` 之前（见构造函数）。
	 */
	private _registerSchedulerTools(): void {
		registerSchedulerTools({
			register: d => this.register(d),
			logService: this.logService,
			scheduler: this.schedulerService,
		});
	}

	private _registerHandoffTools(): void {
		registerHandoffTools({
			register: d => this.register(d),
			id: this.id,
		});
	}
}

