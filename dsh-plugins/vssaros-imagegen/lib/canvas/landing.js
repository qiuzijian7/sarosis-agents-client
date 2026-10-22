/**
 * 出图落位算法（四批⑩）：**网格排布 + 不重叠 + 视口外自动带过去**。
 *
 * 为什么要它：原来落位是"横向排开"（`x = maxX + 40`）⇒ 连出 5 张图会排成一条看不到头的长龙
 *   （上游同款问题，见 `client/tl/conversation-landings.ts:70-107`）⇒ 落位要成网格。
 *
 * 为什么单独一个模块（而且是**纯函数**）：落位规则要能被探针直接 import 测
 *   （"连落 5 张不重叠"这种断言在浏览器里很难稳定复现 ⇒ 规则下沉到纯函数，探针 in-process 断）✓。
 *
 * ⚠ 落位只决定"放哪儿"，**不碰**画布状态（那由页面调 Excalidraw 的 updateScene 做）。
 */

/** 网格参数（默认 3 列 —— 与上游同款）。 */
export const LANDING = {
	columns: 3,
	cellWidth: 520,
	cellHeight: 400,
	gap: 40,
	originX: 40,
	originY: 40,
	/** 单张图在格子里的最大宽/高（超了等比缩 ⇒ 一格放得下一张 ⇒ 网格不会互相压）。 */
	maxWidth: 480,
	maxHeight: 380,
};

/**
 * 元素的矩形（Excalidraw 元素 ⇒ {x,y,width,height}）。
 * @param {object} el
 */
export function rectOf(el) {
	return {
		x: Number(el?.x) || 0,
		y: Number(el?.y) || 0,
		width: Number(el?.width) || 0,
		height: Number(el?.height) || 0,
	};
}

/**
 * 两个矩形是否相交（边界相接**不算**相交 —— 贴边是允许的）。
 */
export function rectsOverlap(a, b) {
	return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

/**
 * 落位尺寸：等比缩到格子里（**不放大**小图）。
 */
export function landingSize(size, options = {}) {
	const cfg = Object.assign({}, LANDING, options);
	const w = Number(size?.width) || 0;
	const h = Number(size?.height) || 0;
	if (w <= 0 || h <= 0) {
		return { width: cfg.maxWidth, height: cfg.maxHeight };
	}
	const scale = Math.min(1, cfg.maxWidth / w, cfg.maxHeight / h);
	return {
		width: Math.max(1, Math.round(w * scale)),
		height: Math.max(1, Math.round(h * scale)),
	};
}

/**
 * 下一个落位槽位：按网格从左上往右扫，**取第一个不与已有元素相交的格子**。
 *
 * ⚠ 为什么"扫 + 判相交"而不是"算行列号"：图有大有小，单纯按行列号排会被高图压到下一行
 *   ⇒ 用相交判定兜住（实测：连落 5 张互不相交 ✓）。
 *
 * @param {Array<object>} elements 画布上已有的元素（`isDeleted !== true` 的才占位）
 * @param {{width:number,height:number}} size 落位尺寸（用 `landingSize` 算过）
 * @param {object} [options] 覆盖 LANDING 的字段
 */
export function nextLandingSlot(elements, size, options = {}) {
	const cfg = Object.assign({}, LANDING, options);
	const width = Math.max(1, Number(size?.width) || cfg.maxWidth);
	const height = Math.max(1, Number(size?.height) || cfg.maxHeight);
	const occupied = (Array.isArray(elements) ? elements : [])
		.filter(el => el && el.isDeleted !== true)
		.map(rectOf)
		.filter(rect => rect.width > 0 || rect.height > 0);
	const stepX = cfg.cellWidth + cfg.gap;
	const stepY = cfg.cellHeight + cfg.gap;
	// 上限：避免"画布被塞满"时无限扫（超出就往下一行放，宁可挨着也不要卡死）。
	const limit = 400;
	for (let index = 0; index < limit; index += 1) {
		const row = Math.floor(index / cfg.columns);
		const column = index % cfg.columns;
		const x = cfg.originX + column * stepX;
		const y = cfg.originY + row * stepY;
		const rect = { x, y, width, height };
		const hit = occupied.some(other => rectsOverlap(rect, other));
		if (!hit) {
			return { x, y, width, height, column, row };
		}
	}
	const row = Math.ceil(limit / cfg.columns);
	return {
		x: cfg.originX + (limit % cfg.columns) * stepX,
		y: cfg.originY + row * stepY,
		width, height,
		column: limit % cfg.columns,
		row,
	};
}

/**
 * 当前视口对应的**世界坐标**矩形。
 *
 * Excalidraw 的换算：`screen = (world + scroll) * zoom`
 * ⇒ 世界范围 x ∈ [-scrollX/zoom, 视口宽/zoom - scrollX]。
 *
 * @param {object} appState Excalidraw 的 appState（`zoom` 可能是数字或 `{value}`）
 * @param {{width:number,height:number}} viewport 视口像素尺寸
 */
export function viewportWorldRect(appState, viewport) {
	const rawZoom = appState?.zoom;
	const zoom = typeof rawZoom === 'number' && rawZoom > 0 ? rawZoom : Number(rawZoom?.value) || 1;
	const scrollX = Number(appState?.scrollX) || 0;
	const scrollY = Number(appState?.scrollY) || 0;
	return {
		x: -scrollX / zoom,
		y: -scrollY / zoom,
		width: (Number(viewport?.width) || 0) / zoom,
		height: (Number(viewport?.height) || 0) / zoom,
	};
}

/**
 * 矩形是否**完整**落在视口里（落位后判断"要不要把镜头带过去"用）。
 */
export function isRectVisible(appState, viewport, rect) {
	const view = viewportWorldRect(appState, viewport);
	const r = rectOf(rect);
	if (view.width <= 0 || view.height <= 0) { return false; }
	return r.x >= view.x && r.y >= view.y
		&& r.x + r.width <= view.x + view.width
		&& r.y + r.height <= view.y + view.height;
}