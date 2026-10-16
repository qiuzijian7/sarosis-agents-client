/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力请求**认领簿**的单元测试。
 *
 * 守的是什么（真缺陷）：`OnIdeRequest` 是广播，每个窗口都有一份 `DshHarnessService`。
 * 没有认领时同一请求会被**执行 N 次**（`browser.click` 点 N 下、`canvas.apply_ops` 弹 N 个确认框），
 * 而只有第一个回执被采纳——副作用已经发生过了。这里把"只放行一个"这条语义钉死：
 * 先到先得、认领过的再认领拿不到、请求结束后可重新认领（id 单调递增，但释放语义要明确）。
 */

import assert from 'assert';
import { IdeRequestClaims } from '../../common/dshIdeClaims.js';

suite('dshHarness / IDE request claims（多窗口只执行一次）', () => {

	test('★ 先到先得：同一个 id 只有第一个认领者拿到执行权', () => {
		const claims = new IdeRequestClaims();
		assert.strictEqual(claims.claim(7), true, '第一个认领者应拿到');
		assert.strictEqual(claims.claim(7), false, '第二个（另一个窗口）必须拿不到 ⇒ 不执行、不回执');
		assert.strictEqual(claims.claim(7), false, '重复认领同样拿不到');
		assert.strictEqual(claims.size, 1, '只记一条');
	});

	test('不同请求互不影响（各窗口各自认领各自的那次）', () => {
		const claims = new IdeRequestClaims();
		assert.strictEqual(claims.claim(1), true);
		assert.strictEqual(claims.claim(2), true);
		assert.strictEqual(claims.size, 2);
	});

	test('请求结束（回执 / 超时）后释放：同一个 id 不再占位', () => {
		const claims = new IdeRequestClaims();
		claims.claim(9);
		claims.release(9);
		assert.strictEqual(claims.size, 0, '释放后不该再有记录（否则集合会无限增长）');
		assert.strictEqual(claims.claim(9), true, '释放后可以再认领（例如重试同一条请求）');
		claims.release(12345); // 释放不存在的 id 不应抛
	});

	test('clear：Host 重启 / 通道重建后清空（旧 id 不会再回来）', () => {
		const claims = new IdeRequestClaims();
		claims.claim(1);
		claims.claim(2);
		claims.clear();
		assert.strictEqual(claims.size, 0);
		assert.strictEqual(claims.claim(1), true);
	});
});
