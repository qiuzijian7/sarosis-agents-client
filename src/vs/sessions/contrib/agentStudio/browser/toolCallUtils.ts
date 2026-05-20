/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool Call Utilities — borrowed from Hermes-Agent's battle-tested patterns
 * Enhanced with OpenClaw-inspired patterns:
 *  - Multi-format tool call type detection (OpenAI/Anthropic/generic)
 *  - Robust argument coercion (string → object, always returns Record)
 *  - Tool call ID resolution (multiple naming conventions)
 *  - Streaming JSON partial parsing support
 *  - Argument buffer size limits (256KB)
 *
 * This module centralizes all tool-call-related pure functions:
 *  - Tool name repair (multi-level normalization)
 *  - Argument coercion & repair
 *  - Error sanitization
 *  - Tool-call deduplication
 *  - Result size limiting
 *  - Tool call content type detection
 *  - Streaming tool call argument assembly
 */

import type { IToolCallInfo, IToolDefinition } from '../common/providers.js';

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum characters a tool result may contain before truncation */
export const MAX_TOOL_RESULT_CHARS = 100_000;

/** Maximum retries when a model returns invalid tool names */
export const MAX_INVALID_TOOL_RETRIES = 3;

/** Maximum retries when a model returns invalid JSON arguments */
export const MAX_INVALID_ARG_RETRIES = 3;

/** Maximum tool call argument buffer size (256KB) — inspired by OpenClaw */
export const MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES = 256 * 1024;

/** Maximum post-tool-call text buffer (256KB) */
export const MAX_POST_TOOL_CALL_BUFFER_BYTES = 256 * 1024;

// ─── Tool Call Content Type Detection (OpenClaw-inspired) ───────────

/**
 * Check if a type string represents a tool call content block.
 * Supports multiple naming conventions across providers:
 *  - OpenAI: "tool_call"
 *  - Anthropic: "tool_use"
 *  - Generic: "toolcall", "tooluse"
 *
 * @see OpenClaw's `isToolCallContentType` in `src/chat/tool-content.ts`
 */
export function isToolCallContentType(value: string | undefined | null): boolean {
	if (!value) { return false; }
	const normalized = value.toLowerCase().replace(/[_-]/g, '');
	return normalized === 'toolcall' || normalized === 'tooluse';
}

/**
 * Check if a type string represents a tool result content block.
 * Supports: "tool_result", "toolresult"
 */
export function isToolResultContentType(value: string | undefined | null): boolean {
	if (!value) { return false; }
	const normalized = value.toLowerCase().replace(/[_-]/g, '');
	return normalized === 'toolresult';
}

/**
 * Resolve the tool arguments from a content block, supporting multiple field names.
 * Priority: args → arguments → input (covers OpenAI + Anthropic conventions)
 *
 * @see OpenClaw's `resolveToolBlockArgs`
 */
export function resolveToolBlockArgs(block: Record<string, unknown>): unknown {
	return block.args ?? block.arguments ?? block.input ?? undefined;
}

/**
 * Resolve the tool use ID from a content block, supporting multiple field names.
 * Priority: id → tool_use_id → toolUseId → tool_call_id → toolCallId
 *
 * @see OpenClaw's `resolveToolUseId`
 */
export function resolveToolUseId(block: Record<string, unknown>): string | undefined {
	const id = block.id ?? block.tool_use_id ?? block.toolUseId ?? block.tool_call_id ?? block.toolCallId;
	return id ? String(id) : undefined;
}

// ─── Argument Coercion (OpenClaw-inspired) ──────────────────────────

/**
 * Coerce tool call arguments to always return a Record<string, unknown>.
 * Inspired by OpenClaw's `coerceTransportToolCallArguments`:
 *  - If already an object → return as-is
 *  - If a JSON string → parse it
 *  - If parse fails or non-object → return {}
 *
 * This ensures downstream code always receives a consistent object type.
 */
export function coerceToolCallArguments(argumentsValue: unknown): Record<string, unknown> {
	if (argumentsValue === null || argumentsValue === undefined) {
		return {};
	}
	if (typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
		return argumentsValue as Record<string, unknown>;
	}
	if (typeof argumentsValue === 'string') {
		const trimmed = argumentsValue.trim();
		if (!trimmed) { return {}; }
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				return parsed;
			}
		} catch {
			// Try repair before giving up
			const repaired = repairToolArguments(trimmed);
			if (repaired) { return repaired; }
		}
	}
	return {};
}

/**
 * Sanitize text by removing isolated surrogate characters.
 * Inspired by OpenClaw's `sanitizeTransportPayloadText`.
 * Prevents transport errors from incomplete Unicode sequences.
 */
export function sanitizePayloadText(text: string): string {
	// Remove lone surrogates (high surrogates not followed by low, or lone low surrogates)
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

// ─── Tool Name Repair ───────────────────────────────────────────────

/**
 * Common misname mapping — models frequently hallucinate these names.
 * Keys are all lowercase for case-insensitive lookup.
 */
const FUZZY_NAME_MAP: Record<string, string> = {
	// Python stdlib hallucinations
	'os.getcwd': 'terminal',
	'os_getcwd': 'terminal',
	'os.path': 'terminal',
	'getcwd': 'terminal',
	'os.listdir': 'terminal',
	'os.makedirs': 'terminal',
	'os.remove': 'terminal',

	// Unix command hallucinations
	'pwd': 'terminal',
	'ls': 'terminal',
	'cat': 'file_read',
	'mkdir': 'terminal',
	'rm': 'terminal',
	'cp': 'terminal',
	'mv': 'terminal',
	'grep': 'search_files',
	'find': 'search_files',

	// Semantic misnamings
	'read_file': 'file_read',
	'write_file': 'file_write',
	'file_search': 'search_files',
	'execute_command': 'terminal',
	'run_command': 'terminal',
	'shell': 'terminal',
	'bash': 'terminal',
	'command_line': 'terminal',
	'cli': 'terminal',
	'write_to_file': 'file_write',
	'read_from_file': 'file_read',
	'list_directory': 'terminal',
	'create_file': 'file_write',
	'delete_file': 'terminal',
	'web_search': 'search_files',
	'internet_search': 'search_files',
	'code_search': 'search_files',
	'open_file': 'file_read',
	'save_file': 'file_write',
	'edit_file': 'file_write',
	'append_file': 'file_write',
};

/**
 * Multi-level tool name repair — mirrors Hermes-Agent's `_repair_tool_call()`.
 *
 * Strategy (in order):
 *  1. Exact match — name is valid as-is
 *  2. Case-insensitive exact match
 *  3. Fuzzy map lookup (common hallucinations)
 *  4. Normalization: lowercase → hyphens-to-underscores → strip common suffixes
 *  5. Substring containment match
 *
 * Returns the repaired name or undefined if no match found.
 */
export function repairToolName(
	rawName: string,
	validNames: string[],
): string | undefined {
	// 1. Exact match
	if (validNames.includes(rawName)) {
		return rawName;
	}

	// 2. Case-insensitive exact match
	const lowerName = rawName.toLowerCase();
	const ciMatch = validNames.find(n => n.toLowerCase() === lowerName);
	if (ciMatch) {
		return ciMatch;
	}

	// 3. Fuzzy map lookup
	const fuzzyMapped = FUZZY_NAME_MAP[lowerName];
	if (fuzzyMapped && validNames.includes(fuzzyMapped)) {
		return fuzzyMapped;
	}

	// 4. Normalization: lowercase, hyphens → underscores, strip suffixes
	const normalized = lowerName
		.replace(/-/g, '_')
		.replace(/_tool$/, '')
		.replace(/_function$/, '')
		.replace(/_action$/, '')
		.replace(/^tool_/, '');
	const normMatch = validNames.find(n => n.toLowerCase().replace(/-/g, '_') === normalized);
	if (normMatch) {
		return normMatch;
	}

	// 5. Substring containment — only if exactly one candidate matches
	const containedBy = validNames.filter(n => n.toLowerCase().includes(lowerName));
	if (containedBy.length === 1) {
		return containedBy[0];
	}
	const contains = validNames.filter(n => lowerName.includes(n.toLowerCase()));
	if (contains.length === 1) {
		return contains[0];
	}

	return undefined;
}

// ─── Argument Coercion & Repair ─────────────────────────────────────

/**
 * Coerce tool arguments to match the expected schema types.
 * Borrowed from Hermes-Agent's `coerce_tool_args()`.
 *
 * - String numbers like "42" → number (when schema declares integer/number)
 * - String booleans like "true" → boolean
 * - JSON string values for array/object types → parsed
 * - Bare scalar values wrapped into array (when schema declares array)
 */
export function coerceToolArgs(
	args: Record<string, unknown>,
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
	if (!props) {
		return args;
	}

	const result = { ...args };

	for (const [key, propSchema] of Object.entries(props)) {
		if (!(key in result)) {
			continue;
		}
		const value = result[key];
		const expectedType = propSchema.type as string | undefined;

		if (expectedType === 'integer' || expectedType === 'number') {
			if (typeof value === 'string') {
				const num = Number(value);
				if (!isNaN(num)) {
					result[key] = num;
				}
			}
		} else if (expectedType === 'boolean') {
			if (typeof value === 'string') {
				if (value.toLowerCase() === 'true') {
					result[key] = true;
				} else if (value.toLowerCase() === 'false') {
					result[key] = false;
				}
			}
		} else if (expectedType === 'array') {
			if (typeof value === 'string') {
				try {
					const parsed = JSON.parse(value);
					if (Array.isArray(parsed)) {
						result[key] = parsed;
					}
				} catch {
					// Not valid JSON array string — wrap as single-element array
					result[key] = [value];
				}
			} else if (value !== null && value !== undefined && !Array.isArray(value)) {
				result[key] = [value];
			}
		} else if (expectedType === 'object') {
			if (typeof value === 'string') {
				try {
					const parsed = JSON.parse(value);
					if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
						result[key] = parsed;
					}
				} catch {
					// Not valid JSON — leave as string
				}
			}
		}
	}

	return result;
}

/**
 * Try to repair malformed JSON arguments from model output.
 *
 * Handles common issues:
 *  - Empty/whitespace → `{}`
 *  - Trailing commas
 *  - Single quotes instead of double quotes
 *  - Python None → null
 *  - Python True/False → true/false
 *  - Truncated JSON (missing closing brackets)
 *  - Unquoted keys
 *
 * Returns the parsed object or undefined if unrepairable.
 */
export function repairToolArguments(raw: string): Record<string, unknown> | undefined {
	// Empty/whitespace
	const trimmed = raw.trim();
	if (!trimmed) {
		return {};
	}

	// Quick valid parse
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed === 'object' && parsed !== null) {
			return parsed;
		}
		return undefined;
	} catch {
		// Continue to repair attempts
	}

	// Truncation detection: if the string doesn't end with } or ], it's likely truncated
	if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
		// Try to auto-close — simple heuristic: count open/close brackets
		let openBraces = 0;
		let openBrackets = 0;
		for (const ch of trimmed) {
			if (ch === '{') { openBraces++; }
			else if (ch === '}') { openBraces--; }
			else if (ch === '[') { openBrackets++; }
			else if (ch === ']') { openBrackets--; }
		}
		let repaired = trimmed;
		while (openBrackets > 0) { repaired += ']'; openBrackets--; }
		while (openBraces > 0) { repaired += '}'; openBraces--; }

		try {
			const parsed = JSON.parse(repaired);
			if (typeof parsed === 'object' && parsed !== null) {
				return parsed;
			}
		} catch {
			// Truncation too severe — not recoverable
			return undefined;
		}
	}

	// Python-style fixes
	let fixed = trimmed
		.replace(/,\s*([}\]])/g, '$1')           // trailing commas
		.replace(/'/g, '"')                        // single → double quotes
		.replace(/\bNone\b/g, 'null')              // Python None
		.replace(/\bTrue\b/g, 'true')              // Python True
		.replace(/\bFalse\b/g, 'false');           // Python False

	try {
		const parsed = JSON.parse(fixed);
		if (typeof parsed === 'object' && parsed !== null) {
			return parsed;
		}
	} catch {
		// Continue
	}

	// Last resort: try to find the outermost { } block
	const startIdx = fixed.indexOf('{');
	const endIdx = fixed.lastIndexOf('}');
	if (startIdx !== -1 && endIdx > startIdx) {
		try {
			const parsed = JSON.parse(fixed.substring(startIdx, endIdx + 1));
			if (typeof parsed === 'object' && parsed !== null) {
				return parsed;
			}
		} catch {
			// Give up
		}
	}

	return undefined;
}

// ─── Error Sanitization ─────────────────────────────────────────────

/** Patterns to strip from error messages before feeding back to the model */
const ERROR_SANITIZE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
	// XML role tags that could pollute model context
	{ pattern: /<\/?(?:assistant|user|system|tool)>/gi, replacement: '' },
	// Excessive stack traces — keep first 3 lines
	{ pattern: /(\n\s+at .+){3,}/g, replacement: '\n  ...' },
	// File system paths with user home
	{ pattern: /(C:\\Users\\|\/home\/|\/Users\/)[^\s"'`]+/gi, replacement: '<path>' },
	// Long hex strings (hashes, IDs)
	{ pattern: /[0-9a-f]{32,}/gi, replacement: '<hash>' },
];

/**
 * Sanitize a tool error message before returning it to the model context.
 * Borrowed from Hermes-Agent's `_sanitize_tool_error()`.
 *
 * Prevents structural tokens, sensitive paths, or excessively long
 * error messages from polluting the model's context window.
 */
export function sanitizeToolError(error: unknown): string {
	let msg = error instanceof Error ? error.message : String(error);

	// Truncate if too long
	if (msg.length > 4000) {
		msg = msg.substring(0, 3900) + '\n... [truncated]';
	}

	for (const { pattern, replacement } of ERROR_SANITIZE_PATTERNS) {
		msg = msg.replace(pattern, replacement);
	}

	return msg;
}

// ─── Tool-Call Deduplication ────────────────────────────────────────

/**
 * Deduplicate tool calls that have the same name and arguments.
 * Models sometimes emit duplicate tool calls in a single response.
 * Borrowed from Hermes-Agent's `_deduplicate_tool_calls()`.
 */
export function deduplicateToolCalls(calls: IToolCallInfo[]): IToolCallInfo[] {
	const seen = new Set<string>();
	return calls.filter(tc => {
		const key = `${tc.name}::${tc.arguments}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

// ─── Result Size Limiting ───────────────────────────────────────────

/**
 * Truncate a tool result string to the maximum allowed size.
 * Borrowed from Hermes-Agent's `max_result_size_chars` concept.
 */
export function limitToolResultSize(
	content: string,
	maxChars: number = MAX_TOOL_RESULT_CHARS,
): string {
	if (content.length <= maxChars) {
		return content;
	}
	const truncated = content.substring(0, maxChars);
	const lastNewline = truncated.lastIndexOf('\n');
	const cutPoint = lastNewline > maxChars * 0.8 ? lastNewline : maxChars;
	return content.substring(0, cutPoint)
		+ `\n\n... [Result truncated: ${content.length} → ${cutPoint} chars]`;
}

// ─── Tool Result Formatting ─────────────────────────────────────────

/**
 * Format a tool error result in a standard shape that guides the model
 * toward self-correction.
 */
export function formatToolErrorResult(
	toolName: string,
	error: string,
	availableTools?: string[],
): Record<string, unknown> {
	const result: Record<string, unknown> = {
		error: `Tool "${toolName}" failed: ${error}`,
	};
	if (availableTools && availableTools.length > 0) {
		result.available_tools = availableTools;
		result.suggestion = 'Please use one of the available tool names listed above.';
	}
	return result;
}

/**
 * Format a "tool not found" error result with guidance.
 */
export function formatToolNotFoundResult(
	requestedName: string,
	attemptedRepair: string | undefined,
	availableTools: string[],
): Record<string, unknown> {
	const repairNote = attemptedRepair
		? ` (also tried repaired name "${attemptedRepair}")`
		: '';
	return {
		error: `Tool "${requestedName}" does not exist${repairNote}. Available tools: ${availableTools.join(', ')}.`,
		suggestion: 'Please use one of the available tool names listed above.',
	};
}

// ─── Validation Helpers ─────────────────────────────────────────────

/**
 * Check whether a tool call's arguments string is valid JSON (or repairable).
 * Returns a classification for retry decision-making.
 */
export function classifyArgumentValidity(raw: string): 'valid' | 'empty' | 'repairable' | 'truncated' | 'invalid' {
	if (!raw || !raw.trim()) {
		return 'empty';
	}
	try {
		JSON.parse(raw.trim());
		return 'valid';
	} catch {
		// Continue classification
	}

	const trimmed = raw.trim();

	// Truncation: doesn't end with } or ] and looks like it started an object
	if (trimmed.startsWith('{') && !trimmed.endsWith('}') && !trimmed.endsWith(']')) {
		return 'truncated';
	}

	// Try repair
	const repaired = repairToolArguments(raw);
	if (repaired !== undefined) {
		return 'repairable';
	}

	return 'invalid';
}

/**
 * Build a lookup set of valid tool names from tool definitions.
 */
export function buildValidToolNameSet(tools: IToolDefinition[]): Set<string> {
	return new Set(tools.map(t => t.name));
}

/**
 * Build a name → schema map for argument coercion.
 */
export function buildToolSchemaMap(tools: IToolDefinition[]): Map<string, Record<string, unknown>> {
	const map = new Map<string, Record<string, unknown>>();
	for (const t of tools) {
		map.set(t.name, t.inputSchema);
	}
	return map;
}

// ─── Parallel Execution Helpers ─────────────────────────────────────

/** Maximum concurrent tool execution threads */
export const MAX_TOOL_WORKERS = 8;

/**
 * Tool names that should NEVER be parallelized — they are interactive
 * or have side effects that depend on conversation state.
 */
const NEVER_PARALLEL_TOOLS = new Set([
	'clarify', 'delegate_task', 'memory', 'todo',
]);

/**
 * Determine whether a batch of tool calls can be safely executed in parallel.
 * Borrowed from Hermes-Agent's `_should_parallelize_tool_batch()`.
 *
 * Rules:
 *  - Any call to a NEVER_PARALLEL tool → serial
 *  - All calls are SAFE_PARALLEL → parallel
 *  - Mixed write tools with overlapping paths → serial
 *  - Otherwise → parallel (conservative default)
 */
export function shouldParallelizeToolBatch(calls: IToolCallInfo[]): boolean {
	if (calls.length <= 1) {
		return false; // No need for parallelism
	}

	// Check for never-parallel tools
	for (const tc of calls) {
		if (NEVER_PARALLEL_TOOLS.has(tc.name)) {
			return false;
		}
	}

	// Check for write-like tools — if any two write to overlapping paths, serial
	const writeLikeNames = new Set(['file_write', 'edit_file', 'patch', 'create_file', 'delete_file']);
	const writeCalls = calls.filter(tc => writeLikeNames.has(tc.name));
	if (writeCalls.length > 1) {
		// Extract paths from arguments and check for overlap
		const paths: string[] = [];
		for (const tc of writeCalls) {
			try {
				const args = JSON.parse(tc.arguments || '{}');
				if (args.path) { paths.push(String(args.path)); }
				if (args.file) { paths.push(String(args.file)); }
			} catch { /* ignore */ }
		}
		// If any two paths overlap (one is a prefix of the other), go serial
		for (let i = 0; i < paths.length; i++) {
			for (let j = i + 1; j < paths.length; j++) {
				if (paths[i].startsWith(paths[j]) || paths[j].startsWith(paths[i])) {
					return false;
				}
			}
		}
	}

	return true;
}

// ─── Streaming Tool Call Assembly (OpenClaw-inspired) ────────────────

/**
 * Streaming tool call assembler — accumulates incremental argument chunks
 * and provides partial parsing, size limits, and finalization.
 *
 * Inspired by OpenClaw's streaming tool call management in
 * `openai-transport-stream.ts` which handles:
 *  - Incremental argument JSON accumulation
 *  - Partial JSON parsing for UI preview
 *  - Buffer size limits (256KB)
 *  - Graceful finalization with fallback
 */
export class StreamingToolCallAssembler {
	private _id = '';
	private _name = '';
	private _argsBuffer = '';
	private _finalized = false;

	get id(): string { return this._id; }
	get name(): string { return this._name; }
	get partialArgs(): string { return this._argsBuffer; }
	get isFinalized(): boolean { return this._finalized; }

	/**
	 * Start a new tool call. Resets internal state.
	 */
	start(id: string, name: string, initialArgs?: string): void {
		this._id = id;
		this._name = name;
		this._argsBuffer = initialArgs || '';
		this._finalized = false;
	}

	/**
	 * Append an argument chunk. Returns false if buffer limit exceeded.
	 */
	appendArgs(chunk: string): boolean {
		if (this._finalized) { return false; }
		if (this._argsBuffer.length + chunk.length > MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES) {
			return false; // Buffer overflow — reject
		}
		this._argsBuffer += chunk;
		return true;
	}

	/**
	 * Try to parse the current partial JSON for UI preview.
	 * Uses best-effort partial parsing (auto-close brackets).
	 */
	tryParsePartial(): Record<string, unknown> | null {
		if (!this._argsBuffer.trim()) { return null; }
		return parsePartialJson(this._argsBuffer);
	}

	/**
	 * Finalize and return the complete tool call info.
	 * Attempts full JSON parse, falls back to repair, then raw string.
	 */
	finalize(): IToolCallInfo {
		this._finalized = true;
		let args = this._argsBuffer;

		// Try parsing to validate
		try {
			JSON.parse(args);
		} catch {
			// Try repair
			const repaired = repairToolArguments(args);
			if (repaired) {
				args = JSON.stringify(repaired);
			}
			// Otherwise keep raw — downstream will handle
		}

		return {
			id: this._id,
			name: this._name,
			arguments: args,
		};
	}

	/**
	 * Whether a tool call is currently being assembled.
	 */
	get isActive(): boolean {
		return !!this._name && !this._finalized;
	}

	/**
	 * Reset to empty state.
	 */
	reset(): void {
		this._id = '';
		this._name = '';
		this._argsBuffer = '';
		this._finalized = false;
	}
}

// ─── Partial JSON Parsing (OpenClaw-inspired) ───────────────────────

/**
 * Parse a potentially incomplete JSON string by auto-closing brackets.
 * Inspired by OpenClaw's usage of `parseStreamingJson()` from `pi-ai`.
 *
 * This allows the UI to show partial tool call arguments while the model
 * is still streaming them. Returns null if the string is too malformed.
 */
export function parsePartialJson(partial: string): Record<string, unknown> | null {
	const trimmed = partial.trim();
	if (!trimmed) { return null; }

	// Already valid?
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed;
		}
		return null;
	} catch {
		// Continue to auto-close attempts
	}

	// Must start with { to be an object
	if (!trimmed.startsWith('{')) { return null; }

	// Strategy: progressively try to close the JSON
	// 1. Remove trailing comma if any
	let candidate = trimmed.replace(/,\s*$/, '');

	// 2. If we're in the middle of a string value, try to close it
	//    Count unescaped quotes
	let inString = false;
	for (let i = 0; i < candidate.length; i++) {
		const ch = candidate[i];
		if (ch === '\\' && inString) { i++; continue; } // skip escaped
		if (ch === '"') { inString = !inString; }
	}

	// If we ended inside a string, close it
	if (inString) {
		candidate += '"';
	}

	// 3. Count unclosed brackets and close them
	let openBraces = 0;
	let openBrackets = 0;
	let inStr = false;
	for (let i = 0; i < candidate.length; i++) {
		const ch = candidate[i];
		if (ch === '\\' && inStr) { i++; continue; }
		if (ch === '"') { inStr = !inStr; continue; }
		if (inStr) { continue; }
		if (ch === '{') { openBraces++; }
		else if (ch === '}') { openBraces--; }
		else if (ch === '[') { openBrackets++; }
		else if (ch === ']') { openBrackets--; }
	}

	// Remove trailing colon or comma (incomplete key-value)
	candidate = candidate.replace(/[,:]\s*$/, '');

	while (openBrackets > 0) { candidate += ']'; openBrackets--; }
	while (openBraces > 0) { candidate += '}'; openBraces--; }

	try {
		const parsed = JSON.parse(candidate);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed;
		}
	} catch {
		// Too malformed
	}

	return null;
}

// ─── Format Tool Output (OpenClaw-inspired) ─────────────────────────

/** Maximum tool output display chars before truncation in UI */
export const MAX_TOOL_OUTPUT_DISPLAY_CHARS = 120_000;

/**
 * Format tool output for display. Attempts JSON pretty-print,
 * falls back to raw text. Truncates if too long.
 *
 * Inspired by OpenClaw's `formatToolOutput` in `app-tool-stream.ts`.
 */
export function formatToolOutputForDisplay(output: string, maxChars: number = MAX_TOOL_OUTPUT_DISPLAY_CHARS): string {
	if (!output) { return '(no output)'; }

	let formatted = output;

	// Try to pretty-print if it looks like JSON
	const trimmed = output.trim();
	if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
		(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
		try {
			const parsed = JSON.parse(trimmed);
			formatted = JSON.stringify(parsed, null, 2);
		} catch {
			// Keep as-is
		}
	}

	// Truncate if needed
	if (formatted.length > maxChars) {
		formatted = formatted.substring(0, maxChars) + '\n\n... [output truncated]';
	}

	return formatted;
}
