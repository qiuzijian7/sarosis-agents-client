/*---------------------------------------------------------------------------------------------
 *  记忆快照 — 版本/回滚/diff 记忆状态。
 *  参考 agentmemory src/functions/snapshot.ts
 *
 *  功能：
 *    - create: 保存当前记忆状态的快照
 *    - list: 列出所有快照
 *    - diff: 比较两个快照的差异
 *    - rollback: 回滚到指定快照
 *--------------------------------------------------------------------------------------------*/

interface InternalEntry {
	id: string;
	content: string;
	type: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
	importance?: number;
	strength: number;
	supersededBy?: string;
}

export interface SnapshotMeta {
	id: string;
	label: string;
	createdAt: string;
	stats: {
		totalEntries: number;
		activeEntries: number;
		superseded: number;
		avgStrength: number;
	};
}

export interface SnapshotDiff {
	fromSnapshot: string;
	toSnapshot: string;
	added: { ids: string[]; count: number };
	removed: { ids: string[]; count: number };
	modified: { ids: string[]; count: number };
	strengthChanges: Array<{ id: string; from: number; to: number }>;
}

interface StoredSnapshot extends SnapshotMeta {
	entries: Map<string, { content: string; strength: number; supersededBy?: string }>;
}

const MAX_SNAPSHOTS = 20;

export class SnapshotManager {
	private _snapshots = new Map<string, StoredSnapshot[]>();

	/** Create a snapshot of current memory state */
	create(agentId: string, label: string, entries: InternalEntry[]): SnapshotMeta {
		const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const now = new Date().toISOString();

		const entryMap = new Map<string, { content: string; strength: number; supersededBy?: string }>();
		let activeCount = 0;
		let supersededCount = 0;
		let totalStrength = 0;

		for (const entry of entries) {
			entryMap.set(entry.id, {
				content: entry.content,
				strength: entry.strength,
				supersededBy: entry.supersededBy,
			});
			if (entry.supersededBy) {
				supersededCount++;
			} else {
				activeCount++;
				totalStrength += entry.strength;
			}
		}

		const meta: SnapshotMeta = {
			id,
			label,
			createdAt: now,
			stats: {
				totalEntries: entries.length,
				activeEntries: activeCount,
				superseded: supersededCount,
				avgStrength: activeCount > 0 ? totalStrength / activeCount : 0,
			},
		};

		const stored: StoredSnapshot = { ...meta, entries: entryMap };
		const list = this._snapshots.get(agentId) ?? [];
		list.push(stored);

		// Cap snapshots
		while (list.length > MAX_SNAPSHOTS) list.shift();

		this._snapshots.set(agentId, list);
		return meta;
	}

	/** List all snapshots for an agent */
	list(agentId: string): SnapshotMeta[] {
		const list = this._snapshots.get(agentId) ?? [];
		return list.map(s => ({
			id: s.id,
			label: s.label,
			createdAt: s.createdAt,
			stats: s.stats,
		}));
	}

	/** Get a specific snapshot */
	get(agentId: string, snapshotId: string): StoredSnapshot | null {
		const list = this._snapshots.get(agentId) ?? [];
		return list.find(s => s.id === snapshotId) ?? null;
	}

	/** Diff two snapshots */
	diff(agentId: string, fromId: string, toId: string): SnapshotDiff | null {
		const from = this.get(agentId, fromId);
		const to = this.get(agentId, toId);
		if (!from || !to) return null;

		const fromIds = new Set(from.entries.keys());
		const toIds = new Set(to.entries.keys());

		const added: string[] = [];
		const removed: string[] = [];
		const modified: string[] = [];
		const strengthChanges: Array<{ id: string; from: number; to: number }> = [];

		for (const id of toIds) {
			if (!fromIds.has(id)) {
				added.push(id);
			} else {
				const fromEntry = from.entries.get(id)!;
				const toEntry = to.entries.get(id)!;
				if (fromEntry.content !== toEntry.content || fromEntry.supersededBy !== toEntry.supersededBy) {
					modified.push(id);
				}
				if (fromEntry.strength !== toEntry.strength) {
					strengthChanges.push({ id, from: fromEntry.strength, to: toEntry.strength });
				}
			}
		}

		for (const id of fromIds) {
			if (!toIds.has(id)) {
				removed.push(id);
			}
		}

		return {
			fromSnapshot: fromId,
			toSnapshot: toId,
			added: { ids: added, count: added.length },
			removed: { ids: removed, count: removed.length },
			modified: { ids: modified, count: modified.length },
			strengthChanges,
		};
	}

	/** Delete a snapshot */
	delete(agentId: string, snapshotId: string): void {
		const list = this._snapshots.get(agentId);
		if (!list) return;
		this._snapshots.set(agentId, list.filter(s => s.id !== snapshotId));
	}

	/** Get snapshot count */
	count(agentId: string): number {
		return this._snapshots.get(agentId)?.length ?? 0;
	}

	clear(agentId: string): void {
		this._snapshots.delete(agentId);
	}
}
