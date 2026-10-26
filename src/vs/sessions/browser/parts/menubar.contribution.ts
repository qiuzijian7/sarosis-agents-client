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
import { URI } from '../../../base/common/uri.js';
// ★ 2026-10-26（用户「执行」）：诊断包要读日志目录、写文件、进剪贴板、定位到文件
import { IFileService, IFileStat } from '../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../platform/environment/common/environment.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { INotificationService, Severity } from '../../../platform/notification/common/notification.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { basename, dirname, join } from '../../../base/common/path.js';

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

// 意见反馈 — ★ 2026-10-26（用户）：原来的占位项「helpFeedback」已移除（标题是英文占位符，
//   点开去的是 TapD story wall，用户根本不知道那是什么）；换成这条中文的、指向产品反馈问卷。
//   ⚠ 经典工作台的「Report Issue（报告问题）」在另一份菜单（MenubarHelpMenu，issue.contribution.ts），
//     不受影响，仍保留 ✓
MenuRegistry.appendMenuItem(MenubarSessionsHelpMenu, {
	command: {
		id: 'workbench.action.openFeedbackForm',
		title: { value: '意见反馈', original: '意见反馈' }
	},
	group: '1_welcome',
	order: 4
});
// 复制诊断信息 — 短文本进剪贴板，直接贴进反馈表单（2026-10-26）
MenuRegistry.appendMenuItem(MenubarSessionsHelpMenu, {
	command: {
		id: 'vssaros.copyDiagnostics',
		title: { value: '复制诊断信息', original: '复制诊断信息' }
	},
	group: '1_welcome',
	order: 5
});

// 导出诊断包 — 把最近会话的日志合成一个 txt，落盘并定位到它（2026-10-26）
MenuRegistry.appendMenuItem(MenubarSessionsHelpMenu, {
	command: {
		id: 'vssaros.exportDiagnostics',
		title: { value: '导出诊断包…', original: '导出诊断包…' }
	},
	group: '1_welcome',
	order: 6
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

/**
 * 产品反馈问卷（飞书）。
 *
 * ★ 2026-10-26（用户指定）：与 dsh 窗口左下角账号菜单的「意见反馈」指向**同一份问卷**
 *   （那边的实现在 `dshHarness.contribution.ts` 的 `DSH_FEEDBACK_URL`）—— 两个入口一个去处，
 *   免得用户看到两份不同的反馈表。
 */
const VS_SAROS_FEEDBACK_URL = 'https://sarosgame.feishu.cn/share/base/form/shrcnLSwbX5eJtTW9DxVmVMxiag';

// 意见反馈 — 用系统浏览器打开反馈问卷（与窗口里其它外链一致）
registerAction2(class OpenFeedbackFormAction extends Action2 {
	static readonly ID = 'workbench.action.openFeedbackForm';

	constructor() {
		super({
			id: OpenFeedbackFormAction.ID,
			title: { value: '意见反馈', original: '意见反馈' },
			category: Categories.Help,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		await openerService.open(URI.parse(VS_SAROS_FEEDBACK_URL), { openExternal: true });
	}
});


// ══════════════════════════════════════════════════════════════════════
// 诊断：复制诊断信息 / 导出诊断包（2026-10-26，用户「执行」⇒ 按上一轮方案实现）
//
// 为什么要有：
//   用户报「点了没反应」时，我们需要**时间点 + 日志**；而让用户自己找
//   `<userData>\logs\<会话>\window1\renderer.log` 几乎不可能一次到位。
//   ⇒ 两个一键动作：短的走剪贴板（贴进反馈表单），长的打成一个 txt（直接上传）。
//
// 为什么是单个 .txt 而不是 zip：
//   渲染层没有可用的打包能力（`base/node/zip` 依赖 Node fs，本层用不了），
//   为一个反馈包引依赖不值得；单文件还省掉「解压」这一步。
//
// 脱敏：
//   · 用户名目录 → `<user>`；token / secret / password / apiKey / Authorization / Cookie 的**值** → `***`
//   · `Bearer …` / `sk-…` / `ghp_…` / JWT 形状 → 打码；邮箱 → `<email>`
//   ⚠ 内网 IP **不脱敏**（诊断网关/代理/端口问题必须看它），文件末尾有说明。
// ══════════════════════════════════════════════════════════════════════

/** 单文件截断上限（避免把几百 MB 的日志打进反馈包）。 */
const DIAG_MAX_FILE_BYTES = 512 * 1024;
/** 最多带几个 dsh 日志（host/harness 每次会话一个，几十个会爆）。 */
const DIAG_MAX_DSH_LOGS = 3;

/**
 * 诊断文本脱敏。**独立导出**，守卫可以直接断言（不必真跑一次导出）。
 */
export function redactDiagnosticText(input: string): string {
	let text = String(input ?? '');
	// ① 用户名目录（Windows / macOS / Linux）
	text = text.replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/g, '$1<user>');
	text = text.replace(/(\/home\/)[^/\s"']+/g, '$1<user>');
	text = text.replace(/(\/Users\/)[^/\s"']+/g, '$1<user>');
	// ② 键值形式的凭据
	text = text.replace(
		/((?:access_?token|refresh_?token|id_?token|token|secret|password|passwd|api[_-]?key|authorization|cookie|set-cookie)"?\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|(?:Bearer|Basic|Token)\s+[^\s,;]+|[^\s,;]{6,})/gi,
		'$1***',
	);
	// ③ 常见 token 形状
	text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
	text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
	text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***');
	text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt>');
	// ④ 邮箱
	text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
	return text;
}

/** 环境信息（两种动作共用同一份口径，避免"复制的"和"导出的"不一致）。 */
function describeEnv(accessor: ServicesAccessor): string[] {
	const env = accessor.get(IEnvironmentService);
	const product = accessor.get(IProductService);
	// ⚠ `userDataPath` / `userHome` 在 **INativeEnvironmentService** 上，不在这层能注入的
	//   基接口 `IEnvironmentService` 里（类型窄、运行时对象是全的）⇒ 窄化取 + 推导兜底：
	//   logsHome 恒为 `<userData>/logs`，父目录就是 userData ✓
	const nativeEnv = env as unknown as { userDataPath?: string };
	const userData = nativeEnv.userDataPath ?? dirname(env.logsHome.fsPath);
	const os = isWindows ? 'Windows' : isMacintosh ? 'macOS' : isLinux ? 'Linux' : 'unknown';
	return [
		'产品        : ' + product.nameShort + ' ' + product.version,
		'运行方式    : ' + (env.isBuilt ? '安装版' : '开发版（未打包，可带 --user-data-dir）'),
		'操作系统    : ' + os,
		'用户数据目录: ' + userData,
		'日志根      : ' + env.logsHome.fsPath,
		'dsh 运行目录: ' + join(userData, 'dsh-run'),
		'采集时间    : ' + new Date().toISOString(),
		'反馈入口    : ' + VS_SAROS_FEEDBACK_URL,
		'（时间点很关键：请同时在反馈里写上问题发生的**大概时间**）',
	];
}

/** 列目录（不存在 / 没权限 ⇒ 空数组，不抛）。 */
async function listDir(fileService: IFileService, dir: URI): Promise<IFileStat[]> {
	try {
		const stat = await fileService.resolve(dir);
		return stat.children ?? [];
	} catch {
		return [];
	}
}

/** 读文本（失败 ⇒ 一句说明；超限留尾部，报错几乎总在最后）。 */
async function readTextFile(fileService: IFileService, uri: URI, maxBytes = DIAG_MAX_FILE_BYTES): Promise<string> {
	try {
		const content = await fileService.readFile(uri);
		const raw = content.value.toString();
		const size = Buffer.byteLength(raw, 'utf8');
		if (size <= maxBytes) {
			return raw;
		}
		const keep = Math.max(1000, Math.floor(raw.length * (maxBytes / size)));
		return '…（前 ' + (raw.length - keep) + ' 字符已截断，以下为末尾）\n' + raw.slice(raw.length - keep);
	} catch (e) {
		return '（读不出来：' + (e instanceof Error ? e.message : String(e)) + '）';
	}
}

/** 最近 N 个会话目录（名字形如 `20261026T111821`）。 */
async function latestLogSessions(fileService: IFileService, logsRoot: URI, n: number): Promise<URI[]> {
	const children = await listDir(fileService, logsRoot);
	return children
		.filter(c => c.isDirectory && /^\d{8}T\d{6}$/.test(basename(c.resource.fsPath)))
		.sort((a, b) => basename(b.resource.fsPath).localeCompare(basename(a.resource.fsPath)))
		.slice(0, n)
		.map(c => c.resource);
}

/** 最近的 dsh 日志（host-*.log / harness-*.log，按修改时间倒序）。 */
async function latestDshLogs(fileService: IFileService, dshRun: URI, n: number): Promise<URI[]> {
	const children = await listDir(fileService, dshRun);
	return children
		.filter(c => !c.isDirectory && /^(host|harness)-.*\.log$/.test(basename(c.resource.fsPath)))
		.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
		.slice(0, n)
		.map(c => c.resource);
}

/** 采集完整诊断文本（导出用；复制走精简版）。 */
export async function buildDiagnosticBundle(accessor: ServicesAccessor): Promise<string> {
	const fileService = accessor.get(IFileService);
	const env = accessor.get(IEnvironmentService);
	const parts: string[] = [];

	parts.push('===== 环境信息 =====');
	parts.push(...describeEnv(accessor));
	parts.push('');

	const sessions = await latestLogSessions(fileService, env.logsHome, 1);
	if (!sessions.length) {
		parts.push('===== IDE 日志 =====');
		parts.push('（没找到会话目录：' + env.logsHome.fsPath + '）');
	}
	for (const session of sessions) {
		const name = basename(session.fsPath);
		const files: [string, URI][] = [
			['main.log', URI.joinPath(session, 'main.log')],
			['window1/renderer.log', URI.joinPath(session, 'window1', 'renderer.log')],
			['window1/agentStudio.log', URI.joinPath(session, 'window1', 'agentStudio.log')],
		];
		for (const [label, uri] of files) {
			parts.push('===== 会话 ' + name + ' · ' + label + ' =====');
			parts.push(await readTextFile(fileService, uri));
			parts.push('');
		}
	}

	const userData = (env as unknown as { userDataPath?: string }).userDataPath ?? dirname(env.logsHome.fsPath);
	const dshLogs = await latestDshLogs(fileService, URI.file(join(userData, 'dsh-run')), DIAG_MAX_DSH_LOGS);
	parts.push('===== dsh 日志（最近 ' + dshLogs.length + ' 个）=====');
	if (!dshLogs.length) {
		parts.push('（没找到 host-*.log / harness-*.log）');
	}
	for (const uri of dshLogs) {
		parts.push('----- ' + basename(uri.fsPath) + ' -----');
		parts.push(await readTextFile(fileService, uri));
		parts.push('');
	}

	parts.push('===== 说明 =====');
	parts.push('本文件由「帮助 → 导出诊断包」生成。已脱敏：用户名目录、token/secret/apikey 的值、Bearer/JWT、邮箱。');
	parts.push('请把本文件（或其中的关键片段）提交到反馈问卷：' + VS_SAROS_FEEDBACK_URL);
	parts.push('入口：帮助 → 意见反馈（系统浏览器打开同一份问卷）；窗口左下角账号菜单里也有同一个入口。');
	parts.push('未脱敏：内网 IP 与端口（排查网关/代理问题需要）。如不希望外发，请自行删除对应行。');
	return redactDiagnosticText(parts.join('\n'));
}

/** 「复制诊断信息」：短、能直接粘进反馈表单。 */
registerAction2(class CopyDiagnosticsAction extends Action2 {
	static readonly ID = 'vssaros.copyDiagnostics';

	constructor() {
		super({
			id: CopyDiagnosticsAction.ID,
			title: { value: '复制诊断信息', original: '复制诊断信息' },
			category: Categories.Help,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const clipboard = accessor.get(IClipboardService);
		const notification = accessor.get(INotificationService);
		const fileService = accessor.get(IFileService);
		const env = accessor.get(IEnvironmentService);

		const lines = describeEnv(accessor);
		const sessions = await latestLogSessions(fileService, env.logsHome, 1);
		lines.push('最近日志会话: ' + (sessions.length ? sessions[0].fsPath : '（无）'));
		const text = redactDiagnosticText(lines.join('\n'));
		await clipboard.writeText(text);
		notification.notify({
			severity: Severity.Info,
			message: '诊断信息已复制到剪贴板（可直接贴进反馈表单）',
		});
	}
});

/** 「导出诊断包…」：把最近会话的日志合成一个 txt，落盘并定位到它。 */
registerAction2(class ExportDiagnosticsAction extends Action2 {
	static readonly ID = 'vssaros.exportDiagnostics';

	constructor() {
		super({
			id: ExportDiagnosticsAction.ID,
			title: { value: '导出诊断包…', original: '导出诊断包…' },
			category: Categories.Help,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const env = accessor.get(IEnvironmentService);
		const notification = accessor.get(INotificationService);
		const clipboard = accessor.get(IClipboardService);
		const nativeHostService = accessor.get(INativeHostService);

		const text = await buildDiagnosticBundle(accessor);
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const name = 'vssaros-diagnostics-' + stamp + '.txt';

		// 落点：优先 Downloads（用户找得到），否则用户主目录，再不行用户数据目录
		const userData = (env as unknown as { userDataPath?: string }).userDataPath ?? dirname(env.logsHome.fsPath);
		const userHome = (env as unknown as { userHome?: URI }).userHome?.fsPath ?? dirname(userData);
		const candidates = [join(userHome, 'Downloads'), userHome, userData];
		let target = join(userData, name);
		for (const dir of candidates) {
			try {
				if (await fileService.exists(URI.file(dir))) { target = join(dir, name); break; }
			} catch { /* 看下一个 */ }
		}

		try {
			await fileService.writeFile(URI.file(target), VSBuffer.fromString(text));
		} catch (e) {
			notification.notify({
				severity: Severity.Error,
				message: '诊断包写入失败：' + (e instanceof Error ? e.message : String(e)),
			});
			return;
		}

		await clipboard.writeText(target);
		notification.notify({
			severity: Severity.Info,
			message: '诊断包已生成：' + name + '（' + Math.round(Buffer.byteLength(text, 'utf8') / 1024) + ' KB，已脱敏）— 路径已复制到剪贴板，文件夹已打开',
		});
		try {
			nativeHostService.showItemInFolder(target);
		} catch { /* 定位失败不影响导出 */ }
	}
});
