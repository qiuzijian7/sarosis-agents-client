/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turn 主循环的静态调参常量。
 *
 * 抽出动机（2026-09-17）：`agentTurnExecutor.ts` 此前经 `host.constructor.X`
 * 读这些值 —— 即「从实例上反查其构造函数的静态成员」。该写法有三个问题：
 *
 *   1. **类型不可见**：`host` 是 `any`，`host.constructor` 退化为 `Function`，
 *      任何拼写错误或缺失成员都不会被 tsc 捕获，只在运行时得到 `undefined`。
 *   2. **静默失效**：`undefined` 参与比较恒为 false（如
 *      `iteration < undefined`），熔断/上限判定会**静音关闭**而非报错。
 *      实测已有两个常量从未在生产宿主上存在（见下方 DEFAULT_BUDGET_MAX /
 *      MAX_TEXT_SEARCH_STREAK_HARD 的说明），全靠 `?? 90` 与 `typeof` 兜底掩盖。
 *   3. **伪实例依赖**：静态量与 host 实例无关，经实例读取会让「executor 依赖
 *      宿主什么」这一问题被污染 —— 任何 host 替身（测试 mock、适配对象）都得
 *      额外伪造一个 `constructor` 才能不改变行为。
 *
 * 故统一改为从本模块 import。静态量本就不该走实例。
 *
 * ⚠ `AgentOSService` 侧的同名 `static readonly` 保留未删：它们是该类的对外
 * 公开常量，可能有本模块之外的消费者。本模块是 executor 的**唯一**取值来源，
 * 两者取值必须一致（见 `test/common/turnLoopConstants.test.ts` 的一致性断言）。
 */

/** 主 agent 单 turn 的工具调用轮次上限。撞上限后额外跑一轮「禁工具收尾轮」，故实际为 +1。 */
export const MAX_TOOL_ITERATIONS = 100;

/** 同名工具连续失败达到此数即熔断该工具。 */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

/**
 * 文本搜索连击软阈值：连续 N 次 grep 类搜索且未触及结构搜索工具时，
 * 注入一次「结构搜索优先」引导。工具分组见 `common/searchToolGroups.ts`。
 */
export const MAX_TEXT_SEARCH_STREAK = 4;

/**
 * 文本搜索连击硬上限：失控时强制进入收尾轮，打断死循环。
 *
 * ⚠ 该常量此前**在任何宿主上都不存在** —— executor 写的是
 * `typeof host.constructor.MAX_TEXT_SEARCH_STREAK_HARD === 'number' ? ... : MAX_TEXT_SEARCH_STREAK * 2`，
 * 而 `AgentOSService` 从未声明它，故恒走 `* 2` 分支。此处将既有实际行为
 * （2× 软阈值）固化为显式常量，不改变行为。
 */
export const MAX_TEXT_SEARCH_STREAK_HARD = MAX_TEXT_SEARCH_STREAK * 2;

/**
 * 反思阶段（Plan-Execute-Reflect）总开关：0 = 彻底关闭。
 *
 * 触发条件 `hasModifiedFiles && reflectCount < MAX_REFLECT_ITERATIONS` 在此值为 0 时永假。
 * 2026-07-27 拍板关闭：模型倾向于把上轮已给出的结论重新生成一遍，代价大于自查收益。
 * 逻辑保留未删 —— 恢复自查能力只需改回 1。
 */
export const MAX_REFLECT_ITERATIONS = 0;

/** 触发反思前提判定用的文件修改类工具名。 */
export const FILE_MODIFICATION_TOOLS: ReadonlySet<string> = new Set([
	'file_write',
	'write_to_file',
	'replace_in_file',
	'edit_file',
	'delete_file',
]);

/** 两次上下文压缩之间的最小间隔。 */
export const COMPRESSION_COOLDOWN_MS = 60_000;

/**
 * budgeted-react 范式的默认总预算（`request.budgetMaxTotal` 未提供时生效）。
 *
 * ⚠ 该常量此前**在生产宿主上不存在** —— executor 写的是
 * `request.budgetMaxTotal ?? (host.constructor.DEFAULT_BUDGET_MAX ?? 90)`，
 * 而 `AgentOSService` 从未声明它（只有行为测试的 mock 宿主声明了 `= 90`）。
 * 生产恒走 `?? 90` 兜底，与 mock 值恰好一致，故行为无差异。
 * 此处固化为显式常量，与 `common/providers.ts` 注释中承诺的 90 对齐。
 */
export const DEFAULT_BUDGET_MAX = 90;

/**
 * 对需要显式引导的模型族，在 system prompt 末尾注入的工具使用强制指令。
 *
 * 幂等标记为首行 `<!-- TOOL_USE_ENFORCEMENT -->`（注入前检测该串是否已存在）。
 * 是否注入由 `common/modelFamilyPrompt.ts` 的 `needsToolUseEnforcement()` 判定。
 */
export const TOOL_USE_ENFORCEMENT_GUIDANCE = [
	'<!-- TOOL_USE_ENFORCEMENT -->',
	'# Tool-use enforcement',
	'You MUST use your tools to take action — do not describe what you would do',
	'or plan to do without actually doing it. When you say you will perform an',
	'action (e.g. "I will run the tests", "Let me check the file", "I will create',
	'the project"), you MUST immediately make the corresponding tool call in the same',
	'response. Never end your turn with a promise of future action — execute it now.',
	'Keep working until the task is actually complete. Do not stop with a summary of',
	'what you plan to do next time. If you have tools available that can accomplish',
	'the task, use them instead of telling the user what you would do.',
	'Every response should either (a) contain tool calls that make progress, or',
	'(b) deliver a final result to the user. Responses that only describe intentions',
	'without acting are not acceptable.',
].join('\n');
