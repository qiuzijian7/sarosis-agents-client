/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `ContextManager` 压缩触发门控契约测试（真实导入）。
 *
 * 被测：`willAttemptCompression`（contextManager.ts:1968）与其唯一真源
 * `_evaluateTrigger`（:1994）。两者共用同一判据是本模块的核心设计承诺
 * ——:1991 的注释明确写着「本仓已有多次『两处各写一份判定，改了一处忘另一处』
 * 的事故记录」，因此这里既测行为，也测**两条入口不漂移**。
 *
 * 目标覆盖 `skipReason` 三分支（:2003 / :2058-2062），这是历史上真实出过
 * 事故的地方：日志 1787286581849 记录 12 轮全部 `below_token_threshold`
 * 却每轮都发 compressing 事件，用户误以为在频繁压缩。
 *
 * 运行方式（自仓库根）：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *     src/vs/sessions/contrib/agentStudio/test/browser/contextTriggerGate.test.ts
 */

import assert from 'assert';

import { ContextManager } from '../../common/contextManager.js';

/** 被测实现只读 config / 调 _estimateTokens，不触碰 provider——给出最小替身即可。 */
function makeManager(config?: Record<string, unknown>): ContextManager {
	return new ContextManager({} as any, 'test-model', config as any);
}

/** 造 n 条消息；内容固定，使 _estimateTokens 的结果可预期且稳定。 */
function makeMessages(count: number): Array<{ role: string; content: string }> {
	return Array.from({ length: count }, (_, i) => ({
		role: i % 2 === 0 ? 'user' : 'assistant',
		content: `message-${i} `.repeat(20),
	}));
}

const CONFIG = { minMessagesToCompress: 10, compressionThreshold: 0.3 };

suite('ContextManager 压缩触发门控', () => {

	test('消息数不足且 token 不足：skipReason 为组合原因（不是单个原因）', () => {
		const cm = makeManager(CONFIG);
		const messages = makeMessages(3);

		// 断言必须落到 _evaluateTrigger 的返回值上——willAttemptCompression 只回 bool，
		// 会把「token 不足」「消息数不足」「两者都不足」压成同一个 false（弱断言）。
		const trigger = (cm as any)._evaluateTrigger(
			messages, { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any,
			undefined, undefined, undefined, undefined,
		);

		assert.strictEqual(trigger.shouldCompress, false, '3 条消息 + 小 token 不得触发压缩');
		assert.strictEqual(
			trigger.skipReason, 'below_token_threshold_and_message_min',
			'两个条件同时不满足时必须回组合原因，而非任取其一',
		);
		assert.strictEqual(trigger.hasRealUsage, false, '未传 realPromptTokens 时不应声称有真实用量');
	});

	test('token 达标但消息数不足：skipReason 为 below_message_min', () => {
		const cm = makeManager(CONFIG);

		const trigger = (cm as any)._evaluateTrigger(
			makeMessages(3), { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any,
			200000, 100000, undefined, undefined,
		);

		assert.strictEqual(trigger.shouldCompress, false, '消息数低于下限仍应被硬地板挡住');
		assert.strictEqual(trigger.skipReason, 'below_message_min', 'token 已达标，原因应只剩消息数');
		assert.strictEqual(trigger.hasRealUsage, true, 'realPromptTokens=100000 应被认作真实用量');
		assert.strictEqual(trigger.effectiveTokens, 100000, '有真实用量时应以真实值作判据');
	});

	test('消息数达标但 token 不足：skipReason 为 below_token_threshold', () => {
		const cm = makeManager(CONFIG);

		const trigger = (cm as any)._evaluateTrigger(
			makeMessages(30), { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any,
			undefined, 100, undefined, undefined,
		);

		assert.strictEqual(trigger.shouldCompress, false, 'token 远低于阈值应 skip');
		assert.strictEqual(
			trigger.skipReason, 'below_token_threshold',
			'这正是事故日志 1787286581849 中的原因码，不得被其它分支吞掉',
		);
	});

	test('无真实用量时 effectiveTokens 含 toolsSchema 估算（避免 60+ 工具定义被低估）', () => {
		const cm = makeManager(CONFIG);
		const messages = makeMessages(3);
		const toolsSchemaTokens = 5000;

		const without = (cm as any)._evaluateTrigger(
			messages, { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any,
			undefined, undefined, undefined, undefined,
		);
		const withTools = (cm as any)._evaluateTrigger(
			messages, { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any,
			undefined, undefined, toolsSchemaTokens, undefined,
		);

		assert.strictEqual(
			withTools.effectiveTokens,
			without.estimatedTokens + toolsSchemaTokens,
			'无真实用量时 effectiveTokens = est + toolsSchema（判据必须含固定开销）',
		);
		assert.strictEqual(withTools.toolsSchemaTokens, 5000, '应回带归一化后的 toolsSchemaTokens');
	});

	test('有真实用量时忽略 toolsSchema：直接采用 provider 返回值', () => {
		const cm = makeManager(CONFIG);

		const trigger = (cm as any)._evaluateTrigger(
			makeMessages(3), { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any,
			200000, 50000, 9999, undefined,
		);

		assert.strictEqual(
			trigger.effectiveTokens, 50000,
			'有真实 usage 时不得再加 toolsSchema 估算，否则重复计入',
		);
	});

	test('高水位豁免：token 逼近窗口时即使消息数/阈值不达标也强制压缩', () => {
		const cm = makeManager(CONFIG);
		// 窗口 200000（未触顶），高水位线 = 200000 × 0.8 = 160000。
		// 消息数 3 < 下限 10，本应被 below_message_min 挡住。
		const trigger = (cm as any)._evaluateTrigger(
			makeMessages(3), { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any,
			200000, 170000, undefined, undefined,
		);

		assert.strictEqual(trigger.highPressure, true, '170000 >= 160000 应判为高水位');
		assert.strictEqual(
			trigger.shouldCompress, true,
			'高水位必须豁免消息数下限（防"消息少但已逼近窗口"的早溢，见 hy3-ioa 107% 事故）',
		);
		assert.strictEqual(trigger.skipReason, undefined, '强制触发时不得带 skipReason');
	});

	test('高水位线本身是边界：恰好 0.8 算高水位，略低则退回防抖门', () => {
		const cm = makeManager(CONFIG);
		const config = { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any;

		const atLine = (cm as any)._evaluateTrigger(
			makeMessages(3), config, 200000, 160000, undefined, undefined,
		);
		const belowLine = (cm as any)._evaluateTrigger(
			makeMessages(3), config, 200000, 159999, undefined, undefined,
		);

		assert.strictEqual(atLine.highPressure, true, '>= 高水位线（含等号）应判为高水位');
		assert.strictEqual(belowLine.highPressure, false, '略低于高水位线不应判为高水位');
		assert.strictEqual(
			belowLine.shouldCompress, false,
			'跌破高水位后应退回常规门（消息数 3 < 10 → skip）',
		);
	});

	test('force 门：force=true 且消息数>=2 时跳过触发门', () => {
		const cm = makeManager(CONFIG);
		const config = { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any;

		const forced = (cm as any)._evaluateTrigger(
			makeMessages(3), config, undefined, undefined, undefined, true,
		);

		assert.strictEqual(forced.skipTriggerGate, true, 'force=true 且 messages>=2 应置位 skipTriggerGate');
		assert.strictEqual(forced.shouldCompress, true, 'force 应穿透 token/消息数双门');
	});

	test('force 门有下界：force=true 但消息数 < 2 时不生效', () => {
		const cm = makeManager(CONFIG);
		const config = { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any;

		const oneMessage = (cm as any)._evaluateTrigger(
			makeMessages(1), config, undefined, undefined, undefined, true,
		);
		const empty = (cm as any)._evaluateTrigger(
			[], config, undefined, undefined, undefined, true,
		);

		assert.strictEqual(oneMessage.skipTriggerGate, false, '1 条消息不满足 force 下界');
		assert.strictEqual(oneMessage.shouldCompress, false, 'force 不得绕过下界去压缩 1 条消息');
		assert.strictEqual(empty.shouldCompress, false, '空消息数组即便 force 也不得压缩');
	});

	test('force 不豁免高水位之外——force 与高水位独立成立，不互相抵消', () => {
		const cm = makeManager(CONFIG);
		const config = { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any;

		const forcedHighPressure = (cm as any)._evaluateTrigger(
			makeMessages(3), config, 200000, 170000, undefined, true,
		);

		assert.strictEqual(forcedHighPressure.shouldCompress, true);
		assert.strictEqual(forcedHighPressure.highPressure, true, '两个条件可同时为真');
		assert.strictEqual(forcedHighPressure.skipTriggerGate, true);
	});

	test('willAttemptCompression 与 _evaluateTrigger 同源：不得漂移', () => {
		const cm = makeManager(CONFIG);
		const config = { ...CONFIG, maxRecentMessages: 20, summaryModelId: 'm' } as any;

		// 覆盖「应当压缩」「被 token 门挡」「被消息数门挡」「force 穿透」四种输入，
		// 逐一比对公开入口与真源布尔值。
		const cases: Array<[any[], any, number | undefined, number | undefined, number | undefined, boolean | undefined]> = [
			[makeMessages(30), undefined, 200000, 100000, undefined, undefined],
			[makeMessages(30), undefined, undefined, 100, undefined, undefined],
			[makeMessages(3), undefined, 200000, 100000, undefined, undefined],
			[makeMessages(3), undefined, undefined, undefined, undefined, true],
			[makeMessages(3), undefined, 200000, 170000, undefined, undefined],
		];

		for (const [messages, , contextWindow, realPromptTokens, toolsSchemaTokens, force] of cases) {
			const viaPublic = cm.willAttemptCompression(
				messages as any, config, contextWindow, realPromptTokens, toolsSchemaTokens, force,
			);
			const viaSource = (cm as any)._evaluateTrigger(
				messages, config, contextWindow, realPromptTokens, toolsSchemaTokens, force,
			).shouldCompress;

			assert.strictEqual(
				viaPublic, viaSource,
				`公开门控与真源判定漂移：window=${contextWindow} real=${realPromptTokens} force=${force}`,
			);
		}
	});

	test('resolveEffectiveWindow：硬地板 64000、硬顶 200000、阈值 = 窗口 × 比例', () => {
		const floor = ContextManager.resolveEffectiveWindow(1000, 0.3);
		assert.strictEqual(floor.effectiveWindow, 64000, '低于 64000 的窗口应抬到硬地板');
		assert.strictEqual(floor.thresholdTokens, 64000 * 0.3, '阈值随生效窗口重算');

		const ceiling = ContextManager.resolveEffectiveWindow(1000000, 0.3);
		assert.strictEqual(ceiling.effectiveWindow, 200000, '超过 200000 的窗口应压到硬顶');

		const normal = ContextManager.resolveEffectiveWindow(128000, 0.3);
		assert.strictEqual(normal.effectiveWindow, 128000, '区间内应原样保留');
		assert.strictEqual(normal.thresholdTokens, 128000 * 0.3, '128k 模型阈值应按比例得出');

		const undef = ContextManager.resolveEffectiveWindow(undefined, 0.3);
		assert.strictEqual(undef.effectiveWindow, 64000, '未提供窗口应退化为硬地板');
	});

	test('getTriggerWindowBudget 使用实例 config 的比例（与判定同源）', () => {
		const cm = makeManager({ minMessagesToCompress: 10, compressionThreshold: 0.5 });

		const budget = cm.getTriggerWindowBudget(128000);

		assert.strictEqual(budget.effectiveWindow, 128000);
		assert.strictEqual(
			budget.thresholdTokens, 128000 * 0.5,
			'诊断日志用的预算必须取实例 config 的真实比例，否则日志与实际触发时机对不上',
		);
	});
});
