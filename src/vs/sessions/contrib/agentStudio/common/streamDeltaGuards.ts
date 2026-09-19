/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天 pane 流式 delta 的会话归属判定 + 面板重建重载判定 —— 纯函数。
 *
 * 为什么单独抽到 `common/`：
 *  - `browser/nativeChatEditorPane.ts` 依赖 `mainWindow` 与大量 workbench/DOM 服务，
 *    Node 测试环境无法加载它（import 即抛 `window is not defined`），
 *    导致这两条判定**此前无任何测试覆盖** —— 而它们各自对应一次线上事故且已复发。
 *  - 本模块零依赖（只用基础类型），可被测试直接导入。
 *
 * 判定必须是纯函数：两类事故都发生在「实例状态被 delta 处理逻辑自身改写」的时序里，
 * 若判据取自实例字段，测试无法复现真实时序，缺陷会再次漏过。
 */

/**
 * 流式 delta 的会话归属判定。
 *
 * @param broadcastSessionId 广播 delta 所属会话（'' / null / undefined = 全局 delta）
 * @param paneSessionId      本 pane 当前绑定的会话（null = 未绑定）
 * @param paneClaimed        **本 pane 是否已被用户占用**（用户在该 pane 发过消息、
 *                           或主动切换/新建过会话）。false = 只是刚打开、用户还没用的空壳 pane。
 * @returns 是否接受该 delta
 *
 * 判定规则：
 *  1. 全局 delta（无会话归属）→ 放行（看板/系统广播不受会话绑定约束）。
 *  2. 本 pane 未绑定会话 → 放行（可接管，用于看板任务在空闲 pane 显示执行流）。
 *  3. 会话相同 → 放行（多窗口实时同步同一流）。
 *  4. 会话不同 + 已被用户占用 → 忽略（★防串台，2026-08-08 事故）。
 *  5. 会话不同 + 空壳 pane → 放行（★2026-09-18 事故：pane 初始化自动绑定
 *     `sessions[0].id`，若不区分「空壳」会把它当作用户占用，静默丢弃
 *     其它会话的流 → 「LLM 正常输出 + 界面全白 + 零日志」）。
 */
export function shouldAcceptStreamDelta(
	broadcastSessionId: string | null | undefined,
	paneSessionId: string | null | undefined,
	paneClaimed: boolean,
): boolean {
	// 1. 全局 delta：无会话归属，一律放行
	if (!broadcastSessionId) { return true; }

	// 2. 本 pane 未绑定会话：允许接管
	if (!paneSessionId) { return true; }

	// 3. 同一会话：放行（多窗口同步 / 自身流）
	if (broadcastSessionId === paneSessionId) { return true; }

	// 4/5. 不同会话：仅「已被用户占用」的 pane 需要防串台
	return !paneClaimed;
}

/**
 * 面板重建（rich ⇄ CLI 互换）后是否需要重新加载历史。
 *
 * 背景：`NativeChatEditorPane.setInput()` 先发起异步 `_selectAndLoadAgent`，
 * 再同步 `_syncPanelType` 重建面板。若不重新加载，在途调用的 `setMessages`
 * 会落到已 `dispose()` 的旧面板上，新面板永远空白 —— 连用户自己的消息气泡都不渲染
 * （2026-09-18「新开窗口整片空白」）。
 *
 * @param agentId 当前绑定的 agent id
 * @returns 是否需要重新加载历史
 */
export function shouldReloadAfterPanelSwap(agentId: string | null | undefined): boolean {
	// 无 agent → 无历史可加载，避免空转一次 getHistory
	return !!agentId;
}
