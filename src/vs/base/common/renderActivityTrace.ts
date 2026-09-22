/*---------------------------------------------------------------------------------------------
 *  renderActivityTrace.ts — **渲染活动标记环**（为 LONG_TASK / SLOW 提供「当时在干什么」的归因）
 *
 * ## 为什么（2026-09-20）
 * `[RenderHeartbeat] LONG_TASK` 能报出「主线程被独占 738ms @ts=…」，但**报不出是谁占的**——
 * 真机日志只有时长与开始时刻，排查只能靠猜（P2 UI 长任务治理因此卡在「无归因」）。
 * 本模块补这一格：热点路径打一个**常数标记**（零分配），心跳在长任务结束时按时间窗取标记，
 * 日志直接写成 `因=[umd×12, delta:text×40]`。
 *
 * ## 设计约束（都是硬约束，别改）
 *   · **零分配**：环形缓冲用两条**预分配数组**（tag / ts）+ 游标，标记时只写数组槽 ——
 *     热点路径（每帧、每 delta）绝不能 new 对象/字符串拼接（GC 抖动会加剧长任务）。
 *     ⇒ 调用方必须传**常量字符串**（`markRenderActivity('umd')`），不要拼 msgId。
 *   · **无依赖**：只用 `Date.now()`（node 下可跑；不碰 DOM / performance）—— base 层可被任意层引用。
 *   · **失败静默**：标记是纯诊断，任何异常都吞（绝不因诊断伤主流程）。
 *   · 关闭开关：`globalThis.__SAROSIS_ACTIVITY_TRACE === false` ⇒ 标记变 no-op（保底逃生门）。
 *
 * ## 判读
 *   · `LONG_TASK … 因=[umd×12]` ⇒ 这段时间在重建消息 DOM（面板侧）；
 *   · `因=[delta:text×40]` ⇒ 在消费流式文本 delta（pane 侧）；
 *   · `因=[umd×3, md×8]` ⇒ 混合；按计数排序即主要占用者。
 *   注意：标记只覆盖**主动打点**的位置；`因=[]` 说明长任务发生在未打点代码里（补点，别猜）。
 *--------------------------------------------------------------------------------------------*/

/** 环形容量（够覆盖一个长任务窗口；32 项 × 2 数组 ≈ 极小常量内存）。 */
const CAPACITY = 32;

const tags: string[] = new Array<string>(CAPACITY).fill('');
const stamps: number[] = new Array<number>(CAPACITY).fill(0);
/** 下一写入槽（环形游标）。 */
let cursor = 0;
/** 已写入总数（用于判定是否绕回）。 */
let written = 0;

export interface IRenderActivityMark {
	readonly tag: string;
	readonly ts: number;
}

/** 打一个活动标记。⚠ tag 必须是常量字符串（避免热点分配）。 */
export function markRenderActivity(tag: string): void {
	try {
		if ((globalThis as { __SAROSIS_ACTIVITY_TRACE?: boolean }).__SAROSIS_ACTIVITY_TRACE === false) { return; }
		tags[cursor] = tag;
		stamps[cursor] = Date.now();
		cursor = (cursor + 1) % CAPACITY;
		written++;
	} catch { /* 纯诊断：静默 */ }
}

/**
 * 取时间窗 `[startMs, endMs]` 内的标记（按 tag 聚合计数，计数降序）。
 * 同时给出「窗口开始前最近一个标记」（长任务常始于某个标记之后的同步代码）。
 */
export function collectRenderActivity(startMs: number, endMs: number): { inWindow: Array<{ tag: string; count: number }>; before?: IRenderActivityMark } {
	try {
		const counts = new Map<string, number>();
		let before: IRenderActivityMark | undefined;
		const n = Math.min(written, CAPACITY);
		for (let i = 0; i < n; i++) {
			// 从最旧到最新遍历（绕回后 cursor 指向最旧）
			const idx = written <= CAPACITY ? i : (cursor + i) % CAPACITY;
			const tag = tags[idx]!;
			const ts = stamps[idx]!;
			if (!tag) { continue; }
			if (ts >= startMs && ts <= endMs) {
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			} else if (ts < startMs) {
				if (!before || ts > before.ts) { before = { tag, ts }; }
			}
		}
		const inWindow = [...counts.entries()]
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count);
		return { inWindow, before };
	} catch {
		return { inWindow: [] };
	}
}

/** 供日志直接拼接的短形状（如 `umd×12, delta:text×40`）。 */
export function formatRenderActivityWindow(startMs: number, endMs: number, maxItems = 4): string {
	const { inWindow, before } = collectRenderActivity(startMs, endMs);
	if (inWindow.length === 0) {
		// ★ 2026-09-22：无标记 ≠ 无线索 —— 业务侧的细粒度 perf 计时（如 chatPerf 的 span 环）
		// 可能覆盖了这个窗口。注册了兜底源就拼上（如 `perf=[card.create.tool×3/612ms]`）。
		let extra = '';
		for (const src of _fallbackSources) {
			try {
				const s = src(startMs, endMs);
				if (s) { extra += (extra ? ' ' : '') + s; }
			} catch { /* 纯诊断：静默 */ }
		}
		const base = before ? `(窗口内无标记; 之前最近=${before.tag}@${before.ts})` : '(无标记)';
		return extra ? `${base} ${extra}` : base;
	}
	const head = inWindow.slice(0, maxItems).map(e => `${e.tag}×${e.count}`).join(', ');
	return inWindow.length > maxItems ? `${head}, …(共${inWindow.length}类)` : head;
}

// ─── 兜底归因源（2026-09-22，LONG_TASK「窗口内无标记」的归因补网）──────────────
// 背景：`因=[(窗口内无标记; 之前最近=scrollbar-markers@…)]` 意味着长任务发生在
// **没打活动标记**的代码里 —— 而业务侧往往另有细粒度 perf 计时（chatPerf.span 等）。
// 把它们注册为兜底源后，无标记时 LONG_TASK 行仍能给出「窗口内有哪些 perf span」，
// 不再只能猜。只在 LONG_TASK 告警路径（低频）被调用 ⇒ 允许分配（与标记环的零分配
// 约束不冲突）。源必须**快速、无副作用、异常自吞**（本模块也会再包一层 try）。
export type RenderActivityFallbackSource = (startMs: number, endMs: number) => string | undefined;

const _fallbackSources: RenderActivityFallbackSource[] = [];

/** 注册兜底归因源；返回反注册函数。 */
export function registerRenderActivityFallbackSource(src: RenderActivityFallbackSource): () => void {
	_fallbackSources.push(src);
	return () => {
		const i = _fallbackSources.indexOf(src);
		if (i >= 0) { _fallbackSources.splice(i, 1); }
	};
}

/** 测试用：清空环。 */
export function __resetRenderActivityTraceForTest(): void {
	tags.fill('');
	stamps.fill(0);
	cursor = 0;
	written = 0;
}
