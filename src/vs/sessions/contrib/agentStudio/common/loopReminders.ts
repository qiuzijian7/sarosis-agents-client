/*---------------------------------------------------------------------------------------------
 *  AgentLoop 注入文本常量（自 agentTurnExecutor.ts 硬编码提取，2026-07-27）。
 *
 *  所有注入 LLM 的 <system-reminder> 文本集中管理，便于审计/调整/国际化。
 *  每个函数返回完整的 reminder 文本（含 <system-reminder> 标签），
 *  调用方直接 `messages = appendMessages(messages, { role: 'user', content: reminderFn(...) })`。
 *--------------------------------------------------------------------------------------------*/

// ─── 工具连续失败恢复提示 ────────────────────────────────────────────────────

/** 同一工具连续失败 N 次后注入，引导 LLM 读错误信息并换策略。 */
export function toolConsecutiveFailureReminder(toolName: string, failCount: number): string {
	return [
		'<system-reminder>',
		`The tool "${toolName}" has failed ${failCount} times in a row.`,
		'READ THE ERROR MESSAGE CAREFULLY and fix the specific issue instead of retrying with similar arguments.',
		'If you are unsure about the correct parameters, use a different tool or ask the user for clarification.',
		'Do NOT retry with the same pattern — each failure costs a turn.',
		'</system-reminder>',
	].join('\n');
}

// ─── Terminal 连续空输出提示 ─────────────────────────────────────────────────

/** Terminal 连续返回 (no output) N 次后注入，引导 LLM 换搜索工具。 */
export function terminalEmptyOutputReminder(): string {
	return [
		'<system-reminder>',
		'Terminal has returned (no output) multiple times in a row.',
		'Possible causes: command not found (Windows lacks grep — use findstr or powershell Select-String),',
		'symbol not found in target file, or incorrect path.',
		'Use search_code or search_graph for codebase search instead, or use a diagnostic command (dir, pwd) first.',
		'Do NOT retry the same command — each empty terminal call wastes a turn.',
		'</system-reminder>',
	].join('\n');
}

// ─── 文本-无工具提醒 ─────────────────────────────────────────────────────────

/** LLM 输出了文本但无任何工具调用（在重试上下文中），提醒停止描述、立即行动。 */
export function textWithoutToolsReminder(): string {
	return [
		'<system-reminder>',
		'You produced text in the previous step but did not call any tools.',
		'If you were describing a plan or approach, STOP DESCRIBING and TAKE ACTION NOW.',
		'Call the appropriate tool(s) to execute what you just described.',
		'Do not output another plan, description, or summary without taking action.',
		'If the task genuinely requires no tool calls and is complete,',
		'explicitly state "Task complete, no further action needed."',
		'</system-reminder>',
	].join('\n');
}

// ─── 工具循环检测提醒 ────────────────────────────────────────────────────────

/** 同一工具以相同参数连续调用 N 次后拦截，提醒 LLM 检查输出并调整策略。 */
export function toolLoopDetectionReminder(toolName: string, times: number): string {
	return [
		'<system-reminder>',
		`You have called ${toolName} with identical parameters ${times} times.`,
		'The result is identical each time.',
		'CHECK the tool output above carefully.',
		'If the desired information is present, extract it and proceed to the next step WITHOUT calling this tool again.',
		'If it is not present, use a DIFFERENT tool or change the approach.',
		'Do NOT call this tool again with the same parameters.',
		'</system-reminder>',
	].join('\n');
}

// ─── 软预算收尾提醒 ──────────────────────────────────────────────────────────

/**
 * Turn 耗时超过软预算（wall-clock）时注入一次（不打断执行）。
 * 目的：让长探索任务在硬超时前主动收敛产出（日志 1785224874547：
 * Explore 子代理 78 轮线性探索撞 600s 硬超时、零产出交接）。
 */
export function softBudgetWrapUpReminder(elapsedSec: number, budgetSec: number): string {
	return [
		'<system-reminder>',
		`You have been running for ${elapsedSec}s — past the soft budget of ${budgetSec}s for this task.`,
		'STOP further exploration NOW: do NOT start new search/read rounds unless strictly necessary.',
		'Immediately write your final summary from what you have ALREADY gathered:',
		'lead with the findings (cite file paths + line numbers), then list what remains unverified.',
		'A hard timeout will terminate this task soon — a concise partial answer is far more useful than no answer.',
		'</system-reminder>',
	].join('\n');
}

// ─── 迭代硬上限总结轮提醒 ─────────────────────────────────────────────────────

/**
 * 迭代数撞硬上限（MAX_TOOL_ITERATIONS）时注入的总结轮提醒（agentTurnExecutor
 * 硬停点注入，随后跑一轮「无工具、纯文本」的收尾轮）。
 * 目的：修复「任务半途中断、无任何结论」——日志 1787019843599 实证 50 轮硬停时
 * 模型仍在 finish_reason=tool_calls 的探索中途，最后一句话停在「让我查证」。
 */
export function hardLimitWrapUpReminder(maxIterations: number): string {
	return [
		'<system-reminder>',
		`Iteration limit reached (${maxIterations}/${maxIterations}). Tool calls are now DISABLED for this final round.`,
		'Do NOT attempt any tool calls — they will not execute.',
		'Immediately produce your FINAL ANSWER from what you have ALREADY gathered:',
		'lead with concrete findings (cite file paths + line numbers), state the conclusion or best assessment,',
		'and explicitly list what remains unverified or unfinished.',
		'A partial but concrete answer is far more useful than an interrupted exploration.',
		'</system-reminder>',
	].join('\n');
}

// ─── 结构搜索优先引导 ────────────────────────────────────────────────────────

/**
 * 连续使用文本/文件名搜索（search_files）而未触及结构搜索工具时注入一次。
 * structuralTools 为当前实际可用的结构搜索工具名（数据驱动，随工具面变化）。
 */
export function preferGraphSearchReminder(streakCount: number, structuralTools: string): string {
	return [
		'<system-reminder>',
		`You have used text/grep-style search (search_files) ${streakCount} times without trying the structural code index.`,
		'For "how does X work", call-chain, architecture, or module-relationship questions, prefer structural tools FIRST:',
		`  ${structuralTools}`,
		'They query the indexed codebase knowledge graph directly — far fewer rounds than grep-and-read.',
		'Reserve search_files for exact string / filename matching only.',
		'Also avoid reading large files linearly — extract only the relevant functions, then SUMMARIZE your findings.',
		'</system-reminder>',
	].join('\n');
}
