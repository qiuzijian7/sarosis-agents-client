import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { shouldProvideSchedule } from '../lib/engine.js';
import { migrateYamlText } from '../lib/migrate.js';

const TOOL_NAMES = ['create', 'list', 'update', 'delete', 'history'].map(name => `vssaros_schedule_${name}`);
const YAML = 'schedules:\n  - name: nightly\n    type: cron\n    prompt: tidy\n    cron: 0 1 * * *\n';

function harness(root, officialFirst = true) {
	const official = { deliveryLimits: { maxTasksPerSession: 20 } };
	const services = new Map(officialFirst ? [['schedule', official]] : []);
	const definitions = new Map();
	const effects = [];
	const events = [];
	const routes = [];
	services.set('vssarosFoundation', { dataRootOf: () => root });
	services.set('tools', { register(def) { assert.ok(!definitions.has(def.name)); definitions.set(def.name, def); return () => definitions.delete(def.name); } });
	function context() {
		const ctx = {
			reflect: { get: (name) => services.get(name) },
			get: (name) => services.get(name),
			provide(name, value) { assert.ok(!services.has(name), `service ${name} already registered`); services.set(name, value); },
			inject(names, callback) { if (names.every(name => services.has(name))) callback(context()); return { dispose() {} }; },
			effect(fn) { const off = fn(); if (typeof off === 'function') effects.push(off); return off; },
			on(name, callback) { events.push({ name, callback }); return () => {}; },
			logger: () => ({ info() {}, warn() {}, error() {} }),
		};
		return new Proxy(ctx, { get(target, key) { if (Reflect.has(target, key)) return Reflect.get(target, key); return services.get(key); } });
	}
	return { ctx: context(), services, definitions, events, routes, official, dispose() { for (const off of effects.splice(0).reverse()) off(); } };
}

function withRoot(fn) {
	const root = mkdtempSync(join(import.meta.dirname, '.isolation-'));
	try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const officialFirst of [true, false]) {
	test(`官方 schedule ${officialFirst ? '先' : '后'}注册不冲突，自建任务库与五工具隔离`, () => withRoot(root => {
		const h = harness(root, officialFirst);
		try {
			apply(h.ctx, {});
			if (!officialFirst) h.ctx.provide('schedule', h.official);
			assert.equal(h.services.get('schedule'), h.official);
			const engine = h.services.get('vssarosScheduler');
			assert.ok(engine);
			assert.notEqual(engine, h.official);
			assert.deepEqual([...h.definitions.keys()].sort(), [...TOOL_NAMES].sort());
			engine.create({ id: 'dream-1', title: 'Dream', kind: 'action', action: { service: 'memory-evolve', method: 'dream.run', args: {} }, rule: { kind: 'daily', time: '01:00' } });
			const saved = JSON.parse(readFileSync(join(root, 'scheduler', 'tasks.json'), 'utf8'));
			assert.equal(saved.tasks[0].action.method, 'dream.run');
			assert.equal(saved.tasks[0].id, 'dream-1');
			apply(h.ctx, {});
			assert.equal(h.services.get('vssarosScheduler'), engine, '双 plane 应复用自家实例');
			assert.equal(h.definitions.size, 5, '第二次 apply 不重复注册工具');
			const gate = h.events.find(event => event.name === 'tools/pre-execute').callback;
			assert.equal(gate({ name: 'schedule_create' }, () => 'official'), 'official');
			assert.equal(gate({ name: 'vssaros_schedule_create', arguments: {} }, () => 'unexpected').kind, 'ask');
		} finally { h.dispose(); }
	}));
}

test('离线工具快照及时退出且不读取或推进操作员任务库', () => withRoot(root => {
	mkdirSync(join(root, 'scheduler'));
	const file = join(root, 'scheduler', 'tasks.json');
	const before = JSON.stringify({ tasks: [{ id: 'sentinel', title: 'private', status: 'active', kind: 'action',
		action: { service: 'memory-evolve', method: 'dream.run', args: {} }, rule: { kind: 'daily', time: '01:00' }, next: { target: 1 } }], history: [] });
	writeFileSync(file, before);
	const run = spawnSync(process.execPath, [fileURLToPath(new URL('../../tools-snapshot.mjs', import.meta.url)), '--only', 'vssaros-scheduler'],
		{ timeout: 5000, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', VSSAROS_DATA_ROOT: root } });
	assert.equal(run.status, 0, String(run.error || run.stderr || run.stdout));
	assert.equal(readFileSync(file, 'utf8'), before);
}));

test('撞键探测只查 vssarosScheduler，不以官方 schedule 决定自建是否可用', () => {
	const queried = [];
	const own = { onFire() {} };
	const ctx = { reflect: { get(name) { queried.push(name); return name === 'vssarosScheduler' ? own : {}; } } };
	assert.equal(shouldProvideSchedule(ctx).ok, false);
	assert.deepEqual(queried, ['vssarosScheduler']);
	assert.equal(shouldProvideSchedule({ schedule: {} }).ok, true);
});

test('迁移只用自建服务，同步 list 可用且重跑幂等，不调用官方接口', async () => {
	const tasks = [];
	const own = { list: () => tasks, create: (task) => { tasks.push(task); return task; } };
	const ctx = { get: (name) => name === 'vssarosScheduler' ? own : undefined, schedule: { list() { throw new Error('official must not be used'); }, create() { throw new Error('official must not be used'); } } };
	const first = await migrateYamlText(ctx, 'bot', YAML, { timeZone: 'UTC' });
	assert.equal(first.created, 1, first.failed.join('; '));
	assert.equal(first.failed.length, 0);
	const second = await migrateYamlText(ctx, 'bot', YAML, { timeZone: 'UTC' });
	assert.equal(second.skipped, 1);
	assert.equal(tasks.length, 1);
});

test('只有官方 schedule 时迁移安全报自建不可用，不触碰官方库', async () => {
	let calls = 0;
	const ctx = { get: () => undefined, schedule: { list() { calls++; return []; }, create() { calls++; } } };
	const result = await migrateYamlText(ctx, 'bot', YAML);
	assert.equal(result.created, 0);
	assert.equal(result.failed.length, 1);
	assert.equal(calls, 0);
});
