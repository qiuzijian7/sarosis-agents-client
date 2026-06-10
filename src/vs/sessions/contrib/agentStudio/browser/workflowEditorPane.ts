/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { AgentStudioWebviewController } from './agentStudioWebviewController.js';
import { IWorkflowStorageService } from '../common/workflowStorage.js';

/**
 * WorkflowEditorPane — WebView-based workflow editor using ReactFlow.
 *
 * Replaces the old DOM-based renderer. Uses AgentStudioWebviewController
 * with panelType 'workflow-editor' to reuse the existing webview infrastructure.
 * Workflow data is passed via `initialData` and injected as
 * `window.__AGENT_STUDIO_INITIAL_DATA__` into the webview.
 */
export class WorkflowEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.workflowPane';

	private _container: HTMLElement | undefined;
	private _webviewController: AgentStudioWebviewController | undefined;
	private _currentWorkflowId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
	) {
		super(WorkflowEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.workflow-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, _options, _context, token);

		if (!(input instanceof WorkflowEditorInput) || !this._container) {
			return;
		}

		if (token.isCancellationRequested) {
			return;
		}

		const workflowId = input.workflow.id;

		// If the same workflow tab is being reactivated, keep the webview alive.
		// Otherwise (first open or different workflow), recreate the webview.
		if (this._webviewController && this._currentWorkflowId === workflowId) {
			// Same tab reactivation — the webview already has the latest state
			return;
		}

		// Different workflow or first open — dispose old and create new
		this._disposeWebview();

		this._currentWorkflowId = workflowId;

		// Read the latest workflow data from disk (may have been saved since the
		// WorkflowEditorInput was created)
		let workflowData = input.workflow;
		try {
			const fresh = await this.workflowStorageService.getWorkflow(workflowId);
			if (fresh) {
				workflowData = fresh;
				// Keep the EditorInput in sync
				input.updateWorkflowData(fresh);
			}
		} catch {
			// Fall back to the input's snapshot
		}

		this._webviewController = this.instantiationService.createInstance(
			AgentStudioWebviewController,
			this._container,
			'workflow-editor' as const,
			// Pass the workflow data as initialData — injected as __AGENT_STUDIO_INITIAL_DATA__
			{ type: 'workflow', workflow: workflowData },
		);
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		this._webviewController?.layout(dimension.width, dimension.height);
	}

	private _disposeWebview(): void {
		if (this._webviewController) {
			this._webviewController.dispose();
			this._webviewController = undefined;
		}
		if (this._container) {
			DOM.clearNode(this._container);
		}
	}

	override dispose(): void {
		this._disposeWebview();
		super.dispose();
	}
}
