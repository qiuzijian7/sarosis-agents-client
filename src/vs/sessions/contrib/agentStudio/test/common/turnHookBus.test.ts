/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { suite, test } from 'node:test';
import {
	TurnHookBus,
	TurnHookGateError,
	isFailClosedHook,
} from '../../common/turnHookBus.js';

/**
 * 钩子总线测试。
 *
 * 关注点是**聚合语义**而非单个 handler 的行为：多 handler 注册时谁的结果生效、
 * handler 抛错时 turn 是被打断还是继续、fail-closed 与 best-effort 的边界在哪。
 * 这些语义一旦漂移，权限判定与终止判定都会静默失效，因此逐条独立断言。
 */

suite('TurnHookBus - 注册与分发', () => {
	test('未注册 handler 时 runWithGate 返回 undefined', async () => {
		const bus = new TurnHookBus();
		const result = await bus.runWithGate('before_run', { requestId: 'r1' });
		assert.strictEqual(result, undefined);
	});

	test('handler 按注册顺序依次收到同一 event', async () => {
		const bus = new TurnHookBus();
		const observed: string[] = [];
		bus.register('before_run', async () => { observed.push('first'); });
		bus.register('before_run', async () => { observed.push('second'); });

		await bus.runWithGate('before_run', { requestId: 'r1' });

		assert.deepStrictEqual(observed, ['first', 'second']);
	});

	test('register 返回的取消函数只摘掉自己那一个 handler', async () => {
		const bus = new TurnHookBus();
		const observed: string[] = [];
		const disposeFirst = bus.register('before_run', async () => { observed.push('first'); });
		bus.register('before_run', async () => { observed.push('second'); });

		disposeFirst();
		await bus.runWithGate('before_run', { requestId: 'r1' });

		assert.deepStrictEqual(observed, ['second'], '仅剩第二个 handler 生效');
	});

	test('不同钩子名之间互不串台', async () => {
		const bus = new TurnHookBus();
		let beforeRunCalls = 0;
		let afterResponseCalls = 0;
		bus.register('before_run', async () => { beforeRunCalls++; });
		bus.register('after_response', async () => { afterResponseCalls++; });

		await bus.runWithGate('before_run', { requestId: 'r1' });

		assert.strictEqual(beforeRunCalls, 1);
		assert.strictEqual(afterResponseCalls, 0, 'after_response 不应被 before_run 触发');
	});
});

suite('TurnHookBus - fail-closed 边界', () => {
	test('isFailClosedHook 仅对 before_tool 为真', () => {
		assert.strictEqual(isFailClosedHook('before_tool'), true);
		assert.strictEqual(isFailClosedHook('before_run'), false);
		assert.strictEqual(isFailClosedHook('after_tool'), false);
		assert.strictEqual(isFailClosedHook('transform_context'), false);
		assert.strictEqual(isFailClosedHook('before_request'), false);
		assert.strictEqual(isFailClosedHook('after_response'), false);
		assert.strictEqual(isFailClosedHook('before_run_end'), false);
	});

	test('before_tool 的 handler 抛错 → 抛出 TurnHookGateError（fail-closed）', async () => {
		const bus = new TurnHookBus();
		bus.register('before_tool', async () => { throw new Error('权限服务不可用'); });

		await assert.rejects(
			() => bus.runWithGate('before_tool', { toolName: 'file_write', toolCallId: 'tc1', args: {} }),
			(err: unknown) => {
				assert.ok(err instanceof TurnHookGateError, '应为 TurnHookGateError');
				assert.strictEqual((err as TurnHookGateError).hookName, 'before_tool');
				assert.match((err as TurnHookGateError).message, /权限服务不可用/);
				return true;
			},
		);
	});

	test('before_tool 抛错时后续 handler 不再执行（短路）', async () => {
		const bus = new TurnHookBus();
		let secondCalled = false;
		bus.register('before_tool', async () => { throw new Error('boom'); });
		bus.register('before_tool', async () => { secondCalled = true; });

		await assert.rejects(() => bus.runWithGate('before_tool', { toolName: 't', toolCallId: 'c', args: {} }));

		assert.strictEqual(secondCalled, false, 'fail-closed 必须短路');
	});

	test('best-effort 钩子的 handler 抛错被吞掉，turn 继续', async () => {
		const bus = new TurnHookBus();
		bus.register('before_run', async () => { throw new Error('观测钩子炸了'); });

		const result = await bus.runWithGate('before_run', { requestId: 'r1' });

		assert.strictEqual(result, undefined, '异常被吞，返回 undefined 而非抛出');
	});

	test('best-effort 钩子中一个 handler 抛错不影响其余 handler', async () => {
		const bus = new TurnHookBus();
		let secondCalled = false;
		bus.register('before_run', async () => { throw new Error('boom'); });
		bus.register('before_run', async () => { secondCalled = true; });

		await bus.runWithGate('before_run', { requestId: 'r1' });

		assert.strictEqual(secondCalled, true, 'best-effort 不短路');
	});

	test('被吞掉的异常上报给 errorReporter', async () => {
		const reported: Array<{ hookName: string; message: string }> = [];
		const bus = new TurnHookBus((hookName, error) => {
			reported.push({ hookName, message: error instanceof Error ? error.message : String(error) });
		});
		bus.register('after_tool', async () => { throw new Error('记账失败'); });

		await bus.runWithGate('after_tool', { toolName: 't', toolCallId: 'c', content: undefined, isError: false });

		assert.strictEqual(reported.length, 1);
		assert.strictEqual(reported[0].hookName, 'after_tool');
		assert.match(reported[0].message, /记账失败/);
	});
});

suite('TurnHookBus - before_tool 拦截聚合（block 优先于 args 改写）', () => {
	test('全部放行 → 返回 undefined（无声明即放行、不改参）', async () => {
		const bus = new TurnHookBus();
		bus.register('before_tool', async () => undefined);
		bus.register('before_tool', async () => undefined);

		const result = await bus.runWithGate('before_tool', { toolName: 'file_read', toolCallId: 'c', args: {} });

		assert.strictEqual(result, undefined);
	});

	test('单个 block 生效并带出原因', async () => {
		const bus = new TurnHookBus();
		bus.register('before_tool', async () => ({ block: { reason: '超出沙箱' } }));

		const result = await bus.runWithGate('before_tool', { toolName: 'file_write', toolCallId: 'c', args: {} });

		assert.strictEqual(result?.block?.reason, '超出沙箱');
	});

	test('block 优先于 args 改写（与注册顺序无关）', async () => {
		const blockLast = new TurnHookBus();
		blockLast.register('before_tool', async () => ({ args: { path: 'rewritten' } }));
		blockLast.register('before_tool', async () => ({ block: { reason: '禁止' } }));
		const blockLastResult = await blockLast.runWithGate('before_tool', { toolName: 't', toolCallId: 'c', args: {} });
		assert.strictEqual(blockLastResult?.block?.reason, '禁止', '后注册的 block 必须压过前面的改参');
		assert.strictEqual(blockLastResult?.args, undefined, '被拦截时不应再返回改写参数');

		const blockFirst = new TurnHookBus();
		blockFirst.register('before_tool', async () => ({ block: { reason: '禁止' } }));
		blockFirst.register('before_tool', async () => ({ args: { path: 'rewritten' } }));
		const blockFirstResult = await blockFirst.runWithGate('before_tool', { toolName: 't', toolCallId: 'c', args: {} });
		assert.strictEqual(blockFirstResult?.block?.reason, '禁止', '先注册的 block 不应被改参降级');
	});

	test('block 可携带 terminate（整批终止信号）', async () => {
		const bus = new TurnHookBus();
		bus.register('before_tool', async () => ({ block: { reason: '致命违规', terminate: true } }));

		const result = await bus.runWithGate('before_tool', { toolName: 't', toolCallId: 'c', args: {} });

		assert.strictEqual(result?.block?.terminate, true);
	});

	test('无 block 时最后一个非空 args 生效', async () => {
		const bus = new TurnHookBus();
		bus.register('before_tool', async () => ({ args: { path: 'first' } }));
		bus.register('before_tool', async () => undefined);
		bus.register('before_tool', async () => ({ args: { path: 'last' } }));

		const result = await bus.runWithGate('before_tool', { toolName: 't', toolCallId: 'c', args: {} });

		assert.deepStrictEqual(result?.args, { path: 'last' });
	});
});

suite('TurnHookBus - transform_context 链式改写', () => {
	test('单 handler 的 messages 改写生效', async () => {
		const bus = new TurnHookBus();
		bus.register('transform_context', async event => ({
			messages: [...event.messages, { role: 'system', content: 'injected' }],
		}));

		const result = await bus.runWithGate('transform_context', {
			messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys',
		});

		assert.strictEqual(result?.messages.length, 2);
		assert.strictEqual(result?.messages[1].content, 'injected');
	});

	test('多 handler 串联：后者看到前者的输出', async () => {
		const bus = new TurnHookBus();
		bus.register('transform_context', async event => ({
			messages: [...event.messages, { role: 'system', content: 'first' }],
		}));
		bus.register('transform_context', async event => {
			assert.strictEqual(
				event.messages[event.messages.length - 1].content,
				'first',
				'第二个 handler 应看到第一个的改写结果',
			);
			return { messages: [...event.messages, { role: 'system', content: 'second' }] };
		});

		const result = await bus.runWithGate('transform_context', {
			messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys',
		});

		assert.deepStrictEqual(
			result?.messages.map(m => m.content),
			['hi', 'first', 'second'],
		);
	});

	test('handler 返回 undefined 视为不改写，链条继续', async () => {
		const bus = new TurnHookBus();
		bus.register('transform_context', async () => undefined);
		bus.register('transform_context', async event => ({
			messages: [...event.messages, { role: 'system', content: 'tail' }],
		}));

		const result = await bus.runWithGate('transform_context', {
			messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys',
		});

		assert.deepStrictEqual(result?.messages.map(m => m.content), ['hi', 'tail']);
	});

	test('transform_context 的 handler 抛错 → 保留已有改写，不打断 turn', async () => {
		const bus = new TurnHookBus();
		bus.register('transform_context', async event => ({
			messages: [...event.messages, { role: 'system', content: 'survived' }],
		}));
		bus.register('transform_context', async () => { throw new Error('boom'); });

		const result = await bus.runWithGate('transform_context', {
			messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys',
		});

		assert.deepStrictEqual(
			result?.messages.map(m => m.content),
			['hi', 'survived'],
			'抛错 handler 之前的改写必须保留',
		);
	});
});

suite('TurnHookBus - before_run_end 续跑聚合', () => {
	test('无 handler 返回 followUp → undefined（正常收尾）', async () => {
		const bus = new TurnHookBus();
		bus.register('before_run_end', async () => undefined);

		const result = await bus.runWithGate('before_run_end', { iteration: 3, hasPendingWork: false });

		assert.strictEqual(result, undefined);
	});

	test('单 handler 的 followUp 触发续跑', async () => {
		const bus = new TurnHookBus();
		bus.register('before_run_end', async () => ({ followUp: '继续下一个任务' }));

		const result = await bus.runWithGate('before_run_end', { iteration: 3, hasPendingWork: false });

		assert.strictEqual(result?.followUp, '继续下一个任务');
	});

	test('多 handler 时最后一个非空 followUp 生效', async () => {
		const bus = new TurnHookBus();
		bus.register('before_run_end', async () => ({ followUp: 'first' }));
		bus.register('before_run_end', async () => undefined);
		bus.register('before_run_end', async () => ({ followUp: 'last' }));

		const result = await bus.runWithGate('before_run_end', { iteration: 3, hasPendingWork: false });

		assert.strictEqual(result?.followUp, 'last', '后注册者覆盖前者');
	});

	test('末位 handler 返回 undefined 不清掉前面的 followUp', async () => {
		const bus = new TurnHookBus();
		bus.register('before_run_end', async () => ({ followUp: 'keep' }));
		bus.register('before_run_end', async () => undefined);

		const result = await bus.runWithGate('before_run_end', { iteration: 3, hasPendingWork: false });

		assert.strictEqual(result?.followUp, 'keep');
	});
});
