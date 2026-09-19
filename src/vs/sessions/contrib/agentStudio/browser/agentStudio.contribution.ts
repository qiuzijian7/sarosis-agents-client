/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { AGENTS_WINDOW_EXTENSION_AGENT_CONTRIBUTIONS_SETTING, AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING, AGENTS_WINDOW_EXTENSION_MODE_SETTING } from '../../../../platform/extensionManagement/common/agentsWindowExtensionPolicy.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IContextKeyService, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILocalizedString, localize, localize2 } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Action2, registerAction2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ActiveEditorContext } from '../../../../workbench/common/contextkeys.js';
import { AuxChatSessionSideView } from '../../sessionHistory/browser/auxChatSessionSideView.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';

// Codebase-Memory-MCP bootstrap — auto-detect, install, and start on app launch.
// Side-effect import: the module self-registers a workbench contribution.
import './codebaseMemoryMcpBootstrap.js';

// Platform Bridge Layer (cc-connect 复刻) — registers IBridgeService + auto-starts.
import './bridge/bridge.contribution.js';

// 单向同步适配器：llm_wiki 文章 → Sarosis WikiTag library（自包含注册）。
import './services/llmWikiAdapter.contribution.js';

// Chat tab "Rename" command + editor title context menu entry.
// Side-effect import: the module self-registers the command and menu item.
import './chatTabRename.js';

import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../workbench/common/editor.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../../workbench/browser/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { AgentStudioPanelType } from '../common/constants.js';

import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService, ITaskOrchestrationService, IConfigHtmlService } from '../common/agentStudio.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IAgentDriverService } from '../common/agentDriver.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { IAgentModelResolver, AgentModelResolver } from '../common/agentModelResolver.js';
import { IWorkspaceRegistry } from '../common/agentWorkspace.js';
import { IAgentInstanceService, IAgentGalleryService } from '../common/agentInstance.js';
import { IAgentStudioLogService, AgentStudioLogService } from './agentStudioLogService.js';
import { IFeedbackService, FeedbackService } from './feedbackService.js';
import { AgentStudioService } from './agentStudioService.js';
import { AgentChatService } from './agentChatService.js';
import { ConfigHtmlService } from './configHtmlService.js';
import { AgentOSService } from './agentOSService.js';
import { AgentDriverService } from './agentDriverService.js';
import { ModelSelectorService } from './modelSelectorService.js';
import { WorkspaceRegistryService } from './workspaceRegistryService.js';
import { AgentInstanceService } from './agentInstanceService.js';
import { AgentGalleryService } from './agentGalleryService.js';
import { AgentDelegationService } from './agentDelegationService.js';
import { IGitCommitService, GitCommitService } from './gitCommitService.js';
import { IAgentSchedulerService } from '../common/agentScheduler.js';
import { AgentSchedulerService } from './agentSchedulerService.js';
import { IHealthMonitorService } from '../common/healthMonitor.js';
import { HealthMonitorService } from './healthMonitorService.js';
import { ICrewTeamService } from '../common/crewTeam.js';
import { CrewTeamService } from './crewTeamService.js';
import { IWorkflowStorageService } from '../common/workflowStorage.js';
import { WorkflowStorageService } from './workflowStorageService.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { WorkflowExecutionService } from './workflowExecutionService.js';
import { IWorkflowVersionService } from '../common/workflowVersionTypes.js';
import { WorkflowVersionService } from './workflowVersionService.js';
import { IEventBridgeService, EventBridgeService } from '../common/eventBridge.js';
import { TaskOrchestrationService } from './taskOrchestrationService.js';
import { IWorkspaceLifecycleService } from '../common/workspaceLifecycle.js';
import { WorkspaceLifecycleService } from './workspaceLifecycleService.js';
import { ISkillLifecycleService } from '../common/skillLifecycle.js';
import { SkillLifecycleService } from './skillLifecycleService.js';
import { IKbNativeKernelService, KbNativeKernelService } from './kbNativeKernelService.js';
import { migrateLegacyKbSessions } from './knowledge/kbLegacyMigration.js';
import { loadActiveKbVault, resolveVaultNotesDir, resolveKbRootUri } from './knowledge/kbVaultState.js';
import { KbVersionService, IKbVersionService } from './kbVersionService.js';
import { SkillVersionService, ISkillVersionService } from './skillVersionService.js';
import { AgentVersionService } from './agentVersionService.js';
import { IAgentVersionService } from '../common/agentVersionTypes.js';
import { IEmbeddingService, EmbeddingService } from './embedding/embeddingService.js';
import {
	AGENT_STUDIO_ENABLED_SETTING,
	AGENT_STUDIO_WORKSPACE_VIEW_ID,
	AGENT_STUDIO_PRESET_AGENT_VIEW_ID,
	AGENT_STUDIO_TASKS_VIEW_ID,
	AGENT_STUDIO_INTEGRATION_VIEW_ID,
	AGENT_STUDIO_SEARCH_VIEW_ID,
	AGENT_STUDIO_PLUGINS_VIEW_ID,
	AGENT_STUDIO_WORKFLOW_VIEW_ID,
	AGENT_STUDIO_DASHBOARD_VIEW_ID,
	AGENT_STUDIO_KB_VIEW_ID,
	AGENT_STUDIO_DATA_PATH_SETTING,
	AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING,
	AGENT_STUDIO_CHAT_STREAM_LOG_DUMP_TOOLS_SETTING,
	AGENT_STUDIO_LANGUAGE_SETTING,
	AGENT_STUDIO_RESPONSE_LANGUAGE_SETTING,
	AGENT_STUDIO_SEND_KEY_SETTING,
	AGENT_STUDIO_DEFAULT_PROVIDER_SETTING,
	AGENT_STUDIO_DEFAULT_MODEL_SETTING,
	AGENT_STUDIO_BOT_NAME_SETTING,
	AGENT_STUDIO_SHOW_TOKEN_USAGE_SETTING,
	AGENT_STUDIO_NOTIFICATION_SOUND_SETTING,
	AGENT_STUDIO_BROWSER_NOTIFICATIONS_SETTING,
	AGENT_STUDIO_CHECK_UPDATES_SETTING,
	AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY,
	AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
	AGENT_STUDIO_PROVIDER_NOUS_API_KEY,
	AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
	AGENT_STUDIO_PROVIDER_GEMINI_API_KEY,
	AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
	AGENT_STUDIO_PROVIDER_MAIN_API_KEY,
	AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
	AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
	AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
	AGENT_STUDIO_EMBEDDING_PROVIDER,
	AGENT_STUDIO_EMBEDDING_MODEL,
	AGENT_STUDIO_EMBEDDING_DIMENSIONS,
	AGENT_STUDIO_EMBEDDING_API_KEY,
	AGENT_STUDIO_EMBEDDING_BASE_URL,
	AGENT_STUDIO_EMBEDDING_LOCAL_ENABLED,
	AGENT_STUDIO_EMBEDDING_LOCAL_MODEL,
	AGENT_STUDIO_AUX_VISION_PROVIDER,
	AGENT_STUDIO_AUX_VISION_MODEL,
	AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER,
	AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL,
	AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER,
	AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL,
	AGENT_STUDIO_AUX_COMPRESSION_PROVIDER,
	AGENT_STUDIO_AUX_COMPRESSION_MODEL,
	AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER,
	AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL,
	AGENT_STUDIO_AUX_CURATOR_PROVIDER,
	AGENT_STUDIO_AUX_CURATOR_MODEL,
	AGENT_STUDIO_CLI_PATH_SETTING,
	AGENT_STUDIO_CLI_DEFAULT_WORKDIR_SETTING,
	AGENT_STUDIO_CLI_AUTO_CONNECT_SETTING,
	AGENT_STUDIO_CLI_SAVE_HISTORY_SETTING,
	AGENT_STUDIO_USE_NATIVE_CHAT_SETTING,
	TOF_PAASID_SETTING,
	TOF_SITE_BASE_URL_SETTING,
	TOF_GATEWAY_BASE_URL_SETTING,
	TOF_LOGIN_TIMEOUT_SETTING,
	TOF_DEFAULT_SITE_BASE_URL,
	AGENT_STUDIO_DRIVER_TURN_CONCURRENCY_LIMIT_SETTING,
	AGENT_STUDIO_SKILLS_INCLUDE_WORKFLOWS_SETTING,
	AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING,
	AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING,
	AGENT_STUDIO_TOOL_SEARCH_ENABLED_SETTING,
	AGENT_STUDIO_TOOL_SEARCH_THRESHOLD_PCT_SETTING,
	AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING,
	CHANNEL_DEFINITIONS,
} from '../common/constants.js';
import { AgentTaskBoardService } from './agentTaskBoardService.js';
import { AgentStudioProvider } from './agentStudioProvider.js';
import { BuiltInBYOKModelProvider, BUILTIN_BYOK_PROVIDERS, customProviderDataToDefinition } from './builtInBYOKModelProvider.js';
import type { CustomProviderData } from './views/providerView.js';
import { MainProcessModelProvider } from './mainProcessModelProvider.js';
import { IModelsAutoUpdateService, ModelsAutoUpdateService, type IProviderHint } from '../common/modelsAutoUpdate.js';
import { VSSAROS_LLM_CHANNEL } from '../common/llmBridge.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { AgentStudioActiveContext } from '../../../common/contextkeys.js';
import { AgentStudioEditorPane } from './agentStudioEditorPane.js';
import { AgentStudioEditorInput, setConfigService } from './agentStudioEditorInput.js';
import { SettingsEditorPane } from './settingsEditorPane.js';
import { SettingsEditorInput } from './settingsEditorInput.js';
import { PluginDetailEditorPane } from './pluginDetailEditorPane.js';
import { PluginDetailEditorInput } from './pluginDetailEditorInput.js';
import { AgentMarketEditorPane } from './agentMarketEditorPane.js';
import { AgentMarketEditorInput } from './agentMarketEditorInput.js';
import { AgentSettingsEditorPane } from './agentSettingsEditorPane.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';
import { AgentCreateEditorPane } from './agentCreateEditorPane.js';
import { AgentCreateEditorInput } from './agentCreateEditorInput.js';
import { McpServerEditorPane } from './mcpServerEditorPane.js';
import { McpServerEditorInput } from './mcpServerEditorInput.js';
import { McpDetailEditorPane } from './mcpDetailEditorPane.js';
import { McpDetailEditorInput } from './mcpDetailEditorInput.js';
import { SkillMarketEditorPane } from './skillMarketEditorPane.js';
import { SkillMarketEditorInput } from './skillMarketEditorInput.js';
import { WorkflowMarketEditorPane } from './workflowMarketEditorPane.js';
import { WorkflowMarketEditorInput } from './workflowMarketEditorInput.js';
import { MarketplaceEditorPane } from './marketplaceEditorPane.js';
import { MarketplaceEditorInput } from './marketplaceEditorInput.js';
import { NativeChatEditorPane } from './nativeChatEditorPane.js';
import { NativeChatEditorInput } from './nativeChatEditorInput.js';


import { ExplorerFolderContext } from '../../../../workbench/contrib/files/common/files.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ResourceContextKey } from '../../../../workbench/common/contextkeys.js';
import { Schemas } from '../../../../base/common/network.js';
import './views/media/toolbarViews.css';
import './views/media/toolsToggle.css';
import { SessionsExplorerView, SessionsExplorerEmptyView } from '../../files/browser/filesView.js';
import { WorkspaceFolderSyncContribution } from './workspaceFolderSync.js';
import { PresetAgentViewPane } from './views/presetAgentView.js';
import { TasksViewPane } from './views/tasksView.js';

import { IntegrationViewPane } from './views/integrationView.js';
import { AgentStudioSearchViewPane } from './views/searchView.js';
import { PluginsViewPane } from './views/pluginsView.js';
import { ISettingsTabRegistry, SettingsTabRegistry } from './views/settingsTabRegistry.js';


import { EvolutionDetailEditorPane } from './evolutionDetailEditorPane.js';
import { EvolutionDetailEditorInput } from './evolutionDetailEditorInput.js';
import { ChannelEditorPane } from './channelEditorPane.js';
import { ChannelEditorInput } from './channelEditorInput.js';

import { KnowledgeBaseViewPane } from './views/knowledgeBaseView.js';
// 资料库 activitybar 徽标聚合（知识库 / 代码库 / 记忆的构建与新增提示）。
// 该模块在文件末尾自行 registerWorkbenchContribution2，这里只需副作用引入。
import './libraryActivityBadge.js';
import { KbBlocksEditorPane } from './kbBlocksEditorPane.js';
import { KbNoteEditorInput } from './kbNoteEditorInput.js';
import { KnowledgeBaseGraphEditorPane } from './kbGraphEditorPane.js';
import { KbGraphEditorInput } from './kbGraphEditorInput.js';
import { CanvasEditorPane, getActiveCanvasPane } from './canvasEditor/canvasEditorPane.js';
import { CanvasEditorInput } from './canvasEditor/canvasEditorInput.js';
import { IMindmapData, type MindmapDirection } from '../common/mindmap/mindmapTypes.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import { WorkflowViewPane } from './views/workflowView.js';
import { IWikiTagService } from './services/wikiTagService.js';
import { WikiTagServiceImpl } from './services/wikiTagServiceImpl.js';
import { ITofAuthService } from '../common/tofAuth.js';
import { TofAuthService } from './tofAuthService.js';
import { URI } from '../../../../base/common/uri.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { WorkspaceFolderCountContext } from '../../../../workbench/common/contextkeys.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { TaskOverviewEditorPane } from './taskOverviewEditorPane.js';
import { TaskOverviewEditorInput } from './taskOverviewEditorInput.js';
import { TaskDetailEditorPane } from './taskDetailEditorPane.js';
import { TaskDetailEditorInput } from './taskDetailEditorInput.js';
import { AgentMediaEditorPane } from './agentMedia/agentMediaEditorPane.js';
import { AgentMediaEditorInput } from './agentMedia/agentMediaEditorInput.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { HtmlFileEditorPane } from './htmlFileEditorPane.js';
import { MdFileEditorPane } from './mdFileEditorPane.js';
import { FileEditorInput } from '../../../../workbench/contrib/files/browser/editors/fileEditorInput.js';
import { UrlPreviewEditorPane } from './urlPreviewEditorPane.js';
import { UrlPreviewEditorInput } from './urlPreviewEditorInput.js';
import { CompressionDetailEditorPane } from './compressionDetailEditorPane.js';
import { CompressionDetailEditorInput } from './compressionDetailEditorInput.js';
import { MemoryDetailEditorPane } from './memoryDetailEditorPane.js';
import { MemoryDetailEditorInput } from './memoryDetailEditorInput.js';
import { CodebaseMemoryDetailEditorPane } from './codebaseMemoryDetailEditorPane.js';
import { CodebaseMemoryDetailEditorInput } from './codebaseMemoryDetailEditorInput.js';
import { MediaGalleryEditorPane } from './mediaGalleryEditorPane.js';
import { MediaGalleryEditorInput } from './mediaGalleryEditorInput.js';
import { CodebaseGraphViewerEditorPane } from './codebaseGraphViewerEditorPane.js';
import { CodebaseGraphViewerEditorInput } from './codebaseGraphViewerEditorInput.js';
import { CodebaseIndexEditorPane } from './codebaseIndexEditorPane.js';
import { CodebaseIndexEditorInput } from './codebaseIndexEditorInput.js';
import { ICodebaseMemoryMcpService, CodebaseMemoryMcpService } from './codebaseMemoryMcpService.js';
import { ICodebaseGraphService, CodebaseGraphService } from './codebaseGraphService.js';
import { ICodebaseGraphWatcher, CodebaseGraphWatcher } from './codebaseGraphWatcher.js';
import './codebaseGraphBootstrap.js';
// ★ 2026-09-16：切换工作区「卡住」诊断（主线程心跳看门狗 + 阶段标记）。自注册贡献，见 wsSwitchDiag.ts。
import './wsSwitchDiag.contribution.js';
// C++ DefinitionProvider（基于图谱，无 LSP 依赖）→ 解锁 Ctrl+点击 / F12 / Peek 跳转。Self-registers.
import './codebaseGraphLanguageFeatures.contribution.js';
// Find Symbol（Shift+Alt+S，VAX 风格符号搜索 QuickPick）。Self-registers.
import './codebaseGraphFindSymbol.contribution.js';
// Class Hierarchy（Alt+Shift+G，类继承关系模态，单击节点跳转定义）。Self-registers.
import './codebaseGraphClassHierarchy.contribution.js';
// VAX 检索命令集（Open File/Find References/Goto Implementation/List Methods）。Self-registers.
import './codebaseGraphVaxSearch.contribution.js';
// Integrated browser "创建看板任务" right-click → kanban scrape. Self-registers.
import './browserKanbanContextMenu.contribution.js';
import { IAgentStudioDashboardService, AgentStudioDashboardService } from './agentStudioDashboardService.js';
import { AgentStudioDashboardEditorPane } from './agentStudioDashboardEditorPane.js';
import { AgentStudioDashboardEditorInput } from './agentStudioDashboardEditorInput.js';
import { AgentStudioDashboardViewPane } from './views/agentStudioDashboardView.js';
import { WorkflowEditorPane } from './workflowEditorPane.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
// P2（2026-09-13）：单节点编辑器开在独立 tab。
import { WorkflowNodeEditorPane } from './workflowNodeEditorPane.js';
import { WorkflowNodeEditorInput } from './workflowNodeEditorInput.js';
import { ResourceManagerEditorPane } from './resourceManagerEditorPane.js';
import { ResourceManagerEditorInput } from './resourceManagerEditorInput.js';
import { ISelfEvolutionService } from '../common/selfEvolution.js';
import { SelfEvolutionService } from './selfEvolutionService.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { IEditorService, SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, IEditorPart, IAuxiliaryEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IAuxiliaryWindowService } from '../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
// 2026-09-05：图表预览改走 HtmlPreviewEditorInput（内存 HTML 通道），
// UntitledTextEditorService / UntitledTextEditorInput 不再被使用，import 已移除。

/**
 * Type-safe accessor for the agent editor part (AGENT_EDITOR_PART).
 *
 * This replaces the `(editorGroupsService as any).agentPart` pattern with
 * a single centralized cast, reducing `as any` usage from 3 call sites to 1.
 */
function getAgentPart(editorGroupsService: IEditorGroupsService): IEditorGroupsService | undefined {
	return (editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
}

/**
 * 中间栏（mainPart）—— 与上面 `getAgentPart` 同风格的结构化取用。
 *
 * ★ 2026-09-16：工具卡片里的「查看文件」类跳转**必须**显式落到这里（详见
 * `openDiagramPreview` 的注释）。sessions 布局：mainPart = 中间栏主编辑器，
 * agentPart = 右侧聊天区；独立窗口（aux part）下没有 mainPart ⇒ 返回 undefined，
 * 调用方退回「活动组」（与 `chatEditorIntegration._openInMainColumn` 同口径）。
 */
function getMainPart(editorGroupsService: IEditorGroupsService): IEditorGroupsService | undefined {
	return (editorGroupsService as unknown as { mainPart?: IEditorGroupsService }).mainPart;
}

// --- Icons -----------------------------------------------------------------------

// Toolbar icons
const workspaceIcon = registerIcon('agent-studio-workspace', Codicon.folder, localize('workspaceIcon', "Workspace"));
const presetAgentIcon = registerIcon('agent-studio-preset-agent', Codicon.robot, localize('presetAgentIcon', "Preset Agent"));
const tasksIcon = registerIcon('agent-studio-tasks', Codicon.tasklist, localize('tasksIcon', "Tasks"));
const integrationIcon = registerIcon('agent-studio-integration', Codicon.extensions, localize('integrationIcon', "Integration"));
const searchIcon = registerIcon('agent-studio-search', Codicon.search, localize('searchIcon', "Search"));
const pluginsIcon = registerIcon('agent-studio-plugins', Codicon.package, localize('pluginsIcon', "Plugins"));
const kbIcon = registerIcon('agent-studio-knowledge-base', Codicon.book, localize('kbIcon', "Knowledge Base"));
const workflowIcon = registerIcon('agent-studio-workflow', Codicon.listTree, localize('workflowIcon', "Workflow"));

// --- Configuration ---------------------------------------------------------------
//qiuzijian debug
/** 由 CHANNEL_DEFINITIONS 动态生成配置注册表（避免手写约 200 项）。 */
function channelConfigProperties(): Record<string, any> {
	const props: Record<string, any> = {};
	for (const def of CHANNEL_DEFINITIONS) {
		for (const f of def.configFields) {
			// JSON Schema 仅接受基础类型：password/textarea/agent 归为 string
			const schemaType =
				f.type === 'password' || f.type === 'textarea' || f.type === 'agent' ? 'string' : f.type;
			const prop: any = { type: schemaType, default: f.default };
			if (f.description) {
				prop.description = localize('agentStudio.channel.' + f.key, f.description);
			}
			if (f.type === 'select' && f.options) {
				prop.enum = f.options.map(o => o.value);
			}
			if (f.placeholder) {
				prop.placeholder = f.placeholder;
			}
			props[f.key] = prop;
		}
	}
	return props;
}

// ★★ Agent Studio 的配置**一律不受工作区设置影响**（`ConfigurationScope.MACHINE`）。
//
// 语义：`MACHINE` = 「只能在本地/远端**用户设置**里配置」⇒ 工作区 `.vscode/settings.json`
// 与 folder 级的值**天然被忽略**。这是「本项目不读工作区 `.vscode/`」这条安全规则在
// **标准 IDE 底座**下的等价实现 —— 标准窗口的 `IConfigurationService` 必读工作区设置，
// 无法像 sessions 窗口那样靠"不加载 folder 配置"来隔离，只能靠 scope。
//
// 为什么不用 `APPLICATION`：它的语义是「只能在**默认 profile** 的用户设置里配置」，
// 而 agents 窗口跑在**独立的 agents profile** 下（`isAgentsWindowProfile`），
// 用 APPLICATION 会让用户在 agents 窗口里设的值读不到 —— 是个静默失效的坑。
//
// 代价：这些设置在 Settings UI 里不再按 folder 分组显示（本来也不该），且不参与 Settings Sync。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	scope: ConfigurationScope.MACHINE,
	properties: {
		...channelConfigProperties(),
		// ★★★ 2026-09-15：任务栏 jump list 的「New Window」默认回到**原生模型 A（同进程内开新窗口）**。
		// 依据：`doc/multi-instance-analysis.md` §3.2「共享面 ≫ 拆分面」+ §6.2 P3-2；
		// 实现见 `platform/workspaces/electron-main/workspacesHistoryMainService.ts` 的 `getNewWindowMode()`。
		// 'instance' 是**逃生门**（回到从前的独立进程/多开），改完即时重建跳转列表，无需重新编译。
		'saros.window.newWindowMode': {
			type: 'string',
			enum: ['window', 'instance'],
			enumDescriptions: [
				localize('saros.window.newWindowMode.window', "原生行为（默认）：在**同一个进程**内开新窗口。所有窗口共享 state.vscdb / 日志 / 备份，跨窗口写入由进程内保护负责（写队列、pane 引用计数、会话锁）。代价：一个窗口崩溃/OOM 会影响全部窗口。"),
				localize('saros.window.newWindowMode.instance', "独立进程（旧行为）：每次开新窗口都启动一个独立实例（多开）——IPC 单实例锁 / 日志 / 备份 / globalStorage 按实例拆分，但 Agent Studio 数据（agents/skills/会话/检查点/媒体/图谱）仍在共享侧且**无跨进程并发保护**。仅在需要崩溃隔离或并行跑重任务时使用。"),
			],
			default: 'window',
			description: localize('saros.window.newWindowMode', "任务栏跳转列表「New Window」的启动方式：同进程新窗口（VS Code 原生）或独立进程（多开）。"),
		},
		// ★ 2026-09-16：agents 窗口的「原生扩展（VS Code 插件）」执行策略 —— 兼容原生插件功能的**总开关**。
		// 上游默认只放行**声明式**扩展（themes/grammars/languages…），任何带 `main`/`browser` 的第三方扩展
		// 在 agents 窗口都是 `DisabledByEnvironment`（用户无法自行启用）。这里提供显式放开的口子，
		// **默认值保持上游行为**（零行为变化）。
		// 判据（纯函数 + 单测）：`platform/extensionManagement/common/agentsWindowExtensionPolicy.ts`
		// 生效点：`workbench/services/extensionManagement/browser/extensionEnablementService.ts`
		// 设计文档：`doc/native-extensions-in-agents-window-plan.md`（L0=本设置，L2=策略，L3=扩展视图可见性）
		[AGENTS_WINDOW_EXTENSION_MODE_SETTING]: {
			type: 'string',
			enum: ['declarative', 'allowlist', 'all'],
			enumDescriptions: [
				localize('saros.extensions.agentsWindow.mode.declarative', "声明式（默认）：只放行**无代码**扩展（主题/图标主题/颜色/键位/语法/语言/本地化）——与上游 agents 窗口行为一致。带代码的扩展在 agents 窗口显示为「由环境禁用」，需切到 IDE 窗口使用。"),
				localize('saros.extensions.agentsWindow.mode.allowlist', "白名单：在声明式基础上，额外放行下述白名单里的扩展（可带代码）。适合只放开少数内网/自研扩展。"),
				localize('saros.extensions.agentsWindow.mode.all', "全部放行（逃生门）：除产品级黑名单（GitHub Copilot 系列，见 agentsWindowExtensionPolicy.ts 的 BLOCKLIST）外全部启用。代价：agents 窗口启动变慢、内存上升、第三方代码进入窗口（安全面/崩溃面扩大）。"),
			],
			default: 'declarative',
			markdownDescription: localize('saros.extensions.agentsWindow.mode', "agents 窗口允许运行的 VS Code 扩展范围。`declarative`（默认）= 上游行为；`allowlist` = 额外放行白名单；`all` = 除黑名单外全部。\n\n⚠ 改这个设置后已启动的扩展宿主不会热加载/卸载扩展，**需要 Reload Window** 才真正生效（设置本身即时影响扩展的启用状态显示）。"),
		},
		[AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			default: [],
			markdownDescription: localize('saros.extensions.agentsWindow.allowlist', "仅在 `saros.extensions.agentsWindow.mode` = `allowlist` 时生效的扩展白名单。支持 `publisher.name`（精确）、`publisher.*`（出版商前缀）、`*`（全部），大小写不敏感。"),
		},
		// ★ 2026-09-16：Agent 贡献型扩展 —— 本产品「用 VS Code 扩展给 Agent 提供能力/插件」的正式通道。
		// 这类扩展**有代码**（main/browser），但只贡献 `agentCapabilities` / `chatPlugins`（+ 声明式点）：
		//   · agentCapabilities → AgentCapabilitiesExtensionPointRegistry（sessions/contrib/agentStudio）
		//   · chatPlugins       → ExtensionAgentPluginDiscovery（workbench/contrib/chat）
		// 默认放行（否则上面的 agents 窗口规则"有代码一律禁用"会让这两条桥永远收不到贡献）；
		// 设为 false 可严格维持上游行为（连这类扩展也不放行）。
		[AGENTS_WINDOW_EXTENSION_AGENT_CONTRIBUTIONS_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('saros.extensions.agentsWindow.allowAgentContributions', "是否放行「Agent 贡献型扩展」：有代码、但只贡献 `agentCapabilities` / `chatPlugins` 的扩展（它们只用于给 Agent 提供模型/记忆/工具等能力或 Agent 插件）。默认开启 —— 这是扩展与 Agent 生态打通的正式通道。关闭后此类扩展在 agents 窗口也会被禁用（严格维持上游「只看声明式扩展」的行为）。"),
		},
		'saros.codebaseGraph.sqliteBackend': {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.codebaseGraph.sqliteBackend', "Codebase 图谱查询/搜索默认走主进程 SQLite（FTS5）后端，避免内存全量扫描。默认开启；设为 false 关闭后回退内存 store。"),
		},
		// ⚠⚠ 2026-09-19 恢复（并发改动把这两条注册覆盖掉了 ⇒ 代码里 `getValue('saros.codebaseGraph.artifactFormat')`
		// / `getValue('saros.codebaseGraph.memoryBudgetMb')` 仍在读，但**设置项不存在** ⇒ 用户无法发现/修改、
		// 且永远拿到默认值（SQLite 快照档变成不可用）✗。契约测试要钉住「读了的配置必须注册」。
		'saros.codebaseGraph.artifactFormat': {
			type: 'string',
			enum: ['json', 'sqlite', 'both'],
			enumDescriptions: [
				localize('agentStudio.codebaseGraph.artifactFormat.json', "JSON（默认，与既有行为完全一致）：`.codebase-memory/graph.db.zst` 是 gzip 压缩的 JSON。载入时必须解析 JSON（大图单 folder 数秒），但格式自解释、便于人工排查。"),
				localize('agentStudio.codebaseGraph.artifactFormat.sqlite', "SQLite 快照（更快）：`.codebase-memory/graph.db.sqlite` 由主进程 `VACUUM INTO` 直接产出 ⇒ 保存时 renderer **不再序列化整张图**；载入时按页取数、**完全不解析 JSON**。适合本机使用；若要提交给队友共享，对方需使用支持该格式的版本。"),
				localize('agentStudio.codebaseGraph.artifactFormat.both', "两份都写：迁移/共享过渡期使用（读仍可走 JSON 路径，同时产出快照）。"),
			],
			default: 'json',
			description: localize('agentStudio.codebaseGraph.artifactFormat', "Codebase 图谱**制品**（`.codebase-memory/`）的写出格式。默认 `json` 保持既有行为；改为 `sqlite` 后保存由主进程 `VACUUM INTO` 直接产出快照（renderer 不再做全图 gzip+JSON 序列化），载入也改为分页读取（完全不解析 JSON）。**切换后下一次索引/保存生效**。"),
		},
		'saros.codebaseGraph.memoryBudgetMb': {
			type: 'number',
			default: 0,
			minimum: 0,
			markdownDescription: localize('agentStudio.codebaseGraph.memoryBudgetMb', "Codebase 图谱的**单轮内存增长预算**（MB）—— 判据是「**本轮索引期间堆的增长量**」而非绝对占用（renderer 静止堆本就包含编辑器/扩展/webview，用绝对值会每轮误报 ✗）。`0` = 自动按设备内存分档（≤4GB→256 / ≤8GB→512 / 更大→768）。超预算时：① 索引阶段对账行会带上「本轮+XMB / 上限YMB（堆…，基线…）」（便于定位是哪一段吃掉内存）；② 单条**响亮告警**（绝不静默）+ 提示如何放宽。对齐 C 版 `mem.c` 的内存预算思想 —— 本仓检索已由主进程 SQLite/FTS5 承担，内存里可重建的结构（BM25/layout）按需重建而不常驻。"),
		},
		'saros.codebaseGraph.excludeProfile': {
			type: 'string',
			enum: ['balanced', 'full'],
			enumDescriptions: [
				localize('agentStudio.codebaseGraph.excludeProfile.balanced', "平衡档（默认）：排除依赖/构建产物，以及 test、docs、scripts、resources 等源码目录——索引最快，但测试与脚本代码不可检索。"),
				localize('agentStudio.codebaseGraph.excludeProfile.full', "完整档：只排除依赖与构建产物，保留 test、docs、scripts 等源码目录——测试/脚本文档中的符号也能被检索，索引耗时更长。"),
			],
			default: 'balanced',
			description: localize('agentStudio.codebaseGraph.excludeProfile', "Codebase 图谱的目录排除档位。切换后需重新索引才会生效。"),
		},
		'saros.codebaseGraph.deferLargeNonPrimaryRootsMB': {
			type: 'number',
			default: 5,
			description: localize('agentStudio.codebaseGraph.deferLargeNonPrimaryRootsMB', "非主 root（工作区 folders[1..]，即 relatedFolders）的图谱超过此大小（MB）时，**不在打开工作区时加载**，改为首次真正用到 codebase 能力（codebase 工具 / 子代理预检）时再加载。设为 0 关闭延迟（保持旧行为：打开工作区即加载全部）。用途：避免「切到含超大图谱的多根工作区时整个窗口卡死」——实测 UE5EA 图谱 24.6MB（87.6 万节点）需数十秒同步解压；而默认检索作用域只到主 root，非主图在「打开工作区」这一刻并不必要。小图（~0MB）照常加载，检索完整性不受影响。"),
		},
		'sessions.agentStudio.tools.autoApproveReadOnlyCommands': {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.tools.autoApproveReadOnlyCommands', "终端命令中，已确认只读的命令（如 Get-ChildItem / git status / cat，含只读管道）与验证/构建命令（如 tsc / esbuild / vite / npm run build / npm test / npm run lint）免交互确认。命令一旦包含重定向、命令替换、`;`/`&&` 串联、变量展开、裸解释器（python3 -c / node -e）或任何未知命令，仍会弹出确认。默认开启；关闭后所有终端命令都需确认。"),
		},
		'sessions.agentStudio.tools.execAutoReview': {
			type: 'boolean',
			default: false,
			description: localize('agentStudio.tools.execAutoReview', "exec 自动审阅（P2-1，默认关闭 → fail-closed）：开启后，只读/验证构建命令交由执行策略免确认，进一步降低审批卡片疲劳。当前为配置驱动的启发式审阅；请确保你信任运行环境后再开启。"),
		},
		[AGENT_STUDIO_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.enabled', "Enable Agent Studio multi-agent workspace in the Sessions window."),
		},
		[AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('agentStudio.chatStreamLog.enabled', "Enable chat stream logging for debugging. Logs are saved to the workspace logs/chat-streams directory."),
		},
		[AGENT_STUDIO_CHAT_STREAM_LOG_DUMP_TOOLS_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('agentStudio.chatStreamLog.dumpTools', "Dump full tools schema in chat stream logs. When false (default), tools are summarized as '(N tools)' to keep log size small. Enable to inspect provider-side tool registration."),
		},
		[AGENT_STUDIO_USE_NATIVE_CHAT_SETTING]: {
			type: 'boolean',
			default: true,
			deprecationMessage: localize('agentStudio.chat.useNativeChat.deprecated', "已废弃 — NativeChatEditorPane 现在是唯一的聊天渲染器，此设置不再生效。"),
			description: localize('agentStudio.chat.useNativeChat', "[已废弃] Use Native Chat UI (DOM-based) instead of React WebView."),
		},
		// --- Preferences ---
		[AGENT_STUDIO_LANGUAGE_SETTING]: {
			type: 'string',
			default: 'zh-CN',
			enum: ['en', 'zh-CN', 'ja'],
			description: localize('agentStudio.preferences.language', "Display language."),
		},
		[AGENT_STUDIO_RESPONSE_LANGUAGE_SETTING]: {
			type: 'string',
			default: 'auto',
			enum: ['auto', 'match-user', 'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'it'],
			description: localize('agentStudio.preferences.responseLanguage', "Language the LLM should respond in. 'auto' uses the Agent Studio display language (sessions.agentStudio.preferences.language); 'match-user' follows the user's input language."),
		},
		[AGENT_STUDIO_SEND_KEY_SETTING]: {
			type: 'string',
			default: 'enter',
			enum: ['enter', 'ctrl+enter'],
			description: localize('agentStudio.preferences.sendKey', "Key combination to send messages."),
		},
		[AGENT_STUDIO_DEFAULT_PROVIDER_SETTING]: {
			type: 'string',
			default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'custom'],
			description: localize('agentStudio.preferences.defaultProvider', "Default AI Provider for new conversations. 'auto' selects the first available authenticated provider."),
		},
		[AGENT_STUDIO_DEFAULT_MODEL_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.preferences.defaultModel', "Default AI model for new conversations. Leave empty to use system default."),
		},
		[AGENT_STUDIO_BOT_NAME_SETTING]: {
			type: 'string',
			default: 'Saros',
			description: localize('agentStudio.preferences.botName', "Display name for the AI assistant."),
		},
		[AGENT_STUDIO_SHOW_TOKEN_USAGE_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('agentStudio.preferences.showTokenUsage', "Show token usage after each assistant reply."),
		},
		[AGENT_STUDIO_NOTIFICATION_SOUND_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('agentStudio.preferences.notificationSound', "Play a sound when the assistant finishes replying."),
		},
		[AGENT_STUDIO_BROWSER_NOTIFICATIONS_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('agentStudio.preferences.browserNotifications', "Show browser notifications when replies complete in the background."),
		},
		[AGENT_STUDIO_CHECK_UPDATES_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.preferences.checkUpdates', "Show update notification when a new version is available."),
		},
		// --- Marketplace ---
		[MARKETPLACE_URL_SETTING]: {
			type: 'string',
			default: 'http://21.6.92.5:3040',
			description: localize('agentStudio.marketplace.url', "Saros 商城服务端地址，用于浏览、上传下载 agent/skill/mcp/知识库。"),
		},
		[MARKETPLACE_AUTO_CHECK_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.marketplace.autoCheck', "启动时自动检查已安装资源的更新。"),
		},
		[MARKETPLACE_UPDATE_INTERVAL_SETTING]: {
			type: 'number',
			default: 3600,
			description: localize('agentStudio.marketplace.updateInterval', "资源更新检查间隔（秒）。"),
		},
		// --- Knot AG-UI ---
		// Knot configuration is registered by the demo-agui extension via its package.json
		// contributes.configuration. The settings tab is discovered at runtime via
		// ISettingsTabRegistry (contributes.agentStudioSettingsTab with when condition).
		// --- Provider Connections ---
		[AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY]: {
			type: 'string', default: '',
			description: localize('agentStudio.provider.openrouter.apiKey', "OpenRouter API Key."),
		},
		[AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL]: {
			type: 'string', default: 'https://openrouter.ai/api/v1',
			description: localize('agentStudio.provider.openrouter.baseUrl', "OpenRouter API base URL."),
		},
		[AGENT_STUDIO_PROVIDER_NOUS_API_KEY]: {
			type: 'string', default: '',
			description: localize('agentStudio.provider.nous.apiKey', "Nous API Key."),
		},
		[AGENT_STUDIO_PROVIDER_NOUS_BASE_URL]: {
			type: 'string', default: 'https://api.nous.com/v1',
			description: localize('agentStudio.provider.nous.baseUrl', "Nous API base URL."),
		},
		[AGENT_STUDIO_PROVIDER_GEMINI_API_KEY]: {
			type: 'string', default: '',
			description: localize('agentStudio.provider.gemini.apiKey', "Gemini API Key."),
		},
		[AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL]: {
			type: 'string', default: 'https://generativelanguage.googleapis.com',
			description: localize('agentStudio.provider.gemini.baseUrl', "Gemini API base URL."),
		},
		[AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY]: {
			type: 'string', default: '',
			description: localize('agentStudio.provider.anthropic.apiKey', "Anthropic API Key."),
		},
		[AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL]: {
			type: 'string', default: 'https://api.anthropic.com',
			description: localize('agentStudio.provider.anthropic.baseUrl', "Anthropic API base URL."),
		},
		[AGENT_STUDIO_PROVIDER_MAIN_API_KEY]: {
			type: 'string', default: '',
			description: localize('agentStudio.provider.main.apiKey', "Main Provider API Key."),
		},
		[AGENT_STUDIO_PROVIDER_MAIN_BASE_URL]: {
			type: 'string', default: '',
			description: localize('agentStudio.provider.main.baseUrl', "Main Provider API base URL."),
		},
		[AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY]: {
			type: 'string', default: '',
			description: localize('agentStudio.provider.custom.apiKey', "Custom Provider API Key."),
		},
		[AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL]: {
			type: 'string', default: '',
			description: localize('agentStudio.provider.custom.baseUrl', "Custom Provider API base URL."),
		},
		// --- Embedding (RAG vectorization) ---
		[AGENT_STUDIO_EMBEDDING_PROVIDER]: {
			type: 'string', default: 'openai',
			enum: ['openai', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'custom', 'local'],
			description: localize('agentStudio.embedding.provider', "Embedding provider for RAG vectorization. Reuses the selected provider's API key when an OpenAI-compatible provider is chosen; 'local' uses an offline transformers.js model (enable embedding.local.enabled)."),
		},
		[AGENT_STUDIO_EMBEDDING_MODEL]: {
			type: 'string', default: 'text-embedding-3-small',
			description: localize('agentStudio.embedding.model', "Embedding model name (e.g. text-embedding-3-small). Provider-specific."),
		},
		[AGENT_STUDIO_EMBEDDING_DIMENSIONS]: {
			type: 'number', default: 512,
			description: localize('agentStudio.embedding.dimensions', "Vector dimension. OpenAI text-embedding-3-* supports reducing to 512; local models are fixed (e.g. 384)."),
		},
		[AGENT_STUDIO_EMBEDDING_API_KEY]: {
			type: 'string', default: '',
			description: localize('agentStudio.embedding.apiKey', "Optional dedicated OpenAI embedding API key (overrides the selected provider's key)."),
		},
		[AGENT_STUDIO_EMBEDDING_BASE_URL]: {
			type: 'string', default: '',
			description: localize('agentStudio.embedding.baseUrl', "Optional dedicated embedding API base URL (overrides the selected provider's base URL)."),
		},
		[AGENT_STUDIO_EMBEDDING_LOCAL_ENABLED]: {
			type: 'boolean', default: false,
			description: localize('agentStudio.embedding.local.enabled', "Enable offline local embedding (transformers.js) as a fallback when the API provider fails or for fully offline RAG."),
		},
		[AGENT_STUDIO_EMBEDDING_LOCAL_MODEL]: {
			type: 'string', default: 'Xenova/all-MiniLM-L6-v2',
			description: localize('agentStudio.embedding.local.model', "Local embedding model id for transformers.js (e.g. Xenova/all-MiniLM-L6-v2 or a multilingual variant)."),
		},
		// --- Auxiliary Models ---
		[AGENT_STUDIO_AUX_VISION_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'custom'],
			description: localize('agentStudio.aux.vision.provider', "Provider for Vision (image analysis)."),
		},
		[AGENT_STUDIO_AUX_VISION_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.vision.model', "Model for Vision. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'custom'],
			description: localize('agentStudio.aux.webExtract.provider', "Provider for Web Extract (page summarization)."),
		},
		[AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.webExtract.model', "Model for Web Extract. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'custom'],
			description: localize('agentStudio.aux.sessionSearch.provider', "Provider for Session Search (history summarizing)."),
		},
		[AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.sessionSearch.model', "Model for Session Search. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_COMPRESSION_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'custom'],
			description: localize('agentStudio.aux.compression.provider', "Provider for Compression (context compression)."),
		},
		[AGENT_STUDIO_AUX_COMPRESSION_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.compression.model', "Model for Compression. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'custom'],
			description: localize('agentStudio.aux.goalJudge.provider', "Provider for Goal Judge (goals feature)."),
		},
		[AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.goalJudge.model', "Model for Goal Judge. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_CURATOR_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'custom'],
			description: localize('agentStudio.aux.curator.provider', "Provider for Curator (code review)."),
		},
		[AGENT_STUDIO_AUX_CURATOR_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.curator.model', "Model for Curator. Leave empty for default."),
		},
		// --- Data Path ---
		[AGENT_STUDIO_DATA_PATH_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.dataPath', "Custom data directory path for Agent Studio. Defaults to workspace .agent-studio/data/."),
		},
		// --- CLI ---
		[AGENT_STUDIO_CLI_PATH_SETTING]: {
			type: 'string', default: '',
			description: localize('agentStudio.cli.cliPath', "Path to the CLI executable (e.g. /usr/local/bin/hermes)."),
		},
		[AGENT_STUDIO_CLI_DEFAULT_WORKDIR_SETTING]: {
			type: 'string', default: '',
			description: localize('agentStudio.cli.defaultWorkdir', "Default working directory for CLI sessions (e.g. ~/.hermes/workspace)."),
		},
		[AGENT_STUDIO_CLI_AUTO_CONNECT_SETTING]: {
			type: 'boolean', default: true,
			description: localize('agentStudio.cli.autoConnect', "Auto-connect to local CLI backend on startup."),
		},
		[AGENT_STUDIO_CLI_SAVE_HISTORY_SETTING]: {
			type: 'boolean', default: true,
			description: localize('agentStudio.cli.saveHistory', "Save CLI interaction history for recall and reuse."),
		},
		// --- TOF (Taihu OA Framework) 登录 ---
		[TOF_PAASID_SETTING]: {
			type: 'string', default: 'sls_mcp_app',
			description: localize('agentStudio.tof.paasid', "TOF 应用 appkey (paasid)，用于构造 passport.woa.com 登录 URL。"),
		},
		[TOF_SITE_BASE_URL_SETTING]: {
			// 必须与以下三处保持一致（本处注册的 default 会**优先生效**，其余两处永远走不到）：
			//   · extensions/tof-authentication/package.json 的 configuration.properties
			//   · extensions/tof-authentication/src/tofAuthProvider.ts 的 fallback
			//   · TOF_DEFAULT_SITE_BASE_URL（common/constants.ts，由单测锁定）
			// ⚠ 该域名必须能在 DNS 中解析，否则登录后回调地址不可达（This site can't be reached）。
			// 2026-09-10 事故：此处曾写 `http://vssaros.woa.com`（扩展侧已是 saroasis-mcp.woa.com），
			// 两处漂移 + 本处优先生效 → 未显式配置的环境登录必失败：passport 登录成功后跳
			// `http://vssaros.woa.com/api/v1/auth/tof/callback?cb_port=<port>&state=…` → NXDOMAIN。
			// 实测 vssaros.woa.com 已无 DNS 记录；saroasis-mcp.woa.com 解析到 21.169.46.116（网关同 IP）。
			type: 'string', default: TOF_DEFAULT_SITE_BASE_URL,
			description: localize('agentStudio.tof.siteBaseUrl', "网关站点基础 URL，TOF 回调地址前缀（须为 .woa.com 白名单域名）。"),
		},
		[TOF_GATEWAY_BASE_URL_SETTING]: {
			type: 'string', default: 'http://21.169.46.116:8080',
			description: localize('agentStudio.tof.gatewayBaseUrl', "鉴权网关基础 URL，用于调用 /api/v1/whoami 校验身份。"),
		},
		[TOF_LOGIN_TIMEOUT_SETTING]: {
			type: 'number', default: 180,
			description: localize('agentStudio.tof.loginTimeout', "TOF 浏览器登录超时时间（秒）。"),
		},
		// --- Driver concurrency ---
		[AGENT_STUDIO_DRIVER_TURN_CONCURRENCY_LIMIT_SETTING]: {
			type: 'number',
			default: 4,
			minimum: 1,
			maximum: 32,
			description: localize('agentStudio.driver.turnConcurrencyLimit', "顶层可同时运行的 agent turn 并发上限。调高 = 更多并行 session/agent，但 API 配额与内存(V8 4GB 堆)压力更大；免费 API 档位在更低并发即被限流，可调低。默认 4。"),
		},
		// --- Skills: workflow bridge ---
		[AGENT_STUDIO_SKILLS_INCLUDE_WORKFLOWS_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.skills.includeWorkflows', "将已存储的工作流作为「可执行型 skill」暴露给 agent（双向打通 A 向）。开启后可用 /skill <workflowId> 触发执行工作流；关闭则不再暴露。默认开启。"),
		},
		// --- Skills: 注入预算（2026-09-11 接线；此前两个常量存在但从未注册/消费）---
		[AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING]: {
			type: 'number',
			default: 10,
			minimum: 1,
			maximum: 100,
			description: localize('agentStudio.skills.maxSkillsInPrompt', "单个 turn 最多注入**完整正文**的技能数量。超出者降级为摘要（保留名称 / 描述 / 目录路径，模型可按需 read_skill 读全文）——**不会丢弃**，故 always 技能的语义不受影响。默认 10。"),
		},
		[AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING]: {
			type: 'number',
			default: 48000,
			minimum: 1000,
			maximum: 1000000,
			description: localize('agentStudio.skills.maxSkillsPromptChars', "单个 turn 注入的 skill **完整正文**字符总预算（约 4 字符 = 1 token）。超出者降级为摘要。默认 48000（约 12k tokens，占 200k 上下文的 ~6%）。"),
		},
		'sessions.agentStudio.workspace.folderSync': {
			type: 'string',
			enum: ['window-drives-registry', 'registry-drives-window', 'off'],
			default: 'window-drives-registry',
			enumDescriptions: [
				'窗口是真源：`.code-workspace` / 打开的文件夹决定文件夹列表，变化后写回 Agent Studio 工作区记录（默认，与原生 VS Code 一致）。',
				'旧行为（仅回滚用）：Agent Studio 工作区记录是真源，投影成窗口文件夹列表 —— 会让用户手写的多根 `.code-workspace` 被裁成单根。',
				'关闭同步（排障用）：两侧互不影响。',
			],
			description: localize('agentStudio.workspace.folderSync', "工作区文件夹列表的同步方向。默认 window-drives-registry（窗口为真源）；仅在排查问题时才切回 registry-drives-window。"),
		},
	},
});

// --- Tool Search 折叠配置（2026-09-11 接线：键一直存在但从未注册 schema）-------------
// 读取方：`agentOSService._getToolSearchConfig`（缺失时回退 DEFAULT_TOOL_SEARCH_CONFIG）。
// 此前键未注册 → 设置 UI 看不到、无补全，用户只能手写 settings.json。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentStudio',
	title: localize('agentStudio', "Agent Studio"),
	// 见文件上方 `id: 'sessions'` 处对 `MACHINE` scope 的说明（不受工作区设置影响）。
	scope: ConfigurationScope.MACHINE,
	properties: {
		[AGENT_STUDIO_TOOL_SEARCH_ENABLED_SETTING]: {
			type: 'string',
			enum: ['off', 'on', 'auto'],
			default: 'auto',
			enumDescriptions: [
				'从不折叠：全部工具 schema 直发（工具多时显著增大请求体积）。',
				'总是折叠：可折叠工具一律走 tool_search 按需发现。',
				'按阈值自动折叠：可折叠工具 token 超过上下文窗口的 thresholdPct% 时折叠（推荐）。',
			],
			description: localize('agentStudio.toolSearch.enabled', "工具检索（tool_search）的折叠策略。默认 auto。"),
		},
		[AGENT_STUDIO_TOOL_SEARCH_THRESHOLD_PCT_SETTING]: {
			type: 'number',
			default: 10,
			minimum: 0,
			maximum: 100,
			description: localize('agentStudio.toolSearch.thresholdPct', "auto 模式下触发折叠的阈值：可折叠工具 token 占模型上下文窗口的百分比（0–100）。调小 = 更早折叠（省体积，但模型多一次 tool_search）。默认 10。"),
		},
	},
});

// --- Canvas Editor Settings -------------------------------------------------------
// ComfyUI 一键启动可配置覆盖（覆盖 comfyLauncher 自动解析的结果；留空则回退自动探测）。
// 排查/特殊安装用：环境变量 SAROS_COMFYUI_PYTHON / SAROS_COMFYUI_MAIN 优先级高于设置。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sarosis.comfyui',
	title: localize('sarosis.comfyui', "ComfyUI 启动"),
	// 见文件上方 `id: 'sessions'` 处对 `MACHINE` scope 的说明（不受工作区设置影响）。
	scope: ConfigurationScope.MACHINE,
	properties: {
		'sarosis.comfyui.pythonPath': {
			type: 'string', default: '',
			description: localize('sarosis.comfyui.pythonPath', "ComfyUI 启动用的 python.exe 绝对路径（留空则按 Comfy Desktop 配置自动解析：<basePath>\\.venv\\Scripts\\python.exe）。"),
		},
		'sarosis.comfyui.mainPath': {
			type: 'string', default: '',
			description: localize('sarosis.comfyui.mainPath', "ComfyUI 的 main.py 绝对路径（留空则自动解析：<desktopRoot>\\resources\\ComfyUI\\main.py）。"),
		},
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sarosis.canvas',
	title: localize('sarosis.canvas', "思维导图编辑器"),
	// 见文件上方 `id: 'sessions'` 处对 `MACHINE` scope 的说明（不受工作区设置影响）。
	scope: ConfigurationScope.MACHINE,
	properties: {
		'sarosis.canvas.autoLayout': {
			type: 'boolean', default: false,
			description: localize('sarosis.canvas.autoLayout', "修改节点后自动触发布局重排。"),
		},
		'sarosis.canvas.autoColor': {
			type: 'boolean', default: true,
			description: localize('sarosis.canvas.autoColor', "新增节点时自动继承父分支颜色。"),
		},
		'sarosis.canvas.horizontalGap': {
			type: 'number', default: 80, minimum: 20, maximum: 300,
			description: localize('sarosis.canvas.horizontalGap', "父子节点间的水平间距 (px)。"),
		},
		'sarosis.canvas.verticalGap': {
			type: 'number', default: 20, minimum: 5, maximum: 100,
			description: localize('sarosis.canvas.verticalGap', "兄弟节点间的垂直间距 (px)。"),
		},
		'sarosis.canvas.defaultNodeWidth': {
			type: 'number', default: 300, minimum: 100, maximum: 800,
			description: localize('sarosis.canvas.defaultNodeWidth', "新创建节点的默认宽度 (px)。"),
		},
		'sarosis.canvas.defaultNodeHeight': {
			type: 'number', default: 60, minimum: 40, maximum: 600,
			description: localize('sarosis.canvas.defaultNodeHeight', "新创建节点的默认高度 (px)。"),
		},
		'sarosis.canvas.maxNodeHeight': {
			type: 'number', default: 300, minimum: 60, maximum: 1200,
			description: localize('sarosis.canvas.maxNodeHeight', "编辑中节点自动扩展的最大高度 (px)。"),
		},
		'sarosis.canvas.zoomPadding': {
			type: 'number', default: 50, minimum: 10, maximum: 200,
			description: localize('sarosis.canvas.zoomPadding', "聚焦节点时的视口边距 (px)。"),
		},
		'sarosis.canvas.mouseNavigation': {
			type: 'boolean', default: true,
			description: localize('sarosis.canvas.mouseNavigation', "启用鼠标侧键前进/后退导航。"),
		},
	},
});

// --- Builtin Agent .agent.md Sync -----------------------------------------------
// Ensures builtin agents have .agent.md files in ~/.saros/agents/ before the
// native chat panel loads, so icons appear correctly in the chat dropdown.

class BuiltinAgentMdSyncContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.builtinAgentMdSync';

	constructor(@IAgentStudioService _agentStudioService: IAgentStudioService) {
		// Injecting IAgentStudioService triggers its constructor, which first
		// migrates legacy ~/.saros/ data into ~/.vssaros/ and then seeds the
		// builtin agents' .agent.md files under ~/.vssaros/agents/.
	}
}

registerWorkbenchContribution2(BuiltinAgentMdSyncContribution.ID, BuiltinAgentMdSyncContribution, WorkbenchPhase.BlockRestore);

// --- Services Registration -------------------------------------------------------

registerSingleton(IAgentStudioLogService, AgentStudioLogService, InstantiationType.Delayed);
registerSingleton(IFeedbackService, FeedbackService, InstantiationType.Delayed);
registerSingleton(IModelsAutoUpdateService, ModelsAutoUpdateService, InstantiationType.Delayed);
registerSingleton(IAgentStudioService, AgentStudioService, InstantiationType.Delayed);
registerSingleton(IAgentChatService, AgentChatService, InstantiationType.Delayed);
registerSingleton(IAgentOSService, AgentOSService, InstantiationType.Delayed);
registerSingleton(IAgentDriverService, AgentDriverService, InstantiationType.Delayed);
registerSingleton(IModelSelectorService, ModelSelectorService, InstantiationType.Delayed);
registerSingleton(IAgentModelResolver, AgentModelResolver, InstantiationType.Delayed);
registerSingleton(IAgentDelegationService, AgentDelegationService, InstantiationType.Delayed);
registerSingleton(IAgentTaskBoardService, AgentTaskBoardService, InstantiationType.Delayed);
registerSingleton(IWorkspaceRegistry, WorkspaceRegistryService as any, InstantiationType.Delayed);
registerSingleton(IAgentInstanceService, AgentInstanceService, InstantiationType.Delayed);
registerSingleton(IAgentGalleryService, AgentGalleryService, InstantiationType.Delayed);
registerSingleton(IGitCommitService, GitCommitService, InstantiationType.Delayed);
registerSingleton(IAgentSchedulerService, AgentSchedulerService, InstantiationType.Delayed);
registerSingleton(IHealthMonitorService, HealthMonitorService, InstantiationType.Delayed);
registerSingleton(ICrewTeamService, CrewTeamService, InstantiationType.Delayed);
registerSingleton(IWorkflowStorageService, WorkflowStorageService, InstantiationType.Delayed);
registerSingleton(IWorkflowExecutionService, WorkflowExecutionService, InstantiationType.Delayed);
registerSingleton(IWorkflowVersionService, WorkflowVersionService, InstantiationType.Delayed);
registerSingleton(IEventBridgeService, EventBridgeService, InstantiationType.Delayed);
registerSingleton(ITaskOrchestrationService, TaskOrchestrationService, InstantiationType.Delayed);
// ConfigHtml service: shared across all webview controllers (chat panels) and
// the HtmlPreviewEditorPane. Keeping a single instance avoids duplicating
// the per-agent state cache and lets the preview pane forward webview
// imgui.submit messages back through the same dispatcher.
registerSingleton(IConfigHtmlService, ConfigHtmlService, InstantiationType.Delayed);
// Workspace lifecycle event bus — generic, decoupled hook system used by
// CLI/provider extensions (e.g. demo-agui) to react to workspace mutations
// without any main-repo hardcoding. Eager so its extension-facing commands
// (`agentStudio.workspaceLifecycle.register/unregister/list`) are available
// before any extension is activated.
registerSingleton(IWorkspaceLifecycleService, WorkspaceLifecycleService, InstantiationType.Eager);
// Skill lifecycle event bus — generic, decoupled hook system used by
// CLI/provider extensions (e.g. demo-agui) to react to skill mutations
// (add / remove / batch sync) on agent instances. Eager so its
// extension-facing commands are available before any extension is activated.
registerSingleton(ISkillLifecycleService, SkillLifecycleService, InstantiationType.Eager);
// ISettingsTabRegistry is still registered for the legacy SettingsViewPane (sidebar).
// Plugin-specific settings (like Knot) now open as independent EditorPanes
// rather than appearing as tabs in the Settings page.
registerSingleton(ISettingsTabRegistry, SettingsTabRegistry, InstantiationType.Delayed);
registerSingleton(IWikiTagService, WikiTagServiceImpl, InstantiationType.Delayed);
// TOF 登录服务 — 对接 OAuthSystem 网关，提供 OA 浏览器登录 + 票据持久化
registerSingleton(ITofAuthService, TofAuthService, InstantiationType.Delayed);
registerSingleton(ISelfEvolutionService, SelfEvolutionService, InstantiationType.Delayed);
// Kanban triage (LLM-driven specify/decompose). Delayed: only instantiated when
// a triage action is invoked from the board UI or a kanban tool.
registerSingleton(ITriageService, LlmTriageService, InstantiationType.Delayed);
// Kanban diagnostics (health scanner). Eager: must start its periodic scan timer
// and subscribe to task-board change events in the background without an explicit consumer.
registerSingleton(IKanbanDiagnosticsService, KanbanDiagnosticsService, InstantiationType.Eager);
// Swarm (multi-agent collaboration). Delayed: only instantiated when a swarm is
// created from the board UI or the kanban_swarm tool.
registerSingleton(ISwarmService, SwarmService, InstantiationType.Delayed);
// Kanban scraping recipes (URL-matched, Playwright-function extraction). Delayed:
// only instantiated when a recipe tool is called or a web_scrape_to_board runs.
registerSingleton(IKanbanRecipeService, KanbanRecipeService, InstantiationType.Delayed);
// Kanban browser-context-menu bridge: runs web_scrape_to_board from the
// integrated browser's "创建看板任务" right-click action. Delayed.
registerSingleton(IKanbanScrapeService, KanbanScrapeService, InstantiationType.Delayed);
// Codebase-Memory-MCP service — detect, install, upgrade, configure MCP.
// Delayed: instantiated by bootstrap contribution or EditorPane.
registerSingleton(ICodebaseMemoryMcpService, CodebaseMemoryMcpService, InstantiationType.Delayed);
// Native Codebase Graph Service — uses VS Code's built-in tree-sitter WASM, no external binary.
registerSingleton(ICodebaseGraphService, CodebaseGraphService, InstantiationType.Delayed);
registerSingleton(ICodebaseGraphWatcher, CodebaseGraphWatcher, InstantiationType.Delayed);
// Dashboard Service — aggregates stats from AgentOS, ContextManager, Memory, Graph
registerSingleton(IAgentStudioDashboardService, AgentStudioDashboardService, InstantiationType.Delayed);
// Shared KB native kernel — lets the BlockSuite note editor reuse the KB view's
// already-built backlink/mention index instead of re-scanning the vault.
registerSingleton(IKbNativeKernelService, KbNativeKernelService, InstantiationType.Delayed);
registerSingleton(IKbVersionService, KbVersionService, InstantiationType.Delayed);
registerSingleton(ISkillVersionService, SkillVersionService, InstantiationType.Delayed);
registerSingleton(IAgentVersionService, AgentVersionService, InstantiationType.Delayed);
registerSingleton(IEmbeddingService, EmbeddingService, InstantiationType.Delayed);

// --- EditorPane Registration -----------------------------------------------------
// Register AgentStudioEditorPane so that AgentStudioEditorInput can be opened
// in the editor area (specifically in the locked right-side editor group).

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentStudioEditorPane,
		AgentStudioEditorPane.ID,
		localize('agentStudioEditor', "Agent Studio"),
	),
	[
		new SyncDescriptor(AgentStudioEditorInput)
	]
);

// Register SettingsEditorPane so that SettingsEditorInput opens in the editor area.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		SettingsEditorPane,
		SettingsEditorPane.ID,
		localize('agentStudioSettingsEditor', "Agent Studio Settings"),
	),
	[
		new SyncDescriptor(SettingsEditorInput)
	]
);

// Register PluginDetailEditorPane so that PluginDetailEditorInput opens in the editor area.
// Clicking a plugin in the Plugins sidebar view opens the detail in the editor area,
// mirroring VS Code's native Extensions view behavior.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		PluginDetailEditorPane,
		PluginDetailEditorPane.ID,
		localize('pluginDetailEditor', "Plugin Detail"),
	),
	[
		new SyncDescriptor(PluginDetailEditorInput)
	]
);

// Register AgentMarketEditorPane so that the Agent Market (商城) page opens
// in the editor area. Triggered by the "🛒 Agent 商城" entry in the Preset
// Agent sidebar view, mirroring VS Code's native Extensions Marketplace.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentMarketEditorPane,
		AgentMarketEditorPane.ID,
		localize('agentMarketEditor', "Agent Market"),
	),
	[
		new SyncDescriptor(AgentMarketEditorInput)
	]
);

// Register AgentCreateEditorPane so that the "Create Agent" page opens
// in the editor area. Triggered by the "✏ 创建" button in the Preset
// Agent sidebar view.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentCreateEditorPane,
		AgentCreateEditorPane.ID,
		localize('agentCreateEditor', "Create Agent"),
	),
	[
		new SyncDescriptor(AgentCreateEditorInput)
	]
);

// Register EvolutionDetailEditorPane so that evolution records open in the editor area.
// Clicking a record in the Evolution sidebar view opens the detail in the editor area.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		EvolutionDetailEditorPane,
		EvolutionDetailEditorPane.ID,
		localize('evolutionDetailEditor', "Evolution Detail"),
	),
	[
		new SyncDescriptor(EvolutionDetailEditorInput)
	]
);

// Register ChannelEditorPane so that channel configuration pages open in the editor area.
// Clicking a channel in the Channel sidebar view opens its config in the editor area.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ChannelEditorPane,
		ChannelEditorPane.ID,
		localize('channelEditor', "Channel Configuration"),
	),
	[
		new SyncDescriptor(ChannelEditorInput)
	]
);

// Register TaskOverviewEditorPane — Kanban board overview in the editor area.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		TaskOverviewEditorPane,
		TaskOverviewEditorPane.ID,
		localize('taskOverviewEditor', "Task Overview"),
	),
	[
		new SyncDescriptor(TaskOverviewEditorInput)
	]
);

// Register TaskDetailEditorPane — single task detail page in the editor area.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		TaskDetailEditorPane,
		TaskDetailEditorPane.ID,
		localize('taskDetailEditor', "Task Detail"),
	),
	[
		new SyncDescriptor(TaskDetailEditorInput)
	]
);

// Register AgentMediaEditorPane — 在中间栏编辑器独立展示聊天里的媒体（生成图 / 候选图 / 参考图）。
// 2026-09-11 用户需求：聊天框显示的图片双击后在中间编辑器单独 pane 展示。
// 用自定义 input 而非 FileEditorInput：媒体 ref 多为 data URL（画布生成结果的主流形态），无文件资源可依附。
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentMediaEditorPane,
		AgentMediaEditorPane.ID,
		localize('agentMediaEditor', "媒体预览"),
	),
	[
		new SyncDescriptor(AgentMediaEditorInput)
	]
);

// Register HtmlFileEditorPane — unified HTML editor: handles both
// standard .html files (FileEditorInput, 3-mode toggle) and
// saros-html-preview:// scheme (HtmlPreviewEditorInput, agent config preview).
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		HtmlFileEditorPane,
		'agentStudio.htmlFileEditor',
		localize('htmlFileEditor', "HTML File Editor"),
	),
	[
		new SyncDescriptor(FileEditorInput),
		new SyncDescriptor(HtmlPreviewEditorInput)
	]
);

// Register MdFileEditorPane — extends TextFileEditor with a 2-mode
// segmented toggle (预览 / Markdown) for .md files.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		MdFileEditorPane,
		'agentStudio.mdFileEditor',
		localize('mdFileEditor', "Markdown File Editor"),
	),
	[
		new SyncDescriptor(FileEditorInput)
	]
);

// NOTE (2026-07-04): The 编辑 / HTML / 预览 toggle for HTML files opened via
// HtmlFileEditorPane is now rendered directly into the editor group's
// trailing breadcrumbs (via `setTrailingBreadcrumbsContent` inside
// HtmlFileEditorPane.setInput). The previous EditorTitle action registration
// for `HtmlFileEditorPane.TOGGLE_MODE_ACTION_ID` has been removed because it
// duplicated the visual control — keeping both produced a redundant toggle
// (one in the toolbar, one in the trailing breadcrumbs).
//
// The constant `HtmlFileEditorPane.TOGGLE_MODE_ACTION_ID` is kept on the
// class for backward compatibility with any callers that still reference
// the id, but it is no longer registered as a menu action.

// Register UrlPreviewEditorPane — renders an external URL inside the editor
// area. Opened when the user clicks a hyperlink in an LLM chat response;
// the page loads in the middle column instead of an external browser.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		UrlPreviewEditorPane,
		UrlPreviewEditorPane.ID,
		localize('urlPreviewEditor', "URL Preview"),
	),
	[
		new SyncDescriptor(UrlPreviewEditorInput)
	]
);

// Register CompressionDetailEditorPane — shows before/after comparison
// of context compression. Opened from the system message panel toolbar.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		CompressionDetailEditorPane,
		CompressionDetailEditorPane.ID,
		localize('compressionDetailEditor', "Compression Detail"),
	),
	[
		new SyncDescriptor(CompressionDetailEditorInput)
	]
);

// Register MemoryDetailEditorPane — shows memory entries (Working/Episodic/Semantic/Procedural)
// for the current agent. Opened from the system message panel toolbar.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		MemoryDetailEditorPane,
		MemoryDetailEditorPane.ID,
		localize('memoryDetailEditor', "Memory Detail"),
	),
	[
		new SyncDescriptor(MemoryDetailEditorInput)
	]
);

// Register CodebaseMemoryDetailEditorPane — shows codebase memory info.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		CodebaseMemoryDetailEditorPane,
		CodebaseMemoryDetailEditorPane.ID,
		localize('codebaseMemoryDetailEditor', "Codebase Memory Detail"),
	),
	[
		new SyncDescriptor(CodebaseMemoryDetailEditorInput)
	]
);

// Register MediaGalleryEditorPane — 完整的媒体库画廊（数据源 = 工作流媒体库）。
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		MediaGalleryEditorPane,
		MediaGalleryEditorPane.ID,
		localize('mediaGalleryEditor', "Media Gallery"),
	),
	[
		new SyncDescriptor(MediaGalleryEditorInput)
	]
);

// Register CodebaseGraphViewerEditorPane — shows 3D graph visualization.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		CodebaseGraphViewerEditorPane,
		CodebaseGraphViewerEditorPane.ID,
		localize('codebaseGraphViewerEditor', "Codebase Graph Viewer"),
	),
	[
		new SyncDescriptor(CodebaseGraphViewerEditorInput)
	]
);

// Register CodebaseIndexEditorPane — standalone codebase indexing controls
// (originally the Memory "代码图谱" tab content, now extracted as independent pane).
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		CodebaseIndexEditorPane,
		CodebaseIndexEditorPane.ID,
		localize('codebaseIndexEditor', "Codebase Index"),
	),
	[
		new SyncDescriptor(CodebaseIndexEditorInput)
	]
);

// Register AgentStudioDashboardEditorPane — shows the full Dashboard with KPIs,
// charts, compression metrics, sessions, memory, budget, and token distribution.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentStudioDashboardEditorPane,
		AgentStudioDashboardEditorPane.ID,
		localize('agentStudioDashboardEditor', "AgentStudio Dashboard"),
	),
	[
		new SyncDescriptor(AgentStudioDashboardEditorInput)
	]
);

// Register WorkflowEditorPane — renders workflow details in the editor area.
// Clicking a workflow in the Workflow sidebar view opens its detail view.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		WorkflowEditorPane,
		WorkflowEditorPane.ID,
		localize('workflowEditor', "Workflow Detail"),
	),
	[
		new SyncDescriptor(WorkflowEditorInput)
	]
);

// Register WorkflowNodeEditorPane — 单个节点的编辑器开在独立 tab（2026-09-13，P2）。
// 入口：节点卡片「⛶ 全屏」浮层里的「↗ 独立窗口」按钮 → RPC workflow.openNodeEditor。
// resource 是 `saros-workflow-node:/{workflowId}/{nodeId}` → 与画布 tab 并存、同节点去重。
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		WorkflowNodeEditorPane,
		WorkflowNodeEditorPane.ID,
		localize('workflowNodeEditor', "Workflow Node Editor"),
	),
	[
		new SyncDescriptor(WorkflowNodeEditorInput)
	]
);

// Register AgentSettingsEditorPane — renders agent settings (System Prompt,
// Skills, Memory, Knowledge, ConfigHtml, Tools, MCP, Rules) in the editor area.
// Opened by clicking an agent in the Agent sidebar view.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentSettingsEditorPane,
		AgentSettingsEditorPane.ID,
		localize('agentSettingsEditor', "Agent Settings"),
	),
	[
		new SyncDescriptor(AgentSettingsEditorInput)
	]
);

// Register McpServerEditorPane so that the MCP Server management page opens
// in the editor area. Triggered by clicking "+ Manage Servers" in the
// Integration sidebar view's MCP tab.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		McpServerEditorPane,
		McpServerEditorPane.ID,
		localize('mcpServerEditor', "MCP Servers"),
	),
	[
		new SyncDescriptor(McpServerEditorInput)
	]
);

// Register McpDetailEditorPane — single-MCP detail page (icon, intro, usage
// guide, tools, install/delete button). Triggered by clicking an MCP item in
// the MCP Servers list page or the Integration sidebar's MCP tab.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		McpDetailEditorPane,
		McpDetailEditorPane.ID,
		localize('mcpDetailEditor', "MCP Server Detail"),
	),
	[
		new SyncDescriptor(McpDetailEditorInput)
	]
);

// Register SkillMarketEditorPane so that the Skill Marketplace page opens
// in the editor area. Triggered by clicking "+ Install" in the Integration
// sidebar view's Skill tab.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		SkillMarketEditorPane,
		SkillMarketEditorPane.ID,
		localize('skillMarketEditor', "Skill Marketplace"),
	),
	[
		new SyncDescriptor(SkillMarketEditorInput)
	]
);

// Register WorkflowMarketEditorPane so that the Workflow Marketplace page opens
// in the editor area. Triggered by clicking "Install" in the Workflow
// sidebar view.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		WorkflowMarketEditorPane,
		WorkflowMarketEditorPane.ID,
		localize('workflowMarketEditor', "Workflow Marketplace"),
	),
	[
		new SyncDescriptor(WorkflowMarketEditorInput)
	]
);

// Register MarketplaceEditorPane so that the Saros Marketplace page opens
// in the editor area. Triggered by clicking "🛒 Market" in the Integration
// sidebar view's global action bar.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		MarketplaceEditorPane,
		MarketplaceEditorPane.ID,
		localize('marketplaceEditor', "VsSaros Marketplace"),
	),
	[
		new SyncDescriptor(MarketplaceEditorInput)
	]
);

// Register ResourceManagerEditorPane — unified management page for locally
// installed Skills / Tools / MCP / Knowledge / Workflows. Combines a sidebar
// list with a Skill/MCP detail editor (header + tabbed content). Triggered by
// the "agentStudio.openResourceManager" command or Integration sidebar.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ResourceManagerEditorPane,
		ResourceManagerEditorPane.ID,
		localize('resourceManagerEditor', "Resource Manager"),
	),
	[
		new SyncDescriptor(ResourceManagerEditorInput)
	]
);

// Register NativeChatEditorPane — renders the Agent Chat UI natively in
// the DOM (no WebView/iframe overlay). Mounted inside AgentEditorPart.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		NativeChatEditorPane,
		NativeChatEditorPane.ID,
		localize('nativeChatEditor', "Agent Chat"),
	),
	[
		new SyncDescriptor(NativeChatEditorInput)
	]
);

// Register KbBlocksEditorPane — 点击知识库文件后在中间栏打开的 WYSIWYG 笔记编辑器。
// 用 AFFiNE / BlockSuite 替换旧的 SiYuan (Lute/Protyle) 渲染管线，详见
// doc/affine-replace-siyuan-plan.md（Phase 1）。其 ID 与 KbNoteEditorInput.editorId
// 一致，故知识库视图点击文件即打开此 BlockSuite 编辑器。
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		KbBlocksEditorPane,
		KbBlocksEditorPane.ID,
		localize('kbBlocksEditor', "知识库 Block 编辑器"),
	),
	[
		new SyncDescriptor(KbNoteEditorInput)
	]
);

// Register KnowledgeBaseGraphEditorPane — 「🕸️ 关系图谱」在中间栏打开的
// 独立力导向图 EditorPane（对齐 SiYuan openGraph → 中心 Tab 范式）。
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		KnowledgeBaseGraphEditorPane,
		KnowledgeBaseGraphEditorPane.ID,
		localize('kbGraphEditor', "知识库关系图谱"),
	),
	[
		new SyncDescriptor(KbGraphEditorInput)
	]
);

// Register CanvasEditorPane — 「🧠 思维导图编辑器」
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		CanvasEditorPane,
		CanvasEditorPane.ID,
		localize('canvasEditor', "思维导图编辑器"),
	),
	[
		new SyncDescriptor(CanvasEditorInput)
	]
);

// ─── Canvas Editor：把 .canvas 文件关联到思维导图编辑器 ────────────────
// 否则在文件树 / 资源管理器中点击 .canvas 文件会走默认文本编辑器，看不到思维导图。
class CanvasEditorResolverContribution extends Disposable {
	constructor(
		@IEditorResolverService private readonly _editorResolverService: IEditorResolverService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(
			this._editorResolverService.registerEditor(
				'*.canvas',
				{
					// id 必须是「编辑器面板 id」（CanvasEditorPane.ID），与 CanvasEditorInput.editorId 一致；
					// 否则 resolver 按此 id 找不到 canvas 面板，会回退到默认文本编辑器（打开成纯 JSON）。
					id: CanvasEditorPane.ID,
					label: localize('canvasEditor', "思维导图编辑器"),
					priority: RegisteredEditorPriority.exclusive,
				},
				{
					canSupportResource: (resource) => resource.path.endsWith('.canvas'),
				},
				{
					createEditorInput: async (editor) => {
						const resource = editor.resource;
						this._logService.info(`[CanvasEditor] resolver.createEditorInput: resource=${resource?.toString()}`);
						let mindmapData: IMindmapData = { nodes: [], edges: [] };
						if (resource) {
							try {
								const content = await this._fileService.readFile(resource);
								mindmapData = JSON.parse(content.value.toString()) as IMindmapData;
								this._logService.info(`[CanvasEditor] resolver.createEditorInput: parsed nodes=${(mindmapData.nodes ?? []).length}, edges=${(mindmapData.edges ?? []).length}, mindmapFlag=${mindmapData.mindmap}`);
							} catch (e) {
								this._logService.warn(`[CanvasEditor] resolver.createEditorInput: 读取/解析 ${resource.toString()} 失败，使用空思维导图`, e);
							}
						}
						return { editor: new CanvasEditorInput(resource!, mindmapData) };
					},
				},
			)
		);
	}
}
registerWorkbenchContribution2(
	'workbench.contrib.canvasEditorResolver',
	CanvasEditorResolverContribution,
	WorkbenchPhase.BlockStartup,
);

// ─── Canvas Editor 键盘命令 ──────────────────────────────────────────

const canvasCmd = (
	id: string, title: string, primary: number | 0, handler: (pane: CanvasEditorPane) => void,
) => {
	registerAction2(class extends Action2 {
		constructor() {
			const opts: any = { id, title: localize2(id, title), f1: false };
			if (primary !== 0) {
				// 仅在画布编辑器激活时生效 —— 否则全局劫持 Backspace/Delete/方向键等，
				// 导致其他编辑器/输入框里无法删除文本（weight 200 优先级很高）
				opts.keybinding = {
					primary,
					weight: 200,
					when: ActiveEditorContext.isEqualTo(CanvasEditorPane.ID),
				};
			}
			super(opts);
		}
		override async run(): Promise<void> {
			const pane = getActiveCanvasPane();
			if (pane) { handler(pane); }
		}
	});
};

// 节点操作
canvasCmd('sarosis.canvas.addChild', '思维导图：添加子节点',
	KeyCode.Tab, p => p.cmdAddChild());
canvasCmd('sarosis.canvas.addSibling', '思维导图：添加兄弟节点',
	KeyMod.Shift | KeyCode.Enter, p => p.cmdAddSibling());
canvasCmd('sarosis.canvas.deleteNode', '思维导图：删除节点',
	KeyCode.Delete, p => p.cmdDeleteNode());
// 参考实现同时支持 Backspace 删除（节点 / 选中连线）
canvasCmd('sarosis.canvas.deleteNodeBackspace', '思维导图：删除节点（Backspace）',
	KeyCode.Backspace, p => p.cmdDeleteNode());
canvasCmd('sarosis.canvas.copyNodes', '思维导图：复制节点',
	KeyMod.CtrlCmd | KeyCode.KeyC, p => p.cmdCopyNodes());
canvasCmd('sarosis.canvas.pasteNodes', '思维导图：粘贴节点',
	KeyMod.CtrlCmd | KeyCode.KeyV, p => p.cmdPasteNodes());
canvasCmd('sarosis.canvas.editNode', '思维导图：编辑节点',
	KeyCode.Enter, p => p.cmdEditNode());
canvasCmd('sarosis.canvas.saveAndExit', '思维导图：保存并退出编辑',
	KeyMod.CtrlCmd | KeyCode.Enter, p => p.cmdSaveAndExit());

// 布局/风格
canvasCmd('sarosis.canvas.relayout', '思维导图：自动布局',
	KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL, p => p.cmdRelayout());
canvasCmd('sarosis.canvas.applyColors', '思维导图：分支着色',
	0, p => p.cmdApplyColors());
canvasCmd('sarosis.canvas.flipBranch', '思维导图：翻转分支',
	KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF, p => p.cmdFlipBranch());
canvasCmd('sarosis.canvas.toggleBalance', '思维导图：平衡布局',
	KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyB, p => p.cmdToggleBalance());
canvasCmd('sarosis.canvas.toggleExpand', '思维导图：折叠/展开节点',
	KeyCode.Space, p => p.cmdToggleExpand());

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sarosis.canvas.setDirection',
			title: localize2('sarosis.canvas.setDirection', '思维导图：设置布局方向'),
			f1: true,
		});
	}
	override async run(_accessor: ServicesAccessor, mode?: MindmapDirection): Promise<void> {
		const pane = getActiveCanvasPane();
		if (!pane) { return; }
		const valid: MindmapDirection[] = ['right', 'left', 'both', 'tree', 'flower'];
		if (mode && valid.includes(mode)) {
			pane.cmdSetDirection(mode);
		} else {
			pane.cmdCycleDirection();
		}
	}
});

// Undo/Redo
canvasCmd('sarosis.canvas.undo', '思维导图：撤销',
	KeyMod.CtrlCmd | KeyCode.KeyZ, p => p.cmdUndo());
canvasCmd('sarosis.canvas.redo', '思维导图：重做',
	KeyMod.CtrlCmd | KeyCode.KeyY, p => p.cmdRedo());

// 导航
canvasCmd('sarosis.canvas.navigateUp', '思维导图：导航上移',
	KeyCode.UpArrow, p => p.cmdNavigate('up'));
canvasCmd('sarosis.canvas.navigateDown', '思维导图：导航下移',
	KeyCode.DownArrow, p => p.cmdNavigate('down'));
canvasCmd('sarosis.canvas.navigateLeft', '思维导图：导航左移',
	KeyCode.LeftArrow, p => p.cmdNavigate('left'));
canvasCmd('sarosis.canvas.navigateRight', '思维导图：导航右移',
	KeyCode.RightArrow, p => p.cmdNavigate('right'));
canvasCmd('sarosis.canvas.navigateToSource', '思维导图：跳转到源码（Ctrl+点击节点）',
	0, p => p.cmdNavigateToSource());

// 视图
canvasCmd('sarosis.canvas.fitViewport', '思维导图：适应窗口',
	KeyMod.CtrlCmd | KeyCode.Digit0, p => p.cmdFitViewport());
canvasCmd('sarosis.canvas.toggleOutline', '思维导图：切换大纲面板',
	KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO, p => p.toggleOutline());

// 导航历史 + 引用
canvasCmd('sarosis.canvas.goBack', '思维导图：后退',
	KeyMod.Alt | KeyCode.LeftArrow, p => p.cmdGoBack());
canvasCmd('sarosis.canvas.goForward', '思维导图：前进',
	KeyMod.Alt | KeyCode.RightArrow, p => p.cmdGoForward());
canvasCmd('sarosis.canvas.copyNodeLink', '思维导图：复制节点链接',
	KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL, p => p.cmdCopyNodeLink());

// Register a unified command to add content/files to the active Agent Studio chat panel.
// - From webview "Add to Chat" buttons → receives { name, value, fullName } entry object
// - From Explorer/Editor "Add to Agent Chat" context menu → receives file URI
// Routes to the most recently focused NativeChatEditorPane (supports multiple chat tabs).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.addToChat',
			title: localize2('agentStudio.addToChat', 'Add to Agent Chat'),
			f1: false,
			menu: [{
				id: MenuId.ExplorerContext,
				group: '5_chat_saros',
				order: 0,
				when: ContextKeyExpr.and(
					AgentStudioActiveContext,
					ExplorerFolderContext.negate(),
					ContextKeyExpr.or(
						ResourceContextKey.Scheme.isEqualTo(Schemas.file),
						ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeRemote)
					)
				),
			}, {
				id: MenuId.EditorContext,
				group: '1_chat_saros',
				order: 1,
				when: ContextKeyExpr.and(
					AgentStudioActiveContext,
					EditorContextKeys.hasNonEmptySelection.negate(),
					ContextKeyExpr.or(
						ResourceContextKey.Scheme.isEqualTo(Schemas.file),
						ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeRemote),
						ResourceContextKey.Scheme.isEqualTo(Schemas.untitled),
						ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeUserData)
					)
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor, resourceOrEntry: URI | { name?: string; value?: unknown; fullName?: string; modelDescription?: string }): Promise<void> {
		const logService = accessor.get(ILogService);
		const pane = NativeChatEditorPane.lastFocusedPane;

		logService.info(`[agentStudio.addToChat] Triggered. lastFocusedPane=${pane ? `pane#${pane.paneId}` : 'null'}, argType=${URI.isUri(resourceOrEntry) ? 'URI' : 'entry'}`);

		// ★ 2026-09-15：`lastFocusedPane` 是跨 pane 静态引用，关闭聊天框独立窗口
		// 会销毁其中的 pane。dispose 侧已做移交（见 NativeChatEditorPane.dispose），
		// 这里再判一次 `isDisposed()` 作为兜底：宁可提示「未找到」，也不要把加文件
		// 动作打到已销毁的 pane 上（表现为静默失效）。
		if (!NativeChatEditorPane.isLivePane(pane)) {
			logService.warn('[agentStudio.addToChat] No live focused NativeChatEditorPane found. User may not have clicked on an Agent Chat tab yet.');
			return;
		}

		// URI mode — from Explorer / Editor context menu ("Add to Agent Chat")
		if (URI.isUri(resourceOrEntry)) {
			const uri = resourceOrEntry as URI;
			logService.info(`[agentStudio.addToChat] URI mode → pane.addFileToChat(${uri.toString()})`);
			await pane.addFileToChat(uri);
			return;
		}

		// Entry mode — from webview "Add to Chat" button
		const entry = resourceOrEntry as { name?: string; value?: unknown; fullName?: string };
		const name = entry?.fullName || entry?.name || 'Attachment';
		const content = typeof entry?.value === 'string' ? entry.value : String(entry?.value ?? '');
		logService.info(`[agentStudio.addToChat] Entry mode → pane.addContentToChat("${name}", ${content.length} chars)`);
		pane.addContentToChat(name, content);
		logService.debug(`[agentStudio.addToChat] Added "${name}" (${content.length} chars) to pane #${pane.paneId}`);
	}
});

// Register a command to open the Agent Studio Settings editor directly
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.openSettings',
			title: localize2('agentStudio.openSettings', 'Open Agent Studio Settings'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const input = SettingsEditorInput.getInstance();
		const groups = editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */);
		if (groups.length <= 1) {
			await editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		} else {
			await editorService.openEditor(input, { pinned: true }, groups[0]);
		}
	}
});

// ─── 迁移旧版知识库（系统 A / Hyper-Extract）到 llm-wiki ───────────────
// 一次性迁移命令：把 `<kb-storage-root>/<id>/kb.json` 旧 session 转成 Markdown
// 笔记写入激活 Vault 的「笔记 / 迁移」目录，并把旧目录安全归档（不硬删）。
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.kb.migrateLegacy',
			title: localize2('agentStudio.kb.migrateLegacy', '迁移旧版知识库到 llm-wiki'),
			category: localize2('agentStudio.category', 'Agent Studio'),
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const logService = accessor.get(ILogService);
		const notificationService = accessor.get(INotificationService);
		const storageService = accessor.get(IStorageService);
		const envService = accessor.get(IEnvironmentService) as INativeEnvironmentService;
		const kbKernelService = accessor.get(IKbNativeKernelService);
		try {
			const kbRoot = resolveKbRootUri(storageService, envService);
			const vault = loadActiveKbVault(storageService);
			if (!vault) {
				notificationService.warn(localize('kb.migrate.noVault', '未找到可用的知识库 Vault，请先打开知识库视图并创建一个 Vault。'));
				return;
			}
			const targetDir = resolveVaultNotesDir(vault, kbRoot);
			const report = await migrateLegacyKbSessions({ fileService, logService }, kbRoot, targetDir);
			if (report.scanned === 0) {
				notificationService.info(localize('kb.migrate.none', '未发现旧版知识库数据，无需迁移。'));
				return;
			}
			// 失效内核缓存，使迁移笔记在下次打开知识库时被索引（best-effort）
			try {
				kbKernelService.invalidate();
				await kbKernelService.ensureBuilt();
			} catch (e) {
				logService.warn('[KB-migrate] rebuild after migration failed (notes will index on next KB open)', e);
			}
			const msg = localize('kb.migrate.done',
				'已迁移 {0}/{1} 个旧版知识库 session 到「笔记/迁移」（{2} 个失败）。旧数据已归档至 {3}，未删除。',
				report.migrated, report.scanned, report.failed.length, report.archiveDir ?? '(无)');
			if (report.failed.length) {
				notificationService.warn(msg);
			} else {
				notificationService.info(msg);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logService.error('[KB-migrate] unexpected error', e);
			notificationService.error(localize('kb.migrate.error', '迁移失败：{0}', msg));
		}
	}
});

// Register a command to open the Resource Manager editor (Skills/Tools/MCP/
// Knowledge/Workflows unified management page).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.openResourceManager',
			title: localize2('agentStudio.openResourceManager', 'Open Resource Manager'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const input = ResourceManagerEditorInput.getInstance();
		const groups = editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */);
		if (groups.length <= 1) {
			await editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		} else {
			await editorService.openEditor(input, { pinned: true }, groups[0]);
		}
	}
});

// Register a command to open the Agent Market (Agent 商城) editor directly.
// Invoked by the "🛒 Agent 商城" button in the Preset Agent sidebar view.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.openMarket',
			title: localize2('agentStudio.openMarket', 'Open Agent Market'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const input = AgentMarketEditorInput.getInstance();
		const groups = editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */);
		if (groups.length <= 1) {
			await editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		} else {
			await editorService.openEditor(input, { pinned: true }, groups[0]);
		}
	}
});

// ─── Open Dashboard Command ────────────────────────────────────────────
// Opens the AgentStudio Dashboard in the editor area.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.openDashboard',
			title: localize2('agentStudio.openDashboard', 'Open AgentStudio Dashboard'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const input = AgentStudioDashboardEditorInput.getOrCreate();
		await editorService.openEditor(input, { pinned: true });
	}
});

// ─── Open Memory Detail Command ───────────────────────────────────────
// Opens the Memory Detail editor pane (4-Tier consolidation model).
// Can be invoked from:
//   1. Command Palette (F1 → "Open Memory Detail")
//   2. The Memory sidebar view's "打开详情" button
//   3. Any code that calls commandService.executeCommand('agentStudio.openMemoryDetail')
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.openMemoryDetail',
			title: localize2('agentStudio.openMemoryDetail', 'Open Memory Detail'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor, agentId?: string): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const agentStudioService = accessor.get(IAgentStudioService);
		// 优先使用传入的 agentId，其次从持久化存储获取，最后从 agent 列表获取第一个
		if (!agentId) {
			agentId = (await agentStudioService.getLastSelectedAgentId()) ?? undefined;
		}
		if (!agentId) {
			try {
				const agents = await agentStudioService.getAgents();
				agentId = agents[0]?.id;
			} catch { /* best effort */ }
		}
		const id = agentId ?? 'default';
		const input = MemoryDetailEditorInput.getOrCreate(id);
		await editorService.openEditor(input, { pinned: true });
	}
});

// ─── Codebase Memory Init Command ────────────────────────────────────
// Opens the Memory Detail editor pane, switches to the Codebase tab,
// and automatically triggers indexing if no graph exists.
//
// Can be invoked from:
//   1. Command Palette (F1 → "Codebase Memory Init")
//   2. Any code that calls commandService.executeCommand('agentStudio.codebaseMemoryInit')
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.codebaseMemoryInit',
			title: localize2('agentStudio.codebaseMemoryInit', 'Codebase Memory Init'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const agentStudioService = accessor.get(IAgentStudioService);
		const agentId = (await agentStudioService.getLastSelectedAgentId()) ?? 'default';
		const input = MemoryDetailEditorInput.getOrCreate(agentId);
		await editorService.openEditor(input, { pinned: true });
		// 等待 editor pane 渲染完成
		await new Promise(r => setTimeout(r, 200));
		// 获取打开的 EditorPane 并调用 activateCodebaseViewAndIndex
		const activeEditorPane = editorService.activeEditorPane;
		if (activeEditorPane instanceof MemoryDetailEditorPane) {
			await activeEditorPane.activateCodebaseViewAndIndex();
		}
	}
});

// ─── Pop Out Chat Window ───────────────────────────────────────────────
// Triggered from the **app title bar** (top-right, next to 反馈 / Panel / 折叠 —
// see `sessions/browser/parts/titlebarPart.ts`). It used to be an icon button in
// the chat editor's title bar; 2026-09-15（用户要求）moved to the title bar.
//
// Implementation: opens an independent OS-level Electron BrowserWindow
// (auxiliary editor part, with the session-list side view on its left) and
// puts **one brand-new blank chat box** in it — it does NOT move the main
// window's chat tabs out, and does NOT clone their conversation either.
//
// ★ 2026-09-15（用户要求）：主窗口**完全不动** ——
//   ① 不再把原聊天 tab 移出去（旧实现 moveEditors ⇒ 主窗口聊天框被清空）；
//   ② 不再隐藏右侧栏 / 顶部三个按钮（旧实现 setPartHidden +
//      `#agent-studio-titlebar-toggle-container` display:none）；
//   ③ 独立窗口里也**不 clone** 主窗口的会话（用户明确要求「全新的空白聊天」）
//      ⇒ 与主窗口零共享（会话锁 / 流式 claim / 历史文件都不共用），
//      因此关闭独立窗口不可能影响主窗口的聊天框区域。
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.popoutChat',
			title: localize2('agentStudio.popoutChat', 'Pop Out Chat to New Window'),
			f1: false,
			icon: Codicon.linkExternal,
			// ★ 2026-09-15（用户要求）：入口从「聊天编辑器标题栏」(MenuId.EditorTitle)
			// **移到 app 顶部标题栏**（见 `sessions/browser/parts/titlebarPart.ts` 的
			// `#agent-studio-titlebar-toggle-container`）。因此这里不再注册菜单项，
			// 也去掉 `precondition` —— 标题栏按钮是全局的，不受「当前活动编辑器是否为
			// 聊天」约束；`run()` 对非聊天上下文同样安全（继承不到 agentId 时开空白聊天）。
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const auxiliaryWindowService = accessor.get(IAuxiliaryWindowService);

		// 继承「被点击的那个聊天框」的 agent：独立窗口直接就是同一个 agent 的
		// **空白**对话，用户不必再选一次 agent（会话内容仍是全新的）。
		const activeEditor = editorService.activeEditor;
		const sourceAgentId = activeEditor instanceof NativeChatEditorInput ? activeEditor.agentId : undefined;

		// [Saros] 独立窗口左侧的「会话侧栏」（可拖拽调宽 / 可折叠），复用主窗口
		// 左侧栏的会话列表面板。提到 try 外声明，便于失败路径释放。
		let sideView: AuxChatSessionSideView | undefined;

		try {
			sideView = instantiationService.createInstance(AuxChatSessionSideView);
			const auxPart = await editorGroupsService.createAuxiliaryEditorPart({ sideView });
			sideView.setTargetPart(auxPart);

			// ★ 2026-09-15（用户确认）：**不 clone** —— 独立窗口里只开**一个全新的
			// 空白聊天**（既不搬走主窗口的会话，也不复制它的内容）。
			//
			//   · chatId 由 `create()` 自动生成 ⇒ 独立 tab；
			//   · `sessionId` 传 undefined ⇒ pane 判为「新页签」
			//     （`_isFreshChatTab()`，见 nativeChatEditorPane.ts）并创建
			//     **独立新会话** ⇒ 界面空白；
			//   · 与主窗口**零共享**（不共用 session ⇒ 会话锁 / 流式 claim /
			//     历史文件都不共享，关窗时不可能波及主窗口的聊天框）；
			//   · 主窗口**完全不动**（不移动 tab、不隐藏右侧栏、不动顶部三个按钮，
			//     旧实现这三件事都做了）。
			//
			// 只开一个（不再按主窗口的分屏数量镜像）：独立窗口的语义是「再给一个
			// 空白聊天窗口」，同时开好几个空白框没有意义。
			const fresh = NativeChatEditorInput.create(undefined, sourceAgentId);
			await auxPart.activeGroup.openEditor(fresh, { pinned: true });

			// ★ 2026-09-15：关窗前先把窗口里那个聊天自己关掉（保证主窗口零影响）。
			//
			// 上游语义是「关闭 aux 窗口 = 把窗口里的编辑器**移回主窗口**」
			// （auxiliaryEditorPart.ts:269-284 注释明说；实现是
			// `doClose(true)` → 先同步 `closeAllEditors({excludeConfirming:true})`，
			// 再把剩下的 merge 进 **File 区** 并 `targetGroup.focus()`）。
			// 只读的聊天本会被那步同步关掉、merge 自然空转，但这里再提前关一次，
			// 使「关窗时 aux 各组必然为空」成为**不依赖上游时序**的硬保证
			// ⇒ 主窗口（含聊天框区域）不会被 merge / 被 focus / 被重新布局。
			// ★★ 事件订阅必须收进 store 并释放（2026-09-15，修 `[LEAKED DISPOSABLE]`）。
			// 泄漏栈：`toDisposable`（`lifecycle.ts:406`）← `NativeAuxiliaryWindow.onBeforeUnload`
			// / `AuxiliaryEditorPartImpl.onWillDispose`（`event.ts:1295`）← 本方法 ✓
			// —— 两个订阅的返回值此前**直接被丢弃** ✗ ⇒ `toDisposable` 造的 Disposable 无人持有
			// ⇒ GC 时被 `GCBasedDisposableTracker` 报出 ✓。
			// ⚠ 释放时机选 `onWillDispose`（aux part 的**终结事件** ✓）：
			// 在它的回调里 dispose 整个 store ⇒ 两个监听器一起释放 ✓。
			// ⚠ **不**在 `onBeforeUnload` 里提前释放 —— 那会把 `onWillDispose` 监听器也解掉 ✗
			// ⇒ 下面的 `sideView?.dispose()` 就永远不会执行 ✗（行为回归）。
			const auxListeners = new DisposableStore();

			const auxWindow = auxiliaryWindowService.getWindow(auxPart.windowId);
			// ⚠ `getWindow()` 可能返回 undefined ⇒ 不能直接 `store.add(undefined)`（会抛 ✗）
			if (auxWindow) {
				auxListeners.add(auxWindow.onBeforeUnload(() => {
					for (const group of [...auxPart.groups]) {
						group.closeAllEditors({ excludeConfirming: true });
					}
				}));
			}

			// When the auxiliary window is closed, only release the side view.
			//
			// ★ 2026-09-15：不再需要「恢复右侧栏 / 恢复顶部按钮 / 把原实例搬回
			// agentPart / 派发 reopen-chat」这一整套收尾 —— 本次弹窗全程没有动过
			// 主窗口（没 move 编辑器、没隐藏任何 part），没有东西需要还原。
			// 至于独立窗口里那个新建的空白聊天：关闭 aux 窗口走
			// `AuxiliaryEditorPart.close()` → `doClose(true)`
			// （auxiliaryEditorPart.ts:518-536），会先
			// `closeAllEditors({ excludeConfirming: true })` 把它**直接关闭**，
			// 不会 merge 回主窗口 ⇒ 主窗口不会多出聊天框。
			auxListeners.add(auxPart.onWillDispose(() => {
				// ★ 先释放上面两个订阅（本事件是 aux part 的终结事件 ✓，之后不再需要它们 ✓）
				auxListeners.dispose();
				// [Saros] 独立窗口关闭 ⇒ 释放左侧会话侧栏（含其内部面板）
				sideView?.dispose();
			}));
		} catch {
			// Last-resort fallback: dispatch the legacy in-window overlay event
			// (kept for backward compatibility with the older floating-overlay impl).
			sideView?.dispose();
			mainWindow.document.dispatchEvent(new CustomEvent('agent-studio:popout-chat'));
		}
	}
});

// ── 自动给「聊天独立窗口」挂上会话侧栏 ──────────────────────────────────
//
// 为什么需要：`agentStudio.popoutChat` 只能在**创建窗口时**传入 sideView，而聊天
// 独立窗口还有另外两条创建路径拿不到该参数 ——
//   ① `AUX_WINDOW_GROUP`（会话右键 "Open in New Window"，
//      见 `sessionsViewPane.openInNewWindow`）
//   ② 拖拽聊天 tab 出窗口（`editorTabsControl.maybeCreateAuxiliaryEditorPartAt`）
// 这些窗口此前只有聊天区、没有左侧会话列表。这里统一补挂：只要某个 auxiliary
// window 里出现了聊天编辑器，就挂上 `AuxChatSessionSideView`（已挂的窗口跳过）。
class AuxChatSideViewContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.auxChatSideViewAutoAttach';

	/** 已创建的 auxiliary editor part（该事件只对 aux 窗口触发）。 */
	private readonly _auxParts = new Set<IAuxiliaryEditorPart>();
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.editorGroupsService.onDidCreateAuxiliaryEditorPart(part => {
			this._auxParts.add(part);
			const disposeListener = part.onWillDispose(() => {
				this._auxParts.delete(part);
				disposeListener.dispose();
			});
			this._register(disposeListener);
			this._attachIfChatWindow(part);
		}));

		// 窗口创建时通常是空的（编辑器随后才被 move 进来）⇒ 等编辑器出现再补挂。
		this._register(this.editorService.onDidVisibleEditorsChange(() => {
			if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
			this._debounceTimer = setTimeout(() => {
				this._debounceTimer = undefined;
				for (const part of this._auxParts) {
					this._attachIfChatWindow(part);
				}
			}, 300);
		}));
	}

	private _attachIfChatWindow(part: IAuxiliaryEditorPart): void {
		try {
			if (part.sideView) {
				return; // 创建时已传入（popoutChat 路径）
			}
			const hasChat = part.groups.some(group => group.editors.some(editor => editor instanceof NativeChatEditorInput));
			if (!hasChat) {
				return;
			}
			part.setSideView(this.instantiationService.createInstance(AuxChatSessionSideView));
			this.logService.info('[AuxChatSideView] attached session side view to auxiliary chat window');
		} catch (err) {
			this.logService.warn('[AuxChatSideView] failed to attach session side view:', err);
		}
	}
}

registerWorkbenchContribution2(AuxChatSideViewContribution.ID, AuxChatSideViewContribution, WorkbenchPhase.AfterRestored);

// ── app 顶部标题栏「新建聊天」按钮 ──────────────────────────────────────
// 用户要求（2026-09-15）：把原先在「聊天编辑器标题栏」的 `+` 按钮**移到 app 顶部
// 标题栏**（见 `sessions/browser/parts/titlebarPart.ts` 的
// `#agent-studio-titlebar-toggle-container`，与 popout 按钮相邻）。
// 命令仍在此注册，标题栏按钮按 id 调用 ⇒ 不再注册 MenuId.EditorTitle 菜单项，
// 也去掉 `precondition`（全局入口不依赖「当前活动编辑器是聊天」）。
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.newChatInEditor',
			title: localize2('agentStudio.newChatInEditor', '新建聊天'),
			f1: false,
			icon: Codicon.add,
		});
	}
	run(accessor: ServicesAccessor): void {
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const editorService = accessor.get(IEditorService);
		const logService = accessor.get(ILogService);
		const input = NativeChatEditorInput.create();

		// 聊天框的合法归属只有两个：主窗口 agentPart（右侧 agent 专区）或 popout 出的
		// 独立窗口（aux part）。严禁落入中间栏 mainPart（file editor instance）。
		//
		// 目标 part 判定用「活动编辑器（+ 按钮所在标题栏）的 group」经 getPart(group)
		// 按 group→part 确定性路由（一个 group id 只属于一个 part），而非依赖
		// `getActiveElement()` 的焦点检测——后者在 agentPart 内点击按钮时可能因焦点
		// 未落到 part 容器内而误判成 mainPart。
		const agentPart = getAgentPart(editorGroupsService);
		const activePane = editorService.activeEditorPane;
		const activeGroup = activePane?.group;
		const activePart = activeGroup ? editorGroupsService.getPart(activeGroup) : undefined;

		// ① 活动编辑器在 agentPart（主窗口 agent 专区）：每个新聊天默认开在独立 group。
		if (activePart && agentPart && activePart === (agentPart as unknown as IEditorPart)) {
			const active = agentPart.activeGroup;
			const targetGroup = active.editors.length === 0
				? active
				: (agentPart.groups.find(g => g.editors.length === 0)
					?? agentPart.addGroup(active, 3 /* GroupDirection.RIGHT */));
			targetGroup.openEditor(input, { pinned: true }).then(() => {
				// Chat editor opened successfully in agent part
			}).catch((err: any) => {
				logService.error('[newChatInEditor] failed to open editor:', err);
			});
			return;
		}

		// ② 活动编辑器在独立聊天窗口（aux part，非 mainPart）：在「当前活动 group」
		//    直接新增页签，保证页签出现在独立窗口里。
		if (activeGroup && activePart && activePart !== editorGroupsService.mainPart) {
			activeGroup.openEditor(input, { pinned: true }).then(() => {
				// Chat editor opened successfully in current (standalone) window
			}).catch((err: any) => {
				logService.error('[newChatInEditor] failed to open editor:', err);
			});
			return;
		}

		// ③ 主窗口且焦点判定失效（活动编辑器实际在 agentPart，但 activePane 误落在
		//    mainPart），或聊天误入 mainPart：一律重定向到 agentPart，绝不落入中间栏。
		if (agentPart?.activeGroup) {
			const active = agentPart.activeGroup;
			const targetGroup = active.editors.length === 0
				? active
				: (agentPart.groups.find(g => g.editors.length === 0)
					?? agentPart.addGroup(active, 3 /* GroupDirection.RIGHT */));
			targetGroup.openEditor(input, { pinned: true }).then(() => {
				// Chat editor opened successfully in agent part
			}).catch((err: any) => {
				logService.error('[newChatInEditor] failed to open editor:', err);
			});
			return;
		}

		// 极端兜底：agentPart 也不可用时回退到 editorService。
		editorService.openEditor(input, { pinned: true }).catch((err: any) => {
			logService.error('[newChatInEditor] failed to open editor:', err);
		});
	}
});

// ── 独立聊天窗口标题栏「新建聊天 Group」按钮 ──────────────────────────
// 在 aux 窗口（popout 独立聊天窗口）标题栏、最小化按钮左侧渲染一个「新建 Group」按钮。
// 点击后：在【当前活动 part】（aux part 优先，其次 agentPart）里新建一个 group，
// 并在该 group 中打开一个新的聊天编辑器。区别于 agentStudio.newChatInEditor
// （group 内 + 按钮，在 aux 窗口已隐藏）——本命令是「新建 group + 打开聊天」。
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.newChatGroup',
			title: localize2('agentStudio.newChatGroup', '新建聊天 Group'),
			f1: false,
			icon: Codicon.add,
		});
	}

	run(accessor: ServicesAccessor): void {
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const editorService = accessor.get(IEditorService);
		const logService = accessor.get(ILogService);
		const input = NativeChatEditorInput.create();

		// [diag] 定位 popout aux 窗口「新建聊天 Group」按钮点击无反应 —— 用 console.info
		// 直接打到 DevTools console（logService 通常只接受字符串）。
		// eslint-disable-next-line no-console
		console.info('[diag][newChatGroup] run() entered');

		// 目标 part：活动编辑器所在 part（aux 窗口聚焦时即 aux part），
		// 其次 agentPart（主窗口 agent 专区），最后 mainPart 兜底。
		const agentPart = getAgentPart(editorGroupsService);
		const activePane = editorService.activeEditorPane;
		const activeGroup = activePane?.group;
		const activePart = activeGroup ? editorGroupsService.getPart(activeGroup) : undefined;
		const targetPart = activePart ?? agentPart ?? editorGroupsService.mainPart;

		// eslint-disable-next-line no-console
		console.info('[diag][newChatGroup] resolved', {
			hasActivePane: !!activePane,
			activePaneInputType: activePane?.input?.constructor?.name,
			activeGroupId: activeGroup?.id,
			activePartClass: activePart?.constructor?.name,
			hasAgentPart: !!agentPart,
			targetPartClass: targetPart?.constructor?.name,
			targetPartGroupCount: targetPart?.groups?.length,
		});

		const baseGroup = activeGroup ?? targetPart.activeGroup;
		if (!baseGroup) {
			// eslint-disable-next-line no-console
			console.warn('[diag][newChatGroup] no baseGroup, fallback to editorService.openEditor');
			editorService.openEditor(input, { pinned: true }).catch((err: any) => {
				logService.error('[newChatGroup] failed to open editor:', err);
			});
			return;
		}

		// 在目标 part 内新建 group（向右分栏），并在其中打开新聊天。
		// 若已存在空 group 则复用，避免拆出「空 group + 聊天 group」两个分栏。
		const emptyGroup = targetPart.groups.find(g => g.editors.length === 0);
		// eslint-disable-next-line no-console
		console.info('[diag][newChatGroup] emptyGroup?', { hasEmpty: !!emptyGroup, emptyGroupId: emptyGroup?.id });
		const newGroup = emptyGroup ?? targetPart.addGroup(baseGroup, 3 /* GroupDirection.RIGHT */);
		// eslint-disable-next-line no-console
		console.info('[diag][newChatGroup] newGroup resolved', { newGroupId: newGroup?.id, isReused: !!emptyGroup });
		newGroup.openEditor(input, { pinned: true }).then(() => {
			// eslint-disable-next-line no-console
			console.info('[diag][newChatGroup] openEditor resolved');
		}).catch((err: any) => {
			// eslint-disable-next-line no-console
			console.error('[diag][newChatGroup] openEditor failed:', err);
			logService.error('[newChatGroup] failed to open editor:', err);
		});
	}
});

// ─── Toggle CLI Style Command ─────────────────────────────────────
// Toggles the chat panel between the default rich-bubble UI and a
// compact terminal-style layout. Appears in the editor tab context
// menu (right-click on a chat tab) and is bound to Ctrl+Shift+L.
// The preference is stored on the NativeChatEditorInput and survives
// tab switches + reloads (via the serializer).
registerAction2(class extends Action2 {
	constructor() {
		const chatEditorActive = ContextKeyExpr.or(
			ActiveEditorContext.isEqualTo('workbench.editor.agentStudio'),
			ActiveEditorContext.isEqualTo('workbench.editor.nativeChat'),
		);
		super({
			id: 'agentStudio.toggleCliStyle',
			title: localize2('agentStudio.toggleCliStyle', '切换 CLI 风格'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
			menu: [{
				id: MenuId.EditorTitleContext,
				when: chatEditorActive,
				group: '2_agentStudio',
				order: 1,
			}],
			keybinding: {
				weight: 200, // KeybindingWeight.WorkbenchContrib
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
				when: chatEditorActive,
			},
			precondition: chatEditorActive,
		});
	}
	run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		for (const pane of editorService.visibleEditorPanes) {
			if (pane instanceof NativeChatEditorPane) {
				pane.toggleCliMode();
				return;
			}
		}
	}
});

// --- EditorInput Serializers ----------------------------------------------------
// EditorPart persists the grid layout (groups + sashes) on shutdown and
// restores it on startup. Each editor in a group is round-tripped via its
// registered IEditorSerializer; an editor with NO serializer is silently
// dropped during save -> restore. That causes ghost (empty) groups to appear
// after split-and-restart, and the Sessions workbench's safety net then
// collapses them back to the default dual-tab layout — making it look like
// the split was never saved.
//
// Registering a serializer for every Agent Studio EditorInput keeps the
// user's split layout intact across reloads.

class AgentStudioEditorInputSerializer implements IEditorSerializer {
	canSerialize(_editorInput: EditorInput): boolean {
		return true;
	}
	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof AgentStudioEditorInput)) {
			return undefined;
		}
		return JSON.stringify({ panelType: editorInput.panelType });
	}
	deserialize(_instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serialized) as { panelType?: AgentStudioPanelType };
			if (!data.panelType) {
				return undefined;
			}
			return AgentStudioEditorInput.getOrCreate(data.panelType);
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(AgentStudioEditorInput.TypeID, AgentStudioEditorInputSerializer);

// Serializer for NativeChatEditorInput — ensures the native chat tab
// survives editor-state round-trips (persist on shutdown, restore on startup).
class NativeChatEditorInputSerializer implements IEditorSerializer {
	canSerialize(_editorInput: EditorInput): boolean {
		return true;
	}
	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof NativeChatEditorInput)) {
			return undefined;
		}
		return JSON.stringify({
			type: 'native-chat',
			chatId: editorInput.chatId,
			agentId: editorInput.agentId,
			sessionId: editorInput.sessionId,
			name: editorInput.name,
			cliMode: editorInput.cliMode,
		});
	}
	deserialize(_instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serialized);
			const input = NativeChatEditorInput.create(data.chatId, data.agentId, data.sessionId, data.name);
			if (data.cliMode) {
				input.setCliMode(true);
			}
			return input;
		} catch {
			return NativeChatEditorInput.getInstance();
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(NativeChatEditorInput.TypeID, NativeChatEditorInputSerializer);

// --- Provider Contribution -------------------------------------------------------

class AgentStudioProviderContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.agentStudioProvider';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();

		// Initialize global config service reference for agentStudioEditorInput.ts
		// This allows the static isNativeChatEnabled() check to read the feature flag.
		setConfigService(configurationService);

		const enabled = this.configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING);
		if (enabled) {
			const provider = this._register(this.instantiationService.createInstance(AgentStudioProvider));
			this._register(this.sessionsProvidersService.registerProvider(provider));

			// [Saros] Activate Agent Studio views immediately so UI is visible
			AgentStudioActiveContext.bindTo(this.contextKeyService).set(true);

			// [Saros] Two-column layout: Sidebar (activity bar + content) | Editor (Agent Studio EditorPanes)
			// Agent Chat, Task Board, and Canvas open as EditorPanes in the editor area.
		}
	}

}

registerWorkbenchContribution2(AgentStudioProviderContribution.ID, AgentStudioProviderContribution, WorkbenchPhase.BlockStartup);

// --- Built-in BYOK Provider Registration ------------------------------------
// Reads API keys from Settings and registers IModelProvider instances so they
// appear in the chat composer's provider picker.

class BYOKProviderContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.byokProviders';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IModelsAutoUpdateService private readonly modelsAutoUpdate: IModelsAutoUpdateService,
	) {
		super();

		if (!this.configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

		// 仿 opencode models.dev：启动时自动拉取 provider 模型清单并合并到 cp.models。
		// 提供 resolver 给 service，便于拉取时遍历已注册 provider（包括内置 + 自定义）。
		this.modelsAutoUpdate.registerProviderResolver(() => this._collectProviderHints());
		// 不阻塞启动：用 setTimeout 推到事件循环尾部
		setTimeout(() => { this.modelsAutoUpdate.triggerNow().catch(() => { /* 静默 */ }); }, 5_000);

		// 阶段 1：若主进程 LLM channel 可用，则把网络调用委派到 electron-main，
		// 否则回退到 renderer 直连的原 BuiltInBYOKModelProvider（web/remote 等）。
		const useMainProcess = !!this.mainProcessService?.getChannel(VSSAROS_LLM_CHANNEL);

		for (const def of BUILTIN_BYOK_PROVIDERS) {
			const provider = useMainProcess
				? new MainProcessModelProvider(def, this.configurationService, this.logService, this.environmentService, this.mainProcessService)
				: new BuiltInBYOKModelProvider(def, this.configurationService, this.logService, this.environmentService);
			this._register(this.agentOSService.registerModelProvider(provider));
			this.logService.info(`[BYOK] Registered built-in provider: ${def.id}${useMainProcess ? ' (main-process)' : ''}`);
		}

		// 阶段 2（Path B）：把 UI 添加的自定义 provider（持久化在
		// AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING）也注册进聊天模型系统，
		// 使其在模型选择器中可见、可真正发请求。监听设置变化做增量增删。
		this._registerCustomProviders(useMainProcess);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING)) {
				this._reconcileCustomProviders(useMainProcess);
			}
		}));
	}

	/** 已注册的自定义 provider 及其解绑句柄，用于增量增删。 */
	private readonly _customProviderDisposables = new Map<string, IDisposable>();

	private _registerCustomProviders(useMainProcess: boolean): void {
		const customProviders = this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
		for (const cp of customProviders) {
			this._registerOneCustomProvider(cp, useMainProcess);
		}
	}

	private _reconcileCustomProviders(useMainProcess: boolean): void {
		const customProviders = this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
		const desiredIds = new Set(customProviders.map(cp => cp.id));

		// 移除已不存在的自定义 provider
		for (const [id, disposable] of this._customProviderDisposables) {
			if (!desiredIds.has(id)) {
				disposable.dispose();
				this._customProviderDisposables.delete(id);
				this.logService.info(`[BYOK] Unregistered custom provider: ${id}`);
			}
		}

		// 注册新增/变化的自定义 provider（简单策略：先解绑再重绑，保证最新配置生效）
		for (const cp of customProviders) {
			const existing = this._customProviderDisposables.get(cp.id);
			if (existing) {
				existing.dispose();
				this._customProviderDisposables.delete(cp.id);
			}
			this._registerOneCustomProvider(cp, useMainProcess);
		}
	}

	private _registerOneCustomProvider(cp: CustomProviderData, useMainProcess: boolean): void {
		// provider id 冲突保护：跳过与内置 provider 重名的自定义项
		if (BUILTIN_BYOK_PROVIDERS.some(def => def.id === cp.id)) {
			this.logService.warn(`[BYOK] Custom provider id "${cp.id}" conflicts with a built-in provider; skipped`);
			return;
		}
		const def = customProviderDataToDefinition(cp);
		const provider = useMainProcess
			? new MainProcessModelProvider(def, this.configurationService, this.logService, this.environmentService, this.mainProcessService)
			: new BuiltInBYOKModelProvider(def, this.configurationService, this.logService, this.environmentService);
		const disposable = this.agentOSService.registerModelProvider(provider);
		this._customProviderDisposables.set(cp.id, disposable);
		this.logService.info(`[BYOK] Registered custom provider: ${cp.id} (${cp.apiType || 'openai'})${useMainProcess ? ' (main-process)' : ''}`);
	}

	/**
	 * 收集当前已注册的 provider 列表，供 ModelsAutoUpdateService 启动扫描用。
	 * - 内置 provider：从 BUILTIN_BYOK_PROVIDERS 读 baseUrl/apiKey 配置
	 * - 自定义 provider：从 AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING 读全部
	 */
	private _collectProviderHints(): IProviderHint[] {
		const hints: IProviderHint[] = [];
		// 内置 provider
		for (const def of BUILTIN_BYOK_PROVIDERS) {
			const baseUrl = (this.configurationService.getValue<string>(def.baseUrlConfigKey) || def.defaultBaseUrl || '').trim();
			const apiKey = (this.configurationService.getValue<string>(def.apiKeyConfigKey) || '').trim();
			hints.push({
				id: def.id,
				name: def.name,
				baseUrl,
				apiKey,
				apiType: def.isAnthropic ? 'anthropic' : 'openai',
				isBuiltin: true,
			});
		}
		// 自定义 provider
		const customProviders = this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
		for (const cp of customProviders) {
			hints.push({
				id: cp.id,
				name: cp.name,
				baseUrl: (cp.baseUrl || '').trim(),
				apiKey: (this.configurationService.getValue<string>(`sessions.agentStudio.provider.${cp.id}.apiKey`) || '').trim(),
				apiType: cp.apiType || 'openai',
				isBuiltin: false,
			});
		}
		return hints;
	}
}

registerWorkbenchContribution2(BYOKProviderContribution.ID, BYOKProviderContribution, WorkbenchPhase.AfterRestored);

// --- LanguageModels → IAgentOSService Bridge -------------------------------------
// Bridges the upstream `vscode.lm.registerLanguageModelChatProvider` proposed API
// into IAgentOSService.registerModelProvider, so any 3rd-party extension that
// declares `enabledApiProposals: ["chatProvider"]` and registers a provider via
// the standard VS Code extension API will appear in the chat box's provider picker
// without any main-repo import or rebuild.
import { LanguageModelsToAgentOSBridge } from './languageModelsBridge.js';
registerWorkbenchContribution2(LanguageModelsToAgentOSBridge.ID, LanguageModelsToAgentOSBridge, WorkbenchPhase.AfterRestored);

// --- Built-in Capability Providers (Skill / Tool / MCP / Memory) ----------------
// 把"四件套"内置 Provider 一次性注入 IAgentOSService。
// 每一项都可独立失败而不影响其他能力 —— 我们对每个 Provider 用 try/catch 兜底。
import { ISkillRegistry } from '../common/skills.js';
import { SkillRegistry } from './skillRegistryService.js';
import { ISkillInstallService } from '../common/skillHubTypes.js';
import { SkillInstallService } from './skillInstallService.js';
import { BuiltinToolProvider } from './providers/tool/builtinToolProvider.js';
import { JsonFileKanbanProvider } from './providers/kanban/jsonFileKanbanProvider.js';
import { ITriageService } from '../common/triageService.js';
import { LlmTriageService } from './providers/triage/llmTriageService.js';
import { IKanbanDiagnosticsService } from '../common/kanbanDiagnosticsService.js';
import { KanbanDiagnosticsService } from './providers/diagnostics/kanbanDiagnosticsService.js';
import { ISwarmService } from '../common/swarmService.js';
import { IKanbanRecipeService, KanbanRecipeService } from './providers/tool/kanbanRecipeService.js';
import { IKanbanScrapeService, KanbanScrapeService } from './providers/tool/kanbanScrapeService.js';
import { SwarmService } from './providers/swarm/swarmService.js';
import { McpToolProvider } from './providers/tool/mcpToolProvider.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { ICheckpointService } from '../common/checkpointService.js';
import { CheckpointService } from './checkpointService.js';
import { IAgentStudioWebviewPool, AgentStudioWebviewPool } from './agentStudioWebviewPool.js';
import { IMarketplaceService, MARKETPLACE_URL_SETTING, MARKETPLACE_AUTO_CHECK_SETTING, MARKETPLACE_UPDATE_INTERVAL_SETTING } from '../common/marketplace.js';
import { MarketplaceService } from './marketplaceService.js';
import { IPackageInstallerRegistry } from '../common/packageInstaller.js';
import { PackageInstallerRegistry } from './packageInstallerRegistry.js';
import { IMermaidInlineRenderer, MermaidInlineRenderer } from './mermaidInlineRenderer.js';
import { IDrawioInlineRenderer, DrawioInlineRenderer } from './drawioInlineRenderer.js';

registerSingleton(ISkillRegistry, SkillRegistry, InstantiationType.Delayed);
registerSingleton(ISkillInstallService, SkillInstallService, InstantiationType.Delayed);
registerSingleton(ICheckpointService, CheckpointService, InstantiationType.Delayed);
// Re-added to repair partial-revert state: AgentStudioWebviewController injects
// IAgentStudioWebviewPool, so the DI must have a registration for it.
registerSingleton(IAgentStudioWebviewPool, AgentStudioWebviewPool, InstantiationType.Delayed);
// Marketplace: 对接线上商城，实现 agent/skill/mcp/knowledge 的上传下载与升级
registerSingleton(IMarketplaceService, MarketplaceService, InstantiationType.Delayed);
// PackageInstallerRegistry: 按 kind 分发安装/打包逻辑（skill 已实现，其他后续补充）
registerSingleton(IPackageInstallerRegistry, PackageInstallerRegistry, InstantiationType.Delayed);
// MermaidInlineRenderer: renderer 进程内的隐藏 webview，把 Mermaid 源码渲染为 SVG
// 字符串（供 agent 工具卡片内联展示，无需扩展进程往返）
registerSingleton(IMermaidInlineRenderer, MermaidInlineRenderer, InstantiationType.Delayed);
CommandsRegistry.registerCommand(
	'_agentStudio.renderMermaidSvg',
	(accessor, markup: string, theme?: 'dark' | 'default') => {
		return accessor.get(IMermaidInlineRenderer).renderToSvg(markup, theme);
	},
);
// DrawioInlineRenderer: renderer 进程内的隐藏 webview，把 drawio mxGraphModel XML 渲染为 SVG
// 字符串（供 agent 工具卡片内联只读展示，无需扩展进程往返，复用 @maxgraph/core + drawioSerializer）
registerSingleton(IDrawioInlineRenderer, DrawioInlineRenderer, InstantiationType.Delayed);
CommandsRegistry.registerCommand(
	'_agentStudio.renderDrawioSvg',
	(accessor, source: string, theme?: 'dark' | 'default') => {
		return accessor.get(IDrawioInlineRenderer).renderToSvg(source, theme);
	},
);

// 图表预览：在编辑器区域打开新标签，渲染 SVG 图表。
// Mermaid 卡片调用 _mermaid-chat.openPreviewHost（mermaidCard.ts:202），
// Draw.io 卡片调用 _drawio-chat.openPreview（drawioCard.ts）——两者共用同一页面外壳，
// 仅渲染器不同（drawio 源码是 mxGraphModel XML，不是 mermaid 语法，不能混用）。
// 图表预览 HTML 的内容哈希（djb2）：同内容 → 同 URI → HtmlPreviewEditorInput.matches
// 按 resource 匹配 → openEditor 复用/激活已有标签，避免每次点击堆积重复标签
// （旧实现用 Date.now() 生成 URI，同图点 N 次开 N 个标签）。
function diagramContentHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) { h = (((h << 5) + h) + s.charCodeAt(i)) | 0; }
	return (h >>> 0).toString(16).padStart(8, '0');
}

async function openDiagramPreview(
	accessor: ServicesAccessor,
	render: (theme: 'dark' | 'default') => Promise<string>,
	title: string | undefined,
	logTag: string,
	contentKey: string,
): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const logService = accessor.get(ILogService);

	try {
		const bodyCls = mainWindow.document.body.classList;
		const isDark = bodyCls.contains('vs-dark') || bodyCls.contains('hc-black')
			|| bodyCls.contains('vscode-dark') || bodyCls.contains('vscode-high-contrast');
		const svg = await render(isDark ? 'dark' : 'default');

		if (!svg || svg.indexOf('<svg') === -1) {
			logService.error('[' + logTag + '] renderToSvg returned empty/invalid SVG');
			return;
		}

			// 构建完整 HTML 页面（含 SVG + 暗色主题适配 + 缩放控制）
			const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title || '图表预览')}</title>
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; background: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${isDark ? '#cccccc' : '#333333'}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.header { flex: none; padding: 6px 12px; background: ${isDark ? '#252525' : '#f3f3f3'}; border-bottom: 1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}; display: flex; align-items: center; gap: 12px; }
.header h1 { font-size: 13px; font-weight: 600; margin: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zoom-controls { display: flex; align-items: center; gap: 4px; font-size: 11px; color: ${isDark ? '#999' : '#666'}; }
.zoom-btn { cursor: pointer; padding: 2px 8px; border-radius: 4px; border: 1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}; background: transparent; color: inherit; font-size: 12px; line-height: 18px; }
.zoom-btn:hover { background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'}; }
.zoom-level { min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; cursor: pointer; user-select: none; }
.svg-container { flex: 1; overflow: auto; cursor: grab; }
.svg-container.panning { cursor: grabbing; }
.svg-stage { transform-origin: 0 0; user-select: none; -webkit-user-select: none; width: max-content; margin: 20px auto; }
.svg-stage svg { display: block; }
.hint { position: fixed; bottom: 8px; left: 50%; transform: translateX(-50%); font-size: 11px; opacity: 0.7; pointer-events: none; white-space: nowrap; color: #999; padding: 4px 10px; border-radius: 10px; background: rgba(0,0,0,0.3); }
.kb-wheel-hint { margin-left: 8px; padding: 3px 8px; font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); border: 1px solid rgba(128,128,128,0.25); border-radius: 4px; white-space: nowrap; user-select: none; cursor: help; }
</style>
</head>
<body>
<div class="header">
<h1>${escapeHtml(title || '图表预览')}</h1>
<div class="zoom-controls">
<button id="z-out" class="zoom-btn" title="缩小">−</button>
<span id="zoom-level" class="zoom-level" title="点击适应窗口">100%</span>
<button id="z-in" class="zoom-btn" title="放大">+</button>
<button id="z-fit" class="zoom-btn" title="适应窗口（双击画布同效）">适应</button>
<button id="z-100" class="zoom-btn" title="原始大小">1:1</button>
<span class="kb-wheel-hint" title="按住 Ctrl 并滚动鼠标滚轮可缩放">Ctrl + 滚轮 缩放</span>
</div>
</div>
<div class="svg-container" id="container">
<div class="svg-stage" id="stage">${svg.replace(/<\/script/gi, '<\\/script')}</div>
</div>
<div class="hint">拖拽 平移 · 双击 适应窗口 · 滚轮(按住 Ctrl) 缩放</div>
<script>
(function() {
	var container = document.getElementById('container');
	var stage = document.getElementById('stage');
	var svg = stage.querySelector('svg');
	var zoomLevel = document.getElementById('zoom-level');
	var scale = 1;
	var natW = 0, natH = 0;

	function measure() {
		if (!svg) { natW = container.clientWidth - 40; natH = container.clientHeight - 40; return; }
		var vb = svg.viewBox && svg.viewBox.baseVal;
		if (vb && vb.width > 0 && vb.height > 0) { natW = vb.width; natH = vb.height; return; }
		try {
			var bb = svg.getBBox();
			if (bb.width > 0 && bb.height > 0) { natW = bb.width; natH = bb.height; return; }
		} catch (e) { /* ignore */ }
		var r = svg.getBoundingClientRect();
		natW = (r.width / scale) || 800; natH = (r.height / scale) || 600;
	}

	function apply() {
		if (!svg) { zoomLevel.textContent = '—'; return; }
		svg.style.width = Math.round(natW * scale) + 'px';
		svg.style.height = Math.round(natH * scale) + 'px';
		stage.style.width = Math.round(natW * scale) + 'px';
		stage.style.height = Math.round(natH * scale) + 'px';
		zoomLevel.textContent = Math.round(scale * 100) + '%';
	}

	function zoomAt(factor, anchorX, anchorY) {
		var old = scale;
		scale = Math.max(0.05, Math.min(8, scale * factor));
		if (scale === old) { return; }
		var r1 = stage.getBoundingClientRect();
		var useAnchor = (anchorX !== undefined);
		var ax = useAnchor ? anchorX : r1.left + r1.width / 2;
		var ay = useAnchor ? anchorY : r1.top + r1.height / 2;
		var contentX = (ax - r1.left) / old, contentY = (ay - r1.top) / old;
		apply();
		var r2 = stage.getBoundingClientRect();
		container.scrollLeft += (contentX * scale + r2.left) - ax;
		container.scrollTop += (contentY * scale + r2.top) - ay;
	}

	function fit() {
		measure();
		var pad = 40;
		var s = Math.min((container.clientWidth - pad) / natW, (container.clientHeight - pad) / natH);
		scale = Math.max(0.05, Math.min(8, Math.min(s, 1) || 1));
		apply();
		container.scrollLeft = Math.max(0, (stage.scrollWidth - container.clientWidth) / 2);
		container.scrollTop = Math.max(0, (stage.scrollHeight - container.clientHeight) / 2);
	}

	function reset100() { zoomAt(1 / scale); }

	document.getElementById('z-in').addEventListener('click', function() { zoomAt(1.25); });
	document.getElementById('z-out').addEventListener('click', function() { zoomAt(0.8); });
	document.getElementById('z-fit').addEventListener('click', fit);
	document.getElementById('z-100').addEventListener('click', reset100);
	zoomLevel.addEventListener('click', fit);

	container.addEventListener('wheel', function(e) {
		if (!e.ctrlKey && !e.metaKey) { return; }
		e.preventDefault();
		zoomAt(e.deltaY > 0 ? 0.9 : 1.111, e.clientX, e.clientY);
	}, { passive: false });

	var dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
	container.addEventListener('mousedown', function(e) {
		if (e.button !== 0) { return; }
		dragging = true; sx = e.clientX; sy = e.clientY; sl = container.scrollLeft; st = container.scrollTop;
		container.classList.add('panning');
		e.preventDefault();
	});
	window.addEventListener('mousemove', function(e) {
		if (!dragging) { return; }
		container.scrollLeft = sl - (e.clientX - sx);
		container.scrollTop = st - (e.clientY - sy);
	});
	window.addEventListener('mouseup', function() { dragging = false; container.classList.remove('panning'); });
	container.addEventListener('dblclick', fit);

	fit();
})();
</script>
</body>
</html>`;

			// 2026-09-05 修复「图表预览标签内容空白」：此前用 UntitledTextEditorInput
			// 打开 HTML 源码，但 HtmlFileEditorPane 的 matcher 只注册了 FileEditorInput /
			// HtmlPreviewEditorInput（contribution.ts:926-936）—— untitled 输入不在其中，
			// 落回默认文本编辑器且无法渲染页面 → 标签打开后空白。
			// 改用项目统一的「内存 HTML → 编辑器区」通道（同 chat Apply
			// chatEditorIntegration.ts:153-157）：HtmlPreviewEditorInput 携带
			// htmlContent + 虚拟 saros-html-preview URI（不落盘），由
			// HtmlFileEditorPane 的 preview webview 渲染完整页面（含缩放控制脚本），
			// 并自动获得 编辑/HTML/预览 三态切换。
			// 内容哈希去重：同图复用已有标签（HtmlPreviewEditorInput.matches 按
			// resource URI 匹配 → openEditor 激活已有 tab 而非创建新 tab）。
			const diagramId = diagramContentHash(contentKey);
			const virtualUri = URI.from({ scheme: 'saros-html-preview', path: `/diagram-preview/${diagramId}.html` });
			const input = new HtmlPreviewEditorInput(
				virtualUri,
				title || '图表预览',
				undefined, undefined, undefined, undefined,
				html,
			);

			// ★★ 2026-09-16：**必须显式指定目标组 = 中间栏（mainPart）**。
			//
			// 工具卡片右上角的「查看文件」链接（`agentChatPanel.mermaidCard.ts:154`
			// 与 drawioCard 的同名控件）是在**聊天面板内部**被点击的 ⇒ 此刻的
			// 「活动编辑器组」正是聊天框所在的 agentPart 组 ⇒ 不指定 group 的
			// `openEditor` 会把预览标签**开进聊天区、覆盖聊天面板**（用户要求：
			// 「点击查看文件，要求在中间栏文件编辑器中打开，不允许在聊天框窗口中打开」）。
			//
			// 与 `chatEditorIntegration._openInMainColumn` / `nativeChatEditorPane._openInMainColumn`
			// 同口径：sessions 布局下 mainPart = 中间栏主编辑器，agentPart = 右侧聊天区。
			// 独立窗口（aux part / popout）下没有 mainPart ⇒ 退回旧行为（只能落在该窗口
			// 的活动组）—— 与 chat 侧两个实现保持一致，避免两套口径分叉。
			const mainGroup = getMainPart(editorGroupsService)?.activeGroup;
			if (mainGroup) {
				await editorService.openEditor(input, { pinned: true }, mainGroup);
			} else {
				await editorService.openEditor(input, { pinned: true });
			}
			logService.info('[' + logTag + '] opened in editor tab:', title || '(untitled)',
				mainGroup ? '(target=mainPart 中间栏)' : '(target=activeGroup — 无 mainPart，独立窗口)');
		} catch (err) {
			logService.error('[' + logTag + '] failed:', err instanceof Error ? err.message : String(err));
		}
}

// 2026-09-05：命令由 `_mermaid-chat.openPreview` 改名为 `_mermaid-chat.openPreviewHost`——
// extensions/mermaid-chat-features/src/extension.ts:38 注册了**同名**命令（扩展激活晚于
// workbench contribution 顶层注册，executeCommand 实际执行的是扩展版），扩展版走
// vscode.window.createWebviewPanel（OverlayWebview 路径）——本项目 fork 的 Chromium 上
// 该路径渲染空白（见 htmlPreviewEditorInput.ts 头注释），且其 HTML 的 .mermaid 初始
// visibility:hidden，渲染脚本失败即永远空白。改名绕开冲突，强制走本文件的
// openDiagramPreview（HtmlPreviewEditorInput 内存 HTML 通道，渲染可靠）。
CommandsRegistry.registerCommand(
	'_mermaid-chat.openPreviewHost',
	async (accessor: ServicesAccessor, markup: string, title?: string) => {
		if (!markup || !markup.trim()) {
			accessor.get(ILogService).warn('[MermaidOpenPreview] markup is empty, skipping');
			return;
		}
		const renderer = accessor.get(IMermaidInlineRenderer);
		const normalized = markup.replace(/\\n/g, '\n');
		await openDiagramPreview(
			accessor,
			theme => renderer.renderToSvg(normalized, theme),
			title,
			'MermaidOpenPreview',
			normalized,
		);
	},
);

CommandsRegistry.registerCommand(
	'_drawio-chat.openPreview',
	async (accessor: ServicesAccessor, source: string, title?: string) => {
		if (!source || !source.trim()) {
			accessor.get(ILogService).warn('[DrawioOpenPreview] source is empty, skipping');
			return;
		}
		const renderer = accessor.get(IDrawioInlineRenderer);
		await openDiagramPreview(
			accessor,
			theme => renderer.renderToSvg(source, theme),
			title,
			'DrawioOpenPreview',
			source,
		);
	},
);

/** 转义 HTML 特殊字符，防止 XSS */
function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

class BuiltinCapabilityContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.builtinCapabilities';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMcpService private readonly mcpService: IMcpService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		// Touch ISkillRegistry so the singleton is created and starts its filesystem
		// scan early — `_skillRegistry` is otherwise unused here, but the service
		// becomes addressable through DI everywhere else (slash commands, UI,
		// PlanningProvider) once it has been instantiated at least once.
		@ISkillRegistry _skillRegistry: ISkillRegistry,
	) {
		super();

		if (!configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

		this._registerBuiltinTools();
		this._registerMcpTools();
		// SessionMemoryProvider 已废弃：记忆统一由 AgentMemoryProviderV2 提供
		// （extensions/agentmemory-memory，经网关宿主 + renderer 代理注册，priority=1000）。
		this._registerKanbanProvider();
	}

	private _registerBuiltinTools(): void {
		try {
			this.logService.info('[BuiltinCapability] _registerBuiltinTools: creating BuiltinToolProvider instance...');
			const provider = this._register(this.instantiationService.createInstance(BuiltinToolProvider));
			this.logService.info('[BuiltinCapability] _registerBuiltinTools: BuiltinToolProvider instance created, registering to AgentOS...');
			// priority 50 — 让运行时由扩展注入的 ToolProvider（typically priority 100+）能覆盖。
			this._register(this.agentOSService.registerToolProvider(provider, 50));
			this.logService.info('[BuiltinCapability] BuiltinToolProvider registered successfully');
		} catch (err) {
			this.logService.error('[BuiltinCapability] BuiltinToolProvider registration failed', err);
		}
	}

	private _registerMcpTools(): void {
		try {
			const provider = this._register(new McpToolProvider(this.mcpService, this.logService));
			// priority 70 — MCP 工具普遍是用户主动配置的，应该优先于内置。
			this._register(this.agentOSService.registerToolProvider(provider, 70));
			this.logService.info('[BuiltinCapability] McpToolProvider registered');
		} catch (err) {
			this.logService.error('[BuiltinCapability] McpToolProvider registration failed', err);
		}
	}

	private _registerKanbanProvider(): void {
		try {
			// 委托给已稳定运行的 AgentTaskBoardService（共享同一份 taskboard.json），
			// 激活此前从未被注册的 IKanbanProvider 抽象槽。
			const provider = new JsonFileKanbanProvider(this.taskBoardService, this.logService);
			this._register(provider);
			this._register(this.agentOSService.registerKanbanProvider(provider, 50));
			this.logService.info('[BuiltinCapability] JsonFileKanbanProvider registered');
		} catch (err) {
			this.logService.error('[BuiltinCapability] JsonFileKanbanProvider registration failed', err);
		}
	}
}

registerWorkbenchContribution2(BuiltinCapabilityContribution.ID, BuiltinCapabilityContribution, WorkbenchPhase.AfterRestored);

// --- Auto-open Skill Detail after Install ----------------------------------
// 安装（或复制）新技能成功后，自动在 ResourceManagerEditorPane 打开其详情页。
class SkillInstallAutoOpenContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.skillInstallAutoOpen';

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ISkillInstallService private readonly skillInstallService: ISkillInstallService,
	) {
		super();
		this._register(
			this.skillInstallService.onDidInstallSkill(({ skillId }) => {
				const input = ResourceManagerEditorInput.getInstance();
				this.editorService.openEditor(input, { pinned: true }).then((pane) => {
					const control = pane?.getControl();
					if (control instanceof ResourceManagerEditorPane) {
						control.showDetailOnly('skill', skillId);
					}
				});
			})
		);
	}
}

registerWorkbenchContribution2(SkillInstallAutoOpenContribution.ID, SkillInstallAutoOpenContribution, WorkbenchPhase.AfterRestored);

// --- ExecutionProvider Registration (default non-stub) ------------------------
// 注册内置的 ExecutionProvider（实现真实 LLM 调用的 agent loop）。
// 没有这个 contribution 时，唯一注册进来的 ExecutionProvider 只有
// extensions/execution-example 的 shell 实现（priority=50），它会
// 抢占真正的执行路径，导致每个 task 在 19ms 内就 "完成"。
import { ExecutionProviderContribution } from './providers/execution/executionProviderService.js';
registerWorkbenchContribution2(ExecutionProviderContribution.ID, ExecutionProviderContribution, WorkbenchPhase.AfterRestored);

// --- Agent Capability Plugin Activation ------------------------------------------
// Discovers and activates IAgentCapabilityPlugin extensions from TWO sources:
//
// 1. Built-in plugins: capability-plugins.js manifest generated at build time
//    by scanning extensions/*/package.json for agentCapabilities declarations.
//
// 2. Third-party installed plugins: ANY VS Code extension that declares
//    "contributes.agentCapabilities" in its package.json is auto-discovered
//    at runtime via the VS Code Extension Point system. No rebuild needed.

import { IAgentOSPluginContext, IAgentCapabilityPlugin } from '../common/adapters.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AgentCapabilitiesExtensionPointRegistry, IResolvedCapabilityPlugin } from './agentCapabilitiesExtensionPoint.js';
import { FileAccess, type AppResourcePath } from '../../../../base/common/network.js';

/**
 * Shape of each entry in the build-generated capability-plugins.js manifest.
 * Used for built-in plugins that ship with the product.
 */
interface ICapabilityPluginManifestEntry {
	id: string;
	name: string;
	version: string;
	module: string;
	capabilities: Array<{ capability: string; provider: string; priority?: number }>;
	exportClass?: string;
	/**
	 * Optional fallback resource path (relative to the app root, in the
	 * `AppResourcePath` shape understood by `FileAccess.asBrowserUri`).
	 * When the primary `module` import fails -- typically because
	 * `npm run transpile-client` has not produced `out/vs/extensions/...` --
	 * the activator imports this resource instead. The path must point at a
	 * file that already exists on disk (e.g. an extension-local
	 * `dist/extension.js` built by the extension's own `tsc`).
	 */
	appResource?: AppResourcePath;
}

/**
 * Discovers and activates IAgentCapabilityPlugin extensions from two sources:
 *
 * Source 1 -- Built-in plugins (build-time manifest):
 * "capability-plugins.js" generated by "build/next/index.ts" scanning
 * "extensions/STAR/package.json". These are bundled with the product.
 *
 * Source 2 -- Third-party plugins (Extension Point):
 * Any VS Code extension installed from marketplace (or sideloaded) that
 * declares "contributes.agentCapabilities" in its package.json.
 * Discovered at runtime via the VS Code Extension Point system --
 * no rebuild required, supports hot install/uninstall.
 */
class AgentCapabilityPluginContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.agentCapabilityPlugins';

	private readonly _activatedPlugins = new Map<string, IAgentCapabilityPlugin>();
	private _extensionPointRegistry: AgentCapabilitiesExtensionPointRegistry | undefined;
	/** 网关地址认领的完成信号（见 `_injectAgentMemoryEndpoint()`）。两条插件激活路径都要 await 它。 */
	private _agentMemoryEndpointReady: Promise<void> | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super();

		if (!this.configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

		// ★ 与插件激活**并行**尽早启动「网关地址认领」。两条激活路径在真正 activate 插件前
		//   都会 await 它 —— agentmemory 走的是 Source 2（Extension Point），只 await Source 1 挡不住。
		this._agentMemoryEndpointReady = this._injectAgentMemoryEndpoint();
		// Source 1: built-in plugins from build-time manifest
		this._activateBuiltInPlugins();
		// Source 2: third-party plugins via VS Code Extension Point
		this._watchExtensionPointPlugins();
	}

	// Build-generated manifest (relative path from this file in out/)
	private static readonly MANIFEST_MODULE = '../../../../extensions/capability-plugins.js';

	/**
	 * Fallback manifest: hardcoded list of capability plugins shipped with the
	 * product. Used when `capability-plugins.js` is missing (e.g. dev sessions
	 * where only `npm run compile` was run, without `npm run transpile-client`).
	 *
	 * Each entry mirrors what `build/next/index.ts:discoverCapabilityPlugins()`
	 * would produce for the matching extension. The `module` path is relative
	 * to this file's location in `out/` (i.e. resolved from
	 * `out/vs/sessions/contrib/agentStudio/browser/`).
	 *
	 * Add new built-in capability plugins here whenever they are dropped into
	 * `extensions/<name>/`; the build pipeline still owns the canonical
	 * manifest, this list only ensures dev-mode parity.
	 *
	 * NOTE: every fallback also declares `appResource` -- the path to a
	 * pre-built artifact that already exists on disk under the app root
	 * (e.g. `extensions/<id>/dist/extension.js` produced by the extension's
	 * own `tsc` step). When the manifest-relative `module` import fails
	 * because `out/vs/extensions/<id>/...` was not generated yet, the
	 * activator falls back to importing the `appResource` via
	 * `FileAccess.asBrowserUri` -- this works in renderer because the
	 * resulting `vscode-file://vscode-app/...` URL is allowed by Electron's CSP.
	 */
	// NOTE: codebuddy-provider（以及已下线的 knot-agui）不在此列表，原因是：
	//   1. They are CJS modules (cannot be loaded via ESM import() in the renderer)
	//   2. They export activate/deactivate (not a Plugin class) — _resolvePluginClass would fail
	//   3. They are already registered as ModelProviders via LMBridge
	//      (languageModelChatProviders contribution → LanguageModelsToAgentOSBridge)
	//   4. Their agentCapabilities contribution was removed from package.json to
	//      prevent the extension-point path from attempting a futile renderer-side load.
	private static readonly BUILTIN_FALLBACK_MANIFEST: ICapabilityPluginManifestEntry[] = [
		{
			// agentmemory：替代 AgentMemory 的新记忆框架。
			// 通过 POST /observe 记录观察，POST /remember 保存长期记忆，
			// POST /smart-search 做 BM25+Vector+Graph 混合搜索。
			//
			// 记忆统一入口：SessionMemoryProvider 已废弃，本 provider 是唯一
			// 记忆来源（扩展 activate 时以 priority=1000 注册）。
			//
			// agentmemory server 由主进程 startAgentMemoryGateway() 启动；端口**不再写死**
			// 3111 —— 主进程 `_resolveAgentMemoryPort()` 按 app 形态派生（安装版 3111 / dev 3112）。
			// 渲染侧**读不到 process.env**（渲染进程无 process）⇒ 由本文件的
			// `_injectAgentMemoryEndpoint()` 按 dataDir 认领后写 `globalThis.__SAROS_AGENTMEMORY_URL__`。
			id: 'agentmemory-memory',
			name: 'AgentMemory',
			version: '1.0.0',
			module: '../../../../extensions/agentmemory-memory/src/extension.js',
			appResource: 'vs/../../extensions/agentmemory-memory/dist/extension.js',
			capabilities: [
				{ capability: 'memory', provider: 'agentmemory', priority: 90 },
			],
		},
		// agentmemory-gateway 不再走 AgentCapability 路径——它走 VSCode 扩展宿主，
		// 由 vscode 主框架在 builtInExtensions 加载时直接 activate，避免 bare specifier
		// "vscode" / "fs" 等无法在渲染端 ESM 解析导致的启动失败。
	];

	// --- Source 1: Built-in plugins (build-time manifest) -------------------

	/**
	 * 把本窗口应使用的 agentmemory 网关地址**注入渲染侧**（2026-09-19 真机验证后落地）。
	 *
	 * 背景：渲染进程里**没有 `process`**（CDP 实测 workbench 渲染上下文 `hasProcess:false`）
	 * ⇒ 主进程写在 `process.env.AGENTMEMORY_URL` 的端口**渲染侧根本读不到**；且
	 * `INativeEnvironmentService.isBuilt`（= `!env['VSCODE_DEV']`）在渲染侧**恒为 true**
	 * ⇒ 「按 dev 推导端口」这条兜底同样是死的。于是渲染侧只能"逐个端口猜"，而只要
	 * 另一个形态（安装版 3111）在监听，dev 就会**先猜中它并锁定它** ⇒ 跨环境串味。
	 *
	 * 解法：**不猜端口，按数据目录认领** —— 本窗口的 `userDataPath` 决定它该连哪份数据。
	 *   · 探到 `dataDir` 与本窗口一致 ⇒ 写 `__SAROS_AGENTMEMORY_URL__`（扩展优先使用它）
	 *   · 探到 `dataDir` 与本窗口**不一致** ⇒ 记入 `__SAROS_AGENTMEMORY_FOREIGN__`
	 *     （扩展会把这些地址**从候选里排除** —— 宁可探测失败也不连错库）
	 * ⚠ 与主进程 `_probeOrSpawnAgentMemoryGateway()` 的 dataDir 比对**同源**，语义一致。
	 * ⚠ 必须在 capability plugin（agentmemory 扩展）`activate()` **之前**完成，故由
	 *   `_activateBuiltInPlugins()` 开头 `await`。探测失败（网关仍在重建索引 ~4s）不算错：
	 *   此刻除异己外没有别的候选，扩展侧退避探测自然会命中自己的网关。
	 */
	private async _injectAgentMemoryEndpoint(): Promise<void> {
		const g = globalThis as {
			__SAROS_AGENTMEMORY_URL__?: string;
			__SAROS_AGENTMEMORY_FOREIGN__?: string[];
		};
		if (typeof g.__SAROS_AGENTMEMORY_URL__ === 'string' && g.__SAROS_AGENTMEMORY_URL__.length > 0) {
			return; // 本窗口只注入一次
		}
		const userDataPath = (this.environmentService as INativeEnvironmentService).userDataPath;
		const wantDataDir = this._normalizeFsPath(`${userDataPath}/.agentmemory`);
		const foreign: string[] = [];
		// 候选端口与主进程 `_resolveAgentMemoryPort()` 同规则：安装版 3111 / dev 3112。
		for (const base of ['http://127.0.0.1:3111', 'http://127.0.0.1:3112']) {
			try {
				const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
				if (!res.ok) {
					continue;
				}
				const body = await res.json() as { dataDir?: string };
				if (typeof body?.dataDir !== 'string' || body.dataDir.length === 0) {
					continue;
				}
				if (this._normalizeFsPath(body.dataDir) === wantDataDir) {
					g.__SAROS_AGENTMEMORY_URL__ = base;
					g.__SAROS_AGENTMEMORY_FOREIGN__ = foreign;
					this.logService.info(`[AgentMemory] 网关地址已认领: ${base}（dataDir 与本窗口一致: ${body.dataDir}）`);
					return;
				}
				foreign.push(base);
				this.logService.warn(
					`[AgentMemory] ${base} 上的网关属于**其他数据目录**（${body.dataDir}），本窗口是 ${wantDataDir} `
					+ '⇒ 排除该地址（避免记忆读写串到另一形态的库）',
				);
			} catch { /* 端口空闲 / 超时 ⇒ 只是还没起来，不算异己 */ }
		}
		g.__SAROS_AGENTMEMORY_FOREIGN__ = foreign;
		this.logService.info(
			`[AgentMemory] 暂未认领到网关（本窗口 dataDir=${wantDataDir}；已排除 ${foreign.length} 个异己地址）—— 交由扩展侧候选探测`,
		);
	}

	/** Windows 路径大小写不敏感、分隔符可能混用 ⇒ 归一化后比较（同主进程 `_isSamePath`）。 */
	private _normalizeFsPath(p: string): string {
		return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	}

	private async _activateBuiltInPlugins(): Promise<void> {
		// 必须等注入完成（constructor 里已启动）—— ⚠ 这里**不要**再调一次
		// `_injectAgentMemoryEndpoint()`：那会多跑一轮 /health 探测（实测表现为
		// "已认领"日志出现两次）。两条激活路径统一 await 同一个 Promise。
		await this._agentMemoryEndpointReady;
		this.logService.info(
			`[AgentCapabilityPlugins][Diag] _activateBuiltInPlugins() start; manifestModule=${AgentCapabilityPluginContribution.MANIFEST_MODULE}`,
		);
		let manifest: ICapabilityPluginManifestEntry[] = [];
		let manifestLoaded = false;
		try {
			const manifestModule = await import(AgentCapabilityPluginContribution.MANIFEST_MODULE);
			manifest = manifestModule.plugins ?? [];
			manifestLoaded = true;
			this.logService.info(
				`[AgentCapabilityPlugins] Built-in manifest loaded: ${manifest.length} plugin(s) `
				+ `[ids=${manifest.map(p => p.id).join(',') || '<none>'}]`,
			);
		} catch (err) {
			this.logService.warn(
				'[AgentCapabilityPlugins] Failed to load capability-plugins.js manifest. '
				+ 'Falling back to hardcoded plugin list (dev mode). '
				+ 'For production, run "npm run transpile-client" to regenerate the manifest from extensions/*/package.json.',
				err,
			);
		}

		// Merge in any fallback-listed plugins that the manifest does not already
		// cover. This guarantees that dropping in a new extension/<name> directory
		// without re-running the full build still surfaces it in the chat
		// provider selector during development.
		const knownIds = new Set(manifest.map(m => m.id));
		const injected: string[] = [];
		for (const fallback of AgentCapabilityPluginContribution.BUILTIN_FALLBACK_MANIFEST) {
			if (!knownIds.has(fallback.id)) {
				manifest.push(fallback);
				injected.push(fallback.id);
			}
		}
		if (injected.length > 0) {
			this.logService.info(
				`[AgentCapabilityPlugins][Diag] Fallback injected (manifestLoaded=${manifestLoaded}): ${injected.join(', ')}`,
			);
		}

		this.logService.info(
			`[AgentCapabilityPlugins][Diag] Final manifest size=${manifest.length}; about to activate each entry`,
		);
		for (const entry of manifest) {
			// ★ 跳过 *-example 系列示例插件（2026-09-07）：capability 示例（priority 50、CI 已跳过）
			//   属死代码，激活只会产生无用的 disposable 实例（日志可见
			//   [LEAKED DISPOSABLE] ExecutionExamplePlugin），还占激活耗时。
			if (/example/i.test(entry.id)) {
				this.logService.info(`[AgentCapabilityPlugins][Diag] skip example plugin: ${entry.id}`);
				continue;
			}
			if (this._activatedPlugins.has(this._normalizePluginId(entry.id))) {
				this.logService.info(`[AgentCapabilityPlugins][Diag] ${entry.id} already activated -- skip`);
				continue;
			}
			await this._activateFromManifestEntry(entry);
		}
		this.logService.info(
			`[AgentCapabilityPlugins][Diag] _activateBuiltInPlugins() done; activated ids=`
			+ `${Array.from(this._activatedPlugins.keys()).join(',') || '<none>'}`,
		);
	}

	private async _activateFromManifestEntry(entry: ICapabilityPluginManifestEntry): Promise<void> {
		this.logService.info(
			`[AgentCapabilityPlugins][Diag] activating "${entry.id}" -- import("${entry.module}")`,
		);
		let pluginModule: any;
		let importedFrom = entry.module;
		try {
			pluginModule = await import(entry.module);
		} catch (err) {
			const e = err as any;
			const errMsg = e?.message ?? String(err);

			// CommonJS modules cannot be loaded via ESM import() in the renderer.
			// This is expected for extensions built as CJS — downgrade to info.
			if (this._isCjsModuleError(errMsg)) {
				this.logService.info(
					`[AgentCapabilityPlugins] ${entry.id} is a CommonJS module — skipped (cannot load via ESM import() in renderer).`,
				);
				return;
			}

			this.logService.warn(
				`[AgentCapabilityPlugins][Diag] Primary import() failed for ${entry.id} (module=${entry.module}). `
				+ `Error: ${errMsg}`,
			);

			// Fallback: try the app-resource path (extensions/<id>/dist/extension.js)
			// converted to a vscode-file:// URL via FileAccess. This works in dev
			// mode without `npm run transpile-client`.
			if (entry.appResource) {
				try {
					const browserUri = FileAccess.asBrowserUri(entry.appResource);
					const fallbackUrl = browserUri.toString(true);
					this.logService.info(
						`[AgentCapabilityPlugins][Diag] Trying appResource fallback for ${entry.id}: ${fallbackUrl}`,
					);
					pluginModule = await import(fallbackUrl);
					importedFrom = fallbackUrl;
				} catch (err2) {
					const e2 = err2 as any;
					const err2Msg = e2?.message ?? String(err2);

					// CommonJS fallback also fails — same CJS-in-renderer issue
					if (this._isCjsModuleError(err2Msg)) {
						this.logService.info(
							`[AgentCapabilityPlugins] ${entry.id} appResource is also CommonJS — skipped.`,
						);
						return;
					}

					this.logService.warn(
						`[AgentCapabilityPlugins][Diag] Fallback import() also failed for ${entry.id} `
						+ `(appResource=${entry.appResource}). `
						+ `Error: ${err2Msg}\nStack: ${e2?.stack ?? '<no stack>'}\n`
						+ `Hint: ensure either "npm run transpile-client" was run (produces out/vs/extensions/${entry.id}/src/extension.js) `
						+ `or the extension itself has been built (produces extensions/${entry.id}/dist/extension.js).`,
					);
					return;
				}
			} else {
				this.logService.warn(
					`[AgentCapabilityPlugins][Diag] No appResource fallback declared for ${entry.id}. `
					+ `Run "npm run transpile-client" to generate the manifest artifact, or add an appResource path to the fallback manifest.\n`
					+ `Stack: ${e?.stack ?? '<no stack>'}`,
				);
				return;
			}
		}

		try {
			const exportedKeys = Object.keys(pluginModule || {});
			this.logService.info(
				`[AgentCapabilityPlugins][Diag] ${entry.id} module loaded from ${importedFrom}; `
				+ `exports=[${exportedKeys.join(', ') || '<empty>'}] exportClass=${entry.exportClass ?? '<auto>'}`,
			);
			const PluginClass = this._resolvePluginClass(pluginModule, entry.exportClass);

			if (!PluginClass) {
				this.logService.warn(
					`[AgentCapabilityPlugins] No plugin class found in ${entry.id} (importedFrom: ${importedFrom}). `
					+ `Module exports: [${exportedKeys.join(', ') || '<empty>'}]. `
					+ `Expected a class whose name ends with "Plugin", a "default" export, `
					+ `or an explicit \`exportClass\` field in the manifest entry.`,
				);
				return;
			}

			const context = this._createPluginContext('');
			// Plugins are created via the InstantiationService so a no-arg
			// constructor (like KnotAguiPlugin) works. IMPORTANT: third-party
			// plugins must NOT declare co-constructor DI for host services such as
			// `@IAgentOSService`. Because the plugin module is loaded from a separate
			// module realm (its own copy of agentOS.js from OUT), the service
			// identifier object differs from the one registered via registerSingleton
			// in the host bundle, so createInstance() throws
			// "UNKNOWN service agentOSService". Plugins must obtain the live service
			// through `context.agentOSService` inside activate() instead.
			const plugin = this.instantiationService.createInstance(PluginClass as any);
			await plugin.activate(context);
			this._activatedPlugins.set(this._normalizePluginId(entry.id), plugin);
			this.logService.info(
				'[AgentCapabilityPlugins] Built-in: ' + entry.name + ' (' + entry.id + '@' + entry.version + ') activated'
				+ ' -- capabilities: ' + entry.capabilities.map(c => c.capability).join(', '),
			);
		} catch (err) {
			const e = err as any;
			this.logService.warn(
				`[AgentCapabilityPlugins] Built-in ${entry.id} activation failed: `
				+ `${e?.message ?? String(err)}\nStack: ${e?.stack ?? '<no stack>'}`,
			);
		}
	}

	// --- Source 2: Third-party plugins (Extension Point) --------------------

	/**
	 * Watch the "contributes.agentCapabilities" extension point for
	 * dynamically installed/uninstalled third-party extensions.
	 *
	 * This is how marketplace-installed providers are auto-discovered
	 * WITHOUT any hardcoding or rebuild.
	 */
	private _watchExtensionPointPlugins(): void {
		this._extensionPointRegistry = this._register(
			new AgentCapabilitiesExtensionPointRegistry(this.logService),
		);

		// React to extensions being added/removed at runtime
		this._register(this._extensionPointRegistry.onDidChange(async ({ added, removed }) => {
			// Deactivate removed plugins
			for (const plugin of removed) {
				await this._deactivatePlugin(plugin.extensionId);
			}

			// Activate newly discovered plugins
			for (const plugin of added) {
				if (this._activatedPlugins.has(this._normalizePluginId(plugin.extensionId))) {
					this.logService.info(`[AgentCapabilityPlugins] ${plugin.extensionId} already active (built-in), skipping`);
					continue;
				}
				await this._activateFromExtensionPoint(plugin);
			}
		}));

		// Also activate any already-discovered plugins (extensions loaded before us)
		const existing = this._extensionPointRegistry.getAll();
		if (existing.length > 0) {
			this.logService.info(`[AgentCapabilityPlugins] Extension point: ${existing.length} plugin(s) already discovered`);
			for (const plugin of existing) {
				if (!this._activatedPlugins.has(this._normalizePluginId(plugin.extensionId))) {
					this._activateFromExtensionPoint(plugin);
				}
			}
		}
	}

	private async _activateFromExtensionPoint(resolved: IResolvedCapabilityPlugin): Promise<void> {
		// ★ 与 Source 1 同理：扩展 activate() 里会**立刻**探活，此刻"禁连地址（异己数据目录）"
		//   必须已经写在 globalThis 上。实测教训（2026-09-19）：原先只把 await 放在 Source 1，
		//   而 agentmemory 由本路径激活 ⇒ 扩展 17:08:42.6 已开始激活、注入 17:08:44.2 才完成，
		//   靠扩展侧退避重试才侥幸连对 3112（若 3111 上有健康网关就会先连错并锁定）。
		await this._agentMemoryEndpointReady;
		this.logService.info(
			`[AgentCapabilityPlugins][Diag] ExtensionPoint activate -- id=${resolved.extensionId} `
			+ `path=${resolved.extensionPath} mainModule=${resolved.mainModule || '<empty>'}`,
		);
		if (!resolved.mainModule) {
			this.logService.warn(`[AgentCapabilityPlugins] Extension ${resolved.extensionId} has no main module -- skipping`);
			return;
		}

		let pluginModule: any;
		try {
			pluginModule = await import(resolved.mainModule);
		} catch (err) {
			const e = err as any;
			const errMsg = e?.message ?? String(err);
			// CJS modules ("module/exports is not defined") and unbuilt extensions
			// ("Failed to fetch dynamically imported module") are expected in the
			// renderer — downgrade to a concise info log without stack trace.
			if (this._isCjsModuleError(errMsg) || this._isModuleNotFoundError(errMsg)) {
				this.logService.info(
					`[AgentCapabilityPlugins] ${resolved.extensionId} — skipped (cannot load via ESM import() in renderer: ${this._isCjsModuleError(errMsg) ? 'CJS module' : 'module not built'}).`,
				);
			} else {
				this.logService.warn(
					`[AgentCapabilityPlugins][Diag] import() failed for extension ${resolved.extensionId} `
					+ `(mainModule=${resolved.mainModule}). `
					+ `Error: ${errMsg}\nStack: ${e?.stack ?? '<no stack>'}`,
				);
			}
			return;
		}

		try {
			const exportedKeys = Object.keys(pluginModule || {});
			this.logService.info(
				`[AgentCapabilityPlugins][Diag] ${resolved.extensionId} module loaded; `
				+ `exports=[${exportedKeys.join(', ') || '<empty>'}]`,
			);
			const PluginClass = this._resolvePluginClass(pluginModule, undefined);

			if (!PluginClass) {
				this.logService.warn(
					`[AgentCapabilityPlugins] No plugin class found in extension ${resolved.extensionId}. `
					+ `Module exports: [${exportedKeys.join(', ') || '<empty>'}]. `
					+ `Hint: dist/extension.js must export a class whose name ends with "Plugin" `
					+ `(e.g. KnotAguiPlugin), or a default export.`,
				);
				return;
			}

			const context = this._createPluginContext(resolved.extensionPath);
			// Use createInstance so DI-constructor plugins resolve correctly.
			const plugin = this.instantiationService.createInstance(PluginClass as any);
			await plugin.activate(context);
			this._activatedPlugins.set(this._normalizePluginId(resolved.extensionId), plugin);

			this.logService.info(
				`[AgentCapabilityPlugins] Third-party: ${resolved.displayName} `
				+ `(${resolved.extensionId}@${resolved.version}) activated`
				+ ` -- capabilities: ${resolved.capabilities.map(c => c.capability).join(', ')}`,
			);
		} catch (err) {
			const e = err as any;
			this.logService.warn(
				`[AgentCapabilityPlugins] Third-party ${resolved.extensionId} activation failed: `
				+ `${e?.message ?? String(err)}\nStack: ${e?.stack ?? '<no stack>'}`,
			);
		}
	}

	/**
	 * 归一化插件 ID 用于去重：builtin manifest 用 `name`（如 `agentmemory-memory`），
	 * extension point 用 `publisher.name`（如 `saros.agentmemory-memory` 或
	 * `undefined_publisher.execution-example`）。取最后一段 `name` 作为统一去重 key，
	 * 避免同一插件因 publisher 前缀不同而被重复激活（曾导致 agentmemory 激活 3 次）。
	 */
	private _normalizePluginId(id: string): string {
		const idx = id.lastIndexOf('.');
		return idx >= 0 ? id.substring(idx + 1) : id;
	}

	private async _deactivatePlugin(pluginId: string): Promise<void> {
		const key = this._normalizePluginId(pluginId);
		const plugin = this._activatedPlugins.get(key);
		if (plugin) {
			try {
				await plugin.deactivate();
				this.logService.info(`[AgentCapabilityPlugins] Deactivated: ${pluginId}`);
			} catch (err) {
				this.logService.error(`[AgentCapabilityPlugins] Deactivation failed for ${pluginId}:`, err);
			}
			this._activatedPlugins.delete(key);
		}
	}

	// --- Shared helpers -----------------------------------------------------

	/**
	 * Detect whether an import() error is caused by attempting to load a
	 * CommonJS module via native ESM import() in the renderer. In the browser
	 * context, `module`, `exports`, and `require` are not defined, so CJS
	 * modules fail immediately with these ReferenceErrors.
	 */
	private _isCjsModuleError(errMsg: string): boolean {
		return errMsg.includes('module is not defined')
			|| errMsg.includes('exports is not defined')
			|| errMsg.includes('require is not defined');
	}

	/**
	 * Detect whether an import() error is caused by the module file not
	 * existing on disk (e.g. extension not yet compiled, `out/extension.js`
	 * missing). The browser ESM loader reports this as "Failed to fetch
	 * dynamically imported module".
	 */
	private _isModuleNotFoundError(errMsg: string): boolean {
		return errMsg.includes('Failed to fetch dynamically imported module')
			|| errMsg.includes('Cannot find module')
			|| errMsg.includes('ERR_FILE_NOT_FOUND');
	}

	/**
	 * Find the exported plugin class from a module.
	 * Convention:
	 * 1. If exportClass is specified, use that
	 * 2. Otherwise, find first export ending with 'Plugin'
	 * 3. Fall back to 'default' export
	 */
	private _resolvePluginClass(
		pluginModule: any,
		exportClass: string | undefined,
	): (new () => IAgentCapabilityPlugin) | undefined {
		if (exportClass && pluginModule[exportClass]) {
			return pluginModule[exportClass];
		}

		for (const key of Object.keys(pluginModule)) {
			if (key.endsWith('Plugin') && typeof pluginModule[key] === 'function') {
				return pluginModule[key];
			}
		}

		if (typeof pluginModule.default === 'function') {
			return pluginModule.default;
		}

		return undefined;
	}

	private _createPluginContext(extensionPath: string): IAgentOSPluginContext {
		return {
			extensionPath,
			globalStoragePath: '',
			workspaceStoragePath: '',
			configurationService: this.configurationService,
			logService: this.logService,
			notificationService: this.notificationService,
			instantiationService: this.instantiationService,
			agentOSService: this.agentOSService,
		};
	}

	override dispose(): void {
		for (const [id, plugin] of this._activatedPlugins) {
			plugin.deactivate().catch(err => {
				this.logService.error(`[AgentCapabilityPlugins] Plugin ${id} deactivation failed:`, err);
			});
			// Plugins are `Disposable` subclasses (all `*-example` plugins `extends Disposable`).
			// `deactivate()` only does business-level cleanup and never disposes the plugin
			// instance itself. Since these instances were created via `createInstance` here,
			// this contribution owns them — dispose them explicitly, otherwise
			// `GCBasedDisposableTracker` logs "[LEAKED DISPOSABLE]" when the instance is
			// GC'd without ever being disposed (most visible on window reload).
			(plugin as unknown as { dispose?: () => void }).dispose?.();
		}
		this._activatedPlugins.clear();
		super.dispose();
	}
}

registerWorkbenchContribution2(AgentCapabilityPluginContribution.ID, AgentCapabilityPluginContribution, WorkbenchPhase.AfterRestored);

// --- ViewContainer & Views Registration ------------------------------------------

class RegisterAgentStudioViewsContribution implements IWorkbenchContribution {
	static readonly ID = 'sessions.registerAgentStudioViews';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
	) {
		if (!configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

		// --- Layout Reference: Two-Column Layout ---------------------------------
		// [Saros] Two-column layout:
		//   Left: Sidebar (activity bar icons + content panel)
		//   Right: Editor Area (Agent Studio EditorPanes: Chat, TaskBoard, Canvas)
		//   AuxiliaryBar: Hidden by default (available for supplementary views)
		//   Bottom: Panel (optional, hidden by default)

		// NOTE: Agent Chat, Task Board, and Canvas are now registered as EditorPanes
		// (see AgentStudioEditorPane / AgentStudioEditorInput) and open in the editor area.

		// --- Toolbar Icons --- all 12 icons registered as separate sidebar containers
	}
}

registerWorkbenchContribution2(RegisterAgentStudioViewsContribution.ID, RegisterAgentStudioViewsContribution, WorkbenchPhase.BlockStartup);

// --- Toolbar Icons Contribution (12 independent icons) ----------------------

class AgentStudioToolbarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.agentStudioToolbar';

	constructor() {
		super();
		this._registerToolbarIcons();
	}

	private _registerToolbarIcons(): void {
		const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

		// --- ActivityBar icons (workspace → search → sourcecontrol → tasks → agents → workflow → integration → plugins) ---

		// 1. Workspace (order: 10) — uses the SAME native VS Code Explorer view
		//    as the sessions Files tab, with conditional view switching based on
		//    WorkspaceFolderCountContext (Explorer when folders exist, EmptyView otherwise).
		//    Uses manual registration (not _registerToolIcon) because the Explorer
		//    requires the conditional when-clause pattern from files.contribution.ts.
		{
			const container = viewContainerRegistry.registerViewContainer({
				id: 'agentStudio.workspace',
				title: localize2('agentStudio.workspace.title', "Workspace"),
				icon: workspaceIcon,
				ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['agentStudio.workspace', { mergeViewWithContainerWhenSingleView: true }]),
				storageId: 'agentStudio.workspace',
				hideIfEmpty: false,
				order: 10,
				windowEnablement: WindowEnablement.Both,
			}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

			// Explorer: shown when workspace folders exist
			viewsRegistry.registerViews([{
				id: AGENT_STUDIO_WORKSPACE_VIEW_ID,
				name: localize2('agentStudio.workspace.title', "Workspace"),
				ctorDescriptor: new SyncDescriptor(SessionsExplorerView),
				canToggleVisibility: false,
				canMoveView: false,
				when: ContextKeyExpr.and(WorkspaceFolderCountContext.notEqualsTo('0'), IsPhoneLayoutContext.negate()),
				windowEnablement: WindowEnablement.Both,
			}], container);

			// Empty state: shown when no workspace folders exist
			viewsRegistry.registerViews([{
				id: 'agentStudio.workspaceView.empty',
				name: localize2('agentStudio.workspace.title', "Workspace"),
				ctorDescriptor: new SyncDescriptor(SessionsExplorerEmptyView),
				canToggleVisibility: false,
				canMoveView: false,
				when: ContextKeyExpr.and(WorkspaceFolderCountContext.isEqualTo('0'), IsPhoneLayoutContext.negate()),
				windowEnablement: WindowEnablement.Both,
			}], container);
		}

		// 2. Search (order: 20) - [Saros] Reuse native VSCode SearchView with workspace selector
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.search',
			title: localize2('agentStudio.search.title', "Search"),
			icon: searchIcon,
			viewId: AGENT_STUDIO_SEARCH_VIEW_ID,
			order: 20,
			viewCtor: AgentStudioSearchViewPane,
		});

		// Note: SourceControl (order: 30) — registered in sourceControl.contribution.ts

		// Note: SourceControl (order: 30) — registered in sourceControl.contribution.ts
		// ── Separator after order 30 (workspace/search/sourcecontrol) ──
		// Session History (order: 50) — registered in sessionHistory.contribution.ts

		// 3. Agents (order: 60)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.presetAgent',
			title: localize2('agentStudio.presetAgent.title', "Agents"),
			icon: presetAgentIcon,
			viewId: AGENT_STUDIO_PRESET_AGENT_VIEW_ID,
			order: 60,
			viewCtor: PresetAgentViewPane,
		});

		// 4. Tasks (order: 70)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.tasks',
			title: localize2('agentStudio.tasks.title', "Tasks"),
			icon: tasksIcon,
			viewId: AGENT_STUDIO_TASKS_VIEW_ID,
			order: 70,
			viewCtor: TasksViewPane,
		});

		// 5. Workflow (order: 80)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.workflow',
			title: localize2('agentStudio.workflow.title', "Workflow"),
			icon: workflowIcon,
			viewId: AGENT_STUDIO_WORKFLOW_VIEW_ID,
			order: 80,
			viewCtor: WorkflowViewPane,
		});

		// 6. Integration (Skills + Tools + MCP, order: 90)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.integration',
			title: localize2('agentStudio.integration.title', "Integration"),
			icon: integrationIcon,
			viewId: AGENT_STUDIO_INTEGRATION_VIEW_ID,
			order: 90,
			viewCtor: IntegrationViewPane,
		});

		// Note: Memory (order: 100) — registered in memory.contribution.ts
		// Note: Knowledge Base (order: 110) — registered below

		// 7. Plugins (order: 120)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.plugins',
			title: localize2('agentStudio.plugins.title', "Plugins"),
			icon: pluginsIcon,
			viewId: AGENT_STUDIO_PLUGINS_VIEW_ID,
			order: 120,
			viewCtor: PluginsViewPane,
		});


		// --- Remaining icons (after Plugins) ---

		// Knowledge Base (order: 110)
		// 2026-09-11：左侧栏页签文案由「知识库」改为「资料库」（id/命令/存储键不变，
		// 避免破坏已有配置与命令注册；仅用户可见标题变化）。
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.knowledgeBase',
			title: localize2('agentStudio.knowledgeBase.title', "资料库"),
			icon: kbIcon,
			viewId: AGENT_STUDIO_KB_VIEW_ID,
			order: 110,
			viewCtor: KnowledgeBaseViewPane,
		});

		// Dashboard (order: 150) — Agent 运维监控面板
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.dashboard',
			title: localize2('agentStudio.dashboard.title', "Dashboard"),
			icon: Codicon.dashboard,
			viewId: AGENT_STUDIO_DASHBOARD_VIEW_ID,
			order: 150,
			viewCtor: AgentStudioDashboardViewPane,
		});

		// --- Bottom-aligned icons moved to SidebarFooter (see account.contribution.ts) --- //
	}

	private _registerToolIcon(
		viewContainerRegistry: IViewContainersRegistry,
		viewsRegistry: IViewsRegistry,
		config: {
			id: string;
			title: ILocalizedString;
			icon: ThemeIcon;
			viewId: string;
			order: number;
			viewCtor: new (...args: any[]) => any;
		}
	): void {
		// Register ViewContainer in Sidebar
		// [Saros] Use WindowEnablement.Both so icons show in both main window and sessions window
		const container = viewContainerRegistry.registerViewContainer({
			id: config.id,
			title: config.title,
			icon: config.icon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [config.id, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: config.id,
			hideIfEmpty: false,
			order: config.order,
			windowEnablement: WindowEnablement.Both,
		}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

		// Register View inside the container using the dedicated ViewPane class
		viewsRegistry.registerViews([{
			id: config.viewId,
			name: config.title,
			ctorDescriptor: new SyncDescriptor(config.viewCtor),
			canToggleVisibility: false,
			canMoveView: false,
			order: 0,
			windowEnablement: WindowEnablement.Both,
		}], container);
	}
}

registerWorkbenchContribution2(AgentStudioToolbarContribution.ID, AgentStudioToolbarContribution, WorkbenchPhase.BlockStartup);

// ─── Worktree Commands ──────────────────────────────────────────────────────
// Moved to `sessions/contrib/files/browser/files.contribution.ts` (the unified
// Explorer owns the worktree views, so it owns their commands too). Registering
// them here as well threw "Cannot register two commands with the same id:
// sessions.worktree.refresh" at startup and aborted the whole workbench load.
// Menu entries live in `sessions/contrib/sourceControl/browser/sourceControl.contribution.ts`.

// ─── Create Workspace (the title-bar "+" button) ────────────────────────────
const CREATE_WORKSPACE_COMMAND_ID = 'agentStudio.workspace.createWorkspace';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CREATE_WORKSPACE_COMMAND_ID,
			title: localize2('agentStudio.createWorkspace', "创建工作区"),
			icon: Codicon.newFolder,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const agentStudioService = accessor.get(IAgentStudioService);
		const fileDialogService = accessor.get(IFileDialogService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);

		// Open folder picker for the workspace home directory
		const picked = await fileDialogService.showOpenDialog({
			title: localize('createWorkspace.pickFolder', "选择工作区主目录"),
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: localize('createWorkspace.openLabel', "选择此文件夹"),
		});

		if (!picked || picked.length === 0) {
			return; // Cancelled
		}

		const homeUri = picked[0];
		const extUri = accessor.get(IUriIdentityService).extUri;
		const name = extUri.basenameOrAuthority(homeUri) || localize('createWorkspace.defaultName', "未命名工作区");

		// Confirm if the folder is non-empty
		try {
			const stat = await accessor.get(IFileService).resolve(homeUri);
			if (stat.isDirectory && stat.children && stat.children.length > 0) {
				const confirmed = await dialogService.confirm({
					type: 'info',
					message: localize('createWorkspaceNonEmpty', "所选文件夹已包含文件"),
					detail: localize('createWorkspaceNonEmptyDetail', "工作区元数据（.sarosworkspace）将写入该文件夹，与已有文件共存（不会删除或修改它们）。是否继续？"),
					primaryButton: localize('createWorkspaceContinue', "继续"),
				});
				if (!confirmed.confirmed) {
					return;
				}
			}
		} catch {
			// If we can't stat the folder, proceed anyway
		}

		try {
			const workspace = await agentStudioService.createWorkspace({ name, path: homeUri.fsPath });
			if (workspace) {
				await agentStudioService.setActiveWorkspace(workspace.id);
				notificationService.info(localize('createWorkspaceSuccess', "工作区 \"{0}\" 已创建", name));
			}
		} catch (err) {
			logService.error('[CreateWorkspace] Failed:', err);
			notificationService.error(localize('createWorkspaceError', "创建工作区失败: {0}", (err as Error)?.message ?? String(err)));
		}
	}
});

// ─── Add Related Folder (link a code repository to the active workspace) ─────
// NOTE: This command is intentionally NOT surfaced in the view title bar — the
// "+" button there creates a workspace (see above). Adding a related folder is
// still available via the inline "+" on each workspace-root row and the command
// palette.
const ADD_RELATED_FOLDER_COMMAND_ID = 'agentStudio.workspace.addRelatedFolder';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ADD_RELATED_FOLDER_COMMAND_ID,
			title: localize2('agentStudio.addRelatedFolder', "添加关联仓库"),
			icon: Codicon.add,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const agentStudioService = accessor.get(IAgentStudioService);
		const fileDialogService = accessor.get(IFileDialogService);
		const notificationService = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);

		// Resolve the target workspace
		const workspaces = await agentStudioService.getWorkspaces();
		if (workspaces.length === 0) {
			notificationService.warn(localize('addRelatedNoWorkspace', "请先创建一个工作区，再添加关联仓库。"));
			return;
		}
		const activeId = agentStudioService.getActiveWorkspaceId();
		const targetWs = (activeId ? workspaces.find(w => w.id === activeId) : undefined) ?? workspaces[0];
		if (!targetWs) {
			return;
		}

		// Pick a folder
		const picked = await fileDialogService.showOpenDialog({
			title: localize('addRelatedFolder.pickFolder', "选择要关联的代码仓库目录"),
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: localize('addRelatedFolder.openLabel', "关联此文件夹"),
		});

		if (!picked || picked.length === 0) {
			return; // Cancelled
		}

		const folderPath = picked[0].fsPath;
		const extUri = accessor.get(IUriIdentityService).extUri;

		try {
			await agentStudioService.addRelatedFolder(targetWs.id, folderPath);
			notificationService.info(localize('addRelatedDone', "已添加关联仓库: {0}", extUri.basenameOrAuthority(picked[0])));
		} catch (err) {
			logService.error('[AddRelatedFolder] Failed:', err);
			notificationService.error(localize('addRelatedError', "添加关联仓库失败: {0}", (err as Error)?.message ?? String(err)));
		}
	}
});

// ─── Workspace Selector & Create Button ─────────────────────────────────────
// The active-workspace dropdown and "create workspace" button now live in the
// top titlebar (right of the sidebar toggle button) — see
// `TitlebarPart._createWorkspaceToolbar`. The old title-bar selector and create
// button that used to sit in the workspace view's title have been removed to
// avoid duplicate controls.

// ─── Workspace Folder Sync ──────────────────────────────────────────────────
// Workspace folder synchronization for the active AgentStudio workspace is
// now handled independently by `WorkspaceFolderSyncContribution`
// (see workspaceFolderSync.ts), which updates VS Code native workspace folders
// whenever the active workspace changes. This drives the native Explorer view
// auto-refresh and works independently of Source Control.
//
// The legacy Source Control sync in `SourceControlWorkspaceSyncContribution`
// (sessions/contrib/sourceControl/browser/sourceControl.contribution.ts) also
// performs multi-root sync for SCM purposes, but it is no longer the sole
// owner of workspace folder synchronization.

registerWorkbenchContribution2(WorkspaceFolderSyncContribution.ID, WorkspaceFolderSyncContribution, WorkbenchPhase.BlockStartup);
//
// The previous single-folder `AgentStudioWorkspaceSyncContribution` was removed
// to avoid a double-write race: it overwrote the SCM contribution's multi-root
// folder set with just the primary directory, dropping related repositories.

// --- Settings Icon → EditorPane Redirect ----------------------------------------
// When the Settings sidebar icon is clicked, the sidebar ViewContainer is activated
// but its content is CSS-hidden. This contribution intercepts that activation and
// opens the SettingsEditorPane in the editor area instead.

// ─── TOF 登录命令 ───────────────────────────────────────────────────────────
// agentStudio.tofLogin  — 发起 OA 浏览器登录
// agentStudio.tofLogout — 登出并清除本地票据
// agentStudio.tofStatus — 查看当前登录状态
// 启动时自动恢复上次会话（restoreSession）。

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.tofLogin',
			title: localize2('agentStudio.tofLogin', 'OA 登录'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const tofAuthService = accessor.get(ITofAuthService);
		const notificationService = accessor.get(INotificationService);
		try {
			const user = await tofAuthService.login();
			notificationService.info(`登录成功：${user.login_name}（工号 ${user.staff_id}）`);
		} catch (e) {
			notificationService.error(`登录失败：${(e as Error).message}`);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.tofLogout',
			title: localize2('agentStudio.tofLogout', 'OA 登出'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const tofAuthService = accessor.get(ITofAuthService);
		const notificationService = accessor.get(INotificationService);
		await tofAuthService.logout();
		notificationService.info('已登出');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.tofStatus',
			title: localize2('agentStudio.tofStatus', '查看登录状态'),
			f1: true,
			category: localize2('agentStudio.category', 'Agent Studio'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const tofAuthService = accessor.get(ITofAuthService);
		const notificationService = accessor.get(INotificationService);
		const user = tofAuthService.currentUser;
		if (user) {
			notificationService.info(`当前登录用户：${user.login_name}（工号 ${user.staff_id}${user.team ? '，团队 ' + user.team : ''}）`);
		} else {
			notificationService.info('当前未登录');
		}
	}
});

// 启动时自动恢复上次 TOF 会话
class TofSessionRestoreContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.tofSessionRestore';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ITofAuthService tofAuthService: ITofAuthService,
		@ILogService logService: ILogService,
	) {
		super();
		if (!configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}
		// fire-and-forget：不阻塞启动
		void tofAuthService.restoreSession().then(user => {
			if (user) {
				logService.info(`[TofAuth] Session restored: ${user.login_name}`);
			} else {
				logService.info('[TofAuth] No saved session or session expired');
			}
		}).catch(err => {
			logService.warn('[TofAuth] Session restore failed:', err);
		});
	}
}

registerWorkbenchContribution2(TofSessionRestoreContribution.ID, TofSessionRestoreContribution, WorkbenchPhase.AfterRestored);

// --- Settings Icon → EditorPane Redirect ----------------------------------------
// When the Settings sidebar icon is clicked, the sidebar ViewContainer is activated
// but its content is CSS-hidden. This contribution intercepts that activation and
// opens the SettingsEditorPane in the editor area instead.

class SettingsEditorRedirectContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.settingsEditorRedirect';

	constructor(
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();

		if (!configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

		// Listen for sidebar ViewContainer activations
		this._register(this.paneCompositeService.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
			if (viewContainerLocation === ViewContainerLocation.Sidebar && composite.getId() === 'agentStudio.settings') {
				this._openSettingsInEditor();
			}
		}));
	}

	private _openSettingsInEditor(): void {
		const input = SettingsEditorInput.getInstance();
		// Find or create a left-side editor group for Settings
		const groups = this.editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */);
		if (groups.length <= 1) {
			// Only one group — open to the side (creates a left group)
			this.editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		} else {
			// Use the first (leftmost) group
			this.editorService.openEditor(input, { pinned: true }, groups[0]);
		}
	}
}

registerWorkbenchContribution2(SettingsEditorRedirectContribution.ID, SettingsEditorRedirectContribution, WorkbenchPhase.Eventually);

// --- Marketplace URL Handler (vssaros://marketplace/install) -------------------
// Registers a handler for `vssaros://marketplace/install?slug=&version=&kind=` URIs
// triggered by the "安装到 VsSaros" button on the web marketplace detail page.
// When clicked in the browser, the OS launches VsSaros which receives the URI,
// downloads the package from the marketplace, and installs it via IMarketplaceService.

import { IURLService } from '../../../../platform/url/common/url.js';
import { MarketplaceUrlHandler } from './marketplaceUrlHandler.js';

class MarketplaceUrlHandlerContribution implements IWorkbenchContribution {
	static readonly ID = 'sessions.marketplaceUrlHandler';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IURLService urlService: IURLService,
	) {
		const handler = instantiationService.createInstance(MarketplaceUrlHandler);
		urlService.registerHandler(handler);
	}
}

registerWorkbenchContribution2(MarketplaceUrlHandlerContribution.ID, MarketplaceUrlHandlerContribution, WorkbenchPhase.AfterRestored);
