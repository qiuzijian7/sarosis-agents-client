/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentMarketEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import {
	AgentMarketEditorInput
} from './agentMarketEditorInput.js';
import {
	AgentPreset,
	PresetCategory,
	BUILTIN_PRESETS,
	PRESET_CATEGORIES,
} from './views/presetAgentView.js';

const { $: $$ } = DOM;

/**
 * EditorPane that renders the Agent Market (Agent 商城) page in the editor area.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  Hero header (title + subtitle + search)             │
 *   │  Category filter chips                                │
 *   │  ┌──────┐ ┌──────┐ ┌──────┐  (responsive card grid)  │
 *   │  │ card │ │ card │ │ card │                           │
 *   │  └──────┘ └──────┘ └──────┘                           │
 *   └─────────────────────────────────────────────────────┘
 *
 * Each card shows the agent icon, name, role, description, skill tags and a
 * one-click "部署" (deploy) button that creates an Agent in the active
 * workspace — reusing the same data model as the Preset Agent sidebar view.
 */
export class AgentMarketEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentMarket';

	private _container: HTMLElement | undefined;
	private _gridContainer: HTMLElement | undefined;
	private _countBadge: HTMLElement | undefined;

	private _activeCategory: PresetCategory | 'All' = 'All';
	private _searchQuery = '';
	private _isDeploying = false;
	private _initialized = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(AgentMarketEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-market-editor');
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof AgentMarketEditorInput)) {
			return;
		}

		if (this._container && !this._initialized) {
			this._buildUI(this._container);
			this._initialized = true;
		}
	}

	private _buildUI(container: HTMLElement): void {
		container.replaceChildren();

		// ── Scrollable root ───────────────────────────────────────────
		const scroll = $$('div.agent-market-scroll');
		container.appendChild(scroll);

		// ── Hero header ───────────────────────────────────────────────
		const hero = $$('div.agent-market-hero');

		const heroText = $$('div.agent-market-hero-text');
		const title = $$('h1.agent-market-title');
		title.textContent = '🛒 Agent 商城';
		heroText.appendChild(title);

		const subtitle = $$('p.agent-market-subtitle');
		subtitle.textContent = '浏览并一键部署预置的智能体到当前工作区';
		heroText.appendChild(subtitle);
		hero.appendChild(heroText);

		// Search box
		const searchBox = $$('div.agent-market-search-box');
		const searchIcon = $$('span.agent-market-search-icon');
		searchIcon.textContent = '🔍';
		searchBox.appendChild(searchIcon);

		const searchInput = document.createElement('input');
		searchInput.type = 'text';
		searchInput.className = 'agent-market-search-input';
		searchInput.placeholder = '搜索智能体（名称、角色、技能…）';
		this._register(DOM.addDisposableListener(searchInput, 'input', () => {
			this._searchQuery = searchInput.value.toLowerCase().trim();
			this._renderGrid();
		}));
		searchBox.appendChild(searchInput);
		hero.appendChild(searchBox);

		scroll.appendChild(hero);

		// ── Toolbar: category chips + count ───────────────────────────
		const toolbar = $$('div.agent-market-toolbar');

		const chips = $$('div.agent-market-chips');
		for (const cat of PRESET_CATEGORIES) {
			const chip = $$('button.agent-market-chip');
			chip.textContent = cat.label;
			if (cat.id === this._activeCategory) {
				chip.classList.add('active');
			}
			chip.onclick = () => {
				chips.querySelectorAll('.agent-market-chip').forEach(c => c.classList.remove('active'));
				chip.classList.add('active');
				this._activeCategory = cat.id as PresetCategory | 'All';
				this._renderGrid();
			};
			chips.appendChild(chip);
		}
		toolbar.appendChild(chips);

		const countBadge = $$('span.agent-market-count');
		this._countBadge = countBadge;
		toolbar.appendChild(countBadge);

		scroll.appendChild(toolbar);

		// ── Card grid ─────────────────────────────────────────────────
		const grid = $$('div.agent-market-grid');
		this._gridContainer = grid;
		scroll.appendChild(grid);

		this._renderGrid();
	}

	private _getFilteredPresets(): AgentPreset[] {
		let presets = BUILTIN_PRESETS;

		if (this._activeCategory !== 'All') {
			presets = presets.filter(p => p.category === this._activeCategory);
		}

		if (this._searchQuery) {
			const q = this._searchQuery;
			presets = presets.filter(p =>
				p.name.toLowerCase().includes(q) ||
				p.role.toLowerCase().includes(q) ||
				p.description.toLowerCase().includes(q) ||
				p.skills.some(s => s.toLowerCase().includes(q))
			);
		}

		return presets;
	}

	private _renderGrid(): void {
		const grid = this._gridContainer;
		if (!grid) {
			return;
		}
		grid.replaceChildren();

		const presets = this._getFilteredPresets();

		if (this._countBadge) {
			this._countBadge.textContent = `${presets.length} 个智能体`;
		}

		if (presets.length === 0) {
			const empty = $$('div.agent-market-empty');
			empty.textContent = '没有匹配的智能体，换个关键词试试吧。';
			grid.appendChild(empty);
			return;
		}

		for (const preset of presets) {
			grid.appendChild(this._renderCard(preset));
		}
	}

	private _renderCard(preset: AgentPreset): HTMLElement {
		const card = $$('div.agent-market-card');

		// Header: icon + name + role
		const header = $$('div.agent-market-card-header');

		const icon = $$('div.agent-market-card-icon');
		icon.textContent = preset.icon || '🤖';
		header.appendChild(icon);

		const titleBox = $$('div.agent-market-card-title-box');
		const name = $$('div.agent-market-card-name');
		name.textContent = preset.name;
		titleBox.appendChild(name);

		const role = $$('div.agent-market-card-role');
		role.textContent = preset.role;
		titleBox.appendChild(role);
		header.appendChild(titleBox);

		// Category badge (top-right)
		const catBadge = $$('span.agent-market-card-cat');
		catBadge.textContent = preset.category;
		header.appendChild(catBadge);

		card.appendChild(header);

		// Description
		const desc = $$('p.agent-market-card-desc');
		desc.textContent = preset.description;
		card.appendChild(desc);

		// Skill tags
		if (preset.skills.length > 0) {
			const tags = $$('div.agent-market-card-tags');
			for (const skill of preset.skills.slice(0, 5)) {
				const tag = $$('span.agent-market-card-tag');
				tag.textContent = skill;
				tags.appendChild(tag);
			}
			card.appendChild(tags);
		}

		// Footer: model + deploy button
		const footer = $$('div.agent-market-card-footer');

		const model = $$('span.agent-market-card-model');
		model.textContent = preset.model;
		model.title = preset.model;
		footer.appendChild(model);

		const deployBtn = $$('button.agent-market-deploy-btn') as HTMLButtonElement;
		deployBtn.textContent = '部署';
		deployBtn.onclick = () => this._deployPreset(preset, deployBtn);
		footer.appendChild(deployBtn);

		card.appendChild(footer);

		return card;
	}

	private async _deployPreset(preset: AgentPreset, btn: HTMLButtonElement): Promise<void> {
		if (this._isDeploying) {
			return;
		}
		this._isDeploying = true;

		const originalText = btn.textContent;
		btn.textContent = '部署中…';
		btn.disabled = true;

		try {
			const agentData: Partial<Agent> = {
				name: preset.name,
				role: preset.role,
				model: preset.model,
				systemPrompt: preset.systemPrompt,
				skills: [...preset.skills],
				tools: preset.tools ? [...preset.tools] : undefined,
				handOffs: preset.handOffs,
				hooks: preset.hooks,
				visibility: preset.visibility,
				agents: preset.agents,
				confidenceThreshold: preset.confidenceThreshold,
				parallelStrategy: preset.parallelStrategy,
			};

			await this.agentStudioService.createAgent(agentData);
			this.notificationService.info(`智能体 "${preset.name}" 已成功部署到当前工作区。`);

			btn.textContent = '✓ 已部署';
			setTimeout(() => {
				btn.textContent = originalText;
				btn.disabled = false;
			}, 2000);
		} catch (err) {
			console.error('[AgentMarketEditorPane] deploy failed:', err);
			this.notificationService.error(`部署失败：${err instanceof Error ? err.message : String(err)}`);
			btn.textContent = originalText;
			btn.disabled = false;
		} finally {
			this._isDeploying = false;
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override dispose(): void {
		super.dispose();
	}
}
