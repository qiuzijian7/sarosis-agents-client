/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「单版本 bundled + 用户数据永不覆盖 / 插件层随版本同步」守卫（2026-11-09 / 11-12 修订）。
 *
 * 产品口径：dsh 版本由 `dsh-compat.json` 的 `bundled` 在构建期 pin 死，版本升级 = 应用发版；
 * **应用升级不替换 workspace / session / model 配置等用户数据**。
 *
 * ★★ 2026-11-12 修订（真机 `2.2.26237` / dsh `0.2.2-rc.2` 的「控制桥不可用」）：
 *   11-09 曾把口径收紧成「profile 已存在就原样返回、一个字节都不改」，但 bundled 从
 *   `0.2.1-rc.2` 升级后，dev 的旧 profile 里 `cordis.patch.yml` / `package.json` 仍指向
 *   `@deepseek-ai/dsh-web-app@0.2.1-rc.2` ⇒ 被判 incompatible 而禁用 ⇒ `webStartup` 缺失
 *   ⇒ Host `code 1`。打包版新机器首启用同版本种子不会踩，只有复用旧 profile 会踩。
 *   ⇒ 现在：**用户数据永不覆盖，但随包插件层（种子顶层条目）必须随 bundled 版本同步**。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshProfileRuntimeSync
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
	copyProfileSeed, planProfileRuntimeSync, PROFILE_RUNTIME_MARKER_REL, profileSeedDirFor,
	readProfileRuntimeVersion, syncProfilePluginLayer, writeProfileRuntimeMarker,
} from '../../electron-main/dshProfileRuntimeSync.js';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';
const MANAGER = 'src/vs/sessions/contrib/dshHarness/electron-main/dshRuntimeManager.ts';
const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 源码断言必须基于**去掉注释**的代码：注释里会写出函数名/标记名，直接查文本会被骗成假绿。 */
function code(rel: string): string {
	return read(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.filter(l => !/^\s*\/\//.test(l))
		.join('\n');
}

suite('dshHarness / 单版本 bundled + 插件层版本同步', () => {

	// ── ① 首启种子复制 ────────────────────────────────────────────────────────
	test('1) ★ 种子复制必须解引用 symlink（Windows 非管理员下裸 fsp.cp 会 EPERM ⇒ 首启崩溃）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-links-'));
		const src = path.join(root, 'seed');
		const dest = path.join(root, 'dest');
		try {
			fs.mkdirSync(path.join(src, 'real'), { recursive: true });
			fs.writeFileSync(path.join(src, 'real', 'a.txt'), 'FROM-REAL');
			fs.writeFileSync(path.join(src, 'package.json'), '{}');
			fs.symlinkSync(path.join(src, 'real'), path.join(src, 'link'), 'junction');
			await copyProfileSeed(src, dest);
			const linked = fs.lstatSync(path.join(dest, 'link'));
			assert.ok(linked.isDirectory() && !linked.isSymbolicLink(), '★ 链接必须被解引用成真实目录');
			assert.strictEqual(fs.readFileSync(path.join(dest, 'link', 'a.txt'), 'utf8'), 'FROM-REAL', '内容要真的复制过来');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
		const mod = code('src/vs/sessions/contrib/dshHarness/electron-main/dshProfileRuntimeSync.ts');
		assert.match(mod, /dereference: true/, 'copyProfileSeed 必须显式 dereference: true');
	});

	for (const manifest of [undefined, '{ broken json', 'null', '[]']) {
		test(`种子缺失或无效 manifest 不得落位：${manifest ?? '(缺失)'}`, async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-invalid-'));
			try {
				const seed = path.join(root, 'seed'), dest = path.join(root, 'dest');
				fs.mkdirSync(seed);
				fs.writeFileSync(path.join(seed, 'copied.txt'), 'PARTIAL');
				if (manifest !== undefined) {
					fs.writeFileSync(path.join(seed, 'package.json'), manifest);
				}
				await assert.rejects(() => copyProfileSeed(seed, dest));
				assert.deepStrictEqual(fs.readdirSync(root), ['seed'], '不得留下可被 init/stamp 误认的目标或临时目录');
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}

	test('种子复制不得合并或覆盖已有目标（包括空目录）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-existing-'));
		try {
			const seed = path.join(root, 'seed');
			fs.mkdirSync(seed);
			fs.writeFileSync(path.join(seed, 'package.json'), '{}');
			for (const name of ['empty', 'existing']) {
				const dest = path.join(root, name);
				fs.mkdirSync(dest);
				if (name === 'existing') {
					fs.writeFileSync(path.join(dest, 'package.json'), '{"user":true}');
				}
				await assert.rejects(() => copyProfileSeed(seed, dest));
				assert.deepStrictEqual(fs.readdirSync(dest), name === 'empty' ? [] : ['package.json']);
				if (name === 'existing') {
					assert.strictEqual(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{"user":true}');
				}
			}
			assert.deepStrictEqual(fs.readdirSync(root).sort(), ['empty', 'existing', 'seed']);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('并发复制只有一个原子落位，失败调用不得清理获胜者', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-race-'));
		try {
			const seed = path.join(root, 'seed'), dest = path.join(root, 'dest');
			fs.mkdirSync(seed);
			fs.writeFileSync(path.join(seed, 'package.json'), '{}');
			fs.writeFileSync(path.join(seed, 'ready.txt'), 'COMPLETE');
			const results = await Promise.allSettled(Array.from({ length: 8 }, () => copyProfileSeed(seed, dest)));
			assert.strictEqual(results.filter(r => r.status === 'fulfilled').length, 1);
			assert.strictEqual(fs.readFileSync(path.join(dest, 'ready.txt'), 'utf8'), 'COMPLETE');
			assert.deepStrictEqual(fs.readdirSync(root).sort(), ['dest', 'seed']);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('种子校验失败时必须原样保留 profile，不产生备份/半成品', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-rollback-'));
		try {
			const seed = path.join(root, 'seed'), profile = path.join(root, 'profile');
			fs.mkdirSync(seed);
			fs.writeFileSync(path.join(seed, 'package.json'), '{ broken json');
			fs.mkdirSync(profile);
			fs.writeFileSync(path.join(profile, 'keep.txt'), 'USER-DATA');
			await assert.rejects(() => syncProfilePluginLayer(seed, profile));
			assert.strictEqual(fs.readFileSync(path.join(profile, 'keep.txt'), 'utf8'), 'USER-DATA');
			assert.strictEqual(fs.existsSync(path.join(profile, 'package.json')), false, '坏种子不许写 profile');
			assert.deepStrictEqual(fs.readdirSync(root).sort(), ['profile', 'seed']);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('2) 种子按版本找：只有版本匹配且 package.json 存在才返回', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-seed-'));
		try {
			const seed = path.join(root, 'dsh-runtime', '0.2.1-rc.2', 'profile-seed', 'profiles', 'vssaros');
			fs.mkdirSync(seed, { recursive: true });
			fs.writeFileSync(path.join(seed, 'package.json'), '{}');
			assert.strictEqual(profileSeedDirFor(path.join(root, 'dsh-runtime'), '0.2.1-rc.2', 'vssaros'), seed,
				'runtimeRoot 本身就是 dsh-runtime 目录，不许再拼一层');
			assert.strictEqual(profileSeedDirFor(path.join(root, 'dsh-runtime'), '0.2.1-alpha.3', 'vssaros'), undefined,
				'版本不匹配 ⇒ 绝不拿别的版本的种子');
			assert.strictEqual(profileSeedDirFor(undefined, '0.2.1-rc.2', 'vssaros'), undefined);
			fs.rmSync(path.join(seed, 'package.json'));
			assert.strictEqual(profileSeedDirFor(path.join(root, 'dsh-runtime'), '0.2.1-rc.2', 'vssaros'), undefined,
				'半成品种子不可用');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	// ── ② 用户数据永不覆盖 / 插件层随版本同步 ────────────────────────────────
	test('3) ★ planProfileRuntimeSync 的五种判定（含「无种子绝不重建」「无 marker 只 stamp」）', () => {
		const seed = '/seed/0.2.2-rc.2';
		assert.deepStrictEqual(planProfileRuntimeSync({ profileExists: false, dshVersion: '0.2.2-rc.2', seedDir: seed }),
			{ kind: 'init', seedDir: seed }, '首次创建走种子');
		assert.deepStrictEqual(planProfileRuntimeSync({ profileExists: false, dshVersion: '0.2.2-rc.2' }),
			{ kind: 'init' }, '没种子就退回模板初始化');
		assert.deepStrictEqual(planProfileRuntimeSync({ profileExists: true, dshVersion: '0.2.2-rc.2' }),
			{ kind: 'stamp' }, '★ 老 profile 无 marker：只登记，绝不动文件');
		assert.deepStrictEqual(planProfileRuntimeSync({ profileExists: true, dshVersion: '0.2.2-rc.2', markerVersion: '0.2.2-rc.2' }),
			{ kind: 'keep' }, '同版本直接返回');
		assert.deepStrictEqual(planProfileRuntimeSync({ profileExists: true, dshVersion: '0.2.2-rc.2', markerVersion: '0.2.1-rc.2', seedDir: seed }),
			{ kind: 'rebuild', seedDir: seed, from: '0.2.1-rc.2' }, '版本变了且有种子 ⇒ 同步插件层');
		assert.deepStrictEqual(planProfileRuntimeSync({ profileExists: true, dshVersion: '0.2.2-rc.2', markerVersion: '0.2.1-rc.2' }),
			{ kind: 'warn-no-seed', from: '0.2.1-rc.2' }, '★ 没同版本种子时绝不重建（清空 profile ✗）');
	});

	test('4) ★ marker 读写：老 profile / 坏标记都当成「没登记」', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-marker-'));
		try {
			assert.strictEqual(readProfileRuntimeVersion(root), undefined, '没有 marker ⇒ undefined');
			await writeProfileRuntimeMarker(root, '0.2.2-rc.2');
			assert.strictEqual(readProfileRuntimeVersion(root), '0.2.2-rc.2');
			const f = path.join(root, PROFILE_RUNTIME_MARKER_REL);
			assert.ok(fs.existsSync(f), 'marker 落在 .vssaros/ 下');
			fs.writeFileSync(f, '{ broken json');
			assert.strictEqual(readProfileRuntimeVersion(root), undefined, '坏标记不许抛，也不许误判成需要重建');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('5) ★ syncProfilePluginLayer：就地覆盖插件层，用户数据原样保留且不 rename 目录', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-'));
		try {
			const seed = path.join(root, 'seed'), profile = path.join(root, 'profile');
			fs.mkdirSync(path.join(seed, 'node_modules'), { recursive: true });
			fs.writeFileSync(path.join(seed, 'package.json'), '{"deps":"NEW"}');
			fs.writeFileSync(path.join(seed, 'node_modules', 'new.txt'), 'NEW-LAYER');
			fs.mkdirSync(profile, { recursive: true });
			fs.writeFileSync(path.join(profile, 'package.json'), '{"deps":"OLD"}');
			fs.writeFileSync(path.join(profile, 'my-session.json'), 'USER-DATA');
			fs.mkdirSync(path.join(profile, 'user-custom'), { recursive: true });
			fs.writeFileSync(path.join(profile, 'user-custom', 'a.txt'), 'KEEP-ME');

			const r = await syncProfilePluginLayer(seed, profile);
			assert.deepStrictEqual(r.restoredUserData.sort(), ['my-session.json', 'user-custom']);
			assert.strictEqual(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), '{"deps":"NEW"}', '插件层已换');
			assert.strictEqual(fs.readFileSync(path.join(profile, 'node_modules', 'new.txt'), 'utf8'), 'NEW-LAYER');
			assert.strictEqual(fs.readFileSync(path.join(profile, 'my-session.json'), 'utf8'), 'USER-DATA', '★ 用户数据不许丢');
			assert.strictEqual(fs.readFileSync(path.join(profile, 'user-custom', 'a.txt'), 'utf8'), 'KEEP-ME');
			assert.deepStrictEqual(fs.readdirSync(root).sort(), ['profile', 'seed'], '★ 不再生成 .bak-runtime 目录');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('6) ★ _ensureProfile 必须走 plan（不许退回「存在即 return」）', () => {
		const src = code(SUPERVISOR);
		const at = src.indexOf('private async _ensureProfile(');
		assert.ok(at > 0, '找不到 _ensureProfile');
		const next = src.indexOf('private async ', at + 30);
		const body = src.slice(at, next > 0 ? next : at + 7000);
		assert.match(body, /planProfileRuntimeSync\(\{/, '必须按版本判定，而不是看目录在不在');
		assert.match(body, /readProfileRuntimeVersion\(dir\)/, '必须读 marker');
		assert.match(body, /syncProfilePluginLayer\(/, '版本变化必须同步插件层');
		assert.match(body, /writeProfileRuntimeMarker\(/, 'init / stamp / rebuild 都要写 marker');
		assert.match(body, /plan\.kind === 'warn-no-seed'/, '没种子必须只警告');
		assert.ok(!/if \(existsSync\(manifest\)\) \{\s*\n\s*return;/.test(body),
			'★ 旧「存在即 return」不许回来（那正是 11-12 控制桥不可用的根因）');
	});

	test('7) supervisor 仍不引用 state.json 指针语义（多版本机制没有复活）', () => {
		const src = code(SUPERVISOR);
		for (const banned of ['readState(', 'clearProfileRebuildPending(', 'profileRebuildPending', 'selectRuntimeVersion']) {
			assert.ok(!src.includes(banned), `supervisor 不该再有 ${banned}`);
		}
	});

	// ── ③ runtime 解析只认 bundled ───────────────────────────────────────────
	test('8) ★ manager 不再读写 state.json；resolveDsh 只走 setting / bundled', () => {
		const src = code(MANAGER);
		for (const banned of ['STATE_FILE', 'readState(', 'restoreState(', 'setCurrent(', 'listInstalled(', 'install(version', "source: 'global'", '_globalBin', 'distTags', '_selectBundled']) {
			assert.ok(!src.includes(banned), `manager 不该再有 ${banned}（managed 多版本已下线）`);
		}
		// ⚠ `IResolvedNode.source` 里仍有 'managed'（**托管 Node** 的来源，与 dsh 版本无关），
		//   不能拿它当 banned；要精确断言 `IResolvedDsh` 的 source 只允许 bundled + setting。
		assert.match(src, /readonly source: 'setting' \| 'bundled';/, 'IResolvedDsh 只认 bundled（+排障 setting）');
		assert.match(src, /_requireBundled\(\)/, '唯一版本必须由 bundled pin 严格校验');
		assert.match(src, /get bundledVersion\(\)/, 'bundledVersion 是唯一「当前版本」');
	});

	test('9) ★ 构建期硬门：dsh-compat.json 的 bundled + 单版本目录 + 种子同版本', () => {
		// 单版本模型下，构建期校验是**唯一的版本真源保障**：运行期只认 pin，
		// 包里多带一个版本 / 种子错版本都只能在出包前拦住。
		const src = code('build/saros/check-dsh-release.mjs');
		assert.match(src, /compat\?\.bundled/, '必须读 compat.bundled 作为唯一 pin');
		assert.match(src, /const extra = dirs\.filter\(v => v !== bundledRuntime\)/, '必须检查 dsh-runtime/ 里有没有多余版本目录');
		assert.match(src, /seedMarker/, '必须校验 profile-seed/seed.json 的版本');
		assert.match(src, /profile 种子不完整/, '必须校验每个 profile 的种子有 package.json');
		assert.match(src, /blocked/, 'bundled 不许同时被拉黑');
	});

	test('10) ★ 同步失败不得改名/清空 profile（Windows EPERM 回归）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-fail-'));
		try {
			const seed = path.join(root, 'seed'), profile = path.join(root, 'profile');
			// 种子目录必须**存在**（否则 readdir 在复制之前就抛，测不到失败分支 ⇒ 假绿）
			fs.mkdirSync(seed, { recursive: true });
			fs.writeFileSync(path.join(seed, 'package.json'), '{}');
			fs.mkdirSync(profile, { recursive: true });
			fs.writeFileSync(path.join(profile, 'keep.txt'), 'OLD-PROFILE');
			await assert.rejects(() => syncProfilePluginLayer(seed, profile,
				async () => { throw new Error('copy failed'); }));
			assert.strictEqual(fs.readFileSync(path.join(profile, 'keep.txt'), 'utf8'), 'OLD-PROFILE', '★ 用户数据必须原样保留');
			assert.deepStrictEqual(fs.readdirSync(root).sort(), ['profile', 'seed'], '不许产生备份目录 / 半成品目录');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('复制部分成功后遇锁失败，旧 marker 保留；完整重试成功后才登记新版本', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-retry-'));
		try {
			const seed = path.join(root, 'seed'), profile = path.join(root, 'profile');
			fs.mkdirSync(path.join(seed, 'node_modules'), { recursive: true });
			fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"new-profile"}');
			fs.writeFileSync(path.join(seed, 'node_modules', 'updated.js'), 'NEW');
			fs.mkdirSync(profile, { recursive: true });
			fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"old-profile"}');
			fs.writeFileSync(path.join(profile, 'user.txt'), 'KEEP');
			await writeProfileRuntimeMarker(profile, '0.2.2-rc.2');
			const markerBefore = fs.readFileSync(path.join(profile, PROFILE_RUNTIME_MARKER_REL), 'utf8');
			const locked = Object.assign(new Error('persistent lock'), { code: 'EBUSY' });
			await assert.rejects(async () => {
				await syncProfilePluginLayer(seed, profile, async (from, to, isDirectory) => {
					if (!isDirectory) { throw locked; }
					await fs.promises.cp(from, to, { recursive: true });
				});
				await writeProfileRuntimeMarker(profile, '0.2.2-rc.5');
			}, error => error === locked);
			assert.strictEqual(fs.readFileSync(path.join(profile, 'node_modules', 'updated.js'), 'utf8'), 'NEW');
			assert.strictEqual(fs.readFileSync(path.join(profile, PROFILE_RUNTIME_MARKER_REL), 'utf8'), markerBefore);
			assert.strictEqual(planProfileRuntimeSync({
				profileExists: true, markerVersion: readProfileRuntimeVersion(profile), dshVersion: '0.2.2-rc.5', seedDir: seed,
			}).kind, 'rebuild', '半更新下次仍必须重试');
			await syncProfilePluginLayer(seed, profile);
			await writeProfileRuntimeMarker(profile, '0.2.2-rc.5');
			assert.strictEqual(readProfileRuntimeVersion(profile), '0.2.2-rc.5');
			assert.strictEqual(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), '{"name":"new-profile"}');
			assert.strictEqual(fs.readFileSync(path.join(profile, 'user.txt'), 'utf8'), 'KEEP');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('插件层普通文件与目录都用重试复制，marker 写入保持在成功同步之后', () => {
		const sync = code('src/vs/sessions/contrib/dshHarness/electron-main/dshProfileRuntimeSync.ts');
		const at = sync.indexOf('export async function syncProfilePluginLayer(');
		const end = sync.indexOf('export function profileSeedDirFor(', at);
		const layer = sync.slice(at, end);
		assert.match(layer, /await copyFileWithRetry\(from, to\)/);
		assert.match(layer, /await copyDirectoryConcurrently\(from, to, \{ dereference: true \}\)/);
		assert.doesNotMatch(layer, /await fsp\.copyFile\(from, to\)/);
		const supervisor = code(SUPERVISOR);
		const rebuildAt = supervisor.indexOf("plan.kind === 'rebuild'");
		const copyAt = supervisor.indexOf('await syncProfilePluginLayer(', rebuildAt);
		const markerAt = supervisor.indexOf('await writeProfileRuntimeMarker(', rebuildAt);
		assert.ok(rebuildAt > 0 && copyAt > rebuildAt && markerAt > copyAt);
	});

	test('11) channel 不再有升级闸门 / 切版本 IPC；bundledRoot 必须在 dev 下向上回退', () => {
		const src = code(CHANNEL);
		for (const banned of ['DshUpgradeGate', 'SetCurrentRuntime', 'InstallRuntime', 'Command.Upgrade,', 'DiscoverUpdates', 'selectRuntimeVersion', 'listInstalled(', 'readState(', 'setCurrent(', '_upgrade(', '_discover(']) {
			assert.ok(!src.includes(banned), `channel 不该再有 ${banned}`);
		}
		const at = src.indexOf('const bundledRuntime = (() => {');
		assert.ok(at > 0, '找不到 bundledRuntime 的查找逻辑');
		const block = src.slice(at, at + 900);
		assert.match(block, /for \(let i = 0; i < 6; i\+\+\)/, 'dev 的 appPath 下没有 dsh-runtime ⇒ 必须逐级向上找到仓库根');
		assert.match(block, /existsSync\(join\(candidate, bundledPin, \.\.\.tail\)\)/, '只有 pin 版本 bin 真的存在才认');
	});

	test('12) ★ 无种子 / web 模板启动也必须登记随包源码依赖，避免定制 UI 被 pnpm 清掉', () => {
		// 这里读原文：该文件的注释里含 `/*` 片段，块注释剥离正则会吞掉后续代码造成假红。
		const src = read(SUPERVISOR);
		const syncAt = src.indexOf('private async _syncBundledPluginDirs(');
		const depsCallAt = src.indexOf('await this._writeBundledPluginDeps(profileDir, sources)', syncAt);
		const syncCallAt = src.indexOf('return await syncBundledPluginDirs(sources, profileDir', syncAt);
		assert.ok(syncAt > 0 && depsCallAt > syncAt && syncCallAt > depsCallAt, '源码同步前必须先写 dependencies');

		const depsAt = src.indexOf('private async _writeBundledPluginDeps(');
		const depsEnd = src.indexOf('private _profileSeedDir(', depsAt);
		const deps = src.slice(depsAt, depsEnd > depsAt ? depsEnd : src.length);
		assert.match(deps, /isSharedProfile\(profileDir\)/, '共享 profile 不能写只读种子');
		assert.match(deps, /toFileSpec\(sourceDir\)/, '必须写入 file: 源码 spec');
		assert.match(deps, /json\.dependencies\[name\] = spec/, '必须登记到 dependencies');
		assert.match(deps, /await fsp\.rename\(tmp, pkgFile\)/, 'package.json 必须原子写');
	});
});
