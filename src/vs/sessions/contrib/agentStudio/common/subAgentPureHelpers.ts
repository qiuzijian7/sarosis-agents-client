/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 子代理纯函数助手（A3 同款拆分策略第二刀，2026-09-20）。
 *
 * 从 `unifiedSubAgentDispatch.ts` 的 `UnifiedSubAgentDispatch` 类中搬出**零 `this` 依赖**的方法
 * （判定依据：实测各方法体内 `this.` 出现次数 — 本模块四者全为 0）。原样搬运 ⇒ 零行为改动；
 * 调用点直接改指本模块（不保留薄委托，避免多一层间接）。
 *
 * 附带收益：`_extractModifiedFile` 的写文件工具表此前**每次调用都新建一个 Record**
 * （每个 tool_result 都走一次），现提升为模块级常量。
 *
 * ⚠ 与类内私有方法的可见性差异：这些函数是模块导出（此前是 private）—— 请勿在别处再实现同语义
 * 逻辑（单一来源）。
 */

import type { IChatMessage } from './providers.js';
import type { ICompletionGateContext } from './completionGate.js';
import { extractAcceptanceCriteria } from './completionGate.js';
import { injectReturnFormatIntoTask } from './subAgentReturnFormat.js';
import { wrapUserQuery } from './userQuery.js';
import { _EXPLORE_REAL_TOOLS, SUB_AGENT_PERMISSIONS, SubAgentType } from './subAgentModel.js';
import type { _ExecResult, SubAgentInstance } from './subAgentLifecycle.js';
import { buildResponseLanguageDirective } from './responseLanguage.js';
import { composeFrozenPrefix, joinSections } from './systemPromptComposer.js';
import { GLOBAL_SYSTEM_PREFIX_SUBAGENT, GLOBAL_SYSTEM_SUFFIX } from './chatModeConfig.js';

/** 该类型 + 工具名是否被权限矩阵放行（原 `UnifiedSubAgentDispatch.isToolAllowed` 的方法体）。 */
export function isToolAllowedForType(type: SubAgentType, toolName: string): boolean {
	const perms = SUB_AGENT_PERMISSIONS[type];
	// If there's an explicit allow list that's not '*', check against it
	if (perms.allowedToolPatterns.length > 0 && !perms.allowedToolPatterns.includes('*')) {
		const matchesAllow = perms.allowedToolPatterns.some(pattern => {
			if (pattern === toolName) { return true; }
			if (pattern.endsWith('*') && toolName.startsWith(pattern.slice(0, -1))) { return true; }
			return false;
		});
		if (!matchesAllow) { return false; }
	}
	// Check deny list
	if (perms.deniedToolPatterns.includes(toolName) || perms.deniedToolPatterns.includes('*')) {
		// Deny '*' means deny all except explicitly allowed
		if (perms.deniedToolPatterns.includes('*') && perms.allowedToolPatterns.includes(toolName)) {
			return true; // Explicitly allowed overrides deny-all
		}
		return false;
	}
	return true;
}

/** 子代理的起始消息（原 `_buildMessages`）：context 前缀 + 任务（可选注入返回格式契约）。 */
export function buildSubAgentMessages(subAgent: SubAgentInstance): IChatMessage[] {
	const messages: IChatMessage[] = [];

	// MiMo RETURN_FORMAT 契约（2026-07-23）：非 forkContext 子代理的任务消息
	// 注入强制返回格式（**Status**/**Summary** 头）。契约随任务消息下发，
	// 系统提示词保持不变（冻结前缀缓存不受影响）；完成门据此优先采信
	// 模型自报状态（parseReturnHeader），无头时回退推断。
	// forkContext（peer/plan，主 agent 级角色）不注入 —— 保持父级语义。
	const task = subAgent.options.forkContext
		? subAgent.task
		: injectReturnFormatIntoTask(subAgent.task);

	// Inject context as a system-like user message prefix
	// task 用 <user_query>...</user_query> 包装，使子 agent 明确区分「用户真实指令」
	// 与注入的 codebase 上下文。
	if (subAgent.options.context) {
		messages.push({
			role: 'user',
			content: `## Codebase Context\n\n${subAgent.options.context}\n\n---\n\n## Task\n\n${wrapUserQuery(task)}`,
		});
	} else {
		messages.push({
			role: 'user',
			content: wrapUserQuery(task),
		});
	}

	return messages;
}

/** 完成门的上下文（原 `_buildGateContext`，含探索型 ground-truth 判定）。 */
export function buildSubAgentGateContext(
	subAgent: SubAgentInstance,
	exec: _ExecResult,
	incompleteTasks?: readonly string[],
): ICompletionGateContext {
	const acceptance = extractAcceptanceCriteria(subAgent.task);
	// B：探索型子代理 ground-truth — 该子代理调用了工具、但没有任何真正的探索类工具。
	// 纯代码事实判定（toolTrace 是真实执行记录，不依赖 LLM 自述）：
	//   - toolTrace.length > 0：要求子代理确实执行过工具（排除零工具调用场景——零工具可能是
	//     合理的"从上下文直接作答"，也是重试测试的合法形态，不应误降级）。
	//   - !usedRealExploration：但所有调用都不属于探索类工具（如只调用了索引/元工具），
	//     说明子代理"看似忙了，实际没探索"，由 gateResult 把 status 降级为 partial。
	const usedRealExploration = exec.toolTrace.some(t => _EXPLORE_REAL_TOOLS.has(t.toolName));
	const noRealExploration = subAgent.type === SubAgentType.Explore
		&& exec.toolTrace.length > 0
		&& !usedRealExploration;
	return {
		filesTouched: exec.filesModified,
		errored: false,
		truncated: exec.budgetExhausted || !!exec.stalled,
		acceptanceCriteria: acceptance.length > 0 ? acceptance : undefined,
		incompleteTasks,
		noRealExploration,
	};
}

/** 写文件类工具 → 其参数中的路径键（模块级常量，避免每次调用重建）。 */
const FILE_WRITE_TOOLS: Record<string, string> = {
	'write_to_file': 'path',
	'apply_diff': 'path',
	'create_file': 'path',
	'edit_file': 'path',
	'write': 'path',
	'edit': 'path',
	'rename_file': 'path',
	'delete_file': 'path',
	'file_write': 'path',
	'file_edit': 'path',
};

/** 从工具调用参数中取「被修改的文件路径」（原 `_extractModifiedFile`）。 */
export function extractModifiedFile(toolName: string, args: Record<string, unknown>): string | undefined {
	const pathKey = FILE_WRITE_TOOLS[toolName];
	if (!pathKey) { return undefined; }

	const filePath = args[pathKey];
	if (typeof filePath === 'string' && filePath.length > 0) {
		return filePath;
	}
	return undefined;
}

/** 字节数格式化（原 `_formatBytes`，模块级纯函数）。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) { return String(bytes) + ' B'; }
	const units = ['KB', 'MB', 'GB'];
	let i = 0;
	let size = bytes / 1024;
	while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
	return size.toFixed(1) + ' ' + units[i];
}
/** 子代理系统提示词（原 ``_buildSystemPrompt``；原 ``this`` 依赖以参数显式传入——两处语言设置）。 */
export function buildSubAgentSystemPrompt(subAgent: SubAgentInstance, responseLanguageSetting?: string, languageSetting?: string): string {
		// Fork prefix-cache alignment (MiMo): reuse the parent's frozen system
		// prompt verbatim so the LLM provider's prompt cache hits.
		if (subAgent.options.forkContext) {
			return subAgent.options.forkContext.systemPrompt;
		}
		const typePrompts: Record<SubAgentType, string> = {
			[SubAgentType.Explore]: `You are a code-explorer sub-agent. You excel at thoroughly navigating and understanding codebases.

## TOOL CALL BUDGET (strictly enforced):
| Tool | Max Calls | Purpose |
|------|-----------|---------|
| search_graph | 5 | Find symbols, classes, functions by name |
| search_code | 5 | Grep content patterns across ALL files |
| search_files | 10 | List file names matching a pattern ONLY |
| file_read | 15 | Read specific files you ALREADY identified |
| get_code_snippet | 3 | Get full code for a specific symbol |
TOTAL BUDGET: ~30 calls. Exceeding this wastes time and LLM tokens.

## MANDATORY WORKFLOW (follow this exact sequence):
1. **search_graph** — Find key symbols/classes/functions related to the task (3-5 calls)
2. **search_code** — Grep for content patterns if search_graph didn't find them (2-3 calls)
3. **search_files** — ONLY to verify file names exist (5-10 calls max)
4. **file_read** — Read ONLY the files you identified as relevant (10-15 calls)
5. **get_code_snippet** — Get full code for 2-3 most critical symbols
6. **STOP** — You now have enough information. Produce your output.

## ANTI-PATTERNS (never do these):
- ❌ Calling search_files 20+ times to scan a directory — use search_code instead
- ❌ Repeating the same search_files query — if it returned no results, it won't magically work
- ❌ Reading files you haven't verified are relevant — read only after search confirms relevance
- ❌ Searching for the same pattern in different directories — search_code searches ALL files at once
- ❌ Continuing to search after finding the key files — STOP and START reading

## CRITICAL TOOL DISTINCTION:
- **search_code** = grep. Searches file CONTENTS for a pattern across ALL files. Use this to find where a variable/function is used.
- **search_files** = file listing. Searches file NAMES matching a pattern. Use this ONLY when you need to know what files exist, not what's inside them.
- **search_graph** = structural search. Finds symbols, callers, dependencies. Use this FIRST.

## Rules:
- DO NOT edit/modify any files — you are in read-only mode
- NEVER call delegate_task recursively (you ARE a sub-agent)
- Always use search_graph as your FIRST tool
- When you have found the key files (usually after 15-20 tool calls), STOP searching and START reading
- Report findings in a clear structured format`,

			[SubAgentType.General]: `You are a general-purpose agent. You can read, write, and execute commands.
- Complete the task described by the user
- You CAN spawn sub-agents using delegate_task when the task can be decomposed into independent parallel subtasks
- Report your results clearly
- If you encounter errors, explain what went wrong

## When to use delegate_task:
- The task can be decomposed into 2+ independent subtasks
- You need to run multiple independent investigations simultaneously
- The subtask is complex enough to benefit from a dedicated context

## When NOT to use delegate_task:
- The task is simple and can be completed in one turn
- You need to maintain ongoing context/memory across steps
- You are already at maximum spawn depth (check parent agent constraints)

## Writing a good delegated task (CRITICAL):
- The sub-agent you spawn starts BLANK — it has no access to your conversation.
- Write each task as a self-contained briefing:
  GOAL (what to accomplish + why), CONTEXT (what you already know / ruled out),
  ACCEPTANCE (how to know it is done + output limits, e.g. "report in <200 words").
- Batch tasks (tasks: [...]) must be mutually independent; sequence dependent steps inside one task string.
- Pick a role with \`type\`: General (read+write), Explore (read-only investigate), Scout (read-only research).
  Batch tasks default to Explore — set General if the batched task must write files.`,

			[SubAgentType.Scout]: `You are a research agent for external libraries, dependency source, and documentation.
- Use repo_clone first when the task involves a GitHub repository
- After cloning, use Glob, Search Code, Read to inspect the cloned repository
- Use WebFetch for official documentation pages
- Use WebSearch to find relevant documentation
- DO NOT edit any files — you are in read-only mode
- Focus on understanding architecture, patterns, and key abstractions`,
		};

	// 经统一 composer 组装（stable-only：子 agent 无 context/volatile 膨胀），
	// 保证与主 loop 相同的 \n\n 分节与前缀指纹口径（P4 单源构造器）。
	// 子代理用 GLOBAL_SYSTEM_PREFIX_SUBAGENT（2026-07-26）：去除委派导向段落，
	// 杜绝子代理被诱导嵌套委派（事故 1785037741973）。
	// agentId 驱动（2026-07-27）：委派 / plan_explore / pre-loop 解析到内置 Agent 后，
	// 直接用其真实 systemPrompt 作为 stable 主体，替代按 type 选取的通用折中提示词。
	const stablePrompt = subAgent.options.systemPrompt || typePrompts[subAgent.type] || typePrompts[SubAgentType.General];
	// 回答语言限制（与父代理一致，Hermes 风格）：'auto' 跟随 Agent Studio 显示语言设置
	//（this.languageSetting，默认 zh-CN），不探测操作系统语言。父代理显式覆盖场景经
	// forkContext 路径复用父 frozen prompt 已含该指令。
	const responseLangDirective = buildResponseLanguageDirective(responseLanguageSetting, languageSetting);
	return composeFrozenPrefix({
		stable: joinSections(
			stablePrompt,
			GLOBAL_SYSTEM_PREFIX_SUBAGENT,
			GLOBAL_SYSTEM_SUFFIX,
			responseLangDirective,
		),
			context: '',
			volatile: '',
		});
}