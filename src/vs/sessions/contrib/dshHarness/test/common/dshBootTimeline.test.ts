/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 启动阶段时间线的表驱动测试：注入假时钟，不依赖 DOM，也不需要真的等几十秒。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshBootTimeline
 */

import assert from 'assert';
import { BOOT_STAGES, BOOT_STUCK_HINT_MS, BootTimeline, formatDuration } from '../../common/dshBootTimeline.js';

function fixture(t0 = 1_000): { boot: BootTimeline; at: (ms: number) => number } {
	let now = t0;
	const boot = new BootTimeline(() => now);
	return {
		boot,
		at(ms: number): number {
			now = t0 + ms;
			return now;
		},
	};
}

suite('dshHarness / 启动阶段时间线', () => {

	test('① 阶段清单：4 段、顺序固定、id 唯一、每段都有详细说明', () => {
		assert.deepStrictEqual(BOOT_STAGES.map(s => s.id), ['shell', 'view', 'runtime', 'ui']);
		assert.strictEqual(new Set(BOOT_STAGES.map(s => s.id)).size, BOOT_STAGES.length);
		for (const stage of BOOT_STAGES) {
			assert.ok(stage.label.length > 0, `${stage.id} 缺标题`);
			assert.ok(stage.detail.length >= 20, `${stage.id} 缺「这一步在做什么」的详细说明`);
		}
		// 「准备运行环境」是首启最容易卡的一步，必须把慢的原因讲清楚。
		assert.match(BOOT_STAGES[2].detail, /profile|Host/);
		assert.match(BOOT_STAGES[2].detail, /Node/);
	});

	test('② formatDuration：毫秒 / 秒 / 分，脏值不崩', () => {
		assert.strictEqual(formatDuration(0), '0ms');
		assert.strictEqual(formatDuration(999), '999ms');
		assert.strictEqual(formatDuration(1_000), '1.0s');
		assert.strictEqual(formatDuration(12_340), '12.3s');
		assert.strictEqual(formatDuration(65_000), '1m05s');
		assert.strictEqual(formatDuration(-1), '—');
		assert.strictEqual(formatDuration(Number.NaN), '—');
	});

	test('③ 初始态：全部 pending、总耗时从 0 开始、有初始文案', () => {
		const { boot, at } = fixture();
		const view = boot.view(at(0));
		assert.deepStrictEqual(view.stages.map(s => s.state), ['pending', 'pending', 'pending', 'pending']);
		assert.deepStrictEqual(view.stages.map(s => s.elapsedMs), [0, 0, 0, 0]);
		assert.strictEqual(view.totalMs, 0);
		assert.strictEqual(view.runningStageId, undefined);
		assert.ok(view.message.includes('启动'));
		assert.strictEqual(view.finished, false);
		assert.strictEqual(view.failed, false);
	});

	test('④ running 阶段显示实时耗时；切到下一阶段自动结算上一阶段', () => {
		const { boot, at } = fixture();
		boot.begin('shell', at(100));
		boot.begin('view', at(2_500));
		boot.view(at(3_000));
		const view = boot.view(at(4_000));
		assert.strictEqual(view.stages[0].state, 'done');
		assert.strictEqual(view.stages[0].elapsedMs, 2_400, 'shell = 2500 - 100');
		assert.strictEqual(view.stages[1].state, 'running');
		assert.strictEqual(view.stages[1].elapsedMs, 1_500, 'view 实时耗时 = 4000 - 2500');
		assert.strictEqual(view.runningStageId, 'view');
		assert.strictEqual(view.runningStageMs, 1_500);
		assert.strictEqual(view.totalMs, 4_000);
	});

	test('⑤ begin 同一阶段幂等，不重置计时', () => {
		const { boot, at } = fixture();
		boot.begin('runtime', at(500));
		boot.begin('runtime', at(3_000));
		assert.strictEqual(boot.view(at(3_500)).stages[2].elapsedMs, 3_000);
	});

	test('⑥ 进度文本切成子步骤，每条都有耗时；重复文案合并', () => {
		const { boot, at } = fixture();
		boot.begin('runtime', at(0));
		boot.note('正在下载并校验托管 Node…', at(100));
		boot.note('首次启动：正在准备后台服务，可能需要几分钟，请勿关闭窗口', at(3_100));
		boot.note('首次启动：正在准备后台服务，可能需要几分钟，请勿关闭窗口', at(3_200));
		boot.note('正在安装伴生插件（3/12）…', at(8_100));
		boot.complete('runtime', at(9_000));
		const steps = boot.view(at(9_000)).stages[2].steps;
		assert.deepStrictEqual(steps.map(s => s.label), [
			'正在下载并校验托管 Node…',
			'首次启动：正在准备后台服务，可能需要几分钟，请勿关闭窗口',
			'正在安装伴生插件（3/12）…',
		], '同一文案连发两次不许制造 0ms 的重复行');
		assert.deepStrictEqual(steps.map(s => s.elapsedMs), [3_000, 5_000, 900]);
		assert.deepStrictEqual(steps.map(s => s.running), [false, false, false]);
		assert.strictEqual(boot.view(at(9_000)).stages[2].elapsedMs, 9_000);
	});

	test('⑦ 没有 running 阶段时进度文本不落进任何阶段', () => {
		const { boot, at } = fixture();
		boot.note('预热时来的进度', at(100));
		boot.begin('shell', at(200));
		assert.deepStrictEqual(boot.view(at(300)).stages.flatMap(s => s.steps), []);
	});

	test('⑧ 失败：当前阶段标红并冻结耗时，总耗时不再随重绘上涨', () => {
		const { boot, at } = fixture();
		boot.begin('shell', at(0));
		boot.begin('runtime', at(1_000));
		boot.note('正在下载并校验托管 Node…', at(1_500));
		boot.failCurrent('EPERM: operation not permitted, rename …', at(6_000));
		const view = boot.view(at(20_000));
		assert.strictEqual(view.failed, true);
		assert.strictEqual(view.stages[0].state, 'done');
		assert.strictEqual(view.stages[2].state, 'failed', '用户能一眼看出卡在「准备运行环境」');
		assert.strictEqual(view.stages[2].elapsedMs, 5_000);
		assert.strictEqual(view.stages[2].steps[0].elapsedMs, 4_500, '最后一条进度也冻结，能看到卡在下载 Node 上');
		assert.strictEqual(view.totalMs, 6_000);
		assert.strictEqual(view.message, 'EPERM: operation not permitted, rename …');
		assert.strictEqual(boot.view(at(60_000)).totalMs, 6_000, '失败后重绘不许继续计时');
		// 失败后不许再被 begin / finish 改写
		boot.begin('ui', at(7_000));
		boot.finish('启动完成', at(8_000));
		assert.strictEqual(boot.view(at(9_000)).failed, true);
		assert.strictEqual(boot.view(at(9_000)).finished, false);
	});

	test('⑨ 完成：结束最后阶段、冻结总耗时，pending 阶段保持原样', () => {
		const { boot, at } = fixture();
		boot.begin('shell', at(0));
		boot.begin('view', at(500));
		boot.begin('runtime', at(1_000));
		boot.begin('ui', at(4_000));
		boot.finish('启动完成 · 总耗时 5.0s', at(5_000));
		const view = boot.view(at(30_000));
		assert.strictEqual(view.finished, true);
		assert.strictEqual(view.failed, false);
		assert.deepStrictEqual(view.stages.map(s => s.state), ['done', 'done', 'done', 'done']);
		assert.deepStrictEqual(view.stages.map(s => s.elapsedMs), [500, 500, 3_000, 1_000]);
		assert.strictEqual(view.totalMs, 5_000);
		assert.strictEqual(view.runningStageId, undefined);
		assert.strictEqual(view.message, '启动完成 · 总耗时 5.0s');
	});

	test('⑩ 卡住阈值：只在确实有一个阶段长时间 running 时给出提示', () => {
		const { boot, at } = fixture();
		boot.begin('runtime', at(0));
		assert.ok(boot.view(at(BOOT_STUCK_HINT_MS - 1)).runningStageMs < BOOT_STUCK_HINT_MS);
		assert.ok(boot.view(at(BOOT_STUCK_HINT_MS + 2_000)).runningStageMs > BOOT_STUCK_HINT_MS);
		boot.finish('启动完成', at(BOOT_STUCK_HINT_MS + 3_000));
		assert.strictEqual(boot.view(at(60_000)).runningStageMs, 0, '完成后不再提示卡住');
	});

	test('⑪ 未知阶段 id 必须报错，不许静默丢阶段', () => {
		const { boot, at } = fixture();
		assert.throws(() => boot.begin('nope' as never, at(0)), /unknown boot stage/);
	});
});
