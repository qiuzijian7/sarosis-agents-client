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

// ★ 绿幕合成（compositeImageOnChroma / composeImageGridOnChroma）。

export async function compositeImageOnChroma(imgRef: string, chromaColor: string, fetchImpl: typeof fetch): Promise<string> {
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

export const ANIMATED_EMOJI_GREEN_SUFFIX =
	', solid pure green background #00FF00, uniform flat green screen backdrop, ' +
	'subject stays centered, background remains solid green in every frame, ' +
	'no background changes, no camera movement, loop-friendly subtle motion';

/** 网格拼贴模式（grid>1）追加的逐格独立运动约束（对冲视频模型的全局运动倾向）。 */
export const ANIMATED_EMOJI_GRID_SUFFIX =
	', grid collage of separate emoji stickers, each sticker animates independently ' +
	'within its own grid cell, stickers never move across cell borders, each cell ' +
	'keeps its own position, no global movement, no zooming, ' +
	'all motion effects (particles, tears, sparks, text) must stay strictly inside ' +
	'their own cell, keep the green gaps between stickers completely empty';

