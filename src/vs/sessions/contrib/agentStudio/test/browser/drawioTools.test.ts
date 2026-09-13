/*---------------------------------------------------------------------------------------------
 *  Draw.io 图示工具（renderDrawioDiagram）单元测试
 *
 *  背景（2026-09-11）：drawio 此前是**半成品** —— 渲染器 / 卡片 / 预览命令 / 构建脚本
 *  全部就绪，唯独缺工具 handler（`browser/providers/tool/` 下有 mermaidTools.ts 却没有
 *  drawioTools.ts）。后果是 `bundledTools.ts` 里的同名定义被注册成 stub（`isStub` →
 *  `listTools` 跳过）→ 模型看不到工具 → 整条链路成为死代码。
 *
 *  覆盖：
 *   - 工具注册（名称 / inputSchema / 必需的 source 参数）
 *   - handler 行为（成功 / title / 空 source / 非 mxGraphModel / 宽容 XML 声明）
 *   - LLM 可见性接线（toolset 归类 / CORE_TOOLS / bundled 定义 / clarity toolset）
 *   - ★ 命名契约：真实注册名必须与 bundled 名**逐字一致**，否则会多注册一个 stub
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/drawioTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { registerDrawioTools, DRAWIO_TOOL_NAME } from '../../browser/providers/tool/drawioTools.js';
import { registerBundledTools } from '../../browser/providers/tool/bundledTools.js';
import { BUNDLED_TOOL_DEFINITIONS, BUNDLED_TOOLSETS } from '../../common/bundled-tools/bundledTools.js';
import { getToolsetForTool, isCoreTool } from '../../common/toolsetConfig.js';

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

const VALID_XML = '<mxGraphModel dx="1422" dy="762"><root><mxCell id="0"/></root></mxGraphModel>';

suite('Drawio Tool (renderDrawioDiagram)', () => {

	test('DRAWIO_TOOL_NAME 是规范的 camelCase 工具 id（与 renderMermaidDiagram 同风格）', () => {
		assert.strictEqual(DRAWIO_TOOL_NAME, 'renderDrawioDiagram');
	});

	test('registerDrawioTools 注册工具含正确的 definition', () => {
		const { registered, ctx } = makeRegisterContext();
		registerDrawioTools(ctx as any);

		assert.strictEqual(registered.length, 1, '应恰好注册一个工具');
		const def = registered[0].definition;
		assert.strictEqual(def.name, DRAWIO_TOOL_NAME);
		assert.ok(typeof def.description === 'string' && def.description.length > 0, 'description 必填');
		assert.ok(def.inputSchema && def.inputSchema.type === 'object', 'inputSchema 应为 object');
		assert.deepStrictEqual(def.inputSchema.required, ['source'], 'source 为必填参数');
		assert.ok(def.inputSchema.properties.source, 'inputSchema 应包含 source');
		assert.ok(def.inputSchema.properties.title, 'inputSchema 应包含可选的 title');
		assert.ok(!('toolset' in def) || def.toolset === undefined, 'definition 不强制内联 toolset（由 toolsetConfig 推断）');
	});

	test('handler 在仅提供 source 时返回成功文本并回显 source', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerDrawioTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { source: VALID_XML });
		assert.ok(text.includes('[Drawio] Diagram rendered successfully.'), '应包含成功标记');
		assert.ok(text.includes('<mxGraphModel'), '应回显 source 内容');
		assert.ok(!text.includes('Title:'), '无 title 时不应出现 Title 行');
	});

	test('handler 在提供 title 时把 title 写入成功文本', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerDrawioTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { source: VALID_XML, title: 'System Architecture' });
		assert.ok(text.includes('[Drawio] Diagram "System Architecture" rendered successfully.'), '成功文本应含 title');
		assert.ok(text.includes('Title: System Architecture'), '应包含 Title 行');
	});

	test('handler 在 source 为空时返回错误文本', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerDrawioTools(ctx as any);

		const text = await invokeHandler(registered[0].handler, { source: '   ' });
		assert.ok(text.includes('[Drawio] Error: source is required'), '空 source 应返回错误');
	});

	test('★ 非 mxGraphModel 输入 → 明确报错并指向 renderMermaidDiagram（早失败优于渲染阶段抛错）', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerDrawioTools(ctx as any);

		// 典型的「张冠李戴」：把 Mermaid 语法交给 drawio 工具
		const text = await invokeHandler(registered[0].handler, { source: 'graph TD\nA-->B' });
		assert.ok(text.includes('[Drawio] Error:'), '非 mxGraphModel 应报错');
		assert.ok(text.includes('mxGraphModel'), '错误信息应说明期望 mxGraphModel');
		assert.ok(text.includes('renderMermaidDiagram'), '错误信息应指引改调 renderMermaidDiagram');
	});

	test('★ 宽容性：带 XML 声明 / 前导空白 / mxfile 包裹均视为合法（不误拒）', async () => {
		const { registered, ctx } = makeRegisterContext();
		registerDrawioTools(ctx as any);

		const withDecl = '<?xml version="1.0" encoding="UTF-8"?>\n<mxGraphModel><root/></mxGraphModel>';
		const withWs = '\n\n   ' + VALID_XML;
		const wrapped = '<mxfile><diagram name="p1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';

		for (const [label, src] of [['XML 声明', withDecl], ['前导空白', withWs], ['mxfile 包裹', wrapped]] as const) {
			const text = await invokeHandler(registered[0].handler, { source: src });
			assert.ok(text.includes('rendered successfully'),
				`${label} 形态是合法 drawio 导出，不应被误拒（误拒比漏放更糟：模型会放弃整张图）`);
		}
	});

	// ─── LLM 可见性接线 ─────────────────────────────────────────────────────

	test('通过小写 key 查工具归入 core toolset（LLM 始终可见）', () => {
		// 与 mermaid 同源：exactNames 统一以小写登记，getToolsetForTool 做大小写不敏感比较。
		// 若漏登记会落进 `utility`（Low）→ 被 focus 模式整条剔除（image_gen 踩过同一个坑）。
		assert.strictEqual(getToolsetForTool('renderdrawiodiagram'), 'core', 'renderdrawiodiagram 应归类为 core（Always）');
	});

	test('驼峰注册名同样归入 core（大小写不敏感匹配）', () => {
		assert.strictEqual(getToolsetForTool('renderDrawioDiagram'), 'core', '驼峰注册名也应归入 core');
	});

	test('isCoreTool 对驼峰注册名返回 true（白名单保护不因大小写失效）', () => {
		assert.strictEqual(isCoreTool('renderDrawioDiagram'), true);
		assert.strictEqual(isCoreTool('renderdrawiodiagram'), true);
	});

	test('BUNDLED_TOOL_DEFINITIONS 包含 clarity 分类的 renderDrawioDiagram', () => {
		const def = BUNDLED_TOOL_DEFINITIONS.find(d => d.name === 'renderDrawioDiagram');
		assert.ok(def, 'bundled 定义应包含 renderDrawioDiagram');
		assert.strictEqual(def!.category, 'clarity', '分类应为 clarity');
		assert.deepStrictEqual(def!.inputSchema.required, ['source'], 'source 必填');
	});

	test('clarity toolset 列出 renderDrawioDiagram', () => {
		const clarity = BUNDLED_TOOLSETS.clarity;
		assert.ok(clarity, '应存在 clarity toolset');
		assert.ok(clarity.tools.includes('renderDrawioDiagram'), 'clarity.tools 应包含 renderDrawioDiagram');
	});

	// ─── ★ 命名契约（锁定本次修复的 bug）────────────────────────────────────

	test('★ 真实注册名与 bundled 名逐字一致 → registerBundledTools 不会注册多余 stub', () => {
		// `registerBundledTools` 用 `ctx.hasTool(def.name)` 决定是否跳过注册，而
		// `toolRegistry.hasTool` 是 `Map.has`（**大小写敏感**）。若 bundled 名与真实
		// 注册名不一致（一个驼峰一个小写），就会多注册一个 stub —— 这正是 drawio 此前
		// 的状态（`isStub` 让 `listTools` 跳过它，于是模型根本看不到该工具）。
		//
		// 本用例把「真实注册表」建模成一个 Set，直接锁定该契约。
		const realRegistered = new Set<string>();
		registerDrawioTools({
			register: d => realRegistered.add(d.definition.name),
			logService: { info() { }, warn() { }, error() { } },
		} as any);
		assert.ok(realRegistered.has('renderDrawioDiagram'), '真实工具应注册为 renderDrawioDiagram');

		let stubRegistered = false;
		registerBundledTools({
			register: d => { if (d.definition.name === 'renderDrawioDiagram') { stubRegistered = true; } },
			logService: { info() { }, warn() { }, error() { } },
			// 与 toolRegistry.hasTool 同语义（Map.has，大小写敏感）
			hasTool: (n: string) => realRegistered.has(n),
		} as any);

		assert.strictEqual(stubRegistered, false,
			'renderDrawioDiagram 已有真实 handler，bundled 不应再注册 stub（否则模型看不到该工具）');
	});
});
