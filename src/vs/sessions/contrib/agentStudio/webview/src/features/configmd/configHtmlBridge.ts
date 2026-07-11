/*---------------------------------------------------------------------------------------------
 *  ConfigHtml Bridge
 *
 *  Routes Host → Webview push events (confightml.htmlRendered, confightml.command,
 *  confightml.error) to the corresponding agent panel, and forwards iframe messages
 *  (HTML view → agent) to the host via sendRequest.
 *
 *  An iframe embedded in the panel uses an injected `AgentConfigHtml` SDK (see
 *  `SDK_INLINE`) to communicate with this bridge through the parent window's
 *  postMessage channel.
 *--------------------------------------------------------------------------------------------*/

import { sendRequest } from '../../bridge/messageClient';

export type ConfigHtmlChangeOrigin = 'editor' | 'html' | 'model' | 'external';

export interface ConfigHtmlHtmlRenderedEvent {
	agentId: string;
	html: string;
	version: number;
	stylesContent?: string;
}

export interface ConfigHtmlCommand {
	name: string;
	params: Record<string, unknown>;
	id: string;
}

export interface ConfigHtmlCommandEvent {
	agentId: string;
	command: ConfigHtmlCommand;
}

type Listener<T> = (data: T) => void;

const htmlListeners = new Map<string, Set<Listener<ConfigHtmlHtmlRenderedEvent>>>();
const commandListeners = new Map<string, Set<Listener<ConfigHtmlCommand>>>();

function add<T>(map: Map<string, Set<Listener<T>>>, agentId: string, fn: Listener<T>): () => void {
	let set = map.get(agentId);
	if (!set) {
		set = new Set();
		map.set(agentId, set);
	}
	set.add(fn);
	return () => {
		set!.delete(fn);
		if (set!.size === 0) { map.delete(agentId); }
	};
}

export function onHtmlRendered(agentId: string, fn: Listener<ConfigHtmlHtmlRenderedEvent>) {
	return add(htmlListeners, agentId, fn);
}

export function onCommand(agentId: string, fn: Listener<ConfigHtmlCommand>) {
	return add(commandListeners, agentId, fn);
}

/**
 * Called by index.tsx when host pushes confightml.htmlRendered / command / error events.
 */
export function dispatchConfigHtmlEvent(agentId: string, type: string, data: unknown): void {
	switch (type) {
		case 'confightml.htmlRendered': {
			const evt = data as ConfigHtmlHtmlRenderedEvent;
			htmlListeners.get(agentId)?.forEach(fn => fn(evt));
			break;
		}
		case 'confightml.command': {
			const evt = data as ConfigHtmlCommandEvent;
			commandListeners.get(agentId)?.forEach(fn => fn(evt.command));
			break;
		}
		default:
			break;
	}
}

// ─── RPC helpers ─────────────────────────────────────────────────────────────

/**
 * Read the agent's current `config.html` content (+ version) from the host.
 */
export async function getHtml(agentId: string): Promise<{ html: string; version: number }> {
	const r = await sendRequest('confightml.getHtml', { agentId });
	return r as { html: string; version: number };
}

/**
 * Persist new `config.html` content to disk. Optimistic concurrency via baseVersion.
 */
export async function writeHtml(
	agentId: string,
	html: string,
	options?: { origin?: ConfigHtmlChangeOrigin; baseVersion?: number },
): Promise<{ version: number }> {
	const r = await sendRequest('confightml.writeHtml', {
		agentId,
		html,
		origin: options?.origin,
		baseVersion: options?.baseVersion,
	});
	return r as { version: number };
}

/**
 * Render the current HTML into a complete standalone document, write it to
 * `<agentDir>/.preview.html` on disk, and return the absolute path so the
 * caller can open it in the host editor.
 */
export async function previewToFile(agentId: string): Promise<{ path: string; version: number }> {
	const r = await sendRequest('confightml.previewToFile', { agentId });
	return r as { path: string; version: number };
}

/**
 * ConfigHtml AI box: ask the model (with the `confightml` skill activated and a
 * dedicated system prompt) to generate a full self-contained HTML document.
 * Returns the extracted HTML string plus the raw reply.
 */
export async function htmlGenerate(
	agentId: string,
	message: string,
	options?: { currentHtml?: string; model?: string },
): Promise<{ html: string; raw: string }> {
	const r = await sendRequest(
		'confightml.htmlGenerate',
		{ agentId, message, currentHtml: options?.currentHtml, model: options?.model },
		0, // no timeout: model generation can take a while
	);
	return r as { html: string; raw: string };
}

export async function fireHtmlEvent(
	agentId: string,
	eventName: string,
	payload?: unknown,
	agentSessionId?: string,
): Promise<void> {
	await sendRequest('confightml.event', { agentId, eventName, payload, agentSessionId }, 0);
}

export async function chatSend(
	agentId: string,
	message: string,
	options?: { context?: string; showInChat?: boolean; agentSessionId?: string },
): Promise<unknown> {
	return sendRequest('confightml.chatSend', { agentId, message, ...options }, 0);
}

// ─── iframe ↔ panel postMessage relay ────────────────────────────────────────

export type IframeRequest =
	| { type: 'sdk.ready'; requestId?: string }
	| { type: 'sdk.event'; requestId?: string; eventName: string; payload?: unknown }
	| { type: 'sdk.chatSend'; requestId?: string; message: string; context?: string; showInChat?: boolean }
	| { type: 'sdk.notify'; requestId?: string; message: string; level?: 'info' | 'success' | 'warning' | 'error' };

export interface IframeReply {
	requestId?: string;
	type: 'sdk.reply';
	ok: boolean;
	data?: unknown;
	error?: string;
}

/**
 * Bind a panel-side handler that listens for iframe sdk requests and forwards them.
 * Returns an unbinder.
 */
export function bindIframeChannel(
	iframe: HTMLIFrameElement,
	agentId: string,
	onConnected?: () => void,
): () => void {
	const handler = async (event: MessageEvent) => {
		// Filter for our iframe
		if (event.source !== iframe.contentWindow) { return; }
		const msg = event.data as IframeRequest | undefined;
		if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('sdk.')) { return; }

		const reply = (ok: boolean, data?: unknown, error?: string) => {
			const r: IframeReply = { requestId: msg.requestId, type: 'sdk.reply', ok, data, error };
			iframe.contentWindow?.postMessage(r, '*');
		};

		try {
			switch (msg.type) {
				case 'sdk.ready':
					onConnected?.();
					reply(true, { agentId });
					break;
				case 'sdk.event':
					await fireHtmlEvent(agentId, msg.eventName, msg.payload);
					reply(true);
					break;
				case 'sdk.chatSend':
					await chatSend(agentId, msg.message, {
						context: msg.context,
						showInChat: msg.showInChat,
					});
					reply(true);
					break;
				case 'sdk.notify':
					await sendRequest('confightml.notify', {
						agentId,
						message: msg.message,
						level: msg.level,
					});
					reply(true);
					break;
				default:
					reply(false, undefined, `Unknown sdk request: ${(msg as { type: string }).type}`);
			}
		} catch (err) {
			reply(false, undefined, err instanceof Error ? err.message : String(err));
		}
	};

	window.addEventListener('message', handler);
	return () => window.removeEventListener('message', handler);
}

/** Push a model-issued command into the iframe. */
export function postCommandToIframe(iframe: HTMLIFrameElement | null, command: ConfigHtmlCommand): void {
	if (!iframe?.contentWindow) { return; }
	iframe.contentWindow.postMessage({ type: 'host.command', command }, '*');
}
