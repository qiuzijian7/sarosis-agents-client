/*---------------------------------------------------------------------------------------------
 *  并发锁 — 按 key 隔离的并发写安全。
 *  参考 agentmemory src/state/keyed-mutex.ts
 *
 *  解决问题：多个异步操作可能同时修改同一 agent 的记忆。
 *  ConcurrentLock 提供按 key（agentId/memoryId）的互斥访问。
 *
 *  核心能力：
 *    1. acquire(key) — 获取锁（返回释放函数）
 *    2. withLock(key, fn) — 在锁保护下执行
 *    3. tryAcquire(key) — 非阻塞获取（失败返回 null）
 *    4. getLockStats() — 获取锁统计
 *
 *  注意：这是 async 锁，不是 OS 级锁。用于防止 JS 事件循环中的竞态条件。
 *--------------------------------------------------------------------------------------------*/

export interface LockStats {
	totalAcquired: number;
	totalReleased: number;
	totalWaited: number;
	totalTimedOut: number;
	activeLocks: number;
	queuedOperations: number;
}

interface LockEntry {
	queue: Array<{ resolve: () => void; reject: (err: Error) => void; acquiredAt: number }>;
	acquiredAt: number;
	owner?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ConcurrentLock {
	private _locks = new Map<string, LockEntry>();
	private _stats = { totalAcquired: 0, totalReleased: 0, totalWaited: 0, totalTimedOut: 0 };
	private _maxQueueSize = 100;

	/**
	 * 在锁保护下执行
	 */
	async withLock<T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
		const release = await this.acquire(key, timeoutMs);
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/**
	 * 获取锁
	 */
	async acquire(key: string, timeoutMs?: number): Promise<() => void> {
		const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let entry = this._locks.get(key);

		if (!entry) {
			// 无竞争：直接获取
			entry = { queue: [], acquiredAt: Date.now() };
			this._locks.set(key, entry);
			this._stats.totalAcquired++;
			return () => this._release(key);
		}

		// 有竞争：加入队列等待
		if (entry.queue.length >= this._maxQueueSize) {
			throw new Error(`Lock queue full for key: ${key}`);
		}

		this._stats.totalWaited++;
		return new Promise<() => void>((resolve, reject) => {
			const waitStart = Date.now();
			let timedOut = false;

			const timer = setTimeout(() => {
				timedOut = true;
				this._stats.totalTimedOut++;
				reject(new Error(`Lock timeout for key: ${key} (waited ${timeoutMs}ms)`));
			}, timeout);

			entry!.queue.push({
				resolve: () => {
					clearTimeout(timer);
					if (!timedOut) {
						this._stats.totalAcquired++;
						resolve(() => this._release(key));
					}
				},
				reject: (err: Error) => {
					clearTimeout(timer);
					if (!timedOut) reject(err);
				},
				acquiredAt: waitStart,
			});
		});
	}

	/**
	 * 非阻塞获取
	 */
	tryAcquire(key: string): (() => void) | null {
		if (this._locks.has(key)) return null;
		this._locks.set(key, { queue: [], acquiredAt: Date.now() });
		this._stats.totalAcquired++;
		return () => this._release(key);
	}

	/**
	 * 释放锁
	 */
	private _release(key: string): void {
		const entry = this._locks.get(key);
		if (!entry) return;

		this._stats.totalReleased++;

		if (entry.queue.length > 0) {
			// 唤醒下一个等待者
			const next = entry.queue.shift()!;
			entry.acquiredAt = Date.now();
			next.resolve();
		} else {
			// 无等待者，删除锁
			this._locks.delete(key);
		}
	}

	/**
	 * 检查锁是否被持有
	 */
	isLocked(key: string): boolean {
		return this._locks.has(key);
	}

	/**
	 * 获取活跃锁数
	 */
	get activeLocks(): number {
		return this._locks.size;
	}

	/**
	 * 获取等待中的操作数
	 */
	get queuedOperations(): number {
		let total = 0;
		for (const entry of this._locks.values()) {
			total += entry.queue.length;
		}
		return total;
	}

	/**
	 * 获取统计
	 */
	getStats(): LockStats {
		return {
			...this._stats,
			activeLocks: this._locks.size,
			queuedOperations: this.queuedOperations,
		};
	}

	/**
	 * 强制释放（谨慎使用）
	 */
	forceRelease(key: string): boolean {
		const entry = this._locks.get(key);
		if (!entry) return false;
		// 拒绝所有等待者
		for (const waiter of entry.queue) {
			waiter.reject(new Error(`Lock force released for key: ${key}`));
		}
		this._locks.delete(key);
		return true;
	}

	/**
	 * 清除所有锁
	 */
	clear(): void {
		for (const [key, entry] of this._locks) {
			for (const waiter of entry.queue) {
				waiter.reject(new Error(`All locks cleared`));
			}
		}
		this._locks.clear();
	}
}
