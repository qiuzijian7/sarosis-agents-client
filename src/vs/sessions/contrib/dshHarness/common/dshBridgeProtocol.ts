/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 控制桥协议：VsSaros 主进程（客户端）↔ `@vssaros/dsh-bridge`（Host 内，监听命名管道）。
 * 传输：换行分隔的 JSON-RPC 2.0。两端都由 VsSaros 发布，只传 VsSaros 自定义的命令与数据，
 * 不搬运 dsh 的事件或数据结构（方案第 13.1 节）。服务端实现见 `dsh-plugins/vssaros-bridge/lib/index.js`。
 */

import { VSSAROS_IDE_CAPABILITIES, VssarosIdeCapability } from './vssarosPluginManifest.js';

/**
 * v2（2026-10-10）：新增**反向通道**（Host → IDE），这是 `@vssaros/dsh-ide` 那个模块的前提
 * （方案 6.7："执行经控制桥 `ide.request` 回调 VsSaros"）——此前两端都不支持该方向。
 *
 * 约定：Host 发起的请求用**负数 id**（IDE 自己的序号是正整数，天然不相交）；IDE 侧回
 * `{ id: <负数>, result | error }`（无 `method`）；参数里带 `token` 供 IDE 核验。
 * Host 侧实现见 `dsh-plugins/vssaros-bridge/lib/index.js` 的 `callIDE`；
 * IDE 侧分发器见 `dshBridgeClient.ts` 的 `setReverseRequestHandler`（默认拒绝 + 内建 `ide.echo` 自检）。
 */
export const DSH_BRIDGE_VERSION = 2;

export const enum DshBridgeMethod {
	ClientRegister = 'client.register',
	HostPing = 'host.ping',
	WorkspaceEnsure = 'workspace.ensure',
	WorkspaceList = 'workspace.list',
	/**
	 * **运行期工作区上下文**（2026-10-17）：IDE 切工作区时推一份新的 ⇒ 看板 / 记忆 / 图谱不必重启 Host
	 * 就能跟着走（起因：切换工作区要重启 Host，而重启会连在跑的会话一起杀掉）。
	 * 真源与三条纪律见 `dsh-plugins/vssaros-foundation/lib/workspaceContext.js`；消费方的解析优先级见
	 * 各自的解析函数注释（`workspaceIdOf` / `partitionOf` / `workspaceRootOf`）。
	 *
	 * ⚠ 老 Host（桥里没有这条）会回 `-32601 method not found` ⇒ 调用方**必须**把它当成"这条能力不存在"，
	 *   退回旧的重启路径 ✓（升级那一次仍会重启，之后就再也不用了 ✓）。
	 * 刻意**不** bump `DSH_BRIDGE_VERSION`：那个常量只是文档口径，能不能用由**这条调用本身**证 ✓。
	 */
	WorkspaceContext = 'workspace.context',
	/** 升级 / 退出闸门：返回仍有活动的会话 id 与活动类别（IHostActivity）。 */
	HostActivity = 'host.activity',
	/** 建/接管一个会话并绑定工作区（方案第 7 章 session.start）：传 sessionId 时为幂等接管。 */
	SessionStart = 'session.start',
	/** 后台回合（重构 1.4）：投一条 prompt 并**等回合跑完回传结果**（渠道/看板/工作流/调度/Pocket 的统一入口）。 */
	SessionRun = 'session.run',
	/** 取消一条会话当前的活动（尽力而为；按 agent.cancel 语义默认清收件箱）。 */
	SessionCancel = 'session.cancel',
	/** 同步 VsSaros 已配置的模型 provider（写 llm-pi-ai settings + 凭证；插件侧只动 vssaros- 前缀路由）。 */
	ProvidersSync = 'providers.sync',
	/**
	 * **同步企业身份（TOF/OA 票据）到 dsh 侧**（2026-10-21）。
	 *
	 * 需求（用户原话）："不要用 dsh 官方 DeepSeek 路由，需求是在两侧用 TOF/OA 企业身份（工号 + 票据）实现登录"。
	 * ⇒ dsh 侧不另起一套账号（DeepSeek 账号那套我们不用），而是**持有同一份企业身份**。
	 *
	 * 为什么是 IDE 侧发起、而不是 dsh 侧自己登录：
	 *  · TOF 的 OAuth 是 **passport.woa.com → 网关 `/api/v1/auth/tof/callback?cb_port=` → 本地 loopback**，
	 *    协议由**网关**定（客户端可 1:1 复用，但回调端口必须由客户端起）；
	 *  · dsh 侧**没有**"打开外部 URL"的服务（无 openExternal/openUrl，全 305 个包都没有），
	 *    而**扩展开浏览器**是现成的（`extensions/tof-authentication`：`env.openExternal` + loopback server）；
	 *  · 网关是**明文 HTTP**（`http://21.169.46.116:8080`）⇒ 页面侧会被 Mixed Content 拦，只能在 Node 侧做。
	 * ⇒ **一次浏览器登录，IDE 侧拿到票据，再经这条桥同步给 dsh** ⇒ 两侧同一份身份，不重复登录 ✓。
	 *
	 * ⚠ **安全边界（重要）**：票据从 VS Code 的 SecretStorage（加密）**落到 dsh 的 `.credentials.yaml`（明文）**。
	 *   dsh 侧 `dsh-credentials-local` 的自述限制："同 UID 的 agent 工具进程能读到这个文件"（无 OS keychain）。
	 *   这是**扩大了暴露面**（之前票据只在 SecretStorage 里）⇒ 必须在两侧都写明，并保证：
	 *   ① 票据**绝不下发到页面**（页面只拿展示投影，见 `DSH_PAGE_IPC_AUTH`）；
	 *   ② 票据只经**本机命名管道**（IDE ⇄ Host，同机同信任域）过，不出网。
	 */
	TofSync = 'tof.sync',
	/**
	 * 企业身份由 **dsh 侧持有**（2026-10-22，用户："登录也转移到 dsh 侧实现，ide 侧仅读取状态"）。
	 * `tof.status`：状态投影 {@link IBridgeTofStatus}（**没有票据**）；Host 认它 ⇒ IDE 的 TofAuthService 切成只读镜像。
	 */
	TofStatus = 'tof.status',
	/** 在 dsh 侧开系统浏览器登录（最长 ~3 分钟，回执等登录完成）。回执 = 身份投影（没有票据）。 */
	TofSignIn = 'tof.signin',
	/** 用户主动登出（两份票都清 + 记"主动登出过" ⇒ IDE 不再把旧扩展里的票迁回来）。 */
	TofSignOut = 'tof.signout',
	/** 取当前有效票据 {@link IBridgeTofTicketResult}（商城 JWT 兑换要它）。⚠ 只经本机命名管道，绝不进页面。 */
	TofTicket = 'tof.ticket',
	/**
	 * dsh 侧 CodeBuddy 登录态（2026-10-22）：CodeBuddy 的登录 / 刷新 / 目录 / 路由都已搬到 Host
	 * （`dsh-plugins/vssaros-bridge/lib/codebuddy.js`）。回执是 {@link IBridgeCodeBuddyStatus}（**不含 token**）。
	 */
	CodeBuddyStatus = 'codebuddy.status',
	/**
	 * 把 IDE 扩展里的 CodeBuddy 登录态**一次性**迁到 dsh 侧（过渡期；dsh 侧已登录时不覆盖）。
	 * 负载 {@link IBridgeCodeBuddyImportArgs}：token 只经本机命名管道，落 dsh 凭据存储。
	 */
	CodeBuddyImport = 'codebuddy.import',
	/**
	 * dsh 侧 LightAI 登录态（2026-10-22）：登录 / 模型清单 / 配置都在 Host（`vssaros-bridge/lib/lightai.js`，
	 * 登录经浏览器插件开页面、读会话 cookie）。回执 {@link IBridgeLightAIStatus}（**无 cookie 值**）。
	 */
	LightAIStatus = 'lightai.status',
	/** 把 IDE 扩展 settings 里的 LightAI cookie **一次性**迁到 dsh 侧（负载 {@link IBridgeLightAIImportArgs}）。 */
	LightAIImport = 'lightai.import',
	/**
	 * 积分样本入账（2026-10-20）：主进程计费代理抓到一条推一条（{@link IBridgeCreditRecordArgs}）。
	 * Host 侧按 LLM 调用区间归属到 (会话, 回合)，写进会话日志（插件记录 `plugin:vssaros/credit`），
	 * 再由投影 `vssaros-credit` 推给页面 —— 取代"广播给所有聊天页、页面按时间窗猜"的旧链路。
	 */
	CreditRecord = 'credit.record',
	/**
	 * **反向通道自检**（协议 v2）：IDE 调它 → 桥反向调 `ide.echo` → 把 IDE 的返回**原样**回传。
	 * 用途：反向通道一旦接通，一条调用即可验收；能力工具接入前也能单独验通道。
	 */
	IdeRoundtrip = 'ide.roundtrip',
	/**
	 * **`ide.request` 自检**：IDE 调它 → 桥反向请求指定 capability → 把结果（或拒绝原因）回传。
	 * 让"授权 + 执行"这条链在模块尚未落地时也能被验收，此后长期充当健康检查。
	 */
	IdeProbe = 'ide.probe',
	// ─── 插件商城（方案 5.16，只读面；写入面在批次 3/4）───────────────────────
	/** 组合包清单（官方随附 + 已安装 + 每包的行）：`pluginManager.listBundles` 的整形视图。 */
	BundlesList = 'plugins.bundles.list',
	/** 运行中的插件行（entryId / patchId / 阶段 / 只读原因）：`pluginManager.listPlugins` 的整形视图。 */
	PluginsList = 'plugins.plugins.list',
	/** 安装源：配置源 + 镜像 + pnpm 自身解析到的源（`pluginManager.registries`）。 */
	PluginRegistries = 'plugins.registries',
	/** 运行态摘要（`pluginInventory.list` 只取计数与预设数，避免 187 条全量过桥）。 */
	PluginInventory = 'plugins.inventory',
	// ─── 插件商城（方案 5.16 批次 3，写入面）：启停走 Host，VsSaros 不再自己写 profile 文件 ──
	/** 组合包启停（`{ name, enabled }` → `pluginManager.setBundleEnabled`：改 `dsh.profile.bundles`）。 */
	BundleSetEnabled = 'plugins.bundle.setEnabled',
	/** 行启停（`{ entryId, enabled }` → `pluginManager.setPluginEnabled`：写 `cordis.patch.yml` 覆盖项）。 */
	PluginRowSetEnabled = 'plugins.plugin.setEnabled',
	// ─── 插件商城（方案 5.16 批次 4，安装面）：安装/卸载只在 Host 运行时可用（无文件兜底）──
	/**
	 * 安装前读一个 spec 指向什么（`{ spec }` → `pluginManager.inspect`）：
	 * 注册表名、绝对路径、git 地址、tarball 四种形态，返回接受的元数据或**拒绝原因**。
	 */
	BundleInspect = 'plugins.bundle.inspect',
	/**
	 * 安装一个组合包（`{ spec, requestId, approvedBuilds? }` → `pluginManager.installBundle`）。
	 * 必须带 `requestId`：它既是取消的凭据，也是 Host 侧 `install-state` 进度的关联键。
	 */
	BundleInstall = 'plugins.bundle.install',
	/** 取消一次进行中的安装（`{ requestId }` → `pluginManager.cancelInstall`）。 */
	BundleInstallCancel = 'plugins.bundle.install.cancel',
	/** 卸载一个 profile 持有的组合包（`{ name }` → `pluginManager.removeBundle`）。 */
	BundleRemove = 'plugins.bundle.remove',
	/**
	 * **向用户要一次确认**（客户端→Host）：交给 Host 侧的审批服务（`ctx.get('approval')`），
	 * 卡片由 `dsh-client-ui-approval` 渲染 —— 与 Host 侧能力（如 browser 族）用的是**同一张**卡。
	 *
	 * 用途：让**留在 IDE 侧**的动作类能力（目前只有 canvas）不再各自弹通知，而与 dsh 侧统一到
	 * "聊天内 ask"（README 4.76 的决定）。Host 侧没有审批通道时按 **fail-closed** 处理（返回不允许），
	 * 与 `dsh-plugins/vssaros-browser` 的纪律一致。
	 *
	 * 入参/结果形状见 `IBridgeApprovalRequestArgs` / `IBridgeApprovalRequestResult`。
	 */
	ApprovalRequest = 'approval.request',
}

export const enum DshBridgeErrorCode {
	ParseError = -32700,
	MethodNotFound = -32601,
	Internal = -32000,
	NotRegistered = -32001,
	BadToken = -32002,
	Unavailable = -32003,
}

// ─── 反向通道（Host → IDE，协议 v2）──────────────────────────────────────────

/**
 * Host 发起的反向方法（IDE 侧分发器要处理的名字）。
 *
 * 与 IDE → Host 方向的区别：这些方法的请求方是 **Host**，id 为**负数**，params 带 `token`。
 */
export const enum DshBridgeReverseMethod {
	/** 自检回显：IDE 原样回显入参（`ide.roundtrip` 的对面，不涉及任何 IDE 能力/授权）。 */
	IdeEcho = 'ide.echo',
	/** 请求一项 IDE 能力：`capability` 必须在该插件清单的 `vssaros.ideCapabilities` 里声明过。 */
	IdeRequest = 'ide.request',
	/**
	 * 计费代理路由登记（2026-10-22）：dsh 侧自持的 provider（CodeBuddy）要让请求经过主进程的计费代理
	 * （积分 chip 的数据源）⇒ Host 发 `{ route, baseURL }`，**主进程**登记"路由 → 真实网关"并回代理地址
	 * {@link IBridgeCreditRouteResult}。由主进程直接应答（不下发渲染进程、不过 IDE 能力闸）。
	 */
	CreditRoute = 'credit.route',
	/**
	 * 企业身份变了（2026-10-22）：Host 在登录成功 / 登出后通知（**不带票据**）。主进程就地应答，
	 * 并转给渲染进程（`DshHarnessChannelEvent.OnDidChangeTof`）⇒ TofAuthService 立刻重读，不必轮询。
	 */
	TofChanged = 'tof.changed',
}

// ─── 插件商城（方案 5.16，只读面）：桥侧整形后的视图，UI 直接用 ─────────────────

/** 组合包声明的一行（`BundleInfo.rows` 的整形视图）。 */
/** `approval.request` 的入参（Host 侧**原样**转调审批缝 `approval.request`）。 */
export interface IBridgeApprovalRequestArgs {
	/** 工具名（审批卡上显示"是谁在要"；留在 IDE 侧的动作类能力用能力名，如 `canvas`）。 */
	readonly toolName: string;
	/** 给日志/模型看的原因。 */
	readonly reason: string;
	/** 给用户看的双语原因（审批卡正文）。 */
	readonly displayReason?: { readonly en?: string; readonly zh?: string };
}

/** `approval.request` 的结果；宿主没有审批通道时 `allowed` 为 `false`（**fail-closed**）。 */
export interface IBridgeApprovalRequestResult {
	readonly allowed: boolean;
	/** 审批服务的原样结果（诊断用：`allowed-once` / 拒绝值 / `no-approval-channel`）。 */
	readonly outcome?: string;
	readonly reason?: string;
}

export interface IBridgeBundleRow {
	/** profile patch 里的行 id（`setPluginEnabled` 写覆盖项用它）。 */
	readonly rowId: string;
	/** 行指向的模块名。 */
	readonly moduleName: string;
	/** 存活条目的 entryId（行级启停的**匹配键**；`include:<rowId>` 形态）。 */
	readonly entryId?: string;
}

/** 一个组合包（官方随附 / 已安装 / 安装提供）。 */
export interface IBridgeBundleInfo {
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	/** 已在 profile 的 `dsh.profile.bundles` 里被选中（**不代表加载成功**）。 */
	readonly enabled: boolean;
	/** profile 自己的依赖持有它；false = 由 dsh 安装随附（官方可选组合包）。 */
	readonly installed: boolean;
	/** 安装随附、供开启、不可卸载（官方随附组合包）。 */
	readonly optional: boolean;
	readonly removable: boolean;
	/** 只读原因（`management-required` = 管理器自身依赖 / `unaddressable`）。 */
	readonly readOnlyReason?: string;
	/** 加载/管理错误码（`undefined` = 无）。 */
	readonly error?: string;
	readonly rows: readonly IBridgeBundleRow[];
}

/** 运行中的插件行。 */
export interface IBridgePluginRow {
	/** 存活条目 id（行级启停的匹配键）。 */
	readonly entryId: string;
	/** profile patch 行 id（写覆盖项用）。 */
	readonly patchId?: string;
	readonly moduleName?: string;
	readonly enabled?: boolean;
	/** Loader fiber 阶段（pending/loading/active/failed…）。 */
	readonly phase?: string;
	readonly readOnlyReason?: string;
}

/** 安装源。 */
export interface IBridgePluginRegistries {
	/** 配置的首选源；`null` = 用 pnpm 自身配置的那个。 */
	readonly registry: string | null;
	readonly fallbackRegistries: readonly string[];
	/** pnpm 自身配置解析到的源（读不到时 null）。 */
	readonly resolved: string | null;
}

/** 运行态摘要（`pluginInventory.list` 的浓缩视图）。 */
export interface IBridgePluginInventory {
	readonly entries: number;
	readonly enabledEntries: number;
	readonly agentPresets: number;
	readonly managementAvailable: boolean;
}

/**
 * 一次启停操作的结果（`ChangeResult` 的整形视图）。
 *
 * `application` 是界面话术的真源：
 * - `applied`：HMR 生效，已热重载；
 * - `restart-required`：改动已保存，需重启 Host 才生效；
 * - `overridden`：被更高层的 patch 覆盖（界面要说明原因）；
 * - `failed`：未生效，`error` 是原因码；`cancelled` 只在带 requestId 的安装里出现。
 */
export interface IBridgePluginChangeResult {
	readonly changed: boolean;
	readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled' | null;
	readonly stage: string | null;
	readonly target: string;
	/** 管理错误码（`unknown-plugin` / `management-required` / `not-bundle` …）。 */
	readonly error?: string;
	/**
	 * 宿主给的**原始诊断**（`error.diagnostic`）：`operation-error` 这类"非预期异常"只有它说得出原因。
	 * 桥侧截断到 400 字符后转出。
	 */
	readonly diagnostic?: string;
	readonly warnings?: readonly string[];
}

/** 组合包启停的入参。 */
export interface IBridgeBundleToggleArgs {
	readonly name: string;
	readonly enabled: boolean;
}

// ─── 插件商城（方案 5.16 批次 4，安装面）──────────────────────────────────────

/**
 * 一个安装 spec 的预检结果（`PluginSpecInspection` 的整形视图）。
 *
 * 两种形态靠 `status` 区分：`accepted` 时给出可显示的元数据（`bundle === false` 表示
 * 「装得上但不是组合包」——装它没有意义，界面要挡住）；`refused` 时 `problem` 是机读原因码，
 * `reason` 是给人看的一句话。
 */
export interface IBridgeInspectResult {
	readonly status: 'accepted' | 'refused';
	/** spec 形态（`registry` / `path` / `git` / `tarball`）。 */
	readonly kind?: string;
	readonly name?: string;
	readonly version?: string;
	readonly description?: string;
	/** 该包是否声明了组合包 patch；`null` = 这种 spec 形态此刻读不出来（git/tarball 要装了才知道）。 */
	readonly bundle?: boolean | null;
	/** 首个被问的源；`null` = pnpm 自身配置的那个。 */
	readonly registry?: string | null;
	/** git/tarball 的抓取主机（注册表替代不了它，失败时界面要说明）。 */
	readonly host?: string;
	/** 拒绝原因码（`invalid-spec` / `not-a-package` / `not-a-bundle` / `not-found` / `network`…）。 */
	readonly problem?: string;
	/** 拒绝原因（pnpm / 注册表 / 文件系统原话）。 */
	readonly reason?: string;
	/** 拒绝时依次问过的源（最后一个是 `reason` 的出处）。 */
	readonly registries?: readonly (string | null)[];
}

/** 一次安装/卸载的结果（`ChangeResult` 的整形视图，启停结果 + 安装诊断）。 */
export interface IBridgeInstallResult extends IBridgePluginChangeResult {
	/** 安装成功后它声明的组合包名（`stage: 'install'` 时才有）。 */
	readonly bundle?: string;
	/** pnpm 退出码（`null` = 没拿到退出码）。 */
	readonly exitCode?: number | null;
	/** 失败类别（`pnpm-missing` / `timeout` / `not-found` / `network` / `disk-full`…）。 */
	readonly failureKind?: string;
	readonly timedOut?: boolean;
	/** 等待显式允许构建脚本的包（pnpm 10 默认拦；带 `approvedBuilds` 重试即可）。 */
	readonly pendingBuilds?: readonly string[];
	/** 本次依次问过的源。 */
	readonly registries?: readonly (string | null)[];
	/** pnpm 全量诊断的落盘路径（失败时给用户看的"日志在哪"）。 */
	readonly logPath?: string;
}

/** 安装请求的入参。 */
export interface IBridgeInstallArgs {
	/** 一个包 spec：注册表名、**绝对**路径、git 地址或 tarball URL。 */
	readonly spec: string;
	/** 调用方生成的请求 id：取消要用它，Host 侧进度也按它关联（**必填**）。 */
	readonly requestId: string;
	/** 显式允许这些待批准包的构建脚本后再装（不是待批准的名字会被 Host 拒）。 */
	readonly approvedBuilds?: readonly string[];
}

/** 卸载入参（组合包名）。 */
export interface IBridgeRemoveArgs {
	readonly name: string;
}

/** 取消入参。 */
export interface IBridgeInstallCancelArgs {
	readonly requestId: string;
}

/** 取消的结果：`cancelled` 已停且文件已还原 / `too-late` 已在应用 / `not-running` 没有这个 id。 */
export interface IBridgeInstallCancelResult {
	readonly status: 'cancelled' | 'too-late' | 'not-running';
}

/** spec 的字符白名单：包名、路径、git/tarball URL 都过它（跨进程边界收紧，禁引号/换行/管道）。 */
const SPEC_RE = /^[^\s"'`|;&<>]+$/;

/** 请求 id 的白名单（自己生成，形态受控：`vssaros-<uuid>` 一类）。 */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export function validateBundleInspectArgs(value: unknown): value is { readonly spec: string } {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as { spec?: unknown };
	return typeof v.spec === 'string' && v.spec.trim().length > 0 && v.spec.length <= 1024 && SPEC_RE.test(v.spec.trim());
}

export function validateBundleInstallArgs(value: unknown): value is IBridgeInstallArgs {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as { spec?: unknown; requestId?: unknown; approvedBuilds?: unknown };
	if (typeof v.spec !== 'string' || v.spec.trim().length === 0 || v.spec.length > 1024 || !SPEC_RE.test(v.spec.trim())) { return false; }
	if (typeof v.requestId !== 'string' || !REQUEST_ID_RE.test(v.requestId)) { return false; }
	if (v.approvedBuilds === undefined) { return true; }
	return Array.isArray(v.approvedBuilds)
		&& v.approvedBuilds.length <= 32
		&& v.approvedBuilds.every(b => typeof b === 'string' && ID_RE.test(b));
}

export function validateBundleRemoveArgs(value: unknown): value is IBridgeRemoveArgs {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as { name?: unknown };
	return typeof v.name === 'string' && v.name.trim().length > 0 && v.name.length <= 512 && ID_RE.test(v.name.trim());
}

export function validateInstallCancelArgs(value: unknown): value is IBridgeInstallCancelArgs {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as { requestId?: unknown };
	return typeof v.requestId === 'string' && REQUEST_ID_RE.test(v.requestId);
}

/** 行启停的入参（`entryId` = `listPlugins` 报的条目 id，形如 `include:<rowId>`）。 */
export interface IBridgePluginRowToggleArgs {
	readonly entryId: string;
	readonly enabled: boolean;
}

/**
 * 包名/条目 id 的字符白名单（跨进程边界收紧；两类 id 都允许 `@scope/name`、`include:a-b.c_d`）。
 *
 * ⚠ **匹配前不 trim**：这两个都是**机器 id**（来自 `listPlugins` 的回报），不是用户随手粘的输入。
 * 若先 trim 再匹配，`' include:x'` 会被判成合法，而消费方按**原值**查表必然查不到——"通过了校验
 * 却什么也没做"是最难查的一类失败。要宽容的是用户输入（见 `validateInstallBundleArgs` 的 spec），
 * 不是 id。（单测 `dshPluginToggle.test.ts` 钉着这条：`' include:x'` 必须被拒。）
 */
const ID_RE = /^[@a-zA-Z0-9][@a-zA-Z0-9._/:-]*$/;

export function validateBundleToggleArgs(value: unknown): value is IBridgeBundleToggleArgs {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as { name?: unknown; enabled?: unknown };
	// 同上：包名也是机器 id，精确匹配（`' @vssaros/x'` 这种必须被拒，否则消费方查不到 ⇒ 静默不生效）。
	return typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 512 && ID_RE.test(v.name) && typeof v.enabled === 'boolean';
}

export function validatePluginRowToggleArgs(value: unknown): value is IBridgePluginRowToggleArgs {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as { entryId?: unknown; enabled?: unknown };
	return typeof v.entryId === 'string' && v.entryId.length > 0 && v.entryId.length <= 512 && ID_RE.test(v.entryId) && typeof v.enabled === 'boolean';
}

/** `ide.request` 的入参。 */
export interface IBridgeIdeRequestParams {
	/** 能力名——与清单 `vssaros.ideCapabilities` 是**同一份白名单**（不做第二套命名）。 */
	readonly capability: VssarosIdeCapability;
	/** 调用方插件名：IDE 侧据此查"这个插件声明过这个能力吗"（**逐插件授权**，不是全局放行）。 */
	readonly pluginId?: string;
	/** 能力自己的入参（形状由 `capability` 决定）。 */
	readonly params?: Record<string, unknown>;
	/** 桥注入的核验令牌（IDE 侧**必须**校验；缺它一律拒）。 */
	readonly token?: string;
}

/** 反向请求在 IDE 侧被派发时的形状（分发器入参 / 事件载荷）。 */
export interface IBridgeReverseRequest {
	/** **负数** id（协议 v2 约定；与 IDE 自己的正数序号不相交）。 */
	readonly id: number;
	readonly method: string;
	readonly params: Record<string, unknown>;
}

/** 反向请求的处理器：返回值写回 `result`，抛出的错误写回 `error`。 */
export type BridgeReverseRequestHandler = (request: IBridgeReverseRequest) => Promise<unknown> | unknown;

/** 判断一个字符串是不是已登记的 IDE 能力名（分发器做**第一道**筛；逐插件授权由调用方补）。 */
export function isVssarosIdeCapability(value: unknown): value is VssarosIdeCapability {
	return typeof value === 'string' && (VSSAROS_IDE_CAPABILITIES as readonly string[]).includes(value);
}

export interface IClientRegisterParams {
	readonly token: string;
	readonly instanceId: string;
	/**
	 * 本次注册者**自己的**拥有者记录路径（`owner-<runId>.json`）。
	 *
	 * 用途：Host 侧的桥插件拿它做**孤儿自退**判据（记录 mtime = 宿主写的心跳；心跳停了又没有 IDE
	 * 客户端 ⇒ "宿主进程崩了而 Host 还在常驻" ⇒ 自退，把**会话写租约**还给系统 —— 写租约是
	 * `session.lock` 的 OS 文件锁，只有关句柄或退进程才释放 ✓）。
	 *
	 * ⚠ 必须**随每次注册**给，不能只在 spawn 时经环境变量给一次 ✗：同一个 Host 会被后续窗口
	 * **接管**（`host.json` 复用）⇒ "当前拥有者"已经换人，只有握手能表达"现在是谁" ✓。
	 * 接管路给的是**接管者新写的那份**；非 VsSaros 托管的 Host 没有记录 ⇒ 不传（插件保持原目标）✓。
	 */
	readonly ownerRecord?: string;
	readonly windows?: readonly { readonly id: number; readonly workspace?: string }[];
}

/** `client.register` 的结果（即 bridge.hello）。 */
export interface IBridgeHello {
	readonly bridgeVersion: number;
	readonly pluginVersion: string;
	readonly node: string;
	readonly pid: number;
	readonly host: {
		readonly port: number;
		readonly bind: string;
		readonly origin: string;
		readonly authUrl: string;
	};
}

export interface IBridgeWorkspace {
	readonly id?: string;
	readonly path: string;
	readonly title?: string;
	readonly sessions?: number;
	readonly error?: string;
}

/** 上下文里一个路径/标识串的长度上限（跨进程边界收紧；与 `MAX_PATHS_PER_WINDOW` 同一条纪律 ✓）。 */
const MAX_WORKSPACE_CONTEXT_TEXT = 4096;
/** 关联根条数上限（一个工作区不该有几百个根；畸形载荷在桥这一侧就被拒 ✓）。 */
const MAX_WORKSPACE_CONTEXT_ROOTS = 64;

/**
 * `workspace.context` 的入参 —— **当前**工作区上下文（运行期真源，见 `DshBridgeMethod.WorkspaceContext`）。
 *
 * ⚠ 三个字段是**一整份**：消费方以整份为准，不做逐字段回落（否则切到"没有关联根 / 没有活动工作区"的
 * 目标时会把**旧工作区的值留着** ✗ —— 那正是"卡片静默写进旧工作区"那类静默错的形状）。
 * `undefined` 在这里是**有意义的**（＝"当前没有"），所以校验只做形状与边界，不要求非空 ✓。
 */
export interface IBridgeWorkspaceContextArgs {
	/** Agent Studio 的当前工作区 id（看板按它过滤、记忆按它分区）。`undefined` = 当前没有活动工作区。 */
	readonly workspaceId?: string;
	/** 当前工作区根（代码图谱按它定位 `<root>/.codebase-memory/`）。`undefined` = 没有可用根。 */
	readonly workspaceRoot?: string;
	/** 关联根（多根工作区；`[]` = 权威的"没有关联根"）。 */
	readonly relatedRoots?: readonly string[];
	/** 推这份上下文的窗口 id（只作诊断：Host 是多窗口共享的，**最后推的胜出** ✓）。 */
	readonly windowId?: number;
	/** 推送时刻（只作诊断/排序 ✓）。 */
	readonly at?: number;
}

/** `workspace.context` 的回执。`applied: false` ⇒ 调用方应退回旧路径（重启），别当成功 ✓。 */
export interface IBridgeWorkspaceContextResult {
	/** 真源**是否真的被更新**（foundation 缺席 / 载荷畸形都会是 false ✓ —— 不谎报成功）。 */
	readonly applied: boolean;
	/** `applied: false` 的原因（`foundation-unavailable` / `invalid-payload`；诊断用 ✓）。 */
	readonly reason?: string;
	/** 生效后的上下文（规范化之后的那份；带异常时可能没有 ✓）。 */
	readonly context?: IBridgeWorkspaceContextArgs;
}

/** 上下文载荷的形状/边界校验（真源那一侧还会再规范化一次 —— 两道都要 ✓）。 */
export function validateWorkspaceContextArgs(value: unknown): value is IBridgeWorkspaceContextArgs {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const v = value as Record<string, unknown>;
	const textOk = (x: unknown): boolean => x === undefined
		|| (typeof x === 'string' && x.length <= MAX_WORKSPACE_CONTEXT_TEXT && !x.includes('\0'));
	if (!textOk(v.workspaceId) || !textOk(v.workspaceRoot)) {
		return false;
	}
	if (v.relatedRoots !== undefined) {
		if (!Array.isArray(v.relatedRoots) || v.relatedRoots.length > MAX_WORKSPACE_CONTEXT_ROOTS) {
			return false;
		}
		if (!v.relatedRoots.every(textOk)) {
			return false;
		}
	}
	if (v.windowId !== undefined && !Number.isInteger(v.windowId)) {
		return false;
	}
	return !(v.at !== undefined && !Number.isFinite(v.at));
}

/** `session.start` 入参：会话的工作目录、可选的自有 id（幂等接管）、可选预设与首条 prompt。 */
export interface IBridgeSessionStartArgs {
	readonly cwd: string;
	/** VsSaros 侧的稳定会话 id（如 `vssaros-<chatId>`）；重复调用即接管同一个会话。 */
	readonly sessionId?: string;
	readonly agentPreset?: string;
	readonly prompt?: string;
}

export interface IBridgeSessionStartResult {
	readonly sessionId: string;
	readonly workspaceId?: string;
	/** 传了 prompt 时为 true（已投递首条消息）。 */
	readonly prompted?: boolean;
	/** 会话实际运行的 preset（桥 ≥0.2.3 回传；方案 5.15 的基座 preset 习得依赖它）。 */
	readonly agentPreset?: string | null;
}

// ─── session.run / session.cancel（重构 1.4，后台回合统一入口）──────────────────

/** `session.run` 入参：工作目录、提示词、可选自有会话 id（重复调用即恢复续聊）、预设与超时。 */
export interface IBridgeSessionRunArgs {
	readonly cwd: string;
	readonly prompt: string;
	readonly sessionId?: string;
	readonly agentPreset?: string;
	/** 一回合的等待上限（毫秒）；缺省 120000。超时按错误回传（不静默挂起）。 */
	readonly timeoutMs?: number;
	/**
	 * 无人值守审批白名单（重构 1.5）：本会话本轮允许的工具名；缺省 = 全拒。
	 * 缺它时背景会话的任何审批请求都会被 runs 应答者拒掉（deny-by-default ✓）。
	 */
	readonly approval?: { readonly allow: readonly string[] };
}

export interface IBridgeSessionRunResult {
	readonly sessionId: string;
	readonly workspaceId?: string;
	readonly agentPreset?: string | null;
	/** 回合结束原因（turn/end 的 kind：completed / aborted / error / …）。 */
	readonly stopReason: string | null;
	/** 该回合最后一条非空 assistant 文本；没有则 null（被工具占满/被打断时是 null，调用方要如实说）。 */
	readonly finalText: string | null;
	/** 最终文本是否因中断而不完整。 */
	readonly interrupted: boolean;
	readonly elapsedMs: number;
}

export interface IBridgeSessionCancelArgs {
	readonly sessionId: string;
}

export interface IBridgeSessionCancelResult {
	readonly cancelled: boolean;
	readonly reason?: string;
}

// ─── providers.sync（模型 provider 接入，dsh 插件形式）─────────────────────────

/** 线协议：OpenAI 兼容 / OpenAI Responses / Anthropic Messages（对应 llm-pi-ai 的 `api` 字段）。 */
export type DshProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

/** 网关认的推理档位（= OpenAI `reasoning_effort` 的取值集合；也是桥侧声明的档位）。 */
export type DshReasoningEffort = 'low' | 'medium' | 'high';

export interface IBridgeProviderModel {
	readonly id: string;
	readonly name?: string;
	/** 具备推理/思考流（reasoning_content 分片上浮为 thinking 卡）；缺省 false。 */
	readonly reasoning?: boolean;
	/**
	 * **平台目录给的推荐档位**（`/v3/config` 的 `model.reasoning.effort`，如 hy3=high / m2.7=medium）。
	 *
	 * 用途只有一个：桥侧据此算出该路由的**路由级默认档位**（`profile.reasoning`）。
	 * 为什么必须是**路由级**：pi-ai 的模型级字段只有 `name/contextWindow/maxTokens/input/reasoningEfforts/compat`
	 * —— **没有模型级默认档位**；而 `reasoningInfo()` 的 `defaultEffort` 只来自 `profile.reasoning`。
	 * 因此若某个模型的推荐档位与路由级不同，只能以路由级为准（详见桥侧 `REASONING_EFFORTS` 与守卫注释）。
	 */
	readonly effort?: DshReasoningEffort;
}

/** 一个要接入 dsh 的 provider（路由名必须 `vssaros-` 前缀——插件侧只管理这个前缀，用户自加条目不动）。 */
export interface IBridgeProviderEntry {
	readonly route: string;
	readonly displayName: string;
	readonly api: DshProviderApi;
	readonly baseURL: string;
	/** 凭证引用名（`VSSAROS_<ROUTE>_KEY`），值经同批 `credentials` 推送；缺省 = 无 key 的本地端点。 */
	readonly credentialRef?: string;
	/** 额外的请求头（如 codebuddy 网关的 X-IDE-* 身份头）；不含 Authorization（凭证负责）。 */
	readonly headers?: Record<string, string>;
	readonly models: readonly IBridgeProviderModel[];
}

export interface IBridgeProvidersSyncArgs {
	readonly providers: readonly IBridgeProviderEntry[];
	/** 凭证写入（`ctx.credentials.set`）；只增/改，不删（路由消失后残留凭证无害）。 */
	readonly credentials: readonly { readonly ref: string; readonly value: string }[];
}

export interface IBridgeProvidersSyncResult {
	/** 本次我们管理的路由名。 */
	readonly routes: readonly string[];
	/** true = 内容无变化，未写 settings。 */
	readonly unchanged: boolean;
	/** 写入后当前在线的 vssaros- 路由（`ctx.llm.listProviders()` 快照，诊断用）。 */
	readonly providersOnline: readonly string[];
	/**
	 * 每条路由**写入后实际服务**的模型 id 清单（`ctx.llm.listModels(route)`；值为 `ERR …` 字符串表示该路由列出了错）。
	 *
	 * 为什么必须有：只回路由名时，"路由在线但模型为空/被丢"在日志里完全看不见——实测
	 * 「codebuddy 同步看起来成功，但选择器里条数对不上」只能靠猜。有了它，日志一眼能分出
	 * "我们没推这么多"与"dsh 侧只剩这么多"。
	 */
	readonly modelsOnline?: Readonly<Record<string, readonly string[] | string>>;
	/** 默认模型改写的诊断（有改写/出错时才有；无则 undefined）。 */
	readonly defaultModel?: string;
}

// ─── tof.sync（企业身份票据同步到 dsh 侧，2026-10-21）───────────────────────────

/**
 * 票据在 dsh 侧的凭证引用名（`ctx.credentials.set(ref, value)` 的 ref；POSIX 标识符）。
 *
 * 为什么用 `credentials` 而不是 `settings`：dsh 的 `ctx.settings` 是**插件配置表单**服务
 * （`dsh-settings` README 明确 "Forms expose only volatile fields"）⇒ 动态票据不该进那里；
 * `ctx.credentials` 才是**持久化凭据**的正规落点（`dsh-credentials-local` ⇒ `<dshHome>/.credentials.yaml`）。
 */
export const DSH_TOF_CREDENTIAL_REF = 'VSSAROS_TOF_TICKET';

export interface IBridgeTofSyncArgs {
	/**
	 * 企业身份票据（`x-tai-identity`，TOF/OA）；`null` = 登出（清掉 dsh 侧那一份）。
	 *
	 * ⚠ 只传**票据**，不传身份字段：身份（工号/姓名/团队）由 Host 侧自己 whoami 得出 ⇒ 单一事实源，
	 * 不会出现"票据是 A、名字是 B"的错配 ✓（dsh 侧走 Node fetch，明文 HTTP 没问题）。
	 */
	readonly ticket: string | null;
}

/**
 * dsh 侧企业身份状态（`tof.status` 回执，2026-10-22）——与 `tof.js` 的 `status()` 同形，**没有票据**。
 */
export interface IBridgeTofStatus {
	readonly signedIn: boolean;
	/** 网关给的标准用户 ID（`taihu:staffid:<id>` 形）——IDE 当数据归属键用。 */
	readonly userId?: string;
	readonly staffId?: string;
	readonly loginName?: string;
	readonly team?: string | null;
	readonly isAdmin?: boolean;
	/** 票据过期时间（ISO 8601，网关给的）。 */
	readonly expiresAt?: string;
	/** 身份来自哪：dsh（dsh 侧自登）/ ide（IDE 旧扩展同步或一次性迁移来的）。 */
	readonly source?: string;
	/** 网关临时不可达 ⇒ 下面是缓存的身份（仍算已登录）。 */
	readonly stale?: boolean;
	/** 网关明确拒票（401：过期 / 吊销）⇒ 未登录，需要用户重新登录（**不**自动开浏览器）。 */
	readonly expired?: boolean;
	/** dsh 侧是否存着票（不论是否有效）——IDE 据此判断要不要做一次性迁移。 */
	readonly hasCredential?: boolean;
	/** 用户在 dsh 侧主动登出过 ⇒ IDE 不得再把旧扩展里的票迁回来。 */
	readonly signedOutByUser?: boolean;
	readonly signingIn?: boolean;
	readonly signInDeadline?: number;
	readonly error?: string;
}

/** `tof.ticket` 回执：当前有效票据（只经本机命名管道到 IDE 主进程 ⇒ 渲染进程；**绝不**下发页面）。 */
export interface IBridgeTofTicketResult {
	readonly ticket: string | null;
	readonly source: string;
}

export interface IBridgeTofSyncResult {
	/** dsh 侧现在是否持有票据。 */
	readonly signedIn: boolean;
	/** 票据落在哪个凭证引用名（诊断用；**值本身不外传**）。 */
	readonly ref: string;
	/** 本次是否真的写入/删除了（false = 内容没变）。 */
	readonly changed: boolean;
}

/** `tof.sync` 负载校验（跨进程边界收紧；票据是凭据 ⇒ 禁控制字符、限长）。 */
export function validateTofSyncArgs(value: unknown): value is IBridgeTofSyncArgs {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const v = value as { ticket?: unknown };
	if (v.ticket === null) {
		return true;
	}
	if (typeof v.ticket !== 'string') {
		return false;
	}
	// 票据是长 base64/hex 串 ⇒ 限长 + 禁换行/NUL（防注入到 YAML 与日志行）
	return v.ticket.length > 0 && v.ticket.length <= 4096 && !/[\r\n\u0000]/.test(v.ticket);
}

// ─── CodeBuddy（dsh 侧自持 provider，2026-10-22）────────────────────────────────

/** dsh 侧 CodeBuddy 状态投影（**不含 token**；与 `codebuddy.js` 的 `status()` 同形）。 */
export interface IBridgeCodeBuddyStatus {
	readonly provider: 'codebuddy';
	readonly route: string;
	readonly endpoint: string;
	readonly signedIn: boolean;
	readonly signingIn: boolean;
	/** 浏览器登录的等待截止时刻（epoch ms；仅登录中出现）。 */
	readonly signInDeadline?: number;
	/** 登录态来源：cli_external_link（浏览器登录）/ local_storage（复用本机 CodeBuddy）/ ide-import / legacy。 */
	readonly source?: string;
	readonly userId?: string;
	readonly tenantId?: string;
	readonly name?: string;
	/** access token 过期时刻（epoch ms）；未知 = null。 */
	readonly expiresAt?: number | null;
	readonly canRefresh?: boolean;
	/** 模型目录条数；还没取过 = null。 */
	readonly models: number | null;
	readonly modelIds: readonly string[];
	/** 与 modelIds 一一对应的展示名（平台没给名字就是 id）。 */
	readonly modelNames?: readonly string[];
	readonly modelsFetchedAt: number | null;
	readonly routeWritten: boolean;
	readonly routeNote: string;
	/** 一句人话的最近错误（不含 token / 堆栈）。 */
	readonly error?: string;
}

/** `codebuddy.import` 负载：IDE 扩展里的登录态（一次性迁移）。 */
export interface IBridgeCodeBuddyImportArgs {
	readonly accessToken: string;
	readonly refreshToken?: string;
	/** 过期时刻（epoch ms 或 s 均可，Host 侧按扩展的 `_calcExpiry` 口径换算）。 */
	readonly expiresAt?: number;
}

export interface IBridgeCodeBuddyImportResult {
	readonly imported: boolean;
	/** 未导入的原因：already-signed-in / invalid-token。 */
	readonly reason?: string;
	readonly status?: IBridgeCodeBuddyStatus;
}

/** token 形状收紧：可打印 ASCII、无空白、限长（跨进程边界 + 将落进 YAML）。 */
const TOKEN_RE = /^[\x21-\x7E]{10,8192}$/;

/** `codebuddy.import` 负载校验。 */
export function validateCodeBuddyImportArgs(value: unknown): value is IBridgeCodeBuddyImportArgs {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const v = value as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
	if (typeof v.accessToken !== 'string' || !TOKEN_RE.test(v.accessToken)) {
		return false;
	}
	if (v.refreshToken !== undefined && (typeof v.refreshToken !== 'string' || !TOKEN_RE.test(v.refreshToken))) {
		return false;
	}
	if (v.expiresAt !== undefined && (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt) || v.expiresAt <= 0)) {
		return false;
	}
	return true;
}

/** dsh 侧 LightAI 状态（`lightai.status` 回执，与 `lightai.js` 的 `status()` 同形；**没有 cookie 值**）。只列 IDE 用到的字段。 */
export interface IBridgeLightAIStatus {
	readonly signedIn: boolean;
	readonly signingIn: boolean;
	/** dsh 侧是否存着 cookie（不论有效与否）—— IDE 据此判断要不要做一次性迁移。 */
	readonly hasCredential: boolean;
	/** 用户在 dsh 侧主动登出过 ⇒ IDE 不得再把扩展里的 cookie 迁回来。 */
	readonly signedOutByUser: boolean;
	readonly expired?: boolean;
	readonly userId?: string;
	readonly error?: string;
}

/** `lightai.import` 负载：IDE 扩展 settings 里的 `lightai.cookie` / `lightai.userId`。 */
export interface IBridgeLightAIImportArgs {
	readonly cookie: string;
	readonly userId: string;
}

export interface IBridgeLightAIImportResult {
	readonly imported: boolean;
	readonly reason?: string;
}

/** 跨进程边界的负载校验：cookie 必须含 `sessionid=` 与 `uid=`、≤4096、无控制字符；userId 1–256。 */
export function validateLightAIImportArgs(value: unknown): value is IBridgeLightAIImportArgs {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const v = value as { cookie?: unknown; userId?: unknown };
	if (typeof v.cookie !== 'string' || v.cookie.length > 4096 || /[\r\n\u0000]/.test(v.cookie)
		|| !/(^|;\s*)sessionid=[^;]+/.test(v.cookie) || !/(^|;\s*)uid=[^;]+/.test(v.cookie)) {
		return false;
	}
	if (typeof v.userId !== 'string' || !v.userId.trim() || v.userId.length > 256 || /[\r\n\u0000]/.test(v.userId)) {
		return false;
	}
	return true;
}

/** 反向 `credit.route` 负载：登记"路由 → 真实网关"。 */
export interface IBridgeCreditRouteArgs {
	readonly route: string;
	readonly baseURL: string;
}

export interface IBridgeCreditRouteResult {
	/** 代理地址（`http://127.0.0.1:<port>/r/<secret>/<route>`）。 */
	readonly baseURL: string;
}

/**
 * `credit.route` 负载校验：路由名同 providers.sync 口径（`vssaros-*`）；真实网关只认 https（或本机）——
 * 主进程代理会**按这个地址转发**，放开 http 等于让 Host 指挥主进程去连任意明文地址 ✗。
 */
export function validateCreditRouteArgs(value: unknown): value is IBridgeCreditRouteArgs {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const v = value as { route?: unknown; baseURL?: unknown };
	return typeof v.route === 'string' && /^vssaros-[a-z0-9-]{1,40}$/.test(v.route)
		&& typeof v.baseURL === 'string' && v.baseURL.length <= 512
		&& (/^https:\/\/[^\s]+$/.test(v.baseURL) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?([/][^\s]*)?$/.test(v.baseURL));
}

// ─── credit.record（积分样本入账，2026-10-20）────────────────────────────────

/** 一条积分样本（与主进程 `IDshCreditSample` 同形；只有数值字段，不含请求/响应内容）。 */
export interface IBridgeCreditRecordArgs {
	/** dsh 路由名（`vssaros-*`），与 Host 侧 `GenerateOptions.provider` 对得上。 */
	readonly route: string;
	/** 请求体里的模型 id（网关可能带后缀，Host 侧按"同族"匹配）。 */
	readonly model?: string;
	/** 网关上报的积分；缺省 = 该响应没有积分字段（与 0 区分）。 */
	readonly credit?: number;
	readonly status?: number;
	/** 代理读完响应的时刻（epoch ms）。 */
	readonly at: number;
}

/** Host 侧归属结果（诊断用；主进程只打日志，不据此做决策）。 */
export interface IBridgeCreditRecordResult {
	readonly matched: boolean;
	/** 已写进会话日志（false = 匹配到了但写不进：Host 版本过旧 / 会话已不活跃）。 */
	readonly appended?: boolean;
	/** 暂时没匹配上、在等对应调用结束。 */
	readonly pending?: boolean;
	readonly sessionId?: string;
	readonly turn?: number | null;
	/** 同一时刻有多个会话在用同一模型 ⇒ 取了最可能的那个。 */
	readonly ambiguous?: boolean;
	readonly reason?: string;
}

const PROVIDER_ROUTE_RE = /^vssaros-[a-z0-9-]{1,40}$/;
const CREDENTIAL_REF_RE = /^VSSAROS_[A-Z0-9_]{1,60}$/;
const PROVIDER_APIS: readonly string[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const HEADER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
/** 凭证走 Authorization，桥侧保留名（Harness 归属头）也不许占用。 */
const HEADER_FORBIDDEN = new Set(['authorization', 'proxy-authorization', 'host', 'content-length']);

function validProviderHeaders(h: unknown): boolean {
	if (!h || typeof h !== 'object' || Array.isArray(h)) {
		return false;
	}
	const entries = Object.entries(h as Record<string, unknown>);
	if (entries.length > 16) {
		return false;
	}
	return entries.every(([k, v]) => HEADER_NAME_RE.test(k) && !HEADER_FORBIDDEN.has(k.toLowerCase())
		&& typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\r\n]/.test(v));
}

/** `providers.sync` 负载校验（跨进程边界收紧）。 */
export function validateProvidersSyncArgs(value: unknown): value is IBridgeProvidersSyncArgs {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as { providers?: unknown; credentials?: unknown };
	if (!Array.isArray(v.providers) || v.providers.length > 32 || !Array.isArray(v.credentials) || v.credentials.length > 32) {
		return false;
	}
	for (const p of v.providers) {
		if (!p || typeof p !== 'object') {
			return false;
		}
		const e = p as Partial<IBridgeProviderEntry>;
		if (typeof e.route !== 'string' || !PROVIDER_ROUTE_RE.test(e.route)
			|| typeof e.displayName !== 'string' || !e.displayName || e.displayName.length > 80
			|| typeof e.api !== 'string' || !PROVIDER_APIS.includes(e.api)
			|| typeof e.baseURL !== 'string' || !/^https:\/\/[^\s]+$/.test(e.baseURL) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?([/][^\s]*)?$/.test(e.baseURL)
			|| (e.credentialRef !== undefined && (typeof e.credentialRef !== 'string' || !CREDENTIAL_REF_RE.test(e.credentialRef)))
			|| !Array.isArray(e.models) || e.models.length === 0 || e.models.length > 200) {
			return false;
		}
		for (const m of e.models) {
			if (!m || typeof m !== 'object' || typeof (m as IBridgeProviderModel).id !== 'string' || !(m as IBridgeProviderModel).id || (m as IBridgeProviderModel).id.length > 200) {
				return false;
			}
		}
		if (e.headers !== undefined && !validProviderHeaders(e.headers)) {
			return false;
		}
	}
	for (const c of v.credentials) {
		if (!c || typeof c !== 'object' || typeof (c as { ref?: unknown }).ref !== 'string' || !CREDENTIAL_REF_RE.test((c as { ref: string }).ref)
			|| typeof (c as { value?: unknown }).value !== 'string') {
			return false;
		}
	}
	return true;
}

export interface IRpcRequest {
	readonly jsonrpc: '2.0';
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

export interface IRpcError {
	readonly code: number;
	readonly message: string;
}

export interface IRpcResponse {
	readonly jsonrpc?: '2.0';
	readonly id: number | null;
	readonly result?: unknown;
	readonly error?: IRpcError;
}

export function encodeRpc(message: IRpcRequest): string {
	return JSON.stringify(message) + '\n';
}

/** 反向通道（协议 v2）用：把**响应**编码成一行。`encodeRpc` 只收请求（`method` 必填），故单列一个。 */
export function encodeRpcResponse(message: IRpcResponse): string {
	return JSON.stringify(message) + '\n';
}

/** 换行分帧解码器：跨 chunk 拼接，单行解析失败只丢该行，不影响后续消息。 */
export class LineDecoder {
	private _buffer = '';
	private _malformed = 0;

	get malformed(): number {
		return this._malformed;
	}

	push(chunk: string): IRpcResponse[] {
		this._buffer += chunk;
		const out: IRpcResponse[] = [];
		let nl: number;
		while ((nl = this._buffer.indexOf('\n')) >= 0) {
			const line = this._buffer.slice(0, nl).trim();
			this._buffer = this._buffer.slice(nl + 1);
			if (!line) {
				continue;
			}
			try {
				const msg = JSON.parse(line);
				if (msg && typeof msg === 'object' && 'id' in msg) {
					out.push(msg as IRpcResponse);
				} else {
					this._malformed++;
				}
			} catch {
				this._malformed++;
			}
		}
		return out;
	}
}

export function isBridgeHello(value: unknown): value is IBridgeHello {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as Partial<IBridgeHello>;
	return typeof v.bridgeVersion === 'number'
		&& typeof v.pluginVersion === 'string'
		&& !!v.host && typeof v.host.port === 'number' && typeof v.host.authUrl === 'string' && typeof v.host.origin === 'string';
}
