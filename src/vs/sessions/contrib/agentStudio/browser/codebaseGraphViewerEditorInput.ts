/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

export class CodebaseGraphViewerEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.codebaseGraphViewer';

	override get typeId(): string {
		return CodebaseGraphViewerEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return CodebaseGraphViewerEditorInput.ID;
	}

	private static _instance: CodebaseGraphViewerEditorInput | null = null;

	static getOrCreate(): CodebaseGraphViewerEditorInput {
		if (!CodebaseGraphViewerEditorInput._instance || CodebaseGraphViewerEditorInput._instance.isDisposed()) {
			CodebaseGraphViewerEditorInput._instance = new CodebaseGraphViewerEditorInput();
		}
		return CodebaseGraphViewerEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get resource(): URI {
		return URI.parse('agent-studio://codebase-graph-viewer');
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '代码库 Graph 可视化';
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: CodebaseGraphViewerEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) { return true; }
		return other instanceof CodebaseGraphViewerEditorInput;
	}

	override dispose(): void {
		CodebaseGraphViewerEditorInput._instance = null;
		super.dispose();
	}
}
