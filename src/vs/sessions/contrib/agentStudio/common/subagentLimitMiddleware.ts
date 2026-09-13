/*---------------------------------------------------------------------------------------------
 *  Subagent Limit Middleware — 并行限制中间件，后置截断策略
 *
 *  Inspired by deer-flow's subagent_limit_middleware.py.
 *
 *  Purpose:
 *  - Intercepts LLM responses containing tool_calls
 *  - Counts the number of 'delegate_task' / 'task' calls in a single model response
 *  - When the count exceeds maxConcurrent, truncates the excess task calls
 *  - This is more reliable than prompt-based limits — the LLM cannot be
 *    reliably constrained via prompt alone, so we enforce limits at the
 *    middleware layer
 *
 *  Design (aligned with deer-flow):
 *  1. After each LLM inference round, the middleware examines the AI message
 *     for tool_calls named 'delegate_task' / 'task' / 'spawn_subagent'
 *  2. If there are more task calls than maxConcurrent, only the first N are kept;
 *     the rest are dropped (truncated)
 *  3. The truncation is logged so the user/developer can see when limits are hit
 *  4. The middleware returns the modified tool_calls array for the caller to use
 *
 *  Key difference from deer-flow:
 *  - deer-flow modifies LangGraph AgentState.messages directly
 *  - Saros operates on the raw tool_calls array before dispatching,
 *    since it doesn't have LangGraph's state model
 *
 *  ★ 丢弃必须显式披露（2026-09-11）：调用方除打日志外，还须为每个 dropped call
 *    补一条失败 tool_result（见 {@link buildDroppedDelegationResult}）并在委派账本
 *    中先登记再标 cancelled —— 否则模型以为这些任务都在跑。
 *
 *  Valid range for maxConcurrent: [2, 5]（与 delegationTools 的 MAX_TASKS_PER_CALL 对齐）
 *--------------------------------------------------------------------------------------------*/

import type { IToolCallInfo } from './providers.js';

// ─── Constants (aligned with deer-flow) ──────────────────────────────────

/** Minimum allowed concurrent sub-agents. */
export const MIN_SUBAGENT_LIMIT = 2;
/** Maximum allowed concurrent sub-agents. 与 delegationTools 的 MAX_TASKS_PER_CALL=5 对齐（2026-07-26）。 */
export const MAX_SUBAGENT_LIMIT = 5;
/** Default maximum concurrent sub-agents. 与 MAX_TASKS_PER_CALL=5 对齐（原 3 会把合法的 1-5 批量委派截断）。 */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 5;

/** Tool names that this middleware considers as sub-agent delegation calls. */
export const SUBAGENT_DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
	'delegate_task',
	'task',
	'spawn_subagent',
	'dispatch_subagent',
]);

// ─── Middleware Class ─────────────────────────────────────────────────────

export interface SubagentLimitResult {
	/** The (potentially truncated) tool calls that should be executed. */
	toolCalls: IToolCallInfo[];
	/** Tool calls that were dropped due to exceeding the limit. */
	droppedCalls: IToolCallInfo[];
	/** Whether any calls were dropped. */
	wasTruncated: boolean;
	/** Original count of task calls before truncation. */
	originalTaskCount: number;
	/** Kept count of task calls after truncation. */
	keptTaskCount: number;
}

/**
 * Intercept and potentially truncate tool_calls before execution.
 *
 * Usage (in AgentOSService or tool execution loop):
 * ```
 * const limitMw = new SubagentLimitMiddleware(3);
 * const result = limitMw.apply(toolCalls);
 * // Execute result.toolCalls instead of the original array
 * // result.droppedCalls can be logged or surfaced to the user
 * ```
 */
export class SubagentLimitMiddleware {
	private readonly _maxConcurrent: number;

	constructor(maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SUBAGENTS) {
		this._maxConcurrent = clampSubagentLimit(maxConcurrent);
	}

	get maxConcurrent(): number { return this._maxConcurrent; }

	/**
	 * Apply truncation to a list of tool calls.
	 *
	 * @returns SubagentLimitResult with kept and dropped calls separated.
	 */
	apply(toolCalls: IToolCallInfo[]): SubagentLimitResult {
		// Find indices of all sub-agent delegation calls
		const taskIndices: number[] = [];
		for (let i = 0; i < toolCalls.length; i++) {
			if (SUBAGENT_DELEGATION_TOOL_NAMES.has(toolCalls[i].name)) {
				taskIndices.push(i);
			}
		}

		if (taskIndices.length <= this._maxConcurrent) {
			return {
				toolCalls,
				droppedCalls: [],
				wasTruncated: false,
				originalTaskCount: taskIndices.length,
				keptTaskCount: taskIndices.length,
			};
		}

		// Build the set of indices to drop (excess task calls beyond the limit)
		const indicesToDrop = new Set(taskIndices.slice(this._maxConcurrent));

		const kept: IToolCallInfo[] = [];
		const dropped: IToolCallInfo[] = [];

		for (let i = 0; i < toolCalls.length; i++) {
			if (indicesToDrop.has(i)) {
				dropped.push(toolCalls[i]);
			} else {
				kept.push(toolCalls[i]);
			}
		}

		return {
			toolCalls: kept,
			droppedCalls: dropped,
			wasTruncated: true,
			originalTaskCount: taskIndices.length,
			keptTaskCount: this._maxConcurrent,
		};
	}

	/**
	 * Check if a tool call is a sub-agent delegation call.
	 */
	isDelegationCall(toolCall: IToolCallInfo): boolean {
		return SUBAGENT_DELEGATION_TOOL_NAMES.has(toolCall.name);
	}

	/**
	 * Count sub-agent delegation calls in a tool_calls array without truncating.
	 */
	countDelegationCalls(toolCalls: IToolCallInfo[]): number {
		let count = 0;
		for (const tc of toolCalls) {
			if (SUBAGENT_DELEGATION_TOOL_NAMES.has(tc.name)) { count++; }
		}
		return count;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Clamp subagent limit to valid range [2, 5] (aligned with MAX_TASKS_PER_CALL). */
export function clampSubagentLimit(value: number): number {
	return Math.max(MIN_SUBAGENT_LIMIT, Math.min(MAX_SUBAGENT_LIMIT, value));
}

/** 「超限被丢弃的委派」回给模型的失败 tool_result（结构兼容 agentOSService 的 results 元素）。 */
export interface DroppedDelegationResult {
	readonly toolCallId: string;
	readonly content: {
		readonly ok: false;
		readonly dropped: true;
		readonly reason: 'subagent_concurrency_limit';
		readonly message: string;
	};
	readonly success: false;
}

/**
 * 构造「超限被丢弃的委派」的失败 tool_result。
 *
 * ★ 为什么必须回一条 result：本中间件只是把超出 maxConcurrent 的委派从执行列表里
 *   摘掉，**不执行也不回告**。若不补这条 result，模型会以为这些任务都在跑
 *   （后续推理建立在错误前提上：漏做、或重复提交），也看不到任何失败原因。
 *   对齐本仓「结果被削弱时必须在输出里显式披露」的原则。纯函数，便于单测。
 *
 * @param callId 被丢弃的 tool_call id（必须与模型下发的 id 一致，否则无法配对）
 * @param keptCount 本轮回告中实际保留（会执行）的委派数
 * @param submittedCount 模型本轮提交的委派总数
 */
export function buildDroppedDelegationResult(
	callId: string,
	keptCount: number,
	submittedCount: number,
): DroppedDelegationResult {
	return {
		toolCallId: callId,
		content: {
			ok: false,
			dropped: true,
			reason: 'subagent_concurrency_limit',
			message: `This delegation was NOT executed: at most ${keptCount} sub-agent delegations may run per iteration, `
				+ `and ${submittedCount} were submitted. Re-submit this task in the next iteration `
				+ `(or split it into smaller batches).`,
		},
		success: false,
	};
}

/**
 * Convenience: apply truncation in a single function call.
 * Returns the kept tool calls (non-delegation calls are always preserved).
 */
export function truncateExcessSubagentCalls(
	toolCalls: IToolCallInfo[],
	maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SUBAGENTS,
): IToolCallInfo[] {
	const mw = new SubagentLimitMiddleware(maxConcurrent);
	return mw.apply(toolCalls).toolCalls;
}
