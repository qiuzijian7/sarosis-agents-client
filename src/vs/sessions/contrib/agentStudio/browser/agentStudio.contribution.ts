/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
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
import { mainWindow } from '../../../../base/browser/window.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';

// Codebase-Memory-MCP bootstrap — auto-detect, install, and start on app launch.
// Side-effect import: the module self-registers a workbench contribution.
import './codebaseMemoryMcpBootstrap.js';

// Platform Bridge Layer (cc-connect 复刻) — registers IBridgeService + auto-starts.
import './bridge/bridge.contribution.js';

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
	AGENT_STUDIO_EMBEDDING_KNOT_API_KEY,
	AGENT_STUDIO_EMBEDDING_KNOT_BASE_URL,
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
	AGENT_STUDIO_DRIVER_TURN_CONCURRENCY_LIMIT_SETTING,
	AGENT_STUDIO_SKILLS_INCLUDE_WORKFLOWS_SETTING,
	AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING,
	CHANNEL_DEFINITIONS,
} from '../common/constants.js';
import { AgentTaskBoardService } from './agentTaskBoardService.js';
import { AgentStudioProvider } from './agentStudioProvider.js';
import { BuiltInBYOKModelProvider, BUILTIN_BYOK_PROVIDERS, customProviderDataToDefinition } from './builtInBYOKModelProvider.js';
import type { CustomProviderData } from './views/providerView.js';
import { MainProcessModelProvider } from './mainProcessModelProvider.js';
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
import { WorktreeViewPane } from '../../worktree/browser/worktreeView.js';
import { WorktreeCommands } from '../../worktree/common/worktreeTypes.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { SESSIONS_SCM_WORKTREE_VIEW_ID } from '../../sourceControl/browser/sourceControl.contribution.js';
import { WorktreeItem } from '../../worktree/browser/worktreeDataProvider.js';
import { URI } from '../../../../base/common/uri.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { WorkspaceFolderCountContext } from '../../../../workbench/common/contextkeys.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { TaskOverviewEditorPane } from './taskOverviewEditorPane.js';
import { TaskOverviewEditorInput } from './taskOverviewEditorInput.js';
import { TaskDetailEditorPane } from './taskDetailEditorPane.js';
import { TaskDetailEditorInput } from './taskDetailEditorInput.js';
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
import { CodebaseGraphViewerEditorPane } from './codebaseGraphViewerEditorPane.js';
import { CodebaseGraphViewerEditorInput } from './codebaseGraphViewerEditorInput.js';
import { CodebaseIndexEditorPane } from './codebaseIndexEditorPane.js';
import { CodebaseIndexEditorInput } from './codebaseIndexEditorInput.js';
import { ICodebaseMemoryMcpService, CodebaseMemoryMcpService } from './codebaseMemoryMcpService.js';
import { ICodebaseGraphService, CodebaseGraphService } from './codebaseGraphService.js';
import { ICodebaseGraphWatcher, CodebaseGraphWatcher } from './codebaseGraphWatcher.js';
import './codebaseGraphBootstrap.js';
// C++ DefinitionProvider（基于图谱，无 LSP 依赖）→ 解锁 Ctrl+点击 / F12 / Peek 跳转。Self-registers.
import './codebaseGraphLanguageFeatures.contribution.js';
// Find Symbol（Shift+Alt+S，VAX 风格符号搜索 QuickPick）。Self-registers.
import './codebaseGraphFindSymbol.contribution.js';
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
import { ResourceManagerEditorPane } from './resourceManagerEditorPane.js';
import { ResourceManagerEditorInput } from './resourceManagerEditorInput.js';
import { ISelfEvolutionService } from '../common/selfEvolution.js';
import { SelfEvolutionService } from './selfEvolutionService.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { IEditorService, SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';

/**
 * Type-safe accessor for the agent editor part (AGENT_EDITOR_PART).
 *
 * This replaces the `(editorGroupsService as any).agentPart` pattern with
 * a single centralized cast, reducing `as any` usage from 3 call sites to 1.
 */
function getAgentPart(editorGroupsService: IEditorGroupsService): IEditorGroupsService | undefined {
	return (editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
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

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	properties: {
		...channelConfigProperties(),
		'saros.codebaseGraph.sqliteBackend': {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.codebaseGraph.sqliteBackend', "Codebase 图谱查询/搜索默认走主进程 SQLite（FTS5）后端，避免内存全量扫描。默认开启；设为 false 关闭后回退内存 store。"),
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
			description: localize('agentStudio.preferences.responseLanguage', "Language the LLM should respond in. 'auto' uses the operating system's current language; 'match-user' follows the user's input language."),
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
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'knot', 'custom'],
			description: localize('agentStudio.preferences.defaultProvider', "Default AI Provider for new conversations. 'auto' selects the first available authenticated provider."),
		},
		[AGENT_STUDIO_DEFAULT_MODEL_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.preferences.defaultModel', "Default AI model for new conversations. Leave empty to use system default."),
		},
		[AGENT_STUDIO_BOT_NAME_SETTING]: {
			type: 'string',
			default: 'Sarosis',
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
			description: localize('agentStudio.marketplace.url', "Sarosis 商城服务端地址，用于浏览、上传下载 agent/skill/mcp/知识库。"),
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
		// Knot configuration is registered by the knot-agui extension via its package.json
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
			enum: ['openai', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'custom', 'knot', 'local'],
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
		[AGENT_STUDIO_EMBEDDING_KNOT_API_KEY]: {
			type: 'string', default: '',
			description: localize('agentStudio.embedding.knot.apiKey', "Knot internal embedding API key."),
		},
		[AGENT_STUDIO_EMBEDDING_KNOT_BASE_URL]: {
			type: 'string', default: '',
			description: localize('agentStudio.embedding.knot.baseUrl', "Knot internal embedding API base URL."),
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
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.vision.provider', "Provider for Vision (image analysis)."),
		},
		[AGENT_STUDIO_AUX_VISION_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.vision.model', "Model for Vision. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.webExtract.provider', "Provider for Web Extract (page summarization)."),
		},
		[AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.webExtract.model', "Model for Web Extract. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.sessionSearch.provider', "Provider for Session Search (history summarizing)."),
		},
		[AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.sessionSearch.model', "Model for Session Search. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_COMPRESSION_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.compression.provider', "Provider for Compression (context compression)."),
		},
		[AGENT_STUDIO_AUX_COMPRESSION_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.compression.model', "Model for Compression. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.goalJudge.provider', "Provider for Goal Judge (goals feature)."),
		},
		[AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.goalJudge.model', "Model for Goal Judge. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_CURATOR_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'ollama', 'main', 'knot', 'custom'],
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
			type: 'string', default: 'http://saroasis-mcp.woa.com',
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
	},
});

// --- Canvas Editor Settings -------------------------------------------------------
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sarosis.canvas',
	title: localize('sarosis.canvas', "思维导图编辑器"),
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
// CLI/provider extensions (e.g. knot-agui) to react to workspace mutations
// without any main-repo hardcoding. Eager so its extension-facing commands
// (`agentStudio.workspaceLifecycle.register/unregister/list`) are available
// before any extension is activated.
registerSingleton(IWorkspaceLifecycleService, WorkspaceLifecycleService, InstantiationType.Eager);
// Skill lifecycle event bus — generic, decoupled hook system used by
// CLI/provider extensions (e.g. knot-agui) to react to skill mutations
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

// Register MarketplaceEditorPane so that the Sarosis Marketplace page opens
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

		if (!pane) {
			logService.warn('[agentStudio.addToChat] No focused NativeChatEditorPane found. User may not have clicked on an Agent Chat tab yet.');
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
// Renders as an icon button in the editor title bar (top-right), but ONLY
// when the active editor is the Agent Chat editor (either the React webview
// AgentStudioEditorPane with panelType='chat', or the native NativeChatEditorPane).
//
// Implementation (方案 2 — Independent BrowserWindow):
// Delegates to the built-in `workbench.action.moveEditorToNewWindow` command,
// which opens an independent OS-level Electron BrowserWindow and moves the
// active editor into it. The new window has its own native window controls
// (min/max/close), completely escaping the stacking-context / OS-overlay
// constraints of the main window's titlebar — no DOM-level z-index conflicts.
// Closing the standalone window automatically returns the editor to the main
// window's editor group.
registerAction2(class extends Action2 {
	constructor() {
		const chatEditorActive = ContextKeyExpr.or(
			ActiveEditorContext.isEqualTo('workbench.editor.agentStudio'),
			ActiveEditorContext.isEqualTo('workbench.editor.nativeChat'),
		);
		super({
			id: 'agentStudio.popoutChat',
			title: localize2('agentStudio.popoutChat', 'Pop Out Chat to New Window'),
			f1: false,
			icon: Codicon.linkExternal,
			menu: [{
				id: MenuId.EditorTitle,
				when: chatEditorActive,
				group: 'navigation',
				order: -1,
			}],
			precondition: chatEditorActive,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const layoutService = accessor.get(IWorkbenchLayoutService);

		// 收集所有聊天编辑器 tab（支持多 group 多聊天窗口）。
		// 记录每个 editor 所在 group 的序号（0-based），用于 pop out 时在
		// aux window 中重建等量 group、pop in 时按 groupIndex 精确恢复分屏。
		const chatEditors: EditorInput[] = [];
		const editorToGroupIndex = new Map<EditorInput, number>();
		let groupCount = 0;
		for (const group of editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */)) {
			let hasChatInGroup = false;
			for (const ed of group.editors) {
				if (
					(ed instanceof AgentStudioEditorInput && ed.panelType === 'chat') ||
					ed instanceof NativeChatEditorInput
				) {
					chatEditors.push(ed);
					editorToGroupIndex.set(ed, groupCount);
					hasChatInGroup = true;
				}
			}
			if (hasChatInGroup) {
				groupCount++;
			}
		}

		if (chatEditors.length === 0) {
			return;
		}

		const isNativeChat = chatEditors.some(ed => ed instanceof NativeChatEditorInput);

		try {
			// Open an auxiliary BrowserWindow and recreate the multi-group layout.
			// **修复**: 旧实现把所有聊天 editor 移进 aux window 的同一个 group，
			// 破坏了原有的分屏结构。新实现按 groupIndex 在 aux window 中重建等量 group。
			const auxPart = await editorGroupsService.createAuxiliaryEditorPart();
			const auxGroups = [auxPart.activeGroup];
			for (let i = 1; i < groupCount; i++) {
				const g = auxPart.addGroup(auxGroups[auxGroups.length - 1], 3 /* GroupDirection.RIGHT */);
				if (g) { auxGroups.push(g); }
			}
			// 将每个聊天 editor 从源 group 移到 aux window 中对应的 group
			NativeChatEditorInput.beginForceMove();
			try {
				for (const editor of chatEditors) {
					const gi = editorToGroupIndex.get(editor) ?? 0;
					const targetAuxGroup = auxGroups[Math.min(gi, auxGroups.length - 1)];
					for (const srcGroup of editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */)) {
						if (srcGroup.editors.includes(editor)) {
							srcGroup.moveEditors([{ editor, options: { preserveFocus: false } as any }], targetAuxGroup);
							break;
						}
					}
				}
			} finally {
				NativeChatEditorInput.endForceMove();
			}

			// Hide the Agent editor (right column) after popping out
			layoutService.setPartHidden(true, Parts.AGENT_EDITOR_PART);

			// Hide the titlebar toggle buttons (right column is gone, they're useless)
			const toggleContainer = mainWindow.document.getElementById('agent-studio-titlebar-toggle-container');
			if (toggleContainer) {
				toggleContainer.style.display = 'none';
			}

			// 保存挪出的所有编辑器快照（含 groupIndex），用于 aux window 关闭后
			// 按 groupIndex 精确恢复分屏布局。
			const movedEditors = chatEditors.map(ed => {
				const gi = editorToGroupIndex.get(ed) ?? 0;
				if (ed instanceof NativeChatEditorInput) {
					return { chatId: ed.chatId, agentId: ed.agentId, sessionId: ed.sessionId, name: ed.name, groupIndex: gi };
				}
				return { chatId: (ed as any).panelType || 'chat', agentId: undefined, sessionId: undefined, name: 'Agent Chat', groupIndex: gi };
			});

			// When the auxiliary window is closed, re-show the Agent editor,
			// restore titlebar toggle buttons, then proactively move the ORIGINAL
			// EditorInput instances back into agentPart (preserving _runtimeState),
			// before dispatching reopen-chat for layout fine-tuning.
			//
			// **修复**: 旧实现只派发事件不主动 move，依赖 VS Code 自动 move back。
			// 但 NativeChatEditorInput 是瞬态的（无 serializer），VS Code 可能直接丢弃，
			// 导致 pop in handler 走 NativeChatEditorInput.create() 创建全新实例，
			// 新实例 _runtimeState = undefined → pane 内容空白。
			// 新实现主动 moveEditors 原实例回 agentPart 对应 group，保留聊天状态。
			auxPart.onWillDispose(() => {
				layoutService.setPartHidden(false, Parts.AGENT_EDITOR_PART);

				const tc = mainWindow.document.getElementById('agent-studio-titlebar-toggle-container');
				if (tc) {
					tc.style.display = '';
				}

				// ① 在 agentPart 上按 groupIndex 创建目标 groups
				const agentPart = getAgentPart(editorGroupsService);
				const baseGroup = agentPart?.activeGroup ?? editorGroupsService.activeGroup;
				const targetGroups: IEditorGroup[] = [baseGroup];
				for (let i = 1; i < groupCount; i++) {
					const g = editorGroupsService.addGroup(targetGroups[targetGroups.length - 1], 3 /* GroupDirection.RIGHT */);
					if (g) { targetGroups.push(g); }
				}

				// ② 主动把原 EditorInput 实例从 aux groups（或任何其他 part）移回
				//    agentPart 对应的 targetGroups[groupIndex]。
				//    原实例携带 _runtimeState（messages / 流式状态），是内容保留的关键。
				for (const editor of chatEditors) {
					const gi = editorToGroupIndex.get(editor) ?? 0;
					const target = targetGroups[Math.min(gi, targetGroups.length - 1)];
					const chatId = (editor as NativeChatEditorInput).chatId;

					// 检查 target group 是否已有相同 editor（防止重复创建）
					const alreadyInTarget = target.editors.some(e => editor.matches(e));
					if (alreadyInTarget) {
						continue;
					}

					// 找到 editor 当前所在的 group（aux window 或已被 VS Code 自动 move back）
					let sourceGroup: IEditorGroup | undefined;
					for (const part of editorGroupsService.parts) {
						for (const g of part.groups) {
							if (g.editors.includes(editor)) {
								sourceGroup = g;
								break;
							}
						}
						if (sourceGroup) { break; }
					}
					if (sourceGroup && sourceGroup !== target) {
						sourceGroup.moveEditors([{ editor, options: { preserveFocus: false } as any }], target);
					} else if (!sourceGroup) {
						// aux 已销毁 editor 实例 — VS Code 已通过 onBeforeUnload 自动移回 editor
						// 但自动移回可能尚未完成，延迟检查后再决定是否创建新实例
						const chatIdToCheck = chatId;
						const targetGroupToCheck = target;
						const snap = movedEditors.find(s => s.chatId === (editor as any).chatId);
						setTimeout(() => {
							// 检查所有 groups 是否已有相同 chatId 的 editor（VS Code 自动移回的结果）
							let existingEditor: NativeChatEditorInput | undefined;
							for (const part of editorGroupsService.parts) {
								for (const g of part.groups) {
									for (const e of g.editors) {
										if (e instanceof NativeChatEditorInput && e.chatId === chatIdToCheck) {
											existingEditor = e;
											break;
										}
									}
									if (existingEditor) { break; }
								}
								if (existingEditor) { break; }
							}
							if (existingEditor) {
								return;
							}
							// 真正找不到 editor — fallback 用快照 create 新实例（内容会丢失）
							if (snap) {
								const input = NativeChatEditorInput.create(
									snap.chatId, snap.agentId, snap.sessionId, snap.name,
								);
								targetGroupToCheck.openEditor(input, { pinned: true });
							}
						}, 100); // 延迟 100ms 让 VS Code 自动移回完成
					}
				}

				// ③ 派发 reopen-chat 事件让 workbench 做布局微调（清理多余 group 等）
				requestAnimationFrame(() => {
					mainWindow.document.dispatchEvent(new CustomEvent('agent-studio:reopen-chat', {
						detail: { isNativeChat, editors: movedEditors, groupCount }
					}));
				});
			});
		} catch {
			// Last-resort fallback: dispatch the legacy in-window overlay event
			// (kept for backward compatibility with the older floating-overlay impl).
			mainWindow.document.dispatchEvent(new CustomEvent('agent-studio:popout-chat'));
		}
	}
});

// ── 编辑器标题栏 "+" 新建聊天按钮（popout 按钮左侧）──────────────────────
// 与 agentStudio.popoutChat 同属 MenuId.EditorTitle / navigation 组，
// order: -2 比 popout 的 order: -1 更小 → 渲染在 popout 按钮左侧。
// 点击后在当前活跃 session 中新建一个 chat。
registerAction2(class extends Action2 {
	constructor() {
		const chatEditorActive = ContextKeyExpr.or(
			ActiveEditorContext.isEqualTo('workbench.editor.agentStudio'),
			ActiveEditorContext.isEqualTo('workbench.editor.nativeChat'),
		);
		super({
			id: 'agentStudio.newChatInEditor',
			title: localize2('agentStudio.newChatInEditor', '新建聊天'),
			f1: false,
			icon: Codicon.add,
			menu: [{
				id: MenuId.EditorTitle,
				when: chatEditorActive,
				group: 'navigation',
				order: -2,
			}],
			precondition: chatEditorActive,
		});
	}
	run(accessor: ServicesAccessor): void {
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const logService = accessor.get(ILogService);
		const agentPart = getAgentPart(editorGroupsService);
		if (!agentPart?.activeGroup) {
			return;
		}
		const input = NativeChatEditorInput.create();
		// 每个新聊天默认开在独立的 group 中——仅当用户手动拖拽时，
		// 才允许同一 group 下存在多个聊天 tab。
		// 修复：全部页签关闭后活动 group 为空时，复用空 group，
		// 避免拆出「空 group + 聊天 group」两个分栏。
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

			// [Sarosis] Activate Agent Studio views immediately so UI is visible
			AgentStudioActiveContext.bindTo(this.contextKeyService).set(true);

			// [Sarosis] Two-column layout: Sidebar (activity bar + content) | Editor (Agent Studio EditorPanes)
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
	) {
		super();

		if (!this.configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

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

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		if (!this.configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

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
	// NOTE: knot-agui and codebuddy-provider were removed from this list because:
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
			// agentmemory server 由主进程 startAgentMemoryGateway() 启动，
			// 监听 127.0.0.1:3111 (III_REST_PORT)。
			id: 'agentmemory',
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

	private async _activateBuiltInPlugins(): Promise<void> {
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
			if (this._activatedPlugins.has(entry.id)) {
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
			this._activatedPlugins.set(entry.id, plugin);
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
				if (this._activatedPlugins.has(plugin.extensionId)) {
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
				if (!this._activatedPlugins.has(plugin.extensionId)) {
					this._activateFromExtensionPoint(plugin);
				}
			}
		}
	}

	private async _activateFromExtensionPoint(resolved: IResolvedCapabilityPlugin): Promise<void> {
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
			this._activatedPlugins.set(resolved.extensionId, plugin);

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

	private async _deactivatePlugin(pluginId: string): Promise<void> {
		const plugin = this._activatedPlugins.get(pluginId);
		if (plugin) {
			try {
				await plugin.deactivate();
				this.logService.info(`[AgentCapabilityPlugins] Deactivated: ${pluginId}`);
			} catch (err) {
				this.logService.error(`[AgentCapabilityPlugins] Deactivation failed for ${pluginId}:`, err);
			}
			this._activatedPlugins.delete(pluginId);
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
		// [Sarosis] Two-column layout:
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

		// 2. Search (order: 20) - [Sarosis] Reuse native VSCode SearchView with workspace selector
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
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.knowledgeBase',
			title: localize2('agentStudio.knowledgeBase.title', "知识库"),
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
		// [Sarosis] Use WindowEnablement.Both so icons show in both main window and sessions window
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

// ─── Worktree Commands (action registrations) ────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Refresh,
			title: localize2('worktreeRefresh', 'Refresh Worktrees'),
			icon: Codicon.refresh,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const repoRoot = await worktreeService.getRepositoryRoot();
		if (repoRoot) {
			await worktreeService.listWorktrees(repoRoot);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Create,
			title: localize2('worktreeCreate', 'Create Worktree'),
			icon: Codicon.add,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		// Try to get existing view first (avoids layout jump)
		let view = viewsService.getViewWithId<WorktreeViewPane>(SESSIONS_SCM_WORKTREE_VIEW_ID);
		if (!view) {
			// View not yet created, open it (first time)
			view = await viewsService.openView<WorktreeViewPane>(SESSIONS_SCM_WORKTREE_VIEW_ID);
		}
		if (view) {
			await view.showCreateInput();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Delete,
			title: localize2('worktreeDelete', 'Delete Worktree'),
			icon: Codicon.trash,
		});
	}
	async run(accessor: ServicesAccessor, item: WorktreeItem): Promise<void> {
		if (!item || item.worktree.isMain) {
			return;
		}
		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);
		try {
			await worktreeService.removeWorktree(item.path);
			notificationService.info(localize('worktreeDeleted', 'Deleted worktree: {0}', item.label));
		} catch (e) {
			notificationService.error(localize('worktreeDeleteError', 'Failed to delete worktree: {0}', (e as Error).message));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Open,
			title: localize2('worktreeOpen', 'Open Worktree Folder'),
		});
	}
	async run(accessor: ServicesAccessor, path: string): Promise<void> {
		if (!path) { return; }
		const hostService = accessor.get(IHostService);
		const uri = URI.file(path);
		hostService.openWindow([{ folderUri: uri }], { forceNewWindow: true });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.OpenInTerminal,
			title: localize2('worktreeOpenInTerminal', 'Open in Terminal'),
		});
	}
	async run(accessor: ServicesAccessor, item: WorktreeItem): Promise<void> {
		if (!item) { return; }
		const commandService = accessor.get(ICommandService);
		const uri = URI.file(item.path);
		await commandService.executeCommand('openInIntegratedTerminal', uri);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Prune,
			title: localize2('worktreePrune', 'Prune Stale Worktrees'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);
		const repoRoot = await worktreeService.getRepositoryRoot();
		if (!repoRoot) {
			notificationService.warn(localize('worktreeNoRepo', 'No git repository found in workspace.'));
			return;
		}
		try {
			await worktreeService.pruneWorktrees(repoRoot);
			notificationService.info(localize('worktreePruned', 'Pruned stale worktrees.'));
		} catch (e) {
			notificationService.error(localize('worktreePruneError', 'Failed to prune worktrees: {0}', (e as Error).message));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Reset,
			title: localize2('worktreeReset', 'Reset Worktree'),
			icon: Codicon.discard,
		});
	}
	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);
		const worktreePath = args[0]?.worktreePath ?? args[0]?.path;
		if (!worktreePath) {
			notificationService.warn(localize('worktreeResetNoPath', 'No worktree selected.'));
			return;
		}
		try {
			await worktreeService.resetWorktree(worktreePath);
			notificationService.info(localize('worktreeResetDone', 'Worktree reset to default branch.'));
		} catch (e) {
			notificationService.error(localize('worktreeResetError', 'Failed to reset worktree: {0}', (e as Error).message));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.CreateWithBranch,
			title: localize2('worktreeCreateWithBranch', 'Create Isolated Worktree'),
			icon: Codicon.gitBranch,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);
		const name = await quickInputService.input({
			placeHolder: localize('worktreeCreateNamePlaceholder', 'Worktree name (e.g. feature-auth)'),
			prompt: localize('worktreeCreateNamePrompt', 'Enter a name for the new worktree. A branch "opencode/<name>" will be created.'),
		});
		if (!name?.trim()) { return; }
		try {
			const info = await worktreeService.makeWorktreeInfo({ name: name.trim() });
			await worktreeService.createFromInfo(info);
			notificationService.info(localize('worktreeCreateWithBranchDone',
				'Created worktree "{0}" at branch "{1}"', info.name, info.branch ?? '(detached)'));
		} catch (e) {
			notificationService.error(localize('worktreeCreateWithBranchError',
				'Failed to create worktree: {0}', (e as Error).message));
		}
	}
});

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
