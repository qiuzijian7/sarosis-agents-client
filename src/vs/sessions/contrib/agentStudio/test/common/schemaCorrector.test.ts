/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema 修正测试 — 对齐 Hermes-Agent `model_tools.py:454-510` 的真实实现。
 *
 * 覆盖：
 *   - browser_navigate: 当 web_search/web_extract 不可用时删除描述中的 web 引用
 *   - execute_code: sandbox 工具列表过滤
 *   - 核心工具白名单: 即使 toolset 标记 deferrable 也强制不可延迟
 */

import assert from 'assert';
import { IToolDefinition } from '../../common/providers.js';
import { correctSchemaReferences } from '../../common/schemaCorrector.js';
import {
	isCoreTool, isCoreToolset, CORE_TOOLS, CORE_TOOLSET_IDS,
} from '../../common/toolsetConfig.js';

// ─── 测试辅助工具 ──────────────────────────────────────────────────────────

function makeTool(name: string, description: string = '', inputSchema?: any): IToolDefinition {
	return {
		name,
		description,
		inputSchema: inputSchema ?? { type: 'object', properties: {} },
	};
}

// ─── browser_navigate 描述修正 ─────────────────────────────────────────────

suite('SchemaCorrector — browser_navigate', () => {

	test('removes web hint when web_search NOT available', () => {
		const tools: IToolDefinition[] = [
			makeTool('browser_navigate', 'Navigate to URL. For simple information retrieval, prefer web_search or web_extract (faster, cheaper).'),
			makeTool('browser_click', 'Click'),
			// 注意：故意不包含 web_search 和 web_extract
		];
		const result = correctSchemaReferences(tools);
		const browser = result.find(t => t.name === 'browser_navigate')!;
		assert.ok(browser);
		assert.ok(!browser.description?.includes('prefer web_search'),
			'should remove web_search reference');
		assert.ok(!browser.description?.includes('web_extract'),
			'should remove web_extract reference');
	});

	test('removes web hint when web_extract NOT available', () => {
		const tools: IToolDefinition[] = [
			makeTool('browser_navigate', 'Navigate. For simple information retrieval, prefer web_search or web_extract (faster, cheaper).'),
			makeTool('web_search', 'Web search'), // web_search 存在，web_extract 不存在
		];
		const result = correctSchemaReferences(tools);
		const browser = result.find(t => t.name === 'browser_navigate')!;
		assert.ok(browser);
		assert.ok(!browser.description?.includes('prefer web_search'),
			'should remove hint when EITHER web tool is missing');
	});

	test('keeps web hint when both web_search and web_extract available', () => {
		const originalDesc = 'Navigate. For simple information retrieval, prefer web_search or web_extract (faster, cheaper).';
		const tools: IToolDefinition[] = [
			makeTool('browser_navigate', originalDesc),
			makeTool('web_search', 'Web search'),
			makeTool('web_extract', 'Web extract'),
		];
		const result = correctSchemaReferences(tools);
		const browser = result.find(t => t.name === 'browser_navigate')!;
		assert.ok(browser);
		assert.strictEqual(browser.description, originalDesc,
			'should keep hint when both web tools available');
	});

	test('does not modify non-browser_navigate tools', () => {
		const tools: IToolDefinition[] = [
			makeTool('file_read', 'Read a file. For simple information retrieval, prefer web_search or web_extract (faster, cheaper).'),
		];
		const result = correctSchemaReferences(tools);
		const fileRead = result.find(t => t.name === 'file_read')!;
		assert.ok(fileRead);
		// 不应修改（描述中包含 hint 字符串但 toolname 不是 browser_navigate）
		assert.ok(fileRead.description?.includes('prefer web_search'),
			'file_read description should NOT be modified');
	});
});

// ─── execute_code sandbox 工具列表 ───────────────────────────────────────

suite('SchemaCorrector — execute_code', () => {

	test('filters sandbox tools that are not available', () => {
		const tools: IToolDefinition[] = [
			makeTool('execute_code', 'Run code', {
				type: 'object',
				properties: {
					code: { type: 'string' },
					sandbox: {
						type: 'array',
						default: ['web_search', 'nonexistent_tool', 'file_read'],
					},
				},
			}),
			makeTool('web_search', 'Web search'),
			makeTool('file_read', 'Read file'),
		];
		const result = correctSchemaReferences(tools);
		const exec = result.find(t => t.name === 'execute_code')!;
		assert.ok(exec);
		const sandboxDefault = (exec.inputSchema as any).properties.sandbox.default;
		assert.deepStrictEqual(sandboxDefault, ['web_search', 'file_read'],
			'should filter out nonexistent_tool');
	});

	test('keeps sandbox unchanged when all tools are available', () => {
		const tools: IToolDefinition[] = [
			makeTool('execute_code', 'Run code', {
				type: 'object',
				properties: {
					sandbox: { type: 'array', default: ['web_search', 'file_read'] },
				},
			}),
			makeTool('web_search', 'Web search'),
			makeTool('file_read', 'Read file'),
		];
		const result = correctSchemaReferences(tools);
		const exec = result.find(t => t.name === 'execute_code')!;
		assert.ok(exec);
		// 不应修改（所有 sandbox 工具都可用）
		assert.strictEqual(exec, result[0], 'should not modify when all tools available');
	});
});

// ─── 核心工具白名单（P3-1 双重保护第一层）────────────────────────────────

suite('CORE_TOOLS whitelist', () => {

	test('isCoreTool returns true for whitelisted tools', () => {
		assert.strictEqual(isCoreTool('file_read'), true);
		assert.strictEqual(isCoreTool('file_write'), true);
		assert.strictEqual(isCoreTool('terminal'), true);
		assert.strictEqual(isCoreTool('memory'), true);
		assert.strictEqual(isCoreTool('todo'), true);
		assert.strictEqual(isCoreTool('web_search'), true);
	});

	test('isCoreTool returns false for non-whitelisted tools', () => {
		assert.strictEqual(isCoreTool('kanban_create'), false);
		assert.strictEqual(isCoreTool('mcp_get_architecture'), false);
		assert.strictEqual(isCoreTool('custom_tool_xyz'), false);
	});

	test('isCoreToolset returns true for protected toolsets', () => {
		assert.strictEqual(isCoreToolset('core'), true);
		assert.strictEqual(isCoreToolset('mcp-bridge'), true);
		assert.strictEqual(isCoreToolset('tool-search'), true);
	});

	test('isCoreToolset returns false for non-protected toolsets', () => {
		assert.strictEqual(isCoreToolset('mcp'), false);
		assert.strictEqual(isCoreToolset('kanban'), false);
		assert.strictEqual(isCoreToolset('memory'), false);
	});

	test('CORE_TOOLS includes tool_search bridge tools', () => {
		assert.ok(CORE_TOOLS.has('tool_search'), 'tool_search is whitelisted');
		assert.ok(CORE_TOOLS.has('tool_describe'), 'tool_describe is whitelisted');
		assert.ok(CORE_TOOLS.has('tool_call'), 'tool_call is whitelisted');
	});

	test('CORE_TOOLSET_IDS contains the 3 protected toolsets', () => {
		assert.strictEqual(CORE_TOOLSET_IDS.size, 3);
	});
});

// ─── 综合测试 ─────────────────────────────────────────────────────────────

suite('SchemaCorrector — integration', () => {

	test('handles empty tool list', () => {
		const result = correctSchemaReferences([]);
		assert.deepStrictEqual(result, []);
	});

	test('preserves tool object identity for unmodified tools', () => {
		const fileRead = makeTool('file_read', 'Read a file');
		const fileWrite = makeTool('file_write', 'Write a file');
		const result = correctSchemaReferences([fileRead, fileWrite]);
		// 没有任何修正应该发生（既没有 browser_navigate 也没有 execute_code）
		assert.strictEqual(result[0], fileRead);
		assert.strictEqual(result[1], fileWrite);
	});
});
