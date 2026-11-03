/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「vssaros-media 挂两次不许炸」守卫（2026-11-03）。
 *
 * 真机（F5 后横幅）：`会话启动失败（第 1/3 次）：vssaros-media (@vssaros/dsh-media):
 * service "vssarosMediaStore" has been registered at <vssaros-media>`
 * Host 日志：`[vssaros-media] apply 抛错（插件因此没挂载）：… has been registered …`
 *
 * 根因：本包被挂**两次** —— host 行（`cordis.patch.yml`）与 preset 行（`preset-vssaros.rows.yml`）。
 * 第二次 `ctx.provide('vssarosMediaStore')` 让 cordis 抛 ⇒ **整个 preset 无效**（`agent-preset/invalid`）⇒
 *   ① 会话起不来；② **preset 内所有工具一起缺失**（含基座的 `pwsh` / `read`
 *   ⇒ 之前查的 `unknown tool "pwsh"` / `"read"` 就是这个的下游症状）。
 * 页面路由同理（第二次注册同一 prefix ⇒ `duplicate prefix route "/x/media"`，dashboard / mcp 踩过）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshMediaServiceIdempotent
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const MEDIA = 'dsh-plugins/vssaros-media/lib/index.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 只去整行 `//` 注释（注释里会解释坑，别被它骗过去） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('vssaros-media 双挂载幂等', () => {

	test('1) provide 前必须检查已存在（否则第二次挂载抛 ⇒ 整个 preset 失效）', () => {
		const src = code(MEDIA);
		const iGet = src.indexOf("ctx.get?.('vssarosMediaStore')");
		const iProvide = src.indexOf("ctx.provide('vssarosMediaStore'");
		assert.ok(iGet > 0, '必须先 `ctx.get?.(\'vssarosMediaStore\')` 探一下');
		assert.ok(iProvide > iGet, 'provide 必须在检查之后');
		// 必须在"不存在"分支里 provide
		const between = src.slice(iGet, iProvide);
		assert.strictEqual((between.match(/ctx\.provide\(/g) ?? []).length, 0, 'provide 不许出现在检查之前');
		assert.match(src, /if \(mediaStoreExisting\) \{[\s\S]{0,400}\} else \{[\s\S]{0,260}ctx\.provide\('vssarosMediaStore'/,
			'provide 必须挂在 `else`（= 本层是第一次挂载）分支里');
	});

	test('2) 页面路由也必须幂等（第二次注册同一 prefix ⇒ duplicate prefix route）', () => {
		const src = code(MEDIA);
		const i = src.indexOf("ctx.inject(['webServer', 'connection']");
		assert.ok(i > 0, '找不到路由注册');
		// ⚠ 窗口只能取**紧邻**的一段：取几百字符会连上一个无关的 `if (mediaStoreExisting)` 一起匹配，
		//   那样"把保护删掉、路由无条件调用"的突变会被骗成假绿（第一版就是这么写的）。
		const before = src.slice(Math.max(0, i - 120), i);
		assert.ok(before.includes('mediaStoreExisting'),
			'路由注册必须紧跟在 `if (mediaStoreExisting)` 的保护之下（已由另一层注册过就不再注册）');
	});
});
