/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { URI } from '../../../../base/common/uri.js';
import { autorun } from '../../../../base/common/observable.js';
import { IWorkspaceFolderCreationData } from '../../../../platform/workspaces/common/workspaces.js';
import { Queue } from '../../../../base/common/async.js';
import { ISession } from '../../../services/sessions/common/session.js';

export class WorkspaceFolderManagementContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.workspaceFolderManagement';
	private queue = this._register(new Queue<void>());

	constructor(
		@ISessionsManagementService private readonly sessionManagementService: ISessionsManagementService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
	) {
		super();
		this._register(autorun(reader => {
			const activeSession = this.sessionManagementService.activeSession.read(reader);
			activeSession?.workspace.read(reader);
			this.queue.queue(() => this.updateWorkspaceFoldersForSession(activeSession));
		}));
	}

	private async updateWorkspaceFoldersForSession(session: ISession | undefined): Promise<void> {
		await this.manageTrustWorkspaceForSession(session);
		const activeSessionFolderData = this.getActiveSessionFolderData(session);
		const currentFolders = this.workspaceContextService.getWorkspace().folders;
		const currentRepo = currentFolders[0]?.uri;

		// A session without a resolvable repository must NOT tear the workspace down:
		// in a multi-root `.code-workspace` the folder list is declared by the file,
		// not by the active session. Only drop a root we ourselves injected earlier
		// (i.e. one that is absent from the declared set).
		if (!activeSessionFolderData) {
			if (currentRepo && !this._isDeclaredFolder(currentRepo)) {
				await this.workspaceEditingService.removeFolders([currentRepo], true);
			}
			return;
		}

		if (!currentRepo) {
			await this.workspaceEditingService.addFolders([activeSessionFolderData], true);
			return;
		}

		if (this.uriIdentityService.extUri.isEqual(currentRepo, activeSessionFolderData.uri)) {
			return;
		}

		// The active session's repository may already be one of several declared
		// roots — in that case only the ordering changes, not the folder set.
		const existingIndex = currentFolders.findIndex(folder => this.uriIdentityService.extUri.isEqual(folder.uri, activeSessionFolderData!.uri));
		if (existingIndex >= 0) {
			return;
		}

		// Only replace the leading folder when the list is a single injected root;
		// otherwise append so declared multi-root projects survive a session switch.
		if (this._isDeclaredFolder(currentRepo)) {
			await this.workspaceEditingService.addFolders([activeSessionFolderData], true);
			return;
		}

		await this.workspaceEditingService.updateFolders(0, 1, [activeSessionFolderData], true);
	}

	/**
	 * True when the URI is part of the folder set declared by the open workspace
	 * file, i.e. it was not injected by the sessions window itself.
	 */
	private _isDeclaredFolder(uri: URI): boolean {
		try {
			return this.workspaceContextService.getWorkspace().folders
				.some(folder => this.uriIdentityService.extUri.isEqual(folder.uri, uri));
		} catch {
			return false;
		}
	}

	private getActiveSessionFolderData(session: ISession | undefined): IWorkspaceFolderCreationData | undefined {
		if (!session) {
			return undefined;
		}

		const workspace = session.workspace.get();
		const repo = workspace?.repositories[0];
		const repository = repo?.uri;
		const worktree = repo?.workingDirectory;
		const branchName = repo?.detail;

		if (worktree) {
			return {
				uri: worktree,
				name: repository ? `${this.uriIdentityService.extUri.basename(repository)} (${branchName ?? this.uriIdentityService.extUri.basename(worktree)})` : this.uriIdentityService.extUri.basename(worktree)
			};
		}

		if (repository) {
			return {
				uri: repository,
				name: workspace?.label,
			};
		}

		return undefined;
	}

	private async manageTrustWorkspaceForSession(session: ISession | undefined): Promise<void> {
		const workspace = session?.workspace.get();
		if (!workspace?.requiresWorkspaceTrust) {
			return;
		}

		const repo = workspace?.repositories[0];
		const repository = repo?.uri;
		const worktree = repo?.workingDirectory;

		if (!repository || !worktree) {
			return;
		}

		if (!this.isUriTrusted(worktree)) {
			await this.workspaceTrustManagementService.setUrisTrust([worktree], true);
		}
	}

	private isUriTrusted(uri: URI): boolean {
		return this.workspaceTrustManagementService.getTrustedUris().some(trustedUri => this.uriIdentityService.extUri.isEqual(trustedUri, uri));
	}
}
