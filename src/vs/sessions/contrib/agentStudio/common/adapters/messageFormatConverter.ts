/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MessageFormatConverter — 集中式消息格式转换工具类
 *
 * 将 IChatMessage[]（providers.ts 中定义的统一格式）转换为不同 LLM 提供商的 API 请求格式。
 * 参考 Void 项目的 convertToLLMMessageService 集中式转换层设计。
 *
 * 解决的问题：
 * - builtInBYOKModelProvider.ts 中的内联消息转换逻辑
 * - languageModelsBridge.ts 中的 _toLanguageModelMessages() 方法
 * - 各适配器之间重复的转换逻辑
 *
 * 使用方式：
 *   import { MessageFormatConverter } from '../common/adapters/messageFormatConverter.js';
 *
 *   // 转换为 OpenAI 格式
 *   const openaiMessages = MessageFormatConverter.toOpenAI(messages, options);
 *
 *   // 转换为 Anthropic 格式
 *   const { messages: anthropicMsgs, systemPrompt } = MessageFormatConverter.toAnthropic(messages, options);
 *
 *   // 转换为 Gemini 格式
 *   const { contents, systemInstruction } = MessageFormatConverter.toGemini(messages, options);
 */

import { IChatMessage, IModelOptions, IToolDefinition, IModelCapabilityConfig } from '../providers.js';
import {
	OpenAILLMChatMessage, OpenAIToolCall,
	AnthropicLLMChatMessage, AnthropicContentBlock, AnthropicUserContentBlock,
	GeminiLLMChatMessage, GeminiPart,
} from '../llmMessageTypes.js';

// ─── OpenAI 格式转换 ──────────────────────────────────────────────────────

export interface OpenAIConvertOptions {
	readonly isAnthropic?: boolean;
	readonly tools?: IToolDefinition[];
	readonly capabilityConfig?: IModelCapabilityConfig;
}

export class MessageFormatConverter {

	// ─── OpenAI 格式 ──────────────────────────────────────────────────

	/**
	 * 将 IChatMessage[] 转换为 OpenAI 格式消息列表。
	 *
	 * OpenAI 格式特点：
	 * - system: { role: 'system' | 'developer', content: string }
	 * - user:   { role: 'user', content: string }
	 * - assistant: { role: 'assistant', content: string, tool_calls?: ToolCall[] }
	 * - tool:   { role: 'tool', content: string, tool_call_id: string }
	 *
	 * @param messages 统一格式的消息列表
	 * @param options 转换选项
	 * @returns OpenAI 格式的消息列表
	 */
	static toOpenAI(messages: IChatMessage[], options?: OpenAIConvertOptions): OpenAILLMChatMessage[] {
		const result: OpenAILLMChatMessage[] = [];
		const config = options?.capabilityConfig;

		// 确定系统消息的角色
		// 如果 capabilityConfig 声明了 developer-role（如 OpenAI o-series），使用 'developer'
		const systemRole = config?.supportsSystemMessage === 'developer-role' ? 'developer' : 'system';

		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];

			if (m.role === 'system') {
				const base: Record<string, unknown> = { role: systemRole, content: m.content };

				// KV Cache: Anthropic Prompt Caching — 在最后一个 system message 注入 cache_control
				if (options?.isAnthropic) {
					const lastSystemIdx = messages.reduce(
						(last, msg, idx) => (msg.role === 'system' ? idx : last),
						-1,
					);
					if (i === lastSystemIdx) {
						base.cache_control = { type: 'ephemeral' };
					}
				}

				result.push(base as OpenAILLMChatMessage);
			} else if (m.role === 'user') {
				result.push({ role: 'user', content: m.content });
			} else if (m.role === 'assistant') {
				const base: Record<string, unknown> = { role: 'assistant', content: m.content };

				// 工具调用转换
				if (m.toolCalls && m.toolCalls.length > 0) {
					base.tool_calls = m.toolCalls.map(tc => ({
						id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						type: 'function' as const,
						function: {
							name: tc.name,
							arguments: tc.arguments || '{}',
						},
					}));
				}

				result.push(base as OpenAILLMChatMessage);
			} else if (m.role === 'tool') {
				result.push({
					role: 'tool',
					content: m.content,
					tool_call_id: m.toolCallId || '',
				});
			}
		}

		return result;
	}

	/**
	 * 将 IToolDefinition[] 转换为 OpenAI 格式的工具定义。
	 */
	static toOpenAITools(tools: IToolDefinition[]): OpenAIToolCall[] {
		return tools.map(t => ({
			type: 'function' as const,
			id: '',
			function: {
				name: t.name,
				arguments: JSON.stringify(t.inputSchema),
			},
		}));
	}

	/**
	 * 构建 OpenAI 格式的工具定义列表（用于 API 请求的 tools 字段）。
	 */
	static toOpenAIToolDefinitions(tools: IToolDefinition[]): Array<{
		type: 'function';
		function: { name: string; description: string; parameters: Record<string, unknown> };
	}> {
		return tools.map(t => ({
			type: 'function' as const,
			function: {
				name: t.name,
				description: t.description,
				parameters: t.inputSchema,
			},
		}));
	}

	// ─── Anthropic 格式 ──────────────────────────────────────────────

	/**
	 * 将 IChatMessage[] 转换为 Anthropic 格式消息列表。
	 *
	 * Anthropic 格式特点：
	 * - system 消息不包含在 messages 数组中，而是作为单独的 system 参数
	 * - assistant: { role: 'assistant', content: string | ContentBlock[] }
	 * - user:     { role: 'user', content: string | UserContentBlock[] }
	 * - tool 结果通过 user 消息中的 tool_result 块传递
	 *
	 * @param messages 统一格式的消息列表
	 * @param options 转换选项（包含 systemPrompt）
	 * @returns Anthropic 格式的消息列表 + 分离的系统消息
	 */
	static toAnthropic(
		messages: IChatMessage[],
		options?: { systemPrompt?: string; tools?: IToolDefinition[] },
	): { messages: AnthropicLLMChatMessage[]; systemPrompt: string | undefined } {
		const result: AnthropicLLMChatMessage[] = [];
		let systemPrompt: string | undefined;

		// 提取系统消息（Anthropic 格式中系统消息是单独的参数）
		for (const m of messages) {
			if (m.role === 'system') {
				systemPrompt = systemPrompt ? `${systemPrompt}\n\n${m.content}` : m.content;
			}
		}

		// 如果 options 中有 systemPrompt，合并
		if (options?.systemPrompt) {
			systemPrompt = systemPrompt ? `${options.systemPrompt}\n\n${systemPrompt}` : options.systemPrompt;
		}

		// 转换非系统消息
		for (const m of messages) {
			if (m.role === 'system') { continue; }

			if (m.role === 'user') {
				result.push({ role: 'user', content: m.content });
			} else if (m.role === 'assistant') {
				const contentBlocks: AnthropicContentBlock[] = [];
				if (m.content) {
					contentBlocks.push({ type: 'text', text: m.content });
				}

				// 工具调用转换
				if (m.toolCalls && m.toolCalls.length > 0) {
					for (const tc of m.toolCalls) {
						let input: Record<string, unknown>;
						try {
							input = JSON.parse(tc.arguments || '{}');
						} catch {
							input = { _raw: tc.arguments };
						}
						contentBlocks.push({
							type: 'tool_use',
							name: tc.name,
							input,
							id: tc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						});
					}
				}

				result.push({
					role: 'assistant',
					content: contentBlocks.length > 0 ? contentBlocks : m.content,
				});
			} else if (m.role === 'tool') {
				// Tool 结果在 Anthropic 格式中是 user 消息中的 tool_result 块
				const userBlocks: AnthropicUserContentBlock[] = [{
					type: 'tool_result',
					tool_use_id: m.toolCallId || '',
					content: m.content,
				}];
				result.push({ role: 'user', content: userBlocks });
			}
		}

		return { messages: result, systemPrompt };
	}

	/**
	 * 构建 Anthropic 格式的工具定义列表。
	 */
	static toAnthropicToolDefinitions(tools: IToolDefinition[]): Array<{
		name: string;
		description: string;
		input_schema: Record<string, unknown>;
	}> {
		return tools.map(t => ({
			name: t.name,
			description: t.description,
			input_schema: t.inputSchema,
		}));
	}

	// ─── Gemini 格式 ──────────────────────────────────────────────

	/**
	 * 将 IChatMessage[] 转换为 Gemini 格式消息列表。
	 *
	 * Gemini 格式特点：
	 * - system 消息不包含在 contents 数组中，而是作为 systemInstruction
	 * - model: { role: 'model', parts: Part[] }  (assistant → model)
	 * - user:  { role: 'user', parts: Part[] }
	 * - tool 结果通过 user 消息中的 functionResponse 传递
	 *
	 * @param messages 统一格式的消息列表
	 * @param options 转换选项（包含 systemPrompt）
	 * @returns Gemini 格式的消息列表 + 系统指令
	 */
	static toGemini(
		messages: IChatMessage[],
		options?: { systemPrompt?: string; tools?: IToolDefinition[] },
	): { contents: GeminiLLMChatMessage[]; systemInstruction: string | undefined } {
		const result: GeminiLLMChatMessage[] = [];
		let systemInstruction: string | undefined;

		// 提取系统消息（Gemini 格式中系统消息是 systemInstruction）
		for (const m of messages) {
			if (m.role === 'system') {
				systemInstruction = systemInstruction ? `${systemInstruction}\n\n${m.content}` : m.content;
			}
		}

		// 如果 options 中有 systemPrompt，合并
		if (options?.systemPrompt) {
			systemInstruction = systemInstruction ? `${options.systemPrompt}\n\n${systemInstruction}` : options.systemPrompt;
		}

		// 转换非系统消息
		for (const m of messages) {
			if (m.role === 'system') { continue; }

			if (m.role === 'user') {
				result.push({ role: 'user', parts: [{ text: m.content }] });
			} else if (m.role === 'assistant') {
				const parts: GeminiPart[] = [];
				if (m.content) {
					parts.push({ text: m.content });
				}

				// 工具调用转换
				if (m.toolCalls && m.toolCalls.length > 0) {
					for (const tc of m.toolCalls) {
						let args: Record<string, unknown>;
						try {
							args = JSON.parse(tc.arguments || '{}');
						} catch {
							args = { _raw: tc.arguments };
						}
						parts.push({
							functionCall: {
								id: tc.id || `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
								name: tc.name,
								args,
							},
						});
					}
				}

				result.push({ role: 'model', parts });
			} else if (m.role === 'tool') {
				// Tool 结果在 Gemini 格式中是 user 消息中的 functionResponse
				result.push({
					role: 'user',
					parts: [{
						functionResponse: {
							id: m.toolCallId || '',
							name: '', // IChatMessage 中 tool 角色无 name 字段
							response: { output: m.content },
						},
					}],
				});
			}
		}

		return { contents: result, systemInstruction };
	}

	// ─── 通用辅助方法 ──────────────────────────────────────────────

	/**
	 * 根据能力配置自动选择格式并转换。
	 *
	 * @param messages 统一格式的消息列表
	 * @param options 模型选项
	 * @param capabilityConfig 声明式能力配置
	 * @returns 转换后的消息 + 格式特定的元数据（如 systemPrompt、systemInstruction）
	 */
	static convert(
		messages: IChatMessage[],
		options: IModelOptions,
		capabilityConfig?: IModelCapabilityConfig,
	): {
		messages: OpenAILLMChatMessage[] | AnthropicLLMChatMessage[] | GeminiLLMChatMessage[];
		separateSystemMessage?: string;
		systemInstruction?: string;
	} {
		const toolFormat = capabilityConfig?.specialToolFormat;

		// 根据 specialToolFormat 决定格式
		if (toolFormat === 'anthropic-style') {
			const { messages: anthropicMsgs, systemPrompt } = this.toAnthropic(
				messages,
				{ systemPrompt: options.systemPrompt, tools: options.tools },
			);
			return { messages: anthropicMsgs, separateSystemMessage: systemPrompt };
		}

		if (toolFormat === 'gemini-style') {
			const { contents, systemInstruction } = this.toGemini(
				messages,
				{ systemPrompt: options.systemPrompt, tools: options.tools },
			);
			return { messages: contents, systemInstruction };
		}

		// 默认：OpenAI 格式（openai-style 或 undefined）
		const openaiMsgs = this.toOpenAI(messages, {
			isAnthropic: false,
			tools: options.tools,
			capabilityConfig,
		});
		return { messages: openaiMsgs };
	}

	/**
	 * 根据能力配置构建请求体的工具定义。
	 */
	static convertToolDefinitions(
		tools: IToolDefinition[],
		capabilityConfig?: IModelCapabilityConfig,
	): unknown {
		const toolFormat = capabilityConfig?.specialToolFormat;

		if (toolFormat === 'anthropic-style') {
			return this.toAnthropicToolDefinitions(tools);
		}

		// Gemini 工具定义（functionDeclarations）和 OpenAI 格式不同，
		// 但由于目前 Gemini 通过 OpenAI 兼容 API 调用，暂时使用 OpenAI 格式
		// TODO: 当添加 GeminiModelProvider 原生支持时，实现 toGeminiToolDefinitions()

		// 默认：OpenAI 格式
		return this.toOpenAIToolDefinitions(tools);
	}
}
