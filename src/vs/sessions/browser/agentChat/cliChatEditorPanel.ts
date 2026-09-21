/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./media/cli-chat.css";
import { Disposable, DisposableStore, type IDisposable } from "../../../base/common/lifecycle.js";
// ★ 2026-09-21 第三轮：`clearNode` 已**全部移除** ✓ —— 本文件所有渲染入口都改成
//   「离屏构建 + 一次换入（内容未变则不碰 DOM）」✗⇒✓，不再有"先清空再重建"的写法 ✓。
//   （留着未使用的 import 会被 tsgo 的 noUnusedLocals 拦下 ✓ —— 这道严格性正好防止回退 ✓。）
import { addDisposableListener, EventType } from "../../../base/browser/dom.js";
import { renderMarkdown } from "../../../base/browser/markdownRenderer.js";
import type { IMarkdownString } from "../../../base/common/htmlContent.js";
import type {
	IAgentChatMessage,
	IToolCall,
	IChatAttachment,
	IAgentInfo,
	IProviderInfo,
	IModelInfo,
	IImageModelGroup,
	StreamPhase,
	IWorktreeItem,
	IWorkspaceItem,
	ISessionInfo,
	IAgentSessionMeta,
	IContextUsage,
	ICheckpointInfo,
	OrchestrationPlan,
	AgentStatus,
} from "./agentChatTypes.js";
import type { IChatPanel, IChatPanelCallbacks } from "./iChatPanel.js";

/** ★ 2026-09-21：TUI 面板代码块高亮的**一次性诊断**开关（每次会话只打一行 ✓）。 */
let _cliHlDiagDone = false;

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
	/** ★ 2026-09-21：rAF 合并重建（防闪烁 ✓，见 `_scheduleUpdateMessageElement` 注释 ✓）。 */
	private readonly _pendingRenderIds = new Set<string>();

	// ─── ★ 2026-09-21 第二轮：限频 + 慢渲染告警（用户报「转 TUI 后还是有闪烁」✓）──────────
	/** 两次消息重建之间的**最小间隔**（ms）：流式文本下每秒最多 ~12 次 ✓（此前每帧 ≈60 次 ✗）。 */
	private static readonly RENDER_MIN_INTERVAL_MS = 80;
	/** 超过此耗时即打 `[CliRender] ⚠ slow` 告警（TUI 侧此前零打点 ✗ ⇒ 无从取证 ✓）。 */
	private static readonly RENDER_SLOW_WARN_MS = 30;
	/** 上次真正执行重建的时间（限频用 ✓）。 */
	private _lastRenderAt = 0;
	/** 限频等待中的定时器（0 = 无 ✓）。 */
	private _renderTimer = 0;
	/**
	 * 状态栏 / 提示行 上次渲染的**文本签名**（第三轮 ✓：相同 ⇒ 一次 DOM 都不碰 ✓✓）。
	 *
	 * 为什么用文本而不是结构化 key ✗✓：签名必须覆盖"所有会让用户看到变化的量" ✓，
	 * 而结构化 key 一漏字段就会出现"值变了却不刷新" ✗（比闪烁更糟 ✓）。文本签名天然完备 ✓。
	 */
	private _lastStatusText = '';
	private _lastMetaText = '';
	/**
	 * ★★★ 第四轮：屏蔽「内容变更**自触发**的滚动事件」✗✓。
	 *
	 * 背景（用户报「底部内容无法滚动、看不到」✓）：滚动容器里的内容一变 ✓，浏览器就会
	 * 重新计算 `scrollHeight` 并把 `scrollTop` 夹回合法范围 ✓、随后**派发 `scroll`** ✗ ⇒
	 * 监听器算出"离底很远" ⇒ `_autoScroll = false` ✗✓ ⇒ **自动跟随永久失效** ✓✓。
	 * ⇒ 凡是我们自己改内容 / 自己写 `scrollTop` 的瞬间都置位本标记 ✓，
	 *   下一帧清掉 ✓（`scroll` 事件是同帧末尾/下一帧派发 ✓ 足以覆盖 ✓）。
	 */
	private _suppressScrollSync = false;
	/** ★ 第五轮：布局探针限频（≤1 行/秒 ✓，见 `_logLayoutProbe` ✓）。 */
	private _lastProbeAt = 0;
	private _renderRaf = 0;

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
		// ★★★ 2026-09-21 第四轮（用户报「**底部内容无法滚动、看不到**」✗✓）：
		//   必须忽略"我们自己造成"的滚动事件 ✗ —— 内容变高/被替换时浏览器会**自行**把
		//   `scrollTop` 夹紧并派发 `scroll` ✓，监听器据此把 `_autoScroll` 判成 `false` ✗✓
		//   ⇒ **自动跟随永久关闭** ⇒ 流式新内容全在下方看不见 ✓✓（这正是用户报的症状 ✓）。
		this._disposables.add(addDisposableListener(this._messagesScroll, EventType.SCROLL, () => {
			if (this._suppressScrollSync) { return; } // 自触发 ✓ ⇒ 不改判定 ✓
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

	patchAgent(agent: IAgentInfo): void {
		// CLI 面板没有图形化 header，直接替换字段即可（定义变更只影响 prompt meta 行）
		if (!this._agent || this._agent.id !== agent.id) { return; }
		this._agent = agent;
		this._renderPromptMeta();
	}

	setAgentStatus(status: AgentStatus): void {
		// CLI 面板无状态圆点；仅记录字段，避免与 Chat 面板的 agent 实体状态脱节。
		if (!this._agent || this._agent.status === status) { return; }
		this._agent = { ...this._agent, status };
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

	// 图片模型（2026-09-10）：CLI 面板不渲染该下拉，no-op。
	setImageModels(_groups: IImageModelGroup[]): void { /* no-op */ }

	setCurrentImageModel(_preference: string): void { /* no-op */ }

	// ═════════════════════════════════════════════════════════════════
	// IChatPanel — Messages
	// ═════════════════════════════════════════════════════════════════

	setMessages(messages: IAgentChatMessage[]): void {
		this._messages = messages.slice();
		// ★ 第五轮：载入/切换会话的语义就是"**看最新**" ✓ ⇒ 强制恢复跟随 ✗✓
		//   （否则上一会话里"用户曾往上滚"留下的 `_autoScroll=false` 会被带过来 ✓，
		//    表现为"新会话打开就停在半截、看不到底部" ✗✓ —— 与用户截图同症状 ✓）
		this._autoScroll = true;
		this._renderAllMessages();
		this._scrollToBottom(false);
	}

	addMessage(message: IAgentChatMessage): void {
		this._messages.push(message);
		// ★★★ 第五轮：**这条路是"直接插进活容器"** ✗（不经 `_updateMessageElement` ✓）⇒
		//   此前既没有锚点恢复、也没有贴底二次滚动 ✓ ⇒ 正是"新消息出现在折线以下、
		//   而且怎么滚都差一点"的来源之一 ✓✓。改为与其它路径**同一套**处理 ✓。
		const scroller = this._messagesScroll;
		const prevTop = scroller.scrollTop;
		const prevHeight = scroller.scrollHeight;
		const wasAtBottom = prevHeight - prevTop - scroller.clientHeight < 60;
		this._appendMessageElement(message);
		this._afterContentMutation(scroller, prevTop, prevHeight, wasAtBottom);
	}

	updateMessage(messageId: string, updates: Partial<IAgentChatMessage>): void {
		const idx = this._messages.findIndex(m => m.id === messageId);
		if (idx < 0) { return; }
		this._messages[idx] = { ...this._messages[idx], ...updates };
		// Re-render the single message element
		this._scheduleUpdateMessageElement(messageId);
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
		// ★★★ 2026-09-21 第二轮：流**结束**时必须再渲染一次最后一条 assistant ✓ ——
		//   因为流式期间刻意**禁用异步代码块高亮** ✓（避免"先没代码块再补上"的两段式闪烁 ✓）；
		//   若不在这里补一次"高亮版"渲染，代码块会**永远停在朴素 `<pre>`** ✗✓。
		if (phase === 'idle') {
			const last = this._messages.findLast(m => m.role === 'assistant');
			if (last) { this._scheduleUpdateMessageElement(last.id); }
		}
	}

	setStreamTextBuffer(buffer: string): void {
		this._streamTextBuffer = buffer;
		// Update the last assistant message's text content
		const last = this._messages.findLast(m => m.role === 'assistant');
		if (last) {
			this._scheduleUpdateMessageElement(last.id);
		}
	}

	setStreamThinkingBuffer(buffer: string): void {
		this._streamThinkingBuffer = buffer;
		const last = this._messages.findLast(m => m.role === 'assistant');
		if (last) {
			this._scheduleUpdateMessageElement(last.id);
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
		// ★ 2026-09-21 第二轮：同样改成**离屏构建 + 一次换入** ✓ ——
		// 此前是"清空整个容器 → 逐条 append" ✗ ⇒ 载入/切换会话时会有一整帧**空白** ✓
		// （TUI 下表现为"闪一下"✓）。离屏构建后一次 `replaceChildren` ⇒ 结构上无空白帧 ✓。
		//
		// ★★★ 第四轮补齐：整段换入同样会让 `scrollHeight` 塌陷 ✗ ⇒ **锚点与屏蔽**一并加上 ✓
		//   （载入会话是"期望贴底"的语义 ✓ ⇒ 换入后直接贴底 ✓，并把 `_autoScroll` 设为 true ✓）。
		this._markdownDisposables.forEach(d => d.dispose());
		this._markdownDisposables.clear();

		const scratch = document.createElement('div');
		// 复用既有建卡路径 ✓（把**目标容器**作为参数传入 ⇒ 无需临时改写字段 ✗）
		for (const msg of this._messages) {
			this._appendMessageElement(msg, scratch);
		}
		const scroller = this._messagesScroll;
		const prevTop = scroller.scrollTop;
		const prevHeight = scroller.scrollHeight;
		const wasAtBottom = prevHeight - prevTop - scroller.clientHeight < 60;
		this._messagesContainer.replaceChildren(...Array.from(scratch.childNodes));
		this._afterContentMutation(scroller, prevTop, prevHeight, wasAtBottom);
	}

	/**
	 * 建一条消息的 DOM 并挂到 `target` ✓（默认挂到消息容器 ✓）。
	 *
	 * `target` 参数专供 `_renderAllMessages` 的**离屏构建** ✓（先建在游离节点上 ✓，
	 * 再一次性换入 ⇒ 消除"整段空白帧" ✗✓）。
	 */
	private _appendMessageElement(msg: IAgentChatMessage, target: HTMLElement = this._messagesContainer): void {
		const el = document.createElement('div');
		el.className = 'cli-msg-row';
		el.dataset.messageId = msg.id;
		el.dataset.role = msg.role;

		if (msg.role === 'user') {
			this._renderUserMessage(msg, el);
		} else if (msg.role === 'assistant') {
			this._renderAssistantMessage(msg, el);
		}

		target.appendChild(el);
	}

	/**
	 * ★★★ 2026-09-21（用户报「TUI 下聊天框 UI 闪烁严重」✓）：
	 * **rAF 合并**地重建消息元素。
	 *
	 * 根因：`_updateMessageElement` 走 `clearNode(el)` **整条重建** ✗（`:528` ✓），
	 * 而它被**每个流式 delta** 直接调用（`updateMessage` :275 / 流式路径 :344/:352 ✓）——
	 * 一秒钟几十次「清空 + 重建」⇒ 文字/表格/代码块反复消失再现 ⇒ **严重闪烁** ✓✓
	 * （日志佐证：`[ChatPerf] ⚠ SLOW render.appendDom=134ms` / `parts.render=59.4ms` ✓）。
	 *
	 * 做法：与主聊天同款 —— 把重建**合并到一帧一次** ✓（同一消息一帧内多次更新只重建一次 ✓）。
	 */
	private _scheduleUpdateMessageElement(messageId: string): void {
		this._pendingRenderIds.add(messageId);
		if (this._renderRaf !== 0 || this._renderTimer !== 0) { return; }
		// ★★★ 2026-09-21（第二轮，用户报「转 TUI 后**还是有闪烁**」✓）：
		// 第一轮只做了 rAF 合并 ✓ —— 但 `_updateMessageElement` 仍是「清空 + 整条重建」✗，
		// 合并到"每帧一次"依然等于**每秒最多 60 次空白帧** ✗⇒ 长消息（表格/代码块）照闪 ✓✓。
		// 本轮两道修：① 离屏构建 + **一次换入**（结构上不存在空白帧 ✓✓）；
		//            ② **限频 80ms**（每秒最多 ~12 次重建，流式文本足够顺滑 ✓，CPU 降 ~5× ✓）。
		const elapsed = Date.now() - this._lastRenderAt;
		const wait = CliChatEditorPanel.RENDER_MIN_INTERVAL_MS - elapsed;
		if (wait > 0) {
			this._renderTimer = window.setTimeout(() => {
				this._renderTimer = 0;
				this._flushPendingMessageRenders();
			}, wait);
			return;
		}
		this._flushPendingMessageRenders();
	}

	/** 把本批次（`_pendingRenderIds`）的重建排到下一帧执行 ✓（合并 + 限频的落点 ✓）。 */
	private _flushPendingMessageRenders(): void {
		if (this._renderRaf !== 0) { return; }
		this._renderRaf = window.requestAnimationFrame(() => {
			this._renderRaf = 0;
			this._lastRenderAt = Date.now();
			const ids = [...this._pendingRenderIds];
			this._pendingRenderIds.clear();
			const t0 = performance.now();
			for (const id of ids) { this._updateMessageElement(id); }
			const cost = performance.now() - t0;
			// ★ TUI 侧此前**完全没有渲染打点** ✗（真机日志里 `cliChat` 命中 0 ✓）⇒
			//   "还在闪"时无从证明/证伪 ✓。这里补上：只在**慢**时打（避免刷屏 ✗）。
			if (cost > CliChatEditorPanel.RENDER_SLOW_WARN_MS) {
				// ⚠ 本类**没有注入 logService** ✗ —— 用 `console.info`（与 native 侧 `[ChatFlickerDiag]`
				//   同款 ✓）；该行**确实会进日志文件** ✓（真机日志里能看到 `[ChatFlickerDiag]` ✓）。
				console.info(
					`[CliRender] ⚠ slow message rebuild: ${ids.length} msg(s) in ${cost.toFixed(1)}ms ` +
					`(throttle=${CliChatEditorPanel.RENDER_MIN_INTERVAL_MS}ms) — 若仍见闪烁请贴此行 ✓`,
				);
			}
		});
	}

	/**
	 * 重建**单条消息** —— ★ 离屏构建 + **一次性换入** ✓✓。
	 *
	 * 为什么必须离屏（用户第二轮实测 ✗✓）：此前是 `clearNode(el)` → 再逐段 append ✓，
	 * 中间的"空元素"状态会被浏览器**画出至少一帧** ✗ ⇒ 表格/代码块反复消失再现 = 闪烁 ✓。
	 * 改为：先在**游离节点**上把内容建好 ✓，再用 `replaceChildren(...)` 一次换入 ✓ ——
	 * 结构上不存在"空"的中间态 ✓，浏览器只会在同一帧内看到旧内容 → 新内容 ✓✓。
	 *
	 * ⚠ 两个必须回写的属性 ✗（渲染函数会改写它们 ✓）：
	 *   · `className`（如 user 消息加 `cli-user-msg` ✓ / agent 配色类 ✓）；
	 *   · `style.cssText`（user 消息用 CSS 变量 `--cli-msg-border-color` 上色 ✓）。
	 */
	private _updateMessageElement(messageId: string): void {
		const el = this._messagesContainer.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
		if (!el) { return; }
		const msg = this._messages.find(m => m.id === messageId);
		if (!msg) { return; }

		// ── 离屏构建（游离节点，不进文档 ⇒ 不会被绘制 ✓）
		const scratch = document.createElement('div');
		scratch.className = el.className;
		scratch.dataset.messageId = el.dataset.messageId;
		scratch.dataset.role = el.dataset.role;
		if (msg.role === 'user') {
			this._renderUserMessage(msg, scratch);
		} else if (msg.role === 'assistant') {
			this._renderAssistantMessage(msg, scratch);
		}

		// ★★★ 2026-09-21 第四轮（用户报「依旧闪烁 + **底部无法滚动/看不到**」✗✓）：
		//   真凶 = 本方法原第 ①步 `el.replaceChildren(...)` ✗ —— 它**先清空再加回** ✓，
		//   清空那一瞬滚动容器的 `scrollHeight` **塌陷** ⇒ 浏览器立刻把 `scrollTop` **夹回去** ✗✓
		//   ⇒ 流式期每 80ms 发生一次，后果两连 ✗✓✓：
		//     · 用户刚滚下去就被拽回 ⇒ **"无法滚动"** ✓；
		//     · 每帧"塌陷 → 恢复"整屏重排 ⇒ **"还在闪"** ✓（所以前三轮只治绘制、治不住 ✓✓）。
		//   ⇒ 修法分两层 ✓：①**结构未变 ⇒ 就地更新文本**（零节点变更 ✓✓，流式期常态 ✓）；
		//     ② 真要换入时**保住滚动锚点** ✓（见 `_afterContentMutation` ✓）。
		const scroller = this._messagesScroll;
		const prevTop = scroller.scrollTop;
		const prevHeight = scroller.scrollHeight;
		const wasAtBottom = prevHeight - prevTop - scroller.clientHeight < 60;

		// ① 就地更新（不换节点 ⇒ 不塌陷、不重排、不动滚动与选区 ✓✓）
		if (this._updateTextInPlace(el, scratch)) {
			this._afterContentMutation(scroller, prevTop, prevHeight, wasAtBottom);
			return;
		}

		// ② 结构变了（新段落 / 代码块 / 工具卡片 ✓）⇒ 换入，但先保住锚点 ✓
		// Dispose old markdown disposables in this element（必须在**换入之前**做 ✓，
		// 因为它们按元素归属登记 ✓，换入后旧节点会被 detach 出去 ✓）
		// ⚠ 只有走到这里才 dispose ✗✓ —— 就地更新时节点仍在，提前 dispose 会让
		//   markdown 交互（链接 / 复制 ✓）失效 ✗✓。
		const toRemove: HTMLElement[] = [];
		this._markdownDisposables.forEach((d, key) => {
			if (el.contains(key)) { toRemove.push(key); }
		});
		for (const key of toRemove) {
			this._markdownDisposables.get(key)?.dispose();
			this._markdownDisposables.delete(key);
		}

		// 一次性换入：先 `replaceChildren`（清 + 加在同一帧内完成 ✓），
		// 再回写被渲染函数改写的属性 ✓（顺序不可反 ✗——反了会先显示默认样式再跳变 ✓）
		el.replaceChildren(...Array.from(scratch.childNodes));
		if (scratch.className !== el.className) { el.className = scratch.className; }
		if (scratch.style.cssText !== el.style.cssText) { el.style.cssText = scratch.style.cssText; }

		this._afterContentMutation(scroller, prevTop, prevHeight, wasAtBottom);
	}

	/**
	 * ★★★ 第四轮核心：**结构未变 ⇒ 就地更新文本**（一个节点都不换 ✓✓）。
	 *
	 * 判据（{@link _sameStructure}）：子节点一一对应且 `tagName` + `className` + 子树结构相同 ✓；
	 * 只有文本变了才写 `textContent` ✓（写相同值是 no-op ⇒ 浏览器不重排 ✓）。
	 * 结构一变（新段落 / 代码块 / 工具卡片 ✓）即返回 `false` ⇒ 交给替换路径并保住锚点 ✓。
	 *
	 * ⚠ 必须**先全量校验、再统一写入** ✗✓ —— 边校验边写会在中途 `return false` 时留下半套改动 ✗。
	 * ⚠ 层数上界（`_sameStructure` 递归 ✓）由真实 DOM 深度决定 ✓（消息体 ≤ 3–4 层 ✓）。
	 */
	private _updateTextInPlace(el: HTMLElement, scratch: HTMLElement): boolean {
		if (el.children.length !== scratch.children.length || el.children.length === 0) { return false; }
		if (!this._sameStructure(el, scratch)) { return false; }
		this._applyText(el, scratch);
		return true;
	}

	/** 结构比对（递归 ✓，只比标签/类名/子数 ✓ —— 不比文本 ✓，文本由 `_applyText` 处理 ✓）。 */
	private _sameStructure(a: Element, b: Element): boolean {
		if (a.children.length !== b.children.length) { return false; }
		for (let i = 0; i < a.children.length; i++) {
			const x = a.children[i];
			const y = b.children[i];
			if (x.tagName !== y.tagName || x.className !== y.className) { return false; }
			if (!this._sameStructure(x, y)) { return false; }
		}
		return true;
	}

	/** 落地写入（叶子写 `textContent` ✓，有子则递归 ✓）。 */
	private _applyText(a: Element, b: Element): void {
		if (a.children.length === 0) {
			if (a.textContent !== b.textContent) { a.textContent = b.textContent; }
			return;
		}
		for (let i = 0; i < a.children.length; i++) {
			this._applyText(a.children[i], b.children[i]);
		}
	}

	/**
	 * ★★★ 第四轮：内容变更后的**滚动锚点恢复** ✓（"用户看不到底部 / 滚不动"的正面修法 ✓）。
	 *
	 *   · 变更前**贴底**（或跟随开启 ✓）⇒ 变更后继续贴底 ✓，并把 `_autoScroll` **复位为 true** ✓
	 *     —— 否则一旦曾被误判为 `false`，状态会一直卡住 ✗✓；
	 *   · 否则 ⇒ 按 `scrollHeight` 增量**补偿** ✓（等价于 CSS `overflow-anchor` 的手动版 ✓），
	 *     **用户当前视点不动** ✓ ⇒ 手动滚动不再被拽回 ✓✓；
	 *   · 最后屏蔽紧随的**自触发** `scroll` 事件 ✓（见 `_suppressScrollSync` ✓），
	 *     否则监听器会把"离底很远"写回 `_autoScroll = false` ✗✓。
	 */
	private _afterContentMutation(
		scroller: HTMLElement,
		prevTop: number,
		prevHeight: number,
		wasAtBottom: boolean,
	): void {
		if (wasAtBottom || this._autoScroll) {
			this._pinToBottom(scroller);
			this._autoScroll = true;
		} else {
			const delta = scroller.scrollHeight - prevHeight;
			if (delta !== 0) { scroller.scrollTop = prevTop + delta; }
		}
		this._suppressScrollSync = true;
		requestAnimationFrame(() => { this._suppressScrollSync = false; });
		this._logLayoutProbe(scroller);
	}

	/**
	 * ★★★ 2026-09-21 第五轮（用户报「**TUI 底部文字被遮挡**」+ 截图：最后一行切在半行 ✗✓）：
	 * 贴底必须**滚两次** ✗✓ —— 只滚一次不够 ✓：
	 *   ① 同步写：此刻**新内容的布局可能还没刷新** ✗ ⇒ 读到的 `scrollHeight` **偏小** ✓；
	 *   ② 下一帧再写：布局刷新后补到真正的底部 ✓✓。
	 * 只做 ① 的后果正是用户截图里那样：**停在离底一行** ✗、且因为"自认为到底了"⇒ 再往下滚也滚不动 ✓✓。
	 *
	 * ⚠ 不要在 `setTimeout`/多帧里反复滚 ✗ —— 那会与用户手动滚动**抢**（"滚下去又被拽回" ✓✓）；
	 *   本方法只在"变更前贴底/跟随开启"时才被调用 ✓，两次写入落在**同一帧 + 下一帧** ✓ 足够 ✓。
	 */
	private _pinToBottom(scroller: HTMLElement): void {
		scroller.scrollTop = scroller.scrollHeight;
		requestAnimationFrame(() => {
			// 布局已刷新 ⇒ 这里才是真正的底部 ✓（同时屏蔽其自触发 scroll 事件 ✓）
			this._suppressScrollSync = true;
			scroller.scrollTop = scroller.scrollHeight;
			requestAnimationFrame(() => { this._suppressScrollSync = false; });
		});
	}

	/**
	 * ★★★ 第五轮：**布局探针** ✓ —— 只做诊断（每秒最多 1 行 ✓），不是修法 ✗。
	 *
	 * 打点内容刻意选成能"一眼判死因"的四个量 ✓：
	 *   `scroll`（client/scroll/top ✓）⇒ `top < scroll-client` 就说明**没到底** ✗（滚动 bug ✓）；
	 *   等于却仍被遮挡 ⇒ 说明是**盒模型/遮挡**问题 ✗✓（父级裁切或覆盖 ✓）；
	 *   `panel`（面板高 ✓）与 `inputTop`（输入区上沿 ✓）⇒ 判断输入区是否**压在**滚动区上 ✗。
	 */
	private _logLayoutProbe(scroller: HTMLElement): void {
		const now = Date.now();
		if (now - this._lastProbeAt < 1000) { return; }
		this._lastProbeAt = now;
		const max = scroller.scrollHeight - scroller.clientHeight;
		const inputTop = this._promptMetaRow?.parentElement?.offsetTop ?? -1;
		console.info(
			`[CliLayout] scroll=${scroller.clientHeight}/${scroller.scrollHeight}/top=${scroller.scrollTop} ` +
			`max=${max} atBottom=${scroller.scrollTop >= max - 1} auto=${this._autoScroll} ` +
			`panel=${this._container.clientHeight} inputTop=${inputTop} msgs=${this._messages.length}`,
		);
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
			content.appendChild(this._renderThinking(thinking, msg.isThinking ?? false, msg.isStreaming === true));
		}

		// Text content (markdown)
		const text = this._getAssistantText(msg);
		if (text && text.trim()) {
			const textEl = document.createElement('div');
			textEl.className = 'cli-assistant-text';
			// ★ 流式期间**不启用异步代码块高亮** ✓（否则每次重建都会"先没代码块再补上" ⇒ 闪烁 ✓✓）
			this._renderMarkdown(textEl, text, msg.isStreaming === true);
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

	private _renderThinking(text: string, isRunning: boolean, streaming = false): HTMLElement {
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
			// ★ 同上：流式期间不做异步代码块高亮（否则每次重建都会闪一下代码块 ✓✓）
			this._renderMarkdown(body, text, streaming);

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
		// ★ 同上（第三轮）：离屏构建 + 内容未变则不碰 DOM ✓（此前 `clearNode` 直觉重建 ✗）
		const scratch = document.createElement('div');
		const host = scratch as HTMLElement;

		const agentName = this._agent?.name ?? 'Build';
		const agentEl = document.createElement('span');
		agentEl.className = 'cli-meta-agent';
		agentEl.textContent = agentName;
		host.appendChild(agentEl);

		if (this._currentModel) {
			const sep = document.createElement('span');
			sep.className = 'cli-meta-sep';
			sep.textContent = '·';
			host.appendChild(sep);

			const modelEl = document.createElement('span');
			modelEl.className = 'cli-meta-model';
			modelEl.textContent = this._currentModel;
			host.appendChild(modelEl);
		}

		if (this._currentProvider) {
			const providerEl = document.createElement('span');
			providerEl.className = 'cli-meta-provider';
			providerEl.textContent = this._currentProvider;
			host.appendChild(providerEl);
		}

		if (scratch.textContent !== this._lastMetaText) {
			this._lastMetaText = scratch.textContent ?? '';
			this._promptMetaRow.replaceChildren(...Array.from(scratch.childNodes));
		}
		return this._promptMetaRow;
	}

	/**
	 * 状态栏（左下"Thinking…/Ready" + 右下 token 计数 ✓）。
	 *
	 * ★★★ 2026-09-21 第三轮（用户报「**整个聊天框**都在闪」✓，根因在这✓）：
	 * 本方法此前是 `clearNode(this._statusBar)` + 重建 ✗，而它被 **`setContextUsage` / `setStreamPhase`
	 * 在每个 delta 上调用** ✓ ⇒ 流式期间状态栏被清空重建几十次/秒 ✗。
	 * 两个可见后果：① 每次重建都是"先空后满" ⇒ 闪 ✗；② **`.cli-spinner` 是 CSS 动画 ⇒
	 * 重建等于把动画反复从头播** ✗✓（视觉上就是"一直在闪" ✓✓）。
	 *
	 * 修法与消息一致 ✓，但更进一步：**内容没变就一次 DOM 都不碰** ✓✓ ——
	 * 先在**游离节点**上构建 ✓，把 `textContent` 当签名比一下 ✓：
	 *   · 相同 ⇒ **直接丢弃 scratch** ✓（零 DOM 变更 ⇒ 零重绘 ⇒ **动画不重启** ✓✓）；
	 *   · 不同 ⇒ 一次 `replaceChildren` 换入 ✓（无空白帧 ✓）。
	 * 这也是流式期的常态（phase 与 token 计数在多数 delta 下并不变 ✓）。
	 */
	private _renderStatusBar(): void {
		const scratch = document.createElement('div');
		const host = scratch as HTMLElement;

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
			host.appendChild(left);
		} else {
			const left = document.createElement('div');
			left.className = 'cli-status-left';
			const idle = document.createElement('span');
			idle.className = 'cli-status-idle';
			idle.textContent = 'Ready';
			left.appendChild(idle);
			host.appendChild(left);
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
		host.appendChild(right);

		// ★ 文本签名相同 ⇒ **不碰 DOM**（保留动画与既有节点 ✓，零重绘 ✓✓）
		if (scratch.textContent === this._lastStatusText) { return; }
		this._lastStatusText = scratch.textContent ?? '';
		this._statusBar.replaceChildren(...Array.from(scratch.childNodes));
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

	private _renderMarkdown(container: HTMLElement, text: string, streaming = false): void {
		try {
			const md: IMarkdownString = { value: text, isTrusted: false };
			// ★★ 2026-09-21：优先用工作台暴露的「**带语法高亮**代码块渲染器」✓
			//（`workbench.ts` 注入 globalThis ✓，内含 tokenizeToString + Trusted Types policy ✓，
			//  与编辑器同源 ✓）⇒ 代码块获得 `.mtk*` 令牌着色 ✓（对齐 pi 的 `syntax*` 令牌 ✓）。
			// 拿不到钩子就**回退**到原朴素 `<pre>` ✓（行为与改造前一致 ✓，零风险 ✓）。
			//
			// ★★★ 2026-09-21 第二轮（用户报「TUI 依然闪烁」✓，根因在这✓）：
			//   `codeBlockRenderer` 是 **async** 的 ✓ ⇒ `renderMarkdown` **分两段出 DOM**：
			//   先画文本/表格 ✓，代码块要等 Promise 才插入 ✓ ⇒ 每次重建都会有**一帧没有代码块**
			//   的状态 ✗✓。而流式期间每 80ms 就重建一次 ⇒ **每 80ms 把代码块抹掉再画** ✗✗ = 闪烁 ✓✓。
			//   ⇒ **流式期间禁用异步高亮** ✓（改用同步朴素 `<pre>` ⇒ 结构上不可能两段式 ✓）；
			//     流结束后的最后一次渲染仍是高亮版 ✓（视觉最终一致 ✓，且只闪 0 次 ✓）。
			const hlCodeBlock = streaming
				? undefined
				: (globalThis as unknown as {
					__SAROSIS_MD_CODE_BLOCK_RENDERER__?: (alias: string | undefined, code: string) => Promise<HTMLElement>;
				}).__SAROSIS_MD_CODE_BLOCK_RENDERER__;
			const result = renderMarkdown(md, {
				codeBlockRenderer: hlCodeBlock
					? (lang, value) => hlCodeBlock(lang, value)
					: async (lang, value) => {
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
			// ★★★ 2026-09-21 诊断（用户报 TUI 高亮「未生效」✓）：每次会话只打一行 ✓ ——
			//   判据同主聊天：钩子 ✓ / 产出 ✓ / mtk 令牌 ✓ / **令牌 span 的实际计算颜色** ✓。
			if (!_cliHlDiagDone) {
				_cliHlDiagDone = true;
				window.setTimeout(() => {
					try {
						const host = container.querySelector('.monaco-tokenized-source') as HTMLElement | null;
						const span = container.querySelector('span[class*="mtk"]') as HTMLElement | null;
						console.info(
							`[MdHighlight] cli-panel diag: hook=${typeof hlCodeBlock === 'function' ? 'yes' : 'NO'}`
							+ ` tokenizedHost=${!!host} spanFound=${!!span}`
							+ ` tokenColor=${span ? getComputedStyle(span).color : 'n/a'}`
							+ ` bodyColor=${getComputedStyle(container).color}`,
						);
					} catch { /* 诊断失败不影响渲染 ✓ */ }
				}, 400);
			}
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
				// ★ 第五轮：统一走 `_pinToBottom`（同步 + 下一帧各一次 ✓）——
				//   只滚一次会因"布局未刷新 ⇒ `scrollHeight` 偏小"而**停在离底一行** ✗✓
				//   （用户截图里那行被切即是此因 ✓）。同时屏蔽自触发 scroll 事件 ✓。
				this._pinToBottom(this._messagesScroll);
			}
		});
	}

	override dispose(): void {
		// ★ 限频定时器必须清掉 ✗：否则释放后它仍会触发 ⇒ 去操作已销毁的 DOM ✓✓
		if (this._renderTimer !== 0) { window.clearTimeout(this._renderTimer); this._renderTimer = 0; }
		this._pendingRenderIds.clear();
		this._markdownDisposables.forEach(d => d.dispose());
		this._markdownDisposables.clear();
		this._disposables.dispose();
		super.dispose();
	}
}
