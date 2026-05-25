/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThrottledDelayer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorktreeDetail, WorktreeContextKeys } from '../common/worktreeTypes.js';
import { IWorktreeService } from '../common/worktreeService.js';

/**
 * Tree item types for the worktree tree view
 */
export const enum WorktreeItemType {
	Worktree = 'worktree',
	WorktreeMain = 'worktreeMain',
	WorktreeBranch = 'worktreeBranch',
	WorktreeDetached = 'worktreeDetached',
	WorktreeLocked = 'worktreeLocked',
	WorktreePrunable = 'worktreePrunable',
}

/**
 * A tree item representing a git worktree
 */
export class WorktreeItem {
	constructor(
		readonly worktree: IWorktreeDetail,
	) { }

	get id(): string {
		return `worktree:${this.worktree.path}`;
	}

	get label(): string {
		return this.worktree.name;
	}

	get description(): string | undefined {
		if (this.worktree.isMain) {
			return localize('worktreeMain', 'main');
		}
		if (this.worktree.detached) {
			return localize('worktreeDetached', 'detached');
		}
		return undefined;
	}

	get iconPath(): ThemeIcon {
		if (this.worktree.isMain) {
			return Codicon.repo;
		}
		if (this.worktree.detached) {
			return Codicon.gitCommit;
		}
		if (this.worktree.locked) {
			return Codicon.lock;
		}
		if (this.worktree.prunable) {
			return Codicon.trash;
		}
		return Codicon.gitBranch;
	}

	get contextValue(): string {
		if (this.worktree.isMain) {
			return WorktreeItemType.WorktreeMain;
		}
		if (this.worktree.detached) {
			return WorktreeItemType.WorktreeDetached;
		}
		if (this.worktree.locked) {
			return WorktreeItemType.WorktreeLocked;
		}
		if (this.worktree.prunable) {
			return WorktreeItemType.WorktreePrunable;
		}
		return WorktreeItemType.WorktreeBranch;
	}

	get path(): string {
		return this.worktree.path;
	}

	get commandId(): string {
		return 'sessions.worktree.open';
	}

	get commandArgs(): [string] {
		return [this.worktree.path];
	}
}

/**
 * Tree data provider for the worktree view
 */
export class WorktreeTreeDataProvider extends Disposable {

	private readonly _onDidChangeTreeData = this._register(new Emitter<WorktreeItem | void>());
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private worktrees: WorktreeItem[] = [];
	private readonly refreshDelayer = this._register(new ThrottledDelayer<void>(200));
	private refreshPromise: Promise<void> | undefined;

	private hasWorktreesKey: IContextKey<boolean>;
	private worktreeCountKey: IContextKey<number>;

	private static readonly HAS_WORKTREES = new RawContextKey<boolean>(WorktreeContextKeys.HasWorktrees, false);
	private static readonly WORKTREE_COUNT = new RawContextKey<number>(WorktreeContextKeys.WorktreeCount, 0);

	constructor(
		@IWorktreeService private readonly worktreeService: IWorktreeService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this.hasWorktreesKey = WorktreeTreeDataProvider.HAS_WORKTREES.bindTo(contextKeyService);
		this.worktreeCountKey = WorktreeTreeDataProvider.WORKTREE_COUNT.bindTo(contextKeyService);

		this._register(this.worktreeService.onDidChangeWorktrees(() => {
			this.scheduleRefresh();
		}));
	}

	private scheduleRefresh(): void {
		this.refreshDelayer.trigger(() => this.doRefresh());
	}

	async refresh(): Promise<void> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}
		this.refreshPromise = this.doRefresh().finally(() => {
			this.refreshPromise = undefined;
		});
		return this.refreshPromise;
	}

	private async doRefresh(): Promise<void> {
		try {
			const repoRoot = await this.worktreeService.getRepositoryRoot();
			if (!repoRoot) {
				this.worktrees = [];
				this.hasWorktreesKey.set(false);
				this.worktreeCountKey.set(0);
				this._onDidChangeTreeData.fire();
				return;
			}

			const details = await this.worktreeService.listWorktrees(repoRoot);
			this.worktrees = details.map(d => new WorktreeItem(d));
			this.hasWorktreesKey.set(this.worktrees.length > 0);
			this.worktreeCountKey.set(this.worktrees.length);
			this._onDidChangeTreeData.fire();
		} catch (e) {
			this.worktrees = [];
			this.hasWorktreesKey.set(false);
			this.worktreeCountKey.set(0);
			this._onDidChangeTreeData.fire();
		}
	}

	async getChildren(element?: WorktreeItem): Promise<WorktreeItem[]> {
		if (element) {
			return []; // Leaf items have no children
		}
		if (this.worktrees.length === 0 && !this.refreshPromise) {
			await this.refresh();
		}
		return this.worktrees;
	}

	getTreeItem(element: WorktreeItem): WorktreeItem {
		return element;
	}
}
