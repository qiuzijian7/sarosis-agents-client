/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

// ─── Agent Instance Service ─────────────────────────────────

export const IAgentInstanceService = createDecorator<IAgentInstanceService>('agentInstanceService');

/**
 * Agent 实例化服务
 * 
 * 管理 Agent 实例的创建、删除、配置。
 * 每个实例对应一个独立的 Agent 配置（. saros/agents/{id}/agent.yaml）。
 */
export interface IAgentInstanceService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeInstances: Event<void>;

	/**
	 * 获取所有 Agent 实例
	 */
	getInstances(workspaceId?: string): Promise<AgentInstance[]>;

	/**
	 * 获取指定实例
	 */
	getInstance(id: string): Promise<AgentInstance | undefined>;

	/**
	 * 从 Gallery 模板创建实例
	 */
	createInstanceFromTemplate(templateId: string, workspaceId: string): Promise<AgentInstance>;

	/**
	 * 手动创建实例（自定义配置）
	 */
	createInstance(config: Partial<AgentInstance>): Promise<AgentInstance>;

	/**
	 * 更新实例配置
	 */
	updateInstance(id: string, updates: Partial<AgentInstance>): Promise<AgentInstance>;

	/**
	 * 删除实例（清理目录）
	 */
	deleteInstance(id: string): Promise<void>;
}

// ─── Agent Gallery Service ──────────────────────────────────

export const IAgentGalleryService = createDecorator<IAgentGalleryService>('agentGalleryService');

/**
 * Agent Gallery 服务
 * 
 * 展示可用的 Agent 预设模板，支持拖拽创建实例。
 */
export interface IAgentGalleryService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTemplates: Event<void>;

	/**
	 * 获取所有可用模板
	 */
	getTemplates(): Promise<AgentTemplate[]>;

	/**
	 * 按分类获取模板
	 */
	getTemplatesByCategory(category: string): Promise<AgentTemplate[]>;

	/**
	 * 搜索模板
	 */
	searchTemplates(query: string): Promise<AgentTemplate[]>;
}

// ─── Agent Instance ──────────────────────────────────────

export interface AgentInstance {
	readonly id: string;
	readonly name: string;
	readonly templateId?: string;      // 来源模板 ID
	readonly workspaceId: string;     // 所属工作区
	configPath: string;                  // agent.yaml 路径 (可修改)
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly status: AgentInstanceStatus;
}

export const enum AgentInstanceStatus {
	Active = 'active',
	Stopped = 'stopped',
	Error = 'error',
}

// ─── Agent Template ──────────────────────────────────────

export interface AgentTemplate {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly category: string;        // e.g. 'codegen', 'writing', 'data-analysis'
	readonly icon?: string;           // URI string
	readonly defaultConfig: Record<string, unknown>;  // 默认配置
	readonly tags?: string[];
}
