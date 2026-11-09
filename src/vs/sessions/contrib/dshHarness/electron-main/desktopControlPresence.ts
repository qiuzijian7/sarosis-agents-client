/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros addition (2026-11-09, P2): the desktop-control presence UI —
 *   · a floating always-on-top indicator window ("a Bot is operating, stop here"), and
 *   · a tray menu with "stop / re-allow".
 *
 * ★ Kept as a separate main-process module on purpose: the aux window in
 *   `dshFullWindowContribution.ts` is guarded by very strict DOM invariants
 *   (`mainWindow.document.createElement` + `pointer-events:auto`), and this indicator needs
 *   `setContentProtection(true)` so it does not appear in the Bot's own screenshots.
 *   A dedicated BrowserWindow satisfies both without touching that large file.
 * ★ Zero UI while idle: nothing is created until the relay reports activity / a stop /
 *   a handoff. All switches still default off, so a normal launch is unchanged.
 * ★ No preload / IPC: the indicator's "停止" is a link whose navigation is intercepted by
 *   `will-navigate`, avoiding a new preload bundle and its packaging rules.
 */

import { BrowserWindow, Menu, Tray, nativeImage, screen } from 'electron';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import type { IDesktopControlStatus } from '../common/desktopControlProtocol.js';

const STOP_URL = 'vssaros-desktop-control://stop';
const REARM_URL = 'vssaros-desktop-control://rearm';

export interface IDesktopControlPresenceOptions {
	readonly appRoot: string;
	readonly log: (line: string) => void;
	readonly onStop: () => void;
	readonly onRearm: () => void;
}

function indicatorHtml(status: IDesktopControlStatus): string {
	const state = status.stopped ? '已停止' : status.handoffState === 'user' ? '用户已接管' : 'Bot 正在操作电脑';
	const who = [status.botId, status.appKey].filter(Boolean).join(' · ');
	const action = status.stopped
		? `<a href="${REARM_URL}" class="act">重新允许</a>`
		: `<a href="${STOP_URL}" class="act">停止全部操控</a>`;
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
body{margin:0;font:12px/1.5 system-ui,sans-serif;background:rgba(28,28,30,.94);color:#fff;
 border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:9px 12px;
 display:flex;align-items:center;gap:10px;user-select:none;-webkit-user-select:none}
.dot{width:8px;height:8px;border-radius:50%;background:${status.stopped ? '#888' : '#f0a132'};flex:none}
.txt{flex:1;min-width:0}.sub{color:#aaa;font-size:11px}
a.act{color:#8ec9ff;text-decoration:none;border:1px solid rgba(142,201,255,.5);
 border-radius:6px;padding:2px 8px;white-space:nowrap;cursor:pointer;pointer-events:auto}
</style></head><body>
<span class="dot"></span><span class="txt">${state}<br><span class="sub">${who || '本地 Agent / 电脑操控'}</span></span>${action}
</body></html>`;
}

export class DesktopControlPresence extends Disposable {
	private _tray: Tray | undefined;
	private _indicator: BrowserWindow | undefined;

	constructor(private readonly _opts: IDesktopControlPresenceOptions) {
		super();
	}

	/** Called on every relay status change; idempotent. */
	update(status: IDesktopControlStatus): void {
		const visible = status.active || status.stopped || status.handoffState !== 'idle';
		if (!visible) {
			this._hideIndicator();
			this._destroyTray();
			return;
		}
		this._ensureTray(status);
		this._showIndicator(status);
	}

	private _ensureTray(status: IDesktopControlStatus): void {
		if (this._tray) {
			this._refreshTrayMenu(status);
			return;
		}
		try {
			const icon = nativeImage.createFromPath(join(this._opts.appRoot, 'resources/win32/sessions.ico'));
			if (icon.isEmpty()) {
				this._opts.log('desktop control tray skipped: icon not found');
				return;
			}
			const tray = new Tray(icon);
			tray.setToolTip('VsSaros 电脑操控');
			this._tray = tray;
			this._refreshTrayMenu(status);
		} catch (error) {
			this._opts.log(`desktop control tray unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _refreshTrayMenu(status: IDesktopControlStatus): void {
		if (!this._tray) return;
		const label = status.stopped ? '电脑操控：已停止' : status.handoffState === 'user' ? '电脑操控：用户已接管' : '电脑操控：运行中';
		try {
			this._tray.setContextMenu(Menu.buildFromTemplate([
				{ label, enabled: false },
				{ label: '停止全部操控', click: () => this._opts.onStop() },
				{ label: '重新允许', enabled: status.stopped, click: () => this._opts.onRearm() },
			]));
		} catch (error) {
			this._opts.log(`desktop control tray menu failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _showIndicator(status: IDesktopControlStatus): void {
		const html = indicatorHtml(status);
		const workArea = screen.getPrimaryDisplay().workArea;
		const width = 264;
		const height = 58;
		const bounds = { x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - height - 16, width, height };
		if (!this._indicator || this._indicator.isDestroyed()) {
			try {
				const win = new BrowserWindow({
					...bounds,
					frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
					focusable: false, resizable: false, movable: false, minimizable: false,
					hasShadow: false, show: false,
					webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
				});
				// ★ Keep the indicator out of the Bot's own screenshots.
				win.setContentProtection(true);
				win.webContents.on('will-navigate', (event, url) => {
					event.preventDefault();
					if (url === STOP_URL || url.startsWith(`${STOP_URL}?`)) this._opts.onStop();
					else if (url === REARM_URL || url.startsWith(`${REARM_URL}?`)) this._opts.onRearm();
				});
				win.on('closed', () => { this._indicator = undefined; });
				this._indicator = win;
			} catch (error) {
				this._opts.log(`desktop control indicator unavailable: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		} else {
			this._indicator.setBounds(bounds);
		}
		const win = this._indicator;
		void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
			if (!win.isDestroyed()) win.showInactive();
		}).catch(error => this._opts.log(`desktop control indicator render failed: ${String(error?.message ?? error)}`));
	}

	private _hideIndicator(): void {
		if (this._indicator && !this._indicator.isDestroyed()) {
			this._indicator.destroy();
		}
		this._indicator = undefined;
	}

	private _destroyTray(): void {
		try { this._tray?.destroy(); } catch { /* gone */ }
		this._tray = undefined;
	}

	override dispose(): void {
		this._hideIndicator();
		this._destroyTray();
		super.dispose();
	}
}
