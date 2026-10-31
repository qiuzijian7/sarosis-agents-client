/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「打包脚本不许依赖 bash」的守卫（2026-10-29）。
 *
 * 真机（蓝盾 CI 日志 `VsSaros-Win-EXE-Package.log`，12:16:51）：
 *
 *     🧹 清理构建输出: E:\data\landun\VSCode-win32-x64
 *     ##[error] The system cannot find the path specified.     ← 连了几十条
 *     ⚠️  .map sourcemaps ⇒ 失败: Command failed: find "E:/data/landun/VSCode-win32-x64" -name "*.map" -type f 2>/dev/null
 *     🧹 清理空目录...
 *     ##[error] The system cannot find the path specified.
 *
 * ⇒ `strip-before-pack.mjs` 原来用 **bash 的 `du -sb` 和 `find … 2>/dev/null`** 算体积、清 *.map、清空目录，
 *   而打包**跑在 Windows CI 上**（cmd/PowerShell）⇒ 这三步**从来没成功过**（异常被 catch 吞掉 ⇒ 没人发现）：
 *   包里的 sourcemap 一直没清（体积白涨）、空目录一直没删。
 * ⇒ 全部改成 Node 自身实现（`dirSizeBytes` / `findFilesByName` / `removeEmptyDirs`）。
 *
 * 端到端验证（临时目录上跑真实脚本）：Windows 报错 **0 条**、`.map` 真被删、空目录真被删、
 * **正常文件保留**（没误删）、末尾门禁照常生效。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshStripCrossPlatform
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const STRIP = 'build/saros/strip-before-pack.mjs';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('打包脚本必须跨平台（不许依赖 bash）', () => {

	test('1) 代码里不许再调 bash 的 du / find / 2>/dev/null', () => {
		const code = stripComments(read(STRIP));

		assert.ok(!/execSync\(\s*`du /.test(code), '不许再用 `du -sb` 算体积（Windows CI 上没有 du）');
		assert.ok(!/execSync\(\s*`find /.test(code), '不许再用 bash `find` 找文件/删空目录（Windows CI 上没有 find）');
		assert.ok(!/2>\/dev\/null/.test(code), '不许再依赖 `2>/dev/null` 重定向（cmd 不认）');
		assert.ok(!/system cannot find the path specified/i.test(code), '不许在代码里出现 Windows 那句报错文本');
	});

	test('2) 三个 Node 实现都必须存在并被真实调用', () => {
		const code = stripComments(read(STRIP));

		for (const fn of ['dirSizeBytes', 'findFilesByName', 'removeEmptyDirs']) {
			assert.match(code, new RegExp('function ' + fn + '\\('), `缺少 ${fn} 的 Node 实现`);
			// 调用次数 ≥ 2（定义里可能递归一次 + 至少一处真实调用）
			const calls = (code.match(new RegExp('\\b' + fn + '\\(', 'g')) ?? []).length;
			assert.ok(calls >= 2, `${fn} 必须在脚本里被真实调用（现在只有 ${calls} 处）`);
		}

		// 具体落点：体积 / *.map / 空目录
		assert.match(code, /size = dirSizeBytes\(absPath\)/, 'removeDir 必须用 dirSizeBytes 统计体积');
		assert.match(code, /const files = findFilesByName\(buildDir, pattern\)/, '*.map 清理必须用 findFilesByName');
		// macOS 支持（2026-10-31）：路径可能经 toStagingRel() 映射 ⇒ 两种形态都接受
		assert.match(code, /removeEmptyDirs\(join\(buildDir, (?:toStagingRel\()?'resources\/app\/node_modules'\)?\)\)/,
			'空目录清理必须用 removeEmptyDirs（macOS 下可经 toStagingRel 映射）');
	});

	test('3) macOS 的 .app 布局必须被识别并做路径映射', () => {
		const code = stripComments(read(STRIP));

		// 没有这两样 ⇒ macOS 产物里 `resources/app/…` 会全部落到不存在的路径
		// ⇒ 自愈/清理/门禁全静默失效（包能打出来，但内容缺件）。
		assert.match(code, /function detectBuildDir\(/, '缺少 detectBuildDir：识别 VSCode-darwin-<arch>/<Name>.app');
		assert.match(code, /function toStagingRel\(/, '缺少 toStagingRel：把 resources/app/… 映射到 Contents/Resources/app/…');
		assert.match(code, /Contents\/Resources\/app/, 'MAC_APP_SUB 必须是 Contents/Resources/app');
	});
});
