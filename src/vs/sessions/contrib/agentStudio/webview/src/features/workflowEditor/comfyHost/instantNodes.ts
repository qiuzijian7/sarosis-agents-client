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

/** Rotation angle in degrees (default 90; ComfyTV rotate steps). Pure. */
export function rotateDegrees(values: Record<string, unknown>): number {
	const n = Number(values['angle'] ?? values['degrees']);
	if (!Number.isFinite(n)) { return 90; }
	return ((n % 360) + 360) % 360;
}

/** Mirror flips (horizontal/vertical toggles). Pure. */
export function mirrorFlip(values: Record<string, unknown>): { h: boolean; v: boolean } {
	return {
		h: values['horizontal'] === true || values['horizontal'] === 1 || values['horizontal'] === '1',
		v: values['vertical'] === true || values['vertical'] === 1 || values['vertical'] === '1',
	};
}

/** Output canvas size after the transform (crop shrinks, others keep source). Pure. */
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
	return { w: srcW, h: srcH };
}

/**
 * Apply the instant transform onto a canvas 2D context. The context is passed
 * as a structural interface so the e2e suite can drive a recording fake.
 * `srcW/srcH` are the source image dimensions; crop draws the sub-rectangle.
 */
export function applyInstantDraw(
	ctx: { drawImage?: (img: unknown, ...args: number[]) => void; translate?: (...a: number[]) => void; rotate?: (r: number) => void; scale?: (...a: number[]) => void },
	type: string,
	values: Record<string, unknown>,
	srcW: number,
	srcH: number,
): void {
	if (type === 'ComfyTV.CropStage') {
		const r = cropRect(values, srcW, srcH);
		ctx.drawImage?.('__SRC__', r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
		return;
	}
	if (type === 'ComfyTV.RotateStage') {
		const deg = rotateDegrees(values);
		ctx.translate?.(srcW / 2, srcH / 2);
		ctx.rotate?.((deg * Math.PI) / 180);
		ctx.translate?.(-srcW / 2, -srcH / 2);
		ctx.drawImage?.('__SRC__', 0, 0, srcW, srcH);
		return;
	}
	if (type === 'ComfyTV.MirrorStage') {
		const f = mirrorFlip(values);
		ctx.translate?.(f.h ? srcW : 0, f.v ? srcH : 0);
		ctx.scale?.(f.h ? -1 : 1, f.v ? -1 : 1);
		ctx.drawImage?.('__SRC__', 0, 0, srcW, srcH);
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
	'ComfyTV.RotateStage': [
		{ name: 'angle', type: 'INT', default: 90 },
	],
	'ComfyTV.MirrorStage': [
		{ name: 'horizontal', type: 'BOOLEAN', default: true },
		{ name: 'vertical', type: 'BOOLEAN', default: false },
	],
};
