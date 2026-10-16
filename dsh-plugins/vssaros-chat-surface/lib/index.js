// @vssaros/dsh-chat-surface — host half, intentionally inert.
// The chat-surface binding runs in the browser half (./client): with VsSaros' preload present
// (window.vssarosDsh, surface=chat, sessionId), it switches the UI to the VsSaros-owned session
// via ctx.uiWorkspace.openSession — the web client has no session deep link (无 /session/<id> 路由).
export const name = 'vssaros-chat-surface';

export function apply() {
	// no-op: nothing to do on the Host side. The session is created by VsSaros through the
	// control bridge (`session.start`, @vssaros/dsh-bridge ≥ 0.1.2) before the view loads.
}
