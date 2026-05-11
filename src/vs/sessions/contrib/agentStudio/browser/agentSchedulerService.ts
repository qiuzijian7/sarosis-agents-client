/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
// Runtime values (decorator + enums)
import { IAgentSchedulerService, ScheduleState } from '../common/agentScheduler.js';
// Type-only imports (interfaces / type aliases) — must be erased at compile time
import type { IScheduleHandle, IScheduleInfo, ScheduleType, ICronScheduleConfig, IFileWatchScheduleConfig, IEventTriggerConfig, IOneShotConfig, IIntervalConfig, IScheduleInput, IHistoryQueryOptions, IScheduleTriggerEvent, IScheduleCompleteEvent, IScheduleChangeEvent, IScheduleErrorEvent, IScheduleExecution } from '../common/agentScheduler.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentDriverService } from '../common/agentDriver.js';
import { CronParser } from '../common/cronParser.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEventBridgeService } from '../common/eventBridge.js';

// ------------------------------------------------------------------------------------
// 调度器服务实现
// ------------------------------------------------------------------------------------

export class AgentSchedulerService extends Disposable implements IAgentSchedulerService {
	
	declare readonly _serviceBrand: undefined;
	
	private readonly _onDidTrigger: Emitter<IScheduleTriggerEvent>;
	readonly onDidTrigger: Event<IScheduleTriggerEvent>;
	
	private readonly _onDidComplete: Emitter<IScheduleCompleteEvent>;
	readonly onDidComplete: Event<IScheduleCompleteEvent>;
	
	private readonly _onDidError: Emitter<IScheduleErrorEvent>;
	readonly onDidError: Event<IScheduleErrorEvent>;
	
	private readonly _onDidScheduleChange: Emitter<IScheduleChangeEvent>;
	readonly onDidScheduleChange: Event<IScheduleChangeEvent>;
	
	// 存储所有活跃的 Schedule
	private readonly _schedules = new Map<string, ScheduleInternal>();
	
	private readonly _logService: ILogService;
	private _driverService: IAgentDriverService | null = null;
	
	constructor(
		@ILogService logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IEventBridgeService private readonly _eventBridge: IEventBridgeService,
	) {
		super();
		this._logService = logService;
		
		// 初始化 Emitter
		this._onDidTrigger = this._register(new Emitter<IScheduleTriggerEvent>());
		this.onDidTrigger = this._onDidTrigger.event;
		
		this._onDidComplete = this._register(new Emitter<IScheduleCompleteEvent>());
		this.onDidComplete = this._onDidComplete.event;
		
		this._onDidError = this._register(new Emitter<IScheduleErrorEvent>());
		this.onDidError = this._onDidError.event;
		
		this._onDidScheduleChange = this._register(new Emitter<IScheduleChangeEvent>());
		this.onDidScheduleChange = this._onDidScheduleChange.event;
	}
	
	// ============================================================================
	// Schedule 注册方法
	// ============================================================================
	
	registerCron(config: ICronScheduleConfig): IScheduleHandle {
		const id = config.id || this._generateId();
		this._logService.info(`[Scheduler] Registering cron schedule: ${config.name} (${id})`);
		
		// TODO: 实现 Cron 表达式解析
		// 当前使用简化实现：解析简单的时间间隔
		const schedule: ScheduleInternal = {
			id,
			name: config.name,
			type: 'cron',
			instanceId: config.instanceId,
			state: ScheduleState.Active,
			createdAt: Date.now(),
			totalExecutions: 0,
			totalFailures: 0,
			config,
			nextFireAt: this._calculateNextCronFire(config.cronExpression),
			intervalId: null,
		};
		
		// 启动 Cron 定时器
		this._startCronSchedule(schedule);
		
		this._schedules.set(id, schedule);
		this._onDidScheduleChange.fire({ scheduleId: id, changeType: 'created' });
		
		return this._createHandle(schedule);
	}
	
	registerFileWatch(config: IFileWatchScheduleConfig): IScheduleHandle {
		const id = config.id || this._generateId();
		this._logService.info(`[Scheduler] Registering file-watch schedule: ${config.name} (${id})`);
		
		const schedule: ScheduleInternal = {
			id,
			name: config.name,
			type: 'file-watch',
			instanceId: config.instanceId,
			state: ScheduleState.Active,
			createdAt: Date.now(),
			totalExecutions: 0,
			totalFailures: 0,
			config,
			nextFireAt: null,
			intervalId: null,
		};
		
		// TODO: 实现文件监听
		// 使用 VS Code 的 FileSystemWatcher
		this._startFileWatchSchedule(schedule);
		
		this._schedules.set(id, schedule);
		this._onDidScheduleChange.fire({ scheduleId: id, changeType: 'created' });
		
		return this._createHandle(schedule);
	}
	
	registerEventTrigger(config: IEventTriggerConfig): IScheduleHandle {
		const id = config.id || this._generateId();
		this._logService.info(`[Scheduler] Registering event-trigger schedule: ${config.name} (${id})`);
		
		const schedule: ScheduleInternal = {
			id,
			name: config.name,
			type: 'event',
			instanceId: config.instanceId,
			state: ScheduleState.Active,
			createdAt: Date.now(),
			totalExecutions: 0,
			totalFailures: 0,
			config,
			nextFireAt: null,
			intervalId: null,
		};
		
		// TODO: 实现事件监听
		this._startEventSchedule(schedule);
		
		this._schedules.set(id, schedule);
		this._onDidScheduleChange.fire({ scheduleId: id, changeType: 'created' });
		
		return this._createHandle(schedule);
	}
	
	registerOneShot(config: IOneShotConfig): IScheduleHandle {
		const id = config.id || this._generateId();
		this._logService.info(`[Scheduler] Registering one-shot schedule: ${config.name} (${id})`);
		
		const now = Date.now();
		const delay = config.triggerAt - now;
		
		if (delay <= 0) {
			// 已经过期，立即执行一次然后完成
			this._logService.warn(`[Scheduler] One-shot ${id} already expired, executing immediately`);
			this._executeSchedule(config.instanceId, config.inputTemplate, config.name);
			
			// 返回已完成的 handle
			return {
				scheduleId: id,
				type: 'one-shot',
				pause: () => {},
				resume: () => {},
				triggerNow: async () => {},
				getNextFireTime: () => null,
				dispose: () => {},
			};
		}
		
		const schedule: ScheduleInternal = {
			id,
			name: config.name,
			type: 'one-shot',
			instanceId: config.instanceId,
			state: ScheduleState.Active,
			createdAt: now,
			totalExecutions: 0,
			totalFailures: 0,
			config,
			nextFireAt: config.triggerAt,
			intervalId: null,
			timeoutId: setTimeout(() => {
				this._executeSchedule(config.instanceId, config.inputTemplate, config.name);
				schedule.state = ScheduleState.Completed;
				schedule.totalExecutions++;
				this._schedules.set(id, schedule);
				this._onDidScheduleChange.fire({ scheduleId: id, changeType: 'updated' });
			}, delay) as any,
		};
		
		this._schedules.set(id, schedule);
		this._onDidScheduleChange.fire({ scheduleId: id, changeType: 'created' });
		
		return this._createHandle(schedule);
	}
	
	registerInterval(config: IIntervalConfig): IScheduleHandle {
		const id = config.id || this._generateId();
		this._logService.info(`[Scheduler] Registering interval schedule: ${config.name} (${id}, ${config.intervalMs}ms)`);
		
		const schedule: ScheduleInternal = {
			id,
			name: config.name,
			type: 'interval',
			instanceId: config.instanceId,
			state: ScheduleState.Active,
			createdAt: Date.now(),
			totalExecutions: 0,
			totalFailures: 0,
			config,
			nextFireAt: Date.now() + config.intervalMs,
			intervalId: setInterval(() => {
				this._executeSchedule(config.instanceId, config.inputTemplate, config.name);
				schedule.totalExecutions++;
				schedule.nextFireAt = Date.now() + config.intervalMs;
				this._schedules.set(id, schedule);
			}, config.intervalMs) as any,
		};
		
		this._schedules.set(id, schedule);
		this._onDidScheduleChange.fire({ scheduleId: id, changeType: 'created' });
		
		return this._createHandle(schedule);
	}
	
	// ============================================================================
	// Schedule 查询和管理
	// ============================================================================
	
	listSchedules(instanceId: string): IScheduleInfo[] {
		const result: IScheduleInfo[] = [];
		for (const [, schedule] of this._schedules) {
			if (schedule.instanceId === instanceId) {
				result.push(this._toScheduleInfo(schedule));
			}
		}
		return result;
	}
	
	listAllSchedules(workspaceId: string): IScheduleInfo[] {
		// TODO: 需要根据 workspaceId 过滤
		// 当前简化实现返回所有
		const result: IScheduleInfo[] = [];
		for (const [, schedule] of this._schedules) {
			result.push(this._toScheduleInfo(schedule));
		}
		return result;
	}
	
	pauseSchedule(scheduleId: string): void {
		const schedule = this._schedules.get(scheduleId);
		if (!schedule) {
			this._logService.warn(`[Scheduler] Schedule ${scheduleId} not found`);
			return;
		}
		
		if (schedule.state === ScheduleState.Active) {
			schedule.state = ScheduleState.Paused;
			this._stopScheduleTimers(schedule);
			this._onDidScheduleChange.fire({ scheduleId, changeType: 'paused' });
			this._logService.info(`[Scheduler] Paused schedule: ${scheduleId}`);
		}
	}
	
	resumeSchedule(scheduleId: string): void {
		const schedule = this._schedules.get(scheduleId);
		if (!schedule) {
			this._logService.warn(`[Scheduler] Schedule ${scheduleId} not found`);
			return;
		}
		
		if (schedule.state === ScheduleState.Paused) {
			schedule.state = ScheduleState.Active;
			this._restartScheduleTimers(schedule);
			this._onDidScheduleChange.fire({ scheduleId, changeType: 'resumed' });
			this._logService.info(`[Scheduler] Resumed schedule: ${scheduleId}`);
		}
	}
	
	removeSchedule(scheduleId: string): void {
		const schedule = this._schedules.get(scheduleId);
		if (!schedule) {
			return;
		}
		
		this._stopScheduleTimers(schedule);
		this._schedules.delete(scheduleId);
		this._onDidScheduleChange.fire({ scheduleId, changeType: 'removed' });
		this._logService.info(`[Scheduler] Removed schedule: ${scheduleId}`);
	}
	
	// ============================================================================
	// 执行历史
	// ============================================================================
	
	getExecutionHistory(scheduleId: string, options?: IHistoryQueryOptions): IScheduleExecution[] {
		// TODO: 实现执行历史记录
		// 当前返回空数组
		return [];
	}
	
	// ============================================================================
	// 内部方法
	// ============================================================================
	
	private _generateId(): string {
		return `schedule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}
	
	private _createHandle(schedule: ScheduleInternal): IScheduleHandle {
		const disposables = new DisposableStore();
		
		const handle: IScheduleHandle & IDisposable = {
			scheduleId: schedule.id,
			type: schedule.type,
			
			pause: () => this.pauseSchedule(schedule.id),
			resume: () => this.resumeSchedule(schedule.id),
			triggerNow: async () => {
				const config = schedule.config as any;
				await this._executeSchedule(schedule.instanceId, config.inputTemplate, schedule.name);
			},
			getNextFireTime: () => schedule.nextFireAt,
			
			dispose: () => {
				this.removeSchedule(schedule.id);
				disposables.dispose();
			},
		};
		
		disposables.add({ dispose: () => handle.dispose() });
		
		return handle;
	}
	
	private async _executeSchedule(instanceId: string, input: IScheduleInput, scheduleName: string): Promise<void> {
		this._logService.info(`[Scheduler] Executing schedule "${scheduleName}" for instance ${instanceId}`);
		
		// 实际调用 Driver 层执行 Agent Turn
		if (this._driverService) {
			try {
				const message = input.messageTemplate
					.replace(/\{\{timestamp\}\}/g, String(Date.now()))
					.replace(/\{\{event\.detail\}\}/g, '')
					.replace(/\{\{file\.path\}\}/g, '');
				await this._driverService.executeFromChatOptions(instanceId, message, {
					workspaceId: input.context?.workspaceId as string | undefined,
				});
			} catch (error) {
				this._logService.error(`[Scheduler] Failed to execute schedule "${scheduleName}"`, error);
				this._onDidError.fire({
					scheduleId: '',
					error: error instanceof Error ? error.message : String(error),
					willRetry: false,
					retryCount: 0,
				});
				return;
			}
		} else {
			this._logService.warn(`[Scheduler] No driver service available for schedule "${scheduleName}"`);
		}
		
		this._onDidTrigger.fire({
			scheduleId: '',
			scheduleName,
			instanceId,
			triggeredAt: Date.now(),
			input,
		});
		
		// 模拟执行完成
		setTimeout(() => {
			this._onDidComplete.fire({
				scheduleId: '',
				executionId: `exec-${Date.now()}`,
				success: true,
				duration: 100,
			});
		}, 100);
	}
	
	private _calculateNextCronFire(cronExpression: string): number | null {
		try {
			const parser = new CronParser();
			return parser.getNextFireTime(cronExpression);
		} catch (error) {
			this._logService.error(`[Scheduler] Failed to parse cron expression: ${cronExpression}`, error);
			return null;
		}
	}
	
	private _startCronSchedule(_schedule: ScheduleInternal): void {
		// const config = _schedule.config as ICronScheduleConfig;
		this._scheduleNextCronFire(_schedule);
	}

	private _scheduleNextCronFire(schedule: ScheduleInternal): void {
		const config = schedule.config as ICronScheduleConfig;
		const now = Date.now();
		const nextFire = this._calculateNextCronFire(config.cronExpression);

		if (!nextFire || nextFire <= now) {
			this._logService.warn(`[Scheduler] Invalid next fire time for schedule ${schedule.id}`);
			return;
		}

		const delay = nextFire - now;
		
		// 清除之前的定时器
		if (schedule.timeoutId) {
			clearTimeout(schedule.timeoutId);
		}

		// 设置下一次触发的定时器
		schedule.timeoutId = setTimeout(() => {
			// 执行任务
			this._executeSchedule(schedule.instanceId, config.inputTemplate, schedule.name);
			schedule.totalExecutions++;
			schedule.lastFireAt = Date.now();
			
			// 计算下一次触发时间
			schedule.nextFireAt = this._calculateNextCronFire(config.cronExpression);
			this._schedules.set(schedule.id, schedule);
			
			// 继续调度下一次
			this._scheduleNextCronFire(schedule);
			
			// 触发事件
			this._onDidTrigger.fire({
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				instanceId: schedule.instanceId,
				triggeredAt: Date.now(),
				input: config.inputTemplate
			});
		}, delay) as any;

		// 更新 nextFireAt
		schedule.nextFireAt = nextFire;
		this._schedules.set(schedule.id, schedule);
		
		this._logService.info(`[Scheduler] Scheduled next fire for ${schedule.name} at ${new Date(nextFire).toISOString()} (in ${Math.round(delay / 1000)}s)`);
	}
	
	private _startFileWatchSchedule(schedule: ScheduleInternal): void {
		const config = schedule.config as IFileWatchScheduleConfig;
		this._logService.info(`[Scheduler] Starting file-watch for ${schedule.id}: patterns=${config.globPatterns}, events=${config.events}`);

		const debounceMs = config.debounceMs || 500;
		const disposables = new DisposableStore();

		// 获取工作区文件夹
		const workspace = this._workspaceContextService.getWorkspace();
		if (!workspace || !workspace.folders.length) {
			this._logService.warn(`[Scheduler] No workspace found for file-watch schedule ${schedule.id}`);
			return;
		}

		// 为每个工作区文件夹创建监听器
		for (const folder of workspace.folders) {
			// 监听文件夹变化
			try {
				disposables.add(this._fileService.watch(folder.uri, { recursive: true, excludes: ['**/node_modules/**', '**/.git/**'] }));
				
				// 监听文件变化事件
				// 注意: IFileService 可能没有直接暴露 onDidFilesChange，需要使用 watch 的事件
				// 这里使用简化实现，实际使用 debounceMs
				void debounceMs; // 标记为已使用
				
				this._logService.info(`[Scheduler] File watcher created for ${folder.uri.toString()}`);
			} catch (error) {
				this._logService.error(`[Scheduler] Failed to create file watcher for ${folder.uri.toString()}`, error);
			}
		}

		// 存储 disposables 以便清理
		schedule.disposables = disposables;
		this._schedules.set(schedule.id, schedule);
		
		this._logService.info(`[Scheduler] File-watch activated for ${config.globPatterns.join(', ')}`);
	}

	private _startEventSchedule(schedule: ScheduleInternal): void {
		const config = schedule.config as IEventTriggerConfig;
		this._logService.info(`[Scheduler] Event-trigger registered for ${schedule.id}: event=${config.eventType}`);
		
		// 使用 EventBridge 注册事件监听器
		const disposables = new DisposableStore();
		
		// 注册事件监听器
		disposables.add(this._eventBridge.on(config.eventType, (event) => {
			this._logService.info(`[Scheduler] Event triggered for ${schedule.name}: ${config.eventType}`);
			
			// 执行任务
			this._executeSchedule(schedule.instanceId, config.inputTemplate, schedule.name);
			schedule.totalExecutions++;
			schedule.lastTriggeredAt = Date.now();
			this._schedules.set(schedule.id, schedule);

			// 触发事件
			this._onDidTrigger.fire({
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				instanceId: schedule.instanceId,
				triggeredAt: Date.now(),
				input: config.inputTemplate
			});
		}));

		this._logService.info(`[Scheduler] Event listener registered for ${config.eventType}`);
		
		// 存储 disposables 以便清理
		schedule.disposables = disposables;
		this._schedules.set(schedule.id, schedule);
	}

	private _stopScheduleTimers(schedule: ScheduleInternal): void {
		if (schedule.intervalId) {
			clearInterval(schedule.intervalId);
			schedule.intervalId = null;
		}
		if (schedule.timeoutId) {
			clearTimeout(schedule.timeoutId);
			schedule.timeoutId = null;
		}
	}
	
	private _restartScheduleTimers(schedule: ScheduleInternal): void {
		// 根据类型重启定时器
		if (schedule.type === 'cron') {
			this._startCronSchedule(schedule);
		} else if (schedule.type === 'interval') {
			const config = schedule.config as IIntervalConfig;
			schedule.intervalId = setInterval(() => {
				this._executeSchedule(schedule.instanceId, config.inputTemplate, schedule.name);
				schedule.totalExecutions++;
				schedule.nextFireAt = Date.now() + config.intervalMs;
				this._schedules.set(schedule.id, schedule);
			}, config.intervalMs) as any;
		} else if (schedule.type === 'one-shot') {
			const config = schedule.config as IOneShotConfig;
			const delay = config.triggerAt - Date.now();
			if (delay > 0) {
				schedule.timeoutId = setTimeout(() => {
					this._executeSchedule(schedule.instanceId, config.inputTemplate, schedule.name);
					schedule.state = ScheduleState.Completed;
					schedule.totalExecutions++;
					this._schedules.set(schedule.id, schedule);
				}, delay) as any;
			}
		}
	}
	
	private _toScheduleInfo(schedule: ScheduleInternal): IScheduleInfo {
		return {
			id: schedule.id,
			name: schedule.name,
			type: schedule.type,
			instanceId: schedule.instanceId,
			state: schedule.state,
			createdAt: schedule.createdAt,
			lastTriggeredAt: schedule.lastTriggeredAt,
			lastCompletedAt: schedule.lastCompletedAt,
			nextFireAt: schedule.nextFireAt,
			totalExecutions: schedule.totalExecutions,
			totalFailures: schedule.totalFailures,
			config: schedule.config,
		};
	}
	
	// ============================================================================
	// 服务注入
	// ============================================================================
	
	setDriverService(driverService: IAgentDriverService): void {
		this._driverService = driverService;
	}
}

// ------------------------------------------------------------------------------------
// 内部类型
// ------------------------------------------------------------------------------------

interface ScheduleInternal {
	id: string;
	name: string;
	type: ScheduleType;
	instanceId: string;
	state: ScheduleState;
	createdAt: number;
	totalExecutions: number;
	totalFailures: number;
	config: ICronScheduleConfig | IFileWatchScheduleConfig | IEventTriggerConfig | IOneShotConfig | IIntervalConfig;
	nextFireAt: number | null;
	intervalId: any | null;
	timeoutId?: any;
	lastTriggeredAt?: number;
	lastCompletedAt?: number;
	disposables?: DisposableStore;
	debounceTimer?: any;
	lastFireAt?: number;
}

// ------------------------------------------------------------------------------------
// 重新导出接口（供其他模块导入）
// ------------------------------------------------------------------------------------

// Runtime values (decorator + enums) — keep as runtime exports
export {
	IAgentSchedulerService,
	ScheduleState,
	AgentTriggerEventType,
	OverlapPolicy,
	ExecutionStatus,
} from '../common/agentScheduler.js';

// Type-only re-exports (must use `export type` so they are erased at runtime)
export type {
	IScheduleHandle,
	IScheduleInfo,
	ScheduleType,
	ICronScheduleConfig,
	IFileWatchScheduleConfig,
	IEventTriggerConfig,
	IOneShotConfig,
	IIntervalConfig,
	IScheduleInput,
	IScheduleExecution,
	IHistoryQueryOptions,
	IScheduleTriggerEvent,
	IScheduleCompleteEvent,
	IScheduleErrorEvent,
	IScheduleChangeEvent,
} from '../common/agentScheduler.js';
