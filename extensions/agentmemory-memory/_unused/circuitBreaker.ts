/*---------------------------------------------------------------------------------------------
 *  熔断器 — 保护外部调用（embedding 服务器、文件服务器）免受级联故障。
 *  参考 agentmemory src/providers/circuit-breaker.ts
 *
 *  三种状态：
 *    closed    — 正常运行，记录失败
 *    open      — 熔断，拒绝所有调用，等待恢复超时
 *    half-open — 恢复探测，允许单次调用测试
 *
 *  核心场景：
 *    1. @xenova/transformers WASM 加载失败 → 熔断，降级到 trigram
 *    2. 文件服务器不可用 → 熔断，降级到内存模式
 *    3. 搜索超时 → 熔断，降级到 BM25-only
 *--------------------------------------------------------------------------------------------*/

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
	failureThreshold?: number;     // 触发熔断的失败次数（默认 3）
	failureWindowMs?: number;      // 失败计数窗口（默认 60s）
	recoveryTimeoutMs?: number;    // 熔断后恢复探测超时（默认 30s）
	halfOpenSuccessThreshold?: number;  // half-open 成功次数恢复 closed（默认 1）
}

export interface CircuitBreakerState {
	state: CircuitState;
	failures: number;
	successes: number;
	lastFailureAt: number | null;
	openedAt: number | null;
	totalTrips: number;  // 累计熔断次数
}

export class CircuitBreaker {
	private _state: CircuitState = 'closed';
	private _failures = 0;
	private _successes = 0;
	private _lastFailureAt: number | null = null;
	private _openedAt: number | null = null;
	private _totalTrips = 0;

	private readonly _failureThreshold: number;
	private readonly _failureWindowMs: number;
	private readonly _recoveryTimeoutMs: number;
	private readonly _halfOpenSuccessThreshold: number;

	constructor(opts?: CircuitBreakerOptions) {
		this._failureThreshold = Math.max(1, opts?.failureThreshold ?? 3);
		this._failureWindowMs = opts?.failureWindowMs ?? 60_000;
		this._recoveryTimeoutMs = opts?.recoveryTimeoutMs ?? 30_000;
		this._halfOpenSuccessThreshold = Math.max(1, opts?.halfOpenSuccessThreshold ?? 1);
	}

	/** 是否允许调用 */
	get isAllowed(): boolean {
		switch (this._state) {
			case 'closed':
				return true;
			case 'open':
				if (this._openedAt && Date.now() - this._openedAt >= this._recoveryTimeoutMs) {
					this._state = 'half-open';
					this._successes = 0;
					return true;
				}
				return false;
			case 'half-open':
				return true;
		}
	}

	/** 记录成功 */
	recordSuccess(): void {
		if (this._state === 'half-open') {
			this._successes++;
			if (this._successes >= this._halfOpenSuccessThreshold) {
				this._state = 'closed';
				this._failures = 0;
				this._successes = 0;
				this._lastFailureAt = null;
				this._openedAt = null;
			}
		}
	}

	/** 记录失败 */
	recordFailure(): void {
		const now = Date.now();

		if (this._state === 'half-open') {
			// half-open 失败 → 重新熔断
			this._state = 'open';
			this._openedAt = now;
			this._totalTrips++;
			return;
		}

		// 窗口外重置
		if (this._lastFailureAt && now - this._lastFailureAt > this._failureWindowMs) {
			this._failures = 0;
		}

		this._failures++;
		this._lastFailureAt = now;

		if (this._failures >= this._failureThreshold) {
			this._state = 'open';
			this._openedAt = now;
			this._totalTrips++;
		}
	}

	/** 执行受保护的调用 */
	async execute<T>(fn: () => Promise<T>, fallback?: () => T | Promise<T>): Promise<T> {
		if (!this.isAllowed) {
			if (fallback) return fallback();
			throw new Error(`Circuit breaker is ${this._state}`);
		}
		try {
			const result = await fn();
			this.recordSuccess();
			return result;
		} catch (err) {
			this.recordFailure();
			if (fallback) return fallback();
			throw err;
		}
	}

	/** 手动重置 */
	reset(): void {
		this._state = 'closed';
		this._failures = 0;
		this._successes = 0;
		this._lastFailureAt = null;
		this._openedAt = null;
	}

	/** 获取状态 */
	getState(): CircuitBreakerState {
		return {
			state: this._state,
			failures: this._failures,
			successes: this._successes,
			lastFailureAt: this._lastFailureAt,
			openedAt: this._openedAt,
			totalTrips: this._totalTrips,
		};
	}
}

/**
 * 多熔断器管理器（按服务名隔离）
 */
export class CircuitBreakerRegistry {
	private _breakers = new Map<string, CircuitBreaker>();

	/** 获取或创建熔断器 */
	get(name: string, opts?: CircuitBreakerOptions): CircuitBreaker {
		let breaker = this._breakers.get(name);
		if (!breaker) {
			breaker = new CircuitBreaker(opts);
			this._breakers.set(name, breaker);
		}
		return breaker;
	}

	/** 检查服务是否可用 */
	isAllowed(name: string): boolean {
		return this._breakers.get(name)?.isAllowed ?? true;
	}

	/** 获取所有熔断器状态 */
	getAllStates(): Record<string, CircuitBreakerState> {
		const result: Record<string, CircuitBreakerState> = {};
		for (const [name, breaker] of this._breakers) {
			result[name] = breaker.getState();
		}
		return result;
	}

	/** 重置所有熔断器 */
	resetAll(): void {
		for (const breaker of this._breakers.values()) {
			breaker.reset();
		}
	}

	clear(): void {
		this._breakers.clear();
	}
}
