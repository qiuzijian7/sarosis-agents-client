/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「scripts/*.ps1 必须是 UTF-8 BOM 或纯 ASCII」的守卫（2026-10-31）。
 *
 * 真机（F5 直接报错）：`start-dev-app.ps1:45 Get-Process: 无法对参数"Name"执行参数验证。
 * 参数为 Null 或空` —— 根因是**往 BOM-less 的 ps1 里加了中文注释**：
 *   PS 5.1 把无 BOM 文件按 ANSI/GBK 读 ⇒ 中文注释变乱码 ⇒ **解析边界被吃掉**
 *   ⇒ `$procNames = …` 那行根本没被赋值 ⇒ `Get-Process -Name $null` ⇒ 报错、F5 卡死。
 *   （报错行号 45 与源码 47 对不上，正是"解析错位"的佐证。）
 *
 * 该文件头部自己就写着规则（上游遗留）：
 *   NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less files as ANSI, …
 *
 * 修法二选一（本守卫两个都接受）：**纯 ASCII** 或 **UTF-8 BOM**。
 * 全仓扫描还揪出 `diag-f5.ps1` / `fix-ts2741.ps1` / `new-window.ps1` 三个同类地雷
 * （`new-window.ps1` 随包交付 ⇒ 安装版「新建窗口」会坏），已全部补 BOM。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPs1Encoding
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'scripts';

function readBytes(rel: string): Buffer {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs);
}

suite('scripts/*.ps1 必须是 UTF-8 BOM 或纯 ASCII', () => {

	test('1) 每个 .ps1：无 BOM 就必须纯 ASCII；有非 ASCII 就必须有 BOM', () => {
		const dir = path.join(process.cwd(), DIR);
		const names = fs.readdirSync(dir).filter(f => f.endsWith('.ps1'));
		assert.ok(names.length > 0, 'scripts 下没有 .ps1（目录变了？）');
		const bad: string[] = [];
		for (const name of names) {
			const buf = readBytes(path.join(DIR, name));
			const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
			if (hasBom) { continue; }
			const nonAscii = [...buf.toString('utf8')].filter(ch => ch.codePointAt(0)! > 127).length;
			if (nonAscii > 0) { bad.push(`${name}（非 ASCII ${nonAscii} 个且无 BOM）`); }
		}
		assert.deepStrictEqual(bad, [],
			'以下 ps1 会被 PS 5.1 按 GBK 误读（中文注释乱码吃掉解析边界 ⇒ 变量没赋值/语法错）：\n  ' + bad.join('\n  '));
	});

	test('2) start-dev-app.ps1（F5 的 death recorder）必须纯 ASCII（它自己声明 keep ASCII-only）', () => {
		const buf = readBytes(path.join(DIR, 'start-dev-app.ps1'));
		const nonAscii = [...buf.toString('utf8')].filter(ch => ch.codePointAt(0)! > 127).length;
		assert.strictEqual(nonAscii, 0,
			'start-dev-app.ps1 出现非 ASCII 字符 —— 该文件头部 NOTE 明确要求 ASCII-only，'
			+ '中文请写进 start-dev-app.mjs（UTF-8）或给本文件加 BOM');
		// 进程名判据要把 dev 专用名排第一（防安装版误判的老问题回归）
		const s = buf.toString('utf8');
		assert.match(s, /\$exeNames = @\('VsSaros Dev\.exe', 'VsSaros\.exe', 'Saroasis harness\.exe'\)/,
			'$exeNames 必须以 dev 专用名开头（安装版同名进程不能被当成 dev 实例）');
	});
});
