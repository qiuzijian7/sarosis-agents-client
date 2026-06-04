/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, GroupIdentifier } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export class TerminalPanelEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.terminalPanelEditorInput';
	private static _instance: TerminalPanelEditorInput | undefined;

	static getInstance(): TerminalPanelEditorInput {
		if (!TerminalPanelEditorInput._instance || TerminalPanelEditorInput._instance.isDisposed()) {
			TerminalPanelEditorInput._instance = new TerminalPanelEditorInput();
		}
		return TerminalPanelEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return TerminalPanelEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.terminal.panel.editor';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'terminal-panel-editor',
			path: '/terminal'
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return 'Terminal';
	}

	override canMove(_sourceGroup: GroupIdentifier, _targetGroup: GroupIdentifier): true | string {
		return true;
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof TerminalPanelEditorInput;
	}
}
