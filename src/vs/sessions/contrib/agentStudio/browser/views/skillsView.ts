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
import { ISkillRegistry, ISkillDefinition } from '../../common/skills.js';

/**
 * Skills View —— 从 ISkillRegistry 拉取真实 skill 列表。
 *
 * 数据来源：
 *   - 内置 skill (硬编码常量数组，随产品发布)
 *   - 用户全局目录 `<userRoamingDataHome>/sarosis/skills/<id>/SKILL.md`
 *   - 工作区目录 `<workspaceFolder>/.sarosis/skills/<id>/SKILL.md`
 *   - 扩展通过 ISkillRegistry.registerSkill 运行时注册
 *
 * UI 责任仅限于"展示 + 触发激活" —— 真正的 skill 注入由 ExecutionProvider
 * 在每轮 turn 调用 `resolveActivations()` 完成；此 view 不直接修改对话。
 */
export class SkillsViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private countBadge!: HTMLElement;
	private skills: ISkillDefinition[] = [];
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
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.skillRegistry.onDidChangeSkills(() => this._refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('skills-view');

		// Header with count
		const header = $('div.skills-header');
		const title = $('h3.skills-title');
		title.textContent = '💡 Skills Library';
		header.appendChild(title);

		this.countBadge = $('span.skills-count');
		header.appendChild(this.countBadge);
		container.appendChild(header);

		// Filter container (rebuilt on each refresh because categories are dynamic)
		const filterRow = $('div.skills-filters');
		filterRow.id = 'skills-filter-row';
		container.appendChild(filterRow);

		// Skills list
		this.listContainer = $('div.skills-list');
		container.appendChild(this.listContainer);

		// Initial refresh - make sure SkillRegistry is ready
		// Use setTimeout to ensure this runs after the DOM is fully rendered
		setTimeout(() => this._refresh(), 0);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) {
			// Force refresh when the view becomes visible
			this._refresh();
		}
	}

	private _refresh(): void {
		this.skills = [...this.skillRegistry.getSkills()];
		this._updateCount();
		this._renderFilters();
		this._renderSkills();
	}

	private _updateCount(): void {
		const total = this.skills.length;
		const active = this.skills.filter(s => s.activation === 'always' || s.activation === 'auto').length;
		this.countBadge.textContent = `${active}/${total} auto-activate`;
	}

	private _renderFilters(): void {
		const filterRow = this.element?.querySelector('#skills-filter-row') as HTMLElement | null;
		if (!filterRow) { return; }
		filterRow.innerHTML = '';
		const categories = ['All', ...Array.from(new Set(this.skills.map(s => s.category ?? 'misc')))];
		for (const cat of categories) {
			const btn = $('button.skill-filter-btn');
			btn.textContent = cat;
			if (cat === this.activeCategory) { btn.classList.add('active'); }
			btn.onclick = () => {
				filterRow.querySelectorAll('.skill-filter-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeCategory = cat;
				this._renderSkills();
			};
			filterRow.appendChild(btn);
		}
	}

	private _renderSkills(): void {
		const listContainer = this.element?.querySelector('.skills-list') as HTMLElement | null;
		if (!listContainer) { return; }
		listContainer.innerHTML = '';
		const filtered = this.activeCategory === 'All'
			? this.skills
			: this.skills.filter(s => (s.category ?? 'misc') === this.activeCategory);

		if (filtered.length === 0) {
			const empty = $('div.skills-empty');
			empty.innerHTML = '<p>No skills in this category. Drop a SKILL.md into <code>.sarosis/skills/&lt;id&gt;/</code>.</p>';
			listContainer.appendChild(empty);
			return;
		}

		for (const skill of filtered) {
			const item = $('div.skill-item');
			item.classList.toggle('skill-enabled', skill.activation !== 'manual');

			const iconEl = $('span.skill-icon');
			iconEl.textContent = this._iconFor(skill);
			item.appendChild(iconEl);

			const info = $('div.skill-info');
			const nameRow = $('div.skill-name-row');
			const nameEl = $('span.skill-name');
			nameEl.textContent = skill.name;
			nameRow.appendChild(nameEl);

			const catBadge = $('span.skill-category-badge');
			catBadge.textContent = skill.category ?? 'misc';
			nameRow.appendChild(catBadge);

			const activationBadge = $('span.skill-category-badge');
			activationBadge.textContent = skill.activation;
			activationBadge.classList.add(`skill-activation-${skill.activation}`);
			nameRow.appendChild(activationBadge);

			const sourceBadge = $('span.skill-category-badge');
			sourceBadge.textContent = skill.source;
			nameRow.appendChild(sourceBadge);
			info.appendChild(nameRow);

			const descEl = $('div.skill-desc');
			descEl.textContent = skill.description || '(no description)';
			info.appendChild(descEl);
			item.appendChild(info);

			listContainer.appendChild(item);
		}
	}

	private _iconFor(s: ISkillDefinition): string {
		switch (s.category) {
			case 'code': return '💻';
			case 'git': return '🔀';
			case 'meta': return '🧠';
			case 'docs': return '📝';
			default: return '💡';
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 90}px`;
		}
	}
}
