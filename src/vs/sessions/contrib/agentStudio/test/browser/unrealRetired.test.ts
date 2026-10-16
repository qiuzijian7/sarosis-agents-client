/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ✅ unreal 族（七个 `unreal_*`）**已整份下移到 dsh 侧** —— 本文件是**退役断言**（2026-10-13）。
 *
 * 为什么需要它 ✗：本目录原有一份 `unrealToolCard.test.ts`，检的是那一族的**多层接线**
 * （注册 → 归类（toolset）→ UI 名单 → 卡片）—— 源自 2026-09-21 的事故：实现存在，
 * 但 `toolsetConfig` 没登记 `unreal_` 前缀 ⇒ 落 `utility` 兜底桶 ⇒ focus 模式整条剔除 ⇒
 * **LLM 与 tool_search 均不可见且零日志**（`tool_describe unreal_exec → Tool not found`）。
 *
 * 现在那一族**整体搬走**了（`dsh-plugins/vssaros-unreal` ✓：Host 进程内直连 `/bridge/*` ✓，
 * 执行类三个挂官方审批闸 ✓），所以正确的检查**反了过来** ✓：多层接线必须**整份消失** ✗ ——
 * 任何一层残留都会重新变成"两边各一份"（dsh 侧同名注册是**静默顶掉** ✗）或让清单说谎 ✗。
 *
 * ⚠ 仍未做（stage 2，见 ④ 的说明 ✓）：`agentChat` 的展示层（工具卡 / unreal 终端视图 / 结果预览 /
 * 设置行）还在 ✗ —— 它们是"给那七个工具的结果画界面"的 ✓，工具没了就是死代码 ✓，但删除要连带动 UI 测试，
 * 属独立一步 ✓。
 *
 * 运行：node src/vs/sessions/contrib/agentStudio/test/browser/run-all-browser-tests.mjs
 */

const ROOT = process.cwd();
const PROVIDER = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/builtinToolProvider.ts';
const TOOLSET = 'src/vs/sessions/contrib/agentStudio/common/toolsetConfig.ts';
const MANIFEST_TS = 'src/vs/sessions/contrib/dshHarness/common/vssarosPluginManifest.ts';
const UNREAL_TOOLS_REL = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/unrealTools.ts';
const HOST_CORE = 'dsh-plugins/vssaros-unreal/lib/core/bridge.js';

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 剥注释：防"注释写了退役、代码还在跑"式假绿（与旧接线断言同一手法 ✓）。 */
const code = (rel: string): string => read(rel)
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/^[ \t]*\/\/.*$/gm, '');

suite('unreal 族已整份下移到 dsh 侧（2026-10-13 退役断言）', () => {

	test('① IDE 侧不再有实现与注册点', () => {
		assert.ok(!fs.existsSync(path.join(ROOT, UNREAL_TOOLS_REL)),
			'`unrealTools.ts` 应当已被删除 ✗（该族只有 dsh 侧一份实现）');
		const src = code(PROVIDER);
		assert.ok(!/registerUnrealTools/.test(src),
			'`builtinToolProvider` 仍引用 `registerUnrealTools` ⇒ 会把已删的模块 import 进来 ✗');
		assert.ok(!/_registerUnrealTools\s*\(/.test(src),
			'仍存在 `_registerUnrealTools()` 调用/定义 ⇒ IDE 侧会再注册一份同名工具（dsh 侧是静默顶掉 ✗）');
	});

	test('② 不再有 `unreal_` 归类条目（没有工具就没有 toolset）', () => {
		const src = code(TOOLSET);
		assert.ok(!/id:\s*'unreal'/.test(src), 'toolsetConfig 里仍有 id=unreal 的条目 ✗');
		assert.ok(!/prefixes:\s*\['unreal_'\]/.test(src), "toolsetConfig 里仍有 prefixes:['unreal_'] ✗");
	});

	test('③ 不再有 `unreal` 能力名（IDE 反向通道那条早已删除 ⇒ 留着只会误导清单）', () => {
		const src = code(MANIFEST_TS);
		assert.ok(!/['"]unreal['"]/.test(src),
			'`VSSAROS_IDE_CAPABILITIES` 里仍有 `unreal` ✗ —— 永远不会有调用者的能力名会稀释"这个插件能驱动 IDE 到什么程度"的语义');
	});

	test('④ dsh 侧是唯一实现：七个工具的黄金契约在那边（见 dshUnrealPlugin.test.ts 的黄金表）', () => {
		const core = read(HOST_CORE);
		for (const name of ['unreal_health', 'unreal_exec', 'unreal_wait', 'unreal_help', 'unreal_dump', 'unreal_build', 'unreal_find_asset']) {
			assert.ok(core.includes(`'${name}'`), `dsh 侧缺工具 ${name} ✗（黄金表在 dshUnrealPlugin.test.ts）`);
		}
		for (const endpoint of ['/bridge/health', '/bridge/exec', '/bridge/wait_probe', '/bridge/help', '/bridge/dump', '/bridge/build', '/bridge/find_asset']) {
			assert.ok(core.includes(`'${endpoint}'`), `dsh 侧缺端点 ${endpoint} ✗`);
		}
	});
});
