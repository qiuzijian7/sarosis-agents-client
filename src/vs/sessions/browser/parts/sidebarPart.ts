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
import { $, append, addDisposableListener, EventType, getWindowId, prepend, clearNode } from '../../../base/browser/dom.js';
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
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../platform/files/common/files.js';
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

	// [Sarosis] Sidebar with activity bar icons + content panel
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
	private _workspaceListEl: HTMLElement | undefined;
	private _workspaces: Workspace[] = [];
	private _activeWorkspaceId: string | undefined;
	private _wsAgentStudioService: IAgentStudioService | undefined;
	private _wsFileDialogService: IFileDialogService | undefined;

	private _createWorkspaceSelector(toolbar: HTMLElement): void {
		const container = append(toolbar, $('div.sidebar-toolbar-workspace'));

		// ── Selector button ──
		const button = append(container, $('button.ws-selector-btn'));
		button.title = '切换工作区';

		const label = append(button, $('span.ws-selector-label'));
		label.textContent = '---';

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

		// ── Search input ──
		const searchRow = append(dropdown, $('div.ws-dropdown-search'));
		searchRow.style.display = 'flex';
		searchRow.style.alignItems = 'center';
		searchRow.style.padding = '4px 8px 6px';
		searchRow.style.borderBottom = '1px solid var(--vscode-dropdown-border, var(--vscode-widget-border))';

		const searchInput = document.createElement('input');
		searchInput.type = 'text';
		searchInput.className = 'ws-search-input';
		searchInput.placeholder = '搜索工作区...';
		searchInput.style.width = '100%';
		searchInput.style.border = 'none';
		searchInput.style.outline = 'none';
		searchInput.style.background = 'transparent';
		searchInput.style.color = 'var(--vscode-input-foreground, inherit)';
		searchInput.style.fontSize = '12px';
		searchInput.style.padding = '2px 4px';
		searchRow.appendChild(searchInput);
		this._workspaceSearchInput = searchInput;

		// ── Workspace list ──
		const list = append(dropdown, $('div.ws-dropdown-list'));
		list.style.maxHeight = '240px';
		list.style.overflowY = 'auto';
		this._workspaceListEl = list;

		// ── Open folder as workspace button ──
		const createRow = append(dropdown, $('div.ws-dropdown-create'));

		const openFolderBtn = append(createRow, $('button.ws-open-folder-btn'));
		openFolderBtn.textContent = '+ 从文件夹打开工作区';
		openFolderBtn.style.cssText = 'width:100%;border:none;background:transparent;color:var(--vscode-textLink-foreground,#3794ff);cursor:pointer;font-size:12px;padding:4px 8px;border-radius:4px;text-align:left';

		// ── Open workspace from file button ──
		const openFileBtn = append(createRow, $('button.ws-open-file-btn'));
		openFileBtn.textContent = '+ 从文件打开工作区';
		openFileBtn.style.cssText = 'width:100%;border:none;background:transparent;color:var(--vscode-textLink-foreground,#3794ff);cursor:pointer;font-size:12px;padding:4px 8px;border-radius:4px;text-align:left';

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

		this._register(addDisposableListener(searchInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this._closeWorkspaceDropdown();
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

			this._loadWorkspaces();
		} catch {
			setTimeout(() => this._connectWorkspaceServices(), 2000);
		}

		try {
			this._wsFileDialogService = this.instantiationService.invokeFunction(
				accessor => accessor.get(IFileDialogService)
			);
		} catch { /* file dialog service not available yet */ }
	}

	private async _loadWorkspaces(): Promise<void> {
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
		if (!label) { return; }
		const active = this._workspaces.find(w => w.id === this._activeWorkspaceId);
		label.textContent = active?.name || '无工作区';
	}

	private _toggleWorkspaceDropdown(): void {
		if (!this._workspaceDropdownEl) { return; }
		if (this._workspaceDropdownEl.style.display === 'none') {
			this._openWorkspaceDropdown();
		} else {
			this._closeWorkspaceDropdown();
		}
	}

	private _openWorkspaceDropdown(): void {
		if (!this._workspaceSelectorEl || !this._workspaceDropdownEl) { return; }
		const rect = this._workspaceSelectorEl.getBoundingClientRect();
		this._workspaceDropdownEl.style.left = `${rect.left}px`;
		this._workspaceDropdownEl.style.top = `${rect.bottom + 4}px`;
		this._workspaceDropdownEl.style.display = '';
		if (this._workspaceSearchInput) {
			this._workspaceSearchInput.value = '';
		}
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
		// Focus search after render
		setTimeout(() => this._workspaceSearchInput?.focus(), 50);
	}

	private _closeWorkspaceDropdown(): void {
		if (this._workspaceDropdownEl) {
			this._workspaceDropdownEl.style.display = 'none';
		}
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

		if (filtered.length === 0) {
			const empty = append(this._workspaceListEl, $('div.ws-dropdown-empty'));
			empty.textContent = query ? '未找到匹配的工作区' : '暂无工作区';
			empty.style.padding = '12px 12px';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontSize = '12px';
			empty.style.textAlign = 'center';
			return;
		}

		for (const ws of filtered) {
			const item = append(this._workspaceListEl, $('div.ws-dropdown-item'));
			item.style.display = 'flex';
			item.style.alignItems = 'center';
			item.style.padding = '6px 12px';
			item.style.cursor = 'pointer';
			item.style.fontSize = '12px';
			item.style.justifyContent = 'space-between';

			if (ws.id === this._activeWorkspaceId) {
				item.classList.add('active');
			}

			// Hover
			this._register(addDisposableListener(item, EventType.MOUSE_OVER, () => {
				item.style.background = 'var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground))';
			}));
			this._register(addDisposableListener(item, EventType.MOUSE_OUT, () => {
				item.style.background = '';
			}));

			// Click to switch
			this._register(addDisposableListener(item, EventType.CLICK, () => {
				if (ws.id !== this._activeWorkspaceId && this._wsAgentStudioService) {
					this._wsAgentStudioService.setActiveWorkspace(ws.id);
				}
				this._closeWorkspaceDropdown();
			}));

			// Text area (click to switch)
			const textDiv = append(item, $('div.ws-dropdown-item-text'));
			textDiv.style.display = 'flex';
			textDiv.style.flexDirection = 'column';
			textDiv.style.minWidth = '0';
			textDiv.style.flex = '1';

			const nameSpan = append(textDiv, $('span.ws-dropdown-item-name'));
			nameSpan.textContent = ws.name;
			nameSpan.style.fontWeight = '500';
			nameSpan.style.whiteSpace = 'nowrap';
			nameSpan.style.overflow = 'hidden';
			nameSpan.style.textOverflow = 'ellipsis';

			if (ws.path) {
				const pathSpan = append(textDiv, $('span.ws-dropdown-item-path'));
				pathSpan.textContent = ws.path;
				pathSpan.style.fontSize = '10px';
				pathSpan.style.color = 'var(--vscode-descriptionForeground)';
				pathSpan.style.opacity = '0.7';
				pathSpan.style.whiteSpace = 'nowrap';
				pathSpan.style.overflow = 'hidden';
				pathSpan.style.textOverflow = 'ellipsis';
			}

			// Right side: active checkmark + delete button
			const actionsDiv = append(item, $('div.ws-dropdown-item-actions'));
			actionsDiv.style.display = 'flex';
			actionsDiv.style.alignItems = 'center';
			actionsDiv.style.gap = '4px';
			actionsDiv.style.flexShrink = '0';

			if (ws.id === this._activeWorkspaceId) {
				const check = append(actionsDiv, $('span.codicon.codicon-check'));
				check.style.fontSize = '14px';
				check.style.color = 'var(--vscode-textLink-foreground, #3794ff)';
			}

			// Delete button
			const deleteBtn = append(actionsDiv, $('button.ws-delete-btn'));
			deleteBtn.textContent = '\u2715';  // ×
			deleteBtn.title = '删除工作区';
			deleteBtn.style.cssText = 'border:none;background:transparent;color:inherit;cursor:pointer;font-size:11px;padding:0 2px;opacity:0.5;line-height:1';
			deleteBtn.style.display = 'none';  // show on hover via CSS

			this._register(addDisposableListener(deleteBtn, EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();  // don't trigger item click
				this._confirmDeleteWorkspace(ws);
			}));
		}
	}

	private _confirmDeleteWorkspace(ws: Workspace): void {
		if (!this._wsAgentStudioService) { return; }
		this._wsAgentStudioService.deleteWorkspace(ws.id);
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
		await this._wsAgentStudioService.setActiveWorkspace(target.id);

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
		} catch { /* parse failed — fall back to parent directory */ }

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
				target = await this._wsAgentStudioService.updateWorkspace(existing.id, { path: wsPath, filesExclude });
			} else {
				target = await this._wsAgentStudioService.updateWorkspace(existing.id, { filesExclude });
			}
		} else {
			target = await this._wsAgentStudioService.createWorkspace({
				name,
				path: wsPath,
				filesExclude,
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
		await this._wsAgentStudioService.setActiveWorkspace(target.id);

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
			} catch { /* parse or read failed — use fallback */ }

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
							await this._wsAgentStudioService.addRelatedFolder(ws.id, f.path);
						} catch { /* non-fatal */ }
					}
				}
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
		const parsed = JSON.parse(content.value.toString());
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
		// [Sarosis] Width root-cause fix for viewpanel content overflow:
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

	protected override getTitleAreaDropDownAnchorAlignment(): AnchorAlignment {
		return this.layoutService.getSideBarPosition() === SideBarPosition.LEFT ? AnchorAlignment.LEFT : AnchorAlignment.RIGHT;
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
		// [Sarosis] Use TOP position — the composite bar is placed in a header area
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
