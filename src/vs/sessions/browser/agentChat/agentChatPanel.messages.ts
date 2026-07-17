import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IAgentChatMessage, IToolCall, ISubAgentData } from './agentChatTypes.js';
import { MODE_OPTIONS, AgentChatPanelBase } from './agentChatPanel.base.js';
import { AgentChatPanelDropdowns } from './agentChatPanel.dropdowns.js';

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
					this._scrollToBottomBtn.style.display = show ? "flex" : "none";
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
					// 拖拽滚动条期间不更新 _isAtBottom（由 MOUSE_DOWN/UP 控制）
					if (!this._isDraggingScrollbar) {
						if (atBottom) {
							this._isAtBottom = true;
							// 用户手动滚到底部 → 清零未读计数
							if (this._unreadCount > 0) {
								this._unreadCount = 0;
								this._scrollbar.updateScrollBadge();
							}
						} else if (!this._isSending) {
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
		this._scrollToBottomBtn.style.display = "none";
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
				this._scrollToBottomBtn.style.display = "none";
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
		const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
		console.debug(`[ScrollDiag] _renderMessages count=${this._messages.length} _wasLoading=${this._wasLoading} caller: ${diagStack}`);
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
		if (!existingEl) { return; }

		// Force rebuild when isThinking state changes — the thinking indicator
		// needs to be added/removed, which fast paths don't handle.
		const existingIndicator = existingEl.querySelector('.thinking-indicator');
		const shouldShowIndicator = !!(msg.isStreaming && msg.isThinking && !msg.thinking);
		if (!!existingIndicator !== shouldShowIndicator) {
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		const partsToolCount = msg.parts ? msg.parts.filter(p => p.kind === 'tool').length : 0;
		const hasToolCalls = (msg.toolCalls && msg.toolCalls.length > 0) || partsToolCount > 0;
		const hasStructuralChange =
			hasToolCalls ||
			msg.confirmation ||
			(msg.subAgents && msg.subAgents.length > 0) ||
			(msg.workflowExecutions && Object.keys(msg.workflowExecutions).length > 0) ||
			(msg.workflowEvents && msg.workflowEvents.length > 0) ||
			(msg.collectVariables && Object.keys(msg.collectVariables).length > 0);

		// Fast path 1: no structural change, streaming text-only update
		if (!hasStructuralChange && msg.isStreaming && msg.content) {
			const streamingContainer = existingEl.querySelector('.streaming-container') as HTMLElement | null;
			const streamingText = existingEl.querySelector('.streaming-text') as HTMLSpanElement | null;

			if (streamingContainer) {
				// 节流 markdown 渲染：delta 到达时仅更新缓存内容，不立即操作 DOM。
				// 定时器每 200ms 做一次增量/全量 markdown 渲染。
				// 首次渲染之前（_streamingMdLastRendered 为空）用 textContent 显示纯文本，
				// 让用户立即看到输出；首次 markdown 渲染后不再覆盖，由增量更新追加。
				if (!this._streamingMdLastRendered) {
					streamingContainer.textContent = msg.content;
				}
				this._streamingMdTarget = { container: streamingContainer };
				this._streamingMdLastContent = msg.content;
				if (this._streamingMdTimer === null) {
					this._streamingMdTimer = window.setTimeout(() => {
						this._streamingMdTimer = null;
						const target = this._streamingMdTarget;
						if (!target || !target.container.isConnected || !this._streamingMdLastContent) { return; }
						// P0: 内容未变 → 跳过渲染
						if (this._streamingMdLastContent === this._streamingMdLastRendered) { return; }
						// P0: 尝试增量更新——只渲染追加部分，避免全量 re-parse
						if (this._tryIncrementalMarkdownRender(target.container, this._streamingMdLastContent)) {
							return;
						}
					// 全量重建 — 离屏渲染后原子替换，避免 textContent='' 导致的空白帧闪烁
					{
						const tempDiv = document.createElement('div');
						this._renderMarkdownContent(tempDiv, this._streamingMdLastContent, true);
						const children = Array.from(tempDiv.childNodes);
						target.container.replaceChildren(...children);
					}
						this._streamingMdLastRendered = this._streamingMdLastContent;
					}, AgentChatPanelBase.STREAMING_MD_INTERVAL);
				}
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
			const existingToolCards = existingEl.querySelectorAll('.tool-header-wrapper');
			if (existingToolCards.length > 0) {
				// Tool cards are already present in DOM — update only the content parts
				this._updateStreamingContentInPlace(existingEl, msg);
				return;
			}
		}

		// Slow path: rebuild this single message element and replace in DOM
		// Clean up any markdown disposables associated with the old element
		// before replacing it, to prevent renderMarkdown() disposable leaks.

		// P1: 流式结束转换——isStreaming 从 true 变为 false 时。
		// 条件：之前在流式（有 streaming-container 或 streaming-cursor），现在不流式。
		const wasStreaming = existingEl.querySelector('.streaming-container, .streaming-cursor') !== null;
		if (wasStreaming && !msg.isStreaming) {
			if (!hasStructuralChange) {
				// 无结构性变化：轻量转换——移除光标 + 渲染 markdown + 追加 footer。
				this._transitionStreamingToComplete(existingEl, msg);
			} else {
				// 结构性消息（含工具卡/确认/子代理/工作流）流式结束：
				// 旧逻辑落到下方「只更新工具卡状态 + footer」的分支，不会重渲染正文，
				// 导致流式期间以 raw text / 半渲染残留的正文（如大段 HTML mockup）在
				// 结束后依旧错乱。这里以最终完整 parts/content 做一次干净全量重建
				// （与历史恢复路径完全一致），彻底消除流式增量渲染累积的错位。
				// 重建仅在流式结束时发生一次，开销可接受。
				this._streamingMdLastRendered = '';
				this._streamingMdLastContent = '';
				this._streamingMdTarget = null;
				this._rebuildMessageElement(existingEl, msg);
			}
			return;
		}

		// P1.5: 流式期间首个 tool_start → 增量追加工具卡，避免
		// replaceChild 导致 scrollHeight 突变 → 滚动条跳动。
		if (msg.isStreaming && hasToolCalls) {
			const existingCards = existingEl.querySelectorAll('.tool-header-wrapper[data-tool-id]');
			if (existingCards.length === 0) {
			const container = existingEl.querySelector('.chat-bubble') as HTMLElement || existingEl;
			for (const tc of msg.toolCalls || []) {
				if (!tc.id) continue;
				this._appendToolCard(container, tc, msg);
			}
				return;
			}
		}

		// P2+: 非流式工具卡增量更新——如果已有工具卡且 ID 匹配（仅状态/结果变化），
		// 只更新变化的工具卡，不重建整条消息。
		if (hasToolCalls && !msg.isStreaming) {
			const existingCards = existingEl.querySelectorAll('.tool-header-wrapper[data-tool-id]');
			const newToolIds = (msg.toolCalls || []).map(tc => tc.id).filter(Boolean);
			if (existingCards.length === newToolIds.length && existingCards.length > 0) {
				const existingIds = Array.from(existingCards).map(c => c.getAttribute('data-tool-id'));
				const idsMatch = newToolIds.every((id, i) => existingIds[i] === id);
				if (idsMatch) {
					// 流式刚结束 → 移除光标 + streaming-container class + 追加 footer
					// Agent loop 进行中（_isSending === true）时跳过 footer 渲染，
					// 避免复制/积分/token 消耗信息在中间迭代中刷屏。
					// loop 结束后由 setSending(false) 统一补齐。
					const bubble = existingEl.querySelector('.chat-bubble');
					if (bubble) {
						bubble.querySelectorAll('.streaming-cursor').forEach(el => el.remove());
						const sc = bubble.querySelector('.streaming-container');
						if (sc) { sc.classList.remove('streaming-container'); }
						if (!this._isSending && !bubble.querySelector('.chat-bubble-footer')) {
							bubble.appendChild(this._createFooter(msg));
						}
					}
					this._updateToolCardStatuses(existingEl, msg);
					return;
				}
			}
		}

		this._cleanupMarkdownDisposables(existingEl);
		const newEl = this._createMessageElement(msg);
		this._messagesContainer.replaceChild(newEl, existingEl);
	}

protected override _updateStreamingContentInPlace(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		// 检测工具调用结构是否发生变化（新增或移除工具卡片）
		const existingToolCards = existingEl.querySelectorAll('.tool-header-wrapper');
		const newToolCount = msg.parts
			? msg.parts.filter(p => p.kind === 'tool').length
			: (msg.toolCalls?.length ?? 0);

		if (existingToolCards.length !== newToolCount) {
			// 结构变化：完整重建
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		// 阶段E：parts 多段文本与工具卡交织 → 增量更新复杂，直接完整重建（与旧 interleaved 行为一致）
		const partsSegments = existingEl.querySelectorAll('.parts-text-segment, .interleaved-segment');
		if (partsSegments.length > 0 || (msg.parts && msg.parts.filter(p => p.kind === 'tool').length > 0)) {
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		// 简单模式：streaming-container + 工具卡片分离 → 只更新文本容器
		const streamingContainer = existingEl.querySelector('.streaming-container') as HTMLElement | null;
		if (streamingContainer) {
			// P2+: 增量更新工具卡状态（running → success/error 等），不重建整条消息
			this._updateToolCardStatuses(existingEl, msg);
			// 节流 markdown 渲染：delta 到达时仅更新缓存内容，不立即操作 DOM。
			// 首次渲染之前（_streamingMdLastRendered 为空）用 textContent 显示纯文本。
			if (!this._streamingMdLastRendered) {
				// 首次渲染：立即做完整 markdown 渲染（不等 200ms 计时器）。
				// 旧实现先用 textContent 撑 200ms，期间用户看到 raw text（表格 `|` 语法、
				// CSS/HTML 裸露），表现为「流式错乱」。首屏直接 renderMarkdown 保证从
				// 第一个 delta 起就是格式化好的 markdown。后续 delta 仍走节流。
				this._renderMarkdownContent(streamingContainer, msg.content, true);
				this._streamingMdLastRendered = msg.content;
			}
			this._streamingMdTarget = { container: streamingContainer };
			this._streamingMdLastContent = msg.content;
			if (this._streamingMdTimer === null) {
				this._streamingMdTimer = window.setTimeout(() => {
					this._streamingMdTimer = null;
					const target = this._streamingMdTarget;
					if (!target || !target.container.isConnected || !this._streamingMdLastContent) { return; }
					if (this._streamingMdLastContent === this._streamingMdLastRendered) { return; }
					if (this._tryIncrementalMarkdownRender(target.container, this._streamingMdLastContent)) {
						return;
					}
				// 离屏渲染后原子替换，避免空白帧闪烁
				{
					const tempDiv = document.createElement('div');
					this._renderMarkdownContent(tempDiv, this._streamingMdLastContent, true);
					const children = Array.from(tempDiv.childNodes);
					target.container.replaceChildren(...children);
					}
					this._streamingMdLastRendered = this._streamingMdLastContent;
				}, AgentChatPanelBase.STREAMING_MD_INTERVAL);
			}
			return;
		}

		// 回退：完整重建
		this._rebuildMessageElement(existingEl, msg);
	}

protected override _rebuildMessageElement(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		// Clean up markdown disposables before replacing the old element
		this._cleanupMarkdownDisposables(existingEl);
		const newEl = this._createMessageElement(msg);
		const parent = existingEl.parentNode;
		if (parent) {
			parent.replaceChild(newEl, existingEl);
		}
	}

protected override _updateToolCardStatuses(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		if (!msg.toolCalls || msg.toolCalls.length === 0) { return; }
		const section = existingEl.querySelector('.tool-calls-section');
		if (!section) { return; }

		for (const tc of msg.toolCalls) {
			if (!tc.id) { continue; }
			const oldCard = section.querySelector(`[data-tool-id="${tc.id}"]`) as HTMLElement | null;
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
				const newCard = this._createToolCallCard(tc);
				oldCard.replaceWith(newCard);
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

		// Thinking card (assistant only) — only show when there's actual thinking
		// content. When isThinking is true but no thinking text yet, we show a
		// "正在思考..." indicator at the BOTTOM of the bubble instead.
		if (!isUser && msg.thinking) {
			bubble.appendChild(this._createThinkingCard(msg));
		}

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
			this._renderPartsContent(bubble, msg.parts, !!msg.isStreaming);
			// 有工具卡时标记 bubble，CSS 会隐藏文本内嵌光标（改用底部光标）
			const hasTool = msg.parts.some(p => p.kind === 'tool');
			if (hasTool) { bubble.classList.add('has-tool-cards'); }
		} else if (!isUser && msg.content) {
			// 回退（无 parts，多见于直连模式早期流式）：content 作 Markdown，附加工具卡。
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
			this._appendToolCallsWithPhaseGroups(bubble, msg.toolCalls, msg.streamPhase);
		}

		// Assistant hover actions: 收藏按钮（仅 assistant 消息，内联在 parts/content 后、footer 前）
		if (!isUser && msg.content && this._onFavoriteMessage) {
			this._addMessageActionButtons(bubble, msg);
		}

		// Sub-agent cards (with grouping for parallel execution)
		if (!isUser && msg.subAgents && msg.subAgents.length > 0) {
			const section = append(bubble, $(".subagent-cards-section"));

			// Group sub-agents by groupId (for parallel execution display)
			const groups = new Map<string, ISubAgentData[]>();
			for (const sa of msg.subAgents) {
				const groupKey = sa.groupId || 'default';
				if (!groups.has(groupKey)) {
					groups.set(groupKey, []);
				}
				groups.get(groupKey)!.push(sa);
			}

			// Render grouped sub-agents
			for (const [groupId, agents] of groups) {
				// If multiple groups, add a group label
				if (groups.size > 1) {
					const groupLabel = append(section, $('.subagent-group-label'));
					const groupText = groupId === 'default' ? 'SubAgents' : `批次 ${groupId} (${agents.length} 个任务)`;
					groupLabel.textContent = groupText;
				}

				// Render each sub-agent in this group
				for (const sa of agents) {
					section.appendChild(this._createSubAgentCard(sa));
				}
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

		// "正在思考..." indicator — 位于 bubble 底部（content + toolCalls 之后、streaming-cursor 之前）
		if (!isUser && msg.isStreaming && msg.isThinking && !msg.thinking) {
			bubble.appendChild(this._createThinkingIndicator());
		}

		// Streaming cursor — 策略：
		//   有工具卡/工作流卡时：文本内嵌光标已由 CSS 隐藏，
		//               改用气泡末尾的 span.streaming-cursor 跟在所有内容之后。
		//   无工具卡时：仅在无 `.streaming-container` 时显示（否则 `::after` 已在文本末尾渲染光标）。
		if (!isUser && msg.isStreaming) {
			const hasToolCards = bubble.querySelector('.tool-header-wrapper') !== null;
			const hasWorkflowTrace = bubble.querySelector('.wf-trace') !== null;
			if (hasToolCards || hasWorkflowTrace || !bubble.querySelector('.streaming-container')) {
				append(bubble, $("span.streaming-cursor")).textContent = "|";
			}
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
			importBtn.title = "导入知识库";
			const importSvg = this._svgImportKbIcon();
			importBtn.appendChild(importSvg);
			let inFlight = false;
			this._register(addDisposableListener(importBtn, EventType.CLICK, async (e: Event) => {
				e.stopPropagation();
				if (inFlight) { return; } // 防重入：一次导入未完成时屏蔽重复点击
				inFlight = true;
				importBtn.disabled = true;
				try {
					// 复制内容快照：避免流式/外部修改导致 callback 看到不一致文本
					const snapshot = msg.content ?? '';
					await this._onImportToKnowledgeBase!(snapshot);
					// 视觉反馈：图标换成对号 + 绿色（1.5s 后还原）
					importBtn.removeChild(importSvg);
					const checkSvg = this._svgCheckSmall();
					importBtn.appendChild(checkSvg);
					importBtn.classList.add("chat-msg-import-kb-saved");
					setTimeout(() => {
						importBtn.classList.remove("chat-msg-import-kb-saved");
						try { importBtn.removeChild(checkSvg); } catch { /* already removed */ }
						importBtn.appendChild(importSvg);
					}, 1500);
				} finally {
					importBtn.disabled = false;
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
		if (msg.tokenUsage?.credit !== undefined && msg.tokenUsage.credit > 0) {
			const scoreWrap = append(footer, $("span.chat-bubble-footer-item.chat-footer-pill"));
			// $ 图标（圆形 $）
			append(scoreWrap, $('span.chat-footer-pill-icon.codicon.codicon-credit-card'));
			append(scoreWrap, $('span.chat-footer-pill-label', undefined, '积分'));
			append(scoreWrap, $('span.chat-footer-pill-value', undefined, `: ${msg.tokenUsage.credit.toFixed(2)}`));
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
			// 缓存命中率（带进度条）
			if (hitRate > 0 || cachedRead > 0) {
				const hitRateEl = append(popup, $('div.tokens-popup-hit-rate'));
				append(hitRateEl, $('span.rate-icon.codicon.codicon-flame'));
				append(hitRateEl, $('span.rate-label', undefined, '缓存命中率'));
				append(hitRateEl, $('span.rate-value', undefined, `${hitRate.toFixed(1)}%`));
				// 进度条
				const bar = append(hitRateEl, $('div.tokens-popup-hit-bar'));
				const fill = append(bar, $('div.tokens-popup-hit-bar-fill'));
				fill.style.width = `${Math.max(0, Math.min(100, hitRate))}%`;
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

		// 1. 移除流式光标
		bubble.querySelectorAll('.streaming-cursor').forEach(el => el.remove());

		// 2. 将 streaming-container 的 textContent 替换为完整 markdown 渲染
		const streamingContainer = bubble.querySelector('.streaming-container') as HTMLElement | null;
		if (streamingContainer && msg.content) {
			streamingContainer.classList.remove('streaming-container');
			// 清理旧的 markdown disposable
			this._cleanupMarkdownDisposables(streamingContainer);
			streamingContainer.textContent = '';
			this._renderMarkdownContent(streamingContainer, msg.content, true);
			this._streamingMdLastRendered = msg.content;
		}

		// 3. 追加 footer（如果尚不存在）
		// Agent loop 进行中（_isSending === true）时跳过 footer 渲染，
		// 避免复制/积分/token 消耗信息在中间迭代中刷屏。
		// loop 结束后由 setSending(false) 统一补齐。
		if (!this._isSending && !bubble.querySelector('.chat-bubble-footer')) {
			bubble.appendChild(this._createFooter(msg));
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

		if (this._onCheckpointAction) {
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

		// 4. 收藏按钮 — 收藏到知识库并自动归类
		if (isAssistant && this._onFavoriteMessage && msg.content) {
			const favBtn = append(actions, $("button.chat-msg-action-btn.chat-msg-fav-btn"));
			favBtn.title = "收藏到知识库";
			favBtn.appendChild(this._svgFavoriteIcon());
			this._register(addDisposableListener(favBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onFavoriteMessage?.(msg.content);
				// 视觉反馈：星形变实心 + 短暂高亮
				const svg = favBtn.querySelector('svg');
				if (svg) { svg.setAttribute('fill', 'currentColor'); svg.style.color = 'var(--void-warn, #d4a72c)'; }
				favBtn.classList.add('chat-msg-fav-saved');
				setTimeout(() => {
					favBtn.classList.remove('chat-msg-fav-saved');
					if (svg) { svg.removeAttribute('fill'); svg.style.color = ''; }
				}, 1500);
			}));
		}
	}

protected override _openUndoConfirmDialog(): void {
		// 防止重复弹出
		if (this._container.querySelector('.checkpoint-undo-dialog-overlay')) { return; }
		const cp = this._checkpoint;
		if (!cp) { this._onCheckpointAction?.('undoAll'); return; }

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
		const modeLabel = this._chatMode === 'craft' ? 'Craft' : this._chatMode === 'ask' ? 'Ask' : this._chatMode === 'plan' ? 'Plan' : this._chatMode;
		desc.textContent = `回退将会恢复 ${modeLabel} 操作变更过的 ${cp.fileCount} 个文件`;

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
			// 变更统计（模拟 +N -M）
			const stats = append(fileRow, $('span.checkpoint-file-stats'));
			// 根据 status 和 path 生成模拟统计
			const added = f.status === 'created' ? Math.floor(Math.random() * 30) + 10 : Math.floor(Math.random() * 50) + 5;
			const removed = f.status === 'deleted' ? Math.floor(Math.random() * 20) + 5 : Math.floor(Math.random() * 15);
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
		const modeOpt = MODE_OPTIONS.find(m => m.id === this._chatMode) || MODE_OPTIONS[0];
		const modeBtn = this._appendEditToolbarBtn(leftTools, { title: '切换模式', svgPath: modeOpt.icon, hasLabel: true, label: modeOpt.label, showChevron: true, cssClass: 'mode-tag' });
		this._register(addDisposableListener(modeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._modeDropdownEl) {
				this._closeModeDropdown();
			} else {
				this._openModeDropdown(modeBtn);
			}
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
}
