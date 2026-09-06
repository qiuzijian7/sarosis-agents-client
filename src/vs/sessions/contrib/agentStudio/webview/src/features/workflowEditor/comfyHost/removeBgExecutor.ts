/*---------------------------------------------------------------------------------------------
 *  removeBgExecutor — 「去背景」节点的浏览器本地执行。
 *
 *  链路：取上游最新图像 ref → fetch 成 bytes → **ComfyUI 抠图**（saros_cutout
 *  自定义节点 SarosBiRefNetCutout，见 comfyCutout.ts）→ RGBA PNG（含 ComfyUI
 *  output view URL）→ snapshotStore.put。
 *
 *  2026-09-06：处理端从「主进程内置 ONNX U²Net（cutout.remove RPC，模型缓存
 *  ~/.vssaros/cutout-models）」切换为 **ComfyUI 自定义节点** —— 主进程不再参与
 *  抠图，模型唯一落盘位置是 ComfyUI 的 models/onnx/。
 *  rembg widget（model/alpha_matting/post_process）保留在节点 UI 上但被忽略
 *  （saros_cutout 只收 image）；后续接入多模型时再把 model 映射接回来。
 *--------------------------------------------------------------------------------------------*/

import type { ComfyRunProgress, IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { comfyRemoveBackground } from './comfyCutout.js';

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
		onProgress?.({ promptId: '', value: 10 });
		const bytes = await fetchImageBytes(src, fetchImpl);
		onProgress?.({ promptId: '', value: 35 });

		// 处理端 = ComfyUI saros_cutout 节点（GPU/CPU 自动）。结果自带 ComfyUI
		// output view URL —— 下游 ComfyUI stage 可直接 LoadImage 引用；浏览器
		// 本地 stage 经 /view 拉取也无需再上传。data: 仅作 view 拉取失败时的兜底。
		const cutout = await comfyRemoveBackground(runner, bytes, (text) => onProgress?.({ promptId: '', value: 35, message: text }));
		onProgress?.({ promptId: '', value: 75 });
		const dataUrl = await blobToDataUrl(cutout.blob);
		let ref = '';
		try {
			// 用可注入 fetchImpl（代理）探测：直接裸 fetch 跨源 view URL 会被 CORS 拦。
			const check = await fetchImpl(cutout.viewUrl, { method: 'HEAD' });
			if (check.ok) { ref = cutout.viewUrl; }
		} catch { /* 跨源 HEAD 失败：走 data: 兜底 */ }
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
		onProgress?.({ promptId: '', value: 100 });
		return { promptId: '', status: 'success', entries: [entry], durationMs: 0 };
	} catch (err) {
		return { promptId: '', status: 'error', error: err instanceof Error ? err.message : String(err), entries: [] };
	}
}
