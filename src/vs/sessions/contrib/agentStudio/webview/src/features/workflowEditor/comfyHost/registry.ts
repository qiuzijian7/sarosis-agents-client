/*---------------------------------------------------------------------------------------------
 *  LiteGraph Node Registry — three-tier node registration.
 *
 *  Keeps all LiteGraph interaction behind a small facade so tests can run without
 *  touching the real @comfyorg/litegraph singleton, and so the webview never calls
 *  `LiteGraph.registerNodeType` directly.
 *
 *  Node kinds:
 *   - 'react'  : existing Sarosis.* nodes, cards rendered as React components
 *                (React is preserved; no Vue bridge).
 *   - 'schema' : ComfyTV-style stages. Only the registration info (kind/inputs/outputs)
 *                is consumed; the card is rendered by a React component driven by that schema.
 *   - 'native' : ComfyUI native nodes, dynamically registered from /object_info.
 *
 *  Port type vocabulary (mirrors LiteGraph link `type`):
 *   'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'SAROSIS_JSON' | 'ANY'
 *--------------------------------------------------------------------------------------------*/

export type PortType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'SAROSIS_JSON' | 'ANY';
import { INSTANT_WIDGETS } from './instantNodes.js';
import { registerSchemaLiteGraphNode } from './schemaLiteGraphNodes.js';

export type NodeKind = 'react' | 'schema' | 'native' | 'llm';

/** Which execution backend a node maps to (drives runNodeOrStage routing). */
export type BackendKind = 'comfy' | 'provider';

/** Provider capability a node requires (llm nodes filter by provider caps). */
export type ProviderCaps = 'imageGen';

export interface PortSpec {
	name: string;
	type: PortType;
	/** true = required input / primary output */
	required?: boolean;
}

export interface NodeSpec {
	/** LiteGraph node type, e.g. "Sarosis.Prompt" / "ComfyTV.ImageStage" / "KSampler" */
	type: string;
	kind: NodeKind;
	title: string;
	/** data-category used by the palette grouping */
	category: string;
	inputs: PortSpec[];
	outputs: PortSpec[];
	/** native nodes: widget definitions from /object_info */
	widgets?: Array<{ name: string; type: string; default?: unknown; options?: string[]; min?: number; max?: number; step?: number }>;
	/** schema nodes: ComfyTV stage metadata (kind, workflow_kind, …) */
	comfyTV?: { stageKind?: string; workflowKind?: string };
	/** llm nodes: which execution backend runs this node (defaults to 'comfy') */
	backendKind?: BackendKind;
	/** llm nodes: provider capability required (nodes filtered by provider caps) */
	providerCaps?: ProviderCaps;
	/** default color used by palette + canvas header */
	color?: string;
}

export interface RegisteredNode {
	spec: NodeSpec;
	/** factory invoked by the canvas when a node of this type is created */
	create: () => unknown;
}

const registry = new Map<string, RegisteredNode>();
const kinds = new Map<NodeKind, NodeSpec[]>();

// ── change notifications (NodePalette subscribes so ComfyTV/native groups
//    appear as soon as stages load from a runner) ──────────────────────────
let version = 0;
const listeners = new Set<() => void>();

/** Subscribe to registry changes. Returns an unsubscribe function. */
export function subscribeNodeRegistry(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Monotonic change counter — cheap snapshot for useSyncExternalStore. */
export function getNodeRegistryVersion(): number {
	return version;
}

function bump(): void {
	version++;
	for (const l of listeners) { l(); }
}

/** Register a node spec. Returns false when the type already existed (still overwrites). */
export function registerNodeSpec(spec: NodeSpec): boolean {
	const isDuplicate = registry.has(spec.type);
	registry.set(spec.type, {
		spec,
		create: () => ({}),
	});
	// ComfyTV schema stages also get a real LiteGraph class (suppresses the
	// canvas title bar so the overlay card owns the whole node header).
	if (spec.kind === 'schema') {
		registerSchemaLiteGraphNode(spec);
	}
	if (!kinds.has(spec.kind)) {
		kinds.set(spec.kind, []);
	}
	// avoid pushing the same type twice into the kind bucket
	const bucket = kinds.get(spec.kind)!;
	if (!bucket.some(s => s.type === spec.type)) {
		bucket.push(spec);
	}
	// Always notify: even an overwrite (e.g. a live /comfytv/stages schema
	// refining a built-in preset) can change the palette label/ports, so the
	// NodePalette must re-render. The kind bucket is deduped above.
	bump();
	return !isDuplicate;
}

export function unregisterNodeSpec(type: string): boolean {
	const had = registry.delete(type);
	// prune kind buckets
	for (const bucket of kinds.values()) {
		const i = bucket.findIndex(s => s.type === type);
		if (i >= 0) { bucket.splice(i, 1); }
	}
	if (had) { bump(); }
	return had;
}

/** A user-configurable option exposed by a ComfyTV stage (from /comfytv/caps). */
export interface StageOption {
	/** option key without the "option:" prefix (e.g. "seed", "batch_size") */
	key: string;
	label: string;
	kind: 'number' | 'textarea' | 'text' | 'select';
	defaultValue?: unknown;
	options?: string[];
}

/** Form fields per ComfyTV stage kind, loaded from /comfytv/caps. */
const stageOptionsByKind = new Map<string, StageOption[]>();

/** Register stage options for a kind (overwrites). Bumps registry version. */
export function setStageOptions(kind: string, options: StageOption[]): void {
	stageOptionsByKind.set(kind, options);
	bump();
}

/** Stage options for a kind (undefined when caps were never loaded). */
export function getStageOptions(kind: string | undefined): StageOption[] | undefined {
	return kind ? stageOptionsByKind.get(kind) : undefined;
}

const OPTION_NUMBER_KEYS = new Set([
	'seed', 'batch_size', 'duration_s', 'fps', 'frames', 'max_length', 'count',
	'speed', 'max_tokens', 'temperature', 'bpm', 'timesignature', 'pad_left',
	'guidance', 'voice', 'reference_voice',
]);
const OPTION_LONG_TEXT_KEYS = new Set(['negative', 'lyrics', 'reference_text']);
const OPTION_BOOL_KEYS = new Set(['generate_audio']);

/**
 * Convert ComfyTV caps `option_keys` + `option_labels` into editor form fields.
 * Pure — unit/e2e testable without a runner.
 */
export function buildStageOptionsFromCaps(
	optionKeys: string[],
	optionLabels: Record<string, string> = {},
): StageOption[] {
	const out: StageOption[] = [];
	for (const key of optionKeys) {
		const bare = key.replace(/^option:/, '');
		const label = optionLabels[key] ?? bare;
		if (OPTION_NUMBER_KEYS.has(bare)) {
			out.push({ key: bare, label, kind: 'number', defaultValue: 0 });
		} else if (OPTION_BOOL_KEYS.has(bare)) {
			out.push({ key: bare, label, kind: 'select', options: ['yes', 'no'], defaultValue: 'no' });
		} else if (OPTION_LONG_TEXT_KEYS.has(bare)) {
			out.push({ key: bare, label, kind: 'textarea', defaultValue: '' });
		} else {
			out.push({ key: bare, label, kind: 'text', defaultValue: '' });
		}
	}
	return out;
}

export function getNodeSpec(type: string): NodeSpec | undefined {
	return registry.get(type)?.spec;
}

export function getSpecsByKind(kind: NodeKind): NodeSpec[] {
	return kinds.get(kind) ?? [];
}

export function getAllSpecs(): NodeSpec[] {
	return [...registry.values()].map(r => r.spec);
}

/** Validate that a spec has sane inputs/outputs (no duplicate port names). */
export function validateNodeSpec(spec: NodeSpec): string[] {
	const issues: string[] = [];
	if (!spec.type || !spec.type.includes('.')) {
		issues.push(`type "${spec.type}" should be namespaced (e.g. "Sarosis.Prompt")`);
	}
	const names = new Set<string>();
	for (const p of [...spec.inputs, ...spec.outputs]) {
		if (!names.has(p.name)) {
			names.add(p.name);
		} else {
			issues.push(`duplicate port name "${p.name}" on ${spec.type}`);
		}
	}
	return issues;
}

/** Link-type compatibility matrix (mirrors LiteGraph isValidConnection + ComfyTV).
 *  Identical types connect. 'ANY' connects to anything. Everything else is strict.
 */
export function isPortTypeCompatible(a: PortType, b: PortType): boolean {
	if (a === b) { return true; }
	if (a === 'ANY' || b === 'ANY') { return true; }
	return false;
}

/**
 * Bridge for LiteGraph's `LiteGraph.isValidConnection(type_a, type_b)`.
 * Accepts ISlotType (number | string). SlotType enum values are numeric; treat
 * them as ANY unless they stringify to a known port type.
 */
export function isValidLiteGraphConnection(typeA: number | string, typeB: number | string): boolean {
	const a = slotToPortType(typeA);
	const b = slotToPortType(typeB);
	return isPortTypeCompatible(a, b);
}

function slotToPortType(t: number | string): PortType {
	if (typeof t === 'number') { return 'ANY'; } // numeric SlotType enum → treat as ANY
	return normalizePortType(t);
}

/** A palette item entry (mirrors store's NodeTypeSelector shape). */
export interface PaletteItem {
	type: string;
	label: string;
	description: string;
	icon: string;
}

/**
 * Build palette items for schema (ComfyTV) + native (ComfyUI) + llm (Provider)
 * node kinds. Pure — lets the editor palette stay static while Comfy nodes populate dynamically.
 */
export function buildComfyPaletteItems(kind: 'schema' | 'native' | 'llm'): PaletteItem[] {
	return getSpecsByKind(kind).map(spec => ({
		type: spec.type,
		label: spec.title ?? spec.type,
		description: spec.kind === 'native'
			? `ComfyUI 原生节点 · ${spec.inputs.length} 输入 / ${spec.outputs.length} 输出`
			: spec.kind === 'llm'
				? `Provider 文生图 · ${spec.backendKind ?? 'provider'} 后端`
				: `ComfyTV stage · ${spec.comfyTV?.stageKind ?? '?'}`,
		icon: spec.kind === 'native' ? '🧩' : spec.kind === 'llm' ? '🖼️' : '🎨',
	}));
}

/** Standard palette categories used by the editor. */
export const PALETTE_GROUPS = [
	{ id: 'system', label: '系统', kinds: ['react'] as NodeKind[] },
	{ id: 'sarosis', label: 'Sarosis 节点', kinds: ['react'] as NodeKind[] },
	{ id: 'comfyTV', label: 'ComfyTV 节点', kinds: ['schema'] as NodeKind[] },
	{ id: 'comfyUI', label: 'ComfyUI 原生', kinds: ['native'] as NodeKind[] },
];

/**
 * Register all existing Sarosis node types.
 * This is the single migration point: ReactFlow's nodeTypes map is replaced by this.
 */
export function registerSarosisNodes(): void {
	const json = (required: boolean = true): PortSpec => ({ name: 'value', type: 'SAROSIS_JSON', required });
	registerNodeSpec({ type: 'Sarosis.Start', kind: 'react', title: '开始', category: 'system', inputs: [], outputs: [json(false)], color: '#22c55e' });
	registerNodeSpec({ type: 'Sarosis.End', kind: 'react', title: '结束', category: 'system', inputs: [json(true)], outputs: [], color: '#ef4444' });
	registerNodeSpec({ type: 'Sarosis.Task', kind: 'react', title: '任务', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#3b82f6' });
	registerNodeSpec({ type: 'Sarosis.Prompt', kind: 'react', title: '提示', category: 'basic', inputs: [json()], outputs: [{ name: 'output', type: 'TEXT' }], color: '#8b5cf6' });
	registerNodeSpec({ type: 'Sarosis.Agent', kind: 'react', title: 'Agent', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#f97316' });
	registerNodeSpec({ type: 'Sarosis.Skill', kind: 'react', title: 'Skill', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#eab308' });
	registerNodeSpec({ type: 'Sarosis.Tool', kind: 'react', title: 'Tool', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#10b981' });
	// Provider 选择器：本地解析（无 RPC），输出 TEXT "provider:<providerId>:<modelId>"
	// 供 ModelImageGen 消费。kind='react' → runNodeOrStage 走 runProviderPickerNode。
	registerNodeSpec({
		type: 'Sarosis.ProviderPicker',
		kind: 'react',
		title: 'Provider 选择',
		category: 'basic',
		inputs: [],
		outputs: [{ name: 'config', type: 'TEXT' }],
		widgets: [
			{ name: 'providerId', type: 'STRING', default: '' },
			{ name: 'modelId', type: 'STRING', default: '' },
		],
		color: '#8b5cf6',
	});
	// Provider + Model 图像生成节点：经 imagegen.generate RPC 走已认证 LLM
	// provider 的 /images/generations 端点（OpenAI 兼容）。纯 provider 后端，
	// 不依赖 ComfyUI runner；输出 IMAGE 快照可与 Comfy 节点接力（P1+）。
	registerNodeSpec({
		type: 'Sarosis.ModelImageGen',
		kind: 'llm',
		title: '模型文生图',
		category: 'sarosis',
		inputs: [{ name: 'prompt', type: 'TEXT' }],
		outputs: [{ name: 'image', type: 'IMAGE' }],
		widgets: [
			{ name: 'providerId', type: 'STRING', default: '' },
			{ name: 'modelId', type: 'STRING', default: '' },
			{ name: 'prompt', type: 'TEXT', default: '' },
			{ name: 'negativePrompt', type: 'TEXT', default: '' },
			{ name: 'size', type: 'STRING', default: '1024x1024' },
			{ name: 'numImages', type: 'INT', default: 1, min: 1, max: 4 },
		],
		backendKind: 'provider',
		providerCaps: 'imageGen',
		color: '#06b6d4',
	});
	registerNodeSpec({ type: 'Sarosis.IfElse', kind: 'react', title: 'If/Else', category: 'controlFlow', inputs: [json()], outputs: [{ name: 'true', type: 'SAROSIS_JSON' }, { name: 'false', type: 'SAROSIS_JSON' }], color: '#ef4444' });
	registerNodeSpec({ type: 'Sarosis.Switch', kind: 'react', title: 'Switch', category: 'controlFlow', inputs: [json()], outputs: [{ name: 'case', type: 'SAROSIS_JSON' }], color: '#a855f7' });
	registerNodeSpec({ type: 'Sarosis.AskUser', kind: 'react', title: '询问', category: 'controlFlow', inputs: [json()], outputs: [{ name: 'answer', type: 'SAROSIS_JSON' }], color: '#06b6d4' });
	registerNodeSpec({ type: 'Sarosis.Group', kind: 'react', title: '分组', category: 'layout', inputs: [], outputs: [], color: '#888780' });
}

/**
 * Register a ComfyTV stage from its extension schema.
 * Only the schema is stored; the card is rendered by React (schema→React), no Vue runtime.
 */
export function registerComfyTVNode(schema: {
	type: string;
	kind?: string;
	workflowKind?: string;
	inputs?: Array<{ name: string; type?: string; required?: boolean }>;
	outputs?: Array<{ name: string; type?: string }>;
	title?: string;
	widgets?: NodeSpec['widgets'];
}): boolean {
	const toPort = (p: { name: string; type?: string; required?: boolean }): PortSpec => ({
		name: p.name,
		type: normalizePortType(p.type),
		required: p.required,
	});
	const spec: NodeSpec = {
		type: schema.type,
		kind: 'schema',
		title: schema.title ?? schema.type,
		category: 'comfyTV',
		inputs: (schema.inputs ?? []).map(toPort),
		outputs: (schema.outputs ?? []).map(toPort),
		widgets: schema.widgets,
		color: '#e879f9',
		comfyTV: { stageKind: schema.kind, workflowKind: schema.workflowKind },
	};
	return registerNodeSpec(spec);
}

/**
 * Register a ComfyUI native node from /object_info entry.
 * Widget definitions are derived from `input.required`.
 */
export function registerComfyUINativeNode(def: {
	class_name: string;
	display_name?: string;
	category?: string;
	input?: { required?: Record<string, [string, Record<string, unknown>?]>; optional?: Record<string, [string, Record<string, unknown>?]> };
	output?: string[];
	output_name?: string[];
}): boolean {
	const inputs: PortSpec[] = [];
	for (const key of Object.keys(def.input?.required ?? {})) {
		inputs.push({ name: key, type: 'ANY' });
	}
	const outputs: PortSpec[] = (def.output ?? []).map((o, i) => ({
		name: def.output_name?.[i] ?? o,
		type: normalizeNativeType(o),
	}));
	const widgets = Object.entries(def.input?.required ?? {}).map(([name, [type, opts]]) => ({
		name,
		type,
		default: opts?.default,
		options: type === 'COMBO' ? (opts?.values as string[] | undefined) : undefined,
	}));
	return registerNodeSpec({
		type: def.class_name,
		kind: 'native',
		title: def.display_name ?? def.class_name,
		category: def.category ?? 'comfyUI',
		inputs,
		outputs,
		widgets,
		color: '#f59e0b',
	});
}

/**
 * Register the built-in ComfyTV stage presets.
 * These guarantee the ComfyTV palette group is never empty — the user can add a
 * stage node even before a runner is connected. A live runner's /comfytv/stages
 * schema (registerComfyTVNode) then refines them (duplicate type overwrites,
 * so real stage details win).
 */
export function registerDefaultComfyTVStages(): void {
	// Built-in default widgets so a stage is usable before a runner is connected.
	// A live runner's /comfytv/stages schema (registerComfyTVNode) overwrites these.
	// Order matches ComfyTV's upstream layout: workflow / resolution /
	// aspect_ratio / batch_size come first, the prompt textarea sits below.
	// The built-in seed/width/height/steps are basic fallbacks for when no
	// runner is connected — a live /comfytv/stages schema (registerComfyTVNode)
	// replaces these with the real ComfyTV widget set.
	const imageWidgets = [
		{ name: 'workflow', type: 'COMBO', default: '', options: [] },
		{ name: 'seed', type: 'INT', default: -1 },
		{ name: 'width', type: 'INT', default: 512 },
		{ name: 'height', type: 'INT', default: 512 },
		{ name: 'steps', type: 'INT', default: 20 },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const stage = (type: string, title: string, stageKind: string, workflowKind: string,
		widgets?: NodeSpec['widgets'],
		extraInputs: { name: string; type: string }[] = [],
		extraOutputs: { name: string; type: string }[] = []): void => {
		registerNodeSpec({
			type,
			kind: 'schema',
			title,
			category: 'comfyTV',
			// ComfyTV-style: each stage exposes the autogrow lists it consumes
			// (texts/images/videos/...) plus its own output channels. The
			// single 'input'/'output' generic port is replaced by typed pins so
			// users see `texts`, `images`, etc. on the canvas — matching the
			// upstream ComfyTV reference layout (which exposes exactly the
			// autogrow lists as connectable pins; everything else is socketless).
			inputs: extraInputs.length > 0
				? extraInputs
				: [{ name: 'input', type: 'ANY' }],
			outputs: extraOutputs.length > 0
				? extraOutputs
				: [{ name: 'output', type: normalizePortType(stageKind) }],
			widgets,
			color: '#e879f9',
			comfyTV: { stageKind, workflowKind },
		});
	};
	stage('ComfyTV.ImageStage', 'Image Stage', 'image', 'image-to-image', imageWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }],
		[{ name: 'images', type: 'COMFYTV_IMAGES' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	stage('ComfyTV.VideoStage', '文生视频', 'video', 'video');
	stage('ComfyTV.AudioStage', '文生音频', 'audio', 'audio');
	stage('ComfyTV.TextStage', '文生文本', 'text', 'text');
	stage('ComfyTV.ImageBatchStage', '文生图批', 'image-batch', 'image-to-image');
	// P2 — no-Run pickers: choose one candidate upstream snapshot → emit it.
	stage('ComfyTV.ImagePickerStage', '图像选择器', 'image', 'image-to-image');
	stage('ComfyTV.VideoPickerStage', '视频选择器', 'video', 'video');
	stage('ComfyTV.AudioPickerStage', '音频选择器', 'audio', 'audio');
	// P2 — no-Run loaders: pick a local file (uploaded in the node popup) → snapshot.
	stage('ComfyTV.ImageLoaderStage', '加载图像', 'image', 'image');
	stage('ComfyTV.VideoLoaderStage', '加载视频', 'video', 'video');
	stage('ComfyTV.AudioLoaderStage', '加载音频', 'audio', 'audio');
	stage('ComfyTV.TextLoaderStage', '加载文本', 'text', 'text');
	// P4 — ComfyTV ↔ native bridge nodes (single-node prompts; full tensor
	// wiring lands with native-graph execution).
	const bridge = (type: string, title: string, inType: string, outType: string): void => {
		registerNodeSpec({
			type,
			kind: 'native',
			title,
			category: 'comfyBridge',
			inputs: [{ name: 'input', type: inType as PortType }],
			outputs: [{ name: 'output', type: outType as PortType }],
			color: '#5eead4',
		});
	};
	bridge('ComfyTV.BridgeToImage', 'Bridge → 图像快照', 'IMAGE', 'IMAGE');
	bridge('ComfyTV.BridgeToImages', 'Bridge → 图像批量', 'IMAGE', 'IMAGE');
	bridge('ComfyTV.BridgeToVideo', 'Bridge → 视频快照', 'VIDEO', 'VIDEO');
	bridge('ComfyTV.BridgeToAudio', 'Bridge → 音频快照', 'AUDIO', 'AUDIO');
	bridge('ComfyTV.BridgeToText', 'Bridge → 文本快照', 'TEXT', 'TEXT');
	bridge('ComfyTV.BridgeFromImage', 'Bridge ← 图像快照', 'IMAGE', 'IMAGE');
	bridge('ComfyTV.BridgeFromMask', 'Bridge ← 蒙版快照', 'IMAGE', 'IMAGE');
	bridge('ComfyTV.BridgeFromVideo', 'Bridge ← 视频快照', 'VIDEO', 'VIDEO');
	bridge('ComfyTV.BridgeFromAudio', 'Bridge ← 音频快照', 'AUDIO', 'AUDIO');
	bridge('ComfyTV.BridgeFromText', 'Bridge ← 文本快照', 'TEXT', 'TEXT');
	// P2 — instant browser-local stages (Crop/Rotate/Mirror, processed on canvas).
	const instant = (type: string, title: string): void => {
		registerNodeSpec({
			type,
			kind: 'native',
			title,
			category: 'comfyInstant',
			inputs: [{ name: 'input', type: 'IMAGE' }],
			outputs: [{ name: 'output', type: 'IMAGE' }],
			widgets: INSTANT_WIDGETS[type],
		});
	};
	instant('ComfyTV.CropStage', '裁剪');
	instant('ComfyTV.RotateStage', '旋转');
	instant('ComfyTV.MirrorStage', '镜像');
	// P3 — Relight embedded light-ball editor (browser-local, two outputs).
	registerNodeSpec({
		type: 'ComfyTV.RelightStage',
		kind: 'native',
		title: '打光',
		category: 'comfyRelight',
		inputs: [],
		outputs: [
			{ name: 'light_render', type: 'IMAGE' },
			{ name: 'light_prompt', type: 'TEXT' },
		],
		widgets: [
			{ name: 'main_prompt', type: 'STRING', default: 'soft studio lighting, gentle shadows' },
		],
	});
	// P3 — Poster embedded layout editor (browser-local, template + layout blob).
	registerNodeSpec({
		type: 'ComfyTV.PosterStage',
		kind: 'native',
		title: '海报',
		category: 'comfyPoster',
		inputs: [{ name: 'images', type: 'IMAGE' }],
		outputs: [{ name: 'image', type: 'IMAGE' }],
		widgets: [
			{ name: 'template', type: 'COMBO', options: ['hero'], default: 'hero' },
		],
	});
	// P3 — Layer Editor artboard (browser-local compositing + upload).
	registerNodeSpec({
		type: 'ComfyTV.LayerEditorStage',
		kind: 'native',
		title: '图层画板',
		category: 'comfyLayer',
		inputs: [],
		outputs: [{ name: 'image', type: 'IMAGE' }],
		widgets: [
			{ name: 'width', type: 'INT', default: 1024 },
			{ name: 'height', type: 'INT', default: 1024 },
		],
	});
	// P3 — Storyboard Editor (reuses the Layer Editor artboard per board).
	registerNodeSpec({
		type: 'ComfyTV.StoryboardEditorStage',
		kind: 'native',
		title: '分镜画板',
		category: 'comfyStoryboard',
		inputs: [],
		outputs: [{ name: 'image', type: 'IMAGE' }],
		widgets: [
			{ name: 'width', type: 'INT', default: 1280 },
			{ name: 'height', type: 'INT', default: 720 },
		],
	});
	// P3 — Material PBR ball editor (browser-local, dual output).
	registerNodeSpec({
		type: 'ComfyTV.MaterialStage',
		kind: 'native',
		title: '材质',
		category: 'comfyMaterial',
		inputs: [],
		outputs: [
			{ name: 'material', type: 'TEXT' },
			{ name: 'image', type: 'IMAGE' },
		],
		widgets: [],
	});
	// P3 — 3D Scene (2.5D isometric MVP, browser-local capture).
	registerNodeSpec({
		type: 'ComfyTV.Scene3DStage',
		kind: 'native',
		title: '3D 摆场',
		category: 'comfyScene3D',
		inputs: [],
		outputs: [{ name: 'image', type: 'IMAGE' }],
		widgets: [
			{ name: 'width', type: 'INT', default: 1024 },
			{ name: 'height', type: 'INT', default: 1024 },
		],
	});
}

export function normalizePortType(t?: string): PortType {
	switch (t) {
		case 'IMAGE': case 'image': return 'IMAGE';
		case 'VIDEO': case 'video': return 'VIDEO';
		case 'AUDIO': case 'audio': return 'AUDIO';
		case 'TEXT': case 'text': return 'TEXT';
		case 'SAROSIS_JSON': case 'json': return 'SAROSIS_JSON';
		default: return 'ANY';
	}
}

function normalizeNativeType(t: string): PortType {
	const lower = t.toLowerCase();
	if (lower.includes('image')) { return 'IMAGE'; }
	if (lower.includes('video')) { return 'VIDEO'; }
	if (lower.includes('audio')) { return 'AUDIO'; }
	if (lower.includes('string') || lower.includes('text')) { return 'TEXT'; }
	return 'ANY';
}
