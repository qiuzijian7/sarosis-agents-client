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
	/** Optional: if true, the provider can work without an API key (e.g. Ollama local) */
	readonly apiKeyOptional?: boolean;
	/** Optional: chat completions endpoint path (default: 'chat/completions'). E.g. Ollama uses 'v1/chat/completions'. */
	readonly chatEndpointPath?: string;
	/**
	 * Optional: if true, this provider targets the native Anthropic Messages API (not OpenAI-compatible).
	 * When set, cache_control will be injected into system messages to enable Prompt Caching (KV Cache).
	 */
	readonly isAnthropic?: boolean;
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

		if (!this._definition.apiKeyOptional && !apiKey) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: API key not configured`);
			yield { type: 'error', error: `${this.name}: API key not configured` };
			return;
		}

		const chatPath = this._definition.chatEndpointPath || 'chat/completions';
		const url = `${baseUrl.replace(/\/+$/, '')}/${chatPath.replace(/^\/+/, '')}`;

		this._logService.info(`[BYOK:${this.id}] _streamChat: url=${url}, model=${modelId}, messages=${messages.length}`);

		const body: Record<string, unknown> = {
			model: modelId,
			messages: messages.map((m, idx) => {
				const base: Record<string, unknown> = { role: m.role, content: m.content };
				if (m.role === 'tool' && (m as any).toolCallId) {
					base.tool_call_id = (m as any).toolCallId;
				}
				if (m.role === 'assistant' && (m as any).toolCalls) {
					base.tool_calls = (m as any).toolCalls.map((tc: any) => ({
						id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						type: 'function',
						function: {
							name: tc.name,
							arguments: tc.arguments || '{}',
						},
					}));
				}
				// ── KV Cache: Anthropic Prompt Caching ──────────────────────────
				// Inject cache_control on the last system message to mark everything
				// up to (and including) that point as a cacheable prefix.
				// This covers: base system prompt + workspace context + skills directory.
				if (this._definition.isAnthropic && m.role === 'system') {
					// Find the index of the last system message
					const lastSystemIdx = messages.reduce(
						(last, msg, i) => (msg.role === 'system' ? i : last),
						-1,
					);
					if (idx === lastSystemIdx) {
						base.cache_control = { type: 'ephemeral' };
					}
				}
				return base;
			}),
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
			// 鼓励模型在需要时主动使用工具
			body.tool_choice = 'auto';
			this._logService.info(`[BYOK:${this.id}] _streamChat: sending ${options.tools.length} tools with tool_choice=auto`);
		}

		let response: Response;
		try {
			this._logService.info(`[BYOK:${this.id}] _streamChat: sending fetch request...`);
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}
			// Use a generous timeout for local models (5 minutes) — they can be slow
			// on large prompts with many tools
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
		let sseDataFound = false;
		let fullBodyForFallback = '';
		let chunkCount = 0;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					this._logService.info(`[BYOK:${this.id}] _streamChat: reader done, total yields=${yieldCount}, sseFound=${sseDataFound}, chunks=${chunkCount}`);
					break;
				}

				const chunk = decoder.decode(value, { stream: true });
				chunkCount++;
				// Log first 3 chunks for debugging format
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

					// Determine the JSON payload from this line
					let jsonPayload: string | null = null;

					if (trimmed.startsWith('data:')) {
						// SSE format: "data: {...}" or "data:{...}"
						jsonPayload = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
						if (jsonPayload === '[DONE]') {
							sseDataFound = true;
							this._logService.info(`[BYOK:${this.id}] _streamChat: received [DONE]`);
							continue;
						}
					} else if (trimmed.startsWith('{')) {
						// NDJSON format: bare JSON objects (one per line)
						jsonPayload = trimmed;
					} else {
						// Skip unrecognized lines (e.g. "event:" or empty SSE comments)
						continue;
					}

					try {
						const parsed = JSON.parse(jsonPayload);
						sseDataFound = true;

						// ── KV Cache: Extract token usage ──────────────────────────────
						// OpenAI: usage.prompt_tokens_details.cached_tokens
						// DeepSeek: usage.prompt_tokens_details.cached_tokens
						// Anthropic (via proxy): usage.cache_read_input_tokens
						if (parsed.usage) {
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
								yieldCount++;
								yield {
									type: 'usage',
									usage: {
										inputTokens,
										outputTokens,
										cachedTokens,
										cacheWriteTokens,
									},
								};
								if (cachedTokens !== undefined) {
									this._logService.info(`[BYOK:${this.id}] KV Cache hit: cached=${cachedTokens} / input=${inputTokens ?? '?'} tokens`);
								}
							}
						}

						// Handle both streaming delta format and non-streaming message format
						const delta = parsed.choices?.[0]?.delta;
						const message = parsed.choices?.[0]?.message;
						const content = delta || message;

						if (!content) {
							const finishReason = parsed.choices?.[0]?.finish_reason;
							if (finishReason) {
								this._logService.info(`[BYOK:${this.id}] _streamChat: finish_reason=${finishReason}`);
							}
							continue;
						}

						// Handle reasoning/thinking content
						// Some models (e.g. qwen via Ollama) wrap thinking in <think>...</think> tags inside content
						let reasoningContent = content.reasoning_content ?? content.thinking ?? content.reasoning;
						let actualContent = content.content;

						// Parse <think> tags from content (DeepSeek/QwQ/qwen style via Ollama)
						if (actualContent && typeof actualContent === 'string') {
							const thinkMatch = /<(think|thinking)>([\s\S]*?)<\/\1>/i.exec(actualContent);
							if (thinkMatch) {
								reasoningContent = reasoningContent || thinkMatch[2].trim();
								actualContent = actualContent.replace(thinkMatch[0], '').trim();
							}
						}

						if (reasoningContent) {
							yieldCount++;
							yield { type: 'thinking', content: reasoningContent };
						}

						if (actualContent) {
							yieldCount++;
							yield { type: 'text', content: actualContent };
						}

						// Handle tool calls — support multiple formats:
						// 1. OpenAI standard: tool_calls[].function.{name, arguments}
						// 2. Anthropic via proxy: tool_calls[].{name, input/arguments}
						// 3. Some proxies: tool_calls[].{id, name, arguments} (flat)
						if (content.tool_calls) {
							for (const tc of content.tool_calls) {
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
									// Arguments can be in: arguments, input, args
									const rawArgs = tc.arguments ?? tc.input ?? tc.args;
									toolArgs = typeof rawArgs === 'string' ? rawArgs
										: typeof rawArgs === 'object' ? JSON.stringify(rawArgs)
										: '';
									// Anthropic uses tool_use_id
									if (!toolId) { toolId = tc.tool_use_id || tc.toolUseId || ''; }
								}

								if (toolName || toolArgs) {
									yieldCount++;
									yield {
										type: 'tool_call',
										toolCall: { id: toolId, name: toolName, arguments: toolArgs },
									};
								}
							}
						}
					} catch {
						this._logService.warn(`[BYOK:${this.id}] _streamChat: malformed JSON line: ${jsonPayload.slice(0, 200)}`);
					}
				}
			}

			// Process remaining buffer
			if (buffer.trim()) {
				const trimmed = buffer.trim();
				let jsonPayload: string | null = null;
				if (trimmed.startsWith('data:')) {
					jsonPayload = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
				} else if (trimmed.startsWith('{')) {
					jsonPayload = trimmed;
				}
				if (jsonPayload && jsonPayload !== '[DONE]') {
					try {
						const parsed = JSON.parse(jsonPayload);
						sseDataFound = true;
						const content = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
						let reasoningContent = content?.reasoning_content ?? content?.thinking ?? content?.reasoning;
						let actualContent = content?.content;
						if (actualContent && typeof actualContent === 'string') {
							const thinkMatch = /<(think|thinking)>([\s\S]*?)<\/\1>/i.exec(actualContent);
							if (thinkMatch) {
								reasoningContent = reasoningContent || thinkMatch[2].trim();
								actualContent = actualContent.replace(thinkMatch[0], '').trim();
							}
						}
						if (actualContent) {
							yieldCount++;
							yield { type: 'text', content: actualContent };
						}
						if (reasoningContent) {
							yieldCount++;
							yield { type: 'thinking', content: reasoningContent };
						}
						if (content?.tool_calls) {
							for (const tc of content.tool_calls) {
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
								if (toolName || toolArgs) {
									yieldCount++;
									yield {
										type: 'tool_call',
										toolCall: { id: toolId, name: toolName, arguments: toolArgs },
									};
								}
							}
						}
					} catch {
						// Ignore trailing partial
					}
				}
			}

			// Fallback: if no SSE/NDJSON data was found, try to parse the entire body as a single JSON response
			if (!sseDataFound && fullBodyForFallback.trim()) {
				this._logService.info(`[BYOK:${this.id}] _streamChat: no streaming data found, trying full JSON fallback (bodyLen=${fullBodyForFallback.length})`);
				try {
					const parsed = JSON.parse(fullBodyForFallback);
					// ── KV Cache: Extract usage from non-streaming response ──────────
					if (parsed.usage) {
						const u = parsed.usage;
						const cachedTokens =
							u.prompt_tokens_details?.cached_tokens ??
							u.cache_read_input_tokens ??
							undefined;
						const cacheWriteTokens = u.cache_creation_input_tokens ?? undefined;
						const inputTokens = u.prompt_tokens ?? u.input_tokens ?? undefined;
						const outputTokens = u.completion_tokens ?? u.output_tokens ?? undefined;
						if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined || cacheWriteTokens !== undefined) {
							yieldCount++;
							yield {
								type: 'usage',
								usage: { inputTokens, outputTokens, cachedTokens, cacheWriteTokens },
							};
							if (cachedTokens !== undefined) {
								this._logService.info(`[BYOK:${this.id}] KV Cache hit (fallback): cached=${cachedTokens} / input=${inputTokens ?? '?'} tokens`);
							}
						}
					}
					const message = parsed.choices?.[0]?.message;
					if (message) {
						let reasoningContent = message.reasoning_content ?? message.thinking;
						let actualContent = message.content;
						if (actualContent && typeof actualContent === 'string') {
							const thinkMatch = /<(think|thinking)>([\s\S]*?)<\/\1>/i.exec(actualContent);
							if (thinkMatch) {
								reasoningContent = reasoningContent || thinkMatch[2].trim();
								actualContent = actualContent.replace(thinkMatch[0], '').trim();
							}
						}
						if (reasoningContent) {
							yieldCount++;
							yield { type: 'thinking', content: reasoningContent };
						}
						if (actualContent) {
							yieldCount++;
							yield { type: 'text', content: actualContent };
						}
						if (message.tool_calls) {
							for (const tc of message.tool_calls) {
								if (tc.function) {
									yieldCount++;
									yield {
										type: 'tool_call',
										toolCall: {
											id: tc.id || '',
											name: tc.function.name || '',
											arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}),
										},
									};
								}
							}
						}
					}
				} catch (parseErr) {
					this._logService.warn(`[BYOK:${this.id}] _streamChat: JSON fallback parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
					// Last resort: if it looks like plain text content, yield it
					const rawTrimmed = fullBodyForFallback.trim();
					if (rawTrimmed.length > 0 && rawTrimmed.length < 100000 && !rawTrimmed.startsWith('<')) {
						yieldCount++;
						yield { type: 'text', content: rawTrimmed };
					}
				}
			}
		} catch (streamErr) {
			this._logService.error(`[BYOK:${this.id}] _streamChat: stream read error:`, streamErr);
			yield { type: 'error', error: `${this.name}: Stream error — ${streamErr}` };
		} finally {
			this._logService.info(`[BYOK:${this.id}] _streamChat: finally block, yielding done (yields=${yieldCount})`);
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
		isAnthropic: true,
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
