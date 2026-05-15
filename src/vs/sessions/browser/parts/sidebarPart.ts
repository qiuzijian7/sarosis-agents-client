/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/sidebar/media/sidebarpart.css';
import './media/sidebarPart.css';
import { IWorkbenchLayoutService, Parts, Position as SideBarPosition } from '../../../workbench/services/layout/browser/layoutService.js';
import { SidebarFocusContext, ActiveViewletContext } from '../../../workbench/common/contextkeys.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
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
import { $, append, getWindowId, prepend } from '../../../base/browser/dom.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { isFullscreen, onDidChangeFullscreen } from '../../../base/browser/browser.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { hasNativeTitlebar, getTitleBarStyle } from '../../../platform/window/common/window.js';
import { isMacintosh, isNative } from '../../../base/common/platform.js';
import { Emitter } from '../../../base/common/event.js';
import { SidebarContentVisibleContext } from '../../common/contextkeys.js';

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

	private footerContainer: HTMLElement | undefined;
	private sideBarTitleArea: HTMLElement | undefined;
	private footerToolbar: MenuWorkbenchToolBar | undefined;
	private previousLayoutDimensions: { width: number; height: number; top: number; left: number } | undefined;

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
		super.layout(width, height, top, left);
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
