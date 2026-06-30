/*---------------------------------------------------------------------------------------------
 *  审计 Trail — 记录所有记忆操作，供追溯和诊断。
 *  参考 agentmemory src/functions/audit.ts
 *
 *  操作类型：write / search / delete / decay / sweep / reinforce / consolidate / session
 *--------------------------------------------------------------------------------------------*/

export type AuditOperation =
	| 'write'
	| 'search'
	| 'delete'
	| 'decay'
	| 'sweep'
	| 'reinforce'
	| 'consolidate'
	| 'session_start'
	| 'session_end'
	| 'contradiction'
	| 'flush'
	| 'dedup_skip'
	| 'retention'
	| 'cascade'
	| 'skill_extract';

export interface AuditEntry {
	id: string;
	timestamp: number;
	operation: AuditOperation;
	agentId: string;
	targetIds: string[];
	details: Record<string, unknown>;
}

const MAX_AUDIT_ENTRIES = 500;

export class AuditLog {
	private _entries: AuditEntry[] = [];

	record(
		operation: AuditOperation,
		agentId: string,
		targetIds: string[] = [],
		details: Record<string, unknown> = {},
	): void {
		this._entries.push({
			id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: Date.now(),
			operation,
			agentId,
			targetIds,
			details,
		});
		// FIFO cleanup
		while (this._entries.length > MAX_AUDIT_ENTRIES) {
			this._entries.shift();
		}
	}

	query(filter?: {
		operation?: AuditOperation;
		agentId?: string;
		limit?: number;
	}): AuditEntry[] {
		let results = this._entries;
		if (filter?.operation) {
			results = results.filter(e => e.operation === filter.operation);
		}
		if (filter?.agentId) {
			results = results.filter(e => e.agentId === filter.agentId);
		}
		if (filter?.limit) {
			results = results.slice(-filter.limit);
		}
		return [...results].reverse(); // newest first
	}

	get count(): number {
		return this._entries.length;
	}

	clear(): void {
		this._entries = [];
	}

	/** Get summary statistics */
	getSummary(): Record<AuditOperation, number> {
		const summary = {} as Record<AuditOperation, number>;
		for (const entry of this._entries) {
			summary[entry.operation] = (summary[entry.operation] ?? 0) + 1;
		}
		return summary;
	}
}
