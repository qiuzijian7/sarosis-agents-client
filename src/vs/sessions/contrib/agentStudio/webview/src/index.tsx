/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Entry Point
 *--------------------------------------------------------------------------------------------*/

// Mark bundle as loaded for early diagnostics
(window as any).__AS_BUNDLE_LOADED__ = true;
console.log('[AS-BUNDLE] index.tsx: module execution started');

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { perfTrace } from './utils/perfTrace.js';
import { initMessageClient, postMessage } from './bridge/messageClient.js';
import { handleStreamDelta, handleStreamComplete, handleStreamError, applyToolApprovalRequest } from './bridge/streamHandler.js';
import { useAgentStore } from './store/useAgentStore.js';
import { useProviderStore } from './store/useProviderStore.js';
import { useThemeStore } from './store/useThemeStore.js';
import { useWorkspaceSessionStore } from './store/useWorkspaceSessionStore.js';
import { useChatStore } from './store/useChatStore.js';
import { useOrchestrationStore } from './store/useOrchestrationStore.js';
import { useDiagnosticsStore } from './store/useDiagnosticsStore.js';
import { useSwarmStore } from './store/useSwarmStore.js';
import { useDebugTraceStore } from './store/useDebugTraceStore.js';
import { dispatchConfigMdEvent } from './features/configmd/configMdBridge.js';
import './styles/globals.css';
import './styles/themes.css';
import './styles/chat-enhanced.css';
import './styles/chat-cards.css';
import './styles/configmd.css';
import './styles/agent-editor.css';
import './styles/void-tool-card.css';
import '@xyflow/react/dist/style.css';

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
	 */
	function routeWorkflowTrace(trace: { executionId: string; sessionId: string; workflowAgentId: string;
		kind: string; nodeId: string; nodeName?: string; nodeType?: string;
		task?: string; delta?: unknown; output?: string; error?: string; status?: string;
		question?: string; options?: Array<{ label: string; description?: string }>;
		multiSelect?: boolean; selection?: string | string[];
		variables?: Array<{ name: string; defaultValue?: string }> }): void {
		const store = useChatStore.getState();

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
			store.appendWorkflowEvent(trace.sessionId, {
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
				store.startWorkflowExecution(trace.executionId, trace.sessionId, trace.nodeName ?? 'Workflow');

				// v6: auto-switch the chat panel to the workflow's owner agent
				// session so the user immediately sees the execution trace.
				// This runs in the CHAT webview (which also receives trace events).
				// We need to set the active agent first (to load the chat panel for
				// that agent), then switch to the specific session.
				void (async () => {
					try {
						const chatStore = useChatStore.getState();
						// Only switch if not already on this agent/session.
						if (chatStore.activeAgentId !== trace.workflowAgentId ||
							chatStore.activeAgentSessionId !== trace.sessionId) {
							chatStore.setActiveAgent(trace.workflowAgentId);
							// Give setActiveAgent a tick to propagate.
							await new Promise(r => setTimeout(r, 50));
							await chatStore.switchAgentSession(trace.sessionId);
							console.log(`[trace-router] auto-switched chat to agent=${trace.workflowAgentId} session=${trace.sessionId}`);
						}
					} catch (err) {
						console.warn('[trace-router] auto-switch chat failed:', err);
					}
				})();
			} else {
				store.startWorkflowSubAgent(trace.sessionId, {
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
			store.appendWorkflowTraceDelta(trace.sessionId, trace.nodeId, trace.delta);
		} else if (trace.kind === 'subagent_end') {
			store.endWorkflowSubAgent(
				trace.sessionId,
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
			store.startAskUser(trace.sessionId, {
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
				store.cancelAskUser(trace.sessionId, `${trace.executionId}:${trace.nodeId}`, status);
			}
		} else if (trace.kind === 'collect_variables') {
			// v6: register a variable collection card so the user can fill in values.
			store.startCollectVariables(trace.sessionId, {
				executionId: trace.executionId,
				variables: trace.variables ?? [],
			});
		} else if (trace.kind === 'collect_variables_end') {
			// v6: server resolved variable collection — mark card as submitted/skipped.
			if (trace.status === 'skipped') {
				store.cancelCollectVariables(trace.sessionId, trace.executionId);
			}
			// 'submitted' is already handled by submitCollectVariables optimistically
		} else if (trace.kind === 'execution_end') {
			store.commitWorkflowExecution(
				trace.sessionId,
				(trace.status as 'completed' | 'failed' | 'cancelled') ?? 'completed',
			);
		}
	}

	switch (type) {
		case 'chat.stream.delta':
			handleStreamDelta(data as Parameters<typeof handleStreamDelta>[0]);
			break;
		case 'chat.stream.complete': {
			const completeData = data as Parameters<typeof handleStreamComplete>[0];
			const msg = completeData.message as Record<string, unknown> | undefined;
			console.log(`[AgentStudio] Routing chat.stream.complete → handleStreamComplete, ` +
				`agentId=${completeData.agentId}, ` +
				`hostMsg.contentLen=${typeof msg?.content === 'string' ? msg.content.length : 'N/A'}, ` +
				`hostMsg.error=${msg?.error ?? 'none'}`);
			handleStreamComplete(completeData);
			break;
		}
		case 'chat.stream.error': {
			const errData = data as Parameters<typeof handleStreamError>[0];
			console.error(`[AgentStudio] Routing chat.stream.error → handleStreamError, ` +
				`agentId=${errData.agentId}, error="${errData.error}"`);
			handleStreamError(errData);
			break;
		}
		case 'chat.userMessageAppended': {
			// Mirrors `useChatStore.sendMessage`'s optimistic local append for
			// messages that originated outside the chat input (currently only
			// imgui form submits routed via the host controller).
			const detail = data as {
				agentId: string;
				agentSessionId?: string;
				message: { id: string; role: 'user'; content: string; timestamp: string };
			} | undefined;
			if (detail?.agentId && detail.message) {
				console.log(`[AgentStudio] Routing chat.userMessageAppended → store: ` +
					`agentId=${detail.agentId}, id=${detail.message.id}, len=${detail.message.content.length}`);
				useChatStore.getState().appendExternalUserMessage(detail.agentId, detail.message);
			}
			break;
		}
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
		case 'chat.injectPrompt': {
			// Host injects a prompt into the chat panel (e.g. workflow ▶ Run button).
			// Only the chat panel should act on this; other panels ignore it.
			const panelType = (window as any).__AGENT_STUDIO_PANEL_TYPE__;
			if (panelType !== 'chat') { break; }
			const { agentId: injectAgentId, message: injectMessage } = (data as { agentId: string; message: string }) ?? {};
			if (injectAgentId && injectMessage) {
				console.log(`[AgentStudio] chat.injectPrompt: sending message for agent=${injectAgentId}`);
				useAgentStore.setState({ selectedAgentId: injectAgentId });
				// Defer send so React can process the agent switch first
				setTimeout(() => {
					void useChatStore.getState().sendMessage(injectMessage);
				}, 100);
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
			// If host assigned a new agentSessionId, update the chat store
			// regardless of whether a Fork active session exists. This is
			// important for Root-mode imgui submits: the host lazily creates
			// an agent session and emits this event, and the webview must
			// pick it up so the next history reload aims at the same session.
			if (detail.agentId && detail.agentSessionId) {
				const chatStore = useChatStore.getState();
				if (chatStore.activeAgentId === detail.agentId) {
					if (chatStore.activeAgentSessionId !== detail.agentSessionId) {
						console.log(
							`[AgentStudio] workspace.sessionUpdated → chatStore.activeAgentSessionId = ${detail.agentSessionId} ` +
							`(was ${chatStore.activeAgentSessionId})`
						);
						useChatStore.setState({ activeAgentSessionId: detail.agentSessionId });
						// Refresh the session list so the new session shows up
						// in the session picker (Root mode).
						chatStore.loadAgentSessions(detail.agentId);
					}
				}

				// Fork-mode bookkeeping: if the agent belongs to the active
				// Fork session, mirror the new agentSessionId there too.
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

			// When a plan status changes (e.g. rejected from TaskOverviewEditorPane),
			// update the matching chat message metadata so AgentChat re-renders
			// its message list.  This is necessary because:
			//   1. ChatMessageRaw is wrapped in React.memo — the memo comparator
			//      only runs when the parent (AgentChat) re-renders.
			//   2. The Zustand subscription inside ChatMessageRaw may not fire if
			//      the plan data in the store doesn't match the message's planId
			//      (e.g. the host sends a stale or different plan object).
			//   3. AgentChat only re-renders when the messages array changes.
			// Mutating the metadata._planStatus forces a new message object ref,
			// which triggers AgentChat → ChatMessageComponent → ChatMessageRaw
			// → OrchestrationPlanInline to re-render with fresh data.
			if (plan?.id && plan.status !== 'pending_approval') {
				useChatStore.setState(state => {
					const updatedMessages = state.messages.map(m =>
						m.metadata?.type === 'orchestration_plan' && m.metadata.planId === plan.id
							? { ...m, metadata: { ...m.metadata, _planStatus: plan.status } }
							: m
					);
					const hasChanges = updatedMessages.some((m, i) => m !== state.messages[i]);
					if (hasChanges) {
						console.log(`[AgentStudio] Updated chat message metadata for plan ${plan.id} → ${plan.status}`);
					}
					return hasChanges ? { messages: updatedMessages } : state;
				});
			}
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
		case 'configmd.sourceChanged':
		case 'configmd.htmlRendered':
		case 'configmd.command':
		case 'configmd.error': {
			const detail = data as { agentId: string };
			if (detail?.agentId) {
				dispatchConfigMdEvent(detail.agentId, type, data);
			}
			break;
		}
		case 'agentSessions.changed': {
			// Agent session list changed (created/renamed/deleted/updated).
			// Refresh the session list in the chat store if the affected agent
			// is currently active so the L0 panel updates automatically.
			const detail = data as { agentId: string } | undefined;
			if (detail?.agentId) {
				const chatStore = useChatStore.getState();
				if (chatStore.activeAgentId === detail.agentId) {
					console.log(`[AgentStudio] agentSessions.changed → reloading sessions for ${detail.agentId}`);
					chatStore.loadAgentSessions(detail.agentId);
				}
			}
			break;
		}
		case 'chat.switchToSession': {
			// Host requests switching to a specific agent session
			// (e.g. from the SessionExplorerViewPane in the sidebar)
			const detail = data as { agentId: string; agentSessionId: string } | undefined;
			if (detail?.agentId && detail?.agentSessionId) {
				const chatStore = useChatStore.getState();
				// First select the agent if not already active
				if (chatStore.activeAgentId !== detail.agentId) {
					chatStore.setActiveAgent(detail.agentId);
				}
				// Then switch to the session
				chatStore.switchAgentSession(detail.agentSessionId);
				console.log(`[AgentStudio] chat.switchToSession → switched to session ${detail.agentSessionId} for agent ${detail.agentId}`);
			}
			break;
		}
		case 'chat.toolApprovalRequest': {
			// Host requests tool approval UI — find the tool call and set status to 'approval_required'
			const payload = data as {
				toolCallId: string;
				toolName: string;
				arguments: Record<string, unknown>;
				securityLevel: 'safe' | 'cautious' | 'dangerous';
				reason?: string;
			};

			// ── Step 1: streaming tool calls (PRIMARY path) ──────────────────
			// During streaming, the tool call lives in streamState.toolCalls
			// (rendered by StreamingBubble), NOT the committed `messages` array.
			// This is the common case — a tool requiring approval mid-stream. If
			// we don't update the stream state, the approval card never renders,
			// the user can't approve, and agentOSService.checkAndApprove() awaits
			// forever → stream stuck at "执行中..." (the reported bug).
			const appliedToStream = applyToolApprovalRequest({
				toolCallId: payload.toolCallId,
				toolName: payload.toolName,
				securityLevel: payload.securityLevel,
			});

			// ── Step 2: committed messages (FALLBACK path) ───────────────────
			// If the tool call was already committed to `messages` (e.g. the
			// stream completed but a deferred approval is still being requested),
			// update it there too.
			const store = useChatStore.getState();
			const messages = store.messages;
			let updatedCommitted = false;
			const newMessages = messages.map(msg => {
				if (msg.toolCalls) {
					const newToolCalls = msg.toolCalls.map(tc => {
						if (tc.id === payload.toolCallId) {
							updatedCommitted = true;
							return { ...tc, status: 'approval_required', securityLevel: payload.securityLevel };
						}
						return tc;
					});
					if (newToolCalls !== msg.toolCalls) {
						return { ...msg, toolCalls: newToolCalls };
					}
				}
				return msg;
			});

			if (updatedCommitted) {
				useChatStore.setState({ messages: newMessages });
			}

			if (appliedToStream || updatedCommitted) {
				console.log(`[AgentStudio] Tool approval requested: toolCallId=${payload.toolCallId}, toolName=${payload.toolName} (stream=${appliedToStream}, committed=${updatedCommitted})`);
			} else {
				// v7: tool approval during workflow execution — the tool call lives
				// in liveWorkflowExecutions (not in the chat's streamState/messages).
				// Search all live workflow executions and auto-approve if found.
				const liveExecs = useChatStore.getState().liveWorkflowExecutions;
				let foundInWorkflow = false;
				for (const [, exec] of Object.entries(liveExecs)) {
					for (const sa of exec.subAgents) {
						const tool = sa.toolCalls?.find(tc => tc.id === payload.toolCallId);
						if (tool) {
							foundInWorkflow = true;
							console.log(`[AgentStudio] Tool approval auto-approved for workflow tool: toolCallId=${payload.toolCallId}, toolName=${payload.toolName}, subAgent=${sa.id}`);
							// Mark the tool call in the store so the SubAgentCard can show the status.
							useChatStore.setState(state => {
								const newExec = { ...state.liveWorkflowExecutions };
								for (const [sid, e] of Object.entries(newExec)) {
									const idx = e.subAgents.findIndex(s => s.id === sa.id);
									if (idx < 0) { continue; }
									const sub = e.subAgents[idx];
									const tcIdx = (sub.toolCalls ?? []).findIndex(tc => tc.id === payload.toolCallId);
									if (tcIdx < 0) { continue; }
									const newTC = [...(sub.toolCalls ?? [])];
									newTC[tcIdx] = { ...newTC[tcIdx], status: 'running' };
									newExec[sid] = {
										...e,
										subAgents: e.subAgents.map((s, i) => i === idx ? { ...s, toolCalls: newTC } : s),
									};
								}
								return { liveWorkflowExecutions: newExec };
							});
							// Auto-approve (allow_once). The user already explicitly started the workflow.
							void postMessage('chat.toolApprove', {
								toolCallId: payload.toolCallId,
								decision: 'allow_once',
							});
							break;
						}
					}
					if (foundInWorkflow) { break; }
				}
				if (!foundInWorkflow) {
					console.warn(`[AgentStudio] chat.toolApprovalRequest: toolCallId=${payload.toolCallId} not found in stream, messages, or live workflow executions`);
				}
			}
			break;
		}
		case 'chat.checkpointCreated': {
			// Host created a checkpoint (user_edit anchor or tool_edit snapshot).
			// Render an inline checkpoint card so the user can time-travel back.
			const cp = data as {
				id: string;
				agentId?: string;
				sessionId: string;
				type: 'user_edit' | 'tool_edit';
				label?: string;
				description?: string;
				createdAt: number;
				fileSnapshotIds?: string[];
				isGhost?: boolean;
				messageId?: string;
				files?: Array<{
					uri: string;
					fileName: string;
					fsPath: string;
					additions: number;
					deletions: number;
				}>;
			} | undefined;
			if (cp?.id) {
				const chatStore = useChatStore.getState();
				// Only render for the currently active agent/session to avoid
				// leaking checkpoints from background agents into the open chat.
				// Skip user_edit anchors: they carry no file snapshot (empty set)
				// and exist purely as message-boundary markers for range rollback.
				// Rendering them would spam an empty card before every turn.
				// Only tool_edit checkpoints (real file snapshots) get a card.
				if (chatStore.activeAgentId === cp.agentId && cp.type === 'tool_edit') {
					console.log(`[AgentStudio] chat.checkpointCreated → ${cp.type} ${cp.id} (${cp.fileSnapshotIds?.length ?? 0} files, files=${cp.files?.length ?? 0})`);
					chatStore.addCheckpoint({
						id: cp.id,
						type: cp.type,
						timestamp: new Date(cp.createdAt).toISOString(),
						description: cp.description || cp.label,
						filesChanged: cp.files?.length ?? cp.fileSnapshotIds?.length ?? 0,
						files: cp.files,
						isGhost: cp.isGhost ?? false,
					});
				}
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
				console.log(`[AgentStudio] pool.activate → panelType=${payload.panelType}`);
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
		console.log(`[AgentStudio] workflow.executionTrace → kind=${trace.kind} node=${trace.nodeId} session=${trace.sessionId}`);
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
