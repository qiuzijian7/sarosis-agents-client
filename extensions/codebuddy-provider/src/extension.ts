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
	extractMessageContent,
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

/** IDE identity headers values (mirrors CodeBuddy IDE CN packet capture) */
const IDE_TYPE = 'VSCode';
const IDE_NAME = 'VSCode';
const IDE_VERSION = '1.122.0';
const PRODUCT_VERSION = '4.3.20019762';

/**
 * Build the common CodeBuddy identity headers shared by all authenticated
 * endpoints (/v3/config, /v2/chat/completions). The caller adds endpoint
 * specific headers (e.g. Accept, X-Conversation-* for chat).
 */
function buildCodeBuddyIdentityHeaders(accessToken: string): Record<string, string> {
	const jwtPayload = decodeJwtPayload(accessToken);
	const userId = (jwtPayload?.sub as string) || '';
	const tenantId = jwtPayload?.iss ? extractTenantIdFromIss(jwtPayload.iss as string) : undefined;

	return {
		'Authorization': `Bearer ${accessToken}`,
		'X-IDE-Type': IDE_TYPE,
		'X-IDE-Name': IDE_NAME,
		'X-IDE-Version': IDE_VERSION,
		'X-Product-Version': PRODUCT_VERSION,
		'X-Env-ID': 'production',
		'X-User-Id': userId,
		'X-Enterprise-Id': tenantId || '',
		'X-Tenant-Id': tenantId || '',
		'X-Domain': 'tencent.sso.codebuddy.cn',
		'X-Product': 'SaaS',
		'User-Agent': `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${PRODUCT_VERSION}`,
	};
}

/**
 * Map a raw model entry (from model.json or /v3/config `data.models`) into an
 * IModelConfig. The two sources share an identical field shape, so this is the
 * single canonical mapping used by both code paths.
 */
function mapRawModelToConfig(model: any): IModelConfig {
	const id = model.id || '';
	return {
		id,
		name: model.name || id,
		vendor: model.vendor || '',
		maxOutputTokens: model.maxOutputTokens || getModelTokenLimits(id).maxOutputTokens,
		maxInputTokens: model.maxInputTokens || 128000,
		supportsToolCall: model.supportsToolCall !== undefined ? model.supportsToolCall : true,
		supportsImages: model.supportsImages !== undefined ? model.supportsImages : false,
		disabledMultimodal: model.disabledMultimodal !== undefined ? model.disabledMultimodal : false,
		maxAllowedSize: model.maxAllowedSize || model.maxInputTokens || 128000,
		temperature: model.temperature !== undefined ? model.temperature : 1,
		supportsReasoning: model.supportsReasoning !== undefined ? model.supportsReasoning : false,
		reasoning: model.reasoning || undefined,
		onlyReasoning: model.onlyReasoning !== undefined ? model.onlyReasoning : false,
		descriptionEn: model.descriptionEn || '',
		descriptionZh: model.descriptionZh || '',
		credits: model.credits || '',
		relatedModels: model.relatedModels || undefined,
		tags: model.tags || [],
		top_p: model.top_p,
		top_k: model.top_k,
		repetition_penalty: model.repetition_penalty,
		isDefault: model.isDefault !== undefined ? model.isDefault : false,
		supportsExtra: model.supportsExtra !== undefined ? model.supportsExtra : false,
	};
}

/** Cached models fetched from /v3/config, with a short TTL. */
interface IModelsCacheEntry {
	models: IModelConfig[];
	fetchedAt: number;
}
let _modelsCache: IModelsCacheEntry | undefined;
const MODELS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * Determine whether a raw /v3/config model entry is usable as a chat model.
 * Used as a fallback filter when the agents allow-list is unavailable.
 * Excludes image-generation, completion-only (NES/3B), and embedding helpers.
 */
function isChatCapableModel(model: any): boolean {
	if (!model || !model.id) { return false; }
	const tags: string[] = Array.isArray(model.tags) ? model.tags : [];
	// Image generation models
	if (tags.some(t => typeof t === 'string' && t.includes('image'))) { return false; }
	// Completion / NES helper models have tiny output budgets and no real input window
	if (!model.maxInputTokens && (model.maxOutputTokens ?? 0) <= 256) { return false; }
	return true;
}

/**
 * Fetch the available chat models from the CodeBuddy `GET /v3/config` endpoint.
 *
 * Strategy:
 *  - The authoritative set of chat models is the `craft` agent's `models` list
 *    (falling back to `ask`). We intersect that allow-list with the detailed
 *    `data.models` metadata array to obtain full config for each model.
 *  - If the agents allow-list cannot be resolved, fall back to filtering
 *    `data.models` heuristically (drop image/completion helpers).
 *
 * Results are cached in-memory for MODELS_CACHE_TTL_MS. Returns null on failure
 * so callers can fall back to model.json / config / built-in defaults.
 */
async function fetchModelsFromConfigApi(
	accessToken: string,
	serverUrl: string,
	timeoutMs: number,
): Promise<IModelConfig[] | null> {
	const LOG = '[CodeBuddy][/v3/config]';

	// Serve from cache when fresh
	if (_modelsCache && Date.now() - _modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
		const ageMs = Date.now() - _modelsCache.fetchedAt;
		const ttlLeftMs = MODELS_CACHE_TTL_MS - ageMs;
		console.log(`${LOG} ✓ Cache HIT — serving ${_modelsCache.models.length} models (age=${ageMs}ms, ttlLeft=${ttlLeftMs}ms): [${_modelsCache.models.map(m => m.id).join(', ')}]`);
		return _modelsCache.models;
	}
	console.log(`${LOG} Cache MISS${_modelsCache ? ' (expired)' : ' (empty)'} — fetching from server`);

	const url = `${serverUrl}/v3/config`;
	const traceId = crypto.randomUUID();
	const requestId = crypto.randomUUID().replace(/-/g, '');
	const headers: Record<string, string> = {
		...buildCodeBuddyIdentityHeaders(accessToken),
		'Accept': 'application/json, text/plain, */*',
		'X-Requested-With': 'XMLHttpRequest',
		'X-Request-Trace-Id': traceId,
		'X-Request-ID': requestId,
	};

	const startedAt = Date.now();
	try {
		console.log(`${LOG} → GET ${url} (timeout=${timeoutMs}ms, traceId=${traceId}, requestId=${requestId})`);
		const response = await fetchWithRetry(url, { method: 'GET', headers }, timeoutMs, 1);
		const elapsedMs = Date.now() - startedAt;
		const serverTraceId = (typeof response.headers?.get === 'function' && response.headers.get('traceid')) || 'n/a';
		console.log(`${LOG} ← HTTP ${response.status} ${response.statusText || ''} in ${elapsedMs}ms (serverTraceId=${serverTraceId})`);

		if (!response.ok) {
			let bodyPreview = '';
			try { bodyPreview = (await response.text()).slice(0, 500); } catch { /* ignore */ }
			console.error(`${LOG} ✗ HTTP error ${response.status}. Body preview: ${bodyPreview}`);
			return null;
		}

		const json = await response.json() as {
			code?: number;
			msg?: string;
			requestId?: string;
			data?: {
				agents?: Array<{ name?: string; models?: string[] }>;
				models?: any[];
			};
		};

		if (json.code !== 0 || !json.data) {
			console.warn(`${LOG} ✗ Response non-OK: code=${json.code}, msg=${json.msg}, requestId=${json.requestId}`);
			return null;
		}

		const rawModels: any[] = Array.isArray(json.data.models) ? json.data.models : [];
		const agents = Array.isArray(json.data.agents) ? json.data.agents : [];
		console.log(`${LOG} Parsed payload: ${rawModels.length} raw models, ${agents.length} agents [${agents.map(a => a?.name).filter(Boolean).join(', ')}]`);

		if (rawModels.length === 0) {
			console.warn(`${LOG} ✗ data.models is empty — cannot resolve any chat models`);
			return null;
		}

		// Build id → full metadata map
		const metaById = new Map<string, any>();
		for (const m of rawModels) {
			if (m && m.id) { metaById.set(m.id, m); }
		}

		// Resolve the authoritative chat model allow-list from the craft/ask agent
		const craftAgent = agents.find(a => a?.name === 'craft') ?? agents.find(a => a?.name === 'ask');
		const allowList: string[] | undefined = Array.isArray(craftAgent?.models) && craftAgent!.models!.length > 0
			? craftAgent!.models
			: undefined;

		let configs: IModelConfig[];
		if (allowList) {
			console.log(`${LOG} Using '${craftAgent?.name}' agent allow-list (${allowList.length} entries): [${allowList.join(', ')}]`);
			// Map each allowed model id to its detailed config; synthesize when
			// the metadata entry is missing (the allow-list is authoritative).
			const seen = new Set<string>();
			const duplicates: string[] = [];
			const synthesized: string[] = [];
			configs = [];
			for (const id of allowList) {
				if (!id) { continue; }
				if (seen.has(id)) { duplicates.push(id); continue; }
				seen.add(id);
				const meta = metaById.get(id);
				if (!meta) { synthesized.push(id); }
				configs.push(meta ? mapRawModelToConfig(meta) : mapRawModelToConfig({ id }));
			}
			if (duplicates.length > 0) {
				console.log(`${LOG} Skipped ${duplicates.length} duplicate allow-list entries: [${duplicates.join(', ')}]`);
			}
			if (synthesized.length > 0) {
				console.warn(`${LOG} ⚠ ${synthesized.length} allow-list models have NO metadata in data.models (synthesized with defaults): [${synthesized.join(', ')}]`);
			}
			console.log(`${LOG} Resolved ${configs.length} chat models from allow-list (${configs.length - synthesized.length} with metadata, ${synthesized.length} synthesized)`);
		} else {
			// Fallback: filter the full models array heuristically
			console.warn(`${LOG} ⚠ No craft/ask agent allow-list found — falling back to heuristic filter over ${rawModels.length} raw models`);
			const dropped = rawModels.filter(m => !isChatCapableModel(m)).map(m => m?.id).filter(Boolean);
			configs = rawModels.filter(isChatCapableModel).map(mapRawModelToConfig);
			if (dropped.length > 0) {
				console.log(`${LOG} Heuristic filter dropped ${dropped.length} non-chat models (image/completion/NES): [${dropped.join(', ')}]`);
			}
			console.log(`${LOG} Resolved ${configs.length} chat models via heuristic filter`);
		}

		const beforeEmptyIdFilter = configs.length;
		configs = configs.filter(c => c.id);
		if (configs.length !== beforeEmptyIdFilter) {
			console.warn(`${LOG} Dropped ${beforeEmptyIdFilter - configs.length} models with empty id`);
		}
		if (configs.length === 0) {
			console.warn(`${LOG} ✗ No usable chat models after resolution — returning null (fallback will engage)`);
			return null;
		}

		_modelsCache = { models: configs, fetchedAt: Date.now() };
		const totalMs = Date.now() - startedAt;
		console.log(`${LOG} ✓ SUCCESS — cached ${configs.length} chat models in ${totalMs}ms (TTL=${MODELS_CACHE_TTL_MS}ms):`);
		console.table?.(configs.map(m => ({
			id: m.id,
			name: m.name,
			maxInput: m.maxInputTokens,
			maxOutput: m.maxOutputTokens,
			images: m.supportsImages,
			tools: m.supportsToolCall,
			reasoning: m.supportsReasoning,
			vendor: m.vendor,
		})));
		return configs;
	} catch (err) {
		const elapsedMs = Date.now() - startedAt;
		const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		console.error(`${LOG} ✗ FAILED after ${elapsedMs}ms — ${msg}`);
		if (err instanceof Error && err.stack) {
			console.error(`${LOG} Stack: ${err.stack}`);
		}
		return null;
	}
}

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

		// Convert each model to IModelConfig (shared mapping with /v3/config)
		const modelConfigs: IModelConfig[] = models
			.map((model: any) => mapRawModelToConfig(model))
			.filter((config: IModelConfig) => config.id !== '');

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
 * Persist the dynamically-fetched models (from /v3/config) into the
 * `codebuddy.models` configuration property.
 *
 * Why: makes the live model list visible/editable in VSCode settings and
 * provides an offline snapshot that the fallback chain (loadModelsFromConfig)
 * can reuse when /v3/config is unreachable.
 *
 * Skips the write when the stored value is already identical, to avoid
 * triggering needless configuration-change events / settings.json churn.
 */
async function persistModelsToConfig(
	config: vscode.WorkspaceConfiguration,
	models: IModelConfig[],
): Promise<void> {
	const LOG = '[CodeBuddy][/v3/config]';
	try {
		const existing = config.get('models');
		// Compare by serialized content; only write when changed.
		if (Array.isArray(existing) && JSON.stringify(existing) === JSON.stringify(models)) {
			console.log(`${LOG} codebuddy.models already up-to-date (${models.length} models) — skip write`);
			return;
		}
		await config.update('models', models, vscode.ConfigurationTarget.Global);
		console.log(`${LOG} ✓ Persisted ${models.length} models into codebuddy.models config: [${models.map(m => m.id).join(', ')}]`);
	} catch (err) {
		const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		console.warn(`${LOG} ⚠ Failed to persist models into codebuddy.models config — ${msg}`);
	}
}
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
		const serverUrl = config.get<string>('endpoint') || 'https://copilot.tencent.com';
		const timeoutMs = config.get<number>('timeout') || 30_000;

		let modelConfigs: IModelConfig[] | undefined;

		// Primary source: fetch models dynamically from the CodeBuddy /v3/config API.
		// This replaces manual model.json configuration — the server is the source of truth.
		const accessToken = await this._auth.getAccessToken();
		if (accessToken) {
			const apiModels = await fetchModelsFromConfigApi(accessToken.trim(), serverUrl, timeoutMs);
			if (apiModels && apiModels.length > 0) {
				modelConfigs = apiModels;
				console.log(`[CodeBuddy] Using ${modelConfigs.length} models from /v3/config API`);
				// Persist the dynamically-fetched models into the `codebuddy.models`
				// configuration so they are visible/inspectable in settings and serve
				// as an offline fallback. Only write when the content actually changed.
				await persistModelsToConfig(config, apiModels);
			}
		}

		// Fallback chain (only used when /v3/config is unavailable):
		//   bundled model.json (extension directory) → codebuddy.models config → built-in defaults
		if (!modelConfigs) {
			const defaultModelJsonPath = path.join(this._context.extensionPath, 'model.json');
			if (fs.existsSync(defaultModelJsonPath)) {
				const jsonModelConfigs = loadModelsFromJsonFile(defaultModelJsonPath, this._context.extensionPath);
				if (jsonModelConfigs && jsonModelConfigs.length > 0) {
					modelConfigs = jsonModelConfigs;
					console.log(`[CodeBuddy] Fallback: using bundled model.json (${defaultModelJsonPath}), total ${modelConfigs.length} models`);
				}
			}

			if (!modelConfigs) {
				console.log(`[CodeBuddy] Fallback: /v3/config and model.json unavailable, using models config / defaults`);
				modelConfigs = await loadModelsFromConfig(config);
			}
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
				},
				{
					supportsImages: modelConfig.supportsImages,
					supportsToolCall: modelConfig.supportsToolCall,
				}
			),
		);
	}

	// ---- Chat response: OpenAI Chat Completions API ----

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
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

		// Extract tools from modelOptions (set by LMBridge)
		const tools = (options.modelOptions as Record<string, unknown> | undefined)?.tools as vscode.LanguageModelChatTool[] | undefined;

		return this._sendCodeBuddyRequest(trimmedToken, selectedModel, messages, tools, progress, cancellationToken);
	}

	private async _sendCodeBuddyRequest(
		accessToken: string,
		selectedModel: string,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		cancellationToken: vscode.CancellationToken,
	): Promise<void> {
		const config = vscode.workspace.getConfiguration('codebuddy');
		const serverUrl = config.get<string>('endpoint') || 'https://copilot.tencent.com';
		const url = `${serverUrl}/v2/chat/completions`;

		// Convert messages to OpenAI format
		const { systemText, conversationMessages } = separateSystemMessage(messages);
		// Use multimodal extraction so image attachments survive as OpenAI
		// `image_url` content parts (data URLs). Text-only messages still yield a
		// plain string, keeping the request body unchanged for non-image turns.
		const apiMessages = conversationMessages.map(msg => ({
			role: msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' as const : 'user' as const,
			content: extractMessageContent(msg),
		}));

		// Convert VS Code LanguageModelChatTool[] to OpenAI tools format
		const openaiTools = tools && tools.length > 0
			? tools.map(t => ({
				type: 'function' as const,
				function: {
					name: t.name,
					description: t.description,
					parameters: t.inputSchema,
				},
			}))
			: undefined;

		const bodyObj: Record<string, unknown> = {
			model: selectedModel,
			messages: [
				...(systemText ? [{ role: 'system', content: systemText }] : []),
				...apiMessages,
			],
			stream: true,
			temperature: 1,
			max_tokens: 48_000,
		};

		// Include tools if available
		if (openaiTools) {
			bodyObj.tools = openaiTools;
			console.log(`[CodeBuddy] Including ${openaiTools.length} tools in request`);
		}

		const body = JSON.stringify(bodyObj);

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

		// Parse OpenAI SSE stream — supports both text content and tool_calls
		// OpenAI tool_calls are streamed incrementally: first chunk has name + id,
		// subsequent chunks append arguments fragments.
		const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();

		return parseSSEStream(response, progress, cancellationToken, (event) => {
			// OpenAI: choices[0].delta.content
			if (event.choices && event.choices[0]) {
				const choice = event.choices[0];

				// Handle text content
				if (choice.delta && choice.delta.content) {
					return { text: choice.delta.content };
				}

				// Handle tool_calls (OpenAI streaming format)
				// Each chunk may contain one or more tool_call deltas:
				//   { index: N, id?: "call_xxx", function?: { name?: "tool_name", arguments?: "..." } }
				if (choice.delta && choice.delta.tool_calls) {
					for (const tc of choice.delta.tool_calls) {
						const idx = tc.index ?? 0;
						let acc = toolCallAccumulators.get(idx);
						if (!acc) {
							acc = { id: '', name: '', arguments: '' };
							toolCallAccumulators.set(idx, acc);
						}
						// First chunk for this tool_call provides id and name
						if (tc.id) { acc.id = tc.id; }
						if (tc.function?.name) { acc.name = tc.function.name; }
						if (tc.function?.arguments) { acc.arguments += tc.function.arguments; }
					}

					// Emit completed tool calls: only when we have id + name + the arguments
					// are done (finish_reason='tool_calls' signals completion, but we can also
					// emit eagerly when the next text chunk arrives). For streaming UX we emit
					// on finish_reason or when a new tool_call index appears.
					if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
						// Emit all accumulated tool calls
						for (const [, acc] of toolCallAccumulators) {
							if (acc.id && acc.name) {
								let params: object;
								try {
									params = JSON.parse(acc.arguments || '{}');
								} catch {
									params = { raw_arguments: acc.arguments };
								}
								// This will be reported as LanguageModelToolCallPart
								// but we can only return one result per event — emit inline
								progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, params));
							}
						}
						toolCallAccumulators.clear();
					}

					// Return null — we already reported tool calls directly via progress.report()
					// because parseSSEStream's callback can only return one result per event.
					return null;
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
			_modelsCache = undefined; // force a fresh /v3/config fetch
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
