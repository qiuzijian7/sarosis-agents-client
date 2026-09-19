/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `ExecBackgroundNotifier`（后台任务完成通知）的三条不变量：
 * ① **一次性**：同一 taskId 完成只发一次；② **预算**：最多盯 maxWatchMs，不永盯；③ **瞬时失败不丢**。
 *
 * ⚠ 注入**可控时钟 + 假 poll**，让套件**不睡真时间**（真睡会让套件又慢又抖 ✗）。
 *   盯守由 `setTimeout(pollMs)` 驱动 ⇒ 测试里把 pollMs 降到 5ms、每步只睡几十 ms 即可 ✓。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import {
	ExecBackgroundNotifier,
	type IBackgroundTaskFinishedEvent,
} from '../../browser/providers/tool/execBackgroundNotify.js';

/** 睡真毫秒（盯守 tick 由 setTimeout 驱动 ⇒ 必须让它真的轮到 ✓）。 */
function sleepReal(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/** 手动时钟（预算测试可控 ✓）。 */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
	let t = 0;
	return { now: () => t, advance: (ms) => { t += ms; } };
}

suite('ExecBackgroundNotifier — 后台任务完成通知（2026-09-19）', () => {

	/**
	 * 订阅返回的 FunctionDisposable 必须进 store ✗（否则「无泄漏」断言会红 ✓）。
	 *
	 * ⚠⚠ **顺序敏感**：TDD 的 `teardown` 钩子按**注册序**运行 ✓ ⇒ 我的 dispose 钩子必须**先于**
	 * `ensureNoDisposablesAreLeakedInTestSuite()`（它内部注册的泄漏检查钩子 ✗）注册，
	 * 否则泄漏检查在 dispose **之前**就执行 ⇒ 必红 ✗✓（本套件曾因此反复红 ✗）。
	 * 且泄漏断言是**按用例**查的 ⇒ **suite 级** dispose 也太晚 ✗ ⇒ 必须**逐用例** dispose ✓。
	 */
	let store: DisposableStore;
	setup(() => { store = new DisposableStore(); });
	teardown(() => { store.dispose(); });

	ensureNoDisposablesAreLeakedInTestSuite();

	const FAST = { pollMs: 5, maxWatchMs: 10 * 60 * 1000 };

	test('★ 完成 ⇒ 只发一次（不变量① 一次性 ✓）', async () => {
		const n = new ExecBackgroundNotifier(FAST);
		const events: IBackgroundTaskFinishedEvent[] = [];
		store.add(n.onDidFinishBackgroundTask(e => events.push(e)));
		let calls = 0;
		n.watch('t1', 'agentA', 'sess1', async () => { calls++; return { done: true, exitCode: 0, stdout: 'hello tail' }; });
		await sleepReal(40);
		assert.strictEqual(events.length, 1, `完成应只发一次，实际 ${events.length}`);
		assert.strictEqual(events[0].status, 'finished');
		assert.strictEqual(events[0].exitCode, 0);
		assert.strictEqual(events[0].stdoutTail, 'hello tail');
		assert.strictEqual(events[0].agentId, 'agentA');
		assert.strictEqual(n.watchingCount, 0, '完成后应停止盯守 ✓');
		assert.strictEqual(calls, 1, `立即完成 ⇒ poll 应只调一次 ⇒ 实际 ${calls}`);
	});

	test('★ 进行中 ⇒ 持续盯守直到完成（不提前发 ✓，完成时拿到真实 exitCode ✓）', async () => {
		const n = new ExecBackgroundNotifier(FAST);
		const events: IBackgroundTaskFinishedEvent[] = [];
		store.add(n.onDidFinishBackgroundTask(e => events.push(e)));
		let calls = 0;
		n.watch('t2', 'agentA', undefined, async () => {
			calls++;
			return calls < 3 ? { done: false } : { done: true, exitCode: 7, stdout: 'ok' };
		});
		await sleepReal(60);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].exitCode, 7);
		assert.ok(calls >= 3, `应轮询到第 3 次才完成 ⇒ 实际 ${calls}`);
	});

	test('★ 幂等：同一 taskId 只盯一次（重复登记返回 false ✓）', async () => {
		const n = new ExecBackgroundNotifier(FAST);
		let calls = 0;
		const poll = async () => { calls++; return { done: false }; };
		assert.strictEqual(n.watch('t3', 'a', undefined, poll), true);
		assert.strictEqual(n.watch('t3', 'a', undefined, poll), false, '重复登记应被拒 ✓');
		assert.strictEqual(n.watchingCount, 1, '只盯一个 ✓');
		await sleepReal(40);
		assert.ok(calls < 30, `只盯一个 ⇒ poll 次数不该翻倍 ⇒ 实际 ${calls}`);
	});

	test('★ 预算：盯守超过 maxWatchMs 后放弃，且**未完成任务不发通知**（不变量② ✓）', async () => {
		const clock = fakeClock();
		const n = new ExecBackgroundNotifier({ pollMs: 5, maxWatchMs: 100, now: clock.now });
		const events: IBackgroundTaskFinishedEvent[] = [];
		store.add(n.onDidFinishBackgroundTask(e => events.push(e)));
		n.watch('t4', 'a', undefined, async () => { clock.advance(50); return { done: false }; });
		await sleepReal(80);
		assert.strictEqual(n.watchingCount, 0, '预算到点后应停止盯守 ✓');
		assert.strictEqual(events.length, 0, '未完成的任务**不应**发完成通知 ✓✓');
	});

	test('★ 瞬时失败不丢：一次 poll 抛错 ⇒ 重试而非丢通知（不变量③ ✓）', async () => {
		const n = new ExecBackgroundNotifier(FAST);
		const events: IBackgroundTaskFinishedEvent[] = [];
		store.add(n.onDidFinishBackgroundTask(e => events.push(e)));
		let calls = 0;
		n.watch('t5', 'a', undefined, async () => {
			calls++;
			if (calls === 1) { throw new Error('IPC 抖动'); }
			return { done: true, exitCode: 0, stdout: 'x' };
		});
		await sleepReal(50);
		assert.strictEqual(events.length, 1, '瞬时失败后重试 ⇒ 仍应送达 ✓✓');
		assert.ok(calls >= 2, `应重试（poll≥2 次）⇒ 实际 ${calls}`);
	});

	test('★ stdout 只保留尾巴 tailChars（防上下文膨胀 ✗）', async () => {
		const n = new ExecBackgroundNotifier({ pollMs: 5, tailChars: 10 });
		const events: IBackgroundTaskFinishedEvent[] = [];
		store.add(n.onDidFinishBackgroundTask(e => events.push(e)));
		n.watch('t6', 'a', undefined, async () => ({ done: true, exitCode: 0, stdout: 'abcdefghijklmnopqrstuvwxyz' }));
		await sleepReal(40);
		assert.strictEqual(events[0].stdoutTail, 'qrstuvwxyz', '应只保留最后 10 个字符 ✓');
	});

	test('★ killed 也要如实标（双保险 ✓——别再把"被杀"读成"还在跑" ✗）', async () => {
		const n = new ExecBackgroundNotifier(FAST);
		const events: IBackgroundTaskFinishedEvent[] = [];
		store.add(n.onDidFinishBackgroundTask(e => events.push(e)));
		n.watch('t7', 'a', undefined, async () => ({ killed: true }));
		await sleepReal(40);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].status, 'killed');
	});
});
