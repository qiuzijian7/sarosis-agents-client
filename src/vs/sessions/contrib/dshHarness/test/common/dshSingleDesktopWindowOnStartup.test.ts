/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「一次启动只能有一扇桌面窗口，且 IDE 不许闪一下」的守卫（2026-10-31）。
 *
 * 真机（`main(8).log`，用户 yueezhu）：**一次启动开了 4 个窗口**
 *
 *     id=1  IDE（openAgentsWindow，hidden ✓）
 *     id=2  IDE（LaunchMainService.startOpenWindow ← 第二次启动请求经单实例 handoff）  ✗ 多一个
 *     id=3  "VsSaros — Desktop"
 *     id=4  "VsSaros — Desktop"                                                        ✗ 多一扇
 *
 * 两条根因：
 *   ① `claimDesktopAutoOpen` 按 **windowId** 记 ⇒ 两个 IDE 窗口各自 claim 成功 ⇒ 各开一扇桌面窗口；
 *   ② `startHidden` 只对 `isInitialStartup === true` 的**首个**窗口生效 ⇒ 第二个 IDE 窗口是
 *      **可见**地建出来的，随后才被桌面流程藏回去 ⇒ 用户看到 IDE 闪一下 ✗✗。
 *
 * 修法：
 *   ① claim 改成**应用级**（第一个来认领的窗口赢，`_desktopAutoOpenClaimed`）；
 *   ② 启动**宽限期**（30s）内新建的窗口同样建窗即隐藏（用户之后主动开的"新建窗口"不受影响）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshSingleDesktopWindowOnStartup
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
const WMS = 'src/vs/platform/windows/electron-main/windowsMainService.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 只去"整行 //"（这些文件里有含 `/*` 的字符串/注释，块注释正则会吞掉半个文件 ⇒ 假红/假绿） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('一次启动只开一扇桌面窗口（IDE 不闪）', () => {

	test('1) claim 必须是应用级（不许按 windowId 各自成功）', () => {
		const src = code(CHANNEL);
		assert.match(src, /private _desktopAutoOpenClaimed = false;/, '缺少应用级认领标记');
		const at = src.indexOf('case DshHarnessChannelCommand.ClaimDesktopAutoOpen:');
		assert.ok(at > 0, '找不到 ClaimDesktopAutoOpen 分支');
		const body = src.slice(at, at + 1500);
		const iGate = body.indexOf('if (this._desktopAutoOpenClaimed) {');
		const iAdd = body.indexOf('this._desktopAutoOpened.add(windowId);');
		assert.ok(iGate > 0, '必须先过应用级闸门（否则多窗口各开一扇 ✗）');
		assert.ok(iAdd > iGate, '闸门通过后才登记');
		assert.ok(!/if \(this\._desktopAutoOpened\.has\(windowId\)\) \{\s*return false;/.test(body),
			'旧"按 windowId 判重"的写法不许再作为唯一闸门');
	});

	test('2) startHidden 必须覆盖启动宽限期（不只是首个窗口）', () => {
		const src = code(WMS);
		assert.match(src, /private readonly _appStartedAt = Date\.now\(\);/, '缺少启动时刻字段');
		assert.match(src, /startHidden: this\._wantsHiddenStart\(\) && \(configuration\.isInitialStartup === true \|\| Date\.now\(\) - this\._appStartedAt < 30_000\)/,
			'startHidden 必须同时认"启动宽限期内"（第二个 IDE 窗口才会建窗即隐藏 ⇒ 不闪）');
		assert.ok(!/startHidden: configuration\.isInitialStartup === true && this\._wantsHiddenStart\(\)/.test(src),
			'旧"只认首个窗口"的写法不许回来（那正是 IDE 闪一下的根因）');
	});
});
