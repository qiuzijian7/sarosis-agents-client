/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Delegation 策略 —— Supervisor + 子 Agent 委托树（对齐 Hermes delegate_task 编排）。
 *
 * 范式特征：
 *  - preLoop: LLM 分析任务 → 拆分子任务 → 为每个 subtask 派发 delegate_task 子 agent →
 *    等待全部完成 → 汇总 → skipMainLoop=true（一轮完成，不进 ReAct 循环）
 *  - prepareIteration: 父级仅暴露 delegate_task / plan 控制工具，屏蔽执行工具
 *  - 自然终止：子 agent 全部完成后直接产出汇总
 *
 * 与 HermesReAct 的区别：
 *  - HermesReAct: preLoop 只探索+计划，ReAct 循环中由 LLM 主动调 delegate_task
 *  - Delegation: preLoop 直接完成全部委派，ReAct 循环被跳过
 */

import type {
	IAgentLoopStrategy,
	PreLoopContext,
	IterationPlan,
	PreLoopResultMeta,
} from '../../common/agentLoopStrategy.js';
import type { IterationBudget } from '../../common/iterationBudget.js';
import type { IChatStreamDelta } from '../../common/providers.js';
import { buildPreLoopDeps, preLoopOrchestrate } from '../preLoopDeps.js';

export class DelegationStrategy implements IAgentLoopStrategy {
	readonly paradigm = 'delegation' as const;

	/**
	 * preLoop: LLM 分析 → 拆分子任务 → 派发子 agent → 等待完成 → 汇总。
	 *
	 * 当前实现复用 HermesReAct 的 preLoopOrchestrate（探索 + 计划），
	 * 但标记 skipMainLoop=false 让主循环继续 ReAct，由 LLM 在其中主动调
	 * delegate_task。未来可扩展为 preLoop 内直接派发并等待子 agent。
	 */
	async *preLoop(ctx: PreLoopContext): AsyncGenerator<IChatStreamDelta, PreLoopResultMeta> {
		const allUserMsgs = ((ctx.request as any).messages || []).filter((m: any) => m.role === 'user');
		const lastUserMsg = allUserMsgs[allUserMsgs.length - 1];
		const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
		if (!userText || !ctx.modelProvider || !ctx.modelId) {
			return { preExploreDone: false, planTasks: [] };
		}

		try {
			const deps = buildPreLoopDeps(
				ctx.host, ctx.modelProvider, ctx.modelId,
				ctx.request.agentId ?? 'default',
				ctx.signal,
			);
			const result = await preLoopOrchestrate(userText, deps);

			ctx.host._logService?.info?.(
				`[Delegation] preLoop: needsExploration=${result.assessment.needsExploration}, ` +
				`planTasks=${result.planTasks.length}`
			);

			return {
				preExploreDone: result.assessment.needsExploration,
				preExploreResult: result.findings,
				planTasks: result.planTasks,
				findings: result.findings,
			};
		} catch (err) {
			ctx.host._logService?.warn?.(
				`[Delegation] preLoop failed: ${err instanceof Error ? err.message : err} — fallback`
			);
			return { preExploreDone: false, planTasks: [] };
		}
	}

	/** 每轮 LLM 调用前：Supervisor 只用控制工具（delegate_task / new_agent / plan），不直接执行 */
	prepareIteration(ctx: PreLoopContext, _budget: IterationBudget): IterationPlan {
		// 保留委托/控制类工具，过滤掉文件读写/搜索等执行工具
		// （子 agent 各自拥有完整工具面，supervisor 不需要，且绝不直接碰工具）。
		// 注意：必须包含 new_agent —— 它是与 delegate_task 并列的 subagent 派发入口，
		// 缺少它会导致 supervisor 无法并行派生子 agent。
		const supervisorToolNames = new Set([
			'delegate_task', 'new_agent', 'transfer_to_agent',
			'task', 'task_list',
			'plan_enter', 'plan_exit', 'plan_explore',
			'update_plan',
			'mcp_tool_search', 'mcp_tool_call',
		]);
		const supervisorTools = (ctx.toolDefs || []).filter(
			(t: any) => supervisorToolNames.has(t.name),
		);
		return { toolDefs: supervisorTools };
	}

	/** 委托模式不基于预算终止——由 LLM 决定何时完成 */
	shouldTerminate(_ctx: PreLoopContext, _budget: IterationBudget): boolean {
		return false;
	}
}
