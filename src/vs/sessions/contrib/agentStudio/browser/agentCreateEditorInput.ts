/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for the "Create Agent" editor pane.
 *
 * Opens in the editor area as a form-based page for creating a new custom agent.
 * Uses a singleton instance so the same tab is reused.
 */
export class AgentCreateEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.agentCreateInput';

	private static _instance: AgentCreateEditorInput | undefined;

	static getInstance(): AgentCreateEditorInput {
		if (!AgentCreateEditorInput._instance || AgentCreateEditorInput._instance.isDisposed()) {
			AgentCreateEditorInput._instance = new AgentCreateEditorInput();
		}
		return AgentCreateEditorInput._instance;
	}

	override get typeId(): string {
		return AgentCreateEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.agentCreate';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-create',
			path: '/create',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '✏️ 创建 Agent';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof AgentCreateEditorInput;
	}
}
