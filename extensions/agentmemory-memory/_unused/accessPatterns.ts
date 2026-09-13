/*---------------------------------------------------------------------------------------------
 *  访问模式分析 — 分析记忆访问的时间模式。
 *  参考 agentmemory src/functions/access-tracker.ts（模式分析扩展）
 *
 *  核心能力：
 *    1. detectBursts(memoryId) — 检测突发访问（短时间内大量访问）
 *    2. detectPeriodicity(memoryId) — 检测周期性访问模式
 *    3. getAccessFrequency(memoryId, windowMs) — 获取访问频率
 *    4. getHotMemories(agentId) — 获取热点记忆（访问频率最高）
 *    5. getColdMemories(agentId) — 获取冷门记忆（长时间无访问）
 *    6. getAccessHeatmap(agentId) — 获取访问热力图（按小时/天统计）
 *
 *  模式类型：
 *    burst    — 突发（短时间内 ≥5 次访问）
 *    periodic — 周期性（固定间隔重复访问）
 *    trending — 上升趋势（访问频率递增）
 *    declining — 下降趋势（访问频率递减）
 *    stable   — 稳定（频率基本不变）
 *    dormant  — 休眠（长时间无访问）
 *--------------------------------------------------------------------------------------------*/

export interface AccessPattern {
	memoryId: string;
	pattern: 'burst' | 'periodic' | 'trending' | 'declining' | 'stable' | 'dormant';
	confidence: number;
	details: {
		totalAccesses: number;
		avgIntervalMs: number;
		burstCount: number;
		lastAccessAt: number;
		firstAccessAt: number;
		accessFrequency: number;  // accesses per day
	};
}

export interface BurstDetection {
	memoryId: string;
	bursts: Array<{
		startTime: number;
		endTime: number;
		count: number;
		durationMs: number;
	}>;
}

export interface AccessHeatmap {
	hourly: number[];      // 24 个值，每小时访问次数
	daily: number[];       // 7 个值，每天访问次数
	weekday: number;       // 0-6 (0=Sunday)
}

const BURST_THRESHOLD = 5;              // 突发：短时间内 ≥5 次访问
const BURST_WINDOW_MS = 5 * 60 * 1000;  // 突发窗口：5 分钟
const DORMANT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;  // 7 天无访问 = 休眠
const MIN_INTERVALS_FOR_PERIODICITY = 3;

export class AccessPatternAnalyzer {
	/**
	 * 分析访问模式
	 */
	analyze(memoryId: string, accessTimestamps: number[]): AccessPattern {
		const sorted = [...accessTimestamps].sort((a, b) => a - b);
		const totalAccesses = sorted.length;
		const lastAccessAt = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
		const firstAccessAt = sorted.length > 0 ? sorted[0] : 0;

		if (totalAccesses === 0) {
			return {
				memoryId,
				pattern: 'dormant',
				confidence: 1,
				details: {
					totalAccesses: 0,
					avgIntervalMs: 0,
					burstCount: 0,
					lastAccessAt: 0,
					firstAccessAt: 0,
					accessFrequency: 0,
				},
			};
		}

		// 检测休眠
		const now = Date.now();
		if (now - lastAccessAt > DORMANT_THRESHOLD_MS) {
			return {
				memoryId,
				pattern: 'dormant',
				confidence: 0.9,
				details: {
					totalAccesses,
					avgIntervalMs: totalAccesses > 1 ? (lastAccessAt - firstAccessAt) / (totalAccesses - 1) : 0,
					burstCount: 0,
					lastAccessAt,
					firstAccessAt,
					accessFrequency: this._computeFrequency(sorted, firstAccessAt, lastAccessAt),
				},
			};
		}

		// 计算间隔
		const intervals: number[] = [];
		for (let i = 1; i < sorted.length; i++) {
			intervals.push(sorted[i] - sorted[i - 1]);
		}
		const avgIntervalMs = intervals.length > 0
			? intervals.reduce((s, v) => s + v, 0) / intervals.length
			: 0;

		// 检测突发
		const burstCount = this._countBursts(sorted);

		// 检测周期性
		const periodicity = this._detectPeriodicity(intervals);

		// 检测趋势
		const trend = this._detectTrend(sorted);

		// 确定模式
		let pattern: AccessPattern['pattern'];
		let confidence: number;

		if (burstCount > 0 && burstCount >= totalAccesses * 0.3) {
			pattern = 'burst';
			confidence = Math.min(1, burstCount / 5);
		} else if (periodicity.isPeriodic && periodicity.confidence > 0.6) {
			pattern = 'periodic';
			confidence = periodicity.confidence;
		} else if (trend.direction === 'up' && trend.confidence > 0.5) {
			pattern = 'trending';
			confidence = trend.confidence;
		} else if (trend.direction === 'down' && trend.confidence > 0.5) {
			pattern = 'declining';
			confidence = trend.confidence;
		} else {
			pattern = 'stable';
			confidence = 0.5;
		}

		return {
			memoryId,
			pattern,
			confidence,
			details: {
				totalAccesses,
				avgIntervalMs,
				burstCount,
				lastAccessAt,
				firstAccessAt,
				accessFrequency: this._computeFrequency(sorted, firstAccessAt, lastAccessAt),
			},
		};
	}

	/**
	 * 检测突发访问
	 */
	detectBursts(memoryId: string, accessTimestamps: number[]): BurstDetection {
		const sorted = [...accessTimestamps].sort((a, b) => a - b);
		const bursts: Array<{ startTime: number; endTime: number; count: number; durationMs: number }> = [];

		let burstStart = -1;
		let burstCount = 0;

		for (let i = 0; i < sorted.length; i++) {
			if (burstStart < 0) {
				burstStart = sorted[i];
				burstCount = 1;
			} else {
				const interval = sorted[i] - sorted[i - 1];
				if (interval <= BURST_WINDOW_MS) {
					burstCount++;
				} else {
					// Burst ended
					if (burstCount >= BURST_THRESHOLD) {
						bursts.push({
							startTime: burstStart,
							endTime: sorted[i - 1],
							count: burstCount,
							durationMs: sorted[i - 1] - burstStart,
						});
					}
					burstStart = sorted[i];
					burstCount = 1;
				}
			}
		}

		// Check last burst
		if (burstCount >= BURST_THRESHOLD) {
			bursts.push({
				startTime: burstStart,
				endTime: sorted[sorted.length - 1],
				count: burstCount,
				durationMs: sorted[sorted.length - 1] - burstStart,
			});
		}

		return { memoryId, bursts };
	}

	/**
	 * 获取热点记忆（访问频率最高）
	 */
	getHotMemories(accessLogs: Array<{ memoryId: string; recent: number[] }>, limit: number = 10): Array<{ memoryId: string; frequency: number; pattern: string }> {
		const results: Array<{ memoryId: string; frequency: number; pattern: string }> = [];

		for (const log of accessLogs) {
			if (log.recent.length === 0) continue;
			const pattern = this.analyze(log.memoryId, log.recent);
			results.push({
				memoryId: log.memoryId,
				frequency: pattern.details.accessFrequency,
				pattern: pattern.pattern,
			});
		}

		return results
			.sort((a, b) => b.frequency - a.frequency)
			.slice(0, limit);
	}

	/**
	 * 获取冷门记忆（长时间无访问）
	 */
	getColdMemories(accessLogs: Array<{ memoryId: string; recent: number[] }>, limit: number = 10): Array<{ memoryId: string; lastAccessAt: number; dormantDays: number }> {
		const now = Date.now();
		const results: Array<{ memoryId: string; lastAccessAt: number; dormantDays: number }> = [];

		for (const log of accessLogs) {
			if (log.recent.length === 0) {
				results.push({ memoryId: log.memoryId, lastAccessAt: 0, dormantDays: Infinity });
				continue;
			}
			const lastAccess = log.recent[log.recent.length - 1];
			const dormantMs = now - lastAccess;
			if (dormantMs > DORMANT_THRESHOLD_MS) {
				results.push({
					memoryId: log.memoryId,
					lastAccessAt: lastAccess,
					dormantDays: Math.floor(dormantMs / (24 * 60 * 60 * 1000)),
				});
			}
		}

		return results
			.sort((a, b) => b.dormantDays - a.dormantDays)
			.slice(0, limit);
	}

	/**
	 * 生成访问热力图
	 */
	getAccessHeatmap(accessTimestamps: number[]): AccessHeatmap {
		const hourly = new Array(24).fill(0);
		const daily = new Array(7).fill(0);

		for (const ts of accessTimestamps) {
			const date = new Date(ts);
			hourly[date.getHours()]++;
			daily[date.getDay()]++;
		}

		// 找出最活跃的星期几
		let maxDay = 0;
		for (let i = 1; i < 7; i++) {
			if (daily[i] > daily[maxDay]) maxDay = i;
		}

		return { hourly, daily, weekday: maxDay };
	}

	/**
	 * 获取统计
	 */
	getStats(accessLogs: Array<{ memoryId: string; recent: number[] }>): {
		totalAnalyzed: number;
		byPattern: Record<string, number>;
		avgFrequency: number;
		hotCount: number;
		dormantCount: number;
	} {
		const byPattern: Record<string, number> = {};
		let totalFrequency = 0;
		let hotCount = 0;
		let dormantCount = 0;

		for (const log of accessLogs) {
			const pattern = this.analyze(log.memoryId, log.recent);
			byPattern[pattern.pattern] = (byPattern[pattern.pattern] ?? 0) + 1;
			totalFrequency += pattern.details.accessFrequency;
			if (pattern.pattern === 'burst' || pattern.pattern === 'trending') hotCount++;
			if (pattern.pattern === 'dormant') dormantCount++;
		}

		return {
			totalAnalyzed: accessLogs.length,
			byPattern,
			avgFrequency: accessLogs.length > 0 ? totalFrequency / accessLogs.length : 0,
			hotCount,
			dormantCount,
		};
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	private _computeFrequency(timestamps: number[], firstAt: number, lastAt: number): number {
		const durationDays = (lastAt - firstAt) / (1000 * 60 * 60 * 24);
		if (durationDays <= 0) return timestamps.length;
		return timestamps.length / durationDays;
	}

	private _countBursts(sorted: number[]): number {
		let burstCount = 0;
		let inBurst = false;
		let consecutive = 0;

		for (let i = 1; i < sorted.length; i++) {
			const interval = sorted[i] - sorted[i - 1];
			if (interval <= BURST_WINDOW_MS) {
				consecutive++;
				if (consecutive >= BURST_THRESHOLD - 1 && !inBurst) {
					burstCount++;
					inBurst = true;
				}
			} else {
				consecutive = 0;
				inBurst = false;
			}
		}

		return burstCount;
	}

	private _detectPeriodicity(intervals: number[]): { isPeriodic: boolean; confidence: number; periodMs?: number } {
		if (intervals.length < MIN_INTERVALS_FOR_PERIODICITY) {
			return { isPeriodic: false, confidence: 0 };
		}

		// 计算间隔的变异系数（CV = std/mean）
		const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
		const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
		const std = Math.sqrt(variance);
		const cv = mean > 0 ? std / mean : 1;

		// CV < 0.3 表示间隔稳定（周期性）
		if (cv < 0.3) {
			return { isPeriodic: true, confidence: 1 - cv, periodMs: mean };
		}

		return { isPeriodic: false, confidence: 1 - cv };
	}

	private _detectTrend(sorted: number[]): { direction: 'up' | 'down' | 'stable'; confidence: number } {
		if (sorted.length < 4) {
			return { direction: 'stable', confidence: 0 };
		}

		// 将时间戳分成前后两半，比较访问频率
		const mid = Math.floor(sorted.length / 2);
		const firstHalf = sorted.slice(0, mid);
		const secondHalf = sorted.slice(mid);

		const firstDuration = (firstHalf[firstHalf.length - 1] - firstHalf[0]) || 1;
		const secondDuration = (secondHalf[secondHalf.length - 1] - secondHalf[0]) || 1;

		const firstFreq = firstHalf.length / firstDuration;
		const secondFreq = secondHalf.length / secondDuration;

		if (secondFreq > firstFreq * 1.5) {
			return { direction: 'up', confidence: Math.min(1, (secondFreq / firstFreq - 1) / 2) };
		} else if (secondFreq < firstFreq * 0.5) {
			return { direction: 'down', confidence: Math.min(1, (1 - secondFreq / firstFreq) / 2) };
		}

		return { direction: 'stable', confidence: 0.3 };
	}
}
