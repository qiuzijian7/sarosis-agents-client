/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「VS Code 的自动更新必须关掉」的守卫（2026-10-29 建，**2026-10-30 纠错**）。
 *
 * 用户要求：**启动时不要弹出升级提示**；升级只由手动入口触发
 * （desktop 左下角那行 / VsSaros 菜单「检查更新…」面板）。
 *
 * ⚠⚠ 2026-10-30 纠错（重要，别再照旧记忆改 product.json）：
 *   2026-10-29 的做法是往 `product.json` 写 `"update": { "mode": "manual" }` —— **那是死字段**：
 *     · `IProductConfiguration` 里**根本没有** `update` 字段（`src/vs/platform/product/common/product.ts` 零命中）；
 *     · `abstractUpdateService` 读的是 `configurationService.getValue('update.mode')`，
 *       默认值**只**来自 `src/vs/platform/update/common/update.config.contribution.ts` 的 `default`；
 *     · 真机证据：打包版 `main.log` 只有 `update#setState idle`，**没有**
 *       `update#ctor - manual checks only; automatic updates are disabled by user preference`
 *       ⇒ mode 一直是 `default` ⇒ 启动 30s 后自动检查 + 每小时再查，Ready 后弹通知/徽章 ✗。
 *   ⇒ 真源改到配置默认值（`default: 'manual'`），并把 product.json 的死字段删掉（守卫 1b 钉住）。
 *
 * ⚠ **`updateUrl` 一律不许动**：它是 VS Code updateService 真正用的下载源
 *   （形态 `GET {updateUrl}/api/update/{platform}/{quality}/{commit}`）；删了/改了 ⇒ 退回
 *   **官方默认源**（`update.code.visualstudio.com`）⇒ 点「一键升级」可能下载**官方 VS Code** ✗✗。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpdateViaDshOnly
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const PRODUCT = 'product.json';
const UPDATE_CONFIG = 'src/vs/platform/update/common/update.config.contribution.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing: ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('升级只由手动入口触发（VS Code 自动更新必须关）', () => {

	test('1) update.mode 的产品默认值必须是 manual（真源在配置注册表，不在 product.json）', () => {
		const src = read(UPDATE_CONFIG);

		const at = src.indexOf("'update.mode': {");
		assert.ok(at > 0, '找不到 update.mode 的配置注册 ✗');
		const block = src.slice(at, src.indexOf("'update.channel'", at));
		assert.ok(block.length > 100, '切出来的 update.mode 配置块不对（找不到 update.channel 边界）✗');

		assert.match(block, /default:\s*'manual'/,
			"update.mode 的默认值必须是 'manual' —— 否则启动 30s 后自动检查、Ready 后弹通知/徽章（用户明确不要）✗");
		assert.ok(!/default:\s*'default'/.test(block),
			"不许再留 default: 'default'（那是自动检查 + 自动下载）✗");
	});

	test('1b) product.json 里不许再放 update 段（死字段：写了不生效，只会误导后人）', () => {
		const product = JSON.parse(read(PRODUCT)) as { update?: unknown };
		assert.strictEqual(product.update, undefined,
			'product.json 的 update 段没有任何代码读取（IProductConfiguration 无该字段）——'
			+ '要关自动更新请改 update.config.contribution.ts 的 default ✓');
	});

	test('2) 顶层 updateUrl 必须还在（不许动下载源）', () => {
		const product = JSON.parse(read(PRODUCT)) as { updateUrl?: string };
		assert.ok(product.updateUrl,
			'顶层 updateUrl 不许删 —— 删了 VS Code 会退回官方默认源，'
			+ '点「一键升级」可能下载官方 VS Code ✗✗');
		assert.ok(/^https?:\/\//.test(product.updateUrl), 'updateUrl 必须是我们自己的源');
	});
});
