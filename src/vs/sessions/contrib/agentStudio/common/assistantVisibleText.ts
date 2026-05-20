/*---------------------------------------------------------------------------------------------
 *  Assistant Visible Text Sanitizer
 *
 *  Multi-stage pipeline for stripping tool-call artifacts from assistant message text.
 *  Modeled after OpenClaw's assistant-visible-text.ts architecture:
 *    1. Detect tool-call-shaped text (JSON, XML, bracket, ReAct formats)
 *    2. Strip various tool-call text representations
 *    3. Provide a sanitization pipeline with configurable profiles
 *
 *  This module is designed to be used in both:
 *    - Backend (agentOSService.ts) for cleaning content before streaming to UI
 *    - Frontend (ChatMessage.tsx) for display-time sanitization
 *--------------------------------------------------------------------------------------------*/

// ════════════════════════════════════════════════════════════════════════════════
// § Types
// ════════════════════════════════════════════════════════════════════════════════

export type ToolCallShapedTextDetection = {
	kind: 'json_tool_call' | 'xml_tool_call' | 'bracketed_tool_call' | 'react_action';
	toolName?: string;
};

export type SanitizerProfile = 'delivery' | 'streaming' | 'history';

interface SanitizerOptions {
	/** Whether to strip JSON tool call objects from text */
	stripJsonToolCalls: boolean;
	/** Whether to strip ```json code blocks containing tool calls */
	stripJsonCodeBlocks: boolean;
	/** Whether to strip XML-style tool call tags */
	stripXmlToolCallTags: boolean;
	/** Whether to strip [TOOL_CALL]...[/TOOL_CALL] blocks */
	stripBracketToolCallBlocks: boolean;
	/** Whether to strip downgraded text representations like [Tool Call: ...] */
	stripDowngradedToolCallText: boolean;
	/** Whether to strip ReAct-style Action:/Action Input: blocks */
	stripReactActions: boolean;
	/** Final trim mode */
	trim: 'both' | 'start' | 'none';
}

// ════════════════════════════════════════════════════════════════════════════════
// § Constants
// ════════════════════════════════════════════════════════════════════════════════

const MAX_SCAN_CHARS = 20_000;
const MAX_JSON_CANDIDATE_CHARS = 8_000;
const MAX_JSON_CANDIDATES = 20;

/** Quick pre-filter regex — avoids expensive parsing when text clearly has no tool calls */
const TOOL_TEXT_PREFILTER_RE =
	/(?:tool[_\s-]?calls?|function[_\s-]?call|["'](?:name|tool_name|function|arguments|args|input|parameters|tool_calls)["']|<\s*tool_call\b|Action\s*:|\[(?:END_)?TOOL_(?:CALL|RESULT)\])/i;

/** Quick-check regex for XML tool call tags */
const TOOL_CALL_XML_QUICK_RE =
	/<\s*\/?\s*(?:tool_call|tool_result|function_calls?|function_response|function|tool_calls)\b/i;

/** Quick-check for legacy bracket blocks */
const LEGACY_BRACKET_QUICK_RE = /\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i;

/** Quick-check for downgraded tool call text */
const DOWNGRADED_TOOL_CALL_RE = /\[Tool (?:Call|Result)/i;

/** JSON tool-call name fields */
const JSON_TOOL_NAME_FIELDS = ['name', 'tool_name', 'tool', 'function_name', 'function'] as const;

/** JSON tool-call argument fields */
const JSON_TOOL_ARGS_FIELDS = ['arguments', 'args', 'parameters', 'params', 'input', 'command'] as const;

/** Profile configurations */
const PROFILE_OPTIONS: Record<SanitizerProfile, SanitizerOptions> = {
	delivery: {
		stripJsonToolCalls: true,
		stripJsonCodeBlocks: true,
		stripXmlToolCallTags: true,
		stripBracketToolCallBlocks: true,
		stripDowngradedToolCallText: true,
		stripReactActions: true,
		trim: 'both',
	},
	streaming: {
		stripJsonToolCalls: true,
		stripJsonCodeBlocks: true,
		stripXmlToolCallTags: true,
		stripBracketToolCallBlocks: true,
		stripDowngradedToolCallText: false,
		stripReactActions: true,
		trim: 'start',
	},
	history: {
		stripJsonToolCalls: true,
		stripJsonCodeBlocks: true,
		stripXmlToolCallTags: true,
		stripBracketToolCallBlocks: true,
		stripDowngradedToolCallText: true,
		stripReactActions: true,
		trim: 'none',
	},
};

// ════════════════════════════════════════════════════════════════════════════════
// § Detection — Detect if text looks like a tool call
// ════════════════════════════════════════════════════════════════════════════════

function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== 'string') { return undefined; }
	const trimmed = value.trim();
	return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
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
 * Recursively classify a JSON value as a tool call.
 * Handles arrays, nested tool_calls fields, function wrappers, etc.
 */
function classifyJsonValue(value: unknown): ToolCallShapedTextDetection | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const detection = classifyJsonValue(item);
			if (detection) { return detection; }
		}
		return null;
	}

	const record = asRecord(value);
	if (!record) { return null; }

	// Check nested tool_calls array
	const toolCalls = record.tool_calls ?? record.toolCalls;
	if (Array.isArray(toolCalls)) {
		for (const tc of toolCalls) {
			const detection = classifyJsonValue(tc);
			if (detection) { return detection; }
		}
		return { kind: 'json_tool_call' };
	}

	// Check nested function object
	const functionRecord = asRecord(record.function);
	if (functionRecord) {
		const toolName = readToolName(functionRecord);
		if (toolName && hasToolArgs(functionRecord)) {
			return { kind: 'json_tool_call', toolName };
		}
	}

	// Direct tool call object
	const toolName = readToolName(record);
	if (toolName && hasToolArgs(record)) {
		return { kind: 'json_tool_call', toolName };
	}

	// Type-based detection
	const type = readTrimmedString(record.type)?.toLowerCase();
	if (toolName && (
		type === 'tool_call' || type === 'toolcall' || type === 'tooluse' ||
		type === 'tool_use' || type === 'function_call' || type === 'functioncall'
	)) {
		return { kind: 'json_tool_call', toolName };
	}

	// Fallback: {"toolName": {"arg": "val"}} format (single key whose value is an arg object)
	const reservedTopKeys = new Set(['id', 'tool_use_id', 'toolUseId', 'tool_call_id', 'type']);
	const topKeys = Object.keys(record).filter(k => !reservedTopKeys.has(k));
	if (topKeys.length === 1) {
		const nested = asRecord(record[topKeys[0]]);
		if (nested && hasToolArgs(nested)) {
			return { kind: 'json_tool_call', toolName: topKeys[0] };
		}
	}

	return null;
}

/**
 * Find the end of a balanced JSON structure starting at `start`.
 */
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

/**
 * Collect JSON candidates from ```json fenced code blocks.
 */
function collectFencedJsonCandidates(text: string): Array<{ start: number; end: number; content: string }> {
	const candidates: Array<{ start: number; end: number; content: string }> = [];
	const fenceRe = /```(?:json|JSON|tool|tool_call|function_call)?[^\n\r]*[\r\n]([\s\S]*?)```/gi;
	let match: RegExpExecArray | null;
	while ((match = fenceRe.exec(text)) !== null) {
		const content = match[1]?.trim();
		if (content && content.length <= MAX_JSON_CANDIDATE_CHARS) {
			candidates.push({
				start: match.index,
				end: match.index + match[0].length,
				content,
			});
		}
	}
	return candidates;
}

/**
 * Collect balanced JSON objects/arrays from raw text.
 */
function collectBalancedJsonCandidates(text: string): Array<{ start: number; end: number; content: string }> {
	const candidates: Array<{ start: number; end: number; content: string }> = [];
	for (let i = 0; i < text.length && candidates.length < MAX_JSON_CANDIDATES; i++) {
		const ch = text[i];
		if (ch !== '{' && ch !== '[') { continue; }
		const end = findBalancedJsonEnd(text, i);
		if (end === null) { continue; }
		const content = text.slice(i, end).trim();
		if (content.length > 1) {
			candidates.push({ start: i, end, content });
		}
		i = end - 1;
	}
	return candidates;
}

/**
 * Detect JSON-formatted tool calls in text.
 */
function detectJsonToolCall(text: string): ToolCallShapedTextDetection | null {
	const allCandidates = [...collectFencedJsonCandidates(text), ...collectBalancedJsonCandidates(text)];
	for (const candidate of allCandidates) {
		try {
			const detection = classifyJsonValue(JSON.parse(candidate.content));
			if (detection) { return detection; }
		} catch { /* malformed JSON is fine */ }
	}
	return null;
}

/**
 * Detect XML-style tool call tags.
 */
function detectXmlToolCall(text: string): ToolCallShapedTextDetection | null {
	if (!/<\s*tool_call\b/i.test(text)) { return null; }
	if (!/<\s*function=/i.test(text) && !/["']name["']\s*:\s*["'][^"']{1,120}["']/i.test(text)) {
		return null;
	}
	const toolName =
		/<\s*function=([A-Za-z0-9_.:-]{1,120})\b/i.exec(text)?.[1] ??
		/["']name["']\s*:\s*["']([^"']{1,120})["']/i.exec(text)?.[1]?.trim();
	return { kind: 'xml_tool_call', ...(toolName ? { toolName } : {}) };
}

/**
 * Detect [TOOL_CALL]...[/TOOL_CALL] bracket format.
 */
function detectBracketedToolCall(text: string): ToolCallShapedTextDetection | null {
	const legacyMatch = /\[\s*TOOL_CALL\s*\]\s*{[\s\S]{0,8000}?\btool\s*=>\s*["']([A-Za-z_][A-Za-z0-9_.:-]{0,119})["'][\s\S]{0,8000}?\bargs\s*=>[\s\S]*?(?:\[\s*\/\s*TOOL_CALL\s*\]|$)/i.exec(text);
	if (legacyMatch?.[1]) {
		return { kind: 'bracketed_tool_call', toolName: legacyMatch[1] };
	}
	const match = /^\s*\[([A-Za-z_][A-Za-z0-9_.:-]{0,119})\]\s+[\s\S]*?\[END_TOOL_REQUEST\]\s*$/i.exec(text);
	if (match?.[1]) {
		return { kind: 'bracketed_tool_call', toolName: match[1] };
	}
	return null;
}

/**
 * Detect ReAct-style Action: / Action Input: patterns.
 */
function detectReactAction(text: string): ToolCallShapedTextDetection | null {
	const match = /(?:^|\n)\s*Action\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})\s*(?:\r?\n)+\s*Action Input\s*:/i.exec(text);
	if (!match?.[1]) { return null; }
	return { kind: 'react_action', toolName: match[1] };
}

/**
 * Master detection function: check if text looks like a tool call.
 * Returns detection info or null if not tool-call-shaped.
 */
export function detectToolCallShapedText(text: string): ToolCallShapedTextDetection | null {
	const trimmed = text.slice(0, MAX_SCAN_CHARS).trim();
	if (!trimmed || !TOOL_TEXT_PREFILTER_RE.test(trimmed)) {
		return null;
	}
	return (
		detectBracketedToolCall(trimmed) ??
		detectXmlToolCall(trimmed) ??
		detectJsonToolCall(trimmed) ??
		detectReactAction(trimmed)
	);
}

// ════════════════════════════════════════════════════════════════════════════════
// § Stripping — Remove tool call artifacts from text
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Strip JSON objects that look like tool calls from text.
 * Uses balanced brace matching to handle nested objects.
 */
export function stripJsonToolCalls(text: string): string {
	if (!text) { return text; }
	// Quick bail: no JSON object start
	if (!text.includes('{')) { return text; }

	let result = '';
	let i = 0;
	while (i < text.length) {
		if (text[i] === '{') {
			const end = findBalancedJsonEnd(text, i);
			if (end !== null) {
				const candidate = text.slice(i, end);
				try {
					const parsed = JSON.parse(candidate);
					const detection = classifyJsonValue(parsed);
					if (detection) {
						// This is a tool call JSON — skip it
						i = end;
						// Skip trailing whitespace/newlines
						while (i < text.length && (text[i] === '\n' || text[i] === '\r' || text[i] === ' ' || text[i] === '\t')) { i++; }
						continue;
					}
				} catch { /* not valid JSON, keep it */ }
				// Valid JSON but not a tool call, or invalid JSON — keep it
				result += text[i];
				i++;
			} else {
				// Unclosed brace — keep character
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
 * Strip ```json/JSON code blocks that contain tool call JSON.
 */
export function stripJsonCodeBlocks(text: string): string {
	if (!text) { return text; }
	const fenced = collectFencedJsonCandidates(text);
	if (fenced.length === 0) { return text; }

	// Check which fenced blocks contain tool calls and remove them
	const toRemove: Array<{ start: number; end: number }> = [];
	for (const block of fenced) {
		try {
			const parsed = JSON.parse(block.content);
			if (classifyJsonValue(parsed)) {
				toRemove.push({ start: block.start, end: block.end });
			}
		} catch { /* not valid JSON, keep the block */ }
	}

	if (toRemove.length === 0) { return text; }

	let result = '';
	let cursor = 0;
	for (const range of toRemove) {
		result += text.slice(cursor, range.start);
		cursor = range.end;
		// Skip trailing newlines after the removed block
		while (cursor < text.length && (text[cursor] === '\n' || text[cursor] === '\r')) { cursor++; }
	}
	result += text.slice(cursor);
	return result;
}

/**
 * Strip XML-style tool call tags and their content.
 * Handles: <tool_call>, <tool_result>, <function_call>, <function_calls>,
 *          <function_response>, <function>, <tool_calls>
 */
export function stripXmlToolCallTags(text: string): string {
	if (!text || !TOOL_CALL_XML_QUICK_RE.test(text)) { return text; }

	const tagNames = ['tool_call', 'tool_result', 'function_call', 'function_calls', 'function_response', 'function', 'tool_calls'];
	let result = text;

	for (const tagName of tagNames) {
		// Match opening + closing tag pairs
		const pairRe = new RegExp(`<\\s*${tagName}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tagName}\\s*>`, 'gi');
		result = result.replace(pairRe, '');

		// Match self-closing tags
		const selfCloseRe = new RegExp(`<\\s*${tagName}\\b[^>]*\\/>`, 'gi');
		result = result.replace(selfCloseRe, '');

		// Match unclosed opening tags (streaming truncation) — only if followed by JSON
		const unclosedRe = new RegExp(`<\\s*${tagName}\\b[^>]*>\\s*(?:\\{[\\s\\S]*)?$`, 'gi');
		result = result.replace(unclosedRe, '');
	}

	return result;
}

/**
 * Strip [TOOL_CALL]...[/TOOL_CALL] and [TOOL_RESULT]...[/TOOL_RESULT] blocks.
 */
export function stripLegacyBracketToolCallBlocks(text: string): string {
	if (!text || !LEGACY_BRACKET_QUICK_RE.test(text)) { return text; }

	// Remove [TOOL_CALL]...[/TOOL_CALL] pairs
	let result = text.replace(
		/\[\s*TOOL_CALL\s*\][\s\S]*?\[\s*\/\s*TOOL_CALL\s*\]/gi,
		''
	);

	// Remove [TOOL_RESULT]...[/TOOL_RESULT] pairs
	result = result.replace(
		/\[\s*TOOL_RESULT\s*\][\s\S]*?\[\s*\/\s*TOOL_RESULT\s*\]/gi,
		''
	);

	// Handle unclosed blocks (streaming truncation)
	result = result.replace(/\[\s*TOOL_CALL\s*\][\s\S]*$/gi, '');
	result = result.replace(/\[\s*TOOL_RESULT\s*\][\s\S]*$/gi, '');

	return result;
}

/**
 * Strip downgraded tool call text: [Tool Call: name (ID: xxx)]
 * and [Tool Result for ID xxx] blocks.
 */
export function stripDowngradedToolCallText(text: string): string {
	if (!text || !DOWNGRADED_TOOL_CALL_RE.test(text)) { return text; }

	let result = text;

	// Remove [Tool Call: ...] lines and their Arguments sections
	result = result.replace(
		/\[Tool Call:[^\]]*\]\s*\n?(?:Arguments:\s*(?:\{[\s\S]*?\}|\S[^\n]*)\n?)?/gi,
		''
	);

	// Remove [Tool Result for ID ...] blocks
	result = result.replace(
		/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi,
		''
	);

	// Remove [Historical context: ...] markers
	result = result.replace(/\[Historical context:[^\]]*\]\n?/gi, '');

	return result;
}

/**
 * Strip ReAct-style Action: / Action Input: blocks.
 */
export function stripReactActions(text: string): string {
	if (!text || !/Action\s*:/i.test(text)) { return text; }

	// Remove Action: + Action Input: blocks (with their content)
	return text.replace(
		/(?:^|\n)\s*Action\s*:\s*[A-Za-z_][A-Za-z0-9_.:-]*\s*(?:\r?\n)+\s*Action Input\s*:[\s\S]*?(?=\n\s*(?:Observation|Thought|Action)\s*:|$)/gi,
		''
	);
}

/**
 * Strip reasoning/thinking tags from text.
 * Handles: <think>...</think>, <thinking>...</thinking>
 */
export function stripReasoningTags(text: string): string {
	if (!text) { return text; }
	let result = text;
	result = result.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, '');
	result = result.replace(/<\s*thinking\s*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, '');
	return result;
}

// ════════════════════════════════════════════════════════════════════════════════
// § Pipeline — Unified sanitization pipeline
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Apply the full sanitization pipeline with given options.
 */
function applySanitizationPipeline(text: string, options: SanitizerOptions): string {
	if (!text) { return ''; }

	let cleaned = text;

	if (options.stripJsonCodeBlocks) {
		cleaned = stripJsonCodeBlocks(cleaned);
	}
	if (options.stripJsonToolCalls) {
		cleaned = stripJsonToolCalls(cleaned);
	}
	if (options.stripXmlToolCallTags) {
		cleaned = stripXmlToolCallTags(cleaned);
	}
	if (options.stripBracketToolCallBlocks) {
		cleaned = stripLegacyBracketToolCallBlocks(cleaned);
	}
	if (options.stripDowngradedToolCallText) {
		cleaned = stripDowngradedToolCallText(cleaned);
	}
	if (options.stripReactActions) {
		cleaned = stripReactActions(cleaned);
	}

	// Always strip reasoning tags (not profile-dependent — these should never be visible)
	cleaned = stripReasoningTags(cleaned);

	// Apply final trim
	if (options.trim === 'both') {
		cleaned = cleaned.trim();
	} else if (options.trim === 'start') {
		cleaned = cleaned.trimStart();
	}

	return cleaned;
}

/**
 * Sanitize assistant visible text with a named profile.
 *
 * Profiles:
 *  - "delivery": Full sanitization, trims both ends. Use for final display.
 *  - "streaming": Strips tool calls but only trims start. Use during streaming.
 *  - "history": Full sanitization, no trim. Use when saving to history.
 */
export function sanitizeAssistantVisibleText(text: string, profile: SanitizerProfile = 'delivery'): string {
	return applySanitizationPipeline(text, PROFILE_OPTIONS[profile]);
}

/**
 * Sanitize tool result text for display.
 * Strips reasoning tags and other artifacts that might leak into tool results.
 */
export function sanitizeToolResultText(text: string): string {
	if (!text) { return ''; }
	return stripReasoningTags(text).trim();
}

/**
 * Quick check if text contains any tool-call-shaped content.
 * Cheaper than full detection — useful for deciding whether to run sanitization.
 */
export function mightContainToolCallText(text: string): boolean {
	if (!text) { return false; }
	return TOOL_TEXT_PREFILTER_RE.test(text.slice(0, MAX_SCAN_CHARS));
}

/**
 * Check if the entire text content is just a tool call (no meaningful prose).
 * Used to decide whether to clear content entirely vs. strip portions.
 */
export function isEntirelyToolCallContent(text: string): boolean {
	if (!text) { return false; }
	const trimmed = text.trim();
	if (trimmed.length < 2) { return false; }

	// Check if it's pure JSON that classifies as a tool call
	if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
		(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
		try {
			const parsed = JSON.parse(trimmed);
			return classifyJsonValue(parsed) !== null;
		} catch { /* not valid JSON */ }
	}

	// Check if it's entirely an XML tool call tag
	if (/<\s*(?:tool_call|function_call)\b/i.test(trimmed) &&
		/<\s*\/\s*(?:tool_call|function_call)\s*>\s*$/i.test(trimmed)) {
		return true;
	}

	// Check if it's a bracket-enclosed tool call
	if (/^\s*\[\s*TOOL_CALL\s*\][\s\S]*\[\s*\/\s*TOOL_CALL\s*\]\s*$/i.test(trimmed)) {
		return true;
	}

	// Check if sanitizing removes everything
	const sanitized = sanitizeAssistantVisibleText(trimmed, 'delivery');
	return sanitized.length < 5;
}
