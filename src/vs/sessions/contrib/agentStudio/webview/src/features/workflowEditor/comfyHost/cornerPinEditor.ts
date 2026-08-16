/*---------------------------------------------------------------------------------------------
 *  cornerPinEditor — ComfyTV Corner Pin support (P3 embedded editor).
 *
 *  Corner Pin 是 fx-chain VideoFX stage：隐藏 `corners` input 存
 *  `[[x1,y1],[x2,y2],[x3,y3],[x4,y4]]`（TL, TR, BR, BL，**像素坐标**，非归一化）。
 *  对齐 ComfyTV useCornerPinEditor.ts：
 *    - defaultCorners(vw, vh) = [[0,0],[vw,0],[vw,vh],[0,vh]]（全图角点）
 *    - serializeCorners 保留 1 位小数（Math.round(x*10)/10）
 *    - parseCorners(raw, vw, vh) 需视频宽高；非法/空 → 默认全图
 *    - nearestCornerIndex 命中距离 CORNER_HIT_PX=24（像素，除以 fit scale）
 *  本项目用 2D canvas 绘制（对齐 ComfyTV 的 video viewport overlay 简化版）。
 *--------------------------------------------------------------------------------------------*/

export type CornerPoint = [number, number];
export type Corners = [CornerPoint, CornerPoint, CornerPoint, CornerPoint];

export const CORNER_LABELS: readonly string[] = ['TL', 'TR', 'BR', 'BL'];
export const CORNER_HIT_PX = 24;

/** 全图角点（像素坐标），对齐 ComfyTV defaultCorners(vw, vh)。 */
export function defaultCorners(vw: number, vh: number): Corners {
	return [[0, 0], [vw, 0], [vw, vh], [0, vh]];
}

/** Parse + validate corners JSON（像素坐标）；非法/空回退全图。Pure. */
export function parseCorners(value: unknown, vw: number, vh: number): Corners {
	if (typeof value === 'string' && value.trim()) {
		try {
			const data = JSON.parse(value);
			if (Array.isArray(data) && data.length === 4 && data.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number')) {
				return data as Corners;
			}
		} catch { /* fall through */ }
	}
	if (!vw) { return [[0, 0], [0, 0], [0, 0], [0, 0]]; }
	return defaultCorners(vw, vh);
}

/** Serialize corners（像素坐标）保留 1 位小数，对齐 ComfyTV serializeCorners。 */
export function serializeCorners(corners: Corners): string {
	return JSON.stringify(corners.map(p => p.map(n => Math.round(n * 10) / 10)));
}

/** 兼容别名（旧名 cornersToJson）。 */
export const cornersToJson = serializeCorners;

/** Clamp 像素坐标到视频范围 [min, vw-1]/[min, vh-1]。 */
export function clampCorner(point: CornerPoint, vw: number, vh: number, min = 1): CornerPoint {
	return [
		Math.max(min, Math.min(vw - min, point[0])),
		Math.max(min, Math.min(vh - min, point[1])),
	];
}

/** 命中测试：返回最近角点索引（-1 无命中）。距离用像素，对齐 nearestCornerIndex。 */
export function nearestCornerIndex(pts: Corners, px: number, py: number): number {
	let best = -1;
	let bestD = CORNER_HIT_PX;
	for (let i = 0; i < 4; i++) {
		const d = Math.hypot(pts[i][0] - px, pts[i][1] - py);
		if (d < bestD) { bestD = d; best = i; }
	}
	return best;
}

/** Corner Pin 由四角拖拽编辑器处理。 */
export function isCornerPinNode(type: string): boolean {
	return type === 'ComfyTV.CornerPinStage';
}
