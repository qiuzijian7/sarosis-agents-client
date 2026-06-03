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
import { IAgentTaskBoardService, IAgentStudioService, ITaskOrchestrationService } from '../../common/agentStudio.js';
import { $ } from '../../../../../base/browser/dom.js';
import { TaskBoardStatus, type TaskBoardRecord, type Workspace } from '../../common/types.js';
import { TaskOverviewEditorInput } from '../taskOverviewEditorInput.js';

/**
 * Tasks View - 任务管理面板 (ActivityBar Sidebar)
 *
 * 特性：
 * - 垂直方向完全铺满
 * - 顶部搜索框
 * - Workspace/All 过滤切换
 * - Overview 按钮（打开看板 EditorPane）
 * - 任务列表（点击打开看板总览并高亮对应任务卡片）
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
		@ITaskOrchestrationService private readonly taskOrchestrationService: ITaskOrchestrationService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._root = $('div.tasks-view-root');
		container.appendChild(this._root);

		// ─── Inject scoped styles ──────────────────────────────────
		const styleEl = document.createElement('style');
		styleEl.textContent = this._getScopedCSS();
		this._root.appendChild(styleEl);

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
			{ label: 'Triage', value: TaskBoardStatus.Triage, icon: '🗂' },
			{ label: 'Todo', value: TaskBoardStatus.Todo, icon: '⬜' },
			{ label: 'Ready', value: TaskBoardStatus.Ready, icon: '✔️' },
			{ label: 'Running', value: TaskBoardStatus.Running, icon: '⚡' },
			{ label: 'Blocked', value: TaskBoardStatus.Blocked, icon: '🚧' },
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
			item.onclick = () => this._openTaskInOverview(task);

			// Status indicator
			const statusWrap = $('div.task-item-status');
			const dot = $('span.task-dot');
			dot.textContent = this._getStatusIcon(task.status);
			statusWrap.appendChild(dot);
			item.appendChild(statusWrap);

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
			case TaskBoardStatus.Triage: return '🗂';
			case TaskBoardStatus.Todo: return '⬜';
			case TaskBoardStatus.Ready: return '✔️';
			case TaskBoardStatus.Running: return '⚡';
			case TaskBoardStatus.Blocked: return '🚧';
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

	/**
	 * Open the Task Overview (Kanban board) and highlight the clicked task.
	 * This replaces the old behavior of opening a separate TaskDetailEditorPane.
	 */
	private async _openTaskInOverview(task: TaskBoardRecord): Promise<void> {
		const input = TaskOverviewEditorInput.getOrCreate();
		// Open the overview editor in the editor area
		await this.editorService.openEditor(input, { pinned: false, preserveFocus: false });
		// Trigger highlight on the matching task card via task title
		this.taskOrchestrationService.focusTaskInBoard(task.title);
	}

	// ─── Scoped CSS ────────────────────────────────────────────────

	private _getScopedCSS(): string {
		return `
.tasks-view-root {
	display: flex;
	flex-direction: column;
	height: 100%;
	overflow: hidden;
	font-family: var(--vscode-font-family);
	font-size: 12px;
	color: var(--vscode-foreground);
	background: var(--vscode-sideBar-background);
}

/* Toolbar */
.tasks-toolbar {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 8px;
	border-bottom: 1px solid var(--vscode-sideBar-border);
}
.tasks-overview-btn {
	font-size: 11px;
	padding: 3px 8px;
	border-radius: 3px;
	border: 1px solid var(--vscode-button-border, transparent);
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	cursor: pointer;
	white-space: nowrap;
}
.tasks-overview-btn:hover {
	background: var(--vscode-button-secondaryHoverBackground);
}
.tasks-ws-selector {
	flex: 1;
	min-width: 0;
	font-size: 11px;
	padding: 2px 4px;
	border-radius: 3px;
	border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border));
	background: var(--vscode-dropdown-background, var(--vscode-input-background));
	color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
}

/* Search */
.tasks-search {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 8px;
	border-bottom: 1px solid var(--vscode-sideBar-border);
}
.tasks-search-icon {
	font-size: 12px;
	opacity: 0.6;
}
.tasks-search-input {
	flex: 1;
	min-width: 0;
	font-size: 11px;
	padding: 3px 6px;
	border-radius: 3px;
	border: 1px solid var(--vscode-input-border);
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	outline: none;
}
.tasks-search-input:focus {
	border-color: var(--vscode-focusBorder);
}

/* Status filters */
.tasks-status-filters {
	display: flex;
	flex-wrap: wrap;
	gap: 3px;
	padding: 4px 8px;
	border-bottom: 1px solid var(--vscode-sideBar-border);
}
.task-filter-chip {
	font-size: 10px;
	padding: 1px 6px;
	border-radius: 9px;
	border: 1px solid var(--vscode-input-border, transparent);
	background: transparent;
	color: var(--vscode-foreground);
	cursor: pointer;
	opacity: 0.7;
}
.task-filter-chip:hover {
	opacity: 1;
	background: var(--vscode-list-hoverBackground);
}
.task-filter-chip.active {
	opacity: 1;
	background: var(--vscode-button-secondaryBackground);
	border-color: var(--vscode-focusBorder);
}

/* Task list scroll */
.tasks-list-scroll {
	flex: 1;
	overflow-y: auto;
	overflow-x: hidden;
	padding: 2px 0;
}
.tasks-list-scroll::-webkit-scrollbar {
	width: 4px;
}
.tasks-list-scroll::-webkit-scrollbar-thumb {
	background: var(--vscode-scrollbarSlider-background);
	border-radius: 2px;
}

.tasks-count {
	font-size: 10px;
	color: var(--vscode-descriptionForeground);
	padding: 4px 10px 2px;
	opacity: 0.7;
}

.tasks-empty {
	text-align: center;
	padding: 24px 12px;
	color: var(--vscode-descriptionForeground);
	font-size: 12px;
}

/* Task list item — enhanced */
.task-list-item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	margin: 1px 4px;
	border-radius: 4px;
	cursor: pointer;
	transition: background 120ms ease, box-shadow 120ms ease, transform 80ms ease;
	border-left: 3px solid transparent;
}
.task-list-item:hover {
	background: var(--vscode-list-hoverBackground);
}
.task-list-item:active {
	transform: scale(0.985);
}

/* Status-based left border color */
.task-list-item.status-todo {
	border-left-color: #f59e0b;
}
.task-list-item.status-running {
	border-left-color: #3b82f6;
}
.task-list-item.status-done {
	border-left-color: #10b981;
}
.task-list-item.status-cancelled {
	border-left-color: #6b7280;
}
.task-list-item.status-archived {
	border-left-color: #8b5cf6;
}

/* Status indicator */
.task-item-status {
	flex-shrink: 0;
	width: 20px;
	text-align: center;
}
.task-dot {
	font-size: 12px;
}

/* Content area */
.task-item-content {
	flex: 1;
	min-width: 0;
	overflow: hidden;
}
.task-item-title {
	font-size: 12px;
	line-height: 1.35;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--vscode-foreground);
}
.task-item-meta {
	font-size: 10px;
	line-height: 1.3;
	margin-top: 1px;
	color: var(--vscode-descriptionForeground);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.task-priority-high {
	font-size: 12px;
	flex-shrink: 0;
}
`;
	}

	// ─── Layout ───────────────────────────────────────────────────

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._root) {
			this._root.style.height = `${height}px`;
		}
	}
}
