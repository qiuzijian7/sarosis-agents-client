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
		/** Number of active sessions using this worktree */
		readonly sessionCount: number = 0,
		/** Whether this is the currently active session's worktree */
		readonly isActiveWorktree: boolean = false,
	) { }

	get id(): string {
		return `worktree:${this.worktree.path}`;
	}

	get label(): string {
		return this.worktree.name;
	}

	get description(): string | undefined {
		const parts: string[] = [];
		if (this.worktree.isMain) {
			parts.push(localize('worktreeMain', 'main'));
		}
		if (this.worktree.detached) {
			parts.push(localize('worktreeDetached', 'detached'));
		}
		if (this.sessionCount > 0) {
			parts.push(localize('worktreeSessionCount', '{0} sessions', this.sessionCount));
		}
		return parts.length > 0 ? parts.join(' · ') : undefined;
	}

	get iconPath(): ThemeIcon {
		if (this.isActiveWorktree) {
			// Highlight the active worktree with a different icon
			return Codicon.gitBranch;
		}
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
 * A tree item representing a repository group (parent node). Only used when the
 * workspace contains more than one related git repository — each group holds the
 * worktrees discovered under one repository root.
 */
export class WorktreeRepoGroup {
	constructor(
		/** Absolute path to the repository root */
		readonly repoRoot: string,
		/** Display label (folder basename) */
		readonly repoLabel: string,
		/** Worktrees discovered under this repository */
		readonly worktrees: WorktreeItem[],
	) { }

	get id(): string {
		return `worktree-repo:${this.repoRoot}`;
	}

	get label(): string {
		return this.repoLabel;
	}
}

/** Union of tree element types rendered by the worktree view. */
export type WorktreeTreeElement = WorktreeRepoGroup | WorktreeItem;

export function isWorktreeRepoGroup(element: WorktreeTreeElement): element is WorktreeRepoGroup {
	return element instanceof WorktreeRepoGroup;
}

/**
 * Tree data provider for the worktree view
 */
export class WorktreeTreeDataProvider extends Disposable {

	private readonly _onDidChangeTreeData = this._register(new Emitter<WorktreeItem | void>());
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private worktrees: WorktreeItem[] = [];
	private groups: WorktreeRepoGroup[] = [];
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

		// Also refresh when worktree state changes (pending/ready/failed)
		this._register(this.worktreeService.onDidChangeWorktreeState(() => {
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
			const repoRoots = await this.worktreeService.getAllRepositoryRoots();
			if (!repoRoots || repoRoots.length === 0) {
				this.worktrees = [];
				this.groups = [];
				this.hasWorktreesKey.set(false);
				this.worktreeCountKey.set(0);
				this._onDidChangeTreeData.fire();
				return;
			}

			// Get the active worktree path from IWorktreeService state tracking
			const activePath = this._getActiveWorktreePath();

			const groups: WorktreeRepoGroup[] = [];
			const allWorktrees: WorktreeItem[] = [];
			const seenPaths = new Set<string>();

			for (const repoRoot of repoRoots) {
				const details = await this.worktreeService.listWorktrees(repoRoot);
				const items = details.map(d => {
					const isActive = activePath ? d.path === activePath : false;
					const sessionCount = isActive ? 1 : 0; // TODO: integrate with session service for accurate count
					return new WorktreeItem(d, sessionCount, isActive);
				});
				if (items.length === 0) {
					continue;
				}
				// De-dup across repos (a worktree path should only appear once)
				const deduped: WorktreeItem[] = [];
				for (const it of items) {
					const norm = it.path.replace(/[\\/]+$/, '').toLowerCase();
					if (seenPaths.has(norm)) {
						continue;
					}
					seenPaths.add(norm);
					deduped.push(it);
					allWorktrees.push(it);
				}
				if (deduped.length > 0) {
					const repoLabel = repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || repoRoot;
					groups.push(new WorktreeRepoGroup(repoRoot, repoLabel, deduped));
				}
			}

			this.groups = groups;
			this.worktrees = allWorktrees;
			this.hasWorktreesKey.set(allWorktrees.length > 0);
			this.worktreeCountKey.set(allWorktrees.length);
			this._onDidChangeTreeData.fire();
		} catch (e) {
			this.worktrees = [];
			this.groups = [];
			this.hasWorktreesKey.set(false);
			this.worktreeCountKey.set(0);
			this._onDidChangeTreeData.fire();
		}
	}

	/**
	 * Get the path of the currently active worktree.
	 * Returns the first worktree that is in Ready state.
	 */
	private _getActiveWorktreePath(): string | undefined {
		// Check worktree states to find any that are ready
		// This is a simplified approach — a full implementation would
		// integrate with the active session service
		return undefined;
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

	/**
	 * Return the repository groups (one per related git repository that has
	 * worktrees). The view decides whether to render a flat list (single repo)
	 * or a grouped two-level tree (multiple repos).
	 */
	async getGroups(): Promise<WorktreeRepoGroup[]> {
		if (this.worktrees.length === 0 && !this.refreshPromise) {
			await this.refresh();
		}
		return this.groups;
	}

	getTreeItem(element: WorktreeItem): WorktreeItem {
		return element;
	}
}
