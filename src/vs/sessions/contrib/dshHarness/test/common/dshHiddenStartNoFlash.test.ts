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
 * ★★ 2026-11-04 补强（**打包版 exe 仍闪**）：上面那条 focus 收回是**事后补救**，真机日志
 *   每次启动都会出现 `window#hiddenStart: 窗口在隐藏启动期间被激活 ⇒ 立刻收回` ⇒
 *   focus 触发时窗口已经被画出来了，`hide()` 追不上那一帧 ✗。
 *   ⇒ 从源头断掉：创建时 `options.focusable = false` ⇒ Chromium 无法激活首个窗口；
 *     正式显示时（`onShown`）必须 `setFocusable(true)` 恢复，否则用户点开的 IDE 拿不到焦点。
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

/**
 * 断言必须基于**去掉注释**的代码：注释里会写出 `setFocusable(true)` 这类字眼，
 * 只查文本会被"实现删了、注释还在"的突变骗成假绿（2026-11-04 踩过）。
 */
function code(rel: string): string {
	return read(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.filter(l => !/^\s*\/\//.test(l))
		.join('\n');
}

suite('隐藏启动期间不许被激活（IDE 不闪）', () => {

	test('1) 隐藏期必须同时设置 show=false 与 skipTaskbar=true', () => {
		const src = code(W);
		const at = src.indexOf('this._startHidden = config.startHidden === true;');
		assert.ok(at > 0, '找不到 _startHidden 的赋值');
		const block = src.slice(at, at + 900);
		assert.match(block, /options\.show = false;/, '必须 show=false（构造时不画）');
		assert.match(block, /options\.skipTaskbar = true;/,
			'必须 skipTaskbar=true：`show:false` 挡不住激活，激活会在任务栏/屏幕闪一下 ✗');
	});

	test('2) 隐藏期被激活必须立刻收回（hide + blur），且显示后要恢复成普通窗口', () => {
		const src = code(W);
		assert.match(src, /onFocusWhileHidden/, '必须有"隐藏期被激活 ⇒ 收回"的处理');
		assert.match(src, /\.on\('focus', onFocusWhileHidden\)/,
			'光有处理函数不够，必须真的注册到 focus 事件上（否则"被激活就收回"根本不会执行）');
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

	test('3) ★ 创建期必须不可聚焦（focusable=false），显示后必须恢复（setFocusable(true)）', () => {
		const src = code(W);
		const at = src.indexOf('this._startHidden = config.startHidden === true;');
		assert.ok(at > 0, '找不到 _startHidden 的赋值');
		const block = src.slice(at, at + 1600);
		assert.match(block, /options\.focusable = false;/,
			'必须从源头禁止激活：只靠 focus 事件里 hide() 是事后补救，窗口已经画出那一帧 ✗');
		const shown = src.indexOf('const onShown = () => {');
		assert.ok(shown > 0, '找不到 onShown');
		assert.match(src.slice(shown, shown + 700), /setFocusable\(true\)/,
			'正式显示后必须恢复可聚焦（否则用户点开的 IDE 窗口永远拿不到焦点）');
	});
});
