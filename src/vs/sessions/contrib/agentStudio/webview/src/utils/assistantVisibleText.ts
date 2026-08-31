/*---------------------------------------------------------------------------------------------
 *  Assistant Visible Text Sanitizer (WebView Edition)
 *
 *  Lightweight port of the shared sanitizer for use in the webview React app.
 *  Strips tool-call artifacts from assistant message content before rendering.
 *
 *  This mirrors the logic in:
 *    src/vs/sessions/contrib/agentStudio/common/assistantVisibleText.ts
 *  but is bundled independently for the webview context.
 *--------------------------------------------------------------------------------------------*/

// ════════════════════════════════════════════════════════════════════════════════
// § Constants
// ════════════════════════════════════════════════════════════════════════════════

const MAX_JSON_CANDIDATE_CHARS = 8_000;

/** JSON tool-call name fields */
const JSON_TOOL_NAME_FIELDS = ['name', 'tool_name', 'tool', 'function_name', 'function'] as const;

/** JSON tool-call argument fields */
const JSON_TOOL_ARGS_FIELDS = ['arguments', 'args', 'parameters', 'params', 'input', 'command'] as const;

// ════════════════════════════════════════════════════════════════════════════════
// § Detection helpers
// ════════════════════════════════════════════════════════════════════════════════

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== 'string') { return undefined; }
	const trimmed = value.trim();
	return trimmed || undefined;
}

function readToolName(record: Record<string, unknown>): string | undefined {
	for (const field of JSON_TOOL_NAME_FIELDS) {
		const name = readTrimmedString(record[field]);
		if (name) { return name; }
	}
	return undefined;
}

function hasToolArgs(record: Record<string, unknown>): boolean {
	for (const field of JSON_TOOL_ARGS_FIELDS) {
		if (field in record) { return true; }
	}
	return false;
}

/**
 * Classify a parsed JSON value as a tool call.
 */
function classifyJsonValue(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some(item => classifyJsonValue(item));
	}

	const record = asRecord(value);
	if (!record) { return false; }

	// Nested tool_calls array
	const toolCalls = record.tool_calls ?? record.toolCalls;
	if (Array.isArray(toolCalls)) { return true; }

	// Nested function object
	const functionRecord = asRecord(record.function);
	if (functionRecord && readToolName(functionRecord) && hasToolArgs(functionRecord)) {
		return true;
	}

	// Direct tool call
	const toolName = readToolName(record);
	if (toolName && hasToolArgs(record)) { return true; }

	// Type-based
	const type = readTrimmedString(record.type)?.toLowerCase();
	if (toolName && (
		type === 'tool_call' || type === 'toolcall' || type === 'tooluse' ||
		type === 'tool_use' || type === 'function_call' || type === 'functioncall'
	)) { return true; }

	return false;
}

// ════════════════════════════════════════════════════════════════════════════════
// § Balanced JSON utilities
// ════════════════════════════════════════════════════════════════════════════════

function findBalancedJsonEnd(text: string, start: number): number | null {
	const opening = text[start];
	const closing = opening === '{' ? '}' : opening === '[' ? ']' : '';
	if (!closing) { return null; }

	const stack = [closing];
	let inString = false;
	let escaped = false;
	for (let i = start + 1; i < text.length; i++) {
		if (i - start > MAX_JSON_CANDIDATE_CHARS) { return null; }
		const ch = text[i];
		if (inString) {
			if (escaped) { escaped = false; }
			else if (ch === '\\') { escaped = true; }
			else if (ch === '"') { inString = false; }
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === '{' || ch === '[') {
			stack.push(ch === '{' ? '}' : ']');
			continue;
		}
		if (ch === '}' || ch === ']') {
			if (stack[stack.length - 1] !== ch) { return null; }
			stack.pop();
			if (stack.length === 0) { return i + 1; }
		}
	}
	return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// § Stripping functions
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Strip JSON objects that classify as tool calls from text.
 */
function stripJsonToolCalls(text: string): string {
	if (!text || !text.includes('{')) { return text; }

	let result = '';
	let i = 0;
	while (i < text.length) {
		if (text[i] === '{') {
			const end = findBalancedJsonEnd(text, i);
			if (end !== null) {
				const candidate = text.slice(i, end);
				try {
					const parsed = JSON.parse(candidate);
					if (classifyJsonValue(parsed)) {
						i = end;
						while (i < text.length && (text[i] === '\n' || text[i] === '\r' || text[i] === ' ' || text[i] === '\t')) { i++; }
						continue;
					}
				} catch { /* not valid JSON */ }
				result += text[i];
				i++;
			} else {
				result += text[i];
				i++;
			}
		} else {
			result += text[i];
			i++;
		}
	}
	return result;
}

/**
 * Strip ```json code blocks that contain tool call JSON.
 */
function stripJsonCodeBlocks(text: string): string {
	if (!text || !text.includes('```')) { return text; }

	const fenceRe = /```(?:json|JSON|tool|tool_call|function_call)?[^\n\r]*[\r\n]([\s\S]*?)```/gi;
	const toRemove: Array<{ start: number; end: number }> = [];

	let match: RegExpExecArray | null;
	while ((match = fenceRe.exec(text)) !== null) {
		const content = match[1]?.trim();
		if (!content || content.length > MAX_JSON_CANDIDATE_CHARS) { continue; }
		try {
			const parsed = JSON.parse(content);
			if (classifyJsonValue(parsed)) {
				toRemove.push({ start: match.index, end: match.index + match[0].length });
			}
		} catch { /* not valid JSON */ }
	}

	if (toRemove.length === 0) { return text; }

	let result = '';
	let cursor = 0;
	for (const range of toRemove) {
		result += text.slice(cursor, range.start);
		cursor = range.end;
		while (cursor < text.length && (text[cursor] === '\n' || text[cursor] === '\r')) { cursor++; }
	}
	result += text.slice(cursor);
	return result;
}

/**
 * Strip XML-style tool call tags.
 */
function stripXmlToolCallTags(text: string): string {
	if (!text) { return text; }
	// 早退守卫：既认「已知标签名」也认「<tag:hexid> 形态」—— 与 common 版一致。
	// 仅当既无标准工具标签、也无冒号ID伪标签时才早退，否则会漏掉
	// `think:6124c78e` / `tool_calls:6124c78e` 这类模型泄漏（它们常不带标准标签名）。
	const hasStandardTag = /<\s*\/?\s*(?:tool_call|tool_result|function_calls?|function_response|function|tool_calls|arg_key|arg_value|tool_use|invoke|think)\b/i.test(text);
	const hasTaggedId = /<\s*[A-Za-z_][\w.-]*\s*:\s*(?:[0-9a-fA-F]{6,}|\d+)\s*>/i.test(text);
	if (!hasStandardTag && !hasTaggedId) {
		return text;
	}

	const tagNames = ['tool_call', 'tool_result', 'function_call', 'function_calls', 'function_response', 'function', 'tool_calls', 'tool'];
	let result = text;

	// 防御：剥离模型泄漏的冒号ID伪XML标签（<tool_calls:xxx>, <arg_key:xxx>, <arg_value:xxx>）
	result = result.replace(/<\/?(?:tool_calls|arg_key|arg_value|tool_call|function_call|function_response|tool_result|tool_use|invoke)[:\w]*>/gi, '');
	// 兜底：形态扫描剥离所有 `<tag:hexid>` 伪标签（含 think:hexid 等白名单之外的变体）。
	// 与 common/assistantVisibleText.ts 的 stripXmlToolCallTags 保持一致——
	// 否则 webview 渲染会残留 tool_calls:6124c78e / think:6124c78e 等标签。
	// webview 为独立打包、不跨 bundle 引用 common，故此处内联等价正则
	// （即 common 的 TAGGED_ID_SCAN_RE，剥离 `<名称:6+位十六进制|纯数字>` 形态）。
	result = result.replace(/<\s*\/?\s*[A-Za-z_][\w.-]*\s*:\s*(?:[0-9a-fA-F]{6,}|\d+)\s*>/g, '');

	for (const tagName of tagNames) {
		const pairRe = new RegExp(`<\\s*${tagName}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tagName}\\s*>`, 'gi');
		result = result.replace(pairRe, '');
		const selfCloseRe = new RegExp(`<\\s*${tagName}\\b[^>]*\\/>`, 'gi');
		result = result.replace(selfCloseRe, '');
		const unclosedRe = new RegExp(`<\\s*${tagName}\\b[^>]*>\\s*(?:\\{[\\s\\S]*)?$`, 'gi');
		result = result.replace(unclosedRe, '');
	}

	// 模型「伪造」工具调用时常写一排方块字符作为分隔(fence)，正常回答几乎不可能
	// 出现整行纯方块字符，剥离之（否则这些 fence 会原样显示在聊天里）。
	result = result.replace(/^[ \t]*(?:[\u2580-\u259F\u25A0])+[ \t]*$/gm, '');

	return result;
}

/**
 * Strip [TOOL_CALL]...[/TOOL_CALL] blocks.
 */
function stripBracketToolCallBlocks(text: string): string {
	if (!text || !/\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i.test(text)) { return text; }

	let result = text;
	result = result.replace(/\[\s*TOOL_CALL\s*\][\s\S]*?\[\s*\/\s*TOOL_CALL\s*\]/gi, '');
	result = result.replace(/\[\s*TOOL_RESULT\s*\][\s\S]*?\[\s*\/\s*TOOL_RESULT\s*\]/gi, '');
	result = result.replace(/\[\s*TOOL_CALL\s*\][\s\S]*$/gi, '');
	result = result.replace(/\[\s*TOOL_RESULT\s*\][\s\S]*$/gi, '');
	return result;
}

/**
 * Strip downgraded tool call text representations.
 */
function stripDowngradedToolCallText(text: string): string {
	if (!text || (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text))) {
		return text;
	}

	let result = text;
	result = result.replace(/\[Tool Call:[^\]]*\]\s*\n?(?:Arguments:\s*(?:\{[\s\S]*?\}|\S[^\n]*)\n?)?/gi, '');
	result = result.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, '');
	result = result.replace(/\[Historical context:[^\]]*\]\n?/gi, '');
	return result;
}

/**
 * Strip reasoning/thinking tags from text.
 * Handles: </think>, <think>...</think>, <thinking>...</thinking>
 */
function stripReasoningTags(text: string): string {
	if (!text) { return text; }
	let result = text;
	//  (DeepSeek/QwQ style)
	result = result.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, '');
	// <thinking>...</thinking>
	result = result.replace(/<\s*thinking\s*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, '');
	// 带冒号ID伪标签形态（<think:6124c78e>...</think:6124c78e>）—— 模型把思考块也写成
	// `:hexid` 形态时，上面两条标准正则匹配不到，必须单独处理，否则原样泄露到 UI。
	result = result.replace(/<\s*think\s*:\s*[\w-]+\s*>[\s\S]*?<\s*\/\s*think\s*:\s*[\w-]+\s*>/gi, '');
	result = result.replace(/<\s*\/?\s*think\s*:\s*[\w-]+\s*>/gi, '');
	return result;
}

// ════════════════════════════════════════════════════════════════════════════════
// § Public API
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Sanitize assistant message content for display.
 * Strips all forms of tool-call artifacts from text.
 *
 * Use this when the message has tool calls and you want to clean
 * any residual tool-call text from the content.
 *
 * NOTE: Markdown normalization (heading spacing, bullet conversion, table
 * formatting, blank-line collapsing) is intentionally NOT done here.
 * It is handled uniformly by MarkdownRenderer for both streaming and
 * completed content, ensuring rendering consistency between the two phases.
 */
export function sanitizeAssistantContent(text: string): string {
	if (!text) { return ''; }

	let cleaned = text;
	cleaned = stripJsonCodeBlocks(cleaned);
	cleaned = stripJsonToolCalls(cleaned);
	cleaned = stripXmlToolCallTags(cleaned);
	cleaned = stripBracketToolCallBlocks(cleaned);
	cleaned = stripDowngradedToolCallText(cleaned);
	cleaned = stripReasoningTags(cleaned);

	return cleaned.trim();
}

/**
 * Streaming sanitizer — applies the SAME pipeline as sanitizeAssistantContent
 * to ensure rendering consistency between streaming and completed states.
 *
 * OpenClaw pattern: use the exact same processing for both streaming and final
 * content so there is zero visual difference when a stream completes.
 *
 * NOTE: Markdown normalization is intentionally NOT done here.
 * It is handled uniformly by MarkdownRenderer for both streaming and
 * completed content, ensuring rendering consistency between the two phases.
 */
export function sanitizeStreamingText(text: string): string {
	if (!text) { return ''; }

	let cleaned = text;
	// Apply the full sanitization pipeline (same as sanitizeAssistantContent)
	cleaned = stripJsonCodeBlocks(cleaned);
	cleaned = stripJsonToolCalls(cleaned);
	cleaned = stripXmlToolCallTags(cleaned);
	cleaned = stripBracketToolCallBlocks(cleaned);
	cleaned = stripDowngradedToolCallText(cleaned);
	cleaned = stripReasoningTags(cleaned);

	return cleaned.trim();
}

/**
 * Sanitize tool result text for display in tool cards.
 * Strips reasoning tags and other artifacts that might leak into results.
 */
export function sanitizeToolResultText(text: string): string {
	if (!text) { return ''; }

	let cleaned = text;
	cleaned = stripReasoningTags(cleaned);

	return cleaned.trim();
}

/**
 * Detect if content is pure JSON that represents a tool call.
 */
export function isPureToolCallJson(text: string): boolean {
	if (!text) { return false; }
	const trimmed = text.trim();
	if (trimmed.length < 2) { return false; }
	if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
		(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
		try {
			return classifyJsonValue(JSON.parse(trimmed));
		} catch { return false; }
	}
	return false;
}
