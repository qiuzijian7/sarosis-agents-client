/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros addition (2026-11-07, P0 · one browser): the right sidebar browser as a CDP endpoint for the Host's `browser`
 * tool, so the page a person sees in the right sidebar is the page the model operates (same view, same Global login).
 *
 * - Transport: a loopback WebSocket (`ws`, imported when it starts) on a random port, at a path holding a random token
 *   that changes with every app start; the Host learns it from `<runDir>/rightbar-cdp.json` (written 0600, removed on
 *   dispose). A client without the token is refused at the handshake.
 * - Protocol: one platform `BrowserViewGroup` (its `CDPBrowserProxy` serves `Target.*` with flatten sessions) per client,
 *   holding the right sidebar's views (`vssaros-rightbar-browser-*`) only; they are synced in before every target query,
 *   since those views are made by `getOrCreateBrowserView`, which fires no creation event. Visible views come first.
 * - Policy (`common/dshRightbarCdp.ts`): a method allowlist — no new pages, no closing the person's view, no
 *   `Browser.close`, no browser contexts — and http(s)-only navigation that never reaches cloud metadata addresses.
 *   `Storage.getCookies` is answered from the views' Electron session (the proxy has no Storage domain).
 * - 2026-11-07 (combined approach, after DS Bot): `VsSaros.ensureRightbarPage` creates the one shared view
 *   (`RIGHTBAR_SHARED_VIEW_ID`), hidden, when the tool needs a page and the right sidebar has none — the tool never
 *   falls back to a second browser while VsSaros runs, and the tab shows that same view when a person opens it.
 *   Nothing pops up: the person sees it by opening the tab (or "take over" on a handoff).
 */

import { randomBytes } from 'crypto';
import { promises as fsp, readFileSync, unlinkSync } from 'fs';
import type { IncomingMessage } from 'http';
import type * as wsTypes from 'ws';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { BrowserViewGroup } from '../../../../platform/browserView/electron-main/browserViewGroup.js';
import type { IProductService } from '../../../../platform/product/common/productService.js';
import type { CDPEvent, CDPResponse } from '../../../../platform/browserView/common/cdp/types.js';
import {
	cdpCookieOf, RIGHTBAR_CDP_FILE, RIGHTBAR_CDP_PATH, RIGHTBAR_ENSURE_PAGE_METHOD, RIGHTBAR_SHARED_VIEW_ID, RIGHTBAR_VIEW_ID_PREFIX,
	rightbarCdpRefusal, rightbarTokenMatches,
	type IRightbarCdpEndpoint,
} from '../common/dshRightbarCdp.js';

export interface IDshRightbarCdpRelayOptions {
	/** The Host's run dir (`<userData>/dsh-run`), where the discovery file goes. */
	readonly runDir: string;
	readonly browserViews: IBrowserViewMainService;
	readonly productService: IProductService;
	readonly log: (line: string) => void;
	/**
	 * The window to own the shared view when the relay creates it (2026-11-07); undefined when there is no window
	 * (the tool then uses Chrome). A view only needs an owner for its lifecycle: it is shown where the tab places it.
	 */
	readonly ownerWindowId?: () => number | undefined;
}

/** What a client sent, as far as the relay reads it. */
interface IRelayRequest { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown }

export class DshRightbarCdpRelay extends Disposable {
	private readonly _token = randomBytes(24).toString('hex');
	private readonly _file: string;
	private _server: wsTypes.WebSocketServer | undefined;
	private _starting: Promise<string | undefined> | undefined;
	private _disposed = false;
	/** The connected clients' groups. */
	private readonly _clients = new Set<DisposableStore>();

	constructor(private readonly _opts: IDshRightbarCdpRelayOptions) {
		super();
		this._file = join(_opts.runDir, RIGHTBAR_CDP_FILE);
		// A file another run left is wrong now (its token and port died with it).
		this._removeFile(true);
	}

	/** Starts listening (once). @returns the WebSocket URL, or undefined when it could not start (the tool then uses Chrome). */
	start(): Promise<string | undefined> {
		this._starting ??= this._start().catch(error => {
			this._opts.log(`rightbar CDP relay could not start: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		});
		return this._starting;
	}

	private async _start(): Promise<string | undefined> {
		const ws = await import('ws');
		if (this._disposed) {
			return undefined;
		}
		const server = new ws.WebSocketServer({
			host: '127.0.0.1', port: 0, maxPayload: 64 * 1024 * 1024,
			verifyClient: (info: { req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
				const remote = info.req.socket.remoteAddress ?? '';
				const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
				if (!loopback || !rightbarTokenMatches(info.req.url, this._token)) {
					done(false, 403, 'Forbidden');
					return;
				}
				done(true);
			},
		});
		this._server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('listening', () => resolve());
			server.once('error', reject);
		});
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		const wsUrl = `ws://127.0.0.1:${port}${RIGHTBAR_CDP_PATH}${this._token}`;
		server.on('connection', socket => this._serve(socket as unknown as wsTypes.WebSocket));
		const endpoint: IRightbarCdpEndpoint = { version: 1, wsUrl, pid: process.pid, startedAt: new Date().toISOString() };
		await fsp.mkdir(this._opts.runDir, { recursive: true });
		await fsp.writeFile(this._file, JSON.stringify(endpoint, null, 2), { encoding: 'utf8', mode: 0o600 });
		this._opts.log(`rightbar CDP relay listening on 127.0.0.1:${port} (${this._file})`);
		return wsUrl;
	}

	/** One client: its own group of the right sidebar's views, and the policy on every request. */
	private _serve(socket: wsTypes.WebSocket): void {
		const store = new DisposableStore();
		const group = store.add(new BrowserViewGroup(`vssaros-rightbar-${generateUuid()}`, { mainWindowId: -1 }, this._opts.browserViews, this._opts.productService));
		/** viewId → the view's page targetId, for the views in the group. */
		const targets = new Map<string, string>();
		const send = (message: CDPResponse | CDPEvent | Record<string, unknown>) => {
			if (socket.readyState === 1) {
				socket.send(JSON.stringify(message));
			}
		};
		store.add(group.onCDPMessage(message => send(message)));
		/** Brings the right sidebar's views into the group. @returns the visible ones' targetIds. */
		const sync = async (): Promise<Set<string>> => {
			const infos = (await this._opts.browserViews.getBrowserViews()).filter(info => info.id.startsWith(RIGHTBAR_VIEW_ID_PREFIX));
			const visible = new Set<string>();
			for (const info of infos) {
				if (!targets.has(info.id)) {
					const view = this._opts.browserViews.tryGetBrowserView(info.id);
					if (!view) {
						continue;
					}
					await group.addView(info.id);
					targets.set(info.id, (await view.debugger.getTargetInfo()).targetId);
				}
				if (info.state.visible) {
					visible.add(targets.get(info.id)!);
				}
			}
			for (const viewId of [...targets.keys()]) {
				if (!infos.some(info => info.id === viewId)) {
					targets.delete(viewId);
				}
			}
			return visible;
		};
		const handle = async (request: IRelayRequest) => {
			const id = typeof request.id === 'number' ? request.id : -1;
			const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : undefined;
			const reply = (body: { result?: unknown; error?: { code: number; message: string } }) => send({ id, ...body, ...(sessionId ? { sessionId } : {}) });
			const refusal = rightbarCdpRefusal(request.method, request.params, request.sessionId);
			if (refusal) {
				reply({ error: refusal });
				return;
			}
			const method = request.method as string;
			try {
				if (method === 'Storage.getCookies') {
					// The right sidebar's views share one Electron session (Global storage): read its cookies.
					await sync();
					const view = [...targets.keys()].map(viewId => this._opts.browserViews.tryGetBrowserView(viewId)).find(Boolean);
					const cookies = view ? await view.session.electronSession.cookies.get({}) : [];
					reply({ result: { cookies: cookies.map(cdpCookieOf) } });
					return;
				}
				if (method === RIGHTBAR_ENSURE_PAGE_METHOD) {
					// 2026-11-07 (combined approach, after DS Bot's main-owned views): the tool needs a page and the right
					// sidebar has none ⇒ create the shared view, hidden; a person sees it when they open the tab. No
					// second page ever: with a view already there this does nothing.
					await sync();
					let created = false;
					if (targets.size === 0) {
						const mainWindowId = this._opts.ownerWindowId?.();
						if (mainWindowId === undefined) {
							reply({ error: { code: -32000, message: 'no VsSaros window to own the right sidebar browser' } });
							return;
						}
						await this._opts.browserViews.getOrCreateBrowserView(RIGHTBAR_SHARED_VIEW_ID, { owner: { mainWindowId }, scope: BrowserViewStorageScope.Global });
						created = true;
						this._opts.log(`rightbar browser: created the shared view hidden (owner window ${mainWindowId}) for the Host's browser tool`);
						await sync();
					}
					reply({ result: { created, targetId: targets.get(RIGHTBAR_SHARED_VIEW_ID) ?? [...targets.values()][0] } });
					return;
				}
				if (method === 'Target.getTargets' || method === 'Target.attachToTarget' || method === 'Target.getTargetInfo') {
					const visible = await sync();
					if (method === 'Target.getTargets') {
						const result = await group.debugger.sendCommand('Target.getTargets') as { targetInfos?: { targetId: string }[] };
						const infos = [...(result.targetInfos ?? [])].sort((a, b) => Number(visible.has(b.targetId)) - Number(visible.has(a.targetId)));
						reply({ result: { targetInfos: infos } });
						return;
					}
				}
				await group.sendCDPMessage({ id, method, params: request.params, ...(sessionId ? { sessionId } : {}) });
			} catch (error) {
				reply({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
			}
		};
		socket.on('message', (data: wsTypes.RawData) => {
			let request: IRelayRequest;
			try {
				request = JSON.parse(String(data)) as IRelayRequest;
			} catch {
				return;
			}
			void handle(request);
		});
		socket.on('close', () => { this._clients.delete(store); store.dispose(); });
		socket.on('error', () => { this._clients.delete(store); store.dispose(); });
		this._clients.add(store);
		store.add({ dispose: () => { try { socket.close(); } catch { /* closed */ } } });
	}

	private _removeFile(onlyStale: boolean): void {
		try {
			if (onlyStale) {
				const pid = (JSON.parse(readFileSync(this._file, 'utf8')) as { pid?: unknown }).pid;
				if (pid === process.pid) {
					return;
				}
			}
			unlinkSync(this._file);
		} catch {
			/* no file */
		}
	}

	override dispose(): void {
		this._disposed = true;
		for (const client of [...this._clients]) {
			client.dispose();
		}
		this._clients.clear();
		try {
			this._server?.close();
		} catch {
			/* closing */
		}
		this._removeFile(false);
		super.dispose();
	}
}
