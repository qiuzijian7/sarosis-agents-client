/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IWorktreeCheckpointService } from '../common/worktreeCheckpointService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Register worktree checkpoint-related commands.
 */
export function registerWorktreeCheckpointCommands(): void {
	// Command: Create a baseline checkpoint for the current worktree
	CommandsRegistry.registerCommand('worktree.createCheckpoint', async (accessor, sessionId: string, worktreePath: string) => {
		const logService = accessor.get(ILogService);
		const worktreeCheckpointService = accessor.get(IWorktreeCheckpointService);
		try {
			logService.info(`[WorktreeCheckpointCommands] Creating checkpoint for session ${sessionId}`);
			const ref = await worktreeCheckpointService.createBaselineCheckpoint(sessionId, worktreePath);
			if (ref) {
				logService.info(`[WorktreeCheckpointCommands] Checkpoint created: ${ref}`);
				return ref;
			} else {
				logService.error('[WorktreeCheckpointCommands] Failed to create checkpoint');
				return undefined;
			}
		} catch (e) {
			logService.error('[WorktreeCheckpointCommands] Error creating checkpoint:', e);
			return undefined;
		}
	});

	// Command: Rollback to a checkpoint
	CommandsRegistry.registerCommand('worktree.rollbackToCheckpoint', async (accessor, worktreePath: string, checkpointRef: string) => {
		const logService = accessor.get(ILogService);
		const worktreeCheckpointService = accessor.get(IWorktreeCheckpointService);
		try {
			logService.info(`[WorktreeCheckpointCommands] Rolling back to checkpoint ${checkpointRef}`);
			const success = await worktreeCheckpointService.rollbackToCheckpoint(worktreePath, checkpointRef);
			if (success) {
				logService.info(`[WorktreeCheckpointCommands] Rollback successful`);
				return true;
			} else {
				logService.error('[WorktreeCheckpointCommands] Rollback failed');
				return false;
			}
		} catch (e) {
			logService.error('[WorktreeCheckpointCommands] Error during rollback:', e);
			return false;
		}
	});

	// Command: List all checkpoints for a session
	CommandsRegistry.registerCommand('worktree.listCheckpoints', async (accessor, sessionId: string, worktreePath: string) => {
		const logService = accessor.get(ILogService);
		const worktreeCheckpointService = accessor.get(IWorktreeCheckpointService);
		try {
			logService.info(`[WorktreeCheckpointCommands] Listing checkpoints for session ${sessionId}`);
			const checkpoints = await worktreeCheckpointService.getCheckpoints(sessionId, worktreePath);
			logService.info(`[WorktreeCheckpointCommands] Found ${checkpoints.length} checkpoint(s)`);
			return checkpoints;
		} catch (e) {
			logService.error('[WorktreeCheckpointCommands] Error listing checkpoints:', e);
			return [];
		}
	});

	// Command: Delete all checkpoints for a session
	CommandsRegistry.registerCommand('worktree.deleteCheckpoints', async (accessor, sessionId: string, worktreePath: string) => {
		const logService = accessor.get(ILogService);
		const worktreeCheckpointService = accessor.get(IWorktreeCheckpointService);
		try {
			logService.info(`[WorktreeCheckpointCommands] Deleting checkpoints for session ${sessionId}`);
			await worktreeCheckpointService.deleteSessionCheckpoints(sessionId, worktreePath);
			logService.info(`[WorktreeCheckpointCommands] Checkpoints deleted`);
			return true;
		} catch (e) {
			logService.error('[WorktreeCheckpointCommands] Error deleting checkpoints:', e);
			return false;
		}
	});
}
