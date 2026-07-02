/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mark } from '../../../../base/common/performance.js';
import { IAction } from '../../../../base/common/actions.js';
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
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { wrapHtmlWithEditorRuntime } from './htmlEditorRuntime.js';

/**
 * HtmlFileEditorPane — extends TextFileEditor with a 3-mode segmented toggle
 * (编辑 / HTML / 预览) for `.html` files.
 *
 * Modes:
 *   - **edit** (default): standard CodeEditorWidget, fully editable. This is
 *     exactly what TextFileEditor provides.
 *   - **source** (HTML): same CodeEditorWidget but switched to read-only so the
 *     user can browse the HTML source without accidentally editing it.
 *   - **preview**: a webview rendering the HTML file's content, so the user
 *     sees the rendered page instead of source code.
 *
 * For non-HTML files the pane behaves identically to TextFileEditor — the
 * toggle is hidden (via EditorTitle menu `when` clause) and the editor stays
 * in edit mode.
 *
 * Architecture:
 *   `createEditorControl` is overridden to create two sibling containers
 *   inside the parent: one for the CodeEditorWidget (edit/source) and one
 *   for the preview webview. The CodeEditorWidget is created by
 *   `super.createEditorControl(editorContainer, …)` — we just pass a
 *   different parent element. `layout` is overridden to size both containers
 *   and the webview follows its container automatically.
 */
export class HtmlFileEditorPane extends TextFileEditor {

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
	private _mode: 'edit' | 'source' | 'preview' = 'edit';
	private _isHtml: boolean = false;

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

	override async setInput(input: FileEditorInput, options: IFileEditorInputOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		// Detect HTML files — only show the 3-mode toggle for these.
		const resource = input.resource;
		this._isHtml = resource.path.toLowerCase().endsWith('.html') || resource.path.toLowerCase().endsWith('.htm');

		if (this._isHtml) {
			// Capture the raw HTML for the preview webview. We read it from
			// the text model that super.setInput already resolved and set on
			// the CodeEditorWidget.
			const control = this.getControl();
			const model = control?.getModel();
			this._rawHtml = model?.getValue() ?? '';
		} else {
			this._rawHtml = undefined;
		}

		// Reset to edit mode for each new input.
		this._setMode('edit', /* force */ true);
	}

	/**
	 * Called by the editor toolbar's actionViewItemProvider for each action
	 * in the MenuId.EditorTitle menu. Returns a custom 3-segment toggle for
	 * our registered action when an HTML file is active.
	 */
	override getActionViewItem(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		if (action.id === HtmlFileEditorPane.TOGGLE_MODE_ACTION_ID) {
			return new HtmlFileSegmentedToggleViewItem(
				action,
				() => this._mode,
				mode => this._setMode(mode),
			);
		}
		return super.getActionViewItem(action, options);
	}

	/** Current view mode — exposed for the registered toggle command. */
	get currentMode(): 'edit' | 'source' | 'preview' {
		return this._mode;
	}

	/** Public entry point for the registered toggle command / keyboard. */
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

		// Toggle readonly on the code editor (source mode = read-only)
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
	 * back to the host and written into the text model.
	 */
	private _ensureEditWebview(): void {
		if (!this._editWebviewContainer) {
			return;
		}

		// If the edit webview already exists, just refresh its HTML.
		if (this._editWebview) {
			this._editWebview.setHtml(wrapHtmlWithEditorRuntime(this._rawHtml ?? ''));
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

		// Handle save/export messages from the editor runtime
		this._register(this._editWebview.onMessage(async (e) => {
			const msg = e.message as { type?: string; html?: string } | undefined;
			if (!msg || !msg.type) {
				return;
			}
			if (msg.type === 'htmlEditor.saveContent' || msg.type === 'htmlEditor.exportContent') {
				if (typeof msg.html === 'string') {
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
		this._rawHtml = undefined;
		this._mode = 'edit';
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

/**
 * Custom toolbar view item rendering a connected "编辑 / HTML / 预览"
 * segmented control (3 buttons). Stateless — pulls the current mode from
 * the pane on render.
 */
class HtmlFileSegmentedToggleViewItem extends BaseActionViewItem {

	private readonly _buttons: { el: HTMLElement; mode: 'edit' | 'source' | 'preview' }[] = [];
	private readonly _getMode: () => 'edit' | 'source' | 'preview';
	private readonly _onModeChange: (mode: 'edit' | 'source' | 'preview') => void;

	constructor(
		action: IAction,
		getMode: () => 'edit' | 'source' | 'preview',
		onModeChange: (mode: 'edit' | 'source' | 'preview') => void,
	) {
		super(undefined, action);
		this._getMode = getMode;
		this._onModeChange = onModeChange;
	}

	override render(container: HTMLElement): void {
		super.render(container);

		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}

		container.classList.add('html-file-segmented-toggle');
		container.style.display = 'inline-flex';
		container.style.alignItems = 'center';
		container.style.alignSelf = 'center';
		container.style.marginRight = '4px';
		container.style.userSelect = 'none';

		const labels: { label: string; mode: 'edit' | 'source' | 'preview' }[] = [
			{ label: '编辑', mode: 'edit' },
			{ label: 'HTML', mode: 'source' },
			{ label: '预览', mode: 'preview' },
		];

		for (let i = 0; i < labels.length; i++) {
			const { label, mode } = labels[i];
			const btn = this._createButton(label, mode);
			// Connected look: middle buttons have no border radius on either side,
			// first button has left radius, last button has right radius.
			if (i > 0) {
				btn.style.borderTopLeftRadius = '0';
				btn.style.borderBottomLeftRadius = '0';
				btn.style.borderLeft = 'none';
			}
			if (i < labels.length - 1) {
				btn.style.borderTopRightRadius = '0';
				btn.style.borderBottomRightRadius = '0';
			}
			container.appendChild(btn);
			this._buttons.push({ el: btn, mode });
		}

		this._updateActiveStyles(this._getMode());
	}

	private _createButton(label: string, mode: 'edit' | 'source' | 'preview'): HTMLElement {
		const btn = document.createElement('a');
		btn.classList.add('html-file-seg-btn');
		btn.setAttribute('role', 'button');
		btn.setAttribute('aria-pressed', 'false');
		btn.tabIndex = 0;
		btn.textContent = label;
		btn.style.display = 'inline-block';
		btn.style.padding = '2px 8px';
		btn.style.fontSize = '11px';
		btn.style.lineHeight = '18px';
		btn.style.cursor = 'pointer';
		btn.style.borderRadius = '3px';
		btn.style.border = '1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(255,255,255,0.1)))';
		btn.style.textDecoration = 'none';
		this._register(DOM.addDisposableListener(btn, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this._onModeChange(mode);
			this._updateActiveStyles(mode);
		}));
		return btn;
	}

	private _updateActiveStyles(mode: 'edit' | 'source' | 'preview'): void {
		for (const { el, mode: btnMode } of this._buttons) {
			const active = btnMode === mode;
			el.setAttribute('aria-pressed', String(active));
			el.style.background = active
				? 'var(--vscode-list-activeSelectionBackground, #094771)'
				: 'var(--vscode-editorWidget-background, transparent)';
			el.style.color = active
				? 'var(--vscode-list-activeSelectionForeground, #ffffff)'
				: 'var(--vscode-foreground, #cccccc)';
		}
	}
}
