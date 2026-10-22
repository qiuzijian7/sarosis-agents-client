/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  媒体库画廊的编辑器输入（单例）。对齐 CodebaseMemoryDetailEditorInput 的范式：
 *  Singleton + Readonly ⇒ 同一窗口只会有一个媒体库标签页，重复打开只是聚焦。
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

/**
 * 打开媒体库时带的**上下文**（2026-10-19）。
 *
 * 为什么要有它：本输入是 **Singleton**（同一窗口只有一个标签页），而"从工作流打开"需要
 * 默认只看**当前工作流**的资产。若上下文只存在 pane 的私有字段里，那个标签页已经开着时
 * 再点另一个工作流的「媒体库」就**不会换范围**（`openEditor` 只会聚焦，不会再 `setInput`）✗。
 * ⇒ 上下文放在输入上，`applyContext()` 变更时发事件，pane 订阅后重载 ✓。
 *
 * ⚠ **不改 resource / typeId**：一旦按上下文区分 resource，单例就变成"每种上下文一个 tab"，
 *   与"一个窗口只有一个媒体库"的口径相反 ✗（取舍见本期 README）。
 */
export interface IMediaGalleryContext {
	/** 只列这个工作流产出的资产（缺省 = 全库）。 */
	readonly workflowId?: string;
	/** 仅用于状态行展示。 */
	readonly workflowName?: string;
}

export class MediaGalleryEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.mediaGallery';

	override get typeId(): string {
		return MediaGalleryEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return MediaGalleryEditorInput.ID;
	}

	private static _instance: MediaGalleryEditorInput | null = null;

	static getOrCreate(): MediaGalleryEditorInput {
		if (!MediaGalleryEditorInput._instance || MediaGalleryEditorInput._instance.isDisposed()) {
			MediaGalleryEditorInput._instance = new MediaGalleryEditorInput();
		}
		return MediaGalleryEditorInput._instance;
	}

	private _context: IMediaGalleryContext = {};
	private readonly _onDidChangeContext = new Emitter<IMediaGalleryContext>();
	/** 上下文变化（pane 订阅它来换范围并重载）。 */
	readonly onDidChangeContext = this._onDidChangeContext.event;

	constructor() {
		super();
	}

	/** 当前上下文（pane 在 `setInput` 里读它）。 */
	get context(): IMediaGalleryContext {
		return this._context;
	}

	/** 设置上下文；**只在真的变了**时才发事件（避免每次点「媒体库」都重载一次）。 */
	applyContext(next: IMediaGalleryContext): void {
		const prev = this._context;
		if (prev.workflowId === next.workflowId && prev.workflowName === next.workflowName) {
			return;
		}
		this._context = { ...next };
		this._onDidChangeContext.fire(this._context);
	}

	override get resource(): URI {
		return URI.parse('agent-studio://media-gallery');
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '媒体库';
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: MediaGalleryEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) { return true; }
		return other instanceof MediaGalleryEditorInput;
	}

	override dispose(): void {
		MediaGalleryEditorInput._instance = null;
		this._onDidChangeContext.dispose();
		super.dispose();
	}
}
