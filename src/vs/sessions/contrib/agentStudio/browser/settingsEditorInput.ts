/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * Singleton EditorInput for the Agent Studio Settings panel.
 * Separate from AgentStudioEditorInput because Settings uses a native-DOM
 * EditorPane (SettingsEditorPane) instead of the WebView-based AgentStudioEditorPane.
 */
export class SettingsEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.agentStudioSettingsInput';

	private static _instance: SettingsEditorInput | undefined;

	static getInstance(): SettingsEditorInput {
		if (!SettingsEditorInput._instance || SettingsEditorInput._instance.isDisposed()) {
			SettingsEditorInput._instance = new SettingsEditorInput();
		}
		return SettingsEditorInput._instance;
	}

	// 构造函数设为 public，供 SyncDescriptor 使用；单例逻辑由 getInstance() 保证
	constructor() {
		super();
		if (SettingsEditorInput._instance && !SettingsEditorInput._instance.isDisposed()) {
			console.warn('[SettingsEditorInput] Use SettingsEditorInput.getInstance() to get the singleton.');
		}
		SettingsEditorInput._instance = this;
	}

	override get typeId(): string {
		return SettingsEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'agentStudio.settings';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio',
			path: '/settings',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '⚙️ Settings';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof SettingsEditorInput;
	}
}
