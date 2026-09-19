/*---------------------------------------------------------------------------------------------
 *  OpenAI Embedding Provider — OpenAI 兼容的嵌入服务。
 *  1:1 复刻 agentmemory src/providers/embedding/openai.ts
 *
 *  支持 OpenAI 官方 API、Azure OpenAI、以及任何 OpenAI 兼容端点
 *  （Ollama / LM Studio / vLLM / llama.cpp）。
 *
 *  环境变量：
 *    OPENAI_API_KEY              — API key（必需）
 *    OPENAI_BASE_URL             — 基础 URL（默认 https://api.openai.com）
 *    OPENAI_EMBEDDING_MODEL      — 模型名（默认 text-embedding-3-small）
 *    OPENAI_EMBEDDING_DIMENSIONS — 覆盖维度（自定义模型时需要）
 *--------------------------------------------------------------------------------------------*/

import type { EmbeddingProvider } from './noopProvider.js';

const DEFAULT_MODEL = 'text-embedding-3-small';

const MODEL_DIMENSIONS: Record<string, number> = {
	'text-embedding-3-small': 1536,
	'text-embedding-3-large': 3072,
	'text-embedding-ada-002': 1536,
};

const DEFAULT_DIMENSIONS = 1536;

function getEnv(key: string): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.[key];
}

function resolveDimensions(model: string, override?: string): number {
	if (override && override.trim().length > 0) {
		const parsed = parseInt(override, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return MODEL_DIMENSIONS[model] ?? DEFAULT_DIMENSIONS;
}

function detectAzure(baseUrl: string): boolean {
	return baseUrl.includes('.openai.azure.com');
}

function normalizeBaseUrl(url?: string): string {
	if (!url) return 'https://api.openai.com';
	return url.replace(/\/+$/, '');
}

function buildEmbeddingUrl(baseUrl: string, isAzure: boolean, apiVersion: string): string {
	if (isAzure) {
		const base = normalizeBaseUrl(baseUrl);
		return `${base}/embeddings?api-version=${apiVersion}`;
	}
	return `${normalizeBaseUrl(baseUrl)}/v1/embeddings`;
}

function buildAuthHeaders(apiKey: string, isAzure: boolean): Record<string, string> {
	if (isAzure) {
		return { 'Content-Type': 'application/json', 'api-key': apiKey };
	}
	return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'openai';
	readonly dimensions: number;
	private _apiKey: string;
	private _baseUrl: string;
	private _model: string;
	private _isAzure: boolean;
	private _azureApiVersion: string;

	constructor(apiKey?: string) {
		this._apiKey = apiKey
			|| getEnv('OPENAI_EMBEDDING_API_KEY')
			|| getEnv('OPENAI_API_KEY')
			|| '';
		if (!this._apiKey) {
			throw new Error('API key is required (via constructor, OPENAI_EMBEDDING_API_KEY, or OPENAI_API_KEY)');
		}
		this._baseUrl = normalizeBaseUrl(
			getEnv('OPENAI_EMBEDDING_BASE_URL') || getEnv('OPENAI_BASE_URL'),
		);
		this._model = getEnv('OPENAI_EMBEDDING_MODEL') || DEFAULT_MODEL;
		this.dimensions = resolveDimensions(this._model, getEnv('OPENAI_EMBEDDING_DIMENSIONS'));
		this._isAzure = detectAzure(this._baseUrl);
		this._azureApiVersion = getEnv('OPENAI_API_VERSION') || '2024-08-01-preview';
	}

	async embed(text: string): Promise<Float32Array | number[] | null> {
		const [result] = await this.embedBatch([text]);
		return result;
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		const url = buildEmbeddingUrl(this._baseUrl, this._isAzure, this._azureApiVersion);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30000);

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: buildAuthHeaders(this._apiKey, this._isAzure),
				body: JSON.stringify({ model: this._model, input: texts }),
				signal: controller.signal,
			});

			if (!response.ok) {
				const err = await response.text();
				throw new Error(`OpenAI embedding failed (${response.status}): ${err}`);
			}

			const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
			return data.data.map(d => new Float32Array(d.embedding));
		} finally {
			clearTimeout(timer);
		}
	}
}
