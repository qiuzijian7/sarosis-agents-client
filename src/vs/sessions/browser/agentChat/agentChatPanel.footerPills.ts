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

/**
 * ★ 2026-09-19：三类药丸的**唯一顺序约定**（用户要求「三个 UI 的顺序在各个位置保持不变」✓）。
 *
 * 取值依据：**三处已是一致**（主气泡处理中 / 委派卡完成态 / 子代理处理中 ✓）+ 用户处理中截图里
 * 看到的就是 `耗时 → Tokens → 积分` ✓；只有**主气泡完成态**是反的（积分在最前 ✗）⇒ 以多数为准 ✓。
 *
 * 为什么要"由构建入口排序"而不是"各调用点按顺序写" ✗：
 *   `tokens` / `积分` 是**流式陆续到达**的（首个 usage delta 之前没有数据 ✓）⇒ 谁先创建**不确定** ✗；
 *   若只靠"先 append 的先在左" ⇒ 同一行在不同时刻会**换位** ✗✗。
 *   ⇒ 本入口按 `PILL_ORDER` **插入到正确位置** ✓（见 `appendFooterPill` 的实现），
 *     与调用顺序、到达顺序**都无关** ✓✓。
 */
const PILL_ORDER: Record<FooterPillKind, number> = {
	duration: 0,
	tokens: 1,
	credit: 2,
};

/**
 * **不属**三类约定、但参与排序的"尾部药丸"类名（顺序视为最大 ⇒ 永远排在三者之后 ✓）。
 *
 * 目前只有「已中断」（`_createFooter` 里手搓的 `.interrupted-item` ✓）。显式列出来的原因：
 * 它的位置原本完全依赖"恰好最后创建" ✗ —— 一旦有人提前创建或复用，就会插到三类中间 ✗。
 */
const TRAILING_ITEM_CLASSES = ['interrupted-item'] as const;

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
	/**
	 * ★ 2026-09-19：加 `live` 类 = **处理中**态（蓝色描边 + 图标呼吸 ✓，见
	 * `agentChat.css` 的 `.chat-footer-pill.live`）—— 与完成态（静止）在视觉上区分 ✓。
	 * 处理中的三个 pill（耗时 / tokens / 积分）**都要带**，否则"进行中"的信号会不一致 ✗。
	 */
	live?: boolean;
	/**
	 * ★ 2026-09-19：显示种类标签（`耗时：` / `Tokens：` / `积分：`）。
	 *
	 * 背景：主气泡完成态一直带标签、而委派卡不带 ✗ ⇒ 同一聊天框里两种形态。
	 * 收敛到本入口后，调用方**只声明要不要标签** ✓，图标/类名/数字格式不会分叉 ✓。
	 */
	withLabel?: boolean;
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
	// ⚠ 刻意**不在这里 append**：先建好、最后按 `PILL_ORDER` 插到正确位置 ✓（见 `_insertPillInOrder`）
	const pill = $(`span.chat-bubble-footer-item.chat-footer-pill.${PILL_ITEM_CLASS[kind]}${options.live ? '.live' : ''}`);
	pill.title = options.title ?? PILL_TITLE[kind];
	append(pill, $(`span.chat-footer-pill-icon.codicon.${PILL_ICON[kind]}`));
	// 标签（可选）：统一用**全角冒号**（此前主气泡里 `：` 与 `: ` 混用 ✗）
	if (options.withLabel) {
		append(pill, $('span.chat-footer-pill-label', undefined, `${PILL_TITLE[kind]}：`));
	}
	append(
		pill,
		$(`span.chat-footer-pill-value${options.valueClass ? `.${options.valueClass}` : ''}`, undefined, valueText),
	);
	if (options.withInfoIcon) {
		append(pill, $('span.chat-footer-pill-info.codicon.codicon-info'));
	}
	_insertPillInOrder(parent, pill, kind);
	return pill;
}

/**
 * 按 `PILL_ORDER` 把 `pill` 插进 `parent` 的**正确位置**（顺序不变量见 `PILL_ORDER` 注释 ✓）。
 *
 * 规则：**插到第一个「顺序比我靠后」的同类药丸之前** ✓；没有更靠后的 ⇒ 追加到末尾 ✓。
 *
 * ⚠ 只与**同类兄弟**（带已知 `*-item` 类名的 `.chat-footer-pill` ✓）比较：
 *   `parent` 里还可能有别的子元素 —— 复制按钮、`.chat-bubble-footer-sep` 分隔线、
 *   以及 `interrupted-item`（"已中断"，不属本三类约定 ✓）—— 它们**不参与排序、位置不动** ✓。
 *
 * ⚠ 用 `:scope >` 只取**直接子元素** ✓：药丸内部还有 `.chat-footer-pill-icon` 等后代，
 *   不加限定会把后代也算进来 ✗。
 */
function _insertPillInOrder(parent: HTMLElement, pill: HTMLElement, kind: FooterPillKind): void {
	const myOrder = PILL_ORDER[kind];
	const knownKinds = Object.keys(PILL_ITEM_CLASS) as FooterPillKind[];
	const siblings = Array.from(parent.querySelectorAll(':scope > .chat-footer-pill'));
	for (const sib of siblings) {
		const sibKind = knownKinds.find(k => sib.classList.contains(PILL_ITEM_CLASS[k]));
		// 非三类约定的药丸（如「已中断」）视为**排到最后** ✓：
		// 否则它们的相对位置取决于"谁先创建" ✗（当前代码恰好最后建 ✓，但很脆弱 ✗）
		const sibOrder = sibKind !== undefined
			? PILL_ORDER[sibKind]
			: (TRAILING_ITEM_CLASSES.some(c => sib.classList.contains(c)) ? Number.MAX_SAFE_INTEGER : undefined);
		if (sibOrder !== undefined && sibOrder > myOrder) {
			parent.insertBefore(pill, sib);
			return;
		}
	}
	parent.appendChild(pill);
}
