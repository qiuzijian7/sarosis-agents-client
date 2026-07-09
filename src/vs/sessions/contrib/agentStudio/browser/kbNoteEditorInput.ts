/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';

/**
 * EditorInput 用于在中栏文件编辑器打开知识库笔记的 WYSIWYG 编辑器。
 *
 * 承载被点击文件的 URI 与标题；编辑器面板（KnowledgeBaseNoteEditorPane）
 * 会在 setInput 时读取该文件内容并用 KbNoteEditorPane（Protyle/Lute）渲染。
 *
 * 注意：本类为非单例、可编辑——同一文件每次点击都会复用同一 Tab
 * （matches 按 URI 判定），便于在中间栏直接编辑知识库笔记。
 */
export class KbNoteEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.kbNote';

	override get typeId(): string {
		return KbNoteEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return 'workbench.editor.agentStudio.kbNotePane';
	}

	override get capabilities(): EditorInputCapabilities {
		// 非单例、可编辑（保存通过 KbNativeKernel/fileService 直接落盘）
		return EditorInputCapabilities.None;
	}

	private readonly _resource: URI;
	private _title: string;

	constructor(resource: URI, title: string) {
		super();
		this._resource = resource;
		this._title = title;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._title;
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof KbNoteEditorInput) {
			return this._resource.toString() === other._resource.toString();
		}
		return false;
	}
}
