/*---------------------------------------------------------------------------------------------
 *  posterEditor — ComfyTV Poster stage support (P3 embedded editor).
 *
 *  数据契约对齐 ComfyTV composables/stages/usePosterStage.ts：
 *    - PosterElement.type ∈ { 'text' | 'image' | 'shape' }（shape 统称），
 *      shape 用 `shape: 'rect' | 'ellipse' | 'line'` 区分（非独立 rect/circle type）
 *    - layout override 结构：{ elementId: override, __added__: [], __removed__: [],
 *      __colors__: {primary_color,accent_color,bg_color}, __fonts__: {font_title,font_body} }
 *    - mergedElements(templateDefs, layout) = 非 removed 模板 + __added__
 *    - newElementDef / nextElementId / DEFAULT_COLORS / layoutColor / SIZE_PRESETS
 *  模板系统（后端 /comfytv/poster/elements）本项目无接口，用 defaultPosterElements
 *  硬编码 fallback（等价于 ComfyTV 的 hero 模板）。
 *
 *  交互增强（8 方向 resize / 多选 arrange / snapping / 图像内编辑 / 参考线）留后续。
 *--------------------------------------------------------------------------------------------*/

export type PosterElementType = 'text' | 'image' | 'shape';
export type PosterShape = 'rect' | 'ellipse' | 'line';

export interface PosterElement {
	id: string;
	type: PosterElementType;
	label?: string;
	/** dynamic text binding (title/subtitle) */
	bind?: string;
	slot?: number;
	text?: string;
	data?: string;
	shape?: PosterShape;
	fill?: string;
	stroke?: string;
	stroke_width?: number;
	font?: 'title' | 'body';
	font_size?: number;
	align?: 'left' | 'center' | 'right';
	color?: string;
	fit?: 'contain' | 'cover';
	/** normalized 0..1 coordinates */
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	z?: number;
	rot?: number;
	img_scale?: number;
	img_x?: number;
	img_y?: number;
	[key: string]: unknown;
}

export type PosterLayout = Record<string, unknown>;

export const DEFAULT_COLORS: Record<string, string> = {
	primary_color: '#1f1b16',
	accent_color: '#9c2b2b',
	bg_color: '#f4ece0',
};

export const SIZE_PRESETS = [
	{ label: 'A4 竖 1240×1754', w: 1240, h: 1754 },
	{ label: 'A3 竖 1754×2480', w: 1754, h: 2480 },
	{ label: '方形 1240×1240', w: 1240, h: 1240 },
	{ label: '竖屏 9:16 1080×1920', w: 1080, h: 1920 },
	{ label: '宽屏 16:9 1920×1080', w: 1920, h: 1080 },
	{ label: '海报 2:3 1240×1860', w: 1240, h: 1860 },
];

/** 匹配尺寸预设标签（对齐 ComfyTV sizePresetLabel：w/h 精确匹配，否则 null）。 */
export function sizePresetFor(w: number, h: number): string | null {
	return SIZE_PRESETS.find(p => p.w === w && p.h === h)?.label ?? null;
}

/** Default "hero"-style element set（等价 ComfyTV hero 模板 fallback）。 */
export function defaultPosterElements(): PosterElement[] {
	return [
		{ id: 'title', type: 'text', bind: 'title', label: '标题', x: 0.06, y: 0.05, w: 0.62, h: 0.12, font: 'title', font_size: 64, align: 'left', color: '#ffffff', text: 'Your Title' },
		{ id: 'subtitle', type: 'text', bind: 'subtitle', label: '副标题', x: 0.06, y: 0.17, w: 0.5, h: 0.06, font: 'body', font_size: 24, align: 'left', color: '#c9c9c9', text: 'Your subtitle here' },
		{ id: 'main', type: 'image', label: '主图', x: 0.06, y: 0.27, w: 0.88, h: 0.65, slot: 0 },
	];
}

/** 对齐 ComfyTV nextElementId：u + base36 时间戳 + 递增序号。 */
let _uidCounter = 0;
export function nextElementId(): string {
	_uidCounter += 1;
	return `u${Date.now().toString(36)}${_uidCounter.toString(36)}`;
}

/** 对齐 ComfyTV newElementDef(type, id)。 */
export function newElementDef(type: string, id: string): PosterElement {
	const base: PosterElement = { id, x: 0.32, y: 0.32, w: 0.36, h: 0.18 };
	if (type === 'image') { return { ...base, type: 'image', slot: 0 }; }
	if (type === 'shape') {
		return { ...base, type: 'shape', shape: 'rect', h: 0.1, stroke: 'accent', stroke_width: 3 };
	}
	return { ...base, type: 'text', text: '新文本', font: 'body', font_size: 36, align: 'left' };
}

/** 对齐 ComfyTV parseLayout（防御解析）。 */
export function parsePosterLayout(value: unknown): PosterLayout {
	if (typeof value !== 'string' || !value.trim()) { return {}; }
	try {
		const data = JSON.parse(value);
		return data && typeof data === 'object' ? (data as PosterLayout) : {};
	} catch {
		return {};
	}
}

/**
 * 对齐 ComfyTV mergedElements：templateDefs.filter(非 __removed__) + __added__。
 * 注意：ComfyTV 的 elementId override 是**局部补丁**（不是完整元素定义），元素本体
 * 来自 templateDefs / __added__。本项目旧 applyPosterLayout 把 layout 当完整定义是错的。
 */
export function mergedElements(
	templateDefs: PosterElement[],
	layout: PosterLayout,
): PosterElement[] {
	const removed = Array.isArray(layout.__removed__) ? (layout.__removed__ as string[]) : [];
	const added = Array.isArray(layout.__added__) ? (layout.__added__ as PosterElement[]) : [];
	const tdefs = templateDefs.filter(d => !removed.includes(d.id));
	return [...tdefs, ...added];
}

/**
 * 合并 override 到元素（对齐 ComfyTV eff：override 优先，其次元素自身，再默认）。
 * 返回带 override 生效后的元素（用于渲染/命中）。
 */
export function eff(element: PosterElement, override: Record<string, unknown> | undefined): PosterElement {
	return { ...element, ...(override ?? {}) };
}

/** 应用 layout override 到模板（等价 mergedElements + 逐元素 eff）。 */
export function applyPosterLayout(
	templateDefs: PosterElement[],
	layout: PosterLayout,
): PosterElement[] {
	const KEYS = ['x', 'y', 'w', 'h', 'z', 'rot', 'slot', 'label', 'text', 'shape', 'fill', 'stroke', 'stroke_width', 'align', 'font_size', 'font', 'color', 'fit', 'img_scale', 'img_x', 'img_y'] as const;
	return mergedElements(templateDefs, layout).map(el => {
		const ov = layout[el.id] as Record<string, unknown> | undefined;
		if (!ov) { return el; }
		const out: PosterElement = { ...el };
		for (const k of KEYS) {
			if (k in ov) { (out as Record<string, unknown>)[k] = ov[k]; }
		}
		return out;
	});
}

/** 对齐 ComfyTV layoutColor：__colors__ 覆盖 DEFAULT_COLORS。 */
export function layoutColor(layout: PosterLayout, key: string): string {
	const c = (layout.__colors__ ?? {}) as Record<string, unknown>;
	const v = c[key];
	return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : (DEFAULT_COLORS[key] ?? '#000000');
}

/** Structural canvas-2D-like interface (fake-recordable for tests). */
export interface PosterCtxLike {
	fillStyle?: string;
	font?: string;
	textAlign?: string;
	textBaseline?: string;
	globalAlpha?: number;
	lineWidth?: number;
	strokeStyle?: string;
	fillRect?: (x: number, y: number, w: number, h: number) => void;
	fillText?: (text: string, x: number, y: number) => void;
	measureText?: (text: string) => { width: number };
	drawImage?: (img: unknown, dx: number, dy: number, dw: number, dh: number) => void;
	beginPath?: () => void;
	arc?: (x: number, y: number, r: number, a0: number, a1: number) => void;
	ellipse?: (x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number) => void;
	moveTo?: (x: number, y: number) => void;
	lineTo?: (x: number, y: number) => void;
	fill?: () => void;
	stroke?: () => void;
	save?: () => void;
	restore?: () => void;
	translate?: (x: number, y: number) => void;
	rotate?: (r: number) => void;
	scale?: (sx: number, sy: number) => void;
}

function alignedX(ctx: PosterCtxLike, text: string, x: number, y: number, w: number, align: string): number {
	if (align === 'center') { return x + w / 2; }
	if (align === 'right') { return x + w; }
	return x;
}

/** 对齐 ComfyTV renderPoster：shape='rect'|'ellipse'|'line' 三种。 */
export function renderPoster(
	ctx: PosterCtxLike,
	elements: PosterElement[],
	images: unknown[],
	W: number,
	H: number,
	bg = '#101014',
): void {
	ctx.fillStyle = bg;
	ctx.fillRect?.(0, 0, W, H);
	const sorted = [...elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
	for (const el of sorted) {
		const px = (el.x ?? 0) * W;
		const py = (el.y ?? 0) * H;
		const pw = (el.w ?? 0) * W;
		const ph = (el.h ?? 0) * H;
		ctx.save?.();
		if (el.rot) {
			ctx.translate?.(px + pw / 2, py + ph / 2);
			ctx.rotate?.((el.rot * Math.PI) / 180);
			ctx.translate?.(-(px + pw / 2), -(py + ph / 2));
		}
		if (el.type === 'text') {
			const size = el.font_size ?? 24;
			ctx.font = `${size}px system-ui, sans-serif`;
			ctx.textBaseline = 'middle';
			ctx.textAlign = (el.align ?? 'left') as CanvasTextAlign;
			ctx.fillStyle = el.color ?? '#ffffff';
			const text = el.text ?? el.label ?? '';
			ctx.fillText?.(text, alignedX(ctx, text, px, py + ph / 2, pw, el.align ?? 'left'), py + ph / 2);
		} else if (el.type === 'image') {
			const slot = el.slot ?? 0;
			const img = images[slot];
			if (img !== undefined) {
				ctx.fillStyle = '#000';
				ctx.fillRect?.(px, py, pw, ph);
				// 图像内编辑：img_scale 围绕框中心放大 + img_x/img_y 相对框平移
				// （对齐 ComfyTV livePatchImg: translate(ix%,iy%) scale(s)，origin=center）
				const iscale = el.img_scale ?? 1;
				const ix = el.img_x ?? 0;
				const iy = el.img_y ?? 0;
				const cx = px + pw / 2;
				const cy = py + ph / 2;
				ctx.save?.();
				ctx.translate?.(cx + ix * pw, cy + iy * ph);
				ctx.scale?.(iscale, iscale);
				ctx.translate?.(-cx, -cy);
				if (el.fit === 'contain') {
					const ratio = (images[slot] as { width?: number; height?: number })?.width
						? (images[slot] as { width: number }).width / (images[slot] as { height: number }).height
						: pw / ph;
					let dw = pw; let dh = pw / ratio;
					if (dh > ph) { dh = ph; dw = ph * ratio; }
					ctx.drawImage?.(img, px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh);
				} else {
					ctx.drawImage?.(img, px, py, pw, ph);
				}
				ctx.restore?.();
			} else {
				ctx.fillStyle = 'rgba(255,255,255,.06)';
				ctx.fillRect?.(px, py, pw, ph);
			}
		} else if (el.type === 'shape') {
			ctx.fillStyle = el.fill ?? 'rgba(255,255,255,.12)';
			ctx.strokeStyle = el.stroke ?? 'rgba(255,255,255,.5)';
			ctx.lineWidth = el.stroke_width ?? 2;
			if (el.shape === 'ellipse') {
				ctx.beginPath?.();
				ctx.ellipse?.(px + pw / 2, py + ph / 2, pw / 2, ph / 2, 0, 0, Math.PI * 2);
				ctx.fill?.();
			} else if (el.shape === 'line') {
				ctx.beginPath?.();
				ctx.moveTo?.(px, py);
				ctx.lineTo?.(px + pw, py + ph);
				ctx.stroke?.();
			} else {
				// rect（默认 shape）
				ctx.fillRect?.(px, py, pw, ph);
			}
		}
		ctx.restore?.();
	}
}

/** Poster element hit-test for dragging (element whose box contains the point). Pure. */
export function hitTestPosterElement(
	elements: PosterElement[],
	nx: number,
	ny: number,
): number {
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i];
		const x = el.x ?? 0;
		const y = el.y ?? 0;
		const w = el.w ?? 0;
		const h = el.h ?? 0;
		if (nx >= x && nx <= x + w && ny >= y && ny <= y + h) { return i; }
	}
	return -1;
}

export function isPosterNode(type: string): boolean {
	return type === 'ComfyTV.PosterStage';
}

// ── 8 方向 resize + 旋转交互（对齐 ComfyTV widgets/poster/geometry.ts + transformMath.ts）──

export const HANDLE_MODES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const;
export type PosterDragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export interface PosterHit { idx: number; mode: PosterDragMode; }

export const MIN_WH = 0.02;        // 元素最小宽高（归一化）
export const HANDLE = 0.02;        // 手柄命中半径（归一化，≈7px @ 360 视图）
export const ROTATE_OFFSET = 0.04; // 旋转手柄距上边中点距离（归一化，≈20px @ 视图）

/** 8 个 resize 手柄位置（归一化，轴对齐）。顺序同 HANDLE_MODES。 */
export function handlePtsN(r: { x: number; y: number; w: number; h: number }): [number, number][] {
	const mx = r.x + r.w / 2;
	const my = r.y + r.h / 2;
	return [
		[r.x, r.y], [mx, r.y], [r.x + r.w, r.y],
		[r.x, my], [r.x + r.w, my],
		[r.x, r.y + r.h], [mx, r.y + r.h], [r.x + r.w, r.y + r.h],
	];
}

/**
 * 命中检测（对齐 ComfyTV hitTest）：先 8 方向手柄（active 元素，仅当轴对齐），
 * 再按 z 倒序命中元素本体（move）。
 */
export function hitTestPosterHandle(
	elements: PosterElement[],
	nx: number,
	ny: number,
	activeIdx: number,
	handle = HANDLE,
): PosterHit | null {
	if (activeIdx >= 0 && activeIdx < elements.length) {
		const el = elements[activeIdx]!;
		if (!(el.rot ?? 0)) {
			const pts = handlePtsN({ x: el.x ?? 0, y: el.y ?? 0, w: el.w ?? 0, h: el.h ?? 0 });
			for (let h = 0; h < pts.length; h++) {
				if (Math.abs(nx - pts[h]![0]) <= handle && Math.abs(ny - pts[h]![1]) <= handle) {
					return { idx: activeIdx, mode: HANDLE_MODES[h] as PosterDragMode };
				}
			}
		}
	}
	const idx = hitTestPosterElement(elements, nx, ny);
	if (idx >= 0) { return { idx, mode: 'move' }; }
	return null;
}

/** 元素某手柄的归一化位置（随 rot 旋转）：'n' 上边中点 / 'rotate' 旋转手柄。 */
export function posterHandlePosN(
	el: PosterElement,
	handle: 'n' | 'rotate',
): { x: number; y: number } {
	const cx = (el.x ?? 0) + (el.w ?? 0) / 2;
	const cy = (el.y ?? 0) + (el.h ?? 0) / 2;
	const h = el.h ?? 0;
	const local = handle === 'rotate'
		? { x: 0, y: -h / 2 - ROTATE_OFFSET }
		: { x: 0, y: -h / 2 };
	const rot = ((el.rot ?? 0) * Math.PI) / 180;
	const c = Math.cos(rot);
	const s = Math.sin(rot);
	return { x: cx + local.x * c - local.y * s, y: cy + local.x * s + local.y * c };
}

/** 两点相对角度（弧度），用于旋转拖拽。 */
export function posterAngleTo(cx: number, cy: number, px: number, py: number): number {
	return Math.atan2(py - cy, px - cx);
}

/** 归一化旋转角到 (-180, 180]。 */
export function normalizePosterRot(deg: number): number {
	let d = ((deg % 360) + 360) % 360;
	if (d > 180) { d -= 360; }
	return d;
}

/** move/resize 数学（对齐 ComfyTV applyDrag）。dx/dy 为归一化位移。 */
export function applyPosterDrag(
	mode: PosterDragMode,
	start: { x: number; y: number; w: number; h: number },
	dx: number,
	dy: number,
): { x: number; y: number; w: number; h: number } {
	const cl = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
	let { x, y, w, h } = start;
	if (mode === 'move') {
		x = cl(x + dx, 0, 1 - w);
		y = cl(y + dy, 0, 1 - h);
	} else {
		if (mode.includes('e')) { w = cl(w + dx, MIN_WH, 1 - x); }
		if (mode.includes('s')) { h = cl(h + dy, MIN_WH, 1 - y); }
		if (mode.includes('w')) { const nw = cl(w - dx, MIN_WH, x + w); x = x + w - nw; w = nw; }
		if (mode.includes('n')) { const nh = cl(h - dy, MIN_WH, y + h); y = y + h - nh; h = nh; }
	}
	return { x, y, w, h };
}

/** 光标（对齐 ComfyTV cursorFor）。 */
export function cursorForPoster(mode: PosterDragMode | null): string {
	if (!mode) { return 'default'; }
	if (mode === 'move') { return 'move'; }
	const map: Record<string, string> = {
		n: 'ns', s: 'ns', e: 'ew', w: 'ew', ne: 'nesw', sw: 'nesw', nw: 'nwse', se: 'nwse',
	};
	return `${map[mode]}-resize`;
}

// ── 参考线 guides + 网格 grid（对齐 ComfyTV usePosterStage guides/gridOn）──

export interface PosterGuide { axis: 'x' | 'y'; pos: number; }

/** 从 layout.__guides__ 防御解析参考线（对齐 usePosterStage guides computed）。 */
export function parsePosterGuides(layout: PosterLayout): PosterGuide[] {
	const raw = layout.__guides__;
	if (!Array.isArray(raw)) { return []; }
	return raw.filter((g): g is PosterGuide =>
		!!g && (g.axis === 'x' || g.axis === 'y')
		&& typeof g.pos === 'number' && g.pos >= 0 && g.pos <= 1);
}

/** layout.__grid__ 网格开关（对齐 usePosterStage gridOn）。 */
export function posterGridOn(layout: PosterLayout): boolean {
	return !!layout.__grid__;
}

/** 命中参考线（归一化坐标，容差 handlePx 像素 / 视图宽度）。返回索引或 -1。 */
export function posterGuideHitIndex(
	guides: PosterGuide[],
	nx: number,
	ny: number,
	tolN = 0.012,
): number {
	for (let i = 0; i < guides.length; i++) {
		const g = guides[i]!;
		const d = g.axis === 'x' ? Math.abs(nx - g.pos) : Math.abs(ny - g.pos);
		if (d <= tolN) { return i; }
	}
	return -1;
}

// ── 图像内编辑（img_scale/img_x/img_y，对齐 ComfyTV usePosterStage elementImageProps/moveImgDrag/setImgScale）──

export interface PosterImageProps { scale: number; x: number; y: number; }

/** 元素图像内编辑参数（对齐 elementImageProps：img_scale/img_x/img_y 默认 1/0/0）。 */
export function posterImageProps(el: PosterElement): PosterImageProps {
	return {
		scale: Number(el.img_scale ?? 1) || 1,
		x: Number(el.img_x ?? 0) || 0,
		y: Number(el.img_y ?? 0) || 0,
	};
}

/** clamp img_scale 到 [1,4]（对齐 setImgScale）。 */
export function clampImgScale(scale: number): number {
	return Math.max(1, Math.min(4, scale || 1));
}

/**
 * 图像拖拽平移：dx/dy 为相对框宽高的位移，clamp 到 [-max, max]（max=(scale-1)/2）。
 * 对齐 ComfyTV moveImgDrag。
 */
export function applyImgDrag(
	start: PosterImageProps,
	dx: number,
	dy: number,
): PosterImageProps {
	const max = Math.max(0, (start.scale - 1) / 2);
	const cl = (v: number): number => Math.max(-max, Math.min(max, v));
	return { scale: start.scale, x: cl(start.x + dx), y: cl(start.y + dy) };
}

/** 缩放到新 scale 时同步 clamp img_x/img_y 到新 max（对齐 setImgScale）。 */
export function applyImgScale(
	props: PosterImageProps,
	newScale: number,
): PosterImageProps {
	const s = clampImgScale(newScale);
	const max = Math.max(0, (s - 1) / 2);
	const cl = (v: number): number => Math.max(-max, Math.min(max, v));
	return { scale: s, x: cl(props.x), y: cl(props.y) };
}
