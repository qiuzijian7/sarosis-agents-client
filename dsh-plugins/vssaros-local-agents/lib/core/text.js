// ContentBlock[] → 纯文本。P0（NDJSON）与 P1（ACP）共用，避免两者循环 import。
export function textOfContent(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((part) => part && part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n');
}
