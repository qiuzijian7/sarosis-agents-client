/*---------------------------------------------------------------------------------------------
 *  agentChatPanel.keyedParts.ts — Keyed Reconciliation 纯函数模块。
 *
 *  从 agentChatPanel.messages.ts 提取的 key 分配逻辑，独立可测试。
 *  每个 part 元素携带 data-part-key 属性，key 在同一 msg 生命周期内稳定：
 *    thinking → `thinking:${msgId}#tk${index}`
 *    text     → `text:${msgId}#t${index}`
 *    tool     → `tool:${toolCall.id}`
 *    subagent → `subagent:${subAgent.id}`
 *--------------------------------------------------------------------------------------------*/
import type { IMessagePart } from './agentChatTypes.js';

/** keyed part 描述：key + part 引用 + 原始索引。 */
export interface IKeyedPart {
	key: string;
	part: IMessagePart;
	index: number;
}

/**
 * 构建有序 keyed part 列表——从 msg.parts 提取所有需要渲染的 part，
 * 跳过空 text，为每个 part 分配稳定 key。
 *
 * @param parts 消息的有序 part 列表
 * @param msgId 消息 ID（用于生成稳定 key）
 * @returns 有序 keyed part 列表（仅包含需要渲染的 part）
 */
export function buildKeyedParts(parts: readonly IMessagePart[], msgId: string): IKeyedPart[] {
	const result: IKeyedPart[] = [];

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		let key: string | null = null;

		if (part.kind === 'thinking') {
			key = `thinking:${msgId}#tk${i}`;
		} else if (part.kind === 'text') {
			if (part.text.trim().length === 0) { continue; }
			key = `text:${msgId}#t${i}`;
		} else if (part.kind === 'tool') {
			const tool = (part as any).tool;
			key = `tool:${tool?.id ?? `auto-${i}`}`;
		}

		if (key) { result.push({ key, part, index: i }); }
	}
	return result;
}

/**
 * 计算最后一个非空 text part 的 key（用于 streaming-container 标记）。
 * 无 text part 时返回 null。
 */
export function lastTextPartKey(parts: readonly IMessagePart[], msgId: string): string | null {
	let lastKey: string | null = null;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p.kind === 'text' && p.text.trim().length > 0) {
			lastKey = `text:${msgId}#t${i}`;
		}
	}
	return lastKey;
}
