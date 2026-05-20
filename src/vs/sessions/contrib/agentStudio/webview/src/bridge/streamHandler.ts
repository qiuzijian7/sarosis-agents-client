/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Stream Handler
 *
 *  Receives chat.stream.delta events from the Host (already frame-throttled at 16ms),
 *  and provides a React-friendly interface for streaming text updates.
 *--------------------------------------------------------------------------------------------*/

export interface StreamChunk {
	type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'error' | 'done' | 'content_replace';
	content?: string;
	toolCallId?: string;
	toolName?: string;
	success?: boolean;
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

/**
 * The employeeId that the UI is currently displaying.
 * Set by switchActiveStream() — used by handleStreamDelta() Case 4 to decide
 * whether a brand-new stream should become the foreground `currentState` or be
 * placed into background.  Without this guard, a late-arriving first delta for
 * a previously-active employee would hijack `currentState`, causing its notify
 * snapshots to be discarded by subscribeStream (employee mismatch) while also
 * preventing the real background accumulation path from being used.
 */
let activeEmployeeId: string | null = null;

/** Per-employee stream states for employees that are not currently displayed.
 *  When the user switches away from a streaming employee, the stream state
 *  is saved here so it can be restored when they switch back. */
const backgroundStreams = new Map<string, StreamState>();

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

/** Build a map key from employeeId only.
 *  We intentionally ignore sessionId because the Host may send deltas
 *  with a sessionId that changes during the stream (e.g. from null to
 *  an actual value). Using employeeId alone is safe because a given
 *  employee can only have one active stream at a time in the webview. */
function streamKey(employeeId: string | null): string {
	return employeeId ?? '';
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
 * Get a snapshot of the current stream state.
 * Returns a new object reference to ensure Zustand detects the change.
 */
export function getStreamState(): StreamState {
	return {
		...currentState,
		toolCalls: currentState.toolCalls.map(tc => ({ ...tc })),
	};
}

function notify(): void {
	// IMPORTANT: We must pass a NEW object reference to listeners so that
	// Zustand's shallow-equality check detects a change and triggers a
	// React re-render. Without this, mutations to currentState (e.g.
	// thinkingBuffer += ...) would go unnoticed since the object ref
	// stays the same.
	const snapshot: StreamState = {
		...currentState,
		toolCalls: currentState.toolCalls.map(tc => ({ ...tc })),
	};
	for (const listener of listeners) {
		listener(snapshot);
	}
}

/**
 * Total number of delta events received in the current stream.
 * Used for diagnostics.
 */
let deltaEventCount = 0;

/** Accumulate a single chunk into a StreamState (mutates state in-place). */
function accumulateChunk(state: StreamState, chunk: StreamChunk): void {
	switch (chunk.type) {
		case 'text':
			state.textBuffer += chunk.content ?? '';
			break;
		case 'thinking':
			state.thinkingBuffer += chunk.content ?? '';
			break;
		case 'content_replace':
			// Replace the entire text buffer with the new content.
			// Used when tool calls are extracted from text and the original
			// JSON content should no longer be displayed.
			state.textBuffer = chunk.content ?? '';
			break;
		case 'tool_start':
			state.toolCalls.push({
				id: chunk.toolCallId ?? '',
				name: chunk.toolName ?? '',
				arguments: '',
				status: 'running',
			});
			break;
		case 'tool_args': {
			const call = state.toolCalls.find(tc => tc.id === chunk.toolCallId);
			if (call) {
				call.arguments += chunk.content ?? '';
			}
			break;
		}
		case 'tool_end': {
			const endCall = state.toolCalls.find(tc => tc.id === chunk.toolCallId);
			if (endCall) {
				endCall.status = chunk.success === false ? 'error' : 'done';
			}
			break;
		}
		case 'tool_result': {
			const resultCall = state.toolCalls.find(tc => tc.id === chunk.toolCallId);
			if (resultCall) {
				resultCall.result = chunk.content;
			}
			break;
		}
		case 'error':
			state.errorMessage = chunk.content || 'Unknown error';
			break;
		case 'done':
			// Stream finished — no action needed, completion is handled by handleStreamComplete
			break;
	}
}

/**
 * Handle a stream delta event from the Host.
 * Called by the message event handler in messageClient.
 *
 * Supports background stream accumulation: if the delta belongs to a
 * different employee/session than the currently displayed one, the chunks
 * are accumulated into a background stream stored in `backgroundStreams`.
 * When the user switches back to that employee, the background stream is
 * restored so no content is lost.
 */
export function handleStreamDelta(data: {
	employeeId: string;
	sessionId: string;
	chunks: StreamChunk[];
}): void {
	const deltaKey = streamKey(data.employeeId);
	const currentKey = streamKey(currentState.employeeId);

	// ── Case 1: Delta matches the currently displayed stream (same employee) ──
	// We match by employeeId only, because the Host may change sessionId mid-stream.
	if (currentState.isStreaming && data.employeeId === currentState.employeeId) {
		// Keep sessionId in sync if the Host sent a different one
		if (data.sessionId !== currentState.sessionId) {
			currentState.sessionId = data.sessionId;
		}
		deltaEventCount++;
		for (const chunk of data.chunks) {
			accumulateChunk(currentState, chunk);
		}
		scheduleNotify();
		return;
	}

	// ── Case 2: Delta is for a different employee (background stream) ──
	if (currentState.isStreaming && data.employeeId !== currentState.employeeId) {
		let bg = backgroundStreams.get(deltaKey);
		if (!bg) {
			bg = {
				...createInitialState(),
				isStreaming: true,
				employeeId: data.employeeId,
				sessionId: data.sessionId,
			};
			backgroundStreams.set(deltaKey, bg);
			console.log(`[StreamHandler] Background stream started for employee=${data.employeeId}, sessionId=${data.sessionId}`);
		}
		for (const chunk of data.chunks) {
			accumulateChunk(bg, chunk);
		}
		// No notify — background streams are not displayed
		return;
	}

	// ── Case 3: No current stream, check for existing background stream ──
	const existingBg = backgroundStreams.get(deltaKey);
	if (existingBg) {
		for (const chunk of data.chunks) {
			accumulateChunk(existingBg, chunk);
		}
		return;
	}

	// ── Case 4: No current stream, no background stream ──
	// If the delta belongs to the currently active employee (or no employee is
	// active yet), start it as the foreground stream.  Otherwise, this is a
	// late-arriving delta for a non-displayed employee — place it into
	// background so it doesn't hijack `currentState` and produce notify()
	// snapshots that subscribeStream will just discard (employee mismatch).
	if (activeEmployeeId && data.employeeId !== activeEmployeeId) {
		// Start as background stream
		const bg: StreamState = {
			...createInitialState(),
			isStreaming: true,
			employeeId: data.employeeId,
			sessionId: data.sessionId,
		};
		for (const chunk of data.chunks) {
			accumulateChunk(bg, chunk);
		}
		backgroundStreams.set(deltaKey, bg);
		console.log(`[StreamHandler] Late delta → started background stream for employee=${data.employeeId} (active=${activeEmployeeId})`);
		return;
	}

	// Start as foreground stream
	deltaEventCount = 0;
	currentState = {
		...createInitialState(),
		isStreaming: true,
		employeeId: data.employeeId,
		sessionId: data.sessionId,
	};
	console.log(`[StreamHandler] Stream started for employee=${data.employeeId}`);

	for (const chunk of data.chunks) {
		accumulateChunk(currentState, chunk);
	}
	scheduleNotify();
}

/** Schedule a RAF-batched notify to listeners. */
function scheduleNotify(): void {
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
	const key = streamKey(data.employeeId);
	const currentKey = streamKey(currentState.employeeId);

	// ── Check if this completion is for a background stream ──
	const bg = backgroundStreams.get(key);
	if (bg && key !== currentKey) {
		console.log(`[StreamHandler] Background stream completed for employee=${data.employeeId}, sessionId=${data.sessionId}`);
		backgroundStreams.delete(key);
		// The host has persisted the message. When the user switches back
		// to this employee, loadHistoryForSession will fetch it.
		// No callbacks fired — the stream was not being displayed.
		return;
	}

	// ── Completion for the currently displayed stream ──
	const wasStreaming = currentState.isStreaming;
	const hostMsg = data.message as Record<string, unknown> | undefined;

	console.log(`[StreamHandler] handleStreamComplete: wasStreaming=${wasStreaming}, deltaCount=${deltaEventCount}, ` +
		`textBufferLen=${currentState.textBuffer.length}, thinkingBufferLen=${currentState.thinkingBuffer.length}, ` +
		`hostMsg.content?.len=${typeof hostMsg?.content === 'string' ? hostMsg.content.length : 'N/A'}, ` +
		`hostMsg.thinking?.len=${typeof hostMsg?.thinking === 'string' ? hostMsg.thinking.length : 'N/A'}, ` +
		`hostMsg.error=${hostMsg?.error ?? 'none'}`);
	if (typeof hostMsg?.thinking === 'string' && currentState.thinkingBuffer.length > 0) {
		const bufLen = currentState.thinkingBuffer.length;
		const hostLen = (hostMsg.thinking as string).length;
		if (hostLen > bufLen) {
			console.warn(`[StreamHandler] ⚠️ THINKING MISMATCH: hostMsg.thinking (${hostLen}) > buffer (${bufLen}). ` +
				`Buffer may be incomplete! Buffer starts with: "${currentState.thinkingBuffer.substring(0, 60)}..." ` +
				`Host starts with: "${(hostMsg.thinking as string).substring(0, 60)}..."`);
		}
	}

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
	const key = streamKey(data.employeeId);
	const currentKey = streamKey(currentState.employeeId);

	// ── Check if this error is for a background stream ──
	const bg = backgroundStreams.get(key);
	if (bg && key !== currentKey) {
		console.log(`[StreamHandler] Background stream error for employee=${data.employeeId}: "${data.error}"`);
		backgroundStreams.delete(key);
		return;
	}

	// ── Error for the currently displayed stream ──
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
	// Do NOT clear backgroundStreams here — other agents may still
	// have active streams that should be preserved for when the user
	// switches back.
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
	// Do NOT clear backgroundStreams — same rationale as resetStream.
}

/**
 * Switch the active stream context when the user switches to a different
 * employee/session. Saves the current stream (if active) to the background
 * map and restores any previously saved stream for the new context.
 *
 * Does NOT notify listeners — the caller should set the returned StreamState
 * in the store alongside updating activeEmployeeId in a single atomic set()
 * call, so React never sees an intermediate state where the employee has
 * changed but the stream hasn't.
 *
 * Returns the StreamState that should be displayed for the new context.
 */
export function switchActiveStream(employeeId: string | null, sessionId: string | null): StreamState {
	// Cancel any pending RAF
	if (pendingRafId !== null) {
		cancelAnimationFrame(pendingRafId);
		pendingRafId = null;
	}

	// Update the active employee marker FIRST — this ensures that any delta
	// arriving after this point for the OLD employee will be routed to
	// background (Case 2/3/4-bg) instead of hijacking currentState.
	activeEmployeeId = employeeId;

	// Save current stream to background if it's active
	if (currentState.isStreaming && currentState.employeeId) {
		const currentKey = streamKey(currentState.employeeId);
		backgroundStreams.set(currentKey, {
			...currentState,
			toolCalls: currentState.toolCalls.map(tc => ({ ...tc })),
		});
		console.log(`[StreamHandler] Saved current stream to background: employee=${currentState.employeeId}, sessionId=${currentState.sessionId}`);
	}

	// Check if there's a background stream for the new context
	const newKey = streamKey(employeeId);
	const saved = backgroundStreams.get(newKey);
	if (saved) {
		backgroundStreams.delete(newKey);
		currentState = saved;
		console.log(`[StreamHandler] Restored background stream for employee=${employeeId}, sessionId=${sessionId} ` +
			`(textLen=${saved.textBuffer.length}, thinkingLen=${saved.thinkingBuffer.length})`);
	} else {
		currentState = createInitialState();
	}

	// Do NOT notify here — the caller will set streamState atomically with activeEmployeeId
	return {
		...currentState,
		toolCalls: currentState.toolCalls.map(tc => ({ ...tc })),
	};
}
