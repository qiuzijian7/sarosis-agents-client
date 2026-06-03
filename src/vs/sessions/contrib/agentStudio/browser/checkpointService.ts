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
	ICreateCheckpointPayload,
	IJumpToCheckpointResult,
} from '../common/checkpointTypes.js';

/**
 * On-disk shape for a persisted checkpoint (metadata only; file snapshots are
 * stored separately as one JSON file per snapshot so that large file contents
 * don't bloat the index).
 */
interface IStoredCheckpoint {
	readonly id: string;
	readonly employeeId: string;
	readonly sessionId: string;
	readonly type: 'user_edit' | 'tool_edit';
	readonly label: string;
	readonly description: string | undefined;
	readonly createdAt: number;
	readonly fileSnapshotIds: string[];
	isGhost: boolean;
	readonly messageId: string | undefined;
}

/** On-disk shape for a single file snapshot. */
interface IStoredFileSnapshot {
	readonly id: string;
	readonly checkpointId: string;
	readonly uri: string; // URI.toString()
	readonly languageId: string | undefined;
	readonly content: string;
}

/**
 * Browser-layer checkpoint service backed by {@link IFileService} + JSON.
 *
 * Storage layout (under the workspace home dir):
 *   <home>/.sarosisworkspace/checkpoints/<employeeId>/<sessionId>/index.json
 *   <home>/.sarosisworkspace/checkpoints/<employeeId>/<sessionId>/snapshots/<snapshotId>.json
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

	/** employeeId → active sessionId, set by the controller when streaming starts. */
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

	setActiveSession(employeeId: string, sessionId: string): void {
		this._activeSessions.set(employeeId, sessionId);
	}

	async captureBeforeToolEdit(employeeId: string, fileUri: string): Promise<void> {
		const sessionId = this._activeSessions.get(employeeId);
		if (!sessionId) {
			// No active session registered → cannot scope storage. Skip silently.
			return;
		}
		// Derive a short, human-readable file name for the checkpoint label
		// instead of dumping the full URI (which is noisy in the card).
		let shortName = fileUri;
		try {
			const parsed = URI.parse(fileUri);
			const segments = parsed.path.split('/').filter(Boolean);
			shortName = segments[segments.length - 1] || fileUri;
		} catch {
			const segs = fileUri.replace(/\\/g, '/').split('/').filter(Boolean);
			shortName = segs[segs.length - 1] || fileUri;
		}
		try {
			await this.createCheckpointFromUris(employeeId, sessionId, 'tool_edit', [fileUri], {
				label: `编辑 ${shortName}`,
				description: `编辑前快照 · ${shortName}`,
			});
		} catch (err) {
			this.logService.warn(`[CheckpointService] captureBeforeToolEdit failed for ${fileUri}: ${err}`);
		}
	}

	// ─── Storage path resolution ────────────────────────────────────────────

	/**
	 * Resolve the base directory for an employee's checkpoint storage.
	 * Prefers the workspace home dir (Workspace.path); falls back to the
	 * environment user-data dir.
	 */
	private async _resolveSessionDir(employeeId: string, sessionId: string): Promise<URI> {
		let baseDir: URI | undefined;
		try {
			const employee = await this.studioService.getEmployee(employeeId);
			if (employee?.workspaceId) {
				const workspace = await this.studioService.getWorkspace(employee.workspaceId);
				if (workspace?.path) {
					baseDir = URI.file(workspace.path);
				}
			}
		} catch (err) {
			this.logService.warn(`[CheckpointService] Failed to resolve workspace home for ${employeeId}: ${err}`);
		}

		if (!baseDir) {
			// Fallback: user-data dir keeps the feature alive for virtual workspaces.
			baseDir = joinPath(this.environmentService.userRoamingDataHome, 'sarosis-checkpoints');
		}

		return joinPath(baseDir, '.sarosisworkspace', 'checkpoints', employeeId, sessionId);
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
		return {
			id: stored.id,
			employeeId: stored.employeeId,
			sessionId: stored.sessionId,
			type: stored.type,
			label: stored.label,
			description: stored.description,
			createdAt: stored.createdAt,
			fileSnapshotIds: stored.fileSnapshotIds,
			isGhost: stored.isGhost,
			messageId: stored.messageId,
		};
	}

	private _getDefaultLabel(type: 'user_edit' | 'tool_edit'): string {
		const now = new Date();
		const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		return type === 'user_edit' ? `User edit at ${timeStr}` : `Tool edit at ${timeStr}`;
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	async createCheckpoint(payload: ICreateCheckpointPayload): Promise<ICheckpoint> {
		const sessionDir = await this._resolveSessionDir(payload.employeeId, payload.sessionId);
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
			employeeId: payload.employeeId,
			sessionId: payload.sessionId,
			type: payload.type,
			label: payload.label || this._getDefaultLabel(payload.type),
			description: payload.description,
			createdAt: Date.now(),
			fileSnapshotIds,
			isGhost: false,
			messageId: payload.messageId,
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
		employeeId: string,
		sessionId: string,
		type: 'user_edit' | 'tool_edit',
		fileUris: string[],
		opts?: { label?: string; description?: string; messageId?: string },
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
					});
				} else {
					// File not yet created — record an empty-content snapshot so that
					// reverting can delete-to-empty rather than leaving the AI's new file.
					fileSnapshots.push({
						uri: resource,
						languageId: undefined,
						content: '',
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
			employeeId,
			sessionId,
			type,
			label: opts?.label,
			description: opts?.description,
			fileSnapshots,
			messageId: opts?.messageId,
		});
	}

	async jumpToCheckpoint(employeeId: string, sessionId: string, checkpointId: string): Promise<IJumpToCheckpointResult> {
		const sessionDir = await this._resolveSessionDir(employeeId, sessionId);
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
				await this.fileService.writeFile(resource, VSBuffer.fromString(snapshot.content));
				restoredFiles.push(snapshot.uri);
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

	async getCheckpoint(employeeId: string, sessionId: string, checkpointId: string): Promise<ICheckpoint | undefined> {
		const sessionDir = await this._resolveSessionDir(employeeId, sessionId);
		const index = await this._readIndex(sessionDir);
		const found = index.find(cp => cp.id === checkpointId);
		return found ? this._toCheckpoint(found) : undefined;
	}

	async listCheckpoints(employeeId: string, sessionId: string): Promise<ICheckpoint[]> {
		const sessionDir = await this._resolveSessionDir(employeeId, sessionId);
		const index = await this._readIndex(sessionDir);
		return index
			.slice()
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(cp => this._toCheckpoint(cp));
	}

	async deleteCheckpoint(employeeId: string, sessionId: string, checkpointId: string): Promise<void> {
		const sessionDir = await this._resolveSessionDir(employeeId, sessionId);
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
}
