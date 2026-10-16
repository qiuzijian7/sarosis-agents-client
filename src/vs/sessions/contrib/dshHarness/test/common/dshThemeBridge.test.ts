/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { backgroundForPageSurface, buildDshThemeTokens, validateThemeTokens, validateViewBackgrounds } from '../../common/dshThemeBridge.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('dshThemeBridge（主题 token 映射）', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('映射表取首个可用颜色，两形态同值', () => {
		const colors: Record<string, string> = {
			'editor.background': '#1e1e1e',
			'sideBar.background': '#252526',
			'editor.foreground': '#d4d4d4',
			'button.background': '#0e639c',
		};
		const tokens = buildDshThemeTokens(id => colors[id]);
		assert.deepStrictEqual(tokens['--dsw-alias-bg-base'], { light: '#1e1e1e', dark: '#1e1e1e' });
		assert.deepStrictEqual(tokens['--dsw-alias-bg-layer-1'], { light: '#252526', dark: '#252526' });
		assert.deepStrictEqual(tokens['--dsw-alias-brand-primary'], { light: '#0e639c', dark: '#0e639c' });
		// input.border / panel.border 都缺 → 边框 token 跳过（保留 dsh 默认）
		assert.strictEqual(tokens['--dsw-alias-border-l1'], undefined);
		assert.strictEqual(tokens['--dsw-alias-border-l2'], undefined);
	});

	test('备选色按序回退', () => {
		const tokens = buildDshThemeTokens(id => id === 'focusBorder' ? '#007fd4' : undefined);
		assert.deepStrictEqual(tokens['--dsw-alias-brand-primary'], { light: '#007fd4', dark: '#007fd4' });
	});

	test('全部缺色时返回空对象', () => {
		assert.deepStrictEqual(buildDshThemeTokens(() => undefined), {});
	});

	test('校验接受合法覆盖层', () => {
		assert.ok(validateThemeTokens({ '--dsw-alias-bg-base': { light: '#fff', dark: 'rgba(0,0,0,0.5)' } }));
	});

	test('校验拒绝非 dsw 变量名与畸形值', () => {
		assert.ok(!validateThemeTokens(undefined));
		assert.ok(!validateThemeTokens(null));
		assert.ok(!validateThemeTokens([]));
		assert.ok(!validateThemeTokens({ '--vscode-editor-background': { light: '#fff', dark: '#000' } }));
		assert.ok(!validateThemeTokens({ 'background': { light: '#fff', dark: '#000' } }));
		assert.ok(!validateThemeTokens({ '--dsw-alias-bg-base': '#fff' }));
		assert.ok(!validateThemeTokens({ '--dsw-alias-bg-base': { light: '#fff' } }));
		assert.ok(!validateThemeTokens({ '--dsw-alias-bg-base': { light: '<script>', dark: '#000' } }));
	});

	// ── 视图底色（2026-10-13 修「初次打开侧栏视图白屏一下」）──────────────────────────
	// 原生 `WebContentsView` 从创建到页面画出第一帧之间露的是 Electron 默认白 ⇒ 建视图时先染成主题色 ✓。
	// 颜色只有渲染进程知道、位置只有主进程知道 ⇒ 两个候选色推过去、主进程挑；挑法就是下面这条纯函数 ✓。
	suite('视图底色（原生视图的白屏窗口）', () => {

		const both = { sidebar: '#252526', editor: '#1e1e1e' };

		test('★ 按承载位置挑：侧栏 ⇒ sidebar、编辑区 ⇒ editor；**没给 pageSurface 也按侧栏**（chat/sessions/full 都落在侧栏 ✓）', () => {
			assert.strictEqual(backgroundForPageSurface(both, 'sideview'), '#252526');
			assert.strictEqual(backgroundForPageSurface(both, 'editor'), '#1e1e1e');
			assert.strictEqual(backgroundForPageSurface(both, undefined), '#252526');
		});

		test('★ 位置对应的色缺了就退另一个（**有主题色就比默认白好** ✓）；两个都缺 ⇒ undefined（保持原值，不退回白 ✗）', () => {
			assert.strictEqual(backgroundForPageSurface({ sidebar: '#252526' }, 'editor'), '#252526');
			assert.strictEqual(backgroundForPageSurface({ editor: '#1e1e1e' }, 'sideview'), '#1e1e1e');
			assert.strictEqual(backgroundForPageSurface({}, 'sideview'), undefined);
			assert.strictEqual(backgroundForPageSurface(undefined, 'editor'), undefined);
		});

		test('★ 跨进程校验：只收**形状合法的 CSS 颜色**（畸形值 / 注入一律拒 ⇒ 主进程当没给 ✓）', () => {
			assert.ok(validateViewBackgrounds({ sidebar: '#252526', editor: 'rgba(30,30,30,0.5)' }));
			assert.ok(validateViewBackgrounds({}), '空对象合法 ⇒ 等价于没给 ✓');
			assert.ok(!validateViewBackgrounds(undefined));
			assert.ok(!validateViewBackgrounds(null));
			assert.ok(!validateViewBackgrounds('#252526'), '不是对象 ⇒ 拒（不能把字符串当负载 ✓）');
			assert.ok(!validateViewBackgrounds({ sidebar: '<script>' }));
			assert.ok(!validateViewBackgrounds({ sidebar: 42 }));
			assert.ok(!validateViewBackgrounds({ sidebar: '#fff'.repeat(40) }), '超长 ⇒ 拒（与 token 值同一条长度上限 ✓）');
		});

		/**
		 * ★★ **接线不变量（源码级）** —— 为什么不用行为测试：原生 `WebContentsView` 的底色
		 * 只有真机起 IDE 才看得见（单测环境里没有 Electron 视图 ✗）⇒ 一旦有人重构掉这条接线，
		 * 症状只是"开侧栏闪一下白"（用户 2026-10-13 报障的原现象）⇒ 又一次**静默的观感退化** ✗✗。
		 * 本仓对这类"不可测但会悄悄退化"的东西一贯用源码守卫（同 `mainProcessSyncWrites.test.ts` ✓）。
		 */
		test('★★ 三处接线都在位：渲染进程算两个候选色 / 通道校验 / 主进程按承载位置染色（且**先染色再 attach**）', () => {
			const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
			const read = (rel: string) => readFileSync(join(REPO, ...rel.split('/')), 'utf8');
			const svc = read('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts');
			const channel = read('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts');
			const host = read('src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts');

			assert.ok(svc.includes("this._themeCssColor('sideBar.background')") || svc.includes('"sideBar.background"'),
				'渲染进程必须**取侧栏底色**（只取编辑器底色会让侧栏闪成另一种不协调的颜色 ✗）');
			assert.ok(svc.includes("this._themeCssColor('editor.background')"),
				'渲染进程必须**取编辑器区底色**（编辑区承载的插件页用得上 ✓）');
			assert.ok(/backgrounds:\s*this\._viewBackgrounds\(\)/.test(svc),
				'★ 底色必须随 **CreateView** 一起给 —— 只靠 pushTheme 会晚一拍，那几毫秒照样露白 ✗✗');
			assert.ok(channel.includes('validateViewBackgrounds(a.backgrounds)'),
				'跨进程负载必须在通道侧先校验（与 `tokens` 同一口径 ✓ —— 主进程是信任边界 ✓）');
			assert.ok(/validateViewBackgrounds\(a\.backgrounds\)\s*\?\s*a\.backgrounds\s*:\s*undefined/.test(channel),
				'非法负载必须**当没给**（而不是把没校验过的串塞进原生 API ✗）');
			assert.ok(host.includes('backgroundForPageSurface(slot.backgrounds, slot.pageSurface)') && host.includes('slot.view.setBackgroundColor(color)'),
				'主进程必须按 `pageSurface` 挑色并真的 `setBackgroundColor` —— 原生视图盖在 DOM 上，用 CSS 挡不住 ✗');
			assert.ok(/this\._applyViewBackground\(slot\);[\s\S]{0,40}this\._wire\(slot\);/.test(host),
				'★ 染色必须发生在 **wire / attach / setVisible(true) 之前** —— 顺序反了，中间那几毫秒照样露白 ✗✗');
		});
	});
});
