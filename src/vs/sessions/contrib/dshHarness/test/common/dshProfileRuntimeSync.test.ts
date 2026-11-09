/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「单版本 bundled + userData/dsh-home 永不覆盖」守卫（2026-11-09）。
 *
 * 产品口径（对标开源 dsh-desktop）：dsh 版本由 `dsh-compat.json` 的 `bundled` 在构建期 pin 死，
 * 版本升级 = 应用发版；**应用升级不替换 profile / plugin / workspace / session / model 配置**。
 * 因此 `_ensureProfile` 只负责「profile 不存在时首次创建」，存在就必须原样返回。
 *
 * 历史上这里守的是 marker / `planProfileRuntimeSync` / `profileRebuildPending` / 按版本重建 profile，
 * 那套机制随 managed 多版本一起下线（真机两次 F5 崩溃：11-07 老 profile 跑新 runtime、
 * 11-09 重建时 Windows symlink EPERM）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshProfileRuntimeSync
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { copyProfileSeed, profileSeedDirFor } from '../../electron-main/dshProfileRuntimeSync.js';

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

suite('dshHarness / 单版本 bundled + profile 永不覆盖', () => {

	// ── ① 首启种子复制 ────────────────────────────────────────────────────────
	test('1) ★ 种子复制必须解引用 symlink（Windows 非管理员下裸 fsp.cp 会 EPERM ⇒ 首启崩溃）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-links-'));
		const src = path.join(root, 'seed');
		const dest = path.join(root, 'dest');
		try {
			fs.mkdirSync(path.join(src, 'real'), { recursive: true });
			fs.writeFileSync(path.join(src, 'real', 'a.txt'), 'FROM-REAL');
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

	// ── ② profile 永不覆盖 ───────────────────────────────────────────────────
	test('3) ★ _ensureProfile：profile 已存在必须**立刻 return**，不许写/比/重建任何东西', () => {
		const src = code(SUPERVISOR);
		const at = src.indexOf('private async _ensureProfile(');
		assert.ok(at > 0, '找不到 _ensureProfile');
		const next = src.indexOf('private async ', at + 30);
		const body = src.slice(at, next > 0 ? next : at + 5000);
		assert.match(body, /if \(existsSync\(manifest\)\) \{\n\s*return;/, '存在即返回（userData/dsh-home 永不覆盖）');
		assert.match(body, /copyProfileSeed\(/, '不存在时才从种子复制');
		for (const banned of ['readState(', 'clearProfileRebuildPending(', 'writeProfileRuntimeMarker(', 'planProfileRuntimeSync(', 'rebuild', 'marker']) {
			assert.ok(!body.includes(banned), `_ensureProfile 不该再出现 ${banned}（多版本重建已下线）`);
		}
	});

	test('4) supervisor 不再引用 state.json 指针语义', () => {
		const src = code(SUPERVISOR);
		for (const banned of ['readState(', 'clearProfileRebuildPending(', 'profileRebuildPending', 'runtime-version.json']) {
			assert.ok(!src.includes(banned), `supervisor 不该再有 ${banned}`);
		}
	});

	// ── ③ runtime 解析只认 bundled ───────────────────────────────────────────
	test('5) ★ manager 不再读写 state.json；resolveDsh 只走 setting / bundled', () => {
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

	test('6) ★ 构建期硬门：dsh-compat.json 的 bundled + 单版本目录 + 种子同版本', () => {
		// 单版本模型下，构建期校验是**唯一的版本真源保障**：运行期只认 pin，
		// 包里多带一个版本 / 种子错版本都只能在出包前拦住。
		const src = code('build/saros/check-dsh-release.mjs');
		assert.match(src, /compat\?\.bundled/, '必须读 compat.bundled 作为唯一 pin');
		assert.match(src, /const extra = dirs\.filter\(v => v !== bundledRuntime\)/, '必须检查 dsh-runtime/ 里有没有多余版本目录');
		assert.match(src, /seedMarker/, '必须校验 profile-seed/seed.json 的版本');
		assert.match(src, /profile 种子不完整/, '必须校验每个 profile 的种子有 package.json');
		assert.match(src, /blocked/, 'bundled 不许同时被拉黑');
	});

	test('7) channel 不再有升级闸门 / 切版本 IPC；bundledRoot 必须在 dev 下向上回退', () => {
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
});
