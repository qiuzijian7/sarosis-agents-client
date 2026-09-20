/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 确定性 token 预算（P0-4，2026-09-20）—— 对齐 codebase-memory-mcp 的 `max_output_tokens` ✓。
 *
 * ## 口径（⚠ 必须诚实写清）
 * **1 token ≈ 4 字符**（`OUTPUT_TOKEN_BYTES`）—— 这是对方的确定性近似 ✓，**不是**精确 tokenizer
 * 计数 ✗（真 tokenizer 依赖模型、且太贵 ✗）。它答的是「**这条结果最多占多少上下文**」✓，
 * 不是「精确的 token 数」✗ —— 描述里必须这么写，别让模型误读 ✗✓。
 *
 * ## 截断策略（为什么是「整行」而不是「按字符硬切」）
 * TOON 表是**逐行**的记录 ✓ ⇒ 按字符硬切会把**半行**切出来 ⇒ 模型读到一行残缺的记录 ✗✗。
 * 故**整行取舍**（保留 header + 放得下的完整行 ✓），再附一行收敛指引 ✓ —— 表结构始终合法 ✓✓。
 */

/** 1 token ≈ 多少字符（确定性近似 ✓，见头注）。 */
export const OUTPUT_TOKEN_BYTES = 4;

/** 截断结果。 */
export interface ITokenBudgetResult {
	/** 截断后的文本（未截断时 = 原文 ✓）。 */
	readonly text: string;
	/** 是否真的截了 ✓。 */
	readonly truncated: boolean;
	/** 实际丢了多少行（0 = 没截 ✓）。 */
	readonly droppedLines: number;
}

/**
 * 把多行输出**按整行**截到 token 预算内。
 *
 * @param output 原始多行文本
 * @param maxOutputTokens token 预算（**未传 / ≤0 ⇒ 不截** ✓）
 * @param narrowHint 截断时附带的「如何缩小范围」指引（复用调用方的措辞 ✓）
 */
export function truncateToTokenBudget(
	output: string,
	maxOutputTokens: number | undefined,
	narrowHint?: string,
): ITokenBudgetResult {
	if (!maxOutputTokens || maxOutputTokens <= 0) {
		return { text: output, truncated: false, droppedLines: 0 };
	}
	const budgetChars = Math.floor(maxOutputTokens * OUTPUT_TOKEN_BYTES);
	if (output.length <= budgetChars) {
		return { text: output, truncated: false, droppedLines: 0 };
	}

	const lines = output.split('\n');
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		// 整行取舍：放不下的**第一行**就停 ✓（不切半行 ✗）
		if (used + line.length + 1 > budgetChars) { break; }
		kept.push(line);
		used += line.length + 1;
	}
	const dropped = lines.length - kept.length;
	const marker = `\nHINT: output truncated to ~${maxOutputTokens} tokens (kept ${kept.length} line(s), dropped ${dropped}).`
		+ (narrowHint ? ` Narrow down: ${narrowHint}` : '');
	return { text: kept.join('\n') + marker, truncated: true, droppedLines: dropped };
}
