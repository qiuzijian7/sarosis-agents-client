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
import { runStageWorkflow, StageWorkflowUnavailableError, collectUpstreamRefs, applyAssetRefOverrides, type StageWorkflowRunOptions } from './stageWorkflowExecutor.js';
import { styleTemplateOf } from './builtinWorkflows/emojiWorkflows.js';
import { buildEmojiModelPrompt, parseComfyModelValue } from './emojiModelAdapt.js';

/** 通用负向词（checkpoint 系 KSampler negative；qwen/flux 组装链无 negative 输入，忽略）。 */
const EMOJI_NEGATIVE_PROMPT = 'text, watermark, blurry, low quality, deformed, ugly, duplicate, morbid, mutilated, out of frame, extra fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation, deformed, bad anatomy, bad proportions, extra limbs, cloned face, disfigured, gross proportions, malformed limbs, missing arms, missing legs, fused fingers, too many fingers, long neck';
import { getPluginNodeRunner } from './pluginLoader.js';
import { isFxNode, isFxChainNode } from './fxChain.js';
import type { MediaSnapshotEntry, MediaKind, MediaRef } from './mediaSnapshot.js';
import { mediaGet, resolveAssetUrl } from '../mediaAssets.js';
import { loadCanvasImageWithProxy } from '../canvasImageLoad.js';
import { WEIXIN_EXPORT_TARGETS } from './registry.js';
import { isInstantNode } from './instantNodes.js';
import { runInstantNode } from './instantExecutor.js';
import { isVideoToGifNode, EMOJI_GIF_PARAMS } from './videoToGif.js';
import { isRemoveBgNode } from './removeBg.js';
import { runRemoveBgNode } from './removeBgExecutor.js';
import { runVideoToGifNode, convertVideoToGif, convertVideoToGridTransparentGifs, blobToDataUrl, dataUrlToBlob } from './videoToGifExecutor.js';
import { isRelightNode } from './relightEditor.js';
import { runRelightNode } from './relightExecutor.js';
import { isPosterNode } from './posterEditor.js';
import { runPosterNode } from './posterExecutor.js';
import { isLayerEditorNode } from './layerEditor.js';
import { runLayerEditorNode } from './layerExecutor.js';
import { isStoryboardEditorNode } from './storyboardEditor.js';
import { runStoryboardEditorNode } from './storyboardExecutor.js';
import { isMultiPanelStoryboardNode, parsePanelsState, buildMultiPanelPrompt, isPanelsEmpty, splitStoryToPanels } from './multiPanelStoryboard.js';
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
import { isAnimatedWebpRef } from './emojiTextOverlay.js';
import { sendRequest } from '../../../bridge/messageClient.js';

/**
 * ★ 外网 ref 的 CSP 兜底 fetch（2026-09-03）。
 *
 * webview 的 CSP `connect-src` 只放行 `data: blob: http(s)://127.0.0.1|localhost`——
 * provider 返回的**外网资源**（如 MiniMax 视频落在腾讯 COS 的签名 URL）直接 fetch
 * 必被拦：`Connecting to 'https://…' violates CSP directive "connect-src"` →
 * `Failed to fetch`（日志实锤：AnimatedEmoji 整条链路因此报废）。
 *
 * 策略：非 localhost 的 http(s) 先走原 fetchImpl（有 CORS 头的源仍直连，省一跳
 * IPC）；失败（CSP 拦 / 无 CORS / 网络抖动）→ 回退 host 代理 `net.fetchAsDataUrl`
 * （ext host 的 node fetch 不受 webview CSP 限制）转 dataURL 再构 Response。
 * localhost / data: 一律原路（ComfyUI 路由与本地解码不受影响）。
 *
 * 注意：代理回退路径不透传 AbortSignal（host 拉取不可中断）——取消语义由上层
 * raceAbort 兜底（外层 RPC 已 abort 后，本兜底结果会被丢弃）。
 */
function withRemoteProxyFetch(fetchImpl: typeof fetch, opts?: { forceProxy?: boolean }): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as URL).toString();
		if (!/^https?:/i.test(url) || /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(url)) {
			return fetchImpl(url, init);
		}
		// forceProxy：CSP 必拦的外网资源（COS 签名 URL 等，无 CORS 头）直接走 host
		// 代理 —— 跳过注定失败的直连，消除每次运行的 CSP 噪音日志与一跳延迟。
		if (opts?.forceProxy) {
			const r = await sendRequest<{ url: string }, { dataUrl?: string; error?: string }>(
				'net.fetchAsDataUrl', { url }, 120_000,
			);
			if (r?.dataUrl) { return new Response(dataUrlToBlob(r.dataUrl), { status: 200 }); }
			throw new Error(`外网资源拉取失败（host 代理）：${r?.error ?? url.slice(0, 96)}`);
		}
		try {
			return await fetchImpl(url, init);
		} catch (firstErr) {
			try {
				const r = await sendRequest<{ url: string }, { dataUrl?: string; error?: string }>(
					'net.fetchAsDataUrl', { url }, 120_000,
				);
				if (r?.dataUrl) { return new Response(dataUrlToBlob(r.dataUrl), { status: 200 }); }
			} catch { /* 代理也失败 → 抛原始错误，错误信息更有指向性 */ }
			throw firstErr;
		}
	}) as typeof fetch;
}

/**
 * ★ 远程 ref 本地化（归档前固化）：http(s) URL 经 fetch（CSP 兜底走 host 代理）
 *   拉取转 data URL；data:/blob: 原样返回。失败**静默回退原 ref**（尽力而为，
 *   不阻断执行——归档总比丢弃好）。
 *
 * 为什么必须：provider 签名 URL（腾讯云 COS 等）**带时效**（q-sign-time 通常
 * 2 小时），直接归档 → 重启 app / 签名过期后 403 →「llm 原图消失」而本地合成
 * 的格子（data URL）还在。所有进快照的远程图像都应先过这里。
 */
async function localizeImageRef(ref: string): Promise<string> {
	if (!ref || !/^https?:\/\//i.test(ref)) { return ref; }
	try {
		const resp = await withRemoteProxyFetch(fetch)(ref);
		if (!resp.ok) { return ref; }
		const blob = await resp.blob();
		if (!blob.type.startsWith('image/')) { return ref; }
		return await blobToDataUrl(blob);
	} catch {
		return ref;
	}
}

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
/**
 * P2a: 类型安全物化 —— 点路径取值的最终结果是对象/数组时，用 JSON.stringify
 * 而非 String()（String(obj) 会得到 `[object Object]`，String([1,2]) 得到 `1,2`）。
 * 标量（string/number/boolean）仍走 String；undefined/null 返回空串（调用方
 * 通常已在 probe 阶段拦截 undefined/null 返回原占位符）。
 */
export function stringifyResolvedValue(v: unknown): string {
	if (v === undefined || v === null) { return ''; }
	if (typeof v === 'object') { return JSON.stringify(v); }
	return String(v);
}

/**
 * P2b: 提取解析后仍残留的 `{{...}}` 占位符（未解析到 = 引用了不存在的
 * label / args 路径 / input 路径 / 变量）。返回去重后的占位符内容列表
 * （不含花括号），空数组表示全部解析成功。
 *
 * 供执行器在物化后检测并告警（而非静默产出带 `{{xxx}}` 的文本）。
 */
export function findUnresolvedPlaceholders(text: string): string[] {
	if (!text || !text.includes('{{')) { return []; }
	const seen = new Set<string>();
	const re = /\{\{([^{}]+)\}\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const name = m[1].trim();
		if (name) { seen.add(name); }
	}
	return Array.from(seen);
}

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
			return probe === undefined || probe === null ? whole : stringifyResolvedValue(probe);
		});
	}
	if (ctx.args && Object.keys(ctx.args).length > 0 && out.includes('{{args.')) {
		out = out.replace(/\{\{args\.([A-Za-z0-9_.]+)\}\}/g, (whole, path: string) => {
			let probe: unknown = ctx.args;
			for (const seg of path.split('.')) {
				if (typeof probe !== 'object' || probe === null) { return whole; }
				probe = (probe as Record<string, unknown>)[seg];
			}
			return probe === undefined || probe === null ? whole : stringifyResolvedValue(probe);
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
				return probe === undefined || probe === null ? whole : stringifyResolvedValue(probe);
			}
			// 无路径：对象快照透传原文（String(obj) 会得到 [object Object]）
			return probe !== null && typeof probe === 'object' ? text : String(probe);
		});
	}
	return out;
}

/**
 * P0: 解析 `Saros.Prompt` 节点的 `variables` 字段（JSON）为「局部具名变量」映射。
 *
 * `variables` 顶层键 = 变量名，值 = 模板字符串（可含 `{{input}}` / `{{args.x}}` /
 * 引用其他变量 `{{其他变量}}`）。解析后这些变量合并进 `resolveTemplateVars` 的
 * `named` 命名空间，`prompt` 里 `{{变量名}}` 即可引用 —— 这是 Prompt 节点此前
 * 「声明了 variables 字段但执行器从不读取」的死代码接线（对齐 Dify/Coze 的
 * 「显式变量声明 + 点选引用」体验）。
 *
 * 特性：
 *   - 变量值递归解析（支持变量间引用，最多 8 层，循环引用返回原文防自锁）；
 *   - 非字符串值 JSON.stringify（数组/对象/数字安全物化）；
 *   - 非法 JSON / 空值 → 空映射（静默降级，不报错）。
 */
export function resolvePromptVariables(
	rawVariables: unknown,
	ctx: { input?: string; args?: Record<string, unknown>; named?: (label: string) => string | undefined },
): Record<string, string> {
	let obj: Record<string, unknown> = {};
	if (typeof rawVariables === 'string' && rawVariables.trim()) {
		try {
			const p = JSON.parse(rawVariables) as unknown;
			if (p && typeof p === 'object' && !Array.isArray(p)) { obj = p as Record<string, unknown>; }
		} catch { /* 非法 JSON → 空映射 */ }
	} else if (rawVariables && typeof rawVariables === 'object' && !Array.isArray(rawVariables)) {
		obj = rawVariables as Record<string, unknown>;
	}
	const raw: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj)) {
		raw[k] = typeof v === 'string' ? v : (v === undefined || v === null ? '' : JSON.stringify(v));
	}
	const resolved: Record<string, string> = {};
	const resolveOne = (name: string, depth: number): string => {
		if (depth > 8) { return raw[name] ?? ''; } // 循环引用保护：返回原文（占位符原样）
		const done = resolved[name];
		if (done !== undefined) { return done; }
		const val = raw[name];
		if (val === undefined) { return ''; }
		// 命名空间：优先局部变量（递归解析），否则委托外部 named（节点 label 引用）
		const merged = (label: string): string | undefined => {
			if (label === name) { return raw[name]; } // 自引用 → 原文（避免空替换）
			if (raw[label] !== undefined) { return resolveOne(label, depth + 1); }
			return ctx.named?.(label);
		};
		resolved[name] = resolveTemplateVars(val, { input: ctx.input, args: ctx.args, named: merged });
		return resolved[name];
	};
	for (const k of Object.keys(raw)) { resolveOne(k, 0); }
	return resolved;
}

/**
 * 把局部变量映射包装成 `resolveTemplateVars` 的 `named` 解析器（局部变量优先，
 * 回退外部 `resolveNamed`）。供 Prompt 节点把 variables 注入模板命名空间。
 */
export function makeNamedWithVariables(
	variables: Record<string, string>,
	fallback?: (label: string) => string | undefined,
): (label: string) => string | undefined {
	return (label: string): string | undefined => {
		const v = variables[label];
		if (v !== undefined) { return v; }
		return fallback?.(label);
	};
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
	/** provider video-gen RPC — required when the graph contains video-gen nodes */
	sendVideoGen?: VideoGenSendFn;
	/** provider 3D-gen RPC — required when the graph contains 3D-gen nodes */
	sendModel3DGen?: Model3DGenSendFn;
	/** provider 文本生成 RPC — required when the graph contains Saros.TextGen nodes */
	sendTextGen?: TextGenSendFn;
	/** provider 音频生成 RPC — required when the graph contains Saros.AudioGen nodes */
	sendAudioGen?: AudioGenSendFn;
	/** M3: Saros.Agent node RPC — required when the graph contains agent nodes */
	runAgentNode?: AgentNodeSendFn;
	/** P1: Saros.AskUser 交互 RPC — required when the graph contains ask-user nodes */
	askUser?: AskUserSendFn;
	/** auto-route provider/model when a node has none set */
	resolveImageGenDefaults?: () => Promise<{ providerId: string; modelId: string } | undefined>;
	/** provider→Comfy LoadImage bridge (optional; defaults to global fetch + runner) */
	resolveLoadImageRef?: (ref: string) => Promise<{ ok: boolean; image?: string; error?: string }>;
	/** Vox 口播视频节点 RPC（vox.run + 轮询）。 */
	runVoxPipeline?: VoxPipelineSendFn;
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
export type RunProgress = (p: { progress?: number; value?: number; message?: string }) => void;

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
	 * sourceHandle：**源输出口名**（如静态表情包 'images'/'image'）——多输出口节点
	 * 的下游按它区分消费语义（转动态表情包接 image 口=仅图集；接 images 口=独立格拼贴）。
	 */
	inbound?: Array<{ source: string; targetHandle?: string; sourceHandle?: string }>;
	/** All canvas nodes (for @[node:label] mention resolution, P2). */
	nodes?: Array<{ id: string; type?: string; data?: { label?: string } }>;
	/** Injectable fetch (proxy for ComfyUI localhost 403 bypass); instant nodes use it. */
	fetchImpl?: typeof fetch;
	store: MediaSnapshotStore;
	onProgress?: RunProgress;
	signal?: AbortSignal;
	/** provider image-gen RPC (imagegen.generate). Injected so the module stays UI-free. */
	sendImageGen?: ImageGenSendFn;
	/** provider video-gen RPC (videogen.generate). Injected so the module stays UI-free. */
	sendVideoGen?: VideoGenSendFn;
	/** provider 3D-gen RPC (modelgen.generate). Injected so the module stays UI-free. */
	sendModel3DGen?: Model3DGenSendFn;
	/** provider 文本生成 RPC (textgen.generate). Injected so the module stays UI-free. */
	sendTextGen?: TextGenSendFn;
	/** provider 音频生成 RPC (audiogen.generate). Injected so the module stays UI-free. */
	sendAudioGen?: AudioGenSendFn;
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
	/** Vox 口播视频节点 RPC（vox.run + 轮询）。Injected for testability. */
	runVoxPipeline?: VoxPipelineSendFn;
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
export function defaultResolveLoadImageRef(runner: IComfyRunner, fetchImpl?: BridgeFetchLike): (ref: string, signal?: AbortSignal) => Promise<{ ok: boolean; image?: string; error?: string }> {
	return (ref, signal) => resolveLoadImageImageRef({
		ref,
		baseUrl: runner.baseUrl,
		fetchImpl: (fetchImpl ?? globalThis.fetch as unknown as BridgeFetchLike),
		signal,
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
	/** quality hint for providers that support it (e.g. GPT Image "high"/"standard"). */
	quality?: string;
	/** img2img: upstream image ref (URL / data URL / snapshot ref). */
	imageInput?: string;
}) => Promise<{ images: Array<{ url?: string; b64?: string }> }>;

/**
 * 让一次性 RPC promise 可被 AbortSignal 取消（本地放弃）。
 *
 * host RPC（imagegen/videogen.generate）签名不含 signal，无法真正中止 provider
 * 侧请求；本 helper 在 signal abort 时立即 reject（AbortError），调用方据此快速
 * 返回 canceled，RPC promise 结果被丢弃（dangling 无害）。
 * 修复「点击取消没有反应」：此前取消只 abort ComfyUI 轮询，provider RPC 会
 * 跑满 180s/600s 超时才结束。
 */
export function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) { return p; }
	const aborted = new Promise<never>((_, reject) => {
		if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
		signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
	});
	return Promise.race([p, aborted]);
}

/** Payload + response of the `videogen.generate` host RPC（模型文生视频节点）。 */
export type VideoGenSendFn = (payload: {
	providerId: string;
	modelId: string;
	prompt?: string;
	/** 视频时长（秒，provider 按档位取整） */
	duration?: number;
	/** 分辨率档位（'768P' | '2K'，provider 特有） */
	resolution?: string;
	/** 画面比例（'16:9' 等，provider 特有） */
	ratio?: string;
	width?: number;
	height?: number;
	/** 图生视频：首帧/参考图引用（URL / data URL / snapshot ref）。 */
	imageInput?: string;
}) => Promise<{ videos: Array<{ url?: string; posterUrl?: string }> }>;

/** Payload + response of the `modelgen.generate` host RPC（3D 模型生成节点）。 */
export type Model3DGenSendFn = (payload: {
	providerId: string;
	modelId: string;
	prompt?: string;
	/** 目标面数（'auto' 或数字，provider 特有） */
	faceCount?: number | 'auto';
	/** 是否生成 PBR 材质（provider 特有） */
	enablePbr?: boolean;
	/** 图生 3D：参考图引用（URL / data URL / snapshot ref）。 */
	imageInput?: string;
}) => Promise<{ models: Array<{ url?: string; previewUrl?: string; sources?: Array<{ type: string; url: string }> }> }>;

/**
 * Payload + response of the `textgen.generate` host RPC（文本生成节点 Saros.TextGen）。
 * host 侧经 provider.chat() 流式聚合文本（与 reversePrompt.generate 同机制，纯文本无图）。
 */
export type TextGenSendFn = (payload: {
	providerId: string;
	modelId: string;
	/** 用户提示词（已展开 {{input}} / mention） */
	prompt?: string;
	/** 系统提示（可选，角色/格式约束） */
	system?: string;
	/** 采样温度（provider 默认 0.7） */
	temperature?: number;
}) => Promise<{ text: string }>;

/**
 * Payload + response of the `audiogen.generate` host RPC（音频生成节点 Saros.AudioGen）。
 * host 侧经 provider.generateAudio()（扩展命令转发，同 videogen/modelgen 模式）。
 */
export type AudioGenSendFn = (payload: {
	providerId: string;
	modelId: string;
	/** 提示词（风格/情绪/乐器/朗读文本等，已展开 {{input}} / mention） */
	prompt?: string;
	/** 歌词（可选，音乐类 provider 用；空 = 纯器乐） */
	lyrics?: string;
	/** 音频时长（秒，provider 按档位取整） */
	duration?: number;
	/** 生成数量（默认 1） */
	numAudios?: number;
	// ── TTS（文生语音）provider 特有（lightai audio_* 模型）──
	/** 音色 id（MiniMax male-qn-qingse / Seed speaker id 等；空 = provider 默认） */
	voiceId?: string;
	/** 语速（1 = 正常） */
	speed?: number;
	/** 情绪（MiniMax happy/sad/angry…；空 = 自动） */
	emotion?: string;
	/** 采样率（Seed 24000/32000/44100） */
	sampleRate?: number;
}) => Promise<{ audios: Array<{ url?: string; duration?: number; format?: string }> }>;

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
 * ★ 优先使用**指定**的 provider/model（否则回落首个可用）。
 *
 * 用途：MiniImageEditor 的消除/重绘/扩图必须与**打开它的节点**同源 —— 节点上配的
 * 是 lightai（gpt-image-2），编辑器却固定取「第一个 provider」可能落到 grnexus
 * （平台不支持 Images API）⇒ `POST /images/generations` 404。
 * 校验规则与 resolveFirstImageGenDefaults 一致：authenticated + supportsImageGen；
 * 指定 provider 未认证 / 模型不支持文生图 / 未提供 → 一律回落首个可用。
 *
 * ★ opts.lock（2026-09-03）：**锁定模式**——preferred 无效时**返回 undefined 而
 *   不是回落其它 provider**。用于「编辑器 AI 工具必须与节点同源」的场景：静默
 *   换 provider 会让用户在 grnexus 这类不支持 Images API 的网关上踩 404，且
 *   「节点用 A、编辑器用 B」的结果差异极难排查。调用方拿到 undefined 应显式
 *   报错引导修复配置。
 */
export function resolvePreferredImageGenDefaults(
	providers: ImageGenProviderLike[] | undefined,
	preferredProviderId?: string,
	preferredModelId?: string,
	opts?: { lock?: boolean },
): { providerId: string; modelId: string } | undefined {
	const all = providers ?? [];
	if (preferredProviderId) {
		const p = all.find(x => x.id === preferredProviderId && x.authStatus === 'authenticated');
		if (p) {
			const gen = (p.models ?? []).filter(x => x.supportsImageGen);
			const hit = preferredModelId ? gen.find(x => x.id === preferredModelId) : undefined;
			const modelId = hit?.id ?? gen[0]?.id;
			if (modelId) { return { providerId: p.id, modelId }; }
		}
		// 锁定模式：preferred 无效 → 不回落（宁可报错，不静默换 provider）
		if (opts?.lock) { return undefined; }
	}
	if (opts?.lock && preferredProviderId) { return undefined; }
	return resolveFirstImageGenDefaults(all);
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
	// M3: 从 `texts` input port 注入上游 TEXT/JSON（与 runAgentNodeExecutor / runVariableNode
	// 等节点一致）。这是「基于接口连接的图像生成」的关键路径：用户可在节点上只填模板或留空，
	// 让上游节点（如 Saros.Prompt、Saros.Agent）把 prompt 文本推过来。
	const upstreamText = resolveUpstreamSnapshotText(store, input.upstreams);
	// 与 Agent 节点同款：{{input}} 替换 / 无占位符则附加到末尾（向后兼容手填场景）。
	// ★ named 命名空间注入本节点 widget 字符串值：特化节点（如 Saros.WeixinStickerCover）
	//   的默认 prompt 模板可用 {{character}}/{{style}}/{{framing}} 引用自身控件，
	//   「填角色描述 → 模板展开」无需改执行器。named 缺失时占位原文保留（不崩），
	//   并回退外部 resolveNamed（Prompt variables 命名空间语义不变）。
	const namedFromWidgets = (label: string): string | undefined => {
		const v = values[label];
		if (label === 'character') {
			// 空角色 → 空串替换（模板「{{character}}{{style}}风格」不留孤立占位符）
			const ch = typeof v === 'string' ? v.trim() : '';
			return ch ? `${ch}，` : '';
		}
		return typeof v === 'string' && v.trim() ? v.trim() : undefined;
	};
	const basePrompt = rawPrompt.includes('{{')
		? resolveTemplateVars(rawPrompt, {
			input: upstreamText,
			args: input.args,
			named: (label) => namedFromWidgets(label) ?? input.resolveNamed?.(label),
		})
		: (rawPrompt + (upstreamText ? `\n\n上游输入：\n${upstreamText}` : ''));
	// P2: "@[node:label]" mentions — text snapshots are injected into the prompt;
	// image mentions are collected as img2img input (first image wins, consistent
	// with findUpstreamImageRef fallback below).
	const mentioned = resolveNodeMentions(basePrompt, input.nodes ?? [], {
		lookup: input.store ? createStoreLookup(input.store) : undefined,
	});
	const prompt = mentioned.text.trim() || basePrompt;
	if (!prompt.trim()) {
		return { ...empty, error: '请在 prompts 文本框输入提示词，或在 texts 输入口连接上游节点' };
	}
	const mentionImageRef = mentioned.images[0];
	const { width, height } = parseSize(
		typeof values.size === 'string' ? values.size : undefined,
		// 兼容新旧 widget 命名：新 spec 用 custom_width/custom_height，
		// 旧值 width/height 仍可读（向后兼容已有节点数据）。
		Number(values.custom_width ?? values.width) || undefined,
		Number(values.custom_height ?? values.height) || undefined,
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
			// quality: GPT Image 等 provider 特有（standard/high），其他 provider 忽略
			quality: typeof values.quality === 'string' && values.quality ? values.quality : undefined,
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
 * Execute a provider video-gen node — `Saros.ModelVideoGen`. Calls the
 * injected `videogen.generate` RPC (host resolves provider.generateVideo via
 * extension command forwarding), then normalizes returned videos into
 * snapshot entries (kind 'video', port 'video' — 与 ComfyTV 视频链路一致).
 *
 * Provider/model 解析顺序与 runProviderImage 相同：① 显式 widget 值
 * （videoProvider/videoModel）→ ② 上游 Provider Picker → ③ 报错提示。
 */
export async function runProviderVideo(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const send = input.sendVideoGen;
	if (!send) {
		return { ...empty, error: 'Provider 视频生成通道未注入（videogen.generate）' };
	}
	let providerId = typeof values.videoProvider === 'string' && values.videoProvider
		? values.videoProvider
		: typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.videoModel === 'string' && values.videoModel
		? values.videoModel
		: typeof values.modelId === 'string' ? values.modelId : '';
	// 上游 Provider Picker 兜底（与文生图同款机制）
	const picker = providerId && modelId
		? undefined
		: collectUpstreamProviderConfig(input.store, input.upstreams);
	if (picker) {
		providerId = providerId || picker.providerId;
		modelId = modelId || picker.modelId;
	}
	if (!providerId || !modelId) {
		return { ...empty, error: '请先在节点设置中选择 Provider 和视频生成模型' };
	}
	// 提示词：与文生图同款 {{input}} 模板 / 上游 TEXT 附加 / @[node:] mention
	const rawPrompt = typeof values.prompt === 'string' ? values.prompt : '';
	const upstreamText = resolveUpstreamSnapshotText(store, input.upstreams);
	const basePrompt = rawPrompt.includes('{{')
		? resolveTemplateVars(rawPrompt, { input: upstreamText, args: input.args, named: input.resolveNamed })
		: (rawPrompt + (upstreamText ? `\n\n上游输入：\n${upstreamText}` : ''));
	const mentioned = resolveNodeMentions(basePrompt, input.nodes ?? [], {
		lookup: input.store ? createStoreLookup(input.store) : undefined,
	});
	const prompt = mentioned.text.trim() || basePrompt;
	const mentionImageRef = mentioned.images[0];
	onProgress?.({ progress: 10 });
	// 图生视频：显式值 → mention 图 → 上游 IMAGE 快照
	const imageInput = typeof values.imageInput === 'string' && values.imageInput
		? values.imageInput
		: mentionImageRef
			? mentionImageRef
			: findUpstreamImageRef(input.store, input.upstreams);
	try {
		const resp = await send({
			providerId,
			modelId,
			prompt: prompt.trim() || undefined,
			// duration：COMBO 存字符串秒数；0/空 = provider 默认
			duration: Number(values.duration) > 0 ? Math.floor(Number(values.duration)) : undefined,
			resolution: typeof values.resolution === 'string' && values.resolution ? values.resolution : undefined,
			ratio: typeof values.ratio === 'string' && values.ratio && values.ratio !== 'auto' ? values.ratio : undefined,
			imageInput,
		});
		onProgress?.({ progress: 90 });
		const videos = resp?.videos ?? [];
		if (!videos.length) {
			return { ...empty, error: '视频生成接口未返回视频' };
		}
		const entries: MediaSnapshotEntry[] = videos
			.map((v, i) => {
				const ref = v.url ?? '';
				if (!ref) { return undefined; }
				return {
					nodeId: snapKey,
					port: 'video',
					key: `${snapKey}:video:${i}`,
					media: {
						kind: 'video' as const,
						ref,
						...(v.posterUrl ? { meta: { posterUrl: v.posterUrl } } : {}),
					},
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
 * Execute a provider 3D-gen node — `Saros.Model3DGen`. Calls the injected
 * `modelgen.generate` RPC（provider.generateModel3D，扩展命令转发）。
 *
 * 输出两条快照：
 *  - `preview`（IMAGE）：3D 渲染预览图（provider 返回 previewUrl；无则跳过）
 *  - `model_url`（TEXT）：glb 主产物 URL（JSON 携带多格式 sources，meta 标记）
 */
export async function runProviderModel3D(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const send = input.sendModel3DGen;
	if (!send) {
		return { ...empty, error: 'Provider 3D 生成通道未注入（modelgen.generate）' };
	}
	let providerId = typeof values.m3dProvider === 'string' && values.m3dProvider
		? values.m3dProvider
		: typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.m3dModel === 'string' && values.m3dModel
		? values.m3dModel
		: typeof values.modelId === 'string' ? values.modelId : '';
	const picker = providerId && modelId
		? undefined
		: collectUpstreamProviderConfig(input.store, input.upstreams);
	if (picker) {
		providerId = providerId || picker.providerId;
		modelId = modelId || picker.modelId;
	}
	if (!providerId || !modelId) {
		return { ...empty, error: '请先在节点设置中选择 Provider 和 3D 生成模型' };
	}
	const rawPrompt = typeof values.prompt === 'string' ? values.prompt : '';
	const upstreamText = resolveUpstreamSnapshotText(store, input.upstreams);
	const basePrompt = rawPrompt.includes('{{')
		? resolveTemplateVars(rawPrompt, { input: upstreamText, args: input.args, named: input.resolveNamed })
		: (rawPrompt + (upstreamText ? `\n\n上游输入：\n${upstreamText}` : ''));
	const mentioned = resolveNodeMentions(basePrompt, input.nodes ?? [], {
		lookup: input.store ? createStoreLookup(input.store) : undefined,
	});
	const prompt = mentioned.text.trim() || basePrompt;
	const mentionImageRef = mentioned.images[0];
	onProgress?.({ progress: 10 });
	const imageInput = typeof values.imageInput === 'string' && values.imageInput
		? values.imageInput
		: mentionImageRef
			? mentionImageRef
			: findUpstreamImageRef(input.store, input.upstreams);
	try {
		const resp = await send({
			providerId,
			modelId,
			prompt: prompt.trim() || undefined,
			// faceCount：COMBO 'auto' 或数字字符串
			faceCount: values.faceCount === 'auto' || values.faceCount === undefined || values.faceCount === ''
				? 'auto'
				: (Number(values.faceCount) > 0 ? Math.floor(Number(values.faceCount)) : 'auto'),
			enablePbr: values.enablePbr === 'true' || values.enablePbr === true,
			imageInput,
		});
		onProgress?.({ progress: 90 });
		const models = resp?.models ?? [];
		if (!models.length) {
			return { ...empty, error: '3D 生成接口未返回模型' };
		}
		const entries: MediaSnapshotEntry[] = [];
		models.forEach((m, i) => {
			// 预览图（IMAGE 口）：3D 渲染图；无预览则退回主产物 URL（下游按 media.kind 渲染）
			const previewRef = m.previewUrl || m.url || '';
			if (previewRef) {
				entries.push({
					nodeId: snapKey,
					port: 'preview',
					key: `${snapKey}:preview:${i}`,
					media: { kind: 'image' as const, ref: previewRef, meta: m.url ? { modelUrl: m.url } : undefined },
					index: i,
				});
			}
			// 模型 URL（TEXT 口）：glb 链接 + 多格式 sources（JSON）
			if (m.url) {
				entries.push({
					nodeId: snapKey,
					port: 'model_url',
					key: `${snapKey}:model_url:${i}`,
					media: {
						kind: 'text' as const,
						ref: m.url,
						meta: {
							sarosJson: '1', mime: 'application/json', model3dNode: '1',
							...(m.sources?.length ? { sources: m.sources } : {}),
						},
					},
					index: i,
				});
			}
		});
		if (!entries.length) {
			return { ...empty, error: '3D 生成结果缺少可展示产物' };
		}
		for (const e of entries) { store.put(e); }
		return { promptId: '', status: 'success', entries };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Execute a provider text-gen node — `Saros.TextGen`. Calls the injected
 * `textgen.generate` RPC（host 经 provider.chat() 流式聚合，与反推提示词同机制）。
 *
 * 输出 TEXT 快照（ports `texts` 批量 + `text` 单值同 ref），可直接接
 * 模型文生图 / 文生视频 / 3D 生成的 prompt 端口（COMFYTV_TEXT）。
 *
 * Provider/model 解析顺序与 runProviderVideo 相同：① 显式 widget 值
 * （textProvider/textModel）→ ② 上游 Provider Picker → ③ 报错提示。
 */
export async function runProviderText(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const send = input.sendTextGen;
	if (!send) {
		return { ...empty, error: 'Provider 文本生成通道未注入（textgen.generate）' };
	}
	let providerId = typeof values.textProvider === 'string' && values.textProvider
		? values.textProvider
		: typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.textModel === 'string' && values.textModel
		? values.textModel
		: typeof values.modelId === 'string' ? values.modelId : '';
	const picker = providerId && modelId
		? undefined
		: collectUpstreamProviderConfig(input.store, input.upstreams);
	if (picker) {
		providerId = providerId || picker.providerId;
		modelId = modelId || picker.modelId;
	}
	if (!providerId || !modelId) {
		return { ...empty, error: '请先在节点设置中选择 Provider 和对话模型' };
	}
	// 提示词：与文生图同款 {{input}} 模板 / 上游 TEXT 附加 / @[node:] mention
	const rawPrompt = typeof values.prompt === 'string' ? values.prompt : '';
	const upstreamText = resolveUpstreamSnapshotText(store, input.upstreams);
	const basePrompt = rawPrompt.includes('{{')
		? resolveTemplateVars(rawPrompt, { input: upstreamText, args: input.args, named: input.resolveNamed })
		: (rawPrompt + (upstreamText ? `\n\n上游输入：\n${upstreamText}` : ''));
	const mentioned = resolveNodeMentions(basePrompt, input.nodes ?? [], {
		lookup: input.store ? createStoreLookup(input.store) : undefined,
	});
	const prompt = mentioned.text.trim() || basePrompt;
	if (!prompt.trim()) {
		return { ...empty, error: '缺少提示词（编辑节点填写 prompt，或连接上游输入）' };
	}
	onProgress?.({ progress: 10 });
	try {
		const resp = await send({
			providerId,
			modelId,
			prompt: prompt.trim(),
			system: typeof values.system === 'string' && values.system.trim() ? values.system.trim() : undefined,
			// temperature：COMBO 存字符串；非法值 = provider 默认
			temperature: Number.isFinite(Number(values.temperature)) && values.temperature !== ''
				? Number(values.temperature)
				: undefined,
		});
		onProgress?.({ progress: 90 });
		const text = resp?.text ?? '';
		if (!text.trim()) {
			return { ...empty, error: '文本生成接口未返回内容' };
		}
		const entries: MediaSnapshotEntry[] = [
			{
				nodeId: snapKey,
				port: 'texts',
				key: `${snapKey}:texts:0`,
				media: { kind: 'text' as const, ref: text },
				index: 0,
			},
			{
				nodeId: snapKey,
				port: 'text',
				key: `${snapKey}:text:0`,
				media: { kind: 'text' as const, ref: text },
				index: 0,
			},
		];
		for (const e of entries) { store.put(e); }
		return { promptId: '', status: 'success', entries };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Execute a provider audio-gen node — `Saros.AudioGen`. Calls the injected
 * `audiogen.generate` RPC（provider.generateAudio，扩展命令转发，同 videogen 模式）。
 *
 * 输出 AUDIO 快照（ports `audios` 批量 + `audio` 单值同 ref），可直接接
 * ComfyTV 视频配音 / 口播导演的 audio 端口（COMFYTV_AUDIO）。
 *
 * Provider/model 解析顺序与 runProviderVideo 相同：① 显式 widget 值
 * （audioProvider/audioModel）→ ② 上游 Provider Picker → ③ 报错提示。
 */
export async function runProviderAudio(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const send = input.sendAudioGen;
	if (!send) {
		return { ...empty, error: 'Provider 音频生成通道未注入（audiogen.generate）' };
	}
	let providerId = typeof values.audioProvider === 'string' && values.audioProvider
		? values.audioProvider
		: typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.audioModel === 'string' && values.audioModel
		? values.audioModel
		: typeof values.modelId === 'string' ? values.modelId : '';
	const picker = providerId && modelId
		? undefined
		: collectUpstreamProviderConfig(input.store, input.upstreams);
	if (picker) {
		providerId = providerId || picker.providerId;
		modelId = modelId || picker.modelId;
	}
	if (!providerId || !modelId) {
		return { ...empty, error: '请先在节点设置中选择 Provider 和音频生成模型' };
	}
	// 提示词：与文生图同款 {{input}} 模板 / 上游 TEXT 附加 / @[node:] mention
	const rawPrompt = typeof values.prompt === 'string' ? values.prompt : '';
	const upstreamText = resolveUpstreamSnapshotText(store, input.upstreams);
	const basePrompt = rawPrompt.includes('{{')
		? resolveTemplateVars(rawPrompt, { input: upstreamText, args: input.args, named: input.resolveNamed })
		: (rawPrompt + (upstreamText ? `\n\n上游输入：\n${upstreamText}` : ''));
	const mentioned = resolveNodeMentions(basePrompt, input.nodes ?? [], {
		lookup: input.store ? createStoreLookup(input.store) : undefined,
	});
	const prompt = mentioned.text.trim() || basePrompt;
	if (!prompt.trim() && !(typeof values.lyrics === 'string' && values.lyrics.trim())) {
		return { ...empty, error: '缺少提示词（编辑节点填写 prompt/lyrics，或连接上游输入）' };
	}
	onProgress?.({ progress: 10 });
	try {
		const resp = await send({
			providerId,
			modelId,
			prompt: prompt.trim() || undefined,
			lyrics: typeof values.lyrics === 'string' && values.lyrics.trim() ? values.lyrics.trim() : undefined,
			// duration：COMBO 存字符串秒数；空 = provider 默认
			duration: Number(values.duration) > 0 ? Math.floor(Number(values.duration)) : undefined,
			numAudios: Number(values.numAudios) > 0 ? Math.floor(Number(values.numAudios)) : undefined,
		});
		onProgress?.({ progress: 90 });
		const audios = resp?.audios ?? [];
		if (!audios.length) {
			return { ...empty, error: '音频生成接口未返回音频' };
		}
		const entries: MediaSnapshotEntry[] = audios
			.map((a, i) => {
				const ref = a.url ?? '';
				if (!ref) { return undefined; }
				return {
					nodeId: snapKey,
					port: 'audios',
					key: `${snapKey}:audios:${i}`,
					media: {
						kind: 'audio' as const,
						ref,
						...(a.duration || a.format ? { meta: { ...(a.duration ? { duration: a.duration } : {}), ...(a.format ? { format: a.format } : {}) } } : {}),
					},
					index: i,
				};
			})
			.filter((e): e is MediaSnapshotEntry => !!e);
		// 单值口（audio）与批量口同 ref，方便下游单连线接线
		if (entries.length) {
			entries.push({
				nodeId: snapKey,
				port: 'audio',
				key: `${snapKey}:audio:0`,
				media: entries[0].media,
				index: 0,
			});
		}
		if (!entries.length) {
			return { ...empty, error: '音频生成结果缺少可播放产物' };
		}
		for (const e of entries) { store.put(e); }
		return { promptId: '', status: 'success', entries };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

// ─── 微信表情包素材导出（Saros.WeixinStickerCover mode='导出规格化'）──────────
// 浏览器本地 canvas 处理（同 VideoToGif 模式，不走 provider/ComfyUI）：
// 上游批量 images → 按微信素材规格缩放/格式转换/体积控制 → 快照输出。
// 防变形：cover 居中裁剪（不 stretch）；跨源上游经 loadCanvasImageWithProxy 代理。
// 规格表（WEIXIN_EXPORT_TARGETS）从 registry 导入——与 nodeCard 联动共享单一事实源。

/** 按 spec 绘制（cover 居中裁剪防变形；JPG 白底因无 alpha 通道）并转 data URL。 */
async function exportImageToSpec(
	img: HTMLImageElement,
	spec: { w: number; h: number; mime: string; maxBytes: number },
): Promise<{ dataUrl: string; bytes: number } | { error: string }> {
	const draw = (w: number, h: number): HTMLCanvasElement => {
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) { throw new Error('canvas 2d 上下文不可用'); }
		if (spec.mime === 'image/jpeg') {
			// JPG 无 alpha 通道：透明区域铺白底（微信要求横幅避免透明背景）
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, w, h);
		}
		const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
		const dw = img.naturalWidth * scale;
		const dh = img.naturalHeight * scale;
		ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
		return canvas;
	};
	const toDataUrl = async (w: number, h: number, quality: number): Promise<{ dataUrl: string; bytes: number }> => {
		const blob = await new Promise<Blob | null>((resolve) => draw(w, h).toBlob(resolve, spec.mime, quality));
		if (!blob) { throw new Error('canvas.toBlob 失败'); }
		const buf = new Uint8Array(await blob.arrayBuffer());
		let bin = '';
		const CHUNK = 0x8000;
		for (let i = 0; i < buf.length; i += CHUNK) {
			bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
		}
		return { dataUrl: `data:${spec.mime};base64,${btoa(bin)}`, bytes: buf.length };
	};
	// 体积控制：JPEG 降 quality 迭代（最低 0.4 后缩尺寸重来）；PNG 无 quality 通道 → 缩尺寸重试
	let w = spec.w;
	let h = spec.h;
	let q = 0.92;
	for (let attempt = 0; attempt < 8; attempt++) {
		let r: { dataUrl: string; bytes: number };
		try {
			r = await toDataUrl(w, h, q);
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
		if (r.bytes <= spec.maxBytes) { return r; }
		if (spec.mime === 'image/jpeg') {
			q -= 0.15;
			if (q < 0.4) { w = Math.max(1, Math.round(w * 0.9)); h = Math.max(1, Math.round(h * 0.9)); q = 0.9; }
		} else {
			w = Math.max(1, Math.round(w * 0.9));
			h = Math.max(1, Math.round(h * 0.9));
		}
	}
	return { error: `导出体积超限（>${Math.round(spec.maxBytes / 1024)}KB，已尝试压缩仍不达标）` };
}

/**
 * Execute the export branch of `Saros.WeixinStickerCover`（mode='导出规格化'）。
 * 上游（可能多个节点 / 单节点多张）的全部 kind='image' 快照逐张按微信素材
 * 规格转换；输出与生成模式同款端口（images 批量 + image 单值）。
 */
export async function runWeixinStickerExport(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const targetName = typeof values.exportTarget === 'string' && WEIXIN_EXPORT_TARGETS[values.exportTarget]
		? values.exportTarget
		: '表情封面图';
	const spec = WEIXIN_EXPORT_TARGETS[targetName];
	// 收集上游全部图片快照（多节点 / 单节点多张都覆盖；ref 去重）
	const refs: string[] = [];
	for (const up of input.upstreams ?? []) {
		for (const e of store.byNode(up)) {
			if (e.media.kind === 'image' && e.media.ref && !refs.includes(e.media.ref)) { refs.push(e.media.ref); }
		}
	}
	if (!refs.length) {
		return { ...empty, error: '没有上游图片：请连接表情包图片节点后运行（或切回「生成」模式直接文生图）' };
	}
	onProgress?.({ progress: 5 });
	const entries: MediaSnapshotEntry[] = [];
	for (let i = 0; i < refs.length; i++) {
		// 跨源 provider URL（无 CORS 头）经代理转 data URL 再进 canvas
		const img = await loadCanvasImageWithProxy(refs[i]);
		if (!img) { continue; } // 单张加载失败跳过，不拖垮整批
		const r = await exportImageToSpec(img, spec);
		if ('error' in r) {
			return { ...empty, error: `第 ${i + 1}/${refs.length} 张：${r.error}` };
		}
		entries.push({
			nodeId: snapKey,
			port: 'images',
			key: `${snapKey}:images:${i}`,
			media: {
				kind: 'image' as const,
				ref: r.dataUrl,
				meta: { exportTarget: targetName, bytes: r.bytes },
			},
			index: i,
		});
		onProgress?.({ progress: Math.round(10 + (85 * (i + 1)) / refs.length) });
	}
	if (!entries.length) {
		return { ...empty, error: '上游图片全部加载失败（签名 URL 可能已过期）' };
	}
	// 单值口（image）与批量口同 ref，方便下游单连线接线
	entries.push({
		nodeId: snapKey,
		port: 'image',
		key: `${snapKey}:image:0`,
		media: entries[0].media,
		index: 0,
	});
	for (const e of entries) { store.put(e); }
	return { promptId: '', status: 'success', entries };
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
	// P0: 解析 variables 局部变量，合并进命名空间（{{变量名}} 可引用）。
	//   W1/W4: {{input}} + {{args.*}} + {{label.field}}；无占位符时原样（纯静态文本）
	const variables = resolvePromptVariables(values.variables, { input: upstreamText, args: input.args, named: input.resolveNamed });
	const named = makeNamedWithVariables(variables, input.resolveNamed);
	const text = template.includes('{{')
		? resolveTemplateVars(template, { input: upstreamText, args: input.args, named })
		: template;
	// P2b: 检测未解析占位符（引用不存在的 label / args 路径 / input 路径 / 变量）。
	//   非阻断：物化文本原样保留（兼容「延迟解析」给下游 Agent 的语义），但
	//   ① console.warn 供 devtools 排查；② meta.unresolvedPlaceholders 标记供卡片
	//   展示 warning（区别于「一切正常」的纯 promptNode 快照）。
	const unresolved = findUnresolvedPlaceholders(text);
	if (unresolved.length > 0) {
		// eslint-disable-next-line no-console
		console.warn(`[Saros.Prompt] nodeId=${nodeId} 未解析占位符: ${unresolved.map(u => `{{${u}}}`).join(', ')}`);
	}
	const snapKey = input.snapshotKey ?? nodeId;
	const entry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref: text,
			meta: { promptNode: '1', ...(unresolved.length > 0 ? { unresolvedPlaceholders: unresolved } : {}) },
		},
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

/** 静态网格表情节点（透明贴纸 m×n）：原 EmojiStage 的静态能力继承者。 */
export function isStatEmojiStageNode(type: string): boolean {
	return type === 'ComfyTV.StatEmojiStage';
}

// ─── 多宫格故事板（ComfyTV.MultiPanelStoryboardStage）本地执行 ─────────────────
//   panels_state（网格宫格内容）→ buildMultiPanelPrompt → runStageWorkflow
//   （复用 qwen 多宫格内置模板 IMAGE_QWEN_2512_MULTI_PANEL，单图直出整张 N 宫格）。
//   宫格数存 panels_state.gridCount，注入 values.grid_count 让模板 prefix 的
//   {{grid_count}} 动态替换（见 stageWorkflowExecutor.interpolateBindingTemplate）。
async function runMultiPanelStoryboardNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, values, upstreams, store, getSpec, onProgress, signal } = input;
	const snapshotKey = input.snapshotKey ?? nodeId;
	const spec = getSpec(type);
	let panelsState = parsePanelsState(typeof values.panels_state === 'string' ? values.panels_state : '');
	// ★ 宫格内容全空 + 有上游故事文本 → 启发式拆分成宫格（否则用用户手动填的）。
	const upstreamStory = collectUpstreamTexts(store, upstreams).join('\n').trim();
	if (isPanelsEmpty(panelsState) && upstreamStory) {
		panelsState = splitStoryToPanels(upstreamStory, panelsState.gridCount);
		// eslint-disable-next-line no-console
		console.log(`[MultiPanelStoryboard] auto-split upstream story into ${panelsState.gridCount} panels`);
	}
	const prompt = buildMultiPanelPrompt(panelsState);
	const runValues: Record<string, unknown> = {
		...values,
		workflow: 'Qwen 2512 多宫格',
		prompt,
		grid_count: String(panelsState.gridCount),
	};
	// eslint-disable-next-line no-console
	console.log(`[MultiPanelStoryboard] run nodeId=${nodeId} gridCount=${panelsState.gridCount} prompt=${prompt.slice(0, 120)}`);
	return runStageWorkflow({
		runner,
		nodeId,
		snapshotKey,
		type,
		kind: spec?.comfyTV?.kind ?? 'image',
		workflowKind: spec?.comfyTV?.workflowKind ?? 'image',
		values: runValues,
		upstreams,
		store,
		onProgress: (p) => onProgress?.({ progress: p.progress }),
		signal,
	});
}

// ─── Vox 口播视频节点（Vox.DirectorStage）本地 pipeline 执行 ─────────────────
//
// 与 ComfyUI 后端不同，vox 走「本地 Python pipeline」：webview 组装 beats.json →
// 注入的 runVoxPipeline RPC（WorkflowEditorPanel 注入，内部 sendRequest vox.run +
// 轮询 vox.getProgress）→ 主进程 spawn `python vox_pipeline.py` → 产出 final.mp4。

/** vox pipeline 启动/轮询 RPC（注入，webview 保持 UI-free）。 */
export type VoxPipelineSendFn = (req: {
	projectId: string;
	beats: unknown;
	onStage?: (stage: string, progress: number) => void;
	signal?: AbortSignal;
}) => Promise<{ ok: boolean; finalMp4Path?: string; finalMp4Url?: string; error?: string }>;

/** Vox 口播视频导演节点类型判定。 */
export function isVoxDirectorNode(type: string): boolean {
	return type === 'Vox.DirectorStage';
}

/** Vox 口播脚本节点类型判定（阶段3：生成本地 beats.json 文本）。 */
export function isVoxScriptNode(type: string): boolean {
	return type === 'Vox.ScriptStage';
}

/**
 * 组装 beats.json。
 *
 * 优先级：
 *  1. 上游 `texts` 端口若含合法 JSON（含 `beats` 数组或数组本身）→ 透传
 *     （阶段3：上游 Saros.Prompt/TextStage 结构化输出 beats JSON）；
 *  2. 否则用 topic 模板化生成 beats_count 个 beat（占位，narration/scene= topic）。
 */
export function buildVoxBeats(values: Record<string, unknown>, upstreamTexts: string[]): unknown {
	// 1. 上游 beats JSON 透传
	for (const t of upstreamTexts) {
		const arr = extractJsonArray(t);
		if (!arr) { continue; }
		// 数组里找第一个含 beats 字段的对象（完整 beats.json 文档）
		for (const item of arr) {
			if (item && typeof item === 'object' && Array.isArray((item as { beats?: unknown }).beats)) {
				return item;
			}
		}
		// 整个数组也可能是 beats 数组（[ {id,narration,scene}, ... ]）
		if (arr.length > 0 && arr.every(x => x && typeof x === 'object' && typeof (x as { narration?: unknown }).narration === 'string')) {
			return {
				beats: arr,
				aspect: values.aspect ?? '9:16',
				theme: values.theme ?? 'american-retro',
				language: values.language ?? 'zh',
				video_model: values.video_model ?? 'local-ltx',
				provider: 'local',
				voice: { voice_id: values.voice_id ?? '', speed: Number(values.speed ?? 1) },
				music: values.music ?? '',
				caption_style: values.caption_style ?? 'white',
			};
		}
	}
	// 2. topic 模板化（占位）
	const topic = typeof values.topic === 'string' ? values.topic.trim() : '';
	const beatsCount = clampInt(values.beats_count, 1, 12, 5);
	const cameraMove = typeof values.camera_move === 'string' ? values.camera_move : 'push_in';
	const motionStyle = typeof values.motion_style === 'string' ? values.motion_style : 'calm';
	const duration = clampInt(values.duration, 1, 12, 4);
	// ★ scene 必须给 SDXL 可用的英文：CLIP 文本编码器只认英文，中文 scene 会被直接忽略，
	//   导致画面只剩英文风格描述随机生成（跟文章内容完全脱钩）。
	//   但纯前端 TS 无法做中文→英文视觉场景翻译，所以这里只能给英文通用占位。
	//   真正的"文章内容→视觉素材对应"需要上游 Saros.Prompt + VOX_LOCAL_QWEN3_4B_SCRIPT
	//   节点用 Qwen3 LLM 把文章拆成 {narration(中文), scene(英文视觉), title_en, title_cn}
	//   的结构化 beats JSON 透传下来，而非走 topic 模板化占位分支。
	const theme = typeof values.theme === 'string' && values.theme ? values.theme : 'american-retro';
	const scenePlaceholder = `thematic visual composition in ${theme} style, evoking the mood of the narration`;
	const beats = Array.from({ length: beatsCount }, (_, i) => ({
		id: i + 1,
		narration: topic || `第 ${i + 1} 段`,   // ★ 中文给 TTS（edge-tts zh-CN-XiaoxiaoNeural）
		scene: scenePlaceholder,                // ★ 英文给 SDXL（CLIP 拒中文）
		// ★ shot 必须自带 scene：python keyframes.py 的 shots_of() 遍历 beat["shots"]
		//   并访问 shot["scene"]（KeyError 若无）。beat 级 scene 不会下探到 shot。
		shots: [{ camera_move: cameraMove, motion_style: motionStyle, duration, scene: scenePlaceholder }],
	}));
	return {
		beats,
		aspect: values.aspect ?? '9:16',
		theme: values.theme ?? 'american-retro',
		language: values.language ?? 'zh',
		image_model: 'flux-dev',
		image_resolution: '1k',
		style: 'collage',
		// ★ 免费方案 video_model='local-ltx'：clips.py 据此走 duration（4s 而非
		//   veo3 特判的 8s），LocalProvider 用 LTX 2.3 图生视频 + zoompan 兜底。
		video_model: values.video_model ?? 'local-ltx',
		// ★ 免费方案：provider 默认 'local'（本地 ComfyUI SDXL + LTX 2.3 +
		//   edge-tts），零 API Key。如需 MuAPI 付费后端，改 'muapi' 并配 key。
		provider: 'local',
		// voice_id 留空 → LocalProvider 按 language 映射 edge-tts 免费音色；
		// 填 edge-tts 音色名（如 zh-CN-YunxiNeural）可自定义。
		voice: { voice_id: values.voice_id ?? '', speed: Number(values.speed ?? 1) },
		music: values.music ?? '',
		caption_style: values.caption_style ?? 'white',
	};
}

/** Vox.DirectorStage 执行器：组装 beats → 调 runVoxPipeline → 归档 video 快照。 */
async function runVoxDirectorNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store, onProgress, signal, runVoxPipeline } = input;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const snapshotKey = input.snapshotKey ?? nodeId;

	if (!runVoxPipeline) {
		return { ...empty, error: 'Vox 口播视频节点缺少 vox.run IPC 通道（runVoxPipeline 未注入）' };
	}
	if (signal?.aborted) { return { promptId: '', status: 'canceled', entries: [] }; }

	const upstreamTexts = collectUpstreamTexts(store, upstreams);
	const beats = buildVoxBeats(values, upstreamTexts);
	const projectId = `vox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	onProgress?.({ value: 5 });
	const resp = await runVoxPipeline({
		projectId,
		beats,
		onStage: (_stage, progress) => onProgress?.({ progress }),
		signal,
	});

	if (signal?.aborted) { return { promptId: projectId, status: 'canceled', entries: [] }; }
	if (!resp.ok || !resp.finalMp4Url) {
		return { promptId: projectId, status: 'error', error: `口播视频生成失败：${resp.error ?? '未知错误'}`, entries: [] };
	}

	// ★ ref 用主进程静态服务返回的 http URL（webview <video> 可直接播放；
	//   file:// 被 CSP 拦截，asWebviewUri 在 pooled webview 有 DNS 问题）。
	const entry: MediaSnapshotEntry = {
		nodeId: snapshotKey,
		port: 'video',
		key: `${snapshotKey}:video:0`,
		index: 0,
		media: {
			kind: 'video',
			ref: resp.finalMp4Url,
			meta: resp.finalMp4Path ? { localPath: resp.finalMp4Path } : undefined,
		},
	};
	store.put(entry, true);
	onProgress?.({ value: 100 });
	return { promptId: projectId, status: 'success', entries: [entry] };
}

/** Vox.ScriptStage 执行器：生成本地 beats.json 文本（上游透传 > topic 模板）。 */
async function runVoxScriptNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, upstreams, store } = input;
	const snapshotKey = input.snapshotKey ?? nodeId;
	const upstreamTexts = collectUpstreamTexts(store, upstreams);
	const beats = buildVoxBeats(values, upstreamTexts);
	const text = JSON.stringify(beats, null, 2);
	const entry: MediaSnapshotEntry = {
		nodeId: snapshotKey,
		port: 'texts',
		key: `${snapshotKey}:texts:0`,
		index: 0,
		media: { kind: 'text', ref: text },
	};
	store.put(entry, true);
	return { promptId: '', status: 'success', entries: [entry] };
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

/** 长字符串截断：单行日志用（避免 prompt 内的换行/超长把控制台刷爆）。 */
function truncateForLog(s: string, max: number): string {
	const oneLine = s.replace(/[\r\n]+/g, ' ');
	if (oneLine.length <= max) { return oneLine; }
	return oneLine.slice(0, max) + '…';
}

/**
 * 收集上游节点的所有文本快照（`text` 端口接入的 TextStage / Agent / Prompt /
 * Start 等输出，`media.kind === 'text'`）。按 upstreams 顺序 + 条目顺序返回，
 * 供 EmojiStage 把文本拆分成 m×n 个格子的 prompt。
 */
export function collectUpstreamTexts(store: MediaSnapshotStore, upstreams: string[] | undefined): string[] {
	const out: string[] = [];
	for (const up of upstreams ?? []) {
		for (const entry of store.byNode(up)) {
			if (entry.media.kind === 'text' && typeof entry.media.ref === 'string') {
				const t = entry.media.ref.trim();
				if (t) { out.push(t); }
			}
		}
	}
	return out;
}

/**
 * 剥离 markdown 代码块包裹（```` ```json ... ``` ```` 或裸 ` ``` `）。
 * 无代码块时原样返回（trim 后）。
 */
export function stripMarkdownCodeFence(text: string): string {
	const t = text.trim();
	if (!t) { return t; }
	// ```json ... ``` / ``` ... ```（语言标识可选，内容非贪婪）
	const m = t.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
	if (m) { return m[1].trim(); }
	return t;
}

/**
 * 从任意文本中稳健提取**第一个** JSON 数组。
 *
 * LLM 生成的文本往往不是干净 JSON：带 markdown 代码块（` ```json [...] ``` `）、
 * 前后缀说明（`好的，结果是：[...]`）、或夹杂解释文字。本函数逐级容错：
 *   1. 先剥离 markdown 代码块；
 *   2. 整段 JSON.parse（若已是干净数组）；
 *   3. 括号配平扫描：从第一个 `[` 起找配平 `]`（跳过字符串字面量与转义），
 *      取平衡段 JSON.parse；失败则继续找下一个 `[`。
 *
 * 返回提取出的数组（`unknown[]`），或 null（无合法 JSON 数组）。
 * 调用方据此决定「严格数组命中」还是「回退启发式拆分」。
 */
export function extractJsonArray(text: string): unknown[] | null {
	if (!text) { return null; }
	const t = stripMarkdownCodeFence(text);
	if (!t) { return null; }
	// 1. 整段即数组（最快的干净路径）
	if (t.startsWith('[')) {
		try {
			const v = JSON.parse(t) as unknown;
			if (Array.isArray(v)) { return v as unknown[]; }
		} catch { /* 继续配平扫描 */ }
	}
	// 2. 括号配平扫描：逐个候选平衡段尝试解析
	let i = t.indexOf('[');
	while (i >= 0) {
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let j = i; j < t.length; j++) {
			const c = t[j];
			if (esc) { esc = false; continue; }
			if (c === '\\' && inStr) { esc = true; continue; }
			if (c === '"') { inStr = !inStr; continue; }
			if (inStr) { continue; }
			if (c === '[') { depth++; }
			else if (c === ']') {
				depth--;
				if (depth === 0) { end = j; break; }
			}
		}
		if (end >= 0) {
			const slice = t.slice(i, end + 1);
			try {
				const v = JSON.parse(slice) as unknown;
				if (Array.isArray(v)) { return v as unknown[]; }
			} catch { /* 该段非法 JSON → 找下一个候选 */ }
		}
		i = t.indexOf('[', i + 1);
	}
	return null;
}

/**
 * 严格解析上游文本为 EmojiCellState 数组 —— JSON 数组是**权威划分依据**。
 *
 * 支持两种元素形态：
 *   - 字符串：`"猫"` → `{ prompt: '猫', seed: 0, text: '' }`
 *   - 对象：`{"prompt":"猫","seed":123,"text":"喵"}` → 完整 cell（三字段均可选）
 *
 * ## 严格性保证（与 splitEmojiPrompts 的关键区别）
 *   1. 只有 `extractJsonArray` **成功命中**（含 markdown/前后缀容错）才算数；
 *   2. 一旦命中，**绝不 fallthrough 到启发式拆分**（多行/逗号）—— 这是
 *      「严格按 JSON 数组划分」的核心：`["猫, 狗"]` 是**一个** prompt，不会被逗号误拆；
 *   3. 无合法 JSON 数组 → 返回 null（不产出半截结果），由调用方回退；
 *   4. 对象元素可携带 `seed` / `text`，让上游完整控制每格的种子与配文。
 *
 * 返回 null 表示「上游无合法 JSON 数组」（调用方回退启发式 / 手填 / 全局）。
 */
export function parseEmojiCellArray(texts: string[]): EmojiCellState[] | null {
	for (const raw of texts) {
		const arr = extractJsonArray(raw);
		if (!arr) { continue; }
		const cells: EmojiCellState[] = [];
		for (const a of arr) {
			if (typeof a === 'string') {
				const p = a.trim();
				if (p) { cells.push({ prompt: p, seed: 0, text: '' }); }
			} else if (a && typeof a === 'object') {
				const o = a as { prompt?: unknown; seed?: unknown; text?: unknown };
				const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
				const seed = typeof o.seed === 'number' && Number.isFinite(o.seed) ? Math.trunc(o.seed) : 0;
				const text = typeof o.text === 'string' ? o.text : '';
				if (prompt || seed || text) { cells.push({ prompt, seed, text }); }
			}
		}
		return cells.length > 0 ? cells : null;
	}
	return null;
}

/**
 * 把上游文本拆分成「最多 total 条」的表情 prompt 列表（**启发式兜底路径**）。
 *
 * 拆分优先级（逐条尝试，命中即用）：
 *  1. JSON 数组：`["猫","狗",{"prompt":"鸟"}]` —— 解析后取字符串项 / `{prompt}` 项；
 *     解析失败则**作为单条保留**（不 fallthrough，避免 `[猫,狗` 被逗号误拆）；
 *  2. 多行文本：每行一个表情描述（`猫\n狗\n鸟`）；
 *  3. 分隔符列表：逗号/顿号/分号/竖线（`猫,狗,鸟` 或 `猫、狗、鸟`）；
 *  4. 单条文本：原样作为唯一 prompt。
 *
 * 返回空数组表示「无上游文本」（调用方回退到全局 prompt / 手填 cells）。
 * 长度可能 > total，调用方按需截断或循环复用。
 *
 * ⚠ 需携带 seed/text 的完整 cell 请走 `parseEmojiCellArray`（本函数只产 prompt）。
 */
export function splitEmojiPrompts(texts: string[]): string[] {
	const items: string[] = [];
	for (const raw of texts) {
		const t = raw.trim();
		if (!t) { continue; }
		// 1. JSON 数组（含 markdown 代码块/前后缀容错提取）
		const arr = extractJsonArray(t);
		if (arr) {
			for (const a of arr) {
				if (typeof a === 'string' && a.trim()) { items.push(a.trim()); }
				else if (a && typeof a === 'object') {
					const p = (a as { prompt?: unknown }).prompt;
					if (typeof p === 'string' && p.trim()) { items.push(p.trim()); }
				}
			}
			continue;
		}
		// 2. ★ 严格：剥 markdown 后仍以 `[` 开头但提取失败 → 单条保留，绝不
		//    fallthrough 到逗号/换行（避免 `[猫,狗` 被误拆成 `['[猫','狗']`）。
		if (stripMarkdownCodeFence(t).startsWith('[')) {
			items.push(t);
			continue;
		}
		// 3. 多行
		const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
		if (lines.length > 1) { items.push(...lines); continue; }
		// 4. 分隔符列表
		const parts = t.split(/[,，、;；|｜]/).map(s => s.trim()).filter(Boolean);
		if (parts.length > 1) { items.push(...parts); continue; }
		// 5. 单条
		items.push(t);
	}
	return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// EmojiStage 整图图集模式（2026-09-02）：一次生成 m×n 拼贴整图 → 前端切分。
// 与「逐格循环」的关系：scope='all' 走整图（1 次采样，格间画风天然统一）；
// scope='cell'（生成此表情）保持单格单图，只重生成选中格、不影响其他格。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 整版图集背景策略（widget `sheet_background`）。
 *
 * - `white`：追加 `flat clean white background`，且切图**不抠白底** ⇒ 成图保留
 *   白底（确实想要白底贴纸时选用）。
 * - `transparent`：追加 `isolated on transparent background`（支持 alpha 的
 *   模型如即梦 5.0 / banana 2 可直接返透明 PNG），切图**不二次抠图**（信任原生
 *   alpha，避免误伤浅色主体）。
 * - `auto`（默认）：**不追加任何背景子句** —— 背景交由每格描述（用户 prompt /
 *   主题模板，后者以 isolated on transparent background 结尾）决定；透明化亦可
 *   由用户手动「去背景」（内置 U²Net）完成。此前 header 硬编码白底，与用户
 *   「透明背景」的格描述直接冲突，且 header 在前更容易被模型采纳 ⇒ 失效。
 */
export type EmojiSheetBackground = 'white' | 'transparent' | 'auto';

/** 各策略对应的 header 尾句（`auto` = 空 ⇒ 整句省略）。 */
const SHEET_BACKGROUND_CLAUSE: Record<EmojiSheetBackground, string> = {
	white: 'flat clean white background',
	transparent: 'isolated on transparent background',
	auto: '',
};

/** 任意 widget 值 → 合法策略（非法/未设置回落 `auto`：不干预用户 prompt）。 */
export function resolveSheetBackground(v: unknown): EmojiSheetBackground {
	return v === 'white' || v === 'transparent' ? v : 'auto';
}

/** 默认整版分辨率（与 registry `size` 默认值 / 模板 EmptyLatentImage 一致）。 */
const SHEET_SIZE_FALLBACK = { width: 1024, height: 1024 };

/**
 * 任意 widget 值 → 整版生成分辨率（2026-09-02）。
 *
 * 接受 `1024x1024` / `1024×1024`（中文乘号，UI 标签里常见）/ `1024*1024`；
 * 非法或缺失 → 回落 1024×1024。宽高各自 clamp 到 [256, 2048] 并**对齐 64**
 * （SDXL latent 打包要求 8 的倍数，64 对齐更稳且避免奇怪尺寸炸显存）。
 */
export function resolveEmojiSheetSize(v: unknown): { width: number; height: number } {
	const raw = typeof v === 'string' ? v.trim() : '';
	const m = /^(\d{3,4})\s*[xX×*]\s*(\d{3,4})$/.exec(raw);
	if (!m) { return { ...SHEET_SIZE_FALLBACK }; }
	const w = Math.round(Number(m[1]) / 64) * 64;
	const h = Math.round(Number(m[2]) / 64) * 64;
	const clamp = (n: number) => Math.max(256, Math.min(2048, n));
	return { width: clamp(w), height: clamp(h) };
}

/**
 * ComfyUI 渠道的尺寸注入器（promptPostProcess 形状）：覆盖 prompt 里所有
 * latent 空图节点（EmptyLatentImage / EmptySD3LatentImage）的 width/height。
 *
 * 遍历而非按固定节点号——图集模板（节点 "4"）与单格模板（节点 "5" / "6"）
 * 的 latent 节点号不同，写死会漏掉其一。
 */
function makeSizePostProcess(width: number, height: number): StageWorkflowRunOptions['promptPostProcess'] {
	return (prompt) => {
		const nodes = prompt as Record<string, { class_type?: string; inputs?: Record<string, unknown> } | undefined>;
		for (const key of Object.keys(nodes ?? {})) {
			const n = nodes[key];
			if (!n?.inputs || typeof n.class_type !== 'string') { continue; }
			if (!/LatentImage$/.test(n.class_type)) { continue; }
			n.inputs.width = width;
			n.inputs.height = height;
		}
	};
}

/** 组合多个 promptPostProcess（img2img 切换 + 尺寸注入可叠加）。 */
function composePostProcess(
	...fns: Array<StageWorkflowRunOptions['promptPostProcess'] | undefined>
): StageWorkflowRunOptions['promptPostProcess'] | undefined {
	const list = fns.filter((f): f is NonNullable<StageWorkflowRunOptions['promptPostProcess']> => typeof f === 'function');
	if (list.length === 0) { return undefined; }
	return (prompt) => { for (const f of list) { f(prompt); } };
}

/**
 * 组装拼贴 prompt（需求4）：版式约束 + 每格描述。
 *
 * - 存在**独立格描述**（去重后 >1 种描述）→ 逐格列出 `Sticker (row r, col c): <desc>`，
 *   让模型把不同表情画进对应格位（模型对 2×2/3×3 的格位遵循度可接受，格描述
 *   越短越稳）；
 * - 所有格共用一个描述 → 只列一次 + 要求「每格不同表情变体」（共享 seed 变体模式）。
 * 纯函数。
 */
export function buildEmojiSheetPrompt(
	rows: number,
	cols: number,
	cellPrompts: string[],
	background: EmojiSheetBackground = 'auto',
): string {
	const total = rows * cols;
	const bg = SHEET_BACKGROUND_CLAUSE[background];
	const header =
		`a sticker sheet of ${total} separate die-cut cartoon stickers arranged in a strict ` +
		`${rows} rows × ${cols} columns grid layout, equal-size cells, clear thin gaps between ` +
		`stickers, each sticker fully inside its own cell with white outline` +
		(bg ? `, ${bg}` : '');
	const unique = new Set(cellPrompts.map(p => p.trim()).filter(Boolean));
	let body: string;
	if (unique.size <= 1) {
		const d = cellPrompts[0]?.trim() || 'a cute cartoon mascot';
		body = `All stickers share the same character design: ${d}. ` +
			`Each sticker shows a different facial expression / pose variation of that character.`;
	} else {
		const lines: string[] = [];
		for (let i = 0; i < total; i++) {
			const r = Math.floor(i / cols) + 1;
			const c = (i % cols) + 1;
			lines.push(`Sticker (row ${r}, col ${c}): ${cellPrompts[i]?.trim() || 'a cute cartoon mascot'}`);
		}
		body = lines.join('; ');
	}
	return `${header}. ${body}`;
}

/**
 * 从四条边 flood-fill 抠白底（就位把 alpha 置 0）。
 *
 * ★ 连通域抠图而非全局阈值：贴纸内部的白色高光/细节（被彩色轮廓包围、与格子边缘
 *   不连通）得以保留 —— 真实图实测彩色主体像素零损失、内部白 100% 保留。
 *
 * ★ protectPx（2026-09-02）：**贴纸白描边保护**，默认 **0（关闭）**。
 *   裸 flood-fill 会把与背景连通的白色描边（die-cut sticker 的 thick white
 *   outline）一并灌掉。开启后先以「不透明 + 非白」像素为源做 protectPx 轮多源
 *   BFS 膨胀（8 邻域，见函数内注释），被覆盖的白视为「贴身白」予以保留，
 *   只抠距主体 > protectPx 的背景白。
 *
 * ⚠ 默认必须为 0（真实图实测，勿凭直觉调大）：
 *   测试图 tmp/emoji-split-test/sheet.png（1254²，贴纸占格约 78%）抠除率 ——
 *     protectPx=0 → 18.3% ／ =1 → 8.9% ／ =2 → 7.5% ／ =6 → 2.9% ／ =8 → 1.5%
 *   原因：prompt 要求 "each sticker fully inside its own cell"，模型会把贴纸画满
 *   格子，背景白只剩**紧贴主体的一条窄环** ⇒ **保护 1px 就吃掉一半背景**。
 *   故默认关闭保护、优先保证背景抠干净；仅当确认模型输出粗白描边、且贴纸不占满
 *   格子（如本地 SDXL 小贴纸 / 合成图场景）时才调大。
 */
function floodFillWhiteBg(rgba: Uint8Array, w: number, h: number, protectPx = 0): void {
	const n = w * h;
	const isWhite = (i: number): boolean => {
		// ★ 透明像素也算背景通路（gpt_image_2 等输出透明 PNG：RGB=0 的透明像素
		//   否则会让 flood-fill 无种子可启动；alpha=0 本身已透明，作通路无害）
		if (rgba[i + 3] === 0) { return true; }
		const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
		// 阈值 245（2026-09-02，原 235）：白底图集里**白色主体细节**（如气团中心的
		// 白色填充 RGB≈250+）此前会被误判为背景抠空——轮廓未与底色闭合时 flood
		// 会沿缺口灌入。收紧阈值保留更白的内部细节；纯白底(255)仍满足。
		return r >= 245 && g >= 245 && b >= 245;
	};
	// ── 保护带：主体（不透明且非白）向外膨胀 protectPx 轮（8 邻域多源 BFS）─────
	// ★ 必须 8 邻域（含对角）：4 邻域膨胀出的是**菱形**（曼哈顿距离），而贴纸描边
	//   是**圆环**（欧氏距离），斜 45° 方向实际保护距离只有 protectPx/√2 —— 实测
	//   6px 描边保住 89%、10px 描边只剩 53%（斜向被削）。加对角后保护带近似方形，
	//   各向覆盖 ≥ protectPx，圆环形描边可完整保住。
	//   （抠图用的 flood 仍是 4 邻域：保护带是实心连通区，4 邻域无法穿越，无漏抠。）
	const keep = new Uint8Array(n);
	if (protectPx > 0) {
		const bfsQ = new Int32Array(n);
		let bfsHead = 0;
		let bfsTail = 0;
		for (let p = 0; p < n; p++) {
			const i = p * 4;
			// 原始透明像素不算主体（否则整片透明背景都被保护 ⇒ flood 抠不动）
			if (rgba[i + 3] > 0 && !isWhite(i)) { keep[p] = 1; bfsQ[bfsTail++] = p; }
		}
		let levelEnd = bfsTail;
		for (let step = 0; step < protectPx && bfsHead < bfsTail; step++) {
			while (bfsHead < levelEnd) {
				const p = bfsQ[bfsHead++];
				const x = p % w;
				const y = (p - x) / w;
				// 正交 4 邻
				if (x > 0 && !keep[p - 1]) { keep[p - 1] = 1; bfsQ[bfsTail++] = p - 1; }
				if (x < w - 1 && !keep[p + 1]) { keep[p + 1] = 1; bfsQ[bfsTail++] = p + 1; }
				if (y > 0 && !keep[p - w]) { keep[p - w] = 1; bfsQ[bfsTail++] = p - w; }
				if (y < h - 1 && !keep[p + w]) { keep[p + w] = 1; bfsQ[bfsTail++] = p + w; }
				// 对角 4 邻（让保护带贴合圆环形描边）
				if (x > 0 && y > 0 && !keep[p - w - 1]) { keep[p - w - 1] = 1; bfsQ[bfsTail++] = p - w - 1; }
				if (x < w - 1 && y > 0 && !keep[p - w + 1]) { keep[p - w + 1] = 1; bfsQ[bfsTail++] = p - w + 1; }
				if (x > 0 && y < h - 1 && !keep[p + w - 1]) { keep[p + w - 1] = 1; bfsQ[bfsTail++] = p + w - 1; }
				if (x < w - 1 && y < h - 1 && !keep[p + w + 1]) { keep[p + w + 1] = 1; bfsQ[bfsTail++] = p + w + 1; }
			}
			levelEnd = bfsTail;
		}
	}
	const visited = new Uint8Array(n);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;
	const push = (x: number, y: number): void => {
		if (x < 0 || y < 0 || x >= w || y >= h) { return; }
		const p = y * w + x;
		if (visited[p]) { return; }
		// ★ 保护带内不抠（保住白描边 / 闭合白主体）；且 BFS 不穿越保护带。
		if (keep[p]) { return; }
		if (!isWhite(p * 4)) { return; }
		visited[p] = 1;
		queue[tail++] = p;
	};
	for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
	for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
	while (head < tail) {
		const p = queue[head++];
		rgba[p * 4 + 3] = 0;
		const x = p % w;
		const y = (p - x) / w;
		push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
	}
}

export interface SplitSheetCell {
	dataUrl: string;
	w: number;
	h: number;
}

/** 单格裁剪框（**归一化坐标** 0-1，相对整图——与分辨率解耦，编辑器写回/执行器消费）。 */
export interface SheetCellCrop {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 解析 values.cell_crops（JSON 数组，长度须 = rows*cols，坐标 0-1）。非法 → null。 */
export function parseSheetCellCrops(raw: unknown, rows: number, cols: number): SheetCellCrop[] | null {
	if (typeof raw !== 'string' || !raw.trim()) { return null; }
	try {
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr) || arr.length !== rows * cols) { return null; }
		const out: SheetCellCrop[] = [];
		for (const it of arr) {
			const o = it as Partial<SheetCellCrop>;
			if (![o.x, o.y, o.w, o.h].every(v => typeof v === 'number' && Number.isFinite(v))) { return null; }
			const x = Math.max(0, Math.min(0.98, o.x));
			const y = Math.max(0, Math.min(0.98, o.y));
			const w = Math.max(0.02, Math.min(1 - x, o.w));
			const h = Math.max(0.02, Math.min(1 - y, o.h));
			out.push({ x, y, w, h });
		}
		return out;
	} catch {
		return null;
	}
}

/** 等分默认裁剪框（marginRatio 内缩），归一化。 */
export function defaultSheetCellCrops(rows: number, cols: number, marginRatio = 0.012): SheetCellCrop[] {
	const cw = 1 / cols;
	const ch = 1 / rows;
	const ix = cw * marginRatio;
	const iy = ch * marginRatio;
	const out: SheetCellCrop[] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			out.push({ x: c * cw + ix, y: r * ch + iy, w: cw - ix * 2, h: ch - iy * 2 });
		}
	}
	return out;
}

/**
 * 整表情图集 → m×n 独立小图（v7：**简单行列裁剪**）。
 *
 * 2026-09-02 方向变更：v3-v6 的连通域自动定位（CCL/归格/延伸规则/像素过滤）
 * 全部弃用——启发式在真实模型输出上反复翻车（跑偏/吞并/交叉/显小）。
 * v7 回归最简模型：**等分裁剪为默认，用户在编辑器上手动拖拽/缩放每格裁剪框
 * （cell_crops 归一化坐标）修正**——人眼校准一次，之后重裁零成本。
 *
 * 每格裁出后仍做 flood-fill 抠白底（尽力而为；棋盘格纹理背景抠不净属已知边界）。
 */
export async function splitStickerSheet(
	imgRef: string,
	rows: number,
	cols: number,
	opts: { marginRatio?: number; cutoutBg?: boolean; protectPx?: number; cellCrops?: SheetCellCrop[] | null },
	fetchImpl: typeof fetch,
): Promise<SplitSheetCell[]> {
	const blob = /^data:/i.test(imgRef) ? dataUrlToBlob(imgRef) : await (await fetchImpl(imgRef)).blob();
	const objectUrl = URL.createObjectURL(blob);
	try {
		const img = document.createElement('img');
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('表情图集解码失败（格式不支持或数据损坏）。'));
			img.src = objectUrl;
		});
		const W = img.naturalWidth;
		const H = img.naturalHeight;
		if (W <= 0 || H <= 0) { throw new Error('表情图集尺寸无效。'); }
		const full = document.createElement('canvas');
		full.width = W;
		full.height = H;
		const fctx = full.getContext('2d', { willReadFrequently: true });
		if (!fctx) { throw new Error('浏览器无法创建画布。'); }
		fctx.drawImage(img, 0, 0);

		const cutout = opts.cutoutBg !== false;
		const crops = opts.cellCrops && opts.cellCrops.length === rows * cols
			? opts.cellCrops
			: defaultSheetCellCrops(rows, cols, opts.marginRatio ?? 0.012);

		const out: SplitSheetCell[] = [];
		for (let ci = 0; ci < crops.length; ci++) {
			const rawCrop = crops[ci];
			// ★ 防御性 clamp（parseSheetCellCrops 已 clamp，但执行器不信任上游）
			const crop = {
				x: Math.max(0, Math.min(0.98, rawCrop.x)),
				y: Math.max(0, Math.min(0.98, rawCrop.y)),
				w: Math.max(0.02, rawCrop.w),
				h: Math.max(0.02, rawCrop.h),
			};
			// ★ 取整用 floor/ceil（2026-09-02）：裁剪框覆盖的源像素**一个不少**——
			//   此前 x/w 各自 Math.round 会双向收缩（最多丢 2px，切线处缺像素）。
			//   框超出图界时 clamp 到图界（不产生透明边）。
			const x0 = Math.max(0, Math.floor(crop.x * W));
			const y0 = Math.max(0, Math.floor(crop.y * H));
			const x1 = Math.min(W, Math.ceil((crop.x + crop.w) * W));
			const y1 = Math.min(H, Math.ceil((crop.y + crop.h) * H));
			const cw = Math.max(1, x1 - x0);
			const ch = Math.max(1, y1 - y0);
			const cell = document.createElement('canvas');
			cell.width = cw;
			cell.height = ch;
			const cctx = cell.getContext('2d', { willReadFrequently: true });
			if (!cctx) { throw new Error('浏览器无法创建画布。'); }
			cctx.drawImage(full, x0, y0, cw, ch, 0, 0, cw, ch);
			if (cutout) {
				const data = cctx.getImageData(0, 0, cw, ch);
				floodFillWhiteBg(new Uint8Array(data.data.buffer), cw, ch, opts.protectPx ?? 0);
				cctx.putImageData(data, 0, 0);
			}
			// eslint-disable-next-line no-console
			console.log(`[EmojiStage] split cell#${ci} src=[${x0},${y0} → ${x1},${y1}] ${cw}x${ch} crop=${JSON.stringify(crop)}`);
			out.push({ dataUrl: cell.toDataURL('image/png'), w: cw, h: ch });
		}
		return out;
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
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
 *  - `'all'`（「生成全部」已移除，改为「生成选中表情」）：先 `clearNode` 清空
 *    旧归档（否则 put 持续追加，cellRefs 会错位到后半段），再逐格执行；
 *  - `'cell'`（「生成选中表情」/「生成此表情」/ tile ⟳）：只跑 `selected_index`
 *    一格；跑完后按「旧列表 + 替换第 selIdx 项」重排回原位（网格每格最新），
 *    被替换的旧产物追加到末尾保留历史（重新生成后历史不删除，仍在 OUTPUT 显示）。
 *
 * 单格失败即返回 error，但**已成功的格保留归档**（部分成功可见）。
 *
 * ## sheet 输入直通（2026-09）
 * `sheet` 输入端口连线 → 跳过全部生成链路，直接按 rows×cols 纯裁剪上游整图。
 * 上游取图优先级：上游归档的 sheetFull 整图（port 'sheet'）> 上游最新 image
 * （外部拼贴图未必带 sheetFull 标注）。归档契约与自生成完全一致。
 */
async function runEmojiStageGrid(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, values, upstreams, store, getSpec, onProgress, signal } = input;
	const snapshotKey = input.snapshotKey ?? nodeId;
	const spec = getSpec(type);

	// ★ 整轮开始：汇总输入（rows/cols/upstreams/上游文本数/默认 workflow）。
	const initialWorkflow = typeof values.workflow === 'string' ? values.workflow : '(default)';
	// eslint-disable-next-line no-console
	console.log(
		`[EmojiStage] run start nodeId=${nodeId} rows=${values.rows} cols=${values.cols} ` +
		`workflow="${initialWorkflow}" upstreams=${upstreams?.length ?? 0}`,
	);

	const rows = clampInt(values.rows, 1, 6, 3);
	const cols = clampInt(values.cols, 1, 6, 3);
	const total = rows * cols;
	const cells = parseEmojiCells(values.cells, total);
	// 主题专属完整 prompt 模板：作为每格 prompt 的兜底主体（取代原顶部全局 prompt）。
	// 选了主题但某格手填/上游文本都空时，用该模板直接当主 prompt，而非"后缀叠加"。
	const themeTemplate = styleTemplateOf(typeof values.style_preset === 'string' ? values.style_preset : undefined);
	// ★ run_scope='recrop'（单格调整裁剪应用）必须走 **cell 语义**——它会按
	//   cell_crops 重裁现有图集。此前映射落到了 'all' → 执行开头 clearNode
	//   清空全部快照，recrop 又查不到基底图集 → 节点 OUTPUT 全空（数据丢失）。
	const scope = (values.run_scope === 'cell' || values.run_scope === 'recrop') ? 'cell' : 'all';
	const selIdx = clampInt(values.selected_index, 0, total - 1, 0);

	// ★ 上游文本 → m×n 逐格数据。两条路径（严格优先）：
	//   1. `parseEmojiCellArray`：JSON 数组 → 完整 cell（prompt/seed/text 全字段），
	//      是「严格按 JSON 数组划分」的权威来源，覆盖手填 cells 的对应格子；
	//   2. `splitEmojiPrompts`：非 JSON 文本 → 只产 prompt（多行/分隔符/单条），
	//      作为 cell.prompt 的兜底。
	//   最终每格 prompt 优先级：严格 cell.prompt > 手填 cell.prompt > 启发式 prompt > 主题模板。
	const upstreamTexts = collectUpstreamTexts(store, upstreams);
	const strictCells = parseEmojiCellArray(upstreamTexts);
	const splitPrompts = strictCells ? [] : splitEmojiPrompts(upstreamTexts);
	const splitCount = splitPrompts.length;
	// 单条上游文本 → 所有格子共用（配合不同 seed 生成变体）；多条 → 按格序分配，
	// 不足时循环复用。零条 → 无上游文本，回退 cell.prompt / 主题模板。
	const cellPromptFromText = (i: number): string => {
		if (splitCount === 0) { return ''; }
		return splitPrompts[i % splitCount];
	};

	// ★ 诊断：上游文本拆分结果（为空时用户可能误以为「接了但没生效」）。
	// eslint-disable-next-line no-console
	console.log(
		`[EmojiStage] upstream text texts=${upstreamTexts.length} strictCells=${strictCells?.length ?? 0} ` +
		`splitPrompts=${splitCount} themeTemplate=${truncateForLog(themeTemplate, 60) || '(empty)'}`,
	);

	const targets = scope === 'cell' ? [selIdx] : Array.from({ length: total }, (_, i) => i);

	// 单格模式：记录现有图/视频列表（按 index 序）用于跑完重排回原位。
	// ★ 同时统计 image 与 video：动态表情现在是 MiniMax H3 视频（mp4，kind='video'），
	//   runEmojiStageGrid 必须按 media 粒度感知，否则单格产物归档不到 cellRef（曾因
	//   kind==='image' 过滤导致 `[EmojiStage] cell #0 success but no new image entry`）。
	// ★ 格序列收集**排除图集类 entry**（2026-09-02）：静态表情包节点 byNode 里
	//   同时有独立格（port 'output'）与图集（port 'sheet' 的 sheetFull / port
	//   'image' 的合并图集 meta.sheet='1'）。图集混进 before → recrop 收尾重放
	//   时被当"格"写回 port 'output' → OUTPUT 网格里出现嵌套图集、且 cell_crops
	//   格位与列表错位（用户看到的「移动后裁剪列表错乱」）。
	//   图集不进格序列：合并图集由收尾统一重建（image 口），sheetFull 在
	//   scope='all' 的 clearNode 中清掉后由合并图集承担 recrop 基底职能。
	const isSheetEntry = (m: MediaRef): boolean => {
		const meta = (m as { meta?: Record<string, string> }).meta as Record<string, string> | undefined;
		return meta?.sheet === '1' || meta?.sheetFull === '1';
	};
	const imagesOf = (): MediaRef[] => store.byNode(snapshotKey)
		.filter(e => (e.media.kind === 'image' || e.media.kind === 'video') && !isSheetEntry(e.media))
		.map(e => e.media);
	/** 当前节点名下全部归档 key 的集合 —— 用于「跑完后按 key 差集精确定位本格新产物」。 */
	const imageKeysOf = (): Set<string> => new Set(
		store.byNode(snapshotKey).filter(e => (e.media.kind === 'image' || e.media.kind === 'video') && !isSheetEntry(e.media)).map(e => e.key),
	);
	const before: MediaRef[] = scope === 'cell' ? imagesOf() : [];

	if (scope === 'all') { store.clearNode(snapshotKey); }

	const collected: MediaSnapshotEntry[] = [];
	// 每格烘焙后的最终 media（按格 index 对齐），循环结束后清空重放。
	// 配文只烘焙到静态贴纸（PNG）；动画 webp 跳过（保动画），配文走编辑器预览层 CSS 叠加。
	const bakedByTarget = new Map<number, MediaRef>();
	let lastPromptId = '';

	// ── 渠道选择（2026-09-02）：backend='comfyui'（默认）| 'provider' ─────────
	// ComfyUI 渠道：模型下拉 values.comfy_model → 模板 option:comfy_model 注入
	//   CheckpointLoaderSimple.ckpt_name（qwen/sdxl 等本地模型）；单格路径沿用
	//   现有逐格循环（cellValues 展开 values 已携带 comfy_model）。
	// Provider 渠道：走 imagegen.generate RPC（provider/model 下拉，supportsImageGen）。
	const backend = values.backend === 'provider' ? 'provider' : 'comfyui';
	const comfyModel = typeof values.comfy_model === 'string' ? values.comfy_model.trim() : '';
	const providerIdRaw = typeof values.provider === 'string' ? values.provider.trim() : '';
	const modelIdRaw = typeof values.model === 'string' ? values.model.trim() : '';
	// ★ 外网 ref（provider 签名 URL 等）CSP 兜底——splitStickerSheet/compose 拉
	//   远程 ref 时原生 fetch 会被 webview connect-src 拦截 → forceProxy 直走
	//   host 代理（消除必败直连的 CSP 报错噪音）。
	const fetchImpl = withRemoteProxyFetch(input.fetchImpl ?? globalThis.fetch, { forceProxy: true });

	/** 每格描述解析（与循环内三级优先级一致：严格 JSON cell > 手填 > 上游文本 > 主题模板）。 */
	const resolveCellPrompt = (i: number): string => {
		const strict = strictCells?.[i];
		const cell: EmojiCellState = strict ?? cells[i] ?? { prompt: '', seed: 0, text: '' };
		return (cell.prompt || '').trim() || cellPromptFromText(i) || themeTemplate;
	};

	/**
	 * 通用收尾：把 bakedByTarget 交给函数尾部统一的「收尾重排」——
	 * 置 sheetMode=true 跳过逐格循环，重排/重放/返回值全部复用现有代码
	 * （scope='all' 清空重放、scope='cell' 替换重排，语义都正确）。
	 */
	let sheetMode = false;

	// ★ 上游参考图（images 端口连线 / 卡片钉住资产）：整图与 provider 单格共用。
	//   此前整图路径完全丢失参考图（模板纯 text2img + provider 未传 imageInput），
	//   「输入端口引入的图像没有被作为参考图使用」即此因。来源解析与单格循环
	//   同源：① 上游连线快照 ② values.comfytv_image_refs 钉住资产。
	const upstreamRefMap = collectUpstreamRefs(store, upstreams);
	applyAssetRefOverrides(upstreamRefMap, values);
	const upstreamImageRef = upstreamRefMap['image'] ?? '';
	// ★ sheet 输入直通（2026-09）：`sheet` 输入端口连线 → 取上游归档的整图图集
	//   （meta.sheetFull='1'，port 'sheet'；兜底上游最新 image——外部拼贴图上游
	//   未必带 sheetFull 标注）。调度器已把边 source 映射为上游 snapshotKey
	//   （workflowRun 主调度 inbound 构造处），byNode 直查即可。
	const sheetInputSource = input.inbound?.find(e => e.targetHandle === 'sheet')?.source ?? '';
	const upstreamSheetRef = sheetInputSource ? (() => {
		const entries = store.byNode(sheetInputSource).filter(e => e.media.kind === 'image');
		return ([...entries].reverse().find(e => e.media.meta?.sheetFull === '1')
			?? entries[entries.length - 1])?.media.ref ?? '';
	})() : '';
	// ★ 生成图像大小（2026-09-02）：整版图集分辨率，两渠道共用。
	//   provider → sendImageGen.width/height；comfyui → 覆盖模板 latent 尺寸。
	const sheetSize = resolveEmojiSheetSize(values.size);
	const sizePostProcess = makeSizePostProcess(sheetSize.width, sheetSize.height);

	// ═══ 整图图集模式（v7）：生成 m×n 拼贴整图 → **简单行列裁剪**（cell_crops 可由
	//   用户在编辑器拖拽/缩放修正）。run_scope='recrop' = 跳过生成，对上次归档的
	//   整图（port 'sheet'）按新 cell_crops 重裁——零生成成本反复校准。
	const cellCrops = parseSheetCellCrops(values.cell_crops, rows, cols);
	const isRecrop = values.run_scope === 'recrop';
	// ★ 切分 = **纯裁剪**（2026-09-03 用户要求）：生成链路不执行任何抠图
	//   （flood-fill / AI 均不跑）。透明化由两条路径覆盖：① prompt 的图集底
	//   约束（模型原生输出）；② 用户手动点「去背景」/迷你编辑器（内置 U²Net）。
	try {
		let sheetRef = '';
		let cellPromptList: string[] = [];
		// ★ sheet 直通模式（2026-09）：上游整图图集 → 跳过生成，直接切分。
		//   归档契约与自生成一致（sheetFull='1' + rows/cols meta），下游
		//   latestRoundOf / nodeCard 对账逻辑无需感知来源差异。
		if (upstreamSheetRef) {
			sheetRef = await localizeImageRef(upstreamSheetRef);
			cellPromptList = [];
			// 整图归档（port 'sheet'，meta.sheetFull='1'）：与自生成分支同契约，
			// 本节点输出 sheet 口（sheetFull 归档）供下一级 EmojiStage 直通连线。
			store.put({
				nodeId: snapshotKey,
				port: 'sheet',
				key: '',
				media: { kind: 'image', ref: sheetRef, meta: { sheetFull: '1', rows: String(rows), cols: String(cols) } },
			});
			onProgress?.({ progress: 60 });
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] sheet passthrough from=${sheetInputSource.slice(0, 40)} ref=${sheetRef.slice(0, 40)}…`);
		} else if (isRecrop) {
			// 裁剪基底 = **原生整图**（meta.sheetFull='1'）：cell_crops 是用户在
			// MiniImageEditor 的整图视图上调出来的，坐标系归属于原生整图；合并
			// 图集（sheet='1'）已被标准化重拼，几何不再对应 cell_crops。此前靠
			// 「key 字典序尾部恰好是 sheetFull」碰对——显式化，消除运气依赖。
			const sheetEntry = [...store.byNode(snapshotKey)].reverse()
				.find(e => e.media.kind === 'image' && e.media.meta?.sheetFull === '1');
			if (!sheetEntry) {
				return { promptId: '', status: 'error', error: '没有可重裁的图集——请先正常生成一次', entries: collected };
			}
			sheetRef = sheetEntry.media.ref;
			// ★ 历史归档可能是未本地化的远程签名 URL（旧版本写入/本地化失败回退）：
			//   recrop 前先本地化（幂等，data URL 原样返回），重裁产物不再续写过期 URL。
			sheetRef = await localizeImageRef(sheetRef);
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] recrop base=${sheetEntry.media.meta?.sheetFull === '1' ? 'sheetFull' : 'mergedSheet'} rows/cols=${rows}x${cols} cellCrops=${JSON.stringify(cellCrops)} ref=${sheetRef.slice(0, 40)}…`);
			// 保留上次各格 prompt 元数据（recrop 不改内容只改裁剪）
			cellPromptList = store.byNode(snapshotKey)
				.filter(e => e.port === 'output' && e.media.meta?.cellPrompt)
				.map(e => String(e.media.meta?.cellPrompt));
			onProgress?.({ progress: 30 });
		} else {
			const cellPrompts = targets.map((i) => resolveCellPrompt(i));
			// ★ 背景策略：默认 auto —— 不再强加白底，让「透明背景」的格描述生效
			//   （白底交由下方切图的 floodFillWhiteBg 兜底抠除，见 cutoutBg）。
			const sheetBg = resolveSheetBackground(values.sheet_background);
			const sheetPrompt = buildEmojiSheetPrompt(rows, cols, cellPrompts, sheetBg);
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] sheet mode backend=${backend} bg=${sheetBg} size=${sheetSize.width}x${sheetSize.height} ${rows}x${cols} prompt=${truncateForLog(sheetPrompt, 140)}`);
			onProgress?.({ progress: 5 });
			if (backend === 'provider') {
				const send = input.sendImageGen;
				if (!send) {
					return { promptId: '', status: 'error', error: 'Provider 图像生成通道未注入（imagegen.generate）', entries: collected };
				}
				let pid = providerIdRaw;
				let mid = modelIdRaw;
				if (!pid || !mid) {
					const picker = collectUpstreamProviderConfig(store, upstreams);
					if (picker) {
						pid = pid || picker.providerId;
						mid = mid || picker.modelId;
					}
				}
				if (!pid || !mid) {
					return { promptId: '', status: 'error', error: '请先在 Provider 选项卡中选择 Provider 和图像模型', entries: collected };
				}
				const resp = await raceAbort(send({
					providerId: pid,
					modelId: mid,
					prompt: sheetPrompt,
					width: sheetSize.width,
					height: sheetSize.height,
					numImages: 1,
					// ★ img2img：上游 images 端口参考图（gpt_image_2 等图生图模型）
					...(upstreamImageRef ? { imageInput: upstreamImageRef } : {}),
				}), signal);
				const first = resp?.images?.[0];
				sheetRef = first?.url ?? (first?.b64 ? `data:image/png;base64,${first.b64}` : '');
				if (!sheetRef) {
					return { promptId: '', status: 'error', error: '图像生成接口未返回图片（检查 provider 额度 / 模型是否支持文生图）', entries: collected };
				}
				// ★ 归档前本地化：provider 签名 URL 有时效（COS 2h），直接归档 →
				//   重启后 403「llm 原图消失」。拉取转 data URL 固化（失败保留原 ref）。
				sheetRef = await localizeImageRef(sheetRef);
				signal?.throwIfAborted();
			} else {
				// ComfyUI 渠道：**模型驱动组装**（2026-09-04「任意模型」）——不再按
				// comfy_model_group 挑模板，按所选模型族（qwen/flux/sd3.5/sdxl/sd15 ×
				// ckpt/unet）动态构造最终 api_json（emojiModelAdapt）。单图与图集
				// 共用同一条组装路径，任何模型都能生成。
				const seed = Math.floor(Math.random() * 0x7fffffff);
				const modelSpec = parseComfyModelValue(comfyModel || 'sd_xl_base_1.0.safetensors');
				// 参考图先 resolve 成 ComfyUI 文件名（组装侧 LoadImage 就地写入；
				// promptOverride 直通不再执行 executor 内的上游桥接）。
				let sheetRefImage: string | undefined;
				if (upstreamImageRef) {
					const resolver = input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner);
					const bridged = await raceAbort(resolver(upstreamImageRef, signal), signal);
					if (bridged.ok && bridged.image) {
						sheetRefImage = bridged.image;
					} else {
						// eslint-disable-next-line no-console
						console.warn(`[EmojiStage] sheet ref resolve failed: ${bridged.error ?? 'unknown'} → 退回 text2img`);
					}
				}
				const built = buildEmojiModelPrompt(modelSpec, {
					positive: sheetPrompt,
					negative: EMOJI_NEGATIVE_PROMPT,
					seed,
					width: sheetSize.width,
					height: sheetSize.height,
					refImage: sheetRefImage,
					denoise: sheetRefImage ? 0.75 : 1.0,
					filenamePrefix: 'ComfyTV/emoji_sheet',
				});
				// eslint-disable-next-line no-console
				console.warn(`[EmojiStage] sheet 组装 model=${built.debug}`);
				const r = await runStageWorkflow({
					runner,
					nodeId,
					snapshotKey,
					type,
					kind: spec?.comfyTV?.kind ?? 'emoji',
					workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
					values: {
						...values,
						prompt: sheetPrompt,
						main_prompt: sheetPrompt,
						comfy_model: comfyModel,
						seed,
						batch_size: 1,
					},
					upstreams,
					store,
					onProgress: (p) => onProgress?.({ progress: 5 + (typeof p.progress === 'number' ? p.progress : 0) * 0.6 }),
					signal,
					resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
					// ★ 模型驱动组装直通（跳过模板/bindings/预检），产物提取节点由组装返回
					promptOverride: built.prompt,
					promptSaveNodeId: built.saveNodeId,
				});
				lastPromptId = r.promptId || lastPromptId;
				if (r.status !== 'success') {
					return { promptId: lastPromptId, status: r.status, error: `整图图集生成失败：${r.error ?? 'unknown'}`, entries: collected };
				}
				const produced = store.byNode(snapshotKey).filter(e => e.media.kind === 'image');
				sheetRef = produced[produced.length - 1]?.media.ref ?? '';
				if (!sheetRef) {
					return { promptId: lastPromptId, status: 'error', error: '整图图集生成成功但未取到图像', entries: collected };
				}
			}
			// ★ 整图归档（port 'sheet'，meta.sheetFull='1'）：编辑器「调整裁剪」的
			//   原图来源 + recrop 的重裁输入。ownSnapshots 消费端按 port 过滤。
			//   meta 顺带带 rows/cols：下游转动态表情包接此图集时可自动对齐拆分行列。
			store.put({
				nodeId: snapshotKey,
				port: 'sheet',
				key: '',
				media: { kind: 'image', ref: sheetRef, meta: { sheetFull: '1', rows: String(rows), cols: String(cols) } },
			});
			cellPromptList = cellPrompts;
		}
		onProgress?.({ progress: 72 });
		// ★ 拆分 = 按行列（cell_crops）**纯裁剪**：不做任何抠图（2026-09-03 用户
		//   要求移除生成链路抠图）。透明化走 prompt 图集底约束或手动「去背景」。
		const cellsOut = await splitStickerSheet(sheetRef, rows, cols, { marginRatio: 0.012, cutoutBg: false, cellCrops }, fetchImpl);
		for (let i = 0; i < cellsOut.length; i++) {
			bakedByTarget.set(i, {
				kind: 'image',
				ref: cellsOut[i].dataUrl,
				meta: {
					mime: 'image/png',
					...(cellPromptList[i] ? { cellPrompt: cellPromptList[i] } : {}),
					sheetMode: '1',
					cellSize: `${cellsOut[i].w}x${cellsOut[i].h}`,
					...(cellCrops?.[i] ? { cellRect: JSON.stringify(cellCrops[i]) } : {}),
					...(isRecrop ? { recrop: '1' } : {}),
				},
			});
		}
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] sheet done (v7): ${rows}x${cols} → ${cellsOut.length} cells recrop=${isRecrop}`);
		sheetMode = true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// ★ 取消响应：abort（任务面板 ✕ / 卡片取消）→ 立即返回 canceled
		if (signal?.aborted || /AbortError/i.test(msg)) {
			return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
		}
		// eslint-disable-next-line no-console
		console.error(`[EmojiStage] sheet mode failed: ${msg}`);
		return { promptId: lastPromptId, status: 'error', error: `表情图集生成/裁剪失败：${msg}`, entries: collected };
	}
	// （2026-09-02 缝合说明：外部并行编辑的中间态在此多了一个闭合 `}`，已移除；
//    本分支即外部目标态的独立 if——scope='cell' && backend==='provider'。）
	// ★ recrop（调整裁剪应用）**只重裁现有图集，绝不调图像生成 API**——
	//   此前 scope='recrop' 映射到 cell 后会命中本分支 → 白白烧一次生成配额，
	//   且 API 新产物（可能与图集格位不符）塞进图集导致错乱。
	if (scope === 'cell' && backend === 'provider' && !isRecrop) {
		// ═══ Provider 渠道单格重生成（需求3）：只重出选中格，不影响其他格 ═══
		try {
			const send = input.sendImageGen;
			if (!send) {
				return { promptId: '', status: 'error', error: 'Provider 图像生成通道未注入（imagegen.generate）', entries: collected };
			}
			let pid = providerIdRaw;
			let mid = modelIdRaw;
			if (!pid || !mid) {
				const picker = collectUpstreamProviderConfig(store, upstreams);
				if (picker) {
					pid = pid || picker.providerId;
					mid = mid || picker.modelId;
				}
			}
			if (!pid || !mid) {
				return { promptId: '', status: 'error', error: '请先在 Provider 选项卡中选择 Provider 和图像模型', entries: collected };
			}
			const cellPrompt = resolveCellPrompt(selIdx);
			const seed = cells[selIdx]?.seed || Math.floor(Math.random() * 0x7fffffff);
			// ★ 与整版同源的背景策略：white 追加 isolated on white background（供
			//   floodFillWhiteBg 抠图）；transparent 追加 isolated on transparent
			//   background；auto 不追加 —— 让用户在格描述里写的「透明背景」生效。
			const cellBg = resolveSheetBackground(values.sheet_background);
			const cellBgClause = cellBg === 'auto' ? '' :
				cellBg === 'transparent' ? ', isolated on transparent background' : ', isolated on white background';
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] provider cell #${selIdx} bg=${cellBg} prompt=${truncateForLog(cellPrompt, 100)} seed=${seed}`);
			onProgress?.({ progress: 10 });
			const resp = await raceAbort(send({
				providerId: pid,
				modelId: mid,
				prompt: `${cellPrompt}, single die-cut sticker, thick outlines${cellBgClause}, centered`,
				width: sheetSize.width,
				height: sheetSize.height,
				numImages: 1,
				// ★ img2img：上游 images 端口参考图（与整图模式同源）
				...(upstreamImageRef ? { imageInput: upstreamImageRef } : {}),
			}), signal);
			const first = resp?.images?.[0];
			const ref = first?.url ?? (first?.b64 ? `data:image/png;base64,${first.b64}` : '');
			if (!ref) {
				return { promptId: '', status: 'error', error: '图像生成接口未返回图片', entries: collected };
			}
			// 单格也走切分管线（1×1 = 纯裁剪，不做抠图——与整图切分一致）
			const one = await splitStickerSheet(ref, 1, 1, { marginRatio: 0.01, cutoutBg: false }, fetchImpl);
			bakedByTarget.set(selIdx, {
				kind: 'image',
				ref: one[0]?.dataUrl ?? ref,
				meta: { mime: 'image/png', cellPrompt, sheetMode: 'cell' },
			});
			sheetMode = true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// ★ 取消响应（同 sheet 分支）：abort → 立即 canceled
			if (signal?.aborted || /AbortError/i.test(msg)) {
				return { promptId: '', status: 'canceled', error: '已取消', entries: collected };
			}
			// eslint-disable-next-line no-console
			console.error(`[EmojiStage] provider cell failed: ${msg}`);
			return { promptId: '', status: 'error', error: `表情生成失败：${msg}`, entries: collected };
		}
	}

	// ★ ComfyUI 渠道单格生成（2026-09-04，与 provider 单格同语义——两渠道粒度
	//   完全对齐：一个提示词 → 一张单表情贴纸 → 1×1 切分管线 → 替换选中格）。
	//   此前 comfyui 的 scope='cell' 落进通用逐格循环走模板（无单贴纸样式约束、
	//   无背景策略、产物不经 1×1 切分），行为与 provider 单格不一致。
	if (scope === 'cell' && backend === 'comfyui' && !isRecrop) {
		try {
			const cmRaw = comfyModel || 'sd_xl_base_1.0.safetensors';
			const modelSpec = parseComfyModelValue(cmRaw);
			const cellPrompt = resolveCellPrompt(selIdx);
			const seed = cells[selIdx]?.seed || Math.floor(Math.random() * 0x7fffffff);
			// ★ 与 provider 单格/整版同源的背景策略 + 单贴纸样式约束。
			const cellBg = resolveSheetBackground(values.sheet_background);
			const cellBgClause = cellBg === 'auto' ? '' :
				cellBg === 'transparent' ? ', isolated on transparent background' : ', isolated on white background';
			const cellPositive = `${cellPrompt}, single die-cut sticker, thick outlines${cellBgClause}, centered`;
			// 参考图 resolve 成 ComfyUI 文件名（组装侧 LoadImage 就地写入）。
			let cellRefImage: string | undefined;
			if (upstreamImageRef) {
				const resolver = input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner);
				const bridged = await raceAbort(resolver(upstreamImageRef, signal), signal);
				if (bridged.ok && bridged.image) { cellRefImage = bridged.image; }
			}
			const built = buildEmojiModelPrompt(modelSpec, {
				positive: cellPositive,
				negative: EMOJI_NEGATIVE_PROMPT,
				seed,
				width: sheetSize.width,
				height: sheetSize.height,
				refImage: cellRefImage,
				denoise: cellRefImage ? 0.75 : 1.0,
				filenamePrefix: 'ComfyTV/emoji_cell',
			});
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] comfyui cell #${selIdx} 组装 model=${built.debug}`);
			onProgress?.({ progress: 10 });
			const r = await runStageWorkflow({
				runner,
				nodeId,
				snapshotKey,
				type,
				kind: spec?.comfyTV?.kind ?? 'emoji',
				workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
				values: { ...values, prompt: cellPositive, main_prompt: cellPositive, comfy_model: cmRaw, seed, batch_size: 1 },
				upstreams,
				store,
				onProgress: (p) => onProgress?.({ progress: 10 + (typeof p.progress === 'number' ? p.progress : 0) * 0.8 }),
				signal,
				resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
				promptOverride: built.prompt,
				promptSaveNodeId: built.saveNodeId,
			});
			if (r.status !== 'success') {
				return { promptId: r.promptId || lastPromptId, status: r.status, error: `表情生成失败：${r.error ?? 'unknown'}`, entries: collected };
			}
			const produced = store.byNode(snapshotKey).filter(e => e.media.kind === 'image');
			const cellRef = produced[produced.length - 1]?.media.ref ?? '';
			if (!cellRef) {
				return { promptId: r.promptId || lastPromptId, status: 'error', error: '表情生成成功但未取到图像', entries: collected };
			}
			// 单格同样走 1×1 切分管线（纯裁剪，与 provider 单格/整图切分一致）。
			const one = await splitStickerSheet(cellRef, 1, 1, { marginRatio: 0.01, cutoutBg: false }, fetchImpl);
			bakedByTarget.set(selIdx, {
				kind: 'image',
				ref: one[0]?.dataUrl ?? cellRef,
				meta: { mime: 'image/png', cellPrompt, sheetMode: 'cell' },
			});
			sheetMode = true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// 取消响应（与 provider 单格分支一致）。
			if (signal?.aborted || /AbortError/i.test(msg)) {
				return { promptId: '', status: 'canceled', error: '已取消', entries: collected };
			}
			// eslint-disable-next-line no-console
			console.error(`[EmojiStage] comfyui cell failed: ${msg}`);
			return { promptId: '', status: 'error', error: `表情生成失败：${msg}`, entries: collected };
		}
	}

	if (!sheetMode) for (let n = 0; n < targets.length; n++) {
		if (signal?.aborted) {
			return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
		}
		const i = targets[n];
		const manual = cells[i] ?? { prompt: '', seed: 0, text: '' };
		// ★ 严格 JSON cell 数组优先：上游 `[{prompt,seed,text},...]` 覆盖手填 cells
		//   的对应格子（三字段全量替换）。该格无严格 cell 时回退手填。
		const strict = strictCells?.[i];
		const cell: EmojiCellState = strict ?? manual;
		// ★ prompt 优先级：严格 cell.prompt > 手填 cell.prompt > 启发式 prompt[i] > 主题模板。
		//   （编辑器「↩ 用模板」清空 cell.prompt 后，若接入了上游文本则优先用文本，
		//   否则回退主题模板 —— 模板即完整主 prompt，直接当本格 prompt 使用。）
		const cellPrompt = cell.prompt.trim() || cellPromptFromText(i) || themeTemplate;
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
		// ★ 诊断：每格详细 prompt 来源（用户报告「表情包图像混乱」期间加强）。
		//   三级优先级的实际命中，便于区分「cell.prompt 是错」「strictCells 是错」
		//   还是「prompt 没错、产物渲染就错」。
		// ⚠ 必须放在 cellValues 声明**之后**：之前引用 cellValues.duration_s 会触发
		//   TDZ（`Cannot access 'cellValues' before initialization`）——生产构建
		//   esbuild 的 `pure:['console.log']` 删除 console.log 时仍保留有副作用参数
		//   求值，导致「生成表情包卡住」（日志 Uncaught (in promise) ReferenceError）。
		// eslint-disable-next-line no-console
		console.log(
			`[EmojiStage] cell #${i}/${total} cellPromptSource=${cellPrompt === cell.prompt.trim() ? 'cell' : cellPrompt === cellPromptFromText(i) ? 'split' : 'theme'} ` +
			`prompt="${cellPrompt.slice(0, 80)}" seed=${cellSeed} duration_s=${cellValues.duration_s}`,
		);
		// ★ 本格执行前的图 key 快照 —— 跑完后用差集精确定位「本格产出的图」。
		//   不能用 `imagesOf().at(-1)`：store 里可能并存多个 port 前缀
		//   （`output:*` 由 comfyOutputsToSnapshots 写入、`output:*` 由收尾重放写入），
		//   `byNode` 按 index 排序后不同前缀会交错，末项未必是本格新图。
		const keysBeforeCell = imageKeysOf();
		// ★ Emoji 自动 fallback：先试默认模板（透明贴纸，需 LayeredDiffusion LoRA），
		//   失败时降级到「普通贴纸（无需 LoRA）」—— 覆盖 LoRA 缺失/版本不兼容/
		//   sub_batch_size 不匹配等环境问题导致的图像混乱或执行报错。
		const EMOJI_FALLBACK_LABEL = '普通贴纸 (SDXL, 无需 LoRA)';
		// ★ 检测参考图（用于 fallback 时决定是否切换 img2img 模式）。
		//   参考图有两大来源：① 上游连线快照；② 卡片上「钉住」的资产引用
		//   （values.comfytv_image_refs）。此前只取 ①，钉住的资产被完全忽略
		//   → hasRefImg=false → fallback 走 text2img，生成结果与参考资产无关。
		const upstreamRefMap = collectUpstreamRefs(store, upstreams);
		applyAssetRefOverrides(upstreamRefMap, values);
		const upstreamImageRef = upstreamRefMap['image'] ?? '';
		const hasRefImg = Boolean(upstreamImageRef);
		/** Fallback SDXL 模板的 img2img 切换：有参考图时 KSampler 接 VAEEncode + denoise=0.75 */
		const patchFallbackToImg2Img: StageWorkflowRunOptions['promptPostProcess'] = hasRefImg ? (prompt) => {
			const ks = (prompt as Record<string, unknown>)['5'] as { inputs?: Record<string, unknown> } | undefined;
			if (!ks?.inputs) return;
			ks.inputs.latent_image = ['11', 0];
			ks.inputs.denoise = 0.75;
			console.log('[EmojiStage] fallback → img2img mode (denoise=0.75)');
		} : undefined;

		const tryRunCell = async (fallback?: string): Promise<SingleNodeRunResult> => {
			const v = fallback ? { ...cellValues, workflow: fallback } : cellValues;
			const label = fallback ?? (typeof v.workflow === 'string' ? v.workflow : '(default)');
			// eslint-disable-next-line no-console
			console.log(`[EmojiStage] cell #${i} tryRunCell label="${label}" prompt=${truncateForLog(cellPrompt, 80)} seed=${cellSeed}`);
			// ★ 模型驱动组装优先（2026-09-04「任意模型」）：单格同样按 comfy_model
			//   族动态构造（768² 贴纸惯例尺寸，SD1.5 自动 clamp）。fallback 重试
			//   （fallback 参数存在）走模板路径——组装失败多为辅助模型缺失，
			//   落回内置模板兜底。
			const cmRaw = typeof v.comfy_model === 'string' ? v.comfy_model.trim() : '';
			if (cmRaw && !fallback) {
				const modelSpec = parseComfyModelValue(cmRaw);
				let cellRefImage: string | undefined;
				if (upstreamImageRef) {
					const resolver = input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner);
					const bridged = await raceAbort(resolver(upstreamImageRef, signal), signal);
					if (bridged.ok && bridged.image) { cellRefImage = bridged.image; }
				}
				const built = buildEmojiModelPrompt(modelSpec, {
					positive: cellPrompt,
					negative: EMOJI_NEGATIVE_PROMPT,
					seed: cellSeed,
					width: 768,
					height: 768,
					refImage: cellRefImage,
					denoise: cellRefImage ? 0.75 : 1.0,
					filenamePrefix: 'ComfyTV/emoji_cell',
				});
				// eslint-disable-next-line no-console
				console.warn(`[EmojiStage] cell #${i} 组装 model=${built.debug}`);
				return runStageWorkflow({
					runner,
					nodeId,
					snapshotKey,
					type,
					kind: spec?.comfyTV?.kind ?? 'emoji',
					workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
					values: v,
					upstreams,
					store,
					onProgress: (p) => {
						const inner = typeof p.progress === 'number' ? p.progress : 0;
						onProgress?.({ progress: (n + inner) / targets.length });
					},
					signal,
					resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
					promptOverride: built.prompt,
					promptSaveNodeId: built.saveNodeId,
				}).catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					// eslint-disable-next-line no-console
					console.error(`[EmojiStage] cell #${i} 组装 threw: ${msg}`);
					return {
						promptId: '',
						status: 'error' as const,
						error: msg,
						entries: [] as MediaSnapshotEntry[],
					};
				});
			}
			return runStageWorkflow({
				runner,
				nodeId,
				snapshotKey,
				type,
				kind: spec?.comfyTV?.kind ?? 'emoji',
				workflowKind: spec?.comfyTV?.workflowKind ?? 'emoji',
				values: v,
				upstreams,
				store,
				onProgress: (p) => {
					const inner = typeof p.progress === 'number' ? p.progress : 0;
					onProgress?.({ progress: (n + inner) / targets.length });
				},
				signal,
				// 钉住资产的 ref 多为 http/data URL（非 Comfy /view），必须经
				// resolveImageRef 上传给 ComfyUI，否则 LoadImage 拿不到图。
				resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
				// ★ 尺寸注入（size widget）对所有单格模板生效；fallback 模板额外切 img2img
				promptPostProcess: composePostProcess(
					sizePostProcess,
					fallback === EMOJI_FALLBACK_LABEL ? patchFallbackToImg2Img : undefined,
				),
			}).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				// eslint-disable-next-line no-console
				console.error(`[EmojiStage] cell #${i} tryRunCell label="${label}" threw: ${msg}`);
				return {
					promptId: '',
					status: 'error' as const,
					error: msg,
					entries: [] as MediaSnapshotEntry[],
				};
			});
		};
		let r = await tryRunCell();
		// ★ 取消检查（关键修复）：当前格刚结束就立即响应 abort，避免在 fallback
		//   重试 / 下一格开始前才停。否则用户点「取消」后，正在跑的格仍会跑完，
		//   视觉上像「取消没反应」。注意不能依赖 tryRunCell 内部的 throwIfAborted——
		//   它的 .catch 会把 AbortError 吞成 status:'error'，abort 信号就丢了。
		if (signal?.aborted) {
			return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
		}
		// ★ 透明模板失败时记录诊断信息（fallback 触发原因 + 执行结果）
		if (r.status !== 'success') {
			// eslint-disable-next-line no-console
			console.warn(
				`[EmojiStage] cell #${i} primary template FAILED, falling back to "${EMOJI_FALLBACK_LABEL}". ` +
				`reason=${r.error ?? 'unknown'}`,
			);
		}
		// 首次执行失败 → 自动 fallback（仅一次，避免无限重试）
		if (r.status !== 'success') {
			r = await tryRunCell(EMOJI_FALLBACK_LABEL);
			// ★ 取消检查：fallback 跑完后同样立即响应 abort（不重跑、不进下一格）
			if (signal?.aborted) {
				return { promptId: lastPromptId, status: 'canceled', error: '已取消', entries: collected };
			}
		}
		// ★ 诊断：每格最终结果（成功用哪个 workflow 出的图）。
		// eslint-disable-next-line no-console
		console.log(
			`[EmojiStage] cell #${i} result status=${r.status} entries=${r.entries.length} ` +
			`error=${r.error ? truncateForLog(r.error, 120) : 'none'}`,
		);
		lastPromptId = r.promptId || lastPromptId;
		if (r.status !== 'success') {
			// ★ 透明模板常见失败原因 → LoRA 缺失 / ComfyUI_LayeredDiffusion 未装
			//   / sub_batch_size 不匹配。给一条诊断提示（console + error 文本），
			//   用户可直接对照查环境。
			const err = r.error ?? '未知错误';
			const isLayeredDiffusionIssue = /layer_xl_transparent|vae's transparent|decoder.*transparent|LoRA|lora/i.test(err);
			const hint = isLayeredDiffusionIssue
				? '。可能原因：① models/loras/ 下缺少 layer_xl_transparent_conv.safetensors；② ComfyUI_LayeredDiffusion 自定义节点未装/版本不匹配；③ 当前已自动 fallback 到「普通贴纸」，无透明通道'
				: '';
			// eslint-disable-next-line no-console
			console.error(`[EmojiStage] cell #${i} all attempts FAILED: ${err}${hint}`);
			return {
				promptId: lastPromptId,
				status: r.status === 'canceled' ? 'canceled' : 'error',
				error: `表情 #${i} 生成失败：${err}${hint}`,
				entries: collected,
			};
		}
		collected.push(...r.entries);

		// ★ 本格产物 = 执行前后 key 差集里的图（fallback 可能产出多张）。
		//   用 store 里的 entry（已被 materializeComfyImageRefs 物化成 data: URL），
		//   **不能**用 `r.entries` —— runStageWorkflow 返回的是物化**前**的副本，
		//   ref 还是 ComfyUI `/view` URL，重启后失效。
		//
		//   EmojiStage 每格同时产出两个槽：`images`（静态贴纸）+ `animated`（动画 webp）。
		//   之前用 `producedNow.at(-1)` 取最后一张，而 comfyOutputsToSnapshots 按
		//   Object.keys 顺序遍历 → at(-1) 永远是 `animated`。动画 webp 因
		//   isAnimatedWebpRef 跳过文字烘焙（Canvas 无法无损重编码带 alpha 的动画
		//   webp），导致「动态图与描述不一致」：描述只活在编辑器 preview 层的 CSS
		//   叠字里，图本体（尤其导出/分享时）拿不到文字。
		//
		//   修复：显式取动画图作为本格主产物（不再依赖顺序 at(-1)），并把配文 caption
		//   作为结构化 meta 写入动画图 —— 描述随动画图一起归档，导出/引用时跟着图走。
		// ★ 同时识别 image + video（MiniMax H3 视频走 video 分支）
		const producedNow = store.byNode(snapshotKey)
			.filter(e => (e.media.kind === 'image' || e.media.kind === 'video') && !keysBeforeCell.has(e.key));
		// 优先取动画产物作为本格主产物：webp（AnimateDiff 动态贴纸）或 video（MiniMax H3）。
		const primaryEntry = producedNow.find(e => isAnimatedWebpRef(e.media.ref) || e.media.kind === 'video')
			?? producedNow[producedNow.length - 1];
		const latest = primaryEntry?.media;
		if (!latest) {
			// 不该发生（status=success 却没新增产物）：记一条诊断，跳过该格避免用
			// 别的格子的图冒充本格产物（历史上正是这里错位造成「表情两两重复」）。
			// eslint-disable-next-line no-console
			console.warn(`[EmojiStage] cell #${i} success but no new image/video entry — skip baking`);
		} else {
			let media: typeof latest = latest;
			// ★ 视频产物（MiniMax H3 动态表情 mp4）自动转 GIF（微信表情包格式）：
			//   GIF 作为本格主产物（网格显示 GIF，kind='image'），mp4 保留在 OUTPUT 历史。
			//   转 GIF 失败不致命：回退用 mp4（网格用 <video> 渲染）。
			if (latest.kind === 'video') {
				try {
					const fetchImpl = withRemoteProxyFetch(input.fetchImpl ?? globalThis.fetch);
					const gif = await convertVideoToGif(latest.ref, EMOJI_GIF_PARAMS, fetchImpl, (p) => onProgress?.({ progress: (n + (p.value ?? 0) / 100) / targets.length }));
					const gifDataUrl = await blobToDataUrl(gif.gifBlob);
					media = {
						...latest,
						kind: 'image',
						ref: gifDataUrl,
						meta: {
							...(latest.meta ?? {}),
							mime: 'image/gif',
							gifFrames: String(gif.frames),
							gifSize: `${gif.width}x${gif.height}`,
						},
					};
					// eslint-disable-next-line no-console
					console.warn(`[EmojiStage] cell #${i} video→gif done ${gif.width}x${gif.height} ${gif.frames}帧`);
				} catch (e) {
					// eslint-disable-next-line no-console
					console.warn(`[EmojiStage] cell #${i} video→gif failed, fallback to mp4: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			bakedByTarget.set(i, media);
		}
		onProgress?.({ progress: (n + 1) / targets.length });
	}

	// 收尾重排：把（烘焙后的）media 按格序写回 store，让归档 index == 格 index，
	// 与卡片 `cellRefs`（ownSnapshots 顺序）对齐。
	//
	// ★ port 必须是 `'output'` —— 与 `comfyOutputsToSnapshots` 写入的 port 一致。
	//   曾误写成 `'images'`，导致 store 里并存 `uid:output:*` 与 `uid:images:*`
	//   两组前缀、各自从 0 独立编号；`byNode` 按 index 排序后两组交错，
	//   前 total 项变成 [A, A', B, B', …]（A' = A 的烘焙副本，无配文时 ref 相同）
	//   → 表情**两两重复**，且真正的后几格图被挤出可见范围。
	const REPLAY_PORT = 'output';
	// eslint-disable-next-line no-console
	console.warn(`[EmojiStage] 收尾重排 scope=${scope} total=${total} bakedCount=${bakedByTarget.size}`);
	if (scope === 'all') {
		// ★ 整图归档（port 'sheet'，meta.sheetFull='1'）必须**原样保留**：
		//   它是 MiniImageEditor 的裁剪基底 + 卡片「LLM 原图」缩略图来源。
		//   此前 clearNode 把它连同旧格子产物一起清掉，重排只回写格子 →
		//   sheetFull 永远不存在：缩略图不显示、双击一律走「旧版产物」降级
		//   （编辑器 decoded 尺寸 = 单格图而非整图）、裁剪框功能全部失效。
		//   （日志佐证：clearNode before: 1 entries → replay done: store now=9）
		const preservedSheet = store.byNode(snapshotKey).filter(e => e.port === 'sheet');
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] clearNode before: ${store.byNode(snapshotKey).length} entries (preserve sheet=${preservedSheet.length})`);
		store.clearNode(snapshotKey);
		let replayed = 0;
		for (let i = 0; i < total; i++) {
			const media = bakedByTarget.get(i);
			if (media) {
				// ★ meta 补 cellIndex：部分格生成失败时 ownOutputs 会**缺条目**、数组
				//   下标与格号错位 —— nodeCard 的单格编辑替换按 cellIndex 精确匹配，
				//   不能信下标。
				const mediaWithIdx: typeof media = { ...media, meta: { ...(media.meta ?? {}), cellIndex: i } };
				// skipImport=true：重放的是已入库资产，避免重复导入媒体库。
				store.put({ nodeId: snapshotKey, port: REPLAY_PORT, key: '', media: mediaWithIdx }, true);
				replayed++;
			}
		}
		// 整图归档放回（media 含 meta.sheetFull/rows/cols，原样保留）
		for (const e of preservedSheet) {
			store.put({ nodeId: snapshotKey, port: 'sheet', key: '', media: e.media }, true);
		}
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] replay done: ${replayed}/${total} entries, sheet preserved=${preservedSheet.length}, store now=${store.byNode(snapshotKey).length}`);
	} else if (scope === 'cell') {
		// 单格模式：新图被追加到末尾，需挪回 selIdx 原位。
		// 用 before（本轮开始前的列表）打底再替换第 selIdx 项。
		//
		// ⚠ 已知限制：`store.put` 只能「顺序追加」分配 index，**无法表达空洞**。
		//   因此当 before 比 selIdx 短（例如从未「生成全部」就直接点某格的
		//   「生成此表情」），该格图只能落在紧邻已有图之后的 index，而非 selIdx。
		//   要真正修好需给 MediaSnapshotStore 加稀疏写入 API；当前保持顺序语义，
		//   正常流程（先生成全部再单格重生成）不受影响。
		const baked = bakedByTarget.get(selIdx);
		if (baked) {
			const arranged = [...before];
			const replaced = arranged[selIdx]; // 被替换的旧产物（历史保留）
			arranged[selIdx] = baked;   // 越界赋值 → 稀疏数组，下面 put 时跳过空洞
			store.clearNode(snapshotKey);
			// skipImport=true：重排搬运的是已入库资产，避免重复导入媒体库。
			for (const media of arranged) {
				if (media) { store.put({ nodeId: snapshotKey, port: REPLAY_PORT, key: '', media }, true); }
			}
			// ★ 历史保留：被替换的旧产物追加到末尾（用户要求「重新生成后历史表情
			//   不要删除，仍在 outputs 显示」）。网格 cellRefs 取前 total 个 = 每格
			//   最新；末尾多出的旧产物只在 OUTPUT 预览条展示，不影响网格对齐。
			if (replaced && replaced.ref !== baked.ref) {
				store.put({ nodeId: snapshotKey, port: REPLAY_PORT, key: '', media: replaced }, true);
			}
		}
	}

	// ★ 整轮结束：汇总结果（成功/取消/error）
	// ★ image 口（2026-09-02）：编辑器「调整拆分」（拖拽/缩放裁剪框 → cell_crops）
	//   烘焙后的各格，按 rows×cols 合并回一整张**透明底图集**。下游「转动态表情包」
	//   接此口（COMFYTV_IMAGE）即可整版动图 → 逐格拆分；images 口仍输出独立表情。
	try {
		const cellRefs: string[] = [];
		for (let i = 0; i < total; i++) {
			const m = bakedByTarget.get(i);
			if (m && m.kind === 'image') { cellRefs.push(m.ref); }
		}
		if (cellRefs.length > 0) {
			onProgress?.({ progress: 97 });
			const sheetDataUrl = await composeImageGridOnChroma(cellRefs, rows, cols, 0, null, fetchImpl);
			const entry: MediaSnapshotEntry = {
				nodeId: snapshotKey,
				port: 'image',
				key: `${snapshotKey}:image:0`,
				media: {
					kind: 'image',
					ref: sheetDataUrl,
					meta: { mime: 'image/png', sheet: '1', rows: String(rows), cols: String(cols), margin: '0' },
				},
				index: 0,
			};
			store.put(entry, true /* skipImport */);
			collected.push(entry);
		}
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] image 口图集拼合失败（不影响 images 口）: ${e instanceof Error ? e.message : String(e)}`);
	}

	// eslint-disable-next-line no-console
	console.log(
		`[EmojiStage] run done collected=${collected.length}/${targets.length} ` +
		`baked=${bakedByTarget.size}/${total} promptId=${lastPromptId || '(none)'}`,
	);
	return { promptId: lastPromptId, status: 'success', entries: collected };
}

/**
 * 「转动态表情包」（Saros.AnimatedEmoji）—— provider 后端动态表情执行器。
 *
 * 与 ComfyTV.DynEmojiStage 的本质差异：视频生成不绑定 ComfyUI + MiniMax H3
 * 绿幕工作流，而是走 `videogen.generate` RPC（provider/model 由用户选择），
 * 纯 provider 后端、无需 ComfyUI runner 在线。
 *
 * 链路：
 *   1. 取上游参考图（透明贴纸 PNG，① 显式 imageInput → ② 上游 IMAGE 快照）；
 *   2. 前端把参考图合成到纯绿幕底（provider 不吃 alpha，透明区会被模型按
 *      黑/白填充不可控；主动绿底 = 抠像可控性最强的先验）；
 *   3. videogen.generate（prompt 追加绿幕强约束，1:1、768P、duration 档位）；
 *   4. 绿幕 mp4 归档（port 'video'，诊断用——抠像质量问题可回看原视频）；
 *   5. convertVideoToGridTransparentGifs：chroma-key 抠像 + 透明 GIF 编码 +
 *      ≤max_kb 压缩迭代；grid_rows×grid_cols>1 时整图动图逐帧切格（1×1 退化单图），
 *      全部格共用同一压缩档位（微信表情规范 240×240 ≤500KB 循环）；
 *   6. GIF 归档（port 'output'，kind='image' —— GIF 是图片格式，<img> 播放）。
 */
async function compositeImageOnChroma(imgRef: string, chromaColor: string, fetchImpl: typeof fetch): Promise<string> {
	const blob = /^data:/i.test(imgRef) ? dataUrlToBlob(imgRef) : await (await fetchImpl(imgRef)).blob();
	const objectUrl = URL.createObjectURL(blob);
	try {
		const img = document.createElement('img');
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('参考图解码失败（格式不支持或数据损坏）。'));
			img.src = objectUrl;
		});
		const c = document.createElement('canvas');
		c.width = Math.max(1, img.naturalWidth);
		c.height = Math.max(1, img.naturalHeight);
		const ctx = c.getContext('2d');
		if (!ctx) { throw new Error('浏览器无法创建画布。'); }
		ctx.fillStyle = chromaColor;
		ctx.fillRect(0, 0, c.width, c.height);
		ctx.drawImage(img, 0, 0);
		return c.toDataURL('image/png');
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

/**
 * 多图拼贴：把 N 张参考图按 rows×cols 网格拼成一整张图集（绿底），
 * 供图生视频一次生成整版动图（下游 convertVideoToGridTransparentGifs 用
 * 相同行列拆分——拼贴 gap 与切分 margin 同源，格间绿边在抠像时去除）。
 *
 * cell 为**正方形**：边长取全部输入图的 max(宽,高)；每图等比缩放居中 fit；
 * gap = margin × cell（与切分内缩同比例）。超出 rows×cols 的图忽略。
 */
/** ★ 导出：nodeCard 单格编辑保存后重建 image 口合并图集复用同一拼装算法
 *  （正方形 cell = max(各格 max(w,h))，等比缩放居中 fit，透明底）——保证
 *  「生成时拼装」与「编辑后重拼」产物几何一致，下游等分切割契约不变。 */
export async function composeImageGridOnChroma(
	refs: string[],
	rows: number,
	cols: number,
	margin: number,
	/** 底色；null = 透明底（表情贴纸图集拼合用） */
	chromaColor: string | null,
	fetchImpl: typeof fetch,
): Promise<string> {
	const objectUrls: string[] = [];
	try {
		const imgs: HTMLImageElement[] = [];
		for (const ref of refs.slice(0, rows * cols)) {
			const blob = /^data:/i.test(ref) ? dataUrlToBlob(ref) : await (await fetchImpl(ref)).blob();
			const objectUrl = URL.createObjectURL(blob);
			objectUrls.push(objectUrl);
			const img = document.createElement('img');
			await new Promise<void>((resolve, reject) => {
				img.onload = () => resolve();
				img.onerror = () => reject(new Error('参考图解码失败（格式不支持或数据损坏）。'));
				img.src = objectUrl;
			});
			imgs.push(img);
		}
		if (imgs.length === 0) { throw new Error('没有可拼贴的参考图。'); }
		// ★ 正方形 cell（2026-09-02）：cell 取全部输入图 max(宽,高)——行列相同 =
		//   正方形图集、每格正方形，切分格也正方形（此前宽高各取 max 会拼出矩形格）。
		const cell = Math.max(1, ...imgs.map(i => Math.max(i.naturalWidth || 1, i.naturalHeight || 1)));
		const gap = Math.round(cell * margin);
		// ★ 贴纸安全内边距（2026-09-03）：表情贴纸 PNG 的角色 bounding 满幅（顶天立
		//   地），直接铺满 cell → 视频模型动作一上移/放大，头部立刻越出格边界 →
		//   下游切分（含内缩）把越界部分裁掉 = **头顶/边缘被切**（用户实测）。绘制
		//   时每图缩到 cell 的 92%（四周各留 4%）给动作位移留余量；cell 网格等分
		//   结构不变，下游切分对齐不受影响。
		const SAFE_PAD = 0.04;
		const drawScale = 1 - SAFE_PAD * 2;
		const c = document.createElement('canvas');
		c.width = cols * cell + (cols + 1) * gap;
		c.height = rows * cell + (rows + 1) * gap;
		const ctx = c.getContext('2d');
		if (!ctx) { throw new Error('浏览器无法创建画布。'); }
		if (chromaColor) {
			ctx.fillStyle = chromaColor;
			ctx.fillRect(0, 0, c.width, c.height);
		}
		imgs.forEach((img, i) => {
			const r = Math.floor(i / cols);
			const col = i % cols;
			const x = gap + col * (cell + gap);
			const y = gap + r * (cell + gap);
			const s = Math.min(cell / (img.naturalWidth || 1), cell / (img.naturalHeight || 1)) * drawScale;
			const w = (img.naturalWidth || 1) * s;
			const h = (img.naturalHeight || 1) * s;
			ctx.drawImage(img, x + (cell - w) / 2, y + (cell - h) / 2, w, h);
		});
		return c.toDataURL('image/png');
	} finally {
		for (const u of objectUrls) { URL.revokeObjectURL(u); }
	}
}

const ANIMATED_EMOJI_GREEN_SUFFIX =
	', solid pure green background #00FF00, uniform flat green screen backdrop, ' +
	'subject stays centered, background remains solid green in every frame, ' +
	'no background changes, no camera movement, loop-friendly subtle motion';

/** 网格拼贴模式（grid>1）追加的逐格独立运动约束（对冲视频模型的全局运动倾向）。 */
const ANIMATED_EMOJI_GRID_SUFFIX =
	', grid collage of separate emoji stickers, each sticker animates independently ' +
	'within its own grid cell, stickers never move across cell borders, each cell ' +
	'keeps its own position, no global movement, no zooming, ' +
	'all motion effects (particles, tears, sparks, text) must stay strictly inside ' +
	'their own cell, keep the green gaps between stickers completely empty';

export async function runAnimatedEmoji(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const send = input.sendVideoGen;
	if (!send) {
		return { ...empty, error: 'Provider 视频生成通道未注入（videogen.generate）' };
	}
	// provider/model 解析（与 runProviderVideo 同序：① 显式 widget → ② 上游 Picker）
	let providerId = typeof values.videoProvider === 'string' && values.videoProvider
		? values.videoProvider
		: typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.videoModel === 'string' && values.videoModel
		? values.videoModel
		: typeof values.modelId === 'string' ? values.modelId : '';
	const picker = providerId && modelId
		? undefined
		: collectUpstreamProviderConfig(input.store, input.upstreams);
	if (picker) {
		providerId = providerId || picker.providerId;
		modelId = modelId || picker.modelId;
	}
	if (!providerId || !modelId) {
		return { ...empty, error: '请先在节点设置中选择 Provider 和视频生成模型' };
	}
	// 参考图：① 显式 imageInput（单图，优先）→ ② 上游 IMAGE 快照。上游传入
	// **多张**图时自动拼贴成 m×n 图集（行列与切分 grid_rows×grid_cols 对齐）：
	// 拼图集 → 整图一次生成动图 → 逐格拆分（convertVideoToGridTransparentGifs），
	// 每格对应一张输入贴纸的动图。参考图应为透明背景 PNG（普通照片无 alpha 时
	// 绿底合成不改变外观 → 抠像会把背景整块抠掉，编辑器文案已提示该边界）。
	// ★ chroma_enable（2026-09-03）：**非透明背景图像**（照片/带底插画）不适用
	//   绿幕+抠像（无绿幕可抠，抠像会把背景整块抠掉）→ 关闭后：不合成绿底、
	//   抠像容差清零（全保留），产出**保留原背景**的逐格 GIF。
	// ★ forceProxy：provider 视频产物落在 COS 签名 URL（无 CORS 头，CSP
	//   connect-src 必拦）→ 直连 100% 失败且每次刷 CSP 报错，直接走 host 代理。
	const fetchImpl = withRemoteProxyFetch(input.fetchImpl ?? globalThis.fetch, { forceProxy: true });
	const chromaEnabled = !(values.chroma_enable === false || values.chroma_enable === 'false');
	// ★ 生成渠道（2026-09-03）：comfyui（本地视频工作流 I2V）/ provider（RPC）
	const backend = values.backend === 'comfyui' ? 'comfyui' : 'provider';
	const chromaColor = typeof values.chroma_color === 'string' && values.chroma_color ? values.chroma_color : '#00FF00';
	// let：消费上游图集时 margin 会**对齐图集 meta**（图集几何是既成事实）
	// grid_margin 兜底 0.1（2026-09-03）：3×3 实测默认 0.03 时「隔离带(gap)+内缩」
	// 合计 ≈6% cell，视频模型动图元素（泪滴/星星/肢体）越界幅度轻松超过 → 邻格
	// 内容串入（用户截图实锤）。0.1 = 隔离带 10% + 内缩 10%，可吸收绝大部分越界；
	// 用户 slider（0-0.2）仍可覆盖。
	let gridMargin = Math.max(0, Math.min(0.2, Number.isFinite(Number(values.grid_margin)) ? Number(values.grid_margin) : 0.1));
	let gridRows = Math.max(1, Math.min(6, Math.round(Number(values.grid_rows) || 1)));
	let gridCols = Math.max(1, Math.min(6, Math.round(Number(values.grid_cols) || 1)));

	const upstreamImageRefs: string[] = [];
	// 上游「图集」探测：静态表情包的 image 口输出带 meta.sheet/rows/cols 的整版
	// 图集（composeImageGridOnChroma 写入）——单图输入时自动按其行列拆分，
	// 消除「手动把 grid_rows×grid_cols 对齐图集」的易错步骤。
	//
	// ★ 端口精确路由（2026-09-02）：静态表情包节点 byNode 里**同时**存在
	//   独立表情格（images 口）与图集 entry（image 口，meta.sheet='1'）——
	//   快照不按 port 过滤，二者混在同一列表。按 inbound 边的 **sourceHandle**
	//   （源输出口名）决定消费语义：
	//     - 连 'image' 口 → **仅引用图集整图**（单图路径，meta 行列自动拆分）
	//     - 连 'images' 口 / 无 handle（存量图）→ 独立格（多图拼贴），sheet 兜底
	let upstreamSheetGrid: { rows: number; cols: number; margin: number } | undefined;
	let upstreamSheetRef = '';
	{
		// upstream uid → 该连线源端口（同 uid 多条边时取第一条有 handle 的）
		const handleByUid = new Map<string, string>();
		for (const b of input.inbound ?? []) {
			if (b.source && b.sourceHandle && !handleByUid.has(b.source)) { handleByUid.set(b.source, b.sourceHandle); }
		}
		const cellRefs: string[] = [];
		let anyCellSource = false;
		if (input.store && input.upstreams?.length) {
			for (const uid of input.upstreams) {
				const portWanted = handleByUid.get(uid); // 'image' | 'images' | undefined（存量图/非表情节点）
				// ★ latestRoundOf：只取「最新一轮」格子——快照按次**追加**不清理，
				//   byNode 会把 EmojiStage 历史轮全混进来（9 旧 + 16 新 → 计数膨胀，
				//   拼贴图集也把废格拼进去）。
				const round = input.store.latestRoundOf(uid);
				if (round.sheet && !upstreamSheetRef) {
					// 第一个有 sheet 的上游：图集取**最新**（旧逻辑取 byNode 第一个 = 最旧轮）
					upstreamSheetRef = round.sheet.entry.media.ref;
					if (round.sheet.rows >= 1 && round.sheet.cols >= 1) {
						upstreamSheetGrid = { rows: round.sheet.rows, cols: round.sheet.cols, margin: round.sheet.margin };
					}
				}
				for (const e of round.cells) {
					// 连的是 image 口 → 该上游只消费图集（格跳过）
					if (portWanted === 'image') { continue; }
					if (!cellRefs.includes(e.media.ref)) { cellRefs.push(e.media.ref); }
				}
				// 连的是 image 口 → 该上游只消费图集
				if (portWanted === 'image' && round.sheet) { upstreamImageRefs.push(round.sheet.entry.media.ref); }
				if (portWanted === 'images' || portWanted === undefined) { anyCellSource = true; }
			}
		}
		if (upstreamImageRefs.length === 0) {
			// 没有按口命中的（连 images 口但格尚未生成 / 非表情上游）→ 兜底：
			// 有独立格用独立格（多图拼贴），否则图集整图。
			if (cellRefs.length > 0) { upstreamImageRefs.push(...cellRefs); }
			else if (upstreamSheetRef) { upstreamImageRefs.push(upstreamSheetRef); }
			void anyCellSource;
		}
	}

	let imageInput: string;
	if (typeof values.imageInput === 'string' && values.imageInput) {
		imageInput = values.imageInput;
	} else if (upstreamImageRefs.length > 1) {
		// 多图拼贴：行列策略——用户显式设置了 grid（>1 且 rows*cols 装得下）用
		// 用户的；否则按张数取近似方形（cols=ceil(sqrt(n))，rows=ceil(n/cols)）。
		const n = upstreamImageRefs.length;
		if (!(gridRows > 1 || gridCols > 1) || gridRows * gridCols < n) {
			gridCols = Math.min(6, Math.ceil(Math.sqrt(n)));
			gridRows = Math.min(6, Math.ceil(n / gridCols));
		}
		onProgress?.({ progress: 3 });
		// 抠像关闭 → 拼贴底色传 null（透明底保留原背景）
		imageInput = await composeImageGridOnChroma(upstreamImageRefs, gridRows, gridCols, gridMargin, chromaEnabled ? chromaColor : null, fetchImpl);
	} else if (upstreamImageRefs.length === 1) {
		imageInput = upstreamImageRefs[0];
	} else {
		return { ...empty, error: '转动态表情包需要上游参考图输入（请先连接并运行一个图像节点）。' };
	}
	// ★ 上游图集网格自动对齐：单图输入（含显式 imageInput 指向图集）且用户未
	//   显式设置 grid（1×1）时，自动采用图集 meta 的行列——拆分与上游静态表情
	//   包编辑器的调整严格对齐，无需手动同步 grid_rows×grid_cols。
	// ★ margin 语义澄清（2026-09-03 二次修正）：convertVideoToGridTransparentGifs
	//   的 grid.margin 是**切格内缩**（吸收邻格渗入/全局抖动），与拼装 gap 是
	//   两个概念；当前所有图集均为无缝等分（拼装 margin=0），等分切分天然对齐，
	//   内缩量应**交还用户 slider**——上一轮把它覆盖成图集 meta.margin(0) 属于
	//   矫枉过正（渗入吸收失效，切出串色边）。
	if (upstreamImageRefs.length <= 1 && !(gridRows > 1 || gridCols > 1) && upstreamSheetGrid) {
		gridRows = upstreamSheetGrid.rows;
		gridCols = upstreamSheetGrid.cols;
	}
	const isGrid = gridRows > 1 || gridCols > 1;
	// prompt：动作描述可选（图生视频以参考图为主体）——① 显式 widget ② 上游
	// TEXT 快照（texts 端口连线）。绿幕/网格约束后缀恒定追加（背景控制不依赖
	// 用户输入）。上游 TEXT 来自 resolveUpstreamSnapshotText（与 runProviderVideo 同源）。
	const widgetPrompt = typeof values.prompt === 'string' ? values.prompt.trim() : '';
	const rawPrompt = widgetPrompt || resolveUpstreamSnapshotText(store, input.upstreams).trim();

	// ★ 抠像关闭 → similarity/smoothness 归零（chromaKeyFrame 零像素被判透明 →
	//   产出**保留原背景**的逐格 GIF，管线复用）；绿幕约束后缀也不追加
	//   （否则视频模型仍会把背景画成绿幕）。
	const chromaSimilarity = chromaEnabled && Number.isFinite(Number(values.chroma_similarity)) ? Number(values.chroma_similarity) : 0;
	const chromaSmoothness = chromaEnabled && Number.isFinite(Number(values.chroma_smoothness)) ? Number(values.chroma_smoothness) : 0;
	const fps = Math.max(6, Math.min(15, Math.round(Number(values.fps) || 12)));
	const maxKb = Math.max(100, Math.min(2000, Math.round(Number(values.max_kb) || 500)));
	const durationS = Math.max(2, Math.min(5, Math.round(Number(values.duration_s) || 3)));
	// 后缀以 ', ' 开头——rawPrompt 为空时去掉前导逗号（避免「， solid pure…」）
	const prompt = rawPrompt
		? `${rawPrompt}${chromaEnabled ? ANIMATED_EMOJI_GREEN_SUFFIX : ''}${isGrid ? ANIMATED_EMOJI_GRID_SUFFIX : ''}`
		: `${chromaEnabled ? ANIMATED_EMOJI_GREEN_SUFFIX.slice(2) : ''}${isGrid ? ANIMATED_EMOJI_GRID_SUFFIX.slice(2) : ''}`;

	try {
		// ① 绿底合成（跨源 ref 必须先 fetch 成 blob 再 objectURL，防画布污染）。
		//    多图模式：imageInput 已是拼贴图集（composeImageGridOnChroma 内含绿底），
		//    这里再过一次 compositeImageOnChroma 幂等无害（透明区→绿底）。
		//    ★ chroma_enable=false → **跳过合成**（保留原背景直喂视频模型）。
		onProgress?.({ progress: 5 });
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] run start nodeId=${nodeId} backend=${backend}${backend === 'comfyui' ? ` workflow=${String(values.workflow ?? '')}` : ` provider=${providerId} model=${modelId}`} duration=${durationS}s grid=${gridRows}x${gridCols} chroma=${chromaEnabled ? 'on' : 'off'}`);
		const seedImage = chromaEnabled ? await compositeImageOnChroma(imageInput, chromaColor, fetchImpl) : imageInput;

		// ② 视频生成（双渠道，2026-09-03）：
		//   - comfyui：本地视频工作流（VIDEO_BUILTIN_WORKFLOWS 的 I2V，如 Local
		//     MiniMax H3 I2V / Qwen Emoji Video），参考图经 upstreams 进 LoadImage；
		//   - provider：videogen RPC（1:1 方形、768P；raceAbort 可取消）。
		//   两渠道产物统一为 videoUrl → ③④ 抠像/切分管线完全复用。
		let videoUrl = '';
		if (backend === 'comfyui') {
			const workflowName = typeof values.workflow === 'string' && values.workflow.trim()
				? values.workflow.trim()
				: '';
			if (!workflowName) {
				return { ...empty, error: 'ComfyUI 渠道需要选择视频工作流（生成渠道 → 工作流下拉）。' };
			}
			// runner 守卫：调度层按 backendKind='provider' 不注入 runner（comfyui
			// 渠道是后加能力）——空 runner 会在 resolveImageRef 深处崩
			// undefined.baseUrl，这里给出可行动的错误。
			if (!input.runner) {
				return { ...empty, error: 'ComfyUI 渠道需要 ComfyUI runner：请在 Runner 面板连接 ComfyUI 后重试（或切回 Provider 渠道）。' };
			}
			onProgress?.({ progress: 8 });
			// ★ seed（2026-09-03 二次）：用户在 ComfyUI 页签可固定（>0 复现同一动图）；
			//   0/未设置 = 随机。binding `option:seed`（RandomNoise.noise_seed，cast:int）
			//   缺失会被解析成 None → /prompt 400 invalid_input_type。
			const seedUser = Number(values.seed);
			const seed = Number.isFinite(seedUser) && seedUser > 0 ? Math.floor(seedUser) : Math.floor(Math.random() * 0x7fffffff);
			const r = await runStageWorkflow({
				runner: input.runner,
				nodeId,
				snapshotKey: snapKey,
				type: 'Saros.AnimatedEmoji',
				kind: 'video',
				workflowKind: 'video',
				values: { ...values, seed, workflow: workflowName, prompt, main_prompt: prompt },
				upstreams: input.upstreams,
				store,
				onProgress: (p) => onProgress?.({ progress: 8 + (typeof p.progress === 'number' ? p.progress : 0) * 0.6 }),
				signal: input.signal,
				resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
			});
			if (r.status !== 'success') {
				return { promptId: r.promptId || '', status: r.status, error: `ComfyUI 视频工作流失败：${r.error ?? 'unknown'}`, entries: [] };
			}
			const producedVideos = store.byNode(snapKey).filter(e => e.media.kind === 'video');
			videoUrl = producedVideos[producedVideos.length - 1]?.media.ref ?? '';
			if (!videoUrl) {
				return { ...empty, error: 'ComfyUI 视频工作流完成但未取到视频（检查工作流的 video 输出）。' };
			}
		} else {
			// provider 视频生成（1:1 方形、768P 档最省时；duration 按档位取整）
			// raceAbort：取消 → 立即返回 canceled（RPC promise 结果丢弃）
			onProgress?.({ progress: 8 });
			const resp = await raceAbort(send({
				providerId,
				modelId,
				prompt,
				duration: durationS,
				resolution: '768P',
				ratio: '1:1',
				imageInput: seedImage,
			}), input.signal);
			onProgress?.({ progress: 70 });
			videoUrl = resp?.videos?.[0]?.url ?? '';
			if (!videoUrl) {
				return { ...empty, error: '视频生成接口未返回视频（检查 provider 额度 / 模型是否支持图生视频）。' };
			}
		}
		// ③ 绿幕 mp4 归档（诊断用：抠像效果差时回看原视频定位是生成问题还是抠像问题）
		store.put({
			nodeId: snapKey,
			port: 'video',
			key: '',
			media: {
				kind: 'video',
				ref: videoUrl,
				meta: { greenScreen: '1', provider: providerId, model: modelId },
			},
		});

		// ④ chroma-key → 透明 GIF（≤max_kb 压缩迭代）。统一走网格管线：
		//   1×1 = 单表情（内部退化为单图路径）；m×n = 整图动图逐帧切格，
		//   全部格共用同一压缩档位（观感一致 + 省时）。
		//   ★ max_width 是**整帧**上限：网格模式 = 每格规范尺寸 × 列数
		//     （此前恒 240 → 3×3 切格后每格只剩 80×80，不满足微信 240×240）。
		const grid = await convertVideoToGridTransparentGifs(
			videoUrl,
			{ ...EMOJI_GIF_PARAMS, fps, max_width: 240 * gridCols, max_frames: durationS * fps, end_s: durationS },
			{ color: chromaColor, similarity: chromaSimilarity, smoothness: chromaSmoothness },
			{ rows: gridRows, cols: gridCols, margin: gridMargin },
			fetchImpl,
			(p) => onProgress?.({ progress: 70 + (p.value ?? 0) * 0.29 }),
			maxKb * 1024,
		);
		const entries: MediaSnapshotEntry[] = [];
		let worstBytes = 0;
		for (let gi = 0; gi < grid.gifs.length; gi++) {
			const g = grid.gifs[gi];
			const gifDataUrl = await blobToDataUrl(g.gifBlob);
			if (g.bytes > worstBytes) { worstBytes = g.bytes; }
			const overLimit = g.bytes > maxKb * 1024;
			// ★ 微信缩略图（表情开放平台规范：PNG 240×240 ≤60KB）：随 GIF 条目
			//   meta.thumb 携带（上传导出按条目取「主图+缩略图」成对提交）。
			const thumb = grid.thumbs[gi] ?? '';
			const thumbOver = thumb ? (() => {
				try { const b64 = thumb.slice(thumb.indexOf(',') + 1); return (b64.length * 3) / 4 > 60 * 1024; } catch { return false; }
			})() : false;
			const media: MediaRef = {
				kind: 'image',
				ref: gifDataUrl,
				meta: {
					mime: 'image/gif',
					gifFrames: String(g.frames),
					gifSize: `${g.width}x${g.height}`,
					gifDelayCs: String(g.delayCs),
					bytes: String(g.bytes),
					compressLevel: String(g.level),
					gridRows: String(grid.rows),
					gridCols: String(grid.cols),
					provider: providerId,
					model: modelId,
					...(thumb ? { thumb, ...(thumbOver ? { thumbOver: '1' } : {}) } : {}),
					...(overLimit ? { overLimit: '1' } : {}),
				},
			};
			store.put({ nodeId: snapKey, port: 'output', key: '', media });
			entries.push({ nodeId: snapKey, port: 'output', key: '', media, index: entries.length });
		}
		onProgress?.({ progress: 100 });
		const overLimit = worstBytes > maxKb * 1024;
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] done grid=${grid.rows}x${grid.cols} cell=${grid.cellW}x${grid.cellH} count=${entries.length} worst=${Math.round(worstBytes / 1024)}KB level=${grid.level}${overLimit ? ' (OVER LIMIT)' : ''}`);
		if (overLimit) {
			return {
				promptId: '',
				status: 'success',
				entries,
				error: `GIF 最大 ${Math.round(worstBytes / 1024)}KB 超过目标 ${maxKb}KB（已用尽压缩档位，可缩短时长/降低帧率后重试）`,
			};
		}
		return { promptId: '', status: 'success', entries };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// ★ 取消响应：abort → 立即 canceled（videogen RPC 600s 内可取消）
		if (input.signal?.aborted || /AbortError/i.test(msg)) {
			return { promptId: '', status: 'canceled', error: '已取消', entries: [] };
		}
		// eslint-disable-next-line no-console
		console.error(`[AnimatedEmoji] run threw: ${msg}`);
		return { ...empty, error: msg };
	}
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
	// ★ 视频 / 3D / 文本 / 音频生成节点必须在 isLLMImageNode **之前**判定 —— 五者都是
	//   backendKind='provider' 的 schema 节点，isLLMImageNode 会把它们一并吞掉。
	if (type === 'Saros.ModelVideoGen') { return runProviderVideo(input); }
	// 转动态表情包（provider 视频生成 + 前端抠像透明 GIF）—— 同为 provider 后端。
	if (type === 'Saros.AnimatedEmoji') { return runAnimatedEmoji(input); }
	if (type === 'Saros.Model3DGen') { return runProviderModel3D(input); }
	if (type === 'Saros.TextGen') { return runProviderText(input); }
	if (type === 'Saros.AudioGen') { return runProviderAudio(input); }
	// 微信表情包封面「导出规格化」模式：上游批量图片 → 本地 canvas 按微信素材
	// 规格转换（缩放/格式/体积控制，不走 provider）。必须在 isLLMImageNode 之前拦截。
	if (type === 'Saros.WeixinStickerCover' && input.values?.mode === '导出规格化') {
		return runWeixinStickerExport(input);
	}
	if (isLLMImageNode(getSpec(type))) { return runProviderImage(input); }
	if (isInstantNode(type)) { return runInstantNode(input); }
	// 视频转 GIF —— 浏览器本地抽帧 + GIF89a 编码（ComfyUI 无 gif 输出节点）
	if (isVideoToGifNode(type)) { return runVideoToGifNode(input); }
	// 去背景 —— 浏览器直连本地 rembg 服务（rembg_server.py，见 removeBg.ts 注释）
	if (isRemoveBgNode(type)) { return runRemoveBgNode(input); }
	if (isRelightNode(type)) { return runRelightNode(input); }
	if (isPosterNode(type)) { return runPosterNode(input); }
	if (isLayerEditorNode(type)) { return runLayerEditorNode(input); }
	if (isStoryboardEditorNode(type)) { return runStoryboardEditorNode(input); }
	if (isMultiPanelStoryboardNode(type)) { return runMultiPanelStoryboardNode(input); }
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
	// Vox 口播视频导演节点：本地 Python pipeline（非 ComfyUI 后端），必须在
	// 通用 schema 分支之前拦截（否则会走 runStageWorkflow 的占位 api_json）。
	if (isVoxDirectorNode(type)) { return runVoxDirectorNode(input); }
	// Vox 口播脚本节点：本地生成 beats.json 文本（供 DirectorStage texts 端口透传）。
	if (isVoxScriptNode(type)) { return runVoxScriptNode(input); }
	// EmojiStage 必须在通用 schema 分支之前拦截。
	//  - 静态 StatEmojiStage：m×n 网格展开成多次单图执行（每格独立 prompt/seed）。
	if (isStatEmojiStageNode(type)) { return runEmojiStageGrid({ ...input, values }); }
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
			resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
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
			inbound: runEdges.filter(e => e.target === step.id).map(e => ({ source: snapshotKeyOf?.(e.source) ?? e.source, targetHandle: e.targetHandle, sourceHandle: e.sourceHandle })),
			nodes: runNodes,
			store: snapshotStore,
			onProgress: progress,
			signal,
			sendImageGen,
			runAgentNode: options.runAgentNode,
			askUser: options.askUser,
			resolveImageGenDefaults,
			resolveLoadImageRef,
			runVoxPipeline: options.runVoxPipeline,
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
				runVoxPipeline: options.runVoxPipeline,
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
