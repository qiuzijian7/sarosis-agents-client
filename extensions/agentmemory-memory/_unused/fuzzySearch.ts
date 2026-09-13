/*---------------------------------------------------------------------------------------------
 *  模糊搜索 — 容错搜索（拼写错误 + 部分匹配）。
 *
 *  与现有 BM25/Vector 搜索的区别：
 *    - BM25：精确 token 匹配 + TF-IDF 权重
 *    - Vector：语义相似度
 *    - FuzzySearch：字符级容错（Levenshtein + n-gram）
 *
 *  适用场景：
 *    1. 用户拼写错误（如 "authentiction" → "authentication"）
 *    2. 部分匹配（如搜索 "memory" 匹配 "memories"）
 *    3. CJK 容错（如搜索 "认证" 匹配 "身份认证"）
 *--------------------------------------------------------------------------------------------*/

export interface FuzzyResult {
	id: string;
	content: string;
	score: number;
	matchType: 'exact' | 'prefix' | 'substring' | 'fuzzy' | 'ngram';
	matchedTerm?: string;
}

export interface FuzzySearchOptions {
	threshold?: number;        // 最小匹配分数（0-1，默认 0.6）
	maxDistance?: number;      // 最大编辑距离（默认 2）
	ngramSize?: number;        // n-gram 大小（默认 2）
	limit?: number;            // 结果数限制（默认 20）
}

const DEFAULT_OPTIONS: FuzzySearchOptions = {
	threshold: 0.6,
	maxDistance: 2,
	ngramSize: 2,
	limit: 20,
};

/**
 * Levenshtein 编辑距离（带提前终止）
 */
function levenshtein(a: string, b: string, maxDist: number): number {
	const m = a.length;
	const n = b.length;
	if (Math.abs(m - n) > maxDist) return maxDist + 1;

	const prev = new Array(n + 1);
	const curr = new Array(n + 1);

	for (let j = 0; j <= n; j++) prev[j] = j;

	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		let minInRow = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				prev[j] + 1,      // deletion
				curr[j - 1] + 1,  // insertion
				prev[j - 1] + cost, // substitution
			);
			minInRow = Math.min(minInRow, curr[j]);
		}
		if (minInRow > maxDist) return maxDist + 1;
		// Swap
		for (let j = 0; j <= n; j++) prev[j] = curr[j];
	}

	return prev[n];
}

/**
 * 生成 n-gram 集合
 */
function ngrams(text: string, n: number): Set<string> {
	const grams = new Set<string>();
	const normalized = text.toLowerCase().replace(/\s+/g, '');
	for (let i = 0; i <= normalized.length - n; i++) {
		grams.add(normalized.slice(i, i + n));
	}
	return grams;
}

/**
 * Jaccard 相似度
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const g of a) {
		if (b.has(g)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union > 0 ? intersection / union : 0;
}

/**
 * 提取所有 token
 */
function tokenize(text: string): string[] {
	return text.toLowerCase()
		.split(/[\s,.!?;:'"()\[\]{}|\\/<>@#$%^&*+=~`]+/)
		.filter(t => t.length > 0);
}

export class FuzzySearcher {
	/**
	 * 模糊搜索
	 */
	search(query: string, entries: Array<{ id: string; content: string }>, options?: FuzzySearchOptions): FuzzyResult[] {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const results: FuzzyResult[] = [];
		const queryLower = query.toLowerCase().trim();
		const queryTokens = tokenize(queryLower);
		const queryNgrams = ngrams(queryLower, opts.ngramSize!);

		for (const entry of entries) {
			const contentLower = entry.content.toLowerCase();
			let bestScore = 0;
			let bestMatch: FuzzyResult['matchType'] = 'fuzzy';
			let matchedTerm: string | undefined;

			// 1. 精确匹配
			if (contentLower.includes(queryLower)) {
				bestScore = 1.0;
				bestMatch = 'exact';
				matchedTerm = queryLower;
			}

			// 2. Token 级匹配
			if (bestScore < 1.0) {
				for (const qToken of queryTokens) {
					// 前缀匹配
					const contentTokens = tokenize(contentLower);
					for (const cToken of contentTokens) {
						if (cToken.startsWith(qToken) && qToken.length >= 3) {
							const score = qToken.length / cToken.length;
							if (score > bestScore) {
								bestScore = score;
								bestMatch = 'prefix';
								matchedTerm = cToken;
							}
						}

						// 子串匹配
						if (cToken.includes(qToken) && qToken.length >= 2) {
							const score = 0.8 * (qToken.length / cToken.length);
							if (score > bestScore) {
								bestScore = score;
								bestMatch = 'substring';
								matchedTerm = cToken;
							}
						}

						// 模糊匹配（Levenshtein）
						if (qToken.length >= 3 && cToken.length >= 3) {
							const dist = levenshtein(qToken, cToken, opts.maxDistance!);
							if (dist <= opts.maxDistance!) {
								const score = 1 - dist / Math.max(qToken.length, cToken.length);
								if (score > bestScore) {
									bestScore = score * 0.9; // 模糊匹配折扣
									bestMatch = 'fuzzy';
									matchedTerm = cToken;
								}
							}
						}
					}
				}
			}

			// 3. N-gram 匹配
			if (bestScore < opts.threshold!) {
				const contentNgrams = ngrams(contentLower, opts.ngramSize!);
				const ngramScore = jaccardSimilarity(queryNgrams, contentNgrams);
				if (ngramScore > bestScore) {
					bestScore = ngramScore;
					bestMatch = 'ngram';
				}
			}

			if (bestScore >= opts.threshold!) {
				results.push({
					id: entry.id,
					content: entry.content,
					score: bestScore,
					matchType: bestMatch,
					matchedTerm,
				});
			}
		}

		results.sort((a, b) => b.score - a.score);
		return results.slice(0, opts.limit);
	}

	/**
	 * 搜索建议（基于已有内容）
	 */
	suggest(query: string, entries: Array<{ id: string; content: string }>, limit: number = 5): string[] {
		const queryLower = query.toLowerCase().trim();
		if (queryLower.length < 2) return [];

		const suggestions = new Map<string, number>();
		const queryTokens = tokenize(queryLower);

		for (const entry of entries) {
			const contentTokens = tokenize(entry.content.toLowerCase());
			for (const cToken of contentTokens) {
				for (const qToken of queryTokens) {
					if (cToken.startsWith(qToken) && cToken !== qToken && cToken.length > qToken.length) {
						suggestions.set(cToken, (suggestions.get(cToken) ?? 0) + 1);
					}
					// 模糊匹配前缀
					if (qToken.length >= 3 && cToken.length >= 3) {
						const dist = levenshtein(qToken, cToken.slice(0, qToken.length), 1);
						if (dist <= 1 && cToken.length > qToken.length) {
							suggestions.set(cToken, (suggestions.get(cToken) ?? 0) + 0.5);
						}
					}
				}
			}
		}

		return Array.from(suggestions.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([term]) => term);
	}
}
