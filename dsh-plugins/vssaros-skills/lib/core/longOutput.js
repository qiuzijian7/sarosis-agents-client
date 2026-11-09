/**
 * @vssaros/dsh-skills — 长结果富媒体（2026-11-08 P1）。
 *
 * 为什么：技能正文动辄几十 KB，整篇塞回模型上下文会挤掉别的输入；截断到「前 N 行」又会让
 * 模型以为全文就这些（信息丢失但不自知）。这里把超阈值的结果改成
 *   **前 N 行预览 + 完整内容的附件路径 + 明确的行数说明**，
 * 想看全文的模型/人可以按路径去读（与 dsh 的 attachment 思路一致，不引入新 UI）。
 *
 * 纯函数、零 dsh 依赖 ⇒ 守卫可直接 import；`output.schema` / `output.render` 由调用方同步扩字段，
 * `check-tool-definitions.mjs` 继续校验。
 */
export const LONG_OUTPUT_MAX_LINES = 120;
export const LONG_OUTPUT_MAX_CHARS = 12_000;

/**
 * @param text 完整正文
 * @param options `{ maxLines, maxChars, attachmentPath }`
 * @returns `{ preview, truncated, totalLines, totalChars, keptLines, attachmentPath }`
 */
export function clipLongOutput(text, options = {}) {
	const full = String(text ?? '');
	const maxLines = Number.isFinite(options?.maxLines) ? Math.max(1, options.maxLines) : LONG_OUTPUT_MAX_LINES;
	const maxChars = Number.isFinite(options?.maxChars) ? Math.max(1, options.maxChars) : LONG_OUTPUT_MAX_CHARS;
	const lines = full.split('\n');
	const totalLines = lines.length;
	const totalChars = full.length;
	const kept = [];
	let chars = 0;
	for (const line of lines) {
		if (kept.length >= maxLines || chars + line.length > maxChars) { break; }
		kept.push(line);
		chars += line.length + 1;
	}
	const truncated = kept.length < totalLines || chars < totalChars;
	return {
		preview: kept.join('\n'),
		truncated,
		totalLines,
		totalChars,
		keptLines: kept.length,
		...(truncated && options?.attachmentPath ? { attachmentPath: String(options.attachmentPath) } : {}),
	};
}

/** 渲染给模型的说明行（诚实：不把截断说成全文）。 */
export function longOutputNote(clipped) {
	if (!clipped?.truncated) { return ''; }
	const path = clipped.attachmentPath ? `完整内容：\`${clipped.attachmentPath}\`` : '完整内容请用 read_skill 按路径读取';
	return `\n\n…（仅显示前 ${clipped.keptLines}/${clipped.totalLines} 行、${clipped.preview.length}/${clipped.totalChars} 字；${path}）`;
}
