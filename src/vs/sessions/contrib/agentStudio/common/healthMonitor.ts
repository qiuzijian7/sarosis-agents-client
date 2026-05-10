/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

// ------------------------------------------------------------------------------------
// 健康监控服务接口
// ------------------------------------------------------------------------------------

export const IHealthMonitorService = createDecorator<IHealthMonitorService>('healthMonitorService');

export interface IHealthMonitorService {
	readonly _serviceBrand: undefined;

	// === 指标收集 ===
	
	/**
	 * 记录 API 调用
	 */
	recordApiCall(instanceId: string, success: boolean, duration: number, tokenUsage?: { input: number; output: number }): void;
	
	/**
	 * 记录错误
	 */
	recordError(instanceId: string, error: string, fatal: boolean): void;
	
	/**
	 * 记录任务开始/完成
	 */
	recordTaskStart(instanceId: string, taskId: string): void;
	recordTaskComplete(instanceId: string, taskId: string, success: boolean): void;
	
	// === 查询方法 ===
	
	/**
	 * 获取实例健康状态
	 */
	getHealthStatus(instanceId: string): IHealthStatus;
	
	/**
	 * 获取实例指标摘要
	 */
	getMetricsSummary(instanceId: string, timeRange?: ITimeRange): IMetricsSummary;
	
	/**
	 * 获取所有实例的健康状态
	 */
	getAllHealthStatuses(): IHealthStatus[];
	
	/**
	 * 获取系统整体健康状态
	 */
	getSystemHealth(): ISystemHealth;
	
	// === 告警 ===
	
	/**
	 * 设置告警规则
	 */
	setAlertRule(rule: IAlertRule): void;
	
	/**
	 * 移除告警规则
	 */
	removeAlertRule(ruleId: string): void;
	
	/**
	 * 获取活跃告警
	 */
	getActiveAlerts(): IAlert[];
	
	// === 事件 ===
	readonly onDidHealthChange: Event<IHealthChangeEvent>;
	readonly onDidAlertTriggered: Event<IAlertEvent>;
}

// ------------------------------------------------------------------------------------
// 数据类型定义
// ------------------------------------------------------------------------------------

export interface IHealthStatus {
	readonly instanceId: string;
	readonly status: HealthState;
	readonly score: number; // 0-100 健康评分
	readonly lastUpdated: number;
	readonly metrics: IInstanceMetrics;
	readonly alerts: IAlert[];
}

export const enum HealthState {
	Healthy = 'healthy',
	Warning = 'warning',
	Critical = 'critical',
	Unknown = 'unknown',
}

export interface IInstanceMetrics {
	readonly totalApiCalls: number;
	readonly successfulApiCalls: number;
	readonly failedApiCalls: number;
	readonly totalErrors: number;
	readonly fatalErrors: number;
	readonly averageResponseTime: number;
	readonly totalTokenUsage: { input: number; output: number };
	readonly activeTasks: number;
	readonly completedTasks: number;
	readonly failedTasks: number;
	readonly uptime: number; // 运行时间（ms）
}

export interface IMetricsSummary {
	readonly timeRange: ITimeRange;
	readonly totalApiCalls: number;
	readonly averageResponseTime: number;
	readonly errorRate: number; // 0-1
	readonly tokenUsage: { input: number; output: number };
	readonly tasks: {
		readonly total: number;
		readonly successful: number;
		readonly failed: number;
		readonly active: number;
	};
}

export interface ITimeRange {
	readonly startTime: number;
	readonly endTime: number;
}

export interface ISystemHealth {
	readonly overallScore: number; // 0-100
	readonly totalInstances: number;
	readonly healthyInstances: number;
	readonly warningInstances: number;
	readonly criticalInstances: number;
	readonly systemMetrics: ISystemMetrics;
}

export interface ISystemMetrics {
	readonly totalApiCalls: number;
	readonly totalErrors: number;
	readonly totalTokenUsage: { input: number; output: number };
	readonly averageResponseTime: number;
	readonly activeTasks: number;
}

// ------------------------------------------------------------------------------------
// 告警系统
// ------------------------------------------------------------------------------------

export interface IAlertRule {
	readonly id: string;
	readonly name: string;
	readonly instanceId?: string; // 如果未指定，适用于所有实例
	readonly condition: IAlertCondition;
	readonly severity: AlertSeverity;
	readonly message: string;
	readonly enabled: boolean;
}

export interface IAlertCondition {
	readonly metric: string; // 'errorRate', 'responseTime', 'tokenUsage', etc.
	readonly operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
	readonly threshold: number;
	readonly duration?: number; // 持续时间（ms），避免短暂波动
}

export const enum AlertSeverity {
	Info = 'info',
	Warning = 'warning',
	Error = 'error',
	Critical = 'critical',
}

export interface IAlert {
	readonly id: string;
	readonly ruleId: string;
	readonly instanceId: string;
	readonly severity: AlertSeverity;
	readonly message: string;
	readonly triggeredAt: number;
	readonly resolved: boolean;
	readonly resolvedAt?: number;
}

// ------------------------------------------------------------------------------------
// 事件类型
// ------------------------------------------------------------------------------------

export interface IHealthChangeEvent {
	readonly instanceId: string;
	readonly oldStatus: HealthState;
	readonly newStatus: HealthState;
	readonly metrics: IInstanceMetrics;
}

export interface IAlertEvent {
	readonly alert: IAlert;
	readonly type: 'triggered' | 'resolved';
}
