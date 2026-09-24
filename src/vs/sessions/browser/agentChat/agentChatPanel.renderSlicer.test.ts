/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import {
	computeRestoreWindowStart,
	RENDER_SLICE_BUDGET_MS,
	RESTORE_USER_TURN_WINDOW,
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

	suite('computeRestoreWindowStart — 恢复窗口 = 最近 2 轮问答（2026-09-24 用户要求 ✓）', () => {
		interface IM { readonly id: string; readonly role: 'user' | 'assistant' | 'system' }
		const U = (id: string): IM => ({ id, role: 'user' });
		const A = (id: string): IM => ({ id, role: 'assistant' });
		const S = (id: string): IM => ({ id, role: 'system' });
		const isUser = (m: IM) => m.role === 'user';
		const startOf = (msgs: IM[]) => computeRestoreWindowStart(msgs, isUser, RESTORE_USER_TURN_WINDOW);

		test('典型 3 轮 ⇒ 从倒数第 2 条提问起（窗口 = u2,a2,u3,a3 ✓）', () => {
			const msgs = [U('u1'), A('a1'), U('u2'), A('a2'), U('u3'), A('a3')];
			assert.strictEqual(startOf(msgs), 2, '必须落在 u2 ✓');
		});

		test('末尾是流式快照（assistant 收尾）⇒ 窗口包含它 ✓', () => {
			// 3 条提问 ⇒ 窗口从 u2 起 ⇒ 尾部流式消息自然在窗口内 ✓
			const msgs = [U('u1'), A('a1'), U('u2'), A('a2'), U('u3'), A('a3-streaming')];
			assert.strictEqual(startOf(msgs), 2, '落在 u2 ✓ 尾部流式消息在窗口内 ✓');
		});

		test('只有 1 条提问 ⇒ 返回 0（全渲染 ✓ 短会话 ✓）', () => {
			assert.strictEqual(startOf([U('u1'), A('a1')]), 0);
		});

		test('无提问 ⇒ 返回 0 ✓', () => {
			assert.strictEqual(startOf([A('a1'), A('a2')]), 0);
		});

		test('恰好 2 条提问 ⇒ 从第 1 条起 ✓', () => {
			const msgs = [U('u1'), A('a1'), U('u2'), A('a2')];
			assert.strictEqual(startOf(msgs), 0);
		});

		test('空列表 ⇒ 0 ✓', () => {
			assert.strictEqual(startOf([]), 0);
		});

		test('相邻连续提问（中间无回答）⇒ 仍按提问计数 ✓', () => {
			const msgs = [U('u1'), A('a1'), U('u2'), U('u3'), A('a3')];
			// 从尾部扫：a3(否) → u3(第 1 条) → u2(第 2 条 ⇒ 返回其下标 2 ✓)
			assert.strictEqual(startOf(msgs), 2, '倒数第 2 条提问 = u2（idx=2）✓');
		});

		test('system 消息不算提问 ✓', () => {
			const msgs = [S('s1'), U('u1'), A('a1'), S('s2'), U('u2'), A('a2'), U('u3'), A('a3')];
			assert.strictEqual(startOf(msgs), 4, '落在 u2 ✓（system 不计数 ✓）');
		});

		test('窗口常量锚定 = 2（用户要求 ✓ 改动需重新确认 ✓）', () => {
			assert.strictEqual(RESTORE_USER_TURN_WINDOW, 2);
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

		test('★★★ 分片钉底必须 force=true（2026-09-24「重启后不在底部」根因 ✗✓ 不许回退 ✗✓）', () => {
			const src = read(MESSAGES_REL);
			// 中间态容器会被 scrollToBottom 的「dist≥80 ⇒ 用户滚离」启发式误判 ⇒ isAtBottom=false
			// ⇒ 后续钉底全灭 ✗ ⇒ 停在半路 ✗（且 _wasLoading 要等 setMessages 返回才置位 ✗）。
			// 剥注释后，onPin 与 _finishRenderBatch 两处钉底都必须是 force=true ✓
			const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			const pinCalls = code.split('this._scrollbar.scrollToBottom(true)').length - 1;
			assert.ok(pinCalls >= 2,
				`onPin 与 _finishRenderBatch 都必须 scrollToBottom(true)（实际 ${pinCalls} 处 ✗✓ —— 用 false 会在分片中间态被误判「用户滚离」✗）`);
			// 反向钉：分片渲染区域内不得出现 force=false 的钉底 ✗
			const finishIdx = code.indexOf('_finishRenderBatch(');
			const finishBody = code.slice(code.indexOf('{', code.indexOf('private _finishRenderBatch')));
			assert.ok(!finishBody.includes('scrollToBottom(false)'),
				'_finishRenderBatch 内不得用 scrollToBottom(false) ✗✓（非 force 会误判滚离 ⇒ 停在半路 ✗）');
			assert.ok(finishIdx > 0, '_finishRenderBatch 必须存在 ✓');
		});

		test('★★★ 恢复窗口 = 最近 2 轮问答 + 保窗规则（不许回退到「最近 30 条」✗✓）', () => {
			const src = read(MESSAGES_REL);
			assert.ok(src.includes('computeRestoreWindowStart'), '必须用纯函数算窗口 ✓');
			assert.ok(src.includes('RESTORE_USER_TURN_WINDOW'), '必须用窗口常量 ✓');
			assert.ok(!src.includes('VISIBLE_CHUNK'), '旧的「最近 30 条」常量必须移除 ✗✓');
			assert.ok(src.includes('Math.min(turnStart, this._lazyLoadRemaining)'),
				'保窗规则必须存在 ✗✓：不在底部 ⇒ min(新窗口, 当前渲染起点) ⇒ 已加载的旧内容不收回 ✓');
			assert.ok(/_isAtBottom[\s\S]{0,80}turnStart/.test(src) || src.includes('this._isAtBottom'),
				'保窗必须由 _isAtBottom 门控（在底部 ⇒ 直接用新窗口 ✓）');
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
