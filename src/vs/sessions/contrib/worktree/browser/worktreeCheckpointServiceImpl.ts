/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorktreeCheckpointService, IWorktreeCheckpoint } from '../common/worktreeCheckpointService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Worktree Checkpoint Service - supports rollback to a previous state.
 * Compatible with VS Code's ChatSessionWorktreeCheckpointService.
 *
 * Checkpoints are implemented using git refs (under refs/sarosis/checkpoints/).
 * Each checkpoint is a lightweight git reference pointing to a commit.
 */
export class WorktreeCheckpointService extends Disposable implements IWorktreeCheckpointService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async createBaselineCheckpoint(sessionId: string, worktreePath: string): Promise<string | undefined> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Creating baseline checkpoint for session ${sessionId} at ${worktreePath}`);

			// Get current HEAD commit
			const headCommit = await this.execGit(worktreePath, ['rev-parse', 'HEAD']);
			const commitHash = headCommit.trim();

			// Create checkpoint ref: refs/sarosis/checkpoints/{sessionId}/baseline
			const refName = `refs/sarosis/checkpoints/${sessionId}/baseline`;
			await this.execGit(worktreePath, ['update-ref', refName, commitHash]);

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
			const headCommit = await this.execGit(worktreePath, ['rev-parse', 'HEAD']);
			const commitHash = headCommit.trim();

			// Create checkpoint ref: refs/sarosis/checkpoints/{sessionId}/request-{requestId}
			const refName = `refs/sarosis/checkpoints/${sessionId}/request-${requestId}`;
			await this.execGit(worktreePath, ['update-ref', refName, commitHash]);

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
			const refPattern = `refs/sarosis/checkpoints/${sessionId}/*`;
			const stdout = await this.execGit(worktreePath, ['for-each-ref', '--format=%(refname) %(objectname) %(creatordate:unix)', refPattern]).catch(() => '');

			if (!stdout.trim()) {
				return [];
			}

			const checkpoints: IWorktreeCheckpoint[] = [];
			for (const line of stdout.trim().split('\n')) {
				const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
				if (match) {
					const [, ref, commitHash, timestampStr] = match;
					const name = ref.replace(`refs/sarosis/checkpoints/${sessionId}/`, '');
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
			await this.execGit(worktreePath, ['show-ref', '--verify', checkpointRef]);

			// Roll back using git reset --hard
			await this.execGit(worktreePath, ['reset', '--hard', checkpointRef]);

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
			const refPattern = `refs/sarosis/checkpoints/${sessionId}/*`;
			const stdout = await this.execGit(worktreePath, ['for-each-ref', '--format=%(refname)', refPattern]).catch(() => '');

			if (!stdout.trim()) {
				this.logService.info(`[WorktreeCheckpoint] No checkpoints to delete`);
				return;
			}

			// Delete each ref
			for (const line of stdout.trim().split('\n')) {
				const refName = line.trim();
				if (refName) {
					await this.execGit(worktreePath, ['update-ref', '-d', refName]).catch((err) => {
						this.logService.warn(`[WorktreeCheckpoint] Failed to delete ref ${refName}:`, err);
					});
					this.logService.info(`[WorktreeCheckpoint] Deleted checkpoint ref: ${refName}`);
				}
			}

			this.logService.info(`[WorktreeCheckpoint] All checkpoints deleted for session ${sessionId}`);
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to delete checkpoints:', e);
		}
	}

	/**
	 * Execute a git command using the same method as WorktreeService.
	 * This ensures compatibility with the current architecture.
	 */
	private async execGit(cwd: string, args: string[]): Promise<string> {
		try {
			this.logService.info(`[WorktreeCheckpoint] execGit: git ${args.join(' ')} (cwd: ${cwd})`);

			// Use the ipcRenderer bridge exposed by the Electron preload script
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				let result: { success: boolean; stdout: string; stderr: string; exitCode: number } | undefined;
				try {
					result = await vscodeBridge.ipcRenderer.invoke('vscode:execGit', cwd, args);
				} catch (invokeErr) {
					this.logService.warn('[WorktreeCheckpoint] execGit: ipcRenderer.invoke failed:', invokeErr);
				}

				if (result !== undefined) {
					if (result.success) {
						return result.stdout;
					}
					throw new Error(result.stderr || `git exited with code ${result.exitCode}`);
				}
			}

			// Fallback: use Node.js child_process if available
			if (typeof process !== 'undefined' && (process as any).versions?.electron) {
				return await this._execGitNodeFallback(cwd, args);
			}

			throw new Error('Git execution not available in this context');
		} catch (err) {
			this.logService.error('[WorktreeCheckpoint] execGit: error:', err);
			throw err;
		}
	}

	private _execGitNodeFallback(cwd: string, args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			try {
				const cp = require('child_process') as typeof import('child_process');
				const child = cp.spawn('git', args, {
					cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
					windowsHide: true,
				});

				let stdout = '';
				let stderr = '';

				child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
				child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

				child.on('error', (err: Error) => {
					reject(new Error(`git spawn error: ${err.message}`));
				});

				child.on('close', (code: number) => {
					if (code === 0) {
						resolve(stdout);
					} else {
						reject(new Error(stderr || `git exited with code ${code}`));
					}
				});
			} catch (err) {
				reject(err);
			}
		});
	}
}
