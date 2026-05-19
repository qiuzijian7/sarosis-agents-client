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
import { IAgentStudioService, IConfigMdService } from '../common/agentStudio.js';
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
	/** Resolved at setInput time; used to filter inbound imgui command pushes. */
	private _currentEmployeeId: string | undefined;
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

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IConfigMdService private readonly _configMdService: IConfigMdService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
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

			// Resolve the owning employee up-front. Prefer the value carried
			// by the EditorInput (set by ConfigMD's preview button which
			// already knows which agent owns it). Fall back to reverse-
			// engineering it from the file path so direct file opens still
			// work, but the input route is preferred and the only one that
			// works for in-memory / global workspaces.
			this._logService.info(`[HtmlPreviewEditorPane] setInput: input.employeeId='${input.employeeId}' workspaceId='${input.workspaceId}' workspaceSessionId='${input.workspaceSessionId}' agentSessionId='${input.agentSessionId}' resource=${input.resource.toString()}`);
			this._currentEmployeeId = input.employeeId
				?? await this._resolveEmployeeIdFromUri(input.resource);
			this._currentWorkspaceId = input.workspaceId;
			this._currentWorkspaceSessionId = input.workspaceSessionId;
			this._currentAgentSessionId = input.agentSessionId;
			this._logService.info(`[HtmlPreviewEditorPane] resolved employeeId='${this._currentEmployeeId}' for ${input.resource.toString()}`);

			// Forward `imgui.submit` (and other future imgui-style events)
			// from the preview SDK back to ConfigMdService.handleHtmlEvent.
			//
			// We re-attach the captured (workspaceId, agentSessionId) to
			// every submit payload here on the host side: the SDK script
			// itself doesn't know about workspaces, and we want the routing
			// info to come from a trusted source (this pane's input) rather
			// than from JS running in the webview content.
			this._register(this._webview.onMessage(async (e) => {
				const m = e.message as { type?: string; payload?: unknown } | undefined;
				if (!m || typeof m.type !== 'string') { return; }
				if (m.type !== 'imgui.submit') { return; }
				try {
					const employeeId = this._currentEmployeeId
						?? await this._resolveEmployeeIdFromUri(input.resource);
					if (!employeeId) {
						this._logService.warn(`[HtmlPreviewEditorPane] could not resolve employeeId from ${input.resource.toString()}`);
						return;
					}
					// Augment payload with the captured ctx so the service
					// can route the eventual chat.send into the right session.
					const enriched = {
						...(typeof m.payload === 'object' && m.payload !== null ? m.payload as Record<string, unknown> : {}),
						_ctx: {
							employeeId,
							workspaceId: this._currentWorkspaceId,
							workspaceSessionId: this._currentWorkspaceSessionId,
							agentSessionId: this._currentAgentSessionId,
						},
					};
					await this._configMdService.handleHtmlEvent(employeeId, m.type, enriched, this._currentAgentSessionId);
				} catch (err) {
					this._logService.error(`[HtmlPreviewEditorPane] handleHtmlEvent failed:`, err);
				}
			}));

			// Push host → preview commands. ConfigMdService dispatches these
			// via its onDidEmitCommand event for any employeeId; we filter
			// to the currently-loaded preview's employee.
			this._register(this._configMdService.onDidEmitCommand(({ employeeId, command }) => {
				if (!this._webview) { return; }
				if (this._currentEmployeeId && employeeId !== this._currentEmployeeId) { return; }
				if (!command?.name || !command.name.startsWith('imgui.')) { return; }
				const payload = { type: command.name, ...(command.params || {}) };
				void this._webview.postMessage(payload);
			}));

			// Direct DOM mount — this is the path that works on this fork's
			// Chromium build, identical to how the chat panel mounts itself.
			this._webview.mountTo(this._container, mainWindow);
			this._webview.setHtml(wrappedHtml);
			this._logService.info(`[HtmlPreviewEditorPane] mounted preview for ${resourceKey} (${wrappedHtml.length} chars)`);

			// Push initial ctx to the SDK so any client-side logic can
			// inspect it (e.g. show a session badge, gate features). The
			// SDK echoes the ctx back on every imgui.submit, which is
			// useful for diagnostics; the host-side `onMessage` above also
			// re-attaches ctx independently as a trust anchor.
			void this._webview.postMessage({
				type: 'imgui.ctx',
				employeeId: this._currentEmployeeId,
				workspaceId: this._currentWorkspaceId,
				workspaceSessionId: this._currentWorkspaceSessionId,
				agentSessionId: this._currentAgentSessionId,
			});
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
		this._currentEmployeeId = undefined;
		this._currentWorkspaceId = undefined;
		this._currentWorkspaceSessionId = undefined;
		this._currentAgentSessionId = undefined;
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
	 * Resolve the owning employee from the preview file's URI.
	 *
	 * Path convention (set up by `ConfigMdService.previewToFile`):
	 *   <workspacePath>/.sarosisworkspace/agents/<agentDir>/.preview.html
	 *
	 * Strategy (in order):
	 *   1. Extract `<workspacePath>` and `<agentDir>` from the file path.
	 *   2. Find the workspace whose `.path` matches `<workspacePath>` (case-
	 *      insensitive on Windows).
	 *   3. List employees scoped to that workspaceId and find one with the
	 *      matching `agentDir`.
	 *   4. Fallback: search across ALL workspaces for the matching `agentDir`
	 *      — `agentDir` is a globally-unique slug so this is safe.
	 *   5. Last-resort fallback: list employees with no workspaceId filter
	 *      (legacy behaviour, kept for non-folder-backed workspaces).
	 *
	 * The previous single-call `getEmployees()` (no workspaceId) would land
	 * on the global fallback data dir when the OSS host has no folder open
	 * or has a folder different from the workspace that owns the agent —
	 * this returned an unrelated employee list and produced the
	 * "no employee with agentDir=..." warnings.
	 */
	private async _resolveEmployeeIdFromUri(uri: URI): Promise<string | undefined> {
		const fsPath = uri.fsPath.replace(/\\/g, '/');
		const m = /^(.+?)\/\.sarosisworkspace\/agents\/([^/]+)\/\.preview\.html$/i.exec(fsPath);
		if (!m) {
			this._logService.warn(`[HtmlPreviewEditorPane] resolveEmployeeId: path regex did not match fsPath=${fsPath}`);
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
				const employees = await this._agentStudioService.getEmployees(ws.id);
				const found = employees.find(e => e.agentDir === agentDir);
				if (found) {
					return found.id;
				}
				this._logService.warn(
					`[HtmlPreviewEditorPane] resolveEmployeeId: workspace '${ws.id}' (${ws.path}) has no employee with agentDir='${agentDir}' (${employees.length} employees)`,
				);
			}
		} catch (err) {
			this._logService.warn(`[HtmlPreviewEditorPane] resolveEmployeeId: workspace lookup failed:`, err);
		}

		// Step 2: search all workspaces (agentDir is globally unique).
		try {
			const workspaces = await this._agentStudioService.getWorkspaces();
			for (const ws of workspaces) {
				const employees = await this._agentStudioService.getEmployees(ws.id);
				const found = employees.find(e => e.agentDir === agentDir);
				if (found) {
					this._logService.info(
						`[HtmlPreviewEditorPane] resolveEmployeeId: matched via cross-workspace scan — workspace='${ws.id}' employee='${found.id}'`,
					);
					return found.id;
				}
			}
		} catch (err) {
			this._logService.warn(`[HtmlPreviewEditorPane] resolveEmployeeId: cross-workspace scan failed:`, err);
		}

		// Step 3: last resort — global/folder-derived employees list.
		try {
			const employees = await this._agentStudioService.getEmployees();
			const found = employees.find(e => e.agentDir === agentDir);
			if (found) {
				return found.id;
			}
			this._logService.warn(
				`[HtmlPreviewEditorPane] resolveEmployeeId: no employee with agentDir='${agentDir}' (workspacePath='${workspacePath}', global fallback has ${employees.length} employees: ${employees.map(e => `${e.id}→${e.agentDir}`).join(', ')})`,
			);
		} catch (err) {
			this._logService.error(`[HtmlPreviewEditorPane] resolveEmployeeId: global fallback failed:`, err);
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
