/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
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
	AGENT_STUDIO_PERSONAL_VIEW_ID,
	AGENT_STUDIO_SETTINGS_VIEW_ID,
	AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID,
	AGENT_STUDIO_WORKSPACE_TEMPLATE_VIEW_ID,
	AGENT_STUDIO_CREW_TEAM_VIEW_ID,
	AGENT_STUDIO_ACTIVE_CONTEXT_KEY,
	AGENT_STUDIO_KNOT_TOKEN_SETTING,
	AGENT_STUDIO_KNOT_AGENT_ID_SETTING,
	AGENT_STUDIO_KNOT_BASE_URL_SETTING,
	AGENT_STUDIO_DATA_PATH_SETTING,
} from '../common/constants.js';
import { AgentTaskBoardService } from './agentTaskBoardService.js';
import { AgentStudioProvider } from './agentStudioProvider.js';
import { AgentStudioSidebarView } from './agentStudioSidebarView.js';
import { AgentStudioActiveContext } from '../../../common/contextkeys.js';
import { AgentStudioEditorPane } from './agentStudioEditorPane.js';
import { AgentStudioEditorInput } from './agentStudioEditorInput.js';
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
import { PersonalViewPane } from './views/personalView.js';
import { SettingsViewPane } from './views/settingsView.js';
import { HealthMonitorViewPane } from './views/healthMonitorView.js';
import { WorkspaceTemplateViewPane } from './views/workspaceTemplateView.js';
import { CrewTeamViewPane } from './views/crewTeamView.js';

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
const personalIcon = registerIcon('agent-studio-personal', Codicon.person, localize('personalIcon', "Personal"));
const settingsIcon = registerIcon('agent-studio-settings', Codicon.gear, localize('settingsIcon', "Settings"));

// --- Configuration ---------------------------------------------------------------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	properties: {
		[AGENT_STUDIO_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.enabled', "Enable Agent Studio multi-agent workspace in the Sessions window."),
		},
		[AGENT_STUDIO_KNOT_TOKEN_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.knot.token', "Knot AG-UI authentication token."),
		},
		[AGENT_STUDIO_KNOT_AGENT_ID_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.knot.agentId', "Knot AG-UI agent ID."),
		},
		[AGENT_STUDIO_KNOT_BASE_URL_SETTING]: {
			type: 'string',
			default: 'https://knot.woa.com',
			description: localize('agentStudio.knot.baseUrl', "Knot AG-UI base URL."),
		},
		[AGENT_STUDIO_DATA_PATH_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.dataPath', "Custom data directory path for Agent Studio. Defaults to workspace .agent-studio/data/."),
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
registerSingleton(IWorkspaceRegistry, WorkspaceRegistryService, InstantiationType.Delayed);
registerSingleton(IAgentInstanceService, AgentInstanceService, InstantiationType.Delayed);
registerSingleton(IAgentGalleryService, AgentGalleryService, InstantiationType.Delayed);
registerSingleton(IGitCommitService, GitCommitService, InstantiationType.Delayed);
registerSingleton(IAgentSchedulerService, AgentSchedulerService, InstantiationType.Delayed);
registerSingleton(IHealthMonitorService, HealthMonitorService, InstantiationType.Delayed);
registerSingleton(IWorkspaceTemplateService, WorkspaceTemplateService, InstantiationType.Delayed);
registerSingleton(ICrewTeamService, CrewTeamService, InstantiationType.Delayed);
registerSingleton(IEventBridgeService, EventBridgeService, InstantiationType.Delayed);

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

		// --- Bottom-aligned icons (order: 100+) -------------------------------

		// 11. Personal (order: 100 - pushed to bottom)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.personal',
			title: localize2('agentStudio.personal.title', "Personal"),
			icon: personalIcon,
			viewId: AGENT_STUDIO_PERSONAL_VIEW_ID,
			order: 100,
			viewCtor: PersonalViewPane,
		});

		// 12. Settings (order: 110 - pushed to bottom, below Personal)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.settings',
			title: localize2('agentStudio.settings.title', "Settings"),
			icon: settingsIcon,
			viewId: AGENT_STUDIO_SETTINGS_VIEW_ID,
			order: 110,
			viewCtor: SettingsViewPane,
		});
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

