/*---------------------------------------------------------------------------------------------
 *  miniEditorAi — 迷你图像编辑器（MiniImageEditor）的 AI 工具纯逻辑层。
 *
 *  四个工具与后端：
 *    - 去背景   → 本地 rembg 服务（rembg_server.py，POST /api/remove；与工作流
 *                 Saros.RemoveBg 节点同一契约，常量复用 comfyHost/removeBg.ts）。
 *    - AI消除   → provider LLM img2img（imagegen.generate RPC，imageInput）：
 *                 蒙版区域烙品红标记块 + 自动 prompt「移除并自然填补背景」。
 *    - 局部重绘 → 同上，用户 prompt：「重绘品红标记区域为 …」。
 *    - 扩图     → 画布四边外扩（比例可选），新区域填品红 + prompt「无缝延展背景」。
 *
 *  为什么用「品红标记 + img2img」而不是 ComfyUI inpaint：
 *    - provider 通道（imagegen.generate）在 webview 内自闭环可调，host 已支持
 *      imageInput（agentStudioWebviewController._handleImageGenGenerate）；
 *    - GPT-image / Gemini 系编辑模型对「品红标记区域」的指令遵循良好（表情包
 *      「转动态表情包」已在用同一 img2img 通道），免配置 ComfyUI inpaint 模型；
 *    - 品红 #FF00FF 与照片内容色距最大，标记误伤最小；prompt 明确声明
 *      「品红仅是标记，不得出现在结果中」。
 *
 *  本模块只放**纯函数/无 UI 逻辑**（合成、prompt、响应解析），便于单测；
 *  React 状态与 RPC 调用在 MiniImageEditor.tsx。
 *--------------------------------------------------------------------------------------------*/

import { REMBG_DEFAULT_URL } from './comfyHost/removeBg.js';
import { removeBackgroundRgba } from './comfyHost/cutoutAi.js';

export { REMBG_DEFAULT_URL };

/** 品红标记色（与照片内容色距最大的约定标记色）。 */
export const MARK_COLOR = '#ff00ff';

/** 发送给 provider 的图最长边上限（过大图 provider 易 4xx/超时；缩小几乎不损编辑质量）。 */
export const GEN_MAX_SIDE = 1536;

// ─── 蒙版合成 ───────────────────────────────────────────────────────────────

/**
 * 合成「基底 + 编辑层 + 蒙版品红标记」→ dataURL。
 *
 * - overlay：MiniImageEditor 的既有编辑层（画笔/文字），原样带上——AI 编辑不应
 *   丢掉用户已画的涂鸦；
 * - mask：白色=标记区（画成品红）。mask 为空/全透明 → 只合成底+overlay。
 * 纯 canvas 函数（浏览器环境）。
 */
export function composeMarkedImage(
	base: HTMLCanvasElement,
	overlay: HTMLCanvasElement | null,
	hasOverlayEdits: boolean,
	mask: HTMLCanvasElement | null,
): string {
	const out = document.createElement('canvas');
	out.width = base.width;
	out.height = base.height;
	const ctx = out.getContext('2d');
	if (!ctx) { return ''; }
	ctx.drawImage(base, 0, 0);
	if (overlay && hasOverlayEdits) { ctx.drawImage(overlay, 0, 0); }
	if (mask) { ctx.drawImage(mask, 0, 0); }
	return out.toDataURL('image/png');
}

/**
 * 把 dataURL 图缩到最长边 ≤ maxSide（只缩不放大）。返回新 dataURL。
 * provider img2img 对超大图容易失败；>maxSide 时等比缩小。纯 canvas 函数。
 */
export async function downscaleDataUrl(dataUrl: string, maxSide = GEN_MAX_SIDE): Promise<string> {
	const img = await loadImage(dataUrl);
	const w = img.naturalWidth, h = img.naturalHeight;
	if (w <= 0 || h <= 0 || Math.max(w, h) <= maxSide) { return dataUrl; }
	const scale = maxSide / Math.max(w, h);
	const out = document.createElement('canvas');
	out.width = Math.max(1, Math.round(w * scale));
	out.height = Math.max(1, Math.round(h * scale));
	out.getContext('2d')?.drawImage(img, 0, 0, out.width, out.height);
	return out.toDataURL('image/png');
}

/** 加载图片（data URL / 同源 URL）。跨源 URL 需 anonymous（与 MiniImageEditor 同策略）。 */
export function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('图片加载失败（引用失效或跨域拒绝）'));
		img.src = src;
	});
}

/**
 * 任意快照 ref（data: / ComfyUI view URL / 同源 URL）→ PNG dataURL。
 * ComfyUI 启动参数带 --enable-cors-header → anonymous 加载不污染画布，
 * toDataURL 可用（MiniImageEditor 同路径已验证）。浏览器环境。
 */
export async function refToPngDataUrl(ref: string): Promise<string> {
	const img = await loadImage(ref);
	const canvas = document.createElement('canvas');
	canvas.width = img.naturalWidth || 1;
	canvas.height = img.naturalHeight || 1;
	const ctx = canvas.getContext('2d');
	if (!ctx) { throw new Error('浏览器无法创建画布'); }
	ctx.drawImage(img, 0, 0);
	return canvas.toDataURL('image/png');
}

// ─── 扩图 ───────────────────────────────────────────────────────────────────

/** 扩图计划：新画布尺寸 + 原图左上角偏移。纯函数。 */
export interface OutpaintPlan {
	width: number;
	height: number;
	dx: number;
	dy: number;
}

/**
 * 计算四边各扩 ratio（0..1，相对原边长）后的画布尺寸与原图偏移。
 * 上限 4096（provider 常见上限）。纯函数。
 */
export function planOutpaint(srcW: number, srcH: number, ratio: number): OutpaintPlan {
	const r = Math.max(0, Math.min(1, ratio));
	const width = Math.min(4096, Math.max(1, Math.round(srcW * (1 + 2 * r))));
	const height = Math.min(4096, Math.max(1, Math.round(srcH * (1 + 2 * r))));
	return { width, height, dx: Math.round((width - srcW) / 2), dy: Math.round((height - srcH) / 2) };
}

/**
 * 合成扩图标记图：品红底 → 原图居中 → 编辑层原偏移叠加。
 * 品红区域 = 待 AI 填充的新增区。纯 canvas 函数。
 */
export function composeOutpaintMarked(
	base: HTMLCanvasElement,
	overlay: HTMLCanvasElement | null,
	hasOverlayEdits: boolean,
	ratio: number,
): { dataUrl: string; plan: OutpaintPlan } {
	const plan = planOutpaint(base.width, base.height, ratio);
	const out = document.createElement('canvas');
	out.width = plan.width;
	out.height = plan.height;
	const ctx = out.getContext('2d');
	if (!ctx) { return { dataUrl: '', plan }; }
	ctx.fillStyle = MARK_COLOR;
	ctx.fillRect(0, 0, plan.width, plan.height);
	ctx.drawImage(base, plan.dx, plan.dy);
	if (overlay && hasOverlayEdits) { ctx.drawImage(overlay, plan.dx, plan.dy); }
	return { dataUrl: out.toDataURL('image/png'), plan };
}

// ─── Prompt ────────────────────────────────────────────────────────────────

const MARK_NOTE = '品红色（#FF00FF）只是标记色，生成结果中绝对不能出现品红色。';

/** AI消除 prompt（无需用户输入：移除 + 自然填补）。 */
export function buildErasePrompt(): string {
	return `精确移除图中品红色标记区域内的全部内容，用周围的背景/环境自然无缝地填补该区域。品红区域以外的画面内容必须保持完全不变。${MARK_NOTE}`;
}

/** 局部重绘 prompt（用户提供内容描述）。 */
export function buildInpaintPrompt(userPrompt: string): string {
	const want = userPrompt.trim() || '与周围画面风格一致的内容';
	return `将图中品红色标记的区域重绘为：${want}。重绘区域必须与周围画面在光照、透视、风格上自然融合。品红区域以外的画面内容必须保持完全不变。${MARK_NOTE}`;
}

/** 扩图 prompt。 */
export function buildOutpaintPrompt(): string {
	return `将画面内容向四周自然向外扩展，用符合原图场景、光照与风格的背景无缝填充品红色区域。原有画面（非品红区域）的内容必须保持完全不变。${MARK_NOTE}`;
}

// ─── 响应解析 ───────────────────────────────────────────────────────────────

/**
 * 从 imagegen.generate 响应取第一张图 → dataURL。
 * host 已把远程 url 内联为 b64（inlineRemoteImageUrls），两种形态都兼容。纯函数。
 */
export function extractFirstImageDataUrl(resp: { images?: Array<{ url?: string; b64?: string }> }): string {
	const first = resp.images?.[0];
	if (!first) { throw new Error('生成结果为空（provider 未返回图片）'); }
	if (first.b64) { return `data:image/png;base64,${first.b64}`; }
	if (first.url) { return first.url; }
	throw new Error('生成结果缺少图片数据');
}

// ─── rembg 去背景 ──────────────────────────────────────────────────────────

/** 服务不可达的统一识别与提示（与 removeBgExecutor 同款映射）。 */
export function friendlyRembgError(err: unknown): Error {
	const raw = err instanceof Error ? err.message : String(err);
	if (/Failed to fetch|NetworkError|ECONNREFUSED|load failed/i.test(raw)) {
		return new Error('rembg 服务未启动：请在 rembg 目录运行 python rembg_server.py（默认 127.0.0.1:7000）后重试。');
	}
	return err instanceof Error ? err : new Error(raw);
}

/**
 * 调本地 rembg `/api/remove`：dataURL 图 → RGBA 透明 PNG dataURL。
 * 与 Saros.RemoveBg 节点同契约（file/model/a/ppm 字段）；固定 bria-rmbg +
 * post_process（编辑器场景不需要暴露调参）。浏览器环境（FormData/atob）。
 */
export async function rembgRemoveDataUrl(dataUrl: string, baseUrl = REMBG_DEFAULT_URL, onStatus?: (text: string) => void): Promise<string> {
	// 2026-09-03：切换到**内置 AI 抠图**（主进程 ONNX U²Net，cutout.remove RPC，
	// 见 comfyHost/cutoutAi.ts）—— 全项目废弃 127.0.0.1:7000 独立 rembg 服务
	// （rembg_server.py 不再需要启动）。baseUrl 参数仅为签名兼容保留，不再使用。
	void baseUrl;
	const img = new Image();
	img.src = dataUrl;
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error('去背景：图片解码失败'));
	});
	const W = img.naturalWidth, H = img.naturalHeight;
	const cv = document.createElement('canvas');
	cv.width = W; cv.height = H;
	const ctx = cv.getContext('2d', { willReadFrequently: true });
	if (!ctx) { throw new Error('去背景：无法创建画布'); }
	ctx.drawImage(img, 0, 0);
	const imageData = ctx.getImageData(0, 0, W, H);
	const out = await removeBackgroundRgba(new Uint8Array(imageData.data.buffer.slice(0)), W, H, 'u2net', undefined, onStatus);
	imageData.data.set(out);
	ctx.putImageData(imageData, 0, 0);
	return cv.toDataURL('image/png');
}
