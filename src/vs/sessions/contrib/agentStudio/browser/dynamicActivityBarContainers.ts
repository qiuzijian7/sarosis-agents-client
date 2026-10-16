/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ActivityBar 图标（活动栏上的一格）的**动态注册 / 注销**封装：不重启窗口即时增删。
 *
 * ── 为什么注册一个 ViewContainer 就能让图标进出 ──
 * 上游这条链本来就是自动的，本文件**不新增机制**，只把它包成幂等、可反复全量 diff 的形式：
 *   `IViewContainersRegistry.registerViewContainer / deregisterViewContainer`（workbench/common/views.ts:242-272）
 *     → `ViewDescriptorService.onDidChangeViewContainers`（services/views/browser/viewDescriptorService.ts:110-124）
 *       → `PaneCompositeBar.onDidChangeViewContainers`（browser/parts/paneCompositeBar.ts:238, 259-262）
 *         → `CompositeBar.addComposite / removeComposite`（browser/parts/compositeBar.ts）
 * 所以**不需要 reload**，也**不必碰 `ActivitybarPart`** —— 那个 part 完全被动：
 * 它唯一的刷新入口 `recreateCompositeBar()`（activitybarPart.ts:104-117）只服务于 `activityBar.compact` 配置。
 *
 * ── 上游不替我们做、必须在这里补的两件事 ──
 * 1. **幂等**：容器重复注册对注册表是 no-op（`views.ts:243-246` 直接返回 existing），
 *    但**视图**重复注册会抛 `A view with id ... is already registered` 并**中断整个工作台加载**
 *    ⇒ 注册前必须同时查容器表与视图表。
 * 2. **持久化残留**：注销会同步触发 `PaneCompositeBar.saveCachedViewContainers()`
 *    （`paneCompositeBar.ts:603-631`），把刚注销的 id 以 `visible:false` 写回 pinned 存储（`:562, 626`）。
 *    图标确实不再渲染，但**下次同名容器注册时会在原 order 位置"复活"，且不会重新 pin**
 *    （`:357-360` 命中 storage 缓存）⇒ 注销后要把该 id 从存储里擦掉（见 `_purgeFromStorage`）。
 *
 * ── 用法 ──
 * 构造一次（`new DynamicActivityBarContainers(logService, storageService)`），之后按需
 * `register(options)` / `deregister(containerId)`；差异由调用方决定（现有调用方用
 * `planModuleContainers()` 算）。
 *
 * ── 依赖面（有意为之）──
 * 两个构造描述符都由**调用方**给（封装的默认容器壳子是
 * `new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }])`），
 * 于是本文件对 `workbench/browser/parts/views/*` 只有**类型**依赖（`import type`，编译后被抹掉）
 * ⇒ 它能被单测直接加载（agentStudio 的浏览器测试 runner 没有 CSS 插件，真拉了 browser 层就打包失败）。
 */

import { ThemeIcon } from '../../../../base/common/themables.js';
import { ILocalizedString } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation, WindowEnablement } from '../../../../workbench/common/views.js';
import { purgePinnedViewlets } from './pinnedViewletsStorage.js';

/** ActivityBar 上一格图标的注册参数。 */
export interface IDynamicActivityBarContainerOptions {
	/** 容器 id：图标格的身份，同时用作 view container 的 `storageId`（布局/顺序据此持久化）。 */
	readonly containerId: string;
	/** 显示名（中文优先；`original` 放英文）。 */
	readonly title: ILocalizedString;
	/** 图标。 */
	readonly icon: ThemeIcon;
	/** 顺序，越小越靠上。 */
	readonly order: number;
	/** 容器壳子（点图标后承载侧栏的那一层）；通常 `new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }])`。 */
	readonly containerCtorDescriptor: SyncDescriptor<ViewPaneContainer>;
	/** 容器内那唯一视图的 id。 */
	readonly viewId: string;
	/** 视图构造描述符；需要带参就用 `new SyncDescriptor(Ctor, [args])`。 */
	readonly viewCtorDescriptor: SyncDescriptor<ViewPane>;
	/** 空容器是否隐藏，默认 `false`（空也留着图标）。 */
	readonly hideIfEmpty?: boolean;
}

/**
 * 注销时要擦掉残留的持久化键。
 *
 * **故意写字面量、不 import 两个 part 类**：这两个 part 在本模块被提前求值时一并加载会干扰
 * 启动期的模块求值顺序（`agentEditorParts.ts` 文件头记着这类"后注册者胜出"的坑），
 * 而这些键是**持久化契约**（改名 = 所有用户的 pin 顺序丢失），实际极稳定。
 * 来源：`workbench/browser/parts/activitybar/activitybarPart.ts:54-56`、
 * `sessions/browser/parts/sidebarPart.ts:108-110`（sessions 布局把图标条折进侧栏，另有一套前缀）。
 * 只清 pinned：placeholder / workspaceState 里的残留不会让图标复活，属无害项。
 */
const PINNED_VIEWLET_STORAGE_KEYS: readonly { readonly key: string; readonly scope: StorageScope; readonly target: StorageTarget }[] = [
	{ key: 'workbench.activity.pinnedViewlets2', scope: StorageScope.PROFILE, target: StorageTarget.USER },
	{ key: 'workbench.agentsession.pinnedViewlets2', scope: StorageScope.PROFILE, target: StorageTarget.USER },
];

const LOG_TAG = '[DynamicActivityBar]';

export class DynamicActivityBarContainers {

	private readonly _registered = new Map<string, { readonly container: ViewContainer; readonly viewId: string }>();
	private readonly _viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
	private readonly _viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

	constructor(
		private readonly _log: ILogService,
		private readonly _storage: IStorageService,
	) { }

	/** 已由本封装注册的容器 id（按注册顺序）。 */
	get ids(): readonly string[] {
		return [...this._registered.keys()];
	}

	has(containerId: string): boolean {
		return this._registered.has(containerId);
	}

	/**
	 * 注册一格图标（幂等）。返回是否真的注册了。
	 *
	 * 冲突时**只跳过并记日志**，不抛错：启动期的双注册异常会带着整个工作台一起挂掉。
	 */
	register(options: IDynamicActivityBarContainerOptions): boolean {
		const { containerId, viewId } = options;

		if (this._registered.has(containerId)) {
			this._log.info(`${LOG_TAG} ${containerId} 已由本封装注册，跳过。`);
			return false;
		}

		const existingContainer = this._viewContainersRegistry.get(containerId);
		const existingView = this._viewsRegistry.getView(viewId);
		if (existingContainer || existingView) {
			this._log.warn(`${LOG_TAG} ${containerId} / ${viewId} 已存在（静态注册或上一次未清干净）：`
				+ `容器=${!!existingContainer} 视图=${!!existingView} ⇒ 跳过动态注册。`);
			return false;
		}

		const container = this._viewContainersRegistry.registerViewContainer({
			id: containerId,
			title: options.title,
			icon: options.icon,
			ctorDescriptor: options.containerCtorDescriptor,
			storageId: containerId,
			hideIfEmpty: options.hideIfEmpty ?? false,
			order: options.order,
			// 本 fork：两种窗口（主窗口 / sessions 窗口）都要显示，否则容器在 sessions 窗口恒不可见。
			windowEnablement: WindowEnablement.Both,
		}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

		const descriptor: IViewDescriptor = {
			id: viewId,
			name: options.title,
			ctorDescriptor: options.viewCtorDescriptor,
			canToggleVisibility: false,
			canMoveView: false,
			order: 0,
			windowEnablement: WindowEnablement.Both,
		};
		this._viewsRegistry.registerViews([descriptor], container);

		this._registered.set(containerId, { container, viewId });
		this._log.info(`${LOG_TAG} 已注册 ${containerId}（view=${viewId}, order=${options.order}）。`);
		return true;
	}

	/**
	 * 注销一格图标（幂等），并清掉它在 pinned 存储里的残留。返回是否真的注销了。
	 *
	 * 顺序有意如此：先 `deregisterViewContainer`（它同步触发 PaneCompositeBar 的
	 * `saveCachedViewContainers()` 把死条目写回去），再擦存储 ⇒ 两者叠加后存储才是干净的。
	 */
	deregister(containerId: string): boolean {
		const entry = this._registered.get(containerId);
		if (!entry) {
			return false;
		}

		const view = this._viewsRegistry.getView(entry.viewId);
		if (view) {
			this._viewsRegistry.deregisterViews([view], entry.container);
		}
		this._viewContainersRegistry.deregisterViewContainer(entry.container);
		this._registered.delete(containerId);

		this._purgeFromStorage(containerId);
		this._log.info(`${LOG_TAG} 已注销 ${containerId}。`);
		return true;
	}

	/**
	 * 擦掉该容器在 `workbench.*.pinnedViewlets2` 里的条目。
	 * 过滤本身是纯函数（`pinnedViewletsStorage.ts`，有单测）；这里只管读写与日志——
	 * 任何异常都只记日志：清理失败不能连累注销本身。
	 */
	private _purgeFromStorage(containerId: string): void {
		for (const { key, scope, target } of PINNED_VIEWLET_STORAGE_KEYS) {
			try {
				const purge = purgePinnedViewlets(this._storage.get(key, scope), containerId);
				if (!purge) {
					continue;
				}
				this._storage.store(key, purge.value, scope, target);
				this._log.info(`${LOG_TAG} 已清除 ${key} 中 ${containerId} 的残留（${purge.before} → ${purge.after}）。`);
			} catch (e) {
				this._log.warn(`${LOG_TAG} 清理 ${key} 失败（不影响注销）：${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
}
