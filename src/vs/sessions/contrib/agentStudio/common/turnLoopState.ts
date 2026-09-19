/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-iteration mutable state for a single agent turn.
 *
 * Mirrors the four closure `let` bindings that pi keeps in `agent-loop.ts:164-168`
 * (`turnOutputTokens` / `toolResultMessage` / ...), but as an explicit object so that
 * loop segments can be extracted into standalone functions instead of having to
 * capture a dozen surrounding variables.
 *
 * Migration is incremental: fields move here in batches, and each batch keeps the
 * original behaviour byte-for-byte. Fields deliberately start out sparse.
 *
 * @module agentStudio/turnLoopState
 */

import type { IToolDefinition } from './providers.js';

/**
 * Iteration counter for the agent turn.
 *
 * Starts at 1 for the first loop round (the executor increments before the loop
 * body runs), and is compared against `MAX_TOOL_ITERATIONS` / wrap-up thresholds.
 * Kept out of `AgentRunState` on purpose — it mirrors LangGraph's step semantics
 * and is a turn-local concern, not part of the durable run snapshot.
 */
export interface ITurnLoopState {
	/** 1-based index of the round currently executing. */
	iteration: number;

	/**
	 * 上下文溢出反应式压缩重试标志（P0-1，2026-08-11，日志 1786432061200）。
	 *
	 * 流调用抛 HTTP 400 code 11133 / invalid_parameter_value 时，仅允许触发一次
	 * 「强制压缩 + 自动重试」；重试后仍失败则走原有 error 路径结束（防死循环）。
	 */
	overflowCompressionDone: boolean;

	/** 软预算收尾提醒的下次触发时间戳（ms）。超阈值首次注入，之后每 REFIRE 周期重复。 */
	softBudgetNextReminderAtMs: number;

	/** 硬剪枝待执行标志：上一轮判定需剪枝但因未压缩而推迟到本轮。 */
	hardPrunePending: boolean;

	/** 本轮生效的工具集（策略 prepareIteration 可覆写）；收尾轮置空以禁用工具。 */
	iterationToolDefs: IToolDefinition[] | undefined;

	/**
	 * 本轮策略级硬权限谓词（`IterationPlan.hardPermission`，返回 true=拦截）。
	 *
	 * 存在这里而不是就地消费：产出点在 `turnIterationGate`（每轮门控段），
	 * 消费点在 `agentTurnExecutor` 的运行时拦截段（工具批次分区），两者跨函数
	 * 边界。此前缺这个字段，谓词在 gate 里被静默丢弃 —— readonly 范式只剩
	 * schema 层过滤，运行时零拦截（见 `toolPermission.isToolCallDeniedByTurnPolicy`）。
	 *
	 * 每轮由 gate 重新赋值（策略不返回则置 undefined），不跨轮累积 ——
	 * 工具面本身是逐轮重算的，权限判据必须同周期，否则会留下过期拦截。
	 */
	iterationHardPermission: ((tool: string) => boolean) | undefined;

	/**
	 * 连续「终态但无输出」计数。达 MAX_TERMINAL_EMPTY_OUTPUT 时触发护栏；
	 * 有产出时归零。
	 */
	terminalEmptyOutputCount: number;

	/** XML 文本工具调用泄漏的已重试次数，上限 XML_TOOL_LEAK_RETRY_LIMIT。 */
	xmlToolLeakAttempts: number;

	/** 上次上报给用户的 prompt token 总量，用于计算 drift 增量。 */
	lastPromptBudgetTotal: number;
}

/** Create the mutable state for a fresh turn. */
export function createTurnLoopState(): ITurnLoopState {
	return {
		iteration: 0,
		overflowCompressionDone: false,
		softBudgetNextReminderAtMs: 0,
		hardPrunePending: false,
		iterationToolDefs: undefined,
		iterationHardPermission: undefined,
		terminalEmptyOutputCount: 0,
		xmlToolLeakAttempts: 0,
		lastPromptBudgetTotal: 0,
	};
}
