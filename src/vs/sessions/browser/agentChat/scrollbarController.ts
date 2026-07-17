import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { addDisposableListener, EventType } from '../../../base/browser/dom.js';
import type { IAgentChatMessage } from './agentChatTypes.js';

/**
 * Explicit contract the ScrollbarController needs from the owning chat panel.
 *
 * This is the crux of the composition refactor: in the old inheritance design the
 * scrollbar feature reached into shared panel state via implicit `this._*`
 * (every base member was promoted to `protected`). Here the dependency is made
 * explicit — the controller only ever touches shared state through these
 * accessors, and owns its own private state (RAF handles, marker disposables).
 */
export interface IScrollbarHost {
	// Shared read-only state (owned by the panel / other features)
	readonly isSending: boolean;
	readonly isDraggingScrollbar: boolean;
	readonly streamJustEnded: boolean;
	readonly unreadCount: number;
	readonly messages: readonly IAgentChatMessage[];
	readonly messagesContainer: HTMLElement | undefined;
	readonly customScrollbar: HTMLElement | null;
	readonly scrollbarThumb: HTMLElement | null;
	readonly scrollbarTrack: HTMLElement | null;
	readonly scrollbarPopup: HTMLElement | null;
	readonly scrollbarPopupPreview: HTMLElement | null;
	readonly scrollToBottomBtn: HTMLElement | null;
	readonly scrollBadge: HTMLElement | null;
	readonly onScrollToMessage?: (messageId: string) => void;
	// Shared read-write state (also written by messages / dropdowns / base)
	isAtBottom: boolean;
	showScrollBtn: boolean;
	wasLoading: boolean;
	// Panel method the controller delegates to (defined in the dropdowns feature)
	scrollToMessage(messageId: string): void;
}

/**
 * Scrollbar behavior, extracted from the AgentChatPanel inheritance chain into a
 * composed controller.
 *
 * Owns its private state and reads/writes shared panel state exclusively through
 * {@link IScrollbarHost}. No `override`, no `protected` promotion, no chain edit
 * is required to add or remove this behavior — the panel simply composes it.
 */
export class ScrollbarController extends Disposable {
	// ── Private state owned by this controller ──
	private _streamScrollRaf: number | null = null;
	private _pendingScrollToBottom = false;
	private _pendingScrollToBottomRaf: number | null = null;
	private _scrollbarUpdateRaf: number | null = null;
	private readonly _markerDisposables = this._register(new DisposableStore());

	constructor(private readonly _host: IScrollbarHost) {
		super();
	}

	override dispose(): void {
		if (this._streamScrollRaf !== null) { cancelAnimationFrame(this._streamScrollRaf); this._streamScrollRaf = null; }
		if (this._scrollbarUpdateRaf !== null) { cancelAnimationFrame(this._scrollbarUpdateRaf); this._scrollbarUpdateRaf = null; }
		if (this._pendingScrollToBottomRaf !== null) { cancelAnimationFrame(this._pendingScrollToBottomRaf); this._pendingScrollToBottomRaf = null; }
		super.dispose();
	}

	startStreamScroll(): void {
		if (this._streamScrollRaf !== null) { return; }
		const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
		console.debug(`[ScrollDiag] _startStreamScroll START caller: ${diagStack}`);
		const tick = () => {
			this._streamScrollRaf = null;
			// 流式结束 → 停止循环（唯一合法的停止条件）
			if (!this._host.isSending || !this._host.messagesContainer) {
				return;
			}
			// 用户滚离底部 → 跳过钉底但保持循环存活，等待 isAtBottom 恢复
			// 用户正在拖拽滚动条 → 暂停钉底，避免互相冲突
			if (this._host.isAtBottom && !this._host.isDraggingScrollbar) {
				this._host.messagesContainer.scrollTop = this._host.messagesContainer.scrollHeight;
			}
			this._streamScrollRaf = requestAnimationFrame(tick);
		};
		this._streamScrollRaf = requestAnimationFrame(tick);
	}

	stopStreamScroll(): void {
		if (this._streamScrollRaf !== null) {
			cancelAnimationFrame(this._streamScrollRaf);
			this._streamScrollRaf = null;
			const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
			console.debug(`[ScrollDiag] _stopStreamScroll STOP caller: ${diagStack}`);
		}
	}

	scheduleScrollToBottom(): void {
		// 流式期间 _startStreamScroll rAF 循环持续钉底，不需要额外调度
		if (this._host.isSending) { return; }

		this._pendingScrollToBottom = true;
		if (this._pendingScrollToBottomRaf === null) {
			this._pendingScrollToBottomRaf = requestAnimationFrame(() => {
				this._pendingScrollToBottomRaf = null;
				if (this._pendingScrollToBottom) {
					this._pendingScrollToBottom = false;
					this.scrollToBottom(false);
				}
			});
		}
	}

	scheduleScrollbarUpdate(): void {
		if (this._scrollbarUpdateRaf !== null) { return; }
		this._scrollbarUpdateRaf = requestAnimationFrame(() => {
			this._scrollbarUpdateRaf = null;
			this.updateScrollbarThumb();
		});
	}

	updateScrollbarThumb(): void {
		const el = this._host.messagesContainer;
		const custom = this._host.customScrollbar;
		const thumb = this._host.scrollbarThumb;
		const track = this._host.scrollbarTrack;
		if (!el || !custom || !thumb || !track) { return; }
		const ratio = el.clientHeight / el.scrollHeight;
		if (ratio >= 1) {
			// Content fits — hide scrollbar
			custom.style.display = 'none';
			return;
		}
		custom.style.display = '';
		const trackHeight = track.offsetHeight;
		const thumbHeight = Math.max(24, trackHeight * ratio);
		const maxScroll = el.scrollHeight - el.clientHeight;
		const scrollRatio = maxScroll > 0 ? el.scrollTop / maxScroll : 0;
		const thumbTop = scrollRatio * (trackHeight - thumbHeight);
		thumb.style.height = `${thumbHeight}px`;
		thumb.style.top = `${thumbTop}px`;
	}

	refreshScrollMarkers(): void {
		const custom = this._host.customScrollbar;
		const el = this._host.messagesContainer;
		const track = this._host.scrollbarTrack;
		if (!custom || !el || !track) { return; }
		// 移除旧标记 + 释放旧事件监听器
		this._markerDisposables.clear();
		const oldMarkers = custom.querySelectorAll('.chat-scroll-marker');
		oldMarkers.forEach(m => m.remove());

		const trackHeight = track.offsetHeight;
		if (trackHeight <= 0 || el.scrollHeight <= 0) { return; }

		for (const msg of this._host.messages) {
			if (msg.role !== 'user') { continue; }
			const msgEl = el.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null;
			if (!msgEl) { continue; }

			const msgRatio = msgEl.offsetTop / el.scrollHeight;
			const markerTop = msgRatio * trackHeight;

			const marker = document.createElement('div');
			marker.className = 'chat-scroll-marker';
			marker.style.top = `${markerTop}px`;

			// Hover → popup
			this._markerDisposables.add(
				addDisposableListener(marker, EventType.MOUSE_ENTER, () => {
					const popup = this._host.scrollbarPopup;
					const preview = this._host.scrollbarPopupPreview;
					if (!popup || !preview || !track) { return; }
					const text = msg.content.length > 100 ? msg.content.substring(0, 100) + '…' : msg.content;
					preview.textContent = text;
					const popupTop = Math.min(markerTop, track.offsetHeight - 80);
					popup.style.top = `${popupTop}px`;
					popup.classList.add('visible');
				}),
			);
			this._markerDisposables.add(
				addDisposableListener(marker, EventType.MOUSE_LEAVE, () => {
					this._host.scrollbarPopup?.classList.remove('visible');
				}),
			);

			// Click → jump to message
			this._markerDisposables.add(
				addDisposableListener(marker, EventType.CLICK, (e: MouseEvent) => {
					e.stopPropagation();
					this._host.scrollToMessage(msg.id);
				}),
			);

			custom.appendChild(marker);
		}

		// Also update thumb (content may have changed scrollHeight)
		this.updateScrollbarThumb();
	}

	updateScrollBadge(): void {
		const badge = this._host.scrollBadge;
		if (!badge) { return; }
		const unread = this._host.unreadCount;
		if (unread > 0) {
			badge.textContent = String(unread > 99 ? '99+' : unread);
			badge.style.display = 'flex';
		} else {
			badge.style.display = 'none';
		}
	}

	pulseScrollBtn(): void {
		const btn = this._host.scrollToBottomBtn;
		if (!btn) { return; }
		btn.classList.remove('pulse');
		// 强制 reflow 重启动画
		void btn.offsetWidth;
		btn.classList.add('pulse');
	}

	scrollToBottom(force: boolean): void {
		const el = this._host.messagesContainer;
		if (!el) { return; }
		// ── SCROLL DIAG: 记录每次滚动的调用栈 ──
		const diagStack = new Error().stack?.split('\n').slice(2, 6).map(s => s.trim()).join(' ← ') || '?';
		const prevTop = el.scrollTop;
		const prevHeight = el.scrollHeight;
		const wasAtBtm = (prevHeight - prevTop - el.clientHeight) < 80;

		const instant = force || this._host.wasLoading;

		if (instant) {
			// 加载历史 / 切 Agent → 即时跳转，恢复自动跟随
			this._host.isAtBottom = true;
			this._host.wasLoading = false;
			this._host.showScrollBtn = false;
			const btn = this._host.scrollToBottomBtn;
			if (btn) { btn.style.display = "none"; }
			el.scrollTop = el.scrollHeight;
			return;
		}

		// 用户不在底部 → 不自动滚动
		if (!this._host.isAtBottom) { return; }

		// During streaming, always use instant scroll to stay pinned to bottom.
		// Smooth scroll can't keep up with continuous content growth — it falls
		// behind, creating a growing gap that eventually triggers the 80px
		// threshold check, causing jumpy behavior.
		if (this._host.isSending) {
			el.scrollTop = el.scrollHeight;
			return;
		}

		// Non-streaming: check if user scrolled away from bottom
		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		// 流式刚结束时，slow-path 重建（footer/token popup）增加的高度可能
		// 超过 80px 阈值，误判为"用户滚离"。宽限期内绕过此检查。
		if (distFromBottom >= 80 && !this._host.streamJustEnded) {
			// User likely scrolled up → disable auto-scroll
			this._host.isAtBottom = false;
			this._host.showScrollBtn = true;
			const btn = this._host.scrollToBottomBtn;
			if (btn) { btn.style.display = "flex"; }
			return;
		}

		// 正常情况 → smooth 滚动（宽限期内用 instant 追赶高度变化）
		if (this._host.streamJustEnded) {
			el.scrollTop = el.scrollHeight;
		} else {
			el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
		}

		// ── SCROLL DIAG: 记录滚动效果 ──
		if (el) {
			const delta = el.scrollTop - prevTop;
			const hDelta = el.scrollHeight - prevHeight;
			if (Math.abs(delta) > 5 || hDelta !== 0) {
				console.debug(`[ScrollDiag] _scrollToBottom force=${force} instant=${instant} prevScroll=${prevTop}→${el.scrollTop} (Δ${delta}) scrollH=${prevHeight}→${el.scrollHeight} (Δ${hDelta}) wasAtBtm=${wasAtBtm} isSending=${this._host.isSending} isAtBtm=${this._host.isAtBottom}\n  caller: ${diagStack}`);
			}
		}
	}
}
