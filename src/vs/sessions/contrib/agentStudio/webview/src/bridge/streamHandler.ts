/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Stream Handler
 *
 *  Receives chat.stream.delta events from the Host (already frame-throttled at 16ms),
 *  and provides a React-friendly interface for streaming text updates.
 *--------------------------------------------------------------------------------------------*/

export interface StreamChunk {
	type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'error' | 'done' | 'content_replace' | 'subagent_start' | 'subagent_progress' | 'subagent_end';
	content?: string;
	toolCallId?: string;
	toolName?: string;
	success?: boolean;
	/** UI 显示名称（来自模型的 display_name 字段） */
	displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeEditor 等） */
	renderType?: string;
	/** 是否默认展开显示工具卡（默认 true） */
	defaultShow?: boolean;
	/** 工具已在服务端执行（如 Knot AG-UI），客户端不需要再执行 */
	serverExecuted?: boolean;
	/** Security level for approval UI */
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	/** Exit code from terminal commands */
	exitCode?: number;
	/** Lint/diagnostic errors after edit_file */
	diagnostics?: Array<{ message: string; line?: number; severity: 'error' | 'warning' }>;
	/** Sub-agent invocation ID for grouping */
	subAgentId?: string;
	/** Sub-agent metadata — sent with subagent_start */
	subAgentMeta?: {
		type: 'explore' | 'general' | 'scout';
		task: string;
		parentAgentId?: string;
	};
}

/**
 * Structured error details (inspired by VS Code Copilot Chat's IChatResponseErrorDetails).
 * Allows the UI to render different error presentations based on level and type.
 */
export interface StreamError {
	message: string;
	/** Error severity — affects UI color/icon */
	level: 'info' | 'warning' | 'error';
	/** Whether this error is retryable (shows a retry button) */
	retryable?: boolean;
	/** Whether this is a rate-limiting error */
	isRateLimited?: boolean;
	/** Whether this is a quota/billing error */
	isQuotaExceeded?: boolean;
	/** Raw error code from the provider (for diagnostics) */
	code?: string;
}

/**
 * Structured content item — replaces textBuffer/thinkingBuffer with a typed array.
 * Inspired by VS Code Copilot Chat's content parts pattern.
 */
export type ContentItem =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool_call'; toolCallId: string };

export interface StreamState {
	isStreaming: boolean;
	employeeId: string | null;
	sessionId: string | null;
	/** @deprecated Use contentItems instead — kept temporarily for backward compat */
	textBuffer: string;
	/** @deprecated Use contentItems instead — kept temporarily for backward compat */
	thinkingBuffer: string;
	/** Structured content items (text / thinking / tool_call in order). */
	contentItems: ContentItem[];
	toolCalls: ToolCallState[];
	/** Active sub-agents being tracked during this stream */
	subAgents: SubAgentState[];
	/** @deprecated Use `error` instead for structured error info */
	errorMessage: string | null;
	/** Structured error details (VS Code Copilot Chat pattern) */
	error: StreamError | null;
}

export interface ToolCallState {
	id: string;
	name: string;
	arguments: string;
	result?: string;
	status: 'running' | 'done' | 'error' | 'approval_required' | 'rejected';
	/** Whether to show this tool call card in the chat UI. Default true. */
	defaultShow?: boolean;
	/** UI 显示名称（来自模型的 display_name 字段） */
	displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeEditor 等） */
	renderType?: string;
	/** 工具已在服务端执行（如 Knot AG-UI），客户端不需要再执行 */
	serverExecuted?: boolean;
	/** Security level for approval UI */
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	/** Exit code from terminal commands */
	exitCode?: number;
	/** Lint/diagnostic errors after edit_file */
	diagnostics?: Array<{ message: string; line?: number; severity: 'error' | 'warning' }>;
	/**
	 * Character offset in the textBuffer at the moment tool_start was received.
	 * Used to position the tool card at the correct location in the interleaved
	 * rendering (Void-inspired: tool card appears where tool_start happened).
	 */
	textPosition?: number;
}

/** Sub-agent state tracked during streaming */
export interface SubAgentState {
	/** Unique sub-agent invocation ID */
	id: string;
	/** Sub-agent type (explore/general/scout) */
	type: 'explore' | 'general' | 'scout';
	/** Task description */
	task: string;
	/** Parent agent ID */
	parentAgentId?: string;
	/** Current status */
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	/** Progress text (from subagent_progress chunks) */
	progress?: string;
	/** Final output (from subagent_end chunks) */
	output?: string;
	/** Error message (if status is error) */
	error?: string;
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
		contentItems: [],
		toolCalls: [],
		subAgents: [],
		errorMessage: null,
		error: null,
	};
}

/**
 * Parse an error string into a structured StreamError.
 * Detects rate-limiting, quota, and network errors to set appropriate flags.
 * (VS Code Copilot Chat pattern: IChatResponseErrorDetails)
 */
function parseStreamError(errorStr: string): StreamError {
	const lower = errorStr.toLowerCase();
	const isRateLimited = lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests');
	const isQuotaExceeded = lower.includes('quota') || lower.includes('billing') || lower.includes('insufficient') || lower.includes('exceeded');
	const isNetwork = lower.includes('network') || lower.includes('timeout') || lower.includes('econnrefused') || lower.includes('fetch failed');
	const isAuthError = lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden');

	// Determine level
	let level: StreamError['level'] = 'error';
	if (isRateLimited) { level = 'warning'; }

	// Retryable: network errors, rate limits, and server errors are retryable
	const retryable = isNetwork || isRateLimited || lower.includes('500') || lower.includes('502') || lower.includes('503');

	return {
		message: errorStr,
		level,
		retryable: retryable && !isAuthError,
		isRateLimited,
		isQuotaExceeded,
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
		contentItems: [...currentState.contentItems],
		toolCalls: currentState.toolCalls.map(tc => ({ ...tc })),
		subAgents: currentState.subAgents.map(sa => ({ ...sa })),
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
		contentItems: [...currentState.contentItems],
		toolCalls: currentState.toolCalls.map(tc => ({ ...tc })),
		subAgents: currentState.subAgents.map(sa => ({ ...sa })),
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
			// Also append to contentItems
			const lastTextItem = state.contentItems[state.contentItems.length - 1];
			if (lastTextItem?.type === 'text') {
				lastTextItem.text += chunk.content ?? '';
			} else {
				state.contentItems.push({ type: 'text', text: chunk.content ?? '' });
			}
			break;
		case 'thinking':
			state.thinkingBuffer += chunk.content ?? '';
			// Also append to contentItems
			const lastThinkItem = state.contentItems[state.contentItems.length - 1];
			if (lastThinkItem?.type === 'thinking') {
				lastThinkItem.text += chunk.content ?? '';
			} else {
				state.contentItems.push({ type: 'thinking', text: chunk.content ?? '' });
			}
			break;
		case 'content_replace':
			// Replace the entire text buffer with the new content.
			// Used when tool calls are extracted from text and the original
			// JSON content should no longer be displayed.
			//
			// The new content may contain <!--TOOL_CARD:id--> placeholders that
			// indicate where tool cards should appear. When placeholders exist,
			// we re-compute textPosition to match the placeholder offsets so
			// position-based interleaving works correctly. When placeholders are
			// absent (e.g. OpenAI function calling with no XML blocks), we leave
			// existing textPosition intact — clearing it would dump all cards at
			// the end because there is no other positioning signal.
			{
				const newContent = chunk.content ?? '';
				state.textBuffer = newContent;

				// Scan for placeholder positions and update textPosition accordingly.
				// If no placeholders are found but we have tool calls with recorded
				// textPosition values, keep those positions — they reflect the true
				// character offset where each tool started in the original streaming
				// text and enable correct position-based interleaving fallback.
				const placeholderRe = /<!--TOOL_CARD:([^>]+)-->/g;
				let match: RegExpExecArray | null;
				let foundAny = false;
				while ((match = placeholderRe.exec(newContent)) !== null) {
					foundAny = true;
					const tcId = match[1].trim();
					const tc = state.toolCalls.find(t => t.id === tcId);
					if (tc) {
						tc.textPosition = match.index;
					}
				}
				// If no placeholders were found, textPosition values from tool_start
				// are already correct and should be preserved as-is.
				if (!foundAny) {
					// Ensure textPosition is defined for all tool calls using their
					// existing values (or falling back to their array index order)
					state.toolCalls.forEach((tc, idx) => {
						if (tc.textPosition === undefined) {
							tc.textPosition = state.textBuffer.length + idx + 1; // place all tool cards after text content
						}
					});
				}
			}
			break;
		case 'tool_start':
			state.toolCalls.push({
				id: chunk.toolCallId ?? '',
				name: chunk.toolName ?? '',
				arguments: '',
				status: 'running',
				defaultShow: chunk.defaultShow,
				displayName: chunk.displayName,
				renderType: chunk.renderType,
				serverExecuted: chunk.serverExecuted,
				securityLevel: chunk.securityLevel,
				// Record position in text buffer at tool_start time — this determines
				// where the tool card appears in the interleaved rendering
				textPosition: state.textBuffer.length,
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
				if (chunk.exitCode !== undefined) {
					endCall.exitCode = chunk.exitCode;
				}
				if (chunk.diagnostics) {
					endCall.diagnostics = chunk.diagnostics;
				}
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
			state.error = parseStreamError(chunk.content || 'Unknown error');
			break;
		case 'done':
			// Stream finished — no action needed, completion is handled by handleStreamComplete
			break;
		case 'subagent_start':
			state.subAgents.push({
				id: chunk.subAgentId ?? '',
				type: chunk.subAgentMeta?.type ?? 'general',
				task: chunk.subAgentMeta?.task ?? chunk.content ?? '',
				parentAgentId: chunk.subAgentMeta?.parentAgentId,
				status: 'running',
			});
			break;
		case 'subagent_progress': {
			const progressAgent = state.subAgents.find(sa => sa.id === chunk.subAgentId);
			if (progressAgent) {
				progressAgent.progress = chunk.content ?? '';
			}
			break;
		}
		case 'subagent_end': {
			const endAgent = state.subAgents.find(sa => sa.id === chunk.subAgentId);
			if (endAgent) {
				endAgent.status = chunk.success === false ? 'error' : 'done';
				endAgent.output = chunk.content ?? '';
				endAgent.error = chunk.success === false ? chunk.content : undefined;
			}
			break;
		}
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
	// IMPORTANT: For the FIRST delta, notify synchronously so React sees
	// isStreaming=true before a potential handleStreamComplete in the same
	// event loop tick (which would cancel the RAF).
	notify();
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
		error: parseStreamError(data.error || 'Unknown stream error'),
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
		currentState = { ...currentState, isStreaming: false, errorMessage: data.error || 'Unknown stream error', error: parseStreamError(data.error || 'Unknown stream error') };
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
			subAgents: currentState.subAgents.map(sa => ({ ...sa })),
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
		subAgents: currentState.subAgents.map(sa => ({ ...sa })),
	};
}
