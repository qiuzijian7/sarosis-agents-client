/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「vssaros-skills 的工具探测不许再拖慢 Host 启动」守卫（2026-11-02）。
 *
 * 背景（`node --cpu-prof` 实测，30 个 agent 的真实配置）：
 *   原实现每次 `tools/change` **同步**跑 `sync()`，里面调 **3 次** `tools.schemas()`；
 *   `schemas()` 对每个工具深拷贝 parameters ⇒ Host 启动期 CPU 有 **3.6s** 花在这里，
 *   bridge apply 被推到 **8.5s**。改成 `view().visible` 取名 + 一轮一次快照 + 800ms 去抖后：
 *   skills 探测 ≈ 0ms，bridge apply **4.4–4.7s**；技能页诊断栏新旧逐字一致。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshSkillsToolProbeCost
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SKILLS = 'dsh-plugins/vssaros-skills/lib/index.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 只去整行 `//` 注释（注释里会提到旧写法，别被它骗过去） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

/** `ctx.inject(['tools'], tools => { … })` 这一段（到技能检索工具注册为止） */
function probeBlock(): string {
	const src = code(SKILLS);
	const at = src.indexOf("ctx.inject(['tools'], tools => {");
	assert.ok(at > 0, '找不到 skills 的 tools 注入段');
	const end = src.indexOf('const definitions = [{', at);
	assert.ok(end > at, '找不到技能检索工具定义（段落边界变了？）');
	return src.slice(at, end);
}

suite('vssaros-skills 工具探测的启动成本', () => {

	test('1) 取名优先走 view().visible（不深拷贝），schemas() 只作回落且全段只出现一次', () => {
		const block = probeBlock();
		assert.match(block, /tools\.tools\.view\?\.\(\)\?\.visible/,
			'必须先走 `view().visible`：dsh-tools 的 schemas() 就是 view().visible 再逐个深拷贝 ⇒ 名字集合一致但贵得多');
		const schemaCalls = (block.match(/tools\.tools\.schemas\?\.\(\)/g) ?? []).length;
		assert.strictEqual(schemaCalls, 1,
			'`schemas()` 只许作为回落出现一次（原来一轮 sync 调 3 次 ⇒ 启动期 3.6s CPU）；实际 ' + schemaCalls + ' 次');
	});

	test('2) 一轮 sync 只取一次快照，三项诊断共用', () => {
		const block = probeBlock();
		const at = block.indexOf('const sync = () => {');
		assert.ok(at > 0, '找不到 sync');
		const body = block.slice(at, block.indexOf('};', at));
		assert.strictEqual((body.match(/visibleToolsOf\(\)/g) ?? []).length, 1, 'sync 里只许取一次快照');
		assert.match(body, /state\.mcpTools = mcpToolsOf\(list\);/, 'mcpTools 必须复用同一份快照（不许自己再取一次）');
	});

	test('3) tools/change 必须去抖；卸载时先停定时器', () => {
		const block = probeBlock();
		assert.match(block, /tools\.on\('tools\/change', scheduleSync\);/,
			'`tools/change` 必须挂去抖版（启动期事件成簇到达，同步重算会占满事件循环）');
		assert.ok(!/tools\.on\('tools\/change', sync\)/.test(block), '不许再直接挂 sync');
		assert.match(block, /setTimeout\(\(\) => \{ syncTimer = undefined; sync\(\); \}, SKILL_TOOL_PROBE_DEBOUNCE_MS\)/,
			'去抖必须真的延后执行');
		const src = code(SKILLS);
		assert.match(src, /const SKILL_TOOL_PROBE_DEBOUNCE_MS = 800;/, '去抖窗口与 vssaros-agents 同值（800ms）');
		// 卸载：先 disposed + clearTimeout，再清状态（否则定时器触发会把状态写回去）
		const iDisposed = src.indexOf('disposed = true;');
		const iClear = src.indexOf('clearTimeout(syncTimer)', iDisposed);
		const iReset = src.indexOf('state.nativeSkillToolPresent = false;', iDisposed);
		assert.ok(iDisposed > 0 && iClear > iDisposed && iReset > iClear,
			'卸载时必须先 `disposed = true` + `clearTimeout(syncTimer)`，再清 state');
	});
});
