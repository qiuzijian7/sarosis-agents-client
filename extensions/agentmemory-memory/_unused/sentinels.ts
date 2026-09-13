/*---------------------------------------------------------------------------------------------
 *  哨兵 — 健康监控哨兵，监控特定条件并在触发时通知。
 *  参考 agentmemory src/functions/sentinels.ts
 *
 *  哨兵类型：
 *    threshold — 指标阈值（如记忆数 > 5000 时告警）
 *    timer     — 定时器（如每 6 小时检查一次）
 *    pattern   — 模式匹配（如检测到错误模式时告警）
 *    webhook   — Webhook 触发
 *    approval  — 审批触发
 *    custom    — 自定义
 *
 *  核心能力：
 *    1. create(name, type, config) — 创建哨兵
 *    2. check(metric, value) — 检查阈值哨兵
 *    3. evaluate(value) — 评估所有哨兵
 *    4. getTriggered() — 获取已触发的哨兵
 *--------------------------------------------------------------------------------------------*/

export type SentinelType = 'threshold' | 'timer' | 'pattern' | 'webhook' | 'approval' | 'custom';

export interface SentinelConfig {
	metric?: string;           // threshold: 监控的指标名
	operator?: 'gt' | 'lt' | 'eq';  // threshold: 比较操作符
	value?: number;             // threshold: 阈值
	pattern?: string;           // pattern: 正则模式
	durationMs?: number;        // timer: 持续时间
	path?: string;              // webhook: 路径
	[key: string]: unknown;
}

export interface Sentinel {
	id: string;
	name: string;
	type: SentinelType;
	config: SentinelConfig;
	linkedActionIds: string[];
	status: 'active' | 'triggered' | 'resolved' | 'expired';
	triggeredAt?: number;
	triggeredValue?: unknown;
	createdAt: string;
	expiresAt?: string;
}

export interface SentinelTrigger {
	sentinelId: string;
	name: string;
	type: SentinelType;
	value: unknown;
	reason: string;
	triggeredAt: number;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const VALID_TYPES: SentinelType[] = ['threshold', 'timer', 'pattern', 'webhook', 'approval', 'custom'];

export class SentinelManager {
	private _sentinels = new Map<string, Sentinel>();
	private _triggers: SentinelTrigger[] = [];
	private _maxTriggers = 200;

	/**
	 * 创建哨兵
	 */
	create(opts: {
		name: string;
		type: SentinelType;
		config?: SentinelConfig;
		linkedActionIds?: string[];
		expiresInMs?: number;
	}): Sentinel | null {
		if (!opts.name || !opts.type || !VALID_TYPES.includes(opts.type)) {
			return null;
		}

		// 验证配置
		if (opts.type === 'threshold') {
			if (!opts.config?.metric || !opts.config?.operator || typeof opts.config?.value !== 'number') {
				return null;
			}
		}
		if (opts.type === 'pattern') {
			if (!opts.config?.pattern || typeof opts.config.pattern !== 'string') {
				return null;
			}
		}
		if (opts.type === 'timer') {
			if (typeof opts.config?.durationMs !== 'number' || opts.config.durationMs <= 0) {
				return null;
			}
		}

		const now = new Date();
		const sentinel: Sentinel = {
			id: generateId('sentinel'),
			name: opts.name.trim(),
			type: opts.type,
			config: opts.config ?? {},
			linkedActionIds: opts.linkedActionIds ?? [],
			status: 'active',
			createdAt: now.toISOString(),
			expiresAt: opts.expiresInMs ? new Date(now.getTime() + opts.expiresInMs).toISOString() : undefined,
		};

		this._sentinels.set(sentinel.id, sentinel);
		return sentinel;
	}

	/**
	 * 评估所有阈值哨兵
	 */
	evaluate(metrics: Record<string, number>): SentinelTrigger[] {
		const triggers: SentinelTrigger[] = [];
		const now = Date.now();

		for (const sentinel of this._sentinels.values()) {
			if (sentinel.status !== 'active') continue;
			if (sentinel.expiresAt && new Date(sentinel.expiresAt).getTime() < now) {
				sentinel.status = 'expired';
				continue;
			}

			if (sentinel.type === 'threshold') {
				const { metric, operator, value } = sentinel.config;
				if (!metric || !operator || value === undefined) continue;

				const actualValue = metrics[metric];
				if (actualValue === undefined) continue;

				let triggered = false;
				switch (operator) {
					case 'gt': triggered = actualValue > value; break;
					case 'lt': triggered = actualValue < value; break;
					case 'eq': triggered = actualValue === value; break;
				}

				if (triggered) {
					sentinel.status = 'triggered';
					sentinel.triggeredAt = now;
					sentinel.triggeredValue = actualValue;
					const trigger: SentinelTrigger = {
						sentinelId: sentinel.id,
						name: sentinel.name,
						type: sentinel.type,
						value: actualValue,
						reason: `${metric} (${actualValue}) ${operator} ${value}`,
						triggeredAt: now,
					};
					triggers.push(trigger);
					this._triggers.push(trigger);
				}
			}
		}

		// 限制触发历史
		if (this._triggers.length > this._maxTriggers) {
			this._triggers = this._triggers.slice(-this._maxTriggers);
		}

		return triggers;
	}

	/**
	 * 评估模式哨兵
	 */
	evaluatePattern(text: string): SentinelTrigger[] {
		const triggers: SentinelTrigger[] = [];
		const now = Date.now();

		for (const sentinel of this._sentinels.values()) {
			if (sentinel.status !== 'active' || sentinel.type !== 'pattern') continue;

			const pattern = sentinel.config.pattern;
			if (!pattern) continue;

			try {
				const regex = new RegExp(pattern);
				if (regex.test(text)) {
					sentinel.status = 'triggered';
					sentinel.triggeredAt = now;
					sentinel.triggeredValue = text.slice(0, 200);
					const trigger: SentinelTrigger = {
						sentinelId: sentinel.id,
						name: sentinel.name,
						type: sentinel.type,
						value: text.slice(0, 200),
						reason: `Pattern "${pattern}" matched`,
						triggeredAt: now,
					};
					triggers.push(trigger);
					this._triggers.push(trigger);
				}
			} catch {
				// Invalid regex, skip
			}
		}

		return triggers;
	}

	/**
	 * 解决哨兵（标记为已处理）
	 */
	resolve(sentinelId: string, resolvedBy?: string): boolean {
		const sentinel = this._sentinels.get(sentinelId);
		if (!sentinel || sentinel.status !== 'triggered') return false;
		sentinel.status = 'resolved';
		return true;
	}

	/**
	 * 重置哨兵为活跃
	 */
	reset(sentinelId: string): boolean {
		const sentinel = this._sentinels.get(sentinelId);
		if (!sentinel) return false;
		sentinel.status = 'active';
		sentinel.triggeredAt = undefined;
		sentinel.triggeredValue = undefined;
		return true;
	}

	/**
	 * 获取已触发的哨兵
	 */
	getTriggered(): Sentinel[] {
		return Array.from(this._sentinels.values()).filter(s => s.status === 'triggered');
	}

	/**
	 * 获取触发历史
	 */
	getTriggerHistory(limit: number = 50): SentinelTrigger[] {
		return this._triggers.slice(-limit).reverse();
	}

	/**
	 * 列出所有哨兵
	 */
	list(filter?: { type?: SentinelType; status?: Sentinel['status'] }): Sentinel[] {
		let sentinels = Array.from(this._sentinels.values());
		if (filter?.type) {
			sentinels = sentinels.filter(s => s.type === filter.type);
		}
		if (filter?.status) {
			sentinels = sentinels.filter(s => s.status === filter.status);
		}
		return sentinels;
	}

	/**
	 * 删除哨兵
	 */
	delete(id: string): boolean {
		return this._sentinels.delete(id);
	}

	/**
	 * 获取统计
	 */
	getStats(): { total: number; active: number; triggered: number; resolved: number; expired: number; totalTriggers: number } {
		const sentinels = Array.from(this._sentinels.values());
		return {
			total: sentinels.length,
			active: sentinels.filter(s => s.status === 'active').length,
			triggered: sentinels.filter(s => s.status === 'triggered').length,
			resolved: sentinels.filter(s => s.status === 'resolved').length,
			expired: sentinels.filter(s => s.status === 'expired').length,
			totalTriggers: this._triggers.length,
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._sentinels.clear();
		this._triggers = [];
	}
}
