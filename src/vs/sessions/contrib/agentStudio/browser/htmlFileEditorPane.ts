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
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
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
	private _previewAgentId: string | undefined;
	/** True when the active input is a virtual HtmlPreviewEditorInput (chat "Apply" / ConfigHtml preview). */
	private _isPreviewInput: boolean = false;
	/** Standalone read-only model backing "HTML" (source) mode for preview inputs (no file model). */
	private _previewInputSourceModel: ITextModel | undefined;
	/** File service (stored because we read HTML directly from disk for chat "Apply" previews). */
	private _fileService: IFileService;

	/** Trailing breadcrumbs content container (the 3-button toggle). */
	private _trailingBreadcrumbsContent: HTMLElement | undefined;
	/** Toggle buttons inside the trailing-breadcrumbs container. */
	private _toggleButtons: { el: HTMLElement; mode: 'edit' | 'source' | 'preview' }[] = [];
	/**
	 * Fallback inline toggle bar — rendered directly inside the editor pane's
	 * parent when the group's trailing-breadcrumbs container is unavailable
	 * (e.g. showTabs=′single′, breadcrumbs disabled).  Positioned absolutely
	 * at the top-right so it never overlaps file content.
	 */
	private _inlineToggleBar: HTMLElement | undefined;

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
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
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
		this._fileService = fileService;
		// Log instantiation AFTER super() so we can confirm the pane was
		// actually created.
		this._logService.info(`[HtmlFileEditorPane] constructor: instantiated, paneId=${this.getId()}, groupId=${group.id}`);
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
		this._logService.info(`[HtmlFileEditorPane] createEditorControl: editorContainer created=${!!this._editorContainer}, parent=${!!this._editorContainer?.parentElement}`);
	}

	override async setInput(input: FileEditorInput | HtmlPreviewEditorInput, options: IFileEditorInputOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this._logService.info(`[HtmlFileEditorPane] setInput called: input.constructor.name=${input.constructor.name}, typeId=${(input as any).typeId ?? 'n/a'}, resource=${input.resource?.toString() ?? 'undefined'}`);

		// Handle HtmlPreviewEditorInput (chat "Apply" / ConfigHtml preview).
		// These inputs use a virtual `saros-html-preview` URI (no filesystem
		// provider) so we CANNOT wrap them in a `FileEditorInput` and forward
		// to `super.setInput`.  Instead we render the HTML in a full-bleed
		// preview webview and, like standard `.html` files, show the
		// 编辑 / HTML / 预览 toggle so users can switch between the visual
		// editor, the HTML source and the rendered preview.
		if (input instanceof HtmlPreviewEditorInput) {
			this._logService.info('[HtmlFileEditorPane] setInput: matched HtmlPreviewEditorInput — entering preview-input path');
			this._isHtml = true;
			this._isPreviewInput = true;

			// Show the 编辑 / HTML / 预览 toggle for the preview input too,
			// so users can switch between the visual editor, the HTML source
			// and the rendered preview. (For standard `.html` files this is
			// set up after super.setInput; the preview-input path bypasses
			// super.setInput, so we set it up here.)
			this._setupTrailingBreadcrumbsContent();

			// Start webview process creation immediately — this fires the
			// IPC and spawns the out-of-process iframe.  In parallel we
			// await renderHtml below, so the two slow operations overlap.
			this._setMode('preview', /* force */ true);

			try {
				if (input.agentId) {
					// ConfigHtml preview: the HTML is owned by ConfigHtmlService
					// and keyed by agentId.
					const result = await this._configHtmlService.getHtml(input.agentId);
					this._rawHtml = result.html;
				} else if (input.htmlContent !== undefined) {
					// Chat "Apply" preview of an unsaved HTML block: the HTML
					// is carried in-memory on the input — render it directly
					// without ever touching the filesystem (the resource is a
					// virtual `saros-html-preview` URI with no file behind it).
					this._rawHtml = input.htmlContent;
				} else {
					// Fallback: read the (real) file the Apply wrote to disk.
					const content = await this._fileService.readFile(input.resource);
					this._rawHtml = content.value.toString();
				}
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
		// This is the standard file path, not a virtual preview input.
		this._isPreviewInput = false;

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

		this._logService.info(
			`[HtmlFileEditorPane] setInput DONE: _isHtml=${this._isHtml}, _isPreviewInput=${this._isPreviewInput}, ` +
			`_mode=${this._mode}, toggleButtons=${this._toggleButtons.length}, ` +
			`trailingSet=${!!this._trailingBreadcrumbsContent}, inlineBar=${!!this._inlineToggleBar}, ` +
			`webviewMounted=${!!this._webview}, rawHtmlLen=${this._rawHtml?.length ?? 0}`,
		);
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

		// For a virtual preview input the code editor has no text model yet
		// (we bypassed super.setInput).  Lazily attach a standalone read-only
		// model populated from the resolved HTML so the "HTML" (source) mode
		// has content to display.  Standard `.html` files already have a model
		// via super.setInput, so this is skipped for them.
		if (mode === 'source' && control && !control.getModel() && this._isPreviewInput) {
			if (!this._previewInputSourceModel) {
				const languageSelection = this._languageService.createById('html');
				this._previewInputSourceModel = this._modelService.createModel(
					this._rawHtml ?? '',
					languageSelection,
					undefined,
					true,
				);
			}
			control.setModel(this._previewInputSourceModel ?? null);
		}

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

		// 从文件路径提取 agentId: ~/.saros/agents/{agentId}/config.html
		const path = resource?.fsPath ?? '';
		const agentMatch = path.match(/[\\/]agents[\\/]([^\\/]+)[\\/]/i);
		this._previewAgentId = agentMatch?.[1];
		this._logService.info(`[HtmlFileEditorPane] _ensurePreviewWebview: agentId=${this._previewAgentId || '<none>'} path=${path}`);

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

		this._register(this._webview.onMessage(async (e) => {
			const msg = e.message as { type?: string; message?: string; eventName?: string; requestId?: string; agentId?: string; level?: string; [key: string]: unknown } | undefined;
			if (!msg || !msg.type) return;
			const agentId = String(msg.agentId || this._previewAgentId || '');
			this._logService.info(`[HtmlFileEditorPane] preview onMessage: type=${msg.type} agentId=${agentId} msgLen=${typeof msg.message==='string'?msg.message.length:'n/a'}`);
			try {
				switch (msg.type) {
					case 'confightml.chatSend':
						if (!agentId) throw new Error('agentId 未识别（检查文件是否在 ~/.saros/agents/{id}/config.html 路径下）');
						await this._configHtmlService.handleChatSend(agentId, String(msg.message || ''));
						break;
					case 'confightml.event':
						await this._configHtmlService.handleHtmlEvent(agentId, String(msg.eventName || ''), msg.payload);
						break;
					case 'confightml.notify':
						this._logService.info(`[HtmlFileEditorPane] preview notify: ${msg.message} [${msg.level}]`);
						break;
					case 'confightml.runTerminal': {
						if (!agentId) throw new Error('agentId 未识别');
						const cmd = String(msg.command || '');
						const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
						const rtOptions = msg as unknown as { cwd?: string; env?: Record<string, string> };
						await this._configHtmlService.handleRunTerminal(agentId, cmd, args, { cwd: rtOptions.cwd, env: rtOptions.env });
						break;
					}
				}
				this._webview?.postMessage({ type: 'sdk.reply', requestId: msg.requestId, ok: true } as unknown as Record<string, unknown>);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				this._logService.error(`[HtmlFileEditorPane] preview handler error: type=${msg.type} agentId=${agentId} err=${errMsg}`);
				this._webview?.postMessage({ type: 'sdk.reply', requestId: msg.requestId, ok: false, error: errMsg } as unknown as Record<string, unknown>);
			}
		}));
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
	// `htmlEditor.syncContent` updates the in-memory model so switching
	// to source mode reflects live edits, but does NOT persist to disk.
	// Only explicit save (Ctrl+S / save button) triggers disk write.
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
	 * Write the edited HTML back into the text model and persist to disk
	 * immediately, so input field values typed in visual editor are saved
	 * when the user clicks the toolbar save button (or presses Ctrl+S).
	 */
	private _applyEditedHtml(html: string): void {
		this._logService.info(`[HtmlFileEditorPane] _applyEditedHtml: htmlLen=${html.length} _webviewExists=${!!this._webview}`);
		this._rawHtml = html;
		const control = this.getControl();
		const model = control?.getModel();
		if (model) {
			model.pushEditOperations([], [{
				range: model.getFullModelRange(),
				text: html,
			}], () => []);
			// Persist immediately — the visual editor's save button / Ctrl+S
			// should write to disk, not just update the buffer.
			// ITextModel.save() is not in the public TS interface but exists at runtime
			// on ITextFileModel (the backing implementation for file editors).
			if (typeof (model as any).save === 'function') {
				(model as any).save().catch((err: unknown) => this._logService.error('[HtmlFileEditorPane] model.save() failed:', err));
			}
		}
		// Refresh the preview webview (if mounted) so the latest HTML
		// shows up the next time the user switches to preview mode.
		if (this._webview) {
			this._logService.info('[HtmlFileEditorPane] _applyEditedHtml: refreshing preview webview');
			this._webview.setHtml(this._wrapHtmlForWebview(html));
		}
	}

	private _wrapHtmlForWebview(html: string): string {
		// ~/.saros 目录下的文件不受沙箱限制，vscode-file: 允许通过
		// file:// 协议访问本地资源（如 config.html 内嵌的 img / iframe / fetch）。
		const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; script-src 'unsafe-inline' 'unsafe-eval' https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; img-src 'self' data: https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; font-src data: https: vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; connect-src https: http://127.0.0.1:* http://localhost:* vscode-resource: vscode-webview-resource: vscode-webview: vscode-file:; frame-src https: vscode-webview: vscode-file:;">`;
		const baseStyle = `<style>html,body{margin:0;padding:0;}body{background:#ffffff;color:#1e1e1e;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;}@media (prefers-color-scheme: dark){body{background:#1e1e1e;color:#d4d4d4;}}</style>`;
		// 预览模式强制隐藏编辑器 runtime chrome——无论源 HTML 是否嵌入了
		// toolbar / add-btn / add-menu（如编辑模式保存后的残留），也移除
		// html-edit-mode 类避免影响页面交互。
		const cleanup = `<style>#html-edit-toolbar,#html-edit-add-btn,#html-edit-add-menu{display:none!important}body.html-edit-mode{cursor:auto!important}</style><script>(function(){document.body&&document.body.classList.remove('html-edit-mode')})();</script>`;
		// 注入最小 AgentConfigHtml SDK：config.html 即使在预览 webview 中
		// 也能正常调用 chatSend / sendEvent / notify。chatSendStream 暂不
		// 支持（预览 webview 没有 delta event relay pipeline）。
		// SDK 用纯字符串拼接，避免 TS 模板字面量在多行 minified JS 场景下出问题。
		const sdk = // prettier-ignore
			'<script>console.log("[AgentConfigHtml SDK] tag-1")</script>' +
			'<script>console.log("[AgentConfigHtml SDK] tag-2");' +
			'!function(g){var p=new Map,l={};var v=acquireVsCodeApi();' +
			'function log(m){try{console.log("[AgentConfigHtml SDK]",m)}catch(e){}}' +
			'function id(){return"sdk_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8)}' +
			'function s(t,d){var r=id();log("send "+t+" rid="+r);return new Promise(function(res,rej){p.set(r,{resolve:res,reject:rej});' +
			'v.postMessage(Object.assign({type:t,requestId:r},d||{}));' +
			'setTimeout(function(){if(p.has(r)){p.delete(r);rej(new Error("timeout "+t))}},30000)})}' +
			'window.addEventListener("message",function(e){var m=e.data;' +
			'if(!m||typeof m!=="object")return;' +
			'if(m.type==="sdk.reply"&&m.requestId&&p.has(m.requestId)){var h=p.get(m.requestId);p.delete(m.requestId);' +
			'log("reply rid="+m.requestId+" ok="+m.ok+" err="+(m.error||""));' +
			'if(m.ok)h.resolve(m.data);else h.reject(new Error(m.error||"err"))}' +
			'});var a={on:function(ev,fn){l[ev]=l[ev]||[];l[ev].push(fn);return a},' +
			'sendEvent:function(n,d){return s("confightml.event",{eventName:n,payload:d})},' +
			'chatSend:function(msg,o){return s("confightml.chatSend",Object.assign({message:msg},o||{}))},' +
			'notify:function(msg,lv){return s("confightml.notify",{message:msg,level:lv||"info"})},' +
			'runTerminal:function(cmd,args,o){return s("confightml.runTerminal",Object.assign({command:cmd,args:args||[]},o||{}))}};' +
			'g.AgentConfigHtml={connect:function(){log("connect ok");return Promise.resolve(a)},isConnected:function(){return true},' +
			'on:function(ev,fn){return a.on(ev,fn)},sendEvent:function(n,d){return a.sendEvent(n,d)},' +
			'chatSend:function(msg,o){return a.chatSend(msg,o)},notify:function(m,l){return a.notify(m,l)},' +
			'runTerminal:function(cmd,args,o){return a.runTerminal(cmd,args,o)}}}(window);</script>';

		const sdkWrapper = `<script>console.log('[HtmlFileEditorPane] preview SDK injected, type tag present')</script>` + sdk;

		const lower = html.toLowerCase();
		const headIdx = lower.indexOf('<head>');

		if (headIdx >= 0) {
			const insertPos = headIdx + '<head>'.length;
			// SDK 必须在 <head> 之后立即注入，确保用户脚本执行前
			// window.AgentConfigHtml 已定义。
			return html.slice(0, insertPos) + csp + baseStyle + cleanup + sdkWrapper + html.slice(insertPos);
		}

		const htmlIdx = lower.indexOf('<html');
		if (htmlIdx >= 0) {
			const closeBracket = html.indexOf('>', htmlIdx);
			if (closeBracket >= 0) {
				return html.slice(0, closeBracket + 1) + `<head>${csp}${baseStyle}${cleanup}${sdkWrapper}</head>` + html.slice(closeBracket + 1);
			}
		}

		return `<!doctype html><html><head>${csp}${baseStyle}${cleanup}${sdkWrapper}</head><body>${html}</body></html>`;
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
	 *
	 * If the trailing-breadcrumbs container is not available (e.g. the group
	 * uses `showTabs: 'single'` which skips breadcrumb container creation, or
	 * breadcrumbs are disabled), falls back to rendering an inline toggle bar
	 * inside the editor pane's DOM.
	 */
	private _setupTrailingBreadcrumbsContent(): void {
		// Clear any existing toggle (breadcrumbs or inline fallback).
		this._cleanupTrailingBreadcrumbsContent();

		const container = this._createTrailingBreadcrumbsContent();

		// Attempt 1: use the group's trailing-breadcrumbs slot (the ideal
		// location — sits next to the file path breadcrumb).
		try {
			this.group.setTrailingBreadcrumbsContent(container);
		} catch (err) {
			this._logService.warn('[HtmlFileEditorPane] setTrailingBreadcrumbsContent threw:', err);
		}

		// IMPORTANT: `setTrailingBreadcrumbsContent` can *silently* do nothing:
		//   - when the group has no breadcrumbs-trailing container (e.g.
		//     `showTabs === 'single'`, see editorTitleControl.ts
		//     `createBreadcrumbsControl` which returns `undefined` and never
		//     creates `breadcrumbsTrailingContainer`); in that case the call
		//     returns without appending anything → `container.parentElement`
		//     stays `null`.
		//   - or it DOES append the element, but the whole breadcrumbs row is
		//     hidden because breadcrumbs are disabled → the element is
		//     connected but `display:none` (invisible to the user).
		// In BOTH cases we must fall back to an inline overlay instead of
		// assuming the embed succeeded.
		const embedded =
			container.parentElement !== null &&
			container.isConnected &&
			getComputedStyle(container).display !== 'none';

		if (embedded) {
			this._trailingBreadcrumbsContent = container;
			this._logService.info('[HtmlFileEditorPane] toggle: installed into trailing breadcrumbs successfully');
			return;
		}

		this._logService.info('[HtmlFileEditorPane] trailing breadcrumbs unavailable/invisible — using inline fallback');
		this._installInlineToggleBar(container);
	}

	/**
	 * Clean up the trailing breadcrumbs content. Detaches the element from
	 * the editor group and clears the local button references so the next
	 * setInput can rebuild from scratch.
	 */
	private _cleanupTrailingBreadcrumbsContent(): void {
		if (this._trailingBreadcrumbsContent) {
			try {
				this.group.setTrailingBreadcrumbsContent(undefined);
			} catch { /* ignore */ }
			this._trailingBreadcrumbsContent = undefined;
		}
		// Also remove inline fallback if present.
		if (this._inlineToggleBar) {
			this._inlineToggleBar.remove();
			this._inlineToggleBar = undefined;
		}
		this._toggleButtons = [];
	}

	/**
	 * Render the toggle bar as an absolutely-positioned overlay inside the
	 * editor pane's DOM (used when trailing breadcrumbs are unavailable).
	 */
	private _installInlineToggleBar(container: HTMLElement): void {
		container.className = 'html-file-mode-toggle html-file-mode-toggle-inline';
		container.style.position = 'absolute';
		container.style.top = '4px';
		container.style.right = '8px';
		container.style.zIndex = '5';
		container.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		container.style.border = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.12))';
		container.style.borderRadius = '4px';
		container.style.padding = '2px';
		container.style.boxShadow = '0 2px 6px rgba(0,0,0,0.25)';

		// Append to the pane's root container (set by create(parent) — always
		// available by the time setInput runs, unlike `_editorContainer` which
		// is only created in createEditorControl and may not exist yet when
		// setInput is invoked).  This is the reliable fallback mount point
		// when the trailing-breadcrumbs slot is unavailable.
		const parent = this.getContainer();
		if (parent) {
			// The overlay is absolutely positioned; make sure its containing
			// block is this pane instance, otherwise it would resolve against
			// a more distant positioned ancestor and render in the wrong place.
			if (getComputedStyle(parent).position === 'static') {
				parent.style.position = 'relative';
			}
			parent.appendChild(container);
			this._logService.info('[HtmlFileEditorPane] toggle: inline fallback mounted into pane root container');
			this._inlineToggleBar = container;
		} else {
			this._logService.warn('[HtmlFileEditorPane] _installInlineToggleBar: no parent to attach');
			// Still keep references so _updateToggleButtonStyles works.
			this._inlineToggleBar = container;
		}
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
		// Dispose the standalone source-model used by preview inputs.
		if (this._previewInputSourceModel) {
			this._previewInputSourceModel.dispose();
			this._previewInputSourceModel = undefined;
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
		this._isPreviewInput = false;
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
		if (this._previewInputSourceModel) {
			this._previewInputSourceModel.dispose();
			this._previewInputSourceModel = undefined;
		}
		super.dispose();
	}
}

