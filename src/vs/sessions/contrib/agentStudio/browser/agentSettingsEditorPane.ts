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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IBridgeService } from './bridge/bridgeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { IAgentOSService } from '../common/agentOS.js';
import { ISkillRegistry } from '../common/skills.js';
import { IMarketplaceService, IMarketplaceVersion, PackageKind } from '../common/marketplace.js';
import { bumpPatch, compareSemver, suggestNextVersion, validatePublishVersion, isVersionConflictError } from './publishVersioning.js';
import { IAgentVersionService, type AgentCommitMeta } from '../common/agentVersionTypes.js';
import { gitUnavailableReason } from './gitVersionCore.js';
import { ITofAuthService } from '../common/tofAuth.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';

const { $: $$ } = DOM;

type TabId = 'prompt' | 'skills' | 'mcp' | 'rules' | 'binding' | 'versions' | 'runtime';

interface TabDef {
	id: TabId;
	label: string;
	icon: string;
}

const TABS: TabDef[] = [
	{ id: 'prompt', label: 'System Prompt', icon: '💬' },
	{ id: 'skills', label: '技能配置', icon: '🛠' },
	{ id: 'versions', label: '版本管理', icon: '🕐' },
	{ id: 'runtime', label: '运行时配置', icon: '⚙️' },
	{ id: 'mcp', label: 'MCP 配置', icon: '🔌' },
	{ id: 'rules', label: 'Rule 配置', icon: '📏' },
	{ id: 'binding', label: 'Channel 绑定', icon: '🔗' },
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

	// ── Read-only / Upload-disabled state ──
	/**
	 * 完全只读：内置 agent 或（已登录且非 owner）→ 禁止一切编辑。
	 * 未登录时不设此标志 —— 用户仍应能编辑本地自定义 agent，只是不能上传。
	 */
	private _readOnly = false;
	/** 上传被禁用：未登录或非 owner → 隐藏/禁用上传按钮，但编辑不受限 */
	private _uploadDisabled = false;
	/** 只读原因（用于横幅文案诊断） */
	private _readOnlyReason: string | undefined;
	private _bindingAddBtn: HTMLButtonElement | undefined;

	// ── Rename state ──
	private _renameInput: HTMLInputElement | undefined;
	private _renameError: HTMLElement | undefined;

	// ── System Prompt tab ──
	private _promptTextarea: HTMLTextAreaElement | undefined;
	private _promptSaveBtn: HTMLButtonElement | undefined;
	private _promptDirty = false;

	// ── Feishu Binding tab ──
	private _bindingListContainer: HTMLElement | undefined;
	private _bindingInput: HTMLInputElement | undefined;
	private _bindingDefaultToggle: HTMLInputElement | undefined;
	// Runtime config (paradigm + budget)
	private _paradigmSelect: HTMLSelectElement | undefined;
	private _budgetInput: HTMLInputElement | undefined;
	private _modelProviderSelect: HTMLSelectElement | undefined;
	private _modelIdSelect: HTMLSelectElement | undefined;

	// ── Skills tab ──
	private _skillsInstalledContainer: HTMLElement | undefined;
	private _skillsAvailableContainer: HTMLElement | undefined;
	private _allSkills: Array<{ id: string; name: string; category: string; activation: string; description?: string; source?: string }> = [];
	private _agentSkills: string[] = [];

	// ── Versions tab ──
	private _versionsListContainer: HTMLElement | undefined;
	private _versionsLoading = false;
	private _versionCommits: AgentCommitMeta[] = [];
	private _marketplaceVersionsContainer: HTMLElement | undefined;
	private _marketplaceVersionsLoading = false;
	/** 本地已安装/已发布的商城版本号，用于隐藏「安装此版本」 */
	private _localMarketVersion: string | undefined;

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
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IBridgeService private readonly bridgeService: IBridgeService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@IAgentVersionService private readonly agentVersionService: IAgentVersionService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
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
		this._buildVersionsTab();
		this._buildRuntimeTab();
		this._buildPlaceholderTab('mcp');
		this._buildPlaceholderTab('rules');
		this._buildBindingTab();

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

	// ── Channel Binding Tab ──

	private _buildBindingTab(): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = 'binding';

		const desc = $$('div.tab-pane-desc');
		desc.textContent = '配置此 Agent 与各消息渠道（Channel）的绑定关系。当前已支持「飞书」渠道：可设为渠道默认处理 Agent，或按会话（chat_id）精确绑定。绑定的渠道会话消息将自动路由给本 Agent。';
		section.appendChild(desc);

		// ── 渠道分组：飞书（Feishu） ──
		const group = $$('div.channel-group');
		const groupHeader = $$('div.channel-group-header');
		const groupIcon = $$('span.channel-group-icon');
		groupIcon.textContent = '🔵';
		const groupTitle = $$('span.channel-group-title');
		groupTitle.textContent = '飞书 (Feishu)';
		groupHeader.appendChild(groupIcon);
		groupHeader.appendChild(groupTitle);
		group.appendChild(groupHeader);

		// Section 1: 飞书渠道默认 Agent
		const sec1 = $$('div.binding-section');
		const sec1Title = $$('div.binding-section-title');
		sec1Title.textContent = '飞书渠道默认 Agent';
		sec1.appendChild(sec1Title);

		const defRow = $$('div.binding-default-row');
		this._bindingDefaultToggle = document.createElement('input');
		this._bindingDefaultToggle.type = 'checkbox';
		this._bindingDefaultToggle.id = 'feishu-default-toggle';
		this._bindingDefaultToggle.onchange = () => this._toggleFeishuDefault();
		const defLabel = $$('label.binding-default-label');
		defLabel.textContent = '将此 Agent 设为飞书渠道的默认处理 Agent（无精确群绑定时生效）';
		defLabel.setAttribute('for', 'feishu-default-toggle');
		defRow.appendChild(this._bindingDefaultToggle);
		defRow.appendChild(defLabel);
		sec1.appendChild(defRow);
		group.appendChild(sec1);

		// Section 2: 群聊绑定（按会话 chat_id）
		const sec2 = $$('div.binding-section');
		const sec2Title = $$('div.binding-section-title');
		sec2Title.textContent = '群聊绑定（按会话）';
		sec2.appendChild(sec2Title);

		const hint = $$('div.binding-hint');
		hint.textContent = '在飞书群中发送 /bind list 可查看本群 chat_id。绑定的群聊消息将自动路由给本 Agent。';
		sec2.appendChild(hint);

		const addRow = $$('div.binding-add-row');
		this._bindingInput = document.createElement('input');
		this._bindingInput.type = 'text';
		this._bindingInput.className = 'binding-input';
		this._bindingInput.placeholder = '输入飞书群聊会话 ID（chat_id）';
		this._bindingInput.onkeydown = (e) => {
			if (e.key === 'Enter') { e.preventDefault(); void this._addFeishuBinding(); }
		};
		addRow.appendChild(this._bindingInput);
		const addBtn = $$('button.agent-settings-btn primary') as HTMLButtonElement;
		addBtn.textContent = '➕ 绑定';
		addBtn.onclick = () => void this._addFeishuBinding();
		addRow.appendChild(addBtn);
		this._bindingAddBtn = addBtn;
		sec2.appendChild(addRow);

		this._bindingListContainer = $$('div.binding-list');
		sec2.appendChild(this._bindingListContainer);
		group.appendChild(sec2);

		section.appendChild(group);
		this._tabContentContainer?.appendChild(section);
	}

	private _renderBindingTab(): void {
		if (!this._agentId) { return; }

		// 飞书渠道默认 Agent 开关
		if (this._bindingDefaultToggle) {
			const cur = this.configurationService.getValue<string>('sessions.channel.feishu.defaultAgent');
			this._bindingDefaultToggle.checked = (cur === this._agentId);
		}

		// 群聊绑定列表
		if (!this._bindingListContainer) { return; }
		this._bindingListContainer.replaceChildren();
		let bindings: Array<{ conversationId: string; agentId: string }> = [];
		try {
			bindings = this.bridgeService.getEngine().listConversationBindings('feishu');
		} catch {
			// 桥接引擎未就绪：忽略
		}
		const mine = bindings.filter(b => b.agentId === this._agentId);
		if (mine.length === 0) {
			const empty = $$('div.skills-empty');
			empty.textContent = '暂无绑定的飞书群聊';
			this._bindingListContainer.appendChild(empty);
			return;
		}
		for (const b of mine) {
			const item = $$('div.skill-item installed');
			const info = $$('div.skill-item-info');
			const nameEl = $$('span.skill-item-name');
			nameEl.textContent = b.conversationId;
			info.appendChild(nameEl);
			item.appendChild(info);
			const removeBtn = $$('button.skill-remove-btn') as HTMLButtonElement;
			removeBtn.title = '解除绑定';
			removeBtn.textContent = '✕';
			removeBtn.disabled = this._readOnly;
			removeBtn.onclick = () => this._removeFeishuBinding(b.conversationId);
			item.appendChild(removeBtn);
			this._bindingListContainer.appendChild(item);
		}
	}

	private async _addFeishuBinding(): Promise<void> {
		if (this._readOnly) { return; }
		if (!this._agentId || !this._bindingInput) { return; }
		const chatId = this._bindingInput.value.trim();
		if (!chatId) {
			this.notificationService.warn('请输入飞书群聊会话 ID（chat_id）');
			return;
		}
		try {
			this.bridgeService.getEngine().setConversationAgent('feishu', chatId, this._agentId);
			this._bindingInput.value = '';
			this.notificationService.info(`已绑定飞书群聊 ${chatId} 到本 Agent`);
			this._renderBindingTab();
		} catch (err) {
			this.notificationService.error(`绑定失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _removeFeishuBinding(chatId: string): void {
		if (this._readOnly) { return; }
		if (!this._agentId) { return; }
		try {
			this.bridgeService.getEngine().clearConversationAgent('feishu', chatId);
			this.notificationService.info(`已解除飞书群聊 ${chatId} 的绑定`);
			this._renderBindingTab();
		} catch (err) {
			this.notificationService.error(`解除失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _toggleFeishuDefault(): void {
		if (this._readOnly) { return; }
		if (!this._agentId || !this._bindingDefaultToggle) { return; }
		const key = 'sessions.channel.feishu.defaultAgent';
		const cur = this.configurationService.getValue<string>(key);
		if (this._bindingDefaultToggle.checked) {
			this.configurationService.updateValue(key, this._agentId);
			this.notificationService.info('已设为飞书渠道默认 Agent');
		} else if (cur === this._agentId) {
			this.configurationService.updateValue(key, '');
			this.notificationService.info('已取消飞书渠道默认 Agent');
		}
	}

	// ── Read-only / Upload-disabled lock ──

	/**
	 * 应用只读/上传禁用状态。在 _loadAgentData 末尾调用。
	 *   - _readOnly=true  → 禁用所有编辑控件 + 横幅
	 *   - _uploadDisabled=true 但 _readOnly=false → 仅禁用上传按钮 + 轻量提示
	 */
	private _applyReadOnlyState(): void {
		const main = this._container?.querySelector('.agent-settings-main') as HTMLElement | null;
		if (!main) { return; }

		// 先清除已有横幅（auth 竞态恢复后重新评估时，旧横幅必须移除）
		main.querySelectorAll('.agent-settings-readonly-banner').forEach(el => el.remove());

		if (this._readOnly) {
			// 禁用固定编辑控件
			if (this._promptTextarea) { this._promptTextarea.disabled = true; }
			if (this._promptSaveBtn) { this._promptSaveBtn.style.display = 'none'; }
			if (this._bindingInput) { this._bindingInput.disabled = true; }
			if (this._bindingDefaultToggle) { this._bindingDefaultToggle.disabled = true; }
			if (this._bindingAddBtn) { this._bindingAddBtn.disabled = true; }
			if (this._renameInput) { this._renameInput.disabled = true; }
			if (this._paradigmSelect) { this._paradigmSelect.disabled = true; }
			if (this._budgetInput) { this._budgetInput.disabled = true; }
			if (this._modelProviderSelect) { this._modelProviderSelect.disabled = true; }
			if (this._modelIdSelect) { this._modelIdSelect.disabled = true; }

			// 禁用重命名触发（标题双击 + 铅笔按钮）
			if (this._nameEl) {
				this._nameEl.classList.remove('editable');
				this._nameEl.ondblclick = null;
				this._nameEl.title = '仅创建者(owner)可编辑';
			}
			const renameBtn = this._container?.querySelector('.agent-settings-rename-btn') as HTMLButtonElement | null;
			if (renameBtn) {
				renameBtn.disabled = true;
				renameBtn.title = '仅创建者(owner)可编辑';
			}

			// 只读提示横幅（含诊断原因）
			const banner = $$('div.agent-settings-readonly-banner');
			banner.textContent = `🔒 只读模式：${this._readOnlyReason || '仅创建者(owner)可编辑此 Agent'}`;
			banner.style.cssText = 'margin:8px 12px;padding:8px 12px;border-radius:6px;background:var(--vscode-badge-background,#3a3d41);color:var(--vscode-badge-foreground,#fff);font-size:12px;';
			main.insertBefore(banner, main.firstChild);
		} else if (this._uploadDisabled) {
			// 可编辑但不可上传 —— 仅显示轻量提示，不锁编辑控件
			const banner = $$('div.agent-settings-readonly-banner');
			banner.textContent = '⚠️ 上传不可用：当前未登录（TOF），请登录后发布到商城';
			banner.style.cssText = 'margin:8px 12px;padding:6px 12px;border-radius:6px;background:var(--vscode-inputValidation-warningBackground,#352a05);color:var(--vscode-inputValidation-warningForeground,#ccc);font-size:11px;border:1px solid var(--vscode-inputValidation-warningBorder,#b89500);';
			main.insertBefore(banner, main.firstChild);
		}
		// 否则：既不只读也不禁上传 —— 恢复编辑控件（auth 竞态恢复路径）
		else {
			if (this._promptTextarea) { this._promptTextarea.disabled = false; }
			if (this._promptSaveBtn) { this._promptSaveBtn.style.display = ''; }
			if (this._bindingInput) { this._bindingInput.disabled = false; }
			if (this._bindingDefaultToggle) { this._bindingDefaultToggle.disabled = false; }
			if (this._bindingAddBtn) { this._bindingAddBtn.disabled = false; }
			if (this._renameInput) { this._renameInput.disabled = false; }
			if (this._paradigmSelect) { this._paradigmSelect.disabled = false; }
			if (this._budgetInput) { this._budgetInput.disabled = false; }
			if (this._modelProviderSelect) { this._modelProviderSelect.disabled = false; }
			if (this._modelIdSelect) { this._modelIdSelect.disabled = false; }
			if (this._nameEl) {
				this._nameEl.classList.add('editable');
				this._nameEl.title = '双击重命名';
			}
			const renameBtn = this._container?.querySelector('.agent-settings-rename-btn') as HTMLButtonElement | null;
			if (renameBtn) { renameBtn.disabled = false; renameBtn.title = ''; }
		}
	}

	// ── Versions Tab（版本管理）──────────────────────────────────────

	private _buildVersionsTab(): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = 'versions';

		const desc = $$('div.tab-pane-desc');
		desc.textContent = '版本历史记录。每次修改 Agent 系统提示词后会自动生成版本快照，可查看差异或回滚到历史版本。';
		section.appendChild(desc);

		// 工具栏：刷新按钮
		const toolbar = $$('div.versions-toolbar');
		toolbar.style.display = 'flex';
		toolbar.style.alignItems = 'center';
		toolbar.style.gap = '8px';
		toolbar.style.marginBottom = '12px';

		const refreshBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		refreshBtn.textContent = '🔄 刷新';
		refreshBtn.onclick = () => {
			this._loadVersionHistory();
			this._loadMarketplaceVersions();
		};
		toolbar.appendChild(refreshBtn);

		const hint = $$('span');
		hint.textContent = '点击版本行展开 diff 详情';
		hint.style.fontSize = '11px';
		hint.style.color = 'var(--vscode-descriptionForeground)';
		toolbar.appendChild(hint);
		section.appendChild(toolbar);

		// ── 商城版本区块（Releases）──
		const mkTitle = $$('div.versions-section-title');
		mkTitle.textContent = '商城版本（Releases）';
		mkTitle.style.fontSize = '12px';
		mkTitle.style.fontWeight = '600';
		mkTitle.style.margin = '4px 0 8px 0';
		mkTitle.style.color = 'var(--vscode-foreground)';
		section.appendChild(mkTitle);

		this._marketplaceVersionsContainer = $$('div.marketplace-versions-list');
		this._marketplaceVersionsContainer.style.marginBottom = '16px';
		section.appendChild(this._marketplaceVersionsContainer);

		// ── 本地历史区块（Git）──
		const localTitle = $$('div.versions-section-title');
		localTitle.textContent = '本地历史（Git）';
		localTitle.style.fontSize = '12px';
		localTitle.style.fontWeight = '600';
		localTitle.style.margin = '4px 0 8px 0';
		localTitle.style.color = 'var(--vscode-foreground)';
		section.appendChild(localTitle);

		// 列表容器
		this._versionsListContainer = $$('div.versions-list');
		this._versionsListContainer.style.maxHeight = 'calc(100vh - 320px)';
		this._versionsListContainer.style.overflowY = 'auto';
		this._versionsListContainer.textContent = '点击上方刷新按钮加载版本历史';
		this._versionsListContainer.style.padding = '16px';
		this._versionsListContainer.style.textAlign = 'center';
		this._versionsListContainer.style.color = 'var(--vscode-descriptionForeground)';
		section.appendChild(this._versionsListContainer);

		this._tabContentContainer?.appendChild(section);
	}

	private async _loadVersionHistory(): Promise<void> {
		if (!this._agentId || this._versionsLoading) { return; }
		this._versionsLoading = true;

		if (this._versionsListContainer) {
			this._versionsListContainer.textContent = '';
			const loading = $$('div');
			loading.textContent = '⏳ 加载版本历史...';
			loading.style.padding = '16px';
			loading.style.textAlign = 'center';
			loading.style.color = 'var(--vscode-descriptionForeground)';
			this._versionsListContainer.appendChild(loading);
		}

		try {
			// Git 不可用时给出**具体**原因，避免误导为"尚未初始化"或"环境不支持"
			// （桌面端最常见成因是主进程通道未就绪，与运行环境无关）
			if (!this.agentVersionService.isAvailable()) {
				const container = this._versionsListContainer;
				if (container) {
					const reason = gitUnavailableReason();
					container.textContent = reason
						? `Git 版本管理暂不可用：${reason}`
						: '当前环境不支持 Git 版本管理（需在桌面客户端中使用）';
					container.style.padding = '12px 4px';
					container.style.color = 'var(--vscode-descriptionForeground)';
				}
				return;
			}
			this._versionCommits = await this.agentVersionService.history(this._agentId, 50);
			// 兼容旧 agent（版本管理落地前创建、无 .git）：首次打开版本页自动初始化仓库，
			// 与 autoCommit 的懒初始化行为对齐。
			if (this._versionCommits.length === 0) {
				await this.agentVersionService.init(this._agentId);
				this._versionCommits = await this.agentVersionService.history(this._agentId, 50);
			}
			this._renderVersionList();
		} catch (err) {
			if (this._versionsListContainer) {
				this._versionsListContainer.textContent = '';
				const errEl = $$('div');
				errEl.textContent = `加载失败: ${err instanceof Error ? err.message : String(err)}`;
				errEl.style.color = 'var(--vscode-errorForeground)';
				errEl.style.padding = '16px';
				errEl.style.textAlign = 'center';
				this._versionsListContainer.appendChild(errEl);
			}
		} finally {
			this._versionsLoading = false;
		}
	}

	private _renderVersionList(): void {
		if (!this._versionsListContainer) { return; }
		this._versionsListContainer.textContent = '';
		// 有内容时左对齐（初始化时设的 center 仅用于空状态提示）
		this._versionsListContainer.style.textAlign = 'left';

		if (this._versionCommits.length === 0) {
			const empty = $$('div');
			empty.textContent = '暂无版本历史（可能是尚未初始化 Git 仓库）';
			empty.style.padding = '16px';
			empty.style.textAlign = 'center';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			this._versionsListContainer.appendChild(empty);
			return;
		}

		const countEl = $$('div');
		countEl.textContent = `共 ${this._versionCommits.length} 条记录`;
		countEl.style.color = 'var(--vscode-descriptionForeground)';
		countEl.style.fontSize = '11px';
		countEl.style.marginBottom = '8px';
		countEl.style.padding = '0 4px';
		countEl.style.textAlign = 'center';
		this._versionsListContainer.appendChild(countEl);

		for (const c of this._versionCommits) {
			this._versionsListContainer.appendChild(this._renderVersionCommitRow(c));
		}
	}

	private _renderVersionCommitRow(c: AgentCommitMeta): HTMLElement {
		const row = $$('div.version-commit-row');
		row.style.padding = '10px 12px';
		row.style.marginBottom = '6px';
		row.style.border = '1px solid var(--vscode-panel-border, #3c3c3c)';
		row.style.borderRadius = '6px';
		row.style.cursor = 'pointer';
		row.style.transition = 'background 0.15s';
		row.style.textAlign = 'left';

		row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, #2a2d2e)'; };
		row.onmouseleave = () => { row.style.background = ''; };

		// ── 头部：SHA + 时间 ──
		const head = $$('div');
		head.style.display = 'flex';
		head.style.justifyContent = 'space-between';
		head.style.alignItems = 'center';
		head.style.marginBottom = '4px';

		const shaBadge = $$('code');
		shaBadge.textContent = c.shortSha;
		shaBadge.style.fontSize = '11px';
		shaBadge.style.fontFamily = 'monospace';
		shaBadge.style.background = 'var(--vscode-badge-background, #4d4d4d)';
		shaBadge.style.color = 'var(--vscode-badge-foreground, #fff)';
		shaBadge.style.padding = '1px 6px';
		shaBadge.style.borderRadius = '3px';
		head.appendChild(shaBadge);

		const timeEl = $$('span');
		timeEl.textContent = this._formatVersionTime(c.time);
		timeEl.style.fontSize = '10px';
		timeEl.style.color = 'var(--vscode-descriptionForeground)';
		head.appendChild(timeEl);
		row.appendChild(head);

		// ── 消息 ──
		const msg = $$('div');
		msg.textContent = c.message;
		msg.style.fontSize = '12px';
		msg.style.color = 'var(--vscode-foreground)';
		msg.style.marginBottom = '6px';
		msg.style.lineHeight = '1.4';
		msg.style.textAlign = 'left';
		row.appendChild(msg);

		// ── 折叠区：diff + 操作 ──
		const detail = $$('div.version-commit-detail');
		detail.style.display = 'none';
		detail.style.marginTop = '8px';
		detail.style.textAlign = 'left';
		row.appendChild(detail);

		// Diff 文本
		const diffPre = $$('pre');
		diffPre.style.fontSize = '11px';
		diffPre.style.fontFamily = 'monospace';
		diffPre.style.padding = '8px';
		diffPre.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		diffPre.style.borderRadius = '4px';
		diffPre.style.maxHeight = '300px';
		diffPre.style.overflowY = 'auto';
		diffPre.style.whiteSpace = 'pre-wrap';
		diffPre.style.wordBreak = 'break-all';
		diffPre.style.margin = '0 0 8px 0';
		detail.appendChild(diffPre);

		// 操作按钮
		const actions = $$('div');
		actions.style.display = 'flex';
		actions.style.gap = '8px';
		detail.appendChild(actions);

		const rollbackBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		rollbackBtn.textContent = '回滚到此版本';
		rollbackBtn.style.background = 'var(--vscode-inputValidation-warningBackground, #352a05)';
		rollbackBtn.style.border = '1px solid var(--vscode-inputValidation-warningBorder, #b89500)';
		rollbackBtn.style.color = 'var(--vscode-inputValidation-warningForeground, #ccc)';
		rollbackBtn.style.padding = '4px 12px';
		rollbackBtn.style.fontSize = '11px';
		if (this._readOnly) {
			rollbackBtn.disabled = true;
			rollbackBtn.title = '只读模式下不可回滚';
			rollbackBtn.style.opacity = '0.5';
		}
		rollbackBtn.onclick = (e) => {
			e.stopPropagation();
			if (!this._readOnly) { void this._handleVersionRollback(c.sha); }
		};
		actions.appendChild(rollbackBtn);
		detail.appendChild(actions);

		// ── 点击展开/收起 diff ──
		let loaded = false;
		const self = this;
		row.onclick = async () => {
			if (detail.style.display === 'block') {
				detail.style.display = 'none';
				return;
			}
			if (loaded) {
				detail.style.display = 'block';
				return;
			}
			detail.style.display = 'block';
			diffPre.textContent = '加载 diff...';
			try {
				const result = await self.agentVersionService.diff(self._agentId!, c.sha);
				diffPre.textContent = result?.unified || '无差异数据';
				self._colorizeVersionDiff(diffPre);
			} catch (err) {
				diffPre.textContent = `加载失败: ${err instanceof Error ? err.message : String(err)}`;
			}
			loaded = true;
		};

		return row;
	}

	private async _handleVersionRollback(sha: string): Promise<void> {
		if (!this._agentId) { return; }
		try {
			await this.agentVersionService.rollback(this._agentId, sha);
			this.notificationService.info(`Agent 已回滚到版本 ${sha.slice(0, 7)}，请刷新 prompt 页签查看内容`);
			await this._loadVersionHistory();
		} catch (err) {
			this.notificationService.error(`回滚失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 商城版本（Releases）──────────────────────────────────────

	private async _loadMarketplaceVersions(): Promise<void> {
		if (!this._agentId || !this._marketplaceVersionsContainer || this._marketplaceVersionsLoading) { return; }
		this._marketplaceVersionsLoading = true;
		const container = this._marketplaceVersionsContainer;
		container.textContent = '⏳ 加载商城版本...';
		container.style.padding = '12px 4px';
		container.style.color = 'var(--vscode-descriptionForeground)';
		container.style.fontSize = '12px';
		try {
			const [detail, installed] = await Promise.all([
				this.marketplaceService.getPackage(this._agentId),
				this.marketplaceService.getInstalled().catch(() => [] as { kind: string; storeId: string; version?: string }[]),
			]);
			// 本地版本：installed-packages.json 记录优先，fallback 到 agent 声明的 version
			const record = installed.find(e => e.kind === 'agent' && e.storeId === this._agentId);
			this._localMarketVersion = record?.version ?? this._agent?.version;
			this._renderMarketplaceVersions(detail.versions ?? []);
		} catch {
			container.textContent = '尚未发布到商城（或商城不可达）';
		} finally {
			this._marketplaceVersionsLoading = false;
		}
	}

	private _renderMarketplaceVersions(versions: readonly IMarketplaceVersion[]): void {
		const container = this._marketplaceVersionsContainer;
		if (!container) { return; }
		container.textContent = '';
		container.style.padding = '0';
		if (versions.length === 0) {
			container.textContent = '商城暂无已发布版本';
			container.style.padding = '12px 4px';
			container.style.color = 'var(--vscode-descriptionForeground)';
			container.style.fontSize = '12px';
			return;
		}
		// 按版本号降序展示（最新在前）
		const sorted = [...versions].sort((a, b) => compareSemver(b.version, a.version));
		for (const v of sorted) {
			container.appendChild(this._renderMarketplaceVersionRow(v));
		}
	}

	private _renderMarketplaceVersionRow(v: IMarketplaceVersion): HTMLElement {
		const row = $$('div.marketplace-version-row');
		row.style.padding = '8px 12px';
		row.style.marginBottom = '6px';
		row.style.border = '1px solid var(--vscode-panel-border, #3c3c3c)';
		row.style.borderRadius = '6px';
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '8px';

		// 版本号 + latest 徽章
		const verBadge = $$('code');
		verBadge.textContent = `v${v.version}`;
		verBadge.style.fontSize = '11px';
		verBadge.style.fontFamily = 'monospace';
		verBadge.style.background = 'var(--vscode-badge-background, #4d4d4d)';
		verBadge.style.color = 'var(--vscode-badge-foreground, #fff)';
		verBadge.style.padding = '1px 6px';
		verBadge.style.borderRadius = '3px';
		row.appendChild(verBadge);

		if (v.isLatest) {
			const latestBadge = $$('span');
			latestBadge.textContent = 'latest';
			latestBadge.style.fontSize = '10px';
			latestBadge.style.padding = '1px 6px';
			latestBadge.style.borderRadius = '3px';
			latestBadge.style.background = 'var(--vscode-testing-iconPassed, #73c991)';
			latestBadge.style.color = '#000';
			row.appendChild(latestBadge);
		}

		// changelog（截断单行）
		const changelog = $$('span');
		changelog.textContent = v.changelog || '';
		changelog.style.flex = '1';
		changelog.style.fontSize = '11px';
		changelog.style.color = 'var(--vscode-descriptionForeground)';
		changelog.style.overflow = 'hidden';
		changelog.style.textOverflow = 'ellipsis';
		changelog.style.whiteSpace = 'nowrap';
		changelog.title = v.changelog || '';
		row.appendChild(changelog);

		// 安装此版本（商城回滚：覆盖安装旧版本，并写入本地 git 历史）
		// 本地已是该版本时不显示按钮，改为「当前版本」标记
		if (this._localMarketVersion && v.version === this._localMarketVersion) {
			const currentTag = $$('span');
			currentTag.textContent = '当前版本';
			currentTag.style.fontSize = '11px';
			currentTag.style.padding = '2px 10px';
			currentTag.style.borderRadius = '4px';
			currentTag.style.background = 'var(--vscode-badge-background, #4d4d4d)';
			currentTag.style.color = 'var(--vscode-badge-foreground, #fff)';
			row.appendChild(currentTag);
		} else {
			const installBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
			installBtn.textContent = '安装此版本';
			installBtn.style.fontSize = '11px';
			installBtn.style.padding = '2px 10px';
			if (this._readOnly) {
				installBtn.disabled = true;
				installBtn.title = '只读模式下不可安装';
				installBtn.style.opacity = '0.5';
			} else {
				installBtn.onclick = (e) => { e.stopPropagation(); void this._handleInstallMarketVersion(v); };
			}
			row.appendChild(installBtn);
		}

		// 下架（仅作者/owner + 仅最新版本）：历史版本不允许单独下架
		if (this._agent && this.agentStudioService.canUploadAgent(this._agent) && !this._readOnly && v.isLatest) {
			const deleteBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
			deleteBtn.textContent = '下架';
			deleteBtn.style.fontSize = '11px';
			deleteBtn.style.padding = '2px 10px';
			deleteBtn.style.color = 'var(--vscode-errorForeground, #f14c4c)';
			deleteBtn.onclick = (e) => { e.stopPropagation(); void this._handleDeleteMarketVersion(v); };
			row.appendChild(deleteBtn);
		}

		return row;
	}

	/** 安装商城指定版本（含旧版本回滚）：下载覆盖安装 + 本地 git 记录 */
	private async _handleInstallMarketVersion(v: IMarketplaceVersion): Promise<void> {
		if (!this._agentId) { return; }
		try {
			this.notificationService.info(`正在安装 v${v.version}...`);
			await this.marketplaceService.download(this._agentId, v.version, 'agent' as PackageKind);
			// 商城回滚也写入本地 git 历史，保持双轨一致
			try {
				await this.agentVersionService.autoCommit(this._agentId, `install: v${v.version} from marketplace`);
			} catch { /* non-critical */ }
			this.notificationService.info(`已安装 v${v.version}，请重新打开设置页查看内容`);
			this._loadVersionHistory();
			this._loadMarketplaceVersions();
		} catch (err) {
			this.notificationService.error(`安装 v${v.version} 失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 下架商城指定版本（仅作者）。删除 latest 版本时提示服务端会重算最新版本。 */
	private async _handleDeleteMarketVersion(v: IMarketplaceVersion): Promise<void> {
		if (!this._agentId) { return; }
		const confirm = await this.dialogService.confirm({
			message: `确定下架 v${v.version} 吗？`,
			detail: v.isLatest
				? '该版本是当前最新版本，下架后商城最新版本将回退到次新版本。已安装的用户不受影响。'
				: '下架后其他用户将无法再下载该版本，已安装的用户不受影响。',
			primaryButton: '下架',
			cancelButton: '取消',
		});
		if (!confirm.confirmed) { return; }
		try {
			await this.marketplaceService.deleteVersion(this._agentId, v.version);
			this.notificationService.info(`v${v.version} 已下架`);
			this._loadMarketplaceVersions();
		} catch (err) {
			this.notificationService.error(`下架失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _formatVersionTime(iso: string): string {
		try {
			const d = new Date(iso);
			return d.toLocaleString('zh-CN', {
				month: '2-digit', day: '2-digit',
				hour: '2-digit', minute: '2-digit',
			});
		} catch { return iso.slice(0, 16); }
	}

	private _colorizeVersionDiff(pre: HTMLElement): void {
		const text = pre.textContent || '';
		const lines = text.split('\n');
		pre.textContent = '';
		for (const line of lines) {
			const span = $$('span');
			if (line.startsWith('+') && !line.startsWith('+++')) {
				span.style.color = 'var(--vscode-testing-iconPassed, #73c991)';
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				span.style.color = 'var(--vscode-testing-iconFailed, #f14c4c)';
			} else if (line.startsWith('@@')) {
				span.style.color = 'var(--vscode-textLink-foreground, #3794ff)';
			}
			span.textContent = line + '\n';
			pre.appendChild(span);
		}
	}

	// ── Runtime Config Tab (paradigm + budget) ──

	private _buildRuntimeTab(): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = 'runtime';

		// ── Paradigm selector ──
		const paradigmGroup = $$('div.agent-settings-form-group');
		const paradigmLabel = $$('label.agent-settings-label');
		paradigmLabel.textContent = 'AgentLoop 循环范式';
		paradigmGroup.appendChild(paradigmLabel);

		const paradigmDesc = $$('div.agent-settings-desc');
		paradigmDesc.textContent = '决定 Agent 的执行模型：ReAct 循环 + 预算门控（默认）、计划-探索、图模式等';
		paradigmGroup.appendChild(paradigmDesc);

		this._paradigmSelect = document.createElement('select');
		this._paradigmSelect.className = 'agent-settings-select';
		const paradigms = [
			{ value: '', label: '默认（按 ChatMode 自动选择）' },
			{ value: 'budgeted-react', label: 'Budgeted ReAct — 预算门控 + 委托编排（Hermes 范式）' },
			{ value: 'plan-explore', label: 'Plan-Explore — 三阶段：分析 → 并行探索 → DAG 执行' },
			{ value: 'react', label: 'Pure ReAct — 纯 ReAct 循环（无预算限制）' },
			{ value: 'graph', label: 'Graph — 声明式图 / BSP 超步（LangGraph 模式）' },
			{ value: 'delegation', label: 'Delegation — Supervisor + 子 Agent 委托树' },
			{ value: 'readonly', label: 'Readonly — 只读收集模式' },
		];
		for (const p of paradigms) {
			const opt = document.createElement('option');
			opt.value = p.value;
			opt.textContent = p.label;
			this._paradigmSelect.appendChild(opt);
		}
		this._paradigmSelect.onchange = () => {
			void this._saveRuntimeConfig();
		};
		paradigmGroup.appendChild(this._paradigmSelect);
		section.appendChild(paradigmGroup);

		// ── Budget input ──
		const budgetGroup = $$('div.agent-settings-form-group');
		const budgetLabel = $$('label.agent-settings-label');
		budgetLabel.textContent = '每 Turn 最大迭代次数（Budget）';
		budgetGroup.appendChild(budgetLabel);

		const budgetDesc = $$('div.agent-settings-desc');
		budgetDesc.textContent = '仅在 Budgeted ReAct 范式下生效。范围 10-200，默认 90。预算耗尽后如未完成将终止回合';
		budgetGroup.appendChild(budgetDesc);

		this._budgetInput = document.createElement('input');
		this._budgetInput.type = 'number';
		this._budgetInput.className = 'agent-settings-number-input';
		this._budgetInput.min = '10';
		this._budgetInput.max = '200';
		this._budgetInput.placeholder = '90';
		this._budgetInput.onchange = () => {
			void this._saveRuntimeConfig();
		};
		budgetGroup.appendChild(this._budgetInput);
		section.appendChild(budgetGroup);

		// ── 默认 Provider & Model ──
		const providerGroup = $$('div.agent-settings-form-group');
		const providerLabel = $$('label.agent-settings-label');
		providerLabel.textContent = '默认 Provider / 模型';
		providerGroup.appendChild(providerLabel);

		const providerDesc = $$('div.agent-settings-desc');
		providerDesc.textContent = '该 Agent 对话与工作流节点使用的默认模型。选择「跟随全局默认」时使用 Provider 视图的全局配置';
		providerGroup.appendChild(providerDesc);

		this._modelProviderSelect = document.createElement('select');
		this._modelProviderSelect.className = 'agent-settings-select';
		const autoOpt = document.createElement('option');
		autoOpt.value = '';
		autoOpt.textContent = '跟随全局默认';
		this._modelProviderSelect.appendChild(autoOpt);
		for (const p of this.agentOSService.getModelProviders()) {
			const opt = document.createElement('option');
			opt.value = p.id;
			opt.textContent = p.name;
			this._modelProviderSelect.appendChild(opt);
		}
		this._modelProviderSelect.onchange = () => {
			void this._onModelProviderChanged();
		};
		providerGroup.appendChild(this._modelProviderSelect);

		this._modelIdSelect = document.createElement('select');
		this._modelIdSelect.className = 'agent-settings-select';
		this._modelIdSelect.style.marginTop = '6px';
		this._modelIdSelect.onchange = () => {
			void this._saveModelConfig();
		};
		providerGroup.appendChild(this._modelIdSelect);
		section.appendChild(providerGroup);

		this._tabContentContainer?.appendChild(section);
	}

	/** Provider 切换：重新加载该 provider 的模型列表并保存 */
	private async _onModelProviderChanged(): Promise<void> {
		await this._refreshModelOptions();
		await this._saveModelConfig();
	}

	/** 刷新模型下拉（按当前选中 provider）；preferModelId 用于加载时预选 */
	private async _refreshModelOptions(preferModelId?: string): Promise<void> {
		const providerSelect = this._modelProviderSelect;
		const modelSelect = this._modelIdSelect;
		if (!providerSelect || !modelSelect) { return; }

		const providerId = providerSelect.value;
		modelSelect.replaceChildren();

		// 跟随全局默认：模型下拉禁用，仅展示提示项
		if (!providerId) {
			const opt = document.createElement('option');
			opt.value = '';
			opt.textContent = '（跟随全局默认模型）';
			modelSelect.appendChild(opt);
			modelSelect.disabled = true;
			return;
		}

		modelSelect.disabled = this._readOnly;
		const provider = this.agentOSService.getModelProviders().find(p => p.id === providerId);
		let models: { id: string; name: string }[] = [];
		try {
			models = (await provider?.listModels() ?? []).map(m => ({ id: m.id, name: m.name || m.id }));
		} catch { /* provider 模型列表加载失败时仅回退到当前值 */ }

		// 当前已保存的模型必须始终可选（即使 provider 列表中不存在）
		const current = preferModelId ?? this._agent?.model ?? '';
		if (current && !models.some(m => m.id === current)) {
			models = [{ id: current, name: `${current}（当前）` }, ...models];
		}
		for (const m of models) {
			const opt = document.createElement('option');
			opt.value = m.id;
			opt.textContent = m.name;
			modelSelect.appendChild(opt);
		}
		if (current) {
			modelSelect.value = current;
		}
	}

	private async _saveModelConfig(): Promise<void> {
		if (!this._agentId || this._readOnly || !this._modelProviderSelect) { return; }
		try {
			const providerId = this._modelProviderSelect.value || undefined;
			const patch: Partial<Agent> = { providerId };
			// 仅在指定 provider 时同步写入模型；跟随全局默认时保留原 model 字段不动
			if (providerId && this._modelIdSelect?.value) {
				patch.model = this._modelIdSelect.value;
			}
			await this.agentStudioService.updateAgent(this._agentId, patch);
			if (this._agent) {
				this._agent.providerId = providerId;
				if (patch.model) { this._agent.model = patch.model; }
			}
			this._renderHeader();
		} catch (err) {
			this.notificationService.warn(`保存模型配置失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _saveRuntimeConfig(): Promise<void> {
		if (!this._agentId || this._readOnly) { return; }
		try {
			const paradigm = this._paradigmSelect?.value || undefined;
			const budgetVal = this._budgetInput?.value.trim();
			const budgetMaxTotal = budgetVal ? parseInt(budgetVal, 10) : undefined;
			await this.agentStudioService.updateAgent(this._agentId, {
				paradigm: paradigm || undefined,
				budgetMaxTotal: (budgetMaxTotal && !isNaN(budgetMaxTotal)) ? budgetMaxTotal : undefined,
			} as Partial<Agent>);
		} catch (err) {
			// silent — 下次加载时会重置
		}
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
		// 进入绑定页签时刷新，反映外部（/bind 命令）变更
		if (tabId === 'binding') {
			this._renderBindingTab();
		}
		// 进入版本管理页签时自动加载历史（本地 git + 商城 releases）
		if (tabId === 'versions') {
			this._loadVersionHistory();
			this._loadMarketplaceVersions();
		}
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
			const agent = await this.agentStudioService.getAgent(this._agentId);
			if (!agent) {
				this.notificationService.warn(`Agent not found: ${this._agentId}`);
				return;
			}
			this._agent = agent;

			// ── 权限判定前先等 TOF 就绪 ──
			// restoreSession 是幂等的（内部有 _sessionRestoring 去重），
			// 若已登录则立即返回，若未恢复则等其完成。避免 auth 竞态导致误判。
			if (!this.tofAuthService.currentUser) {
				console.log(`[AgentSettings] TOF 未就绪，等待 restoreSession...`);
				await this.tofAuthService.restoreSession();
			}

			// ── 权限判定（分离「编辑」与「上传」）──
			//   内置 agent → 完全只读（系统资产）
			//   已登录但非 owner → 完全只读（他人资产）
			//   未登录 + 有 owner → 可编辑本地，但不能上传（票据过期/未登录）
			//   owner / 未认领 → 完全权限
			const canUpload = this.agentStudioService.canUploadAgent(agent);
			const uid = this.agentStudioService.currentUserId;
			// 诊断日志：打印实际比对值，方便排障
			console.log(`[AgentSettings] 权限判定: id=${this._agentId}, source=${agent.source}, owner=${JSON.stringify(agent.owner)}, currentUserId=${JSON.stringify(uid)}, canUpload=${canUpload}`);
			if (agent.source === 'builtin') {
				this._readOnly = true;
				this._uploadDisabled = true;
				this._readOnlyReason = '内置系统 Agent';
			} else if (!canUpload) {
				// canUpload=false 的原因：要么未登录，要么非 owner
				if (!uid && agent.owner) {
					// 未登录但有 owner → 允许编辑，禁止上传
					this._readOnly = false;
					this._uploadDisabled = true;
					this._readOnlyReason = undefined; // 不显示只读横幅（可编辑）
				} else {
					// 已登录但非 owner → 完全只读
					this._readOnly = true;
					this._uploadDisabled = true;
					this._readOnlyReason = `当前用户(${uid ?? '?'})非创建者(owner=${agent.owner ?? '空'})`;
				}
			} else {
				this._readOnly = false;
				this._uploadDisabled = false;
				this._readOnlyReason = undefined;
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

			// Update runtime config (paradigm + budget)
			if (this._paradigmSelect && this._budgetInput) {
				this._paradigmSelect.value = this._agent.paradigm || '';
				this._budgetInput.value = this._agent.budgetMaxTotal !== undefined ? String(this._agent.budgetMaxTotal) : '';
			}

			// Update default provider/model config
			if (this._modelProviderSelect) {
				this._modelProviderSelect.value = this._agent.providerId || '';
				await this._refreshModelOptions(this._agent.model);
			}

			// Update bindings tab
			this._renderBindingTab();

			// 应用只读锁（非 owner / 内置 agent 禁用编辑控件）
			this._applyReadOnlyState();
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
				// 双向打通：记录来源，渲染时区分「工作流型 skill」
				source: s.source,
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
			const stat2Val = $$('span.stat-value');
			stat2Val.textContent = this._agent.providerId ? `${this._agent.providerId} / ${model}` : model;
			if (this._agent.providerId) { stat2.title = `默认 Provider: ${this._agent.providerId}`; }
			stat2.appendChild(stat2Val);
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
			if (skill?.source === 'workflow') {
				const wfBadge = $$('span.skill-item-cat');
				wfBadge.textContent = '工作流';
				wfBadge.title = '该技能由工作流注册，触发即执行工作流（双向打通）';
				info.appendChild(wfBadge);
			}
			if (skill?.category) {
				const catEl = $$('span.skill-item-cat');
				catEl.textContent = skill.category;
				info.appendChild(catEl);
			}
			item.appendChild(info);
		const removeBtn = $$('button.skill-remove-btn') as HTMLButtonElement;
			removeBtn.title = '移除';
			removeBtn.textContent = '✕';
			removeBtn.disabled = this._readOnly;
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
			if (skill.source === 'workflow') {
				const wfBadge = $$('span.skill-item-cat');
				wfBadge.textContent = '工作流';
				wfBadge.title = '该技能由工作流注册，触发即执行工作流（双向打通）';
				info.appendChild(wfBadge);
			}
			const catEl = $$('span.skill-item-cat');
			catEl.textContent = skill.category;
			info.appendChild(catEl);
			item.appendChild(info);
		const addBtn = $$('button.skill-add-btn') as HTMLButtonElement;
			addBtn.title = '添加';
			addBtn.textContent = '+';
			addBtn.disabled = this._readOnly;
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
		if (this._readOnly) { return; }
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
		if (this._readOnly) { return; }
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
		if (this._readOnly) { return; }
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
		if (this._readOnly) { return; }
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
		if (this._readOnly) { return; }
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
		// 上传被禁用（未登录 / 非 owner / 内置）→ 直接隐藏按钮
		if (this._uploadDisabled) {
			this._isUploaded = true;
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
		// Permission guard: only the owner (or an unclaimed agent) may upload.
		if (!this.agentStudioService.canUploadAgent(this._agent)) {
			this.notificationService.warn(`仅创建者(owner)可上传该 Agent「${this._agent.name}」`);
			return;
		}
		// Login guard: 未登录（含 TOF 票据自动同步失败）时立即弹错误通知并拦截，
		// 避免弹出版本号 dialog 后才在 publish 时失败。
		try {
			await this.marketplaceService.ensureLoggedIn();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : '请先登录商城后再上传');
			return;
		}
		const name = this._agent.name;
		// 版本预检：拉取商城远端信息（无包则 undefined），用于建议版本号与发布前校验。
		const remote = await this.marketplaceService.getPackage(this._agentId).catch(() => undefined);
		// 版本号建议：远端已有包则在 latest 基础上 patch+1；否则取 agent 当前版本。
		// 若上传因「版本已存在」失败，会自动递增后重新弹框引导重试。
		let version = remote ? suggestNextVersion(remote) : (this._agent.version || '1.0.0');

		while (true) {
			const result = await this.dialogService.input({
				title: `上传 "${name}" 到商城`,
				message: `输入版本号 (如 1.0.0)`,
				inputs: [
					{ value: version, placeholder: '版本号' },
					{ value: '', placeholder: '更新说明 changelog（可选），如：修复表格抽取越界' },
				],
				primaryButton: '上传',
				cancelButton: '取消',
			});
			if (!result.confirmed) { return; }

			version = result.values?.[0]?.trim() || version;
			const changelog = result.values?.[1]?.trim() || undefined;

			// 发布前校验：格式 / 历史版本查重 / 必须大于 latest
			const versionError = validatePublishVersion(version, remote);
			if (versionError) {
				this.notificationService.warn(versionError);
				continue;
			}

			// Collect skill and MCP references from the agent（依赖检查与上传共用）
			const skillRefs = this._agent.skills || [];
			const mcpRefs = this._agent.tools?.filter(t => t.startsWith('mcp:')) || [];

			// 依赖 skill 冲突检查（先于 agent 自身检查）：任一依赖 slug/name 冲突则中止本次上传
			const depConflict = await this._checkDepsConflicts(skillRefs);
			if (depConflict) {
				this.notificationService.error(`上传中止：${depConflict}`);
				return;
			}
			// agent 自身 slug + name 冲突检查
			try {
				await this.marketplaceService.checkPublishConflicts(this._agentId, name, 'agent');
			} catch (conflictErr) {
				this.notificationService.error(`上传中止：${conflictErr instanceof Error ? conflictErr.message : String(conflictErr)}`);
				return;
			}

			try {
				// Auto-upload missing skill/MCP dependencies first
				const uploadedDeps = await this._uploadMissingDeps(skillRefs, mcpRefs, version);
				if (uploadedDeps > 0) {
					this.notificationService.info(`已自动上传 ${uploadedDeps} 个依赖`);
				}

				this.notificationService.info(`正在上传 "${name}" v${version}...`);
				const { version: published } = await this.marketplaceService.publish(this._agentId, 'agent' as PackageKind, {
					name,
					version,
					description: this._agent.description || undefined,
					category: this._agent.category || undefined,
					skillRefs: skillRefs.length > 0 ? skillRefs : undefined,
					mcpRefs: mcpRefs.length > 0 ? mcpRefs : undefined,
					changelog,
				});
				// 发布锚点：autoCommit + git tag，关联商城版本与本地 git 历史（best-effort）
				try {
					await this.agentVersionService.autoCommit(this._agentId!, `publish: v${published} to marketplace`);
					await this.agentVersionService.tag(this._agentId!, `v${published}`);
				} catch { /* non-critical */ }
				this.notificationService.info(`"${name}" v${published} 已上传到商城`);
				this._isUploaded = true;
				this._updateUploadBtn();
				// Claim ownership so non-owners cannot re-upload later.
				await this.agentStudioService.claimAgentOwnership(this._agentId);
				return;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.notificationService.error(`上传 "${name}" 失败: ${msg}`);
				// 版本冲突：自动递增版本号并重新弹框，引导用户重试。
				if (isVersionConflictError(msg)) {
					version = bumpPatch(version);
					continue;
				}
				return;
			}
		}
	}

	/**
	 * 依赖 skill 冲突检查（先于 agent 自身检查）。
	 * 对每个依赖 skill 校验 slug+name 在商城唯一；返回首个冲突的提示文案，全部通过返回 null。
	 * 仅检查本地存在（能被上传）的依赖；本地不存在的依赖不参与检查。
	 */
	private async _checkDepsConflicts(skillRefs: string[]): Promise<string | null> {
		for (const slug of skillRefs) {
			// 与 Agent 同名的依赖由 _uploadMissingDeps 单独提示，这里跳过避免重复报错
			if (slug === this._agentId) { continue; }
			// 本地不存在的依赖不会上传，无需检查
			const skill = this.skillRegistry.getSkill(slug);
			if (!skill) { continue; }
			try {
				await this.marketplaceService.checkPublishConflicts(slug, skill.name || slug, 'skill');
			} catch (err) {
				return `依赖 Skill "${skill.name || slug}" 检查未通过：${err instanceof Error ? err.message : String(err)}`;
			}
		}
		return null;
	}

	/** Auto-upload missing dependencies before uploading the agent. Returns count of uploaded deps. */
	private async _uploadMissingDeps(skillRefs: string[], _mcpRefs: string[], version: string): Promise<number> {
		let uploadedCount = 0;
		for (const slug of skillRefs) {
			// 与 Agent 同名的依赖：slug 全局唯一，先发布 skill 会抢占标识导致 agent 发布被服务端拒绝，跳过并指引改名
			if (slug === this._agentId) {
				this.notificationService.warn(`关联 Skill "${slug}" 与 Agent 同名，商城标识全局唯一。请先将该 Skill 改名（如 ${slug}-skill）并更新 Agent 的 skills 引用后再上传`);
				continue;
			}
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
