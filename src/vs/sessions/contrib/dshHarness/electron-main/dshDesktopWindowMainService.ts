/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * B 方案：启动时不创建 IDE/sessions 主窗口，由主进程直接创建 dsh desktop 壳。
 *
 * 该窗口通过 `IAuxiliaryWindowsMainService.registerWindow()` 登记，令 `windowId` 等于
 * `webContents.id`；`DshViewHost._windowById()` 因此能找到它并挂接 WebContentsView。
 * 页面侧逻辑放在轻量 `dshDesktop.html` / `dshDesktop.ts`，不加载整套 workbench。
 */

import { BrowserWindow } from 'electron';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IAuxiliaryWindowsMainService } from '../../../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import product from '../../../../platform/product/common/product.js';
import { DSH_DESKTOP_CAPTION_H } from '../common/dshHarness.js';

let activeDesktopWindow: BrowserWindow | undefined;

/** 供单实例 handoff 无层依赖地聚焦已存在的 desktop 窗口。 */
export function focusDshDesktopWindow(): boolean {
	const win = activeDesktopWindow;
	if (!win || win.isDestroyed()) {
		return false;
	}
	if (!win.isVisible()) {
		win.show();
	}
	if (win.isMinimized()) {
		win.restore();
	}
	win.focus();
	return true;
}

/**
 * B 方案 desktop 窗口不是 VS Code 的 `CodeWindow`，不进 `IWindowsMainService` 名册。
 * 窗口生命周期判据需要直接问它是否仍存活，避免「还有 desktop，却被当成最后一扇窗口」。
 */
export function getActiveDshDesktopWindow(): BrowserWindow | undefined {
	const win = activeDesktopWindow;
	return win && !win.isDestroyed() ? win : undefined;
}

export class DshDesktopWindowMainService extends Disposable {

	private _win: BrowserWindow | undefined;
	private _quitting = false;
	private _disposed = false;

	constructor(
		private readonly windowsMainService: IWindowsMainService,
		private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		private readonly lifecycleMainService: ILifecycleMainService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly logService: ILogService,
	) {
		super();
	}

	get windowId(): number | undefined {
		return this._win && !this._win.isDestroyed() ? this._win.webContents.id : undefined;
	}

	focus(): boolean {
		return focusDshDesktopWindow();
	}

	async openDesktopWindow(): Promise<BrowserWindow> {
		if (this._win && !this._win.isDestroyed()) {
			this.focus();
			return this._win;
		}

		const preload = FileAccess.asFileUri('vs/base/parts/sandbox/electron-browser/preload-aux.js').fsPath;
		const win = new BrowserWindow({
			width: 1280,
			height: 840,
			show: true,
			title: 'VsSaros — Desktop',
			backgroundColor: '#1f1f1f',
			...(isWindows ? {
				titleBarStyle: 'hidden' as const,
				// 高度与壳页面自绘 caption 共用同一个常量：原生窗控带比 DOM 标题条高时，
				// 最小化按钮左侧会出现一条 3px 的台阶（2026-11-24 真机截图）。
				titleBarOverlay: { color: '#1f1f1f', symbolColor: '#cccccc', height: DSH_DESKTOP_CAPTION_H },
			} : {}),
			webPreferences: {
				preload,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webviewTag: false,
				spellcheck: false,
			},
		});
		this._win = win;
		activeDesktopWindow = win;
		win.setMenu(null);

		// 直接创建的窗口没有 opener，必须显式登记；`DshViewHost` 按 webContents.id 找窗口。
		this.auxiliaryWindowsMainService.registerWindow(win.webContents);
		const windowId = win.webContents.id;
		this.logService.info(`[dshDesktopOnly] desktop window created: windowId=${windowId} appRoot=${this.environmentMainService.appRoot}`);

		win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		win.webContents.on('will-navigate', event => event.preventDefault());
		win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
			this.logService.error(`[dshDesktopOnly] desktop shell failed to load: ${errorCode} ${errorDescription}`);
		});

		win.once('closed', () => {
			activeDesktopWindow = undefined;
			this._win = undefined;
			if (this._disposed || this._quitting) {
				return;
			}
			// 用户按需打开过 IDE 时，关掉 desktop 不应把 IDE 一起带走。
			if (this.windowsMainService.getWindowCount() > 0) {
				return;
			}
			this._quitting = true;
			void this.lifecycleMainService.quit();
		});

		const html = FileAccess.asBrowserUri('vs/sessions/electron-browser/dshDesktop.html').toString(true);
		// 轻量壳不加载 workbench ⇒ 没有 IProductService。品牌名 / 版本号由主进程随 URL 下发，
		// caption 才能显示与 IDE 窗口一致的 logo 名称与版本（2026-11-24）。
		const query = [
			`windowId=${encodeURIComponent(String(windowId))}`,
			`version=${encodeURIComponent(String(product.version ?? ''))}`,
			`brand=${encodeURIComponent(String(product.nameShort || 'VsSaros'))}`,
		].join('&');
		await win.loadURL(`${html}?${query}`);
		return win;
	}

	override dispose(): void {
		this._disposed = true;
		const win = this._win;
		if (win && !win.isDestroyed()) {
			win.close();
		}
		activeDesktopWindow = undefined;
		this._win = undefined;
		super.dispose();
	}
}
