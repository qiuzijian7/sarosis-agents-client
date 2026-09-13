/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * checkpointConversationAnchor — 「只回退对话」的截断锚点计算（纯函数，无 IO）。
 *
 * 背景（2026-09-12，P1-1）：检查点此前只能「回退代码」（撤销文件改动），缺少
 * Claude Code `/rewind` 的 **Restore conversation**（回退对话、保留代码）。
 *
 * 实现选择——**用时间戳而非 messageId 定位**：现有检查点（native 链工具侧创建的
 * `tool_edit`、webview 链的每轮 `user_edit` 锚点）创建时都没有写入 `messageId`，
 * 依赖它会让功能静默失效；而每条消息都带 `timestamp`，检查点带 `createdAt`，
 * 两者可直接比较。
 *
 * 语义：把历史截断到「**本轮起点之前**」—— 即保留最后一条时间戳早于锚点的消息
 * （含），删除其后的全部消息，使用户可以重新提问（对齐 Claude Code「Restore
 * conversation 后原提示回填输入框」的体验）。
 */

/** 消息的最小时形状（`ChatMessage.timestamp` 是 ISO 字符串）。 */
export interface ITimestampedMessage {
	readonly timestamp: string;
}

/**
 * 计算应**保留**的最后一条消息下标（含）。
 *
 * 假设历史按时间**升序**（持久化顺序即追加顺序），因此一旦遇到不早于锚点的消息
 * 即停止扫描。
 *
 * @param messages 会话历史（升序）。
 * @param anchorMs 本轮起点时间（最早的非 ghost 检查点 `createdAt`，ms）。
 * @returns 保留下标；**-1 表示没有任何消息早于锚点**（本轮即会话开始）——
 *          调用方应**拒绝截断**（绝不误清空整个会话）。
 */
export function findConversationKeepIndex(
	messages: readonly ITimestampedMessage[],
	anchorMs: number,
): number {
	let keepIdx = -1;
	for (let i = 0; i < messages.length; i++) {
		const ts = Date.parse(messages[i].timestamp);
		// 时间戳非法（NaN）视为「不早于锚点」→ 停止（保守，避免把未知消息判为可保留）。
		if (Number.isFinite(ts) && ts < anchorMs) {
			keepIdx = i;
		} else {
			break;
		}
	}
	return keepIdx;
}

/**
 * 计算最早的非 ghost 检查点时间（= 本轮起点）。
 *
 * @returns 最早 `createdAt`；无存活检查点时返回 `undefined`（调用方应放弃操作）。
 */
export function earliestCheckpointTime(
	checkpoints: readonly { readonly createdAt: number; readonly isGhost: boolean }[],
): number | undefined {
	let min: number | undefined;
	for (const cp of checkpoints) {
		if (cp.isGhost) { continue; }
		if (min === undefined || cp.createdAt < min) { min = cp.createdAt; }
	}
	return min;
}
