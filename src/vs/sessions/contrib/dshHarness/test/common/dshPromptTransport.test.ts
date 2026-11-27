/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Agent, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { DSH_PROMPT_IPC_CALL, DSH_PROMPT_IPC_CANCEL, DshPromptTransport } from '../../electron-main/dshPromptTransport.js';

function packet(id = 'rpc-1', mode = 'queue') {
	return JSON.stringify({
		type: 'client-request', rpcId: id, method: 'session/prompt',
		payload: { args: { request: {
			requestId: 'submission-1', sessionId: 'session-1', mode,
			content: [{ type: 'text', text: 'next message' }], clientTimeZone: 'Asia/Shanghai',
		} } },
	});
}

function stopPacket(id = 'stop-1', sessionId = 'session-1') {
	return JSON.stringify({ type: 'client-request', rpcId: id, method: 'session/cancel', payload: { args: { request: { sessionId } } } });
}

suite('DshPromptTransport', () => {
	const transports: DshPromptTransport[] = [];
	teardown(() => { for (const transport of transports.splice(0)) { transport.dispose(); } });

	function fixture(options: Partial<ConstructorParameters<typeof DshPromptTransport>[0]> = {}) {
		const transport = new DshPromptTransport({
			origin: () => 'http://127.0.0.1:3080',
			cookies: async () => [{ name: 'dsh-auth-test', value: 'owner-cookie' }],
			...options,
		});
		transports.push(transport);
		return transport;
	}

	test('queue admission bypasses six occupied HTTP sockets without waiting for the running turn', async () => {
		let blocked = 0;
		let allBlocked!: () => void;
		const ready = new Promise<void>(resolve => { allBlocked = resolve; });
		const observed: { body: string; cookie: string | undefined; path: string | undefined }[] = [];
		const server = createServer(async (req, res) => {
			if (req.url === '/running') {
				if (++blocked === 6) { allBlocked(); }
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) { chunks.push(chunk); }
			const body = Buffer.concat(chunks).toString('utf8');
			observed.push({ body, cookie: req.headers.cookie, path: req.url });
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId, result: { ok: true, value: { accepted: true } } }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const agent = new Agent({ keepAlive: true, maxSockets: 6 });
		try {
			for (let i = 0; i < 6; i++) {
				request(`${origin}/running`, { agent }).on('error', () => {}).end();
			}
			await ready;
			request(`${origin}/api/session/prompt`, { agent, method: 'POST' }).on('error', () => {}).end(packet('blocked-rpc'));
			const transport = fixture({ origin: () => origin, timeoutMs: 2000,
				cookies: async () => [{ name: 'other-cookie', value: 'private' }, { name: 'dsh-auth-test', value: 'owner-cookie' }],
			});
			const response = JSON.parse(await transport.call('rpc-1', packet()));
			assert.deepStrictEqual({ blocked, observed, response }, {
				blocked: 6,
				observed: [{ body: packet(), cookie: 'dsh-auth-test=owner-cookie', path: '/api/session/prompt' }],
				response: { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { accepted: true } } },
			});
		} finally {
			agent.destroy();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('stop retains a reserved socket and quota when every prompt admission is stuck', async () => {
		const seen: string[] = [];
		const server = createServer(async (req, res) => {
			seen.push(req.url ?? '');
			if (req.url !== '/api/session/cancel') { return; }
			const chunks: Buffer[] = [];
			for await (const chunk of req) { chunks.push(chunk); }
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const transport = fixture({ origin: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
		const pending = Array.from({ length: 4 }, (_, i) => transport.call(`rpc-${i}`, packet(`rpc-${i}`)).catch(() => undefined));
		try {
			await assert.rejects(transport.call('overflow', packet('overflow')), /unavailable/);
			const reply = JSON.parse(await transport.call('stop-1', stopPacket()));
			assert.deepStrictEqual({ stopReachedHost: seen.includes('/api/session/cancel'), reply }, {
				stopReachedHost: true, reply: { type: 'server-response', rpcId: 'stop-1', result: { ok: true, value: { accepted: true } } },
			});
		} finally {
			transport.dispose();
			await Promise.all(pending);
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('a stuck stop expires independently of the prompt deadline and remains retryable', async () => {
		const transport = fixture({ stopTimeoutMs: 10, cookies: () => new Promise(() => {}) });
		await assert.rejects(transport.call('stop-1', stopPacket()), /stop: request timed out/);
		await assert.rejects(transport.call('stop-1', stopPacket()), /stop: request timed out/);
	});

	test('stop refuses cross-session requests, extra fields and non-whitelisted endpoints', async () => {
		let reads = 0;
		const transport = fixture({ sessionId: () => 'session-1', cookies: async () => { reads++; return []; } });
		const extra = JSON.parse(stopPacket());
		extra.payload.args.request.force = true;
		for (const body of [stopPacket('stop-1', 'session-2'), JSON.stringify(extra), stopPacket().replace('session/cancel', 'session/delete')]) {
			await assert.rejects(transport.call('stop-1', body), /invalid/);
		}
		assert.strictEqual(reads, 0);
	});

	test('a stuck cookie lookup times out and releases the in-flight request id', async () => {
		const transport = fixture({ timeoutMs: 10, cookies: () => new Promise(() => {}) });
		await assert.rejects(transport.call('rpc-1', packet()), /admission timed out/);
		await assert.rejects(transport.call('rpc-1', packet()), /admission timed out/);
	});

	test('cancel and dispose settle pending work without submitting after a late cookie lookup', async () => {
		let resolve!: (cookies: { name: string; value: string }[]) => void;
		const transport = fixture({ cookies: () => new Promise(done => { resolve = done; }) });
		const pending = transport.call('rpc-1', packet());
		transport.cancel('rpc-1');
		await assert.rejects(pending, /cancelled/);
		resolve([{ name: 'dsh-auth-test', value: 'owner-cookie' }]);
		const next = transport.call('rpc-2', packet('rpc-2'));
		transport.dispose();
		await assert.rejects(next, /view released/);
		await assert.rejects(transport.call('rpc-3', packet('rpc-3')), /transport unavailable/);
	});

	test('rejects other methods, mismatched transport ids and cross-session prompts before authentication', async () => {
		let cookieReads = 0;
		const transport = fixture({ sessionId: () => 'session-1', cookies: async () => { cookieReads++; return []; } });
		for (const body of [packet().replace('session/prompt', 'session/cancel'), packet('another-rpc'), packet().replace('session-1', 'session-2'), packet('rpc-1', 'invalid')]) {
			await assert.rejects(transport.call('rpc-1', body), /invalid/);
		}
		assert.strictEqual(cookieReads, 0);
	});

	test('requires an existing auth cookie and refuses a changed Host', async () => {
		await assert.rejects(fixture({ cookies: async () => [] }).call('rpc-1', packet()), /authentication required/);
		let origin = 'http://127.0.0.1:3080';
		const transport = fixture({ origin: () => origin, cookies: async () => { origin = 'http://127.0.0.1:3081'; return []; } });
		await assert.rejects(transport.call('rpc-1', packet()), /Host changed/);
	});

	test('refuses non-loopback origins instead of forwarding the owner cookie', async () => {
		for (const origin of ['http://example.com', 'https://127.0.0.1', 'http://user@127.0.0.1:3080', 'http://127.0.0.1:3080/other']) {
			await assert.rejects(fixture({ origin: () => origin }).call('rpc-1', packet()), /loopback Host/);
		}
	});

	test('the packaged preload and per-view handler wire the same restricted transport channels', () => {
		const root = 'src/vs/sessions/contrib/dshHarness/';
		const preload = readFileSync(`${root}electron-browser/preload-dshView.ts`, 'utf8');
		const host = readFileSync(`${root}electron-main/dshViewHost.ts`, 'utf8');
		assert.ok(preload.includes(`ipcRenderer.invoke('${DSH_PROMPT_IPC_CALL}', id, body)`));
		assert.ok(preload.includes(`ipcRenderer.send('${DSH_PROMPT_IPC_CANCEL}', id)`));
		assert.match(host, /wc\.ipc\.handle\(DSH_PROMPT_IPC_CALL,[\s\S]*?_isTrustedSender\(event\)/);
		assert.match(host, /slot\.promptTransport\?\.dispose\(\)/);
	});
});
