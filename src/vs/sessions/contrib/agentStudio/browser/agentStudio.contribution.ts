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

import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../../workbench/browser/editor.js';

import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService } from '../common/agentStudio.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IAgentDriverService } from '../common/agentDriver.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { IWorkspaceRegistry } from '../common/agentWorkspace.js';
import { IAgentInstanceService, IAgentGalleryService } from '../common/agentInstance.js';
import { AgentStudioService } from './agentStudioService.js';
import { AgentChatService } from './agentChatService.js';
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
import { IWorkspaceTemplateService } from '../common/workspaceTemplate.js';
import { WorkspaceTemplateService } from './workspaceTemplateService.js';
import { ICrewTeamService } from '../common/crewTeam.js';
import { CrewTeamService } from './crewTeamService.js';
import { IEventBridgeService, EventBridgeService } from '../common/eventBridge.js';
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
	AGENT_STUDIO_CHANGES_VIEW_ID,
	AGENT_STUDIO_PLUGINS_VIEW_ID,
	AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID,
	AGENT_STUDIO_WORKSPACE_TEMPLATE_VIEW_ID,
	AGENT_STUDIO_CREW_TEAM_VIEW_ID,
	AGENT_STUDIO_ACTIVE_CONTEXT_KEY,
	AGENT_STUDIO_DATA_PATH_SETTING,
	AGENT_STUDIO_THEME_SETTING,
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
import { ClawChatViewPane } from './views/clawChatView.js';
import { WorkspaceViewPane } from './views/workspaceView.js';
import { PresetAgentViewPane } from './views/presetAgentView.js';
import { SkillsViewPane } from './views/skillsView.js';
import { TasksViewPane } from './views/tasksView.js';
import { ScheduleViewPane } from './views/scheduleView.js';
import { ToolsViewPane } from './views/toolsView.js';
import { ChangesViewPane } from './views/changesView.js';
import { AgentStudioSearchViewPane } from './views/searchView.js';
import { PluginsViewPane } from './views/pluginsView.js';
import { ISettingsTabRegistry, SettingsTabRegistry } from './views/settingsTabRegistry.js';
import { HealthMonitorViewPane } from './views/healthMonitorView.js';
import { WorkspaceTemplateViewPane } from './views/workspaceTemplateView.js';
import { CrewTeamViewPane } from './views/crewTeamView.js';
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
const changesIcon = registerIcon('agent-studio-changes', Codicon.diff, localize('changesIcon', "Changes"));
const searchIcon = registerIcon('agent-studio-search', Codicon.search, localize('searchIcon', "Search"));
const pluginsIcon = registerIcon('agent-studio-plugins', Codicon.package, localize('pluginsIcon', "Plugins"));

// --- Configuration ---------------------------------------------------------------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	properties: {
		[AGENT_STUDIO_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.enabled', "Enable Agent Studio multi-agent workspace in the Sessions window."),
		},
		// --- Preferences ---
		[AGENT_STUDIO_THEME_SETTING]: {
			type: 'string',
			default: 'dark',
			enum: ['dark', 'light', 'slate', 'solarized', 'monokai', 'nord', 'oled'],
			description: localize('agentStudio.preferences.theme', "UI color theme."),
		},
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
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'knot', 'custom'],
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
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.vision.provider', "Provider for Vision (image analysis)."),
		},
		[AGENT_STUDIO_AUX_VISION_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.vision.model', "Model for Vision. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.webExtract.provider', "Provider for Web Extract (page summarization)."),
		},
		[AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.webExtract.model', "Model for Web Extract. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.sessionSearch.provider', "Provider for Session Search (history summarizing)."),
		},
		[AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.sessionSearch.model', "Model for Session Search. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_COMPRESSION_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.compression.provider', "Provider for Compression (context compression)."),
		},
		[AGENT_STUDIO_AUX_COMPRESSION_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.compression.model', "Model for Compression. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'knot', 'custom'],
			description: localize('agentStudio.aux.goalJudge.provider', "Provider for Goal Judge (goals feature)."),
		},
		[AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL]: {
			type: 'string', default: '',
			description: localize('agentStudio.aux.goalJudge.model', "Model for Goal Judge. Leave empty for default."),
		},
		[AGENT_STUDIO_AUX_CURATOR_PROVIDER]: {
			type: 'string', default: 'auto',
			enum: ['auto', 'openrouter', 'nous', 'gemini', 'anthropic', 'main', 'knot', 'custom'],
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
registerSingleton(IWorkspaceTemplateService, WorkspaceTemplateService, InstantiationType.Delayed);
registerSingleton(ICrewTeamService, CrewTeamService, InstantiationType.Delayed);
registerSingleton(IEventBridgeService, EventBridgeService, InstantiationType.Delayed);
// ISettingsTabRegistry is still registered for the legacy SettingsViewPane (sidebar).
// Plugin-specific settings (like Knot) now open as independent EditorPanes
// rather than appearing as tabs in the Settings page.
registerSingleton(ISettingsTabRegistry, SettingsTabRegistry, InstantiationType.Delayed);

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

// --- Agent Capability Plugin Activation ------------------------------------------
// Discovers and activates IAgentCapabilityPlugin extensions by reading the
// capability-plugins.json manifest generated at build time. This allows new
// provider plugins to be auto-discovered without modifying any source code —
// just drop an extension with agentCapabilities in its package.json.

import { IAgentOSPluginContext, IAgentCapabilityPlugin } from '../common/adapters.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

/**
 * Shape of each entry in the build-generated capability-plugins.json manifest.
 */
interface ICapabilityPluginManifestEntry {
	id: string;
	name: string;
	version: string;
	module: string;
	capabilities: Array<{ capability: string; provider: string; priority?: number }>;
	exportClass?: string;
}

class AgentCapabilityPluginContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.agentCapabilityPlugins';

	private readonly _activatedPlugins: IAgentCapabilityPlugin[] = [];

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

		this._activatePlugins();
	}

	// Path to the build-generated manifest (relative to this file's location in
	// out/vs/sessions/contrib/agentStudio/browser/)
	private static readonly MANIFEST_MODULE = '../../../../extensions/capability-plugins.json';

	private async _activatePlugins(): Promise<void> {
		const context = this._createPluginContext();

		// Load the manifest generated by the build system
		let manifest: ICapabilityPluginManifestEntry[];
		try {
			// Use dynamic import with a variable to prevent TS static resolution
			const manifestPath = AgentCapabilityPluginContribution.MANIFEST_MODULE;
			const manifestModule = await import(manifestPath, { with: { type: 'json' } });
			manifest = manifestModule.default ?? manifestModule;
			this.logService.info(`[AgentCapabilityPlugins] Loaded manifest with ${manifest.length} plugin(s)`);
		} catch (err) {
			this.logService.warn('[AgentCapabilityPlugins] Failed to load capability-plugins.json manifest, falling back to empty list:', err);
			manifest = [];
		}

		// Activate each discovered plugin
		for (const entry of manifest) {
			try {
				// Dynamic import — the module path is relative from this file's
				// runtime location to out/vs/extensions/<name>/src/extension.js
				const pluginModule = await import(entry.module);

				// Find the exported plugin class. Convention:
				// 1. If the manifest specifies exportClass, use that
				// 2. Otherwise, look for the first export that ends with 'Plugin'
				// 3. Fall back to 'default' export
				let PluginClass: (new () => IAgentCapabilityPlugin) | undefined;

				if (entry.exportClass && pluginModule[entry.exportClass]) {
					PluginClass = pluginModule[entry.exportClass];
				} else {
					// Auto-detect: find first exported class whose name ends with 'Plugin'
					for (const key of Object.keys(pluginModule)) {
						if (key.endsWith('Plugin') && typeof pluginModule[key] === 'function') {
							PluginClass = pluginModule[key];
							break;
						}
					}
					// Last resort: default export
					if (!PluginClass && typeof pluginModule.default === 'function') {
						PluginClass = pluginModule.default;
					}
				}

				if (!PluginClass) {
					this.logService.warn(`[AgentCapabilityPlugins] No plugin class found in ${entry.id} (module: ${entry.module})`);
					continue;
				}

				const plugin = new PluginClass();
				await plugin.activate(context);
				this._activatedPlugins.push(plugin);
				this.logService.info(`[AgentCapabilityPlugins] ${entry.name} (${entry.id}@${entry.version}) activated — capabilities: ${entry.capabilities.map(c => c.capability).join(', ')}`);
			} catch (err) {
				this.logService.warn(`[AgentCapabilityPlugins] ${entry.id} plugin activation failed:`, err);
			}
		}
	}

	private _createPluginContext(): IAgentOSPluginContext {
		return {
			extensionPath: '',
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
		for (const plugin of this._activatedPlugins) {
			plugin.deactivate().catch(err => {
				this.logService.error('[AgentCapabilityPlugins] Plugin deactivation failed:', err);
			});
		}
		this._activatedPlugins.length = 0;
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

		// 8. Changes (order: 70)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.changes',
			title: localize2('agentStudio.changes.title', "Changes"),
			icon: changesIcon,
			viewId: AGENT_STUDIO_CHANGES_VIEW_ID,
			order: 70,
			viewCtor: ChangesViewPane,
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

		// 10.5 Health Monitor (order: 85)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.healthMonitor',
			title: localize2('agentStudio.healthMonitor.title', "Health Monitor"),
			icon: Codicon.pulse,
			viewId: AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID,
			order: 85,
			viewCtor: HealthMonitorViewPane,
		});

		// 10.6 Workspace Template (order: 87)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.workspaceTemplate',
			title: localize2('agentStudio.workspaceTemplate.title', "Workspace Templates"),
			icon: Codicon.repo,
			viewId: AGENT_STUDIO_WORKSPACE_TEMPLATE_VIEW_ID,
			order: 87,
			viewCtor: WorkspaceTemplateViewPane,
		});

		// 10.7 Crew/Team (order: 89)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.crewTeam',
			title: localize2('agentStudio.crewTeam.title', "Crew/Team"),
			icon: Codicon.organization,
			viewId: AGENT_STUDIO_CREW_TEAM_VIEW_ID,
			order: 89,
			viewCtor: CrewTeamViewPane,
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
