/*---------------------------------------------------------------------------------------------
 *  Voyage AI Embedding Provider — Voyage 嵌入服务（代码优化）。
 *  1:1 复刻 agentmemory src/providers/embedding/voyage.ts
 *
 *  模型: voyage-code-3 (1024 维, 针对代码场景优化)
 *
 *  环境变量：
 *    VOYAGE_API_KEY — API key（必需）
 *--------------------------------------------------------------------------------------------*/

import type { EmbeddingProvider } from './noopProvider.js';

const API_URL = 'https://api.voyageai.com/v1/embeddings';

function getEnv(key: string): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.[key];
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'voyage';
	readonly dimensions = 1024;
	private _apiKey: string;

	constructor(apiKey?: string) {
		this._apiKey = apiKey || getEnv('VOYAGE_API_KEY') || '';
		if (!this._apiKey) throw new Error('VOYAGE_API_KEY is required');
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
					model: 'voyage-code-3',
					input: texts,
					input_type: 'document',
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const err = await response.text();
				throw new Error(`Voyage embedding failed (${response.status}): ${err}`);
			}

			const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
			return data.data.map(d => new Float32Array(d.embedding));
		} finally {
			clearTimeout(timer);
		}
	}
}
