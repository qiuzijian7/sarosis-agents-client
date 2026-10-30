/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「开发版 exe 必须与安装版不同名」的守卫（2026-10-30）。
 *
 * 背景（用户要求："开发版的 exe 改名叫 **VsSaros Dev.exe** 与打包版区分开"）：
 *
 * dev 与安装版的 exe 原来**同名** `VsSaros.exe`：
 *   · dev：`<repo>\.build\electron\VsSaros.exe`
 *   · 安装版：`D:\Program Files\VsSaros\VsSaros.exe`
 *
 * ⇒ 今天因此连撞三次：
 *   1. 启动器按**进程名**判"dev 实例是否在跑"⇒ 把安装版那十几个进程当成 dev
 *      ⇒ `SKIP a dev instance is already running (visible window present)` + `RAISE NOTFOUND`
 *      ⇒ **开着打包版时 F5 起不来**（而那一刻 dev 进程是 0 个）；
 *   2. 任何"按名字找窗口/杀进程"的脚本都会误伤另一边；
 *   3. 安装器的 `AppMutex` 与 dev 的 mutex 同名 ⇒ dev 在跑时装安装包会提示"先关闭 VsSaros"。
 *
 * 修法：dev 用**独立 exe 名** `VsSaros Dev.exe`（启动器从源 exe 复制，Electron 认同级 `resources/`）。
 *   ⚠ 刻意**不改 `product.json.nameShort`** —— 那份 dev 与打包版共用，改了会连带安装器/快捷方式。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshDevExeNameIsolated
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const LAUNCHER = 'scripts/start-dev-app.mjs';
const LAUNCH_JSON = '.vscode/launch.json';
const PS_FILES = ['scripts/has-visible-window.ps1', 'scripts/raise-dev-window.ps1'];

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('开发版 exe 与安装版不同名', () => {

	test('1) 启动器必须用独立名，并且从源 exe 复制出来', () => {
		const src = read(LAUNCHER);
		assert.match(src, /const DEV_EXE_NAME = 'VsSaros Dev\.exe'/,
			'必须有 DEV_EXE_NAME = \'VsSaros Dev.exe\'（与安装版区分）');
		assert.match(src, /const EXE = ensureDevExe\(\);/,
			'EXE 必须来自 ensureDevExe()（保证每次编译后重新复制，别跑旧 exe）');
		assert.match(src, /fs\.copyFileSync\(src, dst\)/,
			'ensureDevExe 必须真的复制（源 exe 每次编译会更新）');
		// ⚠ 旧写法（EXE_NAMES 里混着安装版名字）不许回来
		const code = stripComments(src);
		assert.ok(!/const EXE_NAMES = /.test(code),
			'不许再回到"EXE_NAMES 里混着 VsSaros.exe"的写法（那正是误判的根源）');
	});

	test('2) taskkill 只许杀 dev 名（绝不能按安装版的名字杀）', () => {
		const code = stripComments(read(LAUNCHER));
		const killLines = code.split('\n').filter(l => /taskkill/.test(l));
		assert.ok(killLines.length > 0, '找不到 taskkill（自愈分支里应有）');
		for (const l of killLines) {
			assert.ok(!/['"]VsSaros\.exe['"]/.test(l),
				'不许 taskkill `VsSaros.exe` —— 那是安装版的名字，会把用户正在用的打包版杀掉 ✗');
		}
		assert.match(code, /for \(const name of \[DEV_EXE_NAME\]\)/,
			'自愈时只杀 dev 专用名');
	});

	test('3) 找窗口的脚本与 attach 配置都必须认 dev 名', () => {
		for (const f of PS_FILES) {
			const ps = read(f);
			assert.match(ps, /'VsSaros Dev'/,
				f + ' 的默认进程名必须包含 `VsSaros Dev`（否则会把安装版的窗口当成 dev 的 ✗）');
		}
		const launch = read(LAUNCH_JSON);
		assert.ok(launch.includes('.build/electron/VsSaros Dev.exe'),
			'launch.json 的 runtimeExecutable 必须指向 VsSaros Dev.exe');
		assert.ok(!/\.build\/electron\/VsSaros\.exe"/.test(launch),
			'launch.json 不许再指向旧的 .build/electron/VsSaros.exe');
	});
});
