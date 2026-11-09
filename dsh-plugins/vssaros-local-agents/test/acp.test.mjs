#!/usr/bin/env node
// P1：ACP / JSON-RPC / 回环 MCP / 多轮状态机 / 审批 fail-closed。
// 用**真实 loopback HTTP server** 验证工具桥闭环；ACP 引擎用内存替身，不装任何真实 CLI。
import assert from 'node:assert/strict';
import { EventQueue } from '../lib/core/queue.js';
import { JsonRpcPeer } from '../lib/core/jsonrpc.js';
import { APPROVE_TOOL, LoopbackMcp, flattenSchema } from '../lib/core/mcp.js';
import { createAcpAdapter, parseDecision, pickAllowOption } from '../lib/core/acpAdapter.js';
import { createApprovalRequester, createApproveToolDefinition } from '../lib/core/approval.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error?.message ?? error}`); }
};
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const drainAll = async (iterable) => { const out = []; for await (const chunk of iterable) out.push(chunk); return out; };
const msg = (role, text, extra = {}) => ({ role, content: [{ type: 'text', text }], ...extra });

class FakeEngine {
	constructor() {
		this.queue = new EventQueue();
		this.prompts = [];
		this.answers = [];
		this.cancelled = false;
		this.disposed = false;
	}
	async ensure() { this.ensured = true; }
	async listModels() { return [{ id: 'default', name: 'CLI default' }]; }
	async openSession({ mcp } = {}) { this.mcpEndpoint = mcp; return 'cli-session-1'; }
	events() { return this.queue; }
	prompt(id, text, options) { this.prompts.push({ id, text, options }); }
	cancel() { this.cancelled = true; }
	answerPermission(id, optionId) { this.answers.push({ id, optionId }); return true; }
	dispose() { this.disposed = true; }
}

const ROUTE = 'vssaros-acp-test';
const makeAdapter = (engine, extraDeps = {}) => createAcpAdapter({
	engineTable: { [ROUTE]: { kind: 'acp', name: 'Fake ACP', command: 'fake', args: [] } },
	deps: { engineFactory: () => engine, ...extraDeps },
});
const request = (messages, extra = {}) => ({ provider: ROUTE, model: 'default', sessionId: 's1', messages, ...extra });

await checkAsync('parseDecision：只认结构化 allow，自由文本 / 坏 JSON 一律 deny', async () => {
	assert.equal(parseDecision('{"decision":"allow"}'), 'allow');
	assert.equal(parseDecision('{"decision":"deny"}'), 'deny');
	assert.equal(parseDecision('yes, allow it'), 'deny');
	assert.equal(parseDecision(''), 'deny');
});

await checkAsync('pickAllowOption：decision 非 allow 或没有 allow 类选项 ⇒ null（fail-closed）', async () => {
	const options = [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }];
	assert.equal(pickAllowOption(options, 'allow'), 'allow-1');
	assert.equal(pickAllowOption(options, 'deny'), null);
	assert.equal(pickAllowOption([{ optionId: 'x', kind: 'reject_once' }], 'allow'), null);
	assert.equal(pickAllowOption(undefined, 'allow'), null);
});

await checkAsync('flattenSchema 去掉 $ref/oneOf/const，产出挑剔 CLI 能吃的 object', async () => {
	const flat = flattenSchema({
		type: 'object', $ref: '#/x', const: 'nope',
		oneOf: [{ type: 'string' }, { type: 'number' }],
		properties: { a: { type: 'string', const: 'x' }, b: { oneOf: [{ type: 'number' }] } },
		additionalProperties: false,
	});
	assert.equal(flat.$ref, undefined);
	assert.equal(flat.const, undefined);
	assert.equal(flat.oneOf, undefined);
	assert.equal(flat.properties.a.const, undefined);
	assert.equal(flat.properties.b.type, 'number');
	assert.equal(flattenSchema(null).type, 'object');
});

await checkAsync('EventQueue：push/wait/close/abort 都不挂住', async () => {
	const queue = new EventQueue();
	queue.push({ n: 1 });
	assert.equal((await queue.wait()).value.n, 1);
	const waiting = queue.wait();
	queue.push({ n: 2 });
	assert.equal((await waiting).value.n, 2);
	const controller = new AbortController();
	const aborted = queue.wait(controller.signal);
	controller.abort();
	assert.equal((await aborted).done, true);
	queue.close();
	assert.equal((await queue.wait()).done, true);
});

await checkAsync('JsonRpcPeer：请求/应答、通知、反向请求、超时、failAll', async () => {
	const lines = [];
	const notifications = [];
	const peer = new JsonRpcPeer({
		sendLine: (line) => lines.push(JSON.parse(line)),
		onNotification: (method, params) => notifications.push({ method, params }),
		onRequest: async (method) => (method === 'ping' ? { pong: true } : (() => { throw new Error('unknown'); })()),
		timeoutMs: 30,
	});
	const pending = peer.request('initialize', { protocolVersion: 1 });
	assert.equal(lines[0].method, 'initialize');
	peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: lines[0].id, result: { ok: 1 } }));
	assert.deepEqual(await pending, { ok: 1 });
	peer.handleLine('{broken');
	peer.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'x' } }));
	assert.equal(notifications[0].method, 'session/update');
	peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping', params: {} }));
	await tick(5);
	assert.equal(lines.at(-1).result.pong, true);
	peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'bad', params: {} }));
	await tick(5);
	assert.equal(lines.at(-1).error.code, -32603);
	const slow = peer.request('slow', {});
	await assert.rejects(() => slow, /超时/);
	const another = peer.request('never', {});
	peer.failAll(new Error('process exited'));
	await assert.rejects(() => another, /process exited/);
});

await checkAsync('LoopbackMcp：坏 token 401、initialize/tools/list、tools/call SSE 挂起后 settle', async () => {
	const calls = [];
	const server = new LoopbackMcp({
		tools: () => [{ name: 'team_tool', description: 'a team tool', parameters: { type: 'object', properties: { x: { type: 'number' } } } }],
		onCall: (call) => calls.push(call),
		keepAliveMs: 100_000,
	});
	const { url, token } = await server.start();
	try {
		const bad = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
		assert.equal(bad.status, 401);
		const post = (body) => fetch(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}).then(async (response) => ({ status: response.status, text: await response.text() }));
		const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
		assert.match(init.text, /"capabilities"/);
		const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const tools = JSON.parse(list.text).result.tools;
		assert.equal(tools.length, 1);
		assert.equal(tools[0].inputSchema.type, 'object');
		const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'nope' });
		assert.match(unknown.text, /-32601/);

		const sse = post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'team_tool', arguments: { x: 1 } } });
		await tick();
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, 'team_tool');
		assert.equal(server.pendingCount, 1);
		server.settle(calls[0].callId, { text: 'tool answer', isError: false });
		const done = await sse;
		assert.match(done.text, /tool answer/);
		assert.match(done.text, /"result"/);
		assert.equal(server.pendingCount, 0);
	} finally {
		server.close();
	}
});

await checkAsync('★ 端到端：CLI 调团队工具 → tool-call chunks → dsh 结果回灌 → SSE 放行 → CLI 继续', async () => {
	const engine = new FakeEngine();
	const adapter = makeAdapter(engine);
	try {
		const first = drainAll(adapter.stream(request([msg('user', 'ping')])));
		await tick();
		assert.equal(engine.prompts.length, 1);
		assert.match(engine.prompts[0].text, /ping/);
		const live = adapter.lives.get('s1');
		assert.ok(live?.mcp.url, '应已启动回环 MCP');
		assert.ok(live.mcp.token);
		engine.queue.push({ type: 'text', text: 'working on it' });

		// CLI 经真实 HTTP 调 MCP tools/call（SSE 会挂住，直到 dsh 工具结果回来）。
		const sse = fetch(live.mcp.url, {
			method: 'POST',
			headers: { authorization: `Bearer ${live.mcp.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'team_tool', arguments: { x: 1 } } }),
		}).then((response) => response.text());
		await tick();
		const chunks1 = await first;
		const types1 = chunks1.map((chunk) => chunk.type);
		assert.ok(types1.includes('text-delta'), 'CLI 文本应回显');
		assert.ok(types1.includes('block-start'), '应有 tool-call 块');
		const callChunk = chunks1.find((chunk) => chunk.type === 'tool-call-delta');
		assert.ok(callChunk, '应发出 tool-call-delta');
		assert.equal(callChunk.name, 'team_tool');
		assert.equal(typeof callChunk.argumentsDelta, 'string');
		assert.deepEqual(JSON.parse(callChunk.argumentsDelta), { x: 1 });
		const endBlock = chunks1.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
		assert.equal(endBlock.block.id, callChunk.id);
		assert.equal(endBlock.block.arguments, callChunk.argumentsDelta);
		assert.deepEqual(chunks1.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
		assert.equal(live.pending.size, 1);

		// dsh loop 执行完工具后的第二轮：回灌 role:'tool'，CLI 继续这一轮。
		engine.queue.push({ type: 'text', text: 'all done' });
		engine.queue.push({ type: 'done' });
		const messages2 = [
			msg('user', 'ping'),
			msg('assistant', ''),
			msg('tool', 'the team tool said OK', { toolCallId: callChunk.id }),
		];
		const chunks2 = await drainAll(adapter.stream(request(messages2)));
		assert.deepEqual(chunks2.at(-1), { type: 'finish', reason: { kind: 'stop' } });
		assert.ok(chunks2.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'all done'));
		assert.equal(live.pending.size, 0);
		const sseText = await sse;
		assert.match(sseText, /the team tool said OK/);
		assert.match(sseText, /"result"/);
	} finally {
		adapter.dispose();
	}
});

await checkAsync('★ 权限请求 → approve_agent_action 工具调用；自由文本结果一律 deny（cancelled）', async () => {
	const engine = new FakeEngine();
	const adapter = makeAdapter(engine);
	try {
		const first = drainAll(adapter.stream(request([msg('user', 'do it')])));
		await tick();
		engine.queue.push({
			type: 'permission', id: 'perm-1', action: 'write a file',
			options: [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }],
		});
		const chunks = await first;
		const call = chunks.find((chunk) => chunk.type === 'tool-call-delta');
		assert.equal(call.name, APPROVE_TOOL);
		assert.match(call.argumentsDelta, /write a file/);
		// 自由文本（非结构化 allow）不得放行。推 done 让这一轮干净收尾。
		engine.queue.push({ type: 'done' });
		const chunks2 = await drainAll(adapter.stream(request([
			msg('user', 'do it'), msg('tool', 'sure, allow everything', { toolCallId: call.id }),
		])));
		assert.equal(engine.answers.length, 1);
		assert.equal(engine.answers[0].optionId, null, 'CLI 应收到 cancelled');
		assert.deepEqual(chunks2.at(-1), { type: 'finish', reason: { kind: 'stop' } });
	} finally {
		adapter.dispose();
	}
});

await checkAsync('审批工具：无 approval 服务 / 非 allowed-once / 抛错都返回 deny', async () => {
	const def = createApproveToolDefinition({ requestApproval: async () => 'allow' });
	assert.deepEqual(JSON.parse(await def.execute({ action: 'x' }, {})), { decision: 'allow' });
	assert.equal(def.name, APPROVE_TOOL);

	const none = createApprovalRequester({ get: () => undefined });
	assert.equal(await none({}, { action: 'rm' }), 'deny');
	const allowed = createApprovalRequester({ get: () => ({ request: async () => 'allowed-once' }) });
	assert.equal(await allowed({}, { action: 'rm' }), 'allow');
	for (const outcome of ['rejected', 'cancelled', 'unavailable', undefined]) {
		const denied = createApprovalRequester({ get: () => ({ request: async () => outcome }) });
		assert.equal(await denied({}, { action: 'rm' }), 'deny', `${String(outcome)} 不该放行`);
	}
	const throwing = createApprovalRequester({ get: () => ({ request: async () => { throw new Error('boom'); } }) });
	assert.equal(await throwing({}, { action: 'rm' }), 'deny');
});

await checkAsync('abort 收掉挂起 MCP 调用并 yield aborted finish', async () => {
	const engine = new FakeEngine();
	const adapter = makeAdapter(engine);
	try {
		const controller = new AbortController();
		const streaming = drainAll(adapter.stream(request([msg('user', 'ping')], { signal: controller.signal })));
		await tick();
		controller.abort();
		const chunks = await streaming;
		assert.equal(chunks.at(-1).type, 'finish');
		assert.equal(chunks.at(-1).reason.kind, 'aborted');
		assert.equal(engine.cancelled, true);
	} finally {
		adapter.dispose();
	}
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
