/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 进度百分比格式化（**唯一真源**；2026-09-12 用户需求「生成的进度最多显示小数点后2位」）。
 *
 * 为什么需要它：进度几乎都来自 `value / max * 100`（ComfyUI step、逐格执行
 * `4 + per * ji`、下载字节比…），结果是**无限小数**（如 `45.45454545454546`）。
 * 此前直接把数字插进文案（`` `生成中 ${prog}%` ``）→ 卡片上出现一长串小数，
 * 既难看、又会把窄卡片撑乱 / 被 CSS 省略号截成「45.45…」这种**看起来像 bug** 的样子 ✗。
 *
 * 规则（**最多** 2 位小数，**不补零**）：
 * ```ts
 * formatProgressPct(45.45454545454546) === '45.45'
 * formatProgressPct(45.4567)           === '45.46'
 * formatProgressPct(45.4)              === '45.4'   // 不是 '45.40'（避免噪音 ✗）
 * formatProgressPct(40)                === '40'     // 整数不补 '.00'
 * formatProgressPct(-1)                === '0'      // 负数无意义（-1 在本仓库表示
 *                                                   // 「不确定进度」，调用方需自己判 `＜0` 再显示 '…'）
 * formatProgressPct(NaN)               === '0'      // `Math.min(100, NaN)` 仍是 NaN →
 *                                                   // width 'NaN%' 非法 → 进度条整条不渲染 ✗
 * ```
 *
 * ⚠ 只做**显示**格式化：写进 store / 上报 host 的 `progress` **必须仍是 number**
 *   （进度条宽度、完成判定、阶段链推断都依赖数值 ✗ 别改成字符串）。
 */
export function formatProgressPct(value: unknown): string {
	const n = typeof value === 'number' ? value : Number(value);
	// NaN / ±Infinity / 非数字 → 0（`Math.min(100, NaN)` 仍是 NaN，会让 width 变 'NaN%' ✗）
	if (!Number.isFinite(n)) { return '0'; }
	// 负数在本仓库是「不确定进度」的哨兵值（taskStore: progress < 0 → indeterminate），
	// 显示成 '-1%' 只会让用户困惑 ✗ → 一律归 0（要显示 '…' 的调用方需自己先判 `＜0`）。
	if (n <= 0) { return '0'; }
	return String(Math.round(n * 100) / 100);
}
