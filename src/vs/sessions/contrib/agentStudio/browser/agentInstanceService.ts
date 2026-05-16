/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentInstanceService, AgentInstance, AgentInstanceStatus, AgentTemplate } from '../common/agentInstance.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentGalleryService } from '../common/agentInstance.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { WORKSPACE_DATA_DIR, AGENTS_DIR, AGENT_CONFIG_FILE } from '../common/constants.js';

// ─── Agent Instance Service Implementation ─────────────────────────

export class AgentInstanceService extends Disposable implements IAgentInstanceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeInstances = this._register(new Emitter<void>());
	readonly onDidChangeInstances = this._onDidChangeInstances.event;

	private readonly _instances = new Map<string, AgentInstance>();

	private readonly _logService: ILogService;
	private _galleryService: IAgentGalleryService | undefined;
	private readonly _fileService: IFileService;

	constructor(
		@ILogService logService: ILogService,
		@IAgentGalleryService agentGalleryService: IAgentGalleryService,
		@IFileService fileService: IFileService,
	) {
		super();
		this._logService = logService;
		this._galleryService = agentGalleryService;
		this._fileService = fileService;
		// 启动时从文件系统加载已有实例
		this._loadInstancesFromDisk();
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

		const instanceId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
		const instance: AgentInstance = {
			id: instanceId,
			name: template.name,
			templateId,
			workspaceId,
			configPath: `${WORKSPACE_DATA_DIR}/${AGENTS_DIR}/${instanceId}/${AGENT_CONFIG_FILE}`,
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
		const instanceId = config.id || `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
		const instance: AgentInstance = {
			id: instanceId,
			name: config.name || 'New Agent',
			templateId: config.templateId,
			workspaceId: config.workspaceId || '',
			configPath: config.configPath || `${WORKSPACE_DATA_DIR}/${AGENTS_DIR}/${instanceId}/${AGENT_CONFIG_FILE}`,
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
			// 清理 .sarosis/agents/{id}/ 目录
			await this._cleanupInstanceFiles(id);

			this._instances.delete(id);
			this._onDidChangeInstances.fire();
			this._logService.info(`[AgentInstance] Deleted: ${id}`);
		}
	}

	private async _cleanupInstanceFiles(instanceId: string): Promise<void> {
		if (!this._fileService) {
			return;
		}

		try {
			const instanceDir = URI.from({ scheme: 'file', path: `${WORKSPACE_DATA_DIR}/${AGENTS_DIR}/${instanceId}` });
			await this._fileService.del(instanceDir, { recursive: true });
			this._logService.info(`[AgentInstance] Cleaned up files for instance: ${instanceId}`);
		} catch (error) {
			this._logService.error(`[AgentInstance] Failed to cleanup files for instance: ${instanceId}`, error);
		}
	}

	private async _loadInstancesFromDisk(): Promise<void> {
		if (!this._fileService) {
			return;
		}

		try {
			const agentsDir = URI.from({ scheme: 'file', path: `${WORKSPACE_DATA_DIR}/${AGENTS_DIR}` });
			const children = await this._fileService.resolve(agentsDir);

			if (children.children) {
				for (const child of children.children) {
					if (child.isDirectory) {
						const configPath = URI.joinPath(child.resource, 'agent.yaml');
						try {
							const content = await this._fileService.readFile(configPath);
							const instance = this._parseAgentConfig(content.value.toString(), child.resource.path);
							if (instance) {
								this._instances.set(instance.id, instance);
							}
						} catch (error) {
							this._logService.error(`[AgentInstance] Failed to load config from ${configPath.toString()}`, error);
						}
					}
				}
			}

			this._logService.info(`[AgentInstance] Loaded ${this._instances.size} instances from disk`);
		} catch (error) {
			// 目录可能不存在，忽略错误
			this._logService.debug('[AgentInstance] No instances directory found on disk');
		}
	}

	private _parseAgentConfig(content: string, dirPath: string): AgentInstance | undefined {
		try {
			const config = JSON.parse(content);
			// 确保必要字段存在
			if (!config.id) {
				this._logService.error('[AgentInstance] Agent config missing id field');
				return undefined;
			}

			// 构建 AgentInstance 对象
			const instance: AgentInstance = {
				id: config.id,
				name: config.name || 'Unnamed Agent',
				templateId: config.templateId,
				workspaceId: config.workspaceId || '',
				configPath: `${dirPath}/agent.yaml`,
				createdAt: config.createdAt || new Date().toISOString(),
				updatedAt: config.updatedAt || new Date().toISOString(),
				status: config.status || AgentInstanceStatus.Active,
			};

			return instance;
		} catch (error) {
			this._logService.error('[AgentInstance] Failed to parse agent config', error);
			return undefined;
		}
	}

	private async _getTemplateById(templateId: string): Promise<AgentTemplate | undefined> {
		if (!this._galleryService) {
			return undefined;
		}

		try {
			const templates = await this._galleryService.getTemplates();
			return templates.find(t => t.id === templateId);
		} catch (error) {
			this._logService.error('[AgentInstance] Failed to get template by ID', error);
			return undefined;
		}
	}

	private async _createAgentConfig(instance: AgentInstance): Promise<void> {
		if (!this._fileService) {
			this._logService.warn('[AgentInstance] No FileService available, cannot create config');
			return;
		}

		try {
			// Ensure directory exists
			const configDir = URI.from({ scheme: 'file', path: `${WORKSPACE_DATA_DIR}/${AGENTS_DIR}/${instance.id}` });
			await this._fileService.createFolder(configDir);

			// 构建配置文件内容
			const config = {
				id: instance.id,
				name: instance.name,
				templateId: instance.templateId,
				workspaceId: instance.workspaceId,
				model: {
					providerId: 'knot-agui',
					modelId: 'gpt-4o',
					temperature: 0.7,
					maxTokens: 4096,
				},
				memory: { enabled: true },
				tools: ['filesystem', 'search'],
				planning: { enabled: true },
				execution: { enabled: true, maxIterations: 10 },
				retrieval: { enabled: false },
				kanban: { enabled: true },
				createdAt: instance.createdAt,
				updatedAt: instance.updatedAt,
				status: instance.status,
			};

			// 写入文件
			const configFile = URI.joinPath(configDir, 'agent.yaml');
			const content = VSBuffer.fromString(JSON.stringify(config, null, 2));
			await this._fileService.writeFile(configFile, content);

			// 更新实例的配置路径
			instance.configPath = `${configDir.path}/agent.yaml`;

			this._logService.info(`[AgentInstance] Created config at ${configFile.toString()}`);
		} catch (error) {
			this._logService.error('[AgentInstance] Failed to create agent config', error);
			throw error;
		}
	}
}
