/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Graph 策略 —— 声明式图 / BSP 超步（对齐 LangGraph）。
 *
 * 范式特征：
 *  - 执行完全委托给 `executeAgentGraph`（由 host 上的 agentOSService 提供），
 *    不走 ReAct inner loop。本策略仅作为范式路由层存在。
 *  - preLoop: 无操作（图执行由 agentDriverService 在 Step 4 判断 agentGraph 字段后
 *    路由到 executeAgentGraph，不经过本策略的 AgentLoop）。
 *  - prepareIteration / shouldTerminate: 空实现（ReAct 循环在 graph 模式下不进入）。
 *
 * 当前定位：
 *  当 agentDriverService 检测到 request.agentGraph 存在时，会直接走 executeAgentGraph
 *  分支，不会调用 executeAgentTurnDirect → AgentLoopStrategyFactory.resolve。
 *  因此本策略主要用于以下场景：
 *    1. 范式切换占位 —— agent 配置 paradigm='graph' 时不会退化为 HermesReAct
 *    2. 未来若需要「从 ReAct 循环内动态图扩展」，可作为扩展点
 */

import type {
	IAgentLoopStrategy,
	PreLoopContext,
	IterationPlan,
	PreLoopResultMeta,
} from '../../common/agentLoopStrategy.js';
import type { IterationBudget } from '../../common/iterationBudget.js';
import type { IChatStreamDelta } from '../../common/providers.js';

export class GraphStrategy implements IAgentLoopStrategy {
	readonly paradigm = 'graph' as const;

	/** 图模式不进入 ReAct 循环：返回 skipMainLoop=true（主循环跳过 while） */
	async *preLoop(ctx: PreLoopContext): AsyncGenerator<IChatStreamDelta, PreLoopResultMeta> {
		ctx.host._logService?.info?.('[Graph] preLoop: graph paradigm active, skipping ReAct loop');
		return { preExploreDone: false, planTasks: [], skipMainLoop: true };
	}

	/** 不适用（图模式不进入 ReAct 循环） */
	prepareIteration(_ctx: PreLoopContext, _budget: IterationBudget): IterationPlan {
		return {};
	}

	/** 不适用（图模式不进入 ReAct 循环） */
	shouldTerminate(_ctx: PreLoopContext, _budget: IterationBudget): boolean {
		return true;
	}
}
