/*---------------------------------------------------------------------------------------------
 *  [Sarosis 2026-07-04] MdFileEditorPane — TextFileEditor with a 2-mode segmented
 *  toggle (预览 / Markdown) for `.md` files, displayed in the editor group's
 *  trailing breadcrumbs.
 *
 *  Modes:
 *   - **preview** (default): a webview rendering the markdown via VSCode's
 *     native `renderMarkdownDocument` (syntax-highlighted code blocks, VSCode
 *     theme variables, proper GFM heading anchors).
 *   - **markdown**: the standard CodeEditorWidget for editing raw markdown.
 *
 *  For non-MD files the pane behaves identically to TextFileEditor.
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
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { renderMarkdownDocument, DEFAULT_MARKDOWN_STYLES } from '../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Dimension } from '../../../../base/browser/dom.js';

/**
 * Two modes: preview (rendered HTML in a webview) or markdown (source code).
 */
type MdMode = 'preview' | 'markdown';

export class MdFileEditorPane extends TextFileEditor {

	override getId(): string {
		return 'agentStudio.mdFileEditor';
	}

	static readonly TOGGLE_MODE_ACTION_ID = 'agentStudio.mdFile.toggleMode';

	private _editorContainer: HTMLElement | undefined;
	private _previewContainer: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	private _rawMd: string | undefined;
	private _mode: MdMode = 'preview';
	private _isMd: boolean = false;

	private _trailingBreadcrumbsContent: HTMLElement | undefined;
	private _toggleButtons: { el: HTMLElement; mode: MdMode }[] = [];

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
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super(group, telemetryService, fileService, paneCompositeService, instantiationService, contextService,
			storageService, textResourceConfigurationService, editorService, themeService, editorGroupService,
			textFileService, explorerService, uriIdentityService, pathService, configurationService,
			preferencesService, hostService, filesConfigurationService);
	}

	// ─── Layout ──────────────────────────────────────────────────────────

	protected override createEditorControl(parent: HTMLElement, initialOptions: ICodeEditorOptions): void {
		parent.style.position = 'relative';

		this._editorContainer = document.createElement('div');
		this._editorContainer.style.position = 'absolute';
		this._editorContainer.style.inset = '0';
		parent.appendChild(this._editorContainer);

		this._previewContainer = document.createElement('div');
		this._previewContainer.style.position = 'absolute';
		this._previewContainer.style.inset = '0';
		this._previewContainer.style.display = 'none';
		this._previewContainer.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		parent.appendChild(this._previewContainer);

		mark('code/willCreateTextFileEditorControl');
		super.createEditorControl(this._editorContainer, initialOptions);
		mark('code/didCreateTextFileEditorControl');
	}

	override async setInput(input: FileEditorInput, options: IFileEditorInputOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const resource = input.resource;
		const lower = resource.path.toLowerCase();
		this._isMd = lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdown') || lower.endsWith('.mkdn');

		if (this._isMd) {
			const control = this.getControl();
			const model = control?.getModel();
			this._rawMd = model?.getValue() ?? '';
			this._setupTrailingBreadcrumbsContent();
		} else {
			this._rawMd = undefined;
			this._cleanupTrailingBreadcrumbsContent();
		}

		this._setMode('preview', /* force */ true);
	}

	get currentMode(): MdMode { return this._mode; }

	setMode(mode: MdMode): void { this._setMode(mode); }

	private _setMode(mode: MdMode, force: boolean = false): void {
		if (this._mode === mode && !force) { return; }
		this._mode = mode;

		if (this._editorContainer) {
			this._editorContainer.style.display = mode === 'preview' ? 'none' : '';
		}
		if (this._previewContainer) {
			this._previewContainer.style.display = mode === 'preview' ? '' : 'none';
		}

		const control = this.getControl();
		if (control) {
			// 预览（渲染）模式只读；Markdown（源码）模式必须可编辑
			control.updateOptions({ readOnly: mode === 'preview' && this._isMd });
		}

		if (mode === 'preview') {
			this._ensurePreviewWebview();
		}

		this._updateToggleButtonStyles();
	}

	private async _ensurePreviewWebview(): Promise<void> {
		if (!this._previewContainer) { return; }

		const html = await this._renderMdToHtml(this._rawMd ?? '');

		if (this._webview) {
			this._webview.setHtml(html);
			return;
		}

		this._webview = this._webviewService.createWebviewElement({
			title: 'Markdown Preview',
			options: { enableFindWidget: true, retainContextWhenHidden: true },
			contentOptions: {
				allowScripts: false,
				allowForms: false,
				localResourceRoots: [],
			},
			extension: undefined,
		});

		this._register(this._webview);
		this._webview.mountTo(this._previewContainer, mainWindow);
		this._webview.setHtml(html);
	}

	// ─── Markdown → HTML (VSCode native renderer) ─────────────────────────

	private async _renderMdToHtml(md: string): Promise<string> {
		try {
			// [Sarosis 2026-07-04] YAML frontmatter is preserved and rendered
			// as a styled code-ish block (monospace, subtle background) so the
			// user can inspect the metadata. The block is assembled BEFORE the
			// native renderer runs so that the underlying `marked` parser never
			// sees the `---...---` delimiters (which it would mis-parse as
			// horizontal rule + setext h2 heading).
			const { body, frontmatterHtml } = MdFileEditorPane._splitFrontmatter(md);

			const trusted = await renderMarkdownDocument(
				body,
				this._extensionService,
				this._languageService,
			);
			const renderedBody = trusted.toString();
			return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${DEFAULT_MARKDOWN_STYLES}
/* vssaros-frontmatter — preserved YAML metadata block */
.vssaros-frontmatter {
	margin: 12px 0 20px;
	padding: 12px 16px;
	background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
	border-radius: 6px;
	font: 12px/1.6 var(--vscode-editor-font-family, "SF Mono", Monaco, Menlo, Consolas, monospace);
	color: var(--vscode-editor-foreground, inherit);
	white-space: pre-wrap;
	word-break: break-word;
	overflow-x: auto;
}
</style>
</head><body>
${frontmatterHtml}${renderedBody}
</body></html>`;
		} catch (err) {
			this._logService.warn('[MdFileEditorPane] renderMarkdownDocument failed:', err);
			const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			return `<!doctype html><html><head><meta charset="utf-8"></head><body><pre style="padding:20px;font:14px/1.5 monospace">${escaped}</pre></body></html>`;
		}
	}

	/**
	 * Split the markdown into a rendered frontmatter block (if present) and
	 * the remaining body. The frontmatter block `---\n...\n---` is extracted
	 * and rendered as `<pre class="vssaros-frontmatter">` so it's visible
	 * but visually distinct from standard code blocks. Returns `{ body,
	 * frontmatterHtml }` where `frontmatterHtml` is empty string when no
	 * frontmatter is detected.
	 */
	private static _splitFrontmatter(md: string): { body: string; frontmatterHtml: string } {
		const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md);
		if (!match) {
			return { body: md, frontmatterHtml: '' };
		}
		const frontmatter = match[1];
		const body = md.slice(match[0].length);
		// Escape for safe HTML embedding; preserve leading whitespace.
		const escaped = frontmatter
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
		return {
			body,
			frontmatterHtml: `<pre class="vssaros-frontmatter">${escaped}</pre>\n`,
		};
	}

	// ─── Trailing-breadcrumbs toggle (预览 / Markdown) ────────────────────

	private _setupTrailingBreadcrumbsContent(): void {
		this._cleanupTrailingBreadcrumbsContent();
		this._trailingBreadcrumbsContent = this._createTrailingBreadcrumbsContent();
		this.group.setTrailingBreadcrumbsContent(this._trailingBreadcrumbsContent);
	}

	private _cleanupTrailingBreadcrumbsContent(): void {
		if (this._trailingBreadcrumbsContent) {
			this.group.setTrailingBreadcrumbsContent(undefined);
			this._trailingBreadcrumbsContent = undefined;
		}
		this._toggleButtons = [];
	}

	private _createTrailingBreadcrumbsContent(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'md-file-mode-toggle';
		container.style.display = 'inline-flex';
		container.style.alignItems = 'center';
		container.style.gap = '0';
		container.style.whiteSpace = 'nowrap';

		const labels: { label: string; mode: MdMode }[] = [
			{ label: '预览', mode: 'preview' },
			{ label: 'Markdown', mode: 'markdown' },
		];

		this._toggleButtons = [];

		for (let i = 0; i < labels.length; i++) {
			const { label, mode } = labels[i];
			const btn = document.createElement('a');
			btn.classList.add('md-file-seg-btn');
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
				this._setMode(mode);
			}));

			container.appendChild(btn);
			this._toggleButtons.push({ el: btn, mode });
		}

		this._updateToggleButtonStyles();
		return container;
	}

	private _updateToggleButtonStyles(): void {
		if (!this._toggleButtons) { return; }
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

	override layout(dimension: Dimension): void {
		super.layout(dimension);
	}

	override clearInput(): void {
		if (this._webview) { this._webview.dispose(); this._webview = undefined; }
		if (this._previewContainer) { DOM.clearNode(this._previewContainer); }
		this._cleanupTrailingBreadcrumbsContent();
		this._rawMd = undefined;
		this._mode = 'preview';
		this._isMd = false;
		super.clearInput();
	}

	override dispose(): void {
		if (this._webview) { this._webview.dispose(); this._webview = undefined; }
		super.dispose();
	}
}
