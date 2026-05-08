/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Configuration keys
export const AGENT_STUDIO_ENABLED_SETTING = 'sessions.agentStudio.enabled';
export const AGENT_STUDIO_KNOT_TOKEN_SETTING = 'sessions.agentStudio.knot.token';
export const AGENT_STUDIO_KNOT_AGENT_ID_SETTING = 'sessions.agentStudio.knot.agentId';
export const AGENT_STUDIO_KNOT_BASE_URL_SETTING = 'sessions.agentStudio.knot.baseUrl';
export const AGENT_STUDIO_DATA_PATH_SETTING = 'sessions.agentStudio.dataPath';

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

// Panel types (passed to WebView to select which React component to render)
export type AgentStudioPanelType = 'canvas' | 'chat' | 'taskboard';

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
