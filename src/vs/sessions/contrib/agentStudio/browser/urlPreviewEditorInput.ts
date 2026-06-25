/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

/**
 * EditorInput for rendering an external URL inside the workbench editor area.
 *
 * Used by the Agent Chat panel: when the user clicks a hyperlink in an LLM
 * response, the URL is opened in the middle (editor) column via this input +
 * `UrlPreviewEditorPane`, instead of launching an external browser.
 *
 * Each distinct URL gets its own tab; the same URL reuses the existing tab
 * (matched by `url.toString()`).
 *
 * Note: the constructor is public (with all-optional args) so that
 * `SyncDescriptor` can instantiate it during editor registration. Real
 * usage goes through the static `getOrCreate()` factory.
 */
export class UrlPreviewEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.urlPreview';

	override get typeId(): string {
		return UrlPreviewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return UrlPreviewEditorInput.ID;
	}

	private readonly _url: URI;
	private readonly _title: string;

	/** Cache of inputs keyed by URL string, so the same URL reuses one tab. */
	private static readonly _instances = new Map<string, UrlPreviewEditorInput>();

	static getOrCreate(rawUrl: string): UrlPreviewEditorInput {
		let uri: URI;
		try {
			uri = URI.parse(rawUrl);
		} catch {
			uri = URI.from({ scheme: 'https', authority: '', path: rawUrl });
		}
		const key = uri.toString();
		let inst = UrlPreviewEditorInput._instances.get(key);
		if (!inst || inst.isDisposed()) {
			let title = uri.authority || uri.path || rawUrl;
			title = title.replace(/^www\./, '');
			inst = new UrlPreviewEditorInput(uri, title);
			UrlPreviewEditorInput._instances.set(key, inst);
		}
		return inst;
	}

	/**
	 * Public for `SyncDescriptor` instantiation. Prefer `getOrCreate()` for
	 * real usage.
	 */
	constructor(url?: URI, title?: string) {
		super();
		this._url = url ?? URI.parse('about:blank');
		this._title = title ?? 'URL Preview';
	}

	override get resource(): URI {
		return this._url;
	}

	get url(): string {
		return this._url.toString(true);
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return this._title;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this._url,
			options: { override: UrlPreviewEditorInput.ID, pinned: true },
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof UrlPreviewEditorInput) {
			return this._url.toString() === other._url.toString();
		}
		return false;
	}

	override dispose(): void {
		UrlPreviewEditorInput._instances.delete(this._url.toString());
		super.dispose();
	}
}
