/*---------------------------------------------------------------------------------------------
 *  AgentStudio Source Control Contribution
 *
 *  Registers a custom Source Control panel for the Sessions window that combines:
 *  1. SCM Changes view (reuses native SCMViewPane — shares ISCMService data)
 *  2. SCM Repositories view (reuses native SCMRepositoriesViewPane)
 *  3. Worktree view (reuses WorktreeViewPane)
 *
 *  Also syncs the VS Code workspace folders when the active AgentStudio workspace
 *  changes, so the SCM panel always reflects the correct git repository.
 *
 *  The native Source Control panel is NOT modified.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService, ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { SCMViewPane, ContextKeys } from '../../../../workbench/contrib/scm/browser/scmViewPane.js';
import { SCMRepositoriesViewPane } from '../../../../workbench/contrib/scm/browser/scmRepositoriesViewPane.js';
import { SCMHistoryViewPane } from '../../../../workbench/contrib/scm/browser/scmHistoryViewPane.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IAgentStudioService } from '../../agentStudio/common/agentStudio.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { WorktreeViewPane } from '../../worktree/browser/worktreeView.js';
import { WorktreeCommands, WorktreeContextKeys } from '../../worktree/common/worktreeTypes.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { SourceControlViewPaneContainer } from './sourceControlViewPaneContainer.js';

// ─── View Container & View IDs ────────────────────────────────────────────────

export const SESSIONS_SOURCE_CONTROL_CONTAINER_ID = 'sessions.sourceControl.container';
export const SESSIONS_SCM_CHANGES_VIEW_ID = 'sessions.scm.changes';
export const SESSIONS_SCM_REPOSITORIES_VIEW_ID = 'sessions.scm.repositories';
export const SESSIONS_SCM_WORKTREE_VIEW_ID = 'sessions.scm.worktrees';
export const SESSIONS_SCM_GRAPH_VIEW_ID = 'sessions.scm.graph';

// ─── Context Keys ────────────────────────────────────────────────────────────
/** Whether the active workspace's directory contains a .git folder */
export const SessionsHasGitRepo = new RawContextKey<boolean>('sessions.hasGitRepo', false, localize('sessionsHasGitRepo', 'Whether the active workspace has a git repository'));

// ─── Icons ────────────────────────────────────────────────────────────────────

const sourceControlViewIcon = registerIcon('sessions-source-control-view-icon', Codicon.sourceControl, localize2('sessionsSourceControlViewIcon', 'View icon of the Source Control view in the sessions window.').value);

// ─── Register View Container ──────────────────────────────────────────────────

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const sourceControlViewContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_SOURCE_CONTROL_CONTAINER_ID,
	title: localize2('agentStudioSourceControl', 'Source Control'),
	icon: sourceControlViewIcon,
	order: 3,
	ctorDescriptor: new SyncDescriptor(SourceControlViewPaneContainer),
	storageId: SESSIONS_SOURCE_CONTROL_CONTAINER_ID,
	alwaysUseContainerInfo: true,
	hideIfEmpty: true,
	openCommandActionDescriptor: {
		id: SESSIONS_SOURCE_CONTROL_CONTAINER_ID,
		title: localize2('agentStudioSourceControl', 'Source Control'),
		mnemonicTitle: localize({ key: 'miAgentStudioSourceControl', comment: ['&& denotes a mnemonic'] }, 'Source &&Control'),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyG },
		order: 3,
	},
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.Sidebar);

// ─── Register Views ───────────────────────────────────────────────────────────

class RegisterSourceControlViewsContribution implements IWorkbenchContribution {

	static readonly ID = 'sessions.registerSourceControlViews';

	constructor() {
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
		const containerTitle = localize('agentStudioSourceControl', 'Source Control');

		// ── Repositories view (hidden by default, like native) ──
		viewsRegistry.registerViews([{
			id: SESSIONS_SCM_REPOSITORIES_VIEW_ID,
			containerTitle,
			name: localize2('scmRepositories', 'Repositories'),
			singleViewPaneContainerTitle: localize('sourceControlRepositories', 'Source Control Repositories'),
			ctorDescriptor: new SyncDescriptor(SCMRepositoriesViewPane),
			canToggleVisibility: true,
			hideByDefault: true,
			canMoveView: false,
			weight: 20,
			order: 0,
			when: ContextKeyExpr.and(ContextKeyExpr.has('scm.providerCount'), ContextKeyExpr.notEquals('scm.providerCount', 0)),
			containerIcon: sourceControlViewIcon,
			windowEnablement: WindowEnablement.Sessions,
		}], sourceControlViewContainer);

		// ── Changes view (primary view — same as native SCM) ──
		viewsRegistry.registerViews([{
			id: SESSIONS_SCM_CHANGES_VIEW_ID,
			containerTitle,
			name: localize2('scmChanges', 'Changes'),
			singleViewPaneContainerTitle: containerTitle,
			ctorDescriptor: new SyncDescriptor(SCMViewPane),
			canToggleVisibility: true,
			canMoveView: false,
			weight: 40,
			order: 1,
			containerIcon: sourceControlViewIcon,
			windowEnablement: WindowEnablement.Sessions,
		}], sourceControlViewContainer);

		// ── Worktree view ──
		viewsRegistry.registerViews([{
			id: SESSIONS_SCM_WORKTREE_VIEW_ID,
			containerTitle,
			name: localize2('worktrees', 'Worktrees'),
			ctorDescriptor: new SyncDescriptor(WorktreeViewPane),
			canToggleVisibility: true,
			canMoveView: false,
			weight: 20,
			order: 2,
			when: ContextKeyExpr.and(
				IsPhoneLayoutContext.negate(),
				SessionsHasGitRepo
			),
			windowEnablement: WindowEnablement.Sessions,
		}], sourceControlViewContainer);

		// ── Graph view (commit history) ──
		viewsRegistry.registerViews([{
			id: SESSIONS_SCM_GRAPH_VIEW_ID,
			containerTitle,
			name: localize2('scmGraph', 'Graph'),
			singleViewPaneContainerTitle: localize('sourceControlGraph', 'Source Control Graph'),
			ctorDescriptor: new SyncDescriptor(SCMHistoryViewPane),
			canToggleVisibility: true,
			canMoveView: false,
			weight: 40,
			order: 3,
			when: ContextKeyExpr.and(
				ContextKeyExpr.has('scm.historyProviderCount'),
				ContextKeyExpr.notEquals('scm.historyProviderCount', 0),
			),
			containerIcon: sourceControlViewIcon,
			windowEnablement: WindowEnablement.Sessions,
		}], sourceControlViewContainer);

		// ── View welcome content for Graph view ──
		viewsRegistry.registerViewWelcomeContent(SESSIONS_SCM_GRAPH_VIEW_ID, {
			content: localize('noHistoryItems', 'The selected source control provider does not have any source control history items.'),
			when: ContextKeys.SCMHistoryItemCount.isEqualTo(0)
		});

		// ── View welcome content for Changes view ──
		// No workspace selected at all
		viewsRegistry.registerViewWelcomeContent(SESSIONS_SCM_CHANGES_VIEW_ID, {
			content: localize('noWorkspaceSourceControl', 'No workspace selected\n\nSelect a workspace in the toolbar above to view its source control status.'),
			when: ContextKeyExpr.equals('sessions.hasGitRepo', false)
		});

		// No git repo in the active workspace
		viewsRegistry.registerViewWelcomeContent(SESSIONS_SCM_CHANGES_VIEW_ID, {
			content: localize('noGitInWorkspace', 'No Git repository found\n\nThe current workspace directory does not contain a `.git` folder. Open a workspace with a Git repository to see source control changes here.'),
			when: ContextKeyExpr.and(
				SessionsHasGitRepo,
				ContextKeyExpr.notEquals('scm.providerCount', undefined),
				ContextKeyExpr.equals('scm.providerCount', 0),
			)
		});
	}
}

registerWorkbenchContribution2(RegisterSourceControlViewsContribution.ID, RegisterSourceControlViewsContribution, WorkbenchPhase.BlockStartup);

// ─── Workspace Folder Sync ─────────────────────────────────────────────────
// When the user switches the active workspace in the AgentStudio toolbar,
// update the VS Code workspace folders so that the Git extension discovers
// the new repository and the SCM views refresh automatically.
// Also maintains the `sessions.hasGitRepo` context key.

class SourceControlWorkspaceSyncContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.sourceControlWorkspaceSync';

	private _activeWorkspaceId: string | undefined;
	private readonly _domEventHandler: (e: Event) => void;
	private _hasGitRepoKey: IContextKey<boolean>;

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IFileService private readonly fileService: IFileService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorktreeService private readonly worktreeService: IWorktreeService,
	) {
		super();

		this._hasGitRepoKey = SessionsHasGitRepo.bindTo(contextKeyService);

		// Listen for workspace switch via DOM event (fired by AgentStudioWorkspaceToolbar)
		this._domEventHandler = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId) {
				this._activeWorkspaceId = detail.workspaceId;
				this._syncWorkspaceFolder(detail.workspaceId);
			}
		};
		document.addEventListener('agent-studio:active-workspace-changed', this._domEventHandler);
		this._register({
			dispose: () => document.removeEventListener('agent-studio:active-workspace-changed', this._domEventHandler),
		});

		// Listen for workspace data mutations — only sync if it affects the active workspace
		this._register(this.agentStudioService.onDidChangeWorkspace((workspaceId: string) => {
			if (workspaceId === this._activeWorkspaceId) {
				this._syncWorkspaceFolder(workspaceId);
			}
		}));

		// When VS Code workspace folders change, update git detection context key
		// and refresh the worktree view
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._updateGitContextKey();
		}));

		// Initial sync: resolve the first workspace if none is active yet
		this._initialSync();
	}

	private async _initialSync(): Promise<void> {
		try {
			const workspaces = await this.agentStudioService.getWorkspaces();
			if (workspaces.length > 0) {
				// Use the first workspace as the active one on startup
				this._activeWorkspaceId = workspaces[0].id;
				await this._syncWorkspaceFolder(workspaces[0].id);
			} else {
				this._hasGitRepoKey.set(false);
			}
		} catch {
			this._hasGitRepoKey.set(false);
		}
	}

	private async _syncWorkspaceFolder(workspaceId: string): Promise<void> {
		const workspace = await this.agentStudioService.getWorkspace(workspaceId);
		if (!workspace) {
			this._hasGitRepoKey.set(false);
			return;
		}

		// Resolve the effective folder URI for the workspace
		// Priority: worktreePath > path
		let folderPath: string | undefined;
		if (workspace.worktreePath) {
			folderPath = workspace.worktreePath;
		} else if (workspace.path) {
			folderPath = workspace.path;
		}

		if (!folderPath) {
			this._hasGitRepoKey.set(false);
			return;
		}

		const folderUri = URI.file(folderPath);
		const currentFolders = this.workspaceContextService.getWorkspace().folders;

		// If there's already a folder and it matches, no folder update needed
		// but still check for git
		if (currentFolders.length > 0 && this.uriIdentityService.extUri.isEqual(currentFolders[0].uri, folderUri)) {
			await this._updateGitContextKey();
			return;
		}

		// Derive a readable name for the folder
		const folderName = workspace.name || this.uriIdentityService.extUri.basenameOrAuthority(folderUri);
		const folderData = { uri: folderUri, name: folderName };

		try {
			if (currentFolders.length === 0) {
				await this.workspaceEditingService.addFolders([folderData], true);
			} else {
				await this.workspaceEditingService.updateFolders(0, currentFolders.length, [folderData], true);
			}
		} catch (err) {
			console.warn('[SourceControlWorkspaceSync] Failed to sync workspace folder:', err);
		}

		// After folder sync, update git context key
		await this._updateGitContextKey();
	}

	private async _updateGitContextKey(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			this._hasGitRepoKey.set(false);
			return;
		}

		// Check if any workspace folder contains a .git directory
		let hasGit = false;
		for (const folder of folders) {
			try {
				const gitPath = URI.joinPath(folder.uri, '.git');
				const stat = await this.fileService.stat(gitPath);
				if (stat) {
					hasGit = true;
					break;
				}
			} catch {
				// No .git in this folder, continue checking
			}
		}

		this._hasGitRepoKey.set(hasGit);

		// If git is found, trigger worktree data refresh
		if (hasGit) {
			try {
				await this.worktreeService.getRepositoryRoot();
			} catch {
				// Ignore
			}
		}
	}
}

registerWorkbenchContribution2(SourceControlWorkspaceSyncContribution.ID, SourceControlWorkspaceSyncContribution, WorkbenchPhase.BlockStartup);

// ─── Worktree Menu Items for the Worktree view ────────────────────────────────
// Commands are registered in worktree.contribution.ts / files.contribution.ts;
// we add menu entries for the Source Control worktree view.

const WT_WHEN = ContextKeyExpr.equals('view', SESSIONS_SCM_WORKTREE_VIEW_ID);
const WT_NOT_MAIN = ContextKeyExpr.and(
	WT_WHEN,
	ContextKeyExpr.regex('viewItem', /^(?!.*worktreeMain).*$/i)
);
const WT_RESET_WHEN = ContextKeyExpr.and(
	WT_WHEN,
	ContextKeyExpr.notEquals(WorktreeContextKeys.WorktreeIsMain, true),
);

// Refresh
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.Refresh, title: localize2('worktreeRefresh', 'Refresh Worktrees'), icon: Codicon.refresh },
	when: WT_WHEN,
	group: 'navigation',
	order: 10,
});

// Create
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.Create, title: localize2('worktreeCreate', 'Create Worktree'), icon: Codicon.add },
	when: WT_WHEN,
	group: 'navigation',
	order: 20,
});

// Create With Branch
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.CreateWithBranch, title: localize2('worktreeCreateWithBranch', 'Create Isolated Worktree'), icon: Codicon.gitBranch },
	when: WT_WHEN,
	group: 'navigation',
	order: 3,
});

// Delete
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.Delete, title: localize2('worktreeDelete', 'Delete Worktree'), icon: Codicon.trash },
	when: WT_NOT_MAIN,
	group: 'inline',
	order: 10,
});

// Open
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.Open, title: localize2('worktreeOpen', 'Open Worktree Folder') },
	when: WT_WHEN,
	group: 'navigation',
	order: 10,
});

// Open in Terminal
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.OpenInTerminal, title: localize2('worktreeOpenInTerminal', 'Open in Terminal') },
	when: WT_WHEN,
	group: 'navigation',
	order: 20,
});

// Prune
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.Prune, title: localize2('worktreePrune', 'Prune Stale Worktrees') },
	when: WT_WHEN,
	group: '2_worktree',
	order: 10,
});

// Reset
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.Reset, title: localize2('worktreeReset', 'Reset Worktree'), icon: Codicon.discard },
	when: WT_RESET_WHEN,
	group: '2_worktree',
	order: 5,
});
