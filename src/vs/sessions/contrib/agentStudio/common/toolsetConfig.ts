/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Toolset 配置 — 参考 Hermes-Agent 的 `toolsets.py` 设计。
 *
 * 每个工具都属于一个 toolset，toolset 决定了工具的：
 *   1. 优先级 — 核心工具始终发送给 LLM，非核心工具按名额填充
 *   2. 可折叠性 — 非核心工具超过 token 阈值时折叠为 tool_search + tool_call 桥接
 *   3. Agent 级配置 — Agent 可声明 enabledToolsets，仅保留这些 toolset 的工具
 *
 * 与 Hermes 的差异：
 *   - Hermes 用 Python dict + includes 递归组合
 *   - Sarosis 用 TS Map + 名称模式匹配自动推断 toolset
 *   - 不支持嵌套 includes（Sarosis 工具数量远少于 Hermes，不需要组合）
 */

// ─── Toolset 优先级 ──────────────────────────────────────────────────────

export enum ToolsetPriority {
	/** 始终发送给 LLM，不可折叠 */
	Always = 0,
	/** 高优先级 — 尽量发送，仅在极端 token 超限时折叠 */
	High = 1,
	/** 中优先级 — 按名额填充，超过阈值时折叠 */
	Medium = 2,
	/** 低优先级 — 优先折叠为桥接工具 */
	Low = 3,
}

// ─── Toolset 定义 ────────────────────────────────────────────────────────

export interface IToolsetDefinition {
	/** toolset 唯一标识 */
	readonly id: string;
	/** 人类可读名称 */
	readonly label: string;
	/** 优先级 */
	readonly priority: ToolsetPriority;
	/** 工具名前缀列表 — 用于自动推断工具所属 toolset */
	readonly prefixes: readonly string[];
	/** 工具名精确匹配列表 — 用于前缀无法覆盖的情况 */
	readonly exactNames?: readonly string[];
	/** 是否可折叠为 tool_search + tool_call 桥接 */
	readonly deferrable: boolean;
}

/**
 * Toolset 定义表 — 按优先级从高到低排列。
 * 第一个匹配的工具集胜出（优先级高的在前）。
 */
export const TOOLSET_DEFINITIONS: readonly IToolsetDefinition[] = [
	{
		id: 'core',
		label: 'Core',
		priority: ToolsetPriority.Always,
		prefixes: ['file_', 'search_files', 'terminal', 'memory_'],
		exactNames: [
			'echo', 'get_current_time', 'math_eval', 'http_get',
			'update_plan', 'memory', 'patch', 'process',
			'web_search', 'web_extract',
			'skills_list', 'skill_view', 'skill_manage', 'skill_create',
			'session_search', 'execute_code', 'delegate_task',
			'read_skill', 'list_skills',
			'clarify', // 2026-07-13: 用户交互核心工具（LLM 向用户提问并等待选择），归入 core 避免被 utility 路径过滤掉
		],
		deferrable: false,
	},
	{
		id: 'mcp-bridge',
		label: 'MCP Bridge',
		priority: ToolsetPriority.Always,
		prefixes: ['mcp_tool_'],
		deferrable: false,
	},
	{
		id: 'mcp',
		label: 'MCP Tools',
		priority: ToolsetPriority.Medium,
		prefixes: ['mcp_'],
		deferrable: true,
	},
	{
		id: 'tool-search',
		label: 'Tool Search',
		priority: ToolsetPriority.Always,
		prefixes: ['tool_search', 'tool_describe', 'tool_call'],
		deferrable: false,
	},
	{
		id: 'workflow',
		label: 'Workflow',
		priority: ToolsetPriority.High,
		prefixes: ['workflow_'],
		deferrable: false,
	},
	{
		id: 'codebase',
		label: 'Codebase',
		priority: ToolsetPriority.High,
		prefixes: [],
		exactNames: [
			'search_graph', 'query_graph', 'get_architecture', 'get_code_snippet',
			'get_graph_schema', 'index_repository', 'index_status', 'list_projects',
			'delete_project', 'detect_changes', 'trace_path', 'ingest_traces',
			'manage_adr', 'search_code',
		],
		deferrable: false,
	},
	{
		id: 'delegation',
		label: 'Delegation',
		priority: ToolsetPriority.High,
		prefixes: ['delegate_'],
		exactNames: ['new_agent'],
		deferrable: false,
	},
	{
		id: 'knowledge',
		label: 'Knowledge',
		priority: ToolsetPriority.High,
		prefixes: ['kb_'],
		deferrable: false,
	},
	{
		id: 'memory',
		label: 'Memory',
		priority: ToolsetPriority.Medium,
		prefixes: ['memory_'],
		deferrable: true,
	},
	{
		id: 'skill',
		label: 'Skills',
		priority: ToolsetPriority.Medium,
		prefixes: ['read_skill', 'list_skills', 'skill_'],
		deferrable: true,
	},
	{
		id: 'browser',
		label: 'Browser',
		priority: ToolsetPriority.Medium,
		prefixes: ['browser_'],
		deferrable: true,
	},
	{
		id: 'kanban',
		label: 'Kanban',
		priority: ToolsetPriority.Low,
		prefixes: ['kanban_'],
		deferrable: true,
	},
	{
		id: 'utility',
		label: 'Utility',
		priority: ToolsetPriority.Low,
		prefixes: [],
		deferrable: true,
	},
];

// ─── 工具名 → toolset 推断 ──────────────────────────────────────────────

const _toolsetCache = new Map<string, string>();

/**
 * 根据工具名推断其所属 toolset。
 * 按优先级顺序匹配 prefixes 和 exactNames，第一个匹配的胜出。
 */
export function getToolsetForTool(toolName: string): string {
	const cached = _toolsetCache.get(toolName);
	if (cached !== undefined) {
		return cached;
	}

	for (const ts of TOOLSET_DEFINITIONS) {
		if (ts.exactNames?.includes(toolName)) {
			_toolsetCache.set(toolName, ts.id);
			return ts.id;
		}
		for (const prefix of ts.prefixes) {
			if (toolName.startsWith(prefix)) {
				_toolsetCache.set(toolName, ts.id);
				return ts.id;
			}
		}
	}

	// 默认归入 utility
	_toolsetCache.set(toolName, 'utility');
	return 'utility';
}

/**
 * 获取 toolset 的优先级。
 */
export function getToolsetPriority(toolsetId: string): ToolsetPriority {
	const ts = TOOLSET_DEFINITIONS.find(t => t.id === toolsetId);
	return ts?.priority ?? ToolsetPriority.Low;
}

/**
 * 判断 toolset 是否可折叠为桥接工具。
 */
export function isToolsetDeferrable(toolsetId: string): boolean {
	const ts = TOOLSET_DEFINITIONS.find(t => t.id === toolsetId);
	return ts?.deferrable ?? true;
}

// ─── 默认启用的 toolset ─────────────────────────────────────────────────

/**
 * 默认启用的 toolset 列表（Agent 未配置 enabledToolsets 时使用）。
 * 不包含 deferrable=true 的 toolset（它们按名额填充或折叠为桥接）。
 */
export const DEFAULT_ENABLED_TOOLSETS: readonly string[] = TOOLSET_DEFINITIONS
	.filter(t => t.priority === ToolsetPriority.Always || t.priority === ToolsetPriority.High)
	.map(t => t.id);

// ─── 桥接工具名称 ────────────────────────────────────────────────────────

/** Tool Search 桥接工具名称 */
export const TOOL_SEARCH_BRIDGE_TOOLS = {
	search: 'tool_search',
	describe: 'tool_describe',
	call: 'tool_call',
} as const;

/** 判断工具名是否为桥接工具 */
export function isBridgeTool(toolName: string): boolean {
	return toolName === TOOL_SEARCH_BRIDGE_TOOLS.search
		|| toolName === TOOL_SEARCH_BRIDGE_TOOLS.describe
		|| toolName === TOOL_SEARCH_BRIDGE_TOOLS.call;
}

// ─── 核心工具白名单（双重保护，对齐 Hermes `toolsets._HERMES_CORE_TOOLS`）──
//
// 设计：核心工具的"双重保护"机制 — 即使 toolset 标记为 deferrable=true，
// 核心工具名也会在 `isCoreTool()` 检查中返回 true，从而强制不被延迟。
//
// 实际场景：MCP 工具可能注册到与核心工具同名/类似名的 key，
// 但核心工具必须永远直接发送给 LLM（对齐 Hermes `tool_search.py:163-186`）。

/** 核心工具白名单 — 永远直接发送给 LLM，永不延迟（对齐 Hermes `_HERMES_CORE_TOOLS`） */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
	// 文件操作 — 任何 Agent 的基础
	'file_read', 'file_write', 'file_edit', 'file_delete',
	'read_file', 'write_file', 'patch', 'search_files',
	'read_dir', 'list_files',
	// 终端 / 进程 — 关键调试能力
	'terminal', 'process', 'read_terminal', 'close_terminal',
	// 记忆 / 任务规划
	'memory', 'memory_search', 'memory_write', 'memory_list',
	'update_plan',
	// 搜索 / 提取
	'web_search', 'web_extract', 'http_get',
	// Session 搜索
	'session_search',
	// 技能调用 — 任何 Agent 都需要
	'skills_list', 'skill_view', 'skill_manage', 'skill_create',
	'read_skill', 'list_skills',
	// 浏览器（用于 LLM 看到浏览器工具但实际被沙箱限制时仍可调用基础导航）
	'browser_navigate', 'browser_snapshot', 'browser_click',
	'browser_type', 'browser_scroll', 'browser_back',
	// 委派 / 代码执行
	'delegate_task', 'new_agent', 'execute_code',
	// 工具搜索桥接工具 — 本身就不能被延迟
	TOOL_SEARCH_BRIDGE_TOOLS.search,
	TOOL_SEARCH_BRIDGE_TOOLS.describe,
	TOOL_SEARCH_BRIDGE_TOOLS.call,
	// 通用实用工具
	'echo', 'get_current_time', 'math_eval',
]);

/** 核心工具的 toolset 集合（用于批量检查） */
export const CORE_TOOLSET_IDS: ReadonlySet<string> = new Set([
	'core', 'mcp-bridge', 'tool-search',
]);

/**
 * 判断工具是否为核心工具（双重保护第一层）。
 * 对齐 Hermes `is_deferrable_tool_name` 中的 `_core_tool_names()` 检查。
 *
 * 即使 toolset 标记为 deferrable=true，核心工具也强制返回 true。
 */
export function isCoreTool(toolName: string): boolean {
	return CORE_TOOLS.has(toolName);
}

/**
 * 判断 toolset 是否为受保护的核心 toolset（双重保护第二层）。
 * 对齐 Hermes `_HERMES_CORE_TOOLS` 整体保护机制。
 */
export function isCoreToolset(toolsetId: string): boolean {
	return CORE_TOOLSET_IDS.has(toolsetId);
}
