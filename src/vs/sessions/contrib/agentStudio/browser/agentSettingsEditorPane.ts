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
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IAgentChatService, IAgentStudioService } from '../common/agentStudio.js';
import { IAgentOSService } from '../common/agentOS.js';
import { ISkillRegistry } from '../common/skills.js';
import { IMarketplaceService, IMarketplaceVersion, PackageKind } from '../common/marketplace.js';
import { bumpPatch, compareSemver, suggestNextVersion, validatePublishVersion, isVersionConflictError } from './publishVersioning.js';
import { IAgentVersionService, type AgentCommitMeta } from '../common/agentVersionTypes.js';
import { gitUnavailableReason } from './gitVersionCore.js';
import { ITofAuthService } from '../common/tofAuth.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import {
	buildEnsureSpec, defaultPortOf, normalizeConfigHtml, previewModeOf, validatePanelUrl,
	type ConfigHtmlCfg,
	nativeIpcBridge,
	normalizePanelUrl,
} from '../common/configHtmlConfig.js';
import { ensureConfigHtmlServerAndOpenPreview } from './configHtmlPreviewOpener.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';
import { ResourceManagerEditorInput } from './resourceManagerEditorInput.js';
import { ResourceManagerEditorPane } from './resourceManagerEditorPane.js';
import { AVATAR_PRESET_GROUPS, AVATAR_PRESET_TOTAL, findAvatarPreset, type IAgentAvatarPreset } from '../common/agentAvatarPresets.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
// ★ 2026-09-23：Channel 绑定页签新增「飞书 CLI」能力（安装/状态/升级 + 创建机器人 + 获取 chat_id）
import { LARK_CLI_INSTALL_COMMAND, LARK_CLI_PACKAGE, larkCliStatusBadge, type ILarkCliStatus } from '../common/larkCli.js';
import { getLarkCliStatus, installLarkCli } from './larkCliService.js';
import { fetchFeishuChats } from './feishuChatList.js';
import { createMainProcessRequestService } from './mainProcessRequestService.js';
import { beginFeishuRegistration, pollFeishuRegistration } from './feishuRegistration.js';
import { drawQrToCanvas } from './feishuQrCode.js';
import { createChannelIcon } from './channelIcons.js';

const { $: $$ } = DOM;

type TabId = 'prompt' | 'skills' | 'mcp' | 'rules' | 'binding' | 'versions' | 'runtime' | 'confightml';

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
	{ id: 'confightml', label: 'ConfigHtml', icon: '🌐' },
];

/** 自定义头像（data URI）压缩后的最大边长（px）——控制 .agent.md 体积 */
const AVATAR_MAX_SIZE = 128;

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
	/** 头像外层容器（承载点击 + hover 相机角标），_iconEl 是它的内容区 */
	private _avatarWrap: HTMLElement | undefined;
	/** 隐藏的图片选择器：上传自定义头像用 */
	private _avatarFileInput: HTMLInputElement | undefined;
	/** 头像编辑浮层（挂在 document.body 上，避免被 header 的 overflow 裁切） */
	private _avatarPopover: HTMLElement | undefined;
	/** 头像预设当前分组（AVATAR_PRESET_GROUPS 的 id） */
	private _avatarPresetGroupId = AVATAR_PRESET_GROUPS[0].id;
	/** 浮层内的预设网格容器 */
	private _avatarPresetGrid: HTMLElement | undefined;
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
	/** ★ 是否已等到「绑定表从磁盘水合完成」（只补一次重渲染，避免无限循环）。 */
	private _bindingsHydrated = false;
	private _bindingInput: HTMLInputElement | undefined;
	private _bindingDefaultToggle: HTMLInputElement | undefined;
	private _bindingDefaultSessionSelect: HTMLSelectElement | undefined;
	// Runtime config (budget)
	private _budgetInput: HTMLInputElement | undefined;
	private _modelProviderSelect: HTMLSelectElement | undefined;
	private _modelIdSelect: HTMLSelectElement | undefined;
	// 图片生成模型（2026-09-10）：与对话模型并列，写入 .agent.md 的 imageModel/imageProviderId
	private _imageProviderSelect: HTMLSelectElement | undefined;
	private _imageModelSelect: HTMLSelectElement | undefined;

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

	// ── Channel 绑定页签 · 飞书 CLI（2026-09-23）──
	/**
	 * 渠道 HTTP 出口：**优先主进程**（渲染进程直连飞书 OpenAPI 会被 CORS 拦，
	 * 见 `mainProcessRequestService.ts` 的实测事故记录），非 Electron 宿主回退渲染进程。
	 */
	private readonly _requestService: IRequestService;
	private _larkCliStatus: ILarkCliStatus | undefined;
	private _larkCliProbing = false;
	private _larkCliInstalling = false;
	private _larkCliStatusEl: HTMLElement | undefined;
	private _larkCliDetailEl: HTMLElement | undefined;
	private _larkCliCheckBtn: HTMLButtonElement | undefined;
	private _larkCliInstallBtn: HTMLButtonElement | undefined;
	private _larkCliOutputEl: HTMLElement | undefined;
	private _larkCliQrEl: HTMLElement | undefined;
	private _larkCliQrPolling = false;
	private _larkCliCreateBtn: HTMLButtonElement | undefined;
	private _chatIdListEl: HTMLElement | undefined;
	private _chatIdFetchBtn: HTMLButtonElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IBridgeService private readonly bridgeService: IBridgeService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@IAgentVersionService private readonly agentVersionService: IAgentVersionService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IRequestService requestService: IRequestService,
	) {
		super(AgentSettingsEditorPane.ID, group, telemetryService, themeService, storageService);
		// ★ 2026-09-23：飞书 CLI 区块（扫码创建机器人 / 列群取 chat_id）需要 HTTP 出口 ——
		//   优先主进程（渲染进程直连飞书 OpenAPI 会被 CORS 拦），非 Electron 宿主回退渲染进程
		this._requestService = createMainProcessRequestService(mainProcessService) ?? requestService;
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
		// 重建 UI 前先收掉挂在 body 上的头像浮层，避免残留孤儿节点
		this._closeAvatarEditor();
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
		this._buildConfigHtmlTab();

		this._showTab(this._activeTab);
	}

	private _buildHeader(parent: HTMLElement): void {
		const header = $$('div.agent-settings-header');

		// ── Row 1: Avatar + Title line + Actions ──
		const row1 = $$('div.agent-settings-row1');

		// Avatar（点击可编辑：上传图片 / 选 Emoji / 恢复默认）
		this._avatarWrap = $$('div.agent-settings-avatar-wrap');
		this._avatarWrap.title = '点击编辑头像';
		this._avatarWrap.onclick = (e) => {
			e.stopPropagation();
			this._toggleAvatarEditor();
		};

		this._iconEl = $$('div.agent-settings-avatar');
		this._iconEl.textContent = '🤖';
		this._avatarWrap.appendChild(this._iconEl);

		const avatarBadge = $$('span.agent-settings-avatar-badge');
		avatarBadge.textContent = '📷';
		this._avatarWrap.appendChild(avatarBadge);

		row1.appendChild(this._avatarWrap);

		// 隐藏的图片选择器（上传自定义头像）
		this._avatarFileInput = document.createElement('input');
		this._avatarFileInput.type = 'file';
		this._avatarFileInput.accept = 'image/png,image/jpeg,image/jpg,image/webp,image/gif,image/svg+xml';
		this._avatarFileInput.style.display = 'none';
		this._avatarFileInput.onchange = () => { void this._handleAvatarFileSelected(); };
		row1.appendChild(this._avatarFileInput);

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

		// ConfigHtml 按钮已移除：功能改为独立页签（🌐 ConfigHtml tab）——
		// 页签内含配置表单（url / displayMode / server）与「打开预览」入口。

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

	// ── Channel 绑定 · 飞书 CLI（2026-09-23）──────────────────────────────
	//
	// 三件事：
	//   ① CLI 的安装 / 状态 / 升级 —— 探测与安装都要 child_process ⇒ 走主进程
	//      （`electron-main/larkCliChannel.ts` ← `browser/larkCliService.ts`）；
	//   ② 创建机器人 —— 复用产品内**已验证**的 PersonalAgent 扫码流程。飞书 CLI 自己的
	//      `config init --new` 需要浏览器交互、输出是给人看的文本（解析不稳定），不适合内联做；
	//   ③ 获取 chat_id —— 用渠道自身 app 凭证列「机器人所在的群」（与扫码绑定/测试连接同一条链路）。
	//      刻意不依赖 CLI：CLI 要先 `config init` / `auth login` 才有凭证，而渠道配置里已经有了。

	/** 构建「飞书 CLI」分组（加入 Channel 绑定页签的飞书渠道分组）。 */
	private _buildLarkCliSection(): HTMLElement {
		const sec = $$('div.binding-section');
		const title = $$('div.binding-section-title');
		title.textContent = '飞书 CLI';
		sec.appendChild(title);

		const hint = $$('div.binding-hint');
		hint.textContent = `官方 CLI（${LARK_CLI_PACKAGE}）：装好后可在终端用 lark-cli 直接操作飞书（发消息 / 查群 / 读写文档），也供 AI 技能调用。安装与升级是同一条命令 —— 官方文档未提供独立的 upgrade 子命令。`;
		sec.appendChild(hint);

		// 状态行：徽章 + 版本/路径 + 两个动作
		const statusRow = $$('div.binding-add-row');
		this._larkCliStatusEl = $$('span.larkcli-badge');
		this._larkCliStatusEl.textContent = '检测中…';
		statusRow.appendChild(this._larkCliStatusEl);
		this._larkCliDetailEl = $$('span.larkcli-detail');
		statusRow.appendChild(this._larkCliDetailEl);
		this._larkCliCheckBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		this._larkCliCheckBtn.textContent = '🔄 重新检测';
		this._larkCliCheckBtn.onclick = () => void this._refreshLarkCliStatus(true);
		statusRow.appendChild(this._larkCliCheckBtn);
		this._larkCliInstallBtn = $$('button.agent-settings-btn primary') as HTMLButtonElement;
		this._larkCliInstallBtn.onclick = () => void this._installLarkCli();
		statusRow.appendChild(this._larkCliInstallBtn);
		sec.appendChild(statusRow);

		this._larkCliOutputEl = $$('div.larkcli-output');
		this._larkCliOutputEl.style.display = 'none';
		sec.appendChild(this._larkCliOutputEl);

		// 创建机器人（扫码）
		const botRow = $$('div.binding-add-row');
		this._larkCliCreateBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		this._larkCliCreateBtn.textContent = '🤖 创建机器人（扫码授权）';
		this._larkCliCreateBtn.onclick = () => void this._createFeishuBotByQr();
		botRow.appendChild(this._larkCliCreateBtn);
		const botHint = $$('span.larkcli-detail');
		botHint.textContent = '扫码授权后自动写入渠道凭证（app_id / app_secret），无需手工复制。';
		botRow.appendChild(botHint);
		sec.appendChild(botRow);
		this._larkCliQrEl = $$('div.larkcli-qr');
		this._larkCliQrEl.style.display = 'none';
		sec.appendChild(this._larkCliQrEl);

		// 获取 chat_id
		const chatRow = $$('div.binding-add-row');
		this._chatIdFetchBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		this._chatIdFetchBtn.textContent = '📋 获取 chat_id（机器人所在的群）';
		this._chatIdFetchBtn.onclick = () => void this._fetchChatIds();
		chatRow.appendChild(this._chatIdFetchBtn);
		sec.appendChild(chatRow);
		this._chatIdListEl = $$('div.chatid-list');
		sec.appendChild(this._chatIdListEl);

		return sec;
	}

	/** 刷新 CLI 状态（页签切入时静默探测；手动点击给通知）。 */
	private async _refreshLarkCliStatus(manual: boolean): Promise<void> {
		if (this._larkCliProbing) { return; }
		this._larkCliProbing = true;
		this._applyLarkCliBusy();
		try {
			const status = await getLarkCliStatus();
			this._larkCliStatus = status;
			this._renderLarkCliStatus();
			if (manual) {
				if (!status.available) {
					this.notificationService.warn(`飞书 CLI 探测不可用：${status.error ?? '未知原因'}`);
				} else if (!status.installed) {
					this.notificationService.info(`未检测到飞书 CLI${status.latestVersion ? `（npm 最新 ${status.latestVersion}）` : ''}，可点「安装」`);
				} else {
					const badge = larkCliStatusBadge(status);
					this.notificationService.info(badge.tone === 'warn'
						? `飞书 CLI ${status.version} 可升级到 ${status.latestVersion}`
						: `飞书 CLI 就绪：${badge.label}`);
				}
			}
		} finally {
			this._larkCliProbing = false;
			this._applyLarkCliBusy();
		}
	}

	/** 按状态刷新徽章 / 详情 / 按钮文案。 */
	private _renderLarkCliStatus(): void {
		const status = this._larkCliStatus;
		const badge = larkCliStatusBadge(status);
		if (this._larkCliStatusEl) {
			this._larkCliStatusEl.textContent = badge.label;
			this._larkCliStatusEl.className = `larkcli-badge tone-${badge.tone}`;
			this._larkCliStatusEl.title = status?.error ?? '';
		}
		if (this._larkCliDetailEl) {
			const parts: string[] = [];
			if (status?.path) { parts.push(status.path); }
			if (status?.latestVersion) { parts.push(`npm 最新 ${status.latestVersion}`); }
			if (status?.available && !status.installed) { parts.push(`将执行：${LARK_CLI_INSTALL_COMMAND}`); }
			if (!status?.available && status?.error) { parts.push(status.error); }
			this._larkCliDetailEl.textContent = parts.join(' · ');
		}
		if (this._larkCliInstallBtn) {
			this._larkCliInstallBtn.textContent = this._larkCliInstalling ? '⏳ 安装中…' : (status?.installed ? '⬆ 升级' : '⬇ 安装');
			this._larkCliInstallBtn.disabled = this._readOnly || this._larkCliInstalling || !status?.available;
		}
	}

	/** 忙碌态统一处理（探测 / 安装期间禁用按钮并改文案）。 */
	private _applyLarkCliBusy(): void {
		const busy = this._larkCliProbing || this._larkCliInstalling;
		if (this._larkCliCheckBtn) {
			this._larkCliCheckBtn.disabled = this._readOnly || busy;
			this._larkCliCheckBtn.textContent = this._larkCliProbing ? '⏳ 检测中…' : '🔄 重新检测';
		}
		if (this._larkCliInstallBtn) {
			this._larkCliInstallBtn.disabled = this._readOnly || busy || this._larkCliStatus?.available === false;
		}
	}

	/** 安装 / 升级（同一命令）；完成后自动重新探测并回显输出尾部。 */
	private async _installLarkCli(): Promise<void> {
		if (this._larkCliInstalling) { return; }
		this._larkCliInstalling = true;
		this._applyLarkCliBusy();
		this._showLarkCliOutput(`⏳ 正在执行：${LARK_CLI_INSTALL_COMMAND}\n（首次安装会下载依赖，可能 1-2 分钟）`);
		this.notificationService.info('正在主进程执行飞书 CLI 安装 / 升级');
		try {
			const r = await installLarkCli();
			this._showLarkCliOutput(`${r.ok ? '✅' : '❌'} ${r.message}${r.output ? `\n\n${r.output}` : ''}`);
			if (r.ok) {
				this.notificationService.info(r.message);
			} else {
				this.notificationService.error(`飞书 CLI 安装失败：${r.message}`);
			}
		} finally {
			this._larkCliInstalling = false;
			this._applyLarkCliBusy();
			await this._refreshLarkCliStatus(false);
		}
	}

	private _showLarkCliOutput(text: string): void {
		if (!this._larkCliOutputEl) { return; }
		this._larkCliOutputEl.textContent = text;
		this._larkCliOutputEl.style.display = '';
	}

	/**
	 * 创建机器人：复用 PersonalAgent 扫码流程（与渠道编辑器的「📷 扫码绑定」同一协议）。
	 * 授权完成后把 app_id / app_secret 写入渠道配置并启用（与手工绑定同一落点）。
	 */
	private async _createFeishuBotByQr(): Promise<void> {
		if (this._larkCliQrPolling) { return; }
		const host = this._larkCliQrEl;
		const createBtn = this._larkCliCreateBtn;
		if (!host) { return; }

		host.replaceChildren();
		host.style.display = '';
		const canvas = document.createElement('canvas');
		canvas.className = 'larkcli-qr-canvas';
		const statusEl = $$('div.larkcli-qr-status');
		statusEl.textContent = '正在向飞书申请授权…';
		host.appendChild(canvas);
		host.appendChild(statusEl);

		this._larkCliQrPolling = true;
		if (createBtn) { createBtn.disabled = true; }
		const setStatus = (msg: string): void => { statusEl.textContent = msg; };

		try {
			const begin = await beginFeishuRegistration(this._requestService);
			drawQrToCanvas(canvas, begin.qrUrl);
			setStatus('请用飞书扫码授权（授权后自动创建机器人并回填凭证）');

			// 间隔与超时都取自服务端返回，避免写死
			const deadline = Date.now() + begin.expiresIn * 1000;
			let interval = begin.interval;
			while (Date.now() < deadline) {
				await this._larkCliSleep(interval * 1000);
				const r = await pollFeishuRegistration(this._requestService, begin.deviceCode);
				if (r.status === 'completed') {
					const appId = r.appId ?? '';
					const appSecret = r.appSecret ?? '';
					if (!appId || !appSecret) { setStatus('❌ 飞书未返回有效凭证'); return; }
					await this.configurationService.updateValue('sessions.channel.feishu.appId', appId);
					await this.configurationService.updateValue('sessions.channel.feishu.appSecret', appSecret);
					await this.configurationService.updateValue('sessions.channel.feishu.enabled', true);
					setStatus(`✅ 机器人已创建：${appId}（凭证已写入渠道配置并启用）`);
					this.notificationService.info(`飞书机器人已创建：${appId}`);
					return;
				}
				if (r.status === 'denied') { setStatus('❌ 授权被拒绝'); return; }
				if (r.status === 'expired') { setStatus('⌛ 授权已过期，请重新发起'); return; }
				if (r.status === 'error') { setStatus(`❌ ${r.error ?? '授权失败'}`); return; }
				if (r.status === 'slow_down') { interval += 5; }
			}
			setStatus('⌛ 等待超时，请重新发起');
		} catch (e) {
			setStatus(`❌ 发起失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this._larkCliQrPolling = false;
			if (createBtn) { createBtn.disabled = false; }
		}
	}

	/** 获取 chat_id：列「机器人所在的群」，可一键填入输入框或直接绑定到本 Agent。 */
	private async _fetchChatIds(): Promise<void> {
		const listEl = this._chatIdListEl;
		if (!listEl) { return; }
		const appId = String(this.configurationService.getValue('sessions.channel.feishu.appId') ?? '').trim();
		const appSecret = String(this.configurationService.getValue('sessions.channel.feishu.appSecret') ?? '').trim();
		listEl.replaceChildren();
		if (!appId || !appSecret) {
			const tip = $$('div.skills-empty');
			tip.textContent = '尚未配置飞书应用凭证：先点上方「创建机器人（扫码授权）」，或手工填写 app_id / app_secret。';
			listEl.appendChild(tip);
			return;
		}
		if (this._chatIdFetchBtn) { this._chatIdFetchBtn.disabled = true; this._chatIdFetchBtn.textContent = '⏳ 拉取中…'; }
		try {
			const chats = await fetchFeishuChats(this._requestService, appId, appSecret);
			if (chats.length === 0) {
				const tip = $$('div.skills-empty');
				tip.textContent = '机器人还没有加入任何群：把机器人拉进一个群后重新拉取。';
				listEl.appendChild(tip);
				return;
			}
			for (const chat of chats) {
				const item = $$('div.chatid-item');
				const info = $$('div.chatid-item-info');
				const nameEl = $$('span.chatid-item-name');
				nameEl.textContent = chat.name;
				const idEl = $$('span.chatid-item-id');
				idEl.textContent = chat.memberCount ? `${chat.chatId} · ${chat.memberCount} 人` : chat.chatId;
				info.appendChild(nameEl);
				info.appendChild(idEl);
				item.appendChild(info);

				const fillBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
				fillBtn.textContent = '填入';
				fillBtn.title = '填入上方「输入飞书群聊会话 ID」输入框';
				fillBtn.onclick = () => {
					if (this._bindingInput) { this._bindingInput.value = chat.chatId; this._bindingInput.focus(); }
				};
				item.appendChild(fillBtn);

				const bindBtn = $$('button.agent-settings-btn primary') as HTMLButtonElement;
				bindBtn.textContent = '绑定到本 Agent';
				bindBtn.disabled = this._readOnly;
				bindBtn.onclick = () => {
					if (this._bindingInput) { this._bindingInput.value = chat.chatId; }
					void this._addFeishuBinding();
				};
				item.appendChild(bindBtn);
				listEl.appendChild(item);
			}
		} catch (e) {
			const tip = $$('div.skills-empty');
			tip.textContent = `拉取群列表失败：${e instanceof Error ? e.message : String(e)}`;
			listEl.appendChild(tip);
		} finally {
			if (this._chatIdFetchBtn) {
				this._chatIdFetchBtn.disabled = false;
				this._chatIdFetchBtn.textContent = '📋 获取 chat_id（机器人所在的群）';
			}
		}
	}

	/** 轮询间隔用的简单延时（独立命名，避免与其它页签的同名 helper 冲突）。 */
	private _larkCliSleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
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
		// ★ 2026-09-23：与设置页渠道条目一致 —— 用飞书**官方品牌 SVG**（未收录品牌才回退 emoji）
		groupIcon.appendChild(createChannelIcon('feishu', '🔵', 18));
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

		// 默认会话下拉：勾选默认 Agent 后，未精确绑定的飞书消息统一进入所选会话
		const defSessionRow = $$('div.binding-default-row');
		const defSessionLabel = $$('label.binding-default-label');
		defSessionLabel.textContent = '默认会话（未精确绑定的消息进入此会话；留空则每群自动建专属会话）：';
		defSessionRow.appendChild(defSessionLabel);
		this._bindingDefaultSessionSelect = document.createElement('select');
		this._bindingDefaultSessionSelect.className = 'binding-input';
		this._bindingDefaultSessionSelect.onchange = () => this._setFeishuDefaultSession();
		defSessionRow.appendChild(this._bindingDefaultSessionSelect);
		sec1.appendChild(defSessionRow);
		group.appendChild(sec1);

		// Section 2: 群聊绑定（按会话 chat_id）
		const sec2 = $$('div.binding-section');
		const sec2Title = $$('div.binding-section-title');
		sec2Title.textContent = '群聊绑定（按会话）';
		sec2.appendChild(sec2Title);

		const hint = $$('div.binding-hint');
		// ⚠ 同 `agentChatPanel.dropdowns.ts` 的口径 ✓：取号路径 = 客户端飞书 → 群设置 → 底部「会话 ID」✓
		hint.textContent = '在客户端飞书中打开该群 → 点右上角「⋯」进入群设置 → 拉到底部，「会话 ID」字段就是本群 chat_id。绑定的群聊消息将自动路由给本 Agent。';
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

		// Section 3: 飞书 CLI（安装 / 状态 / 升级 + 创建机器人 + 获取 chat_id）
		group.appendChild(this._buildLarkCliSection());

		section.appendChild(group);
		this._tabContentContainer?.appendChild(section);
	}

	private _renderBindingTab(): void {
		if (!this._agentId) { return; }

		// 飞书 CLI 区块：切入页签时静默探测一次（手动「重新检测」按钮才会弹通知）
		void this._refreshLarkCliStatus(false);

		// ★ 绑定表在主进程持久化（IPC 读盘异步）：水合完成后再渲染一次，
		//   否则启动后首次打开列表为空 —— 看起来像「重启后绑定丢了」（实测磁盘上有数据）。
		if (!this._bindingsHydrated) {
			void this.bridgeService.ensureBindingsLoaded().then(() => {
				this._bindingsHydrated = true;
				this._renderBindingTab();
			});
		}

		// 飞书渠道默认 Agent 开关
		if (this._bindingDefaultToggle) {
			const cur = this.configurationService.getValue<string>('sessions.channel.feishu.defaultAgent');
			this._bindingDefaultToggle.checked = (cur === this._agentId);
		}

		// 默认会话下拉：启用态跟随勾选，选项为本 Agent 名下会话
		void this._refreshDefaultSessionSelect();

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
			// 取消默认 Agent 时同步清除默认会话（会话归属本 agent，留着是悬空引用）
			try {
				this.bridgeService.getEngine().setChannelDefaultSession('feishu', this._agentId, undefined);
			} catch { /* 引擎未就绪：忽略 */ }
			this.notificationService.info('已取消飞书渠道默认 Agent');
		}
		if (this._bindingDefaultSessionSelect) {
			this._bindingDefaultSessionSelect.disabled = !this._bindingDefaultToggle.checked;
		}
	}

	/** 填充默认会话下拉：本 Agent 名下会话 + 当前选中态；启用态跟随默认 Agent 勾选。 */
	private async _refreshDefaultSessionSelect(): Promise<void> {
		const select = this._bindingDefaultSessionSelect;
		if (!select || !this._agentId) { return; }
		select.disabled = this._readOnly || !(this._bindingDefaultToggle?.checked ?? false);
		let sessions: Array<{ id: string; name: string }> = [];
		try {
			const list = await this.agentChatService.listAgentSessions(this._agentId);
			sessions = list
				.slice()
				.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
				.map(s => ({ id: s.id, name: s.name }));
		} catch { /* 列表加载失败：仅显示占位项 */ }
		select.replaceChildren();
		const autoOpt = document.createElement('option');
		autoOpt.value = '';
		autoOpt.textContent = '（每群自动建专属会话）';
		select.appendChild(autoOpt);
		let cur: string | undefined;
		try {
			const def = this.bridgeService.getEngine().getChannelDefaultSession('feishu');
			cur = def && def.agentId === this._agentId ? def.agentSessionId : undefined;
		} catch { /* 引擎未就绪 */ }
		for (const s of sessions) {
			const opt = document.createElement('option');
			opt.value = s.id;
			opt.textContent = s.name || s.id;
			if (s.id === cur) { opt.selected = true; }
			select.appendChild(opt);
		}
	}

	private _setFeishuDefaultSession(): void {
		if (this._readOnly) { return; }
		if (!this._agentId || !this._bindingDefaultSessionSelect) { return; }
		const sessionId = this._bindingDefaultSessionSelect.value || undefined;
		try {
			this.bridgeService.getEngine().setChannelDefaultSession('feishu', this._agentId, sessionId);
			this.notificationService.info(sessionId
				? '已设置飞书默认会话（未精确绑定的消息将进入此会话）'
				: '已恢复为每群自动建专属会话');
		} catch (err) {
			this.notificationService.error(`设置失败: ${err instanceof Error ? err.message : String(err)}`);
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

		// 头像编辑入口：只读时禁用点击并关闭已打开的浮层
		if (this._avatarWrap) {
			this._avatarWrap.classList.toggle('readonly', this._readOnly);
			this._avatarWrap.title = this._readOnly ? '仅创建者(owner)可编辑' : '点击编辑头像';
		}
		if (this._readOnly) { this._closeAvatarEditor(); }

		if (this._readOnly) {
			// 禁用固定编辑控件
			if (this._promptTextarea) { this._promptTextarea.disabled = true; }
			if (this._promptSaveBtn) { this._promptSaveBtn.style.display = 'none'; }
			if (this._bindingInput) { this._bindingInput.disabled = true; }
			if (this._bindingDefaultToggle) { this._bindingDefaultToggle.disabled = true; }
			if (this._bindingAddBtn) { this._bindingAddBtn.disabled = true; }
			if (this._renameInput) { this._renameInput.disabled = true; }
			if (this._budgetInput) { this._budgetInput.disabled = true; }
			if (this._modelProviderSelect) { this._modelProviderSelect.disabled = true; }
			if (this._modelIdSelect) { this._modelIdSelect.disabled = true; }
			if (this._imageProviderSelect) { this._imageProviderSelect.disabled = true; }
			if (this._imageModelSelect) { this._imageModelSelect.disabled = true; }

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
			if (this._budgetInput) { this._budgetInput.disabled = false; }
			if (this._modelProviderSelect) { this._modelProviderSelect.disabled = false; }
			if (this._modelIdSelect) { this._modelIdSelect.disabled = false; }
			if (this._imageProviderSelect) { this._imageProviderSelect.disabled = false; }
			if (this._imageModelSelect) { this._imageModelSelect.disabled = false; }
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

	// ── Runtime Config Tab (budget) ──

	private _buildRuntimeTab(): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = 'runtime';


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

		// ── 图片生成模型（2026-09-10）──
		// 与上方对话模型并列的独立配置：聊天框「图片模型」选择器读此值作为默认，
		// 图片生成工具（image_generate）未显式指定时也用它兜底。
		const imgGroup = $$('div.agent-settings-form-group');
		const imgLabel = $$('label.agent-settings-label');
		imgLabel.textContent = '图片生成模型';
		imgGroup.appendChild(imgLabel);

		const imgDesc = $$('div.agent-settings-desc');
		imgDesc.textContent = '聊天框「图片模型」选择器的默认值，以及图片生成工具的兜底模型。仅列出标记了 supportsImageGen 的模型；选择「跟随全局默认」时由聊天框临时选择决定';
		imgGroup.appendChild(imgDesc);

		this._imageProviderSelect = document.createElement('select');
		this._imageProviderSelect.className = 'agent-settings-select';
		const imgAutoOpt = document.createElement('option');
		imgAutoOpt.value = '';
		imgAutoOpt.textContent = '跟随全局默认';
		this._imageProviderSelect.appendChild(imgAutoOpt);
		for (const p of this.agentOSService.getModelProviders()) {
			const opt = document.createElement('option');
			opt.value = p.id;
			opt.textContent = p.name;
			this._imageProviderSelect.appendChild(opt);
		}
		this._imageProviderSelect.onchange = () => {
			void this._onImageProviderChanged();
		};
		imgGroup.appendChild(this._imageProviderSelect);

		this._imageModelSelect = document.createElement('select');
		this._imageModelSelect.className = 'agent-settings-select';
		this._imageModelSelect.style.marginTop = '6px';
		this._imageModelSelect.onchange = () => {
			void this._saveImageModelConfig();
		};
		imgGroup.appendChild(this._imageModelSelect);
		section.appendChild(imgGroup);

		this._tabContentContainer?.appendChild(section);
	}

	/** 图片 Provider 切换：重新加载该 provider 的图片模型列表并保存 */
	private async _onImageProviderChanged(): Promise<void> {
		await this._refreshImageModelOptions();
		await this._saveImageModelConfig();
	}

	/** 刷新图片模型下拉（仅 supportsImageGen 的模型）；preferModelId 用于加载时预选 */
	private async _refreshImageModelOptions(preferModelId?: string): Promise<void> {
		const providerSelect = this._imageProviderSelect;
		const modelSelect = this._imageModelSelect;
		if (!providerSelect || !modelSelect) { return; }

		const providerId = providerSelect.value;
		modelSelect.replaceChildren();

		if (!providerId) {
			const opt = document.createElement('option');
			opt.value = '';
			opt.textContent = '（跟随全局默认 / 聊天框选择）';
			modelSelect.appendChild(opt);
			modelSelect.disabled = true;
			return;
		}

		modelSelect.disabled = this._readOnly;
		const provider = this.agentOSService.getModelProviders().find(p => p.id === providerId);
		let models: { id: string; name: string }[] = [];
		try {
			// 只保留声明支持图片生成的模型（IModelInfo.supportsImageGen）
			models = (await provider?.listModels() ?? [])
				.filter(m => (m as { supportsImageGen?: boolean }).supportsImageGen === true)
				.map(m => ({ id: m.id, name: m.name || m.id }));
		} catch { /* provider 模型列表加载失败时仅回退到当前值 */ }

		// 当前已保存的模型必须始终可选（即使不在 provider 列表中）
		const current = preferModelId ?? this._agent?.imageModel ?? '';
		if (current && !models.some(m => m.id === current)) {
			models = [{ id: current, name: `${current}（当前）` }, ...models];
		}
		if (models.length === 0) {
			const opt = document.createElement('option');
			opt.value = '';
			opt.textContent = '（该 Provider 无图片生成模型）';
			modelSelect.appendChild(opt);
			return;
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

	/** 保存图片生成模型配置到 agent（.agent.md 的 imageModel/imageProviderId） */
	private async _saveImageModelConfig(): Promise<void> {
		if (!this._agentId || this._readOnly || !this._imageProviderSelect) { return; }
		try {
			const providerId = this._imageProviderSelect.value || undefined;
			const patch: Partial<Agent> = { imageProviderId: providerId };
			// 仅在指定 provider 时同步写入模型；跟随全局默认时清空（避免残留旧值误导聊天框）
			if (providerId && this._imageModelSelect?.value) {
				patch.imageModel = this._imageModelSelect.value;
			} else {
				patch.imageModel = undefined;
			}
			await this.agentStudioService.updateAgent(this._agentId, patch);
			if (this._agent) {
				this._agent.imageProviderId = providerId;
				this._agent.imageModel = patch.imageModel;
			}
			this.logService.info(
				`[AgentSettingsEditorPane] _saveImageModelConfig: agentId=${this._agentId} ` +
				`imageProviderId=${providerId ?? '(default)'} imageModel=${patch.imageModel ?? '(cleared)'} → .agent.md`
			);
		} catch (err) {
			this.logService.error('[AgentSettingsEditorPane] _saveImageModelConfig failed:', err);
			this.notificationService.warn(`保存图片模型配置失败: ${err instanceof Error ? err.message : String(err)}`);
		}
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
			this.logService.info(
				`[AgentSettingsEditorPane] _saveModelConfig: agentId=${this._agentId} ` +
				`providerId=${providerId ?? '(default)'} model=${patch.model ?? '(unchanged)'} → .agent.md`
			);
			this._renderHeader();
		} catch (err) {
			this.logService.error('[AgentSettingsEditorPane] _saveModelConfig failed:', err);
			this.notificationService.warn(`保存模型配置失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _saveRuntimeConfig(): Promise<void> {
		if (!this._agentId || this._readOnly) { return; }
		try {
			const budgetVal = this._budgetInput?.value.trim();
			const budgetMaxTotal = budgetVal ? parseInt(budgetVal, 10) : undefined;
			await this.agentStudioService.updateAgent(this._agentId, {
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
		// 进入 ConfigHtml 页签时刷新表单（反映外部/其他端变更）
		if (tabId === 'confightml') {
			this._fillConfigHtmlTab();
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

			// ★ 同步 ConfigHtml 表单：外部入口（聊天框设置、另一个设置页实例等）保存后
			//   会触发 onDidChangeAgents → 走到这里；不刷新就会出现
			//   「两个设置面板显示不同地址」的不同步（_showTab 只在切 tab 时才填表单）。
			this._fillConfigHtmlTab();

			// Update runtime config (budget)
			if (this._budgetInput) {
				this._budgetInput.value = this._agent.budgetMaxTotal !== undefined ? String(this._agent.budgetMaxTotal) : '';
			}

			// Update default provider/model config
			if (this._modelProviderSelect) {
				this._modelProviderSelect.value = this._agent.providerId || '';
				await this._refreshModelOptions(this._agent.model);
			}

			// 回填图片生成模型（2026-09-10）
			if (this._imageProviderSelect) {
				this._imageProviderSelect.value = this._agent.imageProviderId || '';
				await this._refreshImageModelOptions(this._agent.imageModel);
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
		this._renderAvatar();
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

	// ═══════════════════════════════════════════════════════════════════════════
	//  Avatar（可编辑：agent.icon = Emoji，agent.avatar = 自定义图片 data URI）
	// ═══════════════════════════════════════════════════════════════════════════

	private _renderAvatar(): void {
		if (!this._iconEl) { return; }
		this._iconEl.replaceChildren();
		const avatar = this._agent?.avatar;
		if (avatar) {
			const img = document.createElement('img');
			img.className = 'agent-settings-avatar-img';
			img.src = avatar;
			img.alt = this._agent?.name || 'avatar';
			// data URI 损坏 / 图片被删除 → 回退 Emoji，避免出现空白方块
			img.onerror = () => {
				if (this._iconEl) { this._iconEl.textContent = this._agent?.icon || '🤖'; }
			};
			this._iconEl.appendChild(img);
		} else {
			this._iconEl.textContent = this._agent?.icon || '🤖';
		}
	}

	private _toggleAvatarEditor(): void {
		if (this._readOnly) {
			this.notificationService.warn(this._readOnlyReason || '只读模式：仅创建者(owner)可编辑此 Agent');
			return;
		}
		if (this._avatarPopover) {
			this._closeAvatarEditor();
			return;
		}
		this._openAvatarEditor();
	}

	private _openAvatarEditor(): void {
		if (!this._agent || !this._avatarWrap) { return; }
		this._closeAvatarEditor();

		// 当前头像若来自预设，打开时自动切到它所在的分组，让选中态可见
		const hit = findAvatarPreset(this._agent.avatar);
		if (hit) {
			const owner = AVATAR_PRESET_GROUPS.find(g => g.presets.some(p => p.id === hit.id));
			if (owner) { this._avatarPresetGroupId = owner.id; }
		}

		const popover = $$('div.agent-avatar-popover');
		popover.onclick = (e) => e.stopPropagation();
		popover.oncontextmenu = (e) => e.stopPropagation();

		const title = $$('div.agent-avatar-popover-title');
		title.textContent = `编辑头像（${AVATAR_PRESET_TOTAL} 款 SVG 预设）`;
		popover.appendChild(title);

		// ── 分组切换：机器人 / 造型 / Emoji ──
		const tabBar = $$('div.agent-avatar-tabs');
		for (const group of AVATAR_PRESET_GROUPS) {
			const tab = $$('button.agent-avatar-tab') as HTMLButtonElement;
			tab.textContent = group.label;
			tab.title = group.title;
			tab.dataset.groupId = group.id;
			if (group.id === this._avatarPresetGroupId) { tab.classList.add('active'); }
			tab.onclick = () => {
				this._avatarPresetGroupId = group.id;
				tabBar.querySelectorAll('.agent-avatar-tab').forEach(el => {
					el.classList.toggle('active', (el as HTMLElement).dataset.groupId === group.id);
				});
				this._renderAvatarPresets();
			};
			tabBar.appendChild(tab);
		}
		popover.appendChild(tabBar);

		// ── 预设网格（SVG data URI，点击即写入 agent.avatar + 配套 icon） ──
		this._avatarPresetGrid = $$('div.agent-avatar-presets');
		popover.appendChild(this._avatarPresetGrid);
		this._renderAvatarPresets();

		// ── 操作按钮 ──
		const actions = $$('div.agent-avatar-actions');

		const uploadBtn = $$('button.primary') as HTMLButtonElement;
		uploadBtn.textContent = '📤 上传图片';
		uploadBtn.title = '从本地选择图片作为头像（自动压缩，无需手动裁剪）';
		uploadBtn.onclick = () => {
			this._closeAvatarEditor();
			this._avatarFileInput?.click();
		};
		actions.appendChild(uploadBtn);

		const currentIcon = this._agent.icon || '🤖';
		const resetBtn = $$('button') as HTMLButtonElement;
		resetBtn.textContent = '↺ 恢复默认';
		resetBtn.title = '清除自定义头像，恢复默认图标';
		resetBtn.disabled = !this._agent.avatar && currentIcon === '🤖';
		resetBtn.onclick = () => { void this._saveAvatarPatch({ icon: '🤖', avatar: undefined }, '已恢复默认头像'); };
		actions.appendChild(resetBtn);

		popover.appendChild(actions);
		document.body.appendChild(popover);
		this._avatarPopover = popover;

		// 定位：默认在头像下方，空间不足则向上翻转，并做水平收边
		const rect = this._avatarWrap.getBoundingClientRect();
		const pw = popover.offsetWidth;
		const ph = popover.offsetHeight;
		let left = rect.left;
		let top = rect.bottom + 8;
		if (left + pw > window.innerWidth - 8) { left = Math.max(8, window.innerWidth - pw - 8); }
		if (top + ph > window.innerHeight - 8) { top = Math.max(8, rect.top - ph - 8); }
		popover.style.left = `${Math.round(left)}px`;
		popover.style.top = `${Math.round(top)}px`;

		// 点击浮层外部 / Esc → 关闭（延后一帧注册，避免吞掉触发本次打开的 mousedown）
		setTimeout(() => {
			if (this._avatarPopover === popover) {
				document.addEventListener('mousedown', this._avatarOutsideHandler, true);
			}
		}, 0);
		document.addEventListener('keydown', this._avatarKeydownHandler, true);
	}

	/** 渲染当前分组的 SVG 预设网格；切换分组时复用同一个容器。 */
	private _renderAvatarPresets(): void {
		const grid = this._avatarPresetGrid;
		if (!grid) { return; }
		grid.replaceChildren();

		const group = AVATAR_PRESET_GROUPS.find(g => g.id === this._avatarPresetGroupId) ?? AVATAR_PRESET_GROUPS[0];
		const current = this._agent?.avatar;
		for (const preset of group.presets) {
			grid.appendChild(this._buildAvatarPresetItem(preset, preset.dataUri === current));
		}
	}

	private _buildAvatarPresetItem(preset: IAgentAvatarPreset, active: boolean): HTMLElement {
		const item = $$('button.agent-avatar-preset') as HTMLButtonElement;
		item.title = preset.label;
		item.type = 'button';
		item.dataset.presetId = preset.id;
		if (active) { item.classList.add('active'); }

		const img = document.createElement('img');
		img.src = preset.dataUri;
		img.alt = preset.label;
		img.draggable = false;
		item.appendChild(img);

		item.onclick = () => {
			void this._saveAvatarPatch(
				{ avatar: preset.dataUri, icon: preset.icon },
				`头像已切换为「${preset.label}」`
			);
		};
		return item;
	}

	private _closeAvatarEditor(): void {
		document.removeEventListener('mousedown', this._avatarOutsideHandler, true);
		document.removeEventListener('keydown', this._avatarKeydownHandler, true);
		this._avatarPopover?.remove();
		this._avatarPopover = undefined;
		this._avatarPresetGrid = undefined;
	}

	private readonly _avatarOutsideHandler = (e: MouseEvent): void => {
		const target = e.target as Node | null;
		if (this._avatarPopover?.contains(target)) { return; }
		if (this._avatarWrap?.contains(target)) { return; }
		this._closeAvatarEditor();
	};

	private readonly _avatarKeydownHandler = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') {
			e.preventDefault();
			this._closeAvatarEditor();
		}
	};

	private async _handleAvatarFileSelected(): Promise<void> {
		const input = this._avatarFileInput;
		const file = input?.files?.[0];
		// 立即清空 value，保证连续选择同一个文件也能触发 change
		if (input) { input.value = ''; }
		if (!file || !this._agentId) { return; }
		if (!file.type.startsWith('image/')) {
			this.notificationService.warn('请选择图片文件（png / jpg / webp / gif / svg）');
			return;
		}
		try {
			const avatar = await this._readImageAsAvatar(file);
			await this._saveAvatarPatch({ avatar }, '头像已更新');
		} catch (err) {
			this.notificationService.error(`头像上传失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _saveAvatarPatch(patch: Partial<Agent>, successMessage?: string): Promise<void> {
		if (this._readOnly) {
			this.notificationService.warn(this._readOnlyReason || '只读模式：仅创建者(owner)可编辑此 Agent');
			return;
		}
		if (!this._agentId || !this._agent) { return; }
		try {
			await this.agentStudioService.updateAgent(this._agentId, patch);
			// 乐观更新，避免 onDidChangeAgents 回读完成前的闪烁
			this._agent = { ...this._agent, ...patch };
			this._renderAvatar();
			this._closeAvatarEditor();
			if (successMessage) { this.notificationService.info(successMessage); }
		} catch (err) {
			this.notificationService.error(`头像保存失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 读取本地图片为 data URI；位图统一压缩到 AVATAR_MAX_SIZE，SVG 保持矢量内联。 */
	private async _readImageAsAvatar(file: File): Promise<string> {
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result ?? ''));
			reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
			reader.readAsDataURL(file);
		});
		if (!dataUrl) { throw new Error('读取文件失败'); }
		// SVG 本身极小且无损缩放，直接内联；canvas 位图化反而会丢矢量优势
		if (/^data:image\/svg\+xml/i.test(dataUrl)) { return dataUrl; }
		try {
			return await this._downscaleImage(dataUrl, AVATAR_MAX_SIZE);
		} catch {
			// 压缩失败（如无 canvas）时退回原图，保证功能可用
			return dataUrl;
		}
	}

	private _downscaleImage(dataUrl: string, maxSize: number): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				try {
					const w = img.naturalWidth || maxSize;
					const h = img.naturalHeight || maxSize;
					const scale = Math.min(1, maxSize / Math.max(w, h));
					const tw = Math.max(1, Math.round(w * scale));
					const th = Math.max(1, Math.round(h * scale));
					const canvas = document.createElement('canvas');
					canvas.width = tw;
					canvas.height = th;
					const ctx = canvas.getContext('2d');
					if (!ctx) { reject(new Error('canvas 不可用')); return; }
					ctx.drawImage(img, 0, 0, tw, th);
					// 优先 WebP（体积约为 PNG 的 1/4，且支持透明），不支持时回退 PNG
					const webp = canvas.toDataURL('image/webp', 0.85);
					resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png'));
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			};
			img.onerror = () => reject(new Error('图片解码失败'));
			img.src = dataUrl;
		});
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
				// 点击技能 item（非按钮区域）→ 打开独立的技能详情 editorpane
				item.style.cursor = 'pointer';
				item.title = '点击查看技能详情';
				item.onclick = (e) => {
					if ((e.target as HTMLElement).closest('button')) { return; }
					void this._openSkillDetail(skillId);
				};
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
				// 点击技能 item（非按钮区域）→ 打开独立的技能详情 editorpane
				item.style.cursor = 'pointer';
				item.title = '点击查看技能详情';
				item.onclick = (e) => {
					if ((e.target as HTMLElement).closest('button')) { return; }
					void this._openSkillDetail(skill.id);
				};
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

	/**
	 * 在独立的技能详情 editorpane（ResourceManager）中打开指定技能。
	 * 复用 IntegrationView / SkillMarketEditorPane 的既有模式：
	 * 单例 input → openEditor → getControl() → showDetailOnly。
	 */
	private async _openSkillDetail(skillId: string): Promise<void> {
		const input = ResourceManagerEditorInput.getInstance();
		const pane = await this.editorService.openEditor(input, { pinned: true });
		const control = pane?.getControl();
		if (control instanceof ResourceManagerEditorPane) {
			await control.showDetailOnly('skill', skillId);
		}
	}

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

	// ── ConfigHtml Tab ──

	private _configHtmlLogEl: HTMLElement | undefined;
	private _configHtmlModeRadios: HTMLInputElement[] = [];

	/** ConfigHtml 页签内的操作日志（启动/停止/保存的全链路，排查「点了没反应」）。 */
	private _configHtmlLog(text: string, cls: 'info' | 'ok' | 'err' | 'dim' = 'info'): void {
		if (!this._configHtmlLogEl) { return; }
		const line = document.createElement('div');
		const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
		line.textContent = `[${ts}] ${text}`;
		line.style.color = cls === 'err'
			? 'var(--vscode-testing-iconFailed, #f48771)'
			: cls === 'ok'
				? 'var(--vscode-testing-iconPassed, #3fb950)'
				: cls === 'dim'
					? 'var(--vscode-descriptionForeground, #8b949e)'
					: 'var(--vscode-foreground, #e8e8e8)';
		this._configHtmlLogEl.appendChild(line);
		// 上限 200 行，超出淘汰最早的
		while (this._configHtmlLogEl.childElementCount > 200) {
			this._configHtmlLogEl.removeChild(this._configHtmlLogEl.firstElementChild!);
		}
		this._configHtmlLogEl.scrollTop = this._configHtmlLogEl.scrollHeight;
	}
	private _configHtmlUrlInput: HTMLInputElement | undefined;
	private _configHtmlPortInput: HTMLInputElement | undefined;
	private _configHtmlHtmlPathInput: HTMLInputElement | undefined;
	/** 可选的健康检查特征串（server.healthExpect）：探活时校验响应体，防端口被别的程序占用误判。 */
	private _configHtmlExpectInput: HTMLInputElement | undefined;
	private _configHtmlUrlSection: HTMLElement | undefined;
	private _configHtmlLocalSection: HTMLElement | undefined;

	/**
	 * 构建 ConfigHtml 配置页签：**本地 HTML** / **URL 面板** 两种预览模式（radio 切换）。
	 * 展示模式固定为独立页签（tab），不再提供选项。
	 */
	private _buildConfigHtmlTab(): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = 'confightml';

		const desc = $$('div.tab-pane-desc');
		desc.textContent = '配置 ConfigHtml 预览来源（两种模式互斥）。本地 HTML 渲染 agent 目录下的文件；URL 面板渲染本地面板服务（未启动时点「启动服务」自动拉起，如测试面板 127.0.0.1:5600）。预览固定在独立页签中打开。';
		section.appendChild(desc);

		const inputStyle = 'flex:1;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 8px;font-size:12px;';
		const mkRow = (labelText: string, parent: HTMLElement) => {
			const row = $$('div.agent-settings-row1');
			const label = $$('div.agent-settings-label') as HTMLElement;
			label.textContent = labelText;
			row.appendChild(label);
			parent.appendChild(row);
			return row;
		};

		// ── 预览模式（radio 切换）──
		const modeRow = mkRow('预览模式', section);
		const modeGroup = $$('div') as HTMLElement;
		modeGroup.style.cssText = 'display:flex;gap:16px;align-items:center;';
		this._configHtmlModeRadios = [];
		for (const [v, t] of [['local', '本地 HTML'], ['url', 'URL 面板']] as const) {
			const wrap = $$('label') as HTMLElement;
			wrap.style.cssText = 'display:flex;gap:4px;align-items:center;cursor:pointer;font-size:12px;';
			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'config-html-mode';
			radio.value = v;
			radio.onchange = () => { if (radio.checked) { this._configHtmlApplyMode(v as 'local' | 'url'); } };
			const span = $$('span') as HTMLElement;
			span.textContent = t;
			wrap.appendChild(radio);
			wrap.appendChild(span);
			modeGroup.appendChild(wrap);
			this._configHtmlModeRadios.push(radio);
		}
		modeRow.appendChild(modeGroup);

		// ── 本地 HTML 模式区块 ──
		this._configHtmlLocalSection = $$('div') as HTMLElement;
		const fileRow = mkRow('预览源文件', this._configHtmlLocalSection);
		this._configHtmlHtmlPathInput = document.createElement('input');
		this._configHtmlHtmlPathInput.type = 'text';
		this._configHtmlHtmlPathInput.placeholder = 'config.html（相对 agent 目录）';
		this._configHtmlHtmlPathInput.style.cssText = inputStyle;
		fileRow.appendChild(this._configHtmlHtmlPathInput);
		section.appendChild(this._configHtmlLocalSection);

		// ── URL 模式区块 ──
		this._configHtmlUrlSection = $$('div') as HTMLElement;
		const urlRow = mkRow('面板地址', this._configHtmlUrlSection);
		this._configHtmlUrlInput = document.createElement('input');
		this._configHtmlUrlInput.type = 'text';
		this._configHtmlUrlInput.placeholder = 'http://127.0.0.1:5600';
		this._configHtmlUrlInput.style.cssText = inputStyle;
		// 失焦时自动补全 scheme（127.0.0.1:5600 → http://127.0.0.1:5600）：
		// 缺 scheme 的输入会让 new URL() 把主机名当协议，探活 URL 拼接全部错乱。
		const urlInput = this._configHtmlUrlInput;
		urlInput.addEventListener('blur', () => {
			const fixed = normalizePanelUrl(urlInput.value);
			if (fixed && fixed !== urlInput.value) {
				urlInput.value = fixed;
				this._configHtmlLog(`面板地址已规范化：${fixed}`, 'dim');
			}
			this._configHtmlSyncUrlPort('url');
		});
		urlRow.appendChild(this._configHtmlUrlInput);
		const portRow = mkRow('服务端口', this._configHtmlUrlSection);
		this._configHtmlPortInput = document.createElement('input');
		this._configHtmlPortInput.type = 'number';
		this._configHtmlPortInput.placeholder = '5600';
		this._configHtmlPortInput.style.cssText = inputStyle;
		portRow.appendChild(this._configHtmlPortInput);
		// 端口框失焦 → 反向同步：改写地址里的端口段
		this._configHtmlPortInput.addEventListener('blur', () => { this._configHtmlSyncUrlPort('port'); });
		const expectRow = mkRow('健康特征串', this._configHtmlUrlSection);
		this._configHtmlExpectInput = document.createElement('input');
		this._configHtmlExpectInput.type = 'text';
		this._configHtmlExpectInput.placeholder = '可选：响应体需包含的子串';
		this._configHtmlExpectInput.title = '留空 = 只探活、不校验身份。若该端口可能被其他程序占用，填入面板页面里的固定文字（如标题），探活时会校验，避免把别人的服务误判为本面板。';
		this._configHtmlExpectInput.style.cssText = inputStyle;
		expectRow.appendChild(this._configHtmlExpectInput);
		const svcRow = $$('div.agent-settings-row1');
		const startBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		startBtn.textContent = '▶ 启动服务';
		startBtn.title = '探测面板服务，未启动则自动拉起';
		startBtn.onclick = () => { void this._configHtmlEnsureService(); };
		svcRow.appendChild(startBtn);
		const stopBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		stopBtn.textContent = '■ 停止服务';
		stopBtn.onclick = () => { void this._configHtmlStopService(); };
		svcRow.appendChild(stopBtn);
		const previewBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		previewBtn.textContent = '🌐 打开预览';
		previewBtn.onclick = () => { void this._openConfigHtmlPreview(); };
		svcRow.appendChild(previewBtn);
		this._configHtmlUrlSection.appendChild(svcRow);
		section.appendChild(this._configHtmlUrlSection);

		// ── 保存 ──
		const saveRow = $$('div.agent-settings-row1');
		saveRow.style.marginTop = '10px';
		const saveBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		saveBtn.textContent = '💾 保存配置';
		saveBtn.onclick = () => { void this._saveConfigHtmlTab(); };
		saveRow.appendChild(saveBtn);
		section.appendChild(saveRow);

		// ── 操作日志区（启动/停止/保存全链路，排查「点了没反应」）──
		const logBlock = $$('div.agent-settings-row1');
		logBlock.style.display = 'block';
		const logHead = document.createElement('div');
		logHead.style.cssText = 'display:flex;align-items:center;gap:10px;';
		const logLabel = $$('div.agent-settings-label') as HTMLElement;
		logLabel.textContent = '操作日志';
		logHead.appendChild(logLabel);
		const copyBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		copyBtn.textContent = '📋 复制日志';
		copyBtn.title = '复制全部操作日志到剪贴板';
		copyBtn.onclick = () => {
			const text = Array.from(this._configHtmlLogEl?.children ?? [])
				.map(c => c.textContent ?? '').join('\n');
			if (!text) { this._configHtmlLog('日志为空，无可复制内容', 'dim'); return; }
			const done = () => {
				copyBtn.textContent = '✓ 已复制';
				this._configHtmlLog('日志已复制到剪贴板', 'ok');
				setTimeout(() => { copyBtn.textContent = '📋 复制日志'; }, 1500);
			};
			// ★ 不用 navigator.clipboard：vscode-file origin 下 writeText 权限被拒
			//   （"Write permission denied"）。走 workbench IClipboardService（主进程实现）。
			this.clipboardService.writeText(text).then(done).catch((err) => {
				this._configHtmlLog(`复制失败：${err instanceof Error ? err.message : String(err)}`, 'err');
			});
		};
		logHead.appendChild(copyBtn);
		logBlock.appendChild(logHead);
		this._configHtmlLogEl = $$('div.agent-settings-confightml-log') as HTMLElement;
		this._configHtmlLogEl.style.cssText = 'margin-top:6px;max-height:140px;overflow:auto;background:var(--vscode-terminal-background, #111);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px 8px;font-family:ui-monospace, Menlo, Consolas, monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;';
		logBlock.appendChild(this._configHtmlLogEl);
		section.appendChild(logBlock);
		this._configHtmlLog('ConfigHtml 页签已构建。点「▶ 启动服务」开始；本日志记录探活/拉起/保存全链路。', 'dim');

		this._tabContentContainer!.appendChild(section);
		this._fillConfigHtmlTab();
	}

	/** 当前预览模式（radio 状态）。 */
	private _configHtmlCurrentMode(): 'local' | 'url' {
		return this._configHtmlModeRadios.find(r => r.checked)?.value as 'local' | 'url' ?? 'local';
	}

	/** 按模式显示/隐藏参数区块。 */
	private _configHtmlApplyMode(mode: 'local' | 'url'): void {
		if (this._configHtmlLocalSection) { this._configHtmlLocalSection.style.display = mode === 'local' ? '' : 'none'; }
		if (this._configHtmlUrlSection) { this._configHtmlUrlSection.style.display = mode === 'url' ? '' : 'none'; }
	}

	/**
	 * 「面板地址」与「服务端口」**双向联动**：
	 * - 地址失焦：url 带显式端口（`:5600`）→ 同步到端口框；url 无端口（隐含 80/443）→ 把端口框的值补进 url。
	 *   不联动的话，`http://127.0.0.1`（隐含 80）+ 端口 5600 会让探活打 80、服务却在 5600，永远探不通。
	 * - 端口失焦：改写 url 的端口段，保证两者始终一致（探活/预览看 url，停止服务按端口查杀）。
	 */
	private _configHtmlSyncUrlPort(source: 'url' | 'port'): void {
		const urlInput = this._configHtmlUrlInput;
		const portInput = this._configHtmlPortInput;
		if (!urlInput || !portInput) { return; }
		const url = normalizePanelUrl(urlInput.value);
		if (!url) { return; }
		try {
			const u = new URL(url);
			const portNum = Number(portInput.value);
			if (source === 'url' && u.port) {
				portInput.value = u.port;   // 地址里写的端口优先
				return;
			}
			if (Number.isFinite(portNum) && portNum > 0 && portNum !== 80 && portNum !== 443) {
				u.port = String(portNum);
				const next = u.toString();
				if (next !== urlInput.value) {
					urlInput.value = next;
					portInput.value = String(portNum);
					this._configHtmlLog(`地址与端口已联动：${next}`, 'dim');
				}
			}
		} catch { /* 非法地址留给 validatePanelUrl 报错 */ }
	}

	/** URL 模式下当前表单对应的服务拉起参数（未填地址返回 undefined）。 */
	private _configHtmlEnsureSpec(): Record<string, unknown> | undefined {
		const url = (this._configHtmlUrlInput?.value ?? '').trim();
		if (!url) { return undefined; }
		const wsRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		const expect = (this._configHtmlExpectInput?.value ?? '').trim() || undefined;
		// ★ 与 webview 共享同一份 spec 构造逻辑（common/configHtmlConfig.ts）
		return buildEnsureSpec(url, Number(this._configHtmlPortInput?.value ?? ''), wsRoot, expect);
	}

	private async _configHtmlEnsureService(): Promise<void> {
		const url = (this._configHtmlUrlInput?.value ?? '').trim();
		this._configHtmlLog(`▶ 启动服务：${url || '(地址为空)'}`);
		if (!url) {
			this._configHtmlLog('✗ 地址为空，无法启动', 'err');
			this.notificationService.error('请先填写面板地址');
			return;
		}
		const wsRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		this._configHtmlLog(`workspaceRoot = ${wsRoot || '(无工作区文件夹)'}`, 'dim');
		const spec = this._configHtmlEnsureSpec();
		this._configHtmlLog(`spec = ${JSON.stringify(spec)}`, 'dim');
		if (!spec) { this._configHtmlLog('✗ spec 构造失败', 'err'); return; }
		const bridge = nativeIpcBridge();
		if (!bridge?.ipcRenderer?.invoke) {
			this._configHtmlLog('✗ vscode.ipcRenderer 不可用（非 Electron 或 preload 未注入）——这正是「点了没反应」的常见原因', 'err');
			this.notificationService.error('无法调用主进程：IPC 桥不可用（详见页签内操作日志）');
			return;
		}
		this._configHtmlLog('→ 主进程 vscode:configHtmlEnsureServer：探活 → 未运行则 spawn → 轮询就绪（默认 30s）…', 'dim');
		this.notificationService.info(`正在启动面板服务 ${url} …`);
		try {
			const r = await bridge.ipcRenderer.invoke('vscode:configHtmlEnsureServer', spec) as { ok: boolean; alreadyRunning?: boolean; starting?: boolean; error?: string; pid?: number; elapsedMs?: number };
			if (r.ok) {
				const detail = r.alreadyRunning ? '服务已在运行' : `新启动 pid=${r.pid ?? '-'}，耗时 ${r.elapsedMs ?? '?'}ms`;
				this._configHtmlLog(`✓ ${detail}`, 'ok');
				this.notificationService.info(r.alreadyRunning ? `面板服务已在运行（${url}）` : `面板服务已就绪（${url}）`);
			} else if (r.starting) {
				this._configHtmlLog(`⏳ 仍在启动中（pid=${r.pid ?? '-'}）：${r.error ?? ''}`, 'info');
				this.notificationService.warn(`面板服务仍在启动中，请稍后重试`);
			} else {
				this._configHtmlLog(`✗ 启动失败：${r.error ?? '未知错误'}`, 'err');
				this.notificationService.error(`面板服务启动失败（详见操作日志）`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._configHtmlLog(`✗ 调用主进程异常：${msg}`, 'err');
			this.notificationService.error(`拉起面板服务失败（详见操作日志）`);
		}
	}

	private async _configHtmlStopService(): Promise<void> {
		const url = (this._configHtmlUrlInput?.value ?? '').trim();
		const port = Number(this._configHtmlPortInput?.value ?? '') || undefined;
		this._configHtmlLog(`■ 停止服务：${url || '(地址为空)'} port=${port ?? '-'}`);
		if (!url) { this._configHtmlLog('✗ 地址为空', 'err'); return; }
		const bridge = nativeIpcBridge();
		if (!bridge?.ipcRenderer?.invoke) { this._configHtmlLog('✗ vscode.ipcRenderer 不可用', 'err'); return; }
		this._configHtmlLog('→ 主进程 vscode:configHtmlStopServer：按端口查杀 …', 'dim');
		try {
			const r = await bridge.ipcRenderer.invoke('vscode:configHtmlStopServer', { url, port }) as { ok: boolean; killed: number[] };
			this._configHtmlLog(r.killed.length
				? `✓ 已结束 ${r.killed.length} 个进程：${r.killed.join(', ')}`
				: '没有进程在监听该端口（服务未运行）', r.killed.length ? 'ok' : 'dim');
		} catch (err) {
			this._configHtmlLog(`✗ 停止异常：${err instanceof Error ? err.message : String(err)}`, 'err');
		}
	}

	/** 把当前 agent 的 configHtml 配置填入表单（进入页签/加载后调用）。 */
	private _fillConfigHtmlTab(): void {
		const cfg = this._agent?.configHtml;
		const mode = previewModeOf(cfg as ConfigHtmlCfg | undefined);
		for (const r of this._configHtmlModeRadios) { r.checked = r.value === mode; }
		this._configHtmlApplyMode(mode);
		if (this._configHtmlUrlInput) { this._configHtmlUrlInput.value = cfg?.url ?? ''; }
		if (this._configHtmlPortInput) { this._configHtmlPortInput.value = String(defaultPortOf(cfg as ConfigHtmlCfg | undefined, cfg?.url ?? '')); }
		if (this._configHtmlHtmlPathInput) { this._configHtmlHtmlPathInput.value = cfg?.htmlPath ?? 'config.html'; }
		if (this._configHtmlExpectInput) { this._configHtmlExpectInput.value = cfg?.server?.healthExpect ?? ''; }
	}

	private async _saveConfigHtmlTab(): Promise<void> {
		if (!this._agentId || !this._agent) { return; }
		const mode = this._configHtmlCurrentMode();
		this._configHtmlLog(`💾 保存配置（模式=${mode}）`, 'dim');
		// ★ 校验与规范化都走共享模块（common/configHtmlConfig.ts），与 webview 侧一致
		const prev = this._agent.configHtml as ConfigHtmlCfg | undefined;
		let cfg: ConfigHtmlCfg;
		if (mode === 'url') {
			const url = (this._configHtmlUrlInput?.value ?? '').trim();
			const err = validatePanelUrl(url);
			if (err) { this._configHtmlLog(`✗ ${err}`, 'err'); this.notificationService.error(err); return; }
			cfg = normalizeConfigHtml('url', { url, port: Number(this._configHtmlPortInput?.value ?? ''), prev });
			const expect = (this._configHtmlExpectInput?.value ?? '').trim();
			if (expect) {
				cfg.server = { ...(cfg.server ?? {}), healthExpect: expect };
			} else if (cfg.server) {
				delete cfg.server.healthExpect;
			}
		} else {
			cfg = normalizeConfigHtml('local', { htmlPath: this._configHtmlHtmlPathInput?.value ?? '' });
		}
		this._configHtmlLog(`规范化结果 = ${JSON.stringify(cfg)}`, 'dim');
		try {
			await this.agentStudioService.updateAgent(this._agentId, { configHtml: cfg } as Partial<Agent>);
			this._agent.configHtml = cfg;
			this._configHtmlLog('✓ 已保存到 agent 元数据（.agent.md frontmatter 的 configHtml 字段）', 'ok');
			this.notificationService.info('ConfigHtml 配置已保存');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._configHtmlLog(`✗ 保存失败：${msg}`, 'err');
			this.notificationService.error(`保存失败: ${msg}`);
		}
	}

	/**
	 * 打开 ConfigHtml 预览。
	 *
	 * ★ 两种模式：
	 *   1. **文件模式**（默认/向后兼容）：渲染 `{agentDir}/config.html`
	 *      —— 走 `HtmlFileEditorPane`，HTML 内可用 `AgentConfigHtml.*` SDK。
	 *   2. **URL 模式**（`configHtml.url` 有值）：预览一个本地 HTTP 面板
	 *      —— 走 `UrlPreviewEditorPane`（其 CSP `frame-src *` 允许本地 http；
	 *      ConfigHtml 面板的 `default-src 'none'` 做不到）。
	 *      服务未启动时**自动拉起**（主进程 `vscode:configHtmlEnsureServer`），
	 *      全过程有通知提示；退出应用时由主进程按端口清理。
	 */
	private async _openConfigHtmlPreview(): Promise<void> {
		if (this._readOnly) { return; }
		if (!this._agentId) { return; }
		try {
			// ★ 预览优先使用**表单实时值**（与「启动服务」按钮一致）：
			//   之前读的是已保存配置——用户填了 url 未保存 → cfg.url 为空 → 误走文件模式打开 config.html。
			const formMode = this._configHtmlCurrentMode();
			const formUrl = normalizePanelUrl(this._configHtmlUrlInput?.value ?? '');
			const savedCfg = this._agent?.configHtml;
			const useFormUrl = formMode === 'url' && !!formUrl;
			const url = useFormUrl ? formUrl : savedCfg?.url?.trim();

			// ── 模式 1：文件模式（原行为）─────────────────────────────────
			if (!url) {
				const agentDir = await this.agentStudioService.getAgentDir(this._agentId);
				const configUri = URI.joinPath(agentDir, savedCfg?.htmlPath || 'config.html');
				this.editorService.openEditor({ resource: configUri, options: { pinned: true } }, this.group);
				return;
			}

			// ── 模式 2：URL 模式（探活 → 拉起 → 预览；逻辑在共享 opener，与聊天框一致）──
			const wsRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
			await ensureConfigHtmlServerAndOpenPreview({
				url,
				server: savedCfg?.server,
				formPort: useFormUrl ? Number(this._configHtmlPortInput?.value ?? '') : undefined,
				wsRoot,
				notificationService: this.notificationService,
				logService: this.logService,
				dialogService: this.dialogService,
				open: (input, options) => this.editorService.openEditor(input as EditorInput, options, this.group),
			});
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
		this._closeAvatarEditor();
		super.dispose();
	}
}
