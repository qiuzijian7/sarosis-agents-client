/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentInstanceService, AgentInstance, AgentInstanceStatus, AgentTemplate } from '../common/agentInstance.js';
import { ILogService } from '../../../../platform/log/common/log.js';

// ─── Agent Instance Service Implementation ─────────────────────────

export class AgentInstanceService extends Disposable implements IAgentInstanceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeInstances = this._register(new Emitter<void>());
	readonly onDidChangeInstances = this._onDidChangeInstances.event;

	private readonly _instances = new Map<string, AgentInstance>();

	private _logService: ILogService = console as unknown as ILogService;

	constructor() {
		super();
	}

	async getInstances(workspaceId?: string): Promise<AgentInstance[]> {
		const all = Array.from(this._instances.values());
		if (workspaceId) {
			return all.filter(i => i.workspaceId === workspaceId);
		}
		return all;
	}

	async getInstance(id: string): Promise<AgentInstance | undefined> {
		return this._instances.get(id);
	}

	async createInstanceFromTemplate(templateId: string, workspaceId: string): Promise<AgentInstance> {
		const template = await this._getTemplateById(templateId);
		if (!template) {
			throw new Error(`Template not found: ${templateId}`);
		}

		const instance: AgentInstance = {
			id: `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			name: template.name,
			templateId,
			workspaceId,
			configPath: `.sarosis/agents/${templateId}/${Date.now()}/agent.yaml`,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: AgentInstanceStatus.Active,
		};

		this._instances.set(instance.id, instance);
		this._onDidChangeInstances.fire();
		this._logService.info(`[AgentInstance] Created from template: ${instance.name} (${instance.id})`);

		await this._createAgentConfig(instance);
		return instance;
	}

	async createInstance(config: Partial<AgentInstance>): Promise<AgentInstance> {
		const instance: AgentInstance = {
			id: config.id || `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			name: config.name || 'New Agent',
			templateId: config.templateId,
			workspaceId: config.workspaceId || '',
			configPath: config.configPath || `.sarosis/agents/untitled/${Date.now()}/agent.yaml`,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: AgentInstanceStatus.Active,
		};

		this._instances.set(instance.id, instance);
		this._onDidChangeInstances.fire();
		this._logService.info(`[AgentInstance] Created: ${instance.name} (${instance.id})`);
		return instance;
	}

	async updateInstance(id: string, updates: Partial<AgentInstance>): Promise<AgentInstance> {
		const instance = this._instances.get(id);
		if (!instance) {
			throw new Error(`Instance not found: ${id}`);
		}

		Object.assign(instance, updates, { updatedAt: new Date().toISOString() });
		this._instances.set(id, instance);
		this._onDidChangeInstances.fire();
		this._logService.info(`[AgentInstance] Updated: ${id}`);
		return instance;
	}

	async deleteInstance(id: string): Promise<void> {
		const instance = this._instances.get(id);
		if (instance) {
			// TODO: 清理 .sarosis/agents/{id}/ 目录
			this._instances.delete(id);
			this._onDidChangeInstances.fire();
			this._logService.info(`[AgentInstance] Deleted: ${id}`);
		}
	}

	private async _getTemplateById(templateId: string): Promise<AgentTemplate | undefined> {
		// TODO: 从 IAgentGalleryService 获取
		return {
			id: templateId,
			name: 'Mock Template',
			description: 'Mock template for development',
			category: 'general',
			defaultConfig: {},
		};
	}

	private async _createAgentConfig(instance: AgentInstance): Promise<void> {
		// TODO: 在 .sarosis/agents/{id}/ 创建 agent.yaml
		this._logService.info(`[AgentInstance] TODO: Create config at ${instance.configPath}`);
	}

	setLogService(logService: ILogService): void {
		this._logService = logService;
	}
}
