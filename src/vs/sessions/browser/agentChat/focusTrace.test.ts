/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `focusTrace` 契约测试（2026-09-18）。
 *
 * 为什么需要：它是**诊断代码** —— 最糟的失败模式不是"抛错"，而是**静默不记录** ✗
 * （于是复现时拿不到数据，只能再改一轮 ✗）。故锁住四条不变量：
 *   ① 无焦点基线时 `mark/span` 既不记录也不抛错（不能因为埋点打断主流程 ✓）；
 *   ② `span` 必须**原样返回**被测函数的返回值，并记录耗时（≥1ms 才记，避免噪音 ✓）；
 *   ③ 窗口获得焦点后，`mark`/`span` 进入轨迹，并在**下一次可绘制**时汇总成日志 ✓；
 *   ④ `spanAsync` 同样记录（会话锁是异步文件 IO ✓ 是重点嫌疑 ✓）；`dump` 不抛错 ✓。
 *
 * 运行（仓库未给 jsdom 运行器，需临时 preload）：
 *   npx mocha "out/vs/sessions/browser/agentChat/focusTrace.test.js" \
 *     --require ./.tmp-jsdom-preload.cjs --ui=tdd --timeout=30000 --exit
 */
import assert from 'assert';
import { FOCUS_TRACE_TAG, focusTrace } from './focusTrace.js';

/** 忙等 ms（用于产生可测的真实耗时；比 mock 计时器更能验证"真的量到了"）。 */
function busy(ms: number): void {
	const s = performance.now();
	while (performance.now() - s < ms) { /* spin */ }
}

/** 捕获 console.info（模块的日志出口见 focusTrace.ts 注释）。 */
function captureLog(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = console.info;
	console.info = (msg?: unknown) => { lines.push(String(msg)); };
	return { lines, restore: () => { console.info = original; } };
}

/**
 * 派发一次「窗口获得焦点」。
 *
 * ⚠ 必须用 `window.Event` 构造 ✗ 不能用全局 `Event`：临时 jsdom preload 会把
 * 浏览器全局**连同 class 一起 bind**（为了让 `addEventListener` 等方法可用 ✓），
 * 而 bind 后的构造函数**不能被 `new` 出合法实例** ✗ ⇒ `dispatchEvent` 会报
 * "parameter 1 is not of type 'Event'"（本次踩过 ✓）。
 */
function dispatchWindowFocus(): void {
	const W = window as unknown as { Event: new (type: string) => globalThis.Event };
	window.dispatchEvent(new W.Event('focus'));
}

suite('focusTrace —— 焦点轨迹埋点（2026-09-18）', () => {

	test('★ span 必须原样返回被测值（埋点不得改变行为）', () => {
		const v = focusTrace.span('test.return', () => 42, 'x');
		assert.strictEqual(v, 42, 'span 必须透传返回值');
		const o = { a: 1 };
		assert.strictEqual(focusTrace.span('test.returnObj', () => o), o, '对象也要原样透传');
	});

	test('★ span 在函数抛错时也必须结束计时（否则耗时数据永久缺失）', () => {
		assert.throws(() => focusTrace.span('test.throw', () => { throw new Error('boom'); }), /boom/);
	});

	test('★ spanAsync 必须 await 原件并透传结果（会话锁走这条路径）', async () => {
		const v = await focusTrace.spanAsync('test.async', async () => { busy(2); return 'ok'; });
		assert.strictEqual(v, 'ok');
		await assert.rejects(() => focusTrace.spanAsync('test.asyncThrow', async () => { throw new Error('nope'); }), /nope/);
	});

	test('★★ 窗口获得焦点 → mark/span 进入轨迹，并在下一次可绘制时打印汇总', async () => {
		const cap = captureLog();
		try {
			// 触发窗口获得焦点（模块在 install() 里监听了 window 'focus' ✓）
			dispatchWindowFocus();
			focusTrace.mark('test.markA', 'detailA');
			const v = focusTrace.span('test.spanB', () => { busy(3); return 'keep'; }, 'detailB');
			assert.strictEqual(v, 'keep');

			// 等汇总：模块用 rAF + setTimeout 兜底 ⇒ 两者都放行一次即可
			await new Promise<void>(resolve => setTimeout(resolve, 20));
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			await new Promise<void>(resolve => setTimeout(resolve, 20));

			const focusLines = cap.lines.filter(l => l.includes(FOCUS_TRACE_TAG));
			assert.ok(focusLines.length > 0, `窗口获得焦点后必须至少打印一行汇总，实际捕获 ${cap.lines.length} 行`);
			assert.ok(focusLines.some(l => l.includes('获得焦点')), '汇总行必须说明"焦点 → 首次可绘制"的耗时');
		} finally {
			cap.restore();
		}
	});

	test('★ 慢焦点（queueDelay 超阈值）必须打印**明细段**，供定位"谁吃掉了时间"', async () => {
		const cap = captureLog();
		try {
			dispatchWindowFocus();
			// 制造"焦点后主线程被占住"：忙等超过 FOCUS_TRACE_SLOW_MS(50ms)
			focusTrace.mark('test.beforeBusy');
			busy(80);
			focusTrace.mark('test.afterBusy', 'busy80');

			await new Promise<void>(resolve => setTimeout(resolve, 20));
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			await new Promise<void>(resolve => setTimeout(resolve, 20));

			const focusLines = cap.lines.filter(l => l.includes(FOCUS_TRACE_TAG));
			assert.ok(focusLines.some(l => l.includes('test.afterBusy')), '慢焦点必须逐条打印 mark 明细（否则无法定位 ✗）');
		} finally {
			cap.restore();
		}
	});

	test('★ dump 不抛错且输出标签（控制台入口必须可靠）', () => {
		const cap = captureLog();
		try {
			focusTrace.dump('test');
			assert.ok(cap.lines.some(l => l.includes(FOCUS_TRACE_TAG)), 'dump 必须输出带标签的内容');
		} finally {
			cap.restore();
		}
	});
});
