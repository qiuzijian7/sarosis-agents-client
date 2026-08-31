/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import {
	IModelProvider, IModelInfo, ModelAuthStatus,
	IModelOptions, IModelDelta, IChatMessage, IChatContext,
	ModelCapability, IModelCapabilityConfig,
	IImageGenParams, IImageGenResult,
} from '../common/providers.js';
import { MessageFormatConverter } from '../common/adapters/messageFormatConverter.js';
import { AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING } from '../common/constants.js';
import { join } from '../../../../base/common/path.js';
import type { CustomProviderData } from './views/providerView.js';
import { inferImageGen } from '../common/llmBridge.js';

/**
 * Safe access to Node.js require() in Electron renderer.
 * In web mode (no require available), returns undefined.
 * Used for debug-only file writes that need fs/fs-promises.
 */
function nodeRequire(moduleName: string): any {
	if (typeof globalThis !== 'undefined' && typeof (globalThis as any).require === 'function') {
		try { return (globalThis as any).require(moduleName); } catch { return undefined; }
	}
	return undefined;
}

// ─── Provider Definition ────────────────────────────────────────────────────

export interface IBYOKProviderDefinition {
	/** Unique provider id, e.g. 'openrouter' */
	readonly id: string;
	/** Display name, e.g. 'OpenRouter' */
	readonly name: string;
	/** Configuration key for API key */
	readonly apiKeyConfigKey: string;
	/** Configuration key for base URL */
	readonly baseUrlConfigKey: string;
	/** Default base URL */
	readonly defaultBaseUrl: string;
	/** Priority (higher = preferred) */
	readonly priority: number;
	/** Optional: models discovery endpoint path (appended to base URL) */
	readonly modelsEndpointPath?: string;
	/** Optional: static model list (if discovery is not supported) */
	readonly staticModels?: IModelInfo[];
	/** Optional: whether the provider uses OpenAI-compatible API */
	readonly openAICompatible?: boolean;
	/** Optional: if true, the provider can work without an API key (e.g. Ollama local) */
	readonly apiKeyOptional?: boolean;
	/** Optional: chat completions endpoint path (default: 'chat/completions'). E.g. Ollama uses 'v1/chat/completions'. */
	readonly chatEndpointPath?: string;
	/**
	 * Optional: images generation endpoint path (default: 'images/generations').
	 * OpenAI-compatible text→image endpoint, e.g. 'v1/images/generations'.
	 */
	readonly imageGenEndpointPath?: string;
	/**
	 * Optional: if true, this provider targets the native Anthropic Messages API (not OpenAI-compatible).
	 * When set, cache_control will be injected into system messages to enable Prompt Caching (KV Cache).
	 */
	readonly isAnthropic?: boolean;
	/**
	 * Optional: response/streaming format to expect from the endpoint.
	 * - 'openai' (default): OpenAI-compatible SSE (`choices[].delta`).
	 * - 'anthropic': native Anthropic Messages SSE (`content_block_delta` / `message_delta` / ...).
	 * Only meaningful when the endpoint is a real Anthropic `/v1/messages` gateway.
	 */
	readonly responseFormat?: 'openai' | 'anthropic';
	/**
	 * Optional: API key auth header scheme.
	 * - 'bearer' (default): `Authorization: Bearer <key>`.
	 * - 'x-api-key': `x-api-key: <key>` + `anthropic-version` header (native Anthropic gateways).
	 */
	readonly apiKeyHeader?: 'bearer' | 'x-api-key';
	/** Optional: `anthropic-version` header value, used when apiKeyHeader === 'x-api-key'. Default '2023-06-01'. */
	readonly anthropicVersion?: string;
}

/**
 * Convert a UI-defined custom provider (`CustomProviderData`, persisted under
 * `sessions.agentStudio.provider.customProviders`) into an `IBYOKProviderDefinition`
 * so it can be registered into the chat model system (Path B: UI-added providers
 * actually take effect).
 *
 * `apiType: 'anthropic'` wires a real Anthropic `/v1/messages` gateway: native
 * request body + `x-api-key` auth + native Anthropic SSE parsing. `apiType: 'openai'`
 * (default) is a plain OpenAI-compatible endpoint.
 */
export function customProviderDataToDefinition(cp: CustomProviderData): IBYOKProviderDefinition {
	const isAnthropic = cp.apiType === 'anthropic';
	const responseFormat: 'openai' | 'anthropic' = isAnthropic ? 'anthropic' : 'openai';
	const chatEndpointPath = cp.chatEndpointPath || (isAnthropic ? 'v1/messages' : 'v1/chat/completions');
	const apiKeyHeader: 'bearer' | 'x-api-key' = cp.apiKeyHeader || (isAnthropic ? 'x-api-key' : 'bearer');
	const staticModels = (cp.models && cp.models.length > 0)
		? (cp.models || []).map((mid: string) => ({
			id: mid,
			name: mid,
			capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.FunctionCalling],
			supportsToolCall: true,
			capabilityConfig: {
				supportsSystemMessage: 'separated',
				specialToolFormat: isAnthropic ? 'anthropic-style' : 'openai-style',
				reasoningType: 'budget-slider',
				supportsCaching: isAnthropic ? 'anthropic' : false,
				supportsFIM: false,
				reservedOutputTokenSpace: null,
			} as IModelCapabilityConfig,
		}))
		: undefined;
	return {
		id: cp.id,
		name: cp.name,
		apiKeyConfigKey: `sessions.agentStudio.provider.${cp.id}.apiKey`,
		baseUrlConfigKey: `sessions.agentStudio.provider.${cp.id}.baseUrl`,
		defaultBaseUrl: cp.baseUrl || '',
		priority: 40,
		openAICompatible: !isAnthropic,
		isAnthropic,
		responseFormat,
		chatEndpointPath,
		modelsEndpointPath: cp.modelsEndpointPath,
		staticModels,
		apiKeyHeader,
		anthropicVersion: isAnthropic ? (cp.anthropicVersion || '2023-06-01') : undefined,
	};
}

// ─── Retry Configuration ────────────────────────────────────────────────────

/** HTTP status codes that are retriable with exponential backoff. */
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

/** Default maximum number of retry attempts for retriable errors. */
const DEFAULT_MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff (first retry = 1s, second = 2s, third = 4s). */
const BASE_RETRY_DELAY_MS = 1000;

// ─── Built-in BYOK Model Provider ──────────────────────────────────────────

/**
 * A generic OpenAI-compatible Model Provider driven by configuration keys.
 *
 * When the user fills in an API key in the Settings page (e.g. for OpenRouter),
 * this provider detects the configuration change, validates the key, fetches
 * available models (if supported), and surfaces them in the chat composer's
 * provider picker via the standard IModelProvider interface.
 */
export class BuiltInBYOKModelProvider extends Disposable implements IModelProvider {

	readonly id: string;
	readonly name: string;
	readonly priority: number;
	readonly settingsSearchQuery: string;

	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ModelAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ModelAuthStatus> = this._onDidChangeAuthStatus.event;

	private _authStatus: ModelAuthStatus = ModelAuthStatus.NotConfigured;
	private _models: IModelInfo[] = [];
	private _modelsFetched = false;

	/** Tracks the last known health status of the provider endpoint. */
	private _lastHealthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

	constructor(
		protected readonly _definition: IBYOKProviderDefinition,
		protected readonly _configurationService: IConfigurationService,
		protected readonly _logService: ILogService,
		protected readonly _environmentService: IEnvironmentService,
	) {
		super();

		this.id = _definition.id;
		this.name = _definition.name;
		this.priority = _definition.priority;
		this.settingsSearchQuery = `sessions.agentStudio.provider.${_definition.id}`;

		// Initial auth check
		this._checkAuth();

		// React to configuration changes
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(this._definition.apiKeyConfigKey) ||
				e.affectsConfiguration(this._definition.baseUrlConfigKey)
			) {
				this._logService.info(`[BYOK:${this.id}] Configuration changed, re-checking auth`);
				this._modelsFetched = false;
				this._checkAuth();
			}
		}));
	}

	getAuthStatus(): ModelAuthStatus {
		return this._authStatus;
	}

	/** Returns the last known health status of this provider's endpoint. */
	getHealthStatus(): 'healthy' | 'degraded' | 'unhealthy' {
		return this._lastHealthStatus;
	}

	async listModels(): Promise<IModelInfo[]> {
		if (this._authStatus !== ModelAuthStatus.Authenticated) {
			return [];
		}

		// Lazy-fetch models on first call
		if (!this._modelsFetched) {
			await this._fetchModels();
		}

		return this._models;
	}

	chat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncIterable<IModelDelta> {
		return this._streamChat(modelId, messages, options, context);
	}

	/**
	 * 文生图：调用 OpenAI 兼容 `/images/generations` 端点。
	 * renderer 直连路径（web/remote 环境）；主进程环境由
	 * `MainProcessModelProvider` 覆写为经 IPC 转发。
	 */
	async generateImage(params: IImageGenParams): Promise<IImageGenResult> {
		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();
		if (!this._definition.apiKeyOptional && !apiKey) {
			throw new Error(`${this.name}: API key not configured`);
		}
		const imagePath = this._definition.imageGenEndpointPath || 'images/generations';
		const url = `${baseUrl.replace(/\/+$/, '')}/${imagePath.replace(/^\/+/, '')}`;
		const body: Record<string, unknown> = {
			model: params.modelId,
			prompt: params.prompt,
			n: params.numImages ?? 1,
		};
		if (params.width && params.height) {
			body['size'] = `${params.width}x${params.height}`;
		}
		if (params.negativePrompt) {
			body['negative_prompt'] = params.negativePrompt;
		}
		if (params.imageInput) {
			body['input_image'] = params.imageInput;
		}
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
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
	}

	// ─── Internal ─────────────────────────────────────────────

	protected _getApiKey(): string {
		return (this._configurationService.getValue<string>(this._definition.apiKeyConfigKey) || '').trim();
	}

	protected _getBaseUrl(): string {
		const configured = (this._configurationService.getValue<string>(this._definition.baseUrlConfigKey) || '').trim();
		return configured || this._definition.defaultBaseUrl;
	}

	private _checkAuth(): void {
		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();
		const oldStatus = this._authStatus;

		// For providers with apiKeyOptional (e.g. Ollama), only a base URL is required.
		const isAuthenticated = this._definition.apiKeyOptional
			? !!baseUrl
			: !!apiKey;

		if (!isAuthenticated) {
			this._authStatus = ModelAuthStatus.NotConfigured;
			this._models = [];
			this._modelsFetched = false;
		} else {
			// We trust the key is valid (no validation round-trip needed for BYOK).
			// The first actual API call will surface any auth errors.
			this._authStatus = ModelAuthStatus.Authenticated;

			// Pre-populate with static models if defined
			if (this._definition.staticModels && !this._modelsFetched) {
				this._models = [...this._definition.staticModels];
			}
		}

		if (oldStatus !== this._authStatus) {
			this._logService.info(`[BYOK:${this.id}] Auth status: ${oldStatus} → ${this._authStatus}`);
			this._onDidChangeAuthStatus.fire(this._authStatus);
			this._onDidChangeModels.fire();
		}
	}

	private async _fetchModels(): Promise<void> {
		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();

		if (!baseUrl) {
			return;
		}
		// For non-optional-key providers, require API key
		if (!this._definition.apiKeyOptional && !apiKey) {
			return;
		}

		// If static models are defined and no discovery endpoint, use static list
		if (this._definition.staticModels && !this._definition.modelsEndpointPath) {
			this._models = [...this._definition.staticModels];
			this._modelsFetched = true;
			return;
		}

		// Try to fetch models from the provider's API
		const modelsUrl = this._definition.modelsEndpointPath
			? `${baseUrl.replace(/\/+$/, '')}/${this._definition.modelsEndpointPath.replace(/^\/+/, '')}`
			: `${baseUrl.replace(/\/+$/, '')}/models`;

		try {
			this._logService.info(`[BYOK:${this.id}] Fetching models from ${modelsUrl}`);
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}
			const response = await fetch(modelsUrl, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(15000),
			});

			if (!response.ok) {
				this._logService.warn(`[BYOK:${this.id}] Models endpoint returned ${response.status}`);
				// Fall back to static models if available
				if (this._definition.staticModels) {
					this._models = [...this._definition.staticModels];
				}
				this._modelsFetched = true;
				return;
			}

			const data: any = await response.json();
			const rawModels: any[] = data.data || data.models || [];

			this._models = rawModels
				.filter((m: any) => m.id || m.name)
				.slice(0, 200) // Cap to avoid huge lists
				.map((m: any) => ({
					id: m.id || m.name,
					name: m.name || m.id,
					description: m.description || undefined,
					contextWindow: m.context_length || m.context_window || undefined,
					maxInputTokens: m.maxInputTokens || m.max_input_tokens || m.context_length || undefined,
					capabilities: this._inferCapabilities(m),
					supportsToolCall: m.supportsToolCall ?? (m.capabilityConfig?.specialToolFormat !== undefined),
					supportsReasoning: m.supportsReasoning ?? (m.capabilityConfig?.reasoningType ? true : undefined),
					supportsImageGen: m.supportsImageGen ?? inferImageGen(m),
					capabilityConfig: m.capabilityConfig || undefined,
					pricing: m.pricing ? {
						inputPerMillion: typeof m.pricing.prompt === 'string' ? parseFloat(m.pricing.prompt) * 1_000_000 : m.pricing.input_per_million,
						outputPerMillion: typeof m.pricing.completion === 'string' ? parseFloat(m.pricing.completion) * 1_000_000 : m.pricing.output_per_million,
					} : undefined,
				}));

			this._logService.info(`[BYOK:${this.id}] Fetched ${this._models.length} models`);
		} catch (err) {
			this._logService.warn(`[BYOK:${this.id}] Failed to fetch models:`, err);
			// Fall back to static models
			if (this._definition.staticModels) {
				this._models = [...this._definition.staticModels];
			}
		}

		this._modelsFetched = true;
		this._onDidChangeModels.fire();
	}

	private _inferCapabilities(m: any): ModelCapability[] {
		const caps: ModelCapability[] = [ModelCapability.Chat];
		const id = (m.id || '').toLowerCase();
		const desc = (m.description || '').toLowerCase();

		// ── 优先使用声明式 capabilityConfig ──────────────────────────
		// 如果模型信息中携带了 capabilityConfig（来自 staticModels 或 API 响应），
		// 直接从配置推断能力，无需通过 ID/描述猜测。
		const config: IModelCapabilityConfig | undefined = m.capabilityConfig;
		if (config) {
			if (config.specialToolFormat) {
				caps.push(ModelCapability.FunctionCalling);
			}
			// 声明式配置不包含 Vision/Code 推断，回退到 ID/描述匹配
		} else {
			// ── 回退：从 API 响应中推断能力 ──────────────────────────
			const supportedParams = m.supported_parameters || [];
			if (Array.isArray(supportedParams) && supportedParams.includes('tools')) {
				caps.push(ModelCapability.FunctionCalling);
			}
		}

		// Vision/Code 推断（声明式配置和回退都使用）
		if (id.includes('vision') || desc.includes('vision') || desc.includes('image')) {
			caps.push(ModelCapability.Vision);
		}
		if (id.includes('code') || desc.includes('code') || desc.includes('coding')) {
			caps.push(ModelCapability.Code);
		}
		return caps;
	}

	// ─── Streaming Chat (refactored) ────────────────────────────────────

	private async *_streamChat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncGenerator<IModelDelta> {
		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();

		if (!this._definition.apiKeyOptional && !apiKey) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: API key not configured`);
			yield { type: 'error', error: `${this.name}: API key not configured` };
			return;
		}

		const chatPath = this._definition.chatEndpointPath || 'chat/completions';
		const url = `${baseUrl.replace(/\/+$/, '')}/${chatPath.replace(/^\/+/, '')}`;

		// 原生 Anthropic SSE 解析状态（仅 responseFormat==='anthropic' 时使用，
		// 不触碰 OpenAI 兼容路径）。
		const isAnthropicStream = this._definition.responseFormat === 'anthropic';
		const anthropicState = isAnthropicStream ? new AnthropicStreamState() : undefined;

		this._logService.info(`[BYOK:${this.id}] _streamChat: url=${url}, model=${modelId}, messages=${messages.length}`);

		const body = this._buildRequestBody(modelId, messages, options, context);

		// Debug: write request body to local file if switch is enabled
		this._debugWriteRequest(body);

		// 抓包对齐：直连路径下三个会话 id 经 HTTP header 传给网关（与 CodeBuddy IDE 一致）。
		const idHeaders: Record<string, string> = {};
		if (context?.conversationId ?? context?.sessionId) {
			idHeaders['X-Conversation-ID'] = (context?.conversationId ?? context?.sessionId) as string;
		}
		if (context?.requestId) {
			idHeaders['X-Conversation-Request-ID'] = context.requestId;
		}

		const response = yield* this._sendRequestWithRetry(url, apiKey, body, idHeaders);
		if (!response) { return; }

		const reader = response.body?.getReader();
		if (!reader) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: No response body`);
			yield { type: 'error', error: `${this.name}: No response body` };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';
		let yieldCount = 0;
		let sseDataFound = false;
		let fullBodyForFallback = '';
		let chunkCount = 0;
		// 抓包对齐：收集所有 SSE chunk 用于响应日志
		let sseChunks: string[] = [];
		// 抓包对齐：捕获响应流 chunk 的 id（每个 chunk 的 id 相同），
		// 它 = 下一次请求的 previous_response_id，随 done 回传给 agentOS。
		let capturedResponseId: string | undefined;
		// 捕获本轮结束原因（OpenAI finish_reason / Anthropic stop_reason 经网关映射），
		// 随 done delta 上抛给 agentOS 做"未完成轮"结构判定（对齐 OpenClaw）。
		let capturedFinishReason: string | undefined;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					this._logService.info(`[BYOK:${this.id}] _streamChat: reader done, total yields=${yieldCount}, sseFound=${sseDataFound}, chunks=${chunkCount}`);
					break;
				}

				const chunk = decoder.decode(value, { stream: true });
				chunkCount++;
				// 抓包对齐：收集每个 SSE chunk 用于响应日志
				sseChunks.push(chunk);
				if (chunkCount <= 3) {
					this._logService.info(`[BYOK:${this.id}] _streamChat: chunk[${chunkCount}] (${chunk.length} bytes): ${JSON.stringify(chunk.slice(0, 300))}`);
				}
				buffer += chunk;
				fullBodyForFallback += chunk;

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) { continue; }

					const jsonPayload = this._extractJsonPayload(trimmed);
					if (jsonPayload === null) { continue; }
					if (jsonPayload === '[DONE]') {
						sseDataFound = true;
						this._logService.info(`[BYOK:${this.id}] _streamChat: received [DONE]`);
						continue;
					}

					try {
						const parsed = JSON.parse(jsonPayload);
						sseDataFound = true;

						// 抓包对齐：捕获响应流 chunk 的 id（= 下一次 previous_response_id）
						if (typeof parsed.id === 'string' && parsed.id) {
							capturedResponseId = parsed.id;
						}

						// 原生 Anthropic SSE：走专用解析器（不影响 OpenAI 兼容路径）
						if (isAnthropicStream && anthropicState) {
							const anthropicDeltas = anthropicState.push(parsed);
							for (const d of anthropicDeltas) {
								yieldCount++;
								yield d;
							}
							continue;
						}

						// Extract token usage
						const usageDelta = this._extractUsage(parsed);
						if (usageDelta) {
							yieldCount++;
							yield usageDelta;
						}

						// Parse content (text / thinking / tool_calls)
						const content = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
						if (!content) {
							const finishReason = parsed.choices?.[0]?.finish_reason;
							if (finishReason) {
								capturedFinishReason = finishReason;
								this._logService.info(`[BYOK:${this.id}] _streamChat: finish_reason=${finishReason}`);
							}
							continue;
						}

						const contentDeltas = this._parseContentFromJson(content);
						for (const d of contentDeltas) {
							yieldCount++;
							yield d;
						}
					} catch {
						this._logService.warn(`[BYOK:${this.id}] _streamChat: malformed JSON line: ${jsonPayload.slice(0, 200)}`);
					}
				}
			}

			// Process remaining buffer
			const remainingDeltas = this._processRemainingBuffer(buffer, anthropicState);
			if (remainingDeltas.length > 0) {
				sseDataFound = true;
			}
			for (const d of remainingDeltas) {
				yieldCount++;
				yield d;
			}

			// Fallback: parse entire body as non-streaming JSON response
			if (!sseDataFound && fullBodyForFallback.trim()) {
				this._logService.info(`[BYOK:${this.id}] _streamChat: no streaming data found, trying full JSON fallback (bodyLen=${fullBodyForFallback.length})`);
				const fallbackDeltas = this._parseFullJsonFallback(fullBodyForFallback, anthropicState);
				for (const d of fallbackDeltas) {
					yieldCount++;
					yield d;
				}
			}

			// Mark healthy after successful stream
			this._updateHealthStatus('healthy');
		} catch (streamErr) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: stream read error:`, streamErr);
			this._updateHealthStatus('degraded');
			yield { type: 'error', error: `${this.name}: Stream error — ${streamErr}` };
		} finally {
			// 抓包对齐：流结束后写入响应日志
			this._debugWriteResponse(sseChunks, body.model as string);
			this._logService.info(`[BYOK:${this.id}] _streamChat: finally block, yielding done (yields=${yieldCount}, responseId=${capturedResponseId ?? '(none)'})`);

			// 原生 Anthropic：工具块已在 content_block_stop / finish() 中 flush，
			// 这里统一产出收尾 done（携带 responseId / stop_reason）。
			if (isAnthropicStream && anthropicState) {
				for (const d of anthropicState.finish()) {
					yieldCount++;
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
		}
	}

	// ─── Extracted Helper Methods ─────────────────────────────────────

	/**
	 * Build the request body for the chat completions API.
	 */
	protected _buildRequestBody(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): Record<string, unknown> {
		// 原生 Anthropic Messages API（/v1/messages）：使用 Anthropic 原生请求体格式
		if (this._definition.responseFormat === 'anthropic') {
			return this._buildAnthropicRequestBody(modelId, messages, options, context);
		}

		const body: Record<string, unknown> = {
			model: modelId,
			messages: MessageFormatConverter.toOpenAI(messages, {
				isAnthropic: this._definition.isAnthropic,
				tools: options.tools,
				capabilityConfig: undefined, // BYOK provider 统一使用 OpenAI 兼容格式
				// Fork 前缀缓存（请求构造端接 ForkContext）：透传 agent 冻结 system + 父级
				// ForkContext，使构造端能在冻结前缀边界注入 cache_control 断点（Anthropic 兼容）。
				systemPrompt: options.systemPrompt,
				forkContext: options.forkContext,
			}),
			stream: true,
		};
		// 抓包对齐：注入 previous_response_id（= 上一次响应流 chunk 的 id），
		// 让服务端按响应链衔接上下文。由 agentOS 经 IChatContext 下传。
		if (context?.previousResponseId) {
			body.previous_response_id = context.previousResponseId;
		}
		if (options.temperature !== undefined) {
			body.temperature = options.temperature;
		}
		if (options.maxTokens !== undefined) {
			body.max_tokens = options.maxTokens;
		}
		if (options.tools && options.tools.length > 0) {
			// Fork 前缀缓存：Anthropic 兼容时把最后一个工具定义也打上 cache 断点，
			// 使 system + tools 共同构成父/子 fork 共享的冻结缓存前缀。
			body.tools = MessageFormatConverter.toOpenAIToolDefinitions(
				options.tools,
				options.forkContext,
				this._definition.isAnthropic,
				options.systemPrompt,
			);
			// 透传上层（agent loop 续跑兜底）指定的 tool_choice；默认 'auto'。
			// 'required' 用于强制模型在续跑这一轮必须调用工具，治"宣告意图却不动手"。
			body.tool_choice = options.toolChoice ?? 'auto';
			const mcpToolCount = options.tools.filter(t => t.category?.startsWith('mcp:')).length;
			this._logService.info(
				`[BYOK:${this.id}] _streamChat: sending ${options.tools.length} tools ` +
				`(MCP: ${mcpToolCount}, builtin: ${options.tools.length - mcpToolCount}) ` +
				`with tool_choice=${body.tool_choice}\n` +
				`  tool names: [${options.tools.map(t => t.name).join(', ')}]`
			);
		} else {
			// 无工具面：正常路径不设 tool_choice（'auto'/'required' 在没有 tools 时
			// 无意义，部分网关还会校验报错）。唯一例外是收尾轮的 'none' ——
			// 它是「禁止调用工具」的协议级声明，与空工具面构成双保险
			// （对齐 MiMo-Code 的 toolChoice:"none"）。
			if (options.toolChoice === 'none') {
				body.tool_choice = 'none';
				this._logService.info(`[BYOK:${this.id}] _streamChat: NO tools + tool_choice='none' (final wrap-up round — model must answer from gathered context)`);
			} else {
				this._logService.warn(`[BYOK:${this.id}] _streamChat: NO tools in request (options.tools is empty or undefined)`);
			}
		}

		// ── Thinking / Reasoning 参数注入 ─────────────────────────────
		// 按模型 capabilityConfig.reasoningType 决定 API 形态（参考 void）：
		//   - 'effort-slider'（OpenAI o 系列 / xAI / DeepSeek）→ reasoning_effort: 'low'|'medium'|'high'
		//   - 'budget-slider' + Anthropic 兼容 → thinking: { type: 'enabled', budget_tokens: N }
		//   - 'budget-slider' + OpenAI 兼容 → 退化为 reasoning_effort（按 budget 粗分档）
		if (options.reasoning?.enabled) {
			const model = this._models.find(m => m.id === modelId);
			const reasoningType = model?.capabilityConfig?.reasoningType;
			const effort = options.reasoning.effort;
			const budget = options.reasoning.budget;

			if (this._definition.isAnthropic || reasoningType === 'budget-slider') {
				if (budget && budget > 0) {
					// Anthropic 原生 extended thinking
					body.thinking = { type: 'enabled', budget_tokens: budget };
					this._logService.info(`[BYOK:${this.id}] reasoning: thinking budget_tokens=${budget}`);
				} else if (effort) {
					body.reasoning_effort = effort;
					this._logService.info(`[BYOK:${this.id}] reasoning: reasoning_effort=${effort}`);
				}
			} else {
				// OpenAI o 系列 / DeepSeek / 其它 OpenAI 兼容：reasoning_effort
				body.reasoning_effort = effort
					?? (budget != null ? (budget >= 6144 ? 'high' : budget >= 3072 ? 'medium' : 'low') : 'medium');
				this._logService.info(`[BYOK:${this.id}] reasoning: reasoning_effort=${body.reasoning_effort}`);
			}
		}
		return body;
	}

	/**
	 * Build a native Anthropic Messages API request body (`/v1/messages`).
	 * System prompt is a separate top-level `system` field; messages/tools use
	 * Anthropic content-block format; `max_tokens` is required by the API.
	 */
	private _buildAnthropicRequestBody(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): Record<string, unknown> {
		const { messages: anthropicMsgs, systemPrompt } = MessageFormatConverter.toAnthropic(messages, {
			systemPrompt: options.systemPrompt,
			tools: options.tools,
			forkContext: options.forkContext,
		});

		const body: Record<string, unknown> = {
			model: modelId,
			// Anthropic requires max_tokens; default to a sane value when not provided.
			max_tokens: options.maxTokens ?? 8192,
			stream: true,
		};
		if (systemPrompt) {
			body.system = systemPrompt;
		}
		body.messages = anthropicMsgs;

		// 抓包对齐：注入 previous_response_id（与 OpenAI 路径一致）
		if (context?.previousResponseId) {
			body.previous_response_id = context.previousResponseId;
		}
		if (options.temperature !== undefined) {
			body.temperature = options.temperature;
		}
		if (options.tools && options.tools.length > 0) {
			body.tools = MessageFormatConverter.toAnthropicToolDefinitions(
				options.tools,
				options.forkContext,
				true,
				options.systemPrompt,
			);
		}

		// ── Thinking / Reasoning 参数注入（Anthropic 原生 extended thinking）──
		if (options.reasoning?.enabled) {
			const budget = options.reasoning.budget;
			if (budget && budget > 0) {
				body.thinking = { type: 'enabled', budget_tokens: budget };
				this._logService.info(`[BYOK:${this.id}] reasoning: thinking budget_tokens=${budget}`);
			}
		}
		return body;
	}

	/**
	 * Send the HTTP request with automatic retry for retriable status codes.
	 * Uses exponential backoff: 1s → 2s → 4s between retries.
	 * Yields error deltas on failure. Returns the Response on success, or null.
	 */
	private async *_sendRequestWithRetry(
		url: string,
		apiKey: string,
		body: Record<string, unknown>,
		extraHeaders?: Record<string, string>,
	): AsyncGenerator<IModelDelta, Response | null, unknown> {
		let lastError: string = '';

		for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
			// Attempt the fetch
			let response: Response;
			try {
				if (attempt > 0) {
					this._logService.info(`[BYOK:${this.id}] _sendRequestWithRetry: attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES + 1}`);
				}
				const headers: Record<string, string> = {
					'Content-Type': 'application/json',
					...(extraHeaders ?? {}),
				};
				if (apiKey) {
					if (this._definition.apiKeyHeader === 'x-api-key') {
						headers['x-api-key'] = apiKey;
						headers['anthropic-version'] = this._definition.anthropicVersion || '2023-06-01';
					} else {
						headers['Authorization'] = `Bearer ${apiKey}`;
					}
				}
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 300_000);
				try {
					response = await fetch(url, {
						method: 'POST',
						headers,
						body: JSON.stringify(body),
						signal: controller.signal,
					});
				} finally {
					clearTimeout(timeoutId);
				}
				this._logService.info(`[BYOK:${this.id}] _streamChat: response status=${response.status} ${response.statusText}`);
			} catch (err) {
				this._logService.error(`[BYOK:${this.id}] _streamChat: fetch error:`, err);
				this._updateHealthStatus('unhealthy');

				// Network errors are retriable
				if (attempt < DEFAULT_MAX_RETRIES) {
					const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
					this._logService.info(`[BYOK:${this.id}] _sendRequestWithRetry: network error, retrying in ${delayMs}ms...`);
					yield* this._delay(delayMs);
					continue;
				}
				yield { type: 'error', error: `${this.name}: Network error — ${err}` };
				return null;
			}

			// Successful response
			if (response.ok) {
				this._updateHealthStatus('healthy');
				return response;
			}

			// Non-retriable error (e.g. 401, 403, 404)
			if (!RETRIABLE_STATUS_CODES.has(response.status)) {
				const text = await response.text().catch(() => '');
				this._logService.error(`[BYOK:${this.id}] _streamChat: HTTP error (non-retriable): ${response.status} — ${text.slice(0, 500)}`);
				this._updateHealthStatus('unhealthy');
				yield { type: 'error', error: `${this.name}: ${response.status} ${response.statusText} — ${text.slice(0, 500)}` };
				return null;
			}

			// Retriable error (429, 500, 502, 503)
			const text = await response.text().catch(() => '');
			lastError = `${response.status} ${response.statusText} — ${text.slice(0, 500)}`;
			this._logService.warn(`[BYOK:${this.id}] _streamChat: HTTP error (retriable): ${lastError}`);

			if (attempt < DEFAULT_MAX_RETRIES) {
				// Respect Retry-After header for 429, otherwise use exponential backoff
				let delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
				const retryAfter = response.headers.get('Retry-After');
				if (retryAfter) {
					const parsed = parseInt(retryAfter, 10);
					if (!isNaN(parsed) && parsed > 0) {
						delayMs = parsed * 1000; // Retry-After is in seconds
					}
				}
				this._logService.info(`[BYOK:${this.id}] _sendRequestWithRetry: retrying in ${delayMs}ms (attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES})`);
				this._updateHealthStatus('degraded');
				yield* this._delay(delayMs);
			}
		}

		// All retries exhausted
		this._updateHealthStatus('unhealthy');
		this._logService.error(`[BYOK:${this.id}] _sendRequestWithRetry: all retries exhausted, last error: ${lastError}`);
		yield { type: 'error', error: `${this.name}: ${lastError}` };
		return null;
	}

	/**
	 * Simple async delay generator that yields nothing (keeps the stream alive).
	 */
	private async *_delay(ms: number): AsyncGenerator<IModelDelta, void, unknown> {
		await new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Update the provider health status and log changes.
	 */
	private _updateHealthStatus(status: 'healthy' | 'degraded' | 'unhealthy'): void {
		if (this._lastHealthStatus !== status) {
			this._logService.info(`[BYOK:${this.id}] Health status: ${this._lastHealthStatus} → ${status}`);
			this._lastHealthStatus = status;
		}
	}

	/**
	 * Debug: write the full request body to a local file if the debug switch is enabled.
	 * Writes to: <logsHome>/chat-streams/<sessionId>_<modelId>_<timestamp>_request.json
	 */
	private async _debugWriteRequest(body: Record<string, unknown>): Promise<void> {
		try {
			const enabled = this._configurationService.getValue<boolean>(AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING);
			if (!enabled) { return; }

			const logsHome = this._environmentService.logsHome;
			if (!logsHome) { return; }

			const dirPath = join(logsHome.fsPath, 'chat-streams');
			const fsPromises = nodeRequire('fs/promises');
			if (!fsPromises) { return; }
			const dirExists = await fsPromises.access(dirPath).then(() => true).catch(() => false);
			if (!dirExists) {
				const fs = nodeRequire('fs');
				if (!fs) { return; }
				await fs.promises.mkdir(dirPath, { recursive: true });
			}

			const timestamp = Date.now();
			const suffix = Math.random().toString(36).slice(2, 7);
			const fileName = `byok_${this.id}_${suffix}_${timestamp}_request.json`;
			const filePath = join(dirPath, fileName);

			const debugObj = {
				provider: this.id,
				model: body.model,
				timestamp: new Date(timestamp).toISOString(),
				messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
				tools: body.tools ? `(${Array.isArray(body.tools) ? body.tools.length : 'unknown'} tools)` : '(none)',
				body,
			};

			await fsPromises.writeFile(filePath, JSON.stringify(debugObj, null, 2), 'utf-8');
			this._logService.info(`[BYOK:${this.id}] Debug request written to: ${filePath}`);
		} catch (err) {
			this._logService.warn(`[BYOK:${this.id}] _debugWriteRequest failed:`, err);
		}
	}

	/**
	 * Debug: write the SSE response chunks to a local file if the debug switch is enabled.
	 * Writes to: <logsHome>/chat-streams/<sessionId>_<modelId>_<timestamp>_response.json
	 */
	private async _debugWriteResponse(sseChunks: string[], model: string): Promise<void> {
		try {
			const enabled = this._configurationService.getValue<boolean>(AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING);
			if (!enabled) { return; }

			const logsHome = this._environmentService.logsHome;
			if (!logsHome) { return; }

			const dirPath = join(logsHome.fsPath, 'chat-streams');
			const fsPromises = nodeRequire('fs/promises');
			if (!fsPromises) { return; }
			const dirExists = await fsPromises.access(dirPath).then(() => true).catch(() => false);
			if (!dirExists) {
				const fs = nodeRequire('fs');
				if (!fs) { return; }
				await fs.promises.mkdir(dirPath, { recursive: true });
			}

			const timestamp = Date.now();
			const suffix = Math.random().toString(36).slice(2, 7);
			const fileName = `byok_${this.id}_${suffix}_${timestamp}_response.json`;
			const filePath = join(dirPath, fileName);

			// 将所有 SSE chunk 拼接后按行解析，收集每个 data: 行 payload
			const allText = sseChunks.join('');
			const lines = allText.split('\n');
			const dataLines: string[] = [];
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) { continue; }
				if (trimmed.startsWith('data:')) {
					dataLines.push(trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5));
				} else if (trimmed.startsWith('{')) {
					dataLines.push(trimmed);
				}
			}

			const debugObj = {
				provider: this.id,
				model,
				timestamp: new Date(timestamp).toISOString(),
				chunkCount: sseChunks.length,
				totalBytes: sseChunks.reduce((sum, c) => sum + c.length, 0),
				dataLines,
			};

			await fsPromises.writeFile(filePath, JSON.stringify(debugObj, null, 2), 'utf-8');
			this._logService.info(`[BYOK:${this.id}] Debug response written to: ${filePath}`);
		} catch (err) {
			this._logService.warn(`[BYOK:${this.id}] _debugWriteResponse failed:`, err);
		}
	}

	/**
	 * Extract the JSON payload string from a single SSE/NDJSON line.
	 * Returns null for unrecognized lines, or the string '[DONE]' for SSE termination.
	 */
	private _extractJsonPayload(trimmed: string): string | null {
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
	 * Extract token usage from a parsed SSE/NDJSON chunk.
	 * Returns a usage delta if meaningful data is found, otherwise null.
	 */
	private _extractUsage(parsed: any): IModelDelta | null {
		if (!parsed.usage) { return null; }
		const u = parsed.usage;
		const cachedTokens =
			u.prompt_tokens_details?.cached_tokens ??
			u.cache_read_input_tokens ??
			undefined;
		const cacheWriteTokens =
			u.cache_creation_input_tokens ?? undefined;
		const inputTokens = u.prompt_tokens ?? u.input_tokens ?? undefined;
		const outputTokens = u.completion_tokens ?? u.output_tokens ?? undefined;
		if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined || cacheWriteTokens !== undefined) {
			if (cachedTokens !== undefined) {
				this._logService.info(`[BYOK:${this.id}] KV Cache hit: cached=${cachedTokens} / input=${inputTokens ?? '?'} tokens`);
			}
			return {
				type: 'usage',
				usage: { inputTokens, outputTokens, cachedTokens, cacheWriteTokens },
			};
		}
		return null;
	}

	/**
	 * Parse content (text, thinking, tool_calls) from a delta or message object.
	 * Returns an array of deltas to yield.
	 */
	private _parseContentFromJson(content: any): IModelDelta[] {
		const deltas: IModelDelta[] = [];

		// Handle reasoning/thinking content
		let reasoningContent = content.reasoning_content ?? content.thinking ?? content.reasoning;
		let actualContent = content.content;

		// Parse <think|thinking> tags from content (DeepSeek/QwQ/qwen style via Ollama)
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

		// Handle tool calls — support multiple formats:
		// 1. OpenAI standard: tool_calls[].function.{name, arguments}
		// 2. Anthropic via proxy: tool_calls[].{name, input/arguments}
		// 3. Some proxies: tool_calls[].{id, name, arguments} (flat)
		if (content.tool_calls) {
			for (const tc of content.tool_calls) {
				const parsed = this._parseToolCall(tc);
				if (parsed) {
					deltas.push({ type: 'tool_call', toolCall: parsed });
				}
			}
		}

		return deltas;
	}

	/**
	 * Parse a single tool call object from various provider formats.
	 */
	private _parseToolCall(tc: any): { id: string; name: string; arguments: string } | null {
		let toolId = tc.id || '';
		let toolName = '';
		let toolArgs = '';

		if (tc.function) {
			// Standard OpenAI format
			toolName = tc.function.name || '';
			toolArgs = tc.function.arguments || '';
		} else if (tc.name) {
			// Anthropic / flat format: name at top level
			toolName = tc.name;
			const rawArgs = tc.arguments ?? tc.input ?? tc.args;
			toolArgs = typeof rawArgs === 'string' ? rawArgs
				: typeof rawArgs === 'object' ? JSON.stringify(rawArgs)
				: '';
			if (!toolId) { toolId = tc.tool_use_id || tc.toolUseId || ''; }
		}

		return (toolName || toolArgs) ? { id: toolId, name: toolName, arguments: toolArgs } : null;
	}

	/**
	 * Process the remaining buffer at the end of a stream.
	 * Returns an array of deltas to yield.
	 */
	private _processRemainingBuffer(buffer: string, anthropicState?: AnthropicStreamState): IModelDelta[] {
		const deltas: IModelDelta[] = [];
		const trimmed = buffer.trim();
		if (!trimmed) { return deltas; }

		const jsonPayload = this._extractJsonPayload(trimmed);
		if (!jsonPayload || jsonPayload === '[DONE]') { return deltas; }

		try {
			const parsed = JSON.parse(jsonPayload);
			if (anthropicState) {
				deltas.push(...anthropicState.push(parsed));
				return deltas;
			}
			const content = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
			if (content) {
				deltas.push(...this._parseContentFromJson(content));
			}
			// Also check for usage in the final chunk
			const usageDelta = this._extractUsage(parsed);
			if (usageDelta) {
				deltas.push(usageDelta);
			}
		} catch {
			// Ignore trailing partial data
		}

		return deltas;
	}

	/**
	 * Fallback parser for non-streaming responses: parse the entire body as JSON.
	 * Returns an array of deltas to yield.
	 */
	private _parseFullJsonFallback(fullBody: string, anthropicState?: AnthropicStreamState): IModelDelta[] {
		const deltas: IModelDelta[] = [];
		try {
			const parsed = JSON.parse(fullBody);

			if (anthropicState) {
				deltas.push(...anthropicState.push(parsed));
				return deltas;
			}

			// Extract usage from non-streaming response
			const usageDelta = this._extractUsage(parsed);
			if (usageDelta) {
				deltas.push(usageDelta);
				const usage = (usageDelta as any).usage;
				if (usage?.cachedTokens !== undefined) {
					this._logService.info(`[BYOK:${this.id}] KV Cache hit (fallback): cached=${usage.cachedTokens} / input=${usage.inputTokens ?? '?'} tokens`);
				}
			}

			const message = parsed.choices?.[0]?.message;
			if (message) {
				deltas.push(...this._parseContentFromJson(message));
			}
		} catch (parseErr) {
			this._logService.warn(`[BYOK:${this.id}] _streamChat: JSON fallback parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
			// Last resort: if it looks like plain text content, yield it
			const rawTrimmed = fullBody.trim();
			if (rawTrimmed.length > 0 && rawTrimmed.length < 100000 && !rawTrimmed.startsWith('<')) {
				deltas.push({ type: 'text', content: rawTrimmed });
			}
		}
		return deltas;
	}
}

// ─── Anthropic native SSE parser ────────────────────────────────────────────
// AnthropicStreamState 定义在 ../common/llmBridge.js（renderer 与主进程共享）。

import { AnthropicStreamState } from '../common/llmBridge.js';

// ─── Built-in Provider Definitions ──────────────────────────────────────────

import {
	AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY,
	AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
	AGENT_STUDIO_PROVIDER_NOUS_API_KEY,
	AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
	AGENT_STUDIO_PROVIDER_GEMINI_API_KEY,
	AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
	AGENT_STUDIO_PROVIDER_MAIN_API_KEY,
	AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
	AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
	AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
	AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY,
	AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
} from '../common/constants.js';

/**
 * All built-in BYOK provider definitions.
 * Each definition maps a Settings section to an IModelProvider instance.
 */
export const BUILTIN_BYOK_PROVIDERS: IBYOKProviderDefinition[] = [
	{
		id: 'openrouter',
		name: 'OpenRouter',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
		priority: 80,
		modelsEndpointPath: 'models',
		openAICompatible: true,
	},
	{
		id: 'nous',
		name: 'Nous',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_NOUS_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
		defaultBaseUrl: 'https://api.nous.com/v1',
		priority: 70,
		modelsEndpointPath: 'models',
		openAICompatible: true,
	},
	{
		id: 'gemini',
		name: 'Gemini',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_GEMINI_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
		defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		priority: 75,
		// Gemini OpenAI-compatible endpoint uses /models
		modelsEndpointPath: 'models',
		openAICompatible: true,
		staticModels: [
			{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling], supportsToolCall: true, supportsReasoning: true, capabilityConfig: { supportsSystemMessage: 'separated', specialToolFormat: 'gemini-style', reasoningType: 'budget-slider', supportsCaching: false, supportsFIM: false, reservedOutputTokenSpace: null } },
			{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling], supportsToolCall: true, supportsReasoning: true, capabilityConfig: { supportsSystemMessage: 'separated', specialToolFormat: 'gemini-style', reasoningType: 'budget-slider', supportsCaching: false, supportsFIM: false, reservedOutputTokenSpace: null } },
			{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling], supportsToolCall: true, capabilityConfig: { supportsSystemMessage: 'separated', specialToolFormat: 'gemini-style', supportsCaching: false, supportsFIM: false, reservedOutputTokenSpace: null } },
		],
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
		defaultBaseUrl: 'https://api.anthropic.com',
		priority: 85,
		openAICompatible: false,
		isAnthropic: true,
		staticModels: [
			{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling], supportsToolCall: true, supportsReasoning: true, capabilityConfig: { supportsSystemMessage: 'separated', specialToolFormat: 'anthropic-style', reasoningType: 'budget-slider', supportsCaching: 'anthropic', supportsFIM: false, reservedOutputTokenSpace: null } },
			{ id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling], supportsToolCall: true, supportsReasoning: true, capabilityConfig: { supportsSystemMessage: 'separated', specialToolFormat: 'anthropic-style', reasoningType: 'budget-slider', supportsCaching: 'anthropic', supportsFIM: false, reservedOutputTokenSpace: null } },
			{ id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.FunctionCalling], supportsToolCall: true, capabilityConfig: { supportsSystemMessage: 'separated', specialToolFormat: 'anthropic-style', supportsCaching: 'anthropic', supportsFIM: false, reservedOutputTokenSpace: null } },
		],
	},
	{
		id: 'main',
		name: 'Main',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_MAIN_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
		defaultBaseUrl: '',
		priority: 60,
		modelsEndpointPath: 'models',
		openAICompatible: true,
	},
	{
		id: 'ollama',
		name: 'Ollama',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
		defaultBaseUrl: 'http://localhost:11434',
		priority: 65,
		modelsEndpointPath: 'api/tags',
		chatEndpointPath: 'v1/chat/completions',
		openAICompatible: true,
		apiKeyOptional: true,
	},
	{
		id: 'custom',
		name: 'Custom',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
		defaultBaseUrl: '',
		priority: 50,
		modelsEndpointPath: 'models',
		openAICompatible: true,
	},
];
