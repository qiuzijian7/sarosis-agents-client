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
import { chromaKeyFrame, autoSampleChromaKeyRgba } from './videoToGifExecutor.js';

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
import { runVideoToGifNode, convertVideoToGif, convertVideoToGridTransparentGifs, blobToDataUrl, dataUrlToBlob } from './videoToGifExecutor.js';import { isRelightNode } from './relightEditor.js';
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

// ★ 表情图集配置与切分工具（background/size/margin/prompt/crops/splitStickerSheet）。

export type EmojiSheetBackground = 'white' | 'green' | 'transparent' | 'auto';

/** 各策略对应的 header 尾句（`auto` = 空 ⇒ 整句省略）。
 * ★ 'white' 从 UI 选项移除（2026-09-08 换成 'green'），但**类型/子句保留**：
 *   旧工作流存的 'white' 继续有效（resolveSheetBackground 兼容），不静默变语义。 */
const SHEET_BACKGROUND_CLAUSE: Record<EmojiSheetBackground, string> = {
	white: 'flat clean white background',
	green: 'solid pure green screen background (#00FF00), flat uniform green, no gradient, no shadows on the background',
	transparent: 'isolated on transparent background',
	auto: '',
};

/** 任意 widget 值 → 合法策略（非法/未设置回落 `auto`：不干预用户 prompt）。 */
export function resolveSheetBackground(v: unknown): EmojiSheetBackground {
	return v === 'white' || v === 'green' || v === 'transparent' ? v : 'auto';
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
export function makeSizePostProcess(width: number, height: number): StageWorkflowRunOptions['promptPostProcess'] {
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
export function composePostProcess(
	...fns: Array<StageWorkflowRunOptions['promptPostProcess'] | undefined>
): StageWorkflowRunOptions['promptPostProcess'] | undefined {
	const list = fns.filter((f): f is NonNullable<StageWorkflowRunOptions['promptPostProcess']> => typeof f === 'function');
	if (list.length === 0) { return undefined; }
	return (prompt) => { for (const f of list) { f(prompt); } };
}

/**
 * ★ 图集切分默认内缩比例（2026-09-07）：格间留白太小时，等分裁剪的单格边缘会
 *   带入相邻贴纸的一角 → 下游转动态表情包以单格为参考图时「相互污染」（邻格
 *   残影进入视频首帧）。1.2% 内缩实测不够 → 3.5%（裁掉边缘渗入 + 视觉留白余量，
 *   又不至于裁掉 die-cut 白边）。所有切分入口（生成切分/去背景联动/编辑重切/
 *   默认 cell_crops）统一引用本常量。
 */
export const EMOJI_SHEET_MARGIN_RATIO = 0.035;

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
	// ★ 格间留白强化（2026-09-07；2026-09-08 二次加大）：「clear wide gaps」实测
	//   模型留白仍不足（贴纸视觉上几乎相邻）→ 占比 75% 降到 65%，并把间隔量化
	//   为「≥ 格宽 15%」+「间距 ≈ 贴纸厚度」的强约束——量化数字比形容词可遵循。
	const header =
		`a sticker sheet of ${total} separate die-cut cartoon stickers arranged in a strict ` +
		`${rows} rows × ${cols} columns grid layout, equal-size cells, large generous empty ` +
		`gaps between stickers (at least 15% of the cell width on every side), each sticker ` +
		`occupies only about 65% of its cell, centered, with wide clear margins all around, ` +
		`never touching or crossing the cell edges, each sticker fully inside its own cell, ` +
		`each sticker has a thick bold white sticker border (die-cut outline, clean smooth ` +
		`rounded white edge, clearly visible)` +
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
	// ★ 以图集底为准（2026-09-08）：background='green' 时，**格描述**（主题模板
	//   尾句 isolated on transparent background / 用户手写「透明背景」）里的透明
	//   要求被绿幕覆盖 —— 此前正是「header 绿幕 + 模板透明」两个矛盾指令让
	//   gpt-image-2 出白底（模型谁也不听）。英文模板尾句与中文描述都替换。
	if (background === 'green') {
		body = body
			.replace(/isolated on transparent background/gi, 'isolated on green screen background')
			.replace(/transparent background/gi, 'green screen background')
			.replace(/透明背景/g, '绿幕背景')
			.replace(/透明底/g, '绿幕底');
	}
	return `${header}. ${body}`;
}

/**
 * 贴纸 alpha 平滑（2026-09-08，「绿幕边缘不光滑」修复）：**PNG 表情包专用**——
 * chromaKeyFrame 的后处理链为 GIF 1-bit alpha 设计（alpha 只有 0/255，放大必锯齿；
 * 开运算仅 1px 尺度治不了多像素波浪）。本函数在其输出上追加两步：
 *
 * ① **3×3 中值滤波**（作用 alpha 通道）：二值 mask 的经典平滑——孤立 1-2px 毛刺
 *    与小凹凸被邻域中位取代，不缩边、不改变主体尺寸；
 * ② **边界羽化**：不透明像素按 8 邻域透明占比把 alpha 降至 45%~100%（邻域越空
 *    越透明）——得到 1px 级软过渡边，视觉圆滑（PNG 支持半透明；GIF 链路不经过
 *    本函数不受影响）。
 *
 * 纯同步（418² 格 ~2ms）。
 */
export function smoothStickerAlpha(rgba: Uint8Array, w: number, h: number): void {
	const n = w * h;
	const a = new Uint8Array(n);
	for (let p = 0; p < n; p++) { a[p] = rgba[p * 4 + 3]; }
	// ① 3×3 中值滤波（边界用自身值填充）
	const med = new Uint8Array(n);
	const win = new Uint8Array(9);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let k = 0;
			const self = a[y * w + x];
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const yy = y + dy, xx = x + dx;
					win[k++] = (yy < 0 || yy >= h || xx < 0 || xx >= w) ? self : a[yy * w + xx];
				}
			}
			for (let i = 1; i < 9; i++) {
				const v = win[i];
				let j = i - 1;
				while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j--; }
				win[j + 1] = v;
			}
			med[y * w + x] = win[4];
		}
	}
	// ② 边界羽化：邻域（含图边视作外部）透明占比 → alpha 线性降至下限 45%
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const p = y * w + x;
			if (med[p] === 0) { continue; }
			let clear = 0, cnt = 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (dy === 0 && dx === 0) { continue; }
					const yy = y + dy, xx = x + dx;
					cnt++;
					if (yy < 0 || yy >= h || xx < 0 || xx >= w || med[yy * w + xx] === 0) { clear++; }
				}
			}
			rgba[p * 4 + 3] = Math.round(med[p] * (1 - 0.55 * (clear / cnt)));
		}
	}
}

/**
 * 自动居中裁剪检测（2026-09-10，`cell_crop_mode='auto'`，**G 方案**）。
 *
 * ## 方案 G：自由 CCL 框 + 像素级归属剔除（替代「检测域 + 硬边界」方案）
 * 浏览器内六/七方案实测对比（tmp/emoji-split-test，1254² 3×3 白底图集）证明：
 *   - 旧「检测域外扩 2% + 硬边界内缩 2%」：框零越界，但**裁切损失 6114px**
 *     （贴纸被硬边界切掉 —— cell7 4429px、cell1 1388px），代价 > 收益；
 *   - 「自由 CCL」：贴纸 100% 完整（裁切 0px），但框内会带进邻格越格像素 939px；
 *   - ★ G = 自由 CCL 框 + 渲染时按连通域归属剔除非本格像素 → **裁切 0 + 外来 0**。
 *
 * ## 算法（全图一次 CCL，不再逐格检测域）
 * 1. 前景掩码：有 alpha → `a>8`；无 alpha（不透明图集）→ 与**全图四边中位色**
 *    色距 > 60；
 * 2. 全图 4-连通域 CCL，产出 labels（像素→连通域）+ comps；
 * 3. 保留 area ≥ 格面积 0.3% 的连通域；按 bbox 中心归格（ownerAll）；
 * 4. 每格：中心在本格的连通域并集 bbox → ±2px → 正方形化 `S=max(w,h)×(1+padding)`
 *    → 中心对齐（**无硬边界/尺寸界/位移界** —— 框允许越格/重叠，靠像素剔除兜底）；
 * 5. 产出一张全图归属掩码 owners（像素→归属格，-1 = 背景/未归属小碎片），
 *    供 splitStickerSheet 裁剪时把「非本格」像素 alpha 置 0。
 *
 * 任一格无连通域 → 该格回退等分 crop；整体异常/无前景 → null（调用方落回等分）。
 * 返回 { crops, ownership }：crops 复用 `cell_crops` 契约（MiniImageEditor 微调零改动），
 * ownership 需一路传到 splitStickerSheet 以启用像素级剔除。
 */
export async function autoDetectCellCrops(
	imgRef: string,
	rows: number,
	cols: number,
	opts: { padding?: number; fetchImpl?: typeof fetch } = {},
): Promise<SheetDetectionResult | null> {
	const padding = Math.max(0, Math.min(0.3, opts.padding ?? 0.08));
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
	let objectUrl = '';
	try {
		const blob = /^data:/i.test(imgRef) ? dataUrlToBlob(imgRef) : await (await fetchImpl(imgRef)).blob();
		objectUrl = URL.createObjectURL(blob);
		const img = document.createElement('img');
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('图集解码失败'));
			img.src = objectUrl;
		});
		const W = img.naturalWidth, H = img.naturalHeight;
		if (W <= 0 || H <= 0) { return null; }
		const cv = document.createElement('canvas');
		cv.width = W; cv.height = H;
		const ctx = cv.getContext('2d', { willReadFrequently: true });
		if (!ctx) { return null; }
		ctx.drawImage(img, 0, 0);
		const data = ctx.getImageData(0, 0, W, H).data;
		// 是否带 alpha（抽稀）
		let tr = 0, total = 0;
		for (let i = 3; i < data.length; i += 64) { total++; if (data[i] < 250) { tr++; } }
		const hasAlpha = total > 0 && tr / total > 0.03;

		const cw = W / cols, chh = H / rows;
		const cellArea = cw * chh;
		const gridCrop = (r: number, c: number): SheetCellCrop => {
			const ix = cw * EMOJI_SHEET_MARGIN_RATIO, iy = chh * EMOJI_SHEET_MARGIN_RATIO;
			return { x: (c * cw + ix) / W, y: (r * chh + iy) / H, w: (cw - ix * 2) / W, h: (chh - iy * 2) / H };
		};

		// ── 全图前景掩码（一次，供全图 CCL） ──
		let bg = { r: 0, g: 0, b: 0 };
		if (!hasAlpha) {
			const edge: number[][] = [];
			const sx = Math.max(1, Math.floor(W / 24)), sy = Math.max(1, Math.floor(H / 24));
			for (let x = 0; x < W; x += sx) {
				for (const y of [0, H - 1]) { const i = (y * W + x) * 4; edge.push([data[i], data[i + 1], data[i + 2]]); }
			}
			for (let y = 0; y < H; y += sy) {
				for (const x of [0, W - 1]) { const i = (y * W + x) * 4; edge.push([data[i], data[i + 1], data[i + 2]]); }
			}
			const med = (ch: number) => edge.map(e => e[ch]).sort((a, b) => a - b)[Math.floor(edge.length / 2)] ?? 0;
			bg = { r: med(0), g: med(1), b: med(2) };
		}
		const mask = new Uint8Array(W * H);
		for (let p = 0; p < W * H; p++) {
			const i = p * 4;
			const fg = hasAlpha
				? data[i + 3] > 8
				: Math.hypot(data[i] - bg.r, data[i + 1] - bg.g, data[i + 2] - bg.b) > 60;
			if (fg) { mask[p] = 1; }
		}

		// ── 全图 4-连通域 CCL（labels：像素 → 连通域 id，-1 = 背景） ──
		const labels = new Int32Array(W * H).fill(-1);
		const comps: Array<{ area: number; x0: number; y0: number; x1: number; y1: number }> = [];
		const visited = new Uint8Array(W * H);
		const stack: number[] = [];
		for (let p0 = 0; p0 < mask.length; p0++) {
			if (!mask[p0] || visited[p0]) { continue; }
			const cid = comps.length;
			let area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
			stack.length = 0;
			stack.push(p0);
			visited[p0] = 1;
			while (stack.length) {
				const cur = stack.pop() as number;
				const yy = (cur / W) | 0;
				const xx = cur - yy * W;
				area++;
				labels[cur] = cid;
				if (xx < x0) { x0 = xx; }
				if (yy < y0) { y0 = yy; }
				if (xx > x1) { x1 = xx; }
				if (yy > y1) { y1 = yy; }
				const push = (j: number): void => { if (!visited[j] && mask[j]) { visited[j] = 1; stack.push(j); } };
				if (xx > 0) { push(cur - 1); }
				if (xx + 1 < W) { push(cur + 1); }
				if (yy > 0) { push(cur - W); }
				if (yy + 1 < H) { push(cur + W); }
			}
			comps.push({ area, x0, y0, x1, y1 });
		}
		if (comps.length === 0) { return null; }

		// ── 归属格：保留连通域按 bbox 中心归格（ownerAll 下标 = comps 下标） ──
		const keepArea = cellArea * 0.003;
		const ownerAll = new Int32Array(comps.length).fill(-1);
		const ownerOfComp = (cm: { x0: number; y0: number; x1: number; y1: number }): number => {
			const cx = (cm.x0 + cm.x1) / 2, cy = (cm.y0 + cm.y1) / 2;
			const gc = Math.min(cols - 1, Math.max(0, Math.floor(cx / cw)));
			const gr = Math.min(rows - 1, Math.max(0, Math.floor(cy / chh)));
			return gr * cols + gc;
		};
		const pool = comps.filter(cm => cm.area >= keepArea);
		comps.forEach((cm, i) => { if (cm.area >= keepArea) { ownerAll[i] = ownerOfComp(cm); } });
		const usePool = pool.length ? pool : comps;

		// ── 每格框：中心在本格的连通域并集 bbox → 正方形化（无硬边界/尺寸界/位移界） ──
		const out: SheetCellCrop[] = [];
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const gx = c * cw, gy = r * chh;
				const mine = usePool.filter(cm => {
					const cx = (cm.x0 + cm.x1) / 2, cy = (cm.y0 + cm.y1) / 2;
					return cx >= gx && cx < gx + cw && cy >= gy && cy < gy + chh;
				});
				if (mine.length === 0) { out.push(gridCrop(r, c)); continue; }
				let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
				for (const cm of mine) {
					bx0 = Math.min(bx0, cm.x0); by0 = Math.min(by0, cm.y0);
					bx1 = Math.max(bx1, cm.x1); by1 = Math.max(by1, cm.y1);
				}
				// bbox ±2px 保住抗锯齿边，正方形化 ×(1+padding)，中心 = bbox 中心
				const fx0 = bx0 - 2, fy0 = by0 - 2, fx1 = bx1 + 2, fy1 = by1 + 2;
				const S = Math.max(fx1 - fx0, fy1 - fy0) * (1 + padding);
				const ccx = (fx0 + fx1) / 2, ccy = (fy0 + fy1) / 2;
				// 归一化并 clamp 到图内（图边缘贴纸允许非正方形）
				const nx = Math.max(0, ccx - S / 2), ny = Math.max(0, ccy - S / 2);
				const nw = Math.min(S, W - nx), nh = Math.min(S, H - ny);
				out.push({ x: nx / W, y: ny / H, w: nw / W, h: nh / H });
			}
		}

		// ── 全图归属掩码（像素 → 归属格，-1 = 背景/未归属小碎片，供切分剔除） ──
		const owners = new Int32Array(W * H).fill(-1);
		for (let p = 0; p < W * H; p++) {
			const l = labels[p];
			if (l >= 0) { owners[p] = ownerAll[l]; }
		}

		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] autoDetectCellCrops(G 自由 CCL): ${rows}x${cols} hasAlpha=${hasAlpha} comps=${comps.length} 输出 ${out.length} 框（含归属掩码）`);
		return { crops: out, ownership: { w: W, h: H, owners } };
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn(`[EmojiStage] autoDetectCellCrops 失败，落回等分裁剪：${e instanceof Error ? e.message : String(e)}`);
		return null;
	} finally {
		if (objectUrl) { URL.revokeObjectURL(objectUrl); }
	}
}

/**
 * 本地整版去背景（2026-09-08，「去背景」按钮算法下拉用）：对**整版图集**
 * dataURL 做一次本地抠图，返回透明 PNG dataURL。零依赖、毫秒级（无需 ComfyUI）。
 *
 * - `chroma`：自动采样四边 key 色（须绿色主导，否则抛错提示换「白底几何」——
 *   与切分管线不同：按钮是用户显式选择，静默降级反而让结果与选择不符难排查）
 *   → chromaKeyFrame（同款五道后处理）。
 * - `flood`：floodFillWhiteBg 抠白底（protectPx=0，见其 JSDoc 的真实图实测）。
 */
export async function removeBgDataUrlLocal(
	dataUrl: string,
	mode: 'chroma' | 'flood',
	/** ★ chroma 参数可调（2026-09-08，「去背景」下拉配套）：缺省=表情包推荐值。
	 *  similarity 越大抠得越净（误删风险↑）；greenDominance 越大对浅色主体越宽容
	 *  （绿残留风险↑）。 */
	chromaParams?: { similarity?: number; smoothness?: number; greenDominance?: number },
): Promise<string> {
	const sim = Math.max(0.05, Math.min(0.8, chromaParams?.similarity ?? 0.25));
	const smo = Math.max(0, Math.min(0.4, chromaParams?.smoothness ?? 0.08));
	const gd = Math.max(18, Math.min(200, chromaParams?.greenDominance ?? 90));
	const blob = dataUrlToBlob(dataUrl);
	const objectUrl = URL.createObjectURL(blob);
	try {
		const img = document.createElement('img');
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('图集解码失败（格式不支持或数据损坏）。'));
			img.src = objectUrl;
		});
		const W = img.naturalWidth;
		const H = img.naturalHeight;
		if (W <= 0 || H <= 0) { throw new Error('图集尺寸无效。'); }
		const cv = document.createElement('canvas');
		cv.width = W; cv.height = H;
		const ctx = cv.getContext('2d', { willReadFrequently: true });
		if (!ctx) { throw new Error('浏览器无法创建画布。'); }
		ctx.drawImage(img, 0, 0);
		const data = ctx.getImageData(0, 0, W, H);
		const rgba = new Uint8Array(data.data.buffer);
		if (mode === 'chroma') {
			const key = autoSampleChromaKeyRgba(rgba, W, H);
			const greenDominant = key.g >= 100 && key.g - Math.max(key.r, key.b) >= 60;
			if (!greenDominant) {
				throw new Error(`采样到的幕布色 rgb(${key.r},${key.g},${key.b}) 不是绿色 —— 图集背景不是绿幕。白底图集请选「白底几何」，或重新生成绿幕图集。`);
			}
			chromaKeyFrame(rgba, key, sim, smo, 'rgb', { greenDominance: gd, boxFilterDistance: true, softAlpha: true });
			// ★ softAlpha 自带连续软边，smoothStickerAlpha（二值事后平滑）跳过
		} else {
			floodFillWhiteBg(rgba, W, H, 0);
		}
		ctx.putImageData(data, 0, 0);
		return cv.toDataURL('image/png');
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
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
export function floodFillWhiteBg(rgba: Uint8Array, w: number, h: number, protectPx = 0): void {
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

/**
 * 全图连通域归属掩码（2026-09-10，G 方案配套）——供 splitStickerSheet 在裁剪时
 * 把「归属其他格」的邻格越格像素 alpha 置 0（根治「框内出现邻格元素」的残留）。
 */
export interface SheetOwnershipMask {
	w: number;
	h: number;
	/** 长度 w*h，值 = 归属格 index（0..rows*cols-1），-1 = 背景 / 未归属小碎片（保留不剔）。 */
	owners: Int32Array;
}

/** autoDetectCellCrops 的完整检测结果：裁剪框 + 归属掩码（切分剔除用）。 */
export interface SheetDetectionResult {
	crops: SheetCellCrop[];
	ownership: SheetOwnershipMask;
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
export function defaultSheetCellCrops(rows: number, cols: number, marginRatio = EMOJI_SHEET_MARGIN_RATIO): SheetCellCrop[] {
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
	opts: { marginRatio?: number; cutoutBg?: boolean; protectPx?: number; chroma?: boolean; cellCrops?: SheetCellCrop[] | null; ownership?: SheetOwnershipMask | null },
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
		// ★ 透明背景预检（2026-09-08）：模型原生输出带 alpha 的图集（prompt 模板
		//   transparent background 生效 / 模型支持 alpha 输出）时**跳过一切抠图**
		//   —— 再跑 chroma（采样透明像素得到无意义 key）或 flood 都是多余甚至有害。
		//   判据：全图**抽稀**统计 alpha<8 的像素占比 > 3%（真透明背景图集通常
		//   >20%；不透明图集为 0%）。抽稀步长 16 像素（查每 4 个像素的 alpha 字节，
		//   i+=64），1254² 约 9.8 万样本，一次 getImageData 成本可接受。
		let alreadyTransparent = false;
		{
			const probe = fctx.getImageData(0, 0, W, H).data;
			let tr = 0;
			let total = 0;
			for (let i = 3; i < probe.length; i += 64) { total++; if (probe[i] < 8) { tr++; } }
			alreadyTransparent = total > 0 && tr / total > 0.03;
			if (alreadyTransparent && (opts.chroma || cutout)) {
				// eslint-disable-next-line no-console
				console.warn(`[EmojiStage] 图集已带透明背景（透明像素 ${(100 * tr / total).toFixed(1)}%），跳过抠图（chroma/flood）——纯裁剪`);
			}
		}
		// 绿幕模式：key 色延迟采样（首格时从整版四边取中位），全格共用。
		let chromaKey: { r: number; g: number; b: number } | null = null;
		// ★ 非绿幕降级标志（2026-09-08）：采样到非绿 key（模型未遵循绿幕 prompt）→
		//   整图集降级白底 flood-fill，避免「白 key 抠掉白色主体」灾难。
		let chromaBroken = false;
		const crops = opts.cellCrops && opts.cellCrops.length === rows * cols
			? opts.cellCrops
			: defaultSheetCellCrops(rows, cols, opts.marginRatio ?? EMOJI_SHEET_MARGIN_RATIO);

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
			if (alreadyTransparent) {
				// 已透明：纯裁剪（抠图三态 none/chroma/flood 均跳过）
			} else if (opts.chroma && !chromaBroken) {
				// ★ 绿幕模式（2026-09-08）：复用 VideoToGif 的产品级 chromaKeyFrame
				//   （主抠 + 五道后处理：choke 内缩 / 邻接 despill / 形态学开 / 碎块清除）。
				//   key 色由**首格**从整版四边自动采样（绿幕图集背景均匀，一次采样全格共用，
				//   避免逐格采样被格内主体干扰）。默认 similarity 0.4 / smoothness 0.1
				//   （与动图抠像默认一致）。适用前提：图集背景为纯绿幕（绿衣服等高饱和
				//   绿主体会被误抠 —— 换品红/蓝幕即可，算法不变）。
				if (!chromaKey) {
					chromaKey = autoSampleChromaKeyRgba(new Uint8Array(fctx.getImageData(0, 0, W, H).data.buffer), W, H);
					// ★ 绿色主导校验（2026-09-08 修复「图集表现异常」）：模型可能不遵循
					//   绿幕 prompt（gpt-image-2 常见，出白底/浅底图集）。若采样到的 key
					//   不是绿色主导（如白色 exc≈0），以它为 key 色距抠图会把白底+白色
					//   主体（白发/白描边）全抠掉，黑色细碎主体再被形态学开+碎块清除
					//   抹掉 → 整格只剩零星彩色碎片。故：非绿幕 → 置 chromaBroken，
					//   **整图集降级白底 flood-fill**（白底场景 flood 反而最稳）。
					const greenDominant = chromaKey.g >= 100 && chromaKey.g - Math.max(chromaKey.r, chromaKey.b) >= 60;
					if (!greenDominant) {
						chromaBroken = true;
						chromaKey = null;
						// eslint-disable-next-line no-console
						console.warn(`[EmojiStage] chroma mode: sampled key 非绿色主导 —— 图集不是绿幕（模型未遵循绿幕 prompt），整图集降级白底 flood-fill 抠图`);
					} else {
						// eslint-disable-next-line no-console
						console.warn(`[EmojiStage] chroma mode: sampled key=rgb(${chromaKey.r},${chromaKey.g},${chromaKey.b}) green-dominant ✓`);
					}
				}
			}
			if (opts.chroma && !chromaBroken && chromaKey) {
				const data = cctx.getImageData(0, 0, cw, ch);
				// ★ 表情包专用参数（2026-09-08）：贴纸=白描边+白发**白色主体**，默认
				//   similarity 0.4 / greenDominance 18 会把沾绿溢色的浅色主体误删。
				//   收紧：t2≈146 + greenDominance 90。
				// ★ OBS 对标软边（2026-09-08）：距离场 3×3 盒式预滤波 + 连续 pow 曲线
				//   alpha（smoothStickerAlpha 的中值+羽化专为二值 alpha 事后补救设计，
				//   软 alpha 下跳过，避免过度羽化）。
				chromaKeyFrame(new Uint8Array(data.data.buffer), chromaKey, 0.25, 0.08, 'rgb', {
					greenDominance: 90, boxFilterDistance: true, softAlpha: true,
				});
				cctx.putImageData(data, 0, 0);
			} else if (!alreadyTransparent && (cutout || (opts.chroma && chromaBroken))) {
				// flood 路径：白底图集（或 chroma 降级）走 floodFillWhiteBg
				const data = cctx.getImageData(0, 0, cw, ch);
				floodFillWhiteBg(new Uint8Array(data.data.buffer), cw, ch, opts.protectPx ?? 0);
				cctx.putImageData(data, 0, 0);
			}
			// ★ 像素级归属剔除（2026-09-10，G 方案）：把框内「归属其他格」的连通域
			//   像素 alpha 置 0 —— 根治「自由 CCL 框越格/重叠把邻格贴纸带进本格」的
			//   残留。ownership 由 autoDetectCellCrops 产出，与整图 W/H 严格对应。
			if (opts.ownership && opts.ownership.w === W && opts.ownership.h === H) {
				const id = cctx.getImageData(0, 0, cw, ch);
				const d = id.data;
				const owners = opts.ownership.owners;
				for (let py = 0; py < ch; py++) {
					const oy = y0 + py;
					for (let px = 0; px < cw; px++) {
						const ox = x0 + px;
						const owner = owners[oy * W + ox];
						if (owner >= 0 && owner !== ci) { d[(py * cw + px) * 4 + 3] = 0; }
					}
				}
				cctx.putImageData(id, 0, 0);
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
