/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AgentLoop 策略工厂 —— 把「选哪种 loop 范式」收敛为单一入口，消除主循环里的
 * `if (chatMode===...)` 分支蔓延。策略实例 per-turn 创建（resolve 每次 new），
 * 保证多聊天框/多 session 之间的预算与状态隔离。
 *
 * 范式选择优先级：
 *   1. request.paradigm（显式，UI/配置传入）
 *   2. agent.config.paradigm（per-agent 配置）
 *   3. chatMode 默认映射（DEFAULT_PARADIGM_BY_CHATMODE）
 */

import type { IAgentTurnRequest } from '../common/providers.js';
import type { AgentParadigm, IAgentLoopStrategy } from '../common/agentLoopStrategy.js';
import { DEFAULT_PARADIGM_BY_CHATMODE } from '../common/preExploreDecision.js';
import { HermesReActStrategy } from './strategies/hermesReActStrategy.js';
import { MiMoStrategy } from './strategies/mimoStrategy.js';
import { ReadonlyStrategy } from './strategies/readonlyStrategy.js';
import { DelegationStrategy } from './strategies/delegationStrategy.js';
import { GraphStrategy } from './strategies/graphStrategy.js';

export class AgentLoopStrategyFactory {
	private readonly _registry = new Map<AgentParadigm, () => IAgentLoopStrategy>();

	constructor() {
		// ReAct 系：共享 HermesReAct 引擎（预算门控 + 委托编排 + preExplore）
		this._registry.set('budgeted-react', () => new HermesReActStrategy());
		this._registry.set('plan-explore', () => new HermesReActStrategy());
		this._registry.set('react', () => new HermesReActStrategy());
		// MiMo 系：Hermes 引擎 + 主会话 TaskGate（DB 真相完成门）
		this._registry.set('mimo', () => new MiMoStrategy());
		// 独立实现：各有独立 preLoop / prepareIteration / shouldTerminate 行为
		this._registry.set('readonly', () => new ReadonlyStrategy());
		this._registry.set('delegation', () => new DelegationStrategy());
		this._registry.set('graph', () => new GraphStrategy());
	}

	/** 注册一个范式实现（可被外部 Agent 配置或插件覆盖） */
	register(paradigm: AgentParadigm, factory: () => IAgentLoopStrategy): void {
		this._registry.set(paradigm, factory);
	}

	/**
	 * 解析出本次 turn 应使用的策略。
	 * @param request 含 chatMode / 可选 paradigm 字段
	 * @param agentParadigm 可选：来自 Agent 配置（agent.config.paradigm）
	 */
	resolve(request: IAgentTurnRequest, agentParadigm?: AgentParadigm): IAgentLoopStrategy {
		const explicit = (request.paradigm as AgentParadigm | undefined)
			?? (request as any).paradigm as AgentParadigm | undefined; // 兼容旧调用方
		const chatMode = ((request.chatMode as string) || 'craft');
		const fromChatMode = DEFAULT_PARADIGM_BY_CHATMODE[chatMode] ?? 'budgeted-react';
		const paradigm: AgentParadigm = explicit ?? agentParadigm ?? fromChatMode;
		const factory = this._registry.get(paradigm);
		if (factory) {
			return factory();
		}
		// 未知范式：回退默认 Hermes-ReAct（永不崩溃）
		return new HermesReActStrategy();
	}
}
