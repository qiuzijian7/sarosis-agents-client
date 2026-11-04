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
import { IFeedbackWindowService, ipcFeedbackWindowChannelName } from '../../contrib/feedback/common/feedbackWindow.js';
import { IMainProcessService } from '../../../platform/ipc/common/mainProcessService.js';
// 「随包 vs 已装」插件版本对照（"改了没生效"类反馈的唯一判据）——
// ⚠ 走 **common 层的通道直连**：`IDshHarnessService` 定义在 electron-browser 层，
//   而本文件是 browser 层，直接 import 会违反分层约束。
import { DSH_HARNESS_CHANNEL, DshHarnessChannelCommand, IDshBundledPluginRow } from '../../contrib/dshHarness/common/dshHarness.js';
import { IChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../platform/log/common/log.js';
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
/**
 * 组装要预填进问卷的关键字段。
 *
 * ★ 2026-11-04（用户原话："问题描述中，不要预填内容"）：**不再预填问题描述**。
 *   理由：那是必填问答题，预填一大段环境信息后用户往往原样提交 ⇒ 反馈变成"日志复读机"，
 *   还挤掉了真正该写的现象描述。环境信息本来就在「日志文件」的 env 卷里，不丢。
 *   只保留 **版本号 / 平台** 两个短字段（独立题，填了不碍事、不填又得手打）。
 */
function feedbackPrefill(ctx: IDiagnosticContext): IFeedbackPrefill {
	const { product, env } = ctx;
	// 问卷里「平台」是单选，选项实测为 Win / Mac / Web ⇒ Linux 没有对应项，宁可不填也不填错
	const platform = isWindows ? 'Win' : isMacintosh ? 'Mac' : undefined;

	return {
		版本号: product.nameShort + ' ' + product.version + (env.isBuilt ? '' : '（开发版）'),
		平台: platform,
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
		// ★★ 所有 service 必须在**同步开头**取完：`ServicesAccessor` 只在 `run()` 的同步栈内有效，
		//    跨过 `await` 再用就抛 "service accessor is only valid during the invocation of its
		//    target method" ⇒ 2026-11-02 真机就是这么静默失败的（连兜底的系统浏览器都没开）。
		const notification = accessor.get(INotificationService);
		const openerService = accessor.get(IOpenerService);
		const logService = accessor.get(ILogService);
		const clipboard = accessor.get(IClipboardService);
		const mainProcessService = accessor.get(IMainProcessService);
		const ctx = resolveDiagnosticContext(accessor);

		// ★ 入口打点：这是"命令到底有没有被执行"的唯一判据（dsh 侧 `executeCommand` 失败是静默的）
		logService.info('[feedbackWindow] 命令 workbench.action.openFeedbackForm 进入');

		// ① 主进程通道（同步建好 proxy，后面两处共用）
		const feedbackWindow = ProxyChannel.toService<IFeedbackWindowService>(
			mainProcessService.getChannel(ipcFeedbackWindowChannelName),
		);

		// ★ 立刻弹 loading 页（本地 `data:` 页，不联网）：采集要读十几个日志、可能还要
		//   978 次 mtime 兜底 stat、再落盘，几秒钟不给反馈就是"点击没反应"（2026-11-04 真机）。
		//   ⚠ 必须 await：保证"loading 页 → 表单"的加载顺序，避免两次 loadURL 竞争。
		await feedbackWindow.showLoading('正在收集诊断日志…');

		// ② 系统快照（主进程视角：内存/CPU/磁盘）。失败只是少几行，绝不阻断
		let systemInfo: readonly string[] = [];
		try {
			systemInfo = await feedbackWindow.collectSystemInfo();
		} catch (e) {
			logService.warn('[feedbackWindow] 系统快照采集失败（不阻断）', e);
		}

		// ③ 先备好日志（收集失败不阻断，用户还能纯文字反馈）
		let files: string[] = [];
		try {
			files = await exportDiagnosticVolumes(ctx, systemInfo);
		} catch (e) {
			notification.notify({
				severity: Severity.Warning,
				message: '诊断日志收集失败（' + (e instanceof Error ? e.message : String(e)) + '）—— 仍可继续反馈，请手动补充现象描述',
			});
			// ★ 必须落日志：2026-11-02 就是因为这里只弹 toast，`files=0` 的真因（Buffer 未定义）
			//   在日志里完全看不出来，白跑了两轮真机。
			logService.error('[feedbackWindow] 诊断日志收集失败（附件会是 0 个）', e);
		}

		// ② 内置窗口：prefill 关键信息 + CDP 挂日志附件
		// ⚠ 组装 prefill 也必须包起来：它一旦抛错，旧写法会**既没日志也没窗口**（最难的静默失败形态）
		let url: string;
		try {
			url = buildFeedbackUrl(feedbackPrefill(ctx));
		} catch (e) {
			logService.error('[feedbackWindow] 组装预填信息失败，退化为不带预填', e);
			url = FEEDBACK_FORM_URL;
		}
		try {
			// ⚠ 走**主进程通道**直连，而不是 `accessor.get(IFeedbackWindowService)`：
			//   后者依赖 `registerMainProcessRemoteService` 那次 singleton 注册是否被执行过
			//   （它在一个没有 UI 贡献点的模块里，漏加载就是"静默失败"✗）。直连则只依赖通道名 ✓。
			const result = await feedbackWindow.openFeedbackWindow(url, files);
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
					message: '反馈窗口已打开：' + attachment + '；版本/平台已预填 —— 请写清现象和大概时间后提交',
				});
				return;
			}
			notification.notify({
				severity: Severity.Warning,
				message: '没能打开内置反馈窗口（' + (result.error ?? '未知原因') + '）⇒ 改用系统浏览器',
			});
		} catch (e) {
			// ★ 必须落日志：以前这里只弹 toast，一旦主进程侧静默失败就无从查起（2026-11-02 教训）
			logService.error('[feedbackWindow] 打开内置反馈窗口失败，将退回系统浏览器', e);

			// 兜底 A：窗口已经开着（loading 页）说明通道是通的，多半只是"填附件"那步失败
			//   ⇒ 再导航一次不带附件，至少别让用户对着 loading 页干等。
			const retry = await feedbackWindow.openFeedbackWindow(url, []).catch(() => undefined);
			if (retry?.ok) {
				notification.notify({
					severity: Severity.Warning,
					message: '反馈窗口已打开，但诊断文件没能自动附上 —— 需要的话请手动「添加本地文件」',
				});
				return;
			}

			notification.notify({
				severity: Severity.Warning,
				message: '没能打开内置反馈窗口（' + (e instanceof Error ? e.message : String(e)) + '）⇒ 改用系统浏览器',
			});
		}

		// ③ 兜底：系统浏览器（路径进剪贴板，方便手动上传）
		if (files.length) {
			await clipboard.writeText(files.join('\n'));
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
 * UTF-8 字节长度。
 *
 * ⚠⚠ **不能用 Node 的 `Buffer`**：本文件跑在 browser 层（窗口渲染进程），那里没有 `Buffer`
 *   全局 ⇒ `Buffer.byteLength` 直接 `ReferenceError`，整个诊断采集在第一个分卷就抛
 *   （真机 2026-11-02：`files=0`、`vssaros-diag` 目录根本没生成）⇒ 用跨层安全的 `VSBuffer`。
 */
function utf8Bytes(text: string): number {
	return VSBuffer.fromString(text).byteLength;
}

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

/**
 * 诊断采集要用的 service 集合（2026-11-02）。
 *
 * ⚠⚠ **必须在 Action 的同步开头解析好**：`ServicesAccessor` 只在 `run()` 的同步调用栈内有效，
 *   跨过 `await` 再 `accessor.get(...)` 会抛：
 *   `Illegal state: service accessor is only valid during the invocation of its target method`
 *   ⇒ 旧写法把 accessor 一路传进异步函数，导致「意见反馈 / 导出诊断包 / 复制诊断信息」
 *   **全部静默失败**（真机 2026-11-02 11:19 的 renderer.log 抓到这条错误）。
 */
export interface IDiagnosticContext {
	readonly fileService: IFileService;
	readonly env: IEnvironmentService;
	readonly product: IProductService;
	/**
	 * dsh 主进程通道（用来拿"随包版本 vs profile 已装版本"的对照）。
	 *
	 * 取不到就是 `undefined`（非 desktop 入口 / 通道没注册）⇒ 只是少一段清单，
	 * **绝不能**让它拖垮整个诊断采集。
	 */
	readonly dshChannel?: IChannel;
}

/** 在 Action 的**同步开头**调用一次；之后一路用返回值，**不要再用 accessor**。 */
export function resolveDiagnosticContext(accessor: ServicesAccessor): IDiagnosticContext {
	let dshChannel: IChannel | undefined;
	try {
		dshChannel = accessor.get(IMainProcessService).getChannel(DSH_HARNESS_CHANNEL);
	} catch {
		dshChannel = undefined;
	}
	return {
		fileService: accessor.get(IFileService),
		env: accessor.get(IEnvironmentService),
		product: accessor.get(IProductService),
		dshChannel,
	};
}

/** 环境信息（两种动作共用同一份口径，避免"复制的"和"导出的"不一致）。 */
function describeEnv(ctx: IDiagnosticContext): string[] {
	const { env, product } = ctx;
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
		const size = utf8Bytes(raw);
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
 * 日志根候选（2026-11-02）。
 *
 * ⚠⚠ 真机实测：这个 fork 的 `env.logsHome` **直接指向当前会话目录**
 *   （`...\logs\20261102T113512`），而不是 `...\logs` ⇒ 旧写法在它下面找
 *   `2026xxxxTxxxxxx` 子目录，永远为空 ⇒ **IDE 日志 0 覆盖**（诊断包里只剩
 *   `===== IDE 日志 =====` 一行）。两种语义都要兼容。
 */
function logRoots(env: IEnvironmentService): URI[] {
	const home = env.logsHome;
	return /[\\/]\d{8}T\d{6}$/.test(home.fsPath) ? [home, URI.file(dirname(home.fsPath))] : [home];
}

/**
 * 最近 N 个会话目录（名字形如 `20261026T111821`）。
 *
 * ⚠ 2026-10-31：`logs/` 下**两种布局并存** ——
 *   · `<logsRoot>/<ts>/main.log`
 *   · `<logsRoot>/instances/w<id>/<ts>/main.log`
 *   只认顶层会漏掉 instances 下真正有内容的那份（实测某台机器上顶层会话全是
 *   0 KB，有内容的在 `instances/` 里）⇒ 下钻两层再匹配，并按 mtime 取最新。
 * ⚠ 2026-11-02：`logsRoot` 之一可能就是**当前会话目录本身** ⇒ 直接收下并给最高优先级
 *   （当前这次运行才是要排查的那次）。
 */
async function latestLogSessions(fileService: IFileService, roots: readonly URI[], n: number): Promise<URI[]> {
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
	for (const root of roots) {
		if (/[\\/]\d{8}T\d{6}$/.test(root.fsPath)) {
			found.push({ uri: root, mtime: Date.now() });	// 当前会话 ⇒ 置顶
		} else {
			await collect(root, 2);
		}
	}

	return found
		.sort((a, b) => b.mtime - a.mtime || basename(b.uri.fsPath).localeCompare(basename(a.uri.fsPath)))
		.slice(0, n)
		.map(e => e.uri);
}

/**
 * 最近的 dsh 日志，**按会话成对**（host + harness）。
 *
 * 同一次启动产出的两个文件 hex 各自随机、无法按名配对 ⇒ 只能靠 mtime 邻近。
 *
 * ⚠⚠ 2026-11-02 两个真机 bug（都在这段）：
 *   ① 配对用 `findIndex` **从索引 0 开始找** ⇒ 最新那个会和**最老**的凑成一对
 *      （打进包里的是 10-16/10-23 的日志，而当时最新的在 11-02 11:39）⇒ 必须 `j > i`；
 *   ② `IFileService.resolve()` 回来的 `mtime` 可能是 `undefined` ⇒ 全为 0 ⇒ 排序退化成
 *      字典序（hex 随机 ⇒ 等于随机挑）⇒ 缺 mtime 时逐个 `stat` 兜底。
 */
async function latestDshLogPairs(fileService: IFileService, dshRun: URI, pairs: number): Promise<URI[]> {
	const entries = (await listDir(fileService, dshRun))
		.filter(c => !c.isDirectory && /^(host|harness)-.*\.log$/.test(basename(c.resource.fsPath)))
		.map(c => ({ uri: c.resource, name: basename(c.resource.fsPath), mtime: c.mtime ?? 0 }));

	// ② mtime 兜底（只在缺失时付 stat 的代价，978 个文件也只发生在这里）
	if (entries.length && entries.every(e => !e.mtime)) {
		await Promise.all(entries.map(async e => {
			try { e.mtime = (await fileService.stat(e.uri)).mtime ?? 0; } catch { /* 单个失败不影响整体 */ }
		}));
	}
	entries.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));

	const out: URI[] = [];
	const used = new Set<number>();
	for (let i = 0; i < entries.length && out.length < pairs * 2; i++) {
		if (used.has(i)) { continue; }
		used.add(i);
		out.push(entries[i].uri);
		const wantHarness = /^host-/.test(entries[i].name);
		// ① 只能往**后面**（更旧）找配对，绝不回头找最老的
		const mate = entries.findIndex((c, j) => j > i && !used.has(j) && (wantHarness ? /^harness-/.test(c.name) : /^host-/.test(c.name)));
		if (mate >= 0) { used.add(mate); out.push(entries[mate].uri); }
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
	if (utf8Bytes(text) <= maxBytes) { return text; }

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
	while (utf8Bytes(out) > maxBytes) {
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
/**
 * 插件版本对照（随包 vs profile 已装）。
 *
 * 为什么值得单独一段：本仓最高频的自我怀疑是"改了插件没生效"，而它几乎总是
 * **版本没 bump 或没重装** ⇒ 这里的 `state` 一栏直接给答案
 * （`installed` 正常 / `missing` 没装 / `upgradable` 装的是旧版 / `downgradable` 装的是新版）。
 */
async function pluginVersionLines(ctx: IDiagnosticContext): Promise<string[]> {
	const lines: string[] = ['----- 插件版本对照（随包 / 已装 / 状态）-----'];
	if (!ctx.dshChannel) {
		lines.push('（拿不到 dsh 通道，跳过）', '');
		return lines;
	}
	try {
		const rows = await ctx.dshChannel.call(DshHarnessChannelCommand.ListBundledPlugins) as readonly IDshBundledPluginRow[];
		for (const r of rows) {
			lines.push(`  ${r.state === 'installed' ? ' ' : '!'} ${r.name}  随包=${r.version}  已装=${r.installedVersion ?? '-'}  ${r.state}`);
		}
		const odd = rows.filter(r => r.state !== 'installed');
		lines.push(`  合计 ${rows.length} 个；状态异常（!= installed）${odd.length} 个：` + (odd.length ? odd.map(r => r.name).join('、') : '无'));
	} catch (e) {
		lines.push('（插件版本清单读取失败：' + (e instanceof Error ? e.message : String(e)) + '）');
	}
	lines.push('');
	return lines;
}

export async function buildDiagnosticVolumes(ctx: IDiagnosticContext, stamp: string, extraEnvLines?: readonly string[]): Promise<IDiagnosticVolume[]> {
	const { fileService, env } = ctx;
	const userData = (env as unknown as { userDataPath?: string }).userDataPath ?? dirname(env.logsHome.fsPath);
	const dshRun = URI.file(join(userData, 'dsh-run'));

	// ── ① env ────────────────────────────────────────────────────────────
	const envParts: string[] = ['===== 环境信息 =====', ...describeEnv(ctx), ''];
	// 系统快照（主进程视角；"卡顿类"反馈唯一的量化依据 —— 磁盘满会把一切伪装成"代码坏了"）
	if (extraEnvLines?.length) {
		envParts.push('----- 系统快照（主进程）-----');
		envParts.push(...extraEnvLines);
		envParts.push('');
	}
	// 插件版本对照（"改了没生效"的唯一判据）
	envParts.push(...await pluginVersionLines(ctx));
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
	const roots = logRoots(env);
	const sessions = await latestLogSessions(fileService, roots, 1);
	if (!sessions.length) {
		ideParts.push('（没找到会话目录，找过：' + roots.map(r => r.fsPath).join(' | ') + '）');
	}
	for (const session of sessions) {
		const name = basename(session.fsPath);
		const files: [string, URI][] = [
			['main.log', URI.joinPath(session, 'main.log')],
			['window1/renderer.log', URI.joinPath(session, 'window1', 'renderer.log')],
			['window1/agentStudio.log', URI.joinPath(session, 'window1', 'agentStudio.log')],
			['window1/customizationsDebug.log', URI.joinPath(session, 'window1', 'customizationsDebug.log')],
			// ★ 2026-11-02 补齐：扩展宿主（插件问题）、共享进程、MCP 网关、网络、终端
			['window1/exthost/exthost.log', URI.joinPath(session, 'window1', 'exthost', 'exthost.log')],
			['sharedprocess.log', URI.joinPath(session, 'sharedprocess.log')],
			['mcpGateway.log', URI.joinPath(session, 'mcpGateway.log')],
			['network-shared.log', URI.joinPath(session, 'network-shared.log')],
			['terminal.log', URI.joinPath(session, 'terminal.log')],
		];
		for (const [label, uri] of files) {
			if (!await fileService.exists(uri)) { continue; }
			ideParts.push('===== 会话 ' + name + ' · ' + label + ' =====');
			ideParts.push(await readTextFile(fileService, uri));
			ideParts.push('');
		}
	}

	// ★ 2026-11-02：`app-stdout/app-stderr-*.log` 在 **logs 根**（不在会话目录里）——
	//   那里是 Electron 主/渲染进程的原始 stdout/stderr，dsh Host 的输出、渲染进程 console、
	//   插件装不上的报错全在（真机一份 stderr 388 KB，比 main.log 信息还密）。
	const logsBase = roots.find(r => !/[\\/]\d{8}T\d{6}$/.test(r.fsPath)) ?? URI.file(dirname(roots[0].fsPath));
	const appLogs = (await listDir(fileService, logsBase))
		.filter(c => !c.isDirectory && /^app-(stdout|stderr)-.*\.log$/.test(basename(c.resource.fsPath)))
		.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
		.slice(0, 2);
	for (const c of appLogs) {
		ideParts.push('===== ' + basename(c.resource.fsPath) + '（Electron 原始 stdout/stderr）=====');
		ideParts.push(await readTextFile(fileService, c.resource, 256 * 1024));
		ideParts.push('');
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
export async function buildDiagnosticBundle(ctx: IDiagnosticContext): Promise<string> {
	const volumes = await buildDiagnosticVolumes(ctx, diagnosticsStamp());
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
		// ★ 所有 service 必须在**同步开头**取完（await 之后 accessor 就失效了，见 IDiagnosticContext）
		const clipboard = accessor.get(IClipboardService);
		const notification = accessor.get(INotificationService);
		const ctx = resolveDiagnosticContext(accessor);

		const lines = describeEnv(ctx);
		const sessions = await latestLogSessions(ctx.fileService, logRoots(ctx.env), 1);
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
export async function exportDiagnosticVolumes(ctx: IDiagnosticContext, extraEnvLines?: readonly string[]): Promise<string[]> {
	const { fileService, env } = ctx;
	const stamp = diagnosticsStamp();
	const dir = diagnosticsDir(env, stamp);

	try {
		await fileService.createFolder(URI.file(dir));
	} catch { /* 已存在 / 写不了会在下面 writeFile 暴露 */ }

	const volumes = await buildDiagnosticVolumes(ctx, stamp, extraEnvLines);
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
		// ★ 同步开头取完（await 之后 accessor 失效）
		const notification = accessor.get(INotificationService);
		const clipboard = accessor.get(IClipboardService);
		const nativeHostService = accessor.get(INativeHostService);
		const mainProcessService = accessor.get(IMainProcessService);
		const logService = accessor.get(ILogService);
		const ctx = resolveDiagnosticContext(accessor);

		// 系统快照（"卡顿类"反馈唯一的量化依据；失败只是少一段）
		let systemInfo: readonly string[] = [];
		try {
			const feedbackWindow = ProxyChannel.toService<IFeedbackWindowService>(
				mainProcessService.getChannel(ipcFeedbackWindowChannelName),
			);
			systemInfo = await feedbackWindow.collectSystemInfo();
		} catch (e) {
			logService.warn('[feedbackWindow] 系统快照采集失败（导出继续）', e);
		}

		let paths: string[];
		try {
			paths = await exportDiagnosticVolumes(ctx, systemInfo);
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
