/*---------------------------------------------------------------------------------------------
 *  Q1: 保留评分测试 — importance×recency×access 三因子 decay
 *  对齐 agentmemory retention 评分模型
 *--------------------------------------------------------------------------------------------*/
import { describe, it, assert, assertApprox } from './testRunner.js';

// --- 被测函数：三因子保留评分 ---

/** 时间衰减因子：越近越高，90天后趋近0 */
function recencyFactor(timestamp: number, now: number): number {
	const days = (now - timestamp) / (1000 * 60 * 60 * 24);
	return 1 / (1 + days * 0.05); // 90天 → ~0.18
}

/** 访问频率因子：log2 平滑 */
function accessFactor(accessCount: number): number {
	return 1 + Math.log2(accessCount + 1) * 0.1;
}

/**
 * 三因子保留评分（对齐 agentmemory retension.ts）
 * retentionScore = (importance / 10) * recencyFactor * accessFactor * 0.1
 * 范围: 0.0 ~ 1.0+
 */
function computeRetentionScore(
	importance: number,
	timestamp: number,
	accessCount: number,
	now: number = Date.now(),
): number {
	return (importance / 10) * recencyFactor(timestamp, now) * accessFactor(accessCount) * 0.1;
}

/** 保留阈值：低于此值的条目降级 */
const RETENTION_FLOOR = 0.01;

export function runRetentionScoringTests(): void {
	describe('Retention Scoring (Q1)', () => {
		it('high importance + recent + often accessed = high score', () => {
			const score = computeRetentionScore(10, Date.now(), 100);
			assert(score > 0.05, `score ${score} should be high`);
		});

		it('low importance + old + never accessed = low score', () => {
			const old = Date.now() - 180 * 24 * 60 * 60 * 1000; // 180 days
			const score = computeRetentionScore(1, old, 0);
			assert(score < RETENTION_FLOOR, `score ${score} should be below floor`);
		});

		it('high access count boosts old memories', () => {
			const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
			const lowAccess = computeRetentionScore(5, old, 0);
			const highAccess = computeRetentionScore(5, old, 50);
			assert(highAccess > lowAccess * 1.3, 'access count should boost score significantly');
		});

		it('recency decays over time', () => {
			const today = Date.now();
			const weekAgo = today - 7 * 24 * 60 * 60 * 1000;
			const monthAgo = today - 30 * 24 * 60 * 60 * 1000;

			const recent = computeRetentionScore(5, today, 0);
			const week = computeRetentionScore(5, weekAgo, 0);
			const month = computeRetentionScore(5, monthAgo, 0);

			assert(recent > week, 'recent > week');
			assert(week > month, 'week > month');
		});

		it('importance dominates when recency equal', () => {
			const ts = Date.now() - 7 * 24 * 60 * 60 * 1000;
			const high = computeRetentionScore(10, ts, 0);
			const low = computeRetentionScore(1, ts, 0);
			assert(high > low * 3, `importance should dominate: ${high} vs ${low}`);
		});

		it('retention floor filters out stale entries', () => {
			const veryOld = Date.now() - 365 * 24 * 60 * 60 * 1000;
			const score = computeRetentionScore(1, veryOld, 0);
			assert(score < RETENTION_FLOOR, `stale entry ${score} should be below floor`);
		});

		it('score is always non-negative', () => {
			const score = computeRetentionScore(0, Date.now(), 0);
			assert(score >= 0, 'score should be non-negative');
		});
	});
}
