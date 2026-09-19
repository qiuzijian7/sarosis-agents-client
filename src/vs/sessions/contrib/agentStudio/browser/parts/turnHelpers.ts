/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `agentTurnExecutor.ts` 的模块级纯函数集合（原主文件顶层 217-240 / 637-828 行）。
 *
 * ## 为什么单独成文件
 *
 * 这些函数有一个共同特征：**不捕获 `executeAgentTurnDirect` 的任何闭包变量**，
 * 全部依赖来自入参。主文件其余部分（setup 段 + while 主循环）则相反 —— 十余个
 * 绑定跨阶段读写，搬走必然要造巨型 context 对象。故此处是主文件唯一能零成本
 * 切开的边界。
 *
 * ## 与 `parts/` 既有纪律的关系
 *
 * `parts/` 下各 Part 一律**不反向 import 主文件**，改由主文件经 deps 注入
 * （见 `turnPostIteration.ts` 的 `buildCheckpointSnapshot` 注入注释、
 * `turnRequestDiagnostics.ts` 的 `groupToolSchemaCosts` 注入注释）。本文件不破坏
 * 该纪律 —— 它位于 `parts/` 内且**不 import 主文件**，因此：
 *   · 主文件从这里 import 后照旧注入给其他 Part，注入链形态不变；
 *   · 其他 Part 若将来要直接用，可平级 import 本文件，无需经主文件绕行。
 *
 * ⚠ 主文件仍 re-export `buildCheckpointSnapshot`：
 * `test/browser/agentTurnExecutorHelpers.test.ts` 从主文件路径 import 它并有 6 个
 * 断言，直接搬走会断链。re-export 是为保住既有测试入口，不是重复实现。
 *
 * @module agentStudio/parts/turnHelpers
 */

import {
	reduceRunState,
	snapshotRunState,
	locateTaggedIdXmlTags,
	type AgentRunMessage,
	type AgentRunState,
	type AgentRunStateSnapshot,
} from '../../common/agentRunState.js';
import type { BudgetSnapshot } from '../../common/iterationBudget.js';
import type { AgentParadigm } from '../../common/agentLoopStrategy.js';
import { isParallelSafeReadOnlyTool } from '../toolCallUtils.js';
import { getToolsetForTool } from '../../common/toolsetConfig.js';
import {
	sanitizeAssistantVisibleText,
	addSanitizeTraceSink,
} from '../../common/assistantVisibleText.js';

/**
 * 仅声明本文件实际用到的日志成员。
 *
 * 纪律沿用 `turnIterationGate.ts` 的 `IGateHost`：不引入完整宿主类型，避免
 * 「本模块到底依赖宿主什么能力」被淹没在几十个无关成员里。
 */
export interface ITurnHelpersLogHost {
	_logService: {
		warn(message: string, ...args: unknown[]): void;
	};
}

/**
 * 带 trace 的 sanitize：把「哪个剥离阶段删了什么」打到 host 日志。
 *
 * 多个剥离阶段用了锚定文本末尾的正则（`$` 无 `m` flag），一旦误命中正文里的
 * 常见词（`Action:` / `[TOOL_CALL]` / `<function>` 等），会删除「从这里到文本
 * 末尾」的全部内容 —— 即用户看到的「消息尾部被截断」。此处在调用期间临时安装
 * sink（用完即卸），既拿到分阶段 trace，又不长期占用全局接收器。
 */
export function sanitizeWithTrace(text: string, host: { _logService: { warn(msg: string): void } }): string {
	const log = host._logService;
	const dispose = addSanitizeTraceSink(e => {
		log.warn(
			`[SanitizeTrace] stage=${e.stage} profile=${e.profile} ` +
			`len ${e.beforeLen}→${e.afterLen} (removed=${e.removedLen}) atOffset=${e.atOffset}\n` +
			`  removedSnippet="${e.removedSnippet.replace(/\n/g, '\\n')}"\n` +
			`  afterTail="${e.afterTail.replace(/\n/g, '\\n')}"`
		);
	});
	try {
		return sanitizeAssistantVisibleText(text, 'streaming');
	} finally {
		dispose();
	}
}

// ─── [TagTrace] `<tag:id>` 伪标签溯源 ──────────────────────────────
// 为什么要有这套日志：这类标签**理论上不该出现** —— 全仓无生成代码、系统提示词
// 反而禁止 XML 工具标签、横向对比 openclaw / Hermes-Agent / opencode 三家也都**没有**
// 处理该格式的逻辑（它们的正则都不认 `:id` 后缀）。既然不是通用模型行为，就必然有
// 特定来源。此前一直在「处理症状」（剥离/检测/提醒），却从未定位源头，故补三处切面，
// 用**二分法**把成因收敛到两种之一：
//   · 请求侧有、响应侧有 → PRIMING：模型看见了才模仿，源头是工具结果/历史/记忆/skill；
//   · 请求侧无、响应侧有 → 模型自发（训练格式残留），只能靠提醒+剥离兜底。
// 两种成因治理方式完全不同，不分清就会一直治标。
//
// ⚠ 本仓自身的注释 / 文档**不得**写出 `<tag:十六进制ID>` 的**字面**形态 —— 一律写成
// `<tag:HEXID>` 之类的占位符。理由（2026-09-16 实证）：这类字面量本身就是 priming 源，
// 且因为它是**我们自己的源码/日志**，任何一次 `file_read` / 搜索命中都会把它重新喂给模型
// （当日日志：子代理读本文件 ⇒ TOOL-RESULT 命中 ⇒ 下一轮 REQUEST-SIDE 命中「PRIMING suspected」）。
// 剥离只是兜底，「不生产」才是根治。

/**
 * 切面 1：扫描**即将发给 LLM 的请求**，报告标签首次出现在第几条消息、什么角色。
 * 命中即强烈提示 priming（模型在下轮看到后就会模仿）。
 */
export function tagTraceScanRequest(
	messages: ReadonlyArray<any>,
	iteration: number,
	host: ITurnHelpersLogHost,
): void {
	try {
		let firstIdx = -1;
		let firstRole = '';
		let firstSnippet = '';
		const allHits: string[] = [];
		for (let i = 0; i < messages.length; i++) {
			const c = messages[i]?.content;
			if (typeof c !== 'string' || !c) { continue; }
			const hits = locateTaggedIdXmlTags(c, 2);
			if (hits.length === 0) { continue; }
			if (firstIdx < 0) {
				firstIdx = i;
				firstRole = String(messages[i]?.role ?? '?');
				firstSnippet = hits[0].snippet;
			}
			for (const h of hits) { allHits.push(`m${i}/${h.tag}:${h.id}@${h.index}`); }
		}
		if (allHits.length === 0) { return; }
		host._logService.warn(
			`[AgentOS][TagTrace] REQUEST-SIDE tags iter=${iteration} ` +
			`firstAt=msg[${firstIdx}](role=${firstRole}) total=${allHits.length} ` +
			`hits=[${allHits.slice(0, 6).join(', ')}] → PRIMING suspected ` +
			`snippet=${JSON.stringify(firstSnippet).slice(0, 220)}`
		);
	} catch {
		// 诊断日志绝不阻断请求
	}
}

/**
 * 切面 3：扫描**工具回灌结果**。工具输出是 priming 最常见的载体 —— 模型读到
 * 文件/日志里含此类标签后会在下一轮模仿（Hermes 亦记录过同类现象，见
 * `conversation_loop.py::_invalid_tool_name_error_content`）。
 */
export function tagTraceScanToolResult(
	resultText: string,
	toolName: string,
	iteration: number,
	host: ITurnHelpersLogHost,
): void {
	try {
		if (!resultText) { return; }
		const hits = locateTaggedIdXmlTags(resultText, 2);
		if (hits.length === 0) { return; }
		host._logService.warn(
			`[AgentOS][TagTrace] TOOL-RESULT tags iter=${iteration} tool=${toolName} ` +
			`len=${resultText.length} hits=[${hits.map(h => `${h.tag}:${h.id}@${h.index}`).join(', ')}] ` +
			`snippet=${JSON.stringify(hits[0].snippet).slice(0, 220)}`
		);
	} catch {
		// 诊断日志绝不阻断请求
	}
}

// ─── argument_churn 抑制名单 ─────────────────────────────────────────
/**
 * 「同一工具、参数每次都不同、连续反复」在这两类工具上属于**正常多目标推进**，
 * 对它注入「停止换参数 / 去问用户」的引导会把正常工作流打断。
 *
 * `detectArgumentChurn` 只看 `argsHash`，无法区分「换了目标」与「同一目标反复试参数」
 * —— 故该判据只能由调用方补（其函数注释已声明「只做判定，由调用方决定」）。
 *
 * 依据（日志 20260916T130827，同一会话两次触发且**两次都是合法推进**）：
 *   · iter=2  `file_read` ×5 —— 连续读 5 个不同文件（子代理探索）；
 *   · iter=16 `patch` ×5     —— 连续改 5 个不同文件。
 *
 * 两类放行的理由各自独立：
 *   · 只读浏览类（`isParallelSafeReadOnlyTool`）—— 逐文件/逐查询推进就是该工具的
 *     正常用法；「重复读同一区域」已由 `coreTools` 的 read-dedup / read-repeat
 *     直接拦截，「单只读工具串行连击」另有 singleToolStreak 软提示，不劳此处再催；
 *   · 路径作用域写类 —— 本项目既有口径：反复改同一文件是**合法迭代**
 *     （见 `toolAuditReport` 的 dup 判据注释「写类工具重复写同一路径是合法的迭代修改」）。
 *
 * ⚠ 其余工具（terminal / process / execute_code / browser / MCP…）**保持原行为** ——
 * 「换个引号/换个路径再试一次」的偏执试探正是本检测要抓的病灶。
 */
const CHURN_MULTI_TARGET_WRITE_TOOLS: ReadonlySet<string> = new Set([
	'patch', 'file_write', 'file_edit', 'multi_edit', 'apply_patch',
]);

export function isMultiTargetChurnTool(toolName: string): boolean {
	return isParallelSafeReadOnlyTool(toolName) || CHURN_MULTI_TARGET_WRITE_TOOLS.has(toolName);
}

/**
 * 工具 schema 的固定 token 开销粗估（纯函数，无副作用）。
 *
 * 压缩触发判定（无真实 usage 时计入 effectiveTokens）与 promptOverhead 诊断
 * **必须共用此函数** —— 早前这段逻辑内联在 `_compressContextIfNeeded` 的闭包里，
 * 请求发出点拿不到，若在那里另写一份就会出现两套口径互相漂移。
 */
export function estimateToolsSchemaTokens(tools: ReadonlyArray<any>): number {
	let total = 0;
	try {
		for (const t of tools) {
			const schemaStr = JSON.stringify({ name: t.name, description: t.description, parameters: (t as any).inputSchema ?? (t as any).schema ?? undefined });
			if (schemaStr) { total += Math.ceil(schemaStr.length / 4); }
		}
	} catch (e) {
		return 0; // 序列化失败不阻断压缩
	}
	return total;
}

/**
 * 构造一轮 checkpoint 的持久化快照。
 *
 * 抽出动机：原实现内联在 `_postIterationCleanup`（闭包依赖 runState/messages/
 * budget/host/request 五个外部变量），无法单测。此处把「三次归约链」纯化，
 * 使「快照是否包含 budget / messages / paradigm」可被断言。
 *
 * 为什么三样都要写进快照：
 *   · budget —— 中断恢复时预算状态必须是最新的，否则恢复后重复消耗；
 *   · messages —— P0-a-2 之后它是真相源，但**旧**快照恢复路径仍读 loopMessages，
 *     故此处同时保留镜像（见 reducer 的 SET_LOOP_MESSAGES 注释）；
 *   · paradigm —— 恢复时要回到同一范式，否则策略钩子对不上。
 *
 * `iteration` 不进 runState（有意豁免，对齐 LangGraph 的 step 语义），
 * 由调用方显式透传后合并。
 *
 * ⚠ 返回的是 `AgentRunStateSnapshot`（`{ version, state }` 信封），**不是**裸
 * `AgentRunState` —— `snapshotRunState` 负责加版本号并深拷贝，这是 forward-compat
 * 的入口（restore 侧会拒绝过高的 version）。
 *
 * @returns 带版本信封的深拷贝快照，可直接交给 checkpointSink。
 */
export function buildCheckpointSnapshot(
	runState: AgentRunState,
	budgetSnapshot: BudgetSnapshot,
	messages: AgentRunMessage[],
	paradigm: AgentParadigm,
	iteration: number,
): AgentRunStateSnapshot {
	const withBudget = reduceRunState(runState, { type: 'SAVE_BUDGET', snapshot: budgetSnapshot });
	const withMessages = reduceRunState(withBudget, { type: 'SET_LOOP_MESSAGES', messages });
	const withParadigm = reduceRunState(withMessages, { type: 'SET_PARADIGM', paradigm });
	return snapshotRunState({ ...withParadigm, iteration });
}

/**
 * 把 tools schema 开销按 toolset 归因（供 [PromptBudget] 预算表）。
 *
 * ⚠ 逐工具调用 `estimateToolsSchemaTokens([t])` 而非另写公式：该函数本身就是
 * 「逐工具累加」，故分组求和**恰好等于**整体调用结果，预算表里 tools 各行之和
 * 与压缩判定用的 `toolsSchemaTokens` 严格一致，不会出现两套口径。
 *
 * 归因价值实证：core toolset 的 prefixes 曾误含 `memory_`，把 16 个 memory_* 工具
 * 抢进不可折叠层、白烧 ~4k schema token —— 有了 `tools:core` 这一行的异常占比，
 * 这类事故不必再靠人工读源码发现。
 */
export function groupToolSchemaCosts(tools: ReadonlyArray<any>): {
	groups: Array<{ name: string; tokens: number; count: number }>;
	costs: Array<{ name: string; tokens: number }>;
} {
	const groups = new Map<string, { tokens: number; count: number }>();
	const costs: Array<{ name: string; tokens: number }> = [];
	for (const t of tools) {
		const name = typeof t?.name === 'string' ? t.name : '(unnamed)';
		const tokens = estimateToolsSchemaTokens([t]);
		costs.push({ name, tokens });
		// MCP 工具的 category 形如 `mcp:<server>`，与内置 toolset 分开统计更有诊断价值。
		const category = typeof t?.category === 'string' ? t.category : '';
		const key = category.startsWith('mcp:') ? category : (t?.toolset || getToolsetForTool(name));
		const g = groups.get(key) ?? { tokens: 0, count: 0 };
		g.tokens += tokens;
		g.count += 1;
		groups.set(key, g);
	}
	return {
		groups: [...groups].map(([name, g]) => ({ name, tokens: g.tokens, count: g.count })),
		costs,
	};
}
