/*---------------------------------------------------------------------------------------------
 *  scene3dEditor — ComfyTV 3D Scene stage support (P3).
 *
 *  数据契约对齐 ComfyTV src/widgets/three/scene3d/types.ts（Scene3DState），
 *  替代旧 2.5D isometric MVP（SceneDoc 归一化地面坐标）。字段/结构/默认值与
 *  ComfyTV 完全一致，scene_state JSON 可直接被 ComfyTV 后端消费。
 *
 *  纯逻辑层：类型 + create/clone/parse 函数 + isScene3DNode。渲染在 Scene3DEditor.tsx
 *  （three.js），执行在 scene3dExecutor.ts（本地透传 captured_image）。
 *--------------------------------------------------------------------------------------------*/

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export interface CharacterAnimationConfig {
	clip: string;
	speed: number;
	loop: boolean;
	startOffset: number;
}

export interface CharacterTransform {
	position: Vec3;
	quaternion: Quat;
	scale: Vec3;
}

export interface SceneCharacterEntry {
	id: string;
	model: string;
	name?: string;
	hidden?: boolean;
	animation: CharacterAnimationConfig;
	transform: CharacterTransform;
}

export interface SceneModelEntry {
	id: string;
	url: string;
	name: string;
	hidden?: boolean;
	animation: CharacterAnimationConfig;
	transform: CharacterTransform;
}

export const PRIMITIVE_SHAPES = ['cube', 'sphere', 'cylinder', 'plane'] as const;
export type PrimitiveShape = (typeof PRIMITIVE_SHAPES)[number];

export const LIGHT_TYPES = ['directional', 'point', 'spot'] as const;
export type SceneLightType = (typeof LIGHT_TYPES)[number];

export interface SceneLightEntry {
	id: string;
	type: SceneLightType;
	name?: string;
	hidden?: boolean;
	color: string;
	intensity: number;
	position: Vec3;
	target?: Vec3;
	range?: number;
	innerConeAngle?: number;
	outerConeAngle?: number;
}

export interface ScenePrimitiveEntry {
	id: string;
	shape: PrimitiveShape;
	color: string;
	name?: string;
	hidden?: boolean;
	transform: CharacterTransform;
}

export interface CameraPresetTuning {
	positionOffset?: Vec3;
	[key: string]: unknown;
}

export interface Scene3DCameraConfig {
	presetId: string;
	file: string;
	tuning: CameraPresetTuning;
	speed: number;
}

export interface SceneCameraEntry {
	id: string;
	name?: string;
	hidden?: boolean;
	fov: number;
	transform: { position: Vec3; quaternion: Quat };
	preset: Scene3DCameraConfig | null;
}

export interface Scene3DOutputConfig { fps: number; frameCount: number; cameraId: string }
export interface SceneEnvironmentConfig { showGrid: boolean; background: string; showRoom: boolean }

export interface Scene3DState {
	version: 1;
	characters: SceneCharacterEntry[];
	primitives: ScenePrimitiveEntry[];
	models: SceneModelEntry[];
	lights: SceneLightEntry[];
	cameras: SceneCameraEntry[];
	environment: SceneEnvironmentConfig;
	output: Scene3DOutputConfig;
}

// ─── 默认值 / 工厂（对齐 ComfyTV types.ts）──────────────────────────────

export function createDefaultEnvironment(): SceneEnvironmentConfig {
	return { showGrid: true, background: '', showRoom: false };
}

export function createEmptyScene(): Scene3DState {
	return {
		version: 1,
		characters: [],
		primitives: [],
		models: [],
		lights: [],
		cameras: [],
		environment: createDefaultEnvironment(),
		output: { fps: 24, frameCount: 0, cameraId: '' },
	};
}

const LIGHT_DEFAULTS: Record<SceneLightType, Omit<SceneLightEntry, 'id'>> = {
	directional: { type: 'directional', color: '#ffffff', intensity: 2, position: { x: 3, y: 5, z: 3 }, target: { x: 0, y: 0, z: 0 } },
	point: { type: 'point', color: '#ffffff', intensity: 8, position: { x: 0, y: 2, z: 0 }, range: 0 },
	spot: { type: 'spot', color: '#ffffff', intensity: 15, position: { x: 0, y: 4, z: 2 }, target: { x: 0, y: 0, z: 0 }, range: 0, innerConeAngle: 30, outerConeAngle: 45 },
};

export function createDefaultLight(type: SceneLightType, existingIds: readonly string[]): SceneLightEntry {
	const taken = new Set(existingIds);
	let index = 1;
	while (taken.has(`light_${index}`)) { index += 1; }
	return { id: `light_${index}`, ...cloneLight(LIGHT_DEFAULTS[type]) };
}

function cloneLight<T extends Omit<SceneLightEntry, 'id'>>(light: T): T {
	return { ...light, position: { ...light.position }, ...(light.target ? { target: { ...light.target } } : {}) };
}

const DEFAULT_PRIMITIVE_COLOR = '#9aa0a6';

export function createDefaultPrimitive(shape: PrimitiveShape, existingIds: readonly string[]): ScenePrimitiveEntry {
	const taken = new Set(existingIds);
	let index = 1;
	while (taken.has(`prim_${index}`)) { index += 1; }
	return {
		id: `prim_${index}`,
		shape,
		color: DEFAULT_PRIMITIVE_COLOR,
		transform: {
			position: { x: 0, y: shape === 'plane' ? 0 : 0.5, z: 0 },
			quaternion: { x: 0, y: 0, z: 0, w: 1 },
			scale: { x: 1, y: 1, z: 1 },
		},
	};
}

export function createDefaultCamera(existingIds: readonly string[], pose?: { position: Vec3; quaternion: Quat; fov: number }): SceneCameraEntry {
	const taken = new Set(existingIds);
	let index = 1;
	while (taken.has(`cam_${index}`)) { index += 1; }
	return {
		id: `cam_${index}`,
		fov: pose?.fov ?? 50,
		transform: {
			position: pose ? { ...pose.position } : { x: 4, y: 2.5, z: 4 },
			quaternion: pose ? { ...pose.quaternion } : { x: 0, y: 0, z: 0, w: 1 },
		},
		preset: null,
	};
}

export function createDefaultCharacter(model: string, existingIds: readonly string[]): SceneCharacterEntry {
	const taken = new Set(existingIds);
	let index = 1;
	while (taken.has(`char_${index}`)) { index += 1; }
	return {
		id: `char_${index}`,
		model,
		animation: { clip: '', speed: 1, loop: true, startOffset: 0 },
		transform: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
	};
}

export function createDefaultModel(url: string, name: string, existingIds: readonly string[]): SceneModelEntry {
	const taken = new Set(existingIds);
	let index = 1;
	while (taken.has(`model_${index}`)) { index += 1; }
	return {
		id: `model_${index}`,
		url,
		name,
		animation: { clip: '', speed: 1, loop: true, startOffset: 0 },
		transform: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
	};
}

export function cloneTransform(transform: CharacterTransform): CharacterTransform {
	return {
		position: { ...transform.position },
		quaternion: { ...transform.quaternion },
		scale: { ...transform.scale },
	};
}

export function cloneScene(state: Scene3DState): Scene3DState {
	return {
		version: 1,
		characters: state.characters.map(c => ({ ...c, animation: { ...c.animation }, transform: cloneTransform(c.transform) })),
		primitives: state.primitives.map(p => ({ ...p, transform: cloneTransform(p.transform) })),
		models: state.models.map(m => ({ ...m, animation: { ...m.animation }, transform: cloneTransform(m.transform) })),
		lights: state.lights.map(l => cloneLight(l)),
		cameras: state.cameras.map(c => ({
			...c,
			transform: { position: { ...c.transform.position }, quaternion: { ...c.transform.quaternion } },
			preset: c.preset ? { ...c.preset, tuning: { ...c.preset.tuning } } : null,
		})),
		environment: { ...state.environment },
		output: { ...state.output },
	};
}

export function isScene3DNode(type: string): boolean {
	return type === 'ComfyTV.Scene3DStage';
}

// ─── 序列化 / 防御解析 ──────────────────────────────────────────────────

export function sceneStateToJson(state: Scene3DState): string {
	return JSON.stringify(state);
}

const validShape = (v: unknown): v is PrimitiveShape => PRIMITIVE_SHAPES.includes(v as PrimitiveShape);
const validLightType = (v: unknown): v is SceneLightType => LIGHT_TYPES.includes(v as SceneLightType);

function safeVec3(v: unknown, fb: Vec3): Vec3 {
	if (!v || typeof v !== 'object') { return { ...fb }; }
	const o = v as Record<string, unknown>;
	return {
		x: Number.isFinite(Number(o.x)) ? Number(o.x) : fb.x,
		y: Number.isFinite(Number(o.y)) ? Number(o.y) : fb.y,
		z: Number.isFinite(Number(o.z)) ? Number(o.z) : fb.z,
	};
}

function safeQuat(v: unknown): Quat {
	if (!v || typeof v !== 'object') { return { x: 0, y: 0, z: 0, w: 1 }; }
	const o = v as Record<string, unknown>;
	return {
		x: Number.isFinite(Number(o.x)) ? Number(o.x) : 0,
		y: Number.isFinite(Number(o.y)) ? Number(o.y) : 0,
		z: Number.isFinite(Number(o.z)) ? Number(o.z) : 0,
		w: Number.isFinite(Number(o.w)) ? Number(o.w) : 1,
	};
}

function safeTransform(v: unknown): CharacterTransform {
	if (!v || typeof v !== 'object') {
		return { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } };
	}
	const o = v as Record<string, unknown>;
	return {
		position: safeVec3(o.position, { x: 0, y: 0, z: 0 }),
		quaternion: safeQuat(o.quaternion),
		scale: safeVec3(o.scale, { x: 1, y: 1, z: 1 }),
	};
}

/**
 * 防御解析 scene_state JSON（旧 2.5D SceneDoc 或非法输入 → 返回空场景）。
 * 旧 SceneDoc 无 version 字段，无法安全迁移，按空场景处理。
 */
export function parseSceneState(value: unknown): Scene3DState {
	if (typeof value !== 'string' || !value.trim()) { return createEmptyScene(); }
	let data: unknown;
	try { data = JSON.parse(value); } catch { return createEmptyScene(); }
	if (!data || typeof data !== 'object') { return createEmptyScene(); }
	const o = data as Record<string, unknown>;
	if (o.version !== 1) { return createEmptyScene(); }

	const primitives = Array.isArray(o.primitives)
		? (o.primitives as Array<Record<string, unknown>>)
			.filter(p => p && typeof p === 'object' && typeof p.id === 'string' && validShape(p.shape))
			.map(p => ({
				id: String(p.id),
				shape: p.shape as PrimitiveShape,
				color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toLowerCase() : DEFAULT_PRIMITIVE_COLOR,
				...(typeof p.name === 'string' ? { name: p.name } : {}),
				...(p.hidden ? { hidden: true } : {}),
				transform: safeTransform(p.transform),
			}))
		: [];

	const lights = Array.isArray(o.lights)
		? (o.lights as Array<Record<string, unknown>>)
			.filter(l => l && typeof l === 'object' && typeof l.id === 'string' && validLightType(l.type))
			.map(l => {
				const type = l.type as SceneLightType;
				const entry: SceneLightEntry = {
					id: String(l.id),
					type,
					color: typeof l.color === 'string' && /^#[0-9a-f]{6}$/i.test(l.color) ? l.color.toLowerCase() : '#ffffff',
					intensity: Number.isFinite(Number(l.intensity)) ? Number(l.intensity) : 1,
					position: safeVec3(l.position, { x: 0, y: 2, z: 0 }),
				};
				if (l.target && typeof l.target === 'object') { entry.target = safeVec3(l.target, { x: 0, y: 0, z: 0 }); }
				if (Number.isFinite(Number(l.range))) { entry.range = Number(l.range); }
				if (Number.isFinite(Number(l.innerConeAngle))) { entry.innerConeAngle = Number(l.innerConeAngle); }
				if (Number.isFinite(Number(l.outerConeAngle))) { entry.outerConeAngle = Number(l.outerConeAngle); }
				return entry;
			})
		: [];

	return {
		version: 1,
		characters: [],  // characters/models 需 GLB 加载，本地编辑器不持久化，空数组占位
		models: [],
		primitives,
		lights,
		cameras: [],
		environment: {
			showGrid: o.environment && typeof o.environment === 'object' ? (o.environment as Record<string, unknown>).showGrid !== false : true,
			background: o.environment && typeof o.environment === 'object' && typeof (o.environment as Record<string, unknown>).background === 'string' ? (o.environment as Record<string, unknown>).background as string : '',
			showRoom: o.environment && typeof o.environment === 'object' ? (o.environment as Record<string, unknown>).showRoom === true : false,
		},
		output: {
			fps: o.output && typeof o.output === 'object' && Number.isFinite(Number((o.output as Record<string, unknown>).fps)) ? Number((o.output as Record<string, unknown>).fps) : 24,
			frameCount: o.output && typeof o.output === 'object' && Number.isFinite(Number((o.output as Record<string, unknown>).frameCount)) ? Number((o.output as Record<string, unknown>).frameCount) : 0,
			cameraId: o.output && typeof o.output === 'object' && typeof (o.output as Record<string, unknown>).cameraId === 'string' ? (o.output as Record<string, unknown>).cameraId as string : '',
		},
	};
}

// ─── 对象操作（immutable，供 Scene3DEditor 使用）────────────────────────

export function addPrimitive(state: Scene3DState, shape: PrimitiveShape): Scene3DState {
	const next = cloneScene(state);
	next.primitives.push(createDefaultPrimitive(shape, next.primitives.map(p => p.id)));
	return next;
}

export function addLight(state: Scene3DState, type: SceneLightType): Scene3DState {
	const next = cloneScene(state);
	next.lights.push(createDefaultLight(type, next.lights.map(l => l.id)));
	return next;
}

export function removePrimitive(state: Scene3DState, id: string): Scene3DState {
	return { ...state, primitives: state.primitives.filter(p => p.id !== id) };
}

export function removeLight(state: Scene3DState, id: string): Scene3DState {
	return { ...state, lights: state.lights.filter(l => l.id !== id) };
}

export function addCamera(state: Scene3DState, pose?: { position: Vec3; quaternion: Quat; fov: number }): Scene3DState {
	const next = cloneScene(state);
	next.cameras.push(createDefaultCamera(next.cameras.map(c => c.id), pose));
	return next;
}

export function removeCamera(state: Scene3DState, id: string): Scene3DState {
	const next = cloneScene(state);
	next.cameras = next.cameras.filter(c => c.id !== id);
	if (next.output.cameraId === id) { next.output.cameraId = ''; }
	return next;
}

export function patchCamera(state: Scene3DState, id: string, patch: Partial<Omit<SceneCameraEntry, 'id'>>): Scene3DState {
	return {
		...state,
		cameras: state.cameras.map(c => (c.id === id ? { ...c, ...patch, transform: patch.transform ? { position: { ...patch.transform.position }, quaternion: { ...patch.transform.quaternion } } : c.transform } : c)),
	};
}

export function patchEnvironment(state: Scene3DState, patch: Partial<SceneEnvironmentConfig>): Scene3DState {
	return { ...state, environment: { ...state.environment, ...patch } };
}

export function patchOutput(state: Scene3DState, patch: Partial<Scene3DOutputConfig>): Scene3DState {
	return { ...state, output: { ...state.output, ...patch } };
}

export function patchPrimitive(state: Scene3DState, id: string, patch: Partial<Omit<ScenePrimitiveEntry, 'id'>>): Scene3DState {
	return { ...state, primitives: state.primitives.map(p => (p.id === id ? { ...p, ...patch, transform: patch.transform ? cloneTransform(patch.transform) : p.transform } : p)) };
}

export function patchLight(state: Scene3DState, id: string, patch: Partial<Omit<SceneLightEntry, 'id'>>): Scene3DState {
	return { ...state, lights: state.lights.map(l => (l.id === id ? { ...l, ...patch } : l)) };
}

/** 灯光 target（默认原点），对齐 ComfyTV types.ts lightTarget。 */
export function lightTarget(light: SceneLightEntry): Vec3 {
	return light.target ?? { x: 0, y: 0, z: 0 };
}

/** 从 quaternion 反推绕 Y 轴的 yaw（弧度）。纯函数。 */
export function rotationYOf(entry: { transform: { quaternion: Quat } }): number {
	const { x, y, z, w } = entry.transform.quaternion;
	// 绕 Y 轴欧拉角：yaw = atan2(2(wy + xz), 1 - 2(y² + z²))
	return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

/** 由绕 Y 轴 yaw（弧度）构造 quaternion。纯函数。 */
export function quaternionFromYaw(yaw: number): Quat {
	const half = yaw / 2;
	return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}
