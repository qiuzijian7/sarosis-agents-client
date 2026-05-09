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

interface PluginInfo {
	id: string;
	name: string;
	version: string;
	author: string;
	description: string;
	icon: string;
	installed: boolean;
	enabled: boolean;
	category: string;
}

const PLUGIN_REGISTRY: PluginInfo[] = [
	{ id: 'memory-plugin', name: 'Memory Provider', version: '1.0.0', author: 'Sarosis', description: 'Persistent memory for agents across sessions', icon: '🧠', installed: true, enabled: true, category: 'Core' },
	{ id: 'context-engine', name: 'Context Engine', version: '1.2.0', author: 'Sarosis', description: 'Smart context retrieval and injection', icon: '📚', installed: true, enabled: true, category: 'Core' },
	{ id: 'code-review', name: 'Code Review', version: '0.9.0', author: 'Community', description: 'Automated code review and suggestions', icon: '🔍', installed: true, enabled: false, category: 'Development' },
	{ id: 'image-gen', name: 'Image Generation', version: '1.1.0', author: 'Sarosis', description: 'Generate images from text descriptions', icon: '🎨', installed: false, enabled: false, category: 'Creative' },
	{ id: 'dashboard', name: 'Dashboard', version: '2.0.0', author: 'Sarosis', description: 'Agent monitoring and analytics dashboard', icon: '📊', installed: false, enabled: false, category: 'Analytics' },
	{ id: 'slack-bridge', name: 'Slack Bridge', version: '1.0.0', author: 'Community', description: 'Connect agents to Slack channels', icon: '💬', installed: false, enabled: false, category: 'Integration' },
	{ id: 'github-actions', name: 'GitHub Actions', version: '0.8.0', author: 'Community', description: 'Trigger and monitor GitHub Actions', icon: '🐙', installed: false, enabled: false, category: 'Integration' },
];

/**
 * Plugins View - 插件管理面板
 * 功能：浏览插件市场、安装/卸载/启用/禁用插件
 */
export class PluginsViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private plugins: PluginInfo[] = [...PLUGIN_REGISTRY];
	private activeTab = 'installed';

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
		container.classList.add('plugins-view');

		const header = $('div.plugins-header');
		const title = $('h3.plugins-title');
		title.textContent = '📦 Plugins';
		header.appendChild(title);
		container.appendChild(header);

		// Tabs
		const tabs = $('div.plugins-tabs');
		const tabDefs = [
			{ id: 'installed', label: `Installed (${this.plugins.filter(p => p.installed).length})` },
			{ id: 'marketplace', label: 'Marketplace' },
		];
		for (const tab of tabDefs) {
			const btn = $('button.plugins-tab');
			btn.textContent = tab.label;
			if (tab.id === 'installed') { btn.classList.add('active'); }
			btn.onclick = () => {
				tabs.querySelectorAll('.plugins-tab').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeTab = tab.id;
				this._renderPlugins();
			};
			tabs.appendChild(btn);
		}
		container.appendChild(tabs);

		// Search
		const searchInput = document.createElement('input');
		searchInput.className = 'plugins-search';
		searchInput.placeholder = '🔍 Search plugins...';
		searchInput.oninput = () => this._filterPlugins(searchInput.value);
		container.appendChild(searchInput);

		this.listContainer = $('div.plugins-list');
		this._renderPlugins();
		container.appendChild(this.listContainer);
	}

	private _renderPlugins(): void {
		this.listContainer.innerHTML = '';
		const filtered = this.activeTab === 'installed'
			? this.plugins.filter(p => p.installed)
			: this.plugins.filter(p => !p.installed);

		if (filtered.length === 0) {
			const empty = $('div.plugins-empty');
			empty.innerHTML = this.activeTab === 'installed'
				? '<p>No plugins installed</p>'
				: '<p>No more plugins available</p>';
			this.listContainer.appendChild(empty);
			return;
		}

		for (const plugin of filtered) {
			const item = $('div.plugin-item');
			const iconEl = $('div.plugin-icon');
			iconEl.textContent = plugin.icon;
			item.appendChild(iconEl);

			const info = $('div.plugin-info');
			const nameRow = $('div.plugin-name-row');
			const nameEl = $('span.plugin-name');
			nameEl.textContent = plugin.name;
			nameRow.appendChild(nameEl);
			const versionEl = $('span.plugin-version');
			versionEl.textContent = `v${plugin.version}`;
			nameRow.appendChild(versionEl);
			info.appendChild(nameRow);

			const authorEl = $('div.plugin-author');
			authorEl.textContent = `by ${plugin.author}`;
			info.appendChild(authorEl);

			const descEl = $('div.plugin-desc');
			descEl.textContent = plugin.description;
			info.appendChild(descEl);
			item.appendChild(info);

			const actions = $('div.plugin-actions');
			if (plugin.installed) {
				const toggleBtn = $('button.plugin-action-btn');
				toggleBtn.textContent = plugin.enabled ? 'Disable' : 'Enable';
				toggleBtn.classList.add(plugin.enabled ? 'disable' : 'enable');
				toggleBtn.onclick = () => { plugin.enabled = !plugin.enabled; this._renderPlugins(); };
				actions.appendChild(toggleBtn);

				const uninstallBtn = $('button.plugin-action-btn.uninstall');
				uninstallBtn.textContent = 'Uninstall';
				uninstallBtn.onclick = () => { plugin.installed = false; this._renderPlugins(); };
				actions.appendChild(uninstallBtn);
			} else {
				const installBtn = $('button.plugin-action-btn.install');
				installBtn.textContent = 'Install';
				installBtn.onclick = () => { plugin.installed = true; plugin.enabled = true; this._renderPlugins(); };
				actions.appendChild(installBtn);
			}
			item.appendChild(actions);

			this.listContainer.appendChild(item);
		}
	}

	private _filterPlugins(query: string): void {
		const lowerQuery = query.toLowerCase();
		const base = this.activeTab === 'installed'
			? this.plugins.filter(p => p.installed)
			: this.plugins.filter(p => !p.installed);
		const filtered = base.filter(p =>
			p.name.toLowerCase().includes(lowerQuery) ||
			p.description.toLowerCase().includes(lowerQuery)
		);
		this.listContainer.innerHTML = '';
		for (const plugin of filtered) {
			// Re-render matching items (simplified)
			const item = $('div.plugin-item');
			item.innerHTML = `<div class="plugin-icon">${plugin.icon}</div><div class="plugin-info"><div class="plugin-name">${plugin.name}</div><div class="plugin-desc">${plugin.description}</div></div>`;
			this.listContainer.appendChild(item);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 110}px`;
		}
	}
}
