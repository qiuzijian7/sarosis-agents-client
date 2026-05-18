/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for a single Task's detail page.
 * Each task ID gets a unique instance (multi-instance, not singleton).
 */
export class TaskDetailEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.taskDetailInput';

	private static _instances = new Map<string, TaskDetailEditorInput>();

	static getOrCreate(taskId: string, taskTitle?: string): TaskDetailEditorInput {
		let instance = TaskDetailEditorInput._instances.get(taskId);
		if (!instance || instance.isDisposed()) {
			instance = new TaskDetailEditorInput(taskId, taskTitle || 'Task');
			TaskDetailEditorInput._instances.set(taskId, instance);
		}
		return instance;
	}

	constructor(
		private readonly _taskId: string,
		private readonly _taskTitle: string,
	) {
		super();
	}

	get taskId(): string {
		return this._taskId;
	}

	override get typeId(): string {
		return TaskDetailEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'agentStudio.taskDetail';
	}

	override get resource(): URI | undefined {
		return URI.from({ scheme: 'agent-studio-task', path: `/${this._taskId}` });
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return `📌 ${this._taskTitle}`;
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof TaskDetailEditorInput
			&& otherInput._taskId === this._taskId;
	}
}
