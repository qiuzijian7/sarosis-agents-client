/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./media/agentChat.css";
import { Disposable, IDisposable } from "../../../base/common/lifecycle.js";
import {
	$,
	append,
	clearNode,
	addDisposableListener,
	EventType,
} from "../../../base/browser/dom.js";
import { mainWindow } from "../../../base/browser/window.js";
import { renderMarkdown, type MarkdownRenderOptions } from "../../../base/browser/markdownRenderer.js";
import type { IMarkdownString } from "../../../base/common/htmlContent.js";
import {
	IAgentChatMessage,
	IToolCall,
	IChatAttachment,
	ISubAgentData,
	ISubAgentBlock,
	IConfirmationData,
	IAgentInfo,
	IProviderInfo,
	IModelInfo,
	STATUS_MAP,
	HeaderPanelType,
	AgentStatus,
	ChatMode,
	StreamPhase,
	IModeOption,
	IWorktreeItem,
	ISessionInfo,
	IAgentSessionMeta,
	IContextUsage,
	ICheckpointInfo,
	ISuggestedQuestion,
	IReferenceItem,
	ILiveWorkflowAskUser,
	ILiveWorkflowExecution,
	ILiveWorkflowEvent,
	ILiveCollectVariable,
	ITodoItem,
	ITipMessage,
	IProgressMessage,
	// Orchestration Plan Types
	OrchestrationPlan,
	PlanTask,
} from "./agentChatTypes.js";

// Mode options metadata — mirrors webview ChatComposer.tsx modeOptions
const MODE_OPTIONS: IModeOption[] = [
	{
		id: 'craft',
		label: 'Craft',
		description: '打造模式 · 完整工具链',
		icon: 'M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.121 2.121 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z',
	},
	{
		id: 'ask',
		label: 'Ask',
		description: '问答模式 · 只读',
		icon: 'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
	},
	{
		id: 'plan',
		label: 'Plan',
		description: '规划模式 · 多步编排',
		icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
	},
];

// AgentChatPanel -- Full chat panel matching saros-webui layout
//
// Structure:
//   .chat-container
//     .chat-header           <- avatar + name/status + toolbar buttons
//     .chat-messages-wrapper <- scrollable messages + scroll-to-bottom btn
//       .chat-messages
//         .chat-message .user / .assistant
//           .chat-message-avatar (assistant only)
//           .chat-bubble .user / .assistant
//             .thinking-card
//             .step-indicator
//             .tool-calls-section > .tool-call-card
//             .message-content
//             .streaming-cursor
//             .chat-bubble-footer
//     .chat-input-area
//       .chat-composer-box
//         textarea.chat-composer-textarea
//         .chat-composer-toolbar
//           .chat-toolbar-left (attach, voice, web-search, divider, provider, model)
//           .chat-send-circle

export class AgentChatPanel extends Disposable {
	// -- DOM refs --
	private readonly _container: HTMLElement;
	private _messagesContainer!: HTMLElement;
	private _messagesWrapper!: HTMLElement;
	private _textarea!: HTMLTextAreaElement;
	private _scrollToBottomBtn!: HTMLElement;
	private _sendBtn!: HTMLElement;
	private _checkpointBarContainer: HTMLElement | null = null;

	// -- State --
	private _messages: IAgentChatMessage[] = [];
	private _agent: IAgentInfo | null = null;
	private _isSending = false;
	private _showScrollBtn = false;
	private _autoOrchestrateEnabled = false;
	private _streamPhase: StreamPhase = 'idle';
	private _currentProvider = "";
	private _currentModel = "";
	private _providers: IProviderInfo[] = [];
	private _models: IModelInfo[] = [];
	private _activeHeaderPanel: HeaderPanelType = null;
	private _abortController: AbortController | null = null;

	// Worktree / session / context / checkpoint state
	private _worktrees: IWorktreeItem[] = [];
	private _selectedWorktreePath = "";
	private _chatMode: ChatMode = 'craft';
	private _sessionInfo: ISessionInfo | null = null;
	private _agentSessions: IAgentSessionMeta[] = [];
	private _contextUsage: IContextUsage | null = null;
	// 流式状态：用于计算 context usage（匹配 React 3 层逻辑）
	private _streamUsage: { input?: number; output?: number; seen?: boolean } | null = null;
	private _streamTextBuffer: string = '';
	private _streamThinkingBuffer: string = '';
	private _compactedBaseline: number = 0;
	private _checkpoint: ICheckpointInfo | null = null;
	private _checkpointFilesExpanded = false;
	private _attachments: IChatAttachment[] = [];
	private _fileInput: HTMLInputElement | null = null;
	// -- Agent dropdown state --
	private _availableAgents: IAgentInfo[] = [];
	private _dropdownOpen = false;
	private _dropdownFilter = "";
	private _agentDropdownEl: HTMLElement | null = null;
	private _agentSearchInput: HTMLInputElement | null = null;
	private _agentDropdownList: HTMLElement | null = null;
	private _agentSelectorTrigger: HTMLElement | null = null;

	// -- Other floating dropdown refs --
	private _worktreeDropdownEl: HTMLElement | null = null;
	private _worktreeTrigger: HTMLElement | null = null;
	private _msgNavDropdownEl: HTMLElement | null = null;
	private _msgNavTrigger: HTMLElement | null = null;
	private _modeDropdownEl: HTMLElement | null = null;
	private _modeTrigger: HTMLElement | null = null;
	private _providerDropdownEl: HTMLElement | null = null;
	private _providerTrigger: HTMLElement | null = null;
	private _modelDropdownEl: HTMLElement | null = null;
	private _modelTrigger: HTMLElement | null = null;
	private _historyOverlayEl: HTMLElement | null = null;

	// -- Tabs state --
	private _tabsContainer: HTMLElement | undefined;

	// -- Composer --
	private _resizeMaxH = 120; // dynamic max height from drag resize
	private _userHasAdjustedHeight = false; // whether user has manually adjusted the composer height

	// -- Slash menu state --
	private _slashMenuEl: HTMLElement | null = null;
	private _slashMenuIndex = 0;

	// -- Skill chips state --
	private _skillChipsBar: HTMLElement | null = null;
	private _skillChips: Array<{ id: string; name: string }> = [];

	// -- Orchestration plan state --
	private _orchestrationPlanEl: HTMLElement | null = null;
	private _isPlanDialogOpen: boolean = false;
	private _activePlan: OrchestrationPlan | null = null;

	// -- Markdown render disposables --
	private _markdownDisposables = new Map<HTMLElement, IDisposable>();

	// -- Context baseline --

	// -- Callbacks --
	private readonly _onSendMessage: (text: string, explicitSkillIds?: string[]) => void;
	private readonly _onCancelExecution: () => void;
	private readonly _onSelectAgent: (id: string) => void;
	private readonly _onSelectWorktree?: (worktree: { path: string; branch: string }) => void;
	private readonly _onScrollToMessage?: (messageId: string) => void;
	private readonly _onNewSession?: () => void;
	private readonly _onOpenSession?: (sessionId: string) => void;
	private readonly _onRenameSession?: (sessionId: string, newName: string) => void;
	private readonly _onDeleteSession?: (sessionId: string) => void;
	private readonly _onOpenSettings?: () => void;
	private readonly _onChangeMode?: (mode: ChatMode) => void;
	private readonly _onSelectProvider?: (providerId: string) => void;
	private readonly _onSelectModel?: (modelId: string) => void;
	private readonly _onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string }) => void;
	private readonly _onConfirmationAction?: (confirmationId: string, buttonId: string) => void;
	private readonly _onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string }>;
	// New callbacks for missing features
	private readonly _onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => void;
	private readonly _onQuestionClick?: (question: ISuggestedQuestion) => void;
	private readonly _onReferenceClick?: (ref: IReferenceItem) => void;
	private readonly _onTipAction?: (tipId: string, actionId: string) => void;
	private readonly _onTipDismiss?: (tipId: string) => void;
	private readonly _onApplyCode?: (code: string, language: string, filePath?: string) => void;
	private readonly _onOpenFile?: (filePath: string) => void;
	// Orchestration plan callbacks
	private readonly _onApprovePlan?: (planId: string) => void;
	private readonly _onRejectPlan?: (planId: string) => void;
	private readonly _onApproveWithoutExecute?: (planId: string) => void;
	private readonly _onTaskAction?: (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => void;
	private readonly _onUpdatePlan?: (planId: string, updates: Record<string, unknown>) => void;
	private readonly _onUpdateTask?: (planId: string, taskId: string, updates: Record<string, unknown>) => void;
	private readonly _onDecomposeTask?: (planId: string, taskId: string) => void;
	private readonly _onClosePlanDialog?: (planId: string) => void;

	constructor(opts: {
		onSendMessage: (text: string) => void;
		onCancelExecution: () => void;
		onToggleCollapse: () => void;
		onSelectAgent: (id: string) => void;
		onSelectWorktree?: (worktree: { path: string; branch: string }) => void;
		onScrollToMessage?: (messageId: string) => void;
		onNewSession?: () => void;
		onOpenSession?: (sessionId: string) => void;
		onRenameSession?: (sessionId: string, newName: string) => void;
		onDeleteSession?: (sessionId: string) => void;
		onOpenSettings?: () => void;
		onChangeMode?: (mode: ChatMode) => void;
		onSelectProvider?: (providerId: string) => void;
		onSelectModel?: (modelId: string) => void;
		onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string }) => void;
		onConfirmationAction?: (confirmationId: string, buttonId: string) => void;
		onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string }>;
		// New callbacks for missing features
		onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => void;
		onQuestionClick?: (question: ISuggestedQuestion) => void;
		onReferenceClick?: (ref: IReferenceItem) => void;
		onTipAction?: (tipId: string, actionId: string) => void;
		onTipDismiss?: (tipId: string) => void;
		onApplyCode?: (code: string, language: string, filePath?: string) => void;
		onOpenFile?: (filePath: string) => void;
		onDecomposeTask?: (planId: string, taskId: string) => void;
		// Orchestration plan callbacks
		onApprovePlan?: (planId: string) => void;
		onRejectPlan?: (planId: string) => void;
		onApproveWithoutExecute?: (planId: string) => void;
		onTaskAction?: (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => void;
		onUpdatePlan?: (planId: string, updates: Record<string, unknown>) => void;
		onUpdateTask?: (planId: string, taskId: string, updates: Record<string, unknown>) => void;
		onClosePlanDialog?: (planId: string) => void;
	}) {
		super();
		this._onSendMessage = opts.onSendMessage;
		this._onCancelExecution = opts.onCancelExecution;
		this._onSelectAgent = opts.onSelectAgent;
		this._onSelectWorktree = opts.onSelectWorktree;
		this._onScrollToMessage = opts.onScrollToMessage;
		this._onNewSession = opts.onNewSession;
		this._onOpenSession = opts.onOpenSession;
		this._onRenameSession = opts.onRenameSession;
		this._onDeleteSession = opts.onDeleteSession;
		this._onOpenSettings = opts.onOpenSettings;
		this._onChangeMode = opts.onChangeMode;
		this._onSelectProvider = opts.onSelectProvider;
		this._onSelectModel = opts.onSelectModel;
		this._onCheckpointAction = opts.onCheckpointAction;
		this._onConfirmationAction = opts.onConfirmationAction;
		this._onListSkills = opts.onListSkills;
		// New callbacks
		this._onAskUserSubmit = opts.onAskUserSubmit;
		this._onQuestionClick = opts.onQuestionClick;
		this._onReferenceClick = opts.onReferenceClick;
		this._onTipAction = opts.onTipAction;
		this._onTipDismiss = opts.onTipDismiss;
		this._onApplyCode = opts.onApplyCode;
		this._onOpenFile = opts.onOpenFile;
		// Orchestration plan callbacks
		this._onApprovePlan = opts.onApprovePlan;
		this._onRejectPlan = opts.onRejectPlan;
		this._onApproveWithoutExecute = opts.onApproveWithoutExecute;
		this._onTaskAction = opts.onTaskAction;
		this._onUpdatePlan = opts.onUpdatePlan;
		this._onUpdateTask = opts.onUpdateTask;
		this._onDecomposeTask = opts.onDecomposeTask;
		this._onClosePlanDialog = opts.onClosePlanDialog;
		this._container = $(".chat-container");

		// Initial render so the container has visible structure (tabs + empty state)
		// even before setAgent() / setAvailableAgents() are called.
		this._render();
	}

	get element(): HTMLElement {
		return this._container;
	}

	// Public API

	setAgent(agent: IAgentInfo | null): void {
		// eslint-disable-next-line no-console
		console.info('[AgentChatPanel] setAgent:', agent ? `id="${agent.id}", name="${agent.name}"` : 'null');
		this._agent = agent;
		this._render();
	}

	setAvailableAgents(agents: IAgentInfo[]): void {
		this._availableAgents = agents;
		// Re-render tabs to reflect the new list of available agents
		this._renderTabs();
	}

	setMessages(messages: IAgentChatMessage[]): void {
		this._messages = this._aggregateTurns(messages);
		this._renderMessages();
		this._scrollToBottom(false);
		// 消息变化影响 inputBaselineTokens，需要重新计算 context ring
		this._updateContextRing();
	}

	addMessage(message: IAgentChatMessage): void {
		this._messages.push(message);
		this._appendMessageDom(message);
		this._scrollToBottom(true);
	}

	updateMessage(
		messageId: string,
		updates: Partial<IAgentChatMessage>,
	): void {
		const idx = this._messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			Object.assign(this._messages[idx], updates);
			this._updateMessageDom(idx, this._messages[idx]);
			// 消息更新可能影响 inputBaselineTokens（如 tokenUsage 变化），需要重新计算 context ring
			this._updateContextRing();
		}
	}

	setSending(sending: boolean): void {
		this._isSending = sending;
		this._updateSendButton();
		if (!sending) { this._streamPhase = 'idle'; }
	}

	setStreamPhase(phase: StreamPhase): void {
		this._streamPhase = phase;
		// streamPhase 变化影响 context usage 计算（空闲/流式/真值 三层逻辑）
		this._updateContextRing();
	}

	setProviders(providers: IProviderInfo[]): void {
		this._providers = providers.slice();
	}

	setModels(models: IModelInfo[]): void {
		this._models = models.slice();
	}

	setCurrentProvider(provider: string): void {
		this._currentProvider = provider;
		// Re-render input area so the chip label refreshes immediately
		if (this._agent) { this._render(); }
	}

	setCurrentModel(model: string): void {
		this._currentModel = model;
		if (this._agent) { this._render(); }
	}

	setWorktrees(items: ReadonlyArray<IWorktreeItem>): void {
		this._worktrees = items.slice();
		if (this._agent) { this._render(); }
	}

	setSelectedWorktree(path: string): void {
		this._selectedWorktreePath = path || "";
		if (this._agent) { this._render(); }
	}

	setChatMode(mode: ChatMode): void {
		this._chatMode = mode;
		if (this._agent) { this._render(); }
	}

	setSessionInfo(info: ISessionInfo | null): void {
		this._sessionInfo = info;
		if (this._agent) { this._render(); }
	}

	setAgentSessions(sessions: ReadonlyArray<IAgentSessionMeta>): void {
		this._agentSessions = sessions.slice();
		if (this._historyOverlayEl) {
			this._renderHistoryOverlayContent();
		}
	}

	/** @deprecated 使用 setStreamUsage 替代 */
	setContextUsage(usage: IContextUsage | null): void {
		// 为了向后兼容，从 IContextUsage 提取 input/output 并设置 streamUsage
		if (usage) {
			this._streamUsage = { input: usage.used, output: 0, seen: true };
		} else {
			this._streamUsage = null;
		}
		this._updateContextRing();
	}

	setCompactedBaseline(baseline: number): void {
		this._compactedBaseline = baseline;
		this._updateContextRing();
	}

	/** 设置流式用量（来自 usage chunk） */
	setStreamUsage(usage: { input?: number; output?: number; seen?: boolean } | null): void {
		this._streamUsage = usage;
		this._updateContextRing();
	}

	/** 设置流式文本缓冲区（用于实时估算） */
	setStreamTextBuffer(buffer: string): void {
		this._streamTextBuffer = buffer;
		this._updateContextRing();
	}

	/** 设置流式思考缓冲区（用于实时估算） */
	setStreamThinkingBuffer(buffer: string): void {
		this._streamThinkingBuffer = buffer;
		this._updateContextRing();
	}

	setCheckpoint(info: ICheckpointInfo | null): void {
		this._checkpoint = info;
		this._renderCheckpointBar();
	}

	focusInput(): void {
		this._textarea?.focus();
	}

	// Rendering — Full render

	private _render(): void {
		// Close all floating dropdowns before re-render
		this._closeAllDropdowns();
		clearNode(this._container);

		// NOTE: 原侧栏样式（webview 版）没有 tabs。
		// 此处不再渲染 tabs，使外观与原 chat sidebar 保持一致。
		// 如需开启 multi-agent tabs，可调用 _renderTabsContainer()。
		this._tabsContainer = undefined;

		if (!this._agent) {
			// eslint-disable-next-line no-console
			console.warn('[AgentChatPanel] _render: rendering empty state — _agent is null/undefined');
			this._renderEmptyState();
			return;
		}

		// Chat header
		this._renderHeader();

		// Session info bar (mode badge + hierarchy + tasks)
		if (this._sessionInfo) {
			this._renderSessionInfo();
		}

		// Messages wrapper
		this._renderMessagesArea();

		// Checkpoint bar container (always present so updates can re-render in place)
		this._renderCheckpointBarContainer();

		// Input area
		this._renderInputArea();

		// History overlay (rendered last so it stacks on top)
		if (this._activeHeaderPanel === 'history') {
			this._renderHistoryOverlay();
		}
	}

	private _closeAllDropdowns(): void {
		this._closeAgentDropdown();
		this._closeWorktreeDropdown();
		this._closeMsgNavDropdown();
		this._closeModeDropdown();
		this._closeProviderDropdown();
		this._closeModelDropdown();
		this._closeSlashMenu();
	}

	// Tabs Container (editor-style tabs)
	// NOTE: 当前不使用 tabs（与原侧栏样式保持一致）。保留方法以便未来可恢复 multi-agent tabs 功能。
	// @ts-expect-error - reserved for future use
	private _renderTabsContainer(): void {
		// Create tabs container
		const tabsContainer = append(this._container, $('.chat-tabs-container'));

		// Create tabs list (role="tablist")
		this._tabsContainer = append(tabsContainer, $('.chat-tabs', { role: 'tablist' }));

		// Render tabs
		this._renderTabs();
	}

	private _renderTabs(): void {
		if (!this._tabsContainer) {
			return;
		}

		clearNode(this._tabsContainer);

		// Create a tab for each available agent
		for (const agent of this._availableAgents) {
			const tab = append(this._tabsContainer, $('.chat-tab', { role: 'tab' }));

			// Mark active tab
			if (this._agent && agent.id === this._agent.id) {
				tab.classList.add('active');
				tab.setAttribute('aria-selected', 'true');
			} else {
				tab.setAttribute('aria-selected', 'false');
			}

			// Agent avatar/icon
			const avatar = append(tab, $('.chat-tab-avatar'));
			if (agent.avatarUrl) {
				const img = append(avatar, $('img')) as HTMLImageElement;
				img.src = agent.avatarUrl;
				img.alt = agent.name;
				img.style.width = '16px';
				img.style.height = '16px';
				img.style.borderRadius = '2px';
			} else if (agent.icon) {
				// Use icon emoji as fallback when avatarUrl is not available
				const fallback = append(avatar, $('.chat-tab-avatar-fallback'));
				fallback.textContent = agent.icon;
			} else {
				const fallback = append(avatar, $('.chat-tab-avatar-fallback'));
				fallback.textContent = agent.name.charAt(0).toUpperCase();
			}

			// Agent name
			const label = append(tab, $('.chat-tab-label'));
			label.textContent = agent.name;

			// Click handler to switch agent
			this._register(
				addDisposableListener(tab, EventType.CLICK, () => {
					this._onSelectAgent(agent.id);
				})
			);
		}
	}

	// Empty state

	private _renderEmptyState(): void {
		// 还原原 webview AgentChat.tsx 的空状态结构：
		// <div class="chat-empty">
		//   <div class="chat-empty-inner">
		//     <div class="chat-empty-icon">💬</div>
		//     <h2 class="chat-empty-title">Agent Studio</h2>
		//     <p class="chat-empty-desc">选择一个 Agent 开始对话</p>
		//   </div>
		// </div>
		const empty = append(this._container, $(".chat-empty"));
		const inner = append(empty, $(".chat-empty-inner"));
		append(inner, $(".chat-empty-icon", undefined, "💬"));
		append(inner, $("h2.chat-empty-title", undefined, "Agent Studio"));
		append(inner, $("p.chat-empty-desc", undefined, "选择一个 Agent 开始对话"));
	}

	// Chat Header

	private _renderHeader(): void {
		const emp = this._agent!;
		const status = emp.status as keyof typeof STATUS_MAP;
		const statusInfo = STATUS_MAP[status] || STATUS_MAP[AgentStatus.Idle];

		const header = append(this._container, $(".chat-header"));

		// Left: worktree pill + agent selector dropdown trigger
		const left = append(header, $(".chat-header-left"));

		// Worktree pill (only if data exists)
		if (this._worktrees.length > 0 || this._selectedWorktreePath) {
			this._renderHeaderWorktree(left);
		}

		// Agent selector trigger (clickable, replaces static avatar+name)
		this._agentSelectorTrigger = append(left, $(".chat-header-agent-selector"));

		// Avatar with status dot
		const avatarWrap = append(this._agentSelectorTrigger, $(".chat-header-avatar-wrap"));
		const avatarBorder = append(avatarWrap, $(".chat-header-avatar-border"));
		if (emp.avatarUrl) {
			const img = append(
				avatarBorder,
				$("img.chat-header-avatar-img"),
			) as HTMLImageElement;
			img.src = emp.avatarUrl;
			img.alt = emp.name;
		} else if (emp.icon) {
			// Use icon emoji as fallback when avatarUrl is not available
			const fallback = append(avatarBorder, $(".chat-header-avatar-fallback"));
			fallback.textContent = emp.icon;
		} else {
			const fallback = append(avatarBorder, $(".chat-header-avatar-fallback"));
			fallback.textContent = emp.name.charAt(0).toUpperCase();
		}
		const statusDot = append(avatarWrap, $(".chat-header-status-dot"));
		statusDot.style.backgroundColor = statusInfo.dot;
		if (statusInfo.animated) {
			statusDot.classList.add("animated");
		}

		// Name + role
		const info = append(this._agentSelectorTrigger, $(".chat-header-info"));
		append(info, $("span.chat-header-name", undefined, emp.name));
		const roleText = emp.role?.split(/[，,]/)[0] || "";
		append(
			info,
			$(
				"span.chat-header-role",
				undefined,
				`${roleText} · ${statusInfo.label}`,
			),
		);

		// Chevron icon for dropdown
		const chevronWrap = append(this._agentSelectorTrigger, $(".chat-header-dropdown-chevron"));
		const chevronSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		chevronSvg.setAttribute("width", "12");
		chevronSvg.setAttribute("height", "12");
		chevronSvg.setAttribute("viewBox", "0 0 24 24");
		chevronSvg.setAttribute("fill", "none");
		chevronSvg.setAttribute("stroke", "currentColor");
		chevronSvg.setAttribute("stroke-width", "2.5");
		chevronSvg.setAttribute("stroke-linecap", "round");
		chevronSvg.setAttribute("stroke-linejoin", "round");
		const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
		chevronPath.setAttribute("d", "M6 9l6 6 6-6");
		chevronSvg.appendChild(chevronPath);
		chevronWrap.appendChild(chevronSvg);

		// Click handler for dropdown toggle
		this._register(
			addDisposableListener(this._agentSelectorTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._dropdownOpen) {
					this._closeAgentDropdown();
				} else {
					this._openAgentDropdown();
				}
			}),
		);

		// Auto-orchestrate toggle (PM only)
		if (emp.isPM) {
			const orchBtn = append(left, $(".chat-header-action-btn.orchestrate"));
			orchBtn.title = this._autoOrchestrateEnabled
				? "自动编排模式已开启"
				: "自动编排模式已关闭";
			if (this._autoOrchestrateEnabled) {
				orchBtn.classList.add("active", "orchestrate-active");
			}
			const orchSvg = append(orchBtn, $("svg"));
			orchSvg.setAttribute("width", "15");
			orchSvg.setAttribute("height", "15");
			orchSvg.setAttribute("viewBox", "0 0 24 24");
			orchSvg.setAttribute("fill", "none");
			orchSvg.setAttribute("stroke", "currentColor");
			orchSvg.setAttribute("stroke-width", "2");
			const circle = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"circle",
			);
			circle.setAttribute("cx", "12");
			circle.setAttribute("cy", "12");
			circle.setAttribute("r", "3");
			orchSvg.appendChild(circle);
			const sunPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			sunPath.setAttribute(
				"d",
				"M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83",
			);
			orchSvg.appendChild(sunPath);
			this._register(
				addDisposableListener(orchBtn, EventType.CLICK, () => {
					this._autoOrchestrateEnabled = !this._autoOrchestrateEnabled;
					this._render();
				}),
			);
		}

		// Spacer
		append(left, $(".chat-header-spacer"));

		// Right: 5 action buttons (message-nav / new / history / settings)
		const actions = append(header, $(".chat-header-actions"));

		// 1. Message-nav (会话消息列表)
		this._msgNavTrigger = this._appendHeaderActionBtn(actions, {
			title: '会话消息列表',
			svgPath: 'M4 6h16M4 12h10M4 18h16',
		});
		// Disable if no user messages
		const userMsgCount = this._messages.filter(m => m.role === 'user').length;
		if (userMsgCount === 0) {
			this._msgNavTrigger.classList.add('disabled');
			this._msgNavTrigger.setAttribute('aria-disabled', 'true');
		}
		if (this._activeHeaderPanel === 'message-nav') {
			this._msgNavTrigger.classList.add('active');
		}
		this._register(
			addDisposableListener(this._msgNavTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._msgNavTrigger && this._msgNavTrigger.classList.contains('disabled')) { return; }
				if (this._msgNavDropdownEl) {
					this._closeMsgNavDropdown();
				} else {
					this._openMsgNavDropdown();
				}
			}),
		);

		// 2. New session (+)
		const newBtn = this._appendHeaderActionBtn(actions, {
			title: '新建会话',
			svgPath: 'M12 5v14M5 12h14',
		});
		this._register(
			addDisposableListener(newBtn, EventType.CLICK, () => {
				console.log('[AgentChatPanel] New Session button clicked, _onNewSession exists:', !!this._onNewSession);
				try {
					this._onNewSession?.();
				} catch (err) {
					console.error('[AgentChatPanel] Error in _onNewSession:', err);
				}
			}),
		);

		// 3. History (clock icon)
		const historyBtn = this._appendHeaderActionBtn(actions, {
			title: '聊天历史',
			svgPath: 'M12 8v4l3 2',
		});
		// Add the outer circle for the clock icon
		const historyClockSvg = historyBtn.querySelector('svg');
		if (historyClockSvg) {
			const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			c.setAttribute('cx', '12');
			c.setAttribute('cy', '12');
			c.setAttribute('r', '9');
			historyClockSvg.insertBefore(c, historyClockSvg.firstChild);
		}
		if (this._activeHeaderPanel === 'history') {
			historyBtn.classList.add('active');
		}
		this._register(
			addDisposableListener(historyBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = this._activeHeaderPanel === 'history' ? null : 'history';
				this._render();
			}),
		);

		// 4. Settings (gear)
		const settingsBtn = this._appendHeaderActionBtn(actions, {
			title: '设置',
			svgPath: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
		});
		const gearSvg = settingsBtn.querySelector('svg');
		if (gearSvg) {
			const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			c.setAttribute('cx', '12');
			c.setAttribute('cy', '12');
			c.setAttribute('r', '3');
			gearSvg.insertBefore(c, gearSvg.firstChild);
		}
		this._register(
			addDisposableListener(settingsBtn, EventType.CLICK, () => {
				this._onOpenSettings?.();
			}),
		);
	}

	// Header-action button helper
	private _appendHeaderActionBtn(parent: HTMLElement, opts: { title: string; svgPath: string }): HTMLElement {
		const el = append(parent, $(".chat-header-action-btn.chat-header-btn"));
		el.title = opts.title;
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "15");
		svg.setAttribute("height", "15");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
		pathEl.setAttribute("d", opts.svgPath);
		svg.appendChild(pathEl);
		el.appendChild(svg);
		return el;
	}

	// Header worktree pill
	private _renderHeaderWorktree(parent: HTMLElement): void {
		this._worktreeTrigger = append(parent, $(".chat-header-worktree"));
		const btn = append(this._worktreeTrigger, $("button.chat-header-worktree-btn"));
		btn.title = '切换 Worktree';

		// Branch icon
		const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		iconSvg.setAttribute('width', '14');
		iconSvg.setAttribute('height', '14');
		iconSvg.setAttribute('viewBox', '0 0 24 24');
		iconSvg.setAttribute('fill', 'none');
		iconSvg.setAttribute('stroke', 'currentColor');
		iconSvg.setAttribute('stroke-width', '2');
		iconSvg.setAttribute('stroke-linecap', 'round');
		iconSvg.setAttribute('stroke-linejoin', 'round');
		const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		iconPath.setAttribute('d', 'M6 3v12M18 9v12M6 21l12-12');
		iconSvg.appendChild(iconPath);
		btn.appendChild(iconSvg);

		// Branch label
		const current = this._worktrees.find(w => w.path === this._selectedWorktreePath);
		const branchEl = append(btn, $("span.chat-header-worktree-branch"));
		const fallback = this._selectedWorktreePath ? this._selectedWorktreePath.split(/[\\/]/).filter(Boolean).pop() || 'main' : 'main';
		branchEl.textContent = current?.branch || fallback;

		// Chevron
		const chevSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		chevSvg.setAttribute('width', '12');
		chevSvg.setAttribute('height', '12');
		chevSvg.setAttribute('viewBox', '0 0 24 24');
		chevSvg.setAttribute('fill', 'none');
		chevSvg.setAttribute('stroke', 'currentColor');
		chevSvg.setAttribute('stroke-width', '2.5');
		chevSvg.setAttribute('stroke-linecap', 'round');
		chevSvg.setAttribute('stroke-linejoin', 'round');
		chevSvg.classList.add('chat-header-worktree-chevron');
		const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		chevPath.setAttribute('d', 'M6 9l6 6 6-6');
		chevSvg.appendChild(chevPath);
		btn.appendChild(chevSvg);

		this._register(
			addDisposableListener(btn, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._worktreeDropdownEl) {
					this._closeWorktreeDropdown();
				} else {
					this._openWorktreeDropdown();
				}
			}),
		);
	}

	// Agent dropdown — open / close / render

	private _openAgentDropdown(): void {
		if (this._dropdownOpen) { return; }
		this._dropdownOpen = true;
		this._dropdownFilter = "";

		// Toggle chevron rotation via class
		if (this._agentSelectorTrigger) {
			this._agentSelectorTrigger.classList.add("open");
		}

		// Create dropdown panel on document.body to avoid any overflow:hidden clipping
		this._agentDropdownEl = append(mainWindow.document.body, $(".chat-agent-dropdown"));

		// Fixed position aligned to the chat container
		const containerRect = this._container.getBoundingClientRect();
		const headerHeight = 52; // approximate header height (padding + content + border)
		this._agentDropdownEl.style.position = "fixed";
		this._agentDropdownEl.style.top = (containerRect.top + headerHeight) + "px";
		this._agentDropdownEl.style.left = (containerRect.left + 14) + "px";
		this._agentDropdownEl.style.width = (containerRect.width - 28) + "px";
		this._agentDropdownEl.style.maxHeight = Math.min(320, containerRect.bottom - containerRect.top - headerHeight - 20) + "px";

		this._renderAgentDropdownContent();

		// Close on outside click
		const outsideHandler = addDisposableListener(mainWindow.document.body, EventType.CLICK, (e) => {
			if (this._agentDropdownEl && !this._agentDropdownEl.contains(e.target as Node) &&
				this._agentSelectorTrigger && !this._agentSelectorTrigger.contains(e.target as Node)) {
				this._closeAgentDropdown();
			}
		});
		this._register(outsideHandler);

		// Auto-focus search
		if (this._agentSearchInput) {
			this._agentSearchInput.focus();
		}
	}

	private _closeAgentDropdown(): void {
		if (!this._dropdownOpen) { return; }
		this._dropdownOpen = false;

		if (this._agentSelectorTrigger) {
			this._agentSelectorTrigger.classList.remove("open");
		}

		if (this._agentDropdownEl) {
			this._agentDropdownEl.remove();
			this._agentDropdownEl = null;
		}
		this._agentSearchInput = null;
		this._agentDropdownList = null;
		this._dropdownFilter = "";
	}

	private _renderAgentDropdownContent(): void {
		if (!this._agentDropdownEl) { return; }

		// Search input
		const searchWrap = append(this._agentDropdownEl, $(".chat-agent-dropdown-search"));
		const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		searchIcon.setAttribute("width", "14");
		searchIcon.setAttribute("height", "14");
		searchIcon.setAttribute("viewBox", "0 0 24 24");
		searchIcon.setAttribute("fill", "none");
		searchIcon.setAttribute("stroke", "currentColor");
		searchIcon.setAttribute("stroke-width", "2");
		searchIcon.classList.add("search-icon");
		const circleEl = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		circleEl.setAttribute("cx", "11");
		circleEl.setAttribute("cy", "11");
		circleEl.setAttribute("r", "8");
		searchIcon.appendChild(circleEl);
		const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
		lineEl.setAttribute("x1", "21");
		lineEl.setAttribute("y1", "21");
		lineEl.setAttribute("x2", "16.65");
		lineEl.setAttribute("y2", "16.65");
		searchIcon.appendChild(lineEl);
		searchWrap.appendChild(searchIcon);

		this._agentSearchInput = append(searchWrap, $("input.chat-agent-dropdown-input")) as HTMLInputElement;
		this._agentSearchInput.placeholder = "搜索 Agent...";
		this._agentSearchInput.value = this._dropdownFilter;

		this._register(
			addDisposableListener(this._agentSearchInput, EventType.INPUT, () => {
				this._dropdownFilter = this._agentSearchInput?.value || "";
				this._renderAgentList();
			}),
		);

		// Prevent Enter key from bubbling up
		this._register(
			addDisposableListener(this._agentSearchInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === "Escape") {
					this._closeAgentDropdown();
				}
				e.stopPropagation();
			}),
		);

		// Agent list
		this._agentDropdownList = append(this._agentDropdownEl, $(".chat-agent-dropdown-list"));
		this._renderAgentList();
	}

	private _renderAgentList(): void {
		if (!this._agentDropdownList) { return; }
		clearNode(this._agentDropdownList);

		const filter = this._dropdownFilter.toLowerCase().trim();
		const filtered = filter
			? this._availableAgents.filter(e =>
				e.name.toLowerCase().includes(filter) ||
				e.role.toLowerCase().includes(filter)
			)
			: this._availableAgents;

		if (filtered.length === 0) {
			const noResults = append(this._agentDropdownList, $(".chat-agent-dropdown-no-results"));
			noResults.textContent = "未找到匹配的 Agent";
			return;
		}

		for (const agent of filtered) {
			const item = append(this._agentDropdownList, $(".chat-agent-dropdown-item"));
			if (this._agent?.id === agent.id) {
				item.classList.add("active");
			}

			// Mini avatar
			const miniAvatar = append(item, $(".chat-agent-dropdown-item-avatar"));
			if (agent.avatarUrl) {
				const img = append(miniAvatar, $("img")) as HTMLImageElement;
				img.src = agent.avatarUrl;
				img.alt = agent.name;
			} else if (agent.icon) {
				// Use icon emoji as fallback when avatarUrl is not available
				const fallback = append(miniAvatar, $(".chat-agent-dropdown-item-avatar-fallback"));
				fallback.textContent = agent.icon;
			} else {
				const fallback = append(miniAvatar, $(".chat-agent-dropdown-item-avatar-fallback"));
				fallback.textContent = agent.name.charAt(0).toUpperCase();
			}

			// Name + role
			const itemInfo = append(item, $(".chat-agent-dropdown-item-info"));
			append(itemInfo, $(".chat-agent-dropdown-item-name", undefined, agent.name));
			const roleText = agent.role?.split(/[，,]/)[0] || "";
			append(itemInfo, $(".chat-agent-dropdown-item-role", undefined, roleText));

			// Click to select (mirrors React AgentChat.tsx logic)
			this._register(
				addDisposableListener(item, EventType.CLICK, (e) => {
					e.stopPropagation();
					// Select agent first (matches React: selectAgent + setActiveAgent)
					if (agent.id !== this._agent?.id) {
						this._onSelectAgent(agent.id);
					}
					// Then close dropdown and clear filter (matches React: setDropdownOpen + setDropdownFilter)
					this._closeAgentDropdown();
				}),
			);
		}
	}

	// --- Hermes turn aggregation ---
	// Merges consecutive assistant messages that share the same turnId into single bubbles,
	// matching the React webview displayMessages computed-property behavior.
	private _aggregateTurns(messages: IAgentChatMessage[]): IAgentChatMessage[] {
		if (!messages.length) { return []; }

		const aggregated: IAgentChatMessage[] = [];
		let i = 0;

		while (i < messages.length) {
			const current = messages[i];

			// Skip non-assistant or messages without turnId
			if (current.role !== 'assistant' || !current.turnId) {
				aggregated.push(current);
				i++;
				continue;
			}

			// Collect consecutive assistant messages with same turnId
			const turnId = current.turnId;
			const turnMessages: IAgentChatMessage[] = [current];
			let j = i + 1;
			while (j < messages.length && messages[j].role === 'assistant' && messages[j].turnId === turnId) {
				turnMessages.push(messages[j]);
				j++;
			}

			if (turnMessages.length === 1) {
				aggregated.push(current);
			} else {
				// Merge: concatenate content, merge toolCalls (adjust textPosition offsets)
				const mergedContent = turnMessages
					.map(m => m.content || '')
					.filter(c => c.length > 0)
					.join('\n\n');
				const mergedToolCalls: IToolCall[] = [];
				let contentOffset = 0;
				for (const tm of turnMessages) {
					const tcOffset = contentOffset;
					const tcs = (tm.toolCalls || []).map(tc => ({
						...tc,
						textPosition: tc.textPosition != null ? tc.textPosition + tcOffset : undefined,
					}));
					mergedToolCalls.push(...tcs);
					contentOffset += (tm.content || '').length + 2; // +2 for \n\n separator
				}

				const lastMsg = turnMessages[turnMessages.length - 1];
				const merged: IAgentChatMessage = {
					...lastMsg,
					id: `turn-${turnId}`,
					content: mergedContent,
					toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : undefined,
					thinking: turnMessages.map(m => m.thinking).filter(Boolean).join('\n\n') || undefined,
				};
				aggregated.push(merged);
			}

			i = j;
		}

		return aggregated;
	}

	// Messages area

	private _renderMessagesArea(): void {
		this._messagesWrapper = append(
			this._container,
			$(".chat-messages-wrapper"),
		);
		this._messagesContainer = append(
			this._messagesWrapper,
			$(".chat-messages"),
		);

		// Scroll listener — toggle bottom button visibility
		this._register(
			addDisposableListener(this._messagesContainer, EventType.SCROLL, () => {
				const el = this._messagesContainer;
				const nearBottom =
					el.scrollHeight - el.scrollTop - el.clientHeight < 60;
				const showBottom = !nearBottom;
				if (showBottom !== this._showScrollBtn) {
					this._showScrollBtn = showBottom;
					this._scrollToBottomBtn.style.display = showBottom ? "flex" : "none";
				}
			}),
		);

		// Scroll-to-bottom button
		this._scrollToBottomBtn = append(
			this._messagesWrapper,
			$(".scroll-to-bottom-btn.chat-scroll-bottom-btn"),
		);
		this._scrollToBottomBtn.style.display = "none";
		const svg = append(this._scrollToBottomBtn, $("svg"));
		svg.setAttribute("width", "20");
		svg.setAttribute("height", "20");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2.5");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", "M12 5v14M5 12l7 7 7-7");
		path.setAttribute("stroke-linecap", "round");
		path.setAttribute("stroke-linejoin", "round");
		svg.appendChild(path);
		this._register(
			addDisposableListener(this._scrollToBottomBtn, EventType.CLICK, () => {
				this._scrollToBottom(true);
				this._showScrollBtn = false;
				this._scrollToBottomBtn.style.display = "none";
			}),
		);

		// Render existing messages
		this._renderMessages();
	}

	private _renderMessages(): void {
		if (!this._messagesContainer) {
			return;
		}
		clearNode(this._messagesContainer);

		if (this._messages.length === 0) {
			const empty = append(this._messagesContainer, $(".chat-messages-empty"));
			append(empty, $("p", undefined, "还没有消息，开始对话吧"));
			return;
		}

		for (const msg of this._messages) {
			this._appendMessageDom(msg);
		}
	}

	private _appendMessageDom(msg: IAgentChatMessage): void {
		if (!this._messagesContainer) {
			return;
		}
		const el = this._createMessageElement(msg);
		this._messagesContainer.appendChild(el);
	}

	private _updateMessageDom(idx: number, msg: IAgentChatMessage): void {
		if (!this._messagesContainer) { return; }
		const children = this._messagesContainer.children;
		if (idx >= children.length) { return; }
		const existingEl = children[idx] as HTMLElement;

		const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
		const hasStructuralChange =
			hasToolCalls ||
			msg.confirmation ||
			(msg.subAgents && msg.subAgents.length > 0);

		// Fast path 1: no structural change, streaming text-only update
		if (!hasStructuralChange && msg.isStreaming && msg.content) {
			const streamingContainer = existingEl.querySelector('.streaming-container') as HTMLElement | null;
			const streamingText = existingEl.querySelector('.streaming-text') as HTMLSpanElement | null;

			if (streamingContainer) {
				streamingContainer.textContent = '';
				this._renderMarkdownContent(streamingContainer, msg.content);
				return;
			}

			if (streamingText) {
				streamingText.textContent = msg.content;
				return;
			}
		}

		// Fast path 2: tool cards already rendered in DOM — only update text content in place
		// 参考 void：工具调用渲染后，后续流式文本只更新内容区域，不重复重建卡片
		if (msg.isStreaming && msg.content && hasToolCalls) {
			const existingToolCards = existingEl.querySelectorAll('.tool-call-card');
			if (existingToolCards.length > 0) {
				// Tool cards are already present in DOM — update only the content parts
				this._updateStreamingContentInPlace(existingEl, msg);
				return;
			}
		}

		// Slow path: rebuild this single message element and replace in DOM
		const newEl = this._createMessageElement(msg);
		this._messagesContainer.replaceChild(newEl, existingEl);
	}

	/**
	 * 增量更新流式内容（工具卡片已渲染后在流式过程中不断更新文本）
	 * 参考 void：保留工具调用卡片，只更新已渲染的 Markdown 内容区域
	 */
	private _updateStreamingContentInPlace(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		// 检测工具调用结构是否发生变化（新增或移除工具卡片）
		const existingToolCards = existingEl.querySelectorAll('.tool-call-card');
		const newToolCount = msg.toolCalls?.length ?? 0;

		if (existingToolCards.length !== newToolCount) {
			// 结构变化：完整重建
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		// Interleaved 模式（工具卡片交叉插入文本中）：内容拆分为多段，增量更新复杂，直接完整重建
		const interleavedSegments = existingEl.querySelectorAll('.interleaved-segment');
		if (interleavedSegments.length > 0) {
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		// 简单模式：streaming-container + 工具卡片分离 → 只更新文本容器
		const streamingContainer = existingEl.querySelector('.streaming-container') as HTMLElement | null;
		if (streamingContainer) {
			streamingContainer.textContent = '';
			this._renderMarkdownContent(streamingContainer, msg.content);
			return;
		}

		// 回退：完整重建
		this._rebuildMessageElement(existingEl, msg);
	}

	/** 完整重建消息元素并替换到 DOM */
	private _rebuildMessageElement(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		const newEl = this._createMessageElement(msg);
		const parent = existingEl.parentNode;
		if (parent) {
			parent.replaceChild(newEl, existingEl);
		}
	}

	// Message element builder

	private _createMessageElement(msg: IAgentChatMessage): HTMLElement {
		const isUser = msg.role === "user";
		const messageEl = $(`.chat-message.${isUser ? "user" : "assistant"}`);
		messageEl.setAttribute('data-msg-id', msg.id);

		// Assistant avatar
		if (!isUser && this._agent) {
			const avatarWrap = append(messageEl, $(".chat-message-avatar"));
			if (this._agent.avatarUrl) {
				const img = append(avatarWrap, $("img")) as HTMLImageElement;
				img.src = this._agent.avatarUrl;
				img.alt = this._agent.name;
				img.style.width = "100%";
				img.style.height = "100%";
				img.style.objectFit = "cover";
				img.style.borderRadius = "50%";
			} else if (this._agent.icon) {
				// Use icon emoji as fallback when avatarUrl is not available
				const fallback = append(avatarWrap, $(".chat-avatar-fallback"));
				fallback.textContent = this._agent.icon;
			} else {
				const fallback = append(avatarWrap, $(".chat-avatar-fallback"));
				fallback.textContent = this._agent.name.charAt(0).toUpperCase();
			}
		}

		// Bubble
		const bubble = append(
			messageEl,
			$(`.chat-bubble.${isUser ? "user" : "assistant"}`),
		);

		// Thinking card (assistant only)
		if (!isUser && (msg.thinking || msg.isThinking)) {
			bubble.appendChild(this._createThinkingCard(msg));
		}

		// Step / phase indicator — shows rich streaming state based on StreamPhase
		// matches React 5-state model: idle → llm_streaming → tool_executing → awaiting_approval → compressing → error
		if (!isUser && msg.isStreaming && !msg.content && !(msg.thinking) && !(msg.toolCalls?.length)) {
			const phase = msg.streamPhase || this._streamPhase;
			const step = append(bubble, $(".step-indicator.loading"));
			// Add phase-specific CSS class for color styling
			if (phase !== 'idle') {
				step.classList.add(`phase-${phase.replace(/_/g, '-')}`);
			}
		switch (phase) {
			case 'llm_streaming': {
				step.textContent = '';
				append(step, $('span.step-icon.loading-dots', undefined, '...'));
				step.append(' AI 正在输出...');
				break;
			}
			case 'tool_executing': {
				step.textContent = '';
				append(step, $('span.step-icon', undefined, '⚙️'));
				step.append(' 执行工具中...');
				break;
			}
			case 'awaiting_approval': {
				step.textContent = '';
				append(step, $('span.step-icon', undefined, '🔒'));
				step.append(' 等待审批...');
				break;
			}
			case 'compressing': {
				step.textContent = '';
				append(step, $('span.step-icon', undefined, '🔄'));
				step.append(' 压缩上下文中...');
				break;
			}
			case 'error': {
				step.textContent = '';
				const errorIcon = $('span.step-icon', undefined, '⚠');
				errorIcon.style.color = '#f87171';
				step.appendChild(errorIcon);
				step.append(' 出错了');
				break;
			}
			default: {
				step.textContent = '';
				if (msg.currentStep === "call_llm") {
					append(step, $('span.step-icon.loading-dots', undefined, '...'));
					step.append(' 调用模型中...');
				} else if (msg.currentStep === "execute_tool") {
					append(step, $('span.step-icon', undefined, '⚙️'));
					step.append(' 执行工具中...');
				} else {
					append(step, $('span.step-icon.loading-dots', undefined, '...'));
					step.append(' 思考中...');
				}
				break;
			}
		}
		}

		// Content + Tool calls — interleaved rendering for assistant messages
		// (Void-inspired: tool cards inserted at text positions inside markdown),
		// simple rendering for user messages.
		// NOTE: Always use Markdown rendering for assistant messages (including streaming)
		// to ensure code blocks, inline code, and other Markdown features render correctly.
		if (isUser && msg.content) {
			const contentEl = append(bubble, $(".message-content"));
			this._renderUserContent(contentEl, msg.content);
		} else if (!isUser && msg.content && msg.toolCalls && msg.toolCalls.some(tc => tc.textPosition != null)) {
			// Has positioned tool calls → interleaved rendering (tool cards inserted at text positions)
			this._renderInterleavedContent(bubble, msg.content, msg.toolCalls);
		} else if (!isUser && msg.content) {
			// No positioned tool calls → render content as Markdown, then append unpositioned tool calls
			const contentEl = append(bubble, $(".message-content"));
			if (msg.isStreaming) {
				contentEl.classList.add('streaming-container');
			}
			this._renderMarkdownContent(contentEl, msg.content);
			if (msg.toolCalls && msg.toolCalls.length > 0) {
				const section = append(bubble, $(".tool-calls-section"));
				for (const tc of msg.toolCalls) {
					section.appendChild(this._createToolCallCard(tc));
				}
			}
		} else if (!isUser && msg.toolCalls && msg.toolCalls.length > 0) {
			// 回退：工具调用存在但内容为空（流式输出早期阶段常见）
			// 参考 void：工具调用作为独立的进度卡片渲染
			const section = append(bubble, $(".tool-calls-section"));
			for (const tc of msg.toolCalls) {
				section.appendChild(this._createToolCallCard(tc));
			}
		}

		// Sub-agent cards
		if (!isUser && msg.subAgents && msg.subAgents.length > 0) {
			const section = append(bubble, $(".subagent-cards-section"));
			for (const sa of msg.subAgents) {
				section.appendChild(this._createSubAgentCard(sa));
			}
		}

		// LiveWorkflowTraceView — collapsible workflow execution trace
		if (!isUser && msg.workflowExecutions && Object.keys(msg.workflowExecutions).length > 0) {
			bubble.appendChild(this._createLiveWorkflowTraceView(
				msg.workflowExecutions,
				msg.workflowEvents,
				msg.collectVariables
			));
		}

		// Confirmation card
		if (!isUser && msg.confirmation && msg.confirmation.status === 'pending') {
			bubble.appendChild(this._createConfirmationCard(msg.confirmation));
		}

		// AskUser cards (workflow interactive input)
		if (!isUser && msg.askUsers && msg.askUsers.length > 0) {
			for (const askUser of msg.askUsers) {
				bubble.appendChild(this._createAskUserCard(askUser));
			}
		}

		// TodoList card
		if (!isUser && msg.todos && msg.todos.length > 0) {
			bubble.appendChild(this._createTodoListCard(msg.todos));
		}

		// QuestionCarousel card
		if (!isUser && msg.questions && msg.questions.length > 0) {
			bubble.appendChild(this._createQuestionCarouselCard(msg.questions));
		}

		// References card
		if (!isUser && msg.references && msg.references.length > 0) {
			bubble.appendChild(this._createReferencesCard(msg.references));
		}

		// Tip card
		if (!isUser && msg.tip) {
			bubble.appendChild(this._createTipCard(msg.tip));
		}

		// Progress card
		if (!isUser && msg.progress && msg.progress.length > 0) {
			bubble.appendChild(this._createProgressCard(msg.progress));
		}

		// Stream error — structured error card with retry button
		if (!isUser && msg.metadata?.['streamError']) {
			bubble.appendChild(this._createStreamErrorCard(msg));
		}

		// Streaming cursor
		if (!isUser && msg.isStreaming) {
			append(bubble, $("span.streaming-cursor")).textContent = "|";
		}

		// Footer: time + tokens
		const footer = append(bubble, $(".chat-bubble-footer"));
		const time = append(footer, $("span.chat-bubble-time"));
		time.textContent = new Date(msg.timestamp).toLocaleTimeString("zh-CN", {
			hour: "2-digit",
			minute: "2-digit",
		});
		if (!isUser && msg.tokenUsage && msg.tokenUsage.total > 0) {
			const tokens = append(footer, $("span.chat-bubble-tokens"));
			tokens.textContent = `${msg.tokenUsage.total} tokens`;
			tokens.title = `输入: ${msg.tokenUsage.input} / 输出: ${msg.tokenUsage.output}`;
		}

		return messageEl;
	}

	// --- Thinking card ----------------------------------------

	private _createThinkingCard(msg: IAgentChatMessage): HTMLElement {
		const card = $(`.thinking-card${msg.isThinking ? ".active" : ""}`);

		// Header
		const header = $(".thinking-card-header");
		append(card, header);
		const icon = append(header, $("span.thinking-card-icon"));
		if (msg.isThinking) {
			const spinnerSvg = append(icon, $("svg.thinking-spinner"));
			spinnerSvg.setAttribute("width", "14");
			spinnerSvg.setAttribute("height", "14");
			spinnerSvg.setAttribute("viewBox", "0 0 24 24");
			spinnerSvg.setAttribute("fill", "none");
			spinnerSvg.setAttribute("stroke", "currentColor");
			spinnerSvg.setAttribute("stroke-width", "2");
			const spinPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			spinPath.setAttribute("d", "M21 12a9 9 0 11-6.219-8.56");
			spinnerSvg.appendChild(spinPath);
		} else {
			icon.textContent = "...";
		}
		append(
			header,
			$(
				"span.thinking-card-title",
				undefined,
				msg.isThinking ? "思考中..." : "思考过程",
			),
		);
		const toggle = append(header, $("span.thinking-card-toggle.collapsed"));
		toggle.textContent = "▼";

		// Body (initially collapsed, rendered as markdown)
		const body = $(".thinking-card-body");
		append(card, body);
		if (msg.thinking) {
			this._renderMarkdownContent(body, msg.thinking);
		} else {
			body.textContent = msg.isThinking ? "正在思考..." : "";
		}
		body.style.display = "none";

		// Toggle click
		let collapsed = true;
		this._register(
			addDisposableListener(header, EventType.CLICK, () => {
				collapsed = !collapsed;
				body.style.display = collapsed ? "none" : "block";
				toggle.classList.toggle("collapsed", collapsed);
			}),
		);

		return card;
	}

	// --- Tool call card --------------------------------------

	private _createToolCallCard(tc: IToolCall): HTMLElement {
		const isRunning = tc.status === "running";
		const renderType = tc.renderType || '';
		const displayName = tc.displayName || '';
		const card = $(`.tool-call-card.${isRunning ? "running" : "completed"}`);

		// Header — clickable to expand/collapse body
		const header = $(".tool-call-header");
		append(card, header);
		const iconEl = append(header, $("span.tool-call-icon"));
		if (isRunning) {
			const spinner = append(iconEl, $("svg.tool-spinner"));
			spinner.setAttribute("width", "12"); spinner.setAttribute("height", "12");
			spinner.setAttribute("viewBox", "0 0 24 24");
			spinner.setAttribute("fill", "none"); spinner.setAttribute("stroke", "currentColor");
			spinner.setAttribute("stroke-width", "2.5");
			const spinPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
			spinPath.setAttribute("d", "M21 12a9 9 0 11-6.219-8.56");
			spinner.appendChild(spinPath);
		} else {
			const checkSvg = append(iconEl, $("svg"));
			checkSvg.setAttribute("width", "12"); checkSvg.setAttribute("height", "12");
			checkSvg.setAttribute("viewBox", "0 0 24 24");
			checkSvg.setAttribute("fill", "none"); checkSvg.setAttribute("stroke", "currentColor");
			checkSvg.setAttribute("stroke-width", "2.5");
			const checkPath = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
			checkPath.setAttribute("points", "20 6 9 17 4 12");
			checkSvg.appendChild(checkPath);
		}

		// Tool name — prefer displayName, fallback to name
		const nameLabel = displayName || tc.name;
		append(header, $("span.tool-call-name", undefined, nameLabel));
		// Render type badge if present
		if (renderType) {
			append(header, $("span.tool-call-render-type", undefined, renderType));
		}
		// File path (clickable to open file)
		if (tc.filePath) {
			const filePathEl = append(header, $("code.tool-call-file-path", undefined, tc.filePath));
			filePathEl.title = '点击打开文件';
			filePathEl.addEventListener('click', (e) => {
				e.stopPropagation();
				// Open file via vscode.open command
				if (tc.filePath) {
					// Use the command service to open the file
					// This will be wired up via callback in ChatBarPart
					this._onOpenFile?.(tc.filePath);
				}
			});
		}
		const toggle = append(header, $("span.tool-call-toggle.collapsed"));
		toggle.textContent = "▼";

		// Body (defaultShow=true → open by default)
		const body = $(".tool-call-body");
		append(card, body);
		const defaultShow = tc.defaultShow !== false; // true if undefined
		if (!defaultShow) { body.style.display = "none"; }

		if (tc.args) {
			try {
				const parsed = JSON.stringify(JSON.parse(tc.args), null, 2);
				if (parsed !== "{}") {
					const section = append(body, $(".tool-call-section"));
					append(section, $("div.tool-call-section-title", undefined, "参数"));
					const pre = append(section, $("pre.tool-call-code"));
					pre.textContent = parsed;
				}
			} catch {
				// not JSON, skip
			}
		}

		if (tc.result) {
			const section = append(body, $(".tool-call-section"));
			append(section, $("div.tool-call-section-title", undefined, "结果"));
			const pre = append(section, $("pre.tool-call-code"));
			try {
				pre.textContent = JSON.stringify(JSON.parse(tc.result), null, 2);
			} catch {
				pre.textContent = tc.result;
			}
		}

		// Toggle click — starts open when defaultShow is true
		let collapsed = !defaultShow;
		if (!collapsed) { toggle.classList.remove("collapsed"); }
		this._register(
			addDisposableListener(header, EventType.CLICK, () => {
				collapsed = !collapsed;
				body.style.display = collapsed ? "none" : "block";
				toggle.classList.toggle("collapsed", collapsed);
			}),
		);

		return card;
	}

	// --- Sub-agent card (enhanced: blocks, traces, grouping) ---

	private _createSubAgentCard(sa: ISubAgentData): HTMLElement {
		const statusMap: Record<string, { icon: string; label: string; color: string }> = {
			pending: { icon: '⏳', label: '等待中', color: '#9ca3af' },
			running: { icon: '⚙️', label: '运行中', color: '#60a5fa' },
			done: { icon: '✅', label: '完成', color: '#34d399' },
			error: { icon: '❌', label: '错误', color: '#f87171' },
			cancelled: { icon: '⛔', label: '已取消', color: '#9ca3af' },
		};
		const info = statusMap[sa.status] || statusMap.pending;
		const typeLabel = sa.type === 'explore' ? '探索' : sa.type === 'scout' ? '侦察' : '通用';
		const card = $(`.subagent-card.status-${sa.status}`);
		const header = append(card, $('.subagent-card-header'));
		append(header, $('span.subagent-card-icon', undefined, info.icon));
		append(header, $('span.subagent-card-name', undefined, `SubAgent (${typeLabel})`));
		append(header, $('span.subagent-card-status', undefined, info.label)).style.color = info.color;

		const body = append(card, $('.subagent-card-body'));

		// Task description
		if (sa.task) {
			append(body, $('p.subagent-card-task', undefined, sa.task));
		}

		// Progress
		if (sa.progress) {
			append(body, $('p.subagent-card-progress', undefined, sa.progress));
		}

		// Enhanced blocks: Input → Thinking → ToolTrace → Output
		const blocks: { label: string; items: ISubAgentBlock[] | undefined }[] = [
			{ label: '输入', items: sa.inputBlocks },
			{ label: '思考', items: sa.thinkingBlocks },
		];
		for (const { label, items } of blocks) {
			if (!items?.length) continue;
			for (const blk of items) {
				const blkEl = append(body, $(`.subagent-block.${blk.collapsed ? 'collapsed' : ''}`));
				const blkHeader = append(blkEl, $('.subagent-block-header'));
				append(blkHeader, $('span.subagent-block-label', undefined, label));
				if (blk.title) { append(blkHeader, $('span.subagent-block-title', undefined, blk.title)); }
				const blkBody = append(blkEl, $('.subagent-block-content'));
				blkBody.textContent = blk.content.slice(0, 3000) + (blk.content.length > 3000 ? '...' : '');
				if (blk.collapsed) { blkBody.style.display = 'none'; }
			}
		}

		// Tool traces
		if (sa.toolTraces?.length) {
			for (const tt of sa.toolTraces) {
				const traceEl = append(body, $(`.subagent-tool-trace.status-${tt.status}`));
				const traceHeader = append(traceEl, $('.subagent-tool-trace-header'));
				append(traceHeader, $('span.subagent-tool-trace-icon', undefined, tt.status === 'running' ? '⚙️' : '✓'));
				append(traceHeader, $('span.subagent-tool-trace-name', undefined, tt.name));
				if (tt.result) {
					append(traceEl, $('pre.subagent-tool-trace-result', undefined, tt.result.slice(0, 1000)));
				}
			}
		}

		// Output blocks
		if (sa.outputBlocks?.length) {
			for (const blk of sa.outputBlocks) {
				const outEl = append(body, $('.subagent-output-block'));
				const outContent = append(outEl, $('pre.subagent-block-output'));
				outContent.textContent = blk.content.slice(0, 3000) + (blk.content.length > 3000 ? '...' : '');
			}
		}

		// Legacy output
		if (sa.output && !sa.outputBlocks?.length) {
			const out = append(body, $('pre.subagent-card-output'));
			out.textContent = sa.output.slice(0, 2000) + (sa.output.length > 2000 ? '...' : '');
		}
		if (sa.error) {
			const err = append(body, $('pre.subagent-card-error'));
			err.textContent = sa.error;
			err.style.color = '#f87171';
		}
		return card;
	}

	// --- LiveWorkflowTraceView -----------------------------------

	private _createLiveWorkflowTraceView(
		workflowExecutions: Record<string, ILiveWorkflowExecution>,
		workflowEvents?: ILiveWorkflowEvent[],
		collectVariables?: Record<string, ILiveCollectVariable>
	): HTMLElement {
		const container = $('.live-workflow-trace-view');

		for (const [execId, exec] of Object.entries(workflowExecutions)) {
			const execCard = append(container, $('.workflow-execution-card'));

			// Header - collapsible
			const header = append(execCard, $('.workflow-execution-header'));
			const toggleBtn = append(header, $('span.workflow-toggle', undefined, '▼'));
			append(header, $('span.workflow-name', undefined, exec.workflowName));

			const statusInfo = exec.status === 'running' ? { icon: '⚙️', label: '运行中', color: '#60a5fa' } :
								exec.status === 'completed' ? { icon: '✅', label: '完成', color: '#34d399' } :
								exec.status === 'failed' ? { icon: '❌', label: '失败', color: '#f87171' } :
								{ icon: '⛔', label: '已取消', color: '#9ca3af' };
			append(header, $('span.workflow-status', undefined, `${statusInfo.icon} ${statusInfo.label}`)).style.color = statusInfo.color;

			// Body - collapsible content
			const body = append(execCard, $('.workflow-execution-body'));

			// Sub-agents
			if (exec.subAgents.length > 0) {
				const subAgentsSection = append(body, $('.workflow-subagents-section'));
				append(subAgentsSection, $('h4.workflow-section-title', undefined, '子代理'));

				for (const subAgent of exec.subAgents) {
					const saCard = append(subAgentsSection, $('.workflow-subagent-card'));
					const saHeader = append(saCard, $('.workflow-subagent-header'));

					const saStatusInfo = subAgent.status === 'pending' ? { icon: '⏳', label: '等待中', color: '#9ca3af' } :
										subAgent.status === 'running' ? { icon: '⚙️', label: '运行中', color: '#60a5fa' } :
										subAgent.status === 'done' ? { icon: '✅', label: '完成', color: '#34d399' } :
										subAgent.status === 'error' ? { icon: '❌', label: '错误', color: '#f87171' } :
										{ icon: '⛔', label: '已取消', color: '#9ca3af' };

					append(saHeader, $('span.subagent-status-icon', undefined, saStatusInfo.icon));
					append(saHeader, $('span.subagent-name', undefined, subAgent.name));
					append(saHeader, $('span.subagent-status-label', undefined, saStatusInfo.label)).style.color = saStatusInfo.color;

					// Task description
					if (subAgent.task) {
						append(saCard, $('p.subagent-task', undefined, subAgent.task));
					}

					// Streamed text (collapsible)
					if (subAgent.streamedText) {
						const textEl = append(saCard, $('pre.subagent-streamed-text'));
						textEl.textContent = subAgent.streamedText.slice(0, 2000) + (subAgent.streamedText.length > 2000 ? '...' : '');
					}

					// Output
					if (subAgent.output) {
						const outputEl = append(saCard, $('pre.subagent-output'));
						outputEl.textContent = subAgent.output.slice(0, 2000) + (subAgent.output.length > 2000 ? '...' : '');
					}

					// Error
					if (subAgent.error) {
						const errorEl = append(saCard, $('pre.subagent-error'));
						errorEl.textContent = subAgent.error;
						errorEl.style.color = '#f87171';
					}
				}
			}

			// Events timeline (if available)
			if (workflowEvents && workflowEvents.length > 0) {
				const events = workflowEvents.filter(e => e.executionId === execId);
				if (events.length > 0) {
					const eventsSection = append(body, $('.workflow-events-section'));
					append(eventsSection, $('h4.workflow-section-title', undefined, '事件时间线'));

					for (const event of events) {
						const eventEl = append(eventsSection, $('.workflow-event-item'));
						const eventHeader = append(eventEl, $('.workflow-event-header'));

						const kindLabel = event.kind === 'subagent_start' ? '子代理开始' :
										event.kind === 'subagent_end' ? '子代理结束' :
										event.kind === 'delta' ? '增量更新' :
										event.kind === 'ask_user' ? '询问用户' :
										event.kind === 'ask_user_end' ? '询问用户结束' :
										event.kind === 'collect_variables' ? '收集变量' :
										event.kind === 'collect_variables_end' ? '收集变量结束' :
										event.kind === 'execution_end' ? '执行结束' :
										event.kind === 'breakpoint_hit' ? '断点命中' : event.kind;

						append(eventHeader, $('span.workflow-event-kind', undefined, kindLabel));
						if (event.nodeName) {
							append(eventHeader, $('span.workflow-event-node', undefined, event.nodeName));
						}

						// Event details
						if (event.ask) {
							append(eventEl, $('p.workflow-event-ask', undefined, event.ask));
						}
						if (event.summary) {
							append(eventEl, $('p.workflow-event-summary', undefined, event.summary));
						}
					}
				}
			}

			// Collect variables (if available)
			if (collectVariables) {
				const vars = Object.values(collectVariables).filter(v => v.executionId === execId);
				if (vars.length > 0) {
					const varsSection = append(body, $('.workflow-collect-variables-section'));
					append(varsSection, $('h4.workflow-section-title', undefined, '收集变量'));

					for (const cv of vars) {
						const cvEl = append(varsSection, $('.workflow-collect-variable-item'));
						append(cvEl, $('p.workflow-cv-status', undefined, `状态: ${cv.status}`));

						// Variables list
						if (cv.variables.length > 0) {
							const varsList = append(cvEl, $('.workflow-cv-variables-list'));
							for (const v of cv.variables) {
								const vEl = append(varsList, $('.workflow-cv-variable-item'));
								append(vEl, $('span.workflow-cv-variable-name', undefined, v.name));
								if (v.defaultValue) {
									append(vEl, $('span.workflow-cv-variable-default', undefined, `(默认: ${v.defaultValue})`));
								}
							}
						}
					}
				}
			}

			// Collapse toggle functionality
			header.addEventListener('click', () => {
				const isCollapsed = body.style.display === 'none';
				body.style.display = isCollapsed ? 'block' : 'none';
				toggleBtn.textContent = isCollapsed ? '▼' : '▶';
			});
		}

		return container;
	}

	// --- Confirmation card -----------------------------------

	private _createConfirmationCard(cf: IConfirmationData): HTMLElement {
		// Terminal confirmation card (has command field)
		if (cf.command) {
			return this._createTerminalConfirmationCard(cf);
		}

		const card = $('.confirmation-card');
		const header = append(card, $('.confirmation-card-header'));
		append(header, $('span.confirmation-card-title', undefined, cf.title));
		// Security level badge
		if (cf.securityLevel) {
			const badge = append(header, $(`span.security-badge.${cf.securityLevel}`));
			badge.textContent = cf.securityLevel === 'safe' ? '安全' : cf.securityLevel === 'cautious' ? '注意' : '危险';
		}
		const body = append(card, $('.confirmation-card-body'));
		append(body, $('p.confirmation-card-message', undefined, cf.message));
		if (cf.detail) {
			append(body, $('pre.confirmation-card-detail', undefined, cf.detail));
		}
		const actions = append(body, $('.confirmation-card-actions'));
		// Main action buttons
		for (const btn of cf.buttons) {
			const el = append(actions, $(
				`button.confirmation-card-btn${btn.primary ? '.primary' : ''}${btn.danger ? '.danger' : ''}`,
				undefined,
				btn.label,
			));
			this._register(addDisposableListener(el, EventType.CLICK, () => {
				this._onConfirmationAction?.(cf.id, btn.id);
			}));
		}
		// Auto-confirm options (once/session/workspace/always)
		if (cf.autoConfirmOptions?.length) {
			const autoSection = append(body, $('.confirmation-auto-options'));
			append(autoSection, $('span.confirmation-auto-options-label', undefined, '自动确认:'));
			for (const opt of cf.autoConfirmOptions) {
				const btn = append(autoSection, $('button.confirmation-auto-btn'));
				btn.textContent = opt.label;
				this._register(addDisposableListener(btn, EventType.CLICK, () => {
					this._onConfirmationAction?.(cf.id, opt.id);
				}));
			}
		}
		return card;
	}

	private _createTerminalConfirmationCard(cf: IConfirmationData): HTMLElement {
		const card = $('.confirmation-card.confirmation-card-terminal');
		const header = append(card, $('.confirmation-title-bar'));
		const titleContent = append(header, $('.confirmation-title-content'));
		// Terminal icon (chevron-right + line)
		const svgIcon = append(titleContent, $('svg'));
		svgIcon.setAttribute('width', '16');
		svgIcon.setAttribute('height', '16');
		svgIcon.setAttribute('viewBox', '0 0 24 24');
		svgIcon.setAttribute('fill', 'none');
		svgIcon.setAttribute('stroke', 'currentColor');
		svgIcon.setAttribute('stroke-width', '2');
		const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		polyline.setAttribute('points', '4 17 10 11 4 5');
		svgIcon.appendChild(polyline);
		const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('x1', '12');
		line.setAttribute('y1', '19');
		line.setAttribute('x2', '20');
		line.setAttribute('y2', '19');
		svgIcon.appendChild(line);

		append(titleContent, $('span.confirmation-title', undefined, '执行终端命令'));
		const badge = append(titleContent, $('span.confirmation-security-badge.security-cautious'));
		badge.textContent = '终端操作';

		// Command preview
		const cmdSection = append(card, $('.confirmation-terminal-command'));
		const cmdHeader = append(cmdSection, $('.terminal-command-header'));
		append(cmdHeader, $('span.terminal-prompt', undefined, '$'));
		const cmdText = cf.command || '';
		const isLong = cmdText.length > 100;
		const displayCmd = isLong ? cmdText.substring(0, 100) + '...' : cmdText;
		append(cmdHeader, $('code.terminal-command-text', undefined, displayCmd));

		if (isLong) {
			const showMoreBtn = append(cmdSection, $('button.terminal-show-more-btn'));
			showMoreBtn.textContent = '显示全部';
			// Toggle logic would need state management - simplified for now
		}

		// Action buttons
		const actions = append(card, $('.confirmation-actions'));
		const primaryAction = append(actions, $('.confirmation-primary-action'));

		const approveBtn = append(primaryAction, $('button.confirmation-btn.confirmation-btn-approve'));
		const approveSvg = append(approveBtn, $('svg'));
		approveSvg.setAttribute('width', '14');
		approveSvg.setAttribute('height', '14');
		approveSvg.setAttribute('viewBox', '0 0 24 24');
		approveSvg.setAttribute('fill', 'none');
		approveSvg.setAttribute('stroke', 'currentColor');
		approveSvg.setAttribute('stroke-width', '2');
		const approvePolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		approvePolyline.setAttribute('points', '20 6 9 17 4 12');
		approveSvg.appendChild(approvePolyline);
		approveBtn.appendChild(document.createTextNode('执行'));
		this._register(addDisposableListener(approveBtn, EventType.CLICK, () => {
			this._onConfirmationAction?.(cf.id, 'allow_once');
		}));

		// Dropdown for more options
		const dropdownContainer = append(primaryAction, $('.confirmation-dropdown-container'));
		const dropdownToggle = append(dropdownContainer, $('button.confirmation-dropdown-toggle'));
		const toggleSvg = append(dropdownToggle, $('svg'));
		toggleSvg.setAttribute('width', '12');
		toggleSvg.setAttribute('height', '12');
		toggleSvg.setAttribute('viewBox', '0 0 24 24');
		toggleSvg.setAttribute('fill', 'none');
		toggleSvg.setAttribute('stroke', 'currentColor');
		toggleSvg.setAttribute('stroke-width', '2');
		const togglePolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		togglePolyline.setAttribute('points', '6 9 12 15 18 9');
		toggleSvg.appendChild(togglePolyline);

		const dropdownMenu = append(dropdownContainer, $('.confirmation-dropdown-menu'));
		for (const opt of (cf.autoConfirmOptions || [
			{ id: 'allow_session', label: '在此会话中允许' },
			{ id: 'allow_workspace', label: '在工作区中允许' },
			{ id: 'allow_always', label: '始终允许' },
		])) {
			const item = append(dropdownMenu, $('button.confirmation-dropdown-item'));
			item.textContent = opt.label;
			this._register(addDisposableListener(item, EventType.CLICK, () => {
				this._onConfirmationAction?.(cf.id, opt.id);
			}));
		}

		// Reject button
		const rejectBtn = append(actions, $('button.confirmation-btn.confirmation-btn-reject'));
		const rejectSvg = append(rejectBtn, $('svg'));
		rejectSvg.setAttribute('width', '14');
		rejectSvg.setAttribute('height', '14');
		rejectSvg.setAttribute('viewBox', '0 0 24 24');
		rejectSvg.setAttribute('fill', 'none');
		rejectSvg.setAttribute('stroke', 'currentColor');
		rejectSvg.setAttribute('stroke-width', '2');
		const rejectLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		rejectLine1.setAttribute('x1', '18');
		rejectLine1.setAttribute('y1', '6');
		rejectLine1.setAttribute('x2', '6');
		rejectLine1.setAttribute('y2', '18');
		rejectSvg.appendChild(rejectLine1);
		const rejectLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		rejectLine2.setAttribute('x1', '6');
		rejectLine2.setAttribute('y1', '6');
		rejectLine2.setAttribute('x2', '18');
		rejectLine2.setAttribute('y2', '18');
		rejectSvg.appendChild(rejectLine2);
		rejectBtn.appendChild(document.createTextNode('取消'));
		this._register(addDisposableListener(rejectBtn, EventType.CLICK, () => {
			this._onConfirmationAction?.(cf.id, 'reject');
		}));

		return card;
	}

	// --- AskUser Card (workflow interactive input) ---

	private _createAskUserCard(askUser: ILiveWorkflowAskUser): HTMLElement {
		const card = $(`.askuser-card.${askUser.status}`);
		const isPending = askUser.status === 'pending';
		const isAnswered = askUser.status === 'answered';

		// Header
		const header = append(card, $('.askuser-card-header'));
		const headerStatus = isPending
			? { icon: '❓', label: '需要输入', color: 'var(--vscode-charts-blue, #60a5fa)' }
			: isAnswered
				? { icon: '✓', label: '已回答', color: 'var(--vscode-charts-green, #34d399)' }
				: { icon: '⊘', label: askUser.status === 'cancelled' ? '已取消' : '已过期', color: 'var(--as-fg-secondary, #6c757d)' };
		append(header, $('span.askuser-card-icon', { style: `color:${headerStatus.color}` }, headerStatus.icon));
		append(header, $('span.askuser-card-title', undefined, askUser.nodeName));
		append(header, $('span.askuser-card-status', { style: `color:${headerStatus.color}` }, headerStatus.label));

		// Question
		append(card, $('div.askuser-card-question', undefined, askUser.question));

		// Options (interactive only while pending)
		if (isPending) {
			const optionsDiv = append(card, $(`.askuser-options.${askUser.multiSelect ? 'multi' : 'single'}`));
			askUser.options.forEach((opt, idx) => {
				const isSelected = askUser.selectedIndices.includes(idx);
				const optBtn = append(optionsDiv, $('button.askuser-option' + (isSelected ? '.selected' : '')));
				this._register(addDisposableListener(optBtn, EventType.CLICK, () => {
					// Toggle selection
					const current = askUser.selectedIndices.slice();
					if (askUser.multiSelect) {
						const has = current.includes(idx);
						const next = has ? current.filter(i => i !== idx) : [...current, idx].sort((a, b) => a - b);
						askUser.selectedIndices = next;
					} else {
						askUser.selectedIndices = [idx];
					}
					// Re-render this card
					const msgEl = card.closest('.chat-message') as HTMLElement;
					if (msgEl) {
						const msgId = msgEl.dataset.msgId;
						if (msgId) {
							const msg = this._messages.find(m => m.id === msgId);
							if (msg) { this._updateMessageDom(this._messages.indexOf(msg), msg); }
						}
					}
				}));
				append(optBtn, $('span.askuser-option-marker', undefined, askUser.multiSelect ? (isSelected ? '☑' : '☐') : (isSelected ? '●' : '○')));
				const body = append(optBtn, $('span.askuser-option-body'));
				append(body, $('span.askuser-option-label', undefined, opt.label));
				if (opt.description) {
					append(body, $('span.askuser-option-description', undefined, opt.description));
				}
			});

			// Submit button
			const actions = append(card, $('.askuser-actions'));
			const canSubmit = askUser.selectedIndices.length > 0;
			const submitBtn = append(actions, $('button.askuser-submit' + (canSubmit ? '' : '.disabled'))) as HTMLButtonElement;
			submitBtn.textContent = askUser.multiSelect ? `提交选择 (${askUser.selectedIndices.length})` : '提交';
			submitBtn.disabled = !canSubmit;
			this._register(addDisposableListener(submitBtn, EventType.CLICK, () => {
				if (!canSubmit) { return; }
				const selectedLabels = askUser.selectedIndices.map(i => askUser.options[i]?.label).filter(Boolean);
				// Call onAskUserSubmit callback
				this._onAskUserSubmit?.(askUser.id, askUser.executionId, askUser.nodeId, askUser.multiSelect ? selectedLabels : selectedLabels[0] ?? '');
			}));
		}

		// Answered summary (read-only)
		if (isAnswered) {
			const answerDiv = append(card, $('.askuser-answer'));
			append(answerDiv, $('div.askuser-answer-label', undefined, '已选择:'));
			const valuesDiv = append(answerDiv, $('.askuser-answer-values'));
			const selection = Array.isArray(askUser.selection) ? askUser.selection : [askUser.selection];
			selection.forEach(s => {
				if (typeof s === 'string' && s.length > 0) {
					append(valuesDiv, $('span.askuser-answer-chip', undefined, s));
				}
			});
		}

		return card;
	}

	// --- TodoList Card ---

	private _createTodoListCard(todos: ITodoItem[]): HTMLElement {
		const card = $('.todo-list-card');
		const completedCount = todos.filter(t => t.completed).length;
		const totalCount = todos.length;

		// Header
		const header = append(card, $('.todo-header'));
		append(header, $('span.todo-icon', undefined, '☑️'));
		append(header, $('span.todo-title', undefined, '任务清单'));
		append(header, $('span.todo-progress', undefined, `${completedCount}/${totalCount}`));
		const toggle = append(header, $('span.todo-toggle'));
		// Create SVG element directly (avoid TrustedHTML issues with DOMParser)
		const todoToggleSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		todoToggleSvg.setAttribute("width", "12");
		todoToggleSvg.setAttribute("height", "12");
		todoToggleSvg.setAttribute("viewBox", "0 0 24 24");
		todoToggleSvg.setAttribute("fill", "none");
		todoToggleSvg.setAttribute("stroke", "currentColor");
		todoToggleSvg.setAttribute("stroke-width", "2.5");
		const todoTogglePolyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
		todoTogglePolyline.setAttribute("points", "6 9 12 15 18 9");
		todoToggleSvg.appendChild(todoTogglePolyline);
		toggle.appendChild(todoToggleSvg);

		// Body
		const body = append(card, $('.todo-body'));
		const list = append(body, $('.todo-list'));
		todos.forEach(todo => {
			const item = append(list, $('.todo-item' + (todo.completed ? '.completed' : '')));
			const label = append(item, $('label.todo-checkbox-label'));
			const cb = append(label, $('input.todo-checkbox')) as HTMLInputElement;
			cb.type = 'checkbox';
			cb.checked = todo.completed;
			cb.disabled = true; // read-only in chat message
			append(label, $('span.todo-label', undefined, todo.label));
			if (todo.description) {
				append(item, $('span.todo-description', undefined, todo.description));
			}
			if (todo.assignee) {
				append(item, $('span.todo-assignee', undefined, `👤 ${todo.assignee}`));
			}
		});

		return card;
	}

	// --- QuestionCarousel Card ---

	private _createQuestionCarouselCard(questions: ISuggestedQuestion[]): HTMLElement {
		const card = $('.question-carousel-card');

		// Title
		const titleDiv = append(card, $('.question-carousel-title'));
		append(titleDiv, $('span.question-carousel-icon', undefined, '💬'));
		append(titleDiv, $('span', undefined, '推荐问题'));

		// Questions list
		const list = append(card, $('.question-carousel-list'));
		questions.forEach(q => {
			const btn = append(list, $('button.question-carousel-item'));
			btn.title = q.tooltip ?? '';
			this._register(addDisposableListener(btn, EventType.CLICK, () => {
				this._onQuestionClick?.(q);
			}));
			append(btn, $('span.question-label', undefined, q.label));
			// Arrow icon
			const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			arrowSvg.setAttribute('width', '12');
			arrowSvg.setAttribute('height', '12');
			arrowSvg.setAttribute('viewBox', '0 0 24 24');
			arrowSvg.setAttribute('fill', 'none');
			arrowSvg.setAttribute('stroke', 'currentColor');
			arrowSvg.setAttribute('stroke-width', '2');
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', '5');
			line.setAttribute('y1', '12');
			line.setAttribute('x2', '19');
			line.setAttribute('y2', '12');
			arrowSvg.appendChild(line);
			const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			polyline.setAttribute('points', '12 5 19 12 12 19');
			arrowSvg.appendChild(polyline);
			btn.appendChild(arrowSvg);
		});

		return card;
	}

	// --- References Card ---

	private _createReferencesCard(references: IReferenceItem[]): HTMLElement {
		const card = $('.references-card');
		const title = references.length > 1 ? `使用了 ${references.length} 个引用` : '使用了 1 个引用';

		// Header
		const header = append(card, $('.references-header'));
		append(header, $('span.references-icon', undefined, '📚'));
		append(header, $('span.references-title', undefined, title));
		const toggle = append(header, $('span.references-toggle.collapsed'));
		// Create SVG element directly (avoid TrustedHTML issues with DOMParser)
		const refToggleSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		refToggleSvg.setAttribute("width", "12");
		refToggleSvg.setAttribute("height", "12");
		refToggleSvg.setAttribute("viewBox", "0 0 24 24");
		refToggleSvg.setAttribute("fill", "none");
		refToggleSvg.setAttribute("stroke", "currentColor");
		refToggleSvg.setAttribute("stroke-width", "2.5");
		const refTogglePolyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
		refTogglePolyline.setAttribute("points", "6 9 12 15 18 9");
		refToggleSvg.appendChild(refTogglePolyline);
		toggle.appendChild(refToggleSvg);

		// List (collapsed by default)
		const list = append(card, $('.references-list'));
		list.style.display = 'none';
		references.forEach(ref => {
			const item = append(list, $(`.reference-item.${ref.state || ''}`));
			const iconMap: Record<string, string> = { file: '📄', code: '📝', url: '🔗', symbol: '🔧', text: '📋' };
			append(item, $('span.reference-icon', undefined, iconMap[ref.kind] || '📎'));
			append(item, $('span.reference-name', undefined, ref.name));
			if (ref.description) {
				append(item, $('span.reference-description', undefined, ref.description));
			}
			if (ref.state && ref.state !== 'not-modified') {
				const badgeLabel = ref.state === 'modified' ? '已修改' : ref.state === 'pending' ? '待处理' : '已排除';
				append(item, $('span.reference-state-badge', undefined, badgeLabel));
			}
			// Click to open
			this._register(addDisposableListener(item, EventType.CLICK, () => {
				this._onReferenceClick?.(ref);
			}));
		});

		// Toggle expand/collapse
		this._register(addDisposableListener(header, EventType.CLICK, () => {
			const expanded = list.style.display !== 'none';
			list.style.display = expanded ? 'none' : 'block';
			toggle.classList.toggle('collapsed');
		}));

		return card;
	}

	// --- Tip Card ---

	private _createTipCard(tip: ITipMessage): HTMLElement {
		const card = $('.tip-card');
		append(card, $('span.tip-icon', undefined, tip.icon || '💡'));
		append(card, $('span.tip-content', undefined, tip.content));

		if (tip.action) {
			const actionBtn = append(card, $('button.tip-action-btn'));
			actionBtn.textContent = tip.action.label;
			actionBtn.title = tip.action.tooltip ?? '';
			this._register(addDisposableListener(actionBtn, EventType.CLICK, () => {
				this._onTipAction?.(tip.id, tip.action!.actionId);
			}));
		}

		const dismissBtn = append(card, $('button.tip-dismiss-btn'));
		dismissBtn.textContent = '×';
		dismissBtn.title = '关闭提示';
		this._register(addDisposableListener(dismissBtn, EventType.CLICK, () => {
			this._onTipDismiss?.(tip.id);
		}));

		return card;
	}

	// --- Progress Card ---

	private _createProgressCard(progressItems: IProgressMessage[]): HTMLElement {
		const card = $('.progress-card');
		const header = append(card, $('.progress-header'));
		append(header, $('span.progress-header-icon', undefined, '⚙️'));
		append(header, $('span.progress-header-title', undefined, '执行进度'));

		const list = append(card, $('.progress-list'));
		progressItems.forEach(p => {
			const step = append(list, $(`.progress-step.${p.status}`));
			const iconMap: Record<string, string> = { spinner: '⏳', check: '✓', warning: '⚠', error: '✗' };
			append(step, $('span.progress-icon', undefined, iconMap[p.icon ?? ''] || '•'));
			append(step, $('span.progress-content', undefined, p.content));
			if (p.timestamp) {
				append(step, $('span.progress-timestamp', undefined, p.timestamp));
			}
		});

		return card;
	}

	// --- Stream error card (retryable errors with structured display) ---

	private _createStreamErrorCard(msg: IAgentChatMessage): HTMLElement {
		const card = $('.chat-error-card');
		const err = (msg.metadata?.['streamError'] as any);
		const msgText = typeof err === 'string' ? err : err?.message ?? '执行失败';
		const isRetryable = !!(err?.retryable);
		const isRateLimited = !!(err?.isRateLimited);
		const level: string = err?.level || 'error';

		const icon = append(card, $('span.chat-error-icon'));
		icon.textContent = level === 'warning' ? '⚠️' : '❌';

		const text = append(card, $('span.chat-error-text'));
		text.textContent = isRateLimited ? `速率限制: ${msgText}` : msgText;
		text.style.color = level === 'warning' ? '#fbbf24' : '#f87171';

		if (isRetryable) {
			const retryBtn = append(card, $('button.chat-error-retry-btn'));
			retryBtn.textContent = '重试';
			this._register(addDisposableListener(retryBtn, EventType.CLICK, () => {
				// Re-send the last user message before this error
				const msgIdx = this._messages.findIndex(m => m.id === msg.id);
				if (msgIdx > 0) {
					const prevMsg = this._messages[msgIdx - 1];
					if (prevMsg.role === 'user') {
						this._onSendMessage(prevMsg.content);
					}
				}
			}));
		}
		return card;
	}

	// --- Content renderers -----------------------------------

	private _renderUserContent(parent: HTMLElement, content: string): void {
		// Highlight @mentions
		const parts = content.split(/(@[\w\u4e00-\u9fff]+)/g);
		for (const part of parts) {
			if (part.startsWith("@") && part.length > 1) {
				const mention = append(parent, $("span.msg-mention"));
				mention.textContent = part;
			} else {
				append(parent, $("span")).textContent = part;
			}
		}
	}

	private _renderMarkdownContent(parent: HTMLElement, content: string): void {
		const md: IMarkdownString = { value: content, isTrusted: true };
		const LARGE_CODE_THRESHOLD = 30; // lines before auto-collapse

		const options: MarkdownRenderOptions = {
			codeBlockRenderer: (languageAlias, code) => {
				const lang = languageAlias || '';
				const lines = code.split('\n');
				const isLarge = lines.length > LARGE_CODE_THRESHOLD;

				// Wrapper
				const wrapper = document.createElement('div');
				wrapper.className = `code-block-wrapper${isLarge ? ' code-block-collapsed' : ''}`;

				// Header bar
				const header = document.createElement('div');
				header.className = 'code-block-header';

				const langLabel = document.createElement('span');
				langLabel.className = 'code-block-lang';
				langLabel.textContent = lang || 'code';
				header.appendChild(langLabel);

				const actions = document.createElement('span');
				actions.className = 'code-block-actions';

				// Copy button
				const copyBtn = document.createElement('button');
				copyBtn.className = 'code-block-copy-btn';
				copyBtn.title = 'Copy code';
				// Create copy SVG icon directly (avoid TrustedHTML issues)
				const copySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
				copySvg.setAttribute('width', '12');
				copySvg.setAttribute('height', '12');
				copySvg.setAttribute('viewBox', '0 0 24 24');
				copySvg.setAttribute('fill', 'none');
				copySvg.setAttribute('stroke', 'currentColor');
				copySvg.setAttribute('stroke-width', '2');
				copySvg.setAttribute('stroke-linecap', 'round');
				copySvg.setAttribute('stroke-linejoin', 'round');
				const copyRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
				copyRect.setAttribute('x', '9');
				copyRect.setAttribute('y', '9');
				copyRect.setAttribute('width', '13');
				copyRect.setAttribute('height', '13');
				copyRect.setAttribute('rx', '2');
				copyRect.setAttribute('ry', '2');
				copySvg.appendChild(copyRect);
				const copyPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				copyPath.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
				copySvg.appendChild(copyPath);
				copyBtn.appendChild(copySvg);
				copyBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					navigator.clipboard.writeText(code).then(() => {
						copyBtn.textContent = '';
						// Create copied SVG icon directly
						const copiedSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
						copiedSvg.setAttribute('width', '12');
						copiedSvg.setAttribute('height', '12');
						copiedSvg.setAttribute('viewBox', '0 0 24 24');
						copiedSvg.setAttribute('fill', 'none');
						copiedSvg.setAttribute('stroke', 'currentColor');
						copiedSvg.setAttribute('stroke-width', '2');
						copiedSvg.setAttribute('stroke-linecap', 'round');
						copiedSvg.setAttribute('stroke-linejoin', 'round');
						const copiedPolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
						copiedPolyline.setAttribute('points', '20 6 9 17 4 12');
						copiedSvg.appendChild(copiedPolyline);
						copyBtn.appendChild(copiedSvg);
						copyBtn.classList.add('copied');
						setTimeout(() => {
							copyBtn.textContent = '';
							// Re-create copy SVG icon
							const copySvg2 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
							copySvg2.setAttribute('width', '12');
							copySvg2.setAttribute('height', '12');
							copySvg2.setAttribute('viewBox', '0 0 24 24');
							copySvg2.setAttribute('fill', 'none');
							copySvg2.setAttribute('stroke', 'currentColor');
							copySvg2.setAttribute('stroke-width', '2');
							copySvg2.setAttribute('stroke-linecap', 'round');
							copySvg2.setAttribute('stroke-linejoin', 'round');
							const copyRect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
							copyRect2.setAttribute('x', '9');
							copyRect2.setAttribute('y', '9');
							copyRect2.setAttribute('width', '13');
							copyRect2.setAttribute('height', '13');
							copyRect2.setAttribute('rx', '2');
							copyRect2.setAttribute('ry', '2');
							copySvg2.appendChild(copyRect2);
							const copyPath2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
							copyPath2.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
							copySvg2.appendChild(copyPath2);
							copyBtn.appendChild(copySvg2);
							copyBtn.classList.remove('copied');
						}, 1500);
					}).catch(() => { /* ignore */ });
				});
				actions.appendChild(copyBtn);

				// Apply button (Void-inspired BlockCodeApplyWrapper)
				const applyBtn = document.createElement('button');
				applyBtn.className = 'code-block-apply-btn';
				applyBtn.title = 'Apply code to file';
				applyBtn.textContent = 'Apply';
				applyBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					this._onApplyCode?.(code, lang);
				});
				actions.appendChild(applyBtn);

				// Expand/collapse button for large blocks
				if (isLarge) {
					const toggleBtn = document.createElement('button');
					toggleBtn.className = 'code-block-toggle-btn';
					toggleBtn.textContent = `+ Expand (${lines.length} lines)`;
					toggleBtn.addEventListener('click', (e) => {
						e.stopPropagation();
						const collapsed = wrapper.classList.toggle('code-block-collapsed');
						toggleBtn.textContent = collapsed
							? `+ Expand (${lines.length} lines)`
							: `- Collapse`;
					});
					actions.appendChild(toggleBtn);
				}

				header.appendChild(actions);
				wrapper.appendChild(header);

				// Code block
				const pre = document.createElement('pre');
				const codeEl = document.createElement('code');
				if (lang) { codeEl.classList.add(`language-${lang}`); }
				codeEl.textContent = code;
				pre.appendChild(codeEl);
				wrapper.appendChild(pre);

				return Promise.resolve(wrapper);
			},
		};

		// Dispose previous markdown disposable for this parent to avoid leakage
		const existingDisposable = this._markdownDisposables.get(parent);
		if (existingDisposable) {
			existingDisposable.dispose();
		}

		// renderMarkdown returns a disposable that must be managed
		const disposable = renderMarkdown(md, options, parent);
		this._markdownDisposables.set(parent, disposable);
	}

	// --- Interleaved content renderer (Void-inspired: tool cards inserted at text positions) ---

	private _renderInterleavedContent(bubble: HTMLElement, content: string, toolCalls: IToolCall[]): void {
		// Separate tool calls with textPosition from those without
		const positioned = toolCalls.filter(tc => typeof tc.textPosition === 'number' && tc.textPosition! >= 0);
		const unpositioned = toolCalls.filter(tc => typeof tc.textPosition !== 'number' || tc.textPosition! < 0);

		if (positioned.length === 0) {
			// Fast path: no positioned tool cards, render markdown then append unpositioned
			if (content) {
				const contentEl = append(bubble, $(".message-content"));
				this._renderMarkdownContent(contentEl, content);
			}
			for (const tc of unpositioned) {
				const section = bubble.querySelector('.tool-calls-section') || (() => {
					const s = $(".tool-calls-section");
					bubble.appendChild(s);
					return s;
				})();
				section.appendChild(this._createToolCallCard(tc));
			}
			return;
		}

		// Sort positioned tool calls by textPosition (ascending)
		const sorted = [...positioned].sort((a, b) => (a.textPosition ?? 0) - (b.textPosition ?? 0));

		// Build segments: [text-segment-0, tool-0, text-segment-1, tool-1, ...]
		let lastPos = 0;
		for (const tc of sorted) {
			const tcPos = tc.textPosition ?? 0;

			// Render text segment before this tool card
			if (tcPos > lastPos) {
				const segText = content.slice(lastPos, tcPos);
				if (segText.trim()) {
					const segEl = append(bubble, $(".message-content.interleaved-segment"));
					this._renderMarkdownContent(segEl, segText);
				}
			}

			// Insert tool card at this position
			this._createToolCallCardAt(bubble, tc);

			lastPos = Math.max(lastPos, tcPos);
		}

		// Render remaining text after last positioned tool call
		if (lastPos < content.length) {
			const remaining = content.slice(lastPos);
			if (remaining.trim()) {
				const segEl = append(bubble, $(".message-content.interleaved-segment"));
				this._renderMarkdownContent(segEl, remaining);
			}
		}

		// Append unpositioned tool cards at the end
		if (unpositioned.length > 0) {
			const section = $(".tool-calls-section");
			bubble.appendChild(section);
			for (const tc of unpositioned) {
				section.appendChild(this._createToolCallCard(tc));
			}
		}
	}

	/** Create and insert a tool call card directly into the bubble (for interleaved rendering) */
	private _createToolCallCardAt(parent: HTMLElement, tc: IToolCall): void {
		const card = this._createToolCallCard(tc);
		parent.appendChild(card);
	}

	// Input area

	private _renderInputArea(): void {
		const emp = this._agent!;

		// Resize handle — drag to adjust composer height (placed above input area)
		const resizeHandle = append(this._container, $(".composer-resize-handle"));
		this._register(addDisposableListener(resizeHandle, EventType.MOUSE_DOWN, (downEv: MouseEvent) => {
			downEv.preventDefault();
			const startY = downEv.clientY;
			const startH = this._textarea?.offsetHeight ?? this._resizeMaxH;
			const onMove = (moveEv: MouseEvent) => {
				const newH = Math.max(60, Math.min(500, startH + (startY - moveEv.clientY)));
				this._resizeMaxH = newH;
				this._userHasAdjustedHeight = true; // 标记用户已调整过高度
				if (this._textarea) { this._textarea.style.height = `${newH}px`; }
				// 保存用户调整的高度到 localStorage
				try {
					localStorage.setItem('agentChatComposerHeight', newH.toString());
				} catch {
					// localStorage 不可用时忽略
				}
			};
			const onUp = () => {
				document.removeEventListener('mousemove', onMove);
				document.removeEventListener('mouseup', onUp);
			};
			document.addEventListener('mousemove', onMove);
			document.addEventListener('mouseup', onUp);
		}));

		const inputArea = append(this._container, $(".chat-input-area"));

		// Composer box
		const composerBox = append(inputArea, $(".chat-composer-box"));

		// Skill chips bar (inserted before textarea)
		// Note: visibility is controlled by _renderSkillChips() -> line 3103
		this._skillChipsBar = append(composerBox, $(".skill-chips-bar")) as HTMLElement;
		// Initialize skill chips bar visibility
		this._renderSkillChips();

		// Textarea
		this._textarea = append(
			composerBox,
			$("textarea.chat-composer-textarea"),
		) as HTMLTextAreaElement;
		this._textarea.rows = 1;
		this._textarea.placeholder =
			emp.isPM && this._autoOrchestrateEnabled
				? "输入目标，自动创建团队并分派任务... (用 @name 手动指定员工)"
				: `Message ${emp.name}...`;
		this._textarea.disabled = this._isSending;

		// 恢复保存的输入框高度
		try {
			const savedHeight = localStorage.getItem('agentChatComposerHeight');
			if (savedHeight) {
				const height = parseInt(savedHeight, 10);
				if (!isNaN(height) && height >= 60 && height <= 500) {
					this._resizeMaxH = height;
					this._userHasAdjustedHeight = true;
					this._textarea.style.height = `${height}px`;
				}
			}
		} catch {
			// localStorage 不可用时忽略
		}

		// Auto-resize + slash command detection + slash menu
		this._register(
			addDisposableListener(this._textarea, EventType.INPUT, () => {
				const t = this._textarea;
				t.style.height = "auto";
				// 如果用户调整过高度，使用 max（内容高度和用户调整高度的较大值）作为高度
				// 否则使用 min（内容高度不超过 resizeMaxH）
				// 同时限制最大高度为 500px
				const maxAllowed = 500;
				const newHeight = this._userHasAdjustedHeight
					? Math.min(Math.max(t.scrollHeight, this._resizeMaxH), maxAllowed)
					: Math.min(t.scrollHeight, this._resizeMaxH);
				t.style.height = newHeight + "px";

				// Detect /skill /command patterns — show slash menu
				const val = t.value;
				const slashMatch = val.match(/^\/(\w*)$/);
				if (slashMatch) {
					t.style.color = 'var(--ec-accent, #60a5fa)';
					t.setAttribute('data-slash-command', slashMatch[1]);
					const filter = slashMatch[1];
					if (this._slashMenuEl) {
						this._renderSlashMenuItems(filter);
					} else {
						this._openSlashMenu(filter);
					}
				} else {
					t.style.color = '';
					t.removeAttribute('data-slash-command');
					this._closeSlashMenu();
				}
			}),
		);

		// Hidden file input (for attach button + paste)
		this._fileInput = append(this._container, $("input.chat-file-input")) as HTMLInputElement;
		this._fileInput.type = "file";
		this._fileInput.multiple = true;
		this._fileInput.accept = "image/*,.txt,.md,.json,.js,.ts,.py,.go,.rs,.java,.cs,.html,.css";
		this._fileInput.style.display = "none";
		this._fileInput.addEventListener("change", () => this._handleFileSelection());

		// Drag & drop on composer box
		composerBox.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); composerBox.classList.add("drag-over"); });
		composerBox.addEventListener("dragleave", () => composerBox.classList.remove("drag-over"));
		composerBox.addEventListener("drop", (e) => {
			e.preventDefault(); e.stopPropagation(); composerBox.classList.remove("drag-over");
			if (e.dataTransfer?.files.length) { this._addFiles(Array.from(e.dataTransfer.files)); }
		});

		// Paste image/file
		this._register(addDisposableListener(this._textarea, EventType.PASTE, (e) => {
			const clipboardData = (e as ClipboardEvent).clipboardData;
			if (!clipboardData?.files.length) { return; }
			const imageFiles = Array.from(clipboardData.files).filter(f => f.type.startsWith("image/"));
			if (imageFiles.length > 0) { e.preventDefault(); this._addFiles(imageFiles, true); }
		}));

		// Attachment preview area (inserted between textarea and toolbar in composerBox)
		append(composerBox, $(".chat-attachment-bar"));

		// Enter to send / slash menu navigation
		this._register(
			addDisposableListener(
				this._textarea,
				EventType.KEY_DOWN,
				(e: KeyboardEvent) => {
					// Slash menu open: handle navigation keys
					if (this._slashMenuEl) {
						if (e.key === 'ArrowDown') {
							e.preventDefault();
							this._slashMenuIndex++;
							this._highlightSlashMenuItem();
							return;
						}
						if (e.key === 'ArrowUp') {
							e.preventDefault();
							this._slashMenuIndex = Math.max(0, this._slashMenuIndex - 1);
							this._highlightSlashMenuItem();
							return;
						}
						if (e.key === 'Enter') {
							e.preventDefault();
							this._selectSlashMenuItem();
							return;
						}
					if (e.key === 'Escape') {
						e.preventDefault();
						if (this._slashMenuEl) {
							// Slash menu open: close menu
							this._closeSlashMenu();
						} else if (this._isSending && this._onCancelExecution) {
							// Sending: cancel execution
							this._onCancelExecution();
						}
						return;
					}
					}

					// Backspace: if textarea is empty and we have skill chips, remove the last chip
					if (e.key === 'Backspace' && !this._textarea.value && this._skillChips.length > 0) {
						e.preventDefault();
						const lastChip = this._skillChips[this._skillChips.length - 1];
						this._removeSkillChip(lastChip.id);
						return;
					}

					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						this._handleSendMessage();
					}
				},
			),
		);

		// Toolbar
		const toolbar = append(composerBox, $(".chat-composer-toolbar"));
		const leftToolbar = append(toolbar, $(".chat-toolbar-left"));

		// Attach button — triggers file input dialog
		const attachBtn = this._appendToolbarBtn(leftToolbar, {
			title: "上传附件",
			svgPath:
				"M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13",
		});
		this._register(addDisposableListener(attachBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this._fileInput?.click();
		}));

		// Voice button
		this._appendToolbarBtn(leftToolbar, {
			title: "语音输入",
			svgPath:
				"M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8",
		});

		// Divider
		append(leftToolbar, $(".chat-toolbar-divider"));

		// Mode tag (craft / ask / plan)
		const modeOpt = MODE_OPTIONS.find(m => m.id === this._chatMode) || MODE_OPTIONS[0];
		this._modeTrigger = this._appendToolbarBtn(leftToolbar, {
			title: '切换模式',
			svgPath: modeOpt.icon,
			hasLabel: true,
			label: modeOpt.label,
			showChevron: true,
			cssClass: 'mode-tag',
		});
		this._register(
			addDisposableListener(this._modeTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._modeDropdownEl) {
					this._closeModeDropdown();
				} else {
					this._openModeDropdown();
				}
			}),
		);

		// Provider chip
		this._providerTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择 Provider",
			svgPath: "M2 3h20v14H2zM8 21h8M12 17v4",
			hasLabel: true,
			label: this._providers.find(p => p.id === this._currentProvider)?.label || this._currentProvider || "Provider",
			showChevron: true,
			cssClass: "provider-tag",
		});
		this._register(
			addDisposableListener(this._providerTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._providerDropdownEl) {
					this._closeProviderDropdown();
				} else {
					this._openProviderDropdown();
				}
			}),
		);

		// Agent chip — only show when current provider supports agents (e.g. knot)
		const currentProviderInfo = this._providers.find(p => p.id === this._currentProvider);
		const supportsAgents = !!currentProviderInfo?.supportsAgents;
		
		if (supportsAgents) {
			const agentTag = this._appendToolbarBtn(leftToolbar, {
				title: '切换 Agent',
				svgPath: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
				hasLabel: true,
				label: this._agent?.name || 'Agent',
				showChevron: true,
				cssClass: 'agent-tag',
			});
			this._register(
				addDisposableListener(agentTag, EventType.CLICK, (e) => {
					e.stopPropagation();
					if (this._dropdownOpen) {
						this._closeAgentDropdown();
					} else {
						this._openAgentDropdown();
					}
				}),
			);
		}

		// Model chip
		this._modelTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择模型",
			svgPath: "M4 17l6-6-6-6M12 19h8",
			hasLabel: true,
			label: this._models.find(m => m.id === this._currentModel)?.label || this._currentModel || "Model",
			showChevron: true,
			cssClass: "model-tag",
		});
		this._register(
			addDisposableListener(this._modelTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._modelDropdownEl) {
					this._closeModelDropdown();
				} else {
					this._openModelDropdown();
				}
			}),
		);

		// Right wrap: context-usage ring + send circle
		const rightWrap = append(toolbar, $(".provider-model-chip-wrap"));
		this._renderContextUsageRing(rightWrap);

		// Send / Cancel button
		this._sendBtn = append(
			rightWrap,
			$(`.chat-send-circle${this._isSending ? ".chat-cancel-circle" : ""}`),
		);
		this._renderSendButtonSvg();
		this._register(
			addDisposableListener(this._sendBtn, EventType.CLICK, () => {
				if (this._isSending) {
					// 参考React：有输入/附件时发送新消息（自动停止当前），无输入时取消
					if (this._textarea?.value.trim() || this._attachments.length > 0) {
						this._handleSendMessage();
					} else {
						this._onCancelExecution();
					}
				} else {
					this._handleSendMessage();
				}
			}),
		);
	}

	private _appendToolbarBtn(
		parent: HTMLElement,
		opts: {
			title: string;
			svgPath: string;
			extraSvgElements?: SVGElement[];
			hasLabel?: boolean;
			label?: string;
			showChevron?: boolean;
			cssClass?: string;
		},
	): HTMLElement {
		const btn = append(
			parent,
			$(
				`.chat-toolbar-btn${opts.hasLabel ? ".has-label" : ""}${opts.cssClass ? "." + opts.cssClass : ""}`,
			),
		);
		btn.title = opts.title;

		// Extra SVG elements (like the globe for web search)
		if (opts.extraSvgElements) {
			const wrapper = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"svg",
			);
			wrapper.setAttribute("width", "16");
			wrapper.setAttribute("height", "16");
			wrapper.setAttribute("viewBox", "0 0 24 24");
			wrapper.setAttribute("fill", "none");
			wrapper.setAttribute("stroke", "currentColor");
			wrapper.setAttribute("stroke-width", "2");
			wrapper.setAttribute("stroke-linecap", "round");
			wrapper.setAttribute("stroke-linejoin", "round");
			// Append pre-created SVG elements (avoids TrustedHTML issues)
			for (const el of opts.extraSvgElements) {
				wrapper.appendChild(el);
			}
			btn.appendChild(wrapper);
		}

		// Main SVG
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "16");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", opts.svgPath);
		svg.appendChild(path);
		btn.appendChild(svg);

		// Label
		if (opts.hasLabel && opts.label) {
			const labelEl = append(btn, $("span.toolbar-btn-label"));
			labelEl.textContent = opts.label;
		}

		// Chevron
		if (opts.showChevron) {
			const chevron = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"svg",
			);
			chevron.setAttribute("width", "10");
			chevron.setAttribute("height", "10");
			chevron.setAttribute("viewBox", "0 0 24 24");
			chevron.setAttribute("fill", "none");
			chevron.setAttribute("stroke", "currentColor");
			chevron.setAttribute("stroke-width", "2.5");
			const chevronPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			chevronPath.setAttribute("d", "M6 9l6 6 6-6");
			chevron.appendChild(chevronPath);
			btn.appendChild(chevron);
		}

		return btn;
	}

	private _renderSendButtonSvg(): void {
		clearNode(this._sendBtn);
		if (this._isSending) {
			// Stop icon
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "currentColor");
			const rect = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"rect",
			);
			rect.setAttribute("x", "6");
			rect.setAttribute("y", "6");
			rect.setAttribute("width", "12");
			rect.setAttribute("height", "12");
			rect.setAttribute("rx", "2");
			svg.appendChild(rect);
			this._sendBtn.appendChild(svg);
			this._sendBtn.title = "取消执行";
		} else {
			// Arrow up icon
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "16");
			svg.setAttribute("height", "16");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2.5");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			const line = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"line",
			);
			line.setAttribute("x1", "12");
			line.setAttribute("y1", "19");
			line.setAttribute("x2", "12");
			line.setAttribute("y2", "5");
			svg.appendChild(line);
			const polyline = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"polyline",
			);
			polyline.setAttribute("points", "5 12 12 5 19 12");
			svg.appendChild(polyline);
			this._sendBtn.appendChild(svg);
			this._sendBtn.title = "发送 (Enter)";
		}
	}

	private _updateSendButton(): void {
		if (!this._sendBtn) {
			return;
		}
		this._sendBtn.classList.toggle("chat-cancel-circle", this._isSending);
		if (this._textarea) {
			this._textarea.disabled = this._isSending;
		}
		// 参考React：按钮禁用逻辑
		// disabled = !input.trim() && attachments.length === 0 && !isLoading
		const hasInput = (this._textarea?.value.trim() || this._attachments.length > 0);
		const disabled = !hasInput && !this._isSending;
		(this._sendBtn as HTMLButtonElement).disabled = disabled;

		// 更新按钮标题（参考React）
		if (this._isSending) {
			if (hasInput) {
				this._sendBtn.title = '发送新消息 (自动停止当前)';
			} else {
				this._sendBtn.title = '停止生成 (Escape)';
			}
		} else {
			this._sendBtn.title = '发送 (Enter)';
		}

		this._renderSendButtonSvg();
	}

	// =========================================================
	// Session Info Bar (mode badge + hierarchy + tasks)
	// =========================================================

	private _renderSessionInfo(): void {
		const info = this._sessionInfo!;
		const bar = append(this._container, $(".chat-session-info"));

		const modeBadge = append(bar, $(`.chat-mode-badge.mode-${info.mode}`));
		modeBadge.textContent = info.mode === 'craft' ? 'Craft' : info.mode === 'ask' ? 'Ask' : 'Plan';

		const hierarchy = append(bar, $(".session-info-hierarchy"));
		if (info.superior) {
			append(hierarchy, $("span.hierarchy-label", undefined, '上级'));
			append(hierarchy, $("span.hierarchy-agent", undefined, info.superior.name));
			if (info.subordinates && info.subordinates.length > 0) {
				append(hierarchy, $("span.hierarchy-comma", undefined, ' · '));
			}
		}
		if (info.subordinates && info.subordinates.length > 0) {
			append(hierarchy, $("span.hierarchy-label", undefined, '下级'));
			const names = info.subordinates.map(s => s.name).join('、');
			append(hierarchy, $("span.hierarchy-agent", undefined, names));
		}
		if (!info.superior && (!info.subordinates || info.subordinates.length === 0)) {
			append(hierarchy, $("span.hierarchy-label", undefined, '独立会话'));
		}

		const tasks = append(bar, $(".session-info-tasks"));
		tasks.textContent = `任务 ${info.taskCount}`;
	}

	// =========================================================
	// CheckpointBar
	// =========================================================

	private _renderCheckpointBarContainer(): void {
		this._checkpointBarContainer = append(this._container, $(".chat-checkpoint-bar-container"));
		this._renderCheckpointBar();
	}

	private _renderCheckpointBar(): void {
		if (!this._checkpointBarContainer) { return; }
		clearNode(this._checkpointBarContainer);
		if (!this._checkpoint) { return; }
		const cp = this._checkpoint;
		const bar = append(this._checkpointBarContainer, $(".chat-checkpoint-bar"));

		const main = append(bar, $(".chat-checkpoint-bar-main"));

		// Files toggle
		const toggle = append(main, $(`.chat-checkpoint-bar-files-toggle${this._checkpointFilesExpanded ? '.expanded' : ''}`));
		const togSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		togSvg.setAttribute('width', '12');
		togSvg.setAttribute('height', '12');
		togSvg.setAttribute('viewBox', '0 0 24 24');
		togSvg.setAttribute('fill', 'none');
		togSvg.setAttribute('stroke', 'currentColor');
		togSvg.setAttribute('stroke-width', '2.5');
		togSvg.setAttribute('stroke-linecap', 'round');
		togSvg.setAttribute('stroke-linejoin', 'round');
		const togPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		togPath.setAttribute('d', this._checkpointFilesExpanded ? 'M6 9l6 6 6-6' : 'M9 18l6-6-6-6');
		togSvg.appendChild(togPath);
		toggle.appendChild(togSvg);
		append(toggle, $("span", undefined, `${cp.fileCount} 个文件`));
		this._register(
			addDisposableListener(toggle, EventType.CLICK, () => {
				this._checkpointFilesExpanded = !this._checkpointFilesExpanded;
				this._renderCheckpointBar();
			}),
		);

		// Label
		const label = append(main, $(".chat-checkpoint-bar-label"));
		label.textContent = cp.label;

		// Actions
		const actions = append(main, $(".chat-checkpoint-bar-actions"));

		const undoBtn = append(actions, $("button.chat-checkpoint-bar-btn.undo"));
		undoBtn.textContent = '撤销全部';
		this._register(
			addDisposableListener(undoBtn, EventType.CLICK, () => {
				this._onCheckpointAction?.('undoAll');
			}),
		);

		const keepBtn = append(actions, $("button.chat-checkpoint-bar-btn.keep"));
		keepBtn.textContent = '保留全部';
		this._register(
			addDisposableListener(keepBtn, EventType.CLICK, () => {
				this._onCheckpointAction?.('keepAll');
			}),
		);

		const diffBtn = append(actions, $("button.chat-checkpoint-bar-btn.diff"));
		diffBtn.textContent = '查看差异';
		this._register(
			addDisposableListener(diffBtn, EventType.CLICK, () => {
				this._onCheckpointAction?.('openDiff');
			}),
		);

		// File list (expanded)
		if (this._checkpointFilesExpanded) {
			const files = append(bar, $(".chat-checkpoint-bar-files"));
			for (const f of cp.files) {
				const fileEl = append(files, $(".chat-checkpoint-bar-file"));
				const status = append(fileEl, $(`.chat-checkpoint-bar-file-status.${f.status}`));
				status.textContent = f.status === 'modified' ? 'M' : f.status === 'created' ? 'A' : 'D';
				const path = append(fileEl, $("span.chat-checkpoint-bar-file-path"));
				path.textContent = f.path;
				this._register(
					addDisposableListener(fileEl, EventType.CLICK, () => {
						this._onCheckpointAction?.('openDiff', { filePath: f.path });
					}),
				);
			}
		}
	}

	// =========================================================
	// Slash menu (slash command picker)
	// =========================================================

	private _openSlashMenu(filter: string): void {
		this._closeSlashMenu();

		const skills = this._onListSkills();
		if (!skills.length) { return; }

		const filtered = filter
			? skills.filter(s =>
				s.id.toLowerCase().includes(filter.toLowerCase()) ||
				s.name.toLowerCase().includes(filter.toLowerCase()))
			: skills;
		if (!filtered.length) { return; }

		const textarea = this._textarea;
		const rect = textarea.getBoundingClientRect();

		this._slashMenuEl = document.createElement('div');
		this._slashMenuEl.className = 'slash-menu';
		// Position above textarea
		this._slashMenuEl.style.left = `${rect.left}px`;
		this._slashMenuEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		this._slashMenuEl.style.maxWidth = `${Math.max(rect.width, 260)}px`;

		// Items (render directly since we just created the element)
		const list = document.createElement('div');
		list.className = 'slash-menu-list';
		filtered.forEach((s, i) => {
			const item = document.createElement('div');
			item.className = 'slash-menu-item';
			item.dataset.skillId = s.id;
			item.dataset.skillName = s.name || s.id;
			const icon = document.createElement('span');
			icon.className = 'slash-menu-item-icon';
			icon.textContent = '/';
			item.appendChild(icon);
			const info = document.createElement('span');
			info.className = 'slash-menu-item-info';
			const name = document.createElement('span');
			name.className = 'slash-menu-item-name';
			name.textContent = s.id;
			info.appendChild(name);
			const desc = document.createElement('span');
			desc.className = 'slash-menu-item-desc';
			desc.textContent = s.name;
			info.appendChild(desc);
			item.appendChild(info);
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this._insertSlashSkill(s.id, s.name || s.id);
				this._closeSlashMenu();
			});
			list.appendChild(item);
		});

		this._slashMenuEl.appendChild(list);
		document.body.appendChild(this._slashMenuEl);
		this._slashMenuIndex = 0;
		this._highlightSlashMenuItem();
	}

	private _renderSlashMenuItems(filter: string): void {
		if (!this._slashMenuEl) { return; }
		const skills = this._onListSkills();
		const filtered = filter
			? skills.filter(s =>
				s.id.toLowerCase().includes(filter.toLowerCase()) ||
				s.name.toLowerCase().includes(filter.toLowerCase()))
			: skills;

		const list = this._slashMenuEl.querySelector('.slash-menu-list') as HTMLElement | null;
		if (!list) { return; }
		clearNode(list);

		if (!filtered.length) {
			this._closeSlashMenu();
			return;
		}

		filtered.forEach((s, i) => {
			const item = document.createElement('div');
			item.className = 'slash-menu-item';
			item.dataset.skillId = s.id;
			const icon = document.createElement('span');
			icon.className = 'slash-menu-item-icon';
			icon.textContent = '/';
			item.appendChild(icon);
			const info = document.createElement('span');
			info.className = 'slash-menu-item-info';
			const name = document.createElement('span');
			name.className = 'slash-menu-item-name';
			name.textContent = s.id;
			info.appendChild(name);
			const desc = document.createElement('span');
			desc.className = 'slash-menu-item-desc';
			desc.textContent = s.name;
			info.appendChild(desc);
			item.appendChild(info);
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this._insertSlashSkill(s.id, s.name || s.id);
				this._closeSlashMenu();
			});
			list.appendChild(item);
		});

		this._slashMenuIndex = Math.min(this._slashMenuIndex, filtered.length - 1);
		this._highlightSlashMenuItem();
	}

	private _highlightSlashMenuItem(): void {
		const items = this._slashMenuEl?.querySelectorAll('.slash-menu-item');
		if (!items?.length) { return; }
		items.forEach((el, i) => {
			el.classList.toggle('selected', i === this._slashMenuIndex);
		});
		// Scroll selected into view
		const selected = items[this._slashMenuIndex] as HTMLElement | undefined;
		if (selected) { selected.scrollIntoView({ block: 'nearest' }); }
	}

	// --- Skill chips (P2) ---

	private _addSkillChip(id: string, name: string): void {
		// Check if already added
		if (this._skillChips.some(c => c.id === id)) { return; }
		this._skillChips.push({ id, name });
		this._renderSkillChips();
	}

	private _removeSkillChip(id: string): void {
		this._skillChips = this._skillChips.filter(c => c.id !== id);
		this._renderSkillChips();
	}

	private _renderSkillChips(): void {
		if (!this._skillChipsBar) { return; }
		// Clear existing chips
		while (this._skillChipsBar.firstChild) {
			this._skillChipsBar.removeChild(this._skillChipsBar.firstChild);
		}
		// Render chips
		for (const chip of this._skillChips) {
			const chipEl = append(this._skillChipsBar, $('span.skill-chip'));
			chipEl.title = `技能: ${chip.name} (${chip.id})`;
			append(chipEl, $('span.skill-chip-icon', undefined, '⚡'));
			append(chipEl, $('span.skill-chip-name', undefined, chip.name));
		const removeBtn = append(chipEl, $('button.skill-chip-remove'));
			// Create SVG element directly (avoid TrustedHTML issues with DOMParser)
			const removeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			removeSvg.setAttribute('width', '10');
			removeSvg.setAttribute('height', '10');
			removeSvg.setAttribute('viewBox', '0 0 24 24');
			removeSvg.setAttribute('fill', 'none');
			removeSvg.setAttribute('stroke', 'currentColor');
			removeSvg.setAttribute('stroke-width', '2.5');
			const removeLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			removeLine1.setAttribute('x1', '18');
			removeLine1.setAttribute('y1', '6');
			removeLine1.setAttribute('x2', '6');
			removeLine1.setAttribute('y2', '18');
			removeSvg.appendChild(removeLine1);
			const removeLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			removeLine2.setAttribute('x1', '6');
			removeLine2.setAttribute('y1', '6');
			removeLine2.setAttribute('x2', '18');
			removeLine2.setAttribute('y2', '18');
			removeSvg.appendChild(removeLine2);
			removeBtn.appendChild(removeSvg);
			this._register(addDisposableListener(removeBtn, EventType.CLICK, () => {
				this._removeSkillChip(chip.id);
			}));
		}
		// Show/hide bar
		this._skillChipsBar.style.display = this._skillChips.length > 0 ? 'flex' : 'none';
	}

	private _selectSlashMenuItem(): void {
		const items = this._slashMenuEl?.querySelectorAll('.slash-menu-item');
		if (!items?.length) { return; }
		const selected = items[Math.min(this._slashMenuIndex, items.length - 1)] as HTMLElement | undefined;
		if (selected?.dataset.skillId) {
			this._insertSlashSkill(selected.dataset.skillId, selected.dataset.skillName || selected.dataset.skillId);
		}
		this._closeSlashMenu();
	}

	private _insertSlashSkill(skillId: string, skillName: string): void {
		// Add skill chip
		this._addSkillChip(skillId, skillName);
		// Clear textarea (skill is now in chip)
		this._textarea.value = '';
		this._textarea.style.color = '';
		this._textarea.removeAttribute('data-slash-command');
		// Auto-resize and reposition cursor to end
		this._textarea.style.height = 'auto';
		// 使用新的高度计算逻辑（考虑用户是否调整过高度）
		const maxAllowed = 500;
		const newHeight = this._userHasAdjustedHeight
			? Math.min(Math.max(this._textarea.scrollHeight, this._resizeMaxH), maxAllowed)
			: Math.min(this._textarea.scrollHeight, this._resizeMaxH);
		this._textarea.style.height = newHeight + 'px';
		this._textarea.focus();
		this._textarea.setSelectionRange(this._textarea.value.length, this._textarea.value.length);
	}

	private _closeSlashMenu(): void {
		if (this._slashMenuEl) {
			this._slashMenuEl.remove();
			this._slashMenuEl = null;
		}
		this._slashMenuIndex = 0;
	}

	// =========================================================
	// Context-usage ring
	// =========================================================

	private _renderContextUsageRing(parent: HTMLElement): void {
		const usage = this._contextUsage;
		const ringEl = append(parent, $(".context-usage-ring"));
		const pct = usage ? Math.max(0, Math.min(1, usage.ratio)) : 0;
		if (usage) {
			ringEl.title = `上下文 ${Math.round(pct * 100)}% (${usage.used} / ${usage.limit})`;
			if (pct >= 0.9) { ringEl.classList.add('danger'); }
			else if (pct >= 0.7) { ringEl.classList.add('warn'); }
		} else {
			ringEl.title = '上下文使用';
		}

		const size = 22;
		const stroke = 2.5;
		const r = (size / 2) - stroke;
		const c = 2 * Math.PI * r;
		const offset = c * (1 - pct);

		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", String(size));
		svg.setAttribute("height", String(size));
		svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

		const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		bg.setAttribute("cx", String(size / 2));
		bg.setAttribute("cy", String(size / 2));
		bg.setAttribute("r", String(r));
		bg.setAttribute("fill", "none");
		bg.setAttribute("stroke", "currentColor");
		bg.setAttribute("stroke-width", String(stroke));
		bg.setAttribute("opacity", "0.2");
		svg.appendChild(bg);

		const fg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		fg.setAttribute("cx", String(size / 2));
		fg.setAttribute("cy", String(size / 2));
		fg.setAttribute("r", String(r));
		fg.setAttribute("fill", "none");
		fg.setAttribute("stroke", "currentColor");
		fg.setAttribute("stroke-width", String(stroke));
		fg.setAttribute("stroke-dasharray", String(c));
		fg.setAttribute("stroke-dashoffset", String(offset));
		fg.setAttribute("stroke-linecap", "round");
		fg.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
		fg.classList.add('ring-progress');
		svg.appendChild(fg);

		ringEl.appendChild(svg);
	}

	// ── Context Usage 计算（匹配 React 3 层逻辑）─────────────────

	/** 粗略 token 估算（参考 React estimateTokens：字符数/4 向上取整） */
	private _estimateTokens(text: string | undefined | null): number {
		if (!text) { return 0; }
		return Math.ceil(text.length / 4);
	}

	/** 计算输入基线 tokens（从消息历史中最后一条有 tokenUsage 的消息） */
	private _computeInputBaselineTokens(): number {
		// 从后往前找到最近一条有真实 tokenUsage 的消息
		for (let i = this._messages.length - 1; i >= 0; i--) {
			const m = this._messages[i];
			if (m.tokenUsage && (m.tokenUsage.input > 0 || m.tokenUsage.total > 0)) {
				if (m.tokenUsage.input > 0) {
					return m.tokenUsage.input + (m.tokenUsage.output || 0);
				}
				return m.tokenUsage.total;
			}
		}
		// 无真实 usage（新对话或首条消息）：降级为逐条字符估算
		let total = 0;
		for (const m of this._messages) {
			total += this._estimateTokens(m.content);
			total += this._estimateTokens(m.thinking);
			if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
				for (const tc of m.toolCalls) {
					total += this._estimateTokens(tc.args);
					total += this._estimateTokens(tc.result);
					total += this._estimateTokens(tc.name);
				}
			}
		}
		return total;
	}

	/** 计算 context usage（3 层实时更新逻辑，匹配 React） */
	private _computeContextUsage(): IContextUsage | null {
		const limit = this._contextUsage?.limit ?? 0;
		if (limit <= 0) {
			return null;
		}

		const isStreaming = this._streamPhase !== 'idle' && this._streamPhase !== 'error';

		const inputBaselineTokens = this._computeInputBaselineTokens();

		// effectiveBaseline: 如果有 compactedBaseline，使用它（取较小值）
		const effectiveBaseline = this._compactedBaseline > 0
			? Math.min(this._compactedBaseline, inputBaselineTokens)
			: inputBaselineTokens;

		let used: number;
		if (this._streamUsage?.seen) {
			// 3) 真值优先：已收到真实 usage chunk
			const real = (this._streamUsage.input ?? 0) + (this._streamUsage.output ?? 0);
			used = Math.max(real, effectiveBaseline);
		} else if (isStreaming) {
			// 2) 流式进行中且尚无真实 usage：输入基线 + 实时输出估算
			const outputEstimate = this._estimateTokens(this._streamTextBuffer) + this._estimateTokens(this._streamThinkingBuffer);
			used = effectiveBaseline + outputEstimate;
		} else {
			// 1) 空闲态：纯输入基线
			used = effectiveBaseline;
		}

		const ratio = Math.max(0, Math.min(1, used / limit));
		return {
			used,
			limit,
			ratio,
			percent: Math.round(ratio * 100),
		};
	}

	private _updateContextRing(): void {
		// 重新计算 contextUsage（3层逻辑，匹配 React）
		const computed = this._computeContextUsage();
		if (computed) {
			this._contextUsage = computed;
		}
		// 渲染环形进度条
		const ring = this._container.querySelector('.context-usage-ring') as HTMLElement | null;
		if (!ring) { return; }
		const parent = ring.parentElement;
		if (!parent) { return; }
		const sendBtn = parent.querySelector('.chat-send-circle');
		ring.remove();
		const tempParent = $('div');
		this._renderContextUsageRing(tempParent);
		const newRing = tempParent.firstElementChild;
		if (newRing && sendBtn) {
			parent.insertBefore(newRing, sendBtn);
		} else if (newRing) {
			parent.appendChild(newRing);
		}
	}

	// =========================================================
	// Worktree dropdown
	// =========================================================

	private _openWorktreeDropdown(): void {
		this._closeAllDropdowns();
		this._activeHeaderPanel = 'worktree';
		if (this._worktreeTrigger) { this._worktreeTrigger.classList.add('open'); }

		this._worktreeDropdownEl = append(mainWindow.document.body, $(".chat-worktree-dropdown"));
		this._positionDropdownBelow(this._worktreeDropdownEl, this._worktreeTrigger);

		const head = append(this._worktreeDropdownEl, $(".chat-worktree-dropdown-header"));
		head.textContent = 'Worktrees';

		const list = append(this._worktreeDropdownEl, $(".chat-worktree-dropdown-list"));
		if (this._worktrees.length === 0) {
			append(list, $(".chat-worktree-dropdown-empty", undefined, '当前仓库没有 worktree'));
		} else {
			for (const wt of this._worktrees) {
				const item = append(list, $(".chat-worktree-dropdown-item"));
				if (wt.path === this._selectedWorktreePath) {
					item.classList.add('active');
				}
				const infoCol = append(item, $(".chat-worktree-dropdown-item-info"));
				append(infoCol, $("span.chat-worktree-dropdown-branch", undefined, wt.branch));
				append(infoCol, $("span.chat-worktree-dropdown-path", undefined, wt.path));
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeWorktreeDropdown();
						if (wt.path !== this._selectedWorktreePath) {
							this._selectedWorktreePath = wt.path;
							this._onSelectWorktree?.({ path: wt.path, branch: wt.branch });
							this._render();
						}
					}),
				);
			}
		}

		this._registerOutsideClickClose(this._worktreeDropdownEl, this._worktreeTrigger, () => this._closeWorktreeDropdown());
	}

	private _closeWorktreeDropdown(): void {
		if (this._worktreeDropdownEl) {
			this._worktreeDropdownEl.remove();
			this._worktreeDropdownEl = null;
		}
		if (this._worktreeTrigger) { this._worktreeTrigger.classList.remove('open'); }
		if (this._activeHeaderPanel === 'worktree') {
			this._activeHeaderPanel = null;
		}
	}

	// =========================================================
	// Message-nav dropdown
	// =========================================================

	private _openMsgNavDropdown(): void {
		this._closeAllDropdowns();
		this._activeHeaderPanel = 'message-nav';
		if (this._msgNavTrigger) { this._msgNavTrigger.classList.add('active'); }

		this._msgNavDropdownEl = append(mainWindow.document.body, $(".chat-message-nav-dropdown"));
		this._positionDropdownBelow(this._msgNavDropdownEl, this._msgNavTrigger, true /* rightAlign */);

		const head = append(this._msgNavDropdownEl, $(".chat-message-nav-dropdown-header"));
		head.textContent = '会话消息';

		const list = append(this._msgNavDropdownEl, $(".chat-message-nav-dropdown-list"));
		const userMsgs = this._messages.filter(m => m.role === 'user');

		if (userMsgs.length === 0) {
			append(list, $(".chat-message-nav-empty", undefined, '当前对话还没有消息'));
		} else {
			for (let i = 0; i < userMsgs.length; i++) {
				const m = userMsgs[i];
				const item = append(list, $(".chat-message-nav-dropdown-item"));
				append(item, $("span.chat-message-nav-index", undefined, `#${userMsgs.length - i}`));
				const trimmedContent = (m.content || '').trim();
				const summary = trimmedContent.slice(0, 80).replace(/\n/g, ' ') + (trimmedContent.length > 80 ? '…' : '');
				append(item, $("span.chat-message-nav-summary", undefined, summary));
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeMsgNavDropdown();
						this._scrollToMessage(m.id);
						this._onScrollToMessage?.(m.id);
					}),
				);
			}
		}

		this._registerOutsideClickClose(this._msgNavDropdownEl, this._msgNavTrigger, () => this._closeMsgNavDropdown());
	}

	private _closeMsgNavDropdown(): void {
		if (this._msgNavDropdownEl) {
			this._msgNavDropdownEl.remove();
			this._msgNavDropdownEl = null;
		}
		if (this._msgNavTrigger) { this._msgNavTrigger.classList.remove('active'); }
		if (this._activeHeaderPanel === 'message-nav') {
			this._activeHeaderPanel = null;
		}
	}

	private _scrollToMessage(messageId: string): void {
		if (!this._messagesContainer) { return; }
		const el = this._messagesContainer.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			el.classList.add('chat-message-flash');
			mainWindow.setTimeout(() => el.classList.remove('chat-message-flash'), 1200);
		}
	}

	// =========================================================
	// Mode dropdown (composer)
	// =========================================================

	private _openModeDropdown(): void {
		this._closeAllDropdowns();
		if (this._modeTrigger) { this._modeTrigger.classList.add('open'); }

		this._modeDropdownEl = append(mainWindow.document.body, $(".mode-dropdown-composer"));
		this._positionDropdownAbove(this._modeDropdownEl, this._modeTrigger);

		// — Disable plan mode for non-planner agents (mirrors webview behaviour)
		const isPlanner = this._agent?.agentType === 'planner';

		for (const opt of MODE_OPTIONS) {
			const isDisabled = opt.id === 'plan' && !isPlanner;
			const item = append(this._modeDropdownEl, $(`.mode-item${this._chatMode === opt.id ? '.active' : ''}${isDisabled ? '.disabled' : ''}`));

			// icon
			const ic = append(item, $(".mode-item-icon"));
			const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			sv.setAttribute('width', '14');
			sv.setAttribute('height', '14');
			sv.setAttribute('viewBox', '0 0 24 24');
			sv.setAttribute('fill', 'none');
			sv.setAttribute('stroke', 'currentColor');
			sv.setAttribute('stroke-width', '2');
			sv.setAttribute('stroke-linecap', 'round');
			sv.setAttribute('stroke-linejoin', 'round');
			const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			p.setAttribute('d', opt.icon);
			sv.appendChild(p);
			ic.appendChild(sv);

			// label + description
			const text = append(item, $(".mode-item-text"));
			append(text, $("span.mode-item-label", undefined, opt.label));
			append(text, $("span.mode-item-tooltip", undefined, opt.description));

			if (!isDisabled) {
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeModeDropdown();
						if (opt.id !== this._chatMode) {
							this._chatMode = opt.id;
							this._onChangeMode?.(opt.id);
							this._render();
						}
					}),
				);
			}
		}

		this._registerOutsideClickClose(this._modeDropdownEl, this._modeTrigger, () => this._closeModeDropdown());
	}

	private _closeModeDropdown(): void {
		if (this._modeDropdownEl) {
			this._modeDropdownEl.remove();
			this._modeDropdownEl = null;
		}
		if (this._modeTrigger) { this._modeTrigger.classList.remove('open'); }
	}

	// =========================================================
	// Provider dropdown (composer)
	// =========================================================

	private _openProviderDropdown(): void {
		this._closeAllDropdowns();
		if (this._providerTrigger) { this._providerTrigger.classList.add('open'); }

		this._providerDropdownEl = append(mainWindow.document.body, $(".provider-dropdown"));
		this._positionDropdownAbove(this._providerDropdownEl, this._providerTrigger);

		if (this._providers.length === 0) {
			append(this._providerDropdownEl, $(".provider-dropdown-empty", undefined, '暂无可用 Provider'));
		} else {
			for (const p of this._providers) {
				const item = append(this._providerDropdownEl, $(`.provider-dropdown-item${this._currentProvider === p.id ? '.active' : ''}`));
				append(item, $("span.provider-dropdown-name", undefined, p.label));
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeProviderDropdown();
						if (p.id !== this._currentProvider) {
							this._currentProvider = p.id;
							this._onSelectProvider?.(p.id);
							this._render();
						}
					}),
				);
			}
		}

		this._registerOutsideClickClose(this._providerDropdownEl, this._providerTrigger, () => this._closeProviderDropdown());
	}

	private _closeProviderDropdown(): void {
		if (this._providerDropdownEl) {
			this._providerDropdownEl.remove();
			this._providerDropdownEl = null;
		}
		if (this._providerTrigger) { this._providerTrigger.classList.remove('open'); }
	}

	// =========================================================
	// Model dropdown (composer)
	// =========================================================

	private _openModelDropdown(): void {
		this._closeAllDropdowns();
		if (this._modelTrigger) { this._modelTrigger.classList.add('open'); }

		this._modelDropdownEl = append(mainWindow.document.body, $(".provider-dropdown.model-dropdown"));
		this._positionDropdownAbove(this._modelDropdownEl, this._modelTrigger);

		// Filter models by current provider when set
		const filtered = this._currentProvider
			? this._models.filter(m => !m.provider || m.provider === this._currentProvider)
			: this._models;

		if (filtered.length === 0) {
			append(this._modelDropdownEl, $(".provider-dropdown-empty", undefined, '暂无可用模型'));
		} else {
			for (const m of filtered) {
				const item = append(this._modelDropdownEl, $(`.provider-dropdown-item${this._currentModel === m.id ? '.active' : ''}`));
				append(item, $("span.provider-dropdown-name", undefined, m.label));
				if (m.provider) {
					append(item, $("span.provider-dropdown-detail", undefined, m.provider));
				}
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeModelDropdown();
						if (m.id !== this._currentModel) {
							this._currentModel = m.id;
							this._onSelectModel?.(m.id);
							this._render();
						}
					}),
				);
			}
		}

		this._registerOutsideClickClose(this._modelDropdownEl, this._modelTrigger, () => this._closeModelDropdown());
	}

	private _closeModelDropdown(): void {
		if (this._modelDropdownEl) {
			this._modelDropdownEl.remove();
			this._modelDropdownEl = null;
		}
		if (this._modelTrigger) { this._modelTrigger.classList.remove('open'); }
	}

	// =========================================================
	// History overlay
	// =========================================================

	private _renderHistoryOverlay(): void {
		this._historyOverlayEl = append(this._container, $(".chat-history-overlay"));
		this._renderHistoryOverlayContent();
	}

	private _renderHistoryOverlayContent(): void {
		if (!this._historyOverlayEl) { return; }
		clearNode(this._historyOverlayEl);

		// Header (close button + title)
		const header = append(this._historyOverlayEl, $(".chat-history-header"));
		const closeBtn = append(header, $("button.chat-history-close-btn"));
		closeBtn.title = '关闭';
		const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		closeSvg.setAttribute('width', '16');
		closeSvg.setAttribute('height', '16');
		closeSvg.setAttribute('viewBox', '0 0 24 24');
		closeSvg.setAttribute('fill', 'none');
		closeSvg.setAttribute('stroke', 'currentColor');
		closeSvg.setAttribute('stroke-width', '2');
		closeSvg.setAttribute('stroke-linecap', 'round');
		closeSvg.setAttribute('stroke-linejoin', 'round');
		const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		closePath.setAttribute('d', 'M18 6L6 18M6 6l12 12');
		closeSvg.appendChild(closePath);
		closeBtn.appendChild(closeSvg);
		this._register(
			addDisposableListener(closeBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = null;
				this._render();
			}),
		);
		append(header, $("span.chat-history-title", undefined, '聊天历史'));

		// Content area (list or empty)
		const content = append(this._historyOverlayEl, $(".chat-history-content"));
		if (this._agentSessions.length === 0) {
			append(content, $(".chat-history-empty", undefined, '当前 Agent 暂无历史会话'));
		} else {
			const list = append(content, $(".chat-history-list"));
			for (const s of this._agentSessions) {
				const item = append(list, $(".chat-history-item"));
				const info = append(item, $(".chat-history-item-info"));
				append(info, $("span.chat-history-item-name", undefined, s.name));
				const time = append(info, $("span.chat-history-item-time"));
				time.textContent = this._formatRelativeTime(s.updatedAt);

				const actions = append(item, $(".chat-history-item-actions"));
				const renameBtn = append(actions, $("button.chat-history-item-btn"));
				renameBtn.title = '重命名';
				// Rename icon (pencil)
				const renameSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
				renameSvg.setAttribute('width', '14');
				renameSvg.setAttribute('height', '14');
				renameSvg.setAttribute('viewBox', '0 0 24 24');
				renameSvg.setAttribute('fill', 'none');
				renameSvg.setAttribute('stroke', 'currentColor');
				renameSvg.setAttribute('stroke-width', '2');
				renameSvg.setAttribute('stroke-linecap', 'round');
				renameSvg.setAttribute('stroke-linejoin', 'round');
				const renamePath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				renamePath1.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
				const renamePath2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				renamePath2.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z');
				renameSvg.appendChild(renamePath1);
				renameSvg.appendChild(renamePath2);
				renameBtn.appendChild(renameSvg);
				this._register(
					addDisposableListener(renameBtn, EventType.CLICK, (e) => {
						e.stopPropagation();
						const next = mainWindow.prompt('新的会话名称', s.name);
						if (next && next.trim() && next.trim() !== s.name) {
							this._onRenameSession?.(s.id, next.trim());
						}
					}),
				);
				const delBtn = append(actions, $("button.chat-history-item-btn delete-btn"));
				delBtn.title = '删除';
				// Delete icon (trash)
				const delSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
				delSvg.setAttribute('width', '14');
				delSvg.setAttribute('height', '14');
				delSvg.setAttribute('viewBox', '0 0 24 24');
				delSvg.setAttribute('fill', 'none');
				delSvg.setAttribute('stroke', 'currentColor');
				delSvg.setAttribute('stroke-width', '2');
				delSvg.setAttribute('stroke-linecap', 'round');
				delSvg.setAttribute('stroke-linejoin', 'round');
				const delPath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				delPath1.setAttribute('d', 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
				delSvg.appendChild(delPath1);
				delBtn.appendChild(delSvg);
				this._register(
					addDisposableListener(delBtn, EventType.CLICK, (e) => {
						e.stopPropagation();
						if (mainWindow.confirm(`确认删除会话「${s.name}」?`)) {
							this._onDeleteSession?.(s.id);
						}
					}),
				);

				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._activeHeaderPanel = null;
						this._onOpenSession?.(s.id);
						this._render();
					}),
				);
			}
		}

		// Footer (new session button)
		const footer = append(this._historyOverlayEl, $(".chat-history-footer"));
		const newBtn = append(footer, $("button.chat-history-new-btn"));
		newBtn.textContent = '+ 新建对话';
		this._register(
			addDisposableListener(newBtn, EventType.CLICK, () => {
				this._onNewSession?.();
			}),
		);
	}

	private _formatRelativeTime(iso: string): string {
		try {
			const t = new Date(iso).getTime();
			const diff = Date.now() - t;
			const mins = Math.floor(diff / 60000);
			if (mins < 1) { return '刚刚'; }
			if (mins < 60) { return `${mins} 分钟前`; }
			const hours = Math.floor(mins / 60);
			if (hours < 24) { return `${hours} 小时前`; }
			const days = Math.floor(hours / 24);
			if (days < 30) { return `${days} 天前`; }
			return new Date(iso).toLocaleDateString('zh-CN');
		} catch {
			return iso;
		}
	}

	// =========================================================
	// Dropdown helpers
	// =========================================================

	private _positionDropdownBelow(el: HTMLElement, trigger: HTMLElement | null, rightAlign = false): void {
		if (!trigger) { return; }
		const rect = trigger.getBoundingClientRect();
		el.style.position = 'fixed';
		el.style.top = (rect.bottom + 4) + 'px';
		if (rightAlign) {
			el.style.right = (mainWindow.innerWidth - rect.right) + 'px';
		} else {
			el.style.left = rect.left + 'px';
		}
		el.style.minWidth = Math.max(220, rect.width) + 'px';
		el.style.zIndex = '10000';
	}

	private _positionDropdownAbove(el: HTMLElement, trigger: HTMLElement | null): void {
		if (!trigger) { return; }
		const rect = trigger.getBoundingClientRect();
		el.style.position = 'fixed';
		el.style.bottom = (mainWindow.innerHeight - rect.top + 6) + 'px';
		el.style.left = rect.left + 'px';
		el.style.minWidth = Math.max(180, rect.width) + 'px';
		el.style.zIndex = '10000';
	}

	private _registerOutsideClickClose(panel: HTMLElement, trigger: HTMLElement | null, onClose: () => void): void {
		const handler = addDisposableListener(mainWindow.document.body, EventType.CLICK, (e: MouseEvent) => {
			if (panel.contains(e.target as Node)) { return; }
			if (trigger && trigger.contains(e.target as Node)) { return; }
			onClose();
		});
		this._register(handler);
	}

	// Actions

	private _handleSendMessage(): void {
		const text = this._textarea?.value?.trim();
		if (!text || this._isSending) {
			return;
		}

		// Get explicit skill IDs from skill chips
		const explicitSkillIds = this._skillChips.length > 0 ? this._skillChips.map(c => c.id) : undefined;

		// Clear textarea and skill chips
		this._textarea.value = "";
		this._textarea.style.height = "auto";
		// 重新计算高度（考虑用户是否调整过高度）
		const maxAllowed = 500;
		const newHeight = this._userHasAdjustedHeight
			? Math.min(Math.max(this._textarea.scrollHeight, this._resizeMaxH), maxAllowed)
			: Math.min(this._textarea.scrollHeight, this._resizeMaxH);
		this._textarea.style.height = newHeight + 'px';
		this._skillChips = [];
		this._renderSkillChips();

		// Send message with skill IDs
		this._onSendMessage(text, explicitSkillIds);
	}

	// ─── Orchestration Plan Dialog ─────────────────────────────────────

	public closeOrchestrationPlanDialog(): void {
		if (this._orchestrationPlanEl) {
			this._orchestrationPlanEl.remove();
			this._orchestrationPlanEl = null;
		}
		this._isPlanDialogOpen = false;
		this._activePlan = null;
	}

	public showOrchestrationPlanDialog(plan: OrchestrationPlan): void {
		// If dialog is already open for the same plan, just update it
		if (this._isPlanDialogOpen && this._activePlan?.id === plan.id) {
			// Close existing dialog and reopen with new data
			this.closeOrchestrationPlanDialog();
		}

		this._activePlan = plan;
		this._isPlanDialogOpen = true;

		// Remove existing dialog if any
		if (this._orchestrationPlanEl) {
			this._orchestrationPlanEl.remove();
		}

		// Create dialog overlay
		const overlay = document.createElement('div');
		overlay.className = 'orch-plan-overlay';

		// Create dialog content
		const dialog = document.createElement('div');
		dialog.className = 'orch-plan-dialog';

		// ─── Dialog Header ─────────────────────────────────────────────
		const header = document.createElement('div');
		header.className = 'orch-dialog-header';

		const title = document.createElement('h3');
		title.textContent = '任务编排';
		header.appendChild(title);

		// Plan status badge
		const statusConfig: Record<string, { label: string; color: string }> = {
			pending_approval: { label: '等待确认', color: '#f59e0b' },
			approved: { label: '已批准', color: '#3b82f6' },
			executing: { label: '执行中', color: '#3b82f6' },
			completed: { label: '已完成', color: '#10b981' },
			rejected: { label: '已拒绝', color: '#6b7280' },
			error: { label: '执行错误', color: '#ef4444' },
		};
		const planStatus = statusConfig[plan.status] || { label: plan.status, color: '#6b7280' };
		const statusBadge = document.createElement('span');
		statusBadge.className = 'orch-plan-status-badge';
		statusBadge.style.backgroundColor = planStatus.color + '20';
		statusBadge.style.color = planStatus.color;
		statusBadge.textContent = planStatus.label;
		header.appendChild(statusBadge);

		// Close button
		const closeBtn = document.createElement('button');
		closeBtn.className = 'orch-inline-close';
		closeBtn.textContent = '✕';
		closeBtn.onclick = () => {
			overlay.remove();
			this._isPlanDialogOpen = false;
			this._activePlan = null;
			this._onClosePlanDialog?.(plan.id);
		};
		header.appendChild(closeBtn);
		dialog.appendChild(header);

		// ─── Plan Summary ──────────────────────────────────────────────
		const summary = document.createElement('div');
		summary.className = 'orch-plan-summary';

		// Goal
		const goalDiv = document.createElement('div');
		goalDiv.className = 'orch-plan-goal';
		goalDiv.style.display = 'flex';
		goalDiv.style.alignItems = 'center';
		goalDiv.style.gap = '8px';
		const goalText = document.createElement('span');
		append(goalText, $('strong', undefined, '目标:'));
		goalText.append(` ${plan.goal}`);
		goalDiv.appendChild(goalText);
		// Edit goal button (only for pending_approval plans)
		if (plan.status === 'pending_approval') {
			const editGoalBtn = document.createElement('button');
			editGoalBtn.textContent = '✏️';
			editGoalBtn.title = '编辑目标';
			editGoalBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;';
			editGoalBtn.onclick = () => this._showEditGoalForm(plan);
			goalDiv.appendChild(editGoalBtn);
		}
		summary.appendChild(goalDiv);

		// Description
		if (plan.summary) {
			const descDiv = document.createElement('div');
			descDiv.className = 'orch-plan-desc';
			descDiv.textContent = plan.summary;
			summary.appendChild(descDiv);
		}

		// Stats
		const statsDiv = document.createElement('div');
		statsDiv.className = 'orch-plan-stats';
		const totalTasks = plan.tasks.length;
		const doneTasks = plan.tasks.filter(t => t.status === 'done').length;
		const runningTasks = plan.tasks.filter(t => t.status === 'running').length;
		const pendingTasks = plan.tasks.filter(t => t.status === 'pending').length;
		append(statsDiv, $('span.orch-stat', undefined, `📋 ${totalTasks} 任务`));
		if (runningTasks > 0) {
			statsDiv.append(' ');
			append(statsDiv, $('span.orch-stat', undefined, `⚡ ${runningTasks} 执行中`));
		}
		if (doneTasks > 0) {
			statsDiv.append(' ');
			append(statsDiv, $('span.orch-stat', undefined, `✅ ${doneTasks} 完成`));
		}
		if (pendingTasks > 0) {
			statsDiv.append(' ');
			append(statsDiv, $('span.orch-stat', undefined, `⏳ ${pendingTasks} 待执行`));
		}
		summary.appendChild(statsDiv);
		dialog.appendChild(summary);

		// ─── Task List ─────────────────────────────────────────────────
		const taskListContainer = document.createElement('div');
		taskListContainer.className = 'orch-task-list';

		// Task status config
		const taskStatusConfig: Record<string, { label: string; color: string; icon: string }> = {
			pending: { label: '待执行', color: '#f59e0b', icon: '⏳' },
			running: { label: '执行中', color: '#3b82f6', icon: '⚡' },
			paused: { label: '已暂停', color: '#8b5cf6', icon: '⏸' },
			done: { label: '已完成', color: '#10b981', icon: '✅' },
			cancelled: { label: '已取消', color: '#6b7280', icon: '⏹' },
			error: { label: '错误', color: '#ef4444', icon: '❌' },
		};

		// Sort tasks by depth and priority
		const sortedTasks = [...plan.tasks].sort((a, b) => a.depth - b.depth || a.priority - b.priority);

		for (const task of sortedTasks) {
			const taskEl = document.createElement('div');
			taskEl.className = 'orch-task-item';
			taskEl.style.marginLeft = `${task.depth * 24}px`;

			// Task header
			const taskHeader = document.createElement('div');
			taskHeader.className = 'orch-task-item-header';

			const statusConf = taskStatusConfig[task.status] || taskStatusConfig.pending;
			const statusIcon = document.createElement('span');
			statusIcon.className = 'orch-task-status-icon';
			statusIcon.textContent = statusConf.icon;
			statusIcon.style.color = statusConf.color;
			taskHeader.appendChild(statusIcon);

			const taskTitle = document.createElement('span');
			taskTitle.className = 'orch-task-title';
			taskTitle.textContent = task.title;
			taskHeader.appendChild(taskTitle);

			const taskStatusBadge = document.createElement('span');
			taskStatusBadge.className = 'orch-task-status-badge';
			taskStatusBadge.style.backgroundColor = statusConf.color + '20';
			taskStatusBadge.style.color = statusConf.color;
			taskStatusBadge.textContent = statusConf.label;
			taskHeader.appendChild(taskStatusBadge);

			// Edit button (only for pending_approval plans)
			if (plan.status === 'pending_approval') {
				const editBtn = document.createElement('button');
				editBtn.className = 'orch-task-header-btn';
				editBtn.textContent = '✏️';
				editBtn.title = '编辑任务';
				editBtn.onclick = () => this._showEditTaskForm(task, plan);
				taskHeader.appendChild(editBtn);

				// Decompose button
				const decomposeBtn = document.createElement('button');
				decomposeBtn.className = 'orch-task-header-btn';
				decomposeBtn.textContent = '🔀';
				decomposeBtn.title = 'AI 自动拆分任务';
				decomposeBtn.onclick = () => this._onDecomposeTask?.(plan.id, task.id);
				taskHeader.appendChild(decomposeBtn);
			}

			taskEl.appendChild(taskHeader);

			// Task description
			if (task.description && task.description !== task.title) {
				const taskDesc = document.createElement('div');
				taskDesc.className = 'orch-task-desc';
				taskDesc.textContent = task.description.length > 120 ? task.description.slice(0, 120) + '...' : task.description;
				taskEl.appendChild(taskDesc);
			}

			// Task meta
			const taskMeta = document.createElement('div');
			taskMeta.className = 'orch-task-meta';

			if (task.assigneeName) {
				const agentSpan = document.createElement('span');
				agentSpan.className = 'orch-task-agent';
				agentSpan.textContent = `${task.autoCreateAgent ? '🆕 ' : ''}${task.assigneeName}`;
				taskMeta.appendChild(agentSpan);
			}

			// Retry count
			if (task.retryCount > 0) {
				const retrySpan = document.createElement('span');
				retrySpan.className = 'orch-task-retry-badge';
				retrySpan.textContent = `🔄 ${task.retryCount}/${task.maxRetries}`;
				taskMeta.appendChild(retrySpan);
			}

			taskEl.appendChild(taskMeta);

			// Task error
			if (task.error) {
				const errorDiv = document.createElement('div');
				errorDiv.className = 'orch-task-error';
				errorDiv.textContent = `❌ ${task.error}`;
				taskEl.appendChild(errorDiv);
			}

			// Task actions (only show for executing plans)
			const isExecuting = plan.status === 'executing' || plan.status === 'approved';
			if (isExecuting) {
				const actionsDiv = document.createElement('div');
				actionsDiv.className = 'orch-task-actions';

				// Retry button (for error or cancelled tasks)
				if (task.status === 'error' || task.status === 'cancelled') {
					const retryBtn = document.createElement('button');
					retryBtn.className = 'orch-task-action-btn retry';
					retryBtn.textContent = '🔄 重做';
					retryBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'retry');
					actionsDiv.appendChild(retryBtn);
				}

				// Pause button (for running or pending tasks)
				if (task.status === 'running' || task.status === 'pending') {
					const pauseBtn = document.createElement('button');
					pauseBtn.className = 'orch-task-action-btn pause';
					pauseBtn.textContent = '⏸ 暂停';
					pauseBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'pause');
					actionsDiv.appendChild(pauseBtn);
				}

				// Resume button (for paused tasks)
				if (task.status === 'paused') {
					const resumeBtn = document.createElement('button');
					resumeBtn.className = 'orch-task-action-btn resume';
					resumeBtn.textContent = '▶ 恢复';
					resumeBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'resume');
					actionsDiv.appendChild(resumeBtn);
				}

				// Cancel button (for non-done/cancelled tasks)
				if (task.status !== 'done' && task.status !== 'cancelled') {
					const cancelBtn = document.createElement('button');
					cancelBtn.className = 'orch-task-action-btn cancel';
					cancelBtn.textContent = '✕ 取消';
					cancelBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'cancel');
					actionsDiv.appendChild(cancelBtn);
				}

				// Approve/Reject buttons (for done tasks with pending review)
				if (task.status === 'done' && task.reviewStatus === 'pending') {
					const approveBtn = document.createElement('button');
					approveBtn.className = 'orch-task-action-btn approve';
					approveBtn.textContent = '✅ 通过';
					approveBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'approve');
					actionsDiv.appendChild(approveBtn);

					const rejectBtn = document.createElement('button');
					rejectBtn.className = 'orch-task-action-btn reject';
					rejectBtn.textContent = '❌ 拒绝';
					rejectBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'reject');
					actionsDiv.appendChild(rejectBtn);
				}

				// Block/Unblock buttons
				if (!task.isBlocked && task.status !== 'done') {
					const blockBtn = document.createElement('button');
					blockBtn.className = 'orch-task-action-btn block';
					blockBtn.textContent = '🚫 阻塞';
					blockBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'block');
					actionsDiv.appendChild(blockBtn);
				}

				if (task.isBlocked) {
					const unblockBtn = document.createElement('button');
					unblockBtn.className = 'orch-task-action-btn unblock';
					unblockBtn.textContent = '🔓 解除';
					unblockBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'unblock');
					actionsDiv.appendChild(unblockBtn);
				}

				taskEl.appendChild(actionsDiv);
			}

			taskListContainer.appendChild(taskEl);
		}

		dialog.appendChild(taskListContainer);

		// ─── Plan Actions ──────────────────────────────────────────────
		const planActions = document.createElement('div');
		planActions.className = 'orch-plan-actions';

		const isPendingApproval = plan.status === 'pending_approval';
		const isExecutingOrApproved = plan.status === 'executing' || plan.status === 'approved';

		if (isPendingApproval) {
			// Approve button
			const approveBtn = document.createElement('button');
			approveBtn.className = 'btn-primary';
			approveBtn.textContent = '✅ 批准计划';
			approveBtn.onclick = () => {
				this._onApprovePlan?.(plan.id);
				overlay.remove();
			};
			planActions.appendChild(approveBtn);

			// Approve without execute button
			const approveWithoutExecBtn = document.createElement('button');
			approveWithoutExecBtn.className = 'btn-secondary';
			approveWithoutExecBtn.textContent = '批准但不执行';
			approveWithoutExecBtn.onclick = () => {
				this._onApproveWithoutExecute?.(plan.id);
				overlay.remove();
			};
			planActions.appendChild(approveWithoutExecBtn);

			// Reject button
			const rejectBtn = document.createElement('button');
			rejectBtn.className = 'btn-secondary';
			rejectBtn.textContent = '❌ 拒绝计划';
			rejectBtn.onclick = () => {
				this._onRejectPlan?.(plan.id);
				overlay.remove();
			};
			planActions.appendChild(rejectBtn);
		} else if (isExecutingOrApproved) {
			// Pause all button
			const pauseAllBtn = document.createElement('button');
			pauseAllBtn.className = 'btn-secondary';
			pauseAllBtn.textContent = '⏸ 暂停所有';
			pauseAllBtn.onclick = () => {
				// Pause all running tasks
				for (const task of plan.tasks) {
					if (task.status === 'running' || task.status === 'pending') {
						this._onTaskAction?.(plan.id, task.id, 'pause');
					}
				}
			};
			planActions.appendChild(pauseAllBtn);
		}

		dialog.appendChild(planActions);

		// ─── Assemble ──────────────────────────────────────────────────
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);
		this._orchestrationPlanEl = overlay;
	}

	// ─── Edit Task Form ──────────────────────────────────────────────

	private _showEditTaskForm(task: PlanTask, plan: OrchestrationPlan): void {
		// Create overlay for edit form
		const overlay = document.createElement('div');
		overlay.className = 'orch-edit-overlay';
		overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';

		// Create form dialog
		const dialog = document.createElement('div');
		dialog.className = 'orch-edit-dialog';
		dialog.style.cssText = 'background:#1e1e2e;color:#cdd6f4;padding:20px;border-radius:8px;max-width:500px;width:90%;';

		// Title
		const title = document.createElement('h4');
		title.textContent = '编辑任务';
		title.style.marginBottom = '15px';
		dialog.appendChild(title);

		// Form fields
		// Task title
		const titleLabel = document.createElement('label');
		titleLabel.textContent = '任务标题';
		titleLabel.style.display = 'block';
		titleLabel.style.marginBottom = '5px';
		dialog.appendChild(titleLabel);

		const titleInput = document.createElement('input');
		titleInput.type = 'text';
		titleInput.value = task.title;
		titleInput.style.cssText = 'width:100%;padding:8px;margin-bottom:15px;border:1px solid #333;border-radius:4px;background:#2a2a3e;color:#cdd6f4;';
		dialog.appendChild(titleInput);

		// Task description
		const descLabel = document.createElement('label');
		descLabel.textContent = '任务描述';
		descLabel.style.display = 'block';
		descLabel.style.marginBottom = '5px';
		dialog.appendChild(descLabel);

		const descTextarea = document.createElement('textarea');
		descTextarea.value = task.description || '';
		descTextarea.rows = 3;
		descTextarea.style.cssText = 'width:100%;padding:8px;margin-bottom:15px;border:1px solid #333;border-radius:4px;background:#2a2a3e;color:#cdd6f4;';
		dialog.appendChild(descTextarea);

		// Priority
		const priorityLabel = document.createElement('label');
		priorityLabel.textContent = '优先级';
		priorityLabel.style.display = 'block';
		priorityLabel.style.marginBottom = '5px';
		dialog.appendChild(priorityLabel);

		const prioritySelect = document.createElement('select');
		prioritySelect.style.cssText = 'width:100%;padding:8px;margin-bottom:15px;border:1px solid #333;border-radius:4px;background:#2a2a3e;color:#cdd6f4;';
		for (let i = 1; i <= 5; i++) {
			const option = document.createElement('option');
			option.value = i.toString();
			option.textContent = `${i} - ${i === 1 ? '最高' : i === 2 ? '高' : i === 3 ? '中' : i === 4 ? '低' : '最低'}`;
			if (i === task.priority) {
				option.selected = true;
			}
			prioritySelect.appendChild(option);
		}
		dialog.appendChild(prioritySelect);

		// Action buttons
		const actions = document.createElement('div');
		actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

		const cancelBtn = document.createElement('button');
		cancelBtn.textContent = '取消';
		cancelBtn.style.cssText = 'padding:8px 16px;background:transparent;border:1px solid #333;border-radius:4px;color:#cdd6f4;cursor:pointer;';
		cancelBtn.onclick = () => overlay.remove();
		actions.appendChild(cancelBtn);

		const saveBtn = document.createElement('button');
		saveBtn.textContent = '保存';
		saveBtn.style.cssText = 'padding:8px 16px;background:#10b981;border:none;border-radius:4px;color:white;cursor:pointer;';
		saveBtn.onclick = () => {
			const updates: Record<string, unknown> = {
				title: titleInput.value,
				description: descTextarea.value,
				priority: parseInt(prioritySelect.value, 10),
			};
			this._onUpdateTask?.(plan.id, task.id, updates);
			overlay.remove();
			// Refresh the plan dialog
			this.showOrchestrationPlanDialog(plan);
		};
		actions.appendChild(saveBtn);

		dialog.appendChild(actions);

		overlay.appendChild(dialog);
		document.body.appendChild(overlay);
	}

	// ─── Edit Goal Form ──────────────────────────────────────────

	private _showEditGoalForm(plan: OrchestrationPlan): void {
		// Create overlay for edit form
		const overlay = document.createElement('div');
		overlay.className = 'orch-edit-overlay';
		overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';

		// Create form dialog
		const dialog = document.createElement('div');
		dialog.className = 'orch-edit-dialog';
		dialog.style.cssText = 'background:#1e1e2e;color:#cdd6f4;padding:20px;border-radius:8px;max-width:500px;width:90%;';

		// Title
		const title = document.createElement('h4');
		title.textContent = '编辑计划目标';
		title.style.marginBottom = '15px';
		dialog.appendChild(title);

		// Goal textarea
		const goalTextarea = document.createElement('textarea');
		goalTextarea.value = plan.goal;
		goalTextarea.rows = 3;
		goalTextarea.style.cssText = 'width:100%;padding:8px;margin-bottom:15px;border:1px solid #333;border-radius:4px;background:#2a2a3e;color:#cdd6f4;';
		dialog.appendChild(goalTextarea);

		// Action buttons
		const actions = document.createElement('div');
		actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

		const cancelBtn = document.createElement('button');
		cancelBtn.textContent = '取消';
		cancelBtn.style.cssText = 'padding:8px 16px;background:transparent;border:1px solid #333;border-radius:4px;color:#cdd6f4;cursor:pointer;';
		cancelBtn.onclick = () => overlay.remove();
		actions.appendChild(cancelBtn);

		const saveBtn = document.createElement('button');
		saveBtn.textContent = '保存';
		saveBtn.style.cssText = 'padding:8px 16px;background:#10b981;border:none;border-radius:4px;color:white;cursor:pointer;';
		saveBtn.onclick = () => {
			const updates: Record<string, unknown> = {
				goal: goalTextarea.value,
			};
			if (this._onUpdatePlan) { this._onUpdatePlan(plan.id, updates); }
			overlay.remove();
			// Refresh the plan dialog
			this.showOrchestrationPlanDialog(plan);
		};
		actions.appendChild(saveBtn);

		dialog.appendChild(actions);

		overlay.appendChild(dialog);
		document.body.appendChild(overlay);
	}

	// ─── Utility ───────────────────────────────────────────────────────

	private _scrollToBottom(force: boolean): void {
		if (!this._messagesContainer) {
			return;
		}
		mainWindow.requestAnimationFrame(() => {
			this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
		});
	}

	// Layout

	layout(width: number, height: number): void {
		// The CSS flexbox handles layout automatically
	}

	// --- Attachments -------------------------------------

	private _handleFileSelection(): void {
		if (!this._fileInput?.files) { return; }
		this._addFiles(Array.from(this._fileInput.files));
		this._fileInput.value = ''; // reset so same file can be re-selected
	}

	private _addFiles(files: File[], isPasted = false): void {
		const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
		const MAX_FILE_SIZE = 30 * 1024 * 1024;  // 30MB per file
		const MAX_TOTAL_SIZE = 30 * 1024 * 1024; // 30MB total

		for (const file of files) {
			const isImage = file.type.startsWith('image/');
			const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;

			if (file.size > maxSize) {
				// eslint-disable-next-line no-console
				console.warn(`[AgentChatPanel] File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(0)}MB limit)`);
				continue;
			}

			if (isImage) {
				// Scale image before encoding
				this._resizeImage(file, 2048, 768).then(scaledDataUrl => {
					const base64 = scaledDataUrl.split(',')[1] || '';
					const att: IChatAttachment = {
						id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						type: 'image',
						name: file.name,
						mimeType: file.type || 'image/png',
						data: base64,
						size: file.size,
						isPasted,
					};
					const currentTotal = this._attachments.reduce((sum, a) => sum + a.size, 0);
					if (currentTotal + file.size > MAX_TOTAL_SIZE) { return; }
					this._attachments.push(att);
					this._renderAttachmentPreviews();
				}).catch(() => { /* ignore resize failures */ });
			} else {
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = reader.result as string;
					const base64 = dataUrl.split(',')[1] || '';
					const att: IChatAttachment = {
						id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						type: 'file',
						name: file.name,
						mimeType: file.type || 'application/octet-stream',
						data: base64,
						size: file.size,
						isPasted,
					};
					const currentTotal = this._attachments.reduce((sum, a) => sum + a.size, 0);
					if (currentTotal + file.size > MAX_TOTAL_SIZE) { return; }
					this._attachments.push(att);
					this._renderAttachmentPreviews();
				};
				reader.readAsDataURL(file);
			}
		}
	}

	/** Auto-scale image to max 2048x768, return data URL */
	private _resizeImage(file: File, maxWidth: number, maxHeight: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				let { width, height } = img;
				if (width <= maxWidth && height <= maxHeight) {
					// No scaling needed, return original via FileReader
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result as string);
					reader.onerror = reject;
					reader.readAsDataURL(file);
					return;
				}
				const ratio = Math.min(maxWidth / width, maxHeight / height);
				width = Math.round(width * ratio);
				height = Math.round(height * ratio);
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext('2d');
				if (!ctx) { reject(new Error('No canvas context')); return; }
				ctx.drawImage(img, 0, 0, width, height);
				resolve(canvas.toDataURL(file.type || 'image/png', 0.85));
			};
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

	private _renderAttachmentPreviews(): void {
		const bars = this._container.querySelectorAll('.chat-attachment-bar');
		for (const bar of bars) { clearNode(bar as HTMLElement); }
		if (!this._attachments.length) { return; }

		const bar = this._container.querySelector('.chat-attachment-bar') as HTMLElement;
		if (!bar) { return; }
		bar.style.display = 'flex';

		// Check if any image attachment and model doesn't support images
		const hasImage = this._attachments.some(a => a.type === 'image');
		const currentModelInfo = this._models.find(m => m.id === this._currentModel);
		const modelSupportsImages = currentModelInfo?.supportsImages ?? false;
		const showWarning = hasImage && !modelSupportsImages;

		for (const att of this._attachments) {
			const chip = append(bar, $('.chat-attachment-chip'));
			if (att.type === 'image') {
				const thumb = append(chip, $('img.chat-attachment-thumb')) as HTMLImageElement;
				thumb.src = `data:${att.mimeType};base64,${att.data}`;
				thumb.alt = att.name;
				// Add warning icon overlay if model doesn't support images
				if (!modelSupportsImages) {
					const warnOverlay = append(chip, $('.chat-attachment-warn-overlay'));
					warnOverlay.title = '当前模型不支持图片';
					const warnIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
					warnIcon.setAttribute('width', '14');
					warnIcon.setAttribute('height', '14');
					warnIcon.setAttribute('viewBox', '0 0 24 24');
					warnIcon.setAttribute('fill', 'currentColor');
					const warnPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
					warnPath.setAttribute('d', 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z');
					warnIcon.appendChild(warnPath);
					warnOverlay.appendChild(warnIcon);
				}
				// Lightbox on click
				this._register(addDisposableListener(thumb, EventType.CLICK, () => {
					this._showLightbox(thumb.src);
				}));
			} else {
				append(chip, $('span.chat-attachment-file-icon', undefined, '📄'));
			}
			append(chip, $('span.chat-attachment-name', undefined, att.name));

			const removeBtn = append(chip, $('span.chat-attachment-remove.codicon.codicon-close'));
			this._register(addDisposableListener(removeBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._attachments = this._attachments.filter(a => a.id !== att.id);
				this._renderAttachmentPreviews();
			}));
		}

		// Show warning text if model doesn't support images
		if (showWarning) {
			const warningEl = append(bar, $('.chat-attachment-warning'));
			warningEl.textContent = '当前模型不支持图片输入，图片附件将被忽略';
		}
	}

	// --- Lightbox (full-screen image preview) ---

	private _showLightbox(src: string): void {
		// Remove any existing lightbox
		document.querySelector('.chat-lightbox-overlay')?.remove();

		const overlay = document.createElement('div');
		overlay.className = 'chat-lightbox-overlay';

		const img = document.createElement('img');
		img.src = src;
		img.className = 'chat-lightbox-image';
		overlay.appendChild(img);

		const closeBtn = document.createElement('button');
		closeBtn.className = 'chat-lightbox-close';
		closeBtn.textContent = '✕';
		closeBtn.addEventListener('click', () => overlay.remove());
		overlay.appendChild(closeBtn);

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) { overlay.remove(); }
		});

		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { overlay.remove(); }
		}, { once: true });

		document.body.appendChild(overlay);
	}

	getAttachments(): ReadonlyArray<IChatAttachment> {
		return this._attachments;
	}

	clearAttachments(): void {
		this._attachments = [];
		this._renderAttachmentPreviews();
	}

	/** Inject a workflow/taskboard prompt into the textarea and auto-send it */
	injectPrompt(message: string): void {
		if (!this._textarea) { return; }
		this._textarea.value = message;
		this._textarea.dispatchEvent(new Event('input'));
		// Auto-send after a microtask so the textarea resize settles
		queueMicrotask(() => this._handleSendMessage());
	}

	override dispose(): void {
		this._closeAgentDropdown();
		this._abortController?.abort();

		// Dispose all markdown disposables to avoid leakage
		for (const disposable of this._markdownDisposables.values()) {
			disposable.dispose();
		}
		this._markdownDisposables.clear();

		super.dispose();
	}
}
