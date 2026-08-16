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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { SessionsExplorerViewPaneContainer } from './sessionsExplorerViewPaneContainer.js';
import { SESSIONS_FILES_EMPTY_VIEW_ID, SESSIONS_FILES_VIEW_ID, SessionsExplorerEmptyView, SessionsExplorerView } from './filesView.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
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

		// Get worktree path from the selected tree item
		const worktreePath = args[0]?.worktreePath ?? args[0]?.path;
		if (!worktreePath) {
			notificationService.warn(localize('worktreeResetNoPath', 'No worktree selected.'));
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
