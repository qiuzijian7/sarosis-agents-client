/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentDriverService, AgentTurnStatus } from '../common/agentDriver.js';
import { IAgentTurnRequest } from '../common/providers.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IAgentChatService, IChatStreamDelta, IChatSendOptions } from '../common/agentStudio.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

// ─── Agent Driver Service Implementation ────────────────────────

export class AgentDriverService extends Disposable implements IAgentDriverService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTurnStatus = this._register(new Emitter<AgentTurnStatus>());
	readonly onDidChangeTurnStatus = this._onDidChangeTurnStatus.event;

	private readonly _turnStatusMap = new Map<string, AgentTurnStatus>();
	private readonly _activeTurns = new Map<string, AbortController>();

	private _logService: ILogService = console as unknown as ILogService;
	private _agentChatService: IAgentChatService | undefined;

	constructor(
		@IAgentOSService private readonly _agentOS: IAgentOSService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	private _getAgentChatService(): IAgentChatService {
		if (!this._agentChatService) {
			this._agentChatService = this._instantiationService.invokeFunction(accessor => accessor.get(IAgentChatService));
		}
		return this._agentChatService;
	}

	// ─── 统一执行入口 ─────────────────────────────────────

	async *executeTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		const turnId = request.agentId;

		// 如果已有同 ID 的轮次在运行，先取消
		this.cancelTurn(turnId);

		const controller = new AbortController();
		this._activeTurns.set(turnId, controller);

		try {
			this._updateTurnStatus(turnId, AgentTurnStatus.Running);

			// Phase 2 编排逻辑：
			// 1. Planning Slot 分析意图（如果有 Planning Provider）
			// 2. Memory Slot 加载上下文（如果有 Memory Provider）
			// 3. Model Slot 生成推理
			// 4. Tool Slot 执行工具（如果有 Tool Provider）
			// 5. Memory Slot 写回记忆（如果有 Memory Provider）
			// 6. 返回结果给 UI

			// 当前实现：直通模式（委托 agentOS.executeAgentTurn）
			// 后续逐步增强为完整编排
			const osStream = this._agentOS.executeAgentTurn(request);

			for await (const delta of osStream) {
				// 检查取消
				if (controller.signal.aborted) {
					yield { type: 'done' };
					break;
				}
				yield delta;
			}

			this._updateTurnStatus(turnId, AgentTurnStatus.Done);

		} catch (error) {
			this._logService.error(`[AgentDriver] Turn ${turnId} failed:`, error);
			this._updateTurnStatus(turnId, AgentTurnStatus.Error);
			yield {
				type: 'error',
				content: String(error),
			};
		} finally {
			this._activeTurns.delete(turnId);
		}
	}

	// ─── 取消轮次 ─────────────────────────────────────

	cancelTurn(turnId: string): void {
		const controller = this._activeTurns.get(turnId);
		if (controller) {
			this._logService.info(`[AgentDriver] Cancelling turn ${turnId}`);
			this._updateTurnStatus(turnId, AgentTurnStatus.Cancelling);
			controller.abort();
			this._activeTurns.delete(turnId);
		}
		// 同时取消 agentChatService 中的流（兼容旧代码）
		this._getAgentChatService().cancelStream(turnId);
	}

	// ─── 查询轮次状态 ─────────────────────────────────

	getTurnStatus(turnId: string): AgentTurnStatus {
		return this._turnStatusMap.get(turnId) ?? AgentTurnStatus.Idle;
	}

	// ─── 内部方法 ─────────────────────────────────────

	private _updateTurnStatus(turnId: string, status: AgentTurnStatus): void {
		this._turnStatusMap.set(turnId, status);
		this._onDidChangeTurnStatus.fire(status);
	}

	// ─── 兼容层：将旧 IChatSendOptions 适配为 IAgentTurnRequest ──

	/**
	 * 兼容现有 agentChatService.sendMessage() 调用方式
	 * Phase 2 中 agentChatService 将委托此方法
	 */
	async *executeFromChatOptions(
		employeeId: string,
		message: string,
		options: IChatSendOptions,
	): AsyncIterable<IChatStreamDelta> {
		const request: IAgentTurnRequest = {
			agentId: employeeId,
			messages: [{ role: 'user', content: message }],
			systemPrompt: options.systemPrompt,
			options: {
				temperature: options.temperature,
			},
		};
		yield* this.executeTurn(request);
	}

	// ─── 服务注入 ─────────────────────────────────────

	setLogService(logService: ILogService): void {
		this._logService = logService;
	}
}
