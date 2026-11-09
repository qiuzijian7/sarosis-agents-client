#!/usr/bin/env node
// P2：本地 Agent 设置页数据端点（检测 / Sign in / 自定义校验 / Refresh 热换路由）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createSettingsService, listEngines, signInFor, validateCustomAgents,
} from '../lib/core/settings.js';
import { apply } from '../lib/index.js';

const fails = [];
let passed = 0;
const check = (name, fn) => {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error?.message ?? error}`); }
};

const onlyCodex = (command) => (command === 'codex' ? '/fake/bin/codex' : undefined);
const probe = (binary) => `v1.2.3 ${binary}`;

check('listEngines：installed/version/custom/models 齐全，不泄露可执行文件路径', () => {
	const rows = listEngines({
		custom: [{ id: 'my', name: 'Mine', command: 'mine', args: ['acp'] }],
		dirs: ['/fake/bin'], resolve: onlyCodex, probe,
	});
	const codex = rows.find((row) => row.route === 'vssaros-codex-cli');
	assert.equal(codex.installed, true);
	assert.match(codex.version, /v1\.2\.3/);
	assert.equal(codex.custom, false);
	assert.equal(codex.signIn, 'codex login');
	assert.ok(codex.models.length > 0);
	const missing = rows.find((row) => row.route === 'vssaros-claude-code');
	assert.equal(missing.installed, false);
	assert.equal(missing.version, undefined);
	const custom = rows.find((row) => row.route === 'vssaros-acp-my');
	assert.equal(custom.custom, true);
	assert.equal(custom.kind, 'acp');
	assert.equal(custom.signIn, '');
	for (const row of rows) assert.equal(row.binary, undefined, '不能把本地路径交给 UI');
});

check('signInFor：返回要复制的命令，不执行；未知/无命令给明确错误', () => {
	const rows = listEngines({ dirs: [], resolve: () => '/fake/x', probe: () => undefined });
	const ok = signInFor(rows, 'vssaros-codex-cli');
	assert.equal(ok.ok, true);
	assert.equal(ok.command, 'codex login');
	assert.match(ok.hint, /不代管 API key/);
	assert.equal(signInFor(rows, 'nope').ok, false);
	assert.equal(signInFor(rows, 'vssaros-acp-x').ok, false);
});

check('validateCustomAgents：逐条给出可读问题，非法项不会进引擎表', () => {
	const report = validateCustomAgents([
		{ id: 'good', name: 'Good', command: 'opencode' },
		{ id: 'bad', name: '', command: 'evil command' },
	]);
	assert.equal(report[0].valid, true);
	assert.equal(report[1].valid, false);
	assert.ok(report[1].problems.length >= 2);
	const rows = listEngines({ custom: [{ id: 'bad', name: '', command: 'evil command' }], dirs: [], resolve: () => undefined, probe });
	assert.equal(rows.some((row) => row.route === 'vssaros-acp-bad'), false);
});

check('★ createSettingsService.refresh()：重扫 + 原子热换路由，快照同步更新', () => {
	let calls = 0;
	const service = createSettingsService({
		custom: [], initialRoutes: ['vssaros-codex-cli'], resolve: onlyCodex, probe,
		refreshRoutes: () => { calls++; return { routes: ['vssaros-codex-cli', 'vssaros-opencode'] }; },
	});
	assert.deepEqual(service.routes(), ['vssaros-codex-cli']);
	const snapshot = service.refresh();
	assert.equal(calls, 1);
	assert.equal(snapshot.ok, true);
	assert.deepEqual(snapshot.routes, ['vssaros-codex-cli', 'vssaros-opencode']);
	assert.deepEqual(service.routes(), snapshot.routes);
	assert.equal(service.list().length, snapshot.engines.length);
	const copy = service.list();
	copy[0].name = 'tampered';
	assert.notEqual(service.list()[0].name, 'tampered', 'list() 必须返回副本');
});

check('refresh 失败兜底：不丢已有快照、不抛给 UI', () => {
	const service = createSettingsService({
		initialRoutes: ['a'], resolve: () => undefined, probe: () => undefined,
		refreshRoutes: () => { throw new Error('扫描失败'); },
	});
	const result = service.refresh();
	assert.equal(result.ok, false);
	assert.match(result.error, /扫描失败/);
	assert.deepEqual(result.routes, ['a']);
});

check('★ apply() 提供 vssarosLocalAgents 服务，Refresh 调 registration.replace', () => {
	const state = { provided: [], registered: [], replaced: [], effects: [] };
	const handle = () => {};
	handle.replace = (routes) => state.replaced.push(routes);
	const ctx = {
		inject(_names, callback) {
			callback({
				llm: {
					registerAdapter(routes, adapter) {
						state.registered.push({ routes, adapter });
						return handle;
					},
				},
				tools: { register() { return () => {}; } },
				get: () => undefined,
				provide(name, service) { state.provided.push({ name, service }); return () => {}; },
				effect(factory) { state.effects.push(factory); return () => {}; },
			});
		},
	};
	// scanRoutes 只认「本机装了」的内置 CLI（自定义 agent 不注册路由）⇒ 造一个探测点。
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-la-settings-'));
	const oldPath = process.env.PATH;
	try {
		writeFileSync(join(dir, 'codex'), '');
		process.env.PATH = dir;
		apply(ctx, { enabled: true, custom: [] });
		assert.equal(state.registered.length, 1);
		assert.ok(state.registered[0].routes.includes('vssaros-codex-cli'));
		assert.equal(state.provided.length, 1);
		const { name, service } = state.provided[0];
		assert.equal(name, 'vssarosLocalAgents');
		assert.equal(typeof service.list, 'function');
		assert.equal(typeof service.refresh, 'function');
		assert.equal(service.signIn('vssaros-codex-cli').command, 'codex login');
		service.refresh();
		assert.equal(state.replaced.length, 1, 'Refresh 必须热换路由');
		assert.ok(Array.isArray(state.replaced[0]));
	} finally {
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
