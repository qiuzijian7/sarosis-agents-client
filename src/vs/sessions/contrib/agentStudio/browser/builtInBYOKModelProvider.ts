/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IModelProvider, IModelInfo, ModelAuthStatus,
	IModelOptions, IModelDelta, IChatMessage, IChatContext,
	ModelCapability,
} from '../common/providers.js';

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
	/** Whether an API key is required. Defaults to true. Set false for local providers like Ollama. */
	readonly requiresApiKey?: boolean;
}

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

	constructor(
		private readonly _definition: IBYOKProviderDefinition,
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
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
		return this._streamChat(modelId, messages, options);
	}

	// ─── Internal ─────────────────────────────────────────────

	private _getApiKey(): string {
		return (this._configurationService.getValue<string>(this._definition.apiKeyConfigKey) || '').trim();
	}

	private _getBaseUrl(): string {
		const configured = (this._configurationService.getValue<string>(this._definition.baseUrlConfigKey) || '').trim();
		return configured || this._definition.defaultBaseUrl;
	}

	private _getAuthHeaders(): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		const apiKey = this._getApiKey();
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
		return headers;
	}

	private _checkAuth(): void {
		const apiKey = this._getApiKey();
		const oldStatus = this._authStatus;
		const needsKey = this._definition.requiresApiKey !== false;

		if (needsKey && !apiKey) {
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

		if (!apiKey || !baseUrl) {
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
			const response = await fetch(modelsUrl, {
				method: 'GET',
				headers: this._getAuthHeaders(),
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
				.filter((m: any) => m.id)
				.slice(0, 200) // Cap to avoid huge lists
				.map((m: any) => ({
					id: m.id,
					name: m.name || m.id,
					description: m.description || undefined,
					contextWindow: m.context_length || m.context_window || undefined,
					capabilities: this._inferCapabilities(m),
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

		if (id.includes('vision') || desc.includes('vision') || desc.includes('image')) {
			caps.push(ModelCapability.Vision);
		}
		if (id.includes('code') || desc.includes('code') || desc.includes('coding')) {
			caps.push(ModelCapability.Code);
		}
		// Most modern models support function calling
		const supportedParams = m.supported_parameters || [];
		if (Array.isArray(supportedParams) && supportedParams.includes('tools')) {
			caps.push(ModelCapability.FunctionCalling);
		}
		return caps;
	}

	private async *_streamChat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
	): AsyncGenerator<IModelDelta> {
		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();

		if (!apiKey) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: API key not configured`);
			yield { type: 'error', error: `${this.name}: API key not configured` };
			return;
		}

		const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
		this._logService.info(`[BYOK:${this.id}] _streamChat: url=${url}, model=${modelId}, messages=${messages.length}`);

		const body: Record<string, unknown> = {
			model: modelId,
			messages: messages.map(m => ({ role: m.role, content: m.content })),
			stream: true,
		};
		if (options.temperature !== undefined) {
			body.temperature = options.temperature;
		}
		if (options.maxTokens !== undefined) {
			body.max_tokens = options.maxTokens;
		}
		if (options.tools && options.tools.length > 0) {
			body.tools = options.tools.map(t => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.inputSchema,
				},
			}));
		}

		let response: Response;
		try {
			this._logService.info(`[BYOK:${this.id}] _streamChat: sending fetch request...`);
			response = await fetch(url, {
				method: 'POST',
				headers: this._getAuthHeaders(),
				body: JSON.stringify(body),
			});
			this._logService.info(`[BYOK:${this.id}] _streamChat: response status=${response.status} ${response.statusText}`);
		} catch (err) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: fetch error:`, err);
			yield { type: 'error', error: `${this.name}: Network error — ${err}` };
			return;
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			this._logService.error(`[BYOK:${this.id}] _streamChat: HTTP error: ${response.status} — ${text.slice(0, 500)}`);
			yield { type: 'error', error: `${this.name}: ${response.status} ${response.statusText} — ${text.slice(0, 500)}` };
			return;
		}

		const reader = response.body?.getReader();
		if (!reader) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: No response body`);
			yield { type: 'error', error: `${this.name}: No response body` };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';
		let yieldCount = 0;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					this._logService.info(`[BYOK:${this.id}] _streamChat: reader done, total yields=${yieldCount}`);
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data: ')) { continue; }
					const data = trimmed.slice(6);
					if (data === '[DONE]') {
						this._logService.info(`[BYOK:${this.id}] _streamChat: received [DONE]`);
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta;
						if (!delta) {
							// Log if finish_reason is present (no delta but stream continues)
							const finishReason = parsed.choices?.[0]?.finish_reason;
							if (finishReason) {
								this._logService.info(`[BYOK:${this.id}] _streamChat: finish_reason=${finishReason}`);
							}
							continue;
						}

						if (delta.content) {
							yieldCount++;
							yield { type: 'text', content: delta.content };
						}
						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								if (tc.function) {
									yieldCount++;
									yield {
										type: 'tool_call',
										toolCall: {
											id: tc.id || '',
											name: tc.function.name || '',
											arguments: tc.function.arguments || '',
										},
									};
								}
							}
						}
					} catch {
						// Skip malformed JSON
					}
				}
			}
		} catch (streamErr) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: stream read error:`, streamErr);
			yield { type: 'error', error: `${this.name}: Stream error — ${streamErr}` };
		} finally {
			this._logService.info(`[BYOK:${this.id}] _streamChat: finally block, yielding done`);
			yield { type: 'done' };
		}
	}
}

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
			{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling] },
			{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling] },
			{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling] },
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
		staticModels: [
			{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling] },
			{ id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling] },
			{ id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.FunctionCalling] },
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
		id: 'custom',
		name: 'Custom',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
		defaultBaseUrl: '',
		priority: 50,
		modelsEndpointPath: 'models',
		openAICompatible: true,
	},
	{
		id: 'ollama',
		name: 'Ollama',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
		defaultBaseUrl: 'http://localhost:11434/v1',
		priority: 90,
		modelsEndpointPath: 'models',
		openAICompatible: true,
		requiresApiKey: false,
	},
];
