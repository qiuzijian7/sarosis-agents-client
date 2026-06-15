/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, GroupIdentifier } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for the native (DOM-based) Agent Chat pane.
 *
 * Unlike `AgentStudioEditorInput` (which renders a WebView/iframe chat),
 * this input drives `NativeChatEditorPane` which mounts `AgentChatPanel`
 * directly into the DOM — eliminating the overlay iframe, fixing resize
 * synchronisation issues, and providing native-level performance.
 *
 * This is a singleton: only one Agent Chat tab exists at a time.
 */
export class NativeChatEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.nativeChatInput';
	static readonly EditorID = 'workbench.editor.nativeChat';

	private static _instance: NativeChatEditorInput | undefined;

	static getInstance(): NativeChatEditorInput {
		if (!NativeChatEditorInput._instance || NativeChatEditorInput._instance.isDisposed()) {
			NativeChatEditorInput._instance = new NativeChatEditorInput();
		}
		return NativeChatEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return NativeChatEditorInput.TypeID;
	}

	override get editorId(): string {
		return NativeChatEditorInput.EditorID;
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'native-chat',
			path: '/chat',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return 'Agent Chat';
	}

	override canMove(_sourceGroup: GroupIdentifier, _targetGroup: GroupIdentifier): true | string {
		return true;
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof NativeChatEditorInput;
	}
}
