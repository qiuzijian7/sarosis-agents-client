/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../browser/media/sidebarActionButton.css';
import './media/accountWidget.css';
import './media/accountTitleBarWidget.css';
import '../../../../workbench/contrib/chat/browser/chatStatus/media/chatStatus.css';
import Severity from '../../../../base/common/severity.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2, IMenuService } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { appendUpdateMenuItems as registerUpdateMenuItems } from '../../../../workbench/contrib/update/browser/update.js';
import { Menus } from '../../../browser/menus.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { fillInActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { $, addDisposableListener, append, disposableWindowInterval, EventType, getDomNodePagePosition } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction, Separator } from '../../../../base/common/actions.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerUpdateTitleBarMenuPlacement } from '../../../../workbench/contrib/update/browser/updateTitleBarEntry.js';
import { IEditorService, SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { SettingsEditorInput } from '../../agentStudio/browser/settingsEditorInput.js';
import { ChatEntitlement, ChatEntitlementService, IChatEntitlementService } from '../../../../workbench/services/chat/common/chatEntitlementService.js';
import { ChatStatusDashboard, IChatStatusDashboardOptions } from '../../../../workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { getAccountProfileImageUrl, getAccountTitleBarBadgeKey, getAccountTitleBarState, resolveAccountInfo } from '../../../browser/accountTitleBarState.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { IChatDashboardService } from '../../../browser/chatDashboardService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ITofAuthService, ITofUser } from '../../agentStudio/common/tofAuth.js';


// --- Account Menu Items --- //
const AccountMenu = Menus.AccountMenu;
const SessionsTitleBarAccountWidgetAction = 'sessions.action.titleBarAccountWidget';
const SESSIONS_ACCOUNT_TITLEBAR_PANEL_WIDTH = 360;

const PERSONALIZE_ACTION_IDS: readonly string[] = [
	'workbench.action.openSettings',
	'workbench.action.openGlobalKeybindings',
	'workbench.action.selectTheme',
];
const SIGN_OUT_ACTION_ID = 'workbench.action.agenticSignOut';
const SIGN_IN_ACTION_ID = 'workbench.action.agenticSignIn';

// Register the shared VS Code update title bar entry into the Agents titlebar layout.
registerUpdateTitleBarMenuPlacement(Menus.TitleBarRightLayout, {
	when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated()),
	group: 'navigation',
	order: 99,
});

// Sign In (shown when signed out) — 走 TOF (太湖 OA) 浏览器登录流程
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agenticSignIn',
			title: localize2('signIn', 'Sign In'),
			menu: {
				id: AccountMenu,
				when: ContextKeyExpr.notEquals('defaultAccountStatus', 'available'),
				group: '1_account',
				order: 1,
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const tofAuthService = accessor.get(ITofAuthService);
		const notificationService = accessor.get(INotificationService);
		// 如果已登录，不重复登录
		if (tofAuthService.currentUser) {
			return;
		}
		// 显示进度提示
		const progress = notificationService.prompt(
			Severity.Info,
			localize('tofLoginInProgress', "正在打开浏览器进行 OA 登录…"),
			[],
			{ sticky: true }
		);
		try {
			const user = await tofAuthService.login();
			progress.close();
			notificationService.info(`登录成功：${user.login_name}（工号 ${user.staff_id}）`);
		} catch (e) {
			progress.close();
			notificationService.error(`登录失败：${(e as Error).message}`);
		}
	}
});

// Sign Out (shown when signed in) — 清除 TOF 本地票据
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agenticSignOut',
			title: localize2('signOut', 'Sign Out'),
			menu: {
				id: AccountMenu,
				when: ContextKeyExpr.equals('defaultAccountStatus', 'available'),
				group: '1_account',
				order: 1,
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const tofAuthService = accessor.get(ITofAuthService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);
		const user = tofAuthService.currentUser;
		const accountLabel = user ? user.login_name : '当前账号';
		const { confirmed } = await dialogService.confirm({
			type: Severity.Info,
			message: localize('agenticSignOutMessage', "Sign out of the Agents app?"),
			detail: localize('agenticSignOutDetail', "This will sign out '{0}' from the Agents app.", accountLabel),
			primaryButton: localize({ key: 'agenticSignOutButton', comment: ['&& denotes a mnemonic'] }, "&&Sign Out")
		});
		if (!confirmed) {
			return;
		}
		await tofAuthService.logout();
		notificationService.info('已登出');
	}
});

// Color Theme (hidden on phone — no theme picker UI on mobile)
MenuRegistry.appendMenuItem(AccountMenu, {
	command: {
		id: 'workbench.action.selectTheme',
		title: localize('selectColorTheme', "Color Theme"),
	},
	when: IsPhoneLayoutContext.negate(),
	group: '2_settings',
	order: 1,
});

// Settings (hidden on phone — no settings UI on mobile)
MenuRegistry.appendMenuItem(AccountMenu, {
	command: {
		id: 'workbench.action.openSettings',
		title: localize('settings', "Settings"),
	},
	when: IsPhoneLayoutContext.negate(),
	group: '2_settings',
	order: 2,
});

// Keyboard Shortcuts (hidden on phone — no keybindings UI on mobile)
MenuRegistry.appendMenuItem(AccountMenu, {
	command: {
		id: 'workbench.action.openGlobalKeybindings',
		title: localize('sessionsAccountMenu.keyboardShortcuts', "Keyboard Shortcuts"),
	},
	when: IsPhoneLayoutContext.negate(),
	group: '2_settings',
	order: 3,
});

// Update actions
registerUpdateMenuItems(AccountMenu, '3_updates');

class TitleBarAccountWidget extends BaseActionViewItem {

	private container: HTMLElement | undefined;
	private avatarElement: HTMLImageElement | undefined;
	private iconElement: HTMLElement | undefined;
	private labelElement: HTMLElement | undefined;
	private badgeElement: HTMLElement | undefined;
	private accountName: string | undefined;
	private accountProviderId: string | undefined;
	private accountProviderLabel: string | undefined;
	private isAccountLoading = true;
	private accountRequestCounter = 0;
	private avatarRequestCounter = 0;
	private currentAvatarUrl: string | undefined;
	private loadedAvatarUrl: string | undefined;
	private lastState: ReturnType<typeof getAccountTitleBarState>;
	private isMenuVisible = false;
	private lastBadgeKey: string | undefined;
	private dismissedBadgeKey: string | undefined;
	private readonly copilotDashboardStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly clickPanelDisposable = this._register(new MutableDisposable<DisposableStore>());
	private readonly avatarLoadDisposable = this._register(new MutableDisposable());

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService private readonly chatEntitlementService: ChatEntitlementService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
	) {
		super(undefined, action, options);
		this.lastState = getAccountTitleBarState({
			isAccountLoading: true,
			entitlement: this.chatEntitlementService.entitlement,
			sentiment: this.chatEntitlementService.sentiment,
			quotas: this.chatEntitlementService.quotas,
		});

		this._register(this.defaultAccountService.onDidChangeDefaultAccount(() => this.refreshAccount()));
		this._register(this.authenticationService.onDidChangeSessions(() => this.refreshAccount()));
		// TOF 登录状态变更 → 直接更新显示
		this._register(this.tofAuthService.onDidChangeUser((user: ITofUser | null) => this._onTofUserChanged(user)));
		this._register(this.chatEntitlementService.onDidChangeEntitlement(() => this.renderState()));
		this._register(this.chatEntitlementService.onDidChangeSentiment(() => this.renderState()));
		this._register(this.chatEntitlementService.onDidChangeQuotaExceeded(() => this.renderState()));
		this._register(this.chatEntitlementService.onDidChangeQuotaRemaining(() => this.renderState()));
		this.refreshAccount();
	}

	/** TOF 用户变更：直接更新 accountName 并渲染（不依赖 Copilot entitlement） */
	private _onTofUserChanged(user: ITofUser | null): void {
		if (user) {
			this.accountName = user.login_name;
			this.accountProviderId = 'tof';
			this.accountProviderLabel = 'OA';
			this.isAccountLoading = false;
			this.currentAvatarUrl = undefined;
			this.loadedAvatarUrl = undefined;
		} else {
			this.accountName = undefined;
			this.accountProviderId = undefined;
			this.accountProviderLabel = undefined;
		}
		this.renderState();
	}

	override setFocusable(_focusable: boolean): void {
		// Don't let the ActionBar remove focusability - this widget must
		// always be reachable via Tab even when a sibling item is hidden.
	}

	override render(container: HTMLElement): void {
		super.render(container);

		this.container = container;
		container.classList.add('sessions-account-titlebar-widget');
		container.setAttribute('role', 'button');
		container.tabIndex = 0;

		this.avatarElement = append(container, $('img.sessions-account-titlebar-widget-avatar', { alt: localize('accountAvatarAltFallback', "Account profile image"), draggable: 'false' })) as HTMLImageElement;
		this.avatarElement.decoding = 'async';
		this.avatarElement.referrerPolicy = 'no-referrer';
		this.iconElement = append(container, $('.sessions-account-titlebar-widget-icon'));
		this.labelElement = append(container, $('span.sessions-account-titlebar-widget-label'));
		this.badgeElement = append(container, $('span.sessions-account-titlebar-widget-badge'));

		this.renderState();
	}

	override onClick(): void {
		if (!this.container) {
			return;
		}

		this.showCombinedPanel();
	}

	private async refreshAccount(): Promise<void> {
		const requestId = ++this.accountRequestCounter;
		this.isAccountLoading = true;
		this.renderState();

		// 优先使用 TOF（太湖 OA）登录用户
		const tofUser = this.tofAuthService.currentUser;
		if (tofUser) {
			this.accountName = tofUser.login_name;
			this.accountProviderId = 'tof';
			this.accountProviderLabel = 'OA';
			this.isAccountLoading = false;
			this.currentAvatarUrl = undefined;
			this.loadedAvatarUrl = undefined;
			this.renderState();
			return;
		}

		// Fallback: 原生 Copilot / GitHub 账户流程
		const info = await resolveAccountInfo(this.defaultAccountService, this.authenticationService);
		if (requestId !== this.accountRequestCounter) {
			return;
		}

		this.accountName = info?.accountName;
		this.accountProviderId = info?.accountProviderId;
		this.accountProviderLabel = info?.accountProviderLabel;
		this.isAccountLoading = false;
		this.refreshAvatar();
		this.renderState();
	}

	private renderState(): void {
		if (!this.container || !this.avatarElement || !this.iconElement || !this.labelElement || !this.badgeElement) {
			return;
		}

		// When we have a session but entitlement hasn't resolved yet,
		// treat as Unresolved to avoid showing "Agents Signed Out".
		const entitlement = this.accountName && this.chatEntitlementService.entitlement === ChatEntitlement.Unknown
			? ChatEntitlement.Unresolved
			: this.chatEntitlementService.entitlement;

		const state = getAccountTitleBarState({
			isAccountLoading: this.isAccountLoading,
			accountName: this.accountName,
			accountProviderLabel: this.accountProviderLabel,
			entitlement,
			sentiment: this.chatEntitlementService.sentiment,
			quotas: this.chatEntitlementService.quotas,
		});
		this.lastState = state;

		this.container.classList.remove('kind-default', 'kind-accent', 'kind-warning', 'kind-prominent');
		this.container.classList.add(`kind-${state.kind}`);
		this.container.classList.toggle('menu-visible', this.isMenuVisible);
		this.container.setAttribute('aria-label', state.ariaLabel);

		const badgeKey = getAccountTitleBarBadgeKey(state);
		if (badgeKey !== this.lastBadgeKey) {
			this.lastBadgeKey = badgeKey;
			this.dismissedBadgeKey = undefined;
		}

		const shouldShowDotBadge = !!badgeKey && badgeKey !== this.dismissedBadgeKey;
		const loadedAvatarUrl = !this.isAccountLoading ? this.loadedAvatarUrl : undefined;
		const hasLoadedAvatar = !!loadedAvatarUrl;
		const titleBarIcon = state.dotBadge ? Codicon.account : state.icon;

		this.avatarElement.classList.toggle('visible', hasLoadedAvatar);
		this.avatarElement.alt = this.getAvatarAltText(hasLoadedAvatar);
		if (hasLoadedAvatar) {
			if (this.avatarElement.src !== loadedAvatarUrl) {
				this.avatarElement.src = loadedAvatarUrl;
			}
		} else {
			this.avatarElement.removeAttribute('src');
		}

		this.iconElement.className = `sessions-account-titlebar-widget-icon ${ThemeIcon.asClassName(titleBarIcon)}`;
		this.iconElement.classList.toggle('hidden', hasLoadedAvatar);
		this.labelElement.textContent = '';
		this.badgeElement.textContent = '';
		this.badgeElement.classList.toggle('dot-badge', shouldShowDotBadge);
		this.badgeElement.classList.toggle('dot-badge-warning', shouldShowDotBadge && state.dotBadge === 'warning');
		this.badgeElement.classList.toggle('dot-badge-error', shouldShowDotBadge && state.dotBadge === 'error');
		this.badgeElement.style.display = shouldShowDotBadge ? '' : 'none';
	}

	private getAvatarAltText(hasLoadedAvatar: boolean): string {
		if (hasLoadedAvatar && this.accountProviderId === 'github' && this.accountName) {
			return localize('accountAvatarAlt', "GitHub profile image for {0}", this.accountName);
		}

		return localize('accountAvatarAltFallback', "Account profile image");
	}

	private refreshAvatar(): void {
		const avatarUrl = getAccountProfileImageUrl(this.accountProviderId, this.accountName);
		if (avatarUrl === this.currentAvatarUrl) {
			return;
		}

		this.currentAvatarUrl = avatarUrl;
		this.loadedAvatarUrl = undefined;
		this.avatarLoadDisposable.clear();
		const requestId = ++this.avatarRequestCounter;

		if (!avatarUrl) {
			this.renderState();
			return;
		}

		const image = new Image();
		image.referrerPolicy = 'no-referrer';
		const clearHandlers = () => {
			image.onload = null;
			image.onerror = null;
		};
		image.onload = () => {
			if (requestId !== this.avatarRequestCounter) {
				return;
			}

			this.loadedAvatarUrl = avatarUrl;
			this.renderState();
			clearHandlers();
		};
		image.onerror = () => {
			if (requestId !== this.avatarRequestCounter) {
				return;
			}

			this.loadedAvatarUrl = undefined;
			this.renderState();
			clearHandlers();
		};
		this.avatarLoadDisposable.value = toDisposable(() => {
			clearHandlers();
			image.src = '';
		});
		image.src = avatarUrl;
		this.renderState();
	}

	private getHoverTarget(): { targetElements: HTMLElement[]; x: number } {
		const { left, width } = getDomNodePagePosition(this.container!);
		return {
			targetElements: [this.container!],
			x: left + width - SESSIONS_ACCOUNT_TITLEBAR_PANEL_WIDTH,
		};
	}

	private showCombinedPanel(): void {
		if (!this.container) {
			return;
		}

		if (this.isMenuVisible) {
			this.hoverService.hideHover(true);
			this.clickPanelDisposable.clear();
			return;
		}

		this.hoverService.hideHover(true);
		this.clickPanelDisposable.clear();

		const panelStore = new DisposableStore();
		this.clickPanelDisposable.value = panelStore;

		const badgeKey = getAccountTitleBarBadgeKey(this.lastState);
		if (badgeKey) {
			this.dismissedBadgeKey = badgeKey;
		}

		this.isMenuVisible = true;
		this.container.classList.add('menu-visible');
		this.renderState();

		panelStore.add({
			dispose: () => {
				this.isMenuVisible = false;
				this.container?.classList.remove('menu-visible');
				this.renderState();
				this.container?.focus();
			}
		});

		const panelContent = this.createCombinedPanelContent(panelStore);
		const hoverWidget = this.hoverService.showInstantHover({
			content: panelContent,
			target: this.getHoverTarget(),
			additionalClasses: ['sessions-account-titlebar-panel-hover'],
			position: { hoverPosition: HoverPosition.BELOW },
			persistence: { sticky: true, hideOnHover: false },
			appearance: { showPointer: false, skipFadeInAnimation: true, maxHeightRatio: 0.8 },
		}, true);

		if (hoverWidget) {
			panelStore.add(hoverWidget);
		}

		panelStore.add(disposableWindowInterval(mainWindow, () => {
			if (!panelContent.isConnected || hoverWidget?.isDisposed) {
				this.clickPanelDisposable.clear();
			}
		}, 500));
	}

	private createCombinedPanelContent(panelStore: DisposableStore): HTMLElement {
		const panel = $('div.sessions-account-titlebar-panel');

		// Build the menu actions once and partition them.
		const menu = this.menuService.createMenu(AccountMenu, this.contextKeyService);
		const rawActions: IAction[] = [];
		fillInActionBarActions(menu.getActions(), rawActions);
		menu.dispose();
		const partitioned = this.partitionMenuActions(rawActions);

		// Header: account label + sign-out icon.
		const headerSection = append(panel, $('.sessions-account-titlebar-panel-header'));
		const loadedAvatarUrl = !this.isAccountLoading ? this.loadedAvatarUrl : undefined;
		if (loadedAvatarUrl) {
			const avatar = append(headerSection, $('img.sessions-account-titlebar-panel-avatar', {
				alt: this.getAvatarAltText(true),
				draggable: 'false',
				src: loadedAvatarUrl,
			})) as HTMLImageElement;
			avatar.decoding = 'async';
			avatar.referrerPolicy = 'no-referrer';
		}
		const title = append(headerSection, $('div.sessions-account-titlebar-panel-title'));
		title.textContent = this.getPanelHeaderLabel();
		if (partitioned.signOut) {
			const headerActionsContainer = append(headerSection, $('.sessions-account-titlebar-panel-header-actions'));
			this.createPanelButton(headerActionsContainer, partitioned.signOut, panelStore, {
				classNames: ['sessions-account-titlebar-panel-header-action'],
				icon: this.getHeaderActionIcon(partitioned.signOut),
			});
		}

		// Personalize section.
		if (partitioned.personalize.length > 0) {
			const personalizeId = 'sessions-account-personalize-title';
			const personalizeSection = append(panel, $('section.sessions-account-titlebar-panel-section', { 'aria-labelledby': personalizeId }));
			const personalizeHeading = append(personalizeSection, $('div.sessions-account-titlebar-panel-section-title', { id: personalizeId }));
			personalizeHeading.textContent = localize('sessionsAccountMenu.personalize', "Personalize");
			const personalizeActionsContainer = append(personalizeSection, $('.sessions-account-titlebar-panel-actions'));
			for (const action of partitioned.personalize) {
				this.createPanelButton(personalizeActionsContainer, action, panelStore, {
					classNames: ['sessions-account-titlebar-panel-action', 'with-icon'],
					icon: this.getPersonalizeActionIcon(action),
					includeLabel: true,
				});
			}
		}

		// Other panel actions (sign-in, etc.) — only render if there's at least one non-separator action.
		if (partitioned.other.some(a => !(a instanceof Separator))) {
			const actionsSection = append(panel, $('.sessions-account-titlebar-panel-actions'));
			let lastWasSeparator = true;
			for (const action of partitioned.other) {
				if (action instanceof Separator) {
					if (!lastWasSeparator) {
						append(actionsSection, $('.sessions-account-titlebar-panel-separator'));
						lastWasSeparator = true;
					}
					continue;
				}
				lastWasSeparator = false;
				this.createPanelButton(actionsSection, action, panelStore, {
					classNames: ['sessions-account-titlebar-panel-action'],
					includeLabel: true,
					checked: !!action.checked,
				});
			}
		}

		// Subscription / Copilot dashboard.
		const contentSection = append(panel, $('.sessions-account-titlebar-panel-content'));
		if (this.shouldShowCopilotDashboardHover()) {
			const subscriptionId = 'sessions-account-subscription-title';
			const subscriptionSection = append(contentSection, $('section.sessions-account-titlebar-panel-section.subscription', { 'aria-labelledby': subscriptionId }));
			const subscriptionHeader = append(subscriptionSection, $('.sessions-account-titlebar-panel-section-header'));
			const subscriptionHeading = append(subscriptionHeader, $('div.sessions-account-titlebar-panel-section-title', { id: subscriptionId }));
			subscriptionHeading.textContent = localize('sessionsAccountMenu.subscription', "Subscription");
			// Render the dashboard's title header (plan name + manage / CTA actions)
			// directly into our section header row via the dashboard's public API.
			const dashboard = this.createCopilotHoverContent({ titleHeaderContainer: subscriptionHeader });
			append(subscriptionSection, dashboard);
		} else if (!this.isAccountLoading) {
			const summary = append(contentSection, $('.sessions-account-titlebar-panel-summary'));
			summary.textContent = this.lastState.ariaLabel;
		}

		return panel;
	}

	private partitionMenuActions(rawActions: IAction[]): { signOut: IAction | undefined; personalize: IAction[]; other: IAction[] } {
		let signOut: IAction | undefined;
		const personalizeMap = new Map<string, IAction>();
		const other: IAction[] = [];

		const pushSeparator = () => {
			// Collapse runs and skip leading separators so groups whose only
			// items get filtered (e.g. update.*) don't leave orphans behind.
			if (other.length === 0 || other[other.length - 1] instanceof Separator) {
				return;
			}
			other.push(new Separator());
		};

		for (const action of rawActions) {
			if (action instanceof Separator) {
				pushSeparator();
				continue;
			}
			if (action.id === SIGN_OUT_ACTION_ID) {
				signOut = action;
				continue;
			}
			if (PERSONALIZE_ACTION_IDS.includes(action.id)) {
				personalizeMap.set(action.id, action);
				continue;
			}
			if (action.id.startsWith('update.')) {
				continue;
			}
			if (this.isAccountLoading && action.id === SIGN_IN_ACTION_ID) {
				continue;
			}
			other.push(action);
		}

		// Trim trailing separator left after filtering.
		if (other.length > 0 && other[other.length - 1] instanceof Separator) {
			other.pop();
		}

		// Preserve canonical personalize order.
		const personalize = PERSONALIZE_ACTION_IDS
			.map(id => personalizeMap.get(id))
			.filter((a): a is IAction => !!a);

		return { signOut, personalize, other };
	}

	private createPanelButton(
		parent: HTMLElement,
		action: IAction,
		panelStore: DisposableStore,
		options: { classNames: readonly string[]; icon?: ThemeIcon; includeLabel?: boolean; checked?: boolean },
	): HTMLButtonElement {
		const button = append(parent, $('button', { type: 'button' })) as HTMLButtonElement;
		button.classList.add(...options.classNames);
		button.disabled = !action.enabled;
		button.setAttribute('aria-label', action.tooltip || action.label);
		if (options.checked) {
			button.classList.add('checked');
		}

		if (options.icon && options.includeLabel) {
			const iconElement = append(button, $('span.sessions-account-titlebar-panel-action-icon'));
			iconElement.classList.add(...ThemeIcon.asClassNameArray(options.icon));
			const labelElement = append(button, $('span.sessions-account-titlebar-panel-action-label'));
			append(labelElement, ...renderLabelWithIcons(action.label));
		} else if (options.icon) {
			button.title = action.tooltip || action.label;
			button.classList.add(...ThemeIcon.asClassNameArray(options.icon));
		} else {
			append(button, ...renderLabelWithIcons(action.label));
		}

		panelStore.add(addDisposableListener(button, EventType.CLICK, async event => {
			event.preventDefault();
			event.stopPropagation();
			this.hoverService.hideHover(true);
			this.clickPanelDisposable.clear();
			await Promise.resolve(action.run());
		}));

		return button;
	}

	private getPanelHeaderLabel(): string {
		if (this.accountName) {
			return this.accountName;
		}

		if (this.isAccountLoading) {
			return localize('loadingAccountHeader', "Loading Account...");
		}

		return localize('accountMenuHeaderFallback', "Account");
	}

	private getHeaderActionIcon(action: IAction): ThemeIcon {
		switch (action.id) {
			case 'workbench.action.selectTheme':
				return Codicon.symbolColor;
			case 'workbench.action.openSettings':
				return Codicon.settingsGear;
			case SIGN_OUT_ACTION_ID:
				return Codicon.signOut;
			default:
				return Codicon.circleLargeFilled;
		}
	}

	private getPersonalizeActionIcon(action: IAction): ThemeIcon {
		switch (action.id) {
			case 'workbench.action.openSettings':
				return Codicon.settingsGear;
			case 'workbench.action.openGlobalKeybindings':
				return Codicon.keyboard;
			case 'workbench.action.selectTheme':
				return Codicon.symbolColor;
			default:
				return Codicon.circleLargeFilled;
		}
	}

	private shouldShowCopilotDashboardHover(): boolean {
		return !this.chatEntitlementService.sentiment.hidden && !!this.accountName;
	}

	private createCopilotHoverContent(extraOptions?: Partial<IChatStatusDashboardOptions>): HTMLElement {
		const store = new DisposableStore();
		this.copilotDashboardStore.value = store;
		const dashboardElement = ChatStatusDashboard.instantiateInContents(this.instantiationService, store, {
			disableInlineSuggestionsSettings: true,
			disableModelSelection: true,
			disableProviderOptions: true,
			disableCompletionsSnooze: true,
			disableQuickSettingsCollapsible: true,
			disableContributedSectionsCollapsible: true,
			...extraOptions,
		});

		store.add(disposableWindowInterval(mainWindow, () => {
			if (!dashboardElement.isConnected) {
				store.dispose();
			}
		}, 2000));

		return dashboardElement;
	}
}

// --- Register custom view item --- //

// Actions registered at module level so Menus.TitleBarRightLayout is non-empty when the
// toolbar is first constructed. The run() is a no-op — rendering is handled by the custom
// view items registered in AccountWidgetContribution.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SessionsTitleBarAccountWidgetAction,
			title: localize2('agentsAccountStatusTitleBar', "Agents Account and Status"),
			menu: {
				id: Menus.TitleBarRightLayout,
				group: 'navigation',
				order: 100,
				when: IsAuxiliaryWindowContext.toNegated(),
			}
		});
	}

	run(): void { }
});


// --- Sidebar Footer: Personal button (moved from activity bar) --- //
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.action.sidebarFooterPersonal',
			title: localize2('sidebarFooterPersonal', 'Personal'),
			icon: Codicon.account,
			menu: {
				id: Menus.SidebarFooter,
				group: 'navigation',
				order: 2,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const tofAuthService = accessor.get(ITofAuthService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const user = tofAuthService.currentUser;
		if (user) {
			// 已登录 → 显示用户信息
			await dialogService.info(
				localize('personalInfoTitle', "个人中心"),
				localize('personalInfoMessage', "当前登录：{0}（工号 {1}{2}）",
					user.login_name, user.staff_id,
					user.team ? '，团队 ' + user.team : '')
			);
		} else {
			// 未登录 → 确认后发起 TOF 登录
			const { confirmed } = await dialogService.confirm({
				type: Severity.Info,
				message: localize('tofLoginConfirmTitle', "OA 登录"),
				detail: localize('tofLoginConfirmDetail', "点击「登录」后将打开系统浏览器，请在浏览器中完成 iOA 登录。\n登录成功后浏览器会自动跳回客户端。"),
				primaryButton: localize({ key: 'tofLoginButton', comment: ['&& denotes a mnemonic'] }, "&&登录"),
				cancelButton: localize('cancel', "取消")
			});
			if (!confirmed) {
				return;
			}

			// 显示进度提示
			const progress = notificationService.prompt(
				Severity.Info,
				localize('tofLoginInProgress', "正在打开浏览器进行 OA 登录…"),
				[],
				{ sticky: true }
			);

			try {
				const user = await tofAuthService.login();
				progress.close();
				notificationService.info(`登录成功：${user.login_name}（工号 ${user.staff_id}）`);
			} catch (e) {
				progress.close();
				const msg = (e as Error).message;
				notificationService.error(`登录失败：${msg}`);
			}
		}
	}
});

// --- Sidebar Footer: Settings button (moved from activity bar) --- //
// Opens the custom Agent Studio SettingsEditorPane instead of native VSCode settings.

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.action.sidebarFooterSettings',
			title: localize2('sidebarFooterSettings', 'Settings'),
			icon: Codicon.settingsGear,
			menu: {
				id: Menus.SidebarFooter,
				group: 'navigation',
				order: 3,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const input = SettingsEditorInput.getInstance();
		const groups = editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */);
		if (groups.length <= 1) {
			// Only one group — open to the side (creates a left group)
			await editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		} else {
			// Use the first (leftmost) group
			await editorService.openEditor(input, { pinned: true }, groups[0]);
		}
	}
});

class AccountWidgetContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsWidget';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(actionViewItemService.register(Menus.TitleBarRightLayout, SessionsTitleBarAccountWidgetAction, (action, options) => {
			return instantiationService.createInstance(TitleBarAccountWidget, action, options);
		}, undefined));
	}
}

registerWorkbenchContribution2(AccountWidgetContribution.ID, AccountWidgetContribution, WorkbenchPhase.BlockRestore);

// --- Chat Dashboard Service (real implementation for mobile account sheet) --- //

class ChatDashboardServiceImpl implements IChatDashboardService {
	readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	createDashboardElement(store: DisposableStore): HTMLElement | undefined {
		const dashboardElement = ChatStatusDashboard.instantiateInContents(this.instantiationService, store, {
			disableInlineSuggestionsSettings: true,
			disableModelSelection: true,
			disableProviderOptions: true,
			disableCompletionsSnooze: true,
		});

		store.add(disposableWindowInterval(mainWindow, () => {
			if (!dashboardElement.isConnected) {
				store.dispose();
			}
		}, 2000));

		return dashboardElement;
	}
}

registerSingleton(IChatDashboardService, ChatDashboardServiceImpl, InstantiationType.Delayed);
