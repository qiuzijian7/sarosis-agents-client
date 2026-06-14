/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IAgentStudioService } from '../../../common/agentStudioService.js';
import { ICheckpointService } from '../common/checkpointService.js';
import {
	ICheckpoint,
	ICheckpointFileChange,
	ICreateCheckpointPayload,
	IJumpToCheckpointResult,
	IFileSnapshot,
} from '../common/checkpointTypes.js';

/**
 * On-disk shape for a persisted checkpoint (metadata only; file snapshots are
 * stored separately as one JSON file per snapshot so that large file contents
 * don't bloat the index).
 */
interface IStoredCheckpoint {
	readonly id: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly type: 'user_edit' | 'tool_edit';
	readonly label: string;
	readonly description: string | undefined;
	readonly createdAt: number;
	readonly fileSnapshotIds: string[];
	isGhost: boolean;
	readonly messageId: string | undefined;
	readonly files?: ICheckpointFileChange[];
}

/** On-disk shape for a single file snapshot. */
interface IStoredFileSnapshot {
	readonly id: string;
	readonly checkpointId: string;
	readonly uri: string; // URI.toString()
	readonly languageId: string | undefined;
	readonly content: string;
	/**
	 * Whether the file already existed on disk at snapshot time. `false` →
	 * the edit created the file, so reverting must delete it. Optional for
	 * backward-compat (absent = treat as existed → restore-by-write).
	 */
	readonly existedBefore?: boolean;
}

/**
 * Browser-layer checkpoint service backed by {@link IFileService} + JSON.
 *
 * Storage layout (under the workspace home dir):
 *   <home>/.sarosworkspace/checkpoints/<agentId>/<sessionId>/index.json
 *   <home>/.sarosworkspace/checkpoints/<agentId>/<sessionId>/snapshots/<snapshotId>.json
 *
 * The index file holds the ordered checkpoint metadata array; each snapshot is
 * its own file. When no workspace home dir can be resolved we fall back to the
 * environment user-data dir so the feature still works for legacy/virtual
 * workspaces.
 */
export class CheckpointService extends Disposable implements ICheckpointService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidCreateCheckpoint = this._register(new Emitter<ICheckpoint>());
	readonly onDidCreateCheckpoint: Event<ICheckpoint> = this._onDidCreateCheckpoint.event;

	/** agentId → active sessionId, set by the controller when streaming starts. */
	private readonly _activeSessions = new Map<string, string>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IAgentStudioService private readonly studioService: IAgentStudioService,
	) {
		super();
	}

	// ─── Active session tracking (for tool-edit capture) ──────────────────────

	setActiveSession(agentId: string, sessionId: string): void {
		this._activeSessions.set(agentId, sessionId);
	}

	async captureBeforeToolEdit(agentId: string, fileUri: string, newContent?: string): Promise<void> {
		const sessionId = this._activeSessions.get(agentId);
		if (!sessionId) {
			// No active session registered → cannot scope storage. Skip silently.
			return;
		}
		// Derive a short, human-readable file name for the checkpoint label
		// instead of dumping the full URI (which is noisy in the card).
		let resource: URI;
		try {
			resource = URI.parse(fileUri);
		} catch {
			resource = URI.file(fileUri);
		}
		const segments = resource.path.split('/').filter(Boolean);
		const shortName = segments[segments.length - 1] || fileUri;

		// Compute additions/deletions vs. the file's pre-edit content so the
		// checkpoint bar can show "+N -N" like Void / GitHub diff stats.
		let oldContent = '';
		try {
			if (await this.fileService.exists(resource)) {
				oldContent = (await this.fileService.readFile(resource)).value.toString();
			}
		} catch {
			/* treat unreadable as empty (new file) */
		}
		const { additions, deletions } = this._computeLineDiff(oldContent, newContent ?? '');
		const fileChange: ICheckpointFileChange = {
			uri: resource.toString(),
			fileName: shortName,
			fsPath: resource.fsPath,
			additions,
			deletions,
		};

		try {
			await this.createCheckpointFromUris(agentId, sessionId, 'tool_edit', [fileUri], {
				label: `编辑 ${shortName}`,
				description: `${shortName} 文件变更`,
				files: [fileChange],
			});
		} catch (err) {
			this.logService.warn(`[CheckpointService] captureBeforeToolEdit failed for ${fileUri}: ${err}`);
		}
	}

	/**
	 * Compute a coarse line-level diff (added/removed line counts) between two
	 * text blobs. This is a lightweight LCS-free heuristic sufficient for the
	 * checkpoint bar's "+N -N" badge: lines present only in `next` count as
	 * additions, lines present only in `prev` count as deletions (multiset diff).
	 */
	private _computeLineDiff(prev: string, next: string): { additions: number; deletions: number } {
		if (prev === next) {
			return { additions: 0, deletions: 0 };
		}
		const prevLines = prev.length ? prev.split('\n') : [];
		const nextLines = next.length ? next.split('\n') : [];
		// Multiset counts so reordering doesn't inflate the diff too much.
		const count = new Map<string, number>();
		for (const l of prevLines) { count.set(l, (count.get(l) ?? 0) + 1); }
		let additions = 0;
		for (const l of nextLines) {
			const c = count.get(l) ?? 0;
			if (c > 0) { count.set(l, c - 1); } else { additions++; }
		}
		let deletions = 0;
		for (const c of count.values()) { deletions += c; }
		return { additions, deletions };
	}

	// ─── Storage path resolution ────────────────────────────────────────────

	/**
	 * Resolve the base directory for an agent's checkpoint storage.
	 * Prefers the workspace home dir (Workspace.path); falls back to the
	 * environment user-data dir.
	 */
	private async _resolveSessionDir(agentId: string, sessionId: string): Promise<URI> {
		let baseDir: URI | undefined;
		try {
			// Agent is global; the runtime workspace is resolved from the session
			// (sessionId → session.workspaceId), falling back to the active workspace.
			let workspaceId: string | undefined;
			try {
				const session = await this.studioService.getSession(sessionId);
				workspaceId = session?.workspaceId;
			} catch {
				// ignore — fall through to active workspace
			}
			if (!workspaceId) {
				workspaceId = this.studioService.getActiveWorkspaceId();
			}
			if (workspaceId) {
				const workspace = await this.studioService.getWorkspace(workspaceId);
				if (workspace?.path) {
					baseDir = URI.file(workspace.path);
				}
			}
		} catch (err) {
			this.logService.warn(`[CheckpointService] Failed to resolve workspace home for ${agentId}: ${err}`);
		}

		if (!baseDir) {
			// Fallback: user-data dir keeps the feature alive for virtual workspaces.
			baseDir = joinPath(this.environmentService.userRoamingDataHome, 'saros-checkpoints');
		}

		return joinPath(baseDir, '.sarosworkspace', 'checkpoints', agentId, sessionId);
	}

	private _indexUri(sessionDir: URI): URI {
		return joinPath(sessionDir, 'index.json');
	}

	private _snapshotUri(sessionDir: URI, snapshotId: string): URI {
		return joinPath(sessionDir, 'snapshots', `${snapshotId}.json`);
	}

	// ─── Index read / write ──────────────────────────────────────────────────

	private async _readIndex(sessionDir: URI): Promise<IStoredCheckpoint[]> {
		const indexUri = this._indexUri(sessionDir);
		try {
			if (!(await this.fileService.exists(indexUri))) {
				return [];
			}
			const content = await this.fileService.readFile(indexUri);
			const parsed = JSON.parse(content.value.toString());
			return Array.isArray(parsed) ? parsed as IStoredCheckpoint[] : [];
		} catch (err) {
			this.logService.error(`[CheckpointService] Failed to read index ${indexUri.toString()}: ${err}`);
			return [];
		}
	}

	private async _writeIndex(sessionDir: URI, checkpoints: IStoredCheckpoint[]): Promise<void> {
		const indexUri = this._indexUri(sessionDir);
		const json = JSON.stringify(checkpoints, null, 2);
		await this.fileService.writeFile(indexUri, VSBuffer.fromString(json));
	}

	// ─── Snapshot read / write ────────────────────────────────────────────────

	private async _writeSnapshot(sessionDir: URI, snapshot: IStoredFileSnapshot): Promise<void> {
		const uri = this._snapshotUri(sessionDir, snapshot.id);
		const json = JSON.stringify(snapshot, null, 2);
		await this.fileService.writeFile(uri, VSBuffer.fromString(json));
	}

	private async _readSnapshot(sessionDir: URI, snapshotId: string): Promise<IStoredFileSnapshot | undefined> {
		const uri = this._snapshotUri(sessionDir, snapshotId);
		try {
			if (!(await this.fileService.exists(uri))) {
				return undefined;
			}
			const content = await this.fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as IStoredFileSnapshot;
		} catch (err) {
			this.logService.error(`[CheckpointService] Failed to read snapshot ${uri.toString()}: ${err}`);
			return undefined;
		}
	}

	// ─── Mapping helpers ──────────────────────────────────────────────────────

	private _toCheckpoint(stored: IStoredCheckpoint): ICheckpoint {
		// Only emit agentId as the canonical identity field.
		return {
			id: stored.id,
			agentId: stored.agentId,
			sessionId: stored.sessionId,
			type: stored.type,
			label: stored.label,
			description: stored.description,
			createdAt: stored.createdAt,
			fileSnapshotIds: stored.fileSnapshotIds,
			isGhost: stored.isGhost,
			messageId: stored.messageId,
			files: stored.files,
		};
	}

	private _getDefaultLabel(type: 'user_edit' | 'tool_edit'): string {
		const now = new Date();
		const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		return type === 'user_edit' ? `User edit at ${timeStr}` : `Tool edit at ${timeStr}`;
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	async createCheckpoint(payload: ICreateCheckpointPayload): Promise<ICheckpoint> {
		const agentId = payload.agentId;
		if (!agentId) {
			throw new Error('[CheckpointService] createCheckpoint: agentId is required');
		}
		const sessionDir = await this._resolveSessionDir(agentId, payload.sessionId);
		const checkpointId = generateUuid();

		// Persist each file snapshot as its own file.
		const fileSnapshotIds: string[] = [];
		for (const fileData of payload.fileSnapshots) {
			const snapshotId = generateUuid();
			const stored: IStoredFileSnapshot = {
				id: snapshotId,
				checkpointId,
				uri: fileData.uri.toString(),
				languageId: fileData.languageId,
				content: fileData.content,
				existedBefore: fileData.existedBefore,
			};
			try {
				await this._writeSnapshot(sessionDir, stored);
				fileSnapshotIds.push(snapshotId);
			} catch (err) {
				this.logService.error(`[CheckpointService] Failed to write snapshot for ${fileData.uri.toString()}: ${err}`);
			}
		}

		const stored: IStoredCheckpoint = {
			id: checkpointId,
			agentId,
			sessionId: payload.sessionId,
			type: payload.type,
			label: payload.label || this._getDefaultLabel(payload.type),
			description: payload.description,
			createdAt: Date.now(),
			fileSnapshotIds,
			isGhost: false,
			messageId: payload.messageId,
			files: payload.files,
		};

		const index = await this._readIndex(sessionDir);
		index.push(stored);
		await this._writeIndex(sessionDir, index);

		this.logService.info(
			`[CheckpointService] Created checkpoint ${checkpointId} (${payload.type}) with ${fileSnapshotIds.length} snapshots`,
		);
		const result = this._toCheckpoint(stored);
		this._onDidCreateCheckpoint.fire(result);
		return result;
	}

	async createCheckpointFromUris(
		agentId: string,
		sessionId: string,
		type: 'user_edit' | 'tool_edit',
		fileUris: string[],
		opts?: { label?: string; description?: string; messageId?: string; files?: ICheckpointFileChange[] },
	): Promise<ICheckpoint | undefined> {
		// Read current on-disk content of each file (skip ones that don't exist).
		const fileSnapshots = [];
		for (const uriStr of fileUris) {
			let resource: URI;
			try {
				resource = URI.parse(uriStr);
			} catch {
				// Treat as a filesystem path.
				resource = URI.file(uriStr);
			}
			try {
				if (await this.fileService.exists(resource)) {
					const content = await this.fileService.readFile(resource);
					fileSnapshots.push({
						uri: resource,
						languageId: undefined,
						content: content.value.toString(),
						existedBefore: true,
					});
				} else {
					// File not yet created — record an empty-content snapshot flagged
					// as existedBefore:false so that reverting DELETES the new file
					// rather than leaving an empty file behind.
					fileSnapshots.push({
						uri: resource,
						languageId: undefined,
						content: '',
						existedBefore: false,
					});
				}
			} catch (err) {
				this.logService.warn(`[CheckpointService] Skip unreadable file ${uriStr}: ${err}`);
			}
		}

		if (fileSnapshots.length === 0) {
			this.logService.info('[CheckpointService] createCheckpointFromUris: no files to snapshot, skipping');
			return undefined;
		}

		return this.createCheckpoint({
			agentId,
			sessionId,
			type,
			label: opts?.label,
			description: opts?.description,
			fileSnapshots,
			messageId: opts?.messageId,
			files: opts?.files,
		});
	}

	async jumpToCheckpoint(agentId: string, sessionId: string, checkpointId: string): Promise<IJumpToCheckpointResult> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const target = index.find(cp => cp.id === checkpointId);
		if (!target) {
			throw new Error(`Checkpoint not found: ${checkpointId}`);
		}

		// 1. Restore each file snapshot's content.
		const restoredFiles: string[] = [];
		for (const snapshotId of target.fileSnapshotIds) {
			const snapshot = await this._readSnapshot(sessionDir, snapshotId);
			if (!snapshot) {
				continue;
			}
			try {
				const resource = URI.parse(snapshot.uri);
				// existedBefore === false 表示该文件是这次编辑“新建”的，
				// 撤销应当删除它，而不是写入空内容（否则会残留一个空文件）。
				// 旧快照没有该字段（undefined）时按“原本存在”处理，沿用写回逻辑。
				if (snapshot.existedBefore === false) {
					if (await this.fileService.exists(resource)) {
						await this.fileService.del(resource);
					}
					restoredFiles.push(snapshot.uri);
				} else {
					await this.fileService.writeFile(resource, VSBuffer.fromString(snapshot.content));
					restoredFiles.push(snapshot.uri);
				}
			} catch (err) {
				this.logService.error(`[CheckpointService] Failed to restore ${snapshot.uri}: ${err}`);
			}
		}

		// 2. Mark all checkpoints created after the target as ghost (unreachable).
		let removedCount = 0;
		for (const cp of index) {
			if (cp.createdAt > target.createdAt && !cp.isGhost) {
				cp.isGhost = true;
				removedCount++;
			}
		}
		await this._writeIndex(sessionDir, index);

		this.logService.info(
			`[CheckpointService] Jumped to ${checkpointId}: restored ${restoredFiles.length} files, ghosted ${removedCount} checkpoints`,
		);

		return {
			checkpointId,
			restoredFiles,
			removedMessages: removedCount, // host maps this; webview truncates by messageId
		};
	}

	/**
	 * 聚合所有（非 ghost）检查点，对每个被改过的文件取其**最早一次**快照
	 * （= 第一次被编辑前的原始内容），把文件还原到该最初状态：
	 *   - `existedBefore === false` 的最早快照 → 该文件是被新建出来的，删除它；
	 *   - 否则写回最早快照内容。
	 * 还原完成后把所有检查点标记为 ghost。
	 *
	 * 这是"撤销全部修改"的正确语义：不是逐个检查点回退，而是直接回到
	 * 任何检查点产生之前的最初状态。与单个 {@link jumpToCheckpoint} 不同，
	 * 后者只还原目标检查点自己的快照。
	 */
	async revertAllCheckpoints(agentId: string, sessionId: string): Promise<IJumpToCheckpointResult> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		// 仅聚合 tool_edit 且非 ghost 的检查点（ghost = 已被回退，不应再参与）。
		const active = index
			.filter(cp => cp.type === 'tool_edit' && !cp.isGhost)
			.sort((a, b) => a.createdAt - b.createdAt);

		// 每个文件 URI → 其最早一次快照（首次遇到即保留，因为已按时间升序）。
		const earliestByUri = new Map<string, IStoredFileSnapshot>();
		for (const cp of active) {
			for (const snapshotId of cp.fileSnapshotIds) {
				const snapshot = await this._readSnapshot(sessionDir, snapshotId);
				if (!snapshot) { continue; }
				if (!earliestByUri.has(snapshot.uri)) {
					earliestByUri.set(snapshot.uri, snapshot);
				}
			}
		}

		const restoredFiles: string[] = [];
		for (const snapshot of earliestByUri.values()) {
			try {
				const resource = URI.parse(snapshot.uri);
				if (snapshot.existedBefore === false) {
					// 文件是被新建出来的 → 撤销即删除。
					if (await this.fileService.exists(resource)) {
						await this.fileService.del(resource);
					}
					restoredFiles.push(snapshot.uri);
				} else {
					await this.fileService.writeFile(resource, VSBuffer.fromString(snapshot.content));
					restoredFiles.push(snapshot.uri);
				}
			} catch (err) {
				this.logService.error(`[CheckpointService] revertAll: failed to restore ${snapshot.uri}: ${err}`);
			}
		}

		// 全部标 ghost（已回退，不再可达）。
		let ghosted = 0;
		for (const cp of index) {
			if (!cp.isGhost) { cp.isGhost = true; ghosted++; }
		}
		await this._writeIndex(sessionDir, index);

		this.logService.info(
			`[CheckpointService] revertAllCheckpoints: restored ${restoredFiles.length} files to original, ghosted ${ghosted} checkpoints`,
		);

		return {
			checkpointId: '',
			restoredFiles,
			removedMessages: ghosted,
		};
	}

	/**
	 * 聚合所有（非 ghost）tool_edit 检查点，返回每个被改过文件的**最早一次**
	 * 快照（首次编辑前的原始内容）。供"查看全部变更"在一个多文件 diff 窗口
	 * 中对比"最初内容 vs 当前内容"。
	 */
	async getAggregatedFileSnapshots(agentId: string, sessionId: string): Promise<IFileSnapshot[]> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const active = index
			.filter(cp => cp.type === 'tool_edit' && !cp.isGhost)
			.sort((a, b) => a.createdAt - b.createdAt);

		const earliestByUri = new Map<string, IFileSnapshot>();
		for (const cp of active) {
			for (const snapshotId of cp.fileSnapshotIds) {
				const stored = await this._readSnapshot(sessionDir, snapshotId);
				if (!stored) { continue; }
				if (!earliestByUri.has(stored.uri)) {
					earliestByUri.set(stored.uri, {
						id: stored.id,
						checkpointId: stored.checkpointId,
						uri: URI.parse(stored.uri),
						languageId: stored.languageId,
						content: stored.content,
						existedBefore: stored.existedBefore,
					});
				}
			}
		}
		return [...earliestByUri.values()];
	}

	async getCheckpoint(agentId: string, sessionId: string, checkpointId: string): Promise<ICheckpoint | undefined> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const found = index.find(cp => cp.id === checkpointId);
		return found ? this._toCheckpoint(found) : undefined;
	}

	async listCheckpoints(agentId: string, sessionId: string): Promise<ICheckpoint[]> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		return index
			.slice()
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(cp => this._toCheckpoint(cp));
	}

	async deleteCheckpoint(agentId: string, sessionId: string, checkpointId: string): Promise<void> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const target = index.find(cp => cp.id === checkpointId);
		if (!target) {
			return;
		}

		// Delete snapshot files.
		for (const snapshotId of target.fileSnapshotIds) {
			const uri = this._snapshotUri(sessionDir, snapshotId);
			try {
				if (await this.fileService.exists(uri)) {
					await this.fileService.del(uri);
				}
			} catch (err) {
				this.logService.warn(`[CheckpointService] Failed to delete snapshot ${uri.toString()}: ${err}`);
			}
		}

		const next = index.filter(cp => cp.id !== checkpointId);
		await this._writeIndex(sessionDir, next);
		this.logService.info(`[CheckpointService] Deleted checkpoint ${checkpointId}`);
	}

	async deleteAllCheckpoints(agentId: string, sessionId: string): Promise<void> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		if (index.length === 0) {
			return;
		}

		// Delete all snapshot files.
		for (const cp of index) {
			for (const snapshotId of cp.fileSnapshotIds) {
				const uri = this._snapshotUri(sessionDir, snapshotId);
				try {
					if (await this.fileService.exists(uri)) {
						await this.fileService.del(uri);
					}
				} catch (err) {
					this.logService.warn(`[CheckpointService] Failed to delete snapshot ${uri.toString()}: ${err}`);
				}
			}
		}

		await this._writeIndex(sessionDir, []);
		this.logService.info(`[CheckpointService] Deleted all ${index.length} checkpoints for session ${sessionId}`);
	}

	async getFileSnapshots(agentId: string, sessionId: string, checkpointId: string): Promise<IFileSnapshot[]> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const cp = index.find(c => c.id === checkpointId);
		if (!cp) {
			return [];
		}
		const snapshots: IFileSnapshot[] = [];
		for (const snapshotId of cp.fileSnapshotIds) {
			try {
				const uri = this._snapshotUri(sessionDir, snapshotId);
				if (!await this.fileService.exists(uri)) {
					continue;
				}
				const raw = (await this.fileService.readFile(uri)).value.toString();
				const stored: IStoredFileSnapshot = JSON.parse(raw);
				snapshots.push({
					id: stored.id,
					checkpointId: stored.checkpointId,
					uri: URI.parse(stored.uri),
					languageId: stored.languageId,
					content: stored.content,
					existedBefore: stored.existedBefore,
				});
			} catch (err) {
				this.logService.warn(`[CheckpointService] Failed to read snapshot ${snapshotId}: ${err}`);
			}
		}
		return snapshots;
	}

	async getSnapshotContentForFile(
		agentId: string,
		sessionId: string,
		checkpointId: string,
		fileUri: string,
	): Promise<string | undefined> {
		const snapshots = await this.getFileSnapshots(agentId, sessionId, checkpointId);
		const found = snapshots.find(s => s.uri.toString() === fileUri);
		return found?.content;
	}
}
