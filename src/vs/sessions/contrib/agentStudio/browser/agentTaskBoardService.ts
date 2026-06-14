/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Queue } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, FileSystemProviderCapabilities } from '../../../../platform/files/common/files.js';
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

/**
 * When the persisted task count crosses this threshold, the JSON-file storage
 * starts to feel the cost of full read/serialize/write on every mutation.
 * We log a one-time warning as a signal to revisit the storage backend
 * (see the JSON-vs-SQLite decision: JSON is intentional below this scale).
 */
const TASK_COUNT_WARN_THRESHOLD = 500;

export class AgentTaskBoardService extends Disposable implements IAgentTaskBoardService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTaskBoard = this._register(new Emitter<void>());
	readonly onDidChangeTaskBoard: Event<void> = this._onDidChangeTaskBoard.event;

	private readonly _onDidChangeBoards = this._register(new Emitter<void>());
	readonly onDidChangeBoards: Event<void> = this._onDidChangeBoards.event;

	private _dataUri: URI | undefined;

	/**
	 * Serialize all read-modify-write cycles so concurrent mutations cannot
	 * interleave and clobber each other (the one real risk of JSON-file
	 * storage). Tasks and boards live in separate files, hence two queues.
	 */
	private readonly _taskWriteQueue = new Queue<unknown>();
	private readonly _boardWriteQueue = new Queue<unknown>();

	/** One-time guard so the high-task-count warning does not spam the log. */
	private _warnedHighTaskCount = false;

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

	/**
	 * Write content to a file, preferring an atomic temp-file+rename when the
	 * underlying provider supports it (avoids leaving a half-written / corrupt
	 * JSON file if the process dies mid-write). Falls back to a plain write.
	 */
	private async _atomicWriteFile(uri: URI, content: VSBuffer): Promise<void> {
		if (this.fileService.hasCapability(uri, FileSystemProviderCapabilities.FileAtomicWrite)) {
			await this.fileService.writeFile(uri, content, { atomic: { postfix: '.vsctmp' } });
		} else {
			await this.fileService.writeFile(uri, content);
		}
	}

	private async _writeTasks(tasks: TaskBoardRecord[]): Promise<void> {
		const uri = URI.joinPath(this._getDataUri(), DATA_FILE_TASKBOARD);
		const content = VSBuffer.fromString(JSON.stringify(tasks, null, 2));
		await this._atomicWriteFile(uri, content);

		// Signal-light for the storage backend: JSON is intentional below this
		// scale; past the threshold the full read/serialize/write per mutation
		// starts to matter, so flag it once.
		if (!this._warnedHighTaskCount && tasks.length > TASK_COUNT_WARN_THRESHOLD) {
			this._warnedHighTaskCount = true;
			this.logService.warn(`[AgentStudio] TaskBoard: task count (${tasks.length}) exceeded ${TASK_COUNT_WARN_THRESHOLD}; JSON-file storage may degrade — consider migrating IAgentTaskBoardService to a database-backed provider.`);
		}
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
		await this._atomicWriteFile(uri, content);
	}

	/**
	 * Run a read-modify-write cycle against the task list under the task write
	 * queue so it cannot interleave with any other task mutation. The mutator
	 * receives the current tasks, mutates them (in place or by returning a new
	 * array), and the result is persisted; its return value is forwarded.
	 */
	private _withTasks<R>(mutate: (tasks: TaskBoardRecord[]) => Promise<R> | R): Promise<R> {
		return this._taskWriteQueue.queue(async () => {
			const tasks = await this._readTasks();
			const result = await mutate(tasks);
			await this._writeTasks(tasks);
			return result;
		}) as Promise<R>;
	}

	/** Same as {@link _withTasks} but for the boards list / queue. */
	private _withBoards<R>(mutate: (boards: TaskBoard[]) => Promise<R> | R): Promise<R> {
		return this._boardWriteQueue.queue(async () => {
			const boards = await this._readBoards();
			const result = await mutate(boards);
			await this._writeBoards(boards);
			return result;
		}) as Promise<R>;
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
			worktreePath: data.worktreePath,
			workspaceId: data.workspaceId || '',
			boardId: data.boardId || DEFAULT_BOARD_ID,
			priority: data.priority || 'medium',
			dependencies: data.dependencies || [],
			createdAt: now,
			updatedAt: now,
			workflowId: data.workflowId,
			variableValues: data.variableValues,
		};
		await this._withTasks(tasks => { tasks.push(newTask); });
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: created task ${newTask.id}`);
		return newTask;
	}

	async updateTask(id: string, data: Partial<TaskBoardRecord>): Promise<TaskBoardRecord> {
		const now = new Date().toISOString();

		// Phase 1 — persist the field changes atomically under the write queue.
		const updated = await this._withTasks(tasks => {
			const index = tasks.findIndex(t => t.id === id);
			if (index === -1) {
				throw new Error(`Task not found: ${id}`);
			}
			const next: TaskBoardRecord = {
				...tasks[index],
				...data,
				id,
				updatedAt: now,
			};
			// Set completedAt when transitioning to Done/Cancelled/Archived;
			// clear it when transitioning back to a non-terminal status (retry / unblock / redo).
			if (data.status) {
				const terminalStatuses: TaskBoardStatus[] = [TaskBoardStatus.Done, TaskBoardStatus.Cancelled, TaskBoardStatus.Archived];
				next.completedAt = terminalStatuses.includes(data.status) ? now : undefined;
			}
			tasks[index] = next;
			return next;
		});
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: updated task ${id}`);

		// Phase 2 — when a task transitions to Running, ensure an agent is
		// assigned. This is deliberately OUTSIDE the write queue: ensureTaskAgent
		// may be slow (network / spawn) and must not block other task mutations.
		// The agent assignment is persisted via a second small queued update.
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

					// Persist the assignment (queued, so it won't clobber concurrent edits).
					await this._withTasks(tasks => {
						const i = tasks.findIndex(t => t.id === id);
						if (i !== -1) {
							tasks[i] = { ...tasks[i], assigneeId: result.assigneeId, assigneeName: result.assigneeName, updatedAt: new Date().toISOString() };
						}
					});
					this._onDidChangeTaskBoard.fire();

					// Fire-and-forget: invoke the agent to actually execute the task
					this.orchestrationService.executeTaskForBoard(
						updated.workspaceId!,
						id,
						{ title: updated.title, description: updated.description, assigneeId: result.assigneeId, assigneeName: result.assigneeName, sourceId: updated.sourceId, worktreePath: updated.worktreePath, workflowId: updated.workflowId, variableValues: updated.variableValues },
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

		return updated;
	}

	async updateTaskStatus(id: string, status: TaskBoardStatus): Promise<TaskBoardRecord> {
		return this.updateTask(id, { status });
	}

	async deleteTask(id: string): Promise<void> {
		await this._withTasks(tasks => {
			const index = tasks.findIndex(t => t.id === id);
			if (index !== -1) {
				tasks.splice(index, 1);
			}
		});
		// Best-effort cleanup of the task's attachment side files (separate dir,
		// not the JSON — safe to do outside the write queue).
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
		const now = new Date().toISOString();
		const board = await this._withBoards(boards => {
			const siblingCount = boards.filter(b => b.workspaceId === workspaceId).length;
			const created: TaskBoard = {
				id: this._generateBoardId(),
				name: name.trim() || '新看板',
				workspaceId,
				order: siblingCount + 1,
				createdAt: now,
				updatedAt: now,
			};
			boards.push(created);
			return created;
		});
		this._onDidChangeBoards.fire();
		this.logService.trace(`[AgentStudio] Board: created ${board.id} (${board.name}) in workspace ${workspaceId}`);
		return board;
	}

	async renameBoard(boardId: string, name: string): Promise<TaskBoard> {
		const now = new Date().toISOString();

		// If renaming the implicit (never-persisted) default board, we need a
		// workspaceId to materialize it. Infer it from any task on that board
		// before entering the write queue (read-only, safe outside).
		let inferredDefaultWorkspaceId = '';
		if (boardId === DEFAULT_BOARD_ID) {
			const tasks = await this._readTasks();
			inferredDefaultWorkspaceId = tasks.find(t => this._effectiveBoardId(t) === DEFAULT_BOARD_ID)?.workspaceId ?? '';
		}

		const updated = await this._withBoards(boards => {
			const index = boards.findIndex(b => b.id === boardId);
			if (index === -1) {
				// Renaming the implicit default board → persist it now.
				if (boardId === DEFAULT_BOARD_ID) {
					const board: TaskBoard = { ...this._defaultBoard(inferredDefaultWorkspaceId), name: name.trim() || '默认看板', updatedAt: now };
					boards.push(board);
					return board;
				}
				throw new Error(`Board not found: ${boardId}`);
			}
			const next: TaskBoard = { ...boards[index], name: name.trim() || boards[index].name, updatedAt: now };
			boards[index] = next;
			return next;
		});
		this._onDidChangeBoards.fire();
		this.logService.trace(`[AgentStudio] Board: renamed ${boardId} → ${updated.name}`);
		return updated;
	}

	async deleteBoard(boardId: string): Promise<void> {
		if (boardId === DEFAULT_BOARD_ID) {
			throw new Error('The default board cannot be deleted.');
		}

		// Remove the board record (queued on the board file).
		const target = await this._withBoards(boards => {
			const found = boards.find(b => b.id === boardId);
			const index = boards.findIndex(b => b.id === boardId);
			if (index !== -1) {
				boards.splice(index, 1);
			}
			return found;
		});

		// Reassign all tasks of the deleted board back to the workspace's
		// default board (queued on the task file).
		const touched = await this._withTasks(tasks => {
			let count = 0;
			const now = new Date().toISOString();
			for (const t of tasks) {
				if (this._effectiveBoardId(t) === boardId) {
					t.boardId = DEFAULT_BOARD_ID;
					t.updatedAt = now;
					count++;
				}
			}
			return count;
		});
		if (touched > 0) {
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
		// Fail fast if the task does not exist (read-only, outside the write queue)
		// so we never leave an orphan side-file behind.
		const existing = await this._readTasks();
		if (!existing.some(t => t.id === taskId)) {
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
		// The side-file is an independent resource, so it stays outside the JSON
		// write queue; only the metadata mutation below is serialized.
		const uri = this._attachmentUri(taskId, attachment.id);
		await this.fileService.writeFile(uri, buffer);

		// Append metadata to the task record (serialized through the write queue).
		await this._withTasks(tasks => {
			const index = tasks.findIndex(t => t.id === taskId);
			if (index === -1) {
				throw new Error(`Task not found: ${taskId}`);
			}
			const task = tasks[index];
			const attachments = task.attachments ? [...task.attachments, attachment] : [attachment];
			tasks[index] = { ...task, attachments, updatedAt: new Date().toISOString() };
		});
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: added attachment ${attachment.id} (${attachment.name}, ${attachment.size}B) to task ${taskId}`);
		return attachment;
	}

	async removeAttachment(taskId: string, attachmentId: string): Promise<void> {
		// Delete the side file first (best-effort, outside the write queue —
		// it is an independent resource, not part of the JSON document).
		try {
			const uri = this._attachmentUri(taskId, attachmentId);
			if (await this.fileService.exists(uri)) {
				await this.fileService.del(uri);
			}
		} catch (err) {
			this.logService.warn(`[AgentStudio] TaskBoard: failed to delete attachment file ${attachmentId}:`, err);
		}

		// Drop the metadata from the task record (serialized through the write queue).
		await this._withTasks(tasks => {
			const index = tasks.findIndex(t => t.id === taskId);
			if (index === -1) {
				throw new Error(`Task not found: ${taskId}`);
			}
			const task = tasks[index];
			const attachments = (task.attachments ?? []).filter(a => a.id !== attachmentId);
			tasks[index] = { ...task, attachments, updatedAt: new Date().toISOString() };
		});
		this._onDidChangeTaskBoard.fire();
		this.logService.trace(`[AgentStudio] TaskBoard: removed attachment ${attachmentId} from task ${taskId}`);
	}

	async readAttachment(taskId: string, attachmentId: string): Promise<string> {
		const uri = this._attachmentUri(taskId, attachmentId);
		const content = await this.fileService.readFile(uri);
		return encodeBase64(content.value);
	}
}
