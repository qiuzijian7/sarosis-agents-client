/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「每次启动前都要体检 profile 依赖树」的守卫（2026-10-29）。
 *
 * 真机（装了最新版本起不来，桌面窗口报「控制桥不可用（未安装伴生插件或 Host 未运行）」）：
 *
 *     dsh: startup failed: 3 required plugins did not activate
 *     Failed plugins (5):
 *         failed to import: Error: Cannot find module './accept'     ← ×4（negotiator 嵌套副本缺 lib/accept.js）
 *         failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…@vssaros/dsh-kb/vendor/markdown-it.cjs'
 *
 * ⇒ profile 的依赖树是**半装**的（升级安装失败 ⇒ `node_modules` 被删了却没装回）。
 * ⇒ 而 `repairProfileDeps`（专门补嵌套副本的缺文件）原来只在「**装完插件之后**」跑
 *   （在 `if (wants.length)` 块内）⇒ 恰好在"版本对、入口内容对 ⇒ 判定不装"的那种启动里**永远不修** ✗✗。
 * ⇒ 提到**每次启动前**（spawn dsh 之前）跑一次 ⇒ 半装 profile 也能自愈 ✓。
 *
 * ⚠ 顺序是硬要求：插件 import 发生在 dsh 启动时 ⇒ 自愈必须在 spawn **之前**（否则修得太晚）✗。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshProfileDepsRepairOnStart
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('每次启动前都要体检 profile 依赖树', () => {

	test('1) 启动前必须调 repairProfileDeps，且在 spawn 之前', () => {
		const src = stripComments(read(SUPERVISOR));

		const at = src.indexOf('const args = buildHostArgs(');
		assert.ok(at > 0, '找不到 spawn 之前的那行（buildHostArgs）');

		// ⚠ 从 buildHostArgs 之后开始找（前面还有"装完插件后"那一处调用，不能被它顶掉）
		const iRepair = src.indexOf('repairProfileDeps(', at);
		const iSpawn = src.indexOf('spawn(node.path, args', at);
		assert.ok(iRepair > at, '启动前必须调 repairProfileDeps（半装 profile 才是起不来的真因）');
		assert.ok(iSpawn > at, '找不到 spawn dsh 那行');
		assert.ok(iRepair < iSpawn,
			'自愈必须在 spawn dsh **之前**（插件 import 发生在 dsh 启动时 ⇒ 修得太晚就没用 ✗）');
	});

	test('2) 自愈失败不许阻断启动', () => {
		const src = stripComments(read(SUPERVISOR));
		const at = src.indexOf('const args = buildHostArgs(');
		const iRepair = src.indexOf('repairProfileDeps(', at);
		assert.ok(iRepair > 0, '找不到启动前的自愈调用');
		const seg = src.slice(iRepair, iRepair + 900);
		assert.match(seg, /catch \(error\)/, '自愈失败必须被 catch（否则一次读盘失败就起不来 ✗）');
	});
});
