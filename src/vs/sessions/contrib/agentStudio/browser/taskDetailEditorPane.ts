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
import { IAgentTaskBoardService } from '../common/agentStudio.js';
import { TaskBoardStatus, type TaskBoardRecord } from '../common/types.js';
import { TaskDetailEditorInput } from './taskDetailEditorInput.js';
import * as DOM from '../../../../base/browser/dom.js';

const { $ } = DOM;

/**
 * Task Detail EditorPane — shows full detail of a single task.
 * Displayed in the editor area when user clicks a task in the sidebar.
 */
export class TaskDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.taskDetail';

	private _container: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
	) {
		super(TaskDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('task-detail-editor');
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof TaskDetailEditorInput) || !this._container) {
			return;
		}

		await this._renderTaskDetail(input.taskId);
	}

	private async _renderTaskDetail(taskId: string): Promise<void> {
		if (!this._container) { return; }
		this._container.replaceChildren();

		let task: TaskBoardRecord | undefined;
		try {
			task = await this.taskBoardService.getTask(taskId);
		} catch { /* ignore */ }

		if (!task) {
			const err = $('div.task-detail-empty');
			err.textContent = `⚠️ 任务未找到: ${taskId}`;
			this._container.appendChild(err);
			return;
		}

		// ─── Header ──────────────────────────────────────────
		const header = $('div.task-detail-header');
		const statusBadge = $('span.task-detail-status');
		statusBadge.textContent = this._getStatusLabel(task.status);
		statusBadge.classList.add(`status-${task.status}`);
		header.appendChild(statusBadge);

		const titleEl = $('h2.task-detail-title');
		titleEl.textContent = task.title;
		header.appendChild(titleEl);

		if (task.priority) {
			const priBadge = $('span.task-detail-priority');
			priBadge.textContent = `Priority: ${task.priority}`;
			priBadge.classList.add(`priority-${task.priority}`);
			header.appendChild(priBadge);
		}
		this._container.appendChild(header);

		// ─── Description ─────────────────────────────────────
		if (task.description) {
			const descSection = $('div.task-detail-section');
			const descLabel = $('h3.task-detail-section-title');
			descLabel.textContent = '📝 描述';
			descSection.appendChild(descLabel);
			const descText = $('div.task-detail-desc');
			descText.textContent = task.description;
			descSection.appendChild(descText);
			this._container.appendChild(descSection);
		}

		// ─── Metadata grid ───────────────────────────────────
		const metaSection = $('div.task-detail-section');
		const metaLabel = $('h3.task-detail-section-title');
		metaLabel.textContent = '📊 元数据';
		metaSection.appendChild(metaLabel);

		const grid = $('div.task-detail-grid');
		const fields: Array<{ label: string; value: string }> = [
			{ label: '任务 ID', value: task.id },
			{ label: '状态', value: this._getStatusLabel(task.status) },
			{ label: '分配 Agent', value: task.assigneeName || '未分配' },
			{ label: '优先级', value: task.priority || 'medium' },
			{ label: '创建时间', value: new Date(task.createdAt).toLocaleString('zh-CN') },
			{ label: '更新时间', value: new Date(task.updatedAt).toLocaleString('zh-CN') },
		];
		if (task.completedAt) {
			fields.push({ label: '完成时间', value: new Date(task.completedAt).toLocaleString('zh-CN') });
		}

		for (const f of fields) {
			const row = $('div.task-detail-field');
			const labelEl = $('span.task-detail-field-label');
			labelEl.textContent = f.label;
			row.appendChild(labelEl);
			const valueEl = $('span.task-detail-field-value');
			valueEl.textContent = f.value;
			row.appendChild(valueEl);
			grid.appendChild(row);
		}
		metaSection.appendChild(grid);
		this._container.appendChild(metaSection);

		// ─── Actions ─────────────────────────────────────────
		const actionsSection = $('div.task-detail-section');
		const actionsLabel = $('h3.task-detail-section-title');
		actionsLabel.textContent = '⚡ 操作';
		actionsSection.appendChild(actionsLabel);

		const actionsBar = $('div.task-detail-actions');
		if (task.status === TaskBoardStatus.Todo) {
			this._addActionBtn(actionsBar, '▶️ 开始', () => this._updateStatus(taskId, TaskBoardStatus.Running));
			this._addActionBtn(actionsBar, '❌ 取消', () => this._updateStatus(taskId, TaskBoardStatus.Cancelled));
		}
		if (task.status === TaskBoardStatus.Running) {
			this._addActionBtn(actionsBar, '✅ 完成', () => this._updateStatus(taskId, TaskBoardStatus.Done));
			this._addActionBtn(actionsBar, '❌ 取消', () => this._updateStatus(taskId, TaskBoardStatus.Cancelled));
		}
		if (task.status === TaskBoardStatus.Cancelled) {
			this._addActionBtn(actionsBar, '🔄 重做', () => this._updateStatus(taskId, TaskBoardStatus.Todo));
		}
		if (task.status === TaskBoardStatus.Done) {
			this._addActionBtn(actionsBar, '📦 归档', () => this._updateStatus(taskId, TaskBoardStatus.Archived));
		}
		actionsSection.appendChild(actionsBar);
		this._container.appendChild(actionsSection);
	}

	private _addActionBtn(container: HTMLElement, text: string, handler: () => void): void {
		const btn = $('button.task-detail-action-btn');
		btn.textContent = text;
		btn.onclick = handler;
		container.appendChild(btn);
	}

	private async _updateStatus(taskId: string, status: TaskBoardStatus): Promise<void> {
		try {
			await this.taskBoardService.updateTaskStatus(taskId, status);
			await this._renderTaskDetail(taskId);
		} catch { /* ignore */ }
	}

	private _getStatusLabel(status: TaskBoardStatus): string {
		switch (status) {
			case TaskBoardStatus.Todo: return '⬜ 待执行';
			case TaskBoardStatus.Running: return '⚡ 执行中';
			case TaskBoardStatus.Done: return '✅ 已完成';
			case TaskBoardStatus.Cancelled: return '❌ 已取消';
			case TaskBoardStatus.Archived: return '📦 已归档';
			default: return status;
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}
}
