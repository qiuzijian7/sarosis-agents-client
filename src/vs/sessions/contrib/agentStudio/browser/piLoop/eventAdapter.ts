/*---------------------------------------------------------------------------------------------
 *  eventAdapter.ts —— piLoop `AgentEvent` → 本仓 `IChatStreamDelta`（聊天契约缝）。
 *
 *  移植自（已删除的）piCore/eventAdapter.ts，并对齐 piLoop 的**拍平后**事件形状（都已核实）：
 *   · piLoop 的 `turn_end`/`agent_end` 是**裸事件**（无载荷）；
 *   · piLoop 的 streamAdapter 把本仓**完整**的 `tool_call` delta 转成 **`toolcall_delta`**
 *     （不是 `toolcall_end`），且事件只有 `partial` ⇒ 工具调用从 `partial.content` 的最后一个
 *     `toolCall` 块取；同一调用可能多次 delta ⇒ **按 toolCallId 去重**（故本适配器是有状态的，
 *     用 `createPiLoopEventMapper()` 每次运行创建一个）；
 *   · ★ piLoop 的 `message_end` 在**工具执行之前**发 ⇒ 我方「每轮 assistant_turn」边界落在
 *     `message_end` —— 这比我之前对上游 pi 的映射更贴合本仓契约（executor 在 assistant 消息
 *     定稿时就发 assistant_turn，再执行工具）。
 *
 *  对外契约不变 ⇒ UI（agentChatPanel / nativeChatEditorPane / streamingRenderScheduler）零改动。
 *--------------------------------------------------------------------------------------------*/

import type { IChatStreamDelta } from '../../common/providers.js';
import type { AgentEvent, AgentMessage, AssistantContent, AssistantMessage, AssistantMessageEvent } from './types.js';

/**
 * 创建一个**有状态**的事件映射器（每次运行一个）。
 * 状态 = 已发过 `tool_start` 的 toolCallId 集合（`toolcall_delta` 可能多次到达 ⇒ 去重）。
 */
export function createPiLoopEventMapper(): (event: AgentEvent) => IChatStreamDelta[] {
	const emittedToolStarts = new Set<string>();
	return (event: AgentEvent): IChatStreamDelta[] => {
		switch (event.type) {
			case 'agent_start':
			case 'turn_start':
			case 'message_start':
			case 'turn_end':        // piLoop 的 turn_end 是裸事件 ⇒ 边界已由 message_end 承担
			case 'tool_execution_start':
				return [];

			case 'message_update':
				return mapAssistantMessageEvent(event.assistantMessageEvent, emittedToolStarts);

			case 'message_end':
				// 我方「每个 iteration 一个 assistant_turn」的边界（piLoop 的 message_end 携定稿消息）
				return isAssistantMessage(event.message) ? [toAssistantTurnDelta(event.message)] : [];

			case 'tool_execution_update': {
				const text = extractBlocksText(event.update?.content);
				return text ? [{ type: 'tool_progress', content: text, toolName: event.toolName } as IChatStreamDelta] : [];
			}

			case 'tool_execution_end':
				return [
					{ type: 'tool_result', content: extractBlocksText(event.result?.content), toolCallId: event.toolCallId, toolName: event.toolName } as IChatStreamDelta,
					{ type: 'tool_end', toolCallId: event.toolCallId, success: !event.isError } as IChatStreamDelta,
				];

			case 'agent_end':
				return [{ type: 'done' } as IChatStreamDelta];
		}
	};
}

/** piLoop 流式消息事件 → 我方 text/thinking/tool_start delta（tool_start 按 id 去重）。 */
function mapAssistantMessageEvent(ev: AssistantMessageEvent, emittedToolStarts: Set<string>): IChatStreamDelta[] {
	switch (ev.type) {
		case 'text_delta':
			return [{ type: 'text', content: ev.delta } as IChatStreamDelta];
		case 'thinking_delta':
			return [{ type: 'thinking', content: ev.delta } as IChatStreamDelta];
		case 'toolcall_delta':
		case 'toolcall_end': {
			const tc = lastToolCall(ev.partial);
			if (!tc || emittedToolStarts.has(tc.id)) { return []; }
			emittedToolStarts.add(tc.id);
			const deltas: IChatStreamDelta[] = [
				{ type: 'tool_start', content: '', toolCallId: tc.id, toolName: tc.name } as IChatStreamDelta,
			];
			// ★ 2026-09-20（真机 A/B 实证）：必须随 tool_start 补发 `tool_args` ——
			// 工具卡的文件名/参数展示靠它按 toolCallId 匹配（缺了 ⇒ 卡片显示「未知文件」，
			// 与 executor:2966 记录的"幽灵卡"教训同源）。形状对齐 executor:1924：
			// content 是 JSON 字符串；空对象不发（避免无意义卡片刷新）。
			const argsStr = safeArgsString(tc.arguments);
			if (argsStr) {
				deltas.push({ type: 'tool_args', content: argsStr, toolCallId: tc.id } as IChatStreamDelta);
			}
			return deltas;
		}
		default:
			return []; // start / *_start / *_end
	}
}

/** `message_end`（assistant）→ 我方 `assistant_turn`（权威一轮文本 + toolCallIds ⇒ chatService 据此切分）。 */
function toAssistantTurnDelta(message: AssistantMessage): IChatStreamDelta {
	let text = '';
	const toolCallIds: string[] = [];
	for (const block of message.content) {
		if (block.type === 'text') { text += block.text; }
		else if (block.type === 'toolCall') { toolCallIds.push(block.id); }
	}
	return { type: 'assistant_turn', content: text, metadata: { toolCallIds } } as IChatStreamDelta;
}

// ─── 小件 ───

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return (m as { role?: string }).role === 'assistant' && Array.isArray((m as AssistantMessage).content);
}

function lastToolCall(m: AssistantMessage): Extract<AssistantContent, { type: 'toolCall' }> | undefined {
	for (let i = m.content.length - 1; i >= 0; i--) {
		const b = m.content[i];
		if (b.type === 'toolCall') { return b; }
	}
	return undefined;
}

function extractBlocksText(content: readonly unknown[] | undefined): string {
	if (!Array.isArray(content)) { return ''; }
	return content
		.map(c => (c && typeof c === 'object' && (c as { type?: string }).type === 'text') ? String((c as { text?: unknown }).text ?? '') : '')
		.filter(s => s.length > 0)
		.join('\n');
}

/** 工具参数 → JSON 字符串（空/空对象 ⇒ 不发，对齐 executor:1923）。 */
function safeArgsString(args: unknown): string {
	if (args === undefined || args === null) { return ''; }
	if (typeof args === 'string') { return (args.length > 0 && args !== '{}') ? args : ''; }
	try {
		const s = JSON.stringify(args);
		return (s.length > 0 && s !== '{}') ? s : '';
	} catch { return ''; }
}
