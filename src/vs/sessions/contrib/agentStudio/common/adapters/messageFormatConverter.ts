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
	AnthropicSystemParam,
	GeminiLLMChatMessage, GeminiPart,
} from '../llmMessageTypes.js';
import { evaluateForkPrefixCache, type IForkContext } from '../forkContext.js';

/** Anthropic 单次请求允许的 cache_control 断点上限（官方限制 = 4）。
 * 超过会被 provider 拒绝（400 invalid_request_error）。所有断点注入必须受此配额门控。 */
const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;

/** 统计任意消息结构中已存在的 cache_control 断点数量（递归 content 数组）。 */
function countCacheControlMarkers(value: unknown): number {
	if (!value || typeof value !== 'object') { return 0; }
	if ('cache_control' in value && (value as Record<string, unknown>).cache_control) {
		return 1;
	}
	const content = (value as Record<string, unknown>).content;
	if (Array.isArray(content)) {
		return content.reduce<number>((sum, block) => sum + countCacheControlMarkers(block), 0);
	}
	return 0;
}

/** 按工具名排序，保证 tools 前缀逐字节稳定（动态增删工具时顺序不再漂移）。
 * 返回排序后的副本，不修改入参。 */
function sortToolsByNameStable(tools: IToolDefinition[]): IToolDefinition[] {
	return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}
import type { AgentRunMessage } from '../agentRunState.js';
import { WIRE_DIALECTS, buildWireMessages, pickDialect } from './wireMessagePipeline.js';

// ─── OpenAI 格式转换 ──────────────────────────────────────────────────────

export interface OpenAIConvertOptions {
	readonly isAnthropic?: boolean;
	readonly tools?: IToolDefinition[];
	readonly capabilityConfig?: IModelCapabilityConfig;
	/**
	 * Agent 的冻结 system prompt（= 冻结前缀的 system 部分）。
	 * 仅用于 Fork 前缀缓存对齐判定（与父级 ForkContext 比对 fingerprint），
	 * 不参与消息组装（system message 已在 messages 中）。
	 */
	readonly systemPrompt?: string;
	/**
	 * 父级 ForkContext（请求构造端接 ForkContext 的完整形态）。
	 * 当本请求 (systemPrompt, tools) 与父级冻结前缀对齐时，在 system 前缀边界注入
	 * `cache_control` 断点 → 命中 provider prompt cache。省略 → 不注入 fork 断点。
	 */
	readonly forkContext?: IForkContext;
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
		// ── Wire 收口（2026-08-19，全 provider 统一守卫）──────────────────
		// 强制接入点：所有 provider 都必须经过格式转换才能发请求，收口层下沉到
		// 这条必经之路后，BYOK / Gemini / LMBridge / MainProcess 四个 provider
		// 全部自动获得保护，未来新增 provider 亦天然受保护。
		// 修复的事故：messages 以 assistant 结尾 → IOA 网关 400 code 11133
		// invalid_parameter_value（param 为空）。详见 wireMessagePipeline.ts 头注释。
		messages = buildWireMessages(
			messages as unknown as AgentRunMessage[],
			pickDialect(undefined, options?.isAnthropic),
		).wire as unknown as IChatMessage[];

		const result: OpenAILLMChatMessage[] = [];
		const config = options?.capabilityConfig;

		// Fork 前缀缓存：cache_control 为 Anthropic 专有协议字段，仅 Anthropic 兼容
		// provider 下发（OpenAI 原生靠前缀自动缓存，无需标记）。forkContext 在 OpenAI 下的
		// 作用是保证 system+tools 前缀逐字节一致（冻结），由 sub-agent 复用/toolsets 继承
		// 实现；对齐判定在 agentOSService 层完成并打日志。
		// 仅 Anthropic 兼容 provider 下发 cache_control 标记（OpenAI 原生不识别该字段）。
		const cachePrefix = options?.isAnthropic === true;

		// 确定系统消息的角色
		// 如果 capabilityConfig 声明了 developer-role（如 OpenAI o-series），使用 'developer'
		const systemRole = config?.supportsSystemMessage === 'developer-role' ? 'developer' : 'system';

		// 冻结前缀对应的 system message 索引：优先精确匹配 options.systemPrompt（即 agent
		// 冻结 system），找不到时退回「最后一个 system message」（与旧行为一致）。
		const frozenSystemIdx = options?.systemPrompt
			? messages.findIndex((m) => m.role === 'system' && m.content === options.systemPrompt)
			: -1;
		const targetSystemIdx = frozenSystemIdx >= 0
			? frozenSystemIdx
			: messages.reduce((last, msg, idx) => (msg.role === 'system' ? idx : last), -1);

		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];

			if (m.role === 'system') {
				const base: Record<string, unknown> = { role: systemRole, content: m.content };

				// KV Cache: 在冻结前缀对应的 system message 注入 cache_control（Anthropic
				// 兼容）。provider 据此把稳定前缀写入 prompt cache，父/子 fork 请求共享同一
				// 缓存条目。forkContext 对齐时该前缀与父级完全一致 → cache 命中而非重计费。
				if (cachePrefix && i === targetSystemIdx) {
					base.cache_control = { type: 'ephemeral' };
				}

				result.push(base as OpenAILLMChatMessage);
			} else if (m.role === 'user') {
				// Check for multimodal content parts (images/files)
				if (m.contentParts && m.contentParts.length > 0) {
					const parts: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [];
					for (const part of m.contentParts) {
						if (part.type === 'text') {
							parts.push({ type: 'text', text: part.text });
						} else if (part.type === 'image') {
							parts.push({
								type: 'image_url',
								image_url: {
									url: `data:${part.mimeType};base64,${part.data}`,
									detail: 'auto',
								},
							});
						}
					}
					result.push({ role: 'user', content: parts as any });
				} else {
					result.push({ role: 'user', content: m.content });
				}
			} else if (m.role === 'assistant') {
				// ReAct: 合并 reasoning 到 content（模型在下一轮迭代中可"看见"自己的思考过程）
				const fullContent = m.reasoning
					? `<thinking>\n${m.reasoning}\n</thinking>\n\n${m.content}`
					: m.content;

				const base: Record<string, unknown> = { role: 'assistant', content: fullContent };

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
	 *
	 * @param forkContext 父级 ForkContext（可选）。当 isAnthropic 为真时，在最后一个
	 *   工具定义上注入 cache_control 断点，使冻结的 tools 前缀也进入 prompt cache
	 *   （system + tools 共同构成父/子 fork 共享的缓存前缀）。
	 * @param isAnthropic 是否 Anthropic 兼容 provider（cache_control 为 Anthropic 专有字段）。
	 * @param systemPrompt agent 冻结 system（仅用于对齐判定，不参与组装）。
	 */
	static toOpenAIToolDefinitions(
		tools: IToolDefinition[],
		forkContext?: IForkContext,
		isAnthropic?: boolean,
		systemPrompt?: string,
	): Array<{
		type: 'function';
		function: { name: string; description: string; parameters: Record<string, unknown> };
		cache_control?: { type: 'ephemeral' };
	}> {
		// 仅 Anthropic 兼容 provider 给 tools 打 cache 断点（OpenAI 原生不识别该字段）。
		// forkContext 存在时认为本请求 fork 感知，值得把 tools 前缀一并冻结进 cache。
		const cacheTools = isAnthropic === true &&
			!!forkContext &&
			evaluateForkPrefixCache(forkContext, systemPrompt ?? '', tools).aligned;
		return tools.map((t, idx) => {
			const def: {
				type: 'function';
				function: { name: string; description: string; parameters: Record<string, unknown> };
				cache_control?: { type: 'ephemeral' };
			} = {
				type: 'function' as const,
				function: {
					name: t.name,
					description: t.description,
					parameters: t.inputSchema,
				},
			};
			if (cacheTools && idx === tools.length - 1) {
				def.cache_control = { type: 'ephemeral' };
			}
			return def;
		});
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
		options?: {
			systemPrompt?: string;
			tools?: IToolDefinition[];
			forkContext?: IForkContext;
			/**
			 * 是否 Anthropic 兼容 provider。本方法生成的即为 Anthropic 方言，
			 * 故默认（undefined）视为 true。仅当显式传 false（非 Anthropic 风格但复用
			 * 了本转换路径）时，跳过 cache_control 断点（其他 provider 原生不识别该字段）。
			 */
			isAnthropic?: boolean;
		},
	): { messages: AnthropicLLMChatMessage[]; systemPrompt: AnthropicSystemParam | undefined } {
		// ── Wire 收口（anthropic 方言：约束最严）──────────────────────────
		// Anthropic 拒绝 ① 以 assistant 结尾（被当作 prefill，no-prefill 模型报
		// 400 must end with a user message）② 空 content blocks 数组
		// ③ 未闭合的 tool 序列（会把后续 user 幻觉成工具结果延续）。
		messages = buildWireMessages(
			messages as unknown as AgentRunMessage[],
			WIRE_DIALECTS.anthropic,
		).wire as unknown as IChatMessage[];

		const result: AnthropicLLMChatMessage[] = [];
		let systemPrompt: AnthropicSystemParam | undefined;

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

		// P0 修复（2026-08-30）：把 system 转为带 cache_control 断点的数组形态。
		// Anthropic 的 system 顶层参数只有写成 [{type:'text', text, cache_control}]
		// 才会作为可缓存前缀断点；裸 string 形态无法命中 prompt cache，导致每轮全量重计费。
		// 该断点与 toAnthropicToolDefinitions 中工具数组末尾的 cache_control 共同构成
		// 一个稳定前缀。
		//
		// cache 策略与 toOpenAI 对称：只要 isAnthropic（默认 true）就无条件注入断点——
		// 主会话的 system+tools 前缀逐轮稳定，本就该命中 prompt cache；forkContext 仅用于
		// 额外保证字节一致性（aligned 校验），不再作为注入断点的前置门槛（否则无 fork 的
		// 主会话命中率恒为 0%）。forkContext 存在且未对齐时，跳过断点以避免缓存脏前缀。
		const isAnthropic = options?.isAnthropic !== false;
		if (systemPrompt && isAnthropic) {
			const aligned = options?.forkContext
				? evaluateForkPrefixCache(
					options.forkContext,
					options.systemPrompt ?? '',
					options.tools ?? [],
				).aligned
				: true;
			// 配额门控：tools 段在 toAnthropicToolDefinitions 中恒占 1 个断点，
			// 预留后确认 system 断点不会使总量超 ANTHROPIC_CACHE_CONTROL_LIMIT。
			const toolsWillMark = 1;
			const remaining = ANTHROPIC_CACHE_CONTROL_LIMIT - toolsWillMark;
			if (aligned && remaining >= 1) {
				systemPrompt = [{
					type: 'text',
					text: systemPrompt,
					cache_control: { type: 'ephemeral' },
				}] as AnthropicSystemParam;
			}
		}

		// 转换非系统消息
		for (const m of messages) {
			if (m.role === 'system') { continue; }

			if (m.role === 'user') {
				// Check for multimodal content parts (images)
				if (m.contentParts && m.contentParts.length > 0) {
					const blocks: AnthropicUserContentBlock[] = [];
					for (const part of m.contentParts) {
						if (part.type === 'text') {
							blocks.push({ type: 'text', text: part.text });
						} else if (part.type === 'image') {
							// Anthropic uses base64 source blocks for images
							(blocks as any[]).push({
								type: 'image',
								source: {
									type: 'base64',
									media_type: part.mimeType,
									data: part.data,
								},
							});
						}
					}
					result.push({ role: 'user', content: blocks });
				} else {
					result.push({ role: 'user', content: m.content });
				}
			} else if (m.role === 'assistant') {
				const contentBlocks: AnthropicContentBlock[] = [];

				// ReAct: reasoning → <thinking> block prepended before visible content
				if (m.reasoning) {
					contentBlocks.push({ type: 'text', text: `<thinking>\n${m.reasoning}\n</thinking>` });
				}
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
	 *
	 * @param forkContext 父级 ForkContext（可选）。当 isAnthropic 为真时，在最后一个
	 *   工具定义上注入 cache_control 断点，使冻结的 tools 前缀进入 prompt cache。
	 * @param isAnthropic 是否 Anthropic 兼容 provider。
	 * @param systemPrompt agent 冻结 system（仅用于对齐判定）。
	 */
	static toAnthropicToolDefinitions(
		tools: IToolDefinition[],
		forkContext?: IForkContext,
		isAnthropic?: boolean,
		systemPrompt?: string,
	): Array<{
		name: string;
		description: string;
		input_schema: Record<string, unknown>;
		cache_control?: { type: 'ephemeral' };
	}> {
		// 与 toAnthropic system 断点对称：Anthropic 兼容 provider 无条件注入 tools 末尾
		// 断点（主会话稳定前缀即可命中）；有 forkContext 时额外校验对齐，未对齐则跳过。
		const cacheTools = isAnthropic === true && (
			!forkContext || evaluateForkPrefixCache(forkContext, systemPrompt ?? '', tools).aligned
		);
		// P1（2026-08-30）：按工具名排序，保证 tools 前缀逐字节稳定。
		// 动态增删工具时注册顺序会漂移，导致 system+tools 整段前缀哈希变化、缓存失效。
		// 排序后整体返回，与 openclaw sortPromptCacheToolsByName 同策略。
		const orderedTools = sortToolsByNameStable(tools);
		// P0 对称：tools 段断点计入全局配额（system 已预留 1）。
		const withinQuota = countCacheControlMarkers(orderedTools) < ANTHROPIC_CACHE_CONTROL_LIMIT - 1;
		const markTools = cacheTools && withinQuota;
		const lastIdx = orderedTools.length - 1;
		return orderedTools.map((t, idx) => {
			const def: {
				name: string;
				description: string;
				input_schema: Record<string, unknown>;
				cache_control?: { type: 'ephemeral' };
			} = {
				name: t.name,
				description: t.description,
				input_schema: t.inputSchema,
			};
			if (markTools && idx === lastIdx) {
				def.cache_control = { type: 'ephemeral' };
			}
			return def;
		});
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
		// ── Wire 收口（gemini 方言）────────────────────────────────────────
		// Gemini contents 要求首条为 user、且不得以 model 结尾。注意本方法会把
		// tool 角色转成 user(functionResponse)，因此"以 tool 结尾"在 Gemini 侧
		// 是合法的 user 结尾；但"以 assistant 结尾"会变成 model 结尾 → 报错。
		messages = buildWireMessages(
			messages as unknown as AgentRunMessage[],
			WIRE_DIALECTS.gemini,
		).wire as unknown as IChatMessage[];

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
				// Check for multimodal content parts (images)
				if (m.contentParts && m.contentParts.length > 0) {
					const parts: GeminiPart[] = [];
					for (const part of m.contentParts) {
						if (part.type === 'text') {
							parts.push({ text: part.text });
						} else if (part.type === 'image') {
							// Gemini uses inline_data for images
							(parts as any[]).push({
								inline_data: {
									mime_type: part.mimeType,
									data: part.data,
								},
							});
						}
					}
					result.push({ role: 'user', parts });
				} else {
					result.push({ role: 'user', parts: [{ text: m.content }] });
				}
			} else if (m.role === 'assistant') {
				const parts: GeminiPart[] = [];

				// ReAct: reasoning → thinking block prepended before visible content
				if (m.reasoning) {
					parts.push({ text: `<thinking>\n${m.reasoning}\n</thinking>` });
				}
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
		separateSystemMessage?: AnthropicSystemParam;
		systemInstruction?: string;
	} {
		const toolFormat = capabilityConfig?.specialToolFormat;

		// 根据 specialToolFormat 决定格式
		if (toolFormat === 'anthropic-style') {
			const { messages: anthropicMsgs, systemPrompt } = this.toAnthropic(
				messages,
				{ systemPrompt: options.systemPrompt, tools: options.tools, isAnthropic: true },
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
			systemPrompt: options.systemPrompt,
			forkContext: options.forkContext,
		});
		return { messages: openaiMsgs };
	}

	/**
	 * 根据能力配置构建请求体的工具定义。
	 */
	static convertToolDefinitions(
		tools: IToolDefinition[],
		capabilityConfig?: IModelCapabilityConfig,
		forkContext?: IForkContext,
		isAnthropic?: boolean,
		systemPrompt?: string,
	): unknown {
		const toolFormat = capabilityConfig?.specialToolFormat;

		if (toolFormat === 'anthropic-style') {
			return this.toAnthropicToolDefinitions(tools, forkContext, isAnthropic, systemPrompt);
		}

		// Gemini 工具定义（functionDeclarations）和 OpenAI 格式不同，
		// 但由于目前 Gemini 通过 OpenAI 兼容 API 调用，暂时使用 OpenAI 格式
		// TODO: 当添加 GeminiModelProvider 原生支持时，实现 toGeminiToolDefinitions()

		// 默认：OpenAI 格式
		return this.toOpenAIToolDefinitions(tools, forkContext, isAnthropic, systemPrompt);
	}
}
