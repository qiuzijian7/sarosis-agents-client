/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
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
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';

import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../workbench/common/editor.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../../workbench/browser/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { AgentStudioPanelType } from '../common/constants.js';

import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService, ITaskOrchestrationService, IConfigHtmlService } from '../common/agentStudio.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IAgentDriverService } from '../common/agentDriver.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { IWorkspaceRegistry } from '../common/agentWorkspace.js';
import { IAgentInstanceService, IAgentGalleryService } from '../common/agentInstance.js';
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
import { IEventBridgeService, EventBridgeService } from '../common/eventBridge.js';
import { TaskOrchestrationService } from './taskOrchestrationService.js';
import { IWorkspaceLifecycleService } from '../common/workspaceLifecycle.js';
import { WorkspaceLifecycleService } from './workspaceLifecycleService.js';
import { ISkillLifecycleService } from '../common/skillLifecycle.js';
import { SkillLifecycleService } from './skillLifecycleService.js';
import {
	AGENT_STUDIO_ENABLED_SETTING,
	AGENT_STUDIO_WORKSPACE_VIEW_ID,
	AGENT_STUDIO_PRESET_AGENT_VIEW_ID,
	AGENT_STUDIO_TASKS_VIEW_ID,
	AGENT_STUDIO_SCHEDULE_VIEW_ID,
	AGENT_STUDIO_INTEGRATION_VIEW_ID,
	AGENT_STUDIO_SEARCH_VIEW_ID,
	AGENT_STUDIO_PLUGINS_VIEW_ID,
	AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID,
	AGENT_STUDIO_EVOLUTION_VIEW_ID,
	AGENT_STUDIO_WORKFLOW_VIEW_ID,
	AGENT_STUDIO_CHANNEL_VIEW_ID,
	AGENT_STUDIO_WIKI_VIEW_ID,
	AGENT_STUDIO_DATA_PATH_SETTING,
	AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING,
	AGENT_STUDIO_CHAT_STREAM_LOG_DUMP_TOOLS_SETTING,
	AGENT_STUDIO_LANGUAGE_SETTING,
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
} from '../common/constants.js';
import { AgentTaskBoardService } from './agentTaskBoardService.js';
import { AgentStudioProvider } from './agentStudioProvider.js';
import { BuiltInBYOKModelProvider, BUILTIN_BYOK_PROVIDERS } from './builtInBYOKModelProvider.js';
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
import { McpServerEditorPane } from './mcpServerEditorPane.js';
import { McpServerEditorInput } from './mcpServerEditorInput.js';
import { McpDetailEditorPane } from './mcpDetailEditorPane.js';
import { McpDetailEditorInput } from './mcpDetailEditorInput.js';
import { SkillMarketEditorPane } from './skillMarketEditorPane.js';
import { SkillMarketEditorInput } from './skillMarketEditorInput.js';
import { NativeChatEditorPane } from './nativeChatEditorPane.js';
import { NativeChatEditorInput } from './nativeChatEditorInput.js';
import './views/media/toolbarViews.css';
import './views/media/toolsToggle.css';
import { WorkspaceViewPane } from './views/workspaceView.js';
import { PresetAgentViewPane } from './views/presetAgentView.js';
import { TasksViewPane } from './views/tasksView.js';
import { ScheduleViewPane } from './views/scheduleView.js';
import { IntegrationViewPane } from './views/integrationView.js';
import { AgentStudioSearchViewPane } from './views/searchView.js';
import { PluginsViewPane } from './views/pluginsView.js';
import { ISettingsTabRegistry, SettingsTabRegistry } from './views/settingsTabRegistry.js';
import { HealthMonitorViewPane } from './views/healthMonitorView.js';
import { EvolutionViewPane } from './views/evolutionView.js';
import { EvolutionDetailEditorPane } from './evolutionDetailEditorPane.js';
import { EvolutionDetailEditorInput } from './evolutionDetailEditorInput.js';
import { ChannelEditorPane } from './channelEditorPane.js';
import { ChannelEditorInput } from './channelEditorInput.js';
import { ChannelViewPane } from './views/channelView.js';
import { WikiViewPane } from './views/wikiView.js';
import { WorkflowViewPane } from './views/workflowView.js';
import { IWikiTagService } from './services/wikiTagService.js';
import { WikiTagServiceImpl } from './services/wikiTagServiceImpl.js';
import { WorktreeViewPane } from '../../worktree/browser/worktreeView.js';
import { WorktreeCommands } from '../../worktree/common/worktreeTypes.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { SESSIONS_SCM_WORKTREE_VIEW_ID } from '../../sourceControl/browser/sourceControl.contribution.js';
import { WorktreeItem } from '../../worktree/browser/worktreeDataProvider.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { TaskOverviewEditorPane } from './taskOverviewEditorPane.js';
import { TaskOverviewEditorInput } from './taskOverviewEditorInput.js';
import { TaskDetailEditorPane } from './taskDetailEditorPane.js';
import { TaskDetailEditorInput } from './taskDetailEditorInput.js';
import { HtmlPreviewEditorPane } from './htmlPreviewEditorPane.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { WorkflowEditorPane } from './workflowEditorPane.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { ISelfEvolutionService } from '../common/selfEvolution.js';
import { SelfEvolutionService } from './selfEvolutionService.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { IEditorService, SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';

// --- Icons -----------------------------------------------------------------------

// Toolbar icons
const workspaceIcon = registerIcon('agent-studio-workspace', Codicon.repo, localize('workspaceIcon', "Workspace"));
const presetAgentIcon = registerIcon('agent-studio-preset-agent', Codicon.robot, localize('presetAgentIcon', "Preset Agent"));
const tasksIcon = registerIcon('agent-studio-tasks', Codicon.tasklist, localize('tasksIcon', "Tasks"));
const scheduleIcon = registerIcon('agent-studio-schedule', Codicon.calendar, localize('scheduleIcon', "Schedule"));
const integrationIcon = registerIcon('agent-studio-integration', Codicon.extensions, localize('integrationIcon', "Integration"));
const searchIcon = registerIcon('agent-studio-search', Codicon.search, localize('searchIcon', "Search"));
const pluginsIcon = registerIcon('agent-studio-plugins', Codicon.package, localize('pluginsIcon', "Plugins"));
const evolutionIcon = registerIcon('agent-studio-evolution', Codicon.beaker, localize('evolutionIcon', "Self-Evolution"));
const channelIcon = registerIcon('agent-studio-channel', Codicon.megaphone, localize('channelIcon', "Channel"));
const wikiIcon = registerIcon('agent-studio-wiki', Codicon.book, localize('wikiIcon', "Wiki"));
const workflowIcon = registerIcon('agent-studio-workflow', Codicon.listTree, localize('workflowIcon', "Workflow"));

// --- Configuration ---------------------------------------------------------------
//qiuzijian debug
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	properties: {
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
			description: localize('agentStudio.chat.useNativeChat', "Use Native Chat UI (DOM-based) instead of React WebView. Native UI has better performance but may have missing features during migration."),
		},
		// --- Preferences ---
		[AGENT_STUDIO_LANGUAGE_SETTING]: {
			type: 'string',
			default: 'en',
			enum: ['en', 'zh-CN', 'ja'],
			description: localize('agentStudio.preferences.language', "Display language."),
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
	},
});

// --- Builtin Agent .agent.md Sync -----------------------------------------------
// Ensures builtin agents have .agent.md files in ~/.saros/agents/ before the
// native chat panel loads, so icons appear correctly in the chat dropdown.

class BuiltinAgentMdSyncContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.builtinAgentMdSync';

	constructor(@IAgentStudioService _agentStudioService: IAgentStudioService) {
		// Injecting IAgentStudioService triggers its constructor, which calls
		// ensureBuiltinAgentMdFiles() to create .agent.md files in ~/.saros/agents/.
	}
}

registerWorkbenchContribution2(BuiltinAgentMdSyncContribution.ID, BuiltinAgentMdSyncContribution, WorkbenchPhase.BlockRestore);

// --- Services Registration -------------------------------------------------------

registerSingleton(IAgentStudioService, AgentStudioService, InstantiationType.Delayed);
registerSingleton(IAgentChatService, AgentChatService, InstantiationType.Delayed);
registerSingleton(IAgentOSService, AgentOSService, InstantiationType.Delayed);
registerSingleton(IAgentDriverService, AgentDriverService, InstantiationType.Delayed);
registerSingleton(IModelSelectorService, ModelSelectorService, InstantiationType.Delayed);
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
registerSingleton(IEventBridgeService, EventBridgeService, InstantiationType.Delayed);
registerSingleton(ITaskOrchestrationService, TaskOrchestrationService, InstantiationType.Delayed);
// ConfigMD service: shared across all webview controllers (chat panels) and
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

// Register HtmlPreviewEditorPane — renders standalone HTML files (e.g.
// ConfigMD's `.preview.html`) inside the editor area using a directly
// DOM-mounted webview iframe, bypassing the OverlayWebview path which
// fails to render on this fork's Chromium build.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		HtmlPreviewEditorPane,
		HtmlPreviewEditorPane.ID,
		localize('htmlPreviewEditor', "HTML Preview"),
	),
	[
		new SyncDescriptor(HtmlPreviewEditorInput)
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
// Skills, Memory, Knowledge, ConfigMD, Tools, MCP, Rules) in the editor area.
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

		// Locate the chat editor + its group EXPLICITLY (do NOT trust the
		// global active editor — when the popout button is clicked, focus may
		// be on the main editor area, which would cause moveEditorToNewWindow
		// to pop out the wrong file).
		let targetGroup: IEditorGroup | undefined;
		let targetEditor: EditorInput | undefined;
		for (const group of editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */)) {
			for (const ed of group.editors) {
				if (
					(ed instanceof AgentStudioEditorInput && ed.panelType === 'chat') ||
					ed instanceof NativeChatEditorInput
				) {
					targetGroup = group;
					targetEditor = ed;
					break;
				}
			}
			if (targetEditor) { break; }
		}

		if (!targetGroup || !targetEditor) {
			// Nothing to pop out
			return;
		}

		try {
			// Open an auxiliary BrowserWindow (independent OS window with
			// native window controls) and move the chat editor into it.
			const auxPart = await editorGroupsService.createAuxiliaryEditorPart();
			targetGroup.moveEditors(
				[{ editor: targetEditor, options: { preserveFocus: false } }],
				auxPart.activeGroup,
			);

			// Hide the chat bar (right sidebar) after popping out
			layoutService.setPartHidden(true, Parts.CHATBAR_PART);

			// When the auxiliary window is closed, re-show the chat bar
			auxPart.onWillDispose(() => {
				layoutService.setPartHidden(false, Parts.CHATBAR_PART);
			});
		} catch {
			// Last-resort fallback: dispatch the legacy in-window overlay event
			// (kept for backward compatibility with the older floating-overlay impl).
			mainWindow.document.dispatchEvent(new CustomEvent('agent-studio:popout-chat'));
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
		return JSON.stringify({ type: 'native-chat' });
	}
	deserialize(_instantiationService: IInstantiationService, _serialized: string): EditorInput | undefined {
		return NativeChatEditorInput.getInstance();
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
	) {
		super();

		if (!this.configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

		for (const def of BUILTIN_BYOK_PROVIDERS) {
			const provider = this._register(new BuiltInBYOKModelProvider(def, this.configurationService, this.logService, this.environmentService));
			this._register(this.agentOSService.registerModelProvider(provider));
			this.logService.info(`[BYOK] Registered built-in provider: ${def.id}`);
		}
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
import { SwarmService } from './providers/swarm/swarmService.js';
import { McpToolProvider } from './providers/tool/mcpToolProvider.js';
import { SessionMemoryProvider } from './providers/memory/sessionMemoryProvider.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { ICheckpointService } from '../common/checkpointService.js';
import { CheckpointService } from './checkpointService.js';
import { IAgentStudioWebviewPool, AgentStudioWebviewPool } from './agentStudioWebviewPool.js';

registerSingleton(ISkillRegistry, SkillRegistry, InstantiationType.Delayed);
registerSingleton(ISkillInstallService, SkillInstallService, InstantiationType.Delayed);
registerSingleton(ICheckpointService, CheckpointService, InstantiationType.Delayed);
// Re-added to repair partial-revert state: AgentStudioWebviewController injects
// IAgentStudioWebviewPool, so the DI must have a registration for it.
registerSingleton(IAgentStudioWebviewPool, AgentStudioWebviewPool, InstantiationType.Delayed);

class BuiltinCapabilityContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.builtinCapabilities';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
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
		this._registerSessionMemory();
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

	private _registerSessionMemory(): void {
		try {
			const provider = new SessionMemoryProvider(this.fileService, this.environmentService, this.logService);
			this._register(provider);
			this._register(this.agentOSService.registerMemoryProvider(provider, 50));
			this.logService.info('[BuiltinCapability] SessionMemoryProvider registered');
		} catch (err) {
			this.logService.error('[BuiltinCapability] SessionMemoryProvider registration failed', err);
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
	private static readonly BUILTIN_FALLBACK_MANIFEST: ICapabilityPluginManifestEntry[] = [
		{
			id: 'knot-agui',
			name: 'Knot AG-UI Model Provider',
			version: '1.0.0',
			module: '../../../../extensions/knot-agui/src/extension.js',
			appResource: 'vs/../../extensions/knot-agui/out/extension.js',
			capabilities: [{ capability: 'model', provider: 'knot-agui', priority: 100 }],
		},
		{
			id: 'hermes-agent',
			name: 'Hermes Agent',
			version: '1.0.0',
			module: '../../../../extensions/hermes-agent/src/extension.js',
			appResource: 'vs/../../extensions/hermes-agent/dist/extension.js',
			capabilities: [
				{ capability: 'model', provider: 'hermes-agent', priority: 50 },
				{ capability: 'execution', provider: 'hermes-agent', priority: 80 },
				{ capability: 'tool', provider: 'hermes-agent', priority: 90 },
				{ capability: 'memory', provider: 'hermes-agent', priority: 70 },
			],
		},
		{
			// tdb-am-memory：把每轮对话通过 POST /capture 上报给 tdb-am-gateway 子进程，
			// 让 vendor TdaiGateway 写入 L0/L1/L2/L3 SQLite。
			//
			// priority 80 > 内置 SessionMemoryProvider(50)，因此 saros 会优先调用本
			// provider 的 writeMemory；同时 hermes-agent.memory(70) 也低于本条，确保在
			// 同时启用时仍然由 tdb-am 拿走数据。
			//
			// 注意：模块路径必须指向 `out/extension.js`（运行时实际产物），不能指向
			// `src/extension.js`，因为 src 是 .ts，浏览器 ESM loader 不识别。
			id: 'tdb-am-memory',
			name: 'TDB-AM Memory',
			version: '1.0.0',
			module: '../../../../extensions/tdb-am-memory/out/extension.js',
			appResource: 'vs/../../extensions/tdb-am-memory/out/extension.js',
			capabilities: [
				{ capability: 'memory', provider: 'tdb-am-memory', priority: 80 },
			],
		},
		// tdb-am-gateway 不再走 AgentCapability 路径——它走 VSCode 扩展宿主，
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
			this.logService.warn(
				`[AgentCapabilityPlugins][Diag] Primary import() failed for ${entry.id} (module=${entry.module}). `
				+ `Error: ${e?.message ?? String(err)}`,
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
					this.logService.warn(
						`[AgentCapabilityPlugins][Diag] Fallback import() also failed for ${entry.id} `
						+ `(appResource=${entry.appResource}). `
						+ `Error: ${e2?.message ?? String(err2)}\nStack: ${e2?.stack ?? '<no stack>'}\n`
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
			// Use the InstantiationService so that plugins which declare DI
			// constructor parameters (e.g. `@IAgentOSService`) get their
			// dependencies wired up. Plugins with a no-arg constructor (like
			// KnotAguiPlugin) work exactly the same way through this path.
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
			this.logService.warn(
				`[AgentCapabilityPlugins][Diag] import() failed for extension ${resolved.extensionId} `
				+ `(mainModule=${resolved.mainModule}). `
				+ `Error: ${e?.message ?? String(err)}\nStack: ${e?.stack ?? '<no stack>'}`,
			);
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

		// 1. Workspace (order: 10)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.workspace',
			title: localize2('agentStudio.workspace.title', "Workspace"),
			icon: workspaceIcon,
			viewId: AGENT_STUDIO_WORKSPACE_VIEW_ID,
			order: 10,
			viewCtor: WorkspaceViewPane,
		});

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

		// 3. Tasks (order: 40)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.tasks',
			title: localize2('agentStudio.tasks.title', "Tasks"),
			icon: tasksIcon,
			viewId: AGENT_STUDIO_TASKS_VIEW_ID,
			order: 40,
			viewCtor: TasksViewPane,
		});

		// 4. Agents (order: 50)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.presetAgent',
			title: localize2('agentStudio.presetAgent.title', "Agents"),
			icon: presetAgentIcon,
			viewId: AGENT_STUDIO_PRESET_AGENT_VIEW_ID,
			order: 50,
			viewCtor: PresetAgentViewPane,
		});

		// 5. Workflow (order: 60)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.workflow',
			title: localize2('agentStudio.workflow.title', "Workflow"),
			icon: workflowIcon,
			viewId: AGENT_STUDIO_WORKFLOW_VIEW_ID,
			order: 60,
			viewCtor: WorkflowViewPane,
		});

		// 6. Integration (Skills + Tools + MCP, order: 70)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.integration',
			title: localize2('agentStudio.integration.title', "Integration"),
			icon: integrationIcon,
			viewId: AGENT_STUDIO_INTEGRATION_VIEW_ID,
			order: 70,
			viewCtor: IntegrationViewPane,
		});

		// 7. Plugins (order: 80)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.plugins',
			title: localize2('agentStudio.plugins.title', "Plugins"),
			icon: pluginsIcon,
			viewId: AGENT_STUDIO_PLUGINS_VIEW_ID,
			order: 80,
			viewCtor: PluginsViewPane,
		});

		// --- Remaining icons (after Plugins) ---

		// Schedule (order: 90)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.schedule',
			title: localize2('agentStudio.schedule.title', "Schedule"),
			icon: scheduleIcon,
			viewId: AGENT_STUDIO_SCHEDULE_VIEW_ID,
			order: 90,
			viewCtor: ScheduleViewPane,
		});

		// Channel (order: 100)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.channel',
			title: localize2('agentStudio.channel.title', "Channel"),
			icon: channelIcon,
			viewId: AGENT_STUDIO_CHANNEL_VIEW_ID,
			order: 100,
			viewCtor: ChannelViewPane,
		});

		// Wiki (order: 110)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.wiki',
			title: localize2('agentStudio.wiki.title', "Wiki"),
			icon: wikiIcon,
			viewId: AGENT_STUDIO_WIKI_VIEW_ID,
			order: 110,
			viewCtor: WikiViewPane,
		});

		// Health Monitor (order: 120)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.healthMonitor',
			title: localize2('agentStudio.healthMonitor.title', "Health Monitor"),
			icon: Codicon.pulse,
			viewId: AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID,
			order: 120,
			viewCtor: HealthMonitorViewPane,
		});

		// Self-Evolution (order: 130)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.evolution',
			title: localize2('agentStudio.evolution.title', "Self-Evolution"),
			icon: evolutionIcon,
			viewId: AGENT_STUDIO_EVOLUTION_VIEW_ID,
			order: 130,
			viewCtor: EvolutionViewPane,
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
		const viewsService = accessor.get(IViewsService);
		let view = viewsService.getViewWithId<WorkspaceViewPane>(AGENT_STUDIO_WORKSPACE_VIEW_ID);
		if (!view) {
			view = await viewsService.openView<WorkspaceViewPane>(AGENT_STUDIO_WORKSPACE_VIEW_ID);
		}
		if (view) {
			await view.showCreateWorkspace();
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
		const viewsService = accessor.get(IViewsService);
		let view = viewsService.getViewWithId<WorkspaceViewPane>(AGENT_STUDIO_WORKSPACE_VIEW_ID);
		if (!view) {
			view = await viewsService.openView<WorkspaceViewPane>(AGENT_STUDIO_WORKSPACE_VIEW_ID);
		}
		if (view) {
			await view.showAddRelatedFolder();
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
// NOTE: VS Code workspace-folder synchronization for the active AgentStudio
// workspace is now owned exclusively by `SourceControlWorkspaceSyncContribution`
// (see sessions/contrib/sourceControl/browser/sourceControl.contribution.ts).
//
// That contribution performs *multi-root* synchronization — it writes the
// active workspace's home directory PLUS every related folder (and worktree)
// into the VS Code workspace folders, so the Git extension discovers all linked
// repositories and the SCM view shows their status.
//
// The previous single-folder `AgentStudioWorkspaceSyncContribution` was removed
// to avoid a double-write race: it overwrote the SCM contribution's multi-root
// folder set with just the primary directory, dropping related repositories.

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
