/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CHECKPOINT_DIFF_SCHEME, CheckpointDiffStore } from '../../browser/checkpointDiffContentProvider.js';

suite('CheckpointDiffStore — 检查点 diff 虚拟文档存储（2026-09-12，P2-2）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ register 返回自定义 scheme 的 URI，且能按 URI 取回内容', () => {
		const store = new CheckpointDiffStore();
		const uri = store.register('a.ts', 'const a = 1;');
		assert.strictEqual(uri.scheme, CHECKPOINT_DIFF_SCHEME);
		assert.strictEqual(store.get(uri), 'const a = 1;');
	});

	test('★ 每次 register 生成唯一 URI —— 同名文件互不覆盖（取代原「snapshotId 子目录」）', () => {
		const store = new CheckpointDiffStore();
		const u1 = store.register('a.ts', 'v1');
		const u2 = store.register('a.ts', 'v2');
		assert.notStrictEqual(u1.toString(), u2.toString());
		assert.strictEqual(store.get(u1), 'v1');
		assert.strictEqual(store.get(u2), 'v2');
	});

	test('★ beginBatch 清空上一批（防内存随打开次数无限增长）', () => {
		const store = new CheckpointDiffStore();
		const u1 = store.register('a.ts', 'v1');
		assert.strictEqual(store.size, 1);
		store.beginBatch();
		assert.strictEqual(store.size, 0);
		assert.strictEqual(store.get(u1), undefined, '清理后旧 URI 取不到内容（已打开的 diff 靠已 acquire 的 model 不受影响）');
	});

	test('★ 文件名净化：路径只取末段（防 URI path 被路径分隔符污染）', () => {
		const store = new CheckpointDiffStore();
		const uri = store.register('g:\\repo\\src\\a.ts', 'x');
		assert.ok(uri.path.endsWith('/a.ts'), uri.path);
		assert.ok(!uri.path.includes('repo'), uri.path);
	});

	test('未知 URI → undefined（provider 据此返回 null，而非静默空白）', () => {
		const store = new CheckpointDiffStore();
		assert.strictEqual(store.get(URI.parse(`${CHECKPOINT_DIFF_SCHEME}:/nope/a.ts`)), undefined);
	});
});
