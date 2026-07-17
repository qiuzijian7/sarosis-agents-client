/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelCapability, type IModelCapabilityConfig, type IModelDelta, type IModelInfo } from './providers.js';
import type { IBYOKProviderDefinition } from '../browser/builtInBYOKModelProvider.js';

/**
 * IPC channel name for routing LLM chat completions + model discovery to the
 * electron-main process (aligns with Void's `void-channel-llmMessage`).
 *
 * 设计意图：把"有副作用/需隔离"的 LLM 网络调用从 renderer 移到主进程，
 * 让 UI 渲染进程只做 agent loop 编排与流式展示，避免大响应流/网络抖动拖垮 UI。
 */
export const VSSAROS_LLM_CHANNEL = 'vssaros-llm';

/** 单次 chat 请求的流式参数（经 IPC 从 renderer 传到主进程）。 */
export interface ISarosisLlmChatRequest {
	readonly requestId: string;
	readonly url: string;
	readonly apiKey: string;
	readonly body: Record<string, unknown>;
	readonly extraHeaders?: Record<string, string>;
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFn = (level: LogLevel, msg: string, ...args: unknown[]) => void;

// ─── 重试配置 ────────────────────────────────────────────────────────────────

const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

// ─── 流式聊天（主进程侧执行）─────────────────────────────────────────────────

export interface IChatStreamParams {
	readonly url: string;
	readonly apiKey: string;
	readonly body: Record<string, unknown>;
	readonly extraHeaders?: Record<string, string>;
	readonly signal?: AbortSignal;
	readonly log?: LogFn;
	readonly onHealth?: (status: 'healthy' | 'degraded' | 'unhealthy') => void;
}

/**
 * 执行一次流式 chat completion：fetch + 指数退避重试 + SSE 解析。
 *
 * 忠实移植自 `browser/builtInBYOKModelProvider.ts` 的 `_streamChat` + `_sendRequestWithRetry`
 * + SSE 解析辅助方法，作为主进程侧的单一实现来源（renderer 的 `BuiltInBYOKModelProvider`
 * 保留为 web/remote 回退，二者逻辑须保持一致）。
 */
export async function* streamChatCompletions(params: IChatStreamParams): AsyncGenerator<IModelDelta> {
	const { url, apiKey, body, extraHeaders, signal } = params;
	const log = params.log ?? (() => { });
	const onHealth = params.onHealth ?? (() => { });

	let lastError = '';

	for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
		if (signal?.aborted) {
			yield { type: 'error', error: 'Aborted' };
			return;
		}

		let response: Response;
		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				...(extraHeaders ?? {}),
			};
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 300_000);
			let onOuterAbort: (() => void) | undefined;
			if (signal) {
				onOuterAbort = () => controller.abort();
				signal.addEventListener('abort', onOuterAbort, { once: true });
			}
			try {
				response = await fetch(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeoutId);
				if (signal && onOuterAbort) {
					signal.removeEventListener('abort', onOuterAbort);
				}
			}
		} catch (err) {
			log('error', `[vssaros-llm] fetch error: ${err}`);
			onHealth('unhealthy');
			if (attempt < DEFAULT_MAX_RETRIES) {
				const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
				log('info', `[vssaros-llm] network error, retrying in ${delayMs}ms...`);
				yield* _delay(delayMs);
				continue;
			}
			yield { type: 'error', error: `Network error — ${err}` };
			return;
		}

		if (response.ok) {
			onHealth('healthy');
			const reader = response.body?.getReader();
			if (!reader) {
				yield { type: 'error', error: 'No response body' };
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';
			let sseDataFound = false;
			let fullBodyForFallback = '';
			let capturedResponseId: string | undefined;
			let capturedFinishReason: string | undefined;

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) { break; }
					const chunk = decoder.decode(value, { stream: true });
					buffer += chunk;
					fullBodyForFallback += chunk;

					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) { continue; }
						const jsonPayload = _extractJsonPayload(trimmed);
						if (jsonPayload === null) { continue; }
						if (jsonPayload === '[DONE]') {
							sseDataFound = true;
							continue;
						}
						try {
							const parsed = JSON.parse(jsonPayload);
							sseDataFound = true;
							if (typeof parsed.id === 'string' && parsed.id) {
								capturedResponseId = parsed.id;
							}
							const usageDelta = _extractUsage(parsed);
							if (usageDelta) { yield usageDelta; }
							const content = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
							if (!content) {
								const finishReason = parsed.choices?.[0]?.finish_reason;
								if (finishReason) { capturedFinishReason = finishReason; }
								continue;
							}
							for (const d of _parseContentFromJson(content)) {
								yield d;
							}
						} catch {
							log('warn', `[vssaros-llm] malformed JSON line: ${jsonPayload.slice(0, 200)}`);
						}
					}
				}

				const remainingDeltas = _processRemainingBuffer(buffer);
				if (remainingDeltas.length > 0) { sseDataFound = true; }
				for (const d of remainingDeltas) { yield d; }

				if (!sseDataFound && fullBodyForFallback.trim()) {
					log('info', `[vssaros-llm] no streaming data found, trying full JSON fallback`);
					for (const d of _parseFullJsonFallback(fullBodyForFallback)) {
						yield d;
					}
				}
			} catch (streamErr) {
				log('error', `[vssaros-llm] stream read error: ${streamErr}`);
				onHealth('degraded');
				yield { type: 'error', error: `Stream error — ${streamErr}` };
				return;
			}

			const doneDeltaBase: IModelDelta = capturedResponseId
				? { type: 'done', responseId: capturedResponseId }
				: { type: 'done' };
			const doneDelta: IModelDelta = capturedFinishReason
				? { ...doneDeltaBase, finishReason: capturedFinishReason }
				: doneDeltaBase;
			yield doneDelta;
			return;
		}

		if (!RETRIABLE_STATUS_CODES.has(response.status)) {
			const text = await response.text().catch(() => '');
			log('error', `[vssaros-llm] HTTP error (non-retriable): ${response.status} — ${text.slice(0, 500)}`);
			onHealth('unhealthy');
			yield { type: 'error', error: `${response.status} ${response.statusText} — ${text.slice(0, 500)}` };
			return;
		}

		const text = await response.text().catch(() => '');
		lastError = `${response.status} ${response.statusText} — ${text.slice(0, 500)}`;
		log('warn', `[vssaros-llm] HTTP error (retriable): ${lastError}`);
		if (attempt < DEFAULT_MAX_RETRIES) {
			let delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
			const retryAfter = response.headers.get('Retry-After');
			if (retryAfter) {
				const parsed = parseInt(retryAfter, 10);
				if (!isNaN(parsed) && parsed > 0) { delayMs = parsed * 1000; }
			}
			onHealth('degraded');
			yield* _delay(delayMs);
		}
	}

	onHealth('unhealthy');
	log('error', `[vssaros-llm] all retries exhausted, last error: ${lastError}`);
	yield { type: 'error', error: lastError };
}

// ─── 模型发现（主进程侧执行）─────────────────────────────────────────────────

/**
 * 发现模型列表（忠实移植自 `BuiltInBYOKModelProvider._fetchModels` 的网络部分）。
 * 在主进程侧执行以把网络调用移出 renderer。
 */
export async function discoverModels(
	baseUrl: string,
	apiKey: string,
	definition: IBYOKProviderDefinition,
	log?: LogFn,
): Promise<IModelInfo[]> {
	if (!baseUrl) { return definition.staticModels ?? []; }
	if (!definition.apiKeyOptional && !apiKey) { return definition.staticModels ?? []; }

	if (definition.staticModels && !definition.modelsEndpointPath) {
		return [...definition.staticModels];
	}

	const modelsUrl = definition.modelsEndpointPath
		? `${baseUrl.replace(/\/+$/, '')}/${definition.modelsEndpointPath.replace(/^\/+/, '')}`
		: `${baseUrl.replace(/\/+$/, '')}/models`;

	try {
		log?.('info', `[vssaros-llm] discovering models from ${modelsUrl}`);
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (apiKey) { headers['Authorization'] = `Bearer ${apiKey}`; }
		const response = await fetch(modelsUrl, {
			method: 'GET',
			headers,
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			log?.('warn', `[vssaros-llm] models endpoint returned ${response.status}`);
			return definition.staticModels ?? [];
		}
		const data: any = await response.json();
		const rawModels: any[] = data.data || data.models || [];
		return rawModels
			.filter((m: any) => m.id || m.name)
			.slice(0, 200)
			.map((m: any) => ({
				id: m.id || m.name,
				name: m.name || m.id,
				description: m.description || undefined,
				contextWindow: m.context_length || m.context_window || undefined,
				maxInputTokens: m.maxInputTokens || m.max_input_tokens || m.context_length || undefined,
				capabilities: _inferCapabilities(m),
				supportsToolCall: m.supportsToolCall ?? (m.capabilityConfig?.specialToolFormat !== undefined),
				supportsReasoning: m.supportsReasoning ?? (m.capabilityConfig?.reasoningType ? true : undefined),
				capabilityConfig: m.capabilityConfig || undefined,
				pricing: m.pricing ? {
					inputPerMillion: typeof m.pricing.prompt === 'string' ? parseFloat(m.pricing.prompt) * 1_000_000 : m.pricing.input_per_million,
					outputPerMillion: typeof m.pricing.completion === 'string' ? parseFloat(m.pricing.completion) * 1_000_000 : m.pricing.output_per_million,
				} : undefined,
			}));
	} catch (err) {
		log?.('warn', `[vssaros-llm] failed to fetch models: ${err}`);
		return definition.staticModels ?? [];
	}
}

// ─── SSE 解析辅助（与 BuiltInBYOKModelProvider 一致）─────────────────────────

function _delay(ms: number): AsyncGenerator<IModelDelta, void, unknown> {
	return (async function* () {
		await new Promise(resolve => setTimeout(resolve, ms));
	})();
}

function _extractJsonPayload(trimmed: string): string | null {
	if (trimmed.startsWith('data:')) {
		const payload = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
		return payload === '[DONE]' ? '[DONE]' : payload;
	}
	if (trimmed.startsWith('{')) { return trimmed; }
	return null;
}

function _extractUsage(parsed: any): IModelDelta | null {
	if (!parsed.usage) { return null; }
	const u = parsed.usage;
	const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? undefined;
	const cacheWriteTokens = u.cache_creation_input_tokens ?? undefined;
	const inputTokens = u.prompt_tokens ?? u.input_tokens ?? undefined;
	const outputTokens = u.completion_tokens ?? u.output_tokens ?? undefined;
	if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined || cacheWriteTokens !== undefined) {
		return { type: 'usage', usage: { inputTokens, outputTokens, cachedTokens, cacheWriteTokens } };
	}
	return null;
}

function _parseContentFromJson(content: any): IModelDelta[] {
	const deltas: IModelDelta[] = [];
	let reasoningContent = content.reasoning_content ?? content.thinking ?? content.reasoning;
	let actualContent = content.content;
	if (actualContent && typeof actualContent === 'string') {
		const thinkMatch = /<(think|thinking)>([\s\S]*?)<\/\1>/i.exec(actualContent);
		if (thinkMatch) {
			reasoningContent = reasoningContent || thinkMatch[2].trim();
			actualContent = actualContent.replace(thinkMatch[0], '').trim();
		}
	}
	if (reasoningContent) { deltas.push({ type: 'thinking', content: reasoningContent }); }
	if (actualContent) { deltas.push({ type: 'text', content: actualContent }); }
	if (content.tool_calls) {
		for (const tc of content.tool_calls) {
			const parsed = _parseToolCall(tc);
			if (parsed) { deltas.push({ type: 'tool_call', toolCall: parsed }); }
		}
	}
	return deltas;
}

function _parseToolCall(tc: any): { id: string; name: string; arguments: string } | null {
	let toolId = tc.id || '';
	let toolName = '';
	let toolArgs = '';
	if (tc.function) {
		toolName = tc.function.name || '';
		toolArgs = tc.function.arguments || '';
	} else if (tc.name) {
		toolName = tc.name;
		const rawArgs = tc.arguments ?? tc.input ?? tc.args;
		toolArgs = typeof rawArgs === 'string' ? rawArgs
			: typeof rawArgs === 'object' ? JSON.stringify(rawArgs)
				: '';
		if (!toolId) { toolId = tc.tool_use_id || tc.toolUseId || ''; }
	}
	return (toolName || toolArgs) ? { id: toolId, name: toolName, arguments: toolArgs } : null;
}

function _processRemainingBuffer(buffer: string): IModelDelta[] {
	const deltas: IModelDelta[] = [];
	const trimmed = buffer.trim();
	if (!trimmed) { return deltas; }
	const jsonPayload = _extractJsonPayload(trimmed);
	if (!jsonPayload || jsonPayload === '[DONE]') { return deltas; }
	try {
		const parsed = JSON.parse(jsonPayload);
		const content = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
		if (content) { deltas.push(..._parseContentFromJson(content)); }
		const usageDelta = _extractUsage(parsed);
		if (usageDelta) { deltas.push(usageDelta); }
	} catch {
		// ignore trailing partial
	}
	return deltas;
}

function _parseFullJsonFallback(fullBody: string): IModelDelta[] {
	const deltas: IModelDelta[] = [];
	try {
		const parsed = JSON.parse(fullBody);
		const usageDelta = _extractUsage(parsed);
		if (usageDelta) { deltas.push(usageDelta); }
		const message = parsed.choices?.[0]?.message;
		if (message) { deltas.push(..._parseContentFromJson(message)); }
	} catch (parseErr) {
		const rawTrimmed = fullBody.trim();
		if (rawTrimmed.length > 0 && rawTrimmed.length < 100000 && !rawTrimmed.startsWith('<')) {
			deltas.push({ type: 'text', content: rawTrimmed });
		}
	}
	return deltas;
}

function _inferCapabilities(m: any): ModelCapability[] {
	const caps: ModelCapability[] = [ModelCapability.Chat];
	const id = (m.id || '').toLowerCase();
	const desc = (m.description || '').toLowerCase();
	const config: IModelCapabilityConfig | undefined = m.capabilityConfig;
	if (config?.specialToolFormat) {
		caps.push(ModelCapability.FunctionCalling);
	} else {
		const supportedParams = m.supported_parameters || [];
		if (Array.isArray(supportedParams) && supportedParams.includes('tools')) {
			caps.push(ModelCapability.FunctionCalling);
		}
	}
	if (id.includes('vision') || desc.includes('vision') || desc.includes('image')) { caps.push(ModelCapability.Vision); }
	if (id.includes('code') || desc.includes('code') || desc.includes('coding')) { caps.push(ModelCapability.Code); }
	return caps;
}
