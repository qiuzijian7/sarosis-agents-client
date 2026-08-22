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
 *   - Saros 用 TS Map + 名称模式匹配自动推断 toolset
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
		// ⚠ 不含 `memory_` 前缀（2026-08-22 修，日志 1787363991734）：
		// `getToolsetForTool` 按定义顺序「第一个匹配胜出」，而 core 排最前；
		// 早前 core 的 prefixes 含 `memory_`，会把全部 16 个 memory_* 工具抢先
		// 归入 core（Always + 不可折叠）→ 后面的 `memory` toolset（Medium + deferrable）
		// 形同虚设。后果：58 个 direct-sent 工具里塞满 memory_*，schema 直接发送
		// 浪费 ~3–4k token 却几乎不被调用。移除后 memory_* 归入独立 memory toolset，
		// 可折叠进 tool_search 桥接；`memory_list` 仍由 CORE_TOOLS 白名单兜底不可折叠。
		prefixes: ['file_', 'search_files', 'terminal'],
		exactNames: [
			'update_plan', 'plan_explore', 'plan_enter', 'plan_exit', 'plan_register',
			'switch_paradigm',
			'patch', 'process',
		'web_search', 'web_extract',
		'skill_manage',
		'session_search', 'execute_code', 'delegate_task',
		'read_skill', 'list_skills',
			// Mermaid 图示 — core Always 优先级确保 LLM 可调用
			'rendermermaiddiagram',
			'clarify', // 2026-07-13: 用户交互核心工具（LLM 向用户提问并等待选择），归入 core 避免被 utility 路径过滤掉
			// ── codebase graph tools: Always priority — 代码检索优先走结构化索引 ──
			'search_graph', 'query_graph', 'trace_path',
			'get_architecture', 'get_graph_schema', 'get_code_snippet',
			'index_repository', 'index_status', 'list_projects',
			'delete_project', 'detect_changes', 'ingest_traces',
			'manage_adr',
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
		// 'workflow'（无下划线）= 动态工作流编排工具（模型写 JS 脚本扇出子代理）
		exactNames: ['workflow'],
		deferrable: false,
	},
	{
		id: 'codebase-grep',
		label: 'Codebase Grep',
		priority: ToolsetPriority.High,
		prefixes: [],
		exactNames: [
			'search_code',
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
		id: 'canvas',
		label: 'Canvas',
		priority: ToolsetPriority.Low,
		prefixes: ['mindmap_'],
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
 * 动态 toolsets 以 `mcp-` 开头自动识别为 Medium 优先级。
 */
export function getToolsetPriority(toolsetId: string): ToolsetPriority {
	const ts = TOOLSET_DEFINITIONS.find(t => t.id === toolsetId);
	if (ts) { return ts.priority; }
	// 动态 toolset：mcp-{server} → Medium（对齐 Hermes-Agent mcp-{server} 模式）
	if (toolsetId.startsWith('mcp-')) { return ToolsetPriority.Medium; }
	return ToolsetPriority.Low;
}

/**
 * 判断 toolset 是否可折叠为桥接工具。
 * 动态 toolsets 以 `mcp-` 开头自动识别为 deferrable。
 */
export function isToolsetDeferrable(toolsetId: string): boolean {
	const ts = TOOLSET_DEFINITIONS.find(t => t.id === toolsetId);
	if (ts) { return ts.deferrable; }
	// 动态 toolset：mcp-{server} → deferrable
	if (toolsetId.startsWith('mcp-')) { return true; }
	return true;
}

/**
 * 判断 toolset 是否为动态 toolset（非静态定义，运行时自动创建）。
 * 当前仅 `mcp-{server}` 为动态 toolset。
 */
export function isDynamicToolset(toolsetId: string): boolean {
	return toolsetId.startsWith('mcp-');
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
	'file_read', 'write_file', 'patch', 'search_files',
	'read_dir', 'list_files',
	// 终端 / 进程 — 关键调试能力
	'terminal', 'process', 'read_terminal', 'close_terminal',
	// 记忆 / 任务规划
	'memory_list',
	'update_plan',
	// 搜索 / 提取
	'web_search', 'web_extract',
	// Session 搜索
	'session_search',
	// 技能调用 — 任何 Agent 都需要
	'skill_manage',
	'read_skill', 'list_skills',
	// Mermaid 图示 — 图表渲染
	'rendermermaiddiagram',
	// 浏览器（用于 LLM 看到浏览器工具但实际被沙箱限制时仍可调用基础导航）
	'browser_navigate', 'browser_snapshot', 'browser_click',
	'browser_type', 'browser_scroll', 'browser_back',
	// 委派 / 代码执行
	'delegate_task', 'new_agent', 'execute_code',
	// 工具搜索桥接工具 — 本身就不能被延迟
	TOOL_SEARCH_BRIDGE_TOOLS.search,
	TOOL_SEARCH_BRIDGE_TOOLS.describe,
	TOOL_SEARCH_BRIDGE_TOOLS.call,
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
