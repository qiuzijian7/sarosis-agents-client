/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/projectBarPart.css';
import { Part } from '../../../workbench/browser/part.js';
import { IWorkbenchLayoutService, Position } from '../../../workbench/services/layout/browser/layoutService.js';
import { IColorTheme, IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { DisposableStore, isDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { $, addDisposableListener, append, clearNode, Dimension, EventType, getActiveDocument, getWindow } from '../../../base/browser/dom.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ACTIVITY_BAR_BACKGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_BORDER, ACTIVITY_BAR_FOREGROUND, ACTIVITY_BAR_INACTIVE_FOREGROUND } from '../../../workbench/common/theme.js';
import { contrastBorder } from '../../../platform/theme/common/colorRegistry.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { Codicon } from '../../../base/common/codicons.js';
import { codiconsLibrary } from '../../../base/common/codiconsLibrary.js';
import { Lazy } from '../../../base/common/lazy.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { GlobalCompositeBar } from '../../../workbench/browser/parts/globalCompositeBar.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IAction, Action, Separator } from '../../../base/common/actions.js';
import { URI } from '../../../base/common/uri.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IPathService } from '../../../workbench/services/path/common/pathService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { hasWorkspaceFileExtension } from '../../../platform/workspace/common/workspace.js';
import { ILabelService } from '../../../platform/label/common/label.js';
import { basename } from '../../../base/common/resources.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IQuickInputService, IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { getIconRegistry, IconContribution } from '../../../platform/theme/common/iconRegistry.js';
import { defaultInputBoxStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { WorkbenchIconSelectBox } from '../../../workbench/services/userDataProfile/browser/iconSelectBox.js';
import { localize } from '../../../nls.js';
import { AgenticParts } from './parts.js';

const HOVER_GROUP_ID = 'projectbar';
const PROJECT_BAR_FOLDERS_KEY = 'workbench.agentsession.projectbar.folders';

type ProjectBarEntryDisplayType = 'letter' | 'icon';

interface IProjectBarEntryData {
	readonly uri: string;
	readonly displayType?: ProjectBarEntryDisplayType;
	readonly iconId?: string;
}

interface IProjectBarEntry {
	readonly uri: URI;
	readonly name: string;
	displayType: ProjectBarEntryDisplayType;
	iconId?: string;
}

const icons = new Lazy<IconContribution[]>(() => {
	const iconDefinitions = getIconRegistry().getIcons();
	const includedChars = new Set<string>();
	const dedupedIcons = iconDefinitions.filter(e => {
		if (e.id === codiconsLibrary.blank.id) {
			return false;
		}
		if (ThemeIcon.isThemeIcon(e.defaults)) {
			return false;
		}
		if (includedChars.has(e.defaults.fontCharacter)) {
			return false;
		}
		includedChars.add(e.defaults.fontCharacter);
		return true;
	});
	return dedupedIcons;
});

/**
 * ProjectBarPart displays project folder entries stored in workspace storage and allows selection between them.
 * When a folder is selected, the workspace editing service is used to replace the current workspace folder
 * with the selected one. It is positioned to the left of the sidebar and has the same visual style as the activity bar.
 * Also includes global activities (accounts, settings) at the bottom.
 */
export class ProjectBarPart extends Part {

	static readonly ACTION_HEIGHT = 48;

	//#region IView

	readonly minimumWidth: number = 48;
	readonly maximumWidth: number = 48;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	//#endregion

	private content: HTMLElement | undefined;
	private actionsContainer: HTMLElement | undefined;
	private addFolderButton: HTMLElement | undefined;
	private entries: IProjectBarEntry[] = [];
	private _selectedFolderUri: URI | undefined;
	/** 切换工作区诊断日志（延迟解析，见 `_logSwitch`）。 */
	private _switchLogService: ILogService | undefined;
	private readonly globalCompositeBar: GlobalCompositeBar;

	private readonly workspaceEntryDisposables = this._register(new MutableDisposable<DisposableStore>());

	private readonly _onDidSelectWorkspace = this._register(new Emitter<URI | undefined>());
	readonly onDidSelectWorkspace: Event<URI | undefined> = this._onDidSelectWorkspace.event;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IPathService private readonly pathService: IPathService,
		@IHostService private readonly hostService: IHostService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILabelService private readonly labelService: ILabelService,
		@IHoverService private readonly hoverService: IHoverService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(AgenticParts.PROJECTBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);

		// Create the global composite bar for accounts and settings at the bottom
		this.globalCompositeBar = this._register(instantiationService.createInstance(
			GlobalCompositeBar,
			() => this.getContextMenuActions(),
			(theme: IColorTheme) => ({
				activeForegroundColor: theme.getColor(ACTIVITY_BAR_FOREGROUND),
				inactiveForegroundColor: theme.getColor(ACTIVITY_BAR_INACTIVE_FOREGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				activeBackgroundColor: undefined,
				inactiveBackgroundColor: undefined,
				activeBorderBottomColor: undefined,
			}),
			{
				position: () => this.layoutService.getSideBarPosition() === Position.LEFT ? HoverPosition.RIGHT : HoverPosition.LEFT,
			}
		));

		// Load entries from storage
		this.loadEntriesFromStorage();
	}

	private getContextMenuActions(): IAction[] {
		return this.globalCompositeBar.getContextMenuActions();
	}

	private loadEntriesFromStorage(): void {
		const raw = this.storageService.get(PROJECT_BAR_FOLDERS_KEY, StorageScope.WORKSPACE);
		if (raw) {
			try {
				const data: (string | IProjectBarEntryData)[] = JSON.parse(raw);
				this.entries = data.map(item => {
					// Support legacy format (just URIs as strings) and new format (objects with display settings)
					if (typeof item === 'string') {
						const uri = URI.parse(item);
						return { uri, name: basename(uri), displayType: 'letter' as ProjectBarEntryDisplayType };
					} else {
						const uri = URI.parse(item.uri);
						return {
							uri,
							name: basename(uri),
							displayType: item.displayType ?? 'letter',
							iconId: item.iconId
						};
					}
				});
			} catch {
				this.entries = [];
			}
		} else {
			this.entries = [];
		}

		// The selected folder is always the first workspace folder
		const currentFolders = this.workspaceContextService.getWorkspace().folders;
		this._selectedFolderUri = currentFolders.length > 0 ? currentFolders[0].uri : undefined;
	}

	private saveEntriesToStorage(): void {
		const data: IProjectBarEntryData[] = this.entries.map(e => ({
			uri: e.uri.toString(),
			displayType: e.displayType,
			iconId: e.iconId
		}));
		this.storageService.store(PROJECT_BAR_FOLDERS_KEY, JSON.stringify(data), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private addFolderEntry(uri: URI): void {
		// Don't add duplicates
		if (this.entries.some(e => e.uri.toString() === uri.toString())) {
			return;
		}

		this.entries.push({ uri, name: basename(uri), displayType: 'letter' });
		this.saveEntriesToStorage();

		// Select the newly added folder
		this._selectedFolderUri = uri;
		this.saveEntriesToStorage();
		this.applySelectedFolder();
		this._onDidSelectWorkspace.fire(this._selectedFolderUri);

		this.renderContent();
	}

	/**
	 * 打开选中的项目 —— **原生「打开文件夹/工作区」语义**（方案 B' Step 2）。
	 *
	 * ── 为什么不再改 folder 列表 ─────────────────────────────────────
	 * 旧实现是 `updateFolders(0, 当前全部, [选中的一个])`，即「清空再放一个」。
	 * 两个实测后果：
	 *   ① 用户手写多根 `.code-workspace` 打开后，点一下项目栏就被**裁成单根**；
	 *   ② `updateFolders` 在标准 `WorkspaceService` 下会**回写用户的 `.code-workspace` 文件**
	 *      —— 用户资产被一次 UI 点击改掉。
	 *
	 * 正确语义是「换一个工作区」，即 `IHostService.openWindow`：
	 * `.code-workspace` 文件 → `workspaceUri`；普通目录 → `folderUri`。
	 *
	 * `forceReuseWindow: true` 是用户 2026-09-14 的明确裁决（复用当前窗口，
	 * 接受丢失当前编辑器状态），而不是开新窗口。
	 */
	private async applySelectedFolder(): Promise<void> {
		const target = this._selectedFolderUri;
		if (!target) {
			return;
		}

		// 已经是当前工作区就不必重开（重开会白丢一次编辑器状态）。
		const current = this.workspaceContextService.getWorkspace();
		if (current.configuration && this.uriIdentityService.extUri.isEqual(current.configuration, target)) {
			this._logSwitch(`entry=project-bar | action=noop (already current config) | target=${target.fsPath}`);
			return;
		}
		if (!current.configuration
			&& current.folders.length === 1
			&& this.uriIdentityService.extUri.isEqual(current.folders[0].uri, target)) {
			this._logSwitch(`entry=project-bar | action=noop (already current folder) | target=${target.fsPath}`);
			return;
		}

		const toOpen = hasWorkspaceFileExtension(target)
			? { workspaceUri: target }
			: { folderUri: target };

		// ★ 对照组：项目栏这条走 openWindow（forceReuseWindow）⇒ 窗口整体重载 ⇒
		// 原生 Explorer 用新工作区重建 ⇒ sideview 会刷新。
		// 侧栏下拉的三个入口（sidebarPart）只调 setActiveWorkspace，不会走到这里 ——
		// 两条路日志对比即可确认差异。
		this._logSwitch(
			`entry=project-bar | action=openWindow(forceReuseWindow) | target=${target.fsPath} ` +
			`kind=${hasWorkspaceFileExtension(target) ? 'workspaceUri' : 'folderUri'} || ` +
			`window: config=${current.configuration?.fsPath ?? '<none>'} folders=${current.folders.length} ` +
			`[${current.folders.map(f => f.uri.fsPath).join(' | ')}]`,
		);

		await this.hostService.openWindow([toOpen], { forceReuseWindow: true });
	}

	/** 切换工作区诊断日志（前缀 `[WorkspaceSwitch]`，与 `sidebarPart._diag` 同一格式便于合并 grep）。 */
	private _logSwitch(msg: string): void {
		try {
			this._switchLogService ??= this.instantiationService.invokeFunction(accessor => accessor.get(ILogService));
			this._switchLogService.info(`[WorkspaceSwitch] ${msg}`);
		} catch { /* diagnostics must never break the flow */ }
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.content = append(this.element, $('.content'));

		// Create actions container for workspace folders and add button
		this.actionsContainer = append(this.content, $('.actions-container'));

		// Create the UI for workspace folders
		this.renderContent();

		// Create global composite bar at the bottom (accounts, settings)
		this.globalCompositeBar.create(this.content);

		return this.content;
	}

	private renderContent(): void {
		if (!this.actionsContainer) {
			return;
		}

		// Clear existing content
		clearNode(this.actionsContainer);
		this.workspaceEntryDisposables.value = new DisposableStore();

		// Create add folder button
		this.createAddFolderButton(this.actionsContainer);

		// Create workspace folder entries
		this.createWorkspaceEntries(this.actionsContainer);
	}

	private createAddFolderButton(container: HTMLElement): void {
		this.addFolderButton = append(container, $('.action-item.add-folder'));
		const actionLabel = append(this.addFolderButton, $('span.action-label'));

		// Add the plus icon using codicon
		actionLabel.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));

		// Add hover tooltip
		this.workspaceEntryDisposables.value?.add(
			this.hoverService.setupDelayedHover(
				this.addFolderButton,
				{
					appearance: { showPointer: true },
					position: { hoverPosition: HoverPosition.RIGHT },
					content: 'Add Folder to Project'
				},
				{ groupId: HOVER_GROUP_ID }
			)
		);

		// Click handler to add folder
		this.workspaceEntryDisposables.value?.add(
			addDisposableListener(this.addFolderButton, EventType.CLICK, () => {
				this.pickAndAddFolder();
			})
		);

		// Keyboard support
		this.addFolderButton.setAttribute('tabindex', '0');
		this.addFolderButton.setAttribute('role', 'button');
		this.addFolderButton.setAttribute('aria-label', 'Add Folder to Project');
		this.workspaceEntryDisposables.value?.add(
			addDisposableListener(this.addFolderButton, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.pickAndAddFolder();
				}
			})
		);
	}

	private async pickAndAddFolder(): Promise<void> {
		const folders = await this.fileDialogService.showOpenDialog({
			openLabel: 'Add',
			title: 'Add Folder to Project',
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: await this.fileDialogService.defaultFolderPath(),
			availableFileSystems: [this.pathService.defaultUriScheme]
		});

		if (folders?.length) {
			this.addFolderEntry(folders[0]);
		}
	}

	private createWorkspaceEntries(container: HTMLElement): void {
		for (let i = 0; i < this.entries.length; i++) {
			this.createWorkspaceEntry(container, this.entries[i], i);
		}

		// Auto-select first entry if available and none selected
		if (this.entries.length > 0 && this._selectedFolderUri) {
			this._onDidSelectWorkspace.fire(this._selectedFolderUri);
		}
	}

	private createWorkspaceEntry(container: HTMLElement, entry: IProjectBarEntry, index: number): void {
		const entryDisposables = this.workspaceEntryDisposables.value!;

		const entryElement = append(container, $('.action-item.workspace-entry'));
		const actionLabel = append(entryElement, $('span.action-label.workspace-icon'));
		append(entryElement, $('span.active-item-indicator'));

		// Render based on display type
		const folderName = entry.name;
		if (entry.displayType === 'icon' && entry.iconId) {
			// Render codicon
			const icon = ThemeIcon.fromId(entry.iconId);
			actionLabel.classList.add(...ThemeIcon.asClassNameArray(icon));
			actionLabel.classList.add('codicon-icon');
			actionLabel.textContent = '';
		} else {
			// Default: render first letter of folder name
			const firstLetter = folderName.charAt(0).toUpperCase();
			actionLabel.textContent = firstLetter;
		}

		// Set selected state
		const isSelected = this._selectedFolderUri?.toString() === entry.uri.toString();
		if (isSelected) {
			entryElement.classList.add('checked');
		}

		// Build hover content with full path
		const folderPath = this.labelService.getUriLabel(entry.uri, { relative: false });

		// Add hover tooltip with folder name
		entryDisposables.add(
			this.hoverService.setupDelayedHover(
				entryElement,
				{
					appearance: { showPointer: true },
					position: { hoverPosition: HoverPosition.RIGHT },
					content: folderPath
				},
				{ groupId: HOVER_GROUP_ID }
			)
		);

		// Click handler to select workspace
		entryDisposables.add(
			addDisposableListener(entryElement, EventType.CLICK, () => {
				this.selectWorkspace(index);
			})
		);

		// Keyboard support
		entryElement.setAttribute('tabindex', '0');
		entryElement.setAttribute('role', 'button');
		entryElement.setAttribute('aria-label', folderName);
		entryElement.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
		entryDisposables.add(
			addDisposableListener(entryElement, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.selectWorkspace(index);
				}
			})
		);

		// Context menu with customize and remove actions
		entryDisposables.add(
			addDisposableListener(entryElement, EventType.CONTEXT_MENU, (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				const event = new StandardMouseEvent(getWindow(entryElement), e);

				// ★★ 收集本次菜单创建的 Action，菜单关闭即释放（2026-09-15，修 `[LEAKED DISPOSABLE]`）。
				// 同 `sessionHistoryView._showContextMenu` / `knowledgeBaseView` 的 4 处 —— 这是
				// 本仓反复出现的模式 ✗：`Action` 是 `Disposable`，而 `showContextMenu` **不接管**
				// 它们的生命周期 ⇒ 每次右键泄漏若干 Action ✓。
				// ⚠ ① Action 提到 `getActions` **外面**创建（回调可能多次调用 ✗）；
				// ⚠ ② `IAction` 不继承 `IDisposable` ⇒ 必须 `isDisposable()` 守卫 ✓。
				const menuStore = new DisposableStore();
				const menuActions: IAction[] = [
					new Action('projectbar.customize', localize('projectbar.customize', "Customize"), undefined, true, () => this.showCustomizeQuickPick(index)),
					new Separator(),
					new Action('projectbar.removeFolder', localize('projectbar.removeFolder', "Remove Folder"), undefined, true, () => this.removeFolderEntry(index))
				];
				menuActions.forEach(a => { if (isDisposable(a)) { menuStore.add(a); } });

				this.contextMenuService.showContextMenu({
					getAnchor: () => event,
					getActions: () => menuActions,
					// ⚠ `showContextMenu()` 返回 void ⇒ 只能用 delegate 的 `onHide` ✓
					onHide: () => menuStore.dispose(),
				});
			})
		);
	}

	private selectWorkspace(index: number): void {
		if (index < 0 || index >= this.entries.length) {
			return;
		}

		const entry = this.entries[index];
		if (this._selectedFolderUri?.toString() === entry.uri.toString()) {
			return; // Already selected
		}

		this._selectedFolderUri = entry.uri;
		this.saveEntriesToStorage();

		// Re-render to update visual state
		this.renderContent();

		// Apply the selected folder as the workspace folder
		this.applySelectedFolder();

		// Fire selection event
		this._onDidSelectWorkspace.fire(this._selectedFolderUri);
	}

	private removeFolderEntry(index: number): void {
		if (index < 0 || index >= this.entries.length) {
			return;
		}

		const removedUri = this.entries[index].uri;
		this.entries.splice(index, 1);
		this.saveEntriesToStorage();

		// If the removed entry was the selected one, select the first remaining entry
		if (this._selectedFolderUri?.toString() === removedUri.toString()) {
			if (this.entries.length > 0) {
				this._selectedFolderUri = this.entries[0].uri;
				this.applySelectedFolder();
				this._onDidSelectWorkspace.fire(this._selectedFolderUri);
			} else {
				this._selectedFolderUri = undefined;
				this._onDidSelectWorkspace.fire(undefined);
			}
		}

		this.renderContent();
	}

	private async showCustomizeQuickPick(index: number): Promise<void> {
		if (index < 0 || index >= this.entries.length) {
			return;
		}

		const entry = this.entries[index];

		interface ICustomizeQuickPickItem extends IQuickPickItem {
			customType: 'letter' | 'icon';
		}

		const items: ICustomizeQuickPickItem[] = [
			{
				customType: 'letter',
				label: localize('projectbar.customize.letter', "Letter"),
				description: localize('projectbar.customize.letter.description', "Show the first letter of the workspace name")
			},
			{
				customType: 'icon',
				label: localize('projectbar.customize.icon', "Icon"),
				description: localize('projectbar.customize.icon.description', "Choose a codicon to represent the workspace")
			}
		];

		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('projectbar.customize.placeholder', "Choose how to display the workspace in the project bar"),
			title: localize('projectbar.customize.title', "Customize Workspace Appearance")
		});

		if (!picked) {
			return;
		}

		if (picked.customType === 'letter') {
			entry.displayType = 'letter';
			entry.iconId = undefined;
			this.saveEntriesToStorage();
			this.renderContent();
		} else if (picked.customType === 'icon') {
			const icon = await this.pickIcon();
			if (icon) {
				entry.displayType = 'icon';
				entry.iconId = icon.id;
				this.saveEntriesToStorage();
				this.renderContent();
			}
		}
	}

	private async pickIcon(): Promise<ThemeIcon | undefined> {
		const iconSelectBox = this.instantiationService.createInstance(WorkbenchIconSelectBox, {
			icons: icons.value,
			inputBoxStyles: defaultInputBoxStyles
		});

		const dimension = new Dimension(486, 260);
		return new Promise<ThemeIcon | undefined>(resolve => {
			const disposables = new DisposableStore();

			disposables.add(iconSelectBox.onDidSelect(e => {
				resolve(e);
				disposables.dispose();
				iconSelectBox.dispose();
			}));

			iconSelectBox.clearInput();
			const body = getActiveDocument().body;
			const bodyRect = body.getBoundingClientRect();
			const hoverWidget = this.hoverService.showInstantHover({
				content: iconSelectBox.domNode,
				target: {
					targetElements: [body],
					x: bodyRect.left + (bodyRect.width - dimension.width) / 2,
					y: bodyRect.top + this.layoutService.activeContainerOffset.top
				},
				position: {
					hoverPosition: HoverPosition.BELOW,
				},
				persistence: {
					sticky: true,
				},
			}, true);

			if (hoverWidget) {
				disposables.add(hoverWidget);
			}

			iconSelectBox.layout(dimension);
			iconSelectBox.focus();
		});
	}

	get selectedWorkspaceFolder(): URI | undefined {
		return this._selectedFolderUri;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		const background = this.getColor(ACTIVITY_BAR_BACKGROUND) || '';
		container.style.backgroundColor = background;

		const borderColor = this.getColor(ACTIVITY_BAR_BORDER) || this.getColor(contrastBorder) || '';
		container.classList.toggle('bordered', !!borderColor);
		container.style.borderColor = borderColor ? borderColor : '';
	}

	focus(): void {
		// Focus the add folder button (first focusable element)
		this.addFolderButton?.focus();
	}

	focusGlobalCompositeBar(): void {
		this.globalCompositeBar.focus();
	}

	override layout(width: number, height: number): void {
		super.layout(width, height, 0, 0);

		// The global composite bar takes some height at the bottom
		// The actions container will take the remaining space due to CSS flex layout
	}

	toJSON(): object {
		return {
			type: AgenticParts.PROJECTBAR_PART
		};
	}
}
