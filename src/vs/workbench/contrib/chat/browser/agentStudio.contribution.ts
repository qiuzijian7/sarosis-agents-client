/*---------------------------------------------------------------------------------------------
 *  Agent Studio - Main Window Integration
 *  Registers Agent Studio services for use in the main workbench window (AuxiliaryBar/Chat position).
 *  This replaces the Sessions window approach: Agent Studio is now embedded directly.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';

import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService } from '../../../../sessions/contrib/agentStudio/common/agentStudio.js';
import { AgentStudioService } from '../../../../sessions/contrib/agentStudio/browser/agentStudioService.js';
import { AgentChatService } from '../../../../sessions/contrib/agentStudio/browser/agentChatService.js';
import { AgentDelegationService } from '../../../../sessions/contrib/agentStudio/browser/agentDelegationService.js';
import { AgentTaskBoardService } from '../../../../sessions/contrib/agentStudio/browser/agentTaskBoardService.js';
import {
	AGENT_STUDIO_ENABLED_SETTING,
	AGENT_STUDIO_KNOT_TOKEN_SETTING,
	AGENT_STUDIO_KNOT_AGENT_ID_SETTING,
	AGENT_STUDIO_KNOT_BASE_URL_SETTING,
	AGENT_STUDIO_DATA_PATH_SETTING,
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
} from '../../../../sessions/contrib/agentStudio/common/constants.js';
import { ClawChatViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/clawChatView.js';
import { WorkspaceViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/workspaceView.js';
import { PresetAgentViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/presetAgentView.js';
import { SkillsViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/skillsView.js';
import { TasksViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/tasksView.js';
import { ScheduleViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/scheduleView.js';
import { ToolsViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/toolsView.js';
import { ChangesViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/changesView.js';
import { AgentStudioSearchViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/searchView.js';
import { PluginsViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/pluginsView.js';
import { PersonalViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/personalView.js';
import { SettingsViewPane } from '../../../../sessions/contrib/agentStudio/browser/views/settingsView.js';

// ─── Configuration ──────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentStudio',
	properties: {
		[AGENT_STUDIO_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.enabled', "Enable Agent Studio in the Chat panel position."),
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
			description: localize('agentStudio.dataPath', "Custom data directory path for Agent Studio."),
		},
	},
});

// ─── Services Registration ──────────────────────────────────────────────────────

registerSingleton(IAgentStudioService, AgentStudioService, InstantiationType.Delayed);
registerSingleton(IAgentChatService, AgentChatService, InstantiationType.Delayed);
registerSingleton(IAgentDelegationService, AgentDelegationService, InstantiationType.Delayed);
registerSingleton(IAgentTaskBoardService, AgentTaskBoardService, InstantiationType.Delayed);

// ─── Toolbar Icons Registration (12 independent sidebar icons) ──────────────────
// [Sarosis] These must be registered in the main window entry path so they appear
// in the main window's Activity Bar. The sessions window entry also registers them
// (in sessions/contrib/agentStudio/browser/agentStudio.contribution.ts), but that
// code is never loaded by the main window.

console.log('[Sarosis-Debug] agentStudio.contribution.ts (MAIN WINDOW): Registering 12 toolbar icons');

const clawChatIcon = registerIcon('agent-studio-claw-chat-main', Codicon.comment, localize('clawChatIcon', "Claw Chat"));
const workspaceIcon = registerIcon('agent-studio-workspace-main', Codicon.repo, localize('workspaceIcon', "Workspace"));
const presetAgentIcon = registerIcon('agent-studio-preset-agent-main', Codicon.robot, localize('presetAgentIcon', "Preset Agent"));
const skillsIcon = registerIcon('agent-studio-skills-main', Codicon.lightbulb, localize('skillsIcon', "Skills"));
const tasksIcon = registerIcon('agent-studio-tasks-main', Codicon.tasklist, localize('tasksIcon', "Tasks"));
const scheduleIcon = registerIcon('agent-studio-schedule-main', Codicon.calendar, localize('scheduleIcon', "Schedule"));
const toolsIcon = registerIcon('agent-studio-tools-main', Codicon.tools, localize('toolsIcon', "Tools"));
const changesIcon = registerIcon('agent-studio-changes-main', Codicon.diff, localize('changesIcon', "Changes"));
const searchIcon = registerIcon('agent-studio-search-main', Codicon.search, localize('searchIcon', "Search"));
const pluginsIcon = registerIcon('agent-studio-plugins-main', Codicon.package, localize('pluginsIcon', "Plugins"));
const personalIcon = registerIcon('agent-studio-personal-main', Codicon.person, localize('personalIcon', "Personal"));
const settingsIcon = registerIcon('agent-studio-settings-main', Codicon.gear, localize('settingsIcon', "Settings"));

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

interface ToolIconConfig {
	id: string;
	title: ReturnType<typeof localize2>;
	icon: any;
	viewId: string;
	order: number;
	viewCtor: any;
}

function registerToolIcon(config: ToolIconConfig): void {
	const container = viewContainerRegistry.registerViewContainer({
		id: config.id,
		title: config.title,
		icon: config.icon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [config.id, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: config.id,
		hideIfEmpty: false,
		order: config.order,
	}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

	viewsRegistry.registerViews([{
		id: config.viewId,
		name: config.title,
		ctorDescriptor: new SyncDescriptor(config.viewCtor),
		canToggleVisibility: false,
		canMoveView: false,
		order: 0,
	}], container);
}

// 1. Claw Chat
registerToolIcon({ id: 'agentStudio.clawChat', title: localize2('agentStudio.clawChat.title', "Claw Chat"), icon: clawChatIcon, viewId: AGENT_STUDIO_CLAW_CHAT_VIEW_ID, order: 0, viewCtor: ClawChatViewPane });
// 2. Workspace
registerToolIcon({ id: 'agentStudio.workspace', title: localize2('agentStudio.workspace.title', "Workspace"), icon: workspaceIcon, viewId: AGENT_STUDIO_WORKSPACE_VIEW_ID, order: 10, viewCtor: WorkspaceViewPane });
// 3. Preset Agent
registerToolIcon({ id: 'agentStudio.presetAgent', title: localize2('agentStudio.presetAgent.title', "Preset Agent"), icon: presetAgentIcon, viewId: AGENT_STUDIO_PRESET_AGENT_VIEW_ID, order: 20, viewCtor: PresetAgentViewPane });
// 4. Skills
registerToolIcon({ id: 'agentStudio.skills', title: localize2('agentStudio.skills.title', "Skills"), icon: skillsIcon, viewId: AGENT_STUDIO_SKILLS_VIEW_ID, order: 30, viewCtor: SkillsViewPane });
// 5. Tasks
registerToolIcon({ id: 'agentStudio.tasks', title: localize2('agentStudio.tasks.title', "Tasks"), icon: tasksIcon, viewId: AGENT_STUDIO_TASKS_VIEW_ID, order: 40, viewCtor: TasksViewPane });
// 6. Schedule
registerToolIcon({ id: 'agentStudio.schedule', title: localize2('agentStudio.schedule.title', "Schedule"), icon: scheduleIcon, viewId: AGENT_STUDIO_SCHEDULE_VIEW_ID, order: 50, viewCtor: ScheduleViewPane });
// 7. Tools
registerToolIcon({ id: 'agentStudio.tools', title: localize2('agentStudio.tools.title', "Tools"), icon: toolsIcon, viewId: AGENT_STUDIO_TOOLS_VIEW_ID, order: 60, viewCtor: ToolsViewPane });
// 8. Changes
registerToolIcon({ id: 'agentStudio.changes', title: localize2('agentStudio.changes.title', "Changes"), icon: changesIcon, viewId: AGENT_STUDIO_CHANGES_VIEW_ID, order: 70, viewCtor: ChangesViewPane });
// 9. Search
registerToolIcon({ id: 'agentStudio.search', title: localize2('agentStudio.search.title', "Search"), icon: searchIcon, viewId: 'workbench.view.search', order: 80, viewCtor: AgentStudioSearchViewPane });
// 10. Plugins
registerToolIcon({ id: 'agentStudio.plugins', title: localize2('agentStudio.plugins.title', "Plugins"), icon: pluginsIcon, viewId: AGENT_STUDIO_PLUGINS_VIEW_ID, order: 90, viewCtor: PluginsViewPane });
// 11. Personal
registerToolIcon({ id: 'agentStudio.personal', title: localize2('agentStudio.personal.title', "Personal"), icon: personalIcon, viewId: AGENT_STUDIO_PERSONAL_VIEW_ID, order: 100, viewCtor: PersonalViewPane });
// 12. Settings
registerToolIcon({ id: 'agentStudio.settings', title: localize2('agentStudio.settings.title', "Settings"), icon: settingsIcon, viewId: AGENT_STUDIO_SETTINGS_VIEW_ID, order: 110, viewCtor: SettingsViewPane });

console.log('[Sarosis-Debug] agentStudio.contribution.ts (MAIN WINDOW): 12 toolbar icons registered successfully');
