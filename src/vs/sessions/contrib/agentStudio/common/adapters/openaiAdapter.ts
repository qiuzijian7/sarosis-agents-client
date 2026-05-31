/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenAI 格式适配器
 * 将 OpenAILLMChatMessage 转换为统一 ChatMessage 格式
 *
 * OpenAI 格式特点：
 * - role: 'system' | 'user' | 'assistant' | 'tool'
 * - content: string | ContentBlock[] (assistant 时)
 * - tool_calls: ToolCall[] (assistant 时)
 * - tool_call_id: string (tool 时)
 */

import { ChatMessage, ToolMessage, ToolResult } from '../chatTypes.js';
import { OpenAILLMChatMessage, OpenAIContentBlock, OpenAIToolCall } from '../llmMessageTypes.js';

export function openaiToChatMessages(messages: OpenAILLMChatMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			result.push(openaiSystemToChatMessage(msg));
		} else if (msg.role === 'user') {
			result.push(openaiUserToChatMessage(msg));
		} else if (msg.role === 'assistant') {
			result.push(...openaiAssistantToChatMessage(msg));
		} else if (msg.role === 'tool') {
			result.push(openaiToolToChatMessage(msg));
		}
	}

	return result;
}

function openaiSystemToChatMessage(msg: OpenAILLMChatMessage): ChatMessage {
	// msg.role === 'system' 已经在调用处检查过
	return {
		role: 'system',
		content: (msg as { content: string }).content,
		timestamp: Date.now(),
	} as ChatMessage;
}

function openaiUserToChatMessage(msg: OpenAILLMChatMessage): ChatMessage {
	return {
		role: 'user',
		content: (msg as { content: string }).content,
		displayContent: (msg as { content: string }).content,
		selections: null,
		timestamp: Date.now(),
	} as ChatMessage;
}

function openaiAssistantToChatMessage(msg: Extract<OpenAILLMChatMessage, { role: 'assistant' }>): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
	const textContent = contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('');
	const toolCalls = msg.tool_calls || [];

	// Assistant 消息
	messages.push({
		role: 'assistant',
		content: textContent,
		reasoning: '',
		thinking: [],
		timestamp: Date.now(),
	});

	// Tool 消息
	for (const tc of toolCalls) {
		messages.push({
			role: 'tool',
			id: tc.id,
			name: tc.function.name,
			params: parseToolArguments(tc.function.arguments),
			rawParams: { [tc.function.name]: tc.function.arguments },
			result: null,
			status: 'pending',
			timestamp: Date.now(),
		});
	}

	return messages;
}

function openaiToolToChatMessage(msg: Extract<OpenAILLMChatMessage, { role: 'tool' }>): ToolMessage {
	return {
		role: 'tool',
		id: msg.tool_call_id,
		name: '', // OpenAI tool message 不包含 name
		params: {},
		rawParams: {},
		result: {
			content: [{ type: 'text', text: msg.content }],
		},
		status: 'success',
		timestamp: Date.now(),
	};
}

/**
 * 将统一 ChatMessage 格式转换为 OpenAI 格式（用于发送到 OpenAI API）
 */
export function chatMessagesToOpenAI(messages: ChatMessage[]): OpenAILLMChatMessage[] {
	const result: OpenAILLMChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			result.push({
				role: 'system',
				content: msg.content,
			});
		} else if (msg.role === 'user') {
			result.push({
				role: 'user',
				content: msg.content,
			});
		} else if (msg.role === 'assistant') {
			const contentBlocks: OpenAIContentBlock[] = [];
			if (msg.content) {
				contentBlocks.push({ type: 'text', text: msg.content });
			}
			const toolCalls: OpenAIToolCall[] = [];
			// TODO: 从 thinking/tool 中提取 tool_calls
			result.push({
				role: 'assistant',
				content: contentBlocks,
				tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
			});
		} else if (msg.role === 'tool') {
			result.push({
				role: 'tool',
				content: msg.result ? toolResultToText(msg.result) : '',
				tool_call_id: msg.id,
			});
		}
	}

	return result;
}

function parseToolArguments(argsStr: string): Record<string, unknown> {
	try {
		return JSON.parse(argsStr);
	} catch {
		return { _raw: argsStr };
	}
}

function toolResultToText(result: ToolResult): string {
	return result.content
		.filter(c => c.type === 'text')
		.map(c => c.text || '')
		.join('');
}
