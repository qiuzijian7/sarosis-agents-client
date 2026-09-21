/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `file_read` 的尾部提示文案（纯逻辑，零 IO —— 便于单测与复用）。
 *
 * ## 为什么要有「超长行」提示（2026-09-21，pi 对比后补）
 *
 * pi 的 `read` 遇到**单行超过 50KB** 时不会只截断，而是回一句**可直接执行**的命令：
 *   `[Line N is XB, exceeds 50.0KB limit. Use bash: sed -n 'Np' <path> | head -c 51200]`
 * 本仓 `file_read` 早已把长行截断到 2000 字符（`READ_LINE_MAX_CHARS`，防一行吃掉整个上下文），
 * 但**没告诉模型怎么拿到那一行的其余部分** ⇒ 模型要么以为内容就这么多（误判），
 * 要么重读整个文件（长行文件往往极大，重读是纯浪费）✗。
 *
 * 本模块把「出路」说成**可执行**的两条（按方言分支），并劝阻重读整个文件 ——
 * 与本仓一贯的「拒绝/降级文案必须可执行」原则一致（见 `binaryReadRejectedMessage` 等）。
 */

/** 长行截断情况（1-based，均为绝对行号）。 */
export interface ILineTruncationInfo {
	/** 第一处被截断的行号（1-based）。 */
	readonly firstLine: number;
	/** 被截断的行数（本页内）。 */
	readonly truncatedCount: number;
	/** 单行保留的最大字符数（即 `READ_LINE_MAX_CHARS`）。 */
	readonly maxChars: number;
}

/**
 * 生成长行截断提示。
 *
 * @param info     截断情况（由 `readFileLines` 统计）。
 * @param filePath 已解析的文件路径（写进示例命令，供模型直接复制）。
 */
export function longLineTruncationHint(info: ILineTruncationInfo, filePath: string): string {
	const where = info.truncatedCount === 1
		? `第 ${info.firstLine} 行`
		: `第 ${info.firstLine} 行起共 ${info.truncatedCount} 行`;
	return (
		`[Hint: ${where}超过 ${info.maxChars} 字符，已按上限截断（该行内容不完整）。` +
		`要取整行内容，用 execute_code 按行取，**不要**为此重读整个文件：\n` +
		`  • Git Bash: execute_code({ command: "sed -n '${info.firstLine}p' ${filePath} | head -c 20000" })\n` +
		`  • PowerShell: execute_code({ command: "Get-Content ${filePath} -TotalCount ${info.firstLine} | Select-Object -Last 1" })]`
	);
}
