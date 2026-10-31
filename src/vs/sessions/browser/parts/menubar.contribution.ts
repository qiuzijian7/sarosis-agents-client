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
// ★ 2026-10-31：意见反馈要在**产品内置窗口**里打开，并自动带上日志与关键信息
import { IFeedbackWindowService } from '../../contrib/feedback/common/feedbackWindow.js';
import { buildFeedbackUrl, FEEDBACK_FORM_URL, IFeedbackPrefill } from '../../contrib/feedback/common/feedbackLink.js';
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

// 检查更新...（2026-10-30：从 VS Code 原生 `update.checkForUpdate` 换成我们自己的面板）
// ⚠ 原生那条只会下载应用安装包：看不到随包插件 / 商城资产，也不显示更新源版本对比。
//   我们这条打开「系统与更新」面板（打开**不联网**，面板里手动点「检查更新」才查）。
MenuRegistry.appendMenuItem(MenubarSarosMenu, {
	command: {
		id: 'dshHarness.checkAppUpdates',
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
 * ★ 真源在 `contrib/feedback/common/feedbackLink.ts`（2026-10-31）—— dsh 侧与 IDE 侧
 *   都从那里取，免得两份漂移。这里只是本地别名，别再改成本地字符串。
 */
const VS_SAROS_FEEDBACK_URL = FEEDBACK_FORM_URL;

/**
 * 组装要预填进问卷的关键信息（2026-10-31）。
 *
 * 为什么**文本走 prefill 而不是 DOM 注入**：问卷的文本题是 `contenteditable`
 * （`adit-container innerdocbody`），React 受控 + 富文本，注入既不稳又要处理事件派发；
 * 而 `prefill_` 是飞书官方能力，实测生效（2026-10-31 打过一次带 prefill 的链接确认）。
 *
 * 顺序有讲究：`buildFeedbackUrl` 按传入顺序分配预算 ⇒ 短字段在前、长文本在后。
 */
function feedbackPrefill(accessor: ServicesAccessor, files: readonly string[]): IFeedbackPrefill {
	const product = accessor.get(IProductService);
	const env = accessor.get(IEnvironmentService);
	// 问卷里「平台」是单选，选项实测为 Win / Mac / Web ⇒ Linux 没有对应项，宁可不填也不填错
	const platform = isWindows ? 'Win' : isMacintosh ? 'Mac' : undefined;

	const description = [
		'【请在这里补充：你做了什么、期望看到什么、实际看到什么，以及大概发生在几点】',
		'',
		...describeEnv(accessor),
		'',
		'已自动附上的诊断文件：' + (files.length ? files.map(f => basename(f)).join('、') : '（本次没有收集到）'),
		'（完整日志在「日志文件」题的附件里；如涉隐私请先在下面删掉对应行再提交）',
	].join('\n');

	return {
		版本号: product.nameShort + ' ' + product.version + (env.isBuilt ? '' : '（开发版）'),
		平台: platform,
		问题描述: description,
	};
}

/**
 * 意见反馈 —— 打开**产品内置窗口**，自动带上诊断日志与关键信息（2026-10-31）。
 *
 * 为什么是独立窗口（`IFeedbackWindowService`）而不是系统浏览器 / BrowserView：
 *   · 系统浏览器里我们没有注入能力 ⇒ 日志只能靠用户手动传；
 *   · BrowserView 组绑的是 IDE 主窗口，而 dsh 桌面窗口场景下主窗口是隐藏的
 *     ⇒ 用户在 dsh 里点反馈会"点了没反应"；
 *   · 独立 BrowserWindow 才能**保证看得见**，且 dsh 侧与 IDE 侧行为一致。
 *
 * 自动带什么：
 *   · 日志文件 —— CDP `DOM.setFileInputFiles` 填「日志文件」题（走飞书匿名上传通道，
 *     实测无 cookie 也能传，不需要任何 token / 后端）；
 *   · 版本号 / 平台 / 环境信息 —— `prefill_` URL 参数（飞书官方预填能力）。
 *
 * 不做什么：**不代提交**（提交永远由本人点），也不往「建议」里塞东西。
 * 任何一步失败 ⇒ 退成"系统浏览器 + 路径进剪贴板"，**绝不阻断反馈**。
 */
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
		const notification = accessor.get(INotificationService);
		const openerService = accessor.get(IOpenerService);

		// ① 先备好日志（收集失败不阻断，用户还能纯文字反馈）
		let files: string[] = [];
		try {
			files = await exportDiagnosticVolumes(accessor);
		} catch (e) {
			notification.notify({
				severity: Severity.Warning,
				message: '诊断日志收集失败（' + (e instanceof Error ? e.message : String(e)) + '）—— 仍可继续反馈，请手动补充现象描述',
			});
		}

		// ② 内置窗口：prefill 关键信息 + CDP 挂日志附件
		const url = buildFeedbackUrl(feedbackPrefill(accessor, files));
		try {
			const result = await accessor.get(IFeedbackWindowService).openFeedbackWindow(url, files);
			if (result.ok) {
				// ⚠ 窗口开着 ≠ 附件挂上了：两者分开说，别让用户以为"日志已经带上了"
				let attachment: string;
				if (!files.length) {
					attachment = '本次没收集到诊断文件';
				} else if (result.filesFilled) {
					attachment = files.length + ' 个诊断文件已挂到「日志文件」题';
				} else {
					attachment = '诊断文件没能自动挂上（' + (result.error ?? '未知原因') + '），请手动「添加本地文件」';
				}
				notification.notify({
					severity: (!files.length || result.filesFilled) ? Severity.Info : Severity.Warning,
					message: '反馈窗口已打开：' + attachment + '；版本/平台/环境已预填 —— 补充现象后点提交',
				});
				return;
			}
			notification.notify({
				severity: Severity.Warning,
				message: '没能打开内置反馈窗口（' + (result.error ?? '未知原因') + '）⇒ 改用系统浏览器',
			});
		} catch (e) {
			notification.notify({
				severity: Severity.Warning,
				message: '没能打开内置反馈窗口（' + (e instanceof Error ? e.message : String(e)) + '）⇒ 改用系统浏览器',
			});
		}

		// ③ 兜底：系统浏览器（路径进剪贴板，方便手动上传）
		if (files.length) {
			await accessor.get(IClipboardService).writeText(files.join('\n'));
		}
		await openerService.open(URI.parse(url), { openExternal: true });
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
/**
 * 单个**分卷**的上限（2026-10-31）。
 *
 * 反馈表单的附件题一次可传多个文件 ⇒ 诊断包从"一个大 txt"改成"三分卷"，
 * 每卷各自按 {@link trimDiagnosticText} 裁剪，避免一刀切把有用的那卷丢了。
 */
const DIAG_MAX_VOLUME_BYTES = 512 * 1024;
/**
 * dsh 日志按「会话对」取几对（2026-10-31）。
 *
 * 同一次启动会产出一个 `host-<hex>.log` + 一个 `harness-<hex>.log`（**hex 各自随机、
 * 不对应**）⇒ 只能靠 mtime 邻近配对。拆散配对的话，看到 host 报错却找不到同期的
 * harness 现场，等于白取。
 */
const DIAG_MAX_DSH_PAIRS = 2;

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

/**
 * 最近 N 个会话目录（名字形如 `20261026T111821`）。
 *
 * ⚠ 2026-10-31：`logs/` 下**两种布局并存** ——
 *   · `<logsRoot>/<ts>/main.log`
 *   · `<logsRoot>/instances/w<id>/<ts>/main.log`
 *   只认顶层会漏掉 instances 下真正有内容的那份（实测某台机器上顶层会话全是
 *   0 KB，有内容的在 `instances/` 里）⇒ 下钻两层再匹配，并按 mtime 取最新。
 */
async function latestLogSessions(fileService: IFileService, logsRoot: URI, n: number): Promise<URI[]> {
	const found: { uri: URI; mtime: number }[] = [];

	const collect = async (dir: URI, depth: number): Promise<void> => {
		for (const c of await listDir(fileService, dir)) {
			if (!c.isDirectory) { continue; }
			if (/^\d{8}T\d{6}$/.test(basename(c.resource.fsPath))) {
				found.push({ uri: c.resource, mtime: c.mtime ?? 0 });
				continue;
			}
			if (depth > 0) { await collect(c.resource, depth - 1); }
		}
	};
	await collect(logsRoot, 2);

	return found
		.sort((a, b) => b.mtime - a.mtime || basename(b.uri.fsPath).localeCompare(basename(a.uri.fsPath)))
		.slice(0, n)
		.map(e => e.uri);
}

/**
 * 最近的 dsh 日志，**按会话成对**（host + harness）。
 *
 * 同一次启动产出的两个文件 hex 各自随机、无法按名配对 ⇒ 按 mtime 邻近配对：
 * 取时间最新的一个，再在剩下的里找异类的那一个凑成对。拆散配对的话，
 * 看到 host 报错却找不到同期的 harness 现场，等于白取。
 */
async function latestDshLogPairs(fileService: IFileService, dshRun: URI, pairs: number): Promise<URI[]> {
	const logs = (await listDir(fileService, dshRun))
		.filter(c => !c.isDirectory && /^(host|harness)-.*\.log$/.test(basename(c.resource.fsPath)))
		.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
		.map(c => ({ uri: c.resource, name: basename(c.resource.fsPath) }));

	const out: URI[] = [];
	const used = new Set<number>();
	for (let i = 0; i < logs.length && out.length < pairs * 2; i++) {
		if (used.has(i)) { continue; }
		used.add(i);
		out.push(logs[i].uri);
		const wantHarness = /^host-/.test(logs[i].name);
		const mate = logs.findIndex((c, j) => !used.has(j) && (wantHarness ? /^harness-/.test(c.name) : /^host-/.test(c.name)));
		if (mate >= 0) { used.add(mate); out.push(logs[mate].uri); }
	}
	return out;
}

/** 日志里"值得留下"的行：错误 / 警告 / 堆栈。 */
const DIAG_ERROR_LINE = /\[(?:error|warn)\b|\b(?:ERROR|WARN|FATAL)\b|Error:|Uncaught|at\s+\S+:\d+:\d+/i;

/**
 * 裁剪单个分卷：**保头 + 保尾 + 中间只留 error/warn（带上下文）**。
 *
 * 比"超限就砍前面"有效得多：日志头有版本与启动信息、尾巴有崩溃现场，
 * 中间九成是 INFO。**独立导出**，守卫可直接断言（不必真跑一次导出）。
 */
export function trimDiagnosticText(raw: string, maxBytes = DIAG_MAX_VOLUME_BYTES): string {
	const text = String(raw ?? '');
	if (Buffer.byteLength(text, 'utf8') <= maxBytes) { return text; }

	const lines = text.split('\n');
	const HEAD = 60;
	const TAIL = 300;
	const tailStart = Math.max(HEAD, lines.length - TAIL);
	const head = lines.slice(0, HEAD);
	const tail = lines.slice(tailStart);
	const middle = lines.slice(HEAD, tailStart);

	const keep = new Set<number>();
	middle.forEach((line, idx) => {
		if (!DIAG_ERROR_LINE.test(line)) { return; }
		for (let k = Math.max(0, idx - 2); k <= Math.min(middle.length - 1, idx + 3); k++) { keep.add(k); }
	});

	const picked: string[] = [];
	let prev = -2;
	for (const idx of [...keep].sort((a, b) => a - b)) {
		if (prev >= 0 && idx - prev > 1) { picked.push('   …'); }
		picked.push(middle[idx]);
		prev = idx;
	}

	let out = [
		...head,
		`…（中间 ${middle.length - keep.size} 行 INFO 已省略，仅保留 error/warn 及其上下文）…`,
		...picked,
		...tail,
	].join('\n');
	// 极端情况下（单行巨型 / 中文占比高）按字节再收一次尾
	while (Buffer.byteLength(out, 'utf8') > maxBytes) {
		out = out.slice(Math.max(0, Math.floor(out.length * 0.9)));
	}
	return out;
}

/** 诊断包时间戳（文件名与目录名共用）。 */
export function diagnosticsStamp(d = new Date()): string {
	return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 诊断包落盘目录：`<userData>/logs/vssaros-diag/<stamp>/`（放 userData 下，用户自己也找得到）。 */
export function diagnosticsDir(env: IEnvironmentService, stamp: string): string {
	const userData = (env as unknown as { userDataPath?: string }).userDataPath ?? dirname(env.logsHome.fsPath);
	return join(userData, 'logs', 'vssaros-diag', stamp);
}

/** 包尾的固定说明（三分卷里 env 卷带一次即可）。 */
function diagnosticNotes(): string[] {
	return [
		'===== 说明 =====',
		'本包由「帮助 → 意见反馈 / 导出诊断包」生成。已脱敏：用户名目录、token/secret/apikey 的值、Bearer/JWT、邮箱。',
		'提交到反馈问卷：' + VS_SAROS_FEEDBACK_URL,
		'未脱敏：内网 IP 与端口（排查网关/代理问题需要）。如不希望外发，请自行删除对应行。',
		'★ 最关键的是「问题大概发生在几点」——没有时间点，几十 KB 日志就是噪声。',
	];
}

/** 一个诊断分卷（落盘成一个文件）。 */
export interface IDiagnosticVolume {
	/** 文件名（不含目录）。 */
	readonly name: string;
	/** 已裁剪 + 已脱敏的正文。 */
	readonly text: string;
}

/**
 * 采集诊断包 —— **三分卷**（2026-10-31）。
 *
 * 为什么分卷：反馈表单的附件题支持多文件（`multiple`）⇒ 分卷后文件名在飞书里
 * 直接可见、能单独下载，也不会因为某一卷过大把另外两卷一起砍掉。
 *   · env：人读，信息密度最高（版本/路径/dsh 启动参数/yml 清单）
 *   · ide：main + renderer + agentStudio + customizationsDebug
 *   · dsh：最近 {@link DIAG_MAX_DSH_PAIRS} 对 host + harness
 */
export async function buildDiagnosticVolumes(accessor: ServicesAccessor, stamp: string): Promise<IDiagnosticVolume[]> {
	const fileService = accessor.get(IFileService);
	const env = accessor.get(IEnvironmentService);
	const userData = (env as unknown as { userDataPath?: string }).userDataPath ?? dirname(env.logsHome.fsPath);
	const dshRun = URI.file(join(userData, 'dsh-run'));

	// ── ① env ────────────────────────────────────────────────────────────
	const envParts: string[] = ['===== 环境信息 =====', ...describeEnv(accessor), ''];
	for (const file of ['last-start.json', 'host-port.json']) {
		const uri = URI.joinPath(dshRun, file);
		if (!await fileService.exists(uri)) { continue; }
		envParts.push('----- dsh ' + file + ' -----');
		envParts.push(await readTextFile(fileService, uri, 64 * 1024));
		envParts.push('');
	}
	// dsh-run 下的 yml 是运行时状态快照，可能含本地路径/密钥 ⇒ **只带清单，不内联**
	const dshYmls = (await listDir(fileService, dshRun))
		.filter(c => !c.isDirectory && /\.yml$/.test(basename(c.resource.fsPath)))
		.slice(0, 40);
	if (dshYmls.length) {
		envParts.push('----- dsh-run/*.yml（仅清单，不内联内容）-----');
		for (const c of dshYmls) {
			envParts.push('  ' + basename(c.resource.fsPath) + '  ' + Math.round((c.size ?? 0) / 1024) + ' KB');
		}
		envParts.push('');
	}
	envParts.push(...diagnosticNotes());

	// ── ② ide ────────────────────────────────────────────────────────────
	const ideParts: string[] = ['===== IDE 日志 ====='];
	const sessions = await latestLogSessions(fileService, env.logsHome, 1);
	if (!sessions.length) {
		ideParts.push('（没找到会话目录：' + env.logsHome.fsPath + '）');
	}
	for (const session of sessions) {
		const name = basename(session.fsPath);
		const files: [string, URI][] = [
			['main.log', URI.joinPath(session, 'main.log')],
			['window1/renderer.log', URI.joinPath(session, 'window1', 'renderer.log')],
			['window1/agentStudio.log', URI.joinPath(session, 'window1', 'agentStudio.log')],
			['window1/customizationsDebug.log', URI.joinPath(session, 'window1', 'customizationsDebug.log')],
		];
		for (const [label, uri] of files) {
			if (!await fileService.exists(uri)) { continue; }
			ideParts.push('===== 会话 ' + name + ' · ' + label + ' =====');
			ideParts.push(await readTextFile(fileService, uri));
			ideParts.push('');
		}
	}

	// ── ③ dsh ────────────────────────────────────────────────────────────
	const dshParts: string[] = ['===== dsh 日志（最近 ' + DIAG_MAX_DSH_PAIRS + ' 个会话对）====='];
	const dshLogs = await latestDshLogPairs(fileService, dshRun, DIAG_MAX_DSH_PAIRS);
	if (!dshLogs.length) {
		dshParts.push('（没找到 host-*.log / harness-*.log）');
	}
	for (const uri of dshLogs) {
		dshParts.push('----- ' + basename(uri.fsPath) + ' -----');
		dshParts.push(await readTextFile(fileService, uri));
		dshParts.push('');
	}

	return [
		{ name: `vssaros-env-${stamp}.txt`, text: redactDiagnosticText(trimDiagnosticText(envParts.join('\n'))) },
		{ name: `vssaros-ide-${stamp}.log`, text: redactDiagnosticText(trimDiagnosticText(ideParts.join('\n'))) },
		{ name: `vssaros-dsh-${stamp}.log`, text: redactDiagnosticText(trimDiagnosticText(dshParts.join('\n'))) },
	];
}

/**
 * 采集完整诊断文本（兼容旧调用）：三分卷拼成一份。
 *
 * ⚠ 新代码请用 {@link buildDiagnosticVolumes} —— 反馈表单一次能传多个附件，
 *   拼成一份只会让飞书里显示成一个无名大文件。
 */
export async function buildDiagnosticBundle(accessor: ServicesAccessor): Promise<string> {
	const volumes = await buildDiagnosticVolumes(accessor, diagnosticsStamp());
	return volumes.map(v => '===== ' + v.name + ' =====\n' + v.text).join('\n\n');
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

/**
 * 生成诊断分卷并落盘（「导出诊断包」与「意见反馈」共用同一份口径）。
 *
 * 落点固定为 {@link diagnosticsDir}（`<userData>/logs/vssaros-diag/<stamp>/`）：
 * 不再往 Downloads 里塞 —— 反馈流程要的是**稳定可预测的路径**（主进程侧的
 * CDP 填文件用绝对路径），用户自己要找也在这个目录。
 *
 * @returns 落盘的绝对路径列表（顺序：env / ide / dsh）
 */
export async function exportDiagnosticVolumes(accessor: ServicesAccessor): Promise<string[]> {
	const fileService = accessor.get(IFileService);
	const env = accessor.get(IEnvironmentService);
	const stamp = diagnosticsStamp();
	const dir = diagnosticsDir(env, stamp);

	try {
		await fileService.createFolder(URI.file(dir));
	} catch { /* 已存在 / 写不了会在下面 writeFile 暴露 */ }

	const volumes = await buildDiagnosticVolumes(accessor, stamp);
	const paths: string[] = [];
	for (const v of volumes) {
		const target = join(dir, v.name);
		await fileService.writeFile(URI.file(target), VSBuffer.fromString(v.text));
		paths.push(target);
	}
	return paths;
}

/** 「导出诊断包…」：把诊断分成三个文件落盘，并定位到它们。 */
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
		const notification = accessor.get(INotificationService);
		const clipboard = accessor.get(IClipboardService);
		const nativeHostService = accessor.get(INativeHostService);

		let paths: string[];
		try {
			paths = await exportDiagnosticVolumes(accessor);
		} catch (e) {
			notification.notify({
				severity: Severity.Error,
				message: '诊断包写入失败：' + (e instanceof Error ? e.message : String(e)),
			});
			return;
		}

		await clipboard.writeText(paths.join('\n'));
		notification.notify({
			severity: Severity.Info,
			message: '诊断包已生成 ' + paths.length + ' 个文件（已脱敏）— 路径已复制到剪贴板，文件夹已打开',
		});
		try {
			nativeHostService.showItemInFolder(paths[0]);
		} catch { /* 定位失败不影响导出 */ }
	}
});
