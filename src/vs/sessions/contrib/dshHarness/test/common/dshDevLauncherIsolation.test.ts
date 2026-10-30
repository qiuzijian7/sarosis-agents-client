/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「开着打包版时 F5 必须能起 dev」的守卫（2026-10-30）。
 *
 * 真机症状：**打包版 exe 已启动**，在 IDE 里按 F5 ⇒ **app 起不来/卡住**，界面毫无变化。
 *
 * 日志（`~/.vssaros-dev/logs/app-exit.log`）：
 *
 *     2026-10-30 10:01:02.493  LAUNCH pid=28800 argv=(none)
 *     2026-10-30 10:01:03.983  SKIP a dev instance is already running (visible window present), attach to it
 *     2026-10-30 10:01:04.305  RAISE NOTFOUND
 *
 * 而那一刻 **dev 进程是 0 个**（`pid=28800` 已不存在）⇒ "已有实例"是**误判**。
 *
 * 根因（`scripts/start-dev-app.mjs` 的 `running()`）：
 *
 * ```js
 * // 旧：只按**进程名**数
 * tasklist /fi "IMAGENAME eq VsSaros.exe"
 * ```
 *
 * ⇒ **dev 的 exe 与安装版同名**（`.build\electron\VsSaros.exe` vs `D:\Program Files\VsSaros\VsSaros.exe`）
 * ⇒ 打包版那十几个进程被当成"dev 实例" ⇒ `if (running() > 0)` 命中 ⇒ SKIP
 * ⇒ `raiseExistingWindow()` 又找不到 dev 窗口（`RAISE NOTFOUND`）⇒ **F5 卡住、没有 app** ✗✗
 *
 * 修法：`running()` 改成按 **`ExecutablePath`（可执行文件路径）** 过滤，只数本仓库
 * `.build/electron/` 下的进程；**探测失败当 0**（宁可重复起一个，也不要永远 SKIP 把 F5 锁死）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshDevLauncherIsolation
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const LAUNCHER = 'scripts/start-dev-app.mjs';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('打包版在跑时 F5 也要能起 dev', () => {

	test('1) running() 不许按进程名数（dev 与安装版同名 VsSaros.exe ⇒ 必然误判）', () => {
		const code = stripComments(read(LAUNCHER));
		const at = code.indexOf('const running = () => {');
		assert.ok(at > 0, '找不到 running()');
		const body = code.slice(at, at + 1600);

		// ⚠ 钉**调用**：代码里不许再真的调 tasklist（注释里提它是可以的，stripComments 已去掉注释）
		assert.ok(!/spawnSync\('tasklist'/.test(body),
			'running() 不许再用 tasklist 按名字数进程（打包版同名 ⇒ 会被当成 dev 实例 ⇒ F5 永远 SKIP ✗）');
		assert.ok(!/IMAGENAME eq/.test(body),
			'running() 不许再用 IMAGENAME 过滤（那是按名字，不是按路径）');

		// 必须按可执行路径过滤
		assert.match(body, /ExecutablePath/, 'running() 必须取 ExecutablePath（按路径区分 dev 与安装版）');
		assert.match(body, /path\.join\(REPO, '\.build', 'electron'\)/,
			'必须用本仓库 .build/electron 目录作为判据（只有它才是 dev 实例）');
		assert.match(body, /startsWith\(devDir\)/, '必须按路径前缀匹配（只数 dev 目录下的）');
	});

	test('2) 探测失败必须当 0（宁可重复起，也不许永远 SKIP）', () => {
		const code = stripComments(read(LAUNCHER));
		const at = code.indexOf('const running = () => {');
		const body = code.slice(at, at + 1600);
		assert.match(body, /catch \{\s*return 0;/s,
			'探测异常必须 return 0 —— 否则一次探测失败就会把 F5 永久挡住 ✗');
	});

	test('3) SKIP 分支的入口条件仍然只看 running()（不许再加"按名字"的旁路）', () => {
		const code = stripComments(read(LAUNCHER));
		assert.match(code, /if \(running\(\) > 0\) \{/,
			'SKIP 的入口必须只由 running() 决定（它现在按路径判，是正确判据）');
		// hasVisibleAppWindow 只在这个分支内使用 ⇒ 不会单独把 F5 挡住
		const iIf = code.indexOf('if (running() > 0) {');
		const iWin = code.indexOf('hasVisibleAppWindow()', iIf);
		assert.ok(iWin > iIf, 'hasVisibleAppWindow 必须在 `running() > 0` 分支内使用');
	});
});
