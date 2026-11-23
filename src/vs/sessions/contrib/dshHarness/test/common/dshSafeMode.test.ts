/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「以安全模式重启」判据的行为守卫（2026-11-23）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshSafeMode
 */

import assert from 'assert';
import {
	DSH_SAFE_MODE_STORAGE_KEY, isThirdPartyPlugin, safeModeDisablePlan, validateSafeModeBackup,
} from '../../common/dshSafeMode.js';

suite('dshHarness / 安全模式重启判据', () => {

	test('官方 / 内置 / 受保护 / 脏包名一律不停用', () => {
		assert.strictEqual(isThirdPartyPlugin('@vssaros/dsh-chat-surface'), false);
		assert.strictEqual(isThirdPartyPlugin('@deepseek-ai/dsh-session'), false);
		assert.strictEqual(isThirdPartyPlugin('my-plugin', ['my-plugin']), false, '页面所在插件必须受保护');
		for (const bad of ['', '../evil', 'a b', 'x'.repeat(300), 42, null, undefined]) {
			assert.strictEqual(isThirdPartyPlugin(bad), false, `脏包名 ${String(bad)}`);
		}
		assert.strictEqual(isThirdPartyPlugin('some-third-party'), true);
	});

	test('停用计划：只收已启用的第三方插件，去重 + 限长', () => {
		const plugins = [
			{ name: '@vssaros/dsh-kb', enabled: true },
			{ name: 'alpha-plugin', enabled: true },
			{ name: 'alpha-plugin', enabled: true },
			{ name: 'disabled-one', enabled: false },
			{ name: 'beta-plugin' },                    // enabled 缺省视为启用
			{ name: '../evil' },
		];
		assert.deepStrictEqual(safeModeDisablePlan(plugins), ['alpha-plugin', 'beta-plugin']);
		assert.deepStrictEqual(safeModeDisablePlan(plugins, ['beta-plugin']), ['alpha-plugin']);
		assert.deepStrictEqual(safeModeDisablePlan(undefined), []);
		const many = Array.from({ length: 140 }, (_, i) => ({ name: `p-${i}` }));
		assert.strictEqual(safeModeDisablePlan(many).length, 100);
	});

	test('恢复清单：storage 里的脏值不许变成批量启用', () => {
		assert.deepStrictEqual(validateSafeModeBackup(['alpha-plugin', 'beta-plugin']), ['alpha-plugin', 'beta-plugin']);
		assert.deepStrictEqual(validateSafeModeBackup(JSON.stringify(['alpha-plugin'])), ['alpha-plugin']);
		assert.deepStrictEqual(validateSafeModeBackup([
			'alpha-plugin', '@vssaros/dsh-kb', '../evil', 'alpha-plugin', 42,
		]), ['alpha-plugin']);
		assert.deepStrictEqual(validateSafeModeBackup(null), []);
		assert.deepStrictEqual(validateSafeModeBackup('not-json'), []);
		assert.deepStrictEqual(validateSafeModeBackup(['alpha-plugin'], ['alpha-plugin']), []);
	});

	test('storage 键是稳定契约（菜单与服务必须用同一个）', () => {
		assert.strictEqual(DSH_SAFE_MODE_STORAGE_KEY, 'dsh.safeMode.disabledPlugins');
	});
});
