/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/path.js';
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

	/** 无参：展示「当前工作区」的代码图谱（单例缓存）。 */
	static getOrCreate(): CodebaseGraphViewerEditorInput {
		if (!CodebaseGraphViewerEditorInput._instance || CodebaseGraphViewerEditorInput._instance.isDisposed()) {
			CodebaseGraphViewerEditorInput._instance = new CodebaseGraphViewerEditorInput();
		}
		return CodebaseGraphViewerEditorInput._instance;
	}

	/**
	 * @param folderPath 可选。指定后打开该文件夹自身的代码图谱（按路径区分 Tab）；
	 *                  留空则展示当前 VS Code 工作区的代码图谱。
	 */
	constructor(folderPath?: string) {
		super();
		this._folderPath = folderPath;
	}

	private readonly _folderPath?: string;

	/** 关联的代码库根目录（可选）。为空表示使用当前 VS Code 工作区。 */
	get folderPath(): string | undefined {
		return this._folderPath;
	}

	override get resource(): URI {
		// 按 folderPath 区分，确保不同文件夹打开各自独立的 Tab。
		const suffix = this._folderPath ? '/' + encodeURIComponent(this._folderPath) : '';
		return URI.parse('agent-studio://codebase-graph-viewer' + suffix);
	}

	override get capabilities(): EditorInputCapabilities {
		// 不再使用 Singleton：不同 folderPath 应各自独立成 Tab。
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		if (this._folderPath) {
			return `代码图谱：${basename(this._folderPath)}`;
		}
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
		if (!(other instanceof CodebaseGraphViewerEditorInput)) { return false; }
		// 同一文件夹视为同一 Tab；不同文件夹（或无 vs 有）视为不同。
		return (this._folderPath ?? '') === (other._folderPath ?? '');
	}

	override dispose(): void {
		if (CodebaseGraphViewerEditorInput._instance === this) {
			CodebaseGraphViewerEditorInput._instance = null;
		}
		super.dispose();
	}
}
