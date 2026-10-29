/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「正在重试」不许显示成「失败」的守卫（2026-10-29）。
 *
 * 真机：桌面窗口弹出黄条「会话启动失败（第 2/3 次）：[dshHarness] startSession: 控制桥不可用」，
 * 而页面同时显示「后台服务已就绪，正在加载界面…」—— 两个信息互相矛盾，而且"失败"是**假的**：
 * Host ready 之后 mux 路由还要几秒才可用 ⇒ 头一两次 startSession 必然失败 ⇒ 但几十秒后自己就好了。
 *
 * ⇒ 分两级：真的失败 = 黄条 + 「重试」按钮；正在重试 = 信息色条、**无按钮**、文案不写"失败"。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshDesktopSessionBanner
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const FULL_WINDOW = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `source missing (cwd changed?): ${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('桌面窗口的会话启动提示条分级', () => {

	test('1) 可重试的那一跳必须按「等待中」上报，不可重试的按「失败」', () => {
		const src = stripComments(read(FULL_WINDOW));

		const at = src.indexOf('private async _ensurePopoutSessionId(');
		assert.ok(at > 0, '_ensurePopoutSessionId not found');
		const end = src.indexOf('\n\tprivate ', at + 10);
		const body = src.slice(at, end > 0 ? end : at + 4000);

		const iDecision = body.indexOf('decideSessionStartRetry(');
		assert.ok(iDecision > 0, 'must use decideSessionStartRetry');
		const iFail = body.indexOf("'error'", iDecision);
		const iWait = body.indexOf("'waiting'", iDecision);
		assert.ok(iFail > 0, 'the non-retryable branch must report level "error"');
		assert.ok(iWait > 0, 'the retryable branch must report level "waiting"');
		assert.ok(iFail < iWait, 'the "error" report belongs to the non-retryable branch (must come first)');

		// 不可重试那一跳必须带 'error'
		const failLine = body.slice(body.lastIndexOf('\n', iFail) + 1, body.indexOf('\n', iFail));
		assert.match(failLine, /reporter\?\.\(message, attempt, 'error'\)/,
			'the non-retryable branch must report "error"');

		// 可重试那一跳必须带 'waiting'
		const waitLine = body.slice(body.lastIndexOf('\n', iWait) + 1, body.indexOf('\n', iWait));
		assert.match(waitLine, /reporter\?\.\(message, attempt, 'waiting'\)/,
			'the retryable branch must report "waiting" (not "failure")');
	});

	test('2) 「等待中」不许渲染重试按钮，措辞不许写「失败」', () => {
		const src = stripComments(read(FULL_WINDOW));

		const at = src.indexOf('private _showStartupBanner(');
		assert.ok(at > 0, '_showStartupBanner not found');
		const end = src.indexOf('\n\tprivate ', at + 10);
		const body = src.slice(at, end > 0 ? end : at + 4000);

		assert.match(body, /level: 'error' \| 'waiting' = 'error'/,
			'banner must accept a level (waiting = still retrying)');

		// 重试按钮只能在「失败」时渲染
		const iWaiting = body.indexOf('const waiting = level ===');
		assert.ok(iWaiting > 0, 'must compute `waiting` from level');
		const iIfNotWaiting = body.indexOf('if (!waiting) {');
		assert.ok(iIfNotWaiting > iWaiting, 'the retry button must be guarded by "if (!waiting)"');
		const iRetryBtn = body.indexOf("button.vssaros-desk-banner-retry");
		assert.ok(iRetryBtn > iIfNotWaiting, 'the retry button lives inside the "not waiting" branch');
		const iBtnText = body.indexOf("retry.textContent = '");
		assert.ok(iBtnText > iRetryBtn, 'retry button text must be inside that branch');

		// 等待中的文案不许出现「失败」—— 必须**精确取 waiting 那一支**（直接搜全文会被 error 分支骗过）
		const tern = /text\.textContent = waiting\s*\?\s*`([^`]*)`\s*:\s*`([^`]*)`/.exec(body);
		assert.ok(tern, 'the banner text must be a ternary on level (waiting vs error)');
		assert.ok(!/失败/.test(tern[1]),
			'the waiting wording must not say "失败"（那正是本次要修的误导 ✗）');
		assert.match(tern[1], /等待/, 'the waiting wording must say it is waiting');
		assert.match(tern[2], /失败/, 'the error wording must say "失败"');
	});
});
