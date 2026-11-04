/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「等更新就绪」的判据（`common/dshUpdateWait.ts`）—— 假时钟 + 假状态序列的行为测试。
 *
 * ★★ 2026-11-04 真机：点「一键升级」几乎**立刻**弹「下载超时（3 分钟内没就绪）」，根本不到 3 分钟。
 *   旧实现把 `Idle` / `Disabled` / `Uninitialized` 一见到就返回 false ⇒ 三种不同原因全被报成"超时"，
 *   而且 `Idle` 那条**必然**先命中（`checkForUpdates` 内部不 await，状态还没翻过来）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpdateWait
 */

import assert from 'assert';
import { StateType } from '../../../../../platform/update/common/update.js';
import { waitForUpdateReady } from '../../common/dshUpdateWait.js';

/** 假时钟 + 假状态序列：`steps` 是 [{ until, type, error? }]，`until` 为累计毫秒。 */
function makeClock(steps: Array<{ until: number; type: StateType; error?: Error }>): {
	readState: () => { type: StateType; error?: Error | string };
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	elapsed: () => number;
} {
	let t = 0;
	let i = 0;
	const readState = () => {
		while (i < steps.length - 1 && t >= steps[i].until) { i++; }
		return { type: steps[i].type, ...(steps[i].error ? { error: steps[i].error } : {}) };
	};
	return {
		readState,
		now: () => t,
		sleep: async (ms: number) => { t += ms; },
		elapsed: () => t,
	};
}

const OPTS = { pollMs: 100, graceMs: 500, idleStuckMs: 1_000 };

suite('等更新就绪的判据', () => {

	test('1) ★ 旧 bug：一开始 Idle、随后才变 Downloading→Downloaded ⇒ 必须成功', async () => {
		// 旧实现在第一次读 Idle 时就直接返回 false —— 这条用例正是钉它。
		const c = makeClock([
			{ until: 1_000, type: StateType.Idle },
			{ until: 3_000, type: StateType.Downloading },
			{ until: Number.MAX_SAFE_INTEGER, type: StateType.Downloaded },
		]);
		const r = await waitForUpdateReady(c.readState, 10_000, { ...OPTS, now: c.now, sleep: c.sleep });
		assert.deepStrictEqual(r, { ok: true, reason: 'ready' });
	});

	test('2) 一直 Idle ⇒ not-started（不是 timeout，也不是"3 分钟超时"）', async () => {
		const c = makeClock([{ until: Number.MAX_SAFE_INTEGER, type: StateType.Idle }]);
		const r = await waitForUpdateReady(c.readState, 60_000, { ...OPTS, now: c.now, sleep: c.sleep });
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.reason, 'not-started');
		// 必须在宽限期之后才判，别一上来就死
		assert.ok(c.elapsed() > OPTS.graceMs + OPTS.idleStuckMs, '判死得太早：' + c.elapsed() + 'ms');
	});

	test('3) Disabled / Uninitialized ⇒ disabled，并带上服务自报的 error', async () => {
		for (const type of [StateType.Disabled, StateType.Uninitialized]) {
			const c = makeClock([{ until: Number.MAX_SAFE_INTEGER, type, error: new Error('update.mode=none') }]);
			const r = await waitForUpdateReady(c.readState, 10_000, { ...OPTS, now: c.now, sleep: c.sleep });
			assert.strictEqual(r.reason, 'disabled', 'StateType ' + type + ' 应判 disabled');
			assert.match(String(r.detail), /update\.mode=none/, '必须把服务自报的错误带出来');
		}
	});

	test('4) 一直在下载但就是不完成 ⇒ timeout', async () => {
		const c = makeClock([{ until: Number.MAX_SAFE_INTEGER, type: StateType.Downloading }]);
		const r = await waitForUpdateReady(c.readState, 5_000, { ...OPTS, now: c.now, sleep: c.sleep });
		assert.deepStrictEqual(r, { ok: false, reason: 'timeout' });
	});

	test('5) 已经是 Ready / Downloaded ⇒ 立即成功（不等）', async () => {
		for (const type of [StateType.Ready, StateType.Downloaded]) {
			const c = makeClock([{ until: Number.MAX_SAFE_INTEGER, type }]);
			const r = await waitForUpdateReady(c.readState, 10_000, { ...OPTS, now: c.now, sleep: c.sleep });
			assert.deepStrictEqual(r, { ok: true, reason: 'ready' });
			assert.ok(c.elapsed() <= OPTS.pollMs, '已经就绪就不该再等：' + c.elapsed() + 'ms');
		}
	});

	test('6) Idle → CheckingForUpdates 的长尾（状态一直在动）不许被判 not-started', async () => {
		const c = makeClock([
			{ until: 800, type: StateType.Idle },
			{ until: Number.MAX_SAFE_INTEGER, type: StateType.CheckingForUpdates },
		]);
		const r = await waitForUpdateReady(c.readState, 20_000, { ...OPTS, now: c.now, sleep: c.sleep });
		assert.strictEqual(r.reason, 'timeout', '在动的状态只能等到超时，不能被当成"没开始下载"');
	});
});
