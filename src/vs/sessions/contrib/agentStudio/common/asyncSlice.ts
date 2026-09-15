/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 时间预算切片 —— 大循环「让出主线程」的统一口径（2026-09-15）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────
 * 图谱加载链路原本用**固定条数**让出主线程（每 2000 个 JSON 元素 / 每 8000 条记录 /
 * 每 1000 个节点）。固定条数的问题是**单次连续占用时间随数据规模与机器而浮动**：
 *   · 元素小、机器快 ⇒ 一批几十毫秒（无感）；
 *   · 元素大（大图节点带长 filePath / 签名）或机器慢 ⇒ 一批 **50~200ms**
 *     ⇒ 用户看到的就是「切换工作区时整窗一顿一顿」（实测 UE5EA 87.6 万节点）。
 *
 * ⇒ 改成**按时间预算**判断：一次切片最多连续占用主线程 `SLICE_BUDGET_MS`，超了就 await 让出。
 *   好处：与「节点大小 / 机器快慢 / 数据规模」自动适配 —— 快机器少让出（吞吐不掉），
 *   慢机器或大节点多让出（不卡 UI）。
 *
 * ── 代价（明说）──────────────────────────────────────────────────────
 * 让出更频繁 ⇒ 总耗时略增（`setTimeout(0)` 的宏任务开销，经验量级 5~10%）。
 * 这是「交互响应 vs 总时长」的取舍：加载图谱是**后台可等待**的工作，卡住 UI 才是不可接受的。
 */

/**
 * 单次切片的时间预算（毫秒）。
 *
 * 取 **8ms** 而不是 16ms：60Hz 下 16ms 正好是一整帧，用满会吃掉渲染与输入处理的时间
 * ⇒ 仍然掉帧。8ms 留一半给浏览器，视觉上接近「不卡」。
 */
export const SLICE_BUDGET_MS = 8;

/**
 * 检查时间预算的间隔（每 N 个工作项查一次 `performance.now()`）。
 *
 * 为什么不是每项都查：`performance.now()` 本身有开销，而单项工作（插入一个节点 /
 * 解析一个 JSON 元素）常在微秒级 ⇒ 每项都查会让检查开销超过工作本身。
 * 128 是「检查开销可忽略」与「超预算后最多多干一点」的折中。
 */
export const SLICE_CHECK_EVERY = 128;

/**
 * 当前切片是否已超出预算。
 *
 * 用法（循环里每 `SLICE_CHECK_EVERY` 项调一次；返回 true 时调用方**必须**让出并重置基准）：
 *
 * ```ts
 * let sliceStart = performance.now();
 * for (let i = 0; i < n; i++) {
 *     doWork(i);
 *     if ((i % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
 *         await yieldToEventLoop();
 *         sliceStart = performance.now();
 *     }
 * }
 * ```
 */
export function sliceBudgetExceeded(sliceStart: number): boolean {
	return performance.now() - sliceStart >= SLICE_BUDGET_MS;
}

/** 让出主线程一次（宏任务）。让出后调用方应把 `sliceStart` 重置为 `performance.now()`。 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, 0));
}
