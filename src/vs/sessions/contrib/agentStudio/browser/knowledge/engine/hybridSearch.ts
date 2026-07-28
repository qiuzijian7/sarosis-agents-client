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

// ---------------------------------------------------------------------------
// P0-2 图信号重排（对齐 llm_wiki「图信号检索」纪律）
// ---------------------------------------------------------------------------

/** 单个条目的图结构信号（由 caller 从图数据中提取）。 */
export interface IGraphSignal {
	/** 节点度数（入度+出度）；高连接度 = 图中枢纽，适度加权 */
	degree?: number;
	/** Louvain 社区 id；用于结果多样化（避免同社区霸榜） */
	communityId?: string | number;
}

export interface IGraphRerankOptions {
	/** 度数加权强度（最终 boost = 1 + weight * log1p(deg)/log1p(maxDeg)），默认 0.3 */
	degreeWeight?: number;
	/** 每个社区最多保留的前排名额，超出者顺延到队尾（不丢弃），默认 3 */
	maxPerCommunity?: number;
}

/**
 * 图信号重排：在 RRF 融合分基础上叠加度数加成，再按社区做多样化。
 * 纯函数、确定性；无图信号（getSignal 返回 undefined）的条目保持原分。
 */
export function rerankWithGraphSignals<T>(
	hits: HybridSearchHit<T>[],
	getSignal: (hit: HybridSearchHit<T>) => IGraphSignal | undefined,
	opts?: IGraphRerankOptions,
): HybridSearchHit<T>[] {
	if (hits.length <= 1) { return hits.slice(); }
	const degreeWeight = opts?.degreeWeight ?? 0.3;
	const maxPerCommunity = Math.max(1, opts?.maxPerCommunity ?? 3);

	// 1) 度数加成
	const signals = hits.map(h => getSignal(h));
	const maxDeg = Math.max(0, ...signals.map(s => s?.degree ?? 0));
	const scored = hits.map((h, i) => {
		const deg = signals[i]?.degree ?? 0;
		const boost = maxDeg > 0 ? 1 + degreeWeight * (Math.log1p(deg) / Math.log1p(maxDeg)) : 1;
		return { hit: h, signal: signals[i], score: h.rrfScore * boost };
	});
	scored.sort((a, b) => b.score - a.score);

	// 2) 社区多样化：同社区前排名额封顶，被挤出者按分数顺延队尾
	const communityCount = new Map<string, number>();
	const front: typeof scored = [];
	const overflow: typeof scored = [];
	for (const s of scored) {
		const cid = s.signal?.communityId;
		if (cid === undefined || cid === null || cid === '') { front.push(s); continue; }
		const key = String(cid);
		const n = communityCount.get(key) ?? 0;
		if (n < maxPerCommunity) {
			communityCount.set(key, n + 1);
			front.push(s);
		} else {
			overflow.push(s);
		}
	}
	return [...front, ...overflow].map(s => s.hit);
}

// ---------------------------------------------------------------------------
// P0-2 token 预算封顶（防检索结果撑爆 LLM 上下文）
// ---------------------------------------------------------------------------

/** 粗略 token 估算：CJK 字符按 1 token，其余按 4 字符 ≈ 1 token。 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0x2E80 && c <= 0x9FFF || c >= 0xF900 && c <= 0xFAFF || c >= 0xFF00 && c <= 0xFFEF) { cjk++; }
	}
	return cjk + Math.ceil((text.length - cjk) / 4);
}

export interface ITokenClampResult<T> {
	items: T[];
	/** 是否发生截断 */
	truncated: boolean;
	/** 保留条目的估算 token 总量 */
	estTokens: number;
}

/**
 * 按 token 预算截断有序结果列表（保序、至少保留 1 条）。
 * @param textOf 条目 → 参与预算的文本表示
 */
export function clampToTokenBudget<T>(items: T[], textOf: (item: T) => string, maxTokens: number): ITokenClampResult<T> {
	if (items.length === 0 || maxTokens <= 0 || !isFinite(maxTokens)) {
		return { items: items.slice(), truncated: false, estTokens: 0 };
	}
	const kept: T[] = [];
	let used = 0;
	for (const it of items) {
		const t = estimateTokens(textOf(it));
		if (kept.length > 0 && used + t > maxTokens) { break; }
		kept.push(it);
		used += t;
	}
	return { items: kept, truncated: kept.length < items.length, estTokens: used };
}
