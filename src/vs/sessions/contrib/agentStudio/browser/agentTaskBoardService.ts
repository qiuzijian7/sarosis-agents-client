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
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { VSBuffer, encodeBase64, decodeBase64 } from '../../../../base/common/buffer.js';
import * as nodePath from '../../../../base/common/path.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentTaskBoardService, ITaskOrchestrationService, IAgentStudioService } from '../common/agentStudio.js';
import type { IChatAttachmentSend } from '../../../common/agentStudioService.js';
import type { TaskBoardRecord, TaskBoard, BoardLink, TaskAttachment } from '../common/types.js';
import { TaskBoardStatus, TaskSource, DEFAULT_BOARD_ID } from '../common/types.js';
import { AGENT_STUDIO_DATA_PATH_SETTING } from '../common/constants.js';
import { SAROS_CLAW_AGENT_ID } from './providers/tool/kanbanTools.js';

const DATA_FILE_TASKBOARD = 'taskboard.json';
const DATA_FILE_BOARDS = 'boards.json';
const DATA_FILE_BOARDLINKS = 'boardlinks.json';
const ATTACHMENTS_DIR = 'attachments';

/** Best-effort image MIME lookup from a file extension (for data-URI embedding). */
function _mimeFromName(name: string): string {
	const ext = name.split('.').pop()?.toLowerCase() || '';
	switch (ext) {
		case 'png': return 'image/png';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'gif': return 'image/gif';
		case 'svg': return 'image/svg+xml';
		case 'webp': return 'image/webp';
		case 'bmp': return 'image/bmp';
		case 'ico': return 'image/x-icon';
		default: return 'application/octet-stream';
	}
}

function _isImageName(name: string): boolean {
	return /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(name);
}

// ── Minimal pure-JS ZIP parser (renderer-safe, no fs/zlib required) ─────────

function _readU16LE(d: Uint8Array, offset: number): number {
	return d[offset] | (d[offset + 1] << 8);
}
function _readU32LE(d: Uint8Array, offset: number): number {
	return d[offset] | (d[offset + 1] << 8) | (d[offset + 2] << 16) | (d[offset + 3] << 24);
}

/** End-of-Central-Directory record */
interface _EOCD {
	totalEntries: number;
	cdOffset: number;
	cdSize: number;
}

/** Central-directory entry parsed from the ZIP */
interface _CDEntry {
	fileName: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

// ZC: unused constant ZIP_EOCD_SIG removed (we use byte-level signature comparison)
const EOCD_SIG_BYTES = [0x50, 0x4B, 0x05, 0x06];

/** Search backward from end of buffer for the EOCD signature. */
function _findEOCD(data: Uint8Array): _EOCD | undefined {
	// EOCD is at most 65535 + 22 bytes from the end
	const maxSearch = Math.min(data.length, 65535 + 22);
	const startSearch = data.length - maxSearch;
	for (let i = data.length - 22; i >= startSearch; i--) {
		if (data[i] === EOCD_SIG_BYTES[0] &&
			data[i + 1] === EOCD_SIG_BYTES[1] &&
			data[i + 2] === EOCD_SIG_BYTES[2] &&
			data[i + 3] === EOCD_SIG_BYTES[3]) {
			const totalEntries = _readU16LE(data, i + 10);
			const cdSize = _readU32LE(data, i + 12);
			const cdOffset = _readU32LE(data, i + 16);
			return { totalEntries, cdOffset, cdSize };
		}
	}
	return undefined;
}

const ZIP_CD_SIG = 0x02014b50;
const ZIP_LH_SIG = 0x04034b50;

/** Parse central-directory entries from the ZIP buffer. */
function _parseCentralDir(data: Uint8Array, eocd: _EOCD, zipPath: string): { entries: _CDEntry[]; baseName: string } {
	const entries: _CDEntry[] = [];
	let offset = eocd.cdOffset;
	const end = eocd.cdOffset + eocd.cdSize;
	// Derive baseName for relative-path prefix (without .zip extension)
	const baseName = (zipPath.replace(/\\/g, '/').split('/').pop() || 'archive').replace(/\.zip$/i, '');

	while (offset < end - 46) {
		const sig = _readU32LE(data, offset);
		if (sig !== ZIP_CD_SIG) { break; }
		const method = _readU16LE(data, offset + 10);
		const compressedSize = _readU32LE(data, offset + 20);
		const uncompressedSize = _readU32LE(data, offset + 24);
		const nameLen = _readU16LE(data, offset + 28);
		const extraLen = _readU16LE(data, offset + 30);
		const commentLen = _readU16LE(data, offset + 32);
		const localHeaderOffset = _readU32LE(data, offset + 42);
		const fileName = new TextDecoder().decode(data.slice(offset + 46, offset + 46 + nameLen));
		entries.push({ fileName, method, compressedSize, uncompressedSize, localHeaderOffset });
		offset += 46 + nameLen + extraLen + commentLen;
	}
	return { entries, baseName };
}

/**
 * Read the raw file data for a ZIP entry.
 * @returns uncompressed data, or `undefined` if the entry is deflated
 * and no `inflateRaw` callback is available.
 */
async function _readLocalFile(data: Uint8Array, entry: _CDEntry, inflateRaw?: (d: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array | undefined> {
	const sig = _readU32LE(data, entry.localHeaderOffset);
	if (sig !== ZIP_LH_SIG) { return undefined; }

	const nameLen = _readU16LE(data, entry.localHeaderOffset + 26);
	const extraLen = _readU16LE(data, entry.localHeaderOffset + 28);
	const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;

	if (entry.method === 0) {
		// Stored (no compression)
		return data.slice(dataStart, dataStart + entry.compressedSize);
	}
	if (entry.method === 8) {
		// Deflated
		if (!inflateRaw) { return undefined; }
		try {
			return await inflateRaw(data.slice(dataStart, dataStart + entry.compressedSize));
		} catch { return undefined; }
	}
	// Unknown compression method
	return undefined;
}

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

	private readonly _onDidChangeBoardLinks = this._register(new Emitter<void>());
	readonly onDidChangeBoardLinks: Event<void> = this._onDidChangeBoardLinks.event;

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

	// ── In-memory cache (方案 A，P2-10 fix) ──────────────────────────────
	// Avoids the 600-1500ms disk I/O on every _withTasks call by caching
	// tasks in memory and flushing to disk asynchronously.
	private _tasksCache: TaskBoardRecord[] | undefined;
	private _tasksLoaded = false;
	private _flushTimer: any = undefined;
	private _tasksDirty = false;

	/** Lazy references to break cyclic dependency */
	private _orchestrationService: ITaskOrchestrationService | undefined;
	private _agentStudioService: IAgentStudioService | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) {
		super();
		// Flush dirty cache to disk on dispose (app shutdown)
		this._register({ dispose: () => { this._forceFlushSync(); } });
	}

	/** Lazily resolve ITaskOrchestrationService to avoid constructor-time cyclic dependency */
	private get orchestrationService(): ITaskOrchestrationService {
		if (!this._orchestrationService) {
			this._orchestrationService = this.instantiationService.invokeFunction(accessor => accessor.get(ITaskOrchestrationService));
		}
		return this._orchestrationService!;
	}

	/**
	 * Lazily resolve IAgentStudioService to avoid constructor-time cyclic
	 * dependency (AgentStudioService itself injects IAgentTaskBoardService).
	 */
	private get agentStudioService(): IAgentStudioService {
		if (!this._agentStudioService) {
			this._agentStudioService = this.instantiationService.invokeFunction(
				accessor => accessor.get(IAgentStudioService)
			);
		}
		return this._agentStudioService;
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
		if (this._tasksLoaded) {
			return this._tasksCache ?? [];
		}
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_TASKBOARD);
			const content = await this.fileService.readFile(uri);
			this._tasksCache = JSON.parse(content.value.toString()) as TaskBoardRecord[];
		} catch {
			this._tasksCache = [];
		}
		this._tasksLoaded = true;
		return this._tasksCache!;
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

	/** Debounce flush: write in-memory cache to disk after 100ms of inactivity.
	 *  Multiple rapid mutations batch into a single disk write. */
	private _scheduleFlush(): void {
		if (this._flushTimer) { clearTimeout(this._flushTimer); }
		this._flushTimer = setTimeout(() => {
			this._flushTimer = undefined;
			if (this._tasksDirty && this._tasksCache) {
				const snapshot = [...this._tasksCache];
				this._tasksDirty = false;
				this._writeTasks(snapshot).catch(err =>
					this.logService.error('[TaskBoard] async flush failed:', err)
				);
			}
		}, 100);
	}

	/** Synchronous flush for shutdown — must complete before the process exits.
	 *  Cancels any pending timer and writes immediately. */
	private _forceFlushSync(): void {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		// Fire-and-forget on shutdown: the process won't wait for async.
		// In practice the dispose happens before the Node event loop drains,
		// so the write will likely complete.
		if (this._tasksDirty && this._tasksCache) {
			this._tasksDirty = false;
			// Use queue to avoid racing with a concurrent flush
			this._taskWriteQueue.queue(async () => {
				await this._writeTasks(this._tasksCache!);
			}).catch(() => { /* best-effort on shutdown */ });
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
			const t0 = performance.now();
			const tasks = await this._readTasks();
			const result = await mutate(tasks);
			this._tasksDirty = true;
			this._scheduleFlush();
			console.info(`[TaskPerfDiag] _withTasks done elapsed=${(performance.now() - t0).toFixed(0)}ms`);
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

	/** Cached worktree lists keyed by workspaceId, to avoid redundant Git scans
	 *  on every createTask call (P2-9 fix).  Populated lazily on first access;
	 *  invalidated when workspace changes via the listener below. */
	private readonly _worktreeCache = new Map<string, any[]>();

	private async _cachedWorktrees(workspaceId: string): Promise<any[]> {
		if (this._worktreeCache.has(workspaceId)) {
			return this._worktreeCache.get(workspaceId)!;
		}
		const worktrees = await this.agentStudioService.getWorktrees(workspaceId);
		this._worktreeCache.set(workspaceId, worktrees);
		return worktrees;
	}

	private _generateId(): string {
		return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	/**
	 * Strip inline base64 data URIs from a task description.
	 * Replaces `data:<mime>;base64,...` with `[图片: N]` / `[文件: N]`
	 * placeholders so the description stays compact and doesn't bloat
	 * taskboard.json or cause regex performance issues on render/exec.
	 * Uses a fast `indexOf` pre-check to skip the regex entirely when
	 * no data URIs are present (the common case).
	 */
	private _sanitizeDescription(desc: string | undefined): string | undefined {
		if (!desc) { return desc; }
		// Fast pre-check — avoid running the regex on descriptions that
		// don't contain any data URIs (the 99% case).
		if (desc.indexOf('data:') === -1) { return desc; }
		const dataUriRe = /(?:(!?\[([^\]]*)\]\())?data:([\w/+-]+);base64,([A-Za-z0-9+/=]+)\)?/gi;
		let img = 0; let file = 0;
		const result = desc.replace(dataUriRe, (_full, _prefix, _alt, mimeType) => {
			if (mimeType?.startsWith('image/')) {
				img++;
				return `[图片: ${img}]`;
			}
			file++;
			return `[文件: ${file}]`;
		});
		return result;
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
		const t0 = performance.now();
		const now = new Date().toISOString();

		// Resolve defaults for workspace and main worktree when not explicitly
		// provided. Uses cached worktree list (populated on first call) so the
		// create-task path doesn't block on a Git scan every time.
		let workspaceId = data.workspaceId;
		let worktreePath = data.worktreePath;

		if (!workspaceId) {
			workspaceId = this.agentStudioService.getActiveWorkspaceId() || '';
		}
		if (!worktreePath && workspaceId) {
			try {
				const worktrees = await this._cachedWorktrees(workspaceId);
				if (worktrees.length > 0) {
					worktreePath = worktrees[0].path;
				}
			} catch {
				// getWorktrees may throw (e.g. no git repo); silently skip.
			}
		}

		const newTask: TaskBoardRecord = {
			id: this._generateId(),
			title: data.title || 'New Task',
			description: this._sanitizeDescription(data.description),
			status: data.status || TaskBoardStatus.Todo,
			source: data.source || TaskSource.Manual,
			sourceId: data.sourceId,
			tapdUrl: data.tapdUrl,
			assigneeId: data.assigneeId,
			assigneeName: data.assigneeName,
			worktreePath,
			workspaceId: workspaceId || '',
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
		console.info(`[TaskPerfDiag] createTask DONE id=${newTask.id} elapsed=${(performance.now() - t0).toFixed(0)}ms`);
		this.logService.trace(`[AgentStudio] TaskBoard: created task ${newTask.id} ws=${workspaceId} wt=${worktreePath || '-'}`);
		return newTask;
	}

	async updateTask(id: string, data: Partial<TaskBoardRecord>): Promise<TaskBoardRecord> {
		const t0 = performance.now();
		const now = new Date().toISOString();

		// Sanitize description if it's being updated — strip inline base64
		// data URIs to prevent MB-sized blobs from being persisted to disk
		// and causing regex performance issues on every render/execution.
		const sanitizedData = data.description !== undefined
			? { ...data, description: this._sanitizeDescription(data.description) }
			: data;

		// Phase 1 — persist the field changes atomically under the write queue.
		const updated = await this._withTasks(tasks => {
			const index = tasks.findIndex(t => t.id === id);
			if (index === -1) {
				throw new Error(`Task not found: ${id}`);
			}
			const next: TaskBoardRecord = {
				...tasks[index],
				...sanitizedData,
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
		const tPhase1 = performance.now();
		// For Running transitions, defer the fire to Phase 2 (after ensureTaskAgent
		// completes and assigneeId/assigneeName are persisted).  Firing here would
		// trigger a full _refresh() + DOM rebuild, immediately followed by a second
		// rebuild in Phase 2 — causing drag-and-drop stutter and double flicker.
		const isTransitioningToRunning = data.status === TaskBoardStatus.Running && updated.status !== TaskBoardStatus.Running;
		if (!isTransitioningToRunning) {
			this._onDidChangeTaskBoard.fire();
		}
		this.logService.trace(`[AgentStudio] TaskBoard: updated task ${id}`);
		console.info(`[ChatFlickerDiag] TaskBoard updateTask FIRE id=${id} status=${data.status ?? 'unchanged'} fireSkipped=${isTransitioningToRunning}`);
		// may be slow (network / spawn) and must not block other task mutations.
		// The agent assignment is persisted via a second small queued update.
		if (data.status === TaskBoardStatus.Running && updated.workspaceId) {
			const tStart = performance.now();
			try {
				console.info(`[TaskExecDiag] updateTask → ensureTaskAgent START id=${id}`);
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
				console.info(`[TaskExecDiag] ensureTaskAgent DONE id=${id} elapsed=${(performance.now() - tStart).toFixed(0)}ms result=${!!result}`);
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
					console.info(`[ChatFlickerDiag] TaskBoard ensureTaskAgent FIRE id=${id} assignee=${result.assigneeId}`);

					// Resolve attachment content (files/images) and forward to the agent
					// so the executing agent receives the same context the user attached
					// to the task card (previously attachments were silently dropped).
					const tAttach = performance.now();
					const attachments = await this._resolveAttachmentPayloads(updated);
					console.info(`[TaskExecDiag] _resolveAttachmentPayloads DONE id=${id} count=${attachments?.length ?? 0} elapsed=${(performance.now() - tAttach).toFixed(0)}ms`);

					// Fire-and-forget: invoke the agent to actually execute the task
					console.info(`[TaskExecDiag] executeTaskForBoard START id=${id} totalElapsed=${(performance.now() - tStart).toFixed(0)}ms`);
					this.orchestrationService.executeTaskForBoard(
						updated.workspaceId!,
						id,
						{ title: updated.title, description: updated.description, assigneeId: result.assigneeId, assigneeName: result.assigneeName, sourceId: updated.sourceId, worktreePath: updated.worktreePath, workflowId: updated.workflowId, variableValues: updated.variableValues, attachments, providerId: updated.providerId, modelId: updated.modelId },
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

		console.info(`[TaskPerfDiag] updateTask DONE id=${id} status=${data.status ?? 'unchanged'} phase1=${(tPhase1 - t0).toFixed(0)}ms phase2=${(performance.now() - tPhase1).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
		return updated;
	}

	async updateTaskStatus(id: string, status: TaskBoardStatus): Promise<TaskBoardRecord> {
		const t0 = performance.now();
		const result = await this.updateTask(id, { status });
		console.info(`[TaskPerfDiag] updateTaskStatus id=${id} status=${status} elapsed=${(performance.now() - t0).toFixed(0)}ms`);
		return result;
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

	// ─── Board hyperlinks (看板超链接) ───────────────────────────────────

	private async _readBoardLinks(): Promise<BoardLink[]> {
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_BOARDLINKS);
			const content = await this.fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString());
			return Array.isArray(parsed) ? parsed as BoardLink[] : [];
		} catch {
			return [];
		}
	}

	private async _writeBoardLinks(links: BoardLink[]): Promise<void> {
		const uri = URI.joinPath(this._getDataUri(), DATA_FILE_BOARDLINKS);
		const content = VSBuffer.fromString(JSON.stringify(links, null, 2));
		await this._atomicWriteFile(uri, content);
	}

	/** Run a read-modify-write cycle against the board-link list (serialized). */
	private _withBoardLinks<R>(mutate: (links: BoardLink[]) => Promise<R> | R): Promise<R> {
		return this._boardWriteQueue.queue(async () => {
			const links = await this._readBoardLinks();
			const result = await mutate(links);
			await this._writeBoardLinks(links);
			return result;
		}) as Promise<R>;
	}

	/** List all pinned board hyperlinks. */
	async listBoardLinks(): Promise<BoardLink[]> {
		return await this._readBoardLinks();
	}

	/** Add a new board hyperlink. */
	async addBoardLink(name: string, url: string): Promise<BoardLink> {
		const trimmedName = name.trim() || '未命名看板';
		const trimmedUrl = url.trim();
		if (!trimmedUrl) {
			throw new Error('看板链接 URL 不能为空');
		}
		try {
			// Basic sanity check: must be an http(s) URL.
			const parsed = new URL(trimmedUrl);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				throw new Error('仅支持 http/https 链接');
			}
		} catch (e) {
			throw new Error(`无效的链接地址: ${e instanceof Error ? e.message : String(e)}`);
		}

		const link: BoardLink = {
			id: `link_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
			name: trimmedName,
			url: trimmedUrl,
			createdAt: new Date().toISOString(),
		};
		await this._withBoardLinks(links => { links.push(link); });
		this._onDidChangeBoardLinks.fire();
		this.logService.trace(`[AgentStudio] BoardLink: added ${link.id} (${link.name})`);
		return link;
	}

	/** Update an existing board hyperlink's name and/or URL. */
	async updateBoardLink(id: string, name: string, url: string): Promise<BoardLink> {
		const trimmedName = name.trim() || '未命名看板';
		const trimmedUrl = url.trim();
		if (!trimmedUrl) {
			throw new Error('看板链接 URL 不能为空');
		}
		try {
			const parsed = new URL(trimmedUrl);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				throw new Error('仅支持 http/https 链接');
			}
		} catch (e) {
			throw new Error(`无效的链接地址: ${e instanceof Error ? e.message : String(e)}`);
		}

		let updated: BoardLink | undefined;
		await this._withBoardLinks(links => {
			const link = links.find(l => l.id === id);
			if (!link) { throw new Error(`看板超链接 ${id} 不存在`); }
			link.name = trimmedName;
			link.url = trimmedUrl;
			updated = link;
		});
		this._onDidChangeBoardLinks.fire();
		this.logService.trace(`[AgentStudio] BoardLink: updated ${id} (${trimmedName})`);
		return updated!;
	}

	/** Remove a board hyperlink by id. */
	async removeBoardLink(id: string): Promise<void> {
		await this._withBoardLinks(links => {
			const idx = links.findIndex(l => l.id === id);
			if (idx !== -1) { links.splice(idx, 1); }
		});
		this._onDidChangeBoardLinks.fire();
		this.logService.trace(`[AgentStudio] BoardLink: removed ${id}`);
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

	/**
	 * Resolve a task's attachment *metadata* into concrete `IChatAttachmentSend`
	 * payloads (with content) suitable for forwarding to the agent's
	 * `sendMessage`. Attachment content is stored host-side as side files, so we
	 * read each one back and inline it here.
	 *
	 * - Images (`image/*`): kept as base64 (`data` field).
	 * - Text files (`text/*`): decoded to raw text so the agent sees the actual
	 *   content rather than a base64 blob.
	 * - Other binaries: kept as base64.
	 *
	 * Failures reading a single attachment are logged and skipped so one bad
	 * file never blocks task execution.
	 */
	private async _resolveAttachmentPayloads(task: TaskBoardRecord): Promise<IChatAttachmentSend[]> {
		const attachments = task.attachments;
		if (!attachments || attachments.length === 0) {
			return [];
		}
		const payloads: IChatAttachmentSend[] = [];
		for (const att of attachments) {
			try {
				const base64 = await this.readAttachment(task.id, att.id);
				const isImage = att.mimeType.startsWith('image/');
				const data = (!isImage && att.mimeType.startsWith('text/'))
					? decodeBase64(base64).toString()
					: base64;
				payloads.push({
					id: att.id,
					type: isImage ? 'image' : 'file',
					name: att.name,
					mimeType: att.mimeType,
					data,
					size: att.size,
				});
			} catch (err) {
				this.logService.warn(`[AgentStudio] TaskBoard: failed to read attachment ${att.id} for task ${task.id}:`, err);
			}
		}
		return payloads;
	}

	/**
	 * Download `url` once and return everything needed for both the task
	 * description (local temp path) and attachment metadata (name / mimeType /
	 * base64). This avoids downloading the same URL twice when importing TAPD
	 * workitems — the caller can later call `addAttachment` with the returned
	 * base64 + mimeType + name.
	 *
	 * Same auth semantics as `downloadUrlToTemp` (Playwright browser context
	 * cookies via `downloadBinary`).
	 */
	/**
	 * Resolve the download directory for task attachments.
	 * Prefers `{activeWorkspace.path}/.sarosworkspace/tmp/task-downloads/`
	 * (workspace-local, survives across sessions). Falls back to the
	 * agent-studio data dir if no workspace is active.
	 */
	private async _getDownloadDir(): Promise<URI> {
		try {
			const wsId = this.agentStudioService.getActiveWorkspaceId();
			if (wsId) {
				const ws = await this.agentStudioService.getWorkspace(wsId);
				if (ws?.path) {
					return URI.joinPath(URI.file(ws.path), '.sarosworkspace', 'tmp', 'task-downloads');
				}
			}
		} catch { /* fall through */ }
		// Fallback: agent-studio data directory
		return URI.joinPath(this._getDataUri(), 'tmp', 'task-downloads');
	}

	async downloadUrlForAttachment(url: string, opts?: { sessionId?: string; viewId?: string; filename?: string; subDir?: string; extractZip?: boolean }): Promise<{ name: string; mimeType: string; base64: string; tempPath: string; isZip?: boolean; extractedFiles?: { name: string; relPath: string; isImage: boolean; dataUri?: string }[] } | undefined> {
		const sessionId = opts?.sessionId ?? SAROS_CLAW_AGENT_ID;
		const viewId = await this._resolveDownloadViewId(sessionId, opts?.viewId);
		if (!viewId) { return undefined; }
		try {
			this.logService.info(`[TaskBoard] downloadUrlForAttachment via Playwright: url=${url} view=${viewId}`);
			const dl = await this.playwrightService.downloadBinary(sessionId, viewId, url);
			this.logService.info(`[TaskBoard] downloadUrlForAttachment status=${dl.status} contentType="${dl.contentType}" base64Len=${dl.base64.length}`);
			if (!dl.ok) { this.logService.warn(`[TaskBoard] downloadUrlForAttachment HTTP ${dl.status}: ${url}`); return undefined; }
			if (dl.contentType.includes('text/html')) { this.logService.warn(`[TaskBoard] downloadUrlForAttachment got HTML (not a real file): ${url}`); return undefined; }
			// Prefer the caller-supplied filename (the real TAPD attachment name)
			// over deriving one from the (often opaque) URL path.
			const name = (opts?.filename && opts.filename.trim())
				? opts.filename.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 200)
				: this._filenameFromUrl(url, dl.contentDisposition);
			// Playwright may return generic "image" contentType without a
			// subtype (e.g. "image" instead of "image/png").  Derive a
			// proper MIME from the file extension so downstream code can
			// correctly detect images (dl.mimeType.startsWith('image/')).
			let mimeType = dl.contentType || 'application/octet-stream';
			if (mimeType === 'image') {
				mimeType = _mimeFromName(name);
			}
			const tmpDir = await this._getDownloadDir();
			const targetDir = opts?.subDir ? URI.joinPath(tmpDir, opts.subDir) : tmpDir;
			const uri = URI.joinPath(targetDir, name);
			const content = decodeBase64(dl.base64);
			await this.fileService.createFile(uri, content, { overwrite: true });
			this.logService.info(`[TaskBoard] downloadUrlForAttachment OK: ${url} → ${uri.fsPath} (${content.byteLength} bytes)`);

			const isZip = /\.zip$/i.test(name) || mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed';
			let extractedFiles: { name: string; relPath: string; isImage: boolean; dataUri?: string }[] | undefined;
			if (isZip && (opts?.extractZip ?? true)) {
				try {
					// Use a separate subdirectory for extraction to avoid naming
					// collision when the zip file is saved with the same basename
					// as the target extraction directory (e.g. "story" file + "story/" dir).
					const extractSubDir = (opts?.subDir ?? '') + '/' + name + '_extracted';
					extractedFiles = await this._extractZipAndCollect(uri.fsPath, targetDir.fsPath, extractSubDir);
					this.logService.info(`[TaskBoard] extracted ${extractedFiles.length} file(s) from ${name}`);
				} catch (zipErr) {
					this.logService.warn('[TaskBoard] downloadUrlForAttachment zip extraction failed:', zipErr);
				}
			}

			return { name, mimeType, base64: dl.base64, tempPath: uri.fsPath, isZip, extractedFiles };
		} catch (err) {
			this.logService.warn('[TaskBoard] downloadUrlForAttachment unexpected error:', err);
			return undefined;
		}
	}

	/** Extract a zip archive and collect its entries (relative to the download root).
	 *  Image entries are read back and embedded as data URIs so the webview can
	 *  render them without hitting the `file://` CSP restriction.
	 *
	 *  Uses a pure-JS ZIP parser that works in the Electron renderer process
	 *  (no `fs`, no Node builtins).  Deflated entries are inflated via the
	 *  `pako` library when available; stored entries are always handled. */
	private async _extractZipAndCollect(zipPath: string, targetDir: string, subDir: string): Promise<{ name: string; relPath: string; isImage: boolean; dataUri?: string }[]> {
		// 1. Read the zip file into a byte buffer
		const zipContent = await this.fileService.readFile(URI.file(zipPath));
		const data = zipContent.value.buffer as Uint8Array;

		// 2. Browser-native decompression (DecompressionStream API available in
		//    Electron/Chromium renderer). We resolve it once so every compressed
		//    entry can reuse the helper without repeating feature-detection.
		const canDeflate = typeof DecompressionStream !== 'undefined';
		const inflateRaw = canDeflate
			? async (d: Uint8Array): Promise<Uint8Array> => {
				const ds = new DecompressionStream('deflate-raw') as TransformStream<Uint8Array, Uint8Array>;
				const writer = ds.writable.getWriter();
				writer.write(d);
				writer.close();
				const reader = ds.readable.getReader();
				const chunks: Uint8Array[] = [];
				while (true) {
					const { done, value } = await reader.read();
					if (done) { break; }
					chunks.push(value);
				}
				// Concatenate all chunks
				const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
				const out = new Uint8Array(totalLen);
				let pos = 0;
				for (const c of chunks) { out.set(c, pos); pos += c.byteLength; }
				return out;
			}
			: undefined;
		if (!canDeflate) {
			this.logService.warn('[TaskBoard] _extractZipAndCollect: DecompressionStream not available, will skip compressed entries');
		}

		// 3. Find End of Central Directory record
		const eocd = _findEOCD(data);
		if (!eocd) { throw new Error('Invalid zip: EOCD not found'); }

		// 4. Parse central directory entries
		const { entries, baseName } = _parseCentralDir(data, eocd, zipPath);
		if (!entries.length) { this.logService.warn('[TaskBoard] _extractZipAndCollect: no entries in zip, returning empty'); return []; }

		// 5. Determine the parent directory prefix for relative paths
		const subPrefix = subDir ? subDir + '/' : '';

		// 6. Process each entry
		const out: { name: string; relPath: string; isImage: boolean; dataUri?: string }[] = [];
		for (const entry of entries) {
			try {
				// Skip directory entries (filename ends with /)
				if (entry.fileName.endsWith('/') || entry.fileName.endsWith('\\')) { continue; }

				// Extract file data
				const rawData = await _readLocalFile(data, entry, inflateRaw);
				if (!rawData) {
					this.logService.warn(`[TaskBoard] _extractZipAndCollect: skipped ${entry.fileName} (compressed and no inflater available)`);
					continue;
				}

				// Derive the simple filename (last segment of entry path)
				const leafName = entry.fileName.replace(/\\/g, '/').split('/').pop() || entry.fileName;

				// Write to disk under targetDir/<subDir leaf> or targetDir/<zipBaseName>
				const extractBase = subDir
					? subDir.replace(/\\/g, '/').split('/').pop()!
					: nodePath.basename(zipPath).replace(/\.zip$/i, '');
				const extractDir = nodePath.join(targetDir, extractBase);
				const outPath = nodePath.join(extractDir, entry.fileName);

				// Ensure parent directories exist
				const parentDir = nodePath.dirname(outPath);
				try {
					const parentUri = URI.file(parentDir);
					await this.fileService.createFolder(parentUri);
				} catch { /* folder may already exist */ }

				// Write extracted file
				const outUri = URI.file(outPath);
				const outBuf = VSBuffer.wrap(rawData);
				await this.fileService.createFile(outUri, outBuf, { overwrite: true });

				const isImage = _isImageName(leafName);
				let dataUri: string | undefined;
				if (isImage) {
					try {
						dataUri = `data:${_mimeFromName(leafName)};base64,${encodeBase64(outBuf)}`;
					} catch { /* leave dataUri undefined */ }
				}
				const relPath = `.sarosworkspace/tmp/task-downloads/${subPrefix}${baseName}/${entry.fileName.replace(/\\/g, '/')}`;
				out.push({ name: leafName, relPath, isImage, dataUri });
			} catch (entryErr) {
				this.logService.warn(`[TaskBoard] _extractZipAndCollect: failed to extract ${entry.fileName}:`, entryErr);
			}
		}
		return out;
	}

	/**
	 * Download `url` to a local temp file and return its filesystem path.
	 *
	 * The renderer process cannot issue `node:https` requests (the CSP
	 * `script-src` directive blocks `import('node:https')`, and `require` is not
	 * exposed here), and a plain `fetch` cannot carry the TAPD session cookie.
	 * So we delegate the actual HTTP download to the **Playwright browser
	 * context** that is already logged into TAPD: `page.request.fetch` reuses the
	 * context's cookies and is not subject to CORS, so authenticated attachments
	 * (including cross-origin `file.tapd.cn` images) download correctly.
	 *
	 * @param opts.sessionId Playwright session id. Defaults to the Saros Claw
	 *   agent session (the one used for TAPD extraction).
	 * @param opts.viewId The browser view id whose context provides the auth
	 *   cookies. When omitted we try to locate a tracked TAPD page automatically.
	 */
	async downloadUrlToTemp(url: string, opts?: { sessionId?: string; viewId?: string }): Promise<string | undefined> {
		const sessionId = opts?.sessionId ?? SAROS_CLAW_AGENT_ID;
		const viewId = await this._resolveDownloadViewId(sessionId, opts?.viewId);
		if (!viewId) {
			this.logService.warn('[TaskBoard] downloadUrlToTemp: no browser view available (cannot authenticate download)');
			return undefined;
		}
		try {
			this.logService.info(`[TaskBoard] downloadUrlToTemp via Playwright: url=${url} view=${viewId}`);
			const dl = await this.playwrightService.downloadBinary(sessionId, viewId, url);
			this.logService.info(`[TaskBoard] downloadUrlToTemp status=${dl.status} contentType="${dl.contentType}" base64Len=${dl.base64.length}`);
			if (!dl.ok) {
				this.logService.warn(`[TaskBoard] downloadUrlToTemp HTTP ${dl.status}: ${url}`);
				return undefined;
			}
			if (dl.contentType.includes('text/html')) {
				this.logService.warn(`[TaskBoard] downloadUrlToTemp got HTML (likely TAPD login page / auth required, not a real file): ${url}`);
			}
			const tmpDir = await this._getDownloadDir();
			const filename = this._filenameFromUrl(url, dl.contentDisposition);
			const uri = URI.joinPath(tmpDir, filename);
			// createFile (not writeFile) so the parent temp dir is created if missing.
			const content = decodeBase64(dl.base64);
			await this.fileService.createFile(uri, content, { overwrite: true });
			this.logService.info(`[TaskBoard] downloadUrlToTemp OK: ${url} → ${uri.fsPath} (${content.byteLength} bytes)`);
			return uri.fsPath;
		} catch (err) {
			this.logService.warn('[TaskBoard] downloadUrlToTemp unexpected error:', err);
			return undefined;
		}
	}

	/** Derive a safe local filename from a URL (last path segment, or a time-based fallback).
	 *  If a Content-Disposition header is provided, it takes priority for extracting
	 *  the real server-side filename (e.g. ZIP files from TAPD where URL path is /story). */
	private _filenameFromUrl(url: string, contentDisposition = ''): string {
		// Priority: Content-Disposition header → URL pathname → timestamp fallback
		if (contentDisposition) {
			// Try: attachment; filename="20260706T103214.zip" or filename*=UTF-8''...
			const cdMatch = contentDisposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
			if (cdMatch?.[1] || cdMatch?.[2]) {
				const raw = decodeURIComponent(cdMatch[1] || cdMatch[2]);
				const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
				if (cleaned) { return cleaned; }
			}
		}
		try {
			const urlObj = new URL(url);
			const raw = decodeURIComponent(urlObj.pathname.split('/').pop() || '');
			if (raw) {
				// Strip a trailing query-only separator and keep it filesystem-safe.
				const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
				if (cleaned) { return cleaned; }
			}
		} catch {
			/* fall through */
		}
		return `file_${Date.now()}.bin`;
	}

	/** Resolve a viewId for authenticated downloads, with fallback logic. */
	private async _resolveDownloadViewId(sessionId: string, preferredViewId?: string): Promise<string | undefined> {
		if (preferredViewId) { return preferredViewId; }
		try {
			const tapdView = await this._findTapdViewId(sessionId);
			if (tapdView) { return tapdView; }
		} catch { /* fall through */ }
		// If no TAPD-specific view is tracked, try any tracked page as
		// a fallback viewId. PlaywrightSession.downloadBinary has a
		// session-level `_tapdCookies` fallback that will provide auth
		// even if the original browser view has been closed.
		const pages = await this.playwrightService.getTrackedPages();
		if (pages.length > 0) {
			this.logService.trace(`[TaskBoard] _resolveDownloadViewId: no TAPD view found, falling back to viewId=${pages[0]} (session cookies will provide auth)`);
			return pages[0];
		}
		return undefined;
	}

	/** Scan tracked pages for one whose summary references tapd.cn (best-effort). */
	private async _findTapdViewId(sessionId: string): Promise<string | undefined> {
		const pages = await this.playwrightService.getTrackedPages();
		for (const vid of pages) {
			try {
				const summary = await this.playwrightService.getSummary(sessionId, vid);
				if (summary && summary.includes('tapd.cn')) {
					return vid;
				}
			} catch {
				/* page may have been closed — skip */
			}
		}
		return undefined;
	}
}
