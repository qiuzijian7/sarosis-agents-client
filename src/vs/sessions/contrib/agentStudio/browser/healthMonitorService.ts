/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IHealthMonitorService, IMetricsSummary, ITimeRange, IInstanceMetrics, ISystemMetrics, IHealthChangeEvent, IAlertEvent, IAlertRule, IAlert, IHealthStatus, ISystemHealth, HealthState } from '../common/healthMonitor.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentDriverService } from '../common/agentDriver.js';

// ------------------------------------------------------------------------------------
// 健康监控服务实现
// ------------------------------------------------------------------------------------

export class HealthMonitorService extends Disposable implements IHealthMonitorService {
	
	declare readonly _serviceBrand: undefined;
	
	private readonly _onDidHealthChange = this._register(new Emitter<IHealthChangeEvent>());
	readonly onDidHealthChange: Event<IHealthChangeEvent> = this._onDidHealthChange.event;
	
	private readonly _onDidAlertTriggered = this._register(new Emitter<IAlertEvent>());
	readonly onDidAlertTriggered: Event<IAlertEvent> = this._onDidAlertTriggered.event;
	
	// 存储所有实例的健康数据
	private readonly _instanceMetrics = new Map<string, InstanceMetricsInternal>();
	private readonly _alertRules = new Map<string, IAlertRule>();
	private readonly _activeAlerts = new Map<string, IAlert>();
	
	// 健康检查定时器（当前未使用，保留以供将来扩展）
	private readonly HEALTH_CHECK_INTERVAL = 60000; // 60秒检查一次
	
	// 防抖保存定时器
	private _saveTimer: any = null;
	private readonly SAVE_DEBOUNCE_DELAY = 5000; // 5秒防抖
	
	// 健康检查定时器
	private _healthCheckTimer: any = null;
	
	override dispose(): void {
		if (this._healthCheckTimer) {
			clearInterval(this._healthCheckTimer);
			this._healthCheckTimer = null;
		}
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = null;
		}
		super.dispose();
	}
	
	// 存储键
	private static readonly STORAGE_KEY_INSTANCE_METRICS = 'agentStudio.healthMonitor.instanceMetrics';
	private static readonly STORAGE_KEY_ALERT_RULES = 'agentStudio.healthMonitor.alertRules';
	private static readonly STORAGE_KEY_ACTIVE_ALERTS = 'agentStudio.healthMonitor.activeAlerts';
	
	private readonly _logService: ILogService;
	private readonly _storageService: IStorageService;
	
	constructor(
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentDriverService agentDriver: IAgentDriverService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		this._logService = logService;
		
		// 保存存储服务引用
		this._storageService = storageService;
		
		// 从持久化存储加载数据
		this._loadFromStorage();
		
		// 启动定时健康检查
		this._startHealthCheck();
	}
	
	// ------------------------------------------------------------------------------------
	// 定时健康检查
	// ------------------------------------------------------------------------------------
	
	private _startHealthCheck(): void {
		this._logService.info('[HealthMonitor] Starting periodic health check');
		
		this._healthCheckTimer = setInterval(() => {
			this._performHealthCheck();
		}, this.HEALTH_CHECK_INTERVAL);
	}
	
	private async _performHealthCheck(): Promise<void> {
		this._logService.debug('[HealthMonitor] Performing periodic health check');
		
		for (const [instanceId] of this._instanceMetrics) {
			try {
				// 检查 Agent 是否响应
				const isResponsive = await this._checkAgentResponsiveness(instanceId);
				
				// 检查资源使用情况
				const resourceUsage = await this._checkResourceUsage(instanceId);
				
				// 更新指标
				const metrics = this._instanceMetrics.get(instanceId)!;
				metrics.isResponsive = isResponsive;
				metrics.cpuUsage = resourceUsage.cpu;
				metrics.memoryUsage = resourceUsage.memory;
				metrics.lastHealthCheck = Date.now();
				
				// 检查告警规则
				this._checkAlerts(instanceId);
				
				// 触发健康状态变化事件
				this._fireHealthChange(instanceId);
				
			} catch (error) {
				this._logService.error(`[HealthMonitor] Health check failed for ${instanceId}`, error);
				this.recordError(instanceId, `Health check failed: ${error}`, false);
			}
		}
	}
	
	private async _checkAgentResponsiveness(instanceId: string): Promise<boolean> {
		try {
			// 通过 AgentDriver 检查 Agent 是否响应
			// 简化实现: 假设 Agent 在最后5分钟内有活动就算响应
			const metrics = this._instanceMetrics.get(instanceId);
			if (!metrics) {
				return false;
			}
			
			const timeSinceLastActivity = Date.now() - metrics.lastUpdated;
			return timeSinceLastActivity < 5 * 60 * 1000; // 5分钟内
		} catch (error) {
			this._logService.error(`[HealthMonitor] Failed to check responsiveness for ${instanceId}`, error);
			return false;
		}
	}
	
	private async _checkResourceUsage(instanceId: string): Promise<{ cpu: number; memory: number }> {
		try {
			// 简化实现: 返回模拟数据
			// 生产环境应使用 Node.js 的 process.cpuUsage() 或系统 API
			return {
				cpu: Math.random() * 100,
				memory: Math.random() * 100
			};
		} catch (error) {
			this._logService.error(`[HealthMonitor] Failed to check resource usage for ${instanceId}`, error);
			return { cpu: 0, memory: 0 };
		}
	}
	
	// ============================================================================
	// 指标收集
	// ============================================================================
	
	recordApiCall(instanceId: string, success: boolean, duration: number, tokenUsage?: { input: number; output: number }): void {
		let metrics = this._getInstanceMetrics(instanceId);
		
		metrics.totalApiCalls++;
		if (success) {
			metrics.successfulApiCalls++;
		} else {
			metrics.failedApiCalls++;
		}
		
		// 更新平均响应时间
		metrics.totalResponseTime += duration;
		metrics.averageResponseTime = metrics.totalResponseTime / metrics.totalApiCalls;
		
		// 更新 Token 使用量
		if (tokenUsage) {
			metrics.totalTokenUsage.input += tokenUsage.input;
			metrics.totalTokenUsage.output += tokenUsage.output;
		}
		
		metrics.lastUpdated = Date.now();
		
		// 检查告警规则
		this._checkAlerts(instanceId);
		
		// 触发健康状态变化事件
		this._fireHealthChange(instanceId);
		
		// 防抖保存
		this._scheduleSave();
	}
	
	recordError(instanceId: string, error: string, fatal: boolean): void {
		let metrics = this._getInstanceMetrics(instanceId);
		
		metrics.totalErrors++;
		if (fatal) {
			metrics.fatalErrors++;
		}
		
		metrics.lastUpdated = Date.now();
		
		// 检查告警规则
		this._checkAlerts(instanceId);
		
		// 触发健康状态变化事件
		this._fireHealthChange(instanceId);
		
		// 防抖保存
		this._scheduleSave();
	}
	
	recordTaskStart(instanceId: string, taskId: string): void {
		let metrics = this._getInstanceMetrics(instanceId);
		
		metrics.activeTasks++;
		metrics.lastUpdated = Date.now();
		
		// 防抖保存
		this._scheduleSave();
	}
	
	recordTaskComplete(instanceId: string, taskId: string, success: boolean): void {
		let metrics = this._getInstanceMetrics(instanceId);
		
		metrics.activeTasks = Math.max(0, metrics.activeTasks - 1);
		metrics.completedTasks++;
		if (!success) {
			metrics.failedTasks++;
		}
		
		metrics.lastUpdated = Date.now();
		
		// 检查告警规则
		this._checkAlerts(instanceId);
		
		// 触发健康状态变化事件
		this._fireHealthChange(instanceId);
		
		// 防抖保存
		this._scheduleSave();
	}
	
	// ============================================================================
	// 查询方法
	// ============================================================================
	
	getHealthStatus(instanceId: string): IHealthStatus {
		const metrics = this._instanceMetrics.get(instanceId);
		if (!metrics) {
			return {
				instanceId,
				status: HealthState.Unknown,
				score: 0,
				lastUpdated: Date.now(),
				metrics: this._createEmptyMetrics(),
				alerts: [],
			};
		}
		
		const healthState = this._calculateHealthState(metrics);
		const score = this._calculateHealthScore(metrics);
		const alerts = this._getAlertsForInstance(instanceId);
		
		return {
			instanceId,
			status: healthState,
			score,
			lastUpdated: metrics.lastUpdated,
			metrics: this._toInstanceMetrics(metrics),
			alerts,
		};
	}
	
	getMetricsSummary(instanceId: string, timeRange?: ITimeRange): IMetricsSummary {
		const metrics = this._instanceMetrics.get(instanceId);
		if (!metrics) {
			return this._createEmptySummary();
		}
		
		// TODO: 根据 timeRange 过滤指标
		
		const errorRate = metrics.totalApiCalls > 0 
			? metrics.failedApiCalls / metrics.totalApiCalls 
			: 0;
		
		return {
			timeRange: timeRange || { startTime: 0, endTime: Date.now() },
			totalApiCalls: metrics.totalApiCalls,
			averageResponseTime: metrics.averageResponseTime,
			errorRate,
			tokenUsage: {
				input: metrics.totalTokenUsage.input,
				output: metrics.totalTokenUsage.output,
			},
			tasks: {
				total: metrics.completedTasks + metrics.activeTasks,
				successful: metrics.completedTasks - metrics.failedTasks,
				failed: metrics.failedTasks,
				active: metrics.activeTasks,
			},
		};
	}
	
	getAllHealthStatuses(): IHealthStatus[] {
		const result: IHealthStatus[] = [];
		for (const [instanceId] of this._instanceMetrics) {
			result.push(this.getHealthStatus(instanceId));
		}
		return result;
	}
	
	getSystemHealth(): ISystemHealth {
		const allStatuses = this.getAllHealthStatuses();
		const totalInstances = allStatuses.length;
		const healthyInstances = allStatuses.filter(s => s.status === HealthState.Healthy).length;
		const warningInstances = allStatuses.filter(s => s.status === HealthState.Warning).length;
		const criticalInstances = allStatuses.filter(s => s.status === HealthState.Critical).length;
		
		// 计算系统整体健康评分（加权平均）
		let totalScore = 0;
		for (const status of allStatuses) {
			totalScore += status.score;
		}
		const overallScore = totalInstances > 0 ? totalScore / totalInstances : 0;
		
		// 汇总系统指标
		let totalApiCalls = 0;
		let totalErrors = 0;
		let totalTokenUsageInput = 0;
		let totalTokenUsageOutput = 0;
		let totalAverageResponseTime = 0;
		let totalActiveTasks = 0;
		
		for (const [_, metrics] of this._instanceMetrics) {
			totalApiCalls += metrics.totalApiCalls;
			totalErrors += metrics.totalErrors;
			totalTokenUsageInput += metrics.totalTokenUsage.input;
			totalTokenUsageOutput += metrics.totalTokenUsage.output;
			totalAverageResponseTime += metrics.averageResponseTime;
			totalActiveTasks += metrics.activeTasks;
		}
		
		if (totalInstances > 0) {
			totalAverageResponseTime /= totalInstances;
		}
		
		const systemMetrics: ISystemMetrics = {
			totalApiCalls,
			totalErrors,
			totalTokenUsage: { input: totalTokenUsageInput, output: totalTokenUsageOutput },
			averageResponseTime: totalAverageResponseTime,
			activeTasks: totalActiveTasks,
		};
		
		return {
			overallScore,
			totalInstances,
			healthyInstances,
			warningInstances,
			criticalInstances,
			systemMetrics,
		};
	}
	
	// ============================================================================
	// 告警管理
	// ============================================================================
	
	setAlertRule(rule: IAlertRule): void {
		this._alertRules.set(rule.id, rule);
		this._logService.info(`[HealthMonitor] Alert rule set: ${rule.name} (${rule.id})`);
		
		// 防抖保存
		this._scheduleSave();
	}
	
	removeAlertRule(ruleId: string): void {
		this._alertRules.delete(ruleId);
		this._logService.info(`[HealthMonitor] Alert rule removed: ${ruleId}`);
		
		// 防抖保存
		this._scheduleSave();
	}
	
	getActiveAlerts(): IAlert[] {
		return Array.from(this._activeAlerts.values());
	}
	
	// ============================================================================
	// 内部方法
	// ============================================================================
	
	private _getInstanceMetrics(instanceId: string): InstanceMetricsInternal {
		let metrics = this._instanceMetrics.get(instanceId);
		if (!metrics) {
			metrics = this._createEmptyInternalMetrics();
			this._instanceMetrics.set(instanceId, metrics);
		}
		return metrics;
	}
	
	private _createEmptyInternalMetrics(): InstanceMetricsInternal {
		return {
			instanceId: '',
			totalApiCalls: 0,
			successfulApiCalls: 0,
			failedApiCalls: 0,
			totalErrors: 0,
			fatalErrors: 0,
			totalResponseTime: 0,
			averageResponseTime: 0,
			totalTokenUsage: { input: 0, output: 0 },
			activeTasks: 0,
			completedTasks: 0,
			failedTasks: 0,
			startTime: Date.now(),
			lastUpdated: Date.now(),
		};
	}
	
	private _createEmptyMetrics(): IInstanceMetrics {
		return {
			totalApiCalls: 0,
			successfulApiCalls: 0,
			failedApiCalls: 0,
			totalErrors: 0,
			fatalErrors: 0,
			averageResponseTime: 0,
			totalTokenUsage: { input: 0, output: 0 },
			activeTasks: 0,
			completedTasks: 0,
			failedTasks: 0,
			uptime: 0,
		};
	}
	
	private _createEmptySummary(): IMetricsSummary {
		return {
			timeRange: { startTime: 0, endTime: Date.now() },
			totalApiCalls: 0,
			averageResponseTime: 0,
			errorRate: 0,
			tokenUsage: { input: 0, output: 0 },
			tasks: {
				total: 0,
				successful: 0,
				failed: 0,
				active: 0,
			},
		};
	}
	
	private _toInstanceMetrics(internal: InstanceMetricsInternal): IInstanceMetrics {
		return {
			totalApiCalls: internal.totalApiCalls,
			successfulApiCalls: internal.successfulApiCalls,
			failedApiCalls: internal.failedApiCalls,
			totalErrors: internal.totalErrors,
			fatalErrors: internal.fatalErrors,
			averageResponseTime: internal.averageResponseTime,
			totalTokenUsage: internal.totalTokenUsage,
			activeTasks: internal.activeTasks,
			completedTasks: internal.completedTasks,
			failedTasks: internal.failedTasks,
			uptime: Date.now() - internal.startTime,
		};
	}
	
	private _calculateHealthState(metrics: InstanceMetricsInternal): HealthState {
		const errorRate = metrics.totalApiCalls > 0 
			? metrics.failedApiCalls / metrics.totalApiCalls 
			: 0;
		
		if (errorRate > 0.1 || metrics.fatalErrors > 0) {
			return HealthState.Critical;
		}
		
		if (errorRate > 0.05 || metrics.totalErrors > 10) {
			return HealthState.Warning;
		}
		
		return HealthState.Healthy;
	}
	
	private _calculateHealthScore(metrics: InstanceMetricsInternal): number {
		// 基础分数 100
		let score = 100;
		
		// 错误率扣分（每1%错误扣10分）
		const errorRate = metrics.totalApiCalls > 0 
			? metrics.failedApiCalls / metrics.totalApiCalls 
			: 0;
		score -= errorRate * 1000;
		
		// 致命错误扣分（每个扣20分）
		score -= metrics.fatalErrors * 20;
		
		// 响应时间扣分（超过5秒每个扣10分）
		if (metrics.averageResponseTime > 5000) {
			score -= (metrics.averageResponseTime - 5000) / 100;
		}
		
		return Math.max(0, Math.min(100, score));
	}
	
	private _getAlertsForInstance(instanceId: string): IAlert[] {
		const result: IAlert[] = [];
		for (const [_alertId, alert] of this._activeAlerts) {
			if (alert.instanceId === instanceId) {
				result.push(alert);
			}
		}
		return result;
	}
	
	private _checkAlerts(instanceId: string): void {
		const metrics = this._instanceMetrics.get(instanceId);
		if (!metrics) {
			return;
		}
		
		for (const [_ruleId, rule] of this._alertRules) {
			if (!rule.enabled) {
				continue;
			}
			
			// 检查实例匹配
			if (rule.instanceId && rule.instanceId !== instanceId) {
				continue;
			}
			
			// 检查条件
			const triggered = this._evaluateCondition(rule.condition, metrics);
			
			if (triggered) {
				// 触发告警
				const alert: IAlert = {
					id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
					ruleId: rule.id,
					instanceId,
					severity: rule.severity,
					message: rule.message,
					triggeredAt: Date.now(),
					resolved: false,
				};
				
				this._activeAlerts.set(alert.id, alert);
				this._onDidAlertTriggered.fire({ alert, type: 'triggered' });
				this._logService.warn(`[HealthMonitor] Alert triggered: ${rule.name} for ${instanceId}`);
				
				// 防抖保存
				this._scheduleSave();
			}
		}
	}
	
	private _evaluateCondition(condition: IAlertCondition, metrics: InstanceMetricsInternal): boolean {
		const metricValue = this._getMetricValue(condition.metric, metrics);
		
		switch (condition.operator) {
			case 'gt':
				return metricValue > condition.threshold;
			case 'gte':
				return metricValue >= condition.threshold;
			case 'lt':
				return metricValue < condition.threshold;
			case 'lte':
				return metricValue <= condition.threshold;
			case 'eq':
				return metricValue === condition.threshold;
			default:
				return false;
		}
	}
	
	private _getMetricValue(metricName: string, metrics: InstanceMetricsInternal): number {
		switch (metricName) {
			case 'errorRate':
				return metrics.totalApiCalls > 0 
					? metrics.failedApiCalls / metrics.totalApiCalls 
					: 0;
			case 'responseTime':
				return metrics.averageResponseTime;
			case 'tokenUsage':
				return metrics.totalTokenUsage.input + metrics.totalTokenUsage.output;
			case 'errorCount':
				return metrics.totalErrors;
			case 'fatalErrorCount':
				return metrics.fatalErrors;
			default:
				return 0;
		}
	}
	
	private _fireHealthChange(instanceId: string): void {
		const oldStatus = HealthState.Unknown; // TODO: 保存旧状态
		const newStatus = this.getHealthStatus(instanceId).status;
		
		if (oldStatus !== newStatus) {
			const metrics = this._instanceMetrics.get(instanceId);
			if (metrics) {
				this._onDidHealthChange.fire({
					instanceId,
					oldStatus,
					newStatus,
					metrics: this._toInstanceMetrics(metrics),
				});
			}
		}
	}
	
	// ============================================================================
	// 持久化存储
	// ============================================================================
	
	private _loadFromStorage(): void {
		if (!this._storageService) {
			return;
		}
		
		try {
			// 加载实例指标
			const metricsJson = this._storageService.get(
				HealthMonitorService.STORAGE_KEY_INSTANCE_METRICS,
				StorageScope.WORKSPACE,
				'[]'
			);
			const metricsData: Array<[string, InstanceMetricsInternal]> = JSON.parse(metricsJson);
			this._instanceMetrics.clear();
			for (const [key, value] of metricsData) {
				this._instanceMetrics.set(key, value);
			}
			this._logService.info(`[HealthMonitor] Loaded ${this._instanceMetrics.size} instance metrics from storage`);
			
			// 加载告警规则
			const rulesJson = this._storageService.get(
				HealthMonitorService.STORAGE_KEY_ALERT_RULES,
				StorageScope.WORKSPACE,
				'[]'
			);
			const rulesData: Array<[string, IAlertRule]> = JSON.parse(rulesJson);
			this._alertRules.clear();
			for (const [key, value] of rulesData) {
				this._alertRules.set(key, value);
			}
			this._logService.info(`[HealthMonitor] Loaded ${this._alertRules.size} alert rules from storage`);
			
			// 加载活动告警
			const alertsJson = this._storageService.get(
				HealthMonitorService.STORAGE_KEY_ACTIVE_ALERTS,
				StorageScope.WORKSPACE,
				'[]'
			);
			const alertsData: Array<[string, IAlert]> = JSON.parse(alertsJson);
			this._activeAlerts.clear();
			for (const [key, value] of alertsData) {
				this._activeAlerts.set(key, value);
			}
			this._logService.info(`[HealthMonitor] Loaded ${this._activeAlerts.size} active alerts from storage`);
		} catch (error) {
			this._logService.error('[HealthMonitor] Failed to load from storage:', error);
		}
	}
	
	private _saveToStorage(): void {
		if (!this._storageService) {
			return;
		}
		
		try {
			// 保存实例指标
			const metricsArray = Array.from(this._instanceMetrics.entries());
			this._storageService.store(
				HealthMonitorService.STORAGE_KEY_INSTANCE_METRICS,
				JSON.stringify(metricsArray),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
			
			// 保存告警规则
			const rulesArray = Array.from(this._alertRules.entries());
			this._storageService.store(
				HealthMonitorService.STORAGE_KEY_ALERT_RULES,
				JSON.stringify(rulesArray),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
			
			// 保存活动告警
			const alertsArray = Array.from(this._activeAlerts.entries());
			this._storageService.store(
				HealthMonitorService.STORAGE_KEY_ACTIVE_ALERTS,
				JSON.stringify(alertsArray),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
			
			this._logService.debug('[HealthMonitor] Saved to storage');
		} catch (error) {
			this._logService.error('[HealthMonitor] Failed to save to storage:', error);
		}
	}
	
	/**
	 * 防抖保存 - 避免在频繁更新时反复写入存储
	 */
	private _scheduleSave(): void {
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
		}
		
		this._saveTimer = setTimeout(() => {
			this._saveToStorage();
			this._saveTimer = null;
		}, this.SAVE_DEBOUNCE_DELAY);
	}
	
	// ============================================================================
	// 服务注入
	// ============================================================================
	
	}


// ------------------------------------------------------------------------------------
// 内部类型
// ------------------------------------------------------------------------------------

interface InstanceMetricsInternal {
	instanceId: string;
	totalApiCalls: number;
	successfulApiCalls: number;
	failedApiCalls: number;
	totalErrors: number;
	fatalErrors: number;
	totalResponseTime: number;
	averageResponseTime: number;
	totalTokenUsage: { input: number; output: number };
	activeTasks: number;
	completedTasks: number;
	failedTasks: number;
	startTime: number;
	lastUpdated: number;
	// 新增：健康检查相关字段
	isResponsive?: boolean;
	cpuUsage?: number;
	memoryUsage?: number;
	lastHealthCheck?: number;
}

// ------------------------------------------------------------------------------------
// 告警条件接口（需要从 healthMonitor.ts 导入）
// ------------------------------------------------------------------------------------

export interface IAlertCondition {
	readonly metric: string;
	readonly operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
	readonly threshold: number;
	readonly duration?: number;
}
