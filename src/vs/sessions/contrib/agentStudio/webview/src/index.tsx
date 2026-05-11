/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Entry Point
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initMessageClient } from './bridge/messageClient.js';
import { handleStreamDelta, handleStreamComplete, handleStreamError } from './bridge/streamHandler.js';
import './styles/globals.css';

// Initialize the message bridge (must happen before React mounts)
initMessageClient((type, data) => {
	switch (type) {
		case 'chat.stream.delta':
			handleStreamDelta(data as Parameters<typeof handleStreamDelta>[0]);
			break;
		case 'chat.stream.complete':
			handleStreamComplete(data as Parameters<typeof handleStreamComplete>[0]);
			break;
		case 'chat.stream.error':
			handleStreamError(data as Parameters<typeof handleStreamError>[0]);
			break;
		case 'employees.changed':
			window.dispatchEvent(new CustomEvent('agentStudio:employees-changed'));
			break;
		case 'workspace.changed':
			window.dispatchEvent(new CustomEvent('agentStudio:workspace-changed', { detail: data }));
			break;
		case 'workspace.activeChanged':
			window.dispatchEvent(new CustomEvent('agentStudio:workspace-active-changed', { detail: data }));
			break;
		case 'delegations.changed':
			window.dispatchEvent(new CustomEvent('agentStudio:delegations-changed'));
			break;
		case 'taskBoard.changed':
			window.dispatchEvent(new CustomEvent('agentStudio:taskboard-changed', { detail: data }));
			break;
		case 'session.activated':
			window.dispatchEvent(new CustomEvent('agentStudio:session-activated', { detail: data }));
			break;
		case 'theme.changed':
			window.dispatchEvent(new CustomEvent('agentStudio:theme-changed', { detail: data }));
			break;
		default:
			console.warn(`[AgentStudio] Unknown event type: ${type}`);
	}
});

// Mount React application
const container = document.getElementById('root');
if (container) {
	const root = createRoot(container);
	root.render(React.createElement(App));
}
