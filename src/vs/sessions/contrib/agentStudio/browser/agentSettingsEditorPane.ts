/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSettingsEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { ISkillRegistry } from '../common/skills.js';
import { IMarketplaceService, PackageKind } from '../common/marketplace.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';

const { $: $$ } = DOM;

type TabId = 'prompt' | 'skills' | 'mcp' | 'rules';

interface TabDef {
	id: TabId;
	label: string;
	icon: string;
}

const TABS: TabDef[] = [
	{ id: 'prompt', label: 'System Prompt', icon: '💬' },
	{ id: 'skills', label: '技能配置', icon: '🛠' },
	{ id: 'mcp', label: 'MCP 配置', icon: '🔌' },
	{ id: 'rules', label: 'Rule 配置', icon: '📏' },
];

/**
 * AgentSettingsEditorPane — Native DOM-based editor pane for agent settings.
 *
 * Replaces the previous webview-based approach. Renders directly with DOM:
 *   - Header: agent info card with inline rename
 *   - Tabs: System Prompt | Skills | MCP | Rules
 *
 * Data is loaded via IAgentStudioService (injected) — no webview bridge.
 */
export class AgentSettingsEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.agentSettingsPane';

	private _container: HTMLElement | undefined;
	private _agentId: string | undefined;
	private _agent: Agent | undefined;
	private _activeTab: TabId = 'prompt';

	// ── DOM element references ──
	private _tabContentContainer: HTMLElement | undefined;
	private _nameEl: HTMLElement | undefined;
	private _iconEl: HTMLElement | undefined;
	private _descEl: HTMLElement | undefined;
	private _statsEl: HTMLElement | undefined;
	private _agentIdEl: HTMLElement | undefined;

	// ── Upload state ──
	private _uploadBtn: HTMLButtonElement | undefined;
	private _isUploaded = false;

	// ── Rename state ──
	private _renameInput: HTMLInputElement | undefined;
	private _renameError: HTMLElement | undefined;

	// ── System Prompt tab ──
	private _promptTextarea: HTMLTextAreaElement | undefined;
	private _promptSaveBtn: HTMLButtonElement | undefined;
	private _promptDirty = false;

	// ── Skills tab ──
	private _skillsInstalledContainer: HTMLElement | undefined;
	private _skillsAvailableContainer: HTMLElement | undefined;
	private _allSkills: Array<{ id: string; name: string; category: string; activation: string; description?: string }> = [];
	private _agentSkills: string[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(AgentSettingsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $$('div.agent-settings-editor');
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof AgentSettingsEditorInput) || !this._container) {
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}

		this._agentId = input.agentId;
		this._container.replaceChildren();
		this._buildUI(this._container);

		// Load agent data
		await this._loadAgentData();

		// Check upload status (show/hide upload button)
		await this._checkUploadStatus();

		// Load skills
		await this._loadSkills();

		// Listen for agent changes (external updates)
		this._register(this.agentStudioService.onDidChangeAgents(async () => {
			await this._loadAgentData();
			await this._checkUploadStatus();
		}));
	}

	// ═══════════════════════════════════════════════════════════════════════════
	//  UI Building
	// ═══════════════════════════════════════════════════════════════════════════

	private _buildUI(container: HTMLElement): void {
		// ── Loading placeholder ──
		const loading = $$('div.agent-settings-loading');
		loading.textContent = '⏳ 加载中...';
		container.appendChild(loading);

		// ── Main layout (hidden until data loads) ──
		const main = $$('div.agent-settings-main');
		main.style.display = 'none';
		container.appendChild(main);

		// Header
		this._buildHeader(main);

		// Tab bar
		this._buildTabBar(main);

		// Tab content container
		this._tabContentContainer = $$('div.agent-settings-tab-content');
		main.appendChild(this._tabContentContainer);

		// Build all tab contents
		this._buildPromptTab();
		this._buildSkillsTab();
		this._buildPlaceholderTab('mcp');
		this._buildPlaceholderTab('rules');

		this._showTab(this._activeTab);
	}

	private _buildHeader(parent: HTMLElement): void {
		const header = $$('div.agent-settings-header');

		// ── Row 1: Avatar + Title line + Actions ──
		const row1 = $$('div.agent-settings-row1');

		// Avatar
		this._iconEl = $$('div.agent-settings-avatar');
		this._iconEl.textContent = '🤖';
		row1.appendChild(this._iconEl);

		// Title line (name + rename trigger)
		const titleLine = $$('div.agent-settings-title-line');

		this._nameEl = $$('span.agent-settings-name');
		this._nameEl.textContent = 'Loading...';
		this._nameEl.title = '双击重命名';
		this._nameEl.classList.add('editable');
		this._nameEl.ondblclick = () => this._startRename();
		titleLine.appendChild(this._nameEl);

		const renameBtn = $$('button.agent-settings-rename-btn');
		renameBtn.textContent = '✏️';
		renameBtn.title = '重命名';
		renameBtn.onclick = () => this._startRename();
		titleLine.appendChild(renameBtn);

		// Rename input (hidden by default)
		const renameContainer = $$('div.agent-settings-rename');
		renameContainer.style.display = 'none';

		this._renameInput = document.createElement('input');
		this._renameInput.className = 'agent-rename-input';
		this._renameInput.type = 'text';
		this._renameInput.placeholder = '输入新名称';
		this._renameInput.onkeydown = (e) => {
			if (e.key === 'Enter') { e.preventDefault(); this._confirmRename(); }
			else if (e.key === 'Escape') { e.preventDefault(); this._cancelRename(); }
		};
		renameContainer.appendChild(this._renameInput);

		const confirmBtn = $$('button.agent-rename-confirm') as HTMLButtonElement;
		confirmBtn.textContent = '✓';
		confirmBtn.title = '确认';
		confirmBtn.onclick = () => this._confirmRename();
		renameContainer.appendChild(confirmBtn);

		const cancelBtn = $$('button.agent-rename-cancel') as HTMLButtonElement;
		cancelBtn.textContent = '✕';
		cancelBtn.title = '取消';
		cancelBtn.onclick = () => this._cancelRename();
		renameContainer.appendChild(cancelBtn);

		this._renameError = $$('div.agent-rename-error');
		this._renameError.style.display = 'none';
		renameContainer.appendChild(this._renameError);

		titleLine.appendChild(renameContainer);
		row1.appendChild(titleLine);

		// Actions (in row1, right-aligned)
		const actions = $$('div.agent-settings-actions');

		const uploadBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		this._uploadBtn = uploadBtn as HTMLButtonElement;
		uploadBtn.textContent = '📤 上传';
		uploadBtn.title = '上传 Agent 到商城';
		uploadBtn.style.display = 'none'; // shown after checking upload status
		uploadBtn.onclick = () => this._handleUpload();
		actions.appendChild(uploadBtn);

		const configHtmlBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		configHtmlBtn.textContent = '🌐 ConfigHtml';
		configHtmlBtn.title = '打开 ConfigHTML 预览';
		configHtmlBtn.onclick = () => this._openConfigHtmlPreview();
		actions.appendChild(configHtmlBtn);

		const exportBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		exportBtn.textContent = '📦 导出';
		exportBtn.onclick = () => this._handleExport();
		actions.appendChild(exportBtn);

		const chatBtn = $$('button.agent-settings-btn primary') as HTMLButtonElement;
		chatBtn.textContent = '💬 对话';
		chatBtn.onclick = () => this._handleChat();
		actions.appendChild(chatBtn);

		row1.appendChild(actions);
		header.appendChild(row1);

		// ── Row 2: Description + Stats ──
		const row2 = $$('div.agent-settings-row2');

		this._descEl = $$('div.agent-settings-desc');
		row2.appendChild(this._descEl);

		this._agentIdEl = $$('div.agent-settings-agentid');
		row2.appendChild(this._agentIdEl);

		this._statsEl = $$('div.agent-settings-stats');
		row2.appendChild(this._statsEl);

		header.appendChild(row2);
		parent.appendChild(header);
	}

	private _buildTabBar(parent: HTMLElement): void {
		const tabBar = $$('div.agent-settings-tabs');
		for (const tab of TABS) {
			const btn = $$('button.agent-settings-tab') as HTMLButtonElement;
			if (tab.id === this._activeTab) { btn.classList.add('active'); }
			const iconSpan = $$('span.tab-icon');
			iconSpan.textContent = tab.icon;
			btn.appendChild(iconSpan);
			const labelSpan = $$('span.tab-label');
			labelSpan.textContent = tab.label;
			btn.appendChild(labelSpan);
			btn.onclick = () => {
				this._activeTab = tab.id;
				this._showTab(tab.id);
			};
			btn.dataset.tabId = tab.id;
			tabBar.appendChild(btn);
		}
		parent.appendChild(tabBar);
	}

	// ── System Prompt Tab ──

	private _buildPromptTab(): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = 'prompt';

		const desc = $$('div.tab-pane-desc');
		desc.textContent = '编辑 Agent 的系统提示词。此提示词将作为每次对话的开场指令注入到 LLM 上下文中。';
		section.appendChild(desc);

		this._promptTextarea = document.createElement('textarea');
		this._promptTextarea.className = 'agent-settings-prompt-textarea';
		this._promptTextarea.placeholder = '输入 System Prompt...';
		this._promptTextarea.oninput = () => {
			this._promptDirty = true;
			if (this._promptSaveBtn) {
				this._promptSaveBtn.disabled = false;
				this._promptSaveBtn.textContent = '💾 保存';
			}
		};
		section.appendChild(this._promptTextarea);

		const footer = $$('div.tab-pane-footer');
		this._promptSaveBtn = $$('button.agent-settings-btn primary') as HTMLButtonElement;
		this._promptSaveBtn.textContent = '💾 保存';
		this._promptSaveBtn.disabled = true;
		this._promptSaveBtn.onclick = () => this._savePrompt();
		footer.appendChild(this._promptSaveBtn);
		section.appendChild(footer);

		this._tabContentContainer?.appendChild(section);
	}

	// ── Skills Tab ──

	private _buildSkillsTab(): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = 'skills';

		const desc = $$('div.tab-pane-desc');
		desc.textContent = '为 Agent 配置技能。点击右侧可用技能添加，点击左侧已安装技能移除。';
		section.appendChild(desc);

		const panel = $$('div.skills-dnd-panel');

		// Left: installed skills
		const leftCol = $$('div.skills-column');
		const leftHeader = $$('div.skills-column-header');
		leftHeader.textContent = '已安装技能';
		leftCol.appendChild(leftHeader);
		this._skillsInstalledContainer = $$('div.skills-list');
		leftCol.appendChild(this._skillsInstalledContainer);
		panel.appendChild(leftCol);

		// Right: available skills
		const rightCol = $$('div.skills-column');
		const rightHeader = $$('div.skills-column-header');
		rightHeader.textContent = '可用技能';
		rightCol.appendChild(rightHeader);
		const rightFilter = document.createElement('input');
		rightFilter.className = 'skills-filter-input';
		rightFilter.type = 'text';
		rightFilter.placeholder = '搜索技能...';
		rightCol.appendChild(rightFilter);
		this._skillsAvailableContainer = $$('div.skills-list');
		rightCol.appendChild(this._skillsAvailableContainer);
		panel.appendChild(rightCol);

		section.appendChild(panel);
		this._tabContentContainer?.appendChild(section);
	}

	// ── Placeholder Tab ──

	private _buildPlaceholderTab(tabId: TabId): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = tabId;

		const placeholder = $$('div.tab-pane-placeholder');
		placeholder.textContent = '🚧 即将上线';
		section.appendChild(placeholder);

		this._tabContentContainer?.appendChild(section);
	}

	// ═══════════════════════════════════════════════════════════════════════════
	//  Tab switching
	// ═══════════════════════════════════════════════════════════════════════════

	private _showTab(tabId: TabId): void {
		if (!this._tabContentContainer) { return; }
		// Update tab buttons
		const tabs = this._container?.querySelectorAll('.agent-settings-tab');
		tabs?.forEach(t => {
			t.classList.toggle('active', t.getAttribute('data-tab-id') === tabId);
		});
		// Show/hide panes
		const panes = this._tabContentContainer.querySelectorAll('[data-tab-pane]');
		panes?.forEach(p => {
			p.classList.toggle('active', p.getAttribute('data-tab-pane') === tabId);
		});
	}

	// ═══════════════════════════════════════════════════════════════════════════
	//  Data Loading
	// ═══════════════════════════════════════════════════════════════════════════

	private async _loadAgentData(): Promise<void> {
		if (!this._agentId) { return; }
		try {
			this._agent = await this.agentStudioService.getAgent(this._agentId);
			if (!this._agent) {
				this.notificationService.warn(`Agent not found: ${this._agentId}`);
				return;
			}

			// Show main, hide loading
			const loading = this._container?.querySelector('.agent-settings-loading');
			if (loading) { loading.remove(); }
			const main = this._container?.querySelector('.agent-settings-main') as HTMLElement;
			if (main) { main.style.display = ''; }

			// Update header
			this._renderHeader();

			// Sync editor tab label in case the name changed externally
			const input = this.input as AgentSettingsEditorInput | undefined;
			if (input && input.agentName !== this._agent.name) {
				input.setAgentName(this._agent.name);
			}

			// Update system prompt
			const promptValue = (this._agent as any).customPrompt || this._agent.systemPrompt || '';
			if (this._promptTextarea && !this._promptDirty) {
				this._promptTextarea.value = promptValue;
			}

			// Update skills
			this._agentSkills = this._agent.skills || [];
			this._renderSkills();
		} catch (err) {
			this.notificationService.error(`加载 Agent 数据失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _loadSkills(): Promise<void> {
		try {
			await this.skillRegistry.whenReady();
			const skills = this.skillRegistry.getSkills();
			this._allSkills = skills.map(s => ({
				id: s.id,
				name: s.name,
				category: s.category || 'uncategorized',
				activation: s.activation,
				description: s.description || undefined,
			}));
			this._renderSkills();
		} catch (err) {
			console.warn('[AgentSettingsEditorPane] Failed to load skills:', err);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	//  Rendering
	// ═══════════════════════════════════════════════════════════════════════════

	private _renderHeader(): void {
		if (!this._agent) { return; }
		if (this._iconEl) { this._iconEl.textContent = this._agent.icon || '🤖'; }
		if (this._nameEl) { this._nameEl.textContent = this._agent.name; }
		if (this._descEl) { this._descEl.textContent = this._agent.description || this._agent.role; }
		if (this._agentIdEl) { this._agentIdEl.textContent = `ID: ${this._agentId}`; }
		if (this._statsEl) {
			this._statsEl.replaceChildren();
			const skillsCount = this._agent.skills?.length || 0;
			const model = this._agent.model || 'default';
			const category = this._agent.category || '';

			const stat1 = $$('span.stat-item');
			const stat1Icon = $$('span.stat-icon'); stat1Icon.textContent = '🛠'; stat1.appendChild(stat1Icon);
			stat1.appendChild(document.createTextNode(' '));
			const stat1Val = $$('span.stat-value'); stat1Val.textContent = String(skillsCount); stat1.appendChild(stat1Val);
			stat1.appendChild(document.createTextNode(' skills'));
			this._statsEl.appendChild(stat1);

			const stat2 = $$('span.stat-item');
			const stat2Icon = $$('span.stat-icon'); stat2Icon.textContent = '🤖'; stat2.appendChild(stat2Icon);
			stat2.appendChild(document.createTextNode(' '));
			const stat2Val = $$('span.stat-value'); stat2Val.textContent = model; stat2.appendChild(stat2Val);
			this._statsEl.appendChild(stat2);

			if (category) {
				const stat3 = $$('span.stat-item');
				const stat3Icon = $$('span.stat-icon'); stat3Icon.textContent = '📂'; stat3.appendChild(stat3Icon);
				stat3.appendChild(document.createTextNode(' ' + category));
				this._statsEl.appendChild(stat3);
			}
		}
	}

	private _renderSkills(): void {
		if (!this._skillsInstalledContainer || !this._skillsAvailableContainer) { return; }
		// Installed skills
		this._skillsInstalledContainer.replaceChildren();
		if (this._agentSkills.length === 0) {
			const empty = $$('div.skills-empty');
			empty.textContent = '暂无已安装技能';
			this._skillsInstalledContainer.appendChild(empty);
		} else {
			for (const skillId of this._agentSkills) {
				const skill = this._allSkills.find(s => s.id === skillId);
				const item = $$('div.skill-item installed');
				const info = $$('div.skill-item-info');
				const nameEl = $$('span.skill-item-name');
				nameEl.textContent = skill?.name || skillId;
				info.appendChild(nameEl);
				if (skill?.category) {
					const catEl = $$('span.skill-item-cat');
					catEl.textContent = skill.category;
					info.appendChild(catEl);
				}
				item.appendChild(info);
				const removeBtn = $$('button.skill-remove-btn') as HTMLButtonElement;
				removeBtn.title = '移除';
				removeBtn.textContent = '✕';
				removeBtn.onclick = () => this._removeSkill(skillId);
				item.appendChild(removeBtn);
				this._skillsInstalledContainer.appendChild(item);
			}
		}

		// Available skills
		this._skillsAvailableContainer.replaceChildren();
		const available = this._allSkills.filter(s => !this._agentSkills.includes(s.id));
		if (available.length === 0) {
			const empty = $$('div.skills-empty');
			empty.textContent = '无可用技能';
			this._skillsAvailableContainer.appendChild(empty);
		} else {
			for (const skill of available) {
				const item = $$('div.skill-item available');
				const info = $$('div.skill-item-info');
				const nameEl = $$('span.skill-item-name');
				nameEl.textContent = skill.name;
				info.appendChild(nameEl);
				const catEl = $$('span.skill-item-cat');
				catEl.textContent = skill.category;
				info.appendChild(catEl);
				item.appendChild(info);
				const addBtn = $$('button.skill-add-btn') as HTMLButtonElement;
				addBtn.title = '添加';
				addBtn.textContent = '+';
				addBtn.onclick = () => this._addSkill(skill.id);
				item.appendChild(addBtn);
				this._skillsAvailableContainer.appendChild(item);
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	//  Actions
	// ═══════════════════════════════════════════════════════════════════════════

	// ── Rename ──

	private _startRename(): void {
		if (!this._agent || !this._nameEl || !this._renameInput) { return; }
		this._renameInput.value = this._agent.name;
		this._nameEl.style.display = 'none';
		const renameContainer = this._container?.querySelector('.agent-settings-rename') as HTMLElement;
		if (renameContainer) {
			renameContainer.style.display = 'flex';
		}
		this._renameInput.focus();
		this._renameInput.select();
	}

	private _cancelRename(): void {
		if (this._nameEl) { this._nameEl.style.display = ''; }
		const renameContainer = this._container?.querySelector('.agent-settings-rename') as HTMLElement;
		if (renameContainer) { renameContainer.style.display = 'none'; }
		if (this._renameError) { this._renameError.style.display = 'none'; }
	}

	private async _confirmRename(): Promise<void> {
		if (!this._agent || !this._agentId || !this._renameInput) { return; }
		const newName = this._renameInput.value.trim();
		if (!newName) {
			this._showRenameError('名称不能为空');
			return;
		}
		if (newName === this._agent.name) {
			this._cancelRename();
			return;
		}
		try {
			// Check duplicate name
			const allAgents = await this.agentStudioService.getAgents();
			const duplicate = allAgents.find(
				a => a.id !== this._agentId && a.name.toLowerCase() === newName.toLowerCase()
			);
			if (duplicate) {
				this._showRenameError(`已存在名为 "${newName}" 的 Agent`);
				return;
			}
			// Perform rename
			await this.agentStudioService.updateAgent(this._agentId, { name: newName });
			this._agent = { ...this._agent, name: newName };
			this._renderHeader();
			this._cancelRename();
			this.notificationService.info(`Agent 已重命名为 "${newName}"`);
			// Sync editor tab label
			const input = this.input as AgentSettingsEditorInput | undefined;
			if (input) { input.setAgentName(newName); }
		} catch (err) {
			this._showRenameError(`重命名失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _showRenameError(msg: string): void {
		if (this._renameError) {
			this._renameError.textContent = msg;
			this._renameError.style.display = 'block';
		}
	}

	// ── System Prompt ──

	private async _savePrompt(): Promise<void> {
		if (!this._agentId || !this._promptTextarea || !this._promptSaveBtn) { return; }
		try {
			this._promptSaveBtn.disabled = true;
			this._promptSaveBtn.textContent = '⏳ 保存中...';
			await this.agentStudioService.updateAgent(this._agentId, {
				systemPrompt: this._promptTextarea.value.trim() || undefined,
			} as Partial<Agent>);
			this._promptDirty = false;
			this._promptSaveBtn.textContent = '✓ 已保存';
			this.notificationService.info('系统提示词已保存');
			setTimeout(() => {
				if (this._promptSaveBtn) {
					this._promptSaveBtn.textContent = '💾 保存';
				}
			}, 2000);
		} catch (err) {
			this.notificationService.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
			this._promptSaveBtn.disabled = false;
			this._promptSaveBtn.textContent = '💾 保存';
		}
	}

	// ── Skills ──

	private async _addSkill(skillId: string): Promise<void> {
		if (!this._agentId) { return; }
		const newSkills = [...this._agentSkills, skillId];
		try {
			await this.agentStudioService.updateAgent(this._agentId, { skills: newSkills } as Partial<Agent>);
			this._agentSkills = newSkills;
			if (this._agent) { this._agent.skills = newSkills; }
			this._renderSkills();
			this._renderHeader();
		} catch (err) {
			this.notificationService.error(`添加技能失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _removeSkill(skillId: string): Promise<void> {
		if (!this._agentId) { return; }
		const newSkills = this._agentSkills.filter(s => s !== skillId);
		try {
			await this.agentStudioService.updateAgent(this._agentId, { skills: newSkills } as Partial<Agent>);
			this._agentSkills = newSkills;
			if (this._agent) { this._agent.skills = newSkills; }
			this._renderSkills();
			this._renderHeader();
		} catch (err) {
			this.notificationService.error(`移除技能失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── ConfigHtml ──

	private async _openConfigHtmlPreview(): Promise<void> {
		if (!this._agentId) { return; }
		try {
			const agentDir = await this.agentStudioService.getAgentDir(this._agentId);
			const configUri = URI.joinPath(agentDir, 'config.html');
			this.editorService.openEditor({ resource: configUri, options: { pinned: true } }, this.group);
		} catch (err) {
			this.notificationService.error(`打开 ConfigHtml 失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── Upload ──

	private async _checkUploadStatus(): Promise<void> {
		if (!this._agentId || !this._agent) { return; }
		// Builtin agents cannot be uploaded; custom agents check marketplace
		if (this._agent.source === 'builtin') {
			this._isUploaded = true; // hide upload button
		} else {
			try {
				await this.marketplaceService.getPackage(this._agentId);
				this._isUploaded = true;
			} catch {
				this._isUploaded = false;
			}
		}
		this._updateUploadBtn();
	}

	private _updateUploadBtn(): void {
		if (this._uploadBtn) {
			this._uploadBtn.style.display = this._isUploaded ? 'none' : '';
		}
	}

	private async _handleUpload(): Promise<void> {
		if (!this._agent || !this._agentId) { return; }
		const name = this._agent.name;

		const result = await this.dialogService.input({
			title: `上传 "${name}" 到商城`,
			message: `输入版本号 (如 1.0.0)`,
			inputs: [{ value: this._agent.version || '1.0.0', placeholder: '版本号' }],
			primaryButton: '上传',
			cancelButton: '取消',
		});
		if (!result.confirmed) { return; }

		const version = result.values?.[0]?.trim() || '1.0.0';

		try {
			// Collect skill and MCP references from the agent
			const skillRefs = this._agent.skills || [];
			const mcpRefs = this._agent.tools?.filter(t => t.startsWith('mcp:')) || [];

			// Auto-upload missing skill/MCP dependencies first
			const uploadedDeps = await this._uploadMissingDeps(skillRefs, mcpRefs, version);
			if (uploadedDeps > 0) {
				this.notificationService.info(`已自动上传 ${uploadedDeps} 个依赖`);
			}

			this.notificationService.info(`正在上传 "${name}" v${version}...`);
			await this.marketplaceService.publish(this._agentId, 'agent' as PackageKind, {
				name,
				version,
				description: this._agent.description || undefined,
				category: this._agent.category || undefined,
				skillRefs: skillRefs.length > 0 ? skillRefs : undefined,
				mcpRefs: mcpRefs.length > 0 ? mcpRefs : undefined,
			});
			this.notificationService.info(`"${name}" v${version} 已上传到商城`);
			this._isUploaded = true;
			this._updateUploadBtn();
		} catch (err) {
			this.notificationService.error(
				`上传 "${name}" 失败: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/** Auto-upload missing dependencies before uploading the agent. Returns count of uploaded deps. */
	private async _uploadMissingDeps(skillRefs: string[], _mcpRefs: string[], version: string): Promise<number> {
		let uploadedCount = 0;
		for (const slug of skillRefs) {
			try {
				const exists = await this._checkPackageExists(slug);
				if (!exists) {
					try {
						this.notificationService.info(`正在上传关联 Skill: ${slug}...`);
						await this.marketplaceService.publish(slug, 'skill' as PackageKind, { version });
						uploadedCount++;
					} catch {
						// Skill may not exist locally — skip
						this.notificationService.warn(`关联 Skill "${slug}" 无法上传（本地不存在或上传失败），已跳过`);
					}
				}
			} catch {
				// Best-effort — skip on check failure
			}
		}
		return uploadedCount;
	}

	/** Check if a package exists on the marketplace server by slug. */
	private async _checkPackageExists(slug: string): Promise<boolean> {
		try {
			await this.marketplaceService.getPackage(slug);
			return true;
		} catch {
			return false;
		}
	}

	// ── Export ──

	private async _handleExport(): Promise<void> {
		if (!this._agentId) { return; }
		try {
			const agent = await this.agentStudioService.getAgent(this._agentId);
			if (!agent) { return; }
			const blob = new Blob([JSON.stringify(agent, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${this._agentId}-export.json`;
			a.click();
			URL.revokeObjectURL(url);
			this.notificationService.info('Agent 已导出');
		} catch (err) {
			this.notificationService.error(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── Chat ──

	private _handleChat(): void {
		if (!this._agentId) { return; }
		this.agentStudioService.fireSelectAgent(this._agentId);
		this.editorService.closeEditor({ editor: this.input!, groupId: this.group.id });
	}

	// ═══════════════════════════════════════════════════════════════════════════
	//  Layout & Dispose
	// ═══════════════════════════════════════════════════════════════════════════

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
