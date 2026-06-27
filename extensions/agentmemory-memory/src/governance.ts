/*---------------------------------------------------------------------------------------------
 *  治理 — 批量记忆管理操作（删除/过滤/审计查询）。
 *  参考 agentmemory src/functions/governance.ts
 *
 *  核心能力：
 *    1. governanceDelete(ids) — 按精确 ID 删除（含审计）
 *    2. governanceBulk(filter) — 按条件批量删除（支持 dryRun）
 *    3. auditQuery(filter) — 审计日志查询
 *
 *  过滤条件：
 *    - type: 记忆类型（short_term / long_term）
 *    - dateFrom / dateTo: 时间范围
 *    - qualityBelow: 强度低于此值的记忆
 *    - tags: 标签匹配
 *--------------------------------------------------------------------------------------------*/

import type { AuditLog } from './auditLog.js';

export interface GovernanceFilter {
	type?: string[];
	dateFrom?: string;
	dateTo?: string;
	qualityBelow?: number;
	tags?: string[];
	source?: string;
}

export interface BulkDeleteResult {
	success: boolean;
	deleted: number;
	failed: number;
	failures?: Array<{ id: string; error: string }>;
	dryRun?: boolean;
	wouldDelete?: number;
	candidateIds?: string[];
}

export interface GovernanceDeleteResult {
	success: boolean;
	deleted: number;
	total: number;
}

export interface GovernanceEntry {
	id: string;
	type: string;
	content: string;
	strength: number;
	timestamp: number;
	metadata?: Record<string, unknown>;
	supersededBy?: string;
}

export class GovernanceManager {
	private _audit: AuditLog;

	constructor(audit: AuditLog) {
		this._audit = audit;
	}

	/**
	 * 按精确 ID 删除记忆
	 * 调用方需提供 entries 数组和 removeFn 回调
	 */
	deleteByIds(
		ids: string[],
		entries: GovernanceEntry[],
		removeFn: (id: string) => boolean,
		reason: string = 'manual deletion',
	): GovernanceDeleteResult {
		if (!ids || ids.length === 0) {
			return { success: false, deleted: 0, total: 0 };
		}

		const idSet = new Set(ids);
		let deleted = 0;
		for (const id of ids) {
			if (removeFn(id)) {
				deleted++;
			}
		}

		this._audit.record('delete', 'governance', ids, {
			reason,
			deleted,
			requested: ids.length,
		});

		return { success: true, deleted, total: ids.length };
	}

	/**
	 * 按条件批量过滤记忆
	 * dryRun=true 时只返回候选列表，不执行删除
	 */
	bulkFilter(
		filter: GovernanceFilter & { dryRun?: boolean },
		entries: GovernanceEntry[],
		removeFn?: (id: string) => boolean,
	): BulkDeleteResult {
		const hasFilter =
			(filter.type && filter.type.length > 0) ||
			filter.dateFrom ||
			filter.dateTo ||
			filter.qualityBelow !== undefined ||
			(filter.tags && filter.tags.length > 0) ||
			filter.source;

		if (!hasFilter) {
			return { success: false, deleted: 0, failed: 0 };
		}

		let candidates = entries.filter(e => !e.supersededBy);  // 不删已取代的

		if (filter.type && filter.type.length > 0) {
			candidates = candidates.filter(c => filter.type!.includes(c.type));
		}
		if (filter.dateFrom) {
			const from = new Date(filter.dateFrom).getTime();
			if (Number.isNaN(from)) {
				return { success: false, deleted: 0, failed: 0 };
			}
			candidates = candidates.filter(c => c.timestamp >= from);
		}
		if (filter.dateTo) {
			const to = new Date(filter.dateTo).getTime();
			if (Number.isNaN(to)) {
				return { success: false, deleted: 0, failed: 0 };
			}
			candidates = candidates.filter(c => c.timestamp <= to);
		}
		if (filter.qualityBelow !== undefined) {
			candidates = candidates.filter(c => c.strength < filter.qualityBelow!);
		}
		if (filter.tags && filter.tags.length > 0) {
			candidates = candidates.filter(c => {
				const tags = c.metadata?.['tags'];
				if (!Array.isArray(tags)) return false;
				return filter.tags!.some(t => tags.includes(t));
			});
		}
		if (filter.source) {
			candidates = candidates.filter(c => c.metadata?.['source'] === filter.source);
		}

		if (filter.dryRun) {
			return {
				success: true,
				deleted: 0,
				failed: 0,
				dryRun: true,
				wouldDelete: candidates.length,
				candidateIds: candidates.map(c => c.id),
			};
		}

		if (!removeFn) {
			return { success: false, deleted: 0, failed: 0 };
		}

		let deleted = 0;
		let failed = 0;
		const failures: Array<{ id: string; error: string }> = [];

		for (const candidate of candidates) {
			try {
				if (removeFn(candidate.id)) {
					deleted++;
				} else {
					failed++;
					failures.push({ id: candidate.id, error: 'remove returned false' });
				}
			} catch (err) {
				failed++;
				failures.push({ id: candidate.id, error: err instanceof Error ? err.message : String(err) });
			}
		}

		this._audit.record('delete', 'governance-bulk', candidates.map(c => c.id), {
			filter,
			deleted,
			failed,
		});

		return {
			success: failed === 0,
			deleted,
			failed,
			failures: failures.length > 0 ? failures : undefined,
		};
	}

	/**
	 * 审计日志查询
	 */
	auditQuery(filter?: {
		operation?: string;
		agentId?: string;
		limit?: number;
	}): unknown[] {
		return this._audit.query(filter as any);
	}

	/**
	 * 审计摘要统计
	 */
	auditSummary(): Record<string, number> {
		return this._audit.getSummary() as Record<string, number>;
	}
}
