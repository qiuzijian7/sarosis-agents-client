/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IAgentPlugin } from '../../../../workbench/contrib/chat/common/plugins/agentPluginService.js';

/**
 * EditorInput for the Plugin Detail panel.
 * Opens in the editor area (like VS Code native Extensions detail view).
 *
 * Each plugin gets its own EditorInput instance so that the editor framework
 * can correctly detect input changes (via `matches()`) and call `setInput()`
 * to refresh the detail pane when the user switches between plugins.
 */
export class PluginDetailEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.pluginDetailInput';

	constructor(
		private readonly _plugin: IAgentPlugin,
	) {
		super();
	}

	override get typeId(): string {
		return PluginDetailEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.pluginDetail';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio-plugin',
			path: `/${this._plugin.uri.toString()}`,
		});
	}

	override get capabilities(): EditorInputCapabilities {
		// Use Singleton so the editor reuses the same pane, but NOT
		// SingleResource which would cause resource-based matching.
		// Our custom matches() ensures different plugins are treated as
		// different inputs, triggering setInput() on the existing pane.
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	get plugin(): IAgentPlugin {
		return this._plugin;
	}

	override getName(): string {
		return `📦 ${this._plugin.label}`;
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		if (!(otherInput instanceof PluginDetailEditorInput)) {
			return false;
		}
		// Two inputs match only when they refer to the same plugin (by URI).
		// When the user clicks a different plugin, matches() returns false,
		// so the editor framework calls setInput() on the existing pane.
		return this._plugin.uri.toString() === otherInput._plugin.uri.toString();
	}
}
