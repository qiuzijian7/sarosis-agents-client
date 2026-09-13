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
 * 取图片 ref 的**首帧**缩放成 PNG 缩略图（返回 data URL；失败 → `''`）。
 *
 * 用途（2026-09-13 用户需求「重启后也要看全 9 张」）：把缩略图写进媒体条目的
 * `meta.thumb`，聊天卡的**落盘副本**（host 侧 `trimSnapshotForPersist`）用它替代
 * 数百 KB 的 GIF data URL —— 9 格 × ~60KB ≈ 540KB 可**全量落盘** ✓；用 GIF 原图则
 * 9 × ~488KB ≈ 4.4MB，会被落盘预算裁到 6 格 ✗（用户实测「9 格生成成功却只显示
 * 6 张 GIF」的同源问题）。
 *
 * ⚠ 落盘副本显示的是**静态首帧**而非动图 —— 刻意的体积取舍 ✓；**活卡**仍用 GIF 原图
 *   （动图）✓，两者互不影响。
 *
 * 实现：`<img>` 解码 → `drawImage` 到画布（动图只画第 0 帧）→ `toDataURL('image/png')`。
 * 不放大（源比目标小就按原尺寸）；跨域图片会 taint 画布 → `toDataURL` 抛异常 →
 * 返回 `''`（调用方跳过缩略图，不影响主链路 ✓）。
 */
export async function firstFrameThumbDataUrl(ref: string, size = 240): Promise<string> {
	if (!ref) { return ''; }
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error('image decode failed'));
			el.src = ref;
		});
		const w = img.naturalWidth || size;
		const h = img.naturalHeight || size;
		const scale = Math.min(size / w, size / h, 1);
		const cv = document.createElement('canvas');
		cv.width = Math.max(1, Math.round(w * scale));
		cv.height = Math.max(1, Math.round(h * scale));
		const ctx = cv.getContext('2d');
		if (!ctx) { return ''; }
		ctx.drawImage(img, 0, 0, cv.width, cv.height);
		return cv.toDataURL('image/png');
	} catch {
		return '';
	}
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
//   4. 首帧一致性（2026-09-07 需求）：可选 firstFrameOverride —— 用参考图（已绿底
//      合成）按帧尺寸重采样+抠像后整体替换第 0 帧，保证动图第 0 帧与输入静态
//      贴纸完全一致（视频模型首帧相对参考图常有漂移）。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 绿幕 key 色自动采样（2026-09-08）：从帧**四边**各取 32 个点，以「绿色超出量
 * （G − max(R,B)）的中位」为中心聚类取均值 —— 抗个别噪点/主体贴边干扰。
 * 前提：四边基本全是幕布色。chroma_color='auto' 时由 convertVideoToTransparentGif
 * 从首帧采样（视频压缩会让幕布绿漂移，采样值比固定 #00FF00 更贴合实际帧）。
 * 纯同步。
 */
export function autoSampleChromaKeyRgba(
	rgba: Uint8Array, w: number, h: number,
): { r: number; g: number; b: number } {
	const pts: Array<[number, number]> = [];
	for (let t = 0.05; t <= 0.96; t += 1 / 32) {
		pts.push([Math.floor(t * w), 2], [Math.floor(t * w), h - 3], [2, Math.floor(t * h)], [w - 3, Math.floor(t * h)]);
	}
	const cand = pts.map(([x, y]) => {
		const i = (y * w + x) * 4;
		return [rgba[i], rgba[i + 1], rgba[i + 2]];
	});
	const exc = cand.map(c => c[1] - Math.max(c[0], c[2]));
	const med = exc.slice().sort((a, b) => a - b)[Math.floor(exc.length / 2)];
	const near = cand.filter((c, i) => Math.abs(exc[i] - med) < 12);
	const pick = (ch: number) => Math.round(near.reduce((s, c) => s + c[ch], 0) / Math.max(1, near.length));
	return { r: pick(0), g: pick(1), b: pick(2) };
}

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
 * chroma-key 抠像算法库（2026-09-08 策略化重构）：
 *   - chromaKeyFrame：策略分发入口（主抠三选一 + 共享后处理），签名向后兼容
 *     （algo 缺省 'rgb' = 既有行为）。
 *   - 主抠算法对比（视觉对比工具：visual/keying-lab.html，拖入绿幕视频逐帧并排）：
 *     · rgb   色距全帧判定（最快；绿幕不均 → 阈值边界抖动 → 毛刺）
 *     · flood 泛洪连通（主体内部绿色元素零误伤；要求贴纸不贴帧边）
 *     · ycbcr Cb/Cr 色度距离（亮度解耦，打光不均最稳）
 *   - chromaPostProcess 共享后处理五道（RGB 阈值语义 / GIF 1-bit alpha）：
 *   - 色距 < similarity×442 → alpha=0；<(similarity+smoothness)×442 → 过渡带
 *     despill（G 钳到 max(R,B)）；其余原样。
 *   1. 绿色优势清除：暗化/灰化的绿（色距超阈但 G 主导）补抠；
 *   2. choke（mask 内缩）：贴边 1px 带 Green fringe 像素清除；
 *   3. 邻接溢色：贴透明区 ≤2px 统一 despill；
 *   4. 形态学开运算（09-08「边缘不规整」）：erosion+dilation 各 1px 去毛刺；
 *   5. 孤立碎块清除：4-连通域 <4px 噪声块清除。
 * 纯同步（240² <10ms；720P 帧源约 30-50ms）。
 */
/** 抠像算法标识（values.chroma_algo；2026-09-08 对比调研落地）。 */
export type ChromaKeyAlgo = 'rgb' | 'flood' | 'ycbcr';

/** 抠像算法注册表：编辑器下拉数据源 + visual/keying-lab 对比工具共用。 */
export const CHROMA_KEY_ALGOS: Array<{ id: ChromaKeyAlgo; label: string; tip: string }> = [
	{
		id: 'rgb', label: 'RGB 色距（默认）',
		tip: '全帧逐像素与绿幕色距判定，最快。绿幕打光不均时阈值边界抖动 → 边缘毛刺；主体含绿色元素（服饰/眼睛）可能被误抠。',
	},
	{
		id: 'flood', label: '泛洪连通',
		tip: '从帧边缘泛洪，只抠「与背景连通」的绿幕区域——主体内部绿色元素零误伤（不需要背景完美均匀，只需边缘可达）。代价：帧边缘必须全是背景（贴纸不贴边）。',
	},
	{
		id: 'ycbcr', label: 'YCbCr 色度',
		tip: 'Cb/Cr 色度平面距离判定（广播级 keyer 经典做法）——色度与亮度解耦，对绿幕亮度不均（阴影/光斑/暗角）明显更稳；边缘同样走后处理规整。',
	},
];

/** 像素到 key 的 RGB 欧氏距离（主抠/泛洪共用）。 */
function keyDistance(r: number, g: number, b: number, kr: number, kg: number, kb: number): number {
	const dr = r - kr, dg = g - kg, db = b - kb;
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** 解析 values.chroma_algo（非法值回退 'rgb'，向后兼容旧工作流）。 */
export function parseChromaAlgo(raw: unknown): ChromaKeyAlgo {
	return raw === 'flood' || raw === 'ycbcr' ? raw : 'rgb';
}

/**
 * 主抠 A：RGB 色距全帧判定（既有算法，缺省）。
 *
 * ★ 2026-09-08 边缘锐化重设计：d<t2（含过渡带）**直接透明**——旧行为「过渡带
 *   保留+despill」会把白绿混合像素以不透明灰白留在 alpha 里（GIF 1-bit 无
 *   半透明），视觉即描边外缘 2-3px「灰白绒毛」——despill 去绿后绒毛反而更明显。
 *   现在过渡带清除 → 描边外缘锐利（代价：真实描边被啃 1-2px，可接受）。
 *   smoothness 语义变为「外扩清除带宽」。
 */
function keyPrimaryRgb(
	rgba: Uint8Array, W: number, H: number,
	key: { r: number; g: number; b: number }, t1: number, t2: number, greenDominate: number,
): void {
	const kr = key.r, kg = key.g, kb = key.b;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const d = keyDistance(rgba[i], rgba[i + 1], rgba[i + 2], kr, kg, kb);
			if (d < t2) {
				rgba[i + 3] = 0;                       // 透明（含过渡带，边缘锐化）
			} else {
				const gExcess = rgba[i + 1] - Math.max(rgba[i], rgba[i + 2]);
				if (gExcess > greenDominate && rgba[i + 1] > 60) {
					// 绿色优势清除：压缩伪影/绿幕不均产生的暗化绿（色距超阈值但 G 明显主导）
					rgba[i + 3] = 0;
				}
			}
		}
	}
}

/**
 * 主抠 B：YCbCr 色度平面距离（2026-09-08 新增）。
 * BT.601 Cb/Cr 与亮度解耦——绿幕打光不均（阴影/亮度梯度）只改变 Y，不影响
 * Cb/Cr → 阈值边界不再随亮度抖动，边缘稳定性显著优于 RGB 欧氏。
 * 阈值域：|Cb|,|Cr| ≤ ~142 → 对角线 ≈ 200.8（与 RGB 442 同语义换算）。
 */
function keyPrimaryYcbcr(
	rgba: Uint8Array, W: number, H: number,
	key: { r: number; g: number; b: number }, t1: number, t2: number, greenDominate: number,
): void {
	const MAXD_CB = 200.8;
	const scale = MAXD_CB / 441.67;             // 与 RGB 语义对齐：similarity/smoothness 同值同比例
	const ct1 = t1 * scale, ct2 = t2 * scale;
	// key 的色度坐标（只算一次）
	const kY = 0.299 * key.r + 0.587 * key.g + 0.114 * key.b;
	const kCb = 0.564 * (key.b - kY);
	const kCr = 0.713 * (key.r - kY);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
			const yy = 0.299 * r + 0.587 * g + 0.114 * b;
			const dcb = 0.564 * (b - yy) - kCb;
			const dcr = 0.713 * (r - yy) - kCr;
			const d = Math.sqrt(dcb * dcb + dcr * dcr);
			if (d < ct2) {
				rgba[i + 3] = 0;                       // 透明（含过渡带，边缘锐化）
			} else {
				const gExcess = g - Math.max(r, b);
				if (gExcess > greenDominate && g > 60) {
					rgba[i + 3] = 0;
				}
			}
		}
	}
}

/**
 * 主抠 C：泛洪连通 keying（2026-09-08 新增）。
 * 从帧边缘（四角 + 四边中点）BFS 泛洪，只把「与背景连通」的绿幕区抠掉——
 * 主体内部的绿色元素（服饰/眼睛/叶片）与背景不连通 → 零误伤。
 * 扩展判定用 t2（过渡带也纳入连通域），d<t1 纯透明、t1..t2 despill 保留——
 * 阈值语义与 RGB 版一致；后处理 choke/despill/open/碎块照常生效。
 * 前提：帧边缘必须全是背景（贴纸不贴边）——表情包管线满足（绿幕合成时留边）。
 */
function keyPrimaryFlood(
	rgba: Uint8Array, W: number, H: number,
	key: { r: number; g: number; b: number }, t1: number, t2: number,
): void {
	const kr = key.r, kg = key.g, kb = key.b;
	const visited = new Uint8Array(W * H);
	const stack: number[] = [];
	const trySeed = (sx: number, sy: number): void => {
		const p = sy * W + sx;
		if (visited[p]) { return; }
		const i = p * 4;
		if (rgba[i + 3] !== 0 && keyDistance(rgba[i], rgba[i + 1], rgba[i + 2], kr, kg, kb) < t2) {
			visited[p] = 1;
			stack.push(p);
		}
	};
	trySeed(0, 0); trySeed(W - 1, 0); trySeed(0, H - 1); trySeed(W - 1, H - 1);
	trySeed(W >> 1, 0); trySeed(W >> 1, H - 1); trySeed(0, H >> 1); trySeed(W - 1, H >> 1);
	while (stack.length) {
		const cur = stack.pop() as number;
		const i = cur * 4;
		// 出队即透明（含 t1..t2 过渡带——与 rgb/ycbcr 同步的边缘锐化语义：
		// 混合像素若 despill 保留会形成灰白绒毛边）。
		rgba[i + 3] = 0;
		const cy = (cur / W) | 0;
		const cx = cur - cy * W;
		// 4-邻扩展：色距 < t2 的邻居纳入连通域（贴纸边缘混合像素 d>t2 → 留给 choke）
		if (cx > 0) { const j = cur - 1; if (!visited[j]) { const q = j * 4; if (keyDistance(rgba[q], rgba[q + 1], rgba[q + 2], kr, kg, kb) < t2) { visited[j] = 1; stack.push(j); } } }
		if (cx + 1 < W) { const j = cur + 1; if (!visited[j]) { const q = j * 4; if (keyDistance(rgba[q], rgba[q + 1], rgba[q + 2], kr, kg, kb) < t2) { visited[j] = 1; stack.push(j); } } }
		if (cy > 0) { const j = cur - W; if (!visited[j]) { const q = j * 4; if (keyDistance(rgba[q], rgba[q + 1], rgba[q + 2], kr, kg, kb) < t2) { visited[j] = 1; stack.push(j); } } }
		if (cy + 1 < H) { const j = cur + W; if (!visited[j]) { const q = j * 4; if (keyDistance(rgba[q], rgba[q + 1], rgba[q + 2], kr, kg, kb) < t2) { visited[j] = 1; stack.push(j); } } }
	}
}

/**
 * 2× 超采样降采样（2026-09-08「细线装饰锯齿」）：src 为 2W×2H 的抠像后帧，
 * 按 2×2 子像素覆盖率聚合回 W×H。
 * - alpha：≥2/4 子像素不透明 → 255（1-bit 二值，边缘位置精度翻倍）
 * - RGB：取**不透明子像素**的平均色（透明子像素是 despill 后的绿幕混合，
 *   混入会污染边缘色；全透明格保留任一子像素色——编码时被跳过无影响）。
 * 纯同步。奇数尺寸向下取整（W/H 恒为偶数——2×plan.width）。
 */
function downsampleChroma2x(src: Uint8Array, W2: number, H2: number): Uint8Array {
	const W = W2 >> 1;
	const H = H2 >> 1;
	const out = new Uint8Array(W * H * 4);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let cnt = 0, r = 0, g = 0, b = 0, n = 0;
			for (let dy = 0; dy < 2; dy++) {
				const sy = y * 2 + dy;
				for (let dx = 0; dx < 2; dx++) {
					const s = ((sy * W2) + (x * 2 + dx)) * 4;
					if (src[s + 3] !== 0) {
						cnt++;
						r += src[s]; g += src[s + 1]; b += src[s + 2]; n++;
					}
				}
			}
			const o = (y * W + x) * 4;
			out[o + 3] = cnt >= 2 ? 255 : 0;
			const s0 = ((y * 2) * W2 + (x * 2)) * 4;
			if (n > 0) {
				out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
			} else {
				out[o] = src[s0]; out[o + 1] = src[s0 + 1]; out[o + 2] = src[s0 + 2];
			}
		}
	}
	return out;
}

/**
 * chroma-key 抠像（就位修改 rgba 的 alpha 通道）——策略分发版。
 *
 * 主抠（三选一，values.chroma_algo / 参数 algo）+ 共享后处理（choke 内缩、
 * 邻接 despill、形态学开运算、孤立碎块清除）。算法注册表见 CHROMA_KEY_ALGOS。
 * GIF 只有 1-bit 透明：alpha 严格二值，边缘质量靠 despill + 形态学保障。
 */
export function chromaKeyFrame(
	rgba: Uint8Array,
	key: { r: number; g: number; b: number },
	similarity: number,
	smoothness: number,
	algo: ChromaKeyAlgo = 'rgb',
	/** ★ 可选调参（2026-09-08，向后兼容）：greenDominance 覆盖「绿色优势扩展清除」
	 *  阈值。默认 max(18, band*0.35) 对**视频真人/深色主体**合适，但对**白色主体
	 *  贴纸**（表情包 die-cut 白描边+白发）过狠：白像素沾轻度绿幕溢色
	 *  （如 RGB(200,255,180)，gExcess=55>18）就会被清除 —— 主抠保留了它、扩展
	 *  清除又吃掉，表现即「贴纸内部被错误删除」。表情包入口应传 90
	 *  （gExcess>90 才算真绿溢：绿白混合 127 仍清 ✓、轻溢白 45 保留 ✓）。
	 * ★ boxFilterDistance / softAlpha（2026-09-08 OBS 对标调研落地，**仅 rgb 算法**，
	 *   默认关——VideoToGif 的 GIF 1-bit 链路行为不变）：
	 *   - boxFilterDistance：色度距离场先做 **3×3 盒式预滤波**再判定（OBS shader
	 *     同款）——在 alpha 判定**之前**平滑距离场，噪声/压缩瑕疵的单像素距离跳动
	 *     被抹平，锯齿从源头减少（事后修补的上限由此决定）；
	 *   - softAlpha：**连续软 alpha**——`alpha *= pow(saturate((d−t1)/(t2−t1)), 1.5)`
	 *     （OBS 同款曲线，指数 1.5 偏向不透明），过渡带 0→1 连续而非二值跳变；
	 *     启用时**跳过 choke/开运算**（它们会把软边重新啃成硬边），仅保留 despill
	 *     与碎块清除。 */
	opts?: {
		greenDominance?: number;
		boxFilterDistance?: boolean;
		softAlpha?: boolean;
	},
): void {
	const MAXD = 441.67;   // RGB 立方体空间对角线长度
	const W = Math.max(1, Math.round(Math.sqrt(rgba.length / 4)));   // 由长度反推宽度（正方形帧）
	const H = Math.max(1, Math.round(rgba.length / 4 / W));
	const t1 = Math.max(0, Math.min(1, similarity)) * MAXD;
	const band = Math.max(0, Math.min(1, smoothness)) * MAXD;
	const t2 = t1 + band;
	// 绿色主导度阈值：与 smoothness 联动（平滑带越宽，扩展清除越保守）
	const greenDominate = opts?.greenDominance ?? Math.max(18, band * 0.35);
	// ★ 软 alpha 路径（OBS 对标，2026-09-08）：仅 rgb 算法。距离场 3×3 盒式预滤波
	//   + 连续 pow 曲线 alpha；跳过 choke/开运算（硬边后处理会啃掉软边），保留
	//   despill 与碎块清除。
	if (opts?.softAlpha && algo !== 'flood') {
		// ★ 传 `algo`（2026-09-12）：距离度量随算法变 —— 否则软边预览下 rgb/ycbcr 完全等价 ✗。
		keySoftWithDistField(rgba, W, H, key, t1, t2, greenDominate, !!opts?.boxFilterDistance, algo);
		// despill（OBS 式局部去饱和，2026-09-08 实测修正）：半透明边缘像素是
		//   绿白混合色，仅钳 G 会留绿色光晕——向灰度混合（越透明越灰）后叠加
		//   无绿色感；不透明像素仍用 G 钳制。
		for (let i = 0; i < rgba.length; i += 4) {
			const a = rgba[i + 3];
			if (a === 0) { continue; }
			const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
			if (a < 255) {
				const k = a / 255;
				const gray = 0.299 * r + 0.587 * g + 0.114 * b;
				rgba[i] = gray * (1 - k) + r * k;
				rgba[i + 1] = gray * (1 - k) + g * k;
				rgba[i + 2] = gray * (1 - k) + b * k;
			} else if (g > Math.max(r, b)) {
				rgba[i + 1] = Math.max(r, b);
			}
		}
		removeSmallAlphaIslands(rgba, W, H);
		return;
	}
	switch (algo) {
		case 'flood': keyPrimaryFlood(rgba, W, H, key, t1, t2); break;
		case 'ycbcr': keyPrimaryYcbcr(rgba, W, H, key, t1, t2, greenDominate); break;
		default: keyPrimaryRgb(rgba, W, H, key, t1, t2, greenDominate);
	}
	chromaPostProcess(rgba, W, H);
}

/**
 * 软 alpha 主抠（2026-09-08 OBS 对标）：距离场（可选 3×3 盒式预滤波）→
 * 连续 alpha = 原alpha × pow(saturate((d−t1)/(t2−t1)), 1.5)；绿色优势清除
 * （d≥t2 且 gExcess>gd）直接置 0。**不二值化**——边缘保留 1px 级渐变。
 *
 * ★ 距离**度量**随主抠算法变（2026-09-12 修「切换算法没区别」）：此前本函数
 *   恒用 RGB 欧氏距离 ⇒ 软边预览下 `rgb` 与 `ycbcr` **完全等价** ✗（用户实测
 *   「切换到不同的抠像算法，表现都不理想」时发现 rgb/ycbcr 看不出差别）。
 *   现 `ycbcr` 走 **Cb/Cr 色度距离**（与硬路径 `keyPrimaryYcbcr` 同款、同阈值域换算）
 *   ⇒ 色度与亮度解耦，对绿幕亮度不均/白描边上的轻度绿溢更稳 ✓。
 *   （`flood` 不走本函数 —— 它需要连通域判定，见 chromaKeyFrame 的分支。）
 */
function keySoftWithDistField(
	rgba: Uint8Array, W: number, H: number,
	key: { r: number; g: number; b: number }, t1: number, t2: number,
	greenDominate: number, boxFilter: boolean,
	algo: ChromaKeyAlgo = 'rgb',
): void {
	const n = W * H;
	const dist = new Float32Array(n);
	// YCbCr 阈值域换算（与 keyPrimaryYcbcr 一致）：|Cb|,|Cr| ≤ ~142 → 对角线 ≈ 200.8
	const yScale = 200.8 / 441.67;
	const useYcbcr = algo === 'ycbcr';
	const lo = useYcbcr ? t1 * yScale : t1;
	const hi = useYcbcr ? t2 * yScale : t2;
	let kCb = 0, kCr = 0;
	if (useYcbcr) {
		const kY = 0.299 * key.r + 0.587 * key.g + 0.114 * key.b;
		kCb = 0.564 * (key.b - kY);
		kCr = 0.713 * (key.r - kY);
	}
	for (let p = 0; p < n; p++) {
		const i = p * 4;
		if (useYcbcr) {
			const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
			const yy = 0.299 * r + 0.587 * g + 0.114 * b;
			dist[p] = Math.hypot(0.564 * (b - yy) - kCb, 0.713 * (r - yy) - kCr);
		} else {
			dist[p] = Math.hypot(rgba[i] - key.r, rgba[i + 1] - key.g, rgba[i + 2] - key.b);
		}
	}
	let df = dist;
	if (boxFilter) {
		// ★ 两遍 3×3 盒滤（2026-09-08「细线锯齿仍存」）：单遍 3×3 只抹单像素距离
		//   跳动，抹不掉 H.264 4:2:0 块效应（8px 尺度）——两遍卷积 ≈ 5×5 三角核，
		//   平滑半径翻倍。距离场平滑不破坏形状（对细线安全，区别于 mask 开运算）。
		let src = dist;
		for (let pass = 0; pass < 2; pass++) {
			const dst = new Float32Array(n);
			const inp = src;
			for (let y = 0; y < H; y++) {
				for (let x = 0; x < W; x++) {
					let sum = 0, cnt = 0;
					for (let dy = -1; dy <= 1; dy++) {
						const yy = y + dy;
						if (yy < 0 || yy >= H) { continue; }
						for (let dx = -1; dx <= 1; dx++) {
							const xx = x + dx;
							if (xx < 0 || xx >= W) { continue; }
							sum += inp[yy * W + xx];
							cnt++;
						}
					}
					dst[y * W + x] = sum / Math.max(1, cnt);
				}
			}
			src = dst;
		}
		df = src;
	}
	const band = Math.max(1e-6, hi - lo);
	for (let p = 0; p < n; p++) {
		const i = p * 4;
		if (rgba[i + 3] === 0) { continue; }
		const d = df[p];
		const g = rgba[i + 1], r = rgba[i], b = rgba[i + 2];
		const gExcess = g - Math.max(r, b);
		// 真绿溢（重混合像素）直接透明（与硬路径语义一致）
		if (d < lo || (d >= hi && gExcess > greenDominate && g > 60)) {
			rgba[i + 3] = 0;
			continue;
		}
		if (d < hi) {
			// 过渡带：连续曲线（指数 1.5 偏向不透明，主体边缘不发虚）
			const k = Math.pow(Math.min(1, Math.max(0, (d - lo) / band)), 1.5);
			rgba[i + 3] = Math.round(rgba[i + 3] * k);
		}
	}
}

/** 软 alpha 路径的碎块清除：4-连通 alpha>8 岛屿 <6px 清除（软边场景阈值略宽）。 */
function removeSmallAlphaIslands(rgba: Uint8Array, W: number, H: number): void {
	const n = W * H;
	const visited = new Uint8Array(n);
	const stack: number[] = [];
	const members: number[] = [];
	for (let start = 0; start < n; start++) {
		if (visited[start] || rgba[start * 4 + 3] <= 8) { continue; }
		members.length = 0;
		stack.length = 0;
		stack.push(start);
		visited[start] = 1;
		while (stack.length) {
			const cur = stack.pop() as number;
			members.push(cur);
			const cy = (cur / W) | 0;
			const cx = cur - cy * W;
			const push = (j: number) => { if (!visited[j] && rgba[j * 4 + 3] > 8) { visited[j] = 1; stack.push(j); } };
			if (cx > 0) { push(cur - 1); }
			if (cx + 1 < W) { push(cur + 1); }
			if (cy > 0) { push(cur - W); }
			if (cy + 1 < H) { push(cur + W); }
		}
		if (members.length < 6) {
			for (const m of members) { rgba[m * 4 + 3] = 0; }
		}
	}
}

/**
 * 抠像共享后处理（三算法共用，2026-09-08 从 chromaKeyFrame 拆出）：
 * choke（mask 内缩）→ 邻接 despill → 形态学开运算 → 孤立碎块清除。
 */
function chromaPostProcess(rgba: Uint8Array, W: number, H: number): void {
	// ── choke（mask 内缩）：与透明区相邻且带绿色优势的边缘像素 → alpha=0。
	//    两趟迭代（各吃 1px）；从 alpha 快照判定邻接，避免本趟清除影响下一像素。
	// ★ 内缩条件放宽（2026-09-08「边缘裁剪过于厉害」）：① 首趟**无条件**内缩
	//   改为 gExcess>20（真绿混合才吃）——无条件吃 1px 在 2× 超采样后过激：
	//   降采样按覆盖率二值化后，贴边 1px 是 ≥50% 覆盖率的**真实描边**，再被
	//   无条件吃掉 = 白描边整体瘦一圈；② 两趟带绿阈值 6→25——白描边溢色
	//   （gExcess 20-55）是高频场景，6 的阈值把描边外缘 3px 全啃掉。
	{
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
				const gExcess = snap[i + 1] - Math.max(snap[i], snap[i + 2]);
				if (gExcess > 20) { rgba[i + 3] = 0; }
			}
		}
	}
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
				if (gExcess > 25) { rgba[i + 3] = 0; }   // 只吃「真绿混合」的贴边像素，保住白描边
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
	// ── 形态学开运算（2026-09-08「边缘不规整」优化①）：erosion 1px + dilation 1px
	//    （4-邻域十字结构元素）。视频压缩噪声让色距阈值边界逐帧抖动 → alpha 边缘
	//    出现 1px 毛刺/锯齿（视觉即「动图边缘不规整」）。开运算吃掉宽度 ≤1px 的
	//    尖刺与贴边噪声点；净尺寸不变（先蚀后胀），白描边（宽 ≥2px）形状不受影响。
	{
		const eroded = new Uint8Array(rgba.length);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				if (rgba[i + 3] === 0) { continue; }
				// 4-邻域全不透明才保留（边界外视为满足；边界像素被腐蚀）
				const left = x === 0 || rgba[i - 4 + 3] !== 0;
				const right = x + 1 >= W || rgba[i + 4 + 3] !== 0;
				const up = y === 0 || rgba[i - W * 4 + 3] !== 0;
				const down = y + 1 >= H || rgba[i + W * 4 + 3] !== 0;
				if (left && right && up && down) {
					eroded[i + 3] = rgba[i + 3];
				}
			}
		}
		// dilation：4-邻域存在腐蚀幸存像素 → 保留（透明像素 RGB 保持原样，仅 alpha）
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				if (eroded[i + 3] !== 0) { continue; }
				if ((x > 0 && eroded[i - 4 + 3] !== 0)
					|| (x + 1 < W && eroded[i + 4 + 3] !== 0)
					|| (y > 0 && eroded[i - W * 4 + 3] !== 0)
					|| (y + 1 < H && eroded[i + W * 4 + 3] !== 0)) {
					rgba[i + 3] = 255;
				} else {
					rgba[i + 3] = 0;
				}
			}
		}
	}
	// ── 孤立碎块清除（2026-09-08「边缘不规整」优化②）：开运算对 2-3px 的噪声
	//    碎块无效（腐蚀幸存的块中心会被膨胀复原）——按 4-连通域扫 alpha，面积
	//    < 4px 的碎块清除。阈值保守（240² 下 4px ≈ 2×2）：贴纸装饰元素（挥手
	//    粒子/爱心/汗滴）面积普遍 ≥4px 不受影响；1-3px 边缘噪声碎片被清除。
	{
		const nPx = W * H;
		const visited = new Uint8Array(nPx);
		const stack: number[] = [];
		const members: number[] = [];
		for (let start = 0; start < nPx; start++) {
			if (visited[start] || rgba[start * 4 + 3] === 0) { continue; }
			members.length = 0;
			stack.length = 0;
			stack.push(start);
			visited[start] = 1;
			while (stack.length) {
				const cur = stack.pop() as number;
				members.push(cur);
				const cy = (cur / W) | 0;
				const cx = cur - cy * W;
				if (cx > 0) { const j = cur - 1; if (!visited[j] && rgba[j * 4 + 3] !== 0) { visited[j] = 1; stack.push(j); } }
				if (cx + 1 < W) { const j = cur + 1; if (!visited[j] && rgba[j * 4 + 3] !== 0) { visited[j] = 1; stack.push(j); } }
				if (cy > 0) { const j = cur - W; if (!visited[j] && rgba[j * 4 + 3] !== 0) { visited[j] = 1; stack.push(j); } }
				if (cy + 1 < H) { const j = cur + W; if (!visited[j] && rgba[j * 4 + 3] !== 0) { visited[j] = 1; stack.push(j); } }
			}
			if (members.length < 4) {
				for (const px of members) { rgba[px * 4 + 3] = 0; }
			}
		}
	}
}

/**
 * 参考图 → 指定尺寸 RGBA 帧（重采样 + 同参数 chroma-key）。
 *
 * 「首帧一致性」（2026-09-07）：视频模型首帧相对参考图常有漂移（构图/配色/
 * 细节微变），把**输入参考图本身**（已绿底合成）重采样到 GIF 帧尺寸并按同一
 * 参数抠像后替换第 0 帧，保证动图起点与输入静态贴纸逐像素同源。
 * 网格模式传入整版拼贴图 → 上层按常规帧切格，每格第 0 帧即对应静态格。
 */
async function loadSeedFrameRgba(
	imageRef: string,
	width: number,
	height: number,
	key: { r: number; g: number; b: number },
	similarity: number,
	smoothness: number,
	fetchImpl: typeof fetch,
	algo: ChromaKeyAlgo = 'rgb',
	/**
	 * 与**视频帧**同源的抠像选项（2026-09-12）。
	 * ★ 必须与同一次编码里的视频帧完全一致，否则第 0 帧与其余帧边缘不一致
	 *   （实测：种子帧用未钳制的 smoothness=0.25 + 缺 greenDominance → 白描边被
	 *   整圈吃掉，第 0 帧看起来「少了一圈边」= 与后续帧对比像重影/跳变 ✗）。
	 */
	opts?: {
		greenDominance?: number;
		/**
		 * 用**种子帧自己的背景色**当 key（而非视频采样的 key）。
		 * ★ `chroma_color='auto'` 时二者不同：种子是 `compositeImageOnChroma` 用
		 *   **纯绿 #00FF00** 合成的，而视频帧的 key 是从视频首帧采样得到的
		 *   （如 rgb(0,212,0)）→ 用视频 key 抠种子，边缘像素色距整体偏大 →
		 *   白描边外圈**抠不掉**（比其余帧多一圈）✗。改为采样种子自身背景色 ✓。
		 */
		autoKey?: boolean;
	},
): Promise<Uint8Array> {
	const blob = /^data:/i.test(imageRef) ? dataUrlToBlob(imageRef) : await (await fetchImpl(imageRef)).blob();
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) { throw new Error('浏览器无法创建画布。'); }
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, 0, 0, width, height);
		const data = ctx.getImageData(0, 0, width, height).data;
		const rgba = new Uint8Array(data.buffer.slice(0));
		const keyUsed = opts?.autoKey ? autoSampleChromaKeyRgba(rgba, width, height) : key;
		chromaKeyFrame(rgba, keyUsed, similarity, smoothness, algo, {
			boxFilterDistance: true,
			...(opts?.greenDominance !== undefined ? { greenDominance: opts.greenDominance } : {}),
		});
		return rgba;
	} finally {
		bitmap.close();
	}
}

/**
 * 压缩降级档位：colors 色数、fps 抽稀（0=沿用计划帧率）、width 缩放（0=沿用）。
 *
 * ★ 2026-09-08 重排（「描边不清晰」根因，日志实锤）：旧表**色数最先牺牲**
 *   （128→96→64→48…），白描边的抗锯齿渐变带被低色数量化成粗阶梯 → 视觉
 *   「描边模糊/绒毛」。实测 36 帧 240²/128 色 = 1.1MB，100KB 上限下 5 档全超。
 *   新策略：**帧率先行**（体积线性下降：36→13 帧约省 64%）、色数殿后（128 保持
 *   到 5fps 档）、尺寸最后（240 是微信硬尺寸）。表情包 4-6fps 完全可接受
 *   （微信表情普遍 5-10fps），而描边量化糊无法逆转。
 *   注：透明 GIF 主体移动时**帧间差分不可用**（disposal=2 每帧全量重绘），
 *   100KB 约束下降档不可避免——质量优先场景请调大 max_kb（对比期建议 500）。
 */
const TRANSPARENT_GIF_LEVELS: Array<{ colors: number; fps: number; width: number }> = [
	{ colors: 128, fps: 0, width: 0 },    // 全量：计划帧率 + 128 色
	{ colors: 128, fps: 8, width: 0 },    // 帧率先降（体积近线性减半）
	{ colors: 128, fps: 5, width: 0 },    // 色数仍是 128（描边清晰）
	{ colors: 96, fps: 5, width: 0 },
	{ colors: 64, fps: 5, width: 0 },
	{ colors: 48, fps: 4, width: 0 },
	{ colors: 32, fps: 4, width: 0 },
	{ colors: 24, fps: 4, width: 0 },
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
	/** ★ 首帧一致性：参考图 ref（已绿底合成的**整版拼贴图**）→ 抠像后替换第 0 帧，每格第 0 帧 = 对应静态格。 */
	firstFrameOverride?: string,
): Promise<ConvertedGridGifs> {
	const rows = Math.max(1, Math.min(6, Math.round(grid.rows)));
	const cols = Math.max(1, Math.min(6, Math.round(grid.cols)));
	if (rows === 1 && cols === 1) {
		// 1×1 退化：直接走单图管线（语义等价，省一次切格/缩放开销）。
		// thumbs=[]（单图管线不产缩略图——微信上传场景固定走网格管线）。
		const single = await convertVideoToTransparentGif(videoRef, values, chroma, fetchImpl, onProgress, maxBytes, firstFrameOverride);
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
		// ★ 缩放质量（2026-09-08 锯齿优化）：768P→240 高质量插值，减少边缘混合带。
		ctx.imageSmoothingQuality = 'high';
		// ★ 抠像算法可选（2026-09-08 调研落地）：values.chroma_algo（rgb/flood/ycbcr）
		const algo = parseChromaAlgo(values.chroma_algo);
		const key = parseHexColor(chroma.color);
		const rgbaFrames: Uint8Array[] = [];
		for (let i = 0; i < plan.times.length; i++) {
			await seekTo(video, plan.times[i]);
			ctx.drawImage(video, 0, 0, plan.width, plan.height);
			const data = ctx.getImageData(0, 0, plan.width, plan.height).data;
			const rgba = new Uint8Array(data.buffer.slice(0));
			// ★ greenDominance:90（2026-09-12，与 convertVideoToTransparentGif / 静态贴纸
			//   链路对齐）：缺省 max(18, band*0.35) 会把**浅色/白色**元素（半透明泡泡、
			//   高光叠在绿幕上的偏绿像素，gExcess 可达 ~55）当绿幕删掉 ✗。
			chromaKeyFrame(rgba, key, chroma.similarity, chroma.smoothness, algo, { boxFilterDistance: true, greenDominance: 90 });
			rgbaFrames.push(rgba);
			onProgress?.({ promptId: '', value: 3 + Math.round((i + 1) / plan.times.length * 45) });
		}
		if (rgbaFrames.length === 0) {
			throw new Error('未能抽取任何视频帧（检查 start_s / end_s 区间）。');
		}
		// ★ 首帧一致性（2026-09-07）：整版拼贴参考图（已绿底合成）按帧尺寸重采样
		//   + 同参数抠像后替换第 0 帧 —— 后续按 rows×cols 正常切格，每格第 0 帧
		//   即对应输入静态格（与切格几何完全对齐：同一 crop/scale 管线）。
		//   失败不阻断（视频首帧兜底）。
		if (firstFrameOverride) {
			try {
				rgbaFrames[0] = await loadSeedFrameRgba(firstFrameOverride, plan.width, plan.height, key, chroma.similarity, chroma.smoothness, fetchImpl, algo);
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn(`[VideoToGif] firstFrameOverride 加载失败，保留视频首帧: ${e instanceof Error ? e.message : String(e)}`);
			}
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
		sctx.imageSmoothingQuality = 'high';
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
	/** ★ 首帧一致性：参考图 ref（已绿底合成）→ 抠像后替换 GIF 第 0 帧。 */
	firstFrameOverride?: string,
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

		// ★ 2× 超采样抗锯齿（2026-09-08「细线装饰锯齿」）：1-bit alpha 的 staircase
		//   只能靠提高判定分辨率缓解——在 2×（480）分辨率抽帧 + 抠像，再按 2×2
		//   子像素**覆盖率**二值降采样（>50% 不透明 → 255）。边缘位置精度翻倍、
		//   台阶减半；细线（240 下 1-2px）在 480 下是 2-4px，开运算不再整条吃掉。
		const SS = 2;
		const canvas = document.createElement('canvas');
		canvas.width = plan.width * SS;
		canvas.height = plan.height * SS;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) { throw new Error('浏览器无法创建画布。'); }

		// ── 逐帧抽取 + 抠像（缓存 RGBA，供多档重编码复用）────────────────────
		// ★ 缩放质量（2026-09-08 锯齿优化）：768P→480 高质量插值，减少边缘混合带。
		ctx.imageSmoothingQuality = 'high';
		// ★ 抠像算法可选（2026-09-08 调研落地）：values.chroma_algo（rgb/flood/ycbcr）
		const algo = parseChromaAlgo(values.chroma_algo);
		// ★ smoothness 防呆钳制（2026-09-08「边缘裁剪过于厉害」）：GIF 硬路径的
		//   smoothness 语义是「外扩清除带」（t1..t2 直接透明，边缘锐化）——0.25
		//   时删除带达 110/441，白描边外圈（混绿色距 100-150）整圈被吃，与原图
		//   差异巨大。合理范围 0.08-0.12，>0.15 钳到 0.12 并提示（软边需求走
		//   matte 抠像预览，其 softAlpha 路径 smoothness=软边宽度不受此限）。
		let effectiveSmoothness = chroma.smoothness;
		if (effectiveSmoothness > 0.15) {
			effectiveSmoothness = 0.12;
			// eslint-disable-next-line no-console
			console.warn(`[VideoToGif] smoothness=${chroma.smoothness} 过大（GIF 硬路径会整圈削掉白描边），已钳制到 0.12。软边预览请用「✂️ 抠像预览」。`);
		}
		// ★ key 色自动采样（2026-09-08）：chroma.color='auto' → 从**首帧**四边采样。
		//   视频编码会让幕布绿漂移（#00FF00 → 偏黄绿/暗绿），采样值贴合实际帧，
		//   比 fix 死 hex 更稳；采样一次全帧复用（幕布色帧间基本恒定）。
		const autoKey = chroma.color === 'auto';
		let key = autoKey ? { r: 0, g: 255, b: 0 } : parseHexColor(chroma.color);
		const rgbaFrames: Uint8Array[] = [];
		for (let i = 0; i < plan.times.length; i++) {
			await seekTo(video, plan.times[i]);
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			// slice(0) 复制出独立 buffer（后续 chromaKeyFrame 就位改写，不污染 ImageData 池）
			const rgba = new Uint8Array(data.buffer.slice(0));
			if (autoKey && i === 0) {
				key = autoSampleChromaKeyRgba(rgba, canvas.width, canvas.height);
				// eslint-disable-next-line no-console
				console.warn(`[VideoToGif] chroma color=auto: sampled key=rgb(${key.r},${key.g},${key.b}) from first frame`);
			}
			// ★ greenDominance:90（2026-09-08「边缘裁剪过于厉害」）：视频链此前用
			//   默认联动值（max(18, band×0.35)）——smoothness 调大时联动阈值下降，
			//   白描边轻度溢色（gExcess 20-55）被扩展清除整片吃掉。表情链主体是
			//   白描边贴纸，对齐静态切分入口传 90（gExcess>90 才算真绿溢）。
			chromaKeyFrame(rgba, key, chroma.similarity, effectiveSmoothness, algo, { boxFilterDistance: true, greenDominance: 90 });
			rgbaFrames.push(downsampleChroma2x(rgba, canvas.width, canvas.height));
			// 抽帧+抠像占 3-60%，压缩迭代占 60-95%
			onProgress?.({ promptId: '', value: 3 + Math.round((i + 1) / plan.times.length * 57) });
		}
		if (rgbaFrames.length === 0) {
			throw new Error('未能抽取任何视频帧（检查 start_s / end_s 区间）。');
		}
		// ★ 首帧一致性（2026-09-07）：参考图（已绿底合成）按帧尺寸重采样 + 同参数
		//   抠像后整体替换第 0 帧 —— 动图起点 = 输入静态贴纸。失败不阻断（视频首帧兜底）。
		//   ★ 参数必须与视频帧**完全一致**（2026-09-12）：用 effectiveSmoothness
		//   （已钳制）+ greenDominance:90，否则第 0 帧白描边被吃掉、与后续帧不一致 ✗。
		if (firstFrameOverride) {
			try {
				// ★ 与视频帧**同管线**（2026-09-12）：视频帧是「2× 超采样抽帧 + 抠像 →
				//   2×2 覆盖率二值降采样」；种子帧此前直接 1× 抠像 → 边缘无抗锯齿、
				//   与其余帧边缘形态不一致 ✗。现同样走 2× → downsampleChroma2x ✓。
				const seedHi = await loadSeedFrameRgba(firstFrameOverride, plan.width * SS, plan.height * SS, key, chroma.similarity, effectiveSmoothness, fetchImpl, algo, { greenDominance: 90, autoKey: autoKey });
				rgbaFrames[0] = downsampleChroma2x(seedHi, plan.width * SS, plan.height * SS);
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn(`[VideoToGif] firstFrameOverride 加载失败，保留视频首帧: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// ★ 首尾回环混合（2026-09-08「视频首尾帧不一致」）：视频模型无循环约束，
		//   GIF 无限循环播放时尾帧→首帧跳变突兀。尾部 m 帧与首帧线性插值——
		//   播放末段平滑过渡回起点。m=4 对 subtle motion 表情无鬼影；大动作可关
		//   （loop_blend=false）。
		// ★ 只混合「两帧都不透明」的像素（2026-09-09 实测修复「部分帧绿色边缘」）：
		//   主体位置偏移区首帧是透明（绿幕底），原全像素插值会把绿幕 RGB 混进
		//   尾帧像素 → GIF 1-bit 化后成不透明绿边（实测末帧强绿 263px、max
		//   gExcess=84，全部集中在混合最重的末两帧）。首帧透明处保持尾帧原样。
		// ★★ 再叠加「颜色接近」门限（2026-09-12 修「转 GIF 后首帧重影」）：
		//   首帧现在被**首帧一致性**替换成输入贴纸，而视频尾帧常是**不同姿势/
		//   缩放**（这正是需要替换首帧的原因）→ 无条件插值 = 两个姿势半透明叠加
		//   = 肉眼「重影」✗（且 GIF 1-bit alpha 无法表达半透明，叠影更明显）。
		//   现只混**色距接近**的像素（背景/描边/缓慢移动区 → 保住「缓慢区渐回
		//   起点」的平滑收益），色距大的像素保留尾帧原色（等价硬切，不产生叠影）。
		if (values.loop_blend !== false && rgbaFrames.length > 6) {
			const LOOP_BLEND_MAX_DIST = 96;      // L1 色距（0-765，≈12%）
			const m = Math.min(4, rgbaFrames.length - 2);
			const first = rgbaFrames[0];
			for (let k = 0; k < m; k++) {
				const t = (k + 1) / (m + 1);          // 0.2→0.8：末帧最接近首帧
				const tail = rgbaFrames[rgbaFrames.length - m + k];
				for (let p = 0; p < tail.length; p += 4) {
					if (first[p + 3] === 0 || tail[p + 3] === 0) { continue; }
					const dist = Math.abs(tail[p] - first[p]) + Math.abs(tail[p + 1] - first[p + 1]) + Math.abs(tail[p + 2] - first[p + 2]);
					if (dist > LOOP_BLEND_MAX_DIST) { continue; }
					tail[p] = Math.round(tail[p] * (1 - t) + first[p] * t);
					tail[p + 1] = Math.round(tail[p + 1] * (1 - t) + first[p + 1] * t);
					tail[p + 2] = Math.round(tail[p + 2] * (1 - t) + first[p + 2] * t);
					tail[p + 3] = Math.round(tail[p + 3] * (1 - t) + first[p + 3] * t);
				}
			}
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
				sctx.imageSmoothingQuality = 'high';
				bctx.imageSmoothingQuality = 'high';
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

// ═══════════════════════════════════════════════════════════════════════════
// 视频抠图（ComfyTV.VideoMatteStage，2026-09-08）—— 独立工具节点。
//
// 与「转动态表情包」（Saros.AnimatedEmoji）的差异：本节点**不生成视频**，只对
// 上游任意视频（视频生成节点产物 / 上传视频）做本地抠像 → 透明 GIF。管线完全
// 复用 convertVideoToTransparentGif（抽帧 + chromaKeyFrame 五道后处理 + 压缩
// 迭代），抠像参数默认值对齐静态表情包验证基准（sim=0.25 / smooth=0.08）。
// ═══════════════════════════════════════════════════════════════════════════

/** 浏览器本地执行「视频抠图」。 */
export async function runVideoMatteNode(input: VideoToGifInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, values, upstreams, store, onProgress } = input;
	const snapshotKey = input.snapshotKey ?? nodeId;
	const src = firstUpstreamVideo(store, upstreams);
	if (!src) {
		return { promptId: '', status: 'error', error: '视频抠图需要上游视频输入（请先连接并运行一个视频节点）。', entries: [] };
	}

	// 抠像参数（默认对齐静态表情包验证基准 sim=0.25/smooth=0.08；color 默认
	// auto = 首帧四边自动采样，幕布绿漂移时比固定 hex 稳）。
	const chroma = {
		color: String(values.chroma_color ?? 'auto') || 'auto',
		similarity: Number.isFinite(Number(values.chroma_similarity)) ? Number(values.chroma_similarity) : 0.25,
		smoothness: Number.isFinite(Number(values.chroma_smoothness)) ? Number(values.chroma_smoothness) : 0.08,
	};
	const maxKb = Math.max(100, Math.min(2000, Math.round(Number(values.max_kb) || 500)));
	// eslint-disable-next-line no-console
	console.warn(`[VideoMatte] start nodeId=${nodeId} src=${src.slice(0, 60)} algo=${String(values.chroma_algo ?? 'rgb')} color=${chroma.color} sim=${chroma.similarity} smooth=${chroma.smoothness} maxKb=${maxKb}`);

	try {
		const fetchImpl = input.fetchImpl ?? globalThis.fetch;
		const converted = await convertVideoToTransparentGif(src, values, chroma, fetchImpl, onProgress, maxKb * 1024);
		const outBlob = converted.gifBlob;

		// ── 上传（失败退 data:，同 runVideoToGifNode）───────────────────────
		let ref = '';
		try {
			const form = new FormData();
			form.append('image', outBlob, `video-matte-${Date.now()}-${Math.floor(Math.random() * 1e6)}.gif`);
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

		// kind:'image' —— GIF 用 <img> 播放（<video> 无法播 gif，见 runVideoToGifNode 注释）
		const entry = {
			nodeId: snapshotKey,
			port: 'output',
			key: `${snapshotKey}:output:0`,
			media: {
				kind: 'image' as const,
				ref,
				meta: {
					mime: 'image/gif',
					transparent: '1',
					gifFrames: String(converted.frames),
					gifSize: `${converted.width}x${converted.height}`,
					gifDelayCs: String(converted.delayCs),
					matteLevel: String(converted.level),
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

