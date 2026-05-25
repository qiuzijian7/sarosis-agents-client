/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parsed output item from `git worktree list --porcelain`
 */
export interface IWorktreeOutputItem {
	/** Working tree path */
	worktree: string;
	/** HEAD commit hash */
	HEAD: string;
	/** Whether HEAD is detached */
	detached: boolean;
	/** Branch name (if not detached) */
	branch?: string;
	/** Whether this is the main worktree */
	isMain: boolean;
	/** Prunable info */
	prunable?: string;
	/** Locked reason */
	locked?: string;
	/** Whether this is a bare repository */
	isBare: boolean;
}

/**
 * Detailed information about a git worktree
 */
export interface IWorktreeDetail {
	/** Display name (branch name or detached HEAD short hash) */
	name: string;
	/** Absolute file system path */
	path: string;
	/** Full commit hash */
	hash: string;
	/** Whether HEAD is detached */
	detached: boolean;
	/** Whether this worktree is prunable */
	prunable: boolean;
	/** Whether this is a bare worktree */
	isBare: boolean;
	/** Whether the worktree is on a branch (vs detached/tag) */
	isBranch: boolean;
	/** Whether the worktree is locked */
	locked: boolean;
	/** Whether this is the main worktree */
	isMain: boolean;
	/** The main worktree folder path */
	mainFolder: string;
	/** Branch name if on a branch */
	branch?: string;
}

/**
 * Information needed to create a new worktree
 */
export interface ICreateWorktreeInfo {
	/** Target folder path for the new worktree */
	folderPath: string;
	/** Name for the new worktree (branch name or display name) */
	name: string;
	/** Display label */
	label: string;
	/** Whether the reference is a branch */
	isBranch: boolean;
	/** Current working directory (repository root) */
	cwd: string;
}

/**
 * View and command identifiers for worktree management
 */
export const WORKTREE_VIEW_ID = 'sessions.worktree.list';
export const WORKTREE_VIEW_CONTAINER_ID = 'sessions.worktree.container';

export const enum WorktreeCommands {
	Refresh = 'sessions.worktree.refresh',
	Create = 'sessions.worktree.create',
	Delete = 'sessions.worktree.delete',
	Open = 'sessions.worktree.open',
	OpenInTerminal = 'sessions.worktree.openInTerminal',
	Remove = 'sessions.worktree.remove',
	Prune = 'sessions.worktree.prune',
}

export const enum WorktreeContextKeys {
	HasWorktrees = 'sessions.worktree.hasWorktrees',
	WorktreeCount = 'sessions.worktree.count',
	WorktreeIsMain = 'sessions.worktree.isMain',
	WorktreeIsDetached = 'sessions.worktree.isDetached',
	WorktreeIsLocked = 'sessions.worktree.isLocked',
	WorktreeIsPrunable = 'sessions.worktree.isPrunable',
}
