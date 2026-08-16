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
 *  Valid range for maxConcurrent: [2, 4] (aligned with deer-flow)
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
