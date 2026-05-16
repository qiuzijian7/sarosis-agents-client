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
import { IAgentOSService } from '../../common/agentOS.js';

interface ToolDefinition {
	id: string;
	name: string;
	category: 'builtin' | 'mcp' | 'custom';
	description: string;
	icon: string;
	enabled: boolean;
	provider?: string;
}

/**
 * 把 `IToolDefinition` (来自 IAgentOSService 的 ActiveToolProvider) 适配成
 * UI 用的 `ToolDefinition` —— 仅在 view 内部使用。
 */
function categorize(category: string | undefined): 'builtin' | 'mcp' | 'custom' {
	if (!category) { return 'builtin'; }
	if (category.startsWith('mcp:') || category.startsWith('mcp-') || category === 'mcp') { return 'mcp'; }
	if (category === 'utility' || category === 'filesystem' || category === 'web' || category === 'shell') { return 'builtin'; }
	return 'custom';
}

function categoryIcon(c: 'builtin' | 'mcp' | 'custom', toolCategory: string | undefined): string {
	if (c === 'mcp') { return '🔌'; }
	if (c === 'custom') { return '🧩'; }
	switch (toolCategory) {
		case 'filesystem': return '📁';
		case 'web': return '🌐';
		case 'shell': return '⌨️';
		case 'utility': return '🛠️';
		default: return '🔧';
	}
}

/**
 * Tools View - 工具管理面板
 * 数据源：IAgentOSService.getActiveToolProvider() —— 同时覆盖内置工具与 MCP 工具，
 * 由 BuiltinToolProvider / McpToolProvider 注入到 IAgentOSService 的 slot 中。
 */
export class ToolsViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private tools: ToolDefinition[] = [];
	private activeTab = 'all';

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
		@IAgentOSService private readonly agentOSService: IAgentOSService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('tools-view');

		// Header
		const header = $('div.tools-header');
		const title = $('h3.tools-title');
		title.textContent = '🔧 Tools & MCP';
		header.appendChild(title);

		const refreshBtn = $('button.tools-add-btn');
		refreshBtn.textContent = '↻ Refresh';
		refreshBtn.title = 'Reload tools from active provider';
		refreshBtn.onclick = () => { void this._reload(); };
		header.appendChild(refreshBtn);
		container.appendChild(header);

		// Tabs
		const tabs = $('div.tools-tabs');
		const tabDefs = [
			{ id: 'all', label: 'All' },
			{ id: 'builtin', label: 'Built-in' },
			{ id: 'mcp', label: 'MCP' },
			{ id: 'custom', label: 'Custom' },
		];
		for (const tab of tabDefs) {
			const btn = $('button.tools-tab');
			btn.textContent = tab.label;
			if (tab.id === 'all') { btn.classList.add('active'); }
			btn.onclick = () => {
				tabs.querySelectorAll('.tools-tab').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeTab = tab.id;
				this._renderTools();
			};
			tabs.appendChild(btn);
		}
		container.appendChild(tabs);

		// Tools list
		this.listContainer = $('div.tools-list');
		container.appendChild(this.listContainer);
		void this._reload();
	}

	private async _reload(): Promise<void> {
		const next: ToolDefinition[] = [];
		const provider = this.agentOSService.getActiveToolProvider();
		if (provider) {
			try {
				// agentId is opaque to the provider for read-only listing.
				const defs = await provider.listTools('viewer');
				for (const d of defs) {
					const cat = categorize(d.category);
					next.push({
						id: d.name,
						name: d.name,
						category: cat,
						description: d.description ?? '',
						icon: categoryIcon(cat, d.category),
						enabled: true,
						provider: d.source ?? provider.id,
					});
				}
			} catch {
				// ignore — provider not ready
			}
		}
		this.tools = next;
		this._renderTools();
	}

	private _renderTools(): void {
		this.listContainer.innerHTML = '';
		const filtered = this.activeTab === 'all'
			? this.tools
			: this.tools.filter(t => t.category === this.activeTab);

		if (filtered.length === 0) {
			const empty = $('div.tools-empty');
			empty.innerHTML = '<p>No tools available. Try refreshing or installing an MCP server.</p>';
			this.listContainer.appendChild(empty);
			return;
		}

		for (const tool of filtered) {
			const item = $('div.tool-item');
			item.classList.toggle('tool-enabled', tool.enabled);

			const iconEl = $('span.tool-icon');
			iconEl.textContent = tool.icon;
			item.appendChild(iconEl);

			const info = $('div.tool-info');
			const nameRow = $('div.tool-name-row');
			const nameEl = $('span.tool-name');
			nameEl.textContent = tool.name;
			nameRow.appendChild(nameEl);

			const categoryBadge = $('span.tool-category');
			categoryBadge.textContent = tool.category;
			categoryBadge.classList.add(`cat-${tool.category}`);
			nameRow.appendChild(categoryBadge);
			info.appendChild(nameRow);

			const descEl = $('div.tool-desc');
			descEl.textContent = tool.description;
			info.appendChild(descEl);

			if (tool.provider) {
				const providerEl = $('div.tool-provider');
				providerEl.textContent = `📦 ${tool.provider}`;
				info.appendChild(providerEl);
			}
			item.appendChild(info);

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

