/*---------------------------------------------------------------------------------------------
 *  turnEmit 单测 —— 锁死 asGenerator 的三条语义保证（保序 / 背压 / 返回值透传）。
 *
 *  这些不是形式化用例：79 处裸 `yield` 要机械替换成 `await emit(...)`，替换的
 *  正确性完全建立在「emit 与裸 yield 行为等价」之上。等价性一旦破损，症状是
 *  UI 事件乱序或 turn 资源泄漏 —— 都属于难以从日志定位的故障。
 *---------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { suite, test } from 'node:test';
import { asGenerator, type TurnEventSink } from '../../common/turnEmit.js';
import type { IChatStreamDelta } from '../../common/providers.js';

function textDelta(content: string): IChatStreamDelta {
	return { type: 'text', content } as IChatStreamDelta;
}

/** 把生成器完整抽干，返回收到的事件与 return 值。 */
async function drain<T>(
	gen: AsyncGenerator<IChatStreamDelta, T>,
): Promise<{ deltas: IChatStreamDelta[]; returned: T }> {
	const deltas: IChatStreamDelta[] = [];
	while (true) {
		const step = await gen.next();
		if (step.done) { return { deltas, returned: step.value }; }
		deltas.push(step.value);
	}
}

suite('turnEmit — asGenerator 语义等价（替换裸 yield 的前提）', () => {

	test('保序：emit 顺序即产出顺序', async () => {
		const gen = asGenerator(async (emit) => {
			await emit(textDelta('a'));
			await emit(textDelta('b'));
			await emit(textDelta('c'));
			return 'done';
		});

		const { deltas, returned } = await drain(gen);

		assert.deepStrictEqual(
			deltas.map(d => (d as any).content), ['a', 'b', 'c'],
			'事件顺序被重排 —— 裸 yield 是严格 FIFO，emit 必须一致',
		);
		assert.strictEqual(returned, 'done');
	});

	test('背压：emit 的 Promise 在事件被消费前不得 resolve', async () => {
		/** 记录生产侧越过每个 emit 的时刻，用于和消费时刻交错比对。 */
		const trace: string[] = [];

		const gen = asGenerator(async (emit) => {
			trace.push('before-1');
			await emit(textDelta('1'));
			trace.push('after-1');
			await emit(textDelta('2'));
			trace.push('after-2');
			return undefined;
		});

		// 只取第一个事件，此时生产侧应当**仍卡在** emit(1) 上。
		const first = await gen.next();
		assert.strictEqual((first.value as any).content, '1');
		assert.deepStrictEqual(
			trace, ['before-1'],
			'emit 在事件被消费前就 resolve 了 —— 生产侧跑到了消费侧前面，' +
			'破坏「yield 之后可假设事件已送达」的既有假设',
		);

		// 取第二个事件 → 放行 emit(1)，生产侧推进到 emit(2)。
		const second = await gen.next();
		assert.strictEqual((second.value as any).content, '2');
		assert.deepStrictEqual(trace, ['before-1', 'after-1']);

		await gen.next();
		assert.deepStrictEqual(trace, ['before-1', 'after-1', 'after-2']);
	});

	test('返回值透传：run 的解析值成为 generator 的 return 值', async () => {
		const gen = asGenerator(async () => ({ kind: 'switch_agent', agentId: 'x' }));

		const { deltas, returned } = await drain(gen);

		assert.strictEqual(deltas.length, 0, '未 emit 任何事件时不应产出 delta');
		assert.deepStrictEqual(returned, { kind: 'switch_agent', agentId: 'x' });
	});

	test('run 抛错：已排队事件先送达，错误随后重抛', async () => {
		const gen = asGenerator(async (emit) => {
			await emit(textDelta('partial'));
			throw new Error('boom');
		});

		const first = await gen.next();
		assert.strictEqual((first.value as any).content, 'partial', '抛错前的事件不得丢失');

		await assert.rejects(() => gen.next(), /boom/, '错误必须重抛给消费者，不能被吞掉');
	});

	test('消费者提前退出：生产侧的 emit 等待被解除，run 不泄漏', async () => {
		let reachedEnd = false;

		const gen = asGenerator(async (emit) => {
			for (let index = 0; index < 100; index++) {
				await emit(textDelta(`item-${index}`));
			}
			reachedEnd = true;
			return undefined;
		});

		const first = await gen.next();
		assert.strictEqual((first.value as any).content, 'item-0');

		// 模拟消费者 `break`：触发 generator 的 return() → finally 解除等待。
		await gen.return(undefined as any);

		// 让微任务队列排空，给 run 机会继续（它应当因 disposed 而快速跑完，
		// 而不是永久挂在某次 emit 上）。
		await new Promise(resolve => setTimeout(resolve, 10));

		assert.strictEqual(
			reachedEnd, true,
			'消费者退出后 run 仍挂在 emit 上 —— turn 资源无法释放（泄漏）',
		);
	});

	test('emit 零次的 run 不挂死', async () => {
		const gen = asGenerator(async () => 'empty');
		const { returned } = await drain(gen);
		assert.strictEqual(returned, 'empty', '无事件时消费者会永久等待唤醒');
	});

	test('TurnEventSink 可被 mock —— 这是「易于测试」的兑现点', async () => {
		const captured: string[] = [];
		const mockSink: TurnEventSink = (delta) => { captured.push(delta.type); };

		// 步骤函数不再是生成器，可直接调用、直接断言事件序列。
		async function emitPhaseChange(emit: TurnEventSink): Promise<void> {
			await emit({ type: 'phase_change', phase: 'llm_streaming' } as IChatStreamDelta);
			await emit({ type: 'done' } as IChatStreamDelta);
		}

		await emitPhaseChange(mockSink);

		assert.deepStrictEqual(captured, ['phase_change', 'done']);
	});
});
