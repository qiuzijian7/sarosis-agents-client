/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 底座 P1 骨架的 renderer 贡献：设置项、服务、命令。
 *
 * dsh 的界面只出现在 vsSaros 的 agent 栏（聊天框 instance 内），不新增 ActivityBar 图标。
 * **默认开启**（`sessions.dshHarness.enabled` 注册值就是 `default: true`，连同 `chatEngine: 'dsh'` 与
 * `prewarm: true` 一起决定"用户什么都不做也会在后台拉起 Host"；本行注释曾误写"默认关闭"，2026-10-12 更正）。
 * 关闭（`enabled = false`）时：命令不可用、不会实例化服务、不会拉起任何进程
 * —— 对现有功能零影响。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { relativePath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { FocusMode, INativeHostService } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
// GroupDirection：方案 C2 里 openBot 要在 chat 组**右侧**新建分组放设置页（左右并排）
import { GroupDirection, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isRuntimeVersionDir } from '../common/dshCli.js';
import { hostIdleTtlText } from '../common/dshHostConfig.js';
import { DSH_PAGE_COMMANDS_WITHOUT_IDE_UI, DshPageCommand, IDshInsertReference, isPathInside } from '../common/dshPageBridgeProtocol.js';
import { IDshUpgradeResult } from '../common/dshUpgrade.js';
import { DSH_MODULE_CONTAINERS, DSH_MODULE_PAGES } from '../common/dshModuleContainers.js';
// 工作台动作（固定 / 隐藏）要改 IDE 的活动栏状态 ⇒ 用既有的工作台管理服务 ✓
// （跨层 import electron-browser → agentStudio/browser 有先例：`dshChatInstanceHost.ts` 就是这么引的 ✓）
import { IWorkbenchManagerService } from '../../agentStudio/browser/workbenchManagerService.js';
import { ITofAuthService } from '../../agentStudio/common/tofAuth.js';
import { DshTofAuthService } from './dshTofAuthService.js';
// Agents 视图 id（`openAgentRoster` 用它聚焦侧栏那个视图；见该分支的注释 —— 用视图 id 而不是
// 曾经的 `agentStudio.presetAgent.focus` 假命令 id ✓）
import { AGENT_STUDIO_PRESET_AGENT_VIEW_ID } from '../../../common/agentStudioConstants.js';
// 桌面窗口**多开**（2026-10-29）：「新开一扇 dsh 桌面窗口」的跨层入口（common 层单例钩子；
// 与 `agentStudio.popoutChat` 走的是同一套 opener，只是多了 `newWindow` 语义）✓
import { openDshFullWindow, paneDshChatPane, splitDshChatPane } from '../../../common/dshFullWindow.js';
// 单个 bot 的「Agent 设置」编辑器页输入（`openAgentSettings` 用它；页面自己开不了编辑器 ⇒ 宿主来开）。
// 与上面几行同属**跨层 import（electron-browser → agentStudio/browser）**，先例见上一条注释 ✓。
import { AgentSettingsEditorInput } from '../../agentStudio/browser/agentSettingsEditorInput.js';
// 资源条目设置（桥 `openResourceSettings`，2026-10-15）：技能走**资源管理详情页**（那条路已有
// "改 SKILL.md / 启停 / 卸载"）、MCP 走**真源文件** `<数据根>/mcp.json`（路径助手与 mcpServerEditorPane
// 用的是同一对 ✓）。跨层 import（electron-browser → agentStudio/browser|common）先例同上 ✓。
import { ResourceManagerEditorInput } from '../../agentStudio/browser/resourceManagerEditorInput.js';
import { ResourceManagerEditorPane } from '../../agentStudio/browser/resourceManagerEditorPane.js';
import { resolveSarosPath, SarosPath, userDataRootFromRoamingHome } from '../../../common/sarosPaths.js';
import { DshPluginPageEditorInput } from './dshPluginPageEditorInput.js';
// side-effect import：注册「dsh 插件页的编辑区承载」（editor pane），见该文件头注释 ✓
import './dshPluginPageEditor.contribution.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
// ★ 2026-10-26：`.code-workspace` 的解析口径只有这一份（sidebarPart 也用它）⇒ 不能各写一份 ✗。
import { parseCodeWorkspaceFolders } from '../../agentStudio/common/codeWorkspaceFolders.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioService } from '../../../common/agentStudioService.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { TERMINAL_VIEW_ID } from '../../../../workbench/contrib/terminal/common/terminal.js';
// 终端位置枚举在 **platform** 层（`workbench/contrib/terminal/common/terminal.ts` 只是转引 ✗）⇒ 从定义处引 ✓
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
// 布局能力探询：agent 布局**底部没有 panel** ⇒ 终端不能建在 Panel 位置（否则建了也看不见 ✗）
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';

const DSH_COMMAND_CHECK_UPDATES = 'dshHarness.checkUpdates';

/**
 * 「意见反馈」的去处（2026-10-26 用户指定）：飞书问卷。
 *
 * 以前这条菜单项交给 IDE 的 issue reporter（`workbench.action.openIssueReporter`），
 * 那个面板是 VS Code 的、提交去 GitHub —— 我们这边根本没人看 ⇒ 改成打开产品自己的问卷。
 */
const DSH_FEEDBACK_URL = 'https://sarosgame.feishu.cn/share/base/form/shrcnLSwbX5eJtTW9DxVmVMxiag';
import { DshHarnessSettings, DSH_DEFAULT_PROFILE, IDshHostStatus, IDshViewInfo } from '../common/dshHarness.js';
import { DshHarnessService, IDshHarnessService } from './dshHarnessService.js';
import { DshChatHostContribution } from './dshChatInstanceHost.js';
import { DshFullWindowContribution, dshIdeWindowHidden } from './dshFullWindowContribution.js';
import { DshPluginCenterHostContribution } from './dshPluginCenterHost.js';
import { DshActivityBarContribution } from './dshActivityBarContribution.js';
import { DSH_COMMAND_OPEN_SETTINGS, DSH_COMMAND_RESTART_HOST, DSH_COMMAND_SHOW_LOG } from './dshCommands.js';
import { DshProviderSync } from './dshProviderSync.js';

const ENABLED = ContextKeyExpr.equals(`config.${DshHarnessSettings.Enabled}`, true);
const CATEGORY = localize2('dshHarness.category', "DSH");

// ─── 设置 ────────────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dshHarness',
	title: localize('dshHarness.config.title', "DeepSeek Harness"),
	type: 'object',
	scope: ConfigurationScope.MACHINE,
	properties: {
		[DshHarnessSettings.Enabled]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('dshHarness.config.enabled', "启用 DeepSeek Harness（dsh）底座：agent 栏的聊天框内容区改用 dsh 的聊天 UI（默认开启）。不新增 ActivityBar 图标；关闭时不拉起任何进程，聊天框退回 DOM 面板。"),
		},
		[DshHarnessSettings.RuntimePath]: {
			type: 'string',
			default: '',
			markdownDescription: localize('dshHarness.config.runtimePath', "dsh 安装位置：`npm i --prefix` 的目录，或 `@deepseek-ai/dsh/lib/bin.js` 的完整路径。留空时使用 VsSaros 托管的运行时，其次是全局安装的 dsh。"),
		},
		[DshHarnessSettings.NodePath]: {
			type: 'string',
			default: '',
			markdownDescription: localize('dshHarness.config.nodePath', "运行 dsh 的 Node 可执行文件（要求 22.19+ 或 24+）。留空时依次尝试托管 Node、PATH 中的 `node`。不能使用 VsSaros 自带的 Electron。"),
		},
		[DshHarnessSettings.NodeMirror]: {
			type: 'string',
			default: '',
			markdownDescription: localize('dshHarness.config.nodeMirror', "托管 Node 的下载源，目录结构须与 `https://nodejs.org/dist` 相同（含 `index.json` 与 `SHASUMS256.txt`），如 `https://npmmirror.com/mirrors/node`。留空使用官方源。下载经系统代理，并校验 SHA-256。"),
		},
		[DshHarnessSettings.UpdateChannel]: {
			type: 'string',
			enum: ['stable', 'preview', 'locked'],
			enumDescriptions: [
				localize('dshHarness.config.channel.stable', "稳定：只升级到 VsSaros 兼容清单中验证过的版本。"),
				localize('dshHarness.config.channel.preview', "尝鲜：跟随 npm 的 latest / next，可能未经 VsSaros 验证。"),
				localize('dshHarness.config.channel.locked', "锁定：固定在 `pinnedVersion`（为空则固定在当前版本），不提示升级。"),
			],
			default: 'stable',
			markdownDescription: localize('dshHarness.config.updateChannel', "dsh 运行时的升级通道。任何通道下切换版本都会先快照，健康检查失败自动回退。"),
		},
		[DshHarnessSettings.PinnedVersion]: {
			type: 'string',
			default: '',
			pattern: '^$|^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$',
			markdownDescription: localize('dshHarness.config.pinnedVersion', "锁定通道使用的 dsh 版本，如 `0.2.0-rc.2`。"),
		},
		[DshHarnessSettings.CompatManifestUrl]: {
			type: 'string',
			default: '',
			markdownDescription: localize('dshHarness.config.compatManifestUrl', "远端兼容清单地址（可选）。必须由 VsSaros 可信密钥签名，否则忽略并使用随包清单。"),
		},
		[DshHarnessSettings.Prewarm]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('dshHarness.config.prewarm', "工作台就绪后在后台预热 dsh Host（默认开启）：点开聊天框时 Host 已就绪。关闭则退回点开才启动（首次要等几秒）。只在总开关打开且聊天框引擎为 dsh 时生效。"),
		},
		[DshHarnessSettings.HostKeepAlive]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('dshHarness.config.hostKeepAlive', "关闭 VsSaros 时保留 dsh Host 常驻（默认开启）：再次打开时直接接管（聊天框零等待）；Host 空闲 {0} 无客户端会自动退出，不会长期占内存。关闭则每次退出都结束 Host。", hostIdleTtlText()),
		},
		[DshHarnessSettings.PopoutStyle]: {
			type: 'string',
			enum: ['composed', 'web'],
			enumDescriptions: [
				localize('dshHarness.config.popoutStyle.composed', "拼装式 desktop（默认）：左侧 VsSaros 会话栏 + 中间 dsh 聊天 + 右侧工作台页签，布局照官方 desktop。"),
				localize('dshHarness.config.popoutStyle.web', "官方 dsh Web 客户端整页（带官方侧栏/顶栏）。注意：真机上曾出现整页卡死（输入框无响应），保留此档仅供对照。"),
			],
			default: 'composed',
			markdownDescription: localize('dshHarness.config.popoutStyle', "「弹出独立窗口」用哪种形态。改动后需重载窗口。"),
		},
		[DshHarnessSettings.OpenDesktopOnStartup]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('dshHarness.config.openDesktopOnStartup', "启动时直接打开 dsh 桌面窗口（默认开启）：工作台就绪后自动弹出那个独立窗口（形态见「弹出独立窗口」设置），只开一次。桌面窗口侧栏底部有「IDE」入口可以回到 VsSaros 主窗口。总开关关闭或聊天框引擎为 legacy 时不生效。"),
		},
		[DshHarnessSettings.SkipPluginInstall]: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('dshHarness.config.skipPluginInstall', "开发用：启动时跳过随包插件的**升级**安装（缺失的仍会安装）。默认关闭（每次启动把随包插件升到与仓库/产品一致）。打开后本次启动先用已装版本，省掉每次约 2 秒/个的安装等待——仓库里插件版本频繁变动时，启动会明显变慢，就是这个原因。"),
		},
		[DshHarnessSettings.ChatEngine]: {
			type: 'string',
			enum: ['dsh', 'legacy'],
			enumDescriptions: [
				localize('dshHarness.config.engine.dsh', "agent 栏聊天框内承载 dsh 聊天 UI（默认）。"),
				localize('dshHarness.config.engine.legacy', "退回现有 DOM 聊天面板（应急开关，行为与启用 dsh 之前一致）。"),
			],
			default: 'dsh',
			markdownDescription: localize('dshHarness.config.chatEngine', "聊天框引擎（方案 5.12）：dsh 的聊天 UI 承载在 agent 栏的聊天框 instance 内。改动后需重载窗口；只在总开关打开时生效。"),
		},
		[DshHarnessSettings.ModuleEngine]: {
			type: 'string',
			enum: ['legacy', 'dsh'],
			enumDescriptions: [
				localize('dshHarness.config.moduleEngine.legacy', "模块 ActivityBar 图标由静态注册负责（回退用）。"),
				localize('dshHarness.config.moduleEngine.dsh', "按已激活的模块插件动态注册 / 注销模块图标（方案 6.4 / 6.11.5；重构 1.1 起按插件清单驱动，新增模块不改壳代码）。"),
			],
			// 重构 1.2（2026-10-16）：默认翻成 dsh。1.1 已把数据源换成插件清单（读 profile，不拉 Host）；
			// Host 没起来时页面显示状态说明（DshPluginViewPane 的状态区），图标照常出现。
			default: 'dsh',
			markdownDescription: localize('dshHarness.config.moduleEngine', "模块引擎（方案 6.8 / 9.2）：`dsh` 时模块图标按插件清单动态注册（容器可见性经聚合计算）；`legacy` 为回退（静态注册）。改动后需重载窗口；只在总开关打开时生效。"),
		},
		[DshHarnessSettings.ChatOnlyUi]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('dshHarness.config.chatOnlyUi', "聊天框里只保留聊天 UI（方案 5.13）：在 dsh 页面里隐藏侧边栏（含品牌行与会话列表）与右侧面板（轨迹 / 任务 / 交付物），只留会话、输入框、审批与用量。关闭即回到官方整页形态。改动后需重载窗口。"),
		},
		[DshHarnessSettings.EntryKanban]: {
			type: 'string',
			enum: ['dsh', 'legacy'],
			enumDescriptions: [
				localize('dshHarness.config.entryKanban.dsh', "看板「进行中」由 dsh 侧 runner 驱动（Host 里的 kanban 插件，重构 2.2）。"),
				localize('dshHarness.config.entryKanban.legacy', "回退到旧的壳侧执行链（executeTaskForBoard）。"),
			],
			default: 'dsh',
			markdownDescription: localize('dshHarness.config.entryKanban', "看板自动执行的入口归属（重构 2.2）：两边同时跑会双执行 ⇒ 只能二选一；出问题回退到 `legacy`。"),
		},
		[DshHarnessSettings.DshHome]: {
			type: 'string',
			default: '',
			markdownDescription: localize('dshHarness.config.dshHome', "`$DSH_HOME` 目录。留空时安装版使用 dsh 默认的 `~/.dsh`（与浏览器中的 `dsh web` 共享会话与凭证），开发版使用独立目录。"),
		},
		[DshHarnessSettings.Profile]: {
			type: 'string',
			default: DSH_DEFAULT_PROFILE,
			markdownDescription: localize('dshHarness.config.profile', "VsSaros 使用的 dsh profile。首次启动时由官方 web 模板创建，插件集合与你自己的 web profile 隔离。"),
		},
	},
});

registerSingleton(IDshHarnessService, DshHarnessService, InstantiationType.Delayed);
// 企业身份（TOF/OA）归 dsh 侧（2026-10-22，用户："登录也转移到 dsh 侧实现，ide 侧仅读取状态"）：
// 桌面版用 dsh 镜像实现**覆盖** agentStudio 里注册的那一份（desktop 入口先装 common 再装本文件 ⇒ 后注册的生效；
// 服务集合按注册顺序 `set`，同 id 后者覆盖前者）。老 Host 时它内部自动退回原实现。
registerSingleton(ITofAuthService, DshTofAuthService, InstantiationType.Delayed);

// ─── 命令 ────────────────────────────────────────────────────────────────────

// ★★ 2026-10-26：**记忆详情 = React 版独立页**（用户要求"IDE 侧改用 react 版本记忆，统一数据源"）。
//   为什么走插件页而不是旧的 `MemoryDetailEditorPane`（2.3k 行原生 DOM）：
//     ① React 版是**同一份实现**（`webapp/src/detailView.js`）⇒ dsh 客户端与 IDE 不再两套 UI/两套口径 ✗
//     ② 数据只走 `GET /x/memory/api/detail`（服务端 `loadDetailModel`，**跨分区**）⇒ 数据源统一 ✓
//     ③ 页面自包含（bundle 自带 React）⇒ IDE 主包不必引入 React ✓
//   ⚠ 路由**不带查询串**（模块页白名单 / `openModulePage` 都要求干净路径）
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dshHarness.openMemoryDetailReact',
			title: localize2('dshHarness.openMemoryDetailReact', 'Open Memory Detail (React)'),
			f1: true,
			category: localize2('dshHarness.category', 'Dsh'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const input = DshPluginPageEditorInput.getOrCreate('agentStudio.memory', '记忆库', '/x/memory/react-detail');
		await editorService.openEditor(input, { pinned: true });
	}
});
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dshHarness.newDesktopWindow',
			title: localize2('dshHarness.newDesktopWindow', "新开 dsh 桌面窗口（并行开新会话）"),
			category: CATEGORY,
			f1: true,
			precondition: ENABLED,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		// ★ 2026-10-29（桌面窗口多开）：**另开一扇**（不复用已开着的）⇒
		//   每扇窗口有自己的一条 dsh 会话（会话 id 按窗口 id 派生）与自己的网络分区
		//   （第 2..N 扇各占一个 ⇒ 不会互相饿死）⇒ 多扇并行工作互不干扰 ✓。
		const opened = await openDshFullWindow({ newWindow: true });
		if (!opened) {
			accessor.get(INotificationService).warn(localize('dshHarness.newDesktopWindow.failed', "没能新开 dsh 桌面窗口（dsh 未启用，或当前引擎不是 dsh）"));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DSH_COMMAND_RESTART_HOST, title: localize2('dshHarness.restartHost', "重启 Host"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const s = await accessor.get(IDshHarnessService).restart();
		reportStatus(accessor.get(INotificationService), s);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dshHarness.stopHost', title: localize2('dshHarness.stopHost', "停止 Host"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IDshHarnessService).stop();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DSH_COMMAND_SHOW_LOG, title: localize2('dshHarness.showLog', "显示 Host 日志"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const dsh = accessor.get(IDshHarnessService);
		const editorService = accessor.get(IEditorService);
		const lines = await dsh.getLog();
		const header = `# DeepSeek Harness Host log (token redacted)\n# status: ${JSON.stringify(dsh.status)}\n\n`;
		await editorService.openEditor({ resource: undefined, forceUntitled: true, contents: header + (lines.join('\n') || '(empty)'), languageId: 'log', options: { pinned: true } });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dshHarness.showStatus', title: localize2('dshHarness.showStatus', "显示运行状态"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const dsh = accessor.get(IDshHarnessService);
		const info = await dsh.getRuntimeInfo();
		const views = await dsh.listViews();
		const s = dsh.status;
		const viewText = views.map(v => `${v.surface}${v.visible ? '' : '(hidden)'}${v.visible !== v.nativeVisible ? '!' : ''} ${v.bounds.width}x${v.bounds.height}`).join('; ') || '无';
		const ws = await dsh.getWorkspaceSync();
		const reported = new Set(ws.windows.flatMap(w => w.paths)).size;
		const rejected = ws.results.filter(r => r.error);
		const wsText = ws.connected
			? localize('dshHarness.wsConnected', "上报 {0} 个目录，已注册 {1} 个{2}", reported, ws.results.length - rejected.length, rejected.length ? localize('dshHarness.wsRejected', "，被拒 {0} 个（{1}）", rejected.length, rejected.map(r => `${r.path}: ${r.error}`).join('；')) : '')
			: localize('dshHarness.wsPending', "上报 {0} 个目录，等控制桥连接后注册", reported);
		const stateText = s.reused ? localize('dshHarness.stateReused', "{0}（复用 pid {1} 的 Host）", s.state, s.pid) : s.state;
		const plugins = await dsh.listPlugins().catch(() => []);
		const pluginText = plugins.length
			? plugins.map(p => `${p.name.split('/').pop()}@${p.version ?? '?'}${p.version ? '' : '（未实装）'}`).join(', ')
			: '无';
		accessor.get(INotificationService).info(localize('dshHarness.statusText', "Host：{0}（控制桥：{1}）· dsh {2} · Node {3} · 托管版本：{4}（当前 {5}）· 视图：{6} · 工作区：{7} · 插件：{8}",
			stateText, s.bridge, s.dshVersion ?? '-', s.nodeVersion ?? '-', info.installed.join(', ') || '无', info.current ?? '-', viewText, wsText, pluginText));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DSH_COMMAND_OPEN_SETTINGS, title: localize2('dshHarness.openSettings', "打开设置"), category: CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('workbench.action.openSettings', 'sessions.dshHarness');
	}
});

// ─── 从 .code-workspace 文件导入多根工作区（2026-10-26）────────────────────────

/** 路径比较（判"是不是同一个工作区"）：忽略大小写与尾斜杠。 */
function samePathLoose(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) { return false; }
	const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
	return norm(a) === norm(b);
}

/**
 * 导入一个 `.code-workspace` 文件：把它的 `folders[]` 落成**一条多根工作区记录**，
 * 并把各根注册进 dsh。
 *
 * 为什么要这条（用户 2026-10-26：「增加从 code-workspace 文件导入多根工作区的能力」）：
 *   · dsh 的工作区模型**只能单目录** ⇒ 一个多根工作区在 dsh 侧是 **N 条平级记录**
 *     ⇒ 想在 dsh 侧用一个 .code-workspace，就得把它的每个 folder 都注册进去；
 *   · 既有「打开工作区文件」（`sidebarPart._openFileAsWorkspace`）是**打开**（把 IDE 窗口切进去），
 *     而"导入"是**只落记录 + 注册到 dsh，窗口不动** ⇒ 适合"我想在 dsh 侧用它"的场景，
 *     也不会在 desktop（窗口）模式下把 IDE 窗口拽出来重载 ✓。
 *
 * 落点说明：命令**注册在 dshHarness 侧**（而不是 agentStudio 侧）—— 因为它要写 dsh 的工作区注册表，
 *   而 dshHarness → agentStudio 已有依赖方向（`IAgentStudioService`）；反向 import 会成环 ✗。
 *
 * ⚠ 失败必须**可见**（通知条）：本仓纪律「点了没反应」是高频缺陷形态 ⇒ 解析不到根、注册失败
 *   都要说出来，不能只落日志 ✓。
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agentStudio.workspace.importCodeWorkspace',
			title: localize2('dshHarness.importCodeWorkspace', "从 .code-workspace 文件导入多根工作区"),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const dialogs = accessor.get(IFileDialogService);
		const files = accessor.get(IFileService);
		const studio = accessor.get(IAgentStudioService);
		const dsh = accessor.get(IDshHarnessService);
		const notifications = accessor.get(INotificationService);
		const log = accessor.get(ILogService);

		const uris = await dialogs.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: localize('dshHarness.importCodeWorkspace.open', "导入"),
			title: localize('dshHarness.importCodeWorkspace.title', "选择 .code-workspace 文件"),
			filters: [{ name: 'Workspace', extensions: ['code-workspace'] }],
		});
		const fileUri = uris && uris.length > 0 ? uris[0] : undefined;
		if (!fileUri) {
			return;   // 用户取消 ⇒ **不是错误**（不弹任何提示 ✓）
		}

		let roots: string[];
		let name: string;
		let filesExclude: Record<string, boolean> | undefined;
		try {
			const content = await files.readFile(fileUri);
			const parsed = parseCodeWorkspaceFolders(content.value.toString(), URI.joinPath(fileUri, '..').fsPath);
			if (parsed.parseErrorCount > 0) {
				log.warn(`[dshHarness] importCodeWorkspace: ${fileUri.fsPath} 有 ${parsed.parseErrorCount} 处可容忍的 JSONC 错误`);
			}
			roots = [parsed.primaryPath, ...parsed.extraFolders.map(f => f.path)].filter((p): p is string => !!p);
			filesExclude = parsed.filesExclude;
			const base = fileUri.fsPath.replace(/[\\/]+$/, '').split(/[/\\]/).pop() || fileUri.fsPath;
			name = base.replace(/\.code-workspace$/i, '') || base;
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			log.warn(`[dshHarness] importCodeWorkspace: 解析 ${fileUri.fsPath} 失败：${msg}`);
			notifications.error(localize('dshHarness.importCodeWorkspace.parseFailed', "读不出这个工作区文件的内容：{0}", msg));
			return;
		}

		if (roots.length === 0) {
			notifications.warn(localize('dshHarness.importCodeWorkspace.noRoots', "这个工作区文件里没有可用的 folder（folders[] 为空，或路径不是本地目录）"));
			return;
		}

		// 落一条记录：同一个 .code-workspace（或同一个主根）就更新，不新建重复的 ✓
		const all = await studio.getWorkspaces().catch(() => [] as readonly { id: string; path?: string; codeWorkspacePath?: string; relatedFolders?: { path: string }[] }[]);
		const existing = all.find(w => samePathLoose(w.codeWorkspacePath, fileUri.fsPath) || samePathLoose(w.path, roots[0]));
		let target: { id: string; relatedFolders?: { path: string }[] };
		try {
			if (existing) {
				target = await studio.updateWorkspace(existing.id, { name, path: roots[0], filesExclude, codeWorkspacePath: fileUri.fsPath });
			} else {
				target = await studio.createWorkspace({ name, path: roots[0], filesExclude, codeWorkspacePath: fileUri.fsPath });
			}
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			log.warn(`[dshHarness] importCodeWorkspace: 落工作区记录失败：${msg}`);
			notifications.error(localize('dshHarness.importCodeWorkspace.recordFailed', "没能把这个多根工作区登记进来：{0}", msg));
			return;
		}

		// 其余根补进 relatedFolders（按路径去重 —— 重复导入不会把记录弄脏 ✓）
		const have = new Set((target.relatedFolders ?? []).map(f => f.path.replace(/[\\/]+$/, '').toLowerCase()));
		for (const p of roots.slice(1)) {
			if (have.has(p.replace(/[\\/]+$/, '').toLowerCase())) { continue; }
			try {
				await studio.addRelatedFolder(target.id, p);
			} catch (e) {
				log.warn(`[dshHarness] importCodeWorkspace: 追加关联根失败（${p}）：${String((e as Error)?.message ?? e)}`);
			}
		}

		// 注册到 dsh（**与窗口无关**的追加登记；窗口那条是整体替换 ⇒ 不能混用 ✓）
		try {
			await dsh.ensureDshWorkspaces(roots);
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			log.warn(`[dshHarness] importCodeWorkspace: 注册到 dsh 失败（${roots.length} 个根）：${msg}`);
			notifications.error(localize('dshHarness.importCodeWorkspace.registerFailed', "工作区已登记，但没能注册到 dsh（Host 可能没连上）：{0}", msg));
			return;
		}

		log.info(`[dshHarness] importCodeWorkspace: 已导入「${name}」（${roots.length} 个根）⇒ ${roots.join(' | ')}`);
		notifications.info(localize('dshHarness.importCodeWorkspace.done', "已导入多根工作区「{0}」（{1} 个根）并注册到 dsh；窗口未切换。", name, roots.length));
	}
});

// ─── 插入引用（编辑器右键 / 命令面板 / 工作台树行 / 工作台页 → 聊天框草稿）─────

const DSH_ENGINE = ContextKeyExpr.equals(`config.${DshHarnessSettings.ChatEngine}`, 'dsh');

/**
 * 把一条引用推进**当前活动的那个 dsh 聊天草稿**。
 *
 * ★ 两条入口**共用这一处**（2026-10-14）：① 编辑器右键 / 命令面板 / 工作台树行
 * （`dshHarness.insertReferenceToChat`）；② 工作台**页面** → 聊天（页面桥 `insertChatReference`）。
 * 分开写两份必然漂移 ✗ —— 它们要落到**同一个**聊天视图、同一套负载形状，差别只在"谁提供路径"。
 *
 * 没有活动聊天框时**如实提示**，不静默丢弃 ✓；返回是否真的投出去。
 */
async function pushReferenceToActiveChat(
	deps: { readonly dsh: IDshHarnessService; readonly notifications: INotificationService },
	reference: IDshInsertReference,
): Promise<boolean> {
	const viewId = deps.dsh.activeChatViewId;
	if (!viewId) {
		deps.notifications.info(localize('dshHarness.insertReference.noChat', "还没有 dsh 聊天框：先在 agent 栏打开一个聊天。"));
		return false;
	}
	await deps.dsh.insertReference(viewId, reference);
	return true;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dshHarness.insertReferenceToChat',
			title: localize2('dshHarness.insertReference', "发送当前文件引用到聊天（dsh）"),
			category: CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(ENABLED, DSH_ENGINE),
			menu: { id: MenuId.EditorContext, when: ContextKeyExpr.and(ENABLED, DSH_ENGINE), group: '9_dsh', order: 1 },
		});
	}
	/**
	 * @param resourceOrUri 可选。给了 URI（工作台树行 `executeCommand(id, node.uri)`）就发**那个文件**；
	 * 不给（编辑器右键 / 命令面板）则回落"文件编辑区当前活动编辑器"—— 不依赖焦点，因为焦点可能在聊天框里。
	 */
	async run(accessor: ServicesAccessor, resourceOrUri?: unknown): Promise<void> {
		const notifications = accessor.get(INotificationService);
		const dsh = accessor.get(IDshHarnessService);
		const argUri = URI.isUri(resourceOrUri) ? resourceOrUri : undefined;
		let uri: URI | undefined;
		let range: { startLine: number; endLine: number } | undefined;
		if (argUri) {
			uri = argUri;
		} else {
			// 读文件编辑区（mainPart）活动分组的编辑器 —— 不依赖焦点：焦点可能在聊天框（agentPart）里。
			const pane = accessor.get(IEditorGroupsService).mainPart.activeGroup.activeEditorPane;
			const control = pane?.getControl();
			if (!isCodeEditor(control)) {
				notifications.info(localize('dshHarness.insertReference.noEditor', "文件编辑区当前没有打开的文本编辑器。"));
				return;
			}
			uri = control.getModel()?.uri;
			const selection = control.getSelection();
			if (selection && !selection.isEmpty()) {
				range = { startLine: selection.startLineNumber, endLine: selection.endLineNumber };
			}
		}
		if (!uri || uri.scheme !== 'file') {
			notifications.info(localize('dshHarness.insertReference.noFile', "当前编辑器不是本地文件。"));
			return;
		}
		// 在工作区内用相对路径（与 dsh @ 引用的展示形态一致），区外用绝对路径。
		const folder = accessor.get(IWorkspaceContextService).getWorkspaceFolder(uri);
		const rel = folder ? relativePath(folder.uri, uri) : undefined;
		await pushReferenceToActiveChat({ dsh, notifications }, {
			path: (rel ?? uri.fsPath).replace(/\\/g, '/'),
			...(range ?? {}),
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dshHarness.installRuntime', title: localize2('dshHarness.installRuntime', "安装运行时版本"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);
		const dsh = accessor.get(IDshHarnessService);
		const version = await quickInput.input({
			prompt: localize('dshHarness.installRuntime.prompt', "要并列安装的 @deepseek-ai/dsh 精确版本（如 0.2.0-rc.2）。安装不改变当前版本。"),
			validateInput: async v => isRuntimeVersionDir(v.trim()) ? undefined : localize('dshHarness.installRuntime.invalid', "请输入精确版本号"),
		});
		if (!version) {
			return;
		}
		const handle = notification.notify({ severity: Severity.Info, message: localize('dshHarness.installing', "正在安装 dsh {0}…", version.trim()), progress: { infinite: true } });
		try {
			const v = await dsh.installRuntime(version.trim());
			handle.close();
			notification.info(localize('dshHarness.installed', "dsh {0} 已安装。可用「DSH: 切换运行时版本」启用它。", v));
		} catch (e) {
			handle.close();
			notification.error(localize('dshHarness.installFailed', "安装失败：{0}", String((e as Error)?.message ?? e)));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dshHarness.switchRuntime', title: localize2('dshHarness.switchRuntime', "切换运行时版本"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);
		const dsh = accessor.get(IDshHarnessService);
		const info = await dsh.getRuntimeInfo();
		if (!info.installed.length) {
			notification.info(localize('dshHarness.noRuntime', "托管目录中还没有 dsh 版本，请先执行「DSH: 安装运行时版本」。"));
			return;
		}
		const pick = await quickInput.pick([...info.installed].reverse().map(v => ({ label: v, description: v === info.current ? localize('dshHarness.current', "当前") : undefined })), {
			placeHolder: localize('dshHarness.switchRuntime.placeholder', "选择要启用的 dsh 版本（先快照，健康检查失败会自动回退）"),
		});
		if (!pick || pick.label === info.current) {
			return;
		}
		await runUpgrade(dsh, notification, accessor.get(IDialogService), pick.label);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DSH_COMMAND_CHECK_UPDATES, title: localize2('dshHarness.checkUpdates', "检查运行时更新"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);
		const dialogs = accessor.get(IDialogService);
		const dsh = accessor.get(IDshHarnessService);
		const d = await dsh.discoverUpdates();
		const channelLabel = { stable: localize('dshHarness.ch.stable', "稳定"), preview: localize('dshHarness.ch.preview', "尝鲜"), locked: localize('dshHarness.ch.locked', "锁定") }[d.channel];
		const items = d.candidates.map(c => {
			const desc: string[] = [];
			if (c.current) { desc.push(localize('dshHarness.current', "当前")); }
			if (c.version === d.recommended) { desc.push(localize('dshHarness.recommended', "推荐")); }
			if (c.tags.length) { desc.push(c.tags.join(', ')); }
			desc.push(c.verified ? localize('dshHarness.verified', "已验证") : localize('dshHarness.unverified', "未经 VsSaros 验证"));
			if (c.installed) { desc.push(localize('dshHarness.installed', "已安装")); }
			const detail = c.blocked ? localize('dshHarness.blocked', "已知问题：{0}", c.blocked) : c.problems.length ? c.problems.join('；') : undefined;
			return { label: c.version, description: desc.join(' · '), detail, disabled: c.current || !!c.blocked || c.problems.length > 0, candidate: c };
		});
		const pick = await quickInput.pick(items, {
			title: localize('dshHarness.checkUpdates.title', "dsh 运行时版本（{0}通道；清单：{1}）", channelLabel, d.manifestSource ? `${d.manifestSource} ${d.manifestGeneratedAt?.slice(0, 10) ?? ''}` : localize('dshHarness.noManifest', "无")),
			placeHolder: d.notes.length ? d.notes.join(' ') : d.recommended ? localize('dshHarness.checkUpdates.has', "可升级到 {0}；选择版本后先快照再切换，失败自动回退", d.recommended) : localize('dshHarness.checkUpdates.none', "当前通道没有可升级的版本；仍可选择其他版本"),
		});
		if (!pick) {
			return;
		}
		if (!pick.candidate.verified) {
			const { confirmed } = await dialogs.confirm({
				type: 'warning',
				message: localize('dshHarness.unverified.confirm', "dsh {0} 未经 VsSaros 验证，界面或 IDE 联动可能异常。仍要切换吗？", pick.label),
				detail: localize('dshHarness.unverified.detail', "切换前会快照会话与 profile，健康检查失败会自动回退。"),
				primaryButton: localize('dshHarness.unverified.go', "仍要切换"),
			});
			if (!confirmed) {
				return;
			}
		}
		await runUpgrade(dsh, notification, dialogs, pick.label);
	}
});

/** 经升级闸门切换；有运行中的任务时先征得用户同意再强制切换。 */
async function runUpgrade(dsh: IDshHarnessService, notification: INotificationService, dialogs: IDialogService, version: string): Promise<void> {
	const progress = notification.notify({ severity: Severity.Info, message: localize('dshHarness.upgrading', "正在切换到 dsh {0}：快照、重启并检查…", version), progress: { infinite: true } });
	let r: IDshUpgradeResult;
	try {
		r = await dsh.upgrade(version);
		if (r.outcome === 'blocked') {
			progress.close();
			const { confirmed } = await dialogs.confirm({
				type: 'warning',
				message: r.running === -1
					? localize('dshHarness.upgrade.unknown', "无法确认是否有正在运行的任务（控制桥不可用）。仍要切换到 dsh {0} 吗？", version)
					: localize('dshHarness.upgrade.busy', "有 {0} 个会话正在运行，切换版本会重启 Host 并中断它们。仍要切换到 dsh {1} 吗？", r.running, version),
				primaryButton: localize('dshHarness.upgrade.force', "中断并切换"),
			});
			if (!confirmed) {
				return;
			}
			r = await dsh.upgrade(version, true);
		}
	} finally {
		progress.close();
	}
	switch (r.outcome) {
		case 'switched':
			notification.info(localize('dshHarness.upgrade.ok', "已切换到 dsh {0}（原版本 {1}），健康检查通过。", r.to, r.from ?? '-'));
			break;
		case 'unchanged':
			break;
		case 'rolled-back':
			notification.warn(localize('dshHarness.upgrade.rolledBack', "dsh {0} 健康检查未通过，已自动回退到 {1} 并恢复快照：{2}", r.to, r.from ?? '-', r.error ?? ''));
			break;
		default:
			notification.error(localize('dshHarness.upgrade.failed', "切换到 dsh {0} 失败：{1}", r.to, r.error ?? ''));
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dshHarness.installNode', title: localize2('dshHarness.installNode', "安装托管 Node"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const notification = accessor.get(INotificationService);
		const handle = notification.notify({ severity: Severity.Info, message: localize('dshHarness.installingNode', "正在下载并校验托管 Node…"), progress: { infinite: true } });
		try {
			const r = await accessor.get(IDshHarnessService).installNode();
			handle.close();
			notification.info(localize('dshHarness.installedNode', "托管 Node {0} 已安装：{1}", r.version, r.path));
		} catch (e) {
			handle.close();
			notification.error(localize('dshHarness.installNodeFailed', "安装托管 Node 失败：{0}", String((e as Error)?.message ?? e)));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dshHarness.bootstrap', title: localize2('dshHarness.bootstrap', "准备运行环境并启动"), category: CATEGORY, f1: true, precondition: ENABLED });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const notification = accessor.get(INotificationService);
		const dsh = accessor.get(IDshHarnessService);
		const handle = notification.notify({ severity: Severity.Info, message: localize('dshHarness.bootstrapping', "正在准备 DeepSeek Harness…"), progress: { infinite: true } });
		const sub = dsh.onDidProgress(text => handle.updateMessage(text));
		try {
			reportStatus(notification, await dsh.bootstrap());
		} catch (e) {
			notification.error(String((e as Error)?.message ?? e));
		} finally {
			sub.dispose();
			handle.close();
		}
	}
});

function reportStatus(notification: INotificationService, s: IDshHostStatus): void {
	if (s.state === 'running') {
		notification.info(localize('dshHarness.running', "DeepSeek Harness 已运行：dsh {0}，控制桥 {1}，启动 {2} ms。", s.dshVersion ?? '-', s.bridge, s.startupMs ?? '-'));
	} else if (s.state === 'error') {
		notification.error(localize('dshHarness.failed', "DeepSeek Harness 启动失败：{0}", s.error ?? ''));
	}
}

class DshHarnessWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.dshHarness';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// 窗口重载后，主进程里属于本窗口旧 renderer 的视图已无人管理，统一回收。
		if (configurationService.getValue<boolean>(DshHarnessSettings.Enabled)) {
			// **必须早于任何视图创建**（所以本贡献挂 BlockStartup，不是 Eventually）：新 renderer 的
			// 视图 id 与孤儿相同（`dsh-chat-w<win>-<chatId>`），而 `DshViewHost.create` 见到 id 已存在
			// 会直接返回——孤儿不先清掉，聊天视图就会用**旧参数**（会话 id 烘在 webContents 的启动参数里）
			// 复活；更糟的是晚到的回收会把刚建好的当前视图一起销毁（用户看到"聊天框一闪就没了"，
			// Host 抢先启动后视图建得更早，这个竞态才暴露出来）。主进程侧另有 `keep` 兜底。
			const windowId = mainWindow?.vscodeWindowId;
			if (typeof windowId === 'number') {
				instantiationService.invokeFunction(accessor => accessor.get(IDshHarnessService).resetWindow(windowId)).catch(() => undefined);
			}
			// 模型 provider 同步：VsSaros 已配置的 provider（BYOK/自定义/扩展登录态）→ dsh 聊天框选择器。
			this._register(instantiationService.createInstance(DshProviderSync));
		}
	}
}

// BlockStartup：回收孤儿视图必须早于工作台恢复布局（聊天 pane 会在恢复时才创建视图）。
registerWorkbenchContribution2(DshHarnessWorkbenchContribution.ID, DshHarnessWorkbenchContribution, WorkbenchPhase.BlockStartup);
// 聊天宿主必须在恢复的聊天标签创建 pane 之前注册工厂。
registerWorkbenchContribution2(DshChatHostContribution.ID, DshChatHostContribution, WorkbenchPhase.BlockRestore);
// 「弹出窗口 = dsh 官方客户端完整 UI」的开窗钩子（engine=dsh 才接管 popout；否则 popout 走旧实现）。
registerWorkbenchContribution2(DshFullWindowContribution.ID, DshFullWindowContribution, WorkbenchPhase.BlockRestore);
// 模块 ActivityBar 的动态注册（方案 6.4）；moduleEngine=legacy 时空操作（静态注册负责）。
// ⚠ 不在此注册：dshActivityBarContribution.ts 文件末尾已自注册（2026-10-16 前这里又注册了一次 ⇒
//   同一 ID 双注册；registerWorkbenchContribution2 对重复 ID 会抛错/告警 ⇒ 保留模块内那一处）。
void DshActivityBarContribution;
// 插件中心「DSH」来源的数据钩子（方案 4.5）；总开关关闭时不注册，页签不出现。
registerWorkbenchContribution2(DshPluginCenterHostContribution.ID, DshPluginCenterHostContribution, WorkbenchPhase.BlockStartup);

/**
 * 工作区注册同步的窗口一侧（方案第 8.2 节）：把本窗口活动 Agent Studio 工作区的目录——
 * 主根（元数据目录）、各关联根（代码所在）、工作区与各 agent 的 worktree、各仓库的 git worktree——
 * 上报给主进程，由主进程在控制桥连上后经 `workspace.ensure` 注册。只上报目录，不做路径规范化
 * （交给 dsh）；切换工作区、关联根增删、worktree 变化时重新上报（防抖）。总开关关闭时什么都不做。
 */
class DshWorkspaceReportContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.dshHarness.workspaceReport';
	private readonly _scheduler = this._register(new RunOnceScheduler(() => void this._report(), 500));
	private _last = '';

	constructor(
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@IAgentStudioService private readonly _studio: IAgentStudioService,
		@IWorktreeService worktrees: IWorktreeService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		const schedule = () => this._config.getValue<boolean>(DshHarnessSettings.Enabled) && this._scheduler.schedule();
		// 工作区换了要做两件事：重报目录（`schedule`）**和**让 Host 里那份工作区上下文跟上。
		// 后者走**运行期**路径（`noteActiveWorkspace` 推 `workspace.context`）⇒ 切工作区**不重启 Host** ✓；
		// 只有老 Host / 老插件不认那条调用时才退回"空闲时重启"（见 service 里那两个方法的注释 ✓）。
		const onWorkspaceChange = () => {
			void this._dsh.noteActiveWorkspace(_studio.getActiveWorkspaceId())
				.catch(err => this._log.warn(`[dshHarness] 切换工作区后的 Host 处理失败：${String((err as Error)?.message ?? err)}`));
			schedule();
		};
		// 先记一次当前值 **并把上下文推给已在跑的 Host**：从前这一步什么都没做（那时还没观测过"上一个"）
		// ⇒ Host 带着旧快照跑到底 ✗；现在首记也推（幂等：值没变 Host 侧不会广播 ✓）。
		void this._dsh.noteActiveWorkspace(_studio.getActiveWorkspaceId()).catch(() => undefined);
		this._register(_studio.onDidChangeActiveWorkspace(onWorkspaceChange));
		this._register(_studio.onDidChangeWorkspace(id => id === _studio.getActiveWorkspaceId() && onWorkspaceChange()));
		this._register(worktrees.onDidChangeWorktrees(schedule));
		this._register(_config.onDidChangeConfiguration(e => e.affectsConfiguration(DshHarnessSettings.Enabled) && (this._last = '', schedule())));
		// 控制桥重连时主进程会用已上报的目录全量注册，这里不需要重报；Host 首次启动前也已上报。
		schedule();
	}

	private async _collect(): Promise<string[]> {
		const id = this._studio.getActiveWorkspaceId();
		const ws = id ? await this._studio.getWorkspace(id) : undefined;
		if (!ws) {
			return [];
		}
		const paths: (string | undefined)[] = [ws.path, ...ws.relatedFolders.map(f => f.path), ws.worktreePath];
		const [bindings, worktrees] = await Promise.all([
			this._studio.getAgentBindings(ws.id).catch(() => []),
			this._studio.getWorktrees(ws.id).catch(() => []),
		]);
		paths.push(...bindings.map(b => b.worktreePath), ...worktrees.map(w => w.path));
		return [...new Set(paths.filter((p): p is string => !!p?.trim()))];
	}

	private async _report(): Promise<void> {
		if (!this._config.getValue<boolean>(DshHarnessSettings.Enabled)) {
			return;
		}
		try {
			const paths = await this._collect();
			const key = JSON.stringify(paths);
			if (key === this._last) {
				return;
			}
			this._last = key;
			await this._dsh.setWindowWorkspaces(mainWindow.vscodeWindowId, paths);
		} catch (e) {
			this._last = '';
			this._log.warn(`[dshHarness] workspace report failed: ${String((e as Error)?.message ?? e)}`);
		}
	}
}

registerWorkbenchContribution2(DshWorkspaceReportContribution.ID, DshWorkspaceReportContribution, WorkbenchPhase.Eventually);

/**
 * 后台预热：**尽早**把 Host 拉起来，让它与工作台启动并行。
 *
 * 实测（用户机器日志）：Host 要等聊天框挂载（工作台启动完成 ≈5.2s）才开始起，再花 ~3.8s 才就绪
 * ——聊天框从点击到可用约 13s（含窗口启动）。而 Host 启动本身只依赖 dsh 运行时与配置，
 * 不依赖工作台，所以放到**最早的** `BlockStartup` 相位 + 0.4s 延迟就能整段重叠掉。
 *
 * 多窗口/多实例靠 supervisor 的启动锁与租约复用去重；总开关/预热开关关闭、或 chatEngine=legacy
 * 时什么都不做。预热失败只记日志（用户真用聊天框时还有懒启动兜底）。
 */
class DshPrewarmContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.dshHarness.prewarm';

	constructor(
		@IDshHarnessService dsh: IDshHarnessService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService log: ILogService,
	) {
		super();
		if (configurationService.getValue<boolean>(DshHarnessSettings.Enabled) === false
			|| configurationService.getValue<boolean>(DshHarnessSettings.Prewarm) === false
			|| configurationService.getValue<string>(DshHarnessSettings.ChatEngine) === 'legacy') {
			return;
		}
		const timer = this._register(new RunOnceScheduler(() => {
			if (dsh.status.state !== 'stopped') {
				return; // 已在运行/启动中（比如聊天框先触发了）
			}
			log.info('[dshHarness] prewarming Host in background');
			void dsh.ensureStarted().catch(e => log.warn('[dshHarness] prewarm failed', e));
		}, 400));
		timer.schedule();
	}
}

registerWorkbenchContribution2(DshPrewarmContribution.ID, DshPrewarmContribution, WorkbenchPhase.BlockStartup);

/**
 * 每天至多一次的升级提示。只在用户已启动 Host 之后检查（不在启动期主动联网），锁定通道不检查，
 * 同一版本只提示一次。
 */
class DshUpdateCheckContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.dshHarness.updateCheck';
	private static readonly LAST_CHECK = 'dshHarness.update.lastCheck';
	private static readonly LAST_NOTIFIED = 'dshHarness.update.lastNotified';
	private _checking = false;

	constructor(
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@IStorageService private readonly _storage: IStorageService,
		@INotificationService private readonly _notification: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._register(this._dsh.onDidChangeStatus(s => {
			if (s.state === 'running') {
				void this._maybeCheck();
			}
		}));
	}

	private async _maybeCheck(): Promise<void> {
		if (this._checking || !this._config.getValue<boolean>(DshHarnessSettings.Enabled) || this._dsh.policy().channel === 'locked') {
			return;
		}
		const last = this._storage.getNumber(DshUpdateCheckContribution.LAST_CHECK, StorageScope.APPLICATION, 0);
		if (Date.now() - last < 24 * 60 * 60 * 1000) {
			return;
		}
		this._checking = true;
		try {
			const d = await this._dsh.discoverUpdates();
			this._storage.store(DshUpdateCheckContribution.LAST_CHECK, Date.now(), StorageScope.APPLICATION, StorageTarget.MACHINE);
			if (!d.recommended || this._storage.get(DshUpdateCheckContribution.LAST_NOTIFIED, StorageScope.APPLICATION) === d.recommended) {
				return;
			}
			this._storage.store(DshUpdateCheckContribution.LAST_NOTIFIED, d.recommended, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this._notification.prompt(Severity.Info,
				localize('dshHarness.update.available', "dsh {0} 可用（当前 {1}）。", d.recommended, d.current ?? '-'),
				[{ label: localize('dshHarness.update.view', "查看并升级"), run: () => this._commands.executeCommand(DSH_COMMAND_CHECK_UPDATES) }]);
		} catch {
			// 离线等情况：静默，下次启动 Host 时再试
		} finally {
			this._checking = false;
		}
	}
}

registerWorkbenchContribution2(DshUpdateCheckContribution.ID, DshUpdateCheckContribution, WorkbenchPhase.Eventually);

// ─── 页面桥命令处理（低风险界面命令；方案第 4.4 节）──────────────────────────

/**
 * 处理 dsh 页面经 `window.vssarosDsh` 发来的命令。页面里可能有第三方前端插件，所以：
 * - 只接受绝对路径；工作区内的文件直接打开，工作区外的先通知、用户点「打开」才打开；
 * - 不提供任何写入或执行能力。
 * 开关关闭时不注册；开关打开时实例化服务只会建立 IPC 订阅，不会拉起 Host。
 *
 * ⚠ 2026-10-15 修订（与协议头部同一处口径 ✓）：`kbAddVault` / `kbRemoveVault` 会**改数据**
 *   （改 IDE 清单 / 删库目录），但**本类依旧没有"替页面写"的能力** —— 它们只是把真源那两步
 *   （各自带**原生对话框**：选目录 / 确认框 ✓）请出来，用户按下去之后由 VsSaros 侧落盘 ✓。
 *   其余写入/执行类（改文件内容、跑命令）仍然一律没有 ✗。
 */
class DshPageCommandContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.dshHarness.pageCommands';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroups: IEditorGroupsService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		// 判断"这个布局有没有面板"（agent 布局没有 ✗）⇒ 决定终端建在 Panel 还是 Editor ✓
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		// `openResourceSettings` 的 mcp 分支要定位**真源文件** `<数据根>/mcp.json`
		//（数据根由 `userDataRootFromRoamingHome(userRoamingDataHome)` 推 —— dev 是 `.vssaros-dev` ✓）
		@IEnvironmentService private readonly _environment: IEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IViewsService private readonly _viewsService: IViewsService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IWorkbenchManagerService private readonly _workbenchManager: IWorkbenchManagerService,
		// 页面桥的 `insertChatReference` 要投给"活动聊天框" ⇒ 本类直接持有服务（原来只用一个局部变量）。
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		// 「回到 IDE」（`focusIde`，桥 15 → 16）：页面拿不到窗口级 API ⇒ 由宿主把主窗口提到前台。
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@ITofAuthService private readonly _tofAuth: ITofAuthService,
	) {
		super();
		if (!configurationService.getValue<boolean>(DshHarnessSettings.Enabled)) {
			return;
		}
		const dsh = instantiationService.invokeFunction(accessor => accessor.get(IDshHarnessService));
		this._register(dsh.onDidPageEvent(e => {
			if (e.kind === 'command') {
				void this._handle(e.command, e.viewId).catch(err => this._notifications.error(String((err as Error)?.message ?? err)));
			}
		}));
	}

	/**
	 * 插件页（侧栏 `dsh-plugin-w…` / 编辑区 `dsh-plugin-editor-w…`）发来的 `newChat` / `openSession`。
	 *
	 * ★ 2026-10-16（agents 方案 A 第 2 步时查出）：这两条原来**只有聊天宿主**（`DshChatInstanceHost`，按自己的
	 *   viewId 过滤）消费 ⇒ 插件页发出来**没人接**，agents 页的「发起会话」「打开对话」在真机里是静默空操作 ✗
	 *   （进程内探针只断"调了桥"，看不见宿主侧没人接 ✗）。
	 * 分工：聊天视图自己的 newChat/openSession 仍归聊天宿主（这里按 viewId 前缀放行，**不会**双开 ✓）。
	 */
	private async _handlePluginChatCommand(command: { method: 'newChat'; agentPreset?: string } | { method: 'openSession'; sessionId: string; agentPreset?: string; cwd?: string }, viewId: string): Promise<void> {
		if (command.method === 'newChat') {
			this._logService.info(`[dshHarness] plugin page ${viewId} newChat${command.agentPreset ? ` preset=${command.agentPreset}` : ''} ⇒ agentStudio.newChatInEditor`);
			await this._commands.executeCommand('agentStudio.newChatInEditor', command.agentPreset ? { presetId: command.agentPreset } : undefined);
			return;
		}
		// openSession：会话绑定的权威在聊天宿主 ⇒ **新开一个聊天页签**再交给它绑（用户定稿：不复用当前聊天框）。
		const bound = await this._dispatchOpenSession(command, viewId);
		if (!bound) {
			this._logService.warn(`[dshHarness] plugin page ${viewId} openSession ${command.sessionId}：新聊天页签没有出现（4000ms），无法绑定`);
			this._notifications.warn(localize('dshHarness.page.openSessionNoChat', "没能打开聊天框（页签未出现），因此这条会话没有被打开：请稍后重试，或在 agent 栏手动新建一个聊天。"));
		}
	}

	/**
	 * 把一条 `openSession` 落到聊天页签上（2026-10-19 两轮用户口径的**最终形态**）：
	 *
	 *   ① **本窗口已经打开了这条会话** ⇒ 只把焦点给到那个页签，**绝不**再开一个（用户原话）；
	 *   ② 本窗口没有 ⇒ 新开一个页签并把它绑到这条会话（不要"复用当前聊天框"把用户正在看的会话换掉）。
	 *
	 * 为什么①优先：不开新页签 = 不制造重复页签、不打断用户；而"复用当前聊天框"只换内容会让用户
	 * 以为没反应（页签还停在原来那条会话上）⇒ 两条合起来才是"打开＝切到它 / 没开＝新开一个"。
	 *
	 * 实现：先查本窗口有没有视图绑着这条会话（`_findChatViewForSession`）→ 有就 `_revealChatView`
	 * 把它显出来；没有才 `agentStudio.newChatInEditor`（等它**在场**）→ 把 openSession 转给它
	 * （它会先 `session.start` 幂等接管再换绑，见 `_openSession`）→ 聚焦该页签。
	 * @returns 实际接单的聊天视图 id；没接上 ⇒ `undefined`（调用方负责如实提示）
	 */
	private async _dispatchOpenSession(command: { sessionId: string; agentPreset?: string; cwd?: string }, viewId: string): Promise<string | undefined> {
		// ★ 幂等①：**本窗口的页签已经在显示这条会话** ⇒ 只聚焦，不再开第二个。
		//   判据是 chatId 记账（`findChatIdForSession`），**不是** listViews —— 真机日志实证：
		//   视图槽会随 pane 隐藏/回收消失，而页签还在 ⇒ 只看视图会每次都判"没打开"，越点越多 ✗。
		const knownChatId = this._dsh.findChatIdForSession(command.sessionId);
		if (knownChatId && await this._revealChatTab(knownChatId)) {
			this._logService.info(`[dshHarness] plugin page ${viewId} openSession ${command.sessionId} ⇒ 本窗口页签 ${knownChatId} 已在显示它，只把焦点给过去`);
			return `chat:${knownChatId}`;
		}
		// 幂等②（兜底）：记账里没有，但确实有活跃视图绑着它（例如本窗口外的记账路径）⇒ 同样只聚焦。
		const already = await this._findChatViewForSession(command.sessionId);
		if (already && await this._revealChatView(already)) {
			this._logService.info(`[dshHarness] plugin page ${viewId} openSession ${command.sessionId} ⇒ 本窗口已打开它，只把焦点给到 ${already}`);
			return already;
		}
		// ② 本窗口没有 ⇒ 新开一个页签，并且**把 openSession 交给"刚建的那个"**（不是"最近活跃的那个"）。
		//   真机日志：按 activeChatViewId 等"新出现的视图"会拿到**别的页签**，于是新页签成了空壳、
		//   原页签被反复 rebind ⇒ 看起来就是"重复显示 + 有的页签打不开"✗。
		const beforeChatIds = new Set(this._openChatIds());
		this._logService.info(`[dshHarness] plugin page ${viewId} openSession ${command.sessionId} ⇒ 新开聊天页签并绑到这条会话（不复用当前聊天框）`);
		await this._commands.executeCommand('agentStudio.newChatInEditor');
		const newChatId = await this._waitForNewChatId(beforeChatIds, 4000);
		if (newChatId) {
			// 先把它显出来（pane 可见才会建视图），再等它的视图出现 ⤵
			await this._revealChatTab(newChatId);
			const target = await this._waitForChatView(newChatId, 4000);
			if (target && this._dsh.dispatchPageCommand(target, { method: 'openSession', ...command })) {
				this._logService.info(`[dshHarness] plugin page ${viewId} openSession ${command.sessionId} ⇒ 已交给新建的聊天框 ${target}（chat ${newChatId}）`);
				return target;
			}
			this._logService.warn(`[dshHarness] plugin page ${viewId} openSession ${command.sessionId}：新页签 ${newChatId} 的视图 4000ms 内没出现，无法绑定`);
			return undefined;
		}
		// 连"哪个页签是新建的"都认不出来（极旧宿主/布局异常）⇒ 退回按活跃视图等，至少不静默。
		const before = this._dsh.activeChatViewId;
		const created = await this._waitForNewChatView(before, 4000);
		if (created && created !== before && this._dsh.dispatchPageCommand(created, { method: 'openSession', ...command })) {
			this._logService.info(`[dshHarness] plugin page ${viewId} openSession ${command.sessionId} ⇒ 已交给聊天框 ${created}（按活跃视图兜底）`);
			await this._revealChatView(created);
			return created;
		}
		return undefined;
	}

	/** 当前打开的聊天页签的 chatId 列表（用 `IEditorService.editors`，与视图是否存活无关）。 */
	private _openChatIds(): string[] {
		return this._editorService.editors
			.map(editor => (editor as { chatId?: string }).chatId)
			.filter((id): id is string => typeof id === 'string' && !!id);
	}

	/** 轮询等"比 before 多出来的那个 chatId"（= 刚新建的页签）。 */
	private async _waitForNewChatId(before: Set<string>, timeoutMs: number): Promise<string | undefined> {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const fresh = this._openChatIds().find(id => !before.has(id));
			if (fresh) {
				return fresh;
			}
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 100));
		}
		return undefined;
	}

	/** 轮询等"这个 chatId 对应的聊天视图"出现（视图 id 形如 `dsh-chat-w<win>-<chatId>`）。 */
	private async _waitForChatView(chatId: string, timeoutMs: number): Promise<string | undefined> {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			let views: readonly IDshViewInfo[] = [];
			try {
				views = await this._dsh.listViews();
			} catch {
				views = [];
			}
			const hit = views.find(v => v.surface === 'chat' && v.viewId.endsWith(`-${chatId}`));
			if (hit) {
				return hit.viewId;
			}
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 100));
		}
		return undefined;
	}

	/**
	 * 找出**本窗口**里正在显示这条会话的聊天视图。
	 *
	 * ⚠ 必须按 `ownerWindowId` 过滤（2026-10-19 用户要求「当前窗口已打开就只聚焦」）：
	 *   别的窗口里的聊天页签在本 renderer 的 `editorService` 里**根本找不到** ⇒ 不滤窗口的话
	 *   会"查到了却聚焦不了"，于是又新开一个（就是用户说的"重复打开新聊天窗口"✗）。
	 *   跨窗口仍然如实记一行：本窗口确实没开 ⇒ 新开一个反而是对的（不跨窗口抢焦点）。
	 */
	private async _findChatViewForSession(sessionId: string): Promise<string | undefined> {
		try {
			const views = await this._dsh.listViews();
			const chats = views.filter(v => v.surface === 'chat' && v.sessionId === sessionId);
			if (!chats.length) {
				return undefined;
			}
			const mine = chats.find(v => v.ownerWindowId === mainWindow?.vscodeWindowId);
			if (mine) {
				return mine.viewId;
			}
			this._logService.info(`[dshHarness] 会话 ${sessionId} 只在别的窗口打开（窗口 ${chats.map(v => v.ownerWindowId).join('/')}）⇒ 本窗口按"没打开"处理`);
			return undefined;
		} catch (e) {
			this._logService.warn('[dshHarness] _findChatViewForSession: listViews failed', e);
			return undefined;
		}
	}

	/**
	 * 插件页发来的 `renameSession`（会话历史页右键「重命名会话」）。
	 *
	 * 为什么不是"页面自己改名就算完"：dsh 只允许**聊天页**（有 dsh 客户端上下文）调
	 * `ctx.sessions.rename` ⇒ 必须经宿主转交给"正在显示这条会话的聊天视图"。
	 * 该会话当前**没在聊天框里打开**时，先按 `openSession` 同款把它绑上（含 `session.start` 幂等接管）
	 * 再改名 —— 否则"没打开就改不了名"，用户会以为重命名坏了。
	 * 成败由页面回执（`vssaros-dsh-renamed` → `onDidDshSessionRenamed`）决定，这里**不假装成功** ✓。
	 */
	private async _handlePluginRename(command: { sessionId: string; title: string; agentPreset?: string; cwd?: string }, viewId: string): Promise<void> {
		if (await this._dsh.renameDshSession(command.sessionId, command.title)) {
			this._logService.info(`[dshHarness] plugin page ${viewId} renameSession ${command.sessionId} → "${command.title}"（已有聊天框，等页面回执）`);
			return;
		}
		this._logService.info(`[dshHarness] plugin page ${viewId} renameSession ${command.sessionId}：没有聊天框绑着它 ⇒ 先绑再改名`);
		if (!await this._dispatchOpenSession(command, viewId)) {
			this._notifications.warn(localize('dshHarness.page.renameNoChat', "没能打开聊天框，因此这条会话没有被重命名：请稍后重试。"));
			return;
		}
		// 换绑是异步的（宿主 → 页面 rebind）：轮询到"该视图确实绑上了这条会话"再改名。
		const started = Date.now();
		while (Date.now() - started < 4000) {
			if (await this._dsh.renameDshSession(command.sessionId, command.title)) {
				this._logService.info(`[dshHarness] plugin page ${viewId} renameSession ${command.sessionId} → "${command.title}"（先绑定后改名，${Date.now() - started}ms）`);
				return;
			}
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 200));
		}
		this._logService.warn(`[dshHarness] plugin page ${viewId} renameSession ${command.sessionId}：4000ms 内没能把它绑到聊天框，改名未发出`);
		this._notifications.warn(localize('dshHarness.page.renameBindTimeout', "没能把这条会话绑到聊天框，因此没有改名：请稍后重试，或先打开这条会话再改名。"));
	}

	/** 视图 id（`dsh-chat-w<win>-<chatId>`）→ 聚焦对应聊天页签；解析不出 chatId ⇒ false。 */
	private async _revealChatView(viewId: string): Promise<boolean> {
		const m = /^dsh-chat-w\d+-(.+)$/.exec(viewId);
		return m ? this._revealChatTab(m[1]) : false;
	}

	/**
	 * 按 **chatId** 把聊天页签显出来并聚焦（"打开会话"必须看得见才算打开）。
	 *
	 * 为什么需要：聊天视图是 `WebContentsView` 挂在编辑器 group 里，页面侧的 rebind 只换会话内容，
	 * **不会**把那一列拉到前台 ⇒ 用户点完"打开会话"可能什么都看不到（尤其聊天在别的 group / 被折叠时）。
	 * `NativeChatEditorInput.resource` 是 `native-chat:/<chatId>`（agentStudio.contribution 的 serializer
	 * 也是这么存的）⇒ 能唯一定位页签；找不到页签时**只记一行**、不硬开（不同布局下视图可能挂在非编辑器 group ✓）。
	 */
	private async _revealChatTab(chatId: string): Promise<boolean> {
		if (!chatId) {
			return false;
		}
		const resource = URI.from({ scheme: 'native-chat', path: `/${chatId}` });
		try {
			const found = this._editorService.findEditors(resource);
			if (!found.length) {
				// 兜底（"别重复开新页签"的最后一道保险）：按输入上的 chatId 再找一遍 ——
				// resource 形态将来若变（加 query/fragment），findEditors 会静默找不到，而那**不是**
				// "没打开"，直接新开就正好制造出用户抱怨的重复页签 ✗。
				const input = this._editorService.editors
					.find(editor => (editor as { chatId?: string }).chatId === chatId);
				if (!input) {
					this._logService.info(`[dshHarness] reveal chat ${chatId}：没有对应的编辑器页签（视图可能挂在非编辑器 group）`);
					return false;
				}
				await this._editorService.openEditor(input, { preserveFocus: false });
				this._logService.info(`[dshHarness] reveal chat ${chatId} ⇒ 按 chatId 兜底聚焦到聊天页签`);
				return true;
			}
			await this._editorService.openEditor(found[0].editor, { preserveFocus: false }, found[0].groupId);
			this._logService.info(`[dshHarness] reveal chat ${chatId} ⇒ 已切到 group ${found[0].groupId} 的聊天页签`);
			return true;
		} catch (e) {
			this._logService.warn(`[dshHarness] reveal chat ${chatId} failed`, e);
			return false;
		}
	}

	/** 轮询等"新出现的活动聊天视图"（见 `_handlePluginChatCommand` 的降级路径）。 */
	private async _waitForNewChatView(previous: string | undefined, timeoutMs: number): Promise<string | undefined> {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const current = this._dsh.activeChatViewId;
			if (current && current !== previous) {
				return current;
			}
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 100));
		}
		const last = this._dsh.activeChatViewId;
		return last && last !== previous ? last : undefined;
	}

	/**
	 * **不**需要 IDE 主窗口露面的命令（其余一律先还原 IDE —— 用**黑名单**而不是白名单：新增的
	 * 桥命令默认按"要给 IDE 出界面"处理，忘登记只会多还原一次窗口，不会变成"点了没反应" ✓）。
	 *
	 * 背景：启动时若把 IDE 主窗口收进了任务栏（`openDesktopOnStartup`，用户 2026-10-21 要求
	 * "F5 只看到那个窗口"），而命令作用在看不见的窗口上 ⇒ 用户看到的就是"点了没反应" ✗
	 * （本仓高频缺陷形态）。所以凡是要让 IDE 出界面的命令，到达时先把主窗口还原到前台。
	 *
	 * ★ 名单本体搬到 `common/dshPageBridgeProtocol.ts`（`DSH_PAGE_COMMANDS_WITHOUT_IDE_UI`）——
	 *   私有静态集没法被单测断言 ⇒ 等于没有守卫 ✗。
	 * ★ 2026-10-21：`signInIde` / `signOutIde` 在名单里 ⇒ **窗口里点「登录」不再切到 IDE 模式**
	 *   （用户原话："窗口模式下，点击登录会切换到 ide 模式，要求不切换，在当前模式下，直接登录"）✓。
	 */
	private static readonly NO_IDE_UI_METHODS = DSH_PAGE_COMMANDS_WITHOUT_IDE_UI;

	/**
	 * 把 IDE 主窗口**再藏一次**（desktop 模式的兜底，2026-10-21）。
	 *
	 * 为什么需要：TOF 登录要开系统浏览器 ⇒ 窗口层面的外部动作（系统把焦点还给本应用的窗口）
	 * 会把 IDE 主窗口拉到前台（真机日志：桌面窗口 BLUR 后 1.6s IDE 主窗口 FOCUS ✗）。
	 * 主进程那边的 **desktop 守卫**（`common/dshIdeWindowGuard.ts`）是第一道防线；这里是第二道
	 * （守卫没装上 / 事件漏了时的兜底）✓。
	 *
	 * ⚠ 只在 `dshIdeWindowHidden.value === true` 时才调（那个标记**只有 IDE 主窗口那个 renderer**
	 *   会置位 ⇒ 桌面窗口那个 renderer 里它是 false ⇒ 绝不会把桌面窗口自己藏掉 ✗）。
	 */
	private async _rehideIdeWindow(reason: string): Promise<void> {
		try {
			await this._nativeHostService.hideWindow({ targetWindowId: this._nativeHostService.windowId });
			this._logService.info(`[dshHarness] ${reason} ⇒ IDE 主窗口保持隐藏（desktop 模式下它不该露面 ✓）`);
		} catch (err) {
			this._logService.warn(`[dshHarness] ${reason} ⇒ 重新隐藏 IDE 主窗口失败`, err);
		}
	}

	private async _handle(command: Exclude<DshPageCommand, { method: 'ping' }>, viewId: string): Promise<void> {
		// 「IDE 窗口被我们收起来了 + 这条命令要让 IDE 出界面」⇒ 先把主窗口拉回前台
		if (dshIdeWindowHidden.value && !DshPageCommandContribution.NO_IDE_UI_METHODS.has(command.method)) {
			dshIdeWindowHidden.value = false;
			this._logService.info(`[dshHarness] page ${command.method}: IDE 主窗口启动时被藏了起来 ⇒ 先显示到前台`);
			try {
				// 隐藏态必须先 show（`focusWindow` 对隐藏窗口无效），再聚焦 ✓
				await this._nativeHostService.showWindow({ targetWindowId: this._nativeHostService.windowId });
				await this._nativeHostService.focusWindow({ targetWindowId: this._nativeHostService.windowId, mode: FocusMode.Force });
			} catch (err) {
				this._logService.warn('[dshHarness] 显示 IDE 主窗口失败（命令照常执行）', err);
			}
		}
		switch (command.method) {
			case 'newChat':
			case 'openSession':
				if (viewId.startsWith('dsh-plugin-')) {
					await this._handlePluginChatCommand(command, viewId);
					return;
				}
				// ⚠⚠ 2026-10-29（真机报障：聊天框顶部「专属 agent」胶囊菜单里「开新会话」点了**没反应**）：
				//   聊天视图（`dsh-chat-w1-…` / `dsh-desk-chat-w2-…`）原来直接落到函数末尾的 `return`
				//   ⇒ 命令被**静默丢弃**：不执行、**一行日志都不打**、不给页面任何回执
				//   ⇒ 用户只看到"点了没反应"（而同文件下面 openFile 那条早就有"必须留痕"的教训 ⇒ 同一坑第二次复发 ✗✗）。
				//   ⇒ 这里必须**留痕 + 给用户一句明确的话**（聊天窗口里请用输入框旁的「＋ 新会话」）。
				this._logService.info(`[dshHarness] page ${command.method}: 视图 ${viewId} 不是插件页 ⇒ 聊天视图暂不支持这条命令（胶囊菜单「开新会话」请改用输入框旁的「＋ 新会话」）`);
				this._notifications.warn(localize('dshHarness.page.chatViewNewChatUnsupported', "当前聊天窗口暂不支持从胶囊菜单新建会话：请点输入框旁的「＋ 新会话」。"));
				return;
			case 'renameSession':
				// 插件页（会话历史）右键改名：只受理插件页发来的（聊天页自己有 ctx.sessions.rename，不走这条）。
				if (viewId.startsWith('dsh-plugin-')) {
					await this._handlePluginRename(command, viewId);
				}
				return;
			case 'openFile':
			case 'reveal': {
				const uri = URI.file(command.path);
				if (!(await this._fileService.exists(uri))) {
					this._notifications.warn(localize('dshHarness.page.missing', "DSH 请求打开的文件不存在：{0}", command.path));
					return;
				}
				const run = () => command.method === 'openFile' ? this._open(uri, command.startLine, command.endLine) : this._reveal(uri);
				// ★★ 2026-10-15（用户报"点击知识库里的文件打不开 editorpane"）：**知识库默认在工作区之外**
				//   （`<数据根>/knowledge-base/…` ✓，本机实测 `C:\Users\<u>\.vssaros-dev\knowledge-base` ✗
				//   而工作区是 `g:\SarosWorkspace\…`）⇒ 原来这一支对**每一行**都要先弹一条带「打开」按钮的
				//   通知 ⇒ 不知道要点那条通知的人看到的就是"点了没反应" ✓。
				//   现在**知识库内直接开** ✓（与 VsSaros 自己的知识库视图同一口径：它打开这些文件从不确认 ✓）；
				//   ⚠ 信任面只有"数据根 ＋ 已登记库根"（`common/dshKbTrust.ts` ✓），其它工作区外路径**照旧**要确认 ✓。
				// ⚠ 顺带补**留痕**（`openTerminal` 那次同类教训：这一支原来**一行日志都不打** ⇒ 无法区分
				//   "命令没到宿主"与"到了但被闸住"，两种都表现为"没反应" ✗）⇒ 以后报"点不开"先看这一行 ✓。
				const inWs = this._insideWorkspace(command.path);
				const kbInside = this._insideKnowledgeBase(command.path);
				this._logService.info(`[dshHarness] page ${command.method}: ${command.path} ⇒ ${inWs ? '工作区内（直接开 ✓）' : kbInside ? '知识库内（免确认，直接开 ✓）' : '工作区外 ⇒ 已弹确认通知，等用户点「打开」'}`);
				if (inWs || kbInside) {
					await run();
				} else {
					this._notifications.prompt(Severity.Info, localize('dshHarness.page.outside', "DSH 页面请求打开工作区之外的文件：{0}", command.path), [{
						label: localize('dshHarness.page.open', "打开"),
						run: () => void run(),
					}]);
				}
				return;
			}
			case 'openMarkdown': {
				// 计划审阅等内存态 markdown（2026-10-15）：dsh 官方开在它的右侧栏 plan-review tab，
				//   我们壳没有侧栏 ⇒ 投到编辑器区的 untitled 页（与「显示 Host 日志」同一先例 ✓）。
				//   留痕（openTerminal 那次的教训：不打日志 ⇒ "没反应"无法区分"没到"与"被闸" ✗）。
				this._logService.info(`[dshHarness] page openMarkdown: ${command.text.length} 字符${command.title ? `（${command.title}）` : ''} ⇒ untitled 编辑器 ✓`);
				await this._editorService.openEditor({
					resource: undefined, forceUntitled: true,
					contents: command.text, languageId: 'markdown',
					options: { pinned: true },
				});
				return;
			}
			case 'insertChatReference': {
				// 工作台**页面** → 聊天草稿（桥 4 → 5，2026-10-14）：与编辑器右键/工作台树行**同一条落点**
				// （`pushReferenceToActiveChat`）—— 否则两条路会各自漂移 ✗。
				//
				// ⚠ 目标视图由**宿主**定：插件页拿不到会话身份（创建时 sessionId 传 undefined ⇒ `api.sessionId === null`），
				//   页面桥又是单向的 ⇒ 页面自报不了"投给哪个聊天"，只有宿主知道 `activeChatViewId` ✓。
				// ⚠ 这里**不读盘**、不校验文件存在（与 `openFile` 不同）：本命令只把引用放进草稿，
				//   "这条引用指向什么"由模型调 kb_read / 文件系统工具时才知道（对齐 dsh 上游 @file 的口径 ✓）。
				await pushReferenceToActiveChat({ dsh: this._dsh, notifications: this._notifications }, {
					path: command.path,
					...(command.startLine === undefined ? {} : { startLine: command.startLine }),
					...(command.endLine === undefined ? {} : { endLine: command.endLine }),
				});
				return;
			}
			case 'showUncommittedDiff': {
				// 「看改动」：HEAD ↔ 工作区 的 diff。旧内容只有 git 知道，而工作台拿不到扩展宿主 API
				// ⇒ 由扩展命令代劳（`extensions/agent-studio` ✓）。
				// 扩展不可用 / 该文件没有未提交改动 ⇒ **回退成直接打开文件**并说明（不许"点了没反应" ✗）。
				//
				// ★★ 2026-10-14 修正（用户要求「在**文件编辑器窗口**中显示 diff editor pane」）：
				//   从前直接调扩展的 `openUncommittedDiff`，它内部用 `vscode.diff` ⇒ 落在**当前活动分组**，
				//   而用户是在**聊天列**点的按钮 ⇒ diff 被开进那条窄的聊天列（真机截图：代码被换行挤成一列 ✗✗）。
				//   现在改成**分工**：扩展的新命令 `getUncommittedDiff` 只**算**出两条资源 URI（字符串 ✓），
				//   由工作台用 `mainPart.activeGroup` 显式开进**文件编辑区** ✓ —— 与本文件 `_open()`、
				//   `openAgentSettings`、「查看文件」跳转（`agentStudio.contribution.ts:3699-3715`）同一口径 ✓。
				//   旧命令仍作兜底保留：扩展产物没重编译时（`out/extension.js` 旧 ✗）至少开得出来 ✓。
				const uri = URI.file(command.path);
				if (!(await this._fileService.exists(uri))) {
					this._notifications.warn(localize('dshHarness.page.missing', "DSH 请求打开的文件不存在：{0}", command.path));
					return;
				}
				const fileName = command.path.replace(/\\/g, '/').split('/').pop() ?? command.path;
				const run = async () => {
					let opened = false;
					// ① 新路径：扩展算 URI，工作台开在**文件编辑区**（mainPart.activeGroup）✓
					try {
						const found = await this._commands.executeCommand<{ original?: string; modified?: string; name?: string } | undefined>('agentStudio.getUncommittedDiff', command.path);
						if (found?.original && found?.modified) {
							const pane = await this._editorService.openEditor({
								original: { resource: URI.parse(found.original) },
								modified: { resource: URI.parse(found.modified) },
								label: `${found.name ?? fileName}（未提交改动）`,
								options: { pinned: true },
							}, this._editorGroups.mainPart.activeGroup);
							opened = !!pane;
						}
					} catch {
						// 扩展产物较旧（没有这条命令）/ 未激活：不静默 —— 走下面的旧命令 + 回退 ✓
					}
					// ② 旧路径兜底：命令内部用 `vscode.diff`（会落**活动分组** ⇒ 可能又是聊天列 ✗，但不至于没反应 ✓）
					if (!opened) {
						try {
							opened = (await this._commands.executeCommand<boolean>('agentStudio.openUncommittedDiff', command.path)) === true;
						} catch {
							// 扩展没装 / 没激活 / 命令未注册：走下面的回退 + 说明 ✓
						}
					}
					this._logService.info(`[dshHarness] page showUncommittedDiff: ${command.path} ⇒ ${opened ? 'diff 已在文件编辑区打开 ✓' : '无未提交改动（或扩展不可用）⇒ 直接打开文件'}`);
					if (!opened) {
						this._notifications.info(localize('dshHarness.page.noDiff', "该文件没有未提交改动（或不在 git 仓库里）⇒ 已直接打开：{0}", command.path));
						await this._open(uri);
					}
				};
				// 知识库内的文件同样**免确认** ✓（理由见上面 `openFile` 那一支的 2026-10-15 注 ✓）
				if (this._insideWorkspace(command.path) || this._insideKnowledgeBase(command.path)) {
					await run();
				} else {
					this._notifications.prompt(Severity.Info, localize('dshHarness.page.outside', "DSH 页面请求打开工作区之外的文件：{0}", command.path), [{
						label: localize('dshHarness.page.open', "打开"),
						run: () => void run(),
					}]);
				}
				return;
			}
			case 'openTerminal': {
				// 在集成终端里开一个终端，并把命令**填进去（不执行）** —— 工具卡里跑过的命令一键重现 ✓
				// ⚠ 不做 `runInTerminal`：页面桥的安全模型是"只允许低风险界面命令"，页面里任何第三方前端插件
				// 都能调 `window.vssarosDsh.*` ⇒ 替用户执行命令属于执行类能力 ✗✗（用户始终按那次回车 ✓）。
				//
				// ⚠⚠ 2026-10-13 用户报"点了没反应、没打开 console"，而**这一段当时一行日志都不打** ✗ ⇒
				// 无法区分"命令没到宿主"还是"终端建了但面板没展开"（两种都表现为"没反应" ✗）⇒ 现在全程留痕 ✓。
				// ★ 2026-10-13（用户第三次纠正后定稿）：**终端就该落在文件编辑器区域下方的 panel** ✓ ——
				//   我上一轮判成"agent 布局没有 panel"是**读过头了** ✗：`agentLayoutWorkbench.ts:210` 那句只是
				//   "**不自动恢复** panel 容器"（默认隐藏 ✓），而 panel 是**用户可切换**的部件 ✓
				//   （同文件 L791-792、L859-860 按 `panelVisible` 决定隐藏；L962 `toggleAgentsPanel()` 就是"打开它"✓）。
				//   ⇒ 正确做法：**先把 panel 显出来**，再把终端建在 Panel 位置 ✓（而不是改用编辑区 ✗）。
				//
				//   为什么不能用 `layoutService.setPartHidden(false, PANEL_PART)` ✗：标准 `Layout` 那条路径
				//   **不恢复 panel 高度、也不打开容器** ⇒ agents 布局下 panel 以 size=0 建成 ⇒
				//   "网格可见但高度 0"（真机症状：点完下方什么都不出现 ✗，见 `toggleAgentsPanel` 的注释 ✓）。
				//   公开入口只有标题栏那个按钮用的 **DOM 事件** `agent-studio:toggle-panel` ✓（两个布局各有监听器：
				//   agents → `toggleAgentsPanel()` ✓，sessions → `workbench.ts:1315` ✓，两处都补齐了那四件事 ✓）。
				//
				// ★★★ 2026-10-14（用户第三次反馈 + 运行日志实证）：**判据不能是 `isVisible(Parts.PANEL_PART)`** ✗✗。
				//   它读 `PANEL_HIDDEN` 运行时状态（`layout.ts:1359-1360`），而 agents 布局的隐藏是**纯 DOM** 的
				//   （inline `display:none`，`agentLayoutWorkbench.ts:859-860`）⇒ 该状态从未置位 ⇒ `isVisible`
				//   **恒为 true**。日志实锤：`panel=已可见 location=panel` + `终端已创建（instanceId=1）`，
				//   用户再点一次又是 `instanceId=2` ⇒ **建了两个"看不见的终端"**（上一版 `if (!before)` 永不触发的后果 ✗）。
				//   ⇒ 改判 **DOM 真相**（元素 `display` + `offsetHeight`），驱动那条**切换**事件**收敛**到"显示"：
				//     状态与 DOM 不一致时，第一次派发会走"隐藏"分支（无视觉变化，但顺带把状态置为 hidden ✓）
				//     ⇒ 第二次必然落进"显示"分支（清 inline display + 恢复 35% 高度 + 打开容器 ✓）。
				//     因此最多两次、每次都复核 DOM ✓；**只有真的显示出来了才建在 Panel 里** ✓。
				const panelElement = () => this._layoutService.getContainer(mainWindow, Parts.PANEL_PART);
				const panelDomShown = (el: HTMLElement | undefined): boolean =>
					!!el && el.style.display !== 'none' && el.offsetHeight > 0;
				/** 派发一次"切换 panel"（`normalizeFirst` 见下）；等一拍让网格重建完再复核 ✓。 */
				const firePanelToggle = async (normalizeFirst: boolean): Promise<void> => {
					if (normalizeFirst) {
						// 第 2 轮兜底：**我们自己**先把状态对齐（布局侧 `toggleAgentsPanel()` 也会对齐 ✓，
						// 两边各修一次 ⇒ 任何一边回归都不致命 ✓）。只在状态"谎报可见"时才动手 ✓。
						try {
							if (this._layoutService.isVisible(Parts.PANEL_PART)) {
								this._layoutService.setPartHidden(true, Parts.PANEL_PART);
							}
						} catch { /* 对齐失败也照常派发，后面还会复核 ✓ */ }
					}
					document.dispatchEvent(new CustomEvent('agent-studio:toggle-panel'));
					await new Promise<void>(resolve => setTimeout(resolve, 200));
				};
				const wasShown = panelDomShown(panelElement());
				let panelShown = wasShown;
				for (let attempt = 0; !panelShown && attempt < 2; attempt++) {
					try {
						await firePanelToggle(attempt > 0);
					} catch {
						break; // 派发失败 ⇒ 按下面的回退走 ✓
					}
					panelShown = panelDomShown(panelElement());
				}
				// 面板真的出不来（布局里没有这个部件 / 展开被拒）⇒ 退到编辑区：至少让用户**看着**终端 ✓
				const location = panelShown ? TerminalLocation.Panel : TerminalLocation.Editor;
				this._logService.info(`[dshHarness] page openTerminal: cwd=${command.cwd ?? '(默认)'} command=${command.command ? `${command.command.length} chars` : '(空)'} panel=${wasShown ? '已显示' : (panelShown ? '原为隐藏，已展开 ✓' : '不可用 ⇒ 退到编辑区')} location=${location === TerminalLocation.Panel ? 'panel' : 'editor'}`);
				try {
					const terminal = await this._terminalService.createTerminal({
						location,
						...(command.cwd ? { config: { cwd: command.cwd } } : {}),
					});
					if (command.command) {
						await terminal.sendText(command.command, false);
					}
					// 焦点落在新终端上（面板刚展开时尤其需要：否则焦点还在别处，用户以为没打开 ✓）。
					// 两条都走：`focus` 命令未必展开面板 ✗ ⇒ 再用 `openView` 显式打开终端视图
					// （`TERMINAL_VIEW_ID`，"确保可见"的语义 ✓；任一失败都不算致命 ✓）。
					// 建在编辑区时不需要（终端页签由创建动作自己打开 ✓）。
					if (panelShown) {
						try { await this._commands.executeCommand('workbench.action.terminal.focus'); } catch { /* 命令可能不存在 */ }
						try { await this._viewsService.openView(TERMINAL_VIEW_ID, true); } catch { /* 视图可能未注册 */ }
					}
					this._logService.info(`[dshHarness] page openTerminal: 终端已创建（location=${location === TerminalLocation.Editor ? 'editor' : 'panel'}，instanceId=${String((terminal as { instanceId?: unknown }).instanceId ?? '?')}）`);
				} catch (e) {
					// 不许"点了没反应" ✗：终端起不来时至少把命令交给用户（剪贴板 + 明确提示）✓
					const msg = String((e as Error)?.message ?? e);
					this._logService.warn(`[dshHarness] page openTerminal failed: ${msg}`);
					try { await this._clipboardService.writeText(command.command ?? ''); } catch { /* 剪贴板也失败就不阻塞提示 */ }
					this._notifications.warn(localize('dshHarness.page.terminalFailed', "打开终端失败：{0}（命令已复制到剪贴板，可自行粘贴执行）", msg));
				}
				return;
			}
			case 'notify': {
				// `warn` 与 `attention` 同为警告级（页面侧两者都在用；见 dshPageBridgeProtocol 的 kind 注释）
				const severity = command.kind === 'attention' || command.kind === 'warn' ? Severity.Warning : Severity.Info;
				this._notifications.notify({ severity, message: `DSH: ${command.text}`, source: 'DeepSeek Harness' });
				return;
			}
			case 'switchPreset':
				// 方案 5.15：由拥有该视图的聊天宿主（DshChatBinding）按 chatId 处理，这里不消费。
				return;
			case 'importCodeWorkspace': {
				// ★ 2026-10-26（桥 `19 → 20`）：从 .code-workspace 文件导入多根工作区。
				//   页面读不了文件、也没有文件选择器 ⇒ 全部在 IDE 侧做（命令 `agentStudio.workspace.importCodeWorkspace`：
				//   选文件 → 解析 folders → 落一条多根记录 → 各根注册进 dsh）。**只导入，不切窗口** ✓。
				//   ⚠ 页面桥是单向的（拿不到回执）⇒ 成功/失败由那条命令自己通知 + 工作区记录推送体现 ✓。
				this._logService.info('[dshHarness] page importCodeWorkspace ⇒ 交给 IDE 命令 agentStudio.workspace.importCodeWorkspace');
				await this._commands.executeCommand('agentStudio.workspace.importCodeWorkspace');
				return;
			}
			case 'openAgentMarket':
				// Agent 商城是**编辑器页**（`agentStudio.openMarket`）：页面无法创建编辑器 ⇒ 宿主执行官方命令。
				// ★ 留痕（2026-10-15）：转发类命令一律先记一笔（"点了没反应且日志无线索"是最差的一种 ✓）。
				this._logService.info('[dshHarness] page openAgentMarket ⇒ 交给 IDE 命令 agentStudio.openMarket');
				void Promise.resolve(this._commands.executeCommand('agentStudio.openMarket')).catch(() => undefined);
				return;
			case 'openSkillMarket':
				// 技能商城（`agentStudio.openSkillMarket`，2026-10-15 新增；触发点 = dsh 集成页 `/x/skills/`
				// 的置顶主入口按钮）。与上一条**同一个理由**：商城是编辑器页（`SkillMarketEditorInput`），
				// 页面（WebContentsView）开不了 ⇒ 交宿主转成 IDE 自己的命令 ✓（不在宿主里 new EditorInput ✗）。
				this._logService.info('[dshHarness] page openSkillMarket ⇒ 交给 IDE 命令 agentStudio.openSkillMarket');
				void Promise.resolve(this._commands.executeCommand('agentStudio.openSkillMarket')).catch(() => undefined);
				return;
			case 'signInIde':
			case 'signOutIde': {
				// 登录/登出**接管 IDE 的账号**（桥 16 → 17，2026-10-21）：dsh 窗口里的那行账号不自己登录，
				//   而是请 IDE 走 TOF/OA 流程 ⇒ 窗口与 IDE 同一份登录态 ✓（结果由 IDE 推回页面 ✓）。
				// ★ 2026-10-21：**失败也必须让页面看见**（页面桥单向 ⇒ 只回 true ⇒ 失败无处可传 ✗）
				//   ⇒ 把失败原因经 `pushAuthError` 推回页面（只给一句人话，不含堆栈/票据 ✓）。
				//   否则用户看到的还是"未登录"（真实原因只落日志）⇒ 干等超时兜底 ⇒ "点了没反应" ✗。
				//
				// ★★ 2026-10-21（用户报障："在 desktop 模式下，点击登录，不要显示 ide 模式的窗口"）：
				//   TOF 登录要**开系统浏览器** ⇒ **窗口层面**的外部动作（系统把焦点还给本应用的窗口）
				//   会把 IDE 主窗口拉到前台（真机日志 dev 21:04:23.574 signInIde → 21:04:23.662 桌面窗口
				//   BLUR → 21:04:25.306 **IDE 主窗口 FOCUS** ✗）⇒ 我们自己的命令分发处根本没调用过
				//   showWindow ⇒ 拦不住 ⇒ 只能"登录期间 IDE 主窗口不许露面"：
				//     ① 主进程那边的 **desktop 守卫**（`dshIdeWindowGuard.ts`）兜住 show/focus ✓；
				//     ② 这里再补一刀"登录结束后它仍然是隐藏的"（守卫没装上/被绕过时的兜底 ✓）。
				const keepHidden = dshIdeWindowHidden.value;
				const signIn = command.method === 'signInIde';
				this._logService.info(`[dshHarness] page ${command.method} ⇒ IDE 账号服务 ${signIn ? 'login' : 'logout'}`);
				const fail = (e: unknown) => {
					const msg = String((e as Error)?.message ?? e);
					this._logService.warn(`[dshHarness] ${command.method} failed: ${msg}`);
					try {
						this._dsh.pushAuthError(msg);
					} catch (pushErr) {
						this._logService.warn(`[dshHarness] auth error push skipped: ${String((pushErr as Error)?.message ?? pushErr)}`);
					}
					if (keepHidden) {
						void this._rehideIdeWindow(`${command.method} 失败`);
					}
				};
				try {
					const p = signIn ? this._tofAuth.login() : this._tofAuth.logout();
					void Promise.resolve(p).then(
						() => { if (keepHidden) { void this._rehideIdeWindow(`${command.method} 完成`); } },
						e => fail(e),
					);
				} catch (e) {
					fail(e);
				}
				return;
			}
			case 'openSettings':
				// 左下角账号菜单的「⚙ 设置」（桥 17 → 18，2026-10-21）：设置编辑器只长在 IDE 窗口里，
				//   页面自己开不了 ⇒ 交给 IDE 的标准命令（与 `Ctrl+,` 同一条）✓。无参（不能指定哪一条设置）。
				this._logService.info('[dshHarness] page openSettings ⇒ 交给 IDE 命令 workbench.action.openSettings');
				void Promise.resolve(this._commands.executeCommand('workbench.action.openSettings')).catch(() => undefined);
				return;
			case 'openFeedback':
				// ★ 2026-10-26（用户：「意见反馈跳转到 <飞书问卷>」）：
				//   不再开 IDE 的 issue reporter（那是 VS Code 的面板、提交去 GitHub，没人看 ✗），
				//   直接交给系统浏览器打开产品自己的问卷 —— 与窗口里其它「外链」同一套行为 ✓。无参。
				this._logService.info(`[dshHarness] page openFeedback ⇒ 系统浏览器打开反馈问卷 ${DSH_FEEDBACK_URL}`);
				void Promise.resolve(this._nativeHostService.openExternal(DSH_FEEDBACK_URL)).catch(err => {
					this._logService.warn('[dshHarness] 打开反馈问卷失败（URL 已记在上一条日志里，可手动打开）', err);
				});
				return;
			// ★ 2026-10-23（桥 `18 → 19`）：desktop 窗口侧栏底部那行「更新」。
			//   三条都**不需要 IDE 出界面**（已登记进 `DSH_PAGE_COMMANDS_WITHOUT_IDE_UI`）——
			//   否则点一下"检查更新"就把 IDE 主窗口拉到前台，正好违反"只显示 desktop" ✗。
			case 'upgradeRefresh':
				// 面板打开 / 点「检查更新」：重算一份状态推回页面（页面桥单向 ⇒ 只能推 ✓）
				this._logService.info('[dshHarness] page upgradeRefresh ⇒ 重算升级状态');
				await this._dsh.refreshUpgrade();
				return;
			case 'upgradeBundled': {
				// 升级/安装一个随包插件（真正干活的是 IDE 插件中心那条 `dsh plugin add` 路）
				const r = await this._dsh.upgradeBundled(command.name);
				this._logService.info(`[dshHarness] page upgradeBundled ${command.name} ⇒ ok=${r.ok}${r.ok ? '' : ` err=${r.error ?? '-'}`}`);
				return;
			}
			case 'upgradeAsset': {
				// 升级一件商城资产（agent / mcp / workbench；skill/workflow 走 dsh 侧，这里只回原因）
				const r = await this._dsh.upgradeAsset(command.kind, command.slug);
				this._logService.info(`[dshHarness] page upgradeAsset ${command.kind}/${command.slug} ⇒ ok=${r.ok}${r.ok ? '' : ` err=${r.error ?? '-'}`}`);
				return;
			}
			case 'upgradeApp':
				// 一键升级应用：检查 → 比版本 →（更新源更新才）下载 → 安装并重启
				this._logService.info('[dshHarness] page upgradeApp ⇒ 一键升级应用');
				await this._dsh.upgradeApp();
				return;
			case 'openMediaGallery':
				// 媒体库（`agentStudio.openMediaGallery`，2026-10-19；触发点 = dsh 媒体库页
				// `/x/media/` 的置顶按钮）。与上面两条同源：媒体库是原生 `EditorPane`，
				// 页面开不了 ⇒ 宿主转成 IDE 自己的命令 ✓（不在宿主里 new EditorInput ✗）。
				// ⚠ 这条**取代**了原先的 `openModulePage('/x/media/')` —— 那条只能把 dsh 自己的
				//   文本列表页放大，给不出缩略图/收藏/分组/标签（用户原话："应该显示同一个样式的 editorpane"）。
				this._logService.info('[dshHarness] page openMediaGallery ⇒ 交给 IDE 命令 agentStudio.openMediaGallery');
				void Promise.resolve(this._commands.executeCommand('agentStudio.openMediaGallery')).catch(() => undefined);
				return;
			case 'focusIde': {
				// 「回到 IDE」（桥 `15 → 16`，2026-10-21；触发点 = dsh 桌面窗口侧栏底部那行品牌摘要）。
				//   · dsh 页面是 WebContentsView 里的前端，**没有窗口级 API**（`window.focus()` 只能激活它自己
				//     所在的那个窗口 ⇒ 对"回到另一个窗口"无效 ✗）⇒ 必须宿主代劳；
				//   · 目标 = **除本窗口外的主窗口**（`includeAuxiliaryWindows: false` ⇒ 桌面窗口那种辅助窗口
				//     不在列表里）。本窗口已经是唯一主窗口时就直接聚焦自己 ⇒ **绝不新开窗口** ✓
				//     （`agents.openVSCodeWindow` 那种"找不到就 openWindow"在这里是不行的：会凭空多出一个 IDE ✗）。
				//   · 只聚焦，不关桌面窗口：关了就回不去（用户随时可能按标题栏那个 Pop Out 切回来 ✓）。
				try {
					const windows = await this._nativeHostService.getWindows({ includeAuxiliaryWindows: false });
					const self = this._nativeHostService.windowId;
					const target = windows.find(w => w.id !== self) ?? windows.find(w => w.id === self);
					if (!target) {
						this._logService.warn(`[dshHarness] page focusIde: 没有可聚焦的主窗口（self=${self}, windows=${windows.map(w => w.id).join(',') || '(空)'}）`);
						return;
					}
					this._logService.info(`[dshHarness] page focusIde ⇒ 显示并聚焦主窗口 ${target.id}（本窗口 ${self}）`);
					// ⚠ 启动时主窗口可能是**隐藏**的（`hideWindow`）：`focusWindow` 对隐藏窗口无效 ⇒ 先 show ✓
					// ⚠ **先撤 desktop 守卫**：守卫会把 show/focus 事件压回去 ⇒ 不撤就是"刚显示就被藏" ✗
					//   （用户点「回到 IDE」= 从 desktop 模式回 IDE 模式 ⇒ 守卫必须撤 ✓）。
					await this._dsh.setIdeWindowHidden(false, target.id);
					await this._nativeHostService.showWindow({ targetWindowId: target.id });
					await this._nativeHostService.focusWindow({ targetWindowId: target.id, mode: FocusMode.Force });
					dshIdeWindowHidden.value = false;
				} catch (err) {
					this._logService.warn('[dshHarness] page focusIde failed', err);
					this._notifications.warn(localize('dshHarness.page.focusIdeFailed', "回到 VsSaros IDE 失败：{0}", String((err as Error)?.message ?? err)));
				}
				return;
				}
			case 'openDesktopWindow': {
				// 「＋ 新窗口」（桥 `21 → 22`，2026-10-29；触发点 = 命令面板的「新开 dsh 桌面窗口」）。
				//   语义 = **另开一扇**（不复用已开着的）⇒ 新窗口有自己的会话（按窗口 id 派生）
				//   与自己的网络分区 ⇒ 多扇并行工作互不干扰 ✓。
				// ⚠ 桌面模式下 IDE 主窗口是**藏着的** ⇒ 这条命令**不许**把 IDE 亮出来
				//   （用户 2026-10-21/22 明确否决过"点一下冒出 IDE 窗口"）⇒ 它已登记在
				//   `DSH_PAGE_COMMANDS_WITHOUT_IDE_UI`，本分支也不碰任何 IDE 窗口 ✓。
				this._logService.info('[dshHarness] page openDesktopWindow ⇒ 新开一扇 dsh 桌面窗口');
				try {
					const opened = await openDshFullWindow({ newWindow: true });
					if (!opened) {
						this._notifications.warn(localize('dshHarness.page.openDesktopWindowFailed', "没能新开一扇 dsh 桌面窗口（dsh 未启用，或当前引擎不是 dsh）"));
					}
				} catch (err) {
					this._logService.warn('[dshHarness] page openDesktopWindow failed', err);
					this._notifications.warn(localize('dshHarness.page.openDesktopWindowFailed', "没能新开一扇 dsh 桌面窗口：{0}", String((err as Error)?.message ?? err)));
				}
				return;
			}
			case 'splitChatPane': {
				// 「新窗格」（桥 `22 → 23`，2026-10-29；触发点 = 会话动作组里那枚「新窗格」按钮）。
				//   语义 = **在当前这扇桌面窗口里分屏出一栏**（左=原会话，右=新会话的纯聊天框），
				//   **不是**弹一扇独立窗口（用户原话："希望是在当前窗口下，分屏出一个聊天框"）✓。
				//   定位靠 `viewId`（发起请求的那个视图）⇒ 宿主据此知道是哪扇窗口 ✓。
				this._logService.info(`[dshHarness] page splitChatPane（视图 ${viewId}）⇒ 当前桌面窗口内分屏一栏`);
				try {
					const ok = await splitDshChatPane(viewId);
					if (!ok) {
						this._notifications.warn(localize('dshHarness.page.splitChatPaneFailed', "没能分屏出一栏新聊天（这台窗口不在 dsh 桌面窗口形态，或新会话没起来）"));
					}
				} catch (err) {
					this._logService.warn('[dshHarness] page splitChatPane failed', err);
					this._notifications.warn(localize('dshHarness.page.splitChatPaneFailed', "没能分屏出一栏新聊天：{0}", String((err as Error)?.message ?? err)));
				}
				return;
			}
			case 'paneAction': {
				// 分屏栏动作（桥 `23 → 24`）：把这一栏移到极端位置 / 关掉它。
				//   ⚠ 动的是 dsh 桌面窗口自己 ⇒ 不碰 IDE 主窗口（已登记在 `WITHOUT_IDE_UI`）✓
				//   ⚠ 为什么走页面菜单而不是拖拽：aux 窗口的 DOM 层收不到鼠标事件（真机证据）⇒ 见协议注释。
				this._logService.info(`[dshHarness] page paneAction ${command.action}（视图 ${viewId}）`);
				try {
					const ok = await paneDshChatPane(viewId, command.action);
					if (!ok) {
						this._notifications.warn(localize('dshHarness.page.paneActionFailed', "这一栏动不了：已经是那个位置，或者只剩这一栏。"));
					}
				} catch (err) {
					this._logService.warn('[dshHarness] page paneAction failed', err);
				}
				return;
			}
			case 'openResourceSettings': {
				// 「工具」页（`/x/skills/`，原「集成」页）里**技能行 / MCP 行**的齿轮（桥 `9 → 10`，2026-10-15；
				// 用户要求"技能/mcp item 中增加设置按钮，点击后打开 editorpane 修改" ✓）。两类落点不同，
				// 取舍写在协议那条命令的注释里，一句话版：
				//   · `skill` ⇒ **资源管理详情页**（`showDetailOnly('skill', id)`）—— 那页已有"改 SKILL.md /
				//     启停 / 卸载"，是技能真正能改的地方 ✓（集成侧栏点技能行走的也是这条 ✓）。
				//   · `mcp`   ⇒ **真源文件** `<数据根>/mcp.json`。⚠ 刻意**不用** IDE 那个 MCP 管理页：
				//     它读的是 `{root}/mcp/<slug>/config.json` 再同步进 VS Code 配置，而 dsh 侧挂载读的是这份
				//     扁平文件（页面自己也把它的路径印在诊断行上）⇒ 指过去会"点了设置、看到另一个列表" ✗。
				// ⚠ 一律开在**文件编辑区**（`mainPart.activeGroup`）：与 `openAgentSettings` 同一个理由 ——
				//   点齿轮时活动分组可能就是这个 dsh 页面本身（插件页也能开在编辑区）⇒ 不指定分组会把设置页
				//   和被点的页面挤成一组的两个页签、把后者顶到后台 ✗。
				const targetGroup = this._editorGroups.mainPart.activeGroup;
				if (command.kind === 'mcp') {
					const sarosRoot = userDataRootFromRoamingHome(this._environment.userRoamingDataHome);
					const uri = resolveSarosPath(sarosRoot, SarosPath.mcpConfig);
					// 文件不存在 ⇒ **如实说 + 指路**（不假装打开了什么 ✗）：没配过 MCP 的机器上确实是这个态 ✓
					if (!(await this._fileService.exists(uri))) {
						this._notifications.warn(localize('dshHarness.page.mcpConfigMissing',
							"MCP 配置文件还不存在：{0}（先加一台 MCP 服务器，这里才有可改的内容）", uri.fsPath));
						return;
					}
					await this._editorService.openEditor({ resource: uri, options: { pinned: true } }, targetGroup);
					return;
				}
				const pane = await this._editorService.openEditor(ResourceManagerEditorInput.getInstance(), { pinned: true }, targetGroup);
				const control = pane?.getControl();
				if (control instanceof ResourceManagerEditorPane) {
					await control.showDetailOnly('skill', command.id);
				} else {
					// 理论到不了：如实报，不静默（"点了有反应但没打开该开的东西"最难查 ✗）
					this._notifications.warn(localize('dshHarness.page.resourceSettingsFailed',
						"打不开资源详情页，技能设置未显示：{0}", command.id));
				}
				return;
			}
			case 'openAgentRoster': {
				// 优先聚焦原生 Agent 列表视图（`agentStudio.presetAgentView`：dsh 引擎下该容器承载插件自托管页
				// `/x/agents/`，静态侧是 `PresetAgentViewPane` ⇒ 同一个视图 id 两种引擎都对 ✓）；
				// 视图不可用（未注册 / 打不开）时回落资源管理页（技能 / 工具 / MCP / 知识库 / 工作流统一管理页）。
				//
				// ⚠ 2026-10-14 修：原来这里是 `executeCommand('agentStudio.presetAgent.focus')` —— **那个命令 id
				//   本仓根本不存在**（VS Code 只为**扩展清单** `viewsContainers` 声明的容器生成
				//   `workbench.view.extension.<id>` 之类的命令；我们这种**程序注册**的视图容器不会自动获得
				//   `<id>.focus`）⇒ 每次点击都抛 "command not found"、静默落到回落页，"优先显 Agent 列表"
				//   这条路**从来没生效过** ✗（"点了也会开到别的页"这种静默降级最难查 ⇒ 现由
				//   `test/common/dshPageCommandWiring.test.ts` ② 钉住：handler 里引用的每个命令 id 都必须真的存在 ✓）。
				const opened = await this._viewsService.openView(AGENT_STUDIO_PRESET_AGENT_VIEW_ID, true)
					.then(view => !!view).catch(() => false);
				// ★ 留痕（2026-10-15）：这条会**静默降级**（打不开就换资源管理页）⇒ 不留痕的话
				//   "怎么开到别的页去了"永远查不出来（2026-10-14 那次假命令 id 就是这种症状 ✗）。
				this._logService.info(`[dshHarness] page openAgentRoster ⇒ 聚焦 Agent 列表视图：${opened ? '成功' : '不可用 ⇒ 回落资源管理页'}`);
				if (!opened) {
					await Promise.resolve(this._commands.executeCommand('agentStudio.openResourceManager')).catch(() => undefined);
				}
				return;
			}
			case 'openBot': {
				/*
				 * ★ 方案 C2（2026-10-27）：一次点击 = **中栏开会话（绑该 bot 人格）+ 右栏开设置**。
				 *
				 * 为什么单独一条命令而不是页面连调两个：
				 *   · 连调时两次调用各自选分组，**顺序和焦点都不受控** —— 设置页会顶替 chat 所在的组，
				 *     用户看到的是"设置把会话挤走了"✗（真机上很难归因）；
				 *   · 这里由宿主**显式布局**：chat 进当前组 → 在它**右侧新建分组** → 设置开在新组里。
				 *
				 * preset id 口径与 `presetIdOf(agentId)` 一致（`vssaros-` + slug）。
				 */
				const preset = command.agentId.startsWith('vssaros-') ? command.agentId : `vssaros-${command.agentId}`;
				this._logService.info(`[dshHarness] page openBot ${command.agentId}（preset=${preset}）⇒ 中栏会话 + 右栏设置`);
				try {
					await this._commands.executeCommand('agentStudio.newChatInEditor', { presetId: preset });
				} catch (e) {
					// 聊天开不出来也要继续开设置页 —— 半成品比什么都不开好，且日志留痕
					this._logService.warn('[dshHarness] page openBot：打开会话失败（继续开设置页）', e);
				}
				const chatGroup = this._editorGroups.mainPart.activeGroup;
				let targetGroup = chatGroup;
				try {
					targetGroup = this._editorGroups.addGroup(chatGroup, GroupDirection.RIGHT);
				} catch (e) {
					// 分组建不出来 ⇒ 退回当前组（至少设置页能看到），不静默
					this._logService.warn('[dshHarness] page openBot：右侧分组创建失败，设置页退回当前组', e);
				}
				await this._editorService.openEditor(
					new AgentSettingsEditorInput(command.agentId, command.name),
					{ pinned: true },
					targetGroup,
				);
				return;
			}
			case 'openAgentSettings': {
				// dsh 的 Agents 页（`/x/agents`）行内「设置」→ 打开该 bot 的 VsSaros Agent 设置编辑器页
				// （2026-10-14，桥 `5 → 6`）。`command.agentId` 的口径 = `.agent.md` 目录名 = VsSaros
				// `Agent.id`（协议注释里写了三级合并那三处来源）⇒ 不需要映射表 ✓。
				// ⚠ 开在**文件编辑区**（mainPart.activeGroup）而不是"当前活动分组"：与 `_open()` 同一个理由 ——
				//   点这个按钮时活动分组有可能就是 dsh 页面本身（Agents 页也能开在编辑区）⇒ 不指定分组会把
				//   设置页和被点的页面挤成一组的两个页签、把后者顶到后台 ✗。
				await this._editorService.openEditor(
					new AgentSettingsEditorInput(command.agentId, command.name),
					{ pinned: true },
					this._editorGroups.mainPart.activeGroup,
				);
				return;
			}
			case 'openKbSettings':
			case 'openKbGraph': {
				// 知识库设置 / 关系图谱（桥 `6 → 7`，2026-10-15；用户报"缺设置按钮 / 缺关系图谱按钮" ✓）——
				// 这两条**只转成 IDE 自己的命令** ✓（`agentStudio.kb.openSettings` / `.openGraph` ✓）。
				// ⚠ 宿主这边**不自己 new EditorInput** ✗：host / 图谱数据都在 **`IKbCommandService`**
				//   （2026-10-15 第 2/3 期把"要视图状态"的那批动作从 `KnowledgeBaseViewPane` 搬出来了 ✓
				//    —— 因为 dsh 引擎下那个视图**根本不会被实例化** ✗，详见 README 5.137–5.139）。
				//   ＝ **同一个动作只有一份实现** ✓（不然两处必然漂移 ✗）。
				const commandId = command.method === 'openKbSettings' ? 'agentStudio.kb.openSettings' : 'agentStudio.kb.openGraph';
				// ★ 留痕（2026-10-15）：这四个入口此前**一条日志都没有** ⇒ 真机上"点了没反应"时无法区分
				//   "点击没到宿主" / "宿主转命令失败" ✗（那次排查就卡在这里）。转发类命令一律先记一笔 ✓。
				this._logService.info(`[dshHarness] page ${command.method} ⇒ 交给 IDE 命令 ${commandId}`);
				try {
					await this._commands.executeCommand(commandId);
					this._logService.info(`[dshHarness] page ${command.method} ⇒ ${commandId} 已执行`);
				} catch (e) {
					// 命令不存在（旧构建 / 模块没启用）⇒ **如实说**，不静默 ✗
					this._logService.error(`[dshHarness] page ${command.method} ⇒ ${commandId} 失败：${String((e as Error)?.message ?? e)}`);
					this._notifications.warn(localize('dshHarness.page.kbPanel', "这条命令不可用：{0}", `${commandId}（${String((e as Error)?.message ?? e)}）`));
				}
				return;
			}
			case 'kbFeishuSync': {
				// 同步飞书（桥 `11 → 12`，2026-10-19；用户报"点了同步飞书按钮只打开设置、没开始同步" ✓）——
				// 与上面 `openKbSettings` **完全同构**：宿主只把这一跳**转成 IDE 自己的命令**
				// （`agentStudio.kb.feishuSync`），判据与实现都在那条命令/服务里 ✓（同一个动作只有一份实现 ✓）。
				//
				// ⚠ 那条命令内部**不等同步结束**（分钟级长任务，fire-and-forget）⇒ 这里 await 也立刻返回；
				//   保留 await 只为把"命令不存在 / 抛错"如实记日志 + 通知用户（与上面两条同一套处理 ✓，
				//   否则又是"点了没反应、日志里啥也没有"那种最难查的形态 ✗）。
				const commandId = 'agentStudio.kb.feishuSync';
				this._logService.info(`[dshHarness] page ${command.method} ⇒ 交给 IDE 命令 ${commandId}`);
				try {
					await this._commands.executeCommand(commandId);
					this._logService.info(`[dshHarness] page ${command.method} ⇒ ${commandId} 已执行（同步在集成终端里跑，输出对用户可见）`);
				} catch (e) {
					this._logService.error(`[dshHarness] page ${command.method} ⇒ ${commandId} 失败：${String((e as Error)?.message ?? e)}`);
					this._notifications.warn(localize('dshHarness.page.kbPanel', "这条命令不可用：{0}", `${commandId}（${String((e as Error)?.message ?? e)}）`));
				}
				return;
			}
			case 'kbAddVault':
			case 'kbRemoveVault': {
				// 知识库**增删**（桥 `7 → 8`，2026-10-15；用户要求"下拉框要有增删功能" ✓）——
				// 与 ↑↑ 那两条同一句理由：要 `_vaults` / `saveVaults` / 建库目录那套 ⇒ 实现已在
				// **`IKbCommandService`**（第 1 期搬的 ✓），宿主只**转成 IDE 自己的命令** ✓
				// （`agentStudio.kb.addVault` / `.removeVault` ✓ —— 命令直接调服务，**不再经过视图** ✓）。
				// ⚠ 这两条**会改数据**，所以闸在**真源那两步自带的原生对话框**上（选目录 / 确认框 ✓）：
				//   用户按下去才落盘 ⇒ 页面依旧拿不到任何直接写能力 ✓（协议头部 2026-10-15 修订 ✓）。
				// ⚠ 两条命令**返回布尔**（"是否真的改了清单"）⇒ 用户在原生对话框里取消时，下面那次
				//   重启**不做** ✓（少一次"无缘无故的重启"✗）。
				const isAdd = command.method === 'kbAddVault';
				const commandId = isAdd ? 'agentStudio.kb.addVault' : 'agentStudio.kb.removeVault';
				// ★ 留痕（同上：这四个入口此前一条日志都没有 ⇒ 真机上"点了没反应"时无线索 ✗）
				this._logService.info(`[dshHarness] page ${command.method} ⇒ 交给 IDE 命令 ${commandId}${isAdd ? '' : `（vaultId=${command.vaultId}）`}`);
				let changed = false;
				try {
					changed = (await this._commands.executeCommand(commandId, isAdd ? undefined : command.vaultId)) === true;
					this._logService.info(`[dshHarness] page ${command.method} ⇒ ${commandId} 已执行（清单变化=${changed}）`);
				} catch (e) {
					this._logService.error(`[dshHarness] page ${command.method} ⇒ ${commandId} 失败：${String((e as Error)?.message ?? e)}`);
					this._notifications.warn(localize('dshHarness.page.kbVault', "这条命令不可用：{0}", `${commandId}（${String((e as Error)?.message ?? e)}）`));
					return;
				}
				// ⚠ 清单改完**本页看不到** ✗：库记录是 **Host 启动时**注入的（`dshHarnessService._kbVaultsJson()`
				//   只在起 Host 时读 storage ✓）⇒ 顺手重启一次让注入刷新 ✓（否则用户会以为"点了没反应" ✗）。
				//   代价如实记：页面会重载一次；dsh 会话在盘上、视图重开会自动重开（`dshChatInstanceHost` 的既有语义 ✓）。
				if (changed) {
					try {
						await this._dsh.restart();
					} catch (e) {
						this._notifications.warn(localize('dshHarness.page.kbRestart', "知识库清单已改，但重启 Host 失败（页面上的库列表要等下次启动才刷新）：{0}", String((e as Error)?.message ?? e)));
					}
				}
				return;
			}
			case 'openModulePage': {
				// 侧栏插件页请求「在编辑区打开我」（2026-10-13，用户 D1=A：「主页」的侧栏版是摘要 + 入口，
				// 完整版由编辑区承载）。route → 模块页表（**白名单**）→ 容器 → 编辑区页 ✓
				// ⚠ 白名单是必须的：页面里任何**第三方**前端插件都能调 `window.vssarosDsh.*` ⇒ 少了白名单
				//   就等于给了它"打开任意页面"的能力 ✗（协议里也是这个口径）。
				//
				// ★ 2026-10-19（用户报「关系图谱应该开在编辑区、不是侧栏」）：先**精确**匹配，再按**前缀**归属
				//   （`/x/kb/graph` ⇒ 归到 `/x/kb/`）。
				//   ⚠ 子路由**不写进** `DSH_MODULE_PAGES`：那张表与插件清单**逐项对账**
				//   （`dshModuleContainers.test.ts` 的"双轨对账"）⇒ 单方面加一条会立刻把对账打红 ✗（踩过）。
				//   ⇒ 白名单仍只登记**模块主页**，子路由靠前缀归属；可打开范围依然是
				//     "已注册模块的路由前缀之下"（仍然打不开第三方站点 ✓）。
				// ⚠ `p.route` 是可选的（`kind: 'none'` 的模块没有 route）⇒ 前缀比较前必须先判 string
				//   （否则 TS2345：`string | undefined` 不能给 `startsWith(string)`；watch-client 报过）。
				const page = DSH_MODULE_PAGES.find(p => p.route === command.route || p.route === `${command.route}/`)
					?? DSH_MODULE_PAGES.find(p => typeof p.route === 'string' && command.route.startsWith(p.route));
				const container = page ? DSH_MODULE_CONTAINERS.find(c => c.modules.includes(page.module)) : undefined;
				this._logService.info(`[dshHarness] page openModulePage: route=${command.route} ⇒ module=${page?.module ?? '(未在页表里)'} container=${container?.containerId ?? '(无)'}`);
				if (!page || !container) {
					this._notifications.warn(localize('dshHarness.page.unknownModulePage', "这个页面不在模块页表里，无法在编辑区打开：{0}", command.route));
					return;
				}
				const bar = container.activityBar;
				const title = typeof bar?.title === 'string' ? bar.title : bar?.title?.zh;
				// 「一个容器一个输入」（`getOrCreate` 单例 ✓）；tab 名取自容器表（如「主页」）而不是容器 id ✓
				// ★ 2026-10-19（用户报「关系图谱应该开在编辑区、不是侧栏」）：把**请求的 route** 传下去。
				//   否则只会打开模块主页（`/x/kb/`）—— 子页面（`/x/kb/graph`）永远打不开 ✗。
				//   白名单按「精确 → 前缀归属」，子路由**不登记**在 `DSH_MODULE_PAGES` 里（见上）。
				const input = DshPluginPageEditorInput.getOrCreate(container.containerId, title ?? container.containerId, command.route);
				await this._editorService.openEditor(input, { pinned: true });
				return;
			}
			case 'setWorkbenchPinned':
			case 'setWorkbenchHidden': {
				// 「工作台」组件的两个**单向动作**（2026-10-13）：route → 模块页表（**白名单**）→ 工作台条目
				// ⇒ 工作台管理服务。⚠ 页面**不回显**结果（dsh 侧读不到 pin / 显隐状态 ⇒ 用户选了"零新通道"的路 ✓）。
				const page = DSH_MODULE_PAGES.find(p => p.route === command.route || p.route === `${command.route}/`);
				const container = page ? DSH_MODULE_CONTAINERS.find(c => c.modules.includes(page.module)) : undefined;
				// ⚠ 服务按**条目 id** 操作（`entry.id`），不是容器 id ⇒ 先按 containerId/id 找一次；
				//   找不到就**明说**（不静默无动作 ✗ —— 那会表现成"点了没反应"）。
				const entry = container
					? this._workbenchManager.listWorkbenches().find(e => e.containerId === container.containerId || e.id === container.containerId)
					: undefined;
				if (!container || !entry) {
					this._notifications.warn(localize('dshHarness.page.unknownWorkbench', "这个页面不在模块页表里（或不在活动栏工作台清单里），无法操作：{0}", command.route));
					return;
				}
				const want = command.method === 'setWorkbenchPinned' ? command.pinned : command.hidden;
				this._logService.info(`[dshHarness] page ${command.method}: route=${command.route} ⇒ entry=${entry.id} 设为 ${want}`);
				if (command.method === 'setWorkbenchPinned') {
					this._workbenchManager.setPinned(entry.id, want);
				} else {
					this._workbenchManager.setHidden(entry.id, want);
				}
				return;
			}
		}
	}

	private _insideWorkspace(path: string): boolean {
		const roots = this._workspace.getWorkspace().folders.map(f => f.uri.scheme === 'file' ? f.uri.fsPath : '').filter(Boolean);
		return isPathInside(path, roots, isWindows || isMacintosh);
	}

	/**
	 * 路径是否落在**知识库**之内（数据根 or 某个**已登记**库根）—— 页面桥据此**免掉**"工作区外"那道确认 ✓。
	 *
	 * ★ 2026-10-15（用户报"点击知识库里的文件打不开 editorpane"）：知识库默认就在工作区之外
	 *   （`<数据根>/knowledge-base/…` ✓）⇒ 原来每点一行都要先点一条通知 ✓ = 用户眼里的"点了没反应" ✗。
	 *   ⚠ 信任面**没有**放宽：只有"数据根 ＋ 已登记库根"（口径与判据都在 `common/dshKbTrust.ts` ✓，
	 *     与 VsSaros 自己的知识库视图同一口径 ✓）；其它工作区外路径照旧确认 ✓。
	 *   ⚠ 服务拿不到清单时 `isInsideKnowledgeBase` 返回 `false`（fail-closed ✓ —— 读不到就**不放宽** ✓）。
	 */
	private _insideKnowledgeBase(path: string): boolean {
		try {
			return this._dsh.isInsideKnowledgeBase(path);
		} catch {
			return false;
		}
	}

	private async _open(resource: URI, startLine?: number, endLine?: number): Promise<void> {
		const selection = startLine ? { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine ?? startLine, endColumn: 1 } : undefined;
		// 固定开在文件编辑区（mainPart）：不指定分组时会落到当前活动分组，而 dsh 页面所在聊天框
		// 就是活动分组 —— 那样打开的编辑器会盖住聊天框（实测）。
		await this._editorService.openEditor({ resource, options: { pinned: true, selection, revealIfOpened: true } }, this._editorGroups.mainPart.activeGroup);
	}

	private async _reveal(resource: URI): Promise<void> {
		try {
			await this._commands.executeCommand('revealInExplorer', resource);
		} catch {
			await this._open(resource);
		}
	}
}

registerWorkbenchContribution2(DshPageCommandContribution.ID, DshPageCommandContribution, WorkbenchPhase.Eventually);
