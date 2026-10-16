/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VsSaros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作流**节点契约**一致性守卫（README 5.121，数据面 F 组）。
 *
 * dsh 的 `workflow_get_schema` 会把节点目录**讲给模型** ✓，而它的"规范性内容从写侧常量推导" ✓
 * （`NODE_TYPE_ALIASES` / `NODE_META_KEYS` ✓）。一旦与 IDE 引擎分叉 ✗，后果比看板那边重得多 ✓：
 * 模型会写出**校验通过、但引擎不认**的图 ✓。
 *
 * 钉两件（都是 2026-10-12 查出来的真边界 ✓）：
 *   ① **别名映射必须与引擎逐项相同** ✓ —— 引擎 `workflowExecutionService.ts:47` 的
 *      `NODE_TYPE_ALIASES`（`branch` / `condition` / **`ifelse`** ✓）是所有写法的归一入口 ✓；
 *      这里实测过少一项 ✗（dsh 缺 `ifelse` ⇒ 同一份输入两边归一结果不同 ✓，且**不报错** ✗）。
 *   ② **dsh 宣称的节点类型必须是引擎认的集合的子集** ✓（dsh 刻意只教写侧支持的 6 个 ✓，
 *      未知类型不改也不拦 ✓ ⇒ 只断"不含引擎不认的" ✗，不断"必须全列" ✓）。
 *   ③ 顺带钉**宿主 enum ⇄ webview 镜像**（`WorkflowNodeType` 两份实现 ✓）—— 与看板那次同一类腐烂 ✓。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 从 cwd 往上找仓库根（同 `dshWorkflowWriteLock.test.ts` 的约定）。 */
function repoRoot(): string | undefined {
	let dir = path.resolve(process.cwd());
	for (let depth = 0; depth < 6; depth += 1) {
		if (fs.existsSync(path.join(dir, 'dsh-plugins')) && fs.existsSync(path.join(dir, 'src'))) { return dir; }
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return undefined;
}

/**
 * 取 `enum X { A = 'a', … }` 的 成员名 → 值 ✓。
 *
 * ⚠ `WorkflowNodeType` 是 **`export const enum`** ✗（我第一版只写了 `export enum` ⇒ 解析出空表 ✓、
 * 于是断言报"引擎引用了宿主 enum 里没有的成员" ✓ —— 报的是**解析失败**、看起来却像内容不一致 ✗）。
 * 行尾也要容忍 CRLF ✓。
 */
function enumMap(source: string, name: string): Record<string, string> {
	const block = new RegExp(`export (?:const )?enum ${name} \\{([\\s\\S]*?)\\r?\\n\\}`).exec(source)?.[1] ?? '';
	return Object.fromEntries([...block.matchAll(/(\w+)\s*=\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
}

suite('dshHarness / 工作流节点契约（引擎别名 ⇄ dsh 别名；类型目录 ⊆ 引擎认的）', () => {

	test('★ 别名映射与引擎逐项相同；dsh 宣称的类型不含引擎不认的', async function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const engineSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'workflowExecutionService.ts'), 'utf8');
		const hostTypesSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'common', 'workflowStorage.ts'), 'utf8');
		const store = await import(pathToFileURL(path.join(root!, 'dsh-plugins', 'vssaros-workflow', 'lib', 'store.js')).href) as {
			NODE_TYPE_ALIASES: Record<string, string>;
		};

		// ① 引擎的别名表：`Object.freeze({ key: WorkflowNodeType.X, … })` ⇒ 用 enum 解析成字面量 ✓
		const memberToValue = enumMap(hostTypesSrc, 'WorkflowNodeType');
		const engineBlock = /const NODE_TYPE_ALIASES:[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(engineSrc)?.[1] ?? '';
		const engineAliases = Object.fromEntries([...engineBlock.matchAll(/(\w+):\s*WorkflowNodeType\.(\w+)/g)].map(m => {
			const value = memberToValue[m[2]];
			assert.ok(value !== undefined, `引擎别名表引用了 WorkflowNodeType.${m[2]}，但宿主 enum 里没有它 ✗`);
			return [m[1], value];
		}));
		assert.ok(Object.keys(engineAliases).length >= 3, `引擎别名表没解析出来（${JSON.stringify(engineAliases)}）✗`);
		assert.deepStrictEqual(store.NODE_TYPE_ALIASES, engineAliases,
			'dsh 的 NODE_TYPE_ALIASES 与引擎的逐项不一致 ✗（少一项时**不报错**、只是两边归一结果不同 ✓ —— 2026-10-12 就是这样少了一个 `ifelse`）');

		// ② dsh 宣称的类型 ⊆ 引擎认的类型（`ORCHESTRATION_TYPES`）—— 刻意只教子集 ✓，但不许教引擎不认的 ✗
		const orchestration = [...(/const ORCHESTRATION_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(engineSrc)?.[1] ?? '')
			.matchAll(/'([^']+)'/g)].map(m => m[1]);
		assert.ok(orchestration.length >= 10,
			`引擎的 ORCHESTRATION_TYPES 没解析出来（拿到 ${orchestration.length} 项：${orchestration.join(', ') || '空'}）✗`);
		const teachingSrc = fs.readFileSync(path.join(root!, 'dsh-plugins', 'vssaros-workflow', 'lib', 'core', 'schema.js'), 'utf8');
		const taught = [...teachingSrc.matchAll(/type:\s*'([^']+)'/g)].map(m => m[1]).sort();
		assert.ok(taught.length >= 5, `dsh 的 schema 目录没解析出来（${taught.length} 项）✗`);
		const unknown = taught.filter(type => !orchestration.includes(type));
		assert.deepStrictEqual(unknown, [],
			`dsh 讲给模型的这些类型**引擎不认** ✗：${unknown.join(', ')}（模型会写出校验通过但跑不起来的图 ✓）`);

		// ③ 宿主 enum ⇄ webview 镜像：**实测不一致，但没做断言** ✗（2026-10-12 查过，理由如下 ✓）
		//
		//   实测差异（`common/workflowStorage.ts` 14 项 ⇄ `webview/src/types/workflowStorage.ts` 16 项）：
		//     · 镜像**有**而宿主没有：`Condition = 'condition'` / `Parallel = 'parallel'` / `Loop = 'loop'`；
		//     · 宿主**有**而镜像没有：`Script = 'script'`（另有 Picker 家族待核 ✗）。
		//
		//   ⚠ 这**可能不是腐烂** ✓：镜像服务的是**画布**（能画什么 ✓），宿主 enum 服务的是**引擎**（能跑什么 ✓）——
		//   引擎自己的 `NON_EXECUTING_TYPES` 里就写着 `group` / `loop` / `parallel` ✓（"布局分组/控制容器，
		//   保持归一原值落 default「skipping」是**正确**行为" ✓）⇒ 两套词汇表**本来就不同** ✓。
		//   而看板那次（README 5.120）是**同一个词表被抄错** ✗ —— 形状像、性质不同 ✓。
		//   ⇒ 要钉它得先定"镜像允许比宿主多哪些、少哪些" ✓（那是产品/画布契约 ✗，不是我这轮能拍板的 ✓）
		//   ⇒ **先不写断言，只把证据留在代码里** ✓（本仓规矩：宁可留一条有依据的"未钉"，也不假装钉了 ✗）。
	});
});
