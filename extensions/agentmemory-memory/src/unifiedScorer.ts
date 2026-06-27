/*---------------------------------------------------------------------------------------------
 *  统一评分 — 融合所有信号的记忆评分系统。
 *
 *  解决问题：现有多种评分信号（strength、retention、accessPattern、importance），
 *  各自独立计算，缺乏统一融合。UnifiedScorer 将所有信号融合为一个 0-1 分数。
 *
 *  评分信号：
 *    strength         — Ebbinghaus 衰减后的强度（0-1）
 *    retentionScore   — Lambda 衰减 + 强化提升的保留评分（0-1）
 *    accessFrequency  — 访问频率归一化（0-1）
 *    recency          — 时间新近度（0-1）
 *    importance       — 用户/系统指定的重要性（1-10 → 0-1）
 *    confidence       — 置信度（0-1）
 *    relevance        — 搜索相关性（0-1）
 *
 *  权重分配（可配置）：
 *    strength 0.20 + retention 0.20 + frequency 0.15 + recency 0.15
 *    + importance 0.15 + confidence 0.10 + relevance 0.05 = 1.0
 *--------------------------------------------------------------------------------------------*/

export interface ScoreInput {
	strength: number;
	retentionScore?: number;
	accessFrequency?: number;
	recency?: number;
	importance?: number;
	confidence?: number;
	relevance?: number;
	age?: number;            // milliseconds since creation
	lastAccessedAt?: number;
}

export interface ScoreWeights {
	strength: number;
	retention: number;
	frequency: number;
	recency: number;
	importance: number;
	confidence: number;
	relevance: number;
}

export interface ScoreBreakdown {
	strength: number;
	retention: number;
	frequency: number;
	recency: number;
	importance: number;
	confidence: number;
	relevance: number;
	total: number;
}

const DEFAULT_WEIGHTS: ScoreWeights = {
	strength: 0.20,
	retention: 0.20,
	frequency: 0.15,
	recency: 0.15,
	importance: 0.15,
	confidence: 0.10,
	relevance: 0.05,
};

function normalize(v: number | undefined, min: number, max: number, fallback: number = 0.5): number {
	if (v === undefined || !Number.isFinite(v)) return fallback;
	return Math.max(0, Math.min(1, (v - min) / (max - min)));
}

function recencyScore(lastAccessedAt: number | undefined, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
	if (!lastAccessedAt) return 0;
	const age = Date.now() - lastAccessedAt;
	if (age <= 0) return 1;
	if (age >= maxAgeMs) return 0;
	// 指数衰减
	return Math.exp(-age / (maxAgeMs / 3));
}

export class UnifiedScorer {
	private _weights: ScoreWeights;

	constructor(weights?: Partial<ScoreWeights>) {
		this._weights = { ...DEFAULT_WEIGHTS, ...weights };
		// 归一化权重
		const sum = Object.values(this._weights).reduce((s, v) => s + v, 0);
		if (sum > 0) {
			for (const key of Object.keys(this._weights) as Array<keyof ScoreWeights>) {
				this._weights[key] = this._weights[key] / sum;
			}
		}
	}

	/**
	 * 计算统一评分
	 */
	score(input: ScoreInput): { total: number; breakdown: ScoreBreakdown } {
		const strength = normalize(input.strength, 0, 1, 0.5);
		const retention = normalize(input.retentionScore, 0, 1, 0.5);
		const frequency = normalize(input.accessFrequency, 0, 10, 0);  // 10次/天 = 满分
		const recency = input.recency ?? recencyScore(input.lastAccessedAt);
		const importance = normalize(input.importance, 1, 10, 0.5);
		const confidence = normalize(input.confidence, 0, 1, 0.7);
		const relevance = normalize(input.relevance, 0, 1, 0.5);

		const breakdown: ScoreBreakdown = {
			strength,
			retention,
			frequency,
			recency,
			importance,
			confidence,
			relevance,
			total: 0,
		};

		breakdown.total =
			strength * this._weights.strength +
			retention * this._weights.retention +
			frequency * this._weights.frequency +
			recency * this._weights.recency +
			importance * this._weights.importance +
			confidence * this._weights.confidence +
			relevance * this._weights.relevance;

		breakdown.total = Math.max(0, Math.min(1, breakdown.total));

		return { total: breakdown.total, breakdown };
	}

	/**
	 * 批量评分 + 排序
	 */
	scoreAndRank(entries: Array<{ id: string } & ScoreInput>, limit?: number): Array<{ id: string; score: number; breakdown: ScoreBreakdown }> {
		const scored = entries.map(e => {
			const result = this.score(e);
			return { id: e.id, score: result.total, breakdown: result.breakdown };
		});
		scored.sort((a, b) => b.score - a.score);
		return limit ? scored.slice(0, limit) : scored;
	}

	/**
	 * 更新权重
	 */
	updateWeights(weights: Partial<ScoreWeights>): void {
		this._weights = { ...this._weights, ...weights };
		const sum = Object.values(this._weights).reduce((s, v) => s + v, 0);
		if (sum > 0) {
			for (const key of Object.keys(this._weights) as Array<keyof ScoreWeights>) {
				this._weights[key] = this._weights[key] / sum;
			}
		}
	}

	/**
	 * 获取权重
	 */
	getWeights(): ScoreWeights {
		return { ...this._weights };
	}
}
