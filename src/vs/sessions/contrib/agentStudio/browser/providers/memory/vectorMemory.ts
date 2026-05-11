/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMemoryEntry } from '../../../common/providers.js';

/**
 * 简化的向量记忆实现（基于 TF-IDF）
 * 
 * 后续可替换为真正的向量数据库（如 Pinecone、Chroma）。
 */

interface IVectorEntry {
	entry: IMemoryEntry;
	vector: number[];
}

export class VectorMemory {

	private readonly _entries: IVectorEntry[] = [];
	private readonly _vocab: Map<string, number> = new Map();

	/**
	 * 计算文本的简单 TF-IDF 向量
	 */
	computeEmbedding(text: string): number[] {
		const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 0);
		const tf = new Map<string, number>();
		
		words.forEach(word => {
			tf.set(word, (tf.get(word) || 0) + 1);
		});

		// 构建向量（简化版，实际应使用完整的 vocab）
		const vector: number[] = [];
		const uniqueWords = Array.from(new Set(words));
		
		uniqueWords.forEach(word => {
			if (!this._vocab.has(word)) {
				this._vocab.set(word, this._vocab.size);
			}
			const idx = this._vocab.get(word)!;
			if (idx >= vector.length) {
				vector.length = idx + 1;
				for (let i = 0; i <= idx; i++) {
					if (vector[i] === undefined) {
						vector[i] = 0;
					}
				}
			}
			vector[idx] = tf.get(word) || 0;
		});

		return vector;
	}

	/**
	 * 搜索相似记忆
	 */
	searchSimilar(query: string, entries: IMemoryEntry[], topK: number = 5): IMemoryEntry[] {
		const queryVector = this.computeEmbedding(query);
		
		const scored = entries.map(entry => {
			const entryVector = this.computeEmbedding(entry.content);
			const score = this._cosineSimilarity(queryVector, entryVector);
			return { entry, score };
		});

		scored.sort((a, b) => b.score - a.score);
		
		return scored.slice(0, topK).map(item => item.entry);
	}

	/**
	 * 保存向量
	 */
	saveVector(entry: IMemoryEntry): void {
		const vector = this.computeEmbedding(entry.content);
		this._entries.push({ entry, vector });
	}

	private _cosineSimilarity(a: number[], b: number[]): number {
		const maxLen = Math.max(a.length, b.length);
		const vecA = new Array(maxLen).fill(0);
		const vecB = new Array(maxLen).fill(0);
		
		a.forEach((val, idx) => vecA[idx] = val);
		b.forEach((val, idx) => vecB[idx] = val);

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < maxLen; i++) {
			dotProduct += vecA[i] * vecB[i];
			normA += vecA[i] * vecA[i];
			normB += vecB[i] * vecB[i];
		}

		const denominator = Math.sqrt(normA) * Math.sqrt(normB);
		return denominator === 0 ? 0 : dotProduct / denominator;
	}
}
