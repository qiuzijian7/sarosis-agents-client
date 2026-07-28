/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 默认 AgentLoop 策略：Hermes-Agent 范式。
 *
 * 范式特征（对齐 Hermes-Agent）：
 *  - ReAct 单循环（由主循环 inner loop 提供，本策略不重写）
 *  - LLM 自主决策是否调用 delegate_task 启动 subagent 探索（不再预分析器拦截）
 *    system prompt 中已注入 <code_explorer_subagent> 指引，LLM 在 ReAct 循环中
 *    自行判断何时需要并行探索，无需 preLoop 钩子做前置 LLM 评估
 *  - IterationBudget 预算门控：每轮 consume，剩余 ≤10% 时注入「总结」提醒，
 *    预算耗尽且无 grace 余量时主循环终止（见 agentTurnExecutor 的预算闸门）
 *  - 委托编排：delegate_task 由主循环现有逻辑执行子 agent（独立预算），本策略在
 *    interceptToolCall 对其做预算记账（父轮不消耗预算，对齐 Hermes execute_code refund）
 *  - 计划模式：plan_exit 经主循环现有拦截 + DAG 执行
 */

import type {
	AgentParadigm,
	IAgentLoopStrategy,
	PreLoopContext,
	IterationPlan,
	InterceptResult,
	PreLoopResultMeta,
	BeforeTerminateResult,
} from '../../common/agentLoopStrategy.js';
import type { IterationBudget } from '../../common/iterationBudget.js';
import type { IChatStreamDelta } from '../../common/providers.js';
import { decideTaskGate, MAX_TASK_GATE_MAIN_REACT } from '../../common/taskGate.js';
import { getSessionTaskLookup } from '../sessionTaskGateBridge.js';

/** 预算剩余低于该比例时，注入「整理发现、准备总结」提醒（对齐 Hermes 末次宽限） */
const BUDGET_LOW_RATIO = 0.1;

export class HermesReActStrategy implements IAgentLoopStrategy {
	/** 注：类型注解放宽为 AgentParadigm，允许子类（如 MiMoStrategy）覆盖字面量 */
	readonly paradigm: AgentParadigm = 'budgeted-react';

	/**
	 * preLoop 钩子：不执行预分析器，直接进入 ReAct 主循环。
	 *
	 * 策略行为通过系统提示词中的 <strategy_guidance> 段落注入 LLM 上下文，
	 * LLM 在 ReAct 循环中自主决定何时调用 delegate_task / search_graph 等工具。
	 *
	 * 移除预分析器的原因：
	 *  1. 额外消耗 1-2 次 LLM 调用 + subagent 启动开销
	 *  2. system prompt 中的 <code_explorer_subagent> + <search_graph_priority> 指引
	 *     已足够让 LLM 在主循环中自主决策
	 *  3. 策略提示词（<strategy_guidance>）明确告知 LLM 当前范式和推荐工具链
	 */
	async *preLoop(_ctx: PreLoopContext): AsyncGenerator<IChatStreamDelta, PreLoopResultMeta> {
		return { preExploreDone: false, planTasks: [] };
	}

	/** 每轮 LLM 调用前：预算低时注入总结提醒。
	 * 注：旧「委托建议（探索≥4次阶梯升级提醒）」已移除 —— LLM 依据
	 * <code_explorer_subagent> 提示词自主决策是否委托，执行层不再干预。 */
	prepareIteration(_ctx: PreLoopContext, budget: IterationBudget): IterationPlan {
		let reminderMessage: string | undefined;
		const ratio = budget.maxIterations > 0 ? budget.remaining / budget.maxIterations : 0;
		if (ratio <= BUDGET_LOW_RATIO && !budget.isGraceUsed()) {
			// 仅注入一次：arm 后由主循环在预算耗尽那圈消费，避免重复提醒
			if (!budget.isGraceArmed()) {
				budget.armGraceCall();
			}
			reminderMessage =
				`<system-reminder>迭代预算即将耗尽（剩余 ${budget.remaining}/${budget.maxIterations}）。` +
				`请基于已有发现整理并产出最终响应，不再发起新的工具调用。若已无工具可调用，直接给出结论。</system-reminder>`;
		}
		return { toolDefs: _ctx.toolDefs, reminderMessage };
	}

	/** 预算耗尽（无 grace 余量）即终止主循环 */
	shouldTerminate(_ctx: PreLoopContext, budget: IterationBudget): boolean {
		if (!budget.hasRemaining() && !budget.isGraceArmed()) {
			return true;
		}
		return false;
	}

	/**
	 * beforeTerminate（MiMo-Code `task/gate.ts` 的处理方式）：
	 * 结束前查任务板 DB 真相 —— 当前会话（含子 agent）名下仍有非终态任务时，
	 * 注入 <system-reminder> 重入提醒继续迭代（上限 MAX_TASK_GATE_MAIN_REACT=3）。
	 * 任务板未接线 / 查询失败 → 失败开放（直接放行，绝不困住 loop）。
	 *
	 * 注：旧「零检索强制 grounding（RETRIEVAL REQUIRED）」guard 已移除 ——
	 * Hermes-Agent 与 MiMo-Code 原版均无此机制，且它对纯问答/轻量请求会误拦截；
	 * 现统一采用 MiMo 的 DB 真相门控：只有任务板上确有未完成任务才拦截收尾。
	 */
	async beforeTerminate(ctx: PreLoopContext, _budget: IterationBudget): Promise<BeforeTerminateResult> {
		const lookup = getSessionTaskLookup();
		if (!lookup) {
			// 任务板未接线（如编排服务未就绪）→ 失败开放
			return { allow: true };
		}
		let incomplete;
		try {
			incomplete = await lookup(ctx.request.agentId);
		} catch {
			// MiMo 同款失败开放：DB 错误不困住 agent loop
			return { allow: true };
		}
		const decision = decideTaskGate({
			incompleteTasks: incomplete,
			reactCount: this._taskGateReactCount,
			maxReact: MAX_TASK_GATE_MAIN_REACT,
			mode: 'main',
		});
		if (!decision.needReentry) {
			return { allow: true };
		}
		this._taskGateReactCount++;
		ctx.host?._logService?.info?.(
			`[HermesReAct] TaskGate reentry ${this._taskGateReactCount}/${MAX_TASK_GATE_MAIN_REACT}: ${incomplete.length} unfinished session task(s)`,
		);
		return { allow: false, nudgeMessage: decision.reentryText };
	}

	/** 本轮是否为委托轮（interceptToolCall 设置，循环末记账后复位） */
	private _delegationRound = false;

	/** TaskGate 重入计数（每次被门拦下 +1；达到上限后放行结束，对齐 MiMo cap） */
	private _taskGateReactCount = 0;

	/** 主循环在循环末调用：若本轮为委托轮则消费 refund（父预算不消耗），并复位标志 */
	takeDelegationRound(): boolean {
		const v = this._delegationRound;
		this._delegationRound = false;
		return v;
	}

	/** 控制工具拦截（观测语义）：delegate_task / transfer_to_agent 由主循环执行子 agent
	 * （独立预算），父轮不消耗预算（refund 对齐 Hermes execute_code 退还），标记
	 * _delegationRound 供循环末记账。 */
	async *interceptToolCall(_ctx: PreLoopContext, call: { name: string; args?: any }): AsyncGenerator<never, InterceptResult> {
		if (call.name === 'delegate_task' || call.name === 'transfer_to_agent') {
			this._delegationRound = true;
		}
		return { handled: false };
	}
}
