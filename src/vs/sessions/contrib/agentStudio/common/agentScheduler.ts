/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

// ------------------------------------------------------------------------------------
// 调度器服务接口
// ------------------------------------------------------------------------------------

export const IAgentSchedulerService = createDecorator<IAgentSchedulerService>('agentSchedulerService');

export interface IAgentSchedulerService {
	readonly _serviceBrand: undefined;

	// === Schedule 管理 ===
	
	/**
	 * 注册 Cron 定时任务
	 * @param config - 包含 cron 表达式、目标 Agent、输入模板
	 * @returns 可取消的 Disposable
	 */
	registerCron(config: ICronScheduleConfig): IScheduleHandle;
	
	/**
	 * 注册文件变化触发
	 * @param config - 包含 glob 模式、防抖时间、目标 Agent
	 */
	registerFileWatch(config: IFileWatchScheduleConfig): IScheduleHandle;
	
	/**
	 * 注册事件驱动触发（git push / terminal exit / build fail 等）
	 */
	registerEventTrigger(config: IEventTriggerConfig): IScheduleHandle;
	
	/**
	 * 注册一次性定时任务
	 */
	registerOneShot(config: IOneShotConfig): IScheduleHandle;
	
	/**
	 * 注册周期性间隔任务（比 cron 更简单的 setInterval 语义）
	 */
	registerInterval(config: IIntervalConfig): IScheduleHandle;
	
	// === 查询管理 ===
	
	/**
	 * 列出某个 Agent 的所有活跃 Schedule
	 */
	listSchedules(instanceId: string): IScheduleInfo[];
	
	/**
	 * 列出工作区内所有活跃 Schedule
	 */
	listAllSchedules(workspaceId: string): IScheduleInfo[];
	
	/**
	 * 暂停某个 Schedule（保留配置，不再触发）
	 */
	pauseSchedule(scheduleId: string): void;
	
	/**
	 * 恢复某个 Schedule
	 */
	resumeSchedule(scheduleId: string): void;
	
	/**
	 * 删除某个 Schedule
	 */
	removeSchedule(scheduleId: string): void;
	
	// === 执行历史 ===
	
	/**
	 * 获取某个 Schedule 的执行历史
	 */
	getExecutionHistory(scheduleId: string, options?: IHistoryQueryOptions): IScheduleExecution[];
	
	// === 事件 ===
	readonly onDidTrigger: Event<IScheduleTriggerEvent>;
	readonly onDidComplete: Event<IScheduleCompleteEvent>;
	readonly onDidError: Event<IScheduleErrorEvent>;
	readonly onDidScheduleChange: Event<IScheduleChangeEvent>;
}

// ------------------------------------------------------------------------------------
// 类型定义
// ------------------------------------------------------------------------------------

export type ScheduleType = 'cron' | 'file-watch' | 'event' | 'one-shot' | 'interval';

// ------------------------------------------------------------------------------------
// 配置类型定义
// ------------------------------------------------------------------------------------

// --- Cron 定时 ---
export interface ICronScheduleConfig {
	readonly id?: string;
	readonly name: string;
	readonly instanceId: string;           // 目标 Agent 实例
	readonly cronExpression: string;       // 标准 cron 表达式（5/6 字段）
	readonly timezone?: string;            // IANA 时区，默认系统本地
	readonly inputTemplate: IScheduleInput; // 触发时发送的输入
	readonly enabled?: boolean;            // 默认 true
	
	/** 有效期（可选），到期自动注销 */
	readonly validFrom?: number;
	readonly validUntil?: number;
	
	/** 执行策略 */
	readonly executionPolicy?: IScheduleExecutionPolicy;
}

// --- 文件监听触发 ---
export interface IFileWatchScheduleConfig {
	readonly id?: string;
	readonly name: string;
	readonly instanceId: string;
	readonly globPatterns: string[];       // e.g. ['src/**/*.ts', '!node_modules/**']
	readonly events: FileWatchEvent[];     // 'create' | 'change' | 'delete'
	readonly debounceMs?: number;          // 防抖时间，默认 2000ms
	readonly inputTemplate: IScheduleInput;
	readonly enabled?: boolean;
	readonly executionPolicy?: IScheduleExecutionPolicy;
}

export type FileWatchEvent = 'create' | 'change' | 'delete';

// --- 事件驱动触发 ---
export interface IEventTriggerConfig {
	readonly id?: string;
	readonly name: string;
	readonly instanceId: string;
	readonly eventType: AgentTriggerEventType;
	readonly filter?: IEventFilter;        // 可选过滤条件
	readonly inputTemplate: IScheduleInput;
	readonly enabled?: boolean;
	readonly executionPolicy?: IScheduleExecutionPolicy;
}

export const enum AgentTriggerEventType {
	/** Git push / commit / merge */
	GitPush = 'git:push',
	GitCommit = 'git:commit',
	GitMerge = 'git:merge',
	GitPullRequestOpen = 'git:pr-open',
	
	/** Terminal 事件 */
	TerminalCommandFail = 'terminal:command-fail',
	TerminalCommandComplete = 'terminal:command-complete',
	
	/** Build 事件 */
	BuildFail = 'build:fail',
	BuildSuccess = 'build:success',
	
	/** 工作区事件 */
	WorkspaceOpen = 'workspace:open',
	WorkspaceClose = 'workspace:close',
	
	/** Agent 间事件 */
	AgentTaskComplete = 'agent:task-complete',
	AgentError = 'agent:error',
	
	/** 外部 Webhook（从 Gateway 转发） */
	ExternalWebhook = 'external:webhook',
	
	/** 自定义事件 */
	Custom = 'custom',
}

// --- 一次性触发 ---
export interface IOneShotConfig {
	readonly id?: string;
	readonly name: string;
	readonly instanceId: string;
	readonly triggerAt: number;             // Unix timestamp
	readonly inputTemplate: IScheduleInput;
}

// --- 间隔触发 ---
export interface IIntervalConfig {
	readonly id?: string;
	readonly name: string;
	readonly instanceId: string;
	readonly intervalMs: number;           // 间隔毫秒
	readonly inputTemplate: IScheduleInput;
	readonly enabled?: boolean;
	readonly maxExecutions?: number;       // 最大执行次数，到达后自动注销
	readonly executionPolicy?: IScheduleExecutionPolicy;
}

// ------------------------------------------------------------------------------------
// 输入模板
// ------------------------------------------------------------------------------------

export interface IScheduleInput {
	/** 消息模板，支持变量插值 {{timestamp}}, {{event.detail}}, {{file.path}} */
	readonly messageTemplate: string;
	/** 附加上下文 */
	readonly context?: Record<string, unknown>;
	/** 是否静默执行（不在 Chat 面板显示） */
	readonly silent?: boolean;
	/** 超时（覆盖 Agent 默认超时） */
	readonly timeoutMs?: number;
}

// ------------------------------------------------------------------------------------
// 执行策略
// ------------------------------------------------------------------------------------

export interface IScheduleExecutionPolicy {
	/** 如果上次执行未完成，新触发如何处理 */
	readonly overlap: OverlapPolicy;
	/** 最大重试次数 */
	readonly maxRetries?: number;
	/** 连续失败 N 次后自动暂停 */
	readonly autoDisableAfterFailures?: number;
	/** 错误时是否通知用户 */
	readonly notifyOnError?: boolean;
	/** 成功时是否通知用户 */
	readonly notifyOnSuccess?: boolean;
}

export const enum OverlapPolicy {
	/** 跳过本次触发 */
	Skip = 'skip',
	/** 排队等待上次完成 */
	Queue = 'queue',
	/** 取消上次，执行本次 */
	Replace = 'replace',
	/** 并行执行 */
	Parallel = 'parallel',
}

// ------------------------------------------------------------------------------------
// 事件过滤器
// ------------------------------------------------------------------------------------

export interface IEventFilter {
	/** 文件路径匹配模式（用于 file-watch） */
	readonly filePattern?: string;
	/** Git 分支过滤 */
	readonly branch?: string;
	/** 自定义条件表达式 */
	readonly customCondition?: string;
}

// ------------------------------------------------------------------------------------
// Schedule Handle
// ------------------------------------------------------------------------------------

export interface IScheduleHandle extends IDisposable {
	readonly scheduleId: string;
	readonly type: ScheduleType;
	
	/** 暂停 */
	pause(): void;
	/** 恢复 */
	resume(): void;
	/** 手动触发一次（用于调试） */
	triggerNow(): Promise<void>;
	/** 获取下次预计触发时间 */
	getNextFireTime(): number | null;
}

// ------------------------------------------------------------------------------------
// 状态信息
// ------------------------------------------------------------------------------------

export interface IScheduleInfo {
	readonly id: string;
	readonly name: string;
	readonly type: ScheduleType;
	readonly instanceId: string;
	readonly state: ScheduleState;
	readonly createdAt: number;
	readonly lastTriggeredAt?: number;
	readonly lastCompletedAt?: number;
	readonly nextFireAt: number | null;
	readonly totalExecutions: number;
	readonly totalFailures: number;
	readonly config: ICronScheduleConfig | IFileWatchScheduleConfig | IEventTriggerConfig | IOneShotConfig | IIntervalConfig;
}

export const enum ScheduleState {
	Active = 'active',
	Paused = 'paused',
	Disabled = 'disabled',      // 自动禁用（连续失败）
	Expired = 'expired',        // 超过 validUntil
	Completed = 'completed',    // 一次性已执行
}

// ------------------------------------------------------------------------------------
// 执行历史
// ------------------------------------------------------------------------------------

export interface IHistoryQueryOptions {
	readonly limit?: number;
	readonly offset?: number;
	readonly startTime?: number;
	readonly endTime?: number;
}

export interface IScheduleExecution {
	readonly executionId: string;
	readonly scheduleId: string;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly status: ExecutionStatus;
	readonly error?: string;
	readonly retryCount: number;
	readonly tokenUsage?: {
		readonly input: number;
		readonly output: number;
	};
}

export const enum ExecutionStatus {
	Running = 'running',
	Success = 'success',
	Failed = 'failed',
	Cancelled = 'cancelled',
	TimedOut = 'timed-out',
}

// ------------------------------------------------------------------------------------
// 事件类型
// ------------------------------------------------------------------------------------

export interface IScheduleTriggerEvent {
	readonly scheduleId: string;
	readonly scheduleName: string;
	readonly instanceId: string;
	readonly triggeredAt: number;
	readonly input: IScheduleInput;
}

export interface IScheduleCompleteEvent {
	readonly scheduleId: string;
	readonly executionId: string;
	readonly success: boolean;
	readonly duration: number;
	readonly error?: string;
}

export interface IScheduleErrorEvent {
	readonly scheduleId: string;
	readonly error: string;
	readonly willRetry: boolean;
	readonly retryCount: number;
}

export interface IScheduleChangeEvent {
	readonly scheduleId: string;
	readonly changeType: 'created' | 'updated' | 'paused' | 'resumed' | 'removed';
}
