/*---------------------------------------------------------------------------------------------
 *  滑动窗口 — 管理最近 N 轮对话的上下文窗口。
 *  参考 agentmemory src/functions/sliding-window.ts
 *
 *  与 ContextManager（VS Code 核心）的区别：
 *    - ContextManager：管理整个对话窗口的 token 预算 + 压缩
 *    - SlidingWindow：记忆层滑动窗口，维护最近相关记忆的活跃集
 *
 *  核心能力：
 *    1. 维护固定大小的"活跃窗口"（最近访问的记忆）
 *    2. 窗口满时，最旧的记忆被"滑出"到 long-term 存储
 *    3. 重复访问的记忆会"固定"在窗口中
 *    4. 支持按 token 预算自动调整窗口大小
 *
 *  适用场景：
 *    - 每轮对话自动加载最近相关的记忆
 *    - 避免 long-term 搜索开销（直接从窗口取）
 *    - 记忆访问模式分析（哪些记忆被反复访问）
 *--------------------------------------------------------------------------------------------*/

export interface WindowEntry {
	id: string;
	content: string;
	type: string;
	timestamp: number;
	score: number;              // 相关性分数
	accessCount: number;        // 在窗口内被访问次数
	pinned: boolean;           // 固定不滑出
	insertedAt: number;         // 进入窗口的时间
	lastAccessedAt: number;
	tokenEstimate: number;
	source: 'search' | 'write' | 'pin' | 'restore';
}

export interface SlidingWindowStats {
	windowSize: number;
	maxSize: number;
	totalTokenEstimate: number;
	pinnedCount: number;
	evictedCount: number;
	hitRate: number;
}

export interface SlidingWindowOptions {
	maxEntries: number;        // 最大条目数
	maxTokens: number;         // 最大 token 预算
	evictionPolicy: 'lru' | 'lfu' | 'fifo';  // 驱逐策略
	pinThreshold: number;      // 访问次数达到此值后固定
}

const DEFAULT_OPTIONS: SlidingWindowOptions = {
	maxEntries: 20,
	maxTokens: 2000,
	evictionPolicy: 'lru',
	pinThreshold: 3,
};

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export class SlidingWindow {
	private _options: SlidingWindowOptions;
	private _window: WindowEntry[] = [];
	private _idIndex = new Map<string, number>();  // id → 在 _window 中的索引
	private _evictedCount = 0;
	private _hitCount = 0;
	private _missCount = 0;

	constructor(options?: Partial<SlidingWindowOptions>) {
		this._options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * 添加/更新条目
	 * 如果已存在，更新 accessCount + lastAccessedAt
	 * 如果不存在，插入并可能在需要时驱逐
	 */
	access(entry: Omit<WindowEntry, 'accessCount' | 'pinned' | 'insertedAt' | 'lastAccessedAt' | 'tokenEstimate'> & { tokenEstimate?: number }): WindowEntry {
		const existingIdx = this._idIndex.get(entry.id);
		if (existingIdx !== undefined) {
			// 已在窗口中：更新
			const existing = this._window[existingIdx];
			existing.accessCount++;
			existing.lastAccessedAt = Date.now();
			existing.score = Math.max(existing.score, entry.score);
			if (existing.accessCount >= this._options.pinThreshold) {
				existing.pinned = true;
			}
			this._hitCount++;
			this._reorder();
			return existing;
		}

		// 新条目
		this._missCount++;
		const newEntry: WindowEntry = {
			...entry,
			accessCount: 1,
			pinned: false,
			insertedAt: Date.now(),
			lastAccessedAt: Date.now(),
			tokenEstimate: entry.tokenEstimate ?? estimateTokens(entry.content),
		};

		// 检查是否需要驱逐
		this._window.push(newEntry);
		this._idIndex.set(newEntry.id, this._window.length - 1);
		this._evictIfNeeded();

		return newEntry;
	}

	/**
	 * 手动固定一个条目
	 */
	pin(id: string): boolean {
		const idx = this._idIndex.get(id);
		if (idx === undefined) return false;
		this._window[idx].pinned = true;
		return true;
	}

	/**
	 * 解除固定
	 */
	unpin(id: string): boolean {
		const idx = this._idIndex.get(id);
		if (idx === undefined) return false;
		this._window[idx].pinned = false;
		return true;
	}

	/**
	 * 获取窗口中的所有条目（按 score 降序）
	 */
	getAll(): WindowEntry[] {
		return [...this._window].sort((a, b) => b.score - a.score);
	}

	/**
	 * 获取窗口中的前 N 个条目（按 token 预算截断）
	 */
	getTop(tokenBudget?: number): WindowEntry[] {
		const budget = tokenBudget ?? this._options.maxTokens;
		const sorted = this.getAll();
		const result: WindowEntry[] = [];
		let used = 0;
		for (const entry of sorted) {
			if (used + entry.tokenEstimate > budget) break;
			result.push(entry);
			used += entry.tokenEstimate;
		}
		return result;
	}

	/**
	 * 从窗口中移除指定条目
	 */
	remove(id: string): WindowEntry | null {
		const idx = this._idIndex.get(id);
		if (idx === undefined) return null;
		const removed = this._window.splice(idx, 1)[0];
		this._rebuildIndex();
		return removed;
	}

	/**
	 * 清除所有非固定条目
	 */
	clearNonPinned(): number {
		const before = this._window.length;
		this._window = this._window.filter(e => e.pinned);
		this._rebuildIndex();
		return before - this._window.length;
	}

	/**
	 * 驱逐策略
	 */
	private _evictIfNeeded(): void {
		while (this._needsEviction()) {
			const evicted = this._evictOne();
			if (!evicted) break;
		}
	}

	private _needsEviction(): boolean {
		if (this._window.length <= this._options.maxEntries) {
			const totalTokens = this._window.reduce((s, e) => s + e.tokenEstimate, 0);
			return totalTokens > this._options.maxTokens;
		}
		return true;
	}

	private _evictOne(): WindowEntry | null {
		// 只驱逐非固定的条目
		const evictableIndices: number[] = [];
		for (let i = 0; i < this._window.length; i++) {
			if (!this._window[i].pinned) {
				evictableIndices.push(i);
			}
		}
		if (evictableIndices.length === 0) return null;

		let targetIdx: number;
		switch (this._options.evictionPolicy) {
			case 'fifo': {
				// 先进先出：取 insertedAt 最早的
				targetIdx = evictableIndices.reduce((min, i) =>
					this._window[i].insertedAt < this._window[min].insertedAt ? i : min,
				);
				break;
			}
			case 'lfu': {
				// 最少使用：取 accessCount 最低的
				targetIdx = evictableIndices.reduce((min, i) =>
					this._window[i].accessCount < this._window[min].accessCount ? i : min,
				);
				break;
			}
			case 'lru':
			default: {
				// 最近最少访问：取 lastAccessedAt 最早的
				targetIdx = evictableIndices.reduce((min, i) =>
					this._window[i].lastAccessedAt < this._window[min].lastAccessedAt ? i : min,
				);
				break;
			}
		}

		const evicted = this._window.splice(targetIdx, 1)[0];
		this._evictedCount++;
		this._rebuildIndex();
		return evicted;
	}

	private _reorder(): void {
		// LRU：将最近访问的移到末尾（仅当策略是 lru 时）
		// 这里简化：不做物理重排，驱逐时按 lastAccessedAt 选择
	}

	private _rebuildIndex(): void {
		this._idIndex.clear();
		for (let i = 0; i < this._window.length; i++) {
			this._idIndex.set(this._window[i].id, i);
		}
	}

	/**
	 * 获取统计
	 */
	getStats(): SlidingWindowStats {
		const totalTokenEstimate = this._window.reduce((s, e) => s + e.tokenEstimate, 0);
		const total = this._hitCount + this._missCount;
		return {
			windowSize: this._window.length,
			maxSize: this._options.maxEntries,
			totalTokenEstimate,
			pinnedCount: this._window.filter(e => e.pinned).length,
			evictedCount: this._evictedCount,
			hitRate: total > 0 ? this._hitCount / total : 0,
		};
	}

	/**
	 * 更新配置
	 */
	updateOptions(options: Partial<SlidingWindowOptions>): void {
		this._options = { ...this._options, ...options };
		// 新的 maxEntries 可能更小，需要驱逐
		this._evictIfNeeded();
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._window = [];
		this._idIndex.clear();
		this._evictedCount = 0;
		this._hitCount = 0;
		this._missCount = 0;
	}
}
