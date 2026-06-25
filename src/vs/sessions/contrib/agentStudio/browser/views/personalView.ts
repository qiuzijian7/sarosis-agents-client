/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { $, append, addDisposableListener, EventType } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ITofAuthService, ITofUser } from '../../common/tofAuth.js';

/**
 * Personal View - 个人中心面板
 * 功能：用户资料、登录状态、API配置、使用统计
 * 对接 TOF (太湖 OA) 登录，显示真实用户信息。
 */
export class PersonalViewPane extends ViewPane {

	private readonly bodyDisposables = this._register(new DisposableStore());
	private profileNameEl: HTMLElement | undefined;
	private profileEmailEl: HTMLElement | undefined;
	private planStatusEl: HTMLElement | undefined;
	private signOutBtn: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('personal-view');

		// Profile card
		const profile = append(container, $('div.personal-profile'));
		append(profile, $('div.profile-avatar', undefined, '👤'));
		const profileInfo = append(profile, $('div.profile-info'));
		this.profileNameEl = append(profileInfo, $('div.profile-name', undefined, '未登录'));
		this.profileEmailEl = append(profileInfo, $('div.profile-email', undefined, '请点击登录'));
		const planRow = append(profileInfo, $('div.profile-plan'));
		append(planRow, $('span.plan-badge', undefined, 'OA'));
		this.planStatusEl = append(planRow, $('span.plan-status', undefined, '未登录'));

		// Login / Logout section
		const authSection = append(container, $('div.personal-auth'));
		append(authSection, $('h4', undefined, '🔐 账号'));
		const authActions = append(authSection, $('div.action-list'));
		const loginBtn = append(authActions, $('button.personal-action-btn.primary', undefined, '🚀 OA 登录')) as HTMLButtonElement;
		this.signOutBtn = append(authActions, $('button.personal-action-btn.danger', undefined, '🚪 登出')) as HTMLButtonElement;
		this.signOutBtn.style.display = 'none';

		this._register(addDisposableListener(loginBtn, EventType.CLICK, () => this._handleLogin()));
		this._register(addDisposableListener(this.signOutBtn, EventType.CLICK, () => this._handleLogout()));

		// Usage stats (static placeholder)
		const stats = append(container, $('div.personal-stats'));
		append(stats, $('h4', undefined, '📊 本月使用统计'));
		const statsGrid = append(stats, $('div.stats-grid'));
		this._appendStatCard(statsGrid, '0', 'API 调用');
		this._appendStatCard(statsGrid, '0', 'Token 用量');
		this._appendStatCard(statsGrid, '0', '完成任务');
		this._appendStatCard(statsGrid, '0', '活跃 Agent');

		// Quick actions
		const actions = append(container, $('div.personal-actions'));
		append(actions, $('h4', undefined, '⚡ 快捷操作'));
		const actionList = append(actions, $('div.action-list'));
		append(actionList, $('button.personal-action-btn', undefined, '📤 导出数据'));
		append(actionList, $('button.personal-action-btn', undefined, '📥 导入配置'));
		append(actionList, $('button.personal-action-btn', undefined, '🔄 同步设置'));

		// 监听 TOF 用户变更
		this.bodyDisposables.add(this.tofAuthService.onDidChangeUser((user: ITofUser | null) => this._renderUser(user)));

		// 初始渲染当前用户
		this._renderUser(this.tofAuthService.currentUser);
	}

	private _renderUser(user: ITofUser | null): void {
		if (!this.profileNameEl || !this.profileEmailEl || !this.planStatusEl || !this.signOutBtn) {
			return;
		}

		if (user) {
			this.profileNameEl.textContent = user.login_name;
			this.profileEmailEl.textContent = `工号 ${user.staff_id}${user.team ? ' · ' + user.team : ''}`;
			this.planStatusEl.textContent = '已登录';
			this.planStatusEl.classList.remove('not-configured');
			this.planStatusEl.classList.add('configured');
			this.signOutBtn.style.display = '';
		} else {
			this.profileNameEl.textContent = '未登录';
			this.profileEmailEl.textContent = '请点击登录';
			this.planStatusEl.textContent = '未登录';
			this.planStatusEl.classList.remove('configured');
			this.planStatusEl.classList.add('not-configured');
			this.signOutBtn.style.display = 'none';
		}
	}

	private async _handleLogin(): Promise<void> {
		try {
			const user = await this.tofAuthService.login();
			this.notificationService.info(`登录成功：${user.login_name}（工号 ${user.staff_id}）`);
		} catch (e) {
			this.notificationService.error(`登录失败：${(e as Error).message}`);
			this.logService.error('[PersonalView] Login failed:', e);
		}
	}

	private async _handleLogout(): Promise<void> {
		await this.tofAuthService.logout();
		this.notificationService.info('已登出');
	}

	private _appendStatCard(parent: HTMLElement, value: string, label: string): void {
		const card = append(parent, $('div.stat-card'));
		append(card, $('div.stat-value', undefined, value));
		append(card, $('div.stat-label', undefined, label));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
