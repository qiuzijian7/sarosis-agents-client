/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "../media/xterm-cli.css";
import type { Terminal as XtermTerminalType } from '@xterm/xterm';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { importAMDNodeModule } from '../../../../amdX.js';
import type {
	IAgentChatMessage,
	IToolCall,
	IChatAttachment,
	IAgentInfo,
	IProviderInfo,
	IModelInfo,
	ChatMode,
	StreamPhase,
	IWorktreeItem,
	ISessionInfo,
	IAgentSessionMeta,
	IContextUsage,
	ICheckpointInfo,
	OrchestrationPlan,
} from '../agentChatTypes.js';
import type { IChatPanel, IChatPanelCallbacks } from '../iChatPanel.js';
import { createAnsiThemeFromCssVars, type AnsiTheme } from './ansiTheme.js';
import { renderMarkdownToAnsi } from './mdToAnsi.js';
import {
	renderToolTrail,
	renderUserMessage,
	renderAssistantFooter,
	SPINNER_FRAMES,
	type ToolCallInfo,
	type ThinkingInfo,
} from './toolTreeRenderer.js';

/**
 * xterm.js-based CLI chat panel — renders LLM content in a real terminal
 * emulator instance (not a DOM simulation).
 *
 * This panel uses xterm.js to render all chat output (user messages,
 * assistant markdown, tool calls, thinking) as ANSI escape sequences
 * in a character-grid terminal. The input area and status bar remain
 * as DOM elements for better UX (textarea, keyboard handling).
 *
 * Architecture:
 *  ┌──────────────────────────────────────┐
 *  │  xterm.js Terminal (output)          │
 *  │  markdown → ANSI → terminal.write()  │
 *  ├──────────────────────────────────────┤
 *  │  HTML textarea (input)               │
 *  ├──────────────────────────────────────┤
 *  │  DOM status bar                      │
 *  └──────────────────────────────────────┘
 *
 * Ported from Hermes-Agent TUI rendering approach, adapted for xterm.js
 * in a VS Code editor pane context.
 */
export class XtermCliPanel extends Disposable implements IChatPanel {
	private readonly _container: HTMLElement;
	private _terminalEl!: HTMLElement;
	private _terminal: XtermTerminalType | undefined;
	private _textarea!: HTMLTextAreaElement;
	private _statusBar!: HTMLElement;
	private readonly _disposables: DisposableStore;

	// ── State ──
	private _messages: IAgentChatMessage[] = [];
	private _agent: IAgentInfo | null = null;
	private _isSending = false;
	private _streamPhase: StreamPhase = 'idle';
	private _currentModel = '';
	private _chatMode: ChatMode = 'craft';
	private _contextUsage: IContextUsage | null = null;
	private _streamTextBuffer = '';
	private _streamThinkingBuffer = '';
	private _attachments: IChatAttachment[] = [];
	private _theme: AnsiTheme;

	// ── xterm layout ──
	private _cols = 80;

	// ── Spinner ──
	private _spinnerFrame = SPINNER_FRAMES[0]!;
	private _spinnerIdx = 0;
	private _spinnerInterval: number | null = null;

	// ── Expanded sections ──
	private readonly _expandedSections = new Set<string>(['thinking', 'tools']);

	// ── Pending render flag (while xterm is loading) ──
	private _pendingRender = false;

	// ── Callbacks ──
	private readonly _onSendMessage: IChatPanelCallbacks['onSendMessage'];

	// ── Detail callbacks ──
	// @ts-ignore — assigned via setters, read when features are added
	private _onOpenCompressionDetail: ((data: Record<string, unknown>) => void) | null = null;
	// @ts-ignore
	private _onOpenMemoryDetail: ((agentId: string, memoryType?: string, contentPreview?: string) => void) | null = null;
	// @ts-ignore
	private _onOpenCodebaseDetail: (() => void) | null = null;

	constructor(opts: IChatPanelCallbacks) {
		super();
		this._onSendMessage = opts.onSendMessage;
		this._disposables = new DisposableStore();
		this._register(this._disposables);
		this._theme = createAnsiThemeFromCssVars();

		this._container = document.createElement('div');
		this._container.className = 'xterm-cli-panel';
		this._buildDOM();
		this._startSpinner();
		// xterm.js must be loaded asynchronously via importAMDNodeModule —
		// direct `import from '@xterm/xterm'` fails in the browser renderer.
		void this._initTerminal();
	}

	/**
	 * Asynchronously load the xterm.js Terminal constructor via the AMD
	 * module loader (required for browser renderer compatibility).
	 */
	private async _initTerminal(): Promise<void> {
		const mod = await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js');
		if (this._store.isDisposed) { return; }

		const Terminal = mod.Terminal;
		this._terminal = new Terminal({
			fontFamily: 'var(--vscode-editor-font-family, JetBrains Mono, monospace)',
			fontSize: 13,
			lineHeight: 1.3,
			cursorBlink: false,
			cursorStyle: 'bar',
			disableStdin: true,
			scrollback: 5000,
			convertEol: false,
			allowProposedApi: true,
			theme: {
				background: '#1e1e1e',
				foreground: '#d4d4d4',
			},
		});
		this._terminal.open(this._terminalEl);

		// Track terminal dimensions
		this._disposables.add(this._terminal.onResize(({ cols }) => {
			this._cols = cols;
			this._rerender();
		}));

		// Copy selection to clipboard
		this._disposables.add(this._terminal.onSelectionChange(() => {
			const sel = this._terminal!.getSelection();
			if (sel) {
				navigator.clipboard?.writeText(sel).catch(() => { /* ignore */ });
			}
		}));

		// Render any messages that arrived while xterm was loading
		if (this._pendingRender || this._messages.length > 0) {
			this._pendingRender = false;
			this._rerender();
		}
	}

	get element(): HTMLElement { return this._container; }

	// ═══════════════════════════════════════════════════════════════════
	// DOM construction
	// ═══════════════════════════════════════════════════════════════════

	private _buildDOM(): void {
		// xterm container (Terminal instance is created asynchronously in _initTerminal)
		this._terminalEl = document.createElement('div');
		this._terminalEl.className = 'xterm-cli-terminal';
		this._terminalEl.style.flex = '1';
		this._terminalEl.style.overflow = 'hidden';
		this._terminalEl.style.position = 'relative';

		// Input area (DOM textarea)
		const inputArea = document.createElement('div');
		inputArea.className = 'xterm-cli-input-area';

		const promptRow = document.createElement('div');
		promptRow.className = 'xterm-cli-prompt-row';

		const promptSymbol = document.createElement('span');
		promptSymbol.className = 'xterm-cli-prompt-symbol';
		promptSymbol.textContent = '\u276f';  // ❯

		this._textarea = document.createElement('textarea');
		this._textarea.className = 'xterm-cli-textarea';
		this._textarea.placeholder = 'Ask anything...';
		this._textarea.rows = 1;
		this._textarea.style.resize = 'none';

		promptRow.appendChild(promptSymbol);
		promptRow.appendChild(this._textarea);
		inputArea.appendChild(promptRow);

		// Status bar
		this._statusBar = document.createElement('div');
		this._statusBar.className = 'xterm-cli-status';

		// Assemble
		this._container.appendChild(this._terminalEl);
		this._container.appendChild(inputArea);
		this._container.appendChild(this._statusBar);

		// Wire events
		this._disposables.add(addDisposableListener(this._textarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._handleSend();
			}
		}));
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

	private _startSpinner(): void {
		this._spinnerInterval = window.setInterval(() => {
			this._spinnerIdx = (this._spinnerIdx + 1) % SPINNER_FRAMES.length;
			this._spinnerFrame = SPINNER_FRAMES[this._spinnerIdx]!;
			// Only re-render if there are running tools
			if (this._hasRunningTools()) {
				this._rerender();
			}
		}, 80);
	}

	private _hasRunningTools(): boolean {
		return this._messages.some(m =>
			m.toolCalls?.some(tc => tc.status === 'running'),
		);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════

	private _rerender(): void {
		const term = this._terminal;
		if (!term) {
			// xterm not yet loaded — defer render until _initTerminal completes
			this._pendingRender = true;
			return;
		}

		term.reset();

		const parts: string[] = [];

		for (const msg of this._messages) {
			if (msg.role === 'user') {
				parts.push(this._renderUserMsg(msg));
			} else if (msg.role === 'assistant') {
				parts.push(this._renderAssistantMsg(msg));
			}
		}

		term.write(parts.join(''));
		this._renderStatusBar();
	}

	private _renderUserMsg(msg: IAgentChatMessage): string {
		const text = msg.content || '';
		const ansi = renderUserMessage(text, this._theme);
		return ansi;
	}

	private _renderAssistantMsg(msg: IAgentChatMessage): string {
		const t = this._theme;
		const parts: string[] = [];

		// Thinking + Tool calls (rendered as tree)
		const hasThinking = (msg.thinking && msg.thinking.trim()) ||
			(msg.isThinking && this._streamThinkingBuffer);
		const hasTools = msg.toolCalls && msg.toolCalls.length > 0;

		if (hasThinking || hasTools) {
			const thinking: ThinkingInfo | null = hasThinking ? {
				text: msg.thinking || this._streamThinkingBuffer,
				isRunning: msg.isThinking ?? false,
				durationMs: (msg.metadata as any)?.durationMs,
			} : null;

			const tools: ToolCallInfo[] = (msg.toolCalls ?? []).map((tc: IToolCall) => ({
				id: tc.id,
				name: tc.name,
				args: tc.args,
				result: tc.result,
				status: tc.status === 'running' ? 'running'
					: tc.status === 'error' ? 'error'
					: 'success',
				durationMs: (msg.metadata as any)?.durationMs,
				displayName: tc.displayName,
			}));

			const trail = renderToolTrail(thinking, tools, {
				cols: this._cols,
				t: this._theme,
				expandedSections: this._expandedSections,
				spinnerFrame: this._spinnerFrame,
			});

			if (trail) {
				parts.push(trail);
				parts.push('\r\n');
			}
		}

		// Markdown text content
		const text = msg.isStreaming ? this._streamTextBuffer : msg.content;
		if (text && text.trim()) {
			const md = renderMarkdownToAnsi(text, {
				cols: this._cols - 3,
				t: this._theme,
				paddingLeft: 3,
			});
			parts.push(md);
			parts.push('\r\n');
		}

		// Footer: ▣ Mode · Model · Duration
		if (!msg.isStreaming || msg.streamPhase === 'idle') {
			const durationMs = (msg.metadata as any)?.durationMs as number | undefined;
			const interrupted = msg.streamPhase === 'error';
			parts.push('   ' + renderAssistantFooter(
				this._chatMode,
				this._currentModel || 'unknown',
				t,
				durationMs,
				interrupted,
			));
			parts.push('\r\n');
		}

		return parts.join('');
	}

	private _renderStatusBar(): void {
		clearNode(this._statusBar);

		if (this._isSending) {
			const left = document.createElement('span');
			left.className = 'xterm-status-left';
			const spinner = document.createElement('span');
			spinner.className = 'xterm-spinner';
			spinner.textContent = this._spinnerFrame;
			const text = document.createElement('span');
			text.textContent = this._streamPhase === 'tool_executing' ? 'Running tools...' : 'Thinking...';
			left.appendChild(spinner);
			left.appendChild(text);
			this._statusBar.appendChild(left);
		} else {
			const left = document.createElement('span');
			left.className = 'xterm-status-left';
			left.textContent = 'Ready';
			this._statusBar.appendChild(left);
		}

		// Right: token usage
		if (this._contextUsage) {
			const right = document.createElement('span');
			right.className = 'xterm-status-right';
			const tokens = this._contextUsage.used ?? 0;
			const limit = this._contextUsage.limit ?? 0;
			const pct = limit > 0 ? Math.round((tokens / limit) * 100) : 0;
			right.textContent = `${tokens.toLocaleString()} tokens (${pct}%)`;
			this._statusBar.appendChild(right);
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Agent / providers
	// ═══════════════════════════════════════════════════════════════════

	setAgent(agent: IAgentInfo | null): void {
		this._agent = agent;
	}

	getAgent(): IAgentInfo | null {
		return this._agent;
	}

	setAvailableAgents(_agents: IAgentInfo[]): void { /* no-op */ }

	setProviders(_providers: IProviderInfo[]): void { /* no-op */ }

	setModels(_models: IModelInfo[]): void { /* no-op */ }

	setCurrentProvider(_provider: string): void { /* no-op */ }

	setCurrentModel(model: string): void {
		this._currentModel = model;
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Messages
	// ═══════════════════════════════════════════════════════════════════

	setMessages(messages: IAgentChatMessage[]): void {
		this._messages = messages.slice();
		this._rerender();
	}

	addMessage(message: IAgentChatMessage): void {
		this._messages.push(message);
		const term = this._terminal;
		if (!term) {
			// xterm not yet loaded — will be rendered when _initTerminal completes
			this._pendingRender = true;
			return;
		}
		// Incremental write — append to terminal
		if (message.role === 'user') {
			term.write(this._renderUserMsg(message));
		} else {
			term.write(this._renderAssistantMsg(message));
		}
	}

	updateMessage(messageId: string, updates: Partial<IAgentChatMessage>): void {
		const idx = this._messages.findIndex(m => m.id === messageId);
		if (idx < 0) { return; }
		this._messages[idx] = { ...this._messages[idx], ...updates };
		this._rerender();
	}

	getMessages(): IAgentChatMessage[] {
		return [...this._messages];
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — System messages (stubs)
	// ═══════════════════════════════════════════════════════════════════

	addCompressionNotice(_info: { originalCount: number; compressedCount: number; tokensSaved: number; durationMs: number; beforeText?: string; afterText?: string; summary?: string }): void { /* stub */ }
	addMemoryNotice(_info: { content: string; memoryType?: string; priority?: number; sceneName?: string; assistantContentPreview?: string; iteration?: number; noticeId?: string; status?: 'pending' | 'saved' | 'failed'; entries?: Array<{ type: string; content: string }>; skillId?: string; skillTitle?: string; agentId?: string; clickable?: boolean }): void { /* stub */ }
	updateMemoryNotice(_noticeId: string, _status: 'saved' | 'failed', _newContent?: string): void { /* stub */ }
	removeMemoryNotice(_noticeId: string): void { /* stub */ }
	addCodebaseNotice(_info: { operation: string; summary?: string }): void { /* stub */ }
	clearSystemMessages(): void { /* stub */ }
	setOpenCompressionDetailCallback(cb: (data: Record<string, unknown>) => void): void { this._onOpenCompressionDetail = cb; }
	setOpenMemoryDetailCallback(cb: (agentId: string, memoryType?: string, contentPreview?: string) => void): void { this._onOpenMemoryDetail = cb; }
	setOpenCodebaseDetailCallback(cb: () => void): void { this._onOpenCodebaseDetail = cb; }

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Stream state
	// ═══════════════════════════════════════════════════════════════════

	setSending(sending: boolean): void {
		this._isSending = sending;
		this._renderStatusBar();
	}

	setStreamPhase(phase: StreamPhase): void {
		this._streamPhase = phase;
		this._renderStatusBar();
	}

	setStreamTextBuffer(buffer: string): void {
		this._streamTextBuffer = buffer;
		// Update the last assistant message
		const last = this._messages.findLast(m => m.role === 'assistant');
		if (last) {
			this._rerender();
		}
	}

	setStreamThinkingBuffer(buffer: string): void {
		this._streamThinkingBuffer = buffer;
		const last = this._messages.findLast(m => m.role === 'assistant');
		if (last) {
			this._rerender();
		}
	}

	setStreamUsage(_usage: { input?: number; output?: number; seen?: boolean } | null): void {
		this._renderStatusBar();
	}

	setCompactedBaseline(_baseline: number): void { /* no-op */ }
	setContextUsage(usage: IContextUsage | null): void {
		this._contextUsage = usage;
		this._renderStatusBar();
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Session / worktree / mode
	// ═══════════════════════════════════════════════════════════════════

	setChatMode(mode: ChatMode): void {
		this._chatMode = mode;
	}

	setSessionInfo(_info: ISessionInfo | null): void { /* no-op */ }
	setAgentSessions(_sessions: ReadonlyArray<IAgentSessionMeta>): void { /* no-op */ }
	setWorktrees(_items: ReadonlyArray<IWorktreeItem>): void { /* no-op */ }
	setSelectedWorktree(_path: string): void { /* no-op */ }
	setCheckpoint(_info: ICheckpointInfo | null): void { /* no-op */ }
	setCheckpoints(_list: ICheckpointInfo[]): void { /* no-op */ }

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Orchestration
	// ═══════════════════════════════════════════════════════════════════

	showOrchestrationPlanDialog(_plan: OrchestrationPlan): void { /* stub */ }
	closeOrchestrationPlanDialog(): void { /* stub */ }

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — UI operations
	// ═══════════════════════════════════════════════════════════════════

	focusInput(): void {
		this._textarea?.focus();
	}

	layout(_width: number, _height: number): void {
		// xterm handles its own layout via the container
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Attachments
	// ═══════════════════════════════════════════════════════════════════

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

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — CLI mode query
	// ═══════════════════════════════════════════════════════════════════

	getCliMode(): boolean {
		return true; // This panel IS the CLI mode
	}

	// ═══════════════════════════════════════════════════════════════════
	// Dispose
	// ═══════════════════════════════════════════════════════════════════

	override dispose(): void {
		if (this._spinnerInterval !== null) {
			window.clearInterval(this._spinnerInterval);
			this._spinnerInterval = null;
		}
		this._terminal?.dispose();
		this._disposables.dispose();
		super.dispose();
	}
}

// ── Helper: clearNode (avoid importing from dom.js to keep deps minimal) ──
function clearNode(node: HTMLElement): void {
	while (node.firstChild) {
		node.removeChild(node.firstChild);
	}
}
