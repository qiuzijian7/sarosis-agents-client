/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

console.log('[Sarosis-Debug] agentStudioToolbar.contribution.ts module LOADED');

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

import { 
	AGENT_STUDIO_ACTIVE_CONTEXT_KEY,
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
} from '../common/constants.js';

import { AgentStudioToolbarView } from './agentStudioToolbarView.js';

// --- Icons ----------------------------------------------------------------------

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

// --- Toolbar Contribution ------------------------------------------------------

class AgentStudioToolbarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.agentStudioToolbar';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		const enabled = this.configurationService.getValue<boolean>('sessions.agentStudio.enabled');
		if (!enabled) {
			return;
		}

		this._registerToolbarIcons();
	}

	private _registerToolbarIcons(): void {
		const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

		// --- Top-aligned icons (order: 0-90) -----------------------------

		// 1. Claw Chat (order: 0)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.clawChat',
			title: localize2('agentStudio.clawChat.title', "Claw Chat"),
			icon: clawChatIcon,
			viewId: AGENT_STUDIO_CLAW_CHAT_VIEW_ID,
			order: 0,
		});

		// 2. Workspace (order: 10)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.workspace',
			title: localize2('agentStudio.workspace.title', "Workspace"),
			icon: workspaceIcon,
			viewId: AGENT_STUDIO_WORKSPACE_VIEW_ID,
			order: 10,
		});

		// 3. Preset Agent (order: 20)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.presetAgent',
			title: localize2('agentStudio.presetAgent.title', "Preset Agent"),
			icon: presetAgentIcon,
			viewId: AGENT_STUDIO_PRESET_AGENT_VIEW_ID,
			order: 20,
		});

		// 4. Skills (order: 30)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.skills',
			title: localize2('agentStudio.skills.title', "Skills"),
			icon: skillsIcon,
			viewId: AGENT_STUDIO_SKILLS_VIEW_ID,
			order: 30,
		});

		// 5. Tasks (order: 40)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.tasks',
			title: localize2('agentStudio.tasks.title', "Tasks"),
			icon: tasksIcon,
			viewId: AGENT_STUDIO_TASKS_VIEW_ID,
			order: 40,
		});

		// 6. Schedule (order: 50)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.schedule',
			title: localize2('agentStudio.schedule.title', "Schedule"),
			icon: scheduleIcon,
			viewId: AGENT_STUDIO_SCHEDULE_VIEW_ID,
			order: 50,
		});

		// 7. Tools (order: 60)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.tools',
			title: localize2('agentStudio.tools.title', "Tools"),
			icon: toolsIcon,
			viewId: AGENT_STUDIO_TOOLS_VIEW_ID,
			order: 60,
		});

		// 8. Changes (order: 70)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.changes',
			title: localize2('agentStudio.changes.title', "Changes"),
			icon: changesIcon,
			viewId: AGENT_STUDIO_CHANGES_VIEW_ID,
			order: 70,
		});

		// 9. Search (order: 80)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.search',
			title: localize2('agentStudio.search.title', "Search"),
			icon: searchIcon,
			viewId: 'workbench.view.search',
			order: 80,
		});

		// 10. Plugins (order: 90)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.plugins',
			title: localize2('agentStudio.plugins.title', "Plugins"),
			icon: pluginsIcon,
			viewId: AGENT_STUDIO_PLUGINS_VIEW_ID,
			order: 90,
		});

		// --- Bottom-aligned icons (order: 100+) -------------------------------

		// 11. Personal (order: 100 - pushed to bottom)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.personal',
			title: localize2('agentStudio.personal.title', "Personal"),
			icon: personalIcon,
			viewId: AGENT_STUDIO_PERSONAL_VIEW_ID,
			order: 100,
		});

		// 12. Settings (order: 110 - pushed to bottom, below Personal)
		this._registerToolIcon(viewContainerRegistry, viewsRegistry, {
			id: 'agentStudio.settings',
			title: localize2('agentStudio.settings.title', "Settings"),
			icon: settingsIcon,
			viewId: AGENT_STUDIO_SETTINGS_VIEW_ID,
			order: 110,
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
		}
	): void {
		// Register ViewContainer in Sidebar
		const container = viewContainerRegistry.registerViewContainer({
			id: config.id,
			title: config.title,
			icon: config.icon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [config.id, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: config.id,
			hideIfEmpty: false,
			order: config.order,
			windowEnablement: WindowEnablement.Sessions,
		}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

		// Register View inside the container
		viewsRegistry.registerViews([{
			id: config.viewId,
			name: config.title,
			ctorDescriptor: new SyncDescriptor(AgentStudioToolbarView),
			canToggleVisibility: false,
			canMoveView: false,
			order: 0,
			when: ContextKeyExpr.equals(AGENT_STUDIO_ACTIVE_CONTEXT_KEY, true),
			windowEnablement: WindowEnablement.Sessions,
		}], container);
	}
}

registerWorkbenchContribution2(AgentStudioToolbarContribution.ID, AgentStudioToolbarContribution, WorkbenchPhase.BlockStartup);
