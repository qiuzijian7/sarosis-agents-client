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
import { mediaGet, resolveAssetUrl, mediaList, mediaGetAsDataUrl } from '../mediaAssets.js';
import { loadCanvasImageWithProxy } from '../canvasImageLoad.js';
import { WEIXIN_EXPORT_TARGETS } from './registry.js';
import { isInstantNode } from './instantNodes.js';
import { runInstantNode } from './instantExecutor.js';
import { isVideoToGifNode, EMOJI_GIF_PARAMS } from './videoToGif.js';
import { isRemoveBgNode } from './removeBg.js';
import { runRemoveBgNode } from './removeBgExecutor.js';
import {
	runVideoToGifNode, convertVideoToGif, convertVideoToTransparentGif, blobToDataUrl, dataUrlToBlob,
	chromaKeyFrame, autoSampleChromaKeyRgba, parseChromaAlgo, firstFrameThumbDataUrl, type ChromaKeyAlgo,
} from './videoToGifExecutor.js';
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
import { splitStickerSheet, EMOJI_SHEET_MARGIN_RATIO } from './emojiSheetUtils.js';
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
import { compositeImageOnChroma, buildAnimatedEmojiVideoPrompt } from './chromaCompose.js';
import { ASSET_REFS_PROP } from './assetRefs.js';

// ★ 转动态表情包执行器（runAnimatedEmoji）。

// ═══════════════════════════════════════════════════════════════════════════
// 三阶段管线（2026-09-12）：① 生成视频 → ② 视频抠像 → ③ GIF 输出。
//
// 由来：原实现把「生成视频 → 抠像 → 编码 GIF」压在**一次运行**里——用户既看不到
// 抠像结果，也不能只调 GIF 参数（改回环/帧率必须重跑整条视频链）。先拆成两阶段
// （2026-09-11），再按用户要求把「生成视频」独立出来（2026-09-12）：
//   阶段①（run_scope='video'）：生成绿幕视频 → 归档 port='video'。不抠像、不编码。
//   阶段②（run_scope='matte'）：读 port='video' → 抠像 → 归档 port='matte'
//     （透明 PNG + 抠像参数凭据 meta.matte*）。不生成视频、不编码 GIF。
//   阶段③（run_scope='gif'）  ：读 port='video' + **阶段② 固化的抠像参数**
//     → 编码透明 GIF（port='output'）。纯编码，秒级，可反复调 GIF 参数。
//   完整链路（run_scope='all'/'cell'）＝ ①+②+③ 顺序跑（保持一键出图）。
//   rematte ＝ ②+③（跳过视频生成；UI 入口已移除，协议保留）。
// ═══════════════════════════════════════════════════════════════════════════

/** 阶段标识：'video' = 只跑①；'matte' = 只跑②；'gif' = 只跑③；'all' = ①+②+③。 */
export type AnimatedEmojiStage = 'video' | 'matte' | 'gif' | 'all';

/** 归档端口：'video' = 绿幕原片（阶段①中间产物）、'matte' = 抠像结果、'output' = 最终 GIF。 */
export type AnimatedEmojiPort = 'video' | 'matte' | 'output';

/**
 * **输入指纹**（2026-09-12 用户需求「输入新的一批图片时，阶段 1-2-3 的预览应同步
 * 更新为新的」）：归档产物时把「该格输入图指纹」写进 `meta.srcSig`；读取侧
 * （nodeCard）比对当前上游输入指纹，不一致 → 该格产物视为**过期**、不再展示
 * → 预览自动回落到新输入原图。
 *
 * 算法刻意用 `长度 + 头 24 + 尾 24`（O(1)）而不是全串哈希：data URL 常达数 MB，
 * 每次渲染全量哈希会卡（9 格 × 每次 store 变更）。不同批次的图在长度或头尾必有
 * 差异，足够判别；同一图重算结果稳定（不误判）。
 */
export function emojiInputSig(ref: string | undefined): string {
	if (!ref) { return ''; }
	return `${ref.length}:${ref.slice(0, 24)}:${ref.slice(-24)}`;
}

/**
 * 取**第 cellIndex 格**的输入指纹（读取侧 nodeCard 与写入侧执行器必须同算法）。
 *
 * ★ 回退到第 0 个：上游是「图集整图」（1 张 → 本地切分成 N 格）时 `refs` 只有
 *   1 项，此时**全部格共用同一来源**——按 `refs[cellIndex]` 取会让第 1..N-1 格
 *   拿不到指纹（→ 换批检测对它们失效）。两条路径都必须走这个入口，否则写入与
 *   读取的指纹口径不一致（格 0 误判过期）。
 */
export function emojiInputSigFor(refs: readonly string[], cellIndex: number): string {
	return emojiInputSig(refs[cellIndex] ?? refs[0]);
}

/**
 * 腾讯云 COS **签名 URL 是否已过期**（2026-09-12）。
 *
 * 签名 URL 形如 `…?q-sign-time=<start>;<end>&q-signature=…`（秒级 Unix 时间），
 * 默认有效期约 2 小时 —— 过期后拉取必 403 ✗（用户实测：阶段③ 编码 GIF 时报
 * `net.fetchAsDataUrl: HTTP 403`，整节点失败）。
 *
 * 非签名 URL / 解析失败 → **保守返回 false**（不判过期，交给实际拉取结果）✓。
 */
export function isExpiredSignedUrl(url: string | undefined, now = Date.now()): boolean {
	if (!url) { return false; }
	const m = /[?&]q-sign-time=(\d+);(\d+)/i.exec(url);
	if (!m) { return false; }
	const end = Number(m[2]);
	return Number.isFinite(end) && end > 0 && end * 1000 < now;
}

/** '#RRGGBB' → {r,g,b}；非法回退纯绿（与编辑器同款兜底）。 */
function parseHexRgb(hex: string): { r: number; g: number; b: number } {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) { return { r: 0, g: 255, b: 0 }; }
	const v = m[1];
	return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
}

/**
 * 解析选格协议（**唯一入口**，勿在分支内重复实现）：`cell_indices`（JSON 数组 /
 * 逗号分隔，0-based）优先，回退 `selected_index`（1-based 单格）。
 *
 * 返回 `null` = **未指定**（调用方按「全部」处理）——刻意不返回 `[0]`：若把
 * 「未指定」当成第 0 格，阶段② 在未选格时只会处理一格（实测语义陷阱）。
 */
function parseCellIndices(raw: unknown, selectedIndex: unknown): number[] | null {
	let indices: number[] = [];
	if (typeof raw === 'string' && raw.trim()) {
		try {
			const arr = JSON.parse(raw) as unknown;
			if (Array.isArray(arr)) { indices = arr.map(Number).filter(n => Number.isInteger(n)); }
		} catch {
			indices = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n));
		}
	}
	if (indices.length === 0) {
		const si = Math.trunc(Number(selectedIndex));
		if (Number.isFinite(si) && si >= 1) { return [si - 1]; }
		return null;
	}
	return [...new Set(indices)].filter(i => i >= 0);
}

/**
 * 阶段① 产物：从绿幕视频抽**中段一帧** → 抠像 → 透明 PNG。
 *
 * 为什么取中段而非首帧：首帧常被「首帧一致性」替换为静态贴纸，边缘质量不具
 * 代表性；中段帧才是运动中最难抠的形态。
 * 失败返回 null（不阻断主链路——抠像结果预览属增强，缺失时降级为绿幕原片预览）。
 */
async function computeMattePreview(
	videoRef: string,
	chroma: { color: string; similarity: number; smoothness: number },
	algo: ChromaKeyAlgo,
	fetchImpl: typeof fetch,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	let objectUrl = '';
	const video = document.createElement('video');
	try {
		const blob = /^data:/i.test(videoRef) ? dataUrlToBlob(videoRef) : await (await fetchImpl(videoRef)).blob();
		objectUrl = URL.createObjectURL(blob);
		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.src = objectUrl;
		await new Promise<void>((res, rej) => {
			video.onloadeddata = () => res();
			video.onerror = () => rej(new Error('视频解码失败'));
		});
		const sw = video.videoWidth || 0;
		const sh = video.videoHeight || 0;
		if (sw <= 0 || sh <= 0) { return null; }
		const scale = Math.min(1, 240 / Math.max(sw, sh));
		const w = Math.max(1, Math.round(sw * scale));
		const h = Math.max(1, Math.round(sh * scale));
		const dur = Number.isFinite(video.duration) ? video.duration : 0;
		if (dur > 0.2) {
			await new Promise<void>((res) => {
				video.onseeked = () => res();
				video.currentTime = Math.min(dur * 0.5, Math.max(0, dur - 0.05));
			});
		}
		const cv = document.createElement('canvas');
		cv.width = w;
		cv.height = h;
		const ctx = cv.getContext('2d', { willReadFrequently: true });
		if (!ctx) { return null; }
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(video, 0, 0, w, h);
		const rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer.slice(0));
		const key = chroma.color === 'auto' ? autoSampleChromaKeyRgba(rgba, w, h) : parseHexRgb(chroma.color);
		// softAlpha：预览是 PNG（8-bit 灰阶透明）——显示即真抗锯齿（GIF 链路仍 1-bit）。
		// ★ greenDominance:90（2026-09-12 用户实测「边缘的冒泡被错误的抠图」）：
		//   缺省 = max(18, band*0.35)（smoothness 0.25 时约 38）对**浅色/白色**元素过狠 ——
		//   半透明泡泡/高光叠在绿幕上像素偏绿（gExcess 可达 ~55）→ 被「绿色优势扩展
		//   清除」误删 ✗。GIF 编码链路（convertVideoToTransparentGif）早已传 90，
		//   归档抠像预览此前漏传 ⇒ 预览与产物不一致 ✗✗。现与产物同参 ✓。
		chromaKeyFrame(rgba, key, chroma.similarity, chroma.smoothness, algo, { boxFilterDistance: true, softAlpha: true, greenDominance: 90 });
		ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), w, h), 0, 0);
		return { dataUrl: cv.toDataURL('image/png'), width: w, height: h };
	} catch {
		return null;
	} finally {
		try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
		if (objectUrl) { URL.revokeObjectURL(objectUrl); }
	}
}

/** 单格「视频 → GIF」：doKey → 透明 GIF；否则带背景 GIF。阶段①②共用（勿重复实现）。 */
async function convertCellVideoToGif(opts: {
	videoRef: string;
	values: Record<string, unknown>;
	chroma: { color: string; similarity: number; smoothness: number };
	algo: ChromaKeyAlgo;
	fps: number;
	durationS: number;
	maxKb: number;
	doKey: boolean;
	fetchImpl: typeof fetch;
	firstFrameOverride?: string;
	onProgress?: (value: number) => void;
}): Promise<{ media: MediaRef; bytes: number; overLimit: boolean }> {
	const gifValues = {
		...EMOJI_GIF_PARAMS,
		fps: opts.fps,
		max_width: 240,
		max_frames: opts.durationS * opts.fps,
		end_s: opts.durationS,
		chroma_algo: opts.algo,
		// ★ 透传「首尾回环混合」开关（2026-09-12 修 bug）：gifValues 此前只来自
		//   EMOJI_GIF_PARAMS（**不含 loop_blend**）→ 编码侧恒 `undefined !== false`
		//   = 永远混合 → 编辑器里的「首尾平滑」开关**完全无效** ✗（用户关不掉，
		//   大动作时只能忍受尾帧叠影）。现按节点 widget 值透传 ✓。
		loop_blend: opts.values?.loop_blend !== false,
	};
	if (opts.doKey) {
		const gif = await convertVideoToTransparentGif(
			opts.videoRef, gifValues,
			{ color: opts.chroma.color, similarity: opts.chroma.similarity, smoothness: opts.chroma.smoothness },
			opts.fetchImpl, (p) => opts.onProgress?.(p.value ?? 0), opts.maxKb * 1024,
			opts.firstFrameOverride,
		);
		const overLimit = gif.bytes > opts.maxKb * 1024;
		const ref = await blobToDataUrl(gif.gifBlob);
		// ★ 首帧缩略图（2026-09-13）：随条目落 `meta.thumb` —— 聊天卡的**落盘副本**用它
		//   替代数百 KB 的 GIF data URL，使「重启后也能看全 9 张」（见 firstFrameThumbDataUrl
		//   注释）。失败返回 '' → 不写该键，落盘回退用原图 ✓（不阻断主链路）。
		const thumb = await firstFrameThumbDataUrl(ref);
		return {
			media: {
				kind: 'image',
				ref,
				meta: {
					mime: 'image/gif',
					gifFrames: String(gif.frames),
					gifSize: `${gif.width}x${gif.height}`,
					gifDelayCs: String(gif.delayCs),
					bytes: String(gif.bytes),
					compressLevel: String(gif.level),
					...(thumb ? { thumb } : {}),
					...(overLimit ? { overLimit: '1' } : {}),
				},
			},
			bytes: gif.bytes,
			overLimit,
		};
	}
	const gif = await convertVideoToGif(
		opts.videoRef, gifValues, opts.fetchImpl, (p) => opts.onProgress?.(p.value ?? 0),
	);
	const ref = await blobToDataUrl(gif.gifBlob);
	const thumb = await firstFrameThumbDataUrl(ref);
	return {
		media: {
			kind: 'image',
			ref,
			meta: {
				mime: 'image/gif',
				gifFrames: String(gif.frames),
				gifSize: `${gif.width}x${gif.height}`,
				gifDelayCs: String(gif.delayCs),
				matte: '0',
				...(thumb ? { thumb } : {}),
			},
		},
		bytes: gif.gifBlob.size,
		overLimit: false,
	};
}

/**
 * 归档阶段① 抠像结果（`port='matte'`）：透明 PNG + **抠像参数凭据**。
 *
 * 用途：① 编辑器阶段② 预览窗口 / 聊天卡「视频抠像」阶段的可见产物；
 * ② 阶段③「GIF 输出」按 `meta.matte*` **沿用阶段② 固化的抠像参数**（三阶段语义：
 * 阶段③ 只是把阶段② 的抠像结果编码成 GIF，不再改抠像）。
 * 失败静默（抠像结果预览属增强，GIF 才是最终产物，不得因它阻断主链路）。
 */
async function archiveMatteResult(
	store: NodeExecutionInput['store'],
	snapKey: string,
	cellIndex: number,
	srcVideo: string,
	chroma: { color: string; similarity: number; smoothness: number },
	algo: ChromaKeyAlgo,
	fetchImpl: typeof fetch,
	/** 该格**输入图指纹**（换批检测，见 emojiInputSig）；缺省不写（向后兼容）。 */
	srcSig?: string,
	/**
	 * 归档时间戳（ms）。缺省 `Date.now()`。
	 * ★ 阶段③ 自动补齐 matte 时必须传**本格 GIF 的 `gifStamp`** —— 卡片用
	 *   「matteStamp > gifStamp」判定「② 比 ③ 新 → GIF 过期」，若 ③ 自己刷新的
	 *   matte 带了更晚的时间戳，刚生成的 GIF 会被立刻误判过期 ✗。
	 */
	stamp?: number,
): Promise<void> {
	try {
		const preview = await computeMattePreview(srcVideo, chroma, algo, fetchImpl);
		if (!preview) { return; }
		const media: MediaRef = {
			kind: 'image',
			ref: preview.dataUrl,
			meta: {
				mime: 'image/png',
				matteResult: '1',
				cellIndex: String(cellIndex),
				matteSig: `${chroma.similarity}|${chroma.smoothness}|${algo}|${chroma.color}`,
				// ★ 归档时间戳（2026-09-12）：③ 预览据此判断「② 之后 GIF 是否过期」
				//   （比签名比对更普适：参数没变也照样能识别「② 刚重跑过」）。
				matteStamp: String(stamp ?? Date.now()),
				matteColor: chroma.color,
				matteSimilarity: String(chroma.similarity),
				matteSmoothness: String(chroma.smoothness),
				matteAlgo: algo,
				matteSize: `${preview.width}x${preview.height}`,
				...(srcSig ? { srcSig } : {}),
			},
		};
		// ★ 替换**最新**那条（同 ③ 的 output：卡片按 index 最大取值，替换最旧会留下
		//   「旧媒体 + 更大 index」的孤儿条目把新结果顶掉 ✗）。
		const sameCell = store.byNode(snapKey).filter(e =>
			e.port === 'matte' && Number(e.media.meta?.cellIndex ?? -1) === cellIndex);
		const prev = sameCell.length > 0
			? sameCell.reduce((a, b) => ((b.index ?? 0) > (a.index ?? 0) ? b : a))
			: undefined;
		if (prev && store.replaceByKey(prev.key, media, {
			importEntry: { nodeId: snapKey, port: 'matte', key: prev.key, media, index: prev.index },
		})) { return; }
		store.put({ nodeId: snapKey, port: 'matte', key: `cell${cellIndex}`, media });
	} catch { /* 抠像结果归档失败不阻断主链路 */ }
}

/** 媒体库本地副本索引缓存（一次运行内复用，避免每格重复 IPC）。 */
type VideoLibCache = { map: Map<string, string> | null };

/**
 * 媒体库「视频」本地副本索引（ref → assetId）。
 * ★ 用途：provider 产物是 COS 签名 URL（q-sign-time 2h）——过期后 403，
 *   而 collectAsset 已把同 ref 落盘媒体库 → 按 ref 精确匹配回退本地副本。
 */
async function ensureVideoLib(cache: VideoLibCache): Promise<Map<string, string>> {
	if (cache.map) { return cache.map; }
	const map = new Map<string, string>();
	try {
		const lib = await mediaList({ kind: 'video', limit: 500 });
		for (const a of lib.items) {
			if (!a.isDeleted && a.filePath && a.ref) { map.set(a.ref, a.id); }
		}
	} catch { /* 媒体库不可用 → 回退原 URL 链路 */ }
	cache.map = map;
	return map;
}

/**
 * 取某格**已归档的绿幕视频**（`port='video'`，meta.cellIndex 匹配，取最新），
 * 并对「外网签名 URL 过期」做本地副本兜底。返回 '' = 该格还没有视频。
 *
 * ★ 阶段②（抠像）与 rematte 共用此入口 —— 两者的「取视频」语义必须一致
 *   （否则一个能重抠、另一个报 403，属平行路径漂移）。
 */
async function resolveArchivedVideo(
	store: NodeExecutionInput['store'],
	snapKey: string,
	cellIndex: number,
	libCache: VideoLibCache,
): Promise<string> {
	const vids = store.byNode(snapKey).filter(e =>
		e.port === 'video' && e.media.kind === 'video'
		&& Number(e.media.meta?.cellIndex ?? -1) === cellIndex);
	let src = vids[vids.length - 1]?.media.ref ?? '';
	if (!src) { return ''; }
	if (/^https?:/i.test(src) && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(src)) {
		const lib = await ensureVideoLib(libCache);
		const assetId = lib.get(src);
		if (assetId) {
			const local = await mediaGetAsDataUrl(assetId);
			if (local) {
				src = local;
				// eslint-disable-next-line no-console
				console.warn(`[AnimatedEmoji] cell ${cellIndex}: 外网视频 URL 不可用，改用媒体库本地副本 (${assetId})`);
			}
		}
	}
	return src;
}

/** 取某格绿幕视频归档时记录的**输入指纹**（换批检测用；缺省 = 旧数据，不参与判定）。 */
function archivedVideoSig(store: NodeExecutionInput['store'], snapKey: string, cellIndex: number): string | undefined {
	const vids = store.byNode(snapKey).filter(e =>
		e.port === 'video' && e.media.kind === 'video'
		&& Number(e.media.meta?.cellIndex ?? -1) === cellIndex);
	const sig = vids[vids.length - 1]?.media.meta?.srcSig;
	return typeof sig === 'string' && sig ? sig : undefined;
}

export async function runAnimatedEmoji(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store, onProgress } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	// ★ 阶段解析（2026-09-12 三阶段拆分，见文件头注释）：
	//   'video' = 只跑阶段①（生成绿幕视频）；'matte' = 只跑阶段②（抠像，不生成视频）；
	//   'gif' = 只跑阶段③（转 GIF）；'rematte' = ②+③；
	//   其余（'all'/'cell'/缺省）= 完整链路 ①+②+③。
	const runScopeRaw = String(values.run_scope ?? '');
	// ★ 用 `let`（2026-09-12）：下方「阶段作用域残留保护」可能把 ②/③-only 回落成完整链路。
	let stageVideoOnly = runScopeRaw === 'video';
	let stageMatteOnly = runScopeRaw === 'matte';
	let stageGifOnly = runScopeRaw === 'gif';
	/** 是否需要「生成视频」能力（阶段① 与完整链路需要；②/③ 只读本节点快照）。 */
	const needsVideoGen = !stageMatteOnly && !stageGifOnly;
	const send = input.sendVideoGen;
	// ②/③ 不生成视频 → 不要求 videogen 通道（否则「只抠像 / 只转 GIF」被无谓拦住）。
	if (!send && needsVideoGen) {
		return { ...empty, error: 'Provider 视频生成通道未注入（videogen.generate）' };
	}
	// provider/model 解析（与 runProviderVideo 同序：① 显式 widget → ② 上游 Picker）
	let providerId = typeof values.videoProvider === 'string' && values.videoProvider
		? values.videoProvider
		: typeof values.providerId === 'string' ? values.providerId : '';
	let modelId = typeof values.videoModel === 'string' && values.videoModel
		? values.videoModel
		: typeof values.modelId === 'string' ? values.modelId : '';
	if (needsVideoGen) {
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
	// ★ 三开关解耦（2026-09-08 用户需求）：
	//   chroma_enable = 绿幕合成（静态图叠加绿底喂视频模型；关 = 原图直喂）
	//   matte_enable  = 抠像（生成后去绿幕；**需要绿幕**——绿幕关时无绿可抠，自动忽略）
	//   gif_enable    = GIF 输出（关 = 直接以生成的视频为产物）
	const chromaEnabled = !(values.chroma_enable === false || values.chroma_enable === 'false');
	const matteEnabled = !(values.matte_enable === false || values.matte_enable === 'false');
	const gifEnabled = !(values.gif_enable === false || values.gif_enable === 'false');
	const doKey = matteEnabled && chromaEnabled;   // 有效抠像 = 抠像开 且 有绿幕
	// ★ 生成渠道（2026-09-03）：comfyui（本地视频工作流 I2V）/ provider（RPC）
	const backend = values.backend === 'comfyui' ? 'comfyui' : 'provider';
	const chromaColor = typeof values.chroma_color === 'string' && values.chroma_color ? values.chroma_color : '#00FF00';
	// ★ chroma_color='auto'（2026-09-08）：绿底**合成**用固定纯绿 #00FF00（合成由
	//   我们控制，纯绿最理想）；抠像侧把 'auto' 透传给 convertVideoToTransparentGif
	//   —— 从视频首帧**采样**实际幕布色（编码会令绿漂移，采样比 fix hex 更贴合）。
	const chromaComposite = chromaColor === 'auto' ? '#00FF00' : chromaColor;
	// ★ 逐格模式（2026-09-07）：grid_rows/grid_cols/grid_margin 与整图切格路线
	//   一并移除——每格独立生成视频，无需网格几何参数。

	const upstreamImageRefs: string[] = [];
	// 上游「图集」探测：静态表情包的 image 口输出带 meta.sheet/rows/cols 的整版
	// 图集（composeImageGridOnChroma 写入）——单图输入时自动按其行列拆分，
	// 消除「手动把 grid_rows×grid_cols 对齐图集」的易错步骤。
	//
	// ★ 消费口径（2026-09-12 统一）：静态表情包节点 byNode 里**同时**存在独立表情格
	//   （images 口）与图集 entry（image 口，meta.sheet='1'）——快照不按 port 过滤。
	//   统一为「**独立格优先，无独立格才回退图集整图**」：
	//     · 与 nodeCard（「引用」缩略图区 / 预览「原图」档）**完全同序同源** ✓
	//       （此前执行器按 sourceHandle 区分、图集口只吃图集 ✗ → 产物与「引用」
	//        看到的图可能对不上，用户实测反馈）；
	//     · 永远用**最新**内容（图集可能滞后于独立格——用户在静态表情包里改过某格时，
	//       image 口图集不会同步重建）。
	//   图集整图仅作兜底：上游只产出图集（如重裁 recrop）时按其行列本地切分成单格。
	let upstreamSheetGrid: { rows: number; cols: number; margin: number } | undefined;
	let upstreamSheetRef = '';
	// ★ 逐格模式的每格动作描述（2026-09-07）：上游单格快照的 meta.cellPrompt
	//   （静态表情包生成时随格归档）→ 逐格视频生成的 prompt 组装输入。
	const cellPromptByRef = new Map<string, string>();
	{
		const cellRefs: string[] = [];
		if (input.store && input.upstreams?.length) {
			for (const uid of input.upstreams) {
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
				// ★ 独立格优先（2026-09-12 统一口径，修「预览与输入端口引用不匹配」）：
				//   此前 `sourceHandle === 'image'` 且上游有图集时走 `sheetOnly` —— 只消费
				//   图集整图、跳过独立格。但 **nodeCard（「引用」缩略图区 / 预览的「原图」档）
				//   一直是「独立格优先、无格才回退图集」** ✗ → 两边口径不一致：
				//   · 执行器按**图集**切格生成产物（图集可能是**旧版**——例如用户在静态
				//     表情包里改过某格，图集不会同步重建 ✗）；
				//   · 卡片「引用」却显示**最新独立格** ✓
				//   ⇒ 产物与「引用」看到的图对不上 ✗（用户实测反馈）。
				//   现统一为「**独立格优先，无独立格才回退图集**」——与 nodeCard 完全同序，
				//   保证「预览产物 ↔ 引用缩略图」逐格同源 ✓，且永远用最新内容 ✓。
				//   （`sheetOnly` 的原始动机是「图集与独立格内容重复，别喂两份」——现在只取
				//   一份，重复问题不存在 ✓。）
				for (const e of round.cells) {
					if (!cellRefs.includes(e.media.ref)) {
						cellRefs.push(e.media.ref);
						const cp = e.media.meta?.cellPrompt;
						if (typeof cp === 'string' && cp.trim()) { cellPromptByRef.set(e.media.ref, cp.trim()); }
					}
				}
			}
		}
		if (upstreamImageRefs.length === 0) {
			// 没有按口命中的（连 images 口但格尚未生成 / 非表情上游）→ 兜底：
			// 有独立格用独立格（多图拼贴），否则图集整图。
			if (cellRefs.length > 0) { upstreamImageRefs.push(...cellRefs); }
			else if (upstreamSheetRef) { upstreamImageRefs.push(upstreamSheetRef); }
		}
	}

	// ★ 逐格任务收集（2026-09-07 需求变更）：动态表情包**移除「图集统一生成后
	//   拆分」路线**——每个表情单格独立走图生视频（编辑器网格切分页签同步移除）。
	//   任务源：① 上游独立格（images 口，含每格 cellPrompt）② 上游 sheet 口整图
	//   → 按其行列本地切分成单格（EMOJI_SHEET_MARGIN_RATIO 内缩吸收边缘渗入）
	//   ③ 显式 imageInput / 单图 = 1 格。
	if (typeof values.imageInput === 'string' && values.imageInput) {
		upstreamImageRefs.splice(0, upstreamImageRefs.length, values.imageInput);
	}
	// ★ 阶段②/③ 不依赖上游（只读本节点快照）→ 不因「无上游参考图」被拦。
	if (upstreamImageRefs.length === 0 && needsVideoGen) {
		return { ...empty, error: '动态表情包制作需要上游参考图输入（请先连接并运行一个图像节点）。' };
	}
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
	// ★ 抠像算法（2026-09-08）：统一在此解析（此前分支各自 parseChromaAlgo，易漏传）。
	const chromaAlgo = parseChromaAlgo(values.chroma_algo);
	const fps = Math.max(6, Math.min(15, Math.round(Number(values.fps) || 12)));
	const maxKb = Math.max(100, Math.min(2000, Math.round(Number(values.max_kb) || 500)));
	const durationS = Math.max(2, Math.min(5, Math.round(Number(values.duration_s) || 3)));
	// ★ 提示词后缀的组装**统一收敛**到 `buildAnimatedEmojiVideoPrompt`
	//   （chromaCompose.ts）：全局动作 + 该格动作 + 不透明约束（恒定）+ 绿幕约束
	//   （仅开抠像）。此前这里还留着一份「整图集一次生成」时代的 `prompt` 变量，
	//   逐格路线（2026-09-07）后已无消费方 → 删除，避免两处后缀口径漂移 ✗。
	// ★ 网格约束后缀（ANIMATED_EMOJI_GRID_SUFFIX）随整图切格路线一并移除：
	//   逐格生成无需「格间不越界」约束。

	// ── 逐格任务表（两渠道共用）：上游独立格直用；上游 sheet 整图先本地切格。──
	type EmojiCellJob = { ref: string; cellIndex: number; cellPrompt?: string };
	let jobs: EmojiCellJob[] = [];
	{
		const sheetGridSnapshot = upstreamSheetGrid;
		const sheetAsOnly = upstreamImageRefs.length === 1 && sheetGridSnapshot
			&& (sheetGridSnapshot.rows > 1 || sheetGridSnapshot.cols > 1)
			&& upstreamSheetRef === upstreamImageRefs[0];
		if (sheetAsOnly && sheetGridSnapshot) {
			onProgress?.({ progress: 3 });
			const cellsSplit = await splitStickerSheet(
				upstreamImageRefs[0], sheetGridSnapshot.rows, sheetGridSnapshot.cols,
				{ marginRatio: EMOJI_SHEET_MARGIN_RATIO, cutoutBg: false }, fetchImpl,
			);
			jobs = cellsSplit.map((c, i) => ({ ref: c.dataUrl, cellIndex: i }));
		} else {
			jobs = upstreamImageRefs.map((ref, i) => {
				const cp = cellPromptByRef.get(ref);
				return { ref, cellIndex: i, ...(cp ? { cellPrompt: cp } : {}) };
			});
		}
	}
	/**
	 * 取该格**真正的输入图**（首帧一致性用）。
	 *
	 * ★ 不能用裸 `upstreamImageRefs[cellIndex]`（2026-09-12 修「转成 GIF 后首帧重影」）：
	 *   上游是**图集整图**时数组只有 1 项 → `[i]` 对 i≥1 全是 `undefined` → 那些格
	 *   的 GIF **拿不到参考图** → 第 0 帧退化成**视频首帧**（I2V 模型首帧相对输入图
	 *   常带漂移/重影）→ 实测「只有第 0 格正常、其余格首帧重影」✗。
	 *   `jobs[i].ref` 是①真正喂给视频模型的那张单格图（图集路径已本地切分）✓。
	 *   刻意**不回退 `refs[0]`**：图集模式下那是整版拼贴图，当单格参考图是错的 ✗。
	 */
	const emojiCellSeedRef = (cellIndex: number): string =>
		jobs[cellIndex]?.ref ?? upstreamImageRefs[cellIndex] ?? '';

	// ★ 重新抠图+GIF（2026-09-08）：网格 ⟳ 语义改为「**跳过视频生成**」——用该格
	//   已归档的绿幕视频按**当前抠像参数**直接重跑 抠像 → 透明 GIF。调参迭代从
	//   分钟级（重新生成视频）降到秒级。必须放在 jobs 空检查之前（不依赖上游，
	//   纯看本节点快照）；选格协议与 'cell' 相同（cell_indices 多选 / selected_index）。
	if (String(values.run_scope ?? '') === 'rematte') {
		if (!doKey) {
			return { ...empty, error: '重新抠图需要开启「绿幕抠像」+「抠像」（当前关闭，无绿可抠）。' };
		}
		const picked = parseCellIndices(values.cell_indices, values.selected_index);
		const valid = picked === null ? [] : picked.filter(i => i >= 0);
		if (valid.length === 0) {
			return { ...empty, error: '重新抠图失败：未选中任何格子。' };
		}
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] run_scope=rematte → 重新抠图格 ${valid.map(i => i + 1).join(',')}（sim=${chromaSimilarity} smooth=${chromaSmoothness} algo=${String(values.chroma_algo ?? 'rgb')}）`);
		const entriesLocal: MediaSnapshotEntry[] = [];
		const failures: string[] = [];
		const per = 92 / valid.length;
		// ★ 媒体库本地副本索引（一次性预取，见 resolveArchivedVideo 注释）
		const libCache: VideoLibCache = { map: null };
		for (let ji = 0; ji < valid.length; ji++) {
			const cellIndex = valid[ji];
			const base = 4 + per * ji;
			onProgress?.({ progress: base, message: `阶段② 视频抠像（重抠）· 格 ${cellIndex + 1}（${ji + 1}/${valid.length}）` });
			const srcVideo = await resolveArchivedVideo(store, snapKey, cellIndex, libCache);
			if (!srcVideo) {
				failures.push(`格 ${cellIndex + 1}：没有已生成的视频（请先执行阶段① 生成视频）`);
				continue;
			}
			try {
				const t0 = Date.now();
				// ★ 首帧一致性（2026-09-12 修「首帧重影」）：重抠路径此前**完全没传**
				//   参考图 → GIF 第 0 帧 = 视频首帧（I2V 模型首帧相对输入图常有漂移/
				//   重影）→ 用户实测「转成 GIF 后首帧出现重影」✗。补上与主链路同源
				//   的参考图（该格真正的输入图 → 绿底合成 → 抠像替换第 0 帧）。
				let rematteSeed: string | undefined;
				const seedRef = emojiCellSeedRef(cellIndex);
				if (doKey && chromaEnabled && seedRef) {
					try { rematteSeed = await compositeImageOnChroma(seedRef, chromaComposite, fetchImpl); } catch { rematteSeed = undefined; }
				}
				const gif = await convertVideoToTransparentGif(
					srcVideo,
					// ★ loop_blend 同样按 widget 值透传（同 convertCellVideoToGif 的修复：
					//   不透传 = 开关失效 = 用户关不掉尾帧叠影）。
					{ ...EMOJI_GIF_PARAMS, loop_blend: values.loop_blend !== false, fps, max_width: 240, max_frames: durationS * fps, end_s: durationS, chroma_algo: String(values.chroma_algo ?? 'rgb') },
					{ color: chromaColor, similarity: chromaSimilarity, smoothness: chromaSmoothness },
					fetchImpl,
					(p) => onProgress?.({ progress: base + (p.value ?? 0) / 100 * per }),
					maxKb * 1024,
					rematteSeed,
				);
				const overLimit = gif.bytes > maxKb * 1024;
				const media: MediaRef = {
					kind: 'image',
					ref: await blobToDataUrl(gif.gifBlob),
					meta: {
						mime: 'image/gif',
						gifFrames: String(gif.frames),
						gifSize: `${gif.width}x${gif.height}`,
						gifDelayCs: String(gif.delayCs),
						bytes: String(gif.bytes),
						compressLevel: String(gif.level),
						cellIndex: String(cellIndex),
						perCell: '1',
						rematte: '1',
						...(overLimit ? { overLimit: '1' } : {}),
						...(archivedVideoSig(store, snapKey, cellIndex) ? { srcSig: archivedVideoSig(store, snapKey, cellIndex)! } : {}),
					},
				};
				// 原地替换优先（同主循环 replaceOrPut 语义：按 cellIndex 匹配旧 image 条目）
				const prev = store.byNode(snapKey).find(e =>
					e.port === 'output' && e.media.kind === 'image'
					&& Number(e.media.meta?.cellIndex ?? -1) === cellIndex);
				if (prev && store.replaceByKey(prev.key, media, {
					importEntry: { nodeId: snapKey, port: 'output', key: prev.key, media, index: prev.index },
				})) {
					// eslint-disable-next-line no-console
					console.warn(`[AnimatedEmoji] rematte cell ${cellIndex} replaced in place (${Math.round((Date.now() - t0) / 1000)}s)`);
				} else {
					store.put({ nodeId: snapKey, port: 'output', key: `cell${cellIndex}`, media });
				}
				// 阶段① 抠像结果归档（重抠也要刷新 → 阶段② 沿用最新参数）
				await archiveMatteResult(store, snapKey, cellIndex, srcVideo,
					{ color: chromaColor, similarity: chromaSimilarity, smoothness: chromaSmoothness },
					chromaAlgo, fetchImpl, archivedVideoSig(store, snapKey, cellIndex));
				entriesLocal.push({
					nodeId: snapKey, port: 'output', key: `cell${cellIndex}`, media, index: cellIndex,
				});
			} catch (e) {
				failures.push(`格 ${cellIndex + 1}：${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (entriesLocal.length === 0) {
			return { ...empty, error: `重新抠图失败：${failures.join('；')}` };
		}
		if (failures.length) {
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] rematte 部分失败: ${failures.join('；')}`);
		}
		onProgress?.({ progress: 100 });
		return { promptId: '', status: 'success', entries: entriesLocal, durationMs: 0 };
	}

	// ★ 阶段②「视频抠像」（2026-09-12 三阶段拆分）：**不生成视频、不编码 GIF**——
	//   读阶段① 归档的绿幕原片（port='video'）→ 按当前抠像参数抠像 → 归档抠像结果
	//   （port='matte'：透明 PNG + 参数凭据）。秒级，可反复调抠像参数。
	//   必须放在 `jobs.length === 0` 检查之前：本阶段不依赖上游参考图。
	if (stageMatteOnly) {
		if (!doKey) {
			return { ...empty, error: '阶段②「视频抠像」需要开启「绿幕合成」+「抠像」（当前关闭，无绿可抠）。' };
		}
		// cellIndex → 绿幕视频（含其**输入指纹** `srcSig`：阶段② 产物继承它，使
		// 换批检测在 ①②③ 三处口径一致 —— 见 emojiInputSig）
		const videoCells = new Map<number, { ref: string; sig?: string }>();
		for (const e of store.byNode(snapKey)) {
			if (e.port !== 'video' || e.media.kind !== 'video' || !e.media.ref) { continue; }
			const idx = Number(e.media.meta?.cellIndex ?? -1);
			if (idx >= 0) {
				const sig = e.media.meta?.srcSig;
				videoCells.set(idx, { ref: e.media.ref, ...(typeof sig === 'string' && sig ? { sig } : {}) });
			}
		}
		const wanted = parseCellIndices(values.cell_indices, values.selected_index);
		const targetCells = wanted === null
			? [...videoCells.keys()].sort((a, b) => a - b)
			: wanted.filter(i => videoCells.has(i));
		const missing = wanted === null ? [] : wanted.filter(i => !videoCells.has(i));
		if (targetCells.length === 0) {
			return { ...empty, error: '阶段②「视频抠像」没有可处理的格子：请先执行阶段①「生成视频」。' };
		}
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] 阶段② 视频抠像 → 格 ${targetCells.map(i => i + 1).join(',')}（sim=${chromaSimilarity} smooth=${chromaSmoothness} algo=${chromaAlgo}）`);
		const entriesLocal: MediaSnapshotEntry[] = [];
		const failures: string[] = missing.map(i => `格 ${i + 1}：缺少阶段① 绿幕视频`);
		const per = 92 / targetCells.length;
		const libCache: VideoLibCache = { map: null };
		try {
			for (let ji = 0; ji < targetCells.length; ji++) {
				const cellIndex = targetCells[ji];
				const base = 4 + per * ji;
				onProgress?.({ progress: base, message: `阶段② 视频抠像 · 格 ${cellIndex + 1}（${ji + 1}/${targetCells.length}）` });
				try {
					const srcVideo = await resolveArchivedVideo(store, snapKey, cellIndex, libCache);
					if (!srcVideo) {
						failures.push(`格 ${cellIndex + 1}：缺少阶段① 绿幕视频`);
						continue;
					}
					await archiveMatteResult(store, snapKey, cellIndex, srcVideo,
						{ color: chromaColor, similarity: chromaSimilarity, smoothness: chromaSmoothness },
						chromaAlgo, fetchImpl, videoCells.get(cellIndex)?.sig);
					// archiveMatteResult 内部静默兜底 → 用「是否真有归档」判定成败
					const matteEntry = store.byNode(snapKey).find(e =>
						e.port === 'matte' && Number(e.media.meta?.cellIndex ?? -1) === cellIndex);
					if (!matteEntry) {
						failures.push(`格 ${cellIndex + 1}：抠像结果归档失败（视频解码失败？）`);
						continue;
					}
					entriesLocal.push(matteEntry);
					onProgress?.({ progress: base + per, message: `阶段② 视频抠像 · 格 ${cellIndex + 1} 完成` });
				} catch (cellErr) {
					const cm = cellErr instanceof Error ? cellErr.message : String(cellErr);
					if (input.signal?.aborted || /AbortError/i.test(cm)) { throw cellErr; }
					failures.push(`格 ${cellIndex + 1}：${cm}`);
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (input.signal?.aborted || /AbortError/i.test(msg)) {
				return { promptId: '', status: 'canceled', error: '已取消', entries: [] };
			}
			return { ...empty, error: `阶段② 视频抠像失败：${msg}` };
		}
		if (entriesLocal.length === 0) {
			return { ...empty, error: `阶段② 视频抠像失败：${failures.join('；')}` };
		}
		onProgress?.({ progress: 100, message: '阶段② 视频抠像完成' });
		const note = failures.length > 0
			? `（${entriesLocal.length}/${targetCells.length + missing.length} 格成功；失败：${failures.join('；')}）`
			: '';
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] 阶段② 完成: ${entriesLocal.length} 格${note}`);
		return {
			promptId: '', status: 'success', entries: entriesLocal, durationMs: 0,
			...(note ? { error: note } : {}),
		};
	}

	// ★★ 阶段作用域**残留**保护（2026-09-12 用户报障：在工作流工具卡片里整链运行时，
	//   AnimatedEmoji 直接进阶段③、拿**几小时前的旧原片**去编码 → COS 签名已过期
	//   → `net.fetchAsDataUrl: HTTP 403` → 整个节点失败 ✗✗）。
	//   根因：`run_scope` 是**编辑器交互**概念，却被 `runStage()`（AnimatedEmojiEditor）
	//   持久化进节点属性 ✗ —— 用户早先点过「③ 生成 GIF」，之后从聊天卡片 / ▶ 整链运行时
	//   执行器仍读到 'gif' ⇒ **只跑③** ✗（用旧原片，必然过期）。
	//   判定「残留」= ②/③-only **且**已归档原片**全部不可用**（缺失 / 签名已过期 /
	//   输入已更换）。此时回落**完整链路 ①+②+③** ✓（用户在整链场景的真实意图就是
	//   「把动态表情做出来」✓）；编辑器里点「③」时原片是刚生成的、必然可用 ✓ 不受影响。
	if (stageGifOnly || stageMatteOnly) {
		const vids = store.byNode(snapKey).filter(e => e.port === 'video' && e.media.kind === 'video' && !!e.media.ref);
		const usable = vids.length > 0 && vids.some(e => {
			if (isExpiredSignedUrl(e.media.ref)) { return false; }
			const ci = Number(e.media.meta?.cellIndex ?? -1);
			const sig = typeof e.media.meta?.srcSig === 'string' ? e.media.meta.srcSig : '';
			// 无指纹（旧数据）/ 无上游可对比 → 不判过期（与卡片换批检测同口径 ✓）
			if (!sig || ci < 0 || upstreamImageRefs.length === 0) { return true; }
			return sig === emojiInputSigFor(upstreamImageRefs, ci);
		});
		if (!usable) {
			if (!send) { return { ...empty, error: 'Provider 视频生成通道未注入（videogen.generate）' }; }
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] run_scope=${runScopeRaw} 为残留（原片缺失/签名过期/输入已更换）→ 自动回落完整链路 ①+②+③`);
			stageGifOnly = false;
			stageMatteOnly = false;
		}
	}

	// ★ 阶段③「GIF 输出」（2026-09-11 两阶段拆分）：**不生成视频、不重新抠像**——
	//   直接取阶段① 归档的绿幕原片（port='video'）+ **当前**抠像参数 → 编码透明
	//   GIF（port='output'），并顺手把阶段② 的抠像结果刷成同一组参数。
	//   纯编码，秒级；调 GIF 参数（回环/帧率/上限）无需重跑视频链。
	//   必须放在 `jobs.length === 0` 检查之前：本阶段不依赖上游参考图。
	if (stageGifOnly) {
		if (!gifEnabled) {
			return { ...empty, error: '阶段③「GIF 输出」已关闭（GIF 输出开关为关）：当前产物即阶段① 的视频。' };
		}
		const videoCells = new Map<number, string>();
		/** 该格绿幕视频的输入指纹（写进 GIF meta → 换批检测口径与 ①② 一致）。 */
		const videoSigByCell = new Map<number, string>();
		const matteMetaByCell = new Map<number, Record<string, string>>();
		for (const e of store.byNode(snapKey)) {
			const idx = Number(e.media.meta?.cellIndex ?? -1);
			if (idx < 0 || !e.media.ref) { continue; }
			if (e.port === 'video' && e.media.kind === 'video') {
				videoCells.set(idx, e.media.ref);
				const sig = e.media.meta?.srcSig;
				if (typeof sig === 'string' && sig) { videoSigByCell.set(idx, sig); }
			}
			if (e.port === 'matte') { matteMetaByCell.set(idx, (e.media.meta ?? {}) as Record<string, string>); }
		}
		const wanted = parseCellIndices(values.cell_indices, values.selected_index);
		const targetCells = wanted === null
			? [...videoCells.keys()].sort((a, b) => a - b)
			: wanted.filter(i => videoCells.has(i));
		const missing = wanted === null ? [] : wanted.filter(i => !videoCells.has(i));
		if (targetCells.length === 0) {
			return {
				...empty,
				error: '阶段③「GIF 输出」没有可转换的格子：请先执行阶段①「生成视频」。',
			};
		}
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] 阶段③ GIF 输出 → 格 ${targetCells.map(i => i + 1).join(',')}（用当前抠像参数：sim=${chromaSimilarity} smooth=${chromaSmoothness} algo=${chromaAlgo}）`);
		const entriesLocal: MediaSnapshotEntry[] = [];
		const failures: string[] = missing.map(i => `格 ${i + 1}：缺少阶段① 绿幕视频`);
		try {
			const per = 92 / targetCells.length;
			for (let ji = 0; ji < targetCells.length; ji++) {
				const cellIndex = targetCells[ji];
				const base = 4 + per * ji;
				const srcVideo = videoCells.get(cellIndex)!;
				// 本格本次生成的时间戳（GIF 与「③ 顺手补齐的 matte」共用同一值 —— 见
				// archiveMatteResult 的 stamp 说明：否则刚生成的 GIF 会被误判过期）。
				const gifStampMs = Date.now();
				const mm = matteMetaByCell.get(cellIndex);
				// ★★ 抠像参数以**当前 widget 值**为准（2026-09-12 修「点击 ③ 生成 GIF
				//   后预览没有更新」）：此前优先取阶段② 固化的 `matte*` —— 用户改了
				//   ② 页签的抠像参数后点 ③，GIF 仍按**旧参数**编码（输入/参数都没变 →
				//   产物字节完全相同 → 预览看起来「没更新」✗，且无从解释）。
				//   现语义 = 「③ 用**现在**的抠像参数把绿幕原片编成 GIF」，与 ② 页签
				//   里正在预览的参数一致；`mm` 仅在 widget 缺省时兜底。
				//   下方 auto-fill 会把 matte 归档刷新成同一组参数 → ② 页签随之对齐
				//   （③ 有图 ⟹ ② 有同源抠像结果，两页签永不打架）。
				const chromaForGif = {
					color: chromaColor || (typeof mm?.matteColor === 'string' ? mm.matteColor : ''),
					similarity: Number.isFinite(chromaSimilarity) ? chromaSimilarity : Number(mm?.matteSimilarity ?? 0),
					smoothness: Number.isFinite(chromaSmoothness) ? chromaSmoothness : Number(mm?.matteSmoothness ?? 0),
				};
				const algoForGif = chromaAlgo;   // 当前算法（入口已统一 parseChromaAlgo）
				const doKeyForGif = chromaEnabled && matteEnabled;
				onProgress?.({ progress: base, message: `阶段③ GIF 输出 · 格 ${cellIndex + 1}（${ji + 1}/${targetCells.length}）` });
				// 首帧一致性：取**该格真正的输入图**（见 emojiCellSeedRef —— 裸
				// `upstreamImageRefs[cellIndex]` 在图集模式下对 i≥1 恒为 undefined，
				// 那些格的 GIF 第 0 帧会退化成视频首帧 = 首帧重影 ✗）。
				let seedForGif: string | undefined;
				const upstreamSeed = emojiCellSeedRef(cellIndex);
				if (doKeyForGif && chromaEnabled && upstreamSeed) {
					try { seedForGif = await compositeImageOnChroma(upstreamSeed, chromaComposite, fetchImpl); } catch { seedForGif = undefined; }
				}
				try {
					const { media, overLimit } = await convertCellVideoToGif({
						videoRef: srcVideo,
						values,
						chroma: chromaForGif,
						algo: algoForGif,
						fps,
						durationS,
						maxKb,
						doKey: doKeyForGif,
						fetchImpl,
						firstFrameOverride: seedForGif,
						onProgress: (v) => onProgress?.({ progress: base + (v / 100) * per * 0.9 }),
					});
					const finalMedia: MediaRef = {
						...media,
						meta: {
							...(media.meta ?? {}),
							cellIndex: String(cellIndex),
							perCell: '1',
							stage2: '1',
							// ★ 生成时间戳（2026-09-12）：参数/输入都没变时 GIF 字节可能**完全
							//   相同** → 卡片 `<img src>` 不变 → 浏览器不重解码 → 用户看到
							//   「点了 ③ 但预览没更新」✗。带上时间戳后，卡片用它作 React key
							//   强制重挂 `<img>`（动画重播）+ 头部显示「更新于 hh:mm:ss」。
							gifStamp: String(gifStampMs),
							// ★ 本 GIF 所依据的**抠像参数签名**（格式同 matte 的 `matteSig`）：
							//   卡片据此判断「② 之后 GIF 是否已过期」——② 用不同参数重跑后
							//   签名不等 → ③ 预览回落到**新的抠像结果** + 角标「待重转 GIF」
							//   （用户实测「执行完抠像后 GIF 预览没更新图片」：此前 ③ 一直
							//   显示旧 GIF，② 的新抠像结果被盖住 ✗）。
							gifFromMatteSig: `${chromaForGif.similarity}|${chromaForGif.smoothness}|${algoForGif}|${chromaForGif.color}`,
							// ★ 本 GIF 所依据的**绿幕原片指纹**（emojiInputSig：长度+头尾，
							//   O(1)）：① 重新生成视频后原片变了，即使抠像参数没变、连输入
							//   图都没变（`srcSig` 一样），这张 GIF 也已经过期 → 卡片据此
							//   判定「待重转」，不再傻乎乎显示旧 GIF ✗。
							gifFromVideoSig: emojiInputSig(srcVideo),
							backend,
							...(backend === 'comfyui'
								? { provider: 'comfyui', model: String(values.workflow ?? '') }
								: { provider: providerId, model: modelId }),
							// 继承绿幕视频的输入指纹（换批检测口径与 ①② 一致）
							...(videoSigByCell.has(cellIndex) ? { srcSig: videoSigByCell.get(cellIndex)! } : {}),
						},
					};
					// 原地替换优先（按 cellIndex 匹配旧 output 条目）。
					// ★ 必须替换**最新**的那条（index 最大），不是 `find` 的第一条（byNode
					//   按 index 升序 → 第一条是最旧的）：卡片侧 `latestOutputs` 的按格去重
					//   取 **index 最大** 者 → 替换最旧条目会留下一条「旧媒体 + 更大 index」
					//   的孤儿条目，把新 GIF 顶掉 ✗（预览看起来没更新）。
					const sameCell = store.byNode(snapKey).filter(e =>
						e.port === 'output' && e.media.kind === 'image'
						&& Number(e.media.meta?.cellIndex ?? -1) === cellIndex);
					const prev = sameCell.length > 0
						? sameCell.reduce((a, b) => ((b.index ?? 0) > (a.index ?? 0) ? b : a))
						: undefined;
					if (prev && store.replaceByKey(prev.key, finalMedia, {
						importEntry: { nodeId: snapKey, port: 'output', key: prev.key, media: finalMedia, index: prev.index },
					})) {
						// eslint-disable-next-line no-console
						console.warn(`[AnimatedEmoji] 阶段③ cell ${cellIndex} 原地替换 (key=${prev.key}, 其余同格旧条目 ${sameCell.length - 1} 条保留待去重)`);
					} else {
						store.put({ nodeId: snapKey, port: 'output', key: `cell${cellIndex}`, media: finalMedia });
					}
					entriesLocal.push({ nodeId: snapKey, port: 'output', key: `cell${cellIndex}`, media: finalMedia, index: cellIndex });
					// ★ 顺手补齐阶段② 的抠像结果（2026-09-12 修「② 与 ③ 预览不一致」）：
					//   阶段③ **不依赖**阶段② 的产物（缺抠像参数凭据时用当前参数兜底），
					//   因此会出现「③ 已有 N 格 GIF、② 只有 M 格抠像结果」的错位状态
					//   ——② 页签对没跑过②的格回落到「输入原图」，与 ③ 的 GIF 观感
					//   完全不同（用户实测反馈「视频抠像里的表情包和 GIF 输出里的不一致」）。
					//   这里用**本格 GIF 实际使用的参数**把缺失（或参数已变）的抠像结果
					//   补上 → 「③ 有图 ⟹ ② 必有同源抠像结果」，两个页签同格同源。
					//   失败静默（archiveMatteResult 内部已兜底，不阻断 GIF 主链路）。
					if (doKeyForGif) {
						const wantSig = `${chromaForGif.similarity}|${chromaForGif.smoothness}|${algoForGif}|${chromaForGif.color}`;
						const hasMatte = store.byNode(snapKey).some(e =>
							e.port === 'matte' && Number(e.media.meta?.cellIndex ?? -1) === cellIndex
							&& e.media.meta?.matteSig === wantSig);
						if (!hasMatte) {
							await archiveMatteResult(store, snapKey, cellIndex, srcVideo,
								chromaForGif, algoForGif, fetchImpl, videoSigByCell.get(cellIndex),
								// ★ 传本格 GIF 的时间戳：这次刷新是 ③ 自己做的，不该被
								//   当成「② 比 ③ 新」→ 否则刚生成的 GIF 立刻显示「待重转」✗
								gifStampMs);
						}
					}
					onProgress?.({ progress: base + per, message: `阶段③ GIF 输出 · 格 ${cellIndex + 1} 完成${overLimit ? '（超限）' : ''}` });
				} catch (cellErr) {
					const cm = cellErr instanceof Error ? cellErr.message : String(cellErr);
					if (input.signal?.aborted || /AbortError/i.test(cm)) { throw cellErr; }
					failures.push(`格 ${cellIndex + 1}：${cm}`);
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (input.signal?.aborted || /AbortError/i.test(msg)) {
				return { promptId: '', status: 'canceled', error: '已取消', entries: [] };
			}
			return { ...empty, error: `阶段③ GIF 输出失败：${msg}` };
		}
		if (entriesLocal.length === 0) {
			return { ...empty, error: `阶段③ GIF 输出失败：${failures.join('；')}` };
		}
		onProgress?.({ progress: 100, message: '阶段③ GIF 输出完成' });
		const note = failures.length > 0
			? `（${entriesLocal.length}/${targetCells.length + missing.length} 格成功；失败：${failures.join('；')}）`
			: '';
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] 阶段③ 完成: ${entriesLocal.length} 格${note}`);
		return {
			promptId: '', status: 'success', entries: entriesLocal, durationMs: 0,
			...(note ? { error: note } : {}),
		};
	}

	if (jobs.length === 0) {
		return { ...empty, error: '没有可生成动态视频的表情格：请先在上游生成表情包（单格或图集）。' };
	}

	// ★ 选格（2026-09-08，对齐静态表情包交互；2026-09-11 扩展到阶段①）：
	//   run_scope='cell'（完整链路选格）与 run_scope='matte'（阶段① 选格）共用同一
	//   选格协议：cell_indices（JSON 数组或逗号分隔，0-based）优先，回退
	//   selected_index（1-based 单格）。cellIndex 保留原索引 → 归档按 meta.cellIndex
	//   原地替换（replaceOrPut），其余格快照不受影响。
	//   **未指定** → 阶段① 跑全部格；'cell' 必须显式选格（否则报错，避免误跑全量）。
	if (runScopeRaw === 'cell' || stageVideoOnly) {
		const picked = parseCellIndices(values.cell_indices, values.selected_index);
		if (picked === null) {
			if (runScopeRaw === 'cell') {
				return { ...empty, error: '选格重生成失败：未选中任何格子。' };
			}
		} else {
			const valid = picked.filter(i => i < jobs.length);
			if (valid.length === 0) {
				return { ...empty, error: `选格失败：选中格超出范围（共 ${jobs.length} 格），请重新选择。` };
			}
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] run_scope=${runScopeRaw} → 只处理格 ${valid.map(i => i + 1).join(',')}/${jobs.length}`);
			jobs = valid.map(i => jobs[i]);
		}
	}

	// ★ 每格动作覆盖（2026-09-07）：编辑器逐格填写的动作描述（cell_actions JSON
	//   数组按格序，TEXT widget 持久化在 node.properties）。优先级：
	//   手填动作 > 上游格自动描述（meta.cellPrompt）> 全局 prompt。
	{
		let manualActions: string[] = [];
		try {
			const arr = JSON.parse(typeof values.cell_actions === 'string' && values.cell_actions.trim() ? values.cell_actions : '[]') as unknown;
			if (Array.isArray(arr)) { manualActions = arr.map(x => (typeof x === 'string' ? x : '')); }
		} catch { /* 非法 JSON 忽略——回退上游格自动描述/全局 prompt */ }
		jobs = jobs.map((job, i) => {
			const manual = (manualActions[i] ?? '').trim();
			return manual ? { ...job, cellPrompt: manual } : job;
		});
	}

	try {
		// ★ chroma_enable=false → 单格不做绿底合成（保留原背景直喂视频模型）。
		onProgress?.({ progress: 5 });
		// eslint-disable-next-line no-console
		console.warn(`[AnimatedEmoji] run start nodeId=${nodeId} backend=${backend} (raw="${String(values.backend)}")${backend === 'comfyui' ? ` workflow=${String(values.workflow ?? '')}` : ` provider=${providerId} model=${modelId}`} duration=${durationS}s cells=${jobs.length} chroma=${chromaEnabled ? 'on' : 'off'} matte=${matteEnabled ? 'on' : 'off'} gif=${gifEnabled ? 'on' : 'off'} algo=${String(values.chroma_algo ?? 'rgb')} sim=${Number(values.chroma_similarity ?? 0.25)} smooth=${Number(values.chroma_smoothness ?? 0.08)} maxKb=${maxKb}`);

		// ② **逐格独立生成**（2026-09-07 全渠道统一）：每个表情单格 → 独立图生
		//   视频 → 单格抠像 → 单格 GIF。不再有「整图集一次生成 → 切格」路线
		//   （视频模型对整版运动理解差、单格动作不独立、邻格渗入相互污染）。
		//   两渠道差异仅在「单格 → 视频」一步：
		//   - comfyui：该格作 LoadImage 输入跑所选本地视频工作流（I2V）；
		//   - provider：videogen RPC（1:1 方形、768P；raceAbort 可取消）。
		{
			// comfyui 渠道守卫（提前于循环，避免逐格才报配置错）。
			const workflowName = backend === 'comfyui'
				? (typeof values.workflow === 'string' && values.workflow.trim() ? values.workflow.trim() : '')
				: '';
			if (backend === 'comfyui' && !workflowName) {
				return { ...empty, error: 'ComfyUI 渠道需要选择视频工作流（生成渠道 → 工作流下拉）。' };
			}
			if (backend === 'comfyui' && !input.runner) {
				return { ...empty, error: 'ComfyUI 渠道需要 ComfyUI runner：请在 Runner 面板连接 ComfyUI 后重试（或切回 Provider 渠道）。' };
			}
			// ★ seed（comfyui 渠道）：用户可固定（>0 复现同一动图）；0/未设置 = 随机。
			const seedUser = Number(values.seed);
			const seed = Number.isFinite(seedUser) && seedUser > 0 ? Math.floor(seedUser) : Math.floor(Math.random() * 0x7fffffff);
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] per-cell mode: ${jobs.length} 格 × 1 视频/格（backend=${backend}${backend === 'comfyui' ? ` workflow=${String(values.workflow ?? '')}` : ` provider=${providerId} model=${modelId}`} duration=${durationS}s chroma=${chromaEnabled ? 'on' : 'off'} matte=${matteEnabled ? 'on' : 'off'} gif=${gifEnabled ? 'on' : 'off'}）`);
			const entriesLocal: MediaSnapshotEntry[] = [];
			const failures: string[] = [];
			const per = 92 / jobs.length;
			for (let ji = 0; ji < jobs.length; ji++) {
				const job = jobs[ji];
				const base = 4 + per * ji;
				const cellT0 = Date.now();
				// 该格输入图指纹（写进本格全部产物 meta.srcSig，供换批检测）。
				// ★ 必须与 nodeCard 的读取口径一致（emojiInputSigFor，含图集回退）。
				const cellSig = emojiInputSigFor(upstreamImageRefs, job.cellIndex);
				onProgress?.({ progress: base, message: `阶段① 生成视频 · 格 ${job.cellIndex + 1}（${ji + 1}/${jobs.length}）生成中…` });
				// eslint-disable-next-line no-console
				console.warn(`[AnimatedEmoji] cell ${job.cellIndex} start (${ji + 1}/${jobs.length}) prompt="${(job.cellPrompt ?? rawPrompt ?? '').slice(0, 80)}"`);
				try {
					// ① 单格绿底合成（chroma 关闭 → 原图直喂）
					const seedCell = chromaEnabled ? await compositeImageOnChroma(job.ref, chromaComposite, fetchImpl) : job.ref;
					// ② 单格视频（1:1 方形、768P；prompt = 全局动作 + 该格动作 + 不透明约束 + 绿幕约束）
					//   ★ 不透明约束（ANIMATED_EMOJI_OPAQUE_SUFFIX）恒定追加（2026-09-12
					//     用户需求「视频中，不要有半透明效果」）：半透明元素叠在绿幕上时
					//     抠像**数学上欠定**（一个方程两个未知数）→ 经典 keyer 直接删掉 ✗、
					//     反混合只能勉强恢复且低 alpha 区放大压缩噪声 ✗、GIF 更是 1-bit
					//     alpha 表达不了 ✗ ⇒ 必须在生成源头要求「实心不透明」✓。
					const cellPrompt = typeof job.cellPrompt === 'string' ? job.cellPrompt.trim() : '';
					const cellPromptFull = buildAnimatedEmojiVideoPrompt(rawPrompt, cellPrompt, chromaEnabled);
					onProgress?.({ progress: base + per * 0.05 });
					let cellVideoUrl = '';
					if (backend === 'comfyui') {
						// 单格 → 工作流 LoadImage：把该格 ref 写入 comfytv_image_refs
						// （applyAssetRefOverrides 的 override 语义：钉住资产优先于上游
						// 连线，覆盖 upstream_image 绑定）。快照归档键按格隔离（snapKey#cellN
						// ——nodeCard 按 snapKey 读 OUTPUT，逐格写同一 snapKey 会让上次
						// run 的视频混入本次）。
						const r = await runStageWorkflow({
							runner: input.runner!,
							nodeId,
							snapshotKey: `${snapKey}#cell${job.cellIndex}`,
							type: 'Saros.AnimatedEmoji',
							kind: 'video',
							workflowKind: 'video',
							values: {
								...values,
								seed,
								workflow: workflowName,
								prompt: cellPromptFull,
								main_prompt: cellPromptFull,
								[ASSET_REFS_PROP]: [{ ref: seedCell, slot: 0, type: 'image' }],
							},
							upstreams: input.upstreams,
							store,
							// ★ 子进度归一化（2026-09-08）：p.progress 是 0-100 百分数，per 是
						//   百分点配额——不除 100 会把进度爆到数千%（任务面板 2493% 根因）。
						onProgress: (p) => onProgress?.({ progress: base + per * 0.05 + (typeof p.progress === 'number' ? p.progress / 100 : 0) * per * 0.6 }),
							signal: input.signal,
							resolveImageRef: input.resolveLoadImageRef ?? defaultResolveLoadImageRef(input.runner),
						});
						if (r.status !== 'success') {
							throw new Error(`ComfyUI 视频工作流失败：${r.error ?? 'unknown'}`);
						}
						const producedVideos = store.byNode(`${snapKey}#cell${job.cellIndex}`).filter((e: MediaSnapshotEntry) => e.media.kind === 'video');
						cellVideoUrl = producedVideos[producedVideos.length - 1]?.media.ref ?? '';
						if (!cellVideoUrl) {
							throw new Error('ComfyUI 视频工作流完成但未取到视频（检查工作流的 video 输出）。');
						}
					} else {
						// send 非空已由函数开头守卫保证（`!send && !stageGifOnly` 已 return；
						// 阶段② 在本分支之前已返回）——此处 `!` 仅为让 TS 收窄。
						const resp = await raceAbort(send!({
							providerId,
							modelId,
							prompt: cellPromptFull,
							duration: durationS,
							resolution: '768P',
							ratio: '1:1',
							imageInput: seedCell,
						}), input.signal);
						cellVideoUrl = resp?.videos?.[0]?.url ?? '';
						if (!cellVideoUrl) {
							throw new Error('视频生成接口未返回视频（检查 provider 额度 / 模型是否支持图生视频）');
						}
					}
					// ★ 原片固化（2026-09-08）：provider 渠道的 COS 签名 URL 约 2h
					//   过期——不固化则签名过期后 ⟳ 重新抠图 403、原片预览黑屏、媒体库
					//   死链。归档前拉成本地 dataURL（失败静默回退原 URL），后续抠像/
					//   归档/⟳ 全用本地数据。comfyui 渠道（127.0.0.1）原样返回零开销。
					cellVideoUrl = await localizeImageRef(cellVideoUrl, {
						label: `AnimatedEmoji cell${job.cellIndex} 绿幕原片`,
						kind: 'video',
					});
					// ★ 固化失败告警（2026-09-12 日志实证）：仍为 http(s) 说明原片**没能落成本地
					//   data URL**（COS 签名 URL 拉取失败）⇒ 约 2h 后签名过期，阶段②/③ 抠像与
					//   GIF 编码都会 403 失败（用户实测：阶段③ 报 `net.fetchAsDataUrl: HTTP 403`）✗。
					//   此处提前告警，把问题定位在**生成时刻**，而不是几小时后才暴露 ✗。
					if (/^https?:/i.test(cellVideoUrl)) {
						// eslint-disable-next-line no-console
						console.warn(`[AnimatedEmoji] cell ${job.cellIndex} 原片未固化（仍为外网 URL，约 2h 后失效 → ②/③ 将失败；先看同段上方的 [localizeRef] 一行，那里有 host 代理 / 公网 alias / 媒体库落盘三条路径的**具体失败原因**）：${cellVideoUrl.slice(0, 120)}…`);
					}
					// ③ 输出管线（2026-09-12 三阶段拆分）：
					//    阶段①：绿幕原片（port='video'）；
					//    阶段②：抠像结果（port='matte'：透明 PNG + 抠像参数凭据）；
					//    阶段③：抠像结果编码为透明 GIF（port='output'）。
					//    stage_video_only → 只做①；gif_enable=false → ①+②，产物即视频。
					if (doKey && !stageVideoOnly) {
						onProgress?.({ progress: base + per * 0.7, message: `阶段② 视频抠像 · 格 ${job.cellIndex + 1}（${ji + 1}/${jobs.length}）` });
						await archiveMatteResult(store, snapKey, job.cellIndex, cellVideoUrl,
							{ color: chromaColor, similarity: chromaSimilarity, smoothness: chromaSmoothness },
							chromaAlgo, fetchImpl, cellSig);
					}
					let media: MediaRef;
					if (stageVideoOnly || !gifEnabled) {
						// 阶段① 只跑 / 视频直出：产物 = 生成的视频（绿幕开=绿幕原片，
						// 关=原背景视频）。阶段① 归档到 port='video'（② 的输入），
						// 视频直出模式归档到 port='output'（它就是最终产物）。
						media = {
							kind: 'video',
							ref: cellVideoUrl,
							meta: {
								cellIndex: String(job.cellIndex),
								backend,
								...(backend === 'comfyui'
									? { provider: 'comfyui', model: workflowName }
									: { provider: providerId, model: modelId }),
								perCell: '1',
								...(stageVideoOnly ? { stage1: '1' } : {}),
								...(chromaEnabled ? { greenScreen: '1' } : { matte: '0' }),
								...(cellPrompt ? { cellPrompt } : {}),
								srcSig: cellSig,
							},
						};
					} else {
						// 阶段③：抠像结果 → GIF（doKey=false 时自动走带背景 GIF）。
						onProgress?.({ progress: base + per * 0.75, message: `阶段③ GIF 输出 · 格 ${job.cellIndex + 1}（${ji + 1}/${jobs.length}）` });
						const gifRes = await convertCellVideoToGif({
							videoRef: cellVideoUrl,
							values,
							chroma: { color: chromaColor, similarity: chromaSimilarity, smoothness: chromaSmoothness },
							algo: chromaAlgo,
							fps,
							durationS,
							maxKb,
							doKey,
							fetchImpl,
							// ★ 首帧一致性（2026-09-07）：以参考图（已绿底合成）替换视频首帧
							// → GIF 第 0 帧 = 输入静态贴纸（视频模型首帧常漂移）。
							firstFrameOverride: seedCell,
							onProgress: (v) => onProgress?.({ progress: base + per * 0.75 + (v / 100) * per * 0.2 }),
						});
						media = {
							...gifRes.media,
							meta: {
								...(gifRes.media.meta ?? {}),
								cellIndex: String(job.cellIndex),
								...(cellPrompt ? { cellPrompt } : {}),
								backend,
								...(backend === 'comfyui'
									? { provider: 'comfyui', model: workflowName }
									: { provider: providerId, model: modelId }),
								perCell: '1',
								...(gifRes.overLimit ? { overLimit: '1' } : {}),
								srcSig: cellSig,
							},
						};
					}
					// ④ 归档：绿幕 mp4（诊断）+ 透明 GIF（输出）。
				// ★ 原地替换优先（2026-09-08 第二轮修复）：store.put **恒追加**（批次
				//   语义——内部忽略传入 key/index，分配单调递增新 key），直接 put 会
				//   让 OUTPUT 条目随每次运行不断累积；OUTPUT 网格 slice(-9) 取尾部 →
				//   旧格条目被新条目挤出（用户实测「生成后原表情丢失」+ 反复生成
				//   同一格 → 多条相同 GIF 占满尾部）。现在按 meta.cellIndex 找旧条目
				//   → replaceByKey **原地替换**（快照序列稳定，网格逐格原地刷新）；
				//   无旧条目（首次生成）才追加。
					const replaceOrPut = (port: 'video' | 'output', media: MediaRef): void => {
					const prev = store.byNode(snapKey).find(e =>
						e.port === port
						&& Number(e.media.meta?.cellIndex ?? -1) === job.cellIndex
						&& (port === 'video' ? e.media.kind === 'video' : e.media.kind === 'image'));
					if (prev && store.replaceByKey(prev.key, media, {
						// ★ 原地替换也要触发媒体库导入（2026-09-08）：视频直出模式的
						//   产物是 COS 签名 URL（约 2h 过期）——不落盘媒体库 = 视频失效
						//   后「生成的视频无处可寻」。
						importEntry: { nodeId: snapKey, port, key: prev.key, media, index: prev.index },
					})) {
						// eslint-disable-next-line no-console
						console.warn(`[AnimatedEmoji] cell ${job.cellIndex} replaced in place (${port} ${prev.key}, ${Math.round((Date.now() - cellT0) / 1000)}s)`);
						return;
					}
					store.put({ nodeId: snapKey, port, key: `cell${job.cellIndex}`, media });
				};
				if (stageVideoOnly) {
					// 阶段①：产物归档到 port='video'（阶段② 的输入 / rematte 的来源）。
					replaceOrPut('video', media);
					entriesLocal.push({ nodeId: snapKey, port: 'video', key: `cell${job.cellIndex}`, media, index: entriesLocal.length });
					onProgress?.({ progress: base + per, message: `阶段① 生成视频 · 格 ${job.cellIndex + 1} 完成` });
				} else {
					// 绿幕 mp4 诊断归档：仅在 GIF 输出模式（mp4 只是中间产物）时保留；
					// 视频直出模式（gif_enable=false）mp4 本身就是 output，不重复归档。
					if (gifEnabled) {
						replaceOrPut('video', {
							kind: 'video', ref: cellVideoUrl,
							meta: {
								...(chromaEnabled ? { greenScreen: '1' } : {}),
								provider: providerId, model: modelId, cellIndex: String(job.cellIndex),
								srcSig: cellSig,
							},
						});
					}
					replaceOrPut('output', media);
					entriesLocal.push({ nodeId: snapKey, port: 'output', key: '', media, index: entriesLocal.length });
					onProgress?.({ progress: base + per, message: `阶段③ GIF 输出 · 格 ${job.cellIndex + 1} 完成` });
				}
				} catch (cellErr) {
					const cm = cellErr instanceof Error ? cellErr.message : String(cellErr);
					// 取消立即上抛（其余格不再继续）；普通失败记录后继续下一格
					if (input.signal?.aborted || /AbortError/i.test(cm)) { throw cellErr; }
					failures.push(`格 ${ji + 1}: ${cm}`);
					// eslint-disable-next-line no-console
					console.warn(`[AnimatedEmoji] cell ${ji + 1}/${jobs.length} failed: ${cm}`);
				}
			}
			if (entriesLocal.length === 0) {
				return { promptId: '', status: 'error', error: `全部 ${jobs.length} 格生成失败：${failures[0] ?? 'unknown'}`, entries: [] };
			}
			onProgress?.({ progress: 100 });
			const partialNote = failures.length > 0
				? `（${entriesLocal.length}/${jobs.length} 格成功；失败：${failures.join('；')}）`
				: '';
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] per-cell done: ${entriesLocal.length}/${jobs.length} 格成功${partialNote}`);
			return {
				promptId: '',
				status: 'success',
				entries: entriesLocal,
				...(partialNote ? { error: partialNote } : {}),
			};
		}
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
