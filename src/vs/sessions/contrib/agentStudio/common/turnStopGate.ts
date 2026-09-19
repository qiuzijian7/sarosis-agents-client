/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turn 停止判定的单一裁决面（Stop Gate）。
 *
 * ## 为什么需要本模块
 *
 * 重构前，「本轮是否该停 / 是否该转收尾」的判据散落在 12 处，各自独立实现、
 * 独立阈值、独立日志：
 *
 * | 原位置 | 信号 |
 * |---|---|
 * | `agentTurnExecutor.ts:1084` | `MAX_CONSECUTIVE_TOOL_FAILURES` |
 * | `agentTurnExecutor.ts:1088` | `MAX_TERMINAL_EMPTY_OUTPUT` |
 * | `agentTurnExecutor.ts:1109` | `MAX_TEXT_SEARCH_STREAK`（软） |
 * | `agentTurnExecutor.ts:1112` | `MAX_TEXT_SEARCH_STREAK_HARD`（硬） |
 * | `agentTurnExecutor.ts:1126` | `MAX_SINGLE_TOOL_STREAK` |
 * | `agentTurnExecutor.ts:1217` | `MAX_REFLECT_ITERATIONS` |
 * | `agentTurnExecutor.ts:2120` | 全批工具名不存在 + `MAX_INVALID_TOOL_RETRIES` |
 * | `agentTurnExecutor.ts:2138` | `shouldTerminateToolBatch`（`every`） |
 * | `agentTurnExecutor.ts:2160` | clarify 信号（`some`） |
 * | `agentTurnExecutor.ts:2289` | `HARD_STOP_ITERATIONS` |
 * | `agentTurnExecutor.ts:3815` | ping-pong 检测 |
 * | `turnIterationGate.ts:144/159` | `classifyBudgetGate` / `isWrapUpRound` |
 *
 * 对标 pi：`packages/agent/src/agent-loop.ts` 的全部等价语义只压在三处 ——
 * `stopReason === 'error' | 'aborted'`（`:215`）、批次 `terminate`（`:235`）、
 * `shouldStopAfterTurn`（`:252`）。claw 缺的不是判据，是**判据的汇聚点**。
 *
 * ## 本模块的边界（重要）
 *
 * 只收口**判定位置**，不改阈值、不改语义。每条判据的 `every` / `some` /
 * 「先递增后比较」等细节都按原实现逐条固化，并由单测锁定 —— 这些阈值是对
 * 真实故障日志的响应（原注释均带日志 ID），统一它们会引入回归。
 *
 * 三个导出的裁决函数对应主循环真实存在的三个决策点，而非硬凑成一个函数：
 *  - {@link classifyIterationStop}：每轮顶（预算 / 收尾轮）
 *  - {@link classifyBatchStop}：工具批次完成后（terminate / clarify / 工具名不存在）
 *  - {@link classifyGuardrailStreak}：连击类护栏（提醒 / 强制收尾）
 *
 * 全部为纯函数：不读模块状态、不写日志、不抛异常。日志与状态写回留在调用方，
 * 保持「裁决可单测，副作用可观测」的分工。
 *
 * @module agentStudio/turnStopGate
 */

import { classifyBudgetGate } from './loopGate.js';
import { findClarifySignal, type ITurnSignalToolResult } from './turnSignals.js';

/** 停止原因。命名对齐原实现的日志措辞，便于排障时反查。 */
export type StopReason =
	/** 预算耗尽且收尾轮已跑过（`turnIterationGate.ts:149`） */
	| 'budget-exhausted'
	/** 撞迭代硬上限（`agentTurnExecutor.ts:2289` `HARD_STOP_ITERATIONS`） */
	| 'hard-iteration-limit'
	/** 全批工具返回 `terminate === true`（`agentTurnExecutor.ts:2138`） */
	| 'tool-batch-terminate'
	/** clarify 已把问题抛给用户，需结束 turn 等回答（`agentTurnExecutor.ts:2160`） */
	| 'clarify-awaiting-user'
	/** 工具名不存在的重试次数达上限（`agentTurnExecutor.ts:2126`） */
	| 'invalid-tool-name-retries'
	/** 纯文本搜索连击失控（`agentTurnExecutor.ts:1112` 硬上限） */
	| 'text-search-streak-hard'
	/** 零进展空转（整轮工具全被拦）升级为强制收尾 */
	| 'all-blocked-streak'
	/** 策略 `shouldTerminate` 主动要求终止（此前为死代码，见阶段 3） */
	| 'strategy-requested';

/** 收尾提醒的种类。调用方据此挑选提醒文案，本模块不产文案。 */
export type WrapUpHint =
	/** 撞硬上限的收尾提醒（`hardLimitWrapUpReminder`） */
	| 'hard-limit'
	/** 零进展空转的收尾提醒（`allBlockedWrapUpReminder`） */
	| 'all-blocked'
	/** 文本搜索连击的收尾提醒 */
	| 'text-search-streak';

/**
 * 裁决结果。
 *
 * 三态而非布尔：原实现的「预算耗尽」路径是**两段式**（先转收尾轮再硬停），
 * 布尔返回值无法表达中间态。故障背景见 `loopGate.ts:86-87`（日志
 * 1787214724132：末轮 delegate_task 成果 100% 丢弃）。
 */
export type StopDecision =
	/** 继续下一轮 */
	| { readonly kind: 'continue' }
	/** 转入收尾轮：禁用工具 + 注入提醒，跑完这一轮再停 */
	| { readonly kind: 'wrap-up'; readonly reason: StopReason; readonly hint: WrapUpHint }
	/** 立即停止主循环 */
	| { readonly kind: 'stop'; readonly reason: StopReason };

const CONTINUE: StopDecision = { kind: 'continue' };

// ─── 决策点 1：每轮顶（预算 / 收尾轮）────────────────────────────────────────

/** {@link classifyIterationStop} 的输入。 */
export interface IterationStopInput {
	/** 1-based 当前轮次（`loopState.iteration`） */
	readonly iteration: number;
	/** `budget.hasRemaining()` */
	readonly hasRemainingBudget: boolean;
	/** `budget.isGraceArmed()` */
	readonly isGraceArmed: boolean;
	/** `runState.wrapUp.done` —— 收尾轮是否已跑过 */
	readonly wrapUpDone: boolean;
	/** `runState.wrapUp.forced` —— 是否已被其他路径请求收尾 */
	readonly wrapUpForced: boolean;
	/** 策略 `shouldTerminate` 的返回值（未实现时传 false） */
	readonly strategyRequestedStop?: boolean;
}

/** 每轮顶裁决的阈值。 */
export interface IterationStopLimits {
	/** `MAX_TOOL_ITERATIONS` —— 超出即为收尾轮（`turnIterationGate.ts:159`） */
	readonly maxToolIterations: number;
}

/**
 * 每轮顶的停止裁决。
 *
 * 判定顺序**必须**与原实现一致（`turnIterationGate.ts:144-159`）：
 *  1. 预算门控（`classifyBudgetGate`）—— 'stop' 直接跳出，'wrap-up' 置 forced
 *  2. 收尾轮判定 —— `forced || iteration > maxToolIterations`
 *
 * 策略 `shouldTerminate` 插在预算之前：策略的主动终止意愿优先于预算的两段式
 * 宽限（策略已决定收手，再跑一轮收尾无意义）。
 *
 * 注意 `'wrap-up'` 与 `'stop'` 的区别不可合并：前者还要跑一轮禁用工具的收尾轮，
 * 后者立即退出。语义来源见 `agentRunState.ts` 的 `AgentWrapUpState` 注释。
 */
export function classifyIterationStop(
	input: IterationStopInput,
	limits: IterationStopLimits,
): StopDecision {
	if (input.strategyRequestedStop === true) {
		return { kind: 'stop', reason: 'strategy-requested' };
	}

	const budgetGate = classifyBudgetGate(
		input.hasRemainingBudget,
		input.isGraceArmed,
		input.wrapUpDone,
	);
	if (budgetGate === 'stop') {
		return { kind: 'stop', reason: 'budget-exhausted' };
	}

	// 'wrap-up' 等价于原实现的 `patchWrapUp({ forced: true })`，随后与
	// `iteration > max` 一同落入下方的收尾轮判定。
	const forced = input.wrapUpForced || budgetGate === 'wrap-up';
	if (forced || input.iteration > limits.maxToolIterations) {
		return {
			kind: 'wrap-up',
			reason: budgetGate === 'wrap-up' ? 'budget-exhausted' : 'hard-iteration-limit',
			hint: 'hard-limit',
		};
	}

	return CONTINUE;
}

// ─── 决策点 2：工具批次完成后 ───────────────────────────────────────────────

/** {@link classifyBatchStop} 的输入。 */
export interface BatchStopInput {
	/** 本轮已完成的工具结果 */
	readonly toolResults: ReadonlyArray<ITurnSignalToolResult>;
	/** 由 toolCallId 反查工具名（executor 侧用 `localExecutedCalls` 查） */
	readonly resolveToolName: (toolCallId: string) => string | undefined;
	/** `runState.invalidToolNameCount` —— **递增前**的值 */
	readonly invalidToolNameCount: number;
}

/** 批次裁决的阈值。 */
export interface BatchStopLimits {
	/** `MAX_INVALID_TOOL_RETRIES` */
	readonly maxInvalidToolRetries: number;
}

/**
 * 批次裁决结果 = 停止裁决 + 「是否需要递增工具名无效计数」。
 *
 * 分两个字段而非折进 `StopDecision`：原实现里递增（`INVALID_TOOL_NAME` reducer）
 * 与停止是**两个独立动作** —— 全批工具名不存在时**总是**递增，但只在计数达上限
 * 时才停。折进一个字段会丢掉「递增了但没停」这个状态。
 */
export interface BatchStopResult {
	readonly decision: StopDecision;
	/** true=调用方须 dispatch `INVALID_TOOL_NAME` reducer（无论是否停止） */
	readonly shouldCountInvalidToolName: boolean;
	/** 命中 clarify 时的 toolCallId 与问题数（日志用） */
	readonly clarifyToolCallId?: string;
	readonly clarifyQuestionCount?: number;
}

/**
 * 全批工具是否都因「工具名不存在」而失败。
 *
 * `every` 语义（`agentTurnExecutor.ts:2120`）：只要有一个工具是别的失败原因，
 * 就不算无效工具名批次 —— 那属于正常的工具失败，交给失败计数路径处理。
 *
 * 判据是结果文本里的 `does not exist` / `not available`，与原实现逐字一致。
 * 改用结构化字段是后续工作（需要工具执行层配合），本模块不动它。
 */
export function isAllInvalidToolName(
	toolResults: ReadonlyArray<ITurnSignalToolResult>,
): boolean {
	if (toolResults.length === 0) {
		return false;
	}
	return toolResults.every(result => {
		// 与原实现一致用 stringify 做包含判断；循环引用降级为「不匹配」，
		// 判定异常绝不能影响主循环。
		let serialized: string;
		try {
			serialized = JSON.stringify(result.content) ?? '';
		} catch {
			return false;
		}
		return serialized.includes('does not exist') || serialized.includes('not available');
	});
}

/**
 * 全批工具是否都显式请求终止。
 *
 * ⚠ `every` 语义（`agentTurnExecutor.ts:2138`，借鉴 OpenClaw）：与下方 clarify 的
 * `some` **刻意不同**。此处要求全批一致，是因为 `terminate` 表达的是「该工具认为
 * 任务已完成」，混合批次里只要还有工具在干活就不该停。
 *
 * 空批次返回 false（`length > 0` 前置条件），否则 `every` 对空数组恒为 true，
 * 会让「本轮没执行任何工具」被误判为全体请求终止。
 */
export function isWholeBatchTerminate(
	toolResults: ReadonlyArray<ITurnSignalToolResult>,
): boolean {
	if (toolResults.length === 0) {
		return false;
	}
	return toolResults.every(result => (result as { terminate?: unknown }).terminate === true);
}

/**
 * 工具批次完成后的停止裁决。
 *
 * 判定顺序**必须**与原实现一致（`agentTurnExecutor.ts:2120 → 2138 → 2160`）：
 *  1. 全批工具名不存在 → 递增计数，达上限则停
 *  2. 全批 `terminate`（`every`）→ 停
 *  3. clarify 命中（`some`）→ 停
 *
 * 顺序不可调换：clarify 若前置，会在「clarify 参数写错导致全批失败」的场景下
 * 抢在无效工具名计数之前返回，让重试计数永远涨不上去。
 */
export function classifyBatchStop(
	input: BatchStopInput,
	limits: BatchStopLimits,
): BatchStopResult {
	const { toolResults } = input;
	if (toolResults.length === 0) {
		return { decision: CONTINUE, shouldCountInvalidToolName: false };
	}

	if (isAllInvalidToolName(toolResults)) {
		// 原实现先 dispatch reducer 再比较递增后的值，故此处用 count + 1。
		const nextCount = input.invalidToolNameCount + 1;
		if (nextCount >= limits.maxInvalidToolRetries) {
			return {
				decision: { kind: 'stop', reason: 'invalid-tool-name-retries' },
				shouldCountInvalidToolName: true,
			};
		}
		// 递增了但未达上限：继续跑，让模型有机会改用正确工具名。
		return { decision: CONTINUE, shouldCountInvalidToolName: true };
	}

	if (isWholeBatchTerminate(toolResults)) {
		return {
			decision: { kind: 'stop', reason: 'tool-batch-terminate' },
			shouldCountInvalidToolName: false,
		};
	}

	const clarifySignal = findClarifySignal(toolResults, input.resolveToolName);
	if (clarifySignal) {
		return {
			decision: { kind: 'stop', reason: 'clarify-awaiting-user' },
			shouldCountInvalidToolName: false,
			clarifyToolCallId: clarifySignal.toolCallId,
			clarifyQuestionCount: clarifySignal.questionCount,
		};
	}

	return { decision: CONTINUE, shouldCountInvalidToolName: false };
}

// ─── 决策点 3：连击类护栏 ───────────────────────────────────────────────────

/** {@link classifyGuardrailStreak} 的输入。全部为「当前连击计数」。 */
export interface GuardrailStreakInput {
	/** 纯文本搜索连续轮数（`runState.guardrails.textSearchStreak`） */
	readonly textSearchStreak: number;
	/** 文本搜索软提醒是否已注入过（只注入一次，避免刷屏） */
	readonly textSearchSoftReminderSent: boolean;
	/** 整轮工具全被拦的连续轮数（`runState.guardrails.allBlockedStreak`） */
	readonly allBlockedStreak: number;
	/** 零进展强提醒是否已注入过 */
	readonly allBlockedReminderSent: boolean;
	/** 每轮只调 1 个只读工具的连续轮数（`runState.guardrails.singleToolStreak`） */
	readonly singleToolStreak: number;
	/** 同一工具连续失败次数（`_toolConsecutiveFailures` 的当前最大值） */
	readonly consecutiveToolFailures: number;
	/** terminal 连续空输出次数 */
	readonly terminalEmptyOutputs: number;
}

/** 连击护栏的阈值。默认值与原实现逐条对齐。 */
export interface GuardrailStreakLimits {
	/** `MAX_TEXT_SEARCH_STREAK`（软：注入一次引导） */
	readonly maxTextSearchStreak: number;
	/** `MAX_TEXT_SEARCH_STREAK_HARD`（硬：强制收尾轮）。原默认 = 软上限 × 2 */
	readonly maxTextSearchStreakHard: number;
	/** 零进展空转转强提醒的轮数 */
	readonly allBlockedReminderAfter: number;
	/** 零进展空转转强制收尾的轮数 */
	readonly allBlockedWrapUpAfter: number;
	/** `MAX_SINGLE_TOOL_STREAK` */
	readonly maxSingleToolStreak: number;
	/** `MAX_CONSECUTIVE_TOOL_FAILURES` */
	readonly maxConsecutiveToolFailures: number;
	/** `MAX_TERMINAL_EMPTY_OUTPUT` */
	readonly maxTerminalEmptyOutput: number;
}

/** 需要注入的护栏提醒种类（调用方据此挑文案）。 */
export type GuardrailReminder =
	| 'text-search-guidance'
	| 'all-blocked-strong'
	| 'batch-parallel-guidance'
	| 'tool-failure-recovery'
	| 'terminal-empty-output';

/** 连击护栏的裁决结果。 */
export interface GuardrailStreakResult {
	readonly decision: StopDecision;
	/** 本轮应注入的提醒（可多条，按判定顺序） */
	readonly reminders: ReadonlyArray<GuardrailReminder>;
}

/*
 * ⚠ 此处曾有 `deriveTextSearchHardLimit(softLimit, override?)`，2026-09-17 删除。
 *
 * 它的唯一存在理由是「原实现允许 `host.constructor.MAX_TEXT_SEARCH_STREAK_HARD`
 * 覆盖调参，故只能提供缺省推导」。该前提已两次失效：
 *
 *  1. 那个 override **在任何宿主上都不存在** —— `AgentOSService` 从未声明该静态量
 *     （断言见 `test/common/turnLoopConstants.test.ts:140-144`），原表达式恒走
 *     `* 2` 分支。可覆盖性是想象出来的需求。
 *  2. 实际行为已被固化为显式常量 `MAX_TEXT_SEARCH_STREAK_HARD`
 *     （`common/turnLoopConstants.ts:49` = `MAX_TEXT_SEARCH_STREAK * 2`），
 *     生产侧 `agentTurnExecutor.ts:4380` 直接 import 该常量比较。
 *
 * 即：一个「运行时可调参」的推导函数，被一个编译期常量取代了。保留它只会诱使
 * 后来者把常量改回函数调用，重新引入 `undefined` 静默失效的风险。
 */

/**
 * 连击类护栏裁决。
 *
 * ⚠ **适用范围（2026-09-17 核实后补注）**：本函数是「每轮一次的聚合裁决」，
 * 但原实现的五处判定分散在**两个层级、五个时机**上，粒度并不匹配：
 *
 * | 计数 | 原判定位置 | 粒度 |
 * |---|---|---|
 * | `consecutiveToolFailures` | `agentTurnExecutor.ts:4298`（`_processToolResult` 内） | 每个工具结果 |
 * | `terminalEmptyOutputs` | 同上 `:4317` | 每个工具结果 |
 * | `textSearchStreak` | 同上 `:4337` | 每个工具结果 |
 * | `singleToolStreak` | `:4228`（批次执行前） | 每批一次 |
 * | `allBlockedStreak` | `:4056`（全被拦的 continue 前） | 每批一次 |
 *
 * 三条已知的不可直接替换点：
 *  1. **计数与判定在原实现里是原子的**（先 `patchGuardrails(+1)` 再立刻比较）。
 *     `_processToolResult` 同批会被每个工具各调一次，聚合裁决只能看到最后一次的
 *     快照 —— 一批 4 个 `search_files` 把 streak 从 3 推到 7，原实现在第 4 次触发
 *     **软**上限并置 `textSearchSoftReminderSent` 抑制其余，聚合版直接判**硬**上限
 *     wrap-up。这是行为变更，不是等价重构。
 *  2. **提醒文案需要判定点的局部上下文**，而 {@link GuardrailReminder} 是无参枚举：
 *     `toolConsecutiveFailureReminder` 要 `toolName`，文本搜索软提醒要按
 *     `enabledTools` 有无结构搜索工具二选一，`batchReadOnlyToolsReminder` 要连击
 *     工具名列表。
 *  3. `singleToolStreak` 的原判据是 `advanceSingleToolStreak`
 *     （`loopReminders.ts:337`）的 `streak % threshold === 0` —— **周期性**提醒；
 *     本函数的 `>=` 会在达标后每轮都提醒（刷屏且污染前缀缓存）。
 *
 * 因此**不要**把本函数接到上述任一工具级判定点。批次级的
 * `allBlockedStreak` 已单独收口为 {@link classifyAllBlockedStreak}（避免被本
 * 函数最前面的 textSearch 硬上限分支抢判）。本函数保留为「聚合语义的参考实现
 * 与单测基线」，真正接线需先完成时序重排并单独补护栏测试。
 *
 * 与前两个决策点的关键差异：这里**大多数信号只产提醒、不停循环**。原实现里
 * 唯一能升级为强制收尾的是文本搜索硬上限与零进展空转 —— 其余（工具失败连击 /
 * 单工具连击 / terminal 空输出）都只注入 `<system-reminder>` 引导模型自纠，
 * 硬停留给预算门控与迭代上限。
 *
 * 提醒的「只注入一次」语义保留在输入的 `*ReminderSent` 标志里：由调用方在
 * `runState.guardrails` 落状态，本函数只读不写。
 */
export function classifyGuardrailStreak(
	input: GuardrailStreakInput,
	limits: GuardrailStreakLimits,
): GuardrailStreakResult {
	const reminders: GuardrailReminder[] = [];

	// 硬信号优先：命中即强制收尾，不再累加其他提醒（避免提醒文案自相矛盾，
	// 背景见 turnIterationGate.ts:172-177）。
	if (input.textSearchStreak >= limits.maxTextSearchStreakHard) {
		return {
			decision: { kind: 'wrap-up', reason: 'text-search-streak-hard', hint: 'text-search-streak' },
			reminders,
		};
	}
	if (input.allBlockedStreak >= limits.allBlockedWrapUpAfter) {
		return {
			decision: { kind: 'wrap-up', reason: 'all-blocked-streak', hint: 'all-blocked' },
			reminders,
		};
	}

	// 软信号：只产提醒。顺序对齐原实现的注入顺序。
	if (input.textSearchStreak >= limits.maxTextSearchStreak && !input.textSearchSoftReminderSent) {
		reminders.push('text-search-guidance');
	}
	if (input.allBlockedStreak >= limits.allBlockedReminderAfter && !input.allBlockedReminderSent) {
		reminders.push('all-blocked-strong');
	}
	if (input.singleToolStreak >= limits.maxSingleToolStreak) {
		reminders.push('batch-parallel-guidance');
	}
	if (input.consecutiveToolFailures >= limits.maxConsecutiveToolFailures) {
		reminders.push('tool-failure-recovery');
	}
	if (input.terminalEmptyOutputs >= limits.maxTerminalEmptyOutput) {
		reminders.push('terminal-empty-output');
	}

	return { decision: CONTINUE, reminders };
}

/** {@link classifyAllBlockedStreak} 的阈值。 */
export interface AllBlockedStreakLimits {
	/** `ALL_BLOCKED_ESCALATE_AT` —— 注入一次「整轮无进展」强提醒 */
	readonly reminderAfter: number;
	/** `ALL_BLOCKED_WRAPUP_AT` —— 升级为强制收尾轮（禁工具） */
	readonly wrapUpAfter: number;
}

/**
 * 「整轮工具全被拦」连击的裁决（`agentTurnExecutor.ts:4069-4087`）。
 *
 * ## 为什么不复用 {@link classifyGuardrailStreak}
 *
 * 聚合版把 `textSearchStreak >= hard` 排在最前，而本决策点（批次全被拦下的
 * `continue` 前）上 `textSearchStreak` 完全可能非零 —— 复用会把「零进展空转」
 * 误判成「文本搜索连击」，`reason` / `hint` 双双跑偏，排障时反查到错误的日志。
 * 故这里按决策点单开一个粒度匹配的原语。
 *
 * 三档升级与原实现逐条对齐，注意是 `if / else if`：**命中收尾档时不再注入软
 * 提醒**（两段文案会自相矛盾 —— 一个说「换个思路继续」，一个说「工具已禁用」）。
 */
export function classifyAllBlockedStreak(
	streak: number,
	reminderSent: boolean,
	limits: AllBlockedStreakLimits,
): GuardrailStreakResult {
	if (streak >= limits.wrapUpAfter) {
		return {
			decision: { kind: 'wrap-up', reason: 'all-blocked-streak', hint: 'all-blocked' },
			reminders: [],
		};
	}
	if (streak >= limits.reminderAfter && !reminderSent) {
		return { decision: CONTINUE, reminders: ['all-blocked-strong'] };
	}
	return { decision: CONTINUE, reminders: [] };
}

// ─── ping-pong ─────────────────────────────────────────────────────────────

/** ping-pong 检测的裁决（`agentTurnExecutor.ts:3821-3836`）。 */
export type PingPongVerdict =
	/** 未命中 ping-pong 模式 */
	| { readonly kind: 'none' }
	/** 命中模式但两侧结果仍在变化 → 放行（仅告警） */
	| { readonly kind: 'allow-changing' }
	/** 命中模式且两侧结果稳定 → 拦截**整批** */
	| { readonly kind: 'block-batch' };

/**
 * ping-pong 裁决。
 *
 * ⚠ 双条件（`pingPong && noProgressEvidence`）不可简化为单条件：结果仍在变化的
 * A→B→A→B 说明模型仍在推进（如翻页、逐个文件读），拦掉会误伤。原实现对这种
 * 情况只告警放行（`:3831-3835`）。
 *
 * 命中时拦**整批**而非单个调用：ping-pong 是批次级的模式，不是单个调用的属性
 * （`:3839` 注释）。
 */
export function classifyPingPong(
	pingPong: boolean,
	noProgressEvidence: boolean,
): PingPongVerdict {
	if (!pingPong) {
		return { kind: 'none' };
	}
	return noProgressEvidence ? { kind: 'block-batch' } : { kind: 'allow-changing' };
}
