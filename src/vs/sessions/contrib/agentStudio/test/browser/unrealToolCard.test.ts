/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ⚠ 运行器会把本文件打包到临时目录执行（__dirname 不再是源码目录）⇒ 必须用 process.cwd()
//（仓库根）而不是 `path.join(__dirname, …)` —— 后者在打包后解析到盘符根，ENOENT。
const ROOT = process.cwd();
const BASE = 'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts';
const TOOL_CARDS = 'src/vs/sessions/browser/agentChat/agentChatPanel.toolCards.ts';
const UNREAL_CARD = 'src/vs/sessions/browser/agentChat/agentChatPanel.unrealCard.ts';
const CONTRIBUTION = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';
const PROVIDER = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/builtinToolProvider.ts';
const TOOLSET = 'src/vs/sessions/contrib/agentStudio/common/toolsetConfig.ts';

/** 与 `unrealTools.ts` 的 `UNREAL_*_TOOL_NAME` 逐一对应的注册名单（7 个）。 */
const UNREAL_TOOLS = [
	'unreal_health', 'unreal_exec', 'unreal_wait', 'unreal_help',
	'unreal_dump', 'unreal_build', 'unreal_find_asset',
];

function read(rel: string): string {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 剥掉注释 —— 防止"注释写了接线、代码没做"式假绿。 */
function code(rel: string): string {
	return read(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^[ \t]*\/\/.*$/gm, '');
}

suite('unreal_* 工具接线（2026-09-21「打出版本找不到 unreal_*」事故回归）', () => {

	// 事故链：实现存在（unrealTools.ts）但 toolsetConfig 从未登记 `unreal_` ⇒ 归 utility（Low）⇒
	// focus 模式整条剔除 ⇒ LLM 与 tool_search 均不可见（`tool_describe unreal_exec → Tool not found`）。
	// 修复是**多层接线**：注册 → 归类（toolset）→ UI 名单 → 分发 → 卡片。任何一层断了，
	// 工具就"存在但不可见/难看"。本文件把每一层钉住（归类层另由 toolsetClassification 覆盖）。

	test('★★★ ① 注册：builtinToolProvider 无条件调用 _registerUnrealTools', () => {
		const src = code(PROVIDER);
		assert.ok(src.includes('this._registerUnrealTools()'),
			'provider 必须在注册链里调用 _registerUnrealTools —— 断了这步，工具根本不注册 ✗');
		assert.ok(src.includes("registerUnrealTools({"),
			'_registerUnrealTools 必须真正调起 unrealTools.registerUnrealTools ✗');
	});

	test('★★★ ② 归类：toolsetConfig 必须有 `unreal_` 前缀的独立 toolset（且不是 utility 兜底）', () => {
		const src = code(TOOLSET);
		assert.ok(/id:\s*'unreal'/.test(src), '必须有 id=unreal 的 toolset ✗');
		assert.ok(src.includes("prefixes: ['unreal_']"),
			"必须有 prefixes:['unreal_'] —— 没有它，unreal_* 会落进 utility(Low) 被 focus 模式整条剔除 ✗");
		// 且必须是 Always（focus 模式/子代理收窄都豁免 Always）
		const unrealBlock = src.slice(src.indexOf("id: 'unreal'"), src.indexOf("id: 'unreal'") + 400);
		assert.ok(/ToolsetPriority\.Always/.test(unrealBlock),
			'unreal toolset 必须是 Always —— 否则 focus 模式（代码工作区几乎必触发）会把它裁掉 ✗');
	});

	test('★★★ ③ UI 名单：TOOL_UNREAL_TOOLS 必须与注册名单**逐项一致**（本次活 bug 的钉）', () => {
		const src = read(BASE); // 名单本体是数组字面量，不能用剥注释后的串（名单行无注释，但内容要精确比对）
		const m = src.match(/TOOL_UNREAL_TOOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
		assert.ok(m, 'base.ts 必须定义 TOOL_UNREAL_TOOLS ✗');
		const names = [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]);
		assert.deepStrictEqual(names.sort(), [...UNREAL_TOOLS].sort(),
			'UI 名单与 unrealTools.ts 注册名单必须一致 —— 不一致的代价是「已注册工具拿不到专用卡片、'
			+ '不存在的工具占着分发位」（本次事故后暴露的第二层 bug）✗');
	});

	test('★★★ ④ 分发：toolCards 必须把 unreal_* 路由到专用卡片', () => {
		const src = code(TOOL_CARDS);
		assert.ok(src.includes('TOOL_UNREAL_TOOLS.has(key)'),
			'分发器必须有 unreal 分支 —— 断了它会落到通用工具卡片 ✗');
		assert.ok(src.includes('_createUnrealToolCard'),
			'分发必须指向 _createUnrealToolCard ✗');
	});

	test('★★★ ⑤ 卡片实现存在且 exec 有代码预览；bridge URL 设置已注册', () => {
		const card = code(UNREAL_CARD);
		assert.ok(card.includes('_createUnrealToolCard'), '卡片实现必须存在 ✗');
		assert.ok(card.includes("unreal_exec"), 'unreal_exec 的代码预览分支必须存在 ✗');
		const contrib = code(CONTRIBUTION);
		assert.ok(contrib.includes('AGENT_STUDIO_UNREAL_BRIDGE_URL_SETTING'),
			'bridge URL 设置必须注册（用户需要能改 bridge 基址）✗');
	});
});
