/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorktreeCheckpointService, IWorktreeCheckpoint } from '../common/worktreeCheckpointService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class WorktreeCheckpointService implements IWorktreeCheckpointService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	async createBaselineCheckpoint(sessionId: string, worktreePath: string): Promise<string | undefined> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Creating baseline checkpoint for session ${sessionId} at ${worktreePath}`);

			// Get current HEAD commit
			const { stdout: headCommit } = await execAsync('git rev-parse HEAD', { cwd: worktreePath });
			const commitHash = headCommit.trim();

			// Create checkpoint ref: refs/vssaros/checkpoints/{sessionId}/baseline
			const refName = `refs/vssaros/checkpoints/${sessionId}/baseline`;
			await execAsync(`git update-ref ${refName} ${commitHash}`, { cwd: worktreePath });

			this.logService.info(`[WorktreeCheckpoint] Baseline checkpoint created: ${refName} -> ${commitHash}`);
			return refName;
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to create baseline checkpoint:', e);
			return undefined;
		}
	}

	async createPostTurnCheckpoint(sessionId: string, worktreePath: string, requestId: string): Promise<string | undefined> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Creating post-turn checkpoint for request ${requestId}`);

			// Get current HEAD commit
			const { stdout: headCommit } = await execAsync('git rev-parse HEAD', { cwd: worktreePath });
			const commitHash = headCommit.trim();

			// Create checkpoint ref: refs/vssaros/checkpoints/{sessionId}/request-{requestId}
			const refName = `refs/vssaros/checkpoints/${sessionId}/request-${requestId}`;
			await execAsync(`git update-ref ${refName} ${commitHash}`, { cwd: worktreePath });

			this.logService.info(`[WorktreeCheckpoint] Post-turn checkpoint created: ${refName} -> ${commitHash}`);
			return refName;
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to create post-turn checkpoint:', e);
			return undefined;
		}
	}

	async getCheckpoints(sessionId: string, worktreePath: string): Promise<readonly IWorktreeCheckpoint[]> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Getting checkpoints for session ${sessionId}`);

			// List all checkpoint refs for this session
			const refPattern = `refs/vssaros/checkpoints/${sessionId}/*`;
			const { stdout } = await execAsync(`git for-each-ref --format='%(refname) %(objectname) %(creatordate:unix)' ${refPattern}`, { cwd: worktreePath });

			if (!stdout.trim()) {
				return [];
			}

			const checkpoints: IWorktreeCheckpoint[] = [];
			for (const line of stdout.trim().split('\n')) {
				const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
				if (match) {
					const [, ref, commitHash, timestampStr] = match;
					const name = ref.replace(`refs/vssaros/checkpoints/${sessionId}/`, '');
					const isBaseline = name === 'baseline';

					checkpoints.push({
						ref,
						commitHash,
						name,
						timestamp: parseInt(timestampStr, 10) * 1000, // convert to ms
						isBaseline,
					});
				}
			}

			this.logService.info(`[WorktreeCheckpoint] Found ${checkpoints.length} checkpoint(s)`);
			return checkpoints;
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to get checkpoints:', e);
			return [];
		}
	}

	async rollbackToCheckpoint(worktreePath: string, checkpointRef: string): Promise<boolean> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Rolling back to checkpoint ${checkpointRef} at ${worktreePath}`);

			// Verify the checkpoint ref exists
			const { stdout: refExists } = await execAsync(`git show-ref --verify ${checkpointRef}`, { cwd: worktreePath }).catch(() => ({ stdout: '' }));
			if (!refExists.trim()) {
				this.logService.warn(`[WorktreeCheckpoint] Checkpoint ref ${checkpointRef} does not exist`);
				return false;
			}

			// Roll back using git reset --hard
			await execAsync(`git reset --hard ${checkpointRef}`, { cwd: worktreePath });

			this.logService.info(`[WorktreeCheckpoint] Rollback completed successfully`);
			return true;
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to rollback:', e);
			return false;
		}
	}

	async deleteSessionCheckpoints(sessionId: string, worktreePath: string): Promise<void> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Deleting all checkpoints for session ${sessionId}`);

			// Get all checkpoint refs for this session
			const refPattern = `refs/vssaros/checkpoints/${sessionId}/*`;
			const { stdout } = await execAsync(`git for-each-ref --format='%(refname)' ${refPattern}`, { cwd: worktreePath }).catch(() => ({ stdout: '' }));

			if (!stdout.trim()) {
				this.logService.info(`[WorktreeCheckpoint] No checkpoints to delete`);
				return;
			}

			// Delete each ref
			for (const line of stdout.trim().split('\n')) {
				const refName = line.trim();
				if (refName) {
					await execAsync(`git update-ref -d ${refName}`, { cwd: worktreePath });
					this.logService.info(`[WorktreeCheckpoint] Deleted checkpoint ref: ${refName}`);
				}
			}

			this.logService.info(`[WorktreeCheckpoint] All checkpoints deleted for session ${sessionId}`);
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to delete checkpoints:', e);
		}
	}
}
