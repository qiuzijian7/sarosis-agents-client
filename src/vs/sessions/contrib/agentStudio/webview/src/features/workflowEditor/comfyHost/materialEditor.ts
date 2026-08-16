/*---------------------------------------------------------------------------------------------
 *  materialEditor — ComfyTV Material stage support (P3 embedded editor).
 *
 *  数据契约对齐 ComfyTV widgets/material/types.ts（MaterialParams 11 字段，
 *  含 version/opacity/ior/emissive/emissiveIntensity）。material_state JSON
 *  可直接被 ComfyTV 后端消费。
 *
 *  渲染：MaterialEditor.tsx 用 three.js MeshPhysicalMaterial + RoomEnvironment
 *  环境贴图（对齐 ComfyTV MaterialSphere.vue）。本模块保留纯逻辑 + 2D fallback
 *  renderer（WebGL 不可用时）。
 *--------------------------------------------------------------------------------------------*/

export interface MaterialParams {
	version: 1;
	color: string;
	metalness: number;
	roughness: number;
	transmission: number;
	opacity: number;
	clearcoat: number;
	clearcoatRoughness: number;
	ior: number;
	emissive: string;
	emissiveIntensity: number;
}

export const DEFAULT_MATERIAL: MaterialParams = {
	version: 1,
	color: '#8fbf8f',
	metalness: 0,
	roughness: 0.4,
	transmission: 0,
	opacity: 1,
	clearcoat: 0,
	clearcoatRoughness: 0.1,
	ior: 1.5,
	emissive: '#000000',
	emissiveIntensity: 0,
};

export interface MaterialPreset {
	key: string;
	params: Omit<MaterialParams, 'version' | 'color' | 'emissive'>;
}

const preset = (p: Partial<Omit<MaterialParams, 'version' | 'color' | 'emissive'>>): MaterialPreset['params'] => ({
	metalness: 0,
	roughness: 0.4,
	transmission: 0,
	opacity: 1,
	clearcoat: 0,
	clearcoatRoughness: 0.1,
	ior: 1.5,
	emissiveIntensity: 0,
	...p,
});

export const MATERIAL_PRESETS: MaterialPreset[] = [
	{ key: 'plasticGlossy', params: preset({ roughness: 0.15, clearcoat: 0.6 }) },
	{ key: 'plasticMatte', params: preset({ roughness: 0.75 }) },
	{ key: 'metalPolished', params: preset({ metalness: 1, roughness: 0.08 }) },
	{ key: 'metalBrushed', params: preset({ metalness: 1, roughness: 0.45 }) },
	{ key: 'glassClear', params: preset({ roughness: 0.05, transmission: 1 }) },
	{ key: 'glassFrosted', params: preset({ roughness: 0.45, transmission: 1 }) },
	{ key: 'rubber', params: preset({ roughness: 0.95 }) },
	{ key: 'ceramic', params: preset({ roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 }) },
];

/** Slider 定义（对齐 ComfyTV MATERIAL_SLIDERS）。 */
export const MATERIAL_SLIDERS: Array<{ key: keyof MaterialParams; min: number; max: number; step: number; label: string }> = [
	{ key: 'metalness', min: 0, max: 1, step: 0.01, label: 'Metalness' },
	{ key: 'roughness', min: 0, max: 1, step: 0.01, label: 'Roughness' },
	{ key: 'transmission', min: 0, max: 1, step: 0.01, label: 'Transmission' },
	{ key: 'opacity', min: 0, max: 1, step: 0.01, label: 'Opacity' },
	{ key: 'clearcoat', min: 0, max: 1, step: 0.01, label: 'Clearcoat' },
	{ key: 'clearcoatRoughness', min: 0, max: 1, step: 0.01, label: 'Clearcoat Roughness' },
	{ key: 'ior', min: 1, max: 2.333, step: 0.001, label: 'IOR' },
	{ key: 'emissiveIntensity', min: 0, max: 1, step: 0.01, label: 'Emissive Intensity' },
];

const clamp01 = (v: unknown, fallback: number): number => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const asHex = (v: unknown, fallback: string): string =>
	typeof v === 'string' && HEX_RE.test(v) ? v.toLowerCase() : fallback;

/** Normalize a material (mirrors ComfyTV normalizeMaterial). Pure. */
export function normalizeMaterial(src: Record<string, unknown>): MaterialParams {
	const d = DEFAULT_MATERIAL;
	const ior = Number(src.ior);
	return {
		version: 1,
		color: asHex(src.color, d.color),
		metalness: clamp01(src.metalness, d.metalness),
		roughness: clamp01(src.roughness, d.roughness),
		transmission: clamp01(src.transmission, d.transmission),
		opacity: clamp01(src.opacity, d.opacity),
		clearcoat: clamp01(src.clearcoat, d.clearcoat),
		clearcoatRoughness: clamp01(src.clearcoatRoughness, d.clearcoatRoughness),
		ior: Number.isFinite(ior) ? Math.min(2.333, Math.max(1, ior)) : d.ior,
		emissive: asHex(src.emissive, d.emissive),
		emissiveIntensity: clamp01(src.emissiveIntensity, d.emissiveIntensity),
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
	return JSON.stringify(normalizeMaterial(p));
}

export function applyPreset(base: MaterialParams, presetParams: Partial<MaterialParams>): MaterialParams {
	return normalizeMaterial({ ...base, ...presetParams });
}

export function isMaterialNode(type: string): boolean {
	return type === 'ComfyTV.MaterialStage';
}

/** Structural canvas-2D-like context for the 2D material ball fallback renderer. */
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

/** Rendered material ball (2D fallback, dark studio backdrop, specular highlights). */
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
	// emissive glow
	if (p.emissiveIntensity > 0.01) {
		ctx.fillStyle = p.emissive;
		ctx.globalAlpha = p.emissiveIntensity * 0.6;
		ctx.beginPath?.();
		ctx.arc?.(cx, cy, r * 0.95, 0, Math.PI * 2);
		ctx.fill?.();
		ctx.globalAlpha = 1;
	}
	// secondary soft bounce
	ctx.fillStyle = `rgba(255,255,255,${0.14 * (1 - p.metalness)})`;
	ctx.beginPath?.();
	ctx.arc?.(cx + r * 0.5, cy + r * 0.5, r * 0.12, 0, Math.PI * 2);
	ctx.fill?.();
}
