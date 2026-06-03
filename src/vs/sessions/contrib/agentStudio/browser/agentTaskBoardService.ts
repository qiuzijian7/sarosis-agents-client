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
import { VSBuffer, encodeBase64, decodeBase64 } from '../../../../base/common/buffer.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentTaskBoardService, ITaskOrchestrationService } from '../common/agentStudio.js';
import type { TaskBoardRecord, TaskBoard, TaskAttachment } from '../common/types.js';
import { TaskBoardStatus, TaskSource, DEFAULT_BOARD_ID } from '../common/types.js';
import { AGENT_STUDIO_DATA_PATH_SETTING } from '../common/constants.js';

const DATA_FILE_TASKBOARD = 'taskboard.json';
const DATA_FILE_BOARDS = 'boards.json';
const ATTACHMENTS_DIR = 'attachments';

export class AgentTaskBoardService extends Disposable implements IAgentTaskBoardService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTaskBoard = this._register(new Emitter<void>());
	readonly onDidChangeTaskBoard: Event<void> = this._onDidChangeTaskBoard.event;

	private readonly _onDidChangeBoards = this._register(new Emitter<void>());
	readonly onDidChangeBoards: Event<void> = this._onDidChangeBoards.event;

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

	private async _readBoards(): Promise<TaskBoard[]> {
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_BOARDS);
			const content = await this.fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString());
			return Array.isArray(parsed) ? parsed as TaskBoard[] : [];
		} catch {
			return [];
		}
	}

	private async _writeBoards(boards: TaskBoard[]): Promise<void> {
		const uri = URI.joinPath(this._getDataUri(), DATA_FILE_BOARDS);
		const content = VSBuffer.fromString(JSON.stringify(boards, null, 2));
		await this.fileService.writeFile(uri, content);
	}

	private _generateId(): string {
		return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	private _generateBoardId(): string {
		return `board_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	/** Normalize a task's boardId: absent/empty → default board (legacy compat). */
	private _effectiveBoardId(task: TaskBoardRecord): string {
		return task.boardId && task.boardId.length > 0 ? task.boardId : DEFAULT_BOARD_ID;
	}

	async getTasks(workspaceId?: string, boardId?: string): Promise<TaskBoardRecord[]> {
		const tasks = await this._readTasks();
		return tasks.filter(t => {
			if (workspaceId && t.workspaceId !== workspaceId) {
				return false;
			}
			if (boardId && this._effectiveBoardId(t) !== boardId) {
				return false;
			}
			return true;
		});
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
			boardId: data.boardId || DEFAULT_BOARD_ID,
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

		// Set completedAt when transitioning to Done/Cancelled/Archived;
		// clear it when transitioning back to a non-terminal status (retry / unblock / redo).
		if (data.status) {
			const terminalStatuses: TaskBoardStatus[] = [TaskBoardStatus.Done, TaskBoardStatus.Cancelled, TaskBoardStatus.Archived];
			if (terminalStatuses.includes(data.status)) {
				updated.completedAt = now;
			} else {
				updated.completedAt = undefined;
			}
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
		// Best-effort cleanup of the task's attachment side files.
		try {
			const dir = URI.joinPath(this._getDataUri(), ATTACHMENTS_DIR, id);
			if (await this.fileService.exists(dir)) {
				await this.fileService.del(dir, { recursive: true });
			}
		} catch (err) {
			this.logService.warn(`[AgentStudio] TaskBoard: failed to clean attachments for ${id}:`, err);
		}
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: deleted task ${id}`);
	}

	async archiveTask(id: string): Promise<TaskBoardRecord> {
		return this.updateTask(id, { status: TaskBoardStatus.Archived });
	}

	// ─── Board management (multi-board isolation, P2) ───────────────────────

	/** Build the implicit default board for a workspace (never persisted unless renamed). */
	private _defaultBoard(workspaceId: string): TaskBoard {
		const now = new Date().toISOString();
		return {
			id: DEFAULT_BOARD_ID,
			name: '默认看板',
			workspaceId,
			order: 0,
			createdAt: now,
			updatedAt: now,
		};
	}

	async listBoards(workspaceId?: string): Promise<TaskBoard[]> {
		const boards = await this._readBoards();
		const scoped = workspaceId ? boards.filter(b => b.workspaceId === workspaceId) : boards;

		// Always surface a default board per workspace, even if never persisted.
		// If a persisted board carries the DEFAULT_BOARD_ID (e.g. it was renamed),
		// use that one instead of synthesizing a fresh default.
		const result: TaskBoard[] = [];
		if (workspaceId) {
			const persistedDefault = scoped.find(b => b.id === DEFAULT_BOARD_ID);
			result.push(persistedDefault ?? this._defaultBoard(workspaceId));
			result.push(...scoped.filter(b => b.id !== DEFAULT_BOARD_ID));
		} else {
			// No workspace scope: return persisted boards as-is (default boards are per-workspace virtual).
			result.push(...scoped);
		}
		return result.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt));
	}

	async createBoard(name: string, workspaceId: string): Promise<TaskBoard> {
		const boards = await this._readBoards();
		const now = new Date().toISOString();
		const siblingCount = boards.filter(b => b.workspaceId === workspaceId).length;
		const board: TaskBoard = {
			id: this._generateBoardId(),
			name: name.trim() || '新看板',
			workspaceId,
			order: siblingCount + 1,
			createdAt: now,
			updatedAt: now,
		};
		boards.push(board);
		await this._writeBoards(boards);
		this._onDidChangeBoards.fire();
		this.logService.trace(`[AgentStudio] Board: created ${board.id} (${board.name}) in workspace ${workspaceId}`);
		return board;
	}

	async renameBoard(boardId: string, name: string): Promise<TaskBoard> {
		const boards = await this._readBoards();
		const now = new Date().toISOString();
		const index = boards.findIndex(b => b.id === boardId);

		if (index === -1) {
			// Renaming the implicit (never-persisted) default board → persist it now.
			if (boardId === DEFAULT_BOARD_ID) {
				// We need a workspaceId; infer from any existing task's board, else fail gracefully.
				const tasks = await this._readTasks();
				const sample = tasks.find(t => this._effectiveBoardId(t) === DEFAULT_BOARD_ID);
				const workspaceId = sample?.workspaceId ?? '';
				const board: TaskBoard = { ...this._defaultBoard(workspaceId), name: name.trim() || '默认看板', updatedAt: now };
				boards.push(board);
				await this._writeBoards(boards);
				this._onDidChangeBoards.fire();
				return board;
			}
			throw new Error(`Board not found: ${boardId}`);
		}

		const updated: TaskBoard = { ...boards[index], name: name.trim() || boards[index].name, updatedAt: now };
		boards[index] = updated;
		await this._writeBoards(boards);
		this._onDidChangeBoards.fire();
		this.logService.trace(`[AgentStudio] Board: renamed ${boardId} → ${updated.name}`);
		return updated;
	}

	async deleteBoard(boardId: string): Promise<void> {
		if (boardId === DEFAULT_BOARD_ID) {
			throw new Error('The default board cannot be deleted.');
		}
		const boards = await this._readBoards();
		const target = boards.find(b => b.id === boardId);
		const filtered = boards.filter(b => b.id !== boardId);
		await this._writeBoards(filtered);

		// Reassign all tasks of the deleted board back to the workspace's default board.
		const tasks = await this._readTasks();
		let touched = 0;
		for (const t of tasks) {
			if (this._effectiveBoardId(t) === boardId) {
				t.boardId = DEFAULT_BOARD_ID;
				t.updatedAt = new Date().toISOString();
				touched++;
			}
		}
		if (touched > 0) {
			await this._writeTasks(tasks);
			this._onDidChangeTaskBoard.fire();
		}
		this._onDidChangeBoards.fire();
		this.logService.trace(`[AgentStudio] Board: deleted ${boardId} (${target?.name ?? '?'}), reassigned ${touched} task(s) to default`);
	}

	// ─── Attachments (P2) ───────────────────────────────────────────────────

	private _generateAttachmentId(): string {
		return `att_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	private _attachmentUri(taskId: string, attachmentId: string): URI {
		return URI.joinPath(this._getDataUri(), ATTACHMENTS_DIR, taskId, attachmentId);
	}

	async addAttachment(taskId: string, name: string, mimeType: string, base64Content: string): Promise<TaskAttachment> {
		const tasks = await this._readTasks();
		const index = tasks.findIndex(t => t.id === taskId);
		if (index === -1) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const buffer = decodeBase64(base64Content);
		const attachment: TaskAttachment = {
			id: this._generateAttachmentId(),
			name: name || 'untitled',
			mimeType: mimeType || 'application/octet-stream',
			size: buffer.byteLength,
			createdAt: new Date().toISOString(),
		};

		// Persist the binary content to a side file (never inline in JSON).
		const uri = this._attachmentUri(taskId, attachment.id);
		await this.fileService.writeFile(uri, buffer);

		// Append metadata to the task record.
		const task = tasks[index];
		const attachments = task.attachments ? [...task.attachments, attachment] : [attachment];
		tasks[index] = { ...task, attachments, updatedAt: new Date().toISOString() };
		await this._writeTasks(tasks);
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: added attachment ${attachment.id} (${attachment.name}, ${attachment.size}B) to task ${taskId}`);
		return attachment;
	}

	async removeAttachment(taskId: string, attachmentId: string): Promise<void> {
		const tasks = await this._readTasks();
		const index = tasks.findIndex(t => t.id === taskId);
		if (index === -1) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Delete the side file (best-effort).
		try {
			const uri = this._attachmentUri(taskId, attachmentId);
			if (await this.fileService.exists(uri)) {
				await this.fileService.del(uri);
			}
		} catch (err) {
			this.logService.warn(`[AgentStudio] TaskBoard: failed to delete attachment file ${attachmentId}:`, err);
		}

		const task = tasks[index];
		const attachments = (task.attachments ?? []).filter(a => a.id !== attachmentId);
		tasks[index] = { ...task, attachments, updatedAt: new Date().toISOString() };
		await this._writeTasks(tasks);
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: removed attachment ${attachmentId} from task ${taskId}`);
	}

	async readAttachment(taskId: string, attachmentId: string): Promise<string> {
		const uri = this._attachmentUri(taskId, attachmentId);
		const content = await this.fileService.readFile(uri);
		return encodeBase64(content.value);
	}
}
