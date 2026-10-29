/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「Host 输出异常少要自己说出来」的守卫（2026-10-29）。
 *
 * 真机：别人机器上 `ready in 21797 ms (bridge: fallback)`，而
 * `~/.vssaros/dsh-run/host-938224b6.log` **只有 83 字节 / 1 行**（就那条 `dsh web:`）。
 *
 * 本机对照（两个版本、stdout 都重定向到普通文件，等价于 keepAlive 模式）：
 *   · bundled rc.2   ⇒ 62 行 / 33KB，含 bridge 日志、6 处 apply
 *   · managed alpha.3 ⇒ 46 行，含 bridge 日志、19 处 apply
 * ⇒ **不是 dsh 版本问题、也不是"stdout 不是 TTY"的问题** ⇒ 是那台机器的环境特例。
 *
 * 但排查体验很差：日志里只有一个莫名的 `bridge: fallback`，没人知道该去看 host-*.log。
 * ⇒ ready 时若 Host 输出 ≤1 行，必须**明确警告并给出日志路径**。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshHostSilentOutput
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('Host 输出异常少时必须自己说出来', () => {

	test('ready 之后要检查 Host 日志行数，并在 ≤1 行时明确警告', () => {
		const src = stripComments(read(SUPERVISOR));

		// 只在 keepAlive 模式才有 hostLogFile ⇒ 检查必须挂在它下面
		assert.match(src, /if \(hostLogFile\) \{\s*try \{\s*const hostLines = readFileSync\(hostLogFile/,
			'检查必须只在 keepAlive（有 hostLogFile）时做，且真的读 Host 日志来数行数');
		assert.match(src, /hostLines <= 1/, '判据必须是"输出 ≤1 行"（正常是几十行）');
		assert.match(src, /Host 输出异常少/, '警告必须说清"输出异常少"（否则只有 bridge: fallback，无法指向原因）');
		assert.match(src, /日志：\$\{hostLogFile\}/, '警告里必须带日志路径（否则排查的人不知道该看哪个文件）');
		// ⚠ 不能用注释里的文字断言：`stripComments` 会把 `/* … */` 删掉（第一版就这么假红 ✗）。
		//   只看"诊断块里有 catch"（而且它在 try 之外 ⇒ 读不到日志也不会抛出）。
		const diagAt = src.indexOf('const hostLines = readFileSync(hostLogFile');
		assert.ok(diagAt > 0, '诊断块找不到');
		assert.match(src.slice(diagAt, diagAt + 700), /catch \{/, '读日志失败不许影响启动（必须有 catch）');

		// ⚠ 位置：必须在 `_pluginsStale = false` **之后**。那对（ready in → 清标记）的顺序有守卫钉着
		//   （`dshPluginPackages` ⑥），插在中间会把它打红（我第一版就是这么干的 ✗）。
		// ⚠ 不能用 `indexOf('this._pluginsStale = false;')`：文件里多处出现（`_ensurePlugin` 里也有）
		//   ⇒ 会取到错误的那一处 ⇒ 假红（实测踩过 ✗）。用**唯一的那对**（清标记 + 审计"新起 Host"）定位。
		const iReady = src.indexOf('ready in ${Date.now() - t0} ms');
		const pair = src.indexOf("void this._auditPluginGraph('新起 Host');");
		const iDiag = src.indexOf('Host 输出异常少');
		assert.ok(iReady > 0, '找不到 ready 日志那条');
		assert.ok(pair > iReady, '找不到"清标记 + 审计新起 Host"那对');
		assert.ok(iDiag > pair,
			'诊断必须在"ready in → 清标记 → 审计新起 Host"之后（插在中间会破坏那对顺序守卫 ✗）');
	});
});
