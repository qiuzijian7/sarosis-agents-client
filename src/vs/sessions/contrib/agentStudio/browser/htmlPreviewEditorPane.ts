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
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IAgentStudioService, IConfigHtmlService } from '../common/agentStudio.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { wrapHtmlWithEditorRuntime } from './htmlEditorRuntime.js';

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

	/**
	 * Action id registered in `MenuId.EditorTitle` (see
	 * `agentStudio.contribution.ts`). The editor toolbar is populated from
	 * that menu — NOT from `Composite.getActions()` — so the toggle must be a
	 * registered menu action. The pane's `getActionViewItem` returns a custom
	 * segmented view item for this action id.
	 */
	static readonly TOGGLE_MODE_ACTION_ID = 'agentStudio.htmlPreview.toggleMode';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	/**
	 * Dedicated mount target for the preview webview. Kept separate from the
	 * source-view container so toggling modes only flips `display` without
	 * destroying/recreating the webview iframe.
	 */
	private _webviewMount: HTMLElement | undefined;
	/** Scrollable container holding the HTML source view with syntax highlighting. */
	private _sourceContainer: HTMLElement | undefined;
	/** Embedded Monaco editor for HTML source with syntax highlighting & editing. */
	private _sourceEditor: CodeEditorWidget | undefined;
	/** The text model for the source editor. Kept as a field so it survives
	 * container display:none toggles without being disposed. */
	private _sourceModel: ITextModel | undefined;
	/** Tracks content changes so we don't trigger recursive updates. */
	private _sourceEditorUpdating = false;
	/** Container for the edit-mode webview (visual editor). */
	private _editWebviewContainer: HTMLElement | undefined;
	/** Edit-mode webview — renders the HTML with injected editor runtime. */
	private _editWebview: IWebviewElement | undefined;
	/** Raw (un-wrapped) HTML captured at setInput time; shown in source mode. */
	private _rawHtml: string | undefined;
	/** Current view mode — 'edit' (visual editor), 'source' (HTML), 'preview' (rendered). */
	private _mode: 'edit' | 'source' | 'preview' = 'preview';
	/** Resolved at setInput time; used to filter inbound imgui command pushes. */
	private _currentAgentId: string | undefined;
	/**
	 * Captured at preview-open time from the chat panel. Forwarded into the
	 * preview's imgui SDK and re-attached to every imgui.submit so the host
	 * can route the chat send to the EXACT (workspace, fork session, agent
	 * session) the user was looking at when they opened the preview —
	 * instead of relying on the chat panel's current state, which may have
	 * moved on.
	 */
	private _currentWorkspaceId: string | undefined;
	private _currentWorkspaceSessionId: string | undefined;
	private _currentAgentSessionId: string | undefined;
	/** Trailing breadcrumbs content container (toggle buttons). */
	private _trailingBreadcrumbsContent: HTMLElement | undefined;
	/** Toggle buttons for mode switching. */
	private _toggleButtons: { el: HTMLElement; mode: 'edit' | 'source' | 'preview' }[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IConfigHtmlService private readonly _configHtmlService: IConfigHtmlService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super(HtmlPreviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		// Main container for webview/source/edit.
		this._container = document.createElement('div');
		this._container.classList.add('agent-studio-html-preview-pane');
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.overflow = 'hidden';
		// VS Code default light/dark backdrop so a still-loading preview does
		// not show the surrounding editor's black/empty background.
		this._container.style.background = 'var(--vscode-editor-background, #1e1e1e)';

		// Preview webview mount target — the iframe lives here.
		this._webviewMount = document.createElement('div');
		this._webviewMount.style.position = 'absolute';
		this._webviewMount.style.inset = '0';
		this._container.appendChild(this._webviewMount);

		// Source code view — embedded Monaco editor with HTML syntax
		// highlighting. Created lazily on first switch to source mode.
		this._sourceContainer = document.createElement('div');
		this._sourceContainer.className = 'agent-studio-html-source-view';
		this._sourceContainer.style.position = 'absolute';
		this._sourceContainer.style.inset = '0';
		this._sourceContainer.style.overflow = 'visible';
		this._sourceContainer.style.display = 'none';
		this._sourceContainer.style.background = 'var(--vscode-editor-background, #1e1e1e)';

		this._container.appendChild(this._sourceContainer);

		// Edit-mode visual editor container — holds a webview with injected
		// editor runtime (drag, resize, RTE, undo/redo). Initially hidden;
		// shown when mode === 'edit'.
		this._editWebviewContainer = document.createElement('div');
		this._editWebviewContainer.className = 'agent-studio-html-edit-view';
		this._editWebviewContainer.style.position = 'absolute';
		this._editWebviewContainer.style.inset = '0';
		this._editWebviewContainer.style.display = 'none';
		this._editWebviewContainer.style.background = '#ffffff';
		this._container.appendChild(this._editWebviewContainer);

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

		// Always (re)start in preview mode for a fresh input — the user may
		// have been viewing source on the previous input.
		this._mode = 'preview';
		if (this._webviewMount) {
			this._webviewMount.style.display = '';
		}
		if (this._sourceContainer) {
			this._sourceContainer.style.display = 'none';
		}

		try {
			let html: string;
			// saros-html-preview scheme has no file system provider —
			// get HTML from IConfigHtmlService instead of reading from disk.
			if (input.resource.scheme === 'saros-html-preview') {
				const agentId = input.agentId ?? input.resource.path.replace(/^\//, '');
				const result = await this._configHtmlService.renderHtml(agentId);
				html = result.html;
			} else {
				const buf = await this._fileService.readFile(input.resource);
				html = buf.value.toString();
			}
			if (token.isCancellationRequested) {
				return;
			}

			// Keep the raw HTML so the "源码" toolbar toggle can display it
			// without re-fetching.
			this._rawHtml = html;

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

			// Resolve the owning agent up-front. Prefer the value carried
			// by the EditorInput (set by ConfigMD's preview button which
			// already knows which agent owns it). Fall back to reverse-
			// engineering it from the file path so direct file opens still
			// work, but the input route is preferred and the only one that
			// works for in-memory / global workspaces.
			this._logService.info(`[HtmlPreviewEditorPane] setInput: input.agentId='${input.agentId}' workspaceId='${input.workspaceId}' workspaceSessionId='${input.workspaceSessionId}' agentSessionId='${input.agentSessionId}' resource=${input.resource.toString()}`);
			this._currentAgentId = input.agentId
				?? await this._resolveAgentIdFromUri(input.resource);
			this._currentWorkspaceId = input.workspaceId;
			this._currentWorkspaceSessionId = input.workspaceSessionId;
			this._currentAgentSessionId = input.agentSessionId;
			this._logService.info(`[HtmlPreviewEditorPane] resolved agentId='${this._currentAgentId}' for ${input.resource.toString()}`);

			// Rename the tab to "{agentName}_html" once the owning agent is
			// known. Best-effort & non-blocking: the initial placeholder title
			// is shown until this resolves.
			this._updateTabTitle(input);

			// Forward `imgui.submit` (and other future imgui-style events)
			// from the preview SDK back to ConfigHtmlService.handleHtmlEvent.
			//
			// We re-attach the captured (workspaceId, agentSessionId) to
			// every submit payload here on the host side: the SDK script
			// itself doesn't know about workspaces, and we want the routing
			// info to come from a trusted source (this pane's input) rather
			// than from JS running in the webview content.
			this._register(this._webview.onMessage(async (e) => {
				const m = e.message as { type?: string; payload?: unknown } | undefined;
				this._logService.info(`[HtmlPreviewEditorPane] preview-webview.onMessage: type=${m?.type ?? 'undefined'}`);
				if (!m || typeof m.type !== 'string') { return; }
				if (m.type !== 'imgui.submit') { return; }
				try {
					const agentId = this._currentAgentId
						?? await this._resolveAgentIdFromUri(input.resource);
					if (!agentId) {
						this._logService.warn(`[HtmlPreviewEditorPane] could not resolve agentId from ${input.resource.toString()}`);
						return;
					}
					// Augment payload with the captured ctx so the service
					// can route the eventual chat.send into the right session.
					const enriched = {
						...(typeof m.payload === 'object' && m.payload !== null ? m.payload as Record<string, unknown> : {}),
						_ctx: {
							agentId,
							workspaceId: this._currentWorkspaceId,
							workspaceSessionId: this._currentWorkspaceSessionId,
							agentSessionId: this._currentAgentSessionId,
						},
					};
					await this._configHtmlService.handleHtmlEvent(agentId, m.type, enriched, this._currentAgentSessionId);
				} catch (err) {
					this._logService.error(`[HtmlPreviewEditorPane] handleHtmlEvent failed:`, err);
				}
			}));

			// Push host → preview commands. ConfigHtmlService dispatches these
			// via its onDidEmitCommand event for any agentId; we filter
			// to the currently-loaded preview's agent.
			this._register(this._configHtmlService.onDidEmitCommand(({ agentId, command }) => {
				if (!this._webview) { return; }
				if (this._currentAgentId && agentId !== this._currentAgentId) { return; }
				if (!command?.name || !command.name.startsWith('imgui.')) { return; }
				this._logService.info(`[HtmlPreviewEditorPane] forwarding imgui command to preview webview: ${command.name}`);
				const payload = { type: command.name, ...(command.params || {}) };
				void this._webview.postMessage(payload);
			}));

			// Direct DOM mount — this is the path that works on this fork's
			// Chromium build, identical to how the chat panel mounts itself.
			// Mount into the dedicated webview mount target (not the whole
			// container) so toggling to source mode only hides the iframe
			// instead of destroying it.
			this._webview.mountTo(this._webviewMount ?? this._container!, mainWindow);
			this._webview.setHtml(wrappedHtml);
			this._logService.info(`[HtmlPreviewEditorPane] mounted preview for ${resourceKey} (${wrappedHtml.length} chars)`);

			// Push initial ctx to the SDK so any client-side logic can
			// inspect it (e.g. show a session badge, gate features). The
			// SDK echoes the ctx back on every imgui.submit, which is
			// useful for diagnostics; the host-side `onMessage` above also
			// re-attaches ctx independently as a trust anchor.
			void this._webview.postMessage({
				type: 'imgui.ctx',
				agentId: this._currentAgentId,
				workspaceId: this._currentWorkspaceId,
				workspaceSessionId: this._currentWorkspaceSessionId,
				agentSessionId: this._currentAgentSessionId,
			});

			// Set up trailing breadcrumbs content (mode toggle buttons).
			this._setupTrailingBreadcrumbsContent();
		} catch (err) {
			this._logService.error(`[HtmlPreviewEditorPane] failed to load ${resourceKey}:`, err);
			// Clear only the webview mount target so the (hidden) source view
			// container survives for a potential retry.
			if (this._webviewMount) {
				DOM.clearNode(this._webviewMount);
			}
			if (this._container) {
				const errorEl = document.createElement('div');
				errorEl.style.position = 'absolute';
				errorEl.style.inset = '0';
				errorEl.style.padding = '20px';
				errorEl.style.color = 'var(--vscode-errorForeground, #f48771)';
				errorEl.style.fontFamily = 'sans-serif';
				errorEl.textContent = `预览加载失败: ${err instanceof Error ? err.message : String(err)}`;
				this._webviewMount?.appendChild(errorEl);
			}
		}
	}

	/**
	 * Set up the trailing breadcrumbs content (mode toggle buttons).
	 * Creates the toggle buttons container and sets it on the editor group.
	 */
	private _setupTrailingBreadcrumbsContent(): void {
		// Clear any existing trailing content.
		this._cleanupTrailingBreadcrumbsContent();

		// Create the toggle buttons container.
		this._trailingBreadcrumbsContent = this._createTrailingBreadcrumbsContent();

		// Set it as the trailing breadcrumbs content on the editor group.
		this.group.setTrailingBreadcrumbsContent(this._trailingBreadcrumbsContent);
	}

	/**
	 * Clean up the trailing breadcrumbs content.
	 */
	private _cleanupTrailingBreadcrumbsContent(): void {
		if (this._trailingBreadcrumbsContent) {
			this.group.setTrailingBreadcrumbsContent(undefined);
			this._trailingBreadcrumbsContent = undefined;
		}
		this._toggleButtons = [];
	}

	override layout(dimension: DOM.Dimension): void {
		const hasSourceEditor = !!this._sourceEditor;
		if (hasSourceEditor) {
			const domNode = this._sourceEditor!.getDomNode();
			this._logService.info(`[HtmlPreviewEditorPane] layout: ${dimension.width}x${dimension.height}, _sourceEditor=true, _mode=${this._mode}, domNode.children=${domNode?.childElementCount}, domNode.display=${domNode ? window.getComputedStyle(domNode).display : 'n/a'}`);
		} else {
			this._logService.info(`[HtmlPreviewEditorPane] layout: ${dimension.width}x${dimension.height}, _sourceEditor=false, _mode=${this._mode}`);
		}
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		// Forward layout to the source editor so it resizes with the pane
		if (this._sourceEditor) {
			this._sourceEditor.layout();
		}
		// IWebviewElement automatically tracks its container's bounding box,
		// so no explicit per-frame size update is needed (unlike chat panel's
		// AgentStudioWebviewController.layout, which forwards dims to React).
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
	 * Switch between edit (visual editor), source (HTML), and preview modes.
	 * Toggling only flips `display` — webview iframes are kept alive so
	 * switching back is instant and retains state.
	 *
	 * Note: the toolbar view item is stateless and pulls the current mode on
	 * render, so we don't need to notify it after `_setMode` — the action
	 * bar re-queries `getActionViewItem` on the next layout pass.
	 */
	private _setMode(mode: 'edit' | 'source' | 'preview'): void {
		this._logService.warn(`[HtmlPreviewEditorPane] _setMode: from=${this._mode} to=${mode}, stack=${new Error().stack?.split('\n').slice(2, 5).join(' <- ')}`);
		if (this._mode === mode) {
			this._logService.info(`[HtmlPreviewEditorPane] _setMode: same mode, returning early`);
			return;
		}
		this._mode = mode;

		// Toggle container visibility
		if (this._webviewMount) {
			this._webviewMount.style.display = mode === 'preview' ? '' : 'none';
		}
		if (this._sourceContainer) {
			this._sourceContainer.style.display = mode === 'source' ? '' : 'none';
			this._logService.info(`[HtmlPreviewEditorPane] _setMode: _sourceContainer display set to "${this._sourceContainer.style.display}", offsetWidth=${this._sourceContainer.offsetWidth}, offsetHeight=${this._sourceContainer.offsetHeight}`);
		}
		if (this._editWebviewContainer) {
			this._editWebviewContainer.style.display = mode === 'edit' ? '' : 'none';
		}

		// Lazily create the source editor on first switch.
		// IMPORTANT: the container was just set to display='' but the
		// browser has NOT reflowed yet — offsetHeight is still 0. The
		// CodeEditorWidget needs non-zero dimensions to create its view
		// layer (the `.monaco-editor` DOM tree). We must defer creation
		// to the next rAF when the container has real dimensions.
		if (mode === 'source') {
			this._logService.info(`[HtmlPreviewEditorPane] _setMode source: scheduling rAF for _ensureSourceEditor`);
			requestAnimationFrame(() => {
				this._logService.info(`[HtmlPreviewEditorPane] rAF callback fired: _sourceContainer=${!!this._sourceContainer} offsetW=${this._sourceContainer?.offsetWidth} offsetH=${this._sourceContainer?.offsetHeight}`);
				// Force reflow to get the real container dimensions
				void this._sourceContainer?.offsetHeight;
				this._ensureSourceEditor();
				this._updateSourceEditorContent();
				if (this._sourceEditor) {
					this._sourceEditor.layout();
				} else {
					this._logService.warn(`[HtmlPreviewEditorPane] _sourceEditor is undefined after _ensureSourceEditor!`);
				}
			});
		}

		// Lazily create the edit webview
		if (mode === 'edit') {
			this._ensureEditWebview();
		}

		// Update header toggle button styles
		this._updateToggleButtonStyles();
	}

	/**
	 * Create the edit/preview/HTML toggle buttons for the breadcrumbs
	 * trailing content area. Returns a container with the segmented buttons.
	 */
	private _createTrailingBreadcrumbsContent(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'html-preview-mode-toggle';
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
			btn.classList.add('html-preview-seg-btn');
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

			this._register(DOM.addDisposableListener(btn, DOM.EventType.CLICK, (e) => {
				DOM.EventHelper.stop(e, true);
				this._logService.info(`[HtmlPreviewEditorPane] toggle button clicked: mode=${mode}`);
				this._setMode(mode);
			}));

			container.appendChild(btn);
			this._toggleButtons.push({ el: btn, mode });
		}

		this._updateToggleButtonStyles();

		return container;
	}

	/** Update the visual state of the header toggle buttons. */
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

	/**
	 * Lazily create the embedded Monaco code editor for HTML source viewing.
	 * Uses the full CodeEditorWidget with HTML language mode for syntax
	 * highlighting and full editing support (undo/redo, find, etc.).
	 */
	private _ensureSourceEditor(): void {
		this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor enter: _sourceContainer=${!!this._sourceContainer} _sourceEditor=${!!this._sourceEditor} _sourceModel=${!!this._sourceModel}`);
		if (!this._sourceContainer) {
			this._logService.warn(`[HtmlPreviewEditorPane] _ensureSourceEditor: _sourceContainer is undefined, returning`);
			return;
		}

		// Create the CodeEditorWidget if it doesn't exist yet.
		if (!this._sourceEditor) {
			this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: creating new CodeEditorWidget`);
			const editorOptions = {
				readOnly: false,
				minimap: { enabled: false },
				lineNumbers: 'on',
				scrollBeyondLastLine: false,
				automaticLayout: false,
				occurrencesHighlight: 'off',
				tabSize: 4,
				glyphMargin: false,
				folding: true,
				lineDecorationsWidth: 0,
				lineNumbersMinChars: 3,
				renderLineHighlight: 'line',
				scrollbar: {
					useShadows: false,
					verticalScrollbarSize: 10,
					horizontalScrollbarSize: 10,
					vertical: 'auto',
					horizontal: 'auto',
				},
			};

			this._sourceEditor = this._instantiationService.createInstance(
				CodeEditorWidget,
				this._sourceContainer,
				editorOptions as any,
				{}, // use full widget (not simple) for proper theme support
			);

			this._register(this._sourceEditor);

			// 监听 _sourceContainer 的子节点变化，抓谁清空了 Monaco DOM
			const containerObserver = new MutationObserver((mutations) => {
				for (const m of mutations) {
					if (m.type === 'childList' && m.removedNodes.length > 0) {
						this._logService.warn(`[HtmlPreviewEditorPane] _sourceContainer child REMOVED — ${m.removedNodes.length} nodes removed, remaining children=${this._sourceContainer?.childElementCount}`, new Error('Stack trace'));
					}
				}
			});
			if (this._sourceContainer) {
				containerObserver.observe(this._sourceContainer, { childList: true });
				this._register({ dispose: () => containerObserver.disconnect() });
			}

			// Sync edits back to _rawHtml so they propagate to preview/edit modes
			this._register(this._sourceEditor.onDidChangeModelContent(() => {
				if (this._sourceEditor && !this._sourceEditorUpdating && this._sourceModel) {
					const newVal = this._sourceModel.getValue();
					this._logService.info(`[HtmlPreviewEditorPane] onDidChangeModelContent: newVal.length=${newVal.length} _sourceEditorUpdating=${this._sourceEditorUpdating}`);
					this._rawHtml = newVal;
				}
			}));
			this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: CodeEditorWidget created`);
		}

		// Ensure the model exists and is attached to the editor.
		// The model may have been detached when the container was hidden.
		if (!this._sourceModel) {
			this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: creating model, _rawHtml.length=${this._rawHtml?.length ?? 'undefined'}`);
			const languageSelection = this._languageService.createById('html');
			this._sourceModel = this._modelService.createModel(
				this._rawHtml ?? '',
				languageSelection,
				URI.parse('inmemory://html-preview-source.html'),
				true,
			);
			// Register the model so it stays alive, then give it to the editor.
			// We keep the _sourceModel reference so we can re-attach it even
			// if the editor drops it during a display:none cycle.
			this._register(this._sourceModel);

			// 安全网：防止 textModelResolverService / WordHighlighter 等扩展销毁我们的 model
			this._sourceModel.onWillDispose(() => {
				this._logService.warn(`[HtmlPreviewEditorPane] _sourceModel onWillDispose fired! Model being destroyed externally.`);
			});

			this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: model created`);
		}

		// Always re-attach the model — if the editor lost its model reference
		// during a display:none cycle, this restores it.
		if (this._sourceEditor.getModel() !== this._sourceModel) {
			this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: attaching model to editor`);
			this._sourceEditor.setModel(this._sourceModel);
		} else {
			this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: model already attached`);
		}

		// Need TWO layout passes for the editor to render text properly:
		//   1) rAF layout after the container becomes visible (offsetWidth > 0)
		//   2) setTimeout layout to catch any delayed reflow
		requestAnimationFrame(() => {
			if (this._sourceEditor) {
				this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: rAF layout pass`);
				this._sourceEditor.layout();
				// Force the editor to re-render with a delayed second layout
				setTimeout(() => {
					if (this._sourceEditor && this._sourceEditor.getDomNode()) {
						this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: setTimeout layout pass (focus skipped)`);
						this._sourceEditor.layout();
						// DOM 状态检查（不主动 focus，让用户点选自然聚焦）
						const domNode = this._sourceEditor.getDomNode();
						const container = this._sourceContainer;
						this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor: DOM check — domNode.children=${domNode?.childElementCount} _sourceContainer.children=${container?.childElementCount} _sourceContainer.contains(domNode)=${domNode && container ? container.contains(domNode) : 'n/a'} model.getValue().length=${this._sourceModel?.getValue().length ?? 'no model'}`);
					} else {
						this._logService.warn(`[HtmlPreviewEditorPane] _ensureSourceEditor: setTimeout - no domNode!`);
					}
				}, 100);
			}
		});
		this._logService.info(`[HtmlPreviewEditorPane] _ensureSourceEditor exit`);
	}

	/** Update the source editor content from _rawHtml without triggering a content-changed loop. */
	private _updateSourceEditorContent(): void {
		this._logService.info(`[HtmlPreviewEditorPane] _updateSourceEditorContent enter: _sourceModel=${!!this._sourceModel} _rawHtml.length=${this._rawHtml?.length ?? 'undefined'}`);
		if (!this._sourceModel) {
			this._logService.warn(`[HtmlPreviewEditorPane] _updateSourceEditorContent: no model, returning`);
			return;
		}
		this._sourceEditorUpdating = true;
		try {
			const newValue = this._rawHtml ?? '';
			if (this._sourceModel.getValue() !== newValue) {
				this._logService.info(`[HtmlPreviewEditorPane] _updateSourceEditorContent: setting model value (${newValue.length} chars)`);
				this._sourceModel.setValue(newValue);
			} else {
				this._logService.info(`[HtmlPreviewEditorPane] _updateSourceEditorContent: model value unchanged`);
			}
		} finally {
			this._sourceEditorUpdating = false;
		}
		this._logService.info(`[HtmlPreviewEditorPane] _updateSourceEditorContent exit`);
	}

	/**
	 * Create or update the edit-mode webview that renders the HTML with the
	 * full editor runtime injected (drag, resize, RTE, undo/redo, save).
	 * When the user saves inside the webview, the cleaned HTML is posted
	 * back to the host via `htmlEditor.saveContent` message.
	 */
	private _ensureEditWebview(): void {
		if (!this._editWebviewContainer) {
			return;
		}

		// If the edit webview already exists, just refresh its HTML
		// and tell it to re-enter edit mode (setHtml doesn't re-execute
		// <script> tags, so we must postMessage to trigger edit mode).
		if (this._editWebview) {
			this._logService.warn('[HtmlPreviewEditorPane] _ensureEditWebview: REFRESHING existing edit webview (setHtml + enterEditMode)');
			this._editWebview.setHtml(wrapHtmlWithEditorRuntime(this._rawHtml ?? ''));
			// Give the webview a moment to process the new HTML,
			// then tell it to enter edit mode.
			setTimeout(() => {
				this._logService.info('[HtmlPreviewEditorPane] _ensureEditWebview: posting enterEditMode after setHtml');
				this._editWebview?.postMessage({ type: 'htmlEditor.enterEditMode' });
			}, 200);
			return;
		}

		const input = this.input;
		const resource = input?.resource;
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

		// Handle save/export/sync messages from the editor runtime
		this._register(this._editWebview.onMessage(async (e) => {
			const msg = e.message as { type?: string; html?: string } | undefined;
			if (!msg || !msg.type) {
				return;
			}
			this._logService.info(`[HtmlPreviewEditorPane] editWebview.onMessage: type=${msg.type} htmlLen=${typeof msg.html === 'string' ? msg.html.length : 'n/a'}`);
			if (msg.type === 'htmlEditor.syncContent') {
				if (typeof msg.html === 'string') {
					this._rawHtml = msg.html;
					this._updateSourceEditorContent();
				}
				return;
			}
			if (msg.type === 'htmlEditor.saveContent' || msg.type === 'htmlEditor.exportContent') {
				if (typeof msg.html === 'string') {
					this._logService.info('[HtmlPreviewEditorPane] calling _applyEditedHtml from saveContent');
					this._applyEditedHtml(msg.html);
				}
			}
		}));

		this._editWebview.mountTo(this._editWebviewContainer, mainWindow);
		this._editWebview.setHtml(wrapHtmlWithEditorRuntime(this._rawHtml ?? ''));
	}

	/**
	 * Write the edited HTML back — for HtmlPreviewEditorPane the source may
	 * come from ConfigHtmlService (saros-html-preview scheme) or a file.
	 * We update `_rawHtml` so switching to preview/source reflects edits.
	 */
	private _applyEditedHtml(html: string): void {
		this._logService.info(`[HtmlPreviewEditorPane] _applyEditedHtml: htmlLen=${html.length} _webviewExists=${!!this._webview}`);
		this._rawHtml = html;
		// Update the source editor if it exists
		this._updateSourceEditorContent();
		// If the preview webview exists, refresh it with the new HTML
		if (this._webview) {
			this._logService.info('[HtmlPreviewEditorPane] _applyEditedHtml: refreshing preview webview');
			this._webview.setHtml(this._wrapHtmlForWebview(html));
		}
	}

	/**
	 * Best-effort async rename of the editor tab to "{agentName}_html".
	 * Called after the owning agentId is resolved in {@link setInput}.
	 * Non-blocking so the preview renders without waiting on the lookup.
	 */
	private async _updateTabTitle(input: HtmlPreviewEditorInput): Promise<void> {
		if (!this._currentAgentId) {
			return;
		}
		try {
			const agent = await this._agentStudioService.getAgent(this._currentAgentId);
			if (agent?.name) {
				input.setName(`${agent.name}_html`);
			}
		} catch (err) {
			this._logService.warn('[HtmlPreviewEditorPane] failed to resolve agent name for tab title:', err);
		}
	}

	override clearInput(): void {
		this._logService.warn('[HtmlPreviewEditorPane] clearInput: clearing editor input, disposing webviews');
		this._cleanupTrailingBreadcrumbsContent();
		this._disposeWebview();
		// Dispose edit webview
		if (this._editWebview) {
			this._editWebview.dispose();
			this._editWebview = undefined;
		}
		if (this._editWebviewContainer) {
			DOM.clearNode(this._editWebviewContainer);
		}
		this._currentAgentId = undefined;
		this._currentWorkspaceId = undefined;
		this._currentWorkspaceSessionId = undefined;
		this._currentAgentSessionId = undefined;
		this._rawHtml = undefined;
		this._mode = 'preview';
		super.clearInput();
	}

	override dispose(): void {
		this._logService.warn('[HtmlPreviewEditorPane] dispose: destroying pane');
		this._cleanupTrailingBreadcrumbsContent();
		if (this._sourceEditor) {
			this._sourceEditor.dispose();
			this._sourceEditor = undefined;
		}
		this._sourceModel = undefined;
		if (this._editWebview) {
			this._editWebview.dispose();
			this._editWebview = undefined;
		}
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		super.dispose();
	}

	private _disposeWebview(): void {
		this._logService.warn('[HtmlPreviewEditorPane] _disposeWebview: destroying preview webview');
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		if (this._webviewMount) {
			DOM.clearNode(this._webviewMount);
		}
	}

	/**
	 * Resolve the owning agent from the preview file's URI.
	 *
	 * Path convention (set up by `ConfigHtmlService.previewToFile`):
	 *   <workspacePath>/.sarosworkspace/agents/<agentDir>/.preview.html
	 *
	 * Strategy (in order):
	 *   1. Extract `<workspacePath>` and `<agentDir>` from the file path.
	 *   2. Find the workspace whose `.path` matches `<workspacePath>` (case-
	 *      insensitive on Windows).
	 *   3. List agents scoped to that workspaceId and find one with the
	 *      matching `agentDir`.
	 *   4. Fallback: search across ALL workspaces for the matching `agentDir`
	 *      — `agentDir` is a globally-unique slug so this is safe.
	 *   5. Last-resort fallback: list agents with no workspaceId filter
	 *      (legacy behaviour, kept for non-folder-backed workspaces).
	 *
	 * The previous single-call `getAgents()` (no workspaceId) would land
	 * on the global fallback data dir when the OSS host has no folder open
	 * or has a folder different from the workspace that owns the agent —
	 * this returned an unrelated agent list and produced the
	 * "no agent with agentDir=..." warnings.
	 */
	private async _resolveAgentIdFromUri(uri: URI): Promise<string | undefined> {
		const fsPath = uri.fsPath.replace(/\\/g, '/');
		const m = /^(.+?)\/\.sarosworkspace\/agents\/([^/]+)\/\.preview\.html$/i.exec(fsPath);
		if (!m) {
			this._logService.warn(`[HtmlPreviewEditorPane] resolveAgentId: path regex did not match fsPath=${fsPath}`);
			return undefined;
		}
		const workspacePath = m[1];
		const agentDir = m[2];

		// Step 1: try the workspace whose path matches.
		try {
			const workspaces = await this._agentStudioService.getWorkspaces();
			const norm = (p?: string) => (p || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
			const target = norm(workspacePath);
			const ws = workspaces.find(w => norm(w.path) === target);
			if (ws) {
				const bindings = await this._agentStudioService.getAgentBindings(ws.id);
				const found = bindings.find(b => b.agentDir === agentDir);
				if (found) {
					return found.agentId;
				}
				this._logService.warn(
					`[HtmlPreviewEditorPane] resolveAgentId: workspace '${ws.id}' (${ws.path}) has no agent binding with agentDir='${agentDir}' (${bindings.length} bindings)`,
				);
			}
		} catch (err) {
			this._logService.warn(`[HtmlPreviewEditorPane] resolveAgentId: workspace lookup failed:`, err);
		}

		// Step 2: search all workspaces (agentDir is globally unique).
		try {
			const workspaces = await this._agentStudioService.getWorkspaces();
			for (const ws of workspaces) {
				const bindings = await this._agentStudioService.getAgentBindings(ws.id);
				const found = bindings.find(b => b.agentDir === agentDir);
				if (found) {
					this._logService.info(
						`[HtmlPreviewEditorPane] resolveAgentId: matched via cross-workspace scan — workspace='${ws.id}' agent='${found.agentId}'`,
					);
					return found.agentId;
				}
			}
		} catch (err) {
			this._logService.warn(`[HtmlPreviewEditorPane] resolveAgentId: cross-workspace scan failed:`, err);
		}

		// Step 3: last resort — active workspace's agent bindings.
		try {
			const activeWsId = this._agentStudioService.getActiveWorkspaceId();
			if (activeWsId) {
				const bindings = await this._agentStudioService.getAgentBindings(activeWsId);
				const found = bindings.find(b => b.agentDir === agentDir);
				if (found) {
					return found.agentId;
				}
				this._logService.warn(
					`[HtmlPreviewEditorPane] resolveAgentId: no agent binding with agentDir='${agentDir}' (workspacePath='${workspacePath}', active workspace '${activeWsId}' has ${bindings.length} bindings: ${bindings.map(b => `${b.agentId}→${b.agentDir}`).join(', ')})`,
				);
			}
		} catch (err) {
			this._logService.error(`[HtmlPreviewEditorPane] resolveAgentId: global fallback failed:`, err);
		}
		return undefined;
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

		// Fragment: wrap into a full document.
		return `<!doctype html><html><head>${csp}${baseStyle}</head><body>${html}</body></html>`;
	}
}
