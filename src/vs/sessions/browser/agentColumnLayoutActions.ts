/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { localize, localize2 } from '../../nls.js';
import { Categories } from '../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService } from '../../workbench/services/layout/browser/layoutService.js';
import { AgentsEditorColumnAvailableContext, AgentsEditorColumnLeftContext } from '../common/contextkeys.js';

/**
 * ★★ [Saros] 「编辑器列 ⇄ Agent 列」换位的**入口层**（2026-10-13）。
 *
 * ── 为什么单独成文件，而不是塞进 `sessions/browser/layoutActions.ts` ──────────
 * `layoutActions.ts` 只被 `sessions/sessions.common.main.ts` 引入，而
 * **agents 布局窗口（IDE 底座）刻意不引入 `sessions.common.main`**
 * （见 `sessions/agentLayout.desktop.main.ts` 的 ⚠⚠ 注释：一旦引入，sessions 那批
 * singleton 覆盖会把底座抢回去，"IDE 底座"这个前提直接失效）。
 * ⇒ 本文件由 `agentLayout.desktop.main.ts` 作为**有意例外**单独引入
 * （与 `agentStudio.contribution` / `paneCompositePartService` 同一处）。
 *
 * ── 四个入口共用同一份实现 ────────────────────────────────────────────────
 * - **标题栏按钮**：`MenuId.TitleBar`（上游 `titlebarPart.ts` 的 global toolbar
 *   就是渲染这个菜单 ⇒ 带 icon 的条目会成为一个可点的标题栏按钮）。
 * - **标签右键菜单**：`MenuId.EditorTitleContext`（有标签栏时才可达）。
 * - **空编辑器区右键**：`MenuId.EmptyEditorGroupContext` —— ⚠ 这一条是**主力**：
 *   本窗口文件区启动时是空的，且 `showTabs` 默认 `multiple`（单编辑器时标签栏隐藏）
 *   ⇒ 只挂标签右键的话多数时候点不到（理由详见下方菜单项处的注释）。
 * - **命令面板**：`f1: true`（也便于用户自己绑快捷键）。
 *
 * ── ⚠ 为什么是**上游** `MenuId.TitleBar` 而不是某个 sessions 标题栏按钮 ──────────
 * 本窗口的标题栏是**上游**的：`workbench.desktop.main.ts` →
 * `workbench/services/title/electron-browser/titleService.js` → `MainNativeTitlebarPart`。
 * sessions 那套 `TitleService` / `sessions/browser/parts/titlebarPart.ts` 的按钮
 * **不在本窗口**（只被 `sessions.desktop.main.ts` / `sessions.web.main.ts` /
 * sessions 版 `Workbench` 引入）⇒ 上游 `BrowserTitlebarPart` 的 global toolbar
 * 是唯一能加标题栏按钮的地方，它渲染的就是 `MenuId.TitleBar`
 * （先例：通知铃铛也注册在那里）。
 *
 * ── 门禁（保留，理由见 contextkeys.ts）────────────────────────────────
 * 所有条目都带 `when: AgentsEditorColumnAvailableContext`。严格说它**不是**为了让入口
 * 不外泄（本模块只被 `agentLayout.desktop.main.ts` 引入 ⇒ 别的窗口连命令都没有），
 * 而是 ① 给 moveLeft/moveRight 提供启用态；② 万一以后被引入到别的入口时立刻兜住。
 *
 * ── 机制在别处 ─────────────────────────────────────────────────────────
 * 真正的网格重排 + 状态在 `workbench/browser/layout.ts#moveAgentsEditorColumn()`
 * （`workbenchGrid` 是 private，只有那里能动）；持久化与 context key 在
 * `AgentLayoutWorkbench`。这里只负责「点什么、调谁」。
 */

/**
 * 统一取方位并调用接缝。
 *
 * `moveAgentsEditorColumn` 在接口上是**可选**的：只有 `Layout`（标准窗口/agents 布局窗口
 * 的基类）实现它，sessions 窗口的 `Workbench` 没实现 ⇒ 用 `?.()` 静默 no-op。
 * 即便方法存在，标准 IDE 窗口下也会因 `AGENT_EDITOR_PART` 不存在而立刻返回。
 */
function moveAgentColumn(accessor: ServicesAccessor, side: 'left' | 'right'): void {
	const layoutService = accessor.get(IWorkbenchLayoutService);
	layoutService.moveAgentsEditorColumn?.(side);
}

/** 当前 Agent 列是否在左（读 context key —— 由 `AgentLayoutWorkbench` 维护）。 */
function isAgentColumnLeft(accessor: ServicesAccessor): boolean {
	return AgentsEditorColumnLeftContext.getValue(accessor.get(IContextKeyService)) === true;
}

/** 交换：左 → 右、右 → 左。 */
class ToggleEditorAndAgentColumnAction extends Action2 {

	static readonly ID = 'vssaros.layout.toggleEditorAndAgentColumn';

	constructor() {
		super({
			id: ToggleEditorAndAgentColumnAction.ID,
			title: localize2('vssaros.toggleEditorAndAgentColumn', "Swap Editor Column and Agent Column Position"),
			icon: Codicon.arrowBoth,
			category: Categories.View,
			f1: true,
			metadata: {
				description: localize('vssaros.toggleEditorAndAgentColumn.desc', "Swap the file editor column and the Agent column (the sidebar and the panel keep their places)"),
			},
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: 6,
					when: AgentsEditorColumnAvailableContext,
				},
				{
					id: MenuId.EditorTitleContext,
					group: 'navigation',
					order: 30,
					when: AgentsEditorColumnAvailableContext,
				},
				// ⚠ 必须再挂 `EmptyEditorGroupContext`（2026-10-13 复核）：标签右键菜单由
				// `editorTabsControl.ts:537` 提供 ⇒ **只有标签栏渲染出来才可达**，而
				// `workbench.editor.showTabs` 默认 `multiple`（单个编辑器时标签栏是隐藏的），
				// 且本窗口的文件区**启动时本来就是空的**（`Sidebar | Editor(空) | AgentEditor`）
				// ⇒ 只挂标签右键的话，绝大多数时刻右键点不到。空组右键走
				// `editorGroupView.ts:457` 的 `EmptyEditorGroupContext`，正好覆盖这个状态。
				{
					id: MenuId.EmptyEditorGroupContext,
					group: 'navigation',
					order: 30,
					when: AgentsEditorColumnAvailableContext,
				},
			],
		});
	}

	run(accessor: ServicesAccessor): void {
		moveAgentColumn(accessor, isAgentColumnLeft(accessor) ? 'right' : 'left');
	}
}

/** 把 Agent 列移到**左**（当前已在左时不显示）。 */
class MoveAgentColumnLeftAction extends Action2 {

	static readonly ID = 'vssaros.layout.moveAgentColumnLeft';

	constructor() {
		super({
			id: MoveAgentColumnLeftAction.ID,
			title: localize2('vssaros.moveAgentColumnLeft', "Move Agent Column Left"),
			icon: Codicon.layoutSidebarLeft,
			category: Categories.View,
			f1: true,
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: 7,
					when: ContextKeyExpr.and(AgentsEditorColumnAvailableContext, AgentsEditorColumnLeftContext.negate()),
				},
				{
					id: MenuId.EditorTitleContext,
					group: 'navigation',
					order: 31,
					when: ContextKeyExpr.and(AgentsEditorColumnAvailableContext, AgentsEditorColumnLeftContext.negate()),
				},
				{
					id: MenuId.EmptyEditorGroupContext,
					group: 'navigation',
					order: 31,
					when: ContextKeyExpr.and(AgentsEditorColumnAvailableContext, AgentsEditorColumnLeftContext.negate()),
				},
			],
		});
	}

	run(accessor: ServicesAccessor): void {
		moveAgentColumn(accessor, 'left');
	}
}

/** 把 Agent 列移到**右**（当前已在右时不显示）。 */
class MoveAgentColumnRightAction extends Action2 {

	static readonly ID = 'vssaros.layout.moveAgentColumnRight';

	constructor() {
		super({
			id: MoveAgentColumnRightAction.ID,
			title: localize2('vssaros.moveAgentColumnRight', "Move Agent Column Right"),
			icon: Codicon.layoutSidebarRight,
			category: Categories.View,
			f1: true,
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: 8,
					when: ContextKeyExpr.and(AgentsEditorColumnAvailableContext, AgentsEditorColumnLeftContext),
				},
				{
					id: MenuId.EditorTitleContext,
					group: 'navigation',
					order: 32,
					when: ContextKeyExpr.and(AgentsEditorColumnAvailableContext, AgentsEditorColumnLeftContext),
				},
				{
					id: MenuId.EmptyEditorGroupContext,
					group: 'navigation',
					order: 32,
					when: ContextKeyExpr.and(AgentsEditorColumnAvailableContext, AgentsEditorColumnLeftContext),
				},
			],
		});
	}

	run(accessor: ServicesAccessor): void {
		moveAgentColumn(accessor, 'right');
	}
}

registerAction2(ToggleEditorAndAgentColumnAction);
registerAction2(MoveAgentColumnLeftAction);
registerAction2(MoveAgentColumnRightAction);

// ★ 诊断：本模块**加载即注册**，所以只要这一行出现在 renderer 日志里，就说明
//   入口模块确实被引入、三个命令存在。反之若日志里没有它，问题在"模块没被加载/产物没重建"，
//   而不在菜单门禁上 —— 排查时先看这一行，别先去怀疑 context key。
//   grep：`[Sarosis][AgentColumnLayout]`
console.info('[Sarosis][AgentColumnLayout] actions registered: swap / moveLeft / moveRight (MenuId.TitleBar + EditorTitleContext + EmptyEditorGroupContext + f1)');
