/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Entry Point
 *--------------------------------------------------------------------------------------------*/

// Mark bundle as loaded for early diagnostics
(window as any).__AS_BUNDLE_LOADED__ = true;
console.log('[AS-BUNDLE] index.tsx: module execution started');

// Dismiss the inline "Agent Studio 加载中..." placeholder (the pre/index.html
// fallback also dismisses it on this flag, but doing it here too ensures the
// placeholder is cleared even if the pre-script fallback is patched out).
(function dismissPreload() {
	const el = document.getElementById('as-preload');
	if (el && el.parentNode) { el.parentNode.removeChild(el); }
})();

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { perfTrace } from './utils/perfTrace.js';
import { initMessageClient, postMessage } from './bridge/messageClient.js';
import { useAgentStore } from './store/useAgentStore.js';
import { useProviderStore } from './store/useProviderStore.js';
import { useThemeStore } from './store/useThemeStore.js';
import { useWorkspaceSessionStore } from './store/useWorkspaceSessionStore.js';
import { useChatStore } from './store/useChatStore.js';
import { useOrchestrationStore } from './store/useOrchestrationStore.js';
import { useDiagnosticsStore } from './store/useDiagnosticsStore.js';
import { useSwarmStore } from './store/useSwarmStore.js';
import { useDebugTraceStore } from './store/useDebugTraceStore.js';
import { dispatchConfigHtmlEvent } from './features/configmd/configHtmlBridge.js';
import './styles/globals.css';
import './styles/themes.css';
import './styles/chat-enhanced.css';
import './styles/chat-cards.css';
import './styles/configHtml.css';
import './styles/agent-editor.css';
import './styles/void-tool-card.css';

// Initialize the message bridge (must happen before React mounts)
perfTrace.mark('bundle-eval');
initMessageClient((type, data) => {

	/**
	 * P4: route a workflow trace event from the host to the chat store.
	 * The store maintains a `liveWorkflowExecutions[sessionId]` entry and
	 * streams subagent deltas into it for live rendering.
	 *
	 * v4: also routes `ask_user` / `ask_user_end` events for interactive
	 * cards in the workflow owner agent's chat.
	 *
	 * v7: tracks executionId → ownerSessionId mapping so non-root events
	 * (which carry the sub-agent's own sessionId) can be resolved back to
	 * the owner session where the live container lives.
	 */
	const _workflowOwnerSessions = new Map<string, string>();

	/** Resolve the owner-session key for a workflow trace event.
	 *  Non-root events carry the sub-agent's own session; we must map them
	 *  back to the owner session recorded from the `__workflow__` root event. */
	function _resolveWorkflowSessionId(trace: { executionId: string; sessionId: string }): string {
		const owner = _workflowOwnerSessions.get(trace.executionId);
		if (owner) { return owner; }
		// Fallback: if we never saw __workflow__, use whatever session we have.
		return trace.sessionId;
	}

	function routeWorkflowTrace(trace: { executionId: string; sessionId: string; workflowAgentId: string;
		kind: string; nodeId: string; nodeName?: string; nodeType?: string;
		task?: string; delta?: unknown; output?: string; error?: string; status?: string;
		question?: string; options?: Array<{ label: string; description?: string }>;
		multiSelect?: boolean; selection?: string | string[];
		variables?: Array<{ name: string; defaultValue?: string }> }): void {
		const store = useChatStore.getState();
		const wfSessionId = _resolveWorkflowSessionId(trace);

		// v6 (refined): append ONLY node-level events to the execution timeline.
		// Deltas (streaming text/thinking/tool args) are intentionally excluded —
		// the timeline should read as a clean per-node execution log, not a
		// noisy per-token stream. The subagent card already shows live deltas.
		// Also skip `__workflow__` synthetic events (the workflow root) to avoid
		// cluttering the timeline with redundant top-level entries.
		const isNodeEvent =
			trace.kind === 'subagent_start' ||
			trace.kind === 'subagent_end' ||
			trace.kind === 'ask_user' ||
			trace.kind === 'ask_user_end' ||
			trace.kind === 'collect_variables' ||
			trace.kind === 'collect_variables_end' ||
			trace.kind === 'execution_end' ||
			trace.kind === 'breakpoint_hit';
		if (!isNodeEvent) {
			// Deltas and any unknown kinds: skip.
		} else {
			let summary: string | undefined;
			if (trace.kind === 'ask_user' && trace.question) {
				summary = `❓ ${trace.question.substring(0, 60)}`;
			} else if (trace.kind === 'ask_user_end') {
				summary = `已${trace.status === 'answered' ? '回答' : trace.status === 'cancelled' ? '取消' : '过期'}`;
			} else if (trace.kind === 'subagent_start' && trace.task) {
				summary = `${trace.task.substring(0, 60).replace(/\n/g, ' ')}`;
			} else if (trace.kind === 'subagent_end' && trace.error) {
				summary = `✗ ${trace.error.substring(0, 60)}`;
			} else if (trace.kind === 'subagent_end' && trace.output) {
				summary = `✓ ${trace.output.substring(0, 60)}`;
			} else if (trace.kind === 'execution_end') {
				summary = `执行结束: ${trace.status}`;
			} else if (trace.kind === 'collect_variables' && trace.variables) {
				summary = `📝 填入变量: ${trace.variables.map(v => v.name).join(', ')}`;
			} else if (trace.kind === 'collect_variables_end') {
				summary = `变量${trace.status === 'submitted' ? '已提交' : '已跳过'}`;
			}
			store.appendWorkflowEvent(wfSessionId, {
				executionId: trace.executionId,
				sessionId: trace.sessionId,
				kind: trace.kind as any,
				nodeId: trace.nodeId,
				nodeName: trace.nodeName,
				nodeType: trace.nodeType,
				task: trace.task,
				status: trace.status,
				summary,
			});
		}

		if (trace.kind === 'subagent_start') {
			if (trace.nodeId === '__workflow__') {
				// v7: resolve the container key. When the service couldn't create
				// an owner session (workflowAgentId falsy), sessionId may be a
				// fallback like 'unknown'. In that case, use the current active
				// session so the container is stored under a key the renderer
				// can actually find.
				let containerKey = trace.sessionId;
				if (!containerKey || containerKey === 'unknown') {
					containerKey = useChatStore.getState().activeAgentSessionId ?? 'unknown';
				}
				_workflowOwnerSessions.set(trace.executionId, containerKey);
				store.startWorkflowExecution(trace.executionId, containerKey, trace.nodeName ?? 'Workflow');
			} else {
				store.startWorkflowSubAgent(wfSessionId, {
					id: trace.nodeId,
					name: trace.nodeName ?? trace.nodeId,
					type: trace.nodeType ?? 'agent',
					task: trace.task ?? '',
					status: 'running',
					toolCalls: [],
					startTime: Date.now(),
				});
			}
		} else if (trace.kind === 'delta') {
			store.appendWorkflowTraceDelta(wfSessionId, trace.nodeId, trace.delta);
		} else if (trace.kind === 'subagent_end') {
			store.endWorkflowSubAgent(
				wfSessionId,
				trace.nodeId,
				// v21: trace.status can be 'cancelled' when the user clicked
				// Cancel mid-stream. endWorkflowSubAgent's type union already
				// includes 'cancelled' so this cast is safe.
				(trace.status as 'done' | 'error' | 'cancelled') ?? 'done',
				trace.output,
				trace.error,
			);
		} else if (trace.kind === 'ask_user') {
			// v4: register an interactive AskUser card. The card will call
			// submitAskUser() when the user picks an option, which sends
			// `workflow.resume` to the host.
			store.startAskUser(wfSessionId, {
				executionId: trace.executionId,
				nodeId: trace.nodeId,
				nodeName: trace.nodeName ?? trace.nodeId,
				question: trace.question ?? '',
				options: trace.options ?? [],
				multiSelect: trace.multiSelect ?? false,
			});
		} else if (trace.kind === 'ask_user_end') {
			// v4: server told us the AskUser was resolved (could be 'answered'
			// from the host firing the same end as us, or 'cancelled' / 'expired').
			// 'answered' is also a no-op since submitAskUser already flipped the
			// card, but we still pass through for any cross-replica case.
			const status = (trace.status as 'answered' | 'cancelled' | 'expired') ?? 'answered';
			if (status !== 'answered') {
				store.cancelAskUser(wfSessionId, `${trace.executionId}:${trace.nodeId}`, status);
			}
		} else if (trace.kind === 'collect_variables') {
			// v6: register a variable collection card so the user can fill in values.
			store.startCollectVariables(wfSessionId, {
				executionId: trace.executionId,
				variables: trace.variables ?? [],
			});
		} else if (trace.kind === 'collect_variables_end') {
			// v6: server resolved variable collection — mark card as submitted/skipped.
			if (trace.status === 'skipped') {
				store.cancelCollectVariables(wfSessionId, trace.executionId);
			}
			// 'submitted' is already handled by submitCollectVariables optimistically
		} else if (trace.kind === 'execution_end') {
			store.commitWorkflowExecution(
				wfSessionId,
				(trace.status as 'completed' | 'failed' | 'cancelled') ?? 'completed',
			);
			// Clean up owner-session mapping so stale entries don't leak across runs.
			_workflowOwnerSessions.delete(trace.executionId);
		}
	}

	switch (type) {
		case 'agent.selected': {
			const { agentId } = (data as { agentId: string | null }) ?? {};
			console.log(`[AgentStudio] received 'agent.selected' event: agentId=${agentId}, panelType=${(window as any).__AGENT_STUDIO_PANEL_TYPE__}`);
			if (agentId !== undefined) {
				// Update the Agent store directly (bypass postMessage to avoid echo loop).
				// NOTE: useAgentStore is the canonical agent store that the chat panel reads from.
				console.log(`[AgentStudio] → useAgentStore.setState({ selectedAgentId: '${agentId}' })`);
				useAgentStore.setState({ selectedAgentId: agentId });
			} else {
				console.warn(`[AgentStudio] agent.selected event missing agentId, data=`, data);
			}
			break;
		}
		case 'agents.changed':
			window.dispatchEvent(new CustomEvent('agentStudio:agents-changed'));
			break;
		case 'worktree.changed':
			// Git worktree list changed (create/remove) — notify the worktree
			// dropdowns (agent node card + WorktreeSwitcher) to re-fetch.
			window.dispatchEvent(new CustomEvent('agentStudio:worktree-changed', { detail: data }));
			break;
		case 'agent.worktree.changed':
			// Agent's binding worktree changed (via dropdown switch) — notify
			// the worktree dropdown to update its current selection.
			window.dispatchEvent(new CustomEvent('agentStudio:agent-worktree-changed', { detail: data }));
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
		case 'boards.changed':
			// Multi-board list changed (create/rename/delete) — notify the
			// TaskBoardPanel board selector to re-fetch the board list.
			window.dispatchEvent(new CustomEvent('agentStudio:boards-changed', { detail: data }));
			break;
		case 'taskBoard.focusTask':
			window.dispatchEvent(new CustomEvent('agentStudio:focusTask', { detail: data }));
			break;
		case 'diagnostics.detected': {
			const diagnostic = data as import('./store/useDiagnosticsStore.js').Diagnostic;
			if (diagnostic?.id) {
				useDiagnosticsStore.getState().onDetected(diagnostic);
				window.dispatchEvent(new CustomEvent('agentStudio:diagnostic-detected', { detail: diagnostic }));
			}
			break;
		}
		case 'diagnostics.changed': {
			const diagnostics = data as import('./store/useDiagnosticsStore.js').Diagnostic[];
			useDiagnosticsStore.getState().onChanged(Array.isArray(diagnostics) ? diagnostics : []);
			break;
		}
		case 'swarm.updated': {
			const status = data as import('./store/useSwarmStore.js').SwarmStatus;
			if (status?.swarmId) {
				useSwarmStore.getState().onUpdated(status);
				window.dispatchEvent(new CustomEvent('agentStudio:swarm-updated', { detail: status }));
			}
			break;
		}
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
		case 'debug.trace': {
			const { message } = (data as { message: string }) ?? {};
			if (message) {
				console.log(`%c${message}`, 'color: #4fc3f7; font-weight: bold');
				useDebugTraceStore.getState().addEntry(message);
			}
			break;
		}
		case 'workspace.sessionUpdated': {
			const detail = data as { workspaceId?: string; agentId?: string; agentSessionId?: string };
			// Fork-mode bookkeeping: if the agent belongs to the active
			// Fork session, mirror the new agentSessionId there too.
			if (detail.agentId && detail.agentSessionId) {
				const sessionStore = useWorkspaceSessionStore.getState();
				const activeSession = sessionStore.getActiveSession();
				if (activeSession) {
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
			console.log(`[AgentStudio] orchestration.planUpdated: planId=${plan?.id}, status=${plan?.status}`);
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
		case 'orchestration.decompositionProgress': {
			// Dispatch as custom event so chat UI can show decomposition progress
			window.dispatchEvent(new CustomEvent('agentStudio:decomposition-progress', { detail: data }));
			break;
		}
		case 'confightml.htmlRendered':
		case 'confightml.command':
		case 'confightml.error':
		case 'confightml.chatStreamDelta':
		case 'confightml.chatStreamDone': {
			const detail = data as { agentId: string };
			if (detail?.agentId) {
				dispatchConfigHtmlEvent(detail.agentId, type, data);
			}
			break;
		}
		case 'pool.activate': {
			// Hot-path: this webview was pooled and is now being activated by
			// the host with a real panelType. Update globals and dispatch a
			// custom event so the App component re-renders with the real panel.
			const payload = data as {
				panelType?: string;
				initialTheme?: string;
				initialData?: unknown;
				perfHostCreateTs?: number;
				perfHtmlTs?: number;
				perfRendererOrigin?: number;
			} | undefined;

			if (payload) {
				(window as any).__AGENT_STUDIO_PANEL_TYPE__ = payload.panelType ?? undefined;
				if (payload.initialTheme) {
					(window as any).__AGENT_STUDIO_INITIAL_THEME__ = payload.initialTheme;
					useThemeStore.getState().setTheme(payload.initialTheme);
				}
				if (payload.initialData !== undefined) {
					(window as any).__AGENT_STUDIO_INITIAL_DATA__ = payload.initialData;
				}
				if (payload.perfHostCreateTs) {
					(window as any).__AS_PERF_HOST_CREATE_TS__ = payload.perfHostCreateTs;
				}
				if (payload.perfHtmlTs) {
					(window as any).__AS_PERF_HTML_TS__ = payload.perfHtmlTs;
				}

				// 修复多窗口 pool 复用场景下的 Zustand 单例跨面板状态泄漏：
				// warm webview 被 workbench Flow/Taskboard 面板复用时，上一个
				// panel session 的 workflow trace 状态（liveWorkflowExecutions/
				// liveWorkflowEvents 等）仍残留在 store 中 → 显示旧工作流数据。
				// pool.activate 是面板接管的第一条数据消息，在此处清空所有
				// workflow trace 以确保新面板从干净状态启动。
				const chatState = useChatStore.getState();
				// 清空旧 session 的工作流执行记录与事件时间线
				const oldSessions = Object.keys(chatState.liveWorkflowExecutions);
				for (const sid of oldSessions) {
					chatState.clearWorkflowEvents(sid);
				}
				// 重置 askUser / collectVariable 等交互状态
				useChatStore.setState({
					liveWorkflowExecutions: {},
					liveAskUsers: {},
					liveCollectVariables: {},
					liveWorkflowEvents: {},
				});

				console.log(`[AgentStudio] pool.activate → panelType=${payload.panelType}` +
					(oldSessions.length > 0 ? ` (cleared ${oldSessions.length} stale workflow sessions)` : ''));
				window.dispatchEvent(new CustomEvent('agentStudio:pool-activate', { detail: payload }));
			}
			break;
		}
	case 'workflow.stateApplied': {
		// AI-driven workflow change — dispatch as custom event so the
		// WorkflowEditorPanel can reload from the new data.
		const payload = data as {
			workflow: {
				id: string;
				name?: string;
				description?: string;
				nodes?: Array<Record<string, unknown>>;
				connections?: Array<Record<string, unknown>>;
			};
			description?: string;
		} | undefined;
		if (payload?.workflow) {
			console.log(`[AgentStudio] workflow.stateApplied → id=${payload.workflow.id}, nodes=${payload.workflow.nodes?.length ?? 0}`);
			window.dispatchEvent(new CustomEvent('agentStudio:workflow-state-applied', { detail: payload }));
		}
		break;
	}
	case 'workflow.canvasOps': {
		// Agent-driven canvas (P0): host forwards canvas ops batch (from
		// canvas_apply_ops / canvas_generate tools). The WorkflowEditorPanel
		// applies them via applyCanvasOps and replies with canvasOpsResult.
		console.log(`[AgentStudio] workflow.canvasOps → ops=${(data as { ops?: unknown[] } | undefined)?.ops?.length ?? 0}`);
		window.dispatchEvent(new CustomEvent('agentStudio:workflow-canvas-ops', { detail: data }));
		break;
	}
	case 'workflow.executionUpdate': {
		// Host pushed workflow execution status / node state / breakpoints update.
		// Dispatch as a custom event so WorkflowEditorPanel can update the canvas
		// (current node highlight, breakpoint markers, run/pause/cancel buttons).
		console.log(`[AgentStudio] workflow.executionUpdate →`, data);
		window.dispatchEvent(new CustomEvent('agentStudio:workflow-execution-update', { detail: data }));
		break;
	}
	case 'workflow.executionTrace': {
		// P4: host pushed per-node trace (subagent_start/delta/subagent_end/execution_end).
		// Route to the chat store, which updates the transient live execution
		// view rendered by the chat panel.
		const trace = data as { executionId: string; sessionId: string; workflowAgentId: string;
			kind: string; nodeId: string; nodeName?: string; nodeType?: string;
			task?: string; delta?: unknown; output?: string; error?: string; status?: string };
		// Skip verbose logging for delta events — hundreds fire during streaming
		if (trace.kind !== 'delta') {
			console.log(`[AgentStudio] workflow.executionTrace → kind=${trace.kind} node=${trace.nodeId} session=${trace.sessionId}`);
		}
		routeWorkflowTrace(trace);
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

	perfTrace.mark('react-render');
	const root = createRoot(container);
	root.render(React.createElement(App));

	// Signal to the host that this webview is fully bootstrapped (React mounted,
	// all stores initialized). For pooled webviews, this lets the pool know it
	// can be acquired with zero additional startup cost.
	postMessage('pool.ready', { ts: Date.now() });
}
