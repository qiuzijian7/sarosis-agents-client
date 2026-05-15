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
 */
export class PluginDetailEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.pluginDetailInput';

	private static _instance: PluginDetailEditorInput | undefined;
	private static _currentPlugin: IAgentPlugin | undefined;

	static getOrCreate(plugin: IAgentPlugin): PluginDetailEditorInput {
		PluginDetailEditorInput._currentPlugin = plugin;
		if (!PluginDetailEditorInput._instance || PluginDetailEditorInput._instance.isDisposed()) {
			PluginDetailEditorInput._instance = new PluginDetailEditorInput();
		}
		return PluginDetailEditorInput._instance;
	}

	static getCurrentPlugin(): IAgentPlugin | undefined {
		return PluginDetailEditorInput._currentPlugin;
	}

	constructor() {
		super();
		if (PluginDetailEditorInput._instance && !PluginDetailEditorInput._instance.isDisposed()) {
			console.warn('[PluginDetailEditorInput] Use PluginDetailEditorInput.getOrCreate() to get the singleton.');
		}
		PluginDetailEditorInput._instance = this;
	}

	override get typeId(): string {
		return PluginDetailEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.pluginDetail';
	}

	override get resource(): URI | undefined {
		const plugin = PluginDetailEditorInput._currentPlugin;
		return URI.from({
			scheme: 'agent-studio-plugin',
			path: plugin ? `/${plugin.uri.toString()}` : '/unknown',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	get plugin(): IAgentPlugin | undefined {
		return PluginDetailEditorInput._currentPlugin;
	}

	override getName(): string {
		const plugin = PluginDetailEditorInput._currentPlugin;
		return plugin ? `📦 ${plugin.label}` : 'Plugin Detail';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof PluginDetailEditorInput;
	}
}
