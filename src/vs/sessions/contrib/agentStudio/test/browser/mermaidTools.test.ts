/*---------------------------------------------------------------------------------------------
 *  Mermaid 图示工具（renderMermaidDiagram）单元测试
 *
 *  覆盖：
 *   - 工具注册（名称 / inputSchema / 必需的 markup 参数）
 *   - handler 行为（成功渲染 / 携带 title / 空 markup 报错 / 转义换行）
 *   - LLM 可见性接线（toolset 归类 / bundled 定义 / 全局系统提示词）
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/mermaidTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { registerMermaidTools, MERMAID_TOOL_NAME } from '../../browser/providers/tool/mermaidTools.js';
import { getToolsetForTool } from '../../common/toolsetConfig.js';
import { BUNDLED_TOOL_DEFINITIONS, BUNDLED_TOOLSETS } from '../../common/bundled-tools/bundledTools.js';
import { GLOBAL_SYSTEM_PREFIX, getStrategyGuidance } from '../../common/chatModeConfig.js';

import type { IToolResultContent } from '../../common/providers.js';

/** 构造一个最小 mock，收集注册的 descriptor */
function makeRegisterContext() {
	const registered: { definition: any; handler: (args: Record<string, unknown>) => Promise<IToolResultContent[]> }[] = [];
	const ctx = {
		register: (d: { definition: any; handler: (args: Record<string, unknown>) => Promise<IToolResultContent[]> }) => registered.push(d),
		logService: { info() { }, warn() { }, error() { } },
	};
	return { registered, ctx };
}

async function invokeHandler(
	handler: (args: Record<string, unknown>) => Promise<IToolResultContent[]>,
	args: Record<string, unknown>,
): Promise<string> {
	const result = await handler(args);
	assert.ok(Array.isArray(result), 'handler should return an array');
	assert.strictEqual(result.length, 1, 'handler should return exactly one content block');
	const block = result[0] as { type: string; text: string };
	assert.strictEqual(block.type, 'text', 'content block should be text');
	return block.text;
}

suite('Mermaid Tool (renderMermaidDiagram)', () => {

	test('MERMAID_TOOL_NAME 是规范的 camelCase 工具 id', () => {
		assert.strictEqual(MERMAID_TOOL_NAME, 'renderMermaidDiagram');
	});

	test('registerMermaidTools 注册工具含正确的 definition', () => {
		const { registered, ctx } = makeRegisterContext();
		registerMermaidTools(ctx as any);

		assert.strictEqual(registered.length, 1, '应恰好注册一个工具');
		const def = registered[0].definition;
		assert.strictEqual(def.name, MERMAID_TOOL_NAME);
		assert.ok(typeof def.description === 'string' && def.description.length > 0, 'description 必填');
		assert.ok(def.inputSchema && def.inputSchema.type === 'object', 'inputSchema 应为 object');
		assert.deepStrictEqual(def.inputSchema.required, ['markup'], 'markup 为必填参数');
		assert.ok(def.inputSchema.properties.markup, 'inputSchema 应包含 markup');
		assert.ok(def.inputSchema.properties.title, 'inputSchema 应包含可选的 title');
		assert.ok(!('toolset' in def) || def.toolset === undefined, 'definition 不强制内联 toolset（由 toolsetConfig 推断）');
	});

	test('handler 在仅提供 markup 时返回成功文本并回显 markup', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerMermaidTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { markup: 'graph TD\nA-->B' });
		assert.ok(text.includes('[Mermaid] Diagram rendered successfully.'), '应包含成功标记');
		assert.ok(text.includes('graph TD'), '应回显 markup 内容');
		assert.ok(!text.includes('Title:'), '无 title 时不应出现 Title 行');
	});

	test('handler 在提供 title 时把 title 写入成功文本', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerMermaidTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { markup: 'graph TD\nA-->B', title: 'System Architecture' });
		assert.ok(text.includes('[Mermaid] Diagram "System Architecture" rendered successfully.'), '成功文本应含 title');
		assert.ok(text.includes('Title: System Architecture'), '应包含 Title 行');
	});

	test('handler 在 markup 为空时返回错误文本', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerMermaidTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { markup: '   ' });
		assert.ok(text.includes('[Mermaid] Error: markup is required'), '空 markup 应返回错误');
	});

	test('handler 能正确处理转义换行（\\n）的 markup', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerMermaidTools(ctx as any);

		const escaped = 'graph TD\\nA-->B\\nC-->D';
		const text = await invokeHandler(registered[0].handler, { markup: escaped });
		assert.ok(text.includes('rendered successfully'), '转义换行 markup 应渲染成功');
		assert.ok(text.includes(escaped), '应原样回显转义后的 markup');
	});

	test('通过小写 dispatch key 查工具归入 core toolset（LLM 始终可见）', () => {
		// agentChatPanel 的 dispatch 会把工具名 .toLowerCase() 后查 TOOL_MERMAID_TOOLS，
		// 因此 toolsetConfig 中的 lowercase key 必须与之一致。
		const toolset = getToolsetForTool('rendermermaiddiagram');
		assert.strictEqual(toolset, 'core', 'rendermermaiddiagram 应归类为 core（Always 优先级）');
	});

	test('BUNDLED_TOOL_DEFINITIONS 包含 clarity 分类的 rendermermaiddiagram', () => {
		const def = BUNDLED_TOOL_DEFINITIONS.find(d => d.name === 'rendermermaiddiagram');
		assert.ok(def, 'bundled 定义应包含 rendermermaiddiagram');
		assert.strictEqual(def!.category, 'clarity', '分类应为 clarity');
		assert.deepStrictEqual(def!.inputSchema.required, ['markup'], 'markup 必填');
	});

	test('clarity toolset 列出 rendermermaiddiagram', () => {
		const clarity = BUNDLED_TOOLSETS.clarity;
		assert.ok(clarity, '应存在 clarity toolset');
		assert.ok(clarity.tools.includes('rendermermaiddiagram'), 'clarity.tools 应包含 rendermermaiddiagram');
	});

	test('GLOBAL_SYSTEM_PREFIX 是 \n 连接的字符串', () => {
		assert.strictEqual(typeof GLOBAL_SYSTEM_PREFIX, 'string', 'GLOBAL_SYSTEM_PREFIX 应为字符串');
		assert.ok(GLOBAL_SYSTEM_PREFIX.length > 0, 'GLOBAL_SYSTEM_PREFIX 不应为空');
	});

	test('策略引导（默认范式）要求调用 renderMermaidDiagram 工具', () => {
		// renderMermaidDiagram 的强制调用说明位于 getStrategyGuidance 的 default 分支
		const guidance = getStrategyGuidance(undefined);
		assert.ok(Array.isArray(guidance), 'getStrategyGuidance 应返回字符串数组');
		const joined = guidance.join('\n');
		assert.ok(joined.includes('renderMermaidDiagram'), '策略引导应指导调用 renderMermaidDiagram 工具');
		assert.ok(joined.toLowerCase().includes('mermaid'), '策略引导应提及 mermaid 图表');
	});

});
