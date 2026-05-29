/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CodeBuddy Provider — VS Code chat model provider via CodeBuddy gateway.
 *
 * - Endpoint: copilot.tencent.com/v2/chat/completions
 * - Protocol: OpenAI Chat Completions API
 * - Auth: see auth.ts (cli-external-link + local_storage + apiKeyHelper)
 * - Models: Claude + GPT + Gemini + GLM/DeepSeek/Kimi/MiniMax/Hunyuan
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
	parseSSEStream,
	parseModelsConfig,
	createModelInfo,
	getModelTokenLimits,
	CODEBUDDY_DEFAULT_MODELS,
	CODEBUDDY_DEFAULT_MODEL_CONFIGS,
	IModelConfig,
	extractText,
	extractModelName,
	estimateTokenCount,
	separateSystemMessage,
	getExtensionVersion,
	fetchWithRetry,
} from '@sarosis/shared';
import { CodeBuddyAuth } from './auth';

/** Decode JWT payload (without verification) to extract claims */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) { return undefined; }
		const payload = parts[1];
		// Base64Url decode
		const padded = payload + '=='.slice(0, (4 - payload.length % 4) % 4);
		const decoded = Buffer.from(padded, 'base64').toString('utf8');
		return JSON.parse(decoded) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Extract tenant ID from JWT issuer (iss) */
function extractTenantIdFromIss(iss: string): string | undefined {
	// iss format: https://tencent.sso.codebuddy.cn/auth/realms/sso-<tenantId>
	const match = iss.match(/\/realms\/sso-([^/]+)$/);
	return match ? match[1] : undefined;
}

const VENDOR = 'codebuddy';
const EXTENSION_ID = 'sarosis.sarosis-codebuddy-provider';

/**
 * Load models from a model.json file.
 * @param filePath Path to the model.json file
 * @param extensionPath Extension path for resolving relative paths
 * @returns Array of IModelConfig or null if file cannot be read/parsed
 */
function loadModelsFromJsonFile(filePath: string, extensionPath?: string): IModelConfig[] | null {
	try {
		// Resolve path (support relative paths from workspace or extension directory)
		let resolvedPath = filePath;
		if (!path.isAbsolute(filePath)) {
			// Try to resolve relative to extension path first
			if (extensionPath) {
				const extensionRelativePath = path.join(extensionPath, filePath);
				if (fs.existsSync(extensionRelativePath)) {
					resolvedPath = extensionRelativePath;
				}
			}
			// If not found in extension path, try workspace
			if (resolvedPath === filePath) {
				const workspaceFolders = vscode.workspace.workspaceFolders;
				if (workspaceFolders && workspaceFolders.length > 0) {
					resolvedPath = path.join(workspaceFolders[0].uri.fsPath, filePath);
				} else if (!extensionPath) {
					console.warn(`[CodeBuddy] Cannot resolve relative path "${filePath}": no workspace folder open`);
					return null;
				}
			}
		}

		// Check if file exists
		if (!fs.existsSync(resolvedPath)) {
			console.warn(`[CodeBuddy] model.json file not found: ${resolvedPath}`);
			return null;
		}

		// Read and parse JSON file
		const fileContent = fs.readFileSync(resolvedPath, 'utf8');
		const jsonData = JSON.parse(fileContent);

		// Extract models array
		const models = jsonData.models;
		if (!Array.isArray(models)) {
			console.warn(`[CodeBuddy] model.json file does not contain a "models" array`);
			return null;
		}

		// Convert each model to IModelConfig
		const modelConfigs: IModelConfig[] = models.map((model: any) => {
			// Extract all fields with defaults
			const id = model.id || '';
			const name = model.name || id;
			const vendor = model.vendor || '';
			const maxOutputTokens = model.maxOutputTokens || getModelTokenLimits(model.id || '').maxOutputTokens;
			const maxInputTokens = model.maxInputTokens || 128000;
			const supportsToolCall = model.supportsToolCall !== undefined ? model.supportsToolCall : true;
			const supportsImages = model.supportsImages !== undefined ? model.supportsImages : false;
			const disabledMultimodal = model.disabledMultimodal !== undefined ? model.disabledMultimodal : false;
			const maxAllowedSize = model.maxAllowedSize || model.maxInputTokens || 128000;
			const temperature = model.temperature !== undefined ? model.temperature : 1;
			const supportsReasoning = model.supportsReasoning !== undefined ? model.supportsReasoning : false;
			const reasoning = model.reasoning || null;
			const onlyReasoning = model.onlyReasoning !== undefined ? model.onlyReasoning : false;
			const descriptionEn = model.descriptionEn || '';
			const descriptionZh = model.descriptionZh || '';
			const credits = model.credits || '';
			const relatedModels = model.relatedModels || null;
			const tags = model.tags || [];
			const top_p = model.top_p !== undefined ? model.top_p : undefined;
			const top_k = model.top_k !== undefined ? model.top_k : undefined;
			const repetition_penalty = model.repetition_penalty !== undefined ? model.repetition_penalty : undefined;
			const isDefault = model.isDefault !== undefined ? model.isDefault : false;
			const supportsExtra = model.supportsExtra !== undefined ? model.supportsExtra : false;

			return {
				id,
				name,
				vendor,
				maxOutputTokens,
				maxInputTokens,
				supportsToolCall,
				supportsImages,
				disabledMultimodal,
				maxAllowedSize,
				temperature,
				supportsReasoning,
				reasoning,
				onlyReasoning,
				descriptionEn,
				descriptionZh,
				credits,
				relatedModels,
				tags,
				top_p,
				top_k,
				repetition_penalty,
				isDefault,
				supportsExtra,
			};
		}).filter((config: IModelConfig) => config.id !== '');

		console.log(`[CodeBuddy] Loaded ${modelConfigs.length} models from ${resolvedPath}:`, modelConfigs.map(m => m.id));
		return modelConfigs;
	} catch (error) {
		console.error(`[CodeBuddy] Error loading model.json file: ${error}`);
		console.error(`[CodeBuddy] Stack trace:`, error instanceof Error ? error.stack : '');
		return null;
	}
}

/**
 * Load models from codebuddy.models configuration.
 * Supports both old format (string) and new format (IModelConfig[]).
 */
async function loadModelsFromConfig(config: vscode.WorkspaceConfiguration): Promise<IModelConfig[]> {
	// Migration: support both old format (string) and new format (IModelConfig[])
	let modelConfigs: IModelConfig[];
	const rawModelsConfig = config.get('models');
	
	if (Array.isArray(rawModelsConfig)) {
		// New format: array of IModelConfig
		modelConfigs = rawModelsConfig.length > 0 ? rawModelsConfig : CODEBUDDY_DEFAULT_MODEL_CONFIGS;
	} else if (typeof rawModelsConfig === 'string' && rawModelsConfig.trim()) {
		// Old format: comma-separated string - migrate to new format
		const modelNames = rawModelsConfig.split(',').map(m => m.trim()).filter(m => m.length > 0);
		modelConfigs = modelNames.map(name => {
			const tokenLimits = getModelTokenLimits(name);
			return {
				id: name,
				name: name,
				maxInputTokens: tokenLimits.maxInputTokens,
				maxAllowedSize: tokenLimits.maxAllowedSize || tokenLimits.maxInputTokens
			};
		});
		// Auto-migrate: save in new format
		await config.update('models', modelConfigs, vscode.ConfigurationTarget.Global);
	} else {
		// No config or empty - use defaults
		modelConfigs = CODEBUDDY_DEFAULT_MODEL_CONFIGS;
	}
	
	return modelConfigs;
}

/**
 * CodeBuddy Chat Provider implementation
 */
class CodeBuddyChatProvider implements vscode.LanguageModelChatProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
	private readonly _context: vscode.ExtensionContext;

	constructor(
		private readonly _auth: CodeBuddyAuth,
		context: vscode.ExtensionContext,
	) {
		this._context = context;
		// Forward auth state changes to model list changes
		this._auth.onDidChange(() => this._onDidChange.fire());
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	notifyModelsChanged(): void {
		this._onDidChange.fire();
	}

	// ---- Model provider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		// Fast path: check auth status before calling getAccessToken() to avoid spamming logs
		if (this._auth.authStatus === 'logged-out') {
			return [];
		}
		const hasCodeBuddy = !!await this._auth.getAccessToken();
		if (!hasCodeBuddy) {
			return [];
		}

		const config = vscode.workspace.getConfiguration('codebuddy');
		
		// Try to load models from model.json file first
		let modelConfigs: IModelConfig[];
		let modelJsonPath = config.get<string>('modelJsonPath');
		
		// If modelJsonPath is not configured (empty), try to load from default model.json in extension directory
		if (!modelJsonPath || !modelJsonPath.trim()) {
			const defaultModelJsonPath = path.join(this._context.extensionPath, 'model.json');
			if (fs.existsSync(defaultModelJsonPath)) {
				modelJsonPath = defaultModelJsonPath;
				console.log(`[CodeBuddy] Using default model.json from extension directory: ${defaultModelJsonPath}`);
			}
		}
		
		if (modelJsonPath && modelJsonPath.trim()) {
			// Try to load from model.json file
			const jsonModelConfigs = loadModelsFromJsonFile(modelJsonPath.trim(), this._context.extensionPath);
			if (jsonModelConfigs && jsonModelConfigs.length > 0) {
				modelConfigs = jsonModelConfigs;
				console.log(`[CodeBuddy] Using models from model.json file: ${modelJsonPath}, total ${modelConfigs.length} models`);
			} else {
				// Fallback to models config
				console.log(`[CodeBuddy] model.json loading failed or returned empty, falling back to models config`);
				modelConfigs = await loadModelsFromConfig(config);
			}
		} else {
			// No modelJsonPath configured and no default model.json, use models config
			console.log(`[CodeBuddy] No modelJsonPath configured and no default model.json found, using models config`);
			modelConfigs = await loadModelsFromConfig(config);
		}

		console.log(`[CodeBuddy] provideLanguageModelChatInformation returning ${modelConfigs.length} models:`, modelConfigs.map(m => m.id));

		return modelConfigs.map(modelConfig =>
			createModelInfo(
				modelConfig.id,
				VENDOR,
				VENDOR,
				`CodeBuddy - ${modelConfig.name}`,
				{
					maxInputTokens: modelConfig.maxInputTokens,
					maxOutputTokens: modelConfig.maxOutputTokens || getModelTokenLimits(modelConfig.id).maxOutputTokens,
					maxAllowedSize: modelConfig.maxAllowedSize
				}
			),
		);
	}

	// ---- Chat response: OpenAI Chat Completions API ----

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		cancellationToken: vscode.CancellationToken,
	): Promise<void> {
		const selectedModel = extractModelName(model.id, VENDOR);
		const accessToken = await this._auth.getAccessToken();
		if (!accessToken) {
			throw new Error('CodeBuddy 未登录。请先运行 CodeBuddy: Login 命令登录，或设置 CODEBUDDY_AUTH_TOKEN 环境变量。');
		}

		// Trim token to avoid format issues (e.g., newline characters)
		const trimmedToken = accessToken.trim();

		// Debug: log token info (first 10 chars + length)
		console.log(`[CodeBuddy] Sending request with token: length=${trimmedToken.length}, prefix=${trimmedToken.substring(0, 10)}...`);

		return this._sendCodeBuddyRequest(trimmedToken, selectedModel, messages, progress, cancellationToken);
	}

	private async _sendCodeBuddyRequest(
		accessToken: string,
		selectedModel: string,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		cancellationToken: vscode.CancellationToken,
	): Promise<void> {
		const config = vscode.workspace.getConfiguration('codebuddy');
		const serverUrl = config.get<string>('endpoint') || 'https://copilot.tencent.com';
		const url = `${serverUrl}/v2/chat/completions`;

		// Convert messages to OpenAI format
		const { systemText, conversationMessages } = separateSystemMessage(messages);
		const apiMessages = conversationMessages.map(msg => ({
			role: msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' as const : 'user' as const,
			content: extractText(msg),
		}));

		const body = JSON.stringify({
			model: selectedModel,
			messages: [
				...(systemText ? [{ role: 'system', content: systemText }] : []),
				...apiMessages,
			],
			stream: true,
			temperature: 1,
			max_tokens: 48_000,
		});

		const conversationId = crypto.randomUUID();
		const requestId = crypto.randomUUID();

		// Decode JWT to get user/tenant info (per CodeBuddy IDE CN headers)
		const jwtPayload = decodeJwtPayload(accessToken);
		const userId = (jwtPayload?.sub as string) || '';
		const tenantId = jwtPayload?.iss ? extractTenantIdFromIss(jwtPayload.iss as string) : undefined;
		const extensionVersion = getExtensionVersion(EXTENSION_ID);

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream',
			'Authorization': `Bearer ${accessToken}`,
			// Note: CodeBuddy IDE CN does NOT send X-API-Key header (per packet capture)
			// Only send Authorization Bearer token
			'X-Conversation-Id': conversationId,
			'X-Conversation-Request-Id': crypto.randomUUID(),
			'X-Conversation-Message-Id': crypto.randomUUID(),
			'X-Request-Id': requestId,
			'X-Model-ID': selectedModel,
			'X-Agent-Intent': 'craft',
			'X-IDE-Type': 'CodeBuddyIDE',
			'X-IDE-Name': 'CodeBuddyIDE',
			'X-IDE-Version': extensionVersion,
			'X-Product-Version': extensionVersion,
			'X-Domain': 'tencent.sso.codebuddy.cn',
			'X-Product': 'SaaS',
			'X-Env-ID': 'production',
			'X-User-Id': userId,
			'X-Enterprise-Id': tenantId || '',
			'X-Tenant-Id': tenantId || '',
			'User-Agent': `CodeBuddyIDE/${extensionVersion} CodeBuddy/${extensionVersion}`,
		};

		// Debug: log complete HTTP request
		const debugHeaders = { ...headers };
		debugHeaders['Authorization'] = `Bearer ${accessToken.substring(0, 20)}...[${accessToken.length}chars]`;
		// Note: X-API-Key header removed (CodeBuddy IDE CN doesn't send it)

		console.log(`\n========== [CodeBuddy] HTTP REQUEST DEBUG ==========`);
		console.log(`[CodeBuddy] URL: ${url}`);
		console.log(`[CodeBuddy] Method: POST`);
		console.log(`[CodeBuddy] Headers:`, JSON.stringify(debugHeaders, null, 2));
		console.log(`[CodeBuddy] Body length: ${body.length} chars`);
		console.log(`[CodeBuddy] Body preview: ${body.substring(0, 500)}...`);
		console.log(`========== END REQUEST DEBUG ==========\n`);

		const controller = new AbortController();
		cancellationToken.onCancellationRequested(() => controller.abort());

		const response = await fetchWithRetry(url, {
			method: 'POST',
			headers,
			body,
			signal: controller.signal,
		});

		// Parse OpenAI SSE stream
		return parseSSEStream(response, progress, cancellationToken, (event) => {
			// OpenAI: choices[0].delta.content
			if (event.choices && event.choices[0]) {
				const choice = event.choices[0];
				if (choice.delta && choice.delta.content) {
					return { text: choice.delta.content };
				}
			}
			return null;
		}, '[CodeBuddy]');
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokenCount(text);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const auth = new CodeBuddyAuth(context.globalState);
	context.subscriptions.push(auth);

	const provider = new CodeBuddyChatProvider(auth, context);
	context.subscriptions.push(provider);

	const registration = vscode.lm.registerLanguageModelChatProvider(VENDOR, provider);
	context.subscriptions.push(registration);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('codebuddy')) {
				provider.notifyModelsChanged();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('codebuddy.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('codebuddy.refreshModels', () => {
			provider.notifyModelsChanged();
			void vscode.window.showInformationMessage('CodeBuddy model list refreshed.');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('codebuddy.login', async () => {
			await auth.login();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('codebuddy.logout', async () => {
			await auth.logout();
		}),
	);

	provider.notifyModelsChanged();
	console.log(`[CodeBuddy] activate() — registered chat provider, vendor='${VENDOR}'`);
}

export function deactivate(): void {
	// Cleanup if needed
}
