/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { ExplorerView } from '../../../../workbench/contrib/files/browser/views/explorerView.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { WorkspaceFolderCountContext } from '../../../../workbench/common/contextkeys.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { SessionsExplorerViewPaneContainer } from './sessionsExplorerViewPaneContainer.js';
import { SESSIONS_FILES_EMPTY_VIEW_ID, SESSIONS_FILES_VIEW_ID, SessionsExplorerEmptyView, SessionsExplorerView } from './filesView.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { IWorktreeCheckpointService } from '../../worktree/common/worktreeCheckpointService.js';
import { WorktreeItem } from '../../worktree/browser/worktreeDataProvider.js';
import { WorktreeViewPane } from '../../worktree/browser/worktreeView.js';
import { WorktreeCommands } from '../../worktree/common/worktreeTypes.js';
import { SESSIONS_SCM_WORKTREE_VIEW_ID } from '../../sourceControl/browser/sourceControl.contribution.js';

// --- Unified Explorer Container ID ---
export const SESSIONS_EXPLORER_CONTAINER_ID = 'sessions.explorer.container';

// --- Icons ---
const explorerViewIcon = registerIcon('sessions-explorer-view-icon', Codicon.files, localize2('sessionsExplorerViewIcon', 'View icon of the Explorer view in the sessions window.').value);

// --- Register View Container (in Sidebar, for sessions window) ---
const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const explorerViewContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_EXPLORER_CONTAINER_ID,
	title: localize2('explorer', "Explorer"),
	icon: explorerViewIcon,
	order: 1,
	ctorDescriptor: new SyncDescriptor(SessionsExplorerViewPaneContainer),
	storageId: SESSIONS_EXPLORER_CONTAINER_ID,
	hideIfEmpty: false,
	openCommandActionDescriptor: {
		id: SESSIONS_EXPLORER_CONTAINER_ID,
		title: localize2('explore', "Explorer"),
		mnemonicTitle: localize({ key: 'miExplorer', comment: ['&& denotes a mnemonic'] }, "E&&xplorer"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE },
		order: 1,
	},
	// [Saros] Hidden — the Explorer file tree duplicates the Workspace (folder) icon
	// below it in the activity bar. Keeping the container registered so that
	// `openView(SESSIONS_FILES_VIEW_ID)` / keybindings (Ctrl+Shift+E) still work.
	windowEnablement: WindowEnablement.None,
}, ViewContainerLocation.Sidebar, { isDefault: true });

// --- Register Views inside the unified Explorer container ---

class RegisterExplorerViewsContribution implements IWorkbenchContribution {

	static readonly ID = 'sessions.registerExplorerViews';

	constructor() {
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

		// 1. Files explorer view (the main file tree)
		viewsRegistry.registerViews([{
			id: SESSIONS_FILES_VIEW_ID,
			name: localize2('files', "Files"),
			containerIcon: explorerViewIcon,
			ctorDescriptor: new SyncDescriptor(SessionsExplorerView),
			canToggleVisibility: false,
			canMoveView: false,
			when: ContextKeyExpr.and(WorkspaceFolderCountContext.notEqualsTo('0'), IsPhoneLayoutContext.negate()),
			weight: 40,
			order: 1,
			windowEnablement: WindowEnablement.Sessions,
		}], explorerViewContainer);

		// 3. Empty view for when no workspace folders exist
		viewsRegistry.registerViews([{
			id: SESSIONS_FILES_EMPTY_VIEW_ID,
			name: localize2('files', "Files"),
			containerIcon: explorerViewIcon,
			ctorDescriptor: new SyncDescriptor(SessionsExplorerEmptyView),
			canToggleVisibility: false,
			canMoveView: false,
			when: ContextKeyExpr.and(WorkspaceFolderCountContext.isEqualTo('0'), IsPhoneLayoutContext.negate()),
			windowEnablement: WindowEnablement.Sessions,
		}], explorerViewContainer);
	}
}

registerWorkbenchContribution2(RegisterExplorerViewsContribution.ID, RegisterExplorerViewsContribution, WorkbenchPhase.BlockStartup);

// --- Register Actions ---

// Collapse all folders in explorer
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.explorer.action.collapseExplorerFolders',
			title: localize2('collapseExplorerFolders', "Collapse Folders in Explorer"),
			icon: Codicon.collapseAll,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 10,
				when: ContextKeyExpr.equals('view', SESSIONS_FILES_VIEW_ID),
			},
		});
	}

	run(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getViewWithId(SESSIONS_FILES_VIEW_ID);
		if (view !== null) {
			(view as ExplorerView).collapseAll();
		}
	}
});

// --- Worktree Commands ---
// NOTE: only the *commands* live here. The corresponding menu entries (ViewTitle /
// ViewItemContext for the Source Control worktree view) are registered centrally in
// `sourceControl/browser/sourceControl.contribution.ts`. Do NOT also declare `menu:`
// below, or every worktree action renders twice in the view title / context menu.

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Refresh,
			title: localize2('worktreeRefresh', 'Refresh Worktrees'),
			icon: Codicon.refresh,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const repoRoot = await worktreeService.getRepositoryRoot();
		if (repoRoot) {
			await worktreeService.listWorktrees(repoRoot);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Create,
			title: localize2('worktreeCreate', 'Create Worktree'),
			icon: Codicon.add,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		// Try to get the existing view first (avoids a layout jump)
		let view = viewsService.getViewWithId<WorktreeViewPane>(SESSIONS_SCM_WORKTREE_VIEW_ID);
		if (!view) {
			// View not yet created, open it (first time)
			view = await viewsService.openView<WorktreeViewPane>(SESSIONS_SCM_WORKTREE_VIEW_ID);
		}
		if (view) {
			await view.showCreateInput();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Delete,
			title: localize2('worktreeDelete', 'Delete Worktree'),
			icon: Codicon.trash,
		});
	}

	async run(accessor: ServicesAccessor, item: WorktreeItem): Promise<void> {
		if (!item || item.worktree.isMain) {
			return;
		}

		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);

		try {
			await worktreeService.removeWorktree(item.path);
			notificationService.info(localize('worktreeDeleted', 'Deleted worktree: {0}', item.label));
		} catch (e) {
			notificationService.error(localize('worktreeDeleteError', 'Failed to delete worktree: {0}', (e as Error).message));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Open,
			title: localize2('worktreeOpen', 'Open Worktree Folder'),
		});
	}

	async run(accessor: ServicesAccessor, path: string): Promise<void> {
		if (!path) {
			return;
		}

		const hostService = accessor.get(IHostService);
		const uri = URI.file(path);
		hostService.openWindow([{ folderUri: uri }], { forceNewWindow: true });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.OpenInTerminal,
			title: localize2('worktreeOpenInTerminal', 'Open in Terminal'),
		});
	}

	async run(accessor: ServicesAccessor, item: WorktreeItem): Promise<void> {
		if (!item) {
			return;
		}

		const commandService = accessor.get(ICommandService);
		const uri = URI.file(item.path);
		await commandService.executeCommand('openInIntegratedTerminal', uri);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Prune,
			title: localize2('worktreePrune', 'Prune Stale Worktrees'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);

		const repoRoot = await worktreeService.getRepositoryRoot();
		if (!repoRoot) {
			notificationService.warn(localize('worktreeNoRepo', 'No git repository found in workspace.'));
			return;
		}

		try {
			await worktreeService.pruneWorktrees(repoRoot);
			notificationService.info(localize('worktreePruned', 'Pruned stale worktrees.'));
		} catch (e) {
			notificationService.error(localize('worktreePruneError', 'Failed to prune worktrees: {0}', (e as Error).message));
		}
	}
});

// ─── Lock / Unlock Worktree（★ 2026-09-15）────────────────────────────────────
//
// `locked` 此前只解析不操作：`WorktreeItem` 与 `WorktreeIsLocked` 上下文键都已存在，
// 视图也能显示锁定态，但没有任何入口能真的上锁。补上这半边。
// 语义：被 lock 的 worktree 不会被 `git worktree prune` 回收（保护网络盘/临时不可达目录）。

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Lock,
			title: localize2('worktreeLock', 'Lock Worktree'),
			icon: Codicon.lock,
		});
	}

	async run(accessor: ServicesAccessor, item: WorktreeItem): Promise<void> {
		if (!item || item.worktree.isMain) {
			return;
		}

		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);

		try {
			await worktreeService.lockWorktree(item.path, localize('worktreeLockReason', 'Locked from the worktree view'));
			notificationService.info(localize('worktreeLocked', 'Locked worktree: {0}', item.label));
		} catch (e) {
			notificationService.error(localize('worktreeLockError', 'Failed to lock worktree: {0}', (e as Error).message));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Unlock,
			title: localize2('worktreeUnlock', 'Unlock Worktree'),
			icon: Codicon.unlock,
		});
	}

	async run(accessor: ServicesAccessor, item: WorktreeItem): Promise<void> {
		if (!item) {
			return;
		}

		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);

		try {
			await worktreeService.unlockWorktree(item.path);
			notificationService.info(localize('worktreeUnlocked', 'Unlocked worktree: {0}', item.label));
		} catch (e) {
			notificationService.error(localize('worktreeUnlockError', 'Failed to unlock worktree: {0}', (e as Error).message));
		}
	}
});

// ─── Clean Up Worktrees（★ 2026-09-15）────────────────────────────────────────
//
// ★★ 设计要点：**先列候选、再让用户确认，绝不按龄自动删**。
//
// 对照：hermes-agent-studio 会按时长自动回收 worktree —— 但它的是「一次 CLI 会话一个」
// 的一次性目录；本仓的 worktree 是用户在视图里手动创建、长期使用的资产，
// 按龄自动删等于销毁用户工作。所以这里只把「陈旧 + 无未推送提交」的工作树
// 和「历史 bug 留下的孤儿分支」列出来，删不删由用户决定。
//
// 两类候选的硬前提都是**没有未推送提交**（会丢的真实工作），扫描侧已过滤。

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Cleanup,
			title: localize2('worktreeCleanup', 'Clean Up Stale Worktrees…'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);

		const repoRoot = await worktreeService.getRepositoryRoot();
		if (!repoRoot) {
			notificationService.warn(localize('worktreeNoRepo', 'No git repository found in workspace.'));
			return;
		}

		let candidates;
		try {
			candidates = await worktreeService.listCleanupCandidates(repoRoot);
		} catch (e) {
			notificationService.error(localize('worktreeCleanupScanError', 'Failed to scan for stale worktrees: {0}', (e as Error).message));
			return;
		}

		if (candidates.length === 0) {
			notificationService.info(localize('worktreeCleanupNone', 'No stale worktrees or orphan branches found.'));
			return;
		}

		// 把**具体删什么**摆在用户面前（截断展示，但数量如实）。
		const MAX_SHOWN = 10;
		const lines = candidates.slice(0, MAX_SHOWN).map(c => `• ${c.path ?? c.branch} —— ${c.reason}`);
		if (candidates.length > MAX_SHOWN) {
			lines.push(`… 以及另外 ${candidates.length - MAX_SHOWN} 项`);
		}

		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: localize('worktreeCleanupConfirm', 'Clean up {0} item(s)?', candidates.length),
			detail: lines.join('\n'),
			primaryButton: localize('worktreeCleanupConfirmButton', 'Clean Up'),
		});
		if (!confirmed) {
			return;
		}

		try {
			const result = await worktreeService.cleanupWorktrees(repoRoot, candidates);
			if (result.failed.length === 0) {
				notificationService.info(localize('worktreeCleanupDone', 'Cleaned up {0} item(s).', result.removed.length));
			} else {
				// 部分失败必须说清（否则用户以为清干净了）。
				notificationService.warn(localize(
					'worktreeCleanupPartial',
					'Cleaned up {0} item(s); {1} failed: {2}',
					result.removed.length,
					result.failed.length,
					result.failed.map(f => f.target).join(', '),
				));
			}
		} catch (e) {
			notificationService.error(localize('worktreeCleanupError', 'Failed to clean up worktrees: {0}', (e as Error).message));
		}
	}
});

// ─── Rollback Worktree to Checkpoint（★ 2026-09-15）───────────────────────────
//
// ★★ 为什么必须补这个入口：`IWorktreeCheckpointService.rollbackToCheckpoint()` 在本仓
// **没有任何可达调用点** —— 唯一调用者是 `worktreeCheckpointCommands.ts` 里那 4 条
// **从未被注册**的命令（`registerWorktreeCheckpointContributions()` 全仓无调用点）。
// 也就是说 checkpoint 一直是"只进不出"：快照写进去，用户没有任何办法回滚。
// 本命令把这条路打通：**先列出该 worktree 的全部还原点 → 用户选 → 确认 → 回滚**。
//
// 列表来源用 `listCheckpointsForWorktree()`（按 worktree 反查，不限 session）——
// 因为视图并不知道 sessionId（`worktreeView.ts` 里创建 checkpoint 时用 `item.path` 占位）。

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.RollbackCheckpoint,
			title: localize2('worktreeRollbackCheckpoint', 'Rollback Worktree to Checkpoint…'),
			icon: Codicon.history,
		});
	}

	async run(accessor: ServicesAccessor, item: WorktreeItem): Promise<void> {
		if (!item || item.worktree.isMain) {
			return;
		}

		const checkpointService = accessor.get(IWorktreeCheckpointService);
		const quickInputService = accessor.get(IQuickInputService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);

		const checkpoints = await checkpointService.listCheckpointsForWorktree(item.path);
		if (checkpoints.length === 0) {
			notificationService.info(localize('worktreeNoCheckpoints', 'No checkpoints have been recorded for worktree "{0}" yet.', item.label));
			return;
		}

		const picked = await quickInputService.pick(
			checkpoints.map(c => ({
				label: c.isBaseline
					? `$(bookmark) ${localize('worktreeCheckpointBaseline', 'baseline')}`
					: `$(history) ${c.name}`,
				description: new Date(c.timestamp).toLocaleString(),
				detail: c.sessionId ? localize('worktreeCheckpointSession', 'session {0}', c.sessionId) : undefined,
				checkpoint: c,
			})),
			{ placeHolder: localize('worktreePickCheckpoint', 'Select a checkpoint to restore this worktree to') },
		);
		if (!picked) {
			return;
		}

		const target = picked.checkpoint;
		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: localize('worktreeRollbackConfirm', 'Roll back worktree "{0}" to this checkpoint?', item.label),
			detail: [
				localize('worktreeRollbackDetail1', 'Checkpoint: {0} ({1})', target.name, new Date(target.timestamp).toLocaleString()),
				localize('worktreeRollbackDetail2', 'All uncommitted changes made AFTER this checkpoint will be overwritten.'),
				localize('worktreeRollbackDetail3', 'Files created after the checkpoint are NOT deleted (conservative: a rollback should not destroy work it cannot restore).'),
			].join('\n'),
			primaryButton: localize('worktreeRollbackConfirmButton', 'Roll Back'),
		});
		if (!confirmed) {
			return;
		}

		try {
			const ok = await checkpointService.rollbackToCheckpoint(item.path, target.ref);
			if (ok) {
				notificationService.info(localize('worktreeRollbackDone', 'Worktree restored to checkpoint "{0}".', target.name));
			} else {
				notificationService.error(localize('worktreeRollbackFailed', 'Failed to restore worktree to checkpoint "{0}". See logs for details.', target.name));
			}
		} catch (e) {
			notificationService.error(localize('worktreeRollbackError', 'Failed to roll back worktree: {0}', (e as Error).message));
		}
	}
});

// ─── Reset Worktree Command ────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Reset,
			title: localize2('worktreeReset', 'Reset Worktree'),
			icon: Codicon.discard,
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);

		// Get worktree path from the selected tree item
		const worktreePath = args[0]?.worktreePath ?? args[0]?.path;
		if (!worktreePath) {
			notificationService.warn(localize('worktreeResetNoPath', 'No worktree selected.'));
			return;
		}

		// ★★ 2026-09-15：**加确认**。原实现零确认直接执行，而 `resetWorktree()` 做的是
		// `fetch` + `reset --hard <默认分支>` + **`clean -ffdx`** + submodule reset
		// —— 即「丢弃全部未提交改动」+「**删除所有未跟踪文件**（含被 gitignore 的）」。
		//
		// 实测确认（临时仓库）：`clean -ffdx` 会删掉 worktree 里指向主仓的 `node_modules`
		// **junction 本身**（主仓内容安全，但该 worktree 的依赖被清空、需重建）。
		// 同时会删掉 `.env` 这类本地配置与 Agent 尚未提交的产出。
		//
		// 破坏性不亚于「删 worktree」，而删除早就该有确认 —— 这里补齐。
		const label = args[0]?.label ?? worktreePath;
		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: localize('worktreeResetConfirm', 'Reset worktree "{0}" to the default branch?', label),
			detail: [
				'This will discard ALL uncommitted changes in the worktree.',
				'It also runs `git clean -ffdx`, which DELETES every untracked file —',
				'including gitignored ones such as node_modules (the dev junction), .env, and',
				'any Agent output that has not been committed yet.',
			].join('\n'),
			primaryButton: localize('worktreeResetConfirmButton', 'Reset'),
		});
		if (!confirmed) {
			return;
		}

		try {
			await worktreeService.resetWorktree(worktreePath);
			notificationService.info(localize('worktreeResetDone', 'Worktree reset to default branch.'));
		} catch (e) {
			notificationService.error(localize('worktreeResetError', 'Failed to reset worktree: {0}', (e as Error).message));
		}
	}
});

// ─── Create Worktree With Branch Command (opencode pattern) ────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.CreateWithBranch,
			title: localize2('worktreeCreateWithBranch', 'Create Isolated Worktree'),
			icon: Codicon.gitBranch,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);

		// Ask for a name
		const name = await quickInputService.input({
			placeHolder: localize('worktreeCreateNamePlaceholder', 'Worktree name (e.g. feature-auth)'),
			prompt: localize('worktreeCreateNamePrompt', 'Enter a name for the new worktree. A branch "opencode/<name>" will be created.'),
		});

		if (!name?.trim()) {
			return;
		}

		try {
			// Two-phase creation (opencode pattern)
			const info = await worktreeService.makeWorktreeInfo({ name: name.trim() });
			await worktreeService.createFromInfo(info);

			notificationService.info(localize('worktreeCreateWithBranchDone',
				'Created worktree "{0}" at branch "{1}"', info.name, info.branch ?? '(detached)'));
		} catch (e) {
			notificationService.error(localize('worktreeCreateWithBranchError',
				'Failed to create worktree: {0}', (e as Error).message));
		}
	}
});
