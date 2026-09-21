/* 媒体库引用桥（同源化方案 B/C）。
 *
 * B（引用）：笔记里的 `saros-media://<id>` 由宿主解析为 webview 可加载 URL
 *   （`kbblocks.resolveMediaAsset` → `kbblocks.mediaAssetUrl`）。
 * C（沉淀）：把资产显式复制进笔记附件目录并回报相对引用
 *   （`kbblocks.saveMediaToNote` → `kbblocks.mediaSaved`）。
 *
 * 复用 embedBridge 的请求-响应模式：postMessage + 共享 window 监听 + 按 requestId
 * 结算 + 超时兜底（宿主卡住时不让图片永久转圈）。
 */

import { postMessage } from '../bridge/messageClient';
import { isMediaAssetSrc, mediaAssetId } from './assetPath';

// 纯函数真源在 ./assetPath.ts（无桥依赖，可单测）；此处 re-export 供渲染组件单点引用。
export { isMediaAssetSrc, mediaAssetId };

const RESOLVE_TIMEOUT_MS = 8000;
const SAVE_TIMEOUT_MS = 20000;

type Resolver = (value: unknown) => void;
const pending = new Map<string, Resolver>();
let installed = false;
let counter = 0;

function install(): void {
	if (installed) { return; }
	installed = true;
	window.addEventListener('message', (e: MessageEvent) => {
		const msg = e.data;
		if (!msg || msg.direction !== 'toWebview') { return; }
		if (msg.type === 'kbblocks.mediaAssetUrl' || msg.type === 'kbblocks.mediaSaved') {
			const requestId = msg.data?.requestId;
			if (typeof requestId !== 'string') { return; }
			const resolver = pending.get(requestId);
			if (resolver) {
				pending.delete(requestId);
				resolver(msg.data);
			}
		}
	});
}

function nextRequestId(tag: string): string {
	return `${tag}_${++counter}_${Date.now()}`;
}

/** 方案 B：请求宿主解析资产 URL；失败/超时返回 null（渲染占位）。 */
export function resolveMediaAssetUrl(assetId: string): Promise<string | null> {
	install();
	const requestId = nextRequestId('mres');
	return new Promise<string | null>((resolve) => {
		const done: Resolver = (data) => {
			const url = (data as { url?: unknown } | undefined)?.url;
			resolve(typeof url === 'string' && url ? url : null);
		};
		pending.set(requestId, done);
		postMessage('kbblocks.resolveMediaAsset', { assetId, requestId });
		window.setTimeout(() => {
			if (pending.has(requestId)) { pending.delete(requestId); resolve(null); }
		}, RESOLVE_TIMEOUT_MS);
	});
}

/**
 * 方案 C：请求宿主把资产复制进笔记附件目录，返回可写进正文的相对引用
 * （失败返回 { error }）。
 */
export function saveMediaToNote(assetId: string): Promise<{ relRef?: string; error?: string }> {
	install();
	const requestId = nextRequestId('msav');
	return new Promise((resolve) => {
		const done: Resolver = (data) => {
			const d = data as { relRef?: unknown; error?: unknown } | undefined;
			resolve({
				relRef: typeof d?.relRef === 'string' ? d.relRef : undefined,
				error: typeof d?.error === 'string' ? d.error : undefined,
			});
		};
		pending.set(requestId, done);
		postMessage('kbblocks.saveMediaToNote', { assetId, requestId });
		window.setTimeout(() => {
			if (pending.has(requestId)) { pending.delete(requestId); resolve({ error: 'timeout' }); }
		}, SAVE_TIMEOUT_MS);
	});
}
