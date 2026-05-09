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
import { $ } from '../../../../../base/browser/dom.js';
import type { Workspace } from '../../common/types.js';

/**
 * Workspace View - 工作区资源管理器
 * 功能：工作区列表、文件树浏览、创建/切换工作区
 */
export class WorkspaceViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private workspaces: Workspace[] = [];

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('workspace-view');

		// Toolbar
		const toolbar = $('div.workspace-toolbar');
		const createBtn = $('button.workspace-action-btn');
		createBtn.textContent = '+ New Workspace';
		createBtn.title = 'Create a new workspace';
		createBtn.onclick = () => this._createWorkspace();
		toolbar.appendChild(createBtn);

		const refreshBtn = $('button.workspace-action-btn');
		refreshBtn.textContent = '↻';
		refreshBtn.title = 'Refresh workspaces';
		refreshBtn.onclick = () => this._loadWorkspaces();
		toolbar.appendChild(refreshBtn);
		container.appendChild(toolbar);

		// Search
		const searchInput = document.createElement('input');
		searchInput.className = 'workspace-search';
		searchInput.type = 'text';
		searchInput.placeholder = '🔍 Filter workspaces...';
		searchInput.oninput = () => this._filterWorkspaces(searchInput.value);
		container.appendChild(searchInput);

		// List
		this.listContainer = $('div.workspace-list');
		container.appendChild(this.listContainer);

		// Load data
		this._loadWorkspaces();

		// Subscribe to changes
		this._register(this.agentStudioService.onDidChangeWorkspace(() => this._loadWorkspaces()));
	}

	private async _loadWorkspaces(): Promise<void> {
		try {
			this.workspaces = await this.agentStudioService.getWorkspaces();
			this._renderWorkspaces(this.workspaces);
		} catch (err) {
			this.listContainer.innerHTML = `<div class="workspace-error">⚠️ Failed to load workspaces</div>`;
		}
	}

	private _renderWorkspaces(workspaces: Workspace[]): void {
		this.listContainer.innerHTML = '';

		if (workspaces.length === 0) {
			const empty = $('div.workspace-empty');
			empty.innerHTML = `
				<div class="empty-icon">📁</div>
				<p>No workspaces yet</p>
				<p class="empty-hint">Create a workspace to organize your agents and tasks</p>
			`;
			this.listContainer.appendChild(empty);
			return;
		}

		for (const ws of workspaces) {
			const item = $('div.workspace-item');
			item.dataset.id = ws.id;

			const icon = $('span.workspace-icon');
			icon.textContent = '📂';
			item.appendChild(icon);

			const info = $('div.workspace-info');
			const name = $('div.workspace-name');
			name.textContent = ws.name;
			info.appendChild(name);

			const meta = $('div.workspace-meta');
			meta.textContent = `${ws.employees.length} agents • ${ws.connections.length} connections`;
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

			const deleteBtn = $('button.ws-action');
			deleteBtn.textContent = '🗑️';
			deleteBtn.title = 'Delete workspace';
			deleteBtn.onclick = (e) => { e.stopPropagation(); this._deleteWorkspace(ws.id); };
			actions.appendChild(deleteBtn);
			item.appendChild(actions);

			item.onclick = () => this._openWorkspace(ws);
			this.listContainer.appendChild(item);
		}
	}

	private _filterWorkspaces(query: string): void {
		const filtered = this.workspaces.filter(ws =>
			ws.name.toLowerCase().includes(query.toLowerCase()) ||
			ws.description?.toLowerCase().includes(query.toLowerCase())
		);
		this._renderWorkspaces(filtered);
	}

	private async _createWorkspace(): Promise<void> {
		const name = `Workspace ${this.workspaces.length + 1}`;
		try {
			await this.agentStudioService.createWorkspace({ name, description: '', employees: [], connections: [] });
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
			await this._loadWorkspaces();
		} catch {
			// handle error
		}
	}

	private _openWorkspace(_ws: Workspace): void {
		// TODO: Switch active workspace context
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 80}px`;
		}
	}
}
