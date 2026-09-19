/*---------------------------------------------------------------------------------------------
 *  Hard Permission (MiMo-Code-inspired)
 *
 *  `hardPermission` is an INVARIANT layer appended AFTER all other tool filtering
 *  (enabledToolsets / allowlist / toolsetsOverride / disabledToolsets). Tools matched by
 *  the hard-permission policy are unconditionally removed from the LLM-visible tool list
 *  and cannot be re-enabled by toolset config, user approval, or an agent prompt.
 *
 *  This mirrors MiMo-Code's `hardPermission` post-append: e.g. plan mode locks every
 *  file-write / execute tool so the agent literally cannot mutate the workspace no matter
 *  what it (or the user) tries.
 *
 *  Pure + dependency-free → fully unit-testable.
 *--------------------------------------------------------------------------------------------*/

import type { IToolDefinition } from './providers.js';

export interface IHardPermissionPolicy {
	/** Tool-name / prefix patterns that are unconditionally denied. */
	readonly deniedToolPatterns: readonly string[];
	/** Optional human-readable reason shown to the user / logged. */
	readonly reason?: string;
}

/**
 * True if `toolName` is matched by the hard-permission policy.
 * Supports exact match and trailing-`*` prefix match.
 */
export function isToolHardDenied(toolName: string, policy: IHardPermissionPolicy | undefined): boolean {
	if (!policy || policy.deniedToolPatterns.length === 0) {
		return false;
	}
	return policy.deniedToolPatterns.some((p) => {
		if (p === toolName) { return true; }
		if (p.endsWith('*') && toolName.startsWith(p.slice(0, -1))) { return true; }
		return false;
	});
}

/**
 * Strip hard-denied tools from a list *after* all other filtering has run.
 * Pure: returns a new array; never mutates the input.
 */
export function applyHardPermission<T extends { name: string }>(
	tools: readonly T[],
	policy: IHardPermissionPolicy | undefined,
): T[] {
	if (!policy || policy.deniedToolPatterns.length === 0) {
		return tools.slice();
	}
	// 无条件放行：检索/只读工具不在 hardPermission 过滤范围
	return tools.filter((t) => isAlwaysPermittedRetrievalTool(t.name) || !isToolHardDenied(t.name, policy));
}

/**
 * The default hard-permission policy for plan mode: every file-write / execute tool is
 * unconditionally locked. The agent may read and plan but cannot mutate the workspace.
 */
export function planModeHardPermission(): IHardPermissionPolicy {
	return {
		deniedToolPatterns: [
			// 文件写入和编辑
			'write', 'write_to_file', 'write_file', 'apply_diff', 'create_file', 'edit_file',
			'edit', 'rename_file', 'delete_file', 'file_write', 'file_edit', 'file_delete',
			'patch',  // patch 可以修改文件
			// 终端和命令执行
			'terminal_cmd', 'terminal', 'bash', 'shell', 'exec', 'process',
			'execute_code', 'run_command',
			// 文件系统操作
			'mkdir', 'mv', 'cp', 'rename', 'chmod', 'rm',
			// 浏览器交互副作用
			'browser_click', 'browser_type', 'browser_navigate', 'browser_submit',
			// codebase 写操作
			'index_repository', 'delete_project', 'ingest_traces', 'manage_adr',
			// skill 修改
			'skill_manage',
			// 部署和发布
			'deploy', 'publish', 'push',
			// 桥接工具（可能绕过权限）
			'tool_call',
		],
		reason: 'plan mode: write/execute/mutate tools are locked (plan files exempted at runtime)',
	};
}

/**
 * Runtime interception check: should a tool call be DENIED by hard permission?
 *
 * Unlike `applyHardPermission` (which strips tools from the schema BEFORE the LLM
 * sees them), this function is called at EXECUTION time — the tool remains in the
 * schema (LLM can attempt to call it), but the call is blocked and an error result
 * is returned to the LLM.
 *
 * This mirrors MiMo-Code's `ctx.ask({ permission: "edit" })` runtime evaluation:
 * tools stay in the schema (prefix-cache stable), permission is a backstop.
 *
 * @param toolName The tool being called
 * @param policy The hard-permission policy (from _resolveHardPermission)
 * @returns `{ denied: true, reason }` if blocked, `{ denied: false }` if allowed
 */
/**
 * 无条件放行的检索/只读工具前缀白名单。
 * 这些工具在任何模式（plan / ask / chatOnly / workMode=plan）下都必须可用，
 * 不受 hardPermission 或模式过滤影响。
 * 
 * 覆盖范围：图谱搜索、代码片断、文件搜索与读取、项目列举与状态查询。
 */
export const ALWAYS_PERMITTED_RETRIEVAL_TOOLS: readonly string[] = [
	// 图谱搜索 / 遍历
	'search_graph', 'query_graph', 'trace_path',
	// 代码片断提取
	'get_code_snippet',
	// 通用代码 / 文件搜索
	'search_code', 'search_files',
	// 文件读取（只读）
	'file_read',
	// 项目与索引状态（只读）
	'list_projects', 'index_status',
	// 架构浏览
	'get_architecture',
];

/**
 * 检查工具名是否匹配无条件放行白名单（精确匹配或前缀匹配）。
 */
export function isAlwaysPermittedRetrievalTool(toolName: string): boolean {
	return ALWAYS_PERMITTED_RETRIEVAL_TOOLS.some((p) => toolName === p || (p.endsWith('*') && toolName.startsWith(p.slice(0, -1))));
}

export function isToolCallDeniedByHardPermission(
	toolName: string,
	policy: IHardPermissionPolicy | undefined,
): { denied: boolean; reason?: string } {
	// 无条件放行：检索/只读工具不受 hardPermission 限制
	if (isAlwaysPermittedRetrievalTool(toolName)) {
		return { denied: false };
	}
	if (isToolHardDenied(toolName, policy)) {
		return { denied: true, reason: policy?.reason ?? 'denied by hard permission' };
	}
	return { denied: false };
}

/**
 * 本轮工具调用的**统一硬权限判据**：合并两个来源的拦截意图。
 *
 *  - `policy`（`IHardPermissionPolicy`，模式表）——由 workMode 驱动，
 *    来源 `agentOSService._resolveHardPermissionForWorkMode`（plan 模式）。
 *  - `strategyCheck`（谓词）——由范式策略驱动，来源
 *    `IterationPlan.hardPermission`（如 `readonlyStrategy` 的写工具黑名单）。
 *
 * 为什么需要这个函数：两个来源**形状不同**（模式表 vs 谓词），此前执行器只认
 * 前者，导致策略侧的 `hardPermission` 被 `turnIterationGate` 静默丢弃 ——
 * readonly 范式只剩 schema 层过滤（`toolDefs`），运行时零拦截。模型一旦调用
 * 不在本轮工具面里的写工具名（历史里出现过、或凭记忆幻觉），就会**真实执行**。
 * 与 plan 模式的双层拦截（schema `applyHardPermission` + 运行时判据）不对等。
 *
 * `source` 用于让调用方区分文案与豁免：计划文件豁免（`plans/*.md`）只对
 * `policy` 来源成立 —— readonly 范式的语义是「什么都不写」，写计划文件同样拦。
 */
export function isToolCallDeniedByTurnPolicy(
	toolName: string,
	policy: IHardPermissionPolicy | undefined,
	strategyCheck?: (tool: string) => boolean,
): { denied: boolean; reason?: string; source?: 'policy' | 'strategy' } {
	// 无条件放行：检索/只读工具不受任何来源限制（含策略谓词）——
	// 只读代理的本职就是检索，策略黑名单不该误伤白名单读工具。
	if (isAlwaysPermittedRetrievalTool(toolName)) {
		return { denied: false };
	}
	const byPolicy = isToolCallDeniedByHardPermission(toolName, policy);
	if (byPolicy.denied) {
		return { ...byPolicy, source: 'policy' };
	}
	if (strategyCheck?.(toolName)) {
		return { denied: true, reason: 'denied by loop strategy (paradigm restriction)', source: 'strategy' };
	}
	return { denied: false };
}

export type { IToolDefinition };
