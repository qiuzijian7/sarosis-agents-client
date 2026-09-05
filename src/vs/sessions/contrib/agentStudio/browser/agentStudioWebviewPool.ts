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
	/** webview.js 的 mtime（bundle 缓存失效依据，见 _ensureBundles）。 */
	private _bundleMtime = 0;
	/** 当前 warm 实例渲染时所用的 bundle mtime（过期实例在 acquire 丢弃）。 */
	private _warmBundleMtime = 0;

	constructor(
		@IWebviewService private readonly webviewService: IWebviewService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	get hasWarmWebview(): boolean {
		// bundle 更新后过期 warm 实例不算 warm（acquire 会丢弃 → 冷路径）。
		return !!this._warmInstance && this._warmBundleMtime === this._bundleMtime;
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

	acquire(): IPooledWebview | undefined {
		const instance = this._warmInstance;
		if (!instance) {
			this.logService.info('[AgentStudioWebviewPool] acquire() — no warm instance available, cold path');
			return undefined;
		}

		// ★ bundle 热更新（2026-09-04）：warm 实例渲染于旧 bundle（_ensureBundles
		//   按 mtime 检测到磁盘更新后），丢弃过期实例——调用方走冷路径，用新
		//   bundle 现创建面板。否则「改了 webview 代码不生效」会一直复现。
		if (this._warmBundleMtime !== this._bundleMtime) {
			this.logService.info(
				`[AgentStudioWebviewPool] acquire() — warm instance predates bundle reload ` +
				`(instance mtime=${this._warmBundleMtime}, disk mtime=${this._bundleMtime}), discarding → cold path`,
			);
			this._warmInstance = undefined;
			instance.webview.dispose();
			instance.container.remove();
			// 立即补 warm（用新 bundle），下次 acquire 恢复热路径。
			void this.startWarming();
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
			'out', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media',
		);
	}

	private async _ensureBundles(): Promise<{ js: string; css: string } | undefined> {
		const mediaUri = this._getMediaUri();
		// ★ bundle 按 mtime 失效（2026-09-04）：此前 read once 常驻缓存——esbuild
		//   重建 out/ 后 warm pool 仍旧用旧代码，表现为「修复不生效，必须 Reload
		//   Window」。现在每次 ensure 先 stat webview.js：mtime 变化即重读，下次
		//   开面板自动加载新 bundle。stat 失败回退旧行为（用缓存/初次读取）。
		let mtime = 0;
		try {
			const stat = await this.fileService.stat(URI.joinPath(mediaUri, 'webview.js'));
			mtime = stat.mtime ?? 0;
		} catch { /* stat 失败不阻塞 */ }
		if (this._bundleJs && this._bundleCss) {
			if (mtime <= 0 || mtime === this._bundleMtime) {
				return { js: this._bundleJs, css: this._bundleCss };
			}
			this.logService.info(
				`[AgentStudioWebviewPool] webview.js changed on disk (mtime ${this._bundleMtime} → ${mtime}) — reloading bundle`,
			);
		}
		try {
			const [jsContent, cssContent] = await Promise.all([
				this.fileService.readFile(URI.joinPath(mediaUri, 'webview.js')),
				this.fileService.readFile(URI.joinPath(mediaUri, 'webview.css')),
			]);
			this._bundleJs = jsContent.value.toString();
			this._bundleCss = cssContent.value.toString();
			this._bundleMtime = mtime;
			// ★ bundle 版本自报：日志直接证明 pool 加载的 webview.js 版本。
			this.logService.info(`[AS-BUNDLE] pool bundle cached mtime=${mtime} len=${this._bundleJs.length}`);
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

		// Create off-screen container
		const container = document.createElement('div');
		container.style.position = 'fixed';
		container.style.left = '-9999px';
		container.style.top = '-9999px';
		container.style.width = '1px';
		container.style.height = '1px';
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
		// 记录渲染本实例所用的 bundle 版本（mtime）——bundle 热更新后过期实例在
		// acquire() 时被丢弃（见 acquire 的 mtime 检查）。
		this._warmBundleMtime = this._bundleMtime;
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
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob: https: http: vscode-webview: vscode-resource:; font-src data: vscode-webview: vscode-resource:; connect-src data: blob: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*;">
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
