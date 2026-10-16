/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 活动栏控制面注册表 —— 让活动栏**外部**（目前是 Dashboard 的「工作台管理」）能在不 import
 * `ActivitybarPart`、也不碰 `IWorkbenchLayoutService` 的前提下操作活动栏容器（pin / 显隐 / 排序）。
 *
 * ── 为什么需要它（而不是注入服务）────────────────────────────────────────
 * `getPart()` / `shouldRenderPart()` 只在 `Layout` 实现类上，**不在 `IWorkbenchLayoutService` 接口**里
 * —— 它们是给 `createWorkbenchLayout()` / `renderWorkbench()` 这类内部代码用的。
 * 与其给服务接口加方法（会波及所有实现类），不如让部件**自己**把能力登记出来：外部只认这份契约。
 *
 * ── 生命周期 ─────────────────────────────────────────────────────────────
 * `ActivitybarPart` 在构造时登记、dispose 时注销（`this._register(...)`）⇒ 从注册表拿到的实例
 * 一定是活的。同窗口同位置只会有一个活动栏，所以键用 {@link ViewContainerLocation} 就够。
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ViewContainerLocation } from '../../../common/views.js';

export interface IActivityBarControl {

	/** 固定在活动栏的顺序（= 活动栏上从左/从上到下的顺序）。 */
	getPinnedPaneCompositeIds(): string[];
	getVisiblePaneCompositeIds(): string[];
	getPaneCompositeIds(): string[];

	/** pin = 固定在活动栏；取消后进底部「…」溢出菜单。 */
	setPaneCompositePinned(compositeId: string, pinned: boolean): void;
	/** 从活动栏完全移除（连溢出菜单一起）/ 恢复。 */
	setPaneCompositeHidden(compositeId: string, hidden: boolean): void;
	/** 把 `compositeId` 移到 `toCompositeId` 之前（`before=false` 为之后）。 */
	movePaneComposite(compositeId: string, toCompositeId: string, before?: boolean): void;
}

const controls = new Map<ViewContainerLocation, IActivityBarControl>();

const _onDidChange = new Emitter<ViewContainerLocation>();
/** 活动栏登记 / 注销时触发（外部可在部件晚于它出现时补做初始化）。 */
export const onDidChangeActivityBarControl: Event<ViewContainerLocation> = _onDidChange.event;

export function registerActivityBarControl(location: ViewContainerLocation, control: IActivityBarControl): IDisposable {
	controls.set(location, control);
	_onDidChange.fire(location);
	return {
		dispose: () => {
			if (controls.get(location) === control) {
				controls.delete(location);
				_onDidChange.fire(location);
			}
		}
	};
}

export function getActivityBarControl(location: ViewContainerLocation = ViewContainerLocation.Sidebar): IActivityBarControl | undefined {
	return controls.get(location);
}
