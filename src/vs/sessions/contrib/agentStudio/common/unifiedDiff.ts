/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 极简 unified diff（纯逻辑，零 IO）—— 用于 `patch` 成功回执（2026-09-21，pi 对比后补）。
 *
 * ## 为什么给模型看 diff（pi 的对照事实）
 *
 * pi 的 `edit` 成功时回传 diff；本仓 `patch` 此前只回「Updated region（带行号的那一段文本）」。
 * region 足以**继续编辑**（本仓刻意如此设计），但**看不出改动的形状** —— 模型无法一眼确认
 * 「删了几行 / 加了几行 / 有没有删多」，多行替换与批量编辑时尤其明显。
 *
 * ## 设计取舍（刻意保持小）
 *
 * - **只输出一个 hunk**：裁剪公共前后缀后，把中间差异整体作为一个 hunk。文件编辑天然局部，
 *   多 hunk 只会让算法与输出都变复杂而收益极低。
 * - **双闸上限**：`maxLines` / `maxChars`（默认 60 行 / 4000 字符），超出以 `… (diff truncated) …` 收尾
 *   —— 回执是**辅助信息**，绝不能把上下文顶爆 ✗。
 * - **绝不抛错**：任何异常返回空串，调用方据此跳过追加；diff 失败不得影响 patch 结果本身。
 */

/** diff 渲染选项。 */
export interface IUnifiedDiffOptions {
	/** 上下文行数（默认 3，与 git 一致）。 */
	readonly contextLines?: number;
	/** 最多输出的行数（默认 60；**下限 2**，低于此值会被抬到 2，避免只剩截断标记）。 */
	readonly maxLines?: number;
	/** 最多输出的字符数（默认 4000；**下限 40**，同上）。 */
	readonly maxChars?: number;
	/** hunk 头里显示的路径（可选；给了就带 `--- a/x` / `+++ b/x`）。 */
	readonly filePath?: string;
}

/** 差异统计（供回执写 `+A/-R` 摘要，免得模型自己数）。 */
export interface IDiffStat {
	readonly added: number;
	readonly removed: number;
}

/** 公共前后缀裁剪结果（`diffStat` 与 `buildUnifiedDiff` 共用，保证口径一致）。 */
interface ITrimmed {
	readonly a: string[];
	readonly b: string[];
	/** 公共前缀行数（两侧同下标、内容相同）。 */
	readonly head: number;
	/** 公共后缀行数。 */
	readonly tail: number;
}

/** 按行切分并裁掉公共前后缀。 */
function trimCommonLines(before: string, after: string): ITrimmed {
	const a = before.split(/\r\n|\n/);
	const b = after.split(/\r\n|\n/);
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) { head++; }
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head
		&& a[a.length - 1 - tail] === b[b.length - 1 - tail]) { tail++; }
	return { a, b, head, tail };
}

/** 全文 vs 新文的差异统计。 */
export function diffStat(before: string, after: string): IDiffStat {
	const { a, b, head, tail } = trimCommonLines(before, after);
	return { added: b.length - head - tail, removed: a.length - head - tail };
}

/**
 * 生成 unified diff 文本（不含颜色；调用方决定是否包进 ```diff 代码块）。
 *
 * @returns 无差异时返回空串。
 */
export function buildUnifiedDiff(before: string, after: string, opts: IUnifiedDiffOptions = {}): string {
	try {
		if (before === after) { return ''; }
		const ctx = Math.max(0, opts.contextLines ?? 3);
		const maxLines = Math.max(2, opts.maxLines ?? 60);
		const maxChars = Math.max(40, opts.maxChars ?? 4000);

		const { a, b, head, tail } = trimCommonLines(before, after);
		const oldChanged = a.length - tail - head;   // 被删除的行数
		const newChanged = b.length - tail - head;   // 被新增的行数
		const ctxBefore = Math.min(ctx, head);
		// ⚠ ctxAfter 必须按「a 侧改动之后还剩多少行」算（含公共后缀）——若按 a 侧改动长度算，
		// 纯插入（oldChanged=0）会算出 0 上下文，尾随的公共行就丢了（diff 看不出插入位置）。
		const ctxAfter = Math.min(ctx, a.length - (head + oldChanged));

		const body: string[] = [];
		for (let i = head - ctxBefore; i < head; i++) { body.push(` ${a[i]}`); }
		for (let i = head; i < head + oldChanged; i++) { body.push(`-${a[i]}`); }
		for (let i = head; i < head + newChanged; i++) { body.push(`+${b[i]}`); }
		for (let i = head + oldChanged; i < head + oldChanged + ctxAfter; i++) { body.push(` ${a[i]}`); }

		// 标准 hunk 头：@@ -oldStart,oldLen +newStart,newLen @@（1-based 起始行）
		const header =
			`@@ -${head - ctxBefore + 1},${ctxBefore + oldChanged + ctxAfter} ` +
			`+${head - ctxBefore + 1},${ctxBefore + newChanged + ctxAfter} @@`;

		const all: string[] = [];
		if (opts.filePath) { all.push(`--- a/${opts.filePath}`, `+++ b/${opts.filePath}`); }
		all.push(header, ...body);

		const lines = all.length > maxLines
			? [...all.slice(0, maxLines), '… (diff truncated) …']
			: all;
		const text = lines.join('\n');
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (diff truncated) …` : text;
	} catch {
		// 回执是辅助信息：diff 失败绝不能影响 patch 结果本身
		return '';
	}
}
