/*---------------------------------------------------------------------------------------------
 *  租约 — 动作的并发访问控制。
 *  参考 agentmemory src/functions/leases.ts
 *
 *  在多 Agent 并行场景下，防止多个 Agent 同时认领同一动作。
 *  租约有 TTL，过期自动释放。
 *
 *  核心能力：
 *    1. acquire(actionId, agentId, ttl) — 获取租约
 *    2. release(actionId, agentId) — 释放租约
 *    3. renew(leaseId, ttl) — 续租
 *    4. getActiveLeases() — 获取活跃租约
 *    5. cleanup() — 清理过期租约
 *--------------------------------------------------------------------------------------------*/

export interface Lease {
	id: string;
	actionId: string;
	agentId: string;
	acquiredAt: string;
	expiresAt: string;
	status: 'active' | 'expired' | 'released';
	renewedCount: number;
}

export interface AcquireResult {
	success: boolean;
	lease?: Lease;
	renewed?: boolean;
	error?: string;
	heldBy?: string;
	expiresAt?: string;
}

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;   // 10 分钟
const MAX_LEASE_TTL_MS = 60 * 60 * 1000;       // 1 小时
const MAX_RENEWALS = 5;

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class LeaseManager {
	private _leases = new Map<string, Lease>();           // leaseId → Lease
	private _byAction = new Map<string, Lease>();           // actionId → active Lease
	private _cleanupTimer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		// 每 60 秒清理过期租约
		this._cleanupTimer = setInterval(() => {
			this.cleanup();
		}, 60 * 1000);
		if (this._cleanupTimer && typeof (this._cleanupTimer as any).unref === 'function') {
			(this._cleanupTimer as any).unref();
		}
	}

	/**
	 * 获取租约
	 */
	acquire(actionId: string, agentId: string, ttlMs?: number): AcquireResult {
		const rawTtl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
			? ttlMs
			: DEFAULT_LEASE_TTL_MS;
		const ttl = Math.min(rawTtl, MAX_LEASE_TTL_MS);

		const now = Date.now();

		// 检查现有活跃租约
		const existing = this._byAction.get(actionId);
		if (existing && existing.status === 'active') {
			const expiresAt = new Date(existing.expiresAt).getTime();
			if (expiresAt > now) {
				// 还有效
				if (existing.agentId === agentId) {
					// 同一 agent，视为续租
					return { success: true, lease: existing, renewed: false };
				}
				return {
					success: false,
					error: 'action already leased',
					heldBy: existing.agentId,
					expiresAt: existing.expiresAt,
				};
			} else {
				// 过期了，清理
				existing.status = 'expired';
				this._byAction.delete(actionId);
			}
		}

		const nowDate = new Date(now);
		const lease: Lease = {
			id: generateId('lse'),
			actionId,
			agentId,
			acquiredAt: nowDate.toISOString(),
			expiresAt: new Date(now + ttl).toISOString(),
			status: 'active',
			renewedCount: 0,
		};

		this._leases.set(lease.id, lease);
		this._byAction.set(actionId, lease);

		return { success: true, lease };
	}

	/**
	 * 释放租约
	 */
	release(actionId: string, agentId: string): boolean {
		const lease = this._byAction.get(actionId);
		if (!lease || lease.agentId !== agentId) {
			return false;
		}
		lease.status = 'released';
		this._byAction.delete(actionId);
		return true;
	}

	/**
	 * 续租
	 */
	renew(leaseId: string, ttlMs?: number): AcquireResult {
		const lease = this._leases.get(leaseId);
		if (!lease) {
			return { success: false, error: 'lease not found' };
		}
		if (lease.status !== 'active') {
			return { success: false, error: `lease is ${lease.status}` };
		}
		if (lease.renewedCount >= MAX_RENEWALS) {
			return { success: false, error: 'max renewals exceeded' };
		}

		const rawTtl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
			? ttlMs
			: DEFAULT_LEASE_TTL_MS;
		const ttl = Math.min(rawTtl, MAX_LEASE_TTL_MS);

		lease.expiresAt = new Date(Date.now() + ttl).toISOString();
		lease.renewedCount++;

		return { success: true, lease, renewed: true };
	}

	/**
	 * 获取活跃租约列表
	 */
	getActiveLeases(): Lease[] {
		const now = Date.now();
		return Array.from(this._leases.values()).filter(l => {
			if (l.status !== 'active') return false;
			return new Date(l.expiresAt).getTime() > now;
		});
	}

	/**
	 * 获取某 agent 持有的租约
	 */
	getLeasesByAgent(agentId: string): Lease[] {
		return this.getActiveLeases().filter(l => l.agentId === agentId);
	}

	/**
	 * 检查动作是否被租约
	 */
	isLeased(actionId: string): boolean {
		const lease = this._byAction.get(actionId);
		if (!lease || lease.status !== 'active') return false;
		return new Date(lease.expiresAt).getTime() > Date.now();
	}

	/**
	 * 清理过期租约
	 */
	cleanup(): number {
		const now = Date.now();
		let cleaned = 0;
		for (const [id, lease] of this._leases) {
			if (lease.status === 'active' && new Date(lease.expiresAt).getTime() <= now) {
				lease.status = 'expired';
				this._byAction.delete(lease.actionId);
				cleaned++;
			}
			// 清理已释放/过期的旧记录（保留 1 小时）
			if (lease.status !== 'active') {
				const expiredAt = new Date(lease.expiresAt).getTime();
				if (now - expiredAt > 60 * 60 * 1000) {
					this._leases.delete(id);
				}
			}
		}
		return cleaned;
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalLeases: number; activeLeases: number; expiredLeases: number; releasedLeases: number } {
		const leases = Array.from(this._leases.values());
		return {
			totalLeases: leases.length,
			activeLeases: leases.filter(l => l.status === 'active').length,
			expiredLeases: leases.filter(l => l.status === 'expired').length,
			releasedLeases: leases.filter(l => l.status === 'released').length,
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._leases.clear();
		this._byAction.clear();
	}

	dispose(): void {
		if (this._cleanupTimer) {
			clearInterval(this._cleanupTimer);
			this._cleanupTimer = undefined;
		}
	}
}
