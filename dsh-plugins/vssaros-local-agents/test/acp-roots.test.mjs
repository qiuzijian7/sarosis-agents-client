#!/usr/bin/env node
// P1-5（2026-11-10）：ACP 多根会话参数与两级接线。纯函数 + 假引擎，不装任何真实 CLI。
import assert from 'node:assert/strict';
import {
	acpAdditionalDirectoriesCapable, acpSessionParams, MAX_ACP_ADDITIONAL_DIRECTORIES,
	acpInitializeParams, acpProtocolVersionOf, acpResumeMethodOf, acpMcpHttpCapable,
	acpCapabilitiesOf, acpIsVersionRejection, ACP_PROTOCOL_VERSION,
} from '../lib/core/acp.js';
import { createAcpAdapter } from '../lib/core/acpAdapter.js';
import { createLocalAgentAdapter } from '../lib/core/adapter.js';
import {
	parseAcpSessionMap, serializeAcpSessionMap, createAcpSessionMap, MAX_ACP_SESSION_MAP_ENTRIES,
} from '../lib/core/sessionMap.js';

const fails = [];
let passed = 0;
const checkAsync = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error?.message ?? error}`); }
};

const ROUTE = 'vssaros-acp-roots-test';
const TABLE = { [ROUTE]: { kind: 'acp', name: 'Fake ACP', command: 'fake', args: [] } };
const ROOTS = ['G:/ws/app', 'G:/ws/app', 'G:/ws/lib', 'G:/ws/docs'];

class FakeEngine {
	constructor() { this.calls = []; this.openCalls = []; }
	async ensure() { }
	async listModels(opts) { this.calls.push(opts); return [{ id: 'default', name: 'CLI default' }]; }
	async openSession(opts = {}) { this.openCalls.push(opts); return 'cli-session-1'; }
	events() { return { wait: async () => ({ done: false, value: { type: 'done' } }) }; }
	prompt() { }
	cancel() { }
}

const fakeMcp = () => ({
	start: async () => ({ url: 'http://127.0.0.1:1', token: 't' }),
	close() { }, failAll() { }, settle() { },
});

await checkAsync('能力协商：v1 sessionCapabilities / v2 session / 未声明', async () => {
	assert.equal(acpAdditionalDirectoriesCapable({ agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } } }), true);
	assert.equal(acpAdditionalDirectoriesCapable({ capabilities: { session: { additionalDirectories: {} } } }), true);
	assert.equal(acpAdditionalDirectoriesCapable({ agentCapabilities: {} }), false);
	assert.equal(acpAdditionalDirectoriesCapable(undefined), false);
});

await checkAsync('未声明能力 ⇒ 参数逐字不变（不冒出 additionalDirectories）', async () => {
	const params = acpSessionParams({ cwd: 'G:/ws/app', roots: ROOTS, capable: false, mcpServers: [] });
	assert.deepEqual(params, { cwd: 'G:/ws/app', mcpServers: [] });
});

await checkAsync('声明能力 ⇒ 绝对路径、去主根、去重、保序', async () => {
	const params = acpSessionParams({ cwd: 'G:/ws/app', roots: ROOTS, capable: true, mcpServers: [] });
	assert.deepEqual(params.additionalDirectories, ['G:/ws/lib', 'G:/ws/docs']);
	assert.equal(params.cwd, 'G:/ws/app');
});

await checkAsync('相对路径 / 畸形项被丢弃', async () => {
	const params = acpSessionParams({
		cwd: 'G:/ws/app', capable: true,
		roots: ['../lib', '', null, 7, { path: ' G:/ws/docs ' }, 'G:/ws/lib'],
	});
	assert.deepEqual(params.additionalDirectories, ['G:/ws/docs', 'G:/ws/lib']);
});

await checkAsync('cwd 缺省 ⇒ process.cwd()，且不把主根算进附加根', async () => {
	const params = acpSessionParams({ capable: true, roots: [process.cwd(), 'G:/ws/lib'] });
	assert.equal(params.cwd, process.cwd());
	assert.deepEqual(params.additionalDirectories, ['G:/ws/lib']);
});

await checkAsync('附加根条数有上限', async () => {
	const many = Array.from({ length: MAX_ACP_ADDITIONAL_DIRECTORIES + 20 }, (_, i) => `G:/r${i}`);
	const params = acpSessionParams({ cwd: 'G:/ws/app', roots: many, capable: true });
	assert.equal(params.additionalDirectories.length, MAX_ACP_ADDITIONAL_DIRECTORIES);
});

await checkAsync('acpAdapter.listModels 把 cwd + roots 传给引擎', async () => {
	const engine = new FakeEngine();
	const adapter = createAcpAdapter({
		engineTable: TABLE,
		deps: {
			engineFactory: () => engine,
			cwdFor: () => 'G:/ws/app',
			rootsFor: () => ['G:/ws/lib'],
		},
	});
	await adapter.listModels(ROUTE);
	assert.deepEqual(engine.calls[0], { cwd: 'G:/ws/app', roots: ['G:/ws/lib'] });
});

await checkAsync('外层 localAgentAdapter 透传 cwdFor / rootsFor', async () => {
	const engine = new FakeEngine();
	const adapter = createLocalAgentAdapter({
		engineTable: TABLE,
		engineFactory: () => engine,
		cwdFor: () => 'G:/ws/app',
		rootsFor: () => ['G:/ws/lib', 'G:/ws/docs'],
	});
	await adapter.listModels(ROUTE);
	assert.deepEqual(engine.calls[0], { cwd: 'G:/ws/app', roots: ['G:/ws/lib', 'G:/ws/docs'] });
});

const V2_REPLY = {
	protocolVersion: 2,
	capabilities: { session: { mcp: { http: {} }, additionalDirectories: {} } },
	info: { name: 'a', version: '1' },
};
const V1_REPLY = {
	protocolVersion: 1,
	agentCapabilities: {
		loadSession: true, mcpCapabilities: { http: true },
		sessionCapabilities: { additionalDirectories: {} },
	},
};

await checkAsync('P1-8：v2 initialize 双写两代字段 / v1 回退逐字不变', async () => {
	assert.equal(ACP_PROTOCOL_VERSION, 2);
	const p2 = acpInitializeParams(2);
	assert.equal(p2.protocolVersion, 2);
	assert.ok('capabilities' in p2 && 'info' in p2 && 'clientCapabilities' in p2 && 'clientInfo' in p2);
	assert.deepEqual(acpInitializeParams(1), {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		clientInfo: { name: 'vssaros', version: '1' },
	});
});

await checkAsync('P1-8：版本协商与 resume 方法', async () => {
	assert.equal(acpProtocolVersionOf(V2_REPLY), 2);
	assert.equal(acpProtocolVersionOf(V1_REPLY), 1);
	assert.equal(acpProtocolVersionOf({}), 1);
	assert.equal(acpResumeMethodOf(V2_REPLY), 'session/resume');
	assert.equal(acpResumeMethodOf({ protocolVersion: 2, capabilities: {} }), null);
	assert.equal(acpResumeMethodOf(V1_REPLY), 'session/load');
});

await checkAsync('P1-8：MCP HTTP 能力与能力集合', async () => {
	assert.equal(acpMcpHttpCapable(V2_REPLY), true);
	assert.equal(acpMcpHttpCapable(V1_REPLY), true);
	assert.equal(acpMcpHttpCapable({ protocolVersion: 2, capabilities: { session: { mcp: { sse: {} } } } }), false);
	assert.deepEqual(acpCapabilitiesOf(V2_REPLY), {
		protocolVersion: 2, mcpHttp: true, resumeMethod: 'session/resume',
		loadSession: false, additionalDirectories: true,
	});
	assert.equal(acpCapabilitiesOf(V1_REPLY).loadSession, true);
});

await checkAsync('P1-8：版本拒绝识别', async () => {
	assert.equal(acpIsVersionRejection({ code: -32022 }), true);
	assert.equal(acpIsVersionRejection({ message: 'Unsupported protocol version' }), true);
	assert.equal(acpIsVersionRejection({ message: 'auth failed' }), false);
});

const memoryMap = (initial = {}) => {
	let text = JSON.stringify(initial);
	return {
		map: createAcpSessionMap({
			readText: async () => text,
			writeText: async (t) => { text = t; },
		}),
		get text() { return text; },
	};
};
const drainStream = async (adapter, options) => {
	for await (const chunk of adapter.stream(options)) { void chunk; }
};

await checkAsync('P1-9：映射纯函数 — 解析只留合法 id 对 / 稳定序列化 / 条数上限', async () => {
	assert.deepEqual(parseAcpSessionMap('not json'), {});
	assert.deepEqual(parseAcpSessionMap('[]'), {});
	assert.deepEqual(parseAcpSessionMap(JSON.stringify({ a: 'x', bad: 7, '': 'y' })), { a: 'x' });
	assert.equal(serializeAcpSessionMap({ b: '2', a: '1' }), JSON.stringify({ a: '1', b: '2' }, null, 2) + '\n');
	const many = Object.fromEntries(Array.from({ length: MAX_ACP_SESSION_MAP_ENTRIES + 20 }, (_, i) => [`s${i}`, `c${i}`]));
	assert.equal(Object.keys(parseAcpSessionMap(JSON.stringify(many))).length, MAX_ACP_SESSION_MAP_ENTRIES);
});

await checkAsync('P1-9：映射 get/set/delete + 读盘失败按空映射', async () => {
	const m = memoryMap({ a: 'cli-a' });
	assert.equal(await m.map.get('a'), 'cli-a');
	assert.equal(await m.map.set('b', 'cli-b'), true);
	assert.equal(await m.map.get('b'), 'cli-b');
	assert.equal(JSON.parse(m.text).b, 'cli-b');
	assert.equal(await m.map.set('', 'nope'), false);
	await m.map.delete('a');
	assert.equal(await m.map.get('a'), undefined);
	assert.equal(await m.map.size(), 1);
	const broken = createAcpSessionMap({ readText: async () => { throw new Error('ENOENT'); }, writeText: async () => { } });
	assert.equal(await broken.get('x'), undefined);
});

await checkAsync('★ P1-9：有映射 ⇒ ensureLive 带 resumeId，最终 id 写回', async () => {
	const engine = new FakeEngine();
	const m = memoryMap({ s1: 'cli-old' });
	const adapter = createAcpAdapter({
		engineTable: TABLE,
		deps: {
			engineFactory: () => engine, mcpFactory: fakeMcp, sessionMap: m.map,
			cwdFor: () => 'G:/ws/app', rootsFor: () => ['G:/ws/lib'],
		},
	});
	await drainStream(adapter, { provider: ROUTE, model: 'default', sessionId: 's1', messages: [] });
	assert.equal(engine.openCalls.length, 1);
	assert.equal(engine.openCalls[0].resumeId, 'cli-old');
	assert.deepEqual(engine.openCalls[0].roots, ['G:/ws/lib']);
	assert.equal(await m.map.get('s1'), 'cli-session-1');
});

await checkAsync('P1-9：无映射 ⇒ 不带 resumeId；anonymous ⇒ 不查映射', async () => {
	const empty = new FakeEngine();
	const m = memoryMap({});
	const adapter = createAcpAdapter({
		engineTable: TABLE,
		deps: { engineFactory: () => empty, mcpFactory: fakeMcp, sessionMap: m.map },
	});
	await drainStream(adapter, { provider: ROUTE, model: 'default', sessionId: 's2', messages: [] });
	assert.equal('resumeId' in empty.openCalls[0], false);
	assert.equal(await m.map.get('s2'), 'cli-session-1');

	let queried = 0;
	const spyMap = { get: async () => { queried++; return undefined; }, set: async () => { } };
	const anon = new FakeEngine();
	const anonAdapter = createAcpAdapter({
		engineTable: TABLE,
		deps: { engineFactory: () => anon, mcpFactory: fakeMcp, sessionMap: spyMap },
	});
	await drainStream(anonAdapter, { provider: ROUTE, model: 'default', messages: [] });
	assert.equal(queried, 0);
	assert.equal('resumeId' in anon.openCalls[0], false);
});

console.log(`\nacp-roots: ${passed} passed / ${fails.length} failed`);
if (fails.length) { process.exit(1); }
