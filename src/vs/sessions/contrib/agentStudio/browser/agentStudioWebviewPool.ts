/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService, type INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { AGENT_STUDIO_WEBVIEW_ORIGIN } from '../common/constants.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IAgentStudioWebviewPool = createDecorator<IAgentStudioWebviewPool>('agentStudioWebviewPool');

export interface IPooledWebview {
	/** The actual webview element, fully bootstrapped (HTML rendered, bundle loaded). */
	readonly webview: IWebviewElement;
	/** The DOM container the webview is mounted in (off-screen initially). */
	readonly container: HTMLElement;
	/** Epoch ms when this webview became ready (bundle loaded, postMessage working). */
	readonly readyTs: number;
}

export interface IAgentStudioWebviewPool {
	readonly _serviceBrand: undefined;

	/**
	 * Try to acquire a pre-warmed webview from the pool.
	 * Returns undefined if no warm instance is available.
	 * Once acquired, the caller owns the webview and is responsible for disposing it.
	 */
	acquire(): IPooledWebview | undefined;

	/**
	 * Whether a warm webview is currently available.
	 */
	readonly hasWarmWebview: boolean;

	/**
	 * Whether the pool is currently in the process of warming a webview.
	 * When true, callers should wait for `onDidBecomeAvailable` instead of
	 * creating a competing cold-path webview (which would share the same
	 * Chromium renderer process and cause contention).
	 */
	readonly isWarming: boolean;

	/**
	 * Fired when a new warm webview becomes available in the pool.
	 */
	readonly onDidBecomeAvailable: Event<void>;

	/**
	 * Ensure a warm webview is being prepared. No-op if one is already warm
	 * or currently warming. Returns synchronously; callers observe progress
	 * via `isWarming` / `hasWarmWebview` / `onDidBecomeAvailable`.
	 *
	 * Used by the chat panel cold-path to avoid spawning a competing renderer
	 * process when the pre-warm contribution hasn't kicked in yet (startup
	 * race): instead of paying a second ~20s renderer spawn, the panel kicks
	 * the pool and waits for the single shared instance.
	 */
	ensureWarming(): void;
}

/**
 * Pool that pre-creates and warms Agent Studio webview instances.
 *
 * The pool creates ONE webview at a time in an off-screen container, loads the
 * same inline HTML + bundle that the real chat panel uses, and holds it warm.
 * When a panel requests a webview via `acquire()`, the hot instance is handed
 * off immediately (0ms spawn cost) and a new one starts warming in the background.
 *
 * This eliminates the 25-40s cold renderer-spawn stall during dev startup.
 */
export class AgentStudioWebviewPool extends Disposable implements IAgentStudioWebviewPool {
	declare readonly _serviceBrand: undefined;

	private _warmInstance: IPooledWebview | undefined;
	private _isWarming = false;

	private readonly _onDidBecomeAvailable = this._register(new Emitter<void>());
	readonly onDidBecomeAvailable: Event<void> = this._onDidBecomeAvailable.event;

	/** Cached inline bundles (read once, reused for all warm instances). */
	private _bundleJs: string | undefined;
	private _bundleCss: string | undefined;

	constructor(
		@IWebviewService private readonly webviewService: IWebviewService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	get hasWarmWebview(): boolean {
		return !!this._warmInstance;
	}

	get isWarming(): boolean {
		return this._isWarming;
	}

	/** Number of consecutive warming failures (resets on success). */
	private _warmingRetries = 0;
	private static readonly MAX_RETRIES = 2;
	private static readonly RETRY_DELAY_MS = 5_000;

	/**
	 * Begin warming a webview instance. Called externally by the prewarm
	 * contribution after lifecycle phase is restored.
	 */
	async startWarming(): Promise<void> {
		if (this._warmInstance || this._isWarming) {
			return;
		}
		this._isWarming = true;
		try {
			await this._createWarmInstance();
			// If _warmInstance was set, reset retry counter
			if (this._warmInstance) {
				this._warmingRetries = 0;
			} else if (this._warmingRetries < AgentStudioWebviewPool.MAX_RETRIES) {
				// Warming failed (timeout / bundle didn't load) — retry after a delay
				this._warmingRetries++;
				this.logService.info(
					`[AgentStudioWebviewPool] scheduling retry ${this._warmingRetries}/${AgentStudioWebviewPool.MAX_RETRIES} ` +
					`in ${AgentStudioWebviewPool.RETRY_DELAY_MS}ms`
				);
				setTimeout(() => this.startWarming(), AgentStudioWebviewPool.RETRY_DELAY_MS);
			} else {
				this.logService.warn(
					`[AgentStudioWebviewPool] giving up after ${AgentStudioWebviewPool.MAX_RETRIES} failed attempts — ` +
					`chat panels will use the cold path`
				);
			}
		} catch (err) {
			this.logService.warn('[AgentStudioWebviewPool] warming failed:', err);
		} finally {
			this._isWarming = false;
		}
	}

	ensureWarming(): void {
		// Fire-and-forget. startWarming() is a no-op if already warm/warming
		// and synchronously flips `_isWarming` before its first await, so
		// callers can immediately observe `isWarming === true`.
		void this.startWarming();
	}

	acquire(): IPooledWebview | undefined {
		const instance = this._warmInstance;
		if (!instance) {
			this.logService.info('[AgentStudioWebviewPool] acquire() — no warm instance available, cold path');
			return undefined;
		}

		this._warmInstance = undefined;
		this.logService.info(
			`[AgentStudioWebviewPool] acquire() — handing off warm webview ` +
			`(warmed ${Date.now() - instance.readyTs}ms ago)`
		);

		// Start warming a replacement in the background
		this.startWarming();

		return instance;
	}

	private _getMediaUri(): URI {
		const appRoot = (this.environmentService as INativeEnvironmentService).appRoot;
		return URI.joinPath(
			URI.file(appRoot),
			'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media',
		);
	}

	private async _ensureBundles(): Promise<{ js: string; css: string } | undefined> {
		if (this._bundleJs && this._bundleCss) {
			return { js: this._bundleJs, css: this._bundleCss };
		}
		const mediaUri = this._getMediaUri();
		try {
			const [jsContent, cssContent] = await Promise.all([
				this.fileService.readFile(URI.joinPath(mediaUri, 'webview.js')),
				this.fileService.readFile(URI.joinPath(mediaUri, 'webview.css')),
			]);
			this._bundleJs = jsContent.value.toString();
			this._bundleCss = cssContent.value.toString();
			return { js: this._bundleJs, css: this._bundleCss };
		} catch (err) {
			this.logService.warn('[AgentStudioWebviewPool] failed to read bundles:', err);
			return undefined;
		}
	}

	private async _createWarmInstance(): Promise<void> {
		const t0 = Date.now();
		const bundles = await this._ensureBundles();
		if (!bundles) {
			return;
		}

		const mediaUri = this._getMediaUri();

		// Create the warming container.
		//
		// IMPORTANT: do NOT warm fully off-screen (e.g. left:-9999px) or at a
		// 1px×1px size. Chromium applies "rendering throttling for offscreen
		// iframes" based on viewport intersection — a frame that does not
		// intersect the viewport (or has ~zero area) gets its rAF/paint/timers
		// throttled, which can ~2x the bundle bootstrap time. Since a webview
		// is an iframe, an off-screen warm instance bootstraps much slower than
		// a visible one.
		//
		// To avoid that while staying invisible to the user, we keep the
		// container INSIDE the viewport at a real size, but make it fully
		// transparent (`opacity:0`) and click-through (`pointer-events:none`).
		// opacity:0 still intersects the viewport, so Chromium renders it at
		// full speed; the user sees nothing and cannot interact with it.
		//
		// On acquire(), the controller resets opacity/pointer-events and mirrors
		// the real panel geometry onto this container.
		const container = document.createElement('div');
		container.style.position = 'fixed';
		container.style.left = '0';
		container.style.top = '0';
		container.style.width = '1200px';
		container.style.height = '800px';
		container.style.opacity = '0';
		container.style.pointerEvents = 'none';
		container.style.overflow = 'hidden';
		container.style.zIndex = '10'; // Ensure overlay visibility when activated
		container.setAttribute('data-agent-studio-pool', 'warming');
		document.body.appendChild(container);

		// Create webview with same params as real chat panel
		const webview = this.webviewService.createWebviewElement({
			title: 'Agent Studio (pooled)',
			origin: AGENT_STUDIO_WEBVIEW_ORIGIN,
			options: {
				enableFindWidget: false,
				retainContextWhenHidden: true,
				disableServiceWorker: true,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [mediaUri],
			},
			extension: undefined,
		});

		webview.mountTo(container, mainWindow);

		// Set HTML with a special "pooled" panelType marker — the React app
		// will render a minimal skeleton and wait for a real panelType to be
		// sent via postMessage when the webview is acquired.
		const nonce = this._generateNonce();
		const html = this._buildPooledHtml(nonce, bundles.js, bundles.css);
		webview.setHtml(html);

		// Wait for the webview to signal it's ready (bundle loaded, React mounted).
		// If the webview fails to signal within the timeout, we dispose it and
		// do NOT mark it as warm — handing off an incompletely initialized webview
		// causes blank panels (the React app hasn't mounted, so pool.activate
		// messages are never handled).
		const result = await this._waitForReady(webview, 90_000);

		if (result === 'timeout') {
			this.logService.warn(
				`[AgentStudioWebviewPool] warm instance FAILED — bundle did not signal pool.ready ` +
				`within timeout (+${Date.now() - t0}ms). Disposing broken webview.`
			);
			webview.dispose();
			container.remove();
			return;
		}

		if (this._warmInstance) {
			// Another instance was somehow created — dispose this one
			webview.dispose();
			container.remove();
			return;
		}

		this._warmInstance = { webview, container, readyTs: result };
		container.setAttribute('data-agent-studio-pool', 'warm');

		this.logService.info(
			`[AgentStudioWebviewPool] warm instance ready (+${result - t0}ms total warm time)`
		);
		this._onDidBecomeAvailable.fire();
	}

	/**
	 * Wait for the pooled webview to post a `pool.ready` message indicating
	 * the bundle has loaded and React has mounted.
	 *
	 * Returns the ready timestamp on success, or `'timeout'` if the webview
	 * failed to signal readiness within the deadline.
	 */
	private _waitForReady(webview: IWebviewElement, timeoutMs: number): Promise<number | 'timeout'> {
		return new Promise<number | 'timeout'>((resolve) => {
			let resolved = false;

			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					disposable.dispose();
					this.logService.warn(
						`[AgentStudioWebviewPool] ready timeout after ${timeoutMs}ms — ` +
						`webview bundle did NOT signal pool.ready`
					);
					resolve('timeout');
				}
			}, timeoutMs);

			const disposable = webview.onMessage((msg) => {
				const data = msg.message as any;
				if (data?.type === 'pool.ready') {
					if (!resolved) {
						resolved = true;
						clearTimeout(timeout);
						disposable.dispose();
						resolve(Date.now());
					}
				}
			});
		});
	}

	private _buildPooledHtml(nonce: string, js: string, css: string): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: https: vscode-webview: vscode-resource:; font-src data: vscode-webview: vscode-resource:;">
	<title>Agent Studio</title>
	<style nonce="${nonce}">${css}</style>
	<style nonce="${nonce}">
		@keyframes as-spin { to { transform: rotate(360deg); } }
		body { margin: 0; padding: 0; overflow: hidden; height: 100vh; background: var(--as-bg-primary, var(--vscode-editor-background)); color: var(--as-fg-primary, var(--vscode-foreground)); font-family: var(--vscode-font-family); }
		#root { width: 100%; height: 100%; }
		#as-preload { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 16px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
		#as-preload svg { animation: as-spin 1s linear infinite; opacity: 0.7; }
		#as-preload span { font-size: 13px; letter-spacing: 0.4px; opacity: 0.8; }
	</style>
</head>
<body>
	<div id="root">
		<div id="as-preload">
			<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
			</svg>
			<span>Agent Studio 加载中...</span>
		</div>
	</div>
	<script nonce="${nonce}">
		// Pooled webview: panelType starts as '__pooled__' — the real type
		// will be injected via postMessage when this webview is acquired.
		window.__AGENT_STUDIO_PANEL_TYPE__ = '__pooled__';
		window.__AGENT_STUDIO_INITIAL_THEME__ = '';
		window.__AGENT_STUDIO_CSP_NONCE__ = '${nonce}';
		window.__AGENT_STUDIO_INITIAL_DATA__ = null;
		window.__AS_PERF_RENDERER_ORIGIN__ = ${Math.round((mainWindow.performance?.timeOrigin ?? Date.now()))};
		window.__AS_PERF_HOST_CREATE_TS__ = ${Date.now()};
		window.__AS_PERF_HTML_TS__ = ${Date.now()};
		window.__AS_MSG_LOG__ = [];
		window.addEventListener('message', function(e) {
			var d = e.data;
			if (d && d.direction === 'toWebview') {
				window.__AS_MSG_LOG__.push(d.type);
			}
		});
		window.__AS_BUNDLE_LOADED__ = false;
		window.__AS_PERF_INLINE_TS__ = Date.now();
	</script>
	${`<script nonce="${nonce}">${js}</script>`}
</body>
</html>`;
	}

	private _generateNonce(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 32; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	override dispose(): void {
		if (this._warmInstance) {
			this._warmInstance.webview.dispose();
			this._warmInstance.container.remove();
			this._warmInstance = undefined;
		}
		super.dispose();
	}
}
