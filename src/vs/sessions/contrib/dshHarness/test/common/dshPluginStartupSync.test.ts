/*---------------------------------------------------------------------------------------------
 * Copyright (c) Saros. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { hostRunOwnershipFileName } from '../../common/dshHostRunOwnership.js';
import { prepareProfilePluginWrites } from '../../electron-main/dshHostReaper.js';
import { DshHostLeaseStore } from '../../electron-main/dshHostLeaseStore.js';
import { stagePluginDir } from '../../electron-main/dshPluginStaging.js';
import { syncBundledPluginDirs } from '../../electron-main/dshProfileRuntimeSync.js';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';
const source = fs.readFileSync(SUPERVISOR, 'utf8');
function method(name: string): string {
	const ast = ts.createSourceFile(SUPERVISOR, source, ts.ScriptTarget.Latest, true);
	let body = '';
	const visit = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node) && node.name.getText(ast) === name) { body = node.getText(ast); }
		ts.forEachChild(node, visit);
	};
	visit(ast);
	assert.ok(body, name);
	return body;
}

suite('伴生插件启动本地同步', () => {
	let root: string;
	setup(() => root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-startup-')));
	teardown(() => fs.rmSync(root, { recursive: true, force: true }));
	function owner(run: string, appPid: number, hostPid: number, profile = 'vssaros', startedAt = Date.now() - 60_000): void {
		fs.writeFileSync(path.join(root, hostRunOwnershipFileName(run)), JSON.stringify({ format: 1, runId: run, appPid, hostPid, profile, instanceId: `vssaros-${appPid}-test`, startedAt, files: [] }));
	}
	function packageAt(dir: string, body: string): void {
		fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@vssaros/dsh-memory', version: '1.0.22', main: 'lib/index.js' }));
		fs.writeFileSync(path.join(dir, 'lib/index.js'), body);
	}
	const matches = (a: string, b: string): boolean => {
		try { return fs.readFileSync(path.join(a, 'lib/index.js'), 'utf8') === fs.readFileSync(path.join(b, 'lib/index.js'), 'utf8'); } catch { return false; }
	};

	test('死拥有者的同profile Host必须在插件写入前确认退出，不回收其它profile', async () => {
		owner('old', 100, 200);
		owner('other', 101, 201, 'other-profile');
		const alive = new Set([200, 201]);
		const events: string[] = [];
		await prepareProfilePluginWrites({ runDir: root, profile: 'vssaros', selfAppPid: 1, lease: undefined, log() {}, assertCurrent() {},
			isAlive: pid => alive.has(pid), killTree: async pid => { events.push(`kill:${pid}`); }, waitExit: async pid => { events.push(`exit:${pid}`); alive.delete(pid); return true; } });
		events.push('write');
		assert.deepStrictEqual(events, ['kill:200', 'exit:200', 'write']);
		assert.strictEqual(alive.has(201), true);
		assert.ok(fs.existsSync(path.join(root, hostRunOwnershipFileName('other'))));
	});

	test('活跃拥有者、同PID接管者、未知租约及新记录都阻止回收与后续写入', async () => {
		for (const scenario of ['active', 'adopted', 'unknown', 'recent', 'self']) {
			fs.rmSync(root, { recursive: true }); fs.mkdirSync(root);
			owner('old', scenario === 'self' ? 1 : 100, 200, 'vssaros', scenario === 'recent' ? Date.now() : Date.now() - 60_000);
			if (scenario === 'adopted') { owner('new', 101, 200, 'other-profile'); }
			let writes = 0, kills = 0;
			await assert.rejects(async () => {
				await prepareProfilePluginWrites({ runDir: root, profile: 'vssaros', selfAppPid: 1, log() {}, assertCurrent() {},
					lease: scenario === 'unknown' ? { pid: 200, profile: 'vssaros', instanceId: 'unknown' } : undefined,
					isAlive: pid => pid === 200 || scenario === 'active' && pid === 100 || scenario === 'adopted' && pid === 101,
					killTree: async () => { kills++; }, waitExit: async () => true });
				writes++;
			}, /plugin-write-blocked/);
			assert.deepStrictEqual({ writes, kills }, { writes: 0, kills: 0 }, scenario);
		}
	});

	test('仅租约孤儿可被确认回收，活租约拥有者不许动', async () => {
		const lease = { pid: 200, profile: 'vssaros', instanceId: 'vssaros-100-test' };
		let live = true;
		await prepareProfilePluginWrites({ runDir: root, profile: 'vssaros', selfAppPid: 1, lease, log() {}, assertCurrent() {}, isAlive: pid => live && pid === 200,
			killTree: async () => { live = false; }, waitExit: async () => true });
		await assert.rejects(prepareProfilePluginWrites({ runDir: root, profile: 'vssaros', selfAppPid: 1, lease, log() {}, assertCurrent() {}, isAlive: () => true }), /plugin-write-blocked/);
	});

	test('退出失败、generation换代或不可读记录均禁止后续写，退出失败保留owner', async () => {
		owner('old', 100, 200);
		await assert.rejects(prepareProfilePluginWrites({ runDir: root, profile: 'vssaros', selfAppPid: 1, lease: undefined, log() {}, assertCurrent() {},
			isAlive: pid => pid === 200, killTree: async () => {}, waitExit: async () => false }), /未确认退出/);
		assert.ok(fs.existsSync(path.join(root, hostRunOwnershipFileName('old'))));
		let stale = false;
		await assert.rejects(prepareProfilePluginWrites({ runDir: root, profile: 'vssaros', selfAppPid: 1, lease: undefined, log() {},
			assertCurrent: () => { if (stale) { throw new Error('superseded'); } }, isAlive: pid => pid === 200,
			killTree: async () => { stale = true; }, waitExit: async () => true }), /superseded/);
		fs.writeFileSync(path.join(root, 'owner-broken.json'), '{invalid');
		await assert.rejects(prepareProfilePluginWrites({ runDir: root, profile: 'vssaros', selfAppPid: 1, lease: undefined, log() {}, assertCurrent() {} }), /不可读/);
	});

	test('活进程持有超龄锁仍不能破门，未知新锁与排他模式不会当成租约命中', async () => {
		const file = path.join(root, 'host.json.lock');
		const leases = new DshHostLeaseStore(root, () => {});
		for (const value of [JSON.stringify({ pid: process.pid, at: Date.now() - 300_000 }), '']) {
			fs.writeFileSync(file, value);
			await assert.rejects(leases.acquireStartLock(-1, true), /等待超时/);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), value);
		}
		fs.unlinkSync(file);
		assert.strictEqual(await leases.acquireStartLock(1, true), undefined);
		await leases.releaseStartLock();
		assert.strictEqual(fs.existsSync(file), false);
	});

	test('严格暂存先验收、失败保留旧包并清理临时，落位后验收失败也回滚', async () => {
		const src = path.join(root, 'src'), dest = path.join(root, 'dest');
		packageAt(src, 'new'); packageAt(dest, 'old');
		for (const verify of [() => false, (dir: string) => dir !== dest]) {
			await assert.rejects(stagePluginDir({ sourceDir: src, destDir: dest, verify }), /verification failed/);
			assert.strictEqual(fs.readFileSync(path.join(dest, 'lib/index.js'), 'utf8'), 'old');
			assert.deepStrictEqual(fs.readdirSync(root).sort(), ['dest', 'src']);
		}
		await stagePluginDir({ sourceDir: src, destDir: dest, verify: dir => matches(src, dir) });
		assert.strictEqual(matches(src, dest), true);
	});

	test('junction旧副本替换失败保持链接与目标，成功仅替换链接而不改目标', async () => {
		const src = path.join(root, 'src'), old = path.join(root, 'old'), dest = path.join(root, 'dest');
		packageAt(src, 'new'); packageAt(old, 'old');
		fs.symlinkSync(old, dest, 'junction');
		await assert.rejects(stagePluginDir({ sourceDir: src, destDir: dest, verify: () => false }), /verification/);
		assert.ok(fs.lstatSync(dest).isSymbolicLink());
		await stagePluginDir({ sourceDir: src, destDir: dest, verify: dir => matches(src, dir) });
		assert.ok(!fs.lstatSync(dest).isSymbolicLink());
		assert.strictEqual(fs.readFileSync(path.join(old, 'lib/index.js'), 'utf8'), 'old');
	});

	test('源码同步同版本修复后再次调用完全no-op，错误验收不把旧副本算成功', async () => {
		const src = path.join(root, 'src'), profile = path.join(root, 'profile');
		const dest = path.join(profile, 'node_modules/@vssaros/dsh-memory');
		packageAt(src, 'new'); packageAt(dest, 'old');
		const sources = [{ name: '@vssaros/dsh-memory', sourceDir: src }];
		const options = { matches, isSharedProfile: async () => false };
		assert.deepStrictEqual((await syncBundledPluginDirs(sources, profile, options)).synced, ['@vssaros/dsh-memory']);
		assert.strictEqual((await syncBundledPluginDirs(sources, profile, options)).changed, false);
		const rejected = await syncBundledPluginDirs(sources, profile, { ...options, matches: () => false });
		assert.strictEqual(rejected.synced.length, 0);
		assert.strictEqual(rejected.errors.length, 1);
	});

	test('实际直装复制完整资源且只登记成功spec，失败保留旧文件和用户依赖', async () => {
		const src = path.join(root, 'src'), profile = path.join(root, 'profile'), dest = path.join(profile, 'node_modules/@vssaros/dsh-memory');
		packageAt(src, 'new'); packageAt(dest, 'old');
		fs.mkdirSync(path.join(src, 'assets')); fs.writeFileSync(path.join(src, 'assets/image.bin'), 'RESOURCE');
		fs.writeFileSync(path.join(dest, 'obsolete.js'), 'old');
		fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { '@vssaros/dsh-memory': 'file:old', 'user-plugin': '1.0.0' } }));
		interface Host { _installPluginsDirect(wants: object[], staged: string[], profile: string): Promise<string> }
		const context = { Host: undefined as unknown as { new(): Host }, stagePluginDir, fsp: fs.promises, join: path.join, toFileSpec: (value: string) => `file:${value}` };
		const code = ts.transpileModule(`class Host { ${method('_installPluginsDirect')} ${method('_writeProfileDeps')} } globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		vm.runInNewContext(code, context);
		const host = new context.Host();
		Object.assign(host, { _startupPluginProblems: [], _appendLog() {}, _progress() {},
			_readPkgVersion: (file: string) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).version; } catch { return undefined; } },
			_installedEntryMatches: matches });
		const wants = [{ name: '@vssaros/dsh-memory', dir: src, bundled: '1.0.22' }];
		await host._installPluginsDirect(wants, [src], profile);
		assert.strictEqual(fs.readFileSync(path.join(dest, 'assets/image.bin'), 'utf8'), 'RESOURCE');
		assert.ok(!fs.existsSync(path.join(dest, 'obsolete.js')));
		const before = fs.readFileSync(path.join(profile, 'package.json'), 'utf8');
		assert.strictEqual(JSON.parse(before).dependencies['user-plugin'], '1.0.0');
		Object.assign(host, { _installedEntryMatches: () => false });
		await host._installPluginsDirect(wants, [src], profile);
		assert.strictEqual(fs.readFileSync(path.join(dest, 'lib/index.js'), 'utf8'), 'new');
		assert.strictEqual(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), before);
	});

	test('实际本地资格判据只允许无依赖产品包，非空依赖/可选依赖/额外peer/未知包不放行', () => {
		const code = ts.transpileModule(`class Host { ${method('_canInstallLocally')} } globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		const context = { Host: undefined as unknown as { new(): { _canInstallLocally(name: string, dir: string): boolean } }, readFileSync: fs.readFileSync, join: path.join, isBundledRepoPluginName: (name: string) => name.startsWith('@vssaros/') };
		vm.runInNewContext(code, context);
		const host = new context.Host();
		packageAt(root, 'new');
		assert.strictEqual(host._canInstallLocally('@vssaros/dsh-memory', root), true);
		for (const changes of [{ dependencies: { sharp: '1' } }, { optionalDependencies: { sharp: '1' } }, { peerDependencies: { react: '1' } }, { name: 'unknown' }]) {
			fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@vssaros/dsh-memory', version: '1', ...changes }));
			assert.strictEqual(host._canInstallLocally('@vssaros/dsh-memory', root), false);
		}
	});

	test('实际启动块无变化不回收/写入/CLI；变化先确认退出、刷新成功不进入安装CLI', async () => {
		const start = source.indexOf("trace.mark('plugin-plan.begin');");
		const end = source.indexOf('const bridgeVersion:', start);
		assert.ok(start > 0 && end > start);
		const block = source.slice(start, end);
		const code = ts.transpileModule(`async function run() { let pluginWriteLeases; try { ${block} } finally { await pluginWriteLeases?.releaseStartLock(); } } globalThis.run = run;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		for (const scenario of ['unchanged', 'changed', 'blocked', 'local-failed', 'external', 'healed-in-lock']) {
			const events: string[] = [];
			let changed = scenario !== 'unchanged';
			const context = {
				plugins: [['@vssaros/dsh-memory', root, 'memory']], profile: 'vssaros', env: {}, options: {}, generation: 1, process: { pid: 1, env: {} },
				START_LOCK_WAIT_MS: 10, normalizeExistingPath: (v: string) => v, join: path.join,
				trace: { mark() {}, measure: async (_phase: string, fn: () => unknown) => fn() },
				prepareProfilePluginWrites: async () => { events.push('confirmed-exit'); if (scenario === 'blocked') { throw new Error('plugin-write-blocked'); } },
				DshHostLeaseStore: class { read() {} async acquireStartLock() { events.push('lock'); if (scenario === 'healed-in-lock') { changed = false; } } async releaseStartLock() { events.push('unlock'); } },
				DSH_BRIDGE_PLUGIN_NAME: '@vssaros/dsh-bridge', node: {}, dsh: { bin: 'fixture' },
				toFileSpec: (value: string) => value, buildPluginAddArgsMany: () => [],
			};
			const host = {
				_opts: { runDir: root }, _startupPluginProblems: [], _appendLog() {}, _progress() {}, _auditBundledVersions() {}, _throwIfStale() {},
				_profileDir: () => root, effectiveDshHome: () => root, _canInstallLocally: () => scenario !== 'external',
				_planPluginInstall: () => changed ? { name: '@vssaros/dsh-memory', dir: root, bundled: '1', label: 'memory' } : undefined,
				_readPkgVersion: () => '1', _installedEntryMatches: () => !changed,
				_syncBundledPluginDirs: async () => {
					if (scenario === 'local-failed' || scenario === 'external') { return { changed: false, synced: [] }; }
					events.push('write'); changed = false; return { changed: true, synced: ['@vssaros/dsh-memory'] };
				},
				_materializeIfShared: async () => {},
				_installPluginsDirect: async () => { events.push('local-install'); return 'failed'; },
				_runDsh: async () => { assert.strictEqual(scenario, 'external', 'Memory must not invoke CLI'); events.push('cli'); changed = false; return ''; },
				_stagePlugin: async () => { events.push('stage'); return root; },
			};
			const run = vm.runInNewContext(code + '\nrun', context) as () => Promise<void>;
			if (scenario === 'blocked') { await assert.rejects(run.call(host), /plugin-write-blocked/); assert.deepStrictEqual(events, ['lock', 'confirmed-exit', 'unlock']); }
			else if (scenario === 'local-failed') { await assert.rejects(run.call(host), /plugin-local-install-failed/); assert.deepStrictEqual(events, ['lock', 'confirmed-exit', 'stage', 'local-install', 'unlock']); }
			else {
				await run.call(host);
				assert.deepStrictEqual(events, scenario === 'unchanged' ? [] : scenario === 'healed-in-lock' ? ['lock', 'unlock'] : scenario === 'external' ? ['lock', 'confirmed-exit', 'stage', 'cli', 'unlock'] : ['lock', 'confirmed-exit', 'write', 'unlock']);
			}
		}
	});
});
