/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IWorktreeCheckpointService = createDecorator<IWorktreeCheckpointService>('worktreeCheckpointService');

/**
 * Worktree Checkpoint Service - supports rollback to a previous state.
 * Compatible with VS Code's ChatSessionWorktreeCheckpointService.
 *
 * Checkpoints are implemented using git refs (under refs/vssaros/checkpoints/).
 * Each checkpoint is a lightweight git reference pointing to a commit.
 */
export interface IWorktreeCheckpointService {
	readonly _serviceBrand: undefined;

	/**
	 * Create a baseline checkpoint for a worktree before an agent request starts.
	 * This captures the current state so the user can roll back later.
	 *
	 * @param sessionId The agent session ID
	 * @param worktreePath The worktree path
	 * @returns The checkpoint ref name (e.g., "refs/vssaros/checkpoints/{sessionId}/baseline")
	 */
	createBaselineCheckpoint(sessionId: string, worktreePath: string): Promise<string | undefined>;

	/**
	 * Create a post-turn checkpoint after an agent request completes.
	 * This allows the user to roll back to the state after each turn.
	 *
	 * @param sessionId The agent session ID
	 * @param worktreePath The worktree path
	 * @param requestId The request ID (used as checkpoint name)
	 * @returns The checkpoint ref name
	 */
	createPostTurnCheckpoint(sessionId: string, worktreePath: string, requestId: string): Promise<string | undefined>;

	/**
	 * Get all checkpoints for a session.
	 */
	getCheckpoints(sessionId: string, worktreePath: string): Promise<readonly IWorktreeCheckpoint[]>;

	/**
	 * Roll back a worktree to a specific checkpoint.
	 * Uses `git reset --hard` to restore the checkpoint state.
	 *
	 * @param worktreePath The worktree path
	 * @param checkpointRef The checkpoint ref (e.g., "refs/vssaros/checkpoints/{sessionId}/baseline")
	 * @returns Whether the rollback was successful
	 */
	rollbackToCheckpoint(worktreePath: string, checkpointRef: string): Promise<boolean>;

	/**
	 * Delete all checkpoints for a session (e.g., when the session is deleted).
	 */
	deleteSessionCheckpoints(sessionId: string, worktreePath: string): Promise<void>;
}

/**
 * A single worktree checkpoint.
 */
export interface IWorktreeCheckpoint {
	/** Checkpoint ref name */
	ref: string;
	/** Commit hash this checkpoint points to */
	commitHash: string;
	/** Human-readable name (e.g., "baseline", "request-abc123") */
	name: string;
	/** Timestamp when the checkpoint was created */
	timestamp: number;
	/** Whether this is a baseline checkpoint */
	isBaseline: boolean;
}
