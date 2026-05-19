/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';

/**
 * EditorPane that renders a standalone HTML file inside the editor area.
 *
 * Architecture: same model as `AgentStudioEditorPane` (the chat panel) —
 * we own a regular `<div>` container, create an `IWebviewElement` (NOT an
 * `IOverlayWebview`), and mount it directly into our container via
 * `webview.mountTo(this._container, mainWindow)`. This bypasses the
 * `OverlayLayoutElement` / CSS anchor-positioning code path which on this
 * fork's Chromium build fails to render the iframe visibly.
 *
 * Lifecycle: a fresh webview is created in `setInput()` so the pane is
 * functional after being moved between editor groups (re-parenting an
 * existing webview iframe destroys its document).
 */
export class HtmlPreviewEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.htmlPreviewPane';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	/** Ensures we don't `mountTo` again for an unchanged input (which would destroy the iframe). */
	private _mountedResource: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(HtmlPreviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-studio-html-preview-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		// VS Code default light/dark backdrop so a still-loading preview does
		// not show the surrounding editor's black/empty background.
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

		if (!(input instanceof HtmlPreviewEditorInput) || !this._container) {
			return;
		}

		const resourceKey = input.resource.toString();

		// Re-mount on every setInput because the editor pane may have been
		// moved between groups (destroying the iframe), and because the file
		// content may have changed since last open.
		this._disposeWebview();

		try {
			const buf = await this._fileService.readFile(input.resource);
			if (token.isCancellationRequested) {
				return;
			}

			const html = buf.value.toString();
			const wrappedHtml = this._wrapHtmlForWebview(html);

			// Permit the webview to read sibling resources from the file's
			// directory (e.g. linked images, styles) without explicit
			// per-asset whitelisting.
			const dirUri = URI.file(input.resource.fsPath.replace(/[\\/][^\\/]+$/, ''));

			this._webview = this._webviewService.createWebviewElement({
				title: input.getName(),
				options: {
					enableFindWidget: true,
					retainContextWhenHidden: true,
				},
				contentOptions: {
					allowScripts: true,
					allowForms: true,
					localResourceRoots: [dirUri],
				},
				extension: undefined,
			});

			this._register(this._webview);

			// Direct DOM mount — this is the path that works on this fork's
			// Chromium build, identical to how the chat panel mounts itself.
			this._webview.mountTo(this._container, mainWindow);
			this._webview.setHtml(wrappedHtml);
			this._mountedResource = resourceKey;
			this._logService.info(`[HtmlPreviewEditorPane] mounted preview for ${resourceKey} (${wrappedHtml.length} chars)`);
		} catch (err) {
			this._logService.error(`[HtmlPreviewEditorPane] failed to load ${resourceKey}:`, err);
			if (this._container) {
				DOM.clearNode(this._container);
				const errorEl = document.createElement('div');
				errorEl.style.padding = '20px';
				errorEl.style.color = 'var(--vscode-errorForeground, #f48771)';
				errorEl.style.fontFamily = 'sans-serif';
				errorEl.textContent = `预览加载失败: ${err instanceof Error ? err.message : String(err)}`;
				this._container.appendChild(errorEl);
			}
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		// IWebviewElement automatically tracks its container's bounding box,
		// so no explicit per-frame size update is needed (unlike chat panel's
		// AgentStudioWebviewController.layout, which forwards dims to React).
	}

	override clearInput(): void {
		this._disposeWebview();
		this._mountedResource = undefined;
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

	/**
	 * Wrap an HTML document for rendering inside a VS Code webview.
	 *
	 * VS Code webviews enforce a strict default CSP that blocks inline
	 * <style>, inline <script>, and several other features. To render an
	 * arbitrary self-contained HTML file we must explicitly opt in via a
	 * <meta http-equiv="Content-Security-Policy"> tag. We also inject a
	 * minimal default body style so documents that omit a body background
	 * blend with the editor instead of appearing fully black.
	 */
	private _wrapHtmlForWebview(html: string): string {
		const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https: vscode-resource: vscode-webview-resource:; script-src 'unsafe-inline' 'unsafe-eval' https: vscode-resource: vscode-webview-resource:; img-src 'self' data: https: vscode-resource: vscode-webview-resource:; font-src data: https: vscode-resource: vscode-webview-resource:; connect-src https: vscode-resource: vscode-webview-resource:; frame-src https:;">`;
		const baseStyle = `<style>html,body{margin:0;padding:0;}body{background:#ffffff;color:#1e1e1e;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;}@media (prefers-color-scheme: dark){body{background:#1e1e1e;color:#d4d4d4;}}</style>`;

		const lower = html.toLowerCase();
		const headIdx = lower.indexOf('<head>');
		if (headIdx >= 0) {
			const insertPos = headIdx + '<head>'.length;
			return html.slice(0, insertPos) + csp + baseStyle + html.slice(insertPos);
		}

		const htmlIdx = lower.indexOf('<html');
		if (htmlIdx >= 0) {
			const closeBracket = html.indexOf('>', htmlIdx);
			if (closeBracket >= 0) {
				return html.slice(0, closeBracket + 1) + `<head>${csp}${baseStyle}</head>` + html.slice(closeBracket + 1);
			}
		}

		// Fragment: wrap into a full document.
		return `<!doctype html><html><head>${csp}${baseStyle}</head><body>${html}</body></html>`;
	}
}
