/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★★ 2026-09-24（P1 分帧渲染）：消息列表的「**时间片渲染器**」—— 纯驱动器，零 DOM 依赖 ✓
 *
 * 背景（真机证据）：
 *   `_renderMessages` 曾一次性**同步**渲染最近 30 条消息；一条百级 parts 的重消息 ≈58ms
 *   （真机埋点 `render.createMessageElement=58.3ms parts=127 tools=69` ✓）⇒ 恢复大会话时
 *   主线程被独占 >1s（[RenderHeartbeat] LONG_TASK worst=1256ms @ uptime=26s ✓ 2026-09-24）。
 *
 * 做法（经典 time-slicing）：
 *   每个时间片内逐条渲染；**片内 JS 超过预算**才把剩余部分交 `schedule`（生产 = rAF）
 *   到下一帧续渲 ⇒ 单帧最长 ≈ 一条重消息（≪ 500ms 的 LONG_TASK 告警阈值 ✓）。
 *
 * 设计不变量（全部为正确性服务，改前先读懂 ✗✓）：
 *   ① **首片同步**：预算内能渲完 ⇒ 返回时已全部完成（`completedSynchronously=true`）——
 *      小列表行为与旧「全同步版」**逐字节一致**（既有测试/调用方零感知 ✓）；
 *   ② **每片至少渲 1 条** ⇒ 单条超预算也只占一帧，且保证必前进（绝不死循环 ✓）；
 *   ③ `items` 是**活数组 getter**（不许传快照 ✗）—— 分片期间的流式新消息被自然捎带、
 *      顺序不乱 ✓（`_updateMessageDom` 对未渲染元素安全跳过，轮到它时用最新数据 ✓）；
 *   ④ `isCancelled()` 代次检查：新一轮渲染/面板销毁 ⇒ 旧链**静默退出**（不抛错 ✓）；
 *   ⑤ `now` / `schedule` 可注入 ⇒ 测试用假时钟 + 手动泵，完全确定 ✓（jsdom 时序不参与断言 ✓）。
 */

/** 单片 JS 预算（ms）：60fps 一帧 16.6ms，留约一半给布局/绘制/合成 ⇒ 8ms。 */
export const RENDER_SLICE_BUDGET_MS = 8;

export interface IRenderSliceInfo {
	/** 第几片（1 起）。 */
	readonly slice: number;
	/** 渲染游标（已渲染条数 = cursor - cursor0）。 */
	readonly cursor: number;
	/** 当前总条数（活数组 ⇒ 分片期间可能增长 ✓）。 */
	readonly total: number;
	/** 本片 JS 耗时（由注入时钟测得 ✓）。 */
	readonly elapsedMs: number;
}

export interface ITimeSlicedRenderOptions<T> {
	/** 活数组 getter（**不要传快照** ✗ —— 快照会让分片期间的流式新消息丢失/乱序 ✓）。 */
	readonly items: () => readonly T[];
	/** 起始游标（懒加载场景 = firstBatchStart ✓）。 */
	readonly cursor0: number;
	/** 单片预算（ms）；传 `Infinity` ⇒ 全同步（逃生门 / 隐藏标签页 ✓）。 */
	readonly budgetMs: number;
	/** 渲染一条（index 为活数组下标 ✓）。 */
	readonly renderItem: (item: T, index: number) => void;
	/** 取消判据（代次失效 / 容器销毁 ⇒ true ⇒ 静默退出 ✓）。 */
	readonly isCancelled: () => boolean;
	/** 续片调度器（生产 = rAF；测试 = 手动泵 ✓）。 */
	readonly schedule: (cb: () => void) => void;
	/** 每片结束后回调（打点 ✓）。 */
	readonly onSlice?: (info: IRenderSliceInfo) => void;
	/** 中间片结束、且尚未渲完时回调（钉底 ✓ —— 最后一片不回调，由 onDone 统一收尾 ✓）。 */
	readonly onPin?: () => void;
	/** 全部渲完恰好调用一次 ✓（被取消 ⇒ 不调用 ✓）。 */
	readonly onDone: () => void;
	/** 时钟注入（默认 `performance.now` ✓ 测试传假时钟 ⇒ 确定性 ✓）。 */
	readonly now?: () => number;
}

export interface ITimeSlicedRenderResult {
	/** true ⇒ 首片内渲完（行为同旧全同步版 ✓）。 */
	readonly completedSynchronously: boolean;
	/** 实际执行的片数（被取消时 < 应渲片数 ✓）。 */
	readonly slices: number;
}

export function runTimeSlicedRender<T>(opts: ITimeSlicedRenderOptions<T>): ITimeSlicedRenderResult {
	const now = opts.now ?? (() => performance.now());
	let cursor = opts.cursor0;
	let slice = 0;
	const runSlice = (): void => {
		// ④ 代次失效 ⇒ 旧链静默退出 ✓
		if (opts.isCancelled()) { return; }
		slice++;
		const t0 = now();
		// ② do…while ⇒ 每片至少渲 1 条：单条 58ms 的巨型消息也只占一帧 ✓ 且保证必前进 ✓
		do {
			const items = opts.items();
			if (cursor >= items.length) { break; }
			opts.renderItem(items[cursor], cursor);
			cursor++;
		} while (cursor < opts.items().length && now() - t0 < opts.budgetMs);
		const total = opts.items().length;
		opts.onSlice?.({ slice, cursor, total, elapsedMs: now() - t0 });
		if (cursor >= total) {
			opts.onDone();
			return;
		}
		opts.onPin?.();
		opts.schedule(runSlice);
	};
	runSlice();
	return { completedSynchronously: cursor >= opts.items().length, slices: slice };
}

/**
 * 是否**放弃分片、全同步**渲染（三条独立理由，任一命中即全同步 ✓）：
 *  · `forceSync`      —— 逃生门（`__SAROSIS_SYNC_RENDER_MESSAGES=true` ✓）；
 *  · `documentHidden` —— 隐藏标签页 rAF 被节流 ⇒ 分片会长期滞留「半渲染态」✗；
 *  · `!canSchedule`   —— 无 rAF 的环境（旧测试桩 ✗ 防御 ✓）。
 */
export function shouldRenderFullySync(opts: {
	readonly forceSync?: boolean;
	readonly documentHidden?: boolean;
	readonly canSchedule: boolean;
}): boolean {
	return opts.forceSync === true || opts.documentHidden === true || !opts.canSchedule;
}

// ─── 恢复窗口（2026-09-24 用户要求 ✓）─────────────────────────────────────────

/**
 * ★★★ 恢复时只渲染**最近 N 轮问答**（用户提问 + LLM 回答）✓ —— 取代旧的「最近 30 条」✗。
 * 背景：大会话（真机 1000+ 条 ✓）恢复时 30 条重消息（单条 ≈58ms ✓）⇒ 首屏 >1s 卡顿 ✗✓。
 * 更早的内容由既有懒加载兜底（向上滚动 ⇒ IntersectionObserver 按 20 条/块加载 ✓）。
 */
export const RESTORE_USER_TURN_WINDOW = 2;

/**
 * 计算恢复窗口起点：**倒数第 `userTurns` 条用户提问**的下标（含它在内的尾部全部渲染 ✓）。
 * 不足 `userTurns` 条提问 ⇒ 返回 0（全渲染 ✓ 新/短会话 ✓）。
 * 纯函数 ✓ 零 DOM ✓（`isUser` 谓词注入 ⇒ 与消息类型解耦 ✓）。
 */
export function computeRestoreWindowStart<T>(
	items: readonly T[],
	isUser: (item: T) => boolean,
	userTurns: number,
): number {
	let seen = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		if (isUser(items[i])) {
			seen++;
			if (seen >= userTurns) { return i; }
		}
	}
	return 0;
}
