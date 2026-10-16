/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	DSH_UNDISABLABLE_BUNDLES, isBundleDisableForbidden, isBundleEnabled, parseHmrPatchState, parseProfileBundles, serializeProfilePackageJson, setBundleEnabled, setRowDisabledOverride,
} from '../../common/dshPluginActivation.js';

/** 真实 profile package.json 的形态（取自 poc/dsh-p0/.dsh-home/profiles/vssaros/package.json）。 */
const profile = (bundles: string[]) => ({
	name: 'dsh-profile-vssaros',
	private: true,
	dependencies: { '@vssaros/dsh-bridge': 'file:/plugins/vssaros-bridge' },
	dsh: { profile: { bundles } },
});

suite('dshPluginActivation（启停 = profile 组合的 bundles 成员）', () => {

	test('读 bundles：缺省 / 非法一律空列表', () => {
		assert.deepStrictEqual(parseProfileBundles(profile(['a', 'b'])), ['a', 'b']);
		for (const bad of [undefined, null, {}, { dsh: {} }, { dsh: { profile: {} } }, { dsh: { profile: { bundles: 'x' } } }, []]) {
			assert.deepStrictEqual(parseProfileBundles(bad), [], JSON.stringify(bad));
		}
		// 非字符串项与空串被滤掉
		assert.deepStrictEqual(parseProfileBundles({ dsh: { profile: { bundles: ['a', 42, '', null, ' b '] } } }), ['a', 'b']);
	});

	test('isBundleEnabled：在列表里 = 启用', () => {
		const pkg = profile(['@deepseek-ai/dsh-base', '@vssaros/dsh-kanban']);
		assert.strictEqual(isBundleEnabled(pkg, '@vssaros/dsh-kanban'), true);
		assert.strictEqual(isBundleEnabled(pkg, '@vssaros/dsh-kb'), false);
	});

	test('停用 = 从 bundles 移出；dependencies 与其它字段不动', () => {
		const pkg = profile(['@deepseek-ai/dsh-base', '@vssaros/dsh-kanban', '@vssaros/dsh-kb']);
		const { packageJson, changed } = setBundleEnabled(pkg, '@vssaros/dsh-kanban', false);
		assert.strictEqual(changed, true);
		assert.deepStrictEqual(parseProfileBundles(packageJson), ['@deepseek-ai/dsh-base', '@vssaros/dsh-kb']);
		assert.deepStrictEqual(packageJson['dependencies'], pkg.dependencies, '依赖保留（不重装）');
		assert.strictEqual(packageJson['name'], 'dsh-profile-vssaros');
		// 入参不被修改
		assert.deepStrictEqual(parseProfileBundles(pkg), ['@deepseek-ai/dsh-base', '@vssaros/dsh-kanban', '@vssaros/dsh-kb']);
	});

	test('幂等：重复停用 / 启用已启用的项不产生变更', () => {
		const pkg = profile(['a']);
		assert.strictEqual(setBundleEnabled(pkg, 'a', true).changed, false, '已是启用状态');
		const off = setBundleEnabled(pkg, 'a', false).packageJson;
		assert.strictEqual(setBundleEnabled(off, 'a', false).changed, false, '已是停用状态');
	});

	test('启用 = 追加到末尾（保留既有顺序）', () => {
		const pkg = profile(['a', 'b']);
		const { packageJson, changed } = setBundleEnabled(pkg, 'c', true);
		assert.strictEqual(changed, true);
		assert.deepStrictEqual(parseProfileBundles(packageJson), ['a', 'b', 'c']);
	});

	test('基础组合与控制桥不可停用（调用方据此报错）', () => {
		for (const name of DSH_UNDISABLABLE_BUNDLES) {
			assert.strictEqual(isBundleDisableForbidden(name), true, name);
			const pkg = profile(['x', name]);
			const r = setBundleEnabled(pkg, name, false);
			assert.strictEqual(r.changed, false, name);
			assert.deepStrictEqual(parseProfileBundles(r.packageJson), ['x', name]);
		}
		assert.strictEqual(isBundleDisableForbidden('@vssaros/dsh-kanban'), false);
		// 空名不产生变更
		assert.strictEqual(setBundleEnabled(profile(['a']), '  ', false).changed, false);
	});

	test('缺失 dsh 结构时能补出来（不破坏其它字段）', () => {
		const { packageJson, changed } = setBundleEnabled({ name: 'p', dependencies: {} }, '@vssaros/dsh-kb', true);
		assert.strictEqual(changed, true);
		assert.deepStrictEqual(parseProfileBundles(packageJson), ['@vssaros/dsh-kb']);
	});

	test('HMR 状态：patch 里 hmr 行的 disabled 覆盖（决定热重载 or 需重启）', () => {
		// 没有任何 hmr 条目：条目由 base bundle 提供，patch 里看不到 → unknown
		assert.strictEqual(parseHmrPatchState('[]\n'), 'unknown');
		assert.strictEqual(parseHmrPatchState(''), 'unknown');
		assert.strictEqual(parseHmrPatchState(undefined), 'unknown');
		assert.strictEqual(parseHmrPatchState('- id: vssaros-bridge\n  disabled: true\n'), 'unknown', '别的条目不算');

		// 显式停用 / 启用
		assert.strictEqual(parseHmrPatchState('- id: hmr\n  disabled: true\n'), 'disabled');
		assert.strictEqual(parseHmrPatchState('  - id: "hmr"  # keep off\n    disabled: yes\n'), 'disabled');
		assert.strictEqual(parseHmrPatchState('- id: hmr\n  disabled: false\n'), 'active');
		assert.strictEqual(parseHmrPatchState('- id: hmr\n  config:\n    root: ["."]\n'), 'active', '有条目但没写 disabled ⇒ 生效');

		// !!js 表达式：运行期才知道
		assert.strictEqual(parseHmrPatchState('- id: hmr\n  disabled: !!js someExpr\n'), 'unknown');

		// 条目边界：后面的条目不该影响判定
		assert.strictEqual(parseHmrPatchState('- id: other\n  disabled: true\n- id: hmr\n'), 'active');
		assert.strictEqual(parseHmrPatchState('- id: hmr\n- id: other\n  disabled: true\n'), 'active');
	});

	test('序列化：2 空格缩进 + 末尾换行（与 dsh 自己写的形态一致）', () => {
		const text = serializeProfilePackageJson(profile(['a']));
		assert.ok(text.endsWith('}\n'));
		assert.ok(text.includes('\n  "name": "dsh-profile-vssaros",'), text.slice(0, 80));
		assert.deepStrictEqual(parseProfileBundles(JSON.parse(text)), ['a']);
	});
});

/**
 * 行级启停的**文件级通路**：给 profile 的 `cordis.patch.yml` 写/删 `disabled` 覆盖。
 *
 * 为什么这条路必须存在：Host 的实时重组在 VsSaros 的启动路径上必然失败（README 4.51），
 * 没有它，用户在插件中心点"禁用某一行"就是**白点**（Host 报 `operation-error`，什么也没发生）。
 * 落盘形态必须与 dsh 自己写的**逐字一致**（`dsh-plugin-manager`：`setIn(["disabled"], !enabled)`），
 * 否则 dsh 读不到——所以这里既断言行级编辑的结果，也用 `parseHmrPatchState` 做**读写往返**。
 */
suite('setRowDisabledOverride（行级启停的文件级通路）', () => {

	test('★ 停用：条目存在 ⇒ 在**条目末尾**加 `disabled: true`，其它字段与注释原样保留', () => {
		const before = [
			'# 用户手改过的 patch（注释要留着）',
			'- id: vssaros-chat-surface',
			"  name: '@vssaros/dsh-chat-surface'",
			'  config: { surface: full }',
			'- id: other',
			'  disabled: true',
			'',
		].join('\n');
		const { text, changed } = setRowDisabledOverride(before, 'vssaros-chat-surface', false);
		assert.strictEqual(changed, true);
		assert.strictEqual(text, [
			'# 用户手改过的 patch（注释要留着）',
			'- id: vssaros-chat-surface',
			"  name: '@vssaros/dsh-chat-surface'",
			'  config: { surface: full }',
			'  disabled: true',
			'- id: other',
			'  disabled: true',
			'',
		].join('\n'), 'disabled 加在条目末尾（与 dsh 的 setIn 同形）、其余字段与注释原样保留；别的条目不受影响');
	});

	test('★ 启用：只删 `disabled`；该条目若只剩 id/name ⇒ 连条目一起删（与 dsh 的清理同口径）', () => {
		// 还有 config ⇒ 只删那一行（不能把用户/上游写的条目一起删掉）
		const withConfig = ['- id: a', '  disabled: true', '  config: { x: 1 }', ''].join('\n');
		assert.strictEqual(setRowDisabledOverride(withConfig, 'a', true).text, ['- id: a', '  config: { x: 1 }', ''].join('\n'));
		// 只剩 id/name ⇒ 整条删掉（否则 patch 里会攒下一堆没内容的空条目）
		const bare = ['- id: a', '  name: pkg-a', '  disabled: true', '- id: b', ''].join('\n');
		assert.strictEqual(setRowDisabledOverride(bare, 'a', true).text, ['- id: b', ''].join('\n'));
	});

	test('条目不存在：停用 ⇒ 追加一条；启用 ⇒ 什么都不做（没有覆盖 = 本来就启用）', () => {
		const { text, changed } = setRowDisabledOverride('- id: other\n', 'vssaros-kb', false);
		assert.strictEqual(changed, true);
		assert.strictEqual(text, ['- id: other', '', '- id: vssaros-kb', '  disabled: true', ''].join('\n'));
		assert.deepStrictEqual(setRowDisabledOverride('- id: other\n', 'vssaros-kb', true), { text: '- id: other\n', changed: false });
	});

	test('幂等：已经停用再停用、没有覆盖再启用 ⇒ `changed:false`（调用方据此不写盘）', () => {
		assert.strictEqual(setRowDisabledOverride('- id: a\n  disabled: true\n', 'a', false).changed, false);
		assert.strictEqual(setRowDisabledOverride('- id: a\n  config: {}\n', 'a', true).changed, false);
		// 空串 id / 无文本来启用：都不该写盘
		assert.strictEqual(setRowDisabledOverride('- id: a\n', '', false).changed, false);
	});

	test('★ 只认**顶层**条目（`insert:` 里的同 id 行是补丁内容，不是可覆盖的条目）', () => {
		// dsh 的口径是 `findLastIndex(… item.has("insert") === false)`：`insert:` 下面那一行不算
		const nested = ['- id: wrapper', '  insert:', '    - id: vssaros-kb', '      name: pkg-kb', ''].join('\n');
		const { text, changed } = setRowDisabledOverride(nested, 'vssaros-kb', false);
		assert.strictEqual(changed, true, '顶层没有 ⇒ 应当追加一条覆盖（而不是改 insert 里面那行）');
		assert.ok(text.includes('- id: vssaros-kb\n  disabled: true'), text);
		assert.ok(text.includes('    - id: vssaros-kb\n      name: pkg-kb'), '补丁内容原样保留');
	});

	test('★ 同 id 多条：取最后一条；给了 moduleName 时要求条目自带的 name 对得上（dsh 的 expectedName 判定）', () => {
		// 同名不同模块的行是"换过模块的残留"（dsh 用 `expectedName` 过滤掉它们），两条都可能是目标
		const two = ['- id: a', '  name: pkg-old', '  disabled: true', '- id: a', "  name: '@scope/pkg'", ''].join('\n');
		// 不给 moduleName ⇒ 取最后一条（`findLast` 口径）
		const anyName = setRowDisabledOverride(two, 'a', false);
		assert.ok(anyName.text.includes("  name: '@scope/pkg'\n  disabled: true"), anyName.text);
		assert.ok(anyName.text.includes('  name: pkg-old\n  disabled: true'), '前一条不动');
		// 给了 moduleName ⇒ 只认 name 对得上的那一条：这里第一条已经是停用态 ⇒ 幂等（证明没去改第二条）
		assert.strictEqual(setRowDisabledOverride(two, 'a', false, 'pkg-old').changed, false);
		// name 完全对不上 ⇒ 与 dsh 一样"当作没这条"、追加一条覆盖（不猜、不改别人的行）
		const mismatched = setRowDisabledOverride(two, 'a', false, 'pkg-other');
		assert.strictEqual(mismatched.changed, true);
		assert.ok(mismatched.text.endsWith('- id: a\n  disabled: true\n'), mismatched.text);
		assert.ok(mismatched.text.includes("  name: '@scope/pkg'"), '既有两条都不动');
	});

	test('★ 读写往返：写完 `hmr` 行后 `parseHmrPatchState` 必须读到（writer ↔ reader 同源）', () => {
		const off = setRowDisabledOverride('', 'hmr', false);
		assert.strictEqual(parseHmrPatchState(off.text), 'disabled', '写出来的形态必须是 dsh/我们自己读得懂的');
		const on = setRowDisabledOverride(off.text, 'hmr', true);
		assert.strictEqual(parseHmrPatchState(on.text), 'unknown', '删掉覆盖 ⇒ 回到"由 base bundle 提供"');
	});

	test('保留原有换行风格（CRLF 不会被改成 LF）；空文本按 LF 新建', () => {
		const crlf = ['- id: a', '  name: pkg-a', ''].join('\r\n');
		const { text } = setRowDisabledOverride(crlf, 'a', false);
		assert.ok(text.includes('\r\n'), '不能把用户文件的换行换掉');
		assert.ok(!/[^\r]\n/.test(text), `只应有 CRLF：${JSON.stringify(text)}`);
		assert.strictEqual(setRowDisabledOverride(undefined, 'a', false).text, '- id: a\n  disabled: true\n');
	});
});
