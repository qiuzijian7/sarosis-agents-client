/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「profile 里的断链必须自愈」的守卫（2026-11-02，真机：F5 起不来）。
 *
 * 现场（`host-*.log`）：
 * ```
 * Error: UNKNOWN: unknown error, realpath
 *   C:\…\.vssaros-dev\dsh-home\profiles\vssaros\node_modules\@deepseek-ai\dsh-app-boot
 *   at realModuleDirectory (dsh-app-boot/lib/index.js:458)
 *   at linkedProfileRoots → createRuntimeResolution → composeProfile
 * ```
 * ⇒ dsh **组装 profile** 时 realpath 抛错 ⇒ Host `code 1` 退出 ⇒ 窗口开了也没有界面（F5 看起来"失败"）。
 *
 * 为什么此前所有体检都是绿的：`existsSync(断链)` 返回 **false**（它跟随链接），
 *   所以"文件在不在"的检查看不出问题；而坏链接只有 1 个（其余 156 个是真目录）。
 *
 * 修法：启动前扫 `node_modules/@scope/*`，`lstat` 判定是链接后 `realpath` 试一下，
 *   失败就地用**真实副本**替换（源优先用链接指向的目标，其次运行时同版本包）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshBrokenProfileLinkHeal
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SUP = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 只去整行 `//` 注释（文件里有字符串含 `/*`，块注释正则会吞掉大段） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('profile 断链必须自愈', () => {

	test('1) 必须有 _repairBrokenProfileLinks，且用 lstat + realpath 判链接', () => {
		const src = code(SUP);
		assert.match(src, /private async _repairBrokenProfileLinks\(/, '缺少断链自愈方法');
		const at = src.indexOf('private async _repairBrokenProfileLinks(');
		const body = src.slice(at, at + 3600);
		assert.match(body, /fsp\.lstat\(/, '必须用 lstat 判"是不是链接"（existsSync 对断链返回 false，看不出来）');
		assert.match(body, /fsp\.realpath\(/, '必须用 realpath 试探链接是否可用（这正是 dsh 组装 profile 时的判据）');
		assert.match(body, /isSymbolicLink\(\)/, '只处理符号链接/联接，别碰真目录');
	});

	test('2) 断链必须用真实副本替换，退化时才删链接（且都要打日志）', () => {
		const src = code(SUP);
		const at = src.indexOf('private async _repairBrokenProfileLinks(');
		const body = src.slice(at, at + 3600);
		// ⚠ 锚定"`if (source)` 紧跟着复制"：只断言 `fsp.cp(...)` 存在会被 `if (false)` 这种
		//   "把修复分支关掉"的突变骗成假绿（第一版就是这么被骗的）
		assert.match(body, /if \(source\) \{\s*\n\s*await fsp\.cp\(source, p, \{ recursive: true \}\);/,
			'断链时必须把来源复制成真实副本（联接受损时 dsh 需要能 realpath 的目录）');
		assert.match(body, /resolveSiblingPackage\(dsh\.bin, pkg\)/, '来源要能退回"运行时同版本包"');
		assert.match(body, /profile 联接失效 ⇒ 已用真实副本替换/, '修复必须留日志（否则线上永远查不出"为什么突然好了"）');
		assert.match(body, /已删除该联接/, '找不到来源时要删掉断链（至少别让 realpath 继续抛错）');
	});

	test('4) dedupe 建完联接必须自己验一次 realpath；不可用就退化成真实副本', () => {
		const src = code(SUP);
		const at = src.indexOf('private async _dedupeSharedPackages(');
		assert.ok(at > 0, '找不到 _dedupeSharedPackages');
		const body = src.slice(at, at + 3200);
		// ⚠ 这台机器上"指向 dsh-runtime 的 junction"建出来 realpath 就失败 ⇒
		//   若 dedupe 不自验，每次启动都会"建链接 → 被自愈换成副本"地白折腾一轮。
		assert.match(body, /await fsp\.realpath\(profileCopy\);/, 'dedupe 建完联接必须验 realpath');
		// ⚠ 锚定"catch 里先删再复制，最后才是日志"：只断言日志文案会被
		//   "把 cp 换成 no-op" 的突变骗成假绿（M5 就是这么绿的）
		assert.match(body, /catch \{\s*\n\s*await fsp\.rm\(profileCopy, \{ recursive: true, force: true \}\);\s*\n\s*await fsp\.cp\(runtimeCopy, profileCopy, \{ recursive: true \}\);/,
			'验失败必须 rm 掉断链再真实复制（不能留一个断链给 dsh）');
		assert.match(body, /联接不可用（realpath 失败）⇒ 已退化为真实副本/, '修复必须留日志');
	});

	test('3) 必须在 dedupe 之后、spawn 之前调用（dedupe 自己会产生链接！）', () => {
		const src = code(SUP);
		const iDedupe = src.indexOf('await this._dedupeSharedPackages(dsh, profile, env);');
		const iHeal = src.indexOf('await this._repairBrokenProfileLinks(dsh, profile, env);');
		const iSpawn = src.indexOf('spawned pid');
		assert.ok(iDedupe > 0 && iHeal > 0, '两处调用都要在');
		assert.ok(iHeal > iDedupe, '自愈必须在 dedupe **之后**（dedupe 会新建联接，自己也可能做出断链）');
		if (iSpawn > 0) {
			assert.ok(iHeal < iSpawn, '自愈必须在 Host spawn 之前');
		}
	});
});
