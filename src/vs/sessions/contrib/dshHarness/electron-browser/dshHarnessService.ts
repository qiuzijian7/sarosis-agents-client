/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../base/common/color.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { FileAccess } from '../../../../base/common/network.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IIdeCapabilityEnv, IIdeSelectionRange, buildExecuteNodeRequest, executeIdeCapability, ideFailureSummary } from '../common/dshIdeCapabilities.js';
import { isPathInside } from '../common/dshPageBridgeProtocol.js';
import { DSH_MODULE_CONTAINERS, DshModuleId, IDshModulePageState, activeModulesFromPlugins, activeModulesOf, containersFromPlugins, pagesFromPlugins, resolveContainerPageState, withWorkbenchClient } from '../common/dshModuleContainers.js';
// `taskboard` 能力（看板"定位卡片"）：与原 `TasksViewPane` 点条目**同一套实现**（同一个 EditorInput
// 与同一个 focusTaskInBoard），不另开一条"看起来能跳"的路径。
import { TaskOverviewEditorInput } from '../../agentStudio/browser/taskOverviewEditorInput.js';
import { ITofAuthService } from '../../agentStudio/common/tofAuth.js';
// ★ 2026-10-21：商城清单能力（`skills` / `mcp`）——认证（商城 JWT）在 IDE 侧 ⇒ 复用它 ✓。
import { IMarketplaceService } from '../../agentStudio/common/marketplace.js';
import { WorkflowEditorInput } from '../../agentStudio/browser/workflowEditorInput.js';
// `executeNode` 能力（2026-10-20）：复用画布侧已有的 Comfy 直跑 delegate —— 真正的执行在 webview
// （`requestDirectStageRun` → `runStageByClass`），这里只负责把「节点原样」整理成它要的形状。
import { createComfyStageDelegate } from '../../agentStudio/browser/workflow/comfyStageBridge.js';
import type { WorkflowGraphNode } from '../../agentStudio/common/workflowStorage.js';
import { ITaskOrchestrationService } from '../../../common/agentStudioOrchestration.js';
// 生态用户级技能目录（SKILL.md 规范）：与 IDE 侧 skillRegistryService **共用同一份清单**
// （少一侧就会出现"IDE 看得见、Host 看不见"的不一致 ✗）。
import { ecosystemUserSkillDirPaths } from '../../../common/agentStudioSkillDirs.js';
// ★ 技能根清单的**单一真源**（顺序 / 来源 / trust 门控 / 去重都在它里面，IDE 侧注册表读同一份 ✓）
import { SKILL_OFFICIAL_USER_ROOT_SETTING_ID, SKILL_PROJECT_ROOTS_SETTING_ID, officialUserSkillRootCandidates, resolveSkillRoots } from '../../../common/agentStudioSkillRoots.js';
// worktree 列表（dsh 聊天 header 的 worktree 下拉）：宿主侧 git 事实的唯一真源。
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { IWorkflowStorageService } from '../../../common/agentStudioWorkflowStorage.js';
import { canvasContextStore } from '../../agentStudio/browser/messageEnrichment/canvasContextStore.js';
import { requestCanvasOps } from '../../agentStudio/browser/providers/tool/canvasOpsBridge.js';
// ★ 2026-10-21：`media`（生图）能力要用的 provider 注册表（`getModelProviders()`）。
import { IAgentOSService } from '../../agentStudio/common/agentOS.js';
// ★ 2026-10-21：`media`（生图 / 图生图）能力用到的 provider 类型。
import { IModelProvider } from '../../agentStudio/common/providers.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
// A 组缺口（2026-10-12）：unreal 的 bridge 设置键 + 知识库存储根解析 —— 后者**复用 IDE 同一份实现** ✓
//（`knowledgeBaseView.rootUri` 用的就是它 ✓；本文件已有从 `agentStudio/browser/**` import 的先例 ✓）。
import { AGENT_STUDIO_BROWSER_CDP_HEADLESS_SETTING, AGENT_STUDIO_BROWSER_CDP_LAUNCH_DEDICATED_SETTING, AGENT_STUDIO_BROWSER_CDP_PORT_SETTING, AGENT_STUDIO_UNREAL_BRIDGE_URL_SETTING } from '../../../common/agentStudioConstants.js';
import { resolveKbRoot } from '../../agentStudio/browser/knowledge/knowledgeStorage.js';
// ★ 库记录（2026-10-15，用户报"不该有 uid 式的根 / 只应显示当前库"）：与 KB 视图**同一对** storage 键
// —— `kbVaultState.ts` 是那对键的唯一定义处 ✓（自己再硬编码一遍字符串就会与 IDE 侧漂移 ✗）。
import { STORAGE_ACTIVE, STORAGE_VAULTS } from '../../agentStudio/browser/knowledge/kbVaultState.js';
// 页面桥的**知识库信任口径**（2026-10-15：点知识库文件不再先问"工作区之外"一次 ✓）。
import { knowledgeBaseTrustRoots } from '../common/dshKbTrust.js';
import type { IKbVault } from '../../agentStudio/browser/views/knowledgeBase/kbTypes.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
// `dashboardStats` 能力（数据面 E 组 / README 5.124）：**IDE 本地聚合**的用量与告警 —— 这是本文件里
// 第一个"读 IDE 内存聚合"的适配（其余读的都是编辑器/工作区状态 ✓）。
import { IAgentStudioDashboardService } from '../../agentStudio/browser/agentStudioDashboardService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { DSH_HARNESS_CHANNEL, DshColorScheme, DshHarnessChannelCommand, DshHarnessChannelEvent, DshHarnessSettings, DshPageSurface, DshViewSurface, IDshBootstrapArgs, IDshBundledInstallResult, IDshBundledPluginRow, IDshHostStartOptions, IDshHostStatus, IDshIdeClaimReply, IDshIdeRequest, IDshPluginActivationSnapshot, IDshPluginInfo, IDshPluginRowSetResult, IDshPluginSetResult, IDshRuntimeInfo, IDshUpdateDiscoveryResult, IDshUpdatePolicy, IDshUpgradeArgs, IDshViewBounds, IDshViewInfo, IDshWorkspaceSyncState, IDshWorkspaceSyncSummary, shouldRestartForWorkspaceChange, surfaceTakesRoute } from '../common/dshHarness.js';
// dsh 侧会话摘要（侧栏合并用；解析规则与测试见 common/dshSessionIndex.ts）
import type { IDshSessionSummary } from '../common/dshSessionIndex.js';
import { DshUpdateChannel } from '../common/dshCompat.js';
import { IBridgeBundleInfo, IBridgeInspectResult, IBridgeInstallCancelResult, IBridgeInstallResult, IBridgePluginInventory, IBridgePluginRegistries, IBridgePluginRow, IBridgeProvidersSyncArgs, IBridgeProvidersSyncResult, IBridgeSessionCancelArgs, IBridgeSessionCancelResult, IBridgeSessionRunArgs, IBridgeSessionRunResult, IBridgeSessionStartArgs, IBridgeSessionStartResult, IBridgeTofSyncResult, IBridgeWorkspace, IBridgeWorkspaceContextArgs, IBridgeWorkspaceContextResult, DSH_TOF_CREDENTIAL_REF } from '../common/dshBridgeProtocol.js';
import { DshChatViewAllocator } from '../common/dshChatViewIds.js';
import { DSH_WORKSPACE_OPTION_LIMIT, DSH_WORKSPACE_ROOT_LIMIT, DSH_WORKTREE_OPTION_LIMIT, DshPageCommand, DshPageEvent, IDshInsertReference, IDshWorkspaceOption, IDshWorktreeOption } from '../common/dshPageBridgeProtocol.js';
// 多根工作区（2026-10-16）：记录里的 `path` 可能是**工作区文件**（`.code-workspace`）
// ⇒ 必须与 IDE 侧同一份判据（`hasWorkspaceFileExtension`）把它排除在"可当 cwd 的目录"之外 ✓。
import { hasWorkspaceFileExtension } from '../../../../platform/workspace/common/workspace.js';
import { basename } from '../../../../base/common/path.js';
import { buildDshThemeTokens, IDshViewBackgrounds } from '../common/dshThemeBridge.js';
import { IDshUpgradeResult, IHostActivity, blockingSessions } from '../common/dshUpgrade.js';
import { IAgentStudioService } from '../../../common/agentStudioService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
// 推运行期工作区上下文时带上**本窗口**的 id（2026-10-17）：Host 是多窗口共享的 ⇒ 那只是诊断标签
// （"最后推的是谁"要答得出来 ✓，与 `setWindowWorkspaces` 用的是同一个窗口身份 ✓）。
import { mainWindow } from '../../../../base/browser/window.js';

/**
 * 多根工作区里最多探几个根去找 git 仓库（每根一次 `git worktree list` ⇒ 有界）。
 *
 * 口径：**多根里第一个根未必是仓库**（实测启动时要 ensure 7 个路径）⇒ 原来只看 `folders[0]`
 * 会推 0 条 ⇒ 页面那枚 worktree chip（空列表时按设计 `return null`）永远不出现 ✗（2026-10-13）。
 */
const DSH_WORKTREE_FOLDER_PROBE_LIMIT = 3;
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../../../common/sarosPaths.js';

export const IDshHarnessService = createDecorator<IDshHarnessService>('dshHarnessService');

/**
 * 有副作用的 IDE 动作等用户确认的上限：**超时按拒绝处理**（没人点头就不动，不留一个悬空的工具调用）。
 * 60s 是"人正在看这条通知、但可能在打字/接电话"的量级。
 */

/**
 * renderer 侧对主进程 dsh 通道的薄封装。只传 VsSaros 自定义的命令（启动、视图矩形、可见性），
 * 不接触 dsh 页面里的任何数据 —— 页面与 Host 之间是 dsh 原生协议，VsSaros 不解析。
 */
/**
 * dsh 会话改名的**回执**（页面 → 工作台 → 服务层）。
 *
 * ⚠ 判成败只看 `error`：**没有 `error` 才算改成了**。命令发出去 ≠ 成功
 * （桥的 invoke 没有语义返回值，上一轮"切换失败却零报错"就是这么来的 ✗）。
 */
export interface IDshSessionRenamedResult {
	readonly viewId: string;
	readonly sessionId: string;
	readonly title?: string;
	readonly error?: string;
}

export interface IDshHarnessService {
	readonly _serviceBrand: undefined;
	readonly status: IDshHostStatus;
	readonly onDidChangeStatus: Event<IDshHostStatus>;
	/** 只包含本 renderer 创建的视图的页面事件（主进程向所有窗口广播，这里按 viewId 过滤）。 */
	readonly onDidPageEvent: Event<DshPageEvent>;
	/**
	 * ★ 2026-10-19：dsh 会话改名的**回执**（页面 → 工作台 → 这里）。
	 *
	 * 只在本 renderer 的视图上发生（`onDidPageEvent` 的同款过滤）。`error` 有值 = 页面侧失败
	 * ⇒ 调用方必须看它，**不能**把"命令已发出"当成"改成功了" ✗（桥 invoke 没有语义返回值，
	 * 上一轮"切换失败却零报错"就是这么来的）。
	 */
	readonly onDidDshSessionRenamed: Event<IDshSessionRenamedResult>;

	ensureStarted(): Promise<IDshHostStatus>;
	/**
	 * 登录/登出**失败**时把原因推给所有本窗口的 dsh 视图（2026-10-21）。
	 *
	 * 为什么必须有：页面桥是**单向**的（只回 true）⇒ 失败时页面**收不到任何回执** ⇒
	 * 真实原因（浏览器被关 / 网关超时 / 账号被拒）只落在 IDE 日志里 ⇒ 页面只能干等超时兜底 ✗。
	 *
	 * ⚠ 只推**一句人话**（≤200 字符）：不含堆栈/路径/票据 ✓。
	 */
	pushAuthError(error: string): void;
	/**
	 * 同步"**IDE 主窗口是我们藏着的**"这个事实给主进程（desktop 模式的窗口守卫，2026-10-21）。
	 *
	 * @param hidden true = 我们把那个窗口藏起来了（主进程据此装守卫：它一旦 show/focus 就再藏回去 ✓）
	 * @param windowId 被守卫的窗口 id（`nativeHostService.windowId` = Electron 窗口 id ✓）
	 */
	setIdeWindowHidden(hidden: boolean, windowId: number): Promise<void>;
	/**
	 * dsh 侧会话摘要（读 projcache）—— 左侧「历史会话」用它把 dsh 会话**合并**进列表。
	 *
	 * 两套数据源：IDE 自己的 `chat-history` 索引（`chatService.listAgentSessions`）与 dsh 侧
	 * `storages/session_projcache`。dsh 引擎下聊天在 dsh 侧开会话 ⇒ 只读前者会让侧栏
	 * 对 dsh 会话"永远空白"（2026-10-19 用户截图：No sessions found）。
	 * 读不到 / Host 没起 ⇒ 返回空数组（不抛：侧栏不能因此整块失败 ✗）。
	 */
	listDshSessions(): Promise<readonly IDshSessionSummary[]>;
	/**
	 * 按 **dsh 会话 id** 改名（侧栏用）——内部把 `sessionId` 解析成"正在显示它的聊天视图"。
	 *
	 * @returns `false` = 该会话当前**没有在任何聊天页签打开**（改名只能由页面做）⇒ 调用方应如实提示，
	 *          **不要**假装成功 ✗；`true` 只代表**请求已推给页面**，真正的成败看
	 *          {@link onDidDshSessionRenamed}（页面会回执）。
	 */
	renameDshSession(sessionId: string, title: string): Promise<boolean>;
	/**
	 * 把**某个已存在的 dsh 会话**切到聊天视图上（侧栏点 dsh 条目用）。
	 *
	 * 复用既有的 `rebindSession`（宿主是会话绑定的权威）⇒ 与"页面里点历史会话"同一条路。
	 * @returns 没有可用的聊天视图 ⇒ `false`（调用方据此如实提示，不假装打开了 ✗）
	 */
	openDshSessionChat(sessionId: string): Promise<boolean>;
	restart(): Promise<IDshHostStatus>;
	stop(): Promise<void>;
	getLog(): Promise<string[]>;
	/**
	 * 路径是否落在**知识库**之内（数据根 or 某个**已登记**库根）—— 页面桥据此**免掉**"工作区外"
	 * 那道确认通知 ✓（2026-10-15，用户报"点知识库里的文件打不开 editorpane"：知识库默认就在工作区
	 * 之外 ⇒ 原来每点一行都要先点一条通知 = 用户眼里的"点了没反应" ✗；口径与信任面见 `common/dshKbTrust.ts` ✓）。
	 */
	isInsideKnowledgeBase(path: string): boolean;
	/** 当前 profile 的已装插件清单（插件中心底座；每项带 `enabled` 启停状态）。 */
	listPlugins(): Promise<IDshPluginInfo[]>;
	/**
	 * **随包**模块插件清单（`dsh-plugins/*`，含 profile 里的实装版本）。
	 *
	 * 与 `listPlugins()` 的区别：那个答"装了哪些"，这个答"**随产品带了哪些、装了没有、能不能升**"——
	 * 用户此前只能手敲 spec（`file:G:\…\dsh-plugins\vssaros-kanban`）才能装模块插件（方案 5.16 的缺口）。
	 * 纯读盘（读随包目录 + profile 清单），**不需要 Host 运行**。
	 */
	listBundledPlugins(): Promise<IDshBundledPluginRow[]>;
	/**
	 * 安装（或升级）一个随包插件（`{ name }`）。走主进程：暂存到 profile 再 `dsh plugin add`
	 * （跨盘符安全）；`changed` 为真时模块 ActivityBar 会跟着重算。
	 */
	installBundledPlugin(name: string): Promise<IDshBundledInstallResult>;
	/**
	 * 从**本地绝对目录**安装插件（「添加插件」段的本地路径分支）。
	 *
	 * 与 `installBundledPlugin` 同一条路（主进程暂存 + `dsh plugin add`）；只接受本地绝对路径，
	 * 非本地形态（注册表 / git / tarball）会**明确报错**——那些该走商城的 `installDshPlugin`。
	 */
	installLocalPlugin(spec: string): Promise<IDshBundledInstallResult>;
	/**
	 * 按 **spec**（注册表 / git / tarball）安装插件 —— 与 `installLocalPlugin` 同一条主进程通道
	 * （`dsh plugin add`，不经 Host 的 `pluginManager`：那条在全新 profile 上会 `operation-error` ✗）。
	 *
	 * `name` 必填：装完读 `<profile>/node_modules/<name>/package.json` 核对版本 ⇒ 名字由**预检结果**给
	 * （选路真源 `agentStudio/common/dshPluginTransport.ts`）。能力差：无进度 / 取消 / 构建脚本批准。
	 */
	installPluginSpec(spec: string, name: string): Promise<IDshBundledInstallResult>;
	/**
	 * 一个**模块化容器**该加载哪一页（按已激活模块现算，见 `pageRouteForActiveModules`）。
	 * 不是模块化容器（常驻容器）时返回 `undefined`。
	 *
	 * 注册时算一次就写死是错的：共容器里"谁先装"会变（先装 mcp、后装 skills），写死的路由会一直错到
	 * 容器重注册；每次问一次（只读已装插件清单，不拉进程）才总是对的。
	 */
	resolveModulePage(containerId: string): Promise<IDshModulePageState | undefined>;
	/** 清单 + HMR 状态（插件中心「DSH」页签的渲染数据）。 */
	getPluginActivation(): Promise<IDshPluginActivationSnapshot>;
	/** 设置某个插件的启停（插件中心开关）；返回更新后的快照与本次是否真的改了组合。 */
	setPluginEnabled(name: string, enabled: boolean): Promise<IDshPluginSetResult>;
	/**
	 * 组合包启停（方案 5.16 批次 3）：Host 运行时经 `pluginManager.setBundleEnabled`，
	 * 否则降级直接改 profile 的 `dsh.profile.bundles`；结果带 `via` 与 Host 的 `application`。
	 */
	setDshBundleEnabled(name: string, enabled: boolean): Promise<IDshPluginSetResult>;
	/** 行级启停（写 `cordis.patch.yml` 覆盖项）；只有 Host 运行时可做。 */
	setDshPluginRowEnabled(entryId: string, enabled: boolean): Promise<IDshPluginRowSetResult>;
	// ─── 插件商城（方案 5.16 批次 2，只读面）：数据来自 Host 的 pluginManager（经控制桥）。
	// 控制桥不可用时**抛错**（UI 据此区分"没有插件"与"Host 没起来"）。
	/** 组合包清单（官方随附 + 已安装 + 每包的行）。 */
	listDshBundles(): Promise<IBridgeBundleInfo[]>;
	/** 运行中的插件行（entryId / patchId / 阶段 / 只读原因）。 */
	listDshPluginRows(): Promise<IBridgePluginRow[]>;
	/** 安装源（配置源 + 镜像 + pnpm 自身解析到的源）。 */
	getDshPluginRegistries(): Promise<IBridgePluginRegistries>;
	/** 运行态摘要（条目数 / 启用数 / 预设数 / 管理可用性）。 */
	getDshPluginInventory(): Promise<IBridgePluginInventory>;
	// ─── 插件商城（方案 5.16 批次 4，安装面）：只有 Host 运行时可用（安装要用 profile 写锁 + pnpm）。
	/** 安装前预检一个 spec（查注册表 / 读路径清单），返回可显示的元数据或拒绝原因。 */
	inspectDshPlugin(spec: string): Promise<IBridgeInspectResult>;
	/** 安装一个组合包；`requestId` 由调用方生成（取消与 Host 侧进度都按它关联）。 */
	installDshPlugin(spec: string, requestId: string, approvedBuilds?: readonly string[]): Promise<IBridgeInstallResult>;
	/** 取消进行中的安装。 */
	cancelDshPluginInstall(requestId: string): Promise<IBridgeInstallCancelResult>;
	/** 卸载一个 profile 持有的组合包。 */
	removeDshPlugin(name: string): Promise<IBridgeInstallResult>;
	/** 插件启停变化（渲染进程据此重算模块 ActivityBar，方案 6.4）。 */
	readonly onDidChangePlugins: Event<void>;
	getRuntimeInfo(): Promise<IDshRuntimeInfo>;
	installRuntime(version: string): Promise<string>;
	setCurrentRuntime(version: string): Promise<void>;
	/** 一键准备（缺 Node 装托管 Node，缺 dsh 装 latest）并启动。 */
	bootstrap(): Promise<IDshHostStatus>;
	installNode(version?: string): Promise<{ version: string; path: string }>;
	/** 经升级闸门切换版本（未安装时先并列安装；运行中任务检查、快照、健康检查、失败回退）。 */
	upgrade(version: string, force?: boolean): Promise<IDshUpgradeResult>;
	/** 当前设置对应的升级通道策略。 */
	policy(): IDshUpdatePolicy;
	/** 最近一次的工作区同步状态（同步可读，供界面与排查使用）。 */
	readonly workspaceSync: IDshWorkspaceSyncSummary;

	/** 按通道列出候选版本与推荐。 */
	discoverUpdates(): Promise<IDshUpdateDiscoveryResult>;
	/** 上报本窗口的工作区目录（整体替换）；控制桥已连接时立即注册为 dsh 工作区。 */
	setWindowWorkspaces(windowId: number, paths: readonly string[]): Promise<void>;
	listWorkspaces(): Promise<IBridgeWorkspace[]>;
	/** 经控制桥建/接管一个 dsh 会话（`sessionId` 给定时幂等接管）；控制桥不可用时抛错。 */
	startSession(args: IBridgeSessionStartArgs): Promise<IBridgeSessionStartResult>;
	/** 后台回合（重构 1.4 `session.run`）：投 prompt、等回合跑完、回传结果；控制桥不可用时抛错。 */
	runSession(args: IBridgeSessionRunArgs): Promise<IBridgeSessionRunResult>;
	/** 取消一条会话当前的活动（重构 1.4 `session.cancel`）。 */
	cancelSession(args: IBridgeSessionCancelArgs): Promise<IBridgeSessionCancelResult>;
	getWorkspaceSync(): Promise<IDshWorkspaceSyncState>;
	getActivity(): Promise<IHostActivity | undefined>;
	/**
	 * 活动工作区变了（`DshWorkspaceReportContribution` 在监听里调）。
	 *
	 * ★ 2026-10-17：**先推运行期上下文**（桥 `workspace.context`）——推成了就**不重启 Host**
	 * （看板 / 记忆 / 图谱在 Host 侧按调用读它 ⇒ 切工作区立即生效，在跑的会话不被打断 ✓）。
	 * 只有推不动（老 Host / 老插件：`applied:false`）才退回旧路径：空闲时重启 Host，让下一次
	 * 启动覆盖层里的新值生效 ✓（见 `shouldRestartForWorkspaceChange` 的注释）。
	 */
	noteActiveWorkspace(workspaceId: string | undefined): Promise<void>;
	readonly onDidProgress: Event<string>;
	/** 工作区注册结果变化（主进程广播）。 */
	readonly onDidWorkspaceSync: Event<void>;

	/** `surface=plugin-page` 时必须给 `route`（插件自托管路由，如 `/x/<module>/`）。 */
	/**
	 * 建视图。
	 *
	 * `overrideChatOnlyUi`（2026-10-18 拼装式弹窗）：临时覆盖 `sessions.dshHarness.chatOnlyUi`。
	 * `surface='chat'` + `false` ⇒ **保留官方侧栏/品牌顶栏/右栏** —— 弹窗要复刻官方 desktop 布局时用；
	 * 主窗口聊天框仍按全局配置（默认 chat-only）✓。
	 */
	createView(viewId: string, windowId: number, surface: DshViewSurface, sessionId?: string, route?: string, pageSurface?: DshPageSurface, overrideChatOnlyUi?: boolean, isolatedPool?: boolean): Promise<void>;
	layoutView(viewId: string, bounds: IDshViewBounds): Promise<void>;
	setViewVisible(viewId: string, visible: boolean, focus?: boolean): Promise<void>;
	/**
	 * **抓一帧并让位**（隐藏原生视图 + 返回那一帧的 JPEG dataURL）。"浮层让位"时把它贴在占位上 ⇒
	 * 用户看到的是**冻结的最后一帧**而不是空白（2026-10-15：hover 活动栏图标 ⇒ 侧栏 sideview 内容消失）。
	 *
	 * ⚠ 抓帧与隐藏是**一次**调用（主进程内先抓后藏）：拆成两次会赛跑，抓到离屏空帧 ✗。
	 * 抓不到 ⇒ `undefined`（让位照样发生，调用方退回主题底色）。
	 */
	freezeView(viewId: string): Promise<string | undefined>;
	reloadView(viewId: string): Promise<void>;
	/** 重绑聊天视图到另一个 dsh 会话（方案 5.15 切 preset）；主进程校验会话 id 形态后推给页面。 */
	rebindSession(viewId: string, sessionId: string): Promise<void>;
	/** 重命名该聊天视图绑定的 dsh 会话（外层页签入口）；主进程校验后推给页面执行。 */
	renameSession(viewId: string, title: string): Promise<void>;
	disposeView(viewId: string): Promise<void>;
	resetWindow(windowId: number): Promise<void>;
	listViews(): Promise<IDshViewInfo[]>;
	/**
	 * 本窗口里**哪个聊天页签**正显示这条 dsh 会话（返回 chatId）。
	 *
	 * 与 {@link listViews} 的分工（2026-10-19 真机日志实证）：`listViews()` 反映的是**视图槽**
	 * （pane 活着、WebContentsView 建好才有），而"这条会话是不是已经打开了"要看**页签**——
	 * pane 隐藏/回收后槽就没了，页签却还在 ⇒ 只看 listViews 会把"已打开"判成"没打开"，
	 * 于是每点一次「打开会话」就多一个页签（用户报的"仍然重复显示"✗）。
	 * 这里在**每次绑定成功**（createView / rebindSession）时按 chatId 记账，纯本地、零 IPC ✓。
	 */
	findChatIdForSession(sessionId: string): string | undefined;
	/**
	 * 本窗口**所有被聊天页签绑着的 dsh 会话 id**（`findChatIdForSession` 的反查集）。
	 *
	 * 用途（2026-10-19）：新开页签时挑"可复用的空白会话"必须排除这些 —— 复用一条已经绑在
	 * 别的页签上的会话，会让两个页签显示同一条 ∨ 更是把用户正在看的会话换掉 ✗。
	 */
	boundChatSessionIds(): Set<string>;
	/**
	 * **预占**一条 dsh 会话（"我马上就绑它"）—— 见实现处的注释：
	 * 并排开两个聊天时，第二个不能抢到第一个正在占用的那条会话 ✓。
	 */
	reserveChatSession(sessionId: string): void;

	/**
	 * 聊天框承载时登记"最近聚焦的聊天视图"（方案 5.5 onInsertReference 的落点）；
	 * 聊天宿主在 pane 在场（可见且矩形非零）时调用。渲染进程本地状态，不走 IPC。
	 *
	 * ⚠ 语义（2026-10-21，多聊天并排后收紧）：**只有真正拿到焦点的聊天才能占这个位**。
	 *   此前"在场即占位"（每次 `_updateVisibility` 都调）⇒ 并排两个聊天时，
	 *   谁最后跑了一次可见性重算谁占位（ResizeObserver / 定时器 / 状态变化都会触发），
	 *   **未必是用户正在看的那个** ⇒ "Add File to Chat / 插件页打开会话"会打到错的聊天 ✗。
	 *   ⇒ 在场登记改走 {@link noteChatViewPresent}；本方法只由**焦点**路径调用。
	 */
	noteActiveChatView(viewId: string, token: object): void;
	/**
	 * 登记"这个聊天视图在场"（pane 可见且矩形非零）——只影响**视图 id 仲裁**，
	 * 不占"活动聊天"位 ✓（多聊天并排时两者必须分开，否则外部路由会错落）。
	 */
	noteChatViewPresent(viewId: string, token: object): void;
	/** 该视图不再在场时释放"活动聊天"位与在场记录（仅当都是它）。 */
	clearActiveChatView(viewId: string, token: object): void;
	/** 最近聚焦的聊天视图 id；没有则为 undefined。 */
	readonly activeChatViewId: string | undefined;
	/**
	 * 把一条页面命令**转交**给本窗口的另一个视图的宿主（渲染进程本地，不走 IPC）：以该视图的名义
	 * 触发一次 `onDidPageEvent`。用途（2026-10-16，agents 方案 A）：插件页（侧栏/编辑区）请求
	 * `openSession` ⇒ 交给**活动聊天框**的宿主切会话 —— 会话绑定的权威在聊天宿主，插件页自己做不了。
	 * 只认本窗口登记过的视图；不是 ⇒ 返回 false、什么都不发。
	 */
	dispatchPageCommand(viewId: string, command: Exclude<DshPageCommand, { method: 'ping' }>): boolean;
	/**
	 * 认领聊天的视图 id（方案第 7 章多开仲裁）：base = `dsh-chat-w<win>-<chatId>`；
	 * 被别的在场 pane 占用时分配后缀 id。每次进入在场状态时都应重认（冲突自愈）。
	 */
	claimChatViewId(base: string, token: object): string;
	/** 释放该 pane 认领的全部视图（pane/输入销毁时；各视图随之销毁）。 */
	releaseChatViews(token: object): void;
	/** 把文件引用插入指定聊天视图的草稿（方案 5.5）。 */
	insertReference(viewId: string, reference: IDshInsertReference): Promise<void>;
	/** 把 VsSaros 已配置的模型 provider 同步到 dsh（桥 `providers.sync`；控制桥不可用时报错）。 */
	syncProviders(args: IBridgeProvidersSyncArgs): Promise<IBridgeProvidersSyncResult>;
	/**
	 * 把 **IDE 侧的企业身份（TOF/OA 票据）**同步到 dsh（桥 `tof.sync`）。
	 *
	 * 2026-10-21（用户："不要用 dsh 官方 DeepSeek 路由，需求是在两侧用 TOF/OA 企业身份（工号 + 票据）实现登录"）：
	 * dsh 侧不另起账号体系，而是持有**同一份**企业身份 ⇒ 一次浏览器登录，两边都能用 ✓。
	 */
	syncTofIdentity(): Promise<IBridgeTofSyncResult>;
}

export class DshHarnessService extends Disposable implements IDshHarnessService {
	declare readonly _serviceBrand: undefined;

	private readonly _channel: IChannel;
	/** 上次观测到的活动工作区 id（`noteActiveWorkspace` 用它判断"这次是不是真的换了"）。 */
	private _observedWorkspaceId: string | undefined;
	private _status: IDshHostStatus = { state: 'stopped', bridge: 'none' };
	/**
	 * 最近一次**真正交给 Host** 的技能根（由 `_skillDirs()` 记）。
	 *
	 * 为什么记：工作区信任状态变化会改变技能根集合（项目级根只在受信任时进，见 `skillRoots.ts`），
	 * 而 `skillDirs` 是**启动快照**（`sameStartOptions` 的判据之一，见 `common/dshHarness.ts`）⇒
	 * 信任变了但 Host 不重启时技能集合**一直不更新** ✗（用户刚点了"信任"，项目技能却还是不出现）。
	 * 有这份快照就能**只在真的变了**时重启，而不是"信任一动就无条件重启"（白重启几秒 ✗）。
	 */
	private _lastSkillDirs?: readonly string[];
	/** 同上，**内置**那一条（它走 `bundledSkillDir` 单独交付 ⇒ 也要参与"变了才重启"的比对 ✓）。 */
	private _lastBundledSkillDir?: string;
	private readonly _onDidChangeStatus = this._register(new Emitter<IDshHostStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	private readonly _onDidPageEvent = this._register(new Emitter<DshPageEvent>());
	readonly onDidPageEvent = this._onDidPageEvent.event;
	/** ★ 改名回执（从 `onDidPageEvent` 里挑 `kind:'renamed'` 转发，见 `_onPageEvent`）。 */
	private readonly _onDidDshSessionRenamed = this._register(new Emitter<IDshSessionRenamedResult>());
	readonly onDidDshSessionRenamed = this._onDidDshSessionRenamed.event;
	private readonly _ownViews = new Set<string>();
	/** ★ 2026-10-19（首启成本拆分）：首次 `ensureStarted()` 的时刻 / 是否已打过"Host ready"日志。 */
	private _startupT0: number | undefined;
	private _startupLogged = false;
	private _workspaceSync: IDshWorkspaceSyncSummary = { reported: 0, registered: 0, rejected: 0 };
	private readonly _onDidProgress = this._register(new Emitter<string>());
	readonly onDidProgress = this._onDidProgress.event;
	private readonly _onDidWorkspaceSync = this._register(new Emitter<void>());
	readonly onDidWorkspaceSync = this._onDidWorkspaceSync.event;
	private readonly _onDidChangePlugins = this._register(new Emitter<void>());
	readonly onDidChangePlugins = this._onDidChangePlugins.event;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IThemeService private readonly _themeService: IThemeService,
		@IAgentStudioService private readonly _studio: IAgentStudioService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		// 技能根的**注入面门控**：工作区目录（`<工作区>/.dsh/skills` 等）会随 git clone 进来 ⇒ 只有
		// 工作区**受信任**时才把它们放进技能根（见 `agentStudio/common/skillRoots.ts`）。
		@IWorkspaceTrustManagementService private readonly _workspaceTrustService: IWorkspaceTrustManagementService,
		// worktree 列表（dsh 聊天 header 的下拉）：数据源是宿主侧 git 事实，只能由宿主推给页面（见 PushWorktrees）。
		@IWorktreeService private readonly _worktreeService: IWorktreeService,
		@IFileService private readonly _fileService: IFileService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		// ★ 库记录（2026-10-15）：读 IDE storage 里那对键（`agentStudio.kb.vaults` / `.active` ✓）——
		//   真源 KB 视图写的就是它们 ✓（`kbVaultState.ts` 的常量 ✓），名字/图标只存在这里，
		//   盘上没有 ✗（真机核过：库目录里只有索引缓存 ✓）⇒ 不注入的话页面只能拿 uid 当库名 ✗。
		@IStorageService private readonly _storageService: IStorageService,
		// `taskboard` 能力要用的两个东西：看板 EditorInput（`TaskOverviewEditorInput`）+ 高亮入参
		// （`focusTaskInBoard(title)`）——与原 `TasksViewPane` 用的是同两个。
		@ITaskOrchestrationService private readonly _taskOrchestrationService: ITaskOrchestrationService,
		// `workflow` 能力要用的：按 id 取到工作流（`IWorkflowStorageService.listWorkflows`）
		@IWorkflowStorageService private readonly _workflowStorage: IWorkflowStorageService,
		// `dashboardStats` 能力要用的：IDE 的用量/告警聚合（`getData()` / `getDateRange()`）——
		// 它**不在**工作区里、也不在盘上，只能由 IDE 内存给出（这正是反向通道存在的理由 ✓）。
		@IAgentStudioDashboardService private readonly _dashboardService: IAgentStudioDashboardService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
		// ★ 2026-10-21：`media`（生图）能力要用的：模型 provider 注册表
		// （`getModelProviders()` ⇒ 里面有 `generateImage` 的那些就是能出图的源）。
		// 凭据、审批、模型清单都在 IDE 进程 ⇒ Host 侧只负责把请求送过来、把图接回去。
		@IAgentOSService private readonly _agentOSService: IAgentOSService,
		@ITofAuthService private readonly _tofAuth: ITofAuthService,
		// 商城清单（`skills` / `mcp` 两条 IDE 能力，2026-10-21）：认证（商城 JWT）在 IDE 侧 ⇒ 这条
		//   能力天然属于 IDE 侧实现（dsh 侧只发意图）✓。
		@IMarketplaceService private readonly _marketplace: IMarketplaceService,
	) {
		super();
		this._channel = mainProcessService.getChannel(DSH_HARNESS_CHANNEL);
		// 主题同步（方案 5.13.2 P2）：VsSaros 主题变化时把映射后的 dsh token 覆盖层推给所有本窗口的视图。
		this._register(this._themeService.onDidColorThemeChange(() => this._pushThemeToAll()));
		// worktree 列表：git 侧变化（新建 / 删除 / prune / 切分支）时重推，页面下拉跟着刷新。
		this._register(this._worktreeService.onDidChangeWorktrees(() => this._pushWorktreesToAll()));
		// IDE 工作区记录（多根工作区，2026-10-16）：**注册表变化**（新建 / 改记录 / 加关联根）与
		// **活动工作区切换**都要重推 —— 页面下拉的"一个工作区 + 各根"分组据此刷新 ✓
		// （两个事件都要接：切活动工作区不必然改记录，改记录也不必然切活动 ✓）。
		this._register(this._studio.onDidChangeWorkspace(() => this._pushWorkspacesToAll()));
		this._register(this._studio.onDidChangeActiveWorkspace(() => this._pushWorkspacesToAll()));
		// IDE 登录态（2026-10-21）：登录/登出变化 ⇒ 推给所有 dsh 视图 ⇒ 窗口里的那行账号与 IDE 同步 ✓
		// ★ 同一次变化还要把**票据**同步给 dsh 侧（桥 `tof.sync`）⇒ 两侧持有同一份企业身份
		//   （用户："不要用 dsh 官方 DeepSeek 路由，需求是在两侧用 TOF/OA 企业身份实现登录"）。
		//   顺序：先推页面（快），再推 dsh（慢、要过桥）⇒ 两者互不阻塞 ✓。
		this._register(this._tofAuth.onDidChangeUser(() => {
			this.pushAuthToAll();
			void this._syncTofIdentityQuietly('登录态变化');
		}));
		// 工作区信任变化 ⇒ 技能根集合可能变（项目级根只在受信任时进）⇒ 变了才重启 Host（见 `_lastSkillDirs`）
		this._register(this._workspaceTrustService.onDidChangeTrust(() => void this._onTrustChanged()));
		this._register(this._channel.listen<IDshHostStatus>(DshHarnessChannelEvent.OnDidChangeStatus)(s => this._update(s)));
		this._register(this._channel.listen<DshPageEvent>(DshHarnessChannelEvent.OnDidPageEvent)(e => {
			if (this._ownViews.has(e.viewId)) {
				this._onDidPageEvent.fire(e);
				// ★ 改名回执单独转发一份：侧栏只需要这一件事实，不必自己解析 `DshPageEvent` 的联合类型。
				if (e.kind === 'renamed') {
					this._onDidDshSessionRenamed.fire({
						viewId: e.viewId,
						sessionId: e.sessionId,
						...(e.title !== undefined ? { title: e.title } : {}),
						...(e.error !== undefined ? { error: e.error } : {}),
					});
				}
			}
		}));
		this._register(this._channel.listen<string>(DshHarnessChannelEvent.OnDidProgress)(p => this._onDidProgress.fire(p)));
		this._register(this._channel.listen<void>(DshHarnessChannelEvent.OnDidChangePlugins)(() => this._onDidChangePlugins.fire()));
		this._register(this._channel.listen<void>(DshHarnessChannelEvent.OnDidWorkspaceSync)(() => {
			this._onDidWorkspaceSync.fire();
			void this.getWorkspaceSync().catch(() => undefined);
		}));
		// IDE 能力请求（反向通道 `ide.request`）：**授权已在主进程做完**，这里是执行端——
		// 读 IDE 状态、整形、经 `ResolveIdeRequest` 交回。没监听者时主进程会超时并明确报错，所以这一行
		// 是"能力真的能用"与"能力只是被授权"的分界。
		this._register(this._channel.listen<IDshIdeRequest>(DshHarnessChannelEvent.OnIdeRequest)(request => void this._handleIdeRequest(request)));
		void this.getWorkspaceSync().catch(() => undefined);
		void this._channel.call<IDshHostStatus>(DshHarnessChannelCommand.GetStatus).then(s => this._update(s), () => undefined);
	}

	/**
	 * `ide.request` 的**执行端**：算完经 `ResolveIdeRequest` 交回主进程。
	 * 回执本身失败（主进程已超时/通道不可用）只记日志——那时结果已无人接收，再抛只会变成噪声。
	 */
	private async _handleIdeRequest(request: IDshIdeRequest): Promise<void> {
		// 多窗口下这一路是**广播**：先向主进程认领，只让一个窗口真正执行——
		// 否则 `browser.click` 会点 N 下、`canvas.apply_ops` 会弹 N 个确认框（只有第一个回执被采纳，
		// 副作用却已经发生 N 次）。认领不到就直接返回，**不回执**（回执由赢家负责）。
		if (!await this._claimIdeRequest(request.id)) {
			return;
		}
		let result: unknown;
		let error: string | undefined;
		try {
			result = await executeIdeCapability(request, this._ideEnv());
			// 回执"没抛异常、但业务上失败"（目前只有 unreal 的 `ok:false`——它把失败做成**文本**）⇒ 补一条留痕。
			// 少了这句，"模型连不上编辑器/调用被拒"在日志里完全不可见：unreal 走不到下面的 catch。
			const failure = ideFailureSummary(result);
			if (failure) {
				this._logService.warn(`[dshHarness] IDE 能力 ${request.capability} ${failure}`);
			}
		} catch (e) {
			error = String((e as Error)?.message ?? e);
			this._logService.warn(`[dshHarness] IDE 能力 ${request.capability} 执行失败：${error}`);
		}
		try {
			await this._channel.call(DshHarnessChannelCommand.ResolveIdeRequest, error === undefined ? { id: request.id, result } : { id: request.id, error });
		} catch (e) {
			this._logService.info(`[dshHarness] IDE 能力 ${request.capability} 的回执被丢弃：${String((e as Error)?.message ?? e)}`);
		}
	}

	/**
	 * 认领一次 IDE 能力请求（语义见 `DshHarnessChannelCommand.ClaimIdeRequest`）。
	 *
	 * `false` = 已被别的窗口认领 / 该请求已超时 ⇒ 本窗口**不执行也不回执**。
	 * 认领调用**本身**出错（通道异常、与主进程版本不匹配）⇒ 按单窗口放行：
	 * 多窗口保护不该成为"能力整个不可用"的原因（真出问题时 `info` 日志里有痕迹）。
	 */
	private async _claimIdeRequest(id: number): Promise<boolean> {
		try {
			const reply = await this._channel.call<IDshIdeClaimReply>(DshHarnessChannelCommand.ClaimIdeRequest, { id });
			return reply?.claimed === true;
		} catch (e) {
			this._logService.info(`[dshHarness] IDE 请求认领失败，按单窗口处理（继续执行）：${String((e as Error)?.message ?? e)}`);
			return true;
		}
	}

	/** 把工作台服务适配成能力执行所需的**只读**面（逻辑本身在 common 里，这里只做服务接缝）。 */
	/**
	 * 选「能出图的 provider + 它的图像模型」（`media` 能力的 generateImage / editImage 共用）。
	 *
	 * 模型来源优先级：**调用参数**（providerId / modelId）→ 第一个能生图的 provider 的
	 * 第一个 `supportsImageGen` 模型 ⇒ 与 IDE 侧既有的「图片生成模型」选择器同口径 ✓。
	 */
	private async _pickImageTarget(modelId?: string, providerId?: string): Promise<{
		target: IModelProvider;
		picked: { id: string; supportsImageGen?: boolean };
	}> {
		const providers = this._agentOSService.getModelProviders()
			.filter(provider => typeof provider.generateImage === 'function');
		if (providers.length === 0) {
			throw new Error('IDE 侧没有可用的图像 provider（没有实现 generateImage 的模型源）');
		}
		const target = providerId
			? providers.find(provider => provider.id === providerId)
			: providers[0];
		if (!target) {
			throw new Error(`找不到图像 provider：${providerId}（可用的：${providers.map(p => p.id).join(', ')}）`);
		}
		const models = await target.listModels();
		const imageModels = models.filter(model => model.supportsImageGen);
		const picked = modelId
			? (models.find(model => model.id === modelId) ?? imageModels.find(model => model.id === modelId))
			: (imageModels[0] ?? models[0]);
		if (!picked) {
			throw new Error(`${target.name} 没有可用模型${modelId ? `（找不到 ${modelId}）` : ''}`);
		}
		return { target, picked };
	}
	private _ideEnv(): IIdeCapabilityEnv {
		return {
			activeResource: () => this._editorService.activeEditor?.resource,
			// 商城清单（2026-10-21）：`skills` / `mcp` 两条能力用。
			// ⚠ 先 `ensureLoggedIn()`：未登录时商城接口会 401，而 401 的文案没法指导用户 ⇒ 换成
			//   "未登录商城，请先在 VsSaros 中完成 TOF 登录"（`marketplaceService` 自己那句）✓。
			marketList: async (kind, opts) => {
				await this._marketplace.ensureLoggedIn();
				const res = await this._marketplace.listPackages({
					kind,
					...(opts.q ? { q: opts.q } : {}),
					pageSize: opts.limit,
				});
				return {
					total: res.total,
					items: res.items.map(pkg => ({
						id: pkg.id,
						slug: pkg.slug,
						name: pkg.name,
						version: pkg.latestVersion ?? '',
						description: pkg.description ?? '',
						author: pkg.authorName ?? '',
						category: pkg.category ?? '',
					})),
				};
			},
			// 不传 filter = 全工作区（`scope: 'workspace'` 用）
			readMarkers: resource => this._markerService.read(resource ? { resource } : undefined),
			activeSelection: () => {
				// 与 accessibilitySignals 的既有写法一致：diff 编辑器取原始侧，其余只认 code editor
				const control = this._editorService.activeTextEditorControl;
				const editor = isDiffEditor(control) ? control.getOriginalEditor() : isCodeEditor(control) ? control : undefined;
				const model = editor?.getModel();
				const selection = editor?.getSelection();
				if (!model || !selection) {
					return undefined;
				}
				return {
					resource: model.uri,
					text: model.getValueInRange(selection),
					startLine: selection.startLineNumber,
					startColumn: selection.startColumn,
					endLine: selection.endLineNumber,
					endColumn: selection.endColumn,
				};
			},
			// `dashboardStats` 能力的适配（README 5.124）：**投影 + 截断**在这里做 ✓ ——
		// `IDashboardData` 整包（sessions / skills / budgets / tokenByModel / dailyBuckets…）**不进通道** ✗，
		// 派发器只负责整形 ✓（分工见 `IIdeDashboardSummary` 的注释 ✓）。
		dashboardSummary: () => {
			let data;
			try {
				data = this._dashboardService.getData();
			} catch (e) {
				// 服务没起来 / 还没 init：**如实返回 undefined** ✓，让能力回一句"还没有数据" ✓（不是错误 ✓）
				this._logService.info(`[dshHarness] dashboardStats：取 IDE 聚合失败，按"暂无数据"处理：${String((e as Error)?.message ?? e)}`);
				return undefined;
			}
			if (!data) {
				return undefined;
			}
			const sessions = data.sessions ?? [];
			const alerts = data.alerts ?? [];
			return {
				range: this._dashboardService.getDateRange(),
				sessionCount: sessions.length,
				// "活跃"就按 IDE 自己的状态口径数（`running` ✓）—— 两次归一不重写第三份口径 ✓
				activeSessions: sessions.filter(s => s?.status === 'running').length,
				alertCount: alerts.length,
				alertTop: alerts.slice(0, 3).map(a => `${a?.type ?? 'info'}：${a?.title ?? ''}`),
				kpis: (data.kpis ?? []).slice(0, 6).map(kpi => ({
					label: String(kpi?.label ?? ''),
					value: String(kpi?.value ?? ''),
					...(kpi?.unit ? { unit: String(kpi.unit) } : {}),
					...(kpi?.detail ? { detail: String(kpi.detail) } : {}),
				})),
				lastUpdated: data.lastUpdated ?? 0,
			};
		},
		resolvePath: path => {
				// 绝对路径直接当文件；相对路径按**第一个工作区文件夹**解析（模型更常给相对路径）
				if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/')) {
					return URI.file(path);
				}
				const folder = this._workspaceContextService.getWorkspace().folders[0]?.uri;
				return folder ? URI.joinPath(folder, ...path.split(/[\\/]/).filter(Boolean)) : undefined;
			},
			exists: resource => this._fileService.exists(resource),
			isInsideWorkspace: resource => {
				// 与页面桥同一套判断（工作区根 + 大小写按平台）
				const roots = this._workspaceContextService.getWorkspace().folders
					.map(folder => folder.uri.scheme === 'file' ? folder.uri.fsPath : '')
					.filter(Boolean);
				return resource.scheme === 'file' && isPathInside(resource.fsPath, roots, isWindows || isMacintosh);
			},
			// 看板定位卡片：与原 `TasksViewPane.setVisible` / `_openTaskInOverview`（`views/tasksView.ts:236-257`）
			// **逐条同形** —— 同一个 `TaskOverviewEditorInput.getOrCreate()`、同样开在文件编辑区、同样用
			// `focusTaskInBoard(title)` 高亮；分组这里跟随本文件既有的 `mainPart.activeGroup` 口径（与
			// 上面 `openResource` 一致），不为了"更像"而另引一个分组排序常量。
			// **不改数据**：纯展示，属白名单里的展示类能力。
			focusTaskboard: async title => {
				const input = TaskOverviewEditorInput.getOrCreate();
				await this._editorService.openEditor(input, { pinned: true }, this._editorGroupsService.mainPart.activeGroup);
				this._taskOrchestrationService.focusTaskInBoard(title);
			},
			// 打开工作流画布：照 `views/workflowView.ts:453-466` 的 `_openWorkflow` —— 已开则 reveal
			// （并把新造的那个 input 释放掉，避免 disposable 泄漏），否则新开。
			// **不**做那边的后半段（`_selectWorkflowAgentInChat` 切聊天区选 agent）：那是 UI 副作用，
			// 能力层只负责"把画布打开"，别顺手改用户的聊天区状态。
			openWorkflow: async id => {
				const workflows = await this._workflowStorage.listWorkflows();
				const found = workflows.find(workflow => workflow.id === id);
				if (!found) {
					throw new Error(`没有这个工作流：${id}（id 用 workflow_list 拿；页面上的条目也带着它）`);
				}
				const input = new WorkflowEditorInput(found);
				const existing = this._editorService.findEditors(input);
				if (existing.length > 0) {
					await this._editorService.openEditor(existing[0].editor, { revealIfVisible: true }, existing[0].groupId);
					input.dispose();
				} else {
					await this._editorService.openEditor(input, { pinned: true });
				}
				return { id: found.id, name: String(found.name ?? '') };
			},
			// 执行工作流里的**单个节点**（`workflow` 能力的 `op:'executeNode'`，2026-10-20）。
			// 复用画布侧**已有的直跑链**，不新造执行器：
			//   delegate.execute → requestDirectStageRun → webview `runStageByClass`
			// （ComfyUI 的 HTTP 客户端在 webview 里 —— renderer 的 fetch 被 CORS 拦 ⇒ 扩展宿主不可能直连）。
			// ⚠ 三条边界都写在 `IIdeCapabilityEnv.executeWorkflowNode` 的注释里（webview 必须在场、
			//   只支持 stage 型节点、长任务走慢档预算）；这里不重复判定，免得两处漂移。
			executeWorkflowNode: async ({ workflowId, executionId, nodeId, nodeType, data }) => {
				const delegate = createComfyStageDelegate({ info: message => this._logService.info(message) });
				const built = buildExecuteNodeRequest({ nodeId, nodeType, data });
				const result = await delegate.execute(
					built.node as unknown as WorkflowGraphNode,
					{ values: built.values, defaults: built.defaults, ...(workflowId ? { workflowId } : {}), upstreams: [] },
					{ executionId: executionId ?? `dsh-${Date.now().toString(36)}`, onProgress: () => undefined },
				);
				// 口径与 `_executeComfyNode` 一致（`summary ?? JSON.stringify(outputs)`）——
				// Host 侧只认 `reply.output` 是字符串（`engineCore` 的节点 output）。
				return {
					output: result.summary ?? JSON.stringify(result.outputs ?? {}),
					...(result.outputs ? { outputs: result.outputs } : {}),
				};
			},
			openResource: async (resource, options) => {
				// 固定开在**文件编辑区**（`mainPart.activeGroup`）：不指定分组会落到活动分组，而聊天框就是
				// 活动分组 ⇒ 打开的编辑器会盖住聊天框（这条修复来自页面桥的实测，见方案 7.x 的"顺带修掉的真缺陷"）。
				// **不抢焦点**用 `inactive`：模型发起 ≠ 用户点击文件链接。
				const selection: IIdeSelectionRange | undefined = options.selection;
				await this._editorService.openEditor({
					resource,
					options: { pinned: true, revealIfOpened: true, ...(selection ? { selection } : {}), ...(options.focus ? {} : { inactive: true }) },
				}, this._editorGroupsService.mainPart.activeGroup);
			},
			revealInExplorer: async resource => {
				try {
					await this._commandService.executeCommand('revealInExplorer', resource);
				} catch {
					// 与页面桥一致：定位做不到（没有资源管理器等）就退回打开
					await this._editorService.openEditor({ resource, options: { pinned: true, inactive: true } }, this._editorGroupsService.mainPart.activeGroup);
				}
			},
			openDiff: async (left, right, options) => {
				await this._editorService.openEditor({
					original: { resource: left },
					modified: { resource: right },
					...(options.title ? { label: options.title } : {}),
					options: { ...(options.focus ? {} : { inactive: true }) },
				}, this._editorGroupsService.mainPart.activeGroup);
			},
			// ⚠ 这里**没有** `runBrowserOp`：IDE 侧那套 CDP 直连已按产品口径整体删除（3b，README 4.78），
			//   浏览器族只在 Host 的 `dsh-plugins/vssaros-browser` 里跑。
			// 有副作用的动作要**用户在场逐次确认**：弹一条带两个按钮的通知，谁先发生算谁
			//（点"允许" / 点"拒绝" / 手动关掉通知 / 超时 ⇒ 后三者都算拒绝）。默认拒绝，不留悬空。
			// **聊天内 ask**（README 4.76 的决定）：确认交给 Host 的审批服务 ⇒ 卡片由
			// `dsh-client-ui-approval` 渲染，与 dsh 侧能力（browser 族等）用的是**同一张**卡。
			// ⚠ **fail-closed**（README 4.84）：桥/Host 不可用、调用失败，一律算"未允许" —— 不退回通知，
			// 也不再由渲染侧自弹（那会让确认形态又分裂成两种）。
			requestActionConsent: async ({ title, detail }) => {
				// 确认窗口（60s）：超时＝未允许。这个名字与数值**被 `dshIdeToolContract.test.ts` 直接读去**
				// 校验"渲染侧慢档预算 ≥ 确认窗口"（那是"用户还没来得及点就被超时"那类事故的守卫）⇒ 改名要同步改它。
				const IDE_CONSENT_TIMEOUT_MS = 60_000;
				try {
					const reply = await this._channel.call<{ allowed?: boolean }>(
						DshHarnessChannelCommand.RequestActionConsent, { title, detail, windowMs: IDE_CONSENT_TIMEOUT_MS },
					);
					return reply?.allowed === true;
				} catch {
					return false;
				}
			},
			// 工作流画布：读的是既有 `canvasContextStore` 里"最近一次快照"（与 `canvas_get_state` /
			// `canvas_get_task_status` 两个工具**同一个数据源**）。没有/过期时返回 undefined ⇒ 能力层
			// 如实回一个 available:false（那是正常状态，不是错误）。
			readCanvas: workflowId => canvasContextStore.get(workflowId),
			// 改画布：复用既有的 `requestCanvasOps`（原子执行、失败整批回滚；它自己会跨 host↔webview 往返）。
			// **只会在用户点过"允许"之后**被调用（闸门在 common）。
			applyCanvasOps: ops => requestCanvasOps([...ops] as Parameters<typeof requestCanvasOps>[0]),
			// 思维导图（`.canvas`）就是磁盘上的 JSON，读法与 `CanvasEditorResolverContribution` 完全一致
			// （那边也是 `fileService.readFile` + `JSON.parse`）——所以这里不需要新的 webview 通道。
			readTextFile: async resource => {
				try {
					return (await this._fileService.readFile(resource)).value.toString();
				} catch {
					return undefined;
				}
			},
			// 字节数：**读之前**问一句（`.canvas` 要整个进内存 + JSON.parse，大文件应当先被拒）。
			// 拿不到（不存在 / 无权限）就给 `undefined` —— 能力层会跳过预检，不会因此失败。
			statFileSize: async resource => {
				try {
					return (await this._fileService.stat(resource)).size;
				} catch {
					return undefined;
				}
			},
			// ★ 2026-10-21：生图（`media` 能力）。
			// 模型来源优先级：**调用参数**（providerId / modelId）→ 第一个能生图的 provider 的
			// 第一个 `supportsImageGen` 模型 ⇒ 与 IDE 侧既有的"图片生成模型"选择器同口径
			// （`agentSettingsEditorPane` 的图片模型下拉也是按 `supportsImageGen` 过滤的 ✓）。
			// ★ 2026-10-21：按参考图改图（画布「照我画的改」走这条）。
			//   参考图是 data URL ⇒ provider 走 img2img（multipart /images/edits）。
			//   ⚠ provider 的 edits 端点不可用时会**降级为文生图** ⇒ degraded 必须透出（不静默）。
			editImage: async ({ prompt, image, modelId, providerId, width, height, numImages, quality }) => {
				const { target, picked } = await this._pickImageTarget(modelId, providerId);
				this._logService.info(`[dshHarness] media.editImage → provider=${target.id} model=${picked.id}`);
				const result = await target.generateImage!({
					modelId: picked.id,
					prompt,
					imageInput: image,
					...(typeof width === 'number' ? { width } : {}),
					...(typeof height === 'number' ? { height } : {}),
					...(typeof numImages === 'number' ? { numImages } : {}),
					// 三批(9)：质量档**原样透传**（各家认的档位不同 ⇒ 不在这儿改写）。
					...(quality ? { quality } : {}),
				});
				return {
					images: result?.images ?? [],
					degraded: result?.degraded === true,
					degradedReason: result?.degradedReason,
				};
			},
			generateImage: async ({ prompt, modelId, providerId, width, height, numImages, quality }) => {
				const { target, picked } = await this._pickImageTarget(modelId, providerId);
				this._logService.info(`[dshHarness] media.generateImage → provider=${target.id} model=${picked.id}`);
				const result = await target.generateImage!({
					modelId: picked.id,
					prompt,
					...(typeof width === 'number' ? { width } : {}),
					...(typeof height === 'number' ? { height } : {}),
					...(typeof numImages === 'number' ? { numImages } : {}),
					// 三批(9)：质量档**原样透传**（各家认的档位不同 ⇒ 不在这儿改写）。
					...(quality ? { quality } : {}),
				});
				return { images: result?.images ?? [] };
			},
			// 三批(9)：**图像能力表**（谁能生图 + 各家支持哪些档位）。
			//   真源 = 各 provider 自己的 imageCapabilities()（模型清单取自它自己的 listModels ⇒
			//   不在别处再抄一份，抄了必漂）。某个 provider 读表失败 ⇒ 跳过它并记一行日志
			//   （不因为一个 provider 坏就让整张表查不出来）。
			imageCapabilities: async () => {
				const providers = this._agentOSService.getModelProviders()
					.filter(provider => typeof provider.generateImage === 'function');
				const out: Array<{
					id: string; name?: string;
					models: Array<{ id: string; name?: string }>;
					ratios?: readonly string[]; qualities?: readonly string[]; sizes?: readonly string[];
				}> = [];
				for (const provider of providers) {
					if (typeof provider.imageCapabilities !== 'function') { continue; }
					try {
						const capabilities = await provider.imageCapabilities();
						if (!capabilities) { continue; }
						const capabilityModels = capabilities.models;
						if (!capabilityModels) { continue; }
						if (capabilityModels.length === 0) { continue; }
						out.push({
							id: provider.id,
							name: provider.name,
							models: capabilityModels.map(model => ({ id: model.id, ...(model.name ? { name: model.name } : {}) })),
							...(capabilities.ratios ? { ratios: capabilities.ratios } : {}),
							...(capabilities.qualities ? { qualities: capabilities.qualities } : {}),
							...(capabilities.sizes ? { sizes: capabilities.sizes } : {}),
						});
					} catch (e) {
						this._logService.info(`[dshHarness] media.imageCapabilities：${provider.id} 读能力表失败（跳过它）：${String((e as Error)?.message ?? e)}`);
					}
				}
				return { providers: out };
			},
		};
	}

	get status(): IDshHostStatus {
		return this._status;
	}

	private _update(status: IDshHostStatus): void {
		const wasBridge = this._status.bridge;
		this._status = status;
		this._onDidChangeStatus.fire(status);
		// ★ 桥**刚连上**时补一次企业身份同步（2026-10-21）：登录可能发生在 Host 起来之前
		//   ⇒ 当时同步会失败（控制桥不可用）⇒ 桥可用后必须补上，否则 dsh 侧永远没有这份身份 ✗。
		//   判据用"桥从不可用变成可用"（connected）⇒ 不会每次状态抖动都打一次桥 ✓。
		if (wasBridge !== 'connected' && status.bridge === 'connected') {
			void this._syncTofIdentityQuietly('控制桥就绪');
		}
	}

	/**
	 * 图谱**相关根**（主根 + `relatedFolders`）——与 contribution 的 `_collect()` 同源 ✓。
	 * 代码图谱插件按它们做**跨根只读查询**（方案口径：*"dsh-codebase 按会话 cwd 与 relatedFolders
	 * 定位 `{root}/.codebase-memory`"*）。
	 *
	 * 为什么不塞进 `_startOptions()` 里直接取：那个方法是**同步**的 ✗，而这些信息要
	 * `await studio.getWorkspace(id)`（异步）⇒ 由**真正启动 Host 的两条路径**（`ensureStarted` /
	 * `restart`）取新鲜的传进去 ✓；其余把 options 当**载荷**用的路径（装运行时 / 升级 / 查更新）
	 * 沿用上一次的值（快照语义 ✓，下一次启动/重启自会带上新值 ✓）。
	 */
	private async _relatedRoots(workspaceId?: string): Promise<readonly string[] | undefined> {
		const id = workspaceId ?? this._studio.getActiveWorkspaceId();
		if (!id) {
			return undefined;
		}
		const ws = await this._studio.getWorkspace(id).catch(() => undefined);
		if (!ws) {
			return undefined;
		}
		// 类型谓词是必要的：`ws.path` 可能 undefined，普通 filter 不会把数组窄化成 `string[]`（tsgo 会报 ✓）
		const roots = [ws.path, ...ws.relatedFolders.map(f => f.path)]
			.filter((p): p is string => typeof p === 'string' && p.length > 0);
		return roots.length ? [...new Set(roots)] : undefined;
	}

	/**
	 * `browser` 插件的三个旋钮（**逐键判断"用户是否显式改过"**）。
	 *
	 * 为什么必须逐键判断（而不是把 `getValue` 的当前值都发过去）✗：插件的默认值与 IDE 的默认值同值，
	 * 但**默认值会各自演进** —— 一旦把"当前值"无差别注入，插件侧改默认就再也惠及不到用户（Host 侧被
	 * 覆盖层的显式值钉死）✓。所以只看 `inspect().userValue`（用户真的在设置里写过）✓。
	 *
	 * 为什么非注入不可：Host 是独立进程、读不到 IDE 设置 ⇒ 这三个键此前改了**不生效** ✗。
	 * 最要命的是 `launchDedicated`：关掉「自动拉起调试实例」也照样拉起一个**空 profile** 的专属实例
	 * ⇒ "在你自己那个 Chrome（带登录态）里干活"这条路被静默绕过（2026-10-14 用户报障）。
	 */
	private _browserOverlayConfig(): IDshHostStartOptions['browser'] {
		const userValue = <T>(key: string): T | undefined => this._configurationService.inspect<T>(key)?.userValue;
		const port = userValue<number>(AGENT_STUDIO_BROWSER_CDP_PORT_SETTING);
		const launchDedicated = userValue<boolean>(AGENT_STUDIO_BROWSER_CDP_LAUNCH_DEDICATED_SETTING);
		const headless = userValue<boolean>(AGENT_STUDIO_BROWSER_CDP_HEADLESS_SETTING);
		const out: { port?: number; launchDedicated?: boolean; headless?: boolean } = {
			...(typeof port === 'number' && Number.isInteger(port) && port > 0 ? { port } : {}),
			...(typeof launchDedicated === 'boolean' ? { launchDedicated } : {}),
			...(typeof headless === 'boolean' ? { headless } : {}),
		};
		return Object.keys(out).length > 0 ? out : undefined;
	}

	/**
	 * 启动用的工作区 id：内存游标为空时按**启动恢复同一套解析**兜底。
	 *
	 * 为什么需要（2026-10-15 现场）：`_activeWorkspaceId` 由 `workspaceFolderSync` 的启动段**异步**恢复，
	 * 而恢复了多个聊天标签的窗口里聊天框挂载更快 ⇒ `ensureStarted()` 抢在恢复之前 ⇒ 发出的 Start
	 * 选项里 `workspaceId`/`relatedRoots` 为空，与上次落盘的预热选项不同 ⇒ 主进程判"选项变了"⇒
	 * **把已经跑了 35s 的预热 Host 杀掉重起**（双份冷启动 ≈ 83s 才 ready，用户看到三个聊天页全卡在
	 * "正在启动"）。这里取值与恢复路径同为 `resolveDefaultActiveWorkspaceId()` ⇒ 两边一致 ⇒ 复用预热 ✓。
	 */
	private async _startWorkspaceId(): Promise<string | undefined> {
		return this._studio.getActiveWorkspaceId()
			?? (await this._studio.resolveDefaultActiveWorkspaceId().catch(() => null))
			?? undefined;
	}

	private _startOptions(relatedRoots?: readonly string[], workspaceId?: string): IDshHostStartOptions {
		const get = (key: DshHarnessSettings) => this._configurationService.getValue<string>(key)?.trim() || undefined;
		// 技能根一次解析出两块（`customSkillDirs` 列表 + 内置的 `bundledSkillDir`）—— 见 `_skillDirs` 的注释 ✓
		const skills = this._skillDirs();
		return {
			runtimePath: get(DshHarnessSettings.RuntimePath),
			nodePath: get(DshHarnessSettings.NodePath),
			dshHome: get(DshHarnessSettings.DshHome),
			profile: get(DshHarnessSettings.Profile),
			// 看板插件要的当前工作区 id（启动时快照；取值与 IDE legacy kanban 工具同源）。
			// 真正启动 Host 的两条路径会传入解析好的值（覆盖启动竞态下还为空的内存游标，见 `_startWorkspaceId`）。
			workspaceId: workspaceId ?? this._studio.getActiveWorkspaceId(),
			// 代码图谱插件要的工作区根（主进程渲染成 `--patch` 覆盖层）。取值口径与 IDE 侧的图谱
			// 面板一致（`codebaseIndexEditorPane._getWorkspaceRoot()`）：工作区的第一个文件夹。
			workspaceRoot: this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath,
			// 图谱相关根（跨根只读查询用）：只有真正启动 Host 的两条路径会传新鲜值 ✓
			relatedRoots,
			// MCP：把 VsSaros 的用户配置路径交给主进程（主进程读它并渲染成 --patch 覆盖层）
			mcpConfigPath: this._mcpConfigPath(),
			// 技能库：**两块**分开交付（主进程过滤存在的，渲染成**同一条** skill-filesystem 覆盖层行）——
			// 一块走 `customSkillDirs`（rank 300），内置那块走 `bundledSkillDir`（rank 600）✓，见 `_skillDirs`
			skillDirs: skills.dirs,
			...(skills.bundledDir ? { bundledSkillDir: skills.bundledDir } : {}),
			// agents 模块要的 agent 目录（`<数据根>/agents`）——dev/生产的数据根不同，必须注入（见方法注释）
			agentsRoot: this._agentsRoot(),
			// 内置 agent 的**源目录**（真源 `resources/.agents/agents/<id>/.agent.md`）—— 主进程据此复制出
			// 交付副本；与上面那条一块儿来，dsh 侧才列得出内置 agent、且内容与真源一致 ✓。
			agentsBuiltinSrc: this._agentsBuiltinSrc(),
			// 数据根本身（kb / canvas / workflow / skills 都读它；mcp 用同一个根定位 mcp.json）——
			// 这几个模块此前**从来没有**被注入过 ⇒ dev 实例读的是生产数据（见选项与方法注释）
			dataRoot: this._dataRoot(),
			// A 组缺口（2026-10-12）：知识库存储根 —— 用户改过 `agentStudio.knowledge.storage.path` 才有值 ✓
			//（口径与 IDE 侧 `knowledgeBaseView.rootUri` 同一份实现 `resolveKbRoot` ✓）。不给的话 kb 与 canvas
			// 只认 `<数据根>/knowledge-base` ⇒ 用户改过就**空着且不报错** ✗。
			kbRoot: this._kbRoot(),
			// ★ 库记录（2026-10-15）：与 kbRoot 同一份覆盖层 ✓（写进 `vssaros-kb` 那一行 ✓ —— 那份 config
			//   整体替换 ⇒ 拆两份会互相擦掉 ✗）。拿不到 ⇒ `undefined` ⇒ 渲染器**不产生那两行** ✓。
			kbVaults: this._kbVaultsJson(),
			kbActiveVaultId: this._kbActiveVaultId(),
			// A 组缺口：Unreal bridge 基址 —— 这是三条里唯一**连配置键都没有**的一条 ✗（此前只能靠环境变量 ✓）。
			// 设置为空串 ⇒ undefined ⇒ 不注入 ⇒ 插件用自带默认（与 IDE 默认同值 ✓）。
			unrealBridgeUrl: this._configurationService.getValue<string>(AGENT_STUDIO_UNREAL_BRIDGE_URL_SETTING)?.trim() || undefined,
			// browser（2026-10-14，同一条缺口）：IDE 的 `browserCdp.{port,launchDedicated,headless}` 此前
			// **到不了 Host**（插件只读自己的 config / `VSSAROS_BROWSER_*`）⇒ 关掉「自动拉起调试实例」不生效，
			// 用工具抓已登录站点时被静默导向**空 profile** 的专属实例（现场＝先撞登录墙 ✓）。逐键注入见该方法注释。
			browser: this._browserOverlayConfig(),
			// 常驻：关闭 IDE 不杀 Host（桥插件空闲自退兜底），下次启动租约接管零等待
			keepAlive: this._configurationService.getValue<boolean>(DshHarnessSettings.HostKeepAlive) !== false,
			// 迭代期开关：启动时跳过随包插件的"升级"安装（缺失的仍装）。仓库里插件版本一 bump，
			// 启动前就要串行等 N×~2 s 的 `dsh plugin add`——开发期把它关掉，启动回到 ~0.3 s 量级。
			skipPluginInstall: this._configurationService.getValue<boolean>(DshHarnessSettings.SkipPluginInstall) === true,
		};
	}

	/**
	 * 工作区信任变化后的处理：技能根集合**真的变了**才重启 Host。
	 *
	 * 两个方向都要管：信任 ⇒ 项目级根进来（不重启不生效 ✗）；**取消信任 ⇒ 项目级根必须立刻出去** ✗
	 * （否则那个 Host 会一直带着"未被信任的工作区里的技能"跑 —— 这是安全侧的一条 ✗✗）。
	 * 没变化（例如工作区里压根没有技能目录）⇒ 什么都不做：重启 Host 是秒级成本，不该为无变化付 ✗。
	 */
	private async _onTrustChanged(): Promise<void> {
		try {
			// ⚠ 顺序硬要求：先把上一份快照读出来，`_skillDirs()` 会**就地覆盖**它 ✗（先调就永远相等）
			const prev = this._lastSkillDirs ?? [];
			const prevBundled = this._lastBundledSkillDir;
			const next = this._skillDirs();
			if (prev.length === next.dirs.length && prev.every((p, i) => p === next.dirs[i]) && prevBundled === next.bundledDir) {
				return;
			}
			if (this._status.state === 'stopped') {
				// Host 没在跑 ⇒ 下次启动自然带上新根 ✓（不能在这里 restart：那会把一个没人在用的 Host 拉起来 ✗）
				this._logService.info(`[dshHarness] 技能根已更新（${prev.length} → ${next.dirs.length} 个）；Host 未运行，下次启动生效`);
				return;
			}
			this._logService.info(`[dshHarness] 技能根因信任变化而改变（${prev.length} → ${next.dirs.length} 个）⇒ 重启 Host 让覆盖层生效`);
			await this.restart();
		} catch (e) {
			this._logService.warn(`[dshHarness] trust change handling failed: ${String((e as Error)?.message ?? e)}`);
		}
	}

	/**
	 * VsSaros 的技能库目录候选（**顺序即优先级**，与 IDE 侧注册表**同源**）。
	 *
	 * ★ 2026-10-13（P1）：根清单、顺序、来源、**trust 门控**、去重全部收进单一真源
	 * `agentStudio/common/skillRoots.ts` ✓ —— 本方法只负责算**基址**（数据根 / 内置目录 / 工作区根）
	 * 并喂给它 ✓。为什么必须同源：两侧各拼一份时，任何一边单独增删都会造成"IDE 看得见、聊天框看不见"
	 * 这类**最难查**的不一致 ✗（完整理由见 `skillRoots.ts` 头注释）。
	 *
	 * 为什么项目级根要 trust 门控：`<工作区>/.dsh/skills` 会随 git clone 进来 ⇒ 是**提示词注入面** ✗；
	 * 未信任时**一个都不注入**，并把被跳过的目录写进日志（用户能看到"为什么少了一半技能" ✓）。
	 * 存在性不过滤：不存在的目录由主进程 `existsSync` 过滤（`dshHostSupervisor`）✓。
	 *
	 * ★ 2026-10-13（P2）：返回值**分两块** —— 内置（`builtin`）单独走 {@link IDshHostStartOptions.bundledSkillDir}
	 * ⇒ 在 dsh 里落官方 **rank 600**（`BUNDLED_SKILL_RANK` ✓）；其余走 `customSkillDirs`（那一档被
	 * `dsh-skill-filesystem` 锁死在 300 ✗，配置里没有 rank/priority 字段 ⇒ 改不了 ✓）。
	 * 此前内置与用户根挤在同一档 300、只靠数组顺序分先后 ✗ —— 现在与官方 rank 表对齐 ✓。
	 */
	private _skillDirs(): { readonly dirs: string[]; readonly bundledDir?: string } {
		// FileAccess 相对 app 根解析，dev（仓库根）与打包（resources/app）两种形态都指到内置技能库。
		let builtinDir: string | undefined;
		try {
			builtinDir = FileAccess.asFileUri('vs/../../resources/.agents/skills').fsPath;
		} catch { /* 忽略 */ }
		// 生态用户级目录：清单已被**刻意置空** ⇒ 通常一个都不加 ✓（保留接线是为了"两处消费点同源"
		// 这条机制还在，见 `skillEcosystemDirs.ts` 头注释 ✓）。
		//
		// 为什么不用 `os.homedir()`：这里是**渲染进程**代码（无 node 全局）✗；而注入类型
		// `IWorkbenchEnvironmentService` 的标注上**没有** `userHome` —— 它是 `INativeEnvironmentService`
		// 的字段（运行时由原生环境服务提供 ✓，IDE 侧走的就是"穿透到 INativeEnvironmentService"那条路）。
		// 这里用"取交集"的窄化（不是 `as unknown as` 完全绕开），并按可选处理：拿不到就不注入 ✓。
		let extraUserDirs: string[] = [];
		let userHomeFsPath: string | undefined;
		try {
			const env = this._environmentService as IWorkbenchEnvironmentService & { readonly userHome?: URI };
			if (env.userHome) {
				userHomeFsPath = env.userHome.fsPath;
				extraUserDirs = ecosystemUserSkillDirPaths(env.userHome.fsPath);
			}
		} catch { /* 解析失败按没有生态目录处理 */ }

		const resolved = resolveSkillRoots({
			// 非 file 方案（虚拟/远端工作区）没有本地路径 ⇒ 该根跳过（与 `dshHarness.contribution` 同口径 ✓）
			workspaceFolders: this._workspaceContextService.getWorkspace().folders.map(f => f.uri.scheme === 'file' ? f.uri.fsPath : ''),
			// `<数据根>/skills` 即用户级技能库（dev/生产数据根不同 ⇒ 必须注入；口径与 IDE 侧同一份 ✓）
			dataRoot: this._dataRoot(),
			// 官方用户级 `<DSH_HOME>/skills`（rank 400，2026-10-13 用户拍板"支持"）：候选路径公式在
			// 真源里（dev 的 DSH_HOME = `<数据根>/dsh-home`、打包版回落 `~/.dsh` ⇒ 见该函数注释 ✓）
			officialUserDirs: officialUserSkillRootCandidates({
				dshHome: this._configurationService.getValue<string>(DshHarnessSettings.DshHome)?.trim() || undefined,
				dataRoot: this._dataRoot(),
				userHome: userHomeFsPath,
			}),
			builtinDirs: builtinDir ? [builtinDir] : [],
			extraUserDirs,
			// ⚠ 这里**刻意不喂** `dshPluginSkillDirs`（IDE 侧技能库那条 `ideOnly` 根 ✓）：
			//   dsh 插件自带的技能是**插件自己**注册的（插件包内那行 `dsh-skill-filesystem`）⇒
			//   我们再注一遍就是"同一技能名两个 provider 各报一份"（rank 还同为 bundled/600 ✗）——
			//   "模型拿到哪一份、版本是哪个"就变成不确定的，正是 2026-10-13 要消灭的重复交付 ✗。
			//   ⇒ 不对称是有意的：IDE 侧补来源、dsh 侧维持插件自注册 ✓
			//   （解析逻辑与理由见 `agentStudio/common/dshPluginSkillRoots.ts`）。
		}, {
			trusted: this._workspaceTrustService.isWorkspaceTrusted(),
			projectRoots: this._configurationService.getValue<boolean>(SKILL_PROJECT_ROOTS_SETTING_ID) !== false,
			// 关掉即回滚到"我们自己的用户库 + 内置"（不变量 4）✓ —— 与项目级是**独立**开关：
			// 官方用户级在用户主目录下，信任级别与我们自己的用户库相同 ⇒ 不需要 trust 门控 ✓
			officialUserRoot: this._configurationService.getValue<boolean>(SKILL_OFFICIAL_USER_ROOT_SETTING_ID) !== false,
		});

		if (resolved.skippedUntrusted.length) {
			// 不静默：用户报"技能少了一半"时，这行就是答案 ✓（信任后 `_onTrustChanged` 会重启 Host 纳入 ✓）
			this._logService.info(`[dshHarness] 工作区未受信任 ⇒ 跳过 ${resolved.skippedUntrusted.length} 个项目级技能根（${resolved.skippedUntrusted.join('、')}）；信任工作区后自动纳入 ✓`);
		}
		// ★ P2：内置与其余根**分开交付**（内置 ⇒ `bundledSkillDir` / rank 600；其余 ⇒ `customSkillDirs` / 300 ✓）。
		// 内置是**单个**目录（官方 schema 就是字符串 ✗）：dsh 侧只有 `FileAccess` 那一个候选 ✓（多个时以先者为准 ✓）。
		const bundledDir = resolved.roots.find(r => r.scope === 'builtin')?.fsPath;
		const dirs = resolved.roots.filter(r => r.scope !== 'builtin').map(r => r.fsPath);
		this._lastSkillDirs = dirs;
		this._lastBundledSkillDir = bundledDir;
		this._logService.info(`[dshHarness] skills roots: ${dirs.length} 个（${resolved.roots.filter(r => r.scope !== 'builtin').map(r => r.scope).join(' > ') || '无'}）+ bundled: ${bundledDir ? '1（rank 600）' : '0'}`);
		return { dirs, bundledDir };
	}

	/**
	 * **库记录**（2026-10-15）：IDE storage 里 `agentStudio.kb.vaults` 的**展示字段**（id / name / icon /
	 * customPath / closed ✓）—— 交给渲染器时序列化成 JSON 字符串（它只写 YAML scalar ✓，见 `dshCli.ts`）。
	 *
	 * 为什么走**注入**而不是页面桥 ✗：桥是"页面 → 宿主"的低风险**界面命令**（协议开篇写明 ✓），
	 * 而这是"宿主 → 页面"的**数据**；协议给的既有两条路是**推送**或**同源 HTTP**（见
	 * `DSH_PAGE_IPC_WORKTREES` 的注释 ✓）—— 注入比推送更早更简单（库记录在 Host 生命周期内不变 ✓），
	 * 且与 `kbRoot` / `dataRoot` **同源同一次启动** ✓（写进同一份 `roots-<id>.yml` ✓）。
	 *
	 * ⚠ 容错口径：读不到 / 解析失败 / 一条都没有 ⇒ `undefined` ⇒ **不注入** ⇒ 插件退回"按目录列出全部库"
	 * 的旧行为 ✓（不假装 ✓，也不让一次 storage 异常阻断 Host 启动 ✗）。
	 */
	private _kbVaultsSlim(): { id: string; name: string; icon: string; path?: string; closed?: true }[] | undefined {
		try {
			const raw = this._storageService.get(STORAGE_VAULTS, StorageScope.APPLICATION);
			if (!raw) { return undefined; }
			const vaults = JSON.parse(raw) as IKbVault[];
			if (!Array.isArray(vaults)) { return undefined; }
			// ⚠ 只带页面要用的字段（少传就少泄漏 ✓，与 `IDshWorktreeOption` 同一条纪律 ✓）。
			const slim = vaults
				.filter(v => v && String(v.id ?? '').trim())
				.map(v => ({
					id: String(v.id),
					name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : String(v.id),
					icon: typeof v.icon === 'string' && v.icon ? v.icon : '📚',
					...(v.customPath ? { path: String(v.customPath) } : {}),
					...(v.closed ? { closed: true as const } : {}),
				}));
			return slim.length > 0 ? slim : undefined;
		} catch {
			return undefined;
		}
	}

	/** 见 {@link _kbVaultsSlim}：给覆盖层用的 JSON 字符串（拿不到 ⇒ `undefined` ⇒ 不渲染那一行 ✓）。 */
	private _kbVaultsJson(): string | undefined {
		const slim = this._kbVaultsSlim();
		return slim ? JSON.stringify(slim) : undefined;
	}

	/**
	 * 见 {@link IDshHarnessService.isInsideKnowledgeBase}：判据与信任面**都在** `common/dshKbTrust.ts` ✓
	 * （本方法只负责把三个来源凑齐：kbRoot 设置 / 数据根 / 已登记库根的 customPath ✓）。
	 */
	isInsideKnowledgeBase(path: string): boolean {
		try {
			const roots = knowledgeBaseTrustRoots(
				this._kbRoot(),
				this._dataRoot(),
				(this._kbVaultsSlim() ?? []).map(v => v.path),
			);
			return isPathInside(path, roots, isWindows || isMacintosh);
		} catch {
			// 任何异常 ⇒ 退回"要用户确认"（fail-closed ✓：绝不因为读不到清单就**放宽** ✓）
			return false;
		}
	}

	/** 见 {@link _kbVaultsSlim}：当前激活的库 id（`agentStudio.kb.active` ✓）。 */
	private _kbActiveVaultId(): string | undefined {
		try {
			const id = this._storageService.get(STORAGE_ACTIVE, StorageScope.APPLICATION);
			return typeof id === 'string' && id.trim() ? id.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * **知识库存储根**（只有用户改过 `agentStudio.knowledge.storage.path` 才有值 ✓）。
	 *
	 * 为什么复用 IDE 的实现而不是自己算一遍 ✗：这条规则有"空 ⇒ `<数据根>/knowledge-base`、`~` 前缀展开"
	 * 等细节 ✓，自己算一遍就多一份**会漂移**的副本 ⇒ 直接调 `resolveKbRoot`（`knowledgeBaseView.rootUri`
	 * 用的**同一份** ✓）。没改过时返回 `undefined` ⇒ **不注入**（与插件默认同值，注入同值只会增加改错的机会 ✗）。
	 * 解析失败同样按"不注入"处理 ⇒ 插件退回自己的默认口径，不阻断 Host 启动 ✓。
	 */
	private _kbRoot(): string | undefined {
		const setting = this._configurationService.getValue<string>('agentStudio.knowledge.storage.path')?.trim();
		if (!setting) {
			return undefined;
		}
		const dataRoot = this._dataRoot();
		if (!dataRoot) {
			return undefined;
		}
		try {
			return resolveKbRoot(setting, dataRoot);
		} catch {
			return undefined;
		}
	}

	/**
	 * VsSaros 的 agent 目录（`<数据根>/agents`，与 `agentStudioService._getSarosAgentsDir()` 同源）。
	 *
	 * 交给 agents 模块（主进程渲染成 `config.agentsRoot` 覆盖层，行 id `vssaros-agents`）：模块自己的
	 * 兜底口径是 `~/.vssaros`（`dsh-plugins/vssaros-agents/lib/store.js`），而 **dev 实例的数据根是
	 * `~/.vssaros-dev`** ⇒ 不注入时 dev 实例列的是**生产** agent（2026-10-11 实测：dev 的 agents 目录里
	 * 5 个 agent，聊天框一个都没出现）。生产两者恰好同路径，这类错配被完全掩盖。
	 * 解析失败按"不注入"处理（模块退回自己的默认口径，不阻断 Host 启动）。
	 */
	private _agentsRoot(): string | undefined {
		try {
			return resolveSarosPath(userDataRootFromRoamingHome(this._environmentService.userRoamingDataHome), SarosPath.agents).fsPath;
		} catch {
			return undefined;
		}
	}

	/**
	 * **内置 agent 的源目录**（`resources/.agents/agents`）—— 真源是那里的 `<id>/.agent.md`。
	 *
	 * 与 `bundledSkillDir` 同一类：产品侧的东西，用绝对路径交付给读不到源码的 Host 进程。
	 * 主进程会把它**原样复制**成一份交付副本 ⇒ dsh 侧列出的内置 agent 与真源逐字节相同
	 * （不会因为"代码镜像没同步"而拿到旧内容 ✗）。解析失败 ⇒ 不注入（主进程退回镜像生成）。
	 */
	private _agentsBuiltinSrc(): string | undefined {
		try {
			return FileAccess.asFileUri('vs/../../resources/.agents/agents').fsPath;
		} catch {
			return undefined;
		}
	}

	/**
	 * VsSaros 用户**数据根**（生产 `~/.vssaros`、dev `~/.vssaros-dev`）：kb / canvas / workflow / skills
	 * 这几个模块都读它（另加 mcp 的配置路径，都走 `--patch` 覆盖层，见 `common/dshCli.ts` 的
	 * `renderDataRootOverlay`）。2026-10-12 之前它们**从来没有**被注入过 ⇒ dev 实例读的是生产数据。
	 * 解析失败按"不注入"处理（模块退回自己的 `~/.vssaros` 兜底，不阻断 Host 启动）。
	 */
	private _dataRoot(): string | undefined {
		try {
			return userDataRootFromRoamingHome(this._environmentService.userRoamingDataHome).fsPath;
		} catch {
			return undefined;
		}
	}

	/**
	 * VsSaros 的 MCP 用户配置绝对路径（`~/.vssaros/mcp.json`，与 IDE 的
	 * `McpWorkbenchManagementService` 读的是同一份；见 `mcpWorkbenchManagementService.ts` 的注释）。
	 * 解析失败按"没有 MCP 配置"处理（不阻断 Host 启动）。
	 */
	private _mcpConfigPath(): string | undefined {
		try {
			return resolveSarosPath(userDataRootFromRoamingHome(this._environmentService.userRoamingDataHome), SarosPath.mcpConfig).fsPath;
		} catch {
			return undefined;
		}
	}

	async ensureStarted(): Promise<IDshHostStatus> {
		// ★ 2026-10-19（首启成本拆分，只加日志不改行为）：
		//   从**首次** ensureStarted 到 Host 变 running 的耗时。与既有三行日志拼起来即可拆出各段：
		//     · `one-shot install of N plugin(s) took …`   —— pnpm 重装（改过版本的插件）
		//     · `spawned pid …`                            —— 进程启动
		//     · `[vssaros-bridge] apply (host uptime …)`   —— Host 内部插件 apply 完成
		//     · 本行                                        —— Host 侧就绪（之后才是页面连接阶梯 17.7s）
		//   实测（2026-10-19 17:17 实例）：install 4.4s + Host 内部 24.3s + 连接 17.7s。
		const t0 = this._startupT0 ?? (this._startupT0 = Date.now());
		const workspaceId = await this._startWorkspaceId();
		const s = await this._channel.call<IDshHostStatus>(DshHarnessChannelCommand.Start, this._startOptions(await this._relatedRoots(workspaceId), workspaceId));
		this._update(s);
		if (s.state === 'running' && !this._startupLogged) {
			this._startupLogged = true;
			this._logService.info(`[dshHarness] Host ready in ${Date.now() - t0} ms（首次 ensureStarted → running；结合 install / spawned / bridge apply 三行可拆出各段成本）`);
		}
		return s;
	}

	async restart(): Promise<IDshHostStatus> {
		const workspaceId = await this._startWorkspaceId();
		const s = await this._channel.call<IDshHostStatus>(DshHarnessChannelCommand.Restart, this._startOptions(await this._relatedRoots(workspaceId), workspaceId));
		this._update(s);
		return s;
	}

	stop(): Promise<void> {
		return this._channel.call(DshHarnessChannelCommand.Stop);
	}

	getLog(): Promise<string[]> {
		return this._channel.call(DshHarnessChannelCommand.GetLog);
	}

	listPlugins(): Promise<IDshPluginInfo[]> {
		return this._channel.call(DshHarnessChannelCommand.ListPlugins);
	}

	listBundledPlugins(): Promise<IDshBundledPluginRow[]> {
		return this._channel.call(DshHarnessChannelCommand.ListBundledPlugins);
	}

	installBundledPlugin(name: string): Promise<IDshBundledInstallResult> {
		return this._channel.call(DshHarnessChannelCommand.InstallBundledPlugin, { name });
	}

	installLocalPlugin(spec: string): Promise<IDshBundledInstallResult> {
		return this._channel.call(DshHarnessChannelCommand.InstallLocalPlugin, { spec });
	}

	installPluginSpec(spec: string, name: string): Promise<IDshBundledInstallResult> {
		return this._channel.call(DshHarnessChannelCommand.InstallPluginSpec, { spec, name });
	}

	async resolveModulePage(containerId: string): Promise<IDshModulePageState | undefined> {
		const plugins = await this.listPlugins();
		// 清单驱动（重构 1.1）：容器与页面都按清单派生，新模块插件不再需要改这两张壳侧表。
		// 表里没有的容器（常驻容器）返回 undefined：静态注册负责，没有"插件页面"这回事。
		const containers = containersFromPlugins(plugins);
		const container = containers.find(c => c.containerId === containerId)
			?? DSH_MODULE_CONTAINERS.find(c => c.containerId === containerId);
		if (!container) {
			return undefined;
		}
		// 与 ActivityBar 同一口径：停用（`enabled === false`）视同未激活，缺省视为启用。
		// 激活模块 = 清单派生 ∪ 硬编码反查（清单读不到的内置插件仍有旧路径兜底，不制造新故障）。
		const enabled = plugins.filter(p => p.enabled !== false);
		const active = [...new Set([
			...activeModulesOf(enabled.map(p => p.name)),
			...activeModulesFromPlugins(enabled),
		])] as DshModuleId[];
		return withWorkbenchClient(resolveContainerPageState(container, active, pagesFromPlugins(plugins)), plugins);
	}

	getPluginActivation(): Promise<IDshPluginActivationSnapshot> {
		return this._channel.call(DshHarnessChannelCommand.GetPluginActivation);
	}

	// ─── 插件商城（方案 5.16 批次 2，只读面）────────────────────────────────
	listDshBundles(): Promise<IBridgeBundleInfo[]> {
		return this._channel.call(DshHarnessChannelCommand.ListDshBundles);
	}

	listDshPluginRows(): Promise<IBridgePluginRow[]> {
		return this._channel.call(DshHarnessChannelCommand.ListDshPluginRows);
	}

	getDshPluginRegistries(): Promise<IBridgePluginRegistries> {
		return this._channel.call(DshHarnessChannelCommand.GetDshPluginRegistries);
	}

	getDshPluginInventory(): Promise<IBridgePluginInventory> {
		return this._channel.call(DshHarnessChannelCommand.GetDshPluginInventory);
	}

	// ─── 插件商城（方案 5.16 批次 4，安装面）。主进程统一兜错与超时，这里只转发。
	inspectDshPlugin(spec: string): Promise<IBridgeInspectResult> {
		return this._channel.call(DshHarnessChannelCommand.InspectDshPlugin, { spec });
	}

	installDshPlugin(spec: string, requestId: string, approvedBuilds?: readonly string[]): Promise<IBridgeInstallResult> {
		return this._channel.call(DshHarnessChannelCommand.InstallDshPlugin, {
			spec,
			requestId,
			...(approvedBuilds?.length ? { approvedBuilds } : {}),
		});
	}

	cancelDshPluginInstall(requestId: string): Promise<IBridgeInstallCancelResult> {
		return this._channel.call(DshHarnessChannelCommand.CancelDshPluginInstall, { requestId });
	}

	removeDshPlugin(name: string): Promise<IBridgeInstallResult> {
		return this._channel.call(DshHarnessChannelCommand.RemoveDshPlugin, { name });
	}

	setPluginEnabled(name: string, enabled: boolean): Promise<IDshPluginSetResult> {
		return this._channel.call(DshHarnessChannelCommand.SetPluginEnabled, { name, enabled });
	}

	setDshBundleEnabled(name: string, enabled: boolean): Promise<IDshPluginSetResult> {
		return this._channel.call(DshHarnessChannelCommand.SetDshBundleEnabled, { name, enabled });
	}

	setDshPluginRowEnabled(entryId: string, enabled: boolean): Promise<IDshPluginRowSetResult> {
		return this._channel.call(DshHarnessChannelCommand.SetDshPluginRowEnabled, { entryId, enabled });
	}

	getRuntimeInfo(): Promise<IDshRuntimeInfo> {
		return this._channel.call(DshHarnessChannelCommand.GetRuntimeInfo);
	}

	async installRuntime(version: string): Promise<string> {
		const r = await this._channel.call<{ version: string }>(DshHarnessChannelCommand.InstallRuntime, { version, nodePath: this._startOptions().nodePath });
		return r.version;
	}

	setCurrentRuntime(version: string): Promise<void> {
		return this._channel.call(DshHarnessChannelCommand.SetCurrentRuntime, { version });
	}

	policy(): IDshUpdatePolicy {
		const raw = this._configurationService.getValue<string>(DshHarnessSettings.UpdateChannel);
		const channel: DshUpdateChannel = raw === 'preview' || raw === 'locked' ? raw : 'stable';
		const get = (key: DshHarnessSettings) => this._configurationService.getValue<string>(key)?.trim() || undefined;
		return { channel, pinned: get(DshHarnessSettings.PinnedVersion), compatUrl: get(DshHarnessSettings.CompatManifestUrl) };
	}

	async setWindowWorkspaces(windowId: number, paths: readonly string[]): Promise<void> {
		await this._channel.call(DshHarnessChannelCommand.SetWindowWorkspaces, { windowId, paths });
	}

	/**
	 * 同步"**IDE 主窗口是我们藏着的**"这个事实给主进程（desktop 模式的窗口守卫，2026-10-21）。
	 *
	 * 为什么需要（用户报障："在 desktop 模式下，点击登录，不要显示 ide 模式的窗口"）：desktop 模式把
	 * IDE 主窗口整个藏起来了；用户在桌面窗口点「登录」⇒ 走 TOF 浏览器流程 ⇒ **窗口层面**的外部动作
	 * （系统把焦点还给本应用的窗口）会把 IDE 主窗口拉到前台（真机日志：桌面窗口 BLUR 后 1.6s IDE 主窗口
	 * FOCUS ✗）⇒ 只在命令分发处拦**拦不住**（那不是命令）⇒ 守卫必须落在**主进程**（那边看得到窗口事件）✓。
	 *
	 * ⚠ 失败只记日志、不抛：守卫是"锦上添花"的防线 ⇒ 它坏了不该把调用方（启动/关窗流程）带崩 ✗。
	 */
	async setIdeWindowHidden(hidden: boolean, windowId: number): Promise<void> {
		try {
			await this._channel.call(DshHarnessChannelCommand.SetIdeWindowHidden, { hidden, windowId });
		} catch (e) {
			this._logService.warn(`[dshHarness] desktop 守卫开关没送达（hidden=${hidden}）：${String((e as Error)?.message ?? e)}`);
		}
	}

	/** 经控制桥查询 dsh 已注册的工作区（诊断用）；控制桥不可用时为空。 */
	listWorkspaces(): Promise<IBridgeWorkspace[]> {
		return this._channel.call<IBridgeWorkspace[]>(DshHarnessChannelCommand.ListWorkspaces).catch(() => []);
	}

	/** 建/接管 dsh 会话（方案第 7 章 `session.start`）：`sessionId` 给定时幂等接管同一会话。 */
	startSession(args: IBridgeSessionStartArgs): Promise<IBridgeSessionStartResult> {
		return this._channel.call<IBridgeSessionStartResult>(DshHarnessChannelCommand.StartSession, args);
	}

	/** 后台回合（重构 1.4 `session.run`）：投 prompt、等回合跑完、回传结果。 */
	runSession(args: IBridgeSessionRunArgs): Promise<IBridgeSessionRunResult> {
		return this._channel.call<IBridgeSessionRunResult>(DshHarnessChannelCommand.RunSession, args);
	}

	/** 取消一条会话当前的活动（重构 1.4 `session.cancel`）。 */
	cancelSession(args: IBridgeSessionCancelArgs): Promise<IBridgeSessionCancelResult> {
		return this._channel.call<IBridgeSessionCancelResult>(DshHarnessChannelCommand.CancelSession, args);
	}

	get workspaceSync(): IDshWorkspaceSyncSummary {
		return this._workspaceSync;
	}

	async getWorkspaceSync(): Promise<IDshWorkspaceSyncState> {
		const state = await this._channel.call<IDshWorkspaceSyncState>(DshHarnessChannelCommand.GetWorkspaceSync);
		const reported = new Set(state.windows.flatMap(w => w.paths)).size;
		const rejected = state.results.filter(r => r.error).length;
		this._workspaceSync = { reported, registered: state.results.length - rejected, rejected };
		return state;
	}

	discoverUpdates(): Promise<IDshUpdateDiscoveryResult> {
		return this._channel.call(DshHarnessChannelCommand.DiscoverUpdates, { policy: this.policy(), start: this._startOptions() });
	}

	async bootstrap(): Promise<IDshHostStatus> {
		const args: IDshBootstrapArgs = {
			start: this._startOptions(),
			nodeMirror: this._configurationService.getValue<string>(DshHarnessSettings.NodeMirror)?.trim() || undefined,
			policy: this.policy(),
		};
		const s = await this._channel.call<IDshHostStatus>(DshHarnessChannelCommand.Bootstrap, args);
		this._update(s);
		return s;
	}

	installNode(version?: string): Promise<{ version: string; path: string }> {
		const mirror = this._configurationService.getValue<string>(DshHarnessSettings.NodeMirror)?.trim() || undefined;
		return this._channel.call(DshHarnessChannelCommand.InstallNode, { mirror, version });
	}

	upgrade(version: string, force?: boolean): Promise<IDshUpgradeResult> {
		const args: IDshUpgradeArgs = { version, force, start: this._startOptions(), installIfMissing: true };
		return this._channel.call(DshHarnessChannelCommand.Upgrade, args);
	}

	getActivity(): Promise<IHostActivity | undefined> {
		return this._channel.call(DshHarnessChannelCommand.GetActivity);
	}

	async noteActiveWorkspace(workspaceId: string | undefined): Promise<void> {
		const previous = this._observedWorkspaceId;
		// ★ 首记（`previous === undefined`）也推：切工作区在"切窗口"那条路径上时，新窗口的第一次进来
		//   previous 还没值 ⇒ 从前这里**什么都不做** ⇒ Host 里那份启动快照永远是旧的（静默 ✗）。
		if (previous === workspaceId) {
			return;
		}
		this._observedWorkspaceId = workspaceId;
		// ① 运行期上下文（首选，不重启）：Host 在跑就推；没在跑 ⇒ 下次 Start 自然带上新值 ✓
		const applied = await this._pushWorkspaceContext(workspaceId)
			.catch(e => {
				this._logService.warn(`[dshHarness] push workspace context failed: ${String((e as Error)?.message ?? e)}`);
				return false;
			});
		if (applied) {
			if (previous !== undefined) {
				this._logService.info('[dshHarness] active workspace changed — runtime context pushed (no Host restart needed)');
			}
			return;
		}
		// ② 兜底：老 Host / 老插件不认这条（`applied:false`）⇒ 与从前逐字一致的重启路径
		if (previous === undefined || this.status.state !== 'running') {
			return;
		}
		const activity = await this.getActivity().catch(() => undefined);
		const restart = shouldRestartForWorkspaceChange({
			previousWorkspaceId: previous,
			nextWorkspaceId: workspaceId,
			running: true,
			// 取不到活动状态 ⇒ `undefined` ⇒ 保守不重启（宁可选项晚一步生效，也不打断在跑的活）
			blockingSessionCount: activity ? blockingSessions(activity).length : undefined,
		});
		if (!restart) {
			// 有会话在跑：**不重启**。supervisor 里那行日志会说明"选项变了但没生效"，这里不再重复刷屏
			return;
		}
		this._logService.info('[dshHarness] active workspace changed while the Host is idle — restarting so the new workspaceId takes effect');
		await this.restart();
	}

	/**
	 * 把当前工作区上下文推给 Host（`workspace.context`）——切工作区**不必重启**的落点。
	 *
	 * 载荷口径与启动覆盖层**同源**（`_startOptions` 的 workspaceId / workspaceRoot / relatedRoots）✓：
	 *   · `workspaceId`   —— Agent Studio 当前活动工作区（看板过滤 + 记忆分区）；
	 *   · `workspaceRoot` —— **该工作区记录的主根**（代码图谱按 `<root>/.codebase-memory/` 定位）；
	 *   · `relatedRoots`  —— 主根 + 关联根（`_relatedRoots()`，与图谱面板同一份取值）。
	 *
	 * ★ 2026-10-17 真机日志抓到并修掉的一个**自相矛盾载荷**：`workspaceRoot` 从前取的是
	 *   **本窗口的第一个 folder**（`_workspaceContextService`），而 `workspaceId` 取 **studio 的活动工作区 id**
	 *   —— 这两者在切换过程中**不同步**（studio 的活动 id 立刻变，IDE 窗口 folders 异步跟随）
	 *   ⇒ 真机实测推出过 `workspaceId=sarosis-agents-client-ncshv` 配 `root=f:\GR_qiuzijian_main\S1Game`（另一个工作区的根 ✗），
	 *   紧接着又是反过来的组合 ✗✗（Host 日志 `[vssaros-bridge] workspace context applied: …` 四条里两条是错配 ✓）。
	 *   消费方（图谱根 / runner cwd / 看板页）拿到这种上下文只会"看着切了、东西没跟着走" ✗。
	 *   ⇒ 现在**两者同源同刻**：都从 studio 那条工作区记录取（主根 = `relatedRoots[0]`，与 `_relatedRoots` 同一份 ✓）；
	 *   只有"没有活动工作区 / 记录里一个根都没有"时才回落到窗口 folder（那才是"用窗口自己的根"的语义 ✓）。
	 *   两者不一致时**留一行 warn**（这种错配从前只能靠 Host 日志逐条比对才看得出来 ✗）。
	 *
	 * ⚠ 三项**一起**推：Host 侧以整份为准、不做逐字段回落 ⇒ "切到没有关联根的工作区"才不会留着旧根 ✓
	 *   （纪律见 `dsh-plugins/vssaros-foundation/lib/workspaceContext.js`）。
	 *
	 * @returns `true` = 真的生效（或 Host 没在跑，下次启动自然带上）；`false` = 调用方应退回重启路径。
	 */
	private async _pushWorkspaceContext(workspaceId: string | undefined): Promise<boolean> {
		if (this.status.state !== 'running') {
			// ★ 2026-10-20：这里原本**静默 return true** ⇒ 排查时看到"日志里没有 push 那行"，
			//   分不清是「压根没调用」（没切工作区）还是「调了但 Host 没在跑」，只能靠猜 ✗。
			//   补一行 trace 把状态说出来（下次 Start 会自然带上新值，这条不是错误路径 ✓）。
			this._logService.trace(`[dshHarness] workspace context push skipped: Host 状态=${this.status.state}（该值会由下一次 Start 带上）`);
			return true;
		}
		// `_relatedRoots()` 的第一项就是该工作区的**主根**（`[ws.path, ...relatedFolders]` 去重 ✓），
		// 与 `renderCodebaseOverlay` 用的是同一份取值 ⇒ 同源同刻 ✓。
		const relatedRoots = await this._relatedRoots(workspaceId);
		const studioRoot = relatedRoots?.[0];
		const windowRoot = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (studioRoot && windowRoot && !this._sameFsPath(studioRoot, windowRoot)) {
			this._logService.warn(`[dshHarness] 工作区根与窗口 folder 不一致（推工作区记录那份：记录=${studioRoot}，窗口=${windowRoot}）`
				+ '—— 切换过程中窗口 folders 会滞后，属预期；但若这行**持续刷**，说明工作区记录本身不对');
		}
		const args: IBridgeWorkspaceContextArgs = {
			// 三样都可能"没有"（没有活动工作区 / 没有可用根 / 没有关联根）—— 空值**照推**，
			// 那是权威的"当前没有"，不是"没给"（Host 侧的纪律 ①）✓
			...(workspaceId ? { workspaceId } : {}),
			workspaceRoot: studioRoot ?? windowRoot,
			relatedRoots: relatedRoots ?? [],
			windowId: mainWindow?.vscodeWindowId,
			at: Date.now(),
		};
		this._logService.info(`[dshHarness] workspace context push → Host：workspaceId=${workspaceId ?? '(none)'} root=${args.workspaceRoot ?? '(none)'} related=${args.relatedRoots?.length ?? 0}（窗口 folder=${windowRoot ?? '(none)'}）`);
		const result = await this._channel.call<IBridgeWorkspaceContextResult>(DshHarnessChannelCommand.SetWorkspaceContext, args);
		if (result?.applied !== true) {
			this._logService.info(`[dshHarness] runtime workspace context not applied (${result?.reason ?? 'unknown'}) — falling back to the restart path`);
		}
		return result?.applied === true;
	}

	/** 两个文件系统路径是否指同一处（大小写不敏感 + 分隔符归一 + 去尾斜杠）——只给上面那行**判噪**用 ✓。 */
	private _sameFsPath(a: string, b: string): boolean {
		const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
		return norm(a) === norm(b);
	}

	createView(viewId: string, windowId: number, surface: DshViewSurface, sessionId?: string, route?: string, pageSurface?: DshPageSurface, overrideChatOnlyUi?: boolean, isolatedPool?: boolean): Promise<void> {
		this._ownViews.add(viewId);
		const chatIdOfView = DshHarnessService._chatIdOf(viewId);
		// 聊天框只保留聊天 UI（方案 5.13）：把设置交给 preload，在页面里隐藏 dsh 的侧栏 / 顶栏 / 右侧栏。
		// `overrideChatOnlyUi` 供「拼装式弹窗」按视图覆盖（弹窗要复刻官方 desktop ⇒ 保留官方整套 chrome ✓）。
		const chatOnlyUi = overrideChatOnlyUi ?? (this._configurationService.getValue<boolean>(DshHarnessSettings.ChatOnlyUi) !== false);
		return this._channel.call(DshHarnessChannelCommand.CreateView, {
			viewId, windowId, surface, chatOnlyUi, sessionId, colorScheme: this._colorScheme(),
			// 弹窗走**独立网络分区**（不与主窗口争同一个 host:port 的 6 条并发连接），见 `DSH_VIEW_PARTITION_DESKTOP`。
			...(isolatedPool ? { isolatedPool: true } : {}),
			// ★ 底色候选（2026-10-13「初次打开侧栏视图白屏一下」）：随**创建**一起给 ⇒
			//   主进程建视图时就染色，页面画出第一帧之前不会露 Electron 默认白 ✓（只靠 pushTheme 会晚一拍 ✗）。
			backgrounds: this._viewBackgrounds(),
			// 承载表面（2026-10-13）与 route 一起只在 plugin-page / workbench 下有意义 ✓（主进程再白名单校验一次）
			...(surfaceTakesRoute(surface) ? { route, pageSurface } : {}),
		}).then(() => {
			// ★ 绑定记账（"这条会话已在本窗口的某个页签里打开"的唯一权威）：见 findChatIdForSession 的注释。
			if (chatIdOfView && sessionId) {
				this._chatSession.set(chatIdOfView, sessionId);
			}
			this._pushTheme(viewId); this._pushWorktrees(viewId); this._pushWorkspaces(viewId); this._pushAuth(viewId);
		});
	}

	/**
	 * dsh 侧会话摘要（读 projcache；主进程解析规则见 `common/dshSessionIndex.ts`）。
	 *
	 * 失败一律降级为空数组：这条只给侧栏"补充"用，绝不能因为它让整个会话列表空白 ✗。
	 */
	async listDshSessions(): Promise<readonly IDshSessionSummary[]> {
		try {
			const list = await this._channel.call<IDshSessionSummary[]>(DshHarnessChannelCommand.ListDshSessions, undefined);
			return Array.isArray(list) ? list : [];
		} catch (e) {
			this._logService.warn('[dshHarness] listDshSessions failed', e);
			return [];
		}
	}

	/**
	 * 按 **dsh 会话 id** 改名：先找到"正在显示它的聊天视图"，再用既有的 `renameSession(viewId, title)`
	 * 推给页面（`dshViewHost` → IPC → preload → 页面 `ctx.sessions.rename`）。
	 *
	 * ⚠ 返回 `true` **只代表请求已推给页面**；真正的成败看 `onDidDshSessionRenamed`（页面回执）⇒
	 *   调用方**不许**在这里就报"已改名"（假成功 ✗）。
	 */
	async renameDshSession(sessionId: string, title: string): Promise<boolean> {
		let views: IDshViewInfo[] = [];
		try {
			views = await this.listViews();
		} catch (e) {
			this._logService.warn('[dshHarness] renameDshSession: listViews failed', e);
			return false;
		}
		const chat = views.find(v => v.surface === 'chat' && v.sessionId === sessionId && this._ownViews.has(v.viewId));
		if (!chat) {
			this._logService.info(`[dshHarness] renameDshSession(${sessionId}): 该会话当前没有在聊天视图里打开 ⇒ 无法改名（改名只能由页面做）`);
			return false;
		}
		try {
			await this.renameSession(chat.viewId, title);
			this._logService.info(`[dshHarness] renameDshSession(${sessionId}) → view ${chat.viewId}（等页面回执）`);
			return true;
		} catch (e) {
			this._logService.warn(`[dshHarness] renameDshSession(${sessionId}) failed`, e);
			return false;
		}
	}

	/**
	 * 把侧栏点的 dsh 会话切到聊天视图（同一窗口内）。
	 *
	 * ⚠ 只挑 `surface === 'chat'` 的视图：`full`（官方整页）与 `plugin-page` 都不是聊天框，
	 * 对它们 rebind 等于把用户正在看的插件页顶掉 ✗。
	 * ⚠ 多个聊天视图时优先**本窗口**（`ownerWindowId` 与视图池里最小的那个一致即可 —— 这里退一步，
	 * 取"最近聚焦"的那条最好，但那条只有聊天宿主知道；拿不到就取第一个 chat 视图，并在日志里留痕）。
	 */
	async openDshSessionChat(sessionId: string): Promise<boolean> {
		let views: IDshViewInfo[] = [];
		try {
			views = await this.listViews();
		} catch (e) {
			this._logService.warn('[dshHarness] openDshSessionChat: listViews failed', e);
			return false;
		}
		const chat = views.find(v => v.surface === 'chat' && this._ownViews.has(v.viewId));
		if (!chat) {
			this._logService.info(`[dshHarness] openDshSessionChat(${sessionId}): 本窗口没有聊天视图 ⇒ 无法切换`);
			return false;
		}
		try {
			await this.rebindSession(chat.viewId, sessionId);
			this._logService.info(`[dshHarness] openDshSessionChat(${sessionId}) → view ${chat.viewId}`);
			return true;
		} catch (e) {
			this._logService.warn(`[dshHarness] openDshSessionChat(${sessionId}) failed`, e);
			return false;
		}
	}

	/** 当前主题 → dsh token 覆盖层（两形态同值，页面始终跟 IDE 一致）；推给指定视图。 */
	private _pushTheme(viewId: string): void {
		const tokens = buildDshThemeTokens(id => this._themeCssColor(id));
		const backgrounds = this._viewBackgrounds();
		// 即便 token 全缺、只要拿到了底色也照推（切主题时原生视图底色得跟着走 ✓）
		if (Object.keys(tokens).length || backgrounds) {
			void this._channel.call(DshHarnessChannelCommand.PushTheme, { viewId, tokens, colorScheme: this._colorScheme(), ...(backgrounds ? { backgrounds } : {}) });
		}
	}

	/** 主题色 → CSS 串（不透明用 hex，与 `--vscode-*` 变量同形态便于比对；透明保留 rgba()）；取不到 ⇒ undefined。 */
	private _themeCssColor(id: string): string | undefined {
		const color = this._themeService.getColorTheme().getColor(id, true);
		return color ? (color.rgba.a === 1 ? Color.Format.CSS.formatHex(color) : color.toString()) : undefined;
	}

	/**
	 * 视图**底色候选**（2026-10-13：修「初次打开侧栏视图白屏一下」）。
	 *
	 * ⚠ 这里给**两个位置**的颜色（侧栏 / 编辑器区），由**主进程**按 `pageSurface` 挑 —— 该用哪一个
	 * 只有它知道（它持有 `slot.pageSurface`）；渲染进程这边只负责"取当前主题的颜色" ✓
	 * （判据本体在 `dshThemeBridge.ts::backgroundForPageSurface`，可单测 ✓）。
	 */
	private _viewBackgrounds(): IDshViewBackgrounds | undefined {
		const sidebar = this._themeCssColor('sideBar.background') ?? this._themeCssColor('editorWidget.background') ?? this._themeCssColor('editor.background');
		const editor = this._themeCssColor('editor.background');
		if (!sidebar && !editor) {
			return undefined;
		}
		return { ...(sidebar ? { sidebar } : {}), ...(editor ? { editor } : {}) };
	}

	/** 当前 IDE 主题的 light/dark（dsh 页面的 palette 模式据此对齐；弹层等非 alias token 跟随 palette 模式）。 */
	private _colorScheme(): DshColorScheme {
		return /dark/i.test(String(this._themeService.getColorTheme().type)) ? 'dark' : 'light';
	}

	private _pushThemeToAll(): void {
		for (const viewId of this._ownViews) {
			this._pushTheme(viewId);
		}
	}

	/**
	 * worktree 列表 → 页面（dsh 聊天 header 的 worktree 下拉）。
	 *
	 * 口径：**当前窗口主工作区目录**（`folders[0]`）的 worktree —— 与 dsh 会话的 cwd 同源
	 * （`dshChatInstanceHost` 建会话时用的就是它）⇒ 列表里每一项都是"可以直接拿来开会话的目录" ✓。
	 *
	 * 没有仓库目录 / git 报错时推**空列表**（而不是不推）：页面据此显示"无 worktree"，
	 * 不会停在上一份快照上（推送是幂等快照，与主题同口径 ✓）。
	 * `listWorktrees` 走 git（异步、可能慢），所以这里不 await、失败只留 trace。
	 */
	private async _currentWorktreeOptions(): Promise<IDshWorktreeOption[]> {
		// ⚠ 2026-10-13 加固：原来只看 `folders[0]` —— 而**多根工作区**里第一个根未必是 git 仓库
		// （实测启动时要 ensure 7 个路径），那时 `listWorktrees` 会抛或返回空 ⇒ 这里推 0 条 ⇒
		// 页面那枚 chip（`list.length === 0` 时按设计 `return null`）**永远不出现**，
		// 表现出来就是用户报的"没有显示 worktree ui" ✗。
		// 现在：**依次尝试**前几个根，取第一个拿得到结果的；并把用的是哪个根写进日志
		// （从此这条链路可自证：有列表 ⇒ 会打 `worktree list from <根>`，0 条也打得出来 ✓）。
		const folders = this._workspaceContextService.getWorkspace().folders;
		for (const folder of folders.slice(0, DSH_WORKTREE_FOLDER_PROBE_LIMIT)) {
			const repoPath = folder.uri.fsPath;
			try {
				const list = await this._worktreeService.listWorktrees(repoPath);
				if (list.length === 0) {
					continue;
				}
				this._logService.info(`[dshHarness] worktree list from ${repoPath}: ${list.length} item(s)`);
				return list.slice(0, DSH_WORKTREE_OPTION_LIMIT).map(w => ({
					path: w.path,
					name: w.name,
					...(w.branch ? { branch: w.branch } : {}),
					isMain: w.isMain === true,
				}));
			} catch (e) {
				// 不是仓库 / git 不可用：换下一个根试（每根都会留 trace，排查时能看出试过谁）
				this._logService.trace(`[dshHarness] worktree list failed for ${repoPath}: ${String((e as Error)?.message ?? e)}`);
			}
		}
		return [];
	}

	/**
	 * **IDE 工作区记录（含各根）** → 页面（多根工作区；2026-10-16 用户拍板稿 C）。
	 *
	 * 为什么真源必须是它、而不是页面已经在读的 `workspaces.list()`：dsh 的工作区模型**只能单目录**，
	 * 宿主上报时把 IDE 侧一个多根工作区的各根**摊平**成 N 条 dsh 记录
	 * （`dshHarness.contribution.ts::_collect`）⇒ 页面只看快照时，同一个窗口的 3 个根看起来就是
	 * "3 个互不相干的工作区" ✗（用户报的"工作区 UI 不对"根因之一）。
	 * 各根 / 主根身份 / `.code-workspace` 身份只有 IDE 记录知道 ⇒ 只能在这里读、经推送交给页面 ✓。
	 *
	 * 取值口径与 `_relatedRoots()` **同一份**（`ws.path` + `ws.relatedFolders`）——两处若分叉，
	 * 会出现"图谱认一个根集合、下拉认另一个"✗。
	 *
	 * ⚠ 空表也照推（幂等快照，与 worktree / 主题同口径 ✓）：否则页面会停在上一份快照上。
	 * ⚠ `.code-workspace` 身份只在有值时才带（`codeWorkspacePath`）—— 页面**本轮只读展示**它（拍板 ④-i）。
	 */
	private async _currentWorkspaceOptions(): Promise<IDshWorkspaceOption[]> {
		const workspaces = await this._studio.getWorkspaces().catch(() => []);
		const out: IDshWorkspaceOption[] = [];
		for (const ws of workspaces) {
			if (out.length >= DSH_WORKSPACE_OPTION_LIMIT) { break; }
			// 主根：`ws.path` 可能是**工作区文件**本身（`.code-workspace`）—— 那不是目录、不能当 `cwd` ✗
			// ⇒ 与 `workspaces` 上报口径一致地只收目录（文件身份另走 `codeWorkspacePath` ✓）。
			const dirs = [ws.path, ...(ws.relatedFolders ?? []).map(f => f?.path)]
				.filter((p): p is string => typeof p === 'string' && p.length > 0 && !hasWorkspaceFileExtension(p));
			const roots = [...new Set(dirs)].slice(0, DSH_WORKSPACE_ROOT_LIMIT);
			if (roots.length === 0) {
				continue;   // 一个可用目录都没有 ⇒ 不编一条假记录 ✓
			}
			const name = typeof ws.name === 'string' && ws.name.trim() ? ws.name.trim() : basename(roots[0]);
			out.push({
				id: ws.id,
				name,
				roots: roots.map((p, i) => ({ path: p, name: basename(p), isPrimary: i === 0 })),
				...(ws.codeWorkspacePath ? { codeWorkspacePath: ws.codeWorkspacePath } : {}),
			});
		}
		return out;
	}

	private _pushWorktrees(viewId: string): void {
		void this._currentWorktreeOptions()
			.then(options => {
				// ★ **成功也留一行**（2026-10-13 用户报"没有显示 worktree ui"的教训）：页面那枚 chip 在
				//   `list.length === 0` 时按设计**不渲染** ⇒ "没 UI" 可能只是"这里推了 0 条"；
				//   而这行从前不存在、失败还走 `trace` ⇒ 整条链路零痕迹，报障时只能靠猜 ✗✗。
				this._logService.info(`[dshHarness] worktree push: ${options.length} item(s) → ${viewId}`);
				return this._channel.call(DshHarnessChannelCommand.PushWorktrees, { viewId, options });
			})
			.catch(e => this._logService.warn(`[dshHarness] worktree push skipped: ${String((e as Error)?.message ?? e)}`));
	}

	private _pushWorktreesToAll(): void {
		for (const viewId of this._ownViews) {
			this._pushWorktrees(viewId);
		}
	}

	/**
	 * IDE 工作区记录（含各根）→ 页面。与 `_pushWorktrees` 同口径（空表也推、失败留一行 ✓），
	 * 差别只在数据源是异步的 `getWorkspaces()`（工作区注册表）而不是 git。
	 */
	private _pushWorkspaces(viewId: string): void {
		void this._currentWorkspaceOptions()
			.then(options => {
				// ★ 2026-10-17：日志里带上 **IDE 的活动工作区 id**（用户报「切工作区后聊天框的工作区 UI 不刷新」）。
				//   页面那枚入口的"当前工作区"判据是**会话归属**（`workspaceIdOfSession`），与这里的"活动工作区"
				//   是**两个不同的概念**（前者 = 会话跑在哪，后者 = 窗口在看哪）⇒ 报障时这两者必须能一起看到，
				//   否则分不清是"推错了"还是"页面按会话显示（本来就该那样）"✓。
				this._logService.info(`[dshHarness] workspace record push: ${options.length} item(s) → ${viewId}（IDE 活动工作区=${this._studio.getActiveWorkspaceId() ?? '(none)'}）`);
				return this._channel.call(DshHarnessChannelCommand.PushWorkspaces, { viewId, options });
			})
			.catch(e => this._logService.warn(`[dshHarness] workspace record push skipped: ${String((e as Error)?.message ?? e)}`));
	}

	/**
	 * IDE 登录态 → 所有本窗口的 dsh 视图（2026-10-21）。
	 *
	 * ⚠ 只推**展示投影**（signedIn / 登录名 / 工号 / 团队）—— 票据绝不下发到页面 ✓。
	 */
	public pushAuthToAll(): void {
		for (const viewId of this._ownViews) {
			this._pushAuth(viewId);
		}
	}

	/**
	 * 登录/登出**失败**时把原因推给所有本窗口的 dsh 视图（2026-10-21）。
	 *
	 * 为什么必须有：页面桥是**单向**的（只回 true）⇒ 失败时页面**收不到任何回执** ⇒
	 * 用户看到的还是"未登录"，真实原因（浏览器被关 / 网关超时 / 账号被拒）只落在 IDE 日志里
	 *   ⇒ 页面只能干等超时兜底（"点了没反应"的高频形态）✗。
	 *
	 * ⚠ 只推**一句人话**（截断到 200 字符）：不含堆栈/路径/票据 ✓。
	 * ⚠ `signedIn` 仍取**当前真实登录态** ⇒ 失败不会把"已登录"说成"未登录" ✓（错误与状态是两件事）。
	 */
	public pushAuthError(error: string): void {
		const message = (error || '').trim().slice(0, 200);
		if (!message) {
			return;
		}
		for (const viewId of this._ownViews) {
			this._pushAuth(viewId, message);
		}
	}

	private _pushAuth(viewId: string, error?: string): void {
		const user = this._tofAuth.currentUser;
		const auth = {
			signedIn: !!user,
			loginName: user?.login_name ?? '',
			staffId: user?.staff_id ?? '',
			team: user?.team ?? '',
			// 失败原因：有才带（推送载荷是逐字段白名单 ⇒ 这里不给，页面就永远看不到失败 ✗）
			...(error ? { error } : {}),
		};
		void this._channel.call(DshHarnessChannelCommand.PushAuth, { viewId, auth })
			.catch(e => this._logService.warn(`[dshHarness] auth push skipped: ${String((e as Error)?.message ?? e)}`));
	}

	private _pushWorkspacesToAll(): void {
		for (const viewId of this._ownViews) {
			this._pushWorkspaces(viewId);
		}
	}

	layoutView(viewId: string, bounds: IDshViewBounds): Promise<void> {
		return this._channel.call(DshHarnessChannelCommand.LayoutView, { viewId, bounds });
	}

	setViewVisible(viewId: string, visible: boolean, focus?: boolean): Promise<void> {
		return this._channel.call(DshHarnessChannelCommand.SetViewVisible, { viewId, visible, focus });
	}

	freezeView(viewId: string): Promise<string | undefined> {
		return this._channel.call<string | undefined>(DshHarnessChannelCommand.FreezeView, { viewId });
	}

	reloadView(viewId: string): Promise<void> {
		return this._channel.call(DshHarnessChannelCommand.ReloadView, { viewId });
	}

	async rebindSession(viewId: string, sessionId: string): Promise<void> {
		await this._channel.call(DshHarnessChannelCommand.RebindSession, { viewId, sessionId });
		// 换绑成功 ⇒ 这个页签现在显示的就是 sessionId（记账口径与 createView 一致）。
		const chatId = DshHarnessService._chatIdOf(viewId);
		if (chatId) {
			this._chatSession.set(chatId, sessionId);
		}
	}

	/** chatId → 当前绑定的 dsh 会话（createView / rebindSession 成功时写入，dispose 时清）。 */
	private readonly _chatSession = new Map<string, string>();

	/**
	 * **已预占**（"马上就绑"）的 dsh 会话 —— 见 `reserveChatSession` 的注释。
	 *
	 * 只参与"这条会话能不能被别的页签复用"的判断（`boundChatSessionIds`）✓。
	 */
	private readonly _reservedChatSessions = new Set<string>();

	/** `dsh-chat-w<win>-<chatId>` → chatId（与本文件 `_viewBaseFor` 的拼法一一对应）。 */
	private static _chatIdOf(viewId: string): string | undefined {
		const m = /^dsh-chat-w\d+-(.+)$/.exec(viewId);
		return m ? m[1] : undefined;
	}

	findChatIdForSession(sessionId: string): string | undefined {
		for (const [chatId, sid] of this._chatSession) {
			if (sid === sessionId) {
				return chatId;
			}
		}
		return undefined;
	}

	boundChatSessionIds(): Set<string> {
		// 已绑定的 + **已预占**的（预占见 `reserveChatSession`）⇒ 并排开两个聊天时，
		// 第二个不会抢到第一个正在占用的那条会话 ✓。
		return new Set([...this._chatSession.values(), ...this._reservedChatSessions]);
	}

	/**
	 * **预占**一条 dsh 会话（"我马上就绑它"）。
	 *
	 * 为什么需要（2026-10-21，中间栏并排多聊天）：新页签会**复用孤儿空白会话**
	 * （`pickReusableBlankSession`），而"复用"这件事在**并发**下会撞车 ——
	 * 两个聊天几乎同时打开时，第一个还没走完 `createView`（记账在 `.then()` 里），
	 * 第二个已经把同一条空白会话挑走了 ⇒ 两个视图绑**同一** dsh 会话 ⇒
	 * 要么 Host 报"会话已被占用"，要么两个页面显示同一段对话（用户以为开了两个，其实是同一个）✗✗。
	 *
	 * ⇒ 决定 sessionId 后**立刻**预占 ⇒ 另一个聊天在挑空白会话时就能排除它 ✓。
	 *
	 * 只影响"能不能被复用"，不改 `_chatSession`（那里记的是"确实已打开"）✓。
	 */
	reserveChatSession(sessionId: string): void {
		if (sessionId) {
			this._reservedChatSessions.add(sessionId);
		}
	}

	renameSession(viewId: string, title: string): Promise<void> {
		return this._channel.call(DshHarnessChannelCommand.RenameSession, { viewId, title });
	}

	disposeView(viewId: string): Promise<void> {
		this._ownViews.delete(viewId);
		if (this._activeChatViewId === viewId) {
			this._activeChatViewId = undefined;
		}
		// 页签销毁 ⇒ 记账一起清（否则"已打开"会指向一个不存在的页签 ⇒ 用户点了没反应 ✗）。
		const chatId = DshHarnessService._chatIdOf(viewId);
		const bound = chatId ? this._chatSession.get(chatId) : undefined;
		if (chatId && bound) {
			this._chatSession.delete(chatId);
			// 预占也一并释放：否则这条会话永远不会被别的页签复用（每次新开页签都多一条空白会话 ✗）。
			this._reservedChatSessions.delete(bound);
		}
		return this._channel.call(DshHarnessChannelCommand.DisposeView, { viewId });
	}

	private _activeChatViewId: string | undefined;
	get activeChatViewId(): string | undefined {
		return this._activeChatViewId;
	}

	dispatchPageCommand(viewId: string, command: Exclude<DshPageCommand, { method: 'ping' }>): boolean {
		if (!this._ownViews.has(viewId)) {
			return false;
		}
		this._onDidPageEvent.fire({ viewId, kind: 'command', command });
		return true;
	}

	private readonly _chatViewAllocator = new DshChatViewAllocator();

	claimChatViewId(base: string, token: object): string {
		return this._chatViewAllocator.claim(base, token);
	}

	releaseChatViews(token: object): void {
		for (const viewId of this._chatViewAllocator.release(token)) {
			void this.disposeView(viewId);
		}
	}

	noteActiveChatView(viewId: string, token: object): void {
		if (this._ownViews.has(viewId)) {
			this._activeChatViewId = viewId;
			this._chatViewAllocator.notePresent(viewId, token);
		}
	}

	noteChatViewPresent(viewId: string, token: object): void {
		if (this._ownViews.has(viewId)) {
			this._chatViewAllocator.notePresent(viewId, token);
		}
	}

	clearActiveChatView(viewId: string, token: object): void {
		if (this._activeChatViewId === viewId) {
			this._activeChatViewId = undefined;
		}
		this._chatViewAllocator.clearPresent(viewId, token);
	}

	insertReference(viewId: string, reference: IDshInsertReference): Promise<void> {
		return this._channel.call(DshHarnessChannelCommand.InsertReference, { viewId, reference });
	}

	syncProviders(args: IBridgeProvidersSyncArgs): Promise<IBridgeProvidersSyncResult> {
		return this._channel.call(DshHarnessChannelCommand.ProvidersSync, args);
	}

	/**
	 * 把企业身份（TOF/OA 票据）同步到 dsh 侧（2026-10-21）。
	 *
	 * ⚠ **三态**（把"没取到票"当成"已登出"会把对端那份凭据误删 ⇒ 用户在 dsh 侧突然掉登录 ✗）：
	 *  ① 已登录 **且** 拿到票 ⇒ 同步这张票；
	 *  ② 已登录但**票没取到**（启动恢复路径：`currentUser` 有、`currentTicket` 空）⇒ **不动 dsh 侧**
	 *     （宁可让旧票留着，也不能在对端把凭据清了）；
	 *  ③ 明确**登出**（`currentUser` 为 null）⇒ 才下发"清掉"。
	 */
	async syncTofIdentity(): Promise<IBridgeTofSyncResult> {
		const user = this._tofAuth.currentUser;
		const ticket = this._tofAuth.currentTicket;
		if (user && !ticket) {
			this._logService.info('[dshHarness] 企业身份同步：已登录但票据未就位 ⇒ 本次不动 dsh 侧（不误清凭据）');
			return { signedIn: true, ref: DSH_TOF_CREDENTIAL_REF, changed: false };
		}
		return this._channel.call(DshHarnessChannelCommand.TofSync, { ticket: ticket ?? null });
	}

	/**
	 * 静默同步（失败不抛）：登录态变化 / 桥就绪时都会调。
	 *
	 * 为什么静默：dsh 侧没装伴生插件 / Host 还没起来 ⇒ 这条能力**暂时不可用**（可降级），
	 * 不该让 TOF 登录本身因此失败（登录成功的判据是 IDE 侧拿到票据，不是 dsh 收到票）✓。
	 */
	private async _syncTofIdentityQuietly(reason: string): Promise<void> {
		try {
			const r = await this.syncTofIdentity();
			this._logService.info(`[dshHarness] 企业身份同步（${reason}）：dsh 侧 signedIn=${r.signedIn} changed=${r.changed}`);
		} catch (e) {
			this._logService.info(`[dshHarness] 企业身份同步（${reason}）跳过：${String((e as Error)?.message ?? e)}`);
		}
	}

	resetWindow(windowId: number): Promise<void> {
		// keep = 本 renderer 自己建的视图（`_ownViews`）：回收目标是**上一个** renderer 的孤儿视图。
		// 不带 keep 会把当前视图一起销毁（Host 抢先启动 ⇒ 聊天视图在工作台启动早期就建好了，
		// 而这条命令在工作台 Eventually 相位才跑 ⇒ 用户看到"聊天框一闪就没了"）。
		return this._channel.call(DshHarnessChannelCommand.ResetWindow, { windowId, keep: [...this._ownViews] });
	}

	listViews(): Promise<IDshViewInfo[]> {
		return this._channel.call(DshHarnessChannelCommand.ListViews);
	}
}
