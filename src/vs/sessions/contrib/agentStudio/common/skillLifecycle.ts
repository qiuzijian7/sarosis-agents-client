/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

// ─── Skill Lifecycle Service ────────────────────────────────
//
// 通用的"技能生命周期事件总线"，用来在 Agent 实例的 skill 列表
// 发生变更（添加 / 移除 / 批量同步）时通知任意外部订阅方。
//
// 设计原则与 IWorkspaceLifecycleService 一致：
//   1. 主仓库**不感知**任何具体 provider（knot / hermes / …）
//   2. 任意 provider 通过 `registerCommandHook()` 自助登记钩子；
//      钩子是**命令 ID 字符串**（扩展端命令，由本服务通过
//      ICommandService 路由）
//   3. 钩子失败不会回滚 skill 的变更 —— 只在 LogService 留痕

export const ISkillLifecycleService = createDecorator<ISkillLifecycleService>('skillLifecycleService');

/**
 * 技能生命周期事件类型
 */
export const enum SkillLifecycleEvent {
	/** 单个 skill 被添加到 agent 实例 */
	Added = 'added',
	/** 单个 skill 从 agent 实例移除 */
	Removed = 'removed',
	/** agent 实例的所有 skill 被批量同步（创建 / 全量更新后触发） */
	Synced = 'synced',
}

/**
 * 单个 skill 事件 payload
 */
export interface ISkillLifecyclePayload {
	/** 工作区 ID */
	readonly workspaceId?: string;
	/** 工作区在用户磁盘上的根路径 */
	readonly workspacePath?: string;
	/** Agent 实例 ID（Employee.id） */
	readonly agentId: string;
	/** Agent 实例目录名（Employee.agentDir） */
	readonly agentDir?: string;
	/** Skill ID */
	readonly skillId: string;
	/** Skill 名称 */
	readonly skillName?: string;
	/** 触发时间（ISO 字符串） */
	readonly timestamp: string;
}

/**
 * 批量 skill 同步事件 payload（创建 agent 或全量更新后触发）
 */
export interface ISkillBatchLifecyclePayload {
	readonly workspaceId?: string;
	readonly workspacePath?: string;
	readonly agentId: string;
	readonly agentDir?: string;
	/** 此 agent 实例当前拥有的所有 skill ID */
	readonly skillIds: readonly string[];
	readonly timestamp: string;
}

/**
 * 命令钩子。扩展端通过 `commands.executeCommand('agentStudio.skillLifecycle.register', spec)`
 * 把自己注册进来；本服务在事件发生时通过 ICommandService 路由调用对应命令。
 *
 * 命令被调用时唯一参数为 ISkillLifecyclePayload 或 ISkillBatchLifecyclePayload。
 */
export interface ISkillLifecycleCommandHook {
	readonly id: string;
	/** 命令 ID，发生 Added 事件时调用 */
	readonly onAdded?: string;
	/** 命令 ID，发生 Removed 事件时调用 */
	readonly onRemoved?: string;
	/** 命令 ID，发生 Synced 事件时调用 */
	readonly onSynced?: string;
}

export interface ISkillLifecycleService {
	readonly _serviceBrand: undefined;

	/**
	 * 注册一个命令钩子；返回 IDisposable 以便取消订阅。
	 */
	registerCommandHook(hook: ISkillLifecycleCommandHook): IDisposable;

	/**
	 * 触发单个 skill 事件。
	 */
	fireSkillEvent(event: SkillLifecycleEvent.Added | SkillLifecycleEvent.Removed, payload: ISkillLifecyclePayload): Promise<void>;

	/**
	 * 触发批量 skill 同步事件。
	 */
	fireBatchEvent(payload: ISkillBatchLifecyclePayload): Promise<void>;

	/**
	 * 仅观察事件（不做副作用），方便其他 contribution 复用。
	 */
	readonly onDidFireSkillEvent: Event<{ event: SkillLifecycleEvent; payload: ISkillLifecyclePayload | ISkillBatchLifecyclePayload }>;
}
