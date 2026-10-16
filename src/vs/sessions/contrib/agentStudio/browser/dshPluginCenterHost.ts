/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件中心「DSH」来源的数据钩子（方案 4.5 的界面 + 6.4 步骤 1 的启停开关）。
 *
 * 分层约束同 `dshChatHost.ts`：`PluginsViewPane` 在 browser 层、dsh 通道服务在 electron-browser 层，
 * browser **不能** import electron-browser。因此这里只定义接口与注册点，实现在
 * `dshHarness/electron-browser/dshPluginCenterHost.ts` 启动时注入。
 *
 * 未注册（总开关关闭 / 未启用 dsh）时**「DSH」页签不出现**，插件中心保持原样。
 */

import { Event } from '../../../../base/common/event.js';

/** 插件中心一行（已装插件 + VsSaros 侧启停状态 + 内置模块归属）。 */
export interface IDshPluginCenterRow {
	readonly name: string;
	/** 清单里的版本约束。 */
	readonly spec: string;
	/** node_modules 里的实装版本（缺省 = 未装上）。 */
	readonly version?: string;
	readonly enabled: boolean;
	/** Host 运行必需（基础组合 / VsSaros 控制桥）⇒ 开关置灰，不能停用。 */
	readonly undisablable?: boolean;
	/** 内置模块 id（`@vssaros/dsh-kanban` → `kanban`）；第三方插件为 undefined。 */
	readonly module?: string;
	/** 该插件承载的 ActivityBar 容器 id（内置模块取聚合表；第三方插件接上清单后取 `activityBar.containerId`）。 */
	readonly containerId?: string;
}

/**
 * HMR 状态：决定"改完 profile 组合"是热重载还是需重启。
 * `active` 时 dsh-hmr 会在 `dsh.profile.bundles` 变化后串行重载（约 2 秒）。
 */
export type DshPluginCenterHmr = 'active' | 'disabled' | 'unknown';

export interface IDshPluginCenterSnapshot {
	readonly rows: readonly IDshPluginCenterRow[];
	readonly hmr: DshPluginCenterHmr;
}

// ─── 插件商城（方案 5.16 批次 2，只读面）──────────────────────────────────────
// 这些形状与 `common/dshBridgeProtocol.ts` 里的桥视图一一对应（browser 层不 import 协议里的
// dsh 相关类型，只镜像它的数据形状——两边都由 VsSaros 拥有，改一处要一起改）。

/** 组合包声明的一行。 */
export interface IDshBundleRow {
	readonly rowId: string;
	readonly moduleName: string;
	/** 存活条目 id（行级启停的匹配键）。 */
	readonly entryId?: string;
}

/** 一个组合包（官方随附 / 已安装 / 安装提供）。 */
export interface IDshBundle {
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly enabled: boolean;
	readonly installed: boolean;
	/** 官方随附、供开启、不可卸载。 */
	readonly optional: boolean;
	readonly removable: boolean;
	readonly readOnlyReason?: string;
	readonly error?: string;
	readonly rows: readonly IDshBundleRow[];
}

/** 组合包 + 运行行 + 安装源 + 运行态摘要（DSH 页签「官方 / 已安装」两段的数据）。 */
export interface IDshPluginBundlesSnapshot {
	readonly bundles: readonly IDshBundle[];
	readonly pluginRows: readonly {
		readonly entryId: string;
		readonly patchId?: string;
		readonly moduleName?: string;
		readonly enabled?: boolean;
		readonly phase?: string;
		readonly readOnlyReason?: string;
	}[];
	readonly registries?: { readonly registry: string | null; readonly fallbackRegistries: readonly string[]; readonly resolved: string | null };
	readonly inventory?: { readonly entries: number; readonly enabledEntries: number; readonly agentPresets: number; readonly managementAvailable: boolean };
	/** 取数失败的原因（Host 未运行 / 桥不可用）；有值时 `bundles` 为空。 */
	readonly error?: string;
}

export interface IDshPluginCenterSetResult extends IDshPluginCenterSnapshot {
	/** 本次是否真的改了 profile 组合（幂等切换为 false）。 */
	readonly changed: boolean;
	/** 写入通路（方案 5.16 批次 3）：`host` = 经 Host 的 pluginManager；`file` = Host 未运行时的文件兜底。 */
	readonly via?: 'host' | 'file';
	/** Host 给出的应用结果（界面话术的真源）：applied / restart-required / overridden / failed。 */
	readonly application?: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled' | null;
	/** Host 侧错误码（如 `management-required`）。 */
	readonly errorCode?: string;
}

/** 行级启停的结果（写 `cordis.patch.yml` 覆盖项）。 */
export interface IDshPluginRowSetResult {
	readonly changed: boolean;
	readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled' | null;
	readonly target: string;
	readonly errorCode?: string;
	readonly warnings?: readonly string[];
}

// ─── 插件商城（方案 5.16 批次 4，安装面）──────────────────────────────────────
// 与 `common/dshBridgeProtocol.ts` 的桥视图一一对应（browser 层不 import dsh 相关类型，
// 只镜像数据形状——两边都归 VsSaros 所有，改一处要一起改）。

/** 一个安装 spec 的预检结果。 */
export interface IDshInspectResult {
	readonly status: 'accepted' | 'refused';
	readonly kind?: string;
	readonly name?: string;
	readonly version?: string;
	readonly description?: string;
	/** `false` = 装得上但不是组合包（装它没有意义，界面要挡住）；`null` = 这种 spec 形态此刻读不出来。 */
	readonly bundle?: boolean | null;
	readonly registry?: string | null;
	readonly host?: string;
	readonly problem?: string;
	readonly reason?: string;
	readonly registries?: readonly (string | null)[];
}

/** 一次安装/卸载的结果（`application` 是界面话术的真源）。 */
export interface IDshInstallResult {
	readonly changed: boolean;
	readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled' | null;
	readonly stage?: string | null;
	readonly target: string;
	readonly bundle?: string;
	readonly errorCode?: string;
	readonly warnings?: readonly string[];
	readonly exitCode?: number | null;
	readonly failureKind?: string;
	readonly timedOut?: boolean;
	/** 等待显式允许构建脚本的包（pnpm 10 默认拦）——界面据此提供"允许并重试"。 */
	readonly pendingBuilds?: readonly string[];
	readonly registries?: readonly (string | null)[];
	/** pnpm 诊断落盘路径（失败时给用户"日志在哪"）。 */
	readonly logPath?: string;
}

// ─── 随包模块插件（方案 5.16 的补充：一键安装）────────────────────────────────
// 与 `common/dshHarness.ts` 的 `IDshBundledPluginRow` / `IDshBundledInstallResult` 一一对应
// （同一约定：browser 层只镜像形状）。
//
// ⚠ 镜像**必须逐字段跟上**：2026-10-12 给真源加 `state` 时漏了这份镜像 ⇒ 界面读不到新字段
//   （tsgo 报了 8 处 `Property 'state' does not exist` ✗）。现在有守卫钉住两处字段集一致：
//   `dshHarness/test/node/dshBundledPlugins.test.ts` 的"跨层镜像"用例 ✓。

/** 一个随包模块插件的行。 */
export interface IDshBundledPluginRow {
	readonly name: string;
	readonly version: string;
	/** 安装状态（真源在主进程 `mergeBundledWithInstalled`；界面只读，不得自行比较版本 ✗）。 */
	readonly state: 'missing' | 'installed' | 'upgradable' | 'downgradable';
	readonly description?: string;
	/** 模块 id（`vssaros.module`），界面显示"这是哪个模块"。 */
	readonly module?: string;
	/** 随包目录（诊断用；界面不显示）。 */
	readonly dir: string;
	/** profile 里的实装版本；未装则空。 */
	readonly installedVersion?: string;
	/** 已装但被停用。 */
	readonly installedDisabled?: boolean;
}

/** 随包插件安装结果（`ok` 的口径是"目标版本真的在 profile 里了"）。 */
export interface IDshBundledInstallResult {
	readonly name: string;
	readonly ok: boolean;
	readonly bundledVersion: string;
	readonly version?: string;
	readonly previousVersion?: string;
	readonly changed: boolean;
	readonly error?: string;
}

export interface IDshPluginCenterHost {
	/** 顶部状态行：Host 状态 / dsh 版本 / profile / 控制桥（方案 4.6 的"运行时闸门"行）。 */
	statusText(): string;
	/** 插件行 + HMR 状态。 */
	load(): Promise<IDshPluginCenterSnapshot>;
	/**
	 * 启停开关（方案 4.3「停用」/ 5.16 批次 3）：改 profile 组合 `dsh.profile.bundles` 的成员。
	 * 停用只移出组合（依赖与数据保留）；Host 运行时经 `pluginManager.setBundleEnabled`
	 * （结果带 `application`），未运行时降级为文件写（`via: 'file'`，按 `hmr` 提示热重载/重启）。
	 */
	setEnabled(name: string, enabled: boolean): Promise<IDshPluginCenterSetResult>;
	/** 行级启停（写 profile `cordis.patch.yml` 的 disabled 覆盖）；只有 Host 运行时可做。 */
	setRowEnabled(entryId: string, enabled: boolean): Promise<IDshPluginRowSetResult>;
	/**
	 * 组合包清单 + 运行行 + 安装源 + 运行态摘要（方案 5.16 批次 2，只读）。
	 * 数据源是 Host 的 `pluginManager`（经控制桥）；控制桥不可用时返回带 `error` 的空快照
	 * （UI 要能区分"没有插件"与"Host 没起来"）。
	 */
	loadBundles(): Promise<IDshPluginBundlesSnapshot>;
	/**
	 * 安装前预检一个 spec（方案 5.16 批次 4）：注册表名 / **绝对**路径 / git 地址 / tarball。
	 * 会查注册表，慢；失败以 `status: 'refused'` 回来而不是抛（界面要显示原因）。
	 */
	inspectBundle(spec: string): Promise<IDshInspectResult>;
	/**
	 * 安装一个组合包。`requestId` 由调用方生成（`cancelInstall` 与 Host 进度都按它关联）；
	 * `approvedBuilds` 用于 pnpm 10 拦下的构建脚本（先拿到 `pendingBuilds` 再带上重试）。
	 */
	installBundle(spec: string, requestId: string, approvedBuilds?: readonly string[]): Promise<IDshInstallResult>;
	/** 取消进行中的安装。 */
	cancelInstall(requestId: string): Promise<'cancelled' | 'too-late' | 'not-running'>;
	/** 卸载一个 profile 持有的组合包（不可卸载的包 Host 会拒，界面据 `removable` 置灰）。 */
	removeBundle(name: string): Promise<IDshInstallResult>;
	/**
	 * **随包模块插件**清单（`dsh-plugins/*`，随产品分发的那批）：含 profile 里的实装版本，
	 * 界面据此显示"可安装 / 已安装 vX / 可升级到 vY"。
	 */
	listBundledPlugins(): Promise<readonly IDshBundledPluginRow[]>;
	/**
	 * 安装（或升级）一个**随包**插件：走主进程暂存到 profile 再 `dsh plugin add`（跨盘符安全），
	 * 与启动时装伴生插件同一条路。装上了会让模块 ActivityBar 立刻重算。
	 */
	installBundledPlugin(name: string): Promise<IDshBundledInstallResult>;
	/**
	 * 从**本地绝对目录**安装（「添加插件」段里粘本地路径的情况）。
	 *
	 * 与 `installBundledPlugin` 同一条路（主进程暂存 + `dsh plugin add`）——商城的 `installBundle`
	 * 在全新 profile 上会剪掉未被 lockfile 声明的包并判 `operation-error`（首启用户必失败，README 4.86）。
	 * 只接受本地绝对路径；注册表 / git / tarball 仍走 `installBundle`。
	 */
	installLocalPlugin(spec: string): Promise<IDshBundledInstallResult>;
	/**
	 * 按 **spec**（注册表 / git / tarball）安装插件，走主进程 `dsh plugin add`（不经 Host 的 pluginManager）。
	 *
	 * 为什么注册表规格也要这条路（2026-10-13）：商城那条在**全新 profile** 上会 `operation-error`
	 * （剪掉 43 个未声明包，README 4.86）⇒ 首启用户装不上。能力差：无进度 / 取消 / 构建脚本批准
	 * ⇒ 视图在这条失败时回落到 `installBundle` ✓（选路真源 `common/dshPluginTransport.ts`）。
	 *
	 * `name` 必填：装完按它核对实装版本；名字从预检结果取（`kind: 'registry'` 时一定有）。
	 */
	installPluginSpec(spec: string, name: string): Promise<IDshBundledInstallResult>;
	/** 重启 Host（HMR 未启用、或改了已装包版本时用它）。返回结果摘要。 */
	restartHost(): Promise<string>;
	/** 清单或 Host 状态变化（页签据此重绘）。 */
	readonly onDidChange: Event<void>;
}

export type DshPluginCenterHostFactory = () => IDshPluginCenterHost | undefined;

let factory: DshPluginCenterHostFactory | undefined;

/** 由 dshHarness 的 electron-browser 贡献在启动时注册。 */
export function setDshPluginCenterHostFactory(f: DshPluginCenterHostFactory | undefined): void {
	factory = f;
}

/** 当前可用的宿主；未注册或未启用时返回 undefined（页签不显示）。 */
export function getDshPluginCenterHost(): IDshPluginCenterHost | undefined {
	return factory?.();
}
