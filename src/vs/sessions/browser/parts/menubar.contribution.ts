/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { MenuId, MenuRegistry, Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { getActiveWindow } from '../../../base/browser/dom.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { URI } from '../../../base/common/uri.js';

// ── Custom MenuIds for VsSaros-specific menus ──
// These use dedicated IDs to avoid pollution from workbench-level
// menu registrations (e.g. helpActions.ts adding license/privacy/YouTube
// items into MenubarHelpMenu).
const MenubarSarosMenu = new MenuId('MenubarSarosMenu');
const MenubarWindowMenu = new MenuId('MenubarWindowMenu');
const MenubarSessionsHelpMenu = new MenuId('MenubarSessionsHelpMenu');

// ══════════════════════════════════════════════════════════════════════
// Top-level menu structure
// ══════════════════════════════════════════════════════════════════════

// 1. VsSaros
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenubarSarosMenu,
	title: {
		value: 'VsSaros',
		original: 'VsSaros',
		mnemonicTitle: localize({ key: 'mVSaros', comment: ['&& denotes a mnemonic'] }, "&&VsSaros"),
	},
	order: 1
});

// 2. 编辑(E)
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarEditMenu,
	title: {
		value: '编辑(E)',
		original: '编辑(E)',
		mnemonicTitle: localize({ key: 'mEdit', comment: ['&& denotes a mnemonic'] }, "编&&辑(E)")
	},
	order: 2
});

// 3. 窗口(W)
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenubarWindowMenu,
	title: {
		value: '窗口(W)',
		original: '窗口(W)',
		mnemonicTitle: localize({ key: 'mWindow', comment: ['&& denotes a mnemonic'] }, "窗&&口(W)")
	},
	order: 3
});

// 4. 帮助(H)
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenubarSessionsHelpMenu,
	title: {
		value: '帮助(H)',
		original: '帮助(H)',
		mnemonicTitle: localize({ key: 'mHelp', comment: ['&& denotes a mnemonic'] }, "帮&&助(H)")
	},
	order: 4
});

// ══════════════════════════════════════════════════════════════════════
// VsSaros submenu items
// ══════════════════════════════════════════════════════════════════════

// 关于 VsSaros — reuses the existing showAboutDialog command
MenuRegistry.appendMenuItem(MenubarSarosMenu, {
	command: {
		id: 'workbench.action.showAboutDialog',
		title: { value: '关于 VsSaros', original: '关于 VsSaros' }
	},
	group: 'z_about',
	order: 1
});

// 检查更新...
MenuRegistry.appendMenuItem(MenubarSarosMenu, {
	command: {
		id: 'update.checkForUpdate',
		title: { value: '检查更新...', original: '检查更新...' }
	},
	group: 'z_about',
	order: 2
});

// 退出 VsSaros (Alt+F4)
MenuRegistry.appendMenuItem(MenubarSarosMenu, {
	command: {
		id: 'workbench.action.quit',
		title: { value: '退出 VsSaros', original: '退出 VsSaros' }
	},
	group: 'z_about',
	order: 3
});

// ══════════════════════════════════════════════════════════════════════
// Window submenu items
// ══════════════════════════════════════════════════════════════════════

// 关闭窗口(C) Ctrl+W
MenuRegistry.appendMenuItem(MenubarWindowMenu, {
	command: {
		id: 'workbench.action.closeWindow',
		title: { value: '关闭窗口(C)', original: '关闭窗口(C)' }
	},
	group: '1_window',
	order: 1
});

// ══════════════════════════════════════════════════════════════════════
// Help submenu items
// ══════════════════════════════════════════════════════════════════════

// 使用文档
MenuRegistry.appendMenuItem(MenubarSessionsHelpMenu, {
	command: {
		id: 'workbench.action.openDocumentationUrl',
		title: { value: '使用文档', original: '使用文档' }
	},
	group: '1_welcome',
	order: 1
});

// 网络检查
MenuRegistry.appendMenuItem(MenubarSessionsHelpMenu, {
	command: {
		id: 'workbench.action.networkCheck',
		title: { value: '网络检查', original: '网络检查' }
	},
	group: '1_welcome',
	order: 2
});

// 打开日志目录(L)
MenuRegistry.appendMenuItem(MenubarSessionsHelpMenu, {
	command: {
		id: 'workbench.action.openLogsFolder',
		title: { value: '打开日志目录(L)', original: '打开日志目录(L)' }
	},
	group: '1_welcome',
	order: 3
});

// helpFeedback
MenuRegistry.appendMenuItem(MenubarSessionsHelpMenu, {
	command: {
		id: 'workbench.action.helpFeedback',
		title: { value: 'helpFeedback', original: 'helpFeedback' }
	},
	group: '1_welcome',
	order: 4
});

// 开发者工具(D) Ctrl+Shift+I
MenuRegistry.appendMenuItem(MenubarSessionsHelpMenu, {
	command: {
		id: 'workbench.action.toggleDevTools',
		title: { value: '开发者工具(D)', original: '开发者工具(D)' }
	},
	group: '2_developer',
	order: 1
});

// ══════════════════════════════════════════════════════════════════════
// Custom action definitions for new commands
// ══════════════════════════════════════════════════════════════════════

// 网络检查 — opens devtools for network diagnostics
registerAction2(class NetworkCheckAction extends Action2 {
	static readonly ID = 'workbench.action.networkCheck';

	constructor() {
		super({
			id: NetworkCheckAction.ID,
			title: { value: '网络检查', original: '网络检查' },
			category: Categories.Help,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		return nativeHostService.openDevTools({ targetWindowId: getActiveWindow().vscodeWindowId });
	}
});

// helpFeedback — opens the report-issue / feedback URL
registerAction2(class HelpFeedbackAction extends Action2 {
	static readonly ID = 'workbench.action.helpFeedback';

	constructor() {
		super({
			id: HelpFeedbackAction.ID,
			title: { value: 'helpFeedback', original: 'helpFeedback' },
			category: Categories.Help,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const productService = accessor.get(IProductService);
		const openerService = accessor.get(IOpenerService);
		const url = productService.reportIssueUrl;
		if (url) {
			await openerService.open(URI.parse(url));
		}
	}
});
