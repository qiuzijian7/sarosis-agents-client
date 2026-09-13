/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具卡「展开态跨整卡重建」的决策逻辑。
 *
 * 背景（2026-09-13，用户报「terminal 工具卡片执行完毕后没有折叠」）：
 *
 * 工具卡在 `running → success` 时走**整卡 DOM 重建**（`_updateToolCardStatuses`
 * 的 status-change 分支）。重建前会读旧卡的展开态，重建后施加到新卡 —— 这个
 * 「保留展开态」的初衷是避免流式刷新把用户展开的内容折叠掉，但它没区分：
 *
 *   ① **用户显式选择**：点过 chevron，`_toolCallExpandState` 里有该 id。
 *      → 必须跨重建保留，否则用户展开的内容会自己合上。
 *
 *   ② **状态默认值**：terminal 卡片运行中默认展开
 *      （`expanded = userChoice ?? (isRunning && !tc.result)`），此时 Map 里
 *      **没有**该 id。这只是「当下该展开」，不是用户意愿。
 *      → status 一变就该按新状态重算（finished → 折叠）。
 *
 * 原实现无条件沿用旧 DOM 展开态并写回 Map，把 ② 固化成了「用户选择」，
 * 于是第 677 行的「执行完毕自动折叠」永远不生效。
 */

/** 旧卡在重建前的展开态快照。 */
export interface IToolCardExpandSnapshot {
	/** 旧卡 DOM 上是否存在展开 class。 */
	readonly wasExpanded: boolean;
	/**
	 * `_toolCallExpandState` 中是否**已记录**该 toolCall 的展开选择。
	 *
	 * 用 `has()` 而非 `get()` 是关键：terminal 卡片运行中自动展开时并不写 Map，
	 * 只有用户点过 chevron 才写。因此 `has === true` 才代表「用户选择过」。
	 */
	readonly userChoseExpandState: boolean;
}

/**
 * 整卡重建后是否应当**强制保持展开**。
 *
 * 仅当「旧卡确实是展开的」且「用户显式选择过展开」时才保持；
 * 其余情况（含仅因运行中而自动展开）一律返回 false，让新卡按自身默认值
 * （`userChoice ?? (isRunning && !tc.result)`）决定 —— 对已完成的工具即折叠。
 */
export function shouldPreserveExpandedAcrossRebuild(snapshot: IToolCardExpandSnapshot): boolean {
	return snapshot.wasExpanded && snapshot.userChoseExpandState;
}

/**
 * 重建后是否应当把展开态**写回** `_toolCallExpandState`。
 *
 * 只有用户显式选择过的状态才值得回写。把「自动展开」写回会让后续所有
 * 默认值计算失效（Map 里永远是 true）——这正是原 bug 的第二半。
 */
export function shouldPersistExpandState(snapshot: IToolCardExpandSnapshot): boolean {
	return snapshot.userChoseExpandState;
}
