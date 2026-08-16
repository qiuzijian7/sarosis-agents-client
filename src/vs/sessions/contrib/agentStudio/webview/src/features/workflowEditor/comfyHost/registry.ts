/*---------------------------------------------------------------------------------------------
 *  LiteGraph Node Registry — three-tier node registration.
 *
 *  Keeps all LiteGraph interaction behind a small facade so tests can run without
 *  touching the real @comfyorg/litegraph singleton, and so the webview never calls
 *  `LiteGraph.registerNodeType` directly.
 *
 *  Node kinds:
 *   - 'react'  : existing Saros.* nodes, cards rendered as React components
 *                (React is preserved; no Vue bridge).
 *   - 'schema' : ComfyTV-style stages. Only the registration info (kind/inputs/outputs)
 *                is consumed; the card is rendered by a React component driven by that schema.
 *   - 'native' : ComfyUI native nodes, dynamically registered from /object_info.
 *
 *  Port type vocabulary (mirrors LiteGraph link `type`):
 *   'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'SAROS_JSON' | 'ANY'
 *--------------------------------------------------------------------------------------------*/

export type PortType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'SAROS_JSON' | 'ANY' | string;
import { INSTANT_WIDGETS } from './instantNodes.js';
import { registerSchemaLiteGraphNode } from './schemaLiteGraphNodes.js';
import { COMFYTV_STAGE_META } from './comfyTVStageMeta.generated.js';
import { listBuiltinLabels } from './builtinWorkflows/index.js';

export type NodeKind = 'react' | 'schema' | 'native' | 'llm';

/** Which execution backend a node maps to (drives runNodeOrStage routing). */
export type BackendKind = 'comfy' | 'provider';

/** Provider capability a node requires (llm nodes filter by provider caps). */
export type ProviderCaps = 'imageGen';

/**
 * ComfyTV stage variant（对齐 ComfyTV `stores/stageStore.ts` 的 StageVariant）。
 * 这是 ComfyTV 框架里驱动卡片形态的**核心声明**，替代按节点类型硬编码：
 *   - 'generator' : 走后端 workflow 生成 → 有运行按钮 / prompt / server select
 *   - 'loader'    : 拖拽或选择载入素材 → 无运行按钮（内容即输出）
 *   - 'transform' : 浏览器本地即时变换（Crop/Rotate/Mirror/ColorGrade/…）
 *                   → 无运行按钮，改参数即自动重算（见 useTransformPipeline）
 * 真源为 ComfyTV `nodes/stages/common/meta.py` 的 STAGE_META，经
 * `comfyTVStageMeta.generated.ts` 编译期内联到本项目。
 */
export type StageVariant = 'generator' | 'loader' | 'transform';

/** 把生成的 meta.variant 字符串（可能为空）归一成 StageVariant。纯函数。 */
export function normalizeStageVariant(raw: string | undefined): StageVariant {
	return raw === 'transform' || raw === 'loader' ? raw : 'generator';
}

/**
 * ComfyTV ImageStage 的控件常量（对齐 src/nodes/stages/generators.py 上游定义）。
 * 这些参数在 ComfyTV 里是 LiteGraph canvas-drawn widgets（io.Combo.Input /
 * io.Int.Input），本实现用 React 卡片等价渲染，字段名/默认值/可选值保持一致。
 */
export const COMFYTV_RESOLUTIONS = ['480P', '720P', '1K', '1080P', '1440P', '2K', '2160P', '4K'];
export const COMFYTV_ASPECT_RATIOS = ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '4:5', '5:4', '21:9'];
/** 兜底 workflow 列表（当某 kind 无内置模板时）。真实列表来自 builtinWorkflows（静态内置，非 /comfytv/workflows）。 */
export const COMFYTV_IMAGE_WORKFLOWS = ['Local SD1.5'];

/**
 * 某 kind 的 workflow 下拉 options（完全不依赖 ComfyTV 后端 API）。
 * 直接读内置静态模板（builtinWorkflows/）的 label 列表；无内置模板时回退兜底。
 */
function workflowOptionsFor(kind: string): string[] {
	const labels = listBuiltinLabels(kind);
	return labels.length > 0 ? labels : COMFYTV_IMAGE_WORKFLOWS;
}

export interface PortSpec {
	name: string;
	type: PortType;
	/** true = required input / primary output */
	required?: boolean;
}

export interface NodeSpec {
	/** LiteGraph node type, e.g. "Saros.Prompt" / "ComfyTV.ImageStage" / "KSampler" */
	type: string;
	kind: NodeKind;
	title: string;
	/** data-category used by the palette grouping */
	category: string;
	inputs: PortSpec[];
	outputs: PortSpec[];
	/** native nodes: widget definitions from /object_info */
	widgets?: Array<{ name: string; type: string; default?: unknown; options?: Array<string | { label: string; value: string; group?: string }>; min?: number; max?: number; step?: number }>;
	/** schema nodes: ComfyTV stage metadata (kind, workflow_kind, …) */
	comfyTV?: { stageKind?: string; workflowKind?: string; variant?: StageVariant };
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

/**
 * `nodeId → { variant, kind }` 查表（由 generated STAGE_META 建立，惰性构建）。
 *
 * 为什么需要：ComfyTV.* 节点有**两条**注册路径 —— schema 批量注册（走
 * COMFYTV_STAGE_META 循环）与手写 `kind:'native'` 注册（instant/loader/relight/
 * material/panorama…）。后者不会带 comfyTV 元数据，若只在 schema 分支透传，
 * Crop/Rotate/Mirror 这些 native 节点会静默丢失：
 *   - `variant` → 回退 'generator' → 运行按钮照旧显示（第 93 轮 P1 的漏洞）
 *   - `stageKind` → `ACTIONS_BY_KIND['']` 查不到 → **ACTIONS 区块完全不出现**
 *     （ComfyTV 参考 UI 里 Rotate/Mirror 都有 `> ACTIONS 6`）
 * 在 registerNodeSpec 这个**唯一入口**统一补全，两条路径都能覆盖。
 */
let metaLookup: Map<string, { variant: StageVariant; kind?: string; workflowKind?: string }> | undefined;
function comfyTVMetaFor(type: string): { variant: StageVariant; kind?: string; workflowKind?: string } | undefined {
	if (!metaLookup) {
		metaLookup = new Map();
		for (const m of COMFYTV_STAGE_META) {
			metaLookup.set(m.nodeId, {
				variant: normalizeStageVariant(m.variant),
				kind: m.kind,
				workflowKind: m.workflowKind ?? m.kind,
			});
		}
	}
	return metaLookup.get(type);
}

/** Register a node spec. Returns false when the type already existed (still overwrites). */
export function registerNodeSpec(spec: NodeSpec): boolean {
	const isDuplicate = registry.has(spec.type);
	// ComfyTV 元数据补全：显式声明优先，缺失的字段从 STAGE_META 查表补齐
	// （真源为 ComfyTV nodes/stages/common/meta.py）。
	// 只对 ComfyTV.* 生效，Saros.* / 原生 ComfyUI 节点不受影响。
	if (spec.type.startsWith('ComfyTV.')) {
		const m = comfyTVMetaFor(spec.type);
		if (m && (!spec.comfyTV?.variant || !spec.comfyTV?.stageKind)) {
			spec = {
				...spec,
				comfyTV: {
					stageKind: spec.comfyTV?.stageKind ?? m.kind,
					workflowKind: spec.comfyTV?.workflowKind ?? m.workflowKind,
					variant: spec.comfyTV?.variant ?? m.variant,
				},
			};
		}
	}
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
	// Always notify: an overwrite (e.g. a refineStage call overriding a built-in
	// preset) can change the palette label/ports, so the NodePalette must
	// re-render. The kind bucket is deduped above.
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

export function getNodeSpec(type: string): NodeSpec | undefined {
	return registry.get(type)?.spec;
}

/** LiteGraph 节点上被本函数读写的最小形状（避免把 LGraphNode 类型拖进注册表）。 */
interface PortBearingNode {
	type?: string;
	inputs?: Array<{ name?: string; type?: unknown; label?: string }>;
	outputs?: Array<{ name?: string; type?: unknown; label?: string }>;
}

/**
 * 把节点实例的**端口名/类型**就地同步成注册表 spec 的定义。
 *
 * 为什么需要：LiteGraph 的 `inputs[].name/type` 是**随 graph.serialize() 持久化
 * 的实例数据**，只在节点 `constructor` 里按 spec 建一次。因此改了 spec 之后：
 *   - 新建节点 → 生效（走 constructor）；
 *   - 已存在于画布 / 已存盘的老节点 → **永远停留在旧端口名**
 *     （截图里 Rotate 仍显示 `input`/`output` 而不是 `Image`/`Image`）。
 * 这个函数在画布同步循环里按帧兜底纠正，无论节点由哪条注册路径创建。
 *
 * 只改**名字与类型**（展示与连线语义），不增删槽位 —— LiteGraph 的连线按
 * **槽位下标**寻址，改名不会断线；增删才会。槽位数量不一致时直接放弃（说明
 * 该节点的形状由运行时 object_info 精化过，spec 不再是权威）。
 *
 * @returns 是否发生了修改（调用方据此决定要不要重绘）。
 */
export function syncNodePortsToSpec(node: PortBearingNode): boolean {
	const spec = node.type ? getNodeSpec(node.type) : undefined;
	if (!spec) { return false; }
	let changed = false;
	const sync = (
		live: Array<{ name?: string; type?: unknown; label?: string }> | undefined,
		want: ReadonlyArray<{ name: string; type: string }> | undefined,
	): void => {
		if (!live || !want || live.length !== want.length) { return; }
		for (let i = 0; i < live.length; i++) {
			const slot = live[i];
			const def = want[i];
			if (slot.name !== def.name) { slot.name = def.name; changed = true; }
			// label 是 LiteGraph 实际绘制的文字（addInput 时传的 { label }）。
			// 只改 name 不改 label，画布上仍然显示旧名字。
			if (slot.label !== undefined && slot.label !== def.name) { slot.label = def.name; changed = true; }
			if (typeof slot.type === 'string' && slot.type !== def.type) { slot.type = def.type; changed = true; }
		}
	};
	sync(node.inputs, spec.inputs);
	sync(node.outputs, spec.outputs);
	return changed;
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
		issues.push(`type "${spec.type}" should be namespaced (e.g. "Saros.Prompt")`);
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

/** Three-layer model for cross-layer connection gating (see doc/workflow-pipeline-fusion-design.md).
 *  - orchestration: react + llm (AgentLoop / provider backends)
 *  - bridge: schema (ComfyTV stage — the "sub-workflow container")
 *  - media: native (ComfyUI primitive nodes)
 */
export type NodeLayer = 'orchestration' | 'bridge' | 'media';

/** Map a node kind to its architectural layer. Pure. */
export function nodeLayer(kind: NodeKind): NodeLayer {
	switch (kind) {
		case 'react':
		case 'llm':
			return 'orchestration';
		case 'schema':
			return 'bridge';
		case 'native':
			return 'media';
	}
}

/**
 * Cross-layer connection gate. Orchestration nodes must NOT connect directly
 * to media nodes (and vice-versa) — they must go through a bridge (schema /
 * ComfyTV stage). Everything else is allowed, including intra-layer links.
 * Pure, unit-testable without LiteGraph.
 */
export function canConnectLayers(srcKind: NodeKind, dstKind: NodeKind): boolean {
	const s = nodeLayer(srcKind);
	const d = nodeLayer(dstKind);
	if ((s === 'orchestration' && d === 'media') || (s === 'media' && d === 'orchestration')) {
		return false;
	}
	return true;
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
	{ id: 'saros', label: 'Saros 节点', kinds: ['react'] as NodeKind[] },
	{ id: 'comfyTV', label: 'ComfyTV 节点', kinds: ['schema'] as NodeKind[] },
	{ id: 'comfyUI', label: 'ComfyUI 原生', kinds: ['native'] as NodeKind[] },
];

/**
 * Register all existing Saros node types.
 * This is the single migration point: ReactFlow's nodeTypes map is replaced by this.
 */
export function registerSarosNodes(): void {
	const json = (required: boolean = true): PortSpec => ({ name: 'value', type: 'SAROS_JSON', required });
	registerNodeSpec({ type: 'Saros.Start', kind: 'react', title: '开始', category: 'system', inputs: [], outputs: [json(false)], color: '#22c55e' });
	registerNodeSpec({ type: 'Saros.End', kind: 'react', title: '结束', category: 'system', inputs: [json(true)], outputs: [], color: '#ef4444' });
	registerNodeSpec({ type: 'Saros.Task', kind: 'react', title: '任务', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#3b82f6' });
	registerNodeSpec({ type: 'Saros.Prompt', kind: 'react', title: '提示', category: 'basic', inputs: [json()], outputs: [{ name: 'output', type: 'TEXT' }], color: '#8b5cf6' });
	registerNodeSpec({ type: 'Saros.Agent', kind: 'react', title: 'Agent', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#f97316' });
	registerNodeSpec({ type: 'Saros.Skill', kind: 'react', title: 'Skill', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#eab308' });
	registerNodeSpec({ type: 'Saros.Tool', kind: 'react', title: 'Tool', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#10b981' });
	// Subflow（子流程）：编排层容器，data.subflow 承载内部图。展开（flattenSubflows）
	// 在执行/导出前还原。静态 SAROS_JSON 端口作为编排容器主链路；内部图的
	// entry/exit 端口在执行期由 substituteSubflow 重映射。
	registerNodeSpec({ type: 'Saros.Subflow', kind: 'react', title: '子流程', category: 'basic', inputs: [json()], outputs: [json(false)], color: '#64748b' });
	// Provider 选择器：本地解析（无 RPC），输出 TEXT "provider:<providerId>:<modelId>"
	// 供 ModelImageGen 消费。kind='react' → runNodeOrStage 走 runProviderPickerNode。
	registerNodeSpec({
		type: 'Saros.ProviderPicker',
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
	//
	// UI 与 ComfyTV.ImageStage 对齐（2026-08-12 重构）：schema 风格卡片、
	// 同款端口（texts/images 入、images/image 出）、同款参数面板——仅把
	// Image Stage 的 `workflow` 换成 provider 后端的 `model`，并新增
	// `provider` 选择。执行仍走 provider RPC（isLLMImageNode 识别 backendKind）。
	registerNodeSpec({
		type: 'Saros.ModelImageGen',
		kind: 'schema',
		title: '模型文生图',
		category: 'saros',
		inputs: [
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'images', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			// provider 选择（COMBO，nodeCard 动态填充已认证文生图 provider）
			{ name: 'provider', type: 'COMBO', default: '', options: [] },
			// model 选择（COMBO，随 provider 联动）
			{ name: 'model', type: 'COMBO', default: '', options: [] },
			{ name: 'seed', type: 'INT', default: -1 },
			{ name: 'width', type: 'INT', default: 1024 },
			{ name: 'height', type: 'INT', default: 1024 },
			{ name: 'steps', type: 'INT', default: 20 },
			{ name: 'prompt', type: 'TEXT', default: '' },
		],
		backendKind: 'provider',
		providerCaps: 'imageGen',
		color: '#06b6d4',
		comfyTV: { stageKind: 'image', workflowKind: 'image-to-image' },
	});
	registerNodeSpec({ type: 'Saros.IfElse', kind: 'react', title: 'If/Else', category: 'controlFlow', inputs: [json()], outputs: [{ name: 'true', type: 'SAROS_JSON' }, { name: 'false', type: 'SAROS_JSON' }], color: '#ef4444' });
	registerNodeSpec({ type: 'Saros.Switch', kind: 'react', title: 'Switch', category: 'controlFlow', inputs: [json()], outputs: [{ name: 'case', type: 'SAROS_JSON' }], color: '#a855f7' });
	registerNodeSpec({ type: 'Saros.AskUser', kind: 'react', title: '询问', category: 'controlFlow', inputs: [json()], outputs: [{ name: 'answer', type: 'SAROS_JSON' }], color: '#06b6d4' });
	registerNodeSpec({ type: 'Saros.Group', kind: 'react', title: '分组', category: 'layout', inputs: [], outputs: [], color: '#888780' });
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
	// /object_info 把 ComfyTV.* 自定义节点也当作「原生节点」返回（它们本质就是
	// ComfyUI custom_nodes）。`registerDefaultComfyTVStages` 已把 ComfyTV.ImageStage
	// 等注册为 kind='schema'（含 comfyTV 元数据），不能被这里无条件覆盖为 native
	// ——否则 `runNodeOrStage` 会走 native 单节点路径而非 schema 的 runStageWorkflow，
	// 卡片 specKind='native'，OUTPUT 区域拿不到 entries，图片不渲染。
	const existing = registry.get(def.class_name)?.spec;
	if (existing && existing.kind && existing.kind !== 'native') {
		// 已有更专用的注册（schema/react/llm）→ 跳过 native 覆盖。
		return false;
	}
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
 * 本项目**完全不依赖 ComfyTV 后端 API**：节点定义来自静态内置的
 * comfyTVStageMeta.generated.ts（171 个 stage，无需 /comfytv/stages）。
 * 这些预设保证 ComfyTV 调色板永远非空，用户无需连接 runner 即可添加 stage 节点。
 */
/**
 * kind → schema 节点输出端口类型（映射 ComfyTV `_KIND_TO_OUTPUT_TYPE` + schema 惯例）。
 * 媒体 kind 直出对应 COMFYTV_* 端口；编辑器/工具 kind 复用其输入媒体类型。
 */
function comfyTVKindOutputType(kind: string): string {
	switch (kind) {
		case 'image': case 'image-batch': case 'image-picker': case 'panorama': return 'COMFYTV_IMAGES';
		case 'video': case 'video-picker': return 'COMFYTV_VIDEO';
		case 'audio': case 'audio-picker': return 'COMFYTV_AUDIO';
		case 'text': return 'COMFYTV_TEXT';
		case 'model': return 'COMFYTV_MODEL';
		case 'material': return 'COMFYTV_MATERIAL';
		case 'storyboard': return 'COMFYTV_STORYBOARD';
		case 'timeline': return 'COMFYTV_TIMELINE';
		case 'project': return 'COMFYTV_JSON';
		default: return 'COMFYTV_IMAGE';
	}
}

/**
 * 全量注册 ComfyTV stage（171 个，顺序对齐 ComfyTV `get_node_list()`）。
 * 数据源 = comfyTVStageMeta.generated.ts（由 ComfyTV nodes/stages 生成）。
 *  - 每个 stage 注册为 schema 节点，category/title/kind/workflowKind 与上游一致；
 *  - 输出端口按 kind 映射（COMFYTV_IMAGES/VIDEO/AUDIO/TEXT/...）；
 *  - 可见 widgets 走通用 `workflow` COMBO（options 来自内置静态模板 builtinWorkflows/，
 *    非 /comfytv/workflows）+ 核心 generator（Image/Video/Audio/Speech/Text/Model3D）
 *    用精确 widgets 覆盖。
 */
export function registerDefaultComfyTVStages(): void {
	const genericStageWidgets = (kind: string): NodeSpec['widgets'] => {
		// 通用 stage：workflow 下拉（options 来自内置静态模板）+ 媒体输入可选。
		// 核心 generator 单独精确覆盖。
		const opts = workflowOptionsFor(kind);
		const w: NonNullable<NodeSpec['widgets']> = [
			{ name: 'workflow', type: 'COMBO', default: opts[0], options: opts },
		];
		return w;
	};
	// ImageVariationsStage：ComfyTV variations.py 把 labels_for('multiview') +
	// labels_for('sequence') 两组 workflow 合并进同一个下拉（分组预览），运行时再
	// 按选中 label 推断 kind。原通用分支用 workflowOptionsFor('image-batch') 取到空
	// 数组 → 下拉空白，这里显式合并两组并分组；同时补 variant_count（slider 1-25）
	// 与 prompt。
	const imageVariationsWidgets = (): NodeSpec['widgets'] => {
		const mv = workflowOptionsFor('multiview');
		const seq = workflowOptionsFor('sequence');
		const options: Array<string | { label: string; value: string; group: string }> = [
			...mv.map(label => ({ label, value: label, group: 'Multi-view' })),
			...seq.map(label => ({ label, value: label, group: 'Sequence' })),
		];
		return [
			{ name: 'workflow', type: 'COMBO', default: mv[0], options },
			{ name: 'variant_count', type: 'INT', default: 3, min: 1, max: 25 },
			{ name: 'prompt', type: 'TEXT', default: '' },
		];
	};
	// UpscaleStage：ComfyTV model_edits.py 定义 workflow + scale["2x","4x"] 两个可见参数。
	// genericStageWidgets 只生成 workflow，缺少 scale → 用户无法选择放大倍数。
	const upscaleWidgets = (): NodeSpec['widgets'] => {
		const opts = workflowOptionsFor('upscale');
		return [
			{ name: 'workflow', type: 'COMBO', default: opts[0], options: opts },
			{ name: 'scale', type: 'COMBO', default: '2x', options: ['2x', '4x'] },
		];
	};
	// PanoramaStage：ComfyTV panorama.py 定义 direction["left","right","up","down"]。
	const panoramaWidgets = (): NodeSpec['widgets'] => {
		const opts = workflowOptionsFor('panorama');
		return [
			{ name: 'workflow', type: 'COMBO', default: opts[0], options: opts },
			{ name: 'direction', type: 'COMBO', default: 'right', options: ['left', 'right', 'up', 'down'] },
		];
	};
	// MultiangleStage：ComfyTV multiangle.py 定义 angle_step(15-90) + num_views(4-24)。
	const multiangleWidgets = (): NodeSpec['widgets'] => {
		const opts = workflowOptionsFor('multiangle');
		return [
			{ name: 'workflow', type: 'COMBO', default: opts[0], options: opts },
			{ name: 'angle_step', type: 'INT', default: 30, min: 15, max: 90 },
			{ name: 'num_views', type: 'INT', default: 8, min: 4, max: 24 },
		];
	};
	for (const meta of COMFYTV_STAGE_META) {
		const outType = comfyTVKindOutputType(meta.kind);
		let widgets: NodeSpec['widgets'] = genericStageWidgets(meta.workflowKind ?? meta.kind);
		if (meta.nodeId === 'ComfyTV.ImageVariationsStage') {
			widgets = imageVariationsWidgets();
		} else if (meta.nodeId === 'ComfyTV.UpscaleStage') {
			widgets = upscaleWidgets();
		} else if (meta.nodeId === 'ComfyTV.PanoramaStage') {
			widgets = panoramaWidgets();
		} else if (meta.nodeId === 'ComfyTV.MultiangleStage') {
			widgets = multiangleWidgets();
		}
		registerNodeSpec({
			type: meta.nodeId,
			kind: 'schema',
			title: meta.title,
			category: 'comfyTV',
			// ComfyTV exposes the autogrow lists as connectable pins; everything
			// else is socketless (Vue panel owns it).
			inputs: [{ name: 'input', type: 'ANY' }],
			outputs: [{ name: 'output', type: outType }],
			widgets,
			color: '#e879f9',
			comfyTV: {
				stageKind: meta.kind,
				workflowKind: meta.workflowKind ?? meta.kind,
				// variant 是 ComfyTV 框架驱动卡片形态的核心声明（transform/loader
				// 无运行按钮、无 prompt）。generated meta 一直带着它，此前在注册时
				// 被丢弃，导致卡片只能按节点类型硬编码 26 个 isXxx 分支。
				variant: normalizeStageVariant(meta.variant),
			},
		});
	}
	// 核心 generator：精确 widgets（对齐 ComfyTV generators.py），覆盖上面通用注册。
	const imageWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('image')[0], options: workflowOptionsFor('image') },
		{ name: 'resolution', type: 'COMBO', default: '1K', options: COMFYTV_RESOLUTIONS },
		{ name: 'aspect_ratio', type: 'COMBO', default: '1:1', options: COMFYTV_ASPECT_RATIOS },
		{ name: 'batch_size', type: 'INT', default: 1, min: 1, max: 8 },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const videoWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('video')[0], options: workflowOptionsFor('video') },
		{ name: 'resolution', type: 'COMBO', default: '720P', options: COMFYTV_RESOLUTIONS },
		{ name: 'aspect_ratio', type: 'COMBO', default: '16:9', options: COMFYTV_ASPECT_RATIOS },
		{ name: 'duration_s', type: 'INT', default: 5, min: 1, max: 120 },
		{ name: 'generate_audio', type: 'BOOLEAN', default: false },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const audioWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('audio')[0], options: workflowOptionsFor('audio') },
		{ name: 'duration_s', type: 'FLOAT', default: 30, min: 1, max: 600 },
		{ name: 'bpm', type: 'INT', default: 120, min: 40, max: 200 },
		{ name: 'timesignature', type: 'COMBO', default: '4', options: ['2', '3', '4', '6'] },
		{ name: 'keyscale', type: 'COMBO', default: 'C major', options: ['C major', 'C minor', 'G major', 'G minor', 'D major', 'D minor', 'A major', 'A minor', 'E major', 'E minor', 'B major', 'B minor', 'F major', 'F minor', 'F# major', 'F# minor', 'C# major', 'C# minor'] },
		{ name: 'language', type: 'COMBO', default: 'en', options: ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ar', 'hi'] },
	];
	const speechWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('speech')[0], options: workflowOptionsFor('speech') },
		{ name: 'voice', type: 'TEXT', default: '' },
		{ name: 'language', type: 'COMBO', default: 'Auto', options: ['Auto', 'English', 'Mandarin Chinese', 'Japanese', 'Korean', 'French', 'German', 'Spanish'] },
		{ name: 'speed', type: 'FLOAT', default: 1.0, min: 0.5, max: 2.0 },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const textWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('text')[0], options: workflowOptionsFor('text') },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const modelWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('model')[0], options: workflowOptionsFor('model') },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	const refineStage = (type: string, widgets: NodeSpec['widgets'], extraInputs: { name: string; type: string }[], extraOutputs: { name: string; type: string }[]): void => {
		const existing = registry.get(type)?.spec;
		if (!existing) { return; }
		registerNodeSpec({
			...existing,
			widgets,
			inputs: extraInputs,
			outputs: extraOutputs,
		});
	};
	refineStage('ComfyTV.ImageStage', imageWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }],
		[{ name: 'images', type: 'COMFYTV_IMAGES' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	// MultiangleStage：ComfyTV model_edits.py 的 INPUT_TYPES 定义了
	// horizontal_angle / vertical_angle / zoom 三个 FLOAT slider，与 ImageStage
	// 的 workflow/resolution/aspect_ratio/batch_size 完全不同。必须单独 refine。
	const multiangleRefineWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('multiangle')[0], options: workflowOptionsFor('multiangle') },
		{ name: 'horizontal_angle', type: 'FLOAT', default: 30, min: 0, max: 180 },
		{ name: 'vertical_angle', type: 'FLOAT', default: 0, min: -90, max: 90 },
		{ name: 'zoom', type: 'FLOAT', default: 1.0, min: 0.5, max: 2.0 },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.MultiangleStage', multiangleRefineWidgets,
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	// PanoramaStage：ComfyTV panorama.py 定义 workflow/direction/prompt。
	// 需要 image 输入（参考图）+ prompt（生成描述）。
	const panoramaRefineWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('panorama')[0], options: workflowOptionsFor('panorama') },
		{ name: 'direction', type: 'COMBO', default: 'right', options: ['left', 'right', 'up', 'down'] },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.PanoramaStage', panoramaRefineWidgets,
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'images', type: 'COMFYTV_IMAGES' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	// EraseStage：需要 image 输入（涂抹参考）+ mask_data 隐藏输入
	refineStage('ComfyTV.EraseStage',
		[
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('erase')[0], options: workflowOptionsFor('erase') },
			{ name: 'brush_size', type: 'INT', default: 20, min: 1, max: 200 },
		],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	refineStage('ComfyTV.VideoStage', videoWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'videos', type: 'COMFYTV_VIDEO' }],
		[{ name: 'videos', type: 'COMFYTV_VIDEO' }]);
	// KenBurnsStage：ComfyTV KenBurnsStageCard.vue 实际仅是滑块卡片
	// （width/height/fps/duration/start·end zoom·x·y + interp），无 workflow 选择、
	// 无专门视口拖拽编辑器。参数精确对齐 ComfyTV video_generate.py 的 define_schema。
	// 节点级渲染走 nodeCard 的 KenBurns 滑块分支（range slider，对齐 ComfyTV FxSlider）。
	const kenBurnsWidgets: NodeSpec['widgets'] = [
		{ name: 'width', type: 'INT', default: 1280, min: 16, max: 4096, step: 16 },
		{ name: 'height', type: 'INT', default: 720, min: 16, max: 4096, step: 16 },
		{ name: 'fps', type: 'INT', default: 24, min: 1, max: 120, step: 1 },
		{ name: 'duration', type: 'FLOAT', default: 5.0, min: 0.5, max: 120, step: 0.5 },
		{ name: 'start_zoom', type: 'FLOAT', default: 1.0, min: 1.0, max: 6.0, step: 0.05 },
		{ name: 'end_zoom', type: 'FLOAT', default: 1.3, min: 1.0, max: 6.0, step: 0.05 },
		{ name: 'start_x', type: 'FLOAT', default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
		{ name: 'start_y', type: 'FLOAT', default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
		{ name: 'end_x', type: 'FLOAT', default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
		{ name: 'end_y', type: 'FLOAT', default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
		{ name: 'interp', type: 'COMBO', default: 'smooth', options: ['linear', 'smooth', 'ease_in', 'ease_out'] },
	];
	refineStage('ComfyTV.KenBurnsStage', kenBurnsWidgets,
		[{ name: 'input', type: 'ANY' }],
		[{ name: 'output', type: 'COMFYTV_VIDEO' }]);
	refineStage('ComfyTV.AudioStage', audioWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'audio', type: 'COMFYTV_AUDIO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	refineStage('ComfyTV.SpeechStage', speechWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'reference_audio', type: 'COMFYTV_AUDIO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	refineStage('ComfyTV.TextStage', textWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }],
		[{ name: 'texts', type: 'COMFYTV_TEXT' }]);
	refineStage('ComfyTV.Model3DStage', modelWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }],
		[{ name: 'models', type: 'COMFYTV_MODEL' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	// Picker 家族：媒体批量 → 单选快照。
	refineStage('ComfyTV.ImagePickerStage', undefined,
		[{ name: 'batch', type: 'COMFYTV_IMAGES' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	refineStage('ComfyTV.VideoPickerStage', undefined,
		[{ name: 'batch', type: 'COMFYTV_VIDEO' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	refineStage('ComfyTV.AudioPickerStage', undefined,
		[{ name: 'batch', type: 'COMFYTV_AUDIO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// Loader 家族（ComfyTV loaders.py 语义：media 输入 / 上传 → 快照输出）。
	const loader = (type: string, outType: string, inType?: string): void => {
		const existing = registry.get(type)?.spec;
		if (!existing) { return; }
		registerNodeSpec({
			...existing,
			inputs: inType ? [{ name: 'input', type: inType }] : [],
			outputs: [{ name: 'output', type: outType }],
		});
	};
	loader('ComfyTV.ImageLoaderStage', 'COMFYTV_IMAGE');
	loader('ComfyTV.VideoLoaderStage', 'COMFYTV_VIDEO');
	loader('ComfyTV.AudioLoaderStage', 'COMFYTV_AUDIO');
	loader('ComfyTV.TextLoaderStage', 'COMFYTV_TEXT');
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
			// 端口名对齐 ComfyTV 参考 UI：卡片头部显示 `Image ─ Image`
			// （ComfyTV 的 stage 端口按类型命名），而非通用的 input/output。
			// 端口**类型**同样对齐其它 ComfyTV stage：用 `COMFYTV_IMAGE` 而非裸
			// `IMAGE` —— 卡片 OUTPUT 标题取 `primaryOutputType`，裸 IMAGE 会渲染成
			// `OUTPUT (IMAGE)`，而参考 UI 是 `OUTPUT (COMFYTV_IMAGE)`；
			// 且与 ImageStage 的 COMFYTV_IMAGES / PickerStage 的 COMFYTV_IMAGE
			// 同族，连线语义更一致。
			inputs: [{ name: 'Image', type: 'COMFYTV_IMAGE' }],
			outputs: [{ name: 'Image', type: 'COMFYTV_IMAGE' }],
			widgets: INSTANT_WIDGETS[type],
		});
	};
	instant('ComfyTV.CropStage', '裁剪');
	instant('ComfyTV.RotateStage', '旋转');
	instant('ComfyTV.MirrorStage', '镜像');
	// 见 syncNodePortsToSpec：已存在于画布/存档里的节点端口名是**序列化数据**，
	// 改这里的 spec 只影响新建节点；老节点靠画布层的同步函数就地纠正。
	// P3 — Relight embedded light-ball editor (browser-local, two outputs).
	registerNodeSpec({
		type: 'ComfyTV.RelightStage',
		kind: 'native',
		title: '打光',
		category: 'comfyRelight',
		inputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
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
			{ name: 'width', type: 'INT', default: 1240 },
			{ name: 'height', type: 'INT', default: 1754 },
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
	// 对齐 ComfyTV 截图：有 image 输入端口（接收上游图像做材质估算）+ workflow 下拉。
	registerNodeSpec({
		type: 'ComfyTV.MaterialStage',
		kind: 'native',
		title: '材质',
		category: 'comfyMaterial',
		inputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'material', type: 'TEXT' },
			{ name: 'image', type: 'IMAGE' },
		],
		widgets: [
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('material-estimate')[0], options: workflowOptionsFor('material-estimate') },
			{ name: 'material_state', type: 'TEXT', default: '' },
		],
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
		case 'SAROS_JSON': case 'json': return 'SAROS_JSON';
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
