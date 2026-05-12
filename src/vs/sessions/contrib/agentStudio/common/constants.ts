/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Configuration keys — feature toggles
export const AGENT_STUDIO_ENABLED_SETTING = 'sessions.agentStudio.enabled';
export const AGENT_STUDIO_DATA_PATH_SETTING = 'sessions.agentStudio.dataPath';

// NOTE: Knot AG-UI configuration keys are defined in the knot-agui extension's
// package.json (contributes.configuration) and discovered at runtime via
// ISettingsTabRegistry (contributes.agentStudioSettingsTab). Do NOT add
// Knot-specific config keys here — they belong to the plugin.

// Configuration keys — Preferences
export const AGENT_STUDIO_THEME_SETTING = 'sessions.agentStudio.preferences.theme';
export const AGENT_STUDIO_LANGUAGE_SETTING = 'sessions.agentStudio.preferences.language';
export const AGENT_STUDIO_SEND_KEY_SETTING = 'sessions.agentStudio.preferences.sendKey';
export const AGENT_STUDIO_DEFAULT_MODEL_SETTING = 'sessions.agentStudio.preferences.defaultModel';
export const AGENT_STUDIO_BOT_NAME_SETTING = 'sessions.agentStudio.preferences.botName';
export const AGENT_STUDIO_SHOW_TOKEN_USAGE_SETTING = 'sessions.agentStudio.preferences.showTokenUsage';
export const AGENT_STUDIO_NOTIFICATION_SOUND_SETTING = 'sessions.agentStudio.preferences.notificationSound';
export const AGENT_STUDIO_BROWSER_NOTIFICATIONS_SETTING = 'sessions.agentStudio.preferences.browserNotifications';
export const AGENT_STUDIO_CHECK_UPDATES_SETTING = 'sessions.agentStudio.preferences.checkUpdates';

// Configuration keys — Auxiliary Models
export const AGENT_STUDIO_AUX_VISION_PROVIDER = 'sessions.agentStudio.aux.vision.provider';
export const AGENT_STUDIO_AUX_VISION_MODEL = 'sessions.agentStudio.aux.vision.model';
export const AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER = 'sessions.agentStudio.aux.webExtract.provider';
export const AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL = 'sessions.agentStudio.aux.webExtract.model';
export const AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER = 'sessions.agentStudio.aux.sessionSearch.provider';
export const AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL = 'sessions.agentStudio.aux.sessionSearch.model';
export const AGENT_STUDIO_AUX_COMPRESSION_PROVIDER = 'sessions.agentStudio.aux.compression.provider';
export const AGENT_STUDIO_AUX_COMPRESSION_MODEL = 'sessions.agentStudio.aux.compression.model';
export const AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER = 'sessions.agentStudio.aux.goalJudge.provider';
export const AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL = 'sessions.agentStudio.aux.goalJudge.model';
export const AGENT_STUDIO_AUX_CURATOR_PROVIDER = 'sessions.agentStudio.aux.curator.provider';
export const AGENT_STUDIO_AUX_CURATOR_MODEL = 'sessions.agentStudio.aux.curator.model';

// Configuration keys — CLI
export const AGENT_STUDIO_CLI_PATH_SETTING = 'sessions.agentStudio.cli.cliPath';
export const AGENT_STUDIO_CLI_DEFAULT_WORKDIR_SETTING = 'sessions.agentStudio.cli.defaultWorkdir';
export const AGENT_STUDIO_CLI_AUTO_CONNECT_SETTING = 'sessions.agentStudio.cli.autoConnect';
export const AGENT_STUDIO_CLI_SAVE_HISTORY_SETTING = 'sessions.agentStudio.cli.saveHistory';

// ViewContainer IDs
export const AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID = 'agentStudio.chatBar';
export const AGENT_STUDIO_SIDEBAR_VIEW_CONTAINER_ID = 'agentStudio.sidebar';
export const AGENT_STUDIO_AUXBAR_VIEW_CONTAINER_ID = 'agentStudio.auxiliaryBar';

// View IDs
export const AGENT_STUDIO_MAIN_VIEW_ID = 'agentStudio.mainView';
export const AGENT_STUDIO_CANVAS_VIEW_ID = 'agentStudio.canvasView';
export const AGENT_STUDIO_CHAT_VIEW_ID = 'agentStudio.chatView';
export const AGENT_STUDIO_TASKBOARD_VIEW_ID = 'agentStudio.taskBoardView';
export const AGENT_STUDIO_SESSIONS_VIEW_ID = 'agentStudio.sessionsView';
export const AGENT_STUDIO_WORKSPACES_VIEW_ID = 'agentStudio.workspacesView';
export const AGENT_STUDIO_DELEGATION_VIEW_ID = 'agentStudio.delegationView';

// Toolbar View IDs (left sidebar toolbar)
export const AGENT_STUDIO_TOOLBAR_VIEW_ID = 'agentStudio.toolbarView';
export const AGENT_STUDIO_CLAW_CHAT_VIEW_ID = 'agentStudio.clawChatView';
export const AGENT_STUDIO_WORKSPACE_VIEW_ID = 'agentStudio.workspaceView';
export const AGENT_STUDIO_PRESET_AGENT_VIEW_ID = 'agentStudio.presetAgentView';
export const AGENT_STUDIO_SKILLS_VIEW_ID = 'agentStudio.skillsView';
export const AGENT_STUDIO_TASKS_VIEW_ID = 'agentStudio.tasksView';
export const AGENT_STUDIO_SCHEDULE_VIEW_ID = 'agentStudio.scheduleView';
export const AGENT_STUDIO_TOOLS_VIEW_ID = 'agentStudio.toolsView';
export const AGENT_STUDIO_CHANGES_VIEW_ID = 'agentStudio.changesView';
export const AGENT_STUDIO_SEARCH_VIEW_ID = 'agentStudio.searchView';
export const AGENT_STUDIO_PLUGINS_VIEW_ID = 'agentStudio.pluginsView';
export const AGENT_STUDIO_PERSONAL_VIEW_ID = 'agentStudio.personalView';
export const AGENT_STUDIO_SETTINGS_VIEW_ID = 'agentStudio.settingsView';
export const AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID = 'agentStudio.healthMonitorView';
export const AGENT_STUDIO_WORKSPACE_TEMPLATE_VIEW_ID = 'agentStudio.workspaceTemplateView';
export const AGENT_STUDIO_CREW_TEAM_VIEW_ID = 'agentStudio.crewTeamView';

// Panel types (passed to WebView to select which React component to render)
// 'settings' is rendered natively (no WebView) via SettingsEditorPane.
export type AgentStudioPanelType = 'canvas' | 'chat' | 'taskboard' | 'settings';

// Provider ID
export const AGENT_STUDIO_PROVIDER_ID = 'agentStudio';

// ContextKey names
export const AGENT_STUDIO_ACTIVE_CONTEXT_KEY = 'agentStudio.active';

// WebView
export const AGENT_STUDIO_WEBVIEW_TYPE = 'agentStudio.webview';

// Data file names
export const DATA_FILE_EMPLOYEES = 'employees.json';
export const DATA_FILE_WORKSPACES = 'workspaces.json';
export const DATA_FILE_DELEGATIONS = 'delegations.json';
export const DATA_FILE_SESSIONS = 'sessions.json';

// Workspace-local data directory name (stored inside the workspace folder)
export const WORKSPACE_DATA_DIR = '.sarosisworkspace';
