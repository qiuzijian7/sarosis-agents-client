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
import { IToolDefinition } from '../../common/providers.js';

interface ToolDefinitionUI {
	id: string;
	name: string;
	category: 'builtin' | 'custom';
	description: string;
	icon: string;
	enabled: boolean;
	provider?: string;
}

/**
 * 把 `IToolDefinition` 适配成 UI 用的 `ToolDefinitionUI`
 */
function categorize(category: string | undefined): 'builtin' | 'custom' {
	if (!category) { return 'builtin'; }
	if (category === 'utility' || category === 'filesystem' || category === 'web' || category === 'shell') { return 'builtin'; }
	return 'custom';
}

function categoryIcon(c: 'builtin' | 'custom'): string {
	if (c === 'custom') { return '🧩'; }
	switch (c) {
		case 'builtin':
		default: return '🔧';
	}
}

/**
 * Tools View - 内置工具管理面板
 * 功能：
 * 1. 显示所有内置工具（包括已禁用的）
 * 2. 每个工具旁边有启用/禁用开关
 * 3. 按类别过滤（All / Built-in / Custom）
 */
export class ToolsViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private tools: ToolDefinitionUI[] = [];
	private activeTab = 'all';
	private retryCount = 0;
	private readonly maxRetries = 10;

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
		title.textContent = '🔧 Built-in Tools';
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

	/**
	 * 从 IAgentOSService 重新加载工具列表（包括已禁用的）
	 */
	private async _reload(): Promise<void> {
		const next: ToolDefinitionUI[] = [];

		try {
			console.log('[ToolsView] _reload: calling listAllToolsWithState...');
			// 使用 listAllToolsWithState() 获取所有工具及其启用状态
			const toolsWithState = await this.agentOSService.listAllToolsWithState('viewer');
			console.log(`[ToolsView] _reload: listAllToolsWithState returned ${toolsWithState.length} tools`);

			for (const tool of toolsWithState) {
				const cat = categorize(tool.category);
				next.push({
					id: tool.name,
					name: tool.name,
					category: cat,
					description: tool.description ?? '',
					icon: categoryIcon(cat),
					enabled: tool.enabled ?? true,
					provider: (tool as IToolDefinition).source ?? 'unknown',
				});
			}

			// 如果返回空且未超过最大重试次数，则延迟重试（provider 可能尚未注册）
			if (next.length === 0 && this.retryCount < this.maxRetries) {
				this.retryCount++;
				console.log(`[ToolsView] _reload: empty result, retry ${this.retryCount}/${this.maxRetries}`);
				setTimeout(() => { void this._reload(); }, 2000);
				return;
			}

			// 成功获取到工具后重置重试计数
			if (next.length > 0) {
				this.retryCount = 0;
			}
		} catch (err) {
			console.error('[ToolsView] _reload: Failed to load tools:', err);
			// provider 未就绪时延迟重试
			if (this.retryCount < this.maxRetries) {
				this.retryCount++;
				console.log(`[ToolsView] _reload: error, retry ${this.retryCount}/${this.maxRetries}`);
				setTimeout(() => { void this._reload(); }, 2000);
				return;
			}
		}

		console.log(`[ToolsView] _reload: setting this.tools to ${next.length} tools, rendering`);
		this.tools = next;
		this._renderTools();
	}

	/**
	 * 渲染工具列表
	 */
	private _renderTools(): void {
		this.listContainer.innerHTML = '';
		const filtered = this.activeTab === 'all'
			? this.tools
			: this.tools.filter(t => t.category === this.activeTab);

		if (filtered.length === 0) {
			const empty = $('div.tools-empty');
			empty.innerHTML = '<p>No tools available. Try refreshing to see built-in tools.</p>';
			this.listContainer.appendChild(empty);
			return;
		}

		for (const tool of filtered) {
			const item = $('div.tool-item');
			item.classList.toggle('tool-enabled', tool.enabled);

			// 启用/禁用开关
			const toggleContainer = $('div.tool-toggle');
			const toggle = $('input.tool-toggle-input') as HTMLInputElement;
			toggle.type = 'checkbox';
			toggle.checked = tool.enabled;
			toggle.title = tool.enabled ? 'Disable this tool' : 'Enable this tool';
			toggle.onchange = async () => {
				try {
					if (toggle.checked) {
						await this.agentOSService.enableTool('viewer', tool.id);
					} else {
						await this.agentOSService.disableTool('viewer', tool.id);
					}
					// 更新本地状态
					tool.enabled = toggle.checked;
					item.classList.toggle('tool-enabled', tool.enabled);
				} catch (err) {
					console.error('[ToolsView] Failed to toggle tool:', err);
					// 回滚 UI 状态
					toggle.checked = !toggle.checked;
				}
			};
			toggleContainer.appendChild(toggle);
			item.appendChild(toggleContainer);

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
