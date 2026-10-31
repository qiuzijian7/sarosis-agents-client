/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 两个"找窗口"的 PS 脚本必须可靠（2026-10-31）。
 *
 * 真机事故：`scripts/has-visible-window.ps1` **恒返回 0**
 *   ⇒ 启动器每次都把"已有 dev 实例"判成僵尸态 ⇒ **杀掉用户正在用的 dev 实例** ✗✗
 *
 * 两个成因都被本守卫钉住：
 *   ① **缺 UTF-8 BOM**：PS 5.1 默认按 GBK 读无 BOM 的 ps1 ⇒ 中文注释变乱码，甚至直接
 *      `ParserError: UnexpectedToken`（脚本一行都跑不起来，输出却是"没有窗口"）。
 *   ② **用 `Get-Process -Name <名>` 取 pid**：实测这台机器上
 *      `Get-Process -Name 'VsSaros'` ⇒ **0**（而 `wmic` 看得到十几个、`Get-Process -Id` 也行）
 *      ⇒ 取不到 pid ⇒ 直接 `Write-Output 0; exit 0`。
 *      ⇒ 改成 CIM（`Win32_Process`，与 wmic 同源）+ 进程扫描两条来源取并集。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshWindowProbeScripts
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const PS1 = ['scripts/has-visible-window.ps1', 'scripts/raise-dev-window.ps1'];

function readBytes(rel: string): Buffer {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs);
}

suite('找窗口的 PS 脚本必须可靠', () => {

	test('1) 两个 ps1 都必须带 UTF-8 BOM（无 BOM ⇒ PS5.1 按 GBK 读 ⇒ 解析失败/误判）', () => {
		for (const rel of PS1) {
			const b = readBytes(rel);
			assert.ok(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF,
				`${rel} 缺少 UTF-8 BOM（这台机器的 PS 5.1 会按 GBK 读 ⇒ 中文注释乱码甚至语法错）`);
		}
	});

	test('2) 不许用 `Get-Process -Name` 取 pid（实测取不到我们的进程 ⇒ 恒 0）', () => {
		// ⚠ 只看**非注释行**：注释里会说明"旧写法为什么不行"，别被它骗过去
		const s = readBytes('scripts/has-visible-window.ps1').toString('utf8')
			.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
		assert.ok(!/Get-Process\s+-Name/.test(s),
			'不许用 `Get-Process -Name`：实测对本应用返回 0 ⇒ 判"没有窗口"⇒ 误杀正在用的实例 ✗');
		// 必须换成 CIM（与 wmic 同源）
		assert.match(s, /Get-CimInstance\s+Win32_Process/, '必须改用 CIM `Win32_Process` 取 pid（wmic 同源，实测可见）');
	});

	test('3) 僵尸判定要连测两次（单次的瞬间 0 会误杀）', () => {
		const s = fs.readFileSync(path.join(process.cwd(), 'scripts/start-dev-app.mjs'), 'utf8');
		// ⚠ 断言**二次采样的实现本身**，不能只断言存在某个变量名
		//   （第一版就是只查 `reallyNoWindow`，被"只改第一次出现"的突变骗成假绿）
		assert.match(s, /setTimeout\(\(\) => resolve\(!hasVisibleAppWindow\(\)\), 1200\)/,
			'HANDOFF 分支必须隔 1.2s **再采样一次**才判僵尸（窗口创建/切桌面会有瞬时 0 ⇒ 会误杀）');
		assert.match(s, /child\.on\('exit', async \(/, 'exit handler 必须是 async（双重判定要 await）');
	});
});
