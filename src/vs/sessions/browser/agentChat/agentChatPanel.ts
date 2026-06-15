/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./media/agentChat.css";
import { Disposable } from "../../../base/common/lifecycle.js";
import {
	$,
	append,
	clearNode,
	addDisposableListener,
	EventType,
} from "../../../base/browser/dom.js";
import { mainWindow } from "../../../base/browser/window.js";
import {
	IAgentChatMessage,
	IToolCall,
	IAgentInfo,
	IProviderInfo,
	IModelInfo,
	STATUS_MAP,
	HeaderPanelType,
	AgentStatus,
	ChatMode,
	IModeOption,
	IWorktreeItem,
	ISessionInfo,
	IAgentSessionMeta,
	IContextUsage,
	ICheckpointInfo,
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
	private _scrollToTopBtn!: HTMLElement;
	private _sendBtn!: HTMLElement;
	private _checkpointBarContainer: HTMLElement | null = null;

	// -- State --
	private _messages: IAgentChatMessage[] = [];
	private _agent: IAgentInfo | null = null;
	private _isSending = false;
	private _showScrollBtn = false;
	private _showScrollTopBtn = false;
	private _autoOrchestrateEnabled = false;
	private _webSearchEnabled = false;
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
	private _checkpoint: ICheckpointInfo | null = null;
	private _checkpointFilesExpanded = false;

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

	// -- Callbacks --
	private readonly _onSendMessage: (text: string) => void;
	private readonly _onCancelExecution: () => void;
	private readonly _onSelectAgent: (id: string) => void;
	private readonly _onSelectWorktree?: (path: string) => void;
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

	constructor(opts: {
		onSendMessage: (text: string) => void;
		onCancelExecution: () => void;
		onToggleCollapse: () => void;
		onSelectAgent: (id: string) => void;
		onSelectWorktree?: (path: string) => void;
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
		this._messages = messages;
		this._renderMessages();
		this._scrollToBottom(false);
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
		}
	}

	setSending(sending: boolean): void {
		this._isSending = sending;
		this._updateSendButton();
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

	setContextUsage(usage: IContextUsage | null): void {
		this._contextUsage = usage;
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

		// 1. Message-nav (汉堡菜单 → 用户消息列表)
		this._msgNavTrigger = this._appendHeaderActionBtn(actions, {
			title: '跳转到用户消息',
			svgPath: 'M3 12h18M3 6h18M3 18h18',
		});
		if (this._activeHeaderPanel === 'message-nav') {
			this._msgNavTrigger.classList.add('active');
		}
		this._register(
			addDisposableListener(this._msgNavTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
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
				this._onNewSession?.();
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
			} else {
				const fallback = append(miniAvatar, $(".chat-agent-dropdown-item-avatar-fallback"));
				fallback.textContent = agent.name.charAt(0).toUpperCase();
			}

			// Name + role
			const itemInfo = append(item, $(".chat-agent-dropdown-item-info"));
			append(itemInfo, $(".chat-agent-dropdown-item-name", undefined, agent.name));
			const roleText = agent.role?.split(/[，,]/)[0] || "";
			append(itemInfo, $(".chat-agent-dropdown-item-role", undefined, roleText));

			// Click to select
			this._register(
				addDisposableListener(item, EventType.CLICK, (e) => {
					e.stopPropagation();
					this._closeAgentDropdown();
					if (agent.id !== this._agent?.id) {
						this._onSelectAgent(agent.id);
					}
				}),
			);
		}
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

		// Scroll listener — toggle top + bottom button visibility
		this._register(
			addDisposableListener(this._messagesContainer, EventType.SCROLL, () => {
				const el = this._messagesContainer;
				const nearBottom =
					el.scrollHeight - el.scrollTop - el.clientHeight < 60;
				const nearTop = el.scrollTop < 40;
				const showBottom = !nearBottom;
				const showTop = !nearTop;
				if (showBottom !== this._showScrollBtn) {
					this._showScrollBtn = showBottom;
					this._scrollToBottomBtn.style.display = showBottom ? "flex" : "none";
				}
				if (showTop !== this._showScrollTopBtn) {
					this._showScrollTopBtn = showTop;
					this._scrollToTopBtn.style.display = showTop ? "flex" : "none";
				}
			}),
		);

		// Scroll-to-top button
		this._scrollToTopBtn = append(this._messagesWrapper, $(".chat-scroll-top-btn"));
		this._scrollToTopBtn.style.display = "none";
		this._scrollToTopBtn.title = '滚动到顶部';
		const upSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		upSvg.setAttribute("width", "18");
		upSvg.setAttribute("height", "18");
		upSvg.setAttribute("viewBox", "0 0 24 24");
		upSvg.setAttribute("fill", "none");
		upSvg.setAttribute("stroke", "currentColor");
		upSvg.setAttribute("stroke-width", "2.5");
		upSvg.setAttribute("stroke-linecap", "round");
		upSvg.setAttribute("stroke-linejoin", "round");
		const upPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
		upPath.setAttribute("d", "M12 19V5M5 12l7-7 7 7");
		upSvg.appendChild(upPath);
		this._scrollToTopBtn.appendChild(upSvg);
		this._register(
			addDisposableListener(this._scrollToTopBtn, EventType.CLICK, () => {
				this._messagesContainer.scrollTop = 0;
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
		// For simplicity, re-render the full message list
		// Performance optimization can be done later with keyed updates
		this._renderMessages();
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

		// Step indicator
		if (!isUser && msg.currentStep && !msg.content) {
			const step = append(bubble, $(".step-indicator"));
			if (msg.currentStep === "call_llm") {
				step.innerHTML = '<span class="step-icon">...</span> 调用模型中...';
			} else if (msg.currentStep === "execute_tool") {
				step.innerHTML = '<span class="step-icon">T</span> 执行工具中...';
			} else {
				step.textContent = `${msg.currentStep}...`;
			}
		}

		// Tool calls
		if (!isUser && msg.toolCalls && msg.toolCalls.length > 0) {
			const section = append(bubble, $(".tool-calls-section"));
			for (const tc of msg.toolCalls) {
				section.appendChild(this._createToolCallCard(tc));
			}
		}

		// Content
		if (msg.content) {
			const contentEl = append(bubble, $(".message-content"));
			if (msg.isStreaming && !isUser) {
				// Streaming: plain text to avoid re-rendering markdown
				const span = append(contentEl, $("span.streaming-text"));
				span.textContent = msg.content;
			} else if (isUser) {
				// User: highlight @mentions
				this._renderUserContent(contentEl, msg.content);
			} else {
				// Assistant: simple markdown-like rendering (code blocks)
				this._renderAssistantContent(contentEl, msg.content);
			}
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

		// Body (initially collapsed)
		const body = $(".thinking-card-body");
		append(card, body);
		body.textContent = msg.thinking || (msg.isThinking ? "正在思考..." : "");
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
		const card = $(`.tool-call-card.${isRunning ? "running" : "completed"}`);

		// Header
		const header = $(".tool-call-header");
		append(card, header);
		const iconEl = append(header, $("span.tool-call-icon"));
		if (isRunning) {
			const spinner = append(iconEl, $("svg.tool-spinner"));
			spinner.setAttribute("width", "12");
			spinner.setAttribute("height", "12");
			spinner.setAttribute("viewBox", "0 0 24 24");
			spinner.setAttribute("fill", "none");
			spinner.setAttribute("stroke", "currentColor");
			spinner.setAttribute("stroke-width", "2.5");
			const spinPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			spinPath.setAttribute("d", "M21 12a9 9 0 11-6.219-8.56");
			spinner.appendChild(spinPath);
		} else {
			const checkSvg = append(iconEl, $("svg"));
			checkSvg.setAttribute("width", "12");
			checkSvg.setAttribute("height", "12");
			checkSvg.setAttribute("viewBox", "0 0 24 24");
			checkSvg.setAttribute("fill", "none");
			checkSvg.setAttribute("stroke", "currentColor");
			checkSvg.setAttribute("stroke-width", "2.5");
			const checkPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"polyline",
			);
			checkPath.setAttribute("points", "20 6 9 17 4 12");
			checkSvg.appendChild(checkPath);
		}
		append(header, $("span.tool-call-name", undefined, tc.name));
		const toggle = append(header, $("span.tool-call-toggle.collapsed"));
		toggle.textContent = "▼";

		// Body (initially collapsed)
		const body = $(".tool-call-body");
		append(card, body);
		body.style.display = "none";

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

	private _renderAssistantContent(parent: HTMLElement, content: string): void {
		// Simple code-block-aware rendering
		// Split by ``` code blocks
		const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = codeBlockRegex.exec(content)) !== null) {
			// Text before code block
			if (match.index > lastIndex) {
				const text = content.slice(lastIndex, match.index);
				this._renderInlineContent(parent, text);
			}
			// Code block
			const lang = match[1];
			const code = match[2].replace(/\n$/, "");
			const codeWrapper = append(parent, $(".chat-code-block"));
			if (lang) {
				const langLabel = append(codeWrapper, $(".chat-code-lang"));
				langLabel.textContent = lang;
			}
			const pre = append(codeWrapper, $("pre.chat-code-content"));
			pre.textContent = code;
			lastIndex = match.index + match[0].length;
		}

		// Remaining text
		if (lastIndex < content.length) {
			this._renderInlineContent(parent, content.slice(lastIndex));
		}
	}

	private _renderInlineContent(parent: HTMLElement, text: string): void {
		// Handle inline code and basic markdown
		const inlineCodeRegex = /`([^`]+)`/g;
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = inlineCodeRegex.exec(text)) !== null) {
			if (match.index > lastIndex) {
				append(parent, $("span")).textContent = text.slice(
					lastIndex,
					match.index,
				);
			}
			const code = append(parent, $("code.chat-inline-code"));
			code.textContent = match[1];
			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < text.length) {
			// Handle line breaks
			const lines = text.slice(lastIndex).split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (i > 0) {
					parent.appendChild(document.createElement("br"));
				}
				// Bold
				const boldRegex = /\*\*(.+?)\*\*/g;
				let boldMatch: RegExpExecArray | null;
				const line = lines[i];
				let lineEl: HTMLElement | null = null;
				let boldLastIdx = 0;

				while ((boldMatch = boldRegex.exec(line)) !== null) {
					if (!lineEl) {
						lineEl = append(parent, $("span"));
					}
					if (boldMatch.index > boldLastIdx) {
						append(lineEl, $("span")).textContent = line.slice(
							boldLastIdx,
							boldMatch.index,
						);
					}
					append(lineEl, $("strong")).textContent = boldMatch[1];
					boldLastIdx = boldMatch.index + boldMatch[0].length;
				}

				if (lineEl && boldLastIdx < line.length) {
					append(lineEl, $("span")).textContent = line.slice(boldLastIdx);
				} else if (!lineEl) {
					append(parent, $("span")).textContent = line;
				}
			}
		}
	}

	// Input area

	private _renderInputArea(): void {
		const emp = this._agent!;
		const inputArea = append(this._container, $(".chat-input-area"));

		// Composer box
		const composerBox = append(inputArea, $(".chat-composer-box"));

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

		// Auto-resize
		this._register(
			addDisposableListener(this._textarea, EventType.INPUT, () => {
				const t = this._textarea;
				t.style.height = "auto";
				t.style.height = Math.min(t.scrollHeight, 120) + "px";
			}),
		);

		// Enter to send
		this._register(
			addDisposableListener(
				this._textarea,
				EventType.KEY_DOWN,
				(e: KeyboardEvent) => {
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

		// Attach button
		this._appendToolbarBtn(leftToolbar, {
			title: "上传附件",
			svgPath:
				"M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13",
		});

		// Voice button
		this._appendToolbarBtn(leftToolbar, {
			title: "语音输入",
			svgPath:
				"M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8",
		});

		// Web search button
		const webSearchBtn = this._appendToolbarBtn(leftToolbar, {
			title: "联网搜索",
			svgPath:
				"M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z",
			hasLabel: true,
			label: "联网",
			extraSvg:
				'<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>',
		});
		if (this._webSearchEnabled) {
			webSearchBtn.classList.add("active");
		}
		this._register(
			addDisposableListener(webSearchBtn, EventType.CLICK, () => {
				this._webSearchEnabled = !this._webSearchEnabled;
				webSearchBtn.classList.toggle("active", this._webSearchEnabled);
			}),
		);

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
			label: this._currentProvider || "Provider",
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

		// Agent chip — toggles header agent dropdown
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

		// Model chip
		this._modelTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择模型",
			svgPath: "M4 17l6-6-6-6M12 19h8",
			hasLabel: true,
			label: this._currentModel || "Model",
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
					this._onCancelExecution();
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
			extraSvg?: string;
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

		// Extra SVG (like the globe for web search)
		if (opts.extraSvg) {
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
			wrapper.innerHTML = opts.extraSvg;
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
		fg.classList.add('ring-fg');
		svg.appendChild(fg);

		ringEl.appendChild(svg);
	}

	private _updateContextRing(): void {
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
							this._onSelectWorktree?.(wt.path);
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
		head.textContent = '用户消息';

		const list = append(this._msgNavDropdownEl, $(".chat-message-nav-dropdown-list"));
		const userMsgs = this._messages.filter(m => m.role === 'user');

		if (userMsgs.length === 0) {
			append(list, $(".chat-message-nav-empty", undefined, '当前对话还没有消息'));
		} else {
			for (let i = 0; i < userMsgs.length; i++) {
				const m = userMsgs[i];
				const item = append(list, $(".chat-message-nav-dropdown-item"));
				append(item, $("span.chat-message-nav-index", undefined, `#${i + 1}`));
				const summary = (m.content || '(空消息)').replace(/\s+/g, ' ').slice(0, 60);
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

		// Header
		const header = append(this._historyOverlayEl, $(".chat-history-header"));
		const back = append(header, $("button.chat-history-back-btn"));
		back.title = '返回';
		const backSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		backSvg.setAttribute('width', '16');
		backSvg.setAttribute('height', '16');
		backSvg.setAttribute('viewBox', '0 0 24 24');
		backSvg.setAttribute('fill', 'none');
		backSvg.setAttribute('stroke', 'currentColor');
		backSvg.setAttribute('stroke-width', '2.5');
		backSvg.setAttribute('stroke-linecap', 'round');
		backSvg.setAttribute('stroke-linejoin', 'round');
		const backPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		backPath.setAttribute('d', 'M19 12H5M12 19l-7-7 7-7');
		backSvg.appendChild(backPath);
		back.appendChild(backSvg);
		this._register(
			addDisposableListener(back, EventType.CLICK, () => {
				this._activeHeaderPanel = null;
				this._render();
			}),
		);
		append(header, $("span.chat-history-title", undefined, '聊天历史'));

		const newBtn = append(header, $("button.chat-history-new-btn"));
		newBtn.textContent = '新建';
		this._register(
			addDisposableListener(newBtn, EventType.CLICK, () => {
				this._onNewSession?.();
			}),
		);

		// List
		if (this._agentSessions.length === 0) {
			append(this._historyOverlayEl, $(".chat-history-empty", undefined, '当前 Agent 暂无历史会话'));
			return;
		}
		const list = append(this._historyOverlayEl, $(".chat-history-list"));
		for (const s of this._agentSessions) {
			const item = append(list, $(".chat-history-item"));
			const info = append(item, $(".chat-history-item-info"));
			append(info, $("span.chat-history-item-name", undefined, s.name));
			const meta = append(info, $("span.chat-history-item-meta"));
			meta.textContent = `${s.messageCount} 条消息 · ${this._formatRelativeTime(s.updatedAt)}`;

			const actions = append(item, $(".chat-history-item-actions"));
			const renameBtn = append(actions, $("button.chat-history-item-action"));
			renameBtn.textContent = '重命名';
			this._register(
				addDisposableListener(renameBtn, EventType.CLICK, (e) => {
					e.stopPropagation();
					const next = mainWindow.prompt('新的会话名称', s.name);
					if (next && next.trim() && next.trim() !== s.name) {
						this._onRenameSession?.(s.id, next.trim());
					}
				}),
			);
			const delBtn = append(actions, $("button.chat-history-item-action"));
			delBtn.textContent = '删除';
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

		this._textarea.value = "";
		this._textarea.style.height = "auto";
		this._onSendMessage(text);
	}

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

	override dispose(): void {
		this._closeAgentDropdown();
		this._abortController?.abort();
		super.dispose();
	}
}
