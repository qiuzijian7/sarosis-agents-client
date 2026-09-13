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
import { registerSchemaLiteGraphNode, FLOW_SLOT_LABEL } from './schemaLiteGraphNodes.js';
import { COMFYTV_STAGE_META } from './comfyTVStageMeta.generated.js';
import { COMFYTV_FX_FIELDS } from './comfyTVFxFields.generated.js';
import { listBuiltinLabels } from './builtinWorkflows/index.js';
import { EMOJI_SHEET_SIZES, EMOJI_SHEET_SIZE_DEFAULT } from './builtinWorkflows/emojiWorkflows.js';
import { isFxBuildNode } from './fxChain.js';
import { VIDEO_TO_GIF_TYPE, VIDEO_TO_GIF_WIDGETS } from './videoToGif.js';
import { REMOVE_BG_TYPE, REMOVE_BG_WIDGETS } from './removeBg.js';

export type NodeKind = 'react' | 'schema' | 'native' | 'llm';

/** Which execution backend a node maps to (drives runNodeOrStage routing). */
export type BackendKind = 'comfy' | 'provider';

/** Provider capability a node requires (llm nodes filter by provider caps). */
export type ProviderCaps = 'imageGen' | 'videoGen' | 'modelGen' | 'chat' | 'audioGen';

/**
 * 微信表情包素材三规格（单一事实源：nodeCard 的 exportTarget→size 联动 +
 * workflowRun 的导出执行共用）。
 *  聊天页图标  50×50   PNG ≤100KB（透明背景）
 *  表情封面图 240×240  PNG ≤500KB（透明背景）
 *  详情页横幅 750×400  JPG ≤500KB（避免透明背景 → 白底）
 */
export const WEIXIN_EXPORT_TARGETS: Record<string, { w: number; h: number; mime: string; maxBytes: number }> = {
	'聊天页图标': { w: 50, h: 50, mime: 'image/png', maxBytes: 100 * 1024 },
	'表情封面图': { w: 240, h: 240, mime: 'image/png', maxBytes: 500 * 1024 },
	'详情页横幅': { w: 750, h: 400, mime: 'image/jpeg', maxBytes: 500 * 1024 },
};

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
export function workflowOptionsFor(kind: string): string[] {
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

export const registry = new Map<string, RegisteredNode>();
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
	// ★ W7-flow：bridge(schema)/provider(llm) 节点尾部注入隐形 FLOW 控制口
	//   （flowIn/flowOut）。「从 Start 开始」要求任何待执行节点都能挂进 Start
	//   可达链，而数据端口类型（COMFYTV_*/TEXT/IMAGE…）不承载控制语义 —— FLOW
	//   口是纯控制通道：锚点渲染在 title 两侧（schemaLiteGraphNodes 设 slot.pos，
	//   LiteGraph 原生折叠分支天然兼容）、连线青色虚线、不进执行器数据上游。
	//   在唯一入口注入 → stage 注册循环 / refineStage 覆盖 / defineNode 全量
	//   形态三条路径都自动覆盖；react（已有 SAROS_JSON in/out 复用为控制口）与
	//   native（ComfyUI 契约，端口来自 /object_info）不注入。
	//   幂等：尾部已是 FLOW 口（refineStage 重注册携带旧注入结果）则跳过。
	if (spec.kind === 'schema' || spec.kind === 'llm') {
		const lastIn = spec.inputs?.[spec.inputs.length - 1];
		const lastOut = spec.outputs?.[spec.outputs.length - 1];
		spec = {
			...spec,
			inputs: lastIn?.type === FLOW_PORT_TYPE
				? spec.inputs
				: [...(spec.inputs ?? []), { name: FLOW_IN_PORT, type: FLOW_PORT_TYPE, required: false }],
			outputs: lastOut?.type === FLOW_PORT_TYPE
				? spec.outputs
				: [...(spec.outputs ?? []), { name: FLOW_OUT_PORT, type: FLOW_PORT_TYPE, required: false }],
		};
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
	outputs?: Array<{ name?: string; type?: unknown; label?: string; links?: Array<number> | null }>;
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
 * ★ 例外：**outputs 的尾部收缩**（2026-09-08）。spec 移除尾部输出端口（如
 *   Start.text 下线）时，老节点残留端口按上面的长度守卫会**永远残留**。尾部
 *   pop 不改变保留端口的下标（连线寻址安全），前提是前缀名字与 spec 完全一致
 *   （防其他 spec 演进形态误删）；被删端口的连线经可选 `graph.removeLink` 断开。
 *
 * @param graph 可选：断开被收缩端口的连线（LiteGraph `graph.removeLink(id)`）。
 * @returns 是否发生了修改（调用方据此决定要不要重绘）。
 */
export function syncNodePortsToSpec(
	node: PortBearingNode,
	graph?: { removeLink?(id: number): unknown },
): boolean {
	const spec = node.type ? getNodeSpec(node.type) : undefined;
	if (!spec) { return false; }
	let changed = false;
	const sync = (
		live: Array<{ name?: string; type?: unknown; label?: string; links?: Array<number> | null }> | undefined,
		want: ReadonlyArray<{ name: string; type: string }> | undefined,
		kind: 'inputs' | 'outputs',
	): void => {
		if (!live || !want) { return; }
		if (live.length > want.length && kind === 'outputs') {
			// 尾部收缩：前 want.length 个名字必须与 spec 一致才执行
			let prefixOk = true;
			for (let i = 0; i < want.length; i++) {
				if (live[i]?.name !== want[i].name) { prefixOk = false; break; }
			}
			if (prefixOk) {
				for (let i = want.length; i < live.length; i++) {
					for (const lid of (live[i].links ?? [])) {
						try { graph?.removeLink?.(lid); } catch { /* link 已断，忽略 */ }
					}
				}
				live.length = want.length;
				changed = true;
			}
			return;
		}
		if (live.length !== want.length) { return; }
		for (let i = 0; i < live.length; i++) {
			const slot = live[i];
			const def = want[i];
			if (slot.name !== def.name) { slot.name = def.name; changed = true; }
			// label 是 LiteGraph 实际绘制的文字（addInput 时传的 { label }）。
			// 只改 name 不改 label，画布上仍然显示旧名字。
			// ★ W7-flow：FLOW 控制口的 label 必须保持 FLOW_SLOT_LABEL（空格）。
			//   它锚在 title 两侧，label 文字会叠在标题上；而**空串不行**——
			//   LiteGraph `renderingLabel = label || localized_name || name || ''`
			//   用的是 `||`，空串 falsy 会回退到 name（'flowIn'）继续画（实测两次
			//   返工的真因）。另：此前这里无条件写 def.name，每帧把 constructor
			//   设的值改回 'flowIn' → 文字复活，故 FLOW 口需按类型分流。
			const wantLabel = def.type === FLOW_PORT_TYPE ? FLOW_SLOT_LABEL : def.name;
			if (slot.label !== undefined && slot.label !== wantLabel) { slot.label = wantLabel; changed = true; }
			if (typeof slot.type === 'string' && slot.type !== def.type) { slot.type = def.type; changed = true; }
		}
	};
	sync(node.inputs, spec.inputs, 'inputs');
	sync(node.outputs, spec.outputs, 'outputs');
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
 *
 *  ★ W7-flow：`FLOW` 是控制流专用类型 —— 只能与 FLOW 相连（**不与 ANY 互通**），
 *  防止把控制线误插进数据口（ANY 通配会把 FLOW 吞掉）。控制流不携带媒体快照，
 *  数据口连接语义完全不受影响。
 */
export function isPortTypeCompatible(a: PortType, b: PortType): boolean {
	if (a === FLOW_PORT_TYPE || b === FLOW_PORT_TYPE) { return a === b; }
	if (a === b) { return true; }
	if (a === 'ANY' || b === 'ANY') { return true; }
	return false;
}

/** 控制流端口类型（title 侧锚点、青色虚线连线；见 registerNodeSpec 注入逻辑）。 */
export const FLOW_PORT_TYPE = 'FLOW';
/** 控制流端口名（LiteGraph slot 名 = store 边的 sourceHandle/targetHandle）。 */
export const FLOW_IN_PORT = 'flowIn';
export const FLOW_OUT_PORT = 'flowOut';
/** 控制流视觉色（title 锚点 pin + 虚线连线统一用青色）。 */
export const FLOW_COLOR = '#22d3ee';

/**
 * 是否为「参与控制流的端口类型」：FLOW 显式控制口，以及编排节点复用为控制
 * 通道的 SAROS_JSON / ANY 口。这些类型的**边**在画布上渲染为青色虚线
 * （`isFlowLinkType`），且 FLOW 边不进入执行器的数据上游（upstreams）。
 */
export function isFlowPortType(t: string | undefined): boolean {
	return t === FLOW_PORT_TYPE || t === 'SAROS_JSON' || t === 'ANY';
}

/** 按 link 两端类型判定是否控制流边（渲染虚线用）。 */
export function isFlowLinkType(srcType: string | undefined, dstType: string | undefined): boolean {
	return isFlowPortType(srcType) && isFlowPortType(dstType);
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
 * 系统级入口/出口锚点 —— 跨层 gate 对其豁免（W7）。
 *
 * 为什么必须豁免：「运行 = 从 Start 开始」要求任何要执行的节点都能挂到 Start 的
 * 可达链上。若 Start/End 仍受 orchestration↔media 禁连约束，用户就无法把 Start
 * 接到原生 ComfyUI 节点（media 层）→ 那条链永远在作用域外、永远不执行。
 * Start/End 不做数据变换（Start 只提供 args 契约、End 只透传标记输出），把它们
 * 当「必须经 bridge 中转」的普通编排节点是过度约束。
 */
const LAYER_GATE_EXEMPT_TYPES = new Set(['Saros.Start', 'Saros.End']);

/**
 * Cross-layer connection gate. Orchestration nodes must NOT connect directly
 * to media nodes (and vice-versa) — they must go through a bridge (schema /
 * ComfyTV stage). Everything else is allowed, including intra-layer links.
 *
 * `srcType` / `dstType` 可选：传入时对系统入口/出口锚点（Saros.Start /
 * Saros.End）豁免跨层限制（W7，见 LAYER_GATE_EXEMPT_TYPES）。不传 = 旧行为。
 * Pure, unit-testable without LiteGraph.
 */
export function canConnectLayers(
	srcKind: NodeKind,
	dstKind: NodeKind,
	srcType?: string,
	dstType?: string,
): boolean {
	if (LAYER_GATE_EXEMPT_TYPES.has(srcType ?? '') || LAYER_GATE_EXEMPT_TYPES.has(dstType ?? '')) {
		return true;
	}
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
	// ★ Saros.Start 已移出（2026-09-09）：卡片零参数 UI 后 Start 与 End 对称，
	//   走纯 canvas 渲染（DOM 富卡 overlay 会把 Start 撑高到 ~150px，
	//   与 End 的纯标题+端口高度不一致）。
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
	// ★ Saros.AskUser 已移出（2026-09-11，多问题重构）：它的参数已收敛为嵌套的
	//   `data.questions`（多问题 × 每问题独立模式/选项/参数），扁平 DOM 控件无法
	//   表达 → spec.widgets 清空、编辑统一走弹窗。此时留在富卡集合里会**双向失效**：
	//   ① 富卡分支按 `meta.controls` 逐行渲染控件（现为空 → 一片空白）
	//   ② 该分支还会**抑制摘要**（nodeCard `!isOrchRich && meta.widgetSummary`）
	//   → 卡片既无控件也无「问题列表=N 个」摘要。移出后走普通 react 卡片：
	//   摘要由 sarosFieldSummary 的 questions 分支给出，信息不丢。
]);

// -- 节点注册聚合（2026-09-07 拆分）：各功能域注册封装在子模块的 registerXxxNodes()
//    内，此处核心初始化完成后依次调用——注册时序与原单文件完全一致。子模块通过
//    ESM live binding 引用本文件的 registerNodeSpec/常量（调用时均已初始化）。
import { registerSarosNodes } from './registrySaros.js';
import { registerProviderGenNodes } from './registryProviderGen.js';
import { registerComfyStageNodes } from './registryComfyStages.js';
import { registerEmojiNodes } from './registryEmoji.js';
import { registerToolNodes, normalizePortType } from './registryTools.js';

// ── 注册入口 re-export（外部消费方兼容）：LiteGraphCanvas / comfyObjectInfoLoader /
//    WorkflowEditorPanel 等从 './registry' import 这些入口——拆分后实现移至子模块，
//    此处原样转发（幂等，可重复调用）。
export { registerSarosNodes, registerComfyUINativeNode } from './registrySaros.js';
export { registerDefaultComfyTVStages } from './registryComfyStages.js';

registerSarosNodes();
registerProviderGenNodes();
registerComfyStageNodes();
registerEmojiNodes();
registerToolNodes();
