/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh「外观」偏好解析（2026-11-02，抄官方 dsh-desktop 的时序）。
 *
 * ## 为什么需要这个解析
 * 官方桌面壳在**建窗口之前**就把 `nativeTheme.themeSource` 设成 dsh 自己的偏好
 * （`dsh-desktop/src/main/index.ts::harnessThemePreference()` 读 `settings.yaml` 的
 * `ui-theme.preference`）⇒ 窗口一出生 `prefers-color-scheme` 就是对的，首帧不闪。
 *
 * 我们是多窗口宿主，不能改全局 `nativeTheme`（会波及 IDE 窗口），但可以在**建视图时**
 * 把该视图的 `Emulation.setEmulatedMedia` 定下来 —— 前提是主进程能读到这份偏好，
 * 也就是本文件的解析器。这条测试钉住的是解析的**容错口径**：
 * 认不出 ⇒ `system`（= 不模拟，退回旧行为），**绝不猜**。
 */

import assert from 'assert';
import { colorSchemeForPreference, DSH_DEFAULT_THEME_PREFERENCE, parseThemePreference } from '../../common/dshThemePreference.js';

suite('dshHarness / dsh 外观偏好解析（settings.yaml → ui-theme.preference）', () => {

	// ── 正常写法：块映射（dsh 设置界面写出来的就是这种）─────────────────────────

	test('★ 块写法：ui-theme.preference 三种取值都认', () => {
		assert.strictEqual(parseThemePreference('ui-theme:\n  preference: light\n'), 'light');
		assert.strictEqual(parseThemePreference('ui-theme:\n  preference: dark\n'), 'dark');
		assert.strictEqual(parseThemePreference('ui-theme:\n  preference: system\n'), 'system');
	});

	test('★ 前面还有别的顶级块时也要能找到（真实 settings.yaml 是长的）', () => {
		const yaml = [
			'model:',
			'  default: deepseek-v3',
			'  temperature: 0.7',
			'ui-theme:',
			'  preference: dark',
			'  fontSize: 13',
			'editor:',
			'  tabSize: 2',
			'',
		].join('\n');
		assert.strictEqual(parseThemePreference(yaml), 'dark', '必须只认 ui-theme 块里的 preference，不能被别的块带偏');
	});

	test('★ 引号 / 大小写 / 行尾注释都要容错', () => {
		assert.strictEqual(parseThemePreference('ui-theme:\n  preference: "dark"\n'), 'dark');
		assert.strictEqual(parseThemePreference("ui-theme:\n  preference: 'light'\n"), 'light');
		assert.strictEqual(parseThemePreference('ui-theme:\n  preference: Dark\n'), 'dark');
		assert.strictEqual(parseThemePreference('ui-theme:\n  preference: light   # 手改的\n'), 'light');
	});

	test('★ 行内映射写法（ui-theme: { preference: dark }）也认', () => {
		assert.strictEqual(parseThemePreference('ui-theme: { preference: dark }\n'), 'dark');
	});

	// ── 容错：认不出 ⇒ system（不猜）─────────────────────────────────────────

	test('★ 没有 ui-theme / 值非法 / 空文本 ⇒ system（宁可退回旧行为，也不要猜错）', () => {
		assert.strictEqual(parseThemePreference(''), 'system');
		assert.strictEqual(parseThemePreference('editor:\n  tabSize: 2\n'), 'system');
		assert.strictEqual(parseThemePreference('ui-theme:\n  preference: sepia\n'), 'system', '不认识的取值不许当成 light/dark');
		assert.strictEqual(parseThemePreference('ui-theme:\n  fontSize: 13\n'), 'system', '块里没有 preference ⇒ system');
		assert.strictEqual(parseThemePreference('ui-theme:'), 'system');
	});

	test('★ 别的块里的 preference 不许串进来（缩进判定的回归）', () => {
		// `locale.preference` 是同级块 ⇒ ui-theme 块已经结束，不能把它的值当外观
		const yaml = 'ui-theme:\n  fontSize: 13\nlocale:\n  preference: dark\n';
		assert.strictEqual(parseThemePreference(yaml), 'system');
	});

	test('默认常量就是 system（与"没配 ⇒ 跟随系统"的产品口径一致）', () => {
		assert.strictEqual(DSH_DEFAULT_THEME_PREFERENCE, 'system');
	});

	// ── 偏好 → 要模拟的 palette 模式 ─────────────────────────────────────────

	test('★ system ⇒ undefined（不模拟）；显式 light/dark ⇒ 对应值', () => {
		assert.strictEqual(colorSchemeForPreference('light', true), 'light', '显式浅色与系统明暗无关');
		assert.strictEqual(colorSchemeForPreference('dark', false), 'dark', '显式深色与系统明暗无关');
		// `system` 时**任何**模拟值都是错的（模拟了页面里的 matchMedia 就读不到真实系统值）
		assert.strictEqual(colorSchemeForPreference('system', true), undefined);
		assert.strictEqual(colorSchemeForPreference('system', false), undefined);
	});
});
