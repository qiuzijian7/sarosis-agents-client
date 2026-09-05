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
			// ★ 状态提示：加载中 / 超时（本地面板服务可能仍在启动）/ 失败 + 重试按钮。
			//   本地 http 服务由宿主按需拉起（vscode:configHtmlEnsureServer），
			//   首次启动可能要几秒到几十秒，没有提示会让人以为面板坏了。
			const html = `<!DOCTYPE html>
			<html>
			<head>
			<meta charset="utf-8">
			<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; frame-src *;">
			<style>
			html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
			iframe { width: 100%; height: 100%; border: none; display: block; }
			#overlay {
			position: fixed; inset: 0; display: flex; flex-direction: column;
			align-items: center; justify-content: center; gap: 12px;
			font-family: sans-serif; font-size: 14px; color: #888; background: #fff;
			transition: opacity 0.3s;
			}
			#overlay.hidden { opacity: 0; pointer-events: none; }
			#overlay.error { color: #c33; }
			#retry {
			display: none; padding: 6px 16px; border: 1px solid #d0d0d0; border-radius: 4px;
			background: #f5f5f5; color: #333; cursor: pointer; font-size: 13px;
			}
			#retry:hover { background: #e8e8e8; }
			</style>
			</head>
			<body>
			<div id="overlay">
			<div id="msg">正在加载 ${escapedUrl} …</div>
			<button id="retry">重试</button>
			</div>
			<iframe src="${escapedUrl}" id="frame" allow="fullscreen; clipboard-read; clipboard-write"></iframe>
			<script>
			(function() {
			var f = document.getElementById('frame');
			var o = document.getElementById('overlay');
			var m = document.getElementById('msg');
			var b = document.getElementById('retry');
			var done = false;
			var src = ${JSON.stringify(url)};

			function ok() { done = true; o.classList.add('hidden'); }
			function fail(text) {
				if (done) { return; }
				o.classList.add('error');
				o.classList.remove('hidden');
				m.textContent = text;
				b.style.display = '';
			}

			f.addEventListener('load', ok);
			f.addEventListener('error', function() { fail('页面加载失败'); });
			b.addEventListener('click', function() {
				done = false;
				o.classList.remove('error');
				b.style.display = 'none';
				m.textContent = '正在重试…';
				f.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + '_r=' + Date.now();
			});

			// 10s 仍未加载 → 提示（本地服务可能刚被拉起、仍在构建/扫描节点）
			setTimeout(function() {
				if (!done) { fail('加载超时——服务可能仍在启动，可稍后点击「重试」'); }
			}, 10000);
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
