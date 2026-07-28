/*---------------------------------------------------------------------------------------------
 *  Unit tests for WorkflowVersionService pure functions:
 *   - parseUnifiedDiff  — structured diff hunk parsing
 *   - simpleDiff        — fallback line-by-line diff
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { parseUnifiedDiff, simpleDiff } from '../../browser/workflowVersionService.js';

suite('WorkflowVersionService — pure functions', () => {

	suite('simpleDiff', () => {

		test('identical content returns only context lines', () => {
			const result = simpleDiff('line1\nline2\n', 'line1\nline2\n');
			// All lines marked as context (leading "  ")
			for (const ln of result.split('\n').filter(Boolean)) {
				assert.ok(ln.startsWith('  '), `expected context line, got: ${ln}`);
			}
		});

		test('added lines are prefixed with +', () => {
			const result = simpleDiff('old\n', 'old\nnew\n');
			assert.ok(result.includes('+ new'));
		});

		test('removed lines are prefixed with -', () => {
			const result = simpleDiff('old\nremoved\n', 'old\n');
			assert.ok(result.includes('- removed'));
		});

		test('changed line shows both - and +', () => {
			const result = simpleDiff('before\nold\n', 'before\nnew\n');
			assert.ok(result.includes('- old'));
			assert.ok(result.includes('+ new'));
		});

		test('empty input', () => {
			const result = simpleDiff('', '');
			// empty diff falls through to a single context line
			assert.strictEqual(result.trim(), '');
		});
	});

	suite('parseUnifiedDiff', () => {

		const basicUnified = [
			'--- workflow.json\t(root)',
			'+++ workflow.json\t(abc1234)',
			'@@ -3,2 +3,3 @@',
			' context line',
			'-removed line',
			'+added line 1',
			'+added line 2',
		].join('\n');

		test('parses hunk header correctly', () => {
			const hunks = parseUnifiedDiff(basicUnified);
			assert.strictEqual(hunks.length, 1);
			assert.strictEqual(hunks[0].oldStart, 3);
			assert.strictEqual(hunks[0].oldLines, 2);
			assert.strictEqual(hunks[0].newStart, 3);
			assert.strictEqual(hunks[0].newLines, 3);
		});

		test('classifies context / add / remove lines', () => {
			const hunks = parseUnifiedDiff(basicUnified);
			const kinds = hunks[0].lines.map(l => l.kind);
			assert.deepStrictEqual(kinds, ['context', 'remove', 'add', 'add']);
		});

		test('preserves line text (stripped prefix)', () => {
			const hunks = parseUnifiedDiff(basicUnified);
			assert.strictEqual(hunks[0].lines[0].text, 'context line');
			assert.strictEqual(hunks[0].lines[1].text, 'removed line');
			assert.strictEqual(hunks[0].lines[2].text, 'added line 1');
		});

		test('multiple hunks', () => {
			const twoHunks = [
				'@@ -1,3 +1,3 @@',
				' one',
				'-two',
				'+TWO',
				'@@ -10,2 +10,3 @@',
				' ten',
				'+eleven',
				'+twelve',
			].join('\n');
			const hunks = parseUnifiedDiff(twoHunks);
			assert.strictEqual(hunks.length, 2);
			assert.strictEqual(hunks[1].oldStart, 10);
			assert.strictEqual(hunks[1].newStart, 10);
		});

		test('empty input returns no hunks', () => {
			const hunks = parseUnifiedDiff('');
			assert.strictEqual(hunks.length, 0);
		});

		test('no hunk headers returns no hunks', () => {
			const hunks = parseUnifiedDiff('just some text\nno hunk here\n');
			assert.strictEqual(hunks.length, 0);
		});
	});
});
