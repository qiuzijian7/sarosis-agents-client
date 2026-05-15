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
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { $ } from '../../../../../base/browser/dom.js';
import type { Employee } from '../../common/types.js';

// ─── Preset Data Model ────────────────────────────────────────────────────────

interface AgentPreset {
	id: string;
	name: string;
	role: string;
	description: string;
	icon: string;
	model: string;
	skills: string[];
	category: PresetCategory;
	systemPrompt?: string;
	temperature?: number;
}

type PresetCategory = 'Development' | 'Research' | 'Creative' | 'Management' | 'DevOps' | 'Analytics';

const BUILTIN_PRESETS: AgentPreset[] = [
	{
		id: 'coder', name: 'Coder', role: 'Software Engineer',
		description: 'Writes, reviews, and refactors code with deep understanding of programming patterns and best practices.',
		icon: '👨‍💻', model: 'claude-sonnet-4-20250514',
		skills: ['code-gen', 'code-review', 'refactor'],
		category: 'Development',
		systemPrompt: 'You are an expert software engineer. Write clean, well-documented, and efficient code. Always consider edge cases and follow best practices.',
		temperature: 0.2,
	},
	{
		id: 'researcher', name: 'Researcher', role: 'Research Analyst',
		description: 'Gathers and synthesizes information from multiple sources, producing comprehensive research summaries.',
		icon: '🔬', model: 'claude-sonnet-4-20250514',
		skills: ['web-search', 'summarize', 'analysis'],
		category: 'Research',
		systemPrompt: 'You are a thorough research analyst. Gather information systematically, cross-reference sources, and present findings in a structured format.',
		temperature: 0.3,
	},
	{
		id: 'writer', name: 'Writer', role: 'Content Writer',
		description: 'Creates documentation, articles, and content with clarity and professional style.',
		icon: '✍️', model: 'claude-sonnet-4-20250514',
		skills: ['writing', 'editing', 'formatting'],
		category: 'Creative',
		systemPrompt: 'You are a skilled content writer. Produce clear, engaging, and well-structured content. Adapt your tone to the target audience.',
		temperature: 0.5,
	},
	{
		id: 'designer', name: 'Designer', role: 'UI/UX Designer',
		description: 'Designs interfaces and user experiences with a focus on usability and aesthetics.',
		icon: '🎨', model: 'claude-sonnet-4-20250514',
		skills: ['ui-design', 'prototyping', 'review'],
		category: 'Creative',
		systemPrompt: 'You are an experienced UI/UX designer. Focus on user-centered design principles, accessibility, and creating intuitive interfaces.',
		temperature: 0.4,
	},
	{
		id: 'planner', name: 'Planner', role: 'Project Manager',
		description: 'Plans tasks, coordinates workflows, and manages project timelines effectively.',
		icon: '📋', model: 'claude-sonnet-4-20250514',
		skills: ['planning', 'delegation', 'tracking'],
		category: 'Management',
		systemPrompt: 'You are a project manager. Break down complex goals into actionable tasks, set priorities, and track progress systematically.',
		temperature: 0.3,
	},
	{
		id: 'tester', name: 'Tester', role: 'QA Engineer',
		description: 'Tests and validates functionality, writes test cases, and ensures code quality.',
		icon: '🧪', model: 'claude-sonnet-4-20250514',
		skills: ['testing', 'bug-report', 'automation'],
		category: 'Development',
		systemPrompt: 'You are a QA engineer. Think critically about edge cases, write comprehensive test cases, and verify that all requirements are met.',
		temperature: 0.2,
	},
	{
		id: 'devops', name: 'DevOps', role: 'DevOps Engineer',
		description: 'Manages deployment pipelines, infrastructure, and monitors system health.',
		icon: '🚀', model: 'claude-sonnet-4-20250514',
		skills: ['deploy', 'ci-cd', 'monitoring'],
		category: 'DevOps',
		systemPrompt: 'You are a DevOps engineer. Automate deployment processes, maintain infrastructure as code, and ensure system reliability.',
		temperature: 0.2,
	},
	{
		id: 'data', name: 'Data Analyst', role: 'Data Scientist',
		description: 'Analyzes data, builds models, and generates actionable insights from datasets.',
		icon: '📊', model: 'claude-sonnet-4-20250514',
		skills: ['data-analysis', 'visualization', 'sql'],
		category: 'Analytics',
		systemPrompt: 'You are a data scientist. Analyze data rigorously, create clear visualizations, and provide actionable insights backed by evidence.',
		temperature: 0.3,
	},
];

const PRESET_CATEGORIES: { id: PresetCategory | 'All'; label: string }[] = [
	{ id: 'All', label: 'All' },
	{ id: 'Development', label: 'Dev' },
	{ id: 'Research', label: 'Research' },
	{ id: 'Creative', label: 'Creative' },
	{ id: 'Management', label: 'Mgmt' },
	{ id: 'DevOps', label: 'DevOps' },
	{ id: 'Analytics', label: 'Data' },
];

const AVAILABLE_MODELS = [
	{ id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
	{ id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
	{ id: 'gpt-4o', label: 'GPT-4o' },
	{ id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
	{ id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
];

const AVAILABLE_SKILLS = [
	'code-gen', 'code-review', 'refactor', 'testing', 'bug-report', 'automation',
	'web-search', 'summarize', 'analysis', 'data-analysis', 'visualization', 'sql',
	'writing', 'editing', 'formatting', 'ui-design', 'prototyping', 'review',
	'planning', 'delegation', 'tracking', 'deploy', 'ci-cd', 'monitoring',
	'file-ops', 'terminal', 'image-gen',
];

// ─── View Pane ────────────────────────────────────────────────────────────────

/**
 * Preset Agent View - 预设Agent模板管理
 * 功能：
 *  - 浏览内置/自定义预设模板（分类筛选 + 搜索）
 *  - 查看预设详情（展开/折叠）
 *  - 一键 Deploy 预设为 Employee
 *  - 创建自定义预设（内联表单）
 *  - 删除自定义预设
 */
export class PresetAgentViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private customPresets: AgentPreset[] = [];
	private activeCategory: PresetCategory | 'All' = 'All';
	private activeTab: 'builtin' | 'custom' = 'builtin';
	private expandedPresetId: string | null = null;
	private isDeploying = false;

	/** Dialog overlay elements */
	private dialogOverlay: HTMLElement | null = null;

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
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._loadCustomPresets();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('preset-agent-view');

		// Diagnostic: confirm renderBody is called
		const diag = document.createElement('div');
		diag.style.cssText = 'padding:8px 12px;color:#e74c3c;font-size:12px;background:#2d2d2d;border-bottom:1px solid #444;';
		diag.textContent = '⏳ Loading presets…';
		container.appendChild(diag);

		try {
			this._doRenderBody(container);
		} catch (err) {
			diag.textContent = `❌ Render error: ${err instanceof Error ? err.message : String(err)}`;
			diag.style.color = '#ff6b6b';
			console.error('[PresetAgentView] renderBody error:', err);
			return;
		}
		diag.remove();
	}

	private _doRenderBody(container: HTMLElement): void {
		// ── Header ───────────────────────────────────────────────────────────
		const header = $('div.preset-header');

		const titleRow = $('div.preset-title-row');
		const title = $('h3.preset-title');
		title.textContent = '🤖 Agent Presets';
		titleRow.appendChild(title);

		const countBadge = $('span.preset-count');
		const totalPresets = BUILTIN_PRESETS.length + this.customPresets.length;
		countBadge.textContent = `${totalPresets} presets`;
		titleRow.appendChild(countBadge);
		header.appendChild(titleRow);

		const addBtn = $('button.preset-add-btn');
		addBtn.textContent = '+ Custom';
		addBtn.title = 'Create a custom agent preset';
		addBtn.onclick = () => this._openCreateDialog();
		header.appendChild(addBtn);
		container.appendChild(header);

		// ── Search ───────────────────────────────────────────────────────────
		const searchBox = $('div.preset-search-box');
		const searchIcon = $('span.preset-search-icon');
		searchIcon.textContent = '🔍';
		searchBox.appendChild(searchIcon);

		this.searchInput = document.createElement('input');
		this.searchInput.type = 'text';
		this.searchInput.className = 'preset-search-input';
		this.searchInput.placeholder = 'Search presets...';
		this.searchInput.oninput = () => this._renderPresets();
		searchBox.appendChild(this.searchInput);
		container.appendChild(searchBox);

		// ── Tabs (Built-in / Custom) ─────────────────────────────────────────
		const tabs = $('div.preset-tabs');
		const builtinTab = $('button.preset-tab.active');
		builtinTab.textContent = `Built-in (${BUILTIN_PRESETS.length})`;
		builtinTab.onclick = () => this._switchTab('builtin', builtinTab, tabs);
		tabs.appendChild(builtinTab);

		const customTab = $('button.preset-tab');
		customTab.textContent = `Custom (${this.customPresets.length})`;
		customTab.onclick = () => this._switchTab('custom', customTab, tabs);
		tabs.appendChild(customTab);
		container.appendChild(tabs);

		// ── Category Filters (only for Built-in tab) ────────────────────────
		const filterRow = $('div.preset-category-filters');
		for (const cat of PRESET_CATEGORIES) {
			const btn = $('button.preset-cat-btn');
			btn.textContent = cat.label;
			if (cat.id === 'All') { btn.classList.add('active'); }
			btn.onclick = () => {
				filterRow.querySelectorAll('.preset-cat-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeCategory = cat.id as PresetCategory | 'All';
				this._renderPresets();
			};
			filterRow.appendChild(btn);
		}
		container.appendChild(filterRow);

		// ── Preset List ──────────────────────────────────────────────────────
		this.listContainer = $('div.preset-grid');
		this._renderPresets();
		container.appendChild(this.listContainer);
	}

	// ── Tab Switching ────────────────────────────────────────────────────────

	private _switchTab(tab: 'builtin' | 'custom', activeTab: HTMLElement, tabsContainer: HTMLElement): void {
		tabsContainer.querySelectorAll('.preset-tab').forEach(t => t.classList.remove('active'));
		activeTab.classList.add('active');
		this.activeTab = tab;
		this.activeCategory = 'All';
		// Reset category filter
		const catFilters = this.element?.querySelectorAll('.preset-cat-btn');
		catFilters?.forEach((b, i) => {
			b.classList.toggle('active', i === 0);
		});
		this._renderPresets();
	}

	// ── Render Preset Cards ──────────────────────────────────────────────────

	private _getFilteredPresets(): AgentPreset[] {
		let presets = this.activeTab === 'builtin' ? BUILTIN_PRESETS : this.customPresets;

		// Category filter (only for builtin)
		if (this.activeTab === 'builtin' && this.activeCategory !== 'All') {
			presets = presets.filter(p => p.category === this.activeCategory);
		}

		// Search filter
		const query = this.searchInput?.value?.toLowerCase().trim();
		if (query) {
			presets = presets.filter(p =>
				p.name.toLowerCase().includes(query) ||
				p.role.toLowerCase().includes(query) ||
				p.description.toLowerCase().includes(query) ||
				p.skills.some(s => s.toLowerCase().includes(query))
			);
		}

		return presets;
	}

	private _renderPresets(): void {
		try {
			if (!this.listContainer) { return; }
			this.listContainer.textContent = '';
			const presets = this._getFilteredPresets();

			if (presets.length === 0) {
				const empty = $('div.preset-empty');
				const emptyIcon = $('div.empty-icon');
				emptyIcon.textContent = this.activeTab === 'custom' ? '🔧' : '🔍';
				empty.appendChild(emptyIcon);

				const emptyText = $('p');
				emptyText.textContent = this.activeTab === 'custom'
					? 'No custom presets yet'
					: 'No presets match your search';
				empty.appendChild(emptyText);

				const emptyHint = $('p.empty-hint');
				emptyHint.textContent = this.activeTab === 'custom'
					? 'Create a custom preset to reuse agent configurations'
					: 'Try adjusting your search or category filter';
				empty.appendChild(emptyHint);

				if (this.activeTab === 'custom') {
					const createBtn = $('button.preset-deploy-btn');
					createBtn.textContent = '+ Create Custom Preset';
					createBtn.style.marginTop = '12px';
					createBtn.onclick = () => this._openCreateDialog();
					empty.appendChild(createBtn);
				}

				this.listContainer.appendChild(empty);
				return;
			}

			for (const preset of presets) {
				const card = this._createPresetCard(preset);
				this.listContainer.appendChild(card);
			}
		} catch (err) {
			console.error('[PresetAgentView] _renderPresets error:', err);
			if (this.listContainer) {
				this.listContainer.textContent = '';
				const errEl = document.createElement('div');
				errEl.style.cssText = 'padding:16px;color:#ff6b6b;font-size:12px;';
				errEl.textContent = `Failed to render presets: ${err instanceof Error ? err.message : String(err)}`;
				this.listContainer.appendChild(errEl);
			}
		}
	}

	private _createPresetCard(preset: AgentPreset): HTMLElement {
		const isExpanded = this.expandedPresetId === preset.id;
		const isCustom = this.activeTab === 'custom';

		const card = $('div.preset-card');
		if (isExpanded) { card.classList.add('expanded'); }

		// ── Card Header (always visible) ─────────────────────────────────
		const cardHeader = $('div.preset-card-header');

		const iconEl = $('div.preset-icon');
		iconEl.textContent = preset.icon;
		cardHeader.appendChild(iconEl);

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
		cardHeader.appendChild(info);

		// Expand/collapse chevron
		const chevron = $('div.preset-chevron');
		chevron.textContent = isExpanded ? '▾' : '▸';
		cardHeader.appendChild(chevron);

		cardHeader.onclick = () => {
			this.expandedPresetId = this.expandedPresetId === preset.id ? null : preset.id;
			this._renderPresets();
		};

		card.appendChild(cardHeader);

		// ── Skills Row (always visible) ──────────────────────────────────
		const skillsEl = $('div.preset-skills');
		for (const skill of preset.skills) {
			const tag = $('span.skill-tag');
			tag.textContent = skill;
			skillsEl.appendChild(tag);
		}
		card.appendChild(skillsEl);

		// ── Expanded Details ─────────────────────────────────────────────
		if (isExpanded) {
			const details = $('div.preset-details');

			// Model
			const modelRow = $('div.preset-detail-row');
			const modelLabel = $('span.preset-detail-label');
			modelLabel.textContent = 'Model';
			modelRow.appendChild(modelLabel);
			const modelValue = $('span.preset-detail-value');
			const modelInfo = AVAILABLE_MODELS.find(m => m.id === preset.model);
			modelValue.textContent = modelInfo?.label ?? preset.model;
			modelRow.appendChild(modelValue);
			details.appendChild(modelRow);

			// Temperature
			if (preset.temperature !== undefined) {
				const tempRow = $('div.preset-detail-row');
				const tempLabel = $('span.preset-detail-label');
				tempLabel.textContent = 'Temperature';
				tempRow.appendChild(tempLabel);
				const tempValue = $('span.preset-detail-value');
				tempValue.textContent = String(preset.temperature);
				tempRow.appendChild(tempValue);
				details.appendChild(tempRow);
			}

			// System Prompt
			if (preset.systemPrompt) {
				const promptSection = $('div.preset-detail-prompt');
				const promptLabel = $('div.preset-detail-label');
				promptLabel.textContent = 'System Prompt';
				promptSection.appendChild(promptLabel);
				const promptText = $('div.preset-detail-prompt-text');
				promptText.textContent = preset.systemPrompt;
				promptSection.appendChild(promptText);
				details.appendChild(promptSection);
			}

			// Action buttons
			const actions = $('div.preset-detail-actions');

			const deployBtn = $('button.preset-deploy-btn');
			deployBtn.textContent = '▶ Deploy Agent';
			deployBtn.onclick = (e) => {
				e.stopPropagation();
				this._deployPreset(preset);
			};
			actions.appendChild(deployBtn);

			if (isCustom) {
				const editBtn = $('button.preset-edit-btn');
				editBtn.textContent = '✏ Edit';
				editBtn.onclick = (e) => {
					e.stopPropagation();
					this._openEditDialog(preset);
				};
				actions.appendChild(editBtn);

				const deleteBtn = $('button.preset-delete-btn');
				deleteBtn.textContent = '🗑 Delete';
				deleteBtn.onclick = (e) => {
					e.stopPropagation();
					this._deleteCustomPreset(preset.id);
				};
				actions.appendChild(deleteBtn);
			}

			details.appendChild(actions);
			card.appendChild(details);
		}

		// ── Quick Deploy (when not expanded) ─────────────────────────────
		if (!isExpanded) {
			const quickActions = $('div.preset-quick-actions');
			const deployBtn = $('button.preset-quick-deploy');
			deployBtn.textContent = '▶';
			deployBtn.title = `Deploy ${preset.name}`;
			deployBtn.onclick = (e) => {
				e.stopPropagation();
				this._deployPreset(preset);
			};
			quickActions.appendChild(deployBtn);
			card.appendChild(quickActions);
		}

		return card;
	}

	// ── Deploy ───────────────────────────────────────────────────────────────

	private async _deployPreset(preset: AgentPreset): Promise<void> {
		if (this.isDeploying) { return; }
		this.isDeploying = true;

		try {
			const employeeData: Partial<Employee> = {
				name: preset.name,
				role: preset.role,
				presetId: preset.id,
				model: preset.model,
				customPrompt: preset.systemPrompt,
				skills: preset.skills.map(s => ({ id: s, name: s, enabled: true })),
			};
			const employee = await this.agentStudioService.createEmployee(employeeData);
			this.notificationService.info(
				`Agent "${preset.name}" deployed successfully (ID: ${employee.id.slice(0, 8)}...)`
			);
		} catch (err) {
			this.notificationService.error(
				`Failed to deploy agent "${preset.name}": ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			this.isDeploying = false;
		}
	}

	// ── Custom Preset CRUD ───────────────────────────────────────────────────

	private _loadCustomPresets(): void {
		try {
			if (typeof localStorage !== 'undefined') {
				const stored = localStorage.getItem('agentStudio.customPresets');
				if (stored) {
					this.customPresets = JSON.parse(stored);
				}
			}
		} catch {
			this.customPresets = [];
		}
	}

	private _saveCustomPresets(): void {
		try {
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem('agentStudio.customPresets', JSON.stringify(this.customPresets));
			}
		} catch {
			// storage full or unavailable
		}
	}

	private _deleteCustomPreset(id: string): void {
		this.customPresets = this.customPresets.filter(p => p.id !== id);
		this._saveCustomPresets();
		if (this.expandedPresetId === id) {
			this.expandedPresetId = null;
		}
		this._updateCustomTabCount();
		this._renderPresets();
		this.notificationService.info('Custom preset deleted');
	}

	private _updateCustomTabCount(): void {
		const tab = this.element?.querySelectorAll('.preset-tab')[1];
		if (tab) {
			tab.textContent = `Custom (${this.customPresets.length})`;
		}
		// Update total count
		const countBadge = this.element?.querySelector('.preset-count');
		if (countBadge) {
			countBadge.textContent = `${BUILTIN_PRESETS.length + this.customPresets.length} presets`;
		}
	}

	// ── Create / Edit Dialog ─────────────────────────────────────────────────

	private _openCreateDialog(): void {
		this._showPresetDialog(null);
	}

	private _openEditDialog(preset: AgentPreset): void {
		this._showPresetDialog(preset);
	}

	private _showPresetDialog(existingPreset: AgentPreset | null): void {
		// Remove any existing dialog
		this._closeDialog();

		const isEdit = existingPreset !== null;
		const overlay = $('div.preset-dialog-overlay');
		this.dialogOverlay = overlay;

		const dialog = $('div.preset-dialog');

		// Title
		const title = $('div.preset-dialog-title');
		title.textContent = isEdit ? 'Edit Custom Preset' : 'Create Custom Preset';
		dialog.appendChild(title);

		// Form fields
		const form = $('div.preset-dialog-form');

		// Name
		const nameField = this._createFormField('Name', 'text', existingPreset?.name ?? '', 'e.g. Code Reviewer');
		form.appendChild(nameField);

		// Role
		const roleField = this._createFormField('Role', 'text', existingPreset?.role ?? '', 'e.g. Senior Code Reviewer');
		form.appendChild(roleField);

		// Icon (emoji picker simplified)
		const iconRow = $('div.preset-dialog-field');
		const iconLabel = $('label.preset-dialog-label');
		iconLabel.textContent = 'Icon';
		iconRow.appendChild(iconLabel);
		const iconInput = document.createElement('input');
		iconInput.type = 'text';
		iconInput.className = 'preset-dialog-input preset-dialog-input-icon';
		iconInput.value = existingPreset?.icon ?? '🔧';
		iconInput.maxLength = 4;
		iconRow.appendChild(iconInput);
		form.appendChild(iconRow);

		// Description
		const descField = this._createTextAreaField('Description', existingPreset?.description ?? '', 'Describe what this agent does...');
		form.appendChild(descField);

		// Model
		const modelRow = $('div.preset-dialog-field');
		const modelLabel = $('label.preset-dialog-label');
		modelLabel.textContent = 'Model';
		modelRow.appendChild(modelLabel);
		const modelSelect = document.createElement('select');
		modelSelect.className = 'preset-dialog-select';
		for (const m of AVAILABLE_MODELS) {
			const opt = document.createElement('option');
			opt.value = m.id;
			opt.textContent = m.label;
			if (m.id === (existingPreset?.model ?? 'claude-sonnet-4-20250514')) {
				opt.selected = true;
			}
			modelSelect.appendChild(opt);
		}
		modelRow.appendChild(modelSelect);
		form.appendChild(modelRow);

		// Temperature
		const tempField = this._createFormField('Temperature', 'number', String(existingPreset?.temperature ?? 0.3), '0.0 - 1.0');
		form.appendChild(tempField);

		// Skills (multi-select chips)
		const skillsRow = $('div.preset-dialog-field');
		const skillsLabel = $('label.preset-dialog-label');
		skillsLabel.textContent = 'Skills';
		skillsRow.appendChild(skillsLabel);
		const skillsChips = $('div.preset-dialog-skills-chips');
		const selectedSkills = new Set(existingPreset?.skills ?? []);
		for (const skill of AVAILABLE_SKILLS) {
			const chip = $('button.preset-skill-chip');
			chip.textContent = skill;
			if (selectedSkills.has(skill)) { chip.classList.add('selected'); }
			chip.onclick = (e) => {
				e.preventDefault();
				chip.classList.toggle('selected');
			};
			skillsChips.appendChild(chip);
		}
		skillsRow.appendChild(skillsChips);
		form.appendChild(skillsRow);

		// System Prompt
		const promptField = this._createTextAreaField('System Prompt', existingPreset?.systemPrompt ?? '', 'Define the agent\'s behavior and persona...');
		form.appendChild(promptField);

		dialog.appendChild(form);

		// Actions
		const actions = $('div.preset-dialog-actions');
		const cancelBtn = $('button.preset-dialog-btn-cancel');
		cancelBtn.textContent = 'Cancel';
		cancelBtn.onclick = () => this._closeDialog();
		actions.appendChild(cancelBtn);

		const saveBtn = $('button.preset-dialog-btn-save');
		saveBtn.textContent = isEdit ? 'Save Changes' : 'Create Preset';
		saveBtn.onclick = () => {
			const name = (nameField.querySelector('input') as HTMLInputElement).value.trim();
			const role = (roleField.querySelector('input') as HTMLInputElement).value.trim();
			const icon = iconInput.value.trim() || '🔧';
			const description = (descField.querySelector('textarea') as HTMLTextAreaElement).value.trim();
			const model = modelSelect.value;
			const temperature = parseFloat((tempField.querySelector('input') as HTMLInputElement).value) || 0.3;
			const skills = Array.from(skillsChips.querySelectorAll('.preset-skill-chip.selected'))
				.map(c => c.textContent ?? '');
			const systemPrompt = (promptField.querySelector('textarea') as HTMLTextAreaElement).value.trim();

			if (!name) {
				this.notificationService.warn('Preset name is required');
				return;
			}
			if (!role) {
				this.notificationService.warn('Preset role is required');
				return;
			}

			if (isEdit && existingPreset) {
				const idx = this.customPresets.findIndex(p => p.id === existingPreset.id);
				if (idx >= 0) {
					this.customPresets[idx] = {
						...existingPreset,
						name, role, icon, description, model,
						temperature: Math.max(0, Math.min(1, temperature)),
						skills, systemPrompt,
					};
				}
			} else {
				const newPreset: AgentPreset = {
					id: `custom-${Date.now()}`,
					name, role, icon, description, model,
					temperature: Math.max(0, Math.min(1, temperature)),
					skills, systemPrompt,
					category: 'Development', // default category for custom
				};
				this.customPresets.push(newPreset);
			}

			this._saveCustomPresets();
			this._updateCustomTabCount();
			this._renderPresets();
			this._closeDialog();
			this.notificationService.info(isEdit ? 'Preset updated' : 'Custom preset created');
		};
		actions.appendChild(saveBtn);
		dialog.appendChild(actions);

		overlay.appendChild(dialog);
		overlay.onclick = (e) => {
			if (e.target === overlay) { this._closeDialog(); }
		};

		// Mount dialog to the view container
		const viewEl = this.element;
		if (viewEl) {
			viewEl.appendChild(overlay);
		}
	}

	private _closeDialog(): void {
		if (this.dialogOverlay) {
			this.dialogOverlay.remove();
			this.dialogOverlay = null;
		}
	}

	private _createFormField(label: string, type: string, value: string, placeholder: string): HTMLElement {
		const field = $('div.preset-dialog-field');
		const labelEl = $('label.preset-dialog-label');
		labelEl.textContent = label;
		field.appendChild(labelEl);

		const input = document.createElement('input');
		input.type = type;
		input.className = 'preset-dialog-input';
		input.value = value;
		input.placeholder = placeholder;
		if (type === 'number') {
			input.min = '0';
			input.max = '1';
			input.step = '0.1';
			input.className += ' preset-dialog-input-number';
		}
		field.appendChild(input);
		return field;
	}

	private _createTextAreaField(label: string, value: string, placeholder: string): HTMLElement {
		const field = $('div.preset-dialog-field');
		const labelEl = $('label.preset-dialog-label');
		labelEl.textContent = label;
		field.appendChild(labelEl);

		const textarea = document.createElement('textarea');
		textarea.className = 'preset-dialog-textarea';
		textarea.value = value;
		textarea.placeholder = placeholder;
		textarea.rows = 3;
		field.appendChild(textarea);
		return field;
	}

	// ── Layout ───────────────────────────────────────────────────────────────

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// The container is .pane-body which also has .preset-agent-view class.
		// It sits inside .pane (display:flex, flex-direction:column).
		// We override flex:1 with flex:none + explicit pixel height to ensure
		// the container gets exactly the right height from the splitview layout.
		// The children (.preset-header, .preset-search-box, etc.) are flex-shrink:0,
		// and .preset-grid uses flex:1 + min-height:0 to fill remaining space.
		const container = this.listContainer?.parentElement;
		if (container) {
			container.style.height = `${height}px`;
			container.style.flex = 'none';
		}
		// Debug: log layout dimensions and parent hierarchy with class names
		console.log(`[PresetAgent] layoutBody: height=${height}, width=${width}`);
		if (container) {
			let el: HTMLElement | null = container;
			let level = 0;
			const labels = ['container(body)', 'pane', 'split-view-view', 'split-view-container', 'scrollable', 'monaco-pane-view', 'composite?', 'content?', 'part?'];
			while (el && level < 9) {
				console.log(`[PresetAgent] L${level}(${labels[level]}): class="${el.className}", clientH=${el.clientHeight}, styleH="${el.style.height}", offsetH=${el.offsetHeight}`);
				el = el.parentElement;
				level++;
			}
		}
	}
}
