/*---------------------------------------------------------------------------------------------
 *  Context-usage ring renderer — extracted from agentChatPanel.ts
 *  Pure DOM rendering function.
 *
 *  2026-09-04 交互优化：
 *  - tooltip 由原生 title（浏览器固定渲染在指针下方、被鼠标遮挡）改为自定义浮层，
 *    固定显示在环**上方**（.context-usage-tooltip，见 agentChat.css）；
 *  - tooltip 增加压缩触发提示：「达到 N tokens 将触发上下文压缩」；
 *  - 环上叠加**压缩线标记**：threshold/limit 对应角度处一条红色刻度线，
 *    进度弧逼近该线即临近压缩。环主体保持窗口占用刻度（used/limit）；
 *  - warn/danger 色阶改为「距压缩线」语义：≥80% 黄（临近）、≥100% 红（已过线）。
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import type { IContextUsage } from '../agentChatTypes.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const fmt = (n: number): string => n.toLocaleString('en-US');

export function renderContextUsageRing(
	parent: HTMLElement,
	usage: IContextUsage | null,
): void {
	const ringEl = append(parent, $(".context-usage-ring"));

	// 环主体：窗口占用刻度（used / limit）
	const windowPct = usage && usage.limit > 0
		? Math.max(0, Math.min(1, usage.used / usage.limit))
		: 0;
	// 距压缩线：used / thresholdTokens（warn/danger 色阶用；阈值未知时退化为窗口占比）
	const compressionPct = usage && usage.thresholdTokens && usage.thresholdTokens > 0
		? Math.max(0, Math.min(1, usage.used / usage.thresholdTokens))
		: windowPct;

	// tooltip 文案（自定义浮层，多行经 CSS white-space: pre-line 渲染）
	let tooltipText = '上下文使用';
	if (usage) {
		const lines: string[] = [
			`上下文：${fmt(usage.used)} / ${fmt(usage.limit)} tokens（${Math.round(windowPct * 100)}%）`,
		];
		if (usage.thresholdTokens && usage.thresholdTokens > 0) {
			const linePct = usage.limit > 0
				? Math.round((usage.thresholdTokens / usage.limit) * 100)
				: 0;
			lines.push(`⚠ 达到 ${fmt(usage.thresholdTokens)} tokens（窗口的 ${linePct}%）将触发上下文压缩`);
		}
		tooltipText = lines.join('\n');
	}

	if (usage) {
		if (compressionPct >= 1) { ringEl.classList.add('danger'); }
		else if (compressionPct >= 0.8) { ringEl.classList.add('warn'); }
	}
	ringEl.style.cursor = 'pointer';

	// 自定义 tooltip：上方浮层（原生 title 无法定位且被鼠标遮挡）。
	// ring 被 _doUpdateContextRing 整体重建时，tooltip 作为子元素随之移除，不会悬挂；
	// CSS pointer-events:none 防止浮层自身挡住 mouseleave 造成闪烁。
	let tipEl: HTMLElement | null = null;
	ringEl.addEventListener('mouseenter', () => {
		if (!usage || tipEl) { return; }
		tipEl = document.createElement('div');
		tipEl.className = 'context-usage-tooltip';
		tipEl.textContent = tooltipText;
		ringEl.appendChild(tipEl);
	});
	ringEl.addEventListener('mouseleave', () => {
		tipEl?.remove();
		tipEl = null;
	});

	const size = 22;
	const stroke = 2.5;
	const r = (size / 2) - stroke;
	const c = 2 * Math.PI * r;
	const offset = c * (1 - windowPct);

	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
	// 不再用 <title>：原生 title 与自定义浮层重复，且延迟出现、位置在指针下方。

	const bg = document.createElementNS(SVG_NS, 'circle');
	bg.setAttribute("cx", String(size / 2));
	bg.setAttribute("cy", String(size / 2));
	bg.setAttribute("r", String(r));
	bg.setAttribute("fill", "none");
	bg.setAttribute("stroke", "currentColor");
	bg.setAttribute("stroke-width", String(stroke));
	bg.setAttribute("opacity", "0.2");
	svg.appendChild(bg);

	const fg = document.createElementNS(SVG_NS, 'circle');
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

	// 压缩线标记：threshold/limit 对应角度处一条红色刻度线（顺时针，与进度方向一致）。
	// 只在阈值有效且小于窗口时画（threshold ≥ limit 说明被 clamp/配置异常，标记无意义）。
	if (usage && usage.thresholdTokens && usage.thresholdTokens > 0
		&& usage.limit > 0 && usage.thresholdTokens < usage.limit) {
		const markPct = Math.max(0, Math.min(1, usage.thresholdTokens / usage.limit));
		const mark = document.createElementNS(SVG_NS, 'line');
		mark.setAttribute('x1', String(size / 2));
		mark.setAttribute('y1', '0.8');
		mark.setAttribute('x2', String(size / 2));
		mark.setAttribute('y2', '4.8');
		mark.setAttribute('stroke', '#ef4444');
		mark.setAttribute('stroke-width', '1.5');
		mark.setAttribute('stroke-linecap', 'round');
		mark.setAttribute('transform', `rotate(${markPct * 360} ${size / 2} ${size / 2})`);
		svg.appendChild(mark);
	}

	ringEl.appendChild(svg);
}
