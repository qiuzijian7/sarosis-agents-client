/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「页面命令不许静默丢弃」的守卫（2026-10-29）。
 *
 * 真机报障（聊天框顶部「专属 agent」胶囊菜单）：
 *   · 「开新会话」⇒ **完全没反应**；
 *   · 「Agent 主页」「Agent 设置」⇒ 弹出黑框。
 *
 * 查出来的两条：
 *   1) 宿主侧 `case 'newChat'` **只处理 `dsh-plugin-` 前缀的视图**，聊天视图直接落到函数末尾的
 *      `return` ⇒ 命令到了也被**静默丢弃**：不执行、不打日志、不给页面回执 ⇒ 用户只看到"没反应"✗。
 *      （同文件下面 openFile 那条早就有"必须留痕"的教训 ⇒ 同一坑第二次复发。）
 *   2) 页面侧 `client.capsule.js` 的三个入口**没有任何 console 输出** ⇒ 页面 console 会被转发成
 *      IDE 日志的 `[dshHarness] page console(warn) …`（实测）⇒ 不写就等于"查不到"。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshChatCommandNotSilent
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const CONTRIB = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';
const CAPSULE = 'dsh-plugins/vssaros-chat-surface/lib/client.capsule.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `source missing (cwd changed?): ${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('页面命令不许静默丢弃', () => {

	test('1) 宿主侧：聊天视图的 newChat/openSession 必须留痕 + 给用户提示', () => {
		const src = stripComments(read(CONTRIB));

		const at = src.indexOf("case 'newChat':");
		assert.ok(at > 0, "case 'newChat' not found");
		// ⚠ 必须按**行**切：`case 'newChat':` 后面紧跟着就是 `case 'openSession':`（共享分支体），
		//   按下一个 `case '` 切会把分支体切没（实测断言假红 ✗）。
		const lines = src.split('\n');
		const lineAt = lines.findIndex(l => l.includes("case 'newChat':"));
		// ⚠ 必须切到**下一个不同的 case** 为止：用 "最后一个 return;" 会把后面别的 case
		//   （`openFile` 那段里也有 `_notifications.warn(`）一起切进来 ⇒ 断言命中别处 ⇒ **假绿**（实测踩过 ✗）。
		const endAt = lines.findIndex((l, i) => i > lineAt && l.includes("case 'renameSession':"));
		const branch = lines.slice(lineAt, endAt > lineAt ? endAt : lineAt + 24).join('\n');

		// 插件视图仍走原路径
		assert.match(branch, /startsWith\('dsh-plugin-'\)/,
			'the plugin-view path must stay (dsh-plugin-* views are handled by _handlePluginChatCommand)');

		// 非插件视图：必须留痕 + 提示，不许静默 return
		const iReturn = branch.lastIndexOf('return;');
		assert.ok(iReturn > 0, 'the branch must still return');
		const tail = branch.slice(0, iReturn);
		// ⚠ 必须用**行首**匹配：stripComments 只删"整行都是注释"的行，**行尾注释里的同名调用还在**
		//   ⇒ 不加行首锚点的话，"把调用注释掉"这种突变会**假绿**（实测踩过 ✗）。
		assert.match(tail, /^\s*this\._logService\.info\(/m,
			'the non-plugin-view branch must log (otherwise "nothing happened" is undiagnosable)');
		assert.match(tail, /^\s*this\._notifications\.warn\(/m,
			'the non-plugin-view branch must tell the user what to do instead of silently returning');
	});

	test('2) 页面侧：胶囊菜单的三个入口都必须写 console 诊断', () => {
		const src = read(CAPSULE);

		const hits = src.match(/console\.warn\("\[vssaros-capsule\]/g);
		const count = hits ? hits.length : 0;
		assert.ok(count >= 6,
			`three entries (Agent 主页 / Agent 设置 / 开新会话) must each write a console diagnostic (found ${count})`);
		assert.match(src, /\[vssaros-capsule\] Agent 主页/, 'Agent 主页 must leave a trace');
		assert.match(src, /\[vssaros-capsule\] Agent 设置/, 'Agent 设置 must leave a trace');
		assert.match(src, /\[vssaros-capsule\] 开新会话/, '开新会话 must leave a trace');
	});
});
