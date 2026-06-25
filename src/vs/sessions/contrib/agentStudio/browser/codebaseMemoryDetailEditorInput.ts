/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

export class CodebaseMemoryDetailEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.codebaseMemoryDetail';

	override get typeId(): string {
		return CodebaseMemoryDetailEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return CodebaseMemoryDetailEditorInput.ID;
	}

	private static _instance: CodebaseMemoryDetailEditorInput | null = null;

	static getOrCreate(): CodebaseMemoryDetailEditorInput {
		if (!CodebaseMemoryDetailEditorInput._instance || CodebaseMemoryDetailEditorInput._instance.isDisposed()) {
			CodebaseMemoryDetailEditorInput._instance = new CodebaseMemoryDetailEditorInput();
		}
		return CodebaseMemoryDetailEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get resource(): URI {
		return URI.parse('agent-studio://codebase-memory-detail');
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '代码库记忆';
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: CodebaseMemoryDetailEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) { return true; }
		return other instanceof CodebaseMemoryDetailEditorInput;
	}

	override dispose(): void {
		CodebaseMemoryDetailEditorInput._instance = null;
		super.dispose();
	}
}
