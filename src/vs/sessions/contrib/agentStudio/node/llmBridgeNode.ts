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
	log?.('info', `[vssaros-llm] httpRequest ${method} ${params.url}${params.insecure ? ' (insecure)' : ''}${params.binary ? ' (binary)' : ''}`);

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
		if (params.binary) {
			// 二进制路径：text() 会按 UTF-8 解码破坏字节 → arrayBuffer + base64。
			const buf = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
			return {
				ok: response.ok,
				status: response.status,
				statusText: response.statusText,
				body: '',
				base64: Buffer.from(buf).toString('base64'),
				contentType: response.headers.get('content-type') ?? '',
			};
		}
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
			if (params.binary) {
				// 二进制：Buffer 收集（不能 setEncoding，否则字节被 UTF-8 解码破坏）。
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
				res.on('end', () => {
					clearTimeout(timeoutId);
					resolve({
						ok: (res.statusCode ?? 0) < 400,
						status: res.statusCode ?? 0,
						statusText: res.statusMessage ?? '',
						body: '',
						base64: Buffer.concat(chunks).toString('base64'),
						contentType: (res.headers['content-type'] as string | undefined) ?? '',
					});
				});
				return;
			}
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
	const method = params.method || 'POST';
	log?.('info', `[vssaros-llm] generateImage → ${method} ${url}${body.__imageDataUrl ? ' (img2img multipart)' : ''}`);

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
		// ── img2img 分派（2026-09-03）：body.__imageDataUrl 存在 → multipart
		//    /images/edits（image 字段=参考图，其余字段转 form 字段）。node18+
		//    全局 FormData/Blob 可用；Content-Type 必须移除（fetch 自动补
		//    boundary，手动设会丢 boundary 导致服务端解析失败）。
		let requestInit: RequestInit;
		if (typeof body.__imageDataUrl === 'string' && body.__imageDataUrl) {
			const imgBuf = await _resolveImageBuffer(body.__imageDataUrl, log);
			if (!imgBuf) { throw new Error('img2img 参考图解析失败（仅支持 data: 或 http(s) 引用）'); }
			const fd = new FormData();
			// Buffer<ArrayBufferLike> 不能直接赋 BlobPart（tsgo 严格泛型）——与
			// messageClient 的 proxied blob 同款断言（运行时 Uint8Array 视图有效）。
			const imgPart = imgBuf as unknown as BlobPart;
			fd.append('image', new Blob([imgPart], { type: 'image/png' }), 'reference.png');
			for (const [k, v] of Object.entries(body)) {
				if (k === '__imageDataUrl' || v === undefined || v === null) { continue; }
				fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
			}
			const multipartHeaders: Record<string, string> = { ...(extraHeaders ?? {}) };
			if (apiKey) {
				if (apiKeyHeader === 'x-api-key') {
					multipartHeaders['x-api-key'] = apiKey;
					multipartHeaders['anthropic-version'] = '2023-06-01';
				} else {
					multipartHeaders['Authorization'] = `Bearer ${apiKey}`;
				}
			}
			requestInit = { method: 'POST', headers: multipartHeaders, body: fd, signal: controller.signal };
		} else {
			requestInit = {
				method,
				headers,
				body: method === 'GET' ? undefined : JSON.stringify(body),
				signal: controller.signal,
			};
		}
		const response = await fetch(url, requestInit);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			log?.('error', `[vssaros-llm] generateImage failed: ${method} ${url} → ${response.status} ${text}`);
			if (response.status === 405) {
				throw new Error(`图片生成接口返回 405（${method} ${url}）：${text.slice(0, 120) || 'Method Not Allowed'}。该路径仅接受其他方法。OpenAI 兼容代理通常在 /v1 前缀下暴露图片端点，请在 Provider 设置中将「文生图路径」改为 v1/images/generations，或确认代理实际支持的路径与方法。`);
			}
			throw new Error(`图片生成接口返回 ${response.status}（${method} ${url}）${text ? `：${text.slice(0, 200)}` : ''}`);
		}
		const data: any = await response.json();
		const rawImages: any[] = Array.isArray(data?.data) ? data.data : [];
		const images: Array<{ url?: string; b64?: string }> = [];
		for (const img of rawImages) {
			if (typeof img?.b64_json === 'string' && img.b64_json) {
				images.push({ b64: img.b64_json });
			} else if (typeof img?.url === 'string' && img.url) {
				// 远程 http(s) URL → 主进程下载转 base64，避免 renderer/webview
				// 直连被 CORS / CSP 拦（webview img-src 只放行 http://127.0.0.1/localhost，
				// 其它 http 会被拦截 → 图片不显示）。
				const b64 = /^https?:\/\//i.test(img.url)
					? await _downloadImageAsBase64(img.url, log)
					: undefined;
				if (b64) { images.push({ b64 }); }
				else { images.push({ url: img.url }); }
			}
		}
		return { images };
	} catch (err) {
		log?.('error', `[vssaros-llm] generateImage error: ${err}`);
		throw err;
	} finally {
		clearTimeout(timeoutId);
		if (signal && onOuterAbort) { signal.removeEventListener('abort', onOuterAbort); }
	}
}

/**
 * img2img 参考图解析：data: URL 解 base64；http(s) 下载转 Buffer。
 * 仅支持这两类引用——画布快照 ref（`uid:output:N`）必须由调用方先物化。
 * 失败返回 undefined（调用方抛出明确错误）。
 */
async function _resolveImageBuffer(ref: string, log?: LogFn): Promise<Buffer | undefined> {
	try {
		if (/^data:/i.test(ref)) {
			const comma = ref.indexOf(',');
			if (comma < 0) { return undefined; }
			return Buffer.from(ref.slice(comma + 1), 'base64');
		}
		if (/^https?:\/\//i.test(ref)) {
			const b64 = await _downloadImageAsBase64(ref, log);
			return b64 ? Buffer.from(b64, 'base64') : undefined;
		}
		log?.('warn', `[vssaros-llm] img2img: unsupported image ref (expect data:/http(s)): ${ref.slice(0, 60)}`);
		return undefined;
	} catch (err) {
		log?.('warn', `[vssaros-llm] img2img: resolve image buffer failed: ${err}`);
		return undefined;
	}
}

/** 下载远程图片并转 base64（主进程侧）。失败返回 undefined（调用方回退为原 url）。 */
async function _downloadImageAsBase64(url: string, log?: LogFn): Promise<string | undefined> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 30_000);
	try {
		const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
		if (!res.ok) { return undefined; }
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.byteLength === 0) { return undefined; }
		return buf.toString('base64');
	} catch (err) {
		log?.('warn', `[vssaros-llm] download image as base64 failed for ${url}: ${err}`);
		return undefined;
	} finally {
		clearTimeout(timeoutId);
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
