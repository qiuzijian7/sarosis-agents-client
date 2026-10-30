/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「打包暂存区的 `dsh-plugins/` 必须每次刷新」的守卫（2026-10-30，真机 P0）。
 *
 * 真机（全新机器 `yueezhu`，装 v2.2.2621x）：窗口开了、Host 也起来了、`bridge: connected`，
 * 但**主页白屏**。日志里三个插件 import 失败：
 *
 *     dsh: skipping profile bundle "@vssaros/dsh-agents": failed to read overlay … cordis.presets.yml: ENOENT
 *     vssaros-dashboard: failed to import: ENOENT … lib/app/d…
 *     vssaros-kb: failed to import: ERR_MODULE_NOT_FOUND … vendor/markdown-it.cjs
 *
 * 根因**不在运行时**，在打包：`strip-before-pack.mjs` 的 `ensureDir()` 只要哨兵文件在就
 * **整个跳过拷贝**：
 *
 *     if (existsSync(sentinelAbs)) { console.log('  ✅ …'); return; }
 *
 * 而暂存目录在**仓库外**（`../VSCode-win32-x64`）、**跨构建保留** ⇒ 里面躺的是某次旧构建的
 * `dsh-plugins/` ⇒ 之后新增的插件文件永远进不了包 ⇒ 直装到用户机器就缺文件 ⇒ 插件 import 失败
 * ⇒ 页面壳在、内容空（白屏）。
 *
 * 本机从不复现：本机 profile 早就装过这些文件，不经过"随包 + 直装"这条路。
 *
 * 修法：`ensureDir(..., { refresh: true })` —— 先 `rmSync` 再整目录 `cpSync`；
 *   `dsh-plugins` 必须用它（那是我们自己每次发版都在改的目录）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPackStagingRefresh
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = 'build/saros/strip-before-pack.mjs';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('打包暂存区的 dsh-plugins 必须每次刷新', () => {

	test('1) ensureDir 必须支持 refresh（先删后拷），且不是"哨兵在就跳过"', () => {
		const s = read(SCRIPT);
		const at = s.indexOf('function ensureDir(');
		assert.ok(at > 0, '找不到 ensureDir');
		const body = s.slice(at, at + 2200);
		assert.match(body, /opts\.refresh/, 'ensureDir 必须支持 refresh 选项');
		assert.match(body, /rmSync\(stagingAbs, \{ recursive: true, force: true \}\)/, 'refresh 必须先删旧目录（否则残留删不掉的文件）');
		assert.match(body, /cpSync\(repoAbsForced, stagingAbs, \{ recursive: true \}\)/, 'refresh 必须整目录从仓库重拷');
	});

	test('2) dsh-plugins 的调用必须带 refresh:true（否则旧副本永远进包）', () => {
		const s = read(SCRIPT);
		const at = s.indexOf("'resources/app/dsh-plugins'");
		assert.ok(at > 0, '找不到 dsh-plugins 的 ensureDir 调用');
		// 取这次调用的完整实参（到下一个 `);` 为止）
		const end = s.indexOf(');', at);
		const call = s.slice(at, end);
		assert.match(call, /\{\s*refresh:\s*true\s*\}/,
			'dsh-plugins 必须 `{ refresh: true }` —— 它是我们自己每次发版都在改的目录，'
			+ '"哨兵在就跳过"会让新加文件（vendor/、cordis.presets.yml、lib/app/…）永远进不了包 ✗');
	});

	test('5) dsh-runtime 也必须 refresh，且必须门禁 profile-seed（否则全新机器退化 web 模板）', () => {
		const s = read(SCRIPT);
		const at = s.indexOf('resources/app/dsh-runtime/${bundledVersion}');
		assert.ok(at > 0, '找不到 dsh-runtime 的 ensureDir 调用');
		const end = s.indexOf(');', at);
		assert.match(s.slice(at, end), /\{\s*refresh:\s*true\s*\}/,
			'dsh-runtime 必须 `{ refresh: true }` —— 同版本重建时旧副本会让 profile-seed 永远进不了包 ✗');
		// 种子门禁：暂存里必须真的有某个 profile 的 package.json
		const gate = s.indexOf('随包 dsh-runtime 缺 profile-seed');
		assert.ok(gate > 0, '缺少 profile-seed 门禁');
		const seg = s.slice(Math.max(0, gate - 900), gate + 420);
		assert.match(seg, /readdirSync\(seedRoot/, '门禁必须真的去列 profile-seed/profiles');
		assert.match(seg, /criticalMissing\+\+/, '缺种子必须计入 criticalMissing');
	});

	test('4) 构建期必须逐文件校验「暂存 vs 仓库」的 dsh-plugins（缺文件 ⇒ criticalMissing）', () => {
		const s = read(SCRIPT);
		const at = s.indexOf('随包 dsh-plugins 完整性');
		assert.ok(at > 0, '缺少"暂存 vs 仓库逐文件比对"这道门禁');
		const seg = s.slice(Math.max(0, at - 1400), at + 200);
		assert.match(seg, /const missing = want\.filter/, '必须算"仓库有、暂存没有"的差集');
		assert.match(seg, /criticalMissing\+\+/, '缺文件必须计入 criticalMissing（让构建收尾报红，而不是静默进包）');
		// 排除项要齐：node_modules 不该进包；test/ 是构建有意排除的
		assert.match(seg, /node_modules/, '比对时必须排除 node_modules');
		assert.match(seg, /'test'/, '比对时必须排除 test/（构建有意排除，缺了不算问题）');
	});

	test('3) 关键插件文件在仓库里确实存在（确保"刷新"有内容可刷）', () => {
		for (const rel of ['dsh-plugins/vssaros-kb/vendor/markdown-it.cjs', 'dsh-plugins/vssaros-agents/cordis.presets.yml']) {
			assert.ok(fs.existsSync(path.join(process.cwd(), rel)), '仓库里缺 ' + rel + ' ⇒ 就算刷新也补不出这个文件');
		}
	});
});
