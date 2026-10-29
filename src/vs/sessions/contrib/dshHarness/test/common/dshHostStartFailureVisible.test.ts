/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「Host 起不来不许变成纯黑屏」的守卫（2026-10-29）。
 *
 * 真机（v2.2.26210 桌面窗口纯黑、零信息）：
 *
 *     [vssaros-bridge] module loaded (host uptime 2683ms)
 *     failed to import: ERR_MODULE_NOT_FOUND: Cannot find module
 *       '…profiles\vssaros\node_modules\@vssaros\dsh-kb\vendor\markdown-it.cjs'
 *     vssaros-bridge   webServer, connection, sessionController
 *     start failed: Host 启动期间退出（code 1）
 *
 * ⇒ Host 死了 ⇒ dsh 的 web server 没起来 ⇒ 页面**无内容** ⇒ 纯黑。
 *
 * ★ 为什么是"纯黑"而不是"一句错误"：
 *   ① `ensureStarted()` 原来**不检查** `s.error` ⇒ Host 失败时它 **resolve** 了
 *      ⇒ 调用方以为"后台服务已启动" ⇒ 继续建视图；
 *   ② 视图是**原生 `WebContentsView`** ⇒ 它**永远盖在 DOM 占位之上**
 *      ⇒ `dshFullWindowContribution` 里那段"占位盖着、等换皮锚点出现再显示视图"的设计
 *        在原生视图下**是无效的**（DOM 占位被原生视图压住 ⇒ 文案看不见）；
 *   ③ 而 `ensureStarted()` 若**抛错**，上层就有现成的一条路：
 *      `booting.textContent = 'VsSaros 后台服务启动失败：…'` ⇒ **窗口里能看到原因** ✓。
 *
 * ⇒ 守卫钉住：**`ensureStarted()` 必须把失败变成异常**（否则又回到"黑屏零信息"）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshHostStartFailureVisible
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const FULLWIN = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('Host 起不来不许变成纯黑屏', () => {

	test('1) ensureStarted 必须在 Host 失败时抛错', () => {
		const src = stripComments(read(SERVICE));
		const at = src.indexOf('async ensureStarted()');
		assert.ok(at > 0, '找不到 ensureStarted');
		const end = src.indexOf('\n\tasync ', at + 10);
		const body = src.slice(at, end > at ? end : at + 4000);

		// ⚠ 必须真的**抛**（throw），不能只打日志/返回状态
		assert.match(body, /if \(s\.error\)/, '必须检查返回状态里的 error（Host 失败时 Start 是 resolve 的）');
		assert.match(body, /throw new Error\(/, '必须抛错（否则调用方以为启动成功 ⇒ 建视图 ⇒ 原生 webview 盖住占位 ⇒ 纯黑 ✗✗）');
		// 失败信息要带上插件问题（那才是真正的根因）
		assert.match(body, /pluginProblems/, '异常信息里要带上 pluginProblems（真机根因就在那儿）');
	});

	test('2) 窗口里那条失败文案必须还在（抛错后它就是唯一的提示）', () => {
		const src = stripComments(read(FULLWIN));
		assert.match(src, /VsSaros 后台服务启动失败/,
			'桌面窗口必须有"后台服务启动失败"的文案（Host 挂掉时用户唯一能看到的提示）');
	});
});
