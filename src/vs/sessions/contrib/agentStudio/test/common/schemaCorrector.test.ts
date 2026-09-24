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
import { TOOL_REFERENCE_HINTS, correctSchemaReferences, ensureMentioned } from '../../common/schemaCorrector.js';
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

// ─── 交叉提示「可用才加」（2026-09-24 重做后的新口径）────────────────────────
//
// 上面那组覆盖的是旧口径的两端；这一组钉住**新口径**的细节，因为它的两种失败都是静默的：
// 该加而不加（提示丢失，模型白多跑一轮浏览器工具）或不该加而在（模型看到指向**不可用**工具的引用
// → 幻觉调用，正是本模块存在的理由）。

suite('SchemaCorrector — 交叉提示「可用才加」', () => {

	/** 规则表里那条句子 —— 直接取声明里的值，不再抄一份字面量。 */
	const HINT = TOOL_REFERENCE_HINTS[0];

	const descOf = (tools: readonly IToolDefinition[], name: string): string =>
		String(tools.find(t => t.name === name)?.description ?? '');

	test('规则表：owner / 被引用工具 / 句子都在（表被清空 ⇒ 提示静默消失）', () => {
		assert.ok(TOOL_REFERENCE_HINTS.length > 0, '规则表不该为空');
		assert.strictEqual(HINT.owner, 'browser_navigate');
		assert.deepStrictEqual([...HINT.referenced], ['web_search', 'web_extract']);
		assert.ok(HINT.text.startsWith(' '), '句子以空格开头：它直接接在描述末尾，调用方不再加分隔符');
	});

	test('★★ 两件工具都在、而描述里**没有**那句话 ⇒ 由本模块加上（这正是"可用才加"）', () => {
		// 旧口径是"工具模块无条件写进去、这里再删"；新口径下**工具模块不再写**，
		// 所以"加"这一步必须由本模块保证 —— 这条用例就是那个新契约。
		const result = correctSchemaReferences([
			makeTool('browser_navigate', 'Open a URL.'),
			makeTool('web_search', 's'),
			makeTool('web_extract', 'e'),
		]);
		assert.strictEqual(descOf(result, 'browser_navigate'), `Open a URL.${HINT.text}`);
	});

	test('★★ 缺**一个**就不加（不是"有一个就加"）—— 描述里没有 ⇒ 保持没有', () => {
		for (const missing of HINT.referenced) {
			const present = HINT.referenced.filter(n => n !== missing).map(n => makeTool(n, 'x'));
			const result = correctSchemaReferences([makeTool('browser_navigate', 'Open a URL.'), ...present]);
			assert.ok(!descOf(result, 'browser_navigate').includes(HINT.text), `缺 ${missing} 时不该出现那句话`);
		}
	});

	test('★ 一个都没有 ⇒ 不加，且对象引用不变（不做无谓的 schema 重建）', () => {
		const nav = makeTool('browser_navigate', 'Open a URL.');
		const result = correctSchemaReferences([nav]);
		assert.strictEqual(result[0], nav);
	});

	test('★★★ 幂等：连跑三次不会把句子拼三遍（每次工具装配都会调它）', () => {
		const tools: IToolDefinition[] = [
			makeTool('browser_navigate', 'Open a URL.'),
			makeTool('web_search', 's'),
			makeTool('web_extract', 'e'),
		];
		for (let i = 0; i < 3; i++) { correctSchemaReferences(tools); }
		const occurrences = descOf(tools, 'browser_navigate').split(HINT.text).length - 1;
		assert.strictEqual(occurrences, 1, '必须恰好出现一次');
	});

	test('ensureMentioned：两个方向 + 幂等 + 不留双空格', () => {
		assert.strictEqual(ensureMentioned('A.', ' H.', true), 'A. H.');
		assert.strictEqual(ensureMentioned('A.', ' H.', false), 'A.');
		assert.strictEqual(ensureMentioned('A. H.', ' H.', true), 'A. H.');
		assert.strictEqual(ensureMentioned('A. H.', ' H.', false), 'A.');
		assert.strictEqual(ensureMentioned('A.   ', ' H.', true), 'A. H.', '加之前先 trimEnd，避免双空格');
	});

	test('★ 只动 owner：别的工具的描述一律不碰（连尾随空白都不动）', () => {
		const result = correctSchemaReferences([
			makeTool('web_search', 'Search the web. '),
			makeTool('browser_navigate', 'x'),
			makeTool('web_extract', 'e'),
		]);
		assert.strictEqual(descOf(result, 'web_search'), 'Search the web. ');
	});

	test('畸形输入不崩（null 项 / 无 name）', () => {
		const tools = [
			null as unknown as IToolDefinition,
			{ name: '' } as IToolDefinition,
			makeTool('browser_navigate', 'x'),
		];
		assert.doesNotThrow(() => correctSchemaReferences(tools));
	});

});

// ─── 核心工具白名单（P3-1 双重保护第一层）────────────────────────────────

suite('CORE_TOOLS whitelist', () => {

	test('isCoreTool returns true for whitelisted tools', () => {
		assert.strictEqual(isCoreTool('file_read'), true);
		assert.strictEqual(isCoreTool('file_write'), true);
		assert.strictEqual(isCoreTool('terminal'), true);
		assert.strictEqual(isCoreTool('memory_list'), true);
		// `todo` 工具已于 2026-07-04 被 `update_plan` 替代（见 compatibilityTools.ts
		// 的「替代旧的 todo 工具」注释），CORE_TOOLS 里对应项也已换成 `update_plan`。
		// 原断言引用的是**已删除的工具** —— 属过时断言（长期红，2026-09-11 修正）。
		assert.strictEqual(isCoreTool('update_plan'), true);
		assert.strictEqual(isCoreTool('web_search'), true);
	});

	test('isCoreTool returns false for non-whitelisted tools', () => {
		assert.strictEqual(isCoreTool('kanban_create'), false);
		assert.strictEqual(isCoreTool('mcp_get_architecture'), false);
		assert.strictEqual(isCoreTool('custom_tool_xyz'), false);
	});

	test('isCoreToolset returns true for protected toolsets', () => {
		assert.strictEqual(isCoreToolset('core'), true);
		assert.strictEqual(isCoreToolset('tool-search'), true);
		// `mcp-bridge` 已于 2026-09-11 删除（靠 `mcp_tool_` 前缀匹配、而该前缀的工具
		// 早已不存在 → 永不匹配的死配置），对应断言同步移除。
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

	test('CORE_TOOLSET_IDS contains the protected toolsets', () => {
		// 2026-09-11：`mcp-bridge` 已删除（靠 `mcp_tool_` 前缀匹配、而该前缀的工具
		// 早已不存在 → 永不匹配的死配置）→ 集合由 3 项变 **2 项**。
		assert.strictEqual(CORE_TOOLSET_IDS.size, 2);
		assert.ok(CORE_TOOLSET_IDS.has('core'));
		assert.ok(CORE_TOOLSET_IDS.has('tool-search'));
		assert.ok(!CORE_TOOLSET_IDS.has('mcp-bridge'), 'mcp-bridge 不应再出现在核心 toolset 集合中');
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
