/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { ActivitybarPart } from '../../../workbench/browser/parts/activitybar/activitybarPart.js';
import { EditorParts as EditorPartsBase } from '../../../workbench/browser/parts/editor/editorParts.js';
import { ViewContainerLocation } from '../../../workbench/common/views.js';
import { IPaneCompositePart } from '../../../workbench/browser/parts/paneCompositePart.js';
import { IAuxiliaryWindowService } from '../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { AgentEditorPart } from './agentEditorPart.js';

/**
 * ★ 模块级实例引用 —— 唯一的用途是绕开「`Workbench` 子类拿不到 DI」这个死结。
 *
 * `workbench/browser/layout.ts` 里**根本没有 `instantiationService`**，所以
 * `AgentLayoutWorkbench`（标准窗口的 Workbench 子类）无法自己
 * `createInstance(AgentEditorPart, ...)`，只能通过本访问器拿到宿主。
 *
 * 成立的前提：本服务是 `InstantiationType.Eager` 的单例，在 InstantiationService
 * 构造时就已实例化，**早于** `Workbench.startup()` 里的 `createWorkbenchLayout()`。
 * 而 `Layout.createAdditionalPartViews()` 恰好在该方法内、`viewMap` 组装之前被调用
 * ⇒ 子类那一次 `agentPart` 访问就是「实例化 + 注册」的时机。
 *
 * `IEditorGroupsService` 本身是 per-window singleton，所以这个引用不会串窗口。
 */
let _instance: AgentEditorParts | undefined;

export function getAgentEditorParts(): AgentEditorParts | undefined {
	return _instance;
}

/**
 * [Saros] 标准窗口（IDE 底座）使用的 `IEditorGroupsService`。
 *
 * ── 与 `sessions/browser/parts/editorParts.ts` 的区别 ────────────────────
 *
 * 那个版本覆写了 `createMainEditorPart()`，把 `MainEditorPart` 换成 sessions
 * 自己的实现（带 Agent 布局的 `layout()` 覆写）。它只适用于 agents 窗口。
 *
 * 本类**不覆写 `createMainEditorPart()`** —— 标准窗口的编辑器区行为完全保持
 * upstream 原样，只额外提供一个 `agentPart`。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * 「IDE 底座 + Agent 布局」要把 agents 那套 grid（`TitleBar / Sidebar /
 * EditorColumn / AgentEditor`）复用到标准窗口。但 `Layout.createWorkbenchLayout()`
 * 是用 `viewMap[type]` 解析 grid 里每个节点的，取到 `undefined` 会让
 * `SerializableGrid.deserialize` **直接抛错**（不是"部件不显示"，是开不了窗）。
 *
 * 所以 grid 里出现的每个 `Parts.*` 都必须先有部件实例。`Part` 基类构造函数
 * 会自动 `layoutService.registerPart(this)`（`workbench/browser/part.ts:60`），
 * 也就是说**「注册」= 「实例化」**，本类的作用就是让 `Parts.AGENT_EDITOR_PART`
 * 有一个可被实例化的宿主。
 *
 * ── 惰性创建（不能在构造函数里建）────────────────────────────────────
 *
 * 基类构造链里刚建完 `mainPart` 就调用 `restoreParts()`，此刻 `_parts` 与
 * scoped instantiation service 尚未就绪；在构造函数里再建第二个 part 会重入。
 * 因此与 sessions 侧一致，改为首次访问 `agentPart` 时才创建并注册。
 *
 * ── 注册顺序（关键）──────────────────────────────────────────────────
 *
 * `registerSingleton` 只往 `_registry` **push、不查重**
 * （`platform/instantiation/common/extensions.ts:32`），而 `ServiceCollection`
 * 是 Map ⇒ **后注册者胜出**。因此本模块必须**晚于**
 * `workbench/browser/parts/editor/editorParts.js` 求值：它由
 * `workbench.desktop.main.ts` 在 `./workbench.common.main.js` 之后导入。
 */
export class AgentEditorParts extends EditorPartsBase {

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService,
		@IAuxiliaryWindowService auxiliaryWindowService: IAuxiliaryWindowService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super(instantiationService, storageService, themeService, auxiliaryWindowService, contextKeyService);

		// 暴露给 `AgentLayoutWorkbench`（见文件头 `getAgentEditorParts()` 的说明）。
		_instance = this;
	}

	/**
	 * ★ 创建 `ActivitybarPart` —— 供 `AgentLayoutWorkbench` 使用（`Layout` 子类**拿不到 DI**）。
	 *
	 * 标准 `SidebarPart` 是**自己**创建 activity bar 的
	 * （`workbench/browser/parts/sidebar/sidebarPart.ts:67`
	 * `this.instantiationService.createInstance(ActivitybarPart, this.location, this)`），
	 * 而 sessions 的 `SidebarPart` **不建**（它把图标条折进了侧栏）
	 * ⇒ agents 布局里 `Parts.ACTIVITYBAR_PART` 从未注册，于是标准 `Layout` 的记账全线炸：
	 * - `createWorkbenchLayout()` 里 `getPart(Parts.ACTIVITYBAR_PART)` 抛 `Unknown part`；
	 * - `getMaximumEditorDimensions()` 读 `activityBarPartView.minimumWidth`（字段未赋值）。
	 */
	createActivityBarPart(paneCompositePart: IPaneCompositePart): ActivitybarPart {
		return this.instantiationService.createInstance(ActivitybarPart, ViewContainerLocation.Sidebar, paneCompositePart);
	}

	/**
	 * ★ 暴露 instantiation service —— 供 `AgentLayoutWorkbench` 取任意服务
	 * （`Layout` 子类拿不到 DI，见文件头 `getAgentEditorParts()` 的说明）。
	 *
	 * 用途（2026-09-15）：聊天框布局持久化需要 `IStorageService` / `ILogService`，
	 * 而 `AgentLayoutWorkbench` 继承的是 upstream `Workbench`，其服务成员不可见
	 * ⇒ 从本类借道 `invokeFunction(accessor => accessor.get(...))` 取。
	 */
	get instantiation(): IInstantiationService {
		return this.instantiationService;
	}

	private _agentPart: AgentEditorPart | undefined;

	get agentPart(): AgentEditorPart {
		if (!this._agentPart) {
			this._agentPart = this._register(this.instantiationService.createInstance(AgentEditorPart, this));
			this._register(this.registerPart(this._agentPart));
		}
		return this._agentPart;
	}
}

registerSingleton(IEditorGroupsService, AgentEditorParts, InstantiationType.Eager);
