/*---------------------------------------------------------------------------------------------
 *  Session History View — **已退役**（2026-10-19）
 *
 *  历史：这里注册常驻容器 `sessionHistory.view` + 自绘列表（`SessionHistoryViewPane`）。
 *  后来会话历史的数据源与 UI 都迁到 dsh 插件页（`/x/sessions/`），本容器改为挂
 *  `DshPluginViewPane` 过渡了一段时间 —— 但 dsh 侧**自己的模块容器**（`vssaros.dsh.sessions`，
 *  见 `dshActivityBarContribution`）本来就挂着同一个插件页 ⇒ 活动栏出现**两个**一模一样的
 *  「历史会话」图标（2026-10-19 用户截图报障）✗。
 *
 *  ⇒ 本贡献**不再注册任何容器/视图**：会话历史入口只保留 dsh 模块容器那一条
 *    （符合用户定稿"会话历史的数据源与 UI 全部归 dsh，IDE 侧不再有任何会话逻辑"）。
 *
 *  ⚠ 回滚方式：把 `registerViewContainer` + `registerViews` 恢复，视图 ctor 用
 *    `new SyncDescriptor(DshPluginViewPane, ['vssaros.dsh.sessions'])`（或自绘列表
 *    `SessionHistoryViewPane`）—— 注意**只能选一个**，两个都注册就会再次出现双图标。
 *  ⚠ `SessionHistoryViewPane`（自绘列表）仍留在源码里，但**没有任何注册点**。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

/** 保留常量：其它流/命令面板可能按 id 引用（本文件不再注册它们）。 */
export const SESSION_HISTORY_VIEW_CONTAINER_ID = 'sessionHistory.view';
export const SESSION_HISTORY_VIEW_ID = 'sessionHistory.view.main';
export const SESSION_HISTORY_PLUGIN_VIEW_ID = 'sessionHistory.view.plugin';

class SessionHistorySidebarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sessionHistorySidebar';

	constructor() {
		super();
		// 空实现：入口由 dsh 模块容器（`vssaros.dsh.sessions`）提供 ⇒ 这里**不再注册**任何东西，
		// 否则活动栏会出现第二个「历史会话」图标（用户 2026-10-19 报障）。
	}
}

registerWorkbenchContribution2(
	SessionHistorySidebarContribution.ID,
	SessionHistorySidebarContribution,
	WorkbenchPhase.BlockStartup
);
