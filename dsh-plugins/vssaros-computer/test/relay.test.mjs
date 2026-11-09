#!/usr/bin/env node
// 发现文件校验 + loopback WS 客户端（假 WebSocket，不联网、不依赖主进程）。
import assert from 'node:assert/strict';
import {
	DesktopRelayClient, ENDPOINT_FILE, ENDPOINT_PATH, parseEndpoint, readEndpoint,
} from '../lib/core/relay.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};

const TOKEN = 'a'.repeat(48);
const endpoint = (extra = {}) => JSON.stringify({
	version: 1, wsUrl: `ws://127.0.0.1:54321${ENDPOINT_PATH}${TOKEN}`,
	pid: process.pid, startedAt: '2026-11-09T00:00:00.000Z', ...extra,
});

/** 最小假 WebSocket：open 异步触发，send 同步回一个 result。 */
class FakeSocket {
	static instances = [];
	static answer = (request) => ({ ok: true, method: request.method });
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		this.sent = [];
		this.listeners = new Map();
		FakeSocket.instances.push(this);
		setTimeout(() => {
			this.readyState = 1;
			this._emit('open', undefined);
		}, 0);
	}
	addEventListener(type, fn) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(fn);
	}
	_emit(type, data) { for (const fn of this.listeners.get(type) ?? []) fn({ data }); }
	send(text) {
		const request = JSON.parse(text);
		this.sent.push(request);
		if (FakeSocket.silent) return;
		this._emit('message', JSON.stringify(FakeSocket.answer(request)));
	}
	close() { this.readyState = 3; }
}

const clientFor = (options = {}) => new DesktopRelayClient({
	endpointPath: '/fake/desktop-control.json',
	WebSocketImpl: FakeSocket,
	isPidAlive: () => true,
	read: () => endpoint(),
	timeoutMs: 200,
	...options,
});

await checkAsync('常量与 TS 侧对账', async () => {
	assert.equal(ENDPOINT_FILE, 'desktop-control.json');
	assert.equal(ENDPOINT_PATH, '/desktop-control/vssaros/');
});

await checkAsync('parseEndpoint：合法端点通过；坏 JSON / 版本 / pid / wsUrl 全拒', async () => {
	assert.equal(parseEndpoint(endpoint(), { isPidAlive: () => true }).ok, true);
	assert.equal(parseEndpoint('nope', { isPidAlive: () => true }).ok, false);
	assert.equal(parseEndpoint('{"version":2}', { isPidAlive: () => true }).ok, false);
	assert.equal(parseEndpoint(endpoint(), { isPidAlive: () => false }).ok, false);
	assert.equal(parseEndpoint(endpoint({ wsUrl: 'ws://evil.example/x' }), { isPidAlive: () => true }).ok, false);
	assert.equal(parseEndpoint(endpoint({ wsUrl: 'ws://127.0.0.1:9000/desktop-control/vssaros/short' }), { isPidAlive: () => true }).ok, false);
});

await checkAsync('readEndpoint：读文件失败给可读错误，不抛', async () => {
	const found = readEndpoint('/x', { read: () => { throw new Error('ENOENT'); }, isPidAlive: () => true });
	assert.equal(found.ok, false);
	assert.match(found.error, /读不到发现文件/);
});

await checkAsync('command：JSON-RPC 往返，token 路径带上，响应按 id 归位', async () => {
	FakeSocket.silent = false;
	FakeSocket.answer = (request) => ({ id: request.id, result: { method: request.method, echo: request.params } });
	const client = clientFor();
	const result = await client.command('getScreenSize', { probe: 1 });
	assert.deepEqual(result, { method: 'getScreenSize', echo: { probe: 1 } });
	const socket = FakeSocket.instances.at(-1);
	assert.equal(socket.url, `ws://127.0.0.1:54321${ENDPOINT_PATH}${TOKEN}`);
	assert.deepEqual(socket.sent[0], { id: 1, method: 'getScreenSize', params: { probe: 1 } });
	// 复用同一连接
	await client.command('getVersion');
	assert.equal(socket.sent.length, 2);
	client.dispose();
});

await checkAsync('command：中继返回 error 时带上 code', async () => {
	FakeSocket.answer = (request) => ({ id: request.id, error: { code: -32601, message: 'P0 只读层不开放' } });
	const client = clientFor();
	await assert.rejects(() => client.command('click'), (error) => {
		assert.equal(error.code, -32601);
		assert.match(error.message, /P0 只读层/);
		return true;
	});
	client.dispose();
});

await checkAsync('command：无响应超时后 reject（不挂住回合）', async () => {
	FakeSocket.silent = true;
	const client = clientFor({ timeoutMs: 20 });
	await assert.rejects(() => client.command('screenshot'), /超时/);
	client.dispose();
	FakeSocket.silent = false;
});

await checkAsync('dispose：拒绝在途请求、关掉 socket、之后不再连', async () => {
	FakeSocket.silent = true;
	const client = clientFor({ timeoutMs: 500 });
	const pending = client.command('screenshot');
	await new Promise((resolve) => setTimeout(resolve, 5));
	client.dispose();
	await assert.rejects(() => pending, /已释放/);
	await assert.rejects(() => client.command('getVersion'), /已释放/);
	FakeSocket.silent = false;
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
