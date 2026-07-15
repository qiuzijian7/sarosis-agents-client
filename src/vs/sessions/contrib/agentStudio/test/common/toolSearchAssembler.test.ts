/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool Search Assembler 测试 — 对齐 Hermes-Agent `tests/tools/test_tool_search.py`。
 *
 * 覆盖：
 *   - estimateTokensFromSchemas: token 估算
 *   - isDeferrableTool: 可折叠判断
 *   - classifyTools: 工具分类
 *   - shouldActivate: threshold gate
 *   - bridgeToolSchemas: 桥接 schema 结构
 *   - assembleToolDefs: 集成
 *   - scopedDeferrableNames: scope 集合
 */

import assert from 'assert';
import { IToolDefinition } from '../../common/providers.js';
import {
	estimateTokensFromSchemas,
	isDeferrableTool,
	classifyTools,
	shouldActivate,
	bridgeToolSchemas,
	assembleToolDefs,
	scopedDeferrableNames,
	IToolSearchConfig,
	DEFAULT_TOOL_SEARCH_CONFIG,
} from '../../common/toolSearchAssembler.js';

// ─── 测试辅助工具 ──────────────────────────────────────────────────────────

function makeTool(name: string, description: string, category?: string, toolset?: string): IToolDefinition & { enabled: boolean } {
	return {
		name,
		description,
		inputSchema: { type: 'object', properties: { arg: { type: 'string' } } },
		category: category ?? 'utility',
		toolset,
		enabled: true,
	};
}

function makeDeferrableTool(name: string, description: string): IToolDefinition & { enabled: boolean } {
	return makeTool(name, description, undefined, 'kanban');
}

function makeCoreTool(name: string, description: string): IToolDefinition & { enabled: boolean } {
	return makeTool(name, description, undefined, 'core');
}

// ─── estimateTokensFromSchemas ─────────────────────────────────────────────

suite('ToolSearchAssembler — estimateTokensFromSchemas', () => {

	test('returns 0 for empty list', () => {
		const result = estimateTokensFromSchemas([]);
		assert.strictEqual(result, 0);
	});

	test('returns positive number for tools', () => {
		const tools = [
			makeCoreTool('file_read', 'Read a file'),
			makeCoreTool('file_write', 'Write a file'),
		];
		const result = estimateTokensFromSchemas(tools);
		assert.ok(result > 0, `expected > 0 tokens, got ${result}`);
	});

	test('scales with tool count', () => {
		const small = estimateTokensFromSchemas([makeCoreTool('t1', 'desc')]);
		const large = estimateTokensFromSchemas([
			makeCoreTool('t1', 'desc'),
			makeCoreTool('t2', 'a longer description here'),
			makeCoreTool('t3', 'yet another tool with a really long description to test'),
			makeCoreTool('t4', 'fourth'),
			makeCoreTool('t5', 'fifth'),
		]);
		assert.ok(large > small, `large=${large} should be > small=${small}`);
	});
});

// ─── isDeferrableTool ──────────────────────────────────────────────────────

suite('ToolSearchAssembler — isDeferrableTool', () => {

	test('core tools are NOT deferrable', () => {
		assert.strictEqual(isDeferrableTool(makeCoreTool('file_read', 'Read file')), false);
		assert.strictEqual(isDeferrableTool(makeCoreTool('file_write', 'Write file')), false);
		assert.strictEqual(isDeferrableTool(makeCoreTool('terminal', 'Run command')), false);
	});

	test('bridge tools are NOT deferrable', () => {
		assert.strictEqual(isDeferrableTool(makeTool('tool_search', 'Search', undefined, 'tool-search')), false);
		assert.strictEqual(isDeferrableTool(makeTool('tool_describe', 'Describe', undefined, 'tool-search')), false);
		assert.strictEqual(isDeferrableTool(makeTool('tool_call', 'Call', undefined, 'tool-search')), false);
	});

	test('2026-07-03: MCP tools are deferrable via unified bridge (tool_search)', () => {
		// 2026-07-03: 统一为单套桥接，MCP 工具通过 'mcp' toolset 纳入 deferrable 池
		// MCP 工具现在通过统一的 tool_search/tool_describe/tool_call 路径按需发现
		const mcpTool = makeTool('get_architecture', 'Get arch', undefined, 'mcp');
		assert.strictEqual(isDeferrableTool(mcpTool), true, 'MCP tools should be deferrable');
	});

	test('2026-07-03: core tool double-protection (whitelist + toolset)', () => {
		// 即使 toolset 标记为 deferrable=true，核心工具也强制不可延迟
		const coreToolInDeferrableToolset = makeTool('file_read', 'Read', undefined, 'kanban');
		assert.strictEqual(isDeferrableTool(coreToolInDeferrableToolset), false, 'core tool whitelisted regardless of toolset');
	});

	test('medium/low priority tools ARE deferrable', () => {
		assert.strictEqual(isDeferrableTool(makeDeferrableTool('kanban_create', 'Create card')), true);
		assert.strictEqual(isDeferrableTool(makeDeferrableTool('browser_navigate', 'Navigate')), true);
	});

	test('workflow tools are NOT deferrable (High priority)', () => {
		// workflow toolset has priority=High and deferrable=false
		assert.strictEqual(isDeferrableTool(makeTool('workflow_create', 'Create', undefined, 'workflow')), false);
	});
});

// ─── classifyTools ─────────────────────────────────────────────────────────

suite('ToolSearchAssembler — classifyTools', () => {

	test('empty input', () => {
		const { visible, deferrable } = classifyTools([]);
		assert.strictEqual(visible.length, 0);
		assert.strictEqual(deferrable.length, 0);
	});

	test('all core tools → all visible, no deferrable', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeCoreTool('file_write', 'Write'),
			makeCoreTool('terminal', 'Terminal'),
		];
		const { visible, deferrable } = classifyTools(tools);
		assert.strictEqual(visible.length, 3);
		assert.strictEqual(deferrable.length, 0);
	});

	test('all deferrable tools → all deferrable, no visible', () => {
		const tools = [
			makeDeferrableTool('kanban_create', 'Create card'),
			makeDeferrableTool('kanban_list', 'List cards'),
		];
		const { visible, deferrable } = classifyTools(tools);
		assert.strictEqual(visible.length, 0);
		assert.strictEqual(deferrable.length, 2);
	});

	test('mixed core + deferrable', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeCoreTool('terminal', 'Terminal'),
			makeDeferrableTool('kanban_create', 'Create card'),
			makeDeferrableTool('browser_navigate', 'Navigate'),
		];
		const { visible, deferrable } = classifyTools(tools);
		assert.strictEqual(visible.length, 2);
		assert.strictEqual(deferrable.length, 2);
	});

	test('existing bridge tools are filtered out', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create'),
			makeTool('tool_search', 'Search', undefined, 'tool-search'),
			makeTool('tool_call', 'Call', undefined, 'tool-search'),
		];
		const { visible, deferrable } = classifyTools(tools);
		// bridge tools are skipped entirely
		assert.strictEqual(visible.length, 1); // file_read only
		assert.strictEqual(deferrable.length, 1); // kanban_create
	});

	test('high priority non-deferrable tools go to visible', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeTool('workflow_create', 'Create workflow', undefined, 'workflow'), // High, non-deferrable
			makeDeferrableTool('kanban_create', 'Create card'),
		];
		const { visible, deferrable } = classifyTools(tools);
		assert.strictEqual(visible.length, 2); // file_read + workflow_create
		assert.strictEqual(deferrable.length, 1); // kanban_create
	});
});

// ─── shouldActivate ────────────────────────────────────────────────────────

suite('ToolSearchAssembler — shouldActivate', () => {

	const configOn: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'on' };
	const configOff: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'off' };
	const configAuto: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'auto', thresholdPct: 10 };

	test('off mode always returns false', () => {
		assert.strictEqual(shouldActivate(configOff, 100000, 200000), false);
	});

	test('on mode returns true when tokens > 0', () => {
		assert.strictEqual(shouldActivate(configOn, 1000, 200000), true);
	});

	test('on mode returns false when tokens = 0', () => {
		assert.strictEqual(shouldActivate(configOn, 0, 200000), false);
	});

	test('auto: activates when above threshold (10%)', () => {
		// 200K context, 10% = 20K threshold. 25K tokens → activate
		assert.strictEqual(shouldActivate(configAuto, 25000, 200000), true);
	});

	test('auto: does NOT activate when below threshold (10%)', () => {
		// 200K context, 10% = 20K threshold. 15K tokens → passthrough
		assert.strictEqual(shouldActivate(configAuto, 15000, 200000), false);
	});

	test('auto: activates at exactly threshold', () => {
		const threshold = Math.floor(200000 * 0.1); // 20000
		assert.strictEqual(shouldActivate(configAuto, threshold, 200000), true);
	});

	test('auto: falls back to 20K when no context length', () => {
		assert.strictEqual(shouldActivate(configAuto, 25000, undefined), true);
		assert.strictEqual(shouldActivate(configAuto, 15000, undefined), false);
	});

	test('auto: activates with large thresholdPct', () => {
		const config: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'auto', thresholdPct: 30 };
		assert.strictEqual(shouldActivate(config, 15000, 200000), false); // 30% of 200K = 60K
	});
});

// ─── bridgeToolSchemas ─────────────────────────────────────────────────────

suite('ToolSearchAssembler — bridgeToolSchemas', () => {

	test('returns 3 tools', () => {
		const deferred = [makeDeferrableTool('kanban_create', 'Create card')];
		const schemas = bridgeToolSchemas(deferred, DEFAULT_TOOL_SEARCH_CONFIG);
		assert.strictEqual(schemas.length, 3);
	});

	test('tools are named tool_search, tool_describe, tool_call', () => {
		const deferred = [makeDeferrableTool('kanban_create', 'Create card')];
		const schemas = bridgeToolSchemas(deferred, DEFAULT_TOOL_SEARCH_CONFIG);
		assert.strictEqual(schemas[0].name, 'tool_search');
		assert.strictEqual(schemas[1].name, 'tool_describe');
		assert.strictEqual(schemas[2].name, 'tool_call');
	});

	test('tool_search has query (required) and limit parameters', () => {
		const deferred = [makeDeferrableTool('kanban_create', 'Create card')];
		const schemas = bridgeToolSchemas(deferred, DEFAULT_TOOL_SEARCH_CONFIG);
		const search = schemas[0].inputSchema;
		assert.ok((search as any)?.properties?.query);
		assert.ok((search as any)?.required?.includes('query'));
		assert.ok((search as any)?.properties?.limit);
	});

	test('tool_describe has name (required) parameter', () => {
		const deferred = [makeDeferrableTool('kanban_create', 'Create card')];
		const schemas = bridgeToolSchemas(deferred, DEFAULT_TOOL_SEARCH_CONFIG);
		const describe = schemas[1].inputSchema;
		assert.ok((describe as any)?.properties?.name);
		assert.ok((describe as any)?.required?.includes('name'));
	});

	test('tool_call has name and arguments (both required) parameters', () => {
		const deferred = [makeDeferrableTool('kanban_create', 'Create card')];
		const schemas = bridgeToolSchemas(deferred, DEFAULT_TOOL_SEARCH_CONFIG);
		const call = schemas[2].inputSchema;
		assert.ok((call as any)?.properties?.name);
		assert.ok((call as any)?.properties?.arguments);
		assert.ok((call as any)?.required?.includes('name'));
		assert.ok((call as any)?.required?.includes('arguments'));
	});

	test('toolset is tool-search for all bridges', () => {
		const deferred = [makeDeferrableTool('kanban_create', 'Create card')];
		const schemas = bridgeToolSchemas(deferred, DEFAULT_TOOL_SEARCH_CONFIG);
		for (const s of schemas) {
			assert.strictEqual((s as any).toolset, 'tool-search');
		}
	});
});

// ─── assembleToolDefs (集成) ────────────────────────────────────────────────

suite('ToolSearchAssembler — assembleToolDefs', () => {

	test('passthrough when no deferrable tools', () => {
		const tools = [makeCoreTool('file_read', 'Read'), makeCoreTool('terminal', 'Terminal')];
		const result = assembleToolDefs(tools);
		assert.strictEqual(result.activated, false);
		assert.strictEqual(result.deferredCount, 0);
		assert.strictEqual(result.toolDefs.length, 2);
		assert.strictEqual(result.toolDefs[0].name, 'file_read');
	});

	test('passthrough when below threshold (auto mode)', () => {
		// Small context + few deferrable tools = below threshold
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create card'),
		];
		const result = assembleToolDefs(tools, { contextLength: 200000 });
		assert.strictEqual(result.activated, false);
		// passthrough: all tools visible
		assert.strictEqual(result.toolDefs.length, 2);
	});

	test('activated when on mode with deferrable tools', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create card'),
		];
		const config: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'on' };
		const result = assembleToolDefs(tools, { config });
		assert.strictEqual(result.activated, true);
		// visible + 3 bridge tools
		assert.strictEqual(result.toolDefs.length, 1 + 3); // 1 visible + 3 bridges
		assert.strictEqual(result.deferredCount, 1);
	});

	test('deferredDefs contains deferrable tools', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create card'),
			makeDeferrableTool('browser_navigate', 'Navigate'),
		];
		const config: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'on' };
		const result = assembleToolDefs(tools, { config });
		assert.strictEqual(result.deferredDefs.length, 2);
		assert.strictEqual(result.deferredDefs[0].name, 'kanban_create');
		assert.strictEqual(result.deferredDefs[1].name, 'browser_navigate');
	});

	test('hard cap: visible (core) tools exceeding maxVisible are forced into bridge', () => {
		// 复现 incident：单轮下发 53 个核心工具 → 请求体过大 → 网关在生成大响应时 stall。
		// 期望：visible 被截断到 maxVisible(30)，溢出核心工具强制折叠进 tool_search 桥接。
		const tools: Array<IToolDefinition & { enabled: boolean }> = [];
		for (let i = 0; i < 40; i++) {
			tools.push(makeCoreTool(`core_tool_${i}`, `Core tool number ${i}`));
		}
		const result = assembleToolDefs(tools, { maxVisible: 30 });
		// 30 visible + 3 bridge
		assert.strictEqual(result.toolDefs.length, 30 + 3, `expected 33 toolDefs, got ${result.toolDefs.length}`);
		assert.strictEqual(result.activated, true, 'bridge must be activated when cap is exceeded');
		assert.strictEqual(result.deferredCount, 10, `expected 10 forced-deferred, got ${result.deferredCount}`);
		// 溢出的核心工具仍在 catalog 中可达
		const names = result.deferredDefs.map(t => t.name);
		assert.ok(names.includes('core_tool_39'), 'overflow core tool should be discoverable via bridge');
		// 桥接工具自身不应进入 deferredDefs（避免重复）
		assert.ok(!names.includes('tool_search'), 'bridge tools must not be in deferredDefs');
	});

	test('hard cap disabled when maxVisible is large enough', () => {
		const tools: Array<IToolDefinition & { enabled: boolean }> = [];
		for (let i = 0; i < 40; i++) {
			tools.push(makeCoreTool(`core_tool_${i}`, `Core tool number ${i}`));
		}
		// maxVisible 足够大 → 不折叠
		const result = assembleToolDefs(tools, { maxVisible: 100 });
		assert.strictEqual(result.activated, false);
		assert.strictEqual(result.toolDefs.length, 40);
	});

	test('idempotent — existing bridge tools are stripped', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create'),
			makeTool('tool_search', 'Search', undefined, 'tool-search'),
			makeTool('tool_call', 'Call', undefined, 'tool-search'),
		];
		const config: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'on' };
		const result = assembleToolDefs(tools, { config });
		// bridge tools stripped from input, then re-added → 1 visible + 3 bridges = 4
		assert.strictEqual(result.toolDefs.length, 4);
		assert.strictEqual(result.activated, true);
	});

	test('off mode never activates', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create'),
		];
		const config: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'off' };
		const result = assembleToolDefs(tools, { config });
		assert.strictEqual(result.activated, false);
		// passthrough
		assert.strictEqual(result.toolDefs.length, 2);
	});

	test('result includes deferredTokens and thresholdTokens', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create'),
		];
		const config: IToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG, enabled: 'on' };
		const result = assembleToolDefs(tools, { config, contextLength: 200000 });
		assert.ok(result.deferredTokens > 0);
		assert.ok(result.thresholdTokens > 0);
	});
});

// ─── scopedDeferrableNames ──────────────────────────────────────────────────

suite('ToolSearchAssembler — scopedDeferrableNames', () => {

	test('returns empty set for no deferrable tools', () => {
		const tools = [makeCoreTool('file_read', 'Read'), makeCoreTool('terminal', 'Terminal')];
		const names = scopedDeferrableNames(tools);
		assert.strictEqual(names.size, 0);
	});

	test('returns deferrable tool names', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create card'),
			makeDeferrableTool('browser_navigate', 'Navigate'),
		];
		const names = scopedDeferrableNames(tools);
		assert.strictEqual(names.size, 2);
		assert.ok(names.has('kanban_create'));
		assert.ok(names.has('browser_navigate'));
	});

	test('does NOT include bridge tool names', () => {
		const tools = [
			makeDeferrableTool('kanban_create', 'Create'),
			makeTool('tool_search', 'Search', undefined, 'tool-search'),
		];
		const names = scopedDeferrableNames(tools);
		assert.strictEqual(names.size, 1);
		assert.ok(!names.has('tool_search'));
	});

	test('does NOT include core tool names', () => {
		const tools = [
			makeCoreTool('file_read', 'Read'),
			makeDeferrableTool('kanban_create', 'Create'),
		];
		const names = scopedDeferrableNames(tools);
		assert.strictEqual(names.size, 1);
		assert.ok(!names.has('file_read'));
	});
});
