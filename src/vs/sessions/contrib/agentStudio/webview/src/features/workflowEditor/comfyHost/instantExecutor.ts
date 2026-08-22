/*---------------------------------------------------------------------------------------------
 *  instantExecutor — run ComfyTV "instant" stages (Crop / Rotate / Mirror)
 *  fully in the browser: fetch the upstream image, apply the transform on a
 *  <canvas>, upload the PNG back to ComfyUI input/ and register a snapshot.
 *--------------------------------------------------------------------------------------------*/

import type { ComfyRunProgress, IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { applyInstantDraw, instantOutputSize } from './instantNodes.js';

export interface InstantNodeInput {
	runner: IComfyRunner;
	nodeId: string;
	/** 快照归档键（= stageUid）。缺省回退 nodeId（见 StageWorkflowRunOptions）。 */
	snapshotKey?: string;
	type: string;
	values: Record<string, unknown>;
	upstreams?: string[];
	store: MediaSnapshotStore;
	onProgress?: (p: ComfyRunProgress) => void;
	/** Injectable fetch (proxy) for fetching the upstream image (ComfyUI view URL). */
	fetchImpl?: typeof fetch;
}

/**
 * `data:` URL → Blob（同步，纯内存）。
 *
 * 见下方 fetch 分支注释：webview CSP 的 `connect-src` 不含 `data:`，
 * `fetch('data:…')` 必被拦截并抛 `TypeError: Failed to fetch`，只能本地解码。
 *
 * 刻意**不复用** `messageClient.ts` 的同名导出：该模块是「多 export function」
 * 模块，在 esbuild IIFE bundle 下命名导入存在丢失风险（见项目历史踩坑记录），
 * 这段逻辑很短，就地实现最稳。
 */
function dataUrlToBlob(url: string): Blob {
	const comma = url.indexOf(',');
	if (comma < 0) { throw new TypeError('Invalid data: URL'); }
	const meta = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	const isB64 = /;base64$/i.test(meta);
	const contentType = (isB64 ? meta.replace(/;base64$/i, '') : meta) || 'application/octet-stream';
	if (!isB64) {
		return new Blob([decodeURIComponent(payload)], { type: contentType });
	}
	const bin = atob(payload);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
	return new Blob([bytes as unknown as BlobPart], { type: contentType });
}

/** Blob → `data:` URL（上传不可用时的本地兜底 ref）。 */
function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result ?? ''));
		fr.onerror = () => reject(fr.error ?? new Error('读取变换结果失败'));
		fr.readAsDataURL(blob);
	});
}

/**
 * 取上游**最新**的一张图。
 *
 * ★ 原实现返回的是遇到的**第一张**，而 `store.byNode()` 按 index 升序返回
 *   （index 是 put 时单调递增分配的）→ 拿到的永远是该上游**最早**那张。
 *   于是上游重新生成后，Rotate/Mirror/Crop 仍然在变换第一次的旧图，
 *   表现就是「重新生成图像后下游 OUTPUT 没跟着变」。
 *   改为取 index 最大的一条（= 最新一次输出）。
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

/** Browser-local execution of an instant stage. */
export async function runInstantNode(input: InstantNodeInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, values, upstreams, store, onProgress } = input;
	// 快照归档键：优先 stageUid（与 nodeCard 读侧一致），缺省 nodeId。
	const snapshotKey = input.snapshotKey ?? nodeId;
	const src = firstUpstreamImage(store, upstreams);
	if (!src) {
		return { promptId: '', status: 'error', error: '即时节点需要上游图像输入（请先连接生成图像并执行）。', entries: [] };
	}
	// 注：不再因 `!runner.fetchApi` 直接失败 —— 上传只是「让后端也能引用这张图」
	// 的增强项，浏览器本地变换本身不依赖它（拿不到就用 data: 兜底，见下）。
	try {
		onProgress?.({ value: 20 });
		// src 可能是 ComfyUI 本地 view URL（跨源 403）→ 用代理 fetch（智能降级）。
		// ★ 但 `data:` 必须本地解码：webview CSP 的 connect-src 不含 data:，
		//   任何 fetch('data:…') 都会被拦截并抛 `TypeError: Failed to fetch`。
		//   注入的 fetchImpl（createComfyFetch）已内置该分支；这里再兜一层，
		//   保证调用方传了裸 globalThis.fetch 时也不会踩坑。
		const fetchImpl = input.fetchImpl ?? globalThis.fetch;
		const blob = /^data:/i.test(src)
			? dataUrlToBlob(src)
			: await (await fetchImpl(src)).blob();
		const bmp = await createImageBitmap(blob);
		const size = instantOutputSize(type, values, bmp.width, bmp.height);
		const canvas = document.createElement('canvas');
		canvas.width = size.w;
		canvas.height = size.h;
		const ctx = canvas.getContext('2d');
		if (!ctx) { return { promptId: '', status: 'error', error: '浏览器无法创建画布。', entries: [] }; }
		applyInstantDraw(ctx, type, values, bmp.width, bmp.height, bmp);
		onProgress?.({ value: 60 });
		const outBlob = await new Promise<Blob>((resolve) => {
			canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/png');
		});
		// ── 上传到 ComfyUI input/，拿到可被后端工作流引用的 filename ──
		// ★ 必须容错：`fetchApi` 底层的代理路径（proxiedComfyFetch）只透传
		//   `typeof body === 'string'` 的 body，FormData 会被丢弃 → ComfyUI 收到
		//   空 multipart → 返回无 name。此时**绝不能**拼出一个指向不存在文件的
		//   `/view?filename=` —— 那个 ref 会让卡片 OUTPUT 显示裂图，且下游节点
		//   再次 fetch 时又炸一次。
		//   兜底：退回浏览器本地 data: URL。变换结果照样能显示、能被下游 instant
		//   节点消费（TransformEditor / firstUpstreamImage 都接受 data:）。
		let ref = '';
		try {
			const form = new FormData();
			// ★ 文件名必须唯一：固定用 `instant.png` 时 ComfyUI 的 /upload/image
			//   会覆盖同名文件并返回**同一个 name** → 拼出的 view URL 一模一样
			//   → 浏览器命中磁盘缓存显示旧位图 → 「点了旋转但 OUTPUT 没变」。
			form.append('image', outBlob, `instant-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
			// fetchApi 是可选能力（IComfyRunner.fetchApi?），缺失时直接走兜底。
			// body 类型已放宽为 `string | FormData`（comfyRunner.ts），无需强转。
			const resp = await runner.fetchApi?.('/upload/image', { method: 'POST', body: form });
			const data = await resp?.json() as { name?: string; subfolder?: string; type?: string } | undefined;
			const name = String(data?.name ?? '');
			if (name) {
				const subfolder = String(data?.subfolder ?? '');
				const typeOut = String(data?.type ?? 'output');
				ref = `${runner.baseUrl}/view?filename=${encodeURIComponent(name)}${subfolder ? '&subfolder=' + encodeURIComponent(subfolder) : ''}&type=${typeOut}`;
			}
		} catch {
			// 忽略：走下面的 data: 兜底。
		}
		if (!ref) {
			ref = await blobToDataUrl(outBlob);
		}
		const entry = {
			nodeId: snapshotKey,
			port: 'output',
			key: `${snapshotKey}:output:0`,
			media: { kind: 'image' as const, ref },
			index: 0,
		};
		store.put(entry);
		onProgress?.({ value: 100 });
		return { promptId: '', status: 'success', entries: [entry], durationMs: 0 };
	} catch (err) {
		return { promptId: '', status: 'error', error: String(err), entries: [] };
	}
}
