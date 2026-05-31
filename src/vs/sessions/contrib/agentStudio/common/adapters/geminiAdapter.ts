/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gemini 格式适配器
 * 将 GeminiLLMChatMessage 转换为统一 ChatMessage 格式
 *
 * Gemini 格式特点：
 * - role: 'model' | 'user'
 * - parts: Part[]
 * - Part 类型：text | functionCall | functionResponse
 */

import { ChatMessage, ToolResult } from '../chatTypes.js';
import { GeminiLLMChatMessage, GeminiPart, GeminiFunctionCall, GeminiFunctionResponse } from '../llmMessageTypes.js';

export function geminiToChatMessages(messages: GeminiLLMChatMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'model') {
			result.push(...geminiModelToChatMessage(msg));
		} else {
			result.push(...geminiUserToChatMessage(msg));
		}
	}

	return result;
}

function geminiModelToChatMessage(msg: Extract<GeminiLLMChatMessage, { role: 'model' }>): ChatMessage[] {
	const textParts = msg.parts.filter((p): p is Extract<GeminiPart, { text: string }> => 'text' in p);
	const functionCallParts = msg.parts.filter((p): p is Extract<GeminiPart, { functionCall: GeminiFunctionCall }> => 'functionCall' in p);

	const messages: ChatMessage[] = [];

	// Model 消息（文本内容）
	const textContent = textParts.map(p => p.text).join('');
	messages.push({
		role: 'assistant',
		content: textContent,
		reasoning: '',
		thinking: [],
		timestamp: Date.now(),
	});

	// Tool 消息（每个 functionCall 对应一个）
	for (const part of functionCallParts) {
		messages.push({
			role: 'tool',
			id: part.functionCall.id,
			name: part.functionCall.name,
			params: part.functionCall.args as Record<string, unknown>,
			rawParams: { [part.functionCall.name]: JSON.stringify(part.functionCall.args) },
			result: null,
			status: 'pending',
			timestamp: Date.now(),
		});
	}

	return messages;
}

function geminiUserToChatMessage(msg: Extract<GeminiLLMChatMessage, { role: 'user' }>): ChatMessage[] {
	const textParts = msg.parts.filter((p): p is Extract<GeminiPart, { text: string }> => 'text' in p);
	const functionResponseParts = msg.parts.filter((p): p is Extract<GeminiPart, { functionResponse: GeminiFunctionResponse }> => 'functionResponse' in p);

	const messages: ChatMessage[] = [];

	// User 消息（文本内容）
	const textContent = textParts.map(p => p.text).join('');
	messages.push({
		role: 'user',
		content: textContent,
		displayContent: textContent,
		selections: null,
		timestamp: Date.now(),
	});

	// Tool Result 消息（每个 functionResponse 对应一个）
	for (const part of functionResponseParts) {
		messages.push({
			role: 'tool',
			id: part.functionResponse.id,
			name: part.functionResponse.name,
			params: {},
			rawParams: {},
			result: {
				content: [{ type: 'text', text: part.functionResponse.response.output }],
			},
			status: 'success',
			timestamp: Date.now(),
		});
	}

	return messages;
}

/**
 * 将统一 ChatMessage 格式转换为 Gemini 格式（用于发送到 Gemini API）
 */
export function chatMessagesToGemini(messages: ChatMessage[]): GeminiLLMChatMessage[] {
	const result: GeminiLLMChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'user') {
			result.push({
				role: 'user',
				parts: [{ text: msg.content }],
			});
		} else if (msg.role === 'assistant') {
			const parts: GeminiPart[] = [];
			if (msg.content) {
				parts.push({ text: msg.content });
			}
			// TODO: 从 thinking/tool 中提取 functionCall
			result.push({
				role: 'model',
				parts,
			});
		} else if (msg.role === 'tool') {
			// Tool 消息在 Gemini 格式中是 user 消息（functionResponse）
			result.push({
				role: 'user',
				parts: [{
					functionResponse: {
						id: msg.id,
						name: msg.name,
						response: { output: msg.result ? toolResultToText(msg.result) : '' },
					},
				}],
			});
		} else if (msg.role === 'system') {
			// System 消息在 Gemini 格式中需要处理（通常是第一个 user 消息或单独处理）
			result.push({
				role: 'user',
				parts: [{ text: msg.content }],
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
