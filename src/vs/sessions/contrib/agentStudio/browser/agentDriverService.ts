/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentDriverService, AgentTurnStatus } from '../common/agentDriver.js';
import { IAgentTurnRequest, IMemoryContext } from '../common/providers.js';
import type { IChatStreamDelta } from '../common/providers.js';
import { IAgentOSService } from '../common/agentOS.js';
import type { IChatSendOptions } from '../common/agentStudio.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISkillRegistry } from '../common/skills.js';

// ─── Agent Driver Service Implementation ────────────────────────

export class AgentDriverService extends Disposable implements IAgentDriverService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTurnStatus = this._register(new Emitter<AgentTurnStatus>());
	readonly onDidChangeTurnStatus = this._onDidChangeTurnStatus.event;

	private readonly _turnStatusMap = new Map<string, AgentTurnStatus>();
	private readonly _activeTurns = new Map<string, AbortController>();
	private readonly _logService: ILogService;

	constructor(
		@IAgentOSService private readonly _agentOS: IAgentOSService,
		@ISkillRegistry private readonly _skillRegistry: ISkillRegistry,
		@ILogService logService: ILogService,
	) {
		super();
		this._logService = logService;
	}

	// ─── 统一执行入口 ─────────────────────────────────────

	async *executeTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		// Composite turnId: session-scoped to prevent cross-fork cancellation
		const turnId = request.sessionId ? `${request.sessionId}::${request.agentId}` : request.agentId;

		// 如果已有同 ID 的轮次在运行，先取消
		this.cancelTurn(turnId);

		const controller = new AbortController();
		this._activeTurns.set(turnId, controller);

		try {
			this._updateTurnStatus(turnId, AgentTurnStatus.Running);

			// ─── 完整编排逻辑 ─────────────────────────────────
			// 1. Planning Slot 分析意图（如果有 Planning Provider）
			// 2. Memory Slot 加载上下文（如果有 Memory Provider）
			// 3. 委托 AgentOS 执行（ExecutionProvider 或 直通模式）
			// 4. Memory Slot 写回记忆（如果有 Memory Provider）
			// 5. 返回结果给 UI

			// Step 1: 加载 Memory 上下文
			let memoryContext: IMemoryContext | undefined;
			const memoryProvider = this._agentOS.getActiveMemoryProvider();
			if (memoryProvider) {
				try {
					memoryContext = await memoryProvider.loadContext(request.agentId, request.sessionId || '');
					this._logService.debug(`[AgentDriver] Loaded memory context for ${request.agentId}`);
				} catch (error) {
					this._logService.error('[AgentDriver] Failed to load memory context:', error);
				}
			}

			// Step 2: Planning 分析意图（如果有 Planning Provider）
			const planningProvider = this._agentOS.getActivePlanningProvider();
			if (planningProvider && memoryContext) {
				try {
					const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
					if (lastUserMessage) {
						const plan = await planningProvider.analyzeIntent(lastUserMessage.content, memoryContext);
						this._logService.info(`[AgentDriver] Planning result: intent="${plan.intent}", complexity=${plan.estimatedComplexity}, steps=${plan.steps.length}`);

						// 如果规划了复杂任务，yield planning 信息给 UI
						if (plan.estimatedComplexity === 'high' || plan.estimatedComplexity === 'medium') {
							yield {
								type: 'thinking',
								content: `[Planning] Intent: ${plan.intent}\n[Planning] Complexity: ${plan.estimatedComplexity}\n[Planning] Steps: ${plan.steps.length}`,
							};
						}
					}
				} catch (error) {
					this._logService.error('[AgentDriver] Planning analysis failed:', error);
					// Planning 失败不阻塞主流程
				}
			}

			// Step 3: 解析并注入已激活的 Skills + 已安装技能清单
			const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
			let enrichedRequest = request;

			try {
				// 3a. 生成已安装技能清单（让模型知道有哪些技能）
				const allSkills = [...this._skillRegistry.getSkills()].filter(s => s.enabled !== false);
				let mergedSystemPrompt = request.systemPrompt || '';

				if (allSkills.length > 0) {
					const skillListSection = [
						'',
						'## Installed Skills',
						'',
						'The following skills are installed and available:',
						'',
						...allSkills.map(s => `- **${s.name}**${s.description ? `: ${s.description}` : ''} [${s.activation}] (source: ${s.source})`),
						'',
					].join('\n');
					mergedSystemPrompt = mergedSystemPrompt + skillListSection;
				}

				// 3b. 解析本轮激活的技能内容并注入
				let mergedMessages = [...request.messages];

				if (lastUserMessage) {
					const injections = await this._skillRegistry.resolveActivations({
						userMessage: lastUserMessage.content,
						agentId: request.agentId,
						sessionId: request.sessionId,
					});

					if (injections.length > 0) {
						// 分离 system 和 user 注入
						const systemInjections = injections.filter(inj => inj.placement === 'system');
						const userInjections = injections.filter(inj => inj.placement === 'user');

						// 将 system 类型的 skill 注入追加到 systemPrompt
						if (systemInjections.length > 0) {
							const activeSection = [
								'',
								'## Active Skills (this turn)',
								'',
								...systemInjections.map(inj => inj.content),
							].join('\n');
							mergedSystemPrompt = mergedSystemPrompt + activeSection;
						}

						// 将 user 类型的 skill 注入插入为 user message（在实际用户消息之前）
						if (userInjections.length > 0) {
							const skillMessages = userInjections.map(inj => ({
								role: 'user' as const,
								content: inj.content,
							}));
							// 插入到最后一条用户消息之前
							const lastIdx = mergedMessages.length - 1;
							mergedMessages = [
								...mergedMessages.slice(0, lastIdx),
								...skillMessages,
								mergedMessages[lastIdx],
							];
						}

						this._logService.info(`[AgentDriver] Injected ${injections.length} skills (system: ${systemInjections.length}, user: ${userInjections.length})`);
					}
				}

				enrichedRequest = {
					...request,
					systemPrompt: mergedSystemPrompt,
					messages: mergedMessages,
				};

				this._logService.info(`[AgentDriver] Skill inventory: ${allSkills.length} skills available`);
			} catch (error) {
				this._logService.error('[AgentDriver] Failed to resolve skill activations:', error);
				// Skill 解析失败不阻塞主流程
			}

			// Step 4: 委托 AgentOS 执行（ExecutionProvider 或 直通模式）
			const osStream = this._agentOS.executeAgentTurn(enrichedRequest);

			for await (const delta of osStream) {
				// 检查取消
				if (controller.signal.aborted) {
					yield { type: 'done' };
					break;
				}
				yield delta;
			}

			// Step 5: 写回记忆（如果有 Memory Provider）
			if (memoryProvider) {
				try {
					const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
					if (lastUserMessage) {
						await memoryProvider.writeMemory(request.agentId, {
							id: `memory-${Date.now()}`,
							type: 'short_term',
							content: lastUserMessage.content,
							timestamp: Date.now(),
						});
						this._logService.debug(`[AgentDriver] Wrote memory for ${request.agentId}`);
					}
				} catch (error) {
					this._logService.error('[AgentDriver] Failed to write memory:', error);
				}
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
		// NOTE: Do NOT call chatService.cancelStream() here.
		// AgentChatService.sendMessage() already cancels old streams on entry (line 46).
		// Calling cancelStream() here would abort the *new* controller that sendMessage()
		// just created, causing the stream to be killed after the first delta.
	}

	// ─── 查询轮次状态 ─────────────────────────────────

	getTurnStatus(turnId: string): AgentTurnStatus {
		return this._turnStatusMap.get(turnId) ?? AgentTurnStatus.Idle;
	}

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
			sessionId: options.agentSessionId,
			messages: [{ role: 'user', content: message }],
			systemPrompt: options.systemPrompt,
			options: {
				temperature: options.temperature,
			},
		};
		yield* this.executeTurn(request);
	}
}
