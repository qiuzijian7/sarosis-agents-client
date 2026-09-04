/*---------------------------------------------------------------------------------------------
 *  removeBgExecutor — 「去背景」节点的浏览器本地执行。
 *
 *  链路：取上游最新图像 ref → fetch 成 bytes → **内置 AI 抠图**（主进程 ONNX
 *  U²Net，cutout.remove RPC，见 cutoutAi.ts）→ RGBA PNG → 上传 ComfyUI input/
 *  （失败退 data:）→ snapshotStore.put。
 *
 *  2026-09-03：处理端从「本地 rembg 独立服务（rembg_server.py:7000）」切换为
 *  **内置 ONNX 推理** —— 无需启动任何服务；模型按需下载缓存（~/.vssaros/cutout-models）。
 *  rembg widget（model/alpha_matting/post_process）保留在节点 UI 上但被忽略
 *  （U²Net 无对应参数）；后续接入 isnet-anime 等内置模型时再把 model 映射接回来。
 *--------------------------------------------------------------------------------------------*/

import type { ComfyRunProgress, IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { removeBackgroundRgba } from './cutoutAi.js';

export interface RemoveBgInput {
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
		fr.onerror = () => reject(fr.error ?? new Error('读取去背景结果失败'));
		fr.readAsDataURL(blob);
	});
}

/**
 * 取上游**最新**的一张图（index 最大 = 最近一次输出）。
 * 与 instantExecutor.firstUpstreamImage 同策略（取第一条会永远拿到最早的输出，
 * 上游重跑后下游不更新）。
 */
function firstUpstreamImage(store: MediaSnapshotStore, upstreams: string[] | undefined): string | undefined {
	let best: { ref: string; index: number } | undefined;
	for (const id of upstreams ?? []) {
		for (const entry of store.byNode(id)) {
			if (entry.media.kind !== 'image' || !entry.media.ref) { continue; }
			const idx = entry.index ?? 0;
			if (!best || idx >= best.index) { best = { ref: entry.media.ref, index: idx }; }
		}
	}
	return best?.ref;
}

/** 上游 ref → 原始字节。data: 本地解码（CSP 拦 fetch），其余走代理 fetch（跨源 view URL）。 */
async function fetchImageBytes(ref: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
	if (/^data:/i.test(ref)) {
		const blob = dataUrlToBlob(ref);
		return new Uint8Array(await blob.arrayBuffer());
	}
	const response = await fetchImpl(ref);
	if (!response.ok) { throw new Error(`读取上游图像失败：HTTP ${response.status}`); }
	return new Uint8Array(await response.arrayBuffer());
}

/** 内置 AI 抠图：PNG/JPEG bytes → 解码 → U²Net mask → 带 alpha 的 PNG Blob。 */
async function removeBackgroundPng(bytes: Uint8Array, onStatus?: (text: string) => void): Promise<Blob> {
	const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }));
	try {
		const img = new Image();
		img.src = url;
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('去背景：上游图像解码失败'));
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
		const dataUrl = cv.toDataURL('image/png');
		const resp = await fetch(dataUrl);
		return await resp.blob();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** 浏览器本地执行「去背景」。 */
export async function runRemoveBgNode(input: RemoveBgInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, values, upstreams, store, onProgress } = input;
	const snapshotKey = input.snapshotKey ?? nodeId;
	const src = firstUpstreamImage(store, upstreams);
	if (!src) {
		return { promptId: '', status: 'error', error: '去背景需要上游图像输入（请先连接并运行一个图像节点，如 Load / 文生图 / ImageStage）。', entries: [] };
	}

	try {
		const fetchImpl = input.fetchImpl ?? globalThis.fetch;
		onProgress?.({ value: 10 });
		const bytes = await fetchImageBytes(src, fetchImpl);
		onProgress?.({ value: 35 });

		// 处理端 = 主进程内置 ONNX U²Net（cutout.remove，rembg 算法内置化）
		const outBlob = await removeBackgroundPng(bytes, (text) => onProgress?.({ promptId: '', value: 35, message: text }));
		onProgress?.({ value: 75 });
		const dataUrl = await blobToDataUrl(outBlob);

		// ── 上传 ComfyUI input/（失败退 data:，同 instantExecutor 的容错理由）──
		// 上传后下游 ComfyUI stage 可直接 LoadImage 引用；浏览器本地 stage 用 data: 也行。
		let ref = '';
		try {
			const form = new FormData();
			// 文件名必须唯一，否则 ComfyUI 覆盖同名文件返回同一 name → 浏览器
			// 命中磁盘缓存显示旧图（见 instantExecutor 同处注释）。
			form.append('image', outBlob, `removebg-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
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
		if (!ref) { ref = dataUrl; }

		// meta.mime 必须是 image/png：下游 LoadImage / 导出按 mime 判定，透明 PNG 换成
		// jpeg 会丢 alpha。宽高留空（快照渲染端用 <img> 自然尺寸）。
		const entry = {
			nodeId: snapshotKey,
			port: 'output',
			key: `${snapshotKey}:output:0`,
			media: {
				kind: 'image' as const,
				ref,
				meta: { mime: 'image/png' },
			},
			index: 0,
		};
		store.put(entry);
		onProgress?.({ value: 100 });
		return { promptId: '', status: 'success', entries: [entry], durationMs: 0 };
	} catch (err) {
		return { promptId: '', status: 'error', error: err instanceof Error ? err.message : String(err), entries: [] };
	}
}
