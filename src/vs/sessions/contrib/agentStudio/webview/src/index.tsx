/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Entry Point
 *--------------------------------------------------------------------------------------------*/

// Mark bundle as loaded for early diagnostics
(window as any).__AS_BUNDLE_LOADED__ = true;
console.log('[AS-BUNDLE] index.tsx: module execution started');

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initMessageClient } from './bridge/messageClient.js';
import { handleStreamDelta, handleStreamComplete, handleStreamError } from './bridge/streamHandler.js';
import { useEmployeeStore } from './store/useEmployeeStore.js';
import { useProviderStore } from './store/useProviderStore.js';
import { useThemeStore } from './store/useThemeStore.js';
import { useWorkspaceSessionStore } from './store/useWorkspaceSessionStore.js';
import { useChatStore } from './store/useChatStore.js';
import { useOrchestrationStore } from './store/useOrchestrationStore.js';
import { dispatchConfigMdEvent } from './features/configmd/configMdBridge.js';
import './styles/globals.css';
import './styles/themes.css';
import './styles/chat-enhanced.css';
import './styles/configmd.css';
import './styles/agent-editor.css';

// Initialize the message bridge (must happen before React mounts)
initMessageClient((type, data) => {
	switch (type) {
		case 'chat.stream.delta':
			handleStreamDelta(data as Parameters<typeof handleStreamDelta>[0]);
			break;
		case 'chat.stream.complete': {
			const completeData = data as Parameters<typeof handleStreamComplete>[0];
			const msg = completeData.message as Record<string, unknown> | undefined;
			console.log(`[AgentStudio] Routing chat.stream.complete → handleStreamComplete, ` +
				`employeeId=${completeData.employeeId}, ` +
				`hostMsg.contentLen=${typeof msg?.content === 'string' ? msg.content.length : 'N/A'}, ` +
				`hostMsg.error=${msg?.error ?? 'none'}`);
			handleStreamComplete(completeData);
			break;
		}
		case 'chat.stream.error': {
			const errData = data as Parameters<typeof handleStreamError>[0];
			console.error(`[AgentStudio] Routing chat.stream.error → handleStreamError, ` +
				`employeeId=${errData.employeeId}, error="${errData.error}"`);
			handleStreamError(errData);
			break;
		}
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
				useThemeStore.getState().setTheme(theme);
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
		case 'workspace.sessionUpdated': {
			const detail = data as { workspaceId?: string; agentId?: string; agentSessionId?: string };
			// If host assigned a new agentSessionId, update the session store and chat store
			if (detail.agentId && detail.agentSessionId) {
				const sessionStore = useWorkspaceSessionStore.getState();
				const activeSession = sessionStore.getActiveSession();
				if (activeSession) {
					// Update the agentSessions array in the active session
					const existing = activeSession.agentSessions.find(a => a.agentId === detail.agentId);
					if (!existing) {
						activeSession.agentSessions.push({
							agentId: detail.agentId!,
							sessionId: detail.agentSessionId!,
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							messageCount: 0,
							status: 'active',
						});
						// Force re-render by updating sessions array
						useWorkspaceSessionStore.setState(state => ({
							sessions: [...state.sessions],
						}));
					}
					// Update the chatStore's active agentSessionId if it's the same agent
					const chatStore = useChatStore.getState();
					if (chatStore.activeEmployeeId === detail.agentId) {
						useChatStore.setState({ activeAgentSessionId: detail.agentSessionId });
					}
				}
			}
			// Also reload the session list if workspaceId is provided
			if (detail.workspaceId) {
				useWorkspaceSessionStore.getState().loadSessions(detail.workspaceId);
			}
			break;
		}
		case 'workspace.sessionCreated':
		case 'workspace.sessionChanged':
		case 'workspace.modeChanged':
			window.dispatchEvent(new CustomEvent('agentStudio:session-event', { detail: data }));
			break;
		case 'orchestration.planCreated':
		case 'orchestration.planUpdated': {
			const plan = data as import('./store/useOrchestrationStore.js').OrchestrationPlan;
			useOrchestrationStore.getState().updatePlanFromEvent(plan);
			window.dispatchEvent(new CustomEvent('agentStudio:orchestration-plan-updated', { detail: plan }));
			break;
		}
		case 'orchestration.taskUpdated': {
			const { planId, task } = data as { planId: string; task: import('./store/useOrchestrationStore.js').PlanTask };
			useOrchestrationStore.getState().updateTaskFromEvent(planId, task);
			window.dispatchEvent(new CustomEvent('agentStudio:orchestration-task-updated', { detail: data }));
			break;
		}
		case 'configmd.sourceChanged':
		case 'configmd.htmlRendered':
		case 'configmd.command':
		case 'configmd.error': {
			const detail = data as { employeeId: string };
			if (detail?.employeeId) {
				dispatchConfigMdEvent(detail.employeeId, type, data);
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
	// Apply initial theme from Host before first render
	const initialTheme = (window as any).__AGENT_STUDIO_INITIAL_THEME__ as string | undefined;
	useThemeStore.getState().setTheme(initialTheme || '');

	const root = createRoot(container);
	root.render(React.createElement(App));
}
