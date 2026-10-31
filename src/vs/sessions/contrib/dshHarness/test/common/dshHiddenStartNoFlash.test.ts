/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「隐藏启动期间不许被激活 ⇒ IDE 窗口不许闪一下」的守卫（2026-10-31）。
 *
 * 真机（dev 日志 20261031T180758，F5 后 IDE 窗口一闪、随后才出 desktop）：
 *   18:07:58  IDE 窗口建出（startHidden ⇒ `options.show = false`）
 *   18:08:02  `[dshHarness] window 1 BLUR`      ← 它拿到过 OS 焦点（BLUR ⇒ 此前被激活）
 *   18:08:03  `desktop 守卫：已装（窗口 1, hidden=true）`  ← 我们 1s 后才藏住
 *   18:08:03  桌面窗口建出并显示
 *
 * ⇒ `show:false` **只保证"构造时不画"**，拦不住 Chromium 把首个窗口**激活**
 *   ⇒ 激活会让窗口短暂画出来 / 在任务栏闪一下 ⇒ 用户看到"IDE 一闪消失"。
 *
 * 修法（windowImpl.ts）：
 *   · 隐藏期 `options.skipTaskbar = true`（显示时 `onShown` 里恢复 false）；
 *   · 隐藏期监听 `focus`：一旦被激活立刻 `hide()` + `blur()` 收回（只在 `_startHidden` 为真时）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshHiddenStartNoFlash
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const W = 'src/vs/platform/windows/electron-main/windowImpl.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('隐藏启动期间不许被激活（IDE 不闪）', () => {

	test('1) 隐藏期必须同时设置 show=false 与 skipTaskbar=true', () => {
		const src = read(W);
		const at = src.indexOf('this._startHidden = config.startHidden === true;');
		assert.ok(at > 0, '找不到 _startHidden 的赋值');
		const block = src.slice(at, at + 900);
		assert.match(block, /options\.show = false;/, '必须 show=false（构造时不画）');
		assert.match(block, /options\.skipTaskbar = true;/,
			'必须 skipTaskbar=true：`show:false` 挡不住激活，激活会在任务栏/屏幕闪一下 ✗');
	});

	test('2) 隐藏期被激活必须立刻收回（hide + blur），且显示后要恢复成普通窗口', () => {
		const src = read(W);
		assert.match(src, /onFocusWhileHidden/, '必须有"隐藏期被激活 ⇒ 收回"的处理');
		const at = src.indexOf('const onFocusWhileHidden = () => {');
		assert.ok(at > 0, '找不到 onFocusWhileHidden');
		const body = src.slice(at, at + 700);
		// 只在仍隐藏时生效
		assert.match(body, /if \(!this\._startHidden/, '只在 _startHidden 为真时生效（显示后不许再抢焦点）');
		assert.match(body, /this\._win\.hide\(\);/, '被激活且可见 ⇒ 立刻 hide');
		assert.match(body, /this\._win\.blur\(\);/, '并 blur 掉焦点');
		// onShown 里恢复 skipTaskbar
		const shown = src.indexOf('const onShown = () => {');
		assert.ok(shown > 0, '找不到 onShown');
		assert.match(src.slice(shown, shown + 700), /setSkipTaskbar\(false\)/, '显示后要恢复任务栏（否则窗口永远不在任务栏）');
	});
});
