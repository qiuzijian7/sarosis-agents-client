/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 桥方法**双向**一致性守卫：协议枚举（`common/dshBridgeProtocol.ts` 的 `DshBridgeMethod`）
 * ↔ 桥插件分发（`dsh-plugins/vssaros-bridge/lib/index.js` 的 `case '<method>':`）。
 *
 * 为什么要有这条：协议加一个方法、插件忘实现（或反之）只会在**运行时**表现为
 * "method not found" 或死代码，往往到具体操作路径才被发现。跨进程的字符串对没有任何
 * 类型系统能连起来（插件是纯 JS），所以用源码解析钉住。
 *
 * 注意：`DshBridgeMethod` 是 `const enum`，不能用 `Object.values` 取成员 —— 从源码文本解析。
 */

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
const protocolSource = readFileSync(join(repoRoot, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshBridgeProtocol.ts'), 'utf8');
const bridgeSource = readFileSync(join(repoRoot, 'dsh-plugins', 'vssaros-bridge', 'lib', 'index.js'), 'utf8');

/** 协议里 IDE → Host 方向的方法名（只取 `DshBridgeMethod` 这个 enum 块）。 */
function protocolMethods(source: string): Set<string> {
	const block = /export const enum DshBridgeMethod \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
	return new Set([...block.matchAll(/=\s*'([^']+)'/g)].map(m => m[1]));
}

/** 桥插件里分发的方法名（`case '<name>':`，含 `case 'a': case 'b': {` 的合并写法）。 */
function dispatchedMethods(source: string): Set<string> {
	return new Set([...source.matchAll(/case\s+'([^']+)'\s*:/g)].map(m => m[1]));
}

suite('dshHarness / bridge method parity', () => {

	test('协议枚举可解析（守卫自身的前置：解析不到就说明守卫失效了）', () => {
		const protocol = protocolMethods(protocolSource);
		assert.ok(protocol.size >= 8, `DshBridgeMethod 只解析出 ${protocol.size} 个方法：解析规则与源码格式脱节了`);
		assert.ok(protocol.has('workspace.ensure') && protocol.has('session.start'), `解析结果不含已知方法：${[...protocol].join(', ')}`);
	});

	test('每个协议方法都被桥插件分发（双向差集都为空）', () => {
		const protocol = protocolMethods(protocolSource);
		const dispatched = dispatchedMethods(bridgeSource);
		const missing = [...protocol].filter(m => !dispatched.has(m));
		const extra = [...dispatched].filter(m => !protocol.has(m));
		assert.deepStrictEqual(missing, [], `桥插件缺少分发：${missing.join(', ')}`);
		assert.deepStrictEqual(extra, [], `桥插件分发了协议里没有的方法：${extra.join(', ')}`);
	});

	test('插件商城（方案 5.16）的只读/写入方法族在两侧都在位', () => {
		const protocol = protocolMethods(protocolSource);
		const dispatched = dispatchedMethods(bridgeSource);
		for (const m of [
			// 批次 2：只读面
			'plugins.bundles.list', 'plugins.plugins.list', 'plugins.registries', 'plugins.inventory',
			// 批次 3：写入面（启停走 Host）
			'plugins.bundle.setEnabled', 'plugins.plugin.setEnabled',
		]) {
			assert.ok(protocol.has(m), `协议缺少 ${m}`);
			assert.ok(dispatched.has(m), `桥插件缺少 ${m}`);
		}
	});
});
