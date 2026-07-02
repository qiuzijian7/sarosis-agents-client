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
			'todo', 'memory', 'patch', 'process',
			'web_search', 'web_extract',
			'skills_list', 'skill_view', 'skill_manage',
			'session_search', 'execute_code', 'delegate_task',
			'read_skill', 'list_skills',
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
		id: 'delegation',
		label: 'Delegation',
		priority: ToolsetPriority.High,
		prefixes: ['delegate_'],
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
