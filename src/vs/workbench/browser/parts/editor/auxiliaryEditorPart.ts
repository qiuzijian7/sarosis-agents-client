/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onDidChangeFullscreen } from '../../../../base/browser/browser.js';
import { $, getActiveWindow, hide, show } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, markAsSingleton, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isNative } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { hasCustomTitlebar } from '../../../../platform/window/common/window.js';
import { IEditorGroupView, IEditorPartsView } from './editor.js';
import { EditorPart, IEditorPartUIState } from './editorPart.js';
import { IAuxiliaryTitlebarPart } from '../titlebar/titlebarPart.js';
import { WindowTitle } from '../titlebar/windowTitle.js';
import { IAuxiliaryWindowOpenOptions, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { GroupDirection, GroupsOrder, IAuxiliaryEditorPart, GroupActivationReason, IAuxiliaryEditorSideView } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts, shouldShowCustomTitleBar } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { ITitleService } from '../../../services/title/browser/titleService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IsAuxiliaryWindowContext, IsAuxiliaryWindowFocusedContext, IsCompactTitleBarContext } from '../../../common/contextkeys.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { GroupIdentifier } from '../../../common/editor.js';

export interface IAuxiliaryEditorPartOpenOptions extends IAuxiliaryWindowOpenOptions {
	readonly state?: IEditorPartUIState;

	/** [Saros] Optional left side view rendered next to the editor area. */
	readonly sideView?: IAuxiliaryEditorSideView;
}

export interface ICreateAuxiliaryEditorPartResult {
	readonly part: AuxiliaryEditorPartImpl;
	readonly instantiationService: IInstantiationService;
	readonly disposables: DisposableStore;
}

const compactWindowEmitter = markAsSingleton(new Emitter<{ windowId: number; compact: boolean | 'toggle' }>());

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.toggleCompactAuxiliaryWindow',
			title: localize2('toggleCompactAuxiliaryWindow', "Toggle Window Compact Mode"),
			category: Categories.View,
			f1: true,
			precondition: IsAuxiliaryWindowFocusedContext
		});
	}

	override async run(): Promise<void> {
		compactWindowEmitter.fire({ windowId: getActiveWindow().vscodeWindowId, compact: 'toggle' });
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.enableCompactAuxiliaryWindow',
			title: localize('enableCompactAuxiliaryWindow', "Turn On Compact Mode"),
			icon: Codicon.screenFull,
			menu: {
				id: MenuId.LayoutControlMenu,
				when: ContextKeyExpr.and(IsCompactTitleBarContext.toNegated(), IsAuxiliaryWindowContext),
				order: 0
			}
		});
	}

	override async run(): Promise<void> {
		compactWindowEmitter.fire({ windowId: getActiveWindow().vscodeWindowId, compact: true });
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.disableCompactAuxiliaryWindow',
			title: localize('disableCompactAuxiliaryWindow', "Turn Off Compact Mode"),
			icon: Codicon.screenNormal,
			menu: {
				id: MenuId.LayoutControlMenu,
				when: ContextKeyExpr.and(IsCompactTitleBarContext, IsAuxiliaryWindowContext),
				order: 0
			}
		});
	}

	override async run(): Promise<void> {
		compactWindowEmitter.fire({ windowId: getActiveWindow().vscodeWindowId, compact: false });
	}
});

export class AuxiliaryEditorPart {

	private static STATUS_BAR_VISIBILITY = 'workbench.statusBar.visible';

	/** [Saros] Keep at least this much width for the editor area next to a side view. */
	private static MIN_EDITOR_WIDTH = 320;

	constructor(
		private readonly editorPartsView: IEditorPartsView,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ITitleService private readonly titleService: ITitleService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService
	) {
	}

	async create(label: string, options?: IAuxiliaryEditorPartOpenOptions): Promise<ICreateAuxiliaryEditorPartResult> {
		const that = this;
		const disposables = new DisposableStore();

		let compact = Boolean(options?.compact);

		function computeEditorPartHeightOffset(): number {
			let editorPartHeightOffset = 0;

			if (statusbarVisible) {
				editorPartHeightOffset += statusbarPart.height;
			}

			if (titlebarPart && titlebarVisible) {
				editorPartHeightOffset += titlebarPart.height;
			}

			return editorPartHeightOffset;
		}

		function updateStatusbarVisibility(fromEvent: boolean): void {
			if (statusbarVisible) {
				show(statusbarPart.container);
			} else {
				hide(statusbarPart.container);
			}

			if (fromEvent) {
				auxiliaryWindow.layout();
			}
		}

		function updateTitlebarVisibility(fromEvent: boolean): void {
			if (!titlebarPart) {
				return;
			}

			if (titlebarVisible) {
				show(titlebarPart.container);
			} else {
				hide(titlebarPart.container);
			}

			if (fromEvent) {
				auxiliaryWindow.layout();
			}
		}

		function updateCompact(newCompact: boolean): void {
			if (newCompact === compact) {
				return;
			}

			compact = newCompact;
			auxiliaryWindow.updateOptions({ compact });
			titlebarPart?.updateOptions({ compact });
			editorPart.updateOptions({ compact });

			const oldStatusbarVisible = statusbarVisible;
			statusbarVisible = !compact && that.configurationService.getValue<boolean>(AuxiliaryEditorPart.STATUS_BAR_VISIBILITY) !== false;
			if (oldStatusbarVisible !== statusbarVisible) {
				updateStatusbarVisibility(true);
			}
		}

		// Auxiliary Window
		const auxiliaryWindow = disposables.add(await this.auxiliaryWindowService.open(options));

		// Editor Part
		const editorPartContainer = $('.part.editor', { role: 'main' });
		editorPartContainer.style.position = 'relative';
		auxiliaryWindow.container.appendChild(editorPartContainer);

		const editorPart = disposables.add(this.instantiationService.createInstance(AuxiliaryEditorPartImpl, auxiliaryWindow.window.vscodeWindowId, this.editorPartsView, options?.state, label));
		editorPart.updateOptions({ compact });
		disposables.add(this.editorPartsView.registerPart(editorPart));
		editorPart.create(editorPartContainer);

		const scopedEditorPartInstantiationService = disposables.add(editorPart.scopedInstantiationService.createChild(new ServiceCollection(
			[IEditorService, this.editorService.createScoped(editorPart, disposables)]
		)));

		// Titlebar
		let titlebarPart: IAuxiliaryTitlebarPart | undefined = undefined;
		let titlebarVisible = false;
		const useCustomTitle = isNative && hasCustomTitlebar(this.configurationService); // custom title in aux windows only enabled in native
		if (useCustomTitle) {
			titlebarPart = disposables.add(this.titleService.createAuxiliaryTitlebarPart(auxiliaryWindow.container, editorPart, scopedEditorPartInstantiationService));
			titlebarPart.updateOptions({ compact });
			titlebarVisible = shouldShowCustomTitleBar(this.configurationService, auxiliaryWindow.window, undefined);

			const handleTitleBarVisibilityEvent = () => {
				const oldTitlebarPartVisible = titlebarVisible;
				titlebarVisible = shouldShowCustomTitleBar(this.configurationService, auxiliaryWindow.window, undefined);
				if (oldTitlebarPartVisible !== titlebarVisible) {
					updateTitlebarVisibility(true);
				}
			};

			disposables.add(titlebarPart.onDidChange(() => auxiliaryWindow.layout()));
			disposables.add(this.layoutService.onDidChangePartVisibility(() => handleTitleBarVisibilityEvent()));
			disposables.add(onDidChangeFullscreen(windowId => {
				if (windowId !== auxiliaryWindow.window.vscodeWindowId) {
					return; // ignore all but our window
				}

				handleTitleBarVisibilityEvent();
			}));

			updateTitlebarVisibility(false);
		} else {
			disposables.add(scopedEditorPartInstantiationService.createInstance(WindowTitle, auxiliaryWindow.window));
		}

		// Statusbar
		const statusbarPart = disposables.add(this.statusbarService.createAuxiliaryStatusbarPart(auxiliaryWindow.container, scopedEditorPartInstantiationService));
		let statusbarVisible = !compact && this.configurationService.getValue<boolean>(AuxiliaryEditorPart.STATUS_BAR_VISIBILITY) !== false;
		disposables.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AuxiliaryEditorPart.STATUS_BAR_VISIBILITY)) {
				statusbarVisible = !compact && this.configurationService.getValue<boolean>(AuxiliaryEditorPart.STATUS_BAR_VISIBILITY) !== false;

				updateStatusbarVisibility(true);
			}
		}));

		updateStatusbarVisibility(false);

		// Lifecycle
		const editorCloseListener = disposables.add(Event.once(editorPart.onWillClose)(() => auxiliaryWindow.window.close()));
		disposables.add(Event.once(auxiliaryWindow.onUnload)(() => {
			if (disposables.isDisposed) {
				return; // the close happened as part of an earlier dispose call
			}

			editorCloseListener.dispose();
			editorPart.close();
			disposables.dispose();
		}));
		disposables.add(Event.once(this.lifecycleService.onDidShutdown)(() => disposables.dispose()));
		disposables.add(auxiliaryWindow.onBeforeUnload(event => {
			for (const group of editorPart.groups) {
				for (const editor of group.editors) {
					// Closing an auxiliary window with opened editors
					// will move the editors to the main window. As such,
					// we need to validate that we can move and otherwise
					// prevent the window from closing.
					const canMoveVeto = editor.canMove(group.id, this.editorPartsView.mainPart.activeGroup.id);
					if (typeof canMoveVeto === 'string') {
						group.openEditor(editor);
						event.veto(canMoveVeto);
						return;
					}
				}
			}
		}));

		// [Saros] Optional left side view (used by the Agent Studio chat windows to
		// render a session side bar next to the chat). Appended last so it paints
		// above the editor area; the element positions itself.
		//
		// 2026-09-15：从「仅创建时传入」改为**可运行时挂载** —— 聊天窗口也会经
		// `AUX_WINDOW_GROUP`（会话右键 Open in New Window）或拖拽 tab 出窗口创建，
		// 那两条路径拿不到 `options.sideView`，需要事后补挂。
		let sideViewDisposables = disposables.add(new DisposableStore());
		editorPart.registerSideViewHandler((prev, next) => {
			sideViewDisposables.dispose();
			sideViewDisposables = disposables.add(new DisposableStore());

			if (prev) {
				const prevElement = prev.element as HTMLElement | undefined;
				prevElement?.remove?.();
			}

			if (next) {
				auxiliaryWindow.container.appendChild(next.element as HTMLElement);
				sideViewDisposables.add(next.onDidChange(() => auxiliaryWindow.layout()));
			}

			auxiliaryWindow.layout();
		});

		if (options?.sideView) {
			editorPart.setSideView(options.sideView);
		}

		// Layout: specifically `onWillLayout` to have a chance
		// to build the aux editor part before other components
		// have a chance to react.
		disposables.add(auxiliaryWindow.onWillLayout(dimension => {
			const titlebarPartHeight = titlebarPart?.height ?? 0;
			titlebarPart?.layout(dimension.width, titlebarPartHeight, 0, 0);

			// [Saros] Reserve room for the optional left side view; the editor
			// area is shifted right by the same amount so nothing overlaps.
			// 读 `editorPart.sideView`（而非创建时的局部变量）以支持运行时挂载。
			const sideView = editorPart.sideView;
			const sideViewWidth = sideView ? Math.max(0, Math.min(Math.round(sideView.width), Math.max(0, dimension.width - AuxiliaryEditorPart.MIN_EDITOR_WIDTH))) : 0;
			const editorPartHeight = dimension.height - computeEditorPartHeightOffset();
			sideView?.layout(sideViewWidth, editorPartHeight, titlebarPartHeight, 0);

			// ⚠ 必须移动**编辑器区容器本身**（2026-09-15「侧栏遮挡聊天框」修复）。
			// `Grid.layout()` 的 `top`/`left` 只是「传给子 view 的 layout 原点」
			// （见 base/browser/ui/grid/grid.ts 的注释），**不会移动 grid 容器**。
			// 旧实现只把 left 交给 grid ⇒ 编辑器内容右移了，但 `.part.editor` 容器
			// 仍从 x=0 起算宽度 ⇒ 左侧栏（absolute + z-index）把聊天框左侧盖住。
			// 容器在 create() 里是 `position: relative` ⇒ 这里用 `left` 真正让位，
			// 同时把 grid 的原点归零，避免「容器 + grid」双重偏移。
			editorPartContainer.style.left = `${sideViewWidth}px`;
			editorPart.layout(dimension.width - sideViewWidth, editorPartHeight, titlebarPartHeight, 0);

			statusbarPart.layout(dimension.width, statusbarPart.height, dimension.height - statusbarPart.height, 0);
		}));
		auxiliaryWindow.layout();

		// Compact mode
		disposables.add(compactWindowEmitter.event(e => {
			if (e.windowId === auxiliaryWindow.window.vscodeWindowId) {
				let newCompact: boolean;
				if (typeof e.compact === 'boolean') {
					newCompact = e.compact;
				} else {
					newCompact = !compact;
				}
				updateCompact(newCompact);
			}
		}));

		disposables.add(editorPart.onDidAddGroup(group => {
			updateCompact(false); // leave compact mode when a group is added

			disposables.add(group.onDidActiveEditorChange(() => {
				if (group.count > 1) {
					updateCompact(false); // leave compact mode when more than 1 editor is active
				}
			}));
		}));

		disposables.add(editorPart.activeGroup.onDidActiveEditorChange(() => {
			if (editorPart.activeGroup.count > 1) {
				updateCompact(false); // leave compact mode when more than 1 editor is active
			}
		}));

		// Have a scoped instantiation service that is scoped to the auxiliary window
		const scopedInstantiationService = disposables.add(scopedEditorPartInstantiationService.createChild(new ServiceCollection(
			[IStatusbarService, this.statusbarService.createScoped(statusbarPart, disposables)]
		)));

		return {
			part: editorPart,
			instantiationService: scopedInstantiationService,
			disposables
		};
	}
}

class AuxiliaryEditorPartImpl extends EditorPart implements IAuxiliaryEditorPart {

	private static COUNTER = 1;

	private readonly _onWillClose = this._register(new Emitter<void>());
	readonly onWillClose = this._onWillClose.event;

	private readonly optionsDisposable = this._register(new MutableDisposable());

	private isCompact = false;

	// ── [Saros] 左侧栏（session side view）─────────────────────────────────
	/** 当前挂载的左侧栏。 */
	private _sideView: IAuxiliaryEditorSideView | undefined;
	/** 由 `AuxiliaryEditorPart.create()` 注入的实际 DOM 挂载/卸载实现。 */
	private _sideViewHandler: ((prev: IAuxiliaryEditorSideView | undefined, next: IAuxiliaryEditorSideView | undefined) => void) | undefined;

	get sideView(): IAuxiliaryEditorSideView | undefined {
		return this._sideView;
	}

	setSideView(sideView: IAuxiliaryEditorSideView | undefined): void {
		if (this._sideView === sideView) {
			return;
		}
		const prev = this._sideView;
		this._sideView = sideView;
		this._sideViewHandler?.(prev, sideView);
	}

	/**
	 * [Saros] 由 `AuxiliaryEditorPart.create()` 注入真正的挂载实现 —— 它需要
	 * 访问 auxiliaryWindow 与 create() 作用域内的 disposables。
	 */
	registerSideViewHandler(handler: (prev: IAuxiliaryEditorSideView | undefined, next: IAuxiliaryEditorSideView | undefined) => void): void {
		this._sideViewHandler = handler;
	}

	constructor(
		windowId: number,
		editorPartsView: IEditorPartsView,
		private readonly state: IEditorPartUIState | undefined,
		groupsLabel: string,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		const id = AuxiliaryEditorPartImpl.COUNTER++;
		super(editorPartsView, `workbench.parts.auxiliaryEditor.${id}`, groupsLabel, windowId, instantiationService, themeService, configurationService, storageService, layoutService, hostService, contextKeyService);
	}

	protected override handleContextKeys(): void {
		const isAuxiliaryWindowContext = IsAuxiliaryWindowContext.bindTo(this.scopedContextKeyService);
		isAuxiliaryWindowContext.set(true);

		super.handleContextKeys();
	}

	updateOptions(options: { compact: boolean }): void {
		this.isCompact = options.compact;

		if (options.compact) {
			if (!this.optionsDisposable.value) {
				this.optionsDisposable.value = this.enforcePartOptions({
					showTabs: 'none',
					closeEmptyGroups: true
				});
			}
		} else {
			this.optionsDisposable.clear();
		}
	}

	override addGroup(location: IEditorGroupView | GroupIdentifier, direction: GroupDirection, groupToCopy?: IEditorGroupView): IEditorGroupView {
		if (this.isCompact) {
			// When in compact mode, we prefer to open groups in the main part
			// as compact mode is typically meant for showing just 1 editor.
			location = this.editorPartsView.mainPart.activeGroup;
		}

		return super.addGroup(location, direction, groupToCopy);
	}

	override removeGroup(group: number | IEditorGroupView, preserveFocus?: boolean): void {

		// Close aux window when last group removed
		const groupView = this.assertGroupView(group);
		if (this.count === 1 && this.activeGroup === groupView) {
			this.doRemoveLastGroup(preserveFocus);
		}

		// Otherwise delegate to parent implementation
		else {
			super.removeGroup(group, preserveFocus);
		}
	}

	private doRemoveLastGroup(preserveFocus?: boolean): void {
		const restoreFocus = !preserveFocus && this.shouldRestoreFocus(this.container);

		// Activate next group when closing
		const mostRecentlyActiveGroups = this.editorPartsView.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		const nextActiveGroup = mostRecentlyActiveGroups[1]; // [0] will be the current group we are about to dispose
		if (nextActiveGroup) {
			nextActiveGroup.groupsView.activateGroup(nextActiveGroup, undefined, GroupActivationReason.PART_CLOSE);
		}

		// Deal with focus: focus the next recently used group but skip
		// this if the next group is in the main part and the main part
		// is currently hidden, as that would make it visible.
		if (nextActiveGroup && restoreFocus) {
			const nextGroupInHiddenMainPart = nextActiveGroup.groupsView === this.editorPartsView.mainPart && !this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow);
			if (!nextGroupInHiddenMainPart) {
				nextActiveGroup.focus();
			}
		}

		this.doClose(false /* do not merge any confirming editors to main part */);
	}

	protected override loadState(): IEditorPartUIState | undefined {
		return this.state;
	}

	protected override saveState(): void {
		return; // disabled, auxiliary editor part state is tracked outside
	}

	close(): boolean {
		return this.doClose(true /* merge all confirming editors to main part */);
	}

	private doClose(mergeConfirmingEditorsToMainPart: boolean): boolean {
		let result = true;
		if (mergeConfirmingEditorsToMainPart) {

			// First close all editors that are non-confirming
			for (const group of this.groups) {
				group.closeAllEditors({ excludeConfirming: true });
			}

			// Then merge remaining to main part
			result = this.mergeGroupsToMainPart();
			if (!result) {
				return false; // Do not close when editors could not be merged back
			}
		}

		this._onWillClose.fire();

		return result;
	}

	private mergeGroupsToMainPart(): boolean {
		if (!this.groups.some(group => group.count > 0)) {
			return true; // skip if we have no editors opened
		}

		// Find the most recent group that is not locked
		let targetGroup: IEditorGroupView | undefined = undefined;
		for (const group of this.editorPartsView.mainPart.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
			if (!group.isLocked) {
				targetGroup = group;
				break;
			}
		}

		if (!targetGroup) {
			targetGroup = this.editorPartsView.mainPart.addGroup(this.editorPartsView.mainPart.activeGroup, this.partOptions.openSideBySideDirection === 'right' ? GroupDirection.RIGHT : GroupDirection.DOWN);
		}

		const result = this.mergeAllGroups(targetGroup, {
			// Try to reduce the impact of closing the auxiliary window
			// as much as possible by not changing existing editors
			// in the main window.
			preserveExistingIndex: true
		});
		targetGroup.focus();

		return result;
	}
}
