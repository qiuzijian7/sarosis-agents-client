/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Store (Zustand)
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';
import { subscribeStream, onStreamComplete, getStreamState, resetStream, resetStreamSilent, type StreamState } from '../bridge/streamHandler';
import { useEmployeeStore } from './useEmployeeStore';

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'tool' | 'system';
	content: string;
	thinking?: string;
	toolCalls?: { id: string; name: string; arguments: string; result?: string; status: string }[];
	tokenUsage?: { input: number; output: number; total: number };
	timestamp: string;
}

export interface AgentSessionInfo {
	id: string;
	name: string;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
	/** External provider session ID (e.g. Knot threadId) */
	providerSessionId?: string;
}

interface ChatState {
	messages: ChatMessage[];
	streamState: StreamState;
	inputValue: string;
	isLoading: boolean;
	activeEmployeeId: string | null;
	/** Current agent session ID (null = 'default') */
	activeAgentSessionId: string | null;
	/** List of sessions for the current agent (Root mode) */
	agentSessions: AgentSessionInfo[];

	// Actions
	setActiveEmployee: (employeeId: string) => void;
	loadHistory: (employeeId: string) => Promise<void>;
	/** Load history for a specific agentSessionId (used by session switching) */
	loadHistoryForSession: (employeeId: string, agentSessionId?: string) => Promise<void>;
	sendMessage: (message: string) => Promise<void>;
	cancelStream: () => void;
	setInputValue: (value: string) => void;
	clearMessages: () => void;
	/**
	 * Append a user message that originated *outside* the chat input
	 * (e.g. an imgui form submitted from a ConfigMD preview pane).
	 *
	 * The host-side controller has already persisted this message and
	 * kicked off a `chat.stream.*` cycle; this method just mirrors the
	 * optimistic local append that `sendMessage` performs for typed input,
	 * so the user sees a bubble for what they sent. Scoped by
	 * `employeeId`: ignored if it doesn't match the active employee.
	 */
	appendExternalUserMessage: (employeeId: string, message: ChatMessage) => void;
	/** Load all sessions for the current agent */
	loadAgentSessions: (employeeId: string) => Promise<void>;
	/** Create a new session for the current agent and switch to it */
	createAgentSession: () => Promise<void>;
	/** Switch to a different session for the current agent */
	switchAgentSession: (sessionId: string) => Promise<void>;
	/** Rename an agent session */
	renameAgentSession: (sessionId: string, newName: string) => Promise<void>;
	/** Delete an agent session */
	deleteAgentSession: (sessionId: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => {
	// Helper: update the active employee's status in the employee store
	function syncEmployeeStatus(status: 'idle' | 'thinking' | 'working') {
		const activeId = get().activeEmployeeId;
		if (!activeId) return;
		useEmployeeStore.setState(state => ({
			employees: state.employees.map(e =>
				e.id === activeId ? { ...e, status } : e
			),
		}));
	}

	// Subscribe to stream state updates (live streaming indicator)
	subscribeStream((streamState) => {
		// Ignore stream updates that don't belong to the currently active employee/session.
		// This prevents stale deltas from a previous chat from leaking into the
		// currently displayed chat after the user switches employees.
		const { activeEmployeeId, activeAgentSessionId } = get();
		if (streamState.isStreaming && streamState.employeeId && streamState.employeeId !== activeEmployeeId) {
			console.warn(`[ChatStore] subscribeStream: discarding streamState for different employee ` +
				`(streamEmployee=${streamState.employeeId}, activeEmployee=${activeEmployeeId})`);
			return;
		}
		if (streamState.isStreaming && streamState.sessionId && activeAgentSessionId &&
			streamState.sessionId !== activeAgentSessionId) {
			console.warn(`[ChatStore] subscribeStream: discarding streamState for different session ` +
				`(streamSession=${streamState.sessionId}, activeSession=${activeAgentSessionId})`);
			return;
		}

		set({ streamState });

		// Sync employee status based on streaming state
		if (streamState.isStreaming) {
			if (streamState.thinkingBuffer && !streamState.textBuffer) {
				syncEmployeeStatus('thinking');
			} else if (streamState.textBuffer || streamState.toolCalls.length > 0) {
				syncEmployeeStatus('working');
			} else {
				syncEmployeeStatus('thinking');
			}
		}
	});

	// When a stream completes (or errors), build the final message and add to history.
	// IMPORTANT: we must atomically update `messages` AND `streamState` in a single
	// set() call so that React sees both changes in the same render batch.
	// Otherwise the streaming bubble disappears (isStreaming→false) before the
	// persisted assistant message appears, causing the chat UI to flash empty.
	onStreamComplete((finalState, hostMessage?: any) => {
		console.log('[ChatStore] onStreamComplete fired:', {
			isStreaming: finalState.isStreaming,
			textBufferLen: finalState.textBuffer.length,
			thinkingBufferLen: finalState.thinkingBuffer.length,
			errorMessage: finalState.errorMessage,
			hostMessage: hostMessage ? {
				id: hostMessage.id,
				role: hostMessage.role,
				contentLen: hostMessage.content?.length ?? 0,
				contentPreview: hostMessage.content?.substring(0, 80),
				thinkingLen: hostMessage.thinking?.length ?? 0,
				error: hostMessage.error,
			} : null,
		});

		// Guard: discard completion events for a different employee/session
		// than the one currently active. This can happen when a stream
		// from a previous chat finishes after the user has switched.
		const { activeEmployeeId, activeAgentSessionId } = get();
		if (finalState.employeeId && finalState.employeeId !== activeEmployeeId) {
			console.warn(`[ChatStore] onStreamComplete: discarding message for different employee ` +
				`(streamEmployee=${finalState.employeeId}, activeEmployee=${activeEmployeeId})`);
			resetStreamSilent();
			set({ streamState: getStreamState() });
			try { syncEmployeeStatus('idle'); } catch { /* ignore */ }
			return;
		}
		if (finalState.sessionId && activeAgentSessionId && finalState.sessionId !== activeAgentSessionId) {
			console.warn(`[ChatStore] onStreamComplete: discarding message for different session ` +
				`(streamSession=${finalState.sessionId}, activeSession=${activeAgentSessionId})`);
			resetStreamSilent();
			set({ streamState: getStreamState() });
			try { syncEmployeeStatus('idle'); } catch { /* ignore */ }
			return;
		}

		if (finalState.errorMessage) {
			// API returned an error — show it as a system error message
			const errorMessage: ChatMessage = {
				id: `error_${Date.now()}`,
				role: 'system',
				content: `⚠️ ${finalState.errorMessage}`,
				timestamp: new Date().toISOString(),
			};
			// Reset silently (no notify) then atomically commit error + streamState
			resetStreamSilent();
			set(state => ({
				messages: [...state.messages, errorMessage],
				streamState: getStreamState(),
			}));
			// Restore employee status AFTER messages are committed
			try { syncEmployeeStatus('idle'); } catch { /* ignore */ }
			console.log('[ChatStore] Error message committed');
			return;
		}

		// Use buffers if available, otherwise fallback to host-assembled message.
		// This fallback is critical when:
		// 1. Stream was very fast and complete arrived before any delta
		// 2. handleStreamError reset the buffers but complete still has the full message
		const textContent = finalState.textBuffer || (hostMessage?.content as string) || '';
		const thinkingContent = finalState.thinkingBuffer || (hostMessage?.thinking as string) || '';

		console.log('[ChatStore] Building assistant message:', {
			textContentLen: textContent.length,
			textContentPreview: textContent.substring(0, 80),
			thinkingContentLen: thinkingContent.length,
			usedBuffer: !!finalState.textBuffer,
			usedHostFallback: !finalState.textBuffer && !!hostMessage?.content,
		});

		// Reset silently (no notify → no intermediate subscribeStream callback)
		// so we can atomically commit messages + streamState in a single set().
		resetStreamSilent();

		if (textContent || thinkingContent) {
			const assistantMessage: ChatMessage = {
				id: hostMessage?.id || `asst_${Date.now()}`,
				role: 'assistant',
				content: textContent || '(思考完成)',
				thinking: thinkingContent || undefined,
				toolCalls: finalState.toolCalls.map(tc => ({
					id: tc.id,
					name: tc.name,
					arguments: tc.arguments,
					result: tc.result,
					status: tc.status,
				})),
				timestamp: new Date().toISOString(),
			};
			// Atomically commit the new message AND the reset streamState
			// so React never sees "no streaming bubble + no message" in between.
			set(state => {
				console.log('[ChatStore] Committing assistant message, current messages count:', state.messages.length, ', new msg id:', assistantMessage.id);
				return {
					messages: [...state.messages, assistantMessage],
					streamState: getStreamState(),
				};
			});
		} else {
			console.warn('[ChatStore] onStreamComplete: No content to build message from! This should not happen in normal flow.');
			// Still sync streamState even when there is no content
			set({ streamState: getStreamState() });
		}

		// Restore employee status AFTER messages and streamState are committed.
		// This must come last to avoid triggering React re-renders that could
		// see an intermediate state where streaming stopped but no message exists.
		try { syncEmployeeStatus('idle'); } catch { /* ignore */ }
		console.log('[ChatStore] onStreamComplete done, employee status restored to idle');
	});

	return {
		messages: [],
		streamState: getStreamState(),
		inputValue: '',
		isLoading: false,
		activeEmployeeId: null,
		activeAgentSessionId: null,
		agentSessions: [],

		setActiveEmployee: (employeeId: string) => {
			const current = get().activeEmployeeId;
			console.log(`[ChatStore] setActiveEmployee: ${current} → ${employeeId}`);
			if (current === employeeId) {
				return;
			}

			// Check if in Fork mode — use fork's agentSessionId
			let forkSessionId: string | null = null;
			try {
				const { useWorkspaceSessionStore } = require('./useWorkspaceSessionStore');
				forkSessionId = useWorkspaceSessionStore.getState().getAgentSessionId(employeeId);
			} catch { /* store not available */ }

			resetStream();
			set({ activeEmployeeId: employeeId, activeAgentSessionId: forkSessionId, messages: [], inputValue: '', agentSessions: [] });

			if (forkSessionId) {
				// Fork mode: directly load fork session
				get().loadHistoryForSession(employeeId, forkSessionId);
			} else {
				// Root mode: load existing sessions list, pick the most recent one if any.
				// Do NOT auto-create here — let sendMessage create with the first message as name.
				sendRequest<{ employeeId: string }, AgentSessionInfo[]>(
					'agentSession.list',
					{ employeeId },
				).then(sessions => {
					if (get().activeEmployeeId !== employeeId) { return; }
					set({ agentSessions: sessions || [] });
					if (sessions && sessions.length > 0) {
						const latest = sessions[0]; // already sorted by updatedAt desc from host
						set({ activeAgentSessionId: latest.id });
						get().loadHistoryForSession(employeeId, latest.id);
					}
					// If no sessions exist, leave activeAgentSessionId null.
					// sendMessage will auto-create on first message.
				}).catch(err => {
					console.error('[ChatStore] Failed to load agent sessions:', err);
				});
			}
		},

		loadHistory: async (employeeId: string) => {
			return get().loadHistoryForSession(employeeId, get().activeAgentSessionId ?? undefined);
		},

		loadHistoryForSession: async (employeeId: string, agentSessionId?: string) => {
			console.log(`[ChatStore] loadHistoryForSession: employeeId=${employeeId}, agentSessionId=${agentSessionId}`);
			set({ isLoading: true, activeAgentSessionId: agentSessionId ?? null });
			try {
				const messages = await sendRequest<{ employeeId: string; sessionId?: string }, ChatMessage[]>(
					'chat.history',
					{ employeeId, sessionId: agentSessionId }
				);
				// Guard: don't overwrite messages if the active employee has changed
				const currentActive = get().activeEmployeeId;
				if (currentActive !== employeeId) {
					console.warn(`[ChatStore] loadHistoryForSession: active employee changed (${currentActive} vs ${employeeId}), discarding stale history`);
					set({ isLoading: false });
					return;
				}
				// Guard: don't overwrite messages if streaming is in progress
				const currentMessages = get().messages;
				const { isStreaming } = getStreamState();
				if (isStreaming || currentMessages.length > 0) {
					console.warn(`[ChatStore] loadHistoryForSession: skipping — streaming=${isStreaming}, existingMessages=${currentMessages.length}`);
					set({ isLoading: false });
					return;
				}
				console.log(`[ChatStore] loadHistoryForSession: received ${messages?.length ?? 0} messages for ${employeeId}`);
				set({ messages: messages || [], isLoading: false });
			} catch (err) {
				console.error('[ChatStore] Failed to load history:', err);
				set({ isLoading: false });
			}
		},

		sendMessage: async (message: string) => {
			let { activeEmployeeId, activeAgentSessionId } = get();
			if (!activeEmployeeId || !message.trim()) { return; }

			const sessionName = message.trim().substring(0, 30);

			// If no session assigned yet, auto-create one with message as name
			if (!activeAgentSessionId) {
				try {
					const meta = await sendRequest<{ employeeId: string; name?: string }, AgentSessionInfo>(
						'agentSession.getActive',
						{ employeeId: activeEmployeeId, name: sessionName },
					);
					if (meta?.id) {
						activeAgentSessionId = meta.id;
						set({ activeAgentSessionId: meta.id });
						get().loadAgentSessions(activeEmployeeId);
					}
				} catch (err) {
					console.error('[ChatStore] Failed to auto-create session before send:', err);
				}
			} else {
				// Session exists — if this is the first message (no messages yet),
				// rename the session to the user's first message
				const currentMessages = get().messages;
				if (currentMessages.length === 0 && sessionName) {
					get().renameAgentSession(activeAgentSessionId, sessionName);
				}
			}

			// Resolve Fork context
			let workspaceSessionId: string | undefined;
			let workspaceId: string | undefined;
			try {
				const { useWorkspaceSessionStore } = require('./useWorkspaceSessionStore');
				const sessionState = useWorkspaceSessionStore.getState();
				workspaceSessionId = sessionState.activeSessionId ?? undefined;
				const { useWorkspaceStore: wsStore } = require('./useWorkspaceStore');
				workspaceId = wsStore.getState().activeWorkspaceId ?? undefined;
			} catch { /* store not available */ }

			// Add user message optimistically
			const userMessage: ChatMessage = {
				id: `user_${Date.now()}`,
				role: 'user',
				content: message,
				timestamp: new Date().toISOString(),
			};
			set(state => ({
				messages: [...state.messages, userMessage],
				inputValue: '',
			}));

			try {
				await sendRequest('chat.send', {
					employeeId: activeEmployeeId,
					message,
					agentSessionId: activeAgentSessionId ?? undefined,
					workspaceSessionId,
					workspaceId,
				});
				// After send completes, refresh session list to update messageCount
				get().loadAgentSessions(activeEmployeeId!);
			} catch (err) {
				console.error('[ChatStore] Failed to send message:', err);
				const errorMsg = err instanceof Error ? err.message : String(err);
				const errorMessage: ChatMessage = {
					id: `error_${Date.now()}`,
					role: 'system',
					content: `⚠️ 发送失败: ${errorMsg}`,
					timestamp: new Date().toISOString(),
				};
				set(state => ({ messages: [...state.messages, errorMessage] }));
				resetStream();
			}
		},

		cancelStream: () => {
			const { activeEmployeeId } = get();
			console.log(`[ChatStore] cancelStream: activeEmployeeId=${activeEmployeeId}`);
			if (activeEmployeeId) {
				sendRequest('chat.cancel', { employeeId: activeEmployeeId }).catch(() => {});
			}
			resetStream();
		},

		setInputValue: (value) => set({ inputValue: value }),

		clearMessages: () => {
			console.log('[ChatStore] clearMessages called');
			resetStream();
			set({ messages: [] });
		},

		appendExternalUserMessage: (employeeId, message) => {
			const { activeEmployeeId, messages } = get();
			// Only mirror the bubble if it belongs to the currently visible
			// employee — otherwise the user would see a phantom message in
			// an unrelated chat pane.
			if (activeEmployeeId !== employeeId) {
				console.log(`[ChatStore] appendExternalUserMessage skipped: target=${employeeId} active=${activeEmployeeId}`);
				return;
			}
			// De-dupe by id in case the same event arrives twice (e.g. fast
			// double-click on an imgui submit button).
			if (messages.some(m => m.id === message.id)) {
				return;
			}
			console.log(`[ChatStore] appendExternalUserMessage: ${employeeId} id=${message.id} len=${message.content.length}`);
			set(state => ({ messages: [...state.messages, message] }));
		},

		// ─── Agent Session Management (Root mode) ───

		loadAgentSessions: async (employeeId: string) => {
			try {
				const sessions = await sendRequest<{ employeeId: string }, AgentSessionInfo[]>(
					'agentSession.list',
					{ employeeId },
				);
				set({ agentSessions: sessions || [] });
			} catch (err) {
				console.error('[ChatStore] Failed to load agent sessions:', err);
			}
		},

		createAgentSession: async () => {
			const { activeEmployeeId } = get();
			if (!activeEmployeeId) { return; }
			try {
				const meta = await sendRequest<{ employeeId: string }, AgentSessionInfo>(
					'agentSession.create',
					{ employeeId: activeEmployeeId },
				);
				if (meta?.id) {
					resetStream();
					set({ activeAgentSessionId: meta.id, messages: [] });
					get().loadHistoryForSession(activeEmployeeId, meta.id);
					get().loadAgentSessions(activeEmployeeId);
				}
			} catch (err) {
				console.error('[ChatStore] Failed to create agent session:', err);
			}
		},

		switchAgentSession: async (sessionId: string) => {
			const { activeEmployeeId } = get();
			if (!activeEmployeeId) { return; }
			resetStream();
			set({ activeAgentSessionId: sessionId, messages: [] });
			get().loadHistoryForSession(activeEmployeeId, sessionId);
		},

		renameAgentSession: async (sessionId: string, newName: string) => {
			const { activeEmployeeId } = get();
			if (!activeEmployeeId) { return; }
			try {
				await sendRequest('agentSession.rename', {
					employeeId: activeEmployeeId,
					sessionId,
					name: newName,
				});
				// Update local list
				set(state => ({
					agentSessions: state.agentSessions.map(s =>
						s.id === sessionId ? { ...s, name: newName } : s,
					),
				}));
			} catch (err) {
				console.error('[ChatStore] Failed to rename session:', err);
			}
		},

		deleteAgentSession: async (sessionId: string) => {
			const { activeEmployeeId, activeAgentSessionId } = get();
			if (!activeEmployeeId) { return; }
			try {
				await sendRequest('agentSession.delete', {
					employeeId: activeEmployeeId,
					sessionId,
				});
				// If we deleted the active session, switch back to default
				if (activeAgentSessionId === sessionId) {
					resetStream();
					set({ activeAgentSessionId: null, messages: [] });
					get().loadHistoryForSession(activeEmployeeId, undefined);
				}
				// Reload session list
				get().loadAgentSessions(activeEmployeeId);
			} catch (err) {
				console.error('[ChatStore] Failed to delete agent session:', err);
			}
		},
	};
});
