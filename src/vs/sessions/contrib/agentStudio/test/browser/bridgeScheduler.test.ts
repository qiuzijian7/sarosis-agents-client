/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BridgeScheduler 单测（cron/timer → engine.handleSynthetic）──

import assert from 'assert';
import { BridgeScheduler, IScheduledTaskStore, ScheduledTask } from '../../browser/bridge/bridgeScheduler.js';

/** 内存态存储，模拟持久化落盘/恢复。 */
function memStore(initial: ScheduledTask[] = []): IScheduledTaskStore & { data: ScheduledTask[]; saves: number } {
	let data: ScheduledTask[] = initial.map(t => ({ ...t }));
	return {
		data,
		saves: 0,
		load(): ScheduledTask[] {
			return data.map(t => ({ ...t }));
		},
		save(tasks: ScheduledTask[]): void {
			this.saves++;
			data = tasks.map(t => ({ ...t }));
			this.data = data;
		},
	};
}

function fakeEngine() {
	const calls: Array<{ sessionKey: string; content: string }> = [];
	return {
		calls,
		async handleSynthetic(sessionKey: string, content: string): Promise<void> {
			calls.push({ sessionKey, content });
		},
	};
}

function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (cond()) {
				resolve();
			} else if (Date.now() - start > timeoutMs) {
				reject(new Error('waitUntil timeout'));
			} else {
				setTimeout(tick, 50);
			}
		};
		tick();
	});
}

suite('BridgeScheduler', () => {
	test('timer fires after delay and auto-removes', async () => {
		const engine = fakeEngine();
		const sched = new BridgeScheduler({ engine: engine as any, logService: { info() {}, warn() {}, error() {} } as any, tickMs: 100 });
		sched.start();
		const task = sched.addTimer({ sessionKey: 'loopback:t', prompt: 'hi timer', delay: '1s' });
		assert.strictEqual(sched.list().length, 1);
		await waitUntil(() => engine.calls.some(c => c.content === 'hi timer'));
		assert.ok(engine.calls.some(c => c.sessionKey === 'loopback:t'));
		// timer 触发后自动移除
		await waitUntil(() => sched.list().length === 0);
		sched.stop();
	});

	test('cron triggerNow invokes engine', async () => {
		const engine = fakeEngine();
		const sched = new BridgeScheduler({ engine: engine as any, logService: { info() {}, warn() {}, error() {} } as any });
		const task = sched.addCron({ sessionKey: 'loopback:c', cronExpr: '* * * * *', prompt: 'hi cron' });
		await sched.triggerNow(task.id);
		assert.ok(engine.calls.some(c => c.content === 'hi cron' && c.sessionKey === 'loopback:c'));
		sched.remove(task.id);
		assert.strictEqual(sched.list().length, 0);
	});

	test('addTimer rejects invalid delay', () => {
		const engine = fakeEngine();
		const sched = new BridgeScheduler({ engine: engine as any, logService: { info() {}, warn() {}, error() {} } as any });
		assert.throws(() => sched.addTimer({ sessionKey: 'x', prompt: 'p', delay: 'notatime' }));
	});

	test('addCron rejects invalid expr', () => {
		const engine = fakeEngine();
		const sched = new BridgeScheduler({ engine: engine as any, logService: { info() {}, warn() {}, error() {} } as any });
		assert.throws(() => sched.addCron({ sessionKey: 'x', cronExpr: 'bad expr', prompt: 'p' }));
	});

	test('persist: addCron/addTimer/remove write to store', () => {
		const engine = fakeEngine();
		const store = memStore();
		const sched = new BridgeScheduler({ engine: engine as any, logService: { info() {}, warn() {}, error() {} } as any, store });
		const c = sched.addCron({ sessionKey: 'loopback:c', cronExpr: '* * * * *', prompt: 'hi cron' });
		assert.strictEqual(store.data.length, 1);
		sched.addTimer({ sessionKey: 'loopback:t', prompt: 'hi timer', delay: '10m' });
		assert.strictEqual(store.data.length, 2);
		sched.remove(c.id);
		assert.strictEqual(store.data.length, 1);
		// 转瞬字段 _firedMinute 不应出现在已存快照的 cron 上（此处 cron 已移除，仅剩 timer）
		assert.strictEqual(store.data[0].kind, 'timer');
	});

	test('restore: start() loads cron tasks and skips completed timers', () => {
		const engine = fakeEngine();
		const now = Date.now();
		const store = memStore([
			{ id: 'cron_a', kind: 'cron', name: 'A', sessionKey: 's:a', prompt: 'pa', cronExpr: '* * * * *', enabled: true, createdAt: now },
			{ id: 'timer_done', kind: 'timer', name: 'B', sessionKey: 's:b', prompt: 'pb', fireAt: now - 1000, enabled: false, createdAt: now },
			{ id: 'timer_pending', kind: 'timer', name: 'C', sessionKey: 's:c', prompt: 'pc', fireAt: now + 3600_000, enabled: true, createdAt: now },
		]);
		const sched = new BridgeScheduler({ engine: engine as any, logService: { info() {}, warn() {}, error() {} } as any, store, tickMs: 100_000 });
		sched.start();
		const ids = sched.list().map(t => t.id).sort();
		assert.deepStrictEqual(ids, ['cron_a', 'timer_pending']);
		sched.stop();
	});
});
