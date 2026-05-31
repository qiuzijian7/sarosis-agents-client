/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorktreeDetail, ICreateWorktreeInfo, IWorktreeInfoOptions, IWorktreeInfo, WorktreeStatus, IWorktreeStateEvent } from './worktreeTypes.js';

export const IWorktreeService = createDecorator<IWorktreeService>('worktreeService');

/**
 * Service for managing git worktrees in the sessions window.
 * Delegates git operations via the shared-process ILocalGitService or
 * direct git execution.
 *
 * Supports opencode-compatible two-phase creation:
 *   1. makeWorktreeInfo() → compute name/branch/directory (no git yet)
 *   2. createFromInfo() → git worktree add + boot (async)
 */
export interface IWorktreeService {
	readonly _serviceBrand: undefined;

	/** Event fired when worktree list changes */
	readonly onDidChangeWorktrees: Event<void>;

	/** Event fired when a worktree's lifecycle status changes (pending/ready/failed) */
	readonly onDidChangeWorktreeState: Event<IWorktreeStateEvent>;

	/**
	 * List all worktrees for the given repository path.
	 * @param repoPath Absolute path to the git repository root
	 */
	listWorktrees(repoPath: string): Promise<IWorktreeDetail[]>;

	/**
	 * Create a new worktree (legacy single-phase).
	 */
	createWorktree(info: ICreateWorktreeInfo): Promise<IWorktreeDetail>;

	/**
	 * Phase 1: Generate worktree info without executing git commands.
	 * Computes a slugified name, branch name, and directory path.
	 * Checks for conflicts (existing directory, existing branch).
	 * Compatible with opencode's makeWorktreeInfo pattern.
	 */
	makeWorktreeInfo(options?: IWorktreeInfoOptions): Promise<IWorktreeInfo>;

	/**
	 * Phase 2: Create the worktree from pre-computed info.
	 * Executes: git worktree add --no-checkout [-b branch] dir
	 * Then: git reset --hard (populate files)
	 * Emits onDidChangeWorktreeState with Pending → Ready/Failed.
	 * Compatible with opencode's createFromInfo pattern.
	 */
	createFromInfo(info: IWorktreeInfo): Promise<void>;

	/**
	 * Reset a worktree to the default branch state.
	 * Executes: git fetch + git reset --hard + git clean -ffdx + submodule update.
	 * Compatible with opencode's reset pattern.
	 */
	resetWorktree(worktreePath: string): Promise<void>;

	/**
	 * Remove (delete) a worktree.
	 * Enhanced with opencode pattern: stops fsmonitor, force remove, cleanup directory, delete branch.
	 * @param worktreePath Absolute path of the worktree to remove
	 * @param force Whether to force removal even with uncommitted changes
	 */
	removeWorktree(worktreePath: string, force?: boolean): Promise<void>;

	/**
	 * Prune stale worktree metadata.
	 * @param repoPath Absolute path to the git repository root
	 */
	pruneWorktrees(repoPath: string): Promise<void>;

	/**
	 * Get the repository root path for the current workspace.
	 * Returns undefined if no git repo is found.
	 */
	getRepositoryRoot(): Promise<string | undefined>;

	/**
	 * Get the current lifecycle status of a worktree by its directory path.
	 */
	getWorktreeState(directory: string): WorktreeStatus;

	/**
	 * Wait for a worktree to reach Ready or Failed status.
	 * Returns the final status. Useful for session creation flow.
	 */
	waitForWorktreeReady(directory: string, timeoutMs?: number): Promise<WorktreeStatus>;

	/**
	 * Get the default branch name for the repository (e.g. "main", "master").
	 */
	getDefaultBranch(repoPath: string): Promise<string>;

	/**
	 * List local git branches that are NOT currently checked out by any worktree.
	 * Used for the "create worktree" flow to avoid branch conflicts.
	 * @param repoPath Absolute path to the git repository root
	 */
	listGitBranches(repoPath: string): Promise<string[]>;
}
