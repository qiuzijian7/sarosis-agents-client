/*---------------------------------------------------------------------------------------------
 *  RRF (Reciprocal Rank Fusion) — 多路搜索结果融合。
 *  从 memoryProvider.ts _hybridSearch 提取为独立模块，便于单元测试。
 *
 *  公式: score(d) = Σ (w_i / totalW) × 1/(k + rank_i)
 *  其中 w_i 是第 i 路搜索的权重，k 是平滑常数（默认 60）。
 *--------------------------------------------------------------------------------------------*/

export interface RRFResult {
	id: string;
	score: number;
}

export interface RRFStream {
	results: Array<{ id: string; score?: number }>;
	weight: number;
}

/**
 * Reciprocal Rank Fusion — 融合多路搜索结果。
 *
 * @param streams 搜索流数组，每路包含结果列表和权重
 * @param k 平滑常数（默认 60，标准 RRF 参数）
 * @param maxPerSession 可选的会话去重（每会话最多保留 N 条）
 * @returns 融合后的 id→score 映射（按 score 降序排列的数组）
 */
export function rrfFuse(
	streams: RRFStream[],
	k: number = 60,
): RRFResult[] {
	const totalW = streams.reduce((sum, s) => sum + s.weight, 0) || 1;
	const scores = new Map<string, number>();

	for (const stream of streams) {
		if (stream.weight === 0) continue;
		stream.results.forEach((r, i) => {
			const existing = scores.get(r.id) ?? 0;
			scores.set(r.id, existing + (stream.weight / totalW) * (1 / (k + i + 1)));
		});
	}

	return Array.from(scores.entries())
		.map(([id, score]) => ({ id, score }))
		.sort((a, b) => b.score - a.score);
}

/**
 * 带会话去重的 RRF 融合。
 * 每个会话最多保留 maxPerSession 条结果，溢出的放入末尾。
 */
export function rrfFuseWithDiversify(
	streams: RRFStream[],
	k: number,
	maxPerSession: number,
	getSessionKey: (id: string) => string,
): RRFResult[] {
	const fused = rrfFuse(streams, k);
	const sorted: RRFResult[] = [];
	const overflow: RRFResult[] = [];
	const sessionCounts = new Map<string, number>();

	for (const r of fused) {
		const sessionKey = getSessionKey(r.id);
		const count = sessionCounts.get(sessionKey) ?? 0;
		if (count < maxPerSession) {
			sorted.push(r);
			sessionCounts.set(sessionKey, count + 1);
		} else {
			overflow.push(r);
		}
	}

	// Fill remaining slots from overflow
	sorted.push(...overflow);
	return sorted;
}
