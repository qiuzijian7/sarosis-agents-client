/*---------------------------------------------------------------------------------------------
 *  独立驱逐 — 多策略驱逐系统（LRU/LFU/FIFO + 策略组合）。
 *  1:1 复刻 agentmemory src/functions/evict.ts
 *
 *  与现有 _sweepAgent 的区别：
 *    - _sweepAgent：固定的清理策略（superseded/strength/importance/cap）
 *    - evict：可配置的多策略驱逐系统（stale sessions + low importance + cap + expired memories）
 *--------------------------------------------------------------------------------------------*/

export interface EvictionConfig {
	staleSessionDays: number;
	lowImportanceMaxDays: number;
	lowImportanceThreshold: number;
	maxObservationsPerProject: number;
}

export interface EvictionStats {
	staleSessions: number;
	lowImportanceObs: number;
	capEvictions: number;
	expiredMemories: number;
	nonLatestMemories: number;
	dryRun: boolean;
}

export interface EvictEntry {
	id: string;
	content: string;
	importance: number;
	strength: number;
	timestamp: number;
	supersededBy?: string;
	sessionId?: string;
	project?: string;
	metadata?: Record<string, unknown>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULTS: EvictionConfig = {
	staleSessionDays: 30,
	lowImportanceMaxDays: 90,
	lowImportanceThreshold: 3,
	maxObservationsPerProject: 10_000,
};

export class EvictionManager {
	private _config: EvictionConfig;

	constructor(config?: Partial<EvictionConfig>) {
		this._config = { ...DEFAULTS, ...config };
	}

	/**
	 * 执行驱逐（返回候选驱逐列表）
	 */
	evict(entries: EvictEntry[], dryRun: boolean = false): { evicted: EvictEntry[]; stats: EvictionStats } {
		const now = Date.now();
		const evicted: EvictEntry[] = [];
		const stats: EvictionStats = {
			staleSessions: 0, lowImportanceObs: 0, capEvictions: 0,
			expiredMemories: 0, nonLatestMemories: 0, dryRun,
		};

		const byProject = new Map<string, EvictEntry[]>();

		for (const entry of entries) {
			let shouldEvict = false;

			// 1. Non-latest memories (superseded)
			if (entry.supersededBy) {
				shouldEvict = true;
				stats.nonLatestMemories++;
			}

			// 2. Expired memories (strength below floor)
			if (!shouldEvict && entry.strength < 0.1) {
				shouldEvict = true;
				stats.expiredMemories++;
			}

			// 3. Low importance + old
			if (!shouldEvict && entry.importance < this._config.lowImportanceThreshold) {
				const age = now - entry.timestamp;
				if (age > this._config.lowImportanceMaxDays * MS_PER_DAY) {
					shouldEvict = true;
					stats.lowImportanceObs++;
				}
			}

			// 4. Stale sessions (no access in staleSessionDays)
			if (!shouldEvict) {
				const lastAccessed = (entry.metadata?.['lastAccessedAt'] as number) ?? entry.timestamp;
				if (now - lastAccessed > this._config.staleSessionDays * MS_PER_DAY) {
					// Only evict if also low importance
					if (entry.importance < 5) {
						shouldEvict = true;
						stats.staleSessions++;
					}
				}
			}

			if (shouldEvict) {
				evicted.push(entry);
			} else {
				// Group by project for cap check
				const project = entry.project ?? '_default';
				const list = byProject.get(project) ?? [];
				list.push(entry);
				byProject.set(project, list);
			}
		}

		// 5. Cap: if too many per project, evict weakest
		for (const [project, projectEntries] of byProject) {
			if (projectEntries.length > this._config.maxObservationsPerProject) {
				const sorted = projectEntries.sort((a, b) => a.strength - b.strength);
				const toEvict = sorted.slice(0, projectEntries.length - this._config.maxObservationsPerProject);
				for (const e of toEvict) {
					evicted.push(e);
					stats.capEvictions++;
				}
			}
		}

		return { evicted, stats };
	}

	/**
	 * 更新配置
	 */
	updateConfig(config: Partial<EvictionConfig>): void {
		this._config = { ...this._config, ...config };
	}

	getConfig(): EvictionConfig { return { ...this._config }; }

	/**
	 * 按策略排序（用于 cap 驱逐时选择受害者）
	 */
	sortByVictimScore(entries: EvictEntry[], strategy: 'lru' | 'lfu' | 'fifo' | 'weakest' = 'weakest'): EvictEntry[] {
		const sorted = [...entries];
		switch (strategy) {
			case 'lru':
				sorted.sort((a, b) => {
					const aLast = (a.metadata?.['lastAccessedAt'] as number) ?? a.timestamp;
					const bLast = (b.metadata?.['lastAccessedAt'] as number) ?? b.timestamp;
					return aLast - bLast;
				});
				break;
			case 'lfu':
				sorted.sort((a, b) => {
					const aCount = (a.metadata?.['accessCount'] as number) ?? 0;
					const bCount = (b.metadata?.['accessCount'] as number) ?? 0;
					return aCount - bCount;
				});
				break;
			case 'fifo':
				sorted.sort((a, b) => a.timestamp - b.timestamp);
				break;
			case 'weakest':
			default:
				sorted.sort((a, b) => a.strength - b.strength || a.importance - b.importance);
				break;
		}
		return sorted;
	}

	clear(): void {}
}
