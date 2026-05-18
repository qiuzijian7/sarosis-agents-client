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
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IAgentTaskBoardService, IAgentStudioService } from '../../common/agentStudio.js';
import { $ } from '../../../../../base/browser/dom.js';
import { TaskBoardStatus, type TaskBoardRecord, type Workspace } from '../../common/types.js';
import { TaskOverviewEditorInput } from '../taskOverviewEditorInput.js';
import { TaskDetailEditorInput } from '../taskDetailEditorInput.js';

/**
 * Tasks View - 任务管理面板 (ActivityBar Sidebar)
 *
 * 特性：
 * - 垂直方向完全铺满
 * - 顶部搜索框
 * - Workspace/All 过滤切换
 * - Overview 按钮（打开看板 EditorPane）
 * - 任务列表（点击打开详情 EditorPane）
 */
export class TasksViewPane extends ViewPane {

	private _root!: HTMLElement;
	private _searchInput!: HTMLInputElement;
	private _listContainer!: HTMLElement;
	private _wsSelector!: HTMLSelectElement;
	private _tasks: TaskBoardRecord[] = [];
	private _workspaces: Workspace[] = [];
	private _searchQuery = '';
	private _selectedWorkspaceId: string | undefined; // undefined = All
	private _statusFilter: TaskBoardStatus | 'all' = 'all';

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
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._root = $('div.tasks-view-root');
		container.appendChild(this._root);

		// ─── Toolbar: Overview + Workspace selector ──────────────────
		const toolbar = $('div.tasks-toolbar');

		const overviewBtn = $('button.tasks-overview-btn');
		overviewBtn.textContent = '📋 Overview';
		overviewBtn.title = '打开任务看板总览 (EditorPane)';
		overviewBtn.onclick = () => this._openOverview();
		toolbar.appendChild(overviewBtn);

		// Workspace selector dropdown
		this._wsSelector = document.createElement('select');
		this._wsSelector.className = 'tasks-ws-selector';
		this._wsSelector.onchange = () => {
			this._selectedWorkspaceId = this._wsSelector.value || undefined;
			this._loadTasks();
		};
		toolbar.appendChild(this._wsSelector);

		this._root.appendChild(toolbar);

		// Load workspaces for the selector
		this._loadWorkspaces();

		// ─── Search bar ───────────────────────────────────────────
		const searchWrap = $('div.tasks-search');
		const searchIcon = $('span.tasks-search-icon');
		searchIcon.textContent = '🔍';
		searchWrap.appendChild(searchIcon);

		this._searchInput = document.createElement('input');
		this._searchInput.type = 'text';
		this._searchInput.placeholder = '搜索任务...';
		this._searchInput.className = 'tasks-search-input';
		this._searchInput.oninput = () => { this._searchQuery = this._searchInput.value; this._renderTasks(); };
		searchWrap.appendChild(this._searchInput);
		this._root.appendChild(searchWrap);

		// ─── Status filters ───────────────────────────────────────
		const filters = $('div.tasks-status-filters');
		const statuses: Array<{ label: string; value: TaskBoardStatus | 'all'; icon: string }> = [
			{ label: 'All', value: 'all', icon: '📋' },
			{ label: 'Todo', value: TaskBoardStatus.Todo, icon: '⬜' },
			{ label: 'Running', value: TaskBoardStatus.Running, icon: '⚡' },
			{ label: 'Done', value: TaskBoardStatus.Done, icon: '✅' },
			{ label: 'Cancelled', value: TaskBoardStatus.Cancelled, icon: '❌' },
		];
		for (const s of statuses) {
			const btn = $('button.task-filter-chip');
			btn.textContent = `${s.icon} ${s.label}`;
			if (s.value === 'all') { btn.classList.add('active'); }
			btn.onclick = () => {
				filters.querySelectorAll('.task-filter-chip').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this._statusFilter = s.value;
				this._renderTasks();
			};
			filters.appendChild(btn);
		}
		this._root.appendChild(filters);

		// ─── Task list (fills remaining height) ───────────────────
		this._listContainer = $('div.tasks-list-scroll');
		this._root.appendChild(this._listContainer);

		// Load & subscribe
		this._loadTasks();
		this._register(this.taskBoardService.onDidChangeTaskBoard(() => this._loadTasks()));
	}

	private async _loadWorkspaces(): Promise<void> {
		try {
			this._workspaces = await this.agentStudioService.getWorkspaces();
			this._rebuildWorkspaceSelector();
		} catch { /* ignore */ }
	}

	private _rebuildWorkspaceSelector(): void {
		if (!this._wsSelector) { return; }
		this._wsSelector.innerHTML = '';

		const allOpt = document.createElement('option');
		allOpt.value = '';
		allOpt.textContent = '🌍 All Workspaces';
		this._wsSelector.appendChild(allOpt);

		for (const ws of this._workspaces) {
			const opt = document.createElement('option');
			opt.value = ws.id;
			opt.textContent = `🏠 ${ws.name}`;
			if (ws.id === this._selectedWorkspaceId) { opt.selected = true; }
			this._wsSelector.appendChild(opt);
		}
	}

	private async _loadTasks(): Promise<void> {
		try {
			this._tasks = await this.taskBoardService.getTasks(this._selectedWorkspaceId);
			this._renderTasks();
		} catch {
			this._listContainer.innerHTML = '<div class="tasks-empty">⚠️ Failed to load tasks</div>';
		}
	}

	private _getFilteredTasks(): TaskBoardRecord[] {
		let tasks = this._tasks;

		// Status filter
		if (this._statusFilter !== 'all') {
			tasks = tasks.filter(t => t.status === this._statusFilter);
		}

		// Search filter
		if (this._searchQuery) {
			const q = this._searchQuery.toLowerCase();
			tasks = tasks.filter(t =>
				t.title.toLowerCase().includes(q) ||
				(t.description || '').toLowerCase().includes(q) ||
				(t.assigneeName || '').toLowerCase().includes(q)
			);
		}

		return tasks;
	}

	private _renderTasks(): void {
		this._listContainer.replaceChildren();
		const tasks = this._getFilteredTasks();

		if (tasks.length === 0) {
			const empty = $('div.tasks-empty');
			empty.innerHTML = this._searchQuery ? '🔍 没有匹配的任务' : '📭 暂无任务';
			this._listContainer.appendChild(empty);
			return;
		}

		// Count header
		const countEl = $('div.tasks-count');
		countEl.textContent = `共 ${tasks.length} 个任务`;
		this._listContainer.appendChild(countEl);

		for (const task of tasks) {
			const item = $('div.task-list-item');
			item.classList.add(`status-${task.status}`);
			item.onclick = () => this._openTaskDetail(task);

			// Status dot
			const dot = $('span.task-dot');
			dot.textContent = this._getStatusIcon(task.status);
			item.appendChild(dot);

			// Content
			const content = $('div.task-item-content');

			const title = $('div.task-item-title');
			title.textContent = task.title;
			content.appendChild(title);

			const meta = $('div.task-item-meta');
			const parts: string[] = [];
			if (task.assigneeName) { parts.push(`🤖 ${task.assigneeName}`); }
			if (task.priority) { parts.push(`${task.priority}`); }
			parts.push(new Date(task.createdAt).toLocaleDateString('zh-CN'));
			meta.textContent = parts.join(' · ');
			content.appendChild(meta);

			item.appendChild(content);

			// Priority indicator
			if (task.priority === 'high') {
				const pri = $('span.task-priority-high');
				pri.textContent = '🔥';
				item.appendChild(pri);
			}

			this._listContainer.appendChild(item);
		}
	}

	private _getStatusIcon(status: TaskBoardStatus): string {
		switch (status) {
			case TaskBoardStatus.Todo: return '⬜';
			case TaskBoardStatus.Running: return '⚡';
			case TaskBoardStatus.Done: return '✅';
			case TaskBoardStatus.Cancelled: return '❌';
			case TaskBoardStatus.Archived: return '📦';
			default: return '⬜';
		}
	}

	// ─── EditorPane integration ───────────────────────────────────

	private _openOverview(): void {
		const input = TaskOverviewEditorInput.getOrCreate();
		this.editorService.openEditor(input, { pinned: true });
	}

	private _openTaskDetail(task: TaskBoardRecord): void {
		const input = TaskDetailEditorInput.getOrCreate(task.id, task.title);
		this.editorService.openEditor(input, { pinned: false });
	}

	// ─── Layout ───────────────────────────────────────────────────

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._root) {
			this._root.style.height = `${height}px`;
		}
	}
}
