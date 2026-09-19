/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * SSE / NDJSON 解析纯函数 —— renderer 与 Electron 主进程共享的单一实现来源。
 *
 * 背景（重构于 P0-1）：这些函数此前在
 *   - `browser/builtInBYOKModelProvider.ts`（私有方法）
 *   - `node/llmBridgeNode.ts`（模块级函数）
 * 各实现一份，逐字重复，且靠注释「逻辑须保持一致」手工同步。
 * 现提取到 common/，两处 import 同一实现，重复消除。
 *
 * 全部为纯函数（无 IO、无 this），输入 any（网络 JSON 不可信）→ 输出 IModelDelta[]。
 */

import type { IModelDelta } from '../providers.js';
import type { AnthropicStreamState } from '../llmBridge.js';

/** 解析单行 SSE/NDJSON → JSON 字符串；非数据行返回 null。 */
export function extractJsonPayload(trimmed: string): string | null {
	if (trimmed.startsWith('data:')) {
		const payload = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
		return payload === '[DONE]' ? '[DONE]' : payload;
	}
	if (trimmed.startsWith('{')) {
		return trimmed;
	}
	return null;
}

/**
 * 从已解析的 chunk 中提取 token 用量。
 *
 * 兼容多厂商字段：OpenAI(`prompt_tokens`/`completion_tokens`)、
 * Anthropic(`input_tokens`/`output_tokens`)、缓存(`cached_tokens`/
 * `cache_read_input_tokens`/`cache_creation_input_tokens`)、
 * reasoning(`completion_tokens_details.reasoning_tokens`/`reasoning_tokens`)。
 *
 * @param onCacheHit 缓存命中时的日志回调（原 renderer 版特有，现注入以保留行为）
 */
export function extractUsage(parsed: any, onCacheHit?: (cachedTokens: number, inputTokens: number | undefined) => void): IModelDelta | null {
	if (!parsed.usage) {
		return null;
	}
	const usage = parsed.usage;
	const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? undefined;
	const cacheWriteTokens = usage.cache_creation_input_tokens ?? undefined;
	const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? undefined;
	const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? undefined;
	// Reasoning tokens：OpenAI/OpenRouter 于 completion_tokens_details.reasoning_tokens，
	// 部分网关直接给 reasoning_tokens（对齐子代理 subagentTokenCollector 口径）。
	const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? undefined;

	if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined || cacheWriteTokens !== undefined || reasoning !== undefined) {
		if (cachedTokens !== undefined && onCacheHit) {
			onCacheHit(cachedTokens, inputTokens);
		}
		return { type: 'usage', usage: { inputTokens, outputTokens, cachedTokens, cacheWriteTokens, reasoning } };
	}
	return null;
}

/** 从 delta/message 内容对象中解析 text / thinking / tool_calls。 */
export function parseContentFromJson(content: any): IModelDelta[] {
	const deltas: IModelDelta[] = [];

	// reasoning/thinking 内容
	let reasoningContent = content.reasoning_content ?? content.thinking ?? content.reasoning;
	let actualContent = content.content;

	// 解析 <think|thinking> 标签（DeepSeek/QwQ/qwen 经 Ollama 风格）
	if (actualContent && typeof actualContent === 'string') {
		const thinkMatch = /<(think|thinking)>([\s\S]*?)<\/\1>/i.exec(actualContent);
		if (thinkMatch) {
			reasoningContent = reasoningContent || thinkMatch[2].trim();
			actualContent = actualContent.replace(thinkMatch[0], '').trim();
		}
	}

	if (reasoningContent) {
		deltas.push({ type: 'thinking', content: reasoningContent });
	}
	if (actualContent) {
		deltas.push({ type: 'text', content: actualContent });
	}

	// 工具调用 —— 兼容三种格式：
	// 1. OpenAI 标准：tool_calls[].function.{name, arguments}
	// 2. Anthropic 经代理：tool_calls[].{name, input/arguments}
	// 3. 部分代理：tool_calls[].{id, name, arguments}（扁平）
	if (content.tool_calls) {
		for (const toolCall of content.tool_calls) {
			const parsed = parseToolCall(toolCall);
			if (parsed) {
				deltas.push({ type: 'tool_call', toolCall: parsed });
			}
		}
	}
	return deltas;
}

/** 归一化三种工具调用形状为 { id, name, arguments }。 */
export function parseToolCall(toolCall: any): { id: string; name: string; arguments: string } | null {
	let toolId = toolCall.id || '';
	let toolName = '';
	let toolArgs = '';

	if (toolCall.function) {
		// 格式 1：OpenAI 标准
		toolName = toolCall.function.name || '';
		toolArgs = toolCall.function.arguments || '';
	} else if (toolCall.name) {
		// 格式 2/3：Anthropic 经代理 / 扁平
		toolName = toolCall.name;
		const rawArgs = toolCall.arguments ?? toolCall.input ?? toolCall.args;
		if (typeof rawArgs === 'string') {
			toolArgs = rawArgs;
		} else if (typeof rawArgs === 'object') {
			toolArgs = JSON.stringify(rawArgs);
		} else {
			toolArgs = '';
		}
		if (!toolId) {
			toolId = toolCall.tool_use_id || toolCall.toolUseId || '';
		}
	}

	return (toolName || toolArgs) ? { id: toolId, name: toolName, arguments: toolArgs } : null;
}

/**
 * 处理流结束后 buffer 中残留的最后一个（未以换行结尾的）数据块。
 *
 * @param onCacheHit 缓存命中回调，透传给 usage 解析（渲染进程侧用于打 KV-cache 日志）。
 */
export function processRemainingBuffer(
	buffer: string,
	anthropicState?: AnthropicStreamState,
	onCacheHit?: (cachedTokens: number, inputTokens: number | undefined) => void,
): IModelDelta[] {
	const deltas: IModelDelta[] = [];
	const trimmed = buffer.trim();
	if (!trimmed) {
		return deltas;
	}
	const jsonPayload = extractJsonPayload(trimmed);
	if (!jsonPayload || jsonPayload === '[DONE]') {
		return deltas;
	}
	try {
		const parsed = JSON.parse(jsonPayload);
		if (anthropicState) {
			deltas.push(...anthropicState.push(parsed));
			return deltas;
		}
		const content = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
		if (content) {
			deltas.push(...parseContentFromJson(content));
		}
		const usageDelta = extractUsage(parsed, onCacheHit);
		if (usageDelta) {
			deltas.push(usageDelta);
		}
	} catch {
		// 忽略不完整的尾部数据
	}
	return deltas;
}

/**
 * 整段响应体（非流式）兜底解析，用于对端返回单个 JSON 而非 SSE 流的情况。
 *
 * @param onCacheHit 缓存命中回调，透传给 usage 解析。
 * @param onParseError 解析失败时的诊断回调（渲染进程侧据此记录网关返回了什么）。
 */
export function parseFullJsonFallback(
	fullBody: string,
	anthropicState?: AnthropicStreamState,
	onCacheHit?: (cachedTokens: number, inputTokens: number | undefined) => void,
	onParseError?: (err: unknown) => void,
): IModelDelta[] {
	const deltas: IModelDelta[] = [];
	try {
		const parsed = JSON.parse(fullBody);
		if (anthropicState) {
			deltas.push(...anthropicState.push(parsed));
			return deltas;
		}
		const usageDelta = extractUsage(parsed, onCacheHit);
		if (usageDelta) {
			deltas.push(usageDelta);
		}
		const message = parsed.choices?.[0]?.message;
		if (message) {
			deltas.push(...parseContentFromJson(message));
		}
	} catch (parseErr) {
		onParseError?.(parseErr);
		// 无法解析为 JSON —— 兜底为纯文本（排除 HTML 错误页与超大响应体）
		const rawTrimmed = fullBody.trim();
		if (rawTrimmed.length > 0 && rawTrimmed.length < 100000 && !rawTrimmed.startsWith('<')) {
			deltas.push({ type: 'text', content: rawTrimmed });
		}
	}
	return deltas;
}
