/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IExecutionProvider, IAgentTurnRequest, IChatStreamDelta, ISlotRegistry, IToolResult, IToolDefinition } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IterationBudget } from '../../../common/iterationBudget.js';
import { ContextManager } from '../../../common/contextManager.js';
import { ToolArgumentRepairer } from '../../../common/toolRepair.js';
import { ParallelToolExecutor } from '../../../common/parallelToolExecutor.js';
import { filterToolsByChatMode } from '../../../common/chatModeConfig.js';
import type { IChatMessage, IModelOptions, IToolCallInfo, IModelDelta } from '../../../common/providers.js';
import type { ChatMessage } from '../../../common/types.js';

/**
 * 完整的 Execution Provider 实现
 * 实现 Agent Loop: Plan → Act → Observe → Reflect
 * 参考 Hermes-Agent 的 AIAgent 类实现
 */
export class ExecutionProvider implements IExecutionProvider {

	readonly id: string = 'default-execution-provider';
	readonly name: string = 'Default Execution Provider';

	private readonly _logService: ILogService;

	// 配置
	private readonly _defaultMaxIterations: number = 90;
	private readonly _contextWindow: number = 128000; // 默认上下文窗口
	private readonly _maxTokens: number = 4096;

	constructor(
		@ILogService logService: ILogService,
	) {
		this._logService = logService;
	}

	async *runAgentLoop(
		request: IAgentTurnRequest,
		slots: ISlotRegistry,
	): AsyncIterable<IChatStreamDelta> {
		this._logService.info(`[ExecutionProvider] Starting Agent Loop for agent ${request.agentId}`);

		// 1. 初始化迭代预算
		const budget = new IterationBudget(this._defaultMaxIterations);
		this._logService.debug(`[ExecutionProvider] Iteration budget: ${budget.getSummary()}`);

		// 2. 获取活跃的能力槽
		const modelProvider = slots.getActiveModelProvider();
		const toolProvider = slots.getActiveToolProvider();
		const memoryProvider = slots.getActiveMemoryProvider();

		if (!modelProvider) {
			this._logService.error('[ExecutionProvider] No ModelProvider available');
			yield {
				type: 'error',
				content: 'No ModelProvider available. Please configure a model provider.',
			};
			return;
		}

		// 3. 初始化消息历史
		let messages: IChatMessage[] = [...request.messages];

		// 4. 加载记忆上下文（如果有 Memory Provider）
		if (memoryProvider) {
			try {
				const memoryContext = await memoryProvider.loadContext(request.agentId, request.sessionId || '');
				// 将记忆合并到系统消息中
				if (memoryContext.systemPrompt) {
					messages.unshift({
						role: 'system',
						content: memoryContext.systemPrompt,
					});
				}
				this._logService.debug('[ExecutionProvider] Loaded memory context');
			} catch (error) {
				this._logService.error('[ExecutionProvider] Failed to load memory:', error);
			}
		}

		// 5. 初始化上下文管理器
		const contextManager = new ContextManager(modelProvider, this._getModelId(slots));
		let modelId = this._getModelId(slots);

		// 6. 初始化并行工具执行器
		const parallelExecutor = new ParallelToolExecutor();

		// 7. Agent 主循环
		try {
			let iterationCount = 0;
			while (budget.hasRemaining()) {
				iterationCount++;
				this._logService.debug(`[ExecutionProvider] Iteration ${budget.consumed + 1}/${budget.maxIterations}`);

				// TEST: Yield a sample progress delta (for testing new card types)
				if (iterationCount === 1) {
					yield {
						type: 'progress',
						progressData: [{
							id: 'test-progress-1',
							content: '正在执行任务...',
							status: 'in-progress' as const,
							icon: 'spinner' as const,
							timestamp: new Date().toISOString(),
						}],
					};
				}

				// 7.1 上下文压缩（如需要）
				messages = [...await contextManager.compressIfNeeded(messages as unknown as ReadonlyArray<ChatMessage>, this._contextWindow)] as unknown as IChatMessage[];

				// 7.2 构建模型选项
				let tools: IToolDefinition[] | undefined;
				if (toolProvider) {
					const allTools = await toolProvider.listTools(request.agentId);
					const chatMode = request.chatMode || 'craft';

					// Filter tools by chat mode (unified in chatModeConfig)
					tools = filterToolsByChatMode(allTools, chatMode);
					if (tools.length === 0) {
						tools = undefined;
					}
					this._logService.info(`[ExecutionProvider] Chat mode=${chatMode}: ${tools?.length ?? 0}/${allTools.length} tools allowed`);
				}

				const modelOptions: IModelOptions = {
					temperature: request.options?.temperature ?? 0.7,
					maxTokens: request.options?.maxTokens ?? this._maxTokens,
					systemPrompt: request.systemPrompt,
					tools,
					stop: request.options?.stop,
				};

			// 7.3 调用模型（传递 context 包含 agentId）
			this._logService.debug(`[ExecutionProvider] Calling model ${modelId} with ${messages.length} messages`);

			let modelResponse: IModelDelta[] = [];
			const modelContext: { agentId?: string } = {};
			if (request.agentId) {
				modelContext.agentId = request.agentId;
			}
			const modelStream = modelProvider.chat(modelId, messages, modelOptions, modelContext);

			// 收集模型响应并 yield 给调用者
			// 注意：IChatMessage 的属性是只读的，所以需要收集数据后创建新对象
			let assistantContent = '';
			let assistantToolCalls: IToolCallInfo[] = [];

			for await (const delta of modelStream) {
				// 将模型 delta 转换为 stream delta 并 yield
				const streamDelta = this._convertToStreamDelta(delta);
				if (streamDelta) {
					yield streamDelta;
				}

				// 收集完整的助手消息
				if (delta.type === 'text' && delta.content) {
					assistantContent += delta.content;
				} else if (delta.type === 'tool_call' && delta.toolCall) {
					assistantToolCalls.push(delta.toolCall);
				}

				modelResponse.push(delta);

				if (delta.type === 'done' || delta.type === 'error') {
					break;
				}
			}

			// 创建助手消息并添加到历史
			if (assistantContent || assistantToolCalls.length > 0) {
				const assistantMessage: IChatMessage = {
					role: 'assistant',
					content: assistantContent,
					toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
				};
				messages.push(assistantMessage);
			}

				// 7.4 检查是否需要执行工具调用
				if (assistantToolCalls.length === 0) {
					// 没有工具调用，对话结束
					this._logService.info('[ExecutionProvider] No tool calls, ending conversation');
					yield { type: 'done' };
					break;
				}

				// 7.5 执行工具调用
				const toolResults = await this._executeToolCalls(
					assistantToolCalls,
					toolProvider,
					parallelExecutor,
					slots,
				);

				// 7.6 将工具结果添加到消息历史
				for (const toolResult of toolResults) {
					const toolResultMessage: IChatMessage = {
						role: 'tool',
						content: JSON.stringify(toolResult.content),
						toolCallId: toolResult.toolCallId,
					};
					messages.push(toolResultMessage);
				}

				// 7.6a Plan-mode: if exit_plan_mode was called, emit a confirmation delta
				// and stop the loop so the user can review and approve the plan.
				if (request.chatMode === 'plan') {
					const exitPlanCall = assistantToolCalls.find(tc => tc.name === 'exit_plan_mode');
					if (exitPlanCall) {
						this._logService.info('[ExecutionProvider] PLAN mode: exit_plan_mode called, emitting confirmation');
						try {
							const args = typeof exitPlanCall.arguments === 'string'
								? JSON.parse(exitPlanCall.arguments)
								: exitPlanCall.arguments;
							yield {
								type: 'confirmation',
								confirmationData: {
									id: `plan-approval-${Date.now()}`,
									type: 'plan-approval' as const,
									title: 'Plan Approval',
									planSummary: args?.plan_summary || '',
									tasks: (args?.tasks || []).map((t: any) => ({
										title: t.title || '',
										description: t.description || '',
										files: t.files || [],
										complexity: t.complexity,
										suggestedRole: t.suggestedRole,
										dependencies: t.dependencies,
									})),
									nextMode: args?.next_mode || 'craft',
								},
							} as IChatStreamDelta;
						} catch {
							// If parsing fails, just continue normally
						}
						yield { type: 'done' };
						break;
					}
				}

				// 7.7 更新记忆（如果有 Memory Provider）
				if (memoryProvider) {
					try {
						await memoryProvider.writeMemory(request.agentId, {
							id: `msg-${Date.now()}`,
							type: 'short_term',
							content: assistantContent || 'Tool execution completed',
							metadata: {
								toolCalls: assistantToolCalls?.length || 0,
								toolResults: toolResults.length,
							},
							timestamp: Date.now(),
						});
					} catch (error) {
						this._logService.error('[ExecutionProvider] Failed to write memory:', error);
					}
				}

				// 7.8 消耗迭代预算
				budget.consume(1);

				// 7.9 检查预算是否即将耗尽
				if (budget.isRunningLow()) {
					this._logService.warn(`[ExecutionProvider] Budget running low: ${budget.getSummary()}`);
					yield {
						type: 'text',
						content: `\n[System: Budget running low (${budget.getSummary()}). Consider wrapping up.]`,
					};
				}
			}

			// 8. 检查是否因预算耗尽而退出
			if (!budget.hasRemaining()) {
				this._logService.warn(`[ExecutionProvider] Budget exhausted: ${budget.getSummary()}`);
				yield {
					type: 'text',
					content: '\n[System: Iteration budget exhausted. Ending conversation.]',
				};
				yield { type: 'done' };
			}

		} catch (error) {
			this._logService.error('[ExecutionProvider] Agent Loop failed:', error);
			yield {
				type: 'error',
				content: `Agent Loop failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * 执行工具调用
	 */
	private async _executeToolCalls(
		toolCalls: IToolCallInfo[],
		toolProvider: any,
		parallelExecutor: ParallelToolExecutor,
		slots: ISlotRegistry,
	): Promise<IToolResult[]> {
		if (!toolProvider) {
			this._logService.warn('[ExecutionProvider] No ToolProvider available for tool execution');
			return [];
		}

		// 转换 IToolCallInfo 为 IToolCall
		const toolCallObjects = toolCalls.map(tc => ({
			id: tc.id,
			name: tc.name,
			arguments: ToolArgumentRepairer.validateAndRepair(tc.name, tc.arguments),
		}));

		// 使用并行执行器执行工具
		const results = await parallelExecutor.executeTools(
			toolCallObjects,
			async (toolCall) => {
				this._logService.debug(`[ExecutionProvider] Executing tool: ${toolCall.name}`);
				return await toolProvider.executeTool(slots, toolCall);
			},
		);

		return results;
	}

	/**
	 * 将 IModelDelta 转换为 IChatStreamDelta
	 */
	private _convertToStreamDelta(delta: IModelDelta): IChatStreamDelta | null {
		if (delta.type === 'text') {
			return {
				type: 'text',
				content: delta.content,
			};
		}

		if (delta.type === 'thinking') {
			return {
				type: 'thinking',
				content: delta.content,
			};
		}

		if (delta.type === 'tool_call') {
			return {
				type: 'tool_start',
				toolCallId: delta.toolCall?.id,
				toolName: delta.toolCall?.name,
			};
		}

		if (delta.type === 'done') {
			return { type: 'done' };
		}

		if (delta.type === 'error') {
			return {
				type: 'error',
				content: delta.error,
			};
		}

		return null;
	}

	/**
	 * 获取当前活跃的模型 ID
	 */
	private _getModelId(slots: ISlotRegistry): string {
		// Query the active model selection from the SlotRegistry bridge
		const selection = slots.getActiveModelSelection();
		if (selection?.modelId) {
			this._logService.debug(`[ExecutionProvider] Using model from active selection: ${selection.modelId}`);
			return selection.modelId;
		}
		// Fallback: try the default model from the first provider
		this._logService.warn('[ExecutionProvider] No active model selection found, falling back to gpt-4o');
		return 'gpt-4o';
	}
}
