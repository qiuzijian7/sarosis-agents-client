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

interface ScheduledTask {
	id: string;
	name: string;
	schedule: string;
	nextRun: string;
	lastRun?: string;
	status: 'active' | 'paused' | 'error';
	description: string;
	agentId?: string;
}

/**
 * Schedule View - 定时任务管理
 * 功能：查看/创建定时任务、设置执行周期、启用/暂停
 */
export class ScheduleViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private scheduledTasks: ScheduledTask[] = [];

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
		container.classList.add('schedule-view');

		// Header
		const header = $('div.schedule-header');
		const title = $('h3.schedule-title');
		title.textContent = '📅 Scheduled Tasks';
		header.appendChild(title);

		const addBtn = $('button.schedule-add-btn');
		addBtn.textContent = '+ Schedule';
		addBtn.onclick = () => this._createSchedule();
		header.appendChild(addBtn);
		container.appendChild(header);

		// Stats bar
		const stats = $('div.schedule-stats');
		// Use DOM API instead of innerHTML to avoid Trusted Types violation
		const activeItem = $('span.stat-item');
		const activeDot = $('span.stat-dot.active');
		activeItem.appendChild(activeDot);
		activeItem.append(` Active: ${this.scheduledTasks.filter(t => t.status === 'active').length}`);
		stats.appendChild(activeItem);
		
		const pausedItem = $('span.stat-item');
		const pausedDot = $('span.stat-dot.paused');
		pausedItem.appendChild(pausedDot);
		pausedItem.append(` Paused: ${this.scheduledTasks.filter(t => t.status === 'paused').length}`);
		stats.appendChild(pausedItem);
		container.appendChild(stats);

		// List
		this.listContainer = $('div.schedule-list');
		this._renderSchedules();
		container.appendChild(this.listContainer);
	}

	private _renderSchedules(): void {
		// Use replaceChildren instead of innerHTML = '' to avoid Trusted Types violation
		this.listContainer.replaceChildren();

		if (this.scheduledTasks.length === 0) {
			const empty = $('div.schedule-empty');
			empty.innerHTML = `
				<div class="empty-icon">⏰</div>
				<p>No scheduled tasks</p>
				<p class="empty-hint">Create a schedule to run tasks automatically at specified intervals</p>
				<div class="schedule-templates">
					<button class="template-btn" data-schedule="hourly">Every hour</button>
					<button class="template-btn" data-schedule="daily">Daily</button>
					<button class="template-btn" data-schedule="weekly">Weekly</button>
				</div>
			`;
			empty.querySelectorAll('.template-btn').forEach(btn => {
				(btn as HTMLButtonElement).onclick = () => {
					const schedule = btn.getAttribute('data-schedule') || 'daily';
					this._createScheduleFromTemplate(schedule);
				};
			});
			this.listContainer.appendChild(empty);
			return;
		}

		for (const task of this.scheduledTasks) {
			const item = $('div.schedule-item');
			item.classList.add(`schedule-${task.status}`);

			const statusDot = $('span.schedule-status-dot');
			statusDot.classList.add(task.status);
			item.appendChild(statusDot);

			const info = $('div.schedule-info');
			const nameEl = $('div.schedule-name');
			nameEl.textContent = task.name;
			info.appendChild(nameEl);

			const scheduleEl = $('div.schedule-cron');
			scheduleEl.textContent = `🔁 ${task.schedule}`;
			info.appendChild(scheduleEl);

			const timingEl = $('div.schedule-timing');
			timingEl.textContent = `Next: ${task.nextRun}${task.lastRun ? ` • Last: ${task.lastRun}` : ''}`;
			info.appendChild(timingEl);

			if (task.description) {
				const descEl = $('div.schedule-desc');
				descEl.textContent = task.description;
				info.appendChild(descEl);
			}
			item.appendChild(info);

			const actions = $('div.schedule-actions');
			const toggleBtn = $('button.schedule-action');
			toggleBtn.textContent = task.status === 'active' ? '⏸' : '▶';
			toggleBtn.title = task.status === 'active' ? 'Pause' : 'Resume';
			toggleBtn.onclick = () => this._toggleSchedule(task.id);
			actions.appendChild(toggleBtn);

			const editBtn = $('button.schedule-action');
			editBtn.textContent = '✏️';
			editBtn.onclick = () => this._editSchedule(task.id);
			actions.appendChild(editBtn);

			const deleteBtn = $('button.schedule-action');
			deleteBtn.textContent = '🗑️';
			deleteBtn.onclick = () => this._deleteSchedule(task.id);
			actions.appendChild(deleteBtn);
			item.appendChild(actions);

			this.listContainer.appendChild(item);
		}
	}

	private _createSchedule(): void {
		const newTask: ScheduledTask = {
			id: `schedule-${Date.now()}`,
			name: 'New Scheduled Task',
			schedule: 'Every day at 9:00 AM',
			nextRun: new Date(Date.now() + 86400000).toLocaleString(),
			status: 'active',
			description: '',
		};
		this.scheduledTasks.push(newTask);
		this._renderSchedules();
	}

	private _createScheduleFromTemplate(template: string): void {
		const scheduleMap: Record<string, string> = {
			'hourly': 'Every hour',
			'daily': 'Every day at 9:00 AM',
			'weekly': 'Every Monday at 9:00 AM',
		};
		const newTask: ScheduledTask = {
			id: `schedule-${Date.now()}`,
			name: `${template.charAt(0).toUpperCase() + template.slice(1)} Task`,
			schedule: scheduleMap[template] || 'Every day',
			nextRun: new Date(Date.now() + 3600000).toLocaleString(),
			status: 'active',
			description: '',
		};
		this.scheduledTasks.push(newTask);
		this._renderSchedules();
	}

	private _toggleSchedule(id: string): void {
		const task = this.scheduledTasks.find(t => t.id === id);
		if (task) {
			task.status = task.status === 'active' ? 'paused' : 'active';
			this._renderSchedules();
		}
	}

	private _editSchedule(_id: string): void {
		// TODO: Open schedule edit dialog
	}

	private _deleteSchedule(id: string): void {
		this.scheduledTasks = this.scheduledTasks.filter(t => t.id !== id);
		this._renderSchedules();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 80}px`;
		}
	}
}
