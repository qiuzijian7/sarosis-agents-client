/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IExecutionProvider, IAgentTurnRequest, IChatStreamDelta, ISlotRegistry, IToolResult, IToolDefinition } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IterationBudget } from '../../../common/iterationBudget.js';
import { ContextManager } from '../../../common/contextManager.js';
import { ToolArgumentRepairer } from '../../../common/toolRepair.js';
import { ParallelToolExecutor } from '../../../common/parallelToolExecutor.js';
import { FileContextStorageService } from '../../contextStorageService.js';
import { userDataRootFromRoamingHome } from '../../../common/sarosPaths.js';

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

	/** 懒创建的上下文存储（快照/摘要持久化到 context-storage/） */
	private _contextStorage?: FileContextStorageService;

	constructor(
		@ILogService logService: ILogService,
		@IFileService private readonly fileService?: IFileService,
		@IEnvironmentService private readonly environmentService?: IEnvironmentService,
	) {
		this._logService = logService;
	}

	/** 懒创建 IContextStorage；缺少文件服务依赖时返回 undefined（内存模式） */
	private _getContextStorage(): FileContextStorageService | undefined {
		if (!this.fileService || !this.environmentService) {
			return undefined;
		}
		if (!this._contextStorage) {
			this._contextStorage = new FileContextStorageService(
				this.fileService,
				this._logService,
				userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome),
			);
		}
		return this._contextStorage;
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

		// 4. 加载记忆上下文（冻结快照模式，借鉴 Hermes Agent）
		// ── 设计说明 ──────────────────────────────────────────────────────────
		// Hermes 的"冻结快照"：会话开始时把 Persona/L1 注入 system prompt，
		// 会话内不再刷新（中途写入的新记忆下次会话才生效）。
		// 好处：保持 KV prefix cache 稳定，prefix 不变则推理服务端可复用计算结果。
		// 参见：doc/Memory-Strategy.md §4.2 / §五.2
		if (memoryProvider) {
			try {
				// 抽取最近一条 user 消息作为召回 query —— 让 vendor 能用真实意图
				// 做 FTS5/embedding 匹配，而不是占位字符串（详见 IMemoryProvider.loadContext 注释）
				const recallQuery = [...request.messages].reverse().find(m => m.role === 'user')?.content ?? '';

				// ── 召回作用域（2026-06）─────────────────────────────────
				// 复用 AgentDriver 在 enrichedRequest 上提前算好的 scope。
				// 缺省按 'agent' 严格隔离。
				const recallScope: 'agent' | 'global' = request.memoryScope ?? 'agent';
				const recallOptions = { scope: recallScope };

			const memoryContext = await memoryProvider.loadContext(
				request.agentId,
				request.sessionId || '',
				recallQuery,
				// includeEntries: 本循环的注入仍消费长/短期记忆数组（见下方
				// Long-term/Short-term 块），显式开启——注入主路径
				// （agentMemoryInjection）已默认关闭以省全表扫描。
				{ ...recallOptions, includeEntries: true },
			);

				// ─── 按 memoryConfig.strategy 过滤 memoryContext ────────────
				// 与 agentOSService 中的注入策略保持一致，详见该处注释。
				const strategy: 'summary' | 'full' = request.memoryStrategy === 'summary' ? 'summary' : 'full';
				const maxEntries = typeof request.memoryMaxEntries === 'number' && request.memoryMaxEntries > 0
					? request.memoryMaxEntries
					: undefined;
				const cap = <T,>(arr: T[] | undefined): T[] => {
					if (!arr || arr.length === 0) { return []; }
					if (maxEntries === undefined) { return arr; }
					return arr.length > maxEntries ? arr.slice(-maxEntries) : arr;
				};
				// L1 在 summary 与 full 两种策略下都注入；L0 仅在 full 下注入（full ⊇ summary）。
				const filteredLongTerm = cap(memoryContext.longTermMemories);
				const filteredShortTerm = strategy === 'full' ? cap(memoryContext.shortTermMemories) : [];

				// ── 收集所有记忆内容 ──
				const memoryParts: string[] = [];

				// longTermMemories（L1/L2 召回内容）——AgentMemory 的核心记忆
				if (filteredLongTerm.length > 0) {
					const ltContents = filteredLongTerm
						.map(m => m.content)
						.filter(Boolean)
						.join('\n\n');
					if (ltContents.trim().length > 0) {
						memoryParts.push(`## Long-term Memory (AgentMemory Recall)\n\n${ltContents}`);
					}
				}

				// shortTermMemories（最近几轮摘要，通常为空，因 AgentMemory 不填此字段）
				if (filteredShortTerm.length > 0) {
					const stContents = filteredShortTerm
						.map(m => m.content)
						.filter(Boolean)
						.join('\n\n');
					if (stContents.trim().length > 0) {
						memoryParts.push(`## Short-term Memory\n\n${stContents}`);
					}
				}

				// systemPrompt（第三方 Memory Provider 可能直接返回格式化字符串）
				// 其本质是 provider 端的摘要表述，属于 L1 范畴，因此在 summary 与 full
				// 两种策略下均注入（full ⊇ summary）。
				if (memoryContext.systemPrompt && memoryContext.systemPrompt.trim().length > 0) {
					memoryParts.push(memoryContext.systemPrompt.trim());
				}

				// ── 注入为 system 消息（放在现有消息历史最前面）──
				// 冻结语义：此处仅在每次 runAgentLoop 开头调用一次，agent loop 内部
				// 不会再次 loadContext，因此即使中途有新记忆写入，本轮 prompt 也不会
				// 被更新——这是"冻结快照"的核心，保证 KV prefix 在整个会话内稳定。
				if (memoryParts.length > 0) {
					const frozenMemoryBlock = `<memory_context>\n${memoryParts.join('\n\n')}\n</memory_context>`;
					messages.unshift({
						role: 'system',
						content: frozenMemoryBlock,
					});
					this._logService.info(`[ExecutionProvider] Injected frozen memory snapshot (strategy=${strategy}, ${frozenMemoryBlock.length} chars, L1/L2=${filteredLongTerm.length}, L0=${filteredShortTerm.length}) into system prompt`);
				}

				this._logService.debug('[ExecutionProvider] Loaded memory context');
			} catch (error) {
				this._logService.error('[ExecutionProvider] Failed to load memory:', error);
			}
		}

		// 5. 初始化上下文管理器
		const contextManager = new ContextManager(modelProvider, this._getModelId(slots));
		// 注入日志服务，使压缩诊断日志输出到 VS Code Output 面板
		contextManager.setLogger({
			info: (msg: string) => this._logService.info(msg),
			warn: (msg: string) => this._logService.warn(msg),
			error: (msg: string, error?: unknown) => this._logService.error(msg, error),
			debug: (msg: string) => this._logService.debug(msg),
		});
		// 接入文件系统持久化（IContextStorage）：快照/摘要落盘到 context-storage/ 目录
		const contextStorage = this._getContextStorage();
		if (contextStorage) {
			contextManager.setStorage(contextStorage);
		}
		let modelId = this._getModelId(slots);
		// 真实上下文窗口：优先读模型 maxInputTokens / contextWindow，取不到回退 _contextWindow（128000）。
		const compressionWindow = await this._resolveContextWindow(modelProvider, modelId);

		// 6. 初始化并行工具执行器
		const parallelExecutor = new ParallelToolExecutor();

		// 7. Agent 主循环
		try {
			let iterationCount = 0;
			// P1: 上一轮 LLM 响应回传的真实 prompt token（provider usage，含 cache）。
			// compressContext 优先用它判定，取代低估的 char/4 粗估。首轮=0 自动退回粗估。
			let lastRealPromptTokens = 0;
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

				// 7.1 上下文压缩（如需要）—— Hermes 三段式 + 压缩中 UI
				// 复用现有 StreamPhase 机制：压缩前发 phase='compressing' 驱动 "正在压缩上下文..." UI，
				// 压缩结束后发 phase='llm_streaming' 切回（后续 model text delta 也会自动切回，此处显式更稳妥）。
				{
					const compressionStartTime = Date.now();
				const originalMessageCount = messages.length;
				const originalEstimatedTokens = this._estimateMessagesTokens(messages as unknown as IChatMessage[]);
				this._logService.info(
					`[ExecutionProvider][Compression] BEFORE: messages=${originalMessageCount}, ` +
					`estimatedTokens=${originalEstimatedTokens}, compressionWindow=${compressionWindow}, ` +
					`lastRealPromptTokens=${lastRealPromptTokens}`
				);

				let compressionResult;
				try {
					compressionResult = await contextManager.compressContext(
						messages as unknown as ReadonlyArray<ChatMessage>,
						undefined,
						compressionWindow,
						lastRealPromptTokens
					);
				} catch (compressionError) {
					// 压缩异常不应中断 Agent 主循环，记录后跳过本轮压缩继续执行
					this._logService.error(
						`[ExecutionProvider][Compression] EXCEPTION during compressContext: ` +
						`${compressionError instanceof Error ? compressionError.message : String(compressionError)}`,
						compressionError
					);
					compressionResult = {
						originalMessageCount: messages.length,
						compressedMessageCount: messages.length,
						summary: '',
						compressedMessages: [...messages] as unknown as ChatMessage[],
						metadata: { compressionRatio: 1.0, skipped: 'exception', error: String(compressionError) },
					};
				}
				const didCompress = compressionResult.compressedMessageCount < compressionResult.originalMessageCount;
				const compressionDurationMs = Date.now() - compressionStartTime;
				// ─── 压缩判定诊断日志（与 AgentOS Path 1 一致）──────────────
				const cmpMeta = compressionResult.metadata ?? {};
				// didCompress=false 时用 warn 级别更醒目，便于在日志中快速定位"为什么没压缩"
				const logFn = didCompress ? this._logService.info.bind(this._logService) : this._logService.warn.bind(this._logService);
				logFn(
					`[ExecutionProvider][Compression] didCompress=${didCompress} ` +
					`skipped=${JSON.stringify(cmpMeta.skipped ?? null)} ` +
					`tokenSource=${cmpMeta.tokenSource ?? 'n/a'} ` +
					`effectiveTokens=${cmpMeta.effectiveTokens ?? 'n/a'} ` +
					`realPromptTokens=${cmpMeta.realPromptTokens ?? 'n/a'} ` +
					`estimatedTokens=${cmpMeta.estimatedTokens ?? 'n/a'} ` +
					`thresholdTokens=${cmpMeta.thresholdTokens ?? 'n/a'} ` +
					`effectiveWindow=${cmpMeta.effectiveWindow ?? 'n/a'} ` +
					`compressionWindow=${compressionWindow} ` +
					`messageCount=${cmpMeta.messageCount ?? messages.length} ` +
					`minMessagesToCompress=${cmpMeta.minMessagesToCompress ?? 'n/a'} ` +
					`ineffectiveCompressionCount=${cmpMeta.ineffectiveCompressionCount ?? 'n/a'} ` +
					`compressionThreshold=${cmpMeta.compressionThreshold ?? 'n/a'}`
				);
					if (didCompress) {
						// 压缩真正发生：通知 UI 进入压缩态（仅在确实压缩时发，避免无谓闪烁）
						yield { type: 'phase_change', phase: 'compressing' };
						messages = [...compressionResult.compressedMessages] as unknown as IChatMessage[];
						const compressedEstimatedTokens = this._estimateMessagesTokens(messages);
						const tokensSaved = originalEstimatedTokens - compressedEstimatedTokens;
						const savePercent = originalEstimatedTokens > 0
							? Math.round(tokensSaved / originalEstimatedTokens * 100)
							: 0;
						this._logService.info(
							`[ExecutionProvider][Compression] AFTER: messages=${compressionResult.compressedMessageCount}, ` +
							`estimatedTokens=${compressedEstimatedTokens}, saved=${tokensSaved} (${savePercent}%), ` +
							`duration=${compressionDurationMs}ms`
						);
						// 回传压缩后估算输入 token，让聊天框圆环进度条立即同步回落。
						yield {
							type: 'context_compacted',
							compactedInputTokens: compressedEstimatedTokens,
							// 压缩详情：用于在聊天消息流中渲染压缩提示卡片
							compressionOriginalCount: originalMessageCount,
							compressionCompressedCount: compressionResult.compressedMessageCount,
							compressionTokensSaved: tokensSaved,
							compressionDurationMs,
						};
						// 压缩完成，切回流式输出态
						yield { type: 'phase_change', phase: 'llm_streaming' };
					}
				}

				// 7.2 构建模型选项
			let tools: IToolDefinition[] | undefined;
			if (toolProvider) {
				const allTools = await toolProvider.listTools(request.agentId);

				tools = allTools;
				if (tools.length === 0) {
					tools = undefined;
				}
				this._logService.info(`[ExecutionProvider] ${tools?.length ?? 0}/${allTools.length} tools loaded`);
			}

			const modelOptions: IModelOptions = {
				temperature: request.options?.temperature ?? 0.7,
				maxTokens: request.options?.maxTokens ?? this._maxTokens,
				systemPrompt: request.systemPrompt,
				tools,
				stop: request.options?.stop,
				// Fork 前缀缓存：透传父级 ForkContext 给请求构造端，对齐时注入 cache 断点。
				forkContext: request.forkContext,
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
			// 用分块数组累积，末尾一次性 join，避免流式 `+=` 产生 ConsString 绳索串（O(n) 且进历史后不会持续膨胀）
			let assistantContentChunks: string[] = [];
			let assistantToolCalls: IToolCallInfo[] = [];

				for await (const delta of modelStream) {
					// 将模型 delta 转换为 stream delta 并 yield
					const streamDelta = this._convertToStreamDelta(delta);
					if (streamDelta) {
						yield streamDelta;
					}

					// 收集完整的助手消息
				if (delta.type === 'text' && delta.content) {
					assistantContentChunks.push(delta.content);
				} else if (delta.type === 'tool_call' && delta.toolCall) {
						assistantToolCalls.push(delta.toolCall);
					} else if (delta.type === 'usage' && delta.usage) {
						// P1: 截获真实 prompt token，供下一轮 compressContext 优先判定。
						// 完整 prompt = inputTokens + 缓存读 + 缓存写（缓存 token 同样占窗口）。
						const u = delta.usage;
						const realPrompt = (u.inputTokens ?? 0) + (u.cachedTokens ?? 0) + (u.cacheWriteTokens ?? 0);
						if (realPrompt > 0) {
							lastRealPromptTokens = realPrompt;
							this._logService.info(
								`[ExecutionProvider][Compression] captured real prompt usage: inputTokens=${u.inputTokens ?? 0} ` +
								`cached=${u.cachedTokens ?? 0} cacheWrite=${u.cacheWriteTokens ?? 0} → lastRealPromptTokens=${lastRealPromptTokens}`
							);
						}
					}

					modelResponse.push(delta);

					if (delta.type === 'done' || delta.type === 'error') {
						break;
					}
				}

			// 创建助手消息并添加到历史
			if (assistantContentChunks.length > 0 || assistantToolCalls.length > 0) {
				const assistantMessage: IChatMessage = {
					role: 'assistant',
					content: assistantContentChunks.join(''),
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
					// P2 源头截断（对齐 MiMo truncate.ts MAX_BYTES=50K）：超大工具输出在写入历史前
					// 即做首尾保留 + 标注，避免污染上下文与压缩输入。仅影响极端大输出，正常结果不变。
					const rawContent = JSON.stringify(toolResult.content);
					const toolResultMessage: IChatMessage = {
						role: 'tool',
						content: ContextManager.truncateSourceToolOutput(rawContent),
						toolCallId: toolResult.toolCallId,
					};
					messages.push(toolResultMessage);
				}


		// 7.7 更新记忆（如果有 Memory Provider）
		// W1（2026-07-26 §16 日志实证修复）：与 agentTurnExecutor 同款改道——
		// 每迭代 writeMemory(type=working) 直写长期层改为 observe 会话暂存层
		// （mem:obs，便宜 KV set + 滑动窗口 + 阈值压缩），不再洪泛 core memory。
		if (memoryProvider) {
			const iterContent = assistantContentChunks.join('');
			if (iterContent.length >= 8 || toolResults.length > 0) {
				void memoryProvider.observe?.(request.agentId, {
					sessionId: request.sessionId || '',
					hookType: 'turn_observation',
					timestamp: new Date().toISOString(),
					data: {
						content: (iterContent || 'Tool execution completed').slice(0, 2000),
						role: 'assistant',
						toolCalls: assistantToolCalls?.length || 0,
						toolResults: toolResults.length,
					},
				}).catch((error: unknown) => {
					this._logService.error('[ExecutionProvider] Failed to observe iteration:', error);
				});
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
	 *
	 * 防御性兜底：上游 IModelDelta（来自各家 ModelProvider）的 content 字段
	 * 不能保证一定是 string —— 例如 vendor copilot 的 LM bridge 在 reasoning
	 * 阶段会发出 type='text' 但 value=undefined 的占位 part。透传到 webview
	 * 后，模板字符串会把 undefined 渲染成字面量 "undefined" 字符串污染显示。
	 * 这里统一做一次 type-coercion，保证下游永远拿到 string。
	 */
	private _convertToStreamDelta(delta: IModelDelta): IChatStreamDelta | null {
		const safeContent = (v: unknown): string => (typeof v === 'string' ? v : '');
		if (delta.type === 'text') {
			return {
				type: 'text',
				content: safeContent(delta.content),
			};
		}

		if (delta.type === 'thinking') {
			return {
				type: 'thinking',
				content: safeContent(delta.content),
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
				content: safeContent(delta.error) || safeContent(delta.content) || 'Unknown error',
			};
		}

		// ── KV Cache: Forward usage metrics ──────────────────────────────────
		if (delta.type === 'usage' && delta.usage) {
			return {
				type: 'usage',
				usage: delta.usage,
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

	/**
	 * 解析模型真实上下文窗口（token）。优先 maxInputTokens，其次 contextWindow，
	 * 取不到时回退到 _contextWindow（128000）。查询失败也回退，绝不抛出。
	 */
	private async _resolveContextWindow(provider: { listModels?: () => Promise<ReadonlyArray<{ id: string; maxInputTokens?: number; contextWindow?: number }>> }, modelId: string): Promise<number> {
		try {
			const models = await provider.listModels?.();
			const info = models?.find(m => m.id === modelId);
			const win = info?.maxInputTokens ?? info?.contextWindow;
			if (typeof win === 'number' && win > 0) {
				return win;
			}
		} catch (err) {
			this._logService.warn(`[ExecutionProvider] _resolveContextWindow failed for ${modelId}, falling back to ${this._contextWindow}: ${err}`);
		}
		return this._contextWindow;
	}

	/**
	 * 粗略估算消息输入 token（char/4，与 ContextManager._estimateTokens 口径一致：
	 * 序列化整条消息以涵盖 content/contentParts/thinking/tool_result 等所有字段，
	 * 图片 base64 剥离后按 1500/张平摊）。
	 * 用于压缩后回传 context_compacted 让圆环基线同步回落。
	 */
	private _estimateMessagesTokens(messages: ReadonlyArray<any>): number {
		const IMAGE_TOKEN_COST = 1500;
		let totalChars = 0;
		let imageTokens = 0;
		for (const m of messages) {
			if (!m) { continue; }
			const shadow: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
				if (k === 'contentParts' && Array.isArray(v)) {
					shadow[k] = v.map((p: any) => (p && p.type === 'image' ? { type: 'image', data: '[stripped]' } : p));
					imageTokens += v.filter((p: any) => p && p.type === 'image').length * IMAGE_TOKEN_COST;
				} else {
					shadow[k] = v;
				}
			}
			try {
				totalChars += JSON.stringify(shadow).length;
			} catch {
				totalChars += (typeof m.content === 'string' ? m.content.length : 0);
			}
		}
		return Math.ceil(totalChars / 4) + imageTokens;
	}
}
