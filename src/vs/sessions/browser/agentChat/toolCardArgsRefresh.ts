/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「args 后到」导致工具卡停留在占位态的刷新决策（纯逻辑，零 DOM 依赖，可独立单测）。
 *
 * ## 事故（2026-08-22，日志 1787363991734）
 *
 * 用户报「存在空的 terminal 工具卡片」+「流式输出后期抖动严重」。日志显示本次
 * **`terminal` 一次都没执行**，但 `execute_code` 执行了 30 次 —— 而
 * `agentChatPanel.base.ts::TOOL_TERMINAL_TOOLS` 把 `execute_code` 也归入终端族，
 * 所以用户看到的「terminal 卡片」其实是 execute_code 的卡。
 *
 * ## 根因：卡片只在【状态变化】时刷新，args 是独立后到的
 *
 * `STREAM_END` 的 delta 类型构成证实 `tool_start` 与 `tool_args` 是**两个独立 delta**：
 *
 *   types={text=12, tool_start=2, tool_args=2, tool_progress=2, ...}
 *
 * 于是时序变成：
 *   1. `tool_start` 到达 → parts 新增 tool part → 建卡，此时 `tc.args` 还是空
 *      → 终端卡走 `else` 分支渲染占位符 `执行中…`（`.terminal-cmd-empty`）；
 *   2. `tool_args` 到达 → `tc.args` 有了完整命令，但 **status 仍是 running**
 *      → `_updateToolCardStatuses` 的唯一刷新条件 `currentStatus !== newStatus`
 *      不成立 → **卡片不更新**，继续显示「执行中…」；
 *   3. 直到 `tool_end` 让 status 变为 success，才整卡重建、命令文本才出现。
 *
 * 因此空卡会持续**整个命令执行期间**。本日志里有一次 execute_code 跑了 30552ms
 * ——用户整整 30 秒看着一张没有命令的卡。
 *
 * ## 与「抖动」是同一个根因
 *
 * 命令文本迟到 step 3 才出现，意味着卡片高度在**命令执行结束的那一刻**才突然增长；
 * 此时消息已经很长、用户正在阅读，下方全部内容被顶动 —— 这正是「后期抖动严重」的
 * 一个直接来源。让内容在 `tool_args` 到达时（卡片刚建好、位于视口底部）就位，
 * 布局在早期一次性稳定，晚期不再跳。
 *
 * ## 为什么不能「每次 args 变化都重建」
 *
 * 那会把 O(1) 的一次补齐变成每帧 N 次整卡重建（含 markdown 重渲染），是更严重的抖动。
 * 故判据必须**自限**：只在「卡片当前确实处于占位态」且「args 现在确实能填上」时刷新
 * 一次；刷新后占位标记消失，条件自然不再成立。这与既有 `tool-progress-row`
 * 「进度条是后到的 → 重建一次补上」的处理同构。
 */

/** 工具卡当前的占位态（由调用方从 DOM 探测，本模块不碰 DOM）。 */
export interface IToolCardPlaceholderState {
	/** 终端族卡片正显示「执行中…／（无命令）」占位符（`.terminal-cmd-empty`）。 */
	readonly hasEmptyCommandPlaceholder: boolean;
	/** 写文件族卡片正显示「(路径未解析)」占位符。 */
	readonly hasUnresolvedPathPlaceholder: boolean;
}

/** 终端族卡片的命令字段候选名（与 `fileCards._createTerminalToolCard` 保持一致）。 */
const COMMAND_KEYS = ['command', 'cmd', 'code'] as const;

/**
 * 写文件族卡片的路径字段候选名。
 * 与 `messages._extractFilePath` 保持一致 —— 两处若漂移，会出现「卡片说路径未解析、
 * 但刷新后仍是未解析」的空转刷新。
 */
const PATH_KEYS = ['filePath', 'path', 'file', 'filepath', 'file_path', 'target_file', 'uri'] as const;

/** 取第一个非空字符串字段。 */
function _firstNonEmptyString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const k of keys) {
		const v = args[k];
		if (typeof v === 'string' && v.length > 0) { return v; }
	}
	return undefined;
}

/** args 是否已能提供终端族卡片所需的命令文本。 */
export function argsResolveCommand(args: Record<string, unknown>): boolean {
	return _firstNonEmptyString(args, COMMAND_KEYS) !== undefined;
}

/** args 是否已能提供写文件族卡片所需的路径。 */
export function argsResolveFilePath(args: Record<string, unknown>): boolean {
	return _firstNonEmptyString(args, PATH_KEYS) !== undefined;
}

/**
 * 判断是否需要因「args 后到」而刷新一次工具卡。
 *
 * **自限性**是这个判据的核心约束：返回 true 的前提之一是卡片**当前**处于占位态，
 * 刷新后占位符消失 → 下一帧必然返回 false。因此每张卡最多因此多重建一次，
 * 不会退化成每帧重建（那才是更严重的抖动）。
 *
 * @param state 卡片当前占位态
 * @param args  已解析的工具参数（调用方应使用 `parseToolArgsLoose`，
 *              以便流式截断的 JSON 也能提取出字段）
 */
export function needsArgsDrivenRebuild(
	state: IToolCardPlaceholderState,
	args: Record<string, unknown>,
): boolean {
	if (state.hasEmptyCommandPlaceholder && argsResolveCommand(args)) { return true; }
	if (state.hasUnresolvedPathPlaceholder && argsResolveFilePath(args)) { return true; }
	return false;
}
