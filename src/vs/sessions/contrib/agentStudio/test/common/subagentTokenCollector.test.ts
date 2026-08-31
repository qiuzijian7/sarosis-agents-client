/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { SubagentTokenCollector } from '../../common/subagentTokenCollector.js';

suite('SubagentTokenCollector', () => {
	test('cacheHitRate = totalCacheHitTokens / totalInputTokens', () => {
		const c = new SubagentTokenCollector();
		c.recordUsage({ inputTokens: 10, outputTokens: 4, cacheHitTokens: 3, cacheWriteTokens: 7 });
		c.recordUsage({ inputTokens: 20, outputTokens: 9, cacheHitTokens: 12, cacheWriteTokens: 8 });
		const u = c.getUsage();
		assert.strictEqual(u.totalInputTokens, 30);
		assert.strictEqual(u.totalCacheHitTokens, 15);
		assert.strictEqual(u.cacheHitRate, 0.5); // 15 / 30
	});

	test('cacheHitRate：totalInputTokens=0 时归零（非 NaN）', () => {
		const c = new SubagentTokenCollector();
		c.recordUsage({ inputTokens: 0, outputTokens: 4 });
		const u = c.getUsage();
		assert.strictEqual(u.cacheHitRate, 0);
		assert.ok(Number.isFinite(u.cacheHitRate));
	});

	test('reset 后 cacheHitRate 归零', () => {
		const c = new SubagentTokenCollector();
		c.recordUsage({ inputTokens: 10, outputTokens: 4, cacheHitTokens: 5 });
		c.reset();
		const u = c.getUsage();
		assert.strictEqual(u.cacheHitRate, 0);
		assert.strictEqual(u.turnCount, 0);
	});
});
