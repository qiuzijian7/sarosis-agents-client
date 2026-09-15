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
import { ISCMViewService, ISCMService, ISCMRepository } from '../../../../workbench/contrib/scm/common/scm.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceFolderRouter } from '../../workspace/common/workspaceFolderRouter.js';
import {
	resolveSyncDirection,
	WORKSPACE_FOLDER_SYNC_DIRECTION_SETTING,
} from '../../agentStudio/common/workspaceFolderSyncPolicy.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IAgentStudioService } from '../../agentStudio/common/agentStudio.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { WorktreeViewPane } from '../../worktree/browser/worktreeView.js';
import { WorktreeCommands } from '../../worktree/common/worktreeTypes.js';
import { WorktreeItemType } from '../../worktree/browser/worktreeDataProvider.js';
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
	order: 30,
	ctorDescriptor: new SyncDescriptor(SourceControlViewPaneContainer),
	storageId: SESSIONS_SOURCE_CONTROL_CONTAINER_ID,
	alwaysUseContainerInfo: true,
	hideIfEmpty: true,
	openCommandActionDescriptor: {
		id: SESSIONS_SOURCE_CONTROL_CONTAINER_ID,
		title: localize2('agentStudioSourceControl', 'Source Control'),
		mnemonicTitle: localize({ key: 'miAgentStudioSourceControl', comment: ['&& denotes a mnemonic'] }, 'Source &&Control'),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyG },
		order: 30,
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
	/**
	 * The active workspace's target roots from the most recent sync. Used by the
	 * onDidAddRepository listener so that a repository registered asynchronously
	 * (after the folder change) is immediately reconciled against the current
	 * workspace without waiting for the next switch.
	 */
	private _currentAllowedRoots: readonly URI[] = [];

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceFolderRouter private readonly workspaceFolderRouter: IWorkspaceFolderRouter,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IFileService private readonly fileService: IFileService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorktreeService private readonly worktreeService: IWorktreeService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@ISCMService private readonly scmService: ISCMService,
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

		// Listen for active workspace switches via the service event (unified path).
		// This drives SCM multi-repo sync whenever setActiveWorkspace / addRelatedFolder fires.
		//
		// CRITICAL: do NOT set _hasGitRepoKey.set(false) when workspaceId is undefined. The
		// active-workspace-changed event commonly fires with undefined both at startup ("no
		// active yet") and during multi-workspace transitions ("old workspace cleared").
		// Synchronously setting false here immediately hides the Worktree view (whose
		// `when` requires SessionsHasGitRepo), and even if a workspaceId is set moments
		// later in the same tick, there is a real window where the view disappears. The
		// authoritative decision on hasGitRepo must come from _updateGitContextKey()
		// after the folder change, when we can actually stat .git in the new folder set.
		this._register(this.agentStudioService.onDidChangeActiveWorkspace((workspaceId: string | undefined) => {
			this._activeWorkspaceId = workspaceId;
			if (workspaceId) {
				this._syncWorkspaceFolder(workspaceId);
			}
		}));

		// When VS Code workspace folders change, update git detection context key
		// and refresh the worktree view.
		//
		// CRITICAL: We must NOT call _initialSync() here. _initialSync()'s else-branch
		// (when agentStudioService.getActiveWorkspaceId() returns undefined, e.g. when
		// the listener fires during BlockStartup before the service is ready) synchronously
		// sets _hasGitRepoKey.set(false). That immediately makes SessionsHasGitRepo=false,
		// which removes the Worktree view (whose `when` condition requires
		// SessionsHasGitRepo). The subsequent async _updateGitContextKey() would
		// normally re-set it to true after stat'ing .git, but there a window where the
		// view disappears, and if agentStudioService never becomes ready on this path,
		// the view stays gone.
		//
		// Instead, drive _updateGitContextKey() (which is the authoritative decision on
		// hasGitRepo based on .git presence) and, if we already know the active
		// workspace, re-drive _syncWorkspaceFolder() so the trust injection that lets
		// the git extension's openRepository() register an SCM provider still runs on
		// folder changes.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(async () => {
			await this._updateGitContextKey();
			const activeId = this._activeWorkspaceId ?? this.agentStudioService.getActiveWorkspaceId();
			if (activeId) {
				await this._syncWorkspaceFolder(activeId);
			}
		}));

		// When a repository is registered asynchronously (the git extension opens
		// SCM providers after a folder change, and sessions opens some explicitly),
		// reconcile it against the active workspace's roots right away. This is the
		// event-driven complement to the setTimeout reconciles in
		// _pruneVisibleRepositories and covers the case where a repo registers
		// later than the t+1000ms window.
		this._register(this.scmService.onDidAddRepository(repo => {
			this._pruneVisibleRepositories(this._currentAllowedRoots);
		}));

		// Initial sync: resolve the first workspace if none is active yet
		this._initialSync();
	}

	private async _initialSync(): Promise<void> {
		try {
			// Prefer the runtime-active workspace; fall back to first workspace.
			let activeId = this.agentStudioService.getActiveWorkspaceId();
			if (!activeId) {
				const workspaces = await this.agentStudioService.getWorkspaces();
				if (workspaces.length > 0) {
					activeId = workspaces[0].id;
				}
			}
			if (activeId) {
				this._activeWorkspaceId = activeId;
				await this._syncWorkspaceFolder(activeId);
			}
			// else: do NOT set _hasGitRepoKey.set(false) here. The onDidChangeWorkspaceFolders
			// listener (registered above) will run _updateGitContextKey() which is the
			// authoritative decision on hasGitRepo based on .git presence in the workspace
			// folders. Setting false here would cause a synchronous false→true flicker that
			// hides the Worktree view (whose `when` requires SessionsHasGitRepo).
		} catch {
			// Real errors (e.g. agentStudioService unavailable) are still surfaced by the
			// listener's subsequent _updateGitContextKey() call; we don't mutate the key here.
		}
	}

	private async _syncWorkspaceFolder(workspaceId: string): Promise<void> {
		const workspace = await this.agentStudioService.getWorkspace(workspaceId);
		if (!workspace) {
			this._hasGitRepoKey.set(false);
			return;
		}

		// Build the target root set for the active workspace:
		//   home dir (workspace.path) + all relatedFolders + worktree (if any).
		// Each related folder becomes an independent SCM git root.
		const targets: { uri: URI; name: string }[] = [];
		const seen = new Set<string>();
		const pushTarget = (rawPath: string, name: string) => {
			const norm = rawPath.replace(/[\\/]+$/, '').toLowerCase();
			if (!norm || seen.has(norm)) {
				return;
			}
			seen.add(norm);
			targets.push({ uri: URI.file(rawPath), name });
		};

		// Home directory (stores metadata; kept as a root so agent artifacts land here)
		if (workspace.path) {
			pushTarget(workspace.path, workspace.name || this.uriIdentityService.extUri.basenameOrAuthority(URI.file(workspace.path)));
		}
		// Related code repositories — git extension auto-discovers .git under each root
		for (const rf of workspace.relatedFolders ?? []) {
			if (rf?.path) {
				pushTarget(rf.path, rf.name || this.uriIdentityService.extUri.basenameOrAuthority(URI.file(rf.path)));
			}
		}
		// Worktree (if assigned)
		if (workspace.worktreePath) {
			pushTarget(workspace.worktreePath, workspace.worktreeBranch || 'worktree');
		}

		if (targets.length === 0) {
			this._hasGitRepoKey.set(false);
			// No roots for this workspace (e.g. empty folder with no git) — hide any
			// stale SCM repositories left visible from a previously active workspace.
			this._pruneVisibleRepositories([]);
			return;
		}

		// CRITICAL: Mark every target root as workspace-trusted BEFORE injecting them
		// as workspace folders. The git extension's openRepository() gates on
		// workspace.requestResourceTrust(); in the Sessions window the synthetic
		// in-memory workspace never auto-trusts these roots, so the trust request
		// returns a pending promise that no dialog ever resolves — openRepository
		// bails out, no SCM provider is registered, and the Changes view shows
		// "No Git repository found" even though .git exists. Trusting the roots up
		// front makes getUriTrustInfo() return trusted=true synchronously, so the
		// git extension can open the repositories on the subsequent folder change.
		try {
			const urisToTrust = targets
				.map(t => t.uri)
				.filter(uri => !this._isUriTrusted(uri));
			if (urisToTrust.length > 0) {
				await this.workspaceTrustManagementService.setUrisTrust(urisToTrust, true);
			}
		} catch (err) {
			console.warn('[SourceControlWorkspaceSync] Failed to mark workspace roots as trusted:', err);
		}

		const targetUris = targets.map(t => t.uri);

		// ★★ 2026-09-14 修订（方案 B' Step 1 的补丁，**血的教训**）：
		//
		// 「窗口是真源」时，SCM 同步**不得**再把 registry 的 root 注入 folder 列表。
		//
		// 事故复盘：本方法由 `onDidChangeActiveWorkspace` 驱动，而注入用的是**追加式**合并
		// （只加不减）。于是切到 `VsSaros_S1Game` 工作区时把它的 root（含 87.6 万节点的 UE5EA）
		// 追加进窗口，切回来时**从不移除** ⇒ folder 列表单向膨胀；而标准 `WorkspaceService`
		// 的 `updateFolders` **会落盘** ⇒ 用户手写的 `.code-workspace` 被回写成 5 个 folder
		// （实测 22:28:33），再被反向投影固化进 registry 的 `relatedFolders`。
		// 这正是历史事故「跨工作区污染 → renderer 堆 2.6GB 卡死」的复现路径。
		//
		// 新语义：**切换 Agent Studio 工作区 = 打开那个工作区**（`projectBarPart` 走
		// `hostService.openWindow`，用户 2026-09-14 裁决为复用当前窗口），而不是往当前窗口
		// 追加 root。所以这里只保留「按窗口现有 folder 做 SCM 投影」的职责：
		// trust（上方已做，git 扩展开仓库的前置）+ prune（下方，隐藏非本工作区的仓库）。
		//
		// 旧方向（`registry-drives-window`）保留注入，否则回滚后 SCM 会看不到仓库。
		if (resolveSyncDirection(this.configurationService.getValue(WORKSPACE_FOLDER_SYNC_DIRECTION_SETTING)) === 'registry-drives-window') {
			await this.workspaceFolderRouter.ensureFolders(targets, 'scm-workspace-sync');
		}

		// After folder sync, update git context key
		await this._updateGitContextKey();

		// Folder sync replaced the VS Code workspace folders, but the git extension
		// does NOT close SCM providers for removed folders (and sessions opens some
		// repositories explicitly via gitService.openRepository, which are never
		// auto-closed). Hide any visible repository whose root is not part of the
		// active workspace's target roots so the Changes view never shows another
		// workspace's repositories. New repositories for the active workspace are
		// registered asynchronously, so also prune on the next registrations.
		this._pruneVisibleRepositories(targetUris);
	}

	/**
	 * Reconcile the SCM Changes/Graph views so they show EXACTLY the repositories
	 * that belong to the active workspace's target roots. A repository "belongs"
	 * if its provider rootUri equals, or is nested under, one of the target roots.
	 *
	 * This is an *alignment* operation, not a one-way prune:
	 *   - REMOVE visible repositories that don't belong to the active workspace, AND
	 *   - ADD already-registered repositories that DO belong but aren't currently
	 *     visible.
	 *
	 * The "add" half is the critical fix for the switch-back bug: sessions opens
	 * git repositories explicitly via gitService.openRepository and NEVER closes
	 * them. The git extension only fires onDidAddRepository on the *first*
	 * registration, so once a repo has been pruned out of visibleRepositories
	 * (because another workspace was active), switching back will NOT re-fire
	 * onDidAddRepository — nothing would ever add it back, leaving Changes empty
	 * and Graph showing "no history items". By scanning ISCMService.repositories
	 * (the full registry) we can re-show repos that are already registered.
	 *
	 * This does NOT close the underlying SCM provider (IGitService exposes no
	 * close API) — it only adjusts ISCMViewService.visibleRepositories, which is
	 * what the native SCMViewPane / SCMHistoryViewPane render. An empty allowed
	 * set hides everything (used for git-less workspaces such as an empty folder).
	 */
	private _pruneVisibleRepositories(allowedRoots: readonly URI[]): void {
		// Remember the active workspace's roots so the onDidAddRepository listener
		// can reconcile late-registering repositories against the current target.
		this._currentAllowedRoots = allowedRoots;
		const tag = '[SourceControlWorkspaceSync]';
		const fmt = (u: URI | undefined) => u ? u.fsPath : '<no-root>';
		const reconcile = (phase: string) => {
			const belongs = (repo: ISCMRepository): boolean => {
				const root = repo.provider.rootUri;
				if (!root) {
					// Providers without a root (e.g. virtual) are not workspace-scoped; hide them.
					return false;
				}
				return allowedRoots.some(allowed =>
					this.uriIdentityService.extUri.isEqual(allowed, root) ||
					this.uriIdentityService.extUri.isEqualOrParent(root, allowed));
			};

			// All repositories currently registered with the SCM service (sessions
			// opens these explicitly and never closes them).
			const allRepos = Array.from(this.scmService.repositories);
			const currentVisible = this.scmViewService.visibleRepositories;
			const currentVisibleSet = new Set(currentVisible);

			// Desired visible set = every registered repo that belongs, preserving
			// registry order for determinism.
			const desired = allRepos.filter(belongs);
			const desiredSet = new Set(desired);

			const toAdd = desired.filter(r => !currentVisibleSet.has(r));
			const toRemove = currentVisible.filter(r => !desiredSet.has(r));

			console.debug(`${tag} reconcile[${phase}] allowedRoots=[${allowedRoots.map(fmt).join(', ')}]`);
			console.debug(`${tag}   registered(${allRepos.length})=[${allRepos.map(r => fmt(r.provider.rootUri)).join(', ')}]`);
			console.debug(`${tag}   visibleBefore(${currentVisible.length})=[${currentVisible.map(r => fmt(r.provider.rootUri)).join(', ')}]`);
			console.debug(`${tag}   desired(${desired.length})=[${desired.map(r => fmt(r.provider.rootUri)).join(', ')}]`);
			console.debug(`${tag}   toAdd(${toAdd.length})=[${toAdd.map(r => fmt(r.provider.rootUri)).join(', ')}] toRemove(${toRemove.length})=[${toRemove.map(r => fmt(r.provider.rootUri)).join(', ')}]`);

			if (toAdd.length === 0 && toRemove.length === 0) {
				console.debug(`${tag}   reconcile[${phase}] no change`);
				return;
			}
			// Assign the fully-aligned desired set in registry order. Setting the
			// array wholesale (rather than add/remove deltas) guarantees the view
			// ends up showing exactly the active workspace's repositories.
			this.scmViewService.visibleRepositories = desired;
			console.log(`${tag}   reconcile[${phase}] APPLIED visibleAfter(${desired.length})=[${desired.map(r => fmt(r.provider.rootUri)).join(', ')}]`);
		};
		// Reconcile now for repositories already registered…
		reconcile('immediate');
		// …and again shortly after, to catch repositories whose SCM providers the
		// git extension registers asynchronously following the folder change.
		setTimeout(() => reconcile('t+300'), 300);
		setTimeout(() => reconcile('t+1000'), 1000);
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

	/** Whether the given URI is already marked as workspace-trusted. */
	private _isUriTrusted(uri: URI): boolean {
		return this.workspaceTrustManagementService
			.getTrustedUris()
			.some(trustedUri => this.uriIdentityService.extUri.isEqual(trustedUri, uri));
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
/**
 * ★ 2026-09-15 修正：原先用 `ContextKeyExpr.notEquals(WorktreeContextKeys.WorktreeIsMain, true)`，
 * 但该键**全仓只声明、从未绑定**（`worktreeDataProvider` 只绑了 `HasWorktrees` / `WorktreeCount`）
 * ⇒ `notEquals(undefined, true)` 恒为 true ⇒ **Reset 菜单对主工作树也显示**。
 * 主工作树上执行 Reset = 对主 checkout 做 `reset --hard` + `clean -ffdx`（opencode 明确禁止），
 * 属破坏性误操作。改用真正可用的机制：`viewItem` = 树项的 `contextValue`
 * （见 `WorktreeItemType`），与上面的 `WT_NOT_MAIN` 同一手法。
 */
const WT_RESET_WHEN = WT_NOT_MAIN;

/**
 * 精确匹配某个树项类型（`WorktreeItem.contextValue`）。
 *
 * ⚠ 必须走 `viewItem`：`WorktreeContextKeys` 里的 `WorktreeIsMain/IsDetached/IsLocked/IsPrunable`
 * 都**没有绑定**，用它们写 when 会让菜单永不出现（或恒出现）。
 */
const wtItemIs = (type: WorktreeItemType) => ContextKeyExpr.and(WT_WHEN, ContextKeyExpr.equals('viewItem', type));
const WT_ITEM_BRANCH = wtItemIs(WorktreeItemType.WorktreeBranch);
const WT_ITEM_LOCKED = wtItemIs(WorktreeItemType.WorktreeLocked);

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

// Rollback to Checkpoint（★ 2026-09-15）—— 与「Create Checkpoint」成对：
// 此前只有创建、没有回滚（`rollbackToCheckpoint` 无任何可达调用点）。
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.RollbackCheckpoint, title: localize2('worktreeRollbackCheckpoint', 'Rollback Worktree to Checkpoint…'), icon: Codicon.history },
	when: WT_RESET_WHEN,
	group: '2_worktree',
	order: 6,
});

// ─── Lock / Unlock（★ 2026-09-15）─────────────────────────────────────────────
//
// 二者互斥：只有「普通分支树」能上锁，只有「已锁定树」能解锁。
// 判据用 `viewItem`（树项的 `contextValue`）—— 见上方 `wtItemIs` 的说明。

// Lock
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.Lock, title: localize2('worktreeLock', 'Lock Worktree'), icon: Codicon.lock },
	when: WT_ITEM_BRANCH,
	group: '2_worktree',
	order: 10,
});

// Unlock
MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
	command: { id: WorktreeCommands.Unlock, title: localize2('worktreeUnlock', 'Unlock Worktree'), icon: Codicon.unlock },
	when: WT_ITEM_LOCKED,
	group: '2_worktree',
	order: 10,
});

// Clean Up Stale Worktrees（视图标题栏；进的是"要删什么先列出来"的确认流程）
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: WorktreeCommands.Cleanup, title: localize2('worktreeCleanup', 'Clean Up Stale Worktrees…') },
	when: WT_WHEN,
	group: '2_worktree',
	order: 20,
});
