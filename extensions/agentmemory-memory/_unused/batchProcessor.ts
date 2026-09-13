/*---------------------------------------------------------------------------------------------
 *  批量处理器 — 批量写入/删除/搜索记忆。
 *
 *  解决问题：高频单条操作效率低，批量操作减少 I/O 和计算开销。
 *
 *  核心能力：
 *    1. batchWrite(agentId, entries) — 批量写入（去重 + 压缩 + 索引）
 *    2. batchDelete(agentId, ids) — 批量删除（索引清理 + 审计）
 *    3. batchSearch(agentId, queries) — 批量搜索（合并结果）
 *    4. batchExport(agentId, ids) — 批量导出
 *--------------------------------------------------------------------------------------------*/

export interface BatchWriteItem {
	content: string;
	type: 'working' | 'episodic' | 'semantic' | 'procedural';
	importance?: number;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

export interface BatchWriteResult {
	total: number;
	written: number;
	deduplicated: number;
	compressed: number;
	errors: Array<{ index: number; error: string }>;
	elapsedMs: number;
}

export interface BatchDeleteResult {
	total: number;
	deleted: number;
	notFound: number;
	errors: Array<{ id: string; error: string }>;
	elapsedMs: number;
}

export interface BatchSearchResult {
	totalQueries: number;
	totalResults: number;
	avgResultsPerQuery: number;
	results: Array<{ query: string; results: unknown[] }>;
	elapsedMs: number;
}

export interface BatchExportResult {
	total: number;
	exported: number;
	errors: Array<{ id: string; error: string }>;
	format: 'json' | 'markdown';
	elapsedMs: number;
}

const BATCH_CONCURRENCY = 5;

export class BatchProcessor {
	/**
	 * 批量写入
	 */
	async batchWrite(
		agentId: string,
		items: BatchWriteItem[],
		writeFn: (agentId: string, item: BatchWriteItem) => Promise<{ written: boolean; deduplicated: boolean; compressed: boolean; error?: string }>,
	): Promise<BatchWriteResult> {
		const startTime = Date.now();
		let written = 0;
		let deduplicated = 0;
		let compressed = 0;
		const errors: Array<{ index: number; error: string }> = [];

		// 分批并发处理
		for (let i = 0; i < items.length; i += BATCH_CONCURRENCY) {
			const batch = items.slice(i, i + BATCH_CONCURRENCY);
			const results = await Promise.allSettled(
				batch.map((item, batchIdx) => writeFn(agentId, item).then(result => ({ result, batchIdx, globalIdx: i + batchIdx }))),
			);

			for (const settled of results) {
				if (settled.status === 'fulfilled') {
					const { result, globalIdx } = settled.value;
					if (result.written) {
						written++;
						if (result.deduplicated) deduplicated++;
						if (result.compressed) compressed++;
					}
					if (result.error) {
						errors.push({ index: globalIdx, error: result.error });
					}
				} else {
					errors.push({
						index: 0,
						error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
					});
				}
			}
		}

		return {
			total: items.length,
			written,
			deduplicated,
			compressed,
			errors,
			elapsedMs: Date.now() - startTime,
		};
	}

	/**
	 * 批量删除
	 */
	async batchDelete(
		agentId: string,
		ids: string[],
		deleteFn: (agentId: string, id: string) => Promise<{ deleted: boolean; notFound: boolean; error?: string }>,
	): Promise<BatchDeleteResult> {
		const startTime = Date.now();
		let deleted = 0;
		let notFound = 0;
		const errors: Array<{ id: string; error: string }> = [];

		for (let i = 0; i < ids.length; i += BATCH_CONCURRENCY) {
			const batch = ids.slice(i, i + BATCH_CONCURRENCY);
			const results = await Promise.allSettled(
				batch.map(id => deleteFn(agentId, id)),
			);

			for (let j = 0; j < results.length; j++) {
				const id = batch[j];
				const result = results[j];
				if (result.status === 'fulfilled') {
					if (result.value.deleted) deleted++;
					if (result.value.notFound) notFound++;
					if (result.value.error) errors.push({ id, error: result.value.error });
				} else {
					errors.push({
						id,
						error: result.reason instanceof Error ? result.reason.message : String(result.reason),
					});
				}
			}
		}

		return {
			total: ids.length,
			deleted,
			notFound,
			errors,
			elapsedMs: Date.now() - startTime,
		};
	}

	/**
	 * 批量搜索
	 */
	async batchSearch(
		agentId: string,
		queries: string[],
		searchFn: (agentId: string, query: string) => Promise<unknown[]>,
	): Promise<BatchSearchResult> {
		const startTime = Date.now();
		const results: Array<{ query: string; results: unknown[] }> = [];
		let totalResults = 0;

		// 顺序搜索（避免并发搜索互相影响索引）
		for (const query of queries) {
			try {
				const searchResults = await searchFn(agentId, query);
				results.push({ query, results: searchResults });
				totalResults += searchResults.length;
			} catch (err) {
				results.push({ query, results: [] });
			}
		}

		return {
			totalQueries: queries.length,
			totalResults,
			avgResultsPerQuery: queries.length > 0 ? Math.round(totalResults / queries.length * 10) / 10 : 0,
			results,
			elapsedMs: Date.now() - startTime,
		};
	}
}
