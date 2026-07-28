/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AgentLoop 策略抽象层 —— 让「ReAct / Plan-Explore / Budgeted-ReAct / Graph / Delegation / Readonly」
 * 之间可自由切换，而不必在主循环里堆一堆 `if (chatMode===...)` 分支。
 *
 * 设计原则（对齐前期对比分析）：
 *  - 所有范式共享同一个 ReAct inner loop（LLM 流式 → 拼装 tool_call → 执行 → 回填 → 续跑）。
 *  - 范式差异只体现在五个可选钩子：preLoop / prepareIteration / interceptToolCall / shouldTerminate。
 *  - 策略实例 per-turn 创建（AgentLoopStrategyFactory.resolve 每次 new），确保多 session 隔离。
 */

import type { IAgentTurnRequest, IChatStreamDelta } from './providers.js';
import type { IterationBudget } from './iterationBudget.js';
import type { AgentWorkState, ParsedPlanTask } from './workMode.js';

/** 支持的 AgentLoop 范式（对应各参考项目的执行模型） */
export type AgentParadigm =
	| 'react'           // 纯 ReAct 单循环（对齐 void / continue agent 模式）
	| 'plan-explore'    // 三阶段：文本分析 → plan_explore → exit_plan_mode → DAG（本项目 plan/craft）
	| 'budgeted-react'  // ReAct + IterationBudget 门控 + 委托编排（默认，对齐 Hermes-Agent）
	| 'graph'           // 声明式图 / BSP 超步（对齐 LangGraph）
	| 'delegation'      // 委托编排（supervisor + 子 agent 树）
	| 'readonly'        // 只读收集（对齐 void gather / continue ask）
	| 'mimo';           // 任务门控 ReAct（budgeted-react + DB 真相完成门，对齐 MiMo-Code）

/** 主循环在调用策略钩子时传入的运行时上下文（对主循环内部状态的只读+受控写视图） */
export interface PreLoopContext {
	readonly host: any;
	readonly request: IAgentTurnRequest;
	readonly chatMode: string;
	readonly modelProvider: any;
	readonly modelId: string;
	readonly selection: any;
	/** 消息数组（引用传递，策略可 push，preLoop 阶段尚未发生压缩重赋值） */
	readonly messages: any[];
	readonly signal: AbortSignal;
	readonly budget: IterationBudget;
	readonly workState: AgentWorkState;
	/** 本轮可用工具定义列表 */
	readonly toolDefs: any[];
	/** 当前迭代序号（prepareIteration 调用时） */
	readonly iteration: number;
	/**
	 * true=本次为用户明显的轻量/会话型请求（如 "test1"、问候、纯确认）。
	 * 主循环据此剔除重探索/委托/技能类工具；策略 beforeTerminate(TaskGate)
	 * 据此跳过任务门控——避免为无意义输入跑偏（深度探索 + 图谱构建）。
	 * 注：旧「零检索强制 grounding」guard 已移除（改用 MiMo TaskGate），
	 * 但 TaskGate 对 trivial 请求仍应放行，故策略侧保留本字段的跳过分支。
	 */
	readonly trivialRequest?: boolean;
}

/** prepareIteration 返回的本轮执行计划 */
export interface IterationPlan {
	/** 覆盖本轮工具面（不传则用默认全工具） */
	readonly toolDefs?: any[];
	/** 本轮注入的 <system-reminder>（budget 即将耗尽等场景） */
	readonly reminderMessage?: string;
	/** 工具级硬权限检查（返回 true 表示拦截该工具） */
	readonly hardPermission?: (tool: string) => boolean;
}

/** interceptToolCall 的返回 */
export interface InterceptResult {
	/** true=该工具调用已被策略消费（不再进普通执行器） */
	readonly handled: boolean;
	/** true=消费后终止整个主循环 */
	readonly terminate?: boolean;
}

/** preLoop 的返回元信息（供快照/恢复与短路） */
export interface PreLoopResultMeta {
	/** true=已完成全部工作，跳过主 ReAct 循环（如纯只读收集） */
	readonly skipMainLoop?: boolean;
	/** pre-explore 是否已完成（用于中断恢复短路） */
	readonly preExploreDone: boolean;
	/** pre-explore 汇总文本（用于中断恢复时回填） */
	readonly preExploreResult?: string;
	/** 计划任务队列（主循环在 while 内依次注入提醒并推进，空=无计划） */
	readonly planTasks: ParsedPlanTask[];
	/** 探索 findings 原始文本（主循环注入 messages 作为上下文） */
	readonly findings?: string;
}

/**
 * AgentLoop 策略接口。所有钩子可选：未实现即沿用默认 ReAct 行为。
 */
export interface IAgentLoopStrategy {
	readonly paradigm: AgentParadigm;

	/**
	 * 主循环开始前的编排（如 HermesReAct 的「LLM 决策是否需要并行 explore」）。
	 * 可 yield 流式状态；返回 PreLoopResultMeta 携带是否跳过主循环 / 探索是否完成。
	 */
	preLoop?(ctx: PreLoopContext): AsyncGenerator<IChatStreamDelta, PreLoopResultMeta | void>;

	/**
	 * 每轮 LLM 调用前：决定本轮工具面 / 是否注入 system-reminder / 硬权限。
	 * 默认实现返回全工具、无提醒。
	 */
	prepareIteration?(ctx: PreLoopContext, budget: IterationBudget): IterationPlan;

	/**
	 * 拦截特定控制工具（plan_exit / plan_explore / delegate_task / transfer_to_agent 等）。
	 * 返回 handled=true 表示该工具已被策略消费（不再进普通执行器）。
	 */
	interceptToolCall?(ctx: PreLoopContext, call: { name: string; args?: any }): AsyncGenerator<IChatStreamDelta, InterceptResult>;

	/**
	 * 判定是否终止主循环（默认由 inner loop 判定：无 tool_call 即终止）。
	 * 策略可在此注入预算门控等终止条件。
	 */
	shouldTerminate?(ctx: PreLoopContext, budget: IterationBudget): boolean;

	/**
	 * 主循环在「无工具调用且计划队列已空、即将正常结束」前调用（MiMo 主会话
	 * TaskGate 的挂载点）。返回 allow=false 且带 nudgeMessage 时，主循环把
	 * nudgeMessage 作为 user 消息注入并继续迭代（策略自行用重入计数封顶）。
	 * 未实现或返回 allow=true → 按原路径结束（Hermes 行为）。
	 * 异步以支持 DB 查询（任务板真相）。
	 */
	beforeTerminate?(ctx: PreLoopContext, budget: IterationBudget): Promise<BeforeTerminateResult>;
}

/** beforeTerminate 的返回：是否允许结束 + 不允许时的重入提醒文本。 */
export interface BeforeTerminateResult {
	/** true=允许结束；false=注入 nudgeMessage 并继续迭代 */
	readonly allow: boolean;
	/** allow=false 时注入的 <system-reminder>（作为 user 消息进入下一轮） */
	readonly nudgeMessage?: string;
}
