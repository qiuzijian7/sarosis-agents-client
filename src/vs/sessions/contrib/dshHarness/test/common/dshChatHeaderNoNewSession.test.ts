/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「聊天框 header 不许再有『＋ 新建会话』」的守卫（2026-10-29）。
 *
 * 用户要求：**移除 dsh 侧聊天框中的「新建会话」按钮。**
 *
 * 背景（`client.sessions.js` 的语义修订史）：那个「＋」是**本页签内**再开一段新对话，
 * 与**顶部**的「＋ 新建会话」（新开页签）语义重叠 ⇒ 用户点错、且两种"新对话"混在一起。
 * ⇒ 入口已删（`newSession` 包装函数一并删掉，桥能力 `bridge.newSession` 保留）。
 *
 * ⚠ 同时钉住 chunk 缓存那条：改 `client.*.js` 之后**必须动一下入口 `lib/client.js`**
 *   （mtime 要比 chunk 新），否则 `?rev` 不变、浏览器继续吃旧 chunk ⇒ 用户看到旧界面。
 *   2026-10-21/10-29 两次"主页/侧栏丢一行"都是这个原因（`check-chat-surface-chunks.mjs` 会查）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshChatHeaderNoNewSession
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SESSIONS_CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.sessions.js';
const CLIENT_ENTRY = 'dsh-plugins/vssaros-chat-surface/lib/client.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('聊天框 header 不再有「新建会话」', () => {

	test('1) 不许再渲染「＋ 新建会话」按钮（两个锚点都清掉）', () => {
		const src = read(SESSIONS_CHUNK);
		assert.ok(!/"data-vssaros-new-session"/.test(src),
			'不许再有 data-vssaros-new-session（那个「＋」是页签内新对话，与顶部＋重复 ⇒ 用户要求移除）');
		assert.ok(!/"data-vssaros-new-chat"/.test(src),
			'不许再有 data-vssaros-new-chat（同一按钮的老标记，一并清掉）');
		// 历史会话入口必须还在（只删了「＋」，不是把整排拆了）
		assert.match(src, /"data-vssaros-history-chip"/, '「🕘 历史会话」入口必须保留');
	});

	test('2) 死代码不许留（newSession 包装函数已删）', () => {
		const src = read(SESSIONS_CHUNK);
		assert.ok(!/const newSession = \(\) =>/.test(src),
			'newSession 的唯一调用点是那个按钮 ⇒ 按钮删了它必须一起删（否则是死代码 ✗）');
	});

	test('3) 入口 client.js 必须比 chunk 新（否则用户吃旧缓存）', () => {
		const entry = fs.statSync(path.join(process.cwd(), CLIENT_ENTRY));
		const chunk = fs.statSync(path.join(process.cwd(), SESSIONS_CHUNK));
		assert.ok(entry.mtimeMs >= chunk.mtimeMs,
			`入口 lib/client.js 的 mtime 比改过的 chunk 旧 ⇒ ?rev 不变 ⇒ 浏览器吃旧 chunk ⇒ `
			+ `用户看到旧界面（2026-10-21/10-29 两次"主页/侧栏丢一行"都是这个原因 ✗）`
			+ ` —— 改完 chunk 后请动一下 CLIENT_BUILD_STAMP 那行注释`);
	});
});
