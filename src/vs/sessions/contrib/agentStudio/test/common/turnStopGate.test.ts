/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `common/turnStopGate.ts` 的语义固化测试。
 *
 * 本套件的职责不是「覆盖率」，而是**锁定阈值语义**：turnStopGate 是从主循环
 * 12 处散落判据收口而来，每条判据的 `every` / `some` / 边界比较都必须与原实现
 * 逐字一致。任何一条被「顺手统一」都会引入回归，故每条都有独立断言。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { suite, test } from 'node:test';
import {
	classifyBatchStop,
	classifyGuardrailStreak,
	classifyAllBlockedStreak,
	classifyIterationStop,
	classifyPingPong,
	isAllInvalidToolName,
	isWholeBatchTerminate,
	type BatchStopLimits,
	type GuardrailStreakInput,
	type GuardrailStreakLimits,
	type IterationStopInput,
	type IterationStopLimits,
} from '../../common/turnStopGate.js';
import {
	MAX_TEXT_SEARCH_STREAK,
	MAX_TEXT_SEARCH_STREAK_HARD,
} from '../../common/turnLoopConstants.js';
import type { ITurnSignalToolResult } from '../../common/turnSignals.js';

const MODULE_ROOT_RELATIVE = 'src/vs/sessions/contrib/agentStudio';

/**
 * 读取本 contrib 下的模块源码，用于「实现不得回退」的源码级断言。
 *
 * runner 约定从仓库根启动，故按 cwd 解析。刻意**不做兜底搜索**：路径错了就应该
 * 红，静默 skip 会让防线在无人察觉时失效（范式对齐 `turnLoopConstants.test.ts:47`）。
 */
function readModuleSource(relativeToContrib: string): string {
	const absolute = path.resolve(process.cwd(), MODULE_ROOT_RELATIVE, relativeToContrib);
	if (!fs.existsSync(absolute)) {
		throw new Error(
			`找不到源码 ${absolute}。本测试必须从仓库根运行（cwd=${process.cwd()}）。`
		);
	}
	return fs.readFileSync(absolute, 'utf8');
}

/**
 * 剥掉块注释与行注释，避免源码断言把「注释里提到的旧写法」误判为实现回退。
 *
 * 本文件的注释大量引用已删除的标识符（如 deriveTextSearchHardLimit 的删除说明），
 * 不剥注释会让禁止性断言恒失败。
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const ITERATION_LIMITS: IterationStopLimits = { maxToolIterations: 10 };

function iterationInput(overrides: Partial<IterationStopInput> = {}): IterationStopInput {
	return {
		iteration: 1,
		hasRemainingBudget: true,
		isGraceArmed: false,
		wrapUpDone: false,
		wrapUpForced: false,
		...overrides,
	};
}

const BATCH_LIMITS: BatchStopLimits = { maxInvalidToolRetries: 3 };

/** 构造文本型工具结果（最常见的执行路径形状）。 */
function textResult(toolCallId: string, text: string): ITurnSignalToolResult {
	return { toolCallId, content: [{ type: 'text', text }] };
}

const GUARDRAIL_LIMITS: GuardrailStreakLimits = {
	maxTextSearchStreak: 3,
	maxTextSearchStreakHard: 6,
	allBlockedReminderAfter: 2,
	allBlockedWrapUpAfter: 4,
	maxSingleToolStreak: 4,
	maxConsecutiveToolFailures: 3,
	maxTerminalEmptyOutput: 3,
};

function guardrailInput(overrides: Partial<GuardrailStreakInput> = {}): GuardrailStreakInput {
	return {
		textSearchStreak: 0,
		textSearchSoftReminderSent: false,
		allBlockedStreak: 0,
		allBlockedReminderSent: false,
		singleToolStreak: 0,
		consecutiveToolFailures: 0,
		terminalEmptyOutputs: 0,
		...overrides,
	};
}

suite('turnStopGate — 每轮顶裁决（classifyIterationStop）', () => {

	test('预算充足且未撞上限 → continue', () => {
		const decision = classifyIterationStop(iterationInput(), ITERATION_LIMITS);
		assert.strictEqual(decision.kind, 'continue');
	});

	test('预算耗尽 + 收尾轮未跑过 → wrap-up（两段式的第一段）', () => {
		const decision = classifyIterationStop(
			iterationInput({ hasRemainingBudget: false, wrapUpDone: false }),
			ITERATION_LIMITS,
		);
		assert.strictEqual(decision.kind, 'wrap-up');
		assert.strictEqual(decision.kind === 'wrap-up' && decision.reason, 'budget-exhausted');
	});

	test('预算耗尽 + 收尾轮已跑过 → stop（两段式的第二段）', () => {
		const decision = classifyIterationStop(
			iterationInput({ hasRemainingBudget: false, wrapUpDone: true }),
			ITERATION_LIMITS,
		);
		assert.strictEqual(decision.kind, 'stop');
		assert.strictEqual(decision.kind === 'stop' && decision.reason, 'budget-exhausted');
	});

	test('预算耗尽但 grace 已武装 → continue（grace 余量优先于收尾）', () => {
		const decision = classifyIterationStop(
			iterationInput({ hasRemainingBudget: false, isGraceArmed: true, wrapUpDone: true }),
			ITERATION_LIMITS,
		);
		assert.strictEqual(
			decision.kind,
			'continue',
			'grace 武装时即使 wrapUpDone 也必须继续 —— 否则末轮工具成果无人消费',
		);
	});

	test('iteration 恰等于 maxToolIterations → 仍 continue（边界：> 而非 >=）', () => {
		const decision = classifyIterationStop(
			iterationInput({ iteration: 10 }),
			ITERATION_LIMITS,
		);
		assert.strictEqual(decision.kind, 'continue');
	});

	test('iteration 超出 maxToolIterations → wrap-up（hard-iteration-limit）', () => {
		const decision = classifyIterationStop(
			iterationInput({ iteration: 11 }),
			ITERATION_LIMITS,
		);
		assert.strictEqual(decision.kind, 'wrap-up');
		assert.strictEqual(decision.kind === 'wrap-up' && decision.reason, 'hard-iteration-limit');
		assert.strictEqual(decision.kind === 'wrap-up' && decision.hint, 'hard-limit');
	});

	test('wrapUpForced 已被其他路径置位 → wrap-up（即使预算充足）', () => {
		const decision = classifyIterationStop(
			iterationInput({ wrapUpForced: true }),
			ITERATION_LIMITS,
		);
		assert.strictEqual(decision.kind, 'wrap-up');
	});

	test('策略 shouldTerminate → stop，且优先于预算的 wrap-up 宽限', () => {
		const decision = classifyIterationStop(
			iterationInput({ strategyRequestedStop: true, hasRemainingBudget: false, wrapUpDone: false }),
			ITERATION_LIMITS,
		);
		assert.strictEqual(decision.kind, 'stop');
		assert.strictEqual(
			decision.kind === 'stop' && decision.reason,
			'strategy-requested',
			'策略主动终止必须优先于 budget-exhausted 的 wrap-up',
		);
	});
});

suite('turnStopGate — 批次裁决（classifyBatchStop）', () => {

	test('空批次 → continue，且不递增无效工具名计数', () => {
		const result = classifyBatchStop(
			{ toolResults: [], resolveToolName: () => undefined, invalidToolNameCount: 0 },
			BATCH_LIMITS,
		);
		assert.strictEqual(result.decision.kind, 'continue');
		assert.strictEqual(result.shouldCountInvalidToolName, false);
	});

	test('isWholeBatchTerminate 空数组返回 false（不可被 every 的空真值误判）', () => {
		assert.strictEqual(
			isWholeBatchTerminate([]),
			false,
			'every 对空数组恒为 true —— 必须由 length 前置条件拦住',
		);
	});

	test('isAllInvalidToolName 空数组返回 false', () => {
		assert.strictEqual(isAllInvalidToolName([]), false);
	});

	test('terminate 语义是 every：混合批次不终止', () => {
		const toolResults: ITurnSignalToolResult[] = [
			{ toolCallId: 'a', content: 'ok', terminate: true } as ITurnSignalToolResult,
			{ toolCallId: 'b', content: 'ok' },
		];
		assert.strictEqual(
			isWholeBatchTerminate(toolResults),
			false,
			'terminate 用 every —— 只要还有工具在干活就不该停',
		);
	});

	test('terminate 语义是 every：全批 terminate 才停', () => {
		const toolResults: ITurnSignalToolResult[] = [
			{ toolCallId: 'a', content: 'ok', terminate: true } as ITurnSignalToolResult,
			{ toolCallId: 'b', content: 'ok', terminate: true } as ITurnSignalToolResult,
		];
		const result = classifyBatchStop(
			{ toolResults, resolveToolName: () => 'file_read', invalidToolNameCount: 0 },
			BATCH_LIMITS,
		);
		assert.strictEqual(result.decision.kind, 'stop');
		assert.strictEqual(result.decision.kind === 'stop' && result.decision.reason, 'tool-batch-terminate');
	});

	test('clarify 语义是 some：混合批次也终止（与 terminate 的 every 刻意不同）', () => {
		const clarifyPayload = JSON.stringify({ __clarify__: true, questions: [{ question: 'A?' }] });
		const toolResults: ITurnSignalToolResult[] = [
			textResult('c1', clarifyPayload),
			textResult('c2', 'file contents here'),
		];
		const result = classifyBatchStop(
			{
				toolResults,
				resolveToolName: id => (id === 'c1' ? 'clarify' : 'file_read'),
				invalidToolNameCount: 0,
			},
			BATCH_LIMITS,
		);
		assert.strictEqual(
			result.decision.kind,
			'stop',
			'clarify 用 some —— 问题一旦渲染，同批次其他结果模型也用不上',
		);
		assert.strictEqual(result.decision.kind === 'stop' && result.decision.reason, 'clarify-awaiting-user');
		assert.strictEqual(result.clarifyToolCallId, 'c1');
		assert.strictEqual(result.clarifyQuestionCount, 1);
	});

	test('clarify 参数错误（无 marker）→ 不终止', () => {
		const toolResults = [
			textResult('c1', 'Error: question or questions[] parameter is required'),
		];
		const result = classifyBatchStop(
			{ toolResults, resolveToolName: () => 'clarify', invalidToolNameCount: 0 },
			BATCH_LIMITS,
		);
		assert.strictEqual(
			result.decision.kind,
			'continue',
			'参数写错不能直接结束 turn —— 否则用户什么也看不到',
		);
	});

	test('工具名是 clarify 但内容仅恰好含 marker 字样 → 不终止（JSON 不合法）', () => {
		const toolResults = [textResult('c1', 'const CLARIFY_MARKER = "__clarify__";')];
		const result = classifyBatchStop(
			{ toolResults, resolveToolName: () => 'clarify', invalidToolNameCount: 0 },
			BATCH_LIMITS,
		);
		assert.strictEqual(result.decision.kind, 'continue');
	});

	test('非 clarify 工具返回合法 clarify 载荷 → 不终止（双重判据）', () => {
		const clarifyPayload = JSON.stringify({ __clarify__: true, questions: [{ question: 'A?' }] });
		const toolResults = [textResult('f1', clarifyPayload)];
		const result = classifyBatchStop(
			{ toolResults, resolveToolName: () => 'file_read', invalidToolNameCount: 0 },
			BATCH_LIMITS,
		);
		assert.strictEqual(
			result.decision.kind,
			'continue',
			'file_read 读出 clarify 源码时不得被误判',
		);
	});

	test('工具名不存在语义是 every：混合失败原因不算无效工具名批次', () => {
		const toolResults = [
			textResult('a', 'Tool "foo" does not exist'),
			textResult('b', 'Permission denied'),
		];
		assert.strictEqual(isAllInvalidToolName(toolResults), false);
	});

	test('全批工具名不存在但未达上限 → continue 且递增计数', () => {
		const toolResults = [
			textResult('a', 'Tool "foo" does not exist'),
			textResult('b', 'Tool "bar" is not available'),
		];
		const result = classifyBatchStop(
			{ toolResults, resolveToolName: () => 'foo', invalidToolNameCount: 0 },
			BATCH_LIMITS,
		);
		assert.strictEqual(result.decision.kind, 'continue');
		assert.strictEqual(
			result.shouldCountInvalidToolName,
			true,
			'递增与停止是两个独立动作 —— 未达上限也必须递增',
		);
	});

	test('全批工具名不存在且递增后达上限 → stop（先递增后比较）', () => {
		const toolResults = [textResult('a', 'Tool "foo" does not exist')];
		const result = classifyBatchStop(
			{ toolResults, resolveToolName: () => 'foo', invalidToolNameCount: 2 },
			BATCH_LIMITS,
		);
		assert.strictEqual(
			result.decision.kind,
			'stop',
			'原实现先 dispatch reducer 再比较递增后的值：2 + 1 >= 3',
		);
		assert.strictEqual(result.decision.kind === 'stop' && result.decision.reason, 'invalid-tool-name-retries');
		assert.strictEqual(result.shouldCountInvalidToolName, true);
	});

	test('判定顺序：无效工具名先于 clarify（否则重试计数永远涨不上去）', () => {
		// clarify 参数写错 → 返回 does not exist 类文本，且工具名是 clarify
		const toolResults = [textResult('c1', 'Tool "clarify" does not exist')];
		const result = classifyBatchStop(
			{ toolResults, resolveToolName: () => 'clarify', invalidToolNameCount: 0 },
			BATCH_LIMITS,
		);
		assert.strictEqual(result.shouldCountInvalidToolName, true);
	});

	test('循环引用的 content 不抛异常（判定失败必须降级为不匹配）', () => {
		const circular: Record<string, unknown> = { type: 'text' };
		circular.self = circular;
		assert.doesNotThrow(() => isAllInvalidToolName([{ toolCallId: 'a', content: circular }]));
		assert.strictEqual(isAllInvalidToolName([{ toolCallId: 'a', content: circular }]), false);
	});
});

suite('turnStopGate — 连击护栏（classifyGuardrailStreak）', () => {

	test('全零输入 → continue 且无提醒', () => {
		const result = classifyGuardrailStreak(guardrailInput(), GUARDRAIL_LIMITS);
		assert.strictEqual(result.decision.kind, 'continue');
		assert.deepStrictEqual(result.reminders, []);
	});

	test('文本搜索达软上限 → 只产提醒，不停循环', () => {
		const result = classifyGuardrailStreak(
			guardrailInput({ textSearchStreak: 3 }),
			GUARDRAIL_LIMITS,
		);
		assert.strictEqual(result.decision.kind, 'continue');
		assert.deepStrictEqual(result.reminders, ['text-search-guidance']);
	});

	test('文本搜索软提醒已发过 → 不重复注入（避免每轮刷屏）', () => {
		const result = classifyGuardrailStreak(
			guardrailInput({ textSearchStreak: 4, textSearchSoftReminderSent: true }),
			GUARDRAIL_LIMITS,
		);
		assert.deepStrictEqual(result.reminders, []);
	});

	test('文本搜索达硬上限 → wrap-up，且不叠加其他提醒', () => {
		const result = classifyGuardrailStreak(
			guardrailInput({ textSearchStreak: 6, singleToolStreak: 9, consecutiveToolFailures: 9 }),
			GUARDRAIL_LIMITS,
		);
		assert.strictEqual(result.decision.kind, 'wrap-up');
		assert.strictEqual(result.decision.kind === 'wrap-up' && result.decision.reason, 'text-search-streak-hard');
		assert.deepStrictEqual(
			result.reminders,
			[],
			'硬信号命中时不得叠加软提醒 —— 提醒文案会自相矛盾',
		);
	});

	test('零进展空转达提醒阈值 → 提醒；达收尾阈值 → wrap-up', () => {
		const reminderOnly = classifyGuardrailStreak(
			guardrailInput({ allBlockedStreak: 2 }),
			GUARDRAIL_LIMITS,
		);
		assert.strictEqual(reminderOnly.decision.kind, 'continue');
		assert.deepStrictEqual(reminderOnly.reminders, ['all-blocked-strong']);

		const escalated = classifyGuardrailStreak(
			guardrailInput({ allBlockedStreak: 4 }),
			GUARDRAIL_LIMITS,
		);
		assert.strictEqual(escalated.decision.kind, 'wrap-up');
		assert.strictEqual(escalated.decision.kind === 'wrap-up' && escalated.decision.hint, 'all-blocked');
	});

	test('工具失败 / 单工具连击 / terminal 空输出 → 只产提醒，绝不硬停', () => {
		const result = classifyGuardrailStreak(
			guardrailInput({
				consecutiveToolFailures: 3,
				singleToolStreak: 4,
				terminalEmptyOutputs: 3,
			}),
			GUARDRAIL_LIMITS,
		);
		assert.strictEqual(
			result.decision.kind,
			'continue',
			'这三条在原实现里只注入 reminder，硬停留给预算门控与迭代上限',
		);
		assert.deepStrictEqual(result.reminders, [
			'batch-parallel-guidance',
			'tool-failure-recovery',
			'terminal-empty-output',
		]);
	});

	test('阈值比较是 >= 而非 >（边界值即触发）', () => {
		const atThreshold = classifyGuardrailStreak(
			guardrailInput({ singleToolStreak: 4 }),
			GUARDRAIL_LIMITS,
		);
		assert.deepStrictEqual(atThreshold.reminders, ['batch-parallel-guidance']);

		const belowThreshold = classifyGuardrailStreak(
			guardrailInput({ singleToolStreak: 3 }),
			GUARDRAIL_LIMITS,
		);
		assert.deepStrictEqual(belowThreshold.reminders, []);
	});

	test('文本搜索硬上限是编译期常量，不得回退为运行时推导函数', () => {
		// 原 `deriveTextSearchHardLimit(soft, override?)` 已于 2026-09-17 删除：
		// 它服务的 `host.constructor.MAX_TEXT_SEARCH_STREAK_HARD` override 在任何
		// 宿主上都不存在，恒走 `* 2` 分支。现固化为常量，本测试守护三件事。
		assert.strictEqual(
			MAX_TEXT_SEARCH_STREAK_HARD,
			MAX_TEXT_SEARCH_STREAK * 2,
			'硬上限必须保持软上限的 2 倍 —— 这是删除推导函数时固化的既有行为',
		);

		const gateSource = stripComments(readModuleSource('common/turnStopGate.ts'));
		assert.ok(
			!/deriveTextSearchHardLimit/.test(gateSource),
			'deriveTextSearchHardLimit 不得重新引入：运行时推导会让缺失 override 退化为 undefined 而静默关闭护栏',
		);

		const executorSource = stripComments(readModuleSource('browser/agentTurnExecutor.ts'));
		assert.ok(
			/_textSearchStreak\s*>=\s*MAX_TEXT_SEARCH_STREAK_HARD/.test(executorSource),
			'生产侧必须直接与 MAX_TEXT_SEARCH_STREAK_HARD 常量比较，不得改回 host.constructor 反查或推导函数',
		);
	});
});

suite('turnStopGate — 零进展空转连击（classifyAllBlockedStreak）', () => {

	const ALL_BLOCKED_LIMITS = { reminderAfter: 2, wrapUpAfter: 4 };

	test('首次被拦（streak=1）→ 仅回填 tool result，不提醒不收尾', () => {
		const result = classifyAllBlockedStreak(1, false, ALL_BLOCKED_LIMITS);
		assert.strictEqual(result.decision.kind, 'continue');
		assert.deepStrictEqual(result.reminders, [], 'streak=1 要给模型自纠机会');
	});

	test('达提醒阈值 → 注入一次强提醒', () => {
		const result = classifyAllBlockedStreak(2, false, ALL_BLOCKED_LIMITS);
		assert.strictEqual(result.decision.kind, 'continue');
		assert.deepStrictEqual(result.reminders, ['all-blocked-strong']);
	});

	test('强提醒已发过 → 不重复注入（反复注入会污染前缀缓存）', () => {
		const result = classifyAllBlockedStreak(3, true, ALL_BLOCKED_LIMITS);
		assert.strictEqual(result.decision.kind, 'continue');
		assert.deepStrictEqual(result.reminders, []);
	});

	test('达收尾阈值 → wrap-up(all-blocked)，且不叠加软提醒', () => {
		const result = classifyAllBlockedStreak(4, false, ALL_BLOCKED_LIMITS);
		assert.strictEqual(result.decision.kind, 'wrap-up');
		assert.strictEqual(
			result.decision.kind === 'wrap-up' && result.decision.reason,
			'all-blocked-streak',
		);
		assert.strictEqual(
			result.decision.kind === 'wrap-up' && result.decision.hint,
			'all-blocked',
			'hint 必须是 all-blocked —— 撞迭代上限的文案会误导模型以为跑过有效轮',
		);
		assert.deepStrictEqual(
			result.reminders,
			[],
			'收尾档与软提醒文案自相矛盾（一个说继续换思路，一个说工具已禁用）',
		);
	});

	test('收尾档优先于 reminderSent=false —— 超过上限仍判 wrap-up', () => {
		const result = classifyAllBlockedStreak(9, false, ALL_BLOCKED_LIMITS);
		assert.strictEqual(result.decision.kind, 'wrap-up');
	});
});

suite('turnStopGate — ping-pong 裁决（classifyPingPong）', () => {

	test('未命中模式 → none', () => {
		assert.deepStrictEqual(classifyPingPong(false, false), { kind: 'none' });
		assert.deepStrictEqual(
			classifyPingPong(false, true),
			{ kind: 'none' },
			'noProgressEvidence 单独不足以判定 —— 必须先命中 ping-pong 模式',
		);
	});

	test('命中模式但结果仍在变化 → 放行（仅告警）', () => {
		assert.deepStrictEqual(
			classifyPingPong(true, false),
			{ kind: 'allow-changing' },
			'翻页/逐文件读会呈 A-B-A-B 但确在推进，拦掉会误伤',
		);
	});

	test('命中模式且两侧结果稳定 → 拦整批', () => {
		assert.deepStrictEqual(classifyPingPong(true, true), { kind: 'block-batch' });
	});
});
