/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { StructuredOutputParser, TASK_DECOMPOSITION_SCHEMA } from '../../browser/structuredOutputParser';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils';

// Minimal mock ILogService
class MockLogService {
	info(_msg: string) { }
	warn(_msg: string) { }
	error(_msg: string) { }
	trace(_msg: string) { }
	debug(_msg: string) { }
}

suite('StructuredOutputParser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const parser = new StructuredOutputParser(new MockLogService() as any);

	// ─── JSON Extraction Strategies ────────────────────────────────────────

	test('Strategy 1: extracts JSON from markdown code block', () => {
		const response = 'Here is the plan:\n```json\n{"tasks": []}\n```\nThat should work!';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
		assert.ok(Array.isArray((result.data as Record<string, unknown>).tasks));
	});

	test('Strategy 1: extracts from untyped code block', () => {
		const response = '```\n{"tasks": [{"id": "1", "title": "Test"}]}\n```';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
	});

	test('Strategy 2: extracts JSON that starts after preamble text', () => {
		const response = 'Sure! Here is the JSON:\n{"tasks": [{"id": "1", "title": "Test", "suggestedRole": "Dev"}]}';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
		assert.strictEqual((result.data as { tasks: unknown[] }).tasks.length, 1);
	});

	test('Strategy 3: extracts JSON embedded in middle of text', () => {
		const response = 'Let me analyze this.\n\n{"tasks": [{"id": "1", "title": "Build API"}]}\n\nHope this helps!';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
	});

	test('Strategy 4: extracts JSON by known key when no brackets at start', () => {
		const response = 'Analysis done.\n{"subtasks": [{"id": "1", "title": "Task 1"}]}';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		// "subtasks" is an alias for "tasks"
		assert.strictEqual(result.success, true);
	});

	test('returns failure when no JSON can be extracted', () => {
		const response = 'This is just plain text with no JSON at all.';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, false);
		assert.ok(result.errors.length > 0);
	});

	// ─── JSON Repair ───────────────────────────────────────────────────────

	test('fixes trailing commas in JSON', () => {
		const response = '```json\n{"tasks": [{"id": "1", "title": "Test",},]}\n```';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
	});

	test('fixes single-line comments in JSON', () => {
		const response = '```json\n{\n  // This is a comment\n  "tasks": []\n}\n```';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
	});

	test('fixes Python-style booleans', () => {
		const response = '{"tasks": [{"id": "1", "title": "Test", "priority": True}]}';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
	});

	test('fixes single quotes to double quotes', () => {
		const response = "{'tasks': [{'id': '1', 'title': 'Test'}]}";
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
	});

	test('fixes unescaped newlines in string values', () => {
		const response = '{"tasks": [{"id": "1", "title": "Line1\nLine2"}]}';
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		assert.strictEqual(result.success, true);
	});

	// ─── Field Normalization (alias mapping) ───────────────────────────────

	test('normalizes "subtasks" alias to "tasks"', () => {
		const response = '{"subtasks": [{"id": "1", "title": "Test"}]}';
		const result = parser.parseTaskDecomposition(response);
		assert.strictEqual(result.tasks.length, 1);
		assert.strictEqual(result.tasks[0].id, '1');
	});

	test('normalizes "task_name" alias to "title"', () => {
		const response = '{"tasks": [{"id": "1", "task_name": "My Task"}]}';
		const result = parser.parseTaskDecomposition(response);
		assert.strictEqual(result.tasks[0].title, 'My Task');
	});

	test('normalizes "deps" alias to "dependencies"', () => {
		const response = '{"tasks": [{"id": "1", "title": "T1", "deps": ["2"]}]}';
		const result = parser.parseTaskDecomposition(response);
		assert.deepStrictEqual(result.tasks[0].dependencies, ['2']);
	});

	// ─── Default Values ────────────────────────────────────────────────────

	test('applies default values for missing optional fields', () => {
		const response = '{"tasks": [{"id": "1", "title": "Minimal Task"}]}';
		const result = parser.parseTaskDecomposition(response);
		assert.strictEqual(result.tasks[0].suggestedRole, 'Software Developer');
		assert.strictEqual(result.tasks[0].suggestedAssignee, '');
		assert.deepStrictEqual(result.tasks[0].dependencies, []);
		assert.strictEqual(result.tasks[0].priority, 2);
	});

	// ─── Phases unwrapping ─────────────────────────────────────────────────

	test('unwraps phases structure into flat tasks array', () => {
		const response = JSON.stringify({
			phases: [
				{ name: 'Phase 1', tasks: [{ id: '1', title: 'Task A' }] },
				{ name: 'Phase 2', tasks: [{ id: '2', title: 'Task B' }] },
			],
		});
		const result = parser.parseTaskDecomposition(response);
		assert.strictEqual(result.tasks.length, 2);
		assert.strictEqual(result.tasks[0].title, 'Task A');
		assert.strictEqual(result.tasks[1].title, 'Task B');
	});

	// ─── Type Coercion ─────────────────────────────────────────────────────

	test('coerces string priority to number', () => {
		const response = '{"tasks": [{"id": "1", "title": "Test", "priority": "5"}]}';
		const result = parser.parseTaskDecomposition(response);
		assert.strictEqual(result.tasks[0].priority, 5);
	});

	test('coerces single string dependency to array', () => {
		const response = '{"tasks": [{"id": "1", "title": "Test", "dependencies": "2"}]}';
		const result = parser.parseTaskDecomposition(response);
		assert.deepStrictEqual(result.tasks[0].dependencies, ['2']);
	});

	// ─── Edge Cases ────────────────────────────────────────────────────────

	test('handles empty tasks array', () => {
		const response = '{"tasks": []}';
		const result = parser.parseTaskDecomposition(response);
		assert.strictEqual(result.tasks.length, 0);
	});

	test('handles very long response without catastrophic backtracking', () => {
		const longPreamble = 'A'.repeat(5000);
		const response = `${longPreamble}\n\`\`\`json\n{"tasks": [{"id": "1", "title": "Test"}]}\n\`\`\``;
		const start = Date.now();
		const result = parser.parse(response, TASK_DECOMPOSITION_SCHEMA);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 1000, `Parsing took ${elapsed}ms, possibly catastrophic backtracking`);
		assert.strictEqual(result.success, true);
	});
});
