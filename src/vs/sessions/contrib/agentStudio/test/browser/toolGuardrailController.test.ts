/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ToolGuardrailController 行为回归（2026-09-13）。
 *
 * ## 为什么需要这个文件
 *
 * 此前 `ToolGuardrailController` 只有「接线」层的源码级断言
 * （`guardrailWiring.test.ts`），**没有任何行为级单测** —— 于是下面这个缺陷
 * 潜伏了很久：控制器本身实现正确（halt 分支、豁免名单、阈值判定全都在），
 * 但**主循环调用它时把阈值写成了 `Number.MAX_SAFE_INTEGER`**，并且
 * `afterCall()` 返回的 halt 只被用来打日志、没有置位收尾轮。结果是
 * 「same_tool_failure 检出却不生效」，模型可无限反复试探同一工具。
 *
 * 单测无法覆盖「调用方怎么传参」，但可以钉死两件回归：
 *   1. 阈值语义：达到 `sameToolFailureHaltAfter` 时必须返回 halt；
 *   2. 豁免语义：失败容忍工具（terminal/execute_code）**永不**触发 halt，
 *      但仍参与 exact_failure 判定（一字不改地重复失败依然该拦）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-all-browser-tests.mjs
 */

import assert from 'assert';
import {
	DEFAULT_GUARDRAIL_CONFIG,
	FAILURE_TOLERANT_TOOL_NAMES,
	ToolGuardrailController,
} from '../../browser/toolGuardrailController.js';

suite('ToolGuardrailController — 失败护栏行为', () => {

	test('★ 同名工具失败达到 sameToolFailureHaltAfter 时返回 halt', () => {
		const ctrl = new ToolGuardrailController();
		const limit = ctrl.config.sameToolFailureHaltAfter;
		assert.ok(Number.isFinite(limit), '默认阈值必须是有限值（曾被 MAX_SAFE_INTEGER 屏蔽）');

		let last = ctrl.afterCall('file_read', { path: '/a' }, 'boom', { failed: true });
		for (let i = 2; i <= limit; i++) {
			last = ctrl.afterCall('file_read', { path: `/a${i}` }, 'boom', { failed: true });
		}
		assert.strictEqual(last.action, 'halt', `第 ${limit} 次同名失败应 halt，实际 ${last.action}`);
		assert.strictEqual(last.code, 'same_tool_failure_halt');
	});

	test('★ 默认配置的 halt 阈值是有限值（回归：不得退回 MAX_SAFE_INTEGER）', () => {
		assert.ok(
			DEFAULT_GUARDRAIL_CONFIG.sameToolFailureHaltAfter < Number.MAX_SAFE_INTEGER,
			'sameToolFailureHaltAfter 被写成 MAX_SAFE_INTEGER 会让 halt 永不触发',
		);
		assert.ok(
			DEFAULT_GUARDRAIL_CONFIG.exactFailureBlockAfter < Number.MAX_SAFE_INTEGER,
			'exactFailureBlockAfter 被写成 MAX_SAFE_INTEGER 会让 block 永不触发',
		);
	});

	test('★★ 失败容忍工具（terminal）即使连续失败超阈值也不 halt', () => {
		assert.ok(FAILURE_TOLERANT_TOOL_NAMES.has('terminal'), 'terminal 应在豁免名单内');
		const ctrl = new ToolGuardrailController({
			// 把阈值压到 2，避免测试里堆循环；语义与默认值一致。
			sameToolFailureHaltAfter: 2,
			sameToolFailureWarnAfter: 1,
		});

		let last = ctrl.afterCall('terminal', { command: 'a' }, 'cmd not found', { failed: true });
		for (let i = 0; i < 5; i++) {
			last = ctrl.afterCall('terminal', { command: `a${i}` }, 'cmd not found', { failed: true });
		}
		assert.notStrictEqual(last.action, 'halt', 'terminal 的失败是调试常态，不应被 halt 打断');
	});

	test('★★ 豁免只针对 halt：terminal 一字不改地失败仍需 exact_failure block', () => {
		const ctrl = new ToolGuardrailController({
			exactFailureBlockAfter: 2,
			sameToolFailureHaltAfter: 999,
		});
		const sameArgs = { command: 'same-command --flag' };

		ctrl.afterCall('terminal', sameArgs, 'boom', { failed: true });
		ctrl.afterCall('terminal', sameArgs, 'boom', { failed: true });
		const decision = ctrl.beforeCall('terminal', sameArgs);

		assert.strictEqual(decision.action, 'block', '同签名同参反复失败仍应被 block');
		assert.strictEqual(decision.code, 'repeated_exact_failure_block');
	});

	test('成功后计数清零：失败→成功→再失败不应累计到 halt', () => {
		const ctrl = new ToolGuardrailController({ sameToolFailureHaltAfter: 3, sameToolFailureWarnAfter: 2 });

		ctrl.afterCall('file_read', { path: '/a' }, 'boom', { failed: true });
		ctrl.afterCall('file_read', { path: '/b' }, 'boom', { failed: true });
		ctrl.afterCall('file_read', { path: '/c' }, 'ok', { failed: false });   // 成功 → 清零
		const last = ctrl.afterCall('file_read', { path: '/d' }, 'boom', { failed: true });

		assert.notStrictEqual(last.action, 'halt', '成功调用后计数应清零，不该在第 4 次失败时 halt');
	});

	test('resetForTurn 清空跨轮计数', () => {
		const ctrl = new ToolGuardrailController({ sameToolFailureHaltAfter: 2 });
		ctrl.afterCall('file_read', { path: '/a' }, 'boom', { failed: true });
		ctrl.resetForTurn();
		const last = ctrl.afterCall('file_read', { path: '/b' }, 'boom', { failed: true });
		assert.notStrictEqual(last.action, 'halt', 'resetForTurn 后计数应从零开始');
	});
});
