/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 底座（DeepSeek Harness）P1 骨架的共享常量与类型。
 *
 * 方案：doc/dsh-foundation-refactor-plan.html（v1.2）；P0 验证：poc/dsh-p0/README.md。
 * 依赖面约束：本目录只依赖 dsh 的 CLI（L0）与"整页加载"（L1），以及 VsSaros 自有的控制桥；
 * 不得 import 任何 `@deepseek-ai/*` 包（L2 依赖只允许出现在仓库根的 `dsh-plugins/` 内）。
 */

import type { DshUpdateChannel, IDshUpdateDiscovery } from './dshCompat.js';
import type { DshHmrState } from './dshPluginActivation.js';
// `browser` 覆盖层的配置形状（真源在渲染器那一侧；这里只要类型 ⇒ type-only import 不进运行时 ✓）。
import type { IDshBrowserOverlayConfig } from './dshCli.js';
import type { IVssarosPluginManifest } from './vssarosPluginManifest.js';

export interface IDshUpdateDiscoveryResult extends IDshUpdateDiscovery {
	readonly manifestSource?: 'bundled' | 'remote' | 'cache';
	readonly manifestGeneratedAt?: string;
}

/** 主进程 IPC 通道名（renderer 经 IMainProcessService.getChannel 取得）。 */
export const DSH_HARNESS_CHANNEL = 'sessions.dshHarness';

/** VsSaros 专属 profile（用 `--from-default-profile web` 初始化，插件集合与用户的 web profile 隔离）。 */
export const DSH_DEFAULT_PROFILE = 'vssaros';

/** 伴生插件包名（源码位于仓库根 `dsh-plugins/vssaros-bridge/`）。 */
export const DSH_BRIDGE_PLUGIN_NAME = '@vssaros/dsh-bridge';

/**
 * 共享运行时服务插件包名（源码位于仓库根 `dsh-plugins/vssaros-foundation/`；重构 1.3）。
 * 它提供 `vssarosFoundation` 服务（dataRoot/dshHome/pageShell/lock 的唯一真源），
 * 所有模块插件都是它的消费者 ⇒ **必须先于模块插件安装/激活**。
 */
export const DSH_FOUNDATION_PLUGIN_NAME = '@vssaros/dsh-foundation';

/**
 * 工作台宿主插件包名（源码位于仓库根 `dsh-plugins/vssaros-workbenches/`；doc/workbench-refactor-plan.md P1）。
 * 提供客户端服务 `desktopWorkbenches` 与只读服务 `desktopWorkbenchOwnership`。它没有 `vssaros.module`
 * （不是 UI 模块）⇒ **不进模块自发现**，必须由伴生段显式安装，且排在模块插件之前（消费者 inject 它）。
 * ⚠ 2026-10-22 真机：漏装它 ⇒ `@vssaros/dsh-scheduler: pending (waiting for service: desktopWorkbenches)`。
 */
export const DSH_WORKBENCHES_PLUGIN_NAME = '@vssaros/dsh-workbenches';

/** chat-surface 插件包名（源码位于仓库根 `dsh-plugins/vssaros-chat-surface/`）。 */
export const DSH_CHAT_SURFACE_PLUGIN_NAME = '@vssaros/dsh-chat-surface';

/**
 * 知识库 `@` 引用源插件包名（源码位于仓库根 `dsh-plugins/vssaros-kb-refs/`，2026-10-14 P1-1）。
 *
 * 纯客户端插件（host 半边是空的）：在聊天输入框里注册 `@知识库` 这个引用源，
 * 候选走 **同源 HTTP 打 kb 插件既有的只读路由** ⇒ 它**不注册工具、不开路由**，
 * 因此**不进**「模块插件」自发现（`vssaros.module`）、也不进工具面快照 ✓ ——
 * 与 bridge / chat-surface 同属"由伴生段显式安装"的那一类。
 */
export const DSH_KB_REFS_PLUGIN_NAME = '@vssaros/dsh-kb-refs';

/**
 * Host 侧 `browser`（CDP）插件包名（源码位于仓库根 `dsh-plugins/vssaros-browser/`）。
 *
 * 随包安装（README 4.69 Step 1）：这一族原本由 `vssaros-ide` 转给 **IDE 进程**执行，
 * 搬到 Host 后**没有 VsSaros 也能用**；`vssaros-ide` 会用 `ctx.get('vssarosBrowser')` **让路**
 * （同名工具不能两个都注册 —— dsh 里那不是后者覆盖，而是整条 entry 失效）。
 */
export const DSH_BROWSER_PLUGIN_NAME = '@vssaros/dsh-browser';

/** Host 侧 `unreal_*` 插件包名（源码位于仓库根 `dsh-plugins/vssaros-unreal/`）；让路机制同上。 */
export const DSH_UNREAL_PLUGIN_NAME = '@vssaros/dsh-unreal';

/**
 * **随包 vendored 的第三方技能包**（`dsh-plugins/vssaros-archify/`；上游 `tt-a1i/archify`，MIT）。
 *
 * ⚠ 包名**保留上游的** `@tt-a1i/archify-dsh`（**不**改成 `@vssaros/*`）：装进 profile 后它与 npm 上那个是
 * **同一个包名** ⇒ 用户若另外从 npm 装一份，pnpm 更新的是**同一份**，不会变成"两个 provider 各报一个 `archify`
 * 技能"（那正是 2026-10-13 消灭掉的重复交付 ✗）。取舍与 provenance 见 `dsh-plugins/vssaros-archify/VENDOR.md`。
 */
export const DSH_ARCHIFY_PLUGIN_NAME = '@tt-a1i/archify-dsh';

/**
 * **ego lite（`ego-browser`）接入插件**包名（源码位于仓库根 `dsh-plugins/vssaros-ego/`）。
 *
 * 它是"**agent 的第二个浏览器**"那条线的 Host 侧落点：`vssaros-browser` 用 CDP 驱动用户**同一个**
 * Chrome（会跟人抢标签），ego lite 则是每个 agent 一个隔离 Space 的**独立浏览器**。
 *
 * ⚠ 本包**不含**浏览器本体：ego lite 是第三方独立应用（不开源、单独下载），`globalThis.ego` 那份
 * 原生绑定由它注入。所以装不上/用户没装 app 都**不是**启动错误 —— 只是那 4 个工具用不了，
 * 且 `ego_status` 会把"没装 / 没运行 / PATH 陈旧"三种情况分开说清楚（`vssaros-ego/README.md`）。
 */
export const DSH_EGO_PLUGIN_NAME = '@vssaros/dsh-ego';

/** 官方实验语音输入 bundle（随 dsh 运行时分发在其 node_modules 里；本地 SenseVoice 识别）。 */
export const DSH_VOICE_BUNDLE_PLUGIN_NAME = '@deepseek-ai/dsh-experimental-voice-input-bundle';

/** 官方调度 bundle（重构 2.1）：time-context / schedule 服务 / ui-schedule 三行。S3 已验证可装可用。 */
export const DSH_SCHEDULE_BUNDLE_PLUGIN_NAME = '@deepseek-ai/dsh-experimental-schedule-bundle';

/**
 * dsh 官方 web app bundle —— **它提供 `webServer` 与 `connection` 这两个服务**。
 *
 * 为什么必须装：缺它时，所有 `inject` 了这两个服务的插件（bridge / chat-surface / codebase /
 * memory / kb / kanban / …）会**永远 pending** ⇒ bridge 插件根本不会去建控制桥管道 ⇒
 * VsSaros 侧的 `DshBridgeClient.connect` 60s 超时（`ENOENT`）⇒ **Host 以 code 1 退出**。
 * 2026-10-11 实测：App 侧 profile 的 `dsh.profile.bundles` 缺它、探针侧有它——两边一比就比出来了
 * （"探针绿、产品坏"的第二次现身）。
 */
export const DSH_WEB_APP_BUNDLE_NAME = '@deepseek-ai/dsh-web-app';

/** 一个已装插件的清单条目（`spec` 是清单里的版本约束，`version` 是 node_modules 里的实装版本）。 */
/**
 * Host 里插件发起的一次 IDE 能力请求（反向通道 `ide.request`，协议 v2）。
 * 主进程授权通过后经 {@link DshHarnessChannelEvent.OnIdeRequest} 交给 renderer 执行。
 */
export interface IDshIdeRequest {
	/** 主进程分配的请求 id（renderer 回执时原样带回）。 */
	readonly id: number;
	/** 能力名（已通过白名单校验）。 */
	readonly capability: string;
	/** 调用方插件名（已通过"该插件声明过该能力"的校验）。 */
	readonly pluginId: string;
	/**
	 * 发起这次能力请求的 **dsh 会话 id**（Host 侧从 `exec.agent.session.id` 取；老版本 dsh 可能没有）。
	 *
	 * 主进程据此把请求**定向**投给"正在跑这个会话的那个窗口"（`common/dshIdeTargeting.ts`），
	 * 免得 `openFile` 落在用户没看的窗口；缺省 ⇒ 退回广播，行为与从前完全一致。
	 */
	readonly sessionId?: string;
	readonly params?: Record<string, unknown>;
}

/** renderer 对一次 IDE 能力请求的回执。 */
export interface IDshIdeReply {
	readonly id: number;
	readonly result?: unknown;
	readonly error?: string;
}

/** renderer 认领一次 IDE 能力请求的结果（详见 {@link DshHarnessChannelCommand.ClaimIdeRequest}）。 */
export interface IDshIdeClaimReply {
	/** `true` = 本次由你执行；`false` = 已被别的窗口认领 / 该请求已不在等待中 ⇒ **不执行、不回执**。 */
	readonly claimed: boolean;
}

export interface IDshPluginInfo {
	readonly name: string;
	readonly spec: string;
	readonly version?: string;
	/**
	 * 是否启用（插件中心开关，方案 4.3）。缺省视为启用。
	 * 「停用」当前只影响 VsSaros 侧是否激活（ActivityBar 图标 / 模块计划）；Host 进程内的实际
	 * 卸载见 `dshPluginActivation.ts` 的口径说明。
	 */
	readonly enabled?: boolean;
	/**
	 * 解析后的 `vssaros` 清单（方案重构 1.1，2026-10-16：壳改为**按清单驱动**）。
	 * 由主进程读取 profile 里的 package.json 并用 `parseVssarosManifest` 校验后带上；
	 * 清单缺失/不合法 ⇒ 没有该字段（渲染端据此不激活它的模块，不猜字段）。
	 */
	readonly manifest?: IVssarosPluginManifest;
	/**
	 * ★ 2026-10-22：该包已迁成 React 工作台（客户端经宿主 `@vssaros/dsh-workbenches` 注册）。
	 * 判据见 `hasWorkbenchClient`；编辑区据此改开 `'workbench'` 视图（否则仍是插件 SSR 页）。
	 */
	readonly workbenchClient?: boolean;
}

/** 承载 dsh 页面的会话分区；与 VsSaros 其他 webview / 集成浏览器隔离。 */
export const DSH_VIEW_PARTITION = 'persist:vssaros-dsh';

/**
 * 「弹出独立窗口」（拼装式 desktop）专用的**网络分区**（2026-10-18 真机定案）。
 *
 * 为什么必须分开：Chromium 对同一个 `host:port` 的 HTTP/1.1 并发连接上限是 **6**，而 dsh 每个页面
 * 都会长期占住若干条连接。真机实测：弹窗页 + 主窗口两个 dsh 页同时存在时，**三个页面的 `fetch` 全部
 * 超时**；把弹窗关掉，主窗口**立刻恢复**（`HTTP404 4ms`）；同期 Host 从外部访问一直是 40–50ms。
 * ⇒ 弹窗页把共享池占满，任何新请求（`session.list` / `session.create`）只能永远排队，
 *   表现为"页面已加载但 create 永不返回"、"reload 也救不回来"（主文档同样排队）。
 * ⇒ 弹窗用自己的分区 ⇒ 独立 socket 池 + 独立 cookie 罐，一个窗口坏掉不会饿死其它窗口 ✓。
 *
 * ⚠ **必须 persist**（2026-10-22 用户报障：「重启 app 后，左侧栏里固定的工作台图标消失了」）：
 * 这个分区承载的是**桌面窗口里那一整页 dsh 客户端**，而它的用户可见状态（侧栏「固定行」清单
 * `vssaros.wb.pinned` 等）存在**页面的 localStorage** 里 ⇒ 分区若不 persist，进程一退出这些数据
 * 全部蒸发 ⇒ 下次启动侧栏固定行长不出来 ✗（图标"自己消失"就是这么来的）。
 * 分区隔离解决的是 **socket 池争抢**，与持久化是两件独立的事 ⇒ 改 persist 不影响那条修复 ✓。
 * ⚠ localStorage 仍按 origin（`127.0.0.1:<host 端口>`）分区 ⇒ Host 端口变了清单会丢；
 *   端口由 `host-port.json` 偏好固定（见 `common/dshHostPortPreference.ts`）⇒ 常规重启端口不变 ✓。
 */
export const DSH_VIEW_PARTITION_DESKTOP = 'persist:vssaros-dsh-desktop';

/**
 * **并发聊天视图**专用网络分区的前缀（2026-10-21，中间栏并排多聊天）。
 *
 * 沿用与弹窗同源的取证（见 `DSH_VIEW_PARTITION_DESKTOP`）：Chromium 对同一 `host:port` 的
 * HTTP/1.1 并发连接上限是 **6**，dsh 每个页面长期占住若干条 ⇒ 同一窗口里并排两个聊天
 * （两个 `WebContentsView` = 两个页面实例）就会互相饿死，表现为"第二个聊天一直转圈 /
 * `session.create` 永不返回"。
 *
 * ⇒ **同一窗口的第 2..N 个聊天视图各占一个独立分区**（独立 socket 池）✓。
 * 第 1 个聊天视图仍用主分区（`DSH_VIEW_PARTITION`）：单聊天场景**行为完全不变**，
 * 且它与插件页同源 ⇒ 跨页焦点交接（聊天页 → agents 页）照旧 ✓。
 *
 * 非 persist：进程退出即释放（不长期累积 cookie/缓存）。
 */
export const DSH_VIEW_PARTITION_CHAT_POOL_PREFIX = 'vssaros-dsh-chat-';

/**
 * 随包插件的**安装状态**（与"是否停用"正交）。
 *
 * `installedVersion` 与随包 `version` 的关系给出四种状态：
 * - `missing`      ⇒ 未装（按钮"安装"）；
 * - `installed`    ⇒ 已装同版本（按钮置灰）；
 * - `upgradable`   ⇒ profile 里的更旧 ⇒ 按钮"升级到 v{version}"；
 * - `downgradable` ⇒ profile 里的**更新** ⇒ 按钮"改回 v{version}"（开发机常见：本地装过更新的随包插件）。
 *
 * ⚠ 这个状态由 `dshBundledPlugins.mergeBundledWithInstalled` **单一真源**算出并放进 `state`；
 *   界面**不许**自己再比一次版本 ✗ —— 2026-10-12 之前视图自己比（徽标用"不等即升级"、按钮另有一份
 *   私有 `_compareVersions`），装了更新版本时会**自相矛盾**：徽标说"可升级"、按钮说"改回" ✗。
 */
export type IDshBundledPluginState = 'missing' | 'installed' | 'upgradable' | 'downgradable';

/**
 * 一个**随包**插件（仓库 `dsh-plugins/<dir>/`）在插件中心里的行（方案 5.16 的补充：一键安装）。
 *
 * `installedVersion` 与 `version` 的关系给出四种安装状态（见 `IDshBundledPluginState`）：
 * - 两者都没有 ⇒ 包坏了（不该出现，行会被丢掉）；
 * - `installedVersion` 空 ⇒ `missing`；
 * - 相等 ⇒ `installed`（按钮置灰）；
 * - profile 更旧 ⇒ `upgradable`；profile 更新 ⇒ `downgradable`。
 */
export interface IDshBundledPluginRow {
	readonly name: string;
	readonly version: string;
	/** ★ 安装状态（真源 = `mergeBundledWithInstalled`；界面只读，不得自行比较版本 ✗）。 */
	readonly state: IDshBundledPluginState;
	/** 清单里的说明（取前若干字符显示）。 */
	readonly description?: string;
	/** 模块 id（`vssaros.module` / 活动栏容器推断），用于显示"这是哪个模块"；非模块包为空。 */
	readonly module?: string;
	/** 随包目录的绝对路径（诊断用，界面不显示）。 */
	readonly dir: string;
	/** profile 里的实装版本；未装则空。 */
	readonly installedVersion?: string;
	/** 已装但被停用（`enabled === false`）：界面要能区分"装了但关了"。 */
	readonly installedDisabled?: boolean;
}

/**
 * 随包插件安装（或升级）的结果。
 *
 * `ok` 的口径是"**目标版本真的在 profile 里了**"（`version === bundledVersion`），不是"命令没抛异常"：
 * 与伴生插件安装同一口径——那条路装不上只记日志并继续，所以这里也必须用"实装版本"判定，
 * 否则界面会把"报了个错然后继续"显示成成功。
 */
export interface IDshBundledInstallResult {
	readonly name: string;
	readonly ok: boolean;
	/**
	 * 目标版本：随包 / 本地目录安装时是**源目录里声明的版本**（`ok` = 实装版本与它相等 ✓）；
	 * `InstallPluginSpec`（按 spec 安装）那条没有"源目录"这个概念 ⇒ 它是**实装版本**（等于 `version` ✓）。
	 */
	readonly bundledVersion: string;
	/** 安装后 profile 里的实装版本（失败时是"仍停在"的旧版本，可能没有=压根没装上）。 */
	readonly version?: string;
	/** 安装前的实装版本（没有=之前没装）。 */
	readonly previousVersion?: string;
	readonly changed: boolean;
	/** 失败原因（`ok=false` 时给界面看；细节在 Host / supervisor 日志里）。 */
	readonly error?: string;
}

export const enum DshHarnessSettings {
	/** 总开关；**默认开启**（`default: true`，2026-10-12 更正此处过时注释），关闭时不注册任何可见入口、不拉起任何进程。 */
	Enabled = 'sessions.dshHarness.enabled',
	/** dsh 安装位置：`npm i --prefix` 的目录，或 `.../@deepseek-ai/dsh/lib/bin.js`；留空用托管运行时。 */
	RuntimePath = 'sessions.dshHarness.runtimePath',
	/** Node 可执行文件；留空依次尝试托管 Node、PATH 中的 node。 */
	NodePath = 'sessions.dshHarness.nodePath',
	/** `$DSH_HOME`；留空时安装版沿用 dsh 默认（~/.dsh，与浏览器里的 dsh web 共享会话），开发版使用独立目录。 */
	DshHome = 'sessions.dshHarness.dshHome',
	/** profile 名。 */
	Profile = 'sessions.dshHarness.profile',
	/** 托管 Node 的下载源（Node 官方 dist 目录结构）；内网可指向镜像，如 npmmirror。 */
	NodeMirror = 'sessions.dshHarness.nodeMirror',
	/** 升级通道：stable（只到兼容清单中的版本）/ preview（跟随 npm latest、next）/ locked（固定版本）。 */
	UpdateChannel = 'sessions.dshHarness.updateChannel',
	/** 锁定通道的版本。 */
	PinnedVersion = 'sessions.dshHarness.pinnedVersion',
	/** 远端签名兼容清单的地址（可选）。 */
	CompatManifestUrl = 'sessions.dshHarness.compatManifestUrl',
	/** 聊天框引擎：legacy（现有 DOM 聊天面板）/ dsh（dsh 聊天页面承载在聊天框 instance 内）。改动后需重载窗口。 */
	ChatEngine = 'sessions.dshHarness.chatEngine',
	// ★ 2026-10-19：`sessionHistoryUi` 开关**已删除** —— 用户定稿"会话历史的数据源与 UI 全部归 dsh"，
	//   容器只挂插件页宿主，不再有第二套 UI 可选。留一个没人读的开关只会制造"配了没效果"的假配置 ✗。
	/** 工作台就绪后后台预热 Host（默认开）：用户点开聊天框时 Host 已就绪，不用等启动。 */
	Prewarm = 'sessions.dshHarness.prewarm',
	/** 关闭 IDE 时保留 Host（默认开）：Host 空闲 30 分钟无客户端自退；再次打开 IDE 经租约直接接管（零等待）。 */
	HostKeepAlive = 'sessions.dshHarness.hostKeepAlive',
	/**
	 * 「弹出独立窗口」的形态（2026-10-18 用户拍板）：
	 *  · `composed`（默认）= **拼装式 desktop**：aux editor part（多分栏）+ 左侧 VsSaros 会话栏
	 *    + 中间 dsh 聊天视图（`surface=chat`，长期稳定）+ 右侧工作台页签。
	 *  · `web` = 官方 dsh Web 客户端整页（`surface=full`，带官方侧栏/顶栏）。
	 * 为什么默认换成 composed：官方整页在真机上会**整页同步阻塞**（渲染线程卡死：executeJavaScript/
	 * Page.enable 全超时、CPU 0%、无弹窗/无崩溃），表现为"停在 hero、输入框点不动"，且从外部无法
	 * 定位阻塞源 ⇒ 不再作为默认形态（保留开关供对照排查）✓。
	 */
	PopoutStyle = 'sessions.dshHarness.popoutStyle',
	/**
	 * 启动时**直接打开 dsh 桌面窗口**（默认开；2026-10-21 用户要求"F5 启动 app，默认显示 dsh 窗口版"）。
	 *
	 * 语义：sessions 工作台起来后自动执行一次「弹出独立窗口」（与标题栏那个 Pop Out 同一条实现
	 * `DshFullWindowContribution._open`），形态由 {@link PopoutStyle} 决定 ⇒ IDE 主窗口仍然在，
	 * 只是退到后面；桌面窗口侧栏底部有「IDE」入口可以回去（页面桥 `focusIde`）✓。
	 * 全程只开一次（关掉那个窗口 ≠ 又开一个）；engine=legacy / 总开关关闭时不生效。
	 */
	OpenDesktopOnStartup = 'sessions.dshHarness.openDesktopOnStartup',
	/**
	 * 迭代期开关：启动时**跳过随包插件的"升级"安装**（**缺失的仍会装**）。
	 *
	 * 为什么需要：`dshHostSupervisor.start()` 里随包插件是**串行安装、且先于 spawn Host**（profile 的
	 * pnpm 锁决定并行没收益），一次 `dsh plugin add` 实测约 2 s。仓库里插件版本一变（开发期频繁
	 * bump），本次启动就多花 N×2 s——2026-10-11 实测：4 个包 ⇒ 启动多 9 s（用户报"启动又变慢了"）。
	 * 打开后：本次启动用**已装版本**跑（新版本留给下次/或手动装），启动回到 ~0.3 s 量级。
	 */
	SkipPluginInstall = 'sessions.dshHarness.skipPluginInstall',
	/**
	 * 模块引擎（方案 6.8 / 9.2 的 `engine`）：legacy = 模块 ActivityBar 图标由静态注册负责（现状）；
	 * dsh = 交给 `DshActivityBarContribution`，按「已激活的模块插件 + 容器聚合表」动态注册 / 注销
	 * （方案 6.4 / 6.11.5）。默认 legacy；改动后需重载窗口。
	 */
	ModuleEngine = 'sessions.dshHarness.moduleEngine',
	/** 聊天框里只保留聊天 UI：停用 dsh 的侧边栏、品牌顶栏、右侧面板与设置类前端插件（方案 5.13）。 */
	ChatOnlyUi = 'sessions.dshHarness.chatOnlyUi',
	/**
	 * 看板自动执行的入口归属（重构 2.2）：`dsh`（默认）= 由 dsh 侧 kanban runner 驱动（拖到「进行中」
	 * 由 Host 里的 runner 拾取）；`legacy` = 旧的壳侧执行链（`executeTaskForBoard`）。
	 * 两边同时跑会双执行 ⇒ 只能二选一；回退到 legacy 时把这个设为 legacy。
	 */
	EntryKanban = 'sessions.dshHarness.entry.kanban',
	/**
	 * 是否在 **IDE 的 ActivityBar** 上显示工作台（主页 / 知识库 / 商城 / …）入口。
	 *
	 * 默认 `false`（2026-10-27 用户要求："IDE 侧的 activitybar 中，不要显示工作台的页签"）：
	 * 工作台是**窗口模式**的形态；IDE 侧应当只用「sideview + editorpane」这条路径。
	 * 需要窗口形态时把它设 `true` 并重载窗口。
	 */
	WorkbenchInActivityBar = 'sessions.dshHarness.workbenchInActivityBar',
}

/**
 * 插件清单 + HMR 状态。HMR 决定"改完 profile 组合是热重载还是需重启"：
 * `active` 时 dsh-hmr 会串行重载（约 2 秒），`disabled`/`unknown` 时需重启 Host。
 */
export interface IDshPluginActivationSnapshot {
	readonly plugins: readonly IDshPluginInfo[];
	readonly hmr: DshHmrState;
}

/** 启停的结果 = 快照 + 本次是否真的改了 profile 组合（幂等切换时为 false）。 */
export interface IDshPluginSetResult extends IDshPluginActivationSnapshot {
	readonly changed: boolean;
	/**
	 * 写入通路（方案 5.16 批次 3）：`host` = 经 Host 的 `pluginManager`（带它自己的 application 语义）；
	 * `file` = Host 未运行，降级为 VsSaros 直接改 profile 的 `dsh.profile.bundles`。
	 */
	readonly via?: 'host' | 'file';
	/** Host 侧给出的应用结果（`via === 'host'` 时才有；界面话术的真源）。 */
	readonly application?: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled' | null;
	/** Host 侧的错误码（`unknown-plugin` / `management-required` …）。 */
	readonly errorCode?: string;
	/**
	 * Host 侧"**失败在哪一步**"（`stage`；`application === 'failed'` 时最有用）。
	 *
	 * 为什么要有它：`operation-error` 这类码只说"那一步失败了"，不说**是哪一步**（下载 / 构建 / 应用…），
	 * 而 Host 本来给了 `stage` —— 上一版在这里把它丢了，于是界面上（与 Electron 探针里）
	 * 只剩一个裸错误码，看不出该查哪儿。透传它不花任何额外成本。
	 */
	readonly stage?: string | null;
	/**
	 * 宿主给的**原始诊断**（`error.diagnostic`）：`errorCode: 'operation-error'` 这类"非预期异常"
	 * 只有它说得出原因（"预期拒绝"才有可枚举的码）。界面应当把它摆出来，而不是只说"操作失败"。
	 */
	readonly diagnostic?: string;
}

/** 行级启停的结果（方案 5.16 批次 3）：改的是 `cordis.patch.yml` 的 disabled 覆盖，与组合包选择无关。 */
export interface IDshPluginRowSetResult {
	readonly changed: boolean;
	/**
	 * 写入通路（同 {@link IDshPluginSetResult.via}）：`host` = 经 Host 的 `pluginManager`（带它自己的
	 * application 语义）；`file` = **Host 没能应用、退回写 profile 的 `cordis.patch.yml`**。
	 *
	 * 为什么行级也要它：4.53 起行级同样有文件级兜底，而界面原先**写死** `via: 'host'` ⇒ 兜底成功
	 * 那一次会被说成"已应用（Host 热重载完成）"——正是这一族最该避免的那种假象。
	 */
	readonly via?: 'host' | 'file';
	readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled' | null;
	readonly target: string;
	readonly errorCode?: string;
	readonly warnings?: readonly string[];
	/** 同 {@link IDshPluginSetResult.stage}：失败在哪一步（宿主侧给的原始 stage，透传给界面与探针）。 */
	readonly stage?: string | null;
	/** 同 {@link IDshPluginSetResult.diagnostic}：宿主给的原始诊断（`operation-error` 的唯一线索）。 */
	readonly diagnostic?: string;
}

export interface IDshUpdatePolicy {
	readonly channel: DshUpdateChannel;
	readonly pinned?: string;
	readonly compatUrl?: string;
}

/** 可由界面直接给出修复动作的错误类别。 */
export type DshErrorCode = 'node-missing' | 'dsh-missing' | 'start-failed';

export type DshHostState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/**
 * 控制桥状态：
 * - connected：伴生插件握手成功（端口与认证 URL 来自插件）
 * - fallback：未装伴生插件或握手失败，退回解析启动输出中的 URL 行；IDE 联动不可用
 */
export type DshBridgeState = 'connected' | 'fallback' | 'none';

export interface IDshHostStatus {
	readonly state: DshHostState;
	readonly bridge: DshBridgeState;
	readonly dshVersion?: string;
	readonly nodeVersion?: string;
	readonly bridgePluginVersion?: string;
	/** `http://127.0.0.1:<port>`；只在 running 时存在。 */
	readonly origin?: string;
	readonly pid?: number;
	readonly profile?: string;
	readonly dshHome?: string;
	readonly startedAt?: number;
	readonly startupMs?: number;
	/** true = Host 由另一个 VsSaros 实例拉起，本实例经 `host.json` 探活后复用（方案 7.5）。 */
	readonly reused?: boolean;
	/**
	 * true = Host 的 mux 升级路由**已注册**（页面实时事件可用）。
	 *
	 * ★ 2026-10-29：Host ready 之后路由还要几秒才注册（真机 +4.8s ~ +11.4s）⇒ 这段时间里
	 * `session.start` 必然失败（"控制桥不可用" / "never started"）⇒ 桌面窗口据此**先等路由**再发起，
	 * 一次成功、不再弹"假失败"黄条、也不必退避 4s/12s 白等。
	 * 复用既有 Host 时直接为 true（那个 Host 的路由早就注册好了）。
	 */
	readonly muxReady?: boolean;
	readonly error?: string;
	readonly errorCode?: DshErrorCode;
}

export interface IDshHostStartOptions {
	readonly runtimePath?: string;
	readonly nodePath?: string;
	readonly dshHome?: string;
	readonly profile?: string;
	/**
	 * 当前 Agent Studio 工作区 id：经 `--patch` 覆盖层注入看板插件（`config.workspaceId`）。
	 * 不注入时看板写工具会 fail-closed 报错（`getTasks(workspaceId)` 会过滤，空值卡片看不见）。
	 * 取值处见 `DshHarnessService._startOptions()`；这是启动时快照，切换工作区后需重启 Host 才更新。
	 */
	readonly workspaceId?: string;
	/**
	 * 代码图谱模块要的**工作区根目录**：经 `--patch` 覆盖层注入（`config.workspaceRoot`，行 id
	 * `vssaros-codebase`）。插件按 `<root>/.codebase-memory/` 定位清单与图谱，而 Host 进程的 cwd
	 * **不是**工作区 ⇒ 不注入就只能报"未配置"（页面会如实显示"工作区 (未配置)"、工具报错），
	 * 而不是去猜别人的图。取值处见 `DshHarnessService._startOptions()`；同样是启动时快照。
	 */
	readonly workspaceRoot?: string;
	/**
	 * 图谱**相关根**（主根 + `relatedFolders`）——代码图谱插件按它们做**跨根只读查询**
	 * （`{root}/.codebase-memory/`，主根优先）。由启动/重启路径异步取新鲜值后传入
	 * （`DshHarnessService._relatedRoots()`；`_startOptions()` 本身是同步的 ⇒ 由调用方传参 ✓）。
	 */
	readonly relatedRoots?: readonly string[];
	/**
	 * VsSaros 的 MCP 用户配置（`~/.vssaros/mcp.json`）绝对路径。主进程读它 → 每个服务器渲染一行
	 * `@deepseek-ai/dsh-mcp-client` 进 `--patch` 覆盖层（dsh 的 MCP 客户端是"一个服务器一个组合行"，
	 * 没有运行时注册 API，见 `common/dshMcpConfig.ts` 的说明）。不传则本次 Host 不挂任何 MCP 服务器。
	 */
	readonly mcpConfigPath?: string;
	/**
	 * VsSaros 技能库目录（内置 `resources/.agents/skills` + 用户 `~/.vssaros/skills`，渲染进程解析）。
	 * 主进程过滤存在的目录，渲染成一条 `dsh-skill-filesystem` 行进 `--patch` 覆盖层
	 * （见 `common/dshSkillDirs.ts`）；目录增删重启 Host 生效。
	 */
	readonly skillDirs?: readonly string[];
	/**
	 * **内置**技能目录（`resources/.agents/skills`）：单列出来走官方 `bundled` 语义（rank 600 ✓），
	 * 不再混进 {@link skillDirs}（那一档被锁死在 rank 300 ✗，见 `common/dshSkillDirs.ts` 的说明）。
	 * 主进程同样过滤存在性；不存在的目录不注入 ✓。
	 */
	readonly bundledSkillDir?: string;
	/**
	 * VsSaros agent 目录（`<数据根>/agents`，与 IDE 的 `agentStudioService._getSarosAgentsDir()` 同源）：
	 * 经 `--patch` 覆盖层注入 agents 模块（`config.agentsRoot`，行 id `vssaros-agents`，
	 * 见 `common/dshCli.ts` 的 `renderAgentsOverlay`）。
	 *
	 * 为什么必须注入：模块自身口径是 `config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`，而
	 * **用户数据根在 dev 模式下是 `~/.vssaros-dev`** ⇒ 不注入时 dev 实例列的是**生产** agent
	 * （2026-10-11 用户报"聊天框 Agents 里缺少 VsSaros agent"时排查到此项）；生产两者恰好同路径，
	 * 这类错配被完全掩盖。目录增删重启 Host 生效（与 skills / kanban 同口径：启动时快照）。
	 */
	readonly agentsRoot?: string;
	/**
	 * **内置 agent 的源目录**（`resources/.agents/agents`，真源是那里的 `<id>/.agent.md`）。
	 *
	 * 为什么也要注入：Host 是独立进程，只能靠绝对路径拿到产品侧的东西（与 `bundledSkillDir` 同一类道理）。
	 * 主进程据此把源目录**原样复制**成 runDir 下的一份交付副本（`config.agentsBuiltinRoot`）
	 * ⇒ dsh 侧列出的内置 agent 与真源**逐字节相同**，不会因为"代码镜像没同步"而拿到旧内容 ✗。
	 * ⚠ 缺省时主进程退回用代码里的镜像生成（兼容老路径），但那不是真源 ⇒ 正常路径永远有值。
	 */
	readonly agentsBuiltinSrc?: string;
	/**
	 * VsSaros 用户**数据根**（`~/.vssaros` 或 dev 的 `~/.vssaros-dev`）：经 `--patch` 覆盖层注入
	 * **那几个读 `<数据根>` 的模块**（`config.dataRoot`：kb / canvas / workflow / skills；
	 * 另加 mcp 的 `config.path`，见 `common/dshCli.ts` 的 `renderDataRootOverlay`）。
	 *
	 * 为什么必须注入：这些模块的兜底都是 `~/.vssaros`，而 dev 的数据根不是它 ⇒ 不注入时 dev
	 * 实例读**生产**数据（资料库/画布/工作流列生产库、技能页列生产技能目录、MCP 页看生产
	 * `mcp.json` —— 于是"页面说的文件"与"Host 真挂载用的文件"是两个）✗，且生产上完全被掩盖。
	 * 2026-10-12 发现：这些模块此前**从来没有**被注入过（探针全都自己注入 ⇒ 从没暴露 ✗）。
	 */
	readonly dataRoot?: string;
	/**
	 * **知识库存储根**（只有用户改过 `agentStudio.knowledge.storage.path` 时才有值 ✓）：注入 kb
	 * （`config.kbRoot`，行 id `vssaros-kb`）。
	 *
	 * 为什么必须注入：kb 只认 `<数据根>/knowledge-base` ✗，而 IDE 允许把知识库存储改到别处
	 *（也可能整个 vault 走 `customPath`）⇒ 用户改过时 dsh 侧**空着、且页面不报错** ✓（2026-10-12 评估
	 * 发现的 A 组缺口之一）。口径与 IDE 侧 `knowledgeBaseView.rootUri` **同一份实现**（`resolveKbRoot`）。
	 *（2026-10-15：canvas 模块已移除 ⇒ 不再注入它 ✓。）
	 */
	readonly kbRoot?: string;
	/**
	 * **知识库的库记录**（2026-10-15 用户报"不该有 uid 式的根 / 只应显示当前库"✓）：把 IDE storage 里
	 * `agentStudio.kb.vaults` 的**展示字段**（id / name / icon / customPath / closed ✓）序列化成 JSON
	 * 交给 kb 插件的**页面** ✓ —— 名字与图标**只存在 IDE storage 里** ✗（库目录里只有索引缓存，
	 * 盘上推不出来 ✓，我核过真机目录 ✓）。
	 *
	 * ⚠ 只带页面要用的字段（少传就少泄漏 ✓，与 `IDshWorktreeOption` 同一条纪律 ✓）。
	 * ⚠ 与 `kbRoot` 写**同一份**覆盖层（那份 config 是整体替换 ⇒ 拆开会互相擦掉 ✗）。
	 */
	readonly kbVaults?: string;
	/** 同上：**当前激活的库 id**（`agentStudio.kb.active` ✓）—— 页面据此只显示一个库 ✓。 */
	readonly kbActiveVaultId?: string;
	/**
	 * **Unreal bridge 基址**（只有用户改过 `sessions.agentStudio.unreal.bridgeUrl` 时才有值 ✓）：注入
	 * unreal 模块（`config.bridgeUrl`，行 id `vssaros-unreal`）。
	 *
	 * 为什么必须注入：这是 A 组缺口里唯一**连配置键都没有**的一条 ✗ ⇒ 用户在 IDE 设置里改了 bridge 地址，
	 * dsh 侧仍连默认 `http://127.0.0.1:8765` ✓（此前只能靠环境变量 `VSSAROS_UNREAL_BRIDGE_URL` ✓）。
	 * 设置**留空**时不给值 ⇒ 插件用自带默认（与 IDE 默认同值 ✓）。
	 */
	readonly unrealBridgeUrl?: string;
	/**
	 * **`browser` 插件的三个旋钮**（只有用户改过 `sessions.agentStudio.browserCdp.{port,launchDedicated,
	 * headless}` 时才有值 ✓）：注入 `browser` 模块（行 id `vssaros-browser`，见 `common/dshCli.ts` 的
	 * `renderDataRootOverlay`）。
	 *
	 * 为什么必须注入：Host 是独立进程、**读不到 IDE 设置** ⇒ 这三个键此前改了**不生效** ✗（插件只认自己的
	 * `config` 或 `VSSAROS_BROWSER_*` 环境变量）。最要命的是 `launchDedicated`：关掉「自动拉起调试实例」
	 * 也照样拉起一个**空 profile** 的专属实例 ⇒ "在你自己那个 Chrome（带登录态）里干活"这条路被静默绕过，
	 * 现场表现为"用工具抓已登录站点先撞登录墙"（2026-10-14 用户报障）。
	 *
	 * **逐键注入**：没改过的键不给 ⇒ 插件用自己的默认（与 IDE 默认同值 ✓）。
	 */
	readonly browser?: IDshBrowserOverlayConfig;
	/**
	 * 关闭 IDE 时保留 Host（默认关=随退出结束）：Host 空闲自退由桥插件的 idle TTL 兜底；
	 * 下次启动经 `host.json` 租约探活接管（版本/profile 不同则不接管，照常新起）。
	 */
	readonly keepAlive?: boolean;
	/**
	 * 启动时跳过随包插件的**升级**安装（缺失的仍会装）。
	 *
	 * 不影响 Host 组成（因此**不**参与 `sameStartOptions` 的比较）：它只决定"这一次启动要不要先等
	 * 随包插件的升级安装"。见 `DshHarnessSettings.SkipPluginInstall`。
	 */
	readonly skipPluginInstall?: boolean;
}

/**
 * 两次启动请求是否"实质相同"（主进程抢先预热 vs 渲染进程随后发来的那份）。
 *
 * 用途：主进程用上次的选项抢先起 Host，渲染进程起来后再发一次 Start——选项相同就直接复用，
 * 不同就必须重启，否则会出现"跑着旧配置的 Host 被当成新配置"（改 runtimePath/工作区后不生效）。
 * 只比**影响 Host 组成的项**：运行时/Node/DSH_HOME/profile/工作区/MCP 配置/技能目录/常驻。
 */
export function sameStartOptions(a: IDshHostStartOptions, b: IDshHostStartOptions): boolean {
	const sameList = (x?: readonly string[], y?: readonly string[]) => {
		const xs = x ?? [];
		const ys = y ?? [];
		return xs.length === ys.length && xs.every((v, i) => v === ys[i]);
	};
	/**
	 * `browser` 三个旋钮逐键比。
	 *
	 * ⚠ 不能用真值判断（`!x?.launchDedicated && !y?.launchDedicated`）：`false` 是**有意义的值**
	 *（"关掉专属实例"正是用户要表达的东西 ✓）⇒ 只能比"是否为 `undefined`"和具体值 ✓。
	 */
	const sameBrowserConfig = (x?: IDshBrowserOverlayConfig, y?: IDshBrowserOverlayConfig) => (x?.port ?? undefined) === (y?.port ?? undefined)
		&& (x?.launchDedicated ?? undefined) === (y?.launchDedicated ?? undefined)
		&& (x?.headless ?? undefined) === (y?.headless ?? undefined);
	return (a.runtimePath ?? '') === (b.runtimePath ?? '')
		&& (a.nodePath ?? '') === (b.nodePath ?? '')
		&& (a.dshHome ?? '') === (b.dshHome ?? '')
		&& (a.profile ?? '') === (b.profile ?? '')
		&& (a.workspaceId ?? '') === (b.workspaceId ?? '')
		&& (a.workspaceRoot ?? '') === (b.workspaceRoot ?? '')
		&& sameList(a.relatedRoots, b.relatedRoots)
		&& (a.mcpConfigPath ?? '') === (b.mcpConfigPath ?? '')
		// `agentsRoot` / `dataRoot` 一旦变化 ⇒ 覆盖层渲染出的内容就不同（模块读到的目录变了）
		// ⇒ 按本文件的判据（"是否影响 Host 组成"）它们**必须**参与比较 ✓。此前 `agentsRoot` 漏了 ✗
		// ——那意味着 dev/生产数据根切换时会**复用**一个带着旧数据根覆盖层的 Host ✓（少见但静默）。
		&& (a.agentsRoot ?? '') === (b.agentsRoot ?? '')
		&& (a.dataRoot ?? '') === (b.dataRoot ?? '')
		&& sameList(a.skillDirs, b.skillDirs)
		// 内置那一条也要比：它换目录（dev 仓库根 ↔ 打包 resources）时 Host 的覆盖层必须跟着重建 ✓
		&& (a.bundledSkillDir ?? '') === (b.bundledSkillDir ?? '')
		// ★ 2026-10-14：**喂给覆盖层的那些"设置 → config"字段也必须比** —— 它们决定覆盖层里那几行
		// 写什么，改了就"必须重启才生效"✓。此前只有 `agentsRoot` / `dataRoot` 参与（那一处漏过一回，
		// 见上面注释）⇒ 而 `kbRoot` / `unrealBridgeUrl` / `browser` 三条**同样漏着** ✗：
		// 现场是"抢先预热那份来自 `last-start.json`（旧值）→ 渲染进程随后带新值 → 判成相同 ⇒ 复用旧配置的
		// Host ⇒ 改了设置不生效，且日志里一句都没有" ✓（与 `agentsRoot` 那次同一形态的静默复用）。
		&& (a.kbRoot ?? '') === (b.kbRoot ?? '')
		&& (a.unrealBridgeUrl ?? '') === (b.unrealBridgeUrl ?? '')
		&& sameBrowserConfig(a.browser, b.browser)
		&& (a.keepAlive === true) === (b.keepAlive === true);
}

/**
 * 活动工作区变了、Host 也在跑——**要不要重启它**？
 *
 * ★ 2026-10-17 起它的角色变成**兜底**：正常情况下 IDE 会把新上下文经桥推给 Host
 * （`workspace.context`，消费插件运行期读它 ✓）⇒ 不重启也生效。只有**推不动**时才回到这里：
 *   · 老 Host / 老桥（没有那条方法 ⇒ `-32601`）；
 *   · foundation 服务缺席或载荷被拒（`applied:false`）。
 * 升级后的第一次仍会走这条路（那时进程里还是旧代码），之后就再也不用了 ✓。
 *
 * 为什么兜底也不能无脑重启：重启会连**正在跑的会话**一起杀掉。所以只在**空闲**时重启
 * （`blockingSessions` 为空），取不到活动状态时**保守不重启**——宁可让选项晚一步生效，
 * 也不打断人家正在干的活（这种情况由 supervisor 里那行日志说明原因）。
 */
export function shouldRestartForWorkspaceChange(input: {
	/** 上次观测到的活动工作区 id（`undefined` = 还没观测过）。 */
	readonly previousWorkspaceId: string | undefined;
	/** 这次的活动工作区 id。 */
	readonly nextWorkspaceId: string | undefined;
	/** Host 是否在跑（没在跑 ⇒ 下次 Start 自然带上新值，不必重启）。 */
	readonly running: boolean;
	/** 有活儿在跑的会话数；`undefined` = 取不到活动状态（保守不重启）。 */
	readonly blockingSessionCount: number | undefined;
}): boolean {
	// 还没观测过（首次初始化）：不知道 Host 里那份是什么，不打扰
	if (input.previousWorkspaceId === undefined) {
		return false;
	}
	if (input.previousWorkspaceId === input.nextWorkspaceId) {
		return false;
	}
	if (!input.running) {
		return false;
	}
	if (input.blockingSessionCount === undefined || input.blockingSessionCount > 0) {
		return false;
	}
	return true;
}

export interface IDshBootstrapArgs {
	readonly start: IDshHostStartOptions;
	readonly nodeMirror?: string;
	/** 缺 dsh 时按通道选版本（稳定通道=兼容清单中最高的可用版本，缺清单时退回 npm latest）。 */
	readonly policy: IDshUpdatePolicy;
}

export interface IDshUpgradeArgs {
	readonly version: string;
	readonly force?: boolean;
	readonly start: IDshHostStartOptions;
	/** 目标版本未安装时先并列安装（当前 Host 保持运行），再走闸门。 */
	readonly installIfMissing?: boolean;
	readonly nodePath?: string;
}

/** 渲染进程上报的视图矩形：CSS px，主进程乘 zoomFactor 后设置（与上游 browserView 同口径）。 */
export interface IDshViewBounds {
	readonly windowId: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly zoomFactor: number;
}

/**
 * 视图承载的界面形态，经 preload 传给页面（P1 只有 full；chat / plugin-page 在 P2 起用）。
 *
 * ★ 2026-10-22 `workbench`（doc/workbench-refactor-plan.md §5 步骤 4）：编辑区承载**已迁成 React 的工作台**——
 *   加载 dsh 客户端根路径 `/`（不是插件 SSR 页），模块路由经 preload 参数交给页面，由 chat-surface 调
 *   `desktopWorkbenches.open(vssaros/<module>)` 整页打开；宿主没到场则页面自己退回 SSR 完整页。
 */
export type DshViewSurface = 'full' | 'chat' | 'plugin-page' | 'sessions' | 'workbench';

/** 带 route 的视图形态（route 都按 {@link validatePluginRoute} 校验）。 */
export function surfaceTakesRoute(surface: DshViewSurface): boolean {
	return surface === 'plugin-page' || surface === 'workbench';
}

/**
 * 页面 palette 模式（light/dark），由 IDE 主题决定。dsh 的弹层、圆角、字体等**非 alias** token
 * 跟随 palette 模式（`body[data-ds-dark-theme]`），overrideTokens 只覆盖 alias 层、够不到它们；
 * 所以必须把页面的 prefers-color-scheme 对齐到 IDE 主题，否则暗色 IDE 主题下弹层会显示成浅色。
 */
export type DshColorScheme = 'light' | 'dark';

export interface IDshCreateViewArgs {
	readonly viewId: string;
	readonly windowId: number;
	readonly surface: DshViewSurface;
	/** 缺省视为 true：`surface=chat` 时在页面里隐藏 dsh 的侧边栏 / 品牌顶栏 / 右侧面板（方案 5.13）。 */
	readonly chatOnlyUi?: boolean;
	/**
	 * 该视图是否使用**独立的网络分区**（弹窗用）。
	 *
	 * 为什么需要：Chromium 对同一 `host:port` 的 HTTP/1.1 并发连接上限是 6，而 dsh 每个页面都长期占住
	 * 若干条（状态同步）。真机实测：弹窗 + 主窗口两个 dsh 页同时存在时三页 `fetch` 全超时；关掉弹窗，
	 * 主窗口立刻恢复；同期 Host 外部访问 40–50ms。⇒ 共享池被占满后，新请求只能永远排队。
	 * 独立分区 = 独立 socket 池 + 独立 cookie 罐 ✓（见 `DSH_VIEW_PARTITION_DESKTOP`）。
	 */
	readonly isolatedPool?: boolean;
	/** 本视图绑定的 dsh 会话 id（chatId → `vssaros-chat-<chatId>`；空串/缺省 = 不绑定）。 */
	readonly sessionId?: string;
	/** 页面 palette 模式（IDE 主题的 light/dark）；缺省时主进程不强制 emulation。 */
	readonly colorScheme?: DshColorScheme;
	/**
	 * `surface=plugin-page` 时加载的插件自托管路由（方案 6.3：`/x/<module>/`）。
	 * 只接受站内绝对路径（`/` 开头、无 `..`、无 `//` 前缀）；其他 surface 传了会被忽略。
	 */
	readonly route?: string;
	/**
	 * 插件页**承载在哪个表面**（仅 `plugin-page` 有意义）：`sideview` = 活动栏侧栏、`editor` = 编辑区。
	 * 主进程把它拼进页面 URL（`?surface=<值>`），插件据此决定渲染"摘要版"还是"完整页"。
	 *
	 * ⚠ 为什么单独一个字段、而不是塞进 `route`：`validatePluginRoute` **明确拒绝查询串**（见
	 *   `dshPluginPage.ts` 的注释与用例）⇒ 塞进去会被通道判非法、`createView` 直接抛错 ✗。
	 */
	readonly pageSurface?: DshPageSurface;
	/**
	 * 视图**底色候选**（2026-10-13：修「初次打开侧栏视图会白屏一下」）。
	 * 形如 `{ sidebar?: string; editor?: string }`（两个位置的主题底色，由渲染进程算好推来）；
	 * 主进程按 `pageSurface` 挑一个，在建视图时就 `setBackgroundColor` ⇒ 页面画出第一帧之前不会露默认白 ✓。
	 *
	 * ⚠ 类型写 `unknown` 是**有意**的：这是跨进程负载，真值由主进程用 `validateViewBackgrounds` 校验
	 *   （与 `PushTheme` 的 `tokens: unknown` 同一口径 ✓）；声明成严格类型只会让"校验过了"变成假象 ✗。
	 */
	readonly backgrounds?: unknown;
}

/**
 * 插件页的承载表面（2026-10-13）：侧栏 `sideview` / 编辑区 `editor`。
 * 它**不是** `DshViewSurface`（那个描述"视图种类"，`plugin-page` 两种承载都用），
 * 而是"同一个插件页摆在哪"——页面拿它决定渲染摘要版还是完整页。
 */
export type DshPageSurface = 'sideview' | 'editor';

export interface IDshViewInfo {
	readonly viewId: string;
	readonly surface: DshViewSurface;
	/** `surface=plugin-page` 时的路由（诊断与断言用；不含查询串）。 */
	readonly route?: string;
	readonly ownerWindowId: number;
	readonly attachedWindowId?: number;
	/** 本视图绑定的 dsh 会话 id（未绑定 = 缺省）；弹窗「跟随当前聊天会话」等场景据此解析。 */
	readonly sessionId?: string;
	/** 主进程记录的可见状态（来自 renderer 的 setViewVisible）。 */
	readonly visible: boolean;
	/** Electron 视图的实际可见状态。 */
	readonly nativeVisible: boolean;
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface IDshRuntimeInfo {
	/** 托管运行时根目录（`<userData>/dsh-runtime`）。 */
	readonly managedRoot: string;
	readonly current?: string;
	readonly installed: readonly string[];
	/** 本次启动实际使用的 dsh 入口（可能来自设置项而非托管目录）。 */
	readonly activeBin?: string;
}

export const enum DshHarnessChannelCommand {
	GetStatus = 'getStatus',
	Start = 'start',
	Stop = 'stop',
	Restart = 'restart',
	/**
	 * **要一次用户确认**（渲染侧 → 主进程 → 桥 → Host 的审批服务）。用于**留在 IDE 侧**的动作类能力
	 * （目前只有 canvas）：确认卡与 dsh 侧能力用的是**同一张**（`dsh-client-ui-approval`）⇒ 口径统一为
	 * "聊天内 ask"（README 4.76 / 4.83）。
	 *
	 * 返回 `{ allowed, outcome?, reason? }`；**Host/桥不可用时主进程按 fail-closed 回 `allowed:false`**
	 * （产品口径：不退回通知 —— 见 README 4.84）。
	 */
	RequestActionConsent = 'requestActionConsent',
	/**
	 * ★ 2026-10-22：**用户在界面上主动发起**的有副作用操作（目前：工作台市场的「安装」）的确认。
	 * 主进程弹**原生模态框**，挂在当前获得焦点的窗口上（用户正在点的那个：IDE 主窗口或 dsh 桌面窗口）。
	 *
	 * 为什么不用 {@link RequestActionConsent}：那条走 Host 审批服务 `approval.request()`，rc.1 要求请求带
	 * `agent` 且**处在打开的回合里**（`dsh-user-approval/lib/index.js:128-130`），桥又没传 agent ⇒
	 * 界面点击这类"没有回合"的请求**当场被拒**（真机：点安装 4ms 后 `allowed:false`，审批卡从没出现）。
	 * 入参 `{ title, detail, confirmLabel? }`；返回 `{ allowed }`。没有可挂的窗口也照样弹（无父窗口）。
	 */
	ConfirmUserAction = 'confirmUserAction',
	GetLog = 'getLog',
	GetRuntimeInfo = 'getRuntimeInfo',
	InstallRuntime = 'installRuntime',
	SetCurrentRuntime = 'setCurrentRuntime',
	CreateView = 'createView',
	LayoutView = 'layoutView',
	SetViewVisible = 'setViewVisible',
	/**
	 * 等页面里出现某个选择器（2026-10-28）。
	 *
	 * 为什么需要：第一次启动时，dsh 页面会先渲染**官方默认样式**（官方侧栏 + hero），
	 * 我们的换皮 chunk（`client.workbenchNav.js` 等）后到 ⇒ 用户看到"闪一下默认样式"。
	 * 视图创建时本来就是不可见的（`createView` 里 `setVisible(false)`）⇒
	 * 只要**等到我们的 UI 就位再显示**，中间那段就不会被人看见 ✓。
	 *
	 * 入参 `{ viewId, selector, timeoutMs }`，返回 `true` = 等到了（`false` = 超时/视图不存在）。
	 * ⚠ 调用方必须**超时也照常显示**（否则页面出问题就永远白屏 ✗）。
	 */
	WaitViewSelector = 'waitViewSelector',
	/**
	 * **抓一帧并让位**：让位（隐藏原生视图）与抓帧必须在**主进程内一步完成**，否则两条 IPC 赛跑 ⇒
	 * 抓到的是离屏空帧（2026-10-15 实测：那样做 `bgImage` 恒为 `none`，与没做一样 ✗）。
	 * 返回 JPEG dataURL；抓不到 `undefined`（让位照样执行 ⇒ 调用方退回主题底色）。
	 */
	FreezeView = 'freezeView',
	ReloadView = 'reloadView',
	DisposeView = 'disposeView',
	ResetWindow = 'resetWindow',
	ListViews = 'listViews',
	/**
	 * **「启动自动开桌面窗口」只允许做一次**（2026-10-27 真机：一启动就出现两扇桌面窗口）。
	 *
	 * 现场（`logs/20261027T225616`）：22:56:24 启动自动开窗 ⇒ 23:01:24 **又开了一扇**
	 * （`renderer.log` 两次 `startup: open the dsh desktop window by default`）。原因是这段逻辑
	 * 跑在 `DshFullWindowContribution` 构造函数里，而 **IDE 主窗口渲染进程重载**（心跳自愈等）
	 * 会重造贡献 ⇒ 2.5s 后又走一遍 ⇒ 多一扇壳 + 多一个视图（用户看到的可能是那扇空壳，白屏）。
	 *
	 * 判定必须落在**主进程**（进程级、不随渲染重载清零）：入参 `{ windowId }`，
	 * 返回 `true` = 本窗口的启动自动开窗**还没做过**（可以开）；`false` = 已经做过（跳过）。
	 */
	ClaimDesktopAutoOpen = 'claimDesktopAutoOpen',
	/**
	 * 列 **profile 里用户自己装的第三方插件**（2026-10-28）。
	 *
	 * 为什么单独一条：本仓对**随包插件**有完整闭环（启动判定 / 批量安装 / 内容指纹 / 不降级），
	 * 但 `dsh plugin add` 装进来的第三方插件此前既看不到清单、也没有升级入口 ——
	 * 而那正是"从 npm / GitHub 装了个开源插件"的场景（判据见 `common/dshPluginUpgrade.ts`）。
	 */
	ListThirdPartyPlugins = 'listThirdPartyPlugins',
	/**
	 * 升级一个第三方插件。**只有 registry 形态会真的执行**（`<name>@latest`）；
	 * git 源写 `@latest` 会把源换成 npm 同名包、本地目录会把链接换成注册表版本 ⇒ 那两种只返回说明。
	 */
	UpgradeThirdPartyPlugin = 'upgradeThirdPartyPlugin',
	/**
	 * dsh 侧会话摘要（读 `<dshHome>/storages/session_projcache/sessions/*.json`）。
	 *
	 * 为什么要有（2026-10-19 用户报「新增的聊天框会话，在左侧会话历史中，没有实时同步更新」）：
	 * dsh 引擎下聊天在 **dsh 侧**开会话，而左侧「历史会话」读的是 IDE 自己的
	 * `chat-history/<agent>/sessions.json` —— 两套数据源不相通 ⇒ dsh 里新建的会话永远不出现。
	 * 这条命令把 dsh 侧的事实读给渲染进程，由侧栏合并展示（解析规则见 `common/dshSessionIndex.ts`）。
	 */
	ListDshSessions = 'listDshSessions',
	InstallNode = 'installNode',
	/** 一键准备：缺 Node 装 Node、缺 dsh 装 npm `latest` 版本并设为当前，然后启动。 */
	Bootstrap = 'bootstrap',
	/** 升级闸门：运行中任务检查 → 快照 → 切换 → 健康检查 → 失败回退。 */
	Upgrade = 'upgrade',
	GetActivity = 'getActivity',
	/** 升级发现：dist-tags + 兼容清单 → 按通道给出候选与推荐（IDshUpdateDiscovery）。 */
	DiscoverUpdates = 'discoverUpdates',
	/** 窗口上报自己的工作区目录（`{ windowId, paths }`，整体替换），已连接时立即注册新增的目录。 */
	SetWindowWorkspaces = 'setWindowWorkspaces',
	/**
	 * 登记**与窗口无关**的一批工作区目录（`{ paths }`）—— 2026-10-26「从 .code-workspace 导入多根工作区」。
	 *
	 * 为什么单开一条：窗口那条是**整体替换**（窗口上报什么就换成什么）⇒ 拿它登记"导入来的根"
	 * 会把窗口自己的目录顶掉 ✗。
	 */
	EnsureWorkspaces = 'ensureWorkspaces',
	/**
	 * 推**运行期工作区上下文**给 Host（`IBridgeWorkspaceContextArgs` → 桥 `workspace.context`）。
	 * 2026-10-17：切工作区**不必重启 Host** 的落点 —— 老 Host/老插件不认识这条时回 `applied:false`，
	 * 调用方据此退回旧的重启路径 ✓（详见 `DshBridgeMethod.WorkspaceContext` 的注释）。
	 */
	SetWorkspaceContext = 'setWorkspaceContext',
	GetWorkspaceSync = 'getWorkspaceSync',
	/** 经控制桥查询 dsh 工作区注册表（诊断用）。 */
	ListWorkspaces = 'listWorkspaces',
	/**
	 * 同步"**IDE 主窗口是我们藏着的**"这个事实给主进程（desktop 模式的窗口守卫，2026-10-21）。
	 *
	 * 为什么需要这条通道（用户报障："在 desktop 模式下，点击登录，不要显示 ide 模式的窗口"）：
	 *   desktop 模式把 IDE 主窗口整个 `hide()` 了；用户在桌面窗口点「登录」⇒ 走 TOF 浏览器流程 ⇒
	 *   **窗口层面**的外部动作（系统把焦点还给本应用的窗口）会把 IDE 主窗口拉到前台 ⇒
	 *   用户看到"冒出一个 IDE 窗口" ✗。只在命令分发处拦**拦不住**（那不是命令）⇒
	 *   只能由**主进程**守着那个窗口：隐藏态下它一旦 show/focus ⇒ 立刻再藏回去 ✓。
	 *
	 * 负载：`IDshSetIdeWindowHiddenArgs`（`{ hidden, windowId }`；`windowId` = 渲染进程的
	 * `nativeHostService.windowId` = Electron 窗口 id ✓）。
	 */
	SetIdeWindowHidden = 'setIdeWindowHidden',
	/** 经控制桥建/接管一个 dsh 会话（方案第 7 章 `session.start`）。 */
	StartSession = 'startSession',
	/** 后台回合（重构 1.4 `session.run`）：投 prompt 并等回合跑完回传结果。 */
	RunSession = 'runSession',
	/** 取消一条会话当前的活动（重构 1.4 `session.cancel`）。 */
	CancelSession = 'cancelSession',
	/** 视图重绑到另一个 dsh 会话（方案 5.15 切 preset；`{ viewId, sessionId }`，主进程校验后推给页面）。 */
	RebindSession = 'rebindSession',
	/** 重命名 dsh 会话（`{ viewId, title }`；主进程校验后推给页面，页面调 `ctx.sessions.rename`）。 */
	RenameSession = 'renameSession',
	/**
	 * IDE 能力请求的**回执**（反向通道 `ide.request`）：renderer 算完经此命令把结果/错误交回主进程
	 * （`{ id, result }` 或 `{ id, error }`）。主进程在 `onIdeRequest` 事件里给出 id。
	 */
	ResolveIdeRequest = 'resolveIdeRequest',
	/**
	 * **认领**一次 IDE 能力请求（renderer → 主进程，`{ id }` → `{ claimed }`）。
	 *
	 * 为什么需要：`OnIdeRequest` 是**广播**（每个窗口各有一份 `DshHarnessService`），没有认领的话
	 * 多窗口会把同一个请求**执行 N 次**（`browser.click` 点 N 下、`canvas.apply_ops` 弹 N 个确认框、
	 * `openFile` 每个窗口各开一个标签页），而只有第一个回执会被采纳——副作用已经发生了。
	 * 认领失败的窗口**不执行、也不回执**；赢家窗口由先到先得决定（单窗口下行为完全不变）。
	 * 实现见 `common/dshIdeClaims.ts`（纯逻辑、可单测）。
	 */
	ClaimIdeRequest = 'claimIdeRequest',
	/** 列出 profile 已装插件（读 profile 清单 + node_modules 实装版本；插件中心底座）。 */
	ListPlugins = 'listPlugins',
	// ─── 插件商城（方案 5.16 批次 2，只读面）：数据来自 Host 的 pluginManager（经控制桥）──
	/** 组合包清单（官方随附 + 已安装 + 每包的行）。 */
	ListDshBundles = 'listDshBundles',
	/** 运行中的插件行（entryId / patchId / 阶段 / 只读原因）。 */
	ListDshPluginRows = 'listDshPluginRows',
	/** 安装源（配置源 + 镜像 + pnpm 自身解析到的源）。 */
	GetDshPluginRegistries = 'getDshPluginRegistries',
	/** 运行态摘要（条目数 / 启用数 / 预设数 / 管理可用性）。 */
	GetDshPluginInventory = 'getDshPluginInventory',
	/**
	 * 组合包启停（`{ name, enabled }`）：Host 运行时走 `pluginManager.setBundleEnabled`（Host 自己的写锁 +
	 * application 语义）；Host 未运行时降级为直接改 profile 的 `dsh.profile.bundles`（同一份真源，同一形态）。
	 */
	SetDshBundleEnabled = 'setDshBundleEnabled',
	/** 行启停（`{ entryId, enabled }`，`pluginManager.setPluginEnabled`）；只有 Host 运行时可做。 */
	SetDshPluginRowEnabled = 'setDshPluginRowEnabled',
	// ─── 插件商城（方案 5.16 批次 4，安装面）：都只有 Host 运行时可用（没有文件兜底）──
	/** 安装前预检一个 spec（`{ spec }`，`pluginManager.inspect`；会查注册表，可能慢）。 */
	InspectDshPlugin = 'inspectDshPlugin',
	/** 安装一个组合包（`{ spec, requestId, approvedBuilds? }`，`pluginManager.installBundle`）。 */
	InstallDshPlugin = 'installDshPlugin',
	/** 取消进行中的安装（`{ requestId }`，`pluginManager.cancelInstall`）。 */
	CancelDshPluginInstall = 'cancelDshPluginInstall',
	/** 卸载组合包（`{ name }`，`pluginManager.removeBundle`）。 */
	RemoveDshPlugin = 'removeDshPlugin',
	// ─── 随包模块插件（仓库 `dsh-plugins/*` 随产品分发；一键安装，2026-10-11）──
	/**
	 * 随包插件清单：每个包的 name / version / 说明 / 模块 id + **profile 里的实装版本**（未装则空）。
	 * 插件中心「随包」段据此显示"可安装 / 已安装 vX / 可升级到 vY"。
	 */
	ListBundledPlugins = 'listBundledPlugins',
	/**
	 * 安装（或升级）一个**随包**插件（`{ name }`）。
	 *
	 * 为什么不复用商城的 `InstallDshPlugin`：那条走 Host 内的 `pluginManager.installBundle`，
	 * spec 是 `file:<路径>`——而**仓库与 profile 常在不同盘符**（开发机：仓库在 G:、userData 在 C:），
	 * pnpm 的 `file:` **跨盘符必失败**（仓库既有结论）。所以这里走主进程：先把包复制进
	 * `<profile>/.vssaros/plugins/<name>-<version>/`，再 `dsh plugin add`——与启动时装伴生插件**同一条路**
	 * （`DshHostSupervisor._ensurePlugin`），版本相同则跳过、版本不同则升级。
	 */
	InstallBundledPlugin = 'installBundledPlugin',
	/**
	 * 安装一个**本地目录**里的插件（`{ spec }`）：主进程暂存 + `dsh plugin add`。
	 *
	 * 为什么单独一条（而不是复用商城的 `InstallDshPlugin`）：后者的安装跑在 Host 内的
	 * `pluginManager`，在**全新 profile** 上会把未被 lockfile 声明的那棵树剪掉（实测 `Packages: -43`）
	 * 并判 `operation-error`——首启用户点"安装"必失败（README 4.86）。本地目录这条路与随包一键安装、
	 * 启动时装伴生插件**同源**，已验证在新 profile 上可用。
	 *
	 * 只收**本地绝对路径**（判定见 `localPluginDir`）；注册表 / git / tarball 仍走商城那条。
	 */
	InstallLocalPlugin = 'installLocalPlugin',
	/**
	 * 按**任意 spec** 安装插件（`{ spec, name }`：注册表 / git / tarball），走主进程 `dsh plugin add`。
	 *
	 * 为什么注册表规格也改走这条（2026-10-13）：商城那条跑在 Host 内的 `pluginManager`，在**全新 profile**
	 * 上会 `operation-error`（剪掉 43 个未声明包，README 4.86）⇒ 首启用户装不上。主进程这条与随包一键安装
	 * 同源、已验证在新 profile 上可用 ✓。
	 *
	 * `name` 必填（装完按它核对版本，spec 形态读不出名字就不敢判"真装上了"✗）；名字由调用方从**预检结果**
	 * 取（`kind: 'registry'` 时一定有 ✓）。能力差：**没有**进度 / 取消 / 构建脚本批准 ⇒ 界面在这条失败时
	 * 回落到商城那条 ✓（选路真源 `agentStudio/common/dshPluginTransport.ts`）。
	 */
	InstallPluginSpec = 'installPluginSpec',
	/**
	 * 装一个**外部发布源**的工作台（`{ url, sha256, name, bytes? }`）：主进程下载 + 校验 sha256
	 * ⇒ 交 `dsh plugin add file:<tgz>`。
	 *
	 * 为什么单独一条（2026-10-22）：`InstallPluginSpec` 只收 spec，**不负责取包** ⇒ 商城登记的
	 * `github-release`（本体在 GitHub Release 上，不在商城服务器）没有取包通道 ✗。
	 * 这条把「下载 → 校验 sha256 → 按 tarball 装」收在主进程：
	 *  - renderer 侧没有 sha256 实现（`vs/base/common` 只有对象 hash）⇒ 算不了 ✗；
	 *  - `marketplace.downloadToFile` 由**外部**内置扩展注册、不在本仓 ⇒ 商城链路不能把它当必需依赖 ✗。
	 *
	 * ⚠ **没有校验就不装**（sha256 缺失/不匹配 ⇒ 拒绝）✓；**只收 https** ✓；体积上限 8 MiB ✓。
	 */
	InstallMarketplaceWorkbench = 'installMarketplaceWorkbench',
	/** 插件清单 + 启停状态 + HMR 状态（插件中心「DSH」页签的渲染数据）。 */
	GetPluginActivation = 'getPluginActivation',
	/** 设置某个插件的启停（`{ name, enabled }`）；返回更新后的清单与 HMR 状态（插件中心开关）。 */
	SetPluginEnabled = 'setPluginEnabled',
	/** 向视图推主题 token 覆盖层（`{ viewId, tokens }`，tokens 经 validateThemeTokens 校验）。 */
	PushTheme = 'pushTheme',
	/**
	 * 向**聊天视图**推 worktree 列表（`{ viewId, options }`，options 经 `validateWorktreeOptions` 校验）。
	 *
	 * 为什么推而不是让页面查：页面桥是**单向**的（`DSH_PAGE_IPC_INVOKE` 只回 `true`/`'pong'`），
	 * 而 worktree 是**宿主侧**的 git 事实（`IWorktreeService`），dsh Host 进程不感知 ⇒ 只能宿主推。
	 * 机制与 `PushTheme` 逐字同款（preload 写 `dataset` + 派 DOM 事件）。
	 */
	PushWorktrees = 'pushWorktrees',
	/**
	 * 向**聊天视图**推 **IDE 工作区记录**（`{ viewId, options }`，options 经 `validateWorkspaceOptions` 校验）。
	 *
	 * 为什么推：dsh 的工作区模型**只能是单目录**，宿主把 IDE 侧一个多根工作区的各根**摊平**成 N 条 dsh
	 * 记录 ⇒ 页面只看 `workspaces.list()` 无法把它们合成"一个工作区 + 各根"（而那正是用户在看的形态）。
	 * IDE 记录（`relatedFolders` / `codeWorkspacePath`）只在渲染进程手里 ⇒ 只能宿主推 ✓。
	 * 机制与 `PushWorktrees` 逐字同款（preload 写 `dataset` + 派 DOM 事件）。
	 */
	PushWorkspaces = 'pushWorkspaces',
	/**
	 * 向视图推 **IDE 登录态**（`{ viewId, auth }`，auth 经 validateAuthOption 校验）。
	 *
	 * 2026-10-21（用户：「窗口中，登录功能，接入 ide 侧的登录，两侧的登录状态要求同步」）：dsh 窗口
	 * 底部那行账号要显示 **IDE 的登录**（TOF/OA）并与 IDE 保持一致 ⇒ 只能宿主推（页面桥单向 ✓）。
	 * ⚠ 载荷只含**展示投影**（signedIn / 登录名 / 工号 / 团队）—— 票据不下发 ✓。
	 */
	PushAuth = 'pushAuth',
	/**
	 * 向视图推**升级状态**（`{ viewId, state }`，state 经 `validateUpgradeState` 校验；2026-10-23）。
	 *
	 * 为什么推：页面桥单向（`invoke` 只回 `true`），而"有哪些可升级 / 应用有没有新版"只在宿主手里
	 * （插件中心 + 更新源）⇒ 只能宿主推。机制与 `PushAuth` 逐字同款（preload 写 `dataset` + 派 DOM 事件）。
	 * 载荷是**全量快照**（不是增量）⇒ 页面整块重画，天然幂等 ✓。
	 */
	PushUpgrade = 'pushUpgrade',
	/** 向视图发「插入文件引用」（`{ viewId, reference }`，reference 经 validateInsertReference 校验）。 */
	InsertReference = 'insertReference',
	/** 同步 VsSaros 已配置的模型 provider 到 dsh（负载经 validateProvidersSyncArgs 校验）。 */
	ProvidersSync = 'providersSync',
	/**
	 * 把 **IDE 侧的企业身份票据**（TOF/OA）同步到 dsh（负载经 validateTofSyncArgs 校验）。
	 *
	 * 2026-10-21（用户："不要用 dsh 官方 DeepSeek 路由，需求是在两侧用 TOF/OA 企业身份（工号 + 票据）实现登录"）：
	 * dsh 侧不另起账号体系，而是**持有同一份企业身份** ⇒ 一次浏览器登录，两边都可用。
	 * 触发时机 = TOF 登录态变化（`ITofAuthService.onDidChangeUser`）＋ 控制桥就绪时补一次。
	 */
	TofSync = 'tofSync',
	/** 查 dsh 侧 CodeBuddy 登录态（2026-10-22：CodeBuddy 已搬到 Host 实现；回执不含 token）。 */
	CodeBuddyStatus = 'codeBuddyStatus',
	/** 把 IDE 扩展里的 CodeBuddy 登录态一次性迁到 dsh 侧（负载经 validateCodeBuddyImportArgs 校验）。 */
	CodeBuddyImport = 'codeBuddyImport',
	/** dsh 侧 LightAI 登录态（无 cookie 值；2026-10-22）。 */
	LightAIStatus = 'lightAIStatus',
	/** 把 IDE 扩展里的 LightAI cookie 一次性迁到 dsh 侧（负载经 validateLightAIImportArgs 校验）。 */
	LightAIImport = 'lightAIImport',
	/** dsh 侧企业身份状态（2026-10-22：TOF 登录归 dsh 侧，IDE 只读；回执没有票据）。 */
	TofStatus = 'tofStatus',
	/** 请 dsh 侧开浏览器登录企业身份（IDE 里的登录入口都走这条）。 */
	TofSignIn = 'tofSignIn',
	/** 请 dsh 侧登出企业身份（用户主动登出）。 */
	TofSignOut = 'tofSignOut',
	/** 取 dsh 侧当前有效票据（商城 JWT 兑换用；只到渲染进程，绝不下发页面）。 */
	TofTicket = 'tofTicket',
}

/** 工作区同步的概览（渲染进程侧同步可读，用于界面显示）。 */
export interface IDshWorkspaceSyncSummary {
	/** 各窗口上报去重后的目录数。 */
	readonly reported: number;
	/** 当前连接上注册成功的目录数。 */
	readonly registered: number;
	/** 被 dsh 拒绝的目录数（如目录不存在）。 */
	readonly rejected: number;
}

export interface IDshWorkspaceSyncState {
	/** 控制桥已连接（否则只记录上报，等连接后注册）。 */
	readonly connected: boolean;
	readonly windows: readonly { readonly windowId: number; readonly paths: readonly string[] }[];
	/** 当前连接上的注册结果；`path` 是 dsh 规范化后的路径，被拒的条目带 `error`。 */
	readonly results: readonly { readonly id?: string; readonly path: string; readonly sessions?: number; readonly error?: string }[];
}

export const enum DshHarnessChannelEvent {
	OnDidChangeStatus = 'onDidChangeStatus',
	/** 页面桥命令、快捷键、焦点（DshPageEvent）；renderer 只处理自己创建的视图。 */
	OnDidPageEvent = 'onDidPageEvent',
	/** 一键准备过程中的进度文本。 */
	OnDidProgress = 'onDidProgress',
	/** 工作区注册结果变化（渲染进程据此刷新显示）。 */
	OnDidWorkspaceSync = 'onDidWorkspaceSync',
	/** 插件启停变化（插件中心开关 → 渲染进程重算模块 ActivityBar，方案 6.4 的 `plugins.changed` 雏形）。 */
	OnDidChangePlugins = 'onDidChangePlugins',
	/**
	 * Host 里的插件请求一项 **IDE 能力**（反向通道 `ide.request`，协议 v2）。
	 * 主进程已做**授权**（能力名合法 + 插件已装 + 该插件清单声明过它）；renderer 负责**执行**，
	 * 算完用 {@link DshHarnessChannelCommand.ResolveIdeRequest} 交回。
	 */
	OnIdeRequest = 'onIdeRequest',
	/** dsh 侧企业身份变了（Host 反向通知 `tof.changed`，主进程转发；不带票据）。 */
	OnDidChangeTof = 'onDidChangeTof',
}
