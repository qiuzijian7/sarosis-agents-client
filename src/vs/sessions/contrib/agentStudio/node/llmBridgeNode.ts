/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LLM bridge —— **主进程侧实现**（网络 I/O + Node 依赖）。
 *
 * ## 为什么独立成 node/ 层（2026-08-21 拆分）
 *
 * 原先这些实现与常量/类型/纯函数同住 `common/llmBridge.ts`。`common/` 会被
 * renderer 引用（`providerView` / `providerSettingsRenderer` / `modelsDevCatalog`
 * / `mainProcessModelProvider` / `builtInBYOKModelProvider` / `agentStudio.contribution`
 * 共 6 处，只取 `VSSAROS_LLM_CHANNEL` 常量、类型与纯函数），而 renderer 是
 * Chromium 沙箱、**无 Node**。
 *
 * 于是为支持 `insecure`（忽略 TLS 证书）加的 `import * as nodeHttps from 'https'`
 * 直接炸掉整个 sessions workbench 启动：
 *   `TypeError: Failed to resolve module specifier "https"` @ sessions.ts:136 load
 * —— 静态 import 在**模块加载时**解析，一个 renderer 引用就全局崩溃。
 *
 * 拆分后职责边界清晰，同类事故不会再发生：
 *   - `common/llmBridge.ts` → 常量 / 类型 / 纯函数，renderer 与主进程共享，
 *     **禁止**任何 Node 依赖（静态或动态）。
 *   - `node/llmBridgeNode.ts`（本文件）→ 网络实现，只被
 *     `electron-main/llmMainChannel.ts` 引用，可自由使用 Node 能力。
 *
 * 调用链：renderer → IPC `VSSAROS_LLM_CHANNEL` → `electron-main/llmMainChannel.ts`
 *        → 本文件。
 */

import { ModelCapability, type IModelCapabilityConfig, type IModelDelta, type IModelInfo } from '../common/providers.js';
import type { IBYOKProviderDefinition } from '../browser/builtInBYOKModelProvider.js';
import {
	AnthropicStreamState,
	inferImageGen,
	type IChatStreamParams,
	type IHttpRequestParams,
	type IHttpRequestResult,
	type IImageGenBridgeParams,
	type LogFn,
} from '../common/llmBridge.js';

// ─── 重试配置 ────────────────────────────────────────────────────────────────

const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

const DEFAULT_MAX_RETRIES = 3;

const BASE_RETRY_DELAY_MS = 1000;

/**
 * 执行一次流式 chat completion：fetch + 指数退避重试 + SSE 解析。
 *
 * 忠实移植自 `browser/builtInBYOKModelProvider.ts` 的 `_streamChat` + `_sendRequestWithRetry`
 * + SSE 解析辅助方法，作为主进程侧的单一实现来源（renderer 的 `BuiltInBYOKModelProvider`
 * 保留为 web/remote 回退，二者逻辑须保持一致）。
 */
export async function* streamChatCompletions(params: IChatStreamParams): AsyncGenerator<IModelDelta> {
	const { url, apiKey, body, extraHeaders, signal } = params;
	const responseFormat = params.responseFormat ?? 'openai';
	const apiKeyHeader = params.apiKeyHeader ?? 'bearer';
	const anthropicVersion = params.anthropicVersion ?? '2023-06-01';
	const log = params.log ?? (() => { });
	const onHealth = params.onHealth ?? (() => { });

	// 原生 Anthropic SSE 解析状态（仅 responseFormat==='anthropic' 时使用）
	const isAnthropicStream = responseFormat === 'anthropic';
	const anthropicState = isAnthropicStream ? new AnthropicStreamState() : undefined;

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
				if (apiKeyHeader === 'x-api-key') {
					headers['x-api-key'] = apiKey;
					headers['anthropic-version'] = anthropicVersion;
				} else {
					headers['Authorization'] = `Bearer ${apiKey}`;
				}
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

							// 原生 Anthropic SSE：走专用解析器
							if (isAnthropicStream && anthropicState) {
								for (const d of anthropicState.push(parsed)) {
									yield d;
								}
								continue;
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

			const remainingDeltas = _processRemainingBuffer(buffer, anthropicState);
			if (remainingDeltas.length > 0) { sseDataFound = true; }
			for (const d of remainingDeltas) { yield d; }

			if (!sseDataFound && fullBodyForFallback.trim()) {
				log('info', `[vssaros-llm] no streaming data found, trying full JSON fallback`);
				for (const d of _parseFullJsonFallback(fullBodyForFallback, anthropicState)) {
					yield d;
				}
			}
		} catch (streamErr) {
			log('error', `[vssaros-llm] stream read error: ${streamErr}`);
			onHealth('degraded');
			yield { type: 'error', error: `Stream error — ${streamErr}` };
			return;
		}

		// 原生 Anthropic：工具块已在 content_block_stop / finish() 中 flush，
		// 这里统一产出收尾 done（携带 responseId / stop_reason）。
		if (isAnthropicStream && anthropicState) {
			for (const d of anthropicState.finish()) {
				yield d;
			}
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
		if (apiKey) {
			if (definition.apiKeyHeader === 'x-api-key') {
				headers['x-api-key'] = apiKey;
				headers['anthropic-version'] = definition.anthropicVersion || '2023-06-01';
			} else {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}
		}
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
				supportsImageGen: m.supportsImageGen ?? inferImageGen(m),
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

/**
 * 在主进程执行一次性 HTTP 请求，返回状态码 + 文本 body。
 * 网络层失败（DNS/连接拒绝/超时）直接 throw，由 IPC call 侧 reject。
 */
export async function httpRequest(params: IHttpRequestParams, log?: LogFn): Promise<IHttpRequestResult> {
	const method = params.method ?? 'GET';
	const timeoutMs = params.timeoutMs ?? 15000;
	log?.('info', `[vssaros-llm] httpRequest ${method} ${params.url}${params.insecure ? ' (insecure)' : ''}`);

	// 忽略 TLS 证书错误场景（公司代理 MITM）走 Node https 模块，绕过 fetch/undici 的证书校验。
	if (params.insecure) {
		return insecureHttpRequest(params, timeoutMs, log);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(params.url, {
			method,
			headers: params.headers ?? {},
			signal: controller.signal,
		});
		const body = await response.text().catch(() => '');
		return { ok: response.ok, status: response.status, statusText: response.statusText, body };
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * 忽略 TLS 证书错误的一次性请求（Node https/http 模块，rejectUnauthorized=false）。
 *
 * ## 为什么用动态 import（务必不要改回静态）
 *
 * 本文件在 `common/` 层，被 **renderer 侧 6 处**引用（`providerView` /
 * `providerSettingsRenderer` / `modelsDevCatalog` / `mainProcessModelProvider` /
 * `builtInBYOKModelProvider` / `agentStudio.contribution`），它们只取
 * `VSSAROS_LLM_CHANNEL` 常量、类型和纯函数（`inferImageGen` / `AnthropicStreamState`）。
 *
 * renderer 是 Chromium 沙箱、**无 Node**（`windows.ts` 设 `sandbox: true`，
 * `globalThis.require` 已被 amdX 换成 AMD shim，连内置模块都解析不了）。
 * 静态 `import * as nodeHttps from 'https'` 会在**模块加载时**立即解析，抛
 *   `TypeError: Failed to resolve module specifier "https"`
 * 并直接炸掉整个 sessions workbench 启动（`sessions.ts:136 load` uncaught）。
 *
 * 动态 import 只在本函数**真正被调用时**解析，而它只可能在主进程执行：
 * renderer → IPC `VSSAROS_LLM_CHANNEL` → `electron-main/llmMainChannel.ts`
 * → `httpRequest({ insecure: true })` → 这里。主进程是 ESM + 有 Node，
 * `import('https')` 是标准可用写法。
 *
 * 同理 `URL` 用全局标准 API，不 import 'url'。
 */
async function insecureHttpRequest(params: IHttpRequestParams, timeoutMs: number, log?: LogFn): Promise<IHttpRequestResult> {
	const [nodeHttps, nodeHttp] = await Promise.all([import('https'), import('http')]);
	return new Promise<IHttpRequestResult>((resolve, reject) => {
		let target: URL;
		try {
			target = new URL(params.url);
		} catch (err) {
			reject(err);
			return;
		}
		const lib = target.protocol === 'https:' ? nodeHttps : nodeHttp;
		const timeoutId = setTimeout(() => {
			req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
		}, timeoutMs);
		const req = lib.request(target, {
			method: params.method ?? 'GET',
			headers: params.headers ?? {},
			rejectUnauthorized: false,
		}, (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				clearTimeout(timeoutId);
				resolve({
					ok: (res.statusCode ?? 0) < 400,
					status: res.statusCode ?? 0,
					statusText: res.statusMessage ?? '',
					body: data,
				});
			});
		});
		req.on('error', (err) => {
			clearTimeout(timeoutId);
			log?.('warn', `[vssaros-llm] insecureHttpRequest error: ${err}`);
			reject(err);
		});
		req.end();
	});
}

/**
 * 调用 OpenAI 兼容 `/images/generations` 端点生成图片，返回 `{ images: [{ url } | { b64 }] }`。
 * 在主进程侧执行以把网络调用移出 renderer（与 streamChatCompletions 同模式）。
 */
export async function generateImage(params: IImageGenBridgeParams): Promise<{ images: Array<{ url?: string; b64?: string }> }> {
	const { url, apiKey, body, extraHeaders, signal, log } = params;
	const apiKeyHeader = params.apiKeyHeader ?? 'bearer';
	log?.('info', `[vssaros-llm] generateImage → ${url}`);

	const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
	if (apiKey) {
		if (apiKeyHeader === 'x-api-key') {
			headers['x-api-key'] = apiKey;
			headers['anthropic-version'] = '2023-06-01';
		} else {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 120_000);
	let onOuterAbort: (() => void) | undefined;
	if (signal) {
		onOuterAbort = () => controller.abort();
		signal.addEventListener('abort', onOuterAbort, { once: true });
	}
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			log?.('error', `[vssaros-llm] generateImage failed: ${response.status} ${text}`);
			throw new Error(`图片生成接口返回 ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`);
		}
		const data: any = await response.json();
		const rawImages: any[] = Array.isArray(data?.data) ? data.data : [];
		return {
			images: rawImages.map((img: any) => {
				if (typeof img?.url === 'string' && img.url) { return { url: img.url }; }
				if (typeof img?.b64_json === 'string' && img.b64_json) { return { b64: img.b64_json }; }
				return {};
			}).filter(img => img.url || img.b64),
		};
	} catch (err) {
		log?.('error', `[vssaros-llm] generateImage error: ${err}`);
		throw err;
	} finally {
		clearTimeout(timeoutId);
		if (signal && onOuterAbort) { signal.removeEventListener('abort', onOuterAbort); }
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
	// Reasoning tokens：OpenAI/OpenRouter 在 completion_tokens_details.reasoning_tokens，
	// 部分网关直接给 reasoning_tokens（对齐子代理 subagentTokenCollector 口径）。
	const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? undefined;
	if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined || cacheWriteTokens !== undefined || reasoning !== undefined) {
		return { type: 'usage', usage: { inputTokens, outputTokens, cachedTokens, cacheWriteTokens, reasoning } };
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

function _processRemainingBuffer(buffer: string, anthropicState?: AnthropicStreamState): IModelDelta[] {
	const deltas: IModelDelta[] = [];
	const trimmed = buffer.trim();
	if (!trimmed) { return deltas; }
	const jsonPayload = _extractJsonPayload(trimmed);
	if (!jsonPayload || jsonPayload === '[DONE]') { return deltas; }
	try {
		const parsed = JSON.parse(jsonPayload);
		if (anthropicState) {
			deltas.push(...anthropicState.push(parsed));
			return deltas;
		}
		const content = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
		if (content) { deltas.push(..._parseContentFromJson(content)); }
		const usageDelta = _extractUsage(parsed);
		if (usageDelta) { deltas.push(usageDelta); }
	} catch {
		// ignore trailing partial
	}
	return deltas;
}

function _parseFullJsonFallback(fullBody: string, anthropicState?: AnthropicStreamState): IModelDelta[] {
	const deltas: IModelDelta[] = [];
	try {
		const parsed = JSON.parse(fullBody);
		if (anthropicState) {
			deltas.push(...anthropicState.push(parsed));
			return deltas;
		}
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
