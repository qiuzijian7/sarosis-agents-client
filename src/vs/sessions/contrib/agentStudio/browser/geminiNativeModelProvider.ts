/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gemini Native Model Provider
 *
 * 使用 Google GenAI SDK 的 generateContentStream API 直接调用 Gemini 模型，
 * 而非通过 OpenAI 兼容 API 代理。
 *
 * 优势：
 * - 原生支持 functionCall 格式（无需 OpenAI 兼容转换）
 * - 原生支持 systemInstruction（而非 role: 'system'）
 * - 原生支持 thinkingConfig（推理能力配置）
 * - 更好的错误信息和类型安全
 *
 * 参考 Void 项目的 sendGeminiChat 实现。
 *
 * 使用方式：
 *   在 agentStudio.contribution.ts 中注册：
 *   agentOS.registerModelProvider(new GeminiNativeModelProvider(configService, logService));
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IModelProvider, IModelInfo, ModelAuthStatus,
	IModelOptions, IModelDelta, IChatMessage, IChatContext,
	ModelCapability,
} from '../common/providers.js';
import { MessageFormatConverter } from '../common/adapters/messageFormatConverter.js';

// ─── Gemini API Types ──────────────────────────────────────────────────────

/**
 * Gemini REST API 内容格式。
 * 参考 https://ai.google.dev/api/generate-content
 */

interface GeminiContent {
	readonly role: 'user' | 'model';
	readonly parts: GeminiPart[];
}

type GeminiPart =
	| { readonly text: string }
	| { readonly functionCall: { readonly name: string; readonly args: Record<string, unknown> } }
	| { readonly functionResponse: { readonly name: string; readonly response: { readonly output: string } } };

interface GeminiTool {
	readonly functionDeclarations: Array<{
		readonly name: string;
		readonly description: string;
		readonly parameters?: {
			readonly type: string;
			readonly properties?: Record<string, unknown>;
			readonly required?: string[];
		};
	}>;
}

// ─── Gemini Static Models ──────────────────────────────────────────────────

const GEMINI_STATIC_MODELS: IModelInfo[] = [
	{
		id: 'gemini-2.5-pro',
		name: 'Gemini 2.5 Pro',
		contextWindow: 1048576,
		maxInputTokens: 1048576,
		maxOutputTokens: 65536,
		capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling],
		supportsToolCall: true,
		supportsReasoning: true,
		capabilityConfig: {
			supportsSystemMessage: 'separated',
			specialToolFormat: 'gemini-style',
			reasoningType: 'budget-slider',
			supportsCaching: false,
			supportsFIM: false,
			reservedOutputTokenSpace: null,
		},
	},
	{
		id: 'gemini-2.5-flash',
		name: 'Gemini 2.5 Flash',
		contextWindow: 1048576,
		maxInputTokens: 1048576,
		maxOutputTokens: 65536,
		capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling],
		supportsToolCall: true,
		supportsReasoning: true,
		capabilityConfig: {
			supportsSystemMessage: 'separated',
			specialToolFormat: 'gemini-style',
			reasoningType: 'budget-slider',
			supportsCaching: false,
			supportsFIM: false,
			reservedOutputTokenSpace: null,
		},
	},
	{
		id: 'gemini-2.0-flash',
		name: 'Gemini 2.0 Flash',
		contextWindow: 1048576,
		maxInputTokens: 1048576,
		maxOutputTokens: 8192,
		capabilities: [ModelCapability.Chat, ModelCapability.Code, ModelCapability.Vision, ModelCapability.FunctionCalling],
		supportsToolCall: true,
		capabilityConfig: {
			supportsSystemMessage: 'separated',
			specialToolFormat: 'gemini-style',
			supportsCaching: false,
			supportsFIM: false,
			reservedOutputTokenSpace: null,
		},
	},
];

// ─── Configuration Keys ────────────────────────────────────────────────────

const GEMINI_API_KEY_CONFIG = 'sessions.agentStudio.provider.gemini.apiKey';
const GEMINI_BASE_URL_CONFIG = 'sessions.agentStudio.provider.gemini.baseUrl';
const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

// ─── Gemini Native Model Provider ──────────────────────────────────────────

export class GeminiNativeModelProvider extends Disposable implements IModelProvider {

	readonly id = 'gemini-native';
	readonly name = 'Gemini (Native)';
	readonly priority = 76; // Slightly higher than BYOK Gemini (75)

	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ModelAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ModelAuthStatus> = this._onDidChangeAuthStatus.event;

	private _authStatus: ModelAuthStatus = ModelAuthStatus.NotConfigured;

	constructor(
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
	) {
		super();

		this._checkAuth();

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(GEMINI_API_KEY_CONFIG) || e.affectsConfiguration(GEMINI_BASE_URL_CONFIG)) {
				this._logService.info('[GeminiNative] Configuration changed, re-checking auth');
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
		return [...GEMINI_STATIC_MODELS];
	}

	chat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncIterable<IModelDelta> {
		return this._streamChat(modelId, messages, options);
	}

	// ─── Internal ──────────────────────────────────────────────────

	private _getApiKey(): string {
		return (this._configurationService.getValue<string>(GEMINI_API_KEY_CONFIG) || '').trim();
	}

	private _getBaseUrl(): string {
		const configured = (this._configurationService.getValue<string>(GEMINI_BASE_URL_CONFIG) || '').trim();
		return configured || GEMINI_DEFAULT_BASE_URL;
	}

	private _checkAuth(): void {
		const apiKey = this._getApiKey();
		const oldStatus = this._authStatus;

		if (!apiKey) {
			this._authStatus = ModelAuthStatus.NotConfigured;
		} else {
			this._authStatus = ModelAuthStatus.Authenticated;
		}

		if (oldStatus !== this._authStatus) {
			this._logService.info(`[GeminiNative] Auth status: ${oldStatus} → ${this._authStatus}`);
			this._onDidChangeAuthStatus.fire(this._authStatus);
			this._onDidChangeModels.fire();
		}
	}

	private async *_streamChat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
	): AsyncGenerator<IModelDelta> {
		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();

		if (!apiKey) {
			yield { type: 'error', error: 'Gemini: API key not configured' };
			return;
		}

		// ── Build request ──────────────────────────────────────────────
		// Use MessageFormatConverter for format conversion
		const { contents, systemInstruction } = MessageFormatConverter.toGemini(
			messages,
			{ systemPrompt: options.systemPrompt },
		);

		const request: {
			model: string;
			contents: GeminiContent[];
			systemInstruction?: { parts: GeminiPart[] };
			tools?: GeminiTool[];
			generationConfig?: {
				temperature?: number;
				maxOutputTokens?: number;
				thinkingConfig?: {
					thinkingBudget?: number;
				};
			};
		} = {
			model: modelId,
			contents: contents.map(c => ({
				role: c.role,
				parts: c.parts,
			})) as GeminiContent[],
		};

		if (systemInstruction) {
			request.systemInstruction = { parts: [{ text: systemInstruction }] };
		}

		// Tools
		if (options.tools && options.tools.length > 0) {
			request.tools = [{
				functionDeclarations: options.tools.map(t => ({
					name: t.name,
					description: t.description,
					parameters: {
						type: 'OBJECT',
						properties: (t.inputSchema.properties || {}) as Record<string, unknown>,
						required: (t.inputSchema.required as string[]) || [],
					},
				})),
			}];
			this._logService.info(`[GeminiNative] _streamChat: sending ${options.tools.length} tools`);
		}

		// Generation config
		const generationConfig: NonNullable<typeof request.generationConfig> = {};
		if (options.temperature !== undefined) {
			generationConfig.temperature = options.temperature;
		}
		if (options.maxTokens !== undefined) {
			generationConfig.maxOutputTokens = options.maxTokens;
		}
		if (Object.keys(generationConfig).length > 0) {
			request.generationConfig = generationConfig;
		}

		// ── Send request ───────────────────────────────────────────────
		// Gemini REST API: POST /v1beta/models/{model}:streamGenerateContent?alt=sse&key={apiKey}
		const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;

		this._logService.info(`[GeminiNative] _streamChat: url=${url.replace(apiKey, '***')}, model=${modelId}, messages=${messages.length}`);

		let response: Response;
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 300_000);
			try {
				response = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(request),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (err) {
			this._logService.error(`[GeminiNative] _streamChat: fetch error:`, err);
			yield { type: 'error', error: `Gemini: Network error — ${err}` };
			return;
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			this._logService.error(`[GeminiNative] _streamChat: HTTP error: ${response.status} — ${text.slice(0, 500)}`);
			yield { type: 'error', error: `Gemini: ${response.status} ${response.statusText} — ${text.slice(0, 500)}` };
			return;
		}

		// ── Parse SSE stream ───────────────────────────────────────────
		const reader = response.body?.getReader();
		if (!reader) {
			yield { type: 'error', error: 'Gemini: No response body' };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';
		let yieldCount = 0;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) { continue; }

					const jsonPayload = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
					if (!jsonPayload || jsonPayload === '[DONE]') { continue; }

					try {
						const parsed = JSON.parse(jsonPayload);

						// Extract candidates
						const candidates = parsed.candidates || [];
						for (const candidate of candidates) {
							const parts = candidate.content?.parts || [];

							for (const part of parts) {
								// Text content
								if ('text' in part && part.text) {
									yieldCount++;
									yield { type: 'text', content: part.text };
								}

								// Function call
								if ('functionCall' in part && part.functionCall) {
									yieldCount++;
									yield {
										type: 'tool_call',
										toolCall: {
											id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
											name: part.functionCall.name,
											arguments: JSON.stringify(part.functionCall.args || {}),
										},
									};
								}
							}
						}

						// Usage metadata
						if (parsed.usageMetadata) {
							const u = parsed.usageMetadata;
							yieldCount++;
							yield {
								type: 'usage',
								usage: {
									inputTokens: u.promptTokenCount,
									outputTokens: u.candidatesTokenCount,
									cachedTokens: u.cachedContentTokenCount,
								},
							};
						}
					} catch {
						this._logService.warn(`[GeminiNative] _streamChat: malformed JSON: ${jsonPayload.slice(0, 200)}`);
					}
				}
			}
		} catch (streamErr) {
			this._logService.error(`[GeminiNative] _streamChat: stream read error:`, streamErr);
			yield { type: 'error', error: `Gemini: Stream error — ${streamErr}` };
		} finally {
			this._logService.info(`[GeminiNative] _streamChat: done (yields=${yieldCount})`);
			yield { type: 'done' };
		}
	}
}
