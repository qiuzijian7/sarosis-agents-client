/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool Search Dispatcher 测试 — 对齐 Hermes-Agent `tests/tools/test_tool_search.py`。
 *
 * 覆盖：
 *   - searchCatalog: BM25 检索 + substring fallback
 *   - dispatchToolSearch: tool_search 完整流程
 *   - dispatchToolDescribe: tool_describe 完整流程
 *   - resolveUnderlyingCall: tool_call 参数解析
 *   - isToolInScope: scope 门控
 *   - buildDispatcherContext: 上下文构建
 *   - dispatchBridgeTool: 集成（end-to-end）
 */

import assert from 'assert';
import { IToolDefinition } from '../../common/providers.js';
import { IAssemblyResult, DEFAULT_TOOL_SEARCH_CONFIG, IToolSearchConfig } from '../../common/toolSearchAssembler.js';
import {
	searchCatalog,
	dispatchToolSearch,
	dispatchToolDescribe,
	resolveUnderlyingCall,
	isToolInScope,
	buildDispatcherContext,
	dispatchBridgeTool,
} from '../../common/toolSearchDispatcher.js';

// ─── 测试辅助工具 ──────────────────────────────────────────────────────────

function makeDef(name: string, description: string, inputSchemaProperties?: Record<string, unknown>): IToolDefinition & { enabled: boolean } {
	return {
		name,
		description,
		inputSchema: {
			type: 'object',
			properties: inputSchemaProperties ?? { arg: { type: 'string' } },
		},
		category: 'utility',
		enabled: true,
	};
}

function makeAssembly(
	deferredDefs: Array<IToolDefinition & { enabled: boolean }>,
	overrides?: Partial<IAssemblyResult>,
): IAssemblyResult {
	return {
		activated: true,
		toolDefs: [],
		deferredCount: deferredDefs.length,
		deferredTokens: 1000,
		thresholdTokens: 20000,
		deferredDefs,
		...overrides,
	};
}

// ─── searchCatalog ──────────────────────────────────────────────────────────

suite('ToolSearchDispatcher — searchCatalog', () => {

	const tools = [
		makeDef('kanban_create', 'Create a kanban card'),
		makeDef('kanban_list', 'List all kanban cards'),
		makeDef('browser_navigate', 'Navigate to a URL'),
		makeDef('browser_snapshot', 'Take a page snapshot'),
		makeDef('memory_search', 'Search memory by keyword'),
	];

	test('returns matching tools for exact name query', () => {
		const catalog = tools.map(t => ({
			name: t.name,
			description: t.description ?? '',
			schema: t,
			tokens: (t.name + ' ' + (t.description ?? '')).toLowerCase().match(/[A-Za-z0-9]+/g) ?? [],
		}));
		const hits = searchCatalog(catalog, 'kanban', 5);
		assert.ok(hits.length >= 1);
		assert.ok(hits.every(h => h.name.startsWith('kanban_')));
	});

	test('returns matching tools for description query', () => {
		const catalog = tools.map(t => ({
			name: t.name,
			description: t.description ?? '',
			schema: t,
			tokens: (t.name + ' ' + (t.description ?? '')).toLowerCase().match(/[A-Za-z0-9]+/g) ?? [],
		}));
		const hits = searchCatalog(catalog, 'URL', 5);
		assert.ok(hits.length >= 1);
		assert.ok(hits.some(h => h.name === 'browser_navigate'));
	});

	test('respects limit', () => {
		const catalog = tools.map(t => ({
			name: t.name,
			description: t.description ?? '',
			schema: t,
			tokens: (t.name + ' ' + (t.description ?? '')).toLowerCase().match(/[A-Za-z0-9]+/g) ?? [],
		}));
		const hits = searchCatalog(catalog, 'kanban', 1);
		assert.strictEqual(hits.length, 1);
	});

	test('returns empty for no match', () => {
		const catalog = tools.map(t => ({
			name: t.name,
			description: t.description ?? '',
			schema: t,
			tokens: (t.name + ' ' + (t.description ?? '')).toLowerCase().match(/[A-Za-z0-9]+/g) ?? [],
		}));
		const hits = searchCatalog(catalog, 'nonexistent', 5);
		assert.strictEqual(hits.length, 0);
	});

	test('returns empty for empty catalog', () => {
		const hits = searchCatalog([], 'anything', 5);
		assert.strictEqual(hits.length, 0);
	});

	test('returns empty for limit <= 0', () => {
		const catalog = tools.map(t => ({
			name: t.name,
			description: t.description ?? '',
			schema: t,
			tokens: [],
		}));
		assert.strictEqual(searchCatalog(catalog, 'kanban', 0).length, 0);
		assert.strictEqual(searchCatalog(catalog, 'kanban', -1).length, 0);
	});

	test('substring fallback works when BM25 gives zero', () => {
		// All tokens empty → BM25 always 0 → falls back to substring
		const catalog = tools.map(t => ({
			name: t.name,
			description: t.description ?? '',
			schema: t,
			tokens: [],  // empty tokens → BM25 = 0
		}));
		const hits = searchCatalog(catalog, 'kanban', 5);
		assert.ok(hits.length >= 1);
		assert.ok(hits.every(h => h.name.includes('kanban')));
	});
});

// ─── dispatchToolSearch ────────────────────────────────────────────────────

suite('ToolSearchDispatcher — dispatchToolSearch', () => {

	const defs = [
		makeDef('kanban_create', 'Create a kanban card with title and description'),
		makeDef('kanban_list', 'List kanban cards with optional filters'),
		makeDef('browser_navigate', 'Navigate browser to a URL'),
	];
	const catalog = defs.map(t => ({
		name: t.name,
		description: t.description ?? '',
		schema: t,
		tokens: (t.name + ' ' + (t.description ?? '')).toLowerCase().match(/[A-Za-z0-9]+/g) ?? [],
	}));

	test('returns error for empty query', () => {
		const result = dispatchToolSearch({ query: '' }, catalog, DEFAULT_TOOL_SEARCH_CONFIG);
		assert.strictEqual(result.success, false);
		assert.ok(result.text.includes('Error'));
	});

	test('returns results for valid query', () => {
		const result = dispatchToolSearch({ query: 'kanban' }, catalog, DEFAULT_TOOL_SEARCH_CONFIG);
		assert.strictEqual(result.success, true);
		assert.ok(result.text.includes('Found'));
		assert.ok(result.text.includes('kanban_create'));
	});

	test('returns empty for non-matching query', () => {
		const result = dispatchToolSearch({ query: 'github' }, catalog, DEFAULT_TOOL_SEARCH_CONFIG);
		assert.strictEqual(result.success, true);
		assert.ok(result.text.includes('No tools found'));
	});

	test('respects limit parameter', () => {
		const result = dispatchToolSearch({ query: 'kanban', limit: 1 }, catalog, DEFAULT_TOOL_SEARCH_CONFIG);
		assert.strictEqual(result.success, true);
		// Only 1 result line
		const lines = result.text.split('\n').filter(l => l.startsWith('  - '));
		assert.strictEqual(lines.length, 1);
	});

	test('limit clamped to maxSearchLimit', () => {
		const result = dispatchToolSearch(
			{ query: 'kanban', limit: 999 },
			catalog,
			{ ...DEFAULT_TOOL_SEARCH_CONFIG, maxSearchLimit: 20 },
		);
		assert.strictEqual(result.success, true);
	});
});

// ─── dispatchToolDescribe ──────────────────────────────────────────────────

suite('ToolSearchDispatcher — dispatchToolDescribe', () => {

	const defs = [
		makeDef('kanban_create', 'Create a kanban card', { title: { type: 'string' }, column: { type: 'string' } }),
	];
	const catalog = defs.map(t => ({
		name: t.name,
		description: t.description ?? '',
		schema: t,
		tokens: [],
	}));

	test('returns error for empty name', () => {
		const result = dispatchToolDescribe({ name: '' }, catalog);
		assert.strictEqual(result.success, false);
		assert.ok(result.text.includes('Error'));
	});

	test('returns schema for valid tool', () => {
		const result = dispatchToolDescribe({ name: 'kanban_create' }, catalog);
		assert.strictEqual(result.success, true);
		assert.ok(result.text.includes('kanban_create'));
		assert.ok(result.text.includes('Create a kanban card'));
		assert.ok(result.text.includes('title'));
		assert.ok(result.text.includes('column'));
	});

	test('returns error for unknown tool', () => {
		const result = dispatchToolDescribe({ name: 'unknown_tool' }, catalog);
		assert.strictEqual(result.success, false);
		assert.ok(result.text.includes('not found'));
	});
});

// ─── resolveUnderlyingCall ─────────────────────────────────────────────────

suite('ToolSearchDispatcher — resolveUnderlyingCall', () => {

	test('returns error for empty name', () => {
		const result = resolveUnderlyingCall({ name: '' });
		assert.strictEqual(result.underlyingName, null);
		assert.ok(result.error?.includes('name'));
	});

	test('rejects bridge tool names', () => {
		const result = resolveUnderlyingCall({ name: 'tool_search', arguments: {} });
		assert.strictEqual(result.underlyingName, null);
		assert.ok(result.error?.includes('bridge tool'));
	});

	test('parses valid name + args', () => {
		const result = resolveUnderlyingCall({ name: 'kanban_create', arguments: { title: 'Task' } });
		assert.strictEqual(result.underlyingName, 'kanban_create');
		assert.deepStrictEqual(result.underlyingArgs, { title: 'Task' });
		assert.strictEqual(result.error, null);
	});

	test('handles missing arguments', () => {
		const result = resolveUnderlyingCall({ name: 'kanban_create' });
		assert.strictEqual(result.underlyingName, 'kanban_create');
		assert.deepStrictEqual(result.underlyingArgs, {});
		assert.strictEqual(result.error, null);
	});

	test('handles JSON string arguments', () => {
		const result = resolveUnderlyingCall({ name: 'kanban_create', arguments: '{"title":"Test"}' });
		assert.strictEqual(result.underlyingName, 'kanban_create');
		assert.deepStrictEqual(result.underlyingArgs, { title: 'Test' });
	});

	test('returns error for invalid JSON string arguments', () => {
		const result = resolveUnderlyingCall({ name: 'kanban_create', arguments: 'not-json' });
		assert.strictEqual(result.underlyingName, null);
		assert.ok(result.error?.includes('JSON'));
	});

	test('rejects array arguments', () => {
		const result = resolveUnderlyingCall({ name: 'kanban_create', arguments: ['invalid'] });
		assert.strictEqual(result.underlyingName, null);
		assert.ok(result.error?.includes('object'));
	});
});

// ─── isToolInScope ─────────────────────────────────────────────────────────

suite('ToolSearchDispatcher — isToolInScope', () => {

	const scoped = new Set(['kanban_create', 'kanban_list', 'browser_navigate']);

	test('returns true for in-scope tool', () => {
		assert.strictEqual(isToolInScope('kanban_create', scoped), true);
	});

	test('returns false for out-of-scope tool', () => {
		assert.strictEqual(isToolInScope('delegate_task', scoped), false);
	});

	test('returns false for empty set', () => {
		assert.strictEqual(isToolInScope('kanban_create', new Set()), false);
	});
});

// ─── buildDispatcherContext ────────────────────────────────────────────────

suite('ToolSearchDispatcher — buildDispatcherContext', () => {

	test('builds context with scoped names', () => {
		const deferredDefs = [
			makeDef('kanban_create', 'Create card'),
			makeDef('kanban_list', 'List cards'),
		];
		const assembly = makeAssembly(deferredDefs, { deferredDefs } as any);
		const ctx = buildDispatcherContext(assembly, DEFAULT_TOOL_SEARCH_CONFIG);
		assert.strictEqual(ctx.assembly, assembly);
		assert.strictEqual(ctx.config, DEFAULT_TOOL_SEARCH_CONFIG);
		assert.strictEqual(ctx.scopedNames.size, 2);
		assert.ok(ctx.scopedNames.has('kanban_create'));
	});
});

// ─── dispatchBridgeTool (集成) ──────────────────────────────────────────────

suite('ToolSearchDispatcher — dispatchBridgeTool', () => {

	const deferredDefs = [
		makeDef('kanban_create', 'Create a kanban card', { title: { type: 'string' } }),
		makeDef('kanban_list', 'List kanban cards'),
		makeDef('browser_navigate', 'Navigate to a URL', { url: { type: 'string' } }),
	];
	const ctx = buildDispatcherContext(
		makeAssembly(deferredDefs, { deferredDefs } as any),
		DEFAULT_TOOL_SEARCH_CONFIG,
	);

	test('tool_search → type search', () => {
		const result = dispatchBridgeTool('tool_search', { query: 'kanban' }, ctx);
		assert.strictEqual(result.type, 'search');
		assert.strictEqual(result.success, true);
		assert.ok(result.text?.includes('kanban_create'));
	});

	test('tool_describe → type describe', () => {
		const result = dispatchBridgeTool('tool_describe', { name: 'kanban_create' }, ctx);
		assert.strictEqual(result.type, 'describe');
		assert.strictEqual(result.success, true);
		assert.ok(result.text?.includes('title'));
	});

	test('tool_describe unknown tool → type call_error', () => {
		const result = dispatchBridgeTool('tool_describe', { name: 'nonexistent' }, ctx);
		assert.strictEqual(result.type, 'describe');
		assert.strictEqual(result.success, false);
	});

	test('tool_call valid → type call_resolved', () => {
		const result = dispatchBridgeTool('tool_call', { name: 'kanban_create', arguments: { title: 'Task' } }, ctx);
		assert.strictEqual(result.type, 'call_resolved');
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.underlyingName, 'kanban_create');
		assert.deepStrictEqual(result.underlyingArgs, { title: 'Task' });
	});

	test('tool_call out-of-scope → type call_error', () => {
		const result = dispatchBridgeTool('tool_call', { name: 'delegate_task', arguments: {} }, ctx);
		assert.strictEqual(result.type, 'call_error');
		assert.strictEqual(result.success, false);
		assert.ok(result.text?.includes('not available'));
	});

	test('tool_call bridge tool → type call_error', () => {
		const result = dispatchBridgeTool('tool_call', { name: 'tool_search', arguments: {} }, ctx);
		assert.strictEqual(result.type, 'call_error');
		assert.strictEqual(result.success, false);
		assert.ok(result.text?.includes('bridge tool'));
	});

	test('unknown bridge tool → type call_error', () => {
		const result = dispatchBridgeTool('unknown_tool', {}, ctx);
		assert.strictEqual(result.type, 'call_error');
		assert.strictEqual(result.success, false);
	});
});
