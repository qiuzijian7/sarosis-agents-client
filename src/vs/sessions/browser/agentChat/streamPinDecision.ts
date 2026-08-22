/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 卡内滚动容器「流式钉底」的纯决策逻辑（零 DOM 依赖，可独立单测）。
 *
 * ## 为什么要把决策从 DOM 操作里抽出来
 *
 * 事故（2026-08-21，日志 1787323320262，用户报「后期 LLM 输出时聊天框抖动严重」）：
 * `_pinAllScrollableBodiesToBottom` 在 `_reconcileParts` 末尾**每帧**执行，实现是
 *
 *   for (el of scrollables) {
 *       if (el.scrollHeight <= el.clientHeight) continue;   // 读
 *       _pinStreamCardToBottom(el);                          // 读 + 写 scrollTop
 *   }
 *
 * 「读 → 写 → 读 → 写」交错是典型的 **layout thrashing**：写 `scrollTop` 使布局失效，
 * 下一个元素读 `scrollHeight` 就强制同步重排（forced reflow）。元素数 = 工具卡数，
 * 该日志里单条消息从 2 涨到 **137 个 part / 81 个工具卡** → 每帧约 81 次强制重排，
 * 60fps 下近 5000 次/秒。**开销随消息增长线性上升，正好表现为「后期越来越抖」。**
 *
 * 同一个坑在外层滚动容器上已经修过（`scrollbarController.startStreamScroll` 用
 * MutationObserver 置脏，注释明确写了「读 scrollHeight …会触发强制重排」），但卡内
 * 批量钉底这条路径当时漏了。
 *
 * ## 修法
 * 1. **读写分相**：先一次性读完所有度量，再统一写 —— N 次强制重排降为 1 次。
 * 2. **未增长即跳过**：缓存上次见到的 `scrollHeight`，没变说明内容没长，本帧连写都
 *    不需要（等价于外层的「干净帧跳过」）。
 *
 * 本模块只放**决策**（给定度量与状态，算出该不该写、写多少），DOM 读写留在面板层。
 * 这样阈值语义可被单测钉住，避免后续重构时悄悄改变钉底行为。
 */

/** 滚动容器的三项度量（调用方在「只读相」一次性采集）。 */
export interface IScrollMetrics {
	readonly scrollHeight: number;
	readonly clientHeight: number;
	readonly scrollTop: number;
}

/** 钉底状态（面板层 WeakMap 中保存的可变状态的只读视图）。 */
export interface IPinState {
	/** 是否处于「跟随底部」态；用户上滚会置 false。 */
	readonly pinned: boolean;
	/** 用户最后一次的滚动位置（用于全量替换归零后恢复）。 */
	readonly lastUserTop: number;
	/** 用户最近一次向上滚动的时间戳（宽限期内不强制置底）。 */
	readonly lastUserScrollAt: number;
}

/** 视为「已贴底」的容差（px）。 */
export const PIN_BOTTOM_EPSILON = 8;

/** 用户上滚后的宽限期（ms）：期间不强制置底，把滚动位置交还用户。 */
export const PIN_USER_SCROLL_GRACE_MS = 200;

/** 判定「scrollTop 被 replaceChildren 物理归零」的跳变阈值（px），区别于正常拖拽增量。 */
export const PIN_RESTORE_JUMP_THRESHOLD = 50;

/**
 * 计算本帧应写入的 `scrollTop`。
 *
 * @returns 目标 scrollTop；`undefined` 表示**本帧不应写** —— 这个返回值是本次修复的
 * 关键：不写就不会使布局失效，后续元素的度量读取也就不会触发强制重排。
 */
export function decidePinScrollTop(
	m: IScrollMetrics,
	state: IPinState,
	now: number,
): number | undefined {
	if (state.pinned) {
		// 用户正在拖拽（近期上滚过）→ 暂缓强制置底
		if (now - state.lastUserScrollAt < PIN_USER_SCROLL_GRACE_MS) { return undefined; }
		// 已经贴底 → 无需再写（原实现同样有此判据，这里保留语义）
		const distFromBottom = m.scrollHeight - m.scrollTop - m.clientHeight;
		if (distFromBottom <= PIN_BOTTOM_EPSILON) { return undefined; }
		return m.scrollHeight;
	}
	// 非 pinned：仅在「大幅跳变」（全量替换导致归零）时恢复用户位置
	if (m.scrollTop < state.lastUserTop - PIN_RESTORE_JUMP_THRESHOLD) { return state.lastUserTop; }
	return undefined;
}

/**
 * 批量钉底时判断某元素**是否需要进入本帧处理**。
 *
 * @param lastSeenScrollHeight 上一帧记录的 scrollHeight（首次为 undefined）
 */
export function needsPinPass(
	m: Pick<IScrollMetrics, 'scrollHeight' | 'clientHeight'>,
	lastSeenScrollHeight: number | undefined,
): boolean {
	// 内容未溢出 → 不可滚动，无需钉底
	if (m.scrollHeight <= m.clientHeight) { return false; }
	// 内容高度未变化 → 本帧没有新增内容，跳过（干净帧零写入）
	if (lastSeenScrollHeight === m.scrollHeight) { return false; }
	return true;
}
