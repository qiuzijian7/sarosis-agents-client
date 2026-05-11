/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentSchedulerService } from '../common/agentScheduler.js';
import type { ICronScheduleConfig, IFileWatchScheduleConfig, IEventTriggerConfig, IOneShotConfig, IIntervalConfig } from '../common/agentScheduler.js';
import { ILogService } from '../../../../platform/log/common/log.js';

// ------------------------------------------------------------------------------------
// agent.yaml 解析器
// ------------------------------------------------------------------------------------

export interface IAgentYaml {
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly model?: string;
	readonly tools?: string[];
	readonly schedules?: IAgentYamlSchedule[];
}

export interface IAgentYamlSchedule {
	readonly name: string;
	readonly type: 'cron' | 'file-watch' | 'event' | 'one-shot' | 'interval';
	readonly enabled?: boolean;
	readonly cron?: string;
	readonly timezone?: string;
	readonly globPatterns?: string[];
	readonly events?: string[];
	readonly eventType?: string;
	readonly triggerAt?: number;
	readonly intervalMs?: number;
	readonly input?: {
		readonly messageTemplate: string;
		readonly context?: Record<string, unknown>;
		readonly silent?: boolean;
		readonly timeoutMs?: number;
	};
	readonly executionPolicy?: {
		readonly overlap: string;
		readonly maxRetries?: number;
		readonly autoDisableAfterFailures?: number;
	};
}

// ------------------------------------------------------------------------------------
// 解析器类
// ------------------------------------------------------------------------------------

export class AgentYamlParser {
	
	private readonly _logService: ILogService;
	private _schedulerService?: IAgentSchedulerService;
	
	constructor(logService: ILogService) {
		this._logService = logService;
	}
	
	// ============================================================================
	// 公共方法
	// ============================================================================
	
	/**
	 * 解析 agent.yaml 内容并注册 Schedule
	 * @param content YAML 文件内容
	 * @param instanceId Agent 实例 ID
	 * @param schedulerService Scheduler 服务
	 */
	parseAndRegisterSchedules(
		content: string,
		instanceId: string,
		schedulerService: IAgentSchedulerService,
	): void {
		this._schedulerService = schedulerService;
		
		try {
			const yaml = this._parseYaml(content);
			
			if (!yaml.schedules || yaml.schedules.length === 0) {
				this._logService.info('[AgentYaml] No schedules found in agent.yaml');
				return;
			}
			
			for (const schedule of yaml.schedules) {
				if (schedule.enabled === false) {
					this._logService.info(`[AgentYaml] Schedule "${schedule.name}" is disabled, skipping`);
					continue;
				}
				
				this._registerSchedule(schedule, instanceId);
			}
			
		} catch (error) {
			this._logService.error('[AgentYaml] Failed to parse agent.yaml:', error);
		}
	}
	
	// ============================================================================
	// 私有方法
	// ============================================================================
	
	/**
	 * 简单的 YAML 解析器（支持基本格式）
	 * 注意：这是简化实现，生产环境应使用专业的 YAML 解析库
	 */
	private _parseYaml(content: string): IAgentYaml {
		// 简化实现：将 YAML 转换为 JSOn（仅支持基本格式）
		// 生产环境应使用 js-yaml 或 VS Code 内置的 YAML 解析
		
		const lines = content.split('\n');
		const result: any = {};
		let currentSchedules: any[] | null = null;
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			
			// 跳过注释和空行
			if (trimmed.startsWith('#') || trimmed === '') {
				continue;
			}
			
			// 解析顶级字段
			if (trimmed.includes(':')) {
				const [key, ...valueParts] = trimmed.split(':');
				const value = valueParts.join(':').trim();
				
				if (key.trim() === 'schedules') {
					// 开始解析 schedules 数组
					currentSchedules = [];
					result.schedules = currentSchedules;
				} else if (currentSchedules === null) {
					// 顶级字段
					result[key.trim()] = value || undefined;
				}
			}
		}
		
		// TODO: 完整实现 YAML 解析
		// 当前返回空对象，等待完善
		
		return result as IAgentYaml;
	}
	
	/**
	 * 注册单个 Schedule
	 */
	private _registerSchedule(schedule: IAgentYamlSchedule, instanceId: string): void {
		if (!this._schedulerService) {
			this._logService.error('[AgentYaml] Scheduler service not set');
			return;
		}
		
		try {
			switch (schedule.type) {
				case 'cron':
					this._registerCronSchedule(schedule, instanceId);
					break;
				case 'file-watch':
					this._registerFileWatchSchedule(schedule, instanceId);
					break;
				case 'event':
					this._registerEventSchedule(schedule, instanceId);
					break;
				case 'one-shot':
					this._registerOneShotSchedule(schedule, instanceId);
					break;
				case 'interval':
					this._registerIntervalSchedule(schedule, instanceId);
					break;
				default:
					this._logService.warn(`[AgentYaml] Unknown schedule type: ${schedule.type}`);
			}
		} catch (error) {
			this._logService.error(`[AgentYaml] Failed to register schedule "${schedule.name}":`, error);
		}
	}
	
	private _registerCronSchedule(schedule: IAgentYamlSchedule, instanceId: string): void {
		if (!schedule.cron) {
			this._logService.warn(`[AgentYaml] Cron schedule "${schedule.name}" missing cron expression`);
			return;
		}
		
		const config: ICronScheduleConfig = {
			name: schedule.name,
			instanceId,
			cronExpression: schedule.cron,
			timezone: schedule.timezone,
			inputTemplate: schedule.input || { messageTemplate: '' },
			enabled: true,
		};
		
		if (this._schedulerService) {
			this._schedulerService.registerCron(config);
			this._logService.info(`[AgentYaml] Registered cron schedule: ${schedule.name}`);
		}
	}
	
	private _registerFileWatchSchedule(schedule: IAgentYamlSchedule, instanceId: string): void {
		if (!schedule.globPatterns || schedule.globPatterns.length === 0) {
			this._logService.warn(`[AgentYaml] File-watch schedule "${schedule.name}" missing glob patterns`);
			return;
		}
		
		const events = (schedule.events || ['change']) as any;
		
		const config: IFileWatchScheduleConfig = {
			name: schedule.name,
			instanceId,
			globPatterns: schedule.globPatterns,
			events,
			inputTemplate: schedule.input || { messageTemplate: '' },
			enabled: true,
		};
		
		if (this._schedulerService) {
			this._schedulerService.registerFileWatch(config);
			this._logService.info(`[AgentYaml] Registered file-watch schedule: ${schedule.name}`);
		}
	}
	
	private _registerEventSchedule(schedule: IAgentYamlSchedule, instanceId: string): void {
		if (!schedule.eventType) {
			this._logService.warn(`[AgentYaml] Event schedule "${schedule.name}" missing event type`);
			return;
		}
		
		const config: IEventTriggerConfig = {
			name: schedule.name,
			instanceId,
			eventType: schedule.eventType as any,
			inputTemplate: schedule.input || { messageTemplate: '' },
			enabled: true,
		};
		
		if (this._schedulerService) {
			this._schedulerService.registerEventTrigger(config);
			this._logService.info(`[AgentYaml] Registered event schedule: ${schedule.name}`);
		}
	}
	
	private _registerOneShotSchedule(schedule: IAgentYamlSchedule, instanceId: string): void {
		if (!schedule.triggerAt) {
			this._logService.warn(`[AgentYaml] One-shot schedule "${schedule.name}" missing trigger time`);
			return;
		}
		
		const config: IOneShotConfig = {
			name: schedule.name,
			instanceId,
			triggerAt: schedule.triggerAt,
			inputTemplate: schedule.input || { messageTemplate: '' },
		};
		
		if (this._schedulerService) {
			this._schedulerService.registerOneShot(config);
			this._logService.info(`[AgentYaml] Registered one-shot schedule: ${schedule.name}`);
		}
	}
	
	private _registerIntervalSchedule(schedule: IAgentYamlSchedule, instanceId: string): void {
		if (!schedule.intervalMs) {
			this._logService.warn(`[AgentYaml] Interval schedule "${schedule.name}" missing interval`);
			return;
		}
		
		const config: IIntervalConfig = {
			name: schedule.name,
			instanceId,
			intervalMs: schedule.intervalMs,
			inputTemplate: schedule.input || { messageTemplate: '' },
			enabled: true,
		};
		
		if (this._schedulerService) {
			this._schedulerService.registerInterval(config);
			this._logService.info(`[AgentYaml] Registered interval schedule: ${schedule.name}`);
		}
	}
}
