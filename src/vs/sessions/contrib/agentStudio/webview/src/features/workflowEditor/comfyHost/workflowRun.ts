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
import { isFxNode, isFxChainNode } from './fxChain.js';
import type { MediaSnapshotEntry, MediaKind } from './mediaSnapshot.js';
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
import { buildExecutionPlan, buildParallelExecutionPlan, type ExecutionNodeLike, type ExecutionEdgeLike } from './executionGraph.js';
import { resolveNodeMentions, createStoreLookup } from './nodeMentions.js';
import { flattenSubflows } from './subflow.js';

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
 * Sarosis orchestration nodes (kind 'react') and unregistered nodes are skipped.
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

/** Provider image-gen node (e.g. Sarosis.ModelImageGen, kind 'llm'). */
export function isLLMImageNode(spec: { kind?: string; backendKind?: string } | undefined): boolean {
	return spec?.kind === 'llm';
}

/** Provider Picker node (Sarosis.ProviderPicker): local, no RPC — emits a TEXT config. */
export function isProviderPickerNode(type: string): boolean {
	return type === 'Sarosis.ProviderPicker';
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
 * consume. Currently: a Sarosis Prompt node's `data.prompt` feeds the stage's
 * prompt input — the first non-empty prompt wins. Pure.
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
		if (node.type === 'prompt' && out.prompt === undefined) {
			const text = data.prompt;
			if (typeof text === 'string' && text.length > 0) { out.prompt = text; }
		}
	}
	return out;
}

export interface GraphRunOptions {
	nodes: RunNode[];
	edges: ExecutionEdgeLike[];
	/** resolve the spec for a node type (from the node registry) */
	getSpec: (type: string) => { kind?: string; comfyTV?: ComfyTVSpecMeta } | undefined;
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
}

export interface GraphRunResult {
	success: boolean;
	/** true when the graph has a cycle → nothing ran */
	hasCycle: boolean;
	/** node ids that completed successfully */
	ran: string[];
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

export interface NodeExecutionInput {
	runner: IComfyRunner;
	nodeId: string;
	type: string;
	getSpec: (type: string) => { kind?: string; comfyTV?: ComfyTVSpecMeta } | undefined;
	values: Record<string, unknown>;
	/** upstream node ids — snapshots feed `upstream_*` bindings (P2) */
	upstreams?: string[];
	/** All canvas nodes (for @[node:label] mention resolution, P2). */
	nodes?: Array<{ id: string; type?: string; data?: { label?: string } }>;
	store: MediaSnapshotStore;
	onProgress?: RunProgress;
	signal?: AbortSignal;
	/** provider image-gen RPC (imagegen.generate). Injected so the module stays UI-free. */
	sendImageGen?: ImageGenSendFn;
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
export function defaultResolveLoadImageRef(runner: IComfyRunner): (ref: string) => Promise<{ ok: boolean; image?: string; error?: string }> {
	return (ref) => resolveLoadImageImageRef({
		ref,
		baseUrl: runner.baseUrl,
		fetchImpl: globalThis.fetch as unknown as BridgeFetchLike,
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

/** Local picker execution: emit the candidate chosen by selected_index (1-based, ComfyTV semantics). */
async function runPickerNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	// 优先：节点弹窗里选的媒体库历史资产（生成图片管理 P2 复用入口）
	const mediaAssetId = typeof input.values?.mediaAssetId === 'string' ? input.values.mediaAssetId : '';
	if (mediaAssetId) {
		const ref = await resolveMediaAssetUrl(mediaAssetId);
		if (ref) {
			const kind = inferPickerKind(input.type, mediaAssetId);
			const entry: MediaSnapshotEntry = { nodeId: input.nodeId, port: 'output', key: `${input.nodeId}:output:0`, media: { kind, ref }, index: 0 };
			input.store.put(entry);
			return { promptId: '', status: 'success', entries: [entry] };
		}
		return { promptId: '', status: 'error', error: '媒体库资产不可用（已删除？）', entries: [] };
	}
	const candidates = collectUpstreamCandidates(input.store, input.upstreams);
	if (!candidates.length) {
		return { promptId: '', status: 'error', error: '选择器没有上游候选：请先连接上游生成节点并执行', entries: [] };
	}
	const idx = Math.max(0, Math.min((Number(input.values?.selected_index) || 1) - 1, candidates.length - 1));
	const picked = candidates[idx];
	const entry: MediaSnapshotEntry = {
		nodeId: input.nodeId,
		port: 'output',
		key: `${input.nodeId}:output:0`,
		media: picked.media,
		index: 0,
	};
	input.store.put(entry);
	return { promptId: '', status: 'success', entries: [entry] };
}

/** 解析媒体库资产为可加载 URL（http/data 直用；本地镜像走 host 转换）。 */
async function resolveMediaAssetUrl(id: string): Promise<string | null> {
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

/** Local loader execution: emit the snapshot the user picked in the popup. */
async function runLoaderNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const mine = input.store.byNode(input.nodeId).filter(e => e.media.kind !== 'unknown');
	if (!mine.length) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中选择文件', entries: [] };
	}
	return { promptId: '', status: 'success', entries: [mine[0]] };
}

/**
 * Local Provider Picker execution (Sarosis.ProviderPicker, kind 'react'):
 * resolves an explicit provider/model (node editor values, else auto-route)
 * and emits a TEXT snapshot `provider:<providerId>:<modelId>` that downstream
 * image-gen nodes consume via `collectUpstreamProviderConfig`. No RPC.
 */
export async function runProviderPickerNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, store } = input;
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
		nodeId,
		port: 'output',
		key: `${nodeId}:output:0`,
		media: { kind: 'text', ref },
		index: 0,
	};
	store.put(entry);
	return { promptId: '', status: 'success', entries: [entry] };
}

/**
 * Execute a provider (LLM) image-gen node — `Sarosis.ModelImageGen` and other
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
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	const send = input.sendImageGen;
	if (!send) {
		return { ...empty, error: 'Provider 文生图通道未注入（imagegen.generate）' };
	}
	let providerId = typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.modelId === 'string' ? values.modelId : '';
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
					nodeId,
					port: 'output',
					key: `${nodeId}:output:${i}`,
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
 * Unified node executor shared by the single-node editor popup and the
 * workflow Run: schema nodes execute as their FULL ComfyTV workflow (degrading
 * to single-node when the runner has no ComfyTV extension), everything else
 * executes as a single ComfyUI class_type. ComfyTV fx-chain stages (builders
 * + the FX Chain terminal) run as single-node prompts with the threaded
 * fx value injected on the video input and fx-aware output extraction.
 * ComfyTV pickers/loaders (P2) resolve locally without any backend call.
 * Provider image-gen nodes (kind 'llm') run through the injected RPC.
 */
export async function runNodeOrStage(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, getSpec, upstreams, store, onProgress, signal } = input;
	let values = input.values;
	if (isProviderPickerNode(type)) { return runProviderPickerNode(input); }
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
			runner, nodeId, type, values: fxValues, store,
			// The chain terminal emits a real video snapshot (standard
			// extraction); intermediate builders emit the threaded fx value.
			extractOutputs: isFxChainNode(type) ? undefined : comfyOutputsToFxSnapshots,
			onProgress: (p) => onProgress?.({ value: p.value }),
			signal,
		});
	}
	const spec = getSpec(type);
	if (spec?.kind === 'schema') {
		return runStageWorkflow({
			runner,
			nodeId,
			type,
			kind: spec.comfyTV?.kind ?? type.replace(/^ComfyTV\./, '').replace(/Stage$/, '').toLowerCase(),
			workflowKind: spec.comfyTV?.workflowKind,
			values,
			upstreams,
			store,
			onProgress: (p) => onProgress?.({ progress: p.progress }),
			signal,
		}).catch((err: unknown): SingleNodeRunResult => {
			if (err instanceof StageWorkflowUnavailableError) {
				return runSingleNode({ runner, nodeId, type, values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
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
			return runSingleNode({ runner, nodeId, type, values: bridged.values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
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
	return runSingleNode({ runner, nodeId, type, values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
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
		mode = 'serial', parallelConcurrency = 4, taskId,
	} = options;
	const result: GraphRunResult = {
		success: false, hasCycle: false, ran: [], failed: null, results: {},
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

	const plan = buildExecutionPlan(runNodes, runEdges, type => isExecutableSpec(getSpec(type)));
	result.hasCycle = plan.hasCycle;
	if (plan.hasCycle) { return result; }
	// A ComfyUI runner is only required for schema/native nodes; a graph made
	// purely of provider (llm) nodes can run without a connected runner.
	const needsRunner = plan.steps.some(s => isComfyExecutableSpec(getSpec(s.type)));
	const runner = needsRunner ? resolveRunner() : undefined;
	if (needsRunner && !runner) { return result; }

	for (const step of plan.steps) {
		if (signal?.aborted) { break; }
		onNodeStart?.(step);
		cardState.set(step.id, { runState: 'running', progress: 5 });
		// P2-tail: orchestration nodes are skipped, but their data flows into the
		// media node's values (e.g. Prompt 文本 → prompt). Editor values win.
		const values = { ...collectOrchestrationValues(runNodes, step.upstreams), ...(nodeValues?.[step.id] ?? {}) };
		const progress = (p: { progress?: number; value?: number }) =>
			cardState.set(step.id, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
		const r = await runNodeOrStage({
			runner: runner as IComfyRunner,
			nodeId: step.id,
			type: step.type,
			getSpec,
			values,
			upstreams: step.upstreams,
			nodes: runNodes,
			store: snapshotStore,
			onProgress: progress,
			signal,
			sendImageGen,
			resolveImageGenDefaults,
			resolveLoadImageRef,
		});
		if (r.status === 'success') {
			cardState.set(step.id, { runState: 'success', progress: 100, durationMs: r.durationMs });
			result.ran.push(step.id);
			result.results[step.id] = r;
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
	const { nodes, edges, getSpec, resolveRunner, snapshotStore, cardState, nodeValues, onNodeStart, signal, sendImageGen, resolveImageGenDefaults, resolveLoadImageRef, parallelConcurrency = 4 } = options;
	const plan = buildParallelExecutionPlan(nodes, edges, type => isExecutableSpec(getSpec(type)));
	result.hasCycle = plan.hasCycle;
	if (plan.hasCycle) { return result; }
	const needsRunner = plan.layers.some(l => l.some(s => isComfyExecutableSpec(getSpec(s.type))));
	const runner = needsRunner ? resolveRunner() : undefined;
	if (needsRunner && !runner) { return result; }

	const isBackend = (step: { type: string }) => isComfyExecutableSpec(getSpec(step.type));

	const layerStats: GraphRunResult['layerStats'] = [];
	for (let li = 0; li < plan.layers.length; li++) {
		if (signal?.aborted) { break; }
		const layer = plan.layers[li];
		const backend = layer.filter(isBackend);
		const local = layer.filter(s => !isBackend(s));
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
				type: step.type,
				getSpec,
				values,
				upstreams: step.upstreams,
				nodes,
				store: snapshotStore,
				onProgress: progress,
				signal,
				sendImageGen,
				resolveImageGenDefaults,
				resolveLoadImageRef,
			});
			if (r.status === 'success') {
				cardState.set(step.id, { runState: 'success', progress: 100, durationMs: r.durationMs });
				result.ran.push(step.id);
				result.results[step.id] = r;
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
