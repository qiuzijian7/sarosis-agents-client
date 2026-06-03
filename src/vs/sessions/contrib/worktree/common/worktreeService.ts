/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorktreeDetail, ICreateWorktreeInfo, IWorktreeInfoOptions, IWorktreeInfo, WorktreeStatus, IWorktreeStateEvent } from './worktreeTypes.js';

export const IWorktreeService = createDecorator<IWorktreeService>('worktreeService');

/**
 * The worktree the user has explicitly selected by clicking an item in the
 * Worktree view. Used to drive the Changes view (sessions-customized
 * ChangesViewModel) to show this worktree's working-tree diff, independently of
 * the active session. `path` is the worktree directory; `branch` is its checked
 * out branch (for the header label).
 */
export interface ISelectedWorktree {
	readonly path: string;
	readonly branch?: string;
}

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
	 * Event fired after a worktree is removed.
	 * Payload is the absolute directory path of the removed worktree.
	 * Consumers (e.g. AgentStudioService) use this to clear stale worktree
	 * bindings on agents/workspaces that pointed at the removed directory.
	 */
	readonly onDidRemoveWorktree: Event<string>;

	/**
	 * The worktree the user has explicitly selected in the Worktree view.
	 * `undefined` means "follow the active session" (default behaviour).
	 *
	 * The Changes view (ChangesViewModel) observes this and, when set, shows
	 * the selected worktree's diff instead of the active session's diff. This
	 * is the cross-contrib channel that lets clicking a worktree item switch
	 * the Changes/Graph content without owning a ChangesViewModel reference
	 * (it is created via createInstance, not a singleton).
	 */
	readonly selectedWorktree: IObservable<ISelectedWorktree | undefined>;

	/**
	 * Set (or clear with `undefined`) the explicitly selected worktree. Called
	 * by the Worktree view when an item is clicked.
	 */
	setSelectedWorktree(selection: ISelectedWorktree | undefined): void;

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
	 * Get ALL repository root paths for the current workspace.
	 * Scans every workspace folder (home dir + related code folders + worktree)
	 * and returns those that contain a `.git` entry. Used by the Worktree view
	 * to list worktrees across all related repositories, not just the first.
	 */
	getAllRepositoryRoots(): Promise<string[]>;

	/**
	 * Filter the given candidate directory paths down to those that are git
	 * repository roots (contain a `.git` entry), de-duplicated and order-preserving.
	 *
	 * Unlike {@link getAllRepositoryRoots} this does NOT read the global VS Code
	 * workspace folders — the caller supplies the exact candidate set. The
	 * Worktree view uses this to scope the list to ONLY the active workspace's
	 * related code repositories, instead of whatever mixed roots happen to be
	 * injected into the global folder set (home dir, sibling worktrees, etc.).
	 *
	 * @param candidatePaths Absolute directory paths to probe.
	 */
	filterGitRepositoryRoots(candidatePaths: readonly string[]): Promise<string[]>;

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
