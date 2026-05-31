/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage, AssistantMessage, ToolMessage, ThinkingBlock, ToolResult } from './chatTypes.js';
import { LLMChatMessage, AnthropicLLMChatMessage, OpenAILLMChatMessage, GeminiLLMChatMessage, AGUIMessage } from './llmMessageTypes.js';
import { IModelDelta, IChatStreamDelta, IChatMessage, IToolCallInfo } from './providers.js';

// ============================================================================
// 格式适配器：旧格式（providers.ts）-> 新格式（chatTypes.ts）
// ============================================================================

/**
 * 将 IModelDelta 转换为 ChatMessage[]
 * 注意：IModelDelta 是流式的，需要累积多个 delta 才能形成完整的 ChatMessage
 */
export function modelDeltaToChatMessages(deltas: readonly IModelDelta[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	let currentAssistantMessage: AssistantMessage | null = null;
	let currentToolMessages: ToolMessage[] = [];

	for (const delta of deltas) {
		switch (delta.type) {
			case 'text':
				if (!currentAssistantMessage) {
					currentAssistantMessage = createEmptyAssistantMessage();
				}
				// 由于 ChatMessage 不支持流式 text（它是完整消息），这里需要累积
				// 实际实现中，应该在调用此函数前已经累积好了
				break;

			case 'thinking':
				if (!currentAssistantMessage) {
					currentAssistantMessage = createEmptyAssistantMessage();
				}
				// 思考内容累积到 thinking 字段
				break;

			case 'tool_call':
				// tool_call delta 包含 IToolCallInfo，需要转换为 ToolMessage
				if (delta.toolCall) {
					const toolMsg = toolCallInfoToToolMessage(delta.toolCall);
					currentToolMessages.push(toolMsg);
				}
				break;

			case 'done':
				// 消息结束，保存当前消息
				if (currentAssistantMessage) {
					messages.push(currentAssistantMessage);
					currentAssistantMessage = null;
				}
				if (currentToolMessages.length > 0) {
					messages.push(...currentToolMessages);
					currentToolMessages = [];
				}
				break;

			case 'error':
				// 错误消息，保存为 AssistantMessage 带错误
				if (currentAssistantMessage) {
					messages.push(currentAssistantMessage);
				}
				// TODO: 可能需要创建错误类型的消息
				currentAssistantMessage = null;
				currentToolMessages = [];
				break;
		}
	}

	// 处理末尾未保存的消息
	if (currentAssistantMessage) {
		messages.push(currentAssistantMessage);
	}
	if (currentToolMessages.length > 0) {
		messages.push(...currentToolMessages);
	}

	return messages;
}

function createEmptyAssistantMessage(): AssistantMessage {
	return {
		role: 'assistant',
		content: '',
		reasoning: '',
		thinking: [],
		timestamp: Date.now(),
	};
}

function toolCallInfoToToolMessage(toolCall: IToolCallInfo): ToolMessage {
	const params = parseToolArguments(toolCall.arguments);
	return {
		role: 'tool',
		id: toolCall.id,
		name: toolCall.name,
		params,
		rawParams: { [toolCall.name]: toolCall.arguments },
		result: null, // 尚未执行
		status: 'pending',
		timestamp: Date.now(),
	};
}

function parseToolArguments(argsStr: string): Record<string, unknown> {
	try {
		return JSON.parse(argsStr);
	} catch {
		return { _raw: argsStr };
	}
}

// ============================================================================
// 格式适配器：IChatStreamDelta -> ChatMessage
// ============================================================================

/**
 * 将 IChatStreamDelta 流转换为 ChatMessage[]
 * IChatStreamDelta 是更丰富的流格式，包含 tool_start/tool_args/tool_end/tool_result 等
 */
export function chatStreamDeltasToChatMessages(deltas: readonly IChatStreamDelta[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	let currentAssistant: AssistantMessage | null = null;
	let currentTool: ToolMessage | null = null;
	const toolMap = new Map<string, ToolMessage>(); // toolCallId -> ToolMessage (pending)

	for (const delta of deltas) {
		switch (delta.type) {
			case 'text':
				if (!currentAssistant) {
					currentAssistant = createEmptyAssistantMessage();
				}
				// text delta 累积到 content
				break;

			case 'thinking':
				if (!currentAssistant) {
					currentAssistant = createEmptyAssistantMessage();
				}
				// thinking delta 累积到 thinking
				break;

			case 'tool_start':
				// 开始一个新的工具调用
				currentTool = createPendingToolMessage(delta);
				toolMap.set(delta.toolCallId!, currentTool);
				break;

			case 'tool_args':
				// 工具参数 delta（可能分片）
				if (currentTool && delta.toolCallId) {
					// 更新参数
				}
				break;

			case 'tool_end':
				// 工具调用结束
				if (currentTool && delta.toolCallId) {
					currentTool = null;
				}
				break;

			case 'tool_result':
				// 工具执行结果
				if (delta.toolCallId) {
					const existing = toolMap.get(delta.toolCallId);
					if (existing) {
						// 更新结果为 success/error
						// 简化：这里假设 result 已经通过其他方式设置
					}
				}
				break;

			case 'done':
				// 流结束
				if (currentAssistant) {
					messages.push(currentAssistant);
					currentAssistant = null;
				}
				// 保存所有 pending 的 tool messages
				for (const tool of toolMap.values()) {
					messages.push(tool);
				}
				toolMap.clear();
				currentTool = null;
				break;
		}
	}

	// 处理剩余
	if (currentAssistant) {
		messages.push(currentAssistant);
	}
	for (const tool of toolMap.values()) {
		messages.push(tool);
	}

	return messages;
}

function createPendingToolMessage(delta: IChatStreamDelta): ToolMessage {
	return {
		role: 'tool',
		id: delta.toolCallId || '',
		name: delta.toolName || '',
		params: {},
		rawParams: {},
		result: null,
		status: 'pending',
		timestamp: Date.now(),
	};
}

// ============================================================================
// 格式适配器：LLMChatMessage -> ChatMessage
// ============================================================================

/**
 * 将 LLM 原始格式（Anthropic/OpenAI/Gemini/AGUI）转换为统一 ChatMessage 格式
 */
export function llmMessageToChatMessage(messages: LLMChatMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];

	for (const msg of messages) {
		if (isAnthropicMessage(msg)) {
			result.push(...anthropicMessageToChatMessage(msg));
		} else if (isOpenAIMessage(msg)) {
			result.push(...openaiMessageToChatMessage(msg));
		} else if (isGeminiMessage(msg)) {
			result.push(...geminiMessageToChatMessage(msg));
		} else if (isAGUIMessage(msg)) {
			result.push(...aguiMessageToChatMessage(msg));
		}
	}

	return result;
}

function isAnthropicMessage(msg: LLMChatMessage): msg is AnthropicLLMChatMessage {
	return ('role' in msg) && ((msg as any).role === 'assistant' || (msg as any).role === 'user');
}

function isOpenAIMessage(msg: LLMChatMessage): msg is OpenAILLMChatMessage {
	return ('role' in msg) && ((msg as any).role === 'system' || (msg as any).role === 'assistant' || (msg as any).role === 'tool');
}

function isGeminiMessage(msg: LLMChatMessage): msg is GeminiLLMChatMessage {
	return ('role' in msg) && ((msg as any).role === 'model' || (msg as any).role === 'user');
}

function isAGUIMessage(msg: LLMChatMessage): msg is AGUIMessage {
	return ('role' in msg) && (((msg as any).role === 'assistant' && 'tool_calls' in (msg as any)) || ((msg as any).role === 'tool' && 'tool_call_id' in (msg as any)));
}

function anthropicMessageToChatMessage(msg: AnthropicLLMChatMessage): ChatMessage[] {
	// 简化实现
	if (msg.role === 'assistant') {
		const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
		const textContent = content.filter(c => c.type === 'text').map(c => (c as any).text).join('');
		const thinkingBlocks = content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking');
		const toolUses = content.filter(c => c.type === 'tool_use');

		const messages: ChatMessage[] = [];

		// Assistant 消息
		messages.push({
			role: 'assistant',
			content: textContent,
			reasoning: '',
			thinking: thinkingBlocks as ThinkingBlock[],
			timestamp: Date.now(),
		});

		// Tool 消息（每个 tool_use 对应一个）
		for (const toolUse of toolUses) {
			messages.push({
				role: 'tool',
				id: (toolUse as any).id,
				name: (toolUse as any).name,
				params: (toolUse as any).input,
				rawParams: {},
				result: null,
				status: 'pending',
				timestamp: Date.now(),
			});
		}

		return messages;
	} else {
		// user message - 简化
		return [{
			role: 'user',
			content: typeof msg.content === 'string' ? msg.content : '',
			displayContent: typeof msg.content === 'string' ? msg.content : '',
			selections: null,
			timestamp: Date.now(),
		}];
	}
}

function openaiMessageToChatMessage(msg: OpenAILLMChatMessage): ChatMessage[] {
	// 简化实现
	if (msg.role === 'assistant') {
		const content = Array.isArray(msg.content) ? msg.content : [];
		const textContent = content.filter(c => c.type === 'text').map(c => c.text).join('');
		const toolCalls = msg.tool_calls || [];

		const messages: ChatMessage[] = [];

		messages.push({
			role: 'assistant',
			content: textContent,
			reasoning: '',
			thinking: [],
			timestamp: Date.now(),
		});

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
	} else if (msg.role === 'tool') {
		return [{
			role: 'tool',
			id: msg.tool_call_id,
			name: '', // OpenAI tool message 不包含 name
			params: {},
			rawParams: {},
			result: { content: [{ type: 'text', text: msg.content }] },
			status: 'success',
			timestamp: Date.now(),
		}];
	} else {
		// system or user
		return [{
			role: msg.role === 'system' ? 'system' : 'user',
			content: msg.content,
			...(msg.role === 'user' ? { displayContent: msg.content, selections: null } : {}),
			timestamp: Date.now(),
		} as any];
	}
}

function geminiMessageToChatMessage(msg: GeminiLLMChatMessage): ChatMessage[] {
	// 简化实现
	return []; // TODO
}

function aguiMessageToChatMessage(msg: AGUIMessage): ChatMessage[] {
	// 简化实现
	if (msg.role === 'assistant') {
		const messages: ChatMessage[] = [];

		messages.push({
			role: 'assistant',
			content: msg.content,
			reasoning: '',
			thinking: [],
			timestamp: Date.now(),
		});

		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				messages.push({
					role: 'tool',
					id: tc.id,
					name: tc.name,
					params: parseToolArguments(tc.arguments),
					rawParams: { [tc.name]: tc.arguments },
					result: null,
					status: tc.server_executed ? 'running' : 'pending',
					timestamp: Date.now(),
				});
			}
		}

		return messages;
	} else {
		// tool message
		return [{
			role: 'tool',
			id: msg.tool_call_id,
			name: '',
			params: {},
			rawParams: {},
			result: { content: [{ type: 'text', text: msg.content }] },
			status: 'success',
			timestamp: Date.now(),
		}];
	}
}

// ============================================================================
// 格式适配器：ChatMessage -> IChatMessage（旧格式，用于向后兼容）
// ============================================================================

/**
 * 将统一 ChatMessage 格式转换为旧格式 IChatMessage[]
 * 用于需要向后兼容的旧代码
 */
export function chatMessagesToIChatMessages(messages: ChatMessage[]): IChatMessage[] {
	return messages.map(msg => chatMessageToIChatMessage(msg));
}

function chatMessageToIChatMessage(msg: ChatMessage): IChatMessage {
	switch (msg.role) {
		case 'user':
			return {
				role: 'user',
				content: msg.content,
				toolCalls: [],
			};

		case 'assistant':
			return {
				role: 'assistant',
				content: msg.content,
				toolCalls: [], // TODO: 从 thinking/tool 中提取
			};

		case 'tool':
			return {
				role: 'tool',
				content: msg.result ? toolResultToContent(msg.result) : '',
				toolCallId: msg.id,
			};

		case 'system':
			return {
				role: 'user', // 系统消息在旧格式中没有对应，转为 user
				content: msg.content,
				toolCalls: [],
			};

		default:
			return {
				role: 'user',
				content: '',
				toolCalls: [],
			};
	}
}

function toolResultToContent(result: ToolResult): string {
	const textContent = result.content
		.filter(c => c.type === 'text')
		.map(c => (c as any).text)
		.join('');
	return textContent;
}
