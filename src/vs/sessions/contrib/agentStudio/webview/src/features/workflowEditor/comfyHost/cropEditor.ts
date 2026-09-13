/*---------------------------------------------------------------------------------------------
 *  cropEditor — 交互式裁剪的纯逻辑（ComfyTV CropStage 增强）。
 *
 *  CropStage 是 instant（浏览器本地）节点，执行器用像素 x/y/width/height
 *  裁剪上游图像（见 instantNodes.ts cropRect）。本模块提供编辑器所需的无 UI 逻辑：
 *    - 归一化裁剪框 ↔ 像素矩形 互转（编辑器画布用归一化 0-1，输出用像素）
 *    - 拖拽命中测试（8 个手柄 + 内部移动 + 新框拖选）
 *    - clamp 到图像边界
 *  全部纯函数，可单测。
 *--------------------------------------------------------------------------------------------*/

export interface CropRectPx { x: number; y: number; width: number; height: number }
export interface CropRectNorm { x: number; y: number; w: number; h: number }

/** 手柄 id：四角 + 四边中点 + 内部移动。 */
export type CropHandle = 'tl' | 'tr' | 'bl' | 'br' | 'l' | 'r' | 't' | 'b' | 'move';

export const CROP_HANDLES: CropHandle[] = ['tl', 'tr', 'bl', 'br', 'l', 'r', 't', 'b'];

/** 像素 → 归一化（0-1）。 */
export function pxToNorm(px: CropRectPx, imgW: number, imgH: number): CropRectNorm {
	const w = Math.max(1, imgW || 1);
	const h = Math.max(1, imgH || 1);
	const x = Math.max(0, Math.min(px.x, w));
	const y = Math.max(0, Math.min(px.y, h));
	const cw = Math.max(1, Math.min(px.width, w - x));
	const ch = Math.max(1, Math.min(px.height, h - y));
	return { x: x / w, y: y / h, w: cw / w, h: ch / h };
}

/** 归一化 → 像素（round，clamp 到图像边界）。 */
export function normToPx(n: CropRectNorm, imgW: number, imgH: number): CropRectPx {
	const x = Math.max(0, Math.min(Math.round(n.x * imgW), imgW - 1));
	const y = Math.max(0, Math.min(Math.round(n.y * imgH), imgH - 1));
	const w = Math.max(1, Math.min(Math.round(n.w * imgW), imgW - x));
	const h = Math.max(1, Math.min(Math.round(n.h * imgH), imgH - y));
	return { x, y, width: w, height: h };
}

/** 全图裁剪框（像素）。 */
export function fullCrop(imgW: number, imgH: number): CropRectPx {
	return { x: 0, y: 0, width: imgW, height: imgH };
}

/** 全图裁剪框（归一化）。 */
export function fullCropNorm(): CropRectNorm {
	return { x: 0, y: 0, w: 1, h: 1 };
}

/** 命中测试：给定归一化坐标点，返回命中的手柄（或 null 表示未命中框）。 */
export function hitTestCrop(n: CropRectNorm, nx: number, ny: number, tolerance: number): CropHandle | null {
	const HANDLE: Array<[CropHandle, number, number]> = [
		['tl', n.x, n.y],
		['tr', n.x + n.w, n.y],
		['bl', n.x, n.y + n.h],
		['br', n.x + n.w, n.y + n.h],
		['l', n.x, n.y + n.h / 2],
		['r', n.x + n.w, n.y + n.h / 2],
		['t', n.x + n.w / 2, n.y],
		['b', n.x + n.w / 2, n.y + n.h],
	];
	for (const [id, hx, hy] of HANDLE) {
		if (Math.hypot(hx - nx, hy - ny) <= tolerance) { return id; }
	}
	if (nx >= n.x && nx <= n.x + n.w && ny >= n.y && ny <= n.y + n.h) { return 'move'; }
	return null;
}

/**
 * 把裁切框约束到指定宽高比（aspect = w/h）。保持手柄对应的「对侧角」不动。
 * 对齐 ComfyTV useImageCrop 的长宽比锁定行为：自由拖拽后按主驱动维度回正比例。
 */
export function enforceAspect(b: CropRectNorm, aspect: number, handle: CropHandle): CropRectNorm {
	if (!isFinite(aspect) || aspect <= 0 || handle === 'move' || handle === 'new') { return b; }
	let { x, y, w, h } = b;
	w = Math.max(0.02, w);
	h = Math.max(0.02, h);
	// 选择主驱动维度：取能形成更大框的一方，贴近用户拖拽意图。
	let nw: number, nh: number;
	if (w / aspect > h) { nw = w; nh = w / aspect; }
	else { nh = h; nw = h * aspect; }
	// 对侧锚点（handle 不动的那一角）
	let ax = x, ay = y;
	if (handle === 'tl') { ax = x + w; ay = y + h; }
	else if (handle === 'tr') { ax = x; ay = y + h; }
	else if (handle === 'bl') { ax = x + w; ay = y; }
	else if (handle === 'br') { ax = x; ay = y; }
	else if (handle === 'l') { ax = x + w; ay = y; }
	else if (handle === 'r') { ax = x; ay = y; }
	else if (handle === 't') { ax = x; ay = y + h; }
	else if (handle === 'b') { ax = x; ay = y; }
	// 由锚点反推新左上角
	let nx = ax, ny = ay;
	if (handle === 'tl') { nx = ax - nw; ny = ay - nh; }
	else if (handle === 'tr') { nx = ax; ny = ay - nh; }
	else if (handle === 'bl') { nx = ax - nw; ny = ay; }
	else if (handle === 'br') { nx = ax; ny = ay; }
	else if (handle === 'l') { nx = ax - nw; ny = ay; }
	else if (handle === 'r') { nx = ax; ny = ay; }
	else if (handle === 't') { nx = ax; ny = ay - nh; }
	else if (handle === 'b') { nx = ax; ny = ay; }
	nx = Math.max(0, Math.min(1 - nw, nx));
	ny = Math.max(0, Math.min(1 - nh, ny));
	return { x: nx, y: ny, w: nw, h: nh };
}

/** 拖拽手柄/移动后得到新归一化框。origin = 拖拽起点，start = 拖拽前的框。 */
export function dragCrop(
	handle: CropHandle,
	start: CropRectNorm,
	originNx: number,
	originNy: number,
	nx: number,
	ny: number,
	aspect?: number | null,
): CropRectNorm {
	const dx = nx - originNx;
	const dy = ny - originNy;
	const clampX = (v: number) => Math.max(0, Math.min(1, v));
	const clampY = (v: number) => Math.max(0, Math.min(1, v));

	if (handle === 'move') {
		// ★ 整体移动：位置 clamp 到 [0, 1-w] / [0, 1-h]，**尺寸恒定**。
		//   此前只把 newX/newY clamp 到 [0,1]，再用 `Math.min(start.w, 1 - newX)`
		//   反推宽高 → 拖到右/下边缘时框被「挤扁」（尺寸缩小）而不是停住，
		//   松手后裁剪区域与用户看到的不一致。语义对齐 MiniImageEditor 的框内拖动
		//   （`x: Math.max(0, Math.min(1 - o.w, o.x + dx))`）。
		const maxX = Math.max(0, 1 - start.w);
		const maxY = Math.max(0, 1 - start.h);
		return {
			x: Math.max(0, Math.min(maxX, start.x + dx)),
			y: Math.max(0, Math.min(maxY, start.y + dy)),
			w: start.w,
			h: start.h,
		};
	}
	// resize handles: keep opposite corner anchored
	let { x, y, w, h } = start;
	// ★ 被拖动的「上边 / 左边」除了夹到图界，还**不得越过对边**：否则越过临界点后
	//   反推出的尺寸变负 → 被 MIN_WH 兜住，框会翻到锚点另一侧（视觉上「跳一下」）。
	//   MiniImageEditor 的四角手柄本来就有这层守卫（clamp(n.y, 0, y1 - 0.02)），此处对齐。
	const MIN_WH = 0.02;
	const clampTop = (v: number) => Math.min(clampY(v), start.y + start.h - MIN_WH);
	const clampLeft = (v: number) => Math.min(clampX(v), start.x + start.w - MIN_WH);
	if (handle === 'tl') {
		x = clampLeft(start.x + dx); y = clampTop(start.y + dy);
		w = start.x + start.w - x; h = start.y + start.h - y;
	} else if (handle === 'tr') {
		y = clampTop(start.y + dy);
		w = start.w + dx; h = start.y + start.h - y;
	} else if (handle === 'bl') {
		x = clampLeft(start.x + dx);
		w = start.x + start.w - x; h = start.h + dy;
	} else if (handle === 'br') {
		w = start.w + dx; h = start.h + dy;
	} else if (handle === 'l') {
		x = clampLeft(start.x + dx); w = start.x + start.w - x;
	} else if (handle === 'r') {
		w = start.w + dx;
	} else if (handle === 't') {
		y = clampTop(start.y + dy); h = start.y + start.h - y;
	} else if (handle === 'b') {
		h = start.h + dy;
	}
	// clamp sizes to image bounds (keep anchored corner)
	if (handle !== 't' && handle !== 'tl' && handle !== 'tr') { h = Math.min(h, 1 - y); }
	if (handle !== 'l' && handle !== 'tl' && handle !== 'bl') { w = Math.min(w, 1 - x); }
	w = Math.max(MIN_WH, w);
	h = Math.max(MIN_WH, h);
	let box = { x, y, w, h };
	if (aspect) { box = enforceAspect(box, aspect, handle); }
	return box;
}

/** 从起点拖出一个新框（拖选）。 */
export function dragNewCrop(originNx: number, originNy: number, nx: number, ny: number, aspect?: number | null): CropRectNorm {
	const x = Math.max(0, Math.min(originNx, nx));
	const y = Math.max(0, Math.min(originNy, ny));
	const w = Math.max(0.02, Math.abs(nx - originNx));
	const h = Math.max(0.02, Math.abs(ny - originNy));
	let box = { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
	if (aspect) { box = enforceAspect(box, aspect, 'br'); }
	return box;
}
