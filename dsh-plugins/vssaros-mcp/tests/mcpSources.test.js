import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { McpRuntime, readMountPlan } from '../lib/core/mcpRuntime.js';

const http = url => ({ type: 'http', url });
const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};

async function fixture(t, raw = { servers: {} }, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'vssaros-mcp-sources-'));
	const path = join(dir, 'mcp.json');
	if (raw !== null) { await writeFile(path, JSON.stringify(raw)); }
	const services = new Map();
	const cleanups = [];
	const mounts = new Map();
	const events = [];
	const warnings = [];
	const client = { apply() {} };
	const ctx = {
		reflect: { get: name => services.get(name) },
		provide: (name, service) => {
			assert.equal(services.has(name), false, `duplicate service ${name}`);
			services.set(name, service);
		},
		get: () => ({ import: async () => { if (options.load) { await options.load; } return client; } }),
		logger: () => ({ warn: message => warnings.push(message) }),
		inject() {},
		on: () => () => {},
		effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') { cleanups.push(cleanup); } },
		tools: { register: () => () => {}, schemas: () => [] },
		plugin: (_plugin, config) => {
			events.push(`mount:${config.serverName}`);
			mounts.set(config.serverName, config);
			return {
				await: async () => { if (options.awaitMount) { await options.awaitMount(config); } },
				dispose: async () => {
					events.push(`unmount:${config.serverName}`);
					mounts.delete(config.serverName);
					if (options.disposeMount) { await options.disposeMount(config); }
				},
			};
		},
	};
	apply(ctx, { path });
	const service = services.get('vssarosMcpSources');
	t.after(async () => {
		await Promise.all(cleanups.reverse().map(cleanup => cleanup()));
		await rm(dir, { recursive: true, force: true });
	});
	return { ctx, service, path, dir, mounts, events, warnings };
}

test('publishes one source service and runtime across host/preset apply', async t => {
	const f = await fixture(t);
	assert.ok(f.service, 'vssarosMcpSources must be publicly provided');
	await f.service.ready;
	apply(f.ctx, { path: f.path });
	const dispose = await f.service.registerSource({ owner: 'local:wb', servers: { wb_docs: http('https://docs.example/mcp') } });
	assert.deepEqual(f.events, ['mount:wb_docs']);
	assert.equal(typeof dispose, 'function');
	await dispose();
	assert.equal(f.mounts.size, 0);
});

test('merges global and two isolated sources without writing user mcp.json', async t => {
	const raw = { inputs: [{ id: 'keep' }], servers: { global: http('https://global.example/mcp') } };
	const f = await fixture(t, raw);
	assert.ok(f.service);
	await f.service.ready;
	const before = await readFile(f.path, 'utf8');
	const disposeA = await f.service.registerSource({ owner: 'a', servers: { wb_a: http('https://a.example/mcp') } });
	const disposeB = await f.service.registerSource({ owner: 'b', servers: { wb_b: http('https://b.example/mcp') } });
	assert.deepEqual([...f.mounts.keys()].sort(), ['global', 'wb_a', 'wb_b']);
	assert.deepEqual(f.service.status('a').servers, [{ name: 'wb_a', state: 'ready' }]);
	await disposeA();
	assert.deepEqual([...f.mounts.keys()].sort(), ['global', 'wb_b']);
	await disposeA();
	await disposeB();
	assert.equal(await readFile(f.path, 'utf8'), before);
});

test('sources work when user mcp.json does not exist and global deletion unmounts', async t => {
	const f = await fixture(t, null);
	assert.ok(f.service);
	await f.service.ready;
	await f.service.registerSource({ owner: 'wb', servers: { wb_docs: http('https://docs.example/mcp') } });
	await writeFile(f.path, JSON.stringify({ servers: { global: http('https://global.example/mcp') } }));
	await f.service.reconcile();
	await rm(f.path);
	await f.service.reconcile();
	assert.deepEqual([...f.mounts.keys()], ['wb_docs']);
	await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('stdio retains explicit approval gate including reload', async t => {
	const f = await fixture(t);
	assert.ok(f.service);
	await f.service.ready;
	await f.service.registerSource({ owner: 'wb', servers: { wb_cmd: { type: 'stdio', command: 'fake-command' } } });
	assert.equal(f.mounts.has('wb_cmd'), false);
	assert.equal(f.service.status('wb').servers[0].state, 'needs-approval');
	await f.service.reloadSource({ owner: 'wb', servers: { wb_cmd: { type: 'stdio', command: 'fake-command', approved: true } } });
	assert.equal(f.mounts.has('wb_cmd'), true);
	await f.service.reloadSource({ owner: 'wb', servers: { wb_cmd: { type: 'stdio', command: 'fake-command', approved: false } } });
	assert.equal(f.mounts.has('wb_cmd'), false);
});

test('owner, cross-source and global conflicts reject without replacing mounts', async t => {
	const f = await fixture(t, { servers: { global: http('https://global.example/mcp') } });
	assert.ok(f.service);
	await f.service.ready;
	await f.service.registerSource({ owner: 'a', servers: { wb_a: http('https://a.example/mcp') } });
	for (const request of [
		{ owner: 'a', servers: {} },
		{ owner: 'b', servers: { wb_a: http('https://b.example/mcp') } },
		{ owner: 'b', servers: { global: http('https://b.example/mcp') } },
	]) { await assert.rejects(f.service.registerSource(request), /conflict|registered/i); }
	assert.deepEqual([...f.mounts.keys()].sort(), ['global', 'wb_a']);
	assert.equal(f.service.status('b').registered, false);
});

test('reconcile rejects newly introduced global conflicts without silent shadowing', async t => {
	const f = await fixture(t);
	assert.ok(f.service);
	await f.service.ready;
	await f.service.registerSource({ owner: 'a', servers: { wb_a: http('https://a.example/mcp') } });
	await writeFile(f.path, JSON.stringify({ servers: { wb_a: http('https://global.example/mcp') } }));
	await assert.rejects(f.service.reconcile(), /conflict/i);
	assert.equal(f.mounts.get('wb_a').url, 'https://a.example/mcp');
});

test('status reflects actual connecting and failed handshake, never parse-ready', async t => {
	const gate = deferred();
	const entered = deferred();
	const f = await fixture(t, undefined, { awaitMount: async config => {
		if (config.serverName === 'wb_bad') { entered.resolve(); await gate.promise; }
	} });
	assert.ok(f.service);
	await f.service.ready;
	const registration = f.service.registerSource({ owner: 'wb', servers: { wb_bad: http('https://bad.example/mcp') } });
	await entered.promise;
	assert.equal(f.service.status('wb').servers[0].state, 'connecting');
	gate.reject(new Error('handshake failed'));
	await registration;
	assert.equal(f.service.status('wb').servers[0].state, 'error');
	assert.equal(f.mounts.has('wb_bad'), false);
});

test('reload, unregister and reconcile run serially; stale disposer cannot remove replacement', async t => {
	const gate = deferred();
	const entered = deferred();
	const f = await fixture(t, undefined, { awaitMount: async config => {
		if (config.url === 'https://slow.example/mcp') { entered.resolve(); await gate.promise; }
	} });
	assert.ok(f.service);
	await f.service.ready;
	const oldDispose = await f.service.registerSource({ owner: 'wb', servers: { wb_docs: http('https://initial.example/mcp') } });
	const reload = f.service.reloadSource({ owner: 'wb', servers: { wb_docs: http('https://slow.example/mcp') } });
	await entered.promise;
	const unregister = f.service.unregisterSource('wb');
	const reconcile = f.service.reconcile();
	assert.equal(f.mounts.get('wb_docs').url, 'https://slow.example/mcp');
	gate.resolve();
	await Promise.all([reload, unregister, reconcile]);
	assert.equal(f.mounts.has('wb_docs'), false);
	await f.service.registerSource({ owner: 'wb', servers: { wb_docs: http('https://new.example/mcp') } });
	await oldDispose();
	assert.equal(f.mounts.get('wb_docs').url, 'https://new.example/mcp');
});

test('config copies preserve credential references and route through gateway', async t => {
	const f = await fixture(t);
	assert.ok(f.service);
	await writeFile(join(f.dir, 'mcp-secrets.json'), JSON.stringify({ secrets: {} }));
	const previous = process.env.MCP_SOURCE_TEST_TOKEN;
	process.env.MCP_SOURCE_TEST_TOKEN = 'source-sensitive-value';
	t.after(() => { if (previous === undefined) { delete process.env.MCP_SOURCE_TEST_TOKEN; } else { process.env.MCP_SOURCE_TEST_TOKEN = previous; } });
	await f.service.ready;
	const servers = { wb_secure: { type: 'http', url: 'https://secure.example/mcp', headers: { Authorization: 'Bearer ${env:MCP_SOURCE_TEST_TOKEN}' }, query: { key: '${env:MCP_SOURCE_TEST_TOKEN}' } } };
	const original = JSON.stringify(servers);
	await f.service.registerSource({ owner: 'wb', servers });
	assert.match(f.mounts.get('wb_secure').url, /^http:\/\/127\.0\.0\.1:\d+\/c\/wb_secure$/);
	assert.equal(JSON.stringify(f.mounts.get('wb_secure')).includes('source-sensitive-value'), false);
	assert.equal(JSON.stringify(servers), original);
	servers.wb_secure.url = 'https://mutated.example/mcp';
	await f.service.reconcile();
	assert.equal(f.service.status('wb').servers[0].state, 'ready');
	assert.equal(JSON.stringify(f.service.status('wb')).includes('source-sensitive-value'), false);
});

test('runtime mount failures cannot leak credential values into status or logs', async t => {
	const f = await fixture(t, undefined, { awaitMount: async () => { throw new Error('token=source-sensitive-value'); } });
	assert.ok(f.service);
	await f.service.ready;
	await f.service.registerSource({ owner: 'wb', servers: { wb_secret: { type: 'stdio', approved: true, command: 'fake', env: { TOKEN: 'source-sensitive-value' } } } });
	assert.equal(f.service.status('wb').servers[0].state, 'error');
	assert.equal(JSON.stringify(f.warnings).includes('source-sensitive-value'), false);
	assert.equal(JSON.stringify(f.service.status('wb')).includes('source-sensitive-value'), false);
});

test('register explicitly rejects unready, disabled and stopped runtime', async t => {
	const load = deferred();
	const f = await fixture(t, undefined, { load: load.promise });
	assert.ok(f.service);
	await assert.rejects(f.service.registerSource({ owner: 'wb', servers: {} }), /unavailable/i);
	load.resolve();
	await f.service.ready;
	const previous = process.env.VSSAROS_MCP_RUNTIME_MOUNT;
	process.env.VSSAROS_MCP_RUNTIME_MOUNT = '0';
	const disabled = await fixture(t);
	if (previous === undefined) { delete process.env.VSSAROS_MCP_RUNTIME_MOUNT; } else { process.env.VSSAROS_MCP_RUNTIME_MOUNT = previous; }
	assert.ok(disabled.service);
	assert.equal(disabled.service.status('wb').available, false);
	await assert.rejects(disabled.service.registerSource({ owner: 'wb', servers: {} }), /unavailable/i);
	await f.service.stop();
	assert.equal(f.service.status('wb').available, false);
	await assert.rejects(f.service.registerSource({ owner: 'wb', servers: {} }), /unavailable/i);
});

test('readMountPlan accepts in-memory sources while preserving raw references and rejecting collisions', async t => {
	const dir = await mkdtemp(join(tmpdir(), 'vssaros-mcp-plan-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, 'mcp.json');
	await writeFile(path, JSON.stringify({ servers: { global: http('https://global.example/mcp') } }));
	const plan = await readMountPlan(path, { TOKEN: 'private' }, { wb_secure: { type: 'http', url: 'https://secure.example/mcp', headers: { Authorization: '${env:TOKEN}' } } });
	assert.equal(plan.servers.length, 2);
	assert.equal(plan.rawConfig.servers.wb_secure.headers.Authorization, '${env:TOKEN}');
	await assert.rejects(readMountPlan(path, {}, { global: http('https://collision.example/mcp') }), /conflict/i);
});

test('credential rotation updates live gateway headers and query without changing client config', async t => {
	const realFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, options) => {
		calls.push({ url, headers: options.headers });
		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	};
	t.after(() => { globalThis.fetch = realFetch; });
	const f = await fixture(t);
	await f.service.ready;
	const secretsPath = join(f.dir, 'mcp-secrets.json');
	await writeFile(secretsPath, JSON.stringify({ secrets: { wb: { token: 'first-secret' } } }));
	await f.service.registerSource({ owner: 'wb', servers: {
		wb_secure: { type: 'http', url: 'https://secure.example/mcp', headers: { Authorization: 'Bearer ${env:MCP_WB_TOKEN}' }, query: { key: '${env:MCP_WB_TOKEN}' } },
	} });
	const clientConfig = f.mounts.get('wb_secure');
	const request = () => realFetch(clientConfig.url, { method: 'POST', headers: clientConfig.headers, body: '{}' });
	assert.equal((await request()).status, 200);
	assert.equal(calls[0].headers.Authorization, 'Bearer first-secret');
	assert.equal(new URL(calls[0].url).searchParams.get('key'), 'first-secret');
	await writeFile(secretsPath, JSON.stringify({ secrets: { wb: { token: 'rotated-secret' } } }));
	await f.service.reconcile();
	assert.deepEqual(f.mounts.get('wb_secure'), clientConfig);
	assert.equal((await request()).status, 200);
	assert.equal(calls[1].headers.Authorization, 'Bearer rotated-secret');
	assert.equal(new URL(calls[1].url).searchParams.get('key'), 'rotated-secret');
	await f.service.registerSource({ owner: 'other', servers: {
		other_secure: { type: 'http', url: 'https://other.example/mcp', headers: { Authorization: 'Bearer ${env:MCP_WB_TOKEN}' } },
	} });
	await f.service.unregisterSource('wb');
	assert.equal((await request()).status, 404);
	assert.equal(f.mounts.has('other_secure'), true);
	assert.equal(JSON.stringify(f.warnings).includes('rotated-secret'), false);
});

test('query-only missing credential is skipped, not declared ready from parsing', async t => {
	const f = await fixture(t);
	await f.service.ready;
	await f.service.registerSource({ owner: 'wb', servers: {
		wb_secure: { type: 'http', url: 'https://secure.example/mcp', query: { key: '${env:MCP_MISSING_SOURCE_CREDENTIAL}' } },
	} });
	assert.equal(f.mounts.has('wb_secure'), false);
	assert.equal(f.service.status('wb').servers[0].state, 'error');
});

test('credential URL references cannot leak into mcp-client config', async t => {
	const f = await fixture(t);
	await f.service.ready;
	await writeFile(join(f.dir, 'mcp-secrets.json'), JSON.stringify({ secrets: { wb: { token: 'url-secret' } } }));
	await f.service.registerSource({ owner: 'wb', servers: {
		wb_secure: { type: 'http', url: 'https://secure.example/mcp?key=${env:MCP_WB_TOKEN}' },
	} });
	assert.match(f.mounts.get('wb_secure').url, /^http:\/\/127\.0\.0\.1:/);
	assert.equal(JSON.stringify(f.mounts.get('wb_secure')).includes('url-secret'), false);
});

test('disabled gateway refuses plugin credentials rather than falling back to cleartext', async t => {
	const f = await fixture(t);
	await f.service.ready;
	const previous = process.env.VSSAROS_MCP_GATEWAY;
	process.env.VSSAROS_MCP_GATEWAY = '0';
	t.after(() => { if (previous === undefined) { delete process.env.VSSAROS_MCP_GATEWAY; } else { process.env.VSSAROS_MCP_GATEWAY = previous; } });
	await f.service.registerSource({ owner: 'wb', servers: {
		wb_secure: { type: 'http', url: 'https://secure.example/mcp', headers: { Authorization: 'Bearer private' } },
	} });
	assert.equal(f.mounts.has('wb_secure'), false);
	assert.equal(f.service.status('wb').servers[0].state, 'unavailable');
});

test('stop during handshake disposes in-flight mount and rejects registration without resurrection', async t => {
	const gate = deferred();
	const entered = deferred();
	const f = await fixture(t, undefined, {
		awaitMount: async () => { entered.resolve(); await gate.promise; },
		disposeMount: () => { gate.reject(new Error('cancelled with secret')); },
	});
	await f.service.ready;
	const registration = f.service.registerSource({ owner: 'wb', servers: { wb_docs: http('https://docs.example/mcp') } });
	const rejected = assert.rejects(registration, /unavailable/i);
	await entered.promise;
	await f.service.stop();
	await rejected;
	assert.equal(f.mounts.size, 0);
	assert.deepEqual(f.service.status('wb'), { owner: 'wb', available: false, registered: false, servers: [] });
});

test('stop while loading client prevents late runtime initialization', async t => {
	const load = deferred();
	const f = await fixture(t, undefined, { load: load.promise });
	const ready = assert.rejects(f.service.ready, /unavailable/i);
	const stopping = f.service.stop();
	load.resolve();
	await Promise.all([stopping, ready]);
	assert.equal(f.service.status('wb').available, false);
	assert.equal(f.mounts.size, 0);
});

test('failed reload conflict preserves old source and disposer', async t => {
	const f = await fixture(t);
	await f.service.ready;
	const dispose = await f.service.registerSource({ owner: 'a', servers: { wb_a: http('https://a.example/mcp') } });
	await f.service.registerSource({ owner: 'b', servers: { wb_b: http('https://b.example/mcp') } });
	await assert.rejects(f.service.reloadSource({ owner: 'a', servers: { wb_b: http('https://collision.example/mcp') } }), /conflict/i);
	assert.deepEqual(f.service.status('a').servers, [{ name: 'wb_a', state: 'ready' }]);
	await dispose();
	assert.deepEqual([...f.mounts.keys()], ['wb_b']);
});

test('initial configuration failure can recover readiness after a successful reconcile', async t => {
	const f = await fixture(t, { servers: [] });
	await assert.rejects(f.service.ready, /unavailable/i);
	assert.equal(f.service.status('wb').available, false);
	await writeFile(f.path, JSON.stringify({ servers: {} }));
	await f.service.reconcile();
	await f.service.ready;
	await f.service.registerSource({ owner: 'wb', servers: { wb_docs: http('https://docs.example/mcp') } });
	assert.equal(f.service.status('wb').servers[0].state, 'ready');
});

test('prototype-like legal server names remain own entries with honest status and conflict checks', async t => {
	const f = await fixture(t);
	await f.service.ready;
	const servers = Object.fromEntries(['__proto__', 'constructor'].map(name => [name, http('https://docs.example/mcp')]));
	const dispose = await f.service.registerSource({ owner: 'wb', servers });
	assert.deepEqual(f.service.status('wb').servers, [
		{ name: '__proto__', state: 'ready' },
		{ name: 'constructor', state: 'ready' },
	]);
	await assert.rejects(f.service.registerSource({ owner: 'other', servers }), /conflict/i);
	await dispose();
	assert.equal(f.mounts.size, 0);
});

test('source snapshot never infers ready from a fiber when actual status is absent', async t => {
	const f = await fixture(t);
	await f.service.ready;
	await f.service.registerSource({ owner: 'wb', servers: { wb_docs: http('https://docs.example/mcp') } });
	const original = McpRuntime.prototype.statusView;
	McpRuntime.prototype.statusView = () => ({});
	t.after(() => { McpRuntime.prototype.statusView = original; });
	assert.deepEqual(f.service.status('wb').servers, [{ name: 'wb_docs', state: 'connecting' }]);
});

test('full runtime status exposes ready only after successful fiber await', async () => {
	const gate = deferred();
	const entered = deferred();
	const runtime = new McpRuntime({ ctx: { plugin: () => ({
		await: async () => { entered.resolve(); await gate.promise; }, dispose() {},
	}) }, client: {} });
	const syncing = runtime.sync([{ serverName: 'wb_docs', transport: 'streamable-http', url: 'https://docs.example/mcp' }]);
	await entered.promise;
	assert.deepEqual(runtime.statusView({ includeReady: true }), { wb_docs: { state: 'connecting' } });
	gate.resolve();
	await syncing;
	assert.deepEqual(runtime.statusView({ includeReady: true }), { wb_docs: { state: 'ready' } });
	assert.deepEqual(runtime.statusView(), {});
	await runtime.stop();
	assert.deepEqual(runtime.statusView({ includeReady: true }), {});
});

test('McpRuntime sync after stop cannot reintroduce mounts or connecting status', async () => {
	const runtime = new McpRuntime({ ctx: { plugin() { throw new Error('must not mount'); } }, client: {} });
	await runtime.stop();
	await runtime.sync([{ serverName: 'wb_docs', transport: 'streamable-http', url: 'https://docs.example/mcp' }]);
	assert.equal(runtime.mounts.size, 0);
	assert.deepEqual(runtime.statusView(), {});
});
