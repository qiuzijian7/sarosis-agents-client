/* Bridge for note embeds (`![[note]]`): an embed asks the host for the target
 * note's markdown, and the host streams it back via `kbblocks.noteContent`.
 * fire-and-forget postMessage in the webview → host, and a single shared
 * window listener that resolves pending requests by `requestId`. */

import { postMessage } from '../bridge/messageClient';

const pending = new Map<string, (md: string) => void>();
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
				resolver(typeof msg.data.markdown === 'string' ? msg.data.markdown : '');
			}
		}
	});
}

export function requestNoteContent(uri: string, heading?: string): Promise<string> {
	install();
	const requestId = `emb_${++counter}_${Date.now()}`;
	return new Promise<string>((resolve) => {
		pending.set(requestId, resolve);
		postMessage('kbblocks.getNoteContent', { uri, heading, requestId });
		// Fallback so a hung host never leaves the embed spinning forever.
		window.setTimeout(() => {
			if (pending.has(requestId)) {
				pending.delete(requestId);
				resolve('');
			}
		}, 8000);
	});
}
