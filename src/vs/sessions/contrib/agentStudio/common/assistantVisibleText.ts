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

import { stripTaggedIdXmlTags, locateTaggedIdXmlTags, findCodeRegions } from './agentRunState.js';

// ════════════════════════════════════════════════════════════════════════════════
//  代码区暂存（stash）：让各道剥离**跳过** Markdown 代码区
//
//  成因：模型在回答里**举例讨论**工具调用语法（例如横向对比几个项目的提示词
//  格式）是正当的技术讨论，用户要看的正是这段内容。若连代码块里的示例一起
//  抹掉，等于把用户想看的答案删了 —— 而这类场景恰恰是伪 XML 泄漏的高发场景
//  （模型讨论格式时最容易顺手写出示例）。
//
//  参照 openclaw `src/shared/text/code-regions.ts` 的同名机制，其测试明确断言
//  "preserves ... inside inline and fenced code"。
//
//  实现方式：剥离前把代码区替换为哨兵，剥离后原样回填。这样**所有**剥离阶段
//  （形态剥离 / 按名剥离 / 配对内容删除）统一受保护，无需逐个阶段加判断。
// ════════════════════════════════════════════════════════════════════════════════

/** 哨兵用私有区字符，正常文本不会出现，避免与正文冲突。 */
const CODE_STASH_MARK = '\uE000';
const CODE_STASH_RE = new RegExp(`${CODE_STASH_MARK}(\\d+)${CODE_STASH_MARK}`, 'g');

interface ICodeStash {
	/** 代码区被替换为哨兵后的文本。 */
	readonly template: string;
	/** 被暂存的代码区原文，按哨兵序号索引。 */
	readonly parts: string[];
}

/** 把代码区从文本中抠出，替换为哨兵。区间重叠时后者跳过。 */
function stashCodeRegions(text: string, regions: readonly { start: number; end: number }[]): ICodeStash {
	if (regions.length === 0) { return { template: text, parts: [] }; }
	const parts: string[] = [];
	let template = '';
	let cursor = 0;
	for (const r of regions) {
		if (r.start < cursor || r.end > text.length) { continue; }
		template += text.slice(cursor, r.start);
		template += `${CODE_STASH_MARK}${parts.length}${CODE_STASH_MARK}`;
		parts.push(text.slice(r.start, r.end));
		cursor = r.end;
	}
	template += text.slice(cursor);
	return { template, parts };
}

/** 把哨兵替换为原代码区内容。 */
function restoreCodeRegions(template: string, parts: readonly string[]): string {
	if (parts.length === 0) { return template; }
	CODE_STASH_RE.lastIndex = 0;
	return template.replace(CODE_STASH_RE, (_m, idx: string) => parts[Number(idx)] ?? '');
}

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
	/<\s*\/?\s*(?:tool_call|tool_result|function_calls?|function_response|function|tool_calls|arg_key|arg_value|tool_use|invoke)\b/i;

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
	if (!text) { return text; }
	// ─── 早退守卫必须同时覆盖「已知标签名」与「<tag:id> 形态」──────────────
	// 原守卫只看 TOOL_CALL_XML_QUICK_RE（标签名白名单），而该白名单**漏了
	// `tool_sep`** —— 日志 1788011997897 实证：`tool_sep:6124c78e` 从未能被剥离，
	// 一路残留进历史并**逐轮累积**（L8944 两条 → L9282 四条），
	// 导致 sanitize 后仍有 600c 残留（原 973c）。
	// 只补 `tool_sep` 仍不解决未知变体，故追加形态判定作为兜底。
	if (!TOOL_CALL_XML_QUICK_RE.test(text) && locateTaggedIdXmlTags(text, 1).length === 0) {
		return text;
	}

	const tagNames = ['tool_call', 'tool_result', 'function_call', 'function_calls', 'function_response', 'function', 'tool_calls', 'tool'];

	// ─── 前置：抠出代码区，使下方**所有**剥离阶段都跳过它 ────────────────
	// 只保护第一道是不够的：下面的按名剥离会连标签**内容**一起删（pairRe 整体
	// 删除 `<tag>...内容...</tag>`），代码块里的示例同样会被抹掉。
	const stash = stashCodeRegions(text, findCodeRegions(text));
	let result = stash.template;

	// ─── 第一道：宽剥离所有 `<tag:id>` 形态（含 tool_sep 与未知变体）────────
	// 逐个枚举标签名永远追不上模型的新变体（`tool_sep` 就是漏掉的那个），
	// 故先按**形态**整体剥离，再走下面的按名剥离处理标准配对标签。
	// replacement 传空串：此处产出的是**展示给用户**的可见文本，
	// 不适合留下 `[已移除]` 之类占位符。
	result = stripTaggedIdXmlTags(result, '');

	// 防御：剥离模型泄漏的冒号ID伪XML标签（<tool_calls:xxx>, <arg_key:xxx>, <arg_value:xxx>）。
	// 这些标签往往不配对（开标签带 :hex 后缀、闭标签不带），普通配对正则无法覆盖，会泄露到UI。
	result = result.replace(/<\/?(?:tool_calls|arg_key|arg_value|tool_call|function_call|function_response|tool_result|tool_use|invoke)[:\w]*>/gi, '');
	// 模型「伪造」工具调用时常写一排方块字符作为分隔(fence)，正常回答几乎不可能
	// 出现整行纯方块字符，剥离之（否则这些 fence 会原样显示在聊天里）。
	result = result.replace(/^[ \t]*(?:[\u2580-\u259F\u25A0])+[ \t]*$/gm, '');

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

	return restoreCodeRegions(result, stash.parts);
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
	// 带冒号ID伪标签形态（<think:6124c78e>...</think:6124c78e>）—— 模型把思考块也写成
	// `:hexid` 形态时，上面两条标准正则匹配不到，必须单独处理，否则原样泄露到 UI。
	result = result.replace(/<\s*think\s*:\s*[\w-]+\s*>[\s\S]*?<\s*\/\s*think\s*:\s*[\w-]+\s*>/gi, '');
	result = result.replace(/<\s*\/?\s*think\s*:\s*[\w-]+\s*>/gi, '');
	return result;
}

// ════════════════════════════════════════════════════════════════════════════════
// § Pipeline — Unified sanitization pipeline
// ════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════
// § Sanitizer Trace —— 定位「哪个阶段误删了正文」
//
// 背景：多个剥离阶段用了锚定文本末尾的正则（`$` 且无 `m` flag），一旦正则
// 误命中正文里的常见词（如 `Action:`、`[TOOL_CALL]`、`<function>`），就会把
// **从这里到文本末尾的所有内容**删掉 —— 表现即用户看到的「消息尾部被截断」。
// 这些误删在 sanitize 前后只表现为总长度变化，无法归因到具体阶段，故加 trace。
//
// 用法：宿主在启动时调 `setSanitizeTraceSink(...)` 把条目转发到 logService；
// 不设置则全程零开销（每个 `_traceStage` 首行即 return）。
// ════════════════════════════════════════════════════════════════════════════════

export interface ISanitizeTraceEntry {
	/** 剥离阶段名（如 'stripReactActions'）。 */
	readonly stage: string;
	/** 使用的 profile。 */
	readonly profile: string;
	/** 阶段前长度。 */
	readonly beforeLen: number;
	/** 阶段后长度。 */
	readonly afterLen: number;
	/** 被删除的字符数（正数=删除，负数=增长）。 */
	readonly removedLen: number;
	/** 首个差异处在本阶段输入中的偏移。 */
	readonly atOffset: number;
	/** 从首个差异处起、本阶段输入的一段原文（用于看出删的是什么）。 */
	readonly removedSnippet: string;
	/** 本阶段输出的尾部（用于判断是否被「删到末尾」）。 */
	readonly afterTail: string;
}

/**
 * 接收器集合（而非单 sink）：`agentTurnExecutor`（host 侧，决定 content_replace 内容）
 * 与 `nativeChatEditorPane`（UI 侧二次清洗）都会调 sanitize，二者都需要 trace。
 * 用数组避免后者覆盖前者。
 */
const _traceSinks: Array<(e: ISanitizeTraceEntry) => void> = [];

/** 安装 trace 接收器（宿主转发到 logService）。返回反安装函数。 */
export function addSanitizeTraceSink(sink: (e: ISanitizeTraceEntry) => void): () => void {
	_traceSinks.push(sink);
	return () => {
		const i = _traceSinks.indexOf(sink);
		if (i >= 0) { _traceSinks.splice(i, 1); }
	};
}

/** 若某阶段删除量超过该占比，视为可疑并额外标记（便于日志筛选）。 */
const SUSPICIOUS_REMOVE_RATIO = 0.3;

function _traceStage(stage: string, profile: string, before: string, after: string): void {
	if (_traceSinks.length === 0 || before === after) { return; }

	// 找首个差异位置
	let i = 0;
	const minLen = Math.min(before.length, after.length);
	while (i < minLen && before[i] === after[i]) { i++; }

	const removedLen = before.length - after.length;
	const removedSnippet = before.slice(i, i + Math.min(Math.max(removedLen, 0) + 60, 240));
	const afterTail = after.length > 80 ? after.slice(-80) : after;

	const entry: ISanitizeTraceEntry = {
		stage,
		profile,
		beforeLen: before.length,
		afterLen: after.length,
		removedLen,
		atOffset: i,
		removedSnippet,
		afterTail,
	};

	// 只上报「删得多」或「从文本前半段就开始删」的阶段，避免正常剥离刷屏。
	if (removedLen > 0 && (removedLen / Math.max(before.length, 1) >= SUSPICIOUS_REMOVE_RATIO || i < before.length * 0.5)) {
		for (const sink of _traceSinks) {
			try { sink(entry); } catch { /* 日志不应影响业务逻辑 */ }
		}
	}
}

/**
 * Apply the full sanitization pipeline with given options.
 */
function applySanitizationPipeline(text: string, options: SanitizerOptions, profile: string = 'delivery'): string {
	if (!text) { return ''; }

	let cleaned = text;

	if (options.stripJsonCodeBlocks) {
		const before = cleaned;
		cleaned = stripJsonCodeBlocks(cleaned);
		_traceStage('stripJsonCodeBlocks', profile, before, cleaned);
	}
	if (options.stripJsonToolCalls) {
		const before = cleaned;
		cleaned = stripJsonToolCalls(cleaned);
		_traceStage('stripJsonToolCalls', profile, before, cleaned);
	}
	if (options.stripXmlToolCallTags) {
		const before = cleaned;
		cleaned = stripXmlToolCallTags(cleaned);
		_traceStage('stripXmlToolCallTags', profile, before, cleaned);
	}
	if (options.stripBracketToolCallBlocks) {
		const before = cleaned;
		cleaned = stripLegacyBracketToolCallBlocks(cleaned);
		_traceStage('stripBracketToolCallBlocks', profile, before, cleaned);
	}
	if (options.stripDowngradedToolCallText) {
		const before = cleaned;
		cleaned = stripDowngradedToolCallText(cleaned);
		_traceStage('stripDowngradedToolCallText', profile, before, cleaned);
	}
	if (options.stripReactActions) {
		const before = cleaned;
		cleaned = stripReactActions(cleaned);
		_traceStage('stripReactActions', profile, before, cleaned);
	}

	// Always strip reasoning tags (not profile-dependent — these should never be visible)
	{
		const before = cleaned;
		cleaned = stripReasoningTags(cleaned);
		_traceStage('stripReasoningTags', profile, before, cleaned);
	}

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
	return applySanitizationPipeline(text, PROFILE_OPTIONS[profile], profile);
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
