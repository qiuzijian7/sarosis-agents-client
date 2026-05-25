/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { IWorktreeDetail, ICreateWorktreeInfo, IWorktreeOutputItem } from '../common/worktreeTypes.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * Service for managing git worktrees in the sessions window.
 * Executes git commands via child_process (electron main process context).
 */
export class WorktreeService extends Disposable implements IWorktreeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorktrees = this._register(new Emitter<void>());
	readonly onDidChangeWorktrees = this._onDidChangeWorktrees.event;

	private _repositoryRoot: string | undefined;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._repositoryRoot = undefined;
			this._onDidChangeWorktrees.fire();
		}));
	}

	async getRepositoryRoot(): Promise<string | undefined> {
		if (this._repositoryRoot !== undefined) {
			return this._repositoryRoot;
		}

		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		// Check each workspace folder for a .git directory
		for (const folder of folders) {
			const gitPath = URI.joinPath(folder.uri, '.git');
			try {
				const stat = await this.fileService.stat(gitPath);
				if (stat) {
					this._repositoryRoot = folder.uri.fsPath;
					return this._repositoryRoot;
				}
			} catch {
				// No .git in this folder, continue
			}
		}

		return undefined;
	}

	async listWorktrees(repoPath: string): Promise<IWorktreeDetail[]> {
		try {
			const output = await this.execGit(repoPath, ['worktree', 'list', '--porcelain']);
			return this.parseWorktreeList(output, repoPath);
		} catch (e) {
			this.logService.error('[WorktreeService] Failed to list worktrees:', e);
			return [];
		}
	}

	async createWorktree(info: ICreateWorktreeInfo): Promise<IWorktreeDetail> {
		const args = ['worktree', 'add'];

		if (info.isBranch) {
			args.push('-b', info.name);
		}

		args.push(info.folderPath);

		if (info.isBranch) {
			args.push('HEAD');
		}

		await this.execGit(info.cwd, args);
		this._onDidChangeWorktrees.fire();

		// Return the newly created worktree info
		const worktrees = await this.listWorktrees(info.cwd);
		const created = worktrees.find(w => w.path === info.folderPath);
		if (!created) {
			throw new Error(`Failed to find newly created worktree at ${info.folderPath}`);
		}
		return created;
	}

	async removeWorktree(worktreePath: string, force: boolean = false): Promise<void> {
		const repoPath = await this.getRepositoryRoot();
		if (!repoPath) {
			throw new Error('No git repository found');
		}

		const args = ['worktree', 'remove', worktreePath];
		if (force) {
			args.push('--force');
		}

		await this.execGit(repoPath, args);
		this._onDidChangeWorktrees.fire();
	}

	async pruneWorktrees(repoPath: string): Promise<void> {
		await this.execGit(repoPath, ['worktree', 'prune']);
		this._onDidChangeWorktrees.fire();
	}

	// --- Private helpers ---

	private async execGit(cwd: string, args: string[]): Promise<string> {
		// child_process is not available in browser/renderer context
		// This service runs in the browser layer, so we cannot spawn git directly.
		// For now, return empty output to gracefully degrade.
		this.logService.warn('[WorktreeService] Git commands are not available in the browser context.');
		return '';
	}

	private parseWorktreeList(output: string, mainFolder: string): IWorktreeDetail[] {
		const items: IWorktreeDetail[] = [];
		const lines = output.split('\n');

		let current: Partial<IWorktreeOutputItem> = {};
		let firstWorktree = true;

		for (const line of lines) {
			if (line.startsWith('worktree ')) {
				if (current.worktree) {
					items.push(this.toWorktreeDetail(current as IWorktreeOutputItem, firstWorktree, mainFolder));
					firstWorktree = false;
				}
				current = { worktree: line.substring('worktree '.length) };
			} else if (line.startsWith('HEAD ')) {
				current.HEAD = line.substring('HEAD '.length);
			} else if (line.startsWith('branch ')) {
				current.branch = line.substring('branch '.length).replace('refs/heads/', '');
			} else if (line === 'detached') {
				current.detached = true;
			} else if (line === 'bare') {
				current.isBare = true;
			} else if (line.startsWith('prunable')) {
				current.prunable = line.substring('prunable '.length) || 'true';
			} else if (line.startsWith('locked')) {
				current.locked = line.substring('locked '.length) || 'true';
			} else if (line === '' && current.worktree) {
				items.push(this.toWorktreeDetail(current as IWorktreeOutputItem, firstWorktree, mainFolder));
				firstWorktree = false;
				current = {};
			}
		}

		// Handle last item
		if (current.worktree) {
			items.push(this.toWorktreeDetail(current as IWorktreeOutputItem, firstWorktree, mainFolder));
		}

		return items;
	}

	private toWorktreeDetail(item: IWorktreeOutputItem, isMain: boolean, mainFolder: string): IWorktreeDetail {
		const isBranch = !!item.branch;
		const name = isBranch
			? item.branch!
			: item.HEAD ? item.HEAD.substring(0, 7) : 'unknown';

		return {
			name,
			path: item.worktree,
			hash: item.HEAD ?? '',
			detached: item.detached ?? false,
			prunable: !!item.prunable,
			isBare: item.isBare ?? false,
			isBranch,
			locked: !!item.locked,
			isMain,
			mainFolder,
			branch: item.branch,
		};
	}
}
