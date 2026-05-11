/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/employeeChat.css';
import { Disposable } from '../../../base/common/lifecycle.js';
import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import {
	IEmployeeChatMessage,
	IToolCall,
	IEmployeeInfo,
	IProviderInfo,
	IModelInfo,
	STATUS_MAP,
	HeaderPanelType,
	uniqueMsgId,
} from './employeeChatTypes.js';

// EmployeeChatPanel — Full chat panel matching sarosis-webui layout
//
// Structure:
//   .chat-container
//     .chat-header           ← avatar + name/status + toolbar buttons
//     .chat-messages-wrapper ← scrollable messages + scroll-to-bottom btn
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

export class EmployeeChatPanel extends Disposable {

	// ── DOM refs ──
	private readonly _container: HTMLElement;
	private _messagesContainer!: HTMLElement;
	private _messagesWrapper!: HTMLElement;
	private _textarea!: HTMLTextAreaElement;
	private _scrollToBottomBtn!: HTMLElement;
	private _sendBtn!: HTMLElement;

	// ── State ──
	private _messages: IEmployeeChatMessage[] = [];
	private _employee: IEmployeeInfo | null = null;
	private _isSending = false;
	private _showScrollBtn = false;
	private _autoOrchestrateEnabled = false;
	private _webSearchEnabled = false;
	private _currentProvider = '';
	private _currentModel = '';
	private _activeHeaderPanel: HeaderPanelType = null;
	private _abortController: AbortController | null = null;

	// ── Callbacks ──
	private readonly _onSendMessage: (text: string) => void;
	private readonly _onCancelExecution: () => void;
	private readonly _onToggleCollapse: () => void;

	constructor(
		opts: {
			onSendMessage: (text: string) => void;
			onCancelExecution: () => void;
			onToggleCollapse: () => void;
		}
	) {
		super();
		this._onSendMessage = opts.onSendMessage;
		this._onCancelExecution = opts.onCancelExecution;
		this._onToggleCollapse = opts.onToggleCollapse;
		this._container = $('.chat-container');
	}

	get element(): HTMLElement { return this._container; }

	// Public API

	setEmployee(employee: IEmployeeInfo | null): void {
		this._employee = employee;
		this._render();
	}

	setMessages(messages: IEmployeeChatMessage[]): void {
		this._messages = messages;
		this._renderMessages();
		this._scrollToBottom(false);
	}

	addMessage(message: IEmployeeChatMessage): void {
		this._messages.push(message);
		this._appendMessageDom(message);
		this._scrollToBottom(true);
	}

	updateMessage(messageId: string, updates: Partial<IEmployeeChatMessage>): void {
		const idx = this._messages.findIndex(m => m.id === messageId);
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
		// Provider list for dropdown — future expansion
	}

	setModels(models: IModelInfo[]): void {
		// Model list for dropdown — future expansion
	}

	setCurrentProvider(provider: string): void {
		this._currentProvider = provider;
	}

	setCurrentModel(model: string): void {
		this._currentModel = model;
	}

	focusInput(): void {
		this._textarea?.focus();
	}

	// Rendering — Full render

	private _render(): void {
		clearNode(this._container);

		if (!this._employee) {
			this._renderEmptyState();
			return;
		}

		// Chat header
		this._renderHeader();

		// Messages wrapper
		this._renderMessagesArea();

		// Input area
		this._renderInputArea();
	}

	// Empty state

	private _renderEmptyState(): void {
		const header = append(this._container, $('.chat-header'));
		append(header, $('h3.chat-header-title', undefined, '对话'));

		const empty = append(this._container, $('.chat-empty-state'));
		const svg = append(empty, $('svg.chat-empty-icon'));
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1.5');
		const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path1.setAttribute('d', 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z');
		svg.appendChild(path1);
		append(empty, $('p.chat-empty-text', undefined, '选择一个 Agent 开始对话'));
		append(empty, $('p.chat-empty-subtext', undefined, '点击画布或列表中的 Agent 卡片'));
	}

	// Chat Header

	private _renderHeader(): void {
		const emp = this._employee!;
		const statusInfo = STATUS_MAP[emp.status] || STATUS_MAP[EmployeeStatus.Idle];

		const header = append(this._container, $('.chat-header'));

		// Left: avatar + name/status
		const left = append(header, $('.chat-header-left'));

		// Avatar with status dot
		const avatarWrap = append(left, $('.chat-header-avatar-wrap'));
		const avatarBorder = append(avatarWrap, $('.chat-header-avatar-border'));
		if (emp.avatarUrl) {
			const img = append(avatarBorder, $('img.chat-header-avatar-img')) as HTMLImageElement;
			img.src = emp.avatarUrl;
			img.alt = emp.name;
		} else {
			const fallback = append(avatarBorder, $('.chat-header-avatar-fallback'));
			fallback.textContent = emp.name.charAt(0).toUpperCase();
		}
		const statusDot = append(avatarWrap, $('.chat-header-status-dot'));
		statusDot.style.backgroundColor = statusInfo.dot;
		if (statusInfo.animated) {
			statusDot.classList.add('animated');
		}

		// Name + role
		const info = append(left, $('.chat-header-info'));
		append(info, $('span.chat-header-name', undefined, emp.name));
		const roleText = emp.role?.split(/[，,]/)[0] || '';
		append(info, $('span.chat-header-role', undefined, `${roleText} · ${statusInfo.label}`));

		// Auto-orchestrate toggle (PM only)
		if (emp.isPM) {
			const orchBtn = append(left, $('.chat-header-action-btn.orchestrate'));
			orchBtn.title = this._autoOrchestrateEnabled
				? '自动编排模式已开启'
				: '自动编排模式已关闭';
			if (this._autoOrchestrateEnabled) {
				orchBtn.classList.add('active', 'orchestrate-active');
			}
			const orchSvg = append(orchBtn, $('svg'));
			orchSvg.setAttribute('width', '15');
			orchSvg.setAttribute('height', '15');
			orchSvg.setAttribute('viewBox', '0 0 24 24');
			orchSvg.setAttribute('fill', 'none');
			orchSvg.setAttribute('stroke', 'currentColor');
			orchSvg.setAttribute('stroke-width', '2');
			const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			circle.setAttribute('cx', '12');
			circle.setAttribute('cy', '12');
			circle.setAttribute('r', '3');
			orchSvg.appendChild(circle);
			const sunPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			sunPath.setAttribute('d', 'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83');
			orchSvg.appendChild(sunPath);
			this._register(addDisposableListener(orchBtn, EventType.CLICK, () => {
				this._autoOrchestrateEnabled = !this._autoOrchestrateEnabled;
				this._render();
			}));
		}

		// Spacer
		append(left, $('.chat-header-spacer'));

		// Right: toolbar buttons
		const actions = append(header, $('.chat-header-actions'));
		const toolButtons: { key: HeaderPanelType; title: string; svgPath: string }[] = [
			{ key: 'prompt',        title: '编辑提示词',    svgPath: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z' },
			{ key: 'condense-skill', title: '对话沉淀为技能', svgPath: 'M12 2 2 7 12 12 22 7 12 2M2 17 12 22 22 17M2 12 12 17 22 12' },
			{ key: 'skills',        title: '配置员工技能',    svgPath: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 012.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.65 1.65 0 001.82.33l.06.06a2 2 0 012.83-2.83l-.06-.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z' },
			{ key: 'config-html',   title: '配置页面',       svgPath: 'M3 3h18v18H3zM3 9h18M9 21V9' },
			{ key: 'params',        title: '配置参数',       svgPath: 'M4 21V14M4 10V3M12 21V12M12 8V3M20 21V16M20 12V3M1 14h7M9 8h6M17 16h6' },
			{ key: 'memory',        title: '员工记忆',       svgPath: 'M4 19.5A2.5 2.5 0 006.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z' },
		];

		for (const btn of toolButtons) {
			const el = append(actions, $('.chat-header-action-btn'));
			el.title = btn.title;
			if (this._activeHeaderPanel === btn.key) {
				el.classList.add('active');
			}
			const svg = append(el, $('svg'));
			svg.setAttribute('width', '15');
			svg.setAttribute('height', '15');
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor');
			svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round');
			svg.setAttribute('stroke-linejoin', 'round');
			const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			pathEl.setAttribute('d', btn.svgPath);
			svg.appendChild(pathEl);
			this._register(addDisposableListener(el, EventType.CLICK, () => {
				this._activeHeaderPanel = this._activeHeaderPanel === btn.key ? null : btn.key;
				this._render();
			}));
		}
	}

	// Messages area

	private _renderMessagesArea(): void {
		this._messagesWrapper = append(this._container, $('.chat-messages-wrapper'));
		this._messagesContainer = append(this._messagesWrapper, $('.chat-messages'));

		// Scroll listener
		this._register(addDisposableListener(this._messagesContainer, EventType.SCROLL, () => {
			const el = this._messagesContainer;
			const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
			if (nearBottom !== !this._showScrollBtn) {
				this._showScrollBtn = !nearBottom;
				this._scrollToBottomBtn.style.display = this._showScrollBtn ? 'flex' : 'none';
			}
		}));

		// Scroll-to-bottom button
		this._scrollToBottomBtn = append(this._messagesWrapper, $('.scroll-to-bottom-btn'));
		this._scrollToBottomBtn.style.display = 'none';
		const svg = append(this._scrollToBottomBtn, $('svg'));
		svg.setAttribute('width', '20');
		svg.setAttribute('height', '20');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2.5');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M12 5v14M5 12l7 7 7-7');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
		this._register(addDisposableListener(this._scrollToBottomBtn, EventType.CLICK, () => {
			this._scrollToBottom(true);
			this._showScrollBtn = false;
			this._scrollToBottomBtn.style.display = 'none';
		}));

		// Render existing messages
		this._renderMessages();
	}

	private _renderMessages(): void {
		if (!this._messagesContainer) { return; }
		clearNode(this._messagesContainer);

		if (this._messages.length === 0) {
			const empty = append(this._messagesContainer, $('.chat-messages-empty'));
			append(empty, $('p', undefined, '还没有消息，开始对话吧'));
			return;
		}

		for (const msg of this._messages) {
			this._appendMessageDom(msg);
		}
	}

	private _appendMessageDom(msg: IEmployeeChatMessage): void {
		if (!this._messagesContainer) { return; }
		const el = this._createMessageElement(msg);
		this._messagesContainer.appendChild(el);
	}

	private _updateMessageDom(idx: number, msg: IEmployeeChatMessage): void {
		// For simplicity, re-render the full message list
		// Performance optimization can be done later with keyed updates
		this._renderMessages();
	}

	// Message element builder

	private _createMessageElement(msg: IEmployeeChatMessage): HTMLElement {
		const isUser = msg.role === 'user';
		const messageEl = $(`.chat-message.${isUser ? 'user' : 'assistant'}`);

		// Assistant avatar
		if (!isUser && this._employee) {
			const avatarWrap = append(messageEl, $('.chat-message-avatar'));
			if (this._employee.avatarUrl) {
				const img = append(avatarWrap, $('img')) as HTMLImageElement;
				img.src = this._employee.avatarUrl;
				img.alt = this._employee.name;
				img.style.width = '100%';
				img.style.height = '100%';
				img.style.objectFit = 'cover';
				img.style.borderRadius = '50%';
			} else {
				const fallback = append(avatarWrap, $('.chat-avatar-fallback'));
				fallback.textContent = this._employee.name.charAt(0).toUpperCase();
			}
		}

		// Bubble
		const bubble = append(messageEl, $(`.chat-bubble.${isUser ? 'user' : 'assistant'}`));

		// Thinking card (assistant only)
		if (!isUser && (msg.thinking || msg.isThinking)) {
			bubble.appendChild(this._createThinkingCard(msg));
		}

		// Step indicator
		if (!isUser && msg.currentStep && !msg.content) {
			const step = append(bubble, $('.step-indicator'));
			if (msg.currentStep === 'call_llm') {
				step.innerHTML = '<span class="step-icon">🧠</span> 调用模型中...';
			} else if (msg.currentStep === 'execute_tool') {
				step.innerHTML = '<span class="step-icon">🔧</span> 执行工具中...';
			} else {
				step.textContent = `${msg.currentStep}...`;
			}
		}

		// Tool calls
		if (!isUser && msg.toolCalls && msg.toolCalls.length > 0) {
			const section = append(bubble, $('.tool-calls-section'));
			for (const tc of msg.toolCalls) {
				section.appendChild(this._createToolCallCard(tc));
			}
		}

		// Content
		if (msg.content) {
			const contentEl = append(bubble, $('.message-content'));
			if (msg.isStreaming && !isUser) {
				// Streaming: plain text to avoid re-rendering markdown
				const span = append(contentEl, $('span.streaming-text'));
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
			append(bubble, $('span.streaming-cursor')).textContent = '▊';
		}

		// Footer: time + tokens
		const footer = append(bubble, $('.chat-bubble-footer'));
		const time = append(footer, $('span.chat-bubble-time'));
		time.textContent = new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
			hour: '2-digit',
			minute: '2-digit',
		});
		if (!isUser && msg.tokenUsage && msg.tokenUsage.total > 0) {
			const tokens = append(footer, $('span.chat-bubble-tokens'));
			tokens.textContent = `${msg.tokenUsage.total} tokens`;
			tokens.title = `输入: ${msg.tokenUsage.input} / 输出: ${msg.tokenUsage.output}`;
		}

		return messageEl;
	}

	// ── Thinking card ─────────────────────────────────────────────

	private _createThinkingCard(msg: IEmployeeChatMessage): HTMLElement {
		const card = append($(`.thinking-card${msg.isThinking ? '.active' : ''}`), '');

		// Header
		const header = append(card, $('.thinking-card-header'));
		const icon = append(header, $('span.thinking-card-icon'));
		if (msg.isThinking) {
			const spinnerSvg = append(icon, $('svg.thinking-spinner'));
			spinnerSvg.setAttribute('width', '14');
			spinnerSvg.setAttribute('height', '14');
			spinnerSvg.setAttribute('viewBox', '0 0 24 24');
			spinnerSvg.setAttribute('fill', 'none');
			spinnerSvg.setAttribute('stroke', 'currentColor');
			spinnerSvg.setAttribute('stroke-width', '2');
			const spinPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			spinPath.setAttribute('d', 'M21 12a9 9 0 11-6.219-8.56');
			spinnerSvg.appendChild(spinPath);
		} else {
			icon.textContent = '💭';
		}
		append(header, $('span.thinking-card-title', undefined, msg.isThinking ? '思考中...' : '思考过程'));
		const toggle = append(header, $('span.thinking-card-toggle.collapsed'));
		toggle.textContent = '▼';

		// Body (initially collapsed)
		const body = append(card, $('.thinking-card-body'));
		body.textContent = msg.thinking || (msg.isThinking ? '正在思考...' : '');
		body.style.display = 'none';

		// Toggle click
		let collapsed = true;
		this._register(addDisposableListener(header, EventType.CLICK, () => {
			collapsed = !collapsed;
			body.style.display = collapsed ? 'none' : 'block';
			toggle.classList.toggle('collapsed', collapsed);
		}));

		return card;
	}

	// ── Tool call card ─────────────────────────────────────────────

	private _createToolCallCard(tc: IToolCall): HTMLElement {
		const isRunning = tc.status === 'running';
		const card = $(`.tool-call-card.${isRunning ? 'running' : 'completed'}`);

		// Header
		const header = append(card, $('.tool-call-header'));
		const iconEl = append(header, $('span.tool-call-icon'));
		if (isRunning) {
			const spinner = append(iconEl, $('svg.tool-spinner'));
			spinner.setAttribute('width', '12');
			spinner.setAttribute('height', '12');
			spinner.setAttribute('viewBox', '0 0 24 24');
			spinner.setAttribute('fill', 'none');
			spinner.setAttribute('stroke', 'currentColor');
			spinner.setAttribute('stroke-width', '2.5');
			const spinPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			spinPath.setAttribute('d', 'M21 12a9 9 0 11-6.219-8.56');
			spinner.appendChild(spinPath);
		} else {
			const checkSvg = append(iconEl, $('svg'));
			checkSvg.setAttribute('width', '12');
			checkSvg.setAttribute('height', '12');
			checkSvg.setAttribute('viewBox', '0 0 24 24');
			checkSvg.setAttribute('fill', 'none');
			checkSvg.setAttribute('stroke', 'currentColor');
			checkSvg.setAttribute('stroke-width', '2.5');
			const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			checkPath.setAttribute('points', '20 6 9 17 4 12');
			checkSvg.appendChild(checkPath);
		}
		append(header, $('span.tool-call-name', undefined, tc.name));
		const toggle = append(header, $('span.tool-call-toggle.collapsed'));
		toggle.textContent = '▼';

		// Body (initially collapsed)
		const body = append(card, $('.tool-call-body'));
		body.style.display = 'none';

		if (tc.args) {
			try {
				const parsed = JSON.stringify(JSON.parse(tc.args), null, 2);
				if (parsed !== '{}') {
					const section = append(body, $('.tool-call-section'));
					append(section, $('div.tool-call-section-title', undefined, '参数'));
					const pre = append(section, $('pre.tool-call-code'));
					pre.textContent = parsed;
				}
			} catch {
				// not JSON, skip
			}
		}

		if (tc.result) {
			const section = append(body, $('.tool-call-section'));
			append(section, $('div.tool-call-section-title', undefined, '结果'));
			const pre = append(section, $('pre.tool-call-code'));
			try {
				pre.textContent = JSON.stringify(JSON.parse(tc.result), null, 2);
			} catch {
				pre.textContent = tc.result;
			}
		}

		// Toggle click
		let collapsed = true;
		this._register(addDisposableListener(header, EventType.CLICK, () => {
			collapsed = !collapsed;
			body.style.display = collapsed ? 'none' : 'block';
			toggle.classList.toggle('collapsed', collapsed);
		}));

		return card;
	}

	// ── Content renderers ──────────────────────────────────────────

	private _renderUserContent(parent: HTMLElement, content: string): void {
		// Highlight @mentions
		const parts = content.split(/(@[\w\u4e00-\u9fff]+)/g);
		for (const part of parts) {
			if (part.startsWith('@') && part.length > 1) {
				const mention = append(parent, $('span.msg-mention'));
				mention.textContent = part;
			} else {
				append(parent, $('span')).textContent = part;
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
			const code = match[2].replace(/\n$/, '');
			const codeWrapper = append(parent, $('.chat-code-block'));
			if (lang) {
				const langLabel = append(codeWrapper, $('.chat-code-lang'));
				langLabel.textContent = lang;
			}
			const pre = append(codeWrapper, $('pre.chat-code-content'));
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
				append(parent, $('span')).textContent = text.slice(lastIndex, match.index);
			}
			const code = append(parent, $('code.chat-inline-code'));
			code.textContent = match[1];
			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < text.length) {
			// Handle line breaks
			const lines = text.slice(lastIndex).split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (i > 0) {
					parent.appendChild(document.createElement('br'));
				}
				// Bold
				const boldRegex = /\*\*(.+?)\*\*/g;
				let boldMatch: RegExpExecArray | null;
				let line = lines[i];
				let lineEl: HTMLElement | null = null;
				let boldLastIdx = 0;

				while ((boldMatch = boldRegex.exec(line)) !== null) {
					if (!lineEl) {
						lineEl = append(parent, $('span'));
					}
					if (boldMatch.index > boldLastIdx) {
						append(lineEl, $('span')).textContent = line.slice(boldLastIdx, boldMatch.index);
					}
					append(lineEl, $('strong')).textContent = boldMatch[1];
					boldLastIdx = boldMatch.index + boldMatch[0].length;
				}

				if (lineEl && boldLastIdx < line.length) {
					append(lineEl, $('span')).textContent = line.slice(boldLastIdx);
				} else if (!lineEl) {
					append(parent, $('span')).textContent = line;
				}
			}
		}
	}

	// Input area

	private _renderInputArea(): void {
		const emp = this._employee!;
		const inputArea = append(this._container, $('.chat-input-area'));

		// Composer box
		const composerBox = append(inputArea, $('.chat-composer-box'));

		// Textarea
		this._textarea = append(composerBox, $('textarea.chat-composer-textarea')) as HTMLTextAreaElement;
		this._textarea.rows = 1;
		this._textarea.placeholder = emp.isPM && this._autoOrchestrateEnabled
			? '输入目标，自动创建团队并分派任务... (用 @name 手动指定员工)'
			: `Message ${emp.name}...`;
		this._textarea.disabled = this._isSending;

		// Auto-resize
		this._register(addDisposableListener(this._textarea, EventType.INPUT, () => {
			const t = this._textarea;
			t.style.height = 'auto';
			t.style.height = Math.min(t.scrollHeight, 120) + 'px';
		}));

		// Enter to send
		this._register(addDisposableListener(this._textarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._handleSendMessage();
			}
		}));

		// Toolbar
		const toolbar = append(composerBox, $('.chat-composer-toolbar'));
		const leftToolbar = append(toolbar, $('.chat-toolbar-left'));

		// Attach button
		this._appendToolbarBtn(leftToolbar, {
			title: '上传附件',
			svgPath: 'M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13',
		});

		// Voice button
		this._appendToolbarBtn(leftToolbar, {
			title: '语音输入',
			svgPath: 'M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8',
		});

		// Web search button
		const webSearchBtn = this._appendToolbarBtn(leftToolbar, {
			title: '联网搜索',
			svgPath: 'M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z',
			hasLabel: true,
			label: '联网',
			extraSvg: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>',
		});
		if (this._webSearchEnabled) {
			webSearchBtn.classList.add('active');
		}
		this._register(addDisposableListener(webSearchBtn, EventType.CLICK, () => {
			this._webSearchEnabled = !this._webSearchEnabled;
			webSearchBtn.classList.toggle('active', this._webSearchEnabled);
		}));

		// Divider
		append(leftToolbar, $('.chat-toolbar-divider'));

		// Provider chip
		const providerBtn = this._appendToolbarBtn(leftToolbar, {
			title: '选择 Provider',
			svgPath: 'M2 3h20v14H2zM8 21h8M12 17v4',
			hasLabel: true,
			label: this._currentProvider || 'Provider',
			showChevron: true,
			cssClass: 'provider-tag',
		});

		// Model chip
		const modelBtn = this._appendToolbarBtn(leftToolbar, {
			title: '选择模型',
			svgPath: 'M4 17l6-6-6-6M12 19h8',
			hasLabel: true,
			label: this._currentModel || 'Model',
			showChevron: true,
			cssClass: 'model-tag',
		});

		// Send / Cancel button
		this._sendBtn = append(toolbar, $(`.chat-send-circle${this._isSending ? '.chat-cancel-circle' : ''}`));
		this._renderSendButtonSvg();
		this._register(addDisposableListener(this._sendBtn, EventType.CLICK, () => {
			if (this._isSending) {
				this._onCancelExecution();
			} else {
				this._handleSendMessage();
			}
		}));
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
		}
	): HTMLElement {
		const btn = append(parent, $(`.chat-toolbar-btn${opts.hasLabel ? '.has-label' : ''}${opts.cssClass ? '.' + opts.cssClass : ''}`));
		btn.title = opts.title;

		// Extra SVG (like the globe for web search)
		if (opts.extraSvg) {
			const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			wrapper.setAttribute('width', '16');
			wrapper.setAttribute('height', '16');
			wrapper.setAttribute('viewBox', '0 0 24 24');
			wrapper.setAttribute('fill', 'none');
			wrapper.setAttribute('stroke', 'currentColor');
			wrapper.setAttribute('stroke-width', '2');
			wrapper.setAttribute('stroke-linecap', 'round');
			wrapper.setAttribute('stroke-linejoin', 'round');
			wrapper.innerHTML = opts.extraSvg;
			btn.appendChild(wrapper);
		}

		// Main SVG
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', opts.svgPath);
		svg.appendChild(path);
		btn.appendChild(svg);

		// Label
		if (opts.hasLabel && opts.label) {
			const labelEl = append(btn, $('span.toolbar-btn-label'));
			labelEl.textContent = opts.label;
		}

		// Chevron
		if (opts.showChevron) {
			const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			chevron.setAttribute('width', '10');
			chevron.setAttribute('height', '10');
			chevron.setAttribute('viewBox', '0 0 24 24');
			chevron.setAttribute('fill', 'none');
			chevron.setAttribute('stroke', 'currentColor');
			chevron.setAttribute('stroke-width', '2.5');
			const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			chevronPath.setAttribute('d', 'M6 9l6 6 6-6');
			chevron.appendChild(chevronPath);
			btn.appendChild(chevron);
		}

		return btn;
	}

	private _renderSendButtonSvg(): void {
		clearNode(this._sendBtn);
		if (this._isSending) {
			// Stop icon
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14');
			svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('fill', 'currentColor');
			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			rect.setAttribute('x', '6');
			rect.setAttribute('y', '6');
			rect.setAttribute('width', '12');
			rect.setAttribute('height', '12');
			rect.setAttribute('rx', '2');
			svg.appendChild(rect);
			this._sendBtn.appendChild(svg);
			this._sendBtn.title = '取消执行';
		} else {
			// Arrow up icon
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '16');
			svg.setAttribute('height', '16');
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor');
			svg.setAttribute('stroke-width', '2.5');
			svg.setAttribute('stroke-linecap', 'round');
			svg.setAttribute('stroke-linejoin', 'round');
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', '12');
			line.setAttribute('y1', '19');
			line.setAttribute('x2', '12');
			line.setAttribute('y2', '5');
			svg.appendChild(line);
			const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			polyline.setAttribute('points', '5 12 12 5 19 12');
			svg.appendChild(polyline);
			this._sendBtn.appendChild(svg);
			this._sendBtn.title = '发送 (Enter)';
		}
	}

	private _updateSendButton(): void {
		if (!this._sendBtn) { return; }
		this._sendBtn.classList.toggle('chat-cancel-circle', this._isSending);
		if (this._textarea) {
			this._textarea.disabled = this._isSending;
		}
		this._renderSendButtonSvg();
	}

	// Actions

	private _handleSendMessage(): void {
		const text = this._textarea?.value?.trim();
		if (!text || this._isSending) { return; }

		this._textarea.value = '';
		this._textarea.style.height = 'auto';
		this._onSendMessage(text);
	}

	private _scrollToBottom(force: boolean): void {
		if (!this._messagesContainer) { return; }
		requestAnimationFrame(() => {
			this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
		});
	}

	// Layout

	layout(width: number, height: number): void {
		// The CSS flexbox handles layout automatically
	}

	override dispose(): void {
		this._abortController?.abort();
		super.dispose();
	}
}
