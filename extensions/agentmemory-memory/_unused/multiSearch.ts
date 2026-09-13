/*---------------------------------------------------------------------------------------------
 *  G8/G9: 多策略检索 + Re-ranker — 对齐 cognee modules/search/adapter.py
 *
 *  策略:
 *    graph_only   — 仅图谱搜索
 *    vector_only  — 仅向量搜索
 *    hybrid       — BM25 + Vector RRF 融合 (默认)
 *    graph_first  — 图谱优先，向量补充
 *    vector_first — 向量优先，图谱补充
 *
 *  Re-ranker:
 *    Cross-encoder 风格的轻量级重新排序 (TF-IDF + 位置加权)
 *--------------------------------------------------------------------------------------------*/

export enum SearchStrategy {
	GraphOnly = 'graph_only',
	VectorOnly = 'vector_only',
	Hybrid = 'hybrid',
	GraphFirst = 'graph_first',
	VectorFirst = 'vector_first',
}

export interface SearchResult {
	id: string;
	content: string;
	score: number;
	source: 'bm25' | 'vector' | 'graph' | 'reranked';
	metadata?: Record<string, unknown>;
}

export interface SearchOptions {
	strategy?: SearchStrategy;
	limit?: number;
	rerank?: boolean;
	rerankTopK?: number;
}

/**
 * G9: 轻量级 Re-ranker — TF-IDF + 位置加权
 * 对齐 cognee Cross-encoder re-ranking，但不依赖外部模型
 */
export function rerankResults(
	query: string,
	results: SearchResult[],
	topK: number = 10,
): SearchResult[] {
	if (results.length === 0) return results;

	const queryTerms = query.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 1);

	if (queryTerms.length === 0) return results.slice(0, topK);

	// 计算 TF-IDF + 位置加权分数
	const scored = results.map(r => {
		const contentLower = r.content.toLowerCase();
		let tfidfScore = 0;
		let positionBonus = 0;

		for (const term of queryTerms) {
			// TF: 词频
			const matches = contentLower.split(term).length - 1;
			tfidfScore += matches;

			// 位置加权: 词出现在前 200 字符中加分
			const firstIdx = contentLower.indexOf(term);
			if (firstIdx >= 0 && firstIdx < 200) {
				positionBonus += 0.5;
			}
		}

		// 归一化 TF-IDF (除以内容长度)
		const normalizedTf = tfidfScore / Math.max(1, r.content.length / 1000);
		// 综合分数: 原始分数 (40%) + TF-IDF (40%) + 位置 (20%)
		const rerankedScore = r.score * 0.4 + normalizedTf * 0.4 + positionBonus * 0.2;

		return {
			...r,
			score: rerankedScore,
			source: 'reranked' as const,
		};
	});

	// 按重排分数降序
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topK);
}

/**
 * G8: 多策略搜索调度器
 * 根据策略选择不同的搜索路径
 */
export async function executeSearch(
	query: string,
	options: SearchOptions,
	searchFns: {
		bm25Search?: (query: string, limit: number) => SearchResult[];
		vectorSearch?: (query: string, limit: number) => Promise<SearchResult[]>;
		graphSearch?: (query: string, limit: number) => SearchResult[];
	},
): Promise<SearchResult[]> {
	const strategy = options.strategy ?? SearchStrategy.Hybrid;
	const limit = options.limit ?? 20;
	const rerank = options.rerank ?? true;
	const rerankTopK = options.rerankTopK ?? Math.min(limit * 2, 40);

	let results: SearchResult[] = [];

	switch (strategy) {
		case SearchStrategy.GraphOnly:
			results = searchFns.graphSearch?.(query, limit) ?? [];
			break;

		case SearchStrategy.VectorOnly:
			results = await searchFns.vectorSearch?.(query, limit) ?? [];
			break;

		case SearchStrategy.GraphFirst: {
			// 图谱优先 (limit * 0.7)，向量补充 (limit * 0.3)
			const graphResults = searchFns.graphSearch?.(query, Math.ceil(limit * 0.7)) ?? [];
			const vectorResults = await searchFns.vectorSearch?.(query, Math.ceil(limit * 0.3)) ?? [];
			results = [...graphResults, ...vectorResults];
			break;
		}

		case SearchStrategy.VectorFirst: {
			// 向量优先 (limit * 0.7)，图谱补充 (limit * 0.3)
			const vectorResults = await searchFns.vectorSearch?.(query, Math.ceil(limit * 0.7)) ?? [];
			const graphResults = searchFns.graphSearch?.(query, Math.ceil(limit * 0.3)) ?? [];
			results = [...vectorResults, ...graphResults];
			break;
		}

		case SearchStrategy.Hybrid:
		default: {
			// BM25 + Vector 并行搜索 + RRF 融合
			const bm25Results = searchFns.bm25Search?.(query, limit * 2) ?? [];
			const vectorResults = await searchFns.vectorSearch?.(query, limit * 2) ?? [];
			results = rrfFusion(bm25Results, vectorResults, limit * 2);
			break;
		}
	}

	// G9: Re-rank
	if (rerank && results.length > 0) {
		results = rerankResults(query, results, rerankTopK);
	}

	return results.slice(0, limit);
}

/**
 * RRF (Reciprocal Rank Fusion) 融合
 */
function rrfFusion(
	bm25Results: SearchResult[],
	vectorResults: SearchResult[],
	limit: number,
): SearchResult[] {
	const K = 60; // RRF 平滑常数
	const scores = new Map<string, { result: SearchResult; score: number }>();

	// BM25 贡献
	bm25Results.forEach((r, i) => {
		const existing = scores.get(r.id);
		const rrfScore = 1 / (K + i + 1);
		if (existing) {
			existing.score += rrfScore;
		} else {
			scores.set(r.id, { result: r, score: rrfScore });
		}
	});

	// Vector 贡献
	vectorResults.forEach((r, i) => {
		const existing = scores.get(r.id);
		const rrfScore = 1 / (K + i + 1);
		if (existing) {
			existing.score += rrfScore;
		} else {
			scores.set(r.id, { result: r, score: rrfScore });
		}
	});

	return Array.from(scores.values())
		.map(({ result, score }) => ({ ...result, score, source: 'bm25' as const }))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}
