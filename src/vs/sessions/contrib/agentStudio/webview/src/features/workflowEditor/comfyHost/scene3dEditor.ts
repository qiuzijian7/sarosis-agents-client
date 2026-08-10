/*---------------------------------------------------------------------------------------------
 *  scene3dEditor — ComfyTV 3D Scene stage support (P3, 2.5D isometric MVP).
 *
 *  The stage holds hidden `scene_state` JSON (characters/primitives/lights/
 *  camera/output) + channel + width/height and uploads `captured_image` from
 *  the browser. A full WebGL viewport is out of scope here; we provide an
 *  isometric 2.5D scene editor (place box/cylinder/sphere primitives on a
 *  ground grid, capture a composite) while keeping the scene_state JSON
 *  structure aligned with ComfyTV.
 *--------------------------------------------------------------------------------------------*/

export type ScenePrimitiveKind = 'box' | 'cylinder' | 'sphere';

export interface SceneObject {
	id: string;
	name: string;
	kind: ScenePrimitiveKind;
	/** ground position, normalized 0..1 (isometric plane) */
	x: number;
	y: number;
	/** footprint size, normalized 0..1 */
	size: number;
	/** extrusion height, normalized 0..1 */
	height: number;
	color: string;
}

export interface SceneDoc {
	width: number;
	height: number;
	objects: SceneObject[];
}

let sceneSeq = 0;
function newSceneObjectId(): string {
	sceneSeq += 1;
	return `obj_${sceneSeq}`;
}

export function defaultSceneDoc(width = 1024, height = 1024): SceneDoc {
	return {
		width,
		height,
		objects: [
			{ id: newSceneObjectId(), name: '主角', kind: 'box', x: 0.5, y: 0.5, size: 0.28, height: 0.5, color: '#4a9eff' },
			{ id: newSceneObjectId(), name: '配角', kind: 'sphere', x: 0.3, y: 0.68, size: 0.2, height: 0.35, color: '#e6b553' },
		],
	};
}

export function parseSceneDoc(value: unknown, width = 1024, height = 1024): SceneDoc {
	if (typeof value !== 'string' || !value.trim()) { return defaultSceneDoc(width, height); }
	try {
		const data = JSON.parse(value);
		if (!data || typeof data !== 'object' || !Array.isArray(data.objects)) { return defaultSceneDoc(width, height); }
		const objects = data.objects
			.filter((o: unknown) => o && typeof o === 'object')
			.map((o: Record<string, unknown>): SceneObject => ({
				id: typeof o.id === 'string' ? o.id : newSceneObjectId(),
				name: typeof o.name === 'string' ? o.name : '对象',
				kind: o.kind === 'cylinder' || o.kind === 'sphere' ? o.kind : 'box',
				x: clamp01v(Number(o.x), 0.5),
				y: clamp01v(Number(o.y), 0.5),
				size: Math.max(0.05, Math.min(1, Number(o.size) || 0.2)),
				height: Math.max(0.05, Math.min(1, Number(o.height) || 0.4)),
				color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color.toLowerCase() : '#4a9eff',
			}));
		return { width: Number(data.width) || width, height: Number(data.height) || height, objects: objects.length ? objects : defaultSceneDoc(width, height).objects };
	} catch {
		return defaultSceneDoc(width, height);
	}
}

function clamp01v(v: number, fb: number): number {
	return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fb;
}

export function sceneDocToJson(doc: SceneDoc): string {
	return JSON.stringify({ width: doc.width, height: doc.height, objects: doc.objects });
}

export function addSceneObject(doc: SceneDoc, kind: ScenePrimitiveKind): SceneDoc {
	return {
		...doc,
		objects: [...doc.objects, {
			id: newSceneObjectId(),
			name: kind === 'box' ? '长方体' : kind === 'cylinder' ? '圆柱' : '球体',
			kind,
			x: 0.5,
			y: 0.5,
			size: 0.2,
			height: 0.4,
			color: '#4a9eff',
		}],
	};
}

export function removeSceneObject(doc: SceneDoc, id: string): SceneDoc {
	if (doc.objects.length <= 1) { return doc; }
	return { ...doc, objects: doc.objects.filter(o => o.id !== id) };
}

export function patchSceneObject(doc: SceneDoc, id: string, patch: Partial<Omit<SceneObject, 'id'>>): SceneDoc {
	return { ...doc, objects: doc.objects.map(o => (o.id === id ? { ...o, ...patch } : o)) };
}

export function isScene3DNode(type: string): boolean {
	return type === 'ComfyTV.Scene3DStage';
}

/**
 * Isometric projection (ground normalized 0..1 → pixel space).
 * sx = cx + (x - y)·K, sy = cy + (x + y)·K·0.5 − height·KH.
 * Pure.
 */
export function projectIso(
	x: number,
	y: number,
	height: number,
	W: number,
	H: number,
): { sx: number; sy: number; k: number; kh: number } {
	const cx = W / 2;
	const cy = H / 2;
	const G = Math.min(W, H) * 0.72;
	const k = G / 2;
	const kh = G * 0.5;
	return {
		// (0.5,0.5) lands on the canvas center; the ground diamond spans
		// around it symmetrically.
		sx: cx + (x - y) * k,
		sy: cy + (x + y - 1) * k * 0.5 - height * kh,
		k,
		kh,
	};
}

/**
 * Inverse isometric projection: pixel point (relative to a W×H canvas center)
 * → normalized ground coordinates (height ignored). Pure.
 */
export function screenToGround(
	sx: number,
	sy: number,
	W: number,
	H: number,
): { x: number; y: number } {
	const cx = W / 2;
	const cy = H / 2;
	const k = (Math.min(W, H) * 0.72) / 2;
	const sum = (sy - cy) / (k * 0.5) + 1; // x + y (mirrors the centered projection)
	const diff = (sx - cx) / k;            // x - y
	return {
		x: Math.max(0, Math.min(1, (sum + diff) / 2)),
		y: Math.max(0, Math.min(1, (sum - diff) / 2)),
	};
}

/** Structural canvas-2D-like context for the scene renderer. */
export interface SceneCtxLike {
	fillStyle?: string;
	strokeStyle?: string;
	lineWidth?: number;
	globalAlpha?: number;
	fillRect?: (x: number, y: number, w: number, h: number) => void;
	fillText?: (t: string, x: number, y: number) => void;
	beginPath?: () => void;
	moveTo?: (x: number, y: number) => void;
	lineTo?: (x: number, y: number) => void;
	closePath?: () => void;
	arc?: (x: number, y: number, r: number, a0: number, a1: number) => void;
	ellipse?: (x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number) => void;
	fill?: () => void;
	stroke?: () => void;
}

/** Render the isometric ground grid + primitives. Pure (draws). */
export function renderScene(ctx: SceneCtxLike, doc: SceneDoc): void {
	const W = doc.width;
	const H = doc.height;
	// ground grid
	ctx.strokeStyle = 'rgba(255,255,255,.14)';
	ctx.lineWidth = 1;
	ctx.beginPath?.();
	for (let i = 0; i <= 4; i++) {
		const u = i / 4;
		const a = projectIso(u, 0, 0, W, H);
		const b = projectIso(u, 1, 0, W, H);
		ctx.moveTo?.(a.sx, a.sy); ctx.lineTo?.(b.sx, b.sy);
		const c = projectIso(0, u, 0, W, H);
		const d = projectIso(1, u, 0, W, H);
		ctx.moveTo?.(c.sx, c.sy); ctx.lineTo?.(d.sx, d.sy);
	}
	ctx.stroke?.();
	// primitives (sorted back→front by screen y)
	const sorted = [...doc.objects].sort((a, b) => (a.x + a.y) - (b.x + b.y));
	for (const obj of sorted) {
		drawPrimitive(ctx, obj, W, H);
	}
}

function drawPrimitive(ctx: SceneCtxLike, obj: SceneObject, W: number, H: number): void {
	const base = projectIso(obj.x, obj.y, 0, W, H);
	const top = projectIso(obj.x, obj.y, obj.height, W, H);
	const half = obj.size * base.k * 0.8;
	const dark = shade(obj.color, -0.45);
	const mid = shade(obj.color, -0.2);
	// ground shadow
	ctx.fillStyle = 'rgba(0,0,0,.35)';
	ctx.beginPath?.();
	ctx.ellipse?.(base.sx, base.sy + half * 0.25, half * 1.3, half * 0.5, 0, 0, Math.PI * 2);
	ctx.fill?.();

	if (obj.kind === 'box') {
		// top face (iso parallelogram)
		ctx.fillStyle = obj.color;
		ctx.beginPath?.();
		ctx.moveTo?.(top.sx - half, top.sy - half * 0.5);
		ctx.lineTo?.(top.sx, top.sy - half);
		ctx.lineTo?.(top.sx + half, top.sy - half * 0.5);
		ctx.lineTo?.(top.sx, top.sy);
		ctx.closePath?.();
		ctx.fill?.();
		// left side
		ctx.fillStyle = mid;
		ctx.beginPath?.();
		ctx.moveTo?.(top.sx - half, top.sy - half * 0.5);
		ctx.lineTo?.(base.sx - half, base.sy - half * 0.5);
		ctx.lineTo?.(base.sx, base.sy);
		ctx.lineTo?.(top.sx, top.sy);
		ctx.closePath?.();
		ctx.fill?.();
		// right side
		ctx.fillStyle = dark;
		ctx.beginPath?.();
		ctx.moveTo?.(top.sx, top.sy);
		ctx.lineTo?.(base.sx, base.sy);
		ctx.lineTo?.(base.sx + half, base.sy - half * 0.5);
		ctx.lineTo?.(top.sx + half, top.sy - half * 0.5);
		ctx.closePath?.();
		ctx.fill?.();
	} else if (obj.kind === 'cylinder') {
		// side
		ctx.fillStyle = mid;
		ctx.beginPath?.();
		ctx.moveTo?.(top.sx - half, top.sy - half * 0.5);
		ctx.lineTo?.(base.sx - half, base.sy - half * 0.5);
		ctx.ellipse?.(base.sx, base.sy, half, half * 0.5, 0, Math.PI / 2, Math.PI * 1.5);
		ctx.lineTo?.(top.sx + half, top.sy - half * 0.5);
		ctx.lineTo?.(top.sx - half, top.sy - half * 0.5);
		ctx.closePath?.();
		ctx.fill?.();
		// top ellipse
		ctx.fillStyle = obj.color;
		ctx.beginPath?.();
		ctx.ellipse?.(top.sx, top.sy, half, half * 0.5, 0, 0, Math.PI * 2);
		ctx.fill?.();
	} else {
		// sphere
		ctx.fillStyle = obj.color;
		ctx.beginPath?.();
		ctx.arc?.(top.sx, top.sy - half * 0.4, half * 0.9, 0, Math.PI * 2);
		ctx.fill?.();
		ctx.fillStyle = 'rgba(255,255,255,.35)';
		ctx.beginPath?.();
		ctx.arc?.(top.sx - half * 0.3, top.sy - half * 0.7, half * 0.25, 0, Math.PI * 2);
		ctx.fill?.();
	}
	// label
	ctx.fillStyle = 'rgba(255,255,255,.7)';
	ctx.font = '9px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.fillText?.(obj.name, top.sx, top.sy - half - 4);
}

function shade(hex: string, amt: number): string {
	const n = parseInt(hex.slice(1), 16);
	const ch = (shift: number) => {
		const v = (n >> shift) & 0xff;
		return Math.round(Math.max(0, Math.min(255, v + amt * 255)));
	};
	return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
