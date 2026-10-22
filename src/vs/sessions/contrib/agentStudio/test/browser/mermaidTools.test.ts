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

import {
	registerMermaidTools, MERMAID_TOOL_NAME, analyzeMermaidSvg, layoutAdvice, unwrapMarkupFence,
} from '../../browser/providers/tool/mermaidTools.js';
import { getToolsetForTool } from '../../common/toolsetConfig.js';
import { BUNDLED_TOOL_DEFINITIONS, BUNDLED_TOOLSETS } from '../../common/bundled-tools/bundledTools.js';
import { GLOBAL_SYSTEM_PREFIX, getStrategyGuidance } from '../../common/chatModeConfig.js';

import type { IToolResultContent } from '../../common/providers.js';

/**
 * 构造一个最小 mock，收集注册的 descriptor。
 * `render` 缺省时不注入（覆盖「无渲染器 ⇒ 跳过校验」的兼容路径）。
 */
function makeRegisterContext(render?: (markup: string, theme?: 'dark' | 'default') => Promise<string>) {
	const registered: { definition: any; handler: (args: Record<string, unknown>) => Promise<IToolResultContent[]> }[] = [];
	const warnings: string[] = [];
	const ctx = {
		register: (d: { definition: any; handler: (args: Record<string, unknown>) => Promise<IToolResultContent[]> }) => registered.push(d),
		logService: { info() { }, warn(msg: string) { warnings.push(msg); }, error() { } },
		render,
	};
	return { registered, ctx, warnings };
}

/**
 * 合成一份「像 **pele** 产物」的 SVG（计数特征与真实产物一致，见 `analyzeMermaidSvg` 注释）。
 *
 * ⚠ 2026-10-20 换口径：实现自 2026-10-19 换 pele 引擎后按 `class="pele-node` / `class="pele-edge`
 *   计数，而这里的夹具还在造 **mermaid** 的 `class="node"` / `class="edge-thickness-*"`
 *   ⇒ 数出 0 节点 ⇒ 布局体检整条静默失效 + 本套 4 条恒红（实现是对的，夹具过期）。
 *   顺带把**容器与标签**也造出来：它们才是口径的关键（`pele-nodes` / `pele-edges` /
 *   `pele-edge-label` 都必须**不**被计入，否则计数会偏）。
 */
function makeSvg(nodeCount: number, edgeCount: number, width = 600, height = 400): string {
	const nodes = '<g class="pele-node" id="n"></g>'.repeat(nodeCount);
	const edges = '<path class="pele-edge" d="M0 0"></path>'.repeat(edgeCount);
	const labels = '<g class="pele-edge-label"></g>'.repeat(edgeCount);
	return `<svg viewBox="0 0 ${width} ${height}">`
		+ `<g class="pele-nodes">${nodes}</g>`
		+ `<g class="pele-edges">${edges}</g>`
		+ labels
		+ '</svg>';
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

	// ── 2026-09-24：真实渲染校验 + 布局体检 ──────────────────────────────
	test('注入 render 成功时返回成功文本，并附带超阈值图的布局体检建议', async () => {
		const { registered, ctx } = makeRegisterContext(async () => makeSvg(25, 40, 4000, 300));
		registerMermaidTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { markup: 'graph TD\nA-->B' });
		assert.ok(text.includes('rendered successfully'), '渲染成功应返回成功标记');
		assert.ok(text.includes('布局体检'), '超阈值图应附布局体检');
		assert.ok(text.includes('节点 25 个'), '应报出节点数');
		assert.ok(text.includes('连线 40 条'), '应报出连线数');
		assert.ok(text.includes('TD'), '画布过宽应建议改 TD');
	});

	test('注入 render 成功且图不大时不附体检建议', async () => {
		const { registered, ctx } = makeRegisterContext(async () => makeSvg(8, 7));
		registerMermaidTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { markup: 'graph TD\nA-->B' });
		assert.ok(text.includes('rendered successfully'), '应返回成功标记');
		assert.ok(!text.includes('布局体检'), '小图不应附体检建议');
	});

	test('渲染失败时返回错误文本（含 mermaid 报错 + 修复检查表），且不得谎报成功', async () => {
		const { registered, ctx } = makeRegisterContext(async () => {
			throw new Error("Parse error on line 3: ... classDef subgraph ... Expecting 'AMP', got 'subgraph'");
		});
		registerMermaidTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { markup: 'graph TD\nA-->B' });
		assert.ok(text.includes('[Mermaid] Error:'), '失败应返回错误文本');
		assert.ok(!text.includes('rendered successfully'), '失败绝不能报成功（模型会因此不再重试）');
		assert.ok(text.includes("got 'subgraph'"), '应回灌 mermaid 原始报错，模型才能定向修复');
		assert.ok(text.includes('修复检查表'), '应附修复检查表');
	});

	test('渲染器不可用（bundle 缺失）时不阻断：记日志并按成功放行', async () => {
		const { registered, ctx, warnings } = makeRegisterContext(async () => {
			// ⚠ 2026-10-20：报错文案必须是**当前引擎**的基建特征 —— 判据是
			//   `RENDERER_INFRA_ERROR_MARKERS = ['pele 资源读不到', 'pele 产物格式不对']`
			//   （2026-10-19 换 pele 后旧特征 '渲染 bundle 不存在' 全部失效）。
			//   夹具还用旧文案 ⇒ 被判成"模型写错 markup" ⇒ 返回错误块 ⇒ 本用例恒红（实现是对的）✗。
			throw new Error('pele 资源读不到：渲染器 bundle 缺失（请先构建 mermaid-chat-features 的 webview）');
		});
		registerMermaidTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { markup: 'graph TD\nA-->B' });
		assert.ok(text.includes('rendered successfully'), '基建问题不应变成图错误');
		assert.ok(warnings.length > 0, '应留下警告日志');
		assert.ok(warnings[0].includes('renderer unavailable'), '日志应标明是渲染器不可用');
	});

	test('校验用的是「剥掉围栏 + 还原 \\n 转义」后的 markup（与卡片渲染口径一致）', async () => {
		const seen: string[] = [];
		const { registered, ctx } = makeRegisterContext(async (markup) => { seen.push(markup); return makeSvg(3, 2); });
		registerMermaidTools(ctx as any);

		await invokeHandler(registered[0].handler, { markup: '```mermaid\\ngraph TD\\nA-->B\\n```' });
		assert.strictEqual(seen.length, 1, '应真实渲染一次');
		assert.ok(!seen[0].includes('```'), '围栏应被剥掉');
		assert.ok(seen[0].startsWith('graph TD'), '首行应为图类型关键字');
		assert.ok(seen[0].includes('\n'), '字面量 \\n 应还原为真换行');
	});

	test('unwrapMarkupFence 处理围栏 / 裸反引号 / 无围栏三种输入', () => {
		assert.strictEqual(unwrapMarkupFence('```mermaid\ngraph TD\nA-->B\n```'), 'graph TD\nA-->B');
		assert.strictEqual(unwrapMarkupFence('```\ngraph TD\nA-->B\n```'), 'graph TD\nA-->B');
		assert.strictEqual(unwrapMarkupFence('graph TD\nA-->B'), 'graph TD\nA-->B');
	});

	test('analyzeMermaidSvg 计数与真实 pele 产物口径一致', () => {
		// 口径来源（2026-10-19 换 pele 后重测）：`class="pele-node` 计数、`class="pele-edge`
		// 必须紧跟空格/引号 ⇒ 容器 `pele-nodes` / `pele-edges` 与标签 `pele-edge-label` 不误计。
		const m = analyzeMermaidSvg(makeSvg(11, 12, 136, 40));
		assert.strictEqual(m.nodes, 11);
		assert.strictEqual(m.edges, 12);
		assert.strictEqual(m.width, 136);
		assert.strictEqual(m.height, 40);
	});

	test('layoutAdvice 对非 flowchart（量不到节点）保持沉默', () => {
		// sequenceDiagram 产物里没有 class="node ⇒ 计数为 0 ⇒ 不能凭 0 给出「节点太少」之类的误判
		const advice = layoutAdvice(analyzeMermaidSvg('<svg viewBox="0 0 450 347"></svg>'));
		assert.deepStrictEqual(advice, []);
	});

	test('layoutAdvice 对画布过长的图建议 LR', () => {
		const advice = layoutAdvice(analyzeMermaidSvg(makeSvg(6, 5, 200, 2000)));
		assert.ok(advice.some(a => a.includes('LR')), '1:10 的画布应建议 LR');
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
