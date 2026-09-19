/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `browser/turnToolExecution.ts` 的三段式骨架测试。
 *
 * 重点锁定三件事：
 *  1. prepare 阶段的**拦截顺序**（not-found → control → permission → aborted）；
 *  2. finalize 阶段 `handledSandboxIds` 的**一次性**语义（防重提示死循环）；
 *  3. 截断保护对**所有**工具调用一律报错、绝不执行。
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { suite, test } from 'node:test';
import {
	createErrorToolResult,
	failToolCallsFromTruncatedMessage,
	finalizeToolCall,
	isTruncatedByOutputLimit,
	type IToolExecutionOutcome,
	type IToolFinalizationDeps,
	type ITurnToolCall,
	type ITurnToolResult,
} from '../../browser/turnToolExecution.js';

function makeCall(name: string, id = `call-${name}`): ITurnToolCall {
	return { id, name, arguments: {} };
}

/** 去掉注释，避免删除理由注释里的标识符被误判为「代码又回来了」。 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readModuleSource(relativePath: string): string {
	const absolute = path.resolve(process.cwd(), relativePath);
	// 缺失即抛：静默 skip 会让契约断言变成永久绿灯。
	return readFileSync(absolute, 'utf8');
}

const TURN_TOOL_EXECUTION_PATH =
	'src/vs/sessions/contrib/agentStudio/browser/turnToolExecution.ts';

suite('turnToolExecution — 已删准备/执行阶段的禁止回退契约', () => {
	test('模块不得重新导出 prepareToolCall / executePreparedCall / resolveToolExecutionMode', () => {
		const source = stripComments(readModuleSource(TURN_TOOL_EXECUTION_PATH));
		for (const symbol of ['prepareToolCall', 'executePreparedCall', 'resolveToolExecutionMode']) {
			assert.ok(
				!source.includes(symbol),
				`${symbol} 已于 2026-09-17 删除（生产侧准备阶段是批次级 + 带副作用，形状不匹配）。`
				+ '若要重新引入，必须先解决 ping-pong 整批判据与 RECORD_TOOL_CALL 副作用的表达问题。',
			);
		}
	});

	test('准备阶段的类型面也不得复活', () => {
		const source = stripComments(readModuleSource(TURN_TOOL_EXECUTION_PATH));
		for (const symbol of ['ToolPreparationOutcome', 'ToolPreparationBlockReason', 'IToolPreparationDeps']) {
			assert.ok(!source.includes(symbol), `${symbol} 是已删准备阶段的类型面，不应存在。`);
		}
	});

	test('收尾阶段 finalizeToolCall 必须仍然导出（唯一保留的阶段函数）', () => {
		const source = readModuleSource(TURN_TOOL_EXECUTION_PATH);
		assert.ok(
			/export async function\* finalizeToolCall/.test(source),
			'finalizeToolCall 是三条执行路径共用的收尾面，删掉它会让沙箱确认行为重新分叉。',
		);
	});
});

suite('turnToolExecution — 收尾阶段（finalizeToolCall）', () => {
	function makeExecuted(success: boolean): IToolExecutionOutcome {
		const call = makeCall('file_write');
		return { call, result: { toolCallId: call.id, content: 'denied', success } };
	}

	/** delta 用字符串代替真实 `IChatStreamDelta`（本模块只转发、不构造）。 */
	function makeFinalDeps(
		overrides: Partial<IToolFinalizationDeps<string>> = {},
	): IToolFinalizationDeps<string> {
		return {
			isSandboxViolation: () => false,
			resolveSandbox: async function* () { return { decision: 'cancel' }; },
			...overrides,
		};
	}

	/** 驱动 generator，收集 delta 并取回返回值。 */
	async function drain(
		gen: AsyncGenerator<string, IToolExecutionOutcome, void>,
	): Promise<{ deltas: string[]; outcome: IToolExecutionOutcome }> {
		const deltas: string[] = [];
		let step = await gen.next();
		while (!step.done) {
			deltas.push(step.value);
			step = await gen.next();
		}
		return { deltas, outcome: step.value };
	}

	test('非沙箱违规 → 直通，不弹确认', async () => {
		let resolveCount = 0;
		const { deltas, outcome } = await drain(finalizeToolCall(
			makeExecuted(true),
			makeFinalDeps({
				resolveSandbox: async function* () { resolveCount++; return { decision: 'x' }; },
			}),
			new Set(),
		));
		assert.strictEqual(resolveCount, 0);
		assert.strictEqual(deltas.length, 0);
		assert.strictEqual(outcome.result.success, true);
	});

	test('沙箱违规 + 重执行成功 → 用重执行结果替换', async () => {
		const executed = makeExecuted(false);
		const { outcome } = await drain(finalizeToolCall(
			executed,
			makeFinalDeps({
				isSandboxViolation: () => true,
				resolveSandbox: async function* () {
					return {
						decision: 'allow-once',
						reExecuted: { toolCallId: executed.call.id, content: 'written', success: true },
					};
				},
			}),
			new Set(),
		));
		assert.strictEqual(outcome.result.success, true);
		assert.strictEqual(outcome.result.content, 'written');
	});

	test('沙箱违规 + 用户拒绝（无 reExecuted）→ 保留原失败结果', async () => {
		const { outcome } = await drain(finalizeToolCall(
			makeExecuted(false),
			makeFinalDeps({ isSandboxViolation: () => true }),
			new Set(),
		));
		assert.strictEqual(outcome.result.success, false);
		assert.strictEqual(outcome.result.content, 'denied');
	});

	test('resolveSandbox 的 delta 按序原样转发（确认卡片须先于决策到达 UI）', async () => {
		let awaited = false;
		const { deltas, outcome } = await drain(finalizeToolCall(
			makeExecuted(false),
			makeFinalDeps({
				isSandboxViolation: () => true,
				resolveSandbox: async function* () {
					// 卡片必须在 await 之前 yield：这正是本阶段改用 generator 的理由。
					yield 'confirmation';
					await Promise.resolve();
					awaited = true;
					yield 'confirmation_resolved';
					return { decision: 'cancel' };
				},
			}),
			new Set(),
		));
		assert.deepStrictEqual(deltas, ['confirmation', 'confirmation_resolved']);
		assert.ok(awaited);
		assert.strictEqual(outcome.result.success, false);
	});

	test('同一 toolCallId 只提示一次（防重提示死循环）', async () => {
		const handled = new Set<string>();
		let resolveCount = 0;
		const counting = makeFinalDeps({
			isSandboxViolation: () => true,
			resolveSandbox: async function* () { resolveCount++; return { decision: 'cancel' }; },
		});

		const executed = makeExecuted(false);
		await drain(finalizeToolCall(executed, counting, handled));
		await drain(finalizeToolCall(executed, counting, handled));

		assert.strictEqual(resolveCount, 1);
		assert.ok(handled.has(executed.call.id));
	});

	test('observe 对最终结果调用一次（并行/串行共用观测口）', async () => {
		const observed: ITurnToolResult[] = [];
		const executed = makeExecuted(false);
		await drain(finalizeToolCall(
			executed,
			makeFinalDeps({
				isSandboxViolation: () => true,
				resolveSandbox: async function* () {
					return {
						decision: 'allow-once',
						reExecuted: { toolCallId: executed.call.id, content: 'written', success: true },
					};
				},
				observe: (_call, result) => observed.push(result),
			}),
			new Set(),
		));
		assert.strictEqual(observed.length, 1);
		assert.strictEqual(observed[0].content, 'written');
	});
});

suite('turnToolExecution — 截断保护（pi agent-loop.ts:379-404 移植）', () => {
	test('stopReason 判据：length / max_tokens 都算截断', () => {
		assert.strictEqual(isTruncatedByOutputLimit('length'), true);
		assert.strictEqual(isTruncatedByOutputLimit('max_tokens'), true);
	});

	test('stopReason 判据：stop / tool_calls / undefined 不算截断', () => {
		assert.strictEqual(isTruncatedByOutputLimit('stop'), false);
		assert.strictEqual(isTruncatedByOutputLimit('tool_calls'), false);
		assert.strictEqual(isTruncatedByOutputLimit(undefined), false);
	});

	test('截断批次 → 每个调用都产出错误结果，一个都不执行', () => {
		const calls = [makeCall('file_write', 'a'), makeCall('terminal', 'b'), makeCall('patch', 'c')];
		const outcomes = failToolCallsFromTruncatedMessage(calls);

		assert.strictEqual(outcomes.length, 3);
		for (const [index, outcome] of outcomes.entries()) {
			assert.strictEqual(outcome.call.id, calls[index].id);
			assert.strictEqual(outcome.result.success, false);
			assert.strictEqual(outcome.result.toolCallId, calls[index].id);
			assert.ok(String(outcome.result.content).includes('output token limit'));
			assert.ok(String(outcome.result.content).includes(calls[index].name));
		}
	});

	test('空批次 → 空结果（不产生伪造的 tool_end）', () => {
		assert.deepStrictEqual(failToolCallsFromTruncatedMessage([]), []);
	});
});

suite('turnToolExecution — 错误结果构造（createErrorToolResult）', () => {
	test('toolCallId 必须回填，否则协议层配对断裂', () => {
		const call = makeCall('search_files', 'pair-me');
		const result = createErrorToolResult(call, 'boom');
		assert.strictEqual(result.toolCallId, 'pair-me');
		assert.strictEqual(result.success, false);
		assert.strictEqual(result.content, 'boom');
	});
});
