/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for the Agent Market (Agent 商城) page.
 *
 * Opens in the editor area (like VS Code's native Extensions Marketplace).
 * Uses a singleton instance so the same tab is reused when the user clicks
 * the "Agent 商城" entry multiple times from the Preset Agent sidebar view.
 *
 * The market lets the user browse all built-in agent presets in a rich
 * card-grid layout and one-click deploy them into the active workspace.
 */
export class AgentMarketEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.agentMarketInput';

	private static _instance: AgentMarketEditorInput | undefined;

	static getInstance(): AgentMarketEditorInput {
		if (!AgentMarketEditorInput._instance || AgentMarketEditorInput._instance.isDisposed()) {
			AgentMarketEditorInput._instance = new AgentMarketEditorInput();
		}
		return AgentMarketEditorInput._instance;
	}

	override get typeId(): string {
		return AgentMarketEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.agentMarket';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-market',
			path: '/market',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '🛒 Agent 商城';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof AgentMarketEditorInput;
	}
}
