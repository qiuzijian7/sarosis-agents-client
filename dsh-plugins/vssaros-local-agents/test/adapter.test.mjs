#!/usr/bin/env node
// adapter 行为测试：用 fake CLI 子进程，不装任何真实 CLI、不需要任何密钥。
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLocalAgentAdapter, LocalAgentError } from '../lib/core/adapter.js';
import { ENGINES } from '../lib/core/engines.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};

/** 造一个返回指定 stdout 行的假 spawn；记录 stdin / kill / 参数。 */
function fakeSpawn(lines = []) {
	const calls = [];
	const children = [];
	const spawnProcess = (binary, args, options) => {
		const child = {
			binary, args, options,
			stdin: { written: '', ended: false, write(text) { this.written += text; }, end() { this.ended = true; } },
			stdout: Readable.from(lines.map((line) => `${line}\n`)),
			killed: false,
			kill() { this.killed = true; return true; },
		};
		calls.push({ binary, args, options });
		children.push(child);
		return child;
	};
	return { spawnProcess, calls, children };
}

const ROUTE = 'vssaros-codex-cli';
const make = (overrides = {}) => {
	const fake = fakeSpawn(overrides.lines ?? []);
	const adapter = createLocalAgentAdapter({
		engineTable: ENGINES,
		findExecutable: overrides.findExecutable ?? (() => '/fake/codex'),
		spawnProcess: fake.spawnProcess,
		cleanEnv: () => ({ PATH: '/bin', SAFE: '1' }),
		now: () => 1234,
	});
	return { adapter, ...fake };
};
const request = (extra = {}) => ({
	provider: ROUTE,
	model: 'default',
	messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
	system: 'TEAM RULES',
	sessionId: 's1',
	...extra,
});
const drain = async (iterable) => { const out = []; for await (const chunk of iterable) out.push(chunk); return out; };

await checkAsync('完整一次 stream：CLI 文本 → 合法 chunk 序列', async () => {
	const { adapter, calls, children } = make({
		lines: [
			'{"type":"thread.started"}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}',
			'{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}',
		],
	});
	const call = await adapter.prepareCall(ROUTE, 'default');
	const chunks = await drain(call.stream(request()));
	assert.deepEqual(chunks.map((c) => c.type),
		['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
	assert.equal(chunks[1].text, 'answer');
	assert.deepEqual(chunks[3].usage, { input_tokens: 2, output_tokens: 3 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].binary, '/fake/codex');
	assert.deepEqual(calls[0].args, ENGINES[ROUTE].args);
	assert.equal(calls[0].options.windowsHide, true);
	assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'inherit']);
	assert.deepEqual(calls[0].options.env, { PATH: '/bin', SAFE: '1' });
	assert.equal(children[0].stdin.written, 'TEAM RULES\n\nping');
	assert.equal(children[0].stdin.ended, true);
	assert.equal(children[0].killed, true, '回合结束要收掉子进程');
	assert.deepEqual(adapter.live.get('s1'), { route: ROUTE, binary: '/fake/codex', startedAt: 1234 });
});

await checkAsync('session-title / compaction 不启动 CLI', async () => {
	for (const purpose of ['session-title', 'compaction']) {
		const { adapter, calls } = make();
		const chunks = await drain(adapter.stream(request({ purpose })));
		assert.equal(calls.length, 0, `${purpose} 不该 spawn`);
		assert.equal(chunks.at(-1).type, 'finish');
	}
	const { adapter } = make();
	const title = await drain(adapter.stream(request({ purpose: 'session-title' })));
	assert.equal(title[1].text, 'ping');
});

await checkAsync('找不到 CLI → LOCAL_AGENT_MISSING 且不 spawn', async () => {
	const { adapter, calls } = make({ findExecutable: () => undefined });
	await assert.rejects(() => drain(adapter.stream(request())), (error) => {
		assert.ok(error instanceof LocalAgentError);
		assert.equal(error.code, 'LOCAL_AGENT_MISSING');
		return true;
	});
	assert.equal(calls.length, 0);
});

await checkAsync('未知路由 fail-closed（ACP 路由已委托 P1 状态机，见 acp.test.mjs）', async () => {
	const { adapter } = make();
	await assert.rejects(() => drain(adapter.stream(request({ provider: 'nope' }))), (error) => {
		assert.equal(error.code, 'LOCAL_AGENT_MISSING');
		return true;
	});
});

await checkAsync('CLI error 事件抛错，子进程仍被收掉', async () => {
	const { adapter, children } = make({ lines: ['{"type":"error","message":"not logged in"}'] });
	await assert.rejects(() => drain(adapter.stream(request())), /not logged in/);
	assert.equal(children[0].killed, true);
});

await checkAsync('abort 会 kill 子进程', async () => {
	const { adapter, children } = make({ lines: [] });
	const controller = new AbortController();
	await drain(adapter.stream(request({ signal: controller.signal })));
	controller.abort();
	assert.equal(children[0].killed, true);
});

await checkAsync('dispose 关掉在途子进程并清空 live', async () => {
	const { adapter, children } = make({ lines: [] });
	await drain(adapter.stream(request()));
	adapter.dispose();
	assert.equal(children[0].killed, true);
	assert.equal(adapter.live.size, 0);
});

await checkAsync('providerInfo / listModels / resolveModel 满足注册契约', async () => {
	const { adapter } = make();
	assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: 'Codex CLI' });
	assert.equal(adapter.providerRetryPolicy(), undefined);
	assert.equal(adapter.imageRequestPricing(), undefined);
	const models = await adapter.listModels('vssaros-claude-code');
	assert.deepEqual(models.map((m) => m.id), ['default', 'opus', 'sonnet', 'haiku']);
	assert.ok(models.every((m) => m.provider === 'vssaros-claude-code'));
	const info = await adapter.resolveModel(ROUTE, 'default');
	assert.deepEqual(info.inputModalities, ['text']);
	assert.equal(info.context.contextWindow, 200_000);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
