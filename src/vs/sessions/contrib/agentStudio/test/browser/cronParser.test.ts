/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── cronParser 单测（对齐 cc-connect cron.go 5 字段语义）──

import assert from 'assert';
import { cronMatches, parseCronExpr } from '../../browser/bridge/cronParser.js';

suite('cronParser', () => {
	test('every-minute matches any time', () => {
		assert.strictEqual(cronMatches('* * * * *', new Date(2026, 6, 12, 9, 15, 0)), true);
		assert.strictEqual(cronMatches('* * * * *', new Date(2026, 0, 1, 0, 0, 0)), true);
	});

	test('specific field match', () => {
		// 每天 6:00
		assert.strictEqual(cronMatches('0 6 * * *', new Date(2026, 6, 12, 6, 0, 0)), true);
		assert.strictEqual(cronMatches('0 6 * * *', new Date(2026, 6, 12, 6, 1, 0)), false);
		assert.strictEqual(cronMatches('0 6 * * *', new Date(2026, 6, 12, 7, 0, 0)), false);
	});

	test('step syntax */15 on minute', () => {
		assert.strictEqual(cronMatches('*/15 * * * *', new Date(2026, 6, 12, 9, 0, 0)), true);
		assert.strictEqual(cronMatches('*/15 * * * *', new Date(2026, 6, 12, 9, 15, 0)), true);
		assert.strictEqual(cronMatches('*/15 * * * *', new Date(2026, 6, 12, 9, 10, 0)), false);
	});

	test('range syntax 9-17 hour', () => {
		assert.strictEqual(cronMatches('0 9-17 * * *', new Date(2026, 6, 12, 12, 0, 0)), true);
		assert.strictEqual(cronMatches('0 9-17 * * *', new Date(2026, 6, 12, 18, 0, 0)), false);
	});

	test('list syntax', () => {
		assert.strictEqual(cronMatches('0 9,12,18 * * *', new Date(2026, 6, 12, 12, 0, 0)), true);
		assert.strictEqual(cronMatches('0 9,12,18 * * *', new Date(2026, 6, 12, 13, 0, 0)), false);
	});

	test('day-of-week: Sunday via 0 and 7', () => {
		// 2026-07-12 是周日
		const sunday = new Date(2026, 6, 12, 9, 0, 0);
		assert.strictEqual(cronMatches('0 9 * * 0', sunday), true);
		assert.strictEqual(cronMatches('0 9 * * 7', sunday), true);
		assert.strictEqual(cronMatches('0 9 * * 1', sunday), false);
	});

	test('dom and dow OR-relation when both set', () => {
		// dom=15 或 dow=1(周一) 命中
		assert.strictEqual(cronMatches('0 9 15 * 1', new Date(2026, 6, 13, 9, 0, 0)), true); // 周一
		assert.strictEqual(cronMatches('0 9 15 * 1', new Date(2026, 6, 15, 9, 0, 0)), true); // 15 号
		assert.strictEqual(cronMatches('0 9 15 * 1', new Date(2026, 6, 14, 9, 0, 0)), false); // 周二且非15
	});

	test('invalid expr throws', () => {
		assert.throws(() => parseCronExpr('0 6 * *'), /5 段/);
	});
});
