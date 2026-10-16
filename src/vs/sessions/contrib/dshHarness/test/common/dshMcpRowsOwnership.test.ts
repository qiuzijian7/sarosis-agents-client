/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP 行的**归属判定**（壳该不该让路给 dsh 侧）—— 2026-10-12。
 *
 * 背景：MCP 的"配置 → 组合行"已搬去 dsh 侧（`dsh-plugins/vssaros-mcp/bin/sync-rows.mjs`，用官方
 * `dsh plugin add` 登记成 profile 的 bundle 层），但壳里仍留着渲染 `--patch` 覆盖层的老路。
 * **两条路并存会把同一台服务器挂两遍**（`insert` 不是"同 id 后层胜出"；p3-25 实测），而 dsh 侧
 * `serverName` 重复会让后到者**加载失败** ✗ ⇒ 壳必须能在"已登记"时主动让路。
 *
 * 这里钉的是那个判据（纯函数）：**只认那一个包名**，相近的、别家的、畸形的都不算 ✓。
 */

import assert from 'assert';
import { DSH_MCP_ROWS_BUNDLE_NAME, isDshRowsBundleRegistered } from '../../common/dshMcpConfig.js';

const withBundles = (bundles: unknown): unknown => ({ dsh: { profile: { bundles } } });

suite('MCP 行归属：壳是否该让路给 dsh 侧', () => {

	test('登记了 dsh 侧的 MCP 行 bundle ⇒ true（壳不写覆盖层）', () => {
		assert.strictEqual(DSH_MCP_ROWS_BUNDLE_NAME, '@vssaros/dsh-mcp-rows');
		assert.strictEqual(isDshRowsBundleRegistered(withBundles([
			'@deepseek-ai/dsh-base',
			'@vssaros/dsh-mcp',
			DSH_MCP_ROWS_BUNDLE_NAME,
		])), true);
	});

	test('★ 只认那一个包名：相近名字（前缀/后缀）**不算** ✗', () => {
		for (const near of [
			'@vssaros/dsh-mcp-rows-extra',
			'@vssaros/dsh-mcp-row',
			'dsh-mcp-rows',
			'@vssaros/dsh-mcp-rows2',
		]) {
			assert.strictEqual(isDshRowsBundleRegistered(withBundles([near])), false, `不该被 ${near} 触发`);
		}
	});

	test('没登记 / 空列表 / 字段畸形 / 不是对象 ⇒ false（退回旧的覆盖层行为，与今天一致）', () => {
		assert.strictEqual(isDshRowsBundleRegistered(withBundles([])), false);
		assert.strictEqual(isDshRowsBundleRegistered(undefined), false);
		assert.strictEqual(isDshRowsBundleRegistered(null), false);
		assert.strictEqual(isDshRowsBundleRegistered('nonsense'), false);
		assert.strictEqual(isDshRowsBundleRegistered({}), false);
		assert.strictEqual(isDshRowsBundleRegistered({ dsh: {} }), false);
		assert.strictEqual(isDshRowsBundleRegistered({ dsh: { profile: {} } }), false);
		assert.strictEqual(isDshRowsBundleRegistered({ dsh: { profile: { bundles: 'x' } } }), false);
		// 列表里混入非字符串：合法项仍要认得出来（与 parseProfileBundles 同口径）
		assert.strictEqual(isDshRowsBundleRegistered(withBundles([42, null, DSH_MCP_ROWS_BUNDLE_NAME, '  '])), true);
	});

	test('大小写/空白：与 parseProfileBundles 同一口径（trim 后**精确**匹配，不做大小写折叠）', () => {
		assert.strictEqual(isDshRowsBundleRegistered(withBundles([`  ${DSH_MCP_ROWS_BUNDLE_NAME}  `])), true, 'trim 生效');
		assert.strictEqual(isDshRowsBundleRegistered(withBundles([DSH_MCP_ROWS_BUNDLE_NAME.toUpperCase()])), false,
			'不做大小写折叠（npm 包名本就小写；折叠会让"另一个包"被误认）');
	});
});
