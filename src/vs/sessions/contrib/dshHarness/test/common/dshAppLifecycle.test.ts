/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * app 开关规则（2026-10-24 用户口径）：
 *   ① 只开了桌面窗口 ⇒ 关窗口 = 关 app
 *   ② 只开了 IDE     ⇒ 关 IDE  = 关 app
 *   ③ 两个都开着     ⇒ 关哪个都只关它自己
 *
 * 这张表就是"产品规则"，任何改动必须先过它。
 */
import assert from 'assert';
import { decideDesktopWindowClose, decideIdeWindowClose } from '../../common/dshAppLifecycle.js';

const F = (ideVisible: number, desktop: number) => ({ ideVisible, desktop });

suite('dshHarness / app 开关规则（关窗收场）', () => {

	test('规则 ①：只开了桌面窗口 ⇒ 关窗口 = 关 app', () => {
		// 桌面上只剩这一扇（IDE 被藏着 / 没开）
		assert.strictEqual(decideDesktopWindowClose(F(0, 0)), 'quit');
		// 还有别的桌面窗口 ⇒ 只关自己（多桌面窗口形态）
		assert.strictEqual(decideDesktopWindowClose(F(0, 1)), 'close');
	});

	test('规则 ②：只开了 IDE ⇒ 关 IDE = 关 app', () => {
		assert.strictEqual(decideIdeWindowClose(F(0, 0)), 'quit');
		// 还有别的可见 IDE 窗口 ⇒ 只关自己
		assert.strictEqual(decideIdeWindowClose(F(1, 0)), 'close');
	});

	test('规则 ③：两个都开着 ⇒ 关哪个都只关它自己', () => {
		// 关桌面窗口：IDE 还可见 ⇒ 不退
		assert.strictEqual(decideDesktopWindowClose(F(1, 0)), 'close');
		assert.strictEqual(decideDesktopWindowClose(F(1, 2)), 'close');
		// 关 IDE：不能真关（会带走桌面窗口）⇒ 隐藏；用户视角 = 关了自己
		assert.strictEqual(decideIdeWindowClose(F(0, 1)), 'hide');
		assert.strictEqual(decideIdeWindowClose(F(0, 3)), 'hide');
		// 关 IDE 且还有别的可见 IDE 窗口：关自己即可（桌面窗口仍活着）
		assert.strictEqual(decideIdeWindowClose(F(1, 1)), 'close');
	});

	test('边界：隐藏的 IDE 不算"还开着"', () => {
		// 典型回归：桌面模式下 IDE 被藏着（ideVisible=0）⇒ 关桌面窗口必须退出，
		// 否则留下"没有界面却活着"的隐形进程 ✗
		assert.strictEqual(decideDesktopWindowClose(F(0, 0)), 'quit');
		// 反过来，隐藏 ≠ 可以真关（关桌面窗口时它没参与判定）
		assert.notStrictEqual(decideDesktopWindowClose(F(0, 0)), 'hide');
	});

	test('幂等：同一组事实重复判定结果一致（两处收场都调它，不许抖动）', () => {
		for (let i = 0; i < 3; i++) {
			assert.strictEqual(decideIdeWindowClose(F(0, 1)), 'hide');
			assert.strictEqual(decideDesktopWindowClose(F(1, 0)), 'close');
			assert.strictEqual(decideDesktopWindowClose(F(0, 0)), 'quit');
		}
	});
});
