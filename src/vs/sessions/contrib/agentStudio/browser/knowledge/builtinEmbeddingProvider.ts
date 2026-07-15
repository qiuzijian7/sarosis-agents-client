/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  BuiltinEmbeddingProvider — 内置 Embedding Provider (Phase 1 Plan-A fallback).
 *
 *  复用用户已配置的 BYOK API（OpenRouter / 自定义 OpenAI-compatible）的
 *  `/v1/embeddings` 端点，无需额外配置。这使 `kb_*` 工具在无扩展注册
 *  embedding provider 时也能正常工作。
 *
 *  设计：
 *    - 读取用户 BYOK provider 配置（base URL + API key）
 *    - 调用 `POST {baseUrl}/embeddings`（OpenAI 标准格式）
 *    - 默认使用 `text-embedding-3-small` 模型（512 维，性价比最高）
 *    - 自动降级：若指定模型不可用，回退到 `text-embedding-ada-002`（1536 维）
 *
 *  注册路径：
 *    BuiltinToolProvider 构造函数 → provider.registerEmbeddingProvider(this.embeddingService)
 *    → IAiEmbeddingVectorService.registerAiEmbeddingVectorProvider(...)
 *    → createEmbedder() 的 isEnabled() 返回 true → 所有 kb_* 工具激活
 *--------------------------------------------------------------------------------------------*/

import { IAiEmbeddingVectorProvider } from '../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { BUILTIN_BYOK_PROVIDERS } from '../builtInBYOKModelProvider.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';

/**
 * P2 修复：Electron renderer sandbox 中 `globalThis.fetch` 直接调用会触发
 * "Illegal invocation"。Arrow wrapper 保留正确的 this 绑定。
 */
const safeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmbeddingProviderConfig {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly model: string;
	readonly dimensions: number;
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/** 默认 embedding 模型配置表 */
export const DEFAULT_EMBEDDING_CONFIG: Record<string, { model: string; dimensions: number }> = {
	openrouter: { model: 'text-embedding-3-small', dimensions: 512 },
	custom: { model: 'text-embedding-3-small', dimensions: 512 },
	main: { model: 'text-embedding-3-small', dimensions: 512 },
	nous: { model: 'text-embedding-3-small', dimensions: 512 },
	ollama: { model: 'nomic-embed-text', dimensions: 768 },
};

/** Fallback embedding 模型：更广泛兼容的旧模型 */
export const FALLBACK_EMBEDDING_MODEL = 'text-embedding-ada-002';

/** 确保 baseUrl 不以 / 结尾，以正确拼接 /embeddings 路径 */
export function normalizeBaseUrl(url: string): string {
	let u = url.trim();
	while (u.endsWith('/')) { u = u.slice(0, -1); }
	// 一些 provider 的 baseUrl 已包含 /v1，确保不重复
	return u;
}

/**
 * 为指定的 BYOK provider 解析 embedding 配置（baseUrl / apiKey / 默认模型 / 维度）。
 * 若该 provider 未配置 baseUrl 或 key，返回 null。供知识库专属 embedder 复用。
 */
export function resolveEmbeddingConfigForProvider(
	config: IConfigurationService,
	providerId: string,
): EmbeddingProviderConfig | null {
	const def = BUILTIN_BYOK_PROVIDERS.find(p => p.id === providerId);
	if (!def) { return null; }

	const baseUrl = (config.getValue<string>(def.baseUrlConfigKey) || '').trim() || def.defaultBaseUrl;
	const apiKey = (config.getValue<string>(def.apiKeyConfigKey) || '').trim();

	// 跳过不需要 API key 的 provider（Ollama 本地）
	const effectiveApiKey = apiKey || (def.apiKeyOptional ? 'local' : '');
	if (!baseUrl || !effectiveApiKey) {
		return null;
	}

	const embConf = DEFAULT_EMBEDDING_CONFIG[def.id];
	const model = embConf?.model ?? DEFAULT_EMBEDDING_CONFIG['openrouter']!.model;
	const dimensions = embConf?.dimensions ?? DEFAULT_EMBEDDING_CONFIG['openrouter']!.dimensions;
	return { baseUrl: normalizeBaseUrl(baseUrl), apiKey: effectiveApiKey, model, dimensions };
}

/** 按遍历优先级解析首个可用的 embedding 配置（内置 provider 注册兜底用）。 */
function resolveEmbeddingConfig(config: IConfigurationService): EmbeddingProviderConfig | null {
	// 按优先级尝试 BYOK providers：openrouter → custom → 其他
	for (const def of BUILTIN_BYOK_PROVIDERS) {
		const cfg = resolveEmbeddingConfigForProvider(config, def.id);
		if (cfg) { return cfg; }
	}
	return null;
}

/**
 * 调用单个 provider 的 /embeddings 端点，含 fallback 模型降级。
 * 抽出为可复用函数，供内置 provider 与知识库专属 embedder共用。
 */
export async function embedTextsViaProvider(
	baseUrl: string,
	apiKey: string,
	model: string,
	texts: string[],
	token: CancellationToken,
	log: (msg: string) => void,
): Promise<number[][]> {
	const url = `${baseUrl}/embeddings`;
	const body = JSON.stringify({ model, input: texts });

	log(`calling ${url} model=${model} texts=${texts.length}`);

		try {
		const response = await safeFetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body,
			signal: token.isCancellationRequested ? AbortSignal.abort('cancelled') : undefined,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => '');
			throw new Error(`Embedding API returned ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json() as {
			data: Array<{ embedding: number[]; index: number }>;
			usage?: { total_tokens: number };
		};

		const sorted = [...data.data].sort((a, b) => a.index - b.index);
		const vectors = sorted.map(d => d.embedding);

		if (vectors.length !== texts.length) {
			throw new Error(`Mismatch: requested ${texts.length} embeddings, got ${vectors.length}`);
		}

		const usage = data.usage;
		if (usage) {
			log(`embedded ${texts.length} texts, total_tokens=${usage.total_tokens}, dims=${vectors[0]?.length ?? '?'}`);
		}
		return vectors;
	} catch (err) {
		// 403/404 等模型不可用错误 → 尝试 fallback 模型
		if (model !== FALLBACK_EMBEDDING_MODEL && !(err instanceof DOMException)) {
			log(`primary model ${model} failed (${err}), trying fallback ${FALLBACK_EMBEDDING_MODEL}...`);
			const fallbackUrl = `${baseUrl}/embeddings`;
			const fallbackBody = JSON.stringify({ model: FALLBACK_EMBEDDING_MODEL, input: texts });

			const fbResp = await safeFetch(fallbackUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`,
				},
				body: fallbackBody,
				signal: token.isCancellationRequested ? AbortSignal.abort('cancelled') : undefined,
			});

			if (!fbResp.ok) {
				const fbError = await fbResp.text().catch(() => '');
				throw new Error(`Fallback embedding failed ${fbResp.status}: ${fbError.slice(0, 300)}`);
			}

			const fbData = await fbResp.json() as { data: Array<{ embedding: number[]; index: number }> };
			const fbSorted = [...fbData.data].sort((a, b) => a.index - b.index);

			log(`fallback ${FALLBACK_EMBEDDING_MODEL} succeeded: ${fbSorted.length} vectors, dims=${fbSorted[0]?.embedding.length ?? '?'}`);
			return fbSorted.map(d => d.embedding);
		}

		throw err;
	}
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export function createBuiltinEmbeddingProvider(
	config: IConfigurationService,
	logService: ILogService,
): IAiEmbeddingVectorProvider {
	const log = (msg: string) => logService.trace(`[BuiltinEmbedding] ${msg}`);

	return {
		async provideAiEmbeddingVector(strings: string[], token: CancellationToken): Promise<number[][]> {
			// 每次调用都重新解析配置（用户可能在运行时更改）
			const resolved = resolveEmbeddingConfig(config);
			if (!resolved) {
				throw new Error(
					'BuiltinEmbedding: no BYOK provider configured. ' +
					'Configure an OpenAI-compatible API (OpenRouter / custom) in Settings → Agent Studio → Model Providers.'
				);
			}

			return embedTextsViaProvider(resolved.baseUrl, resolved.apiKey, resolved.model, strings, token, log);
		},
	};
}

/**
 * 解析当前 embedding 向量的维度（从配置推断，无需调用 API）。
 * 返回 0 表示未知（由 createEmbedder 动态探测）。
 */
export function resolveEmbeddingDimensions(config: IConfigurationService): number {
	const resolved = resolveEmbeddingConfig(config);
	return resolved?.dimensions ?? 0;
}
