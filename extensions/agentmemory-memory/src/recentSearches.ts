/*---------------------------------------------------------------------------------------------
 *  搜索历史 — 记录和清理搜索历史。
 *  参考 agentmemory src/functions/recent-searches-sweep.ts
 *
 *  与 SmartSearch 的 followup 检测的区别：
 *    - SmartSearch：30 秒窗口内的 followup 检测（短期）
 *    - RecentSearches：长期搜索历史管理 + 清理 + 分析
 *
 *  核心能力：
 *    1. record(agentId, query, resultCount) — 记录搜索
 *    2. getHistory(agentId, limit) — 获取搜索历史
 *    3. getStats(agentId) — 搜索统计（热门查询、零结果查询、avg结果数）
 *    4. sweep(maxAge) — 清理旧搜索记录
 *    5. getZeroResultQueries() — 获取零结果查询（用于改进搜索）
 *--------------------------------------------------------------------------------------------*/

export interface SearchHistoryEntry {
	id: string;
	agentId: string;
	query: string;
	resultCount: number;
	resultIds: string[];
	timestamp: number;
	durationMs?: number;
	source?: 'agent' | 'viewer' | 'manual';
}

export interface SearchHistoryStats {
	totalSearches: number;
	uniqueQueries: number;
	avgResultCount: number;
	zeroResultCount: number;
	topQueries: Array<{ query: string; count: number }>;
	zeroResultQueries: Array<{ query: string; count: number }>;
	searchesBySource: Record<string, number>;
}

const MAX_HISTORY_PER_AGENT = 500;
const SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000;  // 7 天

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RecentSearchesManager {
	private _history = new Map<string, SearchHistoryEntry[]>();
	private _globalHistory: SearchHistoryEntry[] = [];
	private _maxGlobalHistory = 5000;

	/**
	 * 记录搜索
	 */
	record(opts: {
		agentId: string;
		query: string;
		resultCount: number;
		resultIds?: string[];
		durationMs?: number;
		source?: 'agent' | 'viewer' | 'manual';
	}): SearchHistoryEntry {
		const entry: SearchHistoryEntry = {
			id: generateId('search'),
			agentId: opts.agentId,
			query: opts.query.slice(0, 500),
			resultCount: opts.resultCount,
			resultIds: (opts.resultIds ?? []).slice(0, 50),
			timestamp: Date.now(),
			durationMs: opts.durationMs,
			source: opts.source ?? 'agent',
		};

		// 按 agent 存储
		let agentHistory = this._history.get(opts.agentId);
		if (!agentHistory) {
			agentHistory = [];
			this._history.set(opts.agentId, agentHistory);
		}
		agentHistory.push(entry);
		if (agentHistory.length > MAX_HISTORY_PER_AGENT) {
			agentHistory.shift();
		}

		// 全局存储
		this._globalHistory.push(entry);
		if (this._globalHistory.length > this._maxGlobalHistory) {
			this._globalHistory.shift();
		}

		return entry;
	}

	/**
	 * 获取搜索历史
	 */
	getHistory(agentId: string, limit: number = 50): SearchHistoryEntry[] {
		const history = this._history.get(agentId) ?? [];
		return history.slice(-limit).reverse();
	}

	/**
	 * 获取全局搜索历史
	 */
	getGlobalHistory(limit: number = 100): SearchHistoryEntry[] {
		return this._globalHistory.slice(-limit).reverse();
	}

	/**
	 * 获取统计
	 */
	getStats(agentId?: string): SearchHistoryStats {
		const history = agentId
			? (this._history.get(agentId) ?? [])
			: this._globalHistory;

		const queryCounts = new Map<string, number>();
		const zeroResultQueries = new Map<string, number>();
		const sourceCounts: Record<string, number> = {};
		let totalResults = 0;
		let zeroResultCount = 0;

		for (const entry of history) {
			const queryKey = entry.query.toLowerCase().trim();
			queryCounts.set(queryKey, (queryCounts.get(queryKey) ?? 0) + 1);
			totalResults += entry.resultCount;

			if (entry.resultCount === 0) {
				zeroResultCount++;
				zeroResultQueries.set(queryKey, (zeroResultQueries.get(queryKey) ?? 0) + 1);
			}

			const src = entry.source ?? 'agent';
			sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
		}

		const topQueries = Array.from(queryCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([query, count]) => ({ query, count }));

		const zeroResultQueriesList = Array.from(zeroResultQueries.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([query, count]) => ({ query, count }));

		return {
			totalSearches: history.length,
			uniqueQueries: queryCounts.size,
			avgResultCount: history.length > 0 ? Math.round(totalResults / history.length * 10) / 10 : 0,
			zeroResultCount,
			topQueries,
			zeroResultQueries: zeroResultQueriesList,
			searchesBySource: sourceCounts,
		};
	}

	/**
	 * 获取零结果查询（用于改进搜索质量）
	 */
	getZeroResultQueries(agentId?: string, limit: number = 20): Array<{ query: string; count: number; lastSearched: number }> {
		const history = agentId
			? (this._history.get(agentId) ?? [])
			: this._globalHistory;

		const zeroResults = new Map<string, { count: number; lastSearched: number }>();

		for (const entry of history) {
			if (entry.resultCount === 0) {
				const key = entry.query.toLowerCase().trim();
				const existing = zeroResults.get(key);
				if (existing) {
					existing.count++;
					existing.lastSearched = Math.max(existing.lastSearched, entry.timestamp);
				} else {
					zeroResults.set(key, { count: 1, lastSearched: entry.timestamp });
				}
			}
		}

		return Array.from(zeroResults.entries())
			.map(([query, info]) => ({ query, ...info }))
			.sort((a, b) => b.count - a.count)
			.slice(0, limit);
	}

	/**
	 * 清理旧搜索记录
	 */
	sweep(maxAgeMs?: number): number {
		const maxAge = maxAgeMs ?? SWEEP_AGE_MS;
		const cutoff = Date.now() - maxAge;
		let swept = 0;

		// 清理 per-agent
		for (const [agentId, history] of this._history) {
			const before = history.length;
			const filtered = history.filter(e => e.timestamp > cutoff);
			swept += before - filtered.length;
			if (filtered.length === 0) {
				this._history.delete(agentId);
			} else {
				this._history.set(agentId, filtered);
			}
		}

		// 清理全局
		const beforeGlobal = this._globalHistory.length;
		this._globalHistory = this._globalHistory.filter(e => e.timestamp > cutoff);
		swept += beforeGlobal - this._globalHistory.length;

		return swept;
	}

	/**
	 * 清除某 agent 的搜索历史
	 */
	clearAgent(agentId: string): number {
		const count = this._history.get(agentId)?.length ?? 0;
		this._history.delete(agentId);
		// 从全局历史中移除该 agent 的记录
		this._globalHistory = this._globalHistory.filter(e => e.agentId !== agentId);
		return count;
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._history.clear();
		this._globalHistory = [];
	}

	/**
	 * 获取相关搜索建议（基于历史）
	 */
	getSuggestions(agentId: string, partialQuery: string, limit: number = 5): string[] {
		const history = this._history.get(agentId) ?? [];
		const lower = partialQuery.toLowerCase();

		const matches = new Map<string, number>();
		for (const entry of history) {
			if (entry.query.toLowerCase().includes(lower) && entry.resultCount > 0) {
				matches.set(entry.query, (matches.get(entry.query) ?? 0) + 1);
			}
		}

		return Array.from(matches.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([query]) => query);
	}
}
