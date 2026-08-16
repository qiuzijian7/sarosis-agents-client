/*---------------------------------------------------------------------------------------------
 *  relightEditor — ComfyTV Relight "light-ball" editor (P3 embedded editor).
 *
 *  The ComfyTV RelightStage is a pure-front-end light rig: the user arranges
 *  lights on a 3D ball (`lights_data` JSON), the front-end renders + uploads a
 *  reference PNG (`light_render_url`), and the stage re-emits that render plus
 *  the lighting prompt verbatim (`light_prompt` = `main_prompt`).
 *
 *  We mirror the exact data contract (LightInfoEntry[] from ComfyTV
 *  `widgets/three/light/*`) so a workflow authored here is portable, and draw
 *  a lightweight orthographic light-ball on a 2D canvas (no WebGL needed).
 *  All geometry + parsing helpers are pure and unit-testable.
 *--------------------------------------------------------------------------------------------*/

export type LightInfoType = 'directional' | 'point' | 'spot';

export const LIGHT_TYPES: readonly LightInfoType[] = ['directional', 'point', 'spot'];

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

export interface LightInfoEntry {
	type: LightInfoType;
	color: string;
	intensity: number;
	position: Vec3;
	target?: Vec3;
	range?: number;
	innerConeAngle?: number;
	outerConeAngle?: number;
}

export function createDefaultLight(type: LightInfoType): LightInfoEntry {
	if (type === 'point') {
		return { type, color: '#ffffff', intensity: 25, position: { x: 2, y: 3, z: 2 } };
	}
	if (type === 'spot') {
		return {
			type,
			color: '#ffffff',
			intensity: 25,
			position: { x: 2, y: 3, z: 2 },
			target: { x: 0, y: 0, z: 0 },
			innerConeAngle: 30,
			outerConeAngle: 45,
		};
	}
	return { type: 'directional', color: '#ffffff', intensity: 1.5, position: { x: 0, y: 7.07, z: 7.07 }, target: { x: 0, y: 0, z: 0 } };
}

export function cloneLights(lights: LightInfoEntry[]): LightInfoEntry[] {
	return lights.map(l => ({
		...l,
		position: { ...l.position },
		...(l.target ? { target: { ...l.target } } : {}),
	}));
}

/** Same tolerance rules as ComfyTV normalizeLightsValue. Pure. */
export function normalizeLights(value: unknown): LightInfoEntry[] {
	if (!Array.isArray(value)) { return []; }
	const out: LightInfoEntry[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') { continue; }
		const r = raw as Record<string, unknown>;
		if (typeof r.type !== 'string' || !(LIGHT_TYPES as readonly string[]).includes(r.type)) { continue; }
		const d = createDefaultLight(r.type as LightInfoType);
		const num = (n: unknown, fb: number) => (typeof n === 'number' && Number.isFinite(n) ? n : fb);
		const vec = (v: unknown, fb: Vec3): Vec3 => {
			const o = (v ?? null) as Partial<Vec3> | null;
			return {
				x: typeof o?.x === 'number' && Number.isFinite(o.x) ? o.x : fb.x,
				y: typeof o?.y === 'number' && Number.isFinite(o.y) ? o.y : fb.y,
				z: typeof o?.z === 'number' && Number.isFinite(o.z) ? o.z : fb.z,
			};
		};
		const light: LightInfoEntry = {
			type: r.type as LightInfoType,
			color: typeof r.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(r.color) ? r.color : d.color,
			intensity: Math.max(0, num(r.intensity, d.intensity)),
			position: vec(r.position, d.position),
		};
		if (r.type !== 'point') { light.target = vec(r.target, d.target ?? { x: 0, y: 0, z: 0 }); }
		if (r.type !== 'directional') {
			const range = num(r.range, 0);
			if (range > 0) { light.range = range; }
		}
		if (r.type === 'spot') {
			light.innerConeAngle = num(r.innerConeAngle, d.innerConeAngle ?? 30);
			light.outerConeAngle = num(r.outerConeAngle, d.outerConeAngle ?? 45);
		}
		out.push(light);
	}
	return out;
}

export function parseLightsData(value: unknown): LightInfoEntry[] {
	if (typeof value !== 'string' || !value.trim()) { return []; }
	try {
		return normalizeLights(JSON.parse(value));
	} catch {
		return [];
	}
}

export interface LightPreset {
	key: string;
	lights: LightInfoEntry[];
}

const D = (intensity: number, x: number, y: number, z: number, color = '#ffffff'): LightInfoEntry => ({
	type: 'directional',
	color,
	intensity,
	position: { x, y, z },
	target: { x: 0, y: 0, z: 0 },
});

/** ComfyTV light-ball presets (three-point / Rembrandt / butterfly / rim / side). */
export const LIGHT_PRESETS: LightPreset[] = [
	{ key: 'threePoint', lights: [D(2.5, 2, 3, 2), D(0.8, -2.5, 2, 2), D(1.8, 0, 3, -3)] },
	{ key: 'rembrandt', lights: [D(2.2, 2.2, 2.5, 1.2)] },
	{ key: 'butterfly', lights: [D(2.2, 0, 3, 2.5)] },
	{ key: 'rim', lights: [D(3.0, 0, 2.5, -3.5), D(0.5, 0, 1.5, 3)] },
	{ key: 'side', lights: [D(2.5, 3, 1.2, 0)] },
];

/** The Relight stage is handled by our embedded light-ball editor + local execution. */
export function isRelightNode(type: string): boolean {
	return type === 'ComfyTV.RelightStage';
}

/** Unit direction of a light (target → position). Pure. */
export function lightDirection(light: LightInfoEntry): Vec3 {
	const t = lightTarget(light);
	const dx = light.position.x - t.x;
	const dy = light.position.y - t.y;
	const dz = light.position.z - t.z;
	const m = Math.hypot(dx, dy, dz);
	if (!m) { return { x: 0, y: 0, z: 0 }; }
	return { x: dx / m, y: dy / m, z: dz / m };
}

/** Light target (defaults to origin). Aligned with ComfyTV types.ts lightTarget. */
export function lightTarget(light: LightInfoEntry): Vec3 {
	return light.target ?? { x: 0, y: 0, z: 0 };
}

/**
 * Orthographic projection of a light position onto the light-ball canvas.
 * Returns the offset from the ball center plus a depth hint (front/back and a
 * 0..1 size factor) so back-facing lights render dimmer/hollow.
 */
export function orthographicProject(
	pos: Vec3,
	radius: number,
): { x: number; y: number; front: boolean; size: number } {
	const r = Math.hypot(pos.x, pos.y, pos.z);
	if (!r) { return { x: 0, y: 0, front: true, size: 0.5 }; }
	const ux = pos.x / r;
	const uy = pos.y / r;
	const uz = pos.z / r;
	return { x: ux * radius, y: -uy * radius, front: uz >= 0, size: 0.4 + 0.6 * Math.max(0, uz) };
}

/**
 * Inverse of the orthographic projection: map a canvas point (relative to the
 * ball center, in pixels) back onto the unit sphere facing the viewer.
 * Returns null when the point is outside the ball disc.
 */
export function screenToSphere(sx: number, sy: number, cx: number, cy: number, radius: number): Vec3 | null {
	const dx = (sx - cx) / radius;
	const dy = -(sy - cy) / radius;
	const dz2 = 1 - dx * dx - dy * dy;
	if (dz2 < 0) { return null; }
	const m = Math.hypot(dx, dy, Math.sqrt(dz2));
	if (!m) { return null; }
	return { x: dx / m, y: dy / m, z: Math.sqrt(dz2) / m };
}
