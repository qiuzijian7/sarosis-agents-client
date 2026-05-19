/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Stream Handler
 *
 *  Receives chat.stream.delta events from the Host (already frame-throttled at 16ms),
 *  and provides a React-friendly interface for streaming text updates.
 *--------------------------------------------------------------------------------------------*/

export interface StreamChunk {
	type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'error' | 'done';
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
	errorMessage: string | null;
}

export interface ToolCallState {
	id: string;
	name: string;
	arguments: string;
	result?: string;
	status: 'running' | 'done' | 'error';
}

type StreamListener = (state: StreamState) => void;
type StreamCompleteCallback = (state: StreamState, hostMessage?: any) => void;

const listeners = new Set<StreamListener>();
const completeCallbacks = new Set<StreamCompleteCallback>();
let currentState: StreamState = createInitialState();
let pendingRafId: number | null = null;

function createInitialState(): StreamState {
	return {
		isStreaming: false,
		employeeId: null,
		sessionId: null,
		textBuffer: '',
		thinkingBuffer: '',
		toolCalls: [],
		errorMessage: null,
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
 * Register a callback that fires when a stream completes (success or error).
 * The callback receives the final StreamState snapshot before reset.
 * Returns an unsubscribe function.
 */
export function onStreamComplete(callback: StreamCompleteCallback): () => void {
	completeCallbacks.add(callback);
	return () => completeCallbacks.delete(callback);
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
 * Total number of delta events received in the current stream.
 * Used for diagnostics.
 */
let deltaEventCount = 0;

/**
 * Handle a stream delta event from the Host.
 * Called by the message event handler in messageClient.
 */
export function handleStreamDelta(data: {
	employeeId: string;
	sessionId: string;
	chunks: StreamChunk[];
}): void {
	// If a stream is already active, discard deltas that don't match
	// the current stream's employeeId/sessionId (e.g. stale deltas
	// from a previous chat that arrived after the user switched).
	if (currentState.isStreaming) {
		if (data.employeeId !== currentState.employeeId || data.sessionId !== currentState.sessionId) {
			console.warn(`[StreamHandler] Discarding stale delta for employee=${data.employeeId}, sessionId=${data.sessionId} ` +
				`(current: employee=${currentState.employeeId}, sessionId=${currentState.sessionId})`);
			return;
		}
	} else {
		deltaEventCount = 0;
		currentState = {
			...createInitialState(),
			isStreaming: true,
			employeeId: data.employeeId,
			sessionId: data.sessionId,
		};
		console.log(`[StreamHandler] Stream started for employee=${data.employeeId}`);
	}

	deltaEventCount++;

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
			case 'error':
				currentState = {
					...currentState,
					errorMessage: chunk.content || 'Unknown error',
				};
				break;
			case 'done':
				// Stream finished — no action needed, completion is handled by handleStreamComplete
				break;
		}
	}

	// Use RAF to batch notify — WebView-side dedupe.
	// Track the RAF id so we can cancel it on stream reset/complete.
	if (pendingRafId !== null) {
		cancelAnimationFrame(pendingRafId);
	}
	pendingRafId = requestAnimationFrame(() => {
		pendingRafId = null;
		notify();
	});
}

/**
 * Handle stream completion.
 */
export function handleStreamComplete(data: {
	employeeId: string;
	sessionId: string;
	message: unknown;
}): void {
	const wasStreaming = currentState.isStreaming;
	const hostMsg = data.message as Record<string, unknown> | undefined;

	console.log(`[StreamHandler] handleStreamComplete: wasStreaming=${wasStreaming}, deltaCount=${deltaEventCount}, ` +
		`textBufferLen=${currentState.textBuffer.length}, thinkingBufferLen=${currentState.thinkingBuffer.length}, ` +
		`hostMsg.content?.len=${typeof hostMsg?.content === 'string' ? hostMsg.content.length : 'N/A'}, ` +
		`hostMsg.error=${hostMsg?.error ?? 'none'}`);

	// Guard: if the stream was already reset (e.g. by a preceding handleStreamError)
	// AND we have no useful hostMessage to salvage, skip to avoid double-processing.
	if (!wasStreaming && !hostMsg?.content && !hostMsg?.thinking) {
		console.log('[StreamHandler] handleStreamComplete: skipping — stream already reset and no hostMessage content');
		return;
	}

	// Cancel any pending RAF from the last delta — we will notify synchronously
	// after the callbacks have committed their state.
	if (pendingRafId !== null) {
		cancelAnimationFrame(pendingRafId);
		pendingRafId = null;
	}

	// Snapshot the final state BEFORE modifying anything — this preserves
	// textBuffer / thinkingBuffer so completeCallbacks can build messages.
	const finalState: StreamState = {
		...currentState,
		isStreaming: false,
	};

	console.log(`[StreamHandler] handleStreamComplete: finalState snapshot — ` +
		`textBufferLen=${finalState.textBuffer.length}, thinkingBufferLen=${finalState.thinkingBuffer.length}, ` +
		`errorMessage=${finalState.errorMessage ?? 'none'}, toolCalls=${finalState.toolCalls.length}`);

	// Fire completion callbacks first.  The useChatStore callback will
	// atomically add the assistant message to `messages[]` **and** call
	// resetStream(), which in turn sets currentState to initial and
	// calls notify().  We intentionally do NOT call notify() ourselves
	// afterwards — doing so would push the already-reset (empty) state
	// into subscribeStream listeners a second time, causing a redundant
	// React render where the streaming bubble vanishes before the new
	// message entry has been committed to the store.
	for (const cb of completeCallbacks) {
		try {
			cb(finalState, data.message);
		} catch (err) {
			console.error('[StreamHandler] completeCallback threw:', err);
		}
	}

	// If no callback called resetStream() (defensive), make sure we
	// still transition out of the streaming state.
	if (currentState.isStreaming) {
		currentState = { ...currentState, isStreaming: false };
		notify();
	}
}

/**
 * Handle stream error.
 */
export function handleStreamError(data: {
	employeeId: string;
	sessionId: string;
	error: string;
}): void {
	console.error(`[StreamHandler] handleStreamError: employee=${data.employeeId}, ` +
		`wasStreaming=${currentState.isStreaming}, deltaCount=${deltaEventCount}, error="${data.error}"`);

	// Cancel any pending RAF from the last delta
	if (pendingRafId !== null) {
		cancelAnimationFrame(pendingRafId);
		pendingRafId = null;
	}

	// Snapshot the error state before callbacks may resetStream
	const finalState: StreamState = {
		...currentState,
		isStreaming: false,
		errorMessage: data.error || 'Unknown stream error',
	};

	// Fire completion callbacks — same atomic pattern as handleStreamComplete
	for (const cb of completeCallbacks) {
		try {
			cb(finalState);
		} catch (err) {
			console.error('[StreamHandler] error completeCallback threw:', err);
		}
	}

	// Defensive: if no callback reset the stream, do it now
	if (currentState.isStreaming) {
		currentState = { ...currentState, isStreaming: false, errorMessage: data.error || 'Unknown stream error' };
		notify();
	}
}

/**
 * Reset stream state (e.g., when switching employees).
 */
export function resetStream(): void {
	if (pendingRafId !== null) {
		cancelAnimationFrame(pendingRafId);
		pendingRafId = null;
	}
	currentState = createInitialState();
	notify();
}

/**
 * Reset stream state WITHOUT notifying listeners.
 * Used by onStreamComplete callbacks that need to read the reset state
 * and commit it atomically together with other store updates, avoiding
 * an intermediate render where the streaming bubble is gone but the
 * persisted message hasn't appeared yet.
 */
export function resetStreamSilent(): void {
	if (pendingRafId !== null) {
		cancelAnimationFrame(pendingRafId);
		pendingRafId = null;
	}
	currentState = createInitialState();
}
