/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **dsh 插件页的页内导航**守卫（2026-10-15 建立）。
 *
 * 起因（主进程日志实证）：用户在「记忆库」点「查看完整记忆」反复"没反应"，日志里每点一次就是一行
 * `webContents#will-navigate: Prevented webcontent navigation` —— `app.ts` 的全局 `web-contents-created`
 * 守卫对**所有** webContents 的页内导航一律 `preventDefault`（只豁免集成浏览器）⇒ `dshViewHost.ts`
 * 自己的"同源放行"**从未生效**，插件页的 `<a href>` / `<form>` / `location.href` 全部静默失效。
 *
 * 不变量：
 *   ① `app.ts` 的全局 `will-navigate` 守卫在 `preventDefault` **之前**豁免 dsh 视图；
 *   ② 豁免判据（`DshViewHost.isDshViewWebContents`）真的有人登记（dsh 视图的 Session 被加入集合）；
 *   ③ 豁免后的权限仍在 `dshViewHost.ts`：`will-navigate` 只放行同源、跨源 `preventDefault`。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshViewNavigationGuard
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const APP = 'src/vs/code/electron-main/app.ts';
const VIEW_HOST = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 去掉注释（防"注释里写了豁免"造成假绿）。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

/** 取 `contents.on('will-navigate', …)` 的处理器体（到第一个 `preventDefault` 为止）。 */
function globalNavigateHandlerHead(app: string): string {
	const start = app.indexOf(`contents.on('will-navigate'`);
	assert.ok(start >= 0, `app.ts 里找不到全局 will-navigate 守卫（结构变了？要同步本守卫）`);
	const stop = app.indexOf('preventDefault', start);
	assert.ok(stop > start, 'app.ts 的全局 will-navigate 守卫里找不到 preventDefault');
	return app.slice(start, stop);
}

suite('dsh 插件页导航守卫（app.ts 全局拦截 ⇄ DshViewHost 同源放行）', () => {

	test('① app.ts 的全局 will-navigate 守卫在 preventDefault 之前豁免 dsh 视图', () => {
		const app = stripComments(read(APP));
		const head = globalNavigateHandlerHead(app);
		assert.ok(/if\s*\(\s*DshViewHost\.isDshViewWebContents\(\s*contents\s*\)\s*\)\s*\{\s*return;?\s*\}/.test(head),
			'全局 will-navigate 守卫没有在 preventDefault 之前豁免 dsh 视图 ⇒ 插件页的链接/表单/location.href 会被全部拦掉（"点了没反应"）');
		assert.ok(/import\s*\{\s*DshViewHost\s*\}\s*from\s*'[^']*dshHarness\/electron-main\/dshViewHost\.js'/.test(app),
			'app.ts 没有 import DshViewHost');
	});

	test('② 豁免判据有人登记：dsh 视图的 Session 被加入 _knownSessions', () => {
		const host = stripComments(read(VIEW_HOST));
		assert.ok(/static\s+isDshViewWebContents\s*\(\s*contents[^)]*\)\s*:\s*boolean\s*\{\s*return\s+DshViewHost\._knownSessions\.has\(\s*contents\.session\s*\)/.test(host),
			'isDshViewWebContents 的判据不是"按 Session 查集合"');
		assert.ok(/DshViewHost\._knownSessions\.add\(\s*ses\s*\)/.test(host),
			'没有任何地方把 dsh 视图的 Session 登记进 _knownSessions ⇒ 豁免永远不生效');
		assert.ok(/session:\s*this\.session\b/.test(host), 'dsh 视图没有用 `this.session`（登记点所在的 getter）创建');
	});

	test('③ 豁免后导航权限仍在 DshViewHost：will-navigate 只放行同源', () => {
		const host = stripComments(read(VIEW_HOST));
		const start = host.indexOf(`wc.on('will-navigate'`);
		assert.ok(start >= 0, 'dshViewHost.ts 里找不到 will-navigate 守卫 ⇒ 豁免后插件页可以导航到任意地址 ✗');
		const body = host.slice(start, host.indexOf('});', start));
		assert.ok(/!isSameOrigin\(\s*url\s*,\s*this\._connection\.origin\s*\)/.test(body) && /event\.preventDefault\(\)/.test(body),
			'dshViewHost 的 will-navigate 守卫不再是"非同源即 preventDefault"');
		const redirect = host.indexOf(`wc.on('will-redirect'`);
		assert.ok(redirect >= 0, 'dshViewHost.ts 里找不到 will-redirect 守卫');
	});
});
