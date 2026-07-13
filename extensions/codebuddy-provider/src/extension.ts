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
import * as zlib from 'zlib';
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
	pruneMessagesForContext,
	getExtensionVersion,
	fetchWithRetry,
} from '@saros/shared';
import { CodeBuddyAuth } from './auth';

// ── Compile-time macro switches ───────────────────────────────────────────────
// 调试构建时改为 true，可绕过 runtime config 强制开启文件日志。
// 生产构建保持 false。
//qiuzijian debug
const FORCE_FILE_LOGGING = false;
const FORCE_FILE_LOGGING_PATH = ''; // 空=用 globalStorageUri/http-debug-{date}.log

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
const EXTENSION_ID = 'saros.saros-codebuddy-provider';

/**
 * Reasoning/thinking config forwarded from the host bridge through
 * `modelOptions.reasoning`. Mirrors `IReasoningOptions` in
 * src/vs/sessions/contrib/agentStudio/common/providers.ts.
 * ⚠️ Keep field names in sync with that interface (cross-package, hardcoded).
 */
interface ReasoningOption {
	readonly enabled: boolean;
	readonly budget?: number;
	readonly effort?: 'low' | 'medium' | 'high';
}

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
 * Look up the **server-authoritative** reasoning defaults for a model id from
 * the latest /v3/config snapshot. Each model entry from the gateway already
 * carries the recommended `reasoning.effort` (e.g. "medium" / "high") and an
 * optional `reasoning.summary`. We treat this as the canonical default — it's
 * what the gateway/model team picked for the model and must NOT be silently
 * overridden by a local budget→effort mapping.
 *
 * Returns `undefined` for models that don't ship reasoning defaults (e.g. the
 * cache is cold, the model isn't in the catalogue, or it's a non-reasoning
 * model). Callers should treat undefined as "no server default available" and
 * fall through to the next priority (UI effort > budget mapping > 'medium').
 */
function getServerModelReasoningDefaults(modelId: string): { effort?: 'low' | 'medium' | 'high'; summary?: string } | undefined {
	if (!_modelsCache) { return undefined; }
	const cfg = _modelsCache.models.find(m => m.id === modelId);
	if (!cfg || !cfg.reasoning) { return undefined; }
	const rawEffort = cfg.reasoning.effort;
	const effort: 'low' | 'medium' | 'high' | undefined =
		rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high' ? rawEffort : undefined;
	return { effort, summary: cfg.reasoning.summary };
}

/**
 * Look up the full cached model config (from /v3/config 或 model.json fallback)
 * by model id. Body 组装时用它的 `temperature` / `maxOutputTokens` 等参数，
 * 避免对全部模型硬编码同一组值（不同模型的 max_tokens / temperature 各不相同）。
 *
 * 返回 `undefined` 表示缓存里没有该模型（冷缓存 / 未命中），调用方应回退到内置默认。
 */
function getServerModelConfig(modelId: string): IModelConfig | undefined {
	if (!_modelsCache) { return undefined; }
	return _modelsCache.models.find(m => m.id === modelId);
}

// ── HTTP Debug File Logging ───────────────────────────────────────────────────

/**
 * 追加一行（或多行）到 HTTP 调试日志文件。
 *
 * 文件路径优先级：
 *   1. codebuddy.debugHttpLogPath 配置（用户显式指定）
 *   2. codebuddy.globalStorageUri/http-debug-{date}.log
 *
 * 单个文件无限大（append 模式），由用户自行清理。日志内容包含：
 *   - 时间戳
 *   - 调用方 sessionId（脱敏）
 *   - 具体日志行
 *
 * 注意：写入失败时打印 warn，不影响主流程。
 */
function appendHttpDebugLog(
	logLines: string[],
	context: vscode.ExtensionContext,
	sessionId: string | undefined,
	forcePath?: string,
): void {
	// ── 诊断：强制写文件时打印路径解析过程 ────────────────────────────────
	if (FORCE_FILE_LOGGING) {
		console.log(`[CodeBuddy] appendHttpDebugLog called: forcePath=${forcePath ?? 'none'}, globalStorageUri=${context.globalStorageUri.fsPath}`);
	}
	try {
		let filePath: string;
		if (forcePath) {
			filePath = forcePath;
		} else {
			const config = vscode.workspace.getConfiguration('codebuddy');
			const logPath = config.get<string>('debugHttpLogPath', '').trim();
			if (logPath) {
				filePath = logPath;
			} else {
				const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
				const dir = context.globalStorageUri.fsPath;
				filePath = path.join(dir, `http-debug-${dateStr}.log`);
			}
		}

		console.log(`[CodeBuddy] appendHttpDebugLog: writing to ${filePath}`);
		// Ensure directory exists
		fs.mkdirSync(path.dirname(filePath), { recursive: true });

		const ts = new Date().toISOString();
		const sidTag = sessionId ? `[sid=${sessionId.slice(0, 12)}...]` : '[no-sid]';
		const header = `\n--- ${ts} ${sidTag} ---\n`;
		const content = header + logLines.join('\n') + '\n';

		fs.appendFileSync(filePath, content, 'utf8');
		console.log(`[CodeBuddy] appendHttpDebugLog: wrote ${content.length} bytes to ${filePath}`);
	} catch (err) {
		console.warn(`[CodeBuddy] Failed to write HTTP debug log: ${err}`);
	}
}

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

/**
 * Result of sanitizing a tool's JSON Schema for the IOA gateway.
 */
interface SchemaSanitizeResult {
	/** The sanitized schema (safe to send). */
	schema: unknown;
	/** Human-readable descriptions of what was fixed (empty = no changes). */
	issues: string[];
}

/**
 * Sanitize a tool's JSON Schema parameters for the CodeBuddy IOA gateway (DeepSeek).
 *
 * The IOA gateway strictly validates JSON Schema and rejects:
 *   1. `additionalProperties` at any nesting level — must be stripped
 *   2. `properties: {}` (empty) — must be replaced with a minimal valid property
 *   3. `type: "object"` without `properties` or `additionalProperties` — must inject a placeholder
 *
 * Design (Void-inspired "construct-time safety"): a single bounded, iterative-DFS
 * pass that **clones + normalizes in one go** and is HARD-CAPPED on both depth and
 * node count. This guarantees the emitted schema can never:
 *   - trip the gateway's "exceeded max depth" HTTP 400 (depth capped at IOA_MAX_SCHEMA_DEPTH)
 *   - OOM the extension host on a pathological / self-recursive schema
 *     (the `http_get.headers` / `workflow_apply` 8.7MB / 200k-node / depth-100001
 *      monster that previously crashed sanitize and 400'd the gateway)
 * Cycles and over-limit subtrees are replaced with a safe placeholder rather than
 * being sent through or aborting the request.
 *
 * Returns both the sanitized schema and a list of issues that were fixed,
 * so callers can log warnings about problematic tool schemas.
 */

// Hard caps — the output is GUARANTEED to stay within these bounds.
// 32 is well below the gateway's "exceeded max depth" rejection threshold and
// covers any realistic tool parameter shape (typical depth < 10).
const IOA_MAX_SCHEMA_DEPTH = 32;
const IOA_MAX_SCHEMA_NODES = 200_000;

/**
 * Read-only bounded DFS scan: returns true if the schema contains any IOA-
 * incompatible pattern OR exceeds the depth/node caps (in which case it must be
 * truncated). Used as a fast-path guard so already-valid schemas skip the clone.
 * Itself depth- and node-capped with a WeakSet cycle-breaker, so it can never
 * spin forever or OOM on a pathological input.
 */
function needsIoaSanitize(node: unknown): boolean {
	const visited = new WeakSet<object>();
	const stack: Array<{ node: unknown; depth: number }> = [{ node, depth: 0 }];
	let nodes = 0;
	while (stack.length > 0) {
		const { node: cur, depth } = stack.pop()!;
		if (cur === null || typeof cur !== 'object') continue;
		if (visited.has(cur)) continue;
		visited.add(cur);
		if (++nodes > IOA_MAX_SCHEMA_NODES) return true; // too large → must sanitize/truncate
		if (depth > IOA_MAX_SCHEMA_DEPTH) return true;   // too deep → must truncate
		if (Array.isArray(cur)) {
			for (let i = cur.length - 1; i >= 0; i--) stack.push({ node: cur[i], depth: depth + 1 });
			continue;
		}
		const obj = cur as Record<string, unknown>;
		// Pattern 1: additionalProperties at any level
		if ('additionalProperties' in obj) return true;
		// Pattern 2: empty properties {}
		const props = obj.properties;
		if (props && typeof props === 'object' && !Array.isArray(props) && Object.keys(props).length === 0) {
			return true;
		}
		// Pattern 3: type:"object" without properties/additionalProperties
		if (obj.type === 'object' && !('properties' in obj) && !('additionalProperties' in obj)) {
			return true;
		}
		for (const key of Object.keys(obj)) {
			const v = obj[key];
			if (v !== null && typeof v === 'object') stack.push({ node: v, depth: depth + 1 });
		}
	}
	return false;
}

function sanitizeSchemaForIoaGateway(schema: unknown, toolName?: string): SchemaSanitizeResult {
	// Fast path: most tool schemas are already IOA-compatible and within caps.
	// Skip the clone entirely (zero-copy) — avoids the heap-allocation spike that
	// previously contributed to OOM on an already-strained extension host.
	if (!needsIoaSanitize(schema)) {
		return { schema, issues: [] };
	}

	const tag = toolName ? ` for tool "${toolName}"` : '';
	const issues: string[] = [];
	const visited = new WeakSet<object>();
	let nodes = 0;

	// Safe placeholder emitted when a subtree is too deep / too large / cyclic.
	const placeholder = (reason: string, depth: number): Record<string, unknown> => {
		issues.push(`${reason} at depth ${depth} — replaced with safe placeholder`);
		return {
			type: 'object',
			description: 'Omitted for IOA gateway compatibility',
			properties: {
				_omitted: { type: 'string', description: 'Original schema omitted to satisfy gateway limits' },
			},
		};
	};

	// Single bounded pass: clone + normalize. Produces a NEW object graph (the
	// original `schema` is never mutated), so the same tool definition can be
	// reused across turns without accumulating injected placeholders.
	const normalize = (node: unknown, depth: number): unknown => {
		if (node === null || typeof node !== 'object') return node;

		// Hard depth cap — never emit anything deeper than the gateway allows.
		if (depth > IOA_MAX_SCHEMA_DEPTH) {
			return placeholder(`schema depth exceeded ${IOA_MAX_SCHEMA_DEPTH}`, depth);
		}
		// Cycle breaker on the ORIGINAL node (returned placeholder avoids re-entrancy).
		if (visited.has(node)) {
			return placeholder('circular schema reference', depth);
		}
		visited.add(node);
		if (++nodes > IOA_MAX_SCHEMA_NODES) {
			return placeholder(`schema exceeded ${IOA_MAX_SCHEMA_NODES} nodes`, depth);
		}

		if (Array.isArray(node)) {
			return node.map((item) => normalize(item, depth + 1));
		}

		const obj = node as Record<string, unknown>;
		const out: Record<string, unknown> = {};

		// Pattern 1: strip additionalProperties everywhere (do not copy it into `out`).
		if ('additionalProperties' in obj) {
			issues.push(`additionalProperties stripped at depth ${depth}`);
		}

		// Pattern 2 / 3: compute the (possibly fixed) properties without mutating
		// the original object — we only write the corrected value into `out`.
		let outProperties = obj.properties;
		const propsObj = obj.properties;
		const propsEmpty = propsObj && typeof propsObj === 'object' && !Array.isArray(propsObj) && Object.keys(propsObj as object).length === 0;
		if (propsEmpty) {
			outProperties = { _no_params: { type: 'boolean', description: 'No parameters needed' } };
			issues.push(`empty properties {} replaced with _no_params at depth ${depth}`);
		}
		if (obj.type === 'object' && !('properties' in obj) && !('additionalProperties' in obj)) {
			// Self-safe placeholder: carries non-empty properties + a string child, so it
			// never re-triggers Pattern 3 (the previous http_get.headers / workflow_apply
			// self-recursion OOM root cause).
			outProperties = {
				_freeform: {
					type: 'object',
					description: 'Arbitrary key-value pairs (freeform object)',
					properties: { _value: { type: 'string', description: 'A value (stringified)' } },
				},
			};
			issues.push(`object without properties — injected _freeform placeholder at depth ${depth}`);
		}

		for (const key of Object.keys(obj)) {
			if (key === 'additionalProperties') continue; // stripped (Pattern 1)
			if (key === 'properties' && outProperties !== obj.properties) {
				out[key] = normalize(outProperties, depth + 1); // write the fixed properties
				continue;
			}
			const v = obj[key];
			out[key] = (v !== null && typeof v === 'object') ? normalize(v, depth + 1) : v;
		}
		return out;
	};

	const result = normalize(schema, 0);

	if (issues.length > 0) {
		console.warn(`[CodeBuddy][sanitize] sanitized ${issues.length} IOA-incompatible pattern(s)${tag}: ${issues.join('; ')}`);
	}

	return { schema: result, issues };
}

/**
 * 计算一个值序列化后的最大 JSON 嵌套深度（object/array 层数）。
 * 用于定位网关 "exceeded max depth" 400 的罪魁——哪个 tool schema 或 message
 * 嵌套过深。带环检测（WeakSet）+ 上限保护，O(n)。
 */
function maxJsonDepth(root: unknown): number {
	const visited = new WeakSet<object>();
	const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
	let max = 0;
	while (stack.length > 0) {
		const { node, depth } = stack.pop()!;
		if (typeof node !== 'object' || node === null) continue;
		if (visited.has(node)) continue;
		visited.add(node);
		if (depth > max) { max = depth; }
		if (max > 100_000) { break; } // 安全阀
		if (Array.isArray(node)) {
			for (const child of node) { stack.push({ node: child, depth: depth + 1 }); }
		} else {
			for (const key of Object.keys(node)) {
				stack.push({ node: (node as Record<string, unknown>)[key], depth: depth + 1 });
			}
		}
	}
	return max;
}

class CodeBuddyChatProvider implements vscode.LanguageModelChatProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
	private readonly _context: vscode.ExtensionContext;

	/**
	 * Per-session last response id, for the OpenAI-style `previous_response_id`
	 * stateful multi-turn association (matches CodeBuddy IDE CN behavior).
	 * Key = stable sessionId (from modelOptions.sessionId, used as X-Conversation-Id).
	 * Updated whenever a streamed chunk carries a response id; replayed on the
	 * next turn of the same session so the gateway can reuse server-side context
	 * and reasoning cache. Best-effort: when the gateway never returns an id, the
	 * field is simply omitted and behavior is unchanged.
	 */
	private readonly _lastResponseIdBySession = new Map<string, string>();

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

		// 确保 _modelsCache 在 fallback 路径下也被填充：
		// /v3/config 成功时 fetchModelsFromConfigApi 内部已写缓存（含完整 reasoning/
		// temperature/maxOutputTokens）；但 model.json / config 兜底路径不经过那里，
		// 若不补写，body 组装时 getServerModelConfig / getServerModelReasoningDefaults
		// 会全部落空 → 退回硬编码默认。这里仅在缓存为空时补写，避免覆盖更权威的
		// 服务端数据。
		if (!_modelsCache) {
			_modelsCache = { models: modelConfigs, fetchedAt: Date.now() };
			console.log(`[CodeBuddy] Seeded _modelsCache from fallback path with ${modelConfigs.length} models`);
		}

		return modelConfigs.map(modelConfig =>
			createModelInfo(
				modelConfig.id,
				'', // 不添加 vendor 前缀 — 服务端模型 ID 已唯一（如 "deepseek-v4-pro-ioa"）
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
		const mo = options.modelOptions as Record<string, unknown> | undefined;
		const tools = mo?.tools as vscode.LanguageModelChatTool[] | undefined;
		// tool_choice：由上层 AgentOS 续跑兜底 / configHtmlService 等流程透传。
		// 'required' 表示本轮必须调用至少一个工具（治本手段，对抗模型\"宣告完成却不调工具\"）。
		// 缺失时由 _sendCodeBuddyRequest 默认走 'auto'。
		const toolChoiceRaw = mo?.toolChoice;
		const toolChoice: 'auto' | 'required' | 'none' | undefined =
			toolChoiceRaw === 'auto' || toolChoiceRaw === 'required' || toolChoiceRaw === 'none'
				? toolChoiceRaw
				: undefined;
		// Reasoning/thinking config (chat toolbar thinking toggle → LMBridge → here).
		const reasoning = mo?.reasoning as ReasoningOption | undefined;
		// Server-authoritative reasoning defaults from /v3/config metadata
		// (e.g. minimax-m2.7-ioa ships `reasoning.effort='medium', summary='auto'`).
		// These are the values the gateway/model team picked for this model and
		// MUST be preferred over any local budget→effort heuristic.
		const serverReasoningDefault = getServerModelReasoningDefaults(selectedModel);
		// Stable session id (LMBridge passes context.sessionId through modelOptions),
		// used as X-Conversation-Id and as the key for previous_response_id.
		const sessionId = typeof mo?.sessionId === 'string' ? mo.sessionId : undefined;

		return this._sendCodeBuddyRequest(this._context, trimmedToken, selectedModel, messages, tools, toolChoice, reasoning, serverReasoningDefault, sessionId, progress, cancellationToken);
	}

	private async _sendCodeBuddyRequest(
		context: vscode.ExtensionContext,
		accessToken: string,
		selectedModel: string,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: vscode.LanguageModelChatTool[] | undefined,
		toolChoice: 'auto' | 'required' | 'none' | undefined,
		reasoning: ReasoningOption | undefined,
		serverReasoningDefault: { effort?: 'low' | 'medium' | 'high'; summary?: string } | undefined,
		sessionId: string | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		cancellationToken: vscode.CancellationToken,
	): Promise<void> {
		const config = vscode.workspace.getConfiguration('codebuddy');
		const serverUrl = config.get<string>('endpoint') || 'https://copilot.tencent.com';
		//qiuzijian debug
		const debugHttp = config.get<boolean>('debugHttp') ?? false;
		const debugHttpLogFile = config.get<boolean>('debugHttpLogFile') ?? false;
		const url = `${serverUrl}/v2/chat/completions`;

		// Convert messages to OpenAI format
		const { systemText, conversationMessages } = separateSystemMessage(messages);
		// 工具调用历史的合法编码 —— 这是模型能否真正调用工具的关键。
		//
		// OpenAI Chat Completions 协议下：
		//   • assistant 消息：{ role:'assistant', content:string|null,
		//                       tool_calls?: [{id, type:'function', function:{name, arguments}}] }
		//   • tool 消息：     { role:'tool', tool_call_id:string, content:string }
		//
		// 历史 bug：之前所有消息都按 `{role, content: extractMessageContent(msg)}`
		// 输出，把 LanguageModelToolCallPart / LanguageModelToolResultPart 默默丢弃，
		// 导致模型从历史里只看到"用文本伪造工具结果"的样本，触发 fake-completion
		// 死循环。修正后：识别两种 part，输出合法的 OpenAI 工具调用序列。
		//
		// 单条 LM message 可能携带多个 ToolResultPart（一个 assistant 多个 tool_call
		// 对应多个 tool result，被打包进同一条 user 消息）。这里把每个 ToolResultPart
		// 单独拆成一条 role:'tool' 消息，保持与 OpenAI 协议 1:1 配对。
		const apiMessages: Array<Record<string, unknown>> = [];
		for (const msg of conversationMessages) {
			const isAssistant = msg.role === vscode.LanguageModelChatMessageRole.Assistant;

			// 收集本条消息中的各类 part
			const toolCalls: Array<{
				id: string;
				type: 'function';
				function: { name: string; arguments: string };
			}> = [];
			const toolResults: Array<{ tool_call_id: string; content: string }> = [];
			const textParts: string[] = [];
			const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];

			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelToolCallPart) {
					// assistant 工具调用：聚合到 tool_calls[]
					let argsStr: string;
					try {
						argsStr = typeof part.input === 'string'
							? part.input
							: JSON.stringify(part.input ?? {});
					} catch {
						argsStr = '{}';
					}
					toolCalls.push({
						id: part.callId,
						type: 'function',
						function: { name: part.name, arguments: argsStr },
					});
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					// 工具结果：拆成独立的 role:'tool' 消息
					const contentParts: string[] = [];
					for (const inner of part.content) {
						if (inner instanceof vscode.LanguageModelTextPart) {
							contentParts.push(inner.value);
						}
						// PromptTsxPart / DataPart 在 tool result 里少见，跳过即可
					}
					toolResults.push({
						tool_call_id: part.callId,
						content: contentParts.join('') || '',
					});
				} else if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					const mime = part.mimeType || '';
					if (mime.startsWith('image/')) {
						const base64 = Buffer.from(part.data).toString('base64');
						imageParts.push({
							type: 'image_url',
							image_url: { url: `data:${mime};base64,${base64}` },
						});
					}
				}
			}

			// 1) 工具结果消息先发（OpenAI 要求 tool 消息紧跟在对应 assistant tool_calls
			//    之后；这里按历史顺序遍历，所以前一条 assistant 已经入队，把当前 user
			//    消息里携带的 tool_result 立刻发出即可）
			for (const tr of toolResults) {
				apiMessages.push({
					role: 'tool',
					tool_call_id: tr.tool_call_id,
					content: tr.content,
				});
			}

			// 2) assistant 消息：text + tool_calls 合并
			if (isAssistant) {
				// 即使 toolCalls.length>0，OpenAI 也允许 content 同时存在（前缀文本）。
				// content 必须有值；若文本为空且有 tool_calls，content 设为空格（对齐 Continue：
				// 部分 OpenAI-compatible 网关拒绝空字符串 content，但接受单空格）。
				const text = textParts.join('') || ' ';
				const assistantMsg: Record<string, unknown> = {
					role: 'assistant',
					content: text,
				};
				if (toolCalls.length > 0) {
					assistantMsg.tool_calls = toolCalls;
				}
				// assistant 不允许携带 image part；如果出现就忽略（理论上不会发生）
				apiMessages.push(assistantMsg);
				continue;
			}

			// 3) user 消息：当只有 tool_result 时已经在步骤 1 处理完毕，跳过
			if (textParts.length === 0 && imageParts.length === 0) {
				continue;
			}

			// 多模态拼装（与原 extractMessageContent 一致）
			const text = textParts.join('');
			let userContent: string | Array<Record<string, unknown>>;
			if (imageParts.length === 0) {
				userContent = text;
			} else {
				const arr: Array<Record<string, unknown>> = [];
				if (text) {
					arr.push({ type: 'text', text });
				}
				arr.push(...imageParts);
				userContent = arr;
			}
			apiMessages.push({ role: 'user', content: userContent });
		}
		// silence unused import warning (kept for API compat / future fallback paths)
		void extractMessageContent;

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

		// ── 模型级参数（temperature / max_tokens）从 model 信息读取 ──────────
		// 抓包对齐：CodeBuddy IDE 的 body 里 temperature / max_tokens 来自该模型的
		// catalog 元数据（model.json / /v3/config 的 `temperature` / `maxOutputTokens`），
		// 而非对所有模型写死同一组值。历史 bug：硬编码 temperature:1 / max_tokens:48000
		// 对 glm-5.1-ioa 恰好吻合，但其它模型（如 maxOutputTokens=32000 的 DeepSeek）
		// 会发出错误的上限。这里按 selectedModel 查缓存里的 config，缺失时回退默认。
		//
		// ⚠️ 追加修正：服务端 /v3/config 对某些模型（如 deepseek-v4-pro-ioa）
		// 返回的 maxOutputTokens（实测 50000）远超 API gateway 实际接受的硬上限，
		// 导致 HTTP 400 "Invalid request parameters"。这里以本地 getModelTokenLimits
		// 的安全值作为 cap——服务端值超过本地值时，取本地值。
		const localMaxTokens = getModelTokenLimits(selectedModel).maxOutputTokens;
		const rawServerMaxTokens = getServerModelConfig(selectedModel)?.maxOutputTokens;
		const modelCfg = rawServerMaxTokens != null ? getServerModelConfig(selectedModel) : undefined;
		const bodyTemperature = modelCfg?.temperature ?? 1;
		const bodyMaxTokens = modelCfg?.maxOutputTokens != null
			? Math.min(modelCfg.maxOutputTokens, localMaxTokens)
			: localMaxTokens;

		// ── 消息裁剪（对齐 Continue compileChatMessages）──────────────────────
		// 当对话历史 + system prompt + tools 超过模型 context window 时，
		// 从最旧的消息开始裁剪，确保请求不会因超长而触发 HTTP 400。
		// system message + tools + 最后一条消息（用户当前输入）不可裁剪。
		const maxInputTokens = getModelTokenLimits(selectedModel).maxInputTokens;
		const pruneResult = pruneMessagesForContext(apiMessages, {
			modelName: selectedModel,
			maxInputTokens,
			maxOutputTokens: bodyMaxTokens,
			systemText,
			tools: openaiTools as Array<Record<string, unknown>> | undefined,
		});
		const finalApiMessages = pruneResult.messages;

		const bodyObj: Record<string, unknown> = {
			model: selectedModel,
			messages: [
				...(systemText ? [{ role: 'system', content: systemText }] : []),
				...finalApiMessages,
			],
			stream: true,
			temperature: bodyTemperature,
			max_tokens: bodyMaxTokens,
		};
		const serverOrLocal = modelCfg?.maxOutputTokens ?? localMaxTokens;
		console.log(`[CodeBuddy] body params from model(${selectedModel}): temperature=${bodyTemperature}, max_tokens=${bodyMaxTokens} (server=${rawServerMaxTokens ?? 'N/A'}, local=${localMaxTokens})${modelCfg ? '' : ' (model cfg MISS)'}${bodyMaxTokens !== (modelCfg?.maxOutputTokens ?? localMaxTokens) ? ` [CAPPED]` : ''}`);

		// Reasoning/thinking parameters (P1) — align with CodeBuddy IDE CN body.
		// The thinking toggle in the chat toolbar flows here as `reasoning`.
		// IDE sends BOTH snake_case and camelCase for gateway compatibility, plus
		// `reasoning_summary: 'auto'`. We only inject when reasoning is enabled, so
		// non-reasoning turns keep the original body shape unchanged.
		if (reasoning?.enabled) {
			// Effort priority (高→低)，**UI 显式输入永远优先于 server-default**：
			//   1. UI 显式 effort（effort-slider 模型，用户在工具栏拨过的值）
			//   2. UI 显式 budget（budget-slider 模型，UI 把 thinking 开关展开成
			//      预算滑块；UI 默认 1024 → 'medium'，用户拨高才走 'high'）
			//   3. 服务端 /v3/config 给的 model.reasoning.effort（catalog 推荐
			//      默认值，例如 hy3-preview-agent-ioa 出厂带 effort='high'）
			//   4. 最终默认 'medium'
			//
			// ⚠️ Bug 修正：之前把 server-default 排在 budget 映射前，导致
			//   budget-slider 模型（hy3 这种）哪怕 UI 明明传了 budget=1024，
			//   也被 server-default='high' 覆盖。配合 hy3 + 80 tools，
			//   reasoning=high 会让模型把工具调用"想"在 reasoning_content 里、
			//   visible content 只描述不发 tool_calls 字段，触发 fake-completion
			//   nudge 死循环。修正后：用户在 UI 拨过的任何值（effort 或
			//   budget）都先于 server-default 起作用，server-default 只在
			//   "UI 完全没传"的边界情况下兜底。
			const budgetMappedEffort: 'low' | 'medium' | 'high' | undefined =
				reasoning.budget != null
					? (reasoning.budget >= 6144 ? 'high' : reasoning.budget >= 1024 ? 'medium' : 'low')
					: undefined;
			const effort: 'low' | 'medium' | 'high' =
				reasoning.effort
				?? budgetMappedEffort
				?? serverReasoningDefault?.effort
				?? 'medium';
			// Effort source tag for diagnostic logging (no behavior impact).
			const effortSource = reasoning.effort
				? 'ui-effort'
				: budgetMappedEffort
					? 'ui-budget'
					: serverReasoningDefault?.effort
						? 'server-default'
						: 'hardcoded-medium';
			// Summary preference: prefer server-default summary (e.g. 'auto'),
			// fall back to 'auto' to match IDE behavior.
			const summary = serverReasoningDefault?.summary ?? 'auto';
			bodyObj.reasoning_effort = effort;
			bodyObj.reasoning_summary = summary;
			console.log(`[CodeBuddy] reasoning enabled: effort=${effort} (source=${effortSource}), summary=${summary}`);
		}

		// Stateful multi-turn association (P2) — replay last response id for this
		// session so the gateway can reuse server-side context / reasoning cache.
		if (sessionId) {
			const prevId = this._lastResponseIdBySession.get(sessionId);
			if (prevId) {
				bodyObj.previous_response_id = prevId;
				console.log(`[CodeBuddy] previous_response_id=${prevId} (session=${sessionId})`);
			}
		}

		// Include tools if available
		if (openaiTools) {
			// ── DeepSeek IOA 网关 schema sanitize ──────────────────────────
			// 网关对 JSON Schema 做严格校验，拒绝以下模式：
			//   1. 嵌套 object 中的 additionalProperties（update_plan / http_get）
			//   2. 空 properties: {}（execute_code / get_graph_schema / list_projects /
			//      workflow_get_schema / workflow_list）
			// 递归剥离 additionalProperties，将空 properties 替换为最小合法 schema
			// 以避免 HTTP 400 "invalid parameter value" 无具体字段名。
			const sanitizeResults = openaiTools.map(tool => ({
				toolName: tool.function.name,
				result: sanitizeSchemaForIoaGateway(tool.function.parameters, tool.function.name),
			}));
			const sanitizedTools = openaiTools.map((tool, i) => ({
				...tool,
				function: {
					...tool.function,
					parameters: sanitizeResults[i].result.schema,
				},
			}));
			// ── 对检测到非法模式的工具输出警告 ───────────────────────────
			for (const { toolName, result } of sanitizeResults) {
				if (result.issues.length > 0) {
					console.warn(
						`[CodeBuddy] ⚠ Tool "${toolName}" has IOA-incompatible schema patterns — auto-fixed:\n` +
						result.issues.map(issue => `  - ${issue}`).join('\n')
					);
				}
			}
			bodyObj.tools = sanitizedTools;
			console.log(`[CodeBuddy] Including ${sanitizedTools.length} tools in request (sanitized for IOA gateway)`);
			// tool_choice：仅在有 tools 时生效。'required' 表示本轮必须发起至少一个
			// 工具调用（治本对抗 hy3-preview-agent-ioa 等模型\"宣告完成却不调工具\"
			// 的幻觉）；'auto'（默认）让模型自行判断；'none' 禁止本轮调用工具。
			const tc = toolChoice ?? 'auto';
			bodyObj.tool_choice = tc;
			if (tc !== 'auto') {
				console.log(`[CodeBuddy] tool_choice=${tc} (forced by upstream)`);
			}
		}

		const bodyJson = JSON.stringify(bodyObj);

		// Gzip the request body (P2) — CodeBuddy IDE CN sends `Content-Encoding: gzip`.
		// For long prompts (tens of KB) this materially reduces upload size. We keep a
		// plaintext fallback if compression throws for any reason.
		let body: string | Buffer = bodyJson;
		let bodyGzipped = false;
		try {
			body = zlib.gzipSync(Buffer.from(bodyJson, 'utf8'));
			bodyGzipped = true;
		} catch (e) {
			console.warn('[CodeBuddy] gzip failed, sending plaintext body:', e);
			body = bodyJson;
		}

		// Stable conversation id (P0) — reuse the session id so the gateway treats
		// all turns of one chat session as the same conversation (request/message
		// ids still rotate per turn). Fall back to a fresh uuid when no session id.
		const conversationId = sessionId || crypto.randomUUID();
		const requestId = crypto.randomUUID();

		// Zipkin B3 / OpenTelemetry trace context (P2). traceId = 32 hex, spanId = 16 hex.
		const traceId = crypto.randomBytes(16).toString('hex');
		const spanId = crypto.randomBytes(8).toString('hex');
		const parentSpanId = crypto.randomBytes(8).toString('hex');

		// Monitor timing markers (P2) — IDE sends prompt-prepare + http-send epochs (ms).
		const monitorPromptPrepareStartTime = Date.now();

		// Decode JWT to get user/tenant info (per CodeBuddy IDE CN headers)
		const jwtPayload = decodeJwtPayload(accessToken);
		const userId = (jwtPayload?.sub as string) || '';
		const tenantId = jwtPayload?.iss ? extractTenantIdFromIss(jwtPayload.iss as string) : undefined;
		const extensionVersion = getExtensionVersion(EXTENSION_ID);

		const monitorHttpSendTime = Date.now();

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
			'X-Requested-With': 'XMLHttpRequest',
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
			// ── Distributed tracing (Zipkin B3) ─────────────────────────────
			'X-Trace-ID': traceId,
			'b3': `${traceId}-${spanId}-1-${parentSpanId}`,
			'X-B3-TraceId': traceId,
			'X-B3-ParentSpanId': parentSpanId,
			'X-B3-SpanId': spanId,
			'X-B3-Sampled': '1',
			// ── Performance monitor markers ─────────────────────────────────
			'monitor_promptPrepareStartTime': String(monitorPromptPrepareStartTime),
			'monitor_httpSendTime': String(monitorHttpSendTime),
		};

		// Advertise gzip encoding only when we actually compressed the body.
		if (bodyGzipped) {
			headers['Content-Encoding'] = 'gzip';
		}

		// ── HTTP 请求 Debug（不受 debugHttp 限制，内容始终完整收集）────────────────
		// 注意：此处 token 为原始值，仅限调试用途，勿提交到版本控制。
		const debugHeaders = { ...headers };
		debugHeaders['Authorization'] = `Bearer ${accessToken}`;

		const reqLines: string[] = [];
		reqLines.push(`========== HTTP REQUEST DEBUG ==========`);
		reqLines.push(`URL: ${url}`);
		reqLines.push(`Method: POST`);
		reqLines.push(`Headers: ${JSON.stringify(debugHeaders, null, 2)}`);
		reqLines.push(`Body: ${bodyJson.length} chars (raw JSON)${bodyGzipped ? `, ${(body as Buffer).length} bytes (gzip)` : ''}`);
		reqLines.push(`Body:\n${bodyJson}`);
		reqLines.push(`========== END REQUEST DEBUG ==========`);
		if (debugHttp) { console.log(`\n${reqLines.join('\n')}\n`); }
		if (FORCE_FILE_LOGGING || debugHttpLogFile) {
			appendHttpDebugLog(reqLines, context, sessionId, FORCE_FILE_LOGGING_PATH || undefined);
		}

		const controller = new AbortController();
		cancellationToken.onCancellationRequested(() => controller.abort());

		// ── Chat 请求超时 ──────────────────────────────────────────────
		// fetchWithRetry 的 timeoutMs 仅覆盖「等待响应头」阶段（fetch 返回后
		// 即 clearTimeout，SSE 流迭代不受此限制）。LLM 在处理大量工具 schema
		// 或长上下文时，首字节延迟可能远超 30s 默认值。
		// 使用 codebuddy.timeout 配置，但对 chat 请求设 120s 下限——
		// 30s 的默认值对带工具的流式 LLM 请求太短，会触发 AbortError 导致空响应。
		const configTimeoutMs = config.get<number>('timeout') ?? 0;
		const chatTimeoutMs = Math.max(configTimeoutMs, 120_000);
		console.log(`[CodeBuddy] Chat request timeout: ${chatTimeoutMs}ms (config=${configTimeoutMs}ms, min=120000ms)`);

		// ── 400 重试：previous_response_id 可能因 system prompt 变化而失效 ──
		// 对齐 Continue（不发 previous_response_id）：当 Knot API 返回 400 且
		// 请求中携带了 previous_response_id 时，清除缓存并重试一次（不带该字段）。
		const hasPrevResponseId = 'previous_response_id' in bodyObj;

		const doFetch = async (): Promise<Response> => {
			return fetchWithRetry(url, {
				method: 'POST',
				headers,
				body: body as unknown as BodyInit,
				signal: controller.signal,
			}, chatTimeoutMs);
		};

		let response: Response;
		try {
			response = await doFetch();
		} catch (err) {
			// ── 400 诊断 ────────────────────────────────────────────────────
			// 网关只回 `param:""`，无法定位是哪个字段非法（DeepSeek 对 tools
			// schema / reasoning 参数很挑剔）。这里把请求体摘要 + 工具形态 +
			// 原始 body 前若干字符附到错误上，沿 handleUnexpectedError 落到主
			// 日志（vscode-app-<pid>.log），便于精确定位 invalid parameter。
			if (err instanceof Error && /HTTP 400|code.*11133/i.test(err.message)) {
				const toolsArr = (bodyObj.tools as Array<{ function?: { name?: string; parameters?: unknown } }> | undefined) ?? [];
				const bodyLen = bodyJson.length;
				const bodyLenKB = (bodyLen / 1024).toFixed(1);
				const msgCount = Array.isArray(bodyObj.messages) ? bodyObj.messages.length : 0;
				// ── 拆成多个独立 console.error，避免长字符串被日志系统截断 ──
				console.error(
					`[CodeBuddy][DIAG-400] model=${selectedModel} ` +
					`reasoning=${bodyObj.reasoning_effort ?? 'none'}/${bodyObj.reasoning_summary ?? 'none'} ` +
					`tool_choice=${bodyObj.tool_choice ?? 'n/a'} ` +
					`tools=${toolsArr.length} messages=${msgCount} ` +
					`max_tokens=${bodyObj.max_tokens} temperature=${bodyObj.temperature} bodySize=${bodyLen}chars/${bodyLenKB}KB`
				);
				// 每个 tool 的形态摘要（一行，较短不会被截断）
				const toolShapes = toolsArr.map(t => {
					const fn = t.function;
					const p = fn?.parameters as Record<string, unknown> | undefined;
					const pType = p && typeof p === 'object' ? (p.type ?? '(missing)') : typeof p;
					return `${fn?.name ?? '(no-name)'}[params.type=${pType}]`;
				}).join(', ');
				console.error(`[CodeBuddy][DIAG-400] toolShapes: ${toolShapes}`);
				// HEAD: 请求体前部（system prompt + 前几条消息）
				console.error(`[CodeBuddy][DIAG-400] body HEAD (first 3000 chars):\n${bodyJson.slice(0, 3000)}`);
				// 关键：tools 数组逐条 dump（每个 tool 独立 console.error，避免长字符串被截断）
				for (let i = 0; i < toolsArr.length; i++) {
					const t = toolsArr[i];
					const fn = t.function;
					const pStr = JSON.stringify(fn?.parameters ?? {});
					console.error(`[CodeBuddy][DIAG-400] tool[${i}] ${fn?.name ?? '(no-name)'} params(${pStr.length}): ${pStr.slice(0, 500)}`);
				}
			// TAIL: 请求体尾部 2000 字符
			console.error(`[CodeBuddy][DIAG-400] body TAIL (last 2000 chars):\n${bodyJson.slice(Math.max(0, bodyLen - 2000))}`);
			// ── 深度扫描：定位 "exceeded max depth" 的罪魁（tool schema 或 message）──
			{
				let toolMaxDepth = 0, toolMaxIdx = -1, toolMaxName = '';
				toolsArr.forEach((t, i) => {
					const d = maxJsonDepth(t.function?.parameters);
					if (d > toolMaxDepth) { toolMaxDepth = d; toolMaxIdx = i; toolMaxName = t.function?.name ?? ''; }
				});
				console.error(`[CodeBuddy][DIAG-400] tool max depth: ${toolMaxDepth} (tool[${toolMaxIdx}] "${toolMaxName}")`);
				// 列出深度 > 32 的所有 tool（疑似病态）
				const deepTools = toolsArr.map((t, i) => ({ i, name: t.function?.name ?? '', d: maxJsonDepth(t.function?.parameters) })).filter(x => x.d > 32);
				if (deepTools.length > 0) {
					console.error(`[CodeBuddy][DIAG-400] deep tools (>32): ${deepTools.map(x => `${x.name}[${x.i}]=${x.d}`).join(', ')}`);
				}
				let msgMaxDepth = 0, msgMaxIdx = -1, msgMaxRole = '';
				const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages as unknown[] : [];
				msgs.forEach((m, i) => {
					const d = maxJsonDepth(m);
					if (d > msgMaxDepth) { msgMaxDepth = d; msgMaxIdx = i; msgMaxRole = (m as { role?: string })?.role ?? ''; }
				});
				console.error(`[CodeBuddy][DIAG-400] message max depth: ${msgMaxDepth} (msg[${msgMaxIdx}] role=${msgMaxRole})`);
				const deepMsgs = msgs.map((m, i) => ({ i, d: maxJsonDepth(m), role: (m as { role?: string })?.role ?? '' })).filter(x => x.d > 32);
				if (deepMsgs.length > 0) {
					console.error(`[CodeBuddy][DIAG-400] deep messages (>32): ${deepMsgs.map(x => `msg[${x.i}](role=${x.role})=${x.d}`).join(', ')}`);
				}
			}
				const diag =
					`[CodeBuddy][DIAG-400] model=${selectedModel} bodySize=${bodyLen}chars/${bodyLenKB}KB tools=${toolsArr.length} messages=${msgCount} — full diagnostics above`;
				const wrapped = new Error(`${err.message}\n${diag}`);
				wrapped.stack = err.stack;
				// 400 + previous_response_id → 清除 stale ID，移除该字段后重试一次
				if (hasPrevResponseId) {
					console.warn(`[CodeBuddy] HTTP 400 with previous_response_id — clearing stale cache and retrying without it`);
					if (sessionId) {
						this._lastResponseIdBySession.delete(sessionId);
					}
					delete bodyObj.previous_response_id;
					const retryBodyJson = JSON.stringify(bodyObj);
					body = retryBodyJson;
					bodyGzipped = false;
					try {
						body = zlib.gzipSync(Buffer.from(retryBodyJson, 'utf8'));
						bodyGzipped = true;
					} catch {
						body = retryBodyJson;
					}
					response = await doFetch();
				} else {
					throw wrapped;
				}
			} else {
				throw err;
			}
		}

		// ── HTTP 响应 Debug（受 codebuddy.debugHttp 开关控制）──────────────────
		// SSE 流式响应无法直接重放，这里记录：
		//   1. status + headers（最关键）
		//   2. 每种 SSE data 事件的样本（前 300 字符截断）
		//   3. 结束时汇总计数
		let _debugSseCount = 0;
		let _debugSseBytes = 0;
		const _debugSseSamples: string[] = [];
		const _debugSseMaxSamples = 500;
		const _debugRespLines: string[] = [];

		// 响应 headers：无论 debugHttp 是否开启，只要 FORCE_FILE_LOGGING 就写文件
		if (FORCE_FILE_LOGGING || debugHttp) {
			const respHeaders: Record<string, string> = {};
			response.headers.forEach((v, k) => { respHeaders[k] = v; });
			const statusLine = `[CodeBuddy] Response status: ${response.status} ${response.statusText}`;
			const headersLine = `[CodeBuddy] Response headers: ${JSON.stringify(respHeaders)}`;
			if (debugHttp) {
				console.log(statusLine);
				console.log(headersLine);
			}
			_debugRespLines.push(statusLine, headersLine);
		}

		// Parse OpenAI SSE stream — supports both text content and tool_calls
		// OpenAI tool_calls are streamed incrementally: first chunk has name + id,
		// subsequent chunks append arguments fragments.
		const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();

		await parseSSEStream(response, progress, cancellationToken, (event) => {
			// ── SSE 事件采样（受 debugHttp + FORCE_FILE_LOGGING 开关控制）──────────
			if (debugHttp || FORCE_FILE_LOGGING) {
				_debugSseCount++;
				const raw = JSON.stringify(event);
				_debugSseBytes += raw.length;
				if (_debugSseSamples.length < _debugSseMaxSamples) {
					_debugSseSamples.push(raw); // 完整记录，无截断
					_debugRespLines.push(`[SSE sample ${_debugSseSamples.length}] ${_debugSseSamples[_debugSseSamples.length - 1]}`);
				}
				// 每 20 个事件打一行进度，避免太吵
				if (_debugSseCount % 20 === 0) {
					const progressLine = `[CodeBuddy] SSE stream: ${_debugSseCount} events, ${_debugSseBytes} bytes so far...`;
					if (debugHttp) { console.log(progressLine); }
					_debugRespLines.push(progressLine);
				}
			}

			// Capture the gateway response id for stateful multi-turn association (P2).
			// OpenAI-style chunks carry a top-level `id`; some gateways also use
			// `response_id`. We stash the latest non-empty id keyed by session so the
			// next turn replays it as `previous_response_id`. Best-effort only.
			if (sessionId) {
				const respId = (typeof event.response_id === 'string' && event.response_id)
					|| (typeof event.id === 'string' && event.id);
				if (respId) {
					this._lastResponseIdBySession.set(sessionId, respId);
				}
			}

			// Final chunk usage (OpenAI-compatible). The terminal chunk carries a top-level
			// `usage` object (sibling of `choices`, which is usually empty in that chunk):
			//   { choices: [], usage: { prompt_tokens, completion_tokens, total_tokens,
			//                           prompt_tokens_details?: { cached_tokens }, credit? } }
			//
			// A provider extension cannot emit a `step` part (the ExtHost progress layer only
			// converts Text/ToolCall/Data/Thinking parts), so we tunnel usage through a
			// `LanguageModelDataPart.json(usage, MIME)`. The renderer-side bridge
			// (languageModelsBridge `_toModelDelta` → `case 'data'`) recognizes this MIME,
			// decodes it, and turns it into a `{ type: 'usage' }` delta for Token/billing UI.
			//
			// ⚠️ This MIME must stay byte-for-byte identical to `SAROSIS_USAGE_MIME` in
			// src/vs/sessions/contrib/agentStudio/browser/languageModelsBridge.ts.
			if (event.usage && typeof event.usage === 'object') {
				progress.report(
					vscode.LanguageModelDataPart.json(event.usage, 'application/vnd.saros.usage+json'),
				);
				// do not return — the usage chunk may have no choices; fall through to the
				// choices guard which will no-op when choices is empty.
			}

			// OpenAI: choices[0].delta.content
			if (event.choices && event.choices[0]) {
				const choice = event.choices[0];

				// Handle reasoning/thinking content (OpenAI-compatible `reasoning_content`).
				// Reasoning tokens stream *before* the final text answer. We surface them as a
				// LanguageModelThinkingPart so the downstream bridge maps them to a `thinking`
				// delta and the webview renders the chain-of-thought.
				//
				// NOTE: report inline (not via the callback `return`) because the callback can
				// only return a single text/tool-call result per event, and the stable
				// `LanguageModelResponsePart` union does not include ThinkingPart — hence the cast.
				if (choice.delta && choice.delta.reasoning_content) {
					progress.report(
						new vscode.LanguageModelThinkingPart(choice.delta.reasoning_content) as unknown as vscode.LanguageModelResponsePart,
					);
					// fall through: a chunk may carry both reasoning_content and content,
					// but in practice they are mutually exclusive per delta. If content also
					// exists we still handle it below.
				}

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

		// ── SSE Debug 汇总（FORCE_FILE_LOGGING 可独立于 debugHttp 触发文件写入）──
		const summaryLines: string[] = [];
		const summary0 = `[CodeBuddy] SSE stream complete: total=${_debugSseCount} events, ${_debugSseBytes} bytes`;
		if (debugHttp) {
			console.log(summary0);
		}
		summaryLines.push(summary0);
		if (_debugSseSamples.length > 0) {
			const sampleHeader = `[CodeBuddy] SSE event samples (first ${_debugSseSamples.length}):`;
			if (debugHttp) {
				console.log(sampleHeader);
			}
			summaryLines.push(sampleHeader);
			_debugSseSamples.forEach((s, i) => {
				const sampleLine = `  [${i + 1}] ${s}`;
				if (debugHttp) {
					console.log(sampleLine);
				}
				summaryLines.push(sampleLine);
			});
		}
		const endLine = `========== END HTTP DEBUG ==========`;
		if (debugHttp) {
			console.log(`${endLine}\n`);
		}
		summaryLines.push(endLine);
		// 文件写入：不受 debugHttp 限制，FORCE_FILE_LOGGING 宏可独立触发
		console.log('[CodeBuddy] REACHED: SSE stream done, about to write response log. FORCE_FILE_LOGGING=' + FORCE_FILE_LOGGING + ', _debugRespLines.length=' + _debugRespLines.length + ', summaryLines.length=' + summaryLines.length);
		if (FORCE_FILE_LOGGING || debugHttpLogFile) {
			appendHttpDebugLog([..._debugRespLines, ...summaryLines], context, sessionId, FORCE_FILE_LOGGING_PATH || undefined);
		}
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
