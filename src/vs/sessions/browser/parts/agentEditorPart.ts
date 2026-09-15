/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { Event } from '../../../base/common/event.js';
import { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorPartCreationOptions, IEditorPartsView } from '../../../workbench/browser/parts/editor/editor.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';

/**
 * [Saros] AgentEditorPart — the second main-window-level EditorPart that
 * hosts the Agent Studio zone (Canvas / Chat) on the right column.
 *
 * It is a thin subclass of the upstream `EditorPart`, identical to the
 * upstream `MainEditorPart` except that it is registered under the
 * dedicated `Parts.AGENT_EDITOR_PART` id instead of `Parts.EDITOR_PART`.
 * The base class already provides a single-grid / single-group layout,
 * which is exactly the Agent zone's initial form — no grid override needed.
 *
 * Physical isolation: because this is a *distinct* Part with its own DOM
 * container and its own editor grid, editors cannot be dragged across the
 * File zone (EDITOR_PART) and the Agent zone (AGENT_EDITOR_PART). Both
 * parts share `mainWindow.vscodeWindowId` (so this is NOT a multi-window /
 * auxiliary part); group→part routing in `EditorParts.getPart(group)`
 * disambiguates them via `part.hasGroup(id)`.
 */
export class AgentEditorPart extends EditorPart {

	constructor(
		editorPartsView: IEditorPartsView,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super(editorPartsView, Parts.AGENT_EDITOR_PART, '', mainWindow.vscodeWindowId, instantiationService, themeService, configurationService, storageService, layoutService, hostService, contextKeyService);

		// [Saros] Show tab bar when multiple editors are open.
		//
		// The Agent zone can host multiple editors (Native Chat, Canvas,
		// TaskBoard, etc.). `showTabs: 'multiple'` shows the tab bar
		// whenever more than one editor is open, keeping the UI clean
		// when only Agent Chat is present.
		//
		// `enforcePartOptions` re-applies on every option recompute, so a
		// later config change can't revert it.
		this.enforcePartOptions({
			showTabs: 'multiple',
			limit: { enabled: false, value: 10, perEditorGroup: false, excludeDirty: false }
		});
	}

	// [Saros] Constrain Agent zone width: prevent the panel from growing
	// wider than 650px or narrower than 450px when dragging the sash.
	override get minimumWidth(): number { return 450; }
	override get maximumWidth(): number { return 650; }

	/**
	 * [Saros] 禁止把 Agent 区网格写进上游的 `editorpart.state`。
	 *
	 * 基类 `Component`（workbench/common/component.ts:25）会给**每个** part 挂
	 * `onWillSaveState → saveState()`，而 `EditorPart.saveState()`
	 * （editorPart.ts:1402-1411）写的是**静态共享 key**
	 * `EditorPart.EDITOR_PART_UI_STATE_STORAGE_KEY = 'editorpart.state'`，
	 * 且**没有** part 维度隔离。于是 File 区（MainEditorPart）与 Agent 区
	 * （本类）互相覆盖同一个 key：Agent 区的 part 创建更晚 → 它的
	 * `onWillSaveState` 监听注册更晚 → 每次 flush 都是 **Agent 区的网格
	 * （含 Chat 页签）盖掉 File 区的网格**。
	 *
	 * 后果（正是"重启后布局不对"的来源）：File 区是
	 * `restorePreviousState: true`，重启时按 `editorpart.state` 恢复，读到的
	 * 却是 Agent 区的网格 → 中栏凭空出现聊天框、用户自己的文件区分屏丢失；
	 * 而 Agent 区自己从不读这个 key（`restorePreviousState: false`），等于
	 * 单向破坏。workbench.ts `_openAgentStudioEditors` 里那段 "Purge stale
	 * Canvas/Chat from the File zone" 就是在给这个互相覆盖擦屁股。
	 *
	 * Agent 区的布局由 `vssaros.agentChatLayout.v1` 单独负责
	 * （workbench.ts `_storeAgentChatLayout` / `_restoreAgentChatLayout`），
	 * 因此这里与 `AuxiliaryEditorPart`（auxiliaryEditorPart.ts:505-507）保持
	 * 同一策略：不写。
	 */
	protected override saveState(): void {
		return; // disabled, Agent zone layout is tracked outside (vssaros.agentChatLayout.v1)
	}

	/**
	 * [Saros] 编辑器组尺寸变化事件（含用户拖动 sash 调整各聊天框宽度）。
	 *
	 * 底层是 grid 的 `onDidChange`（`SplitView` 在视图尺寸/约束变化时触发，
	 * 见 grid.ts:267 + editorPart.ts:1350），供 workbench 节流持久化「聊天框
	 * 布局」。没有它就只能等下一次退出/flush 才可能落盘，异常退出即丢失。
	 *
	 * 注意：`gridWidget` 在 `create()` 之前是 undefined，此时退化为
	 * `Event.None`（调用方在 part 创建完成后才订阅，不受影响）。
	 */
	get onDidChangeGroupSizes(): Event<void> {
		const gridWidget = this.gridWidget;
		return gridWidget ? Event.map(gridWidget.onDidChange, () => { /* 只关心"变了"这一事实，尺寸由 getLayout() 现取 */ }) : Event.None;
	}

	// [Saros] Add a distinguishing class to the part's root element so
	// CSS can target the agent editor's title bar independently of the
	// file editor zone.
	protected override createContentArea(parent: HTMLElement, options?: IEditorPartCreationOptions): HTMLElement {
		const element = super.createContentArea(parent, options);
		// The part's root element gets its classes during create() in the
		// base Part class. We add `agent-editor-part` here so CSS rules
		// like `.agent-editor-part .title` can suppress the tab bar.
		// We must wait a microtask because the base Part.create() populates
		// the element's classList after createContentArea returns.
		queueMicrotask(() => {
			if (this.element) {
				this.element.classList.add('agent-editor-part');
			}
		});
		return element;
	}
}
