/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorktreeDetail, ICreateWorktreeInfo } from './worktreeTypes.js';

export const IWorktreeService = createDecorator<IWorktreeService>('worktreeService');

/**
 * Service for managing git worktrees in the sessions window.
 * Delegates git operations via the shared-process ILocalGitService or
 * direct git execution.
 */
export interface IWorktreeService {
	readonly _serviceBrand: undefined;

	/** Event fired when worktree list changes */
	readonly onDidChangeWorktrees: Event<void>;

	/**
	 * List all worktrees for the given repository path.
	 * @param repoPath Absolute path to the git repository root
	 */
	listWorktrees(repoPath: string): Promise<IWorktreeDetail[]>;

	/**
	 * Create a new worktree.
	 */
	createWorktree(info: ICreateWorktreeInfo): Promise<IWorktreeDetail>;

	/**
	 * Remove (delete) a worktree.
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
}
