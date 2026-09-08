// ★ workflowRun 拆分（2026-09-07）：共享类型守卫/模板解析/上游收集/文本工具。
//
// ★★ 2026-09-08 修复：拆分时本文件一行 import 都没搬过来 —— sendRequest /
//    dataUrlToBlob / blobToDataUrl / findUpstreamImageRef 等全部裸用。esbuild
//    不做类型检查，裸标识符按全局保留 → 运行时 `ReferenceError: sendRequest is
//    not defined`。触发点：AnimatedEmoji 逐格链路 videogen.generate 成功返回
//    外网视频 URL 后，convertVideoToTransparentGif 经 withRemoteProxyFetch 拉
//    COS 签名 URL 走 host 代理 → 每格必炸（9 格全灭、无一归档）。
import type { IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { CardStateStore } from './cardState.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import type { MediaSnapshotEntry, MediaKind } from './mediaSnapshot.js';
import type { ExecutionNodeLike, ExecutionEdgeLike } from './executionGraph.js';
import { findUpstreamImageRef } from './imageGenBackend.js';
import { isComfyViewRef, resolveLoadImageImageRef, type BridgeFetchLike } from './imageGenToComfyBridge.js';
import { dataUrlToBlob, blobToDataUrl } from './videoToGifExecutor.js';
import { sendRequest } from '../../../bridge/messageClient.js';
import { mediaGet, resolveAssetUrl } from '../mediaAssets.js';

export function withRemoteProxyFetch(fetchImpl: typeof fetch, opts?: { forceProxy?: boolean }): typeof fetch {
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
 *
 * ★ 2026-09-08 放宽到 video/*：动态表情的绿幕原片同样是 COS 签名 URL——不固化
 *   则「重新抠图」（⟳）在签名过期后 403 失败、原片预览黑屏。mp4 几 MB dataURL
 *   可接受（3s 768P ≈ 2-5MB）。
 */
export async function localizeImageRef(ref: string): Promise<string> {
	if (!ref || !/^https?:\/\//i.test(ref)) { return ref; }
	try {
		// ★ forceProxy（2026-09-08）：外网 URL 在 webview CSP 下直连 100% 被拦
		//   （connect-src 只放行本机）——先直连只会每次刷两行 CSP 报错 + 白等
		//   一跳，直接走 host 代理。
		const resp = await withRemoteProxyFetch(fetch, { forceProxy: true })(ref);
		if (!resp.ok) { return ref; }
		const blob = await resp.blob();
		if (!blob.type.startsWith('image/') && !blob.type.startsWith('video/')) { return ref; }
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
export function mapSnapshotKeys(
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
	/**
	 * ★ 动态参数表单（可选）：非空时交互卡片渲染**输入框**而非选项按钮，
	 *   用户填写后以 `Record<key, value>` 反馈给工作流（answer = 键值对象）。
	 *   定义来自 AskUser 节点的 `params` widget（JSON 数组）。
	 */
	params?: AskUserParam[];
}
/** AskUser 动态参数定义（params widget 的 JSON 数组元素）。 */
export interface AskUserParam {
	key: string;
	label: string;
	type?: 'text' | 'number' | 'textarea';
}
/**
 * P1: injected ask-user RPC for Saros.AskUser nodes (required when the graph has one).
 * 返回：选项模式 = label 字符串（多选为数组）；**params 模式 = 键值对象**（跳过 = 空对象）。
 */
export type AskUserSendFn = (payload: AskUserPayload, timeoutMs?: number) => Promise<string | string[] | Record<string, string>>;

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
export async function runPickerNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
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
export async function runLoaderNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
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
export interface EmojiCellState { prompt: string; seed: number; text: string }

/** 解析 `cells` widget（JSON 数组），长度对齐 rows*cols。 */
export function parseEmojiCells(raw: unknown, count: number): EmojiCellState[] {
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

export function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) { return dflt; }
	return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/** 长字符串截断：单行日志用（避免 prompt 内的换行/超长把控制台刷爆）。 */
export function truncateForLog(s: string, max: number): string {
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

// ★ 上游文本读取（graphNodeExecutors 拆分时回迁 shared——多模块共用）
export function resolveUpstreamSnapshotText(store: MediaSnapshotStore, upstreams: string[] | undefined): string {
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
