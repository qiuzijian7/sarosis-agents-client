/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  媒体库画廊的编辑器输入（单例）。对齐 CodebaseMemoryDetailEditorInput 的范式：
 *  Singleton + Readonly ⇒ 同一窗口只会有一个媒体库标签页，重复打开只是聚焦。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

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

	constructor() {
		super();
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
		super.dispose();
	}
}
