/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Stream Handler
 *
 *  Receives chat.stream.delta events from the Host (already frame-throttled at 16ms),
 *  and provides a React-friendly interface for streaming text updates.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage, AssistantMessage, ToolMessage, ToolMessageStatus, ThinkingBlock, ToolResult } from '../types/chatTypes';

// ─── Stream Phase (Void-inspired: IsRunningType 5-state model) ──────────

/**
 * 精确表达 Agent 循环的每个阶段，替代 boolean isStreaming。
 *
 * 参考 Void 的 IsRunningType（LLM | tool | awaiting_user | idle | undefined），
 * 额外增加 compressing 状态替代独立的 isCompressing boolean。
 *
 * 状态流转:
 *   idle → llm_streaming → tool_executing → llm_streaming → ... → idle
 *   idle → llm_streaming → awaiting_approval → tool_executing → ... → idle
 *   idle → llm_streaming → compressing → llm_streaming → ... → idle
 *   * → error → idle
 */
export type StreamPhase =
	| 'idle'              // 完全空闲
	| 'llm_streaming'     // LLM 正在流式输出（含 text/thinking delta）
	| 'tool_executing'    // 工具正在执行（tool_start/tool_args/tool_end）
	| 'awaiting_approval' // 等待用户审批（安全工具需确认）
	| 'compressing'       // 正在压缩上下文
	| 'error';            // 错误状态

/** Helper: is the phase actively streaming (not idle)? */
export function isPhaseActive(phase: StreamPhase): boolean {
	return phase !== 'idle';
}

export interface StreamChunk {
	type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'error' | 'done' | 'content_replace' | 'usage' | 'sub_agent_start' | 'sub_agent_progress' | 'sub_agent_end' | 'phase_change' | 'context_compacted' | 'tool_approval_request' | 'tool_approval_resolved' | 'discard_prior_text';
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
	/** Whether the tool was server-executed (no client confirmation needed) */
	serverExecuted?: boolean;
	/**
	 * Security level for an approval request. Carried on
	 * `type: 'tool_approval_request'` chunks so the streaming tool card can
	 * render the correct approval UI variant.
	 */
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	/** Current text-buffer length when this tool started — used to interleave tool cards inside markdown */
	textPosition?: number;
	/**
	 * Explicit phase transition. When present, accumulateChunk will set
	 * StreamState.phase to this value (overriding the type-based inference).
	 * This allows the Host to precisely control phase transitions (e.g.
	 * sending phase_change to 'awaiting_approval' before a tool requires
	 * user confirmation).
	 */
	phase?: StreamPhase;
	/**
	 * Host-side full text snapshot (Void-inspired fullTextSoFar).
	 * When present, accumulateChunk will set textBuffer to this value
	 * instead of incrementally appending `content`.
	 */
	fullText?: string;
	/**
	 * Host-side full thinking snapshot.
	 * When present, accumulateChunk will set thinkingBuffer to this value
	 * instead of incrementally appending `content`.
	 */
	fullThinking?: string;
	/** Sub-agent fields (carried on `sub_agent_*` chunks) */
	subAgentId?: string;
	subAgentType?: 'explore' | 'general' | 'scout';
	subAgentTask?: string;
	subAgentParentId?: string;
	subAgentStatus?: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	subAgentProgress?: string;
	subAgentOutput?: string;
	subAgentError?: string;
	subAgentGroupId?: string;
	/**
	 * KV Cache / token usage metrics. Carried on `type: 'usage'` chunks emitted by
	 * the BYOK provider after the upstream API response includes prompt cache info
	 * (Anthropic Prompt Caching, OpenAI cached_tokens). Accumulated into
	 * StreamState.usage so the chat footer can render a cache-hit badge.
	 */
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cachedTokens?: number;
		cacheWriteTokens?: number;
	};
	/**
	 * 上下文压缩后回传的"压缩后估算输入 token"（type === 'context_compacted' 时携带）。
	 * accumulateChunk 据此把 StreamState.compactedBaseline 下调，让圆环进度条立即回落。
	 */
	compactedInputTokens?: number;
	/** 上下文压缩详情（type === 'context_compacted' 时携带） */
	compressionOriginalCount?: number;
	compressionCompressedCount?: number;
	compressionTokensSaved?: number;
	compressionDurationMs?: number;
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

export interface StreamState {
	/**
	 * Stream phase — replaces boolean isStreaming with a precise state machine.
	 * UI components should check `phase` instead of `isStreaming`:
	 *   - phase !== 'idle' → show streaming UI
	 *   - phase === 'llm_streaming' → "AI 正在思考..." / "AI 正在输出..."
	 *   - phase === 'tool_executing' → "正在执行工具..."
	 *   - phase === 'awaiting_approval' → "等待您确认..."
	 *   - phase === 'compressing' → "正在压缩上下文..."
	 *   - phase === 'error' → show error state
	 *
	 * Backward compat: `isStreaming` is available as a getter via `isPhaseActive(phase)`.
	 */
	phase: StreamPhase;
	/** @deprecated Use `isPhaseActive(phase)` or `phase !== 'idle'` instead */
	isStreaming: boolean;
	agentId: string | null;
	sessionId: string | null;
	textBuffer: string;
	thinkingBuffer: string;
	toolCalls: ToolCallState[];
	/** Unified ChatMessage format (Void-inspired, for adapter compatibility) */
	chatMessages: ChatMessage[];
	/** Sub-agent invocations accumulated during the stream (parallel execution display) */
	subAgents: SubAgentState[];
	/** @deprecated Use `error` instead for structured error info */
	errorMessage: string | null;
	/** Structured error details (VS Code Copilot Chat pattern) */
	error: StreamError | null;
	/**
	 * KV Cache / token usage accumulator. Each `type: 'usage'` chunk adds to these
	 * counters; `seen` tracks whether at least one usage chunk arrived so the UI
	 * can distinguish "no data" from "zero tokens".
	 */
	usage: {
		seen: boolean;
		input: number;
		output: number;
		cached: number;
		cacheWrite: number;
	};
	/**
	 * 压缩后估算输入 token 基线（type === 'context_compacted' 时由 Host 回传）。
	 * 用于让 ChatComposer 圆环进度条在上下文压缩后立即同步回落：前端 messages 历史
	 * 不会因后端压缩而缩减，故 inputBaselineTokens 仍是旧大值；当 compactedBaseline > 0
	 * 时圆环优先采用它作为基线。下一轮真实 usage 到来后自然被覆盖（仍取较大值兜底）。
	 * 0 表示本轮尚未发生压缩。
	 */
	compactedBaseline: number;
}

export interface ToolCallState {
	id: string;
	name: string;
	arguments: string;
	result?: string;
	status: 'running' | 'done' | 'error' | 'approval_required';
	/**
	 * Security level for the approval UI. Carried on the tool call when the Host
	 * requests approval (chat.toolApprovalRequest). Only meaningful while
	 * status === 'approval_required'.
	 */
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	/** Whether to show this tool call card in the chat UI. Default true. */
	defaultShow?: boolean;
	/** UI 显示名称（来自模型的 display_name 字段） */
	displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeEditor 等） */
	renderType?: string;
	/** Whether this tool was server-executed (no client confirmation needed) */
	serverExecuted?: boolean;
	/** Text-buffer length captured when this tool started — used by InterleavedMarkdownRenderer to position the card */
	textPosition?: number;
}

/** Sub-agent invocation state inside a stream (parallel execution display). */
export interface SubAgentState {
	id: string;
	type: 'explore' | 'general' | 'scout';
	task: string;
	parentAgentId?: string;
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	progress?: string;
	output?: string;
	error?: string;
	groupId?: string;
}

type StreamListener = (state: StreamState) => void;
type StreamCompleteCallback = (state: StreamState, hostMessage?: any) => void;

const listeners = new Set<StreamListener>();
const completeCallbacks = new Set<StreamCompleteCallback>();
let currentState: StreamState = createInitialState();
let pendingRafId: number | null = null;

/**
 * The agentId that the UI is currently displaying.
 * Set by switchActiveStream() — used by handleStreamDelta() Case 4 to decide
 * whether a brand-new stream should become the foreground `currentState` or be
 * placed into background.  Without this guard, a late-arriving first delta for
 * a previously-active agent would hijack `currentState`, causing its notify
 * snapshots to be discarded by subscribeStream (agent mismatch) while also
 * preventing the real background accumulation path from being used.
 */
let activeAgentId: string | null = null;

/** Per-agent stream states for agents that are not currently displayed.
 *  When the user switches away from a streaming agent, the stream state
 *  is saved here so it can be restored when they switch back. */
const backgroundStreams = new Map<string, StreamState>();

function createInitialState(): StreamState {
	return {
		phase: 'idle',
		isStreaming: false, // deprecated mirror
		agentId: null,
		sessionId: null,
		textBuffer: '',
		thinkingBuffer: '',
		toolCalls: [],
		chatMessages: [],
		subAgents: [],
		errorMessage: null,
		error: null,
		usage: { seen: false, input: 0, output: 0, cached: 0, cacheWrite: 0 },
		compactedBaseline: 0,
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

/** Build a map key from agentId only.
 *  We intentionally ignore sessionId because the Host may send deltas
 *  with a sessionId that changes during the stream (e.g. from null to
 *  an actual value). Using agentId alone is safe because a given
 *  agent can only have one active stream at a time in the webview. */
function streamKey(agentId: string | null): string {
	return agentId ?? '';
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
		subAgents: (currentState.subAgents || []).map(sa => ({ ...sa })),
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
		subAgents: (currentState.subAgents || []).map(sa => ({ ...sa })),
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

/**
 * Sanitize chunk content before accumulation.
 *
 * Filters out the literal string "undefined" — a known pollution source
 * caused by upstream provider chains that template-stringify undefined
 * values via `${undefined}` somewhere in the IModelDelta → IChatStreamDelta
 * pipeline (e.g. vendor copilot LM bridge yielding type='text' with
 * value=undefined occurrence on reasoning models).
 *
 * Strategy:
 *  1. If the entire chunk content is `"undefined"` (one or more consecutive
 *     copies, possibly with whitespace), drop it entirely.
 *  2. Otherwise, strip any sequence of `(undefined)+` literal substrings —
 *     they cannot legitimately appear in user-visible text from any of our
 *     model providers, so removing them is safe.
 *  3. Pass through untouched if no pollution found (zero-cost on hot path).
 */
function sanitizeChunkContent(content: unknown): string {
	if (typeof content !== 'string' || content.length === 0) {
		return '';
	}
	// Fast-path: no 'u' character → no "undefined" possible.
	if (!content.includes('undefined')) {
		return content;
	}
	// Strip runs of `undefined` (case-sensitive — JS template stringification
	// always produces lowercase). Use a regex that matches one or more
	// adjacent `undefined` occurrences (with no separators) so consecutive
	// pollution like "undefinedundefinedundefined" gets removed in a single pass.
	const cleaned = content.replace(/(?:undefined)+/g, '');
	return cleaned;
}

/** Accumulate a single chunk into a StreamState (mutates state in-place). */
function accumulateChunk(state: StreamState, chunk: StreamChunk): void {
	// ── Phase transition: explicit phase on chunk takes precedence ──
	if (chunk.phase) {
		state.phase = chunk.phase;
		state.isStreaming = isPhaseActive(chunk.phase);
	}

	switch (chunk.type) {
		case 'text':
			// Priority: fullText snapshot > incremental content
			if (chunk.fullText !== undefined) {
				state.textBuffer = chunk.fullText;
			} else {
				state.textBuffer += sanitizeChunkContent(chunk.content);
			}
			// Auto-derive phase: text delta means LLM is streaming
			if (state.phase === 'idle' || state.phase === 'compressing') {
				state.phase = 'llm_streaming';
				state.isStreaming = true;
			}
			break;
		case 'thinking':
			// Priority: fullThinking snapshot > incremental content
			if (chunk.fullThinking !== undefined) {
				state.thinkingBuffer = chunk.fullThinking;
			} else {
				state.thinkingBuffer += sanitizeChunkContent(chunk.content);
			}
			// Auto-derive phase: thinking delta means LLM is streaming
			if (state.phase === 'idle' || state.phase === 'compressing') {
				state.phase = 'llm_streaming';
				state.isStreaming = true;
			}
			break;
		case 'content_replace':
			// Replace the entire text buffer with the new content.
			// Used when tool calls are extracted from text and the original
			// JSON content should no longer be displayed.
			state.textBuffer = sanitizeChunkContent(chunk.content);
			// Still in LLM streaming phase after content replacement
			if (state.phase !== 'llm_streaming') {
				state.phase = 'llm_streaming';
				state.isStreaming = true;
			}
			break;
		case 'discard_prior_text':
			// ── Hermes-style synthetic-recovery 续跑信号 ──────────────────
			// Host 检测到 fake-completion / unfinished-intent / 空回，准备注入
			// nudge 续跑前发出此信号，要求 webview **彻底丢弃刚才那段幻觉/过渡文本**。
			// 与 content_replace（带替换文本）不同，本信号意图是"清空但等待新输出"。
			// content_replace 已先一步把 textBuffer 替换为简短重试提示（见
			// agentOSService.ts），因此此处不再重置 textBuffer，仅做语义留痕：
			// 把 thinkingBuffer 也清掉（避免幻觉 reasoning 残留），保持流式 phase。
			state.thinkingBuffer = '';
			if (state.phase === 'idle') {
				state.phase = 'llm_streaming';
				state.isStreaming = true;
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
				textPosition: typeof chunk.textPosition === 'number' ? chunk.textPosition : state.textBuffer.length,
			});
			// Auto-derive phase: tool starting means tool_executing
			if (state.phase !== 'tool_executing' && state.phase !== 'awaiting_approval') {
				state.phase = 'tool_executing';
				state.isStreaming = true;
			}
			break;
		case 'tool_args': {
			const call = state.toolCalls.find(tc => tc.id === chunk.toolCallId);
			if (call) {
				call.arguments += sanitizeChunkContent(chunk.content);
			}
			// Auto-derive phase: tool args means tool_executing
			if (state.phase !== 'tool_executing' && state.phase !== 'awaiting_approval') {
				state.phase = 'tool_executing';
				state.isStreaming = true;
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
				// CRITICAL FIX (用户反馈："工具一直在转圈，明明已经完成任务了还在执行"):
				// Receiving a tool_result inherently means the tool has finished —
				// even if the host fails to emit tool_end (orphaned via dedup, phantom
				// filter, exception, abort, etc.), the result message proves
				// completion. Promote the status here so the UI card stops spinning
				// the moment we have evidence of completion.
				if (resultCall.status === 'running' || resultCall.status === 'approval_required') {
					resultCall.status = 'done';
				}
			}
			break;
		}
		case 'tool_approval_request': {
			// Host requests user approval for a tool that is currently streaming.
			// The tool call already lives in state.toolCalls (pushed by tool_start),
			// so we flip its status to 'approval_required' and transition the phase
			// so the UI renders the approval buttons inline on the streaming card.
			//
			// CRITICAL FIX (用户反馈："聊天框中输出流式信息最终卡住，没有结束"):
			// Previously the approval request was only applied to the COMMITTED
			// `messages` array (in index.tsx), but during streaming the tool calls
			// live in streamState.toolCalls — so "toolCallId not found in messages"
			// → card never showed approval UI → user could never approve →
			// agentOSService.checkAndApprove() awaited forever → stream stuck.
			const approvalCall = state.toolCalls.find(tc => tc.id === chunk.toolCallId);
			if (approvalCall) {
				approvalCall.status = 'approval_required';
				if (chunk.securityLevel) {
					approvalCall.securityLevel = chunk.securityLevel;
				}
				// Any pending approval blocks the loop → reflect it in the phase so
				// the bubble shows "等待您确认...".
				state.phase = 'awaiting_approval';
				state.isStreaming = true;
			}
			break;
		}
		case 'tool_approval_resolved': {
			// The user has responded to a pending approval (allow/deny). If the tool
			// was approved it will proceed to execution (tool_result/tool_end will
			// arrive); if denied, the host emits a failed tool_result/tool_end. Here
			// we just clear the 'approval_required' visual state back to 'running' so
			// the card stops showing the buttons while execution proceeds. If denied,
			// the subsequent tool_end(success=false) will set it to 'error'.
			const resolvedCall = state.toolCalls.find(tc => tc.id === chunk.toolCallId);
			if (resolvedCall && resolvedCall.status === 'approval_required') {
				resolvedCall.status = 'running';
			}
			// Re-derive phase: if no other call is still awaiting approval, go back to
			// tool_executing so the bubble label updates.
			const stillAwaiting = state.toolCalls.some(tc => tc.status === 'approval_required');
			if (!stillAwaiting && state.phase === 'awaiting_approval') {
				state.phase = 'tool_executing';
				state.isStreaming = true;
			}
			break;
		}
		case 'error':
			state.errorMessage = chunk.content || 'Unknown error';
			state.error = parseStreamError(chunk.content || 'Unknown error');
			state.phase = 'error';
			state.isStreaming = true; // error is still an active state
			break;
		case 'usage': {
			const u = chunk.usage;
			if (u) {
				state.usage.seen = true;
				if (typeof u.inputTokens === 'number') { state.usage.input += u.inputTokens; }
				if (typeof u.outputTokens === 'number') { state.usage.output += u.outputTokens; }
				if (typeof u.cachedTokens === 'number') { state.usage.cached += u.cachedTokens; }
				if (typeof u.cacheWriteTokens === 'number') { state.usage.cacheWrite += u.cacheWriteTokens; }
			}
			break;
		}
		case 'phase_change':
			// Explicit phase transition from Host — no data, just state change
			if (chunk.phase) {
				state.phase = chunk.phase;
				state.isStreaming = isPhaseActive(chunk.phase);
			}
			break;
		case 'context_compacted':
			// 上下文压缩完成：Host 回传压缩后估算输入 token，作为圆环进度条新基线，
			// 让圆圈在压缩后立即同步回落（前端 messages 历史不缩减，需此信号修正）。
			if (typeof chunk.compactedInputTokens === 'number' && chunk.compactedInputTokens >= 0) {
				state.compactedBaseline = chunk.compactedInputTokens;
			}
			break;
		case 'done':
			// Stream finished — no action needed, completion is handled by handleStreamComplete
			break;
		case 'sub_agent_start': {
			if (!state.subAgents) { state.subAgents = []; }
			const id = chunk.subAgentId ?? chunk.toolCallId ?? '';
			if (!id) { break; }
			if (!state.subAgents.some(sa => sa.id === id)) {
				state.subAgents.push({
					id,
					type: chunk.subAgentType ?? 'general',
					task: chunk.subAgentTask ?? '',
					parentAgentId: chunk.subAgentParentId,
					status: chunk.subAgentStatus ?? 'running',
					groupId: chunk.subAgentGroupId,
				});
			}
			break;
		}
		case 'sub_agent_progress': {
			if (!state.subAgents) { state.subAgents = []; break; }
			const id = chunk.subAgentId ?? chunk.toolCallId ?? '';
			const sa = state.subAgents.find(s => s.id === id);
			if (sa) {
				if (chunk.subAgentProgress !== undefined) { sa.progress = chunk.subAgentProgress; }
				if (chunk.subAgentStatus) { sa.status = chunk.subAgentStatus; }
			}
			break;
		}
		case 'sub_agent_end': {
			if (!state.subAgents) { state.subAgents = []; break; }
			const id = chunk.subAgentId ?? chunk.toolCallId ?? '';
			const sa = state.subAgents.find(s => s.id === id);
			if (sa) {
				sa.status = chunk.subAgentStatus ?? (chunk.success === false ? 'error' : 'done');
				if (chunk.subAgentOutput !== undefined) { sa.output = chunk.subAgentOutput; }
				if (chunk.subAgentError !== undefined) { sa.error = chunk.subAgentError; }
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
 * different agent/session than the currently displayed one, the chunks
 * are accumulated into a background stream stored in `backgroundStreams`.
 * When the user switches back to that agent, the background stream is
 * restored so no content is lost.
 */
export function handleStreamDelta(data: {
	agentId: string;
	sessionId: string;
	chunks: StreamChunk[];
}): void {
	const deltaKey = streamKey(data.agentId);
	const currentKey = streamKey(currentState.agentId);

	// ── Case 1: Delta matches the currently displayed stream (same agent) ──
	// We match by agentId only, because the Host may change sessionId mid-stream.
	if (isPhaseActive(currentState.phase) && data.agentId === currentState.agentId) {
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

	// ── Case 2: Delta is for a different agent (background stream) ──
	if (isPhaseActive(currentState.phase) && data.agentId !== currentState.agentId) {
		let bg = backgroundStreams.get(deltaKey);
		if (!bg) {
			bg = {
				...createInitialState(),
				phase: 'llm_streaming',
				isStreaming: true,
				agentId: data.agentId,
				sessionId: data.sessionId,
			};
			backgroundStreams.set(deltaKey, bg);
			console.log(`[StreamHandler] Background stream started for agent=${data.agentId}, sessionId=${data.sessionId}`);
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
	// If the delta belongs to the currently active agent (or no agent is
	// active yet), start it as the foreground stream.  Otherwise, this is a
	// late-arriving delta for a non-displayed agent — place it into
	// background so it doesn't hijack `currentState` and produce notify()
	// snapshots that subscribeStream will just discard (agent mismatch).
	if (activeAgentId && data.agentId !== activeAgentId) {
		// Start as background stream
		const bg: StreamState = {
			...createInitialState(),
			phase: 'llm_streaming',
			isStreaming: true,
			agentId: data.agentId,
			sessionId: data.sessionId,
		};
		for (const chunk of data.chunks) {
			accumulateChunk(bg, chunk);
		}
		backgroundStreams.set(deltaKey, bg);
		console.log(`[StreamHandler] Late delta → started background stream for agent=${data.agentId} (active=${activeAgentId})`);
		return;
	}

	// Start as foreground stream
	deltaEventCount = 0;
	currentState = {
		...createInitialState(),
		phase: 'llm_streaming',
		isStreaming: true,
		agentId: data.agentId,
		sessionId: data.sessionId,
	};
	console.log(`[StreamHandler] Stream started for agent=${data.agentId}`);

	for (const chunk of data.chunks) {
		accumulateChunk(currentState, chunk);
	}
	// IMPORTANT: For the FIRST delta, notify synchronously so React sees
	// isStreaming=true before a potential handleStreamComplete in the same
	// event loop tick (which would cancel the RAF).
	notify();
}

/**
 * Apply a tool approval request to the streaming tool call.
 *
 * CRITICAL FIX (用户反馈："聊天框中输出流式信息最终卡住，没有结束"):
 * During streaming, tool calls live in StreamState.toolCalls (rendered by the
 * StreamingBubble), NOT in the committed `messages` array. The Host's
 * `chat.toolApprovalRequest` event must therefore update the stream state so
 * the approval card renders inline and the user can approve — otherwise
 * agentOSService.checkAndApprove() awaits forever and the stream is stuck at
 * "执行中...".
 *
 * We search the foreground stream first, then any background streams. Returns
 * true if a matching tool call was found and updated (so the caller can decide
 * whether to also fall back to updating committed messages).
 */
export function applyToolApprovalRequest(payload: {
	toolCallId: string;
	toolName?: string;
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
}): boolean {
	const chunk: StreamChunk = {
		type: 'tool_approval_request',
		toolCallId: payload.toolCallId,
		toolName: payload.toolName,
		securityLevel: payload.securityLevel,
	};

	// Foreground stream
	if (currentState.toolCalls.some(tc => tc.id === payload.toolCallId)) {
		accumulateChunk(currentState, chunk);
		scheduleNotify();
		return true;
	}

	// Background streams
	for (const bg of backgroundStreams.values()) {
		if (bg.toolCalls.some(tc => tc.id === payload.toolCallId)) {
			accumulateChunk(bg, chunk);
			return true;
		}
	}

	return false;
}

/**
 * Mark a pending approval as resolved (user clicked allow/deny). Clears the
 * 'approval_required' visual state back to 'running' so the card stops showing
 * the buttons while execution proceeds (a subsequent tool_end will finalize the
 * status). Returns true if a matching tool call was found.
 */
export function applyToolApprovalResolved(toolCallId: string): boolean {
	const chunk: StreamChunk = { type: 'tool_approval_resolved', toolCallId };

	if (currentState.toolCalls.some(tc => tc.id === toolCallId)) {
		accumulateChunk(currentState, chunk);
		scheduleNotify();
		return true;
	}

	for (const bg of backgroundStreams.values()) {
		if (bg.toolCalls.some(tc => tc.id === toolCallId)) {
			accumulateChunk(bg, chunk);
			return true;
		}
	}

	return false;
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
	agentId: string;
	sessionId: string;
	message: unknown;
}): void {
	const key = streamKey(data.agentId);
	const currentKey = streamKey(currentState.agentId);

	// ── Check if this completion is for a background stream ──
	const bg = backgroundStreams.get(key);
	if (bg && key !== currentKey) {
		console.log(`[StreamHandler] Background stream completed for agent=${data.agentId}, sessionId=${data.sessionId}`);
		backgroundStreams.delete(key);
		// The host has persisted the message. When the user switches back
		// to this agent, loadHistoryForSession will fetch it.
		// No callbacks fired — the stream was not being displayed.
		return;
	}

	// ── Completion for the currently displayed stream ──
	const wasStreaming = isPhaseActive(currentState.phase);
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
	// Defensive: any tool calls still marked 'running' at stream-complete time
	// must be finalized (the stream is over — they cannot be running anymore).
	// This guards against missing/late tool_end chunks from the host.
	const finalState: StreamState = {
		...currentState,
		phase: 'idle',
		isStreaming: false,
		toolCalls: currentState.toolCalls.map(tc => ({
			...tc,
			status: tc.status === 'running' ? 'done' : tc.status,
		})),
		subAgents: (currentState.subAgents || []).map(sa => ({
			...sa,
			status: sa.status === 'running' || sa.status === 'pending' ? 'done' : sa.status,
		})),
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
	if (isPhaseActive(currentState.phase)) {
		currentState = { ...currentState, phase: 'idle', isStreaming: false };
		notify();
	}
}

/**
 * Handle stream error.
 */
export function handleStreamError(data: {
	agentId: string;
	sessionId: string;
	error: string;
}): void {
	const key = streamKey(data.agentId);
	const currentKey = streamKey(currentState.agentId);

	// ── Check if this error is for a background stream ──
	const bg = backgroundStreams.get(key);
	if (bg && key !== currentKey) {
		console.log(`[StreamHandler] Background stream error for agent=${data.agentId}: "${data.error}"`);
		backgroundStreams.delete(key);
		return;
	}

	// ── Error for the currently displayed stream ──
	console.error(`[StreamHandler] handleStreamError: agent=${data.agentId}, ` +
		`wasStreaming=${isPhaseActive(currentState.phase)}, deltaCount=${deltaEventCount}, error="${data.error}"`);

	// Cancel any pending RAF from the last delta
	if (pendingRafId !== null) {
		cancelAnimationFrame(pendingRafId);
		pendingRafId = null;
	}

	// Snapshot the error state before callbacks may resetStream
	const finalState: StreamState = {
		...currentState,
		phase: 'error',
		isStreaming: true, // error is still an active state
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
	if (isPhaseActive(currentState.phase)) {
		currentState = { ...currentState, phase: 'idle', isStreaming: false, errorMessage: data.error || 'Unknown stream error', error: parseStreamError(data.error || 'Unknown stream error') };
		notify();
	}
}

/**
 * Reset stream state (e.g., when switching agents).
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
 * agent/session. Saves the current stream (if active) to the background
 * map and restores any previously saved stream for the new context.
 *
 * Does NOT notify listeners — the caller should set the returned StreamState
 * in the store alongside updating activeAgentId in a single atomic set()
 * call, so React never sees an intermediate state where the agent has
 * changed but the stream hasn't.
 *
 * Returns the StreamState that should be displayed for the new context.
 */
export function switchActiveStream(agentId: string | null, sessionId: string | null): StreamState {
	// Cancel any pending RAF
	if (pendingRafId !== null) {
		cancelAnimationFrame(pendingRafId);
		pendingRafId = null;
	}

	// Update the active agent marker FIRST — this ensures that any delta
	// arriving after this point for the OLD agent will be routed to
	// background (Case 2/3/4-bg) instead of hijacking currentState.
	activeAgentId = agentId;

	// Save current stream to background if it's active
	if (isPhaseActive(currentState.phase) && currentState.agentId) {
		const currentKey = streamKey(currentState.agentId);
		backgroundStreams.set(currentKey, {
			...currentState,
			toolCalls: currentState.toolCalls.map(tc => ({ ...tc })),
			subAgents: (currentState.subAgents || []).map(sa => ({ ...sa })),
		});
		console.log(`[StreamHandler] Saved current stream to background: agent=${currentState.agentId}, sessionId=${currentState.sessionId}`);
	}

	// Check if there's a background stream for the new context
	const newKey = streamKey(agentId);
	const saved = backgroundStreams.get(newKey);
	if (saved) {
		backgroundStreams.delete(newKey);
		currentState = saved;
		console.log(`[StreamHandler] Restored background stream for agent=${agentId}, sessionId=${sessionId} ` +
			`(textLen=${saved.textBuffer.length}, thinkingLen=${saved.thinkingBuffer.length})`);
	} else {
		currentState = createInitialState();
	}

	// Do NOT notify here — the caller will set streamState atomically with activeAgentId
	return {
		...currentState,
		toolCalls: currentState.toolCalls.map(tc => ({ ...tc })),
		subAgents: (currentState.subAgents || []).map(sa => ({ ...sa })),
	};
}

/*---------------------------------------------------------------------------------------------
 *  Build ChatMessage[] from a complete StreamState (after streaming is done).
 *  This is the adapter that converts StreamState → unified ChatMessage format.
 *--------------------------------------------------------------------------------------------*/

// Map StreamState tool status to ToolMessageStatus.
function mapToolStatus(status: string): ToolMessageStatus {
	switch (status) {
		case 'running': return 'running';
		case 'done': return 'success';
		case 'error': return 'error';
		case 'pending': return 'pending';
		case 'rejected': return 'rejected';
		case 'approval_required': return 'approval_required';
		case 'cancelled': return 'rejected';
		default: return 'pending';
	}
}

/**
 * Convert a single streaming ToolCallState into the unified ToolMessage format
 * that ToolCallCard expects.
 *
 * CRITICAL FIX (Problem 1 — 工具卡片显示异常 terminal/listfile/readfile):
 * The StreamingBubble previously passed the raw ToolCallState directly to
 * ToolCallCard. But ToolCallCard's internal adapter (toolMessageToToolCallData)
 * reads `params` (an object) and a ToolMessageStatus — whereas ToolCallState
 * carries `arguments` (a JSON string) and status values like 'done'. The
 * mismatch caused arguments to be lost (params undefined) and the status to be
 * misread ('done' is not a ToolMessageStatus → fell back to 'pending'), so the
 * card rendered with no command/path and the wrong (perpetual pending) state.
 *
 * Routing streaming tool calls through the SAME converter used for committed
 * messages guarantees identical, correct rendering during and after streaming.
 */
export function toolCallStateToToolMessage(tc: ToolCallState): ToolMessage {
	const toolStatus = mapToolStatus(tc.status);

	// Build ToolResult if available
	let toolResult: ToolResult | null = null;
	if (tc.result && toolStatus === 'success') {
		toolResult = {
			content: [{ type: 'text', text: tc.result }],
			metadata: undefined,
		};
	}

	// Build params from tool call (parse arguments JSON)
	let params: Record<string, unknown> = {};
	let rawParams: Record<string, string | undefined> = {};
	try {
		params = JSON.parse(tc.arguments || '{}');
		rawParams = { [tc.name]: tc.arguments };
	} catch {
		// If can't parse (still streaming partial JSON), keep raw string so the
		// card can at least show the in-progress arguments.
		rawParams = { [tc.name]: tc.arguments };
	}

	const baseToolMsg = {
		role: 'tool' as const,
		id: tc.id,
		name: tc.name,
		params: params as Readonly<Record<string, unknown>>,
		rawParams: rawParams as Readonly<Record<string, string | undefined>>,
		timestamp: Date.now(),
		displayName: tc.displayName,
		renderType: tc.renderType,
		serverExecuted: tc.serverExecuted,
		securityLevel: tc.securityLevel,
		defaultShow: tc.defaultShow,
	};

	if (toolStatus === 'success') {
		return {
			...baseToolMsg,
			status: 'success' as const,
			result: toolResult || { content: [], metadata: undefined },
		} as ToolMessage;
	} else if (toolStatus === 'error') {
		return {
			...baseToolMsg,
			status: 'error' as const,
			result: tc.result || 'Unknown error',
		} as ToolMessage;
	} else if (toolStatus === 'running') {
		return {
			...baseToolMsg,
			status: 'running' as const,
			result: null,
		} as ToolMessage;
	} else if (toolStatus === 'rejected') {
		return {
			...baseToolMsg,
			status: 'rejected' as const,
			result: null,
		} as ToolMessage;
	} else if (toolStatus === 'approval_required') {
		return {
			...baseToolMsg,
			status: 'approval_required' as const,
			result: null,
		} as ToolMessage;
	}
	// pending or invalid_params
	return {
		...baseToolMsg,
		status: 'pending' as const,
		result: null,
	} as ToolMessage;
}

export function buildChatMessagesFromState(state: StreamState): ChatMessage[] {
	const messages: ChatMessage[] = [];

	// Build assistant message from textBuffer + thinkingBuffer  
	if (state.textBuffer || state.thinkingBuffer) {
		const thinkingBlocks: ThinkingBlock[] = state.thinkingBuffer
			? [{ type: 'thinking', thinking: state.thinkingBuffer, signature: undefined }]
			: [];
		const assistantMsg: AssistantMessage = {
			role: 'assistant',
			content: state.textBuffer || '',
			reasoning: '',
			thinking: thinkingBlocks,
			timestamp: Date.now(),
		};
		messages.push(assistantMsg);
	}

	// Build tool messages from toolCalls[] — reuse the single-tool converter so
	// streaming and committed rendering stay identical.
	for (const tc of state.toolCalls) {
		messages.push(toolCallStateToToolMessage(tc));
	}

	return messages;
}
