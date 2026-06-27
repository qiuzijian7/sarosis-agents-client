/*---------------------------------------------------------------------------------------------
 *  访问追踪 — 记录每次记忆访问的时间戳，供保留评分和模式分析使用。
 *  参考 agentmemory src/functions/access-tracker.ts
 *
 *  与现有 accessCount 字段的区别：
 *    - accessCount：简单计数器（整数递增）
 *    - AccessTracker：时间戳窗口（最近 20 次访问时间 + 总次数 + 最后访问时间）
 *
 *  保留评分使用 recent[] 数组计算 reinforcementBoost
 *  访问模式分析使用 recent[] 检测突发访问和周期性模式
 *--------------------------------------------------------------------------------------------*/

export interface AccessLog {
	memoryId: string;
	count: number;
	lastAt: string;         // ISO timestamp
	recent: number[];        // 最近 RECENT_CAP 次访问的毫秒时间戳
}

const RECENT_CAP = 20;

export function emptyAccessLog(memoryId: string): AccessLog {
	return { memoryId, count: 0, lastAt: '', recent: [] };
}

export function normalizeAccessLog(raw: unknown): AccessLog {
	const r = (raw ?? {}) as Partial<AccessLog>;
	const rawCount = typeof r.count === 'number' && Number.isFinite(r.count) ? r.count : 0;
	const count = Math.max(0, Math.floor(rawCount));
	const rawRecent = Array.isArray(r.recent)
		? r.recent.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
		: [];
	const recent = rawRecent.length > RECENT_CAP ? rawRecent.slice(-RECENT_CAP) : rawRecent;
	return {
		memoryId: typeof r.memoryId === 'string' ? r.memoryId : '',
		count: Math.max(count, recent.length),
		lastAt: typeof r.lastAt === 'string' ? r.lastAt : '',
		recent,
	};
}

export class AccessTracker {
	private _logs = new Map<string, AccessLog>();
	private _byAgent = new Map<string, Set<string>>();  // agentId → memoryIds

	/**
	 * 记录一次访问
	 */
	record(agentId: string, memoryId: string, timestampMs?: number): void {
		if (!memoryId) return;
		const ts = timestampMs ?? Date.now();

		let log = this._logs.get(memoryId);
		if (!log) {
			log = emptyAccessLog(memoryId);
			this._logs.set(memoryId, log);
		}

		log.count++;
		log.lastAt = new Date(ts).toISOString();
		log.recent.push(ts);
		if (log.recent.length > RECENT_CAP) {
			log.recent = log.recent.slice(-RECENT_CAP);
		}

		// Index by agent
		let agentMemories = this._byAgent.get(agentId);
		if (!agentMemories) {
			agentMemories = new Set();
			this._byAgent.set(agentId, agentMemories);
		}
		agentMemories.add(memoryId);
	}

	/**
	 * 批量记录访问
	 */
	recordBatch(agentId: string, memoryIds: string[], timestampMs?: number): void {
		for (const id of memoryIds) {
			this.record(agentId, id, timestampMs);
		}
	}

	/**
	 * 获取访问日志
	 */
	get(memoryId: string): AccessLog {
		return this._logs.get(memoryId) ?? emptyAccessLog(memoryId);
	}

	/**
	 * 获取某 agent 所有记忆的访问日志
	 */
	getByAgent(agentId: string): AccessLog[] {
		const memoryIds = this._byAgent.get(agentId);
		if (!memoryIds) return [];
		return Array.from(memoryIds)
			.map(id => this._logs.get(id))
			.filter((log): log is AccessLog => log !== undefined);
	}

	/**
	 * 获取最常访问的记忆
	 */
	getTopAccessed(agentId: string, limit: number = 10): Array<{ memoryId: string; count: number; lastAt: string }> {
		return this.getByAgent(agentId)
			.sort((a, b) => b.count - a.count)
			.slice(0, limit)
			.map(log => ({ memoryId: log.memoryId, count: log.count, lastAt: log.lastAt }));
	}

	/**
	 * 获取最近访问的记忆
	 */
	getRecentlyAccessed(agentId: string, limit: number = 10): Array<{ memoryId: string; lastAt: string; count: number }> {
		return this.getByAgent(agentId)
			.filter(log => log.lastAt)
			.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
			.slice(0, limit)
			.map(log => ({ memoryId: log.memoryId, lastAt: log.lastAt, count: log.count }));
	}

	/**
	 * 删除记忆的访问日志
	 */
	delete(memoryId: string): void {
		this._logs.delete(memoryId);
		for (const [agentId, memoryIds] of this._byAgent) {
			memoryIds.delete(memoryId);
			if (memoryIds.size === 0) {
				this._byAgent.delete(agentId);
			}
		}
	}

	/**
	 * 清除某 agent 的所有访问日志
	 */
	clearAgent(agentId: string): void {
		const memoryIds = this._byAgent.get(agentId);
		if (!memoryIds) return;
		for (const id of memoryIds) {
			this._logs.delete(id);
		}
		this._byAgent.delete(agentId);
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._logs.clear();
		this._byAgent.clear();
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalTracked: number; totalAccesses: number; avgAccessPerMemory: number } {
		const logs = Array.from(this._logs.values());
		const totalAccesses = logs.reduce((s, l) => s + l.count, 0);
		return {
			totalTracked: logs.length,
			totalAccesses,
			avgAccessPerMemory: logs.length > 0 ? Math.round(totalAccesses / logs.length * 10) / 10 : 0,
		};
	}
}
