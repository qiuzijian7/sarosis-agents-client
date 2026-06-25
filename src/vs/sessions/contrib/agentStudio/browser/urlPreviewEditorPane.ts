/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { UrlPreviewEditorInput } from './urlPreviewEditorInput.js';

/**
 * EditorPane that renders an external URL inside the workbench editor area.
 *
 * Architecture mirrors `HtmlPreviewEditorPane`: we own a `<div>` container,
 * create an `IWebviewElement` (NOT an `IOverlayWebview`), and mount it
 * directly into our container. The webview's HTML is a full-viewport
 * `<iframe>` pointing at the target URL, giving us native browser rendering
 * of the linked page without leaving the workbench.
 *
 * Used by the Agent Chat panel: clicking a hyperlink in an LLM response
 * opens the page here (middle column) instead of an external browser.
 */
export class UrlPreviewEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.urlPreviewPane';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
	) {
		super(UrlPreviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-studio-url-preview-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof UrlPreviewEditorInput) || !this._container) {
			return;
		}

		this._disposeWebview();

		const url = input.url;

		try {
			this._webview = this._webviewService.createWebviewElement({
				title: input.getName(),
				options: {
					enableFindWidget: true,
					retainContextWhenHidden: true,
				},
				contentOptions: {
					allowScripts: true,
					allowForms: true,
					// No localResourceRoots needed — we load an external URL.
				},
				extension: undefined,
			});

			this._register(this._webview);

			// Direct DOM mount (same pattern as HtmlPreviewEditorPane).
			this._webview.mountTo(this._container, mainWindow);

			// Build a minimal HTML shell whose only content is a full-viewport
			// iframe pointing at the target URL. The webview provides the
			// sandboxed container; the iframe handles the actual page load.
			const escapedUrl = url.replace(/"/g, '&quot;');
			const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; frame-src *;">
<style>
	html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
	iframe { width: 100%; height: 100%; border: none; display: block; }
	.loading-overlay {
		position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
		font-family: sans-serif; font-size: 14px; color: #888; background: #fff;
		transition: opacity 0.3s; pointer-events: none;
	}
	.loading-overlay.hidden { opacity: 0; }
</style>
</head>
<body>
<div class="loading-overlay" id="loader">Loading…</div>
<iframe src="${escapedUrl}" id="frame" allow="fullscreen; clipboard-read; clipboard-write"></iframe>
<script>
	(function() {
		var f = document.getElementById('frame');
		var l = document.getElementById('loader');
		f.addEventListener('load', function() { l.classList.add('hidden'); });
	})();
</script>
</body>
</html>`;
			this._webview.setHtml(html);
		} catch (err) {
			if (this._container) {
				DOM.clearNode(this._container);
				const errorEl = document.createElement('div');
				errorEl.style.padding = '20px';
				errorEl.style.color = 'var(--vscode-errorForeground, #f48771)';
				errorEl.style.fontFamily = 'sans-serif';
				errorEl.textContent = `网页加载失败: ${err instanceof Error ? err.message : String(err)}`;
				this._container.appendChild(errorEl);
			}
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override clearInput(): void {
		this._disposeWebview();
		super.clearInput();
	}

	override dispose(): void {
		this._disposeWebview();
		super.dispose();
	}

	private _disposeWebview(): void {
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		if (this._container) {
			DOM.clearNode(this._container);
		}
	}
}
