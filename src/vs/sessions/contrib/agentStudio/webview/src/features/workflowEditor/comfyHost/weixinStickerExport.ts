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

// ★ 微信贴纸导出执行器。

export async function exportImageToSpec(
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
