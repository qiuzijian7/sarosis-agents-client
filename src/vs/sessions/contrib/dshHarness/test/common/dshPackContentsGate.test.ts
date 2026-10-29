/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「产物内容门禁」的守卫（2026-10-29）。
 *
 * 真机：打包出的 exe 在别人机器上每次启动一条
 *   `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vscode/deviceid' imported from …/out/main.js`
 * ⇒ 产物里**缺件**，而这个缺陷一路溜到了用户手上 ✗✗。
 *
 * 根因（两道）：
 *   ① `strip-before-pack.mjs` 里**早就有**补回 `@vscode/deviceid` 的 `ensureDir` 调用
 *      （2026-10-29 00:36 写好），但那个包是 13:40 打的 ⇒ **那个脚本压根没跑**
 *      （它不在 gulp 任务链里，靠手工执行）⇒ 没有任何东西会拦住缺件；
 *   ② 就算跑了，也只统计"仓库源也没有、自愈不了"的那些（`criticalMissing`），
 *      **不独立复核产物** ⇒ 自愈没落到最终产物里也照样放行。
 *
 * ⇒ 修法：
 *   · `build/saros/check-pack-contents.mjs` —— 独立复核，**清单从 strip 的 ensureDir 调用
 *     自动推导**（单一真相源），缺一即 exit(1)；
 *   · `strip-before-pack.mjs` 末尾调用它（strip 跑了就必过）；
 *   · `create-release.cjs`（每次发布必跑）在上传 exe 前调用它（缺件不许发出去）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPackContentsGate
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const STRIP = 'build/saros/strip-before-pack.mjs';
const GATE = 'build/saros/check-pack-contents.mjs';
const RELEASE = 'build/saros/create-release.cjs';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 剥掉注释：断言只能命中真实代码，不能被注释里的同名标识符骗过。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('产物内容门禁', () => {

	test('1) 门禁清单必须从 strip 的 ensureDir 调用自动推导', () => {
		const gate = stripComments(read(GATE));
		const strip = read(STRIP);

		assert.match(gate, /strip-before-pack\.mjs/,
			'门禁必须读 strip-before-pack 的源码来拿清单（单一真相源）');
		assert.match(gate, /ensureDir/,
			'门禁必须按 ensureDir 调用抽清单（那些调用就是"必须存在"的构件）');
		assert.ok(!/'@vscode\/deviceid'/.test(gate),
			'门禁里不许硬编码具体包名（清单只从 strip 推导 ⇒ 以后加构件只改一处）');

		assert.match(gate, /fromEnsure\.length === 0/,
			'抽不到清单时必须拒绝放行（否则门禁形同虚设）');
		assert.match(gate, /process\.exit\(1\)/,
			'门禁不过必须 exit(1)（缺件不许出包）');

		const calls = strip.match(/ensureDir\(/g) ?? [];
		assert.ok(calls.length >= 2,
			'strip-before-pack 里至少要有两个 ensureDir 调用可被推导（现在 ' + calls.length + ' 个）');
	});

	test('2) strip-before-pack 末尾必须跑门禁（strip 跑了就必过）', () => {
		const strip = stripComments(read(STRIP));
		assert.match(strip, /check-pack-contents\.mjs/,
			'strip-before-pack 必须调用产物内容门禁');
		// ⚠ 必须钉**门禁那一次调用**（`[gate, buildDir]`）：只查 `spawnSync(` 会命中 strip 里
		//   另一处（ensure-pnpm-tool 的 spawnSync）⇒ "把门禁调用删掉"这种突变会**假绿**（实测踩过 ✗）。
		assert.match(strip, /spawnSync\(process\.execPath, \[gate, buildDir\]/,
			'必须用子进程跑门禁（门禁要能 exit(1) 阻断打包）；且必须真的执行它');
		assert.match(strip, /if \(r\.status !== 0\)/,
			'门禁不过必须显式处理非零退出码');
		assert.match(strip, /process\.exit\(r\.status \|\| 1\)/,
			'门禁不过必须 exit ⇒ 打包中止（这才是"出不了包"）');
	});

	test('3) 发布脚本（每次必跑）上传前必须过门禁', () => {
		const rel = stripComments(read(RELEASE));
		assert.match(rel, /check-pack-contents\.mjs/,
			'create-release 必须在上传 exe 前跑产物内容门禁（缺件不许发出去）');
		// ⚠ 必须钉住**真的执行**它：只查"文件名出现过"会被"把调用删掉、只留路径常量"骗过（实测假绿 ✗）。
		assert.match(rel, /execFileSync\(process\.execPath, gateArgs/,
			'发布脚本必须真的执行门禁（只引用文件名不算 ⇒ 会假绿）');
		// ⚠ 不许"探测不到就跳过"：不知道产物在哪 ≠ 产物没问题（必须 fail-closed）
		assert.ok(!/构建输出目录不存在[^}]*跳过/.test(rel),
			'发布脚本不许在"找不到产物目录"时静默跳过门禁（应该 fail-closed）');
		const at = rel.indexOf('check-pack-contents.mjs');
		// ⚠ 上传锚点要用**代码**（`for (const exe of EXE_FILES)`）⇒ 不能用 "// 2. upload exes …"
		//   那行**整行注释**（stripComments 会把它删掉 ⇒ 找不到 ⇒ 假红 ✗）。
		const uploadAt = rel.indexOf('for (const exe of EXE_FILES)');
		assert.ok(at > 0 && uploadAt > 0, '找不到门禁调用或上传段');
		assert.ok(at < uploadAt, '门禁必须在**上传之前**（上传了就拦不住了）');
		assert.ok(!/try\s*\{[^}]*check-pack-contents/.test(rel),
			'门禁调用不许被 try/catch 吞掉（吞掉就等于没有门禁）');
	});
});
