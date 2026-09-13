/*---------------------------------------------------------------------------------------------
 *  健康阈值 — 系统健康指标的可配置阈值。
 *  1:1 复刻 agentmemory src/health/thresholds.ts
 *
 *  定义每个健康指标的正常/警告/危险阈值。
 *--------------------------------------------------------------------------------------------*/

export type HealthDimension =
	| 'memoryCount'
	| 'indexSize'
	| 'diskUsage'
	| 'searchLatency'
	| 'writeLatency'
	| 'errorRate'
	| 'circuitOpenCount'
	| 'quotaViolationCount'
	| 'staleSessionCount'
	| 'orphanedImageCount'
	| 'queueDepth'
	| 'activeAlertCount';

export interface ThresholdConfig {
	warn: number;
	critical: number;
	// lowerIsBad=true: 实际值 > 阈值 = 危险
	// lowerIsBad=false: 实际值 < 阈值 = 危险（如 searchLatency）
	lowerIsBad: boolean;
}

export type HealthLevel = 'healthy' | 'warn' | 'critical';

const DEFAULT_THRESHOLDS: Record<HealthDimension, ThresholdConfig> = {
	memoryCount: { warn: 4000, critical: 5000, lowerIsBad: true },
	indexSize: { warn: 50 * 1024 * 1024, critical: 100 * 1024 * 1024, lowerIsBad: true },
	diskUsage: { warn: 0.7, critical: 0.9, lowerIsBad: true },
	searchLatency: { warn: 100, critical: 500, lowerIsBad: true },
	writeLatency: { warn: 50, critical: 200, lowerIsBad: true },
	errorRate: { warn: 0.05, critical: 0.15, lowerIsBad: true },
	circuitOpenCount: { warn: 1, critical: 3, lowerIsBad: true },
	quotaViolationCount: { warn: 1, critical: 5, lowerIsBad: true },
	staleSessionCount: { warn: 5, critical: 20, lowerIsBad: true },
	orphanedImageCount: { warn: 10, critical: 50, lowerIsBad: true },
	queueDepth: { warn: 100, critical: 500, lowerIsBad: true },
	activeAlertCount: { warn: 3, critical: 10, lowerIsBad: true },
};

export class HealthThresholds {
	private _thresholds: Record<HealthDimension, ThresholdConfig>;

	constructor(config?: Partial<Record<HealthDimension, Partial<ThresholdConfig>>>) {
		this._thresholds = { ...DEFAULT_THRESHOLDS };
		if (config) {
			for (const [key, override] of Object.entries(config)) {
				const dim = key as HealthDimension;
				if (this._thresholds[dim]) {
					this._thresholds[dim] = { ...this._thresholds[dim], ...override };
				}
			}
		}
	}

	/**
	 * 评估指标
	 */
	evaluate(dimension: HealthDimension, value: number): HealthLevel {
		const config = this._thresholds[dimension];
		if (!config) return 'healthy';

		if (config.lowerIsBad) {
			if (value >= config.critical) return 'critical';
			if (value >= config.warn) return 'warn';
			return 'healthy';
		} else {
			if (value <= config.critical) return 'critical';
			if (value <= config.warn) return 'warn';
			return 'healthy';
		}
	}

	/**
	 * 批量评估
	 */
	evaluateAll(metrics: Partial<Record<HealthDimension, number>>): Array<{ dimension: HealthDimension; value: number; level: HealthLevel }> {
		const results: Array<{ dimension: HealthDimension; value: number; level: HealthLevel }> = [];
		for (const [dim, value] of Object.entries(metrics)) {
			if (typeof value === 'number') {
				results.push({
					dimension: dim as HealthDimension,
					value,
					level: this.evaluate(dim as HealthDimension, value),
				});
			}
		}
		return results;
	}

	/**
	 * 获取阈值配置
	 */
	getThreshold(dimension: HealthDimension): ThresholdConfig {
		return { ...this._thresholds[dimension] };
	}

	/**
	 * 更新阈值
	 */
	setThreshold(dimension: HealthDimension, config: Partial<ThresholdConfig>): void {
		if (this._thresholds[dimension]) {
			this._thresholds[dimension] = { ...this._thresholds[dimension], ...config };
		}
	}

	/**
	 * 获取所有阈值
	 */
	getAllThresholds(): Record<HealthDimension, ThresholdConfig> {
		return { ...this._thresholds };
	}

	/**
	 * 获取总体健康级别
	 */
	getOverallLevel(results: Array<{ level: HealthLevel }>): HealthLevel {
		if (results.some(r => r.level === 'critical')) return 'critical';
		if (results.some(r => r.level === 'warn')) return 'warn';
		return 'healthy';
	}
}
