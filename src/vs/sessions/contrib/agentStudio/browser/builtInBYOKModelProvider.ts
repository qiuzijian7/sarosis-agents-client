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
import { AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING } from '../common/constants.js';
import { join } from '../../../../base/common/path.js';
import type { CustomProviderData } from './views/providerView.js';
import { inferImageGen } from '../common/llmBridge.js';
// 协议解析与编排均收敛到 common 单一实现（此前本文件与 node 侧各有私有拷贝）。
// 请求构造同样下沉到 common（与响应侧解析器对称）：url / body / parseMode 一次产出。
import { createRequestBuilder } from '../common/protocols/requestBuilder.js';
import type { IRequestBuilder } from '../common/protocols/chatProtocol.js';
// 编排（重试退避 → 读流 → 解析 → 收尾 done）与主进程路径共用同一实现。
import { runChatStream } from '../common/protocols/runChatStream.js';

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
	 * Optional: img2img（图生图）endpoint path（default: 'images/edits'）。
	 * OpenAI 兼容 multipart 端点（image 字段 = 参考图）。imageInput 存在时优先
	 * 走此端点，失败自动回退文生图（参考图降级忽略，保证出图）。
	 */
	readonly imageEditEndpointPath?: string;
	/**
	 * Optional: HTTP method for the images generation endpoint (default: 'POST').
	 * OpenAI-compatible servers use POST; some gateways/proxies expect 'GET'
	 * (e.g. when tunneling via query params) — set this to match the server.
	 */
	readonly imageGenMethod?: 'POST' | 'GET';
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
		? (cp.models || []).map((mid: string) => {
			const mInfo: IModelInfo = {
				id: mid,
				name: mid,
				capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.FunctionCalling],
				supportsToolCall: true,
				supportsImageGen: inferImageGen({ id: mid } as IModelInfo),
				capabilityConfig: {
					supportsSystemMessage: 'separated',
					specialToolFormat: isAnthropic ? 'anthropic-style' : 'openai-style',
					reasoningType: 'budget-slider',
					supportsCaching: isAnthropic ? 'anthropic' : false,
					supportsFIM: false,
					reservedOutputTokenSpace: null,
				} as IModelCapabilityConfig,
			};
			return mInfo;
		})
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
		imageGenEndpointPath: cp.imageGenEndpointPath,
		imageGenMethod: cp.imageGenMethod,
	};
}

// ─── Stream Configuration ───────────────────────────────────────────────────

/**
 * 单次流式请求的整体超时（含连接与读流）。
 *
 * 重试策略（次数 / 退避 / 可重试状态码）已随编排下沉到
 * `common/protocols/runChatStream.ts`，此处只保留传输层超时 —— 它属于
 * 「直连路径的 fetch 语义」，与主进程侧的 signal 联动是各自注入的差异点。
 */
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;

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

	/**
	 * 本 provider 的 strict 工具模式判定（2026-09-21）。
	 *
	 * - **官方 OpenAI / Azure OpenAI 端点 → 开**：这两家真支持 structured outputs 的 strict 子集
	 *   （schema 由 `toolSchemaStrict` 清洗成合法子集 + 按工具回退）；
	 * - **其余端点 → 交给模型级声明**（返回 `undefined`）：OpenRouter / Nous / Ollama / Gemini
	 *   OpenAI 兼容端点 / 任意自建网关对 `strict` 字段的处理各不相同（透传 / 忽略 / 直接 400），
	 *   默认开启等于把 400 风险平摊给所有用户 ⇒ 想做的人可以在模型 `capabilityConfig` 里显式声明
	 *   `strictToolSchema: true`（也可声明 false 强行关掉官方端点上的 strict）。
	 *
	 * ⚠ 这里按 **host** 判定而非 provider id：`main` / `custom` 的 baseUrl 由用户配置，
	 * 同一个 provider id 可能指向 api.openai.com，也可能指向内网网关。
	 */
	protected _resolveStrictToolSchema(): boolean | undefined {
		try {
			const host = new URL(this._getBaseUrl()).host.toLowerCase();
			if (host === 'api.openai.com' || host.endsWith('.openai.azure.com')) {
				return true;
			}
		} catch {
			// baseUrl 为空/非法（例如未配置的 main/custom）：不判定，交给模型级声明
		}
		return undefined;
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

		// 请求构造下沉到 common 的 RequestBuilder（与响应侧解析器对称）：
		// url / body / parseMode 一次产出，主进程侧复用同一实现。
		const built = this._requestBuilder().build({
			modelId,
			messages,
			options,
			context,
			baseUrl,
			chatEndpointPath: this._definition.chatEndpointPath,
		});
		const { url, body } = built;

		// ★ 2026-09-19：**不再在本文件创建 anthropic 解析状态** ✗ ——
		// 解析状态与编排都归 `runChatStream`（common ✓）内部持有 ✓，
		// 本文件只把 `built.parseMode` 经 hooks 传下去即可 ✓。
		// （原 `isAnthropicStream` / `anthropicState` 是重构残留 ⇒ 触发 TS6133 ✗）

		this._logService.info(`[BYOK:${this.id}] _streamChat: url=${url}, model=${modelId}, messages=${messages.length}`);

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

		// 编排（重试退避 → 读流 → 解析 → 收尾 done）下沉到 common 单一实现，
		// 与主进程路径共用；两端差异全部经 hooks 注入。
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), DEFAULT_STREAM_TIMEOUT_MS);

		try {
			yield* runChatStream(
				{
					url,
					apiKey,
					modelId,
					body,
					extraHeaders: idHeaders,
					signal: controller.signal,
					auth: this._definition.apiKeyHeader === 'x-api-key' ? 'x-api-key' : 'bearer',
					anthropicVersion: this._definition.anthropicVersion,
					parseMode: built.parseMode,
				},
				{
					// 直连侧传输：注入超时 signal 的裸 fetch（主进程侧另有 300s + 外部 signal 联动）。
					transport: request => fetch(request.url, {
						method: 'POST',
						headers: request.headers,
						body: request.body,
						signal: request.signal,
					}),
					log: (level, message) => this._logService[level](`[BYOK:${this.id}] _streamChat: ${message}`),
					onHealth: status => this._updateHealthStatus(status),
					onCacheHit: this._logCacheHit,
					errorPrefix: `${this.name}: `,
					onResponseBodyComplete: (chunks, completedModelId) => {
						void this._debugWriteResponse([...chunks], completedModelId);
					},
				},
			);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// ─── Extracted Helper Methods ─────────────────────────────────────

	/**
	 * 绑定本 provider 协议特征的请求构造器（实现见 `common/protocols/requestBuilder.ts`）。
	 *
	 * 每次现建而非缓存实例：`RequestBuilder` 无可变状态，构造成本可忽略，
	 * 而缓存会引入「definition 变了但 builder 没重建」的失效风险。
	 * `getModel` 传函数而非模型数组，使动态变更的 `_models` 每次查询都取最新。
	 */
	protected _requestBuilder(): IRequestBuilder {
		return createRequestBuilder(
			{
				responseFormat: this._definition.responseFormat,
				isAnthropic: this._definition.isAnthropic,
				getModel: modelId => this._models.find(m => m.id === modelId),
				// strict 工具模式：官方 OpenAI / Azure 端点自动开；其余 `undefined` ⇒ 由模型级
				// `capabilityConfig.strictToolSchema` 决定（详见 `_resolveStrictToolSchema`）。
				strictToolSchema: this._resolveStrictToolSchema(),
			},
			(level, message) => this._logService[level](message),
			this.id,
		);
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
	 * KV-cache 命中的日志回调，注入给 common 侧的 usage 解析。
	 *
	 * 箭头函数绑定实例：`extractUsage(parsed, cb)` 会以普通函数方式调用它，
	 * 传裸方法引用会丢失 `this`。
	 */
	private readonly _logCacheHit = (cachedTokens: number, inputTokens: number | undefined): void => {
		this._logService.info(`[BYOK:${this.id}] KV Cache hit: cached=${cachedTokens} / input=${inputTokens ?? '?'} tokens`);
	};

}

// ─── Anthropic native SSE parser ────────────────────────────────────────────
// AnthropicStreamState 定义在 ../common/llmBridge.js（renderer 与主进程共享）。


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
