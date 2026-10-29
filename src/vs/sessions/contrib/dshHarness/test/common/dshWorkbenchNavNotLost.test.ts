/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「侧栏『🏠 主页』那一行不许一次异常就永久丢失」的守卫（2026-10-29）。
 *
 * 真机（v2.2.26212 桌面窗口）：侧栏品牌头下面**直接就是「新会话」**，`🏠 主页` 那一行不见了。
 * 而日志里 **没有任何** `[vssaros] 工作台导航注册失败` ⇒ 说明 `install()` 在跑到注册点**之前**
 * 就中断了，且**没有留下任何痕迹**。
 *
 * 病根（`client.workbenchNav.js` 自己 300 行附近的注释描述过同一个坑，但没兜住）：
 *
 * ```js
 * if (window.__vssarosWorkbenchNavInstalled) { return; }
 * window.__vssarosWorkbenchNavInstalled = true;   // ← 在任何可能抛错的逻辑之前就置位
 * ...
 * (() => { /* 隐藏官方「插件/自动化任务」行：DOM + MutationObserver *\/ })();   // ← 在「主页」行注册之前
 * ...
 * safeInject("nav:主页行", SLOT_NAV, …)          // ← 真正注册
 * ```
 *
 * ⇒ 那段 IIFE 抛一次错 ⇒ `install` 中断 ⇒ **标记已是 true** ⇒ 重试与 1500ms 兜底
 *  全被那行 `return` 掉 ⇒ 「主页」行在整个页面生命周期里**永远补不回来** ✗✗。
 *
 * 修法：把那段 IIFE 整体包 `try/catch`，**catch 里 `delete window.__vssarosWorkbenchNavInstalled`**
 * ⇒ 隐藏官方行失败不影响「主页」行，且下一次装载还能自愈 ✓。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshWorkbenchNavNotLost
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const NAV = 'dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js';
const ENTRY = 'dsh-plugins/vssaros-chat-surface/lib/client.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('侧栏「主页」行不许被一次异常永久带走', () => {

	test('1) 隐藏官方行的 IIFE 必须被 try/catch 包住，且失败时摘掉幂等标记', () => {
		const src = read(NAV);

		// 幂等标记必须还在（去掉它会导致重复装载 ⇒ keyed 槽冲突）
		assert.match(src, /if \(window\.__vssarosWorkbenchNavInstalled\) \{ return; \}/,
			'幂等早退必须保留（否则重复装载 ⇒ 官方 keyed 槽冲突）');
		assert.match(src, /window\.__vssarosWorkbenchNavInstalled = true;/,
			'幂等标记必须保留');

		// ⚠ 必须钉**控制流**：`try {` 要出现在 IIFE 之前，catch 里要 delete 标记
		const iTry = src.indexOf('try {\n\t\t\t(() => {');
		const iTryCrlf = src.indexOf('try {\r\n\t\t\t(() => {');
		const tryAt = iTry >= 0 ? iTry : iTryCrlf;
		assert.ok(tryAt > 0, '隐藏官方行的 IIFE 必须被 try { 包住（否则它抛错会带走「主页」行）');

		const iDelete = src.indexOf('delete window.__vssarosWorkbenchNavInstalled;', tryAt);
		assert.ok(iDelete > tryAt, 'catch 里必须 delete 幂等标记（否则重试永远被那行 return 掉）');

		// ⚠ 顺序：try 必须在「主页」行注册**之前**（它本来就是 HOME 行前面的那段）
		const iHome = src.indexOf('safeInject("nav:主页行"');
		assert.ok(iHome > tryAt, '「主页」行注册必须在被保护的 IIFE 之后（顺序保持原样）');
	});

	test('2) 入口 client.js 必须比 chunk 新（否则用户吃旧 chunk，看到旧界面）', () => {
		const entry = fs.statSync(path.join(process.cwd(), ENTRY));
		const chunk = fs.statSync(path.join(process.cwd(), NAV));
		assert.ok(entry.mtimeMs >= chunk.mtimeMs,
			'入口 lib/client.js 的 mtime 比改过的 chunk 旧 ⇒ ?rev 不变 ⇒ 浏览器吃旧 chunk '
			+ '（2026-10-21 的「主页丢一行」就是这么来的 ✗）—— 改完 chunk 后请动一下 CLIENT_BUILD_STAMP 那行注释');
	});
});
