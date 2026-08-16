/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getZoomFactor } from '../../../base/browser/browser.js';
import { $, addDisposableListener, EventType, getWindow, getWindowId } from '../../../base/browser/dom.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { useWindowControlsOverlay } from '../../../platform/window/common/window.js';
import { IsWindowAlwaysOnTopContext } from '../../../workbench/common/contextkeys.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IAuxiliaryTitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { IEditorGroupsContainer } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { CodeWindow, mainWindow } from '../../../base/browser/window.js';
import { TitlebarPart, TitleService } from '../../browser/parts/titlebarPart.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IWorkbenchEnvironmentService } from '../../../workbench/services/environment/common/environmentService.js';

export class NativeTitlebarPart extends TitlebarPart {

	private cachedWindowControlStyles: { bgColor: string; fgColor: string } | undefined;
	private cachedWindowControlHeight: number | undefined;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@IProductService productService: IProductService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IOpenerService openerService: IOpenerService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super(id, targetWindow, contextMenuService, configurationService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, productService, openerService, environmentService);

		this.handleWindowsAlwaysOnTop(targetWindow.vscodeWindowId, contextKeyService);
	}

	/**
	 * Override: use the native OS shell to open the logs folder in the
	 * system file explorer (e.g., Windows Explorer / macOS Finder),
	 * rather than inside VS Code's own file explorer.
	 */
	protected override _handleFeedback(): void {
		const logsPath = this.environmentService.logsHome.fsPath;
		// Open logs folder in OS file explorer via native shell
		this.nativeHostService.showItemInFolder(logsPath);
		// Open TAPD feedback page
		this.openerService.open('https://www.tapd.cn/tapd_fe/30076258/storywall');
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {

		// Workaround for macOS/Electron bug where the window does not
		// appear in the "Windows" menu if the first `document.title`
		// matches the BrowserWindow's initial title.
		// See: https://github.com/microsoft/vscode/issues/191288
		if (isMacintosh) {
			const window = getWindow(this.element);
			const nativeTitle = this.productService.nameLong;
			if (!window.document.title || window.document.title === nativeTitle) {
				window.document.title = `${nativeTitle} \u200b`;
			}
			window.document.title = nativeTitle;
		}

		return super.createContentArea(parent);
	}

	private async handleWindowsAlwaysOnTop(targetWindowId: number, contextKeyService: IContextKeyService): Promise<void> {
		const isWindowAlwaysOnTopContext = IsWindowAlwaysOnTopContext.bindTo(contextKeyService);

		this._register(this.nativeHostService.onDidChangeWindowAlwaysOnTop(({ windowId, alwaysOnTop }) => {
			if (windowId === targetWindowId) {
				isWindowAlwaysOnTopContext.set(alwaysOnTop);
			}
		}));

		isWindowAlwaysOnTopContext.set(await this.nativeHostService.isWindowAlwaysOnTop({ targetWindowId }));
	}

	override updateStyles(): void {
		super.updateStyles();

		if (this.element) {
			if (useWindowControlsOverlay(this.configurationService)) {
				if (
					!this.cachedWindowControlStyles ||
					this.cachedWindowControlStyles.bgColor !== this.element.style.backgroundColor ||
					this.cachedWindowControlStyles.fgColor !== this.element.style.color
				) {
					this.cachedWindowControlStyles = {
						bgColor: this.element.style.backgroundColor,
						fgColor: this.element.style.color
					};
					this.nativeHostService.updateWindowControls({
						targetWindowId: getWindowId(getWindow(this.element)),
						backgroundColor: this.element.style.backgroundColor,
						foregroundColor: this.element.style.color
					});
				}
			}
		}
	}

	override layout(width: number, height: number): void {
		super.layout(width, height);

		if (useWindowControlsOverlay(this.configurationService)) {
			const newHeight = Math.round(height * getZoomFactor(getWindow(this.element)));
			if (newHeight !== this.cachedWindowControlHeight) {
				this.cachedWindowControlHeight = newHeight;
				this.nativeHostService.updateWindowControls({
					targetWindowId: getWindowId(getWindow(this.element)),
					height: newHeight
				});
			}
		}
	}
}

class MainNativeTitlebarPart extends NativeTitlebarPart {

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
		@INativeHostService nativeHostService: INativeHostService,
		@IOpenerService openerService: IOpenerService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super(Parts.TITLEBAR_PART, mainWindow, contextMenuService, configurationService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, productService, nativeHostService, openerService, environmentService);
	}
}

class AuxiliaryNativeTitlebarPart extends NativeTitlebarPart implements IAuxiliaryTitlebarPart {

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
		@INativeHostService nativeHostService: INativeHostService,
		@IOpenerService openerService: IOpenerService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		const id = AuxiliaryNativeTitlebarPart.COUNTER++;
		super(`workbench.parts.auxiliaryTitle.${id}`, getWindow(container), contextMenuService, configurationService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, productService, nativeHostService, openerService, environmentService);
	}

	override get preventZoom(): boolean {
		return getZoomFactor(getWindow(this.element)) < 1 || !this.mainTitlebar.hasZoomableElements;
	}

	/** popout 独立窗口：隐藏标题栏的反馈 / Toggle Panel / Toggle Sidebar 按钮（只作用于主窗口布局） */
	protected override get _showTitlebarToggles(): boolean { return false; }

	/**
	 * popout 独立窗口标题栏：在最小化按钮（window-controls-container）左侧新增
	 * 「新建聊天 Group」按钮。点击后执行 agentStudio.newChatGroup——在当前 aux part
	 * 新建一个 group 并在其中打开新聊天（替代 group 内被隐藏的 + 按钮）。
	 */
	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const el = super.createContentArea(parent);

		const btn = $('a.titlebar-new-chat-group', { role: 'button', 'aria-label': '新建聊天 Group' });
		btn.title = '新建聊天 Group';
		btn.classList.add('codicon', 'codicon-add');
		// 关键：titlebar 整体是 -webkit-app-region: drag（用于拖拽窗口），按钮必须设 no-drag
		// 才能接收 click。注意：-webkit-app-region 不能写在内联 style（vendor 前缀会被
		// Chromium 归一化成 app-region，Electron 不识别），必须写在样式表里——见
		// workbench/browser/parts/titlebar/media/titlebarpart.css 的 .titlebar-new-chat-group 规则
		//（aux titlebar 继承链实际加载的是该文件，而非 sessions 版的同名 css）。
		btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:28px;height:100%;font-size:15px;cursor:pointer;color:var(--vscode-titleBar-inactiveForeground,var(--vscode-foreground));';
		// 兜底：setProperty 直接写 CSSOM 声明（属性名原样保留 -webkit-app-region，不会被
		// cssText 解析器归一化剥掉 vendor 前缀）。双保险：样式表规则 + 运行时 setProperty。
		try {
			btn.style.setProperty('-webkit-app-region', 'no-drag');
			btn.style.setProperty('app-region', 'no-drag');
		} catch { /* ignore */ }
		btn.setAttribute('data-testid', 'titlebar-new-chat-group');
		// [diag] mousedown 是否到达（drag region 会吞掉 mousedown + click 整套鼠标事件）
		this._register(addDisposableListener(btn, EventType.MOUSE_DOWN, () => {
			// eslint-disable-next-line no-console
			console.info('[diag][titlebar] newChatGroup button MOUSE_DOWN');
		}));
		// [diag] 定位 popout aux 窗口「新建聊天 Group」按钮点击无反应
		this._register(addDisposableListener(btn, EventType.CLICK, (e) => {
			// eslint-disable-next-line no-console
			console.info('[diag][titlebar] newChatGroup button CLICKED', { target: (e.target as HTMLElement)?.tagName, hasCommandService: !!this.commandService });
			try {
				const promise = this.commandService.executeCommand('agentStudio.newChatGroup');
				// eslint-disable-next-line no-console
				console.info('[diag][titlebar] executeCommand returned:', promise);
				if (promise && typeof (promise as Promise<unknown>).then === 'function') {
					(promise as Promise<unknown>).then(
						() => { /* eslint-disable-next-line no-console */ console.info('[diag][titlebar] executeCommand resolved'); },
						(err: any) => { /* eslint-disable-next-line no-console */ console.error('[diag][titlebar] executeCommand rejected:', err); }
					);
				}
			} catch (err) {
				// eslint-disable-next-line no-console
				console.error('[diag][titlebar] executeCommand sync throw:', err);
			}
		}));

		const windowControls = this.rightWindowControlsContainer;
		if (windowControls) {
			this.rightContainer.insertBefore(btn, windowControls);
		} else {
			this.rightContainer.appendChild(btn);
		}

		// [diag] 插入 DOM 之后再打印：确认 CSS 的 -webkit-app-region:no-drag 是否真的
		// 命中。用 getPropertyValue 直接读（.webkitAppRegion 读法可能拿到默认 'none'）。
		// eslint-disable-next-line no-console
		const csBtn = getComputedStyle(btn);
		const csWco = windowControls ? getComputedStyle(windowControls) : null;
		// 完整祖先链（一直往上到 html），确认 aux 窗口 DOM 里是否有 .monaco-workbench
		const chain: string[] = [];
		let cur: HTMLElement | null = btn.parentElement;
		while (cur && chain.length < 10) {
			chain.push(`${cur.tagName}.${cur.className}`);
			cur = cur.parentElement;
		}
		console.info('[diag][titlebar] newChatGroup button mounted', {
			chain,
			bodyClass: document.body?.className,
			htmlClass: document.documentElement?.className,
			// matches() 直接判断 CSS 选择器是否命中当前 DOM（决定性验证）
			matchesWorkbench: btn.matches('.monaco-workbench .part.titlebar .titlebar-new-chat-group'),
			matchesWco: windowControls ? windowControls.matches('.monaco-workbench .part.titlebar .window-controls-container') : null,
			btnInlineStyle: btn.getAttribute('style'),
			btnRegion_prop: csBtn.getPropertyValue('-webkit-app-region'),
			btnRegion_camel: (csBtn as any).webkitAppRegion,
			btnDisplay: csBtn.display,
			btnW: btn.offsetWidth, btnH: btn.offsetHeight,
			wcoRegion_prop: csWco ? csWco.getPropertyValue('-webkit-app-region') : null,
			wcoRegion_camel: csWco ? (csWco as any).webkitAppRegion : null,
			wcoClass: windowControls?.className,
		});

		return el;
	}
}

export class NativeTitleService extends TitleService {

	protected override createMainTitlebarPart(): MainNativeTitlebarPart {
		return this.instantiationService.createInstance(MainNativeTitlebarPart);
	}

	protected override doCreateAuxiliaryTitlebarPart(container: HTMLElement, _editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): AuxiliaryNativeTitlebarPart {
		return instantiationService.createInstance(AuxiliaryNativeTitlebarPart, container, this.mainPart);
	}
}
