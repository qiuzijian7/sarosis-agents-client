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

import type { IToolCallInfo, IToolDefinition } from "../common/providers.js";

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
export function isToolCallContentType(
	value: string | undefined | null,
): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.toLowerCase().replace(/[_-]/g, "");
	return normalized === "toolcall" || normalized === "tooluse";
}

/**
 * Check if a type string represents a tool result content block.
 * Supports: "tool_result", "toolresult"
 */
export function isToolResultContentType(
	value: string | undefined | null,
): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.toLowerCase().replace(/[_-]/g, "");
	return normalized === "toolresult";
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
export function resolveToolUseId(
	block: Record<string, unknown>,
): string | undefined {
	const id =
		block.id ??
		block.tool_use_id ??
		block.toolUseId ??
		block.tool_call_id ??
		block.toolCallId;
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
export function coerceToolCallArguments(
	argumentsValue: unknown,
): Record<string, unknown> {
	if (argumentsValue === null || argumentsValue === undefined) {
		return {};
	}
	if (typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
		return argumentsValue as Record<string, unknown>;
	}
	if (typeof argumentsValue === "string") {
		const trimmed = argumentsValue.trim();
		if (!trimmed) {
			return {};
		}
		try {
			const parsed = JSON.parse(trimmed);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				return parsed;
			}
		} catch {
			// Try repair before giving up
			const repaired = repairToolArguments(trimmed);
			if (repaired) {
				return repaired;
			}
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
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"\uFFFD",
	);
}

// ─── Tool Name Repair ───────────────────────────────────────────────

/**
 * Common misname mapping — models frequently hallucinate these names.
 * Keys are all lowercase for case-insensitive lookup.
 */
const FUZZY_NAME_MAP: Record<string, string> = {
	// Python stdlib hallucinations
	"os.getcwd": "terminal",
	os_getcwd: "terminal",
	"os.path": "terminal",
	getcwd: "terminal",
	"os.listdir": "terminal",
	"os.makedirs": "terminal",
	"os.remove": "terminal",

	// Unix command hallucinations
	pwd: "terminal",
	ls: "terminal",
	cat: "file_read",
	mkdir: "terminal",
	rm: "terminal",
	cp: "terminal",
	mv: "terminal",
	grep: "search_code",
	find: "search_files",

	// Task/planning hallucinations — these are "phantom" tool names that the LLM
	// generates as UI indicators (e.g., showing "任务规划中" in the chat).
	// They have render_type="None" and default_show=false, meaning they should
	// NOT be executed as real tools. Do NOT map them to "todo" or any other real tool.
	// Mapping them to "todo" causes the bundled stub handler to return
	// "not yet implemented natively", which confuses the LLM and derails the conversation.
	//
	// REMOVED mappings (were causing Bug: task_planning → todo loop):
	//   task_planning: "todo", taskplanning: "todo", plan_task: "todo",
	//   plan_tasks: "todo", task_plan: "todo", planning: "todo",
	//
	// These names will now fall through to the "tool not found" path, which
	// returns a proper error with available tool names — much better than the
	// confusing "not yet implemented" stub response.

	// Semantic misnamings
	read_file: "file_read",
	write_file: "file_write",
	file_search: "search_files",
	execute_command: "terminal",
	run_command: "terminal",
	shell: "terminal",
	bash: "terminal",
	command_line: "terminal",
	cli: "terminal",
	write_to_file: "file_write",
	read_from_file: "file_read",
	list_directory: "terminal",
	create_file: "file_write",
	delete_file: "terminal",
	web_search: "search_files",
	internet_search: "search_files",
	code_search: "search_files",
	open_file: "file_read",
	save_file: "file_write",
	edit_file: "file_write",
	append_file: "file_write",
};

// ─── Phantom Tool Names ──────────────────────────────────────

/**
 * Tool names that are phantom / UI-indicator tools (render_type="none").
 * These tools signal a state change (e.g., "planning in progress") but
 * should NOT be rendered as visible tool-call cards in the chat UI.
 * The Knot server may not always send the correct render_type in its
 * _meta, so we maintain this client-side canonical list.
 */
export const PHANTOM_TOOL_NAMES = new Set([
	'task_planning',
	'taskplanning',
	'plan_task',
	'plan_tasks',
	'task_plan',
	'planning',
	'taskplan',
]);

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
	const ciMatch = validNames.find((n) => n.toLowerCase() === lowerName);
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
		.replace(/-/g, "_")
		.replace(/_tool$/, "")
		.replace(/_function$/, "")
		.replace(/_action$/, "")
		.replace(/^tool_/, "");
	const normMatch = validNames.find(
		(n) => n.toLowerCase().replace(/-/g, "_") === normalized,
	);
	if (normMatch) {
		return normMatch;
	}

	// 4.5. camelCase → snake_case + MCP prefix stripping
	// Handles LLM hallucinations like "indexRepository" → "index_repository"
	// matching against MCP tools like "mcp_config_*__index_repository"
	const snakeCase = rawName
		.replace(/([A-Z])/g, "_$1")
		.toLowerCase()
		.replace(/^_/, "");
	const mcpShortMatch = validNames.find((n) => {
		// Strip "mcp_config_*__" prefix to get short name
		const shortName = n.includes("__") ? n.split("__").pop()!.toLowerCase() : n.toLowerCase();
		return shortName === snakeCase;
	});
	if (mcpShortMatch) {
		return mcpShortMatch;
	}

	// 4.6. Partial keyword matching for MCP tools
	// Handles "indexWorkspace" → matches "index" in "index_repository"
	if (snakeCase.includes("_")) {
		const firstWord = snakeCase.split("_")[0];
		const keywordMatch = validNames.filter((n) => {
			const shortName = n.includes("__") ? n.split("__").pop()!.toLowerCase() : n.toLowerCase();
			return shortName.startsWith(firstWord);
		});
		if (keywordMatch.length === 1) {
			return keywordMatch[0];
		}
	}

	// 5. Substring containment — only if exactly one candidate matches
	// 参考 Hermes：fuzzy match 使用 cutoff=0.7，substring 太宽松容易误匹配。
	// 添加最小长度限制（≥4 chars）防止 "Task"→"delegate_task" 等短名误匹配。
	const MIN_SUBSTR_LENGTH = 4;
	if (lowerName.length >= MIN_SUBSTR_LENGTH) {
		const containedBy = validNames.filter((n) =>
			n.toLowerCase().includes(lowerName),
		);
		if (containedBy.length === 1) {
			return containedBy[0];
		}
	}
	if (lowerName.length >= MIN_SUBSTR_LENGTH) {
		const contains = validNames.filter((n) => {
			const nl = n.toLowerCase();
			return nl.length >= MIN_SUBSTR_LENGTH && lowerName.includes(nl);
		});
		if (contains.length === 1) {
			return contains[0];
		}
	}

	// 6. Fuzzy match (difflib equivalent) — last resort
	// 参考 Hermes repair_tool_call 的 get_close_matches(lowered, valid_tool_names, n=1, cutoff=0.7)
	// 使用 Levenshtein 距离的简化版：相似度 ≥ 0.7 时匹配
	const fuzzyMatch = validNames.find((n) => {
		const nl = n.toLowerCase();
		if (nl.length < 3 || lowerName.length < 3) { return false; }
		const maxLen = Math.max(nl.length, lowerName.length);
		const dist = _levenshtein(lowerName, nl);
		const similarity = 1 - dist / maxLen;
		return similarity >= 0.7;
	});
	if (fuzzyMatch) {
		return fuzzyMatch;
	}

	return undefined;
}

/**
 * Levenshtein 距离 — 参考 Hermes 的 difflib.get_close_matches。
 * 用于 fuzzy match 的最后手段。
 */
function _levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) { return n; }
	if (n === 0) { return m; }
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) { dp[i][0] = i; }
	for (let j = 0; j <= n; j++) { dp[0][j] = j; }
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1,
				dp[i][j - 1] + 1,
				dp[i - 1][j - 1] + cost,
			);
		}
	}
	return dp[m][n];
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
	const props = schema.properties as
		| Record<string, Record<string, unknown>>
		| undefined;
	if (!props) {
		return args;
	}

	const result = { ...args };

	for (const [key, propSchema] of Object.entries(props)) {
		if (!(key in result)) {
			continue;
		}
		// P2a: oneOf/anyOf 降级 —— schema 无 type 但有 oneOf/anyOf 时，取第一个分支
		// 的 schema 作为有效 schema。LLM 常把 union 写成 oneOf，取首分支是最小惊讶降级。
		let effectiveSchema = propSchema;
		if (!effectiveSchema.type) {
			const branches = (effectiveSchema.oneOf ?? effectiveSchema.anyOf) as Record<string, unknown>[] | undefined;
			if (Array.isArray(branches) && branches.length > 0) {
				effectiveSchema = branches[0] as Record<string, unknown>;
			}
		}
		const value = result[key];
		const expectedType = effectiveSchema.type as string | undefined;

		if (expectedType === "integer" || expectedType === "number") {
			if (typeof value === "string") {
				const num = Number(value);
				if (!isNaN(num)) {
					result[key] = num;
				}
			}
		} else if (expectedType === "boolean") {
			if (typeof value === "string") {
				if (value.toLowerCase() === "true") {
					result[key] = true;
				} else if (value.toLowerCase() === "false") {
					result[key] = false;
				}
			}
		} else if (expectedType === "array") {
			if (typeof value === "string") {
				try {
					const parsed = JSON.parse(value);
					if (Array.isArray(parsed)) {
						result[key] = parsed;
					}
				} catch {
					// Not valid JSON array string — wrap as single-element array
					result[key] = [value];
				}
			} else if (
				value !== null &&
				value !== undefined &&
				!Array.isArray(value)
			) {
				result[key] = [value];
			}
		} else if (expectedType === "object") {
			if (typeof value === "string") {
				try {
					const parsed = JSON.parse(value);
					if (
						typeof parsed === "object" &&
						parsed !== null &&
						!Array.isArray(parsed)
					) {
						result[key] = parsed;
					}
				} catch {
					// Not valid JSON — leave as string
				}
			}
			// P2a: 嵌套 object 递归强转 —— 当 object property 自身有 properties 时，
			// 递归强转其子字段（之前只处理顶层，嵌套对象的类型不匹配被静默忽略）。
			const nestedProps = effectiveSchema.properties as Record<string, Record<string, unknown>> | undefined;
			if (nestedProps && typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])) {
				result[key] = coerceToolArgs(result[key] as Record<string, unknown>, effectiveSchema);
			}
		}

		// P2a: enum 校验 —— schema 声明了 enum 但值不在合法集合内时，降级到第一个
		// 合法值。LLM 常传近似的枚举值（如 "Scout" vs "scout"）；降级首值是保守自愈，
		// 避免 handler 收到非法值后失败重试浪费 token。放在类型强转之后以检查强转后的值。
		const enumValues = effectiveSchema.enum as unknown[] | undefined;
		if (Array.isArray(enumValues) && enumValues.length > 0 && !enumValues.includes(result[key])) {
			result[key] = enumValues[0];
		}
	}

	return result;
}

/**
 * Enhanced argument coercion with diagnostics — wraps coerceToolArgs.
 *
 * Extends the existing coercion with:
 *   - Before/after diff detection (what was coerced and why)
 *   - Missing required field detection
 *   - Unknown extra argument detection
 *   - Structured warnings suitable for logging
 *
 * Follows the same pattern as Continue's coerceArgsToSchema but integrated
 * into the existing Hermes-Agent tool execution pipeline.
 *
 * @returns Coerced args + human-readable warning strings
 */
export interface CoerceArgsResult {
	args: Record<string, unknown>;
	warnings: string[];
	/** Required schema fields that are absent from args — caller should reject the call early. */
	missingRequired?: string[];
}

export function coerceArgsToSchema(
	args: Record<string, unknown>,
	schema: Record<string, unknown> | undefined,
): CoerceArgsResult {
	const warnings: string[] = [];

	if (!schema) {
		return { args, warnings };
	}

	// P0（2026-08-27，日志 1787842234483）：模型 codebuddy/hy4-dev 偶发把工具参数裹进
	// 非标准 `raw_arguments` 字符串字段（而非扁平 JSON），例如
	//   {"raw_arguments":"{\"path\":\"g:\\...\\x.ts\",\"offset\":580,\"limit\":110}"}
	// 或破损混合形态 {"raw_arguments":"{\"path\":\"...\"}", "offset":580, "limit":110}。
	// 必填参数（如 file_read 的 path）因此沉到字符串内 → 顶层缺失 → 被 coerceOrReject 拒掉，
	// 模型反复重试同一错误工具（见迭代 1/2 的 "missing required args [path]"）。
	// 兜底：若 args.raw_arguments 是 JSON 字符串，解析其内联参数并合并到顶层（仅补缺失键，
	// 不覆盖已正确的顶层字段），随后删除该非标准键，交回正常 schema 校验流程。
	const RAW_ARGS_KEY = 'raw_arguments';
	if (typeof (args as Record<string, unknown>)[RAW_ARGS_KEY] === 'string') {
		try {
			const inner = JSON.parse((args as Record<string, unknown>)[RAW_ARGS_KEY] as string);
			if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
				for (const k of Object.keys(inner)) {
					if (!(k in args)) { (args as Record<string, unknown>)[k] = inner[k]; }
				}
			}
			delete (args as Record<string, unknown>)[RAW_ARGS_KEY];
			warnings.push(`unwrapped non-standard "raw_arguments" wrapper into top-level args`);
		} catch {
			// 解析失败则原样保留，交给后续校验报缺失（避免吞掉真实错误）
		}
	}

	// Snapshot before coercion
	const beforeKeys = Object.keys(args);
	const beforeSnap: Record<string, { type: string; json: string }> = {};
	for (const k of beforeKeys) {
		beforeSnap[k] = { type: typeof args[k], json: JSON.stringify(args[k]) };
	}

	// Apply existing coercion
	const coerced = coerceToolArgs(args, schema);

	// Detect what changed
	for (const k of beforeKeys) {
		const before = beforeSnap[k];
		if (!before) { continue; }
		const after = coerced[k];
		const afterType = typeof after;
		const afterJson = JSON.stringify(after);

		if (afterType !== before.type || afterJson !== before.json) {
			warnings.push(
				`coerced argument "${k}": ${before.type} → ${afterType}` +
				(before.json.length <= 80 ? ` (${before.json} → ${afterJson})` : '')
			);
		}
	}

	// Check for extra args not in schema (LLM sometimes adds spurious fields)
	const props = (schema as Record<string, unknown>).properties as Record<string, unknown> | undefined;

	// P2（2026-07-29，对齐 kimi zod-only 契约）：别名解析已移除。schema 是唯一
	// 契约——模型发错参数名即按 missing/unknown 处理并拒绝（带正确参数名），
	// 不再从 description 文本反向解析 "accepts alias" 建立别名映射（三层别名
	// 防御的复杂度源头；旧会话的别名恢复 handler 层同步移除）。

	// Check for missing required fields (plain containment — no alias awareness).
	const required = (schema as Record<string, unknown>).required as string[] | undefined;
	const missingRequired: string[] = [];
	if (required && Array.isArray(required)) {
		for (const req of required) {
			if (!(req in (coerced as Record<string, unknown>))) {
				warnings.push(`missing required argument: "${req}" — tool may fail`);
				missingRequired.push(req);
			}
		}
	}

	if (props && typeof props === 'object') {
		for (const k of Object.keys(coerced)) {
			// A key is "unknown" when it is neither a declared property nor an
			// underscore-prefixed internal field.
			if (!(k in props) && !k.startsWith('_')) {
				warnings.push(`unknown argument: "${k}" — not in schema, may be ignored`);
			}
		}
	}

	return { args: coerced, warnings, ...(missingRequired.length > 0 ? { missingRequired } : {}) };
}

/**
 * P2a: 统一的 coerce + 拒绝入口，消除 agentOSService 两处复制粘贴的
 * coerce→log→missingRequired 拒绝模式。返回 { args, reject } —— reject 非空时
 * 调用方应跳过 handler 执行并返回拒绝结果。
 *
 * 零依赖：纯函数，委托到 coerceArgsToSchema（已含 enum/oneOf/嵌套递归自愈）。
 */
export interface CoerceOrRejectResult {
	args: Record<string, unknown>;
	/** 非空时调用方应跳过 handler 执行，直接返回此拒绝结果。 */
	reject?: { content: { error: string }; success: false };
	/** schema 违规类警告（unknown argument / 超长截断等），供调用方附到工具结果回传模型。 */
	warnings?: string[];
}

export function coerceOrReject(
	args: Record<string, unknown>,
	schema: Record<string, unknown> | undefined,
	toolName: string,
	log: { warn(msg: string): void; info(msg: string): void },
): CoerceOrRejectResult {
	if (!schema) { return { args }; }
	const coerced = coerceArgsToSchema(args, schema);
	// 2026-07-29：区分无害类型自愈（string→array/number/boolean）与 schema 违规。
	// 类型自愈是 by-design（coerceToolArgs 中的自动包装/转换），降级 INFO 减少 WARN 噪音。
	const SCHEMA_ISSUE_RE = /^(?:unknown argument|missing required):/;
	for (const w of coerced.warnings) {
		if (SCHEMA_ISSUE_RE.test(w)) {
			log.warn(`[AgentOS][Coerce] "${toolName}" — ${w}`);
		} else {
			log.info(`[AgentOS][Coerce] "${toolName}" — type auto-fix: ${w}`);
		}
	}
	if (coerced.missingRequired && coerced.missingRequired.length > 0) {
		const missList = coerced.missingRequired.join(', ');
		log.info(`[AgentOS] Tool "${toolName}" rejected early: missing required args [${missList}]`);
		return {
			args: coerced.args,
			reject: {
				content: { error: `Missing required arguments for "${toolName}": ${missList}. Provide these arguments to retry.` },
				success: false,
			},
		};
	}
	// P0（2026-08-18，日志 1787038807642）：schema 违规警告（unknown argument）此前仅打
	// 日志——模型传错参数名（如 search_code 的 `path`，schema 实为 `path_filter`）被静默
	// 忽略，本想缩小范围却退化为全库扫描（60s×6 超时）且反复犯错。回传给调用方，
	// 由其附到工具结果（见 annotateCoerceWarnings）让模型一次纠对。
	const schemaWarnings = coerced.warnings.filter(w => SCHEMA_ISSUE_RE.test(w));
	return { args: coerced.args, ...(schemaWarnings.length > 0 ? { warnings: schemaWarnings } : {}) };
}

/**
 * 把 coerce 的 schema 违规警告附到工具结果内容上（回传给模型自我纠正）。
 * 注入形态：字符串前缀 / 普通对象加 `_argWarning` 字段——两种形态模型均可读。
 */
export function annotateCoerceWarnings(content: unknown, warnings: string[] | undefined): unknown {
	if (!warnings || warnings.length === 0) { return content; }
	const note = `[arg-warning] ${warnings.join('; ')}. ` +
		`The tool ran with the remaining (valid) arguments — the ignored argument had no effect. ` +
		`Check the tool schema and re-send with the correct argument name if you intended that behavior.`;
	if (typeof content === 'string') { return `${note}\n${content}`; }
	if (content && typeof content === 'object' && !Array.isArray(content)) {
		return { ...(content as Record<string, unknown>), _argWarning: note };
	}
	return content;
}

/**
 * P2a: 编译时类型安全的工具 handler 签名（零运行时依赖）。
 * 工具定义者声明 schema 对应的参数类型 T，handler 即获得类型提示；运行时 args
 * 仍由 coerceOrReject 强转后传入，T 仅用于编译期检查（无运行时开销）。
 *
 * 用法：
 *   interface ReadFileArgs { path: string; encoding?: string }
 *   const handler: TypedToolHandler<ReadFileArgs> = async (args) => { ... args.path ... }
 */
export type TypedToolHandler<T extends Record<string, unknown>> = (args: T) => Promise<unknown>;

/** Escape characters that are legal after a backslash inside a JSON string (RFC 8259 §7). */
const VALID_JSON_ESCAPE_CHARS = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** Raw control characters that must be escaped inside a JSON string. */
const JSON_CONTROL_ESCAPES: Record<number, string> = {
	0x08: "\\b",
	0x09: "\\t",
	0x0a: "\\n",
	0x0c: "\\f",
	0x0d: "\\r",
};

/**
 * Repair illegal escape sequences and raw control characters inside JSON string
 * literals (single pass; only active while inside a string literal).
 *
 * Motivation (2026-08-21): models routinely emit `\x09` instead of `\t` (also
 * `\d`, `\p`, `\uZZ` …). `JSON.parse` rejects the WHOLE payload with
 * "Bad escaped character", and none of the existing repair steps below touch
 * escapes — so a single stray `\x` used to make the entire argument object
 * unrecoverable (it degraded to `{}` via {@link coerceToolCallArguments}).
 *
 * Illegal escapes are made literal (`\x09` → `\\x09`) rather than guessed at,
 * which is the least-surprise reading of the model's intent.
 *
 * NOTE: a parallel implementation lives in
 * `src/vs/sessions/browser/agentChat/toolArgsJson.ts` for the rendering layer.
 * It cannot be shared because `browser/agentChat/**` must not depend on
 * `contrib/agentStudio/**` (layer rule). Keep the two in sync when editing.
 */
export function sanitizeJsonEscapes(raw: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (!inString) {
			out += ch;
			if (ch === '"') {
				inString = true;
			}
			continue;
		}
		if (ch === '"') {
			out += ch;
			inString = false;
			continue;
		}
		if (ch === "\\") {
			const next = raw[i + 1];
			// Dangling backslash at EOF, or an illegal escape → literalise the backslash
			if (next === undefined || !VALID_JSON_ESCAPE_CHARS.has(next)) {
				out += "\\\\";
				continue;
			}
			if (next === "u") {
				const hex = raw.slice(i + 2, i + 6);
				if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
					out += "\\\\";
					continue;
				}
			}
			out += ch + next;
			i++;
			continue;
		}
		const code = ch.charCodeAt(0);
		if (code < 0x20) {
			out += JSON_CONTROL_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, "0")}`;
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Try to repair malformed JSON arguments from model output.
 *
 * Handles common issues:
 *  - Empty/whitespace → `{}`
 *  - Illegal escape sequences (`\x09`) and raw control chars inside strings
 *  - Trailing commas
 *  - Single quotes instead of double quotes
 *  - Python None → null
 *  - Python True/False → true/false
 *  - Truncated JSON (missing closing brackets)
 *  - Unquoted keys
 *
 * Returns the parsed object or undefined if unrepairable.
 */
export function repairToolArguments(
	raw: string,
): Record<string, unknown> | undefined {
	// Empty/whitespace
	const trimmed = raw.trim();
	if (!trimmed) {
		return {};
	}

	// Quick valid parse
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed;
		}
		return undefined;
	} catch {
		// Continue to repair attempts
	}

	// Escape repair — must run before every other step: the remaining repairs
	// (truncation auto-close / Python-style fixes) all re-parse the payload and
	// would still trip over the illegal escape. When there is nothing to fix
	// `escaped === trimmed`, so behaviour is unchanged for well-formed input.
	const escaped = sanitizeJsonEscapes(trimmed);
	if (escaped !== trimmed) {
		try {
			const parsed = JSON.parse(escaped);
			if (typeof parsed === "object" && parsed !== null) {
				return parsed;
			}
		} catch {
			// Continue with the escaped form as the basis for further repairs
		}
	}

	// Truncation detection: if the string doesn't end with } or ], it's likely truncated
	if (!escaped.endsWith("}") && !escaped.endsWith("]")) {
		// Auto-close. Two fixes over the original naive version (2026-08-21):
		//  a) brackets *inside* string literals no longer count (a `content`
		//     value containing `{` used to skew the balance);
		//  b) when the payload is cut in the middle of a string literal we close
		//     the quote first — otherwise the appended `}` lands INSIDE the
		//     string, the parse still fails and the function bails out with
		//     `undefined` (losing every already-complete argument). Truncation
		//     mid-string is the most common streaming shape.
		let openBraces = 0;
		let openBrackets = 0;
		let inString = false;
		for (let i = 0; i < escaped.length; i++) {
			const ch = escaped[i];
			if (inString) {
				if (ch === "\\") { i++; continue; }
				if (ch === '"') { inString = false; }
				continue;
			}
			if (ch === '"') {
				inString = true;
			} else if (ch === "{") {
				openBraces++;
			} else if (ch === "}") {
				openBraces--;
			} else if (ch === "[") {
				openBrackets++;
			} else if (ch === "]") {
				openBrackets--;
			}
		}
		let repaired = inString ? escaped + '"' : escaped;
		while (openBrackets > 0) {
			repaired += "]";
			openBrackets--;
		}
		while (openBraces > 0) {
			repaired += "}";
			openBraces--;
		}

		try {
			const parsed = JSON.parse(repaired);
			if (typeof parsed === "object" && parsed !== null) {
				return parsed;
			}
		} catch {
			// Truncation too severe — not recoverable
			return undefined;
		}
	}

	// Python-style fixes
	const fixed = escaped
		.replace(/,\s*([}\]])/g, "$1") // trailing commas
		.replace(/'/g, '"') // single → double quotes
		.replace(/\bNone\b/g, "null") // Python None
		.replace(/\bTrue\b/g, "true") // Python True
		.replace(/\bFalse\b/g, "false"); // Python False

	try {
		const parsed = JSON.parse(fixed);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed;
		}
	} catch {
		// Continue
	}

	// Last resort: try to find the outermost { } block
	const startIdx = fixed.indexOf("{");
	const endIdx = fixed.lastIndexOf("}");
	if (startIdx !== -1 && endIdx > startIdx) {
		try {
			const parsed = JSON.parse(fixed.substring(startIdx, endIdx + 1));
			if (typeof parsed === "object" && parsed !== null) {
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
const ERROR_SANITIZE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> =
	[
		// XML role tags that could pollute model context
		{ pattern: /<\/?(?:assistant|user|system|tool)>/gi, replacement: "" },
		// Excessive stack traces — keep first 3 lines
		{ pattern: /(\n\s+at .+){3,}/g, replacement: "\n  ..." },
		// File system paths with user home
		{
			pattern: /(C:\\Users\\|\/home\/|\/Users\/)[^\s"'`]+/gi,
			replacement: "<path>",
		},
		// Long hex strings (hashes, IDs)
		{ pattern: /[0-9a-f]{32,}/gi, replacement: "<hash>" },
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
		msg = msg.substring(0, 3900) + "\n... [truncated]";
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
	return calls.filter((tc) => {
		const key = `${tc.name}::${tc.arguments}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

// ─── Loop-Block Feedback ────────────────────────────────────────────

/**
 * 生成「工具调用被循环检测拦截」时回写给模型的 tool result 文本。
 *
 * 关键改进（据日志 1787759962668 实证）：模型用空参/同参反复调用 `patch`，
 * 原本只收到笼统的「called too many times ... try a different approach」，
 * 完全不知道 patch 需要 path/search/replace，于是空转到工具被禁用、任务放弃。
 * 这里对空参/缺参类拦截给出**可执行**的纠正信号，让模型首次被拦就能自检自愈，
 * 不必升级到「禁用工具」的硬停止档。
 */
export function buildLoopBlockFeedback(toolName: string, rawArgs: unknown): string {
	let parsedArgs: Record<string, unknown> = {};
	if (rawArgs != null) {
		try {
			const s = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
			parsedArgs = JSON.parse(s) as Record<string, unknown>;
		} catch {
			// 非 JSON：保留空对象，仅用于判断空参
		}
	}
	const argKeys = Object.keys(parsedArgs);
	const emptyArgs = argKeys.length === 0 || argKeys.every(k => parsedArgs[k] === '' || parsedArgs[k] == null);

	if (toolName === 'patch') {
		if (emptyArgs) {
			return `Error: Tool "patch" was blocked — its arguments were EMPTY or missing. To apply an edit you MUST supply: path (file to edit), search (exact existing text to replace), replace (new text). Do NOT repeat empty patch calls — re-issue EXACTLY ONE corrected patch with real arguments.`;
		}
		return `Error: Tool "patch" was blocked — it was called repeatedly with the SAME arguments (loop). Your patch targeted path="${String(parsedArgs['path'] ?? '')}". If the edit did not apply, file_read the file first, then re-issue ONE patch with a corrected search/replace. Do NOT retry unchanged.`;
	}
	if (emptyArgs) {
		return `Error: Tool "${toolName}" was blocked — its arguments were EMPTY or missing. Provide the required arguments (or a different valid approach) before calling it again.`;
	}
	return `Error: Tool "${toolName}" was called too many times with the same arguments. This looks like a loop — try a different approach or provide more specific arguments.`;
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
	const lastNewline = truncated.lastIndexOf("\n");
	const cutPoint = lastNewline > maxChars * 0.8 ? lastNewline : maxChars;
	return (
		content.substring(0, cutPoint) +
		`\n\n... [Result truncated: ${content.length} → ${cutPoint} chars]`
	);
}

/**
 * Hard cap on the JSON-stringified size of a single tool result, used as a
 * safety net BEFORE we ever call `JSON.stringify` on a tool's `result.content`.
 *
 * Why a separate (larger) cap than {@link MAX_TOOL_RESULT_CHARS}:
 *  - `MAX_TOOL_RESULT_CHARS` (100KB) caps what is fed into the chat history /
 *    streamed to the webview as a `tool_result`.
 *  - `MAX_TOOL_RESULT_PRE_STRINGIFY_BYTES` (4MB) is a much higher safety wall.
 *    It only kicks in when a tool returns something pathological (e.g.
 *    `file_read` on a 50MB log, or a `grep` hit list with millions of bytes).
 *    In that case we MUST avoid `JSON.stringify(content)` because V8 has to
 *    materialise the entire string in heap, and a few concurrent tool calls
 *    of that size will reliably OOM the renderer (we have observed
 *    `CodeWindow: renderer process gone (reason: oom)` with this exact
 *    signature).
 */
export const MAX_TOOL_RESULT_PRE_STRINGIFY_BYTES = 4 * 1024 * 1024; // 4MB

/**
 * Estimate the JSON-stringified size of an arbitrary value WITHOUT actually
 * stringifying it — bails out as soon as the running total exceeds `limit`.
 *
 * Returns:
 *  - `{ exceeded: false, approxBytes }` if the value fits comfortably.
 *  - `{ exceeded: true, approxBytes }` once the running total crosses `limit`.
 *
 * This is intentionally conservative (overestimates) so we err on the side
 * of triggering the truncation path early.
 */
function estimateJsonSize(value: unknown, limit: number): { exceeded: boolean; approxBytes: number } {
	let total = 0;
	const seen = new WeakSet<object>();

	const visit = (v: unknown): boolean => {
		if (total > limit) { return true; } // already exceeded
		if (v === null || v === undefined) {
			total += 4; return false;
		}
		const t = typeof v;
		if (t === "string") {
			// JSON string size ≈ string length + 2 quotes (UTF-16 chars; close enough)
			total += (v as string).length + 2;
			return total > limit;
		}
		if (t === "number" || t === "boolean") {
			total += 8; return total > limit;
		}
		if (t === "bigint") {
			total += 32; return total > limit;
		}
		if (t !== "object") {
			total += 16; return total > limit;
		}
		const obj = v as object;
		if (seen.has(obj)) { return false; } // skip cycles
		seen.add(obj);
		if (Array.isArray(obj)) {
			total += 2; // []
			for (let i = 0; i < obj.length; i++) {
				if (i > 0) { total += 1; }
				if (visit(obj[i])) { return true; }
			}
			return total > limit;
		}
		total += 2; // {}
		const keys = Object.keys(obj);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (i > 0) { total += 1; }
			total += k.length + 3; // "key":
			if (visit((obj as Record<string, unknown>)[k])) { return true; }
		}
		return total > limit;
	};

	visit(value);
	return { exceeded: total > limit, approxBytes: total };
}

/**
 * Walk a value and return a shallow copy where every string is hard-capped
 * to `perStringCap` characters. Used to defang giant tool results BEFORE
 * we hand them to `JSON.stringify`. Cycles are short-circuited; arrays are
 * truncated to `maxArrayItems` to keep the post-truncation object small
 * even for results like "100,000 grep hits".
 */
function deepTruncateStrings(
	value: unknown,
	perStringCap: number,
	maxArrayItems: number = 200,
	seen: WeakSet<object> = new WeakSet(),
): unknown {
	if (value === null || value === undefined) { return value; }
	const t = typeof value;
	if (t === "string") {
		const s = value as string;
		if (s.length <= perStringCap) { return s; }
		return s.substring(0, perStringCap) + `\n... [string truncated: ${s.length} → ${perStringCap} chars]`;
	}
	if (t !== "object") { return value; }
	const obj = value as object;
	if (seen.has(obj)) { return "[circular]"; }
	seen.add(obj);
	if (Array.isArray(obj)) {
		const slice = obj.length > maxArrayItems ? obj.slice(0, maxArrayItems) : obj;
		const out = slice.map(item => deepTruncateStrings(item, perStringCap, maxArrayItems, seen));
		if (obj.length > maxArrayItems) {
			out.push(`... [array truncated: ${obj.length} → ${maxArrayItems} items]`);
		}
		return out;
	}
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(obj)) {
		out[k] = deepTruncateStrings((obj as Record<string, unknown>)[k], perStringCap, maxArrayItems, seen);
	}
	return out;
}

/**
 * Safely stringify a tool result `content`, with hard guard against pathological
 * payloads that would OOM the renderer when passed naively to `JSON.stringify`.
 *
 * Strategy:
 *  1. Cheap structural size estimate (no string allocation).
 *  2. If under {@link MAX_TOOL_RESULT_PRE_STRINGIFY_BYTES}: stringify directly.
 *  3. Otherwise: deep-truncate strings/arrays inside the value first, prepend
 *     a `[truncated]` marker, then stringify the smaller object.
 *  4. Final length is still passed through {@link limitToolResultSize}, so the
 *     post-stringify string also obeys {@link MAX_TOOL_RESULT_CHARS}.
 *
 * Returns the safe JSON string. Never throws; falls back to `String(value)`
 * if both stringify paths fail (e.g. unserialisable BigInt edge cases).
 */
export function safeStringifyToolResult(
	content: unknown,
	preStringifyByteLimit: number = MAX_TOOL_RESULT_PRE_STRINGIFY_BYTES,
	finalCharLimit: number = MAX_TOOL_RESULT_CHARS,
): string {
	const estimate = estimateJsonSize(content, preStringifyByteLimit);
	let toStringify: unknown = content;
	let preTruncated = false;
	if (estimate.exceeded) {
		// Per-string cap is a fraction of the final char limit so we don't
		// recreate the original size after deep-truncation. /4 leaves room
		// for several large strings in the same payload.
		const perStringCap = Math.max(2_000, Math.floor(finalCharLimit / 4));
		toStringify = {
			__truncated__: true,
			__originalApproxBytes__: estimate.approxBytes,
			__note__: `Tool result exceeded ${preStringifyByteLimit} bytes pre-stringify and was deep-truncated to avoid OOM. Strings capped at ${perStringCap} chars per field.`,
			content: deepTruncateStrings(content, perStringCap),
		};
		preTruncated = true;
	}

	let json: string;
	try {
		json = JSON.stringify(toStringify);
	} catch {
		try {
			json = JSON.stringify({
				__truncated__: true,
				__error__: "Tool result could not be serialised to JSON",
			});
		} catch {
			json = '"[unserialisable tool result]"';
		}
	}
	// Final char-level cap (covers the case where the deep-truncated form is
	// still larger than MAX_TOOL_RESULT_CHARS, e.g. extremely wide objects).
	const final = limitToolResultSize(json, finalCharLimit);
	if (preTruncated && final === json) {
		// no-op: keep marker
	}
	return final;
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
		result.suggestion =
			"Please use one of the available tool names listed above.";
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
		: "";
	return {
		error: `Tool "${requestedName}" does not exist${repairNote}. Available tools: ${availableTools.join(", ")}.`,
		suggestion: "Please use one of the available tool names listed above.",
	};
}

// ─── Validation Helpers ─────────────────────────────────────────────

/**
 * Check whether a tool call's arguments string is valid JSON (or repairable).
 * Returns a classification for retry decision-making.
 */
export function classifyArgumentValidity(
	raw: string,
): "valid" | "empty" | "repairable" | "truncated" | "invalid" {
	if (!raw || !raw.trim()) {
		return "empty";
	}
	try {
		JSON.parse(raw.trim());
		return "valid";
	} catch {
		// Continue classification
	}

	const trimmed = raw.trim();

	// Truncation: doesn't end with } or ] and looks like it started an object
	if (
		trimmed.startsWith("{") &&
		!trimmed.endsWith("}") &&
		!trimmed.endsWith("]")
	) {
		return "truncated";
	}

	// Try repair
	const repaired = repairToolArguments(raw);
	if (repaired !== undefined) {
		return "repairable";
	}

	return "invalid";
}

/**
 * Build a lookup set of valid tool names from tool definitions.
 */
export function buildValidToolNameSet(tools: IToolDefinition[]): Set<string> {
	return new Set(tools.map((t) => t.name));
}

/**
 * Build a name → schema map for argument coercion.
 */
export function buildToolSchemaMap(
	tools: IToolDefinition[],
): Map<string, Record<string, unknown>> {
	const map = new Map<string, Record<string, unknown>>();
	for (const t of tools) {
		map.set(t.name, t.inputSchema);
	}
	return map;
}

// ─── Parallel Execution Helpers ─────────────────────────────────────

/** Maximum concurrent tool execution threads. Reduced from 8 to 3 to avoid triggering MCP codebase API rate limiting (HTTP 429). */
export const MAX_TOOL_WORKERS = 3;

/**
 * Tool names that should NEVER be parallelized — they are interactive
 * or have side effects that depend on conversation state.
 */
const NEVER_PARALLEL_TOOLS = new Set([
	"clarify",
	"delegate_task",
	// 动态工作流：自管并发（脚本内 agent()/parallel()），主循环必须串行
	"workflow",
	"todo", "update_plan",
	"memory_remember",
	"skill_manage",
	"cronjob",
	"send_message",
	"html_preview",
]);

/**
 * Read-only tools with no shared mutable session state — safe to parallelize.
 * 参考 Hermes `_PARALLEL_SAFE_TOOLS`。
 */
const PARALLEL_SAFE_TOOLS = new Set([
	// 基础只读
	"file_read", "search_files", "search_content",
	// 技能
	"read_skill", "list_skills",
	// 搜索
	"web_search", "web_extract", "session_search",
	// 工作流
	"workflow_list", "workflow_get", "workflow_get_schema",
	// 看板
	"kanban_show", "kanban_list",
	// Codebase 知识图谱（全部只读，安全并行）
	"search_graph", "query_graph", "get_architecture", "get_code_snippet",
	"get_graph_schema", "trace_path", "search_code",
	"index_status", "list_projects",
	"detect_changes", "ingest_traces",
]);

/**
 * File tools that can run concurrently when targeting independent paths.
 * 参考 Hermes `_PATH_SCOPED_TOOLS`。
 */
const PATH_SCOPED_TOOLS = new Set([
	"file_read", "file_write", "patch",
]);

/**
 * 是否为「只读且可安全并行」的工具（PARALLEL_SAFE_TOOLS 的对外只读视图）。
 *
 * 供 agent loop 的「单工具串行」检测使用（日志 1787302409958：连续 17 轮每轮只调
 * 1 个只读工具 → 浪费约 11 轮 LLM 往返）。复用同一集合而非另建副本，避免口径漂移。
 */
export function isParallelSafeReadOnlyTool(toolName: string): boolean {
	return PARALLEL_SAFE_TOOLS.has(toolName);
}

/**
 * Patterns that indicate a terminal command may modify/delete files.
 * 参考 Hermes `_DESTRUCTIVE_PATTERNS`。
 */
const DESTRUCTIVE_CMD_RE = /(?:^|\s|&&|\|\||;|`)(?:\b(?:rm|rmdir|cp|install|mv|truncate|dd|shred)\s|sed\s+-i|git\s+(?:reset|clean|checkout)\s)/;
const REDIRECT_OVERWRITE_RE = /[^>]>[^>]|^>[^>]/;

/**
 * 主循环工具并行开关（产品决策 2026-07-22）：除 subagent 派发外，主循环工具
 * 一律串行执行 —— 并行只保留在 subagent 通道内（delegate_task batch /
 * plan_explore 在 handler 内部自行并行派发子 agent），让并行工作集中呈现在
 * subagent 工具卡片中，而不是以普通工具卡片并行执行。
 *
 * subagent 工具本身不受影响：delegate_task 在 NEVER_PARALLEL_TOOLS 中（多个
 * delegate_task 调用串行），其 batch/tasks 参数与 plan_explore 的内部并行
 * 由 unifiedSubAgentDispatch 驱动，与本开关无关。
 *
 * 恢复主循环并行：把 MAIN_LOOP_PARALLEL_TOOLS_ENABLED 改回 true 即可
 * （下方 Hermes 对齐的原有判定逻辑完整保留，仅被本开关短路）。
 */
export const MAIN_LOOP_PARALLEL_TOOLS_ENABLED = false;

/**
 * delegate 分区拆分（2026-07-28，日志 1785237386145）：批次含 ≥2 个 delegate_task
 * 时返回 { head: 非 delegate 工具, delegates: delegate_task 子集 }；否则返回 null。
 *
 * 用途：当整批不可并行（混入了 update_plan 等 NEVER_PARALLEL 工具）时，执行器可先
 * 串行执行 head（非 delegate 工具），再把 delegates 子集交给并行路径并发执行——
 * 避免首个 delegate 的内联子 agent 阻塞导致其余 delegate 卡片无内容。
 */
export function splitDelegateParallelBatch(calls: IToolCallInfo[]): { head: IToolCallInfo[]; delegates: IToolCallInfo[] } | null {
	const delegates = calls.filter(c => c.name === 'delegate_task');
	if (delegates.length < 2) {
		return null;
	}
	return { head: calls.filter(c => c.name !== 'delegate_task'), delegates };
}

/**
 * Determine whether a batch of tool calls can be safely executed in parallel.
 * 参考 Hermes-Agent `_should_parallelize_tool_batch`。
 *
 * 策略（与 Hermes 对齐 — 默认串行）：
 *  0. MAIN_LOOP_PARALLEL_TOOLS_ENABLED=false → 全部串行（当前产品决策）
 *  1. Any NEVER_PARALLEL tool → serial
 *  2. Any terminal command that looks destructive → serial
 *  3. PATH_SCOPED tools → parallel only if paths don't overlap
 *  4. PARALLEL_SAFE tools → parallel
 *  5. Everything else → serial (conservative default)
 */
export function shouldParallelizeToolBatch(calls: IToolCallInfo[]): boolean {
	if (calls.length <= 1) {
		return false;
	}

	// 2026-07-27（日志 1785120071762 / 1785121881324，用户报告「启动多个
	// delegate_task 只有最后一个在执行 subagent」）：批次含 ≥2 个 delegate_task
	// 时并行——属于「subagent 通道并行」，与主开关「仅 subagent 通道可并行」的
	// 决策一致。此前多个 delegate_task 串行，首个 subagent（最长 600s）阻塞
	// 期间其余排队。
	//   放宽条件（1785121881324 教训）：真实场景 LLM 常在同一轮夹带只读工具
	//   （如 read_skill + 3×delegate_task），要求整批纯 delegate_task 过严 →
	//   混合批次仍串行 → bug 复现。改为：≥2 个 delegate_task，且其余调用均为
	//   只读安全工具（read_skill / search_* / file_read 等 PARALLEL_SAFE）时并行。
	//   安全性：delegate 各自 fiber + inlineTraceSink 闭包独立、dispatch 并发
	//   上限 5 兜底；只读工具无状态写，与 delegate 并行无副作用；混入写工具
	//   （file_write/terminal 等非 SAFE）则回退串行（保守）。
	const delegateCount = calls.filter(tc => tc.name === 'delegate_task').length;
	if (delegateCount >= 2) {
		const othersAllSafe = calls.every(tc =>
			tc.name === 'delegate_task' || PARALLEL_SAFE_TOOLS.has(tc.name));
		if (othersAllSafe) {
			return true;
		}
	}

	// 0. 产品决策：主循环禁止并行（仅 subagent 通道可并行，见常量注释）。
	if (!MAIN_LOOP_PARALLEL_TOOLS_ENABLED) {
		return false;
	}

	// 1. Check for never-parallel tools
	for (const tc of calls) {
		if (NEVER_PARALLEL_TOOLS.has(tc.name)) {
			return false;
		}
	}

	// 2. Check for destructive terminal commands
	for (const tc of calls) {
		if (tc.name === 'terminal') {
			try {
				const args = JSON.parse(tc.arguments || '{}');
				const cmd = String(args.command ?? '');
				if (DESTRUCTIVE_CMD_RE.test(cmd) || REDIRECT_OVERWRITE_RE.test(cmd)) {
					return false;
				}
			} catch { /* ignore */ }
		}
	}

	// 3. Check path-scoped tools for overlap
	const pathScopedCalls = calls.filter(tc => PATH_SCOPED_TOOLS.has(tc.name));
	if (pathScopedCalls.length > 1) {
		const paths: string[] = [];
		for (const tc of pathScopedCalls) {
			try {
				const args = JSON.parse(tc.arguments || '{}');
				const p = String(args.path ?? args.file ?? '');
				if (p) { paths.push(p); }
			} catch { /* ignore */ }
		}
		for (let i = 0; i < paths.length; i++) {
			for (let j = i + 1; j < paths.length; j++) {
				if (paths[i].startsWith(paths[j]) || paths[j].startsWith(paths[i])) {
					return false;
				}
			}
		}
	}

	// 4. All remaining calls must be PARALLEL_SAFE or PATH_SCOPED (already checked)
	for (const tc of calls) {
		if (!PARALLEL_SAFE_TOOLS.has(tc.name) && !PATH_SCOPED_TOOLS.has(tc.name)) {
			return false; // unknown tool — conservative serial
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
	private _id = "";
	private _name = "";
	private _argsBuffer = "";
	private _finalized = false;
	private _displayName: string | undefined;
	private _renderType: string | undefined;
	private _defaultShow: boolean | undefined;
	private _serverExecuted: boolean | undefined;

	get id(): string {
		return this._id;
	}
	get name(): string {
		return this._name;
	}
	get partialArgs(): string {
		return this._argsBuffer;
	}
	get isFinalized(): boolean {
		return this._finalized;
	}

	/**
	 * Start a new tool call. Resets internal state.
	 */
	start(id: string, name: string, initialArgs?: string, meta?: { displayName?: string; renderType?: string; defaultShow?: boolean; serverExecuted?: boolean }): void {
		this._id = id;
		this._name = name;
		this._argsBuffer = initialArgs || "";
		this._finalized = false;
		this._displayName = meta?.displayName;
		this._renderType = meta?.renderType;
		this._defaultShow = meta?.defaultShow;
		this._serverExecuted = meta?.serverExecuted;
	}

	/**
	 * Append an argument chunk. Returns false if buffer limit exceeded.
	 */
	appendArgs(chunk: string): boolean {
		if (this._finalized) {
			return false;
		}
		if (
			this._argsBuffer.length + chunk.length >
			MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES
		) {
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
		if (!this._argsBuffer.trim()) {
			return null;
		}
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
			displayName: this._displayName,
			renderType: this._renderType,
			defaultShow: this._defaultShow,
			serverExecuted: this._serverExecuted,
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
		this._id = "";
		this._name = "";
		this._argsBuffer = "";
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
export function parsePartialJson(
	partial: string,
): Record<string, unknown> | null {
	const trimmed = partial.trim();
	if (!trimmed) {
		return null;
	}

	// Already valid?
	try {
		const parsed = JSON.parse(trimmed);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed;
		}
		return null;
	} catch {
		// Continue to auto-close attempts
	}

	// Must start with { to be an object
	if (!trimmed.startsWith("{")) {
		return null;
	}

	// Strategy: progressively try to close the JSON
	// 1. Remove trailing comma if any
	let candidate = trimmed.replace(/,\s*$/, "");

	// 2. If we're in the middle of a string value, try to close it
	//    Count unescaped quotes
	let inString = false;
	for (let i = 0; i < candidate.length; i++) {
		const ch = candidate[i];
		if (ch === "\\" && inString) {
			i++;
			continue;
		} // skip escaped
		if (ch === '"') {
			inString = !inString;
		}
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
		if (ch === "\\" && inStr) {
			i++;
			continue;
		}
		if (ch === '"') {
			inStr = !inStr;
			continue;
		}
		if (inStr) {
			continue;
		}
		if (ch === "{") {
			openBraces++;
		} else if (ch === "}") {
			openBraces--;
		} else if (ch === "[") {
			openBrackets++;
		} else if (ch === "]") {
			openBrackets--;
		}
	}

	// Remove trailing colon or comma (incomplete key-value)
	candidate = candidate.replace(/[,:]\s*$/, "");

	while (openBrackets > 0) {
		candidate += "]";
		openBrackets--;
	}
	while (openBraces > 0) {
		candidate += "}";
		openBraces--;
	}

	try {
		const parsed = JSON.parse(candidate);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
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
export function formatToolOutputForDisplay(
	output: string,
	maxChars: number = MAX_TOOL_OUTPUT_DISPLAY_CHARS,
): string {
	if (!output) {
		return "(no output)";
	}

	let formatted = output;

	// Try to pretty-print if it looks like JSON
	const trimmed = output.trim();
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			const parsed = JSON.parse(trimmed);
			formatted = JSON.stringify(parsed, null, 2);
		} catch {
			// Keep as-is
		}
	}

	// Truncate if needed
	if (formatted.length > maxChars) {
		formatted = formatted.substring(0, maxChars) + "\n\n... [output truncated]";
	}

	return formatted;
}
