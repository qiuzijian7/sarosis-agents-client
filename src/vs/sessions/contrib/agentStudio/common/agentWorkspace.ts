/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IAgentOSService } from './agentOS.js';
import { IAgentDriverService } from './agentDriver.js';

// ─── Workspace Registry ─────────────────────────────────────────

export const IWorkspaceRegistry = createDecorator<IWorkspaceRegistry>('workspaceRegistry');

/**
 * 工作区注册表
 * 
 * 管理多工作区完全隔离：每个工作区有独立的 OS 实例栈和 Driver 实例。
 */
export interface IWorkspaceRegistry {
	readonly _serviceBrand: undefined;

	// ── 工作区注册 ───────────────────────────────────────

	/**
	 * 注册工作区（打开工作区时调用）
	 */
	registerWorkspace(workspace: IWorkspaceConfig): IDisposable;

	/**
	 * 注销工作区（关闭工作区时调用）
	 */
	unregisterWorkspace(workspaceId: string): void;

	// ── 查询 ──────────────────────────────────────────────

	/**
	 * 获取所有已注册工作区
	 */
	getWorkspaces(): IWorkspaceConfig[];

	/**
	 * 获取指定工作区
	 */
	getWorkspace(workspaceId: string): IWorkspaceConfig | undefined;

	// ── 工作区级别 OS/Driver 实例 ──────────────────────

	/**
	 * 获取指定工作区的 OS 服务实例
	 */
	getWorkspaceOSService(workspaceId: string): IAgentOSService | undefined;

	/**
	 * 获取指定工作区的 Driver 服务实例
	 */
	getWorkspaceDriverService(workspaceId: string): IAgentDriverService | undefined;

	// ── 事件 ──────────────────────────────────────────────

	readonly onDidChangeWorkspaces: Event<void>;
}

// ─── Workspace Config ───────────────────────────────────────────

export interface IWorkspaceConfig {
	readonly id: string;
	readonly name: string;
	readonly path?: string;  // 工作区根路径
	readonly isActive: boolean;
	readonly createdAt: string;
}

// ─── Workspace Scope OS Service ───────────────────────────────

/**
 * 工作区级别的 Agent OS 服务
 * 
 * 每个工作区拥有独立的 OS 实例栈，实现完全隔离。
 */
export interface IWorkspaceOSService extends IAgentOSService {
	readonly workspaceId: string;
}

// ─── Workspace Scope Driver Service ──────────────────────────

/**
 * 工作区级别的 Agent Driver 服务
 */
export interface IWorkspaceDriverService extends IAgentDriverService {
	readonly workspaceId: string;
}
