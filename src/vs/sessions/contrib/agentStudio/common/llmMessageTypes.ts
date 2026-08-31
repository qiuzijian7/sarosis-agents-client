/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ============================================================================
// LLM 原始消息格式（Provider-Specific Format）
// 参考 void 项目的 LLMChatMessage 设计
// ============================================================================

// ============================================================================
// Anthropic 格式
// ============================================================================

export type AnthropicLLMChatMessage =
	| {
		readonly role: 'assistant';
		readonly content: string | readonly AnthropicContentBlock[];
	}
	| {
		readonly role: 'user';
		readonly content: string | readonly AnthropicUserContentBlock[];
	};

export type AnthropicContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'tool_use'; readonly name: string; readonly input: Readonly<Record<string, unknown>>; readonly id: string }
	| { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
	| { readonly type: 'redacted_thinking'; readonly data: string };

export type AnthropicUserContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string };

/**
 * Anthropic `system` 顶层参数支持的形态。
 * - string：简写形态（无前缀缓存断点）
 * - AnthropicSystemBlock[]：可携带 `cache_control` 断点以命中 prompt cache
 *   （fork 前缀对齐时由 MessageFormatConverter.toAnthropic 构造）
 */
export type AnthropicSystemBlock = {
	readonly type: 'text';
	readonly text: string;
	readonly cache_control?: { readonly type: 'ephemeral' };
};

export type AnthropicSystemParam = string | readonly AnthropicSystemBlock[];

// ============================================================================
// OpenAI 格式
// ============================================================================

export type OpenAILLMChatMessage =
	| {
		readonly role: 'system' | 'user' | 'developer';
		readonly content: string;
	}
	| {
		readonly role: 'assistant';
		readonly content: string | readonly OpenAIContentBlock[];
		readonly tool_calls?: readonly OpenAIToolCall[];
	}
	| {
		readonly role: 'tool';
		readonly content: string;
		readonly tool_call_id: string;
	};

export type OpenAIContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'reasoning'; readonly reasoning: string };

export interface OpenAIToolCall {
	readonly type: 'function';
	readonly id: string;
	readonly function: {
		readonly name: string;
		readonly arguments: string; // JSON string
	};
}

// ============================================================================
// Gemini 格式
// ============================================================================

export type GeminiLLMChatMessage =
	| {
		readonly role: 'model';
		readonly parts: readonly GeminiPart[];
	}
	| {
		readonly role: 'user';
		readonly parts: readonly GeminiPart[];
	};

export type GeminiPart =
	| { readonly text: string }
	| { readonly functionCall: GeminiFunctionCall }
	| { readonly functionResponse: GeminiFunctionResponse };

export interface GeminiFunctionCall {
	readonly id: string;
	readonly name: string;
	readonly args: Readonly<Record<string, unknown>>;
}

export interface GeminiFunctionResponse {
	readonly id: string;
	readonly name: string;
	readonly response: {
		readonly output: string;
	};
}

// ============================================================================
// AG-UI 格式（Knot）
// ============================================================================

export type AGUIMessage =
	| {
		readonly role: 'assistant';
		readonly content: string;
		readonly tool_calls?: readonly AGUIToolCall[];
	}
	| {
		readonly role: 'tool';
		readonly content: string;
		readonly tool_call_id: string;
	};

export interface AGUIToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string; // JSON string
	readonly display_name?: string;
	readonly render_type?: string;
	readonly server_executed?: boolean;
}

// ============================================================================
// XML 格式（模型输出的文本格式）
// ============================================================================

/**
 * XML 格式工具调用（从模型输出的文本中提取）
 * 支持多种 XML 标签格式：
 * - <tool_call>name<script></script>  (Void/Agent-LLM format)
 * - <function_call>...</function_call>  (OpenClaw format)
 * - <tool_use>...</tool_use>  (Anthropic-like format)
 * - <invoke>...</invoke>  (Simple format)
 */
export interface XmlToolCall {
	/** XML 标签名 */
	readonly tag: string;
	/** 工具名称 */
	readonly name: string;
	/** 工具参数（JSON 字符串或 XML 文本） */
	readonly arguments: string;
	/** 原始 XML 文本 */
	readonly rawXml: string;
}

// ============================================================================
// 联合类型
// ============================================================================

export type LLMChatMessage =
	| AnthropicLLMChatMessage
	| OpenAILLMChatMessage
	| GeminiLLMChatMessage
	| AGUIMessage;
