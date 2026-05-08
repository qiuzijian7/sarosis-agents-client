/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Stream Handler
 *
 *  Receives chat.stream.delta events from the Host (already frame-throttled at 16ms),
 *  and provides a React-friendly interface for streaming text updates.
 *--------------------------------------------------------------------------------------------*/

export interface StreamChunk {
	type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result';
	content?: string;
	toolCallId?: string;
	toolName?: string;
}

export interface StreamState {
	isStreaming: boolean;
	employeeId: string | null;
	sessionId: string | null;
	textBuffer: string;
	thinkingBuffer: string;
	toolCalls: ToolCallState[];
}

export interface ToolCallState {
	id: string;
	name: string;
	arguments: string;
	result?: string;
	status: 'running' | 'done' | 'error';
}

type StreamListener = (state: StreamState) => void;

const listeners = new Set<StreamListener>();
let currentState: StreamState = createInitialState();

function createInitialState(): StreamState {
	return {
		isStreaming: false,
		employeeId: null,
		sessionId: null,
		textBuffer: '',
		thinkingBuffer: '',
		toolCalls: [],
	};
}

/**
 * Subscribe to stream state changes.
 * Returns an unsubscribe function.
 */
export function subscribeStream(listener: StreamListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Get the current stream state.
 */
export function getStreamState(): StreamState {
	return currentState;
}

function notify(): void {
	for (const listener of listeners) {
		listener(currentState);
	}
}

/**
 * Handle a stream delta event from the Host.
 * Called by the message event handler in messageClient.
 */
export function handleStreamDelta(data: {
	employeeId: string;
	sessionId: string;
	chunks: StreamChunk[];
}): void {
	if (!currentState.isStreaming) {
		currentState = {
			...createInitialState(),
			isStreaming: true,
			employeeId: data.employeeId,
			sessionId: data.sessionId,
		};
	}

	for (const chunk of data.chunks) {
		switch (chunk.type) {
			case 'text':
				currentState.textBuffer += chunk.content ?? '';
				break;
			case 'thinking':
				currentState.thinkingBuffer += chunk.content ?? '';
				break;
			case 'tool_start':
				currentState.toolCalls.push({
					id: chunk.toolCallId ?? '',
					name: chunk.toolName ?? '',
					arguments: '',
					status: 'running',
				});
				break;
			case 'tool_args': {
				const call = currentState.toolCalls.find(tc => tc.id === chunk.toolCallId);
				if (call) {
					call.arguments += chunk.content ?? '';
				}
				break;
			}
			case 'tool_end': {
				const endCall = currentState.toolCalls.find(tc => tc.id === chunk.toolCallId);
				if (endCall) {
					endCall.status = 'done';
				}
				break;
			}
			case 'tool_result': {
				const resultCall = currentState.toolCalls.find(tc => tc.id === chunk.toolCallId);
				if (resultCall) {
					resultCall.result = chunk.content;
				}
				break;
			}
		}
	}

	// Use RAF to batch notify — WebView-side dedupe
	requestAnimationFrame(() => notify());
}

/**
 * Handle stream completion.
 */
export function handleStreamComplete(_data: {
	employeeId: string;
	sessionId: string;
	message: unknown;
}): void {
	currentState = {
		...currentState,
		isStreaming: false,
	};
	notify();
}

/**
 * Handle stream error.
 */
export function handleStreamError(data: {
	employeeId: string;
	sessionId: string;
	error: string;
}): void {
	currentState = {
		...currentState,
		isStreaming: false,
	};
	notify();
	console.error(`[AgentStudio] Stream error for ${data.employeeId}: ${data.error}`);
}

/**
 * Reset stream state (e.g., when switching employees).
 */
export function resetStream(): void {
	currentState = createInitialState();
	notify();
}
