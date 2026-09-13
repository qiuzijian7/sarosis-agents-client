/*---------------------------------------------------------------------------------------------
 *  配额管理 — 资源配额限制与执行。
 *  参考 agentmemory src/functions/image-quota-cleanup.ts + disk-size-manager.ts
 *
 *  与现有 DiskManager 的区别：
 *    - DiskManager：磁盘容量监控（估计字节数）
 *    - QuotaManager：多维度配额（记忆数 + token + 图片 + 会话数）+ 执行策略
 *
 *  配额维度：
 *    maxMemoriesPerAgent    — 每 agent 最大记忆数（默认 5000）
 *    maxShortTermPerAgent   — 每 agent 最大短期记忆数（默认 200）
 *    maxTokenBudget         — 上下文 token 预算（默认 4000）
 *    maxImageStorageBytes   — 图片存储上限（默认 100MB）
 *    maxSessionsPerAgent    — 每 agent 最大并发会话数（默认 5）
 *    maxAuditLogEntries     — 审计日志上限（默认 500）
 *
 *  执行策略：
 *    reject  — 超限时拒绝新请求
 *    evict   — 超限时驱逐最旧条目
 *    warn    — 超限时只告警不拒绝
 *--------------------------------------------------------------------------------------------*/

export type QuotaDimension =
	| 'maxMemoriesPerAgent'
	| 'maxShortTermPerAgent'
	| 'maxTokenBudget'
	| 'maxImageStorageBytes'
	| 'maxSessionsPerAgent'
	| 'maxAuditLogEntries';

export type EnforcementPolicy = 'reject' | 'evict' | 'warn';

export interface QuotaConfig {
	maxMemoriesPerAgent: number;
	maxShortTermPerAgent: number;
	maxTokenBudget: number;
	maxImageStorageBytes: number;
	maxSessionsPerAgent: number;
	maxAuditLogEntries: number;
	policy: EnforcementPolicy;
}

export interface QuotaUsage {
	agentId: string;
	longTermCount: number;
	shortTermCount: number;
	tokenEstimate: number;
	imageStorageBytes: number;
	sessionCount: number;
	auditLogEntries: number;
	violations: Array<{ dimension: QuotaDimension; limit: number; actual: number }>;
}

export interface QuotaCheckResult {
	allowed: boolean;
	violations: Array<{ dimension: QuotaDimension; limit: number; actual: number; policy: EnforcementPolicy }>;
	actions: Array<{ action: string; dimension: QuotaDimension; detail: string }>;
}

const DEFAULT_CONFIG: QuotaConfig = {
	maxMemoriesPerAgent: 5000,
	maxShortTermPerAgent: 200,
	maxTokenBudget: 4000,
	maxImageStorageBytes: 100 * 1024 * 1024,  // 100MB
	maxSessionsPerAgent: 5,
	maxAuditLogEntries: 500,
	policy: 'warn',
};

export class QuotaManager {
	private _config: QuotaConfig;
	private _usageCache = new Map<string, QuotaUsage>();
	private _violationCount = 0;

	constructor(config?: Partial<QuotaConfig>) {
		this._config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * 检查配额是否允许操作
	 */
	check(agentId: string, currentUsage: {
		longTermCount: number;
		shortTermCount: number;
		tokenEstimate: number;
		imageStorageBytes: number;
		sessionCount: number;
		auditLogEntries: number;
	}): QuotaCheckResult {
		const violations: Array<{ dimension: QuotaDimension; limit: number; actual: number; policy: EnforcementPolicy }> = [];
		const actions: Array<{ action: string; dimension: QuotaDimension; detail: string }> = [];

		const checks: Array<{ dimension: QuotaDimension; actual: number; limit: number }> = [
			{ dimension: 'maxMemoriesPerAgent', actual: currentUsage.longTermCount, limit: this._config.maxMemoriesPerAgent },
			{ dimension: 'maxShortTermPerAgent', actual: currentUsage.shortTermCount, limit: this._config.maxShortTermPerAgent },
			{ dimension: 'maxTokenBudget', actual: currentUsage.tokenEstimate, limit: this._config.maxTokenBudget },
			{ dimension: 'maxImageStorageBytes', actual: currentUsage.imageStorageBytes, limit: this._config.maxImageStorageBytes },
			{ dimension: 'maxSessionsPerAgent', actual: currentUsage.sessionCount, limit: this._config.maxSessionsPerAgent },
			{ dimension: 'maxAuditLogEntries', actual: currentUsage.auditLogEntries, limit: this._config.maxAuditLogEntries },
		];

		for (const check of checks) {
			if (check.actual > check.limit) {
				violations.push({
					dimension: check.dimension,
					limit: check.limit,
					actual: check.actual,
					policy: this._config.policy,
				});

				switch (this._config.policy) {
					case 'reject':
						actions.push({ action: 'reject', dimension: check.dimension, detail: `${check.actual} > ${check.limit}` });
						break;
					case 'evict':
						actions.push({ action: 'evict', dimension: check.dimension, detail: `evict ${check.actual - check.limit} entries` });
						break;
					case 'warn':
						actions.push({ action: 'warn', dimension: check.dimension, detail: `${check.actual} exceeds ${check.limit}` });
						break;
				}
			}
		}

		const allowed = violations.length === 0 || this._config.policy !== 'reject';

		if (violations.length > 0) {
			this._violationCount++;
		}

		// 缓存使用量
		const usage: QuotaUsage = {
			agentId,
			...currentUsage,
			violations: violations.map(v => ({ dimension: v.dimension, limit: v.limit, actual: v.actual })),
		};
		this._usageCache.set(agentId, usage);

		return { allowed, violations, actions };
	}

	/**
	 * 计算需要驱逐的条目数
	 */
	getEvictionPlan(agentId: string): Array<{ dimension: QuotaDimension; toEvict: number }> {
		const usage = this._usageCache.get(agentId);
		if (!usage) return [];

		const plan: Array<{ dimension: QuotaDimension; toEvict: number }> = [];
		if (usage.longTermCount > this._config.maxMemoriesPerAgent) {
			plan.push({
				dimension: 'maxMemoriesPerAgent',
				toEvict: usage.longTermCount - this._config.maxMemoriesPerAgent,
			});
		}
		if (usage.shortTermCount > this._config.maxShortTermPerAgent) {
			plan.push({
				dimension: 'maxShortTermPerAgent',
				toEvict: usage.shortTermCount - this._config.maxShortTermPerAgent,
			});
		}
		return plan;
	}

	/**
	 * 更新配额配置
	 */
	updateConfig(config: Partial<QuotaConfig>): void {
		this._config = { ...this._config, ...config };
	}

	/**
	 * 获取配额配置
	 */
	getConfig(): QuotaConfig {
		return { ...this._config };
	}

	/**
	 * 获取使用量缓存
	 */
	getUsage(agentId: string): QuotaUsage | null {
		return this._usageCache.get(agentId) ?? null;
	}

	/**
	 * 获取统计
	 */
	getStats(): { violationCount: number; agentsTracked: number; config: QuotaConfig } {
		return {
			violationCount: this._violationCount,
			agentsTracked: this._usageCache.size,
			config: { ...this._config },
		};
	}

	/**
	 * 清除使用量缓存
	 */
	clearCache(): void {
		this._usageCache.clear();
		this._violationCount = 0;
	}
}
