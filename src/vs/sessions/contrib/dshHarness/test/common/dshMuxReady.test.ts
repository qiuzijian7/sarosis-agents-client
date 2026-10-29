/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「等 mux 路由就绪再 startSession」的守卫（2026-10-29）。
 *
 * 真机现场（~/.vssaros-dev/logs/20261029T101501）：
 *   10:15:26.047  ready in 24258 ms (bridge: connected)
 *   10:15:30.823  mux route available +4777 ms after Host ready (probe #12)
 * ⇒ Host 说 ready 时 mux 升级路由**还没注册** ⇒ 这 4.8s（历史样本到 11.4s）里任何 session.start
 *   都必然失败 ⇒ 桌面窗口原本只能退避重试（4s/12s）并弹一条**假的**"启动失败"黄条。
 *
 * 本守卫钉三件事：
 *   ① 判据表（路由通/不通、Host 在 starting/stopped、超时）；
 *   ② 主进程把"路由已通"写进 status（探测成功 ⇒ 置位并广播；复用 Host ⇒ 直接就绪）；
 *   ③ 渲染进程真的**先等路由再 startSession**（顺序反了就白等）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshMuxReady
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { MUX_READY_WAIT_TIMEOUT_MS, decideMuxWait } from '../../common/dshMuxReady.js';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const FULL_WINDOW = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `source missing (cwd changed?): ${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 去掉注释（防"注释里写了 xxx"造成假绿）。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('桌面窗口：等 mux 路由就绪再发起会话', () => {

	test('① 判据表：路由通 ⇒ 立刻发起；未通/starting ⇒ 继续等；Host 没了/超时 ⇒ 不等', () => {
		assert.strictEqual(decideMuxWait({ state: 'running', muxReady: true }, 0, 20_000), 'proceed');
		assert.strictEqual(decideMuxWait({ state: 'running', muxReady: false }, 100, 20_000), 'wait');
		// 没有 muxReady 字段（旧状态/还没探测到）⇒ 继续等，不能当成通
		assert.strictEqual(decideMuxWait({ state: 'running' }, 100, 20_000), 'wait');
		// ⚠ starting 必须继续等：ensureStarted() 在"已 spawn"时就返回（不等 ready），
		//   那时状态正是 starting —— 这里判 giveup 的话，等待就白做了（本次要修的坑）。
		assert.strictEqual(decideMuxWait({ state: 'starting' }, 100, 20_000), 'wait');
		assert.strictEqual(decideMuxWait({ state: 'stopped' }, 100, 20_000), 'giveup');
		assert.strictEqual(decideMuxWait({ state: 'error' }, 100, 20_000), 'giveup');
		assert.strictEqual(decideMuxWait({ state: 'stopping' }, 100, 20_000), 'giveup');
		// 拿不到状态 ⇒ 继续等
		assert.strictEqual(decideMuxWait(undefined, 100, 20_000), 'wait');
		// 窗口边界
		assert.strictEqual(decideMuxWait({ state: 'running' }, 19_999, 20_000), 'wait');
		assert.strictEqual(decideMuxWait({ state: 'running' }, 20_000, 20_000), 'giveup');
		assert.strictEqual(decideMuxWait({ state: 'running' }, 99_999, 20_000), 'giveup');
		// ⚠ 负对照：路由已通时即使超时也必须立刻发起（否则白等到超时 ✗）
		assert.strictEqual(decideMuxWait({ state: 'running', muxReady: true }, 99_999, 20_000), 'proceed');
		// 默认窗口必须是 20s 量级（真机最坏样本 11.4s）
		assert.ok(MUX_READY_WAIT_TIMEOUT_MS >= 15_000, `等待窗口要盖住真机的 ~11.4s（实际 ${MUX_READY_WAIT_TIMEOUT_MS}ms）`);
	});

	test('② 主进程：探测到路由 ⇒ 置位并广播 status；复用 Host ⇒ 直接就绪', () => {
		const src = stripComments(read(SUPERVISOR));

		// status 里必须带上 muxReady（渲染进程就靠它判断）
		assert.match(src, /muxReady: status\.state === 'running' \? this\._muxReady : false/,
			'status 必须带上 muxReady（否则渲染进程无从判断 ✗）');

		// 探测成功的那一支：置位 + 再广播一次 status（不然渲染进程永远看不到变化 ✗）
		const probeAt = src.indexOf('private async _probeMuxAfterReady(');
		assert.ok(probeAt > 0, '找不到 _probeMuxAfterReady ✗');
		const probe = src.slice(probeAt, src.indexOf('\n\tprivate ', probeAt + 1));
		const iSet = probe.indexOf('this._muxReady = true;');
		assert.ok(iSet > 0, '探测到路由后必须置 _muxReady = true ✗');
		assert.ok(probe.indexOf('this._setStatus(', iSet) > iSet,
			'置位后必须再广播一次 status（否则状态变化传不到渲染进程 ✗）');

		// 复用既有 Host：那个 Host 早就 ready 过 ⇒ 路由必然已注册 ⇒ 直接就绪
		assert.ok(/this\._reused = true;[\s\S]{0,400}this\._muxReady = true;/.test(src),
			'复用 Host 时必须直接置 muxReady = true（否则对着早就通的路由白等 20s ✗）');

		// 新起 Host 之前必须复位（上一个 Host 的 true 不能带过来 ✗）
		assert.ok(/this\._muxReady = false;[\s\S]{0,200}state: 'starting'/.test(src),
			'新起 Host 前必须把 muxReady 复位为 false ✗');
	});

	test('③ 渲染进程：桌面窗口必须先等路由、再 startSession', () => {
		const svc = stripComments(read(SERVICE));
		assert.ok(svc.includes('async waitForMuxReady('), 'service 必须提供 waitForMuxReady ✗');
		assert.ok(svc.includes('decideMuxWait('), 'waitForMuxReady 必须走 common 的纯函数判据 ✗');

		const win = stripComments(read(FULL_WINDOW));
		const iWait = win.indexOf('await this._dsh.waitForMuxReady()');
		assert.ok(iWait > 0, '桌面窗口必须调用 waitForMuxReady ✗');
		const iStart = win.indexOf('this._dsh.startSession(');
		assert.ok(iStart > 0, '找不到 startSession 调用 ✗');
		assert.ok(iWait < iStart,
			'必须**先等路由**再 startSession（顺序反了 ⇒ 照样失败一次 + 弹假黄条 ✗）');
	});
});
