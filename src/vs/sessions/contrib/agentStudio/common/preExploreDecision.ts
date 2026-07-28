/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pre-Explore 决策类型与 chatMode→paradigm 默认映射。
 *
 * 注意：本项目的「LLM 决策是否需要并行 explore」已存在于 `preLoopOrchestrator.ts` 的
 * `PreLoopAssessment`，因此这里直接复用它作为统一决策类型，避免重复定义。
 */

import type { AgentParadigm } from './agentLoopStrategy.js';

/** 复用 PreLoopAssessment 作为统一 PreExploreDecision（needsExploration / explorationAreas / planTasks / reason） */
export type { PreLoopAssessment as PreExploreDecision, PreLoopResult } from './preLoopOrchestrator.js';

/**
 * chatMode（稳定用户策略）→ 默认 AgentParadigm 映射。
 * 优先级：request.paradigm（显式）> agent.config.paradigm > 本映射。
 */
export const DEFAULT_PARADIGM_BY_CHATMODE: Readonly<Record<string, AgentParadigm>> = {
	craft: 'budgeted-react',   // 默认 Hermes 范式：ReAct + 预算门控 + 委托编排
	plan: 'plan-explore',      // plan 模式：三阶段 plan_explore → exit_plan_mode → DAG
	ask: 'readonly',           // ask 模式：纯只读收集
	workflow: 'graph',         // workflow：声明式图范式
} as const;
