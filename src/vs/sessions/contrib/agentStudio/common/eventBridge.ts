/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ------------------------------------------------------------------------------------------------
// eventBridge.ts - EventBridge 事件桥接服务
// ------------------------------------------------------------------------------------------------
//
// 功能: 统一管理和分发事件，支持事件注册、监听和触发
//
// EventBridge 允许不同组件之间通过事件进行通信，而不需要直接依赖。
// Scheduler 可以注册事件监听器，当事件触发时，自动执行对应的 Schedule。
//
// 使用示例:
// ```typescript
// // 注册事件监听器
// eventBridge.on('git:push', (event) => {
//     console.log('Git push detected', event);
// });
//
// // 触发事件
// eventBridge.emit('git:push', { repository: '...', branch: 'main' });
// ```

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// ------------------------------------------------------------------------------------------------
// 事件类型定义
// ------------------------------------------------------------------------------------------------

export interface IEventBridgeEvent {
	/** 事件类型 */
	type: string;
	/** 事件数据 */
	data?: any;
	/** 事件触发时间 */
	timestamp: number;
	/** 事件源 (可选) */
	source?: string;
}

export interface IEventBridgeService {
	readonly _serviceBrand: undefined;

	/** 事件: 当任何事件被触发时 */
	readonly onAnyEvent: Event<IEventBridgeEvent>;

	/**
	 * 注册事件监听器
	 * @param eventType 事件类型
	 * @param handler 事件处理函数
	 * @returns Disposable，用于取消注册
	 */
	on(eventType: string, handler: (event: IEventBridgeEvent) => void): IDisposable;

	/**
	 * 注册一次性事件监听器
	 * @param eventType 事件类型
	 * @param handler 事件处理函数
	 */
	once(eventType: string, handler: (event: IEventBridgeEvent) => void): void;

	/**
	 * 触发事件
	 * @param eventType 事件类型
	 * @param data 事件数据
	 * @param source 事件源 (可选)
	 */
	emit(eventType: string, data?: any, source?: string): void;

	/**
	 * 移除事件监听器
	 * @param eventType 事件类型
	 * @param handler 事件处理函数 (可选，如果不提供则移除所有监听器)
	 */
	off(eventType: string, handler?: (event: IEventBridgeEvent) => void): void;

	/**
	 * 获取所有已注册的事件类型
	 */
	getEventTypes(): string[];

	/**
	 * 获取指定事件类型的监听器数量
	 * @param eventType 事件类型
	 */
	getListenerCount(eventType: string): number;
}

// ------------------------------------------------------------------------------------------------
// 装饰器标识符 (用于依赖注入)
// ------------------------------------------------------------------------------------------------

export const IEventBridgeService = createDecorator<IEventBridgeService>('eventBridgeService');

// ------------------------------------------------------------------------------------------------
// EventBridge 服务实现
// ------------------------------------------------------------------------------------------------

export class EventBridgeService extends Disposable implements IEventBridgeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onAnyEvent: Emitter<IEventBridgeEvent>;
	readonly onAnyEvent: Event<IEventBridgeEvent>;

	// 存储所有事件监听器
	private readonly _listeners = new Map<string, Set<(event: IEventBridgeEvent) => void>>();

	constructor() {
		super();
		this._onAnyEvent = this._register(new Emitter<IEventBridgeEvent>());
		this.onAnyEvent = this._onAnyEvent.event;
	}

	// ------------------------------------------------------------------------------------------------
	// 公开方法
	// ------------------------------------------------------------------------------------------------

	on(eventType: string, handler: (event: IEventBridgeEvent) => void): IDisposable {
		if (!this._listeners.has(eventType)) {
			this._listeners.set(eventType, new Set());
		}

		const handlers = this._listeners.get(eventType)!;
		handlers.add(handler);

		// 返回 Disposable，用于取消注册
		return {
			dispose: () => {
				handlers.delete(handler);
				if (handlers.size === 0) {
					this._listeners.delete(eventType);
				}
			}
		};
	}

	once(eventType: string, handler: (event: IEventBridgeEvent) => void): void {
		const disposable = this.on(eventType, (event) => {
			handler(event);
			disposable.dispose();
		});
	}

	emit(eventType: string, data?: any, source?: string): void {
		const event: IEventBridgeEvent = {
			type: eventType,
			data,
			timestamp: Date.now(),
			source
		};

		// 触发特定事件类型的监听器
		const handlers = this._listeners.get(eventType);
		if (handlers) {
			for (const handler of handlers) {
				try {
					handler(event);
				} catch (error) {
					console.error(`[EventBridge] Error in event handler for ${eventType}:`, error);
				}
			}
		}

		// 触发通配符监听器
		const wildcardHandlers = this._listeners.get('*');
		if (wildcardHandlers) {
			for (const handler of wildcardHandlers) {
				try {
					handler(event);
				} catch (error) {
					console.error(`[EventBridge] Error in wildcard handler:`, error);
				}
			}
		}

		// 触发 onAnyEvent 事件
		this._onAnyEvent.fire(event);
	}

	off(eventType: string, handler?: (event: IEventBridgeEvent) => void): void {
		const handlers = this._listeners.get(eventType);
		if (!handlers) {
			return;
		}

		if (handler) {
			// 移除特定的监听器
			handlers.delete(handler);
			if (handlers.size === 0) {
				this._listeners.delete(eventType);
			}
		} else {
			// 移除所有监听器
			this._listeners.delete(eventType);
		}
	}

	getEventTypes(): string[] {
		return Array.from(this._listeners.keys());
	}

	getListenerCount(eventType: string): number {
		const handlers = this._listeners.get(eventType);
		return handlers ? handlers.size : 0;
	}
}

// ------------------------------------------------------------------------------------------------
// 预定义事件类型 (辅助常量)
// ------------------------------------------------------------------------------------------------

export const AgentTriggerEventType = {
	// Git 事件
	GitPush: 'git:push',
	GitCommit: 'git:commit',
	GitMerge: 'git:merge',
	GitBranchCreate: 'git:branch:create',
	GitBranchDelete: 'git:branch:delete',

	// Terminal 事件
	TerminalCommandStart: 'terminal:command:start',
	TerminalCommandComplete: 'terminal:command:complete',
	TerminalCommandFail: 'terminal:command:fail',
	TerminalClose: 'terminal:close',

	// Build 事件
	BuildStart: 'build:start',
	BuildSuccess: 'build:success',
	BuildFail: 'build:fail',

	// Workspace 事件
	WorkspaceOpen: 'workspace:open',
	WorkspaceClose: 'workspace:close',
	WorkspaceFolderAdd: 'workspace:folder:add',
	WorkspaceFolderRemove: 'workspace:folder:remove',

	// Agent 事件
	AgentTaskStart: 'agent:task:start',
	AgentTaskComplete: 'agent:task:complete',
	AgentError: 'agent:error',
	AgentMessage: 'agent:message',

	// File 事件
	FileCreate: 'file:create',
	FileChange: 'file:change',
	FileDelete: 'file:delete',

	// Custom 事件
	Custom: 'custom',
} as const;

// ------------------------------------------------------------------------------------------------
// 导出
// ------------------------------------------------------------------------------------------------

export default EventBridgeService;
