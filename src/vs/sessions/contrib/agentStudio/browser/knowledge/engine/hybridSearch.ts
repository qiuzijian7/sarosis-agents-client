/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  HybridSearch — RRF (Reciprocal Rank Fusion) 混合检索
 *
 *  融合两套独立检索系统：
 *    - FTS (KbFullTextIndex): 关键词 BM25 倒排索引 — 侧边栏搜索
 *    - Vector (OMem / SplitIndex): 语义向量余弦相似度 — Agent kb_* 工具
 *
 *  RRF 公式: score(d) = Σ 1 / (k + rank_i(d)), k=60
 *  参考: Cormack et al. "Reciprocal Rank Fusion outperforms Condorcet" (SIGIR 2009)
 *
 *  注意：Hyper-Extract Python 原版无混合检索，此为 Plan-B 补充能力。
 *--------------------------------------------------------------------------------------------*/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 统一检索命中结构 */
export interface HybridSearchHit<T = unknown> {
	/** 原始条目 */
	item: T;
	/** 项目唯一标识（用于去重/合并），可选 */
	id?: string;
	/** 余弦相似度得分 [0, 1]，-1 = 未参与向量检索 */
	vectorScore: number;
	/** BM25 关键词得分 [0, 1]，-1 = 未参与 FTS */
	ftsScore: number;
	/** RRF 融合得分 */
	rrfScore: number;
}

export interface HybridSearchResult<T = unknown> {
	hits: HybridSearchHit<T>[];
	/** 各检索器的命中数 */
	stats: {
		ftsTotal: number;
		vectorTotal: number;
		mergedTotal: number;
	};
}

// ---------------------------------------------------------------------------
// RRF 融合
// ---------------------------------------------------------------------------

/** RRF 常数 k（文献推荐 60） */
const RRF_K = 60;

/**
 * 给定两个带分的排名列表，执行 RRF 融合。
 *
 * 排名由 caller 提供（score 越高或 rank 越小排名越前）。
 * 去重由 `idExtractor` 控制：同一 id 的条目合并，RRF 得分累加。
 *
 * @param ftsItems    FTS 命中列表（rank 越小越相关）
 * @param vectorItems 向量命中列表（rank 越小越相关）
 * @param idExtractor 从 item 提取唯一 id（用于去重合并）
 * @param topK       返回 top K 条结果
 */
export function fuseHybrid<T>(
	ftsItems: T[],
	vectorItems: T[],
	idExtractor: (item: T) => string,
	topK: number = 10,
): HybridSearchResult<T> {
	// 构建 id → HybridSearchHit 映射
	const hitMap = new Map<string, HybridSearchHit<T>>();

	// FTS 排名 → RRF 得分
	for (let i = 0; i < ftsItems.length; i++) {
		const item = ftsItems[i];
		const id = idExtractor(item);
		const rrf = rrfScore(i + 1); // rank 从 1 开始

		const existing = hitMap.get(id);
		if (existing) {
			existing.ftsScore = Math.max(existing.ftsScore, normalizeRankScore(i, ftsItems.length));
			existing.rrfScore += rrf;
		} else {
			hitMap.set(id, {
				item,
				id,
				vectorScore: -1,
				ftsScore: normalizeRankScore(i, ftsItems.length),
				rrfScore: rrf,
			});
		}
	}

	// Vector 排名 → RRF 得分
	for (let i = 0; i < vectorItems.length; i++) {
		const item = vectorItems[i];
		const id = idExtractor(item);
		const rrf = rrfScore(i + 1);

		const existing = hitMap.get(id);
		if (existing) {
			existing.vectorScore = Math.max(existing.vectorScore, normalizeRankScore(i, vectorItems.length));
			existing.rrfScore += rrf;
		} else {
			hitMap.set(id, {
				item,
				id,
				vectorScore: normalizeRankScore(i, vectorItems.length),
				ftsScore: -1,
				rrfScore: rrf,
			});
		}
	}

	// 排序：RRF 得分降序
	const hits = Array.from(hitMap.values())
		.sort((a, b) => b.rrfScore - a.rrfScore)
		.slice(0, topK);

	return {
		hits,
		stats: {
			ftsTotal: ftsItems.length,
			vectorTotal: vectorItems.length,
			mergedTotal: hitMap.size,
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** RRF 单个排名的得分 */
function rrfScore(rank: number): number {
	return 1 / (RRF_K + rank);
}

/**
 * 将排名转换为归一化得分 [0, 1]。
 * rank 0 → 1.0，rank (total - 1) → 0.0
 */
function normalizeRankScore(rank: number, total: number): number {
	if (total <= 1) { return 1; }
	return 1 - rank / (total - 1);
}

// ---------------------------------------------------------------------------
// 批量检索辅助：并发 FTS + Vector
// ---------------------------------------------------------------------------

export async function hybridSearch<T>(
	query: string,
	ftsSearch: (q: string, topK: number) => Promise<T[]>,
	vectorSearch: (q: string, topK: number) => Promise<T[]>,
	idExtractor: (item: T) => string,
	topK: number = 10,
): Promise<HybridSearchResult<T>> {
	const topKPerIndex = Math.max(topK * 2, 20); // 每个索引多取一些，留足融合空间
	const [ftsItems, vectorItems] = await Promise.all([
		ftsSearch(query, topKPerIndex).catch(() => [] as T[]),
		vectorSearch(query, topKPerIndex).catch(() => [] as T[]),
	]);

	return fuseHybrid(ftsItems, vectorItems, idExtractor, topK);
}
