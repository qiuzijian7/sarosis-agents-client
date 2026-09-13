/*---------------------------------------------------------------------------------------------
 *  G13: 磁盘级缓存适配器 — 对齐 cognee DiskCache
 *
 *  将内存级缓存 (_contextCache, _searchCache) 包装为持久化版本，
 *  定期 flush 到 SQLite KV Store，进程重启后可恢复。
 *
 *  使用方式:
 *    const cache = new DiskCacheAdapter(kvStore, 'context_cache');
 *    await cache.set('key', value);
 *    const val = await cache.get('key');  // 先查内存，miss → 查 SQLite
 *--------------------------------------------------------------------------------------------*/

export interface KVStoreLike {
	get(scope: string, key: string): Promise<string | null>;
	set(scope: string, key: string, value: string): Promise<void>;
	delete(scope: string, key: string): Promise<void>;
	list(scope: string): Promise<Array<{ key: string; value: string }>>;
}

interface CacheEntry<T> {
	value: T;
	ts: number;
	ttlMs: number;
}

export class DiskCacheAdapter<T = unknown> {
	private _memory = new Map<string, CacheEntry<T>>();
	private _dirty = new Set<string>(); // 待 flush 的 key
	private _flushTimer: ReturnType<typeof setInterval> | undefined;
	private _cleanupTimer: ReturnType<typeof setInterval> | undefined;
	private readonly _flushIntervalMs = 30 * 1000; // 30s flush 一次
	private readonly _cleanupIntervalMs = 2 * 60 * 1000; // 2 分钟清理一次过期条目

	constructor(
		private readonly _kv: KVStoreLike,
		private readonly _scope: string,
		private readonly _defaultTtlMs: number = 5 * 60 * 1000,
		private readonly _maxSize: number = 200,  // OOM 防护：内存条目上限
	) {
		// 启动定期 flush
		this._flushTimer = setInterval(() => {
			this.flush().catch(() => {});
		}, this._flushIntervalMs);
		if (this._flushTimer && typeof (this._flushTimer as any).unref === 'function') {
			(this._flushTimer as any).unref();
		}
		// 启动定期 TTL 清理（主动回收过期条目，避免惰性 get 时的堆积）
		this._cleanupTimer = setInterval(() => {
			this._evictExpired();
		}, this._cleanupIntervalMs);
		if (this._cleanupTimer && typeof (this._cleanupTimer as any).unref === 'function') {
			(this._cleanupTimer as any).unref();
		}
	}

	/** 获取缓存 — 先查内存，miss 时查 SQLite */
	async get(key: string): Promise<T | undefined> {
		// 1. 内存缓存
		const memEntry = this._memory.get(key);
		if (memEntry) {
			if (Date.now() - memEntry.ts < memEntry.ttlMs) {
				return memEntry.value;
			}
			this._memory.delete(key);
		}

		// 2. SQLite 回退
		try {
			const raw = await this._kv.get(this._scope, key);
			if (raw) {
				const entry = JSON.parse(raw) as CacheEntry<T>;
				if (Date.now() - entry.ts < entry.ttlMs) {
					// 回填内存缓存
					this._memory.set(key, entry);
					return entry.value;
				}
				// 过期，删除
				await this._kv.delete(this._scope, key);
			}
		} catch { /* ignore KV errors */ }

		return undefined;
	}

	/** 设置缓存 — 写内存 + 标记 dirty，超过 maxSize 时 LRU 淘汰最旧条目 */
	async set(key: string, value: T, ttlMs?: number): Promise<void> {
		const entry: CacheEntry<T> = {
			value,
			ts: Date.now(),
			ttlMs: ttlMs ?? this._defaultTtlMs,
		};
		this._memory.set(key, entry);
		this._dirty.add(key);

		// OOM 防护：超过 maxSize 时 LRU 淘汰（按 ts 排序，删除最旧的 N 条）
		if (this._memory.size > this._maxSize) {
			const entries = Array.from(this._memory.entries())
				.sort((a, b) => a[1].ts - b[1].ts);
			const toEvict = entries.slice(0, this._memory.size - this._maxSize);
			for (const [k] of toEvict) {
				this._memory.delete(k);
				this._dirty.delete(k);
			}
		}
	}

	/** 删除缓存 */
	async delete(key: string): Promise<void> {
		this._memory.delete(key);
		this._dirty.delete(key);
		try { await this._kv.delete(this._scope, key); } catch { /* ignore */ }
	}

	/** 清空所有缓存 */
	async clear(): Promise<void> {
		this._memory.clear();
		this._dirty.clear();
		// KV 层清空需要 list + delete
		try {
			const items = await this._kv.list(this._scope);
			await Promise.all(items.map(item => this._kv.delete(this._scope, item.key)));
		} catch { /* ignore */ }
	}

	/** Flush dirty entries to SQLite */
	async flush(): Promise<void> {
		if (this._dirty.size === 0) return;
		const keys = Array.from(this._dirty);
		this._dirty.clear();

		for (const key of keys) {
			const entry = this._memory.get(key);
			if (!entry) continue;
			try {
				await this._kv.set(this._scope, key, JSON.stringify(entry));
			} catch { /* ignore KV errors */ }
		}
	}

	/** 从 SQLite 恢复缓存到内存（限制恢复数量，防止一次性撑爆堆） */
	async restore(): Promise<void> {
		try {
			const items = await this._kv.list(this._scope);
			// 按时间戳排序取最近 maxSize 条恢复，其余仅保留在磁盘
			const sorted = items
				.map(item => {
					try { return { ...item, entry: JSON.parse(item.value) as CacheEntry<T> }; }
					catch { return null; }
				})
				.filter((x): x is NonNullable<typeof x> => x !== null)
				.sort((a, b) => b.entry.ts - a.entry.ts);
			const toRestore = sorted.slice(0, this._maxSize);
			for (const item of toRestore) {
				if (Date.now() - item.entry.ts < item.entry.ttlMs) {
					this._memory.set(item.key, item.entry);
				} else {
					await this._kv.delete(this._scope, item.key);
				}
			}
		} catch { /* ignore */ }
	}

	/** 获取统计 */
	getStats(): { memorySize: number; dirtySize: number } {
		return {
			memorySize: this._memory.size,
			dirtySize: this._dirty.size,
		};
	}

	/** 主动清理过期条目（由定时器调用，防止惰性 get 时堆积） */
	private _evictExpired(): void {
		const now = Date.now();
		for (const [key, entry] of this._memory) {
			if (now - entry.ts >= entry.ttlMs) {
				this._memory.delete(key);
				this._dirty.delete(key);
			}
		}
	}

	/** 销毁 — flush + 停止 timer */
	async dispose(): Promise<void> {
		if (this._flushTimer) {
			clearInterval(this._flushTimer);
			this._flushTimer = undefined;
		}
		if (this._cleanupTimer) {
			clearInterval(this._cleanupTimer);
			this._cleanupTimer = undefined;
		}
		await this.flush();
	}
}

// ─── G13 plumbing: 文件级 KV 存储 ─────────────────────────────────────────
// DiskCacheAdapter 需要一个 KVStoreLike 后端。浏览器/无 fs 环境下优雅降级为纯内存 KV。

class InMemoryKV implements KVStoreLike {
	private _m = new Map<string, string>();
	async get(scope: string, key: string): Promise<string | null> {
		return this._m.get(`${scope}::${key}`) ?? null;
	}
	async set(scope: string, key: string, value: string): Promise<void> {
		this._m.set(`${scope}::${key}`, value);
	}
	async delete(scope: string, key: string): Promise<void> {
		this._m.delete(`${scope}::${key}`);
	}
	async list(scope: string): Promise<Array<{ key: string; value: string }>> {
		const out: Array<{ key: string; value: string }> = [];
		for (const [k, v] of this._m) {
			if (k.startsWith(`${scope}::`)) out.push({ key: k.slice(`${scope}::`.length), value: v });
		}
		return out;
	}
}

/**
 * 创建文件级 KV 存储（用于 DiskCacheAdapter 的 L2 磁盘层）。
 * 若运行环境无 `fs`（如浏览器），自动降级为纯内存 KV，保证调用安全。
 */
export function createFileBackedKVStore(filePath?: string): KVStoreLike {
	try {
		const fsMod: any = (typeof require !== 'undefined') ? require('fs') : undefined;
		if (!fsMod) return new InMemoryKV();
		const pathMod: any = (typeof require !== 'undefined') ? require('path') : undefined;
		const osMod: any = (typeof require !== 'undefined') ? require('os') : undefined;
		const file = filePath ?? (pathMod && osMod ? pathMod.join(osMod.tmpdir(), 'agentmemory-recall-cache.json') : 'agentmemory-recall-cache.json');
		const dir = pathMod ? pathMod.dirname(file) : '.';
		try { fsMod.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
		const load = (): Record<string, string> => {
			try { return JSON.parse(fsMod.readFileSync(file, 'utf8') || '{}'); } catch { return {}; }
		};
		const save = (o: Record<string, string>) => {
			try { fsMod.writeFileSync(file, JSON.stringify(o)); } catch { /* ignore */ }
		};
		return {
			get: async (scope, key) => load()[`${scope}::${key}`] ?? null,
			set: async (scope, key, value) => { const o = load(); o[`${scope}::${key}`] = value; save(o); },
			delete: async (scope, key) => { const o = load(); delete o[`${scope}::${key}`]; save(o); },
			list: async (scope) => Object.entries(load()).filter(([k]) => k.startsWith(`${scope}::`)).map(([k, v]) => ({ key: k.slice(`${scope}::`.length), value: v })),
		};
	} catch {
		return new InMemoryKV();
	}
}
