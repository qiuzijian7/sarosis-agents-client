/*---------------------------------------------------------------------------------------------
 *  保留评分 — 基于 lambda 衰减 + 强化提升的高级保留评分。
 *  参考 agentmemory src/functions/retention.ts
 *
 *  与现有 Ebbinghaus 衰减（strength *= 0.9^n）的区别：
 *    - Ebbinghaus：简单指数衰减，每 30 天周期衰减一次
 *    - Retention：连续 lambda 衰减 + 访问强化提升 + 分层评分（hot/warm/cold/evictable）
 *
 *  评分公式：
 *    score = min(1, salience * temporalDecay + reinforcementBoost)
 *    temporalDecay = exp(-lambda * daysSinceCreation)
 *    reinforcementBoost = sigma * Σ(1/daysSinceAccess)
 *
 *  分层：
 *    hot (≥0.7)   — 高频访问，保留
 *    warm (≥0.4)  — 中频访问，保留
 *    cold (≥0.15) — 低频访问，候选遗忘
 *    evictable (<0.15) — 可驱逐
 *--------------------------------------------------------------------------------------------*/

export interface DecayConfig {
	lambda: number;            // 衰减速率（默认 0.01）
	sigma: number;             // 强化权重（默认 0.3）
	tierThresholds: {
		hot: number;           // 默认 0.7
		warm: number;          // 默认 0.4
		cold: number;          // 默认 0.15
	};
}

export interface RetentionScore {
	memoryId: string;
	source: 'episodic' | 'semantic' | 'procedural';
	score: number;
	salience: number;
	temporalDecay: number;
	reinforcementBoost: number;
	lastAccessed: number;
	accessCount: number;
}

export interface RetentionTiers {
	hot: number;
	warm: number;
	cold: number;
	evictable: number;
}

export interface RetentionResult {
	total: number;
	scores: RetentionScore[];
	tiers: RetentionTiers;
	config: DecayConfig;
}

const DEFAULT_DECAY: DecayConfig = {
	lambda: 0.01,
	sigma: 0.3,
	tierThresholds: {
		hot: 0.7,
		warm: 0.4,
		cold: 0.15,
	},
};

const TYPE_SALIENCE_WEIGHTS: Record<string, number> = {
	architecture: 0.9,
	pattern: 0.8,
	preference: 0.85,
	bug: 0.7,
	workflow: 0.6,
	fact: 0.5,
	long_term: 0.6,
	short_term: 0.3,
};

function resolveConfig(input?: Partial<DecayConfig>): { config: DecayConfig } | { error: string } {
	const tierThresholds = {
		...DEFAULT_DECAY.tierThresholds,
		...(input?.tierThresholds ?? {}),
	};
	const config: DecayConfig = {
		lambda: typeof input?.lambda === 'number' ? input.lambda : DEFAULT_DECAY.lambda,
		sigma: typeof input?.sigma === 'number' ? input.sigma : DEFAULT_DECAY.sigma,
		tierThresholds,
	};

	if (!Number.isFinite(config.lambda) || config.lambda <= 0) {
		return { error: 'config.lambda must be a positive number' };
	}
	if (!Number.isFinite(config.sigma) || config.sigma < 0) {
		return { error: 'config.sigma must be a non-negative number' };
	}
	const { hot, warm, cold } = config.tierThresholds;
	if (![hot, warm, cold].every(v => Number.isFinite(v))) {
		return { error: 'tierThresholds must be finite numbers' };
	}
	if (!(hot >= warm && warm >= cold && cold >= 0)) {
		return { error: 'tierThresholds must satisfy hot >= warm >= cold >= 0' };
	}
	return { config };
}

function computeReinforcementBoost(accessTimestamps: number[], sigma: number): number {
	const now = Date.now();
	let boost = 0;
	for (const tAccess of accessTimestamps) {
		if (!Number.isFinite(tAccess)) continue;
		const daysSinceAccess = (now - tAccess) / (1000 * 60 * 60 * 24);
		if (daysSinceAccess > 0) {
			boost += 1 / daysSinceAccess;
		}
	}
	return boost * sigma;
}

function computeSalience(memory: RetentionEntry, accessCount: number): number {
	let baseSalience = 0.5;
	const typeWeight = TYPE_SALIENCE_WEIGHTS[memory.type];
	if (typeWeight !== undefined) {
		baseSalience = typeWeight;
	}
	if (memory.confidence !== undefined) {
		baseSalience = Math.max(baseSalience, memory.confidence);
	}
	if (memory.importance !== undefined) {
		baseSalience = Math.max(baseSalience, Math.min(1, memory.importance / 10));
	}
	const accessBonus = Math.min(0.2, accessCount * 0.02);
	return Math.min(1, baseSalience + accessBonus);
}

export interface RetentionEntry {
	id: string;
	type: string;
	content: string;
	strength: number;
	confidence?: number;
	importance?: number;
	timestamp: number;
	accessCount: number;
	lastAccessedAt: number;
	accessTimestamps?: number[];
	supersededBy?: string;
}

export class RetentionScorer {
	private _config: DecayConfig;

	constructor(config?: Partial<DecayConfig>) {
		const resolved = resolveConfig(config);
		if ('error' in resolved) {
			this._config = DEFAULT_DECAY;
		} else {
			this._config = resolved.config;
		}
	}

	/**
	 * 计算所有条目的保留评分
	 */
	scoreAll(entries: RetentionEntry[], source: 'episodic' | 'semantic' | 'procedural' = 'episodic'): RetentionResult {
		const scores: RetentionScore[] = [];
		const now = Date.now();

		for (const entry of entries) {
			if (entry.supersededBy) continue;

			const accessTimestamps = entry.accessTimestamps ?? (entry.lastAccessedAt > 0 ? [entry.lastAccessedAt] : []);
			const salience = computeSalience(entry, entry.accessCount);
			const daysSinceCreation = (now - entry.timestamp) / (1000 * 60 * 60 * 24);
			const temporalDecay = Math.exp(-this._config.lambda * daysSinceCreation);
			const reinforcementBoost = computeReinforcementBoost(accessTimestamps, this._config.sigma);
			const score = Math.min(1, salience * temporalDecay + reinforcementBoost);

			scores.push({
				memoryId: entry.id,
				source,
				score,
				salience,
				temporalDecay,
				reinforcementBoost,
				lastAccessed: entry.lastAccessedAt || entry.timestamp,
				accessCount: entry.accessCount,
			});
		}

		scores.sort((a, b) => b.score - a.score);

		const tiers = this.classifyTiers(scores);

		return {
			total: scores.length,
			scores,
			tiers,
			config: this._config,
		};
	}

	/**
	 * 将评分分类到分层
	 */
	classifyTiers(scores: RetentionScore[]): RetentionTiers {
		const { hot, warm, cold } = this._config.tierThresholds;
		return {
			hot: scores.filter(s => s.score >= hot).length,
			warm: scores.filter(s => s.score >= warm && s.score < hot).length,
			cold: scores.filter(s => s.score >= cold && s.score < warm).length,
			evictable: scores.filter(s => s.score < cold).length,
		};
	}

	/**
	 * 获取可驱逐的候选列表
	 */
	getEvictionCandidates(scores: RetentionScore[], maxEvict: number = 50): RetentionScore[] {
		return scores
			.filter(s => s.score < this._config.tierThresholds.cold)
			.sort((a, b) => a.score - b.score)
			.slice(0, Math.min(1000, Math.max(0, maxEvict)));
	}

	/**
	 * 更新配置
	 */
	updateConfig(config: Partial<DecayConfig>): { success: boolean; error?: string } {
		const resolved = resolveConfig({ ...this._config, ...config });
		if ('error' in resolved) {
			return { success: false, error: resolved.error };
		}
		this._config = resolved.config;
		return { success: true };
	}

	/**
	 * 获取当前配置
	 */
	getConfig(): DecayConfig {
		return this._config;
	}
}
