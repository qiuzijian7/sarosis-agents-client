/*---------------------------------------------------------------------------------------------
 *  ConfigMD Bridge
 *
 *  Routes Host → Webview push events (configmd.sourceChanged, configmd.htmlRendered,
 *  configmd.command) to the corresponding agent panel, and forwards iframe messages
 *  (HTML view → agent) to the host via sendRequest.
 *
 *  An iframe embedded in the panel uses the agent-configmd-sdk.js to communicate
 *  with this bridge through the parent window's postMessage channel.
 *--------------------------------------------------------------------------------------------*/

import { sendRequest } from '../../bridge/messageClient';

export type ConfigMdChangeOrigin = 'editor' | 'html' | 'model' | 'external';

export interface ConfigMdSourceChangedEvent {
	employeeId: string;
	markdown: string;
	version: number;
	origin: ConfigMdChangeOrigin;
}

export interface ConfigMdHtmlRenderedEvent {
	employeeId: string;
	html: string;
	version: number;
	stylesContent?: string;
}

export interface ConfigMdCommand {
	name: string;
	params: Record<string, unknown>;
	id: string;
}

export interface ConfigMdCommandEvent {
	employeeId: string;
	command: ConfigMdCommand;
}

type Listener<T> = (data: T) => void;

const sourceListeners = new Map<string, Set<Listener<ConfigMdSourceChangedEvent>>>();
const htmlListeners = new Map<string, Set<Listener<ConfigMdHtmlRenderedEvent>>>();
const commandListeners = new Map<string, Set<Listener<ConfigMdCommand>>>();

function add<T>(map: Map<string, Set<Listener<T>>>, employeeId: string, fn: Listener<T>): () => void {
	let set = map.get(employeeId);
	if (!set) {
		set = new Set();
		map.set(employeeId, set);
	}
	set.add(fn);
	return () => {
		set!.delete(fn);
		if (set!.size === 0) { map.delete(employeeId); }
	};
}

export function onSourceChanged(employeeId: string, fn: Listener<ConfigMdSourceChangedEvent>) {
	return add(sourceListeners, employeeId, fn);
}

export function onHtmlRendered(employeeId: string, fn: Listener<ConfigMdHtmlRenderedEvent>) {
	return add(htmlListeners, employeeId, fn);
}

export function onCommand(employeeId: string, fn: Listener<ConfigMdCommand>) {
	return add(commandListeners, employeeId, fn);
}

/**
 * Called by index.tsx when host pushes configmd.sourceChanged / htmlRendered / command events.
 */
export function dispatchConfigMdEvent(employeeId: string, type: string, data: unknown): void {
	switch (type) {
		case 'configmd.sourceChanged': {
			const evt = data as ConfigMdSourceChangedEvent;
			sourceListeners.get(employeeId)?.forEach(fn => fn(evt));
			break;
		}
		case 'configmd.htmlRendered': {
			const evt = data as ConfigMdHtmlRenderedEvent;
			htmlListeners.get(employeeId)?.forEach(fn => fn(evt));
			break;
		}
		case 'configmd.command': {
			const evt = data as ConfigMdCommandEvent;
			commandListeners.get(employeeId)?.forEach(fn => fn(evt.command));
			break;
		}
		default:
			break;
	}
}

// ─── RPC helpers ─────────────────────────────────────────────────────────────

export async function fetchState(employeeId: string): Promise<{
	markdown: string; html: string; version: number; stylesContent?: string;
} | null> {
	const r = await sendRequest('configmd.getResource', { employeeId });
	return r as any;
}

export async function readSource(employeeId: string): Promise<{ markdown: string; version: number }> {
	const r = await sendRequest('configmd.readSource', { employeeId });
	return r as any;
}

export async function writeSource(
	employeeId: string,
	markdown: string,
	options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
): Promise<{ version: number }> {
	const r = await sendRequest('configmd.writeSource', {
		employeeId,
		markdown,
		origin: options?.origin,
		baseVersion: options?.baseVersion,
	});
	return r as any;
}

export interface PatchOp {
	op: 'replace-anchor' | 'replace-bind' | 'append' | 'prepend' | 'replace-section' | 'replace-all';
	anchor?: string;
	heading?: string;
	content: string;
}

export async function applyPatch(
	employeeId: string,
	patches: PatchOp[],
	options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
): Promise<{ version: number; markdown: string }> {
	const r = await sendRequest('configmd.applyPatch', {
		employeeId,
		patches,
		origin: options?.origin,
		baseVersion: options?.baseVersion,
	});
	return r as any;
}

export async function renderHtml(employeeId: string, markdown?: string): Promise<{ html: string; version: number }> {
	const r = await sendRequest('configmd.renderHtml', { employeeId, markdown });
	return r as any;
}

export async function fireHtmlEvent(
	employeeId: string,
	eventName: string,
	payload?: unknown,
	agentSessionId?: string,
): Promise<void> {
	await sendRequest('configmd.event', { employeeId, eventName, payload, agentSessionId }, 0);
}

export async function chatSend(
	employeeId: string,
	message: string,
	options?: { context?: string; showInChat?: boolean; agentSessionId?: string },
): Promise<unknown> {
	return sendRequest('configmd.chatSend', { employeeId, message, ...options }, 0);
}

// ─── iframe ↔ panel postMessage relay ────────────────────────────────────────

export type IframeRequest =
	| { type: 'sdk.ready'; requestId?: string }
	| { type: 'sdk.event'; requestId?: string; eventName: string; payload?: unknown }
	| { type: 'sdk.chatSend'; requestId?: string; message: string; context?: string; showInChat?: boolean }
	| { type: 'sdk.readMd'; requestId?: string }
	| { type: 'sdk.writeMd'; requestId?: string; markdown: string }
	| { type: 'sdk.applyPatch'; requestId?: string; patches: PatchOp[] }
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
	employeeId: string,
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
					reply(true, { employeeId });
					break;
				case 'sdk.event':
					await fireHtmlEvent(employeeId, msg.eventName, msg.payload);
					reply(true);
					break;
				case 'sdk.chatSend':
					await chatSend(employeeId, msg.message, {
						context: msg.context,
						showInChat: msg.showInChat,
					});
					reply(true);
					break;
				case 'sdk.readMd': {
					const r = await readSource(employeeId);
					reply(true, r);
					break;
				}
				case 'sdk.writeMd':
					await writeSource(employeeId, msg.markdown, { origin: 'html' });
					reply(true);
					break;
				case 'sdk.applyPatch': {
					const r = await applyPatch(employeeId, msg.patches, { origin: 'html' });
					reply(true, r);
					break;
				}
				case 'sdk.notify':
					await sendRequest('configmd.notify', {
						employeeId,
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
export function postCommandToIframe(iframe: HTMLIFrameElement | null, command: ConfigMdCommand): void {
	if (!iframe?.contentWindow) { return; }
	iframe.contentWindow.postMessage({ type: 'host.command', command }, '*');
}

/** Push a content/state update into the iframe (when MD/HTML changes). */
export function postSyncToIframe(
	iframe: HTMLIFrameElement | null,
	payload: { markdown?: string; version: number; origin: ConfigMdChangeOrigin },
): void {
	if (!iframe?.contentWindow) { return; }
	iframe.contentWindow.postMessage({ type: 'host.sync', ...payload }, '*');
}
