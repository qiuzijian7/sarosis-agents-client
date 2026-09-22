/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * renderActivityTrace（渲染活动归因环）的行为钉：
 *   1. 窗口查询只取窗口内标记，并按 tag 聚合计数（降序）；
 *   2. 窗口前最近标记单独给出（长任务常始于某个标记之后的同步代码）；
 *   3. 环形覆盖（超容量后仍能取到最近的标记）；
 *   4. 关闭开关生效（`__SAROSIS_ACTIVITY_TRACE = false` ⇒ 标记 no-op）。
 */
import assert from 'assert';
import {
	__resetRenderActivityTraceForTest,
	collectRenderActivity,
	formatRenderActivityWindow,
	markRenderActivity,
	registerRenderActivityFallbackSource,
} from '../../common/renderActivityTrace.js';

const g = globalThis as { __SAROSIS_ACTIVITY_TRACE?: boolean };

suite('renderActivityTrace', () => {

	setup(() => { __resetRenderActivityTraceForTest(); delete g.__SAROSIS_ACTIVITY_TRACE; });
	teardown(() => { __resetRenderActivityTraceForTest(); delete g.__SAROSIS_ACTIVITY_TRACE; });

	test('窗口聚合：只统计窗口内标记，按计数降序', () => {
		const t0 = Date.now();
		markRenderActivity('umd');
		markRenderActivity('umd');
		markRenderActivity('delta:text');
		const r = collectRenderActivity(t0 - 1000, Date.now() + 1000);
		assert.strictEqual(r.inWindow.length, 2);
		assert.deepStrictEqual(r.inWindow[0], { tag: 'umd', count: 2 });
		assert.deepStrictEqual(r.inWindow[1], { tag: 'delta:text', count: 1 });
	});

	test('窗口前最近标记单独给出（before）', () => {
		markRenderActivity('umd');
		const firstTs = Date.now();
		// ⚠ Date.now() 毫秒粒度：必须等到严格更晚的毫秒再打第二个标记，
		// 否则两个标记同 ts，窗口起点无法把它们分开（测试自身时序问题，非实现缺陷）。
		let later = Date.now();
		while (later <= firstTs) { later = Date.now(); }
		markRenderActivity('delta:text');
		const r = collectRenderActivity(later, Date.now() + 1000);
		assert.strictEqual(r.inWindow.length, 1, '只应含窗口内那一个');
		assert.strictEqual(r.inWindow[0]!.tag, 'delta:text');
		assert.strictEqual(r.before?.tag, 'umd', '窗口前最近标记应给出');
	});

	test('空窗口的文案不静默（无标记 / 有 before 两种形态）', () => {
		const empty = formatRenderActivityWindow(Date.now(), Date.now() + 10);
		assert.ok(empty.includes('无标记'), `空环应明说无标记（实际: ${empty}）`);
		markRenderActivity('umd');
		const withBefore = formatRenderActivityWindow(Date.now() + 1000, Date.now() + 2000);
		assert.ok(withBefore.includes('umd'), `有 before 时应点名（实际: ${withBefore}）`);
	});

	test('环形覆盖：超容量后仍取得到最近标记', () => {
		for (let i = 0; i < 40; i++) { markRenderActivity('umd'); }
		markRenderActivity('delta:text');
		const r = collectRenderActivity(Date.now() - 60_000, Date.now() + 1000);
		const total = r.inWindow.reduce((n, e) => n + e.count, 0);
		assert.ok(total <= 32, `容量上限 32（实际 ${total}）`);
		assert.ok(r.inWindow.some(e => e.tag === 'delta:text'), '最近的标记必须在环里');
	});

	test('关闭开关：__SAROSIS_ACTIVITY_TRACE=false ⇒ 标记 no-op', () => {
		g.__SAROSIS_ACTIVITY_TRACE = false;
		markRenderActivity('umd');
		const r = collectRenderActivity(Date.now() - 1000, Date.now() + 1000);
		assert.strictEqual(r.inWindow.length, 0, '关闭后不应记录任何标记');
	});

	// ─── 兜底归因源（2026-09-22，LONG_TASK「窗口内无标记」的归因补网）────────
	test('兜底源：窗口内无标记时拼上兜底文本（perf=…）', () => {
		const unregister = registerRenderActivityFallbackSource(() => 'perf=[demo×3/612ms]');
		try {
			const out = formatRenderActivityWindow(Date.now(), Date.now() + 10);
			assert.ok(out.includes('无标记'), '无标记的事实仍要明说');
			assert.ok(out.includes('perf=[demo×3/612ms]'), `兜底源文本必须拼上（实际: ${out}）`);
		} finally { unregister(); }
	});

	test('兜底源：窗口内**有**标记时不调用（不稀释主归因）', () => {
		markRenderActivity('umd');
		let called = 0;
		const unregister = registerRenderActivityFallbackSource(() => { called++; return 'perf=[x]'; });
		try {
			const now = Date.now();
			const out = formatRenderActivityWindow(now - 1000, now + 1000);
			assert.ok(out.includes('umd'), '标记命中为主归因');
			assert.ok(!out.includes('perf='), '有标记时不得拼兜底文本');
			assert.strictEqual(called, 0, '有标记时兜底源不应被调用');
		} finally { unregister(); }
	});

	test('兜底源：抛异常的源被静默，不影响其它源与主文案', () => {
		const u1 = registerRenderActivityFallbackSource(() => { throw new Error('boom'); });
		const u2 = registerRenderActivityFallbackSource(() => 'perf=[ok×1/5ms]');
		try {
			const out = formatRenderActivityWindow(Date.now(), Date.now() + 10);
			assert.ok(out.includes('perf=[ok×1/5ms]'), `健壮的源仍要生效（实际: ${out}）`);
		} finally { u1(); u2(); }
	});

	test('兜底源：返回 undefined/空串 不拼文本；反注册后不再调用', () => {
		const unregister = registerRenderActivityFallbackSource(() => undefined);
		const a = formatRenderActivityWindow(Date.now(), Date.now() + 10);
		assert.ok(!a.includes('perf='), 'undefined 不拼');
		unregister();
		const b = formatRenderActivityWindow(Date.now(), Date.now() + 10);
		assert.ok(!b.includes('perf='), '反注册后不得再拼');
	});
});
