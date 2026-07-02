/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for the Workflow Marketplace panel.
 *
 * Opens in the editor area as a marketplace page for browsing and installing
 * workflows from the marketplace server.
 * Singleton pattern: only one instance, reopening reuses it.
 *
 * Triggered by clicking the "Install" button in the Workflow sidebar.
 */
export class WorkflowMarketEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.workflowMarketInput';

	private static _instance: WorkflowMarketEditorInput | undefined;

	static getInstance(): WorkflowMarketEditorInput {
		if (!WorkflowMarketEditorInput._instance || WorkflowMarketEditorInput._instance.isDisposed()) {
			WorkflowMarketEditorInput._instance = new WorkflowMarketEditorInput();
		}
		return WorkflowMarketEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return WorkflowMarketEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.workflowMarket';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio-workflow-market',
			path: '/marketplace',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '🔀 Workflow Marketplace';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof WorkflowMarketEditorInput;
	}
}
