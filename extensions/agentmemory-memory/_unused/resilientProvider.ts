/*---------------------------------------------------------------------------------------------
 *  弹性提供者 — 集成熔断器 + 重试 + 超时 + 降级链的弹性包装器。
 *  参考 agentmemory src/providers/resilient.ts
 *
 *  与现有 CircuitBreaker + FallbackChain 的区别：
 *    - 单独使用：需手动组合 CircuitBreaker + FallbackChain
 *    - ResilientProvider：一键包装，自动组合所有弹性策略
 *
 *  弹性策略链：
 *    请求 → 限流检查 → 熔断器检查 → 超时控制 → 执行 → 成功/失败
 *                                        ↓           ↓
 *                                    超时降级    重试 / 熔断 / 降级
 *--------------------------------------------------------------------------------------------*/

import { CircuitBreaker, type CircuitBreakerState } from './circuitBreaker.js';
import type { RateLimiter } from './rateLimiter.js';

export interface ResilientOptions {
	circuitBreaker?: {
		failureThreshold?: number;
		failureWindowMs?: number;
		recoveryTimeoutMs?: number;
	};
	retry?: {
		maxRetries: number;
		retryDelayMs: number;
		exponentialBackoff: boolean;
	};
	timeout?: {
		timeoutMs: number;
	};
	fallback?: () => unknown | Promise<unknown>;
	rateLimiter?: RateLimiter;
}

export interface ResilientResult<T> {
	success: boolean;
	result?: T;
	error?: string;
	retries: number;
	elapsedMs: number;
	fromFallback: boolean;
	circuitState: CircuitBreakerState;
}

const DEFAULT_OPTIONS: Required<Omit<ResilientOptions, 'fallback' | 'rateLimiter'>> = {
	circuitBreaker: {
		failureThreshold: 3,
		failureWindowMs: 60_000,
		recoveryTimeoutMs: 30_000,
	},
	retry: {
		maxRetries: 2,
		retryDelayMs: 500,
		exponentialBackoff: true,
	},
	timeout: {
		timeoutMs: 10_000,
	},
};

export class ResilientProvider {
	private _breaker: CircuitBreaker;
	private _options: Required<Omit<ResilientOptions, 'fallback' | 'rateLimiter'>>;
	private _fallback?: () => unknown | Promise<unknown>;
	private _rateLimiter?: RateLimiter;
	private _totalCalls = 0;
	private _successfulCalls = 0;
	private _failedCalls = 0;
	private _fallbackCalls = 0;
	private _timeoutCalls = 0;
	private _retriedCalls = 0;

	constructor(name: string, options?: ResilientOptions) {
		this._options = {
			...DEFAULT_OPTIONS,
			...options,
			circuitBreaker: { ...DEFAULT_OPTIONS.circuitBreaker, ...options?.circuitBreaker },
			retry: { ...DEFAULT_OPTIONS.retry, ...options?.retry },
			timeout: { ...DEFAULT_OPTIONS.timeout, ...options?.timeout },
		};
		this._breaker = new CircuitBreaker(this._options.circuitBreaker);
		this._fallback = options?.fallback;
		this._rateLimiter = options?.rateLimiter;
	}

	/**
	 * 执行受保护的操作
	 */
	async execute<T>(fn: () => Promise<T>): Promise<ResilientResult<T>> {
		const startTime = Date.now();
		this._totalCalls++;

		// 1. 限流检查
		if (this._rateLimiter) {
			const rateResult = this._rateLimiter.tryAcquire();
			if (!rateResult.allowed) {
				return {
					success: false,
					error: `Rate limited, retry after ${rateResult.retryAfterMs}ms`,
					retries: 0,
					elapsedMs: Date.now() - startTime,
					fromFallback: false,
					circuitState: this._breaker.getState(),
				};
			}
		}

		// 2. 熔断器检查
		if (!this._breaker.isAllowed) {
			if (this._fallback) {
				const fallbackResult = await this._fallback();
				this._fallbackCalls++;
				return {
					success: true,
					result: fallbackResult as T,
					retries: 0,
					elapsedMs: Date.now() - startTime,
					fromFallback: true,
					circuitState: this._breaker.getState(),
				};
			}
			return {
				success: false,
				error: 'Circuit breaker is open',
				retries: 0,
				elapsedMs: Date.now() - startTime,
				fromFallback: false,
				circuitState: this._breaker.getState(),
			};
		}

		// 3. 执行 + 超时 + 重试
		let lastError: Error | null = null;
		let retries = 0;

		for (let attempt = 0; attempt <= this._options.retry.maxRetries; attempt++) {
			try {
				const result = await this._executeWithTimeout<T>(fn);
				this._breaker.recordSuccess();
				this._successfulCalls++;
				return {
					success: true,
					result,
					retries,
					elapsedMs: Date.now() - startTime,
					fromFallback: false,
					circuitState: this._breaker.getState(),
				};
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				// 超时特殊处理
				if (lastError.message === 'TIMEOUT') {
					this._timeoutCalls++;
				}

				if (attempt < this._options.retry.maxRetries) {
					retries++;
					this._retriedCalls++;
					const delay = this._options.retry.exponentialBackoff
						? this._options.retry.retryDelayMs * Math.pow(2, attempt)
						: this._options.retry.retryDelayMs;
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			}
		}

		// 4. 所有重试失败
		this._breaker.recordFailure();
		this._failedCalls++;

		if (this._fallback) {
			const fallbackResult = await this._fallback();
			this._fallbackCalls++;
			return {
				success: true,
				result: fallbackResult as T,
				retries,
				elapsedMs: Date.now() - startTime,
				fromFallback: true,
				circuitState: this._breaker.getState(),
			};
		}

		return {
			success: false,
			error: lastError?.message ?? 'Unknown error',
			retries,
			elapsedMs: Date.now() - startTime,
			fromFallback: false,
			circuitState: this._breaker.getState(),
		};
	}

	/**
	 * 带超时执行
	 */
	private async _executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
		const timeoutMs = this._options.timeout.timeoutMs;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error('TIMEOUT'));
			}, timeoutMs);

			fn()
				.then(result => {
					clearTimeout(timer);
					resolve(result);
				})
				.catch(err => {
					clearTimeout(timer);
					reject(err);
				});
		});
	}

	/**
	 * 获取熔断器状态
	 */
	getCircuitState(): CircuitBreakerState {
		return this._breaker.getState();
	}

	/**
	 * 手动重置熔断器
	 */
	resetCircuit(): void {
		this._breaker.reset();
	}

	/**
	 * 获取统计
	 */
	getStats(): {
		totalCalls: number;
		successfulCalls: number;
		failedCalls: number;
		fallbackCalls: number;
		timeoutCalls: number;
		retriedCalls: number;
		successRate: number;
	} {
		return {
			totalCalls: this._totalCalls,
			successfulCalls: this._successfulCalls,
			failedCalls: this._failedCalls,
			fallbackCalls: this._fallbackCalls,
			timeoutCalls: this._timeoutCalls,
			retriedCalls: this._retriedCalls,
			successRate: this._totalCalls > 0 ? this._successfulCalls / this._totalCalls : 0,
		};
	}
}
