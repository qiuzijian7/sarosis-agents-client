/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/sidebar/media/sidebarpart.css';
import './media/sidebarPart.css';
import { IWorkbenchLayoutService, Parts, Position as SideBarPosition } from '../../../workbench/services/layout/browser/layoutService.js';
import { SidebarFocusContext, ActiveViewletContext } from '../../../workbench/common/contextkeys.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { SIDE_BAR_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER, SIDE_BAR_FOREGROUND, SIDE_BAR_DRAG_AND_DROP_BACKGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER } from '../../../workbench/common/theme.js';
import { agentsPanelForeground } from '../../common/theme.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { AnchorAlignment } from '../../../base/browser/ui/contextview/contextview.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { ILifecycleService, LifecyclePhase } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { LayoutPriority } from '../../../base/browser/ui/grid/grid.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';


import { ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { Separator } from '../../../base/common/actions.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';
import { Menus } from '../menus.js';
import { $, append, addDisposableListener, EventType, getWindowId, prepend, clearNode, size, Dimension } from '../../../base/browser/dom.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { ILayoutContentResult } from '../../../workbench/browser/part.js';
import { IWorkspacesService } from '../../../platform/workspaces/common/workspaces.js';
import { IWorkbenchConfigurationService } from '../../../workbench/services/configuration/common/configuration.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { isFullscreen, onDidChangeFullscreen } from '../../../base/browser/browser.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { hasNativeTitlebar, getTitleBarStyle } from '../../../platform/window/common/window.js';
import { isMacintosh, isNative } from '../../../base/common/platform.js';
import { Emitter } from '../../../base/common/event.js';
import { SidebarContentVisibleContext } from '../../common/contextkeys.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IAgentStudioService } from '../../contrib/agentStudio/common/agentStudio.js';
import { IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { joinPath } from '../../../base/common/resources.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from '../../../workbench/services/environment/common/environmentService.js';
import { hasWorkspaceFileExtension, IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { parse as parseJsonc } from '../../../base/common/json.js';
import type { ParseError } from '../../../base/common/json.js';
import { IWindowOpenable } from '../../../platform/window/common/window.js';
import { planWindowOnDeleteWorkspace, workspaceIdentityFromWindow, matchWorkspaceIdentity, IWorkspaceIdentity } from '../../contrib/agentStudio/common/workspaceFolderSyncPolicy.js';
import { URI } from '../../../base/common/uri.js';
import type { Workspace } from '../../contrib/agentStudio/common/types.js';
import { ICodebaseMemoryMcpService, IIndexConfig } from '../../contrib/agentStudio/browser/codebaseMemoryMcpService.js';

/** CSS class names for sidebar content collapsed/expanded states */
const SIDEBAR_CONTENT_COLLAPSED_CLASS = 'sidebar-content-collapsed';
const SIDEBAR_CONTENT_EXPANDED_CLASS = 'sidebar-content-expanded';

/**
 * Sidebar part specifically for agent sessions workbench.
 * This is a simplified version of the SidebarPart for agent session contexts.
 *
 * The sidebar has two visual states:
 *  - **Collapsed**: Only the 48px-wide activity bar icon strip is visible.
 *  - **Expanded**: The icon strip + a content panel are shown side-by-side.
 *
 * The activity bar icon strip is ALWAYS visible (it never collapses).
 * Expansion/collapse is triggered by:
 *  - The titlebar toggle button (ToggleSidebarVisibilityAction)
 *  - Clicking any icon in the activity bar (auto-expands to show the viewlet)
 */
export class SidebarPart extends AbstractPaneCompositePart {

	static readonly activeViewletSettingsKey = 'workbench.agentsession.sidebar.activeviewletid';
	static readonly pinnedViewContainersKey = 'workbench.agentsession.pinnedViewlets2';
	static readonly placeholderViewContainersKey = 'workbench.agentsession.placeholderViewlets';
	static readonly viewContainersWorkspaceStateKey = 'workbench.agentsession.viewletsWorkspaceState';

	/** Visual margin values - sidebar is flush (no card appearance) */
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_BOTTOM = 0;
	static readonly MARGIN_LEFT = 0;
	private static readonly FOOTER_ITEM_HEIGHT = 26;
	private static readonly FOOTER_ITEM_GAP = 4;
	private static readonly FOOTER_VERTICAL_PADDING = 6;
	private static readonly FOOTER_BOTTOM_MARGIN = 2;
	private static readonly FOOTER_BORDER_TOP = 1;

	/** Width constants */
	private static readonly COLLAPSED_WIDTH = 48;
	private static readonly EXPANDED_MIN_WIDTH = 170;
	private static readonly EXPANDED_MAX_WIDTH = 450;
	private static readonly EXPANDED_PREFERRED_WIDTH = 250;

	/**
	 * View container IDs in the "above-separator" (tools) group.
	 * Must match the registered view containers whose order is in the
	 * top group (workspace, search, sourcecontrol: order 10/20/30).
	 */
	private static readonly TOP_GROUP_IDS = new Set([
		'agentStudio.workspace',
		'agentStudio.search',
		'sessions.sourceControl.container',  // SESSIONS_SOURCE_CONTROL_CONTAINER_ID
	]);

	private footerContainer: HTMLElement | undefined;
	private sideBarTitleArea: HTMLElement | undefined;
	private footerToolbar: MenuWorkbenchToolBar | undefined;
	private previousLayoutDimensions: { width: number; height: number; top: number; left: number } | undefined;
	private separatorEl: HTMLElement | undefined;

	/** Last known valid pin order (used to revert invalid drag-and-drop moves). */
	private _lastValidPinOrder: string | undefined = undefined;

	/** Whether the content panel is currently collapsed (icon strip only). */
	private _contentCollapsed: boolean = true;

	/** Context key that tracks whether sidebar content is visible (expanded). */
	private readonly sidebarContentVisibleContextKey!: ReturnType<typeof SidebarContentVisibleContext.bindTo>;

	private readonly _onDidChangeContentCollapsed = new Emitter<boolean>();
	readonly onDidChangeContentCollapsed = this._onDidChangeContentCollapsed.event;

	//#region IView

	// [Saros] Sidebar with activity bar icons + content panel
	// The sidebar can expand to show content when an icon is clicked.
	// Width is dynamic based on collapsed state.
	get minimumWidth(): number {
		return this._contentCollapsed ? SidebarPart.COLLAPSED_WIDTH : SidebarPart.EXPANDED_MIN_WIDTH;
	}
	get maximumWidth(): number {
		return this._contentCollapsed ? SidebarPart.COLLAPSED_WIDTH : SidebarPart.EXPANDED_MAX_WIDTH;
	}
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean { return false; }

	readonly priority: LayoutPriority = LayoutPriority.Low;

	//#endregion

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(
			Parts.SIDEBAR_PART,
			{ hasTitle: true, trailingSeparator: false, borderWidth: () => 0 },
			SidebarPart.activeViewletSettingsKey,
			ActiveViewletContext.bindTo(contextKeyService),
			SidebarFocusContext.bindTo(contextKeyService),
			'sideBar',
			'viewlet',
			SIDE_BAR_TITLE_FOREGROUND,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.Sidebar,
			Extensions.Viewlets,
			Menus.SidebarTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);

		this.sidebarContentVisibleContextKey = SidebarContentVisibleContext.bindTo(contextKeyService);
	}

	get preferredWidth(): number | undefined {
		return this._contentCollapsed ? SidebarPart.COLLAPSED_WIDTH : SidebarPart.EXPANDED_PREFERRED_WIDTH;
	}

	/** Whether the sidebar content panel is currently collapsed. */
	get contentCollapsed(): boolean {
		return this._contentCollapsed;
	}

	override create(parent: HTMLElement): void {
		super.create(parent);

		// Apply initial collapsed state CSS class
		parent.classList.add(SIDEBAR_CONTENT_COLLAPSED_CLASS);

		this.createSidebarToolbar(parent);
		this._injectActivityBarSeparator(parent);
		this._setupActivityBarDragValidation();
		this.createFooter(parent);
	}

	/**
	 * Override openPaneComposite to auto-expand the content panel when
	 * a viewlet icon is clicked while the sidebar is collapsed.
	 */
	override async openPaneComposite(id?: string, focus?: boolean): Promise<import('../../../workbench/browser/panecomposite.js').PaneComposite | undefined> {
		// Auto-expand content panel when user clicks an activity bar icon
		if (this._contentCollapsed) {
			this.setContentCollapsed(false);
		}
		return super.openPaneComposite(id, focus);
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement | undefined {
		const titleArea = super.createTitleArea(parent);
		this.sideBarTitleArea = titleArea;

		if (titleArea) {
			// Add a drag region so the sidebar title area can be used to move the window,
			// matching the titlebar's drag behavior.
			prepend(titleArea, $('div.titlebar-drag-region'));
		}

		// macOS native: the sidebar spans full height and the traffic lights
		// overlay the top-left corner. Add a fixed-width spacer inside the
		// title area to push content horizontally past the traffic lights.
		if (titleArea && isMacintosh && isNative && !hasNativeTitlebar(this.configurationService, getTitleBarStyle(this.configurationService))) {
			const spacer = $('div.window-controls-container');
			spacer.style.width = '70px';
			spacer.style.height = '100%';
			spacer.style.flexShrink = '0';
			spacer.style.order = '-1'; // match global-actions-left order so DOM order is respected
			prepend(titleArea, spacer);

			// Hide spacer in fullscreen (traffic lights are not shown)
			const updateSpacerVisibility = () => {
				spacer.style.display = isFullscreen(mainWindow) ? 'none' : '';
			};
			updateSpacerVisibility();
			this._register(onDidChangeFullscreen(windowId => {
				if (windowId === getWindowId(mainWindow)) {
					updateSpacerVisibility();
				}
			}));
		}

		return titleArea;
	}

	/**
	 * Toggle the sidebar content panel between collapsed and expanded.
	 * The activity bar icon strip always remains visible.
	 */
	toggleContent(): void {
		this.setContentCollapsed(!this._contentCollapsed);
	}

	/**
	 * Set the sidebar content panel to a specific collapsed state.
	 */
	setContentCollapsed(collapsed: boolean): void {
		if (this._contentCollapsed === collapsed) {
			return;
		}

		this._contentCollapsed = collapsed;

		const container = this.getContainer();
		if (container) {
			container.classList.toggle(SIDEBAR_CONTENT_COLLAPSED_CLASS, collapsed);
			container.classList.toggle(SIDEBAR_CONTENT_EXPANDED_CLASS, !collapsed);
		}

		// Update context key
		this.sidebarContentVisibleContextKey.set(!collapsed);

		// Fire event so the workbench can resize the grid
		this._onDidChangeContentCollapsed.fire(collapsed);
	}

	/**
	 * Create the sidebar toolbar — a horizontal bar above the sidebar content.
	 * Contains: collapse/expand button, version label, workspace selector.
	 * These were previously in the titlebar; moving them here gives a cleaner
	 * separation: titlebar = window-level, sidebar toolbar = sidebar-level.
	 */
	private createSidebarToolbar(parent: HTMLElement): void {
		const toolbar = prepend(parent, $('div.sidebar-toolbar'));

		// ── 1. Collapse/Expand button ──
		const toggleBtn = append(toolbar, $('button.sidebar-toolbar-toggle'));
		toggleBtn.setAttribute('aria-label', 'Toggle Sidebar Content');
		toggleBtn.title = 'Toggle Sidebar Content';

		// Use codicon classes for native VS Code sidebar icon
		const toggleIcon = append(toggleBtn, $('span.codicon'));
		toggleIcon.style.fontSize = '14px';
		toggleIcon.style.lineHeight = '1';

		const updateToggleIcon = (collapsed: boolean) => {
			toggleIcon.className = 'codicon ' + (collapsed ? 'codicon-layout-sidebar-left-off' : 'codicon-layout-sidebar-left');
		};

		this._register(addDisposableListener(toggleBtn, EventType.CLICK, () => {
			// Toggle via layoutService to get the full expand/collapse behavior
			// (including viewlet restoration when expanding).
			const isContentVisible = !this._contentCollapsed;
			this.layoutService.setPartHidden(isContentVisible, Parts.SIDEBAR_PART);
		}));

		// Set initial icon based on current collapsed state
		updateToggleIcon(this._contentCollapsed);

		// Update icon when content collapsed state changes
		this._register(this.onDidChangeContentCollapsed(collapsed => {
			updateToggleIcon(collapsed);
		}));

		// ── 2. Version label ──
		// productService.version 在启动时从 product.json 读取（product.ts:28-51），
		// 重新加载窗口即会刷新。与 VS Code 原生行为一致，无需额外异步读取文件。
		const versionLabel = append(toolbar, $('span.sidebar-toolbar-version'));
		let version = '';
		let nameLong = 'VsSaros';
		try {
			const productService = this.instantiationService.invokeFunction(accessor => accessor.get(IProductService));
			version = productService.version || '';
			nameLong = productService.nameLong || 'VsSaros';
		} catch { /* product service not available yet */ }
		versionLabel.textContent = version ? `v${version}` : '';
		versionLabel.title = `${nameLong} v${version}`;

		// ── 3. Custom workspace selector (right-aligned) ──
		this._createWorkspaceSelector(toolbar);
	}

	// ─── Custom Workspace Selector ──────────────────────────────────────────

	private _workspaceSelectorEl: HTMLElement | undefined;
	private _workspaceDropdownEl: HTMLElement | undefined;
	private _workspaceSearchInput: HTMLInputElement | undefined;
	private _workspaceSearchRow: HTMLElement | undefined;
	private _workspaceListEl: HTMLElement | undefined;
	/** 键盘导航当前行（`-1` = 未选中）。 */
	private _workspaceKbIndex = -1;
	private _workspaces: Workspace[] = [];
	/** 进行中的 `_loadWorkspaces()`（并发去重，见该方法注释）。 */
	private _loadingWorkspaces: Promise<void> | undefined;
	/** 去重期间又来了请求 ⇒ 本次结束后补一次，避免吞掉变更。 */
	private _loadingWorkspacesDirty = false;
	/** 启动时是否已尝试过「进入工作区文件态」（每次会话只做一次）。 */
	private _enteredWorkspaceFileOnStartup = false;
	private _activeWorkspaceId: string | undefined;
	private _wsAgentStudioService: IAgentStudioService | undefined;
	private _wsFileDialogService: IFileDialogService | undefined;
	private _wsDialogService: IDialogService | undefined;
	private _diagServices: { logService: ILogService; contextService: IWorkspaceContextService } | undefined;

	/**
	 * 工作区切换诊断日志（前缀 `[WorkspaceSwitch]`，便于 grep）。
	 *
	 * ★ 为什么要专门一套：用户报「切换工作区没有刷新 sideview」。
	 * 侧栏那个文件夹列表是**原生 Explorer**，只由 `onDidChangeWorkspaceFolders`
	 * 驱动；而「切换工作区」在本文件里有**三个入口**，实现各不相同。日志把
	 * 「走了哪个入口」+「窗口当时的 folder 列表」打在同一行 —— 只要前后两行的
	 * `folders=` 完全一致，就证明原生侧**根本没收到变更事件**，刷新链路无责，
	 * 问题在「切换没有真的换工作区」。
	 *
	 * 每条都带 `window:` 后缀（configPath + 全部 root），失败静默 ——
	 * 诊断代码绝不能影响主流程。
	 */
	private _diag(msg: string): void {
		try {
			if (!this._diagServices) {
				this._diagServices = this.instantiationService.invokeFunction(accessor => ({
					logService: accessor.get(ILogService),
					contextService: accessor.get(IWorkspaceContextService),
				}));
			}
			const ws = this._diagServices.contextService.getWorkspace();
			const roots = ws.folders.map(f => f.uri.fsPath);
			this._diagServices.logService.info(
				`[WorkspaceSwitch] ${msg} || window: config=${ws.configuration?.fsPath ?? '<none>'} folders=${roots.length} [${roots.join(' | ')}]`,
			);
		} catch { /* diagnostics must never break the flow */ }
	}

	/**
	 * 把一条 registry 记录翻译成 `openWindow` 的打开参数。
	 *
	 * 两种情况：
	 *   · `path` 指向 `.code-workspace` **文件** → `{ workspaceUri }`，多根天然保留；
	 *   · `path` 是**目录** → 主 root 一个 `folderUri`，每个 `relatedFolder` 再加一个。
	 *
	 * ★ 为什么可以传多个 `folderUri`：main 进程 `getPathsToOpen()` 里有一段专门处理
	 * 「一次打开多个 folder」——当 `urisToOpen` 非空（`isCommandLineOrAPICall = true`）时，
	 * 会把它们**自动合成一个 untitled 多根工作区**
	 * （`windowsMainService.ts:1141-1160`，`createUntitledWorkspace`）。
	 * 这正是「registry 记录 → 窗口多根」的正确通道：不落盘、不改任何用户文件。
	 */
	private _buildWorkspaceOpenables(ws: Workspace, roots: URI[]): IWindowOpenable[] {
		const rawPath = ws.path?.trim();
		if (rawPath && hasWorkspaceFileExtension(URI.file(rawPath))) {
			// path 就是工作区文件 ⇒ 直接开文件，保留它与文件的关联（多根天然保留）。
			return [{ workspaceUri: URI.file(rawPath) }];
		}
		return roots.map(uri => ({ folderUri: uri }));
	}

	/** 当前窗口是否已经就是这个工作区（避免点一下又白重载一次）。 */
	private _isWindowAlreadyOn(openables: IWindowOpenable[]): boolean {
		try {
			const ws = this._diagServices?.contextService.getWorkspace()
				?? this.instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceContextService)).getWorkspace();
			const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

			const targetWorkspace = openables.find(o => 'workspaceUri' in o) as { workspaceUri: URI } | undefined;
			if (targetWorkspace) {
				return !!ws.configuration && norm(ws.configuration.fsPath) === norm(targetWorkspace.workspaceUri.fsPath);
			}

			const wanted = openables
				.filter(o => 'folderUri' in o)
				.map(o => norm((o as { folderUri: URI }).folderUri.fsPath))
				.sort();
			const current = ws.folders.map(f => norm(f.uri.fsPath)).sort();
			return wanted.length > 0
				&& wanted.length === current.length
				&& wanted.every((p, i) => p === current[i]);
		} catch {
			return false;
		}
	}

	/**
	 * **切换工作区 = 打开那个工作区**（用户 2026-09-14 裁决：复用当前窗口）。
	 *
	 * ★★ 为什么必须走 `openWindow` 而不是只调 `setActiveWorkspace`（2026-09-15 实测结论）：
	 * 侧栏那个文件夹列表是**原生 Explorer**（`SessionsExplorerView`），数据源是
	 * `IWorkspaceContextService.getWorkspace().folders`，唯一刷新触发点是
	 * `onDidChangeWorkspaceFolders`。而 `setActiveWorkspace()` 只翻 registry 游标，
	 * **从不碰窗口 folder** ⇒ 该事件永不触发 ⇒ sideview 不刷新。
	 *
	 * 用户提供的日志是铁证：连续 6 次下拉切换，每行 `[WorkspaceSwitch]` 的
	 * `window: config=...code-workspace folders=3 [同样 3 个]` **完全一致**，
	 * 且 `onDidChangeWorkspaceFolders` 出现次数为 **0**。
	 *
	 * 与 `projectBarPart.applySelectedFolder()` 保持一致（那条路本来就对）。
	 */
	private async _switchWorkspace(ws: Workspace, entry: string): Promise<void> {
		if (!this._wsAgentStudioService) { return; }

		const roots = await this._resolveWorkspaceRoots(ws);
		const desc = roots?.map(u => u.fsPath).join(' , ') ?? '<none>';

		// 记录没有 path（尚未绑定目录）⇒ 没有可换的 folder，只能退化为翻游标。
		if (!roots || roots.length === 0) {
			this._diag(`entry=${entry} | action=setActiveWorkspace-only (no resolvable roots) | target=${ws.id} name="${ws.name}" path=${ws.path ?? '<none>'}`);
			await this._wsAgentStudioService.setActiveWorkspace(ws.id);
			return;
		}

		// 先把 lastActive 持久化：即使下面走 openWindow 会重载 renderer，
		// 新 renderer 的 `resolveDefaultActiveWorkspaceId()` 也要靠它把选中态接上。
		try {
			await this._wsAgentStudioService.setActiveWorkspace(ws.id);
		} catch (err) {
			this._diag(`entry=${entry} | warn: setActiveWorkspace failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		// 同步「记住的上次工作区」：否则重启后窗口回落到旧的 remembered 路径
		// （可能是单目录），与本次切换不一致。优先写 `.code-workspace` 文件
		// （重启后 WORKSPACE 态、设置原生生效），没有才写主目录。
		const rememberedUri = (ws.codeWorkspacePath && hasWorkspaceFileExtension(ws.codeWorkspacePath))
			? URI.file(ws.codeWorkspacePath)
			: (roots.at(0) ?? undefined);
		if (rememberedUri) {
			await this._writeRememberedUserWorkspace(rememberedUri);
		}

		// ── 首选：若记录来自某个 `.code-workspace` **文件**，走原生 `enterWorkspace` ──
		//
		// 相对纯内存替换的收益（2026-09-15 实测的痛点）：
		//   · 该文件里的 `settings`（`files.exclude` / `search.exclude` / …）**原生生效**
		//     —— 窗口的工作区就是这个文件。纯内存替换时窗口仍是 FOLDER 态
		//     （`config=<none>`），工作区设置完全不生效（`node_modules`/`out`/`.codebuddy` 全可见 ✗）；
		//   · 多根直接来自文件（不依赖 relatedFolders 的完整性）；
		//   · 窗口身份 = 该文件 ⇒ storage / Open Recent 与用户意图一致。
		//
		// ★ 原生 `enterWorkspace()` **不重载窗口**（`workspaceEditingService.ts:178-211`）：
		//   停扩展宿主 → `configurationService.initialize(新标识)` → storage 迁移 → 重启扩展宿主；
		//   只有 remote 才 `hostService.reload()`。代价：扩展宿主重启一次（原生语义，与
		//   真实 VS Code 在同窗口切换工作区一致）。
		//   文件缺失 / 进入失败 ⇒ 回退内存替换（继续，不静默退出）。
		if (ws.codeWorkspacePath && hasWorkspaceFileExtension(ws.codeWorkspacePath)) {
			const entered = await this._enterWorkspaceFile(URI.file(ws.codeWorkspacePath), entry, ws.id);
			if (entered) {
				// 让「记住的上次工作区」与本次选择一致 ⇒ 重启后窗口直接以该文件打开
				// （WORKSPACE 态，设置原生生效），而不是回落到单目录。
				await this._writeRememberedUserWorkspace(URI.file(ws.codeWorkspacePath));
				return;
			}
		}

		// ── 次选：内存内整体替换 folder 列表（★ 不重载窗口、不写任何文件）──
		//
		// 用户 2026-09-15 裁决：切换工作区**不要重新加载窗口**。VS Code「打开工作区」
		// 必然重载，所以只能原地改 folder；而原地改的既有通道要么回写用户的
		// `.code-workspace`、要么在单文件夹窗口下重载（见
		// `WorkspaceService.replaceWorkspaceFoldersInMemory()` 的说明）。
		// 该接缝在标准 IDE 窗口里不存在 ⇒ 鸭子类型探测失败时回退 openWindow。
		const replaceInMemory = this._getInMemoryFolderReplacer();
		if (replaceInMemory) {
			this._diag(`entry=${entry} | action=replaceWorkspaceFoldersInMemory (no reload, no file write) | target=${ws.id} name="${ws.name}" roots=${roots.length} [${desc}]`);
			try {
				await replaceInMemory(roots.map(uri => ({ uri })));
			} catch (err) {
				this._diag(`entry=${entry} | error: in-memory replace failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}

		// ── 回退：开窗口（会重载）。仅在拿不到内存接缝时使用 ──
		const openables = this._buildWorkspaceOpenables(ws, roots);
		if (this._isWindowAlreadyOn(openables)) {
			this._diag(`entry=${entry} | action=noop (window already on this workspace) | target=${ws.id}`);
			return;
		}

		this._diag(`entry=${entry} | action=openWindow(forceReuseWindow) [FALLBACK: no in-memory replacer] | target=${ws.id} roots=${roots.length} [${desc}]`);
		try {
			const hostService = this.instantiationService.invokeFunction(accessor => accessor.get(IHostService));
			await hostService.openWindow(openables, { forceReuseWindow: true });
		} catch (err) {
			this._diag(`entry=${entry} | error: openWindow failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * 解析一条 registry 记录对应的**全部** root（顺序即显示顺序）。
	 *
	 * · `path` 指向 `.code-workspace` **文件** → 读文件（**JSONC**）取它声明的所有 folder；
	 * · `path` 是**目录** → 它自己 + 所有 `relatedFolders`。
	 *
	 * 返回 `undefined` 表示无法解析（没有 path / 读文件失败）。
	 */
	private async _resolveWorkspaceRoots(ws: Workspace): Promise<URI[] | undefined> {
		const rawPath = ws.path?.trim();
		if (!rawPath) {
			return undefined;
		}

		const primary = URI.file(rawPath);

		// ★★★ 2026-09-15：**显式身份字段优先于路径形态判断**。
		//
		// 原先只在 `path` **本身就是** `.code-workspace` 文件时才去解析文件。但记录里
		// `path` 存的是**主 root 目录**（`.sarosworkspace` 要落在真实目录里），工作区文件
		// 路径在 `codeWorkspacePath` 里 ⇒ 文件**被完全忽略** ✗。
		//
		// 后果（用户 2026-09-15 报「应该是 3 个目录，为什么只显示 2 个」）：
		// 一旦 `relatedFolders` 被任何一次窄化写少一个，root 集合就**再也回不来** ——
		// 明明有那个声明了 3 个根的文件，却没人去读它。自愈只补身份、不补 root，
		// 正是因为这里读不到文件。
		//
		// 现在：`codeWorkspacePath` 存在 ⇒ **它就是 root 的权威来源**（文件声明什么就是什么）。
		const filePath = (ws.codeWorkspacePath && hasWorkspaceFileExtension(ws.codeWorkspacePath))
			? ws.codeWorkspacePath
			: (hasWorkspaceFileExtension(primary) ? primary.fsPath : undefined);

		if (filePath) {
			try {
				const fileService = this.instantiationService.invokeFunction(a => a.get(IFileService));
				const { primaryPath, extraFolders } = await this._resolveCodeWorkspaceFolders(URI.file(filePath), fileService);
				const paths = [primaryPath, ...extraFolders.map(f => f.path)].filter((p): p is string => !!p);
				if (paths.length > 0) {
					return paths.map(p => URI.file(p));
				}
				// 文件存在但没解析出任何 folder ⇒ 落到下面的 path+relatedFolders 兜底。
			} catch (err) {
				// ⚠ 文件缺失/不可读时**必须继续兜底**，不能直接 return undefined ——
				// 否则一个被删掉的工作区文件会让整个工作区彻底没有 root。
				this._diag(`warn: resolve roots from ${filePath} failed, falling back to path+relatedFolders: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const roots: URI[] = [primary];
		for (const related of ws.relatedFolders ?? []) {
			if (related?.path) {
				roots.push(URI.file(related.path));
			}
		}
		return roots;
	}

	/** 当前窗口的 root 列表（用于子集判定与日志）。 */
	private _getWindowRoots(): URI[] {
		try {
			const contextService = this.instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceContextService));
			return contextService.getWorkspace().folders.map(f => f.uri);
		} catch {
			return [];
		}
	}

	/**
	 * ★★ 启动时把「当前 Agent Studio 工作区」的**完整 root 集合**应用到窗口。
	 *
	 * ── 为什么需要 ────────────────────────────────────────────────────
	 * 窗口的启动工作区来自 main 进程的 `last-user-workspace.json`，那里只存**一个路径**
	 * （用户实测：`g:\SarosWorkspace\sarosis-agents-client` 这个**目录**）。而该
	 * Agent Studio 工作区还有 2 个 `relatedFolders`。不补这一步，就会出现
	 * 「侧栏选择器写着某工作区、下面只显示 1 个根」，每次重启都要手动再选一次才对齐。
	 *
	 * ── 保守闸门（**必须保留**）──────────────────────────────────────
	 * 只有当窗口当前的 root 集合是目标工作区 root 集合的**子集**、且确实更小时才应用：
	 *   · 窗口打开的就是该工作区的主目录 ⇒ 扩成完整多根 ✓（用户报的场景）；
	 *   · 窗口打开的是**另一个**工作区 / 用户显式打开的 `.code-workspace`
	 *     ⇒ 不是子集 ⇒ **完全不动** ✓
	 *     （避免"用户显式打开的工作区被 Agent Studio 记录覆盖"）。
	 *
	 * 只走内存替换（`replaceWorkspaceFoldersInMemory`）：不重载窗口、不写任何文件。
	 * 拿不到该能力（标准 IDE 窗口）时直接返回。
	 */
	private async _applyActiveWorkspaceRootsOnStartup(): Promise<void> {
		const activeId = this._activeWorkspaceId;
		if (!activeId) {
			return;
		}
		const ws = this._workspaces.find(w => w.id === activeId);
		if (!ws) {
			return;
		}

		// ★★★ 2026-09-15（用户裁决）：记录带 `.code-workspace` 文件 ⇒ 启动时**直接进入文件态**。
		// 进入成功后 root 与 settings 都由文件决定 ⇒ 下面的内存替换就是多余的。
		if (await this._tryEnterActiveWorkspaceFileOnStartup(ws)) {
			return;
		}

		const replacer = this._getInMemoryFolderReplacer();
		if (!replacer) {
			return;
		}

		const roots = await this._resolveWorkspaceRoots(ws);
		if (!roots || roots.length < 2) {
			return; // 单根工作区没什么可补的
		}

		const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
		const targetKeys = new Set(roots.map(u => norm(u.fsPath)));
		const currentKeys = this._getWindowRoots().map(u => norm(u.fsPath));

		const isStrictSubset = currentKeys.length > 0
			&& currentKeys.length < targetKeys.size
			&& currentKeys.every(key => targetKeys.has(key));
		if (!isStrictSubset) {
			this._diag(`startup roots: skipped (window roots not a strict subset) | target=${ws.id} window=${currentKeys.length} workspace=${targetKeys.size}`);
			return;
		}

		this._diag(`startup roots: expanding window to active workspace | target=${ws.id} name="${ws.name}" from=${currentKeys.length} to=${targetKeys.size} [${roots.map(u => u.fsPath).join(' , ')}]`);
		try {
			await replacer(roots.map(uri => ({ uri })));
		} catch (err) {
			this._diag(`startup roots: expand failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * ★★★ 启动时把窗口切到「当前工作区声明的 `.code-workspace` 文件」（2026-09-15 用户裁决）。
	 *
	 * ── 为什么需要 ────────────────────────────────────────────────────────
	 * 窗口的启动工作区来自 main 进程的 `last-user-workspace.json`，那里只存**一个路径**
	 * （实测就是 `g:\SarosWorkspace\sarosis-agents-client` 这个**目录**）⇒ 窗口是 FOLDER 态：
	 *   · 文件里的 `settings`（`files.exclude` / `search.exclude`）与 `tasks` **完全不生效**
	 *     —— 实测证据：`node_modules` 明明被文件排除却仍显示在树里；
	 *   · 多根只能靠内存替换去补，与文件声明的顺序/内容可能不一致。
	 * 进入文件态后窗口变成 WORKSPACE 态 ⇒ settings 原生生效、多根直接来自文件 ✓。
	 *
	 * ── 闸门（**每一条都必须保留**）───────────────────────────────────────
	 *   ① 记录确实带 `.code-workspace` 文件，且窗口**当前不在**该文件上；
	 *   ② 记录**就是当前窗口**（`matchWorkspaceIdentity`，与反向投影守卫、删除判定**同源**）
	 *      ⇒ 绝不把用户拽进「另一个工作区」—— `activeWorkspaceId` 只是 registry 游标，
	 *      启动兜底 `resolveDefaultActiveWorkspaceId()` 会选到无关记录；
	 *   ③ 文件必须存在（`_enterWorkspaceFile` 内部还会再查一次，不存在则返回 false ⇒ 回退内存替换）；
	 *   ④ **每次会话只做一次**（`_enteredWorkspaceFileOnStartup`）—— 避免 initialize 反复触发。
	 *
	 * ── 代价（已逐条核对，见 `_enterWorkspaceFile` 的注释）─────────────────
	 * 走 `configurationService.initialize()` **原地**切换：
	 * **不重载窗口、不重启扩展宿主、不写任何文件** —— 特别是**不碰用户 `.code-workspace`
	 * 的 settings 块**（原生 `enterWorkspace` 会重写它，正是 09-14 那类"改坏用户资产"，已刻意跳过）。
	 *
	 * @returns 是否已把窗口置于文件态（true ⇒ 调用方不必再做内存 root 替换）
	 */
	private async _tryEnterActiveWorkspaceFileOnStartup(ws: Workspace): Promise<boolean> {
		if (this._enteredWorkspaceFileOnStartup) {
			return false;
		}

		const filePath = ws.codeWorkspacePath;
		if (!filePath || !hasWorkspaceFileExtension(filePath)) {
			return false;   // 单目录工作区：没有文件可进
		}

		const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
		const identity = this._currentWindowIdentity();

		// ① 窗口已经在该文件上 ⇒ 已经是文件态，无需进入（也避免 initialize 反复触发）。
		//    此时返回 true：folder 由文件决定，调用方不必再补。
		if (identity.codeWorkspacePath && norm(identity.codeWorkspacePath) === norm(filePath)) {
			this._diag(`startup enter-file: skipped (window already on the file) | file=${filePath}`);
			return true;
		}

		// ② 记录必须**就是**当前窗口，否则绝不进入（防把用户拽进别的工作区）。
		if (matchWorkspaceIdentity(ws, identity) === 'none') {
			this._diag(`startup enter-file: skipped (record is not this window) | target=${ws.id} file=${filePath} | windowRoots=${identity.folderPaths.length} [${identity.folderPaths.join(' | ')}]`);
			return false;
		}

		// ★ 时序闸门：`configurationService.initialize()` 是**重操作**，必须在窗口把
		// 「初始工作区」完全就绪之后再做，否则可能与启动期的初始化竞争。
		// `LifecyclePhase.Restored` 正是「窗口已恢复到启动状态」的时刻；若该阶段已过则立即返回。
		// 拿不到生命周期服务时**照常继续** —— `_enterWorkspaceFile` 内部有 try/catch，
		// 失败会返回 false 并回退到内存替换（不会让窗口处于半切换状态）。
		try {
			const lifecycleService = this.instantiationService.invokeFunction(a => a.get(ILifecycleService));
			await lifecycleService.when(LifecyclePhase.Restored);
		} catch { /* 拿不到 ⇒ 继续（失败路径安全回退） */ }

		this._enteredWorkspaceFileOnStartup = true;
		const entered = await this._enterWorkspaceFile(URI.file(filePath), 'startup', ws.id);
		if (!entered) {
			// 文件缺失 / initialize 失败 ⇒ 回退内存替换（`_enterWorkspaceFile` 已记日志）。
			this._diag(`startup enter-file: failed, falling back to in-memory root expansion | file=${filePath}`);
			return false;
		}

		// 让**下次启动**直接以该文件打开（main 进程读的就是这个文件）⇒ 无需再走一次原地切换，
		// 且从窗口创建那一刻起就是 WORKSPACE 态（settings 一开始就生效）。
		await this._writeRememberedUserWorkspace(URI.file(filePath));
		return true;
	}

	/**
	 * 让窗口**原地**换到某个 `.code-workspace` 文件（不重载、不重启扩展宿主、不写任何文件）。
	 *
	 * 返回 `true` = 已切换（调用方无需再做 folder 替换）；
	 * 返回 `false` = 文件缺失 / 服务不可用 / 失败，调用方应回退内存替换。
	 *
	 * ── 为什么**不**用 `IWorkspaceEditingService.enterWorkspace()`（2026-09-15 优化）──
	 *
	 * 它做四件事，其中两件是我们**不能要**的：
	 * ```
	 * ① extensionService.stopExtensionHosts() → startExtensionHosts()   ← 扩展宿主重启（用户要求去掉）
	 * ② doEnterWorkspace(): 从 FOLDER 态进入时先 migrateWorkspaceSettings()
	 *      → doCopyWorkspaceSettings() 末行：
	 *        jsonEditingService.write(toWorkspace.configPath, [{path:['settings'],…}])
	 *      ⇒ **重写用户 `.code-workspace` 的 settings 块** ✗✗（正是 09-14 那类"改坏用户资产"）
	 * ③ configurationService.initialize(新工作区标识)   ← 真正需要的那一步
	 * ④ storageService.switch() / backup 重指向 / onDidEnterWorkspace
	 * ```
	 *
	 * 本方法**只做 ③**（外加 main 侧不开窗的登记可省）：`WorkspaceService.initialize()`
	 * 本身支持运行时重复调用（`configurationService.ts:541-551` + `:648-676` 专门处理
	 * `hasWorkspaceBefore`：fire 工作区状态/名称/folder 变更）⇒ 这就是 `doEnterWorkspace`
	 * 用的原语，去掉扩展宿主重启后依然完整。
	 *
	 * 收益：窗口的 `workspace.configuration` 变成该文件 ⇒ 它是真正的 WORKSPACE 态
	 * ⇒ 文件里的 `settings`（files.exclude / search.exclude / …）与 `tasks` **原生生效**，
	 * 多根直接来自文件；且**没有**扩展宿主重启、没有窗口重载、没有 storage 迁移
	 * （视图状态不会像换工作区那样被重置）。
	 *
	 * ⚠ 有意跳过的部分（都已核对影响面）：
	 *   · 扩展宿主的 stop/start —— 本方法的目的就是去掉它；
	 *   · `storageService.switch()` —— 保持 storage 作用域不变 ⇒ 切工作区不会重置 UI 状态
	 *     （代价：不同工作区共享同一份 workspace storage）；
	 *   · `workingCopyBackupService.reinitialize()` 与 main 侧 `registerWorkspaceBackup`
	 *     —— 影响仅限「崩溃后热退出恢复」；本方法不迁移备份目录，故不重指向更一致；
	 *   · `onDidEnterWorkspace` 参与者 —— 该事件在标准实现里是 `protected` 方法触发的，
	 *     外部无法补齐；目前无本仓消费者依赖它。
	 */
	private async _enterWorkspaceFile(fileUri: URI, entry: string, wsId: string): Promise<boolean> {
		try {
			const fileService = this.instantiationService.invokeFunction(a => a.get(IFileService));
			if (!await fileService.exists(fileUri)) {
				this._diag(`entry=${entry} | warn: workspace file missing, falling back to in-memory replace: ${fileUri.fsPath}`);
				return false;
			}

			const { workspacesService, configurationService } = this.instantiationService.invokeFunction(accessor => ({
				workspacesService: accessor.get(IWorkspacesService),
				configurationService: accessor.get(IWorkbenchConfigurationService),
			}));

			const identifier = await workspacesService.getWorkspaceIdentifier(fileUri);
			this._diag(`entry=${entry} | action=initializeWorkspaceInPlace (no reload / no ext-host restart / no file write) | target=${wsId} file=${fileUri.fsPath}`);
			await configurationService.initialize(identifier);
			return true;
		} catch (err) {
			this._diag(`entry=${entry} | warn: in-place workspace switch failed, falling back to in-memory replace: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/**
	 * 把「记住的上次工作区」写成 `uri`（与 main 进程 `_rememberUserWorkspaceFile()`
	 * 同一文件、同一格式：`<userData>/User/last-user-workspace.json`）。
	 *
	 * 为什么切换工作区时要写：否则重启后窗口回落到**旧**的 remembered 路径
	 * （例如单目录），与本次切换不一致 —— 用户会觉得「切了但重启又不对」。
	 * 失败只 warn：这是便利数据，绝不能阻断切换。
	 */
	private async _writeRememberedUserWorkspace(uri: URI): Promise<void> {
		try {
			const { fileService, environmentService } = this.instantiationService.invokeFunction(accessor => ({
				fileService: accessor.get(IFileService),
				environmentService: accessor.get(IWorkbenchEnvironmentService),
			}));
			const target = joinPath(environmentService.userRoamingDataHome, 'last-user-workspace.json');
			const content = JSON.stringify({ workspace: uri.fsPath }, null, '\t');
			await fileService.writeFile(target, VSBuffer.fromString(content));
			this._diag(`remembered last workspace: ${uri.fsPath}`);
		} catch (err) {
			this._diag(`warn: write last-user-workspace.json failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * 取「内存内整体替换 folder」的能力（鸭子类型）。
	 *
	 * 该方法定义在标准 `WorkspaceService` 上，而 agents 窗口的
	 * `IWorkspaceContextService` 就是它（`AgentLayoutWorkspaceService extends WorkspaceService`）
	 * ⇒ 同一实例上取得到。标准 IDE 窗口若哪天移除该方法，这里会返回 `undefined`
	 * 并自动回退到 `openWindow`（**不静默失败**：回退路径会打日志）。
	 */
	private _getInMemoryFolderReplacer(): ((folders: { uri: URI; name?: string }[]) => Promise<void>) | undefined {
		try {
			const contextService = this.instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceContextService)) as unknown as {
				replaceWorkspaceFoldersInMemory?: (folders: { uri: URI; name?: string }[]) => Promise<void>;
			};
			return typeof contextService.replaceWorkspaceFoldersInMemory === 'function'
				? contextService.replaceWorkspaceFoldersInMemory.bind(contextService)
				: undefined;
		} catch {
			return undefined;
		}
	}

	private _createWorkspaceSelector(toolbar: HTMLElement): void {
		const container = append(toolbar, $('div.sidebar-toolbar-workspace'));

		// ── Selector button ──
		const button = append(container, $('button.ws-selector-btn'));
		button.title = '切换工作区';

		const label = append(button, $('span.ws-selector-label'));
		label.textContent = '---';

		// ★ 2026-09-15：多根徽标（>1 个根才显示）。
		// 依据：用户多次因「多根工作区只显示一个目录」困惑 —— 根数直接可见就能立刻发现。
		const rootsBadge = append(button, $('span.ws-selector-roots'));
		rootsBadge.style.display = 'none';

		const chevron = append(button, $('span.codicon.codicon-chevron-down'));
		chevron.style.fontSize = '12px';

		// ── Dropdown panel (fixed position, hidden by default) ──
		const dropdown = append(container, $('div.ws-dropdown'));
		dropdown.style.display = 'none';  // controlled programmatically
		dropdown.style.position = 'fixed';
		dropdown.style.minWidth = '220px';
		dropdown.style.maxWidth = '280px';
		dropdown.style.zIndex = '2500';
		dropdown.style.background = 'var(--vscode-dropdown-background, var(--vscode-sideBar-background))';
		dropdown.style.border = '1px solid var(--vscode-dropdown-border, var(--vscode-widget-border))';
		dropdown.style.borderRadius = '6px';
		dropdown.style.boxShadow = '0 4px 16px rgba(0,0,0,0.3)';
		dropdown.style.padding = '4px 0';
		dropdown.style.overflow = 'hidden';

		this._workspaceSelectorEl = container;
		this._workspaceDropdownEl = dropdown;

		// ── Header：标题 + 搜索开关（★ 2026-09-15：搜索改为**按需**）──
		//
		// 原实现无条件常驻一整行搜索框，即使只有 2 条记录也把列表挤下去；
		// 而搜索是低频动作。改为：>5 条时自动展开，否则只留一个 🔍 按钮（或按 `/`）。
		const head = append(dropdown, $('div.ws-dropdown-head'));
		append(head, $('span.ws-dropdown-head-title')).textContent = '工作区';
		const headSpacer = append(head, $('span.ws-dropdown-head-spacer'));
		headSpacer.style.flex = '1';
		const searchToggle = append(head, $('button.ws-search-toggle'));
		searchToggle.title = '搜索（/）';
		append(searchToggle, $('span.codicon.codicon-search'));

		// ── Search input（默认隐藏）──
		const searchRow = append(dropdown, $('div.ws-dropdown-search'));
		searchRow.style.display = 'none';
		searchRow.style.alignItems = 'center';
		searchRow.style.padding = '4px 8px 6px';
		searchRow.style.borderBottom = '1px solid var(--vscode-dropdown-border, var(--vscode-widget-border))';

		const searchInput = document.createElement('input');
		searchInput.type = 'text';
		searchInput.className = 'ws-search-input';
		searchInput.placeholder = '按名称或路径过滤…';
		searchInput.style.width = '100%';
		searchInput.style.border = 'none';
		searchInput.style.outline = 'none';
		searchInput.style.background = 'transparent';
		searchInput.style.color = 'var(--vscode-input-foreground, inherit)';
		searchInput.style.fontSize = '12px';
		searchInput.style.padding = '2px 4px';
		searchRow.appendChild(searchInput);
		this._workspaceSearchInput = searchInput;
		this._workspaceSearchRow = searchRow;

		// ── Workspace list ──
		const list = append(dropdown, $('div.ws-dropdown-list'));
		list.style.maxHeight = '240px';
		list.style.overflowY = 'auto';
		this._workspaceListEl = list;

		// ── Open folder as workspace button ──
		const createRow = append(dropdown, $('div.ws-dropdown-create'));

		const openFolderBtn = append(createRow, $('button.ws-open-folder-btn'));
		append(openFolderBtn, $('span.codicon.codicon-folder-opened'));
		append(openFolderBtn, $('span')).textContent = '打开文件夹…';
		append(openFolderBtn, $('span.ws-open-hint')).textContent = '单根';
		openFolderBtn.title = '把一个目录注册为工作区（单根）';

		// ── Open workspace from file button ──
		//
		// ★ 2026-09-15 文案消歧：原为「+ 从文件夹打开工作区」/「+ 从文件打开工作区」——
		// 两者几乎同形，但实际一个是**目录**、一个是 `.code-workspace` **文件**。
		// 现在直接写出目标形态，并各加副标签。
		const openFileBtn = append(createRow, $('button.ws-open-file-btn'));
		append(openFileBtn, $('span.codicon.codicon-file-code'));
		append(openFileBtn, $('span')).textContent = '打开 .code-workspace…';
		append(openFileBtn, $('span.ws-open-hint')).textContent = '多根';
		openFileBtn.title = '打开 .code-workspace 多根工作区文件';

		// ── Events ──
		this._register(addDisposableListener(button, EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			this._toggleWorkspaceDropdown();
		}));

		this._register(addDisposableListener(document, EventType.CLICK, (e: MouseEvent) => {
			if (!dropdown || dropdown.style.display === 'none') { return; }
			if (!container.contains(e.target as Node)) {
				this._closeWorkspaceDropdown();
			}
		}));

		this._register(addDisposableListener(searchInput, EventType.INPUT, () => {
			this._renderWorkspaceList();
		}));

		// ★ 2026-09-15：搜索开关（按需展开）。
		this._register(addDisposableListener(searchToggle, EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			this._showWorkspaceSearch(searchRow.style.display === 'none');
		}));

		// ★ 2026-09-15：键盘导航（↑↓ / Enter / Esc / `/`）。
		//
		// ⚠ 必须在**面板未打开时立刻返回** —— 否则会抢走编辑器里正常的按键
		// （尤其 `/`：在文档里输入斜杠会被吞掉）。
		this._register(addDisposableListener(document, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (!dropdown || dropdown.style.display === 'none') {
				return;
			}
			const rows = this._workspaceRows();
			if (rows.length === 0) {
				return;
			}

			if (e.key === 'Escape') {
				this._closeWorkspaceDropdown();
				return;
			}
			if (e.key === '/' && document.activeElement !== searchInput) {
				e.preventDefault();
				this._showWorkspaceSearch(true);
				return;
			}
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				this._moveWorkspaceKbFocus(e.key === 'ArrowDown' ? 1 : -1, rows);
				return;
			}
			if (e.key === 'Enter' && this._workspaceKbIndex >= 0) {
				const row = rows[this._workspaceKbIndex];
				if (row) {
					e.preventDefault();
					row.click();
				}
			}
		}));

		this._register(addDisposableListener(searchInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			// Escape 由上面的 document 处理器统一处理（避免两处各关一次）。
			if (e.key === 'Escape') {
				e.stopPropagation();
			}
		}));

		// ── Open folder button: browse folder → create workspace ──
		this._register(addDisposableListener(openFolderBtn, EventType.CLICK, () => {
			this._openFolderAsWorkspace();
		}));

		// ── Open workspace from file button ──
		this._register(addDisposableListener(openFileBtn, EventType.CLICK, () => {
			this._openFileAsWorkspace();
		}));

		// ── Connect services ──
		this._connectWorkspaceServices();
	}

	private _connectWorkspaceServices(): void {
		// Idempotent: this can be invoked more than once (initial create +
		// retry-on-open when the service wasn't ready). Once the service is
		// bound and subscriptions registered, don't re-subscribe.
		if (this._wsAgentStudioService) {
			void this._loadWorkspaces();
			return;
		}
		try {
			const agentStudioService = this.instantiationService.invokeFunction(
				accessor => accessor.get(IAgentStudioService)
			);
			this._wsAgentStudioService = agentStudioService;

			// Subscribe to workspace changes
			this._register(agentStudioService.onDidChangeWorkspace(() => {
				this._loadWorkspaces();
			}));
			this._register(agentStudioService.onDidChangeActiveWorkspace((workspaceId) => {
				this._activeWorkspaceId = workspaceId ?? undefined;
				this._updateSelectorLabel();
				// The active workspace often resolves AFTER the initial
				// _loadWorkspaces() call (service not ready at sidebar-connect
				// time). Without reloading here, `_workspaces` can stay empty
				// while the label shows the active name — making the dropdown
				// list render empty. Reload so list + label stay in sync.
				void this._loadWorkspaces();
			}));

			// ★★ 首次加载完成后，把「当前 Agent Studio 工作区」的**完整 root 集合**应用到窗口。
			//
			// 为什么：窗口启动工作区来自 `last-user-workspace.json`（只存一个路径，可能是
			// 一个目录），而该工作区可能还有 `relatedFolders` ⇒ 不补这一步，侧栏选择器写着
			// 「某工作区」、下面却只有 1 个根，每次重启都要手动再选一次才对齐。
			// 保守闸门（只对"窗口 roots 是工作区 roots 的**真子集**"生效）见该方法注释。
			void this._loadWorkspaces().then(() => this._applyActiveWorkspaceRootsOnStartup());
		} catch {
			setTimeout(() => this._connectWorkspaceServices(), 2000);
		}

		try {
			this._wsFileDialogService = this.instantiationService.invokeFunction(
				accessor => accessor.get(IFileDialogService)
			);
		} catch { /* file dialog service not available yet */ }

		try {
			this._wsDialogService = this.instantiationService.invokeFunction(
				accessor => accessor.get(IDialogService)
			);
		} catch { /* dialog service not available yet */ }
	}

	/**
	 * ★★ 并发去重（2026-09-15）：本方法会 `this._workspaces = await getWorkspaces()`
	 * **整体替换数组**，而 `updateWorkspace()` / `addRelatedFolder()` 都会 fire
	 * `onDidChangeWorkspace` ⇒ 监听器（第 950 / 953 行）会在**写入过程中**再次触发加载
	 * ⇒ 用中途快照把数组换掉，而我正在改的那个对象随即"脱钩"。
	 *
	 * 实测后果（2026-09-15 13:51）：自愈补完 2 个 `relatedFolders` 之后，
	 * 启动补根读到的却是「两次 `addRelatedFolder` **之间**」的快照
	 * ⇒ 只补出 2 个根（日志 `startup roots: expanding ... to=2`，而工作区文件声明 3 个）
	 * ⇒ 用户看到「应该是 3 个目录，为什么只显示 2 个」。
	 *
	 * 并发调用**复用同一个 promise**：既杜绝"中途快照覆盖"，也省掉重复全量读盘。
	 */
	private _loadWorkspaces(): Promise<void> {
		if (this._loadingWorkspaces) {
			// 有并发请求 ⇒ 记一笔，本次结束后**再补一次**。
			// 只去重不补的话会**吞掉变更**：加载期间数据又变了（`onDidChangeWorkspace` 再次 fire）
			// ⇒ 那个请求被合并进旧快照 ⇒ 列表一直停在旧数据，直到别的什么事触发下一次加载。
			this._loadingWorkspacesDirty = true;
			return this._loadingWorkspaces;
		}
		const promise = this._doLoadWorkspaces().finally(() => {
			// 只清理自己 —— 否则会误清掉后来者的 promise。
			if (this._loadingWorkspaces === promise) {
				this._loadingWorkspaces = undefined;
			}
			if (this._loadingWorkspacesDirty) {
				this._loadingWorkspacesDirty = false;
				void this._loadWorkspaces();
			}
		});
		this._loadingWorkspaces = promise;
		return promise;
	}

	private async _doLoadWorkspaces(): Promise<void> {
		if (!this._wsAgentStudioService) { return; }
		this._workspaces = await this._wsAgentStudioService.getWorkspaces();
		// 1. Try in-memory active workspace first
		let activeId = this._wsAgentStudioService.getActiveWorkspaceId();
		// 2. If not set, try restoring from persisted storage (e.g., after window reload)
		if (!activeId && this._workspaces.length > 0) {
			try {
				const lastId = await this._wsAgentStudioService.getLastActiveWorkspaceId();
				if (lastId && this._workspaces.some(w => w.id === lastId)) {
					activeId = lastId;
					await this._wsAgentStudioService.setActiveWorkspace(activeId);
				}
			} catch {
				// Restore failed — fall through
			}
		}
		// 3. Fallback: select first workspace if still none selected
		if (!activeId && this._workspaces.length > 0) {
			activeId = this._workspaces[0].id;
			await this._wsAgentStudioService.setActiveWorkspace(activeId);
		}
		this._activeWorkspaceId = activeId;
		this._updateSelectorLabel();

		// Auto-fix workspaces whose path is a .code-workspace FILE (legacy bug).
		// Resolve the JSON to extract the real folder directory so that
		// WorkspaceViewPane._buildRealOrVirtualRoot gets a valid directory path.
		await this._fixWorkspaceFilePaths();

		// ★ 2026-09-15：修复「记录丢了工作区文件身份」的损坏态（详见方法注释）。
		// 必须在这里（`_loadWorkspaces()` 内、`_applyActiveWorkspaceRootsOnStartup()` 之前）——
		// 修复后紧接着的启动补根才能立刻把多根恢复到窗口。
		await this._recoverWorkspaceFileIdentity();

		// Re-render the list whenever data refreshes AND the dropdown is open,
		// so an async load that resolves after _openWorkspaceDropdown() still
		// fills the visible list (the open() path renders synchronously first
		// with possibly-stale/empty data, then awaits this).
		if (this._workspaceDropdownEl && this._workspaceDropdownEl.style.display !== 'none') {
			this._renderWorkspaceList();
		}
	}

	private _updateSelectorLabel(): void {
		const label = this._workspaceSelectorEl?.querySelector('.ws-selector-label');
		const badge = this._workspaceSelectorEl?.querySelector<HTMLElement>('.ws-selector-roots');
		const active = this._workspaces.find(w => w.id === this._activeWorkspaceId);
		if (label) {
			label.textContent = active?.name || '无工作区';
		}
		// ★ 多根徽标：只在 >1 时显示 —— 根数可见就能立刻发现「多根只显示一个目录」这类问题。
		if (badge) {
			const count = active ? this._estimateRootCount(active) : 0;
			badge.textContent = `${count}`;
			badge.style.display = count > 1 ? '' : 'none';
			badge.title = `${count} 个根（多根工作区）`;
		}
	}

	private _toggleWorkspaceDropdown(): void {
		if (!this._workspaceDropdownEl) { return; }
		if (this._workspaceDropdownEl.style.display === 'none') {
			this._openWorkspaceDropdown();
		} else {
			this._closeWorkspaceDropdown();
		}
	}

	/** 记录数超过这个值才默认展开搜索框（否则只留 header 的 🔍）。 */
	private static readonly WORKSPACE_SEARCH_THRESHOLD = 5;

	private _openWorkspaceDropdown(): void {
		if (!this._workspaceSelectorEl || !this._workspaceDropdownEl) { return; }
		const rect = this._workspaceSelectorEl.getBoundingClientRect();
		this._workspaceDropdownEl.style.left = `${rect.left}px`;
		this._workspaceDropdownEl.style.top = `${rect.bottom + 4}px`;
		this._workspaceDropdownEl.style.display = '';
		if (this._workspaceSearchInput) {
			this._workspaceSearchInput.value = '';
		}
		this._workspaceKbIndex = -1;
		// ★ 搜索按需：记录少时不占一整行（原先 2 条也常驻搜索框，把列表挤下去）。
		this._showWorkspaceSearch(this._workspaces.length > SidebarPart.WORKSPACE_SEARCH_THRESHOLD);
		// Render immediately with whatever we have so the panel isn't blank,
		// then re-fetch fresh data from the service and re-render. This makes
		// the list reliable even if the initial connect-time load missed the
		// data (service not ready) or the data changed in another surface.
		this._renderWorkspaceList();
		if (!this._wsAgentStudioService) {
			// Service may not have connected yet — retry the connection so the
			// list can populate instead of staying permanently empty.
			this._connectWorkspaceServices();
		} else {
			void this._loadWorkspaces();
		}
		// 只在搜索框可见时聚焦它；否则不动焦点（Escape / 方向键由面板级处理器接管）。
		if (this._workspaceSearchRow?.style.display !== 'none') {
			setTimeout(() => this._workspaceSearchInput?.focus(), 50);
		}
	}

	private _closeWorkspaceDropdown(): void {
		if (this._workspaceDropdownEl) {
			this._workspaceDropdownEl.style.display = 'none';
		}
		// 收起时清掉键盘高亮，避免下次打开残留一个"幽灵选中行"。
		this._workspaceRows().forEach(r => r.classList.remove('kb'));
		this._workspaceKbIndex = -1;
	}

	private _renderWorkspaceList(): void {
		if (!this._workspaceListEl) { return; }
		const query = (this._workspaceSearchInput?.value || '').toLowerCase();

		const filtered = query
			? this._workspaces.filter(w =>
				w.name.toLowerCase().includes(query) ||
				(w.path && w.path.toLowerCase().includes(query))
			)
			: this._workspaces;

		// Clear list
		clearNode(this._workspaceListEl);
		// 列表重建 ⇒ 之前记住的键盘行号已失效（不重置会指向另一条记录）。
		this._workspaceKbIndex = -1;

		if (filtered.length === 0) {
			const empty = append(this._workspaceListEl, $('div.ws-dropdown-empty'));
			empty.textContent = query ? '未找到匹配的工作区' : '暂无工作区';
			empty.style.padding = '12px 12px';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontSize = '12px';
			empty.style.textAlign = 'center';
			return;
		}

		// ★ 2026-09-15：按「本窗口是否正在打开」分组。
		//
		// 为什么要分组：原来的 `✓` **只表示 registry 游标**（`_activeWorkspaceId`），
		// 而它与「窗口打开的东西」是两套标识、会错配（启动兜底会选到无关记录）。
		// 于是用户看到 ✓ 却无法判断"我点它会切到哪 / 我现在到底在哪个工作区里"。
		// 判据用 P0 的身份模型（与反向投影守卫、删除判定**同源**），保证三处语义一致。
		const windowIdentity = this._currentWindowIdentity();
		const openHere: Workspace[] = [];
		const others: Workspace[] = [];
		for (const ws of filtered) {
			(matchWorkspaceIdentity(ws, windowIdentity) !== 'none' ? openHere : others).push(ws);
		}

		if (openHere.length > 0) {
			this._appendWorkspaceGroup('本窗口正在打开', openHere, true);
		}
		if (others.length > 0) {
			this._appendWorkspaceGroup('其他工作区', others, false);
		}
	}

	/** 渲染一个分组标题 + 其下的记录。 */
	private _appendWorkspaceGroup(title: string, items: readonly Workspace[], isWindowGroup: boolean): void {
		if (!this._workspaceListEl) { return; }
		const titleEl = append(this._workspaceListEl, $('div.ws-group-title'));
		if (isWindowGroup) {
			titleEl.classList.add('ws-group-window');
			append(titleEl, $('span.codicon.codicon-circle-filled'));
		}
		append(titleEl, $('span')).textContent = title;
		for (const ws of items) {
			this._createWorkspaceItemEl(ws, isWindowGroup);
		}
	}

	/** 渲染一条工作区记录。 */
	private _createWorkspaceItemEl(ws: Workspace, openHere: boolean): void {
		if (!this._workspaceListEl) { return; }
		const isActive = ws.id === this._activeWorkspaceId;

		const item = append(this._workspaceListEl, $('div.ws-dropdown-item'));
		if (openHere) { item.classList.add('open-here'); }
		if (isActive) { item.classList.add('active'); }

		// 状态标记：● 本窗口正在打开 / ○ 仅注册表选中 / 空 = 都不是。
		// 这两种状态**必须能区分** —— 它们会错配，而错配正是此前多个症状的根因。
		const mark = append(item, $('span.ws-item-mark'));
		mark.textContent = openHere ? '●' : (isActive ? '○' : '');
		mark.title = openHere ? '本窗口正在打开' : (isActive ? '仅注册表选中（本窗口并未打开它）' : '');

		const body = append(item, $('div.ws-item-body'));
		const row1 = append(body, $('div.ws-item-row1'));
		append(row1, $('span.ws-item-name')).textContent = ws.name;

		// 徽标：全部来自**已有字段**（无 I/O）。
		//
		// ⚠ 刻意**不做**「切换会重载窗口」提示：`_switchWorkspace` 现在优先走原生
		// `enterWorkspace` 与内存内 folder 替换，两条路径都**不重载**；
		// 只有拿不到内存接缝时才回退 `openWindow`。标出来会是误导。
		const rootCount = this._estimateRootCount(ws);
		if (rootCount > 1) {
			this._appendChip(row1, `${rootCount} 个根`, 'multi-root');
		}
		if (ws.codeWorkspacePath || hasWorkspaceFileExtension(ws.path ?? '')) {
			this._appendChip(row1, '.code-workspace', 'file');
		}
		if (ws.worktreeBranch) {
			this._appendChip(row1, `worktree: ${ws.worktreeBranch}`, 'worktree');
		}

		if (ws.path) {
			const pathSpan = append(body, $('span.ws-item-path'));
			pathSpan.textContent = ws.path;
			// 路径做了中间截断 ⇒ 完整值必须挂在 title 上，否则长路径无法读到全貌。
			pathSpan.title = ws.path;
		}

		const actionsDiv = append(item, $('div.ws-item-actions'));
		const deleteBtn = append(actionsDiv, $('button.ws-delete-btn'));
		append(deleteBtn, $('span.codicon.codicon-trash'));
		// ★ 删除是破坏性的，且「删掉本窗口正在打开的那条」会**转成无工作区**（2026-09-15 语义）
		// ⇒ title 必须把后果说清楚，而不是笼统的"删除工作区"。
		deleteBtn.title = openHere
			? '删除这条记录 —— 它正是本窗口打开的工作区，删除后本窗口将转为「无工作区」'
			: '删除这条记录（仅删注册表记录，磁盘文件不动）';

		this._register(addDisposableListener(deleteBtn, EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();  // don't trigger item click
			this._confirmDeleteWorkspace(ws);
		}));

		// Click to switch
		this._register(addDisposableListener(item, EventType.CLICK, () => {
			// ★ 2026-09-15 修复：原实现只调 `setActiveWorkspace`（翻 registry 游标），
			// 窗口 folder 不变 ⇒ 原生 Explorer 收不到 `onDidChangeWorkspaceFolders`
			// ⇒ sideview 不刷新（用户日志实证：6 次切换 window 行完全一致、
			// 该事件出现 0 次）。改为「切换 = 打开该工作区」，与项目栏语义统一。
			// 不再按 `ws.id !== this._activeWorkspaceId` 短路 —— 游标相同不代表
			// 窗口已打开它（启动兜底可能选错记录），交给 `_isWindowAlreadyOn` 判断。
			void this._switchWorkspace(ws, 'sidebar-dropdown');
			this._closeWorkspaceDropdown();
		}));
	}

	/** 追加一个徽标。 */
	private _appendChip(parent: HTMLElement, text: string, kind: 'multi-root' | 'file' | 'worktree'): void {
		const chip = append(parent, $('span.ws-chip'));
		if (kind !== 'multi-root') {
			chip.classList.add(`ws-chip-${kind}`);
		}
		chip.textContent = text;
	}

	/**
	 * 估算一条记录的根数量（**纯本地字段，不做 I/O**）。
	 *
	 * `path` 是目录时它本身就是一个根；是 `.code-workspace` 文件时**不是**。
	 * ⚠ 这是估算：`relatedFolders` 可能落后于工作区文件的实际内容。列表每次渲染都要跑，
	 * 不能为每条记录去解析文件（那是 I/O）—— 宁可有"少数情况不显示徽标"，也不卡渲染。
	 */
	private _estimateRootCount(ws: Workspace): number {
		const related = ws.relatedFolders?.length ?? 0;
		const pathIsDir = !!ws.path && !hasWorkspaceFileExtension(ws.path);
		return related + (pathIsDir ? 1 : 0);
	}

	/** 当前窗口的工作区身份（与 P0 的身份模型同源）。 */
	private _currentWindowIdentity(): IWorkspaceIdentity {
		try {
			const contextService = this._diagServices?.contextService
				?? this.instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceContextService));
			const ws = contextService.getWorkspace();
			return workspaceIdentityFromWindow(ws.configuration?.fsPath, ws.folders.map(f => f.uri.fsPath));
		} catch {
			return { folderPaths: [] };
		}
	}

	/** 列表里当前可键盘导航的行。 */
	private _workspaceRows(): HTMLElement[] {
		return Array.from(this._workspaceListEl?.querySelectorAll<HTMLElement>('.ws-dropdown-item') ?? []);
	}

	/** 移动键盘高亮（与 hover 同一视觉 —— 键盘用户必须看得见当前行）。 */
	private _moveWorkspaceKbFocus(delta: number, rows: readonly HTMLElement[]): void {
		rows.forEach(r => r.classList.remove('kb'));
		const next = Math.min(rows.length - 1, Math.max(0, this._workspaceKbIndex + delta));
		this._workspaceKbIndex = next;
		rows[next].classList.add('kb');
		rows[next].scrollIntoView({ block: 'nearest' });
	}

	/** 展开 / 收起搜索行。 */
	private _showWorkspaceSearch(show: boolean): void {
		if (!this._workspaceSearchRow) { return; }
		this._workspaceSearchRow.style.display = show ? 'flex' : 'none';
		if (show) {
			setTimeout(() => this._workspaceSearchInput?.focus(), 0);
		}
	}

	/**
	 * 删除 Agent Studio 工作区**记录**（`workspaces.json` 的一条），带确认。
	 *
	 * ★★ 2026-09-14/15 两轮修复（起因：用户报「删除工作区后侧栏没刷新」）：
	 *
	 * ① **本方法原先名叫 confirm 却没有任何确认** —— 点 `×` 直接删，破坏性操作零挽回。
	 *
	 * ② **「没刷新」的真正原因不是刷新 bug，而是语义缺失**：
	 *    侧栏那个文件夹列表是**原生 Explorer**（`SessionsExplorerView`），数据源是
	 *    `IWorkspaceContextService.getWorkspace().folders`，即**窗口自己的 folder 列表**；
	 *    而删记录只写 `workspaces.json`。默认方向 `window-drives-registry` 下**不存在**
	 *    registry → 窗口 的写路径（那条路正是跨工作区污染的源头，已于 09-14 移除），
	 *    所以旧实现里删记录不会让任何 folder 变化 ⇒ 列表当然不动
	 *    （刷新链 `onDidChangeWorkspaceFolders → onDidChangeRoots → setTreeInput()` 本身是好的）。
	 *
	 * ③ **用户 2026-09-15 裁决：删当前工作区 ⇒ 窗口一并关闭该工作区（转空工作区）。**
	 *    实现走 `IHostService.openWindow({ forceReuseWindow: true })`（= 空工作区、复用本窗口）。
	 *
	 *    ⚠⚠ **绝不能用 `removeFolders(全部 folder)` 来「转空」**：标准 `WorkspaceService`
	 *    会把结果**回写 `.code-workspace` 文件**，等于把用户手写的 folders 清空 ——
	 *    正是 09-14 那起「用户资产被程序改坏」事故的同一条路。开空窗口不碰任何用户文件。
	 *
	 *    是否关窗口由纯函数 {@link planWindowOnDeleteWorkspace} 判定（要求「是当前记录」
	 *    **且**「这条记录就是本窗口打开的东西」，避免删一条无关记录却关掉用户正在编辑的工作区）。
	 *
	 * 「记录」与「窗口工作区」这套二元标识的统一属 Step 4（registry key 改 configPath）。
	 */
	private async _confirmDeleteWorkspace(ws: Workspace): Promise<void> {
		if (!this._wsAgentStudioService) { return; }

		// dialog 服务拿不到时（启动早期）**不静默删除** —— 破坏性操作宁可不执行。
		if (!this._wsDialogService) {
			return;
		}

		// 沿用本类既有风格：用 `invokeFunction` 延迟取服务，避免改动 Part 的构造签名。
		let svc: { contextService: IWorkspaceContextService; hostService: IHostService; logService: ILogService };
		try {
			svc = this.instantiationService.invokeFunction(accessor => ({
				contextService: accessor.get(IWorkspaceContextService),
				hostService: accessor.get(IHostService),
				logService: accessor.get(ILogService),
			}));
		} catch {
			// 拿不到工作区/窗口服务就无法安全判断「是否该关窗口」⇒ 整个操作放弃，
			// 而不是退化成「只删记录」（那会让用户以为窗口没反应）。
			return;
		}

		// ★ P0：判定走**完整身份匹配**（工作区文件 > 主 root > root 集合）。
		// 旧版只比「窗口主 root vs ws.path」，当记录 `path` 是 `.code-workspace` 文件时
		// 恒不匹配 ⇒ 删掉当前工作区却不关窗口 ⇒ 用户认为「删除没生效」。
		const windowWs = svc.contextService.getWorkspace();
		const windowIdentity = workspaceIdentityFromWindow(
			windowWs.configuration?.fsPath,
			windowWs.folders.map(f => f.uri.fsPath),
		);
		const plan = planWindowOnDeleteWorkspace(ws.id, this._activeWorkspaceId, ws, windowIdentity);

		const detailLines = ['仅删除工作区记录，磁盘上的文件不会被删除。'];
		if (plan.closeWindowWorkspace) {
			// 会关工作区就必须**说在前面**：未保存的编辑器会被要求处理，视图状态会丢。
			detailLines.push('这是当前打开的工作区，删除后本窗口将关闭该工作区并转为「无工作区」状态。');
		} else if (ws.id === this._activeWorkspaceId) {
			// 是当前记录、但与本窗口打开的东西不是同一个 ⇒ 明确告知窗口不受影响，避免误解成「没生效」。
			detailLines.push('本窗口当前打开的不是该工作区，已打开的文件夹不会受影响。');
		}

		const { confirmed } = await this._wsDialogService.confirm({
			type: 'warning',
			message: `确定要删除工作区「${ws.name}」吗？`,
			detail: detailLines.join('\n'),
			primaryButton: '删除',
		});
		if (!confirmed) {
			return;
		}

		await this._wsAgentStudioService.deleteWorkspace(ws.id);

		if (!plan.closeWindowWorkspace) {
			return;
		}

		// 顺序要紧：① 先把 active 游标清掉，② 再清「记住上次打开的工作区」，
		// ③ 最后才开空窗口 —— openWindow 会重载 renderer，它之后的语句不保证执行。
		try {
			await this._wsAgentStudioService.setActiveWorkspace(undefined);
			await this._wsAgentStudioService.setLastActiveWorkspaceId(null);
		} catch (err) {
			svc.logService.warn('[sidebarPart] failed to clear active workspace after delete:', err);
		}

		if (plan.clearRememberedWorkspace) {
			await this._clearRememberedUserWorkspace(svc.logService);
		}

		await svc.hostService.openWindow({ forceReuseWindow: true });
	}

	/**
	 * 删除 `last-user-workspace.json`，否则下次启动 `windowsMainService` 会把刚删掉的
	 * 工作区**又打开一遍**，用户会认为「删除没生效」。
	 *
	 * 路径必须与 main 进程的 `_rememberedWorkspaceFileLocation()` 一致：
	 * `<userData>/User/last-user-workspace.json`（renderer 侧的 `userRoamingDataHome`
	 * 即 main 侧的 `appSettingsHome`）。
	 *
	 * 失败只 warn —— 这只是「记住上次选择」的便利数据，绝不能阻断删除流程。
	 */
	private async _clearRememberedUserWorkspace(logService: ILogService): Promise<void> {
		try {
			const { fileService, environmentService } = this.instantiationService.invokeFunction(accessor => ({
				fileService: accessor.get(IFileService),
				environmentService: accessor.get(IWorkbenchEnvironmentService),
			}));
			const target = joinPath(environmentService.userRoamingDataHome, 'last-user-workspace.json');
			if (await fileService.exists(target)) {
				await fileService.del(target);
				logService.info('[sidebarPart] cleared last-user-workspace.json after workspace deletion');
			}
		} catch (err) {
			logService.warn('[sidebarPart] failed to clear last-user-workspace.json:', err);
		}
	}

	private async _openFolderAsWorkspace(): Promise<void> {
		if (!this._wsAgentStudioService || !this._wsFileDialogService) { return; }

		let folderPath: string | undefined;
		try {
			const uris = await this._wsFileDialogService.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: '打开工作区',
				title: '选择工作区文件夹',
			});
			if (uris && uris.length > 0) {
				folderPath = uris[0].fsPath;
			}
		} catch { /* user cancelled */ }
		if (!folderPath) { return; }

		// Derive workspace name from folder name
		const segments = folderPath.replace(/[/\\]+$/, '').split(/[/\\]/);
		const name = segments[segments.length - 1] || folderPath;

		// If a workspace already bound to this exact folder exists, reuse it
		// instead of creating a duplicate — then just switch to it.
		const norm = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase();
		const existing = this._workspaces.find(w => w.path && norm(w.path) === norm(folderPath));

		const target = existing ?? await this._wsAgentStudioService.createWorkspace({
			name,
			path: folderPath,
		});

		// Refresh local cache so the new/target workspace is present, then
		// activate it. createWorkspace fires onDidChangeWorkspace (→ reload),
		// but we also reload explicitly to avoid any ordering race before the
		// setActiveWorkspace call below relies on the cached list.
		await this._loadWorkspaces();
		// ★ 2026-09-15：改为「打开该工作区」（同 sidebar-dropdown 的修复）。
		// 同样必须用重新取回的记录（原因见 `_openFileAsWorkspace` 里同位置的长注释）。
		const fresh = this._workspaces.find(w => w.id === target.id) ?? target;
		this._diag(`entry=sidebar-open-folder | existed=${!!existing} | target=${fresh.id} path=${fresh.path ?? '<none>'}`);
		await this._switchWorkspace(fresh, 'sidebar-open-folder');

		this._closeWorkspaceDropdown();
	}

	private async _openFileAsWorkspace(): Promise<void> {
		if (!this._wsAgentStudioService || !this._wsFileDialogService) { return; }

		let fileUri: URI | undefined;
		try {
			const uris = await this._wsFileDialogService.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				openLabel: '打开工作区',
				title: '选择工作区文件',
				filters: [{ name: 'Workspace', extensions: ['code-workspace'] }],
			});
			if (uris && uris.length > 0) {
				fileUri = uris[0];
			}
		} catch { /* user cancelled */ }
		if (!fileUri) { return; }

		const filePath = fileUri.fsPath;

		// Derive workspace name from file name (without extension)
		const segments = filePath.replace(/[/\\]+$/, '').split(/[/\\]/);
		const fileName = segments[segments.length - 1] || filePath;
		const name = fileName.replace(/\.code-workspace$/i, '') || fileName;

		// A .code-workspace file is JSON with a "folders" array. Each entry has
		// a "path" (relative to the workspace file, or absolute) or a "uri".
		// We resolve ALL folder paths. The first folder becomes the workspace
		// `path` (so .sarosworkspace can be created inside a real directory),
		// and the rest become `relatedFolders` (shown as additional roots in
		// WorkspaceViewPane).
		let wsPath: string | undefined;
		let extraFolders: { path: string; name: string }[] = [];
		let filesExclude: Record<string, boolean> | undefined;
		try {
			const fileService = this.instantiationService.invokeFunction(a => a.get(IFileService));
			const { primaryPath, extraFolders: extras, filesExclude: fe } = await this._resolveCodeWorkspaceFolders(fileUri, fileService);
			wsPath = primaryPath;
			extraFolders = extras;
			filesExclude = fe;
		} catch (err) {
			// ★ 2026-09-15：原先这里**静默**吞异常，导致「多根工作区只剩 1 个 root」这类
			// 问题完全无迹可查（症状离根因很远）。改为显式记录 —— 这是「打开工作区文件」
			// 唯一的解析入口，它失败必须可见。
			this._diag(`error: failed to resolve folders from ${fileUri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Fallback: use the parent directory of the .code-workspace file
		if (!wsPath) {
			wsPath = URI.joinPath(fileUri, '..').fsPath;
		}

		// If a workspace already bound to this exact path exists, reuse it.
		// Also check for old workspaces created with the .code-workspace FILE
		// path (pre-fix) — if found, update their path to the resolved folder.
		const norm = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase();
		let existing = this._workspaces.find(w => w.path && norm(w.path) === norm(wsPath));
		if (!existing) {
			existing = this._workspaces.find(w => w.path && norm(w.path) === norm(filePath));
		}

		let target: Workspace;
		if (existing) {
			if (existing.path && norm(existing.path) !== norm(wsPath)) {
				// Old workspace had the .code-workspace file path — fix it
				target = await this._wsAgentStudioService.updateWorkspace(existing.id, { path: wsPath, filesExclude, codeWorkspacePath: filePath });
			} else {
				target = await this._wsAgentStudioService.updateWorkspace(existing.id, { filesExclude, codeWorkspacePath: filePath });
			}
		} else {
			target = await this._wsAgentStudioService.createWorkspace({
				name,
				path: wsPath,
				filesExclude,
				codeWorkspacePath: filePath,
			});
		}

		// Sync extra folders (folders[1..]) as relatedFolders so that
		// WorkspaceViewPane renders them as additional roots.
		if (extraFolders.length > 0) {
			const existingPaths = new Set(
				(target.relatedFolders ?? []).map(f => f.path.replace(/[\\/]+$/, '').toLowerCase())
			);
			const toAdd = extraFolders.filter(f => !existingPaths.has(f.path.replace(/[\\/]+$/, '').toLowerCase()));
			for (const f of toAdd) {
				await this._wsAgentStudioService.addRelatedFolder(target.id, f.path);
			}
		}

		// Refresh local cache so the new/target workspace is present, then
		// activate it.
		await this._loadWorkspaces();
		// ★★ 必须用**重新取回**的记录，不能用上面的 `target`。
		//
		// 2026-09-15 实测 bug：`target` 是 `createWorkspace()`/`updateWorkspace()` 的返回值，
		// 拿在「`addRelatedFolder()` 补 relatedFolders **之前**」⇒ 它的 `relatedFolders`
		// 还是空的 ⇒ `_resolveWorkspaceRoots()` 只解析出 1 个 root。
		// 日志实证：`entry=sidebar-open-file | extraFolders=2 | ... roots=1`
		// ⇒ 用户报「用多项目 code-workspace 打开，sideview 没展示多目录」。
		const fresh = this._workspaces.find(w => w.id === target.id) ?? target;
		this._diag(`entry=sidebar-open-file | extraFolders=${extraFolders.length} | target=${fresh.id} path=${fresh.path ?? '<none>'} relatedFolders=${(fresh.relatedFolders ?? []).length}`);
		await this._switchWorkspace(fresh, 'sidebar-open-file');

		this._closeWorkspaceDropdown();
	}

	/**
	 * Scan loaded workspaces for legacy entries whose `path` points to a
	 * `.code-workspace` FILE instead of the resolved folder directory.
	 * Auto-fix each one by reading the JSON, extracting ALL folders'
	 * paths, setting folders[0] as `path` and folders[1..] as
	 * `relatedFolders`, so WorkspaceViewPane can stat real dirs.
	 */
	private async _fixWorkspaceFilePaths(): Promise<void> {
		if (!this._wsAgentStudioService || this._workspaces.length === 0) { return; }

		let fileService: IFileService;
		try {
			fileService = this.instantiationService.invokeFunction(a => a.get(IFileService));
		} catch { return; /* file service not available */ }

		const norm = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase();
		const CODE_WORKSPACE_RE = /\.code-workspace$/i;

		for (const ws of this._workspaces) {
			if (!ws.path || !CODE_WORKSPACE_RE.test(ws.path)) { continue; }
			const fileUri = URI.file(ws.path);

			// Resolve ALL folders from the .code-workspace file
			let primaryPath: string | undefined;
			let extraFolders: { path: string; name: string }[] = [];
			let filesExclude: Record<string, boolean> | undefined;
			try {
				const result = await this._resolveCodeWorkspaceFolders(fileUri, fileService);
				primaryPath = result.primaryPath;
				extraFolders = result.extraFolders;
				filesExclude = result.filesExclude;
			} catch (err) {
				// 同上：不再静默（原先的静默让 `_fixWorkspaceFilePaths` 的失败完全不可见）。
				this._diag(`error: _fixWorkspaceFilePaths resolve failed for ${fileUri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
			}

			if (!primaryPath) {
				primaryPath = URI.joinPath(fileUri, '..').fsPath;
			}

			// Fix primary path and filesExclude if needed
			const pathChanged = norm(ws.path) !== norm(primaryPath);
			const excludeChanged = JSON.stringify(ws.filesExclude) !== JSON.stringify(filesExclude);
			if (pathChanged || excludeChanged) {
				try {
					await this._wsAgentStudioService.updateWorkspace(ws.id, { path: primaryPath, filesExclude });
					ws.path = primaryPath;
					ws.filesExclude = filesExclude;
				} catch { /* non-fatal */ }
			}

			// Sync extra folders as relatedFolders
			if (extraFolders.length > 0) {
				const existingPaths = new Set(
					(ws.relatedFolders ?? []).map(f => norm(f.path))
				);
				for (const f of extraFolders) {
					if (!existingPaths.has(norm(f.path))) {
						try {
							// ★ 2026-09-15：必须接住返回值并**回写内存副本**。
							// `this._workspaces` 是 `getWorkspaces()` 的快照，与 service 内部不是同一对象
							// ⇒ 只写盘不回写内存的话，紧接着的 `_applyActiveWorkspaceRootsOnStartup()`
							// 读到的 `relatedFolders` 仍是旧的 ⇒ 本次启动补不出多根（要等下次重启）。
							ws.relatedFolders = (await this._wsAgentStudioService.addRelatedFolder(ws.id, f.path)).relatedFolders;
						} catch { /* non-fatal */ }
					}
				}
			}
		}
	}

	/**
	 * ★★★ 修复「记录丢失工作区文件身份」的损坏状态（2026-09-15）。
	 *
	 * ── 为什么要专门修这个 ────────────────────────────────────────────────
	 * 2026-09-15 12:21 实测事故（用户报「工作区 sideview 未显示多根目录」）：
	 * `workspaceFolderSync._projectWindowFoldersToRegistry()` 用**入口快照**写盘，
	 * 而 await 期间「启动补根」把窗口从 1 根扩成 3 根 ⇒ 过期快照把记录的
	 * `relatedFolders` 抹成 `[]`（**根因已修**，见该方法内的 `readWindow` 注释）。
	 *
	 * 但被抹掉的记录**无法自愈**：`_resolveWorkspaceRoots()` 在既无
	 * `codeWorkspacePath` 又无 `relatedFolders` 时只能解析出 1 个 root ⇒
	 * 每次启动都补不出多根 ⇒ 用户永远看到「多根工作区只显示一个目录」，
	 * 且记录不知道那个声明了 3 个根的文件在哪。本方法就是这条自愈通道。
	 *
	 * ── 判据（刻意收得很窄：只认"这个目录自己的声明"）──────────────────
	 *   ① 记录缺 `codeWorkspacePath` **且** `relatedFolders` 为空（完全没有 root 信息）；
	 *   ② `path` 是目录，且目录下存在**与目录同名**的 `<dir>/<dir>.code-workspace`；
	 *   ③ 该文件解析出的 `folders[0]` **就是**这个目录（自证：它是本目录的工作区声明）。
	 *
	 * 三条同时成立才采用 —— 避免「打开任意单根目录，却被同目录下无关的
	 * `.code-workspace` 悄悄扩成多根」这种惊吓。不满足就原样放过（绝大多数记录如此）。
	 *
	 * 修复后写入 `codeWorkspacePath` + `relatedFolders`，**一次性且持久** ⇒
	 * 即使 root 集合将来再被窄化，也能从文件重建（不会重演本次事故）。
	 */
	private async _recoverWorkspaceFileIdentity(): Promise<void> {
		if (!this._wsAgentStudioService || this._workspaces.length === 0) { return; }

		let fileService: IFileService;
		try {
			fileService = this.instantiationService.invokeFunction(a => a.get(IFileService));
		} catch { return; /* file service not available */ }

		const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();

		for (const ws of this._workspaces) {
			// ① 只处理「一点 root 信息都没有」的目录态记录。文件态由 `_fixWorkspaceFilePaths` 负责。
			if (!ws.path || ws.codeWorkspacePath || (ws.relatedFolders ?? []).length > 0) { continue; }
			if (hasWorkspaceFileExtension(ws.path)) { continue; }

			// ② 与目录同名的 `.code-workspace`。
			const dirName = ws.path.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
			if (!dirName) { continue; }
			const candidate = URI.joinPath(URI.file(ws.path), `${dirName}.code-workspace`);

			let result: { primaryPath: string | undefined; extraFolders: { path: string; name: string }[]; filesExclude?: Record<string, boolean> };
			try {
				result = await this._resolveCodeWorkspaceFolders(candidate, fileService);
			} catch {
				continue;   // 文件不存在 / 不可读 ⇒ 不是这个目录的声明
			}

			// ③ 自证：文件声明的**主 root** 必须就是这个目录。
			if (!result.primaryPath || norm(result.primaryPath) !== norm(ws.path)) {
				this._diag(`recover: skipped ${candidate.fsPath} (primary=${result.primaryPath ?? '<none>'} ≠ ${ws.path})`);
				continue;
			}

			this._diag(`recover: restoring workspace file identity | target=${ws.id} file=${candidate.fsPath} extraFolders=${result.extraFolders.length}`);
			try {
				let current = await this._wsAgentStudioService.updateWorkspace(ws.id, {
					codeWorkspacePath: candidate.fsPath,
					filesExclude: result.filesExclude,
				});
				for (const f of result.extraFolders) {
					try {
						current = await this._wsAgentStudioService.addRelatedFolder(ws.id, f.path);
					} catch { /* non-fatal */ }
				}

				// ★★ 必须同步**内存副本** —— 只写盘是不够的。
				//
				// `this._workspaces` 是 `getWorkspaces()` 的**快照**（`_loadWorkspaces()` 第 990 行），
				// 与 service 内部持有的对象**不是同一个** ⇒ 不写回内存的话，
				// 紧接着的 `_applyActiveWorkspaceRootsOnStartup()` 读到的 `relatedFolders` 仍是 `[]`
				// ⇒ 它算出的 roots 只有 1 个 ⇒ 在 `roots.length < 2` 处直接 return
				// ⇒ **本次启动补不出多根**（要等下一次重启才生效，等于自愈"慢一拍"）。
				ws.codeWorkspacePath = candidate.fsPath;
				ws.filesExclude = result.filesExclude;
				ws.relatedFolders = current.relatedFolders;
			} catch (err) {
				this._diag(`recover: failed for ${ws.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * Parse a `.code-workspace` JSON file and resolve ALL folder paths.
	 * Returns `{ primaryPath, extraFolders, filesExclude }` where:
	 * - `primaryPath` is the resolved path of `folders[0]` (used as `workspace.path`)
	 * - `extraFolders` is the rest (used as `workspace.relatedFolders`)
	 * - `filesExclude` is extracted from `settings.files.exclude` (used to hide
	 *   entries in the workspace explorer tree, same as VS Code's native behavior)
	 */
	private async _resolveCodeWorkspaceFolders(
		fileUri: URI,
		fileService: IFileService,
	): Promise<{ primaryPath: string | undefined; extraFolders: { path: string; name: string }[]; filesExclude?: Record<string, boolean>; codebaseMemory?: { excludeDirs?: string[]; keepDirs?: string[]; mode?: string } }> {
		const content = await fileService.readFile(fileUri);
		const text = content.value.toString();

		// ★★ 必须用 JSONC 解析器，**不能**用 `JSON.parse`（2026-09-15 修）。
		//
		// `.code-workspace` 是 JSONC：VS Code 原生支持注释与尾逗号，用户也确实会写
		// （本仓自己的 `sarosis-agents-client.code-workspace` 的 `settings` 里就有大段
		// `//` 注释）。`JSON.parse` 遇注释直接抛错，而调用方的 `catch` 是**静默**的
		// ⇒ `extraFolders` 恒为空、`primaryPath` 退回父目录。
		//
		// 实测后果（用户报「多项目工作区只显示一个项目目录」）：打开一个声明了 3 个
		// folder 的工作区文件，registry 记录只得到 1 个 root，日志里 `extraFolders=0`，
		// 而同一份文件用 JSONC 解析能正确得到 3 个 —— 症状与根因相隔很远，故在此写明。
		//
		// 同一坑已有先例：`agentStudio/browser/codebaseMemoryMcpService.ts:269-273`
		// （日志 2026-08-09 同样踩过），沿用同一写法。
		const parseErrors: ParseError[] = [];
		const parsed = parseJsonc(text, parseErrors);
		if (parseErrors.length > 0) {
			this._diag(`warn: JSONC parse of ${fileUri.fsPath} had ${parseErrors.length} tolerated error(s): ${parseErrors.slice(0, 3).map(e => `@${e.offset}`).join(',')}`);
		}
		const folders: Array<{ path?: string; uri?: string; name?: string }> = parsed?.folders ?? [];

		const resolveOne = (folder: { path?: string; uri?: string; name?: string }): string | undefined => {
			const rawPath: string | undefined = folder.path
				?? (folder.uri ? URI.parse(folder.uri).fsPath : undefined);
			if (!rawPath) { return undefined; }
			if (/^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith('/')) {
				return URI.file(rawPath).fsPath;
			}
			return URI.joinPath(fileUri, '..', rawPath).fsPath;
		};

		const primaryPath = folders.length > 0 ? resolveOne(folders[0]) : undefined;
		const extraFolders: { path: string; name: string }[] = folders.slice(1)
			.filter(f => resolveOne(f) !== undefined)
			.map(f => ({ path: resolveOne(f)!, name: f.name || '' }));

		const filesExclude: Record<string, boolean> | undefined = parsed?.settings?.['files.exclude'];

		// 提取 codebase-memory 配置并应用到 index config
		const codebaseMemoryRaw = parsed?.settings?.['codebase-memory'];
		if (codebaseMemoryRaw && typeof codebaseMemoryRaw === 'object') {
			try {
				const cbmService = this.instantiationService.invokeFunction(a => a.get(ICodebaseMemoryMcpService));
				if (cbmService) {
					const currentConfig = cbmService.getIndexConfig();
					const newConfig: IIndexConfig = {
						mode: (codebaseMemoryRaw.mode as any) || currentConfig.mode,
						excludeDirs: Array.isArray(codebaseMemoryRaw.excludeDirs)
							? codebaseMemoryRaw.excludeDirs
							: currentConfig.excludeDirs,
						keepDirs: Array.isArray(codebaseMemoryRaw.keepDirs)
							? codebaseMemoryRaw.keepDirs
							: currentConfig.keepDirs,
						subPath: currentConfig.subPath,
					};
					cbmService.setIndexConfig(newConfig);
				}
			} catch { /* service not available yet */ }
		}

		return { primaryPath, extraFolders, filesExclude };
	}

	/**
	 * Inject a visual separator into the activity bar between the "tools" group
	 * (workspace, search, sourcecontrol: order <= 40) and the "AI features" group
	 * (session, agents, tasks, workflow, integration, memory, kb, plugins: order > 40).
	 *
	 * The separator is inserted after the last top-group icon and re-positioned
	 * whenever the icon order changes (e.g., after drag-and-drop).
	 */
	private _injectActivityBarSeparator(parent: HTMLElement): void {
		const compositeBar = parent.querySelector('.composite-bar');
		if (!compositeBar) { return; }

		const separator = this.separatorEl = $('div.activity-bar-separator');
		compositeBar.appendChild(separator);

		// Position the separator after the last top-group action item
		this._repositionSeparator(compositeBar);
	}

	/**
	 * Reposition the separator element after the last top-group icon.
	 * Top-group icons have data-container-id matching TOP_GROUP_IDS.
	 */
	private _repositionSeparator(compositeBar?: Element): void {
		if (!this.separatorEl) { return; }
		const bar = compositeBar ?? (this.separatorEl.closest('.composite-bar') as HTMLElement | null);
		if (!bar) { return; }

		const actionItems = bar.querySelectorAll('.action-item');
		let lastTopIndex = -1;

		for (let i = 0; i < actionItems.length; i++) {
			const containerId = actionItems[i].getAttribute('data-container-id') ?? '';
			if (SidebarPart.TOP_GROUP_IDS.has(containerId)) {
				lastTopIndex = i;
			}
		}

		// Place separator after the last top-group icon (or at the end if none found)
		if (lastTopIndex >= 0 && lastTopIndex + 1 < actionItems.length) {
			actionItems[lastTopIndex].after(this.separatorEl);
		} else if (lastTopIndex < 0 && actionItems.length > 0) {
			// No top-group icons found — place separator at the top
			actionItems[0].before(this.separatorEl);
		}
	}

	/**
	 * Listen for pinned view container order changes and validate that
	 * drag-and-drop did not move icons across the activity bar separator.
	 * If icons crossed the boundary, revert to the last valid order.
	 */
	private _setupActivityBarDragValidation(): void {
		// Snapshot the initial valid order
		this._lastValidPinOrder = this.storageService.get(
			SidebarPart.pinnedViewContainersKey,
			StorageScope.PROFILE,
		);

		this._register(this.storageService.onDidChangeValue(
			StorageScope.PROFILE,
			SidebarPart.pinnedViewContainersKey,
			this._store,
		)(() => {
			const currentValue = this.storageService.get(
				SidebarPart.pinnedViewContainersKey,
				StorageScope.PROFILE,
			);
			if (!currentValue) { return; }

			if (this._isPinOrderValid(currentValue)) {
				// Valid order — update the snapshot
				this._lastValidPinOrder = currentValue;
			} else {
				// Invalid order (icons crossed the separator) — revert
				if (this._lastValidPinOrder) {
					this.storageService.store(
						SidebarPart.pinnedViewContainersKey,
						this._lastValidPinOrder,
						StorageScope.PROFILE,
						StorageTarget.USER,
					);
				}
			}

			// Re-position the separator after any order change
			this._repositionSeparator();
		}));
	}

	/**
	 * Check whether the pinned view container order respects the separator
	 * boundary: all TOP_GROUP_IDS must appear before any other icons.
	 */
	private _isPinOrderValid(pinOrderJson: string): boolean {
		try {
			const order: { id: string }[] = JSON.parse(pinOrderJson);
			if (!Array.isArray(order)) { return true; }

			let seenNonTop = false;
			for (const item of order) {
				if (SidebarPart.TOP_GROUP_IDS.has(item.id)) {
					if (seenNonTop) {
						// A top-group icon appeared after a non-top icon — invalid
						return false;
					}
				} else {
					seenNonTop = true;
				}
			}
			return true;
		} catch {
			return true; // ignore parse errors
		}
	}

	private createFooter(parent: HTMLElement): void {
		const footer = append(parent, $('.sidebar-footer.sidebar-action-list'));
		this.footerContainer = footer;

		this.footerToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, footer, Menus.SidebarFooter, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: { primaryGroup: () => true },
			telemetrySource: 'sidebarFooter',
		}));

		this._register(this.footerToolbar.onDidChangeMenuItems(() => {
			if (this.previousLayoutDimensions) {
				const { width, height, top, left } = this.previousLayoutDimensions;
				this.layout(width, height, top, left);
			}
		}));
	}

	private getFooterHeight(): number {
		const actionCount = this.footerToolbar?.getItemsLength() ?? 0;
		if (actionCount === 0) {
			return 0;
		}

		return SidebarPart.FOOTER_VERTICAL_PADDING * 2
			+ (actionCount * SidebarPart.FOOTER_ITEM_HEIGHT)
			+ ((actionCount - 1) * SidebarPart.FOOTER_ITEM_GAP)
			+ SidebarPart.FOOTER_BOTTOM_MARGIN
			+ SidebarPart.FOOTER_BORDER_TOP;
	}

	private updateFooterVisibility(): void {
		const footer = this.footerContainer;
		if (!footer) {
			return;
		}

		footer.style.display = this.getFooterHeight() > 0 ? '' : 'none';
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		container.style.backgroundColor = 'transparent';
		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';
		container.style.outlineColor = this.getColor(SIDE_BAR_DRAG_AND_DROP_BACKGROUND) ?? '';

		// No right border in sessions sidebar
		container.style.borderRightWidth = '';
		container.style.borderRightStyle = '';
		container.style.borderRightColor = '';

		if (this.sideBarTitleArea) {
			this.sideBarTitleArea.style.backgroundColor = 'transparent';
			this.sideBarTitleArea.style.color = this.getColor(agentsPanelForeground) || '';
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		this.previousLayoutDimensions = { width, height, top, left };

		if (!this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
			return;
		}

		// Track expanded width for restore
		if (!this._contentCollapsed && width > SidebarPart.COLLAPSED_WIDTH) {
			// Width tracked for future use when restoring from collapsed state
		}

		this.updateFooterVisibility();
		const footerHeight = Math.min(height, this.getFooterHeight());

		// The sidebar footer is absolutely positioned at the bottom of column 1,
		// outside the grid flow (no third grid row). This avoids both:
		//   (a) an empty cell at row 3 / column 2 (black gap at the bottom), and
		//   (b) .content clientHeight inflation when grid-row spans the footer row.
		// We add padding-bottom to the icon strip (header-or-footer) so icons
		// aren't obscured by the absolutely-positioned footer overlay.
		const container = this.getContainer();
		if (container) {
			const headerOrFooter = container.querySelector<HTMLElement>(':scope > .composite.header-or-footer');
			if (headerOrFooter) {
				headerOrFooter.style.paddingBottom = footerHeight > 0 ? `${footerHeight}px` : '';
			}
		}

		// No height reduction needed: .content occupies grid row 2 (1fr) which
		// fills all remaining space after row 1 (title, auto). The footer is
		// absolutely positioned and doesn't affect the grid sizing.
		//
		// [Saros] Width root-cause fix for viewpanel content overflow:
		// This fork embeds the activity-bar icon strip INSIDE the sidebar part.
		// CSS Grid (`grid-template-columns: 48px 1fr`) renders the icon strip in
		// column 1 (48px) and the content panel in column 2, so the truly visible
		// content width is `partWidth - 48`. However the workbench grid hands us
		// the FULL part width (e.g. 450), and the composite layout chain
		// (CompositePart.layout -> composite.layout -> ViewPane.layoutBody ->
		// tree.layout) would otherwise propagate that full width to every view,
		// making each view's content (and its monaco-list rows) overflow by 48px.
		// Subtracting the icon-strip width here fixes ALL viewpanels at the source,
		// instead of patching each view's layoutBody individually.
		const iconStripWidth = this._contentCollapsed ? 0 : SidebarPart.COLLAPSED_WIDTH;
		const contentWidth = Math.max(SidebarPart.COLLAPSED_WIDTH, width - iconStripWidth);
		super.layout(contentWidth, height, top, left);
	}

	/**
	 * ★★ [Saros] 修「工作区 sideview 底部留白」（2026-09-15，真机日志 + 代码常量双重确认）。
	 *
	 * ── 根因 ──────────────────────────────────────────────────────────
	 * `PartLayout.layout()`（`workbench/browser/part.ts:213-253`）用**硬编码常量**
	 * 计算各段高度，并把 `contentSize` 内联到 `.content`、再交给
	 * `CompositePart.layout()` → `activeComposite.layout(contentSize)`：
	 * ```
	 * titleSize   = options.hasTitle ? 35 : 0
	 * headerSize  = headerVisible    ? 35 : 0
	 * contentSize = height - titleSize - headerSize - footerSize
	 * ```
	 * 但本侧栏**展开态**的几何是 CSS Grid（`media/sidebarPart.css`）：
	 *   · `.composite.title` = `display: none !important` ⇒ 不占任何高度；
	 *   · 图标条 `.composite.header-or-footer` 在 **grid column 1**（侧列，48px 宽）
	 *     ⇒ **不占内容列的垂直空间**。
	 * 两者都不占纵向空间，却各被扣 35px ⇒ 内容区比部件矮 **70px**。
	 *
	 * 真机证据（用户 2026-09-15 日志，`paneCompositePart.ts:601` / `compositePart.ts:527`）：
	 * ```
	 * [PaneCompositePart] layout: partId=workbench.parts.sidebar, width=402, height=997, top=0, left=0
	 * [CompositePart] layout: width=402, height=997, titleSize=35, headerSize=35,
	 *                         footerSize=0, contentSize=927x402, compositeId=agentStudio.workspace
	 * ```
	 * ⇒ 树只拿到 927（部件 997）⇒ **底部留白 70px**。
	 * ⚠ 留白出现在**树的下方**而非部件之外：`.content` 元素被
	 * `height: 100% !important` 撑满了，只有交给 composite 的高度是小的。
	 *
	 * ── 修法 ──────────────────────────────────────────────────────────
	 * 展开态下把 `contentSize` 纠正为**整个部件高度**（图标条在侧列，不参与纵向分配）。
	 * 这与下方 `layout()` 里已有的「减去图标条**宽度**」是同一类修正，只是纵向。
	 * 折叠态不干预：那时 `.content` 本就 `display: none`，且图标条占满整列。
	 */
	protected override layoutContents(width: number, height: number): ILayoutContentResult {
		const result = super.layoutContents(width, height);

		// ── ★★ [Saros] 2026-09-15 回归修复：这里**不能**因折叠态提前 return ✗ ──
		// 原实现有 `if (this._contentCollapsed) { return result; }`，
		// 而真机实测该守卫会在布局时**提前返回** ⇒ 下面的纠正从不执行 ✗
		// ⇒ `PartLayout.layout()`（在 `super.layoutContents` 内）写下的
		//   **1287**（= 部件高 1357 − titleSize 35 − headerSize 35 ✗）成为最终值
		// ⇒ 侧栏底部留白 70px 复发 ✓（该问题此前修过一次，日志证据见上方注释 ✓）。
		// 折叠态无需特殊对待：那时 `.content` 本就 `display: none`，
		// 纠正高度不会有任何视觉影响 ✓。

		// ── ★★ [Saros] 修「侧栏底部留白」（2026-09-15）──────────────────────────
		// 症状：展开态下侧栏内容区**底部空出一块**（真机实测 38px ✓），
		// 根因就在下面这行：原来用**入参 `height`** 当作「整个部件高度」✗，
		// 但 `PartLayout.layout()` 传进来的 `height` 是**内容区高度**（已减去标题区 ✗）
		// ⇒ 于是"纠正回满高"实际纠正成了 **1287**（部件实高 1325）✗
		// ⇒ 该值被 `PaneCompositePart.layout()` 拿去 layout 内层 `PaneView`
		//   ⇒ `.split-view-view` 也只有 1287 ⇒ 底部留白 ✓✓
		// （真机 DOM 证据：`.content` inline height=1287px、`.split-view-view`=1287px，
		//   而 `.monaco-split-view2` 容器是 1325px ✓）
		//
		// 修法：**从 DOM 实测反推**内容区的真实可用高度 ——
		// 用**矩形相减**（`partRect.bottom - contentRect.top`）而不是 `offsetTop`：
		// 实测 `offsetTop` 拿到的是 ~70（不是相对部件的 32 ✗，offsetParent 未必是部件 ✗）
		// ⇒ 会算出 1287 ✗，等于没修 ✓。矩形相减不受 offsetParent 影响 ✓。
		// ⚠ 只取内容区的 **top**（由上方标题区决定，此刻已稳定 ✓），
		// **不用** contentRect.bottom —— 那个值正是我们要纠正的（此刻还是旧的 ✗）。
		// 兜底：DOM 尚未就绪时退回 `height + titleSize.height`（= 把标题区加回来 ✓）。
		let contentHeight = height;
		const partEl = this.element as HTMLElement | undefined;
		const contentEl = this.contentArea as HTMLElement | undefined;
		if (partEl && contentEl) {
			const partRect = partEl.getBoundingClientRect();
			const contentRect = contentEl.getBoundingClientRect();
			const measured = Math.round(partRect.bottom - contentRect.top);
			if (measured > 0) {
				contentHeight = measured;
			}
		} else if (result.titleSize?.height) {
			contentHeight = height + result.titleSize.height;
		}

		const contentSize = new Dimension(width, contentHeight);
		if (this.contentArea) {
			// `PartLayout.layout()` 刚把内容区高度内联上去 —— 这里覆盖回**满高**。
			// （`.content` 的 CSS 有 `height:100% !important` 兜底，但内联值会被
			//  别处读取，故一并纠正，避免只靠 CSS 兜底。）
			size(this.contentArea, contentSize.width, contentSize.height);
		}

		return { ...result, contentSize };
	}

	protected override getTitleAreaDropDownAnchorAlignment(): AnchorAlignment {
		return this.layoutService.getSideBarPosition() === SideBarPosition.LEFT ? AnchorAlignment.LEFT : AnchorAlignment.RIGHT;
	}

	/**
	 * ★★★ [Saros] 不让「图标条容器」占用纵向空间 —— 修「侧栏底部留白」的**真正根因**（2026-09-15）。
	 *
	 * ── 真机证据（已闭环 ✓）────────────────────────────────────────────
	 * `PartLayout` 用的是**硬编码常量**（`workbench/browser/part.ts:204-206`）：
	 * ```ts
	 * private static readonly HEADER_HEIGHT = 35;
	 * private static readonly TITLE_HEIGHT = 35;
	 * ```
	 * 只要 `headerVisible` 为 true，就无条件按 **35px** 预留 ✗ ⇒
	 * `contentSize.height = 1357 − 35(title) − 35(header) = **1287**` ✓✓
	 * 与真机实测**精确吻合**（`.content` 与 `.split-view-view` 的内联高度都是 1287，
	 * 而容器 `.monaco-split-view2` 是 1325 ✓）⇒ 底部留白 **70px** ✓。
	 *
	 * ── 为什么会走到这里 ────────────────────────────────────────────────
	 * 侧栏的 composite bar（= 图标条）由 `paneCompositePart.ts:428` 按位置挂载：
	 * `CompositeBarPosition.TOP` ⇒ `setHeaderArea(...)` ⇒ `headerVisible = true` ✗。
	 * 但侧栏的图标条是**竖向满高**（48×1357 ✓）的**侧列**，**根本不占纵向** ✗
	 * ⇒ 那 35px 是纯浪费 ✓。
	 *
	 * ── 修法 ────────────────────────────────────────────────────────────
	 * 照常让基类完成 DOM 挂载（`prepend` + `header-or-footer header` 类名 ✓ ——
	 * 这些类名是 CSS 依赖的，不能省 ✓），只把**可见性标志复位为 false** ✓。
	 * `partLayout` 在基类是 private ⇒ 用类型擦除访问；取不到就静默跳过 ✓
	 * （宁可少省 35px，也不能抛错影响布局 ✗）。
	 */
	protected override setHeaderArea(headerContainer: HTMLElement): void {
		super.setHeaderArea(headerContainer);

		try {
			(this as unknown as { partLayout?: { setHeaderVisibility(visible: boolean): void } })
				.partLayout?.setHeaderVisibility(false);
		} catch { /* 取不到就跳过（不影响功能，只是仍会少 35px）*/ }
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'sidebar',
			pinnedViewContainersKey: SidebarPart.pinnedViewContainersKey,
			placeholderViewContainersKey: SidebarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: SidebarPart.viewContainersWorkspaceStateKey,
			icon: true,
			orientation: ActionsOrientation.VERTICAL,
			recomputeSizes: false,
			activityHoverOptions: {
				position: () => HoverPosition.RIGHT,
			},
			fillExtraContextMenuActions: actions => {
				const viewsSubmenuAction = this.getViewsSubmenuAction();
				if (viewsSubmenuAction) {
					actions.push(new Separator());
					actions.push(viewsSubmenuAction);
				}
			},
			compositeSize: 40,
			iconSize: 24,
			overflowActionSize: 40,
			colors: theme => ({
				activeBackgroundColor: undefined,
				inactiveBackgroundColor: undefined,
				activeBorderBottomColor: undefined,
				activeForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_FOREGROUND),
				inactiveForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER)
			}),
			compact: false
		};
	}

	protected shouldShowCompositeBar(): boolean {
		return true;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		// [Saros] Use TOP position — the composite bar is placed in a header area
		// above the content, then styled vertically via CSS to create the Activity Bar look.
		return CompositeBarPosition.TOP;
	}

	async focusActivityBar(): Promise<void> {
		if (this.shouldShowCompositeBar()) {
			this.focusCompositeBar();
		}
	}

	toJSON(): object {
		return {
			type: Parts.SIDEBAR_PART
		};
	}
}
