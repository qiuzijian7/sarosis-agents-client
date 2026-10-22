/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 图表渲染时报告给宿主的**可用宽度**（px）。
 *
 * 为什么要有它：pele 相对 Mermaid 的一个核心差别是——窄容器下它**改排版**（能竖排的图改竖排、
 * 长链换行），而不是把整张图等比缩小到看不清 ✗。但这个能力要靠宿主把宽度告诉它才生效。
 *
 * ⚠ 取值口径：**视口宽度减去正文留白**，而不是去量某个具体容器。
 *   为什么不用 ref 量容器：组件在 loading / error / success 三态之间切换根节点，
 *   要挂 ref 就得给三种分支都套一层 ⇒ 会改变 DOM 结构与现有 CSS ✗。视口宽度是稳定的上界，
 *   减掉一个留白常量后足够准（pele 用它只是决定"要不要改成竖排"）。
 */

/** 正文两侧留白 + 卡片内边距的经验值（宁可略小：偏小只会更早触发竖排，不会画错 ✗） */
const GUTTER = 64;

/** 下限：视口异常窄（或尚未布局）时不至于让 pele 把图挤成竖条 ✗ */
const MIN_WIDTH = 320;

export function hostDiagramWidth(): number {
	const viewport = document.documentElement?.clientWidth ?? 0;
	if (viewport <= 0) { return MIN_WIDTH; }
	return Math.max(MIN_WIDTH, viewport - GUTTER);
}
