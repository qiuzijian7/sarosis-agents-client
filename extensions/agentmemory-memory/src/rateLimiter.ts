/*---------------------------------------------------------------------------------------------
 *  限流器 — 令牌桶算法，防止记忆写入洪泛。
 *  参考 agentmemory 中的防抖 + 批量写入机制
 *
 *  与现有写防抖（_schedulePersist）的区别：
 *    - 写防抖：5 秒窗口合并写入（减少磁盘 I/O）
 *    - RateLimiter：令牌桶限流（控制请求速率，防止内存爆炸）
 *
 *  核心场景：
 *    1. Agent 高频写入 → 限流到每秒 N 条
 *    2. 搜索请求 → 限流到每秒 M 次
 *    3. LLM 提取 → 限流到每分钟 K 次
 *
 *  令牌桶算法：
 *    - 桶容量 = burst（允许突发）
 *    - 补充速率 = tokens/second
 *    - 每次请求消耗 1 个令牌
 *    - 桶空时拒绝请求
 *--------------------------------------------------------------------------------------------*/

export interface RateLimitConfig {
	capacity: number;        // 桶容量（突发上限）
	refillRate: number;      // 每秒补充令牌数
	refillIntervalMs: number; // 补充间隔（默认 1000ms）
}

export interface RateLimitResult {
	allowed: boolean;
	remainingTokens: number;
	retryAfterMs: number;   // 如果拒绝，建议等待时间
}

const DEFAULT_CONFIG: RateLimitConfig = {
	capacity: 10,
	refillRate: 5,
	refillIntervalMs: 1000,
};

export class RateLimiter {
	private _tokens: number;
	private _config: RateLimitConfig;
	private _lastRefillTime: number;
	private _totalRequests: number = 0;
	private _rejectedRequests: number = 0;
	private _refillTimer: ReturnType<typeof setInterval> | undefined;

	constructor(config?: Partial<RateLimitConfig>) {
		this._config = { ...DEFAULT_CONFIG, ...config };
		this._tokens = this._config.capacity;
		this._lastRefillTime = Date.now();

		// 定时补充令牌
		this._refillTimer = setInterval(() => {
			this._refill();
		}, this._config.refillIntervalMs);
		if (this._refillTimer && typeof (this._refillTimer as any).unref === 'function') {
			(this._refillTimer as any).unref();
		}
	}

	/**
	 * 尝试获取一个令牌
	 */
	tryAcquire(tokens: number = 1): RateLimitResult {
		this._refill();
		this._totalRequests++;

		if (this._tokens >= tokens) {
			this._tokens -= tokens;
			return {
				allowed: true,
				remainingTokens: this._tokens,
				retryAfterMs: 0,
			};
		}

		this._rejectedRequests++;
		const needed = tokens - this._tokens;
		const retryAfterMs = Math.ceil((needed / this._config.refillRate) * 1000);
		return {
			allowed: false,
			remainingTokens: this._tokens,
			retryAfterMs,
		};
	}

	/**
	 * 等待并获取令牌
	 */
	async acquire(tokens: number = 1, maxWaitMs: number = 30000): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < maxWaitMs) {
			const result = this.tryAcquire(tokens);
			if (result.allowed) return true;
			if (result.retryAfterMs > 0) {
				await new Promise(resolve => setTimeout(resolve, Math.min(result.retryAfterMs, 1000)));
			}
		}
		return false;
	}

	/**
	 * 补充令牌
	 */
	private _refill(): void {
		const now = Date.now();
		const elapsed = (now - this._lastRefillTime) / 1000;
		const tokensToAdd = elapsed * this._config.refillRate;
		this._tokens = Math.min(this._config.capacity, this._tokens + tokensToAdd);
		this._lastRefillTime = now;
	}

	/**
	 * 获取当前令牌数
	 */
	getTokens(): number {
		this._refill();
		return Math.floor(this._tokens);
	}

	/**
	 * 更新配置
	 */
	updateConfig(config: Partial<RateLimitConfig>): void {
		this._config = { ...this._config, ...config };
		this._tokens = Math.min(this._tokens, this._config.capacity);
	}

	/**
	 * 获取配置
	 */
	getConfig(): RateLimitConfig {
		return { ...this._config };
	}

	/**
	 * 获取统计
	 */
	getStats(): {
		totalRequests: number;
		rejectedRequests: number;
		rejectionRate: number;
		currentTokens: number;
		capacity: number;
	} {
		return {
			totalRequests: this._totalRequests,
			rejectedRequests: this._rejectedRequests,
			rejectionRate: this._totalRequests > 0 ? this._rejectedRequests / this._totalRequests : 0,
			currentTokens: this.getTokens(),
			capacity: this._config.capacity,
		};
	}

	/**
	 * 重置
	 */
	reset(): void {
		this._tokens = this._config.capacity;
		this._lastRefillTime = Date.now();
		this._totalRequests = 0;
		this._rejectedRequests = 0;
	}

	dispose(): void {
		if (this._refillTimer) {
			clearInterval(this._refillTimer);
			this._refillTimer = undefined;
		}
	}
}

/**
 * 多限流器管理器（按操作类型隔离）
 */
export class RateLimiterRegistry {
	private _limiters = new Map<string, RateLimiter>();

	/**
	 * 获取或创建限流器
	 */
	get(name: string, config?: Partial<RateLimitConfig>): RateLimiter {
		let limiter = this._limiters.get(name);
		if (!limiter) {
			limiter = new RateLimiter(config);
			this._limiters.set(name, limiter);
		}
		return limiter;
	}

	/**
	 * 尝试获取令牌
	 */
	tryAcquire(name: string, tokens?: number): RateLimitResult {
		return this.get(name).tryAcquire(tokens);
	}

	/**
	 * 获取所有限流器统计
	 */
	getAllStats(): Record<string, ReturnType<RateLimiter['getStats']>> {
		const result: Record<string, ReturnType<RateLimiter['getStats']>> = {};
		for (const [name, limiter] of this._limiters) {
			result[name] = limiter.getStats();
		}
		return result;
	}

	dispose(): void {
		for (const limiter of this._limiters.values()) {
			limiter.dispose();
		}
		this._limiters.clear();
	}
}
