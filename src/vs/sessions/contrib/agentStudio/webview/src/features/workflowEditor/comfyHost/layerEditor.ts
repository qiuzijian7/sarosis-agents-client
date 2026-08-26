/*---------------------------------------------------------------------------------------------
 *  layerEditor — ComfyTV Layer Editor support (P3 embedded editor, MVP).
 *
 *  ComfyTV's LayerEditorStage is a browser artboard editor: hidden `layer_state`
 *  holds the document JSON, and the front-end composites + uploads the result
 *  (`captured_image`); execute only persists. We mirror that flow with a
 *  simpler but compatible document model (layers → paint ops, normalized
 *  coordinates) rendered on a 2D canvas in the webview.
 *--------------------------------------------------------------------------------------------*/

export type LayerOpType = 'stroke' | 'rect' | 'circle' | 'text' | 'eraser' | 'image';

export interface LayerOp {
	type: LayerOpType;
	color: string;
	size: number;
	/** stroke/eraser: normalized polyline points */
	points?: Array<[number, number]>;
	/** rect/circle: normalized box */
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	/** text */
	text?: string;
	fontSize?: number;
	/** image 图层：参考图 / 贴图（normalized box 内绘制） */
	imageUrl?: string;
}

export interface LayerInfo {
	id: string;
	name: string;
	visible: boolean;
	opacity: number;
	ops: LayerOp[];
}

export interface LayerDoc {
	width: number;
	height: number;
	layers: LayerInfo[];
	/** 画布级镜像（DirectorConsoleEditor flipBoard / LayerEditorController.flipImage） */
	flipH?: boolean;
	flipV?: boolean;
}

let layerSeq = 0;
export function newLayerId(prefix = 'layer'): string {
	layerSeq += 1;
	return `${prefix}_${layerSeq}`;
}

export function defaultLayerDoc(width = 1024, height = 1024): LayerDoc {
	return { width, height, layers: [{ id: newLayerId(), name: '图层 1', visible: true, opacity: 1, ops: [] }] };
}

/** Clamp normalized coordinates into 0..1. Pure. */
export function clampN(v: number, min = 0, max = 1): number {
	return Math.max(min, Math.min(max, v));
}

/** Parse + validate a layer_state JSON; falls back to defaults. Pure. */
export function parseLayerDoc(value: unknown, width = 1024, height = 1024): LayerDoc {
	if (typeof value !== 'string' || !value.trim()) { return defaultLayerDoc(width, height); }
	try {
		const data = JSON.parse(value);
		if (!data || typeof data !== 'object' || !Array.isArray(data.layers)) { return defaultLayerDoc(width, height); }
		const layers = data.layers
			.filter((l: unknown) => l && typeof l === 'object')
			.map((l: Record<string, unknown>): LayerInfo => ({
				id: typeof l.id === 'string' ? l.id : newLayerId(),
				name: typeof l.name === 'string' ? l.name : '图层',
				visible: l.visible !== false,
				opacity: Math.max(0, Math.min(1, Number(l.opacity) || 1)),
				ops: Array.isArray(l.ops) ? l.ops.filter(op => op && typeof op.type === 'string') : [],
			}));
		return {
			width: Number(data.width) || width,
			height: Number(data.height) || height,
			...(data.flipH !== undefined ? { flipH: data.flipH === true } : {}),
			...(data.flipV !== undefined ? { flipV: data.flipV === true } : {}),
			layers: layers.length ? layers : defaultLayerDoc(width, height).layers,
		};
	} catch {
		return defaultLayerDoc(width, height);
	}
}

export function layerDocToJson(doc: LayerDoc): string {
	return JSON.stringify({
		width: doc.width,
		height: doc.height,
		...(doc.flipH !== undefined ? { flipH: doc.flipH } : {}),
		...(doc.flipV !== undefined ? { flipV: doc.flipV } : {}),
		layers: doc.layers.map(l => ({
			id: l.id,
			name: l.name,
			visible: l.visible,
			opacity: l.opacity,
			ops: l.ops,
		})),
	});
}

/** Append a paint op to a layer. Pure. */
export function addLayerOp(doc: LayerDoc, layerId: string, op: LayerOp): LayerDoc {
	return {
		...doc,
		layers: doc.layers.map(l => (l.id === layerId ? { ...l, ops: [...l.ops, op] } : l)),
	};
}

export function isLayerEditorNode(type: string): boolean {
	return type === 'ComfyTV.LayerEditorStage';
}

/** Structural canvas-2D-like context for the composite renderer. */
export interface LayerCtxLike {
	fillStyle?: string;
	strokeStyle?: string;
	lineWidth?: number;
	globalAlpha?: number;
	font?: string;
	textAlign?: string;
	textBaseline?: string;
	lineCap?: string;
	lineJoin?: string;
	fillRect?: (x: number, y: number, w: number, h: number) => void;
	fillText?: (t: string, x: number, y: number) => void;
	beginPath?: () => void;
	moveTo?: (x: number, y: number) => void;
	lineTo?: (x: number, y: number) => void;
	arc?: (x: number, y: number, r: number, a0: number, a1: number) => void;
	stroke?: () => void;
	fill?: () => void;
	save?: () => void;
	restore?: () => void;
	translate?: (x: number, y: number) => void;
	scale?: (x: number, y: number) => void;
	/** image 图层：drawImage(htmlImage, dx, dy, dw, dh) */
	drawImage?: (img: CanvasImageSource, dx: number, dy: number, dw: number, dh: number) => void;
}

function px(p: [number, number], W: number, H: number): [number, number] {
	return [p[0] * W, p[1] * H];
}

/** Composite every visible layer onto the context (normalized → pixels). Pure. */
export function drawLayerDoc(ctx: LayerCtxLike, doc: LayerDoc): void {
	// 画布级镜像：flipH 沿中轴左右翻转，flipV 沿中轴上下翻转
	ctx.save?.();
	if (doc.flipH) {
		ctx.translate?.(doc.width, 0);
		ctx.scale?.(-1, 1);
	}
	if (doc.flipV) {
		ctx.translate?.(0, doc.height);
		ctx.scale?.(1, -1);
	}
	for (const layer of doc.layers) {
		if (!layer.visible) { continue; }
		ctx.save?.();
		ctx.globalAlpha = layer.opacity;
		for (const op of layer.ops) {
			ctx.save?.();
			if (op.type === 'stroke' || op.type === 'eraser') {
				const pts = (op.points ?? []).map(p => px(p, doc.width, doc.height));
				if (pts.length < 2) { ctx.restore?.(); continue; }
				ctx.strokeStyle = op.type === 'eraser' ? 'transparent' : op.color;
				ctx.lineWidth = op.size * doc.width;
				ctx.lineCap = 'round';
				ctx.lineJoin = 'round';
				ctx.globalAlpha = op.type === 'eraser' ? 1 : layer.opacity;
				ctx.beginPath?.();
				ctx.moveTo?.(pts[0][0], pts[0][1]);
				for (let i = 1; i < pts.length; i++) { ctx.lineTo?.(pts[i][0], pts[i][1]); }
				ctx.stroke?.();
			} else if (op.type === 'rect') {
				const x = (op.x ?? 0) * doc.width; const y = (op.y ?? 0) * doc.height;
				const w = (op.w ?? 0) * doc.width; const h = (op.h ?? 0) * doc.height;
				ctx.fillStyle = op.color;
				ctx.fillRect?.(x, y, w, h);
			} else if (op.type === 'circle') {
				const cx = ((op.x ?? 0) + (op.w ?? 0) / 2) * doc.width;
				const cy = ((op.y ?? 0) + (op.h ?? 0) / 2) * doc.height;
				const r = Math.max(op.w ?? 0, op.h ?? 0) * doc.width / 2;
				ctx.fillStyle = op.color;
				ctx.beginPath?.();
				ctx.arc?.(cx, cy, r, 0, Math.PI * 2);
				ctx.fill?.();
			} else if (op.type === 'text') {
				const size = (op.fontSize ?? 48) * doc.width;
				ctx.font = `${Math.max(8, size)}px system-ui, sans-serif`;
				ctx.fillStyle = op.color;
				ctx.textBaseline = 'top';
				ctx.fillText?.(op.text ?? '', (op.x ?? 0) * doc.width, (op.y ?? 0) * doc.height);
			} else if (op.type === 'image') {
				// image 图层：需要真实 <img> 已加载（LayerEditor 侧缓存 imageEls map）
				const img = imageElsCache.get(op.imageUrl ?? '');
				if (img && ctx.drawImage) {
					const x = (op.x ?? 0) * doc.width; const y = (op.y ?? 0) * doc.height;
					const w = (op.w ?? 1) * doc.width; const h = (op.h ?? 1) * doc.height;
					ctx.drawImage(img, x, y, w, h);
				}
			}
			ctx.restore?.();
		}
		ctx.restore?.();
	}
	ctx.restore?.();
}

/** image 图层 `<img>` 元素缓存（url → HTMLImageElement）。LayerEditor 组件负责
 * addImageFromUrl 时预加载 + 缓存；drawLayerDoc 据此取 img。 */
const imageElsCache = new Map<string, HTMLImageElement>();

/** 预加载 image 图层 URL（addImageFromUrl 时调用），加载完成后触发重绘。 */
export function preloadLayerImage(url: string): Promise<HTMLImageElement> {
	const existing = imageElsCache.get(url);
	if (existing) { return Promise.resolve(existing);
	}
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => { imageElsCache.set(url, img); resolve(img); };
		img.onerror = () => reject(new Error(`图片加载失败: ${url.slice(0, 64)}`));
		img.src = url;
	});
}

/** 构造 image 图层 op（占满整幅画布，归一化 box 0,0,1,1）。 */
export function makeImageOp(url: string): LayerOp {
	return { type: 'image', color: '#ffffff', size: 0, imageUrl: url, x: 0, y: 0, w: 1, h: 1 };
}
