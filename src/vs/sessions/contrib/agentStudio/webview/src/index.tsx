/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Entry Point
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initMessageClient } from './bridge/messageClient.js';
import { handleStreamDelta, handleStreamComplete, handleStreamError } from './bridge/streamHandler.js';
import { useEmployeeStore } from './store/useEmployeeStore.js';
import { useProviderStore } from './store/useProviderStore.js';
import { useThemeStore, type AgentStudioTheme } from './store/useThemeStore.js';
import './styles/globals.css';
import './styles/themes.css';

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
		case 'employee.selected': {
			const { employeeId } = (data as { employeeId: string | null }) ?? {};
			console.log(`[AgentStudio] received 'employee.selected' event: employeeId=${employeeId}, panelType=${(window as any).__AGENT_STUDIO_PANEL_TYPE__}`);
			if (employeeId !== undefined) {
				// Update the store directly (bypass postMessage to avoid echo loop)
				console.log(`[AgentStudio] → useEmployeeStore.setState({ selectedEmployeeId: '${employeeId}' })`);
				useEmployeeStore.setState({ selectedEmployeeId: employeeId });
			} else {
				console.warn(`[AgentStudio] employee.selected event missing employeeId, data=`, data);
			}
			break;
		}
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
		case 'theme.changed': {
			const { theme } = (data as { theme: string }) ?? {};
			if (theme) {
				useThemeStore.getState().setTheme(theme as AgentStudioTheme);
			}
			window.dispatchEvent(new CustomEvent('agentStudio:theme-changed', { detail: data }));
			break;
		}
		case 'providers.changed': {
			const { providers } = (data as { providers: any[] }) ?? {};
			if (providers) {
				useProviderStore.getState().updateProviders(providers);
			}
			break;
		}
		default:
			console.warn(`[AgentStudio] Unknown event type: ${type}`);
	}
});

// Mount React application
const container = document.getElementById('root');
if (container) {
	// Apply initial theme from Host before first render (always, including 'dark')
	const initialTheme = (window as any).__AGENT_STUDIO_INITIAL_THEME__ as string | undefined;
	useThemeStore.getState().setTheme((initialTheme || 'dark') as AgentStudioTheme);

	const root = createRoot(container);
	root.render(React.createElement(App));
}
