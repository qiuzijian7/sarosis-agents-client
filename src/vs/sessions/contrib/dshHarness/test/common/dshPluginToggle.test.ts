/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件商城写入面（方案 5.16 批次 3）的入参校验：`plugins.bundle.setEnabled` /
 * `plugins.plugin.setEnabled` 的负载跨进程边界，字符白名单要收紧（包名与 `include:<rowId>` 两类）。
 */

import assert from 'assert';
import { validateBundleToggleArgs, validatePluginRowToggleArgs } from '../../common/dshBridgeProtocol.js';

suite('dshHarness / plugin toggle payloads', () => {

	test('组合包启停：接受 scope 包名，拒绝空/超长/非法字符', () => {
		assert.ok(validateBundleToggleArgs({ name: '@vssaros/dsh-chat-surface', enabled: true }));
		assert.ok(validateBundleToggleArgs({ name: '@deepseek-ai/dsh-base', enabled: false }));
		assert.ok(!validateBundleToggleArgs({ name: '   ', enabled: true }));
		assert.ok(!validateBundleToggleArgs({ name: ' @vssaros/x', enabled: true }), '带空白的机器 id 必须被拒（被 trim 后放行会变成"通过校验但查不到"）');
		assert.ok(!validateBundleToggleArgs({ name: '@vssaros/x ', enabled: true }));
		assert.ok(!validateBundleToggleArgs({ name: 'a b', enabled: true }));
		assert.ok(!validateBundleToggleArgs({ name: 'a\nb', enabled: true }));
		assert.ok(!validateBundleToggleArgs({ name: '/abs/path', enabled: true }));
		assert.ok(!validateBundleToggleArgs({ name: 'x'.repeat(513), enabled: true }));
		assert.ok(!validateBundleToggleArgs({ name: '@vssaros/x' }), 'enabled 必填且为布尔');
		assert.ok(!validateBundleToggleArgs({ name: '@vssaros/x', enabled: 'yes' }));
		assert.ok(!validateBundleToggleArgs(null));
	});

	test('行启停：接受 include:<rowId> 形态，拒绝空/非法字符', () => {
		assert.ok(validatePluginRowToggleArgs({ entryId: 'include:vssaros-chat-surface', enabled: false }));
		assert.ok(validatePluginRowToggleArgs({ entryId: 'vssaros-probe-bundle-row', enabled: true }));
		assert.ok(validatePluginRowToggleArgs({ entryId: 'include:a-b.c_d/e', enabled: true }));
		assert.ok(!validatePluginRowToggleArgs({ entryId: '', enabled: true }));
		assert.ok(!validatePluginRowToggleArgs({ entryId: ' include:x', enabled: true }));
		assert.ok(!validatePluginRowToggleArgs({ entryId: 'a b', enabled: true }));
		assert.ok(!validatePluginRowToggleArgs({ entryId: 'x'.repeat(513), enabled: true }));
		assert.ok(!validatePluginRowToggleArgs({ entryId: 'include:x', enabled: 1 }));
		assert.ok(!validatePluginRowToggleArgs(undefined));
	});
});
