/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VsSaros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 看板**契约三方一致性**守卫（README 5.120，数据面 F 组）。
 *
 * 同一套词表被抄了三处，**没有类型系统能连起来**（两处 TS 分属不同 bundle ✓、dsh 侧是纯 JS ✓）：
 *
 *   1. **宿主真源** `src/vs/sessions/common/agentStudioTypes.ts`：`enum TaskBoardStatus` / `enum TaskSource`
 *      ＋ `DEFAULT_BOARD_ID` ＋ `TaskBoardRecord.priority` 的联合 ✓；
 *   2. **webview 镜像** `…/agentStudio/webview/src/store/useTaskBoardStore.ts`（注释自称 "Mirror of the host" ✓）；
 *   3. **dsh 插件** `dsh-plugins/vssaros-kanban/lib/core/taskboard.js` 的 `STATUSES` / `SOURCES` /
 *      `PRIORITIES` / `DEFAULT_BOARD_ID` ✓（注释自称"与 `TaskBoardStatus` **逐项一致**" ✓）。
 *
 * 为什么必须钉（2026-10-12 实测到一处**活的分叉** ✗）：webview 镜像原写 `'task-board' | 'delegation'` ✓，
 * 而 `'task-board'` **宿主不产生** ✓；宿主 `createTask` 是 `source: data.source || TaskSource.Manual`
 * （**不校验** ✗）⇒ 面板建卡会把 enum 之外的值**真的写进** `taskboard.json` ✓。三方对不上的表现是
 * **静默的**：类型没错、跑起来不报错、只是文件里多了一个谁也不认的字面 ✓（本仓反复吃过的病 ✓）。
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

/** 取 `export type X = 'a' | 'b';` 这类联合的成员值 ✓。 */
function unionValues(source: string, name: string): string[] {
	const line = new RegExp(`export type ${name} =([^;]+);`).exec(source)?.[1] ?? '';
	return [...line.matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
}

suite('dshHarness / 看板契约三方一致（宿主 enum ⇄ webview 镜像 ⇄ dsh 数组）', () => {

	test('★ 状态 / 来源 / 优先级 / 默认板：三处词表逐项相等（顺序无关）', async function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const hostSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'common', 'agentStudioTypes.ts'), 'utf8');
		const mirrorSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'src', 'store', 'useTaskBoardStore.ts'), 'utf8');
		const kanban = await import(pathToFileURL(path.join(root!, 'dsh-plugins', 'vssaros-kanban', 'lib', 'core', 'taskboard.js')).href) as {
			STATUSES: string[]; SOURCES: string[]; PRIORITIES: string[]; DEFAULT_BOARD_ID: string;
		};
		const sorted = (values: readonly string[]) => [...values].sort();

		// ① 状态：宿主的 enum 与 dsh 的八列
		assert.deepStrictEqual(sorted(kanban.STATUSES), enumValues(hostSrc, 'TaskBoardStatus'),
			'dsh 的 STATUSES 与宿主 enum TaskBoardStatus 不一致 ✗（dsh 注释自称"逐项一致" ✓）');
		assert.deepStrictEqual(unionValues(mirrorSrc, 'TaskBoardStatus'), enumValues(hostSrc, 'TaskBoardStatus'),
			'webview 镜像的 TaskBoardStatus 与宿主 enum 不一致 ✗');

		// ② 来源：宿主 enum / webview 镜像 / dsh 三处
		const hostSource = enumValues(hostSrc, 'TaskSource');
		assert.deepStrictEqual(sorted(kanban.SOURCES), hostSource,
			'dsh 的 SOURCES 与宿主 enum TaskSource 不一致 ✗');
		assert.deepStrictEqual(unionValues(mirrorSrc, 'TaskSource'), hostSource,
			'webview 镜像的 TaskSource 与宿主 enum 不一致 ✗（2026-10-12 就是这里漂了：写过 "task-board" ✓）');

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
});
