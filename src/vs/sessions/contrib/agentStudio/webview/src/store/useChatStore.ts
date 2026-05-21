/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Store (Zustand)
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';
import { subscribeStream, onStreamComplete, getStreamState, resetStream, resetStreamSilent, switchActiveStream, type StreamState, type StreamError } from '../bridge/streamHandler';
import { useEmployeeStore } from './useEmployeeStore';

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'tool' | 'system';
	content: string;
	thinking?: string;
	toolCalls?: { id: string; name: string; arguments: string; result?: string; status: string; defaultShow?: boolean }[];
	tokenUsage?: { input: number; output: number; total: number };
	timestamp: string;
	/** Structured error info for system error messages (VS Code Copilot Chat pattern) */
	error?: StreamError;
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
			return;
		}
		if (streamState.isStreaming && streamState.sessionId && activeAgentSessionId &&
			streamState.sessionId !== activeAgentSessionId) {
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

		// Guard: if the user already cancelled this stream (via cancelStream()),
		// the partial content has been committed as a `cancelled_*` message.
		// The host-side abort still triggers a `chat.stream.complete` event —
		// discard it to avoid duplicate messages (VS Code Copilot Chat pattern).
		const { messages } = get();
		const lastMsg = messages[messages.length - 1];
		if (lastMsg && lastMsg.id.startsWith('cancelled_')) {
			console.log('[ChatStore] onStreamComplete: discarding — stream was already cancelled by user');
			resetStreamSilent();
			set({ streamState: getStreamState() });
			return;
		}

		if (finalState.errorMessage) {
			// API returned an error — show it as a system error message
			// Use structured error info if available (VS Code Copilot Chat pattern)
			const structuredError = finalState.error || { message: finalState.errorMessage, level: 'error' as const };
			const errorIcon = structuredError.level === 'warning' ? '⚠️' : structuredError.level === 'info' ? 'ℹ️' : '❌';
			const errorMessage: ChatMessage = {
				id: `error_${Date.now()}`,
				role: 'system',
				content: `${errorIcon} ${finalState.errorMessage}`,
				timestamp: new Date().toISOString(),
				error: structuredError,
			};
			// Reset silently (no notify) then atomically commit error + streamState
			resetStreamSilent();
			set(state => ({
				messages: [...state.messages, errorMessage],
				streamState: getStreamState(),
			}));
			// Restore employee status AFTER messages are committed
			try { syncEmployeeStatus('idle'); } catch { /* ignore */ }
			console.log('[ChatStore] Error message committed', { level: structuredError.level, retryable: structuredError.retryable });
			return;
		}

		// Prefer the host-assembled message (hostMessage) as the authoritative source
		// because it accumulates ALL deltas server-side without any risk of missing
		// chunks due to RAF cancellation, background-stream switching, or other
		// webview-side timing issues. Fall back to the webview-side buffers only
		// when the host didn't provide the field.
		// Additionally, as a defensive measure, always pick the LONGER of the two
		// sources — this guards against any scenario where the webview buffer is
		// truncated (e.g. switch-related timing) or the hostMessage is unexpectedly
		// incomplete (e.g. error mid-stream where host still sends partial content).
		const hostText = (hostMessage?.content as string) || '';
		const hostThinking = (hostMessage?.thinking as string) || '';
		const textContent = hostText.length >= finalState.textBuffer.length ? hostText : finalState.textBuffer;
		const thinkingContent = hostThinking.length >= finalState.thinkingBuffer.length ? hostThinking : finalState.thinkingBuffer;

		console.log('[ChatStore] Building assistant message:', {
			textContentLen: textContent.length,
			textContentPreview: textContent.substring(0, 80),
			thinkingContentLen: thinkingContent.length,
			usedHostText: textContent === hostText,
			usedHostThinking: thinkingContent === hostThinking,
			hostTextLen: hostText.length,
			hostThinkingLen: hostThinking.length,
			bufferTextLen: finalState.textBuffer.length,
			bufferThinkingLen: finalState.thinkingBuffer.length,
		});

		// DEBUG: Detect content mismatch between streaming buffer and host message
		if (hostText && finalState.textBuffer && hostText !== finalState.textBuffer) {
			console.warn('[ChatStore] ⚠️ CONTENT MISMATCH between stream buffer and host message!', {
				bufferFirst100: finalState.textBuffer.substring(0, 100),
				hostFirst100: hostText.substring(0, 100),
				bufferLast100: finalState.textBuffer.substring(Math.max(0, finalState.textBuffer.length - 100)),
				hostLast100: hostText.substring(Math.max(0, hostText.length - 100)),
				// Check heading normalization difference
				bufferHeadings: (finalState.textBuffer.match(/^#{1,6}.{0,30}/gm) || []).slice(0, 5),
				hostHeadings: (hostText.match(/^#{1,6}.{0,30}/gm) || []).slice(0, 5),
			});
		}

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
					defaultShow: tc.defaultShow,
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

			// Save current stream to background and restore any saved stream for the new employee.
			// Must be done atomically with updating activeEmployeeId so subscribeStream
			// doesn't discard the restored stream due to stale activeEmployeeId.
			const newStreamState = switchActiveStream(employeeId, forkSessionId);
			set({
				activeEmployeeId: employeeId,
				activeAgentSessionId: forkSessionId,
				messages: [],
				inputValue: '',
				agentSessions: [],
				streamState: newStreamState,
			});

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
				// Guard: don't overwrite messages if local messages already exist
				// (e.g. user typed something during the await, or a background
				// stream completion already appended an assistant message). We
				// must NOT guard on `isStreaming` here — when the user switches
				// back to an employee whose stream is still running, we restored
				// its background streamState and need the historical messages
				// to render alongside the live streaming bubble. Skipping here
				// would leave the chat panel empty (only the streaming bubble).
				const currentMessages = get().messages;
				if (currentMessages.length > 0) {
					console.warn(`[ChatStore] loadHistoryForSession: skipping — existingMessages=${currentMessages.length}`);
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
			// Guard: never send empty or whitespace-only messages to the LLM
			if (!message || !message.trim()) { return; }
			let { activeEmployeeId, activeAgentSessionId, streamState } = get();
			if (!activeEmployeeId) { return; }

			// ── Auto-cancel current stream if still running (VS Code Copilot Chat
			// "steering" pattern: sending a new message interrupts the current one) ──
			if (streamState.isStreaming) {
				console.log('[ChatStore] sendMessage: auto-cancelling active stream before sending new message');
				get().cancelStream();
			}

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
			const { activeEmployeeId, activeAgentSessionId, streamState } = get();
			console.log(`[ChatStore] cancelStream: activeEmployeeId=${activeEmployeeId}, activeAgentSessionId=${activeAgentSessionId}`);

			// ── Preserve already-generated content (VS Code Copilot Chat pattern) ──
			// Instead of discarding everything, commit partial content as a cancelled message.
			const partialText = streamState.textBuffer || '';
			const partialThinking = streamState.thinkingBuffer || '';

			// Reset the stream state first (stops the streaming bubble)
			resetStreamSilent();

			if (partialText || partialThinking) {
				// Commit partial content as a cancelled assistant message
				const cancelledMessage: ChatMessage = {
					id: `cancelled_${Date.now()}`,
					role: 'assistant',
					content: partialText || '(已停止生成)',
					thinking: partialThinking || undefined,
					timestamp: new Date().toISOString(),
				};
				set(state => ({
					messages: [...state.messages, cancelledMessage],
					streamState: getStreamState(),
				}));
				console.log('[ChatStore] cancelStream: committed partial content as cancelled message', {
					textLen: partialText.length,
					thinkingLen: partialThinking.length,
				});
			} else {
				set({ streamState: getStreamState() });
			}

			// Notify host to abort the upstream stream
			if (activeEmployeeId) {
				sendRequest('chat.cancel', { employeeId: activeEmployeeId, agentSessionId: activeAgentSessionId ?? undefined }).catch(() => { });
			}

			// Restore employee status
			try { syncEmployeeStatus('idle'); } catch { /* ignore */ }
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
					const newStreamState = switchActiveStream(activeEmployeeId, meta.id);
					set({ activeAgentSessionId: meta.id, messages: [], streamState: newStreamState });
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
			const newStreamState = switchActiveStream(activeEmployeeId, sessionId);
			set({ activeAgentSessionId: sessionId, messages: [], streamState: newStreamState });
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
					const newStreamState = switchActiveStream(activeEmployeeId, null);
					set({ activeAgentSessionId: null, messages: [], streamState: newStreamState });
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
