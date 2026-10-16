/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	VSSAROS_THIRD_PARTY_ORDER_MAX, containerPrefixOf, isRelativeIconPath, parseVssarosManifest, tryParseVssarosManifest,
} from '../../common/vssarosPluginManifest.js';

const builtinManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	manifestVersion: 1,
	module: 'kanban',
	activityBar: { containerId: 'agentStudio.tasks', title: 'Tasks', icon: 'codicon:checklist', order: 70 },
	view: { kind: 'page', route: '/x/vssaros-kanban/' },
	...overrides,
});

suite('vssarosPluginManifest（清单 schema 与命名空间规则）', () => {

	test('内置模块：沿用既有容器 ID 与 order', () => {
		const m = parseVssarosManifest(builtinManifest(), { pluginName: '@vssaros/dsh-kanban', builtin: true });
		assert.strictEqual(m.manifestVersion, 1);
		assert.strictEqual(m.module, 'kanban');
		assert.strictEqual(m.activityBar?.containerId, 'agentStudio.tasks');
		assert.strictEqual(m.activityBar?.order, 70);
		assert.deepStrictEqual(m.view, { kind: 'page', route: '/x/vssaros-kanban/' });
	});

	test('内置模块可以使用 vssaros.* 命名空间（vssaros.dsh.codebase）', () => {
		const m = parseVssarosManifest(builtinManifest({
			module: 'codebase',
			activityBar: { containerId: 'vssaros.dsh.codebase', title: { zh: '代码图谱', en: 'Codebase Graph' }, icon: 'codicon:type-hierarchy', order: 25 },
			view: undefined,
		}), { pluginName: '@vssaros/dsh-codebase', builtin: true });
		assert.strictEqual(m.activityBar?.containerId, 'vssaros.dsh.codebase');
		// 决议③：view 缺省 → page + 由 module 推导路由
		assert.deepStrictEqual(m.view, { kind: 'page', route: '/x/codebase/' });
	});

	test('第三方：容器 ID 必须以插件名为前缀，order 落在 200–899', () => {
		const ok = parseVssarosManifest(builtinManifest({
			module: undefined,
			activityBar: { containerId: 'dsh-graph-viewer.panel', title: 'Graph', icon: 'icon.svg', order: 300 },
			view: { kind: 'page', route: '/x/graph/' },
		}), { pluginName: '@acme/dsh-graph-viewer' });
		assert.strictEqual(ok.activityBar?.containerId, 'dsh-graph-viewer.panel');

		assert.throws(() => parseVssarosManifest(builtinManifest({
			activityBar: { containerId: 'acme.viewer', title: 'Graph', icon: 'icon.svg', order: 300 },
		}), { pluginName: '@acme/dsh-graph-viewer' }), /必须以插件名为前缀/);

		assert.throws(() => parseVssarosManifest(builtinManifest({
			activityBar: { containerId: 'dsh-graph-viewer.panel', title: 'Graph', icon: 'icon.svg', order: 10 },
		}), { pluginName: '@acme/dsh-graph-viewer' }), /order 必须落在/);
	});

	test('第三方不得占用 vssaros.* 命名空间（决议②）', () => {
		assert.throws(() => parseVssarosManifest(builtinManifest({
			activityBar: { containerId: 'vssaros.sneaky', title: 'X', icon: 'codicon:x', order: 300 },
		}), { pluginName: '@acme/dsh-sneaky' }), /常驻命名空间/);
		assert.strictEqual(VSSAROS_THIRD_PARTY_ORDER_MAX, 899);
	});

	test('manifestVersion 必须为 1；module 格式受约束', () => {
		assert.throws(() => parseVssarosManifest(builtinManifest({ manifestVersion: 2 }), { builtin: true }), /manifestVersion/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'Kanban' }), { builtin: true }), /module 格式/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'x'.repeat(40) }), { builtin: true }), /module 格式/);
	});

	test('view：默认 page（需 module 才能推导）；非法 route / kind 报错', () => {
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: undefined, view: undefined }), { builtin: true }), /必须有 vssaros.module/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ view: { kind: 'page', route: '/x/../etc/' } }), { builtin: true }), /route/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ view: { kind: 'page', route: 'x/no-slash' } }), { builtin: true }), /route/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ view: { kind: 'iframe' } }), { builtin: true }), /kind 必须是 page \/ native \/ section \/ none/);
		const native = parseVssarosManifest(builtinManifest({ view: { kind: 'native', viewType: 'agentStudio.tasksView' } }), { builtin: true });
		assert.deepStrictEqual(native.view, { kind: 'native', viewType: 'agentStudio.tasksView' });
	});

	test('view.none：无图标模块（只有工具、没有界面）显式声明，且不许再带界面字段', () => {
		// `ide` / `channels` 的现状：在 DSH_BUILTIN_MODULES 里但不在容器表里（README 4.53）
		const none = parseVssarosManifest(builtinManifest({ module: 'ide', view: { kind: 'none' }, legacyCounterpart: undefined }), { builtin: true });
		assert.deepStrictEqual(none.view, { kind: 'none' });

		// 写混了就是自相矛盾：none 不许带 route / host / viewType
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'ide', view: { kind: 'none', route: '/x/ide/' } }), { builtin: true }), /kind=none 表示不提供界面，不能再带 route/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'ide', view: { kind: 'none', host: 'kb' } }), { builtin: true }), /不能再带 host/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'ide', view: { kind: 'none', viewType: 'x.y' } }), { builtin: true }), /不能再带 viewType/);
	});

	test('ideCapabilities：工具族名字（browser / canvas / mindmap）可声明；拼错的仍然fail-closed', () => {
		// 13.3 那条"mindmap / unreal 没有位置"的落点：**扩名字不折叠**（折叠 = 粒度变粗，
		// 声明 canvas 的插件会顺带拿到 mindmap 工具，"逐项授权"退化成"整族放行"）。
		// ⚠ 2026-10-13：`unreal` **已从白名单删除**（该族改由 dsh 侧 `dsh-plugins/vssaros-unreal` 直连
		//   bridge，不再经 IDE 反向通道）⇒ 从这条名单里去掉，并**反过来**断言它现在是 fail-closed 的 ✓：
		//   退役的名字与拼错的名字在解析器眼里是同一件事（都不在白名单里）⇒ 都必须明确报错、不许静默忽略 ✓。
		const families = ['browser', 'canvas', 'mindmap'];
		const parsed = parseVssarosManifest(builtinManifest({ module: 'ide', view: { kind: 'none' }, legacyCounterpart: undefined, ideCapabilities: families }), { builtin: true });
		assert.deepStrictEqual([...(parsed.ideCapabilities ?? [])], families);

		assert.throws(
			() => parseVssarosManifest(builtinManifest({ ideCapabilities: ['mindMap'] }), { builtin: true }),
			/未支持的能力名：mindMap（可用：.*mindmap.*）/,	// 大小写错了就是错（不静默纠偏）
		);
		assert.throws(
			() => parseVssarosManifest(builtinManifest({ ideCapabilities: ['unreal'] }), { builtin: true }),
			/未支持的能力名：unreal/,	// 退役 != 仍可声明：老插件声明它会**明确失败**（而不是悄悄放过 ✓）
		);
	});

	test('view.section：聚合模块寄居同容器宿主的页面（决议①），host 不能是自己、route 必须合法', () => {
		// 记忆寄居资料库页的现状：这是唯一需要 section 的形态（它不占自己的容器/页面）
		const section = parseVssarosManifest(builtinManifest({ module: 'memory', view: { kind: 'section', host: 'kb', route: '/x/memory/section' } }), { builtin: true });
		assert.deepStrictEqual(section.view, { kind: 'section', host: 'kb', route: '/x/memory/section' });

		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'memory', view: { kind: 'section', route: '/x/memory/section' } }), { builtin: true }), /host 缺失/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'memory', view: { kind: 'section', host: 'kb' } }), { builtin: true }), /route 缺失/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'memory', view: { kind: 'section', host: 'kb', route: '/x/../etc/' } }), { builtin: true }), /route 缺失或不合法/);
		// 宿主 = 自己 → 无意义（那不就是 page 了），必须报错
		assert.throws(() => parseVssarosManifest(builtinManifest({ module: 'memory', view: { kind: 'section', host: 'memory', route: '/x/memory/section' } }), { builtin: true }), /不能是自己/);
	});

	test('activityBar：title 双形态、icon 必填、order 必须整数', () => {
		assert.throws(() => parseVssarosManifest(builtinManifest({ activityBar: { containerId: 'agentStudio.tasks', icon: 'x', order: 1 } }), { builtin: true }), /title/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ activityBar: { containerId: 'agentStudio.tasks', title: 'T', order: 1 } }), { builtin: true }), /icon/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ activityBar: { containerId: 'agentStudio.tasks', title: 'T', icon: 'x', order: 1.5 } }), { builtin: true }), /order 必须是整数/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ activityBar: 'nope' }), { builtin: true }), /activityBar 必须是对象/);
	});

	test('ideCapabilities：白名单外的能力名报错，上限 16 条', () => {
		const ok = parseVssarosManifest(builtinManifest({ ideCapabilities: ['openFile', 'showDiff'] }), { builtin: true });
		assert.deepStrictEqual(ok.ideCapabilities, ['openFile', 'showDiff']);
		// 6.11.4 那条"mindmap / unreal 没有能力名"已在 v1.2.12 关闭（扩名字，不折叠，见上方新用例）；
		// ⚠ 2026-10-13：`unreal` 后来**整个退役**（改由 dsh 侧插件直连 bridge）⇒ 它现在又回到"白名单外"
		//   那一侧，所以它也是本用例的合法反例之一 ✓（见上方用例最后一条 ✓）。
		// 这条只留"真正白名单外"的例子 → fail-closed，不静默忽略。
		assert.throws(() => parseVssarosManifest(builtinManifest({ ideCapabilities: ['teleport'] }), { builtin: true }), /未支持的能力名：teleport/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ ideCapabilities: Array.from({ length: 17 }, () => 'openFile') }), { builtin: true }), /最多 16 项/);
	});

	test('owns / legacyCounterpart：单写者声明与所有权切换字段', () => {
		const m = parseVssarosManifest(builtinManifest({
			owns: ['~/.vssaros/taskboard.json', '~/.vssaros/boards.json'],
			legacyCounterpart: 'agentStudio.kanban',
		}), { builtin: true });
		assert.deepStrictEqual(m.owns, ['~/.vssaros/taskboard.json', '~/.vssaros/boards.json']);
		assert.strictEqual(m.legacyCounterpart, 'agentStudio.kanban');
		assert.throws(() => parseVssarosManifest(builtinManifest({ owns: [''] }), { builtin: true }), /非空字符串/);
		assert.throws(() => parseVssarosManifest(builtinManifest({ legacyCounterpart: '  ' }), { builtin: true }), /legacyCounterpart/);
	});

	test('tryParse 不抛错，返回 error 文案', () => {
		const bad = tryParseVssarosManifest({ manifestVersion: 1 }, { builtin: true });
		assert.strictEqual(bad.manifest, undefined);
		assert.ok(bad.error && /module/.test(bad.error));
		const good = tryParseVssarosManifest(builtinManifest(), { builtin: true });
		assert.ok(good.manifest);
		assert.strictEqual(good.error, undefined);
	});

	test('容器前缀推导与图标路径判定', () => {
		assert.strictEqual(containerPrefixOf('@acme/dsh-graph-viewer'), 'dsh-graph-viewer');
		assert.strictEqual(containerPrefixOf('dsh-plain'), 'dsh-plain');
		assert.strictEqual(isRelativeIconPath('media/graph.svg'), true);
		assert.strictEqual(isRelativeIconPath('codicon:graph'), false);
		assert.strictEqual(isRelativeIconPath('file:///tmp/a.svg'), false);
	});
});
