/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IStoredWorkflow } from '../common/workflowStorage.js';

/**
 * EditorInput for workflow detail editor.
 *
 * Carries an IStoredWorkflow object so the editor pane can pass
 * the workflow data to the webview-based ReactFlow editor.
 */
export class WorkflowEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.workflow';

	override get typeId(): string {
		return WorkflowEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return 'workbench.editor.agentStudio.workflowPane';
	}

	override get capabilities(): EditorInputCapabilities {
		return 0; // Non-singleton, mutable — each workflow gets its own tab
	}

	private _workflow: IStoredWorkflow;

	constructor(workflow: IStoredWorkflow) {
		super();
		this._workflow = workflow;
	}

	get workflow(): IStoredWorkflow {
		return this._workflow;
	}

	/** Update the internal workflow snapshot after a save, so the editor opens fresh data next time. */
	updateWorkflowData(patch: Partial<IStoredWorkflow>): void {
		Object.assign(this._workflow, patch);
	}

	override get resource(): URI {
		return URI.from({ scheme: 'sarosis-workflow', path: `/${this._workflow.id}` });
	}

	override getName(): string {
		return `Workflow: ${this._workflow.name}`;
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof WorkflowEditorInput) {
			return this._workflow.id === other._workflow.id;
		}
		return false;
	}
}
