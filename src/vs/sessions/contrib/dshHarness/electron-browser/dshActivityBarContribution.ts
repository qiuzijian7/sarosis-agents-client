/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 模块 ActivityBar 的动态注册（方案 6.4 / 9.1 的 `dshActivityBarContribution.ts`）。
 *
 * 只在 `sessions.dshHarness.moduleEngine === 'dsh'` 时工作；此时 `agentStudio.contribution.ts` 的
 * 静态 `_registerToolIcon()` 会让位（方案 9.2），两种机制绝不并存 —— 同一容器/视图双注册会抛错
 * 并中断整个工作台加载，所以本文件对"已存在"一律跳过并记日志。
 *
 * 数据来源：
 * - **已激活模块** = profile 已装插件清单（`IDshHarnessService.listPlugins()`，读 profile 的
 *   package.json + node_modules 实装版本，**不需要拉起 Host**，符合方案 6.4"为显示图标不在启动期拉进程"）；
 * - **容器与依赖** = VsSaros 侧的聚合表（`common/dshModuleContainers.ts`，决议①）；
 * - **页面形态** = 决议③默认 page：宿主统一是 `DshPluginViewPane`（`surface=plugin-page` 的
 *   WebContentsView）。**路由不在这一层决定**：共容器的"该显示哪一页"取决于**已激活**哪些模块
 *   （只装 mcp / 只装 memory 时，容器声明的那条路由属于没装的插件 ⇒ 必然 404），由 Pane 经
 *   `IDshHarnessService.resolveModulePage` 现算（表与清单的一致性见源码守卫）。
 *
 * 已知边界（v0）：
 * - 没有清单缓存：`engine=dsh` 时若插件中心尚未安装模块插件，模块图标不会出现（这是口径，不是缺陷）；
 * - 设置改动需重载窗口（与 `chatEngine` 同口径）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILocalizedString } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { DshHarnessSettings, IDshPluginInfo } from '../common/dshHarness.js';
import { containersFromPlugins, DSH_MODULE_CONTAINERS, IDshModuleContainer, planModuleContainers } from '../common/dshModuleContainers.js';
import { IDshHarnessService } from './dshHarnessService.js';
import { AGENT_STUDIO_CODEBASE_VIEW_ID, AGENT_STUDIO_DASHBOARD_VIEW_ID, AGENT_STUDIO_DSH_IMAGEGEN_VIEW_ID, AGENT_STUDIO_DSH_MARKETPLACE_VIEW_ID, AGENT_STUDIO_DSH_PARALLEL_VIEW_ID, AGENT_STUDIO_DSH_SESSIONS_VIEW_ID, AGENT_STUDIO_DSH_STUDIO_VIEW_ID, AGENT_STUDIO_INTEGRATION_VIEW_ID, AGENT_STUDIO_KB_VIEW_ID, AGENT_STUDIO_MEDIA_VIEW_ID, AGENT_STUDIO_MEMORY_VIEW_ID, AGENT_STUDIO_PRESET_AGENT_VIEW_ID, AGENT_STUDIO_SCHEDULER_VIEW_ID, AGENT_STUDIO_TASKS_VIEW_ID, AGENT_STUDIO_WORKFLOW_VIEW_ID } from '../../../common/agentStudioConstants.js';
import { DynamicActivityBarContainers } from '../../agentStudio/browser/dynamicActivityBarContainers.js';
import { DshPluginViewPane } from './dshPluginViewPane.js';
import { DshNativeTreeViewPane } from './dshNativeTreeViewPane.js';

/**
 * 容器 → 视图宿主（UI 层适配）。
 * `planned` 的容器（代码图谱）没有条目：计划里只报告，不注册。
 * 决议③：宿主统一是 `DshPluginViewPane`（`surface=plugin-page`，加载插件自托管路由）；
 * 视图 id 沿用既有注册 id（R1：用户布局 / 视图状态不受影响），容器 id 取自聚合表。
 * **路由不在这里**：它取决于已激活哪些模块，由 Pane 现算（见 `resolveModulePage`）。
 */
interface IModuleViewHost {
	readonly viewId: string;
	readonly ctorDescriptor: SyncDescriptor<ViewPane>;
}

function pageHost(viewId: string, containerId: string): IModuleViewHost {
	// **不再把路由写进 descriptor**：共容器里"该显示哪一页"取决于**已激活**哪些模块
	//（只装 mcp、只装 memory 时，容器声明的那条路由属于没装的插件 ⇒ 必然 404）。
	// 路由由 Pane 在首次可见时向服务要一次（`resolveModulePage`），注册这一步只知道 id。
	return { viewId, ctorDescriptor: new SyncDescriptor(DshPluginViewPane, [containerId]) };
}

/**
 * 已知容器的视图 id 映射（R1：布局/视图状态按 id 持久化，**已有容器的 id 不能改**）。
 * 清单驱动后（重构 1.1）：**新容器不在这张表里也有宿主**——见 {@link moduleViewHostOf} 的派生规则，
 * 新增模块不再需要改壳代码。
 */
const MODULE_VIEW_HOSTS: Readonly<Record<string, IModuleViewHost>> = {
	// 代码图谱：`page-only`（静态/legacy 侧故意没有——那儿的 graphView 是 Git 历史图，见容器表 note）
	'vssaros.dsh.codebase': pageHost(AGENT_STUDIO_CODEBASE_VIEW_ID, 'vssaros.dsh.codebase'),
	// 历史会话的 dsh 页：`page-only`（legacy 侧有**另一个**容器 —— 常驻的 `sessionHistory.view`，见容器表 note）
	'vssaros.dsh.sessions': pageHost(AGENT_STUDIO_DSH_SESSIONS_VIEW_ID, 'vssaros.dsh.sessions'),
	'agentStudio.presetAgent': pageHost(AGENT_STUDIO_PRESET_AGENT_VIEW_ID, 'agentStudio.presetAgent'),
	'agentStudio.tasks': pageHost(AGENT_STUDIO_TASKS_VIEW_ID, 'agentStudio.tasks'),
	'agentStudio.workflow': pageHost(AGENT_STUDIO_WORKFLOW_VIEW_ID, 'agentStudio.workflow'),
	'agentStudio.integration': pageHost(AGENT_STUDIO_INTEGRATION_VIEW_ID, 'agentStudio.integration'),
	'agentStudio.knowledgeBase': pageHost(AGENT_STUDIO_KB_VIEW_ID, 'agentStudio.knowledgeBase'),
	// 2026-10-12（「资料库」拆分）：记忆库独立成格，dsh 引擎下挂插件自托管页 `/x/memory/`。
	'agentStudio.memory': pageHost(AGENT_STUDIO_MEMORY_VIEW_ID, 'agentStudio.memory'),
	// 媒体库同理：插件自托管页 `/x/media/`（只读直连主进程 media.db）。
	'agentStudio.media': pageHost(AGENT_STUDIO_MEDIA_VIEW_ID, 'agentStudio.media'),
	'agentStudio.dashboard': pageHost(AGENT_STUDIO_DASHBOARD_VIEW_ID, 'agentStudio.dashboard'),
	// 定时任务（重构 2.1）：插件自托管页 `/x/scheduler/`。已知容器显式登记 ⇒ 视图 id 稳定（R1）✓。
	'vssaros.dsh.scheduler': pageHost(AGENT_STUDIO_SCHEDULER_VIEW_ID, 'vssaros.dsh.scheduler'),
	// 画布（2026-10-21）：`@vssaros/dsh-imagegen` 的侧栏页（状态 + 「打开画布工作台」）。
	// ⚠ 2026-10-22 补回：这一行在 10-21 23:08 的本地重置里丢失（没有任何快照），按同族条目重写。
	'vssaros.dsh.imagegen': pageHost(AGENT_STUDIO_DSH_IMAGEGEN_VIEW_ID, 'vssaros.dsh.imagegen'),
	// 商城工作台（2026-10-22）：`@vssaros/dsh-marketplace` 的 `/x/marketplace/` 整页。
	// 已知容器显式登记 ⇒ 视图 id 稳定（R1：改 id 会丢用户已存的活动栏布局）✓。
	'vssaros.dsh.marketplace': pageHost(AGENT_STUDIO_DSH_MARKETPLACE_VIEW_ID, 'vssaros.dsh.marketplace'),
	// ★ 2026-10-30：萨罗斯中转站工作台已移除（`@vssaros/dsh-relay` 已卸载）
	//   ⇒ 活动栏里原先的「中转站」条目（`vssaros.dsh.relay`）一并删除。
	// ★ 2026-10-30（守卫「每个可注册容器都备了 page 宿主」抓出来的三个缺口）：parallel / studio / xhs-note
	//   此前一直走 `moduleViewHostOf` 的**派生兜底**（`vssaros.dsh.pv.<containerId>`）—— 能用，但 id 没被显式钉住，
	//   守卫也就看不见。这里把兜底值**原样**登记成显式条目：语义零变化（同一串 id ⇒ 已持久化的布局状态不丢），
	//   但 id 从此是"写下来的"，派生规则将来改字也不会把它们带走。
	'vssaros.dsh.parallel': pageHost(AGENT_STUDIO_DSH_PARALLEL_VIEW_ID, 'vssaros.dsh.parallel'),
	'vssaros.dsh.studio': pageHost(AGENT_STUDIO_DSH_STUDIO_VIEW_ID, 'vssaros.dsh.studio'),
	// ★ 2026-10-30（用户要求「删除小红书工作台」）：`vssaros.dsh.xhs-note` 活动栏条目已删除。
	};

/**
 * **原生宿主注册表**：清单的 `view.viewType` → 该形态在 IDE 侧用的视图 id。
 *
 * 这是"清单能声明什么"与"IDE 实际画什么"之间的**唯一接缝**（新增一种原生形态 = 这里加一行）。
 * 视图 id 必须**沿用**该容器的既有 id（R1：活动栏布局按 id 持久化，换 id = 用户布局丢失）——
 * 所以下面的取值都走 `AGENT_STUDIO_*_VIEW_ID` 常量，而不是现拼一个。
 *
 * ⚠ 只登记**真的实现了原生宿主**的形态。登记了却没有对应树数据源，表现是"图标在、点开空白"，
 *   比降级成插件页更难查 ⇒ 没实现就别往这里写（`nativeViewHostOf` 会如实 warn）。
 */
const NATIVE_VIEW_IDS: Readonly<Record<string, string>> = {
	// Agent 名册（2026-10-30 首个样板）：原生树取代 `?surface=sideview` 的插件网页。
	'vssaros.agents.roster': AGENT_STUDIO_PRESET_AGENT_VIEW_ID,
};

/**
 * 容器 → 视图宿主（清单驱动）。已知容器走 `MODULE_VIEW_HOSTS`（id 稳定 ✓）；
 * **未知容器**（新模块）派生一个确定性的视图 id（`vssaros.dsh.pv.<containerId>`），宿主同样是
 * `DshPluginViewPane`——宿主对任何容器都同形，只是路由不同（由 Pane 向服务现算）。
 */
function moduleViewHostOf(containerId: string): IModuleViewHost {
	return MODULE_VIEW_HOSTS[containerId] ?? pageHost(`vssaros.dsh.pv.${containerId}`, containerId);
}

/**
 * 清单声明 `view.kind=native` 时，这个容器该挂哪个**原生**宿主。
 *
 * ★ 2026-10-30（用户要求「activitybar 中插件的 sideview 改用 vscode 原生的 UI 和功能」）：
 *   此前这里只有 page 一条路 —— 清单写 `native` 也照样被塞进 `DshPluginViewPane`，
 *   于是那个形态从实现上并不存在。现在按 `viewType` 查**原生宿主注册表**：
 *   - 注册表命中 ⇒ 用原生树宿主（不用 WebContentsView）；
 *   - 注册表没命中 ⇒ **如实降级**到插件页并**记日志**（不静默：否则"改完清单没变化"最难查）。
 *
 * 为什么必须保留降级而不是直接不注册：容器消失会连用户已存的活动栏布局一起丢，
 * 而"降级成插件页"至少还能用 —— 但**一定要说出来**，所以下面 warn 里写清该去加哪一条。
 */
function nativeViewHostOf(containerId: string, viewType: string, log: ILogService): IModuleViewHost | undefined {
	const viewId = NATIVE_VIEW_IDS[viewType];
	if (!viewId) {
		log.warn(`[DshActivityBar] 容器 ${containerId} 声明了原生视图 ${viewType}，但 IDE 侧没有对应的原生宿主`
			+ `（需要在该模块的 nativeViewIds 表里登记；可用的有：${Object.keys(NATIVE_VIEW_IDS).join(', ') || '(无)'}）⇒ 降级为插件页`);
		return undefined;
	}
	return { viewId, ctorDescriptor: new SyncDescriptor(DshNativeTreeViewPane, [containerId, viewType]) };
}

/** `title` 支持 `string | { zh, en }`；ActivityBar 只认一个显示名（中文优先）。 */
function localizedTitle(title: string | { readonly zh: string; readonly en: string }): ILocalizedString {
	const value = typeof title === 'string' ? title : title.zh;
	return { value, original: typeof title === 'string' ? title : title.en };
}

/** 清单图标：`codicon:xxx` → ThemeIcon；包内 SVG 路径暂不支持（回落默认图标并记日志）。 */
function themeIconOf(icon: string, log: ILogService, containerId: string): ThemeIcon {
	if (icon.startsWith('codicon:')) {
		return ThemeIcon.fromId(icon.slice('codicon:'.length));
	}
	log.warn(`[DshActivityBar] 容器 ${containerId} 的图标暂不支持包内路径（${icon}），使用默认图标。`);
	return ThemeIcon.fromId('symbol-misc');
}

export class DshActivityBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.dshActivityBar';

	private readonly _contextKeys = new Map<string, IContextKey<boolean>>();
	/** 图标的注册 / 注销 / pinned 残留清理都委托给它（`agentStudio/browser/dynamicActivityBarContainers.ts`）。 */
	private readonly _containers: DynamicActivityBarContainers;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@ILogService private readonly _log: ILogService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		this._containers = new DynamicActivityBarContainers(this._log, storageService);
		if (!this._dshEnabled()) {
			return;
		}
		/*
		 * ★ 2026-10-27（用户要求：「IDE 侧的 activitybar 中，不要显示工作台的页签」）：
		 *   工作台（主页/知识库/商城/…）是**窗口模式**的入口；IDE 侧应当只用
		 *   「sideview + editorpane」这条路径 ⇒ ActivityBar 上不再放这些模块图标。
		 *   做成**设置项**（默认关闭）而不是删代码：切回窗口形态或排查时还能开回来。
		 */
		if (this._configurationService.getValue<boolean>(DshHarnessSettings.WorkbenchInActivityBar) !== true) {
			this._log.info('[DshActivityBar] 工作台入口在 ActivityBar 已关闭（sessions.dshHarness.workbenchInActivityBar=false）⇒ 不注册模块图标');
			return;
		}
		// Host 启动 / 升级后插件集合会变；running 时刷新（不主动拉起进程）。
		this._register(this._dsh.onDidChangeStatus(s => {
			if (s.state === 'running') {
				void this.refresh();
			}
		}));
		// 插件中心的启停开关（方案 6.4 步骤 4）：图标随开关即时增删，不需要重载窗口。
		this._register(this._dsh.onDidChangePlugins(() => void this.refresh()));
		void this.refresh();
	}

	private _dshEnabled(): boolean {
		if (this._configurationService.getValue<boolean>(DshHarnessSettings.Enabled) === false) {
			return false;
		}
		const engine = this._configurationService.getValue<string>(DshHarnessSettings.ModuleEngine);
		if (engine !== 'dsh') {
			this._log.info('[DshActivityBar] moduleEngine=legacy：模块图标由静态注册负责，动态注册不介入。');
			return false;
		}
		return true;
	}

	/** 按当前已装插件重算容器集合并应用差异。 */
	async refresh(): Promise<void> {
		let plugins: readonly IDshPluginInfo[] = [];
		try {
			plugins = await this._dsh.listPlugins();
		} catch (e) {
			this._log.warn(`[DshActivityBar] 读取插件清单失败，保留当前图标：${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		// 清单驱动（重构 1.1）：容器表与插件→模块映射都从已装插件的清单派生；
		// 新增模块插件 ⇒ 壳代码改动为 0（两张硬编码表只作守卫基准，不再是运行期数据源）。
		const containers = containersFromPlugins(plugins);
		const pluginModules = new Map(plugins.filter(p => p.manifest?.module).map(p => [p.name, p.manifest!.module!]));
		const plan = planModuleContainers({
			engine: 'dsh',
			installedPlugins: plugins.map(p => p.name),
			// 插件中心停用（`enabled === false`）的插件视同未激活（方案 4.3「停用」）。
			disabledPlugins: plugins.filter(p => p.enabled === false).map(p => p.name),
			registeredContainerIds: this._containers.ids,
			containers,
			pluginModules,
		});
		for (const id of plan.deregistrations) {
			this._containers.deregister(id);
		}
		for (const container of plan.registrations) {
			this._registerContainer(container);
		}
		for (const pending of plan.pending) {
			this._log.info(`[DshActivityBar] 模块已激活但容器尚无页面，暂不注册：${pending.containerId}`);
		}
		for (const [key, active] of Object.entries(plan.contextKeys)) {
			this._contextKeyOf(key).set(active);
		}
		this._log.info(`[DshActivityBar] 已激活模块：${plan.activeModules.join(', ') || '(无)'}；`
			+ `容器注册 ${this._containers.ids.length} 个，本次 +${plan.registrations.length}/-${plan.deregistrations.length}。`);
	}

	private _contextKeyOf(key: string): IContextKey<boolean> {
		let k = this._contextKeys.get(key);
		if (!k) {
			k = this._contextKeyService.createKey<boolean>(key, false);
			this._contextKeys.set(key, k);
		}
		return k;
	}

	private _registerContainer(container: IDshModuleContainer): void {
		// 清单驱动（1.1）：未知容器也有派生宿主（moduleViewHostOf）——不再是"没有就跳过"。
		//
		// ★ 2026-10-30：原生形态优先。容器清单声明了 `view.kind=native` 就**不走**插件页宿主
		//   （那是 WebContentsView 里的一张网页），改挂 IDE 自己画的原生视图；注册表里没有对应形态时
		//   `nativeViewHostOf` 返回 undefined 并 warn ⇒ 落到下面的 page 分支（降级但不静默）。
		const view = container.view;
		const host = (view?.kind === 'native' ? nativeViewHostOf(container.containerId, view.viewType, this._log) : undefined)
			?? moduleViewHostOf(container.containerId);
		const { containerId, title, icon, order } = container.activityBar;
		// 幂等守卫（双注册会抛 "A view with id ... is already registered" 并中断工作台加载）已在封装内。
		this._containers.register({
			containerId,
			title: localizedTitle(title),
			icon: themeIconOf(icon, this._log, containerId),
			order,
			// 容器壳子由调用方给（封装只认类型，见 dynamicActivityBarContainers.ts 的"依赖面"）。
			containerCtorDescriptor: new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }]),
			viewId: host.viewId,
			viewCtorDescriptor: host.ctorDescriptor,
		});
	}

	/** 诊断用：当前由本贡献注册的容器 id → 视图 id。 */
	describe(): { readonly containerId: string; readonly viewId: string; readonly modules: readonly string[] }[] {
		return this._containers.ids.map(containerId => ({
			containerId,
			viewId: moduleViewHostOf(containerId).viewId,
			modules: DSH_MODULE_CONTAINERS.find(c => c.containerId === containerId)?.modules ?? [],
		}));
	}
}

registerWorkbenchContribution2(DshActivityBarContribution.ID, DshActivityBarContribution, WorkbenchPhase.BlockStartup);
