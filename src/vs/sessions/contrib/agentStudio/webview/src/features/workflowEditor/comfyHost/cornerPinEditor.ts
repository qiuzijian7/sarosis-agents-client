/*---------------------------------------------------------------------------------------------
 *  cornerPinEditor — ComfyTV Corner Pin support (P3 embedded editor).
 *
 *  Corner Pin is an fx-chain VideoFX stage: hidden `corners` input holds
 *  `[[x1,y1],[x2,y2],[x3,y3],[x4,y4]]` (TL, TR, BR, BL, normalized 0..1) plus
 *  optional `keyframes` / `track`; the stage itself is already routed through
 *  the fx-chain executor. This module only provides the corner data contract,
 *  normalization and the four-corner drag editor glue.
 *--------------------------------------------------------------------------------------------*/

export type CornerPoint = [number, number];

export type Corners = [CornerPoint, CornerPoint, CornerPoint, CornerPoint];

export const CORNER_LABELS: readonly string[] = ['TL', 'TR', 'BR', 'BL'];

/** Default pin: a centered trapezoid so the effect is immediately visible. */
export function defaultCorners(): Corners {
	return [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
}

/** Parse + validate the ComfyTV corners JSON; falls back to defaults. Pure. */
export function parseCorners(value: unknown): Corners {
	if (typeof value !== 'string' || !value.trim()) { return defaultCorners(); }
	try {
		const data = JSON.parse(value);
		if (Array.isArray(data) && data.length === 4 && data.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number')) {
			return data as Corners;
		}
	} catch { /* fall through */ }
	return defaultCorners();
}

/** Serialize corners to the ComfyTV JSON string (2 decimals). Pure. */
export function cornersToJson(corners: Corners): string {
	return JSON.stringify(corners.map(p => p.map(n => Math.round(n * 100) / 100)));
}

/** Clamp a corner into the usable canvas area. Pure. */
export function clampCorner(point: CornerPoint, min = 0.02, max = 0.98): CornerPoint {
	return [Math.max(min, Math.min(max, point[0])), Math.max(min, Math.min(max, point[1]))];
}

/** Corner Pin is handled by the four-corner drag editor inside the node popup. */
export function isCornerPinNode(type: string): boolean {
	return type === 'ComfyTV.CornerPinStage';
}
