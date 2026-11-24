/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * B 方案的 desktop-only 壳：不加载 workbench、不创建 IDE 贡献图，只通过已有的
 * `DSH_HARNESS_CHANNEL` 启动 Host 并挂接一个 dsh `WebContentsView`。
 *
 * ★ 2026-11-24：壳自己画 caption（logo / 品牌名 / 版本号 / 「应用 · 编辑」菜单）。
 *   IDE 渲染进程里 `DshFullWindowContribution._installTitleBar` 的那套标题条只在 A 方案
 *   aux 窗口里执行；B 方案默认启动**没有 IDE 主窗口** ⇒ 必须在这里补齐，菜单动作经
 *   `DesktopMenuAction` / `DesktopMenuCommand` 两条通道命令落到主进程。
 */

import { popup } from '../../base/parts/contextmenu/electron-browser/contextmenu.js';
import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-browser/mainProcessService.js';
import { webFrame } from '../../base/parts/sandbox/electron-browser/globals.js';
import { DSH_DESKTOP_CAPTION_H, DSH_HARNESS_CHANNEL, DshHarnessChannelCommand, IDshHostStatus, IDshViewBounds } from '../contrib/dshHarness/common/dshHarness.js';
import { desktopMenuLabel, desktopMenuNames, dshDesktopMenuTemplate, type DshDesktopMenuAction, type DshDesktopMenuCommand, type DshDesktopMenuName } from '../contrib/dshHarness/common/dshDesktopMenu.js';

/** `navigator.windowControlsOverlay` 的投影（与 dsh-better-sidebar 的 viewport-inset 同口径）。 */
interface WindowControlsOverlayLike {
	readonly visible: boolean;
	getTitlebarAreaRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	addEventListener(type: 'geometrychange', listener: () => void): void;
}

interface CaptionActions {
	act(action: DshDesktopMenuAction): void;
	run(command: DshDesktopMenuCommand): void;
}

function windowControlsOverlay(): WindowControlsOverlayLike | undefined {
	return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }).windowControlsOverlay;
}

/**
 * caption 高度的**唯一运行时真源**是 WCO 的 `getTitlebarAreaRect()`，`DSH_DESKTOP_CAPTION_H`
 * 只是下限。原生窗控带（右侧 138px）由 Electron 画在 DOM 之上，DOM 标题条只要不低于它，
 * 两者同色就会连成一条 ⇒ 最小化按钮左侧不再出现台阶；`#root` 用同一个变量让位，
 * 窗口最大化 / DPI / 缩放变化时 `geometrychange` + `resize` 都会重新校准。
 */
function syncCaptionHeight(): void {
	let height = DSH_DESKTOP_CAPTION_H;
	try {
		const overlay = windowControlsOverlay();
		if (overlay?.visible) {
			const rect = overlay.getTitlebarAreaRect();
			const bottom = Math.round(rect.y + rect.height);
			if (Number.isFinite(bottom) && bottom > height) {
				height = bottom;
			}
		}
	} catch { /* 没有 WCO（macOS / Web）⇒ 用下限 */ }
	document.documentElement.style.setProperty('--dsh-caption-h', `${height}px`);
}

function zoomFactor(): number {
	try {
		return webFrame.getZoomFactor();
	} catch {
		return 1;
	}
}

function showBooting(message: string): void {
	const booting = document.getElementById('booting');
	if (booting) {
		booting.textContent = message;
	}
}

/** 弹 caption 菜单：与 A 方案 `_openDesktopMenu` 同口径（同步打开 + 原生 popup + aria 兜底复位）。 */
function openDesktopMenu(name: DshDesktopMenuName, button: HTMLButtonElement, actions: CaptionActions): void {
	const now = Date.now();
	if (now - Number(button.getAttribute('data-vssaros-menu-opened-at') || 0) < 250) {
		return;
	}
	button.setAttribute('data-vssaros-menu-opened-at', String(now));
	const zoom = zoomFactor();
	const items = dshDesktopMenuTemplate(name, 'zh', zoom, {
		act: action => actions.act(action),
		run: command => actions.run(command),
	});
	const rect = button.getBoundingClientRect();
	const reset = () => button.setAttribute('aria-expanded', 'false');
	button.setAttribute('aria-expanded', 'true');
	try {
		// `popup()` 是 Electron 原生菜单，画在所有 WebContentsView 之上；DOM 菜单会被盖住 ✗。
		popup(items, { x: Math.round(rect.left * zoom), y: Math.round(rect.bottom * zoom) }, reset);
	} catch (error) {
		reset();
		console.warn('[dshDesktopOnly] caption menu: 原生菜单弹不出来', error);
	}
	// onHide 没回发时兜底复位，否则 aria 永久卡 true（A 方案真机踩过）。
	window.setTimeout(() => {
		if (button.getAttribute('aria-expanded') === 'true') {
			reset();
		}
	}, 15_000);
}

function installCaption(version: string, brand: string, actions: CaptionActions): void {
	const brandEl = document.getElementById('dsh-brand');
	if (brandEl) {
		brandEl.textContent = brand;
	}
	const versionEl = document.getElementById('dsh-version');
	if (versionEl) {
		versionEl.textContent = version ? `v${version}` : '';
	}

	syncCaptionHeight();
	windowControlsOverlay()?.addEventListener('geometrychange', syncCaptionHeight);
	window.addEventListener('resize', syncCaptionHeight);

	const menubar = document.getElementById('dsh-menubar');
	if (!menubar) {
		return;
	}
	const buttons: HTMLButtonElement[] = [];
	for (let i = 0; i < desktopMenuNames.length; i++) {
		const name: DshDesktopMenuName = desktopMenuNames[i];
		const btn = document.createElement('button');
		btn.className = 'menu-btn';
		btn.type = 'button';
		btn.setAttribute('role', 'menuitem');
		btn.setAttribute('aria-haspopup', 'menu');
		btn.setAttribute('aria-expanded', 'false');
		btn.setAttribute('data-vssaros-desktop-menu', name);
		btn.tabIndex = i === 0 ? 0 : -1;
		btn.textContent = desktopMenuLabel(name, 'zh');
		// 打开菜单不抢走 composer 焦点：编辑菜单的按键由主进程 `sendInputEvent` 送回聚焦视图。
		btn.addEventListener('pointerdown', e => e.preventDefault());
		btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
		btn.addEventListener('click', () => openDesktopMenu(name, btn, actions));
		btn.addEventListener('keydown', e => {
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				e.preventDefault();
				const next = buttons[i === 0 ? 1 : 0];
				if (next) {
					btn.tabIndex = -1;
					next.tabIndex = 0;
					next.focus();
				}
			} else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				openDesktopMenu(name, btn, actions);
			}
		});
		buttons.push(btn);
		menubar.appendChild(btn);
	}
}

async function main(): Promise<void> {
	const params = new URLSearchParams(location.search);
	const windowId = Number(params.get('windowId'));
	if (!Number.isInteger(windowId) || windowId <= 0) {
		showBooting('启动失败：缺少合法的 windowId');
		return;
	}

	const mainProcessService = new ElectronIPCMainProcessService(windowId);
	window.addEventListener('beforeunload', () => mainProcessService.dispose());
	const channel = mainProcessService.getChannel(DSH_HARNESS_CHANNEL);

	const claimed = await channel.call<boolean>(DshHarnessChannelCommand.ClaimDesktopAutoOpen, { windowId });
	if (!claimed) {
		showBooting('已经有一扇 dsh 桌面窗口，本窗口不再重复创建');
		return;
	}

	const root = document.getElementById('root');
	if (!root) {
		showBooting('启动失败：缺少视图容器');
		return;
	}

	const viewId = `dsh-desktop-${windowId}-${Date.now().toString(36)}`;
	// 品牌名 / 版本号由主进程随 URL 下发（轻量页没有 IProductService）。
	installCaption(params.get('version') ?? '', params.get('brand') || 'VsSaros', {
		act: action => {
			void channel.call(DshHarnessChannelCommand.DesktopMenuAction, { viewId, action }).catch(() => undefined);
		},
		run: command => {
			void channel.call(DshHarnessChannelCommand.DesktopMenuCommand, { windowId, command }).catch(() => undefined);
		},
	});

	// 先建视图槽：DshViewHost 在没有连接时会保留 slot，等 `_applyConnection()`
	// 下发连接后立即加载 ⇒ 不必等 Bootstrap 返回才开始创建 WebContentsView ✓。
	showBooting('正在准备 dsh 桌面视图…');
	await channel.call<void>(DshHarnessChannelCommand.CreateView, {
		viewId,
		windowId,
		surface: 'chat',
		// ★ B 方案是产品主界面，不是 IDE 内嵌聊天框：必须保留 dsh 官方左侧栏/右栏/品牌头。
		// `chatOnlyUi: true` 会让 preload 注入 `[data-slot="sidebar"] { display:none }`，
		// 并把 `data-vssaros-chat-only=1`，侧栏与多根工作区换皮 chunk 都不会加载 ✗。
		chatOnlyUi: false,
		isolatedPool: true,
		// 自主窗口的明暗交给 dsh「外观」；不要再传 IDE 的 colorScheme 覆盖它。
		dshOwnWindow: true,
	});

	let lastLayoutKey = '';
	const layout = () => {
		const rect = root.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) {
			return;
		}
		const zoom = zoomFactor();
		const key = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height), zoom].join(',');
		if (key === lastLayoutKey) {
			return;
		}
		lastLayoutKey = key;
		const bounds: IDshViewBounds = { windowId, x: rect.left, y: rect.top, width: rect.width, height: rect.height, zoomFactor: zoom };
		void channel.call<void>(DshHarnessChannelCommand.LayoutView, { viewId, bounds });
	};

	layout();
	const observer = new ResizeObserver(layout);
	observer.observe(root);
	window.addEventListener('resize', layout);
	window.setInterval(layout, 500);

	// 换皮锚点出现前不许因为窗口获得焦点而提前 `setViewVisible(true)`（会闪官方默认样式）。
	let viewVisible = false;
	const focusView = () => {
		if (!viewVisible) {
			return;
		}
		void channel.call<void>(DshHarnessChannelCommand.SetViewVisible, { viewId, visible: true, focus: true }).catch(() => undefined);
	};
	window.addEventListener('focus', focusView);

	document.getElementById('open-ide')?.addEventListener('click', () => {
		void channel.call<boolean>(DshHarnessChannelCommand.OpenIdeWindow).catch(error => {
			showBooting(`打开 IDE 失败：${String((error as Error)?.message ?? error)}`);
		});
	});

	showBooting('正在准备 dsh 运行环境…');
	try {
		await channel.call<IDshHostStatus>(DshHarnessChannelCommand.Bootstrap, { start: {} });
	} catch (error) {
		await channel.call<void>(DshHarnessChannelCommand.DisposeView, { viewId }).catch(() => undefined);
		showBooting(`dsh 运行环境启动失败：${String((error as Error)?.message ?? error)}`);
		return;
	}

	// 两个换皮锚点用一次 querySelector 并集等待：旧版页签条 / 新版 guide 根节点谁先出现都算就绪。
	// 旧壳串行 1.5s + 7.5s；这里单次 5s 有界等待，超时照常显示，避免白屏。
	const skinSelector = '[data-vssaros-wb-tabstrip],[data-vssaros-guide-root]';
	showBooting('正在加载 dsh 桌面界面…');
	const vssarosReady = await channel.call<boolean>(DshHarnessChannelCommand.WaitViewSelector, { viewId, selector: skinSelector, timeoutMs: 5000 }).catch(() => false);
	if (!vssarosReady) {
		console.warn('[dshDesktopOnly] 换皮锚点等待超时 ⇒ 直接显示页面');
	}
	viewVisible = true;
	focusView();
	document.getElementById('booting')?.remove();
}

void main().catch(error => {
	showBooting(`dsh 桌面窗口启动失败：${String((error as Error)?.message ?? error)}`);
});
