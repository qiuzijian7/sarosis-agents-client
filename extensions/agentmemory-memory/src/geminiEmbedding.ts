/*---------------------------------------------------------------------------------------------
 *  Gemini Embedding Provider — Google Gemini 嵌入服务。
 *  1:1 复刻 agentmemory src/providers/embedding/gemini.ts
 *
 *  模型: gemini-embedding-001 (768 维, 100+ 语言, MRL)
 *
 *  环境变量：
 *    GEMINI_API_KEY — API key（必需）
 *--------------------------------------------------------------------------------------------*/

import type { EmbeddingProvider } from './noopProvider.js';

const BATCH_LIMIT = 100;
const MODEL = 'models/gemini-embedding-001';
const API_BASE = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:batchEmbedContents`;

function getEnv(key: string): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.[key];
}

let _zeroNormWarned = false;

function l2Normalize(vec: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
	const norm = Math.sqrt(sum);
	if (norm === 0) {
		if (!_zeroNormWarned) {
			_zeroNormWarned = true;
			console.debug('[AgentMemory] gemini-embedding-001 returned a zero-norm embedding');
		}
		return vec;
	}
	for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
	return vec;
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'gemini';
	readonly dimensions = 768;
	private _apiKey: string;

	constructor(apiKey?: string) {
		this._apiKey = apiKey || getEnv('GEMINI_API_KEY') || '';
		if (!this._apiKey) throw new Error('GEMINI_API_KEY is required');
	}

	async embed(text: string): Promise<Float32Array | number[] | null> {
		const [result] = await this.embedBatch([text]);
		return result;
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		const results: Float32Array[] = [];

		for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
			const chunk = texts.slice(i, i + BATCH_LIMIT);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 30000);

			try {
				const response = await fetch(`${API_BASE}?key=${this._apiKey}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						requests: chunk.map(t => ({
							model: MODEL,
							content: { parts: [{ text: t }] },
							outputDimensionality: this.dimensions,
						})),
					}),
					signal: controller.signal,
				});

				if (!response.ok) {
					const err = await response.text();
					throw new Error(`Gemini embedding failed (${response.status}): ${err}`);
				}

				const data = (await response.json()) as { embeddings: Array<{ values: number[] }> };
				for (const emb of data.embeddings) {
					results.push(l2Normalize(new Float32Array(emb.values)));
				}
			} finally {
				clearTimeout(timer);
			}
		}

		return results;
	}
}
