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
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ILocalizedString, localize, localize2 } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../workbench/common/editor.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../../workbench/browser/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { AgentStudioPanelType } from '../common/constants.js';

import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService, ITaskOrchestrationService, IConfigMdService } from '../common/agentStudio.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IAgentDriverService } from '../common/agentDriver.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { IWorkspaceRegistry } from '../common/agentWorkspace.js';
import { IAgentInstanceService, IAgentGalleryService } from '../common/agentInstance.js';
import { AgentStudioService } from './agentStudioService.js';
import { AgentChatService } from './agentChatService.js';
import { ConfigMdService } from './configMdService.js';
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
import { IEventBridgeService, EventBridgeService } from '../common/eventBridge.js';
import { TaskOrchestrationService } from './taskOrchestrationService.js';
import { IWorkspaceLifecycleService } from '../common/workspaceLifecycle.js';
import { WorkspaceLifecycleService } from './workspaceLifecycleService.js';
import { ISkillLifecycleService } from '../common/skillLifecycle.js';
import { SkillLifecycleService } from './skillLifecycleService.js';
import {
	AGENT_STUDIO_ENABLED_SETTING,
	AGENT_STUDIO_SIDEBAR_VIEW_CONTAINER_ID,
	AGENT_STUDIO_SESSIONS_VIEW_ID,
	AGENT_STUDIO_WORKSPACES_VIEW_ID,
	AGENT_STUDIO_CLAW_CHAT_VIEW_ID,
	AGENT_STUDIO_WORKSPACE_VIEW_ID,
	AGENT_STUDIO_PRESET_AGENT_VIEW_ID,
	AGENT_STUDIO_SKILLS_VIEW_ID,
	AGENT_STUDIO_TASKS_VIEW_ID,
	AGENT_STUDIO_SCHEDULE_VIEW_ID,
	AGENT_STUDIO_TOOLS_VIEW_ID,
	AGENT_STUDIO_MCP_VIEW_ID,
	AGENT_STUDIO_CHANGES_VIEW_ID,
	AGENT_STUDIO_PLUGINS_VIEW_ID,
	AGENT_STUDIO_PROVIDER_VIEW_ID,
	AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID,
	AGENT_STUDIO_EVOLUTION_VIEW_ID,
	AGENT_STUDIO_CHANNEL_VIEW_ID,
	AGENT_STUDIO_WORKTREE_VIEW_ID,
	AGENT_STUDIO_GRAPH_VIEW_ID,
	AGENT_STUDIO_ACTIVE_CONTEXT_KEY,
	AGENT_STUDIO_DATA_PATH_SETTING,
	AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING,
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
} from '../common/constants.js';
import { AgentTaskBoardService } from './agentTaskBoardService.js';
import { AgentStudioProvider } from './agentStudioProvider.js';
import { BuiltInBYOKModelProvider, BUILTIN_BYOK_PROVIDERS } from './builtInBYOKModelProvider.js';
import { AgentStudioSidebarView } from './agentStudioSidebarView.js';
import { AgentStudioActiveContext } from '../../../common/contextkeys.js';
import { AgentStudioEditorPane } from './agentStudioEditorPane.js';
import { AgentStudioEditorInput } from './agentStudioEditorInput.js';
import { SettingsEditorPane } from './settingsEditorPane.js';
import { SettingsEditorInput } from './settingsEditorInput.js';
import { PluginDetailEditorPane } from './pluginDetailEditorPane.js';
import { PluginDetailEditorInput } from './pluginDetailEditorInput.js';
import './views/media/toolbarViews.css';
import './views/media/toolsToggle.css';
import { ClawChatViewPane } from './views/clawChatView.js';
import { WorkspaceViewPane } from './views/workspaceView.js';
import { PresetAgentViewPane } from './views/presetAgentView.js';
import { SkillsViewPane } from './views/skillsView.js';
import { TasksViewPane } from './views/tasksView.js';
import { ScheduleViewPane } from './views/scheduleView.js';
import { ToolsViewPane } from './views/toolsView.js';
import { ChangesViewPane } from './views/changesView.js';
import { GraphViewPane } from './views/graphView.js';
import { AgentStudioSearchViewPane } from './views/searchView.js';
import { PluginsViewPane } from './views/pluginsView.js';
import { ISettingsTabRegistry, SettingsTabRegistry } from './views/settingsTabRegistry.js';
import { ProviderViewPane } from './views/providerView.js';
import { HealthMonitorViewPane } from './views/healthMonitorView.js';
import { McpViewPane } from './views/mcpView.js';
import { EvolutionViewPane } from './views/evolutionView.js';
import { EvolutionDetailEditorPane } from './evolutionDetailEditorPane.js';
import { EvolutionDetailEditorInput } from './evolutionDetailEditorInput.js';
import { ChannelEditorPane } from './channelEditorPane.js';
import { ChannelEditorInput } from './channelEditorInput.js';
import { ChannelViewPane } from './views/channelView.js';
import { WorktreeViewPane } from '../../worktree/browser/worktreeView.js';
import { WorktreeCommands, WorktreeContextKeys } from '../../worktree/common/worktreeTypes.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { WorktreeItem } from '../../worktree/browser/worktreeDataProvider.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { URI } from '../../../../base/common/uri.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { TaskOverviewEditorPane } from './taskOverviewEditorPane.js';
import { TaskOverviewEditorInput } from './taskOverviewEditorInput.js';
import { TaskDetailEditorPane } from './taskDetailEditorPane.js';
import { TaskDetailEditorInput } from './taskDetailEditorInput.js';
import { HtmlPreviewEditorPane } from './htmlPreviewEditorPane.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { ISelfEvolutionService } from '../common/selfEvolution.js';
import { SelfEvolutionService } from './selfEvolutionService.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { IEditorService, SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';

// --- Icons -----------------------------------------------------------------------

const agentStudioIcon = registerIcon('agent-studio', Codicon.hubot, localize('agentStudioIcon', "Icon for Agent Studio."));

// Toolbar icons
const clawChatIcon = registerIcon('agent-studio-claw-chat', Codicon.comment, localize('clawChatIcon', "Claw Chat"));
const workspaceIcon = registerIcon('agent-studio-workspace', Codicon.repo, localize('workspaceIcon', "Workspace"));
const presetAgentIcon = registerIcon('agent-studio-preset-agent', Codicon.robot, localize('presetAgentIcon', "Preset Agent"));
const skillsIcon = registerIcon('agent-studio-skills', Codicon.lightbulb, localize('skillsIcon', "Skills"));
const tasksIcon = registerIcon('agent-studio-tasks', Codicon.tasklist, localize('tasksIcon', "Tasks"));
const scheduleIcon = registerIcon('agent-studio-schedule', Codicon.calendar, localize('scheduleIcon', "Schedule"));
const toolsIcon = registerIcon('agent-studio-tools', Codicon.tools, localize('toolsIcon', "Tools"));
const mcpIcon = registerIcon('agent-studio-mcp', Codicon.plug, localize('mcpIcon', "MCP"));
const changesIcon = registerIcon('agent-studio-changes', Codicon.diff, localize('changesIcon', "Changes"));
const searchIcon = registerIcon('agent-studio-search', Codicon.search, localize('searchIcon', "Search"));
const pluginsIcon = registerIcon('agent-studio-plugins', Codicon.package, localize('pluginsIcon', "Plugins"));
const providerIcon = registerIcon('agent-studio-provider', Codicon.plug, localize('providerIcon', "Provider"));
const evolutionIcon = registerIcon('agent-studio-evolution', Codicon.beaker, localize('evolutionIcon', "Self-Evolution"));
const channelIcon = registerIcon('agent-studio-channel', Codicon.megaphone, localize('channelIcon', "Channel"));

// --- Configuration ---------------------------------------------------------------

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
		default: true,
		description: localize('agentStudio.chatStreamLog.enabled', "Enable chat stream logging for debugging. Logs are saved to the workspace logs/chat-streams directory."),
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
registerSingleton(IEventBridgeService, EventBridgeService, InstantiationType.Delayed);
registerSingleton(ITaskOrchestrationService, TaskOrchestrationService, InstantiationType.Delayed);
// ConfigMD service: shared across all webview controllers (chat panels) and
// the HtmlPreviewEditorPane. Keeping a single instance avoids duplicating
// the per-employee state cache and lets the preview pane forward webview
// imgui.submit messages back through the same dispatcher.
registerSingleton(IConfigMdService, ConfigMdService, InstantiationType.Delayed);
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
registerSingleton(ISelfEvolutionService, SelfEvolutionService, InstantiationType.Delayed);

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
	) {
		super();

		if (!this.configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			return;
		}

		for (const def of BUILTIN_BYOK_PROVIDERS) {
			const provider = this._register(new BuiltInBYOKModelProvider(def, this.configurationService, this.logService));
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
import { McpToolProvider } from './providers/tool/mcpToolProvider.js';
import { SessionMemoryProvider } from './providers/memory/sessionMemoryProvider.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';

registerSingleton(ISkillRegistry, SkillRegistry, InstantiationType.Delayed);
registerSingleton(ISkillInstallService, SkillInstallService, InstantiationType.Delayed);

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
			// priority 80 > 内置 SessionMemoryProvider(50)，因此 sarosis 会优先调用本
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

		const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

		// --- Layout Reference: Two-Column Layout ---------------------------------
		// [Sarosis] Two-column layout:
		//   Left: Sidebar (activity bar icons + content panel)
		//   Right: Editor Area (Agent Studio EditorPanes: Chat, TaskBoard, Canvas)
		//   AuxiliaryBar: Hidden by default (available for supplementary views)
		//   Bottom: Panel (optional, hidden by default)

		// NOTE: Agent Chat, Task Board, and Canvas are now registered as EditorPanes
		// (see AgentStudioEditorPane / AgentStudioEditorInput) and open in the editor area.
		// The AuxiliaryBar registrations below are kept for supplementary views only.

		// --- Sidebar View Container ---------------------------------------------
		const sidebarContainer = viewContainerRegistry.registerViewContainer({
			id: AGENT_STUDIO_SIDEBAR_VIEW_CONTAINER_ID,
			title: localize2('agentStudio.sidebar.title', "Agent Studio Sessions"),
			icon: agentStudioIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AGENT_STUDIO_SIDEBAR_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
			storageId: AGENT_STUDIO_SIDEBAR_VIEW_CONTAINER_ID,
			hideIfEmpty: true,
			order: 0,
			windowEnablement: WindowEnablement.Sessions,
		}, ViewContainerLocation.Sidebar, { isDefault: true });

		viewsRegistry.registerViews([
			{
				id: AGENT_STUDIO_SESSIONS_VIEW_ID,
				name: localize2('agentStudio.sessionsView', "Sessions"),
				ctorDescriptor: new SyncDescriptor(AgentStudioSidebarView),
				canToggleVisibility: true,
				canMoveView: true,
				order: 0,
				when: ContextKeyExpr.equals(AGENT_STUDIO_ACTIVE_CONTEXT_KEY, true),
				windowEnablement: WindowEnablement.Sessions,
			},
			{
				id: AGENT_STUDIO_WORKSPACES_VIEW_ID,
				name: localize2('agentStudio.workspacesView', "Workspaces"),
				ctorDescriptor: new SyncDescriptor(AgentStudioSidebarView),
				canToggleVisibility: true,
				canMoveView: true,
				order: 1,
				when: ContextKeyExpr.equals(AGENT_STUDIO_ACTIVE_CONTEXT_KEY, true),
				windowEnablement: WindowEnablement.Sessions,
			},
		], sidebarContainer);
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

		// --- Top-aligned icons (order: 0-90) ---------------------------------

		// 1. Claw Chat (order: 0)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.clawChat',
			title: localize2('agentStudio.clawChat.title', "Claw Chat"),
			icon: clawChatIcon,
			viewId: AGENT_STUDIO_CLAW_CHAT_VIEW_ID,
			order: 0,
			viewCtor: ClawChatViewPane,
		});

		// 2. Workspace (order: 10)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.workspace',
			title: localize2('agentStudio.workspace.title', "Workspace"),
			icon: workspaceIcon,
			viewId: AGENT_STUDIO_WORKSPACE_VIEW_ID,
			order: 10,
			viewCtor: WorkspaceViewPane,
		});

		// 3. Preset Agent (order: 20)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.presetAgent',
			title: localize2('agentStudio.presetAgent.title', "Preset Agent"),
			icon: presetAgentIcon,
			viewId: AGENT_STUDIO_PRESET_AGENT_VIEW_ID,
			order: 20,
			viewCtor: PresetAgentViewPane,
		});

		// 4. Skills (order: 30)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.skills',
			title: localize2('agentStudio.skills.title', "Skills"),
			icon: skillsIcon,
			viewId: AGENT_STUDIO_SKILLS_VIEW_ID,
			order: 30,
			viewCtor: SkillsViewPane,
		});

		// 5. Tasks (order: 40)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.tasks',
			title: localize2('agentStudio.tasks.title', "Tasks"),
			icon: tasksIcon,
			viewId: AGENT_STUDIO_TASKS_VIEW_ID,
			order: 40,
			viewCtor: TasksViewPane,
		});

		// 6. Schedule (order: 50)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.schedule',
			title: localize2('agentStudio.schedule.title', "Schedule"),
			icon: scheduleIcon,
			viewId: AGENT_STUDIO_SCHEDULE_VIEW_ID,
			order: 50,
			viewCtor: ScheduleViewPane,
		});

		// 7. Tools (order: 60)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.tools',
			title: localize2('agentStudio.tools.title', "Tools"),
			icon: toolsIcon,
			viewId: AGENT_STUDIO_TOOLS_VIEW_ID,
			order: 60,
			viewCtor: ToolsViewPane,
		});

		// 7.5 MCP (order: 65)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.mcp',
			title: localize2('agentStudio.mcp.title', "MCP"),
			icon: mcpIcon,
			viewId: AGENT_STUDIO_MCP_VIEW_ID,
			order: 65,
			viewCtor: McpViewPane,
		});

		// Hide native VS Code Source Control from Activity Bar
		const nativeScm = viewContainerRegistry.getViewContainers(ViewContainerLocation.Sidebar)
			.find(c => c.id === 'workbench.view.scm');
		if (nativeScm) {
			viewContainerRegistry.deregisterViewContainer(nativeScm);
		}
		// Also listen for late registration and immediately deregister
		this._register(viewContainerRegistry.onDidRegister(({ viewContainer }) => {
			if (viewContainer.id === 'workbench.view.scm') {
				viewContainerRegistry.deregisterViewContainer(viewContainer);
			}
		}));

		// 8. Changes + Worktrees + Graph (order: 70) — multi-view container
		const changesContainer = viewContainerRegistry.registerViewContainer({
			id: 'agentStudio.changes',
			title: localize2('agentStudio.changes.title', "Source Control"),
			icon: changesIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['agentStudio.changes', { mergeViewWithContainerWhenSingleView: false }]),
			storageId: 'agentStudio.changes',
			hideIfEmpty: false,
			order: 70,
			windowEnablement: WindowEnablement.Both,
		}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

		// 8a. Changes view
		viewsRegistry.registerViews([{
			id: AGENT_STUDIO_CHANGES_VIEW_ID,
			name: localize2('agentStudio.changes.title', "Changes"),
			ctorDescriptor: new SyncDescriptor(ChangesViewPane),
			canToggleVisibility: true,
			canMoveView: false,
			order: 0,
			weight: 40,
			windowEnablement: WindowEnablement.Both,
		}], changesContainer);

		// 8b. Worktrees view
		viewsRegistry.registerViews([{
			id: AGENT_STUDIO_WORKTREE_VIEW_ID,
			name: localize2('agentStudio.worktrees.title', "Worktrees"),
			ctorDescriptor: new SyncDescriptor(WorktreeViewPane),
			canToggleVisibility: true,
			canMoveView: false,
			order: 1,
			weight: 20,
			windowEnablement: WindowEnablement.Both,
		}], changesContainer);

		// 8c. Graph view (commit history)
		viewsRegistry.registerViews([{
			id: AGENT_STUDIO_GRAPH_VIEW_ID,
			name: localize2('agentStudio.graph.title', "Graph"),
			ctorDescriptor: new SyncDescriptor(GraphViewPane),
			canToggleVisibility: true,
			canMoveView: false,
			order: 2,
			weight: 40,
			windowEnablement: WindowEnablement.Both,
		}], changesContainer);

		// 8.5 Channel (order: 75)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.channel',
			title: localize2('agentStudio.channel.title', "Channel"),
			icon: channelIcon,
			viewId: AGENT_STUDIO_CHANNEL_VIEW_ID,
			order: 75,
			viewCtor: ChannelViewPane,
		});

		// 9. Search (order: 80) - [Sarosis] Reuse native VSCode SearchView with workspace selector
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.search',
			title: localize2('agentStudio.search.title', "Search"),
			icon: searchIcon,
			viewId: 'workbench.view.search',
			order: 80,
			viewCtor: AgentStudioSearchViewPane,
		});

		// 10. Plugins (order: 90)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.plugins',
			title: localize2('agentStudio.plugins.title', "Plugins"),
			icon: pluginsIcon,
			viewId: AGENT_STUDIO_PLUGINS_VIEW_ID,
			order: 90,
			viewCtor: PluginsViewPane,
		});

		// 11. Provider (order: 95)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.provider',
			title: localize2('agentStudio.provider.title', "Provider"),
			icon: providerIcon,
			viewId: AGENT_STUDIO_PROVIDER_VIEW_ID,
			order: 95,
			viewCtor: ProviderViewPane,
		});

		// 10.5 Health Monitor (order: 85)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.healthMonitor',
			title: localize2('agentStudio.healthMonitor.title', "Health Monitor"),
			icon: Codicon.pulse,
			viewId: AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID,
			order: 85,
			viewCtor: HealthMonitorViewPane,
		});

		// 11. Self-Evolution (order: 92)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.evolution',
			title: localize2('agentStudio.evolution.title', "Self-Evolution"),
			icon: evolutionIcon,
			viewId: AGENT_STUDIO_EVOLUTION_VIEW_ID,
			order: 92,
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

// ─── Worktree Menu Items for the AgentStudio Worktree view ─────────────────

const WT_WHEN = ContextKeyExpr.equals('view', AGENT_STUDIO_WORKTREE_VIEW_ID);
const WT_NOT_MAIN = ContextKeyExpr.and(
	WT_WHEN,
	ContextKeyExpr.regex('viewItem', /^(?!.*worktreeMain).*$/i)
);
const WT_RESET_WHEN = ContextKeyExpr.and(
	WT_WHEN,
	ContextKeyExpr.notEquals(WorktreeContextKeys.WorktreeIsMain, true),
);

// Refresh
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.Refresh, title: localize2('worktreeRefresh', 'Refresh Worktrees'), icon: Codicon.refresh },
	when: WT_WHEN,
	group: 'navigation',
	order: 10,
});

// Create
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.Create, title: localize2('worktreeCreate', 'Create Worktree'), icon: Codicon.add },
	when: WT_WHEN,
	group: 'navigation',
	order: 20,
});

// Create With Branch
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.CreateWithBranch, title: localize2('worktreeCreateWithBranch', 'Create Isolated Worktree'), icon: Codicon.gitBranch },
	when: WT_WHEN,
	group: 'navigation',
	order: 3,
});

// Delete
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.Delete, title: localize2('worktreeDelete', 'Delete Worktree'), icon: Codicon.trash },
	when: WT_NOT_MAIN,
	group: 'inline',
	order: 10,
});

// Open
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.Open, title: localize2('worktreeOpen', 'Open Worktree Folder') },
	when: WT_WHEN,
	group: 'navigation',
	order: 10,
});

// Open in Terminal
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.OpenInTerminal, title: localize2('worktreeOpenInTerminal', 'Open in Terminal') },
	when: WT_WHEN,
	group: 'navigation',
	order: 20,
});

// Prune
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.Prune, title: localize2('worktreePrune', 'Prune Stale Worktrees') },
	when: WT_WHEN,
	group: '2_worktree',
	order: 10,
});

// Reset
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.Reset, title: localize2('worktreeReset', 'Reset Worktree'), icon: Codicon.discard },
	when: WT_RESET_WHEN,
	group: '2_worktree',
	order: 5,
});

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
			notificationService.info(localize('worktreeCreateDone',
				'Created worktree "{0}" at branch "{1}"', info.name, info.branch ?? '(detached)'));
		} catch (e) {
			notificationService.error(localize('worktreeCreateError',
				'Failed to create worktree: {0}', (e as Error).message));
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

// ─── Workspace Folder Sync ──────────────────────────────────────────────────
// When the user switches the active workspace in the AgentStudio toolbar,
// update the VS Code workspace folders so that the Git extension discovers
// the new repository and the SCM views refresh automatically.

class AgentStudioWorkspaceSyncContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'agentStudio.workspaceSync';

	private _activeWorkspaceId: string | undefined;
	private readonly _domEventHandler: (e: Event) => void;

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();

		this._domEventHandler = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId) {
				this._activeWorkspaceId = detail.workspaceId;
				this._syncWorkspaceFolder(detail.workspaceId);
			}
		};
		document.addEventListener('agent-studio:active-workspace-changed', this._domEventHandler);
		this._register({
			dispose: () => document.removeEventListener('agent-studio:active-workspace-changed', this._domEventHandler),
		});

		// Only sync if the mutation affects the active workspace
		this._register(this.agentStudioService.onDidChangeWorkspace((workspaceId: string) => {
			if (workspaceId === this._activeWorkspaceId) {
				this._syncWorkspaceFolder(workspaceId);
			}
		}));

		// Initial sync
		this._initialSync();
	}

	private async _initialSync(): Promise<void> {
		try {
			const workspaces = await this.agentStudioService.getWorkspaces();
			if (workspaces.length > 0) {
				this._activeWorkspaceId = workspaces[0].id;
				await this._syncWorkspaceFolder(workspaces[0].id);
			}
		} catch {
			// Ignore
		}
	}

	private async _syncWorkspaceFolder(workspaceId: string): Promise<void> {
		const workspace = await this.agentStudioService.getWorkspace(workspaceId);
		if (!workspace) { return; }

		let folderPath: string | undefined;
		if (workspace.worktreePath) {
			folderPath = workspace.worktreePath;
		} else if (workspace.path) {
			folderPath = workspace.path;
		}
		if (!folderPath) { return; }

		const folderUri = URI.file(folderPath);
		const currentFolders = this.workspaceContextService.getWorkspace().folders;

		if (currentFolders.length > 0 && this.uriIdentityService.extUri.isEqual(currentFolders[0].uri, folderUri)) {
			return;
		}

		const folderName = workspace.name || this.uriIdentityService.extUri.basenameOrAuthority(folderUri);
		const folderData = { uri: folderUri, name: folderName };

		try {
			if (currentFolders.length === 0) {
				await this.workspaceEditingService.addFolders([folderData], true);
			} else {
				await this.workspaceEditingService.updateFolders(0, currentFolders.length, [folderData], true);
			}
		} catch (err) {
			console.warn('[AgentStudioWorkspaceSync] Failed to sync workspace folder:', err);
		}
	}
}

registerWorkbenchContribution2(AgentStudioWorkspaceSyncContribution.ID, AgentStudioWorkspaceSyncContribution, WorkbenchPhase.BlockStartup);

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
