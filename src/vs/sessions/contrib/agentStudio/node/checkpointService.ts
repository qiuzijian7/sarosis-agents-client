/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IFileService } from '../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import type { ICheckpoint, IFileSnapshot, IFileSnapshotData, ICreateCheckpointPayload, IJumpToCheckpointResult } from '../common/checkpointTypes.js';
import { CheckpointStorage } from './checkpointStorage.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

/**
 * Service for managing checkpoints (Void-inspired time-travel navigation).
 * Coordinates between storage, file service, and chat service.
 */
export class CheckpointService {
	private storage: CheckpointStorage;

	constructor(
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
	) {
		this.storage = new CheckpointStorage(logService);
	}

	/**
	 * Initialize the service with the database path.
	 * Should be called once at startup.
	 */
	async initialize(dbPath: string): Promise<void> {
		await this.storage.initialize(dbPath);
		this.logService.info(`[CheckpointService] Initialized with DB: ${dbPath}`);
	}

	/**
	 * Dispose the service and close the database.
	 */
	async dispose(): Promise<void> {
		await this.storage.close();
		this.logService.info('[CheckpointService] Disposed');
	}

	// ---- Public API ---------------------------------------------------------

	/**
	 * Create a new checkpoint by snapshotting the given files.
	 * @param payload The checkpoint creation payload.
	 * @returns The created checkpoint.
	 */
	async createCheckpoint(payload: ICreateCheckpointPayload): Promise<ICheckpoint> {
		// Batch 9.2: agentId is the primary identity. Resolve once at entry to handle legacy
		// callers that still send only employeeId.
		const agentId = payload.agentId ?? payload.employeeId;
		if (!agentId) {
			throw new Error('[CheckpointService] createCheckpoint: agentId (or legacy employeeId) is required');
		}
		this.logService.info(`[CheckpointService] Creating checkpoint: ${payload.type} for ${agentId}/${payload.sessionId}`);

		// 1. Read file contents
		const fileSnapshots: IFileSnapshotData[] = [];
		for (const fileData of payload.fileSnapshots) {
			try {
				const content = fileData.content; // already provided
				fileSnapshots.push({
					uri: fileData.uri,
					languageId: fileData.languageId,
					content,
				});
			} catch (err) {
				this.logService.error(`[CheckpointService] Failed to read file ${fileData.uri.toString()}: ${err}`);
				// Continue with other files
			}
		}

		// 2. Create checkpoint entity (Batch 9.2: agentId is canonical; employeeId omitted for new rows)
		const checkpoint: ICheckpoint = {
			id: generateUuid(),
			agentId,
			sessionId: payload.sessionId,
			type: payload.type,
			label: payload.label || this.getDefaultLabel(payload.type),
			description: payload.description,
			createdAt: Date.now(),
			fileSnapshotIds: [], // will be populated by storage
			isGhost: false,
			messageId: payload.messageId,
		};

		// 3. Store in DB
		await this.storage.createCheckpoint(checkpoint, fileSnapshots);

		this.logService.info(`[CheckpointService] Checkpoint created: ${checkpoint.id} with ${fileSnapshots.length} snapshots`);
		return checkpoint;
	}

	/**
	 * Jump to a checkpoint (restore file contents).
	 * @param checkpointId The checkpoint ID to restore.
	 * @returns Result with restored files and removed message count (0, caller handles messages).
	 */
	async jumpToCheckpoint(checkpointId: string): Promise<IJumpToCheckpointResult> {
		this.logService.info(`[CheckpointService] Jumping to checkpoint: ${checkpointId}`);

		// 1. Get checkpoint and file snapshots
		const checkpoint = await this.storage.getCheckpoint(checkpointId);
		if (!checkpoint) {
			throw new Error(`Checkpoint not found: ${checkpointId}`);
		}

		const fileSnapshots = await this.storage.getFileSnapshots(checkpointId);

		// 2. Restore file contents
		const restoredFiles: string[] = [];
		for (const snapshot of fileSnapshots) {
			try {
				await this.restoreFileSnapshot(snapshot);
				restoredFiles.push(snapshot.uri.toString());
			} catch (err) {
				this.logService.error(`[CheckpointService] Failed to restore file ${snapshot.uri.toString()}: ${err}`);
				// Continue with other files
			}
		}

		// 3. Mark checkpoints after this one as "ghost" (unreachable)
		await this.markSubsequentCheckpointsAsGhost(checkpoint.agentId, checkpoint.sessionId, checkpoint.createdAt);

		this.logService.info(`[CheckpointService] Jumped to checkpoint: ${checkpointId}, restored ${restoredFiles.length} files`);

		// 4. Return result (caller handles chat message deletion)
		return {
			checkpointId,
			restoredFiles,
			removedMessages: 0, // caller will calculate actual count
		};
	}

	/**
	 * Get a checkpoint by ID.
	 */
	async getCheckpoint(checkpointId: string): Promise<ICheckpoint | undefined> {
		return this.storage.getCheckpoint(checkpointId);
	}

	/**
	 * List all checkpoints for an agent+session.
	 */
	async listCheckpoints(agentId: string, sessionId: string): Promise<ICheckpoint[]> {
		return this.storage.listCheckpoints(agentId, sessionId);
	}

	/**
	 * Delete a checkpoint.
	 */
	async deleteCheckpoint(checkpointId: string): Promise<void> {
		return this.storage.deleteCheckpoint(checkpointId);
	}

	/**
	 * Update checkpoint metadata.
	 */
	async updateCheckpoint(
		checkpointId: string,
		updates: Partial<Pick<ICheckpoint, 'label' | 'description' | 'isGhost'>>,
	): Promise<void> {
		return this.storage.updateCheckpoint(checkpointId, updates);
	}

	// ---- Private helpers -----------------------------------------------------

	private getDefaultLabel(type: 'user_edit' | 'tool_edit'): string {
		const now = new Date();
		const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		return type === 'user_edit' ? `User edit at ${timeStr}` : `Tool edit at ${timeStr}`;
	}

	private async restoreFileSnapshot(snapshot: IFileSnapshot): Promise<void> {
		// Write the snapshot content back to the file
		const resource = snapshot.uri;
		const content = snapshot.content;

		// Use fileService to write the content (expects VSBuffer)
		const buffer = VSBuffer.fromString(content);
		await this.fileService.writeFile(resource, buffer);

		this.logService.info(`[CheckpointService] Restored file: ${resource.toString()}`);
	}

	private async markSubsequentCheckpointsAsGhost(
		employeeId: string,
		sessionId: string,
		createdAt: number,
	): Promise<void> {
		// Get all checkpoints after this one
		const allCheckpoints = await this.storage.listCheckpoints(employeeId, sessionId);
		const subsequent = allCheckpoints.filter(cp => cp.createdAt > createdAt);

		// Mark them as ghost
		for (const cp of subsequent) {
			await this.storage.updateCheckpoint(cp.id, { isGhost: true });
		}

		this.logService.info(`[CheckpointService] Marked ${subsequent.length} checkpoints as ghost`);
	}
}
