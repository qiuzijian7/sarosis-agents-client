/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Token 消耗明细浮层的**格式契约测试**（2026-09-21）。
 *
 * 为什么需要（用户实测 ✓）：浮层此前每行都带 `> 0` 门控 ✗ ⇒ **零值行整行消失** ✗
 * （截图只剩「输入 / 缓存未命中 / 输出 / 回复内容」✓，连命中率条都没有 ✗）；
 * 而且落盘侧没写齐字段 ⇒ **重启后**连剩下的行也会退化 ✗✓。用户要求：**内容与格式固定** ✓。
 *
 * 本测试因此逐行断言：
 *   · 「输入」下 命中 / 未命中 / 写入 **三行恒在** ✓（0 显示 `0` ✓）；
 *   · 「输出」下 思考过程 / 回复内容 **两行恒在** ✓；
 *   · 缓存命中率块 + 三段进度条 + 图例 **恒在** ✓（0% 也画 ✓）；
 *   · **零值与缺数据必须区分** ✓：`undefined` ⇒ `—`（旧记录 ✓），`0` ⇒ `0`（真实读数 ✓）。
 *
 * ⚠ 配套不变量（在 `agentChatService.sharedTokenUsage` ✓）：落盘必须写齐这些字段（含 0 ✓），
 *   否则重启后这里只能显示 `—` ✗✓ —— 两处口径必须同步改 ✓。
 *
 * 运行：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/browser/agentChat/agentChatPanel.tokenPopup.test.ts
 */
import assert from 'assert';

import { appendTokenUsagePopup, type ITokenUsageLike } from './agentChatPanel.tokenPopup.js';

function render(tu: ITokenUsageLike): HTMLElement {
	const pill = document.createElement('div');
	return appendTokenUsagePopup(pill, tu);
}

/** 取所有子行的「标签 → 值」映射 ✓（按 DOM 顺序 ✓）。 */
function rows(popup: HTMLElement): Map<string, string> {
	const out = new Map<string, string>();
	for (const row of Array.from(popup.querySelectorAll('.tokens-popup-sub-row'))) {
		const label = row.querySelector('.sub-label')?.textContent?.trim() ?? '';
		const value = row.querySelector('.sub-value')?.textContent?.trim() ?? '';
		out.set(label, value);
	}
	return out;
}

suite('Token 消耗明细浮层格式契约（2026-09-21）', () => {

	test('★★★ 零缓存回合：**所有行与命中率块都必须出现**（用户实测的残缺场景 ✗✓）', () => {
		// 数字取自用户截图 1（总计 25,730 / 输入 25,511 / 缓存未命中 25,511 / 输出 219 / 回复内容 219）
		const popup = render({
			input: 25511, output: 219, total: 25730,
			cached: 0, cachedRead: 0, cacheWrite: 0, cacheMiss: 25511, reasoning: 0, cacheHitRate: 0,
		});
		const r = rows(popup);
		// 输入三行**恒在** ✓（此前 cachedRead=0 ⇒ 「缓存命中」整行消失 ✗）
		assert.strictEqual(r.get('缓存命中'), '0', '零命中也要显示 0（0 是真实读数 ✗）');
		assert.strictEqual(r.get('缓存未命中'), (25511).toLocaleString());
		assert.strictEqual(r.get('缓存写入'), '0', '零写入也要显示 0 ✗');
		// 输出两行恒在 ✓
		assert.strictEqual(r.get('思考过程'), '0', '哪怕不推理也要显示 0 ✗');
		assert.strictEqual(r.get('回复内容'), (219).toLocaleString());
		// 命中率块恒在 ✓（此前 hitRate=0 && cachedRead=0 ⇒ 整块消失 ✗）
		assert.ok(popup.querySelector('.tokens-popup-hit-rate'), '命中率块必须存在 ✓');
		assert.strictEqual(popup.querySelector('.rate-value')?.textContent, '0.0%');
		assert.strictEqual(popup.querySelectorAll('.tokens-popup-legend .legend-item').length, 3, '图例三项恒在 ✓');
		assert.strictEqual(popup.querySelectorAll('.tokens-popup-hit-bar .seg').length, 3, '三段条恒在 ✓');
		assert.strictEqual(popup.querySelector('.tokens-popup-total-inline .value')?.textContent, (25730).toLocaleString());
	});

	test('★★★ 富数据回合：数字与三段条宽度按 input 占比（用户截图 2 的口径 ✓）', () => {
		const popup = render({
			input: 4862519, output: 12782, total: 4875301,
			cachedRead: 4851712, cacheWrite: 0, cacheMiss: 10807, reasoning: 4252, cacheHitRate: 99.8,
			providerId: 'codebuddy', model: 'claude-sonnet-4',
		});
		const r = rows(popup);
		assert.strictEqual(r.get('缓存命中'), (4851712).toLocaleString());
		assert.strictEqual(r.get('缓存未命中'), (10807).toLocaleString());
		assert.strictEqual(r.get('缓存写入'), '0');
		assert.strictEqual(r.get('思考过程'), (4252).toLocaleString());
		assert.strictEqual(r.get('回复内容'), (12782 - 4252).toLocaleString(), '回复内容 = 输出 − 思考过程 ✓');
		assert.strictEqual(popup.querySelector('.rate-value')?.textContent, '99.8%');
		const segs = Array.from(popup.querySelectorAll('.tokens-popup-hit-bar .seg')) as HTMLElement[];
		assert.strictEqual(segs.length, 3);
		const hitW = parseFloat(segs[0].style.width);
		assert.ok(Math.abs(hitW - (4851712 / 4862519) * 100) < 0.01, `命中段宽度应为占 input 比例（实际 ${segs[0].style.width}）`);
		assert.strictEqual(parseFloat(segs[1].style.width), 0, '写入段 0 ✓');
		// 模型行（落盘侧新增 providerId/model ✓ —— 重启后也能显示 ✓）
		assert.strictEqual(popup.querySelector('.tokens-popup-meta .meta-value')?.textContent, 'codebuddy / claude-sonnet-4');
	});

	test('★★ 缺数据 ≠ 零值：旧记录字段缺失时显示 `—` 但**行仍在**（不许整行消失 ✗）', () => {
		const popup = render({ input: 1000, output: 500, total: 1500 });
		const r = rows(popup);
		assert.strictEqual(r.get('缓存命中'), '—', '缺数据用 — ✓（与 0 区分 ✗）');
		assert.strictEqual(r.get('缓存写入'), '—');
		assert.strictEqual(r.get('思考过程'), '—');
		assert.strictEqual(r.get('缓存未命中'), (1000).toLocaleString(), '未命中可由 input 派生 ⇒ 有值 ✓');
		// 命中率缺省 ⇒ 由 cached/input 现算（0 ✓）
		assert.strictEqual(popup.querySelector('.rate-value')?.textContent, '0.0%');
		assert.ok(!popup.querySelector('.tokens-popup-meta'), '无 provider/model ⇒ 不渲染「模型」行 ✓（该行是可选信息 ✓）');
	});
});
