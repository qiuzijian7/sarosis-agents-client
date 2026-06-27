/*---------------------------------------------------------------------------------------------
 *  搜索重排 — 使用交叉编码器对搜索结果重新排序。
 *  1:1 复刻 agentmemory src/state/reranker.ts
 *
 *  使用 @xenova/transformers 的 ms-marco-MiniLM-L-6-v2 模型对搜索结果重排。
 *  模型不可用时降级为原始排序。
 *--------------------------------------------------------------------------------------------*/

export interface RerankableResult {
	id: string;
	title?: string;
	content: string;
	combinedScore: number;
}

export interface RerankedResult extends RerankableResult {
	rerankScore: number;
	rerankPosition: number;
}

let rerankerPipeline: any = null;
let pipelineLoading: Promise<any> | null = null;
let pipelineUnavailable = false;

async function loadPipeline(): Promise<any> {
	if (pipelineUnavailable) return null;
	if (rerankerPipeline) return rerankerPipeline;
	if (pipelineLoading) return pipelineLoading;

	pipelineLoading = (async () => {
		try {
			const xenova: any = await import('@xenova/transformers');
			rerankerPipeline = await xenova.pipeline(
				'text-classification',
				'Xenova/ms-marco-MiniLM-L-6-v2',
				{ quantized: true },
			);
			return rerankerPipeline;
		} catch {
			rerankerPipeline = null;
			pipelineUnavailable = true;
			return null;
		} finally {
			pipelineLoading = null;
		}
	})();

	return pipelineLoading;
}

/**
 * 对搜索结果进行重排
 */
export async function rerank(
	query: string,
	results: RerankableResult[],
	topK: number = 20,
): Promise<RerankedResult[]> {
	if (results.length <= 1) {
		return results.map((r, i) => ({ ...r, rerankScore: r.combinedScore, rerankPosition: i + 1 }));
	}

	const reranker = await loadPipeline();
	if (!reranker) {
		// 降级：使用原始排序
		return results.map((r, i) => ({ ...r, rerankScore: r.combinedScore, rerankPosition: i + 1 }));
	}

	const candidates = results.slice(0, Math.min(results.length, topK));
	const scores: Array<{ result: RerankableResult; rerankScore: number }> = [];

	for (const candidate of candidates) {
		try {
			const text = `${query} [SEP] ${candidate.title ?? ''} ${candidate.content}`.slice(0, 512);
			const output = await reranker(text);
			const score = Array.isArray(output) ? output[0]?.score ?? 0 : 0;
			scores.push({ result: candidate, rerankScore: score });
		} catch {
			scores.push({ result: candidate, rerankScore: candidate.combinedScore });
		}
	}

	scores.sort((a, b) => b.rerankScore - a.rerankScore);

	return scores.map((s, i) => ({
		...s.result,
		rerankScore: s.rerankScore,
		rerankPosition: i + 1,
	}));
}

/**
 * 检查重排器是否可用
 */
export function isRerankerAvailable(): boolean {
	return rerankerPipeline !== null;
}

/**
 * 检查重排器是否加载中
 */
export function isRerankerLoading(): boolean {
	return pipelineLoading !== null;
}

/**
 * 重置重排器（用于测试或重新加载）
 */
export function resetReranker(): void {
	rerankerPipeline = null;
	pipelineLoading = null;
	pipelineUnavailable = false;
}

/**
 * 简化版重排（不使用模型，基于关键词匹配）
 */
export function rerankSimple(
	query: string,
	results: RerankableResult[],
	topK: number = 20,
): RerankedResult[] {
	const queryTerms = new Set(query.toLowerCase().split(/\s+/).filter(t => t.length > 1));

	const scored = results.slice(0, topK).map(result => {
		const contentLower = (result.title ?? '' + ' ' + result.content).toLowerCase();
		let matchCount = 0;
		for (const term of queryTerms) {
			if (contentLower.includes(term)) matchCount++;
		}
		const rerankScore = (matchCount / queryTerms.size) * 0.5 + result.combinedScore * 0.5;
		return { result, rerankScore };
	});

	scored.sort((a, b) => b.rerankScore - a.rerankScore);

	return scored.map((s, i) => ({
		...s.result,
		rerankScore: s.rerankScore,
		rerankPosition: i + 1,
	}));
}
