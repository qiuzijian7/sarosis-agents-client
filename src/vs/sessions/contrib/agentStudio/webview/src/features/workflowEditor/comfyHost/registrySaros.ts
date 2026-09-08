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
import {
	registerNodeSpec,
	SAROS_NODE_COLORS,
	workflowOptionsFor,
	WEIXIN_EXPORT_TARGETS,
	COMFYTV_RESOLUTIONS,
	COMFYTV_ASPECT_RATIOS,
	COMFYTV_IMAGE_WORKFLOWS,
	type PortSpec,
	type NodeSpec,
	type PortType,
	type NodeKind,
} from './registry.js';
import { INSTANT_WIDGETS } from './instantNodes.js';
import { registry } from './registry.js';
import { normalizeNativeType } from './registryTools.js';
import { COMFYTV_STAGE_META } from './comfyTVStageMeta.generated.js';
import { COMFYTV_FX_FIELDS } from './comfyTVFxFields.generated.js';
import { listBuiltinLabels } from './builtinWorkflows/index.js';
import { EMOJI_SHEET_SIZES, EMOJI_SHEET_SIZE_DEFAULT } from './builtinWorkflows/emojiWorkflows.js';

/**
 * Saros 编排节点（Start/End/Task/Prompt/Agent/Skill/Tool/Subflow/ProviderPicker）。
 * 拆自 registry.ts（2026-09-07）：注册副作用封装在函数内，由 registry.ts 在核心
 * 初始化完成后显式调用（规避 ESM 循环 import 的 TDZ/时序问题）。
 */
export function registerSarosNodes(): void {
	// -- Saros 编排节点（Start/End/Task/Prompt/Agent/Skill/Tool/Subflow/ProviderPicker） --
		// 端口命名：通用数据端口 in/out（原来都叫 value，Agent 左右同名无语义）。
	// 分支端口名（true/false/case-N/default）不可改：executionGraph.isEdgeActive 按其路由。
	// 此处 spec 是端口名权威：syncNodePortsToSpec 每帧同步，须与 sarosLiteGraphNodes 的 NODE_CONFIGS 同名同数。
const jin = (required: boolean = true): PortSpec => ({ name: 'in', type: 'SAROS_JSON', required });
	const jout = (required: boolean = false): PortSpec => ({ name: 'out', type: 'SAROS_JSON', required });
	registerNodeSpec({ type: 'Saros.Start', kind: 'react', title: '开始', category: 'system', inputs: [], outputs: [
		{ name: 'out', type: 'SAROS_JSON', required: false },
		// 2026-09-08：移除 text 输出端口（用户要求卡片零参数 UI）。
		// 原「COMFYTV_TEXT 桥」（args.text 直连 stage prompt）随端口下线；
		// args 数据仍经 out 口 SAROS_JSON 与运行前参数面板消费。
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

	// -- Saros 控制流节点（IfElse/Merge/Loop/Parallel/Switch/AskUser/Group） --
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
		// ★ 动态参数表单（JSON 数组 [{key,label,type}]，type ∈ text/number/textarea）：
		//   非空时交互卡片渲染**输入框**而非选项按钮，用户填写后以键值对象反馈
		//   （answer = {key: value, ...}，SAROS_JSON 快照）。options 可为空。
		{ name: 'params', type: 'TEXT', default: '[]' },
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
	// ★ 函数尾（2026-09-07 拆分回迁）：注册调用原在文件后段，拆分时被切到
	//   registryComfyStages 段首——回迁到宿主函数内。
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
