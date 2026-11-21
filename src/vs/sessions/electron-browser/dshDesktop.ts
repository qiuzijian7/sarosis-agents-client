/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * B 方案的 desktop-only 壳：不加载 workbench、不创建 IDE 贡献图，只通过已有的
 * `DSH_HARNESS_CHANNEL` 启动 Host 并挂接一个 dsh `WebContentsView`。
 */

import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-browser/mainProcessService.js';
import { webFrame } from '../../base/parts/sandbox/electron-browser/globals.js';
import { DSH_HARNESS_CHANNEL, DshHarnessChannelCommand, IDshHostStatus, IDshViewBounds } from '../contrib/dshHarness/common/dshHarness.js';

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

async function main(): Promise<void> {
	const windowId = Number(new URLSearchParams(location.search).get('windowId'));
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

	// 先建视图槽：DshViewHost 在没有连接时会保留 slot，等 `_applyConnection()`
	// 下发连接后立即加载 ⇒ 不必等 Bootstrap 返回才开始创建 WebContentsView ✓。
	const viewId = `dsh-desktop-${windowId}-${Date.now().toString(36)}`;
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
