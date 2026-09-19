/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../base/browser/dom.js';

/**
 * 用量信息药丸（**耗时 / token / 积分**）的**唯一构建入口**（2026-09-18 统一）。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────
 * 这三类数据此前在**三处各自拼 DOM**，样式因此分叉 ✗：
 *   · 主气泡 footer（`agentChatPanel.messages.ts`）—— `pill + codicon` ✓
 *   · 子代理卡 footer（`agentChatPanel.delegateCards.ts`）—— `pill + codicon` ✓
 *   · **delegate 工具卡 meta 行**（同文件）—— **emoji 纯文本**（`⏱ / ⚡ / 💳`）+ `12.3k` 缩写 ✗✗
 *     （`.dlg-meta-item` 在 `agentChat.css` 里**一条规则都没有** ⇒ 完全是浏览器默认样式 ✗）
 * ⇒ 用户看到"同一聊天框里同样的数据长得不一样"✓ 收敛到本模块后：**图标、类名、
 *   数字格式都只有一份** ✓，新增展示位只需 `appendFooterPill()` 一行 ✓。
 *
 * ── 约定（改动前务必先读）───────────────────────────────────────────────
 * 1. **数字格式统一**（此前 token 一处 `toLocaleString()` 一处 `12.3k` ✗）：
 *    token = `formatTokenCount()`（千分位，可核对 ✓）；积分 = `formatCreditAmount()`（两位小数 ✓）；
 *    耗时 = `formatDurationMs()`（ms / s / m+s ✓）。**不要在调用点自行格式化** ✗
 * 2. **DOM 结构固定**为 `.chat-bubble-footer-item.chat-footer-pill.<kind>-item`
 *    → `.chat-footer-pill-icon.codicon.codicon-<name>` + `.chat-footer-pill-value`
 *    ⇒ 样式（含 hover、深色主题、compact 模式）由 `agentChat.css` 一处控制 ✓
 * 3. `valueClass` 只用于**抗抖动**（如 `.chat-footer-processing-elapsed` 的
 *    `min-width` + `tabular-nums`：数字位数变化时宽度不跳 ✓）；**不要**用它改字体/颜色 ✗
 */

/** 三类用量药丸。新增种类时：这里 + 两个 Record + CSS 的 `.chat-footer-pill-*` 一起改。 */
export type FooterPillKind = 'duration' | 'tokens' | 'credit';

/** 图标（codicon）。与 chat/footer 既有约定一致：时钟 / 剪贴板 / 信用卡。 */
const PILL_ICON: Record<FooterPillKind, string> = {
	duration: 'codicon-watch',
	tokens: 'codicon-clippy',
	credit: 'codicon-credit-card',
};

/** 种类专用类名（CSS 与既有 DOM 查询都依赖它，**不可随意改名** ✗）。 */
const PILL_ITEM_CLASS: Record<FooterPillKind, string> = {
	duration: 'duration-item',
	tokens: 'tokens-item',
	credit: 'credit-item',
};

/** 默认 tooltip 文案。 */
const PILL_TITLE: Record<FooterPillKind, string> = {
	duration: '耗时',
	tokens: 'Tokens',
	credit: '积分',
};

/**
 * token 数格式化（**唯一口径**）：千分位全量展示。
 *
 * 为什么不用 `12.3k` 缩写：三处展示必须**可核对**（用户会拿它跟账单/日志对 ✗），
 * 且缩写会让同一个数在不同位置读起来不同（`12.3k` vs `12,345`）✗。
 */
export function formatTokenCount(n: number): string {
	return n.toLocaleString();
}

/** 积分格式化（**唯一口径**）：两位小数。 */
export function formatCreditAmount(n: number): string {
	return n.toFixed(2);
}

/**
 * 耗时格式化（**唯一口径**）：`<1s` → `123ms`；`<60s` → `4.5s`；否则 → `2m 3s`。
 *
 * 说明：主面板的 `_formatDuration()` 现在直接委托到这里（保留方法名是因为
 * `delegateCards` 等多处按面板方法调用 ✓），确保不会出现第二套口径 ✗。
 */
export function formatDurationMs(ms: number): string {
	if (ms < 1000) { return `${Math.round(ms)}ms`; }
	const seconds = ms / 1000;
	if (seconds < 60) { return `${seconds.toFixed(1)}s`; }
	const minutes = Math.floor(seconds / 60);
	const remainSec = Math.round(seconds % 60);
	return `${minutes}m ${remainSec}s`;
}

/** `appendFooterPill` 的可选项。 */
export interface IFooterPillOptions {
	/** 数值节点的附加类（**仅用于抗抖动**，见模块注释第 3 条）。 */
	valueClass?: string;
	/** 覆盖默认 tooltip。 */
	title?: string;
	/** 追加 hover 提示图标（`ⓘ`，提示有明细浮层）。 */
	withInfoIcon?: boolean;
}

/**
 * 创建一个用量药丸并挂到 `parent`，返回药丸元素（供调用方继续 append 明细浮层 ✓）。
 *
 * 例：
 * ```ts
 * const pill = appendFooterPill(footer, 'tokens', formatTokenCount(tu.total), { withInfoIcon: true });
 * append(pill, $('div.tokens-popup'));   // 明细浮层挂在药丸内（CSS 用 :hover 控制显示）
 * ```
 */
export function appendFooterPill(
	parent: HTMLElement,
	kind: FooterPillKind,
	valueText: string,
	options: IFooterPillOptions = {},
): HTMLElement {
	const pill = append(parent, $(`span.chat-bubble-footer-item.chat-footer-pill.${PILL_ITEM_CLASS[kind]}`));
	pill.title = options.title ?? PILL_TITLE[kind];
	append(pill, $(`span.chat-footer-pill-icon.codicon.${PILL_ICON[kind]}`));
	append(
		pill,
		$(`span.chat-footer-pill-value${options.valueClass ? `.${options.valueClass}` : ''}`, undefined, valueText),
	);
	if (options.withInfoIcon) {
		append(pill, $('span.chat-footer-pill-info.codicon.codicon-info'));
	}
	return pill;
}
