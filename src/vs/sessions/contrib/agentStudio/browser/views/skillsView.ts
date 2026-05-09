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

interface SkillDefinition {
	id: string;
	name: string;
	category: string;
	description: string;
	icon: string;
	enabled: boolean;
}

const AVAILABLE_SKILLS: SkillDefinition[] = [
	{ id: 'code-gen', name: 'Code Generation', category: 'Development', description: 'Generate code from natural language', icon: '💻', enabled: true },
	{ id: 'code-review', name: 'Code Review', category: 'Development', description: 'Analyze and review code quality', icon: '🔍', enabled: true },
	{ id: 'refactor', name: 'Refactoring', category: 'Development', description: 'Restructure and improve code', icon: '🔄', enabled: true },
	{ id: 'testing', name: 'Testing', category: 'Development', description: 'Write and run tests', icon: '🧪', enabled: false },
	{ id: 'web-search', name: 'Web Search', category: 'Research', description: 'Search the web for information', icon: '🌐', enabled: true },
	{ id: 'summarize', name: 'Summarization', category: 'Research', description: 'Summarize documents and content', icon: '📝', enabled: true },
	{ id: 'file-ops', name: 'File Operations', category: 'System', description: 'Read, write, and manage files', icon: '📁', enabled: true },
	{ id: 'terminal', name: 'Terminal', category: 'System', description: 'Execute shell commands', icon: '⌨️', enabled: false },
	{ id: 'deploy', name: 'Deployment', category: 'DevOps', description: 'Deploy applications and services', icon: '🚀', enabled: false },
	{ id: 'data-analysis', name: 'Data Analysis', category: 'Analytics', description: 'Analyze datasets and generate insights', icon: '📊', enabled: false },
	{ id: 'image-gen', name: 'Image Generation', category: 'Creative', description: 'Generate images from descriptions', icon: '🎨', enabled: false },
	{ id: 'planning', name: 'Task Planning', category: 'Management', description: 'Break down goals into actionable tasks', icon: '📋', enabled: true },
];

/**
 * Skills View - 技能管理面板
 * 功能：浏览可用技能、启用/禁用、分类筛选、技能详情
 */
export class SkillsViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private skills: SkillDefinition[] = [...AVAILABLE_SKILLS];
	private activeCategory = 'All';

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
		container.classList.add('skills-view');

		// Header with count
		const header = $('div.skills-header');
		const title = $('h3.skills-title');
		title.textContent = '💡 Skills Library';
		header.appendChild(title);

		const countBadge = $('span.skills-count');
		countBadge.textContent = `${this.skills.filter(s => s.enabled).length}/${this.skills.length} active`;
		header.appendChild(countBadge);
		container.appendChild(header);

		// Category filters
		const categories = ['All', ...new Set(this.skills.map(s => s.category))];
		const filterRow = $('div.skills-filters');
		for (const cat of categories) {
			const btn = $('button.skill-filter-btn');
			btn.textContent = cat;
			if (cat === 'All') { btn.classList.add('active'); }
			btn.onclick = () => {
				filterRow.querySelectorAll('.skill-filter-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeCategory = cat;
				this._renderSkills();
			};
			filterRow.appendChild(btn);
		}
		container.appendChild(filterRow);

		// Skills list
		this.listContainer = $('div.skills-list');
		this._renderSkills();
		container.appendChild(this.listContainer);
	}

	private _renderSkills(): void {
		this.listContainer.innerHTML = '';
		const filtered = this.activeCategory === 'All'
			? this.skills
			: this.skills.filter(s => s.category === this.activeCategory);

		for (const skill of filtered) {
			const item = $('div.skill-item');
			item.classList.toggle('skill-enabled', skill.enabled);

			const iconEl = $('span.skill-icon');
			iconEl.textContent = skill.icon;
			item.appendChild(iconEl);

			const info = $('div.skill-info');
			const nameRow = $('div.skill-name-row');
			const nameEl = $('span.skill-name');
			nameEl.textContent = skill.name;
			nameRow.appendChild(nameEl);

			const catBadge = $('span.skill-category-badge');
			catBadge.textContent = skill.category;
			nameRow.appendChild(catBadge);
			info.appendChild(nameRow);

			const descEl = $('div.skill-desc');
			descEl.textContent = skill.description;
			info.appendChild(descEl);
			item.appendChild(info);

			// Toggle switch
			const toggle = $('label.skill-toggle');
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = skill.enabled;
			checkbox.onchange = () => this._toggleSkill(skill.id, checkbox.checked);
			toggle.appendChild(checkbox);
			const slider = $('span.toggle-slider');
			toggle.appendChild(slider);
			item.appendChild(toggle);

			this.listContainer.appendChild(item);
		}
	}

	private _toggleSkill(id: string, enabled: boolean): void {
		const skill = this.skills.find(s => s.id === id);
		if (skill) {
			skill.enabled = enabled;
			// Update count badge
			const badge = this.element?.querySelector('.skills-count');
			if (badge) {
				badge.textContent = `${this.skills.filter(s => s.enabled).length}/${this.skills.length} active`;
			}
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 90}px`;
		}
	}
}
