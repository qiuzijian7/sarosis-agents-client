import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IAgentChatMessage, IToolCall, ITextMessagePart, IThinkingMessagePart, IMessagePart } from './agentChatTypes.js';
import { buildKeyedParts, lastTextPartKey, IKeyedPart } from './agentChatPanel.keyedParts.js';
import { AgentChatPanelDropdowns } from './agentChatPanel.dropdowns.js';
import { filterChildSubAgents } from './subAgentCardUtils.js';

/** P5b：_updateMessageDom 责任链上下文（预计算的结构标志，供各 rule 共享）。 */
interface IMsgUpdateCtx {
	readonly idx: number;
	readonly msg: IAgentChatMessage;
	readonly el: HTMLElement;
	/** toolCalls 或 parts 中的工具段数 > 0 */
	readonly hasToolCalls: boolean;
	/** 是否存在结构性内容（工具/确认/子代理/工作流/变量收集） */
	readonly hasStructuralChange: boolean;
	/** parts-based 渲染是否激活 */
	readonly hasParts: boolean;
}

/** P5b：消息更新规则。handle 返回 true 表示该路径已处理，终止责任链。 */
interface IMsgUpdateRule {
	readonly name: string;
	handle(ctx: IMsgUpdateCtx): boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature: messages. Extracted from AgentChatPanelBase.
export class AgentChatPanelMessages extends AgentChatPanelDropdowns {

protected override _renderMessagesArea(): void {
		this._messagesWrapper = append(
			this._container,
			$(".chat-messages-wrapper"),
		);
		this._messagesContainer = append(
			this._messagesWrapper,
			$(".chat-messages"),
		);

		const SCROLL_THRESHOLD = 80; // 匹配 React 80px 阈值

		// ── 辅助：检测是否在底部 ──
		const checkAtBottom = (): boolean => {
			if (!this._messagesContainer) { return false; }
			const el = this._messagesContainer;
			return (el.scrollHeight - el.scrollTop - el.clientHeight) < SCROLL_THRESHOLD;
		};

		// ── 辅助：更新按钮可见性 ──
		const updateScrollButtons = (atBottom: boolean) => {
			const show = !atBottom;
			if (show !== this._showScrollBtn) {
				this._showScrollBtn = show;
			if (this._scrollToBottomBtn) {
				this._scrollToBottomBtn.classList.toggle("visible", show);
			}
			}
		};

		// ── SCROLL 事件：恢复/暂停自动滚动（rAF 节流）──
		let scrollRafId: number | null = null;
		this._register(
			addDisposableListener(this._messagesContainer, EventType.SCROLL, () => {
				if (scrollRafId !== null) { return; }
				scrollRafId = requestAnimationFrame(() => {
					scrollRafId = null;
					const atBottom = checkAtBottom();
					// 流式期间不由 SCROLL 事件接管 _isAtBottom：内容持续增长会让
					// 位置瞬时落在 80px 阈值内，把 WHEEL-up 刚置 false 的标志立刻
					// 翻回 true，导致用户无法滚离。流式期间由 WHEEL / 拖拽 / 触屏
					// 处理器独占维护 _isAtBottom（见下方 WHEEL / TOUCHSTART /
					// 滚动条拖拽各处理器）。
					if (!this._isDraggingScrollbar && !this._isSending) {
						if (atBottom) {
							this._isAtBottom = true;
							// 用户手动滚到底部 → 清零未读计数
							if (this._unreadCount > 0) {
								this._unreadCount = 0;
								this._scrollbar.updateScrollBadge();
							}
						} else {
							// 非流式期间，滚离底部 → 暂停自动跟随
							this._isAtBottom = false;
						}
					}
					// 流式期间由 _startStreamScroll rAF 循环持续钉底，
					// 程序滚动触发的 SCROLL 事件不更新按钮（避免异步内容增长导致的误闪）
					if (!this._isSending) {
						updateScrollButtons(atBottom);
					}
				});
			}),
		);
		this._register({ dispose: () => { if (scrollRafId !== null) { cancelAnimationFrame(scrollRafId); } } });

		// ── WHEEL 事件：精细控制自动滚动 ──
		this._register(
			addDisposableListener(this._messagesContainer, EventType.WHEEL, (e: WheelEvent) => {
				if (e.deltaY < 0) {
					// 向上滚 → 立即暂停自动滚动
					this._isAtBottom = false;
					updateScrollButtons(false);
				} else if (e.deltaY > 0) {
					// 向下滚 → 检测是否到底，恢复自动跟随
					requestAnimationFrame(() => {
						if (checkAtBottom()) {
							this._isAtBottom = true;
							updateScrollButtons(true);
						}
					});
				}
			}),
		);

		// ── TOUCHSTART：触屏设备暂停自动滚动 ──
		this._register(
			addDisposableListener(this._messagesContainer, 'touchstart', () => {
				this._isAtBottom = false;
				updateScrollButtons(false);
			}),
		);

		// ── 创建下箭头 SVG ──
		const createDownArrowSvg = () => {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
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
			return svg;
		};

		// ── 回到底部按钮 ──
		this._scrollToBottomBtn = append(
			this._messagesWrapper,
			$(".scroll-to-bottom-btn.chat-scroll-bottom-btn"),
		);
		// 默认隐藏由 CSS opacity:0 控制（.visible 类触发淡入），避免 display 硬切换闪烁
		this._scrollToBottomBtn.classList.remove("visible");
		this._scrollToBottomBtn.appendChild(createDownArrowSvg());
		this._scrollToBottomBtn.title = "回到底部";
		// 未读消息计数 badge
		this._scrollBadge = append(this._scrollToBottomBtn, $('.scroll-badge'));
		this._scrollBadge.style.display = 'none';
		this._register(
			addDisposableListener(this._scrollToBottomBtn, EventType.CLICK, () => {
				// 平滑滚动到底部 + 清零未读计数
				if (this._messagesContainer) {
					this._messagesContainer.scrollTo({ top: this._messagesContainer.scrollHeight, behavior: 'smooth' });
				}
				this._isAtBottom = true;
				this._unreadCount = 0;
				this._scrollbar.updateScrollBadge();
				this._showScrollBtn = false;
				this._scrollToBottomBtn.classList.remove("visible");
			}),
		);

		// ── 自定义滚动条覆盖层 ──（必须在 _renderMessages 之前创建，
		//    否则 _refreshScrollMarkers 因 _customScrollbar===null 而跳过）
		this._customScrollbar = append(this._messagesWrapper, $('.chat-custom-scrollbar'));
		this._scrollbarTrack = append(this._customScrollbar, $('.chat-scrollbar-track'));
		this._scrollbarThumb = append(this._scrollbarTrack, $('.chat-scrollbar-thumb'));
		// Hover popup
		this._scrollbarPopup = append(this._customScrollbar, $('.chat-marker-popup'));
		const popupLabel = append(this._scrollbarPopup, $('.chat-marker-popup-label'));
		popupLabel.textContent = '用户消息';
		this._scrollbarPopupPreview = append(this._scrollbarPopup, $('.chat-marker-popup-preview'));
		const popupHint = append(this._scrollbarPopup, $('.chat-marker-popup-hint'));
		popupHint.textContent = '点击跳转到该消息';

		// Scroll sync — lightweight separate listener (rAF-throttled)
		this._register(
			addDisposableListener(this._messagesContainer, EventType.SCROLL, () => {
				this._scrollbar.scheduleScrollbarUpdate();
			}),
		);

		// Thumb drag
		let dragStartY = 0;
		let dragStartScrollTop = 0;
		this._register(
			addDisposableListener(this._scrollbarThumb, EventType.MOUSE_DOWN, (e: MouseEvent) => {
				this._isDraggingScrollbar = true;
				// 拖拽开始立即暂停自动钉底，防止流式 rAF 循环把视图拉回底部
				this._isAtBottom = false;
				dragStartY = e.clientY;
				dragStartScrollTop = this._messagesContainer.scrollTop;
				this._scrollbarThumb?.classList.add('dragging');
				e.preventDefault();
			}),
		);
		this._register(
			addDisposableListener(document, EventType.MOUSE_MOVE, (e: MouseEvent) => {
				if (!this._isDraggingScrollbar || !this._scrollbarThumb || !this._scrollbarTrack || !this._messagesContainer) { return; }
				const deltaY = e.clientY - dragStartY;
				const maxScroll = this._messagesContainer.scrollHeight - this._messagesContainer.clientHeight;
				const trackH = this._scrollbarTrack.offsetHeight - this._scrollbarThumb.offsetHeight;
				const scrollDelta = trackH > 0 ? (deltaY / trackH) * maxScroll : 0;
				this._messagesContainer.scrollTop = dragStartScrollTop + scrollDelta;
			}),
		);
		this._register(
			addDisposableListener(document, EventType.MOUSE_UP, () => {
				if (this._isDraggingScrollbar) {
					this._isDraggingScrollbar = false;
					this._scrollbarThumb?.classList.remove('dragging');
					// 拖拽结束：检测是否在底部，恢复自动跟随
					if (checkAtBottom()) {
						this._isAtBottom = true;
					}
				}
			}),
		);

		// Render existing messages (after scrollbar DOM exists so _refreshScrollMarkers works)
		this._renderMessages();

		// Initial update (deferred to next frame so layout is ready)
		this._scrollbar.scheduleScrollbarUpdate();
		// Deferred marker refresh — layout may not be ready during _renderMessages,
		// so retry on next frame when offsetHeight is correct
		requestAnimationFrame(() => this._scrollbar.refreshScrollMarkers());
	}

protected override _renderMessages(): void {
		if (!this._messagesContainer) { return; }
		if ((window as unknown as Record<string, unknown>).__SAROSIS_SCROLL_DIAG) {
			const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
			console.debug(`[ScrollDiag] _renderMessages count=${this._messages.length} _wasLoading=${this._wasLoading} caller: ${diagStack}`);
		}
		// Clean up all markdown disposables before clearing the DOM,
		// to prevent renderMarkdown disposable leaks across setMessages calls.
		this._cleanupMarkdownDisposables(this._messagesContainer);
		// P2: 断开旧的懒加载 observer
		if (this._lazyLoadObserver) {
			this._lazyLoadObserver.disconnect();
			this._lazyLoadObserver = null;
		}
		clearNode(this._messagesContainer);

		if (this._messages.length === 0) {
			const empty = append(this._messagesContainer, $(".chat-messages-empty"));
			append(empty, $("p", undefined, "还没有消息，开始对话吧"));
			return;
		}

		// P2: 懒加载渲染——只渲染最近的 VISIBLE_CHUNK 条消息，
		// 用户向上滚动时按需加载更早的消息。
		// 参考 VS Code WorkbenchObjectTree 虚拟化（只渲染可见区域）。
		const VISIBLE_CHUNK = 30;
		const total = this._messages.length;

		if (total <= VISIBLE_CHUNK) {
			// 小列表 — 同步渲染全部
			for (const msg of this._messages) {
				this._appendMessageDom(msg);
			}
			return;
		}

		// 大列表 — 只渲染最后 VISIBLE_CHUNK 条，其余懒加载
		const firstBatchStart = Math.max(0, total - VISIBLE_CHUNK);

		// 渲染最近的消息
		for (let i = firstBatchStart; i < total; i++) {
			this._appendMessageDom(this._messages[i]);
		}

		// 设置懒加载——观察第一个消息元素，进入视口时加载更多
		const firstEl = this._messagesContainer.firstElementChild as HTMLElement | null;
		if (firstEl && firstBatchStart > 0) {
			this._setupLazyLoad(firstEl, firstBatchStart);
		}

		// 刷新滚动条用户消息标记
		this._scrollbar.refreshScrollMarkers();
	}

protected override _setupLazyLoad(firstEl: HTMLElement, remainingCount: number): void {
		const CHUNK = 20;
		let nextEnd = remainingCount;

		const loadChunk = () => {
			if (!firstEl.isConnected || nextEnd <= 0) { return; }
			const nextStart = Math.max(0, nextEnd - CHUNK);
			const frag = document.createDocumentFragment();
			for (let i = nextStart; i < nextEnd; i++) {
				const el = this._createMessageElement(this._messages[i]);
				frag.appendChild(el);
			}
			// 保持滚动位置：插入前记录 scrollHeight，插入后修正 scrollTop
			const container = this._messagesContainer;
			if (!container) { return; }
			const prevScrollHeight = container.scrollHeight;
			const prevScrollTop = container.scrollTop;
			firstEl.parentNode?.insertBefore(frag, firstEl);
			// 修正滚动位置，避免内容插入后视图跳动
			const scrollDiff = container.scrollHeight - prevScrollHeight;
			if (scrollDiff > 0) {
				container.scrollTop = prevScrollTop + scrollDiff;
			}
			nextEnd = nextStart;
			// 刷新滚动条标记——消息插入后 offsetTop 全部偏移，旧标记位置失效
			this._scrollbar.refreshScrollMarkers();
		};

		const observer = new IntersectionObserver((entries) => {
			if (entries[0]?.isIntersecting && nextEnd > 0) {
				loadChunk();
			}
		}, {
			root: this._messagesContainer,
			threshold: 0.1,
			rootMargin: '200px 0px 0px 0px', // 提前 200px 预加载
		});
		observer.observe(firstEl);
		// P2: 存储到字段，下次 setMessages 时断开
		this._lazyLoadObserver = observer;
	}

protected override _appendMessageDom(msg: IAgentChatMessage): void {
		if (!this._messagesContainer) {
			return;
		}
		// Remove empty-state placeholder before appending the first real message.
		// 否则占位元素会一直作为 children[0] 存在，导致 _updateMessageDom 的
		// idx → children 映射整体偏移 1 位（流式更新错误地写到上一条消息的 DOM），
		// 同时 "还没有消息，开始对话吧" 文本也不会消失。
		const emptyEl = this._messagesContainer.querySelector('.chat-messages-empty');
		if (emptyEl) {
			emptyEl.remove();
		}
		const el = this._createMessageElement(msg);
		this._messagesContainer.appendChild(el);
	}

protected override _updateMessageDom(idx: number, msg: IAgentChatMessage): void {
	if (!this._messagesContainer) { return; }
	// P2: 使用 data-msg-id 查找元素，解除 idx → children[idx] 硬绑定。
	// 懒加载场景下 DOM 顺序与 _messages 数组顺序可能不一致（老消息后插入）。
	const existingEl = this._messagesContainer.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null;
	if (!existingEl) {
		if ((window as any).__SAROSIS_PARTS_DIAG) {
			console.warn(`[PartsDiag] _updateMessageDom idx=${idx} msgId=${msg.id} → SKIP: element not found in DOM`);
		}
		return;
	}

	// P5b：责任链分发——fast rules（就地更新）→ slow rules（转换/同步）→ 兜底重建。
	// 每条路径独立成 rule（原 7+ 分支级联 fallback 已收敛），新增场景只加 rule 不动主干。
	const ctx = this._buildMsgUpdateCtx(idx, msg, existingEl);
	if ((window as any).__SAROSIS_PARTS_DIAG) {
		const partsInfo = msg.parts ? `partsLen=${msg.parts.length} kinds=[${msg.parts.map(p => p.kind).join(',')}]` : 'parts=none';
		console.info(`[PartsDiag] _updateMessageDom idx=${idx} msgId=${msg.id} isStreaming=${msg.isStreaming} contentLen=${(msg.content||'').length} toolCalls=${msg.toolCalls?.length ?? 0} hasStructuralChange=${ctx.hasStructuralChange} ${partsInfo}`);
	}

	// 写文件流式：在任何 rule 短路前，先把运行中的写文件卡片已到达内容增量刷入滚动预览区。
	// 该步骤幂等、O(delta) 增量，不短路责任链——避免大文件在 tool_end 时一次性渲染 diff 卡住主线程。
	if (msg.isStreaming) {
		this._updateActiveWriteFileStreams(existingEl, msg);
	}

	for (const rule of this._msgUpdateFastRules) {
		if (rule.handle(ctx)) { return; }
	}

	if ((window as any).__SAROSIS_PARTS_DIAG) {
		console.info(`[PartsDiag] _updateMessageDom idx=${idx} msgId=${msg.id} → SLOWPATH (fallthrough to rebuild/update)`);
	}

	for (const rule of this._msgUpdateSlowRules) {
		if (rule.handle(ctx)) { return; }
	}

	// 兜底：全量重建。清理旧元素关联的 markdown disposables 防泄漏。
	this._cleanupMarkdownDisposables(existingEl);
	const newEl = this._createMessageElement(msg);
	this._messagesContainer.replaceChild(newEl, existingEl);
}

/** P5b：预计算结构标志，供责任链各 rule 共享（避免每条 rule 重复判定）。 */
private _buildMsgUpdateCtx(idx: number, msg: IAgentChatMessage, el: HTMLElement): IMsgUpdateCtx {
	const partsToolCount = msg.parts ? msg.parts.filter(p => p.kind === 'tool').length : 0;
	const hasToolCalls = (msg.toolCalls && msg.toolCalls.length > 0) || partsToolCount > 0;
	const hasStructuralChange =
		hasToolCalls ||
		msg.confirmation ||
		(msg.subAgents && msg.subAgents.length > 0) ||
		(msg.workflowExecutions && Object.keys(msg.workflowExecutions).length > 0) ||
		(msg.workflowEvents && msg.workflowEvents.length > 0) ||
		(msg.collectVariables && Object.keys(msg.collectVariables).length > 0);
	return {
		idx,
		msg,
		el,
		hasToolCalls,
		hasStructuralChange: !!hasStructuralChange,
		hasParts: !!(msg.parts && msg.parts.length > 0),
	};
}

// Fast rules：keyed-reconcile 统一处理所有 part 变化（替代原 6 条手写规则）
private readonly _msgUpdateFastRules: IMsgUpdateRule[] = [
	{ name: 'thinking-state-change', handle: (c) => this._ruleThinkingStateChange(c) },
	{ name: 'keyed-reconcile', handle: (c) => this._ruleKeyedReconcile(c) },
	];

// Slow rules：顺序即原分支顺序（流式结束转换 → 首个 tool_start 追加 → 工具状态同步）
private readonly _msgUpdateSlowRules: IMsgUpdateRule[] = [
	{ name: 'stream-end-transition', handle: (c) => this._ruleStreamEndTransition(c) },
	{ name: 'first-tool-start-append', handle: (c) => this._ruleFirstToolStartAppend(c) },
	{ name: 'tool-status-sync', handle: (c) => this._ruleToolStatusSync(c) },
];

/** thinking 状态变化 → 强制重建（phase activity indicator 增删改 fast path 处理不全）。 */
private _ruleThinkingStateChange(ctx: IMsgUpdateCtx): boolean {
	// 仅查 .thinking-indicator（thking 指示器自身带 .phase-activity-indicator.phase-thinking）。
	// 工具参数流式期间 _ensurePhaseIndicator 会插入 .phase-activity-indicator.phase-executing
	// 显示「正在生成工具调用参数…」，若误纳进此查询会与 shouldShowThinking 失配，
	// 触发整条消息 _rebuildMessageElement → 所有 thinking/delegate/tool 卡片整体重渲染闪烁。
	const existingIndicator = ctx.el.querySelector('.thinking-indicator');
	const shouldShowThinking = !!(ctx.msg.isStreaming && ctx.msg.isThinking && !ctx.msg.thinking);
	if (!!existingIndicator === shouldShowThinking) { return false; }
	if ((window as any).__SAROSIS_PARTS_DIAG) {
		console.info(`[PartsDiag] _updateMessageDom idx=${ctx.idx} msgId=${ctx.msg.id} → REBUILD (thinking state changed)`);
	}
	this._rebuildMessageElement(ctx.el, ctx.msg);
	return true;
}

	// ── Keyed Reconciliation ──────────────────────────────────────────────

	/** 构建有序 keyed part 列表（委托给 keyedParts 纯函数模块）。 */
	private _buildKeyedParts(msg: IAgentChatMessage): IKeyedPart[] {
		return buildKeyedParts(msg.parts!, msg.id);
	}

	/**
	 * 统一 keyed diff——替代原 6 条 fast rules（thinking-in-place / streaming-text-only /
	 * tool-cards-in-place / write-file-args-streaming / tool-args-streaming / append-new-parts）。
	 *
	 * 三路 diff：已有 key → 就地更新；新 key → 创建插入；残留 key → remove。
	 * 然后统一后处理：重标 streaming-container + 工具卡状态同步 + 阶段指示器。
	 */
	private _reconcileParts(bubble: HTMLElement, msg: IAgentChatMessage): void {
		const keyedParts = this._buildKeyedParts(msg);

		// 收集已有 keyed 元素
		const existingMap = new Map<string, HTMLElement>();
		for (const el of bubble.querySelectorAll('[data-part-key]')) {
			existingMap.set(el.getAttribute('data-part-key')!, el as HTMLElement);
		}

		// 三路 diff
		let prevEl: HTMLElement | null = null;
		for (const kp of keyedParts) {
			let el = existingMap.get(kp.key);
			if (el) {
				this._updatePartInPlace(el, kp.part, msg);
				existingMap.delete(kp.key);
			} else {
				const newEl = this._createPartElement(kp.part, kp.index, msg, !!msg.isStreaming);
				if (!newEl) { continue; }
				newEl.setAttribute('data-part-key', kp.key);
				el = newEl;
				if (prevEl) {
					prevEl.after(el);
				} else {
					const firstNonAttach = Array.from(bubble.children).find(
						c => !c.classList.contains('message-attachments')
					);
					if (firstNonAttach) { bubble.insertBefore(el, firstNonAttach); }
					else { bubble.appendChild(el); }
				}
			}
			prevEl = el;
		}

		// 删除残留元素
		for (const [, el] of existingMap) { el.remove(); }

		// 后处理
		this._updateStreamingContainerMark(bubble, msg);
		this._updateToolCardStatuses(bubble, msg);
		this._ensurePhaseIndicator(bubble, msg);
		// 统一钉底：所有可滚动卡片体（thinking/tool/sub-agent/write-file）内容增长时自动置底
		this._pinAllScrollableBodiesToBottom(bubble);
	}

	/** 就地更新已有 part 元素（text → mdScheduler 节流；thinking → header + body）。 */
	private _updatePartInPlace(el: HTMLElement, part: IMessagePart, msg: IAgentChatMessage): void {
		if (part.kind === 'text') {
			this.mdScheduler.schedule(el, part.text, 'markdown');
		} else if (part.kind === 'thinking') {
			// P-T1 修正：逐卡片判定是否处于「正在思考」活跃态——仅当该 episode 是
			// 最后一个 part 且 message 仍在思考流式时，本卡才显示「思考中...」。
			// 此前误用 message 级 msg.isThinking，导致多思考卡时所有卡都被标为思考中。
			const isLastPart = !!msg.parts && msg.parts[msg.parts.length - 1] === part;
			const cardIsThinking = !!msg.isStreaming && isLastPart && !!msg.isThinking;
			this._updateThinkingCardHeader(el, cardIsThinking);
			const body = el.querySelector('.thinking-card-body') as HTMLElement | null;
			if (body && body.dataset.rendered === '1') {
				this._attachStreamCardPin(body);
				this.thinkingMdScheduler.schedule(body, (part as IThinkingMessagePart).text, 'markdown');
			}
		}
		// tool / subagent：状态由 _updateToolCardStatuses 统一处理
	}

	/** 重标 streaming-container——最后一个非空 text part 获得流式标记。 */
	private _updateStreamingContainerMark(bubble: HTMLElement, msg: IAgentChatMessage): void {
		if (!msg.isStreaming || !msg.parts) { return; }
		const lastKey = lastTextPartKey(msg.parts, msg.id);
		for (const seg of bubble.querySelectorAll('.parts-text-segment[data-part-key]')) {
			const key = seg.getAttribute('data-part-key');
			if (key === lastKey) {
				seg.classList.add('streaming-container');
			} else {
				seg.classList.remove('streaming-container');
			}
		}
	}

	/** keyed-reconcile fast rule——统一处理所有 part 变化场景。 */
	private _ruleKeyedReconcile(ctx: IMsgUpdateCtx): boolean {
		if (!ctx.msg.isStreaming || !ctx.hasParts) { return false; }
		const bubble = ctx.el.querySelector('.chat-bubble') as HTMLElement | null;
		if (!bubble) { return false; }
		this._reconcileParts(bubble, ctx.msg);
		return true;
	}

	/** 原 P1：流式结束转换（isStreaming true→false）。 */
private _ruleStreamEndTransition(ctx: IMsgUpdateCtx): boolean {
	// 条件：之前在流式（有 streaming-container 或 streaming-cursor），现在不流式。
	const wasStreaming = ctx.el.querySelector('.streaming-container, .streaming-cursor') !== null;
	if (!wasStreaming || ctx.msg.isStreaming) { return false; }
	if (!ctx.hasStructuralChange) {
		// 无结构性变化：轻量转换——移除光标 + 渲染 markdown + 追加 footer。
		this._transitionStreamingToComplete(ctx.el, ctx.msg);
	} else {
		// 结构性消息流式结束：以最终完整 parts/content 做一次干净全量重建
		// （与历史恢复路径完全一致），彻底消除流式增量渲染累积的错位。
		// 重建仅在流式结束时发生一次，开销可接受。
		this.mdScheduler.reset();
		this._rebuildMessageElement(ctx.el, ctx.msg);
	}
	return true;
}

/** 原 P1.5：流式期间首个 tool_start → 增量追加工具卡，避免 replaceChild 导致
 *  scrollHeight 突变 → 滚动条跳动。parts-based 渲染激活时跳过（_appendToolCard
 *  会把卡片追加到 bubble 末尾的错误位置，与交插渲染冲突）。 */
private _ruleFirstToolStartAppend(ctx: IMsgUpdateCtx): boolean {
	if (!ctx.msg.isStreaming || !ctx.hasToolCalls || ctx.hasParts) { return false; }
	const existingCards = ctx.el.querySelectorAll('.tool-header-wrapper[data-tool-id]');
	if (existingCards.length !== 0) { return false; }
	const container = ctx.el.querySelector('.chat-bubble') as HTMLElement || ctx.el;
	for (const tc of ctx.msg.toolCalls || []) {
		if (!tc.id) { continue; }
		this._appendToolCard(container, tc, ctx.msg);
	}
	// 追加工具卡后重新定位 phase indicator 到 bubble 末尾
	this._ensurePhaseIndicator(ctx.el, ctx.msg);
	return true;
}

/** 原 P2+：非流式工具卡增量更新——ID 匹配（仅状态/结果变化）时只更新工具卡，
 *  不重建整条消息。 */
private _ruleToolStatusSync(ctx: IMsgUpdateCtx): boolean {
	if (!ctx.hasToolCalls || ctx.msg.isStreaming) { return false; }
	const existingCards = ctx.el.querySelectorAll('.tool-header-wrapper[data-tool-id]');
	const newToolIds = (ctx.msg.toolCalls || []).map(tc => tc.id).filter(Boolean);
	if (existingCards.length !== newToolIds.length || existingCards.length === 0) { return false; }
	const existingIds = Array.from(existingCards).map(c => c.getAttribute('data-tool-id'));
	if (!newToolIds.every((id, i) => existingIds[i] === id)) { return false; }
	// 流式刚结束 → 移除光标 + streaming-container class + 追加 footer
	// Agent loop 进行中（_isSending === true）时跳过 footer 渲染，
	// 避免复制/积分/token 消耗信息在中间迭代中刷屏。
	// loop 结束后由 setSending(false) 统一补齐。
	const bubble = ctx.el.querySelector('.chat-bubble');
	if (bubble) {
		bubble.querySelectorAll('.streaming-cursor').forEach(el => el.remove());
		const sc = bubble.querySelector('.streaming-container');
		if (sc) { sc.classList.remove('streaming-container'); }
		if (!this._isSending && !bubble.querySelector('.chat-bubble-footer')) {
			bubble.appendChild(this._createFooter(ctx.msg));
		}
	}
	this._updateToolCardStatuses(ctx.el, ctx.msg);
	return true;
}

protected override _updateStreamingContentInPlace(existingEl: HTMLElement, msg: IAgentChatMessage): void {
	// P5a 拆分：原「结构 diff + markdown 节流 + 工具卡状态更新」三合一函数，
	// 拆为 ①结构 diff（_hasStreamingStructureChanged）②工具卡状态刷新
	//（_updateToolCardStatuses）③文本节流渲染（mdScheduler.schedule）。
	if (this._hasStreamingStructureChanged(existingEl, msg)) {
		this._rebuildMessageElement(existingEl, msg);
		return;
	}
	const streamingContainer = existingEl.querySelector('.streaming-container') as HTMLElement | null;
	if (!streamingContainer) {
		this._rebuildMessageElement(existingEl, msg);
		return;
	}
	// P2+: 增量更新工具卡状态（running → success/error 等），不重建整条消息
	this._updateToolCardStatuses(existingEl, msg);
	this.mdScheduler.schedule(streamingContainer, this._lastStreamTextOf(msg), 'markdown');
	// 2026-07-26：thinking episode 就地更新——最后 part 是 thinking 时，其卡片
	// body 随 episode 文本增长就地重渲染（折叠态懒渲染 body 未建则跳过，
	// 展开时由卡片自身的懒渲染补全）。
	const lastPart = msg.parts?.[msg.parts.length - 1];
	if (lastPart?.kind === 'thinking') {
		const cards = existingEl.querySelectorAll('.thinking-card');
		const lastCardBody = cards[cards.length - 1]?.querySelector('.thinking-card-body') as HTMLElement | null;
		if (lastCardBody && lastCardBody.dataset.rendered === '1') {
			this._attachStreamCardPin(lastCardBody); // 幂等：挂载流式钉底（用户上滚自动解除）
			this.thinkingMdScheduler.schedule(lastCardBody, (lastPart as IThinkingMessagePart).text, 'markdown');
		}
	}
}

/**
 * P5a：结构 diff 抽离。工具数与文本段数都未变时，只是最后一段流式文本在增长，
 * 走增量更新；任一变化（新增工具卡 / 新起一段文本）才重建。
 * 这消除了「含工具 parts 即全量重建整条气泡」的瓶颈（工具卡按 ID 就地刷新）。
 */
private _hasStreamingStructureChanged(existingEl: HTMLElement, msg: IAgentChatMessage): boolean {
	const existingToolCards = existingEl.querySelectorAll('.tool-header-wrapper');
	const isPartsMode = !!(msg.parts && msg.parts.length > 0);
	const newToolCount = isPartsMode
		? msg.parts!.filter(p => p.kind === 'tool').length
		: (msg.toolCalls?.length ?? 0);
	if (existingToolCards.length !== newToolCount) { return true; }
	if (isPartsMode) {
		const newTextSegCount = msg.parts!.filter(p => p.kind === 'text' && p.text.trim().length > 0).length;
		const existingTextSegs = existingEl.querySelectorAll('.parts-text-segment, .interleaved-segment');
		if (existingTextSegs.length !== newTextSegCount) { return true; }
		// 2026-07-26：thinking episode 数变化同样触发重建（新一轮思考开新 part）
		const newThinkingCount = msg.parts!.filter(p => p.kind === 'thinking').length;
		const existingThinkingCards = existingEl.querySelectorAll('.thinking-card').length;
		return existingThinkingCards !== newThinkingCount;
	}
	// 非 parts 的旧渲染路径且含工具：保持原有重建行为。
	return (msg.toolCalls?.length ?? 0) > 0;
}

/** P5a：流式渲染文本提取——parts 模式下只显示最后一个非空文本 part，而非整篇 content。 */
private _lastStreamTextOf(msg: IAgentChatMessage): string {
	if (msg.parts && msg.parts.length > 0) {
		const lastTextPart = [...msg.parts].reverse().find((p): p is ITextMessagePart => p.kind === 'text' && p.text.trim().length > 0);
		if (lastTextPart) { return lastTextPart.text; }
	}
	return msg.content;
}

protected override _rebuildMessageElement(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		// Clean up markdown disposables before replacing the old element
		this._cleanupMarkdownDisposables(existingEl);
		if ((window as any).__SAROSIS_PARTS_DIAG) {
			const partsInfo = msg.parts ? `partsLen=${msg.parts.length} kinds=[${msg.parts.map(p => p.kind).join(',')}]` : 'parts=none';
			console.info(`[PartsDiag] _rebuildMessageElement msgId=${msg.id} isStreaming=${msg.isStreaming} contentLen=${(msg.content||'').length} toolCalls=${msg.toolCalls?.length ?? 0} ${partsInfo}`);
		}
		// 重建前按 data-tool-id 捕获各工具卡的卡内滚动位置（展开态由
		// _toolCallExpandState Map 在建卡时恢复），重建后按 id 找回恢复。
		const savedScrollByToolId = new Map<string, Array<{ selector: string; top: number; left: number; atBottom: boolean }>>();
		for (const card of Array.from(existingEl.querySelectorAll('[data-tool-id]')) as HTMLElement[]) {
			const id = card.getAttribute('data-tool-id');
			if (id) { savedScrollByToolId.set(id, this._captureScrollPositions(card)); }
		}
		const newEl = this._createMessageElement(msg);
		const parent = existingEl.parentNode;
		if (parent) {
			parent.replaceChild(newEl, existingEl);
			if (savedScrollByToolId.size > 0) {
				requestAnimationFrame(() => {
					if (!newEl.isConnected) { return; }
					for (const [id, saved] of savedScrollByToolId) {
						const card = newEl.querySelector(`[data-tool-id="${id}"]`) as HTMLElement | null;
						if (card) { this._restoreScrollPositions(card, saved); }
					}
				});
			}
		}
	}

	/** 捕获元素内所有可滚动子元素的滚动位置（重建前调用）。
	 *  key 取元素首个 class 名（同卡内通常唯一），SVG 元素 className 为对象需排除。
	 *  atBottom：捕获时是否位于底部——流式增长场景（如 subagent 输出）恢复时应跟随
	 *  新内容滚到底，而非恢复旧绝对位置（旧位置在新内容下已不是底部）。
	 *  排除 .trace-list / .subagent-card-trace-list：多子代理并行时同名 class 有多个实例，
	 *  按首 class 选择器 querySelector 恢复只命中卡内第一个，会把所有子代理的滚动值
	 *  错误叠写到同一个元素上——该容器已由 _snapshotSubAgentSections/_applySubAgentRefreshFX
	 *  按 data-sa-id 精确逐个处理，两套机制并存互相覆盖是"滚动条上下跳动"的根因。 */
	private _captureScrollPositions(root: HTMLElement): Array<{ selector: string; top: number; left: number; atBottom: boolean }> {
		const diag = !!(window as any).__SAROSIS_SCROLL_DIAG;
		const out: Array<{ selector: string; top: number; left: number; atBottom: boolean }> = [];
		for (const el of Array.from(root.querySelectorAll('*')) as HTMLElement[]) {
			if (typeof el.className !== 'string') { continue; }
			// 捕获已溢出（可滚）或已滚动的容器；未溢出的无需恢复
			if (el.scrollHeight <= el.clientHeight && el.scrollTop === 0 && el.scrollLeft === 0) { continue; }
			if (el.classList.contains('trace-list') || el.classList.contains('subagent-card-trace-list')) { continue; }
			const cls = el.className.trim().split(/\s+/)[0];
			if (!cls) { continue; }
			// 精确化选择器：元素若位于某个 [data-sa-id] 子代理区内，把该区 id 并入选择器。
			// 否则多个子代理区同名 class（.sa-body/.conclusion-box/.done-stats）在恢复时
			// querySelector 只命中第一个，其余实例的滚动值永不恢复 → 任务列表/总结列表"上下跳动"。
			const sa = el.closest('[data-sa-id]');
			const saId = sa?.getAttribute('data-sa-id') ?? '';
			let selector: string;
			if (saId) {
				const safe = saId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
				// 元素自身即 [data-sa-id] 时直接用该属性选择器，否则用 "区 .cls" 后代选择器
				selector = sa === el ? `[data-sa-id="${safe}"]` : `[data-sa-id="${safe}"] .${cls}`;
			} else {
				selector = '.' + cls;
			}
			// 贴底判定（2026-07-27 修正）：仅「无滚动（内容未溢出）」或「距底 <24px」视为
			// 贴底跟随；用户上滚（含滚到顶部，距底 >24px）→ 不跟随，保持其位置不被新内容
			// 拽走。去掉旧 `scrollTop<=2→跟随` 误判（把"用户滚到顶部"当"应置底"而强制拽回）。
			const atBottom = el.scrollHeight <= el.clientHeight + 1
				|| el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			out.push({ selector, top: el.scrollTop, left: el.scrollLeft, atBottom });
			if (diag) {
				console.warn(`[ScrollDiag] CAPTURE ${selector} top=${el.scrollTop} left=${el.scrollLeft} atBottom=${atBottom} sa=${saId}`);
			}
		}
		if (diag) {
			// 修复后选择器已按 [data-sa-id] 精确化，正常应不再出现同名 COLLISIONS；
			// 若仍出现，说明存在不位于任何 [data-sa-id] 区的重复 class，需进一步排查。
			const bySel = new Map<string, number>();
			for (const s of out) { bySel.set(s.selector, (bySel.get(s.selector) ?? 0) + 1); }
			const collisions = [...bySel.entries()].filter(([, c]) => c > 1).map(([s, c]) => `${s}×${c}`).join(', ');
			console.warn(`[ScrollDiag] CAPTURE card=${root.getAttribute('data-tool-id') ?? '?'} scrollableElements=${out.length}${collisions ? ` ⚠ COLLISIONS=[${collisions}]` : ''}`);
		}
		return out;
	}

	/** 恢复 _captureScrollPositions 保存的滚动位置：atBottom 的容器滚到底（跟随流式增长），否则恢复旧位置。 */
	private _restoreScrollPositions(root: HTMLElement, saved: Array<{ selector: string; top: number; left: number; atBottom: boolean }>): void {
		const diag = !!(window as any).__SAROSIS_SCROLL_DIAG;
		const seen = new Map<string, number>();
		for (const s of saved) {
			const el = root.querySelector(s.selector) as HTMLElement | null;
			if (el) {
				const target = s.atBottom ? el.scrollHeight : s.top;
				el.scrollTop = target;
				el.scrollLeft = s.left;
				if (diag) {
					const n = (seen.get(s.selector) ?? 0) + 1;
					seen.set(s.selector, n);
					// querySelector 永远命中第一个匹配 → 同名 selector 第二次起写到同一个元素，
					// 其它实例的滚动值永远无人接管，正是"上下跳动"的来源。
					const collision = n > 1;
					console.warn(`[ScrollDiag] RESTORE ${s.selector}${collision ? ' ⚠ COLLISION(querySelector 命中首个, 其余实例未恢复)' : ''} → top=${target} (scrollHeight=${el.scrollHeight} clientHeight=${el.clientHeight})`);
				}
			} else if (diag) {
				console.warn(`[ScrollDiag] RESTORE ${s.selector} → 新 DOM 中未找到`);
			}
		}
	}

	/** rAF 延迟恢复滚动位置——等展开动画（max-height transition）后的布局稳定再设置。 */
	private _restoreScrollPositionsDeferred(root: HTMLElement, saved: Array<{ selector: string; top: number; left: number; atBottom: boolean }>): void {
		if (saved.length === 0) { return; }
		requestAnimationFrame(() => {
			if (root.isConnected) { this._restoreScrollPositions(root, saved); }
		});
	}

	/**
	 * 跨整卡重建保留「稳定节点」身份：subagent 卡片的 title 与 conclusion。
	 * 流式过程中 _updateSubAgentCardsInPlace 每 ~100ms 整卡 replaceWith，若不保留这两个
	 * 节点，其 CSS 动画（shimmer / cursor-blink）与结论文本每次从头重启/重建 → 用户可见的
	 * 「标题与结论严重闪烁」。这里把旧卡中的 title/conclusion 节点移栽到新卡对应 .sa 区内，
	 * 仅按新状态调和 shimmer 类（元素身份稳定，class toggle 到已有值=no-op，不会重启动画）。
	 */
	private _preserveStableSubagentNodes(oldCard: HTMLElement, newCard: HTMLElement): void {
		const saOldList = Array.from(oldCard.querySelectorAll('.subagent-card[data-sa-id]')) as HTMLElement[];
		for (const saOld of saOldList) {
			const id = saOld.getAttribute('data-sa-id');
			if (!id) { continue; }
			const saNew = newCard.querySelector(`.sa[data-sa-id="${CSS.escape(id)}"]`) as HTMLElement | null;
			if (!saNew) { continue; }
			// title：移栽旧节点到新卡，避免 shimmer 动画每批重启
			const titleOld = saOld.querySelector('.subagent-card-title') as HTMLElement | null;
			const titleNew = saNew.querySelector('.subagent-card-title') as HTMLElement | null;
			if (titleOld && titleNew) {
				saNew.replaceChild(titleOld, titleNew);
				// 状态可能 running→done：按新卡状态调和 shimmer（toggle 到已有值=no-op，不重启动画）
				const shouldShimmer = saNew.classList.contains('running');
				titleOld.classList.toggle('shimmer', shouldShimmer);
			}
			// conclusion：移栽旧节点（含 clamp/expand 折叠态与 textContent），避免结论闪烁
			const conclOld = saOld.querySelector('.conclusion') as HTMLElement | null;
			const conclNew = saNew.querySelector('.conclusion') as HTMLElement | null;
			if (conclOld && conclNew) {
				saNew.replaceChild(conclOld, conclNew);
			}
		}
	}

	/**
	 * 跨整卡重建保留「静态任务指令」节点：delegate 卡片的 .du-instr 来自 args.task，
	 * 永不变化，但整卡 replaceWith 会每次重渲染其 markdown（含潜在异步渲染）→ 内部闪烁。
	 * 把旧卡 .du-instr 节点整体移栽到新卡，避免重渲染静态内容。
	 */
	private _preserveStableDelegateInstruction(oldCard: HTMLElement, newCard: HTMLElement): void {
		const instrOld = oldCard.querySelector('.du-instr') as HTMLElement | null;
		const instrNew = newCard.querySelector('.du-instr') as HTMLElement | null;
		if (instrOld && instrNew && instrOld.childElementCount > 0) {
			instrNew.replaceWith(instrOld);
		}
	}

	/**
	 * delegate 卡片动态签名：子代理 id / status / 工具步数。
	 * 用于整卡重建前的「无变化跳过」判定——签名未变且已无 running 时，已渲染卡片即正确，
	 * 无需每 100ms 批次整卡 replaceWith（那是 delegate「执行结束后」内部抖动的根源）。
	 * 步数只取长度（非内容），因为扁平 .du-steps 列表仅展示步名+预览，内容增长由
	 * running 态的逐批重建覆盖；全 done 后的冗余批次内容增量可安全忽略。
	 */
	private _computeDelegateDynamicSig(tc: IToolCall): string {
		const subs = filterChildSubAgents(tc.subAgents as any, tc.id);
		return subs.map((s: any) => `${s.id}:${s.status}:${(s.toolTraces?.length ?? 0)}`).join('|');
	}

	/**
	 * subagent 区刷新快照（整卡重建前捕获）：data-sa-id → { total, status, traceTop, traceAtBottom }。
	 * total 优先读步数 chip（`N 步`），回退 trace-title（`执行过程 · N 步`）；
	 * 0 步时两者皆无 → 0。trace 滚动：scrollTop≤2（未动过）或距底<24px 视为贴底跟随态。
	 */
	private _snapshotSubAgentSections(card: HTMLElement): Map<string, { total: number; status: string; traceTop: number; traceAtBottom: boolean }> {
		const out = new Map<string, { total: number; status: string; traceTop: number; traceAtBottom: boolean }>();
		for (const sa of Array.from(card.querySelectorAll('.subagent-card[data-sa-id]')) as HTMLElement[]) {
			const id = sa.getAttribute('data-sa-id');
			if (!id) { continue; }
			const traceList = sa.querySelector(':scope > .sa-body .trace-list') as HTMLElement | null;
			const traceTop = traceList?.scrollTop ?? 0;
			const traceAtBottom = !traceList
				|| traceList.scrollTop <= 2
				|| traceList.scrollHeight - traceList.scrollTop - traceList.clientHeight < 24;
			out.set(id, { total: this._readSaStepCount(sa), status: this._readSaStatus(sa), traceTop, traceAtBottom });
		}
		return out;
	}

	private _readSaStepCount(sa: HTMLElement): number {
		const chip = sa.querySelector(':scope > .subagent-card-header .chip.steps')?.textContent;
		const title = sa.querySelector(':scope > .subagent-card-body .subagent-card-trace-header')?.textContent;
		const m = (chip || title || '').match(/(\d+)/);
		return m ? parseInt(m[1], 10) : 0;
	}

	private _readSaStatus(sa: HTMLElement): string {
		return sa.classList.contains('running') ? 'running' : sa.classList.contains('done') ? 'done' : 'error';
	}

	/**
	 * subagent 内容刷新 FX（2026-07-27 mockup 落地）：整卡重建后对比前后快照，
	 * 在新 DOM 上标注——①运行中卡 .refreshing（刷新中微标+色条加亮，400ms 空闲淡出）
	 * ②增量 trace 步 .tstep-new 滑入绿闪 ③步数 chip .bump 脉冲 ④running→done 整卡
	 * .flash-done 绿闪。动画类均为新元素首次添加即触发，无需事后清理。
	 */
	private _applySubAgentRefreshFX(newCard: HTMLElement, prev: Map<string, { total: number; status: string; traceTop: number; traceAtBottom: boolean }>): void {
		for (const sa of Array.from(newCard.querySelectorAll('.subagent-card[data-sa-id]')) as HTMLElement[]) {
			if (sa.classList.contains('running')) {
				sa.classList.add('refreshing');
				setTimeout(() => { sa.classList.remove('refreshing'); }, 400);
			}
			const id = sa.getAttribute('data-sa-id');
			const old = id ? prev.get(id) : undefined;
			if (!old) { continue; }
			// ④ running→done 整卡绿闪
			if (old.status === 'running' && sa.classList.contains('done')) {
				sa.classList.add('flash-done');
				if ((window as any).__SAROSIS_SCROLL_DIAG) {
					const total = newCard.querySelectorAll('.subagent-card[data-sa-id]').length;
					console.warn(`[ScrollDiag] TRANSITION running→done sa=${id} (card 共 ${total} 个子代理区)`);
				}
			}
			// ⑤ trace 滚动恢复（2026-07-27 滚动条显示）：贴底→跟随新内容滚到底；
			// 用户上滚→恢复其位置（不被新内容拽走）。
			const newTraceList = sa.querySelector(':scope > .subagent-card-body .subagent-card-trace-list') as HTMLElement | null;
			if (newTraceList) {
				newTraceList.scrollTop = old.traceAtBottom ? newTraceList.scrollHeight : old.traceTop;
			}
			// ②③ 步数增量：新步在可见列表末尾（折叠态同样成立——可见区是末尾 slice）
			const newTotal = this._readSaStepCount(sa);
			if (newTotal > old.total) {
				const steps = sa.querySelectorAll('.tstep');
				const delta = newTotal - old.total;
				for (let i = Math.max(0, steps.length - delta); i < steps.length; i++) {
					steps[i].classList.add('tstep-new');
				}
				sa.querySelector(':scope > .sa-header .chip.steps')?.classList.add('bump');
			}
		}
	}

	/**
	 * 仅 subagent 数据变化时轻量更新：重建含有 subAgents 的工具卡片 + 独立 subagent 卡片区。
	 * 替代旧的 _updateSubAgentCardsInPlace（复杂 DOM 操作），直接重建
	 * 受影响的 tool card 即可——inlineTraceSink 100ms 批次频率下开销可接受。
	 * 子代理执行详情内嵌于 delegate_task / plan_explore 工具卡内（路径 A：tool.subAgents），
	 * 故重建对应工具卡即可刷新内嵌子代理（_createToolCallCard → _renderSubAgentsInside）。
	 */
	protected override _updateSubAgentCardsInPlace(_msgIdx: number, msg: IAgentChatMessage): void {
		const messageEl = this._messagesContainer?.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null;
		if (!messageEl) { return; }
		// 子代理执行详情内嵌于 delegate_task / plan_explore 工具卡内（路径 A：tool.subAgents）。
		// 流式期间 subagent 数据到达时，tc.subAgents 已被 _remapAndAttachSubAgents
		// 关联到对应工具卡，直接重建受影响工具卡即可（_createToolCallCard → _renderSubAgentsInside）。
		let rebuiltAny = false;
		for (const tc of msg.toolCalls ?? []) {
			if (!tc.id || !tc.subAgents || tc.subAgents.length === 0) { continue; }
			const oldCard = messageEl.querySelector(`[data-tool-id="${tc.id}"]`) as HTMLElement | null;
			if (!oldCard) { continue; }

			// 抖动修复：子代理「执行结束后」仍有 subagent_batch 最终数据 flush 到达，
			// 每次都整卡 replaceWith 会重渲染静态「任务指令」markdown → 卡片内部抖动。
			// 动态签名（子代理 id/status/步数）未变且已无 running 时，已渲染卡片即正确，
			// 跳过整卡重建。运行中则必须重建（保持流式 trace 增长）。
			const sig = this._computeDelegateDynamicSig(tc);
			const anyRunning = filterChildSubAgents(tc.subAgents, tc.id).some((s: any) => s.status === 'running');
			if (!anyRunning && oldCard.dataset.dlgSig === sig) { continue; }

			// 重建工具卡（保留展开态 + 卡内滚动位置 + 稳定子代理节点，避免闪烁）。
			const wasExpanded = oldCard.querySelector(':scope > .tool-header-children')?.classList.contains('tool-header-children-expanded') ?? false;
			const savedScroll = this._captureScrollPositions(oldCard);
			const prevSa = this._snapshotSubAgentSections(oldCard);
			const newCard = this._createToolCallCard(tc);
			// 保留 data-part-key——keyed reconciliation 依赖此属性匹配工具卡，
			// 丢失会导致 _reconcileParts 重复创建卡片（subagent 区域不可见）。
			const oldPartKey = oldCard.getAttribute('data-part-key');
			if (oldPartKey) { newCard.setAttribute('data-part-key', oldPartKey); }
			// 恢复展开态：以旧 DOM 为准覆盖 _createToolCallCard 的默认值，
			// 同时写入 _toolCallExpandState Map 确保后续重建路径读到一致的状态。
			const newBody = newCard.querySelector('.tool-header-children');
			const ch = newCard.querySelector('.tool-header-chevron');
			if (wasExpanded) {
				newBody?.classList.add('tool-header-children-expanded');
				ch?.classList.add('tool-header-chevron-expanded');
				if (tc.id) { this._toolCallExpandState.set(tc.id, true); }
			} else {
				newBody?.classList.remove('tool-header-children-expanded');
				ch?.classList.remove('tool-header-chevron-expanded');
				if (tc.id) { this._toolCallExpandState.set(tc.id, false); }
			}
			this._preserveStableSubagentNodes(oldCard, newCard);
			// 保留静态「任务指令」节点：args.task 永不变化，避免整卡重建时重渲染其 markdown。
			this._preserveStableDelegateInstruction(oldCard, newCard);
			newCard.dataset.dlgSig = sig;
			if ((window as any).__SAROSIS_SCROLL_DIAG) {
				const saCount = newCard.querySelectorAll('.subagent-card[data-sa-id]').length;
				const doneCount = newCard.querySelectorAll('.subagent-card.done[data-sa-id]').length;
				console.warn(`[ScrollDiag] REBUILD tool=${tc.id} sa=${saCount} done=${doneCount} — 重建工具卡并恢复滚动`);
			}
			oldCard.replaceWith(newCard);
			this._applySubAgentRefreshFX(newCard, prevSa);
			this._restoreScrollPositionsDeferred(newCard, savedScroll);
			// 流式重建后重新钉底：使 delegate 卡片内 .delegate-scroll 自动跟随内容增长置底
			this._pinAllScrollableBodiesToBottom(newCard);
			rebuiltAny = true;
		}
		// 子代理已到达但对应工具卡尚未渲染（极少见：subagent 先于 delegate tool call 出现）：
		// 做一次全量重建，由 _createMessageElement 在正确位置创建内嵌子代理卡片。
		if (!rebuiltAny && msg.subAgents && msg.subAgents.length > 0) {
			this._rebuildMessageElement(messageEl, msg);
		}
	}

protected override _updateToolCardStatuses(existingEl: HTMLElement, msg: IAgentChatMessage): void {
	if (!msg.toolCalls || msg.toolCalls.length === 0) { return; }
		// 工具卡可能位于 .tool-calls-section（旧整段渲染）或气泡直接子节点（parts 交错渲染）。
		// 统一按 data-tool-id 在整个消息元素内查找，两种模式都命中。
		for (const tc of msg.toolCalls) {
			if (!tc.id) { continue; }
			const oldCard = existingEl.querySelector(`[data-tool-id="${tc.id}"]`) as HTMLElement | null;
			if (!oldCard) { continue; }

			// 比较状态类名——只有状态变化才重建卡片
			const statusMatch = oldCard.className.match(/tool-card-(\w+)/);
			const currentStatus = statusMatch?.[1] ?? '';
			const newStatus = tc.status === 'error' ? 'error'
				: tc.status === 'running' ? 'running'
				: tc.status === 'approval_required' ? 'approval'
				: (tc.status === 'rejected' || tc.status === 'canceled') ? 'rejected'
				: 'success';

		if (currentStatus !== newStatus) {
			// 重建前保留展开态（如委派卡片运行中自动展开/用户手动展开）+ 卡内滚动位置，
			// 重建后恢复，避免实时刷新时折叠导致看不到执行内容。
			// 展开态用 :scope 直属查找（防内嵌 subagent 卡同名 class 误读）。
			const oldBody = oldCard.querySelector(':scope > .tool-header-children') as HTMLElement | null;
			const wasExpanded = oldBody?.classList.contains('tool-header-children-expanded') ?? false;
			const savedScroll = this._captureScrollPositions(oldCard);
		const prevSa = this._snapshotSubAgentSections(oldCard);
		const newCard = this._createToolCallCard(tc);
		// 保留 data-part-key——keyed reconciliation 依赖此属性匹配工具卡
		const oldPartKey = oldCard.getAttribute('data-part-key');
		if (oldPartKey) { newCard.setAttribute('data-part-key', oldPartKey); }
		if (wasExpanded) {
			const newBody = newCard.querySelector('.tool-header-children') as HTMLElement | null;
			if (newBody) {
				newBody.classList.add('tool-header-children-expanded');
				const ch = newCard.querySelector('.tool-header-chevron') as HTMLElement | null;
				if (ch) { ch.classList.add('tool-header-chevron-expanded'); }
				if (tc.id) { this._toolCallExpandState.set(tc.id, true); }
			}
		} else {
			// 旧卡折叠态同样写回 Map，避免 defaultShow / 其他重建路径把卡片重新展开
			const newBody = newCard.querySelector('.tool-header-children') as HTMLElement | null;
			if (newBody) {
				newBody.classList.remove('tool-header-children-expanded');
				const ch = newCard.querySelector('.tool-header-chevron') as HTMLElement | null;
				if (ch) { ch.classList.remove('tool-header-chevron-expanded'); }
				if (tc.id) { this._toolCallExpandState.set(tc.id, false); }
			}
		}
		// 保留 title/conclusion 节点身份，消除流式整卡重建导致的标题/结论闪烁
		this._preserveStableSubagentNodes(oldCard, newCard);
		// 保留静态「任务指令」节点，避免状态切换时重渲染其 markdown
		this._preserveStableDelegateInstruction(oldCard, newCard);
	oldCard.replaceWith(newCard);
		this._applySubAgentRefreshFX(newCard, prevSa);
		this._restoreScrollPositionsDeferred(newCard, savedScroll);
		}
	}
}

protected override _createMessageElement(msg: IAgentChatMessage): HTMLElement {
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
				// Use icon emoji — no background, matches preset panel style
				const iconEl = append(avatarWrap, $(".chat-avatar-icon"));
				iconEl.textContent = this._agent.icon;
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

		// Thinking card (assistant only) — 2026-07-26 用户要求：不固定顶部，
		// 作为 thinking part 跟随 LLM 流式输出的实际发生位置渲染（见
		// _renderPartsContent 的 kind==='thinking' 分支）。此处不再单独渲染。

		// "正在思考..." indicator 延后到 content + toolCalls 之后 append（见下方）

		// Content + Tool calls — interleaved rendering for assistant messages
		// (Void-inspired: tool cards inserted at text positions inside markdown),
		// simple rendering for user messages.
		// NOTE: Always use Markdown rendering for assistant messages (including streaming)
		// to ensure code blocks, inline code, and other Markdown features render correctly.

		// 附件（图片/文件）—— 与输入框 chip 样式一致，气泡内只读展示（无删除按钮，图片可点击放大）
		if (isUser && msg.attachments && msg.attachments.length > 0) {
			const attWrap = append(bubble, $('.message-attachments'));
			attWrap.style.display = 'flex';
			attWrap.style.flexWrap = 'wrap';
			attWrap.style.gap = '4px';
			attWrap.style.marginBottom = msg.content ? '6px' : '0';
			for (const att of msg.attachments) {
				attWrap.appendChild(this._createReadOnlyAttachmentChip(att));
			}
		}

		if (isUser && msg.content) {
			// Task prompt card: render from structured data when available
			// (avoids the fragile regex-parse anti-pattern).
			const taskCardData = msg.taskCard;
			if (taskCardData) {
				const card = this._buildTaskCardFromData(taskCardData);
				if (card) { bubble.appendChild(card); }
				// Show plain text content below the card
				if (msg.content) {
					const contentEl = append(bubble, $('.message-content'));
					this._renderUserContent(contentEl, msg.content);
				}
			} else {
				const contentEl = append(bubble, $('.message-content'));
				this._renderUserContent(contentEl, msg.content);
			}
			// Hover action buttons: edit / copy / undo (Void-style, shown below-bubble on hover)
			this._addMessageActionButtons(bubble, msg);
		} else if (!isUser && msg.parts && msg.parts.length > 0) {
			// 阶段E：有序 parts 是渲染唯一真相 —— 按数组顺序遍历，
			// 文本段→markdown，工具段→工具卡。结构上不可能错位（取代 textPosition）。
			if ((window as any).__SAROSIS_PARTS_DIAG) {
				console.info(`[PartsDiag] _createMessageElement → PARTS-BASED RENDER msgId=${msg.id} partsLen=${msg.parts.length} isStreaming=${msg.isStreaming}`);
			}
			this._renderPartsContent(bubble, msg.parts, !!msg.isStreaming, msg);
			// 有工具卡时标记 bubble，CSS 会隐藏文本内嵌光标（改用底部光标）
			const hasTool = msg.parts.some(p => p.kind === 'tool');
			if (hasTool) { bubble.classList.add('has-tool-cards'); }
		} else if (!isUser && msg.content) {
			// 回退（无 parts，多见于直连模式早期流式）：content 作 Markdown，附加工具卡。
			if ((window as any).__SAROSIS_PARTS_DIAG) {
				console.info(`[PartsDiag] _createMessageElement → FALLBACK (no parts) msgId=${msg.id} contentLen=${msg.content?.length ?? 0} toolCalls=${msg.toolCalls?.length ?? 0}`);
			}
			const contentEl = append(bubble, $(".message-content"));
			if (msg.isStreaming) {
				contentEl.classList.add('streaming-container');
			}
			this._renderMarkdownContent(contentEl, msg.content, true);
			if (msg.toolCalls && msg.toolCalls.length > 0) {
				this._appendToolCallsWithPhaseGroups(bubble, msg.toolCalls, msg.streamPhase);
			}
		} else if (!isUser && msg.toolCalls && msg.toolCalls.length > 0) {
			// 回退：工具调用存在但内容为空（流式输出早期阶段常见）
			// 参考 void：工具调用作为独立的进度卡片渲染
			if ((window as any).__SAROSIS_PARTS_DIAG) {
				const tcNames = msg.toolCalls.map(tc => `${tc.name}(${tc.status})`).join(', ');
				console.info(`[PartsDiag] _createMessageElement → TOOL-CALLS-ONLY msgId=${msg.id} toolCalls=${msg.toolCalls.length} [${tcNames}]`);
			}
			this._appendToolCallsWithPhaseGroups(bubble, msg.toolCalls, msg.streamPhase);
		}

	// Assistant hover actions: 仅「回撤改动」（checkpoint 存在时才创建容器，避免空 hover 目标）。
	// 编辑 / 复制 / 收藏按钮对 assistant（LLM）气泡不显示（见 _addMessageActionButtons）。
	if (!isUser && msg.content && this._onCheckpointAction && this._checkpoint) {
		this._addMessageActionButtons(bubble, msg);
	}

	// 子代理执行详情已内嵌到 delegate_task / plan_explore 工具卡内（路径 A：
	// tool.subAgents），由 agentChatPanel.delegateCards 的 _renderSubAgentsInside 渲染，
	// 不再使用此处独立的 .subagent-cards-section。

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

		// Plan tasks card (generated by plan workflow / plan_exit)
		if (!isUser && msg.planTasks && msg.planTasks.tasks.length > 0) {
			bubble.appendChild(this._createPlanTasksCard(msg.planTasks));
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

		// （thinking 卡片现作为 thinking part 在 _renderPartsContent 内按流式位置渲染）

		// ── Phase-aware activity indicator (光标 / 思考 / 执行中 / 等待中) ──
		// 在 agent loop 全周期内，LLM 冒泡消息框始终显示当前阶段的活动指示器，
		// 让用户明确知道 agent 仍在工作中（与 composer 中 stop 按钮联动）。
		if (!isUser && msg.isStreaming) {
			this._ensurePhaseIndicator(bubble, msg);
		}

		// 流式期间预留 footer 占位：loop 结束时 footer 淡入替换占位，
		// 避免整段会话因 footer 突然出现而位移（对齐 Hermes footer 常驻占位）。
		// 仅作用于最后一条 assistant 消息，避免中间消息残留空占位。
		if (!isUser && msg.isStreaming && this._isLastAssistantMessage(msg) &&
			!bubble.querySelector('.chat-bubble-footer-placeholder')) {
			bubble.appendChild($('.chat-bubble-footer-placeholder'));
		}

		// Footer: copy | score | tokens | duration — 仅在 LLM 流式输出结束后显示
		// Agent loop 进行中（_isSending === true）时暂时不渲染 footer，避免：
		//   - 复制/积分/token 消耗信息刷屏
		//   - 用户看到部分统计就误以为循环结束
		// loop 结束后由 setSending(false) → _revealFootersAfterLoop() 统一补齐最后一条消息的 footer
		if (!isUser && !msg.isStreaming && !this._isSending) {
			bubble.appendChild(this._createFooter(msg));
		}

		return messageEl;
	}

protected override _createFooter(msg: IAgentChatMessage): HTMLElement {
		// 空消息（无内容也无非错误工具调用）不渲染 footer，避免显示「空 bubble + 复制按钮 + 耗时」视觉噪音
		// —— 错误是首个 delta 时，_initStreamingMessage 创建的占位消息应保持完全空白。
		const realContent = (msg.content ?? '').trim()
			&& !/^(正在思考|Thinking\.\.\.)$/.test((msg.content ?? '').trim());
		const hasRealToolCalls = (msg.toolCalls ?? []).some(
			(tc: any) => tc?.name !== 'llm_error',
		);
		if (!realContent && !hasRealToolCalls) {
			// 返回占位 footer（空元素），调用方 append 后不会显示任何内容
			return $('.chat-bubble-footer');
		}

		const footer = $(".chat-bubble-footer");

		// ── 复制按钮（样式同用户消息的复制按钮）──
		const copyBtn = append(footer, $("button.chat-msg-action-btn.chat-msg-copy-btn")) as HTMLButtonElement;
		copyBtn.title = "复制";
		const copySvg = this._svgCopyIcon();
		copyBtn.appendChild(copySvg);
		this._register(addDisposableListener(copyBtn, EventType.CLICK, async (e: Event) => {
			e.stopPropagation();
			const ok = await this._copyToClipboard(msg.content ?? '');
			if (ok) {
				copyBtn.removeChild(copySvg);
				const checkSvg = this._svgCheckSmall();
				copyBtn.appendChild(checkSvg);
				copyBtn.classList.add("chat-msg-copy-copied");
				setTimeout(() => {
					copyBtn.classList.remove("chat-msg-copy-copied");
					try { copyBtn.removeChild(checkSvg); } catch { /* already removed */ }
					copyBtn.appendChild(copySvg);
				}, 1500);
			}
		}));

		// ── 导入知识库按钮（位于复制按钮右侧；走 importMessageToKnowledgeBase 管线，与顶部收藏按钮同源）──
		if (this._onImportToKnowledgeBase) {
			const importBtn = append(footer, $("button.chat-msg-action-btn.chat-msg-import-kb-btn")) as HTMLButtonElement;

			// 初始状态：若已导入过，直接展示「已导入」态并禁用按钮（禁止重复导入）
			const isAlreadyImported = !!msg.id && this._importedKbMessageIds.has(msg.id);
			const importSvg = this._svgImportKbIcon();
			importBtn.title = isAlreadyImported ? '已导入知识库' : '导入知识库';
			if (isAlreadyImported) {
				importBtn.classList.add('chat-msg-import-kb-done');
				importBtn.disabled = true;
			}
			importBtn.appendChild(importSvg);

			let inFlight = false;
			this._register(addDisposableListener(importBtn, EventType.CLICK, async (e: Event) => {
				e.stopPropagation();
				if (inFlight) { return; } // 防重入：一次导入未完成时屏蔽重复点击
				if (msg.id && this._importedKbMessageIds.has(msg.id)) { return; } // 已导入，禁止重复导入
				inFlight = true;
				importBtn.disabled = true;
				importBtn.classList.remove('chat-msg-import-kb-done');
				try {
					const snapshot = msg.content ?? '';
					const success = await this._onImportToKnowledgeBase!(snapshot, msg.id);
					// 替换图标为对号
					try { importBtn.removeChild(importSvg); } catch { /* already removed */ }
					const resultSvg = this._svgCheckSmall();
					importBtn.appendChild(resultSvg);
					if (success) {
						// 记录已导入状态，禁止后续重复导入
						if (msg.id) { this._importedKbMessageIds.add(msg.id); }
						importBtn.classList.add('chat-msg-import-kb-done');
						importBtn.title = '已导入知识库';
						importBtn.disabled = true; // 禁止重复导入
					} else {
						importBtn.classList.add('chat-msg-import-kb-error');
						importBtn.title = '导入失败，点击重试';
						importBtn.disabled = false; // 失败允许重试
					}
				} catch {
					importBtn.title = '导入失败，点击重试';
					importBtn.disabled = false;
				} finally {
					inFlight = false;
				}
			}));
		}

		// ── 沉淀技能按钮（位于导入知识库按钮右侧）──
		if (this._onExtractSkill) {
			const skillBtn = append(footer, $("button.chat-msg-action-btn.chat-msg-skill-btn")) as HTMLButtonElement;
			skillBtn.title = "沉淀技能";
			const skillSvg = this._svgSkillIcon();
			skillBtn.appendChild(skillSvg);
			let skillInFlight = false;
			this._register(addDisposableListener(skillBtn, EventType.CLICK, async (e: Event) => {
				e.stopPropagation();
				if (skillInFlight) { return; }
				skillInFlight = true;
				skillBtn.disabled = true;
				try {
					const snapshot = msg.content ?? '';
					await this._onExtractSkill!(snapshot);
					// 视觉反馈：图标换成对号 + 绿色（1.5s 后还原）
					skillBtn.removeChild(skillSvg);
					const checkSvg = this._svgCheckSmall();
					skillBtn.appendChild(checkSvg);
					skillBtn.classList.add("chat-msg-import-kb-saved");
					setTimeout(() => {
						skillBtn.classList.remove("chat-msg-import-kb-saved");
						try { skillBtn.removeChild(checkSvg); } catch { /* already removed */ }
						skillBtn.appendChild(skillSvg);
					}, 1500);
				} finally {
					skillBtn.disabled = false;
					skillInFlight = false;
				}
			}));
		}

		// ── 分隔线 ──
		append(footer, $(".chat-bubble-footer-sep"));

		// ── 积分（pill 样式，$ 图标 + 积分 + 数值）──
		// 2026-07-27：即使 credit 为 0（网关未计费/免费额度）也展示占位，
		// 不再要求 >0——避免用户误以为"没有显示"是 bug。
		if (msg.tokenUsage?.credit !== undefined) {
			const scoreWrap = append(footer, $("span.chat-bubble-footer-item.chat-footer-pill"));
			// $ 图标（圆形 $）
			append(scoreWrap, $('span.chat-footer-pill-icon.codicon.codicon-credit-card'));
		append(scoreWrap, $('span.chat-footer-pill-label', undefined, '积分'));
		append(scoreWrap, $('span.chat-footer-pill-value', undefined, `：${msg.tokenUsage.credit.toFixed(2)}`));
		}

		// ── Tokens（pill 样式 + tokens-popup 详情）──
		if (msg.tokenUsage?.total !== undefined && msg.tokenUsage.total > 0) {
			const tokenWrap = append(footer, $("span.chat-bubble-footer-item.chat-footer-pill.tokens-item"));
			// clipboard 图标
			append(tokenWrap, $('span.chat-footer-pill-icon.codicon.codicon-clippy'));
			append(tokenWrap, $('span.chat-footer-pill-label', undefined, 'Tokens'));
			append(tokenWrap, $('span.chat-footer-pill-value', undefined, `: ${msg.tokenUsage.total.toLocaleString()}`));
			// 信息小图标，提示 hover 查看明细
			append(tokenWrap, $('span.chat-footer-pill-info.codicon.codicon-info'));

			// ── Token 消耗明细 Popup ──
			const tu = msg.tokenUsage;
			const cachedRead = tu.cachedRead ?? tu.cached ?? 0;
			const cacheWrite = tu.cacheWrite ?? 0;
			const cacheMiss = tu.cacheMiss ?? Math.max(0, tu.input - cachedRead - cacheWrite);
			const reasoning = tu.reasoning ?? 0;
			const contentTokens = Math.max(0, tu.output - reasoning);
			const hitRate = tu.cacheHitRate ?? (tu.input > 0 ? (cachedRead / tu.input) * 100 : 0);

			const popup = append(tokenWrap, $('div.tokens-popup'));
			// 标题行：左侧 "Token 消耗明细" + 右侧 "总计 X"
			const titleRow = append(popup, $('div.tokens-popup-header'));
			append(titleRow, $('span.tokens-popup-title', undefined, 'Token 消耗明细'));
			const totalEl = append(titleRow, $('span.tokens-popup-total-inline'));
			append(totalEl, $('span.label', undefined, '总计'));
			append(totalEl, $('span.value', undefined, tu.total.toLocaleString()));
			// 输入分组
			const inputGroup = append(popup, $('div.tokens-popup-group'));
			const inputTitle = append(inputGroup, $('div.tokens-popup-group-title'));
			append(inputTitle, $('span.group-name', undefined, '输入'));
			append(inputTitle, $('span.group-value', undefined, tu.input.toLocaleString()));
			if (cachedRead > 0 || cacheMiss > 0 || cacheWrite > 0) {
				if (cachedRead > 0) {
					const row = append(inputGroup, $('div.tokens-popup-sub-row'));
					append(row, $('span.sub-dot.hit'));
					append(row, $('span.sub-label', undefined, '缓存命中'));
					append(row, $('span.sub-value.highlight', undefined, cachedRead.toLocaleString()));
				}
				if (cacheMiss > 0) {
					const row = append(inputGroup, $('div.tokens-popup-sub-row'));
					append(row, $('span.sub-dot.miss'));
					append(row, $('span.sub-label', undefined, '缓存未命中'));
					append(row, $('span.sub-value', undefined, cacheMiss.toLocaleString()));
				}
				if (cacheWrite > 0) {
					const row = append(inputGroup, $('div.tokens-popup-sub-row'));
					append(row, $('span.sub-dot.write'));
					append(row, $('span.sub-label', undefined, '缓存写入'));
					append(row, $('span.sub-value', undefined, cacheWrite.toLocaleString()));
				}
			}
			// 输出分组
			const outputGroup = append(popup, $('div.tokens-popup-group'));
			const outputTitle = append(outputGroup, $('div.tokens-popup-group-title'));
			append(outputTitle, $('span.group-name', undefined, '输出'));
			append(outputTitle, $('span.group-value', undefined, tu.output.toLocaleString()));
			if (reasoning > 0 || contentTokens > 0) {
				if (reasoning > 0) {
					const row = append(outputGroup, $('div.tokens-popup-sub-row'));
					append(row, $('span.sub-label', undefined, '思考过程'));
					append(row, $('span.sub-value', undefined, reasoning.toLocaleString()));
				}
				const row = append(outputGroup, $('div.tokens-popup-sub-row'));
				append(row, $('span.sub-label', undefined, '回复内容'));
				append(row, $('span.sub-value', undefined, contentTokens.toLocaleString()));
			}
			// 缓存命中率（带三段组合进度条：命中绿 + 写入黄 + 未命中红）
			if (hitRate > 0 || cachedRead > 0) {
				const hitRateEl = append(popup, $('div.tokens-popup-hit-rate'));
				const rateHeader = append(hitRateEl, $('div.rate-header'));
				append(rateHeader, $('span.rate-icon.codicon.codicon-zap'));
				append(rateHeader, $('span.rate-label', undefined, '缓存命中率'));
				append(rateHeader, $('span.rate-value', undefined, `${hitRate.toFixed(1)}%`));
				// 进度条：三段按占 input 比例拼接（与图例配色一致）
				const bar = append(hitRateEl, $('div.tokens-popup-hit-bar'));
				if (tu.input > 0) {
					const hitSeg = append(bar, $('span.seg.hit')) as HTMLElement;
					hitSeg.style.width = `${(cachedRead / tu.input) * 100}%`;
					const writeSeg = append(bar, $('span.seg.write')) as HTMLElement;
					writeSeg.style.width = `${(cacheWrite / tu.input) * 100}%`;
					const missSeg = append(bar, $('span.seg.miss')) as HTMLElement;
					missSeg.style.width = `${(cacheMiss / tu.input) * 100}%`;
				}
				// 底部图例
				const legend = append(hitRateEl, $('div.tokens-popup-legend'));
				const lg1 = append(legend, $('span.legend-item'));
				append(lg1, $('span.legend-dot.hit'));
				append(lg1, $('span.legend-label', undefined, '命中'));
				const lg2 = append(legend, $('span.legend-item'));
				append(lg2, $('span.legend-dot.write'));
				append(lg2, $('span.legend-label', undefined, '写入'));
				const lg3 = append(legend, $('span.legend-item'));
				append(lg3, $('span.legend-dot.miss'));
				append(lg3, $('span.legend-label', undefined, '未命中'));
			}
		}

		// ── 耗时（pill 样式，时钟图标 + 耗时 + 数值）──
		const durMs = typeof (msg.metadata?.durationMs) === 'number'
			? (msg.metadata.durationMs as number)
			: 0;
		if (durMs > 0) {
			const durWrap = append(footer, $("span.chat-bubble-footer-item.chat-footer-pill.duration-item"));
			append(durWrap, $('span.chat-footer-pill-icon.codicon.codicon-watch'));
			append(durWrap, $('span.chat-footer-pill-label', undefined, '耗时'));
			append(durWrap, $('span.chat-footer-pill-value', undefined, `: ${this._formatDuration(durMs)}`));
		}

		return footer;
	}

protected override _transitionStreamingToComplete(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		const bubble = existingEl.querySelector('.chat-bubble') as HTMLElement | null;
		if (!bubble) {
			// 找不到 bubble，回退到全量重建
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

	// 1. 移除流式光标 + 阶段活动指示器
	bubble.querySelectorAll('.streaming-cursor, .phase-activity-indicator').forEach(el => el.remove());

	// 1.5 thinking 卡片完成态（P-T1 配套）：spinner→...、思考中...→思考过程；
	// 已渲染 body 做最终完整渲染（流式中 thinkingMdScheduler 节流可能滞后末几个 delta）。
	// 多 episode 时取最后一张卡 + 该 episode 文本（与流式更新路径一致）。
	const thinkingCards = bubble.querySelectorAll('.thinking-card');
	const thinkingCard = thinkingCards[thinkingCards.length - 1] as HTMLElement | undefined;
	if (thinkingCard && msg.thinking) {
		this._updateThinkingCardHeader(thinkingCard, !!msg.isThinking);
		const body = thinkingCard.querySelector('.thinking-card-body') as HTMLElement | null;
		if (body && body.dataset.rendered === '1') {
			const lastThinkingPart = msg.parts
				? [...msg.parts].reverse().find(p => p.kind === 'thinking') as IThinkingMessagePart | undefined
				: undefined;
			this._resetIncrementalMd(body);
			this._renderThinkingCardBody(body, { ...msg, thinking: lastThinkingPart?.text ?? msg.thinking });
			this.thinkingMdScheduler.reset();
		}
	}

		// 2. 将 streaming-container 的 textContent 替换为完整 markdown 渲染
		const streamingContainer = bubble.querySelector('.streaming-container') as HTMLElement | null;
		if (streamingContainer && msg.content) {
			streamingContainer.classList.remove('streaming-container');
			// 清理旧的 markdown disposable
			this._cleanupMarkdownDisposables(streamingContainer);
			streamingContainer.textContent = '';
		this._renderMarkdownContent(streamingContainer, msg.content, true);
		this.mdScheduler.markRendered(msg.content);
		}

		// 3. 追加 footer（如果尚不存在）
		// Agent loop 进行中（_isSending === true）时跳过 footer 渲染，
		// 避免复制/积分/token 消耗信息在中间迭代中刷屏。
		// loop 结束后由 setSending(false) 统一补齐。
		if (!this._isSending && !bubble.querySelector('.chat-bubble-footer')) {
			// loop 已结束：移除流式占位并以真实 footer 替换（高度一致，无位移）
			bubble.querySelector('.chat-bubble-footer-placeholder')?.remove();
			bubble.appendChild(this._createFooter(msg));
		} else if (bubble.querySelector('.chat-bubble-footer-placeholder') &&
			// 非最后一条 assistant（或 loop 已结束）的占位已经无用，移除避免空 gap
			(this._isSending && !this._isLastAssistantMessage(msg))) {
			bubble.querySelector('.chat-bubble-footer-placeholder')?.remove();
		}
	}

protected override _createThinkingIndicator(): HTMLElement {
		const indicator = $('.thinking-indicator');
		const label = append(indicator, $('span.thinking-indicator-label'));
		label.textContent = '正在思考';
		const dots = append(indicator, $('span.thinking-indicator-dots'));
		for (let i = 0; i < 3; i++) {
			append(dots, $('span.thinking-indicator-dot'));
		}
		return indicator;
	}

	/**
	 * 在 LLM 消息气泡中确保存在阶段感知的活动指示器。
	 *
	 * 根据当前 streamPhase / isThinking 状态显示不同指示器：
	 *   - llm_thinking / (isThinking && !thinking) → "正在思考..." + 跳动点
	 *   - tool_executing / tool_parsing          → "执行中..." + spinner
	 *   - llm_streaming（有内容）                → 闪烁光标 |
	 *   - 其他 isStreaming 状态                  → 闪烁光标 |（兜底）
	 *
	 * 每次 updateMessage 重建/增量更新时都会调用，自动替换旧指示器。
	 */
	protected _ensurePhaseIndicator(bubble: HTMLElement, msg: IAgentChatMessage): void {
		// 移除旧指示器（避免重复）
		const old = bubble.querySelector('.phase-activity-indicator');
		old?.remove();

		const phase = msg.streamPhase;
		let el: HTMLElement | null = null;

		if (msg.isStreaming && msg.activityText) {
			// 瞬时活动文本（2026-07-26）：工具参数流式生成等轻量进度——
			// 大参数（万级 tokens 数分钟）期间每秒可见刷新，消除假死感
			// （事故 1785065604981）。优先级最高：它比「正在思考/执行中」更具体。
			el = $('.phase-activity-indicator.phase-executing');
			const icon = append(el, $('span.phase-icon'));
			icon.textContent = '⏳';
			const label = append(el, $('span.phase-label'));
			label.textContent = msg.activityText;
		} else if (msg.isThinking) {
			// 思考阶段（2026-07-26 修正：不再要求 !thinking——thinking 卡片
			// 置顶后跨轮累积，turn 间等待 LLM 时同样需要「正在思考...」指示，
			// 否则工具结束到下轮首 delta 之间无任何提示）。卡片与指示器
			// 分处气泡顶部/底部，无视觉冲突。
			el = this._createThinkingIndicator();
			el.classList.add('phase-activity-indicator', 'phase-thinking');
		} else if (phase === 'tool_executing') {
			// 工具执行阶段
			el = $('.phase-activity-indicator.phase-executing');
			const icon = append(el, $('span.phase-icon'));
			icon.textContent = '⏳';
			const label = append(el, $('span.phase-label'));
			label.textContent = '执行中...';
		} else {
			// 光标由 .streaming-container 的 CSS ::after 伪元素统一渲染，
			// 此处不额外追加 span.streaming-cursor，避免出现双光标。
		}

		if (el) {
			// P0: indicator 必须始终是 bubble 的最后一个子元素，
			// 避免后续 tool_start delta 把新工具卡插入到 indicator 之后。
			// 先移除可能存在的 footer-placeholder，追加 indicator，再恢复 footer-placeholder。
			const footerPlaceholder = bubble.querySelector('.chat-bubble-footer-placeholder');
			footerPlaceholder?.remove();
			append(bubble, el);
			if (footerPlaceholder) {
				bubble.appendChild(footerPlaceholder);
			}
		}
	}

protected override _extractFilePath(tc: IToolCall): string {
		if (tc.filePath) { return tc.filePath; }
		try {
			if (tc.args) {
				const args = JSON.parse(tc.args);
				for (const key of ['filePath', 'path', 'file', 'filepath']) {
					if (typeof args[key] === 'string' && args[key].length > 0) {
						return args[key];
					}
				}
			}
		} catch { /* ignore */ }
		return '';
	}

protected override _getLanguageTag(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase() || '';
		const map: Record<string, string> = {
			ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX',
			py: 'PY', java: 'JAVA', kt: 'KT', swift: 'SWIFT',
			go: 'GO', rs: 'RS', cpp: 'C++', c: 'C', h: 'H',
			html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
			json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML',
			md: 'MD', sql: 'SQL', sh: 'SH', bash: 'SH', zsh: 'SH',
			vue: 'VUE', svelte: 'SVELTE', dart: 'DART',
		};
		return map[ext] || ext.toUpperCase().slice(0, 4);
	}

protected override _computeDiffStats(tc: IToolCall): { added: number; removed: number; lines: Array<{ type: 'add' | 'rem' | 'ctx'; text: string }> } {
		try {
			if (!tc.args) { return { added: 0, removed: 0, lines: [] }; }
			const args = JSON.parse(tc.args);
			// patch 模式：search + replace
			if (typeof args['search'] === 'string' && typeof args['replace'] === 'string') {
				const searchLines = args['search'].split('\n');
				const replaceLines = args['replace'].split('\n');
				return {
					added: replaceLines.length,
					removed: searchLines.length,
					lines: [
						...searchLines.map(text => ({ type: 'rem' as const, text })),
						...replaceLines.map(text => ({ type: 'add' as const, text })),
					],
				};
			}
			// write 模式：content —— 新增文件，全是 +N
			if (typeof args['content'] === 'string') {
				const lines = args['content'].split('\n');
				return { added: lines.length, removed: 0, lines: lines.map(text => ({ type: 'add' as const, text })) };
			}
		} catch { /* ignore */ }
		return { added: 0, removed: 0, lines: [] };
	}

protected override _appendCanceledNotice(wrapper: HTMLElement): void {
		const notice = append(wrapper, $('.tool-rejected-notice'));
		notice.textContent = '命令已取消';
	}

protected override _toolResultText(result: string): string {
		try {
			const parsed = JSON.parse(result);
			if (typeof parsed === 'string') { return parsed; }
			// 顶层数组 [{type:'text', text:'TOON...'}]（search_graph / trace_path 等）
			if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type === 'text') {
				return parsed.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
			}
			// 对象包装 {content:[{type:'text', text:'...'}]}（其他工具）
			if (parsed && Array.isArray((parsed as any).content)) {
				return (parsed as any).content
					.map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
					.join('');
			}
			return JSON.stringify(parsed, null, 2);
		} catch {
			return result;
		}
	}

protected override _formatDuration(ms: number): string {
		if (ms < 1000) { return `${ms}ms`; }
		const seconds = ms / 1000;
		if (seconds < 60) { return `${seconds.toFixed(1)}s`; }
		const minutes = Math.floor(seconds / 60);
		const remainSec = Math.round(seconds % 60);
		return `${minutes}m ${remainSec}s`;
	}

protected override _toggleNodeCollapse(
		nodeId: string,
		card: HTMLElement,
		nodeBody: HTMLElement,
		summary: HTMLElement,
		collapseBtn: HTMLElement,
		chevron: HTMLElement,
	): void {
		const isCollapsed = this._nodeCollapsedState.get(nodeId) === true;
		const newCollapsed = !isCollapsed;
		this._nodeCollapsedState.set(nodeId, newCollapsed);

		nodeBody.style.display = newCollapsed ? 'none' : '';
		summary.style.display = newCollapsed ? 'block' : 'none';
		card.classList.toggle('collapsed', newCollapsed);

		collapseBtn.classList.toggle('collapsed', newCollapsed);
		collapseBtn.classList.toggle('expanded', !newCollapsed);
		collapseBtn.title = newCollapsed ? '点击展开' : '点击收缩';
		chevron.textContent = newCollapsed ? '▶' : '▼';
	}

protected override _addMessageActionButtons(container: HTMLElement, msg: IAgentChatMessage): void {
		const actions = append(container, $(".chat-msg-actions"));
		const isAssistant = msg.role === 'assistant';

		// 编辑 / 复制：仅用户气泡显示。assistant（LLM）气泡右下角不显示这两个按钮。
		if (!isAssistant) {
			if (this._onEditMessage) {
				const editBtn = append(actions, $("button.chat-msg-action-btn.chat-msg-edit-btn"));
				editBtn.title = "编辑";
				editBtn.appendChild(this._svgEditIcon());
				this._register(addDisposableListener(editBtn, EventType.CLICK, (e) => {
					e.stopPropagation();
					this._openUserEditOverlay(msg);
				}));
			}

			const copyBtn = append(actions, $("button.chat-msg-action-btn.chat-msg-copy-btn"));
			copyBtn.title = "复制";
			const copySvg = this._svgCopyIcon();
			copyBtn.appendChild(copySvg);
			this._register(addDisposableListener(copyBtn, EventType.CLICK, async (e) => {
				e.stopPropagation();
				const ok = await this._copyToClipboard(msg.content);
				if (ok) {
					// 替换为对号图标
					copyBtn.removeChild(copySvg);
					const checkSvg = this._svgCheckSmall();
					copyBtn.appendChild(checkSvg);
					copyBtn.classList.add("chat-msg-copy-copied");
					setTimeout(() => {
						copyBtn.classList.remove("chat-msg-copy-copied");
						copyBtn.removeChild(checkSvg);
						copyBtn.appendChild(copySvg);
					}, 1500);
				}
			}));
		}

		// 回撤改动：用户与 assistant 气泡均保留（仅在存在可回撤的检查点时显示，避免空转无反馈）。
		if (this._onCheckpointAction && this._checkpoint) {
			const undoBtn = append(actions, $("button.chat-msg-action-btn.chat-msg-undo-btn"));
			undoBtn.title = "回撤改动";
			undoBtn.appendChild(this._svgUndoIcon());
			this._register(addDisposableListener(undoBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				// 检查是否跳过确认对话框
				try {
					if (localStorage.getItem('agentChat_skipUndoConfirm') === '1') {
						this._onCheckpointAction?.('undoAll');
						return;
					}
				} catch { /* ignore */ }
				this._openUndoConfirmDialog();
			}));
		}
	}

protected override _openUndoConfirmDialog(): void {
		// 防止重复弹出
		if (this._container.querySelector('.checkpoint-undo-dialog-overlay')) { return; }
		const cp = this._checkpoint;
		// 无可回撤的检查点：静默返回，避免无意义的 undoAll 空操作
		if (!cp) { return; }

		// ── 背景遮罩 + 居中容器 ──
		const overlay = append(this._container, $('.checkpoint-undo-dialog-overlay'));
		const dialog = append(overlay, $('.checkpoint-undo-dialog'));

		// ── 标题栏：标题 + 关闭 × ──
		const header = append(dialog, $('.checkpoint-undo-dialog-header'));
		const titleText = append(header, $('span.checkpoint-undo-title'));
		titleText.textContent = `确定回退 检查点 ${cp.id}`;
		const closeBtn = append(header, $('button.checkpoint-undo-close-btn'));
		closeBtn.title = '关闭';
		closeBtn.setAttribute('aria-label', '关闭');
		const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		closeSvg.setAttribute('viewBox', '0 0 24 24');
		closeSvg.setAttribute('width', '16');
		closeSvg.setAttribute('height', '16');
		closeSvg.setAttribute('fill', 'none');
		closeSvg.setAttribute('stroke', 'currentColor');
		closeSvg.setAttribute('stroke-width', '2');
		closeSvg.setAttribute('stroke-linecap', 'round');
		closeSvg.setAttribute('stroke-linejoin', 'round');
		const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		closePath.setAttribute('d', 'M18 6L6 18M6 6l12 12');
		closeSvg.appendChild(closePath);
		closeBtn.appendChild(closeSvg);

		// ── 描述文字 ──
		const desc = append(dialog, $('p.checkpoint-undo-desc'));
		desc.textContent = `回退将会恢复操作变更过的 ${cp.fileCount} 个文件`;

		// ── 文件变更列表 ──
		const fileList = append(dialog, $('.checkpoint-undo-file-list'));
		for (const f of cp.files) {
			const fileRow = append(fileList, $('.checkpoint-undo-file-row'));
			// # 前缀图标（模拟 git diff 样式）
			const hashIcon = append(fileRow, $('span.checkpoint-file-hash'));
			hashIcon.textContent = '# ';
			// 文件名
			const fileName = append(fileRow, $('span.checkpoint-file-name'));
			// 提取短路径（只取最后一段）
			const shortName = f.path.split(/[/\\]/).pop() || f.path;
			fileName.textContent = shortName;
			// 变更统计（真实 +N -M，来自 ICheckpointFileChange 跨检查点累加）
			const stats = append(fileRow, $('span.checkpoint-file-stats'));
			const added = f.additions ?? 0;
			const removed = f.deletions ?? 0;
			stats.textContent = `+${added} -${removed}`;
			stats.classList.add(f.status === 'deleted' ? 'stat-deleted' : f.status === 'created' ? 'stat-added' : 'stat-modified');

			const revertLabel = append(fileRow, $('span.checkpoint-file-revert-label'));
			revertLabel.textContent = '将撤回改动';

			// 点击行可查看 diff
			fileRow.style.cursor = 'pointer';
			this._register(addDisposableListener(fileRow, EventType.CLICK, () => {
				this._onCheckpointAction?.('openDiff', { filePath: f.path });
			}));
		}

		// ── 底部操作栏：[确认] [取消]  + [×]不再提示 ──
		const footer = append(dialog, $('.checkpoint-undo-footer'));

		const btnGroup = append(footer, $('.checkpoint-undo-btn-group'));

		const confirmBtn = append(btnGroup, $('button.checkpoint-undo-btn.confirm'));
		confirmBtn.textContent = '确认';
		const cancelBtn = append(btnGroup, $('button.checkpoint-undo-btn.cancel'));
		cancelBtn.textContent = '取消';

		// "不再提示" 复选框
		const noPromptWrap = append(footer, $('label.checkpoint-no-prompt-wrap'));
		const noPromptCb = append(noPromptWrap, $('input.checkpoint-no-prompt-cb')) as HTMLInputElement;
		noPromptCb.type = 'checkbox';
		append(noPromptWrap, $('span.checkpoint-no-prompt-text')).textContent = '不再提示';

		// ── 关闭对话框辅助方法 ──
		const closeDialog = () => { overlay.remove(); };

		// ── 事件绑定 ──
		this._register(addDisposableListener(closeBtn, EventType.CLICK, closeDialog));
		this._register(addDisposableListener(overlay, EventType.CLICK, (e: Event) => {
			if (e.target === overlay) { closeDialog(); }
		}));
		this._register(addDisposableListener(cancelBtn, EventType.CLICK, closeDialog));
		this._register(addDisposableListener(confirmBtn, EventType.CLICK, () => {
			// 记住"不再提示"
			if (noPromptCb.checked) {
				try { localStorage.setItem('agentChat_skipUndoConfirm', '1'); } catch { /* ignore */ }
			}
			closeDialog();
			this._onCheckpointAction?.('undoAll');
		}));

		// ESC 关闭
		const onEsc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { closeDialog(); }
		};
		mainWindow.addEventListener('keydown', onEsc);
		this._register({ dispose: () => mainWindow.removeEventListener('keydown', onEsc) });
	}

protected override _openUserEditOverlay(msg: IAgentChatMessage): void {
		const msgEl = this._messagesContainer?.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null;
		if (!msgEl) { return; }
		if (msgEl.querySelector(".chat-user-edit-composer")) { return; }

		const bubble = msgEl.querySelector(".chat-bubble") as HTMLElement | null;
		if (!bubble) { return; }

		// Void-style inline edit: 气泡内容替换为 composer，消息宽度变为 100%
		const origContent = bubble.querySelector(".message-content") as HTMLElement | null;
		const origActions = bubble.querySelector(".chat-msg-actions") as HTMLElement | null;
		if (origContent) { origContent.style.display = "none"; }
		if (origActions) { origActions.style.display = "none"; }
		msgEl.classList.add('chat-message-edit-mode');

		// Composer（与底部 chat-composer-box 完全一致）
		const composer = append(bubble, $(".chat-user-edit-composer"));
		const textarea = append(composer, $("textarea.chat-user-edit-input")) as HTMLTextAreaElement;
		textarea.value = msg.content;
		textarea.placeholder = "编辑消息...";
		textarea.rows = 1;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, 500)}px`;

		// Auto-resize — 与底部主输入框行为一致，最大高度 500px
		this._register(addDisposableListener(textarea, EventType.INPUT, () => {
			textarea.style.height = 'auto';
			textarea.style.height = `${Math.min(textarea.scrollHeight, 500)}px`;
		}));

		// Toolbar — 与底部 composer toolbar 完全一致
		const toolbar = append(composer, $(".chat-user-edit-toolbar"));
		const leftTools = append(toolbar, $("span.chat-user-edit-toolbar-left"));
		const attachBtn = this._appendEditToolbarBtn(leftTools, { title: "上传附件", svgPath: "M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" });
		this._register(addDisposableListener(attachBtn, EventType.CLICK, (e) => { e.stopPropagation(); this._fileInput?.click(); }));
		this._register(addDisposableListener(this._appendEditToolbarBtn(leftTools, { title: "语音输入", svgPath: "M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" }), EventType.CLICK, (e) => e.stopPropagation()));
		append(leftTools, $(".chat-user-edit-toolbar-divider"));
		// ChatOnly toggle — replaces legacy mode selector (MODE_OPTIONS + _chatMode)
		const chatOnlySvgPath = this._chatOnly
			? 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z'
			: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z';
		const chatOnlyLabel = this._chatOnly ? '纯聊' : '干活';
		const chatOnlyTitle = this._chatOnly ? '纯聊模式：已开启（禁止工具执行）' : '干活模式：点击切换至纯聊';
		const modeBtn = this._appendEditToolbarBtn(leftTools, {
			title: chatOnlyTitle,
			svgPath: chatOnlySvgPath,
			hasLabel: true,
			label: chatOnlyLabel,
			showChevron: false,
			cssClass: this._chatOnly ? 'mode-tag mode-tag-chatonly-on' : 'mode-tag',
		});
		this._register(addDisposableListener(modeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this._chatOnly = !this._chatOnly;
			this._refreshInputArea();
		}));
		const curProvider = this._providers.find(p => p.id === this._currentProvider)?.label || this._currentProvider || 'Provider';
		const providerBtn = this._appendEditToolbarBtn(leftTools, { title: '切换 Provider', svgPath: 'M2 3h20v14H2zM8 21h8M12 17v4', hasLabel: true, label: curProvider, showChevron: true, cssClass: 'provider-tag' });
		this._register(addDisposableListener(providerBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._providerDropdownEl) {
				this._closeProviderDropdown();
			} else {
				this._openProviderDropdown(providerBtn);
			}
		}));
		const curModel = this._currentModel || 'Model';
		const modelBtn = this._appendEditToolbarBtn(leftTools, { title: '切换模型', svgPath: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M12 12v7M8 12v7M16 12v7M5 3h14l-2 4H7L5 3z', hasLabel: true, label: curModel, showChevron: true, cssClass: 'model-tag' });
		this._register(addDisposableListener(modelBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._modelDropdownEl) {
				this._closeModelDropdown();
			} else {
				this._openModelDropdown(modelBtn);
			}
		}));
		const right = append(toolbar, $('span.chat-user-edit-toolbar-right'));
		this._renderEditContextUsageRing(right);
		const sendBtn = append(right, $('button.chat-send-circle')) as HTMLButtonElement;
		sendBtn.title = '重新生成';
		const sendSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		sendSvg.setAttribute('width', '10'); sendSvg.setAttribute('height', '10');
		sendSvg.setAttribute('viewBox', '0 0 24 24'); sendSvg.setAttribute('fill', 'none');
		sendSvg.setAttribute('stroke', 'currentColor'); sendSvg.setAttribute('stroke-width', '2');
		sendSvg.setAttribute('stroke-linecap', 'round'); sendSvg.setAttribute('stroke-linejoin', 'round');
		const sendLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		sendLine.setAttribute('x1', '22'); sendLine.setAttribute('y1', '2'); sendLine.setAttribute('x2', '11'); sendLine.setAttribute('y2', '13');
		sendSvg.appendChild(sendLine);
		const sendPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		sendPoly.setAttribute('points', '22 2 15 22 11 13 2 9 22 2');
		sendSvg.appendChild(sendPoly);
		sendBtn.appendChild(sendSvg);

		const hintsRow = append(composer, $(".chat-user-edit-hints-row"));
		const hints = append(hintsRow, $("span.chat-user-edit-hints"));
		const escKbd = document.createElement('kbd');
		escKbd.textContent = 'Esc';
		hints.appendChild(escKbd);
		hints.appendChild(document.createTextNode(' 取消'));

		const restore = () => {
			composer.remove();
			msgEl.classList.remove('chat-message-edit-mode');
			if (origContent) { origContent.style.display = ""; }
			if (origActions) { origActions.style.display = ""; }
		};

		// 点击 composer 外部区域时自动关闭编辑框
		const onOutsideMousedown = (e: MouseEvent) => {
			if (!composer.isConnected) { return; } // 已关闭
			const target = e.target as HTMLElement | null;
			if (!target) { return; }
			if (composer.contains(target) || (e.target as HTMLElement)?.closest?.('.chat-composer-box, .chat-input-area, .chat-send-circle, .provider-dropdown, .mode-dropdown-composer')) {
				return; // 点击在 composer 内部、底部输入区域或 mode/provider/model 下拉菜单 → 不关闭
			}
			restore();
		};
		this._register(addDisposableListener(mainWindow.document, EventType.MOUSE_DOWN, onOutsideMousedown));

		const commit = () => {
			const newText = textarea.value.trim();
			if (!newText || newText === msg.content.trim()) {
				restore();
				return;
			}
			const idx = this._messages.findIndex(m => m.id === msg.id);
			if (idx >= 0) {
				this._messages = this._messages.slice(0, idx);
				this._renderMessages();
			}
			restore();
			this._onEditMessage?.(msg.id, newText);
		};

		this._register(addDisposableListener(sendBtn, EventType.CLICK, (e) => { e.stopPropagation(); commit(); }));
		this._register(addDisposableListener(textarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); restore(); }
			else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
		}));
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	}

protected override _renderEditContextUsageRing(parent: HTMLElement): void {
		const usage = this._contextUsage;
		const pct = usage ? Math.max(0, Math.min(1, usage.ratio)) : 0;
		const warnLevel = pct > 0.8 ? 'danger' : pct > 0.6 ? 'warn' : '';
		const tooltipText = usage
			? `上下文 ${Math.round(pct * 100)}% (${usage.used} / ${usage.limit})\n输入: ${usage.used} / 上下文窗口: ${usage.limit}`
			: '上下文';
		const ringEl = append(parent, $(`.context-usage-ring${warnLevel ? '.' + warnLevel : ''}`));
		ringEl.title = tooltipText;

		const radius = 9; const stroke = 1.8;
		const size = (radius + stroke) * 2;
		const circumference = 2 * Math.PI * radius;
		const offset = circumference * (1 - pct);

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
		svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

		const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		bg.setAttribute('cx', String(size / 2)); bg.setAttribute('cy', String(size / 2));
		bg.setAttribute('r', String(radius)); bg.setAttribute('fill', 'none');
		bg.setAttribute('class', 'ring-track');
		bg.setAttribute('stroke-width', String(stroke));
		svg.appendChild(bg);

		const fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		fg.setAttribute('cx', String(size / 2)); fg.setAttribute('cy', String(size / 2));
		fg.setAttribute('r', String(radius)); fg.setAttribute('fill', 'none');
		fg.setAttribute('class', 'ring-progress');
		fg.setAttribute('stroke-width', String(stroke));
		fg.setAttribute('stroke-dasharray', String(circumference));
		fg.setAttribute('stroke-dashoffset', String(offset));
		fg.setAttribute('stroke-linecap', 'round');
		fg.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
		svg.appendChild(fg);
		ringEl.appendChild(svg);
	}

protected override async _copyToClipboard(text: string): Promise<boolean> {
		// Try modern Clipboard API first
		if (navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch { /* fall through to legacy method */ }
		}
		// Fallback: temporary textarea + execCommand('copy')
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			ta.style.top = '0';
			document.body.appendChild(ta);
			ta.focus();
			ta.select();
			const ok = document.execCommand('copy');
			document.body.removeChild(ta);
			return ok;
		} catch {
			return false;
		}
	}

	/**
	 * 性能探针：脚本化驱动 N 轮流式 markdown 负载，量化每帧渲染成本。
	 * 在 webview 控制台调用 `window.__SAROSIS_PERF_PROBE__(rounds)` 触发（rounds 默认 12）。
	 * 内部创建临时 assistant 气泡并逐块流式增量渲染（走真实 _updateStreamingContentInPlace
	 * markdown 路径），结束后清理 DOM / markdown 资源，不影响真实会话。
	 * 统计结果同时写入 window.__SAROSIS_PERF_PROBE_LAST__。
	 */
	protected override async runPerfProbe(rounds = 12): Promise<unknown> {
		if (!this._messagesContainer) {
			return { error: 'no messages container' };
		}

		// 贴近真实回复的 markdown（标题/列表/代码块/表格/引用），用于施压 markdown 渲染
		const SAMPLE_MD: string = [
			'# 性能探针示例回复',
			'',
			'这是一段用于**压测**聊天框渲染的 Markdown 文本，包含多种元素。',
			'',
			'## 列表',
			'- 项目一：流式增量渲染',
			'- 项目二：markdown 全量重解析',
			'- 项目三：代码块语法高亮',
			'',
			'| 指标 | 说明 |',
			'| --- | --- |',
			'| avgFrameMs | 平均帧耗时 |',
			'| p95FrameMs | 95 分位帧耗时 |',
			'',
			'> 引用块：对齐 Hermes perf-probe，量化每帧成本。',
			'',
			'```ts',
			'function fib(n: number): number {',
			'  return n < 2 ? n : fib(n - 1) + fib(n - 2);',
			'}',
			'console.log(fib(10));',
			'```',
			'',
			'更多正文用于拉长累计文本，模拟长 transcript 场景下的重渲染开销。',
		].join('\n');
		const chunkChars = 160;
		const total = SAMPLE_MD.length;

		// 采样每帧耗时
		const frames: number[] = [];
		let last = performance.now();
		let raf = 0;
		const sample = () => {
			const now = performance.now();
			frames.push(now - last);
			last = now;
			raf = requestAnimationFrame(sample);
		};
		raf = requestAnimationFrame(sample);

		let roundsDone = 0;
		let streamUpdates = 0;
		try {
			for (let r = 0; r < rounds; r++) {
				const id = `__perf_probe_${r}`;
				const msg = {
					id, role: 'assistant', content: '', isStreaming: true,
					parts: [], toolCalls: [], createdAt: Date.now(),
					streamPhase: 'llm_streaming', phase: 'llm_streaming',
					tokenUsage: { promptTokens: 123, completionTokens: 456, totalTokens: 579 },
					durationMs: 1234,
				} as unknown as IAgentChatMessage;
				const el = this._createMessageElement(msg);
				this._messagesContainer.appendChild(el);
				// 模拟 token 逐块到达（每帧让出一帧，贴近真实流式节奏）
				for (let i = 0; i < total; i += chunkChars) {
					msg.content = SAMPLE_MD.slice(0, i + chunkChars);
					this._updateStreamingContentInPlace(el, msg);
					streamUpdates++;
					await new Promise<void>((res) => setTimeout(res, 0));
				}
				// 结束流式：走真实 finalize 路径
				msg.isStreaming = false;
				this._transitionStreamingToComplete(el, msg);
				roundsDone++;
				await new Promise<void>((res) => requestAnimationFrame(() => res()));
				// 清理临时 DOM 与 markdown 资源
				this._cleanupMarkdownDisposables(el);
				el.remove();
			}
		} finally {
			cancelAnimationFrame(raf);
			// 复位流式增量渲染状态，避免指向已移除节点的定时器泄漏
			this.mdScheduler.reset();
		}

		frames.sort((a, b) => a - b);
		const avg = frames.reduce((s, v) => s + v, 0) / (frames.length || 1);
		const p95 = frames[Math.floor(frames.length * 0.95)] ?? avg;
		const max = frames[frames.length - 1] ?? 0;
		const stats = {
			rounds: roundsDone,
			totalFrames: frames.length,
			avgFrameMs: +avg.toFixed(2),
			p95FrameMs: +p95.toFixed(2),
			maxFrameMs: +max.toFixed(2),
			streamUpdates,
			note: '每帧耗时(ms)；>16.7ms 表示低于 60fps。复测：window.__SAROSIS_PERF_PROBE__(N)',
		};
		(window as unknown as Record<string, unknown>).__SAROSIS_PERF_PROBE_LAST__ = stats;
		console.info('[PerfProbe]', stats);
		return stats;
	}
}
