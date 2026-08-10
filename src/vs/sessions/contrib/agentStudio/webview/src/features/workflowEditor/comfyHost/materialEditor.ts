/*---------------------------------------------------------------------------------------------
 *  materialEditor — ComfyTV Material stage support (P3 embedded editor).
 *
 *  The stage holds hidden `material_state` (PBR JSON) + `captured_image` (the
 *  material-ball preview uploaded by the node body); output material
 *  (COMFYTV_MATERIAL) + image. We mirror the exact MaterialParams contract from
 *  ComfyTV `widgets/material/types.ts` (portable), render a lightweight
 *  material ball on a 2D canvas and debounce-upload it.
 *--------------------------------------------------------------------------------------------*/

export interface MaterialParams {
	color: string;
	metalness: number;
	roughness: number;
	transmission: number;
	clearcoat: number;
	clearcoatRoughness: number;
}

export const DEFAULT_MATERIAL: MaterialParams = {
	color: '#8fbf8f',
	metalness: 0,
	roughness: 0.4,
	transmission: 0,
	clearcoat: 0,
	clearcoatRoughness: 0.1,
};

export interface MaterialPreset {
	key: string;
	params: Partial<MaterialParams>;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
	{ key: 'plasticGlossy', params: { roughness: 0.15, clearcoat: 0.6 } },
	{ key: 'plasticMatte', params: { roughness: 0.75 } },
	{ key: 'metalPolished', params: { metalness: 1, roughness: 0.08 } },
	{ key: 'metalBrushed', params: { metalness: 1, roughness: 0.45 } },
	{ key: 'glassClear', params: { roughness: 0.05, transmission: 1 } },
	{ key: 'glassFrosted', params: { roughness: 0.45, transmission: 1 } },
	{ key: 'rubber', params: { roughness: 0.95 } },
	{ key: 'ceramic', params: { roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 } },
];

export function clamp01(v: number, fallback: number): number {
	return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
}

/** Normalize a material (mirrors ComfyTV normalizeMaterial). Pure. */
export function normalizeMaterial(src: Record<string, unknown>): MaterialParams {
	const color = typeof src.color === 'string' && /^#[0-9a-f]{6}$/i.test(src.color)
		? src.color.toLowerCase()
		: DEFAULT_MATERIAL.color;
	const num = (k: string, d: number) => clamp01(Number(src[k]), d);
	return {
		color,
		metalness: num('metalness', DEFAULT_MATERIAL.metalness),
		roughness: num('roughness', DEFAULT_MATERIAL.roughness),
		transmission: num('transmission', DEFAULT_MATERIAL.transmission),
		clearcoat: num('clearcoat', DEFAULT_MATERIAL.clearcoat),
		clearcoatRoughness: num('clearcoatRoughness', DEFAULT_MATERIAL.clearcoatRoughness),
	};
}

export function parseMaterialState(value: unknown): MaterialParams {
	if (typeof value !== 'string' || !value.trim()) { return { ...DEFAULT_MATERIAL }; }
	try {
		const data = JSON.parse(value);
		return normalizeMaterial(data && typeof data === 'object' ? data : {});
	} catch {
		return { ...DEFAULT_MATERIAL };
	}
}

export function materialStateToJson(p: MaterialParams): string {
	return JSON.stringify(p);
}

export function applyPreset(base: MaterialParams, preset: Partial<MaterialParams>): MaterialParams {
	return { ...base, ...preset };
}

export function isMaterialNode(type: string): boolean {
	return type === 'ComfyTV.MaterialStage';
}

/** Structural canvas-2D-like context for the material ball renderer. */
export interface MaterialCtxLike {
	fillStyle?: string;
	globalAlpha?: number;
	fillRect?: (x: number, y: number, w: number, h: number) => void;
	beginPath?: () => void;
	arc?: (x: number, y: number, r: number, a0: number, a1: number) => void;
	fill?: () => void;
	createRadialGradient?: (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) => { addColorStop: (p: number, c: string) => void };
	stroke?: () => void;
	strokeStyle?: string;
	lineWidth?: number;
	ellipse?: (x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number) => void;
}

/** Rendered material ball (dark studio backdrop, specular highlights). Pure (draws). */
export function renderMaterialBall(
	ctx: MaterialCtxLike,
	p: MaterialParams,
	cx: number,
	cy: number,
	r: number,
): void {
	const hex = p.color;
	const lighten = (amt: number): string => {
		const n = parseInt(hex.slice(1), 16);
		const ch = (shift: number) => {
			const v = (n >> shift) & 0xff;
			return Math.round(Math.min(255, v + (255 - v) * amt));
		};
		return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
	};
	// backdrop
	ctx.fillStyle = '#17181c';
	ctx.fillRect?.(0, 0, cx * 2, cy * 2);
	// ground shadow
	ctx.fillStyle = 'rgba(0,0,0,.45)';
	ctx.beginPath?.();
	ctx.ellipse?.(cx, cy + r * 0.78, r * 0.85, r * 0.22, 0, 0, Math.PI * 2);
	ctx.fill?.();
	// ball (base gradient)
	const grad = ctx.createRadialGradient?.(cx - r * 0.35, cy - r * 0.45, r * 0.1, cx, cy, r);
	if (grad) {
		grad.addColorStop(0, lighten(p.metalness * 0.35 + 0.35));
		grad.addColorStop(0.55, hex);
		grad.addColorStop(1, lighten(-0.45));
	}
	ctx.fillStyle = grad ?? hex;
	ctx.beginPath?.();
	ctx.arc?.(cx, cy, r, 0, Math.PI * 2);
	ctx.fill?.();
	// transmission sheen (hollow feel)
	if (p.transmission > 0.02) {
		ctx.fillStyle = `rgba(255,255,255,${p.transmission * 0.22})`;
		ctx.beginPath?.();
		ctx.arc?.(cx, cy, r * 0.98, 0, Math.PI * 2);
		ctx.fill?.();
	}
	// specular highlight (sharper when roughness low)
	const rough = Math.max(0.05, p.roughness);
	const hr = r * (0.28 + rough * 0.5);
	const alpha = p.metalness > 0.5 ? 0.65 : 0.85;
	ctx.fillStyle = p.metalness > 0.5 ? lighten(0.6) : `rgba(255,255,255,${alpha})`;
	ctx.globalAlpha = 1 - rough * 0.55;
	ctx.beginPath?.();
	ctx.arc?.(cx - r * 0.32, cy - r * 0.4, hr, 0, Math.PI * 2);
	ctx.fill?.();
	ctx.globalAlpha = 1;
	// secondary soft bounce
	ctx.fillStyle = `rgba(255,255,255,${0.14 * (1 - p.metalness)})`;
	ctx.beginPath?.();
	ctx.arc?.(cx + r * 0.5, cy + r * 0.5, r * 0.12, 0, Math.PI * 2);
	ctx.fill?.();
}
