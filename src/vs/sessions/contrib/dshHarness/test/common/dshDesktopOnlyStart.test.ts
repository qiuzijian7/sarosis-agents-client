/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「启动只露桌面窗口，不许 IDE 闪一下」的守卫（2026-10-31）。
 *
 * 真机（打包版 2026-10-31 09:50:23）：
 *   `[windowsManager] wantsHiddenStart=false（isBuilt=true, isEmbeddedApp=true, hasTarget=true）`
 * ⇒ IDE 主窗口**可见地**建出来，几秒后桌面窗口就绪才把它藏回去 ⇒ 用户看到 IDE 闪一下 ✗✗
 *   （对比：同日 10:01:57 那次 `hasTarget=false` ⇒ 隐藏 ✓ 没有闪）。
 *
 * 根因：`_wantsHiddenStart()` 里 `hasTarget`（文件 / 文件夹 / `--diff` / `--merge`）会**强制不隐藏**，
 *   而本 app 的主界面就是桌面窗口 ⇒ 带目标也应该继续藏着（目标照样被打开，只是发生在桌面窗口那边）。
 *
 * 修法：读取 `sessions.dshHarness.openDesktopOnStartup`（默认 `true`）——
 *   只要它没被用户关掉，**带目标也不露 IDE**；只有用户关掉它时才回到"带目标就露 IDE"的老语义。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshDesktopOnlyStart
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const WMS = 'src/vs/platform/windows/electron-main/windowsMainService.ts';
const CONTRIB = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('启动只露桌面窗口（不许 IDE 闪一下）', () => {

	test('1) 判据必须读"启动即开桌面窗口"设置，且它没被关掉时带目标也隐藏', () => {
		const src = read(WMS);
		const at = src.indexOf('private _wantsHiddenStart(): boolean {');
		assert.ok(at > 0, '找不到 _wantsHiddenStart');
		const body = src.slice(at, at + 3000);
		assert.match(body, /sessions\.dshHarness\.openDesktopOnStartup/,
			'必须读 `sessions.dshHarness.openDesktopOnStartup`（否则带目标时还是会露 IDE）');
		assert.match(body, /getValue<boolean>\('sessions\.dshHarness\.openDesktopOnStartup'\)\s*!==\s*false/,
			'读不到配置时要按"开着"处理（`!== false`）⇒ 默认不露 IDE');
		// ⚠ 关键表达式：hidden = (isBuilt||isEmbedded) && (openDesktopOnStartup || !hasTarget)
		assert.match(body, /const hidden = \(isBuilt \|\| isEmbedded\) && \(openDesktopOnStartup \|\| !hasTarget\);/,
			'隐藏判据必须是 `(isBuilt||isEmbedded) && (openDesktopOnStartup || !hasTarget)`');
		assert.ok(!/const hidden = !hasTarget && \(isBuilt \|\| isEmbedded\);/.test(body),
			'旧的 `!hasTarget && …` 判据不许回来（那正是 IDE 闪一下的根因）');
	});

	test('2) 日志必须带上 openDesktopOnStartup（下次再闪能一眼看出是哪个判据没成立）', () => {
		const src = read(WMS);
		assert.match(src, /wantsHiddenStart=\$\{hidden\}（isBuilt=\$\{isBuilt\}, isEmbeddedApp=\$\{isEmbedded\}, hasTarget=\$\{hasTarget\}, openDesktopOnStartup=\$\{openDesktopOnStartup\}）/,
			'日志要打印 hasTarget 与 openDesktopOnStartup 两个判据');
	});

	test('3) 该设置默认必须是 true（否则默认行为还是露 IDE）', () => {
		const src = read(CONTRIB);
		const at = src.indexOf('[DshHarnessSettings.OpenDesktopOnStartup]: {');
		assert.ok(at > 0, '找不到 OpenDesktopOnStartup 的配置声明');
		assert.match(src.slice(at, at + 300), /default: true/, '该设置默认必须是 true');
	});
});
