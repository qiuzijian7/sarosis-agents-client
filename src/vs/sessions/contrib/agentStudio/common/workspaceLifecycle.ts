/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

// ─── Workspace Lifecycle Service ────────────────────────────────
//
// 通用的"工作区生命周期事件总线"，用来在 AgentStudio 工作区被
// 创建 / 删除 / 更新时通知任意 *外部* 订阅方（typically：扩展端的
// Capability Plugin / Chat Provider / 外部 CLI 适配层），从而把诸如
// "调用某个 CLI 同步工作区" 这类副作用与 AgentStudioService 解耦。
//
// 设计原则：
//   1. 主仓库**不感知**任何具体 provider（knot / hermes / …）
//   2. 任意 provider 通过 `registerHook()` 自助登记钩子；
//      钩子既可以是**进程内回调**（同仓库 contribution），
//      也可以是**命令 ID 字符串**（扩展端命令，由本服务通过
//      ICommandService 路由）
//   3. 钩子失败不会回滚 workspace 的创建/删除 —— 只在 LogService 留痕
//
// 事件触发由 `AgentStudioService.createWorkspace` / `deleteWorkspace`
// 在底层数据落盘 *成功之后* 调用。

export const IWorkspaceLifecycleService = createDecorator<IWorkspaceLifecycleService>('workspaceLifecycleService');

/**
 * 工作区生命周期事件类型
 */
export const enum WorkspaceLifecycleEvent {
	Created = 'created',
	Deleted = 'deleted',
	Updated = 'updated',
}

/**
 * 钩子触发时传入的工作区快照（保持精简，不绑定到具体的 Workspace 类型，
 * 让 lifecycle 模块对 agentStudio 内部 Workspace shape 解耦）。
 */
export interface IWorkspaceLifecyclePayload {
	readonly id: string;
	readonly name: string;
	/** 工作区在用户磁盘上的根路径（如未指定则为 undefined） */
	readonly path?: string;
	/** 触发时间（ISO 字符串） */
	readonly timestamp: string;
}

/**
 * 进程内钩子。可以选择性地实现 onCreated / onDeleted / onUpdated。
 */
export interface IWorkspaceLifecycleHook {
	/** 用作日志和 dispose 时的标识（不强制全局唯一，但建议唯一） */
	readonly id: string;
	onCreated?(workspace: IWorkspaceLifecyclePayload): void | Promise<void>;
	onDeleted?(workspace: IWorkspaceLifecyclePayload): void | Promise<void>;
	onUpdated?(workspace: IWorkspaceLifecyclePayload): void | Promise<void>;
}

/**
 * 命令钩子。扩展端通过 `commands.executeCommand('agentStudio.workspaceLifecycle.register', spec)`
 * 把自己注册进来；本服务在事件发生时通过 ICommandService 路由调用对应命令。
 *
 * 命令被调用时唯一参数为 IWorkspaceLifecyclePayload。
 */
export interface IWorkspaceLifecycleCommandHook {
	readonly id: string;
	/** 命令 ID，发生 Created 事件时调用；缺省则跳过 Created */
	readonly onCreated?: string;
	/** 命令 ID，发生 Deleted 事件时调用；缺省则跳过 Deleted */
	readonly onDeleted?: string;
	/** 命令 ID，发生 Updated 事件时调用；缺省则跳过 Updated */
	readonly onUpdated?: string;
}

export interface IWorkspaceLifecycleService {
	readonly _serviceBrand: undefined;

	/**
	 * 注册一个进程内钩子；返回 IDisposable 以便取消订阅。
	 */
	registerHook(hook: IWorkspaceLifecycleHook): IDisposable;

	/**
	 * 注册一个命令钩子；返回 IDisposable 以便取消订阅。
	 *
	 * 注：命令在另一个进程（extension host）中执行；本服务只负责通过
	 * ICommandService 路由调用，并把异常吞掉。
	 */
	registerCommandHook(hook: IWorkspaceLifecycleCommandHook): IDisposable;

	/**
	 * 触发事件 —— 仅供 AgentStudioService 内部使用。
	 *
	 * 实现保证：
	 *   - 单事件内所有钩子并发触发
	 *   - 任何单个钩子的异常不会影响其他钩子
	 *   - 返回 Promise 在所有钩子 settled 后 resolve（成功/失败均可）
	 */
	fire(event: WorkspaceLifecycleEvent, payload: IWorkspaceLifecyclePayload): Promise<void>;

	/**
	 * 仅观察事件（不做副作用），方便其他 contribution 复用。
	 */
	readonly onDidFire: Event<{ event: WorkspaceLifecycleEvent; payload: IWorkspaceLifecyclePayload }>;
}
