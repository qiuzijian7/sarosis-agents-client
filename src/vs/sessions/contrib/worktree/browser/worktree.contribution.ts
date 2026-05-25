/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { registerAction2, Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { WorktreeService } from './worktreeService.js';
import { WorktreeViewPane } from './worktreeView.js';
import { WORKTREE_VIEW_ID, WORKTREE_VIEW_CONTAINER_ID, WorktreeCommands } from '../common/worktreeTypes.js';
import { WorktreeItem } from './worktreeDataProvider.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

// --- Icon ---

const worktreeViewIcon = registerIcon('worktree-view-icon', Codicon.gitBranch, localize('worktreeViewIcon', 'View icon of the Worktree view.'));

// --- Register Service ---

registerSingleton(IWorktreeService, WorktreeService, InstantiationType.Delayed);

// --- Register View Container (in Sidebar, for sessions window) ---

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const worktreeViewContainer = viewContainerRegistry.registerViewContainer({
	id: WORKTREE_VIEW_CONTAINER_ID,
	title: localize2('worktree', 'Worktrees'),
	icon: worktreeViewIcon,
	order: 3,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [WORKTREE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: WORKTREE_VIEW_CONTAINER_ID,
	hideIfEmpty: true,
	openCommandActionDescriptor: {
		id: WORKTREE_VIEW_CONTAINER_ID,
		mnemonicTitle: localize({ key: 'miWorktree', comment: ['&& denotes a mnemonic'] }, "Wor&&ktrees"),
		keybindings: {
			primary: 0,
		},
		order: 3,
	},
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.Sidebar, { isDefault: false });

// --- Register Views ---

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: WORKTREE_VIEW_ID,
	name: localize2('worktreeList', 'Worktrees'),
	containerIcon: worktreeViewIcon,
	ctorDescriptor: new SyncDescriptor(WorktreeViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	weight: 40,
	order: 1,
	windowEnablement: WindowEnablement.Sessions,
}], worktreeViewContainer);

// --- Register Commands ---

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Refresh,
			title: localize2('worktreeRefresh', 'Refresh Worktrees'),
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', WORKTREE_VIEW_ID),
				group: 'navigation',
				order: 10,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const worktreeService = accessor.get(IWorktreeService);
		const repoRoot = await worktreeService.getRepositoryRoot();
		if (repoRoot) {
			// Re-list worktrees to trigger a refresh
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
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', WORKTREE_VIEW_ID),
				group: 'navigation',
				order: 20,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		notificationService.info(localize('worktreeCreateInfo', 'Create worktree: Use the command palette to specify branch name and path.'));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.Delete,
			title: localize2('worktreeDelete', 'Delete Worktree'),
			icon: Codicon.trash,
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', WORKTREE_VIEW_ID),
					ContextKeyExpr.regex('viewItem', /^(?!.*worktreeMain).*$/i)
				),
				group: 'inline',
				order: 10,
			},
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
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.equals('view', WORKTREE_VIEW_ID),
				group: 'navigation',
				order: 10,
			},
		});
	}

	async run(accessor: ServicesAccessor, path: string): Promise<void> {
		if (!path) {
			return;
		}

		const hostService = accessor.get(IHostService);

		// Open the worktree folder in a new window
		const uri = URI.file(path);
		hostService.openWindow([{ folderUri: uri }], { forceNewWindow: true });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WorktreeCommands.OpenInTerminal,
			title: localize2('worktreeOpenInTerminal', 'Open in Terminal'),
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.equals('view', WORKTREE_VIEW_ID),
				group: 'navigation',
				order: 20,
			},
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
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', WORKTREE_VIEW_ID),
				group: '2_worktree',
				order: 10,
			},
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
