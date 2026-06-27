/*---------------------------------------------------------------------------------------------
 *  性能指标 — 记录和分析操作延迟、吞吐量、错误率。
 *  参考 agentmemory src/telemetry/ 目录
 *
 *  核心能力：
 *    1. recordLatency(operation, ms) — 记录操作延迟
 *    2. recordCount(operation, count) — 记录操作计数
 *    3. recordError(operation, error) — 记录错误
 *    4. getLatencyStats(operation) — 获取延迟统计（p50/p90/p99/avg）
 *    5. getThroughput(operation) — 获取吞吐量（ops/sec）
 *    6. getErrorRate(operation) — 获取错误率
 *
 *  指标类型：
 *    latency  — 延迟（毫秒）
 *    counter  — 计数器
 *    gauge    — 仪表值（当前值）
 *    histogram — 直方图（延迟分布）
 *--------------------------------------------------------------------------------------------*/

export interface LatencyStats {
	count: number;
	min: number;
	max: number;
	avg: number;
	p50: number;
	p90: number;
	p99: number;
	totalMs: number;
}

export interface OperationStats {
	count: number;
	errors: number;
	errorRate: number;
	latency: LatencyStats;
	throughputPerSec: number;
	lastOperationAt: number;
}

export interface MetricsSummary {
	operations: Record<string, OperationStats>;
	totalOperations: number;
	totalErrors: number;
	overallErrorRate: number;
	uptime: number;
}

const MAX_LATENCY_SAMPLES = 1000;

export class MetricsCollector {
	private _latencies = new Map<string, number[]>();
	private _counts = new Map<string, number>();
	private _errors = new Map<string, number>();
	private _lastOperationAt = new Map<string, number>();
	private _gauges = new Map<string, number>();
	private _startTime: number;
	private _windowStart = new Map<string, number>();  // 吞吐量窗口起始
	private _windowCount = new Map<string, number>();

	constructor() {
		this._startTime = Date.now();
	}

	/**
	 * 记录延迟
	 */
	recordLatency(operation: string, ms: number): void {
		let samples = this._latencies.get(operation);
		if (!samples) {
			samples = [];
			this._latencies.set(operation, samples);
		}
		samples.push(ms);
		if (samples.length > MAX_LATENCY_SAMPLES) {
			samples.shift();
		}
		this._lastOperationAt.set(operation, Date.now());
		this._incrementCount(operation);
	}

	/**
	 * 测量异步操作的延迟
	 */
	async measure<T>(operation: string, fn: () => Promise<T>): Promise<T> {
		const start = Date.now();
		try {
			const result = await fn();
			this.recordLatency(operation, Date.now() - start);
			return result;
		} catch (err) {
			this.recordError(operation, err instanceof Error ? err.message : String(err));
			throw err;
		}
	}

	/**
	 * 测量同步操作的延迟
	 */
	measureSync<T>(operation: string, fn: () => T): T {
		const start = Date.now();
		try {
			const result = fn();
			this.recordLatency(operation, Date.now() - start);
			return result;
		} catch (err) {
			this.recordError(operation, err instanceof Error ? err.message : String(err));
			throw err;
		}
	}

	/**
	 * 记录计数
	 */
	recordCount(operation: string, count: number = 1): void {
		this._incrementCount(operation);
		this._lastOperationAt.set(operation, Date.now());
	}

	/**
	 * 记录错误
	 */
	recordError(operation: string, errorMessage: string): void {
		this._errors.set(operation, (this._errors.get(operation) ?? 0) + 1);
		this._lastOperationAt.set(operation, Date.now());
	}

	/**
	 * 设置仪表值
	 */
	setGauge(name: string, value: number): void {
		this._gauges.set(name, value);
	}

	/**
	 * 获取仪表值
	 */
	getGauge(name: string): number | null {
		return this._gauges.get(name) ?? null;
	}

	/**
	 * 获取延迟统计
	 */
	getLatencyStats(operation: string): LatencyStats | null {
		const samples = this._latencies.get(operation);
		if (!samples || samples.length === 0) return null;

		const sorted = [...samples].sort((a, b) => a - b);
		const sum = sorted.reduce((s, v) => s + v, 0);

		return {
			count: sorted.length,
			min: sorted[0],
			max: sorted[sorted.length - 1],
			avg: sum / sorted.length,
			p50: this._percentile(sorted, 0.5),
			p90: this._percentile(sorted, 0.9),
			p99: this._percentile(sorted, 0.99),
			totalMs: sum,
		};
	}

	/**
	 * 获取操作统计
	 */
	getOperationStats(operation: string): OperationStats | null {
		const latency = this.getLatencyStats(operation);
		const count = this._counts.get(operation) ?? 0;
		const errors = this._errors.get(operation) ?? 0;
		if (count === 0 && errors === 0) return null;

		// 计算吞吐量（基于最近窗口）
		const windowStart = this._windowStart.get(operation) ?? this._startTime;
		const windowCount = this._windowCount.get(operation) ?? count;
		const windowDuration = (Date.now() - windowStart) / 1000;
		const throughputPerSec = windowDuration > 0 ? windowCount / windowDuration : 0;

		return {
			count,
			errors,
			errorRate: count > 0 ? errors / count : 0,
			latency: latency ?? {
				count: 0, min: 0, max: 0, avg: 0,
				p50: 0, p90: 0, p99: 0, totalMs: 0,
			},
			throughputPerSec: Math.round(throughputPerSec * 100) / 100,
			lastOperationAt: this._lastOperationAt.get(operation) ?? 0,
		};
	}

	/**
	 * 获取所有指标摘要
	 */
	getSummary(): MetricsSummary {
		const operations: Record<string, OperationStats> = {};
		const allOps = new Set<string>([
			...this._counts.keys(),
			...this._errors.keys(),
			...this._latencies.keys(),
		]);

		let totalOperations = 0;
		let totalErrors = 0;

		for (const op of allOps) {
			const stats = this.getOperationStats(op);
			if (stats) {
				operations[op] = stats;
				totalOperations += stats.count;
				totalErrors += stats.errors;
			}
		}

		return {
			operations,
			totalOperations,
			totalErrors,
			overallErrorRate: totalOperations > 0 ? totalErrors / totalOperations : 0,
			uptime: Date.now() - this._startTime,
		};
	}

	/**
	 * 重置吞吐量窗口
	 */
	resetThroughputWindow(operation?: string): void {
		if (operation) {
			this._windowStart.set(operation, Date.now());
			this._windowCount.set(operation, 0);
		} else {
			for (const op of this._counts.keys()) {
				this._windowStart.set(op, Date.now());
				this._windowCount.set(op, 0);
			}
		}
	}

	/**
	 * 清除所有指标
	 */
	clear(): void {
		this._latencies.clear();
		this._counts.clear();
		this._errors.clear();
		this._lastOperationAt.clear();
		this._gauges.clear();
		this._windowStart.clear();
		this._windowCount.clear();
		this._startTime = Date.now();
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	private _incrementCount(operation: string): void {
		this._counts.set(operation, (this._counts.get(operation) ?? 0) + 1);
		this._windowCount.set(operation, (this._windowCount.get(operation) ?? 0) + 1);
		if (!this._windowStart.has(operation)) {
			this._windowStart.set(operation, Date.now());
		}
	}

	private _percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		const idx = Math.ceil(p * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
	}
}
