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
import { localize, localize2 } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../../workbench/browser/editor.js';
import { IEditorGroupsService, GroupDirection } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService } from '../common/agentStudio.js';
import { AgentStudioService } from './agentStudioService.js';
import { AgentChatService } from './agentChatService.js';
import { AgentDelegationService } from './agentDelegationService.js';
import {
	AGENT_STUDIO_ENABLED_SETTING,
	AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID,
	AGENT_STUDIO_SIDEBAR_VIEW_CONTAINER_ID,
	AGENT_STUDIO_CANVAS_VIEW_ID,
	AGENT_STUDIO_CHAT_VIEW_ID,
	AGENT_STUDIO_TASKBOARD_VIEW_ID,
	AGENT_STUDIO_SESSIONS_VIEW_ID,
	AGENT_STUDIO_WORKSPACES_VIEW_ID,
	AGENT_STUDIO_DELEGATION_VIEW_ID,
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
	AGENT_STUDIO_ACTIVE_CONTEXT_KEY,
	AGENT_STUDIO_KNOT_TOKEN_SETTING,
	AGENT_STUDIO_KNOT_AGENT_ID_SETTING,
	AGENT_STUDIO_KNOT_BASE_URL_SETTING,
	AGENT_STUDIO_DATA_PATH_SETTING,
} from '../common/constants.js';
import { AgentTaskBoardService } from './agentTaskBoardService.js';
import { AgentStudioProvider } from './agentStudioProvider.js';
import { AgentStudioCanvasViewPane, AgentStudioChatViewPane, AgentStudioTaskBoardViewPane } from './agentStudioViewPane.js';
import { AgentStudioSidebarView } from './agentStudioSidebarView.js';
import { DelegationTreeView } from './delegationTreeView.js';
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

// --- DEBUG: Module load test -----------------------------------------------------
console.log('[Sarosis-Debug] agentStudio.contribution.ts module LOADED');
alert('[Sarosis-Debug] agentStudio.contribution.ts LOADED!!!');
(window as any).__AGENT_STUDIO_LOADED__ = true;
console.log('[Sarosis-Debug] Global flag set:', (window as any).__AGENT_STUDIO_LOADED__);

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
registerSingleton(IAgentDelegationService, AgentDelegationService, InstantiationType.Delayed);
registerSingleton(IAgentTaskBoardService, AgentTaskBoardService, InstantiationType.Delayed);

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
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		const enabled = this.configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING);
		console.log(`[Sarosis-Debug] AgentStudioProviderContribution: AGENT_STUDIO_ENABLED=${enabled}`);
		if (enabled) {
			const provider = this._register(this.instantiationService.createInstance(AgentStudioProvider));
			this._register(this.sessionsProvidersService.registerProvider(provider));

			// [Sarosis] Activate Agent Studio views immediately so canvas/chat UI is visible
			AgentStudioActiveContext.bindTo(this.contextKeyService).set(true);
			console.log(`[Sarosis-Debug] AgentStudioProviderContribution: AgentStudioActiveContext set to true`);

			// [Sarosis] Show Panel part so TaskBoard is visible (Panel defaults to hidden)
			if (!this.layoutService.isVisible(Parts.PANEL_PART)) {
				this.layoutService.setPartHidden(false, Parts.PANEL_PART);
				console.log(`[Sarosis-Debug] AgentStudioProviderContribution: Panel revealed for TaskBoard`);
			}

		// [Sarosis] Create dual editor zone layout:
		// Left editor group = normal files
		// Right editor group = Agent Studio custom panels only (unlocked for free docking)
		this._initDualEditorLayout();
		}
	}

	private async _initDualEditorLayout(): Promise<void> {
		try {
			// Get the active (left) editor group
			const leftGroup = this.editorGroupsService.activeGroup;

		// Create a new editor group to the right of the active group
		const rightGroup = this.editorGroupsService.addGroup(leftGroup, GroupDirection.RIGHT);

		// NOTE: Right group is NOT locked. Locking prevents normal drag-and-drop.
		// Instead, zone protection in editorGroupFinder.ts ensures non-agent-studio
		// editors are never routed to groups containing agent-studio editors.

		console.log(`[Sarosis-Debug] AgentStudioProviderContribution: Created dual editor layout. Left group=${leftGroup.id}, Right group (unlocked)=${rightGroup.id}`);

			// Open Agent Studio panels in the right group (unlocked)
			const canvasInput = AgentStudioEditorInput.getOrCreate('canvas');
			const taskboardInput = AgentStudioEditorInput.getOrCreate('taskboard');
			const chatInput = AgentStudioEditorInput.getOrCreate('chat');

			await this.editorService.openEditor(canvasInput, { pinned: true, preserveFocus: true }, rightGroup.id);
			await this.editorService.openEditor(taskboardInput, { pinned: true, preserveFocus: true }, rightGroup.id);
			await this.editorService.openEditor(chatInput, { pinned: true, preserveFocus: true }, rightGroup.id);

			// Ensure the group is unlocked — auto-lock or restored serialized state may have locked it
			rightGroup.lock(false);

			// [Sarosis] Force-unlock ALL groups that contain agent-studio editors.
			// This handles cases where the user rearranged panels (drag-and-drop) into
			// separate groups, and those groups got locked via auto-lock or serialized state.
			this._unlockAgentStudioGroups();

			console.log(`[Sarosis-Debug] AgentStudioProviderContribution: Opened canvas, taskboard, chat in right group (unlocked)`);
		} catch (err) {
			console.error(`[Sarosis-Debug] AgentStudioProviderContribution: Failed to init dual editor layout`, err);
		}
	}

	/**
	 * Force-unlock any editor group that contains an agent-studio editor.
	 * Agent studio groups should never be locked — zone protection handles isolation.
	 */
	private _unlockAgentStudioGroups(): void {
		for (const group of this.editorGroupsService.groups) {
			if (group.isLocked) {
				const hasAgentStudioEditor = group.editors.some(
					editor => editor.resource?.scheme === 'agent-studio'
				);
				if (hasAgentStudioEditor) {
					group.lock(false);
					console.log(`[Sarosis-Debug] AgentStudioProviderContribution: Force-unlocked group ${group.id} (contained agent-studio editors)`);
				}
			}
		}
	}
}

registerWorkbenchContribution2(AgentStudioProviderContribution.ID, AgentStudioProviderContribution, WorkbenchPhase.AfterRestored);

// --- ViewContainer & Views Registration ------------------------------------------

class RegisterAgentStudioViewsContribution implements IWorkbenchContribution {
	static readonly ID = 'sessions.registerAgentStudioViews';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
	) {
		if (!configurationService.getValue<boolean>(AGENT_STUDIO_ENABLED_SETTING)) {
			console.log(`[Sarosis-Debug] RegisterAgentStudioViewsContribution: DISABLED by setting`);
			return;
		}

		console.log(`[Sarosis-Debug] RegisterAgentStudioViewsContribution: registering Agent Studio views...`);
		const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

	// --- 3 Independent ViewContainers for Canvas, Chat, TaskBoard ------------
		// Each panel lives in a different workbench location so they are all
		// simultaneously visible without requiring tab switching.
		//   Canvas   → ChatBar       (main content area, always visible)
		//   Chat     → AuxiliaryBar  (right side, always visible)
		//   TaskBoard → Panel        (bottom area, shown when agent studio active)

		// Canvas ViewContainer (ChatBar — main content)
		const canvasContainer = viewContainerRegistry.registerViewContainer({
			id: `${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.canvas`,
			title: localize2('agentStudio.canvas.title', "Workspace Canvas"),
			icon: agentStudioIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [`${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.canvas`, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: `${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.canvas`,
			hideIfEmpty: false,
			order: 0,
			windowEnablement: WindowEnablement.Sessions,
		}, ViewContainerLocation.ChatBar, { isDefault: true, doNotRegisterOpenCommand: true });

		viewsRegistry.registerViews([{
			id: AGENT_STUDIO_CANVAS_VIEW_ID,
			name: localize2('agentStudio.canvasView', "Workspace Canvas"),
			ctorDescriptor: new SyncDescriptor(AgentStudioCanvasViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			order: 0,
			when: ContextKeyExpr.equals(AGENT_STUDIO_ACTIVE_CONTEXT_KEY, true),
			windowEnablement: WindowEnablement.Sessions,
		}], canvasContainer);

		// Chat ViewContainer (AuxiliaryBar — right side, default visible)
		const chatContainer = viewContainerRegistry.registerViewContainer({
			id: `${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.chat`,
			title: localize2('agentStudio.chat.title', "Agent Chat"),
			icon: agentStudioIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [`${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.chat`, { mergeViewWithContainerWhenSingleView: false }]),
			storageId: `${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.chat`,
			hideIfEmpty: false,
			order: 0,
			windowEnablement: WindowEnablement.Sessions,
		}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });

		viewsRegistry.registerViews([
			{
				id: AGENT_STUDIO_CHAT_VIEW_ID,
				name: localize2('agentStudio.chatView', "Agent Chat"),
				ctorDescriptor: new SyncDescriptor(AgentStudioChatViewPane),
				canToggleVisibility: false,
				canMoveView: true,
				order: 0,
				when: ContextKeyExpr.equals(AGENT_STUDIO_ACTIVE_CONTEXT_KEY, true),
				windowEnablement: WindowEnablement.Sessions,
			},
			{
				id: AGENT_STUDIO_DELEGATION_VIEW_ID,
				name: localize2('agentStudio.delegationView', "Task Delegation"),
				ctorDescriptor: new SyncDescriptor(DelegationTreeView),
				canToggleVisibility: true,
				canMoveView: true,
				order: 1,
				when: ContextKeyExpr.equals(AGENT_STUDIO_ACTIVE_CONTEXT_KEY, true),
				windowEnablement: WindowEnablement.Sessions,
			},
		], chatContainer);

		// TaskBoard ViewContainer (Panel — bottom area)
		const taskBoardContainer = viewContainerRegistry.registerViewContainer({
			id: `${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.taskBoard`,
			title: localize2('agentStudio.taskBoard.title', "Task Board"),
			icon: agentStudioIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [`${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.taskBoard`, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: `${AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID}.taskBoard`,
			hideIfEmpty: false,
			order: 0,
			windowEnablement: WindowEnablement.Sessions,
		}, ViewContainerLocation.Panel, { isDefault: true, doNotRegisterOpenCommand: true });

		viewsRegistry.registerViews([{
			id: AGENT_STUDIO_TASKBOARD_VIEW_ID,
			name: localize2('agentStudio.taskBoardView', "Task Board"),
			ctorDescriptor: new SyncDescriptor(AgentStudioTaskBoardViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			order: 0,
			when: ContextKeyExpr.equals(AGENT_STUDIO_ACTIVE_CONTEXT_KEY, true),
			windowEnablement: WindowEnablement.Sessions,
		}], taskBoardContainer);

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

		console.log(`[Sarosis-Debug] AgentStudioToolbarContribution: ALWAYS registering 12 toolbar icons (no guard)`);
		this._registerToolbarIcons();
		console.log(`[Sarosis-Debug] AgentStudioToolbarContribution: 12 toolbar icons registered`);
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
			title: any;
			icon: any;
			viewId: string;
			order: number;
			viewCtor: any;
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

