import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const moduleUrl = new URL('../lib/index.js', import.meta.url);
const resourcesModule = () => import(moduleUrl.href);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), 'plugin-resources-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, 'skills/help'), { recursive: true });
	await mkdir(join(root, 'lib/tools'), { recursive: true });
	await mkdir(join(root, 'bots/helper'), { recursive: true });
	await mkdir(join(root, 'mcp/remote'), { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@demo/bot', version: '1.0.0', type: 'module' }));
	await writeFile(join(root, 'skills/help/SKILL.md'), '---\nname: help\ndescription: Help\n---\nInstructions');
	await writeFile(join(root, 'bots/helper/.agent.md'), '---\nname: Helper\n---\nHelp');
	await writeFile(join(root, 'mcp/remote/config.json'), '{"type":"http","url":"https://example.test/mcp"}');
	await writeFile(join(root, 'lib/tools/ping.js'), 'export const definition = { parameters: { type: "object", properties: {} }, output: { schema: { type: "string" }, render: String }, execute: async () => "pong" };');
	const plan = { profile: 'bot', primaryBot: 'helper', packageName: '@demo/bot', version: '1.0.0', resources: {
		bots: [{ id: 'helper', runtimeId: 'runtime-helper', path: 'bots/helper/.agent.md' }],
		skills: [{ id: 'help', runtimeId: 'runtime-help', path: 'skills/help/SKILL.md' }],
		tools: [{ id: 'ping', runtimeId: 'runtime-ping', path: 'lib/tools/ping.js' }],
		mcp: [{ id: 'remote', runtimeId: 'runtime-remote', path: 'mcp/remote/config.json' }],
	} };
	return { root, plan };
}

function context(services = {}) {
	const published = new Map();
	const disposers = [];
	const callbacks = [];
	const routes = new Map();
	const reflect = { get: name => published.get(name), provide: (name, value) => { published.set(name, value); return () => published.delete(name); } };
	const effect = factory => { const dispose = factory(); if (typeof dispose === 'function') { disposers.push(dispose); } return dispose; };
	services.connection ??= { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } };
	const ctx = { reflect, effect, inject(keys, callback) { callbacks.push([keys, callback]); if (keys.every(key => services[key])) { const child = { ...services, effect, reflect }; const result = callback(child); if (typeof result === 'function') { disposers.push(result); } } } };
	return { ctx, routes, published, callbacks, services, async stop() { for (const dispose of disposers.reverse()) { await dispose(); } } };
}

test('Host plugin has no client and exposes one neutral resource API with legacy GET alias', async t => {
	const { apply, inject } = await resourcesModule();
	const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
	assert.equal(manifest.exports['./client'], undefined);
	assert.equal(manifest.dsh.client, undefined);
	assert.deepEqual(inject, []);
	const host = context();
	t.after(() => host.stop());
	const service = apply(host.ctx, { pollInterval: 0 });
	apply(host.ctx, { pollInterval: 0 });
	assert.equal(host.published.get('vssarosPluginResources'), service);
	assert.deepEqual(['inspectArchive', 'refresh', 'status', 'list'].map(key => typeof service[key]), ['function', 'function', 'function', 'function']);
	assert.deepEqual([...host.routes.keys()].sort(), ['/api/vssaros-plugin-resources', '/api/vssaros-workbenches/plugin-resources']);
	assert.deepEqual(await (await host.routes.get('/api/vssaros-plugin-resources').fetch()).json(), { packages: [] });
});

test('Bot status without workbench is safe and preset identity comes from Bot service', async t => {
	const { createPluginResourceRegistry } = await resourcesModule();
	const { root, plan } = await fixture(t);
	const registry = createPluginResourceRegistry();
	t.after(() => registry.stop());
	await registry.setService('bots', { registerSource: async () => () => {}, presetIdOf: id => `actual:${id}` });
	await registry.register({ root, plan });
	assert.equal(registry.status(plan.packageName).defaultPreset, 'actual:runtime-helper');
	assert.equal(registry.status(plan.packageName).profile, 'bot');
	assert.equal(registry.status(plan.packageName).resources.mcp[0].state, 'awaiting-service');
});

for (let mask = 0; mask < 8; mask++) {
	test(`optional skills/tools/MCP combination ${mask} does not block Bot`, async t => {
		const { createPluginResourceRegistry } = await resourcesModule();
		const { root, plan } = await fixture(t);
		for (const [bit, kind] of ['skills', 'tools', 'mcp'].entries()) { if (!(mask & (1 << bit))) { plan.resources[kind] = []; } }
		const registry = createPluginResourceRegistry();
		t.after(() => registry.stop());
		let calls = 0;
		await registry.setService('bots', { registerSource: async () => { calls++; return () => {}; }, presetIdOf: id => id });
		await registry.register({ root, plan });
		assert.equal(calls, 1);
		assert.equal(registry.status(plan.packageName).resources.bots[0].state, 'registered');
		await registry.refresh();
		assert.equal(calls, 1);
	});
}

test('pending optional MCP startup cannot block Bot and registered is not connected ready', async t => {
	const { createPluginResourceRegistry } = await resourcesModule();
	const { root, plan } = await fixture(t);
	const gate = deferred();
	const registry = createPluginResourceRegistry();
	t.after(() => registry.stop());
	let mounted = 0;
	await registry.setService('mcp', { ready: gate.promise, registerSource: async () => { mounted++; return () => {}; }, status: () => ({ registered: true, servers: [{ name: 'runtime-remote', state: 'missing-credentials' }] }) });
	await registry.setService('bots', { registerSource: async () => () => {} });
	await registry.register({ root, plan });
	assert.equal(registry.status(plan.packageName).resources.bots[0].state, 'registered');
	assert.equal(mounted, 0);
	gate.resolve();
	await tick();
	await registry.refresh();
	assert.equal(mounted, 1);
	assert.equal(registry.status(plan.packageName).resources.mcp[0].state, 'registered');
	assert.equal(registry.status(plan.packageName).mcp.servers[0].state, 'missing-credentials');
});

test('async disposer failure does not strand other resources or stop package removal', async t => {
	const { createPluginResourceRegistry } = await resourcesModule();
	const { root, plan } = await fixture(t);
	const registry = createPluginResourceRegistry({ warn: () => {} });
	t.after(() => registry.stop());
	const removed = [];
	await registry.setService('bots', { registerSource: async () => async () => { removed.push('bots'); } });
	await registry.setService('skills', { registerProvider: () => async () => { removed.push('skills'); throw new Error('dispose failed'); } });
	await registry.setService('tools', { register: () => async () => { removed.push('tools'); } });
	await registry.setService('mcp', { registerSource: async () => async () => { removed.push('mcp'); } });
	const dispose = await registry.register({ root, plan });
	await dispose();
	assert.deepEqual(removed.sort(), ['bots', 'mcp', 'skills', 'tools']);
	assert.equal(registry.status(plan.packageName), null);
});

test('unavailable service retries; configuration errors do not retry until service replacement', async t => {
	const { createPluginResourceRegistry } = await resourcesModule();
	const { root, plan } = await fixture(t);
	const registry = createPluginResourceRegistry();
	t.after(() => registry.stop());
	let botCalls = 0;
	let toolCalls = 0;
	await registry.setService('bots', { registerSource: async () => { if (++botCalls === 1) { throw new Error('agentPresets 服务还没就绪（Host 还在启动）'); } return () => {}; } });
	await registry.setService('tools', { register: () => { toolCalls++; throw new Error('invalid tool configuration'); } });
	await registry.register({ root, plan });
	assert.equal(registry.status(plan.packageName).resources.bots[0].state, 'awaiting-service');
	await registry.refresh();
	await registry.refresh();
	assert.equal(botCalls, 2);
	assert.equal(toolCalls, 1);
});

test('enabled profile package is discovered once and disable withdraws resources without UI', async t => {
	const { apply } = await resourcesModule();
	const { root, plan } = await fixture(t);
	let enabled = true;
	let resolved = 0;
	let removed = 0;
	const host = context({ pluginManager: { listBundles: async () => [{ name: plan.packageName, version: plan.version, installed: true, enabled }] }, vssarosAgents: { registerSource: async () => () => { removed++; } } });
	t.after(() => host.stop());
	const service = apply(host.ctx, { pollInterval: 0, resolver: async name => { assert.equal(name, plan.packageName); resolved++; return root; }, readPlan: async () => plan });
	await service.refresh();
	assert.equal(service.status(plan.packageName).resources.bots[0].state, 'registered');
	await service.refresh();
	assert.equal(resolved, 1);
	enabled = false;
	await service.refresh();
	assert.equal(removed, 1);
	assert.equal(service.status(plan.packageName), null);
});

test('plan configuration failures are cached by version rather than endlessly reparsed', async t => {
	const { apply } = await resourcesModule();
	let reads = 0;
	const host = context({ pluginManager: { listBundles: async () => [{ name: '@demo/broken', version: '1.0.0', installed: true, enabled: true }] } });
	t.after(() => host.stop());
	const service = apply(host.ctx, { pollInterval: 0, warn: () => {}, resolver: async () => '/unused', readPlan: async () => { reads++; throw new Error('invalid manifest'); } });
	await service.refresh();
	await service.refresh();
	assert.equal(reads, 1);
	assert.equal(service.status('@demo/broken').state, 'error');
});

test('profileContext supplies real installation and profile anchors to injected package resolver', async () => {
	const { installedRoot } = await resourcesModule();
	const calls = [];
	const root = await installedRoot('@demo/bot', { profileRoot: '/real/profile', installAnchor: '/real/installation/package.json', resolveBundleDir: (...args) => { calls.push(args); return '/resolved/bot'; } });
	assert.equal(root, '/resolved/bot');
	assert.deepEqual(calls, [['dsh', '@demo/bot', '/real/installation/package.json', '/real/profile']]);
	await assert.rejects(installedRoot('@demo/bot', {}), /profileContext|profileRoot/);
});

test('upstream resolver discovers newly installed profile package without package.json export', async t => {
	const { installedRoot } = await resourcesModule();
	const { resolveBundleDir } = await import('../../../dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
	const root = await mkdtemp(join(tmpdir(), 'profile-root-resolution-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const profileRoot = join(root, 'profiles/demo');
	const installAnchor = join(root, 'installation/package.json');
	const expected = join(profileRoot, 'node_modules/@demo/new-bot');
	await mkdir(expected, { recursive: true });
	await mkdir(join(root, 'installation'), { recursive: true });
	await writeFile(installAnchor, '{"name":"installation","version":"1.0.0"}');
	await writeFile(join(profileRoot, 'package.json'), '{"name":"profile","version":"1.0.0"}');
	await writeFile(join(expected, 'package.json'), '{"name":"@demo/new-bot","version":"1.0.0","exports":{".":"./lib/index.js"}}');
	assert.equal(await installedRoot('@demo/new-bot', { profileContext: { dir: profileRoot, installAnchor }, resolveBundleDir }), expected);
});
