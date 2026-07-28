/*---------------------------------------------------------------------------------------------
 *  KbBlocksEditorPane — KB note editor backed by the react-markdown pipeline.
 *
 *  Replaces the old SiYuan (Lute) `KbNoteEditorPane` and the abandoned AFFiNE /
 *  BlockSuite WYSIWYG attempt. This is a real `EditorPane` (registered under
 *  the same `editorId` that `KbNoteEditorInput` reports) so clicking a KB file
 *  in the knowledge-base view opens the markdown renderer in the editor area.
 *
 *  Host side (AMD) mounts a sandboxed VS Code webview that loads the
 *  pre-bundled `media/kbblocks.js` (react-markdown + KaTeX + the wikilink /
 *  embed resolver). The `.md` content and the vault note index are injected via
 *  `window.__KB_INIT__`; edits in source mode are serialized straight back to
 *  disk through `IFileService`. `.md` is the single source of truth.
 *
 *  Collaboration (multi-agent editing of one document) is intentionally out of
 *  scope for now — each pane owns an independent doc.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { KbNoteEditorInput } from './kbNoteEditorInput.js';
import { serializeBacklinks } from './kbBlocksCodec.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IKbNativeKernelService } from './kbNativeKernelService.js';
import { KbVersionService, IKbVersionService } from './kbVersionService.js';
import type { KbCommitMeta, KbDiffResult } from './kbVersionTypes.js';

interface KbHostMessage {
	direction: 'toHost';
	type: string;
	payload?: unknown;
}

export class KbBlocksEditorPane extends EditorPane {

	/** Must match `KbNoteEditorInput.editorId` so KB clicks open this pane. */
	static readonly ID = 'workbench.editor.agentStudio.kbNotePane';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;

	private _currentResource: URI | undefined;
	private _currentMarkdown = '';
	/** Vault note index (URI + stem) for the webview wikilink resolver. */
	private _workspaceFiles: { uri: string; name: string }[] = [];
	/** Absolute `file://` URI of the currently open note (wikilink disambiguation). */
	private _currentFilePath = '';
	/** `#heading` to scroll to after the note renders (`[[note#heading]]` jump). */
	private _pendingHeading: string | undefined;

	private readonly _onReady = this._register(new Emitter<{ docId: string }>());
	readonly onReady: Event<{ docId: string }> = this._onReady.event;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IEditorService private readonly _editorService: IEditorService,
		@IKbNativeKernelService private readonly _kbKernelService: IKbNativeKernelService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IKbVersionService private readonly _versionService: KbVersionService,
	) {
		super(KbBlocksEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-studio-kb-blocks-pane');
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

		if (!(input instanceof KbNoteEditorInput) || !this._container || token.isCancellationRequested) {
			return;
		}

		await this._openDoc(input.resource, input.heading);
	}

	private async _openDoc(resource: URI, heading?: string): Promise<void> {
		this._currentResource = resource;
		this._currentFilePath = resource.toString();
		this._pendingHeading = heading;

		let mdContent = '';
		try {
			const content = await this._fileService.readFile(resource);
			mdContent = content.value.toString();
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to read KB note, opening empty doc', err);
		}
		this._currentMarkdown = mdContent;

		// Enumerate the vault notes so the webview can resolve `[[wikilinks]]`.
		// Best-effort: if the kernel can't build (no KB view yet / cold start),
		// fall back to an empty index — the note still renders, wikilinks just
		// appear broken until the index becomes available.
		try {
			this._workspaceFiles = await this._kbKernelService.getWorkspaceFiles(resource.toString());
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to build workspace file index', err);
			this._workspaceFiles = [];
		}

		await this._ensureWebview();
	}

	// ── Media resolution (out/ for prod, src/ for dev) ──────────────────────

	private _mediaCandidates(): URI[] {
		const appRoot = this._environmentService.appRoot;
		const segments = ['vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media'];
		const outUri = URI.joinPath(URI.file(appRoot), 'out', ...segments);
		const srcUri = URI.joinPath(URI.file(appRoot), 'src', ...segments);
		// Prefer `src` (the esbuild output target — always the freshest local
		// build) during development; fall back to `out` for the packaged build
		// where `src` is not shipped.
		return [srcUri, outUri];
	}

	private async _resolveMediaUri(): Promise<URI | undefined> {
		for (const uri of this._mediaCandidates()) {
			try {
				await this._fileService.stat(URI.joinPath(uri, 'kbblocks.js'));
				return uri;
			} catch {
				// try next candidate
			}
		}
		return undefined;
	}

	private async _ensureWebview(): Promise<void> {
		if (!this._container) {
			return;
		}

		const mediaUri = await this._resolveMediaUri();

		let bundleJs = '';
		let css = '';
		if (mediaUri) {
			// Read the pre-bundled react-markdown script so we can inline it
			// (avoids the slow service-worker fetch; mirrors AgentStudioWebviewController).
			try {
				bundleJs = (await this._fileService.readFile(URI.joinPath(mediaUri, 'kbblocks.js'))).value.toString();
			} catch (err) {
				this._logService.warn('[KbBlocksEditorPane] failed to read kbblocks.js, using external ref', err);
			}
			try {
				css = (await this._fileService.readFile(URI.joinPath(mediaUri, 'kbblocks.css'))).value.toString();
			} catch {
				// no stylesheet — use default styles
			}
		}

		const html = this._getHtml(bundleJs, css, mediaUri);

		if (this._webview) {
			this._webview.setHtml(html);
			return;
		}

		const localResourceRoots = this._mediaCandidates();

		this._webview = this._webviewService.createWebviewElement({
			title: 'Markdown KB',
			options: {
				enableFindWidget: false,
				retainContextWhenHidden: true,
				disableServiceWorker: bundleJs.length > 0,
			},
			contentOptions: {
				allowScripts: true,
				allowForms: true,
				localResourceRoots,
			},
			extension: undefined,
		});

		this._register(this._webview);

		this._register(
			this._webview.onMessage((e) => this._onMessage(e.message as KbHostMessage)),
		);

		this._webview.mountTo(this._container, mainWindow);
		this._webview.setHtml(html);
	}

	private async _onMessage(msg: KbHostMessage): Promise<void> {
		if (!msg || msg.direction !== 'toHost') {
			return;
		}

		if (msg.type === 'kbblocks.ready') {
			const payload = msg.payload as { docId?: string } | undefined;
			this._onReady.fire({ docId: payload?.docId ?? this._currentResource?.toString() ?? '' });
			// AFFiNE "linked references" parity: push the shared kernel's
			// backlinks/mentions for this doc into the webview.
			void this._refreshBacklinks(payload?.docId);
		} else if (msg.type === 'kbblocks.save') {
			const payload = msg.payload as { markdown?: string; kind?: string } | undefined;
			if (typeof payload?.markdown === 'string') {
				// Await so we can drop the stale kernel index *after* the `.md`
				// hit disk (task flips also change file content, so invalidate).
				const markdownSaved = await this._saveDoc(payload.markdown);
				if (markdownSaved) {
					this._kbKernelService.invalidate();
					// Notify webview the file was saved (external change notification),
					// so the double-buffer (editContent/dirty) stays in sync.
					this._webview?.postMessage({
						direction: 'toWebview',
						type: 'kbblocks.fileChanged',
						data: { markdown: payload.markdown },
					});
					// AutoGit: snapshot the file after every save (SoloMD v2.2 pattern).
					void this._autoCommit();
				}
			}
			// A task checkbox flip only changes `[ ]`↔`[x]`; it never alters
			// `[[wikilink]]`s, so skip the (relatively heavy) backlink refresh.
			if (payload?.kind !== 'taskToggle') {
				void this._refreshBacklinks();
			}
		} else if (msg.type === 'kbblocks.getNoteContent') {
			const payload = msg.payload as { uri?: string; requestId?: string } | undefined;
			if (typeof payload?.uri === 'string' && typeof payload?.requestId === 'string') {
				void this._serveNoteContent(payload.uri, payload.requestId);
			}
		} else if (msg.type === 'kbblocks.openRelative') {
			const payload = msg.payload as { href?: string; fromUri?: string } | undefined;
			if (typeof payload?.href === 'string' && typeof payload?.fromUri === 'string') {
				this._openRelative(payload.href, payload.fromUri);
			}
		} else if (msg.type === 'kbblocks.openExternal') {
			const payload = msg.payload as { url?: string } | undefined;
			if (typeof payload?.url === 'string') {
				try {
					void this._openerService.open(URI.parse(payload.url), { openExternal: true });
				} catch (err) {
					this._logService.warn('[KbBlocksEditorPane] failed to open external url', err);
				}
			}
		} else if (msg.type === 'kbblocks.copy') {
			const payload = msg.payload as { markdown?: string } | undefined;
			if (typeof payload?.markdown === 'string') {
				void this._copyMarkdown(payload.markdown);
			}
		} else if (msg.type === 'kbblocks.openDoc') {
			const payload = msg.payload as { uri?: string; heading?: string } | undefined;
			if (typeof payload?.uri === 'string') {
				this._openDocByUri(payload.uri, payload.heading);
			}
		} else if (msg.type === 'kbblocks.getVersionHistory') {
			const payload = msg.payload as { requestId?: string } | undefined;
			if (typeof payload?.requestId === 'string') {
				void this._handleGetVersionHistory(payload.requestId);
			}
		} else if (msg.type === 'kbblocks.getVersionDiff') {
			const payload = msg.payload as { requestId?: string; sha?: string } | undefined;
			if (typeof payload?.requestId === 'string' && typeof payload?.sha === 'string') {
				void this._handleGetVersionDiff(payload.requestId, payload.sha);
			}
		} else if (msg.type === 'kbblocks.restoreVersion') {
			const payload = msg.payload as { sha?: string } | undefined;
			if (typeof payload?.sha === 'string') {
				void this._handleRestoreVersion(payload.sha);
			}
		}
	}

	/** Query the shared KB kernel for backlinks/mentions and push to the webview. */
	private async _refreshBacklinks(docId?: string): Promise<void> {
		const id = docId ?? this._currentResource?.toString();
		if (!id || !this._webview) {
			return;
		}
		try {
			const result = await this._kbKernelService.getBacklinks(id);
			const payload = serializeBacklinks(result);
			this._webview.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.backlinks',
				data: payload,
			});
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to resolve backlinks', err);
		}
	}

	/** Open a KB note referenced by a backlink card / wikilink (AFFiNE jump-to-reference parity). */
	private _openDocByUri(uriStr: string, heading?: string): void {
		try {
			const uri = URI.parse(uriStr);
			this._editorService.openEditor(
				new KbNoteEditorInput(uri, uri.path, heading),
				{ pinned: true },
				this.group,
			);
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to open backlink target', err);
		}
	}

	/** Serve a note's markdown to the webview for an `![[embed]]` (cycle-safe). */
	private async _serveNoteContent(uriStr: string, requestId: string): Promise<void> {
		const respond = (markdown: string): void => {
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.noteContent',
				data: { requestId, markdown },
			});
		};
		try {
			const uri = URI.parse(uriStr);
			const content = await this._fileService.readFile(uri);
			respond(content.value.toString());
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to serve note content', err);
			respond('');
		}
	}

	/** Open a relative markdown/canvas link resolved against the current note. */
	private _openRelative(href: string, fromUri: string): void {
		try {
			const base = dirname(URI.parse(fromUri));
			const segments = href.split('/').filter((s) => s.length > 0 && s !== '.');
			const parts: string[] = [];
			for (const s of segments) {
				if (s === '..') parts.pop();
				else parts.push(s);
			}
			const target = URI.joinPath(base, ...parts);
			this._editorService.openEditor(
				new KbNoteEditorInput(target, target.path),
				{ pinned: true },
				this.group,
			);
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to open relative link', err);
		}
	}

	/** Copy the current note's Markdown to the OS clipboard (AFFiNE "copy" parity). */
	private async _copyMarkdown(markdown: string): Promise<void> {
		try {
			await this._clipboardService.writeText(markdown);
			this._logService.info('[KbBlocksEditorPane] KB note markdown copied to clipboard');
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to copy KB note markdown', err);
		}
	}

	/** AutoGit: commit the current file after a save (SoloMD v2.2 pattern). */
	private async _autoCommit(): Promise<void> {
		if (!this._currentResource || !this._versionService.isAvailable()) {
			return;
		}
		try {
			const vaultRoot = this._versionService.resolveVaultRoot(this._currentResource);
			if (!vaultRoot) return;
			const sha = await this._versionService.autoCommit(vaultRoot, this._currentResource);
			if (sha && this._webview) {
				this._webview.postMessage({
					direction: 'toWebview',
					type: 'kbblocks.versionCommitted',
					data: { sha, shortSha: sha.substring(0, 7) },
				});
			}
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] autoCommit failed', err);
		}
	}

	/** Handle webview request for version history. */
	private async _handleGetVersionHistory(requestId: string): Promise<void> {
		if (!this._currentResource || !this._versionService.isAvailable()) {
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionHistory',
				data: { requestId, commits: [] },
			});
			return;
		}
		try {
			const vaultRoot = this._versionService.resolveVaultRoot(this._currentResource);
			if (!vaultRoot) {
				this._webview?.postMessage({
					direction: 'toWebview',
					type: 'kbblocks.versionHistory',
					data: { requestId, commits: [] },
				});
				return;
			}
			const commits: KbCommitMeta[] = await this._versionService.fileHistory(vaultRoot, this._currentResource);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionHistory',
				data: { requestId, commits },
			});
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] getVersionHistory failed', err);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionHistory',
				data: { requestId, commits: [] },
			});
		}
	}

	/** Handle webview request for a specific commit's diff. */
	private async _handleGetVersionDiff(requestId: string, sha: string): Promise<void> {
		if (!this._currentResource || !this._versionService.isAvailable()) {
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionDiff',
				data: { requestId, diff: null },
			});
			return;
		}
		try {
			const vaultRoot = this._versionService.resolveVaultRoot(this._currentResource);
			if (!vaultRoot) {
				this._webview?.postMessage({
					direction: 'toWebview',
					type: 'kbblocks.versionDiff',
					data: { requestId, diff: null },
				});
				return;
			}
			const diff: KbDiffResult | null = await this._versionService.fileDiff(vaultRoot, this._currentResource, sha);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionDiff',
				data: { requestId, diff },
			});
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] getVersionDiff failed', err);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionDiff',
				data: { requestId, diff: null },
			});
		}
	}

	/** Handle webview request to restore a file to a specific commit version. */
	private async _handleRestoreVersion(sha: string): Promise<void> {
		if (!this._currentResource || !this._versionService.isAvailable()) {
			return;
		}
		try {
			const vaultRoot = this._versionService.resolveVaultRoot(this._currentResource);
			if (!vaultRoot) return;
			const restoredContent = await this._versionService.rollbackFile(vaultRoot, this._currentResource, sha);
			// Update our in-memory copy so subsequent saves don't overwrite the rollback.
			this._currentMarkdown = restoredContent;
			this._kbKernelService.invalidate();
			// Notify webview with the restored content so the editor buffer syncs.
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionRestored',
				data: { sha, markdown: restoredContent },
			});
			this._logService.info('[KbBlocksEditorPane] restored to', sha.substring(0, 7));
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] restoreVersion failed', err);
		}
	}

	/**
	 * Persist the note. Returns `true` if the `.md` (the only thing the shared
	 * kernel indexes) was actually written — callers use this to decide whether
	 * the backlink index needs invalidating.
	 */
	/**
	 * Persist the note. Returns `true` if the `.md` (the only source of truth now
	 * that BlockSuite/`.bsdoc` is gone) was actually written.
	 */
	private async _saveDoc(markdown: string | undefined): Promise<boolean> {
		if (!this._currentResource || typeof markdown !== 'string') {
			return false;
		}
		try {
			await this._fileService.writeFile(this._currentResource, VSBuffer.fromString(markdown));
			this._currentMarkdown = markdown;
			this._logService.info('[KbBlocksEditorPane] KB note saved (markdown)');
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to save KB note', err);
			return false;
		}
		return true;
	}

	private _getHtml(bundleJs: string, css: string, mediaUri: URI | undefined): string {
		const nonce = generateUuid().replace(/-/g, '');
		const docId = this._currentResource?.toString() ?? 'kb:probe';
		const initJson = JSON.stringify({
			docId,
			markdown: this._currentMarkdown,
			workspaceFiles: this._workspaceFiles,
			currentFilePath: this._currentFilePath,
			...(this._pendingHeading ? { heading: this._pendingHeading } : {}),
		});

		// Inline the stylesheet (style-src 'unsafe-inline' allows it; a <link> to a
		// webview resource would be blocked by the CSP origin allow-list).
		const styleTag = css ? `<style nonce="${nonce}">${css}</style>` : '';

		let scriptTag: string;
		if (bundleJs.length > 0) {
			scriptTag = `<script nonce="${nonce}">${bundleJs}</script>`;
		} else if (mediaUri) {
			// Fallback: external reference through the webview URI (needs SW on).
			const scriptUri = asWebviewUri(URI.joinPath(mediaUri, 'kbblocks.js')).toString();
			scriptTag = `<script nonce="${nonce}" src="${scriptUri}"></script>`;
		} else {
			scriptTag = `<script nonce="${nonce}">console.error('[KbBlocksEditorPane] kbblocks.js not found');</script>`;
		}

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: https: vscode-webview: vscode-resource:; font-src data: vscode-webview: vscode-resource:; connect-src vscode-webview:;">
	<title>Markdown KB</title>
	${styleTag}
</head>
<body>
	<div id="root" style="height:100%"></div>
	<script nonce="${nonce}">window.__KB_INIT__ = ${initJson};</script>
	${scriptTag}
</body>
</html>`;
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override clearInput(): void {
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		this._currentResource = undefined;
		this._currentMarkdown = '';
		this._workspaceFiles = [];
		this._currentFilePath = '';
		if (this._container) {
			DOM.clearNode(this._container);
		}
		super.clearInput();
	}

	override dispose(): void {
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		super.dispose();
	}
}
