/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChatMode configuration — unified constants, tool-filtering, system-prompt
 * templates, and permission-mode mappings for the three chat modes
 * (craft / ask / plan).
 *
 * Reference: doc/CodeBuddy-IDE-模式分析.md
 *
 * ┌──────────┬──────────────────────────────────────────────────────────────────┐
 * │ Mode     │ Behaviour                                                       │
 * ├──────────┼──────────────────────────────────────────────────────────────────┤
 * │ craft    │ Full access: all tools, acceptEdits permission, code-generation  │
 * │ ask      │ Read-only tools only, default permission, Q&A / explanation     │
 * │ plan     │ Read-only exploration + plan-specific tools, plan permission,   │
 * │          │ task decomposition only; exits to craft/ask on user approval     │
 * └──────────┴──────────────────────────────────────────────────────────────────┘
 */

import type { ChatMode } from '../../../common/agentStudioService.js';
import type { IToolDefinition } from './providers.js';
import { ToolSecurityLevel } from './providers.js';

// ─── Permission Mode Mapping ────────────────────────────────────────────

export const enum PermissionMode {
	/** Every write / dangerous action requires explicit user approval */
	Default = 'default',
	/** Automatically allow safe file edits within the workspace */
	AcceptEdits = 'acceptEdits',
	/** Read-only exploration + plan-specific tools; cannot modify files */
	Plan = 'plan',
}

/** Map ChatMode → PermissionMode */
export function getPermissionMode(chatMode: ChatMode): PermissionMode {
	switch (chatMode) {
		case 'craft': return PermissionMode.AcceptEdits;
		case 'ask': return PermissionMode.Default;
		case 'plan': return PermissionMode.Plan;
		case 'workflow': return PermissionMode.AcceptEdits;
		default: return PermissionMode.Default;
	}
}

// ─── Tool-name patterns ─────────────────────────────────────────────────

/** Tool names that are explicitly destructive (write / delete / execute). */
export const DESTRUCTIVE_TOOL_PATTERNS: readonly RegExp[] = [
	/^file_write$/i, /^file_delete$/i, /^write$/i, /^delete$/i, /^remove$/i,
	/^terminal$/i, /^shell$/i, /^exec$/i, /^bash$/i, /^command$/i,
	/^mkdir$/i, /^mv$/i, /^cp$/i, /^rename$/i, /^chmod$/i,
];

/** Tool names that are known to be read-only. */
export const READ_ONLY_TOOL_PATTERNS: readonly RegExp[] = [
	/^file_read$/i, /^search_files$/i, /^search$/i, /^grep$/i, /^find$/i,
	/^list_files$/i, /^list_dir$/i, /^read$/i, /^cat$/i, /^head$/i, /^tail$/i,
	/^glob$/i, /^ripgrep$/i, /^rg$/i, /^tree$/i, /^ls$/i,
	/^read_skill$/i, /^web_search$/i, /^web_fetch$/i, /^browser/i,
	/^symbol/i, /^references$/i, /^definition$/i, /^hover$/i,
];

/** Tool names that are exclusive to Plan mode (added on top of read-only). */
export const PLAN_EXCLUSIVE_TOOL_PATTERNS: readonly RegExp[] = [
	/^enter_plan_mode$/i, /^exit_plan_mode$/i, /^ask_user_question$/i,
];

/** Tool categories that imply read-only access. */
export const READ_ONLY_CATEGORIES = new Set(['search', 'retrieval', 'read']);

// ─── Tool filtering ─────────────────────────────────────────────────────

/**
 * Filter a tool list according to the given ChatMode.
 *
 * - **craft** → all tools
 * - **ask**   → read-only tools only (no write / delete / execute)
 * - **plan**  → read-only tools + plan-exclusive tools
 */
export function filterToolsByChatMode(
	tools: readonly IToolDefinition[],
	chatMode: ChatMode,
): IToolDefinition[] {
	switch (chatMode) {
		case 'craft':
		case 'workflow':
			return [...tools];

		case 'ask':
			return tools.filter(t => isToolAllowedInAskMode(t));

		case 'plan':
			return tools.filter(t => isToolAllowedInPlanMode(t));

		default:
			return [...tools];
	}
}

function isToolAllowedInAskMode(tool: IToolDefinition): boolean {
	// Explicitly exclude destructive tools
	if (DESTRUCTIVE_TOOL_PATTERNS.some(p => p.test(tool.name))) {
		return false;
	}
	// Include known read-only tools
	if (READ_ONLY_TOOL_PATTERNS.some(p => p.test(tool.name))) {
		return true;
	}
	// Include by security level: safe tools are allowed
	if (tool.securityLevel === ToolSecurityLevel.Safe) {
		return true;
	}
	// Include by category
	if (READ_ONLY_CATEGORIES.has((tool.category || '').toLowerCase())) {
		return true;
	}
	// Unknown tools are excluded by default in ask mode
	return false;
}

function isToolAllowedInPlanMode(tool: IToolDefinition): boolean {
	// Plan-exclusive tools are always allowed
	if (PLAN_EXCLUSIVE_TOOL_PATTERNS.some(p => p.test(tool.name))) {
		return true;
	}
	// Otherwise, same rules as ask mode (read-only only)
	return isToolAllowedInAskMode(tool);
}

// ─── System Prompt Templates ────────────────────────────────────────────

/** System prompt suffix injected for ASK mode. */
export const ASK_MODE_SYSTEM_PROMPT = [
	'',
	'## Chat Mode: ASK (Read-Only)',
	'',
	'You are in ASK mode — a technical Q&A assistant. You may use tools to READ files,',
	'search code, and retrieve information, but you MUST NOT modify, delete, create,',
	'or overwrite any local files, nor execute shell commands that change state.',
	'',
	'Allowed actions:',
	'- Read file contents (file_read, search_files, etc.)',
	'- Search and browse code / documentation',
	'- Answer questions based on existing files and context',
	'- Provide explanations, analysis, and suggestions',
	'',
	'Forbidden actions:',
	'- Writing, creating, or overwriting files (file_write, etc.)',
	'- Deleting files or directories',
	'- Executing terminal commands that modify the filesystem (e.g., git commit, npm install, mkdir)',
	'- Any operation that changes the state of the workspace',
	'',
	'If the user asks you to perform a forbidden action, explain that you are in ASK mode',
	'and suggest switching to CRAFT mode for implementation.',
].join('\n');

/** System prompt suffix injected for CRAFT mode. */
export const CRAFT_MODE_SYSTEM_PROMPT = [
	'',
	'## Chat Mode: CRAFT (Agent Mode)',
	'',
	'You are in CRAFT mode — a code-generation and modification agent.',
	'You have full access to read and write files, execute commands, and modify the workspace.',
	'',
	'Guidelines:',
	'- Read files and understand context before making changes',
	'- Make precise, targeted modifications rather than rewriting large sections',
	'- Verify your changes by reading the modified file afterwards',
	'- Execute commands when needed to test or validate your work',
	'- When editing, preserve existing code style and conventions',
].join('\n');

/** System prompt suffix injected for PLAN mode. */
export const PLAN_MODE_SYSTEM_PROMPT = [
	'',
	'## Chat Mode: PLAN (Task Decomposition)',
	'',
	'You are in PLAN mode — a planning and task-decomposition assistant.',
	'Your job is to analyze the user\'s request and produce a clear, structured plan.',
	'',
	'You may use read-only tools to EXPLORE the codebase (read files, search code),',
	'but you MUST NOT modify, delete, create, or overwrite any files.',
	'You MUST NOT execute any code or commands that change state.',
	'',
	'Your response should:',
	'1. Analyze the user\'s goal and identify key requirements',
	'2. Break down the goal into concrete, ordered sub-tasks',
	'3. For each sub-task, describe what needs to be done, which files are likely involved, and any dependencies',
	'4. Estimate complexity and suggest an execution order',
	'5. Flag any risks, assumptions, or open questions',
	'',
	'When your plan is ready, call the `exit_plan_mode` tool with:',
	'- plan_summary: concise summary of the entire plan',
	'- tasks: array of sub-tasks, each with title, description, files, and complexity',
	'- next_mode: recommended mode after approval (craft for implementation, ask for Q&A)',
	'',
	'After user approval, the system will automatically:',
	'1. Create an OrchestrationPlan with your tasks',
	'2. Create Agent instances for each task (if not already assigned)',
	'3. Assign tasks to agents based on role/skills',
	'4. Execute tasks automatically following dependency order',
	'',
	'Tips for better auto-execution:',
	'- Make tasks specific and independently executable',
	'- Include relevant file paths in the `files` field',
	'- Set appropriate complexity levels (low/medium/high)',
	'- Order tasks by dependency — earlier tasks should not depend on later ones',
	'- For multi-file changes, split into separate tasks per logical unit',
	'',
	'If the user asks you to actually implement something, explain that you are in PLAN mode',
	'and suggest switching to CRAFT mode for execution, or use exit_plan_mode to transition.',
].join('\n');

/** Get the system prompt suffix for a given ChatMode. */
export function getModeSystemPrompt(chatMode: ChatMode): string {
	switch (chatMode) {
		case 'craft': return CRAFT_MODE_SYSTEM_PROMPT;
		case 'ask': return ASK_MODE_SYSTEM_PROMPT;
		case 'plan': return PLAN_MODE_SYSTEM_PROMPT;
		case 'workflow': return CRAFT_MODE_SYSTEM_PROMPT; // workflow uses craft prompt
		default: return '';
	}
}

// ─── Mode info (for UI) ─────────────────────────────────────────────────

export interface ChatModeInfo {
	readonly id: ChatMode;
	readonly label: string;
	readonly description: string;
	readonly icon: string; // SVG path data or icon id
}

export const CHAT_MODE_INFO: readonly ChatModeInfo[] = [
	{
		id: 'craft',
		label: 'Craft',
		description: 'Agent 模式 — 完整工具访问，可直接修改代码和执行命令',
		icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z', // lightning bolt
	},
	{
		id: 'ask',
		label: 'Ask',
		description: '问答模式 — 只读工具访问，提供技术解答和建议',
		icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm1 5.5v5h-2v-5h2z', // info circle
	},
	{
		id: 'plan',
		label: 'Plan',
		description: '计划模式 — 只读探索 + 任务拆解，确认后切换执行模式',
		icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4', // clipboard list
	},
] as const;
