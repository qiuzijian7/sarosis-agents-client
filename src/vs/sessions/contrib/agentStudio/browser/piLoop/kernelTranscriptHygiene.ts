/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 转录卫生（2026-09-20，修复「孤儿 tool 对每轮重剥」实证缺陷）。
 *
 * 背景：`LMBridge.sanitizeToolPairs` 在每次模型调用前剥掉「有 tool_call 无 tool_result /
 * 有 result 无 call」的孤儿对。legacy 路径的 caller 数组**就是**权威历史 ⇒ 回写后彻底
 * 干净（剥一次）。pi 路径的 caller 数组是 `convertToChatMessages` 派生的一次性副本 ⇒
 * 回写进不了内核 transcript（并发会话已按 `CHAT_MESSAGES_DERIVED` 标记跳过无效回写并
 * 如实打日志，但那只是止血）——孤儿每轮原样复发（真机实测每轮固定剥 3→5→6 条，且在涨）。
 *
 * 本模块把「孤儿清理」做进内核自己（transcript 是内核的资产，卫生由内核负责）：
 *   · 孤儿来源：收尾轮（禁工具轮）里模型仍写的 tool calls 不执行 ⇒ 无 result；
 *     用户 abort 打断的半批工具调用；历史遗留（legacy 时代 / 早期 pi 版本写入）。
 *   · 清理时机：每轮流式前（权威 transcript 此刻完整）；收尾轮跳过执行的调用就地摘除。
 *   · 与 legacy 的差异：legacy 靠 LMBridge 的哨兵函数剥，内核不感知；本仓内核自己剥、
 *     并给出计数（可观测），LMBridge 侧因此不再需要重剥（它仍会兜底，只是无孤儿可剥）。
 */

import type { AgentMessage, AssistantMessage, ITranscriptPruneResult } from './types.js';

export type { ITranscriptPruneResult } from './types.js';

const EMPTY_RESULT: ITranscriptPruneResult = { prunedCalls: 0, prunedResults: 0, droppedMessages: 0 };

/** 收集全部 tool result 的 call id（含 OpenAI 风格 `tool_call_id` 兼容字段）。 */
function collectResultIds(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		const msg = m as { role?: string; toolCallId?: string; tool_call_id?: string };
		if (msg.role === 'toolResult' || msg.role === 'tool') {
			const id = msg.toolCallId ?? msg.tool_call_id;
			if (typeof id === 'string' && id) { ids.add(id); }
		}
	}
	return ids;
}

/** 收集全部 tool call 的 id（assistant 内容块）。 */
function collectCallIds(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== 'assistant') { continue; }
		for (const block of (m as AssistantMessage).content ?? []) {
			const b = block as { type?: string; id?: string };
			if (b.type === 'toolCall' && typeof b.id === 'string' && b.id) { ids.add(b.id); }
		}
	}
	return ids;
}

/**
 * 就地清理孤儿（双向）：
 *   · assistant 的 toolCall 块无对应 result ⇒ 摘除该块（整条消息因此清空则移除消息）；
 *   · toolResult 消息无对应 call ⇒ 移除该消息。
 * 幂等：清理后的 transcript 再跑一次返回全零。
 */
export function pruneOrphanedToolCalls(messages: AgentMessage[]): ITranscriptPruneResult {
	if (messages.length === 0) { return EMPTY_RESULT; }
	const resultIds = collectResultIds(messages);
	const callIds = collectCallIds(messages);

	let prunedCalls = 0;
	let prunedResults = 0;
	let droppedMessages = 0;

	// 逆序遍历（可安全 splice）；保持原顺序语义
	for (let i = messages.length - 1; i >= 0; i--) {
		const raw = messages[i]!;
		const role = (raw as { role?: string }).role;

		// ① 孤儿 result（无对应 call）⇒ 整条移除
		if (role === 'toolResult' || role === 'tool') {
			const id = (raw as { toolCallId?: string; tool_call_id?: string }).toolCallId ?? (raw as { tool_call_id?: string }).tool_call_id;
			if (typeof id !== 'string' || !id || !callIds.has(id)) {
				messages.splice(i, 1);
				prunedResults++;
				droppedMessages++;
			}
			continue;
		}

		// ② assistant 的孤儿 call 块 ⇒ 摘块（清空则移除消息）
		if (role === 'assistant') {
			const content = (raw as AssistantMessage).content;
			if (!Array.isArray(content)) { continue; }
			const kept = content.filter(block => {
				const b = block as { type?: string; id?: string };
				if (b.type !== 'toolCall') { return true; }
				const orphan = typeof b.id !== 'string' || !b.id || !resultIds.has(b.id);
				if (orphan) { prunedCalls++; }
				return !orphan;
			});
			if (kept.length === content.length) { continue; }
			if (kept.length === 0) {
				messages.splice(i, 1);
				droppedMessages++;
			} else {
				// 内容不可变（readonly）⇒ 原地替换元素为新对象
				messages[i] = { ...(raw as object), content: kept } as unknown as AgentMessage;
			}
		}
	}

	return { prunedCalls, prunedResults, droppedMessages };
}

/** 便捷判定：本次清理是否动了 transcript。 */
export function hasPruneEffect(r: ITranscriptPruneResult): boolean {
	return r.prunedCalls > 0 || r.prunedResults > 0 || r.droppedMessages > 0;
}
