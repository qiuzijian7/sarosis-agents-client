/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import {
	IModelProvider, IModelSelection,
	IMemoryProvider, IToolProvider, IPlanningProvider, IExecutionProvider, IRetrievalProvider, IKanbanProvider,
	IAgentTurnRequest, IChatStreamDelta, ISlotRegistry,
} from './providers.js';

// ─── Agent OS Service ───────────────────────────────────────────────────────

export const IAgentOSService = createDecorator<IAgentOSService>('agentOSService');

/**
 * Agent OS 中间层核心服务
 * 统一编排所有能力槽（Model / Memory / Tool / Planning / Execution / Retrieval / Kanban）
 *
 * 架构位置：
 *   UI → Driver Layer → **OS Layer (IAgentOSService)** → Provider Plugins
 */
export interface IAgentOSService {
	readonly _serviceBrand: undefined;

	// ─── 能力槽注册 ─────────────────────────────────────────────────

	/**
	 * 注册 Model Provider（支持多个，用户在 UI 中选择）
	 */
	registerModelProvider(provider: IModelProvider): IDisposable;

	/**
	 * 注册 Memory Provider（优先级自动选择活跃 Provider）
	 */
	registerMemoryProvider(provider: IMemoryProvider, priority?: number): IDisposable;

	/**
	 * 注册 Tool Provider
	 */
	registerToolProvider(provider: IToolProvider, priority?: number): IDisposable;

	/**
	 * 注册 Planning Provider
	 */
	registerPlanningProvider(provider: IPlanningProvider, priority?: number): IDisposable;

	/**
	 * 注册 Execution Provider
	 */
	registerExecutionProvider(provider: IExecutionProvider, priority?: number): IDisposable;

	/**
	 * 注册 Retrieval (RAG) Provider
	 */
	registerRetrievalProvider(provider: IRetrievalProvider, priority?: number): IDisposable;

	/**
	 * 注册 Kanban Provider
	 */
	registerKanbanProvider(provider: IKanbanProvider, priority?: number): IDisposable;

	// ─── Model Provider 管理（多 Provider 多模型）────────────────────

	readonly onDidChangeModelProviders: Event<void>;
	getModelProviders(): IModelProvider[];
	getActiveModelSelection(): IModelSelection;
	setActiveModelSelection(selection: IModelSelection): void;

	// ─── 其他能力查询（优先级自动选择）────────────────────────────

	getActiveMemoryProvider(): IMemoryProvider | undefined;
	getActiveToolProvider(): IToolProvider | undefined;
	getActivePlanningProvider(): IPlanningProvider | undefined;
	getActiveExecutionProvider(): IExecutionProvider | undefined;
	getActiveRetrievalProvider(): IRetrievalProvider | undefined;
	getActiveKanbanProvider(): IKanbanProvider | undefined;

	// ─── Slot Registry（传递给 ExecutionProvider）──────────────────

	/**
	 * 获取 SlotRegistry，供 ExecutionProvider 在 Agent Loop 内部回调 OS 各能力槽
	 */
	getSlotRegistry(): ISlotRegistry;

	// ─── 统一执行入口（替代原 IAgentChatService.sendMessage）────────

	/**
	 * 执行一次 Agent 对话轮次
	 * 内部编排：Planning → Memory → Execution(Tool) → Memory → 返回流
	 */
	executeAgentTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta>;
}
