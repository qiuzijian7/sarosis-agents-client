/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

/**
 * EditorInput for rendering a self-contained HTML file (e.g. ConfigMD's
 * `.preview.html`) inside the workbench editor area.
 *
 * Why a custom input?
 *   The standard `WebviewInput` route (used by simple-browser, markdown
 *   preview, etc.) relies on `IOverlayWebview`, which positions the
 *   webview iframe via CSS anchor-positioning. On this fork's Chromium
 *   build that path renders an empty pane. Our own input + pane uses the
 *   same `createWebviewElement` + `mountTo(container)` model that the
 *   chat panel already uses successfully — i.e. a regular DOM-mounted
 *   iframe with no anchor-positioning involvement.
 */
export class HtmlPreviewEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.htmlPreview';

	override get typeId(): string {
		return HtmlPreviewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return HtmlPreviewEditorInput.ID;
	}

	private readonly _resource: URI;
	private readonly _title: string;

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

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this._resource,
			options: { override: HtmlPreviewEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof HtmlPreviewEditorInput) {
			return this._resource.toString() === other._resource.toString();
		}
		return false;
	}
}
