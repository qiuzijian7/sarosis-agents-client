/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	INDEX_LOCK_STALE_MS,
	createIndexLockToken,
	isIndexLockStale,
	parseIndexLock,
	serializeIndexLock,
} from '../../browser/codebaseIndexLock.js';

suite('codebaseIndexLock — 跨进程索引文件锁', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('serialize/parse round-trip', () => {
		const content = { token: 'default-abc-xyz', instanceId: '2', acquiredAt: 1722700000000 };
		const parsed = parseIndexLock(serializeIndexLock(content));
		assert.deepStrictEqual(parsed, content);
	});

	test('parse tolerates missing instanceId', () => {
		const parsed = parseIndexLock('{"token":"t","acquiredAt":1}');
		assert.strictEqual(parsed?.token, 't');
		assert.strictEqual(parsed?.instanceId, undefined);
	});

	test('parse returns undefined for invalid content', () => {
		assert.strictEqual(parseIndexLock(''), undefined);
		assert.strictEqual(parseIndexLock('not json'), undefined);
		assert.strictEqual(parseIndexLock('{"foo":1}'), undefined);
		assert.strictEqual(parseIndexLock('{"token":"t"}'), undefined); // 缺 acquiredAt
	});

	test('isIndexLockStale: fresh vs expired', () => {
		const now = 1000000;
		assert.strictEqual(isIndexLockStale(now - 1000, now), false); // 1s ago → 新鲜
		assert.strictEqual(isIndexLockStale(now - INDEX_LOCK_STALE_MS + 1, now), false); // 刚好未到阈值
		assert.strictEqual(isIndexLockStale(now - INDEX_LOCK_STALE_MS - 1, now), true); // 超过阈值 → 过期可接管
	});

	test('createIndexLockToken: uniqueness and format', () => {
		const t1 = createIndexLockToken('2');
		const t2 = createIndexLockToken('2');
		assert.notStrictEqual(t1, t2);
		assert.ok(t1.startsWith('2-'));
		assert.ok(createIndexLockToken(undefined).startsWith('default-'));
	});
});
