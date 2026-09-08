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

// ★ 表情图集配置与切分工具（background/size/margin/prompt/crops/splitStickerSheet）。

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
	// ★ 格间留白强化（2026-09-07）：「clear thin gaps」实测模型留白过小 → 贴纸
	//   几乎贴满格 → 切分单格边缘带邻格内容 → 转动态相互污染。改为：宽缝 + 贴纸
	//   只占格内约 75% 居中 + 明确「不触碰/不越过格边」。
	const header =
		`a sticker sheet of ${total} separate die-cut cartoon stickers arranged in a strict ` +
		`${rows} rows × ${cols} columns grid layout, equal-size cells, clear wide gaps between ` +
		`stickers, each sticker occupies about 75% of its cell, centered, never touching or ` +
		`crossing the cell edges, each sticker fully inside its own cell with white outline` +
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
