/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentTaskBoardService, ITaskOrchestrationService } from '../common/agentStudio.js';
import type { TaskBoardRecord } from '../common/types.js';
import { TaskBoardStatus, TaskSource } from '../common/types.js';
import { AGENT_STUDIO_DATA_PATH_SETTING } from '../common/constants.js';

const DATA_FILE_TASKBOARD = 'taskboard.json';

export class AgentTaskBoardService extends Disposable implements IAgentTaskBoardService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTaskBoard = this._register(new Emitter<void>());
	readonly onDidChangeTaskBoard: Event<void> = this._onDidChangeTaskBoard.event;

	private _dataUri: URI | undefined;

	/** Lazy references to break cyclic dependency (agentTaskBoardService ↔ taskOrchestrationService) */
	private _orchestrationService: ITaskOrchestrationService | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	/** Lazily resolve ITaskOrchestrationService to avoid constructor-time cyclic dependency */
	private get orchestrationService(): ITaskOrchestrationService {
		if (!this._orchestrationService) {
			this._orchestrationService = this.instantiationService.invokeFunction(accessor => accessor.get(ITaskOrchestrationService));
		}
		return this._orchestrationService!;
	}

	private _getDataUri(): URI {
		if (!this._dataUri) {
			const customPath = this.configurationService.getValue<string>(AGENT_STUDIO_DATA_PATH_SETTING);
			if (customPath) {
				this._dataUri = URI.file(customPath);
			} else {
				// 使用 environmentService.userHome 替代 process.env（浏览器环境无 process）
				const homeUri = this.environmentService.userHome;
				this._dataUri = URI.joinPath(homeUri, '.agent-studio', 'data');
			}
		}
		return this._dataUri;
	}

	private async _readTasks(): Promise<TaskBoardRecord[]> {
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_TASKBOARD);
			const content = await this.fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as TaskBoardRecord[];
		} catch {
			return [];
		}
	}

	private async _writeTasks(tasks: TaskBoardRecord[]): Promise<void> {
		const uri = URI.joinPath(this._getDataUri(), DATA_FILE_TASKBOARD);
		const content = VSBuffer.fromString(JSON.stringify(tasks, null, 2));
		await this.fileService.writeFile(uri, content);
	}

	private _generateId(): string {
		return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	async getTasks(workspaceId?: string): Promise<TaskBoardRecord[]> {
		const tasks = await this._readTasks();
		if (workspaceId) {
			return tasks.filter(t => t.workspaceId === workspaceId);
		}
		return tasks;
	}

	async getTask(id: string): Promise<TaskBoardRecord | undefined> {
		const tasks = await this._readTasks();
		return tasks.find(t => t.id === id);
	}

	async createTask(data: Partial<TaskBoardRecord>): Promise<TaskBoardRecord> {
		const tasks = await this._readTasks();
		const now = new Date().toISOString();
		const newTask: TaskBoardRecord = {
			id: this._generateId(),
			title: data.title || 'New Task',
			description: data.description,
			status: data.status || TaskBoardStatus.Todo,
			source: data.source || TaskSource.Manual,
			sourceId: data.sourceId,
			assigneeId: data.assigneeId,
			assigneeName: data.assigneeName,
			workspaceId: data.workspaceId || '',
			priority: data.priority || 'medium',
			dependencies: data.dependencies || [],
			createdAt: now,
			updatedAt: now,
		};
		tasks.push(newTask);
		await this._writeTasks(tasks);
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: created task ${newTask.id}`);
		return newTask;
	}

	async updateTask(id: string, data: Partial<TaskBoardRecord>): Promise<TaskBoardRecord> {
		const tasks = await this._readTasks();
		const index = tasks.findIndex(t => t.id === id);
		if (index === -1) {
			throw new Error(`Task not found: ${id}`);
		}

		const now = new Date().toISOString();
		const updated: TaskBoardRecord = {
			...tasks[index],
			...data,
			id,
			updatedAt: now,
		};

		// Set completedAt when transitioning to Done/Cancelled/Archived
		if (data.status && [TaskBoardStatus.Done, TaskBoardStatus.Cancelled, TaskBoardStatus.Archived].includes(data.status)) {
			updated.completedAt = now;
		}

		// When task transitions to Running, ensure an agent is assigned.
		// If no agent exists, find or create one before executing.
		if (data.status === TaskBoardStatus.Running && updated.workspaceId) {
			try {
				const result = await this.orchestrationService.ensureTaskAgent(
					updated.workspaceId,
					id,
					{
						title: updated.title,
						description: updated.description,
						assigneeId: updated.assigneeId,
						assigneeName: updated.assigneeName,
						sourceId: updated.sourceId,
					},
				);
				if (result) {
					updated.assigneeId = result.assigneeId;
					updated.assigneeName = result.assigneeName;
					this.logService.info(`[AgentStudio] TaskBoard: ensured agent "${result.assigneeName}" (${result.assigneeId}) for task ${id}`);

					// Fire-and-forget: invoke the agent to actually execute the task
					this.orchestrationService.executeTaskForBoard(
						updated.workspaceId!,
						id,
						{ title: updated.title, description: updated.description, assigneeId: result.assigneeId, assigneeName: result.assigneeName, sourceId: updated.sourceId },
					).catch(err => {
						this.logService.warn(`[AgentStudio] TaskBoard: task execution failed for ${id}:`, err);
					});
				} else {
					this.logService.warn(`[AgentStudio] TaskBoard: could not ensure agent for task ${id}, proceeding without assignment`);
				}
			} catch (err) {
				this.logService.warn(`[AgentStudio] TaskBoard: ensureTaskAgent failed for task ${id}:`, err);
			}
		}

		tasks[index] = updated;
		await this._writeTasks(tasks);
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: updated task ${id}`);
		return updated;
	}

	async updateTaskStatus(id: string, status: TaskBoardStatus): Promise<TaskBoardRecord> {
		return this.updateTask(id, { status });
	}

	async deleteTask(id: string): Promise<void> {
		const tasks = await this._readTasks();
		const filtered = tasks.filter(t => t.id !== id);
		await this._writeTasks(filtered);
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: deleted task ${id}`);
	}

	async archiveTask(id: string): Promise<TaskBoardRecord> {
		return this.updateTask(id, { status: TaskBoardStatus.Archived });
	}
}
