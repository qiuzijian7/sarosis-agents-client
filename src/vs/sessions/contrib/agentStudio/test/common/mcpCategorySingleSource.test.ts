/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP 工具**归属**的单一真源守卫：`category = mcp:<sanitize(server.definition.id)>`。
 *
 * 钉三件事，都是 2026-10-12 那类真实故障的形状：
 *   ① **生成端**必须用 `MCP_TOOL_CATEGORY_PREFIX` 拼（`mcpToolProvider`）—— 生成端一漂，
 *      所有读端（审批归类、toolset 分组、UI 归属、搜索标签）一起失效 ✗；
 *   ② **`'mcp:'` 字面量只许出现在常量定义处**：别人各自 `startsWith('mcp:')` / `slice(4)`
 *      就是"多份真源"，改一处漏一处 ✗（本轮已把散落的 5 处收敛到常量）；
 *   ③ **不许从工具名反推 server**：名字来自上游 `IMcpTool.id`（`mcp_<server>_<tool>`，**单**下划线，
 *      且 server 名本身可能含下划线），dsh Host 侧又是 `mcp__<server>__<tool>` ⇒
 *      `name.split('_')` / `split('__')` 都拿不到 server（`integrationView` 2026-10-12 就栽在这：
 *      恒落 `'unknown'` ⇒ UI 多出假服务器 + 「启动中」spinner 清不掉）。
 *
 * 归属的唯一入口：`common/toolApprovalPolicy.ts` 的 `isMcpSourcedTool` / `mcpServerIdOf`。
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';

const REPO = process.cwd();
const ROOTS = ['src/vs/sessions/contrib/agentStudio', 'src/vs/sessions/contrib/dshHarness'];
const CONSTANT_FILE = 'src/vs/sessions/contrib/agentStudio/common/toolApprovalPolicy.ts';
const GENERATOR_FILE = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/mcpToolProvider.ts';

function walkTs(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
		const rel = `${dir}/${e.name}`;
		if (e.isDirectory()) {
			// 跳过非源码与测试自身（守卫要扫的是产品代码）
			if (['node_modules', 'webview', 'media', 'test'].includes(e.name)) { continue; }
			walkTs(rel, out);
			continue;
		}
		if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) { out.push(rel); }
	}
	return out;
}

/** 去掉注释再扫：注释里写示例（如 `` `mcp:` ``）不该被当成"又一份真源"。 */
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

suite('MCP 工具归属 · 单一真源（category）', () => {
	const files = ROOTS.flatMap(r => walkTs(r));

	test('① 生成端用常量拼 category', () => {
		const gen = fs.readFileSync(path.join(REPO, GENERATOR_FILE), 'utf8');
		assert.ok(/category:\s*`\$\{MCP_TOOL_CATEGORY_PREFIX\}/.test(gen),
			'mcpToolProvider 生成 category 时没用 MCP_TOOL_CATEGORY_PREFIX ⇒ 生成端与读端会各写一份前缀 ✗');
	});

	test("② `'mcp:'` 字面量只许出现在常量定义处", () => {
		// 防空跑下限：扫不到足够文件说明路径/过滤坏了，别"绿着空跑"✗
		assert.ok(files.length >= 200, `扫描面可疑：只扫到 ${files.length} 个 .ts —— 本用例已失效 ✗`);
		const offenders = files.filter(f => /'mcp:'|"mcp:"/.test(strip(fs.readFileSync(path.join(REPO, f), 'utf8'))));
		assert.deepStrictEqual(offenders, [CONSTANT_FILE],
			'除常量定义外不许再出现 mcp: 字面量（请用 MCP_TOOL_CATEGORY_PREFIX / isMcpSourcedTool）✗：' + offenders.join(', '));
	});

	test('③ 不许从工具名反推 server', () => {
		const offenders: string[] = [];
		for (const f of files) {
			const code = strip(fs.readFileSync(path.join(REPO, f), 'utf8'));
			for (const m of code.matchAll(/\.name\.split\(\s*['"]_+['"]\s*\)/g)) {
				offenders.push(`${f} → ${m[0]}`);
			}
		}
		assert.deepStrictEqual(offenders, [],
			'归属只认 category（isMcpSourcedTool / mcpServerIdOf）：两种命名格式都拆不出 server ✗');
	});
});
