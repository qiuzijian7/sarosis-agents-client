/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./media/cli-chat.css";
import { Disposable, DisposableStore, type IDisposable } from "../../../base/common/lifecycle.js";
import { clearNode, addDisposableListener, EventType } from "../../../base/browser/dom.js";
import { renderMarkdown } from "../../../base/browser/markdownRenderer.js";
import type { IMarkdownString } from "../../../base/common/htmlContent.js";
import type {
	IAgentChatMessage,
	IToolCall,
	IChatAttachment,
	IAgentInfo,
	IProviderInfo,
	IModelInfo,
	StreamPhase,
	IWorktreeItem,
	IWorkspaceItem,
	ISessionInfo,
	IAgentSessionMeta,
	IContextUsage,
	ICheckpointInfo,
	OrchestrationPlan,
} from "./agentChatTypes.js";
import type { IChatPanel, IChatPanelCallbacks } from "./iChatPanel.js";

/**
 * CLI-style chat panel — independent rendering implementation inspired by
 * OpenCode TUI layout.
 *
 * Key differences from {@link AgentChatPanel}:
 *  - User messages: left border (agent color) + panel background, no ❯ prefix
 *  - Assistant messages: no ● prefix, indented (paddingLeft ~24px)
 *  - Tool calls: two modes — InlineTool (single line icon+text) and BlockTool
 *    (left border + panel bg, contains diff/code/output)
 *  - Thinking: collapsible header with summary + duration, muted italic body
 *  - Assistant footer: `▣ Mode · Model · Duration`
 *  - Prompt: agent-colored left border + meta row (agent · model · provider)
 *  - No avatar circles, no rounded bubbles, no gradients
 *  - Independent CSS file (cli-chat.css) — does NOT reuse agentChat.css
 *    `.cli-mode` rules
 *
 * The panel implements {@link IChatPanel} so {@link NativeChatEditorPane} can
 * treat it polymorphically with {@link AgentChatPanel}.
 */
export class CliChatEditorPanel extends Disposable implements IChatPanel {
	private readonly _container: HTMLElement;
	private _messagesContainer!: HTMLElement;
	private _messagesScroll!: HTMLElement;
	private _textarea!: HTMLTextAreaElement;
	private _sendBtn!: HTMLElement;
	private _promptMetaRow!: HTMLElement;
	private _statusBar!: HTMLElement;

	// -- State --
	private _messages: IAgentChatMessage[] = [];
	private _agent: IAgentInfo | null = null;
	private _isSending = false;
	private _streamPhase: StreamPhase = 'idle';
	private _currentProvider = "";
	private _currentModel = "";
	private _chatOnly: boolean = false;
	private _contextUsage: IContextUsage | null = null;
	private _streamTextBuffer: string = '';
	private _streamThinkingBuffer: string = '';
	private _attachments: IChatAttachment[] = [];
	private _autoScroll = true;

	// -- Markdown render disposables --
	private readonly _markdownDisposables = new Map<HTMLElement, IDisposable>();
	private readonly _disposables: DisposableStore;

	// -- Callbacks (only those used by this panel's rendering logic) --
	private readonly _onSendMessage: IChatPanelCallbacks['onSendMessage'];

	// -- Detail callbacks (stubs, will be wired as features are added) --
	// These are stored to satisfy the IChatPanel interface setters; they will
	// be consumed when CLI panel gains compression/memory detail rendering.
	// @ts-ignore — assigned via setters, read when features are added
	private _onOpenCompressionDetail: ((data: Record<string, unknown>) => void) | null = null;
	// @ts-ignore
	private _onOpenMemoryDetail: ((agentId: string, memoryType?: string, contentPreview?: string) => void) | null = null;
	// @ts-ignore
	private _onOpenCodebaseDetail: (() => void) | null = null;

	constructor(opts: IChatPanelCallbacks) {
		super();
		this._onSendMessage = opts.onSendMessage;

		this._container = document.createElement('div');
		this._container.className = 'cli-chat-panel';
		this._disposables = new DisposableStore();
		this._register(this._disposables);
		this._buildDOM();
	}

	get element(): HTMLElement { return this._container; }

	// ═════════════════════════════════════════════════════════════════
	// DOM construction
	// ═════════════════════════════════════════════════════════════════

	private _buildDOM(): void {
		// Messages scroll area
		this._messagesScroll = document.createElement('div');
		this._messagesScroll.className = 'cli-messages-scroll';
		this._messagesScroll.style.flex = '1';
		this._messagesScroll.style.overflowY = 'auto';
		this._messagesScroll.style.overflowX = 'hidden';

		this._messagesContainer = document.createElement('div');
		this._messagesContainer.className = 'cli-messages';
		this._messagesScroll.appendChild(this._messagesContainer);

		// Track scroll for auto-scroll
		this._disposables.add(addDisposableListener(this._messagesScroll, EventType.SCROLL, () => {
			const el = this._messagesScroll;
			this._autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
		}));

		// Input area
		const inputArea = document.createElement('div');
		inputArea.className = 'cli-input-area';

		// Prompt meta row (agent · model · provider)
		this._promptMetaRow = document.createElement('div');
		this._promptMetaRow.className = 'cli-prompt-meta-row';
		this._renderPromptMeta();

		// Textarea + send button row
		const inputRow = document.createElement('div');
		inputRow.className = 'cli-input-row';

		this._textarea = document.createElement('textarea');
		this._textarea.className = 'cli-textarea';
		this._textarea.placeholder = 'Ask anything...';
		this._textarea.rows = 1;
		this._textarea.style.resize = 'none';

		this._sendBtn = document.createElement('button');
		this._sendBtn.className = 'cli-send-btn';
		this._sendBtn.textContent = '▶';
		this._sendBtn.title = 'Send';

		inputRow.appendChild(this._textarea);
		inputRow.appendChild(this._sendBtn);

		inputArea.appendChild(this._promptMetaRow);
		inputArea.appendChild(inputRow);

		// Status bar
		this._statusBar = document.createElement('div');
		this._statusBar.className = 'cli-status-bar';
		this._renderStatusBar();

		// Assemble
		this._container.appendChild(this._messagesScroll);
		this._container.appendChild(inputArea);
		this._container.appendChild(this._statusBar);

		// Wire events
		this._disposables.add(addDisposableListener(this._textarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._handleSend();
			}
		}));
		this._disposables.add(addDisposableListener(this._sendBtn, EventType.CLICK, () => this._handleSend()));
		this._disposables.add(addDisposableListener(this._textarea, EventType.INPUT, () => this._autoResizeTextarea()));
	}

	private _autoResizeTextarea(): void {
		this._textarea.style.height = 'auto';
		const max = 200;
		const h = Math.min(this._textarea.scrollHeight, max);
		this._textarea.style.height = h + 'px';
	}

	private _handleSend(): void {
		const text = this._textarea.value.trim();
		if (!text || this._isSending) { return; }
		const attachments = this._attachments.length > 0 ? this._attachments.slice() : undefined;
		this._onSendMessage(text, undefined, attachments);
		this._textarea.value = '';
		this._autoResizeTextarea();
		this._attachments = [];
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — Agent / providers
	// ═════════════════════════════════════════════════════════════════

	setAgent(agent: IAgentInfo | null): void {
		this._agent = agent;
		this._renderPromptMeta();
		// Update container CSS var for agent color
		if (agent) {
			const color = this._getAgentColor(agent);
			this._container.style.setProperty('--cli-agent-color', color);
		}
	}

	getAgent(): IAgentInfo | null {
		return this._agent;
	}

	setAvailableAgents(_agents: IAgentInfo[]): void {
		// Stored on the pane level; CLI panel doesn't render agent dropdown
	}

	setProviders(_providers: IProviderInfo[]): void {
		// CLI panel doesn't render provider dropdown; model name shown in meta row
	}

	setModels(_models: IModelInfo[]): void {
		// CLI panel doesn't render model dropdown; model name shown in meta row
	}

	setCurrentProvider(provider: string): void {
		this._currentProvider = provider;
		this._renderPromptMeta();
	}

	setCurrentModel(model: string): void {
		this._currentModel = model;
		this._renderPromptMeta();
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — Messages
	// ═════════════════════════════════════════════════════════════════

	setMessages(messages: IAgentChatMessage[]): void {
		this._messages = messages.slice();
		this._renderAllMessages();
		this._scrollToBottom(false);
	}

	addMessage(message: IAgentChatMessage): void {
		this._messages.push(message);
		this._appendMessageElement(message);
		this._scrollToBottom(true);
	}

	updateMessage(messageId: string, updates: Partial<IAgentChatMessage>): void {
		const idx = this._messages.findIndex(m => m.id === messageId);
		if (idx < 0) { return; }
		this._messages[idx] = { ...this._messages[idx], ...updates };
		// Re-render the single message element
		this._updateMessageElement(messageId);
	}

	getMessages(): IAgentChatMessage[] {
		return [...this._messages];
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — System messages (stubs: CLI mode shows inline)
	// ═════════════════════════════════════════════════════════════════

	addCompressionNotice(_info: { originalCount: number; compressedCount: number; tokensSaved: number; durationMs: number; beforeText?: string; afterText?: string; summary?: string }): void {
		// CLI mode: render as a system line in the message stream
		// Minimal implementation — can be enhanced later
	}

	addMemoryNotice(_info: { content: string; memoryType?: string; priority?: number; sceneName?: string; assistantContentPreview?: string; iteration?: number; noticeId?: string; status?: 'pending' | 'saved' | 'failed'; entries?: Array<{ type: string; content: string }>; skillId?: string; skillTitle?: string; agentId?: string; clickable?: boolean }): void {
		// Stub — CLI mode can show a single-line notice later
	}

	updateMemoryNotice(_noticeId: string, _status: 'saved' | 'failed', _newContent?: string): void {
		// Stub
	}

	removeMemoryNotice(_noticeId: string): void {
		// Stub
	}

	addCodebaseNotice(_info: { operation: string; summary?: string }): void {
		// Stub
	}

	clearSystemMessages(): void {
		// Stub — no separate system message area in CLI mode
	}

	setOpenCompressionDetailCallback(cb: (data: Record<string, unknown>) => void): void {
		this._onOpenCompressionDetail = cb;
	}

	setOpenMemoryDetailCallback(cb: (agentId: string, memoryType?: string, contentPreview?: string) => void): void {
		this._onOpenMemoryDetail = cb;
	}

	setOpenCodebaseDetailCallback(cb: () => void): void {
		this._onOpenCodebaseDetail = cb;
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — Stream state
	// ═════════════════════════════════════════════════════════════════

	setSending(sending: boolean, _options?: { triggerExecuteNext?: boolean }): void {
		this._isSending = sending;
		this._sendBtn.textContent = sending ? '■' : '▶';
		this._sendBtn.title = sending ? 'Stop' : 'Send';
		this._renderStatusBar();
	}

	setStreamPhase(phase: StreamPhase): void {
		this._streamPhase = phase;
		this._renderStatusBar();
	}

	setStreamTextBuffer(buffer: string): void {
		this._streamTextBuffer = buffer;
		// Update the last assistant message's text content
		const last = this._messages.findLast(m => m.role === 'assistant');
		if (last) {
			this._updateMessageElement(last.id);
		}
	}

	setStreamThinkingBuffer(buffer: string): void {
		this._streamThinkingBuffer = buffer;
		const last = this._messages.findLast(m => m.role === 'assistant');
		if (last) {
			this._updateMessageElement(last.id);
		}
	}

	setStreamUsage(_usage: { input?: number; output?: number; seen?: boolean } | null): void {
		// Token usage shown via setContextUsage
	}

	setCompactedBaseline(_baseline: number): void {
		// Compacted baseline tracked on pane level
	}

	setContextUsage(usage: IContextUsage | null): void {
		this._contextUsage = usage;
		this._renderStatusBar();
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — Session / worktree / mode
	// ═════════════════════════════════════════════════════════════════

	// ChatOnly toggle — replaces legacy setChatMode(mode: ChatMode)
	setChatOnly(chatOnly: boolean): void {
		this._chatOnly = chatOnly;
		this._renderPromptMeta();
	}

	setSessionInfo(_info: ISessionInfo | null): void {
		// Session info tracked on pane level
	}

	setAgentSessions(_sessions: ReadonlyArray<IAgentSessionMeta>): void {
		// Session list tracked on pane level
	}

	setWorktrees(_items: ReadonlyArray<IWorktreeItem>): void {
		// Worktree list tracked on pane level
	}

	setSelectedWorktree(_path: string): void {
		// Worktree selection tracked on pane level
	}

	setWorkspaces(_items: ReadonlyArray<IWorkspaceItem>): void {
		// Workspace list tracked on pane level
	}

	setSelectedWorkspace(_id: string): void {
		// Workspace selection tracked on pane level
	}

	setCheckpoint(_info: ICheckpointInfo | null): void {
		// Checkpoint tracked on pane level
	}

	setCheckpoints(_list: ICheckpointInfo[]): void {
		// Checkpoint list tracked on pane level
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — Orchestration (stub — CLI mode can show inline later)
	// ═════════════════════════════════════════════════════════════════

	showOrchestrationPlanDialog(_plan: OrchestrationPlan): void {
		// Stub — could render a compact plan summary inline
	}

	closeOrchestrationPlanDialog(): void {
		// Stub
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — UI operations
	// ═════════════════════════════════════════════════════════════════

	focusInput(): void {
		this._textarea?.focus();
	}

	getComposerText(): string { return this._textarea?.value ?? ''; }
	setComposerText(text: string): void { if (this._textarea) { this._textarea.value = text; } }

	layout(_width: number, _height: number): void {
		// CSS flexbox handles layout
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — Attachments
	// ═════════════════════════════════════════════════════════════════

	getAttachments(): ReadonlyArray<IChatAttachment> {
		return this._attachments;
	}

	clearAttachments(): void {
		this._attachments = [];
	}

	addFileContext(filePath: string, content: string): void {
		const fileName = filePath.split(/[\\/]/).pop() || filePath;
		this._attachments.push({
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name: fileName,
			mimeType: 'text/plain',
			data: content,
			size: content.length,
			isPasted: false,
			filePath,
		});
	}

	addTextContext(name: string, content: string): void {
		this._attachments.push({
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name,
			mimeType: 'text/plain',
			data: content,
			size: content.length,
			isPasted: false,
		});
	}

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — CLI mode query
	// ═════════════════════════════════════════════════════════════════

	getCliMode(): boolean {
		return true; // This panel IS the CLI mode
	}

	// ═════════════════════════════════════════════════════════════════
	// Rendering — OpenCode TUI style
	// ═════════════════════════════════════════════════════════════════

	private _renderAllMessages(): void {
		clearNode(this._messagesContainer);
		this._markdownDisposables.forEach(d => d.dispose());
		this._markdownDisposables.clear();
		for (const msg of this._messages) {
			this._appendMessageElement(msg);
		}
	}

	private _appendMessageElement(msg: IAgentChatMessage): void {
		const el = document.createElement('div');
		el.className = 'cli-msg-row';
		el.dataset.messageId = msg.id;
		el.dataset.role = msg.role;

		if (msg.role === 'user') {
			this._renderUserMessage(msg, el);
		} else if (msg.role === 'assistant') {
			this._renderAssistantMessage(msg, el);
		}

		this._messagesContainer.appendChild(el);
	}

	private _updateMessageElement(messageId: string): void {
		const el = this._messagesContainer.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
		if (!el) { return; }
		const msg = this._messages.find(m => m.id === messageId);
		if (!msg) { return; }

		// Dispose old markdown disposables in this element
		const toRemove: HTMLElement[] = [];
		this._markdownDisposables.forEach((d, key) => {
			if (el.contains(key)) { toRemove.push(key); }
		});
		for (const key of toRemove) {
			this._markdownDisposables.get(key)?.dispose();
			this._markdownDisposables.delete(key);
		}

		clearNode(el);
		if (msg.role === 'user') {
			this._renderUserMessage(msg, el);
		} else if (msg.role === 'assistant') {
			this._renderAssistantMessage(msg, el);
		}

		if (this._autoScroll) {
			this._scrollToBottom(true);
		}
	}

	// ── User message: left border + panel background ──

	private _renderUserMessage(msg: IAgentChatMessage, container: HTMLElement): void {
		container.classList.add('cli-user-msg');
		const agentColor = this._agent ? this._getAgentColor(this._agent) : 'var(--vscode-textLink-foreground, #4aa3ff)';
		container.style.setProperty('--cli-msg-border-color', agentColor);

		const body = document.createElement('div');
		body.className = 'cli-user-msg-body';

		// Text content
		const text = msg.content || '';
		if (text.trim()) {
			const textEl = document.createElement('div');
			textEl.className = 'cli-user-msg-text';
			textEl.textContent = text;
			body.appendChild(textEl);
		}

		// Attachments
		if (msg.attachments && msg.attachments.length > 0) {
			for (const att of msg.attachments) {
				const attEl = document.createElement('span');
				attEl.className = 'cli-attachment-badge';
				attEl.textContent = att.name;
				body.appendChild(attEl);
			}
		}

		container.appendChild(body);
	}

	// ── Assistant message: indented, no prefix ──

	private _renderAssistantMessage(msg: IAgentChatMessage, container: HTMLElement): void {
		container.classList.add('cli-assistant-msg');

		const content = document.createElement('div');
		content.className = 'cli-assistant-content';

		// Thinking (collapsible)
		const thinking = this._getThinkingText(msg);
		if (thinking && thinking.trim()) {
			content.appendChild(this._renderThinking(thinking, msg.isThinking ?? false));
		}

		// Text content (markdown)
		const text = this._getAssistantText(msg);
		if (text && text.trim()) {
			const textEl = document.createElement('div');
			textEl.className = 'cli-assistant-text';
			this._renderMarkdown(textEl, text);
			content.appendChild(textEl);
		}

		// Tool calls
		if (msg.toolCalls && msg.toolCalls.length > 0) {
			for (const tc of msg.toolCalls) {
				content.appendChild(this._renderToolCall(tc));
			}
		}

		// Footer: ▣ Mode · Model · Duration
		if (!msg.isStreaming || msg.streamPhase === 'idle') {
			content.appendChild(this._renderAssistantFooter(msg));
		}

		container.appendChild(content);
	}

	private _renderThinking(text: string, isRunning: boolean): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.className = 'cli-thinking';

		if (isRunning) {
			wrapper.classList.add('cli-thinking-running');
			const spinner = document.createElement('span');
			spinner.className = 'cli-spinner';
			const label = document.createElement('span');
			label.textContent = 'Thinking';
			wrapper.appendChild(spinner);
			wrapper.appendChild(label);
		} else {
			const header = document.createElement('div');
			header.className = 'cli-thinking-header';

			const toggle = document.createElement('span');
			toggle.className = 'cli-thinking-toggle collapsed';

			const summary = document.createElement('span');
			summary.className = 'cli-thinking-summary';
			// Use first line or first 80 chars as summary
			const firstLine = text.split('\n')[0]?.slice(0, 80) || 'Thought';
			summary.textContent = firstLine;

			header.appendChild(toggle);
			header.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'cli-thinking-body';
			body.style.display = 'none';
			this._renderMarkdown(body, text);

			header.addEventListener('click', () => {
				const expanded = body.style.display !== 'none';
				body.style.display = expanded ? 'none' : 'block';
				toggle.classList.toggle('collapsed', expanded);
				toggle.classList.toggle('expanded', !expanded);
			});

			wrapper.appendChild(header);
			wrapper.appendChild(body);
		}

		return wrapper;
	}

	private _renderToolCall(tc: IToolCall): HTMLElement {
		const isBlock = this._isBlockTool(tc.name) && (!!tc.result || tc.status === 'running');
		const wrapper = document.createElement('div');
		wrapper.className = isBlock ? 'cli-tool-block' : 'cli-tool-inline';

		const icon = this._getToolIcon(tc.name);
		const iconEl = document.createElement('span');
		iconEl.className = 'cli-tool-icon';
		if (tc.status === 'running') { iconEl.classList.add('running'); }
		else if (tc.status === 'error') { iconEl.classList.add('error'); }
		else { iconEl.classList.add('complete'); }
		iconEl.textContent = icon;

		const textEl = document.createElement('span');
		textEl.className = 'cli-tool-text';
		const args = this._formatToolArgs(tc.args);
		textEl.textContent = `${tc.displayName || tc.name}${args ? ' ' + args : ''}`;

		if (isBlock) {
			const title = document.createElement('div');
			title.className = 'cli-tool-block-title';
			title.textContent = `# ${tc.displayName || tc.name} ${args}`.trim();

			const body = document.createElement('div');
			body.className = 'cli-tool-block-body';
			if (tc.result) {
				const pre = document.createElement('pre');
				pre.className = 'cli-tool-output';
				pre.textContent = tc.result;
				body.appendChild(pre);
			}

			wrapper.appendChild(title);
			wrapper.appendChild(body);
		} else {
			wrapper.appendChild(iconEl);
			wrapper.appendChild(textEl);
		}

		return wrapper;
	}

	private _renderAssistantFooter(msg: IAgentChatMessage): HTMLElement {
		const footer = document.createElement('div');
		footer.className = 'cli-assistant-footer';

		const marker = document.createElement('span');
		marker.className = 'cli-footer-marker';
		marker.textContent = '▣';

		const mode = document.createElement('span');
		mode.className = 'cli-footer-mode';
		mode.textContent = this._chatOnly ? '只读' : '正常';

		const sep1 = document.createElement('span');
		sep1.className = 'cli-footer-sep';
		sep1.textContent = '·';

		const model = document.createElement('span');
		model.className = 'cli-footer-model';
		model.textContent = this._currentModel || 'unknown';

		footer.appendChild(marker);
		footer.appendChild(mode);
		footer.appendChild(sep1);
		footer.appendChild(model);

		// Duration
		if (msg.metadata?.durationMs) {
			const sep2 = document.createElement('span');
			sep2.className = 'cli-footer-sep';
			sep2.textContent = '·';
			const dur = document.createElement('span');
			dur.className = 'cli-footer-duration';
			dur.textContent = this._formatDuration(msg.metadata.durationMs as number);
			footer.appendChild(sep2);
			footer.appendChild(dur);
		}

		// Interrupted
		if (msg.streamPhase === 'error' || (msg as any).interrupted) {
			const sep3 = document.createElement('span');
			sep3.className = 'cli-footer-sep';
			sep3.textContent = '·';
			const intr = document.createElement('span');
			intr.className = 'cli-footer-interrupted';
			intr.textContent = 'interrupted';
			footer.appendChild(sep3);
			footer.appendChild(intr);
		}

		return footer;
	}

	private _renderPromptMeta(): HTMLElement {
		clearNode(this._promptMetaRow);

		const agentName = this._agent?.name ?? 'Build';
		const agentEl = document.createElement('span');
		agentEl.className = 'cli-meta-agent';
		agentEl.textContent = agentName;
		this._promptMetaRow.appendChild(agentEl);

		if (this._currentModel) {
			const sep = document.createElement('span');
			sep.className = 'cli-meta-sep';
			sep.textContent = '·';
			this._promptMetaRow.appendChild(sep);

			const modelEl = document.createElement('span');
			modelEl.className = 'cli-meta-model';
			modelEl.textContent = this._currentModel;
			this._promptMetaRow.appendChild(modelEl);
		}

		if (this._currentProvider) {
			const providerEl = document.createElement('span');
			providerEl.className = 'cli-meta-provider';
			providerEl.textContent = this._currentProvider;
			this._promptMetaRow.appendChild(providerEl);
		}

		return this._promptMetaRow;
	}

	private _renderStatusBar(): void {
		clearNode(this._statusBar);

		if (this._isSending) {
			const left = document.createElement('div');
			left.className = 'cli-status-left';

			const spinner = document.createElement('span');
			spinner.className = 'cli-spinner';

			const text = document.createElement('span');
			text.className = 'cli-status-text';
			text.textContent = this._streamPhase === 'tool_executing' ? 'Running tools...' : 'Thinking...';

			left.appendChild(spinner);
			left.appendChild(text);
			this._statusBar.appendChild(left);
		} else {
			const left = document.createElement('div');
			left.className = 'cli-status-left';
			const idle = document.createElement('span');
			idle.className = 'cli-status-idle';
			idle.textContent = 'Ready';
			left.appendChild(idle);
			this._statusBar.appendChild(left);
		}

		// Right: token usage
		const right = document.createElement('div');
		right.className = 'cli-status-right';
		if (this._contextUsage) {
			const tokens = this._contextUsage.used ?? 0;
			const limit = this._contextUsage.limit ?? 0;
			const pct = limit > 0 ? Math.round((tokens / limit) * 100) : 0;
			const tokenEl = document.createElement('span');
			tokenEl.className = 'cli-status-tokens';
			tokenEl.textContent = `${tokens.toLocaleString()} tokens (${pct}%)`;
			right.appendChild(tokenEl);
		}
		this._statusBar.appendChild(right);
	}

	// ═════════════════════════════════════════════════════════════════
	// Helpers
	// ═════════════════════════════════════════════════════════════════

	private _getAgentColor(agent: IAgentInfo): string {
		// Use agent icon color or a default
		const colors = ['#4aa3ff', '#4ade80', '#cca700', '#f48771', '#c586c0', '#dcdcaa'];
		const hash = (agent.id || agent.name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
		return colors[hash % colors.length];
	}

	private _getThinkingText(msg: IAgentChatMessage): string {
		return msg.thinking || (msg.isThinking ? this._streamThinkingBuffer : '') || '';
	}

	private _getAssistantText(msg: IAgentChatMessage): string {
		if (msg.isStreaming && this._streamTextBuffer) {
			return this._streamTextBuffer;
		}
		return msg.content || '';
	}

	private _renderMarkdown(container: HTMLElement, text: string): void {
		try {
			const md: IMarkdownString = { value: text, isTrusted: false };
			const result = renderMarkdown(md, {
				codeBlockRenderer: async (lang, value) => {
					const pre = document.createElement('pre');
					pre.className = 'cli-code-block';
					const code = document.createElement('code');
					code.className = lang ? `language-${lang}` : '';
					code.textContent = value;
					pre.appendChild(code);
					return pre;
				},
			});
			container.appendChild(result.element);
			this._markdownDisposables.set(container, result);
		} catch {
			// Fallback: plain text
			container.textContent = text;
		}
	}

	private _isBlockTool(name: string): boolean {
		const blockTools = new Set([
			'bash', 'terminal', 'run_command', 'run_terminal_cmd', 'execute_code', 'process',
			'write', 'write_file', 'rewrite_file', 'edit', 'edit_file', 'replace_in_file',
			'apply_patch', 'patch', 'todowrite', 'todo', 'update_plan', 'question', 'clarify',
		]);
		return blockTools.has(name);
	}

	private _getToolIcon(name: string): string {
		const icons: Record<string, string> = {
			bash: '$', terminal: '$', run_command: '$', run_terminal_cmd: '$', execute_code: '$', process: '$',
			read: '→', read_file: '→', file_read: '→',
			write: '←', write_file: '←', rewrite_file: '←', file_write: '←',
			edit: '←', edit_file: '←', replace_in_file: '←', apply_patch: '←', patch: '←',
			grep: '✱', search_content: '✱', search_files: '✱', search_in_file: '✱',
			file_list: '✱', ls_dir: '✱', list_files: '✱', get_dir_tree: '✱',
			search_pathnames_only: '✱', search_for_files: '✱',
			web_fetch: '%', http_get: '%', web_search: '◈',
			delegate_task: '│', task: '│', subagent: '│',
			skill_manage: '→', read_skill: '→', list_skills: '→',
			todo: '⚙', todowrite: '⚙', update_plan: '⚙',
			clarify: '→', question: '→',
			memory_remember: '⚙', memory_list: '⚙',
			recall: '⚙',
		};
		return icons[name] ?? '⚙';
	}

	private _formatToolArgs(args: string | undefined): string {
		if (!args) { return ''; }
		try {
			const parsed = JSON.parse(args);
			if (typeof parsed === 'object' && parsed !== null) {
				const entries = Object.entries(parsed)
					.filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
					.slice(0, 3);
				if (entries.length === 0) { return ''; }
				return `[${entries.map(([k, v]) => `${k}=${v}`).join(', ')}]`;
			}
		} catch {
			// Not JSON — return raw truncated
		}
		if (args.length > 60) { return args.slice(0, 60) + '...'; }
		return args;
	}

	private _formatDuration(ms: number): string {
		if (ms < 1000) { return `${ms}ms`; }
		const s = ms / 1000;
		if (s < 60) { return `${s.toFixed(1)}s`; }
		const m = Math.floor(s / 60);
		const rem = Math.round(s % 60);
		return `${m}m${rem}s`;
	}

	private _scrollToBottom(_animate: boolean): void {
		requestAnimationFrame(() => {
			if (this._autoScroll) {
				this._messagesScroll.scrollTop = this._messagesScroll.scrollHeight;
			}
		});
	}

	override dispose(): void {
		this._markdownDisposables.forEach(d => d.dispose());
		this._markdownDisposables.clear();
		this._disposables.dispose();
		super.dispose();
	}
}
