/*---------------------------------------------------------------------------------------------
 * contextAdapter.ts —— **Context 适配器**（六件套之一，doc §3.3）。
 *
 * 把 pi 的 `convertToLlm`（transcript → LLM 消息）与我方的上下文治理（压缩 / HardPrune /
 * 记忆注入 / prefix-cache 对齐）接起来。
 *
 * 本期（P0）：`convertToLlm` 的忠实实现（过滤 UI-only 条目；**契约：不能 throw**）。
 * P1 接入点（已标注 TODO）：
 *   · 压缩（我方 Compression，token 阈值 0.7 + ineffective 计数）→ pi `transformContext`；
 *   · HardPrune（消息数硬上限，model-free 兜底 —— pi 没有 ⇒ 保留我方实现）；
 *   · 记忆注入（agentmemory recall + 工作记忆）→ pi `prepareNextTurn` 追加 system-reminder；
 *   · prefix-cache 对齐（我方 Fork prefix-cache aligned）→ pi `convertToLlm` 边界保持不变。
 *--------------------------------------------------------------------------------------------*/

import type { AgentMessage, Message } from './piCoreTypes.js';

/**
 * pi `AgentLoopConfig.convertToLlm` 的实现：把 transcript 条目过滤/映射成 LLM 可识别的 `Message[]`。
 *
 * ⚠ 契约（pi 注释原话）："**must not throw or reject**. Return a safe fallback value instead.
 *    Throwing interrupts the low-level agent loop without producing a normal event sequence."
 *    ⇒ 不能识别的条目（UI-only / 状态卡）**丢弃**，绝不抛错。
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const out: Message[] = [];
	for (const m of messages) {
		if (isLlmCompatible(m)) {
			out.push(m);
		}
		// else：UI-only / 状态条目 ⇒ 丢弃（不进 LLM 上下文）
	}
	return out;
}

/** LLM 可识别的角色集合（system / user / assistant / toolResult）。 */
function isLlmCompatible(m: AgentMessage): m is Message {
	const role = (m as { role?: string }).role;
	return role === 'system' || role === 'user' || role === 'assistant' || role === 'toolResult';
}

// TODO(P1, doc §3.3)：transformContext —— 接入我方 Compression（阈值 0.7）+ HardPrune（model-free 兜底）。
// TODO(P1, doc §3.3)：prepareNextTurn —— 接入记忆注入（agentmemory recall + 工作记忆）与 prefix-cache 对齐。
