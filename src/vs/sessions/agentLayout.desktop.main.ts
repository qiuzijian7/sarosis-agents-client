/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// #######################################################################
// ###                                                                 ###
// ###  [Saros] 「IDE 底座 + Agent 布局」的**第三个**渲染层入口。       ###
// ###                                                                 ###
// ###  与另两个入口的关系：                                            ###
// ###   - workbench.desktop.main.ts → 标准 IDE 窗口（upstream 底座）   ###
// ###   - sessions.desktop.main.ts  → agents 窗口（sessions 底座）     ###
// ###   - 本文件                      → agents 布局跑在**标准底座**上  ###
// #######################################################################


//#region --- workbench (standard base) ---
//
// ★ 一行拿到**全套标准贡献 + 标准服务**。
//
// 为什么可以这样复用：`workbench.desktop.main.ts` 只负责"注册贡献"，
// 它 export 的 `main` 由 bootstrap 显式调用，**不会自己执行** —— 所以把它 import
// 进来不会顺带启动标准窗口。本模块随后用同名导出覆盖它即可。
//
// ⚠⚠ 绝不能在这里 import `./sessions.common.main.js`。
// 那是 `workbench.common.main.js` 的 sessions 对位物，sessions 那批**覆盖标准
// singleton** 的注册（`ConfigurationService` / `EditorParts` / `PaneCompositePartService` /
// `SessionsWorkspaceContextService` …）就在其中。而 `registerSingleton` 是
// **后注册者胜出** ⇒ 一旦引入，底座就被 sessions 抢回去，"IDE 底座"这个前提直接失效。
// （`sessionsConfigIsolation.test.ts` 有用例锁这条。）

import '../workbench/workbench.desktop.main.js';

//#endregion


//#region --- sessions contributions (deliberately minimal) ---
//
// ★ [Saros] 这里是上面那条规则的一处**有意例外**，请连注释一起读。
//
// 规则是"不引入 sessions 的 singleton 覆盖"（见上一段），目的是保住标准底座。
// 但右侧 `AGENT_EDITOR_PART` 的内容（Canvas / Chat）是 **sessions 侧**的
// `AgentStudioEditorInput` / `NativeChatEditorInput`，它们的 editor pane 注册在
// `contrib/agentStudio/browser/agentStudio.contribution.ts` 里（约 1300 行）。
// 没有它，右侧只能是一块空编辑器水印（真机截图确认）。
//
// 所以这里**按需**引入两个文件，而**不是**引入整个 `sessions.common.main.js`：
//
// ① `contrib/agentStudio/browser/agentStudio.contribution.js`
//    注册两个 editor pane（该文件 `:898-907` 与 `:1289-1294`）。
//
// ② `browser/paneCompositePartService.js`
//    ★ 这个**确实是 singleton 覆盖**（`IPaneCompositePartService`），属有意例外：
//    `sessions.common.main.ts:496-500` 的注释明确说，撤掉它会让 sessions chat 的
//    `RegisterChatViewContainerContribution` 往 `ViewContainerLocation.ChatBar`
//    注册容器时，在标准 `PaneCompositePartService.getPartByLocation()` 上
//    **断言失败**（真机验证过）。它是标准版的**超集**（Panel / Sidebar /
//    AuxiliaryBar **+ ChatBar**），因此与"标准底座"并不冲突。
//    ⚠ 副作用：多出一个 `Parts.CHATBAR_PART` 部件，而 agents grid 里没有它
//    ⇒ 会变成**游离 DOM 元素**（和 activity bar 同一个坑）。已由
//    `AgentLayoutWorkbench.createWorkbenchLayout()` 一并 `display: none`。
//
// ⚠ 回退：删掉下面两行 import 即可回到"标准底座 + 右侧空"的状态。
//    若窗口起不来，先看 `renderer.log` 的错误栈 —— 它会指出还缺哪个贡献
//    （用 `npm run smoke-agent-layout-parse` 取）。

import './contrib/agentStudio/browser/agentStudio.contribution.js';
import './browser/paneCompositePartService.js';
// pi 对拍入口（__SAROSIS_PI_RUN）：agents 布局不引 sessions.common.main.js（见上方 ⚠⚠ 注释），
// 故此处单独按需引入 —— 该贡献点仅装一个全局函数（不写会话/不落盘/AfterRestored），
// 且 IAgentOSService 为可选解析，服务缺失时优雅跳过而不是打爆启动（2026-09-20 实证）。
import './contrib/agentStudio/browser/piLoopDualRun.contribution.js';

//#endregion


//#region --- window entry (Agent layout) ---

import './electron-browser/agentLayoutDesktopMain.js';

//#endregion


export { main } from './electron-browser/agentLayoutDesktopMain.js';
