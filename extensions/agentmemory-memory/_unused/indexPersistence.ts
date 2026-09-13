/*---------------------------------------------------------------------------------------------
 *  索引持久化 — BM25/Vector 索引的磁盘序列化/反序列化。
 *  1:1 复刻 agentmemory src/state/index-persistence.ts
 *
 *  解决问题：每次启动时索引丢失，需要重新构建。
 *  持久化后可快速加载。
 *--------------------------------------------------------------------------------------------*/

import type { BM25Index } from './bm25Index.js';
import type { VectorIndex } from './vectorIndex.js';

const DEBOUNCE_MS = 5000;
const DEFAULT_SHARD_CHARS = 2_000_000;

export interface IndexShardManifest {
	v: 1;
	generation?: string;
	shards: Array<{ scope: string; key: string; chars: number }>;
	chars: number;
}

export interface IndexPersistenceResult {
	success: boolean;
	bm25Manifest?: IndexShardManifest;
	vectorManifest?: IndexShardManifest;
	elapsedMs: number;
	error?: string;
}

export interface IndexLoadResult {
	success: boolean;
	loaded: boolean;
	bm25Entries: number;
	vectorEntries: number;
	elapsedMs: number;
	error?: string;
}

export interface SerializedEntry {
	id: string;
	content: string;
	vector?: number[];
}

/**
 * 将条目分片
 */
function shardEntries(entries: SerializedEntry[], shardChars: number = DEFAULT_SHARD_CHARS): Array<{ entries: SerializedEntry[]; chars: number }> {
	const shards: Array<{ entries: SerializedEntry[]; chars: number }> = [];
	let current: SerializedEntry[] = [];
	let currentChars = 0;

	for (const entry of entries) {
		const entryChars = entry.content.length + (entry.vector?.length ?? 0) * 4;
		if (currentChars + entryChars > shardChars && current.length > 0) {
			shards.push({ entries: current, chars: currentChars });
			current = [];
			currentChars = 0;
		}
		current.push(entry);
		currentChars += entryChars;
	}

	if (current.length > 0) {
		shards.push({ entries: current, chars: currentChars });
	}

	return shards;
}

export class IndexPersistence {
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _pendingSave = false;
	private _lastSaveAt = 0;
	private _totalSaves = 0;
	private _totalLoads = 0;

	/**
	 * 序列化索引
	 */
	serialize(entries: SerializedEntry[]): string {
		return JSON.stringify({ v: 1, entries, savedAt: Date.now() });
	}

	/**
	 * 反序列化索引
	 */
	deserialize(json: string): SerializedEntry[] | null {
		try {
			const parsed = JSON.parse(json) as { v: number; entries: SerializedEntry[] };
			if (parsed.v !== 1 || !Array.isArray(parsed.entries)) return null;
			return parsed.entries;
		} catch {
			return null;
		}
	}

	/**
	 * 序列化分片
	 */
	serializeSharded(entries: SerializedEntry[], shardChars?: number): { manifest: IndexShardManifest; shards: string[] } {
		const shards = shardEntries(entries, shardChars ?? DEFAULT_SHARD_CHARS);
		const manifestShards = shards.map((s, i) => ({
			scope: `shard-${i}`,
			key: `data-${i}`,
			chars: s.chars,
		}));
		const manifest: IndexShardManifest = {
			v: 1,
			shards: manifestShards,
			chars: shards.reduce((sum, s) => sum + s.chars, 0),
		};
		const serializedShards = shards.map(s => this.serialize(s.entries));
		return { manifest, shards: serializedShards };
	}

	/**
	 * 反序列化分片
	 */
	deserializeSharded(shards: string[]): SerializedEntry[] {
		const allEntries: SerializedEntry[] = [];
		for (const shard of shards) {
			const entries = this.deserialize(shard);
			if (entries) allEntries.push(...entries);
		}
		return allEntries;
	}

	/**
	 * 获取分片统计
	 */
	getShardStats(entries: SerializedEntry[], shardChars?: number): {
		totalEntries: number;
		totalChars: number;
		shardCount: number;
		avgCharsPerShard: number;
	} {
		const shards = shardEntries(entries, shardChars ?? DEFAULT_SHARD_CHARS);
		const totalChars = shards.reduce((s, sh) => s + sh.chars, 0);
		return {
			totalEntries: entries.length,
			totalChars,
			shardCount: shards.length,
			avgCharsPerShard: shards.length > 0 ? Math.round(totalChars / shards.length) : 0,
		};
	}

	/**
	 * 防抖保存
	 */
	scheduleDebouncedSave(saveFn: () => Promise<void>): void {
		this._pendingSave = true;
		if (this._debounceTimer) return;
		this._debounceTimer = setTimeout(async () => {
			this._debounceTimer = undefined;
			if (this._pendingSave) {
				this._pendingSave = false;
				try {
					await saveFn();
					this._lastSaveAt = Date.now();
					this._totalSaves++;
				} catch (err) {
					console.warn('[IndexPersistence] save failed:', err);
				}
			}
		}, DEBOUNCE_MS);
		if (this._debounceTimer && typeof (this._debounceTimer as any).unref === 'function') {
			(this._debounceTimer as any).unref();
		}
	}

	/**
	 * 强制立即保存
	 */
	async flush(saveFn: () => Promise<void>): Promise<void> {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
		this._pendingSave = false;
		await saveFn();
		this._lastSaveAt = Date.now();
		this._totalSaves++;
	}

	/**
	 * 统计
	 */
	getStats(): { totalSaves: number; totalLoads: number; lastSaveAt: number; pendingSave: boolean } {
		return {
			totalSaves: this._totalSaves,
			totalLoads: this._totalLoads,
			lastSaveAt: this._lastSaveAt,
			pendingSave: this._pendingSave,
		};
	}

	/**
	 * 记录加载
	 */
	recordLoad(): void {
		this._totalLoads++;
	}

	dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
	}
}
