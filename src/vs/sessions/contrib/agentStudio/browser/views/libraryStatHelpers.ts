/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「资料库系」侧栏面板的共用 DOM 助手 —— 从 `knowledgeBaseView.ts` 的三个私有方法**逐字搬出**。
 *
 * 为什么要单独一个文件：拆分「资料库」后，`memoryLibraryView` / `codebaseLibraryView` 两个新面板
 * 要用**同一套**标题按钮与统计格子（`.kb-hbtn` / `.kb-stat-cell` / `.kb-stats-hint`，
 * 样式在 `views/media/kbView.css`）。复制第二三份必然漂移 ⇒ 新面板统一走这里。
 *
 * ⚠ `knowledgeBaseView.ts` 里那三份**暂未改动**（收尾期再把它们也指过来）。也就是说，
 * 这一轮之后仓库里会有「本文件 + kb 页私有副本」两处实现 —— 是**有意**的过渡，不是遗漏。
 */

import { $ } from '../../../../../base/browser/dom.js';

/** 标题栏上的 codicon 按钮（统一尺寸/悬停态，样式见 kbView.css 的 `.kb-hbtn`）。 */
export function headerBtn(icon: string, title: string, onclick: (e: MouseEvent) => void): HTMLElement {
	const btn = $('span.kb-hbtn.codicon.' + icon);
	btn.title = title;
	btn.setAttribute('role', 'button');
	btn.setAttribute('aria-label', title);
	btn.onclick = onclick;
	return btn;
}

/** 统计区的提示行（占位 / 空态）。 */
export function statsHint(text: string): HTMLElement {
	const el = $('div.kb-stats-hint');
	el.textContent = text;
	return el;
}

/** 单个统计格子（数值 + 标签；0 时灰显）。value 可传已格式化的字符串（如体积）。 */
export function statCell(label: string, value: number | string): HTMLElement {
	const cell = $('div.kb-stat-cell');
	if (value === 0 || value === '0') { cell.classList.add('zero'); }
	const n = $('span.kb-stat-num');
	n.textContent = String(value);
	const l = $('span.kb-stat-label');
	l.textContent = label;
	cell.replaceChildren(n, l);
	return cell;
}
