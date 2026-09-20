/*---------------------------------------------------------------------------------------------
 *  pi 内核驱动器 —— 纯工具小件（2026-09-20 自 piTurnKernel.ts 拆出）。
 *
 *  零依赖（不 import 任何 piLoop/宿主模块），供 kernelMessages / kernelGuardrails /
 *  piTurnKernel 共用。搬出原因：piTurnKernel 超 1200 行，按「内核薄、复杂度归钩子」
 *  的 pi 哲学拆分；本文件只放无副作用的纯函数。
 *--------------------------------------------------------------------------------------------*/

/** 宿主工具结果（string / 内容块数组 / 任意对象）→ 供 LLM 消费的纯文本。 */
export function toolResultToText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		const parts = content.map(b =>
			typeof b === 'string' ? b
				: (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') ? (b as { text: string }).text
					: '',
		).filter(Boolean);
		if (parts.length > 0) { return parts.join('\n'); }
	}
	if (content === undefined || content === null) { return ''; }
	try { return JSON.stringify(content); } catch { return String(content); }
}

/** 消息 content（string / 内容块数组）→ 纯文本。 */
export function asText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map(b =>
			typeof b === 'string' ? b
				: (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') ? (b as { text: string }).text
					: '',
		).join('');
	}
	return content === undefined || content === null ? '' : String(content);
}

/** 工具参数（JSON 字符串或已解析对象）→ 对象；失败降级空对象。 */
export function parseArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) { return raw as Record<string, unknown>; }
	if (typeof raw !== 'string' || !raw) { return {}; }
	try {
		const v: unknown = JSON.parse(raw);
		return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
	} catch { return {}; }
}
