/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for the Task Overview (Kanban board) page.
 * Singleton — only one overview can be open at a time.
 */
export class TaskOverviewEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.taskOverviewInput';

	private static _instance: TaskOverviewEditorInput | undefined;

	static getOrCreate(): TaskOverviewEditorInput {
		if (!TaskOverviewEditorInput._instance || TaskOverviewEditorInput._instance.isDisposed()) {
			TaskOverviewEditorInput._instance = new TaskOverviewEditorInput();
		}
		return TaskOverviewEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return TaskOverviewEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'agentStudio.taskOverview';
	}

	override get resource(): URI | undefined {
		return URI.from({ scheme: 'agent-studio-task', path: '/overview' });
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '📋 Task Overview';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof TaskOverviewEditorInput;
	}
}
