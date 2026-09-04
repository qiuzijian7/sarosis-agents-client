/*---------------------------------------------------------------------------------------------
 *  videoToGifExecutor — 「视频转 GIF」节点的浏览器本地执行。
 *
 *  链路：取上游视频 ref → fetch 成 blob（绕开跨源画布污染）→ HTMLVideoElement
 *  逐点 seek 抽帧 → canvas 缩放 → medianCut 量化 + LZW/GIF89a 编码 →
 *  上传 ComfyUI input/（失败退 data:）→ snapshotStore.put。
 *
 *  与 instantExecutor 同架构（见该文件注释），差异点：
 *    - 源是**视频**而非图像（firstUpstreamVideo）；
 *    - 必须走 `blob:` object URL：跨源 video 画到 canvas 会污染画布，
 *      `getImageData` 直接抛 SecurityError（GIF 编码强依赖像素读取）；
 *    - 抽帧是**异步串行 seek**，进度按帧回报（编码大 gif 可能数秒）。
 *--------------------------------------------------------------------------------------------*/

import type { ComfyRunProgress, IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { encodeGif, medianCutPalette, mapToPaletteIndices, mapToPaletteIndicesWithAlpha, planGifFrames, type GifFrameInput } from './videoToGif.js';

export interface VideoToGifInput {
	runner: IComfyRunner;
	nodeId: string;
	/** 快照归档键（= stageUid）。缺省回退 nodeId。 */
	snapshotKey?: string;
	type: string;
	values: Record<string, unknown>;
	upstreams?: string[];
	store: MediaSnapshotStore;
	onProgress?: (p: ComfyRunProgress) => void;
	/** Injectable fetch (proxy) —— 上游多为 ComfyUI view URL（跨源 403）。 */
	fetchImpl?: typeof fetch;
}

/** `data:` URL → Blob（webview CSP 的 connect-src 不含 data:，必须本地解码）。 */
export function dataUrlToBlob(url: string): Blob {
	const comma = url.indexOf(',');
	if (comma < 0) { throw new TypeError('Invalid data: URL'); }
	const meta = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	const isB64 = /;base64$/i.test(meta);
	const contentType = (isB64 ? meta.replace(/;base64$/i, '') : meta) || 'application/octet-stream';
	if (!isB64) { return new Blob([decodeURIComponent(payload)], { type: contentType }); }
	const bin = atob(payload);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
	return new Blob([arr as unknown as BlobPart], { type: contentType });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result ?? ''));
		fr.onerror = () => reject(fr.error ?? new Error('读取 GIF 失败'));
		fr.readAsDataURL(blob);
	});
}

/**
 * 取上游**最新**的一段视频（index 最大 = 最近一次输出）。
 * 与 instantExecutor.firstUpstreamImage 同策略（见该函数注释：取第一条会永远
 * 拿到最早的输出，上游重跑后下游不更新）。
 */
function firstUpstreamVideo(store: MediaSnapshotStore, upstreams: string[] | undefined): string | undefined {
	let best: { ref: string; index: number } | undefined;
	for (const id of upstreams ?? []) {
		for (const entry of store.byNode(id)) {
			if (entry.media.kind !== 'video' || !entry.media.ref) { continue; }
			const idx = entry.index ?? 0;
			if (!best || idx >= best.index) { best = { ref: entry.media.ref, index: idx }; }
		}
	}
	return best?.ref;
}

/** 等待视频元数据（拿到 duration / videoWidth）。 */
function waitMetadata(video: HTMLVideoElement): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (video.readyState >= 1 /* HAVE_METADATA */) { resolve(); return; }
		const ok = (): void => { cleanup(); resolve(); };
		const bad = (): void => {
			cleanup();
			// ★ 诊断：探测浏览器对常见视频编码的支持，快速区分「HEVC 不支持」vs「其它解码失败」。
			const probe = ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="av01.0.05M.08"']
				.map(t => `${t.replace('video/mp4; codecs=', '')}=${video.canPlayType(t) || 'no'}`).join(' ');
			reject(new Error(`视频元数据加载失败（编码不支持？video.error.code=${video.error?.code ?? '?'} canPlayType: ${probe}）`));
		};
		const cleanup = (): void => {
			video.removeEventListener('loadedmetadata', ok);
			video.removeEventListener('error', bad);
		};
		video.addEventListener('loadedmetadata', ok);
		video.addEventListener('error', bad);
	});
}

/**
 * seek 到指定时间并等待该帧**真正解码渲染**。
 *
 * ★ 只等 `seeked` + 一个 rAF 不够：实测（Chrome，H.264）`seeked` 触发后立刻
 *   drawImage 会画出**黑帧**（视频解码器尚未产出目标帧 → 画的是空缓冲），
 *   双 rAF 给合成器足够时间渲染目标帧（实测每帧抽到 5 万+ 色，内容正确）。
 *
 * ★ 不用 `requestVideoFrameCallback`：在 Playwright 的 Chrome 151 环境下，rVFC
 *   回调会导致页面执行上下文被销毁（"Execution context was destroyed"），
 *   抽帧直接失败。双 rAF 简单、够用、零兼容坑。
 */
function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => { cleanup(); resolve(); }, 3000);  // 兜底，防某些流永不触发 seeked
		const finish = (): void => { if (settled) { return; } settled = true; clearTimeout(timer); cleanup(); resolve(); };
		const fail = (err: unknown): void => { if (settled) { return; } settled = true; clearTimeout(timer); cleanup(); reject(err instanceof Error ? err : new Error(String(err))); };
		const onSeeked = (): void => { requestAnimationFrame(() => requestAnimationFrame(finish)); };
		const onError = (): void => { fail(new Error(`seek 到 ${t.toFixed(2)}s 失败`)); };
		const cleanup = (): void => {
			video.removeEventListener('seeked', onSeeked);
			video.removeEventListener('error', onError);
		};
		video.addEventListener('seeked', onSeeked);
		video.addEventListener('error', onError);
		try {
			video.currentTime = t;
		} catch (err) { fail(err); }
	});
}

/** 转换结果：GIF 的 Blob + 元数据。 */
export interface ConvertedGif {
	gifBlob: Blob;
	width: number;
	height: number;
	frames: number;
	delayCs: number;
}

/**
 * 核心转换：取视频 ref → fetch 成 blob → HTMLVideoElement 逐帧 seek 抽帧 →
 * canvas 缩放 → medianCut 量化 + LZW/GIF89a 编码。返回 GIF Blob（不含上传/归档）。
 *
 * 从 runVideoToGifNode 抽出，供「视频转 GIF」节点 + emoji stage 自动转 GIF 共用。
 * 浏览器环境（依赖 document/HTMLVideoElement/canvas）。
 */
export async function convertVideoToGif(
	videoRef: string,
	values: Record<string, unknown>,
	fetchImpl: typeof fetch,
	onProgress?: (p: ComfyRunProgress) => void,
): Promise<ConvertedGif> {
	let objectUrl = '';
	const video = document.createElement('video');
	try {
		onProgress?.({ value: 5 });
		// ★ 必须先取成 blob 再走 blob: URL —— 直接把跨源 URL 给 <video> 会污染
		//   canvas，后续 getImageData 抛 SecurityError（GIF 编码依赖像素读取）。
		const blob = /^data:/i.test(videoRef) ? dataUrlToBlob(videoRef) : await (await fetchImpl(videoRef)).blob();
		objectUrl = URL.createObjectURL(blob);

		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.src = objectUrl;
		await waitMetadata(video);

		const srcW = video.videoWidth || 0;
		const srcH = video.videoHeight || 0;
		if (srcW <= 0 || srcH <= 0) {
			throw new Error('无法读取视频尺寸（解码失败）。');
		}
		const plan = planGifFrames(values, video.duration, srcW, srcH);

		const canvas = document.createElement('canvas');
		canvas.width = plan.width;
		canvas.height = plan.height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) { throw new Error('浏览器无法创建画布。'); }

		// ── 逐帧抽取 + 量化 ──────────────────────────────────────────────────
		const frames: GifFrameInput[] = [];
		for (let i = 0; i < plan.times.length; i++) {
			await seekTo(video, plan.times[i]);
			ctx.drawImage(video, 0, 0, plan.width, plan.height);
			const data = ctx.getImageData(0, 0, plan.width, plan.height).data;
			const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			const palette = medianCutPalette(rgba, plan.colors);
			frames.push({
				indices: mapToPaletteIndices(rgba, palette),
				palette,
				delayCs: plan.delayCs,
			});
			// 抽帧+量化占 85% 进度，编码/上传留 15%
			onProgress?.({ value: 5 + Math.round((i + 1) / plan.times.length * 80) });
		}
		if (frames.length === 0) {
			throw new Error('未能抽取任何视频帧（检查 start_s / end_s 区间）。');
		}

		onProgress?.({ value: 88 });
		const gif = encodeGif(frames, plan.width, plan.height, plan.loopCount);
		return {
			gifBlob: new Blob([gif as unknown as BlobPart], { type: 'image/gif' }),
			width: plan.width,
			height: plan.height,
			frames: frames.length,
			delayCs: plan.delayCs,
		};
	} finally {
		// 释放解码器与 blob URL（不释放会持有整段视频内存）
		try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
		if (objectUrl) { URL.revokeObjectURL(objectUrl); }
	}
}

/** 浏览器本地执行「视频转 GIF」。 */
export async function runVideoToGifNode(input: VideoToGifInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, values, upstreams, store, onProgress } = input;
	const snapshotKey = input.snapshotKey ?? nodeId;
	const src = firstUpstreamVideo(store, upstreams);
	if (!src) {
		return { promptId: '', status: 'error', error: 'GIF 转换需要上游视频输入（请先连接并运行一个视频节点）。', entries: [] };
	}

	try {
		const fetchImpl = input.fetchImpl ?? globalThis.fetch;
		const converted = await convertVideoToGif(src, values, fetchImpl, onProgress);
		const outBlob = converted.gifBlob;

		// ── 上传（失败退 data:，同 instantExecutor 的容错理由）──────────────
		let ref = '';
		try {
			const form = new FormData();
			// 文件名必须唯一，否则 ComfyUI 覆盖同名文件返回同一 name → 浏览器
			// 命中磁盘缓存显示旧 gif（见 instantExecutor 同处注释）。
			form.append('image', outBlob, `video2gif-${Date.now()}-${Math.floor(Math.random() * 1e6)}.gif`);
			const resp = await runner.fetchApi?.('/upload/image', { method: 'POST', body: form });
			const data = await resp?.json() as { name?: string; subfolder?: string; type?: string } | undefined;
			const name = String(data?.name ?? '');
			if (name) {
				const subfolder = String(data?.subfolder ?? '');
				const typeOut = String(data?.type ?? 'output');
				ref = `${runner.baseUrl}/view?filename=${encodeURIComponent(name)}${subfolder ? '&subfolder=' + encodeURIComponent(subfolder) : ''}&type=${typeOut}`;
			}
		} catch {
			// 忽略：走 data: 兜底
		}
		if (!ref) { ref = await blobToDataUrl(outBlob); }

		// kind:'image' —— GIF 是图片格式，卡片 OUTPUT 用 <img> 就能播放动图
		// （若标记 video，<video> 无法播放 gif → 显示黑框）。
		const entry = {
			nodeId: snapshotKey,
			port: 'output',
			key: `${snapshotKey}:output:0`,
			media: {
				kind: 'image' as const,
				ref,
				meta: {
					mime: 'image/gif',
					gifFrames: String(converted.frames),
					gifSize: `${converted.width}x${converted.height}`,
					gifDelayCs: String(converted.delayCs),
				},
			},
			index: 0,
		};
		store.put(entry);
		onProgress?.({ value: 100 });
		return { promptId: '', status: 'success', entries: [entry], durationMs: 0 };
	} catch (err) {
		return { promptId: '', status: 'error', error: String(err), entries: [] };
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// 透明 GIF（chroma-key 抠像）—— 「转动态表情包」（Saros.AnimatedEmoji）管线。
//
// 与普通 convertVideoToGif 的差异：
//   1. 每帧先 chroma-key（绿幕 → alpha=0），再走 1-bit 透明 GIF 编码；
//   2. 压缩迭代：编码后超过 max_bytes 时按 色数→帧率→尺寸 逐级降级重编码
//      （RGBA 帧缓存复用，降级不重新 seek 解码视频）；
//   3. GIF 透明是 1-bit（GIF89a 无半透明），边缘羽化以「despill 去绿边」代替。
// ═══════════════════════════════════════════════════════════════════════════

/** 解析 #RRGGBB / #RGB 十六进制颜色。非法输入回退纯绿 #00FF00。 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
	if (!m) { return { r: 0, g: 255, b: 0 }; }
	const h = m[1];
	if (h.length === 3) {
		return {
			r: parseInt(h[0] + h[0], 16),
			g: parseInt(h[1] + h[1], 16),
			b: parseInt(h[2] + h[2], 16),
		};
	}
	return {
		r: parseInt(h.slice(0, 2), 16),
		g: parseInt(h.slice(2, 4), 16),
		b: parseInt(h.slice(4, 6), 16),
	};
}

/**
 * chroma-key 抠像（就位修改 rgba 的 alpha 通道）。GIF 只有 1-bit 透明，因此：
 *   - 色距 < similarity×442        → alpha=0（完全透明）
 *   - 色距 < (similarity+smoothness)×442 → 保持不透明 + **despill**（把 G 通道
 *     钳到 max(R,B)，消除主体边缘的绿色溢色/泛绿描边）
 *   - 其余                          → 原样保留
 *
 * ★ 2026-09-03 增强（「绿边残留」修复），三道后处理：
 *   1. **绿色优势清除**：视频压缩/绿幕不均会产生「暗化/灰化的绿」，其到纯绿的
 *      色距可能超出阈值而漏网——按**绿色主导度**（G − max(R,B)）补抠，阈值与
 *      smoothness 挂钩。
 *   2. **choke（mask 内缩）**：与透明区相邻的边缘像素若仍带绿色优势 → alpha=0
 *      （吃掉贴边 1px 绿 fringe；贴纸白描边不含绿色优势，不受影响）。
 *   3. **邻接溢色**：贴着透明区 ≤2px 的不透明像素统一 despill（G 钳到 max(R,B)）
 *      ——只处理边界带，贴纸内部的绿色元素（叶片/服饰）不受影响。
 * 纯同步函数（每帧 240×240=5.8 万像素，多趟遍历 <5ms）。
 */
export function chromaKeyFrame(
	rgba: Uint8Array,
	key: { r: number; g: number; b: number },
	similarity: number,
	smoothness: number,
): void {
	const MAXD = 441.67;   // RGB 立方体空间对角线长度
	const W = Math.max(1, Math.round(Math.sqrt(rgba.length / 4)));   // 由长度反推宽度（正方形帧）
	const H = Math.max(1, Math.round(rgba.length / 4 / W));
	const t1 = Math.max(0, Math.min(1, similarity)) * MAXD;
	const band = Math.max(0, Math.min(1, smoothness)) * MAXD;
	const t2 = t1 + band;
	const kr = key.r, kg = key.g, kb = key.b;
	// 绿色主导度阈值：与 smoothness 联动（平滑带越宽，扩展清除越保守）
	const greenDominate = Math.max(18, band * 0.35);
	for (let i = 0; i + 3 < rgba.length; i += 4) {
		const dr = rgba[i] - kr, dg = rgba[i + 1] - kg, db = rgba[i + 2] - kb;
		const d = Math.sqrt(dr * dr + dg * dg + db * db);
		const gExcess = rgba[i + 1] - Math.max(rgba[i], rgba[i + 2]);
		if (d < t1) {
			rgba[i + 3] = 0;                       // 完全透明
		} else if (d < t2) {
			// 边缘带：不透明但去绿溢色（G 钳到 R/B 最大值，视觉上从绿边变中性边）
			const cap = Math.max(rgba[i], rgba[i + 2]);
			if (rgba[i + 1] > cap) { rgba[i + 1] = cap; }
		} else if (gExcess > greenDominate && rgba[i + 1] > 60) {
			// 绿色优势清除：压缩伪影/绿幕不均产生的暗化绿（色距超阈值但 G 明显主导）
			rgba[i + 3] = 0;
		}
	}
	// ── choke（mask 内缩）：与透明区相邻且带绿色优势的边缘像素 → alpha=0。
	//    两趟迭代（各吃 1px）；从 alpha 快照判定邻接，避免本趟清除影响下一像素。
	const CHOKES = 2;
	for (let pass = 0; pass < CHOKES; pass++) {
		const snap = new Uint8Array(rgba);        // alpha 快照（含 RGB，代价可接受）
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				if (snap[i + 3] === 0) { continue; }
				let touchesTransparent = false;
				if (x > 0 && snap[i - 4 + 3] === 0) { touchesTransparent = true; }
				else if (x + 1 < W && snap[i + 4 + 3] === 0) { touchesTransparent = true; }
				else if (y > 0 && snap[i - W * 4 + 3] === 0) { touchesTransparent = true; }
				else if (y + 1 < H && snap[i + W * 4 + 3] === 0) { touchesTransparent = true; }
				if (!touchesTransparent) { continue; }
				const gExcess = snap[i + 1] - Math.max(snap[i], snap[i + 2]);
				if (gExcess > 6) { rgba[i + 3] = 0; }   // 只吃「带绿」的贴边像素，保住白描边
			}
		}
	}
	// ── 邻接溢色：贴着透明区 ≤2px 的不透明像素统一 despill（形状不变，去残余绿）。
	for (let pass = 0; pass < 2; pass++) {
		const snap = new Uint8Array(rgba);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				if (snap[i + 3] === 0) { continue; }
				let touchesTransparent = false;
				if (x > 0 && snap[i - 4 + 3] === 0) { touchesTransparent = true; }
				else if (x + 1 < W && snap[i + 4 + 3] === 0) { touchesTransparent = true; }
				else if (y > 0 && snap[i - W * 4 + 3] === 0) { touchesTransparent = true; }
				else if (y + 1 < H && snap[i + W * 4 + 3] === 0) { touchesTransparent = true; }
				if (!touchesTransparent) { continue; }
				const cap = Math.max(snap[i], snap[i + 2]);
				if (rgba[i + 1] > cap) { rgba[i + 1] = cap; }
			}
		}
	}
}

/**
 * 压缩降级档位：colors 色数、fps 抽稀（0=沿用计划帧率）、width 缩放（0=沿用）。
 * ★ 微信规范 240×240 是**硬尺寸**——末两档保持 240（width 0）只降色数/帧率；
 *   100KB 上限较紧，240² 动图靠「色数→帧率」双降逼近（仍超限则 overLimit 提示，
 *   不缩尺寸——缩尺寸产出不合规）。
 */
const TRANSPARENT_GIF_LEVELS: Array<{ colors: number; fps: number; width: number }> = [
	{ colors: 128, fps: 0, width: 0 },
	{ colors: 96, fps: 0, width: 0 },
	{ colors: 64, fps: 10, width: 0 },
	{ colors: 48, fps: 8, width: 192 },
	{ colors: 32, fps: 8, width: 160 },
	{ colors: 24, fps: 6, width: 0 },
];

export interface ConvertedTransparentGif extends ConvertedGif {
	/** 最终 GIF 字节数（微信表情规范 ≤500KB）。 */
	bytes: number;
	/** 实际采用的降级档位（0=最高画质档即达标）。 */
	level: number;
}

/** 从整帧 RGBA 中裁出子区域（就位复制）。纯函数。 */
function cropRgba(src: Uint8Array, srcW: number, srcH: number, x: number, y: number, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let row = 0; row < h; row++) {
		const sy = y + row;
		if (sy < 0 || sy >= srcH) { continue; }
		const sx0 = Math.max(0, x);
		const sx1 = Math.min(srcW, x + w);
		if (sx1 <= sx0) { continue; }
		out.set(
			src.subarray((sy * srcW + sx0) * 4, (sy * srcW + sx1) * 4),
			(row * w + (sx0 - x)) * 4,
		);
	}
	return out;
}

/**
 * 单格帧序列 → 透明 GIF（指定档位）。convertVideoToTransparentGif 的编码核心
 * 抽出，供单图版与网格切分版共用：k 抽稀 → 每帧 medianCut(跳透明像素) +
 * 透明索引映射 → encodeGif。纯同步。
 */
function encodeCellLevel(
	rgbaFrames: Uint8Array[],
	srcFps: number,
	lv: { colors: number; fps: number },
	loopCount: number,
	width: number,
	height: number,
): { blob: Blob; frames: number; delayCs: number } {
	const fps = lv.fps > 0 ? lv.fps : srcFps;
	const k = Math.max(1, Math.round(srcFps / fps));
	const delayCs = Math.max(2, Math.round(100 / fps));
	const frames: GifFrameInput[] = [];
	for (let i = 0; i < rgbaFrames.length; i += k) {
		const rgba = rgbaFrames[i];
		// 透明像素不参与装箱（跳过绿色入板挤占主体色阶）
		const palette = medianCutPalette(rgba, lv.colors, 4, true);
		const transparentIndex = palette.length / 3;    // = 实际色数 n
		// 调色板显式扩 1 位给透明索引（padPalette 补齐 2 的幂时保证覆盖）
		const padded = new Uint8Array((transparentIndex + 1) * 3);
		padded.set(palette);
		frames.push({
			indices: mapToPaletteIndicesWithAlpha(rgba, palette, transparentIndex),
			palette: padded,
			delayCs,
			transparentIndex,
		});
	}
	const gif = encodeGif(frames, width, height, loopCount);
	return {
		blob: new Blob([gif as unknown as BlobPart], { type: 'image/gif' }),
		frames: frames.length,
		delayCs,
	};
}

export interface ConvertedGridGifs {
	/** 每格一个透明 GIF，行主序（r*cols+c，与输入拼贴图格序一致）。 */
	gifs: ConvertedTransparentGif[];
	/** ★ 每格微信**缩略图**（PNG 240×240，取首帧，与 gifs 同序；≤60KB 目标，超限由 meta 标记）。 */
	thumbs: string[];
	rows: number;
	cols: number;
	/** 单格输出尺寸（≤240，微信规范）。 */
	cellW: number;
	cellH: number;
	/** 统一采用的降级档位（全部格共用，保证观感一致）。 */
	level: number;
}

/**
 * 视频 → m×n 网格透明 GIF 组（「转动态表情包」整图动图切分模式）。
 *
 * 与 convertVideoToTransparentGif（单图）的差异：抽帧+抠像后按 rows×cols 把
 * **每帧**切成 cells 个子帧（grid_margin 内缩吸收邻格渗入/全局抖动），再缩放
 * 到 ≤240，**全部格共用同一压缩档位**（最差格达标才通过——单独逐格降级会让
 * 同一批表情帧率/色数不一致，且最坏 5档×格数 次编码）。
 * 输入参考图为 m×n 拼贴贴纸图，prompt 已约束「每格独立运动」。
 */
export async function convertVideoToGridTransparentGifs(
	videoRef: string,
	values: Record<string, unknown>,
	chroma: { color: string; similarity: number; smoothness: number },
	grid: { rows: number; cols: number; margin: number },
	fetchImpl: typeof fetch,
	onProgress?: (p: ComfyRunProgress) => void,
	maxBytes = 500 * 1024,
): Promise<ConvertedGridGifs> {
	const rows = Math.max(1, Math.min(6, Math.round(grid.rows)));
	const cols = Math.max(1, Math.min(6, Math.round(grid.cols)));
	if (rows === 1 && cols === 1) {
		// 1×1 退化：直接走单图管线（语义等价，省一次切格/缩放开销）。
		// thumbs=[]（单图管线不产缩略图——微信上传场景固定走网格管线）。
		const single = await convertVideoToTransparentGif(videoRef, values, chroma, fetchImpl, onProgress, maxBytes);
		return { gifs: [single], thumbs: [], rows: 1, cols: 1, cellW: single.width, cellH: single.height, level: single.level };
	}
	let objectUrl = '';
	const video = document.createElement('video');
	try {
		onProgress?.({ promptId: '', value: 3 });
		const blob = /^data:/i.test(videoRef) ? dataUrlToBlob(videoRef) : await (await fetchImpl(videoRef)).blob();
		objectUrl = URL.createObjectURL(blob);

		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.src = objectUrl;
		await waitMetadata(video);

		const srcW = video.videoWidth || 0;
		const srcH = video.videoHeight || 0;
		if (srcW <= 0 || srcH <= 0) {
			throw new Error('无法读取视频尺寸（解码失败）。');
		}
		const plan = planGifFrames(values, video.duration, srcW, srcH);

		const canvas = document.createElement('canvas');
		canvas.width = plan.width;
		canvas.height = plan.height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) { throw new Error('浏览器无法创建画布。'); }

		// ── 逐帧抽取 + 抠像（整帧，格切分在抠像之后——一次 chroma-key 全帧复用）──
		const key = parseHexColor(chroma.color);
		const rgbaFrames: Uint8Array[] = [];
		for (let i = 0; i < plan.times.length; i++) {
			await seekTo(video, plan.times[i]);
			ctx.drawImage(video, 0, 0, plan.width, plan.height);
			const data = ctx.getImageData(0, 0, plan.width, plan.height).data;
			const rgba = new Uint8Array(data.buffer.slice(0));
			chromaKeyFrame(rgba, key, chroma.similarity, chroma.smoothness);
			rgbaFrames.push(rgba);
			onProgress?.({ promptId: '', value: 3 + Math.round((i + 1) / plan.times.length * 45) });
		}
		if (rgbaFrames.length === 0) {
			throw new Error('未能抽取任何视频帧（检查 start_s / end_s 区间）。');
		}

		// ── 切格 + 缩放（margin 内缩吸收邻格渗入；目标 ≤240 微信规范）────────
		const cellSrcW = Math.floor(plan.width / cols);
		const cellSrcH = Math.floor(plan.height / rows);
		const insetX = Math.floor(cellSrcW * Math.max(0, Math.min(0.2, grid.margin)));
		const insetY = Math.floor(cellSrcH * Math.max(0, Math.min(0.2, grid.margin)));
		const cropW = cellSrcW - insetX * 2;
		const cropH = cellSrcH - insetY * 2;
		if (cropW < 16 || cropH < 16) {
			throw new Error(`切格后尺寸过小（${cropW}×${cropH}）：检查网格参数与边距。`);
		}
		const cellW = Math.min(240, cropW);
		const cellH = Math.min(240, cropH);
		const scaleCanvas = document.createElement('canvas');
		scaleCanvas.width = cellW;
		scaleCanvas.height = cellH;
		const sctx = scaleCanvas.getContext('2d', { willReadFrequently: true });
		if (!sctx) { throw new Error('浏览器无法创建画布。'); }
		// cells[r][c] = 该格全部帧的 RGBA（行主序扁平化：cellFrames[r*cols+c]）
		const cellFrames: Uint8Array[][] = Array.from({ length: rows * cols }, () => []);
		const big = document.createElement('canvas');
		big.width = cropW;
		big.height = cropH;
		const bctx = big.getContext('2d', { willReadFrequently: true });
		if (!bctx) { throw new Error('浏览器无法创建画布。'); }
		const imgData = bctx.createImageData(cropW, cropH);
		for (let fi = 0; fi < rgbaFrames.length; fi++) {
			for (let r = 0; r < rows; r++) {
				for (let c = 0; c < cols; c++) {
					const cropped = cropRgba(rgbaFrames[fi], plan.width, plan.height, c * cellSrcW + insetX, r * cellSrcH + insetY, cropW, cropH);
					let out = cropped;
					if (cropW > cellW || cropH > cellH) {
						new Uint8Array(imgData.data.buffer).set(cropped);
						bctx.putImageData(imgData, 0, 0);
						sctx.clearRect(0, 0, cellW, cellH);
						sctx.drawImage(big, 0, 0, cellW, cellH);
						const d2 = sctx.getImageData(0, 0, cellW, cellH).data;
						out = new Uint8Array(d2.buffer.slice(0));
					}
					cellFrames[r * cols + c].push(out);
				}
			}
			onProgress?.({ promptId: '', value: 48 + Math.round((fi + 1) / rgbaFrames.length * 12) });
		}

		// ── 微信缩略图（2026-09-03）：每格**首帧** → 240×240 PNG（≤60KB 目标）。
		//    用首帧原始切片（不受 GIF 压缩降级的尺寸/帧率影响）；源格 cellW×cellH
		//    可能为 80×80 等（整帧受限时）→ 先 putImageData 到等尺寸临时画布，再
		//    **等比放大**到规范 240×240。扁平贴纸画风 PNG 通常 <60KB；超限时由调用
		//    方在 meta.thumbOver 标记（格式固定 PNG，无进一步有损手段）。
		const thumbCanvas = document.createElement('canvas');
		thumbCanvas.width = 240;
		thumbCanvas.height = 240;
		const tctx = thumbCanvas.getContext('2d');
		const tmpC = document.createElement('canvas');
		tmpC.width = cellW;
		tmpC.height = cellH;
		const tmpCtx = tmpC.getContext('2d');
		const midData = tmpCtx ? tmpCtx.createImageData(cellW, cellH) : null;
		const thumbs: string[] = [];
		for (let ci = 0; ci < cellFrames.length; ci++) {
			const first = cellFrames[ci][0];
			if (!tctx || !tmpCtx || !midData || !first) { thumbs.push(''); continue; }
			new Uint8Array(midData.data.buffer).set(first);
			tmpCtx.clearRect(0, 0, cellW, cellH);
			tmpCtx.putImageData(midData, 0, 0);
			tctx.clearRect(0, 0, 240, 240);
			tctx.drawImage(tmpC, 0, 0, 240, 240);
			thumbs.push(thumbCanvas.toDataURL('image/png'));
		}

		// ── 统一档位迭代：全部格 ≤maxBytes 才通过（观感一致 + 省时）────────────
		let lastLevel = -1;
		let lastResults: ConvertedTransparentGif[] = [];
		for (let li = 0; li < TRANSPARENT_GIF_LEVELS.length; li++) {
			const lv = TRANSPARENT_GIF_LEVELS[li];
			const srcFps = Math.max(1, Math.round(100 / plan.delayCs));
			const results: ConvertedTransparentGif[] = [];
			let allOk = true;
			for (let ci = 0; ci < cellFrames.length; ci++) {
				const enc = encodeCellLevel(cellFrames[ci], srcFps, lv, plan.loopCount, cellW, cellH);
				results.push({
					gifBlob: enc.blob,
					width: cellW,
					height: cellH,
					frames: enc.frames,
					delayCs: enc.delayCs,
					bytes: enc.blob.size,
					level: li,
				});
				if (enc.blob.size > maxBytes) { allOk = false; }
			}
			lastLevel = li;
			lastResults = results;
			const worst = Math.max(...results.map(r2 => r2.bytes));
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] grid ${rows}x${cols} level=${li} colors=${lv.colors} fps=${lv.fps || srcFps} ${cellW}x${cellH} worstBytes=${worst}`);
			onProgress?.({ promptId: '', value: 60 + Math.round((li + 1) / TRANSPARENT_GIF_LEVELS.length * 35) });
			if (allOk) {
				return { gifs: results, thumbs, rows, cols, cellW, cellH, level: li };
			}
		}
		return { gifs: lastResults, thumbs, rows, cols, cellW, cellH, level: lastLevel };
	} finally {
		try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
		if (objectUrl) { URL.revokeObjectURL(objectUrl); }
	}
}

/**
 * 视频 → 透明背景 GIF（chroma-key + 压缩迭代）。浏览器环境。
 *
 * 流程：fetch blob（防跨源画布污染，同 convertVideoToGif）→ 逐帧 seek 抽帧 +
 * chroma-key（RGBA 帧缓存）→ 按档位循环「量化(跳过透明像素) → 映射(透明索引) →
 * 编码」，首个 ≤maxBytes 的结果即返回；保底档仍超限则返回最后结果（调用方
 * 拿 bytes 自行提示）。fps 降级 = 从缓存帧等距抽稀，不重新 seek。
 */
export async function convertVideoToTransparentGif(
	videoRef: string,
	values: Record<string, unknown>,
	chroma: { color: string; similarity: number; smoothness: number },
	fetchImpl: typeof fetch,
	onProgress?: (p: ComfyRunProgress) => void,
	maxBytes = 500 * 1024,
): Promise<ConvertedTransparentGif> {
	let objectUrl = '';
	const video = document.createElement('video');
	try {
		onProgress?.({ promptId: '', value: 3 });
		const blob = /^data:/i.test(videoRef) ? dataUrlToBlob(videoRef) : await (await fetchImpl(videoRef)).blob();
		objectUrl = URL.createObjectURL(blob);

		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.src = objectUrl;
		await waitMetadata(video);

		const srcW = video.videoWidth || 0;
		const srcH = video.videoHeight || 0;
		if (srcW <= 0 || srcH <= 0) {
			throw new Error('无法读取视频尺寸（解码失败）。');
		}
		const plan = planGifFrames(values, video.duration, srcW, srcH);

		const canvas = document.createElement('canvas');
		canvas.width = plan.width;
		canvas.height = plan.height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) { throw new Error('浏览器无法创建画布。'); }

		// ── 逐帧抽取 + 抠像（缓存 RGBA，供多档重编码复用）────────────────────
		const key = parseHexColor(chroma.color);
		const rgbaFrames: Uint8Array[] = [];
		for (let i = 0; i < plan.times.length; i++) {
			await seekTo(video, plan.times[i]);
			ctx.drawImage(video, 0, 0, plan.width, plan.height);
			const data = ctx.getImageData(0, 0, plan.width, plan.height).data;
			// slice(0) 复制出独立 buffer（后续 chromaKeyFrame 就位改写，不污染 ImageData 池）
			const rgba = new Uint8Array(data.buffer.slice(0));
			chromaKeyFrame(rgba, key, chroma.similarity, chroma.smoothness);
			rgbaFrames.push(rgba);
			// 抽帧+抠像占 3-60%，压缩迭代占 60-95%
			onProgress?.({ promptId: '', value: 3 + Math.round((i + 1) / plan.times.length * 57) });
		}
		if (rgbaFrames.length === 0) {
			throw new Error('未能抽取任何视频帧（检查 start_s / end_s 区间）。');
		}

		// ── 压缩迭代：色数 → 帧率 → 尺寸 逐级降级，首个达标即停 ───────────────
		let last: ConvertedTransparentGif | undefined;
		for (let li = 0; li < TRANSPARENT_GIF_LEVELS.length; li++) {
			const lv = TRANSPARENT_GIF_LEVELS[li];
			const fps = lv.fps > 0 ? lv.fps : Math.max(1, Math.round(100 / plan.delayCs));
			const k = Math.max(1, Math.round((100 / plan.delayCs) / fps));
			const delayCs = Math.max(2, Math.round(100 / fps));

			// 尺寸降级：离屏 canvas 把缓存帧等比缩小（比重新 seek 解码便宜一个量级）
			let w = plan.width;
			let h = plan.height;
			let frameSource = rgbaFrames;
			if (lv.width > 0 && lv.width < plan.width) {
				const scale = lv.width / plan.width;
				w = Math.max(1, Math.round(plan.width * scale));
				h = Math.max(1, Math.round(plan.height * scale));
				const small = document.createElement('canvas');
				small.width = w;
				small.height = h;
				const sctx = small.getContext('2d', { willReadFrequently: true });
				const big = document.createElement('canvas');
				big.width = plan.width;
				big.height = plan.height;
				const bctx = big.getContext('2d', { willReadFrequently: true });
				if (!sctx || !bctx) { throw new Error('浏览器无法创建画布。'); }
				const shrunk: Uint8Array[] = [];
				const imgData = bctx.createImageData(plan.width, plan.height);
				for (const rgba of rgbaFrames) {
					new Uint8Array(imgData.data.buffer).set(rgba);
					bctx.putImageData(imgData, 0, 0);
					sctx.drawImage(big, 0, 0, w, h);
					const d2 = sctx.getImageData(0, 0, w, h).data;
					// canvas 重采样会把已透明像素的 RGB 写回 0（premultiply），
					// alpha 通道保留 —— 抠像判定发生在缩放前，这里只需保 alpha。
					shrunk.push(new Uint8Array(d2.buffer.slice(0)));
				}
				frameSource = shrunk;
			}

			const frames: GifFrameInput[] = [];
			for (let i = 0; i < frameSource.length; i += k) {
				const rgba = frameSource[i];
				// 透明像素不参与装箱（跳过绿色入板挤占主体色阶）
				const palette = medianCutPalette(rgba, lv.colors, 4, true);
				const transparentIndex = palette.length / 3;    // = 实际色数 n
				// 调色板显式扩 1 位给透明索引（padPalette 补齐 2 的幂时保证覆盖）
				const padded = new Uint8Array((transparentIndex + 1) * 3);
				padded.set(palette);
				frames.push({
					indices: mapToPaletteIndicesWithAlpha(rgba, palette, transparentIndex),
					palette: padded,
					delayCs,
					transparentIndex,
				});
			}
			onProgress?.({ promptId: '', value: 60 + Math.round((li + 1) / TRANSPARENT_GIF_LEVELS.length * 35) });
			const gif = encodeGif(frames, w, h, plan.loopCount);
			const out = new Blob([gif as unknown as BlobPart], { type: 'image/gif' });
			last = {
				gifBlob: out,
				width: w,
				height: h,
				frames: frames.length,
				delayCs,
				bytes: out.size,
				level: li,
			};
			// eslint-disable-next-line no-console
			console.warn(`[AnimatedEmoji] gif level=${li} colors=${lv.colors} fps=${fps} ${w}x${h} frames=${frames.length} bytes=${out.size}`);
			if (out.size <= maxBytes) { return last; }
		}
		return last as ConvertedTransparentGif;
	} finally {
		try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
		if (objectUrl) { URL.revokeObjectURL(objectUrl); }
	}
}
