/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「dev 与安装版不许抢同一个 Windows mutex」的守卫（2026-10-30）。
 *
 * 真机（用户报："开着打包版 exe 时，无法 F5 启动开发版"）：
 *
 *   `~/.vssaros-dev/code.lock` 的内容是 `28024`，而 28024 是
 *   `G:\…\.build\electron\VsSaros.exe … --user-data-dir C:\Users\…\.vssaros-dev`
 *   ⇒ 是**上一次 dev 实例自己还活着**（不是打包版）。这一条是"实例残留"，已按清理流程处理。
 *
 * 但排查时发现一个**真实隐患**（与上面那个独立）：
 *
 *   `win32MutexName`（`product.json` = `vssaros`）是 **Windows 全局命名对象**，**不随 userData 走**
 *   ⇒ `app.ts` 的 `installMutex()` 里 `new WindowsMutex.Mutex(win32MutexName)`
 *      ⇒ **dev 与安装版创建同名 mutex ⇒ 互相锁死**；
 *   ⇒ 而安装器的 `AppMutex` 查的也是这个名字（`build/gulpfile.vscode.win32.ts` 的 `AppMutex`）
 *      ⇒ **dev 在跑时，装安装包会提示"请先关闭 VsSaros"**（用户只想关安装版）。
 *
 * 修法：`installMutex()` 里 **dev（`!isBuilt`）用 `-dev` 后缀**，安装版保持原名
 * （与 Inno 的 `AppMutex` 一致 ✓）。判据必须用 `isBuilt`，**不能用 `app.isPackaged`**
 * —— 本仓库既有结论（见 `app.ts` 里 agentmemory 端口 3111/3112 那段注释的依据）。
 *
 * ⚠ `main.ts` 的 `checkInnoSetupMutex()` **不改**：它是 `mutex.isActive('vssaros-updating')` 的
 *   **读取方**，名字必须与 Inno 编译期写死的一致；dev 改了反而查不到安装器。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshDevMutexIsolated
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const APP = 'src/vs/code/electron-main/app.ts';
const MAIN = 'src/vs/code/electron-main/main.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('dev 与安装版的 Windows mutex 必须分开', () => {

	test('1) installMutex 里 dev 必须用 -dev 后缀，且判据是 isBuilt', () => {
		const src = stripComments(read(APP));
		const at = src.indexOf('private async installMutex(): Promise<void> {');
		assert.ok(at > 0, '找不到 installMutex');
		const body = src.slice(at, at + 1400);

		// 必须真的派生一个带后缀的名字
		assert.match(body, /`\$\{rawMutexName\}-dev`/,
			'dev 必须用 `<mutexName>-dev`（否则与安装版创建同名 mutex ⇒ 互相锁死 ✗）');
		// 判据必须是 isBuilt（不能用 app.isPackaged —— 本仓库既有结论）
		assert.match(body, /!this\.environmentMainService\.isBuilt/,
			'dev 判据必须是 `!isBuilt`（`app.isPackaged` 在本仓库不可靠）');
		assert.ok(!/app\.isPackaged/.test(body), 'installMutex 里不许用 app.isPackaged 判 dev');
		// 仍然要真的创建 mutex（别为了分离把功能删了）
		assert.match(body, /new WindowsMutex\.Mutex\(win32MutexName\)/,
			'必须仍然创建 mutex（只是名字按 dev/安装版分开）');
	});

	test('2) 安装版必须保持原名（要与 Inno 的 AppMutex 对得上）', () => {
		const app = stripComments(read(APP));
		const at = app.indexOf('private async installMutex(): Promise<void> {');
		const body = app.slice(at, at + 1400);
		// 三元必须是「dev 才加后缀，否则原名」
		assert.match(body, /isBuilt \? `\$\{rawMutexName\}-dev` : rawMutexName/,
			'必须写成 `!isBuilt ? `<name>-dev` : `<name>``（安装版用原名，才能和 Inno 的 AppMutex 匹配）');

		// Inno 侧确实用 product.win32MutexName 作为 AppMutex
		const gulp = read('build/gulpfile.vscode.win32.ts');
		assert.match(gulp, /AppMutex: product\.win32MutexName/,
			'Inno 的 AppMutex 必须取 product.win32MutexName —— 这就是"安装版不能改后缀"的依据');
	});

	test('3) checkInnoSetupMutex 不许跟着改（它是读取方，名字要与 Inno 写死的一致）', () => {
		const main = stripComments(read(MAIN));
		const at = main.indexOf('private async checkInnoSetupMutex(');
		assert.ok(at > 0, '找不到 checkInnoSetupMutex');
		const body = main.slice(at, at + 1200);
		assert.match(body, /`\$\{productService\.win32MutexName\}-updating`/,
			'读取方必须保持 `<name>-updating`（Inno 编译期写死的名字；dev 改了就查不到安装器 ✗）');
		assert.ok(!/-dev/.test(body), 'checkInnoSetupMutex 里不许出现 -dev（它会破坏与安装器的匹配）');
	});
});
