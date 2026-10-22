/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

//#region < --- Active Session --- >

export const IsNewChatSessionContext = new RawContextKey<boolean>('isNewChatSession', true);

/**
 * 「这个**编辑器组**在中间栏（main part）里吗」——**组作用域**的 key。
 *
 * 为什么必须是**组作用域**而不是全局 key（2026-10-21，中间栏多聊天入口 UI）：
 *   `MenuId.EditorTitle`（组标题栏右侧动作区）与 `MenuId.EmptyEditorGroup`（空组右上角）
 *   都用**该组自己的** scoped context key service 解析 when
 *   （`editorGroupView.ts:2095` 用 `activeEditorPane.scopedContextKeyService ?? this.scopedContextKeyService`；
 *    `editorGroupView.ts:418` 空组 ActionBar 用 `this.scopedContextKeyService`）
 *   ⇒ 每个组能**各自**回答"我在不在中间栏" ✓。
 *   用全局 key 的话，中间栏之外的组（右侧 agent 专区、popout 窗口）也会长出同一个 ＋ 按钮，
 *   而点击落点又按**活动**组算 ⇒ 按钮所在位置与实际行为对不上 ✗。
 *
 * 维护方：`sessions/contrib/agentStudio/browser/middleColumnChatEntry.ts`。
 */
export const EditorGroupInMainPartContext = new RawContextKey<boolean>('vssaros.editorGroupInMainPart', false, localize('vssaros.editorGroupInMainPart', "Whether the editor group lives in the main (middle) editor part"));
export const IsNewChatInSessionContext = new RawContextKey<boolean>('isNewChatInSession', false, localize('isNewChatInSession', "Whether the user is composing a new chat within the active session"));
export const ActiveSessionProviderIdContext = new RawContextKey<string>('activeSessionProviderId', '', localize('activeSessionProviderId', "The provider ID of the active session"));
export const ActiveSessionTypeContext = new RawContextKey<string>('activeSessionType', '', localize('activeSessionType', "The session type of the active session"));
export const IsActiveSessionBackgroundProviderContext = new RawContextKey<boolean>('isActiveSessionBackgroundProvider', false, localize('isActiveSessionBackgroundProvider', "Whether the active session uses the background agent provider"));
export const IsActiveSessionArchivedContext = new RawContextKey<boolean>('isActiveSessionArchived', false, localize('isActiveSessionArchived', "Whether the active session is archived (marked as done)"));
export const ActiveSessionHasGitRepositoryContext = new RawContextKey<boolean>('activeSessionHasGitRepository', false, localize('activeSessionHasGitRepository', "Whether the active session has an associated git repository"));
export const ChatSessionProviderIdContext = new RawContextKey<string>('chatSessionProviderId', '', localize('chatSessionProviderId', "The provider ID of a session in context menu overlays"));

//#endregion

//#region < --- Sidebar --- >

export const SidebarContentVisibleContext = new RawContextKey<boolean>('sidebarContentVisible', false, localize('sidebarContentVisible', "Whether the sidebar content panel is expanded (visible)"));

//#endregion

//#region < --- Chat Bar --- >

export const ActiveChatBarContext = new RawContextKey<string>('activeChatBar', '', localize('activeChatBar', "The identifier of the active chat bar panel"));
export const ChatBarFocusContext = new RawContextKey<boolean>('chatBarFocus', false, localize('chatBarFocus', "Whether the chat bar has keyboard focus"));
export const ChatBarVisibleContext = new RawContextKey<boolean>('chatBarVisible', false, localize('chatBarVisible', "Whether the chat bar is visible"));

//#endregion

//#region < --- Welcome --- >

export const SessionsWelcomeVisibleContext = new RawContextKey<boolean>('sessionsWelcomeVisible', false, localize('sessionsWelcomeVisible', "Whether the sessions welcome overlay is visible"));

//#endregion

//#region < --- Workspace Picker --- >

export const SessionWorkspacePickerGroupContext = new RawContextKey<string>('sessionWorkspacePickerGroup', '', localize('sessionWorkspacePickerGroup', "The currently active group tab in the session workspace picker"));

//#endregion

//#region < --- Aquarium --- >

export const SessionsAquariumActiveContext = new RawContextKey<boolean>('sessionsAquariumActive', false, localize('sessionsAquariumActive', "Whether the sessions aquarium overlay is active"));

//#endregion

//#region < --- Editor --- >

export const EditorMaximizedContext = new RawContextKey<boolean>('editorMaximized', false, localize('editorMaximized', "Whether the editor area is maximized"));

//#endregion

//#region < --- Mobile Layout --- >

export const IsPhoneLayoutContext = new RawContextKey<boolean>('sessionsIsPhoneLayout', false, localize('sessionsIsPhoneLayout', "Whether the current layout is the phone layout"));
export const KeyboardVisibleContext = new RawContextKey<boolean>('sessionsKeyboardVisible', false, localize('sessionsKeyboardVisible', "Whether the virtual keyboard is visible"));

//#endregion

//#region < --- Agent Studio --- >

export const AgentStudioActiveContext = new RawContextKey<boolean>('agentStudio.active', false, localize('agentStudioActive', "Whether Agent Studio multi-agent workspace is active"));

//#endregion

//#region < --- Agent 列方位（agents 布局） --- >

/**
 * ★ [Saros] 当前窗口是否提供「编辑器列 ⇄ Agent 列」换位能力 ——
 * 由 `AgentLayoutWorkbench` 在网格建好后置 `true`（`wireAgentsEditorColumnSideContextKeys()`）。
 *
 * ⚠ 它不是"隐藏入口"用的（那 3 个 action 只由 `agentLayout.desktop.main.ts` 引入 ⇒
 * 标准 IDE / sessions 窗口**根本没注册这些命令**，本就不会多出入口）。它的作用是：
 * ① 给 `moveAgentColumnLeft/Right` 提供**启用态**（当前方位那一侧不显示）；
 * ② 兜底：万一该 action 模块以后被引入到别的入口（web / sessions），门禁立刻生效。
 */
export const AgentsEditorColumnAvailableContext = new RawContextKey<boolean>('vssaros.agentsEditorColumnAvailable', false, localize('agentsEditorColumnAvailable', "Whether the window can swap the editor column and the Agent column"));

/** ★ [Saros] Agent 列当前是否在**左**（= 编辑器列在右）。用于菜单项的启用态与文案。 */
export const AgentsEditorColumnLeftContext = new RawContextKey<boolean>('vssaros.agentsEditorColumnLeft', false, localize('agentsEditorColumnLeft', "Whether the Agent column is currently on the left"));

//#endregion
