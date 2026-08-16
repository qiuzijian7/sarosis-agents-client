/*---------------------------------------------------------------------------------------------
 *  instantNodes — ComfyTV "instant" stages processed locally in the browser
 *  (Crop / Rotate / Mirror), mirroring the subset that needs no GPU. The whole
 *  transform math is pure and unit-testable; the executor applies it onto a
 *  Canvas and uploads the result through the runner.
 *--------------------------------------------------------------------------------------------*/

import type { NodeSpec } from './registry.js';

/** ComfyTV instant (browser-local) stages currently supported. */
export function isInstantNode(type: string): boolean {
	return type === 'ComfyTV.CropStage'
		|| type === 'ComfyTV.RotateStage'
		|| type === 'ComfyTV.MirrorStage';
}

/** Clamp a numeric field (pixels) to the source bounds; missing → source dim. Pure. */
export function instantNum(values: Record<string, unknown>, key: string, fallback: number): number {
	const n = Number(values[key]);
	return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

/**
 * Crop rectangle in source pixels (x/y default 0, w/h default full image).
 * Pure.
 */
export function cropRect(
	values: Record<string, unknown>,
	srcW: number,
	srcH: number,
): { x: number; y: number; w: number; h: number } {
	const x = instantNum(values, 'x', 0);
	const y = instantNum(values, 'y', 0);
	const w = Math.min(instantNum(values, 'width', srcW), srcW - x);
	const h = Math.min(instantNum(values, 'height', srcH), srcH - y);
	return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
}

/**
 * Rotation angle in degrees. Pure.
 *
 * 默认 **0**（对齐 ComfyTV `RotateStageCard.vue` 的
 * `useNumWidget(node, 'angle', 0)`）。此前默认 90 会让刚落下的 Rotate 节点
 * 未经用户操作就把上游图旋转 90°，与参考实现不一致。
 */
export function rotateDegrees(values: Record<string, unknown>): number {
	const n = Number(values['angle'] ?? values['degrees']);
	if (!Number.isFinite(n)) { return 0; }
	return ((n % 360) + 360) % 360;
}

/** 布尔控件取值：兼容 true / 1 / '1' / 'true'。纯函数。 */
function truthy(v: unknown): boolean {
	return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Mirror flips (horizontal/vertical toggles). Pure.
 *
 * 同时接受 ComfyTV 上游字段名 `flip_horizontal` / `flip_vertical`
 * （见 `MirrorStageCard.vue` 的 `useBoolWidget(node, 'flip_horizontal', false)`），
 * 以便直接导入 ComfyTV 导出的工作流 JSON 不丢参数。
 */
export function mirrorFlip(values: Record<string, unknown>): { h: boolean; v: boolean } {
	return {
		h: truthy(values['horizontal']) || truthy(values['flip_horizontal']),
		v: truthy(values['vertical']) || truthy(values['flip_vertical']),
	};
}

/**
 * 旋转后的外接矩形尺寸（对齐 ComfyTV `imageOrientPreview.rotatedSize`）。
 * 纯函数。非 90° 倍数的角度会让画布变大，否则图像四角被裁掉。
 *
 * EPS 容差不可省：`Math.cos(Math.PI/2)` 是 6.12e-17 而非精确 0，于是
 * 100×50 旋转 90° 会算出 50.000000000000006，被 `Math.ceil` 放大成 51 —— 每次
 * 90° 旋转都凭空多 1px，反复旋转会持续漂移。
 */
export function rotatedSize(w: number, h: number, deg: number): { w: number; h: number } {
	const rad = (deg * Math.PI) / 180;
	const cosT = Math.abs(Math.cos(rad));
	const sinT = Math.abs(Math.sin(rad));
	const EPS = 1e-9;
	return {
		w: Math.max(1, Math.ceil(w * cosT + h * sinT - EPS)),
		h: Math.max(1, Math.ceil(w * sinT + h * cosT - EPS)),
	};
}

/** Output canvas size after the transform (crop shrinks, rotate grows, mirror keeps). Pure. */
export function instantOutputSize(
	type: string,
	values: Record<string, unknown>,
	srcW: number,
	srcH: number,
): { w: number; h: number } {
	if (type === 'ComfyTV.CropStage') {
		const r = cropRect(values, srcW, srcH);
		return { w: r.w, h: r.h };
	}
	if (type === 'ComfyTV.RotateStage') {
		return rotatedSize(srcW, srcH, rotateDegrees(values));
	}
	return { w: srcW, h: srcH };
}

/**
 * Apply the instant transform onto a canvas 2D context. The context is passed
 * as a structural interface so the e2e suite can drive a recording fake.
 * `srcW/srcH` are the source image dimensions; crop draws the sub-rectangle.
 *
 * `src` is the actual drawable image source (ImageBitmap / HTMLImageElement /
 * HTMLCanvasElement). It defaults to the `'__SRC__'` sentinel so the recording
 * fake used by the e2e suite keeps asserting on a stable, printable value.
 * **Production callers MUST pass the real bitmap** — handing the sentinel to a
 * real CanvasRenderingContext2D throws
 * `TypeError: Failed to execute 'drawImage' … not of type '(CSSImageValue or …)'`.
 */
export function applyInstantDraw(
	ctx: { drawImage?: (img: unknown, ...args: number[]) => void; translate?: (...a: number[]) => void; rotate?: (r: number) => void; scale?: (...a: number[]) => void },
	type: string,
	values: Record<string, unknown>,
	srcW: number,
	srcH: number,
	src: unknown = '__SRC__',
): void {
	if (type === 'ComfyTV.CropStage') {
		const r = cropRect(values, srcW, srcH);
		ctx.drawImage?.(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
		return;
	}
	if (type === 'ComfyTV.RotateStage') {
		const deg = rotateDegrees(values);
		// 旋转画布尺寸由 instantOutputSize 给出（可能大于源图），围绕**输出**中心
		// 旋转再把源图居中绘制，避免大角度旋转时被裁角。
		const out = instantOutputSize(type, values, srcW, srcH);
		ctx.translate?.(out.w / 2, out.h / 2);
		ctx.rotate?.((deg * Math.PI) / 180);
		ctx.drawImage?.(src, -srcW / 2, -srcH / 2, srcW, srcH);
		return;
	}
	if (type === 'ComfyTV.MirrorStage') {
		const f = mirrorFlip(values);
		ctx.translate?.(f.h ? srcW : 0, f.v ? srcH : 0);
		ctx.scale?.(f.h ? -1 : 1, f.v ? -1 : 1);
		ctx.drawImage?.(src, 0, 0, srcW, srcH);
	}
}

/** Widgets used to register the instant stages in the palette. */
export const INSTANT_WIDGETS: Record<string, NodeSpec['widgets']> = {
	'ComfyTV.CropStage': [
		{ name: 'x', type: 'INT', default: 0 },
		{ name: 'y', type: 'INT', default: 0 },
		{ name: 'width', type: 'INT', default: 512 },
		{ name: 'height', type: 'INT', default: 512 },
	],
	// 默认值对齐 ComfyTV RotateStageCard / MirrorStageCard：angle=0、
	// flip_horizontal=false、flip_vertical=false —— 刚落下的节点是「直通」，
	// 由用户主动点按钮/拖滑块才产生变换。
	'ComfyTV.RotateStage': [
		{ name: 'angle', type: 'INT', default: 0, min: -180, max: 180 },
	],
	'ComfyTV.MirrorStage': [
		{ name: 'horizontal', type: 'BOOLEAN', default: false },
		{ name: 'vertical', type: 'BOOLEAN', default: false },
	],
};
