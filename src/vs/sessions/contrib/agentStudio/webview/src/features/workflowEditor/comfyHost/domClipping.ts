/*---------------------------------------------------------------------------------------------
 *  DOM widget 层级 / 裁剪 —— 严格移植 ComfyUI 前端的官方机制
 *
 *  ## 为什么需要这个文件
 *
 *  LiteGraph 把节点（标题栏、背景、端口、canvas widget）画在**一张** <canvas> 上，
 *  而 DOM widget（我们的 NodeCard）是一个覆盖在 canvas **之上**的 DOM 图层。
 *  两者是两个独立的合成层，**无法交错层叠**：任何 DOM 卡片都在任何 canvas 像素之上。
 *  于是节点重叠时必然出现「穿插」——上层节点 B 的 canvas 标题栏被下层节点 A 的
 *  DOM 卡片盖住，而 B 的 DOM 卡片又盖住 A 的卡片。
 *
 *  ComfyUI 前端遇到的是同一个问题，它的解法（`GraphView-*.js` 内 `useDomClipping`）
 *  不是调层序，而是 **用 `clip-path` 把下层卡片上被上层节点覆盖的那块挖掉**：
 *
 *  ```js
 *  // ComfyUI: useDomClipping()
 *  const isect = intersect(
 *    { x: elRect.left - canvasRect.left, y: elRect.top - canvasRect.top, width, height },
 *    { x: (area.x + offset[0] - margin) * scale, y: (area.y + offset[1] - margin) * scale,
 *      width: (area.width + 2 * margin) * scale, height: (area.height + 2 * margin) * scale },
 *  );
 *  // → polygon(...) 在元素的局部（未缩放）坐标系里挖出一个矩形缺口
 *  ```
 *
 *  层级本身则由 z-index 决定，同样来自 ComfyUI（`getDomWidgetZIndex`）：
 *
 *  ```js
 *  function getDomWidgetZIndex(node, graph) {
 *    if (!graph) return node.order ?? -1;
 *    const i = graph.nodes.indexOf(node);
 *    return i === -1 ? (node.order ?? -1) : i;
 *  }
 *  ```
 *
 *  也就是说 **DOM widget 的 z-index === 节点在 `graph.nodes` 中的下标**，与 LiteGraph
 *  绘制 canvas 的顺序完全同源（`bringToFront` 会把节点移到数组末尾 → z 最大 → 最上）。
 *  ComfyUI 从不重排 DOM 顺序，也没有 hover 提升。
 *
 *  ## 与 ComfyUI 的唯一差异（严格增强，非偏离）
 *
 *  ComfyUI 只挖「当前选中节点」这一个洞（`selected_nodes` 的第一个），所以未选中
 *  的静态重叠仍会穿插。本实现把同一技术推广为「挖掉所有层级在我之上的节点」：
 *  多个缺口用 `clip-path: path(evenodd, ...)` 表达（单洞时与 ComfyUI 的 polygon
 *  等价）。这样任意重叠组合下 canvas 与 DOM 的观感都与 z 序一致。
 *
 *  本文件是**纯函数**（无 DOM 依赖），便于单测。
 *--------------------------------------------------------------------------------------------*/

/** 轴对齐矩形。所有函数内的单位要么全是 overlay layer 的 CSS px，要么全是 graph 单位。 */
export interface ClipRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** ComfyUI `useDomClipping` 的 margin，graph 单位。 */
export const CLIP_MARGIN = 4;

/**
 * ComfyUI `intersect()` 的等价实现。
 * 返回 `[x, y, width, height]`；无交集（含相切）返回 `null`。
 */
export function intersectRect(a: ClipRect, b: ClipRect): [number, number, number, number] | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (x >= right || y >= bottom) { return null; }
	return [x, y, right - x, bottom - y];
}

/**
 * 节点 `renderArea`（graph 单位，`[x, y, w, h]`，已含标题栏与外部装饰）
 * → overlay layer 内的 CSS px 矩形，并按 ComfyUI 的做法外扩 `margin`。
 *
 * 与 `nodeToOverlayRect` 同一套坐标变换：`screen = (graph + offset) * scale`。
 */
export function renderAreaToLayerRect(
	area: ArrayLike<number>,
	offset: readonly [number, number],
	scale: number,
	margin: number = CLIP_MARGIN,
): ClipRect {
	return {
		x: (area[0] + offset[0] - margin) * scale,
		y: (area[1] + offset[1] - margin) * scale,
		width: (area[2] + margin * 2) * scale,
		height: (area[3] + margin * 2) * scale,
	};
}

/** clip-path 数值精度：2 位小数足够，避免每帧生成超长字符串。 */
function round(v: number): number {
	return Math.round(v * 100) / 100;
}

/**
 * 生成容器的 `clip-path` 值。
 *
 * @param el     容器在 overlay layer 内的 px 矩形（视觉尺寸，即已乘 scale）
 * @param holes  需要挖掉的矩形（同一坐标系，通常是层级在其之上的节点 renderArea）
 * @param scale  容器 `transform: scale()` 的倍率
 *
 * `clip-path` 在元素**未变换**的局部坐标系中求值，所以所有长度都要 `/ scale`
 * （ComfyUI 的 `polygon()` 版本里同样有 `/ r` 这一步）。
 *
 * @returns 空串表示无需裁剪（调用方应写 `'none'`）。
 */
export function buildClipPath(el: ClipRect, holes: readonly ClipRect[], scale: number): string {
	if (scale <= 0 || el.width <= 0 || el.height <= 0) { return ''; }
	const cuts: string[] = [];
	for (const hole of holes) {
		const isect = intersectRect(el, hole);
		if (!isect) { continue; }
		const hx = (isect[0] - el.x) / scale;
		const hy = (isect[1] - el.y) / scale;
		const hw = isect[2] / scale;
		const hh = isect[3] / scale;
		if (hw <= 0.01 || hh <= 0.01) { continue; }
		cuts.push(`M${round(hx)} ${round(hy)}H${round(hx + hw)}V${round(hy + hh)}H${round(hx)}Z`);
	}
	if (cuts.length === 0) { return ''; }
	const w = el.width / scale;
	const h = el.height / scale;
	// evenodd：外框顺时针一圈，每个缺口再画一圈 → 重叠区域被判为"外部"从而挖空。
	return `path(evenodd, "M0 0H${round(w)}V${round(h)}H0Z ${cuts.join(' ')}")`;
}

/**
 * ComfyUI `getDomWidgetZIndex` 的等价实现。
 *
 * DOM widget 的 z-index **就是**节点在 `graph.nodes` 里的下标，与 LiteGraph 绘制
 * canvas 的顺序同源。找不到节点时回退到 `node.order`（ComfyUI 原样行为）。
 *
 * 注意：CSS `z-index: 0` 与 `auto` 在同一 stacking context 下容易出歧义，
 * 调用方统一 `+1` 后写入（本函数保持与 ComfyUI 一致，返回原始下标）。
 */
export function domWidgetZIndex(nodeIndex: number, order: number | undefined): number {
	return nodeIndex === -1 ? (order ?? -1) : nodeIndex;
}
