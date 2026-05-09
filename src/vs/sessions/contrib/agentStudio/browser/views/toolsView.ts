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

interface ToolDefinition {
	id: string;
	name: string;
	category: 'builtin' | 'mcp' | 'custom';
	description: string;
	icon: string;
	enabled: boolean;
	provider?: string;
}

const AVAILABLE_TOOLS: ToolDefinition[] = [
	{ id: 'read_file', name: 'Read File', category: 'builtin', description: 'Read contents of a file', icon: '📄', enabled: true },
	{ id: 'write_file', name: 'Write File', category: 'builtin', description: 'Create or overwrite a file', icon: '✏️', enabled: true },
	{ id: 'search_files', name: 'Search Files', category: 'builtin', description: 'Search for files by pattern', icon: '🔍', enabled: true },
	{ id: 'run_command', name: 'Run Command', category: 'builtin', description: 'Execute shell commands', icon: '⌨️', enabled: true },
	{ id: 'web_search', name: 'Web Search', category: 'builtin', description: 'Search the internet', icon: '🌐', enabled: true },
	{ id: 'web_fetch', name: 'Web Fetch', category: 'builtin', description: 'Fetch content from URLs', icon: '📡', enabled: true },
	{ id: 'git_operations', name: 'Git Operations', category: 'builtin', description: 'Git version control operations', icon: '🔀', enabled: true },
	{ id: 'mcp_filesystem', name: 'Filesystem MCP', category: 'mcp', description: 'File system access via MCP', icon: '💾', enabled: false, provider: 'filesystem-server' },
	{ id: 'mcp_github', name: 'GitHub MCP', category: 'mcp', description: 'GitHub API integration via MCP', icon: '🐙', enabled: false, provider: 'github-server' },
	{ id: 'mcp_database', name: 'Database MCP', category: 'mcp', description: 'Database operations via MCP', icon: '🗄️', enabled: false, provider: 'database-server' },
	{ id: 'mcp_browser', name: 'Browser MCP', category: 'mcp', description: 'Browser automation via MCP', icon: '🌍', enabled: false, provider: 'puppeteer-server' },
];

/**
 * Tools View - 工具管理面板
 * 功能：查看可用工具、MCP服务器管理、工具启用/禁用、自定义工具
 */
export class ToolsViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private tools: ToolDefinition[] = [...AVAILABLE_TOOLS];
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

		const addMcpBtn = $('button.tools-add-btn');
		addMcpBtn.textContent = '+ Add MCP';
		addMcpBtn.title = 'Connect a new MCP server';
		addMcpBtn.onclick = () => this._addMcpServer();
		header.appendChild(addMcpBtn);
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

		// MCP status
		const mcpStatus = $('div.mcp-status');
		mcpStatus.innerHTML = `<span class="mcp-dot connected"></span> MCP: 0 servers connected`;
		container.appendChild(mcpStatus);

		// Tools list
		this.listContainer = $('div.tools-list');
		this._renderTools();
		container.appendChild(this.listContainer);
	}

	private _renderTools(): void {
		this.listContainer.innerHTML = '';
		const filtered = this.activeTab === 'all'
			? this.tools
			: this.tools.filter(t => t.category === this.activeTab);

		if (filtered.length === 0) {
			const empty = $('div.tools-empty');
			empty.innerHTML = '<p>No tools in this category</p>';
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

			// Toggle
			const toggle = $('label.tool-toggle');
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = tool.enabled;
			checkbox.onchange = () => { tool.enabled = checkbox.checked; item.classList.toggle('tool-enabled', tool.enabled); };
			toggle.appendChild(checkbox);
			const slider = $('span.toggle-slider');
			toggle.appendChild(slider);
			item.appendChild(toggle);

			this.listContainer.appendChild(item);
		}
	}

	private _addMcpServer(): void {
		// TODO: Open MCP server connection dialog
		const newTool: ToolDefinition = {
			id: `mcp-custom-${Date.now()}`,
			name: 'New MCP Server',
			category: 'mcp',
			description: 'Custom MCP server tool',
			icon: '🔌',
			enabled: false,
			provider: 'custom-server',
		};
		this.tools.push(newTool);
		this._renderTools();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 110}px`;
		}
	}
}
