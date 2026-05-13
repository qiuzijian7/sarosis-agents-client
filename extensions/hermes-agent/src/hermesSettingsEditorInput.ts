/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../src/vs/workbench/common/editor/editorInput.js';
import { URI } from '../../../src/vs/base/common/uri.js';

/**
 * Hermes Settings Editor Input — singleton pattern (same as KnotSettingsEditorInput)
 */
export class HermesSettingsEditorInput extends EditorInput {

	static readonly ID = 'hermes.settings.editor.input';
	private static _instance: HermesSettingsEditorInput | undefined;

	static getInstance(): HermesSettingsEditorInput {
		if (!HermesSettingsEditorInput._instance) {
			HermesSettingsEditorInput._instance = new HermesSettingsEditorInput();
		}
		return HermesSettingsEditorInput._instance;
	}

	override get typeId(): string {
		return HermesSettingsEditorInput.ID;
	}

	override get resource(): URI | undefined {
		return URI.from({ scheme: 'hermes-settings', path: '/settings' });
	}

	override getName(): string {
		return 'Hermes Agent Settings';
	}

	override matches(other: EditorInput): boolean {
		return other instanceof HermesSettingsEditorInput;
	}
}
