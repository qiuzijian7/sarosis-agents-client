/*---------------------------------------------------------------------------------------------
 *  增量记忆同步 — 多 Agent 间通过 MeshCoordinator 同步记忆。
 *
 *  场景：
 *    Agent A 写入了一条记忆，通过 Mesh 网络将记忆条目路由给 Agent B。
 *    Agent B 接收后合并到自己的记忆库中。
 *
 *  同步策略：
 *    1. 增量同步 — 只同步新增的记忆（基于 timestamp 和 id 去重）
 *    2. 按 type 过滤 — 可选择只同步特定类型（如只同步 episodic）
 *    3. 双向确认 — 接收方返回已同步的条目数，发送方据此更新同步状态
 *--------------------------------------------------------------------------------------------*/

export interface SyncEntry {
	id: string;
	type: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

export interface SyncRequest {
	fromAgentId: string;
	toAgentId: string;
	entries: SyncEntry[];
	syncId: string;
	timestamp: number;
}

export interface SyncResponse {
	syncId: string;
	accepted: number;
	skipped: number;
	errors: string[];
}

export interface SyncStats {
	totalSynced: number;
	totalReceived: number;
	totalSkipped: number;
	lastSyncAt: number;
}

export class MemorySync {
	private _syncedIds = new Set<string>();
	private _stats: SyncStats = { totalSynced: 0, totalReceived: 0, totalSkipped: 0, lastSyncAt: 0 };
	private _maxSyncedIds = 10000;

	/**
	 * 创建同步请求 — 发送方调用
	 */
	createSyncRequest(fromAgentId: string, toAgentId: string, entries: SyncEntry[]): SyncRequest {
		// Filter out already-synced entries
		const newEntries = entries.filter(e => !this._syncedIds.has(e.id));
		return {
			fromAgentId,
			toAgentId,
			entries: newEntries,
			syncId: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: Date.now(),
		};
	}

	/**
	 * 处理同步请求 — 接收方调用
	 * Returns the entries that should be written to memory.
	 */
	handleSyncRequest(request: SyncRequest): { entries: SyncEntry[]; response: SyncResponse } {
		const accepted: SyncEntry[] = [];
		let skipped = 0;
		const errors: string[] = [];

		for (const entry of request.entries) {
			// Dedup check
			if (this._syncedIds.has(entry.id)) {
				skipped++;
				continue;
			}

			// Track as synced
			this._syncedIds.add(entry.id);
			if (this._syncedIds.size > this._maxSyncedIds) {
				// Trim: remove oldest 20% (Set doesn't have order, but this prevents unbounded growth)
				const toRemove = Math.floor(this._maxSyncedIds * 0.2);
				let removed = 0;
				for (const id of this._syncedIds) {
					this._syncedIds.delete(id);
					if (++removed >= toRemove) break;
				}
			}

			accepted.push(entry);
		}

		this._stats.totalReceived += request.entries.length;
		this._stats.totalSynced += accepted.length;
		this._stats.totalSkipped += skipped;
		this._stats.lastSyncAt = Date.now();

		const response: SyncResponse = {
			syncId: request.syncId,
			accepted: accepted.length,
			skipped,
			errors,
		};

		return { entries: accepted, response };
	}

	/**
	 * 标记条目为已同步（发送方在收到确认后调用）
	 */
	markSynced(entries: SyncEntry[]): void {
		for (const entry of entries) {
			this._syncedIds.add(entry.id);
		}
	}

	/**
	 * 获取同步统计
	 */
	getStats(): SyncStats {
		return { ...this._stats };
	}

	/**
	 * 清除同步状态
	 */
	clear(): void {
		this._syncedIds.clear();
		this._stats = { totalSynced: 0, totalReceived: 0, totalSkipped: 0, lastSyncAt: 0 };
	}
}
