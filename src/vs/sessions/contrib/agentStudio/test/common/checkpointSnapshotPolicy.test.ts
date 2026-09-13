/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	MAX_SNAPSHOT_CONTENT_CHARS,
	describeSkippedSnapshots,
	shouldOmitSnapshotContent,
} from '../../common/checkpointSnapshotPolicy.js';

suite('checkpointSnapshotPolicy — 快照内容省略策略（2026-09-12，P2-3）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── shouldOmitSnapshotContent ───────────────────────────────────────────

	test('★ 普通文本（含中文）→ 不省略', () => {
		assert.strictEqual(shouldOmitSnapshotContent('const a = 1;\n'), false);
		assert.strictEqual(shouldOmitSnapshotContent('中文内容也很正常，不应被省略。'), false);
	});

	test('★ 超过阈值 → 省略', () => {
		assert.strictEqual(shouldOmitSnapshotContent('a'.repeat(MAX_SNAPSHOT_CONTENT_CHARS + 1)), true);
	});

	test('★ 恰好等于阈值 → 不省略（判定用 > 而非 >=）', () => {
		assert.strictEqual(shouldOmitSnapshotContent('a'.repeat(MAX_SNAPSHOT_CONTENT_CHARS)), false);
	});

	test('★ 含 NUL 字节（二进制特征）→ 省略', () => {
		assert.strictEqual(shouldOmitSnapshotContent('PNG\u0000\u0001\u0002data'), true);
	});

	test('★ NUL 落在采样窗口之外 → 不省略（只看开头 8KB，避免遍历大文件）', () => {
		assert.strictEqual(shouldOmitSnapshotContent('a'.repeat(9000) + '\u0000'), false);
	});

	test('空内容 → 不省略（新建空文件的快照要能正常写入）', () => {
		assert.strictEqual(shouldOmitSnapshotContent(''), false);
	});

	test('自定义阈值生效', () => {
		assert.strictEqual(shouldOmitSnapshotContent('abc', 2), true);
		assert.strictEqual(shouldOmitSnapshotContent('abc', 3), false);
	});

	// ─── describeSkippedSnapshots ────────────────────────────────────────────

	test('★ 生成含文件名的用户提示', () => {
		const note = describeSkippedSnapshots(['g:\\repo\\dist\\bundle.js']);
		assert.ok(note, '非空列表应产出提示');
		assert.ok(note!.includes('bundle.js'), note);
		assert.ok(note!.includes('1 个文件'), note);
		assert.ok(note!.includes('已跳过'), note);
	});

	test('★ 超过 5 个 → 折叠为「等 N 个文件」', () => {
		const files = Array.from({ length: 7 }, (_, i) => `g:/repo/f${i}.bin`);
		const note = describeSkippedSnapshots(files);
		assert.ok(note!.includes('等 7 个文件'), note);
	});

	test('空列表 → undefined（调用方不提示）', () => {
		assert.strictEqual(describeSkippedSnapshots([]), undefined);
	});
});
