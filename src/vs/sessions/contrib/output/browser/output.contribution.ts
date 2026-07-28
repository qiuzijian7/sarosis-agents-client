/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	IViewContainersRegistry,
	IViewDescriptor,
	IViewsRegistry,
	ViewContainerLocation,
	Extensions as ViewContainerExtensions,
	WindowEnablement,
} from '../../../../workbench/common/views.js';
import { OUTPUT_VIEW_ID } from '../../../../workbench/services/output/common/output.js';

/**
 * [Sarosis] Sidebar Output 视图容器
 *
 * 背景：
 *   Sarosis 的桌面布局是双栏（Sidebar | Editor），不挂 Panel 区域，
 *   原生 Output 视图被注册到 ViewContainerLocation.Panel，因此用户
 *   按 Ctrl+Shift+U 或在菜单选 View → Output 都看不到面板。
 *
 * 方案：
 *   不破坏原生 Output 服务/逻辑，在 Workbench 启动时把 Output 的
 *   ViewContainer 从 Panel "搬家" 到 Sidebar——通过 deregister + 在
 *   Sidebar 重新 register 的方式（参考 chatDebug.contribution.ts 中
 *   tryMoveView 的模式）。这样 Output 会以一个独立的 Activity Bar
 *   图标出现在最左侧侧边栏图标列中，点击即可像普通侧边栏视图一样展开。
 */

const sidebarOutputViewIcon = registerIcon(
	'sidebar-output-view-icon',
	Codicon.output,
	localize('sidebarOutputViewIcon', 'View icon of the Output view in the sidebar.')
);

class RegisterSidebarOutputViewContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.registerSidebarOutputView';

	constructor() {
		super();

		const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

		// Output 容器是在 output.contribution.ts 同步注册的（OUTPUT_VIEW_ID 同时是容器 id 和视图 id），
		// 此处 BlockRestore 阶段执行时一定已经存在；若不存在则降级监听后续注册事件，做兼容兜底。
		if (!this.tryRelocate(viewContainerRegistry, viewsRegistry)) {
			const listener = viewsRegistry.onViewsRegistered(e => {
				for (const { views } of e) {
					if (views.some(v => v.id === OUTPUT_VIEW_ID)) {
						if (this.tryRelocate(viewContainerRegistry, viewsRegistry)) {
							listener.dispose();
						}
						break;
					}
				}
			});
			this._register(listener);
		}
	}

	private tryRelocate(viewContainerRegistry: IViewContainersRegistry, viewsRegistry: IViewsRegistry): boolean {
		const originalContainer = viewContainerRegistry.get(OUTPUT_VIEW_ID);
		if (!originalContainer) {
			return false;
		}

		const originalView = viewsRegistry.getView(OUTPUT_VIEW_ID);
		if (!originalView) {
			return false;
		}

		// 如果已经在 Sidebar 上了（重复执行/热更新场景），直接 no-op
		// 注：通过 deregister + register 的方式无法直接判定 location，因此用容器 id 后缀做幂等性兜底
		// （这里我们使用一个新的容器 id，所以原始容器存在即未迁移）
		const SIDEBAR_OUTPUT_CONTAINER_ID = OUTPUT_VIEW_ID; // 复用同一个 id，保持原生快捷键/命令兼容
		// 由于复用了原始 id，"原始容器存在" 即代表当前还在 Panel；deregister 后再以同 id 在 Sidebar 重注册。

		// 1. 从原 Panel 容器中摘除 view，并销毁原容器
		viewsRegistry.deregisterViews([originalView], originalContainer);
		viewContainerRegistry.deregisterViewContainer(originalContainer);

		// 2. 在 Sidebar 重新注册一个同 id 的容器
		const sidebarContainer = viewContainerRegistry.registerViewContainer({
			id: SIDEBAR_OUTPUT_CONTAINER_ID,
			title: localize2('output', 'Output'),
			icon: sidebarOutputViewIcon,
			order: 160,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SIDEBAR_OUTPUT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: SIDEBAR_OUTPUT_CONTAINER_ID,
			hideIfEmpty: false,
			openCommandActionDescriptor: {
				id: 'workbench.action.output.toggleOutput',
				mnemonicTitle: localize({ key: 'miToggleOutput', comment: ['&& denotes a mnemonic'] }, '&&Output'),
				keybindings: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyU,
					linux: {
						// 在 Linux 上 Ctrl+Shift+U 可能被全局 OS 命令占用，这里沿用原生 Output 的兜底
						primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyH),
					},
				},
				order: 50,
			},
			windowEnablement: WindowEnablement.Both,
		}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

		// 3. 把原 OutputView 视图重新挂到新容器
		const sidebarView: IViewDescriptor = {
			...originalView,
			canMoveView: false,
			containerIcon: sidebarOutputViewIcon,
		};
		viewsRegistry.registerViews([sidebarView], sidebarContainer);

		return true;
	}
}

registerWorkbenchContribution2(
	RegisterSidebarOutputViewContribution.ID,
	RegisterSidebarOutputViewContribution,
	WorkbenchPhase.BlockRestore
);
