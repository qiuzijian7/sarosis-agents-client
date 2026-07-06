/*---------------------------------------------------------------------------------------------
 *  Context-usage ring renderer — extracted from agentChatPanel.ts
 *  Pure DOM rendering function.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import type { IContextUsage } from '../agentChatTypes.js';

export function renderContextUsageRing(
	parent: HTMLElement,
	usage: IContextUsage | null,
): void {
	const ringEl = append(parent, $(".context-usage-ring"));
	const pct = usage ? Math.max(0, Math.min(1, usage.ratio)) : 0;
	const tooltipText = usage
		? `上下文 ${Math.round(pct * 100)}% (${usage.used} / ${usage.limit})\n输入: ${usage.used} / 上下文窗口: ${usage.limit}`
		: '上下文使用';
	ringEl.title = tooltipText;
	ringEl.style.cursor = 'pointer';
	if (usage) {
		if (pct >= 0.9) { ringEl.classList.add('danger'); }
		else if (pct >= 0.7) { ringEl.classList.add('warn'); }
	}

	const size = 22;
	const stroke = 2.5;
	const r = (size / 2) - stroke;
	const c = 2 * Math.PI * r;
	const offset = c * (1 - pct);

	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
	const svgTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
	svgTitle.textContent = tooltipText;
	svg.appendChild(svgTitle);

	const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	bg.setAttribute("cx", String(size / 2));
	bg.setAttribute("cy", String(size / 2));
	bg.setAttribute("r", String(r));
	bg.setAttribute("fill", "none");
	bg.setAttribute("stroke", "currentColor");
	bg.setAttribute("stroke-width", String(stroke));
	bg.setAttribute("opacity", "0.2");
	svg.appendChild(bg);

	const fg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	fg.setAttribute("cx", String(size / 2));
	fg.setAttribute("cy", String(size / 2));
	fg.setAttribute("r", String(r));
	fg.setAttribute("fill", "none");
	fg.setAttribute("stroke", "currentColor");
	fg.setAttribute("stroke-width", String(stroke));
	fg.setAttribute("stroke-dasharray", String(c));
	fg.setAttribute("stroke-dashoffset", String(offset));
	fg.setAttribute("stroke-linecap", "round");
	fg.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
	fg.classList.add('ring-progress');
	svg.appendChild(fg);

	ringEl.appendChild(svg);
}
