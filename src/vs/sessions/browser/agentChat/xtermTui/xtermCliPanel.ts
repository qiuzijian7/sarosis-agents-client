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
		const xtermMod = await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js');
		if (this._store.isDisposed) { return; }

		const Terminal = xtermMod.Terminal;


		// 对齐 Hermes-Agent TUI 的文本渲染策略：
		// - 最小化 lineHeight（1.0，无额外行间距）
		// - letterSpacing=0（零字符间距）
		// - 较小的 fontSize（12px，增加信息密度）
		// Hermes-Agent 纯 ANSI 渲染器中不控制这些属性，
		// 但我们用 xterm.js 必须显式设置
		this._terminal = new Terminal({
			fontFamily: 'var(--vscode-editor-font-family, JetBrains Mono, monospace)',
			fontSize: 12,
			lineHeight: 1.0,
			letterSpacing: 0,
			cursorBlink: false,
			cursorStyle: 'bar',
			disableStdin: true,
			scrollback: 5000,
			convertEol: true,
			allowProposedApi: true,
			theme: {
				background: '#1e1e1e',
				foreground: '#d4d4d4',
			},
		});
		this._terminal.open(this._terminalEl);

		// 手动计算 cols 和 rows，基于容器尺寸
		// 避免依赖 @xterm/addon-fit（未安装）
		// xterm 字符宽度 ≈ 7.5px (13px font * 0.6 char-width)
		// xterm 行高 ≈ 18px (13px font * 1.3 lineHeight + padding)
		this._refitTerminal();

		// ResizeObserver: 监听 xterm 容器尺寸变化，自动重新计算 cols
		// 解决水平溢出问题：容器宽度变化时，xterm 自动调整列数
		const resizeObserver = new ResizeObserver(() => {
			this._refitTerminal();
		});
		resizeObserver.observe(this._terminalEl);
		this._disposables.add({ dispose: () => resizeObserver.disconnect() });

		// Track terminal dimensions
		this._disposables.add(this._terminal.onResize(({ cols }) => {
			this._cols = cols;
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

		// 关键：xterm 加载完成后，DOM 布局已稳定，重新计算 xterm 容器高度
		// 修复从 web 切换到 CLI 时的空白问题：
		// - _initChatPanel() 调用 panel.layout() 时 wrapper 高度为 0（DOM 未布局完成）
		// - xterm 异步加载完成后，wrapper 已有正确高度
		// - 此处需要主动 layout 一次
		this._recomputeLayout();
	}

	get element(): HTMLElement { return this._container; }

	// ═══════════════════════════════════════════════════════════════════
	// Terminal refit
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * 手动计算 xterm 的 cols 和 rows，基于容器尺寸。
	 * 避免依赖 @xterm/addon-fit（项目未安装）。
	 * 字符宽度估算：13px 字体下，等宽字符约 7.8px 宽。
	 * 行高估算：13px * 1.3 = 16.9px，加 padding ≈ 18px。
	 */
	private _refitTerminal(): void {
		const term = this._terminal;
		if (!term || !this._terminalEl) { return; }
		const rect = this._terminalEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) { return; }

		// 对齐 Hermes-Agent 的最小化间距策略：
		// fontSize=12px，等宽字符约 7.2px 宽（12 * 0.6）
		// lineHeight=1.0，行高约 12px + cell padding
		const charWidth = 7.2;
		const lineHeightEstimate = 14; // 12px font * 1.0 + 2px cell padding
		const padding = 20; // 左右 padding 4px*2 + scrollbar 12px

		const cols = Math.max(20, Math.floor((rect.width - padding) / charWidth));
		const rows = Math.max(3, Math.floor((rect.height - padding) / lineHeightEstimate));

		this._cols = cols;
		try {
			(term as any).resize?.(cols, rows);
		} catch { /* ignore */ }
	}

	/**
	 * 强制重新计算 xterm 容器高度。
	 * 与 `layout()` 不同：使用 `requestAnimationFrame` 等待 DOM 布局完成，
	 * 并使用容器的 `getBoundingClientRect()`（而非 `clientHeight`）来读取实际高度。
	 *
	 * 解决"从 web 切换到 CLI 后仍有空白"问题：
	 * - `_initChatPanel()` 第一次调用 `panel.layout()` 时，wrapper 高度为 0（DOM 未布局完成）
	 * - `layout()` 检测到 0 高度后直接 return，xterm 容器高度永远保持默认 200px
	 * - xterm 异步加载完成后，需要再调用一次 layout 才能正确计算
	 */
	private _recomputeLayout(): void {
		requestAnimationFrame(() => {
			if (!this._container || !this._terminalEl) { return; }
			const wrapper = this._container.querySelector('.xterm-cli-content-wrapper') as HTMLElement | null;
			if (!wrapper) { return; }

			const rect = wrapper.getBoundingClientRect();
			const wrapperHeight = rect.height;
			if (wrapperHeight <= 0) {
				// wrapper 还未布局完成，再重试一次
				this._recomputeLayout();
				return;
			}

			const term = this._terminal;
			let contentLines = 1;
			if (term) {
				try {
					contentLines = term.buffer.active.length;
				} catch { /* ignore */ }
			}

			const lineHeight = 14;  // 12px font * 1.0 lineHeight + 2px cell padding
			const contentHeight = contentLines * lineHeight + 12;
			const newHeight = Math.max(40, Math.min(contentHeight, wrapperHeight));

			this._terminalEl.style.height = `${newHeight}px`;
			this._terminalEl.style.width = `${rect.width}px`;

			// 重新计算 cols/rows
			this._refitTerminal();
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// DOM construction
	// ═══════════════════════════════════════════════════════════════════

	private _buildDOM(): void {
		// Wrapper for xterm — fills available space, contains the xterm
		// container which is positioned at the bottom. This way:
		// - Input is always at the very bottom of the panel
		// - xterm content sticks to the bottom of the available area
		// - No huge gap between content and input
		const contentWrapper = document.createElement('div');
		contentWrapper.className = 'xterm-cli-content-wrapper';

		// xterm container (Terminal instance is created asynchronously in _initTerminal)
		this._terminalEl = document.createElement('div');
		this._terminalEl.className = 'xterm-cli-terminal';

		contentWrapper.appendChild(this._terminalEl);

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
		this._container.appendChild(contentWrapper);
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

		// 重新计算 cols — 手动根据容器宽度算出正确的列数，
		// 确保长行在终端宽度处换行，不溢出。
		this._refitTerminal();

		term.reset();

		const parts: string[] = [];

		for (const msg of this._messages) {
			if (msg.role === 'user') {
				parts.push(this._renderUserMsg(msg));
			} else if (msg.role === 'assistant') {
				parts.push(this._renderAssistantMsg(msg));
			}
		}

		term.write(parts.join(''), () => {
			// 渲染完成后重新计算 xterm 容器高度，让内容贴底显示
			// 使用 _recomputeLayout() 等待 DOM 布局稳定（避免 wrapperHeight=0 的问题）
			this._recomputeLayout();
		});
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

	layout(width: number, height: number): void {
		// 委托给 _recomputeLayout —— 内部使用 rAF 等待 DOM 布局完成
		// 即使首次调用时 wrapper 高度为 0，rAF 也会重试直到布局完成
		// 同时更新输入框的宽度
		if (this._textarea) {
			this._textarea.style.maxWidth = `${width - 40}px`;
		}
		// width/height 参数保留用于将来扩展
		void width; void height;
		this._recomputeLayout();
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
