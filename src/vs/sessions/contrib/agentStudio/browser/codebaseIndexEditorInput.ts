/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/path.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

/**
 * EditorInput for the standalone "Codebase Index" pane.
 * Carries an optional folderPath so different linked folders open independent tabs.
 */
export class CodebaseIndexEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.codebaseIndex';

	override get typeId(): string {
		return CodebaseIndexEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return CodebaseIndexEditorInput.ID;
	}

	constructor(folderPath?: string) {
		super();
		this._folderPath = folderPath;
	}

	private readonly _folderPath?: string;

	get folderPath(): string | undefined {
		return this._folderPath;
	}

	override get resource(): URI {
		const suffix = this._folderPath ? '/' + encodeURIComponent(this._folderPath) : '';
		return URI.parse('agent-studio://codebase-index' + suffix);
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		if (this._folderPath) {
			return `索引库: ${basename(this._folderPath)}`;
		}
		return '代码库索引';
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: CodebaseIndexEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) { return true; }
		if (!(other instanceof CodebaseIndexEditorInput)) { return false; }
		return (this._folderPath ?? '') === (other._folderPath ?? '');
	}

	override dispose(): void {
		super.dispose();
	}
}
