/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「随包插件必须登记进 `dsh.profile.bundles`」的守卫（2026-10-30，外部机器 P0）。
 *
 * 真机：窗口开了，但界面是 **dsh 原生的英文界面**（没有侧栏「主页」、没有我们的页面），
 * 主进程日志 `bridge handshake did not complete; using URL-line fallback`、`Host 输出异常少（1 行）`。
 *
 * 现场 profile/package.json：`dependencies` 里 35 个 `@vssaros/*` 全在、`node_modules` 里文件也全在，
 * 但 `dsh.profile.bundles` **只有 3 项**（`dsh-base` / `dsh-web-app` / voice-input）。
 *
 * ⇒ dsh **只组合 `bundles` 里列出的包**：不在列表里的一律不加载 ⇒ 没有 `vssaros-bridge`
 *   ⇒ 控制桥握手失败；没有 chat-surface / brand ⇒ 界面退回原生形态 ✗✗。
 *
 * 为什么会缺：真正会追加 bundles 的只有 `dsh plugin add`（pnpm 那条路）——
 *   · 「直装」只写 `dependencies`；
 *   · 插件**早已装好**时 `wants` 为空 ⇒ 连装都不跑 ⇒ bundles 永远停在模板那 3 项。
 *
 * 修法：启动前**无条件**调用 `_ensureProfileBundles()`：以随包种子（构建期校验过的权威清单）为准，
 *   只追加缺失项（不删、不重排 ⇒ 幂等，也不覆盖用户手工停用）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshProfileBundlesSync
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { mergeMissingBundles, parseProfileBundles } from '../../common/dshPluginActivation.js';

const SUP = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

const THEIRS = {
	name: 'dsh-profile-vssaros',
	dependencies: { '@vssaros/dsh-bridge': 'file:...', '@vssaros/dsh-chat-surface': 'file:...' },
	dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle'] } },
};

suite('随包插件必须登记进 dsh.profile.bundles', () => {

	test('1) 对方机器那种状态（装了但没登记）⇒ 必须把缺的补上，且保留原有顺序', () => {
		const desired = [
			'@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
			'@vssaros/dsh-foundation', '@vssaros/dsh-bridge', '@vssaros/dsh-chat-surface',
		];
		const merged = mergeMissingBundles(THEIRS, desired);
		assert.strictEqual(merged.changed, true, '必须判定"有变化"（否则不会写盘）');
		assert.deepStrictEqual([...merged.added], ['@vssaros/dsh-foundation', '@vssaros/dsh-bridge', '@vssaros/dsh-chat-surface'],
			'只追加缺的，已登记的不重复追加');
		assert.deepStrictEqual([...merged.next], [
			'@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle',
			'@vssaros/dsh-foundation', '@vssaros/dsh-bridge', '@vssaros/dsh-chat-surface',
		], '原有顺序必须保持不变，新项追加在末尾（与 `dsh plugin add` 一致）');
	});

	test('2) 幂等：全都在 ⇒ changed=false（每次启动都跑，不能每次写盘）', () => {
		const full = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@vssaros/dsh-bridge'] } } };
		const merged = mergeMissingBundles(full, ['@deepseek-ai/dsh-base', '@vssaros/dsh-bridge']);
		assert.strictEqual(merged.changed, false);
		assert.deepStrictEqual([...merged.added], []);
		assert.deepStrictEqual([...merged.next], ['@deepseek-ai/dsh-base', '@vssaros/dsh-bridge']);
	});

	test('3) 只追加、不删除：用户手工停用的项不许被动回来（除非它在随包里）', () => {
		const pkg = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
		const merged = mergeMissingBundles(pkg, ['@deepseek-ai/dsh-base', '@vssaros/dsh-bridge']);
		assert.ok(!merged.next.includes('@vssaros/dsh-kb'), '不在 desired 里的一律不加');
		// 反向：已经在列表里的（哪怕是用户自己加的）绝不被移除
		const pkg2 = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@tt-a1i/archify-dsh'] } } };
		const m2 = mergeMissingBundles(pkg2, ['@deepseek-ai/dsh-base']);
		assert.strictEqual(m2.changed, false);
		assert.deepStrictEqual([...m2.next], ['@deepseek-ai/dsh-base', '@tt-a1i/archify-dsh'], '既有项不许被删');
	});

	test('4) 空串 / 重复 / 非字符串一律忽略（种子或清单脏了也不许写出坏列表）', () => {
		const merged = mergeMissingBundles({}, ['@a', '  ', '@a', '', '@b'] as string[]);
		assert.deepStrictEqual([...merged.next], ['@a', '@b']);
		assert.deepStrictEqual([...merged.added], ['@a', '@b']);
		// profile 里原本没有 dsh 字段也要能读出空列表（不抛）
		assert.deepStrictEqual(parseProfileBundles({}), []);
	});

	test('6) 诊断日志：每次启动都打 bundles 统计；bridge fallback 时必须给归因', () => {
		const src = read(SUP).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
		// ① 统计行必须在 `if (!merged.changed) return;` **之前**（不然"本来就全"的情况永远没日志）
		const iStat = src.indexOf('profile bundles: 现有 ${current.length} 项');
		const iEarlyReturn = src.indexOf('if (!merged.changed) {', iStat);
		assert.ok(iStat > 0, '必须有"现有/随包/本次补"这条统计日志');
		assert.ok(iEarlyReturn > iStat, '统计日志必须在 `if (!merged.changed)` 之前（诊断"bundles 本来就全"时同样需要它）');
		// ② fallback 归因三分支：没登记 / 刚补登记 / bundles 正常
		const iFallback = src.indexOf('if (!connection.hello) {');
		const iReady = src.indexOf('ready in ${Date.now() - t0} ms at ${connection.origin}');
		assert.ok(iFallback > iReady, '归因日志必须紧跟 `ready in …`（fallback 分支里）');
		const seg = src.slice(iFallback, iFallback + 2600);
		assert.match(seg, /dsh\.profile\.bundles 里没有 \$\{DSH_BRIDGE_PLUGIN_NAME\}/, '必须能指出"bundles 没登记桥插件"');
		assert.match(seg, /本次刚补登记了 \$\{stats\.added\} 个插件/, '必须能指出"刚补登记、需再启动一次"');
		assert.match(seg, /bundles 正常.*已含 \$\{DSH_BRIDGE_PLUGIN_NAME\}/s, '必须能指出"bundles 正常 ⇒ 问题在 Host 内部"');
	});

	test('5) 接线：spawn 之前必须无条件调用 `_ensureProfileBundles`（不许只在"本次装了插件"时调用）', () => {
		// ⚠ 这里只去"整行注释"：这份文件里有字符串含 `/*`，用块注释正则会吞掉一大段（上一版就因此找不到调用）
		const src = read(SUP).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
		const iCall = src.indexOf('await this._ensureProfileBundles(profile, dsh, env, plugins, pluginProfileDir);');
		assert.ok(iCall > 0, '找不到 `_ensureProfileBundles` 的调用');
		const iSpawnReady = src.indexOf("this._progress('正在启动 Host…')", iCall);
		assert.ok(iSpawnReady > iCall, '必须在「正在启动 Host…」之前调用（否则新起的 Host 不会加载我们的插件）');
		// ⚠ 关键：不能挂在 `if (wants.length)` 里面 —— 插件早已装好时 wants 为空，那正是出问题的场景
		const iWantsBlock = src.lastIndexOf('if (wants.length) {', iCall);
		const iWantsBlockEnd = iWantsBlock >= 0 ? src.indexOf('\n\t\t\t}', iWantsBlock) : -1;
		assert.ok(!(iWantsBlock >= 0 && iCall > iWantsBlock && iCall < iWantsBlockEnd),
			'`_ensureProfileBundles` 不许放在 `if (wants.length)` 块内 —— 插件"已装"时 wants 为空，恰恰是 bundles 缺失的现场 ✗');
		// 必须以随包种子为权威，并在种子不可用时退回"确实装着的随包插件"
		assert.match(src, /_profileSeedDir\(profile, dsh\)/, '必须以随包种子为权威清单');
		assert.match(src, /existsSync\(join\(pluginProfileDir, 'node_modules'/, '种子不可用时必须按"真的装着"过滤（否则会把没随包的 dsh-schedule-bundle 加进去）');
	});
});
