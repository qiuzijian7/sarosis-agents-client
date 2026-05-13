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
import { IAgentStudioService } from '../../common/agentStudio.js';
import { IWorkspaceRegistry, IWorkspaceConfig } from '../../common/agentWorkspace.js';
import { $ } from '../../../../../base/browser/dom.js';
import type { Workspace } from '../../common/types.js';

/**
 * Workspace View - 工作区资源管理器
 *
 * 功能：
 *  - 当前活跃工作区概览（名称、路径、Agent 数、连接数）
 *  - 工作区列表（搜索/筛选、创建、切换、删除）
 *  - 工作区详情面板（选中后展示 Agent 列表 + 连接图）
 *  - 快捷操作按钮（新建工作区、打开工作区路径、刷新）
 */
export class WorkspaceViewPane extends ViewPane {

	private headerEl!: HTMLElement;
	private overviewEl!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private listContainer!: HTMLElement;
	private detailEl!: HTMLElement;

	private workspaces: Workspace[] = [];
	private registryWorkspaces: IWorkspaceConfig[] = [];
	private selectedWorkspace: Workspace | undefined;
	private activeFilter: 'all' | 'active' | 'inactive' = 'all';

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
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IWorkspaceRegistry private readonly workspaceRegistry: IWorkspaceRegistry,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('workspace-view');
		// Inline fallback for layout — ensures content is visible even if CSS fails to load
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.height = '100%';
		container.style.overflowY = 'auto';

		// ─── Header ───────────────────────────────────────────────────
		this.headerEl = $('div.workspace-header');
		const title = $('h3.workspace-title');
		title.textContent = 'Workspace';
		this.headerEl.appendChild(title);

		const headerActions = $('div.workspace-header-actions');
		const newBtn = $('button.workspace-action-btn.primary');
		newBtn.textContent = '+ New';
		newBtn.title = 'Create a new workspace';
		newBtn.onclick = () => this._createWorkspace();
		headerActions.appendChild(newBtn);

		const refreshBtn = $('button.workspace-action-btn');
		refreshBtn.textContent = '↻';
		refreshBtn.title = 'Refresh workspaces';
		refreshBtn.onclick = () => this._loadWorkspaces();
		headerActions.appendChild(refreshBtn);

		this.headerEl.appendChild(headerActions);
		container.appendChild(this.headerEl);

		// ─── Active Workspace Overview ─────────────────────────────────
		this.overviewEl = $('div.workspace-overview');
		this._renderOverview();
		container.appendChild(this.overviewEl);

		// ─── Filters ──────────────────────────────────────────────────
		const filtersEl = $('div.workspace-filters');
		const filterOptions: Array<{ label: string; value: 'all' | 'active' | 'inactive' }> = [
			{ label: 'All', value: 'all' },
			{ label: 'Active', value: 'active' },
			{ label: 'Inactive', value: 'inactive' },
		];
		for (const opt of filterOptions) {
			const btn = $('button.workspace-filter-btn');
			btn.textContent = opt.label;
			if (opt.value === 'all') { btn.classList.add('active'); }
			btn.onclick = () => {
				filtersEl.querySelectorAll('.workspace-filter-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeFilter = opt.value;
				this._renderWorkspaces();
			};
			filtersEl.appendChild(btn);
		}
		container.appendChild(filtersEl);

		// ─── Search ───────────────────────────────────────────────────
		this.searchInput = document.createElement('input');
		this.searchInput.className = 'workspace-search';
		this.searchInput.type = 'text';
		this.searchInput.placeholder = 'Filter workspaces...';
		this.searchInput.oninput = () => this._renderWorkspaces();
		container.appendChild(this.searchInput);

		// ─── Workspace List ───────────────────────────────────────────
		this.listContainer = $('div.workspace-list');
		container.appendChild(this.listContainer);

		// ─── Detail Panel ─────────────────────────────────────────────
		this.detailEl = $('div.workspace-detail');
		this.detailEl.style.display = 'none';
		container.appendChild(this.detailEl);

		// ─── Load & Subscribe ─────────────────────────────────────────
		try {
			this._loadWorkspaces();
		} catch (err) {
			this.listContainer.innerHTML = '<div class="workspace-error">Failed to load workspaces</div>';
		}
		try {
			this._register(this.agentStudioService.onDidChangeWorkspace(() => this._loadWorkspaces()));
		} catch { /* service may not be ready */ }
		try {
			this._register(this.workspaceRegistry.onDidChangeWorkspaces(() => this._syncRegistryWorkspaces()));
		} catch { /* service may not be ready */ }
	}

	// ─── Data Loading ────────────────────────────────────────────────────

	private async _loadWorkspaces(): Promise<void> {
		try {
			this.workspaces = await this.agentStudioService.getWorkspaces();
			this._syncRegistryWorkspaces();
			this._renderOverview();
			this._renderWorkspaces();
		} catch {
			this.listContainer.innerHTML = '<div class="workspace-error">Failed to load workspaces</div>';
		}
	}

	private _syncRegistryWorkspaces(): void {
		this.registryWorkspaces = this.workspaceRegistry.getWorkspaces();
	}

	// ─── Active Workspace Overview ───────────────────────────────────────

	private _renderOverview(): void {
		this.overviewEl.innerHTML = '';
		const active = this.registryWorkspaces.find(w => w.isActive);
		if (!active) {
			const empty = $('div.workspace-overview-empty');
			empty.textContent = 'No active workspace';
			this.overviewEl.appendChild(empty);
			return;
		}

		// Find matching data workspace
		const ws = this.workspaces.find(w => w.id === active.id);
		const agentCount = ws?.employees.length ?? 0;
		const connCount = ws?.connections.length ?? 0;

		const icon = $('span.workspace-overview-icon');
		icon.textContent = '📂';
		this.overviewEl.appendChild(icon);

		const info = $('div.workspace-overview-info');
		const nameEl = $('div.workspace-overview-name');
		nameEl.textContent = active.name;
		info.appendChild(nameEl);

		if (active.path) {
			const pathEl = $('div.workspace-overview-path');
			pathEl.textContent = active.path;
			pathEl.title = active.path;
			info.appendChild(pathEl);
		}

		const statsEl = $('div.workspace-overview-stats');
		statsEl.innerHTML = `
			<span class="ws-stat"><span class="ws-stat-icon">🤖</span> ${agentCount} agents</span>
			<span class="ws-stat-divider">·</span>
			<span class="ws-stat"><span class="ws-stat-icon">🔗</span> ${connCount} connections</span>
		`;
		info.appendChild(statsEl);
		this.overviewEl.appendChild(info);
	}

	// ─── Workspace List Rendering ────────────────────────────────────────

	private _renderWorkspaces(): void {
		this.listContainer.innerHTML = '';
		const query = this.searchInput.value.toLowerCase();
		let filtered = this.workspaces;

		// Text filter
		if (query) {
			filtered = filtered.filter(ws =>
				ws.name.toLowerCase().includes(query) ||
				ws.description?.toLowerCase().includes(query)
			);
		}

		// Status filter
		if (this.activeFilter === 'active') {
			const activeIds = new Set(this.registryWorkspaces.filter(w => w.isActive).map(w => w.id));
			filtered = filtered.filter(ws => activeIds.has(ws.id));
		} else if (this.activeFilter === 'inactive') {
			const activeIds = new Set(this.registryWorkspaces.filter(w => w.isActive).map(w => w.id));
			filtered = filtered.filter(ws => !activeIds.has(ws.id));
		}

		if (filtered.length === 0) {
			const empty = $('div.workspace-empty');
			empty.innerHTML = `
				<div class="empty-icon">📁</div>
				<p>${query ? 'No matching workspaces' : 'No workspaces yet'}</p>
				<p class="empty-hint">${query ? 'Try a different search term' : 'Create a workspace to organize your agents and tasks'}</p>
			`;
			this.listContainer.appendChild(empty);
			return;
		}

		for (const ws of filtered) {
			const isActive = this.registryWorkspaces.some(rw => rw.id === ws.id && rw.isActive);
			const item = $('div.workspace-item');
			if (isActive) { item.classList.add('active-workspace'); }
			if (this.selectedWorkspace?.id === ws.id) { item.classList.add('selected'); }
			item.dataset.id = ws.id;

			const icon = $('span.workspace-icon');
			icon.textContent = isActive ? '🟢' : '📂';
			item.appendChild(icon);

			const info = $('div.workspace-info');
			const nameRow = $('div.workspace-name-row');
			const name = $('span.workspace-name');
			name.textContent = ws.name;
			nameRow.appendChild(name);

			if (isActive) {
				const badge = $('span.workspace-active-badge');
				badge.textContent = 'ACTIVE';
				nameRow.appendChild(badge);
			}
			info.appendChild(nameRow);

			const meta = $('div.workspace-meta');
			meta.textContent = `${ws.employees.length} agents · ${ws.connections.length} connections`;
			info.appendChild(meta);

			if (ws.description) {
				const desc = $('div.workspace-desc');
				desc.textContent = ws.description;
				info.appendChild(desc);
			}

			item.appendChild(info);

			const actions = $('div.workspace-item-actions');
			const editBtn = $('button.ws-action');
			editBtn.textContent = '✏️';
			editBtn.title = 'Edit workspace';
			editBtn.onclick = (e) => { e.stopPropagation(); this._editWorkspace(ws); };
			actions.appendChild(editBtn);

			const deleteBtn = $('button.ws-action.ws-action-danger');
			deleteBtn.textContent = '🗑️';
			deleteBtn.title = 'Delete workspace';
			deleteBtn.onclick = (e) => { e.stopPropagation(); this._deleteWorkspace(ws.id); };
			actions.appendChild(deleteBtn);
			item.appendChild(actions);

			item.onclick = () => this._selectWorkspace(ws);
			this.listContainer.appendChild(item);
		}
	}

	// ─── Detail Panel ────────────────────────────────────────────────────

	private _selectWorkspace(ws: Workspace): void {
		if (this.selectedWorkspace?.id === ws.id) {
			// Deselect
			this.selectedWorkspace = undefined;
			this.detailEl.style.display = 'none';
			this._renderWorkspaces();
			return;
		}

		this.selectedWorkspace = ws;
		this._renderWorkspaces();
		this._renderDetail(ws);
		this.detailEl.style.display = '';
	}

	private _renderDetail(ws: Workspace): void {
		this.detailEl.innerHTML = '';

		// Header
		const header = $('div.workspace-detail-header');
		const name = $('span.workspace-detail-name');
		name.textContent = ws.name;
		header.appendChild(name);

		const closeBtn = $('button.workspace-detail-close');
		closeBtn.textContent = '✕';
		closeBtn.title = 'Close detail';
		closeBtn.onclick = () => {
			this.selectedWorkspace = undefined;
			this.detailEl.style.display = 'none';
			this._renderWorkspaces();
		};
		header.appendChild(closeBtn);
		this.detailEl.appendChild(header);

		// Description
		if (ws.description) {
			const desc = $('div.workspace-detail-desc');
			desc.textContent = ws.description;
			this.detailEl.appendChild(desc);
		}

		// Path
		if (ws.path) {
			const pathEl = $('div.workspace-detail-path');
			pathEl.innerHTML = `<span class="detail-label">Path:</span> <span class="detail-value">${ws.path}</span>`;
			this.detailEl.appendChild(pathEl);
		}

		// Timestamps
		const timestamps = $('div.workspace-detail-timestamps');
		timestamps.innerHTML = `
			<span>Created: ${new Date(ws.createdAt).toLocaleDateString()}</span>
			<span>Updated: ${new Date(ws.updatedAt).toLocaleDateString()}</span>
		`;
		this.detailEl.appendChild(timestamps);

		// Actions
		const actionsEl = $('div.workspace-detail-actions');
		const switchBtn = <HTMLButtonElement>$('button.workspace-detail-action.primary');
		const isActive = this.registryWorkspaces.some(rw => rw.id === ws.id && rw.isActive);
		switchBtn.textContent = isActive ? 'Current Workspace' : 'Switch to Workspace';
		switchBtn.disabled = isActive;
		switchBtn.onclick = () => this._openWorkspace(ws);
		actionsEl.appendChild(switchBtn);
		this.detailEl.appendChild(actionsEl);

		// Agents section
		const agentsSection = $('div.workspace-detail-section');
		const agentsHeader = $('div.workspace-detail-section-header');
		agentsHeader.textContent = `Agents (${ws.employees.length})`;
		agentsSection.appendChild(agentsHeader);

		if (ws.employees.length === 0) {
			const empty = $('div.workspace-detail-empty');
			empty.textContent = 'No agents in this workspace';
			agentsSection.appendChild(empty);
		} else {
			const agentsList = $('div.workspace-detail-agents');
			for (const empId of ws.employees) {
				const agentItem = $('div.workspace-detail-agent');
				agentItem.innerHTML = `
					<span class="agent-dot"></span>
					<span class="agent-id">${empId}</span>
				`;
				agentsList.appendChild(agentItem);
			}
			agentsSection.appendChild(agentsList);
		}
		this.detailEl.appendChild(agentsSection);

		// Connections section
		const connSection = $('div.workspace-detail-section');
		const connHeader = $('div.workspace-detail-section-header');
		connHeader.textContent = `Connections (${ws.connections.length})`;
		connSection.appendChild(connHeader);

		if (ws.connections.length === 0) {
			const empty = $('div.workspace-detail-empty');
			empty.textContent = 'No connections in this workspace';
			connSection.appendChild(empty);
		} else {
			const connList = $('div.workspace-detail-connections');
			for (const conn of ws.connections) {
				const connItem = $('div.workspace-detail-connection');
				connItem.innerHTML = `
					<span class="conn-source">${conn.sourceId}</span>
					<span class="conn-arrow">→</span>
					<span class="conn-type">${conn.type}</span>
					<span class="conn-arrow">→</span>
					<span class="conn-target">${conn.targetId}</span>
				`;
				if (conn.label) {
					const label = $('span.conn-label');
					label.textContent = conn.label;
					connItem.appendChild(label);
				}
				connList.appendChild(connItem);
			}
			connSection.appendChild(connList);
		}
		this.detailEl.appendChild(connSection);
	}

	// ─── Actions ─────────────────────────────────────────────────────────

	private async _createWorkspace(): Promise<void> {
		const name = `Workspace ${this.workspaces.length + 1}`;
		try {
			await this.agentStudioService.createWorkspace({
				name,
				description: '',
				employees: [],
				connections: [],
			});
			await this._loadWorkspaces();
		} catch {
			// handle error
		}
	}

	private _editWorkspace(_ws: Workspace): void {
		// TODO: Open workspace edit dialog
	}

	private async _deleteWorkspace(id: string): Promise<void> {
		try {
			await this.agentStudioService.deleteWorkspace(id);
			if (this.selectedWorkspace?.id === id) {
				this.selectedWorkspace = undefined;
				this.detailEl.style.display = 'none';
			}
			await this._loadWorkspaces();
		} catch {
			// handle error
		}
	}

	private _openWorkspace(_ws: Workspace): void {
		// TODO: Switch active workspace context via WorkspaceRegistry
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			// Account for header, overview, filters, search, and detail panel
			const reserved = 260 + (this.detailEl.style.display !== 'none' ? 200 : 0);
			this.listContainer.style.maxHeight = `${Math.max(100, height - reserved)}px`;
		}
	}
}
