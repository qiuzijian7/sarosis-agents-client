/*---------------------------------------------------------------------------------------------
 *  BM25 搜索索引 — 基于 Okapi BM25 算法的关键词检索。
 *  1:1 复刻 agentmemory src/state/search-index.ts
 *  参数: k1=1.2 (词频饱和), b=0.75 (文档长度归一化)
 *
 *  使用完整 Porter 词干化 + CJK 分词（jieba/bigram 降级）。
 *--------------------------------------------------------------------------------------------*/

import { stem as stemPorter } from './stemmer.js';
import { segmentCjk, hasCjk } from './cjkSegmenter.js';
import { getSynonyms } from './synonyms.js';

export interface BM25SearchResult {
	id: string;
	score: number;
}

export class BM25Index {
	private entries = new Map<string, { id: string; termCount: number }>();
	private invertedIndex = new Map<string, Set<string>>();
	private docTermCounts = new Map<string, Map<string, number>>();
	private totalDocLength = 0;
	/** 惰性排序缓存：词条排序后缓存，写操作时失效（1:1 对齐 agentmemory search-index.ts） */
	private _sortedTerms: string[] | null = null;
	private readonly k1 = 1.2;
	private readonly b = 0.75;

	private stem(word: string): string {
		return stemPorter(word);
	}

	private hasCJK(text: string): boolean {
		return hasCjk(text);
	}

	private tokenize(text: string): string[] {
		const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s/.\\-_]/gu, ' ');
		const out: string[] = [];
		// Use CJK segmenter for CJK text
		const segments = segmentCjk(cleaned);
		for (const raw of segments) {
			if (this.hasCJK(raw)) {
				// CJK segment: use as-is (already segmented by jieba/bigram)
				if (raw.trim().length >= 2) out.push(raw.trim());
			} else {
				// Latin segment: split by whitespace and stem
				for (const word of raw.split(/\s+/)) {
					if (word.length < 2) continue;
					out.push(this.stem(word));
				}
			}
		}
		return out;
	}

	add(id: string, content: string): void {
		if (this.entries.has(id)) this.remove(id);
		const terms = this.tokenize(content);
		const termFreq = new Map<string, number>();
		let termCount = 0;
		for (const term of terms) {
			termFreq.set(term, (termFreq.get(term) || 0) + 1);
			termCount++;
		}
		this.entries.set(id, { id, termCount });
		this.docTermCounts.set(id, termFreq);
		this.totalDocLength += termCount;
		for (const term of termFreq.keys()) {
			if (!this.invertedIndex.has(term)) {
				this.invertedIndex.set(term, new Set());
			}
			this.invertedIndex.get(term)!.add(id);
		}
		this._sortedTerms = null; // 写时失效
	}

	remove(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		const termFreq = this.docTermCounts.get(id);
		if (termFreq) {
			for (const term of termFreq.keys()) {
				const posting = this.invertedIndex.get(term);
				if (posting) {
					posting.delete(id);
					if (posting.size === 0) this.invertedIndex.delete(term);
				}
			}
			this.docTermCounts.delete(id);
		}
		this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
		this.entries.delete(id);
		this._sortedTerms = null; // 写时失效
	}

	search(query: string, limit = 20): BM25SearchResult[] {
		const queryTerms = this.tokenize(query);
		if (queryTerms.length === 0 || this.entries.size === 0) return [];
		const N = this.entries.size;
		const avgDocLen = this.totalDocLength / N;
		const scores = new Map<string, number>();

		// P10: 同义词扩展加权（对齐 agentmemory search-index.ts L88-101）
		// 精确匹配 weight=1.0, 同义词 weight=0.7, 前缀匹配 weight=0.5
		const expandedTerms: Array<{ term: string; weight: number }> = [];
		const seen = new Set<string>();
		for (const term of queryTerms) {
			if (!seen.has(term)) {
				seen.add(term);
				expandedTerms.push({ term, weight: 1.0 });
			}
			for (const syn of getSynonyms(term)) {
				if (!seen.has(syn)) {
					seen.add(syn);
					expandedTerms.push({ term: syn, weight: 0.7 });
				}
			}
		}

		// P1: 惰性排序缓存 — 避免每次搜索都对倒排索引重新排序
		const sorted = this._getSortedTerms();

		for (const { term, weight } of expandedTerms) {
			// 精确词条匹配（主 IDF 权重 * weight）
			const matchingDocs = this.invertedIndex.get(term);
			if (matchingDocs) {
				const df = matchingDocs.size;
				const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
				for (const id of matchingDocs) {
					const entry = this.entries.get(id)!;
					const docTerms = this.docTermCounts.get(id);
					const tf = docTerms?.get(term) || 0;
					if (tf === 0) continue;
					const docLen = entry.termCount;
					const numerator = tf * (this.k1 + 1);
					const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
					scores.set(id, (scores.get(id) || 0) + idf * (numerator / denominator) * weight);
				}
			}

			// P1: 前缀匹配 — 用 lowerBound 二分查找起始位置，线性扫描匹配前缀的词条
			// 前缀匹配 weight=0.5（在精确 weight 基础上再减半）
			const startIdx = this._lowerBound(sorted, term);
			for (let si = startIdx; si < sorted.length; si++) {
				const indexTerm = sorted[si];
				if (!indexTerm.startsWith(term)) break;
				if (indexTerm === term) continue; // 已在精确匹配中处理

				const obsIds = this.invertedIndex.get(indexTerm)!;
				const prefixDf = obsIds.size;
				const prefixIdf = Math.log((N - prefixDf + 0.5) / (prefixDf + 0.5) + 1) * 0.5 * weight; // 前缀 IDF 减半 * term weight
				for (const id of obsIds) {
					const entry = this.entries.get(id)!;
					const docTerms = this.docTermCounts.get(id);
					const tf = docTerms?.get(indexTerm) || 0;
					if (tf === 0) continue;
					const docLen = entry.termCount;
					const numerator = tf * (this.k1 + 1);
					const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
					scores.set(id, (scores.get(id) || 0) + prefixIdf * (numerator / denominator));
				}
			}
		}

		return Array.from(scores.entries())
			.map(([id, score]) => ({ id, score }))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	get size(): number { return this.entries.size; }

	clear(): void {
		this.entries.clear();
		this.invertedIndex.clear();
		this.docTermCounts.clear();
		this.totalDocLength = 0;
		this._sortedTerms = null; // 写时失效
	}

	// ─── P1: 惰性排序缓存（1:1 对齐 agentmemory search-index.ts）───

	/** 获取排序后的词条列表（惰性缓存） */
	private _getSortedTerms(): string[] {
		if (!this._sortedTerms) {
			this._sortedTerms = Array.from(this.invertedIndex.keys()).sort();
		}
		return this._sortedTerms;
	}

	/** 二分查找：返回第一个 >= target 的位置 */
	private _lowerBound(arr: string[], target: string): number {
		let lo = 0, hi = arr.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (arr[mid] < target) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}
}
