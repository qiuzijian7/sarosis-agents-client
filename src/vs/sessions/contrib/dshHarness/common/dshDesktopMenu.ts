/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **dsh desktop 窗口顶部的「应用 / 编辑」菜单模板**（2026-11-04，用户要求参考
 * `G:\CustomWorkspaces\AIProjects\dsh-desktop\` 的源码实现）。
 *
 * 参考工程是「单 BrowserWindow + 40DIP 自绘 caption」：`src/main/windows-menu.ts` 生成
 * Electron template、`src/preload/windows-menu-bar.ts` 在 caption 行挂两枚按钮、
 * `src/main/index.ts` 用 `Menu.buildFromTemplate().popup()` 弹原生菜单。
 *
 * 本仓是 **aux 窗口 + 多个 WebContentsView**：caption 是 `dshFullWindowContribution` 自绘的
 * `.vssaros-desk-titlebar`，原生视图盖在 DOM 之上 ⇒ 菜单必须走 **Electron 原生菜单**
 * （`base/parts/contextmenu` 的 `popup()`，主进程 `menu.popup()`），DOM 菜单会被盖住 ✗。
 * ⇒ 这里输出 `IContextMenuItem[]`（`popup()` 的入参），按钮与命令分发在宿主侧。
 *
 * ⚠ 两处与参考工程不同的务实取舍（都由本仓架构决定，不是偷工减料）：
 *   · 编辑命令不能只作用于一个 webContents ⇒ 走新的 `DshHarnessChannelCommand.DesktopMenuAction`，
 *     主进程找当前聚焦的 WebContentsView 再 `sendInputEvent`（composer 自己管历史栈，
 *     `webContents.undo()` 会跳过它 ✗ —— 参考工程 sendEditingKey 的注释同口径）。
 *   · 参考工程的「连接手机 / 以安全模式重启 / 显示 Harness 日志」在本仓没有对应能力
 *     ⇒ **不放进来**，避免"点了没反应"（本仓高频缺陷形态）。
 */

import type { IContextMenuItem } from '../../../../base/parts/contextmenu/common/contextmenu.js';

/** caption 行两个菜单（顺序即渲染顺序）。 */
export const desktopMenuNames = ['application', 'edit'] as const;
export type DshDesktopMenuName = (typeof desktopMenuNames)[number];

/**
 * 需要**主进程对 WebContentsView 执行**的动作（封闭集 ⇒ channel 校验器用白名单，
 * 页面/渲染侧不许自造 ⇒ 与 `paneAction` 同一安全口径）。
 */
export const dshDesktopMenuActions = [
	'undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll',
	'reload', 'toggleDevTools', 'zoomIn', 'zoomOut', 'zoomReset',
	/** 只查询当前 zoomFactor（给「实际大小（当前 N%）」用），不改状态。 */
	'zoomQuery',
] as const;
export type DshDesktopMenuAction = (typeof dshDesktopMenuActions)[number];

const actionSet = new Set<string>(dshDesktopMenuActions);
export function isDshDesktopMenuAction(value: unknown): value is DshDesktopMenuAction {
	return typeof value === 'string' && actionSet.has(value);
}

/** 渲染侧直接执行的宿主命令（不需要主进程视图操作）。 */
export const dshDesktopMenuCommands = [
	'restart', 'toggleFullscreen', 'checkForUpdates', 'about', 'quit',
] as const;
export type DshDesktopMenuCommand = (typeof dshDesktopMenuCommands)[number];

const commandSet = new Set<string>(dshDesktopMenuCommands);
export function isDshDesktopMenuCommand(value: unknown): value is DshDesktopMenuCommand {
	return typeof value === 'string' && commandSet.has(value);
}

/**
 * 编辑按键（`sendInputEvent` 用）。modifiers 统一写 `control`：
 * macOS 由主进程在执行时换成 `meta`（本文件保持纯函数，不 import node:platform）。
 */
export interface DshDesktopEditingKey {
	readonly keyCode: string;
	readonly modifiers: readonly ('control' | 'meta')[];
}

export const dshDesktopEditingKeys: Partial<Record<DshDesktopMenuAction, DshDesktopEditingKey>> = {
	undo: { keyCode: 'Z', modifiers: ['control'] },
	redo: { keyCode: 'Y', modifiers: ['control'] },
	cut: { keyCode: 'X', modifiers: ['control'] },
	copy: { keyCode: 'C', modifiers: ['control'] },
	paste: { keyCode: 'V', modifiers: ['control'] },
	delete: { keyCode: 'Delete', modifiers: [] },
	selectAll: { keyCode: 'A', modifiers: ['control'] },
};

export function formatZoomPercentage(zoomFactor: number): string {
	return `${Math.round(zoomFactor * 100)}%`;
}

export interface DshDesktopMenuActions {
	/** 渲染侧宿主命令（重启 / 全屏 / 检查更新 / 关于 / 退出）。 */
	run(command: DshDesktopMenuCommand): void;
	/** 主进程视图动作（编辑键 / 重载 / 开发者工具 / 缩放）。 */
	act(action: DshDesktopMenuAction): void;
}

/**
 * 生成一个 caption 菜单。纯函数：只用入参，不碰 DOM / Electron / 平台
 * ⇒ 可以在守卫里直接 import 做行为级断言（参考工程 `test/windows-titlebar.test.ts` 同思路）。
 *
 * @param zoomFactor 当前聚焦视图的缩放，显示在「实际大小」那一项上。
 */
export function dshDesktopMenuTemplate(
	name: DshDesktopMenuName,
	locale: 'zh' | 'en',
	zoomFactor: number,
	actions: DshDesktopMenuActions,
): IContextMenuItem[] {
	const zh = locale === 'zh';
	const command = (id: DshDesktopMenuCommand, zhLabel: string, enLabel: string, accelerator?: string): IContextMenuItem => ({
		label: zh ? zhLabel : enLabel,
		...(accelerator === undefined ? {} : { accelerator }),
		click: () => actions.run(id),
	});
	const editing = (id: DshDesktopMenuAction, zhLabel: string, enLabel: string, accelerator?: string): IContextMenuItem => ({
		label: zh ? zhLabel : enLabel,
		...(accelerator === undefined ? {} : { accelerator }),
		click: () => actions.act(id),
	});
	const sep: IContextMenuItem = { type: 'separator' };

	if (name === 'edit') {
		return [
			editing('undo', '撤销', 'Undo', 'Ctrl+Z'),
			editing('redo', '重做', 'Redo', 'Ctrl+Y'),
			sep,
			editing('cut', '剪切', 'Cut', 'Ctrl+X'),
			editing('copy', '复制', 'Copy', 'Ctrl+C'),
			editing('paste', '粘贴', 'Paste', 'Ctrl+V'),
			editing('delete', '删除', 'Delete'),
			sep,
			editing('selectAll', '全选', 'Select All', 'Ctrl+A'),
		];
	}

	return [
		command('restart', '重启 Harness', 'Restart Harness', 'Ctrl+Shift+R'),
		sep,
		{
			label: zh ? '视图' : 'View',
			submenu: [
				editing('reload', '重新加载', 'Reload', 'Ctrl+R'),
				editing('toggleDevTools', '开发者工具', 'Developer Tools', 'Ctrl+Shift+I'),
				sep,
				editing('zoomIn', '放大', 'Zoom In', 'Ctrl+='),
				editing('zoomOut', '缩小', 'Zoom Out', 'Ctrl+-'),
				editing('zoomReset', `实际大小（当前 ${formatZoomPercentage(zoomFactor)}）`, `Actual Size (now ${formatZoomPercentage(zoomFactor)})`, 'Ctrl+0'),
				sep,
				command('toggleFullscreen', '切换全屏', 'Toggle Full Screen', 'F11'),
			],
		},
		sep,
		command('checkForUpdates', '检查更新…', 'Check for Updates…', 'Ctrl+U'),
		command('about', '关于 VsSaros', 'About VsSaros'),
		sep,
		command('quit', '退出', 'Exit'),
	];
}

/** caption 按钮标题（与 `windows-menu-bar.ts` 的 relabel() 同口径）。 */
export function desktopMenuLabel(name: DshDesktopMenuName, locale: 'zh' | 'en'): string {
	const zh = locale === 'zh';
	if (name === 'edit') { return zh ? '编辑' : 'Edit'; }
	return zh ? '应用' : 'Application';
}
