/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 流式 markdown 渲染调度器：统一持有「节流定时器 + 目标容器 + 最新内容 + 已渲染基线」
 * 四元组，替代此前散落在 _updateMessageDom（FastPath1）与
 * _updateStreamingContentInPlace 中两处近乎逐字重复的节流块。
 *
 * 行为契约（与此前两条手写路径一致）：
 * - schedule() 幂等：timer 存活期间重复调用只更新缓存内容，不叠加定时器；
 * - 首次渲染策略：'text' 立即 textContent 纯文本占位（FastPath1），
 *   'markdown' 立即完整渲染（InPlace 路径）；
 * - flush 时优先增量渲染（块边界冻结法），失败则离屏全量渲染后原子替换，
 *   避免 textContent='' 导致的空白帧闪烁；
 * - 增量成功后同步 lastRendered 基线（与原 markdown 层
 *   `this._streamingMdLastRendered = newContent` 的全局同步等效），
 *   避免下个 tick 对相同内容重复调 renderIncremental；
 * - 全量替换前统一调用 resetIncremental（原 FastPath1 遗漏此项，
 *   InPlace 路径有，此处统一为总是重置，避免 WeakMap 残留错位状态）。
 */
export interface IStreamingRenderHooks {
	/** 完整 markdown 渲染（流式语义，等价于面板 _renderMarkdownContent(c, t, true)）。 */
	renderFull(container: HTMLElement, text: string): void;
	/** 增量渲染；返回 false 表示无法增量（块结构失配），调用方应回退全量。 */
	renderIncremental(container: HTMLElement, text: string): boolean;
	/** 重置容器对应的增量渲染状态（全量替换前调用）。 */
	resetIncremental(container: HTMLElement): void;
	/**
	 * 可选：增量渲染失败、即将做全量替换时通知调用方（2026-08-22 加入）。
	 *
	 * 这条路径是「markdown 内容整段闪烁」的直接原因 —— `replaceChildren` 会丢弃并
	 * 重建整个 markdown 子树。此前它**完全没有日志**，抖动排查时只能靠推演。
	 * 通过 hook 上报而非在此处直接打日志，是为了让 scheduler 保持与日志设施解耦
	 * （它不持有 msgId 等上下文，调用方才有）。
	 *
	 * @param charCount 本次全量渲染的内容长度，用于估算重建成本。
	 */
	onFullReplace?(container: HTMLElement, charCount: number): void;
}

export class StreamingRenderScheduler {
	private _timer: number | null = null;
	/**
	 * 待渲染目标：container → 最新文本。
	 *
	 * ★ 2026-08-31：由「单 target」改为**多 target 并存**。原设计只有一份
	 * `_target/_lastContent/_lastRendered`，而 `_reconcileParts` 每帧会对**每个**
	 * 发生变化的 text part 各调一次 `schedule()`。同一帧内多次调用只有最后一个
	 * 存活，前面全部被覆盖、永不渲染 —— 这正是「消息在某个 text part 处截断」
	 * 的直接来源（多 text 段的 agent loop 消息必现）。
	 */
	private readonly _targets = new Map<HTMLElement, string>();
	/**
	 * 各容器**各自独立**的已渲染基线。
	 *
	 * 原来是跨容器共享的一个字符串：target 切换时基线会错位，`renderIncremental`
	 * 拿着别的容器的基线做增量 → 失败 → 回退 `replaceChildren` 全量替换整段 DOM，
	 * 正是可见的「抖动/闪烁」。改为按容器独立后该问题一并消除。
	 */
	private _lastRendered = new WeakMap<HTMLElement, string>();

	constructor(
		private readonly _hooks: IStreamingRenderHooks,
		private readonly _intervalMs: number,
		/** 可选：每次实际渲染完成后回调（如 thinking 卡片 body 滚动吸底）。 */
		private readonly _afterRender?: (container: HTMLElement) => void,
	) { }

	/**
	 * 调度一次流式渲染。delta 到达时调用：仅更新缓存内容，实际 DOM 操作
	 * 由 interval 后的 flush 执行（markdown 节流）。
	 * @param firstRender 首次渲染策略：'text' 纯文本占位 | 'markdown' 立即完整渲染
	 */
	schedule(container: HTMLElement, text: string, firstRender: 'text' | 'markdown'): void {
		if (!this._lastRendered.has(container)) {
			if (firstRender === 'text') {
				// 让用户立即看到输出；首次 markdown 渲染后不再覆盖，由增量更新追加
				container.textContent = text;
			} else {
				this._hooks.renderFull(container, text);
				this._lastRendered.set(container, text);
				this._afterRender?.(container);
			}
		}
		this._targets.set(container, text);
		if (this._timer === null) {
			this._timer = window.setTimeout(() => this._flush(), this._intervalMs);
		}
	}

	/**
	 * 外部已完成全量渲染（如 _transitionStreamingToComplete 的流式结束转换），
	 * 同步该容器的基线，使 pending 的 flush 因内容相等而跳过（复刻原
	 * `this._streamingMdLastRendered = msg.content` 语义）。
	 *
	 * 改为多 target 后必须带容器——否则无法知道同步的是哪一个的基线。
	 */
	markRendered(container: HTMLElement, text: string): void {
		this._lastRendered.set(container, text);
		this._targets.delete(container);
	}

	/** 取消 pending 的节流渲染（保留各容器已渲染基线）。 */
	cancel(): void {
		if (this._timer !== null) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		this._targets.clear();
	}

	/** 完整复位：cancel + 清空已渲染基线（新流式会话 / 流式结束 / dispose 前）。 */
	reset(): void {
		this.cancel();
		// WeakMap 无 clear()，只能重建（旧的随容器 GC 一起回收）
		this._lastRendered = new WeakMap<HTMLElement, string>();
	}

	private _flush(): void {
		this._timer = null;
		// 先摘出待渲染集合再遍历：渲染回调里可能再次 schedule（_afterRender 触发吸底等）
		const pending = Array.from(this._targets.entries());
		this._targets.clear();
		for (const [container, text] of pending) {
			if (!container.isConnected || !text) { continue; }
			// 内容未变 → 跳过渲染
			if (this._lastRendered.get(container) === text) { continue; }
			// 尝试增量更新——只渲染追加部分，避免全量 re-parse
			if (this._hooks.renderIncremental(container, text)) {
				this._lastRendered.set(container, text);
				this._afterRender?.(container);
				continue;
			}
			// 全量重建 — 离屏渲染后原子替换，避免空白帧闪烁
			// 上报给调用方记录（见 IStreamingRenderHooks.onFullReplace）：这是抖动的
			// 直接来源之一，必须可观测。
			this._hooks.onFullReplace?.(container, text.length);
			this._hooks.resetIncremental(container);
			const tempDiv = document.createElement('div');
			this._hooks.renderFull(tempDiv, text);
			container.replaceChildren(...Array.from(tempDiv.childNodes));
			this._lastRendered.set(container, text);
			this._afterRender?.(container);
		}
	}
}
