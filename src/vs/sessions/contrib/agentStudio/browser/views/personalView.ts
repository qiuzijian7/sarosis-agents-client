/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
import { $ } from '../../../../../base/browser/dom.js';

/**
 * Personal View - 个人中心面板
 * 功能：用户资料、API配置、使用统计、登录状态
 */
export class PersonalViewPane extends ViewPane {

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('personal-view');

		// Profile card
		const profile = $('div.personal-profile');
		const avatar = $('div.profile-avatar', undefined, '👤');
		const profileInfo = $('div.profile-info');
		profileInfo.appendChild($('div.profile-name', undefined, 'User'));
		profileInfo.appendChild($('div.profile-email', undefined, 'user@example.com'));
		const planRow = $('div.profile-plan');
		planRow.appendChild($('span.plan-badge', undefined, 'Pro'));
		planRow.appendChild($('span.plan-status', undefined, 'Active'));
		profileInfo.appendChild(planRow);
		profile.appendChild(avatar);
		profile.appendChild(profileInfo);
		container.appendChild(profile);

		// Usage stats
		const stats = $('div.personal-stats');
		stats.appendChild($('h4', undefined, '📊 Usage This Month'));
		const statsGrid = $('div.stats-grid');
		statsGrid.appendChild(this._createStatCard('1,234', 'API Calls', 42));
		statsGrid.appendChild(this._createStatCard('56.7K', 'Tokens Used', 28));
		statsGrid.appendChild(this._createStatCard('23', 'Tasks Completed'));
		statsGrid.appendChild(this._createStatCard('5', 'Active Agents'));
		stats.appendChild(statsGrid);
		container.appendChild(stats);

		// API Keys section
		const apiKeys = $('div.personal-api-keys');
		apiKeys.appendChild($('h4', undefined, '🔑 API Keys'));
		const keyList = $('div.api-key-list');
		keyList.appendChild(this._createApiKeyItem('OpenAI', true));
		keyList.appendChild(this._createApiKeyItem('Anthropic', true));
		keyList.appendChild(this._createApiKeyItem('Google AI', false));
		apiKeys.appendChild(keyList);
		const manageBtn = $('button.manage-keys-btn', undefined, 'Manage API Keys');
		apiKeys.appendChild(manageBtn);
		container.appendChild(apiKeys);

		// Quick actions
		const actions = $('div.personal-actions');
		actions.appendChild($('h4', undefined, '⚡ Quick Actions'));
		const actionList = $('div.action-list');
		actionList.appendChild($('button.personal-action-btn', undefined, '📤 Export Data'));
		actionList.appendChild($('button.personal-action-btn', undefined, '📥 Import Config'));
		actionList.appendChild($('button.personal-action-btn', undefined, '🔄 Sync Settings'));
		actionList.appendChild($('button.personal-action-btn.danger', undefined, '🚪 Sign Out'));
		actions.appendChild(actionList);
		container.appendChild(actions);
	}

	private _createStatCard(value: string, label: string, barPercent?: number): HTMLElement {
		const card = $('div.stat-card');
		card.appendChild($('div.stat-value', undefined, value));
		card.appendChild($('div.stat-label', undefined, label));
		if (barPercent !== undefined) {
			const bar = $('div.stat-bar');
			const fill = $('div.stat-bar-fill') as HTMLDivElement;
			fill.style.width = `${barPercent}%`;
			bar.appendChild(fill);
			card.appendChild(bar);
		}
		return card;
	}

	private _createApiKeyItem(provider: string, configured: boolean): HTMLElement {
		const item = $('div.api-key-item');
		item.appendChild($('span.key-provider', undefined, provider));
		const status = configured
			? $('span.key-status.configured', undefined, '✓ Configured')
			: $('span.key-status.not-configured', undefined, 'Not configured');
		item.appendChild(status);
		return item;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
