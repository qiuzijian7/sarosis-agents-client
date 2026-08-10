/*---------------------------------------------------------------------------------------------
 *  posterEditor — ComfyTV Poster stage support (P3 embedded editor).
 *
 *  ComfyTV's PosterStage is a browser-layout poster tool: a template defines
 *  elements (title/subtitle text, image cells) with NORMALIZED (0..1) x/y/w/h;
 *  the front-end lets the user drag/resize/edit them, the node's hidden
 *  `layout` field is a `{ elementId: {x,y,w,h,z,rot,text,font_size,color,…} }`
 *  overrides blob, and the backend renders template + layout + image slots
 *  into a PNG.
 *
 *  We mirror the layout JSON contract exactly (portable to ComfyTV) and render
 *  a lightweight equivalent on a 2D canvas in the webview — no headless
 *  browser needed. All layout math + drawing is pure and unit-testable.
 *--------------------------------------------------------------------------------------------*/

export type PosterElementType = 'text' | 'image' | 'rect' | 'circle';

export interface PosterElement {
	id: string;
	type: PosterElementType;
	/** dynamic text binding (title/subtitle) */
	bind?: string;
	label: string;
	/** normalized 0..1 coordinates */
	x: number;
	y: number;
	w: number;
	h: number;
	/** image slot index (image/cell elements) */
	slot?: number;
	z?: number;
	rot?: number;
	text?: string;
	shape?: string;
	fill?: string;
	stroke?: string;
	align?: 'left' | 'center' | 'right';
	font?: 'title' | 'body';
	font_size?: number;
	color?: string;
	fit?: 'contain' | 'cover';
}

/** Default "hero"-style element set (mirrors ComfyTV template meta). */
export function defaultPosterElements(): PosterElement[] {
	return [
		{ id: 'title', type: 'text', bind: 'title', label: '标题', x: 0.06, y: 0.05, w: 0.62, h: 0.12, font: 'title', font_size: 64, align: 'left', color: '#ffffff', text: 'Your Title' },
		{ id: 'subtitle', type: 'text', bind: 'subtitle', label: '副标题', x: 0.06, y: 0.17, w: 0.5, h: 0.06, font: 'body', font_size: 24, align: 'left', color: '#c9c9c9', text: 'Your subtitle here' },
		{ id: 'main', type: 'image', label: '主图', x: 0.06, y: 0.27, w: 0.88, h: 0.65, slot: 0 },
	];
}

/**
 * Merge a ComfyTV layout overrides blob onto the template element definitions
 * (mirror of poster/elements.py `_apply_layout`). Pure.
 */
export function applyPosterLayout(
	defs: PosterElement[],
	layout: Record<string, Partial<PosterElement> & Record<string, unknown>>,
): PosterElement[] {
	return defs.map(d => {
		const ov = layout[d.id];
		if (!ov) { return d; }
		const el: PosterElement = { ...d };
		const KEYS = ['x', 'y', 'w', 'h', 'z', 'rot', 'slot', 'label', 'text', 'shape', 'fill', 'stroke', 'align', 'font_size', 'font', 'color', 'fit', 'img_scale', 'img_x', 'img_y'] as const;
		for (const k of KEYS) {
			if (k in ov) { (el as Record<string, unknown>)[k] = ov[k]; }
		}
		return el;
	});
}

export function parsePosterLayout(value: unknown): Record<string, Partial<PosterElement> & Record<string, unknown>> {
	if (typeof value !== 'string' || !value.trim()) { return {}; }
	try {
		const data = JSON.parse(value);
		return data && typeof data === 'object' ? data : {};
	} catch {
		return {};
	}
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
	fill?: () => void;
	save?: () => void;
	restore?: () => void;
	translate?: (x: number, y: number) => void;
	rotate?: (r: number) => void;
}

function alignedX(ctx: PosterCtxLike, text: string, x: number, y: number, w: number, align: string): number {
	if (align === 'center') { return x + w / 2; }
	if (align === 'right') { return x + w; }
	return x;
}

/**
 * Render the poster onto a 2D context: background, then elements in z-order.
 * Coordinates are normalized (0..1) × W/H. `images` is indexed by element
 * slot — real canvases pass loaded HTMLImageElements, tests pass opaque tokens.
 * Pure (only draws).
 */
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
		const px = el.x * W;
		const py = el.y * H;
		const pw = el.w * W;
		const ph = el.h * H;
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
			} else {
				ctx.fillStyle = 'rgba(255,255,255,.06)';
				ctx.fillRect?.(px, py, pw, ph);
			}
		} else if (el.type === 'rect') {
			ctx.fillStyle = el.fill ?? 'rgba(255,255,255,.12)';
			ctx.fillRect?.(px, py, pw, ph);
		} else if (el.type === 'circle') {
			ctx.fillStyle = el.fill ?? 'rgba(255,255,255,.12)';
			ctx.beginPath?.();
			ctx.arc?.(px + pw / 2, py + ph / 2, Math.min(pw, ph) / 2, 0, Math.PI * 2);
			ctx.fill?.();
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
		if (nx >= el.x && nx <= el.x + el.w && ny >= el.y && ny <= el.y + el.h) { return i; }
	}
	return -1;
}

export function isPosterNode(type: string): boolean {
	return type === 'ComfyTV.PosterStage';
}
