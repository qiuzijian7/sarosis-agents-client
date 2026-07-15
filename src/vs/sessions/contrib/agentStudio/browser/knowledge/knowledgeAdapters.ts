/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — VS Code adapters
 *
 *  Bridges the portable engine (`IChatModel` / `IEmbedder`) to the project's
 *  existing services:
 *    - `BuiltInBYOKModelProvider` configuration  →  OpenAICompatibleJsonModel
 *    - `IAiEmbeddingVectorService`                →  IEmbedder
 *
 *  No `fetch`/network details leak into the engine; the engine only knows the
 *  `IChatModel` / `IEmbedder` contracts.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IAiEmbeddingVectorService } from '../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { BUILTIN_BYOK_PROVIDERS } from '../builtInBYOKModelProvider.js';
import { IChatModel, OpenAICompatibleJsonModel } from './engine/llm.js';
import { IEmbedder } from './engine/embedder.js';
import { resolveEmbeddingConfigForProvider, embedTextsViaProvider } from './builtinEmbeddingProvider.js';

/** Per-provider sensible default model ids (override via tool `model` arg). */
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
	openrouter: 'openai/gpt-4o-mini',
	nous: 'nousresearch/deepseek-r1',
	gemini: 'gemini-2.0-flash',
	anthropic: 'claude-3-5-haiku-20241022',
	ollama: 'llama3.1',
	main: 'gpt-4o-mini',
	custom: 'gpt-4o-mini',
};

export interface ResolveChatModelOpts {
	/** BYOK provider id (e.g. 'openrouter'). Default: 'openrouter'. */
	providerId?: string;
	/** Model id. Falls back to the provider's default model. */
	modelId?: string;
}

/**
 * Build an `IChatModel` from the user's configured BYOK provider.
 * Reads the provider's base URL + API key from Settings, then delegates to the
 * engine's OpenAI-compatible JSON model (which already implements the
 * json_schema → tool_call → instructed-JSON fallback ladder).
 */
export function resolveChatModel(config: IConfigurationService, opts: ResolveChatModelOpts = {}): IChatModel {
	const def = BUILTIN_BYOK_PROVIDERS.find(p => p.id === (opts.providerId ?? 'openrouter'))
		?? BUILTIN_BYOK_PROVIDERS[0];

	const configuredBase = (config.getValue<string>(def.baseUrlConfigKey) || '').trim();
	const baseUrl = configuredBase || def.defaultBaseUrl;
	const apiKey = (config.getValue<string>(def.apiKeyConfigKey) || '').trim();
	const model = (opts.modelId?.trim())
		|| DEFAULT_MODEL_BY_PROVIDER[def.id]
		|| def.staticModels?.[0]?.id
		|| 'gpt-4o-mini';

	if (!baseUrl) {
		throw new Error(`Knowledge tools: provider "${def.id}" has no base URL configured (set it in Settings).`);
	}

	return new OpenAICompatibleJsonModel({
		baseUrl,
		apiKey,
		model,
		timeoutMs: 180_000,
		verboseFallback: true,
		// P2 修复：Electron renderer sandbox 中 globalThis.fetch 直接调用会触发
		// "Illegal invocation"。Arrow wrapper 保留 this 绑定。
		fetchImpl: (input, init) => globalThis.fetch(input, init),
	});
}

/**
 * Wrap `IAiEmbeddingVectorService` as the engine's `IEmbedder`.
 * The engine only needs embed(texts) → vectors[]; the project's embedding
 * provider supplies the actual vectors.
 *
 * With the built-in BYOK embedding provider (Phase 1), this will work
 * out of the box when the user has configured a model provider in Settings.
 */
export function createEmbedder(svc: IAiEmbeddingVectorService): IEmbedder {
	if (!svc.isEnabled()) {
		throw new Error(
			'Knowledge tools: embedding service is not enabled. ' +
			'Configure a model provider (OpenRouter / custom OpenAI-compatible) in Settings → Agent Studio → Model Providers.',
		);
	}
	return {
		// dimensions 由首次 embed 调用后动态探测
		dimensions: undefined,
		async embed(texts: string[]): Promise<number[][]> {
			const v = await svc.getEmbeddingVector(texts, CancellationToken.None);
			return v as number[][];
		},
		async embedOne(text: string): Promise<number[]> {
			const v = await svc.getEmbeddingVector([text], CancellationToken.None) as number[][];
			return v[0];
		},
	};
}

export type { ILogService };

/**
 * 知识库专属 embedder：使用指定 BYOK provider 的 baseUrl/apiKey（即知识库 agent
 * 当前配置的 provider），模型取传入的 embedding 模型（复用 embedding 设置）。
 *
 * 这与 `createEmbedder`（走全局 IAiEmbeddingVectorService）不同：KB 操作的 embedding
 * 必须跟着知识库 agent 的 provider 走，而非遍历所有 provider 取首个可用。
 */
export function createKbEmbedder(
	config: IConfigurationService,
	logService: ILogService,
	opts: { providerId: string; model: string; dimensions: number },
): IEmbedder {
	const log = (msg: string) => logService.trace(`[KbEmbedder] ${msg}`);

	const resolved = resolveEmbeddingConfigForProvider(config, opts.providerId);
	if (!resolved) {
		throw new Error(
			`KbEmbedder: provider "${opts.providerId}" is not configured. ` +
			'Configure its API key/base URL in Settings → Agent Studio → Model Providers.'
		);
	}

	const baseUrl = resolved.baseUrl;
	const apiKey = resolved.apiKey;
	const model = opts.model?.trim() || resolved.model;
	const dimensions = opts.dimensions || resolved.dimensions;

	return {
		dimensions,
		async embed(texts: string[]): Promise<number[][]> {
			return embedTextsViaProvider(baseUrl, apiKey, model, texts, CancellationToken.None, log);
		},
		async embedOne(text: string): Promise<number[]> {
			const v = await embedTextsViaProvider(baseUrl, apiKey, model, [text], CancellationToken.None, log);
			return v[0];
		},
	};
}
