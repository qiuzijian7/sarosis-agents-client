/*---------------------------------------------------------------------------------------------
 *  Agent Tool Isolator
 *
 *  Bridges Agent.tools[] to Saros internal tool names for real tool isolation.
 *  When an agent sends a chat request, the isolator computes an enabledTools map
 *  that only enables the tools declared in the agent's `tools` field, disabling all others.
 *
 *  Tool naming system:
 *    - Saros internal tool names: read_file, write_to_file, terminal, etc.
 *    - Legacy aliases (vscode, read, execute) and old internal names (file_read, file_write,
 *      file_list, read_skill, list_skills) are expanded to current names for backward compat.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import { SandboxMode } from '../../../common/agentStudioTypes.js';

export const IAgentToolIsolator = createDecorator<IAgentToolIsolator>('agentToolIsolator');

/**
 * Result of tool isolation computation.
 */
export interface IIsolatedTools {
	/** Map of toolName → enabled (true = allowed, false = disabled) */
	readonly enabledTools: Record<string, boolean>;
	/** The tool names that were explicitly enabled (after alias expansion) */
	readonly declaredTools: readonly string[];
	/** Tool names that exist in the platform registry but were NOT declared (disabled) */
	readonly disabledTools: readonly string[];
	/** Tool names declared by the agent but not found in the platform registry */
	readonly unknownTools: readonly string[];
}

export interface IAgentToolIsolator {
	readonly _serviceBrand: undefined;

	/**
	 * Compute isolated tool enablement for an agent.
	 *
	 * - If the agent has `tools` defined and non-empty, only those tools are enabled;
	 *   all other registered tools are explicitly disabled.
	 * - If the agent has no `tools` (undefined or empty), all tools are allowed
	 *   (returns undefined to signal "no restriction").
	 * - Legacy aliases and old internal names are expanded to current Saros tool names.
	 * - Unknown tool references (declared but not in the platform registry) are
	 *   reported but still enabled in the map so they can be resolved lazily.
	 *
	 * @param agent The agent whose tool access to isolate
	 * @param allRegisteredToolNames All tool names currently registered in the platform
	 * @returns Isolated tool map, or undefined if no restriction applies
	 */
	isolateTools(agent: Agent, allRegisteredToolNames: readonly string[]): IIsolatedTools | undefined;

	/**
	 * Check if a specific tool is allowed for an agent.
	 * @param agent The agent
	 * @param toolName The Saros internal tool name to check
	 * @returns true if the tool is allowed, false if blocked
	 */
	isToolAllowed(agent: Agent, toolName: string): boolean;

	/**
	 * Expand legacy aliases and old internal names to current Saros tool names.
	 * @param toolIds Tool IDs (may include legacy aliases or old internal names)
	 * @returns Expanded list of Saros internal tool names
	 */
	expandToolAliases(toolIds: readonly string[]): string[];

	/**
	 * Get all known Saros tool names (for UI display).
	 */
	getKnownToolNames(): readonly string[];

	/**
	 * Get tool metadata for display in the UI.
	 */
	getToolMetadata(): ReadonlyArray<{ name: string; label: string; description: string; category: string }>;
}

// ─── Saros Internal Tool Name Constants ──────────────────────────────

/**
 * Well-known Saros internal tool names.
 * These are the canonical tool identifiers used throughout the system.
 *
 * 22 tools total, organized by category:
 *   search    : grep_search, search_files
 *   filesystem: list_dir, read_file, replace_in_file, edit_file, write_to_file
 *   terminal  : terminal
 *   mcp       : use_mcp_tool, fetch_mcp_tools, grep_mcp_tools
 *   skills    : use_skill
 *   vision    : read_image, capture_screen
 *   web       : web_preview
 *   env       : get_env_info
 *   media     : generate_picture
 *   history   : read_history_context, grep_history_context
 *   scheduler : cron
 *   notify    : notify
 *   download  : display_download_links
 */
export const VSSAROS_TOOL_NAMES = {
	// Search
	GREP_SEARCH: 'search_files',
	SEARCH_FILES: 'search_files',
	// Filesystem
	LIST_DIR: 'file_list',
	READ_FILE: 'file_read',
	REPLACE_IN_FILE: 'patch',
	EDIT_FILE: 'patch',
	WRITE_TO_FILE: 'file_write',
	// Terminal
	TERMINAL: 'terminal',
	// Skills
	USE_SKILL: 'read_skill',
	// Vision
	READ_IMAGE: 'vision_analyze',
	CAPTURE_SCREEN: 'browser_vision',
	// Web
	WEB_PREVIEW: 'browser_navigate',
	// Environment
	GET_ENV_INFO: 'get_current_time',
	// Media generation
	GENERATE_PICTURE: 'image_generate',
	// History context
	READ_HISTORY_CONTEXT: 'session_search',
	GREP_HISTORY_CONTEXT: 'session_search',
	// Scheduler
	CRON: 'cronjob',
	// Notification
	NOTIFY: 'send_message',
	// Download
	DISPLAY_DOWNLOAD_LINKS: 'file_list',
	// MCP — no direct MCP tool; use tool_search/tool_describe/tool_call bridge
} as const;

// ─── Legacy Alias → Current Saros Tool Name Mapping ──────────────────

/**
 * Maps legacy VS Code tool IDs and old Saros internal names to current tool names.
 * Used for backward compatibility with existing agent configs.
 *
 * Expansion rules:
 *   ── VS Code legacy aliases ──
 *   vscode    → file_write, file_list, search_files, file_read (full code access)
 *   read      → file_read, file_list, search_files (read-only access)
 *   execute   → terminal (command execution)
 *   listFiles → file_list
 *   search    → search_files
 *   webFetch  → browser_navigate
 *
 *   ── Saros actual tool names（对齐 builtinToolProvider 注册名）──
 *   read_file → file_read
 *   write_to_file → file_write
 *   list_dir → file_list
 *   read_skill → read_skill
 *   list_skills → use_skill (merged)
 *   echo        → (no equivalent — dropped)
 *   get_current_time → (no equivalent — dropped)
 *   math_eval   → (no equivalent — dropped)
 *   http_get    → (no equivalent — dropped)
 *   exit_plan_mode → (no equivalent — dropped)
 *   ask_user_question → (no equivalent — dropped)
 */
export const TOOL_ALIAS_MAP: Readonly<Record<string, string[]>> = {
	// VS Code legacy aliases
	vscode: [VSSAROS_TOOL_NAMES.WRITE_TO_FILE, VSSAROS_TOOL_NAMES.LIST_DIR, VSSAROS_TOOL_NAMES.SEARCH_FILES, VSSAROS_TOOL_NAMES.READ_FILE],
	read: [VSSAROS_TOOL_NAMES.READ_FILE, VSSAROS_TOOL_NAMES.LIST_DIR, VSSAROS_TOOL_NAMES.SEARCH_FILES, VSSAROS_TOOL_NAMES.GREP_SEARCH],
	execute: [VSSAROS_TOOL_NAMES.TERMINAL],
	agent: [],  // reserved for future delegation tools
	listFiles: [VSSAROS_TOOL_NAMES.LIST_DIR],
	search: [VSSAROS_TOOL_NAMES.SEARCH_FILES],
	webFetch: [VSSAROS_TOOL_NAMES.WEB_PREVIEW],
	notebook: [],  // reserved

	// Old Saros internal names (renamed)
	file_read: [VSSAROS_TOOL_NAMES.READ_FILE],
	file_write: [VSSAROS_TOOL_NAMES.WRITE_TO_FILE],
	file_list: [VSSAROS_TOOL_NAMES.LIST_DIR],
	read_skill: [VSSAROS_TOOL_NAMES.USE_SKILL],
	list_skills: [VSSAROS_TOOL_NAMES.USE_SKILL],

	// Common LLM hallucination names (snake_case variants — models
	// trained on agent patterns often use read_file / write_to_file
	// instead of the registered file_read / file_write)
	read_file: [VSSAROS_TOOL_NAMES.READ_FILE],
	write_to_file: [VSSAROS_TOOL_NAMES.WRITE_TO_FILE],
	replace_in_file: [VSSAROS_TOOL_NAMES.REPLACE_IN_FILE],
	list_dir: [VSSAROS_TOOL_NAMES.LIST_DIR],

	// Old names with no current equivalent — silently dropped
	echo: [],
	get_current_time: [],
	math_eval: [],
	http_get: [],
	exit_plan_mode: [],
	ask_user_question: [],
};

/**
 * Tool metadata for display in the UI.
 * Uses current Saros internal tool names.
 */
// Note: multiple VSSAROS_TOOL_NAMES aliases resolve to the same actual tool name
// (e.g. GREP_SEARCH/SEARCH_FILES → 'search_files'). Keep only one entry per actual name.
export const TOOL_METADATA: Record<string, { label: string; description: string; category: string }> = {
	// Search
	[VSSAROS_TOOL_NAMES.SEARCH_FILES]: { label: 'Search Files', description: '文件搜索 (文件名/文本)', category: 'search' },
	// Filesystem
	[VSSAROS_TOOL_NAMES.LIST_DIR]: { label: 'List Dir', description: '列出目录内容', category: 'filesystem' },
	[VSSAROS_TOOL_NAMES.READ_FILE]: { label: 'Read File', description: '读取本地文件内容', category: 'filesystem' },
	[VSSAROS_TOOL_NAMES.REPLACE_IN_FILE]: { label: 'Replace/Edit File', description: '文本替换/文件编辑', category: 'filesystem' },
	[VSSAROS_TOOL_NAMES.WRITE_TO_FILE]: { label: 'Write To File', description: '写入/创建文件', category: 'filesystem' },
	// Terminal
	[VSSAROS_TOOL_NAMES.TERMINAL]: { label: 'Terminal', description: '执行命令行命令', category: 'terminal' },
	// Skills
	[VSSAROS_TOOL_NAMES.USE_SKILL]: { label: 'Use Skill', description: '加载并使用 Skill', category: 'skills' },
	// Vision
	[VSSAROS_TOOL_NAMES.READ_IMAGE]: { label: 'Read Image', description: '读取/分析图片', category: 'vision' },
	[VSSAROS_TOOL_NAMES.CAPTURE_SCREEN]: { label: 'Capture Screen', description: '截取屏幕', category: 'vision' },
	// Web
	[VSSAROS_TOOL_NAMES.WEB_PREVIEW]: { label: 'Web Preview', description: '预览前端 Web 页面', category: 'web' },
	// Environment
	[VSSAROS_TOOL_NAMES.GET_ENV_INFO]: { label: 'Get Env Info', description: '获取当前时间/环境信息', category: 'env' },
	// Media generation
	[VSSAROS_TOOL_NAMES.GENERATE_PICTURE]: { label: 'Generate Picture', description: 'AI 图像生成 (文生图/图生图)', category: 'media' },
	// History context
	[VSSAROS_TOOL_NAMES.READ_HISTORY_CONTEXT]: { label: 'History Context', description: '搜索/读取历史对话上下文', category: 'history' },
	// Scheduler
	[VSSAROS_TOOL_NAMES.CRON]: { label: 'Cron', description: '创建/管理定时任务', category: 'scheduler' },
	// Notification
	[VSSAROS_TOOL_NAMES.NOTIFY]: { label: 'Notify', description: '发送通知消息', category: 'notify' },
};

/**
 * Default tool sets for common agent roles.
 * Uses current Saros internal tool names directly.
 * Used when creating agents from presets that don't explicitly declare tools.
 */
export const DEFAULT_TOOL_SETS: Record<string, string[]> = {
	code: [VSSAROS_TOOL_NAMES.WRITE_TO_FILE, VSSAROS_TOOL_NAMES.READ_FILE, VSSAROS_TOOL_NAMES.TERMINAL, VSSAROS_TOOL_NAMES.SEARCH_FILES, VSSAROS_TOOL_NAMES.LIST_DIR, VSSAROS_TOOL_NAMES.GREP_SEARCH, VSSAROS_TOOL_NAMES.REPLACE_IN_FILE],
	research: [VSSAROS_TOOL_NAMES.READ_FILE, VSSAROS_TOOL_NAMES.SEARCH_FILES, VSSAROS_TOOL_NAMES.GREP_SEARCH, VSSAROS_TOOL_NAMES.LIST_DIR, VSSAROS_TOOL_NAMES.WEB_PREVIEW],
	writing: [VSSAROS_TOOL_NAMES.READ_FILE, VSSAROS_TOOL_NAMES.WRITE_TO_FILE, VSSAROS_TOOL_NAMES.LIST_DIR, VSSAROS_TOOL_NAMES.REPLACE_IN_FILE],
	management: [VSSAROS_TOOL_NAMES.READ_FILE, VSSAROS_TOOL_NAMES.LIST_DIR, VSSAROS_TOOL_NAMES.NOTIFY],
	devops: [VSSAROS_TOOL_NAMES.WRITE_TO_FILE, VSSAROS_TOOL_NAMES.READ_FILE, VSSAROS_TOOL_NAMES.TERMINAL, VSSAROS_TOOL_NAMES.LIST_DIR, VSSAROS_TOOL_NAMES.CRON],
	analytics: [VSSAROS_TOOL_NAMES.READ_FILE, VSSAROS_TOOL_NAMES.TERMINAL, VSSAROS_TOOL_NAMES.LIST_DIR, VSSAROS_TOOL_NAMES.GREP_SEARCH],
	creative: [VSSAROS_TOOL_NAMES.GENERATE_PICTURE, VSSAROS_TOOL_NAMES.READ_IMAGE, VSSAROS_TOOL_NAMES.WRITE_TO_FILE, VSSAROS_TOOL_NAMES.READ_FILE],
};

/**
 * Read-only tool names — only these are allowed in SandboxMode.ReadOnly.
 * Includes all tools that do NOT modify files, execute code, or make external changes.
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
	VSSAROS_TOOL_NAMES.GREP_SEARCH,
	VSSAROS_TOOL_NAMES.SEARCH_FILES,
	VSSAROS_TOOL_NAMES.READ_FILE,
	VSSAROS_TOOL_NAMES.READ_IMAGE,
	VSSAROS_TOOL_NAMES.READ_HISTORY_CONTEXT,
	VSSAROS_TOOL_NAMES.GREP_HISTORY_CONTEXT,
	VSSAROS_TOOL_NAMES.USE_SKILL,
	VSSAROS_TOOL_NAMES.WEB_PREVIEW,
	VSSAROS_TOOL_NAMES.CAPTURE_SCREEN,
];

export class AgentToolIsolator implements IAgentToolIsolator {
	declare readonly _serviceBrand: undefined;

	/**
	 * Expand legacy aliases and old internal names to current Saros tool names.
	 * If a tool ID is a known alias, it's replaced with its expanded set.
	 * If it's already a current Saros name, it passes through unchanged.
	 * Known aliases with empty expansion (e.g. 'echo', 'http_get') are silently dropped.
	 */
	expandToolAliases(toolIds: readonly string[]): string[] {
		const expanded = new Set<string>();
		for (const id of toolIds) {
			const aliasTargets = TOOL_ALIAS_MAP[id];
			if (aliasTargets && aliasTargets.length > 0) {
				for (const name of aliasTargets) {
					expanded.add(name);
				}
			} else if (!TOOL_ALIAS_MAP.hasOwnProperty(id)) {
				// Not a known alias — treat as a direct Saros tool name
				expanded.add(id);
			}
			// Known alias with empty expansion is silently dropped
		}
		return [...expanded];
	}

	/**
	 * Compute isolated tool enablement for an agent.
	 *
	 * Implementation strategy:
	 * 1. If SandboxMode.ReadOnly → force read-only tools only, regardless of `tools` field
	 * 2. If agent.tools is undefined/empty → no restriction (return undefined)
	 * 3. Expand legacy aliases and old names in agent.tools to current tool names
	 * 4. Build enabledTools map: declared tools = true, all others = false
	 * 5. Report unknown tools (declared but not in registered tools)
	 */
	isolateTools(agent: Agent, allRegisteredToolNames: readonly string[]): IIsolatedTools | undefined {
		const registeredSet = new Set(allRegisteredToolNames);

		// SandboxMode.ReadOnly overrides everything — only read-only tools allowed
		if (agent.sandbox === SandboxMode.ReadOnly) {
			const declaredTools = [...READ_ONLY_TOOL_NAMES].filter(t => registeredSet.has(t));
			const disabledTools = [...registeredSet].filter(t => !READ_ONLY_TOOL_NAMES.includes(t));

			const enabledTools: Record<string, boolean> = {};
			for (const toolName of declaredTools) {
				enabledTools[toolName] = true;
			}
			for (const toolName of disabledTools) {
				enabledTools[toolName] = false;
			}

			return {
				enabledTools,
				declaredTools,
				disabledTools,
				unknownTools: [],
			};
		}

		const rawTools = agent.tools;
		if (!rawTools || rawTools.length === 0) {
			// No tool restriction — agent can use all tools
			return undefined;
		}

		// Expand legacy aliases → current Saros tool names
		const declared = this.expandToolAliases(rawTools);
		const unknownTools = declared.filter(t => !registeredSet.has(t));
		const disabledTools = [...registeredSet].filter(t => !declared.includes(t));

		// Build the enablement map: declared tools → true, everything else → false
		const enabledTools: Record<string, boolean> = {};

		// Enable declared tools (including unknown ones — they may be resolved lazily)
		for (const toolName of declared) {
			enabledTools[toolName] = true;
		}

		// Explicitly disable registered tools not declared
		for (const toolName of disabledTools) {
			enabledTools[toolName] = false;
		}

		return {
			enabledTools,
			declaredTools: declared,
			disabledTools,
			unknownTools,
		};
	}

	isToolAllowed(agent: Agent, toolName: string): boolean {
		// SandboxMode.ReadOnly — only read-only tools allowed
		if (agent.sandbox === SandboxMode.ReadOnly) {
			return READ_ONLY_TOOL_NAMES.includes(toolName);
		}

		const rawTools = agent.tools;
		if (!rawTools || rawTools.length === 0) {
			// No restriction — all tools allowed
			return true;
		}
		const expanded = this.expandToolAliases(rawTools);
		return expanded.includes(toolName);
	}

	getKnownToolNames(): readonly string[] {
		return Object.values(VSSAROS_TOOL_NAMES);
	}

	getToolMetadata(): ReadonlyArray<{ name: string; label: string; description: string; category: string }> {
		return Object.entries(TOOL_METADATA).map(([name, meta]) => ({
			name,
			label: meta.label,
			description: meta.description,
			category: meta.category,
		}));
	}
}
