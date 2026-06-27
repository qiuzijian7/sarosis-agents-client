/*---------------------------------------------------------------------------------------------
 *  磁盘管理 — 跟踪和限制记忆系统的磁盘使用。
 *  参考 agentmemory src/functions/disk-size-manager.ts
 *
 *  功能：
 *    - 估算记忆数据占用的磁盘空间
 *    - 设置磁盘配额，超限时触发清理
 *    - 按类型统计存储分布
 *--------------------------------------------------------------------------------------------*/

export interface DiskUsageStats {
	totalBytes: number;
	totalMB: number;
	byAgent: Array<{ agentId: string; bytes: number; entries: number }>;
	byType: Record<string, number>;
	quotaMB: number;
	quotaUsed: number; // percentage
	overQuota: boolean;
}

const DEFAULT_QUOTA_MB = 100; // 100 MB default quota

interface AgentData {
	agentId: string;
	bytes: number;
	entries: number;
}

export class DiskManager {
	private _quotaMB = DEFAULT_QUOTA_MB;
	private _onOverQuota?: () => void;

	/** Set disk quota in MB */
	setQuota(mb: number): void {
		this._quotaMB = mb;
	}

	/** Set callback for quota exceeded */
	onOverQuota(callback: () => void): void {
		this._onOverQuota = callback;
	}

	/** Estimate disk usage from in-memory data */
	estimate(opts: {
		agents: Array<{
			agentId: string;
			shortTermEntries: Array<{ content: string }>;
			longTermEntries: Array<{ content: string; metadata?: Record<string, unknown> }>;
		}>;
	}): DiskUsageStats {
		let totalBytes = 0;
		const byAgent: AgentData[] = [];
		const byType: Record<string, number> = {
			short_term: 0,
			long_term: 0,
			metadata: 0,
			indexes: 0,
		};

		for (const agent of opts.agents) {
			let agentBytes = 0;

			// Short-term entries
			let shortBytes = 0;
			for (const entry of agent.shortTermEntries) {
				shortBytes += this._estimateStringSize(entry.content);
			}
			byType['short_term'] += shortBytes;
			agentBytes += shortBytes;

			// Long-term entries
			let longBytes = 0;
			let metaBytes = 0;
			for (const entry of agent.longTermEntries) {
				longBytes += this._estimateStringSize(entry.content);
				if (entry.metadata) {
					metaBytes += this._estimateObjectSize(entry.metadata);
				}
			}
			byType['long_term'] += longBytes;
			byType['metadata'] += metaBytes;
			agentBytes += longBytes + metaBytes;

			// Estimate index overhead (~10% of content)
			const indexBytes = Math.round(agentBytes * 0.1);
			byType['indexes'] += indexBytes;
			agentBytes += indexBytes;

			totalBytes += agentBytes;
			byAgent.push({
				agentId: agent.agentId,
				bytes: agentBytes,
				entries: agent.shortTermEntries.length + agent.longTermEntries.length,
			});
		}

		const totalMB = totalBytes / (1024 * 1024);
		const quotaUsed = this._quotaMB > 0 ? (totalMB / this._quotaMB) * 100 : 0;
		const overQuota = totalMB > this._quotaMB;

		if (overQuota && this._onOverQuota) {
			this._onOverQuota();
		}

		return {
			totalBytes,
			totalMB: Math.round(totalMB * 100) / 100,
			byAgent: byAgent.sort((a, b) => b.bytes - a.bytes),
			byType,
			quotaMB: this._quotaMB,
			quotaUsed: Math.round(quotaUsed * 100) / 100,
			overQuota,
		};
	}

	private _estimateStringSize(s: string): number {
		// UTF-8: 1-4 bytes per char, average ~1.5 for mixed content
		return Math.round(s.length * 1.5);
	}

	private _estimateObjectSize(obj: Record<string, unknown>): number {
		try {
			return JSON.stringify(obj).length * 1.5;
		} catch {
			return 100; // fallback
		}
	}

	get quotaMB(): number { return this._quotaMB; }
}
