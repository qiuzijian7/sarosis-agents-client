/*---------------------------------------------------------------------------------------------
 *  搜索结果缓存 — LRU 缓存高频查询，避免重复 BM25+Vector+RRF 计算。
 *
 *  策略：
 *    - 按 (agentId + query) 做 key
 *    - LRU 淘汰：超过 maxSize 时移除最久未访问的条目
 *    - TTL 过期：超过 ttlMs 的条目自动失效（默认 5 分钟）
 *    - 写入失效：当 agent 有新记忆写入时，清除该 agent 的所有缓存
 *--------------------------------------------------------------------------------------------*/

interface CacheEntry<T> {
	value: T;
	timestamp: number;
	agentId: string;
	lastAccessed: number;
}

export class SearchCache<T = unknown> {
	private _cache = new Map<string, CacheEntry<T>>();
	private readonly _maxSize: number;
	private readonly _ttlMs: number;
	private _hits = 0;
	private _misses = 0;

	constructor(maxSize: number = 100, ttlMs: number = 5 * 60 * 1000) {
		this._maxSize = maxSize;
		this._ttlMs = ttlMs;
	}

	/**
	 * 生成缓存 key
	 */
	private _key(agentId: string, query: string): string {
		return `${agentId}::${query.toLowerCase().trim()}`;
	}

	/**
	 * 获取缓存结果。返回 undefined 表示未命中。
	 */
	get(agentId: string, query: string): T | undefined {
		const key = this._key(agentId, query);
		const entry = this._cache.get(key);
		if (!entry) {
			this._misses++;
			return undefined;
		}

		// TTL check
		if (Date.now() - entry.timestamp > this._ttlMs) {
			this._cache.delete(key);
			this._misses++;
			return undefined;
		}

		// LRU: move to end (Map preserves insertion order, delete+re-insert)
		this._cache.delete(key);
		entry.lastAccessed = Date.now();
		this._cache.set(key, entry);
		this._hits++;
		return entry.value;
	}

	/**
	 * 存入缓存结果
	 */
	set(agentId: string, query: string, value: T): void {
		const key = this._key(agentId, query);

		// LRU eviction
		if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
			const oldestKey = this._cache.keys().next().value;
			if (oldestKey) this._cache.delete(oldestKey);
		}

		this._cache.set(key, {
			value,
			timestamp: Date.now(),
			agentId,
			lastAccessed: Date.now(),
		});
	}

	/**
	 * 失效某个 agent 的所有缓存（当有新记忆写入时调用）
	 */
	invalidateAgent(agentId: string): number {
		let removed = 0;
		for (const [key, entry] of this._cache) {
			if (entry.agentId === agentId) {
				this._cache.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * 清除所有缓存
	 */
	clear(): void {
		this._cache.clear();
		this._hits = 0;
		this._misses = 0;
	}

	/**
	 * 获取缓存统计
	 */
	getStats(): {
		size: number;
		maxSize: number;
		hits: number;
		misses: number;
		hitRate: number;
	} {
		const total = this._hits + this._misses;
		return {
			size: this._cache.size,
			maxSize: this._maxSize,
			hits: this._hits,
			misses: this._misses,
			hitRate: total > 0 ? Math.round(this._hits / total * 100) / 100 : 0,
		};
	}
}
