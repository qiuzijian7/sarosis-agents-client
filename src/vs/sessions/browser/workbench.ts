/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../workbench/browser/style.js';
import './media/style.css';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { Emitter, Event, setGlobalLeakWarningThreshold } from '../../base/common/event.js';
import { getActiveDocument, getActiveElement, getClientArea, getWindowId, getWindows, IDimension, isAncestorUsingFlowTo, isHTMLElement, size, Dimension, runWhenWindowIdle } from '../../base/browser/dom.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { isFullscreen, onDidChangeFullscreen, isChrome, isFirefox, isSafari } from '../../base/browser/browser.js';
import { mark } from '../../base/common/performance.js';
import { onUnexpectedError, setUnexpectedErrorHandler } from '../../base/common/errors.js';
import { isWindows, isLinux, isWeb, isNative, isMacintosh } from '../../base/common/platform.js';
import { Parts, Position, PanelAlignment, IWorkbenchLayoutService, SINGLE_WINDOW_PARTS, MULTI_WINDOW_PARTS, IPartVisibilityChangeEvent } from '../../workbench/services/layout/browser/layoutService.js';
import { ILayoutOffsetInfo } from '../../platform/layout/browser/layoutService.js';
import { Part } from '../../workbench/browser/part.js';
import { Direction, ISerializableView, ISerializedGrid, ISerializedLeafNode, ISerializedNode, IViewSize, Orientation, SerializableGrid } from '../../base/browser/ui/grid/grid.js';
import { DEFAULT_CUSTOM_TITLEBAR_HEIGHT } from '../../platform/window/common/window.js';
import { IEditorGroupsService, IEditorGroup } from '../../workbench/services/editor/common/editorGroupsService.js';
import { MainEditorPart as SessionsMainEditorPart } from './parts/editorPart.js';
import { EditorParts as SessionsEditorParts } from './parts/editorParts.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../workbench/common/views.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IInstantiationService, refineServiceDecorator, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ITitleService } from '../../workbench/services/title/browser/titleService.js';
import { mainWindow, CodeWindow } from '../../base/browser/window.js';
import { coalesce } from '../../base/common/arrays.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { ILifecycleService, LifecyclePhase, WillShutdownEvent } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { IStorageService, WillSaveStateReason, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { IDialogService, IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../platform/files/common/files.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { NotificationService } from '../../workbench/services/notification/common/notificationService.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../platform/hover/browser/hover.js';
import { setHoverDelegateFactory } from '../../base/browser/ui/hover/hoverDelegateFactory.js';
import { setBaseLayerHoverDelegate } from '../../base/browser/ui/hover/hoverDelegate2.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../workbench/common/contributions.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../workbench/common/editor.js';
import { setARIAContainer } from '../../base/browser/ui/aria/aria.js';
import { FontMeasurements } from '../../editor/browser/config/fontMeasurements.js';
import { createBareFontInfoFromRawSettings } from '../../editor/common/config/fontInfoFromSettings.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { WorkbenchContextKeysHandler } from '../../workbench/browser/contextkeys.js';
import { PixelRatio } from '../../base/browser/pixelRatio.js';
import { AccessibilityProgressSignalScheduler } from '../../platform/accessibilitySignal/browser/progressAccessibilitySignalScheduler.js';
import { setProgressAccessibilitySignalScheduler } from '../../base/browser/ui/progressbar/progressAccessibilitySignal.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import { NotificationAccessibleView } from '../../workbench/browser/parts/notifications/notificationAccessibleView.js';
import { NotificationsCenter } from '../../workbench/browser/parts/notifications/notificationsCenter.js';
import { NotificationsAlerts } from '../../workbench/browser/parts/notifications/notificationsAlerts.js';
import { NotificationsStatus } from '../../workbench/browser/parts/notifications/notificationsStatus.js';
import { registerNotificationCommands } from '../../workbench/browser/parts/notifications/notificationsCommands.js';
import { CommandsRegistry } from '../../platform/commands/common/commands.js';
import { NotificationsToasts } from '../../workbench/browser/parts/notifications/notificationsToasts.js';
import { IMarkdownRendererService } from '../../platform/markdown/browser/markdownRenderer.js';
import { EditorMarkdownCodeBlockRenderer } from '../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { TitleService } from './parts/titlebarPart.js';
import { SidebarPart } from './parts/sidebarPart.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { EditorMaximizedContext, IsPhoneLayoutContext, KeyboardVisibleContext } from '../common/contextkeys.js';
import {
	NotificationsPosition,
	NotificationsSettings,
	getNotificationsPosition
} from '../../workbench/common/notifications.js';
import { SessionsLayoutPolicy } from './layoutPolicy.js';
import { MobileNavigationStack } from './mobileNavigationStack.js';
import { MobileTitlebarPart } from './parts/mobile/mobileTitlebarPart.js';
import { autorun } from '../../base/common/observable.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { AgentStudioEditorInput } from '../contrib/agentStudio/browser/agentStudioEditorInput.js';
import { AgentStudioWorkspaceToolbar } from '../contrib/agentStudio/browser/agentStudioWorkspaceToolbar.js';
import { IAgentStudioService } from '../contrib/agentStudio/common/agentStudio.js';
import '../contrib/agentStudio/browser/media/workspaceToolbar.css';

//#region Workbench Options

export interface IWorkbenchOptions {
	/**
	 * Extra classes to be added to the workbench container.
	 */
	extraClasses?: string[];
}

//#endregion

//#region Layout Classes

enum LayoutClasses {
	SIDEBAR_HIDDEN = 'nosidebar',
	MAIN_EDITOR_AREA_HIDDEN = 'nomaineditorarea',
	PANEL_HIDDEN = 'nopanel',
	AUXILIARYBAR_HIDDEN = 'noauxiliarybar',
	CHATBAR_HIDDEN = 'nochatbar',
	STATUSBAR_HIDDEN = 'nostatusbar',
	SHELL_GRADIENT_BACKGROUND = 'shell-gradient-background',
	FULLSCREEN = 'fullscreen',
	MAXIMIZED = 'maximized',
	PHONE_LAYOUT = 'phone-layout'
}

//#endregion

//#region Part Visibility State

interface IPartVisibilityState {
	sidebar: boolean;
	auxiliaryBar: boolean;
	editor: boolean;
	panel: boolean;
	chatBar: boolean;
}

//#endregion

export interface IAgentWorkbenchLayoutService extends IWorkbenchLayoutService {
	isEditorMaximized(): boolean;
	setEditorMaximized(maximized: boolean): void;

	readonly onDidChangeEditorMaximized: Event<void>;
}

export const IAgentWorkbenchLayoutService = refineServiceDecorator<IWorkbenchLayoutService, IAgentWorkbenchLayoutService>(IWorkbenchLayoutService);

export const CLOSE_MOBILE_SIDEBAR_DRAWER_COMMAND_ID = 'sessions.closeMobileSidebarDrawer';

export class Workbench extends Disposable implements IAgentWorkbenchLayoutService {

	declare readonly _serviceBrand: undefined;

	//#region Lifecycle Events

	private readonly _onWillShutdown = this._register(new Emitter<WillShutdownEvent>());
	readonly onWillShutdown = this._onWillShutdown.event;

	private readonly _onDidShutdown = this._register(new Emitter<void>());
	readonly onDidShutdown = this._onDidShutdown.event;

	//#endregion

	//#region Events

	private readonly _onDidChangeZenMode = this._register(new Emitter<boolean>());
	readonly onDidChangeZenMode = this._onDidChangeZenMode.event;

	private readonly _onDidChangeMainEditorCenteredLayout = this._register(new Emitter<boolean>());
	readonly onDidChangeMainEditorCenteredLayout = this._onDidChangeMainEditorCenteredLayout.event;

	private readonly _onDidChangePanelAlignment = this._register(new Emitter<PanelAlignment>());
	readonly onDidChangePanelAlignment = this._onDidChangePanelAlignment.event;

	private readonly _onDidChangeWindowMaximized = this._register(new Emitter<{ windowId: number; maximized: boolean }>());
	readonly onDidChangeWindowMaximized = this._onDidChangeWindowMaximized.event;

	private readonly _onDidChangePanelPosition = this._register(new Emitter<string>());
	readonly onDidChangePanelPosition = this._onDidChangePanelPosition.event;

	private readonly _onDidChangePartVisibility = this._register(new Emitter<IPartVisibilityChangeEvent>());
	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;

	private readonly _onDidChangeNotificationsVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeNotificationsVisibility = this._onDidChangeNotificationsVisibility.event;

	private readonly _onDidChangeAuxiliaryBarMaximized = this._register(new Emitter<void>());
	readonly onDidChangeAuxiliaryBarMaximized = this._onDidChangeAuxiliaryBarMaximized.event;

	private readonly _onDidChangeEditorMaximized = this._register(new Emitter<void>());
	readonly onDidChangeEditorMaximized = this._onDidChangeEditorMaximized.event;

	private readonly _onDidLayoutMainContainer = this._register(new Emitter<IDimension>());
	readonly onDidLayoutMainContainer = this._onDidLayoutMainContainer.event;

	private readonly _onDidLayoutActiveContainer = this._register(new Emitter<IDimension>());
	readonly onDidLayoutActiveContainer = this._onDidLayoutActiveContainer.event;

	private readonly _onDidLayoutContainer = this._register(new Emitter<{ container: HTMLElement; dimension: IDimension }>());
	readonly onDidLayoutContainer = this._onDidLayoutContainer.event;

	private readonly _onDidAddContainer = this._register(new Emitter<{ container: HTMLElement; disposables: DisposableStore }>());
	readonly onDidAddContainer = this._onDidAddContainer.event;

	private readonly _onDidChangeActiveContainer = this._register(new Emitter<void>());
	readonly onDidChangeActiveContainer = this._onDidChangeActiveContainer.event;

	//#endregion

	//#region Properties

	readonly mainContainer = document.createElement('div');

	get activeContainer(): HTMLElement {
		return this.getContainerFromDocument(getActiveDocument());
	}

	get containers(): Iterable<HTMLElement> {
		const containers: HTMLElement[] = [];
		for (const { window } of getWindows()) {
			containers.push(this.getContainerFromDocument(window.document));
		}
		return containers;
	}

	private getContainerFromDocument(targetDocument: Document): HTMLElement {
		if (targetDocument === this.mainContainer.ownerDocument) {
			return this.mainContainer;
		} else {
			// eslint-disable-next-line no-restricted-syntax
			return targetDocument.body.getElementsByClassName('monaco-workbench')[0] as HTMLElement;
		}
	}

	private _mainContainerDimension!: IDimension;
	get mainContainerDimension(): IDimension { return this._mainContainerDimension; }

	get activeContainerDimension(): IDimension {
		return this.getContainerDimension(this.activeContainer);
	}

	private getContainerDimension(container: HTMLElement): IDimension {
		if (container === this.mainContainer) {
			return this.mainContainerDimension;
		} else {
			return getClientArea(container);
		}
	}

	get mainContainerOffset(): ILayoutOffsetInfo {
		return this.computeContainerOffset();
	}

	get activeContainerOffset(): ILayoutOffsetInfo {
		return this.computeContainerOffset();
	}

	private computeContainerOffset(): ILayoutOffsetInfo {
		let top = 0;
		let quickPickTop = 0;

		// [Sarosis] The titlebar is no longer a window-top full-width band —
		// it lives inside the left column (above the sidebar). The center
		// (File) and right (Agent) content areas therefore start at y=0, so
		// the global container offset is 0. (On phone the MobileTitlebarPart
		// still sits at the top and contributes its own offset.)
		if (this.mobileTopBarElement) {
			top = this.mobileTopBarElement.offsetHeight;
			quickPickTop = top;
		}

		return { top, quickPickTop };
	}

	//#endregion

	//#region State

	private readonly parts = new Map<string, Part>();
	private workbenchGrid!: SerializableGrid<ISerializableView>;

	private titleBarPartView!: ISerializableView;
	private sideBarPartView!: ISerializableView;
	private editorPartView!: ISerializableView;
	private agentEditorPartView!: ISerializableView;

	private readonly partVisibility: IPartVisibilityState = {
		sidebar: true,
		auxiliaryBar: false,
		editor: true,
		panel: false,
		chatBar: false
	};

	private mainWindowFullscreen = false;
	private readonly maximized = new Set<number>();
	private readonly layoutPolicy = this._register(new SessionsLayoutPolicy());
	private readonly mobileNavStack = this._register(new MobileNavigationStack());
	private mobileTopBarElement: HTMLElement | undefined;
	private readonly mobileTopBarDisposables = this._register(new DisposableStore());

	private _editorMaximized = false;
	private _editorLastNonMaximizedVisibility: IPartVisibilityState | undefined;

	/**
	 * Last user-resized width of the expanded sidebar content panel.
	 * Persisted across restarts via storageService — see
	 * `restoreLayoutPreferences()` / `storeLayoutPreferences()`.
	 * Default kept at 250 to match the original hard-coded value.
	 */
	// [Sarosis 2026-06-03] Initial sidebar expanded width — was 250px, trimmed
	// to 240px so the three-column boot layout (sidebar | file | agent-with-
	// internal-split) leaves more room for the file editor on small (~1080px)
	// screens. Users can still resize freely; persisted dragged width takes
	// precedence over this default once they touch the sash.
	private _sidebarExpandedWidth = 240;

	private readonly restoredPromise = new DeferredPromise<void>();
	readonly whenRestored = this.restoredPromise.p;
	private restored = false;

	readonly openedDefaultEditors = false;

	//#endregion

	//#region Services

	private editorGroupService!: IEditorGroupsService;
	private editorService!: IEditorService;
	private paneCompositeService!: IPaneCompositePartService;
	private viewDescriptorService!: IViewDescriptorService;
	private sessionsManagementService!: ISessionsManagementService;
	private instantiationService!: IInstantiationService;

	//#endregion

	constructor(
		protected readonly parent: HTMLElement,
		private readonly options: IWorkbenchOptions | undefined,
		private readonly serviceCollection: ServiceCollection,
		private readonly logService: ILogService
	) {
		super();

		// Sessions-scoped mobile viewport tweaks. These are applied here
		// (rather than in the shared workbench.html) so that the regular
		// code-web workbench — which does not handle safe-area insets — is
		// not affected on notched mobile devices.
		// The viewport `<meta>` tag is injected by the shared workbench.html,
		// so we cannot use dom.ts `h()` to create it. Look it up by tag name
		// and filter by the `name` attribute to avoid a selector query.
		// eslint-disable-next-line no-restricted-syntax
		const metaElements = mainWindow.document.head.getElementsByTagName('meta');
		let viewportMeta: HTMLMetaElement | undefined;
		for (let i = 0; i < metaElements.length; i++) {
			if (metaElements[i].name === 'viewport') {
				viewportMeta = metaElements[i];
				break;
			}
		}
		if (viewportMeta && !viewportMeta.content.includes('viewport-fit=')) {
			viewportMeta.content = `${viewportMeta.content}, viewport-fit=cover`;
		}

		// Perf: measure workbench startup time
		mark('code/willStartWorkbench');

		this.registerErrorHandler(logService);
	}

	//#region Error Handling

	private registerErrorHandler(logService: ILogService): void {
		// Increase stack trace limit for better errors stacks
		if (!isFirefox) {
			Error.stackTraceLimit = 100;
		}

		// Listen on unhandled rejection events
		// Note: intentionally not registered as disposable to handle
		//       errors that can occur during shutdown phase.
		mainWindow.addEventListener('unhandledrejection', (event) => {
			// See https://developer.mozilla.org/en-US/docs/Web/API/PromiseRejectionEvent
			onUnexpectedError(event.reason);

			// Prevent the printing of this event to the console
			event.preventDefault();
		});

		// Install handler for unexpected errors
		setUnexpectedErrorHandler(error => this.handleUnexpectedError(error, logService));
	}

	private previousUnexpectedError: { message: string | undefined; time: number } = { message: undefined, time: 0 };
	private handleUnexpectedError(error: unknown, logService: ILogService): void {
		const message = toErrorMessage(error, true);
		if (!message) {
			return;
		}

		const now = Date.now();
		if (message === this.previousUnexpectedError.message && now - this.previousUnexpectedError.time <= 1000) {
			return; // Return if error message identical to previous and shorter than 1 second
		}

		this.previousUnexpectedError.time = now;
		this.previousUnexpectedError.message = message;

		// Log it
		logService.error(message);
	}

	//#endregion

	//#region Startup

	startup(): IInstantiationService {
		try {
			// Configure emitter leak warning threshold
			this._register(setGlobalLeakWarningThreshold(175));

			// Services
			const instantiationService = this.initServices(this.serviceCollection);

			instantiationService.invokeFunction(accessor => {
				const lifecycleService = accessor.get(ILifecycleService);
				const storageService = accessor.get(IStorageService);
				const configurationService = accessor.get(IConfigurationService);
				const hostService = accessor.get(IHostService);
				const hoverService = accessor.get(IHoverService);
				const dialogService = accessor.get(IDialogService);
				const notificationService = accessor.get(INotificationService) as NotificationService;
				const markdownRendererService = accessor.get(IMarkdownRendererService);

				// On web, the configuration service needs access to the
				// instantiation service for dynamic configuration resolution.
				if (isWeb && typeof (configurationService as IConfigurationService & { acquireInstantiationService?(i: IInstantiationService): void }).acquireInstantiationService === 'function') {
					(configurationService as IConfigurationService & { acquireInstantiationService(i: IInstantiationService): void }).acquireInstantiationService(instantiationService);
				}

				// Set code block renderer for markdown rendering
				markdownRendererService.setDefaultCodeBlockRenderer(instantiationService.createInstance(EditorMarkdownCodeBlockRenderer));

				// Default Hover Delegate must be registered before creating any workbench/layout components
				setHoverDelegateFactory((placement, enableInstantHover) => instantiationService.createInstance(WorkbenchHoverDelegate, placement, { instantHover: enableInstantHover }, {}));
				setBaseLayerHoverDelegate(hoverService);

				// Layout
				this.initLayout(accessor);

				// Registries - this creates and registers all parts
				Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).start(accessor);
				Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor);

				// Context Keys
				this._register(instantiationService.createInstance(WorkbenchContextKeysHandler));

				// Editor Maximized Context Key
				const editorMaximizedContext = EditorMaximizedContext.bindTo(accessor.get(IContextKeyService));
				this._register(this.onDidChangeEditorMaximized(() => {
					editorMaximizedContext.set(this.isEditorMaximized());
				}));

				// Phone Layout Context Key
				const contextKeyService = accessor.get(IContextKeyService);
				const isPhoneLayoutCtx = IsPhoneLayoutContext.bindTo(contextKeyService);
				this._register(autorun(reader => {
					isPhoneLayoutCtx.set(this.layoutPolicy.viewportClass.read(reader) === 'phone');
				}));

				// Virtual keyboard detection via visualViewport API.
				// Use `window.innerHeight` (layout viewport) as the baseline
				// rather than a captured initial height. Layout viewport
				// updates on orientation change and split-screen resizes, so
				// comparing against it avoids stale baselines on landscape
				// launches, Android split-screen, and iOS URL-bar collapse.
				if (mainWindow.visualViewport) {
					const keyboardVisibleCtx = KeyboardVisibleContext.bindTo(contextKeyService);
					const KEYBOARD_HEIGHT_THRESHOLD_PX = 100;

					const onViewportResize = () => {
						const vp = mainWindow.visualViewport;
						if (!vp) {
							return;
						}
						const heightDiff = mainWindow.innerHeight - vp.height;
						keyboardVisibleCtx.set(heightDiff > KEYBOARD_HEIGHT_THRESHOLD_PX);
					};

					mainWindow.visualViewport.addEventListener('resize', onViewportResize);
					this._register({ dispose: () => mainWindow.visualViewport?.removeEventListener('resize', onViewportResize) });
				}

				// Orientation changes produce a window `resize` event which
				// is already handled by `registerLayoutListeners()`. No
				// separate matchMedia listener is needed — the previous
				// implementation caused a redundant second layout.

				// Register Listeners
				this.registerListeners(lifecycleService, storageService, configurationService, hostService, dialogService);

				// Render Workbench
				this.renderWorkbench(instantiationService, notificationService, storageService, configurationService);

				// Workbench Layout
				this.createWorkbenchLayout();

				// Create mobile navigation after grid exists (so DOM order is correct)
				if (this.layoutPolicy.viewportClass.get() === 'phone') {
					this.createMobileTitlebar();
				}

				// Workbench Management
				this.createWorkbenchManagement(instantiationService);

				// Layout
				this.layout();

				// Restore
				this.restore(lifecycleService);
			});

			return instantiationService;
		} catch (error) {
			onUnexpectedError(error);

			throw error; // rethrow because this is a critical issue we cannot handle properly here
		}
	}

	private initServices(serviceCollection: ServiceCollection): IInstantiationService {
		// Layout Service
		serviceCollection.set(IAgentWorkbenchLayoutService, this);

		// Title Service - agent sessions titlebar with dedicated part overrides
		serviceCollection.set(ITitleService, new SyncDescriptor(TitleService, []));

		// All Contributed Services
		const contributedServices = getSingletonServiceDescriptors();
		for (const [id, descriptor] of contributedServices) {
			serviceCollection.set(id, descriptor);
		}

		const instantiationService = new InstantiationService(serviceCollection, true);

		// Wrap up
		instantiationService.invokeFunction(accessor => {
			const lifecycleService = accessor.get(ILifecycleService);
			lifecycleService.phase = LifecyclePhase.Ready;
		});

		return instantiationService;
	}

	private registerListeners(lifecycleService: ILifecycleService, storageService: IStorageService, configurationService: IConfigurationService, hostService: IHostService, dialogService: IDialogService): void {
		// Command: close the mobile sidebar drawer (no-op outside phone layout).
		// Routes through the proper close path so the mobile nav/history stack
		// stays in sync (avoids extra Android back-button presses).
		this._register(CommandsRegistry.registerCommand(CLOSE_MOBILE_SIDEBAR_DRAWER_COMMAND_ID, () => {
			if (this.layoutPolicy.viewportClass.get() === 'phone') {
				this.closeMobileSidebarDrawer();
			}
		}));

		// Configuration changes
		this._register(configurationService.onDidChangeConfiguration(e => this.updateFontAliasing(e, configurationService)));

		// Font Info
		if (isNative) {
			this._register(storageService.onWillSaveState(e => {
				if (e.reason === WillSaveStateReason.SHUTDOWN) {
					this.storeFontInfo(storageService);
				}
			}));
		} else {
			this._register(lifecycleService.onWillShutdown(() => this.storeFontInfo(storageService)));
		}

		// [Sarosis] Layout preferences (sidebar expanded width, sidebar
		// visibility, editor-maximized state). Saved on every shutdown
		// AND on storage flush so values survive crashes too.
		this._register(storageService.onWillSaveState(e => {
			if (e.reason === WillSaveStateReason.SHUTDOWN) {
				this.storeLayoutPreferences(storageService);
			}
		}));
		this._register(lifecycleService.onWillShutdown(() => this.storeLayoutPreferences(storageService)));

		// Lifecycle
		this._register(lifecycleService.onWillShutdown(event => this._onWillShutdown.fire(event)));
		this._register(lifecycleService.onDidShutdown(() => {
			this._onDidShutdown.fire();
			this.dispose();
		}));

		// Flush storage on window focus loss
		this._register(hostService.onDidChangeFocus(focus => {
			if (!focus) {
				storageService.flush();
			}
		}));

		// Dialogs showing/hiding
		this._register(dialogService.onWillShowDialog(() => this.mainContainer.classList.add('modal-dialog-visible')));
		this._register(dialogService.onDidShowDialog(() => this.mainContainer.classList.remove('modal-dialog-visible')));
	}

	//#region Font Aliasing and Caching

	private fontAliasing: 'default' | 'antialiased' | 'none' | 'auto' | undefined;
	private updateFontAliasing(e: IConfigurationChangeEvent | undefined, configurationService: IConfigurationService) {
		if (!isMacintosh) {
			return; // macOS only
		}

		if (e && !e.affectsConfiguration('workbench.fontAliasing')) {
			return;
		}

		const aliasing = configurationService.getValue<'default' | 'antialiased' | 'none' | 'auto'>('workbench.fontAliasing');
		if (this.fontAliasing === aliasing) {
			return;
		}

		this.fontAliasing = aliasing;

		// Remove all
		const fontAliasingValues: (typeof aliasing)[] = ['antialiased', 'none', 'auto'];
		this.mainContainer.classList.remove(...fontAliasingValues.map(value => `monaco-font-aliasing-${value}`));

		// Add specific
		if (fontAliasingValues.some(option => option === aliasing)) {
			this.mainContainer.classList.add(`monaco-font-aliasing-${aliasing}`);
		}
	}

	private restoreFontInfo(storageService: IStorageService, configurationService: IConfigurationService): void {
		const storedFontInfoRaw = storageService.get('editorFontInfo', StorageScope.APPLICATION);
		if (storedFontInfoRaw) {
			try {
				const storedFontInfo = JSON.parse(storedFontInfoRaw);
				if (Array.isArray(storedFontInfo)) {
					FontMeasurements.restoreFontInfo(mainWindow, storedFontInfo);
				}
			} catch (err) {
				/* ignore */
			}
		}

		FontMeasurements.readFontInfo(mainWindow, createBareFontInfoFromRawSettings(configurationService.getValue('editor'), PixelRatio.getInstance(mainWindow).value));
	}

	private storeFontInfo(storageService: IStorageService): void {
		const serializedFontInfo = FontMeasurements.serializeFontInfo(mainWindow);
		if (serializedFontInfo) {
			storageService.store('editorFontInfo', JSON.stringify(serializedFontInfo), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	//#endregion

	//#region Layout Preferences Persistence

	// Storage keys for per-workspace layout preferences. Scope is
	// WORKSPACE (not PROFILE / APPLICATION) because the dual-zone
	// editor grid state — which these complement — is also
	// workspace-scoped (see editorPart.ts: SESSIONS_ZONE_STATE_STORAGE_KEY
	// and the upstream EDITOR_PART_UI_STATE_STORAGE_KEY).
	private static readonly LAYOUT_SIDEBAR_VISIBLE_KEY = 'sessions.layout.sidebarVisible';
	private static readonly LAYOUT_SIDEBAR_EXPANDED_WIDTH_KEY = 'sessions.layout.sidebarExpandedWidth';
	private static readonly LAYOUT_EDITOR_MAXIMIZED_KEY = 'sessions.layout.editorMaximized';

	/**
	 * Read persisted layout preferences into in-memory fields.
	 * Called early during startup so that `createDesktopGridDescriptor()`
	 * sees the restored values when building the initial grid.
	 *
	 * NOTE: We do NOT apply effects here (e.g. expand/collapse the
	 * sidebar) — the grid is not yet built. Effects are applied later
	 * in `applyRestoredLayoutPreferences()` once all parts and the grid
	 * are wired up.
	 */
	private restoreLayoutPreferences(storageService: IStorageService): void {
		// Sidebar expanded width — clamp to a sensible range so a
		// corrupted value cannot wedge the layout.
		const widthRaw = storageService.getNumber(Workbench.LAYOUT_SIDEBAR_EXPANDED_WIDTH_KEY, StorageScope.WORKSPACE);
		if (typeof widthRaw === 'number' && Number.isFinite(widthRaw)) {
			this._sidebarExpandedWidth = Math.max(120, Math.min(800, Math.round(widthRaw)));
		}

		// Sidebar visibility (only honoured on desktop layouts —
		// the layout policy still wins on phone).
		const sidebarVisibleRaw = storageService.getBoolean(Workbench.LAYOUT_SIDEBAR_VISIBLE_KEY, StorageScope.WORKSPACE);
		if (typeof sidebarVisibleRaw === 'boolean') {
			// Only override if the layout policy did not force a value
			// for the current viewport class. We check `isPhone`
			// indirectly via the previously-applied default.
			if (this.layoutPolicy.viewportClass.get() !== 'phone') {
				this.partVisibility.sidebar = sidebarVisibleRaw;
			}
		}

		// Editor maximized — applied in applyRestoredLayoutPreferences()
		// because setEditorMaximized(true) needs the sidebar part to
		// already be in the grid.
		const editorMax = storageService.getBoolean(Workbench.LAYOUT_EDITOR_MAXIMIZED_KEY, StorageScope.WORKSPACE);
		if (typeof editorMax === 'boolean') {
			this._pendingEditorMaximized = editorMax;
		}
	}

	private _pendingEditorMaximized: boolean | undefined;

	/**
	 * Apply restored preferences that need a fully-built layout — call
	 * once the grid has been created and the sidebar part is wired up.
	 */
	private applyRestoredLayoutPreferences(): void {
		const sideBarPart = this.parts.get(Parts.SIDEBAR_PART);

		// Synchronise the sidebar content panel with the persisted
		// expanded/collapsed flag. By default a fresh SidebarPart has
		// _contentCollapsed=true, so if the user previously had the
		// panel expanded we must explicitly expand it now.
		if (sideBarPart instanceof SidebarPart) {
			const wantExpanded = this.partVisibility.sidebar;
			if (sideBarPart.contentCollapsed === wantExpanded) {
				// state mismatch — flip
				sideBarPart.setContentCollapsed(!wantExpanded);
			}
		}

		// Resize the sidebar view to the persisted expanded width if
		// the content panel ended up expanded. If it's collapsed
		// the width takes effect the next time the user expands it
		// (handleSidebarContentCollapsed reads `_sidebarExpandedWidth`).
		if (sideBarPart instanceof SidebarPart && !sideBarPart.contentCollapsed) {
			try {
				this.workbenchGrid.resizeView(this.sideBarPartView, {
					width: this._sidebarExpandedWidth,
					height: 1000
				});
			} catch {
				// Grid not ready / view detached — silently ignore.
			}
		}

		if (this._pendingEditorMaximized) {
			// setEditorMaximized() is idempotent w.r.t. the current
			// state and emits onDidChangeEditorMaximized when it does
			// flip — we want that event so the toolbar/icons update.
			this.setEditorMaximized(true);
			this._pendingEditorMaximized = undefined;
		}
	}

	private storeLayoutPreferences(storageService: IStorageService): void {
		// Capture the latest expanded width from the grid before saving.
		// On desktop the user can drag the sash, which changes the view
		// size without going through setSize() — so we read the live
		// dimension here.
		const sideBarPart = this.parts.get(Parts.SIDEBAR_PART);
		if (sideBarPart instanceof SidebarPart && !sideBarPart.contentCollapsed) {
			try {
				const liveWidth = this.workbenchGrid.getViewSize(this.sideBarPartView).width;
				if (Number.isFinite(liveWidth) && liveWidth >= 120) {
					this._sidebarExpandedWidth = Math.round(liveWidth);
				}
			} catch {
				// Grid disposed — fall back to the in-memory value.
			}
		}

		storageService.store(
			Workbench.LAYOUT_SIDEBAR_EXPANDED_WIDTH_KEY,
			this._sidebarExpandedWidth,
			StorageScope.WORKSPACE,
			StorageTarget.USER
		);
		storageService.store(
			Workbench.LAYOUT_SIDEBAR_VISIBLE_KEY,
			this.partVisibility.sidebar,
			StorageScope.WORKSPACE,
			StorageTarget.USER
		);
		storageService.store(
			Workbench.LAYOUT_EDITOR_MAXIMIZED_KEY,
			this._editorMaximized,
			StorageScope.WORKSPACE,
			StorageTarget.USER
		);
	}

	//#endregion

	private renderWorkbench(instantiationService: IInstantiationService, notificationService: NotificationService, storageService: IStorageService, configurationService: IConfigurationService): void {
		// ARIA & Signals
		setARIAContainer(this.mainContainer);
		setProgressAccessibilitySignalScheduler((msDelayTime: number, msLoopTime?: number) => instantiationService.createInstance(AccessibilityProgressSignalScheduler, msDelayTime, msLoopTime));

		// Initialize viewport classification before building layout classes
		// Use a fallback dimension in case the parent has no size yet (e.g. window
		// created hidden for maximized/fullscreen mode where body clientWidth is 0).
		const initialDimension = getClientArea(this.parent, new Dimension(800, 600));
		this.layoutPolicy.update(initialDimension.width, initialDimension.height);

		// Apply initial part visibility from layout policy (phone hides sidebar, etc.)
		const visibilityDefaults = this.layoutPolicy.getPartVisibilityDefaults();
		this.partVisibility.sidebar = visibilityDefaults.sidebar;
		this.partVisibility.auxiliaryBar = visibilityDefaults.auxiliaryBar;
		this.partVisibility.panel = visibilityDefaults.panel;
		this.partVisibility.chatBar = visibilityDefaults.chatBar;
		this.partVisibility.editor = visibilityDefaults.editor;

		// State specific classes
		const platformClass = isWindows ? 'windows' : isLinux ? 'linux' : 'mac';
		const workbenchClasses = coalesce([
			'monaco-workbench',
			'agent-sessions-workbench',
			LayoutClasses.SHELL_GRADIENT_BACKGROUND,
			platformClass,
			isWeb ? 'web' : undefined,
			isChrome ? 'chromium' : isFirefox ? 'firefox' : isSafari ? 'safari' : undefined,
			...this.getLayoutClasses(),
			...(this.options?.extraClasses ? this.options.extraClasses : [])
		]);

		this.mainContainer.classList.add(...workbenchClasses);

		// Apply font aliasing
		this.updateFontAliasing(undefined, configurationService);

		// Warm up font cache information before building up too many dom elements
		this.restoreFontInfo(storageService, configurationService);

		// [Sarosis] Restore persisted layout preferences (sidebar width /
		// visibility / editor maximized) BEFORE the grid is built so the
		// initial grid dimensions reflect the previous session.
		this.restoreLayoutPreferences(storageService);

		// Create Parts (only Titlebar and Sidebar; Editor created separately below)
		for (const { id, role, classes } of [
			{ id: Parts.TITLEBAR_PART, role: 'none', classes: ['titlebar'] },
			{ id: Parts.SIDEBAR_PART, role: 'none', classes: ['sidebar', 'left'] },
		]) {
			const partContainer = this.createPartContainer(id, role, classes);

			mark(`code/willCreatePart/${id}`);
			this.getPart(id).create(partContainer);
			mark(`code/didCreatePart/${id}`);
		}

		// Create Editor Part (hidden by default)
		this.createEditorPart();

		// Notification Handlers
		this.createNotificationsHandlers(instantiationService, notificationService, configurationService);

		// Add Workbench to DOM
		this.parent.appendChild(this.mainContainer);
	}

	private createMobileTitlebar(): void {
		this.mobileTopBarDisposables.clear();
		const mobileTitlebar = this.mobileTopBarDisposables.add(this.instantiationService.createInstance(MobileTitlebarPart, this.mainContainer));
		this.mobileTopBarElement = mobileTitlebar.element;

		// Hamburger: toggle sidebar drawer overlay
		this.mobileTopBarDisposables.add(mobileTitlebar.onDidClickHamburger(() => {
			this.toggleMobileSidebarDrawer();
		}));

		// New session: open new chat view and dismiss the sidebar drawer
		// so the new session view becomes visible. createMobileTitlebar() is
		// only invoked in phone layout, so closing the drawer here is safe.
		this.mobileTopBarDisposables.add(mobileTitlebar.onDidClickNewSession(() => {
			this.sessionsManagementService.openNewSessionView();
			this.closeMobileSidebarDrawer();
		}));
	}

	private toggleMobileSidebarDrawer(): void {
		const isOpen = this.partVisibility.sidebar;
		if (isOpen) {
			this.closeMobileSidebarDrawer();
		} else {
			this.openMobileSidebarDrawer();
		}
	}

	private openMobileSidebarDrawer(): void {
		// Push a history entry so the Android back button dismisses the drawer.
		// Must come before setSideBarHidden(false) so layoutMobileSidebar() sees
		// the drawer state.
		if (!this.mobileNavStack.has('sidebar')) {
			this.mobileNavStack.push('sidebar');
		}

		// Show sidebar in grid — the actual drawer dimensions are applied by
		// layoutMobileSidebar() from within layout(), which uses the full
		// viewport width below the mobile top bar on phone. The toggle button
		// in the top bar remains visible and is used to close the drawer.
		this.setSideBarHidden(false);
	}

	private closeMobileSidebarDrawer(): void {
		// Hide sidebar in grid
		this.setSideBarHidden(true);

		// Sync the navigation stack with the browser history: if there is a
		// pending 'sidebar' entry (UI-initiated close), rewind history without
		// firing onDidPop. If we're being called from the back-button path
		// (onDidPop already fired), this is a no-op.
		if (this.mobileNavStack.has('sidebar')) {
			this.mobileNavStack.popSilently('sidebar');
		}
	}

	private createNotificationsHandlers(
		instantiationService: IInstantiationService,
		notificationService: NotificationService,
		configurationService: IConfigurationService
	): void {
		// Instantiate Notification components
		const notificationsCenter = this._register(instantiationService.createInstance(NotificationsCenter, this.mainContainer, notificationService.model));
		const notificationsToasts = this._register(instantiationService.createInstance(NotificationsToasts, this.mainContainer, notificationService.model));
		this._register(instantiationService.createInstance(NotificationsAlerts, notificationService.model));
		const notificationsStatus = this._register(instantiationService.createInstance(NotificationsStatus, notificationService.model));

		// Visibility
		this._register(notificationsCenter.onDidChangeVisibility(() => {
			notificationsStatus.update(notificationsCenter.isVisible, notificationsToasts.isVisible);
			notificationsToasts.update(notificationsCenter.isVisible);
		}));

		this._register(notificationsToasts.onDidChangeVisibility(() => {
			notificationsStatus.update(notificationsCenter.isVisible, notificationsToasts.isVisible);
		}));

		// Register Commands
		registerNotificationCommands(notificationsCenter, notificationsToasts, notificationService.model);

		// Register notification accessible view
		AccessibleViewRegistry.register(new NotificationAccessibleView());

		// The shared notification controllers apply a top-right inline offset based on the
		// default workbench custom titlebar height. The sessions workbench has its own
		// fixed chrome, so re-apply the sessions-specific top-right offset after they run.
		this.registerSessionsNotificationOffsets(configurationService, notificationsCenter, notificationsToasts);

		// Register with Layout
		this.registerNotifications({
			onDidChangeNotificationsVisibility: Event.map(
				Event.any(notificationsToasts.onDidChangeVisibility, notificationsCenter.onDidChangeVisibility),
				() => notificationsToasts.isVisible || notificationsCenter.isVisible
			)
		});
	}

	private registerSessionsNotificationOffsets(
		configurationService: IConfigurationService,
		notificationsCenter: NotificationsCenter,
		notificationsToasts: NotificationsToasts
	): void {
		const applySessionsNotificationOffsets = () => {
			const position = getNotificationsPosition(configurationService);
			const notificationsCenterContainer = this.getWorkbenchChildByClassName('notifications-center');
			const notificationsToastsContainer = this.getWorkbenchChildByClassName('notifications-toasts');

			if (position === NotificationsPosition.TOP_RIGHT) {
				notificationsCenterContainer?.style.setProperty('top', '40px');
				notificationsToastsContainer?.style.setProperty('top', '40px');
			}
		};

		this._register(this.onDidLayoutMainContainer(() => applySessionsNotificationOffsets()));
		this._register(notificationsCenter.onDidChangeVisibility(() => applySessionsNotificationOffsets()));
		this._register(notificationsToasts.onDidChangeVisibility(() => applySessionsNotificationOffsets()));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(NotificationsSettings.NOTIFICATIONS_POSITION)) {
				applySessionsNotificationOffsets();
			}
		}));
	}

	private getWorkbenchChildByClassName(className: string): HTMLElement | undefined {
		for (const child of this.mainContainer.children) {
			if (isHTMLElement(child) && child.classList.contains(className)) {
				return child;
			}
		}

		return undefined;
	}

	private createPartContainer(id: string, role: string, classes: string[]): HTMLElement {
		const part = document.createElement('div');
		part.classList.add('part', ...classes);
		part.id = id;
		part.setAttribute('role', role);
		return part;
	}

	private createEditorPart(): void {
		const editorPartContainer = document.createElement('div');
		editorPartContainer.classList.add('part', 'editor');
		editorPartContainer.id = Parts.EDITOR_PART;
		editorPartContainer.setAttribute('role', 'main');

		mark('code/willCreatePart/workbench.parts.editor');
		// [Sarosis] Enable upstream state restoration so that the File-zone
		// editor part recreates the previously persisted grid (groups, sash
		// positions, active group, MRU). After the path-A refactor this is a
		// plain single-grid part; the Agent zone is a separate part below.
		this.getPart(Parts.EDITOR_PART).create(editorPartContainer, { restorePreviousState: true });
		mark('code/didCreatePart/workbench.parts.editor');

		this.mainContainer.appendChild(editorPartContainer);

		// [Sarosis] Create the second main-window-level editor part that
		// hosts the Agent Studio zone (Canvas / Chat). Touching the
		// `agentPart` getter lazily instantiates it and `registerPart()`s it
		// into the EditorParts `_parts` set, enabling group→part routing.
		const agentPart = (this.editorGroupService as SessionsEditorParts).agentPart;

		const agentEditorPartContainer = document.createElement('div');
		agentEditorPartContainer.classList.add('part', 'editor', 'agent-editor');
		agentEditorPartContainer.id = Parts.AGENT_EDITOR_PART;
		agentEditorPartContainer.setAttribute('role', 'main');

		mark('code/willCreatePart/workbench.parts.agentEditor');
		// [Sarosis] The Agent zone is a *fixed* Canvas+Chat two-tab layout —
		// it must NOT restore a persisted grid. Older builds persisted the
		// pair as two separate locked groups (one editor each → no tab bar),
		// or even leaked Canvas into the File part. Restoring that broken
		// state is exactly what caused "only Chat shows / no tabs". We always
		// rebuild the layout deterministically in `_openAgentStudioEditors`,
		// so start the agent part from a clean single empty group.
		agentPart.create(agentEditorPartContainer, { restorePreviousState: false });
		mark('code/didCreatePart/workbench.parts.agentEditor');

		this.mainContainer.appendChild(agentEditorPartContainer);
	}

	private restore(lifecycleService: ILifecycleService): void {
		// Update perf marks
		mark('code/didStartWorkbench');
		performance.measure('perf: workbench create & restore', 'code/didLoadWorkbenchMain', 'code/didStartWorkbench');

		// Restore parts (open default view containers)
		this.restoreParts();

		// Set lifecycle phase to `Restored`
		lifecycleService.phase = LifecyclePhase.Restored;

		// Mark as restored
		this.setRestored();

		// Set lifecycle phase to `Eventually` after a short delay and when idle (min 2.5sec, max 5sec)
		const eventuallyPhaseScheduler = this._register(new RunOnceScheduler(() => {
			this._register(runWhenWindowIdle(mainWindow, () => lifecycleService.phase = LifecyclePhase.Eventually, 2500));
		}, 2500));
		eventuallyPhaseScheduler.schedule();
	}

	private restoreParts(): void {
		// Open default view containers for sidebar
		if (this.partVisibility.sidebar) {
			const defaultViewContainer = this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.Sidebar);
			if (defaultViewContainer) {
				this.paneCompositeService.openPaneComposite(defaultViewContainer.id, ViewContainerLocation.Sidebar);
			}
		}

		// [Sarosis] Open Agent Studio EditorPanes — two physically
		// independent EditorPart instances:
		//   - EDITOR_PART       → File zone (middle column)
		//   - AGENT_EDITOR_PART → Agent zone (right column: Canvas + Chat)
		// Physical isolation makes cross-zone drags impossible, so no
		// drag-gate / relocation guard is needed — only a close-guard.
		// Fire-and-forget: the method is async (it awaits stale-purge +
		// deterministic editor opens) but restoreParts itself is sync.
		this._openAgentStudioEditors().catch(err => console.error('[Sarosis] Failed to open Agent Studio editors', err));

		// [Sarosis] Now that every part is wired up and the editor grid
		// has been (re)built, apply persisted layout preferences that
		// require a fully-formed layout.
		this.applyRestoredLayoutPreferences();
	}

	private async _openAgentStudioEditors(): Promise<void> {
		// ── Physical two-part model ──────────────────────────────────────
		// After the path-A refactor the editor area is split into two
		// *physically independent* EditorPart instances that share the main
		// window id:
		//   - EDITOR_PART       → File zone (middle column). Regular file
		//                         editors open here through the default
		//                         group; we do not touch them.
		//   - AGENT_EDITOR_PART → Agent zone (right column). Canvas / Chat
		//                         live here.
		//
		// Because they are distinct Parts, each with its own grid and DOM
		// container, editors can NEVER be dragged across the boundary — the
		// old single-part dual-zone model required a globalThis drag-gate and
		// a cross-zone relocation guard, but with physical isolation those
		// are unnecessary. We only keep a lightweight close-guard so the last
		// Canvas / Chat tab cannot be accidentally closed.
		const editorParts = this.editorGroupService as SessionsEditorParts;
		const agentPart = editorParts.agentPart;

		// ── Purge stale Canvas/Chat from the File zone (middle column) ──
		// Before the path-A refactor, Canvas / Chat lived in the single
		// shared EditorPart and were persisted there. The middle File part
		// is created with `restorePreviousState: true`, so on the first
		// launch after the refactor it re-materialises those old
		// AgentStudioEditorInput tabs — producing a *duplicate* Canvas/Chat
		// in the middle column (and the Chat pane's "New Session" header
		// button). Canvas/Chat now belong exclusively to the Agent part, so
		// strip any AgentStudioEditorInput out of the File part and drop the
		// emptied non-root groups.
		const fileMainPart = editorParts.mainPart;
		// Only act when stale Canvas/Chat are actually present in the File
		// part — otherwise leave the user's legitimate file-editor splits
		// untouched. (After the first post-refactor launch the persisted
		// state no longer carries Canvas/Chat, so this becomes a no-op.)
		const fileHasStale = fileMainPart.groups.some(g =>
			g.editors.some(ed => ed instanceof AgentStudioEditorInput)
		);
		if (fileHasStale) {
			// Step 1 — collapse every File group into the active root group.
			// The old persisted grid (saved while Canvas/Chat still lived in
			// this shared part) carries several groups, including empty ones
			// and stale Canvas/Chat duplicates. `mergeAllGroups` is
			// synchronous and guarantees the middle column ends up with
			// exactly one editor area.
			if (fileMainPart.groups.length > 1) {
				fileMainPart.mergeAllGroups(fileMainPart.activeGroup);
			}
			// Step 2 — strip the stale AgentStudioEditorInput (old Canvas/Chat,
			// whose Chat tab also surfaces the "New Session" session title)
			// out of the single remaining File group. Canvas/Chat belong
			// exclusively to the Agent part now.
			//
			// IMPORTANT — must AWAIT the close. `AgentStudioEditorInput` is a
			// singleton (getOrCreate returns the same instance per panelType).
			// If we re-open Canvas/Chat in the Agent part while the File part
			// still holds a pending async close of the *same instance*, the
			// editor service races and the panel ends up only half-opened
			// (the "only Chat shows, no Canvas" symptom). Awaiting guarantees
			// the singleton is fully detached from the File part first.
			const fileRootGroup = fileMainPart.activeGroup;
			const staleEditors = fileRootGroup.editors.filter(ed => ed instanceof AgentStudioEditorInput);
			if (staleEditors.length > 0) {
				await fileRootGroup.closeEditors(staleEditors, { preserveFocus: true });
			}
		}

		// The Agent zone's root group (always present on a freshly-created
		// EditorPart). Lock it so file editors can never be implicitly
		// routed here via "open to side" and friends.
		const canvasGroup = agentPart.activeGroup;
		canvasGroup.lock(true);

		// ── Workspace Toolbar overlay (right column) ─────────────────────
		// Absolute overlay on mainContainer, positioned in the band above
		// the Agent editor part. Tracks the agent part's bounding rect so it
		// always spans the right column. (Stage 3 will fold this into the
		// right-column titlebar with the workspace dropdown + window
		// controls; for now it floats above the agent part.)
		const TOOLBAR_HEIGHT = SessionsMainEditorPart.TOOLBAR_HEIGHT;
		const agentPartContainer = this.getPart(Parts.AGENT_EDITOR_PART).getContainer();

		if (agentPartContainer) {
			const toolbar = new AgentStudioWorkspaceToolbar(this.mainContainer);
			this._register(toolbar);
			toolbar.element.style.position = 'absolute';
			toolbar.element.style.height = `${TOOLBAR_HEIGHT}px`;
			toolbar.element.style.zIndex = '15';

			const updateToolbarPosition = () => {
				const mainRect = this.mainContainer.getBoundingClientRect();
				const partRect = agentPartContainer.getBoundingClientRect();
				// AgentEditorPart reserves a TOOLBAR_HEIGHT band at the top
				// of its content (see agentEditorPart.ts: createContentArea
				// shifts `.content` down by `TOOLBAR_HEIGHT`, layout() trims
				// the grid by the same amount). The toolbar therefore
				// anchors at `partRect.top` (the freed band) — no clamping,
				// no negative offset needed.
				toolbar.element.style.left = `${partRect.left - mainRect.left}px`;
				toolbar.element.style.top = `${partRect.top - mainRect.top}px`;
				toolbar.element.style.width = `${partRect.width}px`;
			};
			updateToolbarPosition();

			const ro = new ResizeObserver(updateToolbarPosition);
			ro.observe(agentPartContainer);
			this._register({ dispose: () => ro.disconnect() });

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

		// ── Close-guard for Canvas / Chat ────────────────────────────────
		// Re-open the last instance of a panel type if it is closed inside
		// the agent part. Membership is trivial now: every group on
		// `agentPart` belongs to the agent zone.
		const reopenIfLast = (panelType: string) => {
			const stillExists = agentPart.groups.some(g =>
				g.editors.some(ed => ed instanceof AgentStudioEditorInput && ed.panelType === panelType)
			);
			console.warn(`[Sarosis][AgentEditor] reopenIfLast(${panelType}) stillExists=${stillExists}`);
			if (stillExists) {
				return;
			}
			const target = agentPart.activeGroup;
			const input = AgentStudioEditorInput.getOrCreate(panelType as any);
			console.warn(`[Sarosis][AgentEditor] reopenIfLast → re-opening '${panelType}' in group ${target.id}`);
			target.openEditor(input, { pinned: true, sticky: true });
		};
		const installCloseGuard = (group: IEditorGroup) => {
			this._register(group.onDidCloseEditor(e => {
				if (e.editor instanceof AgentStudioEditorInput) {
					const panelType = e.editor.panelType;
					console.warn(`[Sarosis][AgentEditor] onDidCloseEditor fired: panelType='${panelType}' group=${group.id} → scheduling reopenIfLast`);
					queueMicrotask(() => reopenIfLast(panelType));
				}
			}));
		};

		installCloseGuard(canvasGroup);

		// ── Single Chat layout (every launch) ────────────────────────────
		// The Agent part is created with `restorePreviousState: false`, so it
		// always boots as a single empty group. Chat occupies the full width.
		// Users can split the group manually via the editor UI.
		if (agentPart.groups.length > 1) {
			agentPart.mergeAllGroups(canvasGroup);
		}
		const leftGroup = agentPart.activeGroup;

		// ── Diagnostic logging helper ────────────────────────────────────
		const dumpAgent = (tag: string) => {
			const groupsInfo = agentPart.groups.map(g => {
				const eds = g.editors.map(ed => ed instanceof AgentStudioEditorInput ? `AS:${ed.panelType}` : ed.typeId).join(', ');
				return `  group#${g.id} (active=${g.id === agentPart.activeGroup.id}) [${g.editors.length}]: ${eds}`;
			}).join('\n');
			console.warn(`[Sarosis][AgentEditor] === ${tag} ===\n  agentPart.groups.length=${agentPart.groups.length}\n${groupsInfo}`);
		};

		// Surface the relevant editor-tab configuration values that decide
		// whether a tab bar shows and whether editors get auto-closed.
		try {
			const cfg = this.instantiationService.invokeFunction(accessor => accessor.get(IConfigurationService));
			console.warn(`[Sarosis][AgentEditor] config: showTabs=${JSON.stringify(cfg.getValue('workbench.editor.showTabs'))}, limit.enabled=${JSON.stringify(cfg.getValue('workbench.editor.limit.enabled'))}, limit.value=${JSON.stringify(cfg.getValue('workbench.editor.limit.value'))}, limit.perEditorGroup=${JSON.stringify(cfg.getValue('workbench.editor.limit.perEditorGroup'))}`);
		} catch (e) {
			console.warn('[Sarosis][AgentEditor] failed to read editor config', e);
		}

		dumpAgent('BEFORE rebuild');

		// Remove any stale AgentStudioEditorInput already sitting in the left
		// group (shouldn't happen with restore disabled, but keep it
		// deterministic).
		const existingAgentEditors = leftGroup.editors.filter(ed => ed instanceof AgentStudioEditorInput);
		if (existingAgentEditors.length > 0) {
			console.warn(`[Sarosis][AgentEditor] purging ${existingAgentEditors.length} pre-existing AS editor(s) from left group`);
			await leftGroup.closeEditors(existingAgentEditors, { preserveFocus: true });
		}

		const chatInput = AgentStudioEditorInput.getOrCreate('chat');

		// Open Chat in the single group (no Canvas side-by-side).
		try {
			await leftGroup.openEditor(chatInput, { pinned: true, sticky: true });
		} catch (e) {
			console.error('[Sarosis][AgentEditor] openEditor(chat) threw', e);
		}

		leftGroup.focus();

		// Guard groups added later within the agent part (user splits).
		this._register(agentPart.onDidAddGroup(newGroup => {
			installCloseGuard(newGroup);
		}));
	}

	//#endregion

	//#region Initialization

	initLayout(accessor: ServicesAccessor): void {
		// Services - accessing these triggers their instantiation
		// which creates and registers the parts
		this.editorGroupService = accessor.get(IEditorGroupsService);
		this.editorService = accessor.get(IEditorService);
		this.paneCompositeService = accessor.get(IPaneCompositePartService);
		this.viewDescriptorService = accessor.get(IViewDescriptorService);
		this.sessionsManagementService = accessor.get(ISessionsManagementService);
		this.instantiationService = accessor.get(IInstantiationService);
		accessor.get(ITitleService);

		// Register layout listeners
		this.registerLayoutListeners();

		// Editor opens should only affect the main editor part when
		// they actually target one of the main editor groups. Modal
		// opens stay neutral.
		this._register(this.editorService.onWillOpenEditor(e => {
			const targetsMainEditorPart = this.editorGroupService.mainPart.groups.some(group => group.id === e.groupId);
			if (!targetsMainEditorPart) {
				return;
			}

			if (!this.partVisibility.editor) {
				this.setPartHidden(false, Parts.EDITOR_PART);
			}
		}));

		// [Sarosis] Two-column layout: Sidebar | Editor (split into left files + right Agent Studio)
		// Editor is always visible; the two editor groups cannot be closed.

		// Initialize layout state (must be done before createWorkbenchLayout)
		this._mainContainerDimension = getClientArea(this.parent, new Dimension(800, 600));
		this.layoutPolicy.update(this._mainContainerDimension.width, this._mainContainerDimension.height);

		// Update part visibility based on final viewport classification
		const visDefaults = this.layoutPolicy.getPartVisibilityDefaults();
		this.partVisibility.sidebar = visDefaults.sidebar;
		this.partVisibility.editor = true; // Editor is always visible in this layout
	}

	private registerLayoutListeners(): void {
		// Fullscreen changes
		this._register(onDidChangeFullscreen(windowId => {
			if (windowId === getWindowId(mainWindow)) {
				this.mainWindowFullscreen = isFullscreen(mainWindow);
				this.updateFullscreenClass();
				this.layout();
			}
		}));

		// Window resize — needed for device emulation and mobile viewport changes
		const onWindowResize = () => this.layout();
		mainWindow.addEventListener('resize', onWindowResize);
		this._register({ dispose: () => mainWindow.removeEventListener('resize', onWindowResize) });
	}

	private updateFullscreenClass(): void {
		if (this.mainWindowFullscreen) {
			this.mainContainer.classList.add(LayoutClasses.FULLSCREEN);
		} else {
			this.mainContainer.classList.remove(LayoutClasses.FULLSCREEN);
		}
	}

	//#endregion

	//#region Workbench Layout Creation

	createWorkbenchLayout(): void {
		const titleBar = this.getPart(Parts.TITLEBAR_PART);
		const editorPart = this.getPart(Parts.EDITOR_PART);
		const agentEditorPart = this.getPart(Parts.AGENT_EDITOR_PART);
		const sideBar = this.getPart(Parts.SIDEBAR_PART);

		// View references for parts in the grid
		this.titleBarPartView = titleBar;
		this.sideBarPartView = sideBar;
		this.editorPartView = editorPart;
		this.agentEditorPartView = agentEditorPart;

		const viewMap: { [key: string]: ISerializableView } = {
			[Parts.TITLEBAR_PART]: this.titleBarPartView,
			[Parts.SIDEBAR_PART]: this.sideBarPartView,
			[Parts.EDITOR_PART]: this.editorPartView,
			[Parts.AGENT_EDITOR_PART]: this.agentEditorPartView
		};

		const fromJSON = ({ type }: { type: string }) => viewMap[type];
		const workbenchGrid = SerializableGrid.deserialize(
			this.createGridDescriptor(),
			{ fromJSON },
			{ proportionalLayout: false }
		);

		this.mainContainer.prepend(workbenchGrid.element);
		this.mainContainer.setAttribute('role', 'application');
		this.workbenchGrid = workbenchGrid;
		this.workbenchGrid.edgeSnapping = this.mainWindowFullscreen;

		// Listen for part visibility changes (for parts in grid)
		for (const part of [titleBar, sideBar, editorPart, agentEditorPart]) {
			this._register(part.onDidVisibilityChange(visible => {
				if (part === sideBar) {
					this.setSideBarHidden(!visible);
				} else if (part === editorPart) {
					this.setPartHidden(!visible, Parts.EDITOR_PART);
				} else if (part === agentEditorPart) {
					this.setPartHidden(!visible, Parts.AGENT_EDITOR_PART);
				}

				this._onDidChangePartVisibility.fire({ partId: part.getId(), visible });
				this.handleContainerDidLayout(this.mainContainer, this._mainContainerDimension);
			}));
		}

		// [Sarosis] Listen for sidebar content collapse/expand to resize the grid.
		// When the content panel toggles, the sidebar's width constraints change,
		// so we resize the grid view to match.
		if (sideBar instanceof SidebarPart) {
			this._register(sideBar.onDidChangeContentCollapsed(collapsed => {
				this.handleSidebarContentCollapsed(collapsed);
			}));
		}

		// Wire up mobile nav stack: back-button pops close the corresponding part
		this._register(this.mobileNavStack.onDidPop(layer => {
			switch (layer) {
				case 'sidebar':
					this.closeMobileSidebarDrawer();
					break;
				case 'editor':
					// Editor modal close is handled by the editor service
					break;
			}
		}));
	}

	createWorkbenchManagement(_instantiationService: IInstantiationService): void {
		// No floating toolbars in this layout
	}

	/**
	 * Creates the grid descriptor for the Agent Sessions layout.
	 *
	 * Structure (vertical root orientation):
	 * - Titlebar (top, full width)
	 * - Main row (horizontal):
	 *   - Sidebar (left, 250px, activity bar + content panel)
	 *   - Right column (vertical):
	 *     - Top row (horizontal): Chat Bar | Editor | Auxiliary Bar
	 *     - Panel (below editor and auxiliary bar)
	 */
	private createGridDescriptor(): ISerializedGrid {
		const { width, height } = this._mainContainerDimension;

		return this.createDesktopGridDescriptor(width, height);
	}

	/**
	 * Standard two-part layout for all viewport classes.
	 * On phone, the titlebar is hidden via CSS and a MobileTitlebarPart
	 * is prepended before the grid.
	 *
	 * [Sarosis] Two-column layout:
	 * - Sidebar (activity bar + content panel, 250px default) on the left
	 * - Editor (split into two groups: left=files, right=Agent Studio) on the right
	 * - No Panel, no AuxiliaryBar, no ChatBar
	 */
	private createDesktopGridDescriptor(width: number, height: number): ISerializedGrid {

		// [Sarosis] Sidebar width is dynamic:
		//   - When the persisted sidebar visibility says "expanded", build
		//     the grid with the previously-resized width (`_sidebarExpandedWidth`).
		//   - Otherwise start collapsed at the 48px icon strip and let
		//     `handleSidebarContentCollapsed()` resize when the user
		//     expands it (it reads the same `_sidebarExpandedWidth`).
		const sideBarSize = this.partVisibility.sidebar
			? this._sidebarExpandedWidth
			: 48;
		// [Sarosis] The titlebar hosts the left-column tools (the sidebar
		// expand/collapse toggle in `Menus.TitleBarLeftLayout`, plus the
		// center command center and right account menu). Previously we gave
		// it a zero-height hidden full-width slot so the three columns could
		// fill the window top-to-bottom — but that also removed the sidebar
		// toggle button. To keep the toggle button AND let the File/Agent
		// editor columns fill the full window height, the titlebar is moved
		// OUT of the window-top row and INTO the top of the left column.
		//
		// New grid shape (root = HORIZONTAL):
		//   Root (HORIZONTAL):
		//   ├─ leftColumn (branch, VERTICAL) [width=sideBarSize]:
		//   │     ├─ TitleBar [height=titleBarHeight]  ← toggle button lives here
		//   │     └─ Sidebar  [height=fill]
		//   ├─ File editor  [width=editorWidth]        (fills full window height)
		//   └─ Agent editor [width=agentEditorWidth]   (fills full window height)
		//
		// Because the editor columns are now direct children of the root
		// HORIZONTAL branch, they span the entire window height — the File
		// (middle) column is no longer pushed down by a top titlebar band.
		const titleBarHeight = DEFAULT_CUSTOM_TITLEBAR_HEIGHT;

		// [Sarosis] The editor row is split into two physically independent
		// EditorPart columns:
		//   - File zone (middle)  → workspace files
		//   - Agent zone (right)  → Canvas + Chat side-by-side split
		//
		// Per user requirement (2026-06-03): the agent zone takes **exactly
		// half of the entire window width** at boot. This is measured
		// against `width` (the whole window), NOT against the editor band,
		// because users frame the layout in terms of "screen halves" — the
		// sidebar is taken out of the file zone's budget, not split with
		// the agent zone.
		//
		// Sizing rules:
		//   - agent zone   = max(480, width / 2)
		//                    (480 floor keeps both inner panes ≥ 240px on
		//                     very narrow windows after the Canvas|Chat
		//                     internal split)
		//   - file editor  = remainder of the editor band, floor 320px
		//
		// Typical results:
		//   1080px window: sidebar=240, agent=540, file=300→320 (floor)
		//   1440px window: sidebar=240, agent=720, file=480
		//   1920px window: sidebar=240, agent=960, file=720
		const agentEditorWidth = Math.max(480, Math.round(width / 2));
		const editorWidth = Math.max(320, width - sideBarSize - agentEditorWidth);

		const titleBarNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.TITLEBAR_PART },
			size: titleBarHeight,
			visible: true
		};

		const sideBarNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.SIDEBAR_PART },
			size: Math.max(0, height - titleBarHeight),
			visible: this.partVisibility.sidebar
		};

		// Left column (VERTICAL): TitleBar (top) | Sidebar (fill). Its width
		// is the sidebar width; the titlebar shares that width and renders
		// only the left-column tools (toggle button) within it.
		const leftColumn: ISerializedNode = {
			type: 'branch',
			data: [titleBarNode, sideBarNode],
			size: sideBarSize
		};

		const editorNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.EDITOR_PART },
			size: editorWidth,
			visible: true
		};

		const agentEditorNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.AGENT_EDITOR_PART },
			size: agentEditorWidth,
			visible: true
		};

		// Root (HORIZONTAL): Left column | File editor | Agent editor.
		const result: ISerializedGrid = {
			root: {
				type: 'branch',
				size: height,
				data: [
					leftColumn,
					editorNode,
					agentEditorNode
				]
			},
			orientation: Orientation.HORIZONTAL,
			width,
			height
		};

		return result;
	}

	//#endregion

	//#region Layout Methods

	private _previousViewportClass: string | undefined;

	layout(): void {
		this._mainContainerDimension = getClientArea(
			this.mainWindowFullscreen ? mainWindow.document.body : this.parent
		);

		// Update viewport classification and toggle mobile CSS classes
		const previousClass = this._previousViewportClass;
		this.layoutPolicy.update(this._mainContainerDimension.width, this._mainContainerDimension.height);
		const currentClass = this.layoutPolicy.viewportClass.get();
		this.mainContainer.classList.toggle(LayoutClasses.PHONE_LAYOUT, currentClass === 'phone');

		// When viewport class changes at runtime (e.g., device emulation toggle),
		// update part visibility and create/destroy mobile components
		if (previousClass !== undefined && previousClass !== currentClass) {
			if (currentClass === 'phone' && !this.mobileTopBarElement) {
				this.createMobileTitlebar();
				// Hide titlebar in grid on phone (replaced by MobileTitlebarPart)
				this.workbenchGrid.setViewVisible(this.titleBarPartView, false);
				// On phone, only chat is visible — hide everything else first
				const defaults = this.layoutPolicy.getPartVisibilityDefaults();
				if (this.partVisibility.sidebar !== defaults.sidebar) {
					this.setSideBarHidden(!defaults.sidebar);
				}
				if (this.partVisibility.auxiliaryBar !== defaults.auxiliaryBar) {
					this.setPartHidden(!defaults.auxiliaryBar, Parts.AUXILIARYBAR_PART);
				}
				if (this.partVisibility.panel !== defaults.panel) {
					this.setPartHidden(!defaults.panel, Parts.PANEL_PART);
				}
			} else if (currentClass !== 'phone' && this.mobileTopBarElement) {
				// Remove mobile components when leaving phone layout
				this.mobileTopBarDisposables.clear();
				this.mobileTopBarElement = undefined;
				// Restore titlebar in grid
				this.workbenchGrid.setViewVisible(this.titleBarPartView, true);
				// Restore desktop part visibility
				const defaults = this.layoutPolicy.getPartVisibilityDefaults();
				if (this.partVisibility.sidebar !== defaults.sidebar) {
					this.setSideBarHidden(!defaults.sidebar);
				}
				if (this.partVisibility.chatBar !== defaults.chatBar) {
					this.setPartHidden(!defaults.chatBar, Parts.CHATBAR_PART);
				}
				if (this.partVisibility.auxiliaryBar !== defaults.auxiliaryBar) {
					this.setPartHidden(!defaults.auxiliaryBar, Parts.AUXILIARYBAR_PART);
				}
				if (this.partVisibility.panel !== defaults.panel) {
					this.setPartHidden(!defaults.panel, Parts.PANEL_PART);
				}
			}

			// Re-run updateStyles() on pane composite parts so that
			// mobile Part subclasses can re-apply or clear card-chrome
			// inline styles based on the new `.phone-layout` class.
			for (const partId of [Parts.CHATBAR_PART, Parts.SIDEBAR_PART, Parts.AUXILIARYBAR_PART, Parts.PANEL_PART]) {
				this.parts.get(partId)?.updateStyles();
			}
		}
		this._previousViewportClass = currentClass;

		this.logService.trace(`Workbench#layout, height: ${this._mainContainerDimension.height}, width: ${this._mainContainerDimension.width}`);

		size(this.mainContainer, this._mainContainerDimension.width, this._mainContainerDimension.height);

		// On phone, subtract the mobile top bar height from the grid
		const mobileTopBarHeight = this.mobileTopBarElement?.offsetHeight ?? 0;
		const gridHeight = this._mainContainerDimension.height - mobileTopBarHeight;

		// Layout the grid widget
		this.workbenchGrid.layout(this._mainContainerDimension.width, gridHeight);
		this.layoutMobileSidebar();

		// Emit as event
		this.handleContainerDidLayout(this.mainContainer, this._mainContainerDimension);
	}

	private layoutMobileSidebar(): void {
		const sidebarContainer = this.getContainer(mainWindow, Parts.SIDEBAR_PART);
		const sidebarPart = this.getPart(Parts.SIDEBAR_PART);
		if (!sidebarContainer) {
			return;
		}

		// On phone the sidebar renders as a full-viewport overlay drawer.
		// Geometry is fully expressed in CSS — see
		// `mobileChatShell.css` (split-view-view fills the grid) and
		// `sidebarPart.css` (drawer animation, z-index). We avoid setting
		// inline position/size styles here because writing them after the
		// grid has already laid out and painted the sidebar causes a
		// visible one-frame snap on toggle.
		const isPhone = this.layoutPolicy.viewportClass.get() === 'phone';
		if (!isPhone || !this.partVisibility.sidebar) {
			sidebarContainer.classList.remove('mobile-overlay-sidebar');
			return;
		}

		sidebarContainer.classList.add('mobile-overlay-sidebar');

		// Re-layout the sidebar Part with the drawer's content dimensions
		// so its internal composite/list sizing matches the CSS-positioned
		// drawer (grid area minus the mobile top bar).
		const topBarHeight = this.mobileTopBarElement?.offsetHeight ?? 48;
		const drawerWidth = this._mainContainerDimension.width;
		const drawerHeight = Math.max(0, this._mainContainerDimension.height - topBarHeight);
		sidebarPart.layout(drawerWidth, drawerHeight, topBarHeight, 0);
	}

	private handleContainerDidLayout(container: HTMLElement, dimension: IDimension): void {
		this._onDidLayoutContainer.fire({ container, dimension });
		if (container === this.mainContainer) {
			this._onDidLayoutMainContainer.fire(dimension);
		}
		if (container === this.activeContainer) {
			this._onDidLayoutActiveContainer.fire(dimension);
		}
	}

	getLayoutClasses(): string[] {
		// [Sarosis] The sidebar (activity bar strip) is always visible,
		// so we never add the SIDEBAR_HIDDEN class. The content panel
		// collapses/expands instead of the entire sidebar disappearing.
		return coalesce([
			LayoutClasses.PANEL_HIDDEN, // No panel in this layout
			LayoutClasses.AUXILIARYBAR_HIDDEN, // No auxiliary bar in this layout
			LayoutClasses.CHATBAR_HIDDEN, // No chat bar in this layout
			LayoutClasses.STATUSBAR_HIDDEN, // agents window never has a status bar
			this.mainWindowFullscreen ? LayoutClasses.FULLSCREEN : undefined,
			this.layoutPolicy.viewportClass.get() === 'phone' ? LayoutClasses.PHONE_LAYOUT : undefined,
		]);
	}

	//#endregion

	//#region Part Management

	registerPart(part: Part): IDisposable {
		const id = part.getId();
		this.parts.set(id, part);
		return toDisposable(() => this.parts.delete(id));
	}

	getPart(key: Parts): Part {
		const part = this.parts.get(key);
		if (!part) {
			throw new Error(`Unknown part ${key}`);
		}
		return part;
	}

	hasFocus(part: Parts): boolean {
		const container = this.getContainer(mainWindow, part);
		if (!container) {
			return false;
		}

		const activeElement = getActiveElement();
		if (!activeElement) {
			return false;
		}

		return isAncestorUsingFlowTo(activeElement, container);
	}

	focusPart(part: MULTI_WINDOW_PARTS, targetWindow: Window): void;
	focusPart(part: SINGLE_WINDOW_PARTS): void;
	focusPart(part: Parts, targetWindow: Window = mainWindow): void {
		switch (part) {
			case Parts.EDITOR_PART:
				this.editorGroupService.activeGroup.focus();
				break;
			case Parts.AGENT_EDITOR_PART:
				(this.editorGroupService as SessionsEditorParts).agentPart.activeGroup.focus();
				break;
			case Parts.SIDEBAR_PART:
				this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.focus();
				break;
			default: {
				const container = this.getContainer(targetWindow, part);
				container?.focus();
			}
		}
	}

	focus(): void {
		this.focusPart(Parts.EDITOR_PART, mainWindow);
	}

	//#endregion

	//#region Container Methods

	getContainer(targetWindow: Window): HTMLElement;
	getContainer(targetWindow: Window, part: Parts): HTMLElement | undefined;
	getContainer(targetWindow: Window, part?: Parts): HTMLElement | undefined {
		if (typeof part === 'undefined') {
			return this.getContainerFromDocument(targetWindow.document);
		}

		if (targetWindow === mainWindow) {
			return this.parts.get(part)?.getContainer();
		}

		// For auxiliary windows, only editor part is supported
		if (part === Parts.EDITOR_PART) {
			const container = this.getContainerFromDocument(targetWindow.document);
			const partCandidate = this.editorGroupService.getPart(container);
			if (partCandidate instanceof Part) {
				return partCandidate.getContainer();
			}
		}

		return undefined;
	}

	whenContainerStylesLoaded(_window: CodeWindow): Promise<void> | undefined {
		return undefined;
	}

	//#endregion

	//#region Part Visibility

	isActivityBarHidden(): boolean {
		return true; // No activity bar in this layout
	}

	isVisible(part: SINGLE_WINDOW_PARTS): boolean;
	isVisible(part: MULTI_WINDOW_PARTS, targetWindow: Window): boolean;
	isVisible(part: Parts, targetWindow?: Window): boolean {
		switch (part) {
			case Parts.TITLEBAR_PART:
				// On phone layout the grid titlebar is hidden (replaced by MobileTitlebarPart)
				return this.layoutPolicy.viewportClass.get() !== 'phone';
			case Parts.SIDEBAR_PART:
				// [Sarosis] The sidebar (activity bar) is always visible in the grid.
				// The content panel may be collapsed, but the icon strip is always shown.
				return true;
			case Parts.EDITOR_PART:
				return true; // Editor is always visible in this layout
			case Parts.AGENT_EDITOR_PART:
				return true; // Agent editor (right column) is always visible
			case Parts.AUXILIARYBAR_PART:
			case Parts.PANEL_PART:
			case Parts.CHATBAR_PART:
			case Parts.ACTIVITYBAR_PART:
			case Parts.STATUSBAR_PART:
			case Parts.BANNER_PART:
			default:
				return false;
		}
	}

	setPartHidden(hidden: boolean, part: Parts): void {
		switch (part) {
			case Parts.SIDEBAR_PART:
				this.setSideBarHidden(hidden);
				break;
			case Parts.EDITOR_PART:
				// Editor cannot be hidden in this layout
				break;
			case Parts.AGENT_EDITOR_PART:
				// Agent editor (right column) cannot be hidden in this layout
				break;
			// Panel, AuxiliaryBar, ChatBar are not in this layout - no-op
		}
	}

	private setSideBarHidden(hidden: boolean): void {
		if (this.partVisibility.sidebar === !hidden) {
			return;
		}

		this.partVisibility.sidebar = !hidden;

		// [Sarosis] The sidebar (activity bar) is always visible in the grid.
		// "Hidden" now means the content panel is collapsed, not the entire sidebar.
		// We toggle the content panel via SidebarPart.setContentCollapsed()
		// instead of removing the sidebar from the grid.
		const sidebarPart = this.getPart(Parts.SIDEBAR_PART);
		if (sidebarPart instanceof SidebarPart) {
			sidebarPart.setContentCollapsed(hidden);
		}

		// If sidebar becomes hidden/collapsed, also hide the current active pane composite
		if (hidden && this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)) {
			this.paneCompositeService.hideActivePaneComposite(ViewContainerLocation.Sidebar);
		}

		// If sidebar becomes visible/expanded, show last active Viewlet or default viewlet
		if (!hidden && !this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)) {
			const viewletToOpen = this.paneCompositeService.getLastActivePaneCompositeId(ViewContainerLocation.Sidebar) ??
				this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.Sidebar)?.id;
			if (viewletToOpen) {
				this.paneCompositeService.openPaneComposite(viewletToOpen, ViewContainerLocation.Sidebar);
			}
		}

		this.layoutMobileSidebar();
	}

	/**
	 * Handle sidebar content collapse/expand by resizing the grid view.
	 * The activity bar icon strip always stays at 48px; only the content panel changes.
	 *
	 * The expanded width is the persisted, user-resized value (see
	 * `_sidebarExpandedWidth`). This means a previously-dragged width
	 * is honoured both when the user toggles the panel back open and
	 * across full restarts (via `restoreLayoutPreferences()`).
	 */
	private handleSidebarContentCollapsed(collapsed: boolean): void {
		const targetWidth = collapsed ? 48 : this._sidebarExpandedWidth;
		try {
			// IViewSize requires both width and height; use a large default for height
			this.workbenchGrid.resizeView(this.sideBarPartView, { width: targetWidth, height: 1000 });
		} catch {
			// resizeView can throw if the grid is not yet fully initialized;
			// fall back to a full layout.
			this.layout();
		}
	}

	//#endregion

	//#region Position Methods (Fixed - Not Configurable)

	getSideBarPosition(): Position {
		return Position.LEFT; // Always left in this layout
	}

	getPanelPosition(): Position {
		return Position.BOTTOM; // Always bottom in this layout
	}

	setPanelPosition(_position: Position): void {
		// No-op: Panel position is fixed in this layout
	}

	getPanelAlignment(): PanelAlignment {
		return 'justify'; // Full width panel
	}

	setPanelAlignment(_alignment: PanelAlignment): void {
		// No-op: Panel alignment is fixed in this layout
	}

	//#endregion

	//#region Size Methods

	getSize(part: Parts): IViewSize {
		const view = this.getPartView(part);
		if (!view) {
			return { width: 0, height: 0 };
		}
		return this.workbenchGrid.getViewSize(view);
	}

	setSize(part: Parts, size: IViewSize): void {
		const view = this.getPartView(part);
		if (view) {
			this.workbenchGrid.resizeView(view, size);
		}
	}

	resizePart(part: Parts, sizeChangeWidth: number, sizeChangeHeight: number): void {
		const view = this.getPartView(part);
		if (!view) {
			return;
		}

		const currentSize = this.workbenchGrid.getViewSize(view);
		this.workbenchGrid.resizeView(view, {
			width: currentSize.width + sizeChangeWidth,
			height: currentSize.height + sizeChangeHeight
		});
	}

	private getPartView(part: Parts): ISerializableView | undefined {
		switch (part) {
			case Parts.TITLEBAR_PART:
				return this.titleBarPartView;
			case Parts.SIDEBAR_PART:
				return this.sideBarPartView;
			case Parts.EDITOR_PART:
				return this.editorPartView;
			case Parts.AGENT_EDITOR_PART:
				return this.agentEditorPartView;
			default:
				return undefined;
		}
	}

	getMaximumEditorDimensions(_container: HTMLElement): IDimension {
		// Return the available space for editor (excluding sidebar)
		// [Sarosis] The sidebar is always in the grid (at least 48px for the
		// icon strip). The titlebar now lives INSIDE the left column (above
		// the sidebar), not as a window-top band, so the editor columns span
		// the full window height — we must NOT subtract the titlebar height.
		const sidebarWidth = this.workbenchGrid.getViewSize(this.sideBarPartView).width;

		return new Dimension(
			this._mainContainerDimension.width - sidebarWidth,
			this._mainContainerDimension.height
		);
	}

	//#endregion

	//#region Unsupported Features (No-ops)

	toggleMaximizedPanel(): void {
		// No-op: No panel in this layout
	}

	isPanelMaximized(): boolean {
		return false; // No panel in this layout
	}

	toggleMaximizedAuxiliaryBar(): void {
		// No-op: No auxiliary bar in this layout
	}

	setAuxiliaryBarMaximized(_maximized: boolean): boolean {
		return false; // No auxiliary bar in this layout
	}

	isAuxiliaryBarMaximized(): boolean {
		return false; // No auxiliary bar in this layout
	}

	isEditorMaximized(): boolean {
		return this._editorMaximized;
	}

	setEditorMaximized(maximized: boolean): void {
		if (maximized === this._editorMaximized) {
			return;
		}

		if (maximized) {
			// Save current sidebar visibility
			this._editorLastNonMaximizedVisibility = {
				sidebar: this.partVisibility.sidebar,
				auxiliaryBar: false,
				editor: true,
				panel: false,
				chatBar: false,
			};

			// Hide sidebar to maximize editor
			if (this.partVisibility.sidebar) {
				this.setSideBarHidden(true);
			}

			this._editorMaximized = true;
		} else {
			const state = this._editorLastNonMaximizedVisibility;

			// Restore previous sidebar state
			if (state?.sidebar) {
				this.setSideBarHidden(false);
			}

			this._editorMaximized = false;
		}

		this._onDidChangeEditorMaximized.fire();
	}

	toggleZenMode(): void {
		// No-op: Zen mode not supported in this layout
	}

	toggleMenuBar(): void {
		// No-op: Menu bar toggle not supported in this layout
	}

	isMainEditorLayoutCentered(): boolean {
		return false; // Centered layout not supported
	}

	centerMainEditorLayout(_active: boolean): void {
		// No-op: Centered layout not supported in this layout
	}

	hasMainWindowBorder(): boolean {
		return false;
	}

	getMainWindowBorderRadius(): string | undefined {
		return undefined;
	}

	//#endregion

	//#region Window Maximized State

	isWindowMaximized(targetWindow: Window): boolean {
		return this.maximized.has(getWindowId(targetWindow));
	}

	updateWindowMaximizedState(targetWindow: Window, maximized: boolean): void {
		const windowId = getWindowId(targetWindow);
		if (maximized) {
			this.maximized.add(windowId);
			if (targetWindow === mainWindow) {
				this.mainContainer.classList.add(LayoutClasses.MAXIMIZED);
			}
		} else {
			this.maximized.delete(windowId);
			if (targetWindow === mainWindow) {
				this.mainContainer.classList.remove(LayoutClasses.MAXIMIZED);
			}
		}

		this._onDidChangeWindowMaximized.fire({ windowId, maximized });
	}

	//#endregion

	//#region Neighbor Parts

	getVisibleNeighborPart(part: Parts, direction: Direction): Parts | undefined {
		if (!this.workbenchGrid) {
			return undefined;
		}

		const view = this.getPartView(part);
		if (!view) {
			return undefined;
		}

		const neighbor = this.workbenchGrid.getNeighborViews(view, direction, false);
		if (neighbor.length === 0) {
			return undefined;
		}

		const neighborView = neighbor[0];

		if (neighborView === this.titleBarPartView) {
			return Parts.TITLEBAR_PART;
		}
		if (neighborView === this.sideBarPartView) {
			return Parts.SIDEBAR_PART;
		}
		if (neighborView === this.editorPartView) {
			return Parts.EDITOR_PART;
		}

		return undefined;
	}

	//#endregion

	//#region Restore

	isRestored(): boolean {
		return this.restored;
	}

	setRestored(): void {
		this.restored = true;
		this.restoredPromise.complete();
	}

	//#endregion

	//#region Notifications Registration

	registerNotifications(delegate: { onDidChangeNotificationsVisibility: Event<boolean> }): void {
		this._register(delegate.onDidChangeNotificationsVisibility(visible => this._onDidChangeNotificationsVisibility.fire(visible)));
	}

	//#endregion
}
