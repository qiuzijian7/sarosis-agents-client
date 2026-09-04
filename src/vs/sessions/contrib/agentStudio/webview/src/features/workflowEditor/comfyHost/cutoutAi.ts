/*---------------------------------------------------------------------------------------------
 *  cutoutAi.ts — 表情包「AI 抠图」webview 侧（内置 rembg 算法的前端半边）。
 *
 *  链路：本文件（webview，图像解码/缩放/alpha 合成）
 *        → sendRequest('cutout.*') → controller 透传
 *        → electron-main cutoutChannel（ONNX U²Net 推理，rembg 同款预处理/后处理）。
 *
 *  ★ 算法完全内置：无独立服务、无 Python、无外部进程。模型（u2net.onnx 176MB /
 *    u2netp.onnx 4.6MB）首次使用时由主进程从 rembg 官方 release 下载，缓存到
 *    ~/.vssaros/cutout-models，之后离线可用。
 *
 *  接入点：workflowRun.applyAiCutout —— 对**整版图集**跑一次推理（比逐格省 9 倍），
 *  返回带 alpha 的 dataURL，后续切分照旧。
 *--------------------------------------------------------------------------------------------*/

import { sendRequest } from '../../../bridge/messageClient.js';

/** 可用模型（与 electron-main cutoutChannel.CUTOUT_MODELS 对齐）。 */
export type CutoutModel = 'u2net' | 'u2netp';

const MODEL_LABELS: Record<CutoutModel, string> = {
	u2net: 'U²Net（176MB，rembg 默认）',
	u2netp: 'U²Net 轻量（4.6MB）',
};

export interface EnsureModelResult {
	ok: boolean;
	path?: string;
	size?: number;
	existed?: boolean;
	downloading?: boolean;
	error?: string;
}

export interface ModelProgress {
	exists?: boolean;
	received?: number;
	total?: number;
	done?: boolean;
	error?: string;
}

export interface CutoutRemoveResult {
	ok: boolean;
	maskW?: number;
	maskH?: number;
	mask?: Uint8Array;
	model?: string;
	elapsedMs?: number;
	error?: string;
}

/** 确保模型已下载（已存在秒回；否则触发主进程后台下载，进度走 pollModelProgress）。 */
export function ensureCutoutModel(model: CutoutModel = 'u2net'): Promise<EnsureModelResult> {
	return sendRequest<{ model: CutoutModel }, EnsureModelResult>('cutout.ensureModel', { model }, 15_000);
}

/** 轮询下载进度（字节级）。 */
export function pollModelProgress(model: CutoutModel = 'u2net'): Promise<ModelProgress> {
	return sendRequest<{ model: CutoutModel }, ModelProgress>('cutout.modelProgress', { model }, 10_000);
}

/** 查询本地缓存状态（dir + 各模型是否存在）。 */
export function queryCutoutStatus(): Promise<{ ok: boolean; models?: Record<string, { exists: boolean; size: number }>; dir?: string; error?: string }> {
	return sendRequest<Record<string, never>, { ok: boolean; models?: Record<string, { exists: boolean; size: number }>; dir?: string; error?: string }>('cutout.status', {}, 10_000);
}

/**
 * ★ AI 抠图核心（像素级）：原图 RGBA → 主进程 ONNX U²Net mask → canvas 双线性
 *   放大回原尺寸 → 写入 alpha 通道 → 返回**带 alpha 的新 RGBA**（尺寸不变）。
 *
 *  所有"去背景"入口（表情包整版切分 / 迷你编辑器 / 表情卡片按钮 / Saros.RemoveBg
 *  节点）统一走这里 —— 2026-09-03 起全项目废弃 127.0.0.1:7000 独立 rembg 服务。
 *  模型未就绪时内部自动触发下载（幂等，exists 秒回）。
 */
export async function removeBackgroundRgba(
	rgba: Uint8Array,
	w: number,
	h: number,
	model: CutoutModel = 'u2net',
	signal?: AbortSignal,
	onStatus?: (text: string) => void,
): Promise<Uint8Array> {
	if (!w || !h || rgba.length < w * h * 4) { throw new Error('AI 抠图：像素尺寸无效'); }
	await ensureModelReady(model, (text) => {
		onStatus?.(text);
		// eslint-disable-next-line no-console
		console.warn('[cutoutAi]', text);
	});
	const t0 = Date.now();
	const resp = await sendRequest<{ width: number; height: number; rgba: Uint8Array; model: CutoutModel }, CutoutRemoveResult>(
		'cutout.remove',
		{ width: w, height: h, rgba: new Uint8Array(rgba.buffer.slice(0)), model },
		10 * 60_000,
	);
	if (signal?.aborted) { throw new Error('AI 抠图已取消'); }
	if (!resp?.ok || !resp.mask || !resp.maskW || !resp.maskH) {
		throw new Error(resp?.error || 'AI 抠图推理失败');
	}

	// mask 320² → 高质量双线性放大回 W×H → 写 alpha
	const maskCv = document.createElement('canvas');
	maskCv.width = resp.maskW; maskCv.height = resp.maskH;
	const mctx = maskCv.getContext('2d');
	if (!mctx) { throw new Error('AI 抠图：无法创建 mask 画布'); }
	const maskImg = mctx.createImageData(resp.maskW, resp.maskH);
	for (let i = 0; i < resp.mask.length; i++) {
		// mask 是灰度显著图：白=前景。塞进 RGBA 四通道同值，放大后取 G 通道当 alpha。
		maskImg.data[i * 4] = 255;
		maskImg.data[i * 4 + 1] = resp.mask[i];
		maskImg.data[i * 4 + 2] = 255;
		maskImg.data[i * 4 + 3] = 255;
	}
	mctx.putImageData(maskImg, 0, 0);

	const upCv = document.createElement('canvas');
	upCv.width = w; upCv.height = h;
	const uctx = upCv.getContext('2d', { willReadFrequently: true });
	if (!uctx) { throw new Error('AI 抠图：无法创建放大画布'); }
	uctx.imageSmoothingEnabled = true;
	uctx.imageSmoothingQuality = 'high';
	uctx.drawImage(maskCv, 0, 0, w, h);
	const upMask = uctx.getImageData(0, 0, w, h).data;

	const out = new Uint8Array(rgba); // 拷贝，不动调用方数据
	for (let i = 0; i < w * h; i++) {
		out[i * 4 + 3] = upMask[i * 4 + 1];
	}
	void t0;
	return out;
}

/**
 * AI 抠图便捷版：图 URL/dataURL → 解码 → removeBackgroundRgba →
 * 返回一张**带 alpha 的透明 dataURL**（尺寸与输入一致）。
 */
export async function removeBackgroundAi(
	src: string,
	model: CutoutModel = 'u2net',
	signal?: AbortSignal,
): Promise<{ ok: boolean; dataUrl?: string; elapsedMs?: number; error?: string }> {
	// ── 1. 解码原图 → 全尺寸 canvas ──
	const img = new Image();
	img.decoding = 'async';
	img.src = src;
	await new Promise<void>((resolve, reject) => {
		const abort = () => reject(new Error('AI 抠图已取消'));
		if (signal?.aborted) { return abort(); }
		img.onload = () => resolve();
		img.onerror = () => reject(new Error('AI 抠图：整版图解码失败'));
		signal?.addEventListener('abort', abort, { once: true });
	});
	const W = img.naturalWidth, H = img.naturalHeight;
	if (!W || !H) { return { ok: false, error: 'AI 抠图：整版图尺寸无效' }; }

	const full = document.createElement('canvas');
	full.width = W; full.height = H;
	const fctx = full.getContext('2d', { willReadFrequently: true });
	if (!fctx) { return { ok: false, error: 'AI 抠图：无法创建画布' }; }
	fctx.drawImage(img, 0, 0);
	const imageData = fctx.getImageData(0, 0, W, H);

	// ── 2. 核心抠图（RPC → ONNX → mask 放大 → alpha）──
	const t0 = Date.now();
	const out = await removeBackgroundRgba(new Uint8Array(imageData.data.buffer.slice(0)), W, H, model, signal);
	imageData.data.set(out);
	fctx.putImageData(imageData, 0, 0);

	return { ok: true, dataUrl: full.toDataURL('image/png'), elapsedMs: Date.now() - t0 };
}

/** 编辑器下拉用的选项（含体积提示）。 */
export function cutoutModelOptions(): Array<{ value: CutoutModel; label: string }> {
	return (Object.keys(MODEL_LABELS) as CutoutModel[]).map(v => ({ value: v, label: MODEL_LABELS[v] }));
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * 确保模型就绪：本地缓存不存在时触发主进程下载并**轮询进度直到完成**。
 * 首次下载 176MB 视带宽约 1~5 分钟；之后秒回。
 *
 * @param onStatus 进度回调（received/total 字节），表情包执行器透传给任务进度。
 * @returns 就绪返回 true；下载失败抛错（调用方降级几何抠图）。
 */
export async function ensureModelReady(
	model: CutoutModel = 'u2net',
	onStatus?: (text: string) => void,
): Promise<boolean> {
	const status = await queryCutoutStatus();
	if (status.ok && status.models?.[model]?.exists) { return true; }
	const ensured = await ensureCutoutModel(model);
	if (!ensured.ok) { throw new Error(ensured.error || '模型下载触发失败'); }
	if (ensured.existed) { return true; }
	for (;;) {
		const p = await pollModelProgress(model);
		if (p.exists) { return true; }
		if (p.error) { throw new Error(`模型下载失败：${p.error}`); }
		// 兜底：主进程报 done 且无错误（即使 exists 探测因文件系统延迟短暂 false）
		// 也不再空转 —— 下一轮推理若真缺文件会给出明确错误，不会静默卡死。
		if (p.done) { return true; }
		if (typeof p.received === 'number' && typeof p.total === 'number' && p.total > 0) {
			const mb = (p.received / 1e6).toFixed(0), tot = (p.total / 1e6).toFixed(0);
			onStatus?.(`AI 抠图模型下载中 ${mb}/${tot}MB（首次使用，之后离线可用）`);
		} else {
			onStatus?.('AI 抠图模型下载中…');
		}
		await sleep(900);
	}
}
