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

// ─── 整轮全被循环检测拦截（升级干预）─────────────────────────────────────────

/** 连续「整轮全被拦」达到此值 → 注入强制升级提醒（只注入一次）。 */
export const ALL_BLOCKED_ESCALATE_AT = 2;
/** 连续「整轮全被拦」达到此值 → 强制进入收尾轮（禁工具，只许输出结论）。 */
export const ALL_BLOCKED_WRAPUP_AT = 4;

/**
 * 一整轮的**全部**工具调用都被循环检测拦下，且已连续发生多轮。
 *
 * 为什么单工具级的 `toolLoopDetectionReminder` 不够（日志 1787377582459 实证）：
 * 该轮 37 次连续出现 `All 2 tool calls blocked by loop detection`，每轮模型输出
 * **逐字节相同**的 229 个 delta（text=214），完全无视「已被跳过」的 tool result。
 * 原实现只是 `continue` 进入下一轮 —— 等于每轮白烧一次完整 prompt（30k+ token
 * × 5–8s），直到 100 轮硬上限。单工具提醒此时已被模型忽略，必须升级为
 * 「整轮无进展」的显式判定 + 更强指令。
 *
 * 措辞要点：不再重复「换个参数」这类它已经忽略的建议，而是**直接要求它停止调用
 * 工具并基于已有信息作答** —— 与 `softBudgetWrapUpReminder` 的思路一致
 * （部分答案远胜没有答案）。
 */
export function allToolCallsBlockedReminder(streak: number, toolNames: string): string {
	const lines = [
		'<system-reminder>',
		`For ${streak} consecutive turns, EVERY tool call you made was rejected as a duplicate (${toolNames}).`,
		'Nothing has been executed and no new information has been obtained in those turns — you are in a loop.',
		'The repetition itself is the problem: issuing the same calls again will be rejected again.',
		'',
		'Do ONE of the following NOW:',
		'1. Answer the user using the information ALREADY gathered above (preferred — cite file paths / line numbers).',
		'2. If information is genuinely missing, call a DIFFERENT tool with DIFFERENT arguments than any you have used.',
		'3. If you cannot proceed without input, ask the user a specific question.',
		'',
		'Do NOT repeat any previous tool call. Do NOT restate your plan without acting on it.',
	];
	// patch 空参/同参循环：明确允许「重发一次带正确参数的 patch」，而非只让模型放弃
	// （日志 1787759962668 实证：patch 空参被拦后模型无任何可执行信号，空转到工具禁用）。
	if (toolNames.includes('patch')) {
		lines.push(
			'If you were trying to EDIT a file with "patch": re-issue EXACTLY ONE patch with real arguments — path (file), search (exact existing text), replace (new text) — after reading the file. That is allowed and is the correct fix; only empty/identical patch calls are rejected.',
		);
	}
	lines.push('</system-reminder>');
	return lines.join('\n');
}

/**
 * 连续「整轮全被拦」过多 → 强制收尾轮的提醒。
 *
 * 与 `hardLimitWrapUpReminder` 的区别：那是撞迭代上限（跑了很多**有效**轮），
 * 这里是**零进展**空转，需要明确点出「工具已被禁用」，否则模型会继续尝试调用、
 * 白烧最后一轮。
 */
export function allBlockedWrapUpReminder(streak: number): string {
	return [
		'<system-reminder>',
		`You have made NO progress for ${streak} consecutive turns — every tool call was a rejected duplicate.`,
		'Tool calling is now DISABLED for this turn. You cannot call any tool.',
		'',
		'Write your final answer now, using only what you have already gathered:',
		'1. What you found (cite file paths and line numbers).',
		'2. What you could NOT determine, and why.',
		'3. The single most useful next step for the user.',
		'',
		'This instruction overrides all other instructions. A concise partial answer is required.',
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
 *
 * 2026-08-20：输出要求结构化，对齐 MiMo-Code 的 `session/prompt/max-steps.txt`
 * （四项必需内容 + 「本约束覆盖其他所有指令」的优先级声明）。此前只说「给出部分
 * 但具体的答案」，模型常省略「未完成事项」与「下一步建议」——而这两项恰是用户
 * 在被截断时最需要的信息。
 */
export function hardLimitWrapUpReminder(maxIterations: number): string {
	return [
		'<system-reminder>',
		`Iteration limit reached (${maxIterations}/${maxIterations}). Tool calls are now DISABLED for this final round.`,
		'Do NOT attempt any tool calls — they will not execute.',
		'Immediately produce your FINAL ANSWER from what you have ALREADY gathered.',
		'It MUST include ALL FOUR of the following:',
		`  1. A brief statement that the ${maxIterations}-round tool budget for this task was reached.`,
		'  2. What was ACCOMPLISHED — concrete findings with file paths + line numbers.',
		'  3. What remains UNFINISHED or UNVERIFIED — list it explicitly, do not silently omit it.',
		'  4. RECOMMENDED NEXT STEPS — what should be done next to complete the task.',
		'Do not ask the user whether to continue; just deliver the four sections above.',
		'A partial but concrete answer is far more useful than an interrupted exploration.',
		'This constraint overrides ALL other instructions.',
		'</system-reminder>',
	].join('\n');
}

/**
 * 迭代预算即将耗尽（剩余 N 轮）时注入一次的预警。
 *
 * 目的：修复「模型在最后一轮启动昂贵操作 → 结果无轮次消费」——日志
 * 1787214724132 实证第 50/50 轮才发起 delegate_task，子代理跑了 23 轮/6 分钟，
 * 结果回来时主循环已退出，成果 100% 丢弃，回答停在「让我用 delegate_task…」。
 * 模型当时并不知道自己只剩 1 轮。
 */
export function budgetLowWarning(remaining: number, maxIterations: number): string {
	return [
		'<system-reminder>',
		`Only ${remaining} tool-calling round(s) remain out of ${maxIterations} for this task.`,
		'Do NOT start any long-running or delegating operation now (e.g. delegate_task, broad repo-wide search):',
		'its result would arrive after the budget is exhausted and would be DISCARDED.',
		'Spend the remaining round(s) on cheap, targeted verification only, then write your final answer',
		'from what you have ALREADY gathered (cite file paths + line numbers).',
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
		'If these searches are not surfacing the answer, STOP issuing more searches and either report what you have',
		'already found (cite concrete file paths + line numbers) or ask a clarifying question. Do NOT keep grepping.',
		'</system-reminder>',
	].join('\n');
}

/**
 * 纯文本搜索连击、但当前工具面**没有任何结构搜索工具可用**时的引导。
 * 此时无法引导「改用结构工具」，只能明确要求模型停搜并直接基于已有信息汇报。
 */
export function stopSearchingReportReminder(streakCount: number): string {
	return [
		'<system-reminder>',
		`You have used text/grep-style search (search_files) ${streakCount} times in a row without making progress.`,
		'Repeated searching is not surfacing the answer — STOP issuing more searches.',
		'Switch strategy now: if any STRUCTURAL tool is available (graph / architecture / code-snippet queries),',
		'use it; otherwise write up your findings so far (cite concrete file paths + line numbers) and either',
		'propose the next concrete step or ask a clarifying question. Do NOT keep grepping.',
		'</system-reminder>',
	].join('\n');
}

/**
 * 纯文本搜索连击**硬上限**触发时的强制收尾提醒。配合 `_forceWrapUpRound`
 * （工具已禁用）使用：要求模型基于已收集信息产出最终结论，不得再请求搜索/工具。
 */
export function textSearchLoopWrapUpReminder(streakCount: number): string {
	return [
		'<system-reminder>',
		`Search-loop guardrail: you have issued ${streakCount} consecutive text/grep searches without resolution.`,
		'This turn is being forced to wrap up. Tools are now DISABLED for this final round.',
		'Produce your final answer from what you have ALREADY gathered: summarize findings with concrete',
		'file paths + line numbers, state what remains uncertain, and either propose the next step or ask',
		'a clarifying question. Do NOT request more searches or tools.',
		'</system-reminder>',
	].join('\n');
}

// ─── 单工具串行引导（批量并行提醒）──────────────────────────────────────────
//
// 事故（日志 1787302409958 Turn 2）：ITER 20-36 连续 **17 轮每轮只请求 1 个只读
// 工具**（search_code / search_files / file_read 交替），而同会话开头 ITER 1-12
// 是每轮 2-3 个并行请求 —— 模型在长会话后期「忘了」批量。
//
// 代价：这 17 轮若保持 3 个/轮只需 ~6 轮 → 浪费约 11 轮 LLM 往返。而每轮往返都要
// 重传完整 prompt（该会话已达 27k-60k tokens），是整个流程里最贵的开销，远超工具
// 本身的执行耗时（那些搜索平均仅 100-800ms）。

/**
 * 单只读工具连击推进（纯函数，便于单测）。
 *
 * @param current           当前连击数
 * @param isSingleReadOnly  本轮是否「只请求了 1 个工具且该工具为只读安全工具」
 * @param threshold         触发阈值（达阈值倍数时引导，周期性提醒不刷屏）
 */
export function advanceSingleToolStreak(
	current: number, isSingleReadOnly: boolean, threshold: number,
): { streak: number; shouldGuide: boolean } {
	const streak = isSingleReadOnly ? current + 1 : 0;
	return { streak, shouldGuide: streak > 0 && threshold > 0 && streak % threshold === 0 };
}

/**
 * 连续多轮每轮只调 1 个只读工具时注入，引导模型批量并行。
 * @param streakCount 连续轮数
 * @param recentTools 最近这几轮实际用到的工具名（去重，用于让提醒具体可信）
 */
export function batchReadOnlyToolsReminder(streakCount: number, recentTools: string): string {
	return [
		'<system-reminder>',
		`You have issued ${streakCount} consecutive rounds with only ONE read-only tool call each (${recentTools}).`,
		'Every round costs a full LLM round-trip that re-sends the entire conversation — by far the most',
		'expensive part of the loop, while these reads finish in milliseconds.',
		'Batch independent read-only calls into a SINGLE round from now on:',
		'  request 3-5 search_code / search_files / file_read calls together whenever the next lookups',
		'  do not depend on each other\'s results.',
		'Plan the lookups you need up front, issue them in one batch, then reason over all results at once.',
		'Only fall back to one-at-a-time when a call genuinely depends on the previous result.',
		'</system-reminder>',
	].join('\n');
}
