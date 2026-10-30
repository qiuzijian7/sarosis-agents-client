/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 源码守卫：插件侧栏的**原生形态**（`view.kind = 'native'`）契约。
 *
 * ★ 2026-10-30（用户要求：「IDE 侧的 activitybar 中，插件的 sideview 要求改用 vscode 原生的 UI 和功能」）
 *
 * 钉住三件事（任何一条破了都是"清单说一套、界面是另一套"）：
 * ① 清单解析：`native` 必须带 `viewType`，`data.route` 必须是站内干净路径，动作 id 不许重复 /
 *    不许未知字段（写错名字 ⇒ 报错，而不是静默变成"空面板"）；
 * ② 宿主编排：`dshActivityBarContribution` 必须**按 `view.kind` 分派**，且 `native` 不能落到
 *    `DshPluginViewPane`（那正是本次要消灭的"侧栏里嵌网页"）；
 * ③ 样板对账：`vssaros-agents` 清单确实是 `native`，且它的 `data.route` 与 IDE 侧数据源表
 *    **指向同一个接口**（两处各写一份路由 ⇒ 迟早对不上；本仓已为同类漂移付过代价）。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { parseVssarosManifest } from '../../common/vssarosPluginManifest.js';

const REL_ACTIVITY_BAR = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshActivityBarContribution.ts';
const REL_NATIVE_PANE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshNativeTreeViewPane.ts';
const REL_AGENTS_MANIFEST = 'dsh-plugins/vssaros-agents/package.json';

function readFromRepoRoot(rel: string): string | undefined {
	// runner 约定从仓库根执行（见 run-dshharness-tests.mjs）。
	const abs = path.join(process.cwd(), rel);
	return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
}

/** 一份最小的合法内置插件清单外壳，只换 `view` 字段。 */
function manifestWith(view: unknown, builtin = true) {
	return parseVssarosManifest({
		manifestVersion: 1,
		module: 'demo',
		activityBar: { containerId: builtin ? 'agentStudio.demo' : 'demo-plugin.x', title: 'Demo', icon: 'codicon:robot', order: 300 },
		view,
	}, { pluginName: builtin ? '@vssaros/dsh-demo' : 'demo-plugin', builtin });
}

suite('dshNativeView 契约（kind=native 的解析与编排）', () => {

	// ── ① 清单解析 ──────────────────────────────────────────────────────────

	test('native：带完整 data / actions 时原样解析出来', function () {
		const manifest = manifestWith({
			kind: 'native',
			viewType: 'vssaros.agents.roster',
			data: { route: '/x/agents/api/agents' },
			actions: [{ id: 'refresh', title: '刷新', icon: 'codicon:refresh' }],
		});
		const view = manifest.view;
		assert.strictEqual(view.kind, 'native');
		if (view.kind !== 'native') {
			return; // 让 TS 收窄
		}
		assert.strictEqual(view.viewType, 'vssaros.agents.roster');
		assert.strictEqual(view.data?.route, '/x/agents/api/agents');
		assert.strictEqual(view.actions?.length, 1);
		assert.strictEqual(view.actions?.[0].id, 'refresh');
	});

	test('native：data / actions 都是可选的（不吃 HTTP 的视图不用编一个路由出来）', function () {
		const manifest = manifestWith({ kind: 'native', viewType: 'vssaros.demo.plain' });
		assert.strictEqual(manifest.view.kind, 'native');
		if (manifest.view.kind === 'native') {
			assert.strictEqual(manifest.view.data, undefined);
			assert.strictEqual(manifest.view.actions, undefined);
		}
	});

	test('native：data.route 必须是站内干净路径（查询串 / 片段 / .. 一律拒）', function () {
		for (const bad of ['', 'agents/api', 'http://evil/x', '/x/agents/api?evil=1', '/x/agents/api#frag', '/x/../etc']) {
			assert.throws(
				() => manifestWith({ kind: 'native', viewType: 'vssaros.demo.plain', data: { route: bad } }),
				/route/,
				`data.route 应拒绝：${bad}`,
			);
		}
	});

	test('native：未知字段报错（写错名字 ≠ 没写，不静默吞）', function () {
		assert.throws(
			() => manifestWith({ kind: 'native', viewType: 'vssaros.demo.plain', dataRoute: '/x/demo/' }),
			/不认识的字段/,
		);
		assert.throws(
			() => manifestWith({ kind: 'native', viewType: 'vssaros.demo.plain', data: { route: '/x/demo/', method: 'POST' } }),
			/不认识的字段/,
		);
	});

	test('native：actions 的 id 必须合法且不可重复（重复 = IDE 按 id 分派二义）', function () {
		const withActions = (actions: unknown) => manifestWith({ kind: 'native', viewType: 'vssaros.demo.plain', actions });
		assert.throws(() => withActions([{ id: 'Refresh', title: 'x' }]), /id/, '大写开头不合法');
		assert.throws(() => withActions([{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }]), /重复/, '重复 id 必须拒');
		assert.throws(() => withActions(new Array(9).fill(0).map((_, i) => ({ id: `a${i}`, title: 'x' }))), /最多 8/, '超过 8 项必须拒');
	});

	test('kind=none 不能再带 native 的界面字段（自相矛盾早点报）', function () {
		assert.throws(() => manifestWith({ kind: 'none', data: { route: '/x/demo/' } }), /不能再带 data/);
		assert.throws(() => manifestWith({ kind: 'none', actions: [] }), /不能再带 actions/);
	});

	// ── ② 宿主编排（源码守卫）────────────────────────────────────────────────

	test('宿主编排按 view.kind 分派：native 优先，且降级时**记日志**而不是静默', function () {
		const src = readFromRepoRoot(REL_ACTIVITY_BAR);
		if (!src) {
			this.skip();
		}
		assert.ok(src, '源文件必须可读');
		// native 分支必须真的存在并参与宿主选择。
		assert.match(src, /view\?\.kind === 'native'/, '缺少 native 分派：清单写 native 也照样会挂插件页宿主');
		assert.match(src, /nativeViewHostOf\(/, '缺少原生宿主解析函数');
		// 注册表里认不出的形态必须降级并 warn（"改完清单没变化"最难查）。
		assert.match(src, /log\.warn\([^)]*原生宿主/, '注册表未命中时必须 warn，不能静默');
		// ⚠ 若将来有人把 native 改回插件页宿主，这条会当场抓住。
		// 判据刻意收窄到**函数体**：`nativeViewHostOf` 命中注册表后必须返回原生宿主描述符，
		// 而不是 `DshPluginViewPane`。降级路径（`?? moduleViewHostOf(...)`）是调用方的事，
		// 不在这里断言 —— 否则"降级"和"回落"会被混为一谈（第一版正则就踩了这个）。
		const fnStart = src.indexOf('function nativeViewHostOf');
		assert.ok(fnStart >= 0, '找不到 nativeViewHostOf');
		const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
		assert.match(fnBody, /new SyncDescriptor\(DshNativeTreeViewPane/, '命中注册表时必须挂原生宿主');
		assert.doesNotMatch(fnBody, /DshPluginViewPane/, 'native 分支**不得**回落到插件页宿主');
	});

	test('原生宿主用 VS Code 自己的树，而不是 WebContentsView', function () {
		const src = readFromRepoRoot(REL_NATIVE_PANE);
		if (!src) {
			this.skip();
		}
		assert.ok(src, '源文件必须可读');
		assert.match(src, /extends ViewPane/, '原生侧栏必须是 ViewPane（拿得到原生标题栏 / 工具栏 / 主题）');
		assert.match(src, /WorkbenchObjectTree/, '列表必须是框架自带的树（键盘导航 / 无障碍 / 样式）');
		assert.doesNotMatch(src, /createView\(/, '原生宿主**不得**再开 WebContentsView —— 那正是本次要消灭的东西');
		assert.doesNotMatch(src, /webview|iframe/i, '原生宿主不得内嵌网页');
	});

	// ── ③ 样板对账 ──────────────────────────────────────────────────────────

	test('agents 清单已切成 native，且 data.route 与 IDE 侧数据源指向同一接口', function () {
		const raw = readFromRepoRoot(REL_AGENTS_MANIFEST);
		const paneSrc = readFromRepoRoot(REL_NATIVE_PANE);
		if (!raw || !paneSrc) {
			this.skip();
		}
		assert.ok(raw && paneSrc, '两个源文件都必须可读');
		const pkg = JSON.parse(raw) as { vssaros: { view: { kind: string; viewType?: string; data?: { route?: string } } } };
		assert.strictEqual(pkg.vssaros.view.kind, 'native', 'agents 侧栏应已改用原生形态');
		assert.strictEqual(pkg.vssaros.view.viewType, 'vssaros.agents.roster');

		const manifestRoute = pkg.vssaros.view.data?.route;
		assert.ok(manifestRoute, 'agents 清单必须声明 data.route');
		// IDE 侧解码器表也必须用同一个路由：两处各写一份 ⇒ 迟早对不上。
		assert.ok(
			paneSrc.includes(`'${manifestRoute}'`),
			`dshNativeTreeViewPane 的 NATIVE_DATA_SOURCES 里没有 ${manifestRoute}：清单与 IDE 数据源已漂移`,
		);
		// 编辑区完整页仍是插件页 ⇒ 插件必须继续提供它（否则点开条目什么都没有）。
		assert.ok(fs.existsSync(path.join(process.cwd(), 'dsh-plugins/vssaros-agents/lib/detail.js')),
			'编辑区完整页仍由插件自托管（lib/detail.js），迁移侧栏不能把它删掉');
	});
});
