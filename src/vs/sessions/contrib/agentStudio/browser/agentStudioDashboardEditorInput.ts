/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

export class AgentStudioDashboardEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.dashboard';

	override get typeId(): string {
		return AgentStudioDashboardEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return AgentStudioDashboardEditorInput.ID;
	}

	private static _instance: AgentStudioDashboardEditorInput | null = null;

	static getOrCreate(): AgentStudioDashboardEditorInput {
		if (!AgentStudioDashboardEditorInput._instance || AgentStudioDashboardEditorInput._instance.isDisposed()) {
			AgentStudioDashboardEditorInput._instance = new AgentStudioDashboardEditorInput();
		}
		return AgentStudioDashboardEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get resource(): URI {
		return URI.parse('agent-studio://dashboard');
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return 'AgentStudio Dashboard';
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: AgentStudioDashboardEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) { return true; }
		return other instanceof AgentStudioDashboardEditorInput;
	}

	override dispose(): void {
		AgentStudioDashboardEditorInput._instance = null;
		super.dispose();
	}
}
