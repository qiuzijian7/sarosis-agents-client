/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「agents 应用启动必须至少开出一个窗口」的守卫（2026-10-30，外部机器 P0）。
 *
 * 真机（两台外部机器，安装路径不同，症状相同）：**装完第一次能用，之后每次启动都没有窗口**，
 * 进程常驻、日志只剩心跳。
 *
 *     [windowsManager][diag] no workspace requested/remembered → opening EMPTY agents window
 *     [windowsManager][diag] open() after ensureAgentsWindow | forceNewWindow=true | forceEmpty=false | urisToOpen=[]
 *     [launch][diag] open(forceNewWindow+forceEmpty) returned 0 window(s)
 *     （之后**没有** `wantsHiddenStart=` / `browser-window-created` —— 根本没进建窗）
 *
 * 链路（逐行对得上）：
 *   ① 新机器没有记住的工作区/兜底文件 ⇒ `ensureAgentsWindow` 走 case ④ ⇒ `urisToOpen: []` 且**不带 forceEmpty**；
 *   ② `getPathsToOpen` ⇒ 读「上次会话」⇒ 上次是**空窗口** ⇒ 返回 `{ backupPath }`（不是 `EMPTY_WINDOW`）
 *      ⇒ `maybeOpenEmptyWindow` 恒 false；
 *   ③ 这条 backup 被 `open()` 里 `initialStartup && !isAgentsApp` 的 else 分支**清空** ⇒ 无窗可开 ⇒ `[]`。
 *   本机永远有记住的工作区（case ③）⇒ 从不走到这里 ⇒ **只在新机器上复现**。
 *
 * 修法（两层，缺一不可）：
 *   · case ④ 显式 `forceEmpty: true`（该分支语义就是"开空窗"）；
 *   · `open()` 兜底：agents 应用在"过滤后无任何可开对象"时强制 `maybeOpenEmptyWindow = true`。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshAgentsWindowAlwaysOpens
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const WMS = 'src/vs/platform/windows/electron-main/windowsMainService.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).map(l => l.replace(/\s\/\/.*$/, '')).join('\n');
}

suite('agents 应用启动必须至少开出一个窗口', () => {

	test('1) ensureAgentsWindow 的 case ④（无工作区）必须带 forceEmpty: true', () => {
		const code = stripComments(read(WMS));
		const iMsg = code.indexOf("'[windowsManager][diag] no workspace requested/remembered → opening EMPTY agents window'");
		assert.ok(iMsg > 0, '找不到 case ④ 的日志行');
		const iRet = code.indexOf('return {', iMsg);
		const iEnd = code.indexOf('};', iRet);
		assert.ok(iRet > iMsg && iEnd > iRet, '找不到 case ④ 的返回对象');
		const obj = code.slice(iRet, iEnd);
		assert.match(obj, /forceEmpty:\s*true/,
			'case ④ 必须显式 forceEmpty: true —— 否则会去读上次会话的空窗 backup，被 agents 过滤掉后无窗可开 ✗');
		assert.match(obj, /urisToOpen:\s*\[\]/, 'case ④ 仍是空 urisToOpen（只是明确声明开空窗）');
	});

	test('2) open() 里必须有"agents 应用无可开对象 ⇒ 开空窗"的兜底，且在 doOpen 之前', () => {
		const code = stripComments(read(WMS));
		const iOpen = code.indexOf('async open(openConfig: IOpenConfiguration): Promise<ICodeWindow[]> {');
		assert.ok(iOpen > 0, '找不到 open()');
		const iClear = code.indexOf('emptyWindowsWithBackupsToRestore.length = 0;', iOpen);
		const iGuard = code.indexOf('if (isAgentsApp && !maybeOpenEmptyWindow', iOpen);
		const iSet = code.indexOf('maybeOpenEmptyWindow = true;', iGuard);
		const iDoOpen = code.indexOf('await this.doOpen(openConfig', iOpen);
		assert.ok(iClear > iOpen, '找不到 agents 应用清空 backup 的那段（结构变了？）');
		assert.ok(iGuard > iClear, '兜底必须在"清空 backup"之后（否则判断不到被清掉的情况）');
		assert.ok(iSet > iGuard, '兜底必须真的置 maybeOpenEmptyWindow = true');
		assert.ok(iDoOpen > iSet, '兜底必须在 doOpen 之前（doOpen 才会据此开空窗）');
		const guard = code.slice(iGuard, iSet);
		for (const cond of ['workspacesToOpen.length === 0', 'foldersToOpen.length === 0', '!filesToOpen', 'emptyWindowsWithBackupsToRestore.length === 0']) {
			assert.ok(guard.includes(cond), '兜底条件缺少 `' + cond + '`（只该在"确实无可开对象"时生效，不能多开窗）');
		}
	});

	test('3) doOpen 的开空窗条件仍认 maybeOpenEmptyWindow（兜底才有意义）', () => {
		const code = stripComments(read(WMS));
		assert.match(code, /if \(filesToOpen \|\| \(maybeOpenEmptyWindow && \(openConfig\.forceEmpty \|\| usedWindows\.length === 0\)\)\) \{/,
			'doOpen 末尾"开空窗"的条件变了 ⇒ 兜底可能失效，请同步复核');
	});
});
