/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Store (Zustand)
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';
import { subscribeStream, getStreamState, resetStream, type StreamState } from '../bridge/streamHandler';

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
	// Subscribe to stream state updates
	subscribeStream((streamState) => {
		set({ streamState });
	});

	return {
		messages: [],
		streamState: getStreamState(),
		inputValue: '',
		isLoading: false,
		activeEmployeeId: null,

		setActiveEmployee: (employeeId: string) => {
			resetStream();
			set({ activeEmployeeId: employeeId, messages: [], inputValue: '' });
			get().loadHistory(employeeId);
		},

		loadHistory: async (employeeId: string) => {
			set({ isLoading: true });
			try {
				const messages = await sendRequest<{ employeeId: string }, ChatMessage[]>(
					'chat.history',
					{ employeeId }
				);
				set({ messages, isLoading: false });
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
			set(state => ({
				messages: [...state.messages, userMessage],
				inputValue: '',
			}));

			// Send to host (streaming will be handled by streamHandler)
			try {
				await sendRequest('chat.send', {
					employeeId: activeEmployeeId,
					message,
				});

				// After completion, add the assistant message from stream buffer
				const { streamState } = get();
				if (streamState.textBuffer) {
					const assistantMessage: ChatMessage = {
						id: `asst_${Date.now()}`,
						role: 'assistant',
						content: streamState.textBuffer,
						thinking: streamState.thinkingBuffer || undefined,
						toolCalls: streamState.toolCalls.map(tc => ({
							id: tc.id,
							name: tc.name,
							arguments: tc.arguments,
							result: tc.result,
							status: tc.status,
						})),
						timestamp: new Date().toISOString(),
					};
					set(state => ({ messages: [...state.messages, assistantMessage] }));
					resetStream();
				}
			} catch (err) {
				console.error('[ChatStore] Failed to send message:', err);
			}
		},

		cancelStream: () => {
			const { activeEmployeeId } = get();
			if (activeEmployeeId) {
				sendRequest('chat.cancel', { employeeId: activeEmployeeId }).catch(() => {});
			}
			resetStream();
		},

		setInputValue: (value) => set({ inputValue: value }),

		clearMessages: () => {
			resetStream();
			set({ messages: [] });
		},
	};
});
