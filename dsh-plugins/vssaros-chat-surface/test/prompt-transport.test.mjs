/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const source = readFileSync(new URL('../lib/client.promptTransport.js', import.meta.url), 'utf8');
const payload = mode => ({ args: { request: {
	requestId: 'submission-1', sessionId: 'session-1', mode,
	content: [{ type: 'text', text: 'next message' }], clientTimeZone: 'Asia/Shanghai',
} } });
const receipt = (id, result = { ok: true, value: { accepted: true } }) => JSON.stringify({ type: 'server-response', rpcId: id, result });

function fixture(bridge, timers = { setTimeout, clearTimeout }) {
	let definition;
	const window = { crypto: { randomUUID }, vssarosDshPrompt: bridge, __ModuleLoader__: { load(value) { definition = value; } } };
	new Function('window', 'setTimeout', 'clearTimeout', source)(window, timers.setTimeout, timers.clearTimeout);
	const module = definition.factory();
	const states = [];
	const rpc = { call() { throw new Error('the occupied HTTP pool must not be used'); } };
	return { module, states, rpc, call: module.__test.createPromptRpcCall(rpc, rpc.call, bridge, phase => states.push(phase)) };
}

test('queue and steer use the independent carrier while retaining the Host request identity and receipt', async () => {
	const sent = [];
	const f = fixture({ call: async (id, body) => { sent.push(JSON.parse(body)); return receipt(id); }, cancel() {} });
	for (const mode of ['queue', 'steer']) {
		assert.deepEqual(await f.call('/api', 'session/prompt', payload(mode)), { ok: true, value: { accepted: true } });
	}
	assert.deepEqual(sent.map(packet => ({ method: packet.method, payload: packet.payload })), ['queue', 'steer'].map(mode => ({ method: 'session/prompt', payload: payload(mode) })));
	assert.deepEqual(f.states, ['sending', 'accepted', 'sending', 'accepted']);
});

test('a prompt is not accepted optimistically while its Host receipt is pending', async () => {
	let accept;
	const f = fixture({ call: (id) => new Promise(resolve => { accept = () => resolve(receipt(id)); }), cancel() {} });
	const pending = f.call('/api', 'session/prompt', payload('queue'));
	assert.deepEqual(f.states, ['sending']);
	accept();
	await pending;
	assert.deepEqual(f.states, ['sending', 'accepted']);
});

test('Host refusal remains a business failure and does not become a queued message', async () => {
	const result = { ok: false, error: { code: 'session/not-found', message: 'missing', details: {} } };
	const f = fixture({ call: async id => receipt(id, result), cancel() {} });
	assert.deepEqual(await f.call('/api', 'session/prompt', payload('queue')), result);
	assert.deepEqual(f.states, ['sending', 'rejected']);
});

test('other Remote calls retain their original carrier and receiver', async () => {
	const calls = [];
	const rpc = { call(...args) { assert.equal(this, rpc); calls.push(args); return 'original'; } };
	const f = fixture({ call() { throw new Error('not a prompt'); }, cancel() {} });
	const call = f.module.__test.createPromptRpcCall(rpc, rpc.call, {});
	assert.equal(await call('/api', 'session/cancel', {}), 'original');
	assert.equal(await call('/other', 'session/prompt', {}), 'original');
	assert.equal(calls.length, 2);
});

test('stop uses its independent carrier and reports failure without acknowledging success', async () => {
	const calls = [], states = [];
	const result = { ok: false, error: { code: 'session/not-found', message: 'not attached', details: {} } };
	const f = fixture({ version: 2, call: async (id, body) => { calls.push(JSON.parse(body)); return receipt(id, result); }, cancel() {} });
	const call = f.module.__test.createPromptRpcCall(f.rpc, f.rpc.call, { version: 2, call: async id => receipt(id, result), cancel() {} }, (phase, meta) => states.push({ phase, ...meta }));
	const data = { args: { request: { sessionId: 'session-1' } } };
	assert.deepEqual(await f.call('/api', 'session/cancel', data), result);
	assert.equal(calls[0].method, 'session/cancel');
	assert.deepEqual(await call('/api', 'session/cancel', data), result);
	assert.deepEqual(states, [{ phase: 'stopping', endpoint: 'session/cancel', sessionId: 'session-1' },
		{ phase: 'rejected', endpoint: 'session/cancel', sessionId: 'session-1', error: 'not attached' }]);
});

test('a hung stop is cancelled after its shorter deadline and releases the retry state', async () => {
	let timeout;
	let cancelled = 0;
	const f = fixture({ version: 2, call: () => new Promise(() => {}), cancel() { cancelled++; } }, {
		setTimeout(fn, ms) { assert.equal(ms, 12000); timeout = fn; return 1; }, clearTimeout() {},
	});
	const pending = f.call('/api', 'session/cancel', { args: { request: { sessionId: 'session-1' } } });
	timeout();
	await assert.rejects(pending, /停止请求超时/);
	assert.deepEqual({ cancelled, states: f.states }, { cancelled: 1, states: ['stopping', 'failed'] });
});

test('repeated stop clicks share one pending receipt and can retry after completion', async () => {
	let resolve, sent = 0;
	const f = fixture({ version: 2, call: id => { sent++; return new Promise(done => { resolve = () => done(receipt(id)); }); }, cancel() {} });
	const data = { args: { request: { sessionId: 'session-1' } } };
	const first = f.call('/api', 'session/cancel', data);
	const duplicate = f.call('/api', 'session/cancel', data);
	assert.equal(first, duplicate);
	assert.equal(sent, 1);
	resolve(); await first;
	const next = f.call('/api', 'session/cancel', data);
	assert.equal(sent, 2);
	resolve(); await next;
});

test('cancellation releases sending immediately and ignores a late Host receipt', async () => {
	let late;
	const cancelled = [];
	const f = fixture({ call: id => new Promise(resolve => { late = () => resolve(receipt(id)); }), cancel: id => cancelled.push(id) });
	const controller = new AbortController();
	const pending = f.call('/api', 'session/prompt', payload('queue'), controller.signal);
	controller.abort(new Error('user cancelled'));
	await assert.rejects(pending, /user cancelled/);
	late();
	await Promise.resolve();
	assert.deepEqual({ cancelled: cancelled.length, states: f.states }, { cancelled: 1, states: ['sending', 'failed'] });
});

test('an already-cancelled submission never reaches the Host', async () => {
	let sent = 0;
	const f = fixture({ call() { sent++; }, cancel() {} });
	const controller = new AbortController();
	controller.abort(new Error('cancelled'));
	await assert.rejects(f.call('/api', 'session/prompt', payload('queue'), controller.signal), /cancelled/);
	assert.equal(sent, 0);
});

test('a stuck IPC call is bounded, cancelled, and not retried through the occupied HTTP pool', async () => {
	let timeout;
	let cleared = 0;
	let cancelled = 0;
	const f = fixture({ call: () => new Promise(() => {}), cancel() { cancelled++; } }, {
		setTimeout(fn, ms) { assert.equal(ms, 35000); timeout = fn; return 1; }, clearTimeout() { cleared++; },
	});
	const pending = f.call('/api', 'session/prompt', payload('queue'));
	timeout();
	await assert.rejects(pending, /admission timed out/);
	assert.deepEqual({ cleared, cancelled, states: f.states }, { cleared: 1, cancelled: 1, states: ['sending', 'failed'] });
});

test('malformed or mismatched receipts cannot acknowledge the composer', async () => {
	for (const reply of ['invalid-json', receipt('another-rpc'), '{}']) {
		const f = fixture({ call: async () => reply, cancel() {} });
		await assert.rejects(f.call('/api', 'session/prompt', payload('queue')));
		assert.deepEqual(f.states, ['sending', 'failed']);
	}
});

test('installation is idempotent and teardown restores the original carrier and cancels pending work', async () => {
	const cancelled = [];
	const f = fixture({ call: () => new Promise(() => {}), cancel: id => cancelled.push(id) });
	const original = f.rpc.call;
	const cleanups = [];
	const ctx = { get: () => ({ rpc: f.rpc }), effect: fn => cleanups.push(fn()) };
	f.module.install(ctx, { state: {} });
	f.module.install(ctx, { state: {} });
	assert.equal(cleanups.length, 1);
	const pending = f.rpc.call('/api', 'session/prompt', payload('queue'));
	cleanups[0]();
	await assert.rejects(pending, /client released/);
	assert.equal(f.rpc.call, original);
	assert.equal(cancelled.length, 1);
});

test('browser-only and older hosts remain on the official carrier', () => {
	const f = fixture(undefined);
	const original = f.rpc.call;
	f.module.install({ get: () => ({ rpc: f.rpc }), effect() { throw new Error('unexpected patch'); } }, {});
	assert.equal(f.rpc.call, original);
});

test('the transport is shipped and loaded independently of the other UI chunks', () => {
	const entry = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.ok(manifest.files.includes('lib/client.promptTransport.js'));
	assert.match(entry, /const ALWAYS_CHUNKS = \[[^\]]*"\.\/client\.promptTransport\.js"/);
	assert.match(entry, /Promise\.resolve\(\)\.then\(\(\) => require\.async\("\.\/client\.promptTransport\.js"\)\)/);
	assert.match(entry, /ALWAYS_CHUNKS\.filter\(p => p !== "\.\/client\.promptTransport\.js"\)/);
});
