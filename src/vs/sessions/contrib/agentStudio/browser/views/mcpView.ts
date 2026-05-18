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
import { BUNDLED_MCP_PRESETS, IMcpServerPreset } from '../../common/bundled-tools/bundledMcpPresets.js';

interface McpServerUI {
	id: string;
	name: string;
	status: 'connected' | 'disconnected' | 'error';
	toolCount: number;
}

interface McpToolUI {
	id: string;
	name: string;
	description: string;
	serverId: string;
	serverName: string;
	enabled: boolean;
}

/**
 * MCP View - 管理 MCP 服务器和工具
 * 功能：
 * 1. 显示已连接的 MCP 服务器列表
 * 2. 显示每个服务器提供的工具
 * 3. 为每个工具提供启用/禁用开关
 * 4. 添加/移除 MCP 服务器
 */
export class McpViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private servers: McpServerUI[] = [];
	private tools: McpToolUI[] = [];
	private activeTab = 'servers'; // 'servers' | 'tools'

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
		container.classList.add('mcp-view');

		// Header
		const header = $('div.mcp-header');
		const title = $('h3.mcp-title');
		title.textContent = '🔌 MCP Servers';
		header.appendChild(title);

		const addBtn = $('button.mcp-add-btn');
		addBtn.textContent = '+ Add Server';
		addBtn.title = 'Add a new MCP server';
		addBtn.onclick = () => { void this._addServer(); };
		header.appendChild(addBtn);
		container.appendChild(header);

		// Tabs
		const tabs = $('div.mcp-tabs');
		const tabDefs = [
			{ id: 'servers', label: 'Servers' },
			{ id: 'tools', label: 'Tools' },
		];
		for (const tab of tabDefs) {
			const btn = $('button.mcp-tab');
			btn.textContent = tab.label;
			if (tab.id === 'servers') { btn.classList.add('active'); }
			btn.onclick = () => {
				tabs.querySelectorAll('.mcp-tab').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeTab = tab.id;
				this._renderContent();
			};
			tabs.appendChild(btn);
		}
		container.appendChild(tabs);

		// Content list
		this.listContainer = $('div.mcp-list');
		container.appendChild(this.listContainer);
		void this._reload();
	}

	/**
	 * 重新加载 MCP 服务器和工具
	 */
	private async _reload(): Promise<void> {
		try {
			// 从 McpToolProvider 获取 MCP 工具
			const toolsWithState = await this.agentOSService.listAllToolsWithState('viewer');
			
			// 过滤出 MCP 工具（source 包含 'mcp'）
			const mcpTools = toolsWithState.filter(t => 
				t.source?.includes?.('mcp') || t.category === 'mcp'
			);

			// 按服务器分组
			const serverMap = new Map<string, McpServerUI>();
			const toolList: McpToolUI[] = [];

			for (const tool of mcpTools) {
				const serverId = (tool as any).serverId ?? 'unknown';
				const serverName = (tool as any).serverName ?? 'Unknown Server';
				
				if (!serverMap.has(serverId)) {
					serverMap.set(serverId, {
						id: serverId,
						name: serverName,
						status: 'connected',
						toolCount: 0,
					});
				}
				serverMap.get(serverId)!.toolCount++;

				toolList.push({
					id: tool.name,
					name: tool.name,
					description: tool.description ?? '',
					serverId,
					serverName,
					enabled: tool.enabled ?? true,
				});
			}

			this.servers = Array.from(serverMap.values());
			this.tools = toolList;
		} catch (err) {
			console.warn('[McpView] Failed to load MCP data:', err);
		}

		this._renderContent();
	}

	/**
	 * 渲染当前 tab 的内容
	 */
	private _renderContent(): void {
		this.listContainer.innerHTML = '';
		
		if (this.activeTab === 'servers') {
			this._renderServers();
		} else {
			this._renderTools();
		}
	}

	/**
	 * 渲染服务器列表
	 */
	private _renderServers(): void {
		if (this.servers.length === 0) {
			const empty = $('div.mcp-empty');
			empty.innerHTML = '<p>No MCP servers configured. Click "+ Add Server" to add one.</p>';
			this.listContainer.appendChild(empty);
			return;
		}

		for (const server of this.servers) {
			const item = $('div.mcp-server-item');
			
			// 状态指示器
			const statusDot = $('span.mcp-status-dot');
			statusDot.classList.add(`status-${server.status}`);
			item.appendChild(statusDot);

			// 服务器信息
			const info = $('div.mcp-server-info');
			const nameEl = $('div.mcp-server-name');
			nameEl.textContent = server.name;
			info.appendChild(nameEl);

			const toolCountEl = $('div.mcp-server-tools');
			toolCountEl.textContent = `${server.toolCount} tool${server.toolCount !== 1 ? 's' : ''}`;
			info.appendChild(toolCountEl);
			item.appendChild(info);

			// 操作按钮
			const actions = $('div.mcp-server-actions');
			
			const removeBtn = $('button.mcp-remove-btn');
			removeBtn.textContent = '✕';
			removeBtn.title = 'Remove server';
			removeBtn.onclick = () => { void this._removeServer(server.id); };
			actions.appendChild(removeBtn);
			item.appendChild(actions);

			this.listContainer.appendChild(item);
		}
	}

	/**
	 * 渲染工具列表
	 */
	private _renderTools(): void {
		if (this.tools.length === 0) {
			const empty = $('div.mcp-empty');
			empty.innerHTML = '<p>No MCP tools available. Add an MCP server to see tools.</p>';
			this.listContainer.appendChild(empty);
			return;
		}

		for (const tool of this.tools) {
			const item = $('div.mcp-tool-item');
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
					tool.enabled = toggle.checked;
					item.classList.toggle('tool-enabled', tool.enabled);
				} catch (err) {
					console.error('[McpView] Failed to toggle tool:', err);
					toggle.checked = !toggle.checked;
				}
			};
			toggleContainer.appendChild(toggle);
			item.appendChild(toggleContainer);

			// 工具信息
			const info = $('div.mcp-tool-info');
			const nameEl = $('div.mcp-tool-name');
			nameEl.textContent = tool.name;
			info.appendChild(nameEl);

			const descEl = $('div.mcp-tool-desc');
			descEl.textContent = tool.description;
			info.appendChild(descEl);

			const serverBadge = $('span.mcp-tool-server');
			serverBadge.textContent = tool.serverName;
			info.appendChild(serverBadge);
			item.appendChild(info);

			this.listContainer.appendChild(item);
		}
	}

	/**
	 * 添加 MCP 服务器 — 显示预置模板选择 + 自定义输入
	 */
	private async _addServer(): Promise<void> {
		// 清空当前内容，渲染添加界面
		this.listContainer.innerHTML = '';

		const addPanel = $('div.mcp-add-panel');

		// ── 标题 ────────────────────────────────────────────────────
		const header = $('div.mcp-add-header');
		const title = $('h4');
		title.textContent = 'Add MCP Server';
		header.appendChild(title);

		const backBtn = $('button.mcp-back-btn');
		backBtn.textContent = '← Back';
		backBtn.onclick = () => { this._renderContent(); };
		header.appendChild(backBtn);
		addPanel.appendChild(header);

		// ── 预置模板 ──────────────────────────────────────────────
		const presetSection = $('div.mcp-preset-section');
		const presetTitle = $('div.mcp-section-title');
		presetTitle.textContent = 'Quick Add from Presets';
		presetSection.appendChild(presetTitle);

		const presetGrid = $('div.mcp-preset-grid');
		for (const preset of BUNDLED_MCP_PRESETS) {
			const card = $('div.mcp-preset-card');
			card.onclick = () => { void this._addFromPreset(preset); };

			const nameEl = $('div.mcp-preset-name');
			nameEl.textContent = preset.name;
			card.appendChild(nameEl);

			const descEl = $('div.mcp-preset-desc');
			descEl.textContent = preset.description;
			card.appendChild(descEl);

			const transportEl = $('div.mcp-preset-transport');
			transportEl.textContent = preset.transportType === 'http' ? '🌐 HTTP' : '💻 stdio';
			card.appendChild(transportEl);

			if (preset.envKeys && preset.envKeys.length > 0) {
				const envEl = $('div.mcp-preset-env');
				envEl.textContent = `Requires: ${preset.envKeys.join(', ')}`;
				card.appendChild(envEl);
			}

			presetGrid.appendChild(card);
		}
		presetSection.appendChild(presetGrid);
		addPanel.appendChild(presetSection);

		// ── 自定义添加 ──────────────────────────────────────────────
		const customSection = $('div.mcp-custom-section');
		const customTitle = $('div.mcp-section-title');
		customTitle.textContent = 'Custom Server';
		customSection.appendChild(customTitle);

		const nameInput = $('input.mcp-input') as HTMLInputElement;
		nameInput.placeholder = 'Server name (e.g., my-api)';
		nameInput.type = 'text';
		customSection.appendChild(nameInput);

		const commandInput = $('input.mcp-input') as HTMLInputElement;
		commandInput.placeholder = 'Command (e.g., npx) or URL (https://...)';
		commandInput.type = 'text';
		customSection.appendChild(commandInput);

		const argsInput = $('input.mcp-input') as HTMLInputElement;
		argsInput.placeholder = 'Arguments (space-separated, optional)';
		argsInput.type = 'text';
		customSection.appendChild(argsInput);

		const addCustomBtn = $('button.mcp-add-custom-btn');
		addCustomBtn.textContent = 'Add Custom Server';
		addCustomBtn.onclick = () => {
			const name = nameInput.value.trim();
			const cmd = commandInput.value.trim();
			if (!name || !cmd) { return; }
			// TODO: 实际添加 MCP 服务器到 VS Code 的 MCP 配置
			console.log('[McpView] Add custom server:', { name, command: cmd, args: argsInput.value });
			void this._reload();
		};
		customSection.appendChild(addCustomBtn);
		addPanel.appendChild(customSection);

		this.listContainer.appendChild(addPanel);
	}

	/**
	 * 从预置模板添加 MCP 服务器
	 */
	private async _addFromPreset(preset: IMcpServerPreset): Promise<void> {
		// TODO: 实际添加 MCP 服务器到 VS Code 的 MCP 配置
		// 这需要调用 VS Code 的 MCP 服务 API
		console.log('[McpView] Add from preset:', preset.id, preset.name);
		// 将来实现：写入 settings.json 中的 mcp.servers 配置
		void this._reload();
	}

	/**
	 * 移除 MCP 服务器
	 */
	private async _removeServer(serverId: string): Promise<void> {
		// TODO: 调用 MCP 服务移除服务器
		console.log('[McpView] Removing server:', serverId);
		await this._reload();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 110}px`;
		}
	}
}
