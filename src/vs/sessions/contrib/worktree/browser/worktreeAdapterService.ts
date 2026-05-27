/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceAdapterService, IWorkspaceInfo, IWorkspaceListedInfo, IWorkspaceTarget, IWorkspaceAdapterContext } from '../common/workspaceAdapter.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { IWorktreeInfo, WorktreeStatus } from '../common/worktreeTypes.js';


/**
 * Worktree-based workspace adapter.
 * Implements the IWorkspaceAdapterService using git worktrees for agent isolation.
 *
 * Lifecycle (opencode-compatible):
 *   configure() → makeWorktreeInfo() → compute name/branch/directory
 *   create()    → createFromInfo() → git worktree add + boot
 *   list()      → listWorktrees() → enumerate existing worktrees
 *   remove()    → removeWorktree() → git worktree remove + cleanup
 *   target()    → { type: 'local', directory } → connection target
 *   reset()     → resetWorktree() → git reset --hard + clean
 */
export class WorktreeAdapterService extends Disposable implements IWorkspaceAdapterService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IWorktreeService private readonly worktreeService: IWorktreeService,
	) {
		super();
	}

	async configure(info: IWorkspaceInfo, context?: IWorkspaceAdapterContext): Promise<IWorkspaceInfo> {
		const worktreeInfo = await this.worktreeService.makeWorktreeInfo({
			name: info.name,
			detached: info.type === 'worktree-detached',
		});

		return {
			...info,
			type: 'worktree',
			name: worktreeInfo.name,
			branch: worktreeInfo.branch,
			directory: worktreeInfo.directory,
		};
	}

	async create(info: IWorkspaceInfo, context?: IWorkspaceAdapterContext): Promise<void> {
		if (!info.directory || !info.name) {
			throw new Error('Workspace info must have directory and name after configure()');
		}

		const worktreeInfo: IWorktreeInfo = {
			name: info.name,
			branch: info.branch,
			directory: info.directory,
		};

		await this.worktreeService.createFromInfo(worktreeInfo);

		// Wait for the worktree to be ready (with 30s timeout)
		const status = await this.worktreeService.waitForWorktreeReady(info.directory, 30000);
		if (status === WorktreeStatus.Failed) {
			throw new Error(`Worktree creation failed for ${info.directory}`);
		}
	}

	async list(context?: IWorkspaceAdapterContext): Promise<IWorkspaceListedInfo[]> {
		const repoRoot = await this.worktreeService.getRepositoryRoot();
		if (!repoRoot) {
			return [];
		}

		const worktrees = await this.worktreeService.listWorktrees(repoRoot);
		return worktrees
			.filter(w => !w.isMain && !w.isBare)
			.map(w => ({
				type: 'worktree' as const,
				name: w.name,
				branch: w.branch,
				directory: w.path,
				projectID: repoRoot,
			}));
	}

	async remove(info: IWorkspaceInfo, context?: IWorkspaceAdapterContext): Promise<void> {
		if (!info.directory) {
			throw new Error('Workspace info must have directory for removal');
		}
		await this.worktreeService.removeWorktree(info.directory, true);
	}

	target(info: IWorkspaceInfo): IWorkspaceTarget {
		if (!info.directory) {
			throw new Error('Workspace info must have directory for target');
		}
		return { type: 'local', directory: info.directory };
	}

	async reset(info: IWorkspaceInfo, context?: IWorkspaceAdapterContext): Promise<void> {
		if (!info.directory) {
			throw new Error('Workspace info must have directory for reset');
		}
		await this.worktreeService.resetWorktree(info.directory);
	}
}
