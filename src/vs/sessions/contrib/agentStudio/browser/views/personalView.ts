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
		profile.innerHTML = `
			<div class="profile-avatar">👤</div>
			<div class="profile-info">
				<div class="profile-name">User</div>
				<div class="profile-email">user@example.com</div>
				<div class="profile-plan">
					<span class="plan-badge">Pro</span>
					<span class="plan-status">Active</span>
				</div>
			</div>
		`;
		container.appendChild(profile);

		// Usage stats
		const stats = $('div.personal-stats');
		stats.innerHTML = `
			<h4>📊 Usage This Month</h4>
			<div class="stats-grid">
				<div class="stat-card">
					<div class="stat-value">1,234</div>
					<div class="stat-label">API Calls</div>
					<div class="stat-bar"><div class="stat-bar-fill" style="width:42%"></div></div>
				</div>
				<div class="stat-card">
					<div class="stat-value">56.7K</div>
					<div class="stat-label">Tokens Used</div>
					<div class="stat-bar"><div class="stat-bar-fill" style="width:28%"></div></div>
				</div>
				<div class="stat-card">
					<div class="stat-value">23</div>
					<div class="stat-label">Tasks Completed</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">5</div>
					<div class="stat-label">Active Agents</div>
				</div>
			</div>
		`;
		container.appendChild(stats);

		// API Keys section
		const apiKeys = $('div.personal-api-keys');
		apiKeys.innerHTML = `
			<h4>🔑 API Keys</h4>
			<div class="api-key-list">
				<div class="api-key-item">
					<span class="key-provider">OpenAI</span>
					<span class="key-status configured">✓ Configured</span>
				</div>
				<div class="api-key-item">
					<span class="key-provider">Anthropic</span>
					<span class="key-status configured">✓ Configured</span>
				</div>
				<div class="api-key-item">
					<span class="key-provider">Google AI</span>
					<span class="key-status not-configured">Not configured</span>
				</div>
			</div>
			<button class="manage-keys-btn">Manage API Keys</button>
		`;
		container.appendChild(apiKeys);

		// Quick actions
		const actions = $('div.personal-actions');
		actions.innerHTML = `
			<h4>⚡ Quick Actions</h4>
			<div class="action-list">
				<button class="personal-action-btn">📤 Export Data</button>
				<button class="personal-action-btn">📥 Import Config</button>
				<button class="personal-action-btn">🔄 Sync Settings</button>
				<button class="personal-action-btn danger">🚪 Sign Out</button>
			</div>
		`;
		container.appendChild(actions);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
