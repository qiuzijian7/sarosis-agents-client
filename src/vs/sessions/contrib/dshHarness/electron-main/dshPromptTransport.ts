/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { request } from 'node:http';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

export const DSH_PROMPT_IPC_CALL = 'vssaros:dsh:prompt-rpc';
export const DSH_PROMPT_IPC_CANCEL = 'vssaros:dsh:prompt-rpc-cancel';
const MAX_PROMPT_BYTES = 300 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface IPromptCookie {
	readonly name: string;
	readonly value: string;
}

export interface IDshPromptTransportOptions {
	readonly origin: () => string | undefined;
	readonly sessionId?: () => string | undefined;
	readonly cookies: (origin: string) => Promise<readonly IPromptCookie[]>;
	readonly timeoutMs?: number;
	readonly stopTimeoutMs?: number;
}

type ChatControlEndpoint = 'session/prompt' | 'session/cancel';

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the transport envelope without changing the Host's prompt or request identity. */
function validatePrompt(id: string, body: string, sessionId: string | undefined): ChatControlEndpoint {
	if (typeof id !== 'string' || !id || id.length > 200 || typeof body !== 'string'
		|| body.length > MAX_PROMPT_BYTES || Buffer.byteLength(body) > MAX_PROMPT_BYTES) {
		throw new Error('dsh prompt: invalid request');
	}
	let packet: unknown;
	try {
		packet = JSON.parse(body);
	} catch {
		throw new Error('dsh prompt: invalid JSON envelope');
	}
	if (!record(packet) || packet.type !== 'client-request' || packet.rpcId !== id
		|| (packet.method !== 'session/prompt' && packet.method !== 'session/cancel')
		|| !record(packet.payload) || !record(packet.payload.args)) {
		throw new Error('dsh prompt: invalid envelope');
	}
	const prompt = packet.payload.args.request;
	if (!record(prompt) || typeof prompt.sessionId !== 'string' || !prompt.sessionId
		|| (sessionId && prompt.sessionId !== sessionId)) {
		throw new Error('dsh prompt: invalid session request');
	}
	if (packet.method === 'session/cancel') {
		if (Buffer.byteLength(body) > 4096 || Object.keys(prompt).some(key => key !== 'sessionId')
			|| Object.keys(packet.payload.args).some(key => key !== 'request')) {
			throw new Error('dsh prompt: invalid stop request');
		}
	} else if (typeof prompt.requestId !== 'string' || !prompt.requestId
		|| (prompt.mode !== 'queue' && prompt.mode !== 'steer') || !Array.isArray(prompt.content)) {
		throw new Error('dsh prompt: invalid session request');
	}
	return packet.method;
}

/** Use a fresh Node socket so Chromium's occupied HTTP pool cannot delay prompt admission. */
function postPrompt(origin: string, endpoint: ChatControlEndpoint, body: string, cookie: string, signal: AbortSignal): Promise<string> {
	const url = new URL(origin);
	if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
		|| url.origin !== origin || url.username || url.password) {
		throw new Error('dsh prompt: expected the current loopback Host');
	}
	return new Promise((resolve, reject) => {
		const req = request(new URL(endpoint === 'session/cancel' ? '/api/session/cancel' : '/api/session/prompt', url), {
			method: 'POST', agent: false, signal,
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), cookie },
		}, res => {
			const chunks: Buffer[] = [];
			let size = 0;
			res.on('error', reject);
			res.on('aborted', () => reject(new Error('dsh prompt: response interrupted')));
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`dsh prompt: HTTP ${res.statusCode}`));
				return;
			}
			res.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_RESPONSE_BYTES) {
					res.destroy(new Error('dsh prompt: response too large'));
					return;
				}
				chunks.push(chunk);
			});
			res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		});
		req.on('error', reject);
		req.end(body);
	});
}

/** Per-view, cancellable transport; the official Host remains the only admission and queue owner. */
export class DshPromptTransport implements IDisposable {
	private readonly pending = new Map<string, { controller: AbortController; endpoint: ChatControlEndpoint }>();
	private disposed = false;

	constructor(private readonly options: IDshPromptTransportOptions) { }

	async call(id: string, body: string): Promise<string> {
		const endpoint = validatePrompt(id, body, this.options.sessionId?.());
		const origin = this.options.origin();
		const count = [...this.pending.values()].filter(entry => entry.endpoint === endpoint).length;
		if (this.disposed || !origin || this.pending.has(id) || count >= (endpoint === 'session/cancel' ? 2 : 4)) {
			throw new Error('dsh prompt: transport unavailable');
		}
		const controller = new AbortController();
		this.pending.set(id, { controller, endpoint });
		const timeoutMs = endpoint === 'session/cancel' ? this.options.stopTimeoutMs ?? 10_000 : this.options.timeoutMs ?? 30_000;
		const timer = setTimeout(() => controller.abort(new Error(endpoint === 'session/cancel'
			? 'dsh stop: request timed out' : 'dsh prompt: admission timed out')), timeoutMs);
		let onAbort!: () => void;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(controller.signal.reason);
			controller.signal.addEventListener('abort', onAbort, { once: true });
		});
		try {
			return await Promise.race([aborted, (async () => {
				const cookies = await this.options.cookies(origin);
				controller.signal.throwIfAborted();
				if (this.options.origin() !== origin) {
					throw new Error('dsh prompt: Host changed during admission');
				}
				const auth = cookies.filter(cookie => cookie.name.startsWith('dsh-auth') && cookie.value);
				if (!auth.length) {
					throw new Error('dsh prompt: authentication required');
				}
				return postPrompt(origin, endpoint, body, auth.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), controller.signal);
			})()]);
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener('abort', onAbort);
			controller.abort();
			this.pending.delete(id);
		}
	}

	cancel(id: string): void {
		this.pending.get(id)?.controller.abort(new Error('dsh prompt: cancelled'));
	}

	cancelAll(): void {
		for (const { controller } of this.pending.values()) {
			controller.abort(new Error('dsh prompt: view released'));
		}
	}

	dispose(): void {
		this.disposed = true;
		this.cancelAll();
	}
}
