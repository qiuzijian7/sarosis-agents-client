/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import {
	RENDER_SLICE_BUDGET_MS,
	runTimeSlicedRender,
	shouldRenderFullySync,
	type IRenderSliceInfo,
} from './agentChatPanel.renderSlicer.js';

const MESSAGES_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.messages.ts';
const BASE_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts';

function read(rel: string): string {
	return readFileSync(rel, 'utf8');
}

/** 手动泵调度器：把续片回调收进队列，测试自己决定何时驱动 ✓（jsdom 时序不参与断言 ✓）。 */
function manualScheduler(): { pending: (() => void)[]; schedule: (cb: () => void) => void; pumpAll: () => void } {
	const pending: (() => void)[] = [];
	return {
		pending,
		schedule: (cb) => { pending.push(cb); },
		pumpAll: () => { while (pending.length) { pending.shift()!(); } },
	};
}

/** 假时钟：每渲染一条 renderItem 内 t += 100 ⇒ 每条都「超预算」⇒ 每片恰好 1 条 ✓✓（确定性）。 */
function clockAdvancingPerItem(): { now: () => number; tick: (ms: number) => void } {
	let t = 0;
	return { now: () => t, tick: (ms) => { t += ms; } };
}

suite('agentChatPanel.renderSlicer — P1 分帧渲染（2026-09-24 ✓ LONG_TASK worst=1256ms 的修法 ✓）', () => {

	test('预算内 ⇒ 首片全渲完（completedSynchronously=true ✓ 与旧全同步版行为一致 ✓）', () => {
		const items = ['a', 'b', 'c', 'd', 'e'];
		const rendered: string[] = [];
		const slices: IRenderSliceInfo[] = [];
		let done = 0;
		let pin = 0;
		const r = runTimeSlicedRender({
			items: () => items,
			cursor0: 0,
			budgetMs: RENDER_SLICE_BUDGET_MS,
			renderItem: (m) => { rendered.push(m); },
			isCancelled: () => false,
			schedule: () => { throw new Error('预算内不该调度续片 ✗✓'); },
			onSlice: (i) => slices.push(i),
			onPin: () => { pin++; },
			onDone: () => { done++; },
			now: () => 0, // 时钟不前进 ⇒ 永不超预算 ✓
		});
		assert.strictEqual(r.completedSynchronously, true, '预算内必须同步完成 ✓');
		assert.strictEqual(r.slices, 1);
		assert.deepStrictEqual(rendered, items, '顺序必须与源数组一致 ✓');
		assert.strictEqual(done, 1, 'onDone 恰好一次 ✓');
		assert.strictEqual(pin, 0, '渲完时不该有中间片钉底 ✓');
		assert.strictEqual(slices.length, 1);
		assert.strictEqual(slices[0].cursor, 5);
	});

	test('cursor0（懒加载起点）⇒ 只渲染尾部 ✓ 且 renderItem 拿到活数组下标 ✓', () => {
		const items = ['m0', 'm1', 'm2', 'm3', 'm4'];
		const seen: Array<[string, number]> = [];
		runTimeSlicedRender({
			items: () => items,
			cursor0: 2, // = firstBatchStart ✓
			budgetMs: RENDER_SLICE_BUDGET_MS,
			renderItem: (m, i) => { seen.push([m, i]); },
			isCancelled: () => false,
			schedule: () => assert.fail('不该分片 ✗'),
			onDone: () => { /* noop */ },
			now: () => 0,
		});
		assert.deepStrictEqual(seen, [['m2', 2], ['m3', 3], ['m4', 4]]);
	});

	test('★★★ 超预算 ⇒ 分片续渲：每片恰好 1 条 + 顺序不乱 + onPin/onDone 语义 ✓✓', () => {
		const items = ['a', 'b', 'c', 'd'];
		const clock = clockAdvancingPerItem();
		const sch = manualScheduler();
		const rendered: string[] = [];
		const pins: number[] = [];
		let done = 0;
		const r = runTimeSlicedRender({
			items: () => items,
			cursor0: 0,
			budgetMs: RENDER_SLICE_BUDGET_MS,
			renderItem: (m) => { rendered.push(m); clock.tick(100); }, // 每条 100ms ≫ 8ms 预算 ✓
			isCancelled: () => false,
			schedule: sch.schedule,
			onPin: () => { pins.push(rendered.length); },
			onDone: () => { done++; },
			now: clock.now,
		});
		assert.strictEqual(r.completedSynchronously, false, '超预算必须让出主线程 ✓✓');
		assert.deepStrictEqual(rendered, ['a'], '首片恰好 1 条（② 每片至少 1 条 ✓）');
		assert.strictEqual(sch.pending.length, 1, '剩余部分必须交调度器 ✓');
		// 泵完所有续片
		sch.pumpAll();
		assert.deepStrictEqual(rendered, items, '全部渲完且顺序不乱 ✓');
		assert.strictEqual(done, 1, 'onDone 恰好一次 ✓');
		assert.deepStrictEqual(pins, [1, 2, 3], '中间片各钉底一次；最后一片不钉（由 onDone 收尾 ✓）');
	});

	test('★ 单条本身超预算 ⇒ 仍前进（每片至少 1 条 ⇒ 不死循环 ✓✓）', () => {
		const items = ['x', 'y'];
		const clock = clockAdvancingPerItem();
		const sch = manualScheduler();
		const rendered: string[] = [];
		runTimeSlicedRender({
			items: () => items,
			cursor0: 0,
			budgetMs: RENDER_SLICE_BUDGET_MS,
			renderItem: (m) => { rendered.push(m); clock.tick(10_000); }, // 单条 10s ✗ 极端
			isCancelled: () => false,
			schedule: sch.schedule,
			onDone: () => { /* noop */ },
			now: clock.now,
		});
		assert.deepStrictEqual(rendered, ['x'], '首片至少渲了 1 条 ✓（没被预算挡成 0 条 ✗✓）');
		sch.pumpAll();
		assert.deepStrictEqual(rendered, ['x', 'y']);
	});

	test('★★ 活数组：分片中途 push 新消息 ⇒ 被自然捎带、顺序不乱 ✓（流式恢复交错场景 ✓）', () => {
		const items = ['a', 'b', 'c'];
		const clock = clockAdvancingPerItem();
		const sch = manualScheduler();
		const rendered: string[] = [];
		runTimeSlicedRender({
			items: () => items, // 活 getter ✓（不许快照 ✗）
			cursor0: 0,
			budgetMs: RENDER_SLICE_BUDGET_MS,
			renderItem: (m) => {
				rendered.push(m);
				clock.tick(100);
				if (m === 'b') { items.push('d-流式新到'); } // 分片期间数组变长 ✓
			},
			isCancelled: () => false,
			schedule: sch.schedule,
			onDone: () => { /* noop */ },
			now: clock.now,
		});
		sch.pumpAll();
		assert.deepStrictEqual(rendered, ['a', 'b', 'c', 'd-流式新到'],
			'流式新消息必须按数组顺序捎带渲染 ✓（快照会丢它 ✗✓）');
	});

	test('★★ 取消：代次失效 ⇒ 旧链静默退出 ✓（onDone 不调用、不再渲染 ✓）', () => {
		const items = ['a', 'b', 'c'];
		const clock = clockAdvancingPerItem();
		const sch = manualScheduler();
		const rendered: string[] = [];
		let cancelled = false;
		let done = 0;
		runTimeSlicedRender({
			items: () => items,
			cursor0: 0,
			budgetMs: RENDER_SLICE_BUDGET_MS,
			renderItem: (m) => { rendered.push(m); clock.tick(100); },
			isCancelled: () => cancelled,
			schedule: sch.schedule,
			onDone: () => { done++; },
			now: clock.now,
		});
		assert.deepStrictEqual(rendered, ['a']);
		cancelled = true; // 模拟新一轮 setMessages / dispose ✓
		sch.pumpAll();
		assert.deepStrictEqual(rendered, ['a'], '取消后一片都不许再渲 ✗✓');
		assert.strictEqual(done, 0, '被取消 ⇒ onDone 不得调用 ✓（收尾归新一轮 ✓）');
	});

	test('budget=Infinity ⇒ 全同步（逃生门/隐藏标签页共用的路径 ✓）', () => {
		const items = Array.from({ length: 500 }, (_, i) => `m${i}`);
		const clock = clockAdvancingPerItem();
		const rendered: string[] = [];
		const r = runTimeSlicedRender({
			items: () => items,
			cursor0: 0,
			budgetMs: Number.POSITIVE_INFINITY,
			renderItem: (m) => { rendered.push(m); clock.tick(100); },
			isCancelled: () => false,
			schedule: () => assert.fail('Infinity 预算不该分片 ✗✓'),
			onDone: () => { /* noop */ },
			now: clock.now,
		});
		assert.strictEqual(r.completedSynchronously, true);
		assert.strictEqual(rendered.length, 500);
	});

	suite('shouldRenderFullySync — 三条独立理由 ✓', () => {
		test('默认（可见 + 有 rAF + 无逃生门）⇒ 分片 ✓', () => {
			assert.strictEqual(shouldRenderFullySync({ canSchedule: true }), false);
		});
		test('逃生门 ⇒ 全同步 ✓', () => {
			assert.strictEqual(shouldRenderFullySync({ forceSync: true, canSchedule: true }), true);
		});
		test('隐藏标签页（rAF 被节流 ⇒ 分片会滞留半渲染态 ✗）⇒ 全同步 ✓', () => {
			assert.strictEqual(shouldRenderFullySync({ documentHidden: true, canSchedule: true }), true);
		});
		test('无 rAF ⇒ 全同步（防御 ✓）', () => {
			assert.strictEqual(shouldRenderFullySync({ canSchedule: false }), true);
		});
	});

	suite('★★ 接线断言（钉"不变量语义" ✓ 防实现漂移 ✗）', () => {
		test('messages.ts 必须真的使用时间片渲染器（不是只在测试里转 ✗✓）', () => {
			const src = read(MESSAGES_REL);
			for (const token of [
				'runTimeSlicedRender',
				'RENDER_SLICE_BUDGET_MS',
				'shouldRenderFullySync',
				'__SAROSIS_SYNC_RENDER_MESSAGES', // 逃生门 ✓
				'this._renderSliceGen',             // 代次 ✓
				"chatPerf.record('render.appendSlice'", // 分片打点 ✓
			]) {
				assert.ok(src.includes(token), `messages.ts 缺少接线 token：${token} ✗✓`);
			}
		});

		test('base.ts 必须声明分片字段并在 dispose 里取消续片 ✓', () => {
			const src = read(BASE_REL);
			assert.ok(src.includes('_renderSliceGen'), '代次字段 ✗');
			assert.ok(src.includes('_renderSliceRaf'), '续片句柄字段 ✗');
			assert.ok(/dispose\(\)[\s\S]*_renderSliceRaf/, 'dispose 必须触及续片句柄 ✗✓');
			assert.ok(/dispose\(\)[\s\S]*_renderSliceGen\+\+/, 'dispose 必须作废代次 ✗✓');
		});

		test('片预算取值锚定（改动需重新评估 60fps 语义 ✓）', () => {
			assert.strictEqual(RENDER_SLICE_BUDGET_MS, 8, '8ms = 16.6ms 一帧的一半 ✓');
		});
	});
});
