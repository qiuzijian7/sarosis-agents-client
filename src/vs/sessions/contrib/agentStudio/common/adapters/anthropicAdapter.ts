/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Anthropic 格式适配器
 * 将 AnthropicLLMChatMessage 转换为统一 ChatMessage 格式
 *
 * Anthropic 格式特点：
 * - role: 'user' | 'assistant'
 * - content: string | ContentBlock[]
 * - ContentBlock 类型：text | tool_use | thinking | redacted_thinking
 */

import { ChatMessage, ToolResult } from '../chatTypes.js';
import { AnthropicLLMChatMessage, AnthropicContentBlock, AnthropicUserContentBlock } from '../llmMessageTypes.js';

export function anthropicToChatMessages(messages: AnthropicLLMChatMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'assistant') {
			result.push(...anthropicAssistantToChatMessage(msg));
		} else {
			result.push(...anthropicUserToChatMessage(msg));
		}
	}

	return result;
}

function anthropicAssistantToChatMessage(msg: Extract<AnthropicLLMChatMessage, { role: 'assistant' }>): ChatMessage[] {
	const contentBlocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
	const textBlocks = contentBlocks.filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text');
	const thinkingBlocks = contentBlocks.filter((b): b is Extract<AnthropicContentBlock, { type: 'thinking' | 'redacted_thinking' }> => b.type === 'thinking' || b.type === 'redacted_thinking');
	const toolUseBlocks = contentBlocks.filter((b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');

	const messages: ChatMessage[] = [];

	// Assistant 消息（文本内容 + 思考内容）
	const textContent = textBlocks.map(b => b.text).join('');
	const thinkingContent = thinkingBlocks.map(b => {
		if (b.type === 'thinking') {
			return { type: 'thinking' as const, thinking: b.thinking, signature: b.signature };
		} else {
			return { type: 'redacted_thinking' as const, data: b.data };
		}
	});

	messages.push({
		role: 'assistant',
		content: textContent,
		reasoning: '',
		thinking: thinkingContent,
		timestamp: Date.now(),
	});

	// Tool 消息（每个 tool_use 对应一个）
	for (const toolUse of toolUseBlocks) {
		messages.push({
			role: 'tool',
			id: toolUse.id,
			name: toolUse.name,
			params: toolUse.input as Record<string, unknown>,
			rawParams: { [toolUse.name]: JSON.stringify(toolUse.input) },
			result: null,
			status: 'pending',
			timestamp: Date.now(),
		});
	}

	return messages;
}

function anthropicUserToChatMessage(msg: Extract<AnthropicLLMChatMessage, { role: 'user' }>): ChatMessage[] {
	const contentBlocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
	const textBlocks = contentBlocks.filter((b): b is Extract<AnthropicUserContentBlock, { type: 'text' }> => b.type === 'text');
	const toolResultBlocks = contentBlocks.filter((b): b is Extract<AnthropicUserContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');

	const messages: ChatMessage[] = [];

	// User 消息（文本内容）
	const textContent = textBlocks.map(b => b.text).join('');
	messages.push({
		role: 'user',
		content: textContent,
		displayContent: textContent,
		selections: null,
		timestamp: Date.now(),
	});

	// Tool Result 消息（每个 tool_result 对应一个）
	for (const toolResult of toolResultBlocks) {
		messages.push({
			role: 'tool',
			id: toolResult.tool_use_id,
			name: '', // Anthropic tool_result 不包含 name
			params: {},
			rawParams: {},
			result: {
				content: [{ type: 'text', text: typeof toolResult.content === 'string' ? toolResult.content : '' }],
			},
			status: 'success',
			timestamp: Date.now(),
		});
	}

	return messages;
}

/**
 * 将统一 ChatMessage 格式转换为 Anthropic 格式（用于发送到 Anthropic API）
 */
export function chatMessagesToAnthropic(messages: ChatMessage[]): AnthropicLLMChatMessage[] {
	const result: AnthropicLLMChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'user') {
			result.push({
				role: 'user',
				content: msg.content,
			});
		} else if (msg.role === 'assistant') {
			const contentBlocks: AnthropicContentBlock[] = [];
			if (msg.content) {
				contentBlocks.push({ type: 'text', text: msg.content });
			}
			if (msg.thinking) {
				for (const t of msg.thinking) {
					if (t.type === 'thinking') {
						contentBlocks.push({ type: 'thinking', thinking: t.thinking, signature: t.signature || '' });
					} else {
						contentBlocks.push({ type: 'redacted_thinking', data: t.data || '' });
					}
				}
			}
			result.push({
				role: 'assistant',
				content: contentBlocks,
			});
		} else if (msg.role === 'tool') {
			// Tool 消息在 Anthropic 格式中是 user 消息（tool_result）
			result.push({
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: msg.id,
					content: msg.result ? toolResultToText(msg.result) : '',
				}],
			});
		} else if (msg.role === 'system') {
			// System 消息在 Anthropic 格式中是单独的 system parameter
			// 这里暂时转为 user 消息（实际应该单独处理）
			result.push({
				role: 'user',
				content: msg.content,
			});
		}
	}

	return result;
}

function toolResultToText(result: ToolResult): string {
	return result.content
		.filter(c => c.type === 'text')
		.map(c => c.text || '')
		.join('');
}
