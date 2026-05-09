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
import { IAgentTaskBoardService } from '../../common/agentStudio.js';
import { $ } from '../../../../../base/browser/dom.js';
import { TaskBoardStatus, type TaskBoardRecord } from '../../common/types.js';

/**
 * Tasks View - 任务管理面板
 * 功能：任务列表、状态筛选、创建任务、看板视图切换
 */
export class TasksViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private tasks: TaskBoardRecord[] = [];
	private activeFilter: TaskBoardStatus | 'all' = 'all';
	private viewMode: 'list' | 'board' = 'list';

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('tasks-view');

		// Toolbar
		const toolbar = $('div.tasks-toolbar');

		const addBtn = $('button.tasks-action-btn');
		addBtn.textContent = '+ New Task';
		addBtn.onclick = () => this._createTask();
		toolbar.appendChild(addBtn);

		const viewToggle = $('div.tasks-view-toggle');
		const listBtn = $('button.view-mode-btn.active');
		listBtn.textContent = '☰';
		listBtn.title = 'List view';
		listBtn.onclick = () => { this.viewMode = 'list'; this._updateViewMode(viewToggle); this._renderTasks(); };
		viewToggle.appendChild(listBtn);

		const boardBtn = $('button.view-mode-btn');
		boardBtn.textContent = '▦';
		boardBtn.title = 'Board view';
		boardBtn.onclick = () => { this.viewMode = 'board'; this._updateViewMode(viewToggle); this._renderTasks(); };
		viewToggle.appendChild(boardBtn);
		toolbar.appendChild(viewToggle);
		container.appendChild(toolbar);

		// Status filters
		const filters = $('div.tasks-filters');
		const statuses: Array<{ label: string; value: TaskBoardStatus | 'all'; icon: string }> = [
			{ label: 'All', value: 'all', icon: '📋' },
			{ label: 'Todo', value: TaskBoardStatus.Todo, icon: '⬜' },
			{ label: 'Running', value: TaskBoardStatus.Running, icon: '🔄' },
			{ label: 'Done', value: TaskBoardStatus.Done, icon: '✅' },
			{ label: 'Cancelled', value: TaskBoardStatus.Cancelled, icon: '❌' },
		];
		for (const s of statuses) {
			const btn = $('button.task-filter-btn');
			btn.textContent = `${s.icon} ${s.label}`;
			if (s.value === 'all') { btn.classList.add('active'); }
			btn.onclick = () => {
				filters.querySelectorAll('.task-filter-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeFilter = s.value;
				this._renderTasks();
			};
			filters.appendChild(btn);
		}
		container.appendChild(filters);

		// Task list/board container
		this.listContainer = $('div.tasks-content');
		container.appendChild(this.listContainer);

		this._loadTasks();
		this._register(this.taskBoardService.onDidChangeTaskBoard(() => this._loadTasks()));
	}

	private _updateViewMode(toggle: HTMLElement): void {
		const btns = toggle.querySelectorAll('.view-mode-btn');
		btns.forEach((b, i) => {
			b.classList.toggle('active', (i === 0 && this.viewMode === 'list') || (i === 1 && this.viewMode === 'board'));
		});
	}

	private async _loadTasks(): Promise<void> {
		try {
			this.tasks = await this.taskBoardService.getTasks();
			this._renderTasks();
		} catch {
			this.listContainer.innerHTML = '<div class="tasks-error">⚠️ Failed to load tasks</div>';
		}
	}

	private _renderTasks(): void {
		const filtered = this.activeFilter === 'all'
			? this.tasks
			: this.tasks.filter(t => t.status === this.activeFilter);

		if (this.viewMode === 'list') {
			this._renderListView(filtered);
		} else {
			this._renderBoardView(filtered);
		}
	}

	private _renderListView(tasks: TaskBoardRecord[]): void {
		this.listContainer.innerHTML = '';
		this.listContainer.className = 'tasks-content tasks-list-view';

		if (tasks.length === 0) {
			const empty = $('div.tasks-empty');
			empty.innerHTML = '<p>No tasks found</p>';
			this.listContainer.appendChild(empty);
			return;
		}

		for (const task of tasks) {
			const item = $('div.task-item');
			item.classList.add(`task-${task.status}`);

			const statusIcon = $('span.task-status-icon');
			statusIcon.textContent = this._getStatusIcon(task.status);
			item.appendChild(statusIcon);

			const info = $('div.task-info');
			const titleEl = $('div.task-title');
			titleEl.textContent = task.title;
			info.appendChild(titleEl);

			if (task.description) {
				const descEl = $('div.task-desc');
				descEl.textContent = task.description;
				info.appendChild(descEl);
			}

			const metaEl = $('div.task-meta');
			const parts: string[] = [];
			if (task.assigneeName) { parts.push(`👤 ${task.assigneeName}`); }
			if (task.priority) { parts.push(`🔥 ${task.priority}`); }
			parts.push(`📅 ${new Date(task.createdAt).toLocaleDateString()}`);
			metaEl.textContent = parts.join(' • ');
			info.appendChild(metaEl);
			item.appendChild(info);

			const actions = $('div.task-actions');
			if (task.status === TaskBoardStatus.Todo) {
				const startBtn = $('button.task-action');
				startBtn.textContent = '▶';
				startBtn.title = 'Start task';
				startBtn.onclick = () => this._updateStatus(task.id, TaskBoardStatus.Running);
				actions.appendChild(startBtn);
			}
			if (task.status === TaskBoardStatus.Running) {
				const doneBtn = $('button.task-action');
				doneBtn.textContent = '✓';
				doneBtn.title = 'Complete task';
				doneBtn.onclick = () => this._updateStatus(task.id, TaskBoardStatus.Done);
				actions.appendChild(doneBtn);
			}
			const deleteBtn = $('button.task-action');
			deleteBtn.textContent = '🗑️';
			deleteBtn.onclick = () => this._deleteTask(task.id);
			actions.appendChild(deleteBtn);
			item.appendChild(actions);

			this.listContainer.appendChild(item);
		}
	}

	private _renderBoardView(_tasks: TaskBoardRecord[]): void {
		this.listContainer.innerHTML = '';
		this.listContainer.className = 'tasks-content tasks-board-view';

		const columns: Array<{ status: TaskBoardStatus; label: string; icon: string }> = [
			{ status: TaskBoardStatus.Todo, label: 'Todo', icon: '⬜' },
			{ status: TaskBoardStatus.Running, label: 'In Progress', icon: '🔄' },
			{ status: TaskBoardStatus.Done, label: 'Done', icon: '✅' },
		];

		for (const col of columns) {
			const column = $('div.board-column');
			const colHeader = $('div.board-column-header');
			colHeader.textContent = `${col.icon} ${col.label}`;
			const colTasks = this.tasks.filter(t => t.status === col.status);
			const countBadge = $('span.board-count');
			countBadge.textContent = ` (${colTasks.length})`;
			colHeader.appendChild(countBadge);
			column.appendChild(colHeader);

			const colBody = $('div.board-column-body');
			for (const task of colTasks) {
				const card = $('div.board-card');
				const cardTitle = $('div.board-card-title');
				cardTitle.textContent = task.title;
				card.appendChild(cardTitle);
				if (task.assigneeName) {
					const assignee = $('div.board-card-assignee');
					assignee.textContent = `👤 ${task.assigneeName}`;
					card.appendChild(assignee);
				}
				colBody.appendChild(card);
			}
			column.appendChild(colBody);
			this.listContainer.appendChild(column);
		}
	}

	private _getStatusIcon(status: TaskBoardStatus): string {
		switch (status) {
			case TaskBoardStatus.Todo: return '⬜';
			case TaskBoardStatus.Running: return '🔄';
			case TaskBoardStatus.Done: return '✅';
			case TaskBoardStatus.Cancelled: return '❌';
			case TaskBoardStatus.Archived: return '📦';
			default: return '⬜';
		}
	}

	private async _createTask(): Promise<void> {
		try {
			await this.taskBoardService.createTask({
				title: 'New Task',
				status: TaskBoardStatus.Todo,
				workspaceId: 'default',
			});
		} catch { /* ignore */ }
	}

	private async _updateStatus(id: string, status: TaskBoardStatus): Promise<void> {
		try {
			await this.taskBoardService.updateTaskStatus(id, status);
		} catch { /* ignore */ }
	}

	private async _deleteTask(id: string): Promise<void> {
		try {
			await this.taskBoardService.deleteTask(id);
		} catch { /* ignore */ }
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 90}px`;
		}
	}
}
