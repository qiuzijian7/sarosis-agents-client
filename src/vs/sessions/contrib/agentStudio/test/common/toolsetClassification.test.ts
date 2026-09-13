/*---------------------------------------------------------------------------------------------
 *  Toolset 归类回归锁定（2026-09-11）
 *
 *  背景：一组「有真实 handler、但无任何 toolset 匹配」的工具会落进 `utility`。
 *  而 `utility` **不在 `CODING_FOCUS_TOOLSETS`** 内（focus 推荐列表只有
 *  core / tool-search / mcp / codebase / codebase-grep / memory / skill）→
 *  focus 模式下被**整条剔除** → 工具虽注册了真实 handler，**LLM 永远看不到**。
 *
 *  本仓已有两次同源事故（都在 `toolsetConfig.ts` 留有注释）：
 *    - `renderMermaidDiagram` 落入 utility（历史坑）
 *    - `image_generate` 落入 utility → 专门新增 `image_gen` toolset 修复
 *
 *  2026-09-11 又发现三组遗漏（本文件锁定）：
 *    - `canvas_*`（7 个）：`canvas` toolset 只写了 `mindmap_` 前缀
 *    - `web_recipe_*` / `web_scrape_to_board`（4 个）：不带 `kanban_` 前缀
 *    - `check_index_coverage` / `export_artifact` / `import_artifact`（3 个）：
 *      同族 13 个工具都在 `CORE_TOOLS`，唯独这 3 个漏登
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/common/toolsetClassification.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { getToolsetForTool } from '../../common/toolsetConfig.js';

suite('Toolset 归类（2026-09-11 遗漏修复锁定）', () => {

	test('canvas_* 归入 canvas toolset（此前全部落 utility）', () => {
		const canvasTools = [
			'canvas_apply_ops',
			'canvas_generate',
			'canvas_get_task_status',
			'canvas_get_state',
			'canvas_reverse_prompt',
			'canvas_undo',
			'canvas_redo',
		];
		for (const t of canvasTools) {
			assert.strictEqual(getToolsetForTool(t), 'canvas', `${t} 应归入 canvas toolset`);
		}
	});

	test('mindmap_* 仍归入 canvas toolset（同族，双前缀）', () => {
		// canvas toolset 是 mindmap 的演进 —— 补 `canvas_` 前缀不能挤掉原 `mindmap_`
		assert.strictEqual(getToolsetForTool('mindmap_generate'), 'canvas');
	});

	test('web_recipe_* / web_scrape_to_board 归入 kanban toolset（此前落 utility）', () => {
		const kanbanFamily = ['web_recipe_create', 'web_recipe_list', 'web_recipe_remove', 'web_scrape_to_board'];
		for (const t of kanbanFamily) {
			assert.strictEqual(getToolsetForTool(t), 'kanban', `${t} 应归入 kanban toolset`);
		}
	});

	test('kanban_* 仍归入 kanban toolset（补前缀不能挤掉原有规则）', () => {
		assert.strictEqual(getToolsetForTool('kanban_create'), 'kanban');
	});

	test('★ codebase 同族遗漏的 3 个已归入 core toolset（focus 模式不被剔除）', () => {
		// 注：同族工具（search_graph / index_repository / manage_adr…）同样只通过
		// `TOOLSET_DEFINITIONS` 中 core 项的 `exactNames` 保核心，**并不在**
		// `CORE_TOOLS` 集合里 —— 后者是另一份清单（覆盖 file_read / terminal /
		// 桥接工具等），二者有重叠但不相同。此处与同族保持一致，故断言 toolset
		// 归类，而非 `isCoreTool`。
		for (const t of ['check_index_coverage', 'export_artifact', 'import_artifact']) {
			assert.strictEqual(getToolsetForTool(t), 'core', `${t} 应归入 core toolset`);
		}
	});

	test('★ 上述工具均不落 utility（落 utility = focus 模式下 LLM 永远看不到）', () => {
		const mustNotBeUtility = [
			'canvas_apply_ops', 'canvas_generate', 'canvas_get_task_status',
			'canvas_get_state', 'canvas_reverse_prompt', 'canvas_undo', 'canvas_redo',
			'web_recipe_create', 'web_recipe_list', 'web_recipe_remove', 'web_scrape_to_board',
			'check_index_coverage', 'export_artifact', 'import_artifact',
			// 2026-09-11 补全 handler 的工具：有 handler 还不够，必须同时可见。
			'vision_analyze', 'session_search', 'renderdrawiodiagram',
			'video_generate', 'text_to_speech', 'cronjob',
		];
		for (const t of mustNotBeUtility) {
			assert.notStrictEqual(getToolsetForTool(t), 'utility',
				`${t} 不应落进 utility（那会让它在 focus 模式下被整条剔除）`);
		}
	});

	test('★ 补全 handler 的工具必须同时归入 core（否则仍是「模型看不到」）', () => {
		// 「有真实 handler」与「模型能看到」是两件事：前者只保证不被 isStub 跳过，
		// 后者还要求 toolset 归类不在 focus 模式的白名单之外。本用例锁定两者一致。
		for (const t of ['vision_analyze', 'session_search', 'renderdrawiodiagram', 'video_generate', 'text_to_speech', 'cronjob']) {
			assert.strictEqual(getToolsetForTool(t), 'core', `${t} 应归入 core toolset`);
		}
	});

	test('对照：真正无归属的名字仍落 utility（确认上面的断言不是恒真）', () => {
		// 若这条失败，说明 `getToolsetForTool` 的兜底行为变了 —— 上面所有
		// notStrictEqual(..., 'utility') 断言将失去意义。
		assert.strictEqual(getToolsetForTool('some_totally_unknown_tool_xyz'), 'utility');
	});
});
