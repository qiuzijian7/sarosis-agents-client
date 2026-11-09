/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros addition (2026-11-09, P0 · read-only): a loopback WebSocket so the dsh Host's
 * `computer` tool can OBSERVE this desktop (screenshot, screen size, this app's windows).
 *
 * Transport mirrors DshRightbarCdpRelay: random loopback port + a token that changes every app
 * start, written to `<runDir>/desktop-control.json` (0600, removed on dispose), refused at the
 * handshake unless the peer is loopback AND holds the token. Policy lives in
 * `common/desktopControlProtocol.ts` and is checked on EVERY request.
 *
 * ★ P0 has no input-injection code whatsoever. All nine served methods are read-only Electron
 * APIs. OS-wide window enumeration, a real control-level accessibility tree, leases, app grants,
 * handoff and user takeover are P1/P2 — see doc/dsb-capability-compat-design.md §5.
 */

import { randomBytes } from 'crypto';
import { promises as fsp, readFileSync, unlinkSync } from 'fs';
import type { IncomingMessage } from 'http';
import type * as wsTypes from 'ws';
import { BrowserWindow, desktopCapturer, powerMonitor, screen } from 'electron';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import {
	DESKTOP_CONTROL_FILE, DESKTOP_CONTROL_PATH, DESKTOP_DEFAULT_MAX_LEVEL, DESKTOP_IDLE_STATUS,
	DESKTOP_OBSERVE_METHODS, DESKTOP_USER_IDLE_THRESHOLD_SECONDS,
	desktopControlRefusal, desktopTokenMatches, foregroundIdleRefusal,
	isForegroundMethod, isPresenceMethod, isProtectedApp, isReadOnlyLevel,
	type DesktopLevel, type IDesktopControlEndpoint, type IDesktopControlStatus,
} from '../common/desktopControlProtocol.js';
import { injectDesktopInput, type IDesktopInputParams } from './desktopInputService.js';

export interface IDesktopControlRelayOptions {
	/** The Host's run dir (`<userData>/dsh-run`). */
	readonly runDir: string;
	readonly log: (line: string) => void;
	/**
	 * P1 ceiling owned by the main process. Default `view` = strictly read-only.
	 * Only an explicit `background` allows the relay to reach the input injection service;
	 * the Host cannot raise it (its request carries no level). `foreground` is P2.
	 */
	readonly maxLevel?: DesktopLevel;
	/**
	 * P2: OS idle seconds, injected so the gate is testable. Defaults to Electron's
	 * `powerMonitor.getSystemIdleTime()`. A platform that cannot report it returns NaN,
	 * and `foregroundIdleRefusal()` refuses (fail-closed).
	 */
	readonly idleSeconds?: () => number;
	readonly userIdleThresholdSeconds?: number;
	/** P2: display-only status consumer (tray / floating indicator). */
	readonly onStatusChange?: (status: IDesktopControlStatus) => void;
}

interface IRelayRequest { id?: unknown; method?: unknown; params?: unknown }

interface IWindowRow {
	readonly windowId: number;
	readonly title: string;
	readonly bounds: { x: number; y: number; width: number; height: number };
	readonly visible: boolean;
	readonly focused: boolean;
	readonly minimized: boolean;
	/** A Bot must never target this window (its own approval card lives here). */
	readonly protected: boolean;
}

export class DesktopControlRelay extends Disposable {
	private readonly _token = randomBytes(24).toString('hex');
	private readonly _file: string;
	private _server: wsTypes.WebSocketServer | undefined;
	private _starting: Promise<string | undefined> | undefined;
	private _disposed = false;
	private readonly _sockets = new Set<wsTypes.WebSocket>();

	private readonly _maxLevel: DesktopLevel;
	private readonly _idleSeconds: () => number;
	private readonly _userIdleThreshold: number;
	private _status: IDesktopControlStatus = DESKTOP_IDLE_STATUS;
	private readonly _statusListeners = new Set<(status: IDesktopControlStatus) => void>();

	/** Tray / indicator subscribe here. @returns disposer */
	onStatusChange(listener: (status: IDesktopControlStatus) => void): () => void {
		this._statusListeners.add(listener);
		listener(this._status);
		return () => this._statusListeners.delete(listener);
	}

	/** Emergency stop: idempotent, never touches the desktop, works at every level. */
	stop(): void {
		this._setStatus({ active: false, stopped: true });
	}

	private _setStatus(patch: Partial<IDesktopControlStatus>): void {
		this._status = { ...this._status, ...patch };
		this._broadcast('status', this._status as unknown as Record<string, unknown>);
		for (const listener of this._statusListeners) {
			try { listener(this._status); } catch { /* one consumer must not break the relay */ }
		}
		try { this._opts.onStatusChange?.(this._status); } catch { /* same */ }
	}

	private _broadcast(method: string, params: Record<string, unknown>): void {
		const frame = JSON.stringify({ type: 'event', method, params });
		for (const socket of this._sockets) {
			try { if (socket.readyState === 1) socket.send(frame); } catch { /* gone */ }
		}
	}

	constructor(private readonly _opts: IDesktopControlRelayOptions) {
		super();
		// P2: `foreground` is reachable only when explicitly configured here AND every
		// foreground call passes the OS idle gate below. Default remains `view` (read-only).
		this._maxLevel = _opts.maxLevel ?? DESKTOP_DEFAULT_MAX_LEVEL;
		this._idleSeconds = _opts.idleSeconds ?? (() => {
			try { return powerMonitor.getSystemIdleTime(); } catch { return Number.NaN; }
		});
		this._userIdleThreshold = _opts.userIdleThresholdSeconds ?? DESKTOP_USER_IDLE_THRESHOLD_SECONDS;
		this._file = join(_opts.runDir, DESKTOP_CONTROL_FILE);
		// A file left by another run is wrong now: its token and port died with it.
		this._removeFile(true);
	}

	/** Starts listening once. @returns the WebSocket URL, or undefined when it could not start. */
	start(): Promise<string | undefined> {
		this._starting ??= this._start().catch(error => {
			this._opts.log(`desktop control relay could not start: ${error instanceof Error ? error.message : String(error)}`);
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
			host: '127.0.0.1', port: 0, maxPayload: 8 * 1024 * 1024,
			verifyClient: (info: { req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
				const remote = info.req.socket.remoteAddress ?? '';
				const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
				if (!loopback || !desktopTokenMatches(info.req.url, this._token)) {
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
		const wsUrl = `ws://127.0.0.1:${port}${DESKTOP_CONTROL_PATH}${this._token}`;
		server.on('connection', socket => this._serve(socket as unknown as wsTypes.WebSocket));
		const endpoint: IDesktopControlEndpoint = { version: 1, wsUrl, pid: process.pid, startedAt: new Date().toISOString() };
		await fsp.mkdir(this._opts.runDir, { recursive: true });
		await fsp.writeFile(this._file, JSON.stringify(endpoint, null, 2), { encoding: 'utf8', mode: 0o600 });
		this._opts.log(`desktop control relay (read-only) listening on 127.0.0.1:${port} (${this._file})`);
		return wsUrl;
	}

	private _serve(socket: wsTypes.WebSocket): void {
		this._sockets.add(socket);
		socket.on('close', () => this._sockets.delete(socket));
		const send = (message: Record<string, unknown>) => {
			if (socket.readyState === 1) {
				socket.send(JSON.stringify(message));
			}
		};
		socket.on('message', data => { void this._handle(data, send); });
	}

	private async _handle(raw: unknown, send: (message: Record<string, unknown>) => void): Promise<void> {
		let request: IRelayRequest;
		try {
			request = JSON.parse(String(raw)) as IRelayRequest;
		} catch {
			send({ id: null, error: { code: -32700, message: 'invalid JSON' } });
			return;
		}
		const id = request.id ?? null;
		// P2 presence methods never touch the desktop, so they bypass the level/idle gates:
		// an emergency stop must still work when all control is switched off.
		if (isPresenceMethod(request.method)) {
			try {
				const result = this._dispatchPresence(String(request.method), request.params);
				send({ id, result });
			} catch (error) {
				send({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
			}
			return;
		}
		// The ceiling lives in the main process, never in the request. Default `view` keeps the
		// hard read-only gate on; only an explicit `background` ceiling can reach input injection.
		const refusal = desktopControlRefusal(request.method, this._maxLevel, isReadOnlyLevel(this._maxLevel));
		if (refusal) {
			send({ id, error: refusal });
			return;
		}
		// ★ Emergency stop stays latched until an explicit re-arm; observing is still allowed.
		if (this._status.stopped && !DESKTOP_OBSERVE_METHODS.has(String(request.method))) {
			send({ id, error: { code: -32001, message: '用户已停止电脑操控；观察类方法仍可用，动作类需重新开启。' } });
			return;
		}
		// ★ P2: foreground methods additionally require the person to be idle. This lives in
		// the main process because only it can read OS idle time; the Host cannot waive it.
		if (isForegroundMethod(request.method)) {
			const idle = (() => { try { return this._idleSeconds(); } catch { return Number.NaN; } })();
			const idleRefusal = foregroundIdleRefusal(idle, this._userIdleThreshold);
			if (idleRefusal) {
				send({ id, error: idleRefusal });
				return;
			}
		}
		try {
			const result = await this._dispatch(String(request.method), request.params);
			send({ id, result });
		} catch (error) {
			send({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
		}
	}

	/** Clear an emergency stop; only the tray/user can call it (never a Host request). */
	rearm(): void {
		this._setStatus({ stopped: false });
	}

	/** Presence-only dispatch, deliberately separate so the guarded path has one `_dispatch` call. */
	private _dispatchPresence(method: string, params: unknown): Record<string, unknown> {
		switch (method) {
			case 'stop':
				this.stop();
				return { ok: true, stopped: true };
			case 'reportStatus': {
				// Display metadata only — whitelist fields and clamp lengths; never credentials/pixels.
				const raw = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
				const handoffState = ['idle', 'pending', 'user'].includes(String(raw.handoffState))
					? raw.handoffState as IDesktopControlStatus['handoffState'] : undefined;
				this._setStatus({
					active: raw.active === true,
					botId: typeof raw.botId === 'string' ? raw.botId.slice(0, 80) : '',
					appKey: typeof raw.appKey === 'string' ? raw.appKey.slice(0, 120) : '',
					...(handoffState ? { handoffState } : {}),
				});
				return { ok: true };
			}
			default:
				throw new Error(`unsupported presence method ${method}`);
		}
	}

	private async _dispatch(method: string, params: unknown): Promise<Record<string, unknown>> {
		switch (method) {
			case 'getStatus':
				return { ...this._status } as unknown as Record<string, unknown>;
			case 'getVersion':
				return {
					protocol: 'vssaros-desktop-control', version: 1,
					p0ReadOnly: isReadOnlyLevel(this._maxLevel), level: this._maxLevel,
					platform: process.platform, methods: [...DESKTOP_OBSERVE_METHODS],
				};
			case 'checkPermissions':
				return {
					platform: process.platform,
					level: this._maxLevel,
					p0ReadOnly: isReadOnlyLevel(this._maxLevel),
					screenCapture: 'available',
					inputInjection: !isReadOnlyLevel(this._maxLevel),
					foregroundEnabled: this._maxLevel === 'foreground',
					userIdleGate: true,
					userIdleThresholdSeconds: this._userIdleThreshold,
					osWindowEnumeration: false,
					note: 'OS-wide enumeration, a control-level accessibility tree and foreground actions are P2',
				};
			case 'getScreenSize': {
				const display = screen.getPrimaryDisplay();
				return {
					width: display.size.width, height: display.size.height,
					scaleFactor: display.scaleFactor,
					workArea: display.workArea,
				};
			}
			case 'getCursorPosition': {
				const point = screen.getCursorScreenPoint();
				return { x: point.x, y: point.y };
			}
			case 'listWindows':
				return { scope: 'self-only', windows: this._windows() };
			case 'listApps':
				return {
					scope: 'self-only',
					apps: [{ name: 'VsSaros', pid: process.pid, windowCount: this._windows().length, protected: true }],
				};
			case 'getWindowState': {
				const windowId = (params as { windowId?: unknown } | undefined)?.windowId;
				const row = this._windows().find(candidate => candidate.windowId === windowId);
				if (!row) {
					throw new Error(`window ${String(windowId)} not found (P0 lists this app's windows only)`);
				}
				return { ...row };
			}
			case 'getAccessibilityTree':
				// P0 is explicit about being coarse: a window-level structure, NOT a control tree.
				return {
					coarse: true, scope: 'self-only',
					note: 'P0 returns window-level structure only; control-level UIA/AX tree is P1',
					windows: this._windows(),
				};
			case 'screenshot':
				return await this._screenshot();
			case 'click':
			case 'doubleClick':
			case 'rightClick':
			case 'typeText':
			case 'pressKey':
			case 'hotkey':
			case 'scroll':
			case 'drag':
			case 'movePointer':
			case 'activateApp':
				// Reached only after the method allowlist AND (for foreground) the OS idle gate.
				return { ...(await injectDesktopInput(method, params as IDesktopInputParams)) };
			case 'setValue':
			case 'showWindow':
			case 'launchApp':
			case 'clipboardRead':
				throw new Error(`${method} 在 P1 未实现（窗口/OS 动作属 P2）`);
			default:
				throw new Error(`unsupported method ${method}`);
		}
	}

	private _windows(): IWindowRow[] {
		return BrowserWindow.getAllWindows()
			.filter(win => !win.isDestroyed())
			.map(win => {
				const bounds = win.getBounds();
				const title = win.getTitle();
				return {
					windowId: win.id,
					title,
					bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
					visible: win.isVisible(),
					focused: win.isFocused(),
					minimized: win.isMinimized(),
					protected: isProtectedApp(title),
				};
			});
	}

	private async _screenshot(): Promise<Record<string, unknown>> {
		const sources = await desktopCapturer.getSources({
			types: ['screen'],
			thumbnailSize: { width: 1280, height: 720 },
		});
		if (sources.length === 0) {
			throw new Error('no screen source available');
		}
		const primary = screen.getPrimaryDisplay();
		const source = sources.find(candidate => candidate.display_id === String(primary.id)) ?? sources[0];
		const image = source.thumbnail;
		const size = image.getSize();
		return {
			mimeType: 'image/png',
			dataUrl: image.toDataURL(),
			width: size.width,
			height: size.height,
			sourceName: source.name,
		};
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
		for (const socket of [...this._sockets]) {
			try { socket.close(); } catch { /* closed */ }
		}
		this._sockets.clear();
		try { this._server?.close(); } catch { /* closing */ }
		this._removeFile(false);
		super.dispose();
	}
}
