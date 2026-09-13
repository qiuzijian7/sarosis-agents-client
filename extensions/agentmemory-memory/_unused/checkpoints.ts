/*---------------------------------------------------------------------------------------------
 *  条件检查点 — 外部条件门控，等待条件满足后继续。
 *  参考 agentmemory src/functions/checkpoints.ts
 *
 *  用途：在工作流中设置检查点，等待外部条件满足：
 *    - CI 通过后才继续部署
 *    - 代码审查通过后才合并
 *    - 定时器到期后才执行
 *    - 外部审批通过后才继续
 *--------------------------------------------------------------------------------------------*/

export type CheckpointType = 'ci' | 'approval' | 'deploy' | 'external' | 'timer';
export type CheckpointStatus = 'pending' | 'passed' | 'failed' | 'expired';

export interface Checkpoint {
	id: string;
	name: string;
	description: string;
	type: CheckpointType;
	status: CheckpointStatus;
	createdAt: string;
	resolvedAt?: string;
	resolvedBy?: string;
	result?: unknown;
	expiresAt?: string;
	linkedActionIds: string[];
	waiters: number; // number of agents waiting on this checkpoint
}

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export class CheckpointManager {
	private _checkpoints = new Map<string, Checkpoint>();

	/** Create a new checkpoint */
	create(opts: {
		name: string;
		description?: string;
		type: CheckpointType;
		linkedActionIds?: string[];
		expiresInMs?: number;
	}): Checkpoint {
		const id = `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const now = new Date().toISOString();
		const checkpoint: Checkpoint = {
			id,
			name: opts.name,
			description: opts.description ?? '',
			type: opts.type,
			status: 'pending',
			createdAt: now,
			expiresAt: opts.expiresInMs !== undefined
				? new Date(Date.now() + opts.expiresInMs).toISOString()
				: new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString(),
			linkedActionIds: opts.linkedActionIds ?? [],
			waiters: 0,
		};
		this._checkpoints.set(id, checkpoint);
		return checkpoint;
	}

	/** Resolve a checkpoint (pass or fail) */
	resolve(id: string, status: 'passed' | 'failed', resolvedBy: string, result?: unknown): boolean {
		const checkpoint = this._checkpoints.get(id);
		if (!checkpoint || checkpoint.status !== 'pending') return false;
		checkpoint.status = status;
		checkpoint.resolvedAt = new Date().toISOString();
		checkpoint.resolvedBy = resolvedBy;
		checkpoint.result = result;
		return true;
	}

	/** Get a checkpoint */
	get(id: string): Checkpoint | null {
		return this._checkpoints.get(id) ?? null;
	}

	/** List checkpoints by status */
	list(status?: CheckpointStatus): Checkpoint[] {
		const all = Array.from(this._checkpoints.values());
		if (!status) return all;
		return all.filter(c => c.status === status);
	}

	/** Wait for a checkpoint (increments waiter count) */
	wait(id: string): boolean {
		const checkpoint = this._checkpoints.get(id);
		if (!checkpoint || checkpoint.status !== 'pending') return false;
		checkpoint.waiters++;
		return true;
	}

	/** Stop waiting */
	unwait(id: string): void {
		const checkpoint = this._checkpoints.get(id);
		if (checkpoint && checkpoint.waiters > 0) checkpoint.waiters--;
	}

	/** Check if a checkpoint is resolved (passed) */
	isPassed(id: string): boolean {
		return this._checkpoints.get(id)?.status === 'passed';
	}

	/** Check if a checkpoint is still pending */
	isPending(id: string): boolean {
		return this._checkpoints.get(id)?.status === 'pending';
	}

	/** Expire pending checkpoints past their expiry */
	pruneExpired(): number {
		const now = new Date().toISOString();
		let expired = 0;
		for (const checkpoint of this._checkpoints.values()) {
			if (checkpoint.status === 'pending' && checkpoint.expiresAt && checkpoint.expiresAt < now) {
				checkpoint.status = 'expired';
				checkpoint.resolvedAt = now;
				expired++;
			}
		}
		return expired;
	}

	/** Get pending checkpoints for an action */
	getForAction(actionId: string): Checkpoint[] {
		return Array.from(this._checkpoints.values())
			.filter(c => c.linkedActionIds.includes(actionId));
	}

	get count(): number { return this._checkpoints.size; }

	clear(): void {
		this._checkpoints.clear();
	}
}
