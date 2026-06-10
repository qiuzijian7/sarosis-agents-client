/*---------------------------------------------------------------------------------------------
 *  AgentStudio First-Run Workspace Contribution
 *
 *  Runs once on the very first launch of a fresh install (when no workspace
 *  exists yet and this contribution has never triggered before). It:
 *    1. Activates the Workspace icon in the ActivityBar (so it appears
 *       highlighted/selected.
 *    2. Pops up the "Create Workspace" dialog so the user is guided into
 *       choosing a workspace immediately.
 *    3. Persists a completion marker so the dialog never auto-pops again.
 *
 *  Uses a dedicated marker (`FIRST_RUN_WORKSPACE_DONE_KEY`) that is
 *  independent of the welcome-walkthrough completion key, so the two flows
 *  can be reset/managed separately. Returns silently if any workspace
 *  already exists (e.g. profile was restored from a backup).
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioService } from '../common/agentStudio.js';

const FIRST_RUN_WORKSPACE_DONE_KEY = 'workbench.agentsession.firstRunWorkspaceDone';
const CREATE_WORKSPACE_COMMAND_ID = 'agentStudio.workspace.createWorkspace';
const WORKSPACE_VIEW_CONTAINER_ID = 'agentStudio.workspace';

/**
 * Detects the very first launch of the application on a fresh install
 * (when no workspace exists yet and the welcome walkthrough has not been
 * completed) and guides the user into creating a workspace.
 */
export class FirstRunWorkspaceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.firstRunWorkspace';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@ICommandService private readonly commandService: ICommandService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Run async; never block workbench restoration on this.
		void this._maybeRun();
	}

	private async _maybeRun(): Promise<void> {
		try {
			// Already handled on a previous launch — skip silently.
			if (this.storageService.getBoolean(FIRST_RUN_WORKSPACE_DONE_KEY, StorageScope.APPLICATION, false)) {
				return;
			}

			// Defer one tick so that all view containers and the AgentStudio
			// service have finished their BlockStartup registration before we
			// try to open the workspace view and trigger the dialog.
			await this._yieldToEventLoop();

			const workspaces = await this.agentStudioService.getWorkspaces();
			if (workspaces.length > 0) {
				// Edge case: profile was migrated / restored from a backup that
				// already contains workspaces. No need to pop the wizard.
				this.logService.info(`[FirstRunWorkspace] Found ${workspaces.length} existing workspace(s); skipping first-run wizard.`);
				this._markDone();
				return;
			}

			this.logService.info('[FirstRunWorkspace] First launch with no workspaces — activating Workspace view and popping Create dialog.');

			// 1) Activate the Workspace icon in the ActivityBar (highlight it).
			//    `openPaneComposite` switches the visible sidebar composite and
			//    marks it active in the activitybar. This also ensures the
			//    workspace view DOM container exists before step 2 (the create
			//    dialog is appended inside `workspaceView.element`).
			await this.paneCompositePartService.openPaneComposite(
				WORKSPACE_VIEW_CONTAINER_ID,
				ViewContainerLocation.Sidebar,
				true,
			);

			// 2) Pop the "Create Workspace" dialog. The existing command opens
			//    the workspace view (if not already open) and shows the modal.
			await this.commandService.executeCommand(CREATE_WORKSPACE_COMMAND_ID);

			this._markDone();
		} catch (err) {
			this.logService.error('[FirstRunWorkspace] First-run handler failed:', err);
			// Always mark done on failure so we don't loop on every start.
			this._markDone();
		}
	}

	private _markDone(): void {
		this.storageService.store(
			FIRST_RUN_WORKSPACE_DONE_KEY,
			true,
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
	}

	private _yieldToEventLoop(): Promise<void> {
		return new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

registerWorkbenchContribution2(
	FirstRunWorkspaceContribution.ID,
	FirstRunWorkspaceContribution,
	WorkbenchPhase.AfterRestored,
);