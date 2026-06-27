/*---------------------------------------------------------------------------------------------
 *  报告生成器 — 聚合所有模块的统计信息，生成统一报告。
 *
 *  解决问题：71+ 模块各自有统计，用户需要手动调用每个 getStats()。
 *  ReportGenerator 一键聚合所有模块状态。
 *
 *  报告类型：
 *    1. summary — 摘要报告（关键指标）
 *    2. detailed — 详细报告（所有模块）
 *    3. health — 健康报告（诊断 + 告警 + 熔断器）
 *    4. performance — 性能报告（延迟 + 吞吐量 + 错误率）
 *    5. usage — 使用报告（记忆数 + 访问模式 + 搜索历史）
 *--------------------------------------------------------------------------------------------*/

export type ReportType = 'summary' | 'detailed' | 'health' | 'performance' | 'usage';

export interface ReportSection {
	name: string;
	healthy: boolean;
	metrics: Record<string, unknown>;
	warnings?: string[];
}

export interface SystemReport {
	type: ReportType;
	timestamp: number;
	overallHealth: 'healthy' | 'degraded' | 'critical';
	sections: ReportSection[];
	summary: string;
	recommendations: string[];
}

export interface ReportDataSource {
	// Core
	getStats?(agentId?: string): unknown;
	// Health
	getHealthSummary?(): unknown;
	getActiveAlerts?(): unknown[];
	// Metrics
	getMetricsSummary?(): unknown;
	// Access
	getAccessTrackerStats?(): unknown;
	getAccessPatternStats?(agentId?: string): unknown;
	// Search
	getSearchStats?(agentId?: string): unknown;
	// Diagnostics
	runDiagnostics?(agentId: string): unknown;
	// Quota
	getQuotaStats?(): unknown;
	// Circuit
	getAllCircuitBreakerStates?(): Record<string, unknown>;
	// Notifications
	getNotificationStats?(): unknown;
	// BloomFilter
	getBloomFilterStats?(agentId: string): unknown;
	// Rate limiter
	getRateLimiterStats?(): Record<string, unknown>;
	// Subagent
	getSubagentStats?(): unknown;
	// Event bus
	getEventBusStats?(): unknown;
	// Write queue
	getWriteQueueStats?(): unknown;
	// Temporal graph
	getTemporalGraphStats?(agentId: string): unknown;
	// Image refs
	getImageRefStats?(): unknown;
	// Mesh
	getMeshTopology?(): unknown;
	// Commits
	getCommitStats?(): unknown;
	// Flow
	getFlowStats?(agentId?: string): unknown;
}

export class ReportGenerator {
	private _source: ReportDataSource;

	constructor(source: ReportDataSource) {
		this._source = source;
	}

	/**
	 * 生成报告
	 */
	async generate(type: ReportType = 'summary', agentId?: string): Promise<SystemReport> {
		switch (type) {
			case 'health':
				return this._generateHealthReport();
			case 'performance':
				return this._generatePerformanceReport();
			case 'usage':
				return this._generateUsageReport(agentId);
			case 'detailed':
				return this._generateDetailedReport(agentId);
			case 'summary':
			default:
				return this._generateSummaryReport(agentId);
		}
	}

	private _generateSummaryReport(agentId?: string): SystemReport {
		const sections: ReportSection[] = [];

		// 1. Core stats
		const stats = this._source.getStats?.(agentId);
		if (stats) {
			sections.push({
				name: 'Core Memory',
				healthy: true,
				metrics: stats as Record<string, unknown>,
			});
		}

		// 2. Quota
		const quota = this._source.getQuotaStats?.();
		if (quota) {
			const quotaRecord = quota as { violationCount: number };
			sections.push({
				name: 'Quota',
				healthy: quotaRecord.violationCount === 0,
				metrics: quota as Record<string, unknown>,
				warnings: quotaRecord.violationCount > 0 ? [`${quotaRecord.violationCount} quota violations`] : [],
			});
		}

		// 3. Circuit breakers
		const circuits = this._source.getAllCircuitBreakerStates?.();
		if (circuits) {
			const openCount = Object.values(circuits).filter(
				(s: unknown) => (s as { state: string }).state === 'open',
			).length;
			sections.push({
				name: 'Circuit Breakers',
				healthy: openCount === 0,
				metrics: { totalServices: Object.keys(circuits).length, openCircuits: openCount, states: circuits },
				warnings: openCount > 0 ? [`${openCount} circuit(s) open`] : [],
			});
		}

		// 4. Active alerts
		const alerts = this._source.getActiveAlerts?.() ?? [];
		if (alerts.length > 0) {
			sections.push({
				name: 'Active Alerts',
				healthy: false,
				metrics: { count: alerts.length, alerts: alerts.slice(0, 5) },
				warnings: [`${alerts.length} active alerts`],
			});
		}

		return this._finalizeReport('summary', sections);
	}

	private _generateHealthReport(): SystemReport {
		const sections: ReportSection[] = [];

		const health = this._source.getHealthSummary?.();
		if (health) {
			sections.push({
				name: 'Health Monitor',
				healthy: (health as { status: string }).status === 'healthy',
				metrics: health as Record<string, unknown>,
			});
		}

		const circuits = this._source.getAllCircuitBreakerStates?.();
		if (circuits) {
			const states = Object.values(circuits);
			const openCount = states.filter((s: unknown) => (s as { state: string }).state === 'open').length;
			sections.push({
				name: 'Circuit Breakers',
				healthy: openCount === 0,
				metrics: { open: openCount, total: states.length },
			});
		}

		const alerts = this._source.getActiveAlerts?.() ?? [];
		sections.push({
			name: 'Alerts',
			healthy: alerts.length === 0,
			metrics: { count: alerts.length },
		});

		return this._finalizeReport('health', sections);
	}

	private _generatePerformanceReport(): SystemReport {
		const sections: ReportSection[] = [];

		const metrics = this._source.getMetricsSummary?.();
		if (metrics) {
			sections.push({
				name: 'Performance Metrics',
				healthy: true,
				metrics: metrics as Record<string, unknown>,
			});
		}

		const rateLimit = this._source.getRateLimiterStats?.();
		if (rateLimit) {
			sections.push({
				name: 'Rate Limiters',
				healthy: true,
				metrics: rateLimit as Record<string, unknown>,
			});
		}

		const writeQueue = this._source.getWriteQueueStats?.();
		if (writeQueue) {
			sections.push({
				name: 'Write Queue',
				healthy: true,
				metrics: writeQueue as Record<string, unknown>,
			});
		}

		return this._finalizeReport('performance', sections);
	}

	private _generateUsageReport(agentId?: string): SystemReport {
		const sections: ReportSection[] = [];

		const accessStats = this._source.getAccessTrackerStats?.();
		if (accessStats) {
			sections.push({
				name: 'Access Tracking',
				healthy: true,
				metrics: accessStats as Record<string, unknown>,
			});
		}

		const patternStats = this._source.getAccessPatternStats?.(agentId);
		if (patternStats) {
			sections.push({
				name: 'Access Patterns',
				healthy: true,
				metrics: patternStats as Record<string, unknown>,
			});
		}

		const searchStats = this._source.getSearchStats?.(agentId);
		if (searchStats) {
			sections.push({
				name: 'Search History',
				healthy: true,
				metrics: searchStats as Record<string, unknown>,
			});
		}

		const commitStats = this._source.getCommitStats?.();
		if (commitStats) {
			sections.push({
				name: 'Git Commits',
				healthy: true,
				metrics: commitStats as Record<string, unknown>,
			});
		}

		return this._finalizeReport('usage', sections);
	}

	private _generateDetailedReport(agentId?: string): SystemReport {
		const sections: ReportSection[] = [];

		// Collect all available stats
		const collectors: Array<{ name: string; fn: () => unknown; healthy: boolean }> = [
			{ name: 'Core Memory', fn: () => this._source.getStats?.(agentId), healthy: true },
			{ name: 'Health Monitor', fn: () => this._source.getHealthSummary?.(), healthy: true },
			{ name: 'Metrics', fn: () => this._source.getMetricsSummary?.(), healthy: true },
			{ name: 'Access Tracker', fn: () => this._source.getAccessTrackerStats?.(), healthy: true },
			{ name: 'Access Patterns', fn: () => this._source.getAccessPatternStats?.(agentId), healthy: true },
			{ name: 'Search History', fn: () => this._source.getSearchStats?.(agentId), healthy: true },
			{ name: 'Quota', fn: () => this._source.getQuotaStats?.(), healthy: true },
			{ name: 'Circuit Breakers', fn: () => this._source.getAllCircuitBreakerStates?.(), healthy: true },
			{ name: 'Notifications', fn: () => this._source.getNotificationStats?.(), healthy: true },
			{ name: 'Rate Limiters', fn: () => this._source.getRateLimiterStats?.(), healthy: true },
			{ name: 'Subagents', fn: () => this._source.getSubagentStats?.(), healthy: true },
			{ name: 'Event Bus', fn: () => this._source.getEventBusStats?.(), healthy: true },
			{ name: 'Write Queue', fn: () => this._source.getWriteQueueStats?.(), healthy: true },
			{ name: 'Image Refs', fn: () => this._source.getImageRefStats?.(), healthy: true },
			{ name: 'Mesh Topology', fn: () => this._source.getMeshTopology?.(), healthy: true },
			{ name: 'Git Commits', fn: () => this._source.getCommitStats?.(), healthy: true },
			{ name: 'Flow Patterns', fn: () => this._source.getFlowStats?.(agentId), healthy: true },
		];

		for (const collector of collectors) {
			const result = collector.fn();
			if (result !== undefined) {
				sections.push({
					name: collector.name,
					healthy: collector.healthy,
					metrics: result as Record<string, unknown>,
				});
			}
		}

		return this._finalizeReport('detailed', sections);
	}

	private _finalizeReport(type: ReportType, sections: ReportSection[]): SystemReport {
		const unhealthyCount = sections.filter(s => !s.healthy).length;
		const overallHealth = unhealthyCount === 0 ? 'healthy' : unhealthyCount <= 2 ? 'degraded' : 'critical';

		const allWarnings = sections.flatMap(s => s.warnings ?? []);
		const recommendations: string[] = [];

		if (allWarnings.length > 0) {
			recommendations.push('Review active warnings in the report sections above.');
		}
		if (overallHealth === 'critical') {
			recommendations.push('System health is critical. Consider resetting circuit breakers and investigating root causes.');
		}
		if (overallHealth === 'degraded') {
			recommendations.push('System is operating in degraded mode. Monitor for further degradation.');
		}

		const summary = `${sections.length} sections | ${overallHealth} | ${allWarnings.length} warnings`;

		return {
			type,
			timestamp: Date.now(),
			overallHealth,
			sections,
			summary,
			recommendations,
		};
	}
}
