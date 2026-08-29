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
import { COMFYTV_FX_FIELDS } from './comfyTVFxFields.generated.js';
import { listBuiltinLabels } from './builtinWorkflows/index.js';
import { isFxBuildNode } from './fxChain.js';
import { VIDEO_TO_GIF_TYPE, VIDEO_TO_GIF_WIDGETS } from './videoToGif.js';

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
 * ComfyTV 风格 Saros 节点色板（深色低饱和）—— **单一真源**。
 *
 * ★ 原配色是 Tailwind 500 系（#f97316 橙 / #eab308 黄 / #10b981 绿 / #ef4444 红），
 *   高饱和高亮度，在深色画布上刺眼，且与 ComfyTV stage 节点的深紫色系
 *   （ImageStage ≈ #6b3fa0）冲突 —— 同画布上编排节点像「贴纸」、ComfyTV 节点
 *   像原生控件。统一降到亮度 ~0.45 / 中低饱和，保留**色相**做类别区分。
 *
 * `sarosLiteGraphNodes.NODE_CONFIGS` 从这里取色，保证 spec 与 LiteGraph class
 * 两套定义同色（两处硬编码曾经漂移过）。
 */
export const SAROS_NODE_COLORS = {
	start: '#3f7a52',      // 深绿 — 起点
	end: '#7a4242',        // 深红 — 终点
	task: '#3f5a8a',       // 深蓝 — 任务
	prompt: '#5a4a8a',     // 深紫 — 内容（对齐 ComfyTV stage 紫）
	agent: '#8a5a3f',      // 深棕橙 — 执行主体
	skill: '#7a6a3f',      // 深金 — 技能
	tool: '#3f7a6a',       // 深青绿 — 工具
	ifElse: '#7a4a52',     // 深玫红 — 条件分支
	switch: '#6a4a8a',     // 深紫罗兰 — 多路分支
	merge: '#3f6a8a',      // 深天蓝 — 汇聚
	loop: '#7a5f3f',       // 深琥珀 — 循环
	parallel: '#3f7a72',   // 深青 — 并发
	askUser: '#3f6a7a',    // 深青蓝 — 人工介入
	group: '#55554f',      // 中灰 — 容器
	subflow: '#4a5260',    // 灰蓝 — 子流程
} as const;

/**
 * 编排节点中「参数用 **DOM 卡片**绘制」的类型 —— **单一真源**。
 *
 * 这些节点的参数复用 ImageStage 那套 DOM UI（MentionTextarea / ComboPopover /
 * 宽 label 单列），而不是 LiteGraph canvas 原生 widget。三处消费：
 *   1. `nodeCard.getNodeCardMeta` / NodeCard —— 放开原本 `kind==='schema'` 的
 *      门控（showRun / hasPrompt / isProviderImageGen / 控件行样式）。
 *   2. `LiteGraphCanvas.syncOverlay` —— 挂 `__saros_form` widget 参与**高度反馈**
 *      （否则走 fallbackY ≈100px 兜底，textarea 与下拉被裁掉）。
 *   3. `sarosLiteGraphNodes._initWidgets` —— canvas widget 全部标 `hidden`
 *      （只保留 properties 持久化通道），避免 canvas / DOM 双绘同一参数。
 *
 * 放在 registry（底层、无 React 依赖）而非 nodeCard.tsx，让 sarosLiteGraphNodes
 * 也能引用而不必把 React 组件拉进 LiteGraph 节点模块。
 */
export const ORCH_RICH_NODE_TYPES = new Set<string>([
	'Saros.Start',
	'Saros.Prompt',
	'Saros.Task',
	'Saros.Agent',
	'Saros.Skill',
	'Saros.Tool',
	'Saros.IfElse',
	'Saros.Switch',
	'Saros.Merge',
	'Saros.Loop',
	'Saros.Parallel',
	'Saros.AskUser',
]);

/**
 * Register all existing Saros node types.
 * This is the single migration point: ReactFlow's nodeTypes map is replaced by this.
 */
export function registerSarosNodes(): void {
	// ★ 端口命名：通用数据端口 `in` / `out`（原来输入输出**都叫 value**，画布上
	//   Agent 节点左右显示同一个 "value"，毫无语义）。
	//   ⚠ 分支端口名（true/false/case-1..4/default）**不可改** ——
	//   `executionGraph.isEdgeActive` 按 `edge.sourceHandle === branch` 路由。
	//   ⚠ 这里的 spec 是端口名**权威**：`syncNodePortsToSpec` 每帧把节点实例的
	//   端口名同步成 spec（槽位数相等时），所以必须与 sarosLiteGraphNodes 的
	//   NODE_CONFIGS 保持**同名同数**，否则改了 class 也会被这里覆盖回去。
	const jin = (required: boolean = true): PortSpec => ({ name: 'in', type: 'SAROS_JSON', required });
	const jout = (required: boolean = false): PortSpec => ({ name: 'out', type: 'SAROS_JSON', required });
	registerNodeSpec({ type: 'Saros.Start', kind: 'react', title: '开始', category: 'system', inputs: [], outputs: [
		{ name: 'out', type: 'SAROS_JSON', required: false },
		// COMFYTV_TEXT 桥：args.text 或 args.prompt 字段直连 ComfyTV stage 的 texts/prompt 输入
		{ name: 'text', type: 'COMFYTV_TEXT', required: false },
	], color: SAROS_NODE_COLORS.start, widgets: [{ name: 'args', type: 'TEXT', default: '{}' }] });
	registerNodeSpec({ type: 'Saros.End', kind: 'react', title: '结束', category: 'system', inputs: [jin(true)], outputs: [], color: SAROS_NODE_COLORS.end });
	registerNodeSpec({ type: 'Saros.Task', kind: 'react', title: '任务', category: 'basic', inputs: [jin()], outputs: [jout()], color: SAROS_NODE_COLORS.task, widgets: [{ name: 'prompt', type: 'TEXT' }] });
	// ★ 编排节点的 widgets 是 **DOM 富卡的数据源**（`getNodeCardMeta` 从
	//   `spec.widgets` 派生 `controls` 与 `hasPrompt`）—— 让参数复用 ImageStage
	//   那套 DOM UI（MentionTextarea / ComboPopover / 宽 label 单列），而不是
	//   LiteGraph canvas 原生 widget（窄、无 @ 提及、配色与 ComfyTV 不一致）。
	//
	//   ⚠ widget `name` 必须与 `nodeEditorForm.VSSAROS_FIELDS` 的 `key` **完全一致**：
	//   `LiteGraphCanvas.handleNodeControl` 直接 `node.properties[name] = value`，
	//   名字对不上就会写到一个执行层永远读不到的键（值静默丢失）。
	//   故 Agent 用 `providerId`/`modelId`（**不是** provider/model —— 那是
	//   ComfyTV ModelImageGen 的文生图键名，语义与过滤规则都不同）。
	registerNodeSpec({ type: 'Saros.Prompt', kind: 'react', title: '提示', category: 'basic', inputs: [jin()], outputs: [{ name: 'output', type: 'TEXT' }], color: SAROS_NODE_COLORS.prompt, widgets: [{ name: 'prompt', type: 'TEXT' }] });
	registerNodeSpec({ type: 'Saros.Agent', kind: 'react', title: 'Agent', category: 'basic', inputs: [jin()], outputs: [jout()], color: SAROS_NODE_COLORS.agent, widgets: [
		{ name: 'agentId', type: 'COMBO' },
		{ name: 'providerId', type: 'COMBO' },
		{ name: 'modelId', type: 'COMBO' },
		{ name: 'prompt', type: 'TEXT' },
	] });
	registerNodeSpec({ type: 'Saros.Skill', kind: 'react', title: 'Skill', category: 'basic', inputs: [jin()], outputs: [jout()], color: SAROS_NODE_COLORS.skill, widgets: [
		{ name: 'skillName', type: 'COMBO' },
		{ name: 'task', type: 'TEXT' },
		{ name: 'skillArgs', type: 'TEXT', default: '{}' },
	] });
	registerNodeSpec({ type: 'Saros.Tool', kind: 'react', title: 'Tool', category: 'basic', inputs: [jin()], outputs: [jout()], color: SAROS_NODE_COLORS.tool, widgets: [
		{ name: 'toolName', type: 'COMBO' },
		{ name: 'toolParams', type: 'TEXT', default: '{}' },
	] });
	// Subflow（子流程）：编排层容器，data.subflow 承载内部图。展开（flattenSubflows）
	// 在执行/导出前还原。静态 SAROS_JSON 端口作为编排容器主链路；内部图的
	// entry/exit 端口在执行期由 substituteSubflow 重映射。
	registerNodeSpec({ type: 'Saros.Subflow', kind: 'react', title: '子流程', category: 'basic', inputs: [jin()], outputs: [jout()], color: SAROS_NODE_COLORS.subflow });
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
	// 参数设计对齐 OpenAI GPT Image / DALL-E 等主流 provider（2026-08-26）：
	//   - size 预设尺寸（优先于 width/height，provider 按预设映射）
	//   - quality 标准/高质量（GPT Image 特有）
	//   - numImages 批量出图数
	//   - negativePrompt 负面提示词（部分 provider 支持）
	//   - seed 可复现种子
	//   - custom_width/custom_height 自定义尺寸（size 为空时生效）
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
			// ── Provider & Model ──────────────────────────────────────
			// provider 选择（COMBO，nodeCard 动态填充已认证文生图 provider）
			{ name: 'provider', type: 'COMBO', default: '', options: [] },
			// model 选择（COMBO，随 provider 联动）
			{ name: 'model', type: 'COMBO', default: '', options: [] },
			// ── 图像规格 ─────────────────────────────────────────────
			// 预设尺寸（优先级高于 custom_width/height；空串=使用自定义尺寸）
			{ name: 'size', type: 'COMBO', default: '', options: [
				{ value: '', label: '自定义' },
				{ value: '1024x1024', label: '1024×1024 (方形)' },
				{ value: '1792x1024', label: '1792×1024 (横版)' },
				{ value: '1024x1792', label: '1024×1792 (竖版)' },
				{ value: '2048x1152', label: '2048×1152 (宽屏)' },
				{ value: '1152x2048', label: '1152×2048 (长屏)' },
			]},
			// 自定义宽度（size 为空时生效）
			{ name: 'custom_width', type: 'INT', default: 1024 },
			// 自定义高度（size 为空时生效）
			{ name: 'custom_height', type: 'INT', default: 1024 },
			// ── 生成控制 ─────────────────────────────────────────────
			// 质量（GPT Image 等 provider 特有：standard/high）
			{ name: 'quality', type: 'COMBO', default: 'standard', options: [
				{ value: 'standard', label: '标准' },
				{ value: 'high', label: '高质量' },
			]},
			// 批量出图数量
			{ name: 'numImages', type: 'INT', default: 1, min: 1, max: 10 },
			// 可复现种子（-1 = 随机）
			{ name: 'seed', type: 'INT', default: -1 },
			// ── 提示词 ───────────────────────────────────────────────
			// 正面提示词
			{ name: 'prompt', type: 'TEXT', default: '' },
			// 负面提示词（部分 provider 支持，如 ComfyUI 后端 / SDXL）
			{ name: 'negativePrompt', type: 'TEXT', default: '' },
		],
		backendKind: 'provider',
		providerCaps: 'imageGen',
		color: '#06b6d4',
		comfyTV: { stageKind: 'image', workflowKind: 'image-to-image' },
	});
	// ── Vox 口播视频节点（kind=schema，走 runStageWorkflow 内置模板）────────────
	// 三节点串联：口播脚本(TEXT) → vox 图像(COMFYTV_IMAGES) → vox 视频(COMFYTV_VIDEO)。
	// 端口/控件对齐 vox 管道（keyframes.py / clips.py / audio.py / styles.py）。
	registerNodeSpec({
		type: 'Vox.ScriptStage',
		kind: 'schema',
		title: '口播脚本',
		category: 'vox',
		inputs: [],
		outputs: [{ name: 'texts', type: 'COMFYTV_TEXT' }],
		widgets: [
			{ name: 'title_cn', type: 'TEXT', default: '' },
			{ name: 'title_en', type: 'TEXT', default: '' },
			{ name: 'aspect', type: 'COMBO', default: '9:16', options: ['9:16', '16:9', '1:1', '4:3', '3:4'] },
			{ name: 'language', type: 'COMBO', default: 'zh', options: ['zh', 'en'] },
			{ name: 'theme', type: 'COMBO', default: 'american-retro', options: ['american-retro', 'tang', 'song', 'wpa-propaganda', '70s-groovy'] },
			{ name: 'beats_count', type: 'INT', default: 5, min: 1, max: 12 },
			{ name: 'prompt', type: 'TEXT', default: '为「{{topic}}」写一段口播脚本：标题中英、3-6 个镜头 beats，每个 beats 含 narration 与 scene，输出 JSON。' },
		],
		color: '#f97316',
		comfyTV: { stageKind: 'vox-script', workflowKind: 'vox-script' },
	});
	registerNodeSpec({
		type: 'Vox.ImageStage',
		kind: 'schema',
		title: 'vox 图像生成',
		category: 'vox',
		inputs: [{ name: 'texts', type: 'COMFYTV_TEXT' }],
		outputs: [{ name: 'images', type: 'COMFYTV_IMAGES' }],
		widgets: [
			{ name: 'workflow', type: 'COMBO', default: 'Local Flux Dev Keyframe', options: ['Local Flux Dev Keyframe'] },
			{ name: 'image_model', type: 'COMBO', default: 'flux-dev', options: ['flux-dev', 'sdxl'] },
			{ name: 'style', type: 'COMBO', default: 'collage', options: ['collage', 'keyframe'] },
			{ name: 'collage_style', type: 'COMBO', default: 'american-retro', options: ['american-retro', 'wpa-propaganda', '70s-groovy', 'bauhaus'] },
			{ name: 'palette', type: 'COMBO', default: 'auto', options: ['auto', 'muted', 'vibrant', 'mono'] },
			{ name: 'theme', type: 'COMBO', default: 'american-retro', options: ['american-retro', 'tang', 'song'] },
			{ name: 'era', type: 'COMBO', default: 'auto', options: ['auto', '1920s', '1950s', '1980s'] },
			{ name: 'aspect', type: 'COMBO', default: '9:16', options: ['9:16', '16:9', '1:1', '4:3', '3:4'] },
			{ name: 'image_resolution', type: 'COMBO', default: '1k', options: ['1k', '2k'] },
			{ name: 'steps', type: 'INT', default: 20, min: 1, max: 50 },
			{ name: 'cfg', type: 'FLOAT', default: 7.0, min: 0, max: 20 },
			{ name: 'seed', type: 'INT', default: -1 },
		],
		color: '#f97316',
		comfyTV: { stageKind: 'vox-image', workflowKind: 'vox-image' },
	});
	registerNodeSpec({
		type: 'Vox.VideoStage',
		kind: 'schema',
		title: 'vox 视频生成',
		category: 'vox',
		inputs: [{ name: 'images', type: 'COMFYTV_IMAGES' }],
		outputs: [{ name: 'video', type: 'COMFYTV_VIDEO' }],
		widgets: [
			{ name: 'workflow', type: 'COMBO', default: 'Local LTX 2.3 FLF2V', options: ['Local LTX 2.3 FLF2V'] },
			{ name: 'video_model', type: 'COMBO', default: 'ltx-2.3-flf2v', options: ['ltx-2.3-flf2v', 'wan-2.1', 'cogvideox-5b'] },
			{ name: 'camera_move', type: 'COMBO', default: 'static', options: ['static', 'pan-left', 'pan-right', 'zoom-in', 'zoom-out', 'tilt-up', 'tilt-down'] },
			{ name: 'motion_style', type: 'COMBO', default: 'calm', options: ['calm', 'punchy', 'slow', 'dynamic'] },
			{ name: 'duration', type: 'INT', default: 4, min: 1, max: 12 },
			{ name: 'element_motion', type: 'COMBO', default: 'auto', options: ['auto', 'foreground', 'background', 'none'] },
			{ name: 'seed', type: 'INT', default: -1 },
		],
		color: '#f97316',
		comfyTV: { stageKind: 'vox-video', workflowKind: 'vox-video' },
	});
	// ── Vox 口播视频导演（单节点 = 完整 pipeline，走本地 Python 执行）──────────
	// kind=schema 复用卡片渲染，但执行走 runNodeOrStage 的 isVoxDirectorNode 分支
	// （非 ComfyUI 后端）。参数对齐 vox 管道（keyframes/clips/audio/styles）。
	registerNodeSpec({
		type: 'Vox.DirectorStage',
		kind: 'schema',
		title: '口播视频导演',
		category: 'vox',
		inputs: [{ name: 'texts', type: 'COMFYTV_TEXT' }],
		outputs: [{ name: 'video', type: 'COMFYTV_VIDEO' }],
		widgets: [
			{ name: 'topic', type: 'TEXT', default: '' },
			{ name: 'beats_count', type: 'INT', default: 5, min: 1, max: 12 },
			{ name: 'aspect', type: 'COMBO', default: '9:16', options: ['9:16', '16:9', '1:1', '4:3', '3:4'] },
			{ name: 'language', type: 'COMBO', default: 'zh', options: ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de'] },
			{ name: 'theme', type: 'COMBO', default: 'american-retro', options: ['american-retro', 'swiss-modern', 'punk-zine', 'soviet-constructivist', 'wpa-propaganda', '70s-groovy', 'chinese-ink', 'atomic-age', 'newsprint-editorial', 'gilded-deco'] },
			// ★ 免费方案：voice_id 留空 → 按 language 映射 edge-tts 免费音色；
			//   填 edge-tts 音色名（如 zh-CN-YunxiNeural）可自定义音色。
			{ name: 'voice_id', type: 'TEXT', default: '' },
			{ name: 'speed', type: 'FLOAT', default: 1.0, min: 0.5, max: 2.0 },
			{ name: 'music', type: 'TEXT', default: '' },
			// ★ 免费方案默认 local-ltx（LTX 2.3 本地图生视频 + zoompan 兜底）；
			//   veo3 等是 MuAPI 付费模型，仅 provider='muapi' 时用。
			{ name: 'video_model', type: 'COMBO', default: 'local-ltx', options: ['local-ltx', 'veo3.1-image-to-video', 'veo31-image-to-video', 'gemini-omni-flash/image-to-video', 'runway-image-to-video', 'kling-video'] },
			{ name: 'camera_move', type: 'COMBO', default: 'push_in', options: ['push_in', 'push_out', 'pan_left', 'pan_right', 'zoom_in', 'zoom_out', 'tilt_up', 'tilt_down', 'static'] },
			{ name: 'motion_style', type: 'COMBO', default: 'calm', options: ['calm', 'punchy', 'max', 'slow', 'dynamic'] },
			{ name: 'duration', type: 'INT', default: 4, min: 1, max: 12 },
			{ name: 'caption_style', type: 'COMBO', default: 'white', options: ['white', 'black', 'yellow', 'none'] },
			// 免费方案（默认）无需 api_key；仅切换 provider='muapi' 付费后端时填写。
			{ name: 'api_key', type: 'TEXT', default: '' },
		],
		color: '#f97316',
		comfyTV: { stageKind: 'vox-director', workflowKind: 'vox-director' },
	});
	registerNodeSpec({ type: 'Saros.IfElse', kind: 'react', title: 'If/Else', category: 'controlFlow', inputs: [jin()], outputs: [{ name: 'true', type: 'SAROS_JSON' }, { name: 'false', type: 'SAROS_JSON' }], color: SAROS_NODE_COLORS.ifElse, widgets: [{ name: 'evaluationTarget', type: 'TEXT' }] });
	// W3: Merge 汇聚节点（双输入）—— 分支合流。widget `mode`：
	//   all   = 等全部入边，输出 {inA, inB}（桶可为 null=分支未激活）
	//   any   = 首个非空入边值直接透传（OR 语义）
	//   order = 按端口序输出数组 [inA, inB]（保留 null 对齐下标）
	registerNodeSpec({ type: 'Saros.Merge', kind: 'react', title: '汇聚', category: 'controlFlow', inputs: [{ name: 'inA', type: 'SAROS_JSON' }, { name: 'inB', type: 'SAROS_JSON' }], outputs: [jout()], color: SAROS_NODE_COLORS.merge, widgets: [{ name: 'mode', type: 'COMBO', default: 'all', options: ['all', 'any', 'order'] }] });
	// W5: Loop/Parallel 迭代子图节点——body 存 data.loopBody（SubflowDefinition
	// 同构；**不走 flattenSubflows**——执行时容器而非设计时组合，避免双跑）。
	// widget `items`（JSON 数组或 {{input}} 引用上游数组快照）逐项跑 body，
	// 当前项写入 Loop 自身快照（body 内 {{input}} = item）。
	registerNodeSpec({ type: 'Saros.Loop', kind: 'react', title: '循环', category: 'controlFlow', inputs: [jin()], outputs: [jout()], color: SAROS_NODE_COLORS.loop, widgets: [{ name: 'items', type: 'TEXT', default: '[]' }, { name: 'concurrency', type: 'INT', default: 1 }] });
	registerNodeSpec({ type: 'Saros.Parallel', kind: 'react', title: '并发', category: 'controlFlow', inputs: [jin()], outputs: [jout()], color: SAROS_NODE_COLORS.parallel, widgets: [{ name: 'items', type: 'TEXT', default: '[]' }, { name: 'concurrency', type: 'INT', default: 4 }] });
	// W2b: Switch 多 case 输出（case-1..4 + default）。widget `cases` 定义每路
	// 匹配值（JSON 数组或逗号分隔，长度 ≤4）；运行时 value 命中第 i 路 →
	// branch='case-i'（端口路由），无命中 → 'default'。
	registerNodeSpec({ type: 'Saros.Switch', kind: 'react', title: 'Switch', category: 'controlFlow', inputs: [jin()], outputs: [
		{ name: 'case-1', type: 'SAROS_JSON' }, { name: 'case-2', type: 'SAROS_JSON' }, { name: 'case-3', type: 'SAROS_JSON' }, { name: 'case-4', type: 'SAROS_JSON' }, { name: 'default', type: 'SAROS_JSON' },
	], color: SAROS_NODE_COLORS.switch, widgets: [{ name: 'evaluationTarget', type: 'TEXT' }, { name: 'cases', type: 'TEXT', default: '[]' }] });
	registerNodeSpec({ type: 'Saros.AskUser', kind: 'react', title: '询问', category: 'controlFlow', inputs: [jin()], outputs: [{ name: 'answer', type: 'SAROS_JSON' }], color: SAROS_NODE_COLORS.askUser, widgets: [
		{ name: 'questionText', type: 'TEXT', default: 'Select an option' },
		{ name: 'options', type: 'TEXT', default: '[{"label":"Option 1"},{"label":"Option 2"}]' },
		{ name: 'multiSelect', type: 'COMBO', default: 'no', options: ['yes', 'no'] },
	] });
	registerNodeSpec({ type: 'Saros.Group', kind: 'react', title: '分组', category: 'layout', inputs: [], outputs: [], color: SAROS_NODE_COLORS.group });
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
	// UpscaleStage：ComfyTV model_edits.py 定义 workflow + scale["2x","4x"] +
	// main_prompt（可选扩散精修引导）+ image(COMFYTV_IMAGE)。genericStageWidgets 只生成
	// workflow，缺少 scale → 用户无法选择放大倍数；此处补 prompt，image 输入由
	// 循环后 refineStage 精确补上。
	const upscaleWidgets = (): NodeSpec['widgets'] => {
		const opts = workflowOptionsFor('upscale');
		return [
			{ name: 'workflow', type: 'COMBO', default: opts[0], options: opts },
			{ name: 'scale', type: 'COMBO', default: '2x', options: ['2x', '4x'] },
			{ name: 'prompt', type: 'TEXT', default: '' },
		];
	};
	// PanoramaStage：ComfyTV panorama.py 的 define_schema 无 direction 参数
	//   （direction 属于 LensDistort/STMapGen/Particles，见 preset_fields.py）。
	//   此处不再特殊生成（由循环后 panoramaRefineWidgets 精确覆盖）。
	const panoramaWidgets = (): NodeSpec['widgets'] => workflowOptionsFor('panorama').length
		? [{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('panorama')[0], options: workflowOptionsFor('panorama') }]
		: [];
	// fx 节点（VideoColorStage/AudioEQStage/…）：ComfyTV 这些是 fx-chain builder，
	// 走单节点执行（class_type = stage 本身），参数直接作为 socketless hidden 字段
	// 由 StagePresetBar + CustomParamsSection 渲染。此处把 COMFYTV_FX_FIELDS 的字段
	// 转成 DOM widgets（FLOAT/INT/COMBO/BOOLEAN），让 nodeCard 通用控件渲染参数面板，
	// 替代原本对 fx 节点无意义的 workflow 下拉。TEXT 字段（lut_file/bands/curves 等
	// 需专用 UI）不在表内，保留后端默认值。
	const fxFieldWidgets = (nodeId: string): NodeSpec['widgets'] => {
		const fields = COMFYTV_FX_FIELDS[nodeId];
		if (!fields || fields.length === 0) { return undefined; }
		const w: NonNullable<NodeSpec['widgets']> = [];
		for (const f of fields) {
			if (f.type === 'COMBO') {
				w.push({ name: f.name, type: 'COMBO', default: String(f.default), options: f.options ?? [] });
			} else if (f.type === 'BOOLEAN') {
				w.push({ name: f.name, type: 'BOOLEAN', default: Boolean(f.default) });
			} else if (f.type === 'INT') {
				w.push({ name: f.name, type: 'INT', default: Number(f.default), min: f.min, max: f.max });
			} else {
				w.push({ name: f.name, type: 'FLOAT', default: Number(f.default), min: f.min, max: f.max, step: f.step });
			}
		}
		return w;
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
		} else if (isFxBuildNode(meta.nodeId)) {
			// fx 节点用参数字段替代 workflow 下拉（fx 不走 workflow）。
			widgets = fxFieldWidgets(meta.nodeId);
		}
		// ★ MultiangleStage 不在此处特殊生成：旧 angle_step/num_views 参数已过时
		//   （ComfyTV 现为 model_edits.py 的 horizontal_angle/vertical_angle/zoom），
		//   由循环后的 multiangleRefineWidgets 精确覆盖。
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
		{ name: 'grid_count', type: 'COMBO', default: '4', options: ['2', '4', '6', '9'] },
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
	// AudioStage 参数严格对齐 ComfyTV generators.py define_schema：
	//   workflow + main_prompt(prompt) + lyrics(String multiline) +
	//   duration_s(Float 30, 1~240) + bpm(Int 120, 10~300) +
	//   timesignature(ACE_TIME_SIGNATURES) + keyscale(ACE_KEYSCALES 34 项) +
	//   language(ACE_LANGUAGES 51 项)。
	const COMFYTV_ACE_KEYSCALES = (() => {
		const roots = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
		return roots.flatMap(root => [`${root} major`, `${root} minor`]);
	})();
	const COMFYTV_ACE_LANGUAGES = ['ar', 'az', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'ht', 'hu', 'id', 'is', 'it', 'ja', 'ko', 'la', 'lt', 'ms', 'ne', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sa', 'sk', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'yue', 'zh', 'unknown'];
	const COMFYTV_SPEECH_LANGUAGES = ['Auto', 'English', 'English (British)', 'Mandarin Chinese', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Brazilian Portuguese', 'Portuguese', 'Italian', 'Hindi', 'Russian', 'Arabic'];
	const audioWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('audio')[0], options: workflowOptionsFor('audio') },
		{ name: 'prompt', type: 'TEXT', default: '' },
		{ name: 'lyrics', type: 'TEXT', default: '' },
		{ name: 'duration_s', type: 'FLOAT', default: 30, min: 1, max: 240, step: 1 },
		{ name: 'bpm', type: 'INT', default: 120, min: 10, max: 300 },
		{ name: 'timesignature', type: 'COMBO', default: '4', options: ['2', '3', '4', '6'] },
		{ name: 'keyscale', type: 'COMBO', default: 'C major', options: COMFYTV_ACE_KEYSCALES },
		{ name: 'language', type: 'COMBO', default: 'en', options: COMFYTV_ACE_LANGUAGES },
	];
	const speechWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('speech')[0], options: workflowOptionsFor('speech') },
		{ name: 'prompt', type: 'TEXT', default: '' },
		{ name: 'voice', type: 'TEXT', default: '' },
		{ name: 'language', type: 'COMBO', default: 'Auto', options: COMFYTV_SPEECH_LANGUAGES },
		{ name: 'speed', type: 'FLOAT', default: 1.0, min: 0.5, max: 2.0, step: 0.05 },
		{ name: 'reference_text', type: 'TEXT', default: '' },
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
	// MultiangleStage：ComfyTV model_edits.py 的 define_schema 定义
	// horizontal_angle(Int 0-360 默认0) / vertical_angle(Int -30~60 默认0) /
	// zoom(Float 0-10 默认5.0) 三个 slider + prompt。与 ImageStage 的
	// workflow/resolution/aspect_ratio/batch_size 完全不同，必须单独 refine。
	// ★ 数值严格对齐 model_edits.py（此前 FLOAT 0-180 默认30 / -90~90 / 0.5-2
	//   默认1.0 全是错的——zoom 默认 1.0 会退化成原始大小，LoRA 相机控制失效）。
	const multiangleRefineWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('multiangle')[0], options: workflowOptionsFor('multiangle') },
		{ name: 'horizontal_angle', type: 'INT', default: 0, min: 0, max: 360 },
		{ name: 'vertical_angle', type: 'INT', default: 0, min: -30, max: 60 },
		{ name: 'zoom', type: 'FLOAT', default: 5.0, min: 0.0, max: 10.0, step: 0.1 },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.MultiangleStage', multiangleRefineWidgets,
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	// PanoramaStage：ComfyTV panorama.py 定义 workflow + main_prompt + image 输入，
	// 输出为**单个** COMFYTV_PANORAMA.Output("panorama")（非 images/image 双输出）。
	// ★ ComfyTV panorama.py 无 direction 参数（direction 属于 LensDistort/STMapGen/
	//   Particles）。此处只保留 workflow + prompt，严格对齐 define_schema。
	const panoramaRefineWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('panorama')[0], options: workflowOptionsFor('panorama') },
		{ name: 'prompt', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.PanoramaStage', panoramaRefineWidgets,
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'panorama', type: 'COMFYTV_PANORAMA' }]);
	// EraseStage：ComfyTV model_edits.py 定义 workflow + mask_data(hidden) + image。
	// ★ 源码无 brush_size 参数（笔刷大小是 MaskPainter 编辑器的内部 UI 状态，非节点
	//   参数）。此处只保留 workflow + image 输入，mask_data 由 MaskPainter 写入
	//   节点 properties（见 nodeCard commitMaskField）。
	refineStage('ComfyTV.EraseStage',
		[
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('erase')[0], options: workflowOptionsFor('erase') },
		],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	// UpscaleStage：补 image 输入 + image 输出（对齐 model_edits.py）。
	refineStage('ComfyTV.UpscaleStage', upscaleWidgets(),
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'image', type: 'COMFYTV_IMAGE' }]);
	refineStage('ComfyTV.VideoStage', videoWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'videos', type: 'COMFYTV_VIDEO' }, { name: 'audio', type: 'COMFYTV_AUDIO' }],
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
	// KenBurnsStage：源码 video_generate.py 输入 image(COMFYTV_IMAGE)、输出
	// video(COMFYTV_VIDEO)（非通用 input/output 端口名）。
	refineStage('ComfyTV.KenBurnsStage', kenBurnsWidgets,
		[{ name: 'image', type: 'COMFYTV_IMAGE' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	// AudioStage：源码 generators.py 无媒体输入端口（纯 socketless 参数 + 输出 audio）。
	refineStage('ComfyTV.AudioStage', audioWidgets,
		[],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// SpeechStage：源码仅 reference_audio(COMFYTV_AUDIO) 一个输入端口（无 texts）。
	refineStage('ComfyTV.SpeechStage', speechWidgets,
		[{ name: 'reference_audio', type: 'COMFYTV_AUDIO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// TextStage：源码 texts(8) + images(8) + videos(4) 三个 autogrow 输入。
	refineStage('ComfyTV.TextStage', textWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'videos', type: 'COMFYTV_VIDEO' }],
		[{ name: 'texts', type: 'COMFYTV_TEXT' }]);
	// Model3DStage：源码 texts(4) + images(4) + models(4) 三个 autogrow 输入。
	refineStage('ComfyTV.Model3DStage', modelWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'models', type: 'COMFYTV_MODEL' }],
		[{ name: 'models', type: 'COMFYTV_MODEL' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	// ── 补齐 meta.py 缺失节点的精确端口（对齐源码 define_schema）─────────────
	// ShotImagesStage：storyboard(COMFYTV_STORYBOARD) + images 输入 → images/image 输出。
	const shotImagesWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('shot-images')[0], options: workflowOptionsFor('shot-images') },
		{ name: 'resolution', type: 'COMBO', default: '1K', options: COMFYTV_RESOLUTIONS },
		{ name: 'aspect_ratio', type: 'COMBO', default: '1:1', options: COMFYTV_ASPECT_RATIOS },
	];
	refineStage('ComfyTV.ShotImagesStage', shotImagesWidgets,
		[{ name: 'storyboard', type: 'COMFYTV_STORYBOARD' }, { name: 'images', type: 'COMFYTV_IMAGE' }],
		[{ name: 'images', type: 'COMFYTV_IMAGES' }, { name: 'image', type: 'COMFYTV_IMAGE' }]);
	// StoryboardStage：texts 输入 → storyboard 输出（含 total_duration_s/shot_count/
	// characters 参数，对齐 generators.py）。
	const storyboardWidgets: NodeSpec['widgets'] = [
		{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('storyboard')[0], options: workflowOptionsFor('storyboard') },
		{ name: 'prompt', type: 'TEXT', default: '' },
		{ name: 'total_duration_s', type: 'INT', default: 30, min: 2, max: 600 },
		{ name: 'shot_count', type: 'INT', default: 6, min: 1, max: 25 },
		{ name: 'characters', type: 'TEXT', default: '' },
	];
	refineStage('ComfyTV.StoryboardStage', storyboardWidgets,
		[{ name: 'texts', type: 'COMFYTV_TEXT' }],
		[{ name: 'storyboard', type: 'COMFYTV_STORYBOARD' }]);
	// DirectorTimelineStage：images + audio 输入 → timeline 输出（transform 变体）。
	refineStage('ComfyTV.DirectorTimelineStage', undefined,
		[{ name: 'images', type: 'COMFYTV_IMAGE' }, { name: 'audio', type: 'COMFYTV_AUDIO' }],
		[{ name: 'timeline', type: 'COMFYTV_TIMELINE' }]);
	// TimelineVideoStage：timeline 输入 → video 输出（源码含 timeline workflow 下拉）。
	// 注意：builtinWorkflows 暂无 'timeline' 模板，故用 listBuiltinLabels 直取（空则不
	// 兜底成 Local SD1.5，避免误导）；后端补模板后自动出现。
	const timelineLabels = listBuiltinLabels('timeline');
	const timelineVideoWidgets: NodeSpec['widgets'] = timelineLabels.length
		? [{ name: 'workflow', type: 'COMBO', default: timelineLabels[0], options: timelineLabels }]
		: [];
	refineStage('ComfyTV.TimelineVideoStage', timelineVideoWidgets,
		[{ name: 'timeline', type: 'COMFYTV_TIMELINE' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	// VideoUpscaleStage：video 输入 → video 输出 + scale 下拉。
	const videoUpscaleWidgets: NodeSpec['widgets'] = [
		{ name: 'scale', type: 'COMBO', default: '2x', options: ['2x', '4x'] },
	];
	refineStage('ComfyTV.VideoUpscaleStage', videoUpscaleWidgets,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	// 字幕擦除系列：video 输入 → video 输出。
	refineStage('ComfyTV.VideoSubtitleSmartEraseStage', undefined,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	refineStage('ComfyTV.VideoSubtitleSelectEraseStage', undefined,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'video', type: 'COMFYTV_VIDEO' }]);
	// 人声/背景提取：video 输入 → audio 输出 + workflow 下拉（源码 labels_for('audio-vocal'/'audio-bg')）。
	// builtinWorkflows 暂无这两个 kind，用 listBuiltinLabels 直取避免兜底误导。
	const audioVocalLabels = listBuiltinLabels('audio-vocal');
	const audioBgLabels = listBuiltinLabels('audio-bg');
	const audioExtractVocalWidgets: NodeSpec['widgets'] = audioVocalLabels.length
		? [{ name: 'workflow', type: 'COMBO', default: audioVocalLabels[0], options: audioVocalLabels }]
		: [];
	const audioExtractBgWidgets: NodeSpec['widgets'] = audioBgLabels.length
		? [{ name: 'workflow', type: 'COMBO', default: audioBgLabels[0], options: audioBgLabels }]
		: [];
	refineStage('ComfyTV.AudioExtractVocalStage', audioExtractVocalWidgets,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	refineStage('ComfyTV.AudioExtractBgStage', audioExtractBgWidgets,
		[{ name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// AudioClipStage（Audio Trim）：audio + video 输入 → audio 输出。
	refineStage('ComfyTV.AudioClipStage', undefined,
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }, { name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }]);
	// AudioSplitStage：audio + video 输入 → audio_a + audio_b 双输出。
	refineStage('ComfyTV.AudioSplitStage', undefined,
		[{ name: 'audio', type: 'COMFYTV_AUDIO' }, { name: 'video', type: 'COMFYTV_VIDEO' }],
		[{ name: 'audio_a', type: 'COMFYTV_AUDIO' }, { name: 'audio_b', type: 'COMFYTV_AUDIO' }]);
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
	// ★ 输出端口名对齐 ComfyTV `define_schema` 的 Output 名（loaders.py）：
	//   ImageLoaderStage → `image`、VideoLoaderStage → `video`、AudioLoaderStage →
	//   `audio`、TextLoaderStage → `text`（非通用的 `output`）。此前写死 `output`
	//   导致连线端口标签与 ComfyTV 参考 UI 不一致（「loadimage/loadvideo 参数错误」）。
	//   端口**类型**仍用 COMFYTV_* 族（与其它 ComfyTV stage 同族，连线语义一致）。
	const loader = (type: string, outType: string, outName: string, widgets: NodeWidgetSpec[] = []): void => {
		const existing = registry.get(type)?.spec;
		if (!existing) { return; }
		registerNodeSpec({
			...existing,
			inputs: [],
			outputs: [{ name: outName, type: outType }],
			widgets,
		});
	};
	// LoadImage 复刻 ComfyTV LoadImage 编辑器：文件名 input + 本地上传按钮 + 缩略图
	// + 尺寸文字（image widget 类型见 NodeEditorPopup ImageFieldEditor）。
	loader('ComfyTV.ImageLoaderStage', 'COMFYTV_IMAGE', 'image', [
		{ name: 'image', type: 'IMAGE', default: '' },
	]);
	loader('ComfyTV.VideoLoaderStage', 'COMFYTV_VIDEO', 'video', [
		{ name: 'video', type: 'TEXT', default: '' },
	]);
	loader('ComfyTV.AudioLoaderStage', 'COMFYTV_AUDIO', 'audio', [
		{ name: 'audio', type: 'TEXT', default: '' },
	]);
	loader('ComfyTV.TextLoaderStage', 'COMFYTV_TEXT', 'text', [
		{ name: 'text', type: 'TEXT', default: '' },
	]);
	// Asset 系列（loaders.py Asset*LoaderStage，输出名同基础 loader）：
	//   本项目未走 ComfyTV 的文件上传 Combo，改由拖拽媒体库资产（mediaAssetId）
	//   注入；但**输出端口名**仍须对齐 ComfyTV（image/video/audio）。
	loader('ComfyTV.AssetImageLoaderStage', 'COMFYTV_IMAGE', 'image');
	loader('ComfyTV.AssetVideoLoaderStage', 'COMFYTV_VIDEO', 'video');
	loader('ComfyTV.AssetAudioLoaderStage', 'COMFYTV_AUDIO', 'audio');
	// Model loader 双输出（loaders.py ModelLoaderStage/AssetModelLoaderStage：
	//   outputs=[COMFYTV_MODEL.Output("model"), COMFYTV_IMAGE.Output("image")]）。
	const modelLoader = (type: string): void => {
		const existing = registry.get(type)?.spec;
		if (!existing) { return; }
		registerNodeSpec({
			...existing,
			inputs: [],
			outputs: [
				{ name: 'model', type: 'COMFYTV_MODEL' },
				{ name: 'image', type: 'COMFYTV_IMAGE' },
			],
		});
	};
	modelLoader('ComfyTV.ModelLoaderStage');
	modelLoader('ComfyTV.AssetModelLoaderStage');
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
	// ★ 对齐 ComfyTV model_edits.py：RelightStage 无 image 输入（纯灯光球编辑器，
	//   灯光数据由内嵌编辑器持久化为 lights_data/light_render_url hidden 字段）；
	//   输出类型 = COMFYTV_IMAGE("3d light") + COMFYTV_TEXT。
	registerNodeSpec({
		type: 'ComfyTV.RelightStage',
		kind: 'native',
		title: '打光',
		category: 'comfyRelight',
		inputs: [],
		outputs: [
			{ name: 'light_render', type: 'COMFYTV_IMAGE' },
			{ name: 'light_prompt', type: 'COMFYTV_TEXT' },
		],
		widgets: [
			{ name: 'main_prompt', type: 'STRING', default: 'soft studio lighting, gentle shadows' },
		],
	});
	// P3 — Poster embedded layout editor (browser-local, template + layout blob).
	// ★ 对齐 ComfyTV poster.py：images(Autogrow 12) 输入 + image 输出均为 COMFYTV_*
	//   类型；补 layout 隐藏字段（画布布局+配色+字体 blob）。
	registerNodeSpec({
		type: 'ComfyTV.PosterStage',
		kind: 'native',
		title: '海报',
		category: 'comfyPoster',
		inputs: [{ name: 'images', type: 'COMFYTV_IMAGE' }],
		outputs: [{ name: 'image', type: 'COMFYTV_IMAGE' }],
		widgets: [
			{ name: 'template', type: 'COMBO', options: ['hero'], default: 'hero' },
			{ name: 'width', type: 'INT', default: 1240 },
			{ name: 'height', type: 'INT', default: 1754 },
			{ name: 'layout', type: 'TEXT', default: '{}' },
		],
	});
	// P3 — Layer Editor artboard (browser-local compositing + upload).
	// ★ 对齐 ComfyTV layer_editor.py：双输出 image(COMFYTV_IMAGE) + images(COMFYTV_IMAGES)。
	registerNodeSpec({
		type: 'ComfyTV.LayerEditorStage',
		kind: 'native',
		title: '图层画板',
		category: 'comfyLayer',
		inputs: [],
		outputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
			{ name: 'images', type: 'COMFYTV_IMAGES' },
		],
		widgets: [
			{ name: 'width', type: 'INT', default: 1024 },
			{ name: 'height', type: 'INT', default: 1024 },
		],
	});
	// P3 — 导演台编辑器（Storyboard Editor，复用 Layer Editor 画板 per board）。
	registerNodeSpec({
		type: 'ComfyTV.StoryboardEditorStage',
		kind: 'native',
		title: '导演台',
		category: 'comfyStoryboard',
		inputs: [
			// text = 上游分镜文本（Fountain 剧本）→ 打开编辑器时自动解析成 boards
			{ name: 'text', type: 'COMFYTV_TEXT' },
		],
		// 对齐 ComfyTV storyboard_editor.py 三输出：image（封面）/ images（批次）/ video（animatic）
		outputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'video', type: 'COMFYTV_VIDEO' },
		],
		widgets: [
			{ name: 'width', type: 'INT', default: 1280 },
			{ name: 'height', type: 'INT', default: 720 },
		],
	});
	// P3 — Material PBR ball editor (browser-local, dual output).
	// 对齐 ComfyTV material.py：image 输入 + 双输出 material(COMFYTV_MATERIAL) +
	// image(COMFYTV_IMAGE)（此前 material 误用 TEXT、image 误用 IMAGE）。
	registerNodeSpec({
		type: 'ComfyTV.MaterialStage',
		kind: 'native',
		title: '材质',
		category: 'comfyMaterial',
		inputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'material', type: 'COMFYTV_MATERIAL' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('material-estimate')[0], options: workflowOptionsFor('material-estimate') },
			{ name: 'material_state', type: 'TEXT', default: '' },
		],
	});
	// P3 — 3D Scene (2.5D isometric MVP, browser-local capture).
	// ★ 对齐 ComfyTV scene3d.py：三输出 image + video + images（均为 COMFYTV_*）。
	registerNodeSpec({
		type: 'ComfyTV.Scene3DStage',
		kind: 'native',
		title: '3D 摆场',
		category: 'comfyScene3D',
		inputs: [],
		outputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
			{ name: 'video', type: 'COMFYTV_VIDEO' },
			{ name: 'images', type: 'COMFYTV_IMAGES' },
		],
		widgets: [
			{ name: 'width', type: 'INT', default: 1024 },
			{ name: 'height', type: 'INT', default: 1024 },
		],
	});
	// 多宫格故事板 — 网格宫格（2/4/6/9）漫画分格编辑器（browser-local）。
	// 每格独立描述（角色/动作/对白/图像提示），run 时拼 qwen 多宫格 prompt 单图直出
	// 整张多宫格合成图（workflowRun.runMultiPanelStoryboardNode → IMAGE_QWEN_2512_MULTI_PANEL）。
	// 内嵌编辑器 = MultiPanelStoryboardEditor；inputs 接上游故事提示词（text，可选）。
	registerNodeSpec({
		type: 'ComfyTV.MultiPanelStoryboardStage',
		kind: 'native',
		title: '多宫格故事板',
		category: 'comfyMultiPanel',
		inputs: [
			{ name: 'text', type: 'COMFYTV_TEXT' },
		],
		outputs: [
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			{ name: 'panels_state', type: 'TEXT', default: '' },
			{ name: 'width', type: 'INT', default: 1328 },
			{ name: 'height', type: 'INT', default: 1328 },
		],
	});
	// ── 表情包拆分为两个独立节点（2026-08-26）────────────────────────────────
	// 静态表情包：m×n 透明背景贴纸网格，主题预设作为 prompt 后缀（单一透明贴纸模板 + 风格）。
	// 动态表情包：参考图 → MiniMax H3 绿幕视频 → 前端抠图 → GIF 输出。
	// 两者均不在 comfyTVStageMeta.generated.ts（后端无此 stage），comfyTV 元数据显式声明。

	// StatEmojiStage — 静态表情包（m×n 透明背景贴纸网格）。
	// 主题预设（3D/Q版/手绘/Meme/漫画封/粘土/像素艺术/可爱风）作为 prompt 后缀注入。
	// variant='generator' → 有运行按钮；workflowKind='emoji' → 读 builtinWorkflows/emojiWorkflows。
	registerNodeSpec({
		type: 'ComfyTV.StatEmojiStage',
		kind: 'schema',
		title: '静态表情包',
		category: 'comfyTV',
		inputs: [
			// text = 单条文本输入（接 TextStage 输出作为表情描述）；
			// texts = 批量文本（逐格分配）；images = 参考图（slot 注入）。
			{ name: 'text', type: 'COMFYTV_TEXT' },
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'images', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			// images = m×n 表情批次；image = 当前选中格（selected_index）。
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('emoji')[0], options: workflowOptionsFor('emoji') },
			// 主题预设：作为 prompt 后缀的风格关键词（见 emojiWorkflows 的 SUFFIX 映射）。
			{ name: 'style_preset', type: 'COMBO', default: 'Q版', options: ['Q版', '3D', '手绘', 'Meme', '漫画封', '粘土', '像素艺术', '可爱风'] },
			{ name: 'rows', type: 'INT', default: 3, min: 1, max: 6 },
			{ name: 'cols', type: 'INT', default: 3, min: 1, max: 6 },
			{ name: 'prompt', type: 'TEXT', default: '' },
			{ name: 'cells', type: 'TEXT', default: '[]' },
			{ name: 'selected_index', type: 'INT', default: 0, min: 0, max: 35 },
			// run_scope：'all'（生成全部）| 'cell'（只跑 selected_index 一格）。
			// 由 StatEmojiStageEditor 在点击运行前写回，workflowRun.runEmojiStageGrid 消费。
			{ name: 'run_scope', type: 'TEXT', default: 'all' },
		],
		color: '#e879f9',
		comfyTV: { stageKind: 'emoji', workflowKind: 'emoji', variant: 'generator' },
	});

	// EmojiStaticStage — 静态表情包（8 主题预设，白底出图 → 抠图透明）。
	// 拆分自原 EmojiStage：静态分支独立成节点，widget.theme 选 8 主题之一，
	// workflow COMBO 限定为 EMOJI_BUILTIN_WORKFLOWS 里「静态·」前缀的模板。
	// 复用 runEmojiStageGrid 执行器（按 workflow 前缀分派静态链路）。
	registerNodeSpec({
		type: 'ComfyTV.EmojiStaticStage',
		kind: 'schema',
		title: '静态表情包',
		category: 'comfyTV',
		inputs: [
			{ name: 'text', type: 'COMFYTV_TEXT' },
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'images', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			// theme：8 主题预设（与 emojiWorkflows.EMOJI_STATIC_* 的 label 前缀对齐）。
			{ name: 'theme', type: 'COMBO', default: '3D', options: ['3D', 'Q版', '手绘', 'Meme', '漫画封', '粘土', '像素艺术', '可爱风'] },
			// workflow：限定静态模板（前端 EmojiStageEditor 会按 theme 选中对应 label）。
			{ name: 'workflow', type: 'COMBO', default: '静态·3D', options: workflowOptionsFor('emoji').filter((l: string) => l.startsWith('静态·')) },
			{ name: 'rows', type: 'INT', default: 3, min: 1, max: 6 },
			{ name: 'cols', type: 'INT', default: 3, min: 1, max: 6 },
			{ name: 'prompt', type: 'TEXT', default: '' },
			{ name: 'cells', type: 'TEXT', default: '[]' },
			{ name: 'selected_index', type: 'INT', default: 0, min: 0, max: 35 },
			{ name: 'run_scope', type: 'TEXT', default: 'all' },
		],
		color: '#f0abfc',
		comfyTV: { stageKind: 'emoji', workflowKind: 'emoji-static', variant: 'generator' },
	});
	// EmojiAnimatedStage — 动态表情包（绿幕链路：透明PNG → 贴绿底 → MiniMax H3 → 抠绿 → GIF）。
	// 拆分自原 EmojiStage：动态分支独立成节点，强制上游透明 PNG 参考图（贴绿底用 alpha），
	// 输出透明动态视频 + GIF（执行器末段 videoToGif 转 GIF）。
	registerNodeSpec({
		type: 'ComfyTV.EmojiAnimatedStage',
		kind: 'schema',
		title: '动态表情包',
		category: 'comfyTV',
		inputs: [
			// images = 上游透明 PNG（静态节点产物，必需，绿底合成依赖其 alpha）。
			{ name: 'images', type: 'COMFYTV_IMAGE' },
			{ name: 'text', type: 'COMFYTV_TEXT' },
			{ name: 'texts', type: 'COMFYTV_TEXT' },
		],
		outputs: [
			// video = 透明动态 mp4；image = 转码后的 GIF（供 <img> 播放）。
			{ name: 'video', type: 'COMFYTV_VIDEO' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			{ name: 'workflow', type: 'COMBO', default: '动态·绿幕', options: workflowOptionsFor('emoji').filter((l: string) => l.startsWith('动态·')) },
			{ name: 'duration_s', type: 'FLOAT', default: 3, min: 2, max: 15 },
			{ name: 'fps', type: 'INT', default: 24, min: 12, max: 30 },
			{ name: 'prompt', type: 'TEXT', default: '' },
			{ name: 'selected_index', type: 'INT', default: 0, min: 0, max: 35 },
			{ name: 'run_scope', type: 'TEXT', default: 'all' },
		],
		color: '#c084fc',
		comfyTV: { stageKind: 'emoji', workflowKind: 'emoji-animated', variant: 'generator' },
	});
	// VideoToGifStage — 视频转 GIF（浏览器本地执行，见 videoToGif.ts 顶部注释：
	// ComfyTV 无 gif stage，本机 ComfyUI 也只有 SaveAnimatedWEBP/PNG）。
	// variant='transform' → 无「生成」语义的运行按钮，改由 ACTIONS/参数变更驱动；
	// 输出 kind='image' → GIF 用 <img> 播放动图（标 video 会被 <video> 播成黑框）。
	// 同 EmojiStage：不在 comfyTVStageMeta.generated.ts，comfyTV 元数据显式声明。
	registerNodeSpec({
		type: VIDEO_TO_GIF_TYPE,
		kind: 'schema',
		title: '视频转 GIF',
		category: 'comfyTV',
		inputs: [
			{ name: 'input', type: 'COMFYTV_VIDEO' },
		],
		outputs: [
			{ name: 'output', type: 'COMFYTV_IMAGE' },
		],
		widgets: VIDEO_TO_GIF_WIDGETS,
		color: '#22d3ee',
		comfyTV: { stageKind: 'video', workflowKind: 'video', variant: 'transform' },
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
