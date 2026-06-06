/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IWorkflow } from '../common/crewTeam.js';

/**
 * EditorInput for workflow detail editor.
 *
 * Carries an IWorkflow object so the editor pane can render
 * the workflow's details (name, description, steps, etc.).
 */
export class WorkflowEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.workflow';

	override get typeId(): string {
		return WorkflowEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return WorkflowEditorInput.ID;
	}

	private readonly _workflow: IWorkflow;

	constructor(workflow: IWorkflow) {
		super();
		this._workflow = workflow;
	}

	get workflow(): IWorkflow {
		return this._workflow;
	}

	override get resource(): URI {
		// Use a synthetic URI since workflows are not file-based.
		// The URI includes the workflow ID so different workflows
		// produce different resources (enabling side-by-side).
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
