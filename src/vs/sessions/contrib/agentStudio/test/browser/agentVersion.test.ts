/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 版本管理纯函数单元测试。
 *
 * 覆盖点：
 *   1. parseUnifiedDiff — unified diff 解析为结构化 hunks
 *   2. simpleDiff — 逐行简单 diff
 *   3. AgentCommitMeta / AgentDiffResult 类型契约
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseUnifiedDiff, simpleDiff } from '../../browser/agentVersionService.js';
import type { AgentCommitMeta, AgentDiffResult, AgentDiffHunk } from '../../common/agentVersionTypes.js';

suite('Agent Studio - Agent Version Management', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseUnifiedDiff', () => {

		test('空 diff → 空 hunks', () => {
			const result = parseUnifiedDiff('');
			assert.strictEqual(result.length, 0);
		});

		test('无 hunk header 的 diff → 空 hunks', () => {
			const diff = `+ line 1\n- line 2\n  unchanged`;
			const result = parseUnifiedDiff(diff);
			assert.strictEqual(result.length, 0, 'lines without hunk header are ignored');
		});

		test('单 hunk — add + remove + context', () => {
			const diff = [
				'@@ -1,3 +1,3 @@',
				' unchanged line',
				'-removed line',
				'+added line',
				' still unchanged',
			].join('\n');

			const result = parseUnifiedDiff(diff);
			assert.strictEqual(result.length, 1);
			const hunk = result[0];
			assert.strictEqual(hunk.oldStart, 1);
			assert.strictEqual(hunk.oldLines, 3);
			assert.strictEqual(hunk.newStart, 1);
			assert.strictEqual(hunk.newLines, 3);
			assert.strictEqual(hunk.lines.length, 4);

			assert.strictEqual(hunk.lines[0].kind, 'context');
			assert.strictEqual(hunk.lines[0].text, ' unchanged line');
			assert.strictEqual(hunk.lines[1].kind, 'remove');
			assert.strictEqual(hunk.lines[1].text, 'removed line');
			assert.strictEqual(hunk.lines[2].kind, 'add');
			assert.strictEqual(hunk.lines[2].text, 'added line');
			assert.strictEqual(hunk.lines[3].kind, 'context');
			assert.strictEqual(hunk.lines[3].text, ' still unchanged');
		});

		test('多 hunk — 正确分离', () => {
			const diff = [
				'@@ -1,2 +1,2 @@',
				' line1',
				'-line2-old',
				'+line2-new',
				'@@ -5,2 +5,2 @@',
				' line5',
				' line6',
			].join('\n');

			const result = parseUnifiedDiff(diff);
			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].lines.length, 3);
			assert.strictEqual(result[1].lines.length, 2);
		});

		test('仅新增行的 diff', () => {
			const diff = [
				'@@ -0,0 +1,3 @@',
				'+new line 1',
				'+new line 2',
				'+new line 3',
			].join('\n');

			const result = parseUnifiedDiff(diff);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].oldStart, 0);
			assert.strictEqual(result[0].oldLines, 0);
			assert.strictEqual(result[0].lines.length, 3);
			assert.strictEqual(result[0].lines[0].kind, 'add');
		});

		test('仅删除行的 diff', () => {
			const diff = [
				'@@ -1,3 +0,0 @@',
				'-deleted line 1',
				'-deleted line 2',
				'-deleted line 3',
			].join('\n');

			const result = parseUnifiedDiff(diff);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].newLines, 0);
			assert.strictEqual(result[0].lines[0].kind, 'remove');
		});
	});

	suite('simpleDiff', () => {

		test('相同内容 → 全 context', () => {
			const old = 'line1\nline2\nline3';
			const result = simpleDiff(old, old);
			assert.ok(!result.includes('- '), 'should have no deletions');
			assert.ok(!result.includes('+ '), 'should have no additions');
			assert.ok(result.includes('  line1'));
			assert.ok(result.includes('  line2'));
		});

		test('新增行 → + 标记', () => {
			const old = 'line1';
			const newText = 'line1\nline2';
			const result = simpleDiff(old, newText);
			assert.ok(result.includes('+ line2'));
		});

		test('删除行 → - 标记', () => {
			const old = 'line1\nline2';
			const newText = 'line1';
			const result = simpleDiff(old, newText);
			assert.ok(result.includes('- line2'));
		});

		test('修改行 → - 旧 + 新', () => {
			const old = 'line1\nold line';
			const newText = 'line1\nnew line';
			const result = simpleDiff(old, newText);
			assert.ok(result.includes('- old line'));
			assert.ok(result.includes('+ new line'));
		});
	});

	suite('AgentCommitMeta — 类型契约', () => {

		test('AgentCommitMeta 包含所有必需字段', () => {
			const meta: AgentCommitMeta = {
				sha: 'abc1234567890defabc1234567890defabc12345',
				shortSha: 'abc1234',
				message: 'auto: 2026-07-18 21:00:00',
				author: 'Sarosis Agent',
				time: '2026-07-18T21:00:00.000Z',
			};
			assert.strictEqual(meta.sha.length, 41);
			assert.strictEqual(meta.shortSha.length, 7);
			assert.ok(meta.message.includes('auto:'));
			assert.strictEqual(meta.author, 'Sarosis Agent');
			assert.ok(meta.time.endsWith('Z'));
		});

		test('AgentDiffResult 包含所有必需字段', () => {
			const result: AgentDiffResult = {
				fromSha: 'abc1234',
				toSha: 'def5678',
				hunks: [],
				unified: '--- .agent.md\n+++ .agent.md\n',
			};
			assert.strictEqual(result.fromSha.length, 7);
			assert.strictEqual(result.toSha.length, 7);
			assert.strictEqual(result.hunks.length, 0);
			assert.ok(result.unified.includes('.agent.md'));
		});

		test('AgentDiffHunk 包含行级别变更', () => {
			const hunk: AgentDiffHunk = {
				oldStart: 1, oldLines: 3,
				newStart: 1, newLines: 4,
				lines: [
					{ kind: 'context', text: 'unchanged' },
					{ kind: 'remove', text: 'removed' },
					{ kind: 'add', text: 'added' },
				],
			};
			assert.strictEqual(hunk.oldLines, 3);
			assert.strictEqual(hunk.newLines, 4);
			assert.strictEqual(hunk.lines.length, 3);
			assert.strictEqual(hunk.lines[1].kind, 'remove');
			assert.strictEqual(hunk.lines[2].kind, 'add');
		});
	});
});
