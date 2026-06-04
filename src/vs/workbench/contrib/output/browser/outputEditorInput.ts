/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, GroupIdentifier } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export class OutputEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.outputEditorInput';
	private static _instance: OutputEditorInput | undefined;

	static getInstance(): OutputEditorInput {
		if (!OutputEditorInput._instance || OutputEditorInput._instance.isDisposed()) {
			OutputEditorInput._instance = new OutputEditorInput();
		}
		return OutputEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return OutputEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.output.editor';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'output-editor',
			path: '/output'
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return 'Output';
	}

	override canMove(_sourceGroup: GroupIdentifier, _targetGroup: GroupIdentifier): true | string {
		return true;
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof OutputEditorInput;
	}
}
