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
import { encodeGif, medianCutPalette, mapToPaletteIndices, planGifFrames, type GifFrameInput } from './videoToGif.js';

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
function dataUrlToBlob(url: string): Blob {
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
