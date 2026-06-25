/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Emitter } from '../../../../base/common/event.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

export interface ICompressionDetailData {
	originalCount: number;
	compressedCount: number;
	tokensSaved: number;
	durationMs: number;
	savePercent?: number;
	beforeText?: string;
	afterText?: string;
	summary?: string;
}

export class CompressionDetailEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.compressionDetail';

	override get typeId(): string {
		return CompressionDetailEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return CompressionDetailEditorInput.ID;
	}

	private static _instance: CompressionDetailEditorInput | null = null;

	static getOrCreate(data?: ICompressionDetailData): CompressionDetailEditorInput {
		if (!CompressionDetailEditorInput._instance || CompressionDetailEditorInput._instance.isDisposed()) {
			CompressionDetailEditorInput._instance = new CompressionDetailEditorInput();
		}
		if (data) {
			CompressionDetailEditorInput._instance._data = data;
			// 触发数据变更事件，让已打开的 editor pane 重新渲染
			// （singleton 模式下 openEditor 不会再次调用 setInput）
			CompressionDetailEditorInput._instance._onDidChangeData.fire();
		}
		return CompressionDetailEditorInput._instance;
	}

	private _data: ICompressionDetailData | null = null;

	private readonly _onDidChangeData = new Emitter<void>();
	/** 数据变更事件：点击不同压缩条目时，getOrCreate 更新 _data 后触发 */
	readonly onDidChangeData = this._onDidChangeData.event;

	constructor() {
		super();
	}

	get data(): ICompressionDetailData | null {
		return this._data;
	}

	override get resource(): URI {
		return URI.parse('agent-studio://compression-detail');
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '压缩详情';
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: CompressionDetailEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof CompressionDetailEditorInput) {
			return true;
		}
		return false;
	}

	override dispose(): void {
		CompressionDetailEditorInput._instance = null;
		super.dispose();
	}
}
