/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「产物依赖闭包核对」的守卫（2026-10-29）。
 *
 * 真机：`build/win32/code.iss` 的 `[Files]` Excludes 排除了 `@vscode/deviceid` 与
 * `@vscode/policy-watcher`（上游 VS Code 当遥测件剥掉）⇒ 而我们的 `out/main.js` **在 import 它们**
 * ⇒ 用户装完每次启动两条 `ERR_MODULE_NOT_FOUND` / `Failed to import` ✗✗。
 *
 * 为什么"人肉查不出来"：
 *   · `strip-before-pack` 的自愈日志里 `@vscode/deviceid` 是 **✅（存在）**（源目录里确实有）；
 *   · 安装后 `resources/app/node_modules/` **整个目录都不见了**（纯 JS 包在 `node_modules.asar` 里，
 *     native 模块在 `node_modules.asar.unpacked` 里）⇒ 只查磁盘目录会**误判成缺件**；
 *   · 装出来的目录结构与构建输出不同（`out/` 被 bundle 成 `main.js`）⇒ 拿安装目录当门禁输入全是假警报。
 *
 * ⇒ 门禁必须做三件事：
 *   ① **扫产物代码里真正 require 的裸模块**（`@vscode/*`）⇒ 逐个确认包在；
 *   ② 判定"包在"要**同时看磁盘 / `node_modules.asar` / `node_modules.asar.unpacked`**；
 *   ③ 输入目录**不像构建输出**时明确提示并退出（别硬报一堆误导的"缺失"）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPackClosureCheck
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const GATE = 'build/saros/check-pack-contents.mjs';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('产物依赖闭包核对', () => {

	test('1) 必须扫产物代码里真正 require 的裸模块，并逐个确认包在', () => {
		const code = stripComments(read(GATE));

		assert.match(code, /function collectBareRequires\(/, '必须有"扫产物代码里的裸模块引用"的能力');
		assert.match(code, /require\\\(|from\\s\+|import\\s\\\(/,
			'必须覆盖 require(...) / from \'...\' / import(...) 三种写法');
		// ⚠ 必须钉**调用点**（只查函数名会被"定义还在、调用被删"骗过 —— 实测假绿 ✗）
		assert.match(code, /collectBareRequires\(root, \['@vscode'\]\)/,
			'必须真的用 collectBareRequires 扫产物代码（定义还在不算 ✗）');
		assert.match(code, /packagePresent\(appDir, spec\)/,
			'每个被引用的包都要过"在不在产物里"的判定');
		assert.match(code, /产物代码引用了 \$\{spec\}/,
			'缺件必须点名是哪个包（否则还是"一堆缺失"看不出方向）');
	});

	test('2) "包在不在"必须同时看磁盘 / asar / asar.unpacked', () => {
		const code = stripComments(read(GATE));

		assert.match(code, /function asarHasPackage\(/, '必须能判断"包在 asar 归档里"（纯 JS 都在那儿）');
		assert.match(code, /readUInt32LE\(12\)/, '必须按 asar 的真实头部格式解析（12 偏移处是 header 长度）');
		assert.match(code, /node_modules\.asar\.unpacked/, '必须也算上 asar.unpacked（native 模块在那儿）');
		assert.match(code, /function packagePresent\(/, '必须有统一的"包在不在"判定');
		// ⚠ 必须钉**调用点与返回值**：只查函数定义会被"定义了但从不调用"骗过（实测假绿 ✗）
		assert.match(code, /asarHasPackage\(asar, spec\)/,
			'packagePresent 必须真的去问 asar（不看 asar ⇒ 纯 JS 包一律误判成缺件 ✗）');
		assert.match(code, /return existsSync\(asar\) \? asarHasPackage\(asar, spec\) : false;/,
			'asar 存在时必须走 asarHasPackage 判定');
	});

	test('3) 输入目录不像构建输出时必须明确提示（别硬报假缺失）', () => {
		const code = stripComments(read(GATE));

		assert.match(code, /resources\/app\/out\/main\.js/, '必须用 out/main.js 判断"这是不是构建输出目录"');
		assert.match(code, /不像构建输出目录/, '必须明确说"不像构建输出目录"');
		assert.match(code, /不是安装目录/, '必须提示"别指向安装目录"（装出来的结构不同 ⇒ 全是假警报）');
		// ⚠ 必须钉**控制流**：把条件改成 `if (false)` 就等于没这道提示（只查字符串会假绿 ✗）
		//   ⚠ 不用正则带距离（`{0,800}` 那种）—— 太脆（自己就假红过一次 ✗）⇒ 用**顺序判定**。
		const iIf = code.indexOf("if (!existsSync(join(appDir, 'out/main.js'))) {");
		const iMsg = code.indexOf('不像构建输出目录', iIf);
		const iExit = code.indexOf('process.exit(1);', iMsg);
		assert.ok(iIf > 0, '找不到"判断这是不是构建输出目录"那个 if');
		assert.ok(iMsg > iIf, '提示必须在那个 if 之后');
		assert.ok(iExit > iMsg, '退出必须在提示之后（同一个块里）');
	});
});
