/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  embeddingProviders.ts — Embedding 供应商适配层（对标 Hyper-Extract CompatibleEmbeddings）。
 *
 *  设计：
 *   - IEmbeddingProviderAdapter 抽象「发送文本 → 获取向量」的协议，每个供应商实现自己的
 *     URL 拼装、请求格式、认证头。
 *   - resolveEmbeddingAdapter(config, providerId) 按 providerId 工厂式选择适配器。
 *     · OpenAI-compatible → /embeddings，Authorization: Bearer
 *     · Ollama（本地）→ /api/embeddings，无认证头
 *   - 适配器不负责分块/重试——这些由调用层的 embedTextsInBatches + embedWithRetry 承担。
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { BUILTIN_BYOK_PROVIDERS } from '../builtInBYOKModelProvider.js';
import { embedTextsViaProvider, normalizeBaseUrl, KB_FALLBACK_PROVIDER } from './builtinEmbeddingProvider.js';

// ─── Adapter interface ──────────────────────────────────────────────────────

/** 供应商级别的 embedding 适配器：知道如何向特定供应商发起向量化请求。 */
export interface IEmbeddingProviderAdapter {
	readonly providerId: string;

	/**
	 * 生成向量。
	 * @param baseUrl   provider 的 API 根地址
	 * @param apiKey    API key（本地 provider 可用 ''）
	 * @param model     模型 id
	 * @param texts     文本数组
	 * @param token     取消令牌
	 * @param log       日志回调
	 * @returns 向量数组（与 texts 同序）
	 */
	embed(
		baseUrl: string,
		apiKey: string,
		model: string,
		texts: string[],
		token: CancellationToken,
		log: (msg: string) => void,
	): Promise<number[][]>;
}

// ─── Implementations ─────────────────────────────────────────────────────────

/**
 * OpenAI-compatible 适配器（OpenRouter / 自定义 / Nous Research 等）。
 * 请求格式：POST {baseUrl}/embeddings  { model, input: [...texts] }
 * 认证：Authorization: Bearer {apiKey}
 */
class OpenAICompatibleAdapter implements IEmbeddingProviderAdapter {

	readonly providerId: string;

	constructor(providerId: string) {
		this.providerId = providerId;
	}

	async embed(
		baseUrl: string, apiKey: string, model: string,
		texts: string[], token: CancellationToken, log: (msg: string) => void,
	): Promise<number[][]> {
		return embedTextsViaProvider(baseUrl, apiKey, model, texts, token, log);
	}
}

/**
 * Ollama 本地适配器。
 * 请求格式：POST {baseUrl}/api/embeddings  { model, prompt: text }（单条）
 * 认证：无（本地服务）
 */
class OllamaAdapter implements IEmbeddingProviderAdapter {

	readonly providerId = 'ollama';

	async embed(
		baseUrl: string, _apiKey: string, model: string,
		texts: string[], token: CancellationToken,
		log: (msg: string) => void,
	): Promise<number[][]> {
		// Ollama /api/embeddings 一次只支持单条 prompt，逐条请求
		const vectors: number[][] = [];
		const url = `${normalizeBaseUrl(baseUrl)}/api/embeddings`;

		for (const text of texts) {
			if (token.isCancellationRequested) { break; }

			const body = JSON.stringify({ model, prompt: text });
			log(`calling ${url} model=${model} chars=${text.length}`);

			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				signal: token.isCancellationRequested ? AbortSignal.abort('cancelled') : undefined,
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => '');
				throw new Error(`Ollama embedding returned ${response.status}: ${errorText.slice(0, 300)}`);
			}

			const data = await response.json() as { embedding: number[] };
			vectors.push(data.embedding);
		}

		return vectors;
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * 根据 providerId 解析对应的 embedding 适配器。
 * 对标 Hyper-Extract `create_embedder()` 的 provider 分支逻辑。
 *
 * @param config 配置服务
 * @param providerId 目标 provider 的 id（如 'openrouter'、'custom'、'ollama'）
 * @returns 适配器实例，若目标 provider 已配置或已知；否则返回 undefined（调用方可降级）
 */
export function resolveEmbeddingAdapter(
	config: IConfigurationService,
	providerId: string,
): IEmbeddingProviderAdapter | undefined {
	// 按 providerId 分支（对标 Hyper-Extract client.py:409-415）
	switch (providerId) {
		case 'ollama':
			return new OllamaAdapter();
		default:
			break;
	}

	// OpenAI-compatible：需要验证 provider 确实已在配置中注册
	const def = BUILTIN_BYOK_PROVIDERS.find(p => p.id === providerId);
	if (!def) {
		return undefined;
	}

	// 验证 baseUrl + apiKey 存在（Ollama 已在上方分支处理）
	const baseUrl = (config.getValue<string>(def.baseUrlConfigKey) || '').trim() || def.defaultBaseUrl;
	const apiKeyRaw = (config.getValue<string>(def.apiKeyConfigKey) || '').trim();
	const apiKey = apiKeyRaw || (def.apiKeyOptional ? '' : '');

	if (!baseUrl || (!apiKey && !def.apiKeyOptional)) {
		// 未配置 → 不下发适配器（向上层抛配置缺失错误）
		return undefined;
	}

	return new OpenAICompatibleAdapter(providerId);
}

/**
 * 便捷工厂：解析适配器，并在解析失败时尝试回退到 KB_FALLBACK_PROVIDER。
 */
export function resolveOrFallbackAdapter(
	config: IConfigurationService,
	providerId?: string,
): IEmbeddingProviderAdapter | undefined {
	const primary = providerId ? resolveEmbeddingAdapter(config, providerId) : undefined;
	if (primary) { return primary; }
	if (providerId !== KB_FALLBACK_PROVIDER) {
		return resolveEmbeddingAdapter(config, KB_FALLBACK_PROVIDER);
	}
	return undefined;
}
