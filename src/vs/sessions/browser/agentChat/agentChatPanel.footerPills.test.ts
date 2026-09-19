/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 用量药丸统一入口的**契约测试**（2026-09-18）。
 *
 * 为什么需要：用户报「聊天框中 token / 耗时 / 积分 样式不统一」——根因是三处各自拼 DOM
 * （主气泡 pill ✓ / 子代理卡 pill ✓ / delegate 卡 emoji 纯文本 ✗）。
 * 收敛到 `appendFooterPill()` 后，**只要这个入口的 DOM 结构与数字格式不漂移**，
 * 三处就永远一致 ✓；反之若有人绕过它自拼 DOM，就又会分叉 ✗。
 * 故本测试锁住：① 结构与类名 ② 数字格式口径 ③ 可选件（ⓘ / valueClass）的边界。
 *
 * 运行：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/browser/agentChat/agentChatPanel.footerPills.test.ts
 */
import assert from 'assert';
import {
	appendFooterPill,
	formatCreditAmount,
	formatDurationMs,
	formatTokenCount,
} from './agentChatPanel.footerPills.js';

/** 建一个挂载点（等价于 footer / dlg-meta-row / chat-footer-processing）。 */
function host(): HTMLElement {
	return document.createElement('div');
}

suite('用量药丸统一入口 appendFooterPill（2026-09-18）', () => {

	test('★★★ 三种 kind 的 DOM 结构与类名一致（只有图标与种类类名不同）', () => {
		const h = host();
		const d = appendFooterPill(h, 'duration', '4.5s');
		const t = appendFooterPill(h, 'tokens', '12,345');
		const c = appendFooterPill(h, 'credit', '0.42');

		// 共同父类名：三处展示位据此共享同一套 CSS（图标/圆角/间距/深色主题）✓
		for (const pill of [d, t, c]) {
			assert.ok(pill.classList.contains('chat-bubble-footer-item'), '必须有 chat-bubble-footer-item');
			assert.ok(pill.classList.contains('chat-footer-pill'), '必须有 chat-footer-pill');
			// 结构固定：图标 + 数值（顺序不可变，CSS 依赖首个子节点做图标定位）
			assert.strictEqual(pill.children.length, 2, '基础形态应恰好为「图标 + 数值」两个子节点');
			assert.ok(pill.children[0].classList.contains('chat-footer-pill-icon'), '首个子节点必须是图标');
			assert.ok(pill.children[1].classList.contains('chat-footer-pill-value'), '次个子节点必须是数值');
		}

		// 种类类名（既有 DOM 查询与 CSS 都依赖，改名即破坏 ✗）
		assert.ok(d.classList.contains('duration-item'));
		assert.ok(t.classList.contains('tokens-item'));
		assert.ok(c.classList.contains('credit-item'));

		// 图标按 kind 区分，且必须是 codicon（不许 emoji —— 那正是被统一掉的旧样式 ✗）
		const iconOf = (el: HTMLElement) => el.children[0].className;
		assert.ok(iconOf(d).includes('codicon-watch'), `耗时图标应为 codicon-watch，实际 ${iconOf(d)}`);
		assert.ok(iconOf(t).includes('codicon-clippy'), `token 图标应为 codicon-clippy，实际 ${iconOf(t)}`);
		assert.ok(iconOf(c).includes('codicon-credit-card'), `积分图标应为 codicon-credit-card，实际 ${iconOf(c)}`);
		for (const pill of [d, t, c]) {
			assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(pill.textContent ?? ''), '文本里不得再出现 emoji');
		}
	});

	test('★★★ 数字格式只有一份口径（token 千分位 / 积分两位小数 / 耗时三段）', () => {
		// token：千分位全量（此前 delegate 卡用 12.3k 缩写，导致同一数字两种读法 ✗）
		assert.strictEqual(formatTokenCount(0), '0');
		assert.strictEqual(formatTokenCount(12345), (12345).toLocaleString());
		assert.strictEqual(formatTokenCount(1234567), (1234567).toLocaleString());
		// 积分：固定两位小数
		assert.strictEqual(formatCreditAmount(0.4), '0.40');
		assert.strictEqual(formatCreditAmount(3.055), '3.06');
		// 耗时：<1s → ms；<60s → s（一位小数）；≥60s → m + s
		assert.strictEqual(formatDurationMs(250), '250ms');
		assert.strictEqual(formatDurationMs(4500), '4.5s');
		assert.strictEqual(formatDurationMs(72000), '1m 12s');
	});

	test('★★ ⓘ 只在显式要求时出现（否则会污染不需要明细浮层的位置）', () => {
		const h = host();
		const plain = appendFooterPill(h, 'tokens', '12,345');
		const withInfo = appendFooterPill(h, 'tokens', '12,345', { withInfoIcon: true });
		assert.strictEqual(plain.querySelector('.chat-footer-pill-info'), null, '默认不得有 ⓘ');
		assert.ok(withInfo.querySelector('.chat-footer-pill-info'), 'withInfoIcon 时必须追加 ⓘ');
		assert.strictEqual(withInfo.children.length, 3, 'ⓘ 追加在数值之后');
	});

	test('★★ valueClass 只落到数值节点（抗抖动约定：不得改字体/颜色）', () => {
		const h = host();
		const pill = appendFooterPill(h, 'duration', '9s', { valueClass: 'chat-footer-processing-elapsed' });
		const value = pill.children[1] as HTMLElement;
		assert.ok(value.classList.contains('chat-footer-pill-value'), '数值节点基础类名不可少');
		assert.ok(value.classList.contains('chat-footer-processing-elapsed'), 'valueClass 必须生效');
		// 关键：秒级刷新靠类名取节点（_tickProcessingElapsed）⇒ 它必须能在药丸内被查到 ✓
		assert.ok(pill.querySelector('.chat-footer-processing-elapsed'), '按类名查询必须命中（秒级刷新依赖）');
		assert.strictEqual(pill.children[0].className.includes('chat-footer-processing-elapsed'), false, 'valueClass 不得落到图标上');
	});

	test('★★ title 默认按 kind 给，可被覆盖（tooltip 是用户理解图标的唯一线索）', () => {
		const h = host();
		assert.strictEqual(appendFooterPill(h, 'duration', '1s').title, '耗时');
		assert.strictEqual(appendFooterPill(h, 'tokens', '1').title, 'Tokens');
		assert.strictEqual(appendFooterPill(h, 'credit', '1.00').title, '积分');
		const custom = appendFooterPill(h, 'tokens', '1', { title: 'token 消耗：输入 1 / 输出 0' });
		assert.strictEqual(custom.title, 'token 消耗：输入 1 / 输出 0');
	});

	test('★ 返回药丸元素本身（供调用方挂 tokens-popup 明细浮层）', () => {
		const h = host();
		const pill = appendFooterPill(h, 'tokens', '12,345');
		let popup: HTMLElement | null = null;
		// 模拟 messages.ts 的用法：明细浮层必须能挂进药丸内（CSS 用 :hover 显示）
		popup = pill;
		// 返回值即药丸；此处直接断言父子关系可用（避免误返回数值节点导致浮层挂错位置）
		assert.strictEqual(popup.children[1].textContent, '12,345', '返回值必须是药丸，而非数值节点');
	});
});
