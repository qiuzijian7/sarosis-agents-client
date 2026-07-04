/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Synchronizes native VS Code workspace folders (driving the built-in Explorer
 * view) whenever the Agent Studio active workspace changes.
 *
 * This is the central bridge between the Agent Studio workspace concept and the
 * VS Code native file explorer. When the user switches workspaces via the
 * sidebar selector or programmatic {@link IAgentStudioService.setActiveWorkspace},
 * this contribution resolves the workspace's filesystem roots (home directory,
 * related folders, worktree path) and updates {@link IWorkspaceContextService}
 * folders via {@link IWorkspaceEditingService}. The native Explorer view
 * auto-refreshes in response.
 *
 * This is independent of the Source Control workspace sync — it runs regardless
 * of whether SCM is enabled or initialized.
 */
export class WorkspaceFolderSyncContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.agentStudio.workspaceFolderSync';

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const initialCtxFolders = this.workspaceContextService.getWorkspace().folders;
		this.logService.info(
			`[WorkspaceFolderSync] contribution constructed | ` +
			`inMemoryActiveId=${this.agentStudioService.getActiveWorkspaceId() ?? 'undefined'} | ` +
			`initialContextFolderCount=${initialCtxFolders.length}`,
		);
		for (let i = 0; i < initialCtxFolders.length; i++) {
			this.logService.info(`[WorkspaceFolderSync]   initialCtxFolder[${i}] = ${initialCtxFolders[i].uri.fsPath}`);
		}

		// Trace raw workspace context changes so we can see exactly when
		// the native folders mutate.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(e => {
			this.logService.info(
				`[WorkspaceFolderSync] onDidChangeWorkspaceFolders | ` +
				`added=${e.added.length} removed=${e.removed.length}`,
			);
		}));

		// Sync on every active workspace switch
		this._register(this.agentStudioService.onDidChangeActiveWorkspace((workspaceId: string | undefined) => {
			this.logService.info(`[WorkspaceFolderSync] onDidChangeActiveWorkspace fired | workspaceId=${workspaceId}`);
			void this._syncWorkspaceFolder(workspaceId);
		}));

		// Startup restore: the active workspace is normally set lazily by the
		// webview on first load, but if the user opens the workspace tab
		// BEFORE the webview loads (e.g. directly via the activity bar) the
		// native Explorer has no folders to show. Trigger resolution eagerly
		// here so the Explorer can pick up the last-active workspace as
		// soon as the contribution starts.
		this._restoreActiveWorkspaceOnStartup();
	}

	/**
	 * Resolve and activate the default workspace at startup if no workspace
	 * is currently active. This ensures the native Explorer has workspace
	 * folders to display as soon as the user opens the workspace tab,
	 * independent of webview load timing.
	 */
	private _restoreActiveWorkspaceOnStartup(): void {
		// If an active workspace is already in memory, just sync it.
		const currentId = this.agentStudioService.getActiveWorkspaceId();
		if (currentId) {
			this.logService.info(`[WorkspaceFolderSync] startup: in-memory active workspace → direct sync: ${currentId}`);
			void this._syncWorkspaceFolder(currentId);
			return;
		}

		// No active workspace yet — resolve the default and activate it.
		// setActiveWorkspace() will fire onDidChangeActiveWorkspace, which is
		// caught by our listener above and triggers _syncWorkspaceFolder.
		this.logService.info('[WorkspaceFolderSync] startup: no active workspace in memory, calling resolveDefaultActiveWorkspaceId()');
		this.agentStudioService.resolveDefaultActiveWorkspaceId()
			.then(defaultId => {
				this.logService.info(`[WorkspaceFolderSync] startup: resolveDefaultActiveWorkspaceId() returned: ${defaultId ?? 'null'}`);
				if (defaultId) {
					this.logService.info(`[WorkspaceFolderSync] startup: calling setActiveWorkspace(${defaultId})`);
					return this.agentStudioService.setActiveWorkspace(defaultId).then(() => {
						this.logService.info(`[WorkspaceFolderSync] startup: setActiveWorkspace(${defaultId}) resolved`);
					});
				}
				this.logService.info('[WorkspaceFolderSync] startup: no default workspace to restore');
				return undefined;
			})
			.catch(err => {
				this.logService.error('[WorkspaceFolderSync] startup: failed to restore default workspace:', err);
			});
	}

	/**
	 * Resolve the active workspace's filesystem roots and update the VS Code
	 * native workspace folders. The native Explorer picks up the change
	 * automatically via {@link IWorkspaceContextService.onDidChangeWorkspaceFolders}.
	 */
	private async _syncWorkspaceFolder(workspaceId: string | undefined): Promise<void> {
		this.logService.info(`[WorkspaceFolderSync] _syncWorkspaceFolder START | workspaceId=${workspaceId ?? 'undefined'}`);

		if (!workspaceId) {
			// No active workspace — clear all folders so the Explorer shows empty state
			const currentFolders = this.workspaceContextService.getWorkspace().folders;
			this.logService.info(`[WorkspaceFolderSync] no active workspace, currentFolderCount=${currentFolders.length}`);
			if (currentFolders.length > 0) {
				const uris = currentFolders.map(f => f.uri);
				try {
					await this.workspaceEditingService.removeFolders(uris, true);
					this.logService.info(`[WorkspaceFolderSync] removed ${uris.length} folders`);
				} catch (err) {
					this.logService.error('[WorkspaceFolderSync] Failed to clear folders:', err);
				}
			}
			return;
		}

		let workspace;
		try {
			workspace = await this.agentStudioService.getWorkspace(workspaceId);
		} catch (err) {
			this.logService.error(`[WorkspaceFolderSync] getWorkspace(${workspaceId}) threw:`, err);
			return;
		}
		if (!workspace) {
			this.logService.warn(`[WorkspaceFolderSync] Workspace not found: ${workspaceId}`);
			return;
		}
		this.logService.info(
			`[WorkspaceFolderSync] loaded workspace "${workspace.name}" | ` +
			`path=${workspace.path ?? '<none>'} | ` +
			`relatedFolders=${(workspace.relatedFolders ?? []).length} | ` +
			`worktreePath=${workspace.worktreePath ?? '<none>'}`,
		);

		// Build the target root set: home dir + related folders + worktree path
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

		// Home directory (workspace.path)
		if (workspace.path) {
			pushTarget(workspace.path, workspace.name || this.uriIdentityService.extUri.basenameOrAuthority(URI.file(workspace.path)));
		}

		// Related code repositories
		for (const rf of workspace.relatedFolders ?? []) {
			if (rf?.path) {
				pushTarget(rf.path, rf.name || this.uriIdentityService.extUri.basenameOrAuthority(URI.file(rf.path)));
			}
		}

		// Worktree path (if assigned)
		if (workspace.worktreePath) {
			pushTarget(workspace.worktreePath, workspace.worktreeBranch || 'worktree');
		}

		this.logService.info(`[WorkspaceFolderSync] built ${targets.length} target roots:`);
		for (let i = 0; i < targets.length; i++) {
			this.logService.info(`[WorkspaceFolderSync]   target[${i}] = ${targets[i].uri.fsPath} (name="${targets[i].name}")`);
		}

		if (targets.length === 0) {
			this.logService.info(`[WorkspaceFolderSync] No filesystem roots for workspace: ${workspaceId}`);
			return;
		}

		// Trust all workspace roots before injecting them as folders.
		// This ensures file operations (git, explorer context menus, etc.) work
		// without triggering trust dialogs.
		try {
			const urisToTrust = targets
				.map(t => t.uri)
				.filter(uri => !this._isUriTrusted(uri));
			this.logService.info(`[WorkspaceFolderSync] ${urisToTrust.length}/${targets.length} URIs need trust`);
			if (urisToTrust.length > 0) {
				await this.workspaceTrustManagementService.setUrisTrust(urisToTrust, true);
				this.logService.info(`[WorkspaceFolderSync] setUrisTrust OK for ${urisToTrust.length} URIs`);
			}
		} catch (err) {
			this.logService.warn('[WorkspaceFolderSync] Failed to mark workspace roots as trusted:', err);
		}

		const currentFolders = this.workspaceContextService.getWorkspace().folders;
		this.logService.info(`[WorkspaceFolderSync] currentContextFolderCount=${currentFolders.length} before apply`);

		// Skip if already matching (same URIs in same order)
		const sameAsCurrent = currentFolders.length === targets.length &&
			currentFolders.every((cf, i) => this.uriIdentityService.extUri.isEqual(cf.uri, targets[i].uri));
		if (sameAsCurrent) {
			this.logService.info('[WorkspaceFolderSync] folders already match targets, skipping apply');
			return;
		}

		const targetFolderData = targets.map(t => ({ uri: t.uri, name: t.name }));

		try {
			if (currentFolders.length === 0) {
				this.logService.info(`[WorkspaceFolderSync] addFolders(${targetFolderData.length})`);
				await this.workspaceEditingService.addFolders(targetFolderData, true);
			} else {
				this.logService.info(
					`[WorkspaceFolderSync] updateFolders(idx=0, deleteCount=${currentFolders.length}, addCount=${targetFolderData.length})`,
				);
				await this.workspaceEditingService.updateFolders(0, currentFolders.length, targetFolderData, true);
			}
			const after = this.workspaceContextService.getWorkspace().folders;
			this.logService.info(
				`[WorkspaceFolderSync] sync SUCCEEDED for workspace "${workspace.name}" | ` +
				`folderCountBefore=${currentFolders.length} → after=${after.length}`,
			);
		} catch (err) {
			this.logService.error('[WorkspaceFolderSync] Failed to sync workspace folders:', err);
		}
	}

	private _isUriTrusted(uri: URI): boolean {
		return this.workspaceTrustManagementService.getTrustedUris().some(
			trustedUri => this.uriIdentityService.extUri.isEqual(trustedUri, uri)
		);
	}
}
