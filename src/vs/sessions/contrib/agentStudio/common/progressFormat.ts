/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 进度百分比格式化（**宿主/聊天侧**；2026-09-12 用户需求「生成的进度最多显示小数点后2位」）。
 *
 * ⚠⚠ **本文件是 `webview/src/features/workflowEditor/comfyHost/progressFormat.ts` 的
 *    镜像实现** —— 宿主（主进程侧聊天面板）与 webview（画布）是**两个独立 bundle**，
 *    webview 的 tsconfig 有 `rootDir: ./src`（`include: src/**`），无法相对引用
 *    `common/` 下的文件 ✗，故只能各留一份。
 *
 *    ⇒ **两边必须始终同口径**：由 `test/browser/workflowProgressFormat.test.ts`
 *      对两张实现做**逐值一致性断言**（同一组输入必须输出相同字符串）✓ ——
 *      改任何一边都会立刻被那条测试打回 ✗。
 *
 * 为什么需要它：进度几乎都来自 `value / max * 100`（ComfyUI step 轮询、逐格执行），
 * 结果是**无限小数**（如 `45.45454545454546`）。宿主在**兜底文案**里直接插值
 * （`` `生成中 ${payload.progress}%` ``）→ 聊天卡上出现一长串小数 ✗。
 *
 * 规则（**最多** 2 位小数，**不补零**）：`45.45454545454546 → '45.45'`、
 * `45.4 → '45.4'`、`40 → '40'`、负数/NaN/Infinity/非数字 → `'0'`。
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
