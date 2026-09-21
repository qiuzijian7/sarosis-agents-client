/*---------------------------------------------------------------------------------------------
 * Copyright (c) Sarosis. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `unifiedDiff` 回归测试（2026-09-21，P1-③：patch 回执附 unified diff）。
 *
 * 钉住四件事：
 *  1. **统计口径**（`+A/-R`）与实际改动一致（回执里的数字不能骗人）；
 *  2. hunk 头 `@@ -oldStart,oldLen +newStart,newLen @@` 正确 —— 纯插入也必须带尾随上下文
 *     （否则 diff 里看不出插入发生在哪）；
 *  3. 单 hunk + 上下文行数（默认 3）；
 *  4. 双闸上限（行/字符）与「绝不抛错」。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/unifiedDiff.test.ts
 */
import assert from 'assert';
import { buildUnifiedDiff, diffStat } from '../../common/unifiedDiff.js';

suite('unifiedDiff — diffStat', () => {

	test('相同内容 → 0/0；无差异时 diff 为空串', () => {
		assert.deepStrictEqual(diffStat('a\nb', 'a\nb'), { added: 0, removed: 0 });
		assert.strictEqual(buildUnifiedDiff('a\nb', 'a\nb'), '');
	});

	test('单行替换 → +1/-1', () => {
		assert.deepStrictEqual(diffStat('a\nold\nc', 'a\nnew\nc'), { added: 1, removed: 1 });
	});

	test('纯插入 → +N/-0；纯删除 → +0/-N（且**不受公共前后缀干扰**）', () => {
		assert.deepStrictEqual(diffStat('a\nb', 'a\nX\nY\nb'), { added: 2, removed: 0 });
		assert.deepStrictEqual(diffStat('a\nX\nY\nb', 'a\nb'), { added: 0, removed: 2 });
	});

	test('大段未变内容不计入统计（裁剪公共前后缀）', () => {
		const before = ['h1', 'h2', 'h3', 'old', 't1', 't2', 't3'].join('\n');
		const after = ['h1', 'h2', 'h3', 'new', 't1', 't2', 't3'].join('\n');
		assert.deepStrictEqual(diffStat(before, after), { added: 1, removed: 1 });
	});
});

suite('unifiedDiff — buildUnifiedDiff', () => {

	test('★★★ 单行替换：hunk 头 + 上下文 + -/+ 行', () => {
		const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
		const after = ['a', 'b', 'X', 'd', 'e'].join('\n');
		const d = buildUnifiedDiff(before, after);
		const lines = d.split('\n');
		assert.ok(lines[0].startsWith('@@ -1,5 +1,5 @@'), `hunk 头应为 @@ -1,5 +1,5 @@，got ${lines[0]}`);
		assert.deepStrictEqual(lines.slice(1), [' a', ' b', '-c', '+X', ' d', ' e']);
	});

	test('★★★ 纯插入必须带尾随上下文（否则看不出插在哪）', () => {
		const d = buildUnifiedDiff('a\nb', 'a\nX\nb');
		const lines = d.split('\n');
		assert.strictEqual(lines[0], '@@ -1,2 +1,3 @@');
		assert.deepStrictEqual(lines.slice(1), [' a', '+X', ' b']);
	});

	test('★★★ 纯删除：hunk 头长度两侧不同', () => {
		const d = buildUnifiedDiff('a\nX\nb', 'a\nb');
		const lines = d.split('\n');
		assert.strictEqual(lines[0], '@@ -1,3 +1,2 @@');
		assert.deepStrictEqual(lines.slice(1), [' a', '-X', ' b']);
	});

	test('★ 只输出**一个** hunk，且改动行号正确（大文件中部改动）', () => {
		const before = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n');
		const after = before.replace('L20', 'L20-changed');
		const d = buildUnifiedDiff(before, after);
		const lines = d.split('\n');
		assert.strictEqual(lines.filter(l => l.startsWith('@@')).length, 1, '只应有一个 hunk ✗');
		// 上下文各 3 行 ⇒ 起始行 = 20-3 = 17
		assert.strictEqual(lines[0], '@@ -17,7 +17,7 @@');
		assert.ok(d.includes('-L20') && d.includes('+L20-changed'));
		assert.ok(!d.includes('L1\n'), '远端未变行不得进入 diff ✗');
	});

	test('★ filePath 选项带 ---/+++ 头（且用 a//b/ 约定）', () => {
		const d = buildUnifiedDiff('a', 'b', { filePath: 'src/x.ts' });
		assert.ok(d.startsWith('--- a/src/x.ts\n+++ b/src/x.ts\n'), `头部不对：${d.split('\n').slice(0, 2).join(' | ')}`);
	});

	test('★ 行数上限：超限以 (diff truncated) 收尾（回执不得顶爆上下文）', () => {
		const before = Array.from({ length: 200 }, () => 'same').join('\n');
		const after = Array.from({ length: 200 }, () => 'different').join('\n');
		const d = buildUnifiedDiff(before, after, { maxLines: 10 });
		const lines = d.split('\n');
		assert.strictEqual(lines.length, 11, `应为 10 行 + 截断标记，got ${lines.length}`);
		assert.strictEqual(lines[lines.length - 1], '… (diff truncated) …');
	});

	test('★ 字符上限同样生效（且有下限，不会只剩截断标记）', () => {
		const before = 'x'.repeat(50);
		const after = 'y'.repeat(50);
		// 该 diff 全文 ≈ 120 字符（头 16 + -50 + +50 及换行）⇒ 限 100 必超
		const d = buildUnifiedDiff(before, after, { maxChars: 100 });
		assert.ok(d.endsWith('… (diff truncated) …'), '字符超限也要收尾标记 ✗');
		assert.ok(d.length <= 100 + '… (diff truncated) …'.length + 1);
		// 下限保护：传 1 也不会截成空壳（被抬到 40）
		assert.ok(buildUnifiedDiff(before, after, { maxChars: 1 }).length > 10,
			'过小的上限应被抬到下限，而不是产出空壳 ✗');
	});

	test('★ 无尾换行的文件也能 diff（末行差异）', () => {
		assert.deepStrictEqual(diffStat('a\nb', 'a\nb\n'), { added: 1, removed: 0 });
		assert.ok(buildUnifiedDiff('a\nb', 'a\nb\n').includes('+'));
	});
});
