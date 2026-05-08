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
import { AgentTaskBoardService } from './agentTaskBoardService.js';
import { AgentStudioProvider } from './agentStudioProvider.js';
import { AgentStudioCanvasViewPane, AgentStudioChatViewPane, AgentStudioTaskBoardViewPane } from './agentStudioViewPane.js';
import { AgentStudioSidebarView } from './agentStudioSidebarView.js';
import { DelegationTreeView } from './delegationTreeView.js';
import { AgentStudioActiveContext } from '../../../common/contextkeys.js';
import { AgentStudioEditorPane } from './agentStudioEditorPane.js';
import { AgentStudioEditorInput } from './agentStudioEditorInput.js';

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
	AGENT_STUDIO_ACTIVE_CONTEXT_KEY,
	AGENT_STUDIO_KNOT_TOKEN_SETTING,
	AGENT_STUDIO_KNOT_AGENT_ID_SETTING,
	AGENT_STUDIO_KNOT_BASE_URL_SETTING,
	AGENT_STUDIO_DATA_PATH_SETTING,
} from '../common/constants.js';

// ─── Icons ──────────────────────────────────────────────────────────────────────

const agentStudioIcon = registerIcon('agent-studio', Codicon.hubot, localize('agentStudioIcon', "Icon for Agent Studio."));

// ─── Configuration ──────────────────────────────────────────────────────────────

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

// ─── Services Registration ──────────────────────────────────────────────────────

registerSingleton(IAgentStudioService, AgentStudioService, InstantiationType.Delayed);
registerSingleton(IAgentChatService, AgentChatService, InstantiationType.Delayed);
registerSingleton(IAgentDelegationService, AgentDelegationService, InstantiationType.Delayed);
registerSingleton(IAgentTaskBoardService, AgentTaskBoardService, InstantiationType.Delayed);

// ─── EditorPane Registration ────────────────────────────────────────────────────
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

// ─── Provider Contribution ──────────────────────────────────────────────────────

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

// ─── ViewContainer & Views Registration ─────────────────────────────────────────

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

	// ─── 3 Independent ViewContainers for Canvas, Chat, TaskBoard ───────────
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

		// ─── Sidebar View Container ──────────────────────────────────────────
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
