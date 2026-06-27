/*---------------------------------------------------------------------------------------------
 *  优先级队列 — 按优先级批量处理记忆操作。
 *  参考 agentmemory 的批量写入 + 合并机制
 *
 *  与现有写防抖（_schedulePersist）的区别：
 *    - 写防抖：5 秒窗口合并所有写入（无优先级）
 *    - PriorityQueue：按优先级排序处理（高优先级先执行）+ 批量合并
 *
 *  核心场景：
 *    1. 高频写入 → 按优先级批量处理
 *    2. 系统关闭时 → flush 所有待处理操作
 *    3. 资源紧张时 → 只处理高优先级操作
 *
 *  优先级：
 *    critical (1) — 立即执行（如 dispose 前 flush）
 *    high (2)     — 优先执行（如用户显式搜索）
 *    normal (3)   — 正常执行（如 writeMemory）
 *    low (4)      — 延迟执行（如 sweep 后的清理）
 *    background (5) — 后台执行（如索引更新）
 *--------------------------------------------------------------------------------------------*/

export type QueuePriority = 1 | 2 | 3 | 4 | 5;  // 1=critical, 5=background

export interface QueueItem<T = unknown> {
	id: string;
	priority: QueuePriority;
	data: T;
	createdAt: number;
	expiresAt?: number;
}

export interface BatchResult<T> {
	processed: number;
	skipped: number;
	errors: Array<{ id: string; error: string }>;
	items: T[];
}

export interface PriorityQueueStats {
	totalItems: number;
	itemsByPriority: Record<number, number>;
	totalProcessed: number;
	totalErrors: number;
	avgBatchSize: number;
	oldestItemAge: number;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const EXPIRY_CHECK_INTERVAL_MS = 60_000;
const MAX_QUEUE_SIZE = 5000;

export class PriorityQueue<T = unknown> {
	private _items: QueueItem<T>[] = [];
	private _processed = 0;
	private _errors = 0;
	private _batchSizes: number[] = [];
	private _expiryTimer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		this._expiryTimer = setInterval(() => {
			this._removeExpired();
		}, EXPIRY_CHECK_INTERVAL_MS);
		if (this._expiryTimer && typeof (this._expiryTimer as any).unref === 'function') {
			(this._expiryTimer as any).unref();
		}
	}

	/**
	 * 入队
	 */
	enqueue(data: T, priority: QueuePriority = 3, ttlMs?: number): string {
		// 队列满时丢弃最低优先级
		if (this._items.length >= MAX_QUEUE_SIZE) {
			this._items.sort((a, b) => b.priority - a.priority);
			this._items.shift();
		}

		const id = generateId('q');
		const item: QueueItem<T> = {
			id,
			priority,
			data,
			createdAt: Date.now(),
			expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
		};

		this._items.push(item);

		// 按优先级排序（critical=1 在前）
		this._items.sort((a, b) => a.priority - b.priority);

		return id;
	}

	/**
	 * 批量入队
	 */
	enqueueBatch(items: Array<{ data: T; priority?: QueuePriority; ttlMs?: number }>): string[] {
		const ids: string[] = [];
		for (const item of items) {
			ids.push(this.enqueue(item.data, item.priority ?? 3, item.ttlMs));
		}
		return ids;
	}

	/**
	 * 出队（取最高优先级）
	 */
	dequeue(): QueueItem<T> | null {
		if (this._items.length === 0) return null;
		return this._items.shift() ?? null;
	}

	/**
	 * 批量出队
	 */
	dequeueBatch(maxSize: number = 50, maxPriority?: QueuePriority): QueueItem<T>[] {
		if (maxPriority !== undefined) {
			// 只取指定优先级及更高（数值更小）的
			const matching = this._items.filter(i => i.priority <= maxPriority);
			const toTake = matching.slice(0, maxSize);
			this._items = this._items.filter(i => !toTake.includes(i));
			this._batchSizes.push(toTake.length);
			return toTake;
		}

		const batch = this._items.slice(0, maxSize);
		this._items = this._items.slice(maxSize);
		this._batchSizes.push(batch.length);
		return batch;
	}

	/**
	 * 批量处理
	 */
	async processBatch(
		handler: (items: T[]) => Promise<void>,
		maxSize: number = 50,
		maxPriority?: QueuePriority,
	): Promise<BatchResult<T>> {
		const batch = this.dequeueBatch(maxSize, maxPriority);
		const items = batch.map(b => b.data);

		if (items.length === 0) {
			return { processed: 0, skipped: 0, errors: [], items: [] };
		}

		const errors: Array<{ id: string; error: string }> = [];
		try {
			await handler(items);
			this._processed += items.length;
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			for (const item of batch) {
				errors.push({ id: item.id, error: errorMsg });
			}
			this._errors += batch.length;
		}

		return {
			processed: items.length,
			skipped: 0,
			errors,
			items,
		};
	}

	/**
	 * 移除指定项
	 */
	remove(id: string): boolean {
		const idx = this._items.findIndex(i => i.id === id);
		if (idx >= 0) {
			this._items.splice(idx, 1);
			return true;
		}
		return false;
	}

	/**
	 * 获取队列大小
	 */
	get size(): number {
		return this._items.length;
	}

	/**
	 * 检查是否为空
	 */
	get isEmpty(): boolean {
		return this._items.length === 0;
	}

	/**
	 * 查看队首（不出队）
	 */
	peek(): QueueItem<T> | null {
		return this._items[0] ?? null;
	}

	/**
	 * 获取统计
	 */
	getStats(): PriorityQueueStats {
		const byPriority: Record<number, number> = {};
		let oldestTime = Date.now();
		for (const item of this._items) {
			byPriority[item.priority] = (byPriority[item.priority] ?? 0) + 1;
			if (item.createdAt < oldestTime) oldestTime = item.createdAt;
		}

		const avgBatch = this._batchSizes.length > 0
			? this._batchSizes.reduce((s, v) => s + v, 0) / this._batchSizes.length
			: 0;

		return {
			totalItems: this._items.length,
			itemsByPriority: byPriority,
			totalProcessed: this._processed,
			totalErrors: this._errors,
			avgBatchSize: Math.round(avgBatch * 10) / 10,
			oldestItemAge: this._items.length > 0 ? Date.now() - oldestTime : 0,
		};
	}

	/**
	 * 清除过期项
	 */
	private _removeExpired(): number {
		const now = Date.now();
		const before = this._items.length;
		this._items = this._items.filter(item => !item.expiresAt || item.expiresAt > now);
		return before - this._items.length;
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._items = [];
		this._batchSizes = [];
	}

	dispose(): void {
		if (this._expiryTimer) {
			clearInterval(this._expiryTimer);
			this._expiryTimer = undefined;
		}
	}
}
