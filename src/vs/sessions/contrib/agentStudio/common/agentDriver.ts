/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import type { IAgentTurnRequest, IChatMessage, IChatStreamDelta, IMemoryProvider } from './providers.js';
import type { IChatSendOptions } from './agentStudio.js';

// ─── Agent Driver Service ─────────────────────────────────────────

export const IAgentDriverService = createDecorator<IAgentDriverService>('agentDriverService');

/**
 * Agent Driver Service
 *
 * 驱动层：UI → OS 之间的统一入口。
 * 将现有 agentChatService.sendMessage() 重构为委托 Driver。
 *
 * 核心职责：
 * 1. 作为 UI 与 OS 中间层之间的统一入口
 * 2. 编排一次对话轮次的完整流程
 * 3. 管理 Turn 生命周期（开始、取消）
 * 4. 流控与帧节流（继承现有 16ms 逻辑）
 */
export interface IAgentDriverService {
	readonly _serviceBrand: undefined;

	/**
	 * 执行一次 Agent 对话轮次
	 * @param request - 轮次请求（含 agentId, messages, options）
	 * @returns 异步可迭代流，产生 IChatStreamDelta 事件
	 */
	executeTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta>;

	/**
	 * 兼容层：将旧 IChatSendOptions 适配为 IAgentTurnRequest
	 *
	 * @param priorMessages 可选的会话历史消息（driver 格式）。由 chatService
	 *   从持久化历史转换后传入，用于让后端 turn 收到完整上下文而非仅当前 user
	 *   消息——长对话上下文才能涨起来并触发压缩。当前 user 消息会追加在其后。
	 */
	executeFromChatOptions(
		agentId: string,
		message: string,
		options: IChatSendOptions,
		priorMessages?: IChatMessage[],
	): AsyncIterable<IChatStreamDelta>;

	/**
	 * 取消正在执行的轮次
	 * @param turnId - 轮次 ID（通常为 agentId）
	 */
	cancelTurn(turnId: string): void;

	/**
	 * 当前是否有正在执行的轮次
	 */
	readonly onDidChangeTurnStatus: Event<{ status: AgentTurnStatus; turnId: string }>;

	/**
	 * 获取指定轮次的当前状态
	 */
	getTurnStatus(turnId: string): AgentTurnStatus;

	/**
	 * 获取当前活跃的 Memory Provider（供 chatService 订阅其 lifecycle 事件）
	 */
	getActiveMemoryProvider(): IMemoryProvider | undefined;

	/**
	 * 入队一条运行中 steering 消息（用户在 turn 执行期间补充的输入）。
	 *
	 * 与 `executeTurn` 的新请求不同，steering **不打断**当前轮次：消息进入 per-agent
	 * 交付队列，由主循环每轮 iteration 顶部的门控段注入（见 `common/loopGate.ts`
	 * 的 `injectSteeringMessages`）。因此用户在 stream 活跃时补充的输入会在
	 * **下一轮**生效，而当前轮次已产生的中间成果不会丢失。
	 *
	 * 声明在接口上而非仅实现类上：controller 需经 DI 边界调用，绕过接口会使
	 * webview → controller → driver 的投递链在 DI 处断开。
	 *
	 * @param agentId 目标 agent（同时作为队列的交付目标）
	 * @param content 用户补充的文本内容
	 * @param from 来源标记，默认 `'user'`；子任务/子 agent 可传自己的 id 以区分来源
	 * @returns 入队后的交付项 id；队列不可用时返回 undefined
	 */
	enqueueSteeringMessage(agentId: string, content: string, from?: string): string | undefined;
}

export const enum AgentTurnStatus {
	Idle = 'idle',
	Running = 'running',
	Cancelling = 'cancelling',
	Done = 'done',
	Error = 'error',
}

// ─── Turn Lifecycle Events ──────────────────────────────────────

export interface IAgentTurnLifecycle {
	readonly turnId: string;
	readonly status: AgentTurnStatus;
	readonly startTime?: number;
	readonly endTime?: number;
	readonly error?: string;
}
