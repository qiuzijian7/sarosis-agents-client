/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/titlebar/media/titlebarpart.css';
import { MultiWindowParts, Part } from '../../../workbench/browser/part.js';
import { ITitleService } from '../../../workbench/services/title/browser/titleService.js';
import { getZoomFactor, isWCOEnabled, getWCOTitlebarAreaRect } from '../../../base/browser/browser.js';
import { hasCustomTitlebar, hasNativeTitlebar, DEFAULT_CUSTOM_TITLEBAR_HEIGHT, TitlebarStyle, getTitleBarStyle, getWindowControlsStyle, WindowControlsStyle } from '../../../platform/window/common/window.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { TITLE_BAR_ACTIVE_BACKGROUND, TITLE_BAR_ACTIVE_FOREGROUND, TITLE_BAR_INACTIVE_FOREGROUND, TITLE_BAR_INACTIVE_BACKGROUND, TITLE_BAR_BORDER } from '../../../workbench/common/theme.js';
import { isMacintosh, isWeb, isNative, platformLocale, isWindows, isLinux } from '../../../base/common/platform.js';
import { EventType, EventHelper, append, $, addDisposableListener, prepend, getWindow, getWindowId, isHTMLElement, isAncestor } from '../../../base/browser/dom.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { Parts, IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';

import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IEditorGroupsContainer } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { CodeWindow, mainWindow } from '../../../base/browser/window.js';
import { safeIntl } from '../../../base/common/date.js';
import { ITitlebarPart, ITitleProperties, ITitleVariable, IAuxiliaryTitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { Menus } from '../menus.js';
import { CustomMenubarControl } from '../../../workbench/browser/parts/titlebar/menubarControl.js';

/**
 * VS Code native-layout titlebar for agent sessions.
 *
 * Layout (matches standard VS Code):
 * - **Left**:   (empty — no app icon for sessions)
 * - **Center**: Window title text (product name)
 * - **Right**:  Window controls (min/max/close) + context menu
 *
 * No menubar, no editor actions, no layout controls.
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
	private centerContent!: HTMLElement;
	private rightContent!: HTMLElement;

	get leftContainer(): HTMLElement { return this.leftContent; }
	get rightContainer(): HTMLElement { return this.rightContent; }
	get rightWindowControlsContainer(): HTMLElement | undefined { return this.windowControlsContainer; }

	protected readonly customMenubar = this._register(new MutableDisposable<CustomMenubarControl>());
	private menubar: HTMLElement | undefined;

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
		@IProductService protected readonly productService: IProductService,
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
		this.rootContainer = append(parent, $('.titlebar-container'));

		// Draggable region
		prepend(this.rootContainer, $('div.titlebar-drag-region'));

		this.leftContent = append(this.rootContainer, $('.titlebar-left'));
		this.centerContent = append(this.rootContainer, $('.titlebar-center'));
		this.rightContent = append(this.rootContainer, $('.titlebar-right'));

		// App Icon (Windows, Linux — matches native VS Code)
		if ((isWindows || isLinux) && !hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			const appIcon = prepend(this.leftContent, $('a.window-appicon'));
			appIcon.textContent = '🛠'; // gear/tools icon for agent studio
		}

		// Menubar
		this.installMenubar();

		// Window Title
		const windowTitle = append(this.centerContent, $('div.window-title'));
		const productName = this.productService.nameShort || this.productService.nameLong || 'VsSaros';
		windowTitle.textContent = productName;
		windowTitle.style.display = 'flex';
		windowTitle.style.alignItems = 'center';
		windowTitle.style.justifyContent = 'center';
		windowTitle.style.height = '100%';
		windowTitle.style.padding = '0 12px';
		windowTitle.style.fontSize = '12px';
		windowTitle.style.opacity = '0.7';
		windowTitle.style.userSelect = 'none';
		(windowTitle.style as any).webkitAppRegion = 'no-drag';

		// Window Controls Container
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
				// macOS native: traffic lights are rendered by the OS
			} else if (getWindowControlsStyle(this.configurationService) === WindowControlsStyle.HIDDEN) {
				// controls explicitly disabled
			} else {
				this.windowControlsContainer = append(
					primaryWindowControlsLocation === 'left' ? this.leftContent : this.rightContent,
					$('div.window-controls-container')
				);

				// ── 弹出 + 伸缩按钮：弹出聊天独立窗口 / 折叠右侧栏 ──
				// 包裹在 no-drag 容器中，避免父级 titlebar drag region
				// 导致的鼠标 cursor 闪烁问题。
				if (primaryWindowControlsLocation === 'right') {
					const toggleContainer = append(this.rightContent, $('div.titlebar-toggle-container'));
					toggleContainer.id = 'agent-studio-titlebar-toggle-container';

					// 弹出按钮：隐藏右侧栏并弹出独立聊天窗口
					const popoutBtn = append(toggleContainer, $('button.titlebar-popout-chat'));
					popoutBtn.classList.add('codicon', 'codicon-open-in-window');
					popoutBtn.title = 'Pop Out Chat Window';
					popoutBtn.setAttribute('aria-label', 'Pop Out Chat Window');
					popoutBtn.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						document.dispatchEvent(new CustomEvent('agent-studio:popout-chat'));
					});

					// 折叠按钮
					const toggleBtn = append(toggleContainer, $('button.titlebar-toggle-right-column'));
					toggleBtn.classList.add('codicon', 'codicon-layout-sidebar-left');
					toggleBtn.title = 'Toggle Sidebar Content';
					toggleBtn.setAttribute('aria-label', 'Toggle Sidebar Content');
					toggleBtn.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						document.dispatchEvent(new CustomEvent('agent-studio:toggle-right-column'));
					});
					// 将容器移到 window-controls-container 之前
					this.rightContent.insertBefore(toggleContainer, this.windowControlsContainer);
				}
				if (isWeb) {
					append(
						primaryWindowControlsLocation === 'left' ? this.rightContent : this.leftContent,
						$('div.window-controls-container')
					);
				}
				if (isWCOEnabled()) {
					this.windowControlsContainer.classList.add('wco-enabled');
				}
			}
		}

		// Context menu on the titlebar
		this._register(addDisposableListener(this.rootContainer, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e);

			let targetMenu = Menus.TitleBarContext;
			if (isMacintosh && isHTMLElement(e.target) && isAncestor(e.target, windowTitle)) {
				targetMenu = Menus.TitleBarContext; // simplified: no separate title context
			}

			this.onContextMenu(e, targetMenu);
		}));

		this.updateStyles();

		return this.element;
	}

	override updateStyles(): void {
		super.updateStyles();

		if (this.element) {
			this.element.classList.toggle('inactive', this.isInactive);

			// Use VS Code native titlebar theme colors
			const activeBackground = this.getColor(TITLE_BAR_ACTIVE_BACKGROUND);
			const activeForeground = this.getColor(TITLE_BAR_ACTIVE_FOREGROUND);
			const inactiveBackground = this.getColor(TITLE_BAR_INACTIVE_BACKGROUND);
			const inactiveForeground = this.getColor(TITLE_BAR_INACTIVE_FOREGROUND);
			const borderColor = this.getColor(TITLE_BAR_BORDER);

			this.element.style.backgroundColor = this.isInactive
				? (inactiveBackground || '')
				: (activeBackground || '');

			this.element.style.color = this.isInactive
				? (inactiveForeground || '')
				: (activeForeground || '');

			this.element.style.borderBottom = borderColor ? `1px solid ${borderColor}` : '';
		}
	}

	private onContextMenu(e: MouseEvent, menuId: MenuId): void {
		const event = new StandardMouseEvent(getWindow(this.element), e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			menuId,
			contextKeyService: this.contextKeyService,
			domForShadowRoot: isMacintosh && isNative ? event.target : undefined
		});
	}

	protected installMenubar(): void {
		if (this.menubar) {
			return;
		}

		this.customMenubar.value = this.instantiationService.createInstance(CustomMenubarControl);

		this.menubar = append(this.leftContent, $('div.menubar'));
		this.menubar.setAttribute('role', 'menubar');

		this._register(this.customMenubar.value.onVisibilityChange(e => {
			this._onMenubarVisibilityChange.fire(e);
		}));

		this.customMenubar.value.create(this.menubar);
	}

	get hasZoomableElements(): boolean {
		return true;
	}

	get preventZoom(): boolean {
		return getZoomFactor(getWindow(this.element)) < 1 || !this.hasZoomableElements;
	}

	override layout(width: number, height: number): void {
		this.updateLayout();
		super.layoutContents(width, height);
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
