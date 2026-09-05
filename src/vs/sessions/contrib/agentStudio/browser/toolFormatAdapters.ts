/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool Format Adapters — 多 LLM Provider 工具格式适配层
 *
 * 参考 OpenClaw 的设计：
 *  - `convertResponsesTools()` (OpenAI Responses API)
 *  - `convertAnthropicTools()` (Anthropic API)
 *  - `normalizeToolParameterSchema()` (per-provider schema 兼容)
 *
 * 每种适配器负责：
 *  1. 将 IToolDefinition[] 转为对应 API 的 tools 参数格式
 *  2. 将 API 响应中的 tool_calls 解析为统一的 IToolCallInfo[]
 *  3. 将 IToolResult 格式化为对应 API 的 tool result 消息
 *  4. 处理 schema 兼容性（如 OpenAI strict 模式、Anthropic 不支持 $ref）
 */

import type { IToolDefinition, IToolCallInfo, IToolResult, IChatMessage } from '../common/providers.js';

// ─── Adapter Interface ──────────────────────────────────────────────

/**
 * 工具格式适配器接口 — 抽象不同 LLM API 的工具交互格式差异。
 */
export interface IToolFormatAdapter {
	/** 适配器标识（对应 provider type） */
	readonly providerId: string;

	/**
	 * 将内部 IToolDefinition[] 转为目标 API 的 tools 请求参数。
	 * 处理 schema 规范化（如 additionalProperties、$ref 展开等）。
	 */
	formatToolsForRequest(tools: IToolDefinition[]): unknown[];

	/**
	 * 从 API 流式 delta 中解析 tool call 信息。
	 * 返回 null 表示当前 delta 不含 tool call。
	 */
	parseToolCallDelta(delta: unknown): IToolCallDeltaParsed | null;

	/**
	 * 将 IToolResult 转为目标 API 的 tool result 消息格式。
	 */
	formatToolResultMessage(result: IToolResult): IChatMessage;

	/**
	 * 格式化包含 tool_calls 的 assistant 消息（不同 API 格式不同）。
	 */
	formatAssistantToolCallMessage(content: string, toolCalls: IToolCallInfo[]): unknown;

	/**
	 * 规范化单个 tool 的 inputSchema — 处理 provider 特定限制。
	 * 如 OpenAI strict 模式需要 additionalProperties: false。
	 */
	normalizeSchema(schema: Record<string, unknown>): Record<string, unknown>;
}

/**
 * 从流式 delta 中解析出的 tool call 信息
 */
export interface IToolCallDeltaParsed {
	/** 工具调用 ID */
	readonly id: string;
	/** 工具名称（仅首个 chunk 包含） */
	readonly name: string;
	/** 参数 JSON 片段（流式拼接） */
	readonly arguments: string;
	/** 是否是新的 tool call（而非续传参数） */
	readonly isNew: boolean;
}

// ─── OpenAI Adapter ─────────────────────────────────────────────────

/**
 * OpenAI Chat Completions API 工具格式适配器。
 * 支持 OpenAI、OpenRouter、DeepSeek、Ollama 等 OpenAI 兼容 API。
 */
export class OpenAIToolFormatAdapter implements IToolFormatAdapter {
	readonly providerId = 'openai';

	private readonly _strictMode: boolean;

	constructor(options?: { strictMode?: boolean }) {
		this._strictMode = options?.strictMode ?? false;
	}

	formatToolsForRequest(tools: IToolDefinition[]): unknown[] {
		return tools.map(t => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description,
				parameters: this.normalizeSchema(t.inputSchema),
				...(this._strictMode ? { strict: true } : {}),
			},
		}));
	}

	parseToolCallDelta(delta: unknown): IToolCallDeltaParsed | null {
		const d = delta as any;
		if (!d?.tool_calls || !Array.isArray(d.tool_calls)) { return null; }

		// OpenAI returns tool_calls as an array (usually single element in streaming)
		const tc = d.tool_calls[0];
		if (!tc) { return null; }

		const id = tc.id || '';
		const name = tc.function?.name || '';
		const args = tc.function?.arguments || '';

		if (!name && !args) { return null; }

		return {
			id,
			name,
			arguments: args,
			isNew: !!name, // If name is present, it's the start of a new tool call
		};
	}

	formatToolResultMessage(result: IToolResult): IChatMessage {
		const contentStr = result.content
			.map(c => c.text || (c.data ? `[${c.type}: ${c.mimeType}]` : ''))
			.join('\n');

		return {
			role: 'tool',
			content: result.error
				? JSON.stringify({ error: result.error, content: contentStr })
				: contentStr || JSON.stringify(result.content),
			toolCallId: result.toolCallId,
		};
	}

	formatAssistantToolCallMessage(content: string, toolCalls: IToolCallInfo[]): unknown {
		return {
			role: 'assistant',
			content: content || null,
			tool_calls: toolCalls.map(tc => ({
				id: tc.id,
				type: 'function',
				function: {
					name: tc.name,
					arguments: tc.arguments,
				},
			})),
		};
	}

	normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
		return this._normalize(schema, 0);
	}

	/**
	 * @param depth 0 = schema 根。嵌套层（depth ≥ 1）的 additionalProperties 在
	 * 非 strict 模式下会被剥离——多数 OpenAI 兼容网关（IOA 等）不接受 depth ≥ 1
	 * 的该字段，会在接收侧 sanitize 时剥掉并刷警告（[CodeBuddy][sanitize] …
	 * stripped at depth 2，实测 workflow 工具每请求都触发）。源头清掉语义不变
	 * （非 strict 下该字段本就无强制校验），消除每请求一次的重复清洗与日志噪音。
	 * 对齐 GeminiToolFormatAdapter 已有的 additionalProperties 删除策略。
	 */
	private _normalize(schema: Record<string, unknown>, depth: number): Record<string, unknown> {
		const normalized = { ...schema };

		if (this._strictMode) {
			// OpenAI strict mode 要求 additionalProperties: false（含嵌套 object）
			if (normalized['type'] === 'object' && !('additionalProperties' in normalized)) {
				normalized['additionalProperties'] = false;
			}
		} else if (depth > 0 && normalized['type'] === 'object' && 'additionalProperties' in normalized) {
			delete normalized['additionalProperties'];
		}

		// 递归处理嵌套 schema：properties 与 items（原实现漏了 items —— strict 模式下
		// 数组项里的 object 不会被补 additionalProperties: false，OpenAI strict 会拒绝；
		// workflow_apply 的 nodes.items 就是这种形态）。
		const properties = normalized['properties'] as Record<string, unknown> | undefined;
		if (properties) {
			const normalizedProps: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(properties)) {
				normalizedProps[key] = (typeof value === 'object' && value !== null)
					? this._normalize(value as Record<string, unknown>, depth + 1)
					: value;
			}
			normalized['properties'] = normalizedProps;
		}
		const items = normalized['items'] as Record<string, unknown> | undefined;
		if (items && typeof items === 'object' && !Array.isArray(items)) {
			normalized['items'] = this._normalize(items, depth + 1);
		}

		return normalized;
	}
}

// ─── Anthropic Adapter ──────────────────────────────────────────────

/**
 * Anthropic Messages API 工具格式适配器。
 * 处理 Anthropic 特有的 tool_use/tool_result 格式。
 */
export class AnthropicToolFormatAdapter implements IToolFormatAdapter {
	readonly providerId = 'anthropic';

	formatToolsForRequest(tools: IToolDefinition[]): unknown[] {
		return tools.map(t => ({
			name: t.name,
			description: t.description,
			input_schema: this.normalizeSchema(t.inputSchema),
		}));
	}

	parseToolCallDelta(delta: unknown): IToolCallDeltaParsed | null {
		const d = delta as any;

		// Anthropic content_block_start with type: tool_use
		if (d?.type === 'content_block_start' && d?.content_block?.type === 'tool_use') {
			return {
				id: d.content_block.id || '',
				name: d.content_block.name || '',
				arguments: '',
				isNew: true,
			};
		}

		// Anthropic content_block_delta with type: input_json_delta
		if (d?.type === 'content_block_delta' && d?.delta?.type === 'input_json_delta') {
			return {
				id: '', // ID was in the start block
				name: '',
				arguments: d.delta.partial_json || '',
				isNew: false,
			};
		}

		// Via OpenAI-compatible proxy (many Anthropic proxies reformat to OpenAI style)
		if (d?.tool_calls) {
			const tc = Array.isArray(d.tool_calls) ? d.tool_calls[0] : d.tool_calls;
			if (tc) {
				const name = tc.name || '';
				const id = tc.id || tc.tool_use_id || '';
				const rawArgs = tc.arguments ?? tc.input ?? tc.args;
				const args = typeof rawArgs === 'string' ? rawArgs
					: typeof rawArgs === 'object' ? JSON.stringify(rawArgs)
					: '';
				return { id, name, arguments: args, isNew: !!name };
			}
		}

		return null;
	}

	formatToolResultMessage(result: IToolResult): IChatMessage {
		// Anthropic uses role: 'user' with tool_result content blocks
		// But when going through an OpenAI-compatible proxy, we use 'tool' role
		const contentStr = result.content
			.map(c => c.text || '')
			.join('\n');

		return {
			role: 'tool',
			content: result.error
				? JSON.stringify({ error: result.error, is_error: true })
				: contentStr || JSON.stringify(result.content),
			toolCallId: result.toolCallId,
		};
	}

	formatAssistantToolCallMessage(content: string, toolCalls: IToolCallInfo[]): unknown {
		// For OpenAI-compatible proxies
		return {
			role: 'assistant',
			content: content || null,
			tool_calls: toolCalls.map(tc => ({
				id: tc.id,
				type: 'function',
				function: {
					name: tc.name,
					arguments: tc.arguments,
				},
			})),
		};
	}

	normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
		const normalized = { ...schema };

		// Anthropic 不支持 $ref 和 $defs — 需要内联展开
		if ('$ref' in normalized || '$defs' in normalized) {
			return this._inlineRefs(normalized);
		}

		// 递归处理嵌套 schema
		const properties = normalized['properties'] as Record<string, unknown> | undefined;
		if (properties) {
			const normalizedProps: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(properties)) {
				if (typeof value === 'object' && value !== null) {
					normalizedProps[key] = this.normalizeSchema(value as Record<string, unknown>);
				} else {
					normalizedProps[key] = value;
				}
			}
			normalized['properties'] = normalizedProps;
		}

		return normalized;
	}

	/**
	 * 内联展开 $ref 引用（简化版 — 只处理一层）
	 */
	private _inlineRefs(schema: Record<string, unknown>): Record<string, unknown> {
		const defs = (schema['$defs'] || schema['definitions']) as Record<string, unknown> | undefined;
		if (!defs) {
			// 无 definitions，移除 $ref 并返回 object type
			const { $ref, $defs, definitions, ...rest } = schema as any;
			return Object.keys(rest).length > 0 ? rest : { type: 'object' };
		}

		const result = { ...schema };
		delete result['$defs'];
		delete result['definitions'];

		// 简单替换顶层 $ref
		if (typeof result['$ref'] === 'string') {
			const refName = (result['$ref'] as string).replace('#/$defs/', '').replace('#/definitions/', '');
			if (defs[refName]) {
				return defs[refName] as Record<string, unknown>;
			}
		}

		return result;
	}
}

// ─── Google Gemini Adapter ──────────────────────────────────────────

/**
 * Google Gemini API 工具格式适配器。
 * 处理 Gemini 特有的 functionDeclarations 格式。
 */
export class GeminiToolFormatAdapter implements IToolFormatAdapter {
	readonly providerId = 'gemini';

	formatToolsForRequest(tools: IToolDefinition[]): unknown[] {
		// Gemini uses functionDeclarations in a tools array
		return [{
			function_declarations: tools.map(t => ({
				name: t.name,
				description: t.description,
				parameters: this.normalizeSchema(t.inputSchema),
			})),
		}];
	}

	parseToolCallDelta(delta: unknown): IToolCallDeltaParsed | null {
		const d = delta as any;

		// Gemini uses functionCall in candidates[].content.parts[]
		if (d?.functionCall) {
			return {
				id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: d.functionCall.name || '',
				arguments: d.functionCall.args ? JSON.stringify(d.functionCall.args) : '{}',
				isNew: true,
			};
		}

		return null;
	}

	formatToolResultMessage(result: IToolResult): IChatMessage {
		const contentStr = result.content
			.map(c => c.text || '')
			.join('\n');

		return {
			role: 'tool',
			content: JSON.stringify({
				functionResponse: {
					name: '', // Needs to be filled by caller
					response: result.error
						? { error: result.error }
						: { result: contentStr },
				},
			}),
			toolCallId: result.toolCallId,
		};
	}

	formatAssistantToolCallMessage(content: string, toolCalls: IToolCallInfo[]): unknown {
		return {
			role: 'assistant',
			content: content || null,
			tool_calls: toolCalls.map(tc => ({
				id: tc.id,
				type: 'function',
				function: {
					name: tc.name,
					arguments: tc.arguments,
				},
			})),
		};
	}

	normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
		const normalized = { ...schema };

		// Gemini 不支持 $ref、$defs、additionalProperties
		delete normalized['$ref'];
		delete normalized['$defs'];
		delete normalized['definitions'];
		delete normalized['additionalProperties'];

		// 递归处理
		const properties = normalized['properties'] as Record<string, unknown> | undefined;
		if (properties) {
			const normalizedProps: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(properties)) {
				if (typeof value === 'object' && value !== null) {
					normalizedProps[key] = this.normalizeSchema(value as Record<string, unknown>);
				} else {
					normalizedProps[key] = value;
				}
			}
			normalized['properties'] = normalizedProps;
		}

		return normalized;
	}
}

// ─── Adapter Registry ───────────────────────────────────────────────

/** 已注册的适配器集合 */
const _adapters = new Map<string, IToolFormatAdapter>();

/**
 * 注册一个工具格式适配器
 */
export function registerToolFormatAdapter(adapter: IToolFormatAdapter): void {
	_adapters.set(adapter.providerId, adapter);
}

/**
 * 获取指定 provider 的适配器（找不到则返回 OpenAI 兼容默认适配器）
 */
export function getToolFormatAdapter(providerId: string): IToolFormatAdapter {
	return _adapters.get(providerId) || _adapters.get('openai') || new OpenAIToolFormatAdapter();
}

/**
 * 根据 base URL 或模型名推断适配器类型
 */
export function inferToolFormatAdapter(baseUrl: string, modelId?: string): IToolFormatAdapter {
	const url = baseUrl.toLowerCase();
	const model = (modelId || '').toLowerCase();

	// Anthropic
	if (url.includes('anthropic') || model.startsWith('claude')) {
		return _adapters.get('anthropic') || new AnthropicToolFormatAdapter();
	}

	// Gemini
	if (url.includes('generativelanguage.googleapis.com') || model.startsWith('gemini')) {
		return _adapters.get('gemini') || new GeminiToolFormatAdapter();
	}

	// Default: OpenAI compatible
	return _adapters.get('openai') || new OpenAIToolFormatAdapter();
}

// 初始化默认适配器
registerToolFormatAdapter(new OpenAIToolFormatAdapter());
registerToolFormatAdapter(new AnthropicToolFormatAdapter());
registerToolFormatAdapter(new GeminiToolFormatAdapter());
