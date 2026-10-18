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
	AGENT_STUDIO_WEB_SEARCH_PROVIDER_SETTING,
	AGENT_STUDIO_WEB_SEARCH_SEARXNG_URL_SETTING,
	AGENT_STUDIO_WEB_SEARCH_TAVILY_KEY_SETTING,
	AGENT_STUDIO_WEB_SEARCH_BRAVE_KEY_SETTING,
	AGENT_STUDIO_WEB_SEARCH_EXA_KEY_SETTING,
	AGENT_STUDIO_WEB_SEARCH_CACHE_ENABLED_SETTING,
	// 2026-10-17（5.5 前置）：AGENT_STUDIO_BROWSER_COOKIES_FROM_BROWSER_SETTING 摘了——
	//   web_scrape_to_board 退役（它不再被读 ✓）。
} from '../../../common/constants.js';
import { getToolsetForTool, UTILITY_BUCKET_WHITELIST } from '../../../common/toolsetConfig.js';
// 2026-10-17（5.5 前置）：ISkillRegistry 的 import 摘了——skills 工具退役（`_registerSkillTools` 删了 ⇒
//   没人读它 ✓）。
// 2026-10-17（5.5 前置）：IModelSelectorService 的 import 摘了——modelSelectorService 的注入摘了（没人读 ✓）。
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { resolveToolMutationKey, withFileMutationQueue } from '../../../common/fileMutationQueue.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IAgentStudioService, ITaskOrchestrationService } from '../../../../../common/agentStudioService.js';
// 2026-10-17（5.5 前置）：IAgentChatService 的 import 摘了——agentChatService 的注入摘了（没人读 ✓）。
// 2026-10-17（5.5 前置）：kanban 工具退役（见构造函数的注释）——IAgentTaskBoardService / ITriageService /
//   ISwarmService / registerKanbanTools / IPlaywrightService / ISessionsManagementService 的 import 摘了
//   （kanban 工具是它们的唯一使用方 ✓）。
import { ICheckpointService } from '../../../common/checkpointService.js';
import { IAgentOSService } from '../../../common/agentOS.js';
// 2026-10-17（5.5 前置）：IWorkflowStorageService 的 import 摘了——workflowStorageService 的注入摘了（没人读 ✓）。
import { resolveEffectiveWorktreeRoot } from '../../../common/worktreeBinding.js';
// 2026-10-17（5.5 前置）：SkillManagerTool / SkillUsageTracker 的 import 摘了——skills 工具退役
//   （_registerSkillTools 删了 ⇒ 没人读它们 ✓）。
import { ICodebaseGraphService } from '../../codebaseGraphService.js';
// 2026-10-17（5.5 前置）：AdrManager 的 import 摘了——_adrManager 摘了（codebase 工具是它的唯一使用方 ✓）。
// 2026-10-17（5.5 前置）：registerCodebaseTools 的 import 摘了——codebase 工具族退役（见构造函数的注释）。
// 2026-10-17（5.5 前置）：registerWorkflowTools 的 import 摘了——workflow 工具族退役（见构造函数的注释）。
import { registerCanvasTools } from './canvasTools.js';
// 2026-10-17（5.5 前置）：registerImageGenTools 的 import 摘了——image_generate 退役（见构造函数的注释）。
import { registerMindmapTools } from './mindmapTools.js';
// 2026-10-17（5.5 前置）：createMediaStoreProxy 的 import 摘了——media 工具退役（见构造函数的注释）。
// 2026-10-17（5.5 前置）：IMainProcessService / IEditorService 的 import 摘了——mainProcessService / editorService 的注入摘了（没人读 ✓）。
// ★ 2026-09-24：`kb_build` 要按「知识库视图」那样**造一个 KbImportController**（同一份管线、
//   同一套服务），故需 views / notification 两个服务（前者用于打开知识库视图，后者用于
//   「知识库专家未配置模型」的提醒与构建失败通知）。
// 2026-10-17（5.5 前置）：IViewsService / INotificationService 的 import 摘了——viewsService / notificationService 的注入摘了（没人读 ✓）。
// 2026-10-17（5.5 前置）：recipeService 的注入摘了（kanban 工具是它的唯一使用方 ✓）——
//   IKanbanRecipeService 的 import 留着（类型还被别处用 ⇒ 5.5 真删时一起删）。
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
// 2026-10-17（5.5 前置）：memory 工具全族退役（见构造函数的注释）——unifiedMemoryTools /
//   memoryTools / advancedMemoryTools / routineCrystalFacetTools 的 import 摘了。
// 2026-10-17（5.5 前置）：registerSkillTools 的 import 摘了——skills 工具退役（见构造函数的注释）。
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
// 2026-10-17（5.5 前置）：registerKbBuildTools 的 import 摘了——kb_build 退役（见构造函数的注释）。
// ★ 2026-09-24：飞书云文档工具族（读文档 / 评论 5 个）—— 从 Hermes 的 feishu_* 工具移植
//   能力（上游那套靠"评论事件注入 client"，我们改成按需调用官方 CLI，见该文件头）。
import { registerProcessTools } from './processTools.js';
// 2026-10-17（5.5 前置）：registerFeishuDriveTools 的 import 摘了——feishu 工具族退役（见构造函数的注释）。
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
// 2026-10-17（5.5 前置）：FEISHU_CONTENT_PREFIX / FEISHU_CONTENT_STALE_MS / runLarkCli 摘了——
//   feishu 工具族退役（见构造函数的注释）。getLarkCliStatus 留着（能力探测还在用 ✓——543 行）。
import { getLarkCliStatus } from '../../larkCliService.js';
// 视频工具的命令通道（主进程 vscode:execCode；与知识库同步/飞书工具同一套原语）
import { execShortCommand } from '../../knowledge/feishuSyncCore.js';
// 2026-10-17（5.5 前置）：KbImportController / loadActiveKbVault / resolveKbRootUri 的 import 摘了——
//   kb 工具族退役（见构造函数的注释）。
import { resolveAndCheckWorkspacePathImpl } from './workspaceSecurity.js';
import { registerCoreTools } from './coreTools.js';
import { executeToolImpl } from './toolExecutor.js';
import { registerHandoffTools } from './handoffTools.js';
import { registerMermaidTools } from './mermaidTools.js';
import { registerDrawioTools } from './drawioTools.js';
// ★ 2026-10-13：`registerUnrealTools`（`./unrealTools.js`）**已移除** ✗ —— unreal 族（七个工具）
//   全部由 dsh 侧插件 `@vssaros/dsh-unreal` 提供（Host 直连 `/bridge/*`，带审批闸 ✓，README 4.68）。
//   IDE 侧再留一份只会让同名工具两处注册（dsh 侧是**静默顶掉**）⇒ 已在 2026-10-13 整份删除 ✓。
// 2026-10-17（5.5 前置）：registerSessionSearchTools 的 import 摘了——session_search 退役（见构造函数的注释）。
// 2026-10-17（5.5 前置）：registerVisionAnalyzeTools / readLocalImageAsBase64 的 import 摘了——vision_analyze 退役（见构造函数的注释）。
// 2026-10-17（5.5 前置）：sensitivePaths 的 import 摘了——media 工具退役（它不再被读 ✓）。
// 2026-10-17（5.5 前置）：AgentNetworkDomainSettingId 的 import 摘了——media 工具退役（见构造函数的注释）。
// 主模型图片能力判定（与 agent loop 同一真源，带 provider::model 缓存 + fail-closed）
// 2026-10-17（5.5 前置）：resolveSupportsImages / registerMediaGenTools / registerVideoFrameTools /
//   registerVideoAnalyzeTools 的 import 摘了——media 工具退役（见构造函数的注释）。
// 2026-10-17（5.5 前置）：cronjob 工具退役（见构造函数的注释）——schedulerTools / IAgentSchedulerService 的 import 摘了。
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


	// 2026-10-17（5.5 前置）：_skillManagerTool / _skillUsageTracker 的声明删了——skills 工具退役
	//   （`_registerSkillTools` 删了 ⇒ 没人读它们 ✓）。SkillManagerTool / SkillUsageTracker 的 import 留着
	//   （类型还被别处用 ⇒ 5.5 真删时一起删）。

	/** web_extract 本地页面缓存（P2）—— 懒构造，见 `_getWebPageCache`。 */
	private _webPageCache?: WebPageCache;
	/** web_search 结果备忘（内存 + TTL + 单飞）—— 懒构造，见 `_getSearchMemo`。 */
	private _searchMemo?: WebSearchMemo;


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
	// 2026-10-17（5.5 前置）：_adrManager 摘了——codebase 工具是它的唯一使用方 ✓。

	/** 搜索相关 helper 集合（从本文件抽取到 searchHelpers.ts，降低主文件体积） */
	private readonly _searchHelpers: SearchHelpers;

	/** Core tools per-turn reset 回调（清空读去重/重复计数 Map）。 */
	private _corePerTurnReset?: () => void;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		// 2026-10-17（5.5 前置）：skillRegistry 的注入摘了——skills 工具退役（`_registerSkillTools` 删了 ⇒
		//   没人读它 ✓）。ISkillRegistry 的 import 留着（类型还被别处用 ⇒ 5.5 真删时一起删）。
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAgentStudioService private readonly studioService: IAgentStudioService,
		// 2026-10-17（5.5 前置）：`schedulerService` 摘了——cronjob 工具退役（见构造函数的注释）。
		@IAgentOSService private readonly agentOS: IAgentOSService,
		@ITaskOrchestrationService private readonly orchestrationService: ITaskOrchestrationService,
		// 2026-10-17（5.5 前置）：kanban 工具退役（见构造函数的注释）——taskBoardService / triageService /
		//   swarmService / playwrightService / sessionsManagement 的注入摘了（kanban 工具是它们的唯一使用方 ✓）。
	@ICheckpointService private readonly checkpointService: ICheckpointService,
	@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		// 2026-10-17（5.5 前置）：workflowStorageService 的注入摘了——workflow 工具族是它的唯一使用方 ✓。
		@ICodebaseGraphService private readonly codebaseGraphService: ICodebaseGraphService,
		// 2026-10-17（5.5 前置）：recipeService 的注入摘了（kanban 工具是它的唯一使用方 ✓）。
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
		// ★ 2026-09-24：`kb_build`（agent 发起知识库构建）需要按视图同样的方式装配
		//   `KbImportController`（它有 9 个必需依赖：configuration/log/file/env/storage/
		//   studio/views/editor/notification/request）。其余所需服务本类已有。
	) {
		super();
		// 2026-10-17（5.5 前置）：_skillManagerTool / _skillUsageTracker 的赋值删了——skills 工具退役
		//   （`_registerSkillTools` 删了 ⇒ 没人读它们 ✓）。
		// 2026-10-17（5.5 前置）：_adrManager 的赋值摘了——codebase 工具退役（见构造函数的注释）。
		this._searchHelpers = new SearchHelpers(this.fileService, this.searchService, this.logService, this.configurationService);
		// Phase 1: 注册内置 embedding provider（复用 BYOK API → /v1/embeddings）
		// 使 kb_* 工具无需扩展即可工作
		this._registerEmbeddingProvider();
		this._registerCoreTools();
		this._registerWebTools();
		this._registerCompatibilityTools();
		// ★ 2026-09-24（P1-5）：process 的真实实现（此前只是 compatibilityTools 里的提示占位，
		//   占位已从那里移除）。必须在 _registerBundledTools 之前 —— bundled 里有同名 stub。
		this._registerProcessTools();
		// 2026-10-17（5.5 前置）：memory 工具全族**退役**——dsh 侧的 memory 插件已迁（23 个工具都在
		//   `vssaros-memory` 里 ✓——工具快照里都有 ✓：remember/recall/forget/search/delete/list +
		//   governance/team/mesh/sentinel/obsidian_export/cascade + routine/crystal/facet + improve +
		//   skill/slot/stats/work/lesson/refresh/import/api）。legacy 侧的注册注释掉 ⇒ 模型看不到了 ✓
		//   （dsh 侧的还在 ✓）。文件留着（memoryTools / unifiedMemoryTools / advancedMemoryTools /
		//   routineCrystalFacetTools 等）等 5.5 真删。
		// this._registerUnifiedMemoryTools(); // G12: recall/improve/forget
		// this._registerMemoryTools(); // remember/search/delete/list（真实 handler，须在 bundled stub 之前注册）
		// this._registerAdvancedMemoryTools(); // 接入引擎编排/治理能力：governance/team/mesh/sentinel/obsidian/cascade
		// this._registerRoutineCrystalFacetTools(); // 接入高阶记忆能力：routine/crystal/facet
		// 2026-10-17（5.5 前置）：skills 工具**退役**——dsh 侧的 skills 全族已迁（4 个工具都在
		//   `vssaros-skills` 插件里 ✓：skill_manage + skill_search + skill_market_list + read_skill +
		//   list_skills——工具快照里都有 ✓）。legacy 侧的注册注释掉 ⇒ 模型看不到了 ✓（dsh 侧的还在 ✓）。
		//   文件留着（skillTools.ts）等 5.5 真删。
		// this._registerSkillTools();
		// ★ 2026-09-10：image_generate 真实实现，必须在 _registerBundledTools 之前 ——
		// 后者对未注册的 bundled 定义注册 stub（isStub → listTools 跳过），
		// 先注册真实 handler 才能让 LLM 看到并调用该工具（ctx.hasTool 判据）。
		// 2026-10-17（5.5 前置）：image_generate 退役——dsh 侧的 vssaros-media 已迁 ✓。
		// this._registerImageGenTools();
		// ★ 2026-09-11：drawio 真实实现，同样**必须在 _registerBundledTools 之前** ——
		// 否则 bundled 里的 renderDrawioDiagram 定义会因 ctx.hasTool() 未命中而被
		// 注册成 stub（isStub → listTools 跳过）→ 模型看不到该工具，整条 drawio 链路
		// （渲染器 drawioInlineRenderer / 卡片 drawioCard / 预览命令）成为永远走不到
		// 的死代码。与 _registerImageGenTools 同一模式（见其上方注释）。
		this._registerDrawioTools();
		// ★ 2026-10-13：`this._registerUnrealTools()` **已移除** ✗ —— unreal 族整份下移到 dsh 侧
		//   `@vssaros/dsh-unreal`（七个工具都由 Host 直连 `/bridge/*` 执行 ✓、执行类挂审批闸 ✓）。
		//   ⚠ 留档（2026-09-20 的坑）：在**本文件**注册过工具但 `toolsetConfig` 没登记前缀 ⇒ 落 `utility`
		//   兜底桶 ⇒ focus 模式整条剔除且**零日志**；所以删除族时也要一并清 `toolsetConfig` 的条目 ✓。
		// ★ 2026-09-11：session_search 真实实现，同样必须在 _registerBundledTools 之前
		// —— 否则 bundled 里的 session_search 定义会被注册成 stub（isStub → listTools
		// 跳过）→ 模型永远看不到（此前正是此状态：配置项 / 工具名映射 / 白名单俱全，
		// 唯独缺 handler）。
		// 2026-10-17（5.5 前置）：session_search 退役——dsh 侧的 vssaros-sessions 已迁 ✓。
		// this._registerSessionSearchTools();
		// ★ 2026-09-11：vision_analyze 真实实现（同源半成品第 4 例），同样必须在
		// _registerBundledTools 之前 —— 否则 bundled 定义被注册成 stub 并被 listTools
		// 跳过 → 模型看不到（此前正是此状态）。
		// 2026-10-17（5.5 前置）：vision_analyze 退役——dsh 侧的 vssaros-media 已迁 ✓。
		// this._registerVisionAnalyzeTools();
		// ★ 2026-09-11：video_generate / text_to_speech 真实实现（同源半成品第 5、6 例），
		// 同样必须在 _registerBundledTools 之前 —— 否则 bundled 定义被注册成 stub
		// 并被 listTools 跳过 → 模型看不到（此前正是此状态）。
		// 2026-10-17（5.5 前置）：media 生成三件套（video_generate / text_to_speech）退役——dsh 侧的 vssaros-media 已迁 ✓。
		// this._registerMediaGenTools();
		// ★ 2026-09-11：cronjob 真实实现（同源半成品第 7 例）—— 调度能力与视图早已
		// 齐备，唯独缺 LLM 工具入口；同样必须在 _registerBundledTools 之前注册。
		// 2026-10-17（5.5 前置）：cronjob 工具**退役**——dsh 侧的调度器是官方 bundle
		//   （`dsh-schedule` 的 `schedule_create`，Phase 2 的 2.1 已接管 ✓）；legacy 的
		//   `agentSchedulerService` **从来没有执行过**（`await async *` 不迭代 ⇒ 函数体没跑 ✗，
		//   `dshModuleContainers.ts` 的注释写清了）⇒ 它是死代码 ✓。不再注册 ⇒ 模型看不到了 ✓；
		//   文件留着（`schedulerTools.ts` / `agentSchedulerService.ts` / `common/agentScheduler.ts`）
		//   等 5.5 真删。
		// this._registerSchedulerTools();
		// ★ 2026-09-24：extract_video_frames —— 补齐「视频画面」能力（此前只有封面一张静止图，
		//   依赖画面的任务只能靠模型编造）。同样注册在 _registerBundledTools 之前；
		//   命令拼装/清理逻辑见 videoFrameTools.ts / videoMediaPipeline.ts 头注释。
		// 2026-10-17（5.5 前置）：extract_video_frames 退役——dsh 侧的 vssaros-media 已迁 ✓。
		// this._registerVideoFrameTools();
		// ★ 2026-09-24：video_analyze 真实实现 —— 此前只有 bundled 定义（category 'video'）无 handler，
		//   被判为 stub ⇒ listTools 跳过 ⇒ 模型**根本看不到**这个工具。
		//   它 = 抽帧 + 字幕 + 多模态模型一次给结论（与 extract_video_frames 互补，见其头注释）。
		//   同样必须在 _registerBundledTools 之前，否则 stub 会把真 handler 顶掉。
		// 2026-10-17（5.5 前置）：video_analyze 退役——dsh 侧的 vssaros-media 已迁 ✓。
		// this._registerVideoAnalyzeTools();
		this._registerBundledTools();
		this._registerDelegationTools();
		this._registerPlanExploreTool(); // WorkBuddy-style plan mode: parallel exploration
		this._registerDynamicWorkflowTool(); // dynamic workflows: 模型写 JS 脚本编排子代理
		this._registerPlanModeTools(); // MiMo-style plan_enter/plan_exit tools
		// 2026-10-17（5.5 前置）：kanban 工具**退役**——dsh 侧的 kanban 全族已迁（17 个工具都在
		//   `vssaros-kanban` 插件里 ✓——工具快照里都有 ✓）。legacy 侧的注册注释掉 ⇒ 模型看不到了 ✓
		//   （dsh 侧的还在 ✓）。文件留着（`kanbanTools.ts` 的常量/函数还被别处用：`SAROS_CLAW_AGENT_ID` /
		//   `resolveScrapeSessionId` 被 kanbanScrapeService / browserKanbanContextMenu 用 ✓）等 5.5 真删。
		// this._registerKanbanTools();
		this._registerMindmapTools();
		// 2026-10-17（5.5 前置）：workflow 工具族（workflow_list / workflow_get / workflow_get_schema /
		//   workflow_apply）退役——dsh 侧的 vssaros-workflow 已迁 ✓（4 个都在 ✓——工具快照里都有 ✓）。
		// this._registerWorkflowTools();
		this._registerCanvasTools();
		// 2026-10-17（5.5 前置）：codebase 工具族退役——dsh 侧的 vssaros-codebase 已迁 ✓
		//   （18 个里 17 个迁了 ✓；ingest_traces 刻意不迁：dsh 里没有被测应用 + 动态边混进静态图
		//   不可证伪 ✗——`vssaros-codebase/lib/index.js:121` 的注释写清了 ✓）。
		// this._registerCodebaseTools();
		// 2026-10-17（5.5 前置）：kb 工具族（kb_search 等）退役——dsh 侧的 vssaros-kb 已迁 ✓。
		// this._registerKnowledgeTools(); // llm-wiki 知识内核（kb_search 工具）
		// ★ 2026-09-24：`kb_build` —— 构建此前**只有 UI 入口**（视图「批量构建库」/ 右键「构建为笔记」），
		//   于是「素材先落库、再构建」的链路（如 kb-game-teardown 把拆解写进 库/raw）走到最后一步就断了：
		//   agent 只能让用户自己去点按钮。本工具补齐该入口（走同一条 agent 会话构建路径）。
		// 2026-10-17（5.5 前置）：kb_build 退役——dsh 侧的 vssaros-kb 已迁 ✓。
		// this._registerKbBuildTools();
		// ★ 2026-09-24：飞书文档工具族（读文档 + 评论读/写）—— 同样必须在 _registerBundledTools
		//   之前：bundled 里有 5 个同名 stub，晚注册会被 stub 顶掉（真 handler 失效）。
		// 2026-10-17（5.5 前置）：feishu 工具族（feishu_doc_read / feishu_drive_list_comments /
		//   feishu_drive_list_comment_replies / feishu_drive_reply_comment / feishu_drive_add_comment）
		//   退役——dsh 侧的 vssaros-kb 已迁 ✓（5 个都在 ✓——工具快照里都有 ✓）。
		// this._registerFeishuDriveTools();
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
	// 2026-10-17（5.5 前置）：_feishuContentSeq 摘了——feishu 工具族退役（见构造函数的注释）。

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

	// ─── Skill 按需读取工具（已抽到 skillTools.ts）───────────────


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

	// 2026-10-17（5.5 前置）：`_registerKanbanTools` 删了——kanban 工具退役（见构造函数的注释）。
	//   kanbanTools.ts 的常量/函数（SAROS_CLAW_AGENT_ID / resolveScrapeSessionId）还被别处用 ⇒ 文件留着等 5.5 真删。


	private _registerMindmapTools(): void {
		registerMindmapTools({
			register: (def) => this.register(def),
			logService: this.logService,
		});
	}

	// 2026-10-17（5.5 前置）：`_registerWorkflowTools` 删了——workflow 工具族退役（见构造函数的注释）。
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


	// ─── Codebase Tools (built-in, no external MCP binary) ─────────────────
	//
	// Extracted to codebaseTools.ts for maintainability.
	// See codebaseTools.ts for the full implementation.
	//

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
	 * ★ 2026-10-13：`_registerUnrealTools()` **整块已删除** ✗（连同 `./unrealTools.js` 与它的定义表）。
	 *
	 * 为什么删：七个 `unreal_*` 现在**只有一份实现** ✓ —— dsh 侧 `dsh-plugins/vssaros-unreal`
	 * （Host 进程内直连 `http://127.0.0.1:8765/bridge/*` ✓：Host 是 Node，连 CORS 都没有；
	 * 而这边当初要绕 renderer 的 CORS ✗）。执行类三个（exec/wait/build）在 Host 侧挂官方
	 * `tools/pre-execute` ⇒ `ask` 闸 ✓ —— 权限靠闸守，而不是靠"某侧不提供" ✗。
	 *
	 * ⚠ 桥地址配置 `sessions.agentStudio.unreal.bridgeUrl` 仍**有效** ✓：它现在由 VsSaros 经
	 * `--patch` 覆盖层注入 **Host 侧插件**的 `config.bridgeUrl`（见 `common/dshHarness.ts` 的说明 ✓）。
	 */

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


	/**
	 * 视频 / 语音生成工具（`video_generate`、`text_to_speech`，2026-09-11 补全）。
	 *
	 * 底层能力早已实现（`IModelProvider.generateVideo/generateAudio` + 扩展命令转发 +
	 * host RPC + 画布节点），此前仅缺 LLM 工具入口 —— 与 `image_generate` 完全对称
	 * （后者 2026-09-10 已补），故此处照同一模式接线。
	 *
	 * 注册**时机**：调用点在 `_registerBundledTools()` 之前（见构造函数）。
	 */

	/**
	 * 定时任务工具（`cronjob`，2026-09-11 补全）。
	 *
	 * 底层 `IAgentSchedulerService` 早已实现（含 Cron 解析、执行策略、执行历史、
	 * 定时任务视图），此前仅缺 LLM 工具入口 —— 模型无法用自然语言创建定时任务。
	 *
	 * 注册**时机**：调用点在 `_registerBundledTools()` 之前（见构造函数）。
	 */
	// 2026-10-17（5.5 前置）：`_registerSchedulerTools` 删了——cronjob 工具退役（见上面构造函数的注释）。

	private _registerHandoffTools(): void {
		registerHandoffTools({
			register: d => this.register(d),
			id: this.id,
		});
	}
}

