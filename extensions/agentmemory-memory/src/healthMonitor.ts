/*---------------------------------------------------------------------------------------------
 *  健康监控 — 聚合诊断 + 哨兵 + 熔断器状态，统一系统健康视图。
 *  参考 agentmemory src/functions/diagnostics.ts + sentinels.ts
 *
 *  与现有 Diagnostics 的区别：
 *    - Diagnostics：一次性检查（索引一致性 + 维度 + 存储）
 *    - HealthMonitor：持续监控（定时检查 + 告警 + 趋势分析）
 *
 *  核心能力：
 *    1. registerCheck(name, fn) — 注册健康检查
 *    2. runAllChecks() — 运行所有检查
 *    3. getHealthSummary() — 获取健康摘要
 *    4. getTrends() — 获取趋势（历史记录）
 *    5. getAlerts() — 获取告警
 *--------------------------------------------------------------------------------------------*/

import type { CircuitBreakerRegistry } from './circuitBreaker.js';
import type { SentinelManager } from './sentinels.js';
import type { Diagnostics, DiagnosticResult } from './diagnostics.js';

export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export interface HealthCheck {
	name: string;
	category: string;
	check: () => Promise<HealthCheckResult> | HealthCheckResult;
	enabled: boolean;
	intervalMs: number;     // 检查间隔
	lastRunAt?: number;
	lastResult?: HealthCheckResult;
}

export interface HealthCheckResult {
	status: 'pass' | 'warn' | 'fail';
	message: string;
	metrics?: Record<string, number>;
}

export interface HealthSnapshot {
	timestamp: number;
	status: HealthStatus;
	checks: Array<{ name: string; category: string; status: string; message: string }>;
	circuitBreakers?: Record<string, unknown>;
	sentinels?: Record<string, unknown>;
	summary: {
		total: number;
		pass: number;
		warn: number;
		fail: number;
	};
}

export interface HealthTrend {
	timestamp: number;
	status: HealthStatus;
	passCount: number;
	warnCount: number;
	failCount: number;
}

export interface HealthAlert {
	id: string;
	checkName: string;
	severity: 'warn' | 'fail';
	message: string;
	timestamp: number;
	resolved: boolean;
	resolvedAt?: number;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class HealthMonitor {
	private _checks = new Map<string, HealthCheck>();
	private _snapshots: HealthSnapshot[] = [];
	private _trends: HealthTrend[] = [];
	private _alerts: HealthAlert[] = [];
	private _maxSnapshots = 100;
	private _maxTrends = 500;
	private _maxAlerts = 200;
	private _monitorTimer: ReturnType<typeof setInterval> | undefined;
	private _circuitRegistry?: CircuitBreakerRegistry;
	private _sentinelManager?: SentinelManager;
	private _diagnostics?: Diagnostics;

	constructor(opts?: {
		circuitRegistry?: CircuitBreakerRegistry;
		sentinelManager?: SentinelManager;
		diagnostics?: Diagnostics;
	}) {
		this._circuitRegistry = opts?.circuitRegistry;
		this._sentinelManager = opts?.sentinelManager;
		this._diagnostics = opts?.diagnostics;
	}

	/**
	 * 注册健康检查
	 */
	registerCheck(name: string, category: string, check: () => Promise<HealthCheckResult> | HealthCheckResult, intervalMs: number = 60_000): void {
		this._checks.set(name, {
			name,
			category,
			check,
			enabled: true,
			intervalMs,
		});
	}

	/**
	 * 运行所有检查
	 */
	async runAllChecks(): Promise<HealthSnapshot> {
		const checks: Array<{ name: string; category: string; status: string; message: string }> = [];
		let pass = 0, warn = 0, fail = 0;

		for (const [name, check] of this._checks) {
			if (!check.enabled) continue;

			try {
				const result = await check.check();
				check.lastRunAt = Date.now();
				check.lastResult = result;

				checks.push({
					name,
					category: check.category,
					status: result.status,
					message: result.message,
				});

				switch (result.status) {
					case 'pass': pass++; break;
					case 'warn':
						warn++;
						this._addAlert(name, 'warn', result.message);
						break;
					case 'fail':
						fail++;
						this._addAlert(name, 'fail', result.message);
						break;
				}
			} catch (err) {
				fail++;
				const msg = err instanceof Error ? err.message : String(err);
				checks.push({ name, category: check.category, status: 'fail', message: msg });
				this._addAlert(name, 'fail', msg);
			}
		}

		const status: HealthStatus = fail > 0 ? 'critical' : warn > 0 ? 'degraded' : 'healthy';

		const snapshot: HealthSnapshot = {
			timestamp: Date.now(),
			status,
			checks,
			circuitBreakers: this._circuitRegistry?.getAllStates(),
			sentinels: this._sentinelManager?.getStats() as unknown as Record<string, unknown>,
			summary: { total: checks.length, pass, warn, fail },
		};

		this._snapshots.push(snapshot);
		if (this._snapshots.length > this._maxSnapshots) {
			this._snapshots.shift();
		}

		// 记录趋势
		const trend: HealthTrend = {
			timestamp: snapshot.timestamp,
			status,
			passCount: pass,
			warnCount: warn,
			failCount: fail,
		};
		this._trends.push(trend);
		if (this._trends.length > this._maxTrends) {
			this._trends.shift();
		}

		return snapshot;
	}

	/**
	 * 添加告警
	 */
	private _addAlert(checkName: string, severity: 'warn' | 'fail', message: string): void {
		// 检查是否已有相同告警
		const existing = this._alerts.find(a =>
			a.checkName === checkName && a.severity === severity && !a.resolved,
		);
		if (existing) {
			existing.message = message;
			existing.timestamp = Date.now();
			return;
		}

		this._alerts.push({
			id: generateId('alert'),
			checkName,
			severity,
			message,
			timestamp: Date.now(),
			resolved: false,
		});

		if (this._alerts.length > this._maxAlerts) {
			this._alerts.shift();
		}
	}

	/**
	 * 解决告警
	 */
	resolveAlert(alertId: string): boolean {
		const alert = this._alerts.find(a => a.id === alertId);
		if (!alert || alert.resolved) return false;
		alert.resolved = true;
		alert.resolvedAt = Date.now();
		return true;
	}

	/**
	 * 自动解决已恢复的告警
	 */
	autoResolveAlerts(currentSnapshot: HealthSnapshot): number {
		let resolved = 0;
		for (const alert of this._alerts) {
			if (alert.resolved) continue;
			const check = currentSnapshot.checks.find(c => c.name === alert.checkName);
			if (check && check.status === 'pass') {
				alert.resolved = true;
				alert.resolvedAt = Date.now();
				resolved++;
			}
		}
		return resolved;
	}

	/**
	 * 获取健康摘要
	 */
	getHealthSummary(): HealthSnapshot | null {
		return this._snapshots.length > 0 ? this._snapshots[this._snapshots.length - 1] : null;
	}

	/**
	 * 获取趋势
	 */
	getTrends(limit: number = 50): HealthTrend[] {
		return this._trends.slice(-limit);
	}

	/**
	 * 获取活跃告警
	 */
	getActiveAlerts(): HealthAlert[] {
		return this._alerts.filter(a => !a.resolved);
	}

	/**
	 * 获取告警历史
	 */
	getAlertHistory(limit: number = 50): HealthAlert[] {
		return this._alerts.slice(-limit).reverse();
	}

	/**
	 * 启动定时监控
	 */
	startMonitoring(intervalMs: number = 60_000): void {
		if (this._monitorTimer) return;
		this._monitorTimer = setInterval(async () => {
			try {
				await this.runAllChecks();
			} catch (err) {
				console.warn('[AgentMemory] health monitor failed:', err);
			}
		}, intervalMs);
		if (this._monitorTimer && typeof (this._monitorTimer as any).unref === 'function') {
			(this._monitorTimer as any).unref();
		}
	}

	/**
	 * 停止定时监控
	 */
	stopMonitoring(): void {
		if (this._monitorTimer) {
			clearInterval(this._monitorTimer);
			this._monitorTimer = undefined;
		}
	}

	/**
	 * 启用/禁用检查
	 */
	setCheckEnabled(name: string, enabled: boolean): boolean {
		const check = this._checks.get(name);
		if (!check) return false;
		check.enabled = enabled;
		return true;
	}

	/**
	 * 列出所有检查
	 */
	listChecks(): Array<{ name: string; category: string; enabled: boolean; lastRunAt?: number; lastStatus?: string }> {
		return Array.from(this._checks.values()).map(c => ({
			name: c.name,
			category: c.category,
			enabled: c.enabled,
			lastRunAt: c.lastRunAt,
			lastStatus: c.lastResult?.status,
		}));
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._checks.clear();
		this._snapshots = [];
		this._trends = [];
		this._alerts = [];
	}

	dispose(): void {
		this.stopMonitoring();
		this.clear();
	}
}
