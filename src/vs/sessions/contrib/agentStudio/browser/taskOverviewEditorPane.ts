/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IAgentTaskBoardService, IAgentStudioService, ITaskOrchestrationService } from '../common/agentStudio.js';
import { TaskBoardStatus, type TaskBoardRecord, type Workspace } from '../common/types.js';
import type { OrchestrationPlan } from '../../../common/agentStudioTypes.js';
import { TaskDetailEditorInput } from './taskDetailEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import * as DOM from '../../../../base/browser/dom.js';

const COLUMNS: Array<{ status: TaskBoardStatus; label: string; icon: string; color: string }> = [
	{ status: TaskBoardStatus.Todo, label: '待执行', icon: '⬜', color: '#f59e0b' },
	{ status: TaskBoardStatus.Running, label: '执行中', icon: '⚡', color: '#3b82f6' },
	{ status: TaskBoardStatus.Done, label: '已完成', icon: '✅', color: '#10b981' },
	{ status: TaskBoardStatus.Cancelled, label: '已取消', icon: '❌', color: '#6b7280' },
	{ status: TaskBoardStatus.Archived, label: '归档', icon: '📦', color: '#8b5cf6' },
];

/**
 * Task Overview EditorPane — Kanban-style 5-column board with workspace selector.
 * Displayed in the editor area when user clicks "Overview" in the sidebar.
 */
export class TaskOverviewEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.taskOverview';

	private _container: HTMLElement | undefined;
	private _boardContainer: HTMLElement | undefined;
	private _selectedWorkspaceId: string | undefined; // undefined = All
	private _workspaces: Workspace[] = [];
	private _highlightedTaskTitle: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@ITaskOrchestrationService private readonly taskOrchestrationService: ITaskOrchestrationService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(TaskOverviewEditorPane.ID, group, telemetryService, themeService, storageService);
		
		// Listen for plan changes to refresh the board
		this._register(
			this.taskOrchestrationService.onDidChangePlan((plan: OrchestrationPlan) => {
				// Refresh the board when a plan is updated
				// Only refresh if the board container exists (i.e., the editor is fully rendered)
				if (this._boardContainer) {
					this._renderBoard().catch(err => {
						console.error('[TaskOverviewEditorPane] Failed to refresh board on plan change:', err);
					});
				}
			})
		);
		// Listen for focus task requests to highlight a task card
		this._register(
			this.taskOrchestrationService.onDidFocusTask((taskTitle: string) => {
				this._highlightedTaskTitle = taskTitle;
				if (this._boardContainer) {
					this._renderBoard().catch(err => {
						console.error('[TaskOverviewEditorPane] Failed to refresh board on focus task:', err);
					});
				}
			})
		);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('task-overview-editor');
		this._container.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--vscode-editor-background);';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this._workspaces = await this.agentStudioService.getWorkspaces();
		await this._render();
	}

	private async _render(): Promise<void> {
		if (!this._container) { return; }
		this._container.replaceChildren();

		// ─── Header toolbar ──────────────────────────────────────
		const header = document.createElement('div');
		header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,0.2));flex-shrink:0;';

		const title = document.createElement('h2');
		title.textContent = '📋 任务看板';
		title.style.cssText = 'margin:0;font-size:14px;font-weight:600;color:var(--vscode-foreground);';
		header.appendChild(title);

		// Workspace selector
		const wsSelector = document.createElement('select');
		wsSelector.style.cssText = 'padding:4px 8px;border-radius:4px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:12px;cursor:pointer;min-width:140px;';
		const allOpt = document.createElement('option');
		allOpt.value = '';
		allOpt.textContent = '🌍 All Workspaces';
		wsSelector.appendChild(allOpt);
		for (const ws of this._workspaces) {
			const opt = document.createElement('option');
			opt.value = ws.id;
			opt.textContent = `🏠 ${ws.name}`;
			if (ws.id === this._selectedWorkspaceId) { opt.selected = true; }
			wsSelector.appendChild(opt);
		}
		wsSelector.onchange = () => {
			this._selectedWorkspaceId = wsSelector.value || undefined;
			this._renderBoard();
		};
		header.appendChild(wsSelector);

		// Spacer
		const spacer = document.createElement('div');
		spacer.style.flex = '1';
		header.appendChild(spacer);

		// Refresh button
		const refreshBtn = document.createElement('button');
		refreshBtn.textContent = '🔄 刷新';
		refreshBtn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,0.3));background:transparent;color:var(--vscode-foreground);font-size:12px;cursor:pointer;';
		refreshBtn.onclick = () => this._renderBoard();
		header.appendChild(refreshBtn);

		this._container.appendChild(header);

		// ─── Board container (fills remaining height, horizontal scroll) ──
		this._boardContainer = document.createElement('div');
		this._boardContainer.style.cssText = 'display:flex;flex:1;gap:12px;padding:12px 16px;overflow-x:auto;overflow-y:hidden;';
		this._container.appendChild(this._boardContainer);

		await this._renderBoard();
	}

	private async _renderBoard(): Promise<void> {
		if (!this._boardContainer) { return; }
		this._boardContainer.replaceChildren();

		// Load tasks
		let tasks: TaskBoardRecord[];
		try {
			tasks = await this.taskBoardService.getTasks(this._selectedWorkspaceId);
		} catch {
			const err = document.createElement('div');
			err.textContent = '⚠️ 加载任务失败';
			err.style.cssText = 'color:#ef4444;padding:24px;font-size:13px;';
			this._boardContainer.appendChild(err);
			return;
		}

		// Render 5-column kanban
		for (const col of COLUMNS) {
			const colTasks = tasks.filter(t => t.status === col.status);

			const column = document.createElement('div');
			column.style.cssText = 'display:flex;flex-direction:column;min-width:220px;flex:1;max-width:320px;border-radius:8px;background:var(--vscode-sideBar-background,rgba(128,128,128,0.04));border:1px solid var(--vscode-panel-border,rgba(128,128,128,0.15));overflow:hidden;';

			// Column header
			const colHeader = document.createElement('div');
			colHeader.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:2px solid ${col.color};`;

			const colTitle = document.createElement('span');
			colTitle.textContent = `${col.icon} ${col.label}`;
			colTitle.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-foreground);';
			colHeader.appendChild(colTitle);

			const colCount = document.createElement('span');
			colCount.textContent = `${colTasks.length}`;
			colCount.style.cssText = `padding:1px 7px;border-radius:10px;font-size:11px;font-weight:500;background:${col.color}20;color:${col.color};`;
			colHeader.appendChild(colCount);
			column.appendChild(colHeader);

			// Column body (scrollable)
			const colBody = document.createElement('div');
			colBody.style.cssText = 'flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px;';

			for (const task of colTasks) {
				const card = document.createElement('div');
				const isHighlighted = this._highlightedTaskTitle && task.title === this._highlightedTaskTitle;
				card.style.cssText = `padding:8px 10px;border-radius:6px;background:var(--vscode-editor-background);border:2px solid ${isHighlighted ? col.color : 'var(--vscode-panel-border,rgba(128,128,128,0.15))'};cursor:pointer;transition:border-color 100ms;${isHighlighted ? `box-shadow:0 0 0 3px ${col.color}30;` : ''}`;
				if (isHighlighted) {
					// Scroll into view after a short delay to ensure DOM is ready
					setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
				}
				card.onmouseenter = () => { if (!isHighlighted) { card.style.borderColor = col.color; } };
				card.onmouseleave = () => { if (!isHighlighted) { card.style.borderColor = 'var(--vscode-panel-border,rgba(128,128,128,0.15))'; } };
				card.onclick = () => this._openTaskDetail(task);

				const cardTitle = document.createElement('div');
				cardTitle.textContent = task.title;
				cardTitle.style.cssText = 'font-size:12px;font-weight:500;color:var(--vscode-foreground);margin-bottom:4px;line-height:1.4;';
				card.appendChild(cardTitle);

				if (task.description) {
					const cardDesc = document.createElement('div');
					cardDesc.textContent = task.description.slice(0, 60) + (task.description.length > 60 ? '...' : '');
					cardDesc.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px;line-height:1.3;';
					card.appendChild(cardDesc);
				}

				const cardMeta = document.createElement('div');
				cardMeta.style.cssText = 'display:flex;gap:8px;font-size:10px;color:var(--vscode-descriptionForeground);';
				if (task.assigneeName) {
					const assignee = document.createElement('span');
					assignee.textContent = `🤖 ${task.assigneeName}`;
					cardMeta.appendChild(assignee);
				}
				if (task.priority) {
					const pri = document.createElement('span');
					pri.textContent = task.priority === 'high' ? '🔥 high' : task.priority;
					cardMeta.appendChild(pri);
				}
				if (cardMeta.children.length > 0) {
					card.appendChild(cardMeta);
				}

				colBody.appendChild(card);
			}

			if (colTasks.length === 0) {
				const empty = document.createElement('div');
				empty.textContent = '暂无任务';
				empty.style.cssText = 'text-align:center;padding:20px 8px;font-size:11px;color:var(--vscode-descriptionForeground);opacity:0.6;';
				colBody.appendChild(empty);
			}

			column.appendChild(colBody);
			this._boardContainer.appendChild(column);
		}
	}

	private _openTaskDetail(task: TaskBoardRecord): void {
		const input = TaskDetailEditorInput.getOrCreate(task.id, task.title);
		this.editorService.openEditor(input, { pinned: false });
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}
}
