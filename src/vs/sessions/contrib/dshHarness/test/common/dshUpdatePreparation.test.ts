/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { registerBeforeUpdateInstallHook, runBeforeUpdateInstallHooks } from '../../../../../platform/update/electron-main/updateInstallHooks.js';
import { assertIdleForUpdate, IDshUpdatePreparation, prepareDshHostForUpdate } from '../../common/dshUpdatePreparation.js';

suite('安装前严格任务及 Host 检查', () => {
	const idle = { live: 1, sessions: [{ sessionId: 'scheduled', kinds: ['schedule'] }] };
	const busy = { live: 1, sessions: [{ sessionId: 'active', kinds: ['turn'] }] };
	function fixture(overrides: Partial<IDshUpdatePreparation> = {}) {
		const calls: string[] = [];
		return {
			calls,
			host: {
				hasHost: () => true, ownsHost: () => true,
				getActivity: async () => { calls.push('activity'); return idle; },
				stopHost: async () => { calls.push('stop'); },
				hostStopped: () => { calls.push('verify'); return true; },
				...overrides,
			},
		};
	}

	test('空闲两次复查通过，停止后确认退出', async () => {
		const f = fixture();
		await prepareDshHostForUpdate(f.host, CancellationToken.None);
		assert.deepStrictEqual(f.calls, ['activity', 'activity', 'stop', 'verify']);
	});

	test('已无 Host 不查询任务、不尝试停止', async () => {
		const f = fixture({ hasHost: () => false });
		await prepareDshHostForUpdate(f.host, CancellationToken.None);
		assert.deepStrictEqual(f.calls, []);
	});

	test('任务未知或正在运行均拒绝，不能把 live 数量当任务数', async () => {
		assert.doesNotThrow(() => assertIdleForUpdate({ live: 100, sessions: [] }));
		assert.throws(() => assertIdleForUpdate(undefined), /tasks-unavailable/);
		assert.throws(() => assertIdleForUpdate({ live: Number.NaN, sessions: [] }), /tasks-unavailable/);
		for (const activity of [undefined, busy]) {
			const f = fixture({ getActivity: async () => activity });
			await assert.rejects(prepareDshHostForUpdate(f.host, CancellationToken.None), /tasks-(unavailable|changed)/);
			assert.deepStrictEqual(f.calls, []);
		}
	});

	test('共享 Host 不得擅自停止', async () => {
		const f = fixture({ ownsHost: () => false });
		await assert.rejects(prepareDshHostForUpdate(f.host, CancellationToken.None), /stop-failed/);
		assert.deepStrictEqual(f.calls, []);
	});

	test('复查期间新任务出现时拒绝停止', async () => {
		let checked = 0;
		const f = fixture({ getActivity: async () => ++checked === 1 ? idle : busy });
		await assert.rejects(prepareDshHostForUpdate(f.host, CancellationToken.None), /tasks-changed/);
		assert.deepStrictEqual(f.calls, []);
	});

	test('停止失败或进程仍存活时拒绝安装', async () => {
		for (const overrides of [{ stopHost: async () => { throw new Error('stop failed'); } }, { hostStopped: () => false }]) {
			await assert.rejects(prepareDshHostForUpdate(fixture(overrides).host, CancellationToken.None), /stop/);
		}
	});

	test('准备取消后不允许继续停止 Host', async () => {
		const cancellation = new CancellationTokenSource();
		try {
			const f = fixture({ getActivity: async () => { cancellation.cancel(); return idle; } });
			await assert.rejects(prepareDshHostForUpdate(f.host, cancellation.token), /取消/);
			assert.deepStrictEqual(f.calls, []);
		} finally { cancellation.dispose(); }
	});
});

suite('安装准备钩子失败阻断', () => {
	const registrations: Array<{ dispose(): void }> = [];
	teardown(() => { for (const item of registrations.splice(0)) { item.dispose(); } });

	test('串行执行，失败不运行后续钩子', async () => {
		const calls: string[] = [];
		registrations.push(registerBeforeUpdateInstallHook(async () => { calls.push('first'); await Promise.resolve(); calls.push('finished'); }));
		registrations.push(registerBeforeUpdateInstallHook(() => { throw new Error('tasks-changed'); }));
		registrations.push(registerBeforeUpdateInstallHook(() => { calls.push('must not run'); }));
		await assert.rejects(runBeforeUpdateInstallHooks(), /tasks-changed/);
		assert.deepStrictEqual(calls, ['first', 'finished']);
	});

	test('超时取消准备并拒绝安装，晚到活动结果不能继续停止 Host', async () => {
		let release: (() => void) | undefined;
		let stopped = false;
		let finished: Promise<void> | undefined;
		registrations.push(registerBeforeUpdateInstallHook(token => {
			finished = prepareDshHostForUpdate({
				hasHost: () => true, ownsHost: () => true,
				getActivity: async () => { await new Promise<void>(resolve => release = resolve); return { live: 0, sessions: [] }; },
				stopHost: async () => { stopped = true; }, hostStopped: () => true,
			}, token);
			return finished;
		}));
		await assert.rejects(runBeforeUpdateInstallHooks(undefined, 10), /timed out/);
		release?.();
		await assert.rejects(finished!, /取消/);
		assert.strictEqual(stopped, false);
	});
});
