/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mark } from '../../../../base/common/performance.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IEditorOpenContext, IFileEditorInputOptions } from '../../../../workbench/common/editor.js';
import { FileEditorInput } from '../../../../workbench/contrib/files/browser/editors/fileEditorInput.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITextResourceConfigurationService } from '../../../../editor/common/services/textResourceConfiguration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IExplorerService } from '../../../../workbench/contrib/files/browser/files.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { IFilesConfigurationService } from '../../../../workbench/services/filesConfiguration/common/filesConfigurationService.js';
import { TextFileEditor } from '../../../../workbench/contrib/files/browser/editors/textFileEditor.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { wrapHtmlWithEditorRuntime } from './htmlEditorRuntime.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { IConfigHtmlService } from '../../../common/agentStudioService.js';

/**
 * HtmlFileEditorPane — extends TextFileEditor with a 3-mode segmented toggle
 * (编辑 / HTML / 预览) for `.html` files, displayed in the editor group's
 * trailing breadcrumbs (next to the file path breadcrumb) so it looks
 * identical to {@link HtmlPreviewEditorPane}.
 *
 * Modes:
 *   - **edit** (default for HTML files): a webview rendering the HTML with
 *     injected editor runtime — drag, resize, RTE, undo/redo, save/export.
 *     Functionally identical to the edit page in HtmlPreviewEditorPane.
 *   - **HTML**: same CodeEditorWidget (inherited from TextFileEditor) but
 *     switched to read-only so the user can browse the HTML source without
 *     accidentally editing it.
 *   - **preview**: a webview rendering the HTML file's content.
 *
 * For non-HTML files the pane behaves identically to TextFileEditor — the
 * toggle is hidden (only set up when the active input is an HTML file) and
 * the editor stays in edit mode.
 *
 * Architecture:
 *   `createEditorControl` is overridden to create two sibling containers
 *   inside the parent: one for the CodeEditorWidget (edit/source) and one
 *   for the preview webview. The CodeEditorWidget is created by
 *   `super.createEditorControl(editorContainer, …)` — we just pass a
 *   different parent element. `layout` is overridden to size both containers
 *   and the webview follows its container automatically.
 *
 * The trailing-breadcrumbs toggle is implemented by setting a custom
 * content element on the editor group via `setTrailingBreadcrumbsContent`.
 * The element contains three connected buttons (编辑 / HTML / 预览) that
 * call `_setMode` on click and update their active state.
 */
export class HtmlFileEditorPane extends TextFileEditor {

	/**
	 * Action id (kept for backward compatibility — no longer registered as a
	 * menu action). The toggle is now rendered into the editor group's
	 * trailing breadcrumbs via `setTrailingBreadcrumbsContent`.
	 */
	static readonly TOGGLE_MODE_ACTION_ID = 'agentStudio.htmlFile.toggleMode';

	/** Custom ID so the editor-title toolbar toggle only shows for this pane. */
	override getId(): string {
		return 'agentStudio.htmlFileEditor';
	}

	private _editorContainer: HTMLElement | undefined;
	private _previewContainer: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	/** Edit-mode webview — renders the HTML with injected editor runtime (visual editing). */
	private _editWebview: IWebviewElement | undefined;
	/** Container for the edit-mode webview. */
	private _editWebviewContainer: HTMLElement | undefined;
	private _rawHtml: string | undefined;
	private _mode: 'edit' | 'source' | 'preview' = 'preview';
	private _isHtml: boolean = false;

	/** Trailing breadcrumbs content container (the 3-button toggle). */
	private _trailingBreadcrumbsContent: HTMLElement | undefined;
	/** Toggle buttons inside the trailing-breadcrumbs container. */
	private _toggleButtons: { el: HTMLElement; mode: 'edit' | 'source' | 'preview' }[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IFileService fileService: IFileService,
		@IPaneCompositePartService paneCompositeService: IPaneCompositePartService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IEditorService editorService: IEditorService,
		@IThemeService themeService: IThemeService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@ITextFileService textFileService: ITextFileService,
		@IExplorerService explorerService: IExplorerService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IPathService pathService: IPathService,
		@IConfigurationService configurationService: IConfigurationService,
		@IPreferencesService preferencesService: IPreferencesService,
		@IHostService hostService: IHostService,
		@IFilesConfigurationService filesConfigurationService: IFilesConfigurationService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@ILogService private readonly _logService: ILogService,
		@IConfigHtmlService private readonly _configHtmlService: IConfigHtmlService,
	) {
		super(
			group,
			telemetryService,
			fileService,
			paneCompositeService,
			instantiationService,
			contextService,
			storageService,
			textResourceConfigurationService,
			editorService,
			themeService,
			editorGroupService,
			textFileService,
			explorerService,
			uriIdentityService,
			pathService,
			configurationService,
			preferencesService,
			hostService,
			filesConfigurationService,
		);
	}

	/**
	 * Override createEditorControl to create a dual-container structure:
	 * one div for the CodeEditorWidget (edit/source modes) and one div for
	 * the preview webview (preview mode). super.createEditorControl creates
	 * the CodeEditorWidget inside the given parent.
	 */
	protected override createEditorControl(parent: HTMLElement, initialOptions: ICodeEditorOptions): void {
		// [Sarosis 2026-07-04] Make the parent the positioning context for our
		// `position: absolute; inset: 0` containers. Without this, the absolute
		// containers (preview / edit webview) would resolve `inset: 0` against
		// the nearest positioned ancestor — which is the editor group's
		// `.title` element (`.editor-group-container > .title` has
		// `position: relative` for the breadcrumbs layout, see
		// editorgroupview.css:177-181). The result: when the preview or edit
		// webview is shown, it overflows UP and covers the tab + breadcrumb
		// area, hiding the editor title entirely.
		//
		// We cannot modify the CSS class (`.editor-instance`) from here, so
		// the simplest correct fix is to set `position: relative` on the
		// inline `parent.style`. The class's `height: 100%` continues to
		// drive the box height, while inline `position: relative` scopes our
		// `position: absolute` children to this element only.
		parent.style.position = 'relative';

		// Wrapper to hold both containers, positioned absolutely.
		this._editorContainer = document.createElement('div');
		this._editorContainer.style.position = 'absolute';
		this._editorContainer.style.inset = '0';
		parent.appendChild(this._editorContainer);

		// Preview container — hidden by default (edit mode is default).
		this._previewContainer = document.createElement('div');
		this._previewContainer.style.position = 'absolute';
		this._previewContainer.style.inset = '0';
		this._previewContainer.style.display = 'none';
		this._previewContainer.style.background = 'var(--vscode-editor-background, #1e1e1e)';

		// Edit-mode visual editor container — holds a webview with injected
		// editor runtime. Initially hidden; shown when mode === 'edit' and
		// the file is HTML (the CodeEditorWidget stays for non-HTML files).
		this._editWebviewContainer = document.createElement('div');
		this._editWebviewContainer.style.position = 'absolute';
		this._editWebviewContainer.style.inset = '0';
		this._editWebviewContainer.style.display = 'none';
		this._editWebviewContainer.style.background = '#ffffff';
		parent.appendChild(this._previewContainer);
		parent.appendChild(this._editWebviewContainer);

		// Let TextFileEditor → AbstractTextCodeEditor create the CodeEditorWidget
		// inside our editor container (instead of the raw parent).
		mark('code/willCreateTextFileEditorControl');
		super.createEditorControl(this._editorContainer, initialOptions);
		mark('code/didCreateTextFileEditorControl');
	}

	override async setInput(input: FileEditorInput | HtmlPreviewEditorInput, options: IFileEditorInputOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		// Handle HtmlPreviewEditorInput (saros-html-preview:// scheme).
		// These inputs use a virtual `saros-html-preview` URI which has no
		// filesystem provider — we CANNOT wrap it in a `FileEditorInput` and
		// forward to `super.setInput`.  Instead just render the HTML in a
		// full-bleed preview webview without the 3-mode toggle.  Users who
		// want source editing can open the backing `config.html` disk file
		// directly from the file explorer.
		if (input instanceof HtmlPreviewEditorInput) {
			this._isHtml = true;
			this._cleanupTrailingBreadcrumbsContent();

			// Start webview process creation immediately — this fires the
			// IPC and spawns the out-of-process iframe.  In parallel we
			// await renderHtml below, so the two slow operations overlap.
			this._setMode('preview', /* force */ true);

			try {
				const agentId = input.agentId ?? input.resource.path.replace(/^\//, '');
				const result = await this._configHtmlService.getHtml(agentId);
				this._rawHtml = result.html;
			} catch (err) {
				this._logService.warn('[HtmlFileEditorPane] renderHtml failed:', err);
				this._rawHtml = `Failed to render: ${err}`;
			}

			// Webview is already mounted; just inject the resolved HTML.
			if (this._webview) {
				this._webview.setHtml(this._wrapHtmlForWebview(this._rawHtml ?? ''));
			}
			return;
		}

		await super.setInput(input, options, context, token);

		// Detect HTML files — only show the 3-mode toggle for these.
		const resource = input.resource;
		this._isHtml = resource.path.toLowerCase().endsWith('.html') || resource.path.toLowerCase().endsWith('.htm');

		if (this._isHtml) {
			// Capture the raw HTML for the preview / edit webviews. We read
			// it from the text model that super.setInput already resolved
			// and set on the CodeEditorWidget.
			const control = this.getControl();
			const model = control?.getModel();
			this._rawHtml = model?.getValue() ?? '';

			// Set up the trailing-breadcrumbs toggle (编辑 / HTML / 预览).
			this._setupTrailingBreadcrumbsContent();
		} else {
			this._rawHtml = undefined;
			// Make sure no leftover toggle from a previous HTML input is shown.
			this._cleanupTrailingBreadcrumbsContent();
		}

		// Reset to preview mode for each new input.
		this._setMode('preview', /* force */ true);
	}

	/** Current view mode — exposed for any external mode switch. */
	get currentMode(): 'edit' | 'source' | 'preview' {
		return this._mode;
	}

	/** Public entry point for any external mode switch (e.g. test code). */
	setMode(mode: 'edit' | 'source' | 'preview'): void {
		this._setMode(mode);
	}

	/**
	 * Switch between edit / source / preview modes.
	 *
	 * - **edit** (HTML files): show the visual editor webview (with injected
	 *   editor runtime — drag, resize, RTE, undo/redo, save/export).
	 * - **edit** (non-HTML): show the CodeEditorWidget (standard text editing).
	 * - **source**: show the CodeEditorWidget in read-only mode.
	 * - **preview**: hide the CodeEditorWidget, show the preview webview.
	 *
	 * The webviews are created lazily on first switch.
	 */
	private _setMode(mode: 'edit' | 'source' | 'preview', force: boolean = false): void {
		if (this._mode === mode && !force) {
			return;
		}
		this._mode = mode;

		const control = this.getControl();
		const useVisualEditor = mode === 'edit' && this._isHtml;

		// Toggle containers — visual editor webview vs CodeEditorWidget
		if (this._editorContainer) {
			this._editorContainer.style.display = (mode === 'preview' || useVisualEditor) ? 'none' : '';
		}
		if (this._previewContainer) {
			this._previewContainer.style.display = mode === 'preview' ? '' : 'none';
		}
		if (this._editWebviewContainer) {
			this._editWebviewContainer.style.display = useVisualEditor ? '' : 'none';
		}

		// Toggle readonly on the code editor (source mode = read-only,
		// or when visual editor is shown the underlying text widget is
		// hidden but we keep it read-only to be safe).
		if (control) {
			const readOnly = mode === 'source' || useVisualEditor;
			control.updateOptions({ readOnly });
		}

		// Lazily create / update webviews
		if (mode === 'preview') {
			this._ensurePreviewWebview();
		}
		if (useVisualEditor) {
			this._ensureEditWebview();
		}

		// Update the toggle button active-state in the trailing breadcrumbs.
		this._updateToggleButtonStyles();
	}

	private _ensurePreviewWebview(): void {
		if (!this._previewContainer) {
			return;
		}

		// If a webview already exists, just update its HTML.
		if (this._webview) {
			this._webview.setHtml(this._wrapHtmlForWebview(this._rawHtml ?? ''));
			return;
		}

		const resource = this.input?.resource;
		const dirUri = resource
			? URI.file(resource.fsPath.replace(/[\\/][^\\/]+$/, ''))
			: undefined;

		this._webview = this._webviewService.createWebviewElement({
			title: 'HTML Preview',
			options: {
				enableFindWidget: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
				allowForms: true,
				localResourceRoots: dirUri ? [dirUri] : [],
			},
			extension: undefined,
		});

		this._register(this._webview);
		this._webview.mountTo(this._previewContainer, mainWindow);
		this._webview.setHtml(this._wrapHtmlForWebview(this._rawHtml ?? ''));
	}

	/**
	 * Create or update the edit-mode webview that renders the HTML with the
	 * full editor runtime injected (drag, resize, RTE, undo/redo, save).
	 * When the user saves inside the webview, the cleaned HTML is posted
	 * back to the host via `htmlEditor.saveContent` and written into the
	 * text model.
	 *
	 * Mirrors the behavior of {@link HtmlPreviewEditorPane._ensureEditWebview}
	 * so the visual editing experience is consistent between the standalone
	 * preview editor and the text-editor HTML file view.
	 */
	private _ensureEditWebview(): void {
		if (!this._editWebviewContainer) {
			return;
		}

		// If the edit webview already exists, refresh its HTML and tell it
		// to re-enter edit mode. setHtml alone does NOT re-execute <script>
		// tags on the same document, so we must post a follow-up message.
		if (this._editWebview) {
			this._logService.warn('[HtmlFileEditorPane] _ensureEditWebview: REFRESHING existing edit webview (setHtml + enterEditMode)');
			this._editWebview.setHtml(wrapHtmlWithEditorRuntime(this._rawHtml ?? ''));
			setTimeout(() => {
				this._logService.info('[HtmlFileEditorPane] _ensureEditWebview: posting enterEditMode after setHtml');
				this._editWebview?.postMessage({ type: 'htmlEditor.enterEditMode' });
			}, 200);
			return;
		}

		const resource = this.input?.resource;
		const dirUri = resource
			? URI.file(resource.fsPath.replace(/[\\/][^\\/]+$/, ''))
			: undefined;

		this._editWebview = this._webviewService.createWebviewElement({
			title: 'HTML Visual Editor',
			options: {
				enableFindWidget: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
				allowForms: true,
				localResourceRoots: dirUri ? [dirUri] : [],
			},
			extension: undefined,
		});

		this._register(this._editWebview);

		// Handle save / export / sync messages from the editor runtime.
		// `htmlEditor.syncContent` is emitted on every content change inside
		// the visual editor so we can keep the underlying text model in sync
		// (the user can switch to source mode and see live HTML).
		this._register(this._editWebview.onMessage(async (e) => {
			const msg = e.message as { type?: string; html?: string } | undefined;
			if (!msg || !msg.type) {
				return;
			}
			this._logService.info(`[HtmlFileEditorPane] editWebview.onMessage: type=${msg.type} htmlLen=${typeof msg.html === 'string' ? msg.html.length : 'n/a'}`);
			if (msg.type === 'htmlEditor.syncContent') {
				if (typeof msg.html === 'string') {
					this._rawHtml = msg.html;
				}
				return;
			}
			if (msg.type === 'htmlEditor.saveContent' || msg.type === 'htmlEditor.exportContent') {
				if (typeof msg.html === 'string') {
					this._logService.info('[HtmlFileEditorPane] calling _applyEditedHtml from saveContent');
					this._applyEditedHtml(msg.html);
				}
			}
		}));

		this._editWebview.mountTo(this._editWebviewContainer, mainWindow);
		this._editWebview.setHtml(wrapHtmlWithEditorRuntime(this._rawHtml ?? ''));
	}

	/**
	 * Write the edited HTML back into the text model so the file is updated
	 * on disk when the user saves. Also updates `_rawHtml` so switching to
	 * preview mode reflects the latest edits.
	 */
	private _applyEditedHtml(html: string): void {
		this._logService.info(`[HtmlFileEditorPane] _applyEditedHtml: htmlLen=${html.length} _webviewExists=${!!this._webview}`);
		this._rawHtml = html;
		const control = this.getControl();
		const model = control?.getModel();
		if (model) {
			// Use pushEditOperations to make the change undoable in the code editor
			model.applyEdits([{
				range: model.getFullModelRange(),
				text: html,
			}]);
		}
		// Refresh the preview webview (if mounted) so the latest HTML
		// shows up the next time the user switches to preview mode.
		if (this._webview) {
			this._logService.info('[HtmlFileEditorPane] _applyEditedHtml: refreshing preview webview');
			this._webview.setHtml(this._wrapHtmlForWebview(html));
		}
	}

	private _wrapHtmlForWebview(html: string): string {
		const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https: vscode-resource: vscode-webview-resource: vscode-webview:; script-src 'unsafe-inline' 'unsafe-eval' https: vscode-resource: vscode-webview-resource: vscode-webview:; img-src 'self' data: https: vscode-resource: vscode-webview-resource: vscode-webview:; font-src data: https: vscode-resource: vscode-webview-resource: vscode-webview:; connect-src https: vscode-resource: vscode-webview-resource: vscode-webview:; frame-src https: vscode-webview:;">`;
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

		return `<!doctype html><html><head>${csp}${baseStyle}</head><body>${html}</body></html>`;
	}

	override layout(dimension: Dimension): void {
		super.layout(dimension);
		// IWebviewElement tracks its container automatically, so no explicit
		// layout call is needed for the webview.
	}

	// ─── Trailing-breadcrumbs toggle (编辑 / HTML / 预览) ──────────────────

	/**
	 * Set up the trailing breadcrumbs content (3-mode toggle buttons).
	 * The container is attached to the editor group via
	 * `setTrailingBreadcrumbsContent`, so it appears next to the file path
	 * breadcrumb below the editor tab — identical look to
	 * {@link HtmlPreviewEditorPane}.
	 */
	private _setupTrailingBreadcrumbsContent(): void {
		// Clear any existing trailing content (e.g. from a previous input).
		this._cleanupTrailingBreadcrumbsContent();

		this._trailingBreadcrumbsContent = this._createTrailingBreadcrumbsContent();
		this.group.setTrailingBreadcrumbsContent(this._trailingBreadcrumbsContent);
	}

	/**
	 * Clean up the trailing breadcrumbs content. Detaches the element from
	 * the editor group and clears the local button references so the next
	 * setInput can rebuild from scratch.
	 */
	private _cleanupTrailingBreadcrumbsContent(): void {
		if (this._trailingBreadcrumbsContent) {
			this.group.setTrailingBreadcrumbsContent(undefined);
			this._trailingBreadcrumbsContent = undefined;
		}
		this._toggleButtons = [];
	}

	/**
	 * Build the 3-button connected segmented toggle (编辑 / HTML / 预览)
	 * that gets injected into the editor group's trailing breadcrumbs area.
	 * Returns the container element ready to be passed to
	 * `group.setTrailingBreadcrumbsContent`.
	 */
	private _createTrailingBreadcrumbsContent(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'html-file-mode-toggle';
		container.style.display = 'inline-flex';
		container.style.alignItems = 'center';
		container.style.gap = '0';
		container.style.whiteSpace = 'nowrap';

		const labels: { label: string; mode: 'edit' | 'source' | 'preview' }[] = [
			{ label: '编辑', mode: 'edit' },
			{ label: 'HTML', mode: 'source' },
			{ label: '预览', mode: 'preview' },
		];

		this._toggleButtons = [];

		for (let i = 0; i < labels.length; i++) {
			const { label, mode } = labels[i];
			const btn = document.createElement('a');
			btn.classList.add('html-file-seg-btn');
			btn.setAttribute('role', 'button');
			btn.setAttribute('aria-pressed', String(mode === this._mode));
			btn.tabIndex = 0;
			btn.textContent = label;
			btn.style.display = 'inline-block';
			btn.style.whiteSpace = 'nowrap';
			btn.style.padding = '2px 8px';
			btn.style.fontSize = '11px';
			btn.style.lineHeight = '18px';
			btn.style.cursor = 'pointer';
			btn.style.borderRadius = '3px';
			btn.style.border = '1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(255,255,255,0.1)))';
			btn.style.textDecoration = 'none';
			btn.style.backgroundColor = 'transparent';

			// Connected look: middle buttons have no border radius on either
			// side, first button has left radius, last button has right radius.
			if (i > 0) {
				btn.style.borderTopLeftRadius = '0';
				btn.style.borderBottomLeftRadius = '0';
				btn.style.borderLeft = 'none';
			}
			if (i < labels.length - 1) {
				btn.style.borderTopRightRadius = '0';
				btn.style.borderBottomRightRadius = '0';
			}

			this._register(DOM.addDisposableListener(btn, DOM.EventType.CLICK, (e) => {
				DOM.EventHelper.stop(e, true);
				this._logService.info(`[HtmlFileEditorPane] toggle button clicked: mode=${mode}`);
				this._setMode(mode);
			}));

			container.appendChild(btn);
			this._toggleButtons.push({ el: btn, mode });
		}

		this._updateToggleButtonStyles();

		return container;
	}

	/** Refresh the active state of the toggle buttons to match the current mode. */
	private _updateToggleButtonStyles(): void {
		if (!this._toggleButtons) {
			return;
		}
		for (const { el, mode } of this._toggleButtons) {
			const active = mode === this._mode;
			el.setAttribute('aria-pressed', String(active));
			el.style.backgroundColor = active
				? 'var(--vscode-list-activeSelectionBackground, #094771)'
				: 'var(--vscode-editorWidget-background, transparent)';
			el.style.color = active
				? 'var(--vscode-list-activeSelectionForeground, #ffffff)'
				: 'var(--vscode-foreground, #cccccc)';
		}
	}

	override clearInput(): void {
		// Dispose preview webview on input clear
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		// Dispose edit-mode visual editor webview
		if (this._editWebview) {
			this._editWebview.dispose();
			this._editWebview = undefined;
		}
		if (this._editWebviewContainer) {
			DOM.clearNode(this._editWebviewContainer);
		}
		if (this._previewContainer) {
			DOM.clearNode(this._previewContainer);
		}
		this._cleanupTrailingBreadcrumbsContent();
		this._rawHtml = undefined;
		this._mode = 'preview';
		this._isHtml = false;
		super.clearInput();
	}

	override dispose(): void {
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		if (this._editWebview) {
			this._editWebview.dispose();
			this._editWebview = undefined;
		}
		super.dispose();
	}
}

