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
import { DSH_DESKTOP_CAPTION_H, DSH_HARNESS_CHANNEL, DshHarnessChannelCommand, DshHarnessChannelEvent, IDshHostStatus, IDshViewBounds } from '../contrib/dshHarness/common/dshHarness.js';
import { desktopMenuLabel, desktopMenuNames, dshDesktopMenuTemplate, type DshDesktopMenuAction, type DshDesktopMenuCommand, type DshDesktopMenuName } from '../contrib/dshHarness/common/dshDesktopMenu.js';
import { ensureDesktopHostRunning } from '../contrib/dshHarness/common/dshDesktopSessionStart.js';
import { BOOT_STAGES, BOOT_STUCK_HINT_MS, BootTimeline, formatDuration, type BootStageId, type IBootStageView } from '../contrib/dshHarness/common/dshBootTimeline.js';

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

interface IBootUI {
	readonly root: HTMLElement;
	readonly title: HTMLElement;
	readonly message: HTMLElement;
	readonly total: HTMLElement;
	readonly list: HTMLElement;
	readonly hint: HTMLElement;
}

/** 页面脚本一执行就开始计时：四个阶段 + 主进程进度派生的子步骤，各自记耗时。 */
const boot = new BootTimeline();
let bootUI: IBootUI | undefined;
let bootTimer: number | undefined;

/** 伴生插件直装能刷出十几条进度，只留最近几条，否则面板会顶出屏幕。 */
const BOOT_VISIBLE_STEPS = 5;
/** 启动够慢时，完成汇总停留一小会儿再显示视图（原生 WebContentsView 会盖住 DOM 覆盖层）。 */
const BOOT_SUMMARY_HOLD_MS = 1_200;

function el(tag: string, className: string): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	return node;
}

function renderBootStage(stage: IBootStageView): HTMLElement {
	const row = el('div', `boot-stage is-${stage.state}`);
	const head = el('div', 'boot-stage-head');
	const mark = el('span', 'boot-mark');
	mark.textContent = stage.state === 'done' ? '✓' : stage.state === 'failed' ? '✕' : stage.state === 'running' ? '●' : '○';
	const label = el('span', 'boot-stage-label');
	label.textContent = stage.label;
	const time = el('span', 'boot-stage-time');
	time.textContent = stage.state === 'pending' ? '待进行' : formatDuration(stage.elapsedMs);
	head.append(mark, label, time);
	row.append(head);

	const detail = el('div', 'boot-stage-detail');
	detail.textContent = stage.detail;
	row.append(detail);

	if (stage.steps.length) {
		const steps = el('div', 'boot-steps');
		const hidden = stage.steps.length - BOOT_VISIBLE_STEPS;
		if (hidden > 0) {
			const more = el('div', 'boot-step is-more');
			const moreLabel = el('span', 'boot-step-label');
			moreLabel.textContent = `… 此前还有 ${hidden} 条进度`;
			more.append(moreLabel);
			steps.append(more);
		}
		for (const step of stage.steps.slice(-BOOT_VISIBLE_STEPS)) {
			const line = el('div', `boot-step${step.running ? ' is-running' : ''}`);
			const text = el('span', 'boot-step-label');
			text.textContent = step.label;
			const spent = el('span', 'boot-step-time');
			spent.textContent = formatDuration(step.elapsedMs);
			line.append(text, spent);
			steps.append(line);
		}
		row.append(steps);
	}
	return row;
}

function stopBootTimer(): void {
	if (bootTimer !== undefined) {
		window.clearInterval(bootTimer);
		bootTimer = undefined;
	}
}

/** 每 250ms 重绘一次：running 阶段与最后一条子步骤的耗时是实时的，数字在跳就说明没死。 */
function renderBoot(): void {
	if (!bootUI) {
		return;
	}
	const view = boot.view();
	bootUI.root.classList.toggle('is-failed', view.failed);
	bootUI.root.classList.toggle('is-complete', view.finished);
	bootUI.title.textContent = view.failed ? 'VsSaros 启动失败' : view.finished ? 'VsSaros 启动完成' : 'VsSaros 正在启动';
	bootUI.message.textContent = view.message;
	bootUI.total.textContent = `${view.finished ? '启动完成' : '已用时'} ${formatDuration(view.totalMs)}`;
	const stageLabel = BOOT_STAGES.find(s => s.id === view.runningStageId)?.label ?? '当前阶段';
	bootUI.hint.textContent = (!view.finished && !view.failed && view.runningStageMs >= BOOT_STUCK_HINT_MS)
		? `「${stageLabel}」已停留 ${formatDuration(view.runningStageMs)}。若长时间没有变化，可点击右上角 IDE 查看日志。`
		: '';
	bootUI.list.replaceChildren(...view.stages.map(renderBootStage));
	if (view.finished || view.failed) {
		stopBootTimer();   // 耗时已冻结，不需要再重绘
	}
}

function installBootUI(): void {
	const root = document.getElementById('booting');
	if (!root) {
		return;
	}
	const card = el('div', 'boot-card');
	const title = el('div', 'boot-title');
	title.textContent = 'VsSaros 正在启动';
	const message = el('div', 'boot-message');
	const total = el('div', 'boot-total');
	const list = el('div', 'boot-stages');
	const hint = el('div', 'boot-hint');
	card.append(title, message, total, list, hint);
	root.replaceChildren(card);
	bootUI = { root, title, message, total, list, hint };
	renderBoot();
	bootTimer = window.setInterval(renderBoot, 250);
}

function beginStage(id: BootStageId): void {
	boot.begin(id);
	renderBoot();
}

function showBooting(message: string): void {
	if (bootUI) {
		boot.setMessage(message);
		renderBoot();
		return;
	}
	const booting = document.getElementById('booting');
	if (booting) {
		booting.textContent = message;
	}
}

/** 把阶段耗时也写进日志：面板消失后仍能回溯「这次首启慢在哪」。 */
function logBootSummary(): void {
	const view = boot.view();
	console.info(`[dshDesktopOnly] 启动耗时 ${formatDuration(view.totalMs)}：${view.stages.map(s => `${s.label}=${formatDuration(s.elapsedMs)}`).join('，')}`);
	for (const stage of view.stages) {
		for (const step of stage.steps) {
			console.info(`[dshDesktopOnly]   ${stage.label} · ${step.label} ${formatDuration(step.elapsedMs)}`);
		}
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
	installBootUI();
	beginStage('shell');

	const params = new URLSearchParams(location.search);
	const windowId = Number(params.get('windowId'));
	if (!Number.isInteger(windowId) || windowId <= 0) {
		const message = '启动失败：缺少合法的 windowId';
		boot.failCurrent(message);
		showBooting(message);
		return;
	}

	const mainProcessService = new ElectronIPCMainProcessService(windowId);
	window.addEventListener('beforeunload', () => mainProcessService.dispose());
	const channel = mainProcessService.getChannel(DSH_HARNESS_CHANNEL);
	// 主进程的启动进度（Node 下载、profile 种子复制、伴生插件 i/n、Host 启动）切成
	// 「准备运行环境」的子步骤并逐条计时 —— 卡住时能直接看出卡在哪条进度上。
	channel.listen<string>(DshHarnessChannelEvent.OnDidProgress)(line => {
		boot.note(line);
		renderBoot();
	});

	const claimed = await channel.call<boolean>(DshHarnessChannelCommand.ClaimDesktopAutoOpen, { windowId });
	if (!claimed) {
		const message = '已经有一扇 dsh 桌面窗口，本窗口不再重复创建';
		boot.failCurrent(message);
		showBooting(message);
		return;
	}

	const root = document.getElementById('root');
	if (!root) {
		const message = '启动失败：缺少视图容器';
		boot.failCurrent(message);
		showBooting(message);
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
	beginStage('view');
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

	beginStage('runtime');
	showBooting('正在准备 dsh 运行环境…');
	const hostReady = await ensureDesktopHostRunning(
		() => channel.call<IDshHostStatus>(DshHarnessChannelCommand.Bootstrap, { start: {} }),
		async message => {
			boot.failCurrent(message);
			viewVisible = false;
			await channel.call<void>(DshHarnessChannelCommand.DisposeView, { viewId }).catch(() => undefined);
			console.error(`[dshDesktopOnly] 后台服务启动失败：${message}`);
			showBooting(`dsh 运行环境启动失败：${message}\n请关闭窗口后重新启动，或点击右上角 IDE 查看日志。`);
		},
	);
	if (!hostReady) {
		return;
	}

	// 两个换皮锚点用一次 querySelector 并集等待：旧版页签条 / 新版 guide 根节点谁先出现都算就绪。
	// 旧壳串行 1.5s + 7.5s；这里单次 5s 有界等待，超时照常显示，避免白屏。
	const skinSelector = '[data-vssaros-wb-tabstrip],[data-vssaros-guide-root]';
	beginStage('ui');
	showBooting('正在加载 dsh 桌面界面…');
	const vssarosReady = await channel.call<boolean>(DshHarnessChannelCommand.WaitViewSelector, { viewId, selector: skinSelector, timeoutMs: 5000 }).catch(() => false);
	if (!vssarosReady) {
		console.warn('[dshDesktopOnly] 换皮锚点等待超时 ⇒ 直接显示页面');
	}
	boot.finish('启动完成');
	renderBoot();
	logBootSummary();
	// 原生 WebContentsView 一旦显示就会盖住 DOM 覆盖层 ⇒ 汇总必须先留在屏幕上；
	// 秒开的启动不留这一帧，别为了看耗时反而拖慢启动。
	if (boot.view().totalMs >= 2_000) {
		await new Promise<void>(resolve => window.setTimeout(resolve, BOOT_SUMMARY_HOLD_MS));
	}
	viewVisible = true;
	focusView();
	document.getElementById('booting')?.remove();
}

void main().catch(error => {
	const message = `dsh 桌面窗口启动失败：${String((error as Error)?.message ?? error)}`;
	boot.failCurrent(message);
	showBooting(message);
});
