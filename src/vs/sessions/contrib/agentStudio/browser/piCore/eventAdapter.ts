/*---------------------------------------------------------------------------------------------
 * eventAdapter.ts —— **Event 适配器**（六件套之一，doc §3.4）。
 *
 * 把 pi 内核的 `AgentEvent`（10 种）映射成我方聊天框消费的 `IChatStreamDelta`。
 * **对外契约不变 ⇒ UI（agentChatPanel / nativeChatEditorPane / streamingRenderScheduler）零改动。**
 *
 * 映射表（pi → 我方 delta.type）：
 *   agent_start / turn_start / message_start / message_end   → （无）
 *   message_update.assistantMessageEvent:
 *     text_delta      → 'text'      （content=delta）
 *     thinking_delta  → 'thinking'  （content=delta）
 *     toolcall_end    → 'tool_start'（toolCallId/toolName；我方 tool_call 是完整调用 ⇒ 无 tool_args 阶段）
 *     其余            → （无）
 *   tool_execution_start  → （无；工具卡已由 tool_start 建）
 *   tool_execution_update → 'tool_progress'（content=partialResult 文本）
 *   tool_execution_end    → 'tool_result'（content=结果文本，toolCallId）+ 'tool_end'（success=!isError）
 *   turn_end              → 'assistant_turn'（content=该轮权威文本；metadata.toolCallIds）——
 *                           对齐我方 Hermes-style 消息边界（chatService 据此切 turn，不自行压扁）
 *   agent_end             → 'done'
 *--------------------------------------------------------------------------------------------*/

import type { AgentEvent, AgentMessage, AssistantMessage, AssistantMessageEvent } from './piCoreTypes.js';
import type { IChatStreamDelta } from '../../common/providers.js';

/** pi `AgentEvent` → 我方 `IChatStreamDelta[]`（一个事件可能展开成多条，如 tool_execution_end）。 */
export function agentEventToChatDeltas(event: AgentEvent): IChatStreamDelta[] {
	switch (event.type) {
		case 'agent_start':
		case 'turn_start':
		case 'message_start':
		case 'message_end':
		case 'tool_execution_start':
			return [];

		case 'message_update':
			return mapAssistantMessageEvent(event.assistantMessageEvent);

		case 'tool_execution_update': {
			const text = extractResultText(event.partialResult);
			return text ? [{ type: 'tool_progress', content: text, toolName: event.toolName } as IChatStreamDelta] : [];
		}

		case 'tool_execution_end': {
			const text = extractResultText(event.result);
			return [
				{ type: 'tool_result', content: text, toolCallId: event.toolCallId, toolName: event.toolName } as IChatStreamDelta,
				{ type: 'tool_end', toolCallId: event.toolCallId, success: !event.isError } as IChatStreamDelta,
			];
		}

		case 'turn_end':
			return [toAssistantTurnDelta(event)];

		case 'agent_end':
			return [{ type: 'done' } as IChatStreamDelta];
	}
}

/** pi 流式消息事件 → 我方 text/thinking/tool_start delta。 */
function mapAssistantMessageEvent(ev: AssistantMessageEvent): IChatStreamDelta[] {
	switch (ev.type) {
		case 'text_delta':
			return [{ type: 'text', content: ev.delta } as IChatStreamDelta];
		case 'thinking_delta':
			return [{ type: 'thinking', content: ev.delta } as IChatStreamDelta];
		case 'toolcall_end':
			// 我方 tool_start 形状（与 legacy executor 一致）：{ type:'tool_start', content:'', toolCallId, toolName }
			return [{ type: 'tool_start', content: '', toolCallId: ev.toolCall.id, toolName: ev.toolCall.name } as IChatStreamDelta];
		default:
			return []; // start / text_start / text_end / thinking_* / toolcall_start / toolcall_delta
	}
}

/** 类型谓词：`AgentMessage` 并集里的 `AgentCustomMessage.role` 是 `string`（可为 'assistant'）⇒ 还需 content 是数组才收窄。 */
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return (m as { role?: string }).role === 'assistant' && Array.isArray((m as AssistantMessage).content);
}

/** `turn_end` → 我方 `assistant_turn`（权威一轮文本 + toolCallIds ⇒ chatService 据此切分，不压扁）。 */
function toAssistantTurnDelta(event: Extract<AgentEvent, { type: 'turn_end' }>): IChatStreamDelta {
	const msg = event.message;
	let text = '';
	const toolCallIds: string[] = [];
	if (isAssistantMessage(msg)) {
		for (const block of msg.content) {
			if (block.type === 'text') { text += block.text; }
			else if (block.type === 'toolCall') { toolCallIds.push(block.id); }
		}
	}
	return { type: 'assistant_turn', content: text, metadata: { toolCallIds } } as IChatStreamDelta;
}

/** pi 工具结果（`AgentToolResult.content: (TextContent|ImageContent)[]`）→ 纯文本。 */
function extractResultText(result: unknown): string {
	if (result === null || result === undefined) { return ''; }
	if (typeof result === 'string') { return result; }
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) { return ''; }
	return content
		.map(c => (c && typeof c === 'object' && (c as { type?: string }).type === 'text') ? String((c as { text?: unknown }).text ?? '') : '')
		.filter(s => s.length > 0)
		.join('\n');
}
