/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService, type INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { generateUuid } from '../../../../base/common/uuid.js';

export const IDrawioInlineRenderer = createDecorator<IDrawioInlineRenderer>('drawioInlineRenderer');

export interface IDrawioInlineRenderer {
	readonly _serviceBrand: undefined;

	/**
	 * Renders a Draw.io mxGraphModel (XML string) to an SVG string.
	 * Rejects when the markup is invalid or rendering times out.
	 */
	renderToSvg(markup: string, theme?: 'dark' | 'default'): Promise<string>;
}

interface IPendingRequest {
	resolve(svg: string): void;
	reject(err: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

const RENDER_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 30_000;

/**
 * Renders Draw.io diagrams (mxGraphModel XML) to SVG strings using a hidden
 * off-screen webview hosting the `index-render-drawio-inline.js` bundle from the
 * mermaid-chat-features extension. Lives entirely in the renderer process — no
 * extension host round-trip, no visible editor tab.
 *
 * The webview is created lazily on first render request and kept alive for
 * subsequent requests. If it fails to initialize, requests reject and the next
 * request retries from scratch.
 */
export class DrawioInlineRenderer extends Disposable implements IDrawioInlineRenderer {
	declare readonly _serviceBrand: undefined;

	private _webview: IWebviewElement | undefined;
	private _container: HTMLElement | undefined;
	private _readyPromise: Promise<void> | undefined;
	private readonly _pending = new Map<string, IPendingRequest>();

	constructor(
		@IWebviewService private readonly _webviewService: IWebviewService,
		@ILogService private readonly _logService: ILogService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	async renderToSvg(markup: string, theme?: 'dark' | 'default'): Promise<string> {
		if (!markup || !markup.trim()) {
			throw new Error('Draw.io 源码为空，无法渲染');
		}

		try {
			await this._ensureWebview();
		} catch (err) {
			// Allow the next call to retry initialization from scratch.
			this._teardown();
			throw err;
		}

		const webview = this._webview;
		if (!webview) {
			throw new Error('Draw.io 渲染 webview 不可用');
		}

		const requestId = generateUuid();
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(requestId);
				this._logService.error('[DrawioInlineRenderer] render did not complete within ' + RENDER_TIMEOUT_MS + 'ms for request ' + requestId);
				reject(new Error('Draw.io 渲染超时'));
			}, RENDER_TIMEOUT_MS);
			this._pending.set(requestId, { resolve, reject, timer });
			webview.postMessage({ type: 'render', requestId, source: markup, theme });
		});
	}

	private _ensureWebview(): Promise<void> {
		if (!this._readyPromise) {
			this._readyPromise = this._createWebview();
		}
		return this._readyPromise;
	}

	private async _createWebview(): Promise<void> {
		const appRoot = (this._environmentService as INativeEnvironmentService).appRoot;
		const bundleUri = URI.joinPath(
			URI.file(appRoot),
			'out', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media', 'index-render-drawio-inline.js',
		);

		let bundleJs: string;
		try {
			const content = await this._fileService.readFile(bundleUri);
			bundleJs = content.value.toString();
		} catch (err) {
			this._logService.error('[DrawioInlineRenderer] failed to read index-render-drawio-inline.js bundle', err);
			throw new Error('Draw.io 渲染 bundle 不存在（请先构建 agentStudio webview 的 drawio 内联产物）');
		}

		// Off-screen container: maxgraph needs a live DOM to measure text.
		const container = mainWindow.document.createElement('div');
		container.style.position = 'fixed';
		container.style.left = '-9999px';
		container.style.top = '-9999px';
		container.style.width = '1024px';
		container.style.height = '768px';
		container.style.overflow = 'hidden';
		container.setAttribute('data-drawio-inline-renderer', 'true');
		mainWindow.document.body.appendChild(container);
		this._container = container;

		const webview = this._webviewService.createWebviewElement({
			title: 'Draw.io Renderer (hidden)',
			options: {
				enableFindWidget: false,
				retainContextWhenHidden: true,
				disableServiceWorker: true,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [],
			},
			extension: undefined,
		});
		this._webview = webview;
		this._register(webview);

		webview.mountTo(container, mainWindow);

		const nonce = generateUuid().replace(/-/g, '');
		// Escape any `</script` sequences so the inlined bundle cannot break
		// out of its script tag (safe inside JS strings too: `<\/` === `</`).
		const safeJs = bundleJs.replace(/<\/script/gi, '<\\/script');
		webview.setHtml(`<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:; img-src data:;">
	<style>html, body { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; background: transparent; }</style>
</head>
<body>
	<script nonce="${nonce}">${safeJs}</script>
</body>
</html>`);

		const readyPromise = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				listener.dispose();
				this._logService.error('[DrawioInlineRenderer] hidden webview did not signal ready within ' + READY_TIMEOUT_MS + 'ms');
				reject(new Error('Draw.io 渲染 webview 初始化超时'));
			}, READY_TIMEOUT_MS);

			const listener = webview.onMessage((e) => {
				const msg = e.message as { type?: string; requestId?: string; svg?: string; error?: string } | undefined;
				if (!msg || typeof msg !== 'object') {
					return;
				}
				if (msg.type === 'ready') {
					clearTimeout(timer);
					resolve();
					return;
				}
				if (msg.type === 'rendered' && typeof msg.requestId === 'string') {
					const pending = this._pending.get(msg.requestId);
					if (!pending) {
						return;
					}
					this._pending.delete(msg.requestId);
					clearTimeout(pending.timer);
					if (msg.error || !msg.svg) {
						this._logService.error('[DrawioInlineRenderer] render returned no SVG: error=' + (msg.error ?? 'empty'));
						pending.reject(new Error(msg.error || 'Draw.io 渲染返回空结果'));
					} else {
						this._logService.info('[DrawioInlineRenderer] rendered SVG ok');
						pending.resolve(msg.svg);
					}
				}
			});
			this._register(listener);
		});

		await readyPromise;
		this._logService.info('[DrawioInlineRenderer] hidden render webview ready');
	}

	private _teardown(): void {
		this._readyPromise = undefined;
		this._webview?.dispose();
		this._webview = undefined;
		this._container?.remove();
		this._container = undefined;
		for (const [, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Draw.io 渲染 webview 已销毁'));
		}
		this._pending.clear();
	}

	override dispose(): void {
		this._teardown();
		super.dispose();
	}
}
