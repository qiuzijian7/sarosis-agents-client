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
	timestamp: string;
}

interface ChatState {
	messages: ChatMessage[];
	streamState: StreamState;
	inputValue: string;
	isLoading: boolean;
	activeEmployeeId: string | null;

	// Actions
	setActiveEmployee: (employeeId: string) => void;
	loadHistory: (employeeId: string) => Promise<void>;
	sendMessage: (message: string) => Promise<void>;
	cancelStream: () => void;
	setInputValue: (value: string) => void;
	clearMessages: () => void;
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

		setActiveEmployee: (employeeId: string) => {
			const current = get().activeEmployeeId;
			console.log(`[ChatStore] setActiveEmployee: ${current} → ${employeeId}`);
			if (current === employeeId) {
				console.log('[ChatStore] setActiveEmployee: same employee, skipping');
				return; // Don't reset when already active
			}
			resetStream();
			set({ activeEmployeeId: employeeId, messages: [], inputValue: '' });
			get().loadHistory(employeeId);
		},

		loadHistory: async (employeeId: string) => {
			console.log(`[ChatStore] loadHistory: employeeId=${employeeId}`);
			set({ isLoading: true });
			try {
				const messages = await sendRequest<{ employeeId: string }, ChatMessage[]>(
					'chat.history',
					{ employeeId }
				);
				// Guard: don't overwrite messages if the active employee has changed
				const currentActive = get().activeEmployeeId;
				if (currentActive !== employeeId) {
					console.warn(`[ChatStore] loadHistory: active employee changed (${currentActive} vs ${employeeId}), discarding stale history`);
					set({ isLoading: false });
					return;
				}
				// Guard: don't overwrite messages if streaming is in progress
				// (the response arrived after the user already started a conversation)
				const currentMessages = get().messages;
				const { isStreaming } = getStreamState();
				if (isStreaming || currentMessages.length > 0) {
					console.warn(`[ChatStore] loadHistory: skipping — streaming=${isStreaming}, existingMessages=${currentMessages.length}`);
					set({ isLoading: false });
					return;
				}
				console.log(`[ChatStore] loadHistory: received ${messages?.length ?? 0} messages for ${employeeId}`);
				set({ messages: messages || [], isLoading: false });
			} catch (err) {
				console.error('[ChatStore] Failed to load history:', err);
				set({ isLoading: false });
			}
		},

		sendMessage: async (message: string) => {
			const { activeEmployeeId } = get();
			if (!activeEmployeeId || !message.trim()) { return; }

			// Add user message optimistically
			const userMessage: ChatMessage = {
				id: `user_${Date.now()}`,
				role: 'user',
				content: message,
				timestamp: new Date().toISOString(),
			};
			set(state => {
				console.log(`[ChatStore] sendMessage: adding user message, current count=${state.messages.length}`);
				return {
					messages: [...state.messages, userMessage],
					inputValue: '',
				};
			});

			// Send to host — returns immediately with { status: 'streaming' }.
			// The actual content arrives via chat.stream.delta / chat.stream.complete events
			// which are handled by streamHandler and the subscribeStream listener below.
			try {
				await sendRequest('chat.send', {
					employeeId: activeEmployeeId,
					message,
				});
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
	};
});
