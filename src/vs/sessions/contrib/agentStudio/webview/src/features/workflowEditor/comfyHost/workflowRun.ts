/*---------------------------------------------------------------------------------------------
 *  workflowRun — run a whole workflow graph through the Comfy runners (P0).
 *
 *  Executes every executable node in topological order (upstream first) so
 *  media outputs land in the shared snapshot store before their downstream
 *  consumers run. Execution stops on the first failure (the failing card shows
 *  an error banner; the caller surfaces the reason in the toolbar).
 *
 *  Pure helper `isComfyExecutableSpec`; the async `runGraphExecution` performs
 *  IO only through injected runner / snapshot store / card store — testable
 *  with fakes.
 *--------------------------------------------------------------------------------------------*/

import type { IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { CardStateStore } from './cardState.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { runSingleNode, comfyOutputsToFxSnapshots } from './nodeExecutor.js';
import { runStageWorkflow, StageWorkflowUnavailableError } from './stageWorkflowExecutor.js';
import { getPluginNodeRunner } from './pluginLoader.js';
import { isFxNode, isFxChainNode } from './fxChain.js';
import type { MediaSnapshotEntry, MediaKind, MediaRef } from './mediaSnapshot.js';
import { mediaGet, resolveAssetUrl } from '../mediaAssets.js';
import { isInstantNode } from './instantNodes.js';
import { runInstantNode } from './instantExecutor.js';
import { isRelightNode } from './relightEditor.js';
import { runRelightNode } from './relightExecutor.js';
import { isPosterNode } from './posterEditor.js';
import { runPosterNode } from './posterExecutor.js';
import { isLayerEditorNode } from './layerEditor.js';
import { runLayerEditorNode } from './layerExecutor.js';
import { isStoryboardEditorNode } from './storyboardEditor.js';
import { runStoryboardEditorNode } from './storyboardExecutor.js';
import { isMaterialNode } from './materialEditor.js';
import { runMaterialNode } from './materialExecutor.js';
import { isScene3DNode } from './scene3dEditor.js';
import { runScene3DNode } from './scene3dExecutor.js';
import { parseSize, findUpstreamImageRef } from './imageGenBackend.js';
import { isComfyViewRef, resolveLoadImageImageRef, type BridgeFetchLike } from './imageGenToComfyBridge.js';
import { buildExecutionPlan, buildParallelExecutionPlan, computeExecutionOrder, computeInactiveNodes, type ExecutionNodeLike, type ExecutionEdgeLike } from './executionGraph.js';
import type { SubflowDefinition } from './subflow.js';
import { resolveNodeMentions, createStoreLookup } from './nodeMentions.js';
import { flattenSubflows } from './subflow.js';
import { overlayTextOnImage, isAnimatedWebpRef } from './emojiTextOverlay.js';

/** A registered ComfyTV stage's extra metadata. */
export interface ComfyTVSpecMeta {
	kind?: string;
	workflowKind?: string;
}

/** Store node with optional editor data (Prompt 节点的 text 等). */
export interface RunNode extends ExecutionNodeLike {
	data?: Record<string, unknown>;
}

/**
 * A node spec kind is executable when it maps to a Comfy class_type.
 * Saros orchestration nodes (kind 'react') and unregistered nodes are skipped.
 */
export function isComfyExecutableSpec(spec: { kind?: string } | undefined): boolean {
	return spec?.kind === 'schema' || spec?.kind === 'native';
}

/**
 * A node participates in workflow Run when it maps to a Comfy class_type OR a
 * provider backend (kind 'llm'). Provider nodes execute through the injected
 * `sendImageGen` RPC instead of a ComfyUI runner.
 */
export function isExecutableSpec(spec: { kind?: string } | undefined): boolean {
	return isComfyExecutableSpec(spec) || spec?.kind === 'llm';
}

/**
 * M3 dynamic workflow: `Saros.Agent` orchestration node. Executed via the
 * injected `runAgentNode` RPC (browser-side startWorkflowChild bridge) —
 * the node's prompt (with {{input}} = upstream JSON) goes to one subagent
 * whose result is archived as a SAROS_JSON snapshot on this node.
 * (Type-keyed: plan callbacks receive the node TYPE, not the spec.)
 */
export function isAgentNodeType(type: string): boolean {
	return type === 'Saros.Agent';
}

/** M3: `Saros.Prompt` — pure text materialization node (local, no backend). */
export function isPromptNodeType(type: string): boolean {
	return type === 'Saros.Prompt';
}

/** M3: `Saros.IfElse` / `Saros.Switch` — verdict gate nodes (local JSON evaluation). */
export function isGateNodeType(type: string): boolean {
	return type === 'Saros.IfElse' || type === 'Saros.Switch';
}

/** W1: `Saros.Start` — 工作流输入契约节点（args 定义，见 doc/workflow-hybrid-controlflow-analysis.md §3 W1）。 */
export function isStartNodeType(type: string): boolean {
	return type === 'Saros.Start';
}

/** W3: `Saros.Merge` — 分支合流汇聚节点（all 模式：聚合各入边快照为 {inA,inB}）。 */
export function isMergeNodeType(type: string): boolean {
	return type === 'Saros.Merge';
}

/** W5: `Saros.Loop` / `Saros.Parallel` — 迭代子图容器节点（执行时语义，不走 flatten）。 */
export function isLoopNodeType(type: string): boolean {
	return type === 'Saros.Loop' || type === 'Saros.Parallel';
}

/** P0: `Saros.Task` — 复用 Agent 执行通道的原子子任务节点（prompt + 可选 agentId）。 */
export function isTaskNodeType(type: string): boolean {
	return type === 'Saros.Task';
}

/** P0: `Saros.End` — 工作流输出标记：透传上游快照并标记为图最终输出。 */
export function isEndNodeType(type: string): boolean {
	return type === 'Saros.End';
}

/** P0: `Saros.Skill` — 让子代理加载并执行指定技能（复用 runAgentNode 通道）。 */
export function isSkillNodeType(type: string): boolean {
	return type === 'Saros.Skill';
}

/** P0: `Saros.Tool` — 让子代理调用指定工具并返回结果（复用 runAgentNode 通道）。 */
export function isToolNodeType(type: string): boolean {
	return type === 'Saros.Tool';
}

/** P1: `Saros.AskUser` — 交互节点：暂停并弹窗收集用户选择，结果归档为 {answer}。 */
export function isAskUserNodeType(type: string): boolean {
	return type === 'Saros.AskUser';
}

/**
 * W1: collect Start-node args — the whole-graph input contract. Start 节点
 * data.args（JSON 字符串或对象）被解析为全局 args 上下文；图内任意
 * Prompt/Agent 模板可用 `{{args.key}}`（支持点路径）引用。多个 Start 时
 * 后解析者合并覆盖（浅合并）。Pure。
 */
export function collectStartArgs(nodes: RunNode[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const n of nodes) {
		if (!isStartNodeType(n.type ?? '')) { continue; }
		const raw = (n.data as Record<string, unknown> | undefined)?.args;
		if (typeof raw === 'string') {
			try { Object.assign(out, JSON.parse(raw) as Record<string, unknown>); } catch { /* 非法 JSON 忽略（卡片上另有校验） */ }
		} else if (raw && typeof raw === 'object') {
			Object.assign(out, raw as Record<string, unknown>);
		}
	}
	return out;
}

/**
 * W1/W4: 通用模板占位符解析（Pure）：
 *   `{{input}}`     第一上游快照（兼容语义不变）
 *   `{{args.a.b}}`  Start 输入契约（点路径）
 *   `{{标签}}` / `{{标签.field}}`  W4 具名引用——按节点 label 解析快照
 *     （ctx.named 由调度器提供：label → 归档键 → store 快照文本；label
 *     重名取首个；未解析到的占位符原样保留）。
 */
export function resolveTemplateVars(
	template: string,
	ctx: { input?: string; args?: Record<string, unknown>; named?: (label: string) => string | undefined },
): string {
	let out = template;
	if (ctx.input !== undefined && out.includes('{{input}}')) {
		out = out.split('{{input}}').join(ctx.input);
	}
	// {{input.path}} —— 对上游快照做点路径取值（JSON 解析后逐段 probe）
	if (ctx.input !== undefined && out.includes('{{input.')) {
		let parsed: unknown = ctx.input;
		try { parsed = JSON.parse(ctx.input); } catch { parsed = ctx.input; }
		out = out.replace(/\{\{input\.([A-Za-z0-9_.]+)\}\}/g, (whole, path: string) => {
			let probe: unknown = parsed;
			for (const seg of path.split('.')) {
				if (typeof probe !== 'object' || probe === null) { return whole; }
				probe = (probe as Record<string, unknown>)[seg];
			}
			return probe === undefined || probe === null ? whole : String(probe);
		});
	}
	if (ctx.args && Object.keys(ctx.args).length > 0 && out.includes('{{args.')) {
		out = out.replace(/\{\{args\.([A-Za-z0-9_.]+)\}\}/g, (whole, path: string) => {
			let probe: unknown = ctx.args;
			for (const seg of path.split('.')) {
				if (typeof probe !== 'object' || probe === null) { return whole; }
				probe = (probe as Record<string, unknown>)[seg];
			}
			return probe === undefined || probe === null ? whole : String(probe);
		});
	}
	// W4: 一般占位符 {{label}} / {{label.a.b}}（排除 input / args.* 前缀）
	if (ctx.named && out.includes('{{')) {
		out = out.replace(/\{\{([^{}]+)\}\}/g, (whole, name: string) => {
			if (name === 'input' || name.startsWith('args.')) { return whole; }
			if (!/^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5 \-]*$/.test(name)) { return whole; }
			const dot = name.indexOf('.');
			const label = (dot === -1 ? name : name.slice(0, dot)).trim();
			const path = dot === -1 ? '' : name.slice(dot + 1).trim();
			const text = ctx.named!(label);
			if (text === undefined) { return whole; }
			let probe: unknown;
			try { probe = JSON.parse(text); } catch { probe = text; }
			if (path) {
				for (const seg of path.split('.')) {
					if (typeof probe !== 'object' || probe === null) { return whole; }
					probe = (probe as Record<string, unknown>)[seg];
				}
				return probe === undefined || probe === null ? whole : String(probe);
			}
			// 无路径：对象快照透传原文（String(obj) 会得到 [object Object]）
			return probe !== null && typeof probe === 'object' ? text : String(probe);
		});
	}
	return out;
}

/** Provider image-gen node (e.g. Saros.ModelImageGen).
 *
 * Matches both legacy kind 'llm' specs and schema-styled provider nodes
 * (kind 'schema' + backendKind 'provider', since 2026-08-12 the node is
 * rendered like a ComfyTV Image Stage but still executes via the provider
 * RPC — never a ComfyUI runner). */
export function isLLMImageNode(spec: { kind?: string; backendKind?: string } | undefined): boolean {
	return spec?.kind === 'llm' || (spec?.kind === 'schema' && spec?.backendKind === 'provider');
}

/** Provider Picker node (Saros.ProviderPicker): local, no RPC — emits a TEXT config. */
export function isProviderPickerNode(type: string): boolean {
	return type === 'Saros.ProviderPicker';
}

/** TEXT config ref emitted by a Provider Picker ("providerId:modelId"). */
export const PROVIDER_PICKER_PREFIX = 'provider:';

/**
 * Parse a Provider Picker TEXT config ("provider:providerId:modelId") from an
 * upstream snapshot. Pure — shared by the canvas Run and editor popup so an
 * image-gen node can consume an explicit picker without opening its own editor.
 */
export function parseProviderPickerConfig(text: string | undefined): { providerId: string; modelId: string } | undefined {
	if (!text || !text.startsWith(PROVIDER_PICKER_PREFIX)) { return undefined; }
	const rest = text.slice(PROVIDER_PICKER_PREFIX.length);
	const sep = rest.indexOf(':');
	if (sep < 0) { return undefined; }
	const providerId = rest.slice(0, sep);
	const modelId = rest.slice(sep + 1);
	return providerId && modelId ? { providerId, modelId } : undefined;
}

/** First upstream Provider Picker TEXT config, if any. Pure. */
export function collectUpstreamProviderConfig(
	store: MediaSnapshotStore,
	upstreams: string[] | undefined,
): { providerId: string; modelId: string } | undefined {
	for (const id of upstreams ?? []) {
		for (const entry of store.byNode(id)) {
			// Picker emits kind 'text'; older snapshots may normalize to 'unknown'.
			if ((entry.media.kind === 'text' || entry.media.kind === 'unknown') && typeof entry.media.ref === 'string') {
				const cfg = parseProviderPickerConfig(entry.media.ref);
				if (cfg) { return cfg; }
			}
		}
	}
	return undefined;
}

/**
 * Collect text values from upstream orchestration nodes that a media stage can
 * consume. Pure. First non-empty prompt wins.
 *   * Saros.Prompt 节点 → `data.prompt` feed stage 的 prompt 输入
 *   * Saros.Start 节点 → `args.text` 或 `args.prompt` 字段 feed stage 的 prompt
 *     （COMFYTV_TEXT 桥：Start 直连 ComfyTV stage 无需经 Prompt 中转）
 */
export function collectOrchestrationValues(
	nodes: RunNode[],
	upstreams: string[] | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!upstreams) { return out; }
	for (const id of upstreams) {
		const node = nodes.find(n => n.id === id);
		const data = node?.data;
		if (!node || !data) { continue; }
		// ★ 修复：原匹配小写 'prompt'（ReactFlow 遗留），实际 RunNode.type 是
		//   'Saros.Prompt' 全名 —— Prompt→stage 文本注入此前已静默失配。
		if (isPromptNodeType(node.type ?? '') && out.prompt === undefined) {
			const text = data.prompt;
			if (typeof text === 'string' && text.length > 0) { out.prompt = text; }
		}
		// Start → COMFYTV_TEXT 桥：约定 args.text（优先）或 args.prompt 字段
		if (isStartNodeType(node.type ?? '') && out.prompt === undefined) {
			const raw = data.args;
			let args: Record<string, unknown> = {};
			if (typeof raw === 'string') {
				try { args = JSON.parse(raw) as Record<string, unknown>; } catch { args = {}; }
			} else if (raw && typeof raw === 'object') {
				args = raw as Record<string, unknown>;
			}
			const text = (args.text ?? args.prompt);
			if (typeof text === 'string' && text.length > 0) { out.prompt = text; }
		}
	}
	return out;
}

/**
 * 把一组上游 nodeId 映射成**快照归档键**（stageUid）。
 * 解析器缺省或某节点没有 uid 时该项原样保留 nodeId（向后兼容旧工作流）。
 */
function mapSnapshotKeys(
	upstreams: string[] | undefined,
	snapshotKeyOf: ((nodeId: string) => string | undefined) | undefined,
): string[] | undefined {
	if (!upstreams || !snapshotKeyOf) { return upstreams; }
	return upstreams.map(id => snapshotKeyOf(id) ?? id);
}

export interface GraphRunOptions {
	nodes: RunNode[];
	edges: ExecutionEdgeLike[];
	/** resolve the spec for a node type (from the node registry) */
	getSpec: (type: string) => { kind?: string; backendKind?: string; comfyTV?: ComfyTVSpecMeta } | undefined;
	/** resolve the runner to use; undefined when nothing is connected */
	resolveRunner: () => IComfyRunner | undefined;
	snapshotStore: MediaSnapshotStore;
	cardState: CardStateStore;
	/** optional persisted form values per node id (double-click editor) */
	nodeValues?: Record<string, Record<string, unknown>>;
	/** called before each node starts (canvas can highlight it) */
	onNodeStart?: (step: { id: string; type: string }) => void;
	signal?: AbortSignal;
	/** provider image-gen RPC — required when the graph contains llm nodes */
	sendImageGen?: ImageGenSendFn;
	/** M3: Saros.Agent node RPC — required when the graph contains agent nodes */
	runAgentNode?: AgentNodeSendFn;
	/** P1: Saros.AskUser 交互 RPC — required when the graph contains ask-user nodes */
	askUser?: AskUserSendFn;
	/** auto-route provider/model when a node has none set */
	resolveImageGenDefaults?: () => Promise<{ providerId: string; modelId: string } | undefined>;
	/** provider→Comfy LoadImage bridge (optional; defaults to global fetch + runner) */
	resolveLoadImageRef?: (ref: string) => Promise<{ ok: boolean; image?: string; error?: string }>;
	/**
	 * Execution mode (docs/Agent-画布编排设计方案.md P1):
	 *  - 'serial'  (default) — current behavior, stop on first failure.
	 *  - 'parallel' — run independent steps concurrently within each topological
	 *    layer (barrier between layers). Provider/local steps share a concurrency
	 *    pool; Comfy backend steps are serialized (ComfyUI queue is inherently
	 *    serial) via the `comfySlots` pool.
	 */
	mode?: 'serial' | 'parallel';
	/** Max parallel provider/local steps when mode='parallel' (default 4). */
	parallelConcurrency?: number;
	/** Stable identifier for the run (cross-session task tracking, P1). */
	taskId?: string;
	/** Injectable fetch (proxy for ComfyUI localhost 403 bypass); instant nodes use it. */
	fetchImpl?: typeof fetch;
	/**
	 * nodeId → 快照归档键（stageUid）解析器。由画布层注入
	 * （`LiteGraphCanvas.stageUidOf`）。
	 *
	 * ★ 为什么图执行必须要它：卡片读快照用 stageUid，若全图 Run 仍按 nodeId 归档，
	 *   就是「写 nodeId、读 uid」→ 运行成功但 OUTPUT 永不刷新（静默）。
	 *   同时**上游键也要映射**：`store.byNode(upstream)` 查的是归档键，
	 *   传 nodeId 会让下游节点拿不到上游刚生成的图。
	 *   缺省（未注入 / 该节点无 uid）时回退 nodeId，行为与旧版一致。
	 */
	snapshotKeyOf?: (nodeId: string) => string | undefined;
	/**
	 * W1b: Start 运行时参数覆盖 —— 用户在参数面板填写的值（key→value），
	 * 浅合并到 collectStartArgs 的结果之上（运行时覆盖 > 节点默认值）。
	 * 面板取消时传入 undefined，不弹窗 / 无 Start 节点时同样不传。
	 */
	startArgsOverride?: Record<string, unknown>;
}

export interface GraphRunResult {
	success: boolean;
	/** true when the graph has a cycle → nothing ran */
	hasCycle: boolean;
	/** node ids that completed successfully */
	ran: string[];
	/** W2 端口感知路由：被跳过的节点（gate 分支未激活 + 传导下游），非错误 */
	skippedIds: string[];
	/** the first failing node (null when all ran) */
	failed: { nodeId: string; error: string } | null;
	/** per-node results of successful runs */
	results: Record<string, SingleNodeRunResult>;
	/** stable run id (P1, task tracking) */
	taskId?: string;
	/** execution mode actually used */
	mode?: 'serial' | 'parallel';
	/** per-layer run stats (parallel mode) */
	layerStats?: { layer: number; total: number; ran: number; failed: number }[];
}

/** Progress callback accepted by both runSingleNode and runStageWorkflow. */
export type RunProgress = (p: { progress?: number; value?: number }) => void;

/** M3: `workflow.runAgentNode` RPC payload (Saros.Agent node execution). */
export interface AgentNodePayload {
	prompt: string;
	agentId?: string;
	/** optional model override (agentConfig.modelId) */
	model?: string;
	label?: string;
}

/** M3: `workflow.runAgentNode` RPC result. */
export interface AgentNodeRunResult {
	ok: boolean;
	/** final subagent text (no schema on canvas nodes in M3) */
	output?: string;
	error?: string;
}

/** M3: injected RPC for Saros.Agent nodes (required when the graph has one). */
export type AgentNodeSendFn = (payload: AgentNodePayload, timeoutMs?: number) => Promise<AgentNodeRunResult>;

/** P1: Saros.AskUser 交互请求载荷（renderer 侧弹窗收集用户输入）。 */
export interface AskUserPayload {
	nodeId: string;
	question: string;
	options: Array<{ label: string; description?: string }>;
	multiSelect: boolean;
}
/** P1: injected ask-user RPC for Saros.AskUser nodes (required when the graph has one). */
export type AskUserSendFn = (payload: AskUserPayload, timeoutMs?: number) => Promise<string | string[]>;

export interface NodeExecutionInput {
	runner: IComfyRunner;
	nodeId: string;
	/**
	 * 快照归档键（= stageUid）。缺省回退 nodeId。
	 * 见 stageWorkflowExecutor.StageWorkflowRunOptions.snapshotKey —— 与 nodeCard
	 * 读侧（stageUid）保持一致，否则写 nodeId、读 stageUid，OUTPUT 不刷新。
	 */
	snapshotKey?: string;
	type: string;
	getSpec: (type: string) => { kind?: string; backendKind?: string; comfyTV?: ComfyTVSpecMeta } | undefined;
	values: Record<string, unknown>;
	/** W1: Start 节点 args 全局上下文（模板 `{{args.*}}` 消费） */
	args?: Record<string, unknown>;
	/**
	 * W4: 具名引用解析器 —— 节点 label → 最新快照文本（调度器闭包提供，
	 * label→归档键→store 查询）。模板 `{{label.field}}` 消费。
	 */
	resolveNamed?: (label: string) => string | undefined;
	/** upstream node ids — snapshots feed `upstream_*` bindings (P2) */
	upstreams?: string[];
	/**
	 * W3: 入边表（带 targetHandle）—— Merge 等多输入编排节点按端口分桶上游。
	 * 缺省时 executor 回退按 upstreams 顺序。source 为快照归档键（与 upstreams 同映射）。
	 */
	inbound?: Array<{ source: string; targetHandle?: string }>;
	/** All canvas nodes (for @[node:label] mention resolution, P2). */
	nodes?: Array<{ id: string; type?: string; data?: { label?: string } }>;
	/** Injectable fetch (proxy for ComfyUI localhost 403 bypass); instant nodes use it. */
	fetchImpl?: typeof fetch;
	store: MediaSnapshotStore;
	onProgress?: RunProgress;
	signal?: AbortSignal;
	/** provider image-gen RPC (imagegen.generate). Injected so the module stays UI-free. */
	sendImageGen?: ImageGenSendFn;
	/** M3: Saros.Agent node RPC (workflow.runAgentNode). Injected for testability. */
	runAgentNode?: AgentNodeSendFn;
	/** P1: Saros.AskUser 交互 RPC（renderer 弹窗）。Injected for testability. */
	askUser?: AskUserSendFn;
	/**
	 * Auto-routing: resolve a provider/model pair when the node has none set.
	 * Injected from the host's provider list (first authenticated image-gen
	 * model). Returns undefined when nothing is available.
	 */
	resolveImageGenDefaults?: () => Promise<{ providerId: string; modelId: string } | undefined>;
	/**
	 * Provider→Comfy LoadImage bridge: upload an upstream provider image ref
	 * (http/data URL) to ComfyUI and return a consumable /view ref for the
	 * native LoadImage node's `image` input. Injected for testability; when
	 * absent, the default bridge (global fetch + runner baseUrl) is used.
	 */
	resolveLoadImageRef?: (ref: string) => Promise<{ ok: boolean; image?: string; error?: string }>;
}

/** LoadImage 原生节点（ComfyUI class_type 'LoadImage'）。 */
export function isLoadImageNode(type: string): boolean {
	return type === 'LoadImage';
}

/**
 * B 场景桥接：原生 LoadImage 的 `image` 输入若来自 Provider 快照（http/data URL，
 * 非 Comfy /view 引用），先上传到 ComfyUI 再执行。显式 `values.image` 优先于
 * 上游快照；comfy-view 直通。纯编排（上传由注入的 `resolveLoadImageRef` 完成）。
 */
export async function resolveLoadImageInputForNode(input: NodeExecutionInput): Promise<
	{ status: 'ok'; values: Record<string, unknown> } | { status: 'error'; result: SingleNodeRunResult }
> {
	const { type, values, upstreams, store } = input;
	if (!isLoadImageNode(type)) { return { status: 'ok', values }; }
	const ref = typeof values.image === 'string' && values.image
		? values.image
		: findUpstreamImageRef(store, upstreams);
	if (!ref || isComfyViewRef(ref)) { return { status: 'ok', values }; }
	const resolve = input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner);
	const r = await resolve(ref);
	if (!r.ok) {
		return {
			status: 'error',
			result: { promptId: '', status: 'error', error: r.error ?? '图片上传失败', entries: [] },
		};
	}
	return { status: 'ok', values: { ...values, image: r.image } };
}

/** 默认上传实现：全局 fetch + runner baseUrl → Comfy /upload/image。 */
export function defaultResolveLoadImageRef(runner: IComfyRunner, fetchImpl?: BridgeFetchLike): (ref: string) => Promise<{ ok: boolean; image?: string; error?: string }> {
	return (ref) => resolveLoadImageImageRef({
		ref,
		baseUrl: runner.baseUrl,
		fetchImpl: (fetchImpl ?? globalThis.fetch as unknown as BridgeFetchLike),
	});
}

/** Payload + response of the `imagegen.generate` host RPC (OpenAI-compatible). */
export type ImageGenSendFn = (payload: {
	providerId: string;
	modelId: string;
	prompt: string;
	negativePrompt?: string;
	width?: number;
	height?: number;
	numImages?: number;
	/** img2img: upstream image ref (URL / data URL / snapshot ref). */
	imageInput?: string;
}) => Promise<{ images: Array<{ url?: string; b64?: string }> }>;

/** Minimal structural provider entry used for auto-routing (duck-typed). */
export interface ImageGenProviderLike {
	id: string;
	authStatus?: string;
	models?: Array<{ id: string; supportsImageGen?: boolean }>;
}

/**
 * Auto-route: first authenticated provider with an image-gen model. Pure —
 * shared by the canvas Run (inject as `resolveImageGenDefaults`) and the
 * single-node editor popup. Returns undefined when nothing is available.
 */
export function resolveFirstImageGenDefaults(
	providers: ImageGenProviderLike[] | undefined,
): { providerId: string; modelId: string } | undefined {
	for (const p of providers ?? []) {
		if (p.authStatus !== 'authenticated') { continue; }
		const m = p.models?.find(x => x.supportsImageGen);
		if (m) { return { providerId: p.id, modelId: m.id }; }
	}
	return undefined;
}

/**
 * Collect the first available snapshot ref per media kind across upstream nodes
 * for FX-chain threading: a `video` upstream that carries an fx chain is
 * injected as its FULL packed value (`{"__fxvideo__": …}`) so the next fx stage
 * appends its spec entry; plain media falls back to the `/view` URL. Pure.
 */
export function collectUpstreamValues(
	store: MediaSnapshotStore,
	upstreams: string[] | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!upstreams) { return out; }
	for (const nodeId of upstreams) {
		for (const entry of store.byNode(nodeId)) {
			const kind = entry.media.kind;
			if (kind === 'unknown' || out[kind]) { continue; }
			out[kind] = entry.media.fxChain && kind === 'video'
				? entry.media.fxChain
				: entry.media.ref;
		}
	}
	return out;
}

/** ComfyTV no-Run picker stages: choose one candidate snapshot → emit it locally. */
export function isPickerNode(type: string): boolean {
	return type === 'ComfyTV.ImagePickerStage'
		|| type === 'ComfyTV.VideoPickerStage'
		|| type === 'ComfyTV.AudioPickerStage';
}

/** ComfyTV no-Run loader stages: emit the snapshot chosen in the node popup. */
export function isLoaderNode(type: string): boolean {
	return type === 'ComfyTV.ImageLoaderStage'
		|| type === 'ComfyTV.VideoLoaderStage'
		|| type === 'ComfyTV.AudioLoaderStage'
		|| type === 'ComfyTV.TextLoaderStage'
		|| type.startsWith('ComfyTV.Asset');
}

/** All snapshots produced by the upstream nodes (candidates for a picker). Pure. */
export function collectUpstreamCandidates(
	store: MediaSnapshotStore,
	upstreams: string[] | undefined,
): MediaSnapshotEntry[] {
	const out: MediaSnapshotEntry[] = [];
	for (const id of upstreams ?? []) { out.push(...store.byNode(id)); }
	return out;
}

/** Local picker execution: emit the candidate chosen by selected_index (1-based, ComfyTV semantics).
 *  Picker 是路由节点（不产生新内容），put 时 skipImport=true 避免重复导入媒体库。 */
async function runPickerNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	// 归档键（= stageUid，缺省 nodeId）。entry.nodeId 决定 `store.put` 的键前缀，
	// 必须与卡片读侧一致，否则 picker 自己的 OUTPUT 不刷新。
	const snapKey = input.snapshotKey ?? input.nodeId;
	// 优先：节点弹窗里选的媒体库历史资产（生成图片管理 P2 复用入口）
	const mediaAssetId = typeof input.values?.mediaAssetId === 'string' ? input.values.mediaAssetId : '';
	if (mediaAssetId) {
		const ref = await resolveMediaAssetUrl(mediaAssetId);
		if (ref) {
			const kind = inferPickerKind(input.type, mediaAssetId);
			const entry: MediaSnapshotEntry = { nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, media: { kind, ref }, index: 0 };
			input.store.put(entry, true /* skipImport */);
			return { promptId: '', status: 'success', entries: [entry] };
		}
		return { promptId: '', status: 'error', error: '媒体库资产不可用（已删除？）', entries: [] };
	}
	// 次优先：跨节点「全部生成图」视图选中的 directRef（节点卡片 pool scope='all'
	// 点选 → 直接输出该 ref，无需上游 batch 索引）。
	const directRef = typeof input.values?.directRef === 'string' ? input.values.directRef : '';
	if (directRef) {
		const kind = inferPickerKind(input.type, directRef);
		const entry: MediaSnapshotEntry = { nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, media: { kind, ref: directRef }, index: 0 };
		input.store.put(entry, true /* skipImport */);
		return { promptId: '', status: 'success', entries: [entry] };
	}
	const candidates = collectUpstreamCandidates(input.store, input.upstreams);
	if (!candidates.length) {
		return { promptId: '', status: 'error', error: '选择器没有上游候选：请先连接上游生成节点并执行', entries: [] };
	}
	const idx = Math.max(0, Math.min((Number(input.values?.selected_index) || 1) - 1, candidates.length - 1));
	const picked = candidates[idx];
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		media: picked.media,
		index: 0,
	};
	input.store.put(entry, true /* skipImport */);
	return { promptId: '', status: 'success', entries: [entry] };
}

/** 解析媒体库资产为可加载 URL（http/data 直用；本地镜像走 host 转换）。导出给
 * nodeCard 的 ImageLoaderPreview（仅渲染阶段解析——执行阶段产物走 runLoaderNode）。 */
export async function resolveMediaAssetUrl(id: string): Promise<string | null> {
	try {
		const asset = await mediaGet(id);
		if (!asset) { return null; }
		return resolveAssetUrl(asset);
	} catch {
		return null;
	}
}

/** 按 picker 节点类型推断媒体 kind（未知时回落 image）。 */
export function inferPickerKind(type: string, assetId: string): MediaKind {
	if (type === 'ComfyTV.VideoPickerStage') { return 'video'; }
	if (type === 'ComfyTV.AudioPickerStage') { return 'audio'; }
	return 'image';
}

/** Local loader execution: emit the snapshot the user picked in the popup,
 *  or the media-library asset injected via drag-to-canvas (mediaAssetId). */
async function runLoaderNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const snapKey = input.snapshotKey ?? input.nodeId;
	// 优先：拖拽注入的媒体库资产（mediaAssetId）→ resolve 资产 URL 产出快照。
	// 对齐 ComfyTV AssetLoaderStage 语义（setWidget asset_id/asset_url）。
	const mediaAssetId = typeof input.values?.mediaAssetId === 'string' ? input.values.mediaAssetId : '';
	if (mediaAssetId) {
		const ref = await resolveMediaAssetUrl(mediaAssetId);
		if (ref) {
			const kind = inferPickerKind(input.type, mediaAssetId);
			const entry: MediaSnapshotEntry = { nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, media: { kind, ref }, index: 0 };
			input.store.put(entry, true /* skipImport */);
			return { promptId: '', status: 'success', entries: [entry] };
		}
		return { promptId: '', status: 'error', error: '媒体库资产不存在或无法解析', entries: [] };
	}
	// 剪贴板粘贴图片直通：data.image 存 data URL / http URL（粘贴图片时注入，
	// 无需 mediaAssetId），直接产出 image 快照。
	const pastedImageRef = typeof input.values?.image === 'string' && input.values.image ? input.values.image : '';
	if (pastedImageRef) {
		const entry: MediaSnapshotEntry = { nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, media: { kind: 'image', ref: pastedImageRef }, index: 0 };
		input.store.put(entry, true /* skipImport */);
		return { promptId: '', status: 'success', entries: [entry] };
	}
	const mine = input.store.byNode(snapKey).filter(e => e.media.kind !== 'unknown');
	if (!mine.length) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中选择文件', entries: [] };
	}
	return { promptId: '', status: 'success', entries: [mine[0]] };
}

/**
 * Local Provider Picker execution (Saros.ProviderPicker, kind 'react'):
 * resolves an explicit provider/model (node editor values, else auto-route)
 * and emits a TEXT snapshot `provider:<providerId>:<modelId>` that downstream
 * image-gen nodes consume via `collectUpstreamProviderConfig`. No RPC.
 */
export async function runProviderPickerNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, store } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	let providerId = typeof input.values?.providerId === 'string' ? input.values.providerId : '';
	let modelId = typeof input.values?.modelId === 'string' ? input.values.modelId : '';
	if (!providerId || !modelId) {
		const defaults = await input.resolveImageGenDefaults?.();
		if (defaults) {
			providerId = providerId || defaults.providerId;
			modelId = modelId || defaults.modelId;
		}
	}
	if (!providerId || !modelId) {
		return { ...empty, error: '请先在节点设置中选择 Provider 和文生图模型' };
	}
	const ref = `${PROVIDER_PICKER_PREFIX}${providerId}:${modelId}`;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		media: { kind: 'text', ref },
		index: 0,
	};
	store.put(entry, true /* skipImport */);
	return { promptId: '', status: 'success', entries: [entry] };
}

/**
 * Execute a provider (LLM) image-gen node — `Saros.ModelImageGen` and other
 * kind='llm' specs. Calls the injected `imagegen.generate` RPC (host resolves
 * provider.generateImage against an authenticated provider), then normalizes
 * the returned image refs into snapshot entries under the node's primary key.
 *
 * Values are read from the node's editor form (`providerId`, `modelId`,
 * `prompt`, `negativePrompt`, `size`, `numImages`); `size` "WxH" wins over
 * explicit width/height.
 */
export async function runProviderImage(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	// 快照归档键（= stageUid，缺省 nodeId）—— 与卡片读侧一致。
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const send = input.sendImageGen;
	if (!send) {
		return { ...empty, error: 'Provider 文生图通道未注入（imagegen.generate）' };
	}
	// 兼容两种 widget 命名：schema 卡片用 `provider`/`model`（仿 Image Stage），
	// 旧 llm 弹窗用 `providerId`/`modelId`。前者优先。
	let providerId = typeof values.provider === 'string' && values.provider
		? values.provider
		: typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.model === 'string' && values.model
		? values.model
		: typeof values.modelId === 'string' ? values.modelId : '';
	// Precedence: ① explicit node values → ② upstream Provider Picker config
	// → ③ auto-route (first authenticated image-gen provider+model).
	const picker = providerId && modelId
		? undefined
		: collectUpstreamProviderConfig(input.store, input.upstreams);
	if (picker) {
		providerId = providerId || picker.providerId;
		modelId = modelId || picker.modelId;
	}
	if ((!providerId || !modelId) && input.resolveImageGenDefaults) {
		const defaults = await input.resolveImageGenDefaults();
		if (defaults) {
			providerId = providerId || defaults.providerId;
			modelId = modelId || defaults.modelId;
		}
	}
	if (!providerId || !modelId) {
		return { ...empty, error: '请先在节点设置中选择 Provider 和文生图模型' };
	}
	const rawPrompt = typeof values.prompt === 'string' ? values.prompt : '';
	if (!rawPrompt.trim()) {
		return { ...empty, error: '请输入提示词' };
	}
	// P2: "@[node:label]" mentions — text snapshots are injected into the prompt;
	// image mentions are collected as img2img input (first image wins, consistent
	// with findUpstreamImageRef fallback below).
	const mentioned = resolveNodeMentions(rawPrompt, input.nodes ?? [], {
		lookup: input.store ? createStoreLookup(input.store) : undefined,
	});
	const prompt = mentioned.text.trim() || rawPrompt;
	const mentionImageRef = mentioned.images[0];
	const { width, height } = parseSize(
		typeof values.size === 'string' ? values.size : undefined,
		Number(values.width) || undefined,
		Number(values.height) || undefined,
	);
	onProgress?.({ progress: 10 });
	// img2img: explicit value → @[node:...] image mention → upstream IMAGE snapshot.
	const imageInput = typeof values.imageInput === 'string' && values.imageInput
		? values.imageInput
		: mentionImageRef
			? mentionImageRef
			: findUpstreamImageRef(input.store, input.upstreams);
	try {
		const resp = await send({
			providerId,
			modelId,
			prompt,
			negativePrompt: typeof values.negativePrompt === 'string' ? values.negativePrompt : undefined,
			width,
			height,
			numImages: Number(values.numImages) > 0 ? Math.floor(Number(values.numImages)) : 1,
			imageInput,
		});
		onProgress?.({ progress: 90 });
		const images = resp?.images ?? [];
		if (!images.length) {
			return { ...empty, error: '图片生成接口未返回图片' };
		}
		const entries: MediaSnapshotEntry[] = images
			.map((img, i) => {
				const ref = img.url ?? (img.b64 ? `data:image/png;base64,${img.b64}` : '');
				if (!ref) { return undefined; }
				return {
					nodeId: snapKey,
					port: 'output',
					key: `${snapKey}:output:${i}`,
					media: { kind: 'image' as const, ref },
					index: i,
				};
			})
			.filter((e): e is MediaSnapshotEntry => !!e);
		for (const e of entries) { store.put(e); }
		return { promptId: '', status: 'success', entries };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * M3: shared upstream materialization — the first SAROS_JSON / TEXT snapshot
 * among the upstreams as a string (SAROS_JSON refs are already JSON text;
 * TEXT refs pass through). '' when no upstream snapshot exists.
 */
function resolveUpstreamSnapshotText(store: MediaSnapshotStore, upstreams: string[] | undefined): string {
	for (const up of upstreams ?? []) {
		const entries = store.byNode(up);
		if (entries.length === 0) { continue; }
		const m = entries[0].media;
		if (m.meta?.['sarosJson'] === '1' || m.meta?.['sarosJson'] === 1) {
			return m.ref; // ref 已是 JSON 串
		}
		if (m.kind === 'text') { return m.ref; }
	}
	return '';
}

/**
 * M3: `Saros.Agent` node executor. Prompt = node's `prompt` value with
 * `{{input}}` replaced by the first upstream SAROS_JSON/TEXT snapshot
 * (JSON-stringified); the subagent's final text is archived as a
 * `{kind:'text', meta.sarosJson:'1'}` snapshot so downstream nodes and the
 * M2 nodeOutput() bridge read the same value under the same key system.
 */
async function runAgentNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, type, values, upstreams, store, onProgress, signal, runAgentNode } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	if (!runAgentNode) {
		return { ...empty, error: '画布未连接 Agent 执行通道（runAgentNode 未注入）' };
	}
	const node = (input.nodes ?? []).find(n => n.id === nodeId);
	void node;
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	const template = typeof values.prompt === 'string' ? values.prompt : '';
	// W1/W4: {{input}} + {{args.*}} + {{label.field}}；无占位符时上游 JSON 附在尾部（兼容）
	const prompt = template.includes('{{')
		? resolveTemplateVars(template, { input: upstreamJson, args: input.args, named: input.resolveNamed })
		: (template + (upstreamJson ? `\n\n上游输出：\n${upstreamJson}` : ''));
	if (!prompt.trim()) {
		return { ...empty, error: 'Saros.Agent 节点缺少提示词（编辑节点填写 prompt，或连接上游输入）' };
	}
	const agentCfg = (values.agentConfig as { modelId?: string } | undefined) ?? {};
	const agentId = typeof values.agentId === 'string' && values.agentId ? values.agentId : undefined;
	const model = agentCfg.modelId ? agentCfg.modelId : undefined;
	const label = (input.nodes ?? []).find(n => n.id === nodeId)?.data?.label ?? type;
	onProgress?.({ progress: 15 });
	try {
		const r = await runAgentNode({ prompt, ...(agentId ? { agentId } : {}), ...(model ? { model } : {}), label }, 600_000);
		signal?.throwIfAborted();
		onProgress?.({ progress: 90 });
		if (!r.ok) {
			return { ...empty, error: r.error ?? 'Agent 子代理执行失败' };
		}
		const snapKey = input.snapshotKey ?? nodeId;
		const ref = JSON.stringify({ output: r.output ?? '' });
		const entry: MediaSnapshotEntry = {
			nodeId: snapKey,
			port: 'output',
			key: `${snapKey}:output:0`,
			index: 0,
			media: { kind: 'text', ref, meta: { sarosJson: '1', mime: 'application/json', agentNode: '1' } },
		};
		store.put(entry, true);
		return { promptId: '', status: 'success', entries: [entry] };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * P0: `Saros.Skill` node executor —— 让子代理（默认 saros-claw）加载并执行
 * 指定技能。复用 runAgentNode 通道（workflow.runAgentNode RPC），零新增 RPC。
 * prompt = 「请使用技能 X 执行任务」+ 技能参数（skillArgs 内 {{input}}/{{args.*}}
 * 已解析）+ 上游输入。归档 meta.skillNode='1'。
 */
async function runSkillNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store, onProgress, signal, runAgentNode } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	if (!runAgentNode) {
		return { ...empty, error: '画布未连接 Agent 执行通道（runAgentNode 未注入）' };
	}
	const skillName = typeof values.skillName === 'string' ? values.skillName.trim() : '';
	if (!skillName) {
		return { ...empty, error: 'Saros.Skill 节点缺少技能名（编辑节点选择 Skill）' };
	}
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	const argsRaw = typeof values.skillArgs === 'string' ? values.skillArgs : '{}';
	const argsText = argsRaw.includes('{{')
		? resolveTemplateVars(argsRaw, { input: upstreamJson, args: input.args, named: input.resolveNamed })
		: argsRaw;
	const taskHint = typeof values.task === 'string' && values.task.trim() ? values.task.trim() : '';
	const prompt = [
		`请使用技能「${skillName}」执行任务。`,
		taskHint ? `任务说明：${taskHint}` : '',
		`技能参数：\n${argsText}`,
		upstreamJson && !argsRaw.includes('{{input}}') ? `\n\n上游输入：\n${upstreamJson}` : '',
	].filter(Boolean).join('\n');
	const label = (input.nodes ?? []).find(n => n.id === nodeId)?.data?.label ?? 'Saros.Skill';
	onProgress?.({ progress: 15 });
	try {
		const r = await runAgentNode({ prompt, label }, 600_000);
		signal?.throwIfAborted();
		onProgress?.({ progress: 90 });
		if (!r.ok) {
			return { ...empty, error: r.error ?? '技能执行失败' };
		}
		const snapKey = input.snapshotKey ?? nodeId;
		const entry: MediaSnapshotEntry = {
			nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, index: 0,
			media: { kind: 'text', ref: JSON.stringify({ output: r.output ?? '' }), meta: { sarosJson: '1', mime: 'application/json', skillNode: '1' } },
		};
		store.put(entry, true);
		return { promptId: '', status: 'success', entries: [entry] };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * P0: `Saros.Tool` node executor —— 让子代理调用指定工具并返回结果（复用
 * runAgentNode 通道，零新增 RPC）。prompt = 「请调用工具 X」+ 参数 JSON +
 * 上游输入；明确要求只返回工具执行结果、不加额外说明。归档 meta.toolNode='1'。
 */
async function runToolNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store, onProgress, signal, runAgentNode } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	if (!runAgentNode) {
		return { ...empty, error: '画布未连接 Agent 执行通道（runAgentNode 未注入）' };
	}
	const toolName = typeof values.toolName === 'string' ? values.toolName.trim() : '';
	if (!toolName) {
		return { ...empty, error: 'Saros.Tool 节点缺少工具名（编辑节点填写 Tool 名称）' };
	}
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	const paramsRaw = typeof values.toolParams === 'string' ? values.toolParams : '{}';
	const paramsText = paramsRaw.includes('{{')
		? resolveTemplateVars(paramsRaw, { input: upstreamJson, args: input.args, named: input.resolveNamed })
		: paramsRaw;
	const prompt = [
		`请调用工具「${toolName}」，参数如下，直接执行并返回工具结果，不要添加额外说明。`,
		`工具参数：\n${paramsText}`,
		upstreamJson && !paramsRaw.includes('{{input}}') ? `\n\n上游输入：\n${upstreamJson}` : '',
	].filter(Boolean).join('\n');
	const label = (input.nodes ?? []).find(n => n.id === nodeId)?.data?.label ?? 'Saros.Tool';
	onProgress?.({ progress: 15 });
	try {
		const r = await runAgentNode({ prompt, label }, 600_000);
		signal?.throwIfAborted();
		onProgress?.({ progress: 90 });
		if (!r.ok) {
			return { ...empty, error: r.error ?? '工具调用失败' };
		}
		const snapKey = input.snapshotKey ?? nodeId;
		const entry: MediaSnapshotEntry = {
			nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, index: 0,
			media: { kind: 'text', ref: JSON.stringify({ output: r.output ?? '' }), meta: { sarosJson: '1', mime: 'application/json', toolNode: '1' } },
		};
		store.put(entry, true);
		return { promptId: '', status: 'success', entries: [entry] };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * P1: `Saros.AskUser` 交互节点 executor。暂停图执行，弹窗收集用户选择
 * （renderer 侧 askUser 回调，返回 string 或 string[]），结果归档为
 * `{answer}` SAROS_JSON 快照（meta.askUserNode='1'）。question/options 内
 * {{input}}/{{args.*}} 已解析。
 */
async function runAskUserNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store, onProgress, signal, askUser } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	if (!askUser) {
		return { ...empty, error: '画布未连接 AskUser 交互通道（askUser 未注入）' };
	}
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	let question = typeof values.questionText === 'string' && values.questionText.trim() ? values.questionText : '请选择';
	if (question.includes('{{')) {
		question = resolveTemplateVars(question, { input: upstreamJson, args: input.args, named: input.resolveNamed });
	}
	// options：数组或 JSON 字符串（[{label, description}]）
	let options: Array<{ label: string; description?: string }> = [];
	const rawOptions = values.options;
	if (Array.isArray(rawOptions)) {
		options = (rawOptions as unknown[]).map(o => {
			const oo = o as { label?: string; description?: string };
			return { label: String(oo?.label ?? ''), ...(oo?.description ? { description: String(oo.description) } : {}) };
		}).filter(o => o.label);
	} else if (typeof rawOptions === 'string' && rawOptions.trim()) {
		try {
			const arr: unknown = JSON.parse(rawOptions);
			if (Array.isArray(arr)) {
				options = (arr as Array<{ label?: string; description?: string }>).map(o => ({ label: String(o?.label ?? ''), ...(o?.description ? { description: String(o.description) } : {}) })).filter(o => o.label);
			}
		} catch {
			return { ...empty, error: 'AskUser 选项不是合法 JSON 数组' };
		}
	}
	if (options.length === 0) {
		return { ...empty, error: 'AskUser 节点缺少选项（编辑节点填写 options）' };
	}
	const multiSelect = values.multiSelect === 'yes' || values.multiSelect === true;
	onProgress?.({ progress: 30 });
	try {
		const answer = await askUser({ nodeId, question, options, multiSelect }, 600_000);
		signal?.throwIfAborted();
		onProgress?.({ progress: 95 });
		const snapKey = input.snapshotKey ?? nodeId;
		const entry: MediaSnapshotEntry = {
			nodeId: snapKey, port: 'output', key: `${snapKey}:output:0`, index: 0,
			media: { kind: 'text', ref: JSON.stringify({ answer }), meta: { sarosJson: '1', mime: 'application/json', askUserNode: '1' } },
		};
		store.put(entry, true);
		return { promptId: '', status: 'success', entries: [entry] };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * M3: `Saros.Prompt` node executor — pure text materialization (no backend
 * call). The widget text with `{{input}}` substituted by the first upstream
 * snapshot lands as a TEXT snapshot; downstream Agent / media nodes read it
 * through the same key system.
 */
async function runPromptNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const template = typeof values.prompt === 'string' ? values.prompt : '';
	if (!template.trim()) {
		return { ...empty, error: 'Saros.Prompt 节点缺少文本（编辑节点填写 prompt）' };
	}
	const upstreamText = resolveUpstreamSnapshotText(store, upstreams);
	// W1/W4: {{input}} + {{args.*}} + {{label.field}}；无占位符时原样（纯静态文本）
	const text = template.includes('{{')
		? resolveTemplateVars(template, { input: upstreamText, args: input.args, named: input.resolveNamed })
		: template;
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: { kind: 'text', ref: text, meta: { promptNode: '1' } },
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
}

/**
 * M3→W2: `Saros.IfElse` / `Saros.Switch` gate-node executor. Reads the upstream
 * SAROS_JSON and evaluates the `evaluationTarget` dot-path for truthiness,
 * then archives `{verdict, branch, value}` as a SAROS_JSON snapshot.
 *
 * W2 端口感知路由：结果带 `branch`（'true'/'false'）返回给调度器——出边
 * sourceHandle 与 branch 匹配才激活（真路由，不匹配分支不再执行）；
 * verdict 快照行为保留（旧模板 `{{input}}.verdict` 兼容）。
 * W2b: Switch 多 case——widget `cases`（JSON 数组或逗号分隔，≤4 路）定义每路
 * 匹配值；probe 的 String 值命中第 i 路 → branch='case-i'，无命中 → 'default'。
 */
async function runGateNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, type, values, upstreams, store } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	if (!upstreamJson) {
		return { ...empty, error: 'IfElse/Switch 节点无上游输出（请先运行上游节点）' };
	}
	let parsed: unknown;
	try { parsed = JSON.parse(upstreamJson); } catch {
		return { ...empty, error: 'IfElse/Switch 上游输出不是合法 JSON（上游应为 SAROS_JSON 节点）' };
	}
	let target = typeof values.evaluationTarget === 'string' ? values.evaluationTarget.trim() : '';
	// 兼容两种写法：裸点路径 `value` / `a.b.c`，或模板写法 `{{input.value}}`。
	// （旧 placeholder 误导用户填 {{input.value}}，此处 strip 前缀让两种都可用。）
	if (target === '{{input}}') { target = ''; }
	else if (target.startsWith('{{input.')) { target = target.slice('{{input.'.length).replace(/}}$/, ''); }
	// 点路径求值（a.b.c）；空路径 = 直接对上游值本身做 truthy 判定。
	let probe: unknown = parsed;
	if (target) {
		for (const seg of target.split('.')) {
			if (typeof probe !== 'object' || probe === null) { probe = undefined; break; }
			probe = (probe as Record<string, unknown>)[seg];
		}
	}
	const verdict = Boolean(probe);
	let branch = verdict ? 'true' : 'false';
	if (type === 'Saros.Switch') {
		// W2b: 解析 cases（JSON 数组或逗号分隔）→ String(probe) 精确匹配第 i 路
		const rawCases = values.cases;
		let cases: string[] = [];
		if (typeof rawCases === 'string' && rawCases.trim()) {
			try {
				const arr = JSON.parse(rawCases) as unknown;
				cases = Array.isArray(arr) ? arr.map(String) : String(arr).split(',').map(s => s.trim());
			} catch {
				cases = rawCases.split(',').map(s => s.trim());
			}
		} else if (Array.isArray(rawCases)) {
			cases = (rawCases as unknown[]).map(String);
		}
		const hit = cases.findIndex(c => c === String(probe));
		branch = hit >= 0 && hit < 4 ? `case-${hit + 1}` : 'default';
	}
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref: JSON.stringify({ verdict, branch, value: parsed, ...(type.includes('Switch') ? { nodeType: type } : {}) }),
			meta: { sarosJson: '1', mime: 'application/json', gateNode: '1' },
		},
	};
	store.put(entry, true);
	// W2/W2b 真路由：IfElse 与 Switch（case-N/default）都把 branch 交给调度器做端口激活
	return { promptId: '', status: 'success', entries: [entry], branch };
}

/**
 * W3/W3b: `Saros.Merge` 汇聚节点。按入边 targetHandle 分桶读取各上游快照
 * （无 handle 兼容：按 upstreams 顺序 inA/inB）。widget `mode`：
 *   all   → 聚合 `{inA, inB}`（桶可为 null=分支未激活，模板可判空）
 *   any   → 首个非空桶值直接透传（OR 合流；全空 → null）
 *   order → `[inA, inB]` 数组（null 占位保持端口下标对齐）
 */
async function runMergeNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, inbound, store } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const readSnapshot = (id: string | undefined): unknown => {
		if (!id) { return null; }
		const text = resolveUpstreamSnapshotText(store, [id]);
		if (!text) { return null; }
		try { return JSON.parse(text); } catch { return text; }
	};
	let inA: unknown;
	let inB: unknown;
	if (inbound && inbound.length > 0) {
		inA = readSnapshot(inbound.find(e => e.targetHandle === 'inA')?.source);
		inB = readSnapshot(inbound.find(e => e.targetHandle === 'inB')?.source);
	} else {
		inA = readSnapshot(upstreams?.[0]);
		inB = readSnapshot(upstreams?.[1]);
	}
	const mode = values.mode === 'any' || values.mode === 'order' ? values.mode : 'all';
	let out: unknown;
	if (mode === 'any') {
		out = inA ?? inB ?? null;
	} else if (mode === 'order') {
		out = [inA, inB];
	} else {
		out = { inA, inB };
	}
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref: JSON.stringify(out),
			meta: { sarosJson: '1', mime: 'application/json', mergeNode: '1', mergeMode: mode },
		},
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
}

/**
 * P0: `Saros.End` 工作流输出标记。透传上游快照（JSON 原文）并归档到自身，
 * meta.endNode='1' 标记为图最终输出。无输出端口——语义是「最终返回 = 本快照」，
 * 宿主/调用方读 GraphRunResult 后据此取结果。
 */
async function runEndNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, upstreams, store } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const upstreamJson = resolveUpstreamSnapshotText(store, upstreams);
	if (!upstreamJson) {
		return { ...empty, error: 'End 节点无上游输出（请先连接上游节点）' };
	}
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: { kind: 'text', ref: upstreamJson, meta: { sarosJson: '1', mime: 'application/json', endNode: '1' } },
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
}

/**
 * W5: `Saros.Loop` / `Saros.Parallel` 迭代子图容器执行器。
 *
 * body 存 `data.loopBody`（SubflowDefinition 同构；刻意**不走 flattenSubflows**——
 * 这是执行时语义容器，展平会导致 body 节点在主 plan 里重复执行）。
 *
 * 语义：
 *   * items = widget `items`（JSON 数组）或 `{{input}}` 时取上游数组快照；
 *   * 每个 item：当前项写入 `${snapKey}:item:${idx}` 快照 → body entry 节点
 *     的 `{{input}}` 读到它；body 按拓扑序逐节点 runNodeOrStage（迭代键
 *     `${id}#it${idx}`，不污染主图同名节点快照史）；
 *   * 失败 item → null 并继续（对齐脚本域 parallel() 的 null 语义）；
 *   * 输出 = `{iterations: [exitOutputs], failed: n}` 归档到 Loop 节点；
 *   * Loop=串行逐项；Parallel=简单并发池（concurrency widget，1–16）。
 */
async function runLoopNodeExecutor(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, type, values, upstreams, store, nodes } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const loopNode = nodes?.find(n => n.id === nodeId);
	const body = (loopNode?.data as Record<string, unknown> | undefined)?.loopBody as SubflowDefinition | undefined;
	if (!body || !Array.isArray(body.nodes) || body.nodes.length === 0) {
		return { ...empty, error: 'Loop/Parallel 节点缺少循环体（data.loopBody，可经画布「封装」操作生成）' };
	}
	// items 解析：widget JSON 数组 > {{input}} 上游数组快照
	let items: unknown[] = [];
	const rawItems = values.items;
	if (typeof rawItems === 'string' && rawItems.trim() && rawItems.trim() !== '{{input}}') {
		try {
			const arr: unknown = JSON.parse(rawItems);
			items = Array.isArray(arr) ? arr : [arr];
		} catch {
			return { ...empty, error: `items 不是合法 JSON 数组：${String(rawItems).slice(0, 64)}` };
		}
	} else {
		const up = resolveUpstreamSnapshotText(store, upstreams);
		if (up) {
			try { const arr: unknown = JSON.parse(up); items = Array.isArray(arr) ? arr : [up]; } catch { items = [up]; }
		}
	}
	if (items.length === 0) {
		const entry0: MediaSnapshotEntry = { nodeId: input.snapshotKey ?? nodeId, port: 'output', key: `${input.snapshotKey ?? nodeId}:output:0`, index: 0, media: { kind: 'text', ref: JSON.stringify({ iterations: [], failed: 0 }), meta: { sarosJson: '1', mime: 'application/json', loopNode: '1', empty: '1' } } };
		store.put(entry0, true);
		return { promptId: '', status: 'success', entries: [entry0] };
	}
	const mode = type === 'Saros.Parallel' ? 'parallel' : 'serial';
	const conc = Math.max(1, Math.min(16, Number(values.concurrency) || (mode === 'parallel' ? 4 : 1)));
	const snapKey = input.snapshotKey ?? nodeId;
	const order = computeExecutionOrder(body.nodes as ExecutionNodeLike[], body.edges as ExecutionEdgeLike[]).order;
	const entryIds = new Set(body.entryIds ?? []);
	const exitId = body.exitIds?.[0] ?? order[order.length - 1];

	const runItem = async (item: unknown, idx: number): Promise<unknown> => {
		// 当前项快照：body entry 节点 {{input}} 的数据源
		store.put({ nodeId: `${snapKey}:item:${idx}`, port: 'output', key: `${snapKey}:item:${idx}:output:0`, index: 0, media: { kind: 'text', ref: JSON.stringify(item), meta: { sarosJson: '1', loopItem: '1' } } }, true);
		const keyOf = (id: string) => `${id}#it${idx}`;
		for (const id of order) {
			const bn = body.nodes.find(n => n.id === id);
			if (!bn) { continue; }
			const ups = [
				...(entryIds.has(id) ? [`${snapKey}:item:${idx}`] : []),
				...body.edges.filter(e => e.target === id).map(e => keyOf(e.source)),
			];
			const r = await runNodeOrStage({
				...input,
				nodeId: id,
				type: bn.type,
				snapshotKey: keyOf(id),
				values: bn.data ?? {},
				upstreams: ups,
				inbound: body.edges.filter(e => e.target === id).map(e => ({ source: keyOf(e.source), targetHandle: e.targetHandle })),
				nodes: body.nodes,
				onProgress: undefined, // 迭代内进度不冒泡到主卡片
			}).catch(() => null); // 迭代内异常也按失败处理（null 语义）
			if (!r || r.status !== 'success') { return null; }
		}
		const text = resolveUpstreamSnapshotText(store, [keyOf(exitId)]);
		if (!text) { return null; }
		try { return JSON.parse(text); } catch { return text; }
	};

	const iterations: Array<unknown> = new Array(items.length).fill(null);
	let failed = 0;
	if (mode === 'serial') {
		for (let i = 0; i < items.length; i++) {
			if (input.signal?.aborted) { break; }
			iterations[i] = await runItem(items[i], i);
			if (iterations[i] === null) { failed++; }
			input.onProgress?.(Math.round(((i + 1) / items.length) * 100), `迭代 ${i + 1}/${items.length}`);
		}
	} else {
		// 简单并发池（concurrency 上限）
		let next = 0;
		const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) { return; }
				if (input.signal?.aborted) { return; }
				iterations[i] = await runItem(items[i], i);
				if (iterations[i] === null) { failed++; }
			}
		});
		await Promise.all(workers);
	}
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref: JSON.stringify({ iterations, failed }),
			meta: { sarosJson: '1', mime: 'application/json', loopNode: '1', loopMode: mode, itemCount: items.length },
		},
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
}

/* ==================================================================== *
 * EmojiStage —— m×n 表情包网格循环调度
 * ==================================================================== */

export function isEmojiStageNode(type: string): boolean {
	return type === 'ComfyTV.EmojiStage';
}

interface EmojiCellState { prompt: string; seed: number; text: string }

/** 解析 `cells` widget（JSON 数组），长度对齐 rows*cols。 */
function parseEmojiCells(raw: unknown, count: number): EmojiCellState[] {
	const out: EmojiCellState[] = Array.from({ length: count }, () => ({ prompt: '', seed: 0, text: '' }));
	if (typeof raw !== 'string' || !raw.trim()) { return out; }
	try {
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr)) { return out; }
		for (let i = 0; i < count; i++) {
			const it = arr[i] as { prompt?: unknown; seed?: unknown; text?: unknown } | undefined;
			if (typeof it?.prompt === 'string') { out[i].prompt = it.prompt; }
			if (typeof it?.seed === 'number' && Number.isFinite(it.seed)) { out[i].seed = Math.trunc(it.seed); }
			if (typeof it?.text === 'string') { out[i].text = it.text; }
		}
	} catch { /* 脏数据 → 全空 */ }
	return out;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) { return dflt; }
	return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/**
 * EmojiStage 执行器 —— 把 m×n 网格展开成 **m×n 次单图 workflow**。
 *
 * ## 为什么循环而不是 batch_size
 * 每格有**独立 prompt 与 seed**（表情包的核心诉求：每个表情不同），
 * batch_size 只能共享同一 prompt，因此必须逐格执行。
 *
 * ## 归档顺序 = 格顺序（关键）
 * `MediaSnapshotStore.put` 自动把 index 追加为「当前最大 index + 1」，
 * 所以顺序执行即可让第 i 格落在 index i，与卡片 `cellRefs`
 * （`ownSnapshots.map(e => e.media.ref)`）天然对齐。
 *
 * ## 两种运行范围（`run_scope`，由 EmojiStageEditor 写回）
 *  - `'all'`（默认，「生成全部」）：先 `clearNode` 清空旧归档（否则 put 持续
 *    追加，cellRefs 会错位到后半段），再逐格执行；
 *  - `'cell'`（「生成此表情」/ tile ⟳）：只跑 `selected_index` 一格；因 put 只能
 *    追加到末尾，跑完后按「旧列表 + 替换第 selIdx 项」重排回原位，避免其它格错位。
 *
 * 单格失败即返回 error，但**已成功的格保留归档**（部分成功可见）。
 */
async function runEmojiStageGrid(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, values, upstreams, store, getSpec, onProgress, signal } = input;
	const snapshotKey = input.snapshotKey ?? nodeId;
	const spec = getSpec(type);

	const rows = clampInt(values.rows, 1, 6, 3);
	const cols = clampInt(values.cols, 1, 6, 3);
	const total = rows * cols;
	const cells = parseEmojiCells(values.cells, total);
	const globalPrompt = typeof values.prompt === 'string' ? values.prompt : '';
	const scope = values.run_scope === 'cell' ? 'cell' : 'all';
	const selIdx = clampInt(values.selected_index, 0, total - 1, 0);

	const targets = scope === 'cell' ? [selIdx] : Array.from({ length: total }, (_, i) => i);

	// 单格模式：记录现有图列表（按 index 序）用于跑完重排回原位。
	const imagesOf = (): MediaRef[] => store.byNode(snapshotKey)
		.filter(e => e.media.kind === 'image')
		.map(e => e.media);
	const before: MediaRef[] = scope === 'cell' ? imagesOf() : [];

	if (scope === 'all') { store.clearNode(snapshotKey); }

	const collected: MediaSnapshotEntry[] = [];
	// 每格烘焙后的最终 media（按格 index 对齐），循环结束后清空重放。
	// 配文只烘焙到静态贴纸（PNG）；动画 webp 跳过（保动画），配文走编辑器预览层 CSS 叠加。
	const bakedByTarget = new Map<number, MediaRef>();
	let lastPromptId = '';
	for (let n = 0; n < targets.length; n++) {
		if (signal?.aborted) {
			return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
		}
		const i = targets[n];
		const cell = cells[i] ?? { prompt: '', seed: 0, text: '' };
		// 该格 prompt 为空 → 回退全局 prompt（对齐编辑器「↩ 用全局」语义）。
		const cellPrompt = cell.prompt.trim() || globalPrompt;
		// seed=0 视为「未指定」→ 随机，保证每格图不同。
		const cellSeed = cell.seed || Math.floor(Math.random() * 0x7fffffff);
		const cellValues: Record<string, unknown> = {
			...values,
			prompt: cellPrompt,
			main_prompt: cellPrompt,
			seed: cellSeed,
			// batch_size 固定 1：网格由本循环驱动，模板不再自行出多图。
			batch_size: 1,
		};
		const r = await runStageWorkflow({
			runner,
			nodeId,
			snapshotKey,
			type,
			kind: spec?.comfyTV?.kind ?? 'emoji',
			workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
			values: cellValues,
			upstreams,
			store,
			onProgress: (p) => {
				// 单格进度折算成整体进度：已完成格数 + 当前格内部进度。
				const inner = typeof p.progress === 'number' ? p.progress : 0;
				onProgress?.({ progress: (n + inner) / targets.length });
			},
			signal,
		}).catch((err: unknown) => ({
			promptId: '',
			status: 'error' as const,
			error: err instanceof Error ? err.message : String(err),
			entries: [] as MediaSnapshotEntry[],
		}));
		lastPromptId = r.promptId || lastPromptId;
		if (r.status !== 'success') {
			return {
				promptId: lastPromptId,
				status: r.status === 'canceled' ? 'canceled' : 'error',
				error: `表情 #${i} 生成失败：${r.error ?? '未知错误'}`,
				entries: collected,
			};
		}
		collected.push(...r.entries);

		// 配文烘焙：runStageWorkflow 已把本格图 put 进 store（物化为 data URL），
		// 取最后一个 image 即为本格产物；非动画 webp 且有配文时叠字并记录。
		const imgs = imagesOf();
		const latest = imgs[imgs.length - 1];
		if (latest) {
			let media = latest;
			const caption = cell.text.trim();
			if (caption && !isAnimatedWebpRef(latest.ref)) {
				try {
					media = { ...latest, ref: await overlayTextOnImage(latest.ref, caption) };
				} catch { /* 烘焙失败保留原图，绝不中断网格 */ }
			}
			bakedByTarget.set(i, media);
		}
		onProgress?.({ progress: (n + 1) / targets.length });
	}

	// 收尾重排：把（烘焙后的）media 按格序写回 store。
	// 'all'：clearNode 后按 index 顺序重放；'cell'：替换 selIdx 原位，其余不动。
	if (scope === 'all') {
		store.clearNode(snapshotKey);
		for (let i = 0; i < total; i++) {
			const media = bakedByTarget.get(i);
			if (media) {
				// skipImport=true：重放的是已入库资产，避免重复导入媒体库。
				store.put({ nodeId: snapshotKey, port: 'images', key: '', media }, true);
			}
		}
	} else if (scope === 'cell' && before.length > selIdx) {
		const after = imagesOf();
		const baked = bakedByTarget.get(selIdx);
		const added = baked ?? after[after.length - 1];
		if (added) {
			const arranged = [...before];
			arranged[selIdx] = added;
			store.clearNode(snapshotKey);
			// skipImport=true：重排搬运的是已入库资产，避免重复导入媒体库。
			for (const media of arranged) {
				store.put({ nodeId: snapshotKey, port: 'images', key: '', media }, true);
			}
		}
	}

	return { promptId: lastPromptId, status: 'success', entries: collected };
}

/**
 * Unified node executor shared by the single-node editor popup and the
 * workflow Run: schema nodes execute as their FULL ComfyTV workflow (degrading
 * to single-node when the runner has no ComfyTV extension), everything else
 * executes as a single ComfyUI class_type. ComfyTV fx-chain stages (builders
 * + the FX Chain terminal) run as single-node prompts with the threaded
 * fx value injected on the video input and fx-aware output extraction.
 * ComfyTV pickers/loaders (P2) resolve locally without any backend call.
 * Provider image-gen nodes (kind 'llm') run through the injected RPC.
 * M3: Saros.Agent orchestration nodes run through the injected agent RPC.
 */
export async function runNodeOrStage(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, getSpec, upstreams, store, onProgress, signal } = input;
	let values = input.values;
	if (isProviderPickerNode(type)) { return runProviderPickerNode(input); }
	if (isAgentNodeType(type) || isTaskNodeType(type)) { return runAgentNodeExecutor(input); }
	if (isSkillNodeType(type)) { return runSkillNodeExecutor(input); }
	if (isToolNodeType(type)) { return runToolNodeExecutor(input); }
	if (isPromptNodeType(type)) { return runPromptNodeExecutor(input); }
	if (isGateNodeType(type)) { return runGateNodeExecutor(input); }
	if (isMergeNodeType(type)) { return runMergeNodeExecutor(input); }
	if (isLoopNodeType(type)) { return runLoopNodeExecutor(input); }
	if (isEndNodeType(type)) { return runEndNodeExecutor(input); }
	if (isAskUserNodeType(type)) { return runAskUserNodeExecutor(input); }
	if (isLLMImageNode(getSpec(type))) { return runProviderImage(input); }
	if (isInstantNode(type)) { return runInstantNode(input); }
	if (isRelightNode(type)) { return runRelightNode(input); }
	if (isPosterNode(type)) { return runPosterNode(input); }
	if (isLayerEditorNode(type)) { return runLayerEditorNode(input); }
	if (isStoryboardEditorNode(type)) { return runStoryboardEditorNode(input); }
	if (isMaterialNode(type)) { return runMaterialNode(input); }
	if (isScene3DNode(type)) { return runScene3DNode(input); }
	if (isPickerNode(type)) { return runPickerNode(input); }
	if (isLoaderNode(type)) { return runLoaderNode(input); }
	if (isFxNode(type)) {
		const fxValues = { ...collectUpstreamValues(store, upstreams), ...values };
		return runSingleNode({
			runner, nodeId, snapshotKey: input.snapshotKey, type, values: fxValues, store,
			// The chain terminal emits a real video snapshot (standard
			// extraction); intermediate builders emit the threaded fx value.
			extractOutputs: isFxChainNode(type) ? undefined : comfyOutputsToFxSnapshots,
			onProgress: (p) => onProgress?.({ value: p.value }),
			signal,
		});
	}
	// EmojiStage 必须在通用 schema 分支之前拦截：m×n 网格要展开成多次单图执行
	// （每格独立 prompt/seed），而 schema 分支只跑一次 workflow。
	if (isEmojiStageNode(type)) { return runEmojiStageGrid({ ...input, values }); }
	const spec = getSpec(type);
	if (spec?.kind === 'schema') {
		return runStageWorkflow({
			runner,
			nodeId,
			snapshotKey: input.snapshotKey,
			type,
			kind: spec.comfyTV?.kind ?? type.replace(/^ComfyTV\./, '').replace(/Stage$/, '').toLowerCase(),
			workflowKind: spec.comfyTV?.workflowKind,
			workflowKinds: type === 'ComfyTV.ImageVariationsStage' ? ['multiview', 'sequence'] : undefined,
			values,
			upstreams,
			store,
			onProgress: (p) => onProgress?.({ progress: p.progress }),
			signal,
		}).catch(async (err: unknown): Promise<SingleNodeRunResult> => {
			if (err instanceof StageWorkflowUnavailableError) {
				// ComfyTV 扩展不可用（纯 ComfyUI / workflow 未准备）→ 按设计契约降级单节点执行。
				// StageWorkflowUnavailableError 的语义即 "→ degrade"，见 stageWorkflowExecutor.ts
				// 与 runStageWorkflow 的 JSDoc。单节点跑 ComfyTV 自定义节点可能报
				// required_input_missing / node not found，这是尽力而为的兜底路径。
				// 降级路径同样用 snapshotKey（快照归档键保持一致）。
				return await runSingleNode({ runner, nodeId, snapshotKey: input.snapshotKey, type, values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
			}
			return { promptId: '', status: 'error', error: err instanceof Error ? err.message : String(err), entries: [] };
		});
	}
	if (isLoadImageNode(type)) {
		// B 场景：原生 LoadImage 的 image 若来自 Provider 快照（http/data URL），
		// 先上传到 ComfyUI 再执行（原生 LoadImage 需要服务端 /view 引用）。
		const bridged = await resolveLoadImageInputForNode(input);
		if (bridged.status === 'error') { return bridged.result; }
		if (bridged.values !== values) {
			return runSingleNode({ runner, nodeId, snapshotKey: input.snapshotKey, type, values: bridged.values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
		}
	}
	// P2: plugin nodes — run the plugin's onRun hook (if any) to transform the
	// values before the backend call. onRun gets upstream snapshot refs per port
	// and the plugin-local storage.
	const pluginRunner = getPluginNodeRunner(type);
	if (pluginRunner) {
		try {
			const upstream: Record<string, string[]> = {};
			for (const pid of upstreams ?? []) {
				const portRefs = store.byNode(pid).map(e => e.media.ref);
				upstream[pid] = portRefs;
			}
			const hookValues = await pluginRunner({
				values,
				upstream,
				storage: {
					get: (k) => localStorage.getItem(`plugin:${type}:${k}`) ?? undefined,
					set: (k, v) => localStorage.setItem(`plugin:${type}:${k}`, v),
				},
			});
			if (hookValues && typeof hookValues === 'object') {
				values = { ...values, ...hookValues };
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { promptId: '', status: 'error', error: `插件节点执行失败：${msg}`, entries: [] };
		}
	}
	return runSingleNode({ runner, nodeId, snapshotKey: input.snapshotKey, type, values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
}

/**
 * Execute the executable sub-graph upstream-first. Stops on the first failure.
 * In 'parallel' mode independent steps run concurrently within each topological
 * layer (Comfy backend steps serialized; provider/local steps pooled).
 */
export async function runGraphExecution(options: GraphRunOptions): Promise<GraphRunResult> {
	const {
		nodes, edges, getSpec, resolveRunner, snapshotStore, cardState, nodeValues,
		onNodeStart, signal, sendImageGen, resolveImageGenDefaults, resolveLoadImageRef,
		mode = 'serial', parallelConcurrency = 4, taskId, fetchImpl, snapshotKeyOf,
	} = options;
	const result: GraphRunResult = {
		success: false, hasCycle: false, ran: [], skippedIds: [], failed: null, results: {},
		taskId, mode,
	};

	// P2: flatten subflow nodes (data.subflow) into their internal sub-graphs
	// before planning — the composition is a design-time convenience; execution
	// runs the flattened graph.
	const flattened = flattenSubflows(nodes, edges);
	const runNodes = flattened.nodes;
	const runEdges = flattened.edges;

	if (mode === 'parallel') {
		return runGraphExecutionParallel({ ...options, nodes: runNodes, edges: runEdges }, result);
	}

	const plan = buildExecutionPlan(runNodes, runEdges, type => isExecutableSpec(getSpec(type)) || isAgentNodeType(type) || isTaskNodeType(type) || isSkillNodeType(type) || isToolNodeType(type) || isPromptNodeType(type) || isGateNodeType(type) || isMergeNodeType(type) || isLoopNodeType(type) || isEndNodeType(type) || isAskUserNodeType(type));
	result.hasCycle = plan.hasCycle;
	if (plan.hasCycle) { return result; }
	// A ComfyUI runner is only required for schema/native nodes; a graph made
	// purely of provider (llm) nodes can run without a connected runner.
	const needsRunner = plan.steps.some(s => isComfyExecutableSpec(getSpec(s.type)));
	const runner = needsRunner ? resolveRunner() : undefined;
	if (needsRunner && !runner) {
		// P2 engine-ready gate: surface a clear per-node error instead of a
		// silent "nothing happened". Every backend step shows "未连接 ComfyUI
		// 引擎"; result.failed points at the first one.
		const backendSteps = plan.steps.filter(s => isComfyExecutableSpec(getSpec(s.type)));
		for (const s of backendSteps) {
			cardState.set(s.id, { runState: 'error', progress: 0, errorMsg: '未连接 ComfyUI 引擎：请先在 Runner 面板连接并测试 ComfyUI/ComfyTV' });
		}
		if (backendSteps[0]) {
			result.failed = { nodeId: backendSteps[0].id, error: '未连接 ComfyUI 引擎' };
		}
		return result;
	}

	// W2 端口感知路由状态：gate 节点 → 已判定分支。每步执行前用
	// computeInactiveNodes 重算激活表（拓扑序单遍传播，代价 O(V+E)，小图可忽略）。
	const branchOf = new Map<string, string>();
	const gateNodeIds = new Set(runNodes.filter(n => isGateNodeType(n.type ?? '')).map(n => n.id));
	// W1/W1b: Start 节点 args 输入契约（全图模板可用 {{args.*}}）；运行时覆盖 > 节点默认
	const startArgs = { ...collectStartArgs(runNodes), ...(options.startArgsOverride ?? {}) };
	// W4: 具名引用解析器（label → 归档键 → store 快照文本；重名取首个）
	const resolveNamed = (label: string): string | undefined => {
		const target = runNodes.find(x => {
			const l = (x.data as Record<string, unknown> | undefined)?.label;
			return (typeof l === 'string' && l ? l : x.type) === label;
		});
		if (!target) { return undefined; }
		return resolveUpstreamSnapshotText(snapshotStore, [snapshotKeyOf?.(target.id) ?? target.id]) || undefined;
	};

	for (const step of plan.steps) {
		if (signal?.aborted) { break; }
		// W2: 分支路由 —— 节点所有入边均未激活（gate 分支未命中 / 上游被 skip）→ 跳过
		if (computeInactiveNodes(runNodes, runEdges, branchOf, gateNodeIds).has(step.id)) {
			cardState.set(step.id, { runState: 'skipped', progress: 0 });
			result.skippedIds.push(step.id);
			continue;
		}
		onNodeStart?.(step);
		cardState.set(step.id, { runState: 'running', progress: 5 });
		// P2-tail: orchestration nodes are skipped, but their data flows into the
		// media node's values (e.g. Prompt 文本 → prompt). Editor values win.
		// ⚠ collectOrchestrationValues 按 **nodeId** 在 runNodes 里查节点，必须用
		//   原始 step.upstreams（不是归档键映射后的 uid）。
		const values = { ...collectOrchestrationValues(runNodes, step.upstreams), ...(nodeValues?.[step.id] ?? {}) };
		const progress = (p: { progress?: number; value?: number }) =>
			cardState.set(step.id, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
		const r = await runNodeOrStage({
			runner: runner as IComfyRunner,
			nodeId: step.id,
			snapshotKey: snapshotKeyOf?.(step.id),
			type: step.type,
			getSpec,
			values,
			args: startArgs,
			resolveNamed,
			// executor 侧的 upstreams 只用于 `store.byNode(...)`（快照查询），
			// 因此这里传**归档键**；节点身份相关的消费方拿 `nodes` + step.id。
			upstreams: mapSnapshotKeys(step.upstreams, snapshotKeyOf),
			inbound: runEdges.filter(e => e.target === step.id).map(e => ({ source: snapshotKeyOf?.(e.source) ?? e.source, targetHandle: e.targetHandle })),
			nodes: runNodes,
			store: snapshotStore,
			onProgress: progress,
			signal,
			sendImageGen,
			runAgentNode: options.runAgentNode,
			askUser: options.askUser,
			resolveImageGenDefaults,
			resolveLoadImageRef,
		});
		if (r.status === 'success') {
			cardState.set(step.id, { runState: 'success', progress: 100, durationMs: r.durationMs });
			result.ran.push(step.id);
			result.results[step.id] = r;
			// W2: gate 执行成功 → 记录分支，后续步骤据此端口路由
			if (r.branch) { branchOf.set(step.id, r.branch); }
		} else {
			cardState.set(step.id, { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
			result.failed = { nodeId: step.id, error: r.error ?? '执行失败' };
			return result;
		}
	}
	result.success = true;
	return result;
}

/**
 * Parallel mode: group steps into independent layers (buildParallelExecutionPlan)
 * and run each layer as a barrier. Provider/local steps (llm, instant, editors,
 * pickers) share a concurrency pool; Comfy backend steps (schema/native) are
 * serialized because ComfyUI's queue is inherently serial — they run in their
 * own single-slot pool. A failure in a layer stops later layers (first failure
 * recorded), matching the serial stop-on-first-failure contract.
 */
async function runGraphExecutionParallel(options: GraphRunOptions, result: GraphRunResult): Promise<GraphRunResult> {
	const { nodes, edges, getSpec, resolveRunner, snapshotStore, cardState, nodeValues, onNodeStart, signal, sendImageGen, resolveImageGenDefaults, resolveLoadImageRef, parallelConcurrency = 4, fetchImpl, snapshotKeyOf } = options;
	const plan = buildParallelExecutionPlan(nodes, edges, type => isExecutableSpec(getSpec(type)) || isAgentNodeType(type) || isTaskNodeType(type) || isSkillNodeType(type) || isToolNodeType(type) || isPromptNodeType(type) || isGateNodeType(type) || isMergeNodeType(type) || isLoopNodeType(type) || isEndNodeType(type) || isAskUserNodeType(type));
	result.hasCycle = plan.hasCycle;
	if (plan.hasCycle) { return result; }
	const needsRunner = plan.layers.some(l => l.some(s => isComfyExecutableSpec(getSpec(s.type))));
	const runner = needsRunner ? resolveRunner() : undefined;
	if (needsRunner && !runner) {
		// P2 engine-ready gate (parallel): same per-node error surfacing as serial.
		const backendSteps = plan.layers.flat().filter(s => isComfyExecutableSpec(getSpec(s.type)));
		for (const s of backendSteps) {
			cardState.set(s.id, { runState: 'error', progress: 0, errorMsg: '未连接 ComfyUI 引擎：请先在 Runner 面板连接并测试 ComfyUI/ComfyTV' });
		}
		if (backendSteps[0]) {
			result.failed = { nodeId: backendSteps[0].id, error: '未连接 ComfyUI 引擎' };
		}
		return result;
	}

	const isBackend = (step: { type: string }) => isComfyExecutableSpec(getSpec(step.type));

	// W2 端口感知路由（parallel 版）：gate 分支结果跨层传播；层内节点执行前
	// 重算激活表，未激活 → skipped（不占用并发池）。gate 与其分支下游天然
	// 落在不同层（barrier 不变量保证 gate 先完成），因此层内并发安全。
	const branchOf = new Map<string, string>();
	const gateNodeIds = new Set(nodes.filter(n => isGateNodeType(n.type ?? '')).map(n => n.id));
	// W1/W1b: Start args（parallel 版同样注入）；运行时覆盖 > 节点默认
	const startArgs = { ...collectStartArgs(nodes), ...(options.startArgsOverride ?? {}) };
	// W4: 具名引用解析器（parallel 版同款闭包）
	const resolveNamed = (label: string): string | undefined => {
		const target = nodes.find(x => {
			const l = (x.data as Record<string, unknown> | undefined)?.label;
			return (typeof l === 'string' && l ? l : x.type) === label;
		});
		if (!target) { return undefined; }
		return resolveUpstreamSnapshotText(snapshotStore, [snapshotKeyOf?.(target.id) ?? target.id]) || undefined;
	};

	const layerStats: GraphRunResult['layerStats'] = [];
	for (let li = 0; li < plan.layers.length; li++) {
		if (signal?.aborted) { break; }
		const layer = plan.layers[li];
		// W2: 先剔除本层未激活节点（gate 分支未命中 / 上游 skip 传导）
		const inactive = computeInactiveNodes(nodes, edges, branchOf, gateNodeIds);
		const activeLayer = layer.filter(s => !inactive.has(s.id));
		for (const s of layer.filter(x => inactive.has(x.id))) {
			cardState.set(s.id, { runState: 'skipped', progress: 0 });
			result.skippedIds.push(s.id);
		}
		const backend = activeLayer.filter(isBackend);
		const local = activeLayer.filter(s => !isBackend(s));
		let layerFailed = 0;
		let layerRan = 0;

		const runStep = async (step: { id: string; type: string; upstreams?: string[] }) => {
			if (signal?.aborted) { return; }
			onNodeStart?.(step);
			cardState.set(step.id, { runState: 'running', progress: 5 });
			const values = { ...collectOrchestrationValues(nodes, step.upstreams), ...(nodeValues?.[step.id] ?? {}) };
			const progress = (p: { progress?: number; value?: number }) =>
				cardState.set(step.id, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
			const r = await runNodeOrStage({
				runner: runner as IComfyRunner,
				nodeId: step.id,
				snapshotKey: snapshotKeyOf?.(step.id),
				type: step.type,
				getSpec,
				values,
				args: startArgs,
				resolveNamed,
				upstreams: mapSnapshotKeys(step.upstreams, snapshotKeyOf),
				inbound: edges.filter(e => e.target === step.id).map(e => ({ source: snapshotKeyOf?.(e.source) ?? e.source, targetHandle: e.targetHandle })),
				nodes,
				fetchImpl,
				store: snapshotStore,
				onProgress: progress,
				signal,
				sendImageGen,
				runAgentNode: options.runAgentNode,
				askUser: options.askUser,
				resolveImageGenDefaults,
				resolveLoadImageRef,
			});
				if (r.status === 'success') {
				cardState.set(step.id, { runState: 'success', progress: 100, durationMs: r.durationMs });
				result.ran.push(step.id);
				result.results[step.id] = r;
				if (r.branch) { branchOf.set(step.id, r.branch); }
				layerRan++;
			} else {
				cardState.set(step.id, { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
				if (!result.failed) {
					result.failed = { nodeId: step.id, error: r.error ?? '执行失败' };
				}
				layerFailed++;
			}
		};

		// Backend steps run in their own single-slot pool (serialized).
		const runBackendPool = runConcurrent(backend, 1, runStep);
		// Local/provider steps share the parallel pool.
		const runLocalPool = runConcurrent(local, parallelConcurrency, runStep);
		await Promise.all([runBackendPool, runLocalPool]);

		layerStats.push({ layer: li, total: layer.length, ran: layerRan, failed: layerFailed });
		result.layerStats = layerStats;

		// Stop at the first layer with a failure (barrier semantics).
		if (layerFailed > 0 || result.failed) { break; }
	}

	if (!result.failed) { result.success = true; }
	return result;
}

/**
 * Run `items` with at most `limit` concurrent executions. Each item's fn is
 * called with the item. Rejects only if `fn` throws synchronously (runStep
 * never throws — failures are recorded in results).
 */
async function runConcurrent<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const workers = Math.min(limit, items.length);
	if (workers <= 0) { return; }
	const slot = async () => {
		while (cursor < items.length) {
			const i = cursor++;
			await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: workers }, () => slot()));
}
