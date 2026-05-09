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
import type { Employee } from '../../common/types.js';

interface AgentPreset {
	id: string;
	name: string;
	role: string;
	description: string;
	icon: string;
	model: string;
	skills: string[];
}

const BUILTIN_PRESETS: AgentPreset[] = [
	{ id: 'coder', name: 'Coder', role: 'Software Engineer', description: 'Writes, reviews, and refactors code', icon: '👨‍💻', model: 'claude-sonnet-4-20250514', skills: ['code-gen', 'code-review', 'refactor'] },
	{ id: 'researcher', name: 'Researcher', role: 'Research Analyst', description: 'Gathers and synthesizes information', icon: '🔬', model: 'claude-sonnet-4-20250514', skills: ['web-search', 'summarize', 'analysis'] },
	{ id: 'writer', name: 'Writer', role: 'Content Writer', description: 'Creates documentation and content', icon: '✍️', model: 'claude-sonnet-4-20250514', skills: ['writing', 'editing', 'formatting'] },
	{ id: 'designer', name: 'Designer', role: 'UI/UX Designer', description: 'Designs interfaces and user experiences', icon: '🎨', model: 'claude-sonnet-4-20250514', skills: ['ui-design', 'prototyping', 'review'] },
	{ id: 'planner', name: 'Planner', role: 'Project Manager', description: 'Plans tasks and coordinates workflows', icon: '📋', model: 'claude-sonnet-4-20250514', skills: ['planning', 'delegation', 'tracking'] },
	{ id: 'tester', name: 'Tester', role: 'QA Engineer', description: 'Tests and validates functionality', icon: '🧪', model: 'claude-sonnet-4-20250514', skills: ['testing', 'bug-report', 'automation'] },
	{ id: 'devops', name: 'DevOps', role: 'DevOps Engineer', description: 'Manages deployment and infrastructure', icon: '🚀', model: 'claude-sonnet-4-20250514', skills: ['deploy', 'ci-cd', 'monitoring'] },
	{ id: 'data', name: 'Data Analyst', role: 'Data Scientist', description: 'Analyzes data and generates insights', icon: '📊', model: 'claude-sonnet-4-20250514', skills: ['data-analysis', 'visualization', 'sql'] },
];

/**
 * Preset Agent View - 预设Agent模板管理
 * 功能：浏览预设模板、创建自定义模板、从模板实例化Agent
 */
export class PresetAgentViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private customPresets: AgentPreset[] = [];

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
		container.classList.add('preset-agent-view');

		// Header
		const header = $('div.preset-header');
		const title = $('h3.preset-title');
		title.textContent = '🤖 Agent Presets';
		header.appendChild(title);

		const addBtn = $('button.preset-add-btn');
		addBtn.textContent = '+ Custom';
		addBtn.title = 'Create custom preset';
		addBtn.onclick = () => this._createCustomPreset();
		header.appendChild(addBtn);
		container.appendChild(header);

		// Category tabs
		const tabs = $('div.preset-tabs');
		const builtinTab = $('button.preset-tab.active');
		builtinTab.textContent = 'Built-in';
		builtinTab.onclick = () => this._showCategory('builtin', builtinTab, tabs);
		tabs.appendChild(builtinTab);

		const customTab = $('button.preset-tab');
		customTab.textContent = 'Custom';
		customTab.onclick = () => this._showCategory('custom', customTab, tabs);
		tabs.appendChild(customTab);
		container.appendChild(tabs);

		// Grid list
		this.listContainer = $('div.preset-grid');
		this._renderPresets(BUILTIN_PRESETS);
		container.appendChild(this.listContainer);
	}

	private _showCategory(category: string, activeTab: HTMLElement, tabsContainer: HTMLElement): void {
		tabsContainer.querySelectorAll('.preset-tab').forEach(t => t.classList.remove('active'));
		activeTab.classList.add('active');

		if (category === 'builtin') {
			this._renderPresets(BUILTIN_PRESETS);
		} else {
			this._renderPresets(this.customPresets);
		}
	}

	private _renderPresets(presets: AgentPreset[]): void {
		this.listContainer.innerHTML = '';

		if (presets.length === 0) {
			const empty = $('div.preset-empty');
			empty.innerHTML = '<p>No custom presets yet</p><p class="empty-hint">Create a custom preset to reuse agent configurations</p>';
			this.listContainer.appendChild(empty);
			return;
		}

		for (const preset of presets) {
			const card = $('div.preset-card');

			const iconEl = $('div.preset-icon');
			iconEl.textContent = preset.icon;
			card.appendChild(iconEl);

			const info = $('div.preset-info');
			const nameEl = $('div.preset-name');
			nameEl.textContent = preset.name;
			info.appendChild(nameEl);

			const roleEl = $('div.preset-role');
			roleEl.textContent = preset.role;
			info.appendChild(roleEl);

			const descEl = $('div.preset-desc');
			descEl.textContent = preset.description;
			info.appendChild(descEl);

			const skillsEl = $('div.preset-skills');
			for (const skill of preset.skills) {
				const tag = $('span.skill-tag');
				tag.textContent = skill;
				skillsEl.appendChild(tag);
			}
			info.appendChild(skillsEl);
			card.appendChild(info);

			const deployBtn = $('button.preset-deploy-btn');
			deployBtn.textContent = '▶ Deploy';
			deployBtn.onclick = () => this._deployPreset(preset);
			card.appendChild(deployBtn);

			this.listContainer.appendChild(card);
		}
	}

	private async _deployPreset(preset: AgentPreset): Promise<void> {
		try {
			const employeeData: Partial<Employee> = {
				name: preset.name,
				role: preset.role,
				presetId: preset.id,
				model: preset.model,
				skills: preset.skills.map(s => ({ id: s, name: s, enabled: true })),
			};
			await this.agentStudioService.createEmployee(employeeData);
		} catch {
			// handle error
		}
	}

	private _createCustomPreset(): void {
		// TODO: Open preset creation dialog
		const newPreset: AgentPreset = {
			id: `custom-${Date.now()}`,
			name: 'Custom Agent',
			role: 'Custom Role',
			description: 'Custom agent preset',
			icon: '🔧',
			model: 'claude-sonnet-4-20250514',
			skills: [],
		};
		this.customPresets.push(newPreset);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 90}px`;
		}
	}
}
