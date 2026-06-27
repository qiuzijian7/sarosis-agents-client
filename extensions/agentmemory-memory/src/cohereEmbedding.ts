/*---------------------------------------------------------------------------------------------
 *  Cohere Embedding Provider — Cohere 嵌入服务。
 *  1:1 复刻 agentmemory src/providers/embedding/cohere.ts
 *
 *  模型: embed-english-v3.0 (1024 维)
 *
 *  环境变量：
 *    COHERE_API_KEY — API key（必需）
 *--------------------------------------------------------------------------------------------*/

import type { EmbeddingProvider } from './noopProvider.js';

const API_URL = 'https://api.cohere.ai/v1/embed';

function getEnv(key: string): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.[key];
}

export class CohereEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'cohere';
	readonly dimensions = 1024;
	private _apiKey: string;

	constructor(apiKey?: string) {
		this._apiKey = apiKey || getEnv('COHERE_API_KEY') || '';
		if (!this._apiKey) throw new Error('COHERE_API_KEY is required');
	}

	async embed(text: string): Promise<Float32Array | number[] | null> {
		const [result] = await this.embedBatch([text]);
		return result;
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30000);

		try {
			const response = await fetch(API_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this._apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: 'embed-english-v3.0',
					texts,
					input_type: 'search_document',
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const err = await response.text();
				throw new Error(`Cohere embedding failed (${response.status}): ${err}`);
			}

			const data = (await response.json()) as { embeddings: number[][] };
			return data.embeddings.map(e => new Float32Array(e));
		} finally {
			clearTimeout(timer);
		}
	}
}
