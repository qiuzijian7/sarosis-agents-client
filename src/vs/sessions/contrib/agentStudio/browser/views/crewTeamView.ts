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
import { ICrewTeamService, ICrew, CrewType, ITask } from '../../common/crewTeam.js';
import { $ } from '../../../../../base/browser/dom.js';

// ------------------------------------------------------------------------------------
// Crew/Team 视图面板
// ------------------------------------------------------------------------------------

export class CrewTeamViewPane extends ViewPane {

	private _crewsContainer!: HTMLElement;
	private _tasksContainer!: HTMLElement;
	private _selectedCrewId: string | null = null;
	private _crews: ICrew[] = [];
	private _tasks: ITask[] = [];

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
		@ICrewTeamService private readonly _crewTeamService: ICrewTeamService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('crew-team-view');

		// 创建整体布局
		const layout = $('div.crew-team-layout');
		container.appendChild(layout);

		// 工具栏
		const toolbar = $('div.crew-toolbar');
		
		const createCrewBtn = $('button.crew-action-btn');
		createCrewBtn.textContent = '+ New Crew';
		createCrewBtn.onclick = () => this._createCrew();
		toolbar.appendChild(createCrewBtn);

		const refreshBtn = $('button.crew-action-btn');
		refreshBtn.textContent = '🔄 Refresh';
		refreshBtn.onclick = () => this._loadData();
		toolbar.appendChild(refreshBtn);

		layout.appendChild(toolbar);

		// Crew列表
		const crewsSection = $('div.section');
		const crewsTitle = $('div.section-title');
		crewsTitle.textContent = 'Crews';
		crewsSection.appendChild(crewsTitle);

		this._crewsContainer = $('div.crews-container');
		crewsSection.appendChild(this._crewsContainer);
		layout.appendChild(crewsSection);

		// 任务列表
		const tasksSection = $('div.section');
		const tasksTitle = $('div.section-title');
		tasksTitle.textContent = 'Tasks';
		tasksSection.appendChild(tasksTitle);

		this._tasksContainer = $('div.tasks-container');
		tasksSection.appendChild(this._tasksContainer);
		layout.appendChild(tasksSection);

		// 加载数据
		this._loadData();

		// 监听Crew变化
		this._register(
			this._crewTeamService.onDidCreateCrew((crew) => {
				this._loadCrews();
			})
		);

		this._register(
			this._crewTeamService.onDidUpdateCrew((crew) => {
				this._loadCrews();
			})
		);

		this._register(
			this._crewTeamService.onDidDeleteCrew((crewId) => {
				if (this._selectedCrewId === crewId) {
					this._selectedCrewId = null;
				}
				this._loadCrews();
			})
		);

		// 监听任务变化
		this._register(
			this._crewTeamService.onDidCreateTask((task) => {
				if (this._selectedCrewId) {
					this._loadTasks(this._selectedCrewId);
				}
			})
		);

		this._register(
			this._crewTeamService.onDidUpdateTask((task) => {
				if (this._selectedCrewId) {
					this._loadTasks(this._selectedCrewId);
				}
			})
		);
	}

	private async _loadData(): Promise<void> {
		await this._loadCrews();
		if (this._selectedCrewId) {
			await this._loadTasks(this._selectedCrewId);
		}
	}

	private async _loadCrews(): Promise<void> {
		try {
			this._crews = await this._crewTeamService.listCrews();
			this._renderCrews();
		} catch (error) {
			this._crewsContainer.replaceChildren();
			const errorDiv = $('div.error');
			errorDiv.textContent = 'Failed to load crews';
			this._crewsContainer.appendChild(errorDiv);
		}
	}

	private _renderCrews(): void {
		this._crewsContainer.replaceChildren();

		if (this._crews.length === 0) {
			const emptyMsg = $('div.empty-message');
			emptyMsg.textContent = 'No crews yet. Create one!';
			this._crewsContainer.appendChild(emptyMsg);
			return;
		}

		for (const crew of this._crews) {
			const card = $('div.crew-card');
			card.classList.toggle('selected', this._selectedCrewId === crew.id);
			card.onclick = () => this._selectCrew(crew.id);

			// Crew信息
			const info = $('div.crew-info');
			
			const name = $('div.crew-name');
			name.textContent = crew.name;
			info.appendChild(name);

			const description = $('div.crew-description');
			description.textContent = crew.description;
			info.appendChild(description);

			const meta = $('div.crew-meta');

			const typeSpan = $('span');
			typeSpan.textContent = `Type: ${crew.type}`;
			meta.appendChild(typeSpan);

			const membersSpan = $('span');
			membersSpan.textContent = `Members: ${crew.members.length}`;
			meta.appendChild(membersSpan);

			const tasksSpan = $('span');
			tasksSpan.textContent = `Tasks: ${crew.tasks.length}`;
			meta.appendChild(tasksSpan);

			info.appendChild(meta);

			card.appendChild(info);

			// 操作按钮
			const actions = $('div.crew-actions');
			
			const viewBtn = $('button.crew-action-small');
			viewBtn.textContent = 'View';
			viewBtn.onclick = (e) => { e.stopPropagation(); this._selectCrew(crew.id); };
			actions.appendChild(viewBtn);

			const deleteBtn = $('button.crew-action-small danger');
			deleteBtn.textContent = 'Delete';
			deleteBtn.onclick = (e) => { e.stopPropagation(); this._deleteCrew(crew.id); };
			actions.appendChild(deleteBtn);

			card.appendChild(actions);

			this._crewsContainer.appendChild(card);
		}
	}

	private async _selectCrew(crewId: string): Promise<void> {
		this._selectedCrewId = crewId;
		this._renderCrews();
		await this._loadTasks(crewId);
	}

	private async _createCrew(): Promise<void> {
		try {
			// TODO: 打开对话框收集Crew信息
			const name = prompt('Enter crew name:');
			if (!name) {
				return;
			}

			const description = prompt('Enter crew description:') || '';
			
			await this._crewTeamService.createCrew(
				name,
				description,
				CrewType.Sequential,
			);

			this._loadCrews();
		} catch (error) {
			console.error('Failed to create crew:', error);
		}
	}

	private async _deleteCrew(crewId: string): Promise<void> {
		try {
			const confirmed = confirm('Are you sure you want to delete this crew?');
			if (!confirmed) {
				return;
			}

			await this._crewTeamService.deleteCrew(crewId);
			if (this._selectedCrewId === crewId) {
				this._selectedCrewId = null;
				this._tasksContainer.replaceChildren();
				const emptyMsg = $('div.empty-message');
				emptyMsg.textContent = 'Select a crew to view tasks';
				this._tasksContainer.appendChild(emptyMsg);
			}
		} catch (error) {
			console.error('Failed to delete crew:', error);
		}
	}

	private async _loadTasks(crewId: string): Promise<void> {
		try {
			this._tasks = await this._crewTeamService.listTasks(crewId);
			this._renderTasks();
		} catch (error) {
			this._tasksContainer.replaceChildren();
			const errorDiv = $('div.error');
			errorDiv.textContent = 'Failed to load tasks';
			this._tasksContainer.appendChild(errorDiv);
		}
	}

	private _renderTasks(): void {
		this._tasksContainer.replaceChildren();

		if (!this._selectedCrewId) {
			const emptyMsg = $('div.empty-message');
			emptyMsg.textContent = 'Select a crew to view tasks';
			this._tasksContainer.appendChild(emptyMsg);
			return;
		}

		if (this._tasks.length === 0) {
			const emptyMsg = $('div.empty-message');
			emptyMsg.textContent = 'No tasks yet. Create one!';
			this._tasksContainer.appendChild(emptyMsg);
			return;
		}

		for (const task of this._tasks) {
			const item = $('div.task-item');
			item.classList.add(`task-${task.status}`);

			const header = $('div.task-header');
			
			const name = $('div.task-name');
			name.textContent = task.name;
			header.appendChild(name);

			const status = $('div.task-status');
			status.textContent = task.status;
			header.appendChild(status);

			item.appendChild(header);

			const description = $('div.task-description');
			description.textContent = task.description;
			item.appendChild(description);

			const meta = $('div.task-meta');

			const prioritySpan = $('span');
			prioritySpan.textContent = `Priority: ${task.priority}`;
			meta.appendChild(prioritySpan);

			const assignedSpan = $('span');
			assignedSpan.textContent = `Assigned to: ${task.assignedTo || 'Unassigned'}`;
			meta.appendChild(assignedSpan);

			item.appendChild(meta);

			this._tasksContainer.appendChild(item);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// 可以在这里调整布局
	}
}
