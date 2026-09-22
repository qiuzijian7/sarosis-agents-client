/*---------------------------------------------------------------------------------------------
 *  chatPerfWindow.test.ts — chatPerf 近期 span 环（窗口聚合）的行为钉（2026-09-22）
 *
 *  背景：`[RenderHeartbeat] LONG_TASK … 因=[(窗口内无标记; 之前最近=scrollbar-markers@…)]`
 *  （真机 704ms/6 次累计 1605ms）—— 长任务发生在没打活动标记的代码里 ⇒ 无法归因。
 *  chatPerf 的 span 环注册为 renderActivityTrace 的**兜底归因源**后，无标记时仍能给出
 *  `perf=[label×n/累计ms]`。本文件钉住环的窗口聚合语义与兜底接线。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/common/chatPerfWindow.test.ts
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChatPerf, chatPerf } from '../../../../browser/agentChat/agentChatPanel.perf.js';
import { formatRenderActivityWindow, __resetRenderActivityTraceForTest } from '../../../../../base/common/renderActivityTrace.js';

suite('chatPerf 近期 span 环（LONG_TASK 无标记兜底归因，2026-09-22）', () => {

	setup(() => { __resetRenderActivityTraceForTest(); });
	teardown(() => { __resetRenderActivityTraceForTest(); });

	test('窗口聚合：按 label 聚合次数与累计耗时，耗时降序', () => {
		const perf = new ChatPerf(() => { /* 静音 */ });
		perf.record('card.create.tool', 300);
		perf.record('card.create.tool', 312);
		perf.record('render.messages.total', 89);
		const now = Date.now();
		const out = perf.formatWindow(now - 1000, now + 1000);
		assert.ok(out, '窗口内有 span 必须给出文本');
		assert.ok(out!.includes('perf=['), `形状必须是 perf=[…]（实际: ${out}）`);
		assert.ok(out!.includes('card.create.tool×2/612ms'), `聚合计数+累计耗时（实际: ${out}）`);
		assert.ok(out!.indexOf('card.create.tool') < out!.indexOf('render.messages.total'),
			`累计耗时降序（实际: ${out}）`);
	});

	test('窗口外不计入；空窗口返回 undefined（心跳据此不拼兜底文本）', () => {
		const perf = new ChatPerf(() => { /* 静音 */ });
		perf.record('card.create.tool', 300);
		const now = Date.now();
		assert.strictEqual(perf.formatWindow(now + 10_000, now + 20_000), undefined, '窗口外不得计入');
		assert.strictEqual(perf.formatWindow(now - 60_000, now - 50_000), undefined, '早于 span 的窗口也不计入');
	});

	test('环形覆盖：超容量后最近的 span 仍可查到', () => {
		const perf = new ChatPerf(() => { /* 静音 */ });
		for (let i = 0; i < 300; i++) { perf.record('spam', 1); }
		perf.record('the.culprit', 700);
		const now = Date.now();
		const out = perf.formatWindow(now - 1000, now + 1000);
		assert.ok(out!.includes('the.culprit×1/700ms'), `最近的 span 必须在环里（实际: ${out}）`);
		// 300 条 spam 里只剩 255 条在环中（容量 256，the.culprit 占 1 格）
		assert.ok(out!.includes('spam×255'), `环形覆盖后计数封顶（实际: ${out}）`);
	});

	test('★★★ 兜底接线：单例已注册 ⇒ 无标记的窗口能拼出 perf=[…]', () => {
		// 模块级副作用（agentChatPanel.perf.ts 末尾）应已把单例注册为兜底源。
		chatPerf.record('dom.census', 640);
		const now = Date.now();
		const out = formatRenderActivityWindow(now - 1000, now + 1000);
		assert.ok(out.includes('无标记'), '无活动标记的事实仍要明说');
		assert.ok(out.includes('perf=[') && out.includes('dom.census×1/640ms'),
			`无标记时必须拼出 span 兜底（实际: ${out}）`);
	});
});
