/*---------------------------------------------------------------------------------------------
 *  rotoMaskEditor — ComfyTV Roto Mask support (P3 embedded editor).
 *
 *  Roto Mask is an fx-chain VideoFX stage: hidden `shape_keys` input holds
 *  `[{t: seconds, points: [{x,y,lx,ly,rx,ry}]}]` — per-keyframe Bezier splines
 *  with NORMALIZED (0..1) coordinates and left/right tangent handles per
 *  vertex (SVG path semantics: lx/ly = incoming control point, rx/ry =
 *  outgoing control point). The stage itself is already routed through the
 *  fx-chain executor; this module only provides the spline data contract and
 *  vertex math.
 *--------------------------------------------------------------------------------------------*/

export interface RotoPoint {
	x: number;
	y: number;
	lx: number;
	ly: number;
	rx: number;
	ry: number;
}

export interface ShapeKeyframe {
	t: number;
	points: RotoPoint[];
}

/** A small triangle — the minimum drawable shape (3 points). */
export function defaultShapePoints(): RotoPoint[] {
	return [
		{ x: 0.35, y: 0.35, lx: 0.27, ly: 0.35, rx: 0.43, ry: 0.35 },
		{ x: 0.7, y: 0.35, lx: 0.62, ly: 0.35, rx: 0.78, ry: 0.35 },
		{ x: 0.5, y: 0.75, lx: 0.42, ly: 0.75, rx: 0.58, ry: 0.75 },
	];
}

export function clampPoint(p: RotoPoint, min = 0.01, max = 0.99): RotoPoint {
	const c = (v: number) => Math.max(min, Math.min(max, v));
	return { x: c(p.x), y: c(p.y), lx: c(p.lx), ly: c(p.ly), rx: c(p.rx), ry: c(p.ry) };
}

/** Parse + validate the shape_keys JSON; returns the first keyframe or null. */
export function parseShapeKeys(value: unknown): ShapeKeyframe | null {
	if (typeof value !== 'string' || !value.trim()) { return null; }
	try {
		const data = JSON.parse(value);
		if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0].points) && data[0].points.length >= 3) {
			const points = data[0].points
				.filter((p: unknown) => p && typeof p === 'object')
				.map((p: Record<string, unknown>) => clampPoint({
					x: Number(p.x) || 0,
					y: Number(p.y) || 0,
					lx: Number(p.lx ?? p.x) || 0,
					ly: Number(p.ly ?? p.y) || 0,
					rx: Number(p.rx ?? p.x) || 0,
					ry: Number(p.ry ?? p.y) || 0,
				}));
			if (points.length >= 3) { return { t: Number(data[0].t) || 0, points }; }
		}
	} catch { /* fall through */ }
	return null;
}

/** Serialize a keyframe list to the ComfyTV JSON string (3 decimals). Pure. */
export function shapeKeysToJson(keys: ShapeKeyframe[]): string {
	const round = (v: number) => Math.round(v * 1000) / 1000;
	return JSON.stringify(keys.map(k => ({
		t: round(k.t),
		points: k.points.map(p => ({ x: round(p.x), y: round(p.y), lx: round(p.lx), ly: round(p.ly), rx: round(p.rx), ry: round(p.ry) })),
	})));
}

/** Append a vertex (with outward horizontal handles). Pure. */
export function addShapePoint(points: RotoPoint[], x: number, y: number): RotoPoint[] {
	const h = 0.08;
	const p = clampPoint({ x, y, lx: x - h, ly: y, rx: x + h, ry: y });
	return [...points, p];
}

/** Move a vertex; its tangent handles translate along (roto semantics). Pure. */
export function moveShapePoint(points: RotoPoint[], i: number, x: number, y: number): RotoPoint[] {
	if (i < 0 || i >= points.length) { return points; }
	const p = points[i];
	const dx = x - p.x; const dy = y - p.y;
	const next = clampPoint({ ...p, x, y, lx: p.lx + dx, ly: p.ly + dy, rx: p.rx + dx, ry: p.ry + dy });
	return points.map((q, j) => (j === i ? next : q));
}

/** Move a single tangent handle. Pure. */
export function moveShapeTangent(points: RotoPoint[], i: number, which: 'l' | 'r', x: number, y: number): RotoPoint[] {
	if (i < 0 || i >= points.length) { return points; }
	const p = points[i];
	const next = clampPoint(which === 'l'
		? { ...p, lx: x, ly: y }
		: { ...p, rx: x, ry: y });
	return points.map((q, j) => (j === i ? next : q));
}

/** Remove a vertex (keeps at least 3). Pure. */
export function removeShapePoint(points: RotoPoint[], i: number): RotoPoint[] {
	if (points.length <= 3 || i < 0 || i >= points.length) { return points; }
	return points.filter((_, j) => j !== i);
}

export function isRotoMaskNode(type: string): boolean {
	return type === 'ComfyTV.RotoMaskStage';
}

/**
 * 对齐 ComfyTV useRotoMaskEditor.buildShapePoints：smooth 开关决定顶点切线。
 *  - smooth=true：用相邻顶点的 1/6 切线近似贝塞尔（自动平滑）
 *  - smooth=false：切线 = 顶点自身（直线多边形）
 * 纯函数，输入顶点（带或忽略旧切线），输出带切线的新顶点。
 */
export function applySmooth(points: RotoPoint[], smooth: boolean): RotoPoint[] {
	const n = points.length;
	if (n === 0) { return points; }
	return points.map((p, i) => {
		if (!smooth) {
			return { ...p, lx: p.x, ly: p.y, rx: p.x, ry: p.y };
		}
		const prev = points[(i - 1 + n) % n];
		const next = points[(i + 1) % n];
		const tx = (next.x - prev.x) / 6;
		const ty = (next.y - prev.y) / 6;
		return clampPoint({ x: p.x, y: p.y, lx: p.x - tx, ly: p.y - ty, rx: p.x + tx, ry: p.y + ty });
	});
}
