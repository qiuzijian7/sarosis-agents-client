/* Bridge for note embeds (`![[note]]`): an embed asks the host for the target
 * note's markdown, and the host streams it back via `kbblocks.noteContent`.
 * fire-and-forget postMessage in the webview → host, and a single shared
 * window listener that resolves pending requests by `requestId`. */

import { postMessage } from '../bridge/messageClient';
import { kbLog } from './kbDebug';

/** 嵌入内容结果：`markdown` 为空时 `error` 给出宿主侧原因（★ 2026-09-24 新增，便于定位失败）。 */
export interface IEmbedContentResult {
	markdown: string;
	error?: string;
}

const pending = new Map<string, (r: IEmbedContentResult) => void>();
let installed = false;
let counter = 0;

function install(): void {
	if (installed) return;
	installed = true;
	window.addEventListener('message', (e: MessageEvent) => {
		const msg = e.data;
		if (
			msg &&
			msg.direction === 'toWebview' &&
			msg.type === 'kbblocks.noteContent' &&
			msg.data?.requestId
		) {
			const resolver = pending.get(msg.data.requestId);
			if (resolver) {
				pending.delete(msg.data.requestId);
				const markdown = typeof msg.data.markdown === 'string' ? msg.data.markdown : '';
				const error = typeof msg.data.error === 'string' ? msg.data.error : undefined;
				kbLog('getNoteContent:resp', `id=${msg.data.requestId} len=${markdown.length} error=${error ?? ''}`);
				resolver({ markdown, error });
			}
		}
	});
}

/** 请求目标文件的文本内容（失败/超时 ⇒ markdown=''，error 说明原因）。 */
export function requestNoteContentDetailed(uri: string, heading?: string): Promise<IEmbedContentResult> {
	install();
	const requestId = `emb_${++counter}_${Date.now()}`;
	// 诊断（★ 2026-09-24）：经宿主日志查看「请求了什么 + 拿到了什么」
	// （webview 的 console.* 在发布打包里被 drop，见 kbDebug.ts）。
	kbLog('getNoteContent:req', `uri=${uri} heading=${heading ?? ''} id=${requestId}`);
	return new Promise<IEmbedContentResult>((resolve) => {
		pending.set(requestId, resolve);
		postMessage('kbblocks.getNoteContent', { uri, heading, requestId });
		// Fallback so a hung host never leaves the embed spinning forever.
		window.setTimeout(() => {
			if (pending.has(requestId)) {
				pending.delete(requestId);
				kbLog('getNoteContent:timeout', `8s 未响应 uri=${uri} id=${requestId}`);
				resolve({ markdown: '', error: '宿主 8s 未响应（消息未送达或读取挂起）' });
			}
		}, 8000);
	});
}

/** 兼容旧签名：只要内容（失败 ⇒ 空串）。新代码建议用 `requestNoteContentDetailed` 拿到原因。 */
export function requestNoteContent(uri: string, heading?: string): Promise<string> {
	return requestNoteContentDetailed(uri, heading).then(r => r.markdown);
}
