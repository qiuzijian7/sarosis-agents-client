import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as store from '../lib/store.js';
import { presetIdOf } from '../lib/core/agents.js';

const bot = (id = 'wb-audit-reviewer') => ({
	id, name: '工作台审查员', role: '审查', systemPrompt: '检查工作台内容。',
	skills: ['audit-skill'], tools: ['read', 'mcp__audit__*'], capabilities: [],
});
const fixture = async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'vssaros-agent-source-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { dataRoot: root, dshHome: join(root, 'dsh'), agentsBuiltinRoot: join(root, 'builtin') };
};
const writeAgent = async (root, id, name) => {
	await mkdir(join(root, id), { recursive: true });
	await writeFile(join(root, id, '.agent.md'), `---\nname: ${name}\n---\n${name}人格。\n`, 'utf8');
};

test('数组 source 进入统一扫描，保留能力字段并将 systemPrompt 映射到 persona', async (t) => {
	const config = await fixture(t);
	assert.equal(typeof store.registerAgentSource, 'function');
	const dispose = store.registerAgentSource(config, { owner: 'workbench:audit', agents: [bot()] });
	t.after(dispose);
	const scan = await store.scanAgentsFromConfig({ ...config });
	assert.equal(scan.agents.length, 1);
	const row = scan.agents[0];
	assert.equal(row.id, bot().id);
	assert.equal(row.persona, bot().systemPrompt);
	assert.equal(row.source, 'plugin');
	assert.equal(row.sourceOwner, 'workbench:audit');
	assert.deepEqual(row.skills, bot().skills);
	assert.deepEqual(row.tools, bot().tools);
	assert.equal(presetIdOf(row.id), 'vssaros-wb-audit-reviewer');
	assert.deepEqual(scan.sourceAgentIds, [row.id]);
	dispose();
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents, []);
});

test('用户覆写优先于插件；撤销只移除插件，用户文件与内置 Bot 不受影响', async (t) => {
	const config = await fixture(t);
	await writeAgent(config.agentsBuiltinRoot, 'builtin-helper', '内置助手');
	await writeAgent(join(config.dataRoot, 'agents'), bot().id, '用户覆写');
	const dispose = store.registerAgentSource(config, { owner: 'workbench:audit', agents: [bot()] });
	t.after(dispose);
	const scan = await store.scanAgentsFromConfig(config);
	assert.equal(scan.agents.find(a => a.id === bot().id).name, '用户覆写');
	assert.equal(scan.agents.find(a => a.id === bot().id).source, 'custom');
	assert.deepEqual(scan.sourceAgentIds, [bot().id]);
	dispose();
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents.map(a => a.name), ['内置助手', '用户覆写']);
});

test('owner 与跨 owner id 冲突明确拒绝，失败是原子的，旧 disposer 不撤新 source', async (t) => {
	const config = await fixture(t);
	const dispose = store.registerAgentSource(config, { owner: 'workbench:audit', agents: [bot()] });
	t.after(dispose);
	assert.throws(() => store.registerAgentSource(config, { owner: 'workbench:audit', agents: [] }), /owner|来源/);
	assert.throws(() => store.registerAgentSource(config, { owner: 'workbench:other', agents: [bot('wb-other-new'), bot()] }), /冲突|已注册/);
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents.map(a => a.id), [bot().id]);
	dispose();
	const replacement = store.registerAgentSource(config, { owner: 'workbench:audit', agents: [bot('wb-audit-replacement')] });
	t.after(replacement);
	dispose();
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents.map(a => a.id), ['wb-audit-replacement']);
});

test('source 按数据根隔离；输入与扫描返回值不能修改注册快照', async (t) => {
	const config = await fixture(t);
	const other = await fixture(t);
	const row = bot();
	const dispose = store.registerAgentSource(config, { owner: 'workbench:audit', agents: [row] });
	const otherDispose = store.registerAgentSource(other, { owner: 'workbench:audit', agents: [bot()] });
	t.after(dispose);
	t.after(otherDispose);
	row.skills.push('mutated-input');
	const first = await store.scanAgentsFromConfig(config);
	first.agents[0].tools.push('mutated-result');
	const second = await store.scanAgentsFromConfig(config);
	assert.deepEqual(second.agents[0].skills, bot().skills);
	assert.deepEqual(second.agents[0].tools, bot().tools);
	dispose();
	assert.equal((await store.scanAgentsFromConfig(other)).agents.length, 1);
});

test('非法 owner、agents、非安全 id 和重复 id 拒绝且不留下半注册', async (t) => {
	const config = await fixture(t);
	assert.equal(typeof store.registerAgentSource, 'function');
	for (const source of [
		{ owner: '', agents: [bot()] },
		{ owner: 'invalid', agents: null },
		{ owner: 'invalid', agents: [bot('WB/Audit')] },
		{ owner: 'invalid', agents: [bot(), bot()] },
		{ owner: 'invalid', agents: [{ id: 'wb-empty-name', name: '' }] },
	]) {
		assert.throws(() => store.registerAgentSource(config, source));
	}
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents, []);
});

function hostFixture(presets, appReady) {
	const services = new Map();
	if (appReady) { services.set('appReady', appReady); }
	const cleanups = [];
	const injectors = [];
	const routes = [];
	const noop = () => undefined;
	const ctx = {
		tools: { register: () => noop, get: noop },
		logger: () => ({ info: noop, warn: noop, error: noop }),
		on: () => noop,
		reflect: { get: (name) => services.get(name) },
		get: (name) => services.get(name),
		provide: (name, value) => services.set(name, value),
		inject: (deps, callback) => {
			if (deps.length === 1 && deps[0] === 'agentPresets') {
				injectors.push(callback);
				if (presets) { callback({ agentPresets: presets, effect: ctx.effect, get: ctx.get }); }
			} else if (deps.join(',') === 'webServer,connection') {
				callback({ webServer: { register: route => { routes.push(route); return noop; } }, connection: { requestRejection: () => 0 }, effect: ctx.effect });
			}
		},
		effect: (fn) => {
			const cleanup = fn();
			if (typeof cleanup === 'function') { cleanups.push(cleanup); }
			return cleanup;
		},
	};
	return {
		ctx, services, routes,
		attachPresets: (value) => injectors.forEach(callback => callback({ agentPresets: value, effect: ctx.effect, get: ctx.get })),
		close: async () => { for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); } },
	};
}
function presetFixture() {
	const definitions = new Map();
	const registrations = [];
	let beforeRegister;
	let beforeDispose;
	return {
		definitions, registrations,
		setRegisterHook: (hook) => { beforeRegister = hook; },
		setDisposeHook: (hook) => { beforeDispose = hook; },
		register: async (definition) => {
			await beforeRegister?.(definition);
			assert.equal(definitions.has(definition.id), false, 'preset 不得重复注册');
			definitions.set(definition.id, definition);
			registrations.push(definition.id);
			return async () => { await beforeDispose?.(definition); definitions.delete(definition.id); };
		},
		list: async () => [...definitions.values()],
	};
}
const deferred = () => {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
};

test('真实apply的兜底等待appReady，慢启动60秒也不提前扫描', async t => {
	const config = await fixture(t);
	await writeAgent(join(config.dataRoot, 'agents'), 'ready-helper', '就绪助手');
	const presets = presetFixture();
	const started = deferred();
	presets.setRegisterHook(() => started.resolve());
	let readyCallback;
	const host = hostFixture(presets, { onReady(callback) { readyCallback = callback; return () => { readyCallback = undefined; }; } });
	t.after(host.close);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, config);
	assert.equal(typeof readyCallback, 'function');
	t.mock.timers.tick(60_000);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(presets.registrations.length, 0);
	readyCallback();
	t.mock.timers.tick(14_999);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(presets.registrations.length, 0);
	t.mock.timers.tick(1);
	await started.promise;
	await host.close();
	assert.equal(readyCallback, undefined);
	assert.equal(presets.definitions.size, 0);
});

test('服务注册等待在飞同步；lazy 下插件立即可用，附件与异步撤销共享事实', async (t) => {
	const config = await fixture(t);
	for (let i = 0; i < 4; i++) { await writeAgent(join(config.dataRoot, 'agents'), `user-${i}`, `用户${i}`); }
	const presets = presetFixture();
	const firstStarted = deferred();
	const firstAllowed = deferred();
	let blocked = false;
	presets.setRegisterHook(async () => {
		if (!blocked) { blocked = true; firstStarted.resolve(); await firstAllowed.promise; }
	});
	const host = hostFixture(presets);
	t.after(async () => { firstAllowed.resolve(); await host.close(); });
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, config);
	const service = host.services.get('vssarosAgents');
	assert.equal(typeof service?.registerSource, 'function');
	assert.equal(service.presetIdOf(bot().id), presetIdOf(bot().id));
	const firstSync = service.rescan();
	await firstStarted.promise;
	let registered = false;
	const sourceBots = [bot(), bot('wb-audit-second'), bot('wb-audit-third'), bot('wb-audit-fourth')];
	const registration = service.registerSource({ owner: 'workbench:audit', agents: sourceBots }).then(value => { registered = true; return value; });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(registered, false);
	firstAllowed.resolve();
	await firstSync;
	const dispose = await registration;
	assert.equal(typeof dispose, 'function');
	assert.ok(sourceBots.every(row => presets.definitions.has(presetIdOf(row.id))), '全部插件 Bot 都必须绕过 lazy 上限');
	const definition = presets.definitions.get(presetIdOf(bot().id));
	assert.ok(definition, '插件 Bot 不应被 lazy 延迟15秒');
	assert.equal(definition.plugins[0].config.persona, bot().systemPrompt);
	assert.deepEqual(definition.plugins[0].config.skills, bot().skills);
	assert.ok(definition.plugins[0].config.tools.includes('mcp__audit__*'));
	assert.deepEqual(await service.attachmentsOf(presetIdOf(bot().id)), { agentId: bot().id, capabilities: [], skills: bot().skills, declared: true });
	const disposeStarted = deferred();
	const disposeAllowed = deferred();
	presets.setDisposeHook(async (def) => { if (def.id === definition.id) { disposeStarted.resolve(); await disposeAllowed.promise; } });
	let removed = false;
	const removal = dispose().then(() => { removed = true; });
	await disposeStarted.promise;
	assert.equal(removed, false);
	disposeAllowed.resolve();
	await removal;
	await dispose();
	assert.equal(presets.definitions.has(definition.id), false);
	assert.equal((await store.scanAgentsFromConfig(config)).agents.some(a => a.id === bot().id), false);
	assert.equal((await service.attachmentsOf(definition.id)).declared, false);
});

test('服务 preset 注册失败回滚 source 并明确拒绝；宿主卸载清理未手动撤销的 source', async (t) => {
	const config = await fixture(t);
	const presets = presetFixture();
	const host = hostFixture(presets);
	t.after(host.close);
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, { ...config, presetMode: 'eager' });
	const service = host.services.get('vssarosAgents');
	assert.equal(typeof service?.registerSource, 'function');
	presets.setRegisterHook(async (def) => { if (def.id === presetIdOf(bot().id)) { throw new Error('preset failure'); } });
	await assert.rejects(() => service.registerSource({ owner: 'workbench:audit', agents: [bot()] }), /preset failure|注册.*失败/);
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents, []);
	presets.setRegisterHook(undefined);
	await service.registerSource({ owner: 'workbench:audit', agents: [bot()] });
	await host.close();
	assert.equal(presets.definitions.size, 0);
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents, []);
});

test('agentPresets 未就绪时注册拒绝且不留 source，rescan 保持明确错误', async (t) => {
	const config = await fixture(t);
	const host = hostFixture();
	t.after(host.close);
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, config);
	const service = host.services.get('vssarosAgents');
	assert.equal(typeof service?.registerSource, 'function');
	await assert.rejects(() => service.registerSource({ owner: 'workbench:audit', agents: [bot()] }), /还没就绪/);
	await assert.rejects(() => service.rescan(), /还没就绪/);
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents, []);
});

test('HTTP home 不等待冷启动 preset 注册，返回 pending 并在注册完成后收敛', { timeout: 5000 }, async t => {
	const config = await fixture(t);
	await writeAgent(join(config.dataRoot, 'agents'), 'cold-helper', '冷启动助手');
	const presets = presetFixture();
	const started = deferred();
	const allowed = deferred();
	presets.setRegisterHook(async () => { started.resolve(); await allowed.promise; });
	const host = hostFixture(presets);
	t.after(async () => { allowed.resolve(); await host.close(); });
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, config);
	const route = host.routes.find(row => row.path === '/x/agents');
	const call = async () => {
		const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
		await route.handler({ url: '/x/agents/api/home', method: 'GET', headers: {} }, response);
		assert.equal(response.status, 200, response.body);
		return JSON.parse(response.body);
	};
	const first = call();
	await started.promise;
	const pending = await first;
	assert.deepEqual({ pending: pending.presetsPending, ids: pending.agents.map(row => row.id), registered: pending.agents[0].registered },
		{ pending: true, ids: ['cold-helper'], registered: false });
	assert.equal((await call()).presetsPending, true);
	allowed.resolve();
	await host.services.get('vssarosAgents').registrar.lazyFill.fillNow();
	const ready = await call();
	assert.deepEqual({ pending: ready.presetsPending, registered: ready.agents[0].registered }, { pending: false, registered: true });
});

test('无 preset 的 HTTP 花名册和未读读口也包含插件 source', async (t) => {
	const config = await fixture(t);
	const { __test: seenTest } = await import('../lib/seen.js');
	seenTest.resetSeenCache();
	t.after(seenTest.resetSeenCache);
	const cacheRoot = join(config.dshHome, 'storages', 'session_projcache', 'sessions');
	await mkdir(cacheRoot, { recursive: true });
	await writeFile(join(cacheRoot, 'plugin-session.json'), JSON.stringify({ record: { rows: { agentPreset: { val: presetIdOf(bot().id) }, sessionListMetadata: { val: { lastPromptAt: 1 } } } } }), 'utf8');
	const withdraw = store.registerAgentSource(config, { owner: 'workbench:audit', agents: [bot(), bot('wb-audit-seen')] });
	t.after(withdraw);
	const host = hostFixture();
	t.after(host.close);
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, config);
	const route = host.routes.find(row => row.path === '/x/agents');
	assert.ok(route);
	const call = async (url, method = 'GET', body) => {
		const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
		await route.handler({ url, method, headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {})); } }, response);
		assert.equal(response.status, 200, response.body);
		return JSON.parse(response.body);
	};
	assert.deepEqual((await call('/x/agents/api/agents')).agents.map(row => row.id), [bot().id, 'wb-audit-seen']);
	assert.equal((await call('/x/agents/api/unread')).counts[bot().id], 1);
	assert.equal((await call('/x/agents/api/agents', 'POST', { action: 'seen', id: 'wb-audit-seen' })).counts[bot().id], 1);
});

test('lazy 窗口内可委派插件 Bot 完成两阶段，注销清除别的 preset 中的引用', async (t) => {
	const config = await fixture(t);
	await writeAgent(join(config.dataRoot, 'agents'), 'user-keeper', '保留用户 Bot');
	const presets = presetFixture();
	const host = hostFixture(presets);
	t.after(host.close);
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, config);
	const service = host.services.get('vssarosAgents');
	const agents = [bot('wb-team-a'), bot('wb-team-b')].map(row => ({ ...row, delegatable: true }));
	const withdraw = await service.registerSource({ owner: 'workbench:team', agents });
	const findSubagent = definition => definition.plugins.find(row => row.id === 'delegation').config.find(row => row.id === 'tool-subagent');
	assert.deepEqual(findSubagent(presets.definitions.get(presetIdOf(agents[0].id))).config.allowedAgentPresets, [presetIdOf(agents[1].id)]);
	assert.deepEqual(findSubagent(presets.definitions.get(presetIdOf('user-keeper'))).config.allowedAgentPresets, agents.map(row => presetIdOf(row.id)));
	await withdraw();
	assert.ok(agents.every(row => !presets.definitions.has(presetIdOf(row.id))));
	assert.equal(findSubagent(presets.definitions.get(presetIdOf('user-keeper'))).config.allowedAgentPresets, undefined);
});

test('root source 复用原格式，只读已声明 Bot，映射 skills/tools/MCP 并保留外部能力', async (t) => {
	const config = await fixture(t);
	const root = join(config.dataRoot, 'package', 'bots');
	await writeAgent(root, 'reviewer', '包内 Bot');
	await writeFile(join(root, 'reviewer', '.agent.md'), '---\nname: 包内 Bot\nrole: 审查\nsubagent: true\nskills:\n  - audit\n  - external-skill\ntools:\n  - inspect\n  - inspect_*\n  - !inspect_secret\n  - read\n  - mcp__local__search\n  - !mcp__local__*\n  - mcp__external__*\n---\n包内人格正文。\n', 'utf8');
	await mkdir(join(root, 'undeclared'), { recursive: true });
	await writeFile(join(root, 'undeclared', '.agent.md'), '---\nid: invalid\n---\n没有name，不应读取。\n', 'utf8');
	const source = { owner: '@tests/audit-workbench', root,
		ids: new Map([['reviewer', 'wb-12345678-reviewer']]),
		skills: { audit: 'wb-12345678-audit' },
		tools: new Map([['inspect', 'wb_12345678_inspect'], ['inspect_detail', 'wb_12345678_detail'], ['inspect_secret', 'wb_12345678_secret']]),
		mcp: { local: 'wb_12345678_local' } };
	const presets = presetFixture();
	const host = hostFixture(presets);
	t.after(host.close);
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, { ...config, presetMode: 'eager' });
	const service = host.services.get('vssarosAgents');
	const withdraw = await service.registerSource(source);
	const scan = await store.scanAgentsFromConfig(config);
	assert.deepEqual(scan.agents.map(row => row.id), ['wb-12345678-reviewer']);
	const row = scan.agents[0];
	assert.equal(row.role, '审查');
	assert.equal(row.delegatable, true);
	assert.equal(row.persona, '包内人格正文。');
	assert.deepEqual(row.skills, ['wb-12345678-audit', 'external-skill']);
	assert.deepEqual(row.tools, ['wb_12345678_inspect', 'wb_12345678_detail', 'wb_12345678_secret', '!wb_12345678_secret', 'read', 'mcp__wb_12345678_local__search', '!mcp__wb_12345678_local__*', 'mcp__external__*']);
	assert.deepEqual((await service.attachmentsOf('vssaros-wb-12345678-reviewer')).skills, row.skills);
	assert.ok(presets.definitions.has('vssaros-wb-12345678-reviewer'));
	await withdraw();
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents, []);
	assert.equal(presets.definitions.has('vssaros-wb-12345678-reviewer'), false);
});

test('root source 拒绝缺失文件、目录声明与frontmatter id不符、非法路径及映射', async (t) => {
	const config = await fixture(t);
	const root = join(config.dataRoot, 'package', 'bots');
	await writeAgent(root, 'reviewer', '测试 Bot');
	const base = { owner: 'root-invalid', root, ids: { reviewer: 'wb-12345678-reviewer' } };
	const presets = presetFixture();
	const host = hostFixture(presets);
	t.after(host.close);
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, { ...config, presetMode: 'eager' });
	const service = host.services.get('vssarosAgents');
	for (const source of [
		{ ...base, ids: { missing: 'wb-12345678-missing' } },
		{ ...base, ids: { '../reviewer': 'wb-12345678-reviewer' } },
		{ ...base, ids: { reviewer: 'BAD/namespace' } },
		{ ...base, skills: [] },
		{ ...base, tools: { inspect: 42 } },
		{ ...base, root: 'relative/bots' },
		{ ...base, ids: undefined },
		{ ...base, agents: [bot()] },
	]) { await assert.rejects(() => service.registerSource(source)); }
	await writeFile(join(root, 'reviewer', '.agent.md'), '---\nid: different\nname: 不匹配的 Bot\n---\n正文。\n', 'utf8');
	await assert.rejects(() => service.registerSource(base), /id|声明/);
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents, []);
});

test('root source 命名空间 id 的用户覆写优先且撤销保留用户文件', async (t) => {
	const config = await fixture(t);
	const root = join(config.dataRoot, 'package', 'bots');
	await writeAgent(root, 'reviewer', '插件 Bot');
	await writeAgent(join(config.dataRoot, 'agents'), 'wb-12345678-reviewer', '用户覆写');
	const presets = presetFixture();
	const host = hostFixture(presets);
	t.after(host.close);
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, { ...config, presetMode: 'eager' });
	const withdraw = await host.services.get('vssarosAgents').registerSource({ owner: 'root-override', root, ids: { reviewer: 'wb-12345678-reviewer' } });
	assert.equal(presets.definitions.get('vssaros-wb-12345678-reviewer').name, '用户覆写');
	await withdraw();
	assert.equal((await store.scanAgentsFromConfig(config)).agents[0].name, '用户覆写');
	assert.equal(presets.definitions.get('vssaros-wb-12345678-reviewer').name, '用户覆写');
});

test('兼容主流程真实10位hash runtimeId与Object映射，所有能力引用和注销对齐', async (t) => {
	const { resourceId } = await import('../../vssaros-workbenches/lib/pluginPackage.js');
	const config = await fixture(t);
	const owner = '@tests/main-resource-runtime';
	const original = 'abcdefghijklmnopq-rstuvwxyz';
	const runtime = resourceId(owner, original);
	assert.match(runtime, /^wb-[a-f0-9]{10}-[a-z0-9]+$/);
	const skill = resourceId(owner, 'audit');
	const tool = resourceId(owner, 'inspect-detail');
	const server = resourceId(owner, 'local');
	assert.ok(server.length <= 32);
	const root = join(config.dataRoot, 'package', 'bots');
	await writeAgent(root, original, '真实主流程 Bot');
	await writeFile(join(root, original, '.agent.md'), '---\nname: 真实主流程 Bot\nskills: audit\ntools:\n  - inspect-detail\n  - !inspect-*\n  - mcp__local__*\n---\n主流程人格。\n', 'utf8');
	const presets = presetFixture();
	const host = hostFixture(presets);
	t.after(host.close);
	const { apply } = await import('../lib/index.js');
	apply(host.ctx, { ...config, presetMode: 'eager' });
	const service = host.services.get('vssarosAgents');
	const dispose = await service.registerSource({ owner, root, ids: { [original]: runtime }, skills: { audit: skill }, tools: { 'inspect-detail': tool }, mcp: { local: server } });
	const row = (await store.scanAgentsFromConfig(config)).agents[0];
	assert.equal(row.id, runtime);
	assert.deepEqual(row.skills, [skill]);
	assert.deepEqual(row.tools, [tool, '!' + tool, `mcp__${server}__*`]);
	assert.equal(service.presetIdOf(runtime), 'vssaros-' + runtime);
	assert.ok(presets.definitions.has('vssaros-' + runtime));
	assert.deepEqual((await service.attachmentsOf('vssaros-' + runtime)).skills, [skill]);
	await dispose();
	assert.equal(presets.definitions.has('vssaros-' + runtime), false);
	assert.deepEqual((await store.scanAgentsFromConfig(config)).agents, []);
});
