/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VsSaros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 看板**契约一致性**守卫（README 5.120，数据面 F 组）。
 *
 * 同一套词表被抄了两处，**没有类型系统能连起来**（一处 TS、一处纯 JS ✓）：
 *
 *   1. **宿主真源** `src/vs/sessions/common/agentStudioTypes.ts`：`enum TaskBoardStatus` / `enum TaskSource`
 *      ＋ `DEFAULT_BOARD_ID` ＋ `TaskBoardRecord.priority` 的联合 ✓；
 *   2. **dsh 插件** `dsh-plugins/vssaros-kanban/lib/core/taskboard.js` 的 `STATUSES` / `SOURCES` /
 *      `PRIORITIES` / `DEFAULT_BOARD_ID` ✓（注释自称"与 `TaskBoardStatus` **逐项一致**" ✓）。
 *
 * ⚠ 2026-10-18：**第三方（webview 镜像）已退役** —— `agentStudio/webview/src/store/useTaskBoardStore.ts`
 * 随 5.2（React webview 拆分：taskboard 面板退役）删除 ✓。该镜像曾是 2026-10-12 那处**活的分叉**的所在
 * （写过宿主不产生的 `'task-board'` ✓）；现在 webview 里根本没有看板面板 ⇒ 镜像消失了，契约收敛成两方 ✓。
 * 本守卫相应收窄：只比宿主 ⇄ dsh ✓（不再读已删文件 ⇒ 否则 ENOENT ✗）。
 *
 * 为什么仍必须钉：宿主 `createTask` 是 `source: data.source || TaskSource.Manual`（**不校验** ✗）⇒
 * 面板建卡可以把 enum 之外的值**真的写进** `taskboard.json` ✓。两方对不上的表现是**静默的**：
 * 类型没错、跑起来不报错、只是文件里多了一个谁也不认的字面 ✓（本仓反复吃过的病 ✓）。
 *
 * ⚠ 只断**词表集合**（顺序无关 ✓），不断顺序、不断措辞 ✓ —— 顺序是各自 UI 的事 ✓（dsh 的数组顺序
 * 表示看板列顺序 ✓，宿主 enum 的书写顺序不是契约 ✓）。
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

/** 取一个 TS `enum` 块的成员值（`X = 'a'` 形态；注释与成员名一律不参与 ✓）。 */
function enumValues(source: string, name: string): string[] {
	const block = new RegExp(`export enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? '';
	return [...block.matchAll(/=\s*'([^']+)'/g)].map(m => m[1]).sort();
}

// 2026-10-18：`unionValues` 摘了——它只用于比对已退役的 webview 镜像（useTaskBoardStore.ts 已删 ✓）。

suite('dshHarness / 看板契约两方一致（宿主 enum ⇄ dsh 数组）', () => {

	test('★ 状态 / 来源 / 优先级 / 默认板：两处词表逐项相等（顺序无关）', async function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const hostSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'common', 'agentStudioTypes.ts'), 'utf8');
		const kanban = await import(pathToFileURL(path.join(root!, 'dsh-plugins', 'vssaros-kanban', 'lib', 'core', 'taskboard.js')).href) as {
			STATUSES: string[]; SOURCES: string[]; PRIORITIES: string[]; DEFAULT_BOARD_ID: string;
		};
		const sorted = (values: readonly string[]) => [...values].sort();

		// ① 状态：宿主的 enum 与 dsh 的八列
		assert.deepStrictEqual(sorted(kanban.STATUSES), enumValues(hostSrc, 'TaskBoardStatus'),
			'dsh 的 STATUSES 与宿主 enum TaskBoardStatus 不一致 ✗（dsh 注释自称"逐项一致" ✓）');

		// ② 来源：宿主 enum / dsh 两处
		const hostSource = enumValues(hostSrc, 'TaskSource');
		assert.deepStrictEqual(sorted(kanban.SOURCES), hostSource,
			'dsh 的 SOURCES 与宿主 enum TaskSource 不一致 ✗');

		// ③ 优先级：宿主写在 `TaskBoardRecord.priority` 的联合里（不是 enum ✓）
		const priorityLine = /priority\?:\s*([^;]+);/.exec(hostSrc)?.[1] ?? '';
		assert.deepStrictEqual(sorted(kanban.PRIORITIES), [...priorityLine.matchAll(/'([^']+)'/g)].map(m => m[1]).sort(),
			'dsh 的 PRIORITIES 与宿主 TaskBoardRecord.priority 的联合不一致 ✗');

		// ④ 默认板：常量（不是词表 ✓）
		assert.ok(hostSrc.includes(`export const DEFAULT_BOARD_ID = 'default';`),
			'宿主 DEFAULT_BOARD_ID 变了 ✗（dsh 与 webview 都按 "default" 兜底 ✓）');
		assert.strictEqual(kanban.DEFAULT_BOARD_ID, 'default',
			'dsh 的 DEFAULT_BOARD_ID 与宿主不一致 ✗');
	});

	test('★ 入口开关：legacy 自动执行链接了 entry.kanban 闸（重构 2.2，防双执行）', function () {
		// 为什么钉：legacy `updateTask` 在任务转 Running 时会自动 `executeTaskForBoard`；dsh runner 也盯着
		// 同一个文件 ⇒ 两边同时跑 = 双执行 ✗。闸在 `agentTaskBoardService.ts`（读 `DshHarnessSettings.EntryKanban`）。
		// 没有这条守卫，重构期有人把闸删掉 ⇒ 静默双执行，而且很难发现（两边都"看起来在跑"）✗。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const legacy = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'agentTaskBoardService.ts'), 'utf8');
		assert.match(legacy, /DshHarnessSettings\.EntryKanban/, 'legacy 执行链没读 entry.kanban 闸 ⇒ 双执行风险 ✗');
		assert.match(legacy, /由 dsh runner 拾取/, '闸的日志话术变了（守卫锚点）');
		// runner 侧：kanban 插件必须真的装了 runner（拖入 running ⇒ 拾取的循环）
		const kanbanIndex = fs.readFileSync(path.join(root!, 'dsh-plugins', 'vssaros-kanban', 'lib', 'index.js'), 'utf8');
		assert.match(kanbanIndex, /createKanbanRunner/, 'kanban 插件没接 runner ⇒ entry.kanban=dsh 时任务没人跑 ✗');
	});
});
