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
import {
	withRemoteProxyFetch,
	localizeImageRef,
	ComfyTVSpecMeta,
	RunNode,
	isComfyExecutableSpec,
	isExecutableSpec,
	isAgentNodeType,
	isPromptNodeType,
	isGateNodeType,
	isStartNodeType,
	isMergeNodeType,
	isLoopNodeType,
	isTaskNodeType,
	isEndNodeType,
	isSkillNodeType,
	isToolNodeType,
	isAskUserNodeType,
	collectStartArgs,
	stringifyResolvedValue,
	findUnresolvedPlaceholders,
	resolveTemplateVars,
	resolvePromptVariables,
	makeNamedWithVariables,
	isLLMImageNode,
	isProviderPickerNode,
	PROVIDER_PICKER_PREFIX,
	parseProviderPickerConfig,
	collectUpstreamProviderConfig,
	collectOrchestrationValues,
	GraphRunOptions,
	GraphRunResult,
	RunProgress,
	AgentNodePayload,
	AgentNodeRunResult,
	AgentNodeSendFn,
	AskUserPayload,
	AskUserSendFn,
	NodeExecutionInput,
	isLoadImageNode,
	resolveLoadImageInputForNode,
	defaultResolveLoadImageRef,
	ImageGenSendFn,
	raceAbort,
	VideoGenSendFn,
	Model3DGenSendFn,
	TextGenSendFn,
	AudioGenSendFn,
	ImageGenProviderLike,
	resolveFirstImageGenDefaults,
	resolvePreferredImageGenDefaults,
	collectUpstreamValues,
	isPickerNode,
	isLoaderNode,
	collectUpstreamCandidates,
	resolveMediaAssetUrl,
	inferPickerKind,
	mapSnapshotKeys,
	resolveUpstreamSnapshotText,
	EmojiCellState,
	parseEmojiCells,
	clampInt,
	truncateForLog,
	collectUpstreamTexts,
	stripMarkdownCodeFence,
	extractJsonArray,
	parseEmojiCellArray,
	splitEmojiPrompts,
} from './workflowRunShared.js';

// ★ provider 通道执行器（picker/loader/image/video/m3d/text/audio + multiPanel + vox）。

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
export function isStatEmojiStageNode(type: string): boolean {
	return type === 'ComfyTV.StatEmojiStage';
}

// ─── 多宫格故事板（ComfyTV.MultiPanelStoryboardStage）本地执行 ─────────────────
//   panels_state（网格宫格内容）→ buildMultiPanelPrompt → runStageWorkflow
//   （复用 qwen 多宫格内置模板 IMAGE_QWEN_2512_MULTI_PANEL，单图直出整张 N 宫格）。
//   宫格数存 panels_state.gridCount，注入 values.grid_count 让模板 prefix 的
//   {{grid_count}} 动态替换（见 stageWorkflowExecutor.interpolateBindingTemplate）。
export async function runMultiPanelStoryboardNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
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

