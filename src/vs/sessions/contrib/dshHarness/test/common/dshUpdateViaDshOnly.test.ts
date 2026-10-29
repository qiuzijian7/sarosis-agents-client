/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「升级只走 dsh desktop 左下角入口，不许用 VS Code 的更新弹窗」的守卫（2026-10-29）。
 *
 * 用户要求：**app 升级用 dsh desktop 左下角的升级按钮触发，不要 VS Code 的弹出升级弹窗。**
 *
 * 为什么要配 `product.json`（而不是只改页面）：
 *   `product.json` 里原本**没有 `update` 段** ⇒ VS Code 用默认 `update.mode = "prompt"`
 *   ⇒ 它会**自己弹**「有可用更新」的通知 ⇒ 跟我们的左下角入口**抢**、且用户明确不要 ✗。
 *
 * ⚠ **只加 `update.mode`，不许动 `updateUrl`**：
 *   · 顶层 `updateUrl`（`http://zijianqiu-any1.devcloud.woa.com:3030`）是 VS Code updateService
 *     真正用的下载源（形态 `GET {updateUrl}/api/update/{platform}/{quality}/{commit}`，
 *     与 `build/saros/README.md` 写的一致 ✓）；
 *   · `mode: "manual"` 只是**不自动检查/不自动弹窗**；我们自己的 `upgradeApp()` 走
 *     `svc.checkForUpdates(true)`（force）⇒ **照样能检查、下载、升级** ✓；
 *   · 若把 `updateUrl` 改掉/删掉 ⇒ VS Code 会退回**官方默认源**
 *     （`update.code.visualstudio.com`）⇒ 点「一键升级」可能下载**官方 VS Code** ✗✗✠。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpdateViaDshOnly
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const PRODUCT = 'product.json';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('升级只走 dsh desktop 左下角入口', () => {

	test('1) product.json 必须把 VS Code 的更新模式设为 manual（不弹它自己的框）', () => {
		const product = JSON.parse(read(PRODUCT)) as {
			update?: { mode?: string };
			updateUrl?: string;
		};

		assert.ok(product.update, 'product.json 必须有 update 段（否则 VS Code 用默认 prompt ⇒ 会弹自己的更新框 ✗）');
		assert.strictEqual(product.update.mode, 'manual',
			'update.mode 必须是 manual —— 升级只由 dsh desktop 左下角入口触发，'
			+ 'VS Code 自己的「有可用更新」弹窗必须不再出现 ✗');
	});

	test('2) 顶层 updateUrl 必须还在（不许动下载源）', () => {
		const product = JSON.parse(read(PRODUCT)) as { updateUrl?: string };
		assert.ok(product.updateUrl,
			'顶层 updateUrl 不许删 —— 删了 VS Code 会退回官方默认源，'
			+ '点「一键升级」可能下载官方 VS Code ✗✗✠');
		assert.ok(/^https?:\/\//.test(product.updateUrl), 'updateUrl 必须是我们自己的源');
	});
});
