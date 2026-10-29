/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「chunk 装载失败必须说出来」的守卫（2026-10-29）。
 *
 * 真机（v2.2.26212 桌面窗口：侧栏「🏠 主页」那一行消失）**排查时最痛的一点**：
 * 日志里**一条线索都没有** —— 既没有注册失败的 warn，也没有 chunk 加载失败的 error。
 *
 * 根因：`client.js` 三处 chunk 装载的 `.catch` **只写 `state.partErrors`**（页面内部字段）：
 *
 *     .catch((e) => {
 *         state.partErrors = Object.assign({}, state.partErrors, { [file]: String((e && e.message) || e) });
 *         return null;                       // ← 静默：不 console、也不进宿主自证
 *     })
 *
 * ⇒ 任何一个部件装载失败（`client.workbenchNav.js` 就在这条路上）⇒ **悄悄不装、日志干干净净** ✗✗
 * ⇒ 排查只能靠"排除法"猜。
 *
 * 修法：三处 catch 里都 `console.error("[vssaros] chunk 装载失败：…")`
 * ⇒ 宿主会把 `page console(error)` 镜像进 `main.log` ⇒ 下次一眼能看到是哪个文件、什么原因 ✓。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshChunkLoadVisible
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = 'dsh-plugins/vssaros-chat-surface/lib/client.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 去掉行注释与块注释（断言不能命中注释里的文字 —— 这个坑踩过多次）。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('chunk 装载失败必须说出来', () => {

	test('1) 三处 chunk 装载的 catch 都必须 console.error（不许只写 state 就吞掉）', () => {
		const src = stripComments(read(CLIENT));

		// 这三处都要报出来
		const spots = [
			{ key: '加载单个 chunk（loadParts）', re: /console\.error\("\[vssaros\] chunk 装载失败：" \+ file/ },
			{ key: 'always-parts', re: /console\.error\("\[vssaros\] chunk 装载失败（always-parts）："/ },
			{ key: 'full-surface-parts', re: /console\.error\("\[vssaros\] chunk 装载失败（full-surface-parts）："/ },
		];
		for (const s of spots) {
			assert.match(src, s.re, `「${s.key}」失败时必须在页面 console 里报出来（否则宿主日志里零线索 ✗）`);
		}

		// 每个 catch 里必须"先写 state 再 console"（顺序不重要，但两者都要在）
		const catchCount = (src.match(/state\.partErrors = Object\.assign/g) || []).length;
		assert.ok(catchCount >= 3, `应当有 3 处写 partErrors（实际 ${catchCount}）`);
	});

	test('2) 报错要带上**是哪个 chunk**（只说"失败了"等于没说）', () => {
		const src = stripComments(read(CLIENT));
		// loadParts 那处必须拼上文件名
		assert.match(src, /"\[vssaros\] chunk 装载失败：" \+ file \+ " — " \+ msg/,
			'必须点出失败的是哪个 chunk 文件（`file`），否则还是查不出是哪个部件 ✗');
	});

	test('3) 不许因此把聊天本身搞挂（catch 必须返回 null 兜住）', () => {
		const src = stripComments(read(CLIENT));
		const at = src.indexOf('const loadParts = (files)');
		assert.ok(at > 0, '找不到 loadParts');
		const seg = src.slice(at, at + 1200);
		assert.match(seg, /return null;/, 'loadParts 的 catch 必须 return null（一个 chunk 挂了不许带走其它部件）');
	});
});
