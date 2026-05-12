/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../src/vs/base/common/uri.js';
import { EditorInputCapabilities } from '../../../src/vs/workbench/common/editor.js';
import { EditorInput } from '../../../src/vs/workbench/common/editor/editorInput.js';

/**
 * EditorInput for the Knot AG-UI Settings panel.
 *
 * Opens as an independent editor pane in the left editor area when the user
 * clicks the Knot plugin. This is NOT embedded in the main Settings page —
 * each plugin that needs its own settings UI registers its own EditorInput
 * + EditorPane pair.
 */
export class KnotSettingsEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.knotSettingsInput';

	private static _instance: KnotSettingsEditorInput | undefined;

	static getInstance(): KnotSettingsEditorInput {
		if (!KnotSettingsEditorInput._instance || KnotSettingsEditorInput._instance.isDisposed()) {
			KnotSettingsEditorInput._instance = new KnotSettingsEditorInput();
		}
		return KnotSettingsEditorInput._instance;
	}

	constructor() {
		super();
		if (KnotSettingsEditorInput._instance && !KnotSettingsEditorInput._instance.isDisposed()) {
			console.warn('[KnotSettingsEditorInput] Use KnotSettingsEditorInput.getInstance() to get the singleton.');
		}
		KnotSettingsEditorInput._instance = this;
	}

	override get typeId(): string {
		return KnotSettingsEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'knot.settings';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'knot',
			path: '/settings',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '🔗 Knot Settings';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof KnotSettingsEditorInput;
	}
}
