/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/titlebar/media/titlebarpart.css';
import './media/titlebarpart.css';
import { MultiWindowParts, Part } from '../../../workbench/browser/part.js';
import { ITitleService } from '../../../workbench/services/title/browser/titleService.js';
import { getZoomFactor, isWCOEnabled, getWCOTitlebarAreaRect, isFullscreen, onDidChangeFullscreen } from '../../../base/browser/browser.js';
import { hasCustomTitlebar, hasNativeTitlebar, DEFAULT_CUSTOM_TITLEBAR_HEIGHT, TitlebarStyle, getTitleBarStyle, getWindowControlsStyle, WindowControlsStyle } from '../../../platform/window/common/window.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { agentsPanelForeground } from '../../common/theme.js';
import { isMacintosh, isWeb, isNative, platformLocale } from '../../../base/common/platform.js';
import { EventType, EventHelper, append, $, addDisposableListener, prepend, getWindow, getWindowId, getContentWidth } from '../../../base/browser/dom.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { Parts, IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';

import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { IEditorGroupsContainer } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { CodeWindow, mainWindow } from '../../../base/browser/window.js';
import { safeIntl } from '../../../base/common/date.js';
import { ITitlebarPart, ITitleProperties, ITitleVariable, IAuxiliaryTitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { Menus } from '../menus.js';
import { AgentStudioWorkspaceToolbar } from '../../contrib/agentStudio/browser/agentStudioWorkspaceToolbar.js';
import { IAgentStudioService } from '../../contrib/agentStudio/common/agentStudio.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../platform/files/common/files.js';

/**
 * Simplified agent sessions titlebar part.
 *
 * Three sections driven entirely by menus:
 * - **Left**: `Menus.TitleBarLeft` toolbar
 * - **Center**: `Menus.CommandCenter` toolbar (renders session picker via IActionViewItemService)
 * - **Right**: `Menus.TitleBarRight` toolbar (includes account submenu)
 *
 * No menubar, no editor actions, no layout controls, no WindowTitle dependency.
 */
export class TitlebarPart extends Part implements ITitlebarPart {

	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;

	get minimumHeight(): number {
		const wcoEnabled = isWeb && isWCOEnabled();
		let value = DEFAULT_CUSTOM_TITLEBAR_HEIGHT;
		if (wcoEnabled) {
			value = Math.max(value, getWCOTitlebarAreaRect(getWindow(this.element))?.height ?? 0);
		}

		return value / (this.preventZoom ? getZoomFactor(getWindow(this.element)) : 1);
	}

	get maximumHeight(): number { return this.minimumHeight; }

	//#endregion

	//#region Events

	private readonly _onMenubarVisibilityChange = this._register(new Emitter<boolean>());
	readonly onMenubarVisibilityChange = this._onMenubarVisibilityChange.event;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	//#endregion

	private rootContainer!: HTMLElement;
	private windowControlsContainer: HTMLElement | undefined;

	private leftContent!: HTMLElement;
	private leftToolbarContainer!: HTMLElement;
	private centerContent!: HTMLElement;
	private rightContent!: HTMLElement;

	get leftContainer(): HTMLElement { return this.leftContent; }
	get rightContainer(): HTMLElement { return this.rightContent; }
	get rightWindowControlsContainer(): HTMLElement | undefined { return this.windowControlsContainer; }

	private sideBarPartResizeObserver: ResizeObserver | undefined;
	private leftToolbarContentWidth: number = 0;
	private lastSideBarWidth: number = 0;
	private leftSpacerWidth: number = 0;
	private _workspaceSelectorContainer: HTMLElement | undefined;

	private readonly titleBarStyle: TitlebarStyle;
	private isInactive: boolean = false;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHostService private readonly hostService: IHostService,
		@IProductService private readonly productService: IProductService,
	) {
		super(id, { hasTitle: false }, themeService, storageService, layoutService);

		this.titleBarStyle = getTitleBarStyle(this.configurationService);

		this.registerListeners(getWindowId(targetWindow));
	}

	private registerListeners(targetWindowId: number): void {
		this._register(this.hostService.onDidChangeFocus(focused => focused ? this.onFocus() : this.onBlur()));
		this._register(this.hostService.onDidChangeActiveWindow(windowId => windowId === targetWindowId ? this.onFocus() : this.onBlur()));
	}

	private onBlur(): void {
		this.isInactive = true;
		this.updateStyles();
	}

	private onFocus(): void {
		this.isInactive = false;
		this.updateStyles();
	}

	updateProperties(_properties: ITitleProperties): void {
		// No window title to update in simplified titlebar
	}

	registerVariables(_variables: ITitleVariable[]): void {
		// No window title variables in simplified titlebar
	}

	updateOptions(_options: { compact: boolean }): void {
		// No compact mode support in agent sessions titlebar
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.rootContainer = append(parent, $('.titlebar-container.sessions-titlebar-container.has-center'));

		// Draggable region
		prepend(this.rootContainer, $('div.titlebar-drag-region'));

		this.leftContent = append(this.rootContainer, $('.titlebar-left'));
		this.centerContent = append(this.rootContainer, $('.titlebar-center'));
		this.rightContent = append(this.rootContainer, $('.titlebar-right'));

		// Window Controls Container (must be before left toolbar for correct ordering)
		if (!hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			let primaryWindowControlsLocation = isMacintosh ? 'left' : 'right';
			if (isMacintosh && isNative) {
				const localeInfo = safeIntl.Locale(platformLocale).value;
				const textInfo = (localeInfo as { textInfo?: { direction?: string } }).textInfo;
				if (textInfo?.direction === 'rtl') {
					primaryWindowControlsLocation = 'right';
				}
			}

			if (isMacintosh && isNative && primaryWindowControlsLocation === 'left') {
				// macOS native: traffic lights are rendered by the OS at the top-left corner.
				// Add a fixed-width spacer to push content past the traffic lights.
				const spacer = append(this.leftContent, $('div.window-controls-container'));

				// Hide spacer in fullscreen (traffic lights are not shown)
				const updateSpacerVisibility = () => {
					const fullscreen = isFullscreen(mainWindow);
					spacer.style.display = fullscreen ? 'none' : '';
					this.leftSpacerWidth = fullscreen ? 0 : 70;
				};
				updateSpacerVisibility();
				spacer.style.width = `${this.leftSpacerWidth}px`;
				spacer.style.flexShrink = '0';
				this._register(onDidChangeFullscreen(windowId => {
					if (windowId === getWindowId(mainWindow)) {
						updateSpacerVisibility();
						this.updateLeftContentWidth();
					}
				}));
			} else if (getWindowControlsStyle(this.configurationService) === WindowControlsStyle.HIDDEN) {
				// controls explicitly disabled
			} else {
				this.windowControlsContainer = append(primaryWindowControlsLocation === 'left' ? this.leftContent : this.rightContent, $('div.window-controls-container'));
				if (isWeb) {
					append(primaryWindowControlsLocation === 'left' ? this.rightContent : this.leftContent, $('div.window-controls-container'));
				}

				if (isWCOEnabled()) {
					this.windowControlsContainer.classList.add('wco-enabled');
				}
			}
		}

		// Left toolbar (driven by Menus.TitleBarLeft, rendered after window controls via CSS order)
		this.leftToolbarContainer = append(this.leftContent, $('div.left-toolbar-container'));
		const leftToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, this.leftToolbarContainer, Menus.TitleBarLeftLayout, {
			contextMenu: Menus.TitleBarContext,
			telemetrySource: 'titlePart.left',
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: { primaryGroup: () => true },
		}));
		this.leftToolbarContentWidth = getContentWidth(this.leftToolbarContainer);
		this.updateLeftContentWidth();
		this._register(leftToolbar.onDidChangeMenuItems(() => {
			this.leftToolbarContentWidth = getContentWidth(this.leftToolbarContainer);
			this.updateLeftContentWidth();
		}));

		// Workspace selector — absolutely positioned to the right side of the
		// titlebar-left band (which tracks the sidebar width). Using absolute
		// positioning so it does NOT participate in the flex flow and cannot
		// interfere with the sidebar/activitybar layout.
		this._createWorkspaceToolbar();

		// Version label — shown to the right of the hamburger button
		const versionLabel = append(this.leftContent, $('span.titlebar-version-label'));
		const version = this.productService.version || '';
		versionLabel.textContent = version ? `v${version}` : '';
		versionLabel.title = `${this.productService.nameLong || 'VsSarosis'} v${version}`;

		// Center toolbar - command center (renders session picker via IActionViewItemService)
		// Uses .window-title > .command-center nesting to match default workbench CSS selectors
		const windowTitle = append(this.centerContent, $('div.window-title'));
		const centerToolbarContainer = append(windowTitle, $('div.command-center'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, centerToolbarContainer, Menus.CommandCenter, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'commandCenter',
			toolbarOptions: { primaryGroup: () => true },
		}));

		// Right toolbar (driven by Menus.TitleBarRightLayout - includes layout actions)
		const rightToolbarContainer = prepend(this.rightContent, $('div.titlebar-actions-container.titlebar-right-layout-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, rightToolbarContainer, Menus.TitleBarRightLayout, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'titlePart.right',
			toolbarOptions: { primaryGroup: () => true },
		}));

		// Session title actions toolbar (before right toolbar)
		const sessionActionsContainer = prepend(this.rightContent, $('div.titlebar-actions-container.titlebar-session-actions-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, sessionActionsContainer, Menus.TitleBarSessionMenu, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'titlePart.sessionActions',
			toolbarOptions: { primaryGroup: () => true },
		}));

		// Context menu on the titlebar
		this._register(addDisposableListener(this.rootContainer, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e);
			this.onContextMenu(e);
		}));

		this.updateStyles();

		return this.element;
	}

	/**
	 * Create workspace selector toolbar inside titlebar-left, absolutely
	 * positioned to the right side. This avoids flex flow interference that
	 * previously caused the activitybar to disappear. The container is placed
	 * inside `.titlebar-left` (which has inline width = sidebar width), so
	 * `right:0` aligns it to the right edge of the sidebar.
	 */
	private _createWorkspaceToolbar(): void {
		const container = append(this.leftContent, $('div.titlebar-workspace-selector'));
		this._workspaceSelectorContainer = container;
		const toolbar = this._register(new AgentStudioWorkspaceToolbar(container, {
			variant: 'titlebar',
			showBadge: false,
			insertMode: 'append',
		}));

		const connectService = () => {
			try {
				const agentStudioService = this.instantiationService.invokeFunction(accessor => accessor.get(IAgentStudioService));
				toolbar.connectService(agentStudioService);
			} catch { setTimeout(connectService, 2000); }
		};
		connectService();

		const connectFileDialog = () => {
			try {
				const fileDialogService = this.instantiationService.invokeFunction(accessor => accessor.get(IFileDialogService));
				toolbar.connectFileDialogService(fileDialogService);
			} catch { setTimeout(connectFileDialog, 2000); }
		};
		connectFileDialog();

		const connectFileSvc = () => {
			try {
				const fileService = this.instantiationService.invokeFunction(accessor => accessor.get(IFileService));
				toolbar.connectFileService(fileService);
			} catch { setTimeout(connectFileSvc, 2000); }
		};
		connectFileSvc();
	}

	override updateStyles(): void {
		super.updateStyles();

		if (this.element) {
			this.element.classList.toggle('inactive', this.isInactive);

			// Titlebar is transparent — it inherits the sidebar/gradient background via CSS.
			// Only set foreground color for text/icon contrast.
			this.element.style.backgroundColor = '';

			const titleForeground = this.getColor(agentsPanelForeground);
			this.element.style.color = titleForeground || '';
		}
	}

	private onContextMenu(e: MouseEvent): void {
		const event = new StandardMouseEvent(getWindow(this.element), e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			menuId: Menus.TitleBarContext,
			contextKeyService: this.contextKeyService,
			domForShadowRoot: isMacintosh && isNative ? event.target : undefined
		});
	}

	get hasZoomableElements(): boolean {
		return true; // sessions titlebar always has command center and toolbar actions
	}

	get preventZoom(): boolean {
		// Prevent zooming behavior if any of the following conditions are met:
		// 1. Shrinking below the window control size (zoom < 1)
		// 2. No custom items are present in the title bar
		return getZoomFactor(getWindow(this.element)) < 1 || !this.hasZoomableElements;
	}

	override layout(width: number, height: number): void {
		this.updateLayout();
		super.layoutContents(width, height);
		this.installSideBarPartResizeObserver();
	}

	private installSideBarPartResizeObserver(): void {
		if (this.sideBarPartResizeObserver) {
			return;
		}

		const sideBarContainer = this.layoutService.getContainer(getWindow(this.element), Parts.SIDEBAR_PART);
		if (!sideBarContainer) {
			return;
		}

		this.sideBarPartResizeObserver = new ResizeObserver(entries => {
			this.lastSideBarWidth = entries[0].contentRect.width;
			this.updateLeftContentWidth();

			// Hide workspace selector when sidebar is collapsed (width ≈ 0)
			if (this._workspaceSelectorContainer) {
				const isCollapsed = entries[0].contentRect.width < 50;
				this._workspaceSelectorContainer.classList.toggle('hidden', isCollapsed);
			}
		});
		this.sideBarPartResizeObserver.observe(sideBarContainer);
		this._register({ dispose: () => this.sideBarPartResizeObserver?.disconnect() });
	}

	private getLeftContentWidth(): number {
		if (this.leftToolbarContentWidth === 0) {
			this.leftToolbarContentWidth = getContentWidth(this.leftToolbarContainer);
		}
		return this.leftToolbarContentWidth + this.leftSpacerWidth;
	}

	private updateLeftContentWidth(): void {
		this.leftContent.style.width = `${Math.max(this.getLeftContentWidth(), this.lastSideBarWidth)}px`;
	}

	private updateLayout(): void {
		if (!hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			return;
		}

		const zoomFactor = getZoomFactor(getWindow(this.element));
		this.element.style.setProperty('--zoom-factor', zoomFactor.toString());
		this.rootContainer.classList.toggle('counter-zoom', this.preventZoom);
	}

	focus(): void {
		// eslint-disable-next-line no-restricted-syntax
		(this.element.querySelector('[tabindex]:not([tabindex="-1"])') as HTMLElement | null)?.focus();
	}

	toJSON(): object {
		return { type: Parts.TITLEBAR_PART };
	}

	override dispose(): void {
		this._onWillDispose.fire();
		super.dispose();
	}
}

/**
 * Main agent sessions titlebar part (for the main window).
 */
export class MainTitlebarPart extends TitlebarPart {

	constructor(
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@IProductService productService: IProductService,
	) {
		super(Parts.TITLEBAR_PART, mainWindow, contextMenuService, configurationService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, productService);
	}
}

/**
 * Auxiliary agent sessions titlebar part (for auxiliary windows).
 */
export class AuxiliaryTitlebarPart extends TitlebarPart implements IAuxiliaryTitlebarPart {

	private static COUNTER = 1;

	get height() { return this.minimumHeight; }

	constructor(
		readonly container: HTMLElement,
		private readonly mainTitlebar: TitlebarPart,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@IProductService productService: IProductService,
	) {
		const id = AuxiliaryTitlebarPart.COUNTER++;
		super(`workbench.parts.auxiliaryTitle.${id}`, getWindow(container), contextMenuService, configurationService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, productService);
	}

	override get preventZoom(): boolean {
		// Prevent zooming behavior if any of the following conditions are met:
		// 1. Shrinking below the window control size (zoom < 1)
		// 2. No custom items are present in the main title bar
		// The auxiliary title bar never contains any zoomable items itself,
		// but we want to match the behavior of the main title bar.
		return getZoomFactor(getWindow(this.element)) < 1 || !this.mainTitlebar.hasZoomableElements;
	}
}

/**
 * Agent Sessions title service - manages the titlebar parts.
 */
export class TitleService extends MultiWindowParts<TitlebarPart> implements ITitleService {

	declare _serviceBrand: undefined;

	readonly mainPart: TitlebarPart;

	constructor(
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService
	) {
		super('workbench.agentSessionsTitleService', themeService, storageService);

		this.mainPart = this._register(this.createMainTitlebarPart());
		this.onMenubarVisibilityChange = this.mainPart.onMenubarVisibilityChange;
		this._register(this.registerPart(this.mainPart));
	}

	protected createMainTitlebarPart(): TitlebarPart {
		return this.instantiationService.createInstance(MainTitlebarPart);
	}

	//#region Auxiliary Titlebar Parts

	createAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): IAuxiliaryTitlebarPart {
		const titlebarPartContainer = $('.part.titlebar', { role: 'none' });
		titlebarPartContainer.style.position = 'relative';
		container.insertBefore(titlebarPartContainer, container.firstChild);

		const disposables = new DisposableStore();

		const titlebarPart = this.doCreateAuxiliaryTitlebarPart(titlebarPartContainer, editorGroupsContainer, instantiationService);
		disposables.add(this.registerPart(titlebarPart));

		disposables.add(Event.runAndSubscribe(titlebarPart.onDidChange, () => titlebarPartContainer.style.height = `${titlebarPart.height}px`));
		titlebarPart.create(titlebarPartContainer);

		Event.once(titlebarPart.onWillDispose)(() => disposables.dispose());

		return titlebarPart;
	}

	protected doCreateAuxiliaryTitlebarPart(container: HTMLElement, _editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): TitlebarPart & IAuxiliaryTitlebarPart {
		return instantiationService.createInstance(AuxiliaryTitlebarPart, container, this.mainPart);
	}

	//#endregion

	//#region Service Implementation

	readonly onMenubarVisibilityChange: Event<boolean>;

	updateProperties(properties: ITitleProperties): void {
		for (const part of this.parts) {
			part.updateProperties(properties);
		}
	}

	registerVariables(variables: ITitleVariable[]): void {
		for (const part of this.parts) {
			part.registerVariables(variables);
		}
	}

	//#endregion
}
