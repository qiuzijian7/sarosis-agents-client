/*---------------------------------------------------------------------------------------------
 *  posterArrange — Poster 多选 arrange（对齐/分布）+ snapping 吸附纯函数。
 *  移植自 ComfyTV lib/shared2d/arrange.ts + lib/shared2d/snapping.ts。
 *  坐标空间：Poster 编辑器统一用归一化 0..1（x/y/w/h）。
 *--------------------------------------------------------------------------------------------*/

export interface PRect { x: number; y: number; w: number; h: number }

// ── arrange ──────────────────────────────────────────────────────────────

export type AlignOp = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type DistributeOp = 'hspread' | 'vspread' | 'hgap' | 'vgap';
export type ArrangeOp = AlignOp | DistributeOp;
export interface Delta { dx: number; dy: number }

const ALIGN_FACTOR: Record<AlignOp, { axis: 'x' | 'y'; f: number }> = {
	left: { axis: 'x', f: 0 },
	hcenter: { axis: 'x', f: 0.5 },
	right: { axis: 'x', f: 1 },
	top: { axis: 'y', f: 0 },
	vcenter: { axis: 'y', f: 0.5 },
	bottom: { axis: 'y', f: 1 },
};

export function isAlignOp(op: ArrangeOp): op is AlignOp {
	return op in ALIGN_FACTOR;
}

export function unionRect(rects: PRect[]): PRect {
	let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
	for (const r of rects) {
		minX = Math.min(minX, r.x);
		minY = Math.min(minY, r.y);
		maxX = Math.max(maxX, r.x + r.w);
		maxY = Math.max(maxY, r.y + r.h);
	}
	if (!isFinite(minX)) { return { x: 0, y: 0, w: 0, h: 0 }; }
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function anchorOf(r: PRect, axis: 'x' | 'y', f: number): number {
	return axis === 'x' ? r.x + r.w * f : r.y + r.h * f;
}

export function align(rects: PRect[], op: AlignOp, reference?: PRect): Delta[] {
	const { axis, f } = ALIGN_FACTOR[op];
	if (rects.length === 0) { return []; }
	const ref = reference ?? unionRect(rects);
	const target = anchorOf(ref, axis, f);
	return rects.map((r) => {
		const d = target - anchorOf(r, axis, f);
		return axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d };
	});
}

export function distribute(rects: PRect[], op: DistributeOp): Delta[] {
	const zero = rects.map(() => ({ dx: 0, dy: 0 }));
	if (rects.length < 3) { return zero; }
	const axis: 'x' | 'y' = op === 'hspread' || op === 'hgap' ? 'x' : 'y';
	const size = (r: PRect) => (axis === 'x' ? r.w : r.h);
	const pos = (r: PRect) => (axis === 'x' ? r.x : r.y);

	const order = rects
		.map((r, i) => ({ r, i }))
		.sort((a, b) =>
			op === 'hgap' || op === 'vgap'
				? pos(a.r) - pos(b.r)
				: anchorOf(a.r, axis, 0.5) - anchorOf(b.r, axis, 0.5));

	const out = zero;
	const first = order[0]!;
	const last = order[order.length - 1]!;

	if (op === 'hspread' || op === 'vspread') {
		const a0 = anchorOf(first.r, axis, 0.5);
		const a1 = anchorOf(last.r, axis, 0.5);
		const fill = (a1 - a0) / (order.length - 1);
		for (let n = 1; n < order.length - 1; n++) {
			const { r, i } = order[n]!;
			const d = a0 + n * fill - anchorOf(r, axis, 0.5);
			out[i] = axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d };
		}
		return out;
	}

	let midSizes = 0;
	for (let n = 1; n < order.length - 1; n++) { midSizes += size(order[n]!.r); }
	const span = pos(last.r) - (pos(first.r) + size(first.r));
	const gap = (span - midSizes) / (order.length - 1);
	let z = pos(first.r) + size(first.r);
	for (let n = 1; n < order.length - 1; n++) {
		const { r, i } = order[n]!;
		const d = z + gap - pos(r);
		out[i] = axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d };
		z += gap + size(r);
	}
	return out;
}

export function arrange(rects: PRect[], op: ArrangeOp, reference?: PRect): Delta[] {
	return isAlignOp(op) ? align(rects, op, reference) : distribute(rects, op as DistributeOp);
}

// ── snapping ─────────────────────────────────────────────────────────────

export interface SnapTargets { xs: number[]; ys: number[] }
export interface SnapGuide {
	axis: 'x' | 'y';
	pos: number;
	kind?: 'edge' | 'gap';
	cross?: number;
	spans?: Array<[number, number]>;
}
export interface SnapExtras {
	gridX?: number;
	gridY?: number;
	guideXs?: number[];
	guideYs?: number[];
}
export interface SnapOpts {
	thrX: number;
	thrY: number;
	minWH: number;
	boundsW?: number;
	boundsH?: number;
	clamp?: boolean;
	eqRects?: PRect[];
}
export interface SnapResult { rect: PRect; guides: SnapGuide[] }

function clampNum(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

/** 吸附目标：画布边界(0/bw/2/bw) + 其他元素边缘/中点 + 网格 + 参考线。 */
export function buildSnapTargets(
	otherRects: PRect[],
	bounds?: { w: number; h: number },
	extras?: SnapExtras,
): SnapTargets {
	const bw = bounds?.w ?? 1;
	const bh = bounds?.h ?? 1;
	const xs = [0, bw / 2, bw];
	const ys = [0, bh / 2, bh];
	for (const r of otherRects) {
		xs.push(r.x, r.x + r.w / 2, r.x + r.w);
		ys.push(r.y, r.y + r.h / 2, r.y + r.h);
	}
	if (extras?.gridX && extras.gridX > 0) {
		for (let v = 0; v <= bw + 1e-9; v += extras.gridX) { xs.push(v); }
	}
	if (extras?.gridY && extras.gridY > 0) {
		for (let v = 0; v <= bh + 1e-9; v += extras.gridY) { ys.push(v); }
	}
	for (const g of extras?.guideXs ?? []) { xs.push(g); }
	for (const g of extras?.guideYs ?? []) { ys.push(g); }
	return { xs, ys };
}

export function nearestTarget(val: number, targets: number[], thr: number): number | null {
	let best: number | null = null;
	let bd = thr;
	for (const t of targets) {
		const dd = Math.abs(val - t);
		if (dd < bd) { bd = dd; best = t; }
	}
	return best;
}

interface EqCandidate { pos: number; guide: SnapGuide }

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
	return a0 < b1 && a1 > b0;
}

function eqCandidatesAxis(rect: PRect, others: PRect[], axis: 'x' | 'y'): EqCandidate[] {
	const p = (r: PRect) => (axis === 'x' ? r.x : r.y);
	const s = (r: PRect) => (axis === 'x' ? r.w : r.h);
	const c0 = (r: PRect) => (axis === 'x' ? r.y : r.x);
	const c1 = (r: PRect) => (axis === 'x' ? r.y + r.h : r.x + r.w);
	const cross = (axis === 'x' ? rect.y + rect.h / 2 : rect.x + rect.w / 2);

	const near = others.filter(o => overlaps(c0(o), c1(o), c0(rect), c1(rect)));
	const lefts = near.filter(o => p(o) + s(o) <= p(rect) + s(rect) / 2)
		.sort((a, b) => (p(b) + s(b)) - (p(a) + s(a)));
	const rights = near.filter(o => p(o) >= p(rect) + s(rect) / 2)
		.sort((a, b) => p(a) - p(b));
	const out: EqCandidate[] = [];

	const L = lefts[0];
	const R = rights[0];
	if (L && R) {
		const free = p(R) - (p(L) + s(L)) - s(rect);
		if (free >= 0) {
			const pos = p(L) + s(L) + free / 2;
			out.push({
				pos,
				guide: { axis, pos, kind: 'gap', cross, spans: [[p(L) + s(L), pos], [pos + s(rect), p(R)]] },
			});
		}
	}
	if (lefts.length >= 2) {
		const L1 = lefts[0]!;
		const L2 = lefts[1]!;
		const gap = p(L1) - (p(L2) + s(L2));
		if (gap >= 0) {
			const pos = p(L1) + s(L1) + gap;
			out.push({
				pos,
				guide: { axis, pos, kind: 'gap', cross, spans: [[p(L2) + s(L2), p(L1)], [p(L1) + s(L1), pos]] },
			});
		}
	}
	if (rights.length >= 2) {
		const R1 = rights[0]!;
		const R2 = rights[1]!;
		const gap = p(R2) - (p(R1) + s(R1));
		if (gap >= 0) {
			const pos = p(R1) - gap - s(rect);
			out.push({
				pos,
				guide: { axis, pos, kind: 'gap', cross, spans: [[pos + s(rect), p(R1)], [p(R1) + s(R1), p(R2)]] },
			});
		}
	}
	return out;
}

/** 对齐 ComfyTV applySnap：move/resize 时的吸附 + 边界 clamp。 */
export function applySnap(
	mode: string,
	rect: PRect,
	targets: SnapTargets,
	opts: SnapOpts,
): SnapResult {
	let { x, y, w, h } = rect;
	const guides: SnapGuide[] = [];
	const { thrX, thrY, minWH } = opts;
	const bw = opts.boundsW ?? 1;
	const bh = opts.boundsH ?? 1;
	const clamp = opts.clamp !== false;

	if (mode === 'move') {
		let bestDX: number | null = null;
		let guideX: SnapGuide | null = null;
		for (const v of [x, x + w / 2, x + w]) {
			const t = nearestTarget(v, targets.xs, thrX);
			if (t != null) {
				const dd = t - v;
				if (bestDX === null || Math.abs(dd) < Math.abs(bestDX)) {
					bestDX = dd;
					guideX = { axis: 'x', pos: t, kind: 'edge' };
				}
			}
		}
		let bestDY: number | null = null;
		let guideY: SnapGuide | null = null;
		for (const v of [y, y + h / 2, y + h]) {
			const t = nearestTarget(v, targets.ys, thrY);
			if (t != null) {
				const dd = t - v;
				if (bestDY === null || Math.abs(dd) < Math.abs(bestDY)) {
					bestDY = dd;
					guideY = { axis: 'y', pos: t, kind: 'edge' };
				}
			}
		}
		if (opts.eqRects?.length) {
			for (const c of eqCandidatesAxis(rect, opts.eqRects, 'x')) {
				const dd = c.pos - x;
				if (Math.abs(dd) < thrX && (bestDX === null || Math.abs(dd) < Math.abs(bestDX))) {
					bestDX = dd;
					guideX = c.guide;
				}
			}
			for (const c of eqCandidatesAxis(rect, opts.eqRects, 'y')) {
				const dd = c.pos - y;
				if (Math.abs(dd) < thrY && (bestDY === null || Math.abs(dd) < Math.abs(bestDY))) {
					bestDY = dd;
					guideY = c.guide;
				}
			}
		}
		if (bestDX !== null && guideX) { x += bestDX; guides.push(guideX); }
		if (bestDY !== null && guideY) { y += bestDY; guides.push(guideY); }
	} else {
		if (mode.includes('e')) {
			const t = nearestTarget(x + w, targets.xs, thrX);
			if (t != null) { w = t - x; guides.push({ axis: 'x', pos: t }); }
		}
		if (mode.includes('w')) {
			const t = nearestTarget(x, targets.xs, thrX);
			if (t != null) { const rt = x + w; x = t; w = rt - x; guides.push({ axis: 'x', pos: t }); }
		}
		if (mode.includes('s')) {
			const t = nearestTarget(y + h, targets.ys, thrY);
			if (t != null) { h = t - y; guides.push({ axis: 'y', pos: t }); }
		}
		if (mode.includes('n')) {
			const t = nearestTarget(y, targets.ys, thrY);
			if (t != null) { const bt = y + h; y = t; h = bt - y; guides.push({ axis: 'y', pos: t }); }
		}
		w = Math.max(minWH, w);
		h = Math.max(minWH, h);
	}

	if (clamp) {
		x = clampNum(x, 0, Math.max(0, bw - w));
		y = clampNum(y, 0, Math.max(0, bh - h));
	}
	return { rect: { x, y, w, h }, guides };
}
