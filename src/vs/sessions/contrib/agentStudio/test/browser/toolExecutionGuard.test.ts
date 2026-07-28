/*---------------------------------------------------------------------------------------------
 *  toolExecutionGuard.test.ts
 *
 *  2026-07-25 线上事故回归：delegate_task 被 60s 默认工具超时 abort（子代理批次
 *  全部 exitReason=interrupted），且 retryable=true 触发整批重跑（两个连续 60s
 *  失败 = 首次超时 + 一次重试）。修复：编排类工具 630s 超时 + 禁止工具级重试。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DELEGATION_TOOL_TIMEOUT_MS,
	DEFAULT_TOOL_TIMEOUT_MS,
	MCP_TOOL_TIMEOUT_MS,
	executeWithRetryAndTimeout,
	getTimeoutForTool,
} from '../../browser/toolExecutionGuard.js';

/** 永远返回 retryable 失败的 mock provider（模拟超时中断）。 */
function makeFailingProvider(calls: string[]) {
	return {
		id: 'mock',
		listTools: async () => [{ name: 'delegate_task' }, { name: 'file_read' }] as any,
		executeTool: async (_agentId: string, toolCall: any) => {
			calls.push(toolCall.name);
			return {
				toolCallId: toolCall.id,
				success: false,
				error: 'Tool execution timed out after 60000ms',
				content: [{ type: 'text', text: '[Timeout]' }],
				metadata: { timedOut: true, retryable: true },
			} as any;
		},
	} as any;
}

/** 永远成功的 mock provider。 */
function makeOkProvider(calls: string[]) {
	return {
		id: 'mock',
		listTools: async () => [{ name: 'delegate_task' }] as any,
		executeTool: async (_agentId: string, toolCall: any) => {
			calls.push(toolCall.name);
			return { toolCallId: toolCall.id, success: true, content: 'done', metadata: {} } as any;
		},
	} as any;
}

suite('toolExecutionGuard', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('getTimeoutForTool — 编排类工具', () => {

		test('delegate_task → 0（禁用守卫 wall-clock 超时，活性由子代理看门狗判定）', () => {
			// 2026-07-26 重构（事故 1785053998262：630s 固定帽砍死 34 迭代健康子代理）。
			// 现行模型：子代理不限轮数/不限总时长，180s 内容停滞看门狗兜底。
			assert.strictEqual(DELEGATION_TOOL_TIMEOUT_MS, 0);
			assert.strictEqual(getTimeoutForTool('delegate_task'), DELEGATION_TOOL_TIMEOUT_MS);
			assert.strictEqual(getTimeoutForTool('plan_explore'), DELEGATION_TOOL_TIMEOUT_MS);
			assert.strictEqual(getTimeoutForTool('subagent_batch'), DELEGATION_TOOL_TIMEOUT_MS);
		});

		test('普通工具不受影响', () => {
			assert.strictEqual(getTimeoutForTool('file_read'), DEFAULT_TOOL_TIMEOUT_MS);
			assert.strictEqual(getTimeoutForTool('search_graph'), 30_000);
			assert.strictEqual(getTimeoutForTool('terminal'), MCP_TOOL_TIMEOUT_MS);
		});
	});

	suite('executeWithTimeout — 编排类工具无 wall-clock 帽', () => {

		test('timeoutMs=0 时不会被守卫中止（超过旧 630s 语义也照常完成）', async () => {
			const calls: string[] = [];
			const provider = {
				id: 'mock',
				listTools: async () => [{ name: 'delegate_task' }] as any,
				executeTool: async (_agentId: string, toolCall: any) => {
					calls.push(toolCall.name);
					// 模拟长任务：若守卫设了计时器（即使 50ms），此 80ms 执行会被 abort。
					await new Promise(r => setTimeout(r, 80));
					return { toolCallId: toolCall.id, success: true, content: 'done', metadata: {} } as any;
				},
			} as any;
			const result = await executeWithRetryAndTimeout(provider, 'agent-1',
				{ id: 'tc-0', name: 'delegate_task', arguments: '{}' } as any,
				{ timeoutMs: 0 });
			assert.strictEqual(result.success, true, '无 wall-clock 帽时长任务应正常完成');
			assert.strictEqual(calls.length, 1);
		});
	});

	suite('executeWithRetryAndTimeout — 编排类工具禁重试', () => {

		test('delegate_task 超时失败仅执行 1 次（不整批重跑）', async () => {
			const calls: string[] = [];
			const provider = makeFailingProvider(calls);
			const result = await executeWithRetryAndTimeout(provider, 'agent-1',
				{ id: 'tc-1', name: 'delegate_task', arguments: '{}' } as any,
				{ timeoutMs: 1000 });
			assert.strictEqual(result.success, false);
			assert.strictEqual(calls.length, 1, `编排工具不得重试，实际执行 ${calls.length} 次`);
		});

		test('plan_explore 同样禁重试', async () => {
			const calls: string[] = [];
			const provider = makeFailingProvider(calls);
			await executeWithRetryAndTimeout(provider, 'agent-1',
				{ id: 'tc-2', name: 'plan_explore', arguments: '{}' } as any,
				{ timeoutMs: 1000 });
			assert.strictEqual(calls.length, 1);
		});

		test('普通工具保留默认重试（3 次）', async () => {
			const calls: string[] = [];
			const provider = makeFailingProvider(calls);
			// 缩短退避等待：注入快速 retryPolicy（保持 maxAttempts=3 语义）。
			// 注意 runWithRetry 耗尽后以 ToolRetryableError 抛出（生产侧由调用方捕获）。
			let threw = false;
			try {
				await executeWithRetryAndTimeout(provider, 'agent-1',
					{ id: 'tc-3', name: 'file_read', arguments: '{}' } as any,
					{
						timeoutMs: 1000,
						retryPolicy: { initialInterval: 1, backoffFactor: 1, maxInterval: 2, maxAttempts: 3, jitter: false, retryOn: () => true },
					});
			} catch {
				threw = true;
			}
			assert.ok(threw, '耗尽后应以 ToolRetryableError 抛出');
			assert.strictEqual(calls.length, 3, `普通工具应重试到 maxAttempts，实际 ${calls.length} 次`);
		});

		test('成功路径不受影响', async () => {
			const calls: string[] = [];
			const provider = makeOkProvider(calls);
			const result = await executeWithRetryAndTimeout(provider, 'agent-1',
				{ id: 'tc-4', name: 'delegate_task', arguments: '{}' } as any,
				{ timeoutMs: 1000 });
			assert.strictEqual(result.success, true);
			assert.strictEqual(calls.length, 1);
		});
	});
});
