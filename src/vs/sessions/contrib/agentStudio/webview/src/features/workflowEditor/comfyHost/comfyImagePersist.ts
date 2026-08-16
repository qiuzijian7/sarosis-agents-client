/*---------------------------------------------------------------------------------------------
 *  comfyImagePersist — 让 ComfyUI 生成的图像在 app 重启后仍可显示。
 *
 *  问题：comfyOutputsToSnapshots 把图像 ref 写成 `${baseUrl}/view?filename=…`
 *  （依赖运行中的 ComfyUI 服务器）。app 重启后服务器端口可能变化或尚未启动，
 *  该 ref 失效 → 节点卡片图像消失。
 *
 *  修复：在把快照写入 MediaSnapshotStore 之前，把图像字节下载为自包含的
 *  `data:` URL（字符串，随 IndexedDB 一并持久化，`<img src>` 无需改动即可显示）。
 *  仅对 ComfyUI /view 引用生效；data:/http(s) 等已有引用原样保留。
 *
 *  字节获取走 createComfyFetch：本产品 comfy.launch 带 --enable-cors-header，
 *  生成时处于直连(direct)模式，返回真实 Response 支持 blob()。代理(proxied)态
 *  Response 无 blob() → 优雅保留原 ref，不破坏在线显示。
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotEntry } from './mediaSnapshot.js';

/** 判断 ref 是否为 ComfyUI /view 引用（需要下载持久化）。 */
function isComfyViewRef(ref: string): boolean {
	return typeof ref === 'string' && ref.includes('/view?');
}

function blobToDataUrl(blob: Blob, timeoutMs = 5000): Promise<string> {
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		const timer = setTimeout(() => {
			try { fr.abort(); } catch { /* ignore */ }
			reject(new Error('blobToDataUrl timeout'));
		}, timeoutMs);
		fr.onload = () => { clearTimeout(timer); resolve(fr.result as string); };
		fr.onerror = () => { clearTimeout(timer); reject(fr.error); };
		fr.onabort = () => { clearTimeout(timer); reject(new Error('aborted')); };
		fr.readAsDataURL(blob);
	});
}

/** 单张图像的物化总超时（含 fetch + FileReader.readAsDataURL）。 */
const MATERIALIZE_PER_IMAGE_TIMEOUT_MS = 10_000;

/**
 * 把 entries 中 ComfyUI /view 图像引用物化为自包含 data: URL。
 * 非图像/视频类或下载失败时原样返回（不抛异常）。
 *
 * @param baseUrl 当前 runner baseUrl（用于补全相对 /view? 路径）。
 * @param fetchImpl createComfyFetch(baseUrl) 返回的 fetch（按 origin 路由直连/代理）。
 */
export async function materializeComfyImageRefs(
	entries: MediaSnapshotEntry[],
	baseUrl: string,
	fetchImpl: typeof fetch,
): Promise<MediaSnapshotEntry[]> {
	if (!entries.length) { return entries; }
	let origin = '';
	try { origin = new URL(baseUrl).origin; } catch { /* ignore */ }
	const out = await Promise.all(entries.map(async (e): Promise<MediaSnapshotEntry> => {
		// 视频字节体量大，保持原 /view 引用；其余 /view 引用物化为 data URL。
		if (e.media.kind === 'video') { return e; }
		const ref = e.media.ref;
		if (!isComfyViewRef(ref)) { return e; }
		// 全链路熔断：fetch + blob + readAsDataURL 任一环节挂起/抛错都按"原样返回"
		// 处理——执行流程的 Promise 链绝对不能被死锁卡住（否则 [runStageWorkflow]
		// 的 awaited entries 永不 resolve → 卡片图像/媒体库全部空着）。
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const url = ref.startsWith('/view') && origin ? origin + ref : ref;
			const ac = new AbortController();
			timer = setTimeout(() => ac.abort(new Error('materialize fetch timeout')),
				MATERIALIZE_PER_IMAGE_TIMEOUT_MS);
			const res = await fetchImpl(url, { signal: ac.signal });
			if (!res.ok) { return e; }
			const blobFn = (res as Response & { blob?: () => Promise<Blob> }).blob;
			if (typeof blobFn !== 'function') { return e; } // 代理态无 blob → 保留原 ref
			const blob = await blobFn.call(res);
			const dataUrl = await blobToDataUrl(blob);
			if (!dataUrl) { return e; }
			return { ...e, media: { ...e.media, ref: dataUrl } };
		} catch {
			return e; // 超时 / CORS / 任何异常都安全降级，**绝不阻塞主流程**
		} finally {
			if (timer) { clearTimeout(timer); }
		}
	}));
	return out;
}
