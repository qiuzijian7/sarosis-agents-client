/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IAgentOSService } from '../common/agentOS.js';
import {
	IModelProvider, IModelSelection, ModelAuthStatus,
	IMemoryProvider, IToolProvider, IPlanningProvider,
	IExecutionProvider, IRetrievalProvider, IKanbanProvider,
	IAgentTurnRequest, IChatStreamDelta, ISlotRegistry,
	IToolDefinition, IToolCallInfo, IToolResult, IModelOptions,
	IToolApprovalHandler,
} from '../common/providers.js';
import { SlotRegistry } from './slotRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	repairToolName,
	repairToolArguments,
	coerceToolArgs,
	sanitizeToolError,
	deduplicateToolCalls,
	limitToolResultSize,
	safeStringifyToolResult,
	formatToolErrorResult,
	formatToolNotFoundResult,
	classifyArgumentValidity,
	buildValidToolNameSet,
	buildToolSchemaMap,
	MAX_INVALID_TOOL_RETRIES,
	MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES,
	shouldParallelizeToolBatch,
	StreamingToolCallAssembler,
	PHANTOM_TOOL_NAMES,
} from './toolCallUtils.js';
import {
	sanitizeAssistantVisibleText,
	sanitizeToolResultText,
	isEntirelyToolCallContent,
} from '../common/assistantVisibleText.js';
import {
	executeWithTimeout,
	getTimeoutForTool,
	ToolApprovalService,
	ToolExecutionTracker,
} from './toolExecutionGuard.js';
import {
	SurroundingsRemover,
	endsWithAnyPrefixOf,
	trimBeforeAndAfterNewLines,
} from '../common/toolExtractionUtils.js';

// ─── Agent OS Service Implementation ────────────────────────────────────

export class AgentOSService extends Disposable implements IAgentOSService {

	declare readonly _serviceBrand: undefined;

	private readonly _slotRegistry: SlotRegistry;
	private readonly _modelProviders: IModelProvider[] = [];
	private _activeSelection: IModelSelection | undefined;
	private readonly _logService: ILogService;

	// ─── Tool Execution Guard (P0 优化) ───────────────────────
	private readonly _approvalService = new ToolApprovalService();
	private readonly _executionTracker = new ToolExecutionTracker();

	/** Agent Loop 级别的 AbortController — 用于取消整个循环 */
	private _loopAbortController: AbortController | undefined;

	// Events
	private readonly _onDidChangeModelProviders = this._register(new Emitter<void>());
	readonly onDidChangeModelProviders = this._onDidChangeModelProviders.event;

	private readonly _onDidChangeAvailableModels = this._register(new Emitter<void>());
	readonly onDidChangeAvailableModels = this._onDidChangeAvailableModels.event;

	constructor(
		@ILogService logService: ILogService,
	) {
		super();
		this._logService = logService;
		this._slotRegistry = this._register(new SlotRegistry(logService));

		// Bridge the OS-level ModelProvider list and active selection
		// into the SlotRegistry so that ExecutionProviders can access them
		// via slots.getActiveModelProvider() / slots.getActiveModelSelection()
		this._slotRegistry.setModelProviderBridge({
			getModelProviders: () => this._modelProviders,
			getActiveModelSelection: () => this._activeSelection,
		});
	}

	// ─── Tool Execution Guard API (P0) ────────────────────────────────

	/**
	 * 注册工具审批 UI Handler。
	 * 由 WebView 或 Chat UI 层调用，提供用户确认能力。
	 */
	setToolApprovalHandler(handler: IToolApprovalHandler): void {
		this._approvalService.setApprovalHandler(handler);
		this._logService.info('[AgentOS] Tool approval handler registered');
	}

	/**
	 * 取消当前 Agent Loop（如果正在执行）。
	 * 所有活跃的工具执行将被 abort。
	 */
	cancelAgentLoop(): void {
		if (this._loopAbortController) {
			this._logService.info('[AgentOS] Cancelling agent loop');
			this._loopAbortController.abort();
			this._executionTracker.cancelAll();
		}
	}

	/**
	 * 获取当前活跃的工具执行信息（供 UI 展示）
	 */
	getActiveToolExecutions(): ReadonlyArray<{ toolCallId: string; toolName: string; elapsedMs: number }> {
		return this._executionTracker.getActiveExecutions();
	}

	// ─── 能力槽注册 ─────────────────────────────────────────────────

	registerModelProvider(provider: IModelProvider): IDisposable {
		this._modelProviders.push(provider);
		this._onDidChangeModelProviders.fire();
		this._onDidChangeAvailableModels.fire();

		// 监听 Provider 自身状态变化
		this._register(provider.onDidChangeModels?.(() => {
			this._onDidChangeAvailableModels.fire();
		}));
		this._register(provider.onDidChangeAuthStatus?.(() => {
			this._onDidChangeAvailableModels.fire();
		}));

		this._logService.info(`[AgentOS] Registered ModelProvider: ${provider.id}`);

		// 如果没有活跃选择，自动选择第一个已认证的 Provider
		if (!this._activeSelection && provider.getAuthStatus?.() === ModelAuthStatus.Authenticated) {
			this._autoSelectDefault();
		}

		return {
			dispose: () => {
				const idx = this._modelProviders.indexOf(provider);
				if (idx !== -1) {
					this._modelProviders.splice(idx, 1);
					this._onDidChangeModelProviders.fire();
					this._onDidChangeAvailableModels.fire();
					this._logService.info(`[AgentOS] Unregistered ModelProvider: ${provider.id}`);
				}
			},
		};
	}

	registerMemoryProvider(provider: IMemoryProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerMemoryProvider(provider, priority);
	}

	registerToolProvider(provider: IToolProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerToolProvider(provider, priority);
	}

	registerPlanningProvider(provider: IPlanningProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerPlanningProvider(provider, priority);
	}

	registerExecutionProvider(provider: IExecutionProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerExecutionProvider(provider, priority);
	}

	registerRetrievalProvider(provider: IRetrievalProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerRetrievalProvider(provider, priority);
	}

	registerKanbanProvider(provider: IKanbanProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerKanbanProvider(provider, priority);
	}

	// ─── Model Provider 管理 ─────────────────────────────────────────

	getModelProviders(): IModelProvider[] {
		return [...this._modelProviders];
	}

	getActiveModelSelection(): IModelSelection {
		if (!this._activeSelection && this._modelProviders.length > 0) {
			this._autoSelectDefault();
		}
		return this._activeSelection!;
	}

	setActiveModelSelection(selection: IModelSelection): void {
		this._activeSelection = selection;
		this._logService.info(`[AgentOS] Active model selection: ${selection.providerId}/${selection.modelId}`);
	}

	private _autoSelectDefault(): void {
		// 优先级：已认证 > priority 高 > 第一个
		const authenticated = this._modelProviders.filter(
			p => p.getAuthStatus?.() === ModelAuthStatus.Authenticated,
		);
		if (authenticated.length > 0) {
			const selected = authenticated.sort((a, b) => b.priority - a.priority)[0];
			selected.listModels?.().then(models => {
				if (models && models.length > 0) {
					// ── Guard: do NOT overwrite an explicit selection ──
					// The async .then() can resolve after the webview has
					// already synced an employee-level selection (e.g. Knot)
					// via providers.select → setActiveModelSelection().
					// Blindly overwriting here would snap the selection back
					// to a different provider (e.g. OpenRouter).
					if (this._activeSelection) {
						this._logService.info(
							`[AgentOS] _autoSelectDefault: skipping — explicit selection already set `
							+ `(${this._activeSelection.providerId}/${this._activeSelection.modelId})`,
						);
						return;
					}
					this._activeSelection = {
						providerId: selected.id,
						modelId: models[0].id,
					};
					this._logService.info(
						`[AgentOS] _autoSelectDefault: auto-selected ${selected.id}/${models[0].id}`,
					);
				}
			});
		}
	}

	// ─── 其他能力查询 ─────────────────────────────────────────────

	getActiveMemoryProvider(): IMemoryProvider | undefined {
		return this._slotRegistry.getActiveMemoryProvider();
	}

	getActiveToolProvider(): IToolProvider | undefined {
		return this._slotRegistry.getActiveToolProvider();
	}

	getActivePlanningProvider(): IPlanningProvider | undefined {
		return this._slotRegistry.getActivePlanningProvider();
	}

	getActiveExecutionProvider(): IExecutionProvider | undefined {
		return this._slotRegistry.getActiveExecutionProvider();
	}

	getActiveRetrievalProvider(): IRetrievalProvider | undefined {
		return this._slotRegistry.getActiveRetrievalProvider();
	}

	getActiveKanbanProvider(): IKanbanProvider | undefined {
		return this._slotRegistry.getActiveKanbanProvider();
	}

	// ─── Slot Registry ────────────────────────────────────────────

	getSlotRegistry(): ISlotRegistry {
		return this._slotRegistry;
	}

	// ─── 工具启用/禁用管理 ─────────────────────────────────────

	async enableTool(agentId: string, toolName: string): Promise<void> {
		const provider = this.getActiveToolProvider();
		if (provider) {
			await provider.enableTool(agentId, toolName);
			this._logService.info(`[AgentOS] Enabled tool: ${toolName}`);
		}
	}

	async disableTool(agentId: string, toolName: string): Promise<void> {
		const provider = this.getActiveToolProvider();
		if (provider) {
			await provider.disableTool(agentId, toolName);
			this._logService.info(`[AgentOS] Disabled tool: ${toolName}`);
		}
	}

	async isToolEnabled(agentId: string, toolName: string): Promise<boolean> {
		const provider = this.getActiveToolProvider();
		if (!provider) { return true; }
		return await provider.isToolEnabled(agentId, toolName);
	}

	async getToolsEnabledState(agentId: string): Promise<Record<string, boolean>> {
		const provider = this.getActiveToolProvider();
		if (!provider) { return {}; }
		return await provider.getToolsEnabledState(agentId);
	}

	async setToolsEnabledState(agentId: string, state: Record<string, boolean>): Promise<void> {
		const provider = this.getActiveToolProvider();
		if (provider) {
			await provider.setToolsEnabledState(agentId, state);
		}
	}

	async listAllToolsWithState(agentId: string): Promise<(IToolDefinition & { enabled: boolean })[]> {
		// 获取所有已注册的 tool provider，而不仅是 active provider
		// 注意：不使用可选链，因为 getToolProviders 在 ISlotRegistry 接口中是必需方法
		let allProviders: IToolProvider[];
		try {
			allProviders = this._slotRegistry.getToolProviders();
		} catch (err) {
			this._logService.warn('[AgentOS] listAllToolsWithState: getToolProviders() failed, falling back to active provider', err);
			allProviders = this.getActiveToolProvider() ? [this.getActiveToolProvider()!] : [];
		}

		this._logService.info(`[AgentOS] listAllToolsWithState: found ${allProviders.length} tool providers`);
		for (const p of allProviders) {
			this._logService.info(`[AgentOS] listAllToolsWithState: provider ${p.id}`);
		}

		if (allProviders.length === 0) {
			this._logService.warn('[AgentOS] listAllToolsWithState: no tool providers registered!');
			return [];
		}

		const allTools: IToolDefinition[] = [];
		for (const provider of allProviders) {
			if (!provider) { continue; }
			if ('getAllToolDefinitions' in provider && typeof (provider as any).getAllToolDefinitions === 'function') {
				allTools.push(...await (provider as any).getAllToolDefinitions(agentId));
			} else {
				allTools.push(...await provider.listTools(agentId));
			}
		}

		// 去重：同名工具只保留第一个
		const seen = new Set<string>();
		const uniqueTools = allTools.filter(tool => {
			if (seen.has(tool.name)) { return false; }
			seen.add(tool.name);
			return true;
		});

		// 收集所有 provider 的启用状态
		const enabledState: Record<string, boolean> = {};
		for (const provider of allProviders) {
			if (!provider) { continue; }
			try {
				const state = await provider.getToolsEnabledState(agentId);
				Object.assign(enabledState, state);
			} catch { /* ignore */ }
		}

		return uniqueTools.map(tool => ({
			...tool,
			enabled: enabledState[tool.name] ?? true,
		}));
	}

	// ─── Fallback 配置 ─────────────────────────────────────────
	private readonly _fallbackModels: string[] = ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'];
	private readonly _maxFallbackAttempts: number = 3;

	// ─── 统一执行入口 ───────────────────────────────────────────

	/**
	 * 执行一次 Agent 对话轮次
	 *
	 * 完整实现 — 包含错误恢复和 Fallback 机制
	 *
	 * 路径选择逻辑：
	 * 1. 如果有活跃的 ModelSelection 且对应的 ModelProvider 已注册
	 *    → 优先走直通模式（直接调用选中的 ModelProvider），确保用户在 UI
	 *      中选择的 Provider/Model 生效。
	 * 2. 否则尝试 ExecutionProvider（完整 Agent Loop）。
	 * 3. 最终退化为直接 Model Provider 调用（带 Fallback）。
	 */
	async *executeAgentTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		this._logService.info(`[AgentOS] executeAgentTurn: agentId=${request.agentId}, messages=${request.messages.length}`);

		// ─── Path 1: 用户明确选择了 Model → 直通模式 ───────────────
		// 当用户在聊天框中显式选择了 Provider/Model 时，应直接使用该 Provider
		// 的 chat() 方法，而不是走 ExecutionProvider（它可能是 example stub）。
		const activeModelProvider = this._getActiveModelProvider();
		if (activeModelProvider && this._activeSelection?.modelId) {
			this._logService.info(
				`[AgentOS] Active model selection detected (${this._activeSelection.providerId}/${this._activeSelection.modelId}), `
				+ `using direct model call instead of ExecutionProvider`,
			);
			yield* this._executeWithFallbackDirectly(request);
			return;
		}

		// ─── Path 2: 使用 ExecutionProvider（完整 Agent Loop）────────
		const executionProvider = this.getActiveExecutionProvider();
		if (executionProvider) {
			this._logService.info(`[AgentOS] Using ExecutionProvider: ${executionProvider.id}`);
			try {
				yield* this._executeWithFallback(
					() => executionProvider.runAgentLoop(request, this.getSlotRegistry()),
					request,
				);
			} catch (error) {
				this._logService.error('[AgentOS] ExecutionProvider failed, trying fallback', error);
				yield {
					type: 'text',
					content: `\n[System: ExecutionProvider failed, falling back to direct mode]\n`,
				};
				yield* this._executeWithFallbackDirectly(request);
			}
			return;
		}

		// ─── Path 3: 退化模式：直接调用 Model Provider（带 Fallback）──
		yield* this._executeWithFallbackDirectly(request);
	}

	/**
	 * 带 Fallback 的直接模型调用（含工具执行循环）
	 *
	 * 实现完整的 Agent Loop：
	 *   1. 获取启用的工具列表
	 *   2. 将工具定义传递给模型
	 *   3. 收集模型返回的 tool_calls
	 *   4. 执行工具调用，将结果反馈给模型
	 *   5. 循环直到模型不再调用工具或达到最大迭代次数
	 */
	private async *_executeWithFallbackDirectly(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		const modelProvider = this._getActiveModelProvider();
		if (!modelProvider) {
			this._logService.warn('[AgentOS] No ModelProvider available');
			yield* this._fallbackToDirectChat(request);
			return;
		}

		const selection = this.getActiveModelSelection();
		this._logService.info(`[AgentOS] Using ModelProvider directly: ${modelProvider.id}, modelId=${selection?.modelId}`);

		if (!selection || !selection.modelId) {
			this._logService.error('[AgentOS] No active model selection or modelId is empty');
			yield { type: 'error', content: 'No model selected. Please select a model from the toolbar.' };
			return;
		}

		// ─── 1. 收集启用的工具 ─────────────────────────────────────
		const enabledTools = await this._getEnabledTools(request.agentId);
		this._logService.info(`[AgentOS] Direct mode: ${enabledTools.length} enabled tools for agent ${request.agentId}`);

		// ─── 2. 初始化消息历史 ─────────────────────────────────────
		let messages: any[];
		if (request.systemPrompt) {
			messages = [
				{ role: 'system', content: request.systemPrompt },
				...request.messages,
			];
			this._logService.info(`[AgentOS] Prepended systemPrompt (${request.systemPrompt.length} chars) as system message`);
		} else {
			messages = request.messages as any[];
		}

		// ─── 加载 Memory 上下文并注入 system prompt（冻结快照模式）──────
		//
		// 对齐 ExecutionProvider.runAgentLoop 的 memory 注入语义。
		// 用户反馈："L1 看起来没有收集到跟随这次对话一起下发的 memory"
		//
		// 历史 BUG：这里之前只有一行 `_logService.info('Memory provider available')`
		// 占位代码，根本没调用 loadContext，导致用户在工具栏选了模型走 Path 1 时，
		// L1/L2/L3 记忆永远不会被注入到 system prompt。
		//
		// Hermes "冻结快照"：会话开始时一次性注入，会话内不再刷新（中途新写入的
		// 记忆下次会话才生效），目的是保持 KV prefix cache 稳定。
		// 参见：doc/Memory-Strategy.md §4.2 / §五.2
		const memoryProvider = this.getActiveMemoryProvider();
		if (memoryProvider) {
			try {
				// 抽取最近一条 user 消息作为召回 query —— 让 vendor 能用真实意图
				// 做 FTS5/embedding 匹配，而不是占位字符串（详见 IMemoryProvider.loadContext 注释）
				const recallQuery = [...(request.messages as Array<{ role?: string; content?: string }>)]
					.reverse()
					.find(m => m?.role === 'user')?.content ?? '';
				const memoryContext = await memoryProvider.loadContext(request.agentId, request.sessionId || '', recallQuery);

				const memoryParts: string[] = [];

				// longTermMemories（L1/L2 召回内容）——TDB-AM 的核心记忆
				if (memoryContext.longTermMemories && memoryContext.longTermMemories.length > 0) {
					const ltContents = memoryContext.longTermMemories
						.map(m => m.content)
						.filter(Boolean)
						.join('\n\n');
					if (ltContents.trim().length > 0) {
						memoryParts.push(`## Long-term Memory (TDB-AM Recall)\n\n${ltContents}`);
					}
				}

				// shortTermMemories（最近几轮摘要，通常为空）
				if (memoryContext.shortTermMemories && memoryContext.shortTermMemories.length > 0) {
					const stContents = memoryContext.shortTermMemories
						.map(m => m.content)
						.filter(Boolean)
						.join('\n\n');
					if (stContents.trim().length > 0) {
						memoryParts.push(`## Short-term Memory\n\n${stContents}`);
					}
				}

				// systemPrompt（第三方 Memory Provider 直接返回的格式化字符串）
				if (memoryContext.systemPrompt && memoryContext.systemPrompt.trim().length > 0) {
					memoryParts.push(memoryContext.systemPrompt.trim());
				}

				if (memoryParts.length > 0) {
					const frozenMemoryBlock = `<memory_context>\n${memoryParts.join('\n\n')}\n</memory_context>`;
					// 注入为 system 消息（放在已有 systemPrompt 之后、用户消息之前）。
					// 找到最后一条 system 消息位置，紧随其后插入；如无任何 system
					// 消息则插入到最前面。
					let insertIdx = 0;
					for (let i = 0; i < messages.length; i++) {
						if (messages[i]?.role === 'system') {
							insertIdx = i + 1;
						} else {
							break;
						}
					}
					messages.splice(insertIdx, 0, {
						role: 'system',
						content: frozenMemoryBlock,
					});
					this._logService.info(
						`[AgentOS] Injected frozen memory snapshot (${frozenMemoryBlock.length} chars, ` +
						`L1/L2=${memoryContext.longTermMemories?.length ?? 0}, ` +
						`short=${memoryContext.shortTermMemories?.length ?? 0}, ` +
						`hasSystemPrompt=${!!memoryContext.systemPrompt}) for agent ${request.agentId}`
					);
				} else {
					this._logService.info(
						`[AgentOS] Memory provider returned empty context for agent ${request.agentId} ` +
						`(L1/L2=${memoryContext.longTermMemories?.length ?? 0}, ` +
						`short=${memoryContext.shortTermMemories?.length ?? 0})`
					);
				}
			} catch (error) {
				this._logService.error('[AgentOS] Failed to load memory context', error);
			}
		} else {
			this._logService.info(`[AgentOS] No memory provider registered — skipping memory injection`);
		}

		// ─── 3. Agent Loop（带工具执行） ─────────────────────────
		// 初始化循环级 AbortController — 用于超时和取消
		this._loopAbortController = new AbortController();
		this._approvalService.reset(); // 新会话重置审批记忆
		const MAX_TOOL_ITERATIONS = 50;
		let iteration = 0;
		let invalidToolNameCount = 0;

		while (iteration < MAX_TOOL_ITERATIONS) {
			iteration++;
			this._logService.info(`[AgentOS] Direct mode iteration ${iteration}/${MAX_TOOL_ITERATIONS}`);

			// 构建模型选项（注入工具）
			const modelOptions: IModelOptions = {
				temperature: request.options?.temperature ?? 0.7,
				maxTokens: request.options?.maxTokens ?? 4096,
				systemPrompt: request.systemPrompt,
				tools: enabledTools.length > 0 ? enabledTools : undefined,
				stop: request.options?.stop,
			};

			// 调用模型
			const context: { agentId?: string } = {};
			if (request.agentId) {
				context.agentId = request.agentId;
			}

			this._logService.info(`[AgentOS] Calling modelProvider.chat(modelId=${selection.modelId}, messages=${messages.length}, tools=${enabledTools.length})`);

			// 收集模型响应
			let assistantContent = '';
			let thinkingContent = '';
			const assistantToolCalls: IToolCallInfo[] = [];
			// Streaming tool call assembly using OpenClaw-inspired assembler
			// Provides: incremental argument buffering, size limits, partial JSON parsing
			const toolCallAssembler = new StreamingToolCallAssembler();
			// ─── Track all tool_start IDs we yield this iteration ──────────────
			// Any ID that gets a tool_start MUST eventually get a tool_end, otherwise
			// the webview's tool card will spin forever. Tool calls can be lost between
			// tool_start and tool_end via:
			//   1. Deduplication (`deduplicateToolCalls`) — duplicate name+args dropped
			//   2. Phantom filter (render_type=None && default_show=false)
			//   3. Provider not found (executed=false in _executeToolCalls)
			//   4. Any execution exception that bypasses results.push()
			// We track started IDs and emit a synthetic tool_end with success=false
			// for any ID that did not get a real tool_end before the iteration ends.
			const startedToolIds = new Set<string>();
			const endedToolIds = new Set<string>();

			try {
				const stream = modelProvider.chat(selection.modelId, messages, modelOptions, context);
				for await (const delta of stream) {
					// 收集完整的助手消息数据
					if (delta.type === 'text' && delta.content) {
						assistantContent += delta.content;
					} else if (delta.type === 'thinking' && delta.content) {
						thinkingContent += delta.content;
					} else if (delta.type === 'tool_call' && delta.toolCall) {
						const tc = delta.toolCall;
						if (tc.name) {
							// New tool call (first chunk) — finalize previous if any
							if (toolCallAssembler.isActive) {
								assistantToolCalls.push(toolCallAssembler.finalize());
							}
							toolCallAssembler.start(tc.id, tc.name, tc.arguments || '', {
								displayName: tc.displayName,
								renderType: tc.renderType,
								defaultShow: tc.defaultShow,
								serverExecuted: tc.serverExecuted,
							});
						} else {
							// Continuation chunk — append arguments with buffer size check
							const appended = toolCallAssembler.appendArgs(tc.arguments || '');
							if (!appended) {
								this._logService.warn(`[AgentOS] Tool call argument buffer overflow (>${MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES} bytes), finalizing early`);
								assistantToolCalls.push(toolCallAssembler.finalize());
							}
						}
					}

					// 将 delta 适配并 yield 给调用者
					const adapted = this._adaptModelDelta(delta);
					if (adapted) {
						// Track tool_start IDs for end-of-iteration reconciliation
						if ((adapted as any).type === 'tool_start' && (adapted as any).toolCallId) {
							startedToolIds.add((adapted as any).toolCallId);
						}
						yield adapted;
					}
				}
			} catch (error) {
				this._logService.error(`[AgentOS] Model call failed on iteration ${iteration}:`, error);
				// 如果是第一次迭代失败，尝试 fallback
				if (iteration === 1) {
					yield { type: 'error', content: `Model call failed: ${error instanceof Error ? error.message : String(error)}` };
				}
				// Reconcile any tool_start that was emitted during streaming before
				// the model call failed — webview must not be left with spinners.
				for (const orphanId of startedToolIds) {
					if (!endedToolIds.has(orphanId)) {
						this._logService.warn(`[AgentOS] Orphaned tool_start after model error: ${orphanId} — emitting synthetic tool_end`);
						yield { type: 'tool_end', toolCallId: orphanId, success: false };
						endedToolIds.add(orphanId);
					}
				}
				break;
			}

			// Finalize the last pending tool call from streaming assembly
			if (toolCallAssembler.isActive) {
				assistantToolCalls.push(toolCallAssembler.finalize());
			}

			this._logService.info(`[AgentOS] Model response: textLen=${assistantContent.length}, toolCalls=${assistantToolCalls.length}`);
			if (assistantContent.length === 0 && assistantToolCalls.length === 0) {
				this._logService.warn(`[AgentOS] Model returned empty response — no text and no tool calls. The model may not support tool calling or the prompt was too large.`);
			}

			// ─── 检查是否需要执行工具（含文本解析兜底）──────────────────
			let effectiveToolCalls = assistantToolCalls;
			if (effectiveToolCalls.length === 0 && assistantContent) {
				// 尝试从纯文本中解析工具调用（兼容不严格遵循 OpenAI 格式的模型）
				// 传入 enabledTools 以支持从纯参数 JSON 推断工具名
				const extracted = this._tryExtractToolCallsFromText(assistantContent, thinkingContent, enabledTools);
				if (extracted.length > 0) {
					this._logService.info(`[AgentOS] Extracted ${extracted.length} tool calls from text output`);
					effectiveToolCalls = extracted;

					// ── Clean assistantContent using the unified sanitizer pipeline
					// (OpenClaw-style multi-stage strip: JSON objects, code blocks, XML, brackets, etc.)
					if (isEntirelyToolCallContent(assistantContent)) {
						assistantContent = '';
						this._logService.info(`[AgentOS] Cleared assistantContent (was entirely tool-call content)`);
					} else {
						const cleaned = sanitizeAssistantVisibleText(assistantContent, 'streaming');
						assistantContent = cleaned.length < 5 ? '' : cleaned;
						this._logService.info(`[AgentOS] Sanitized assistantContent, remaining: ${assistantContent.length} chars`);
					}

					// Notify downstream (agentChatService + webview) to replace accumulated text
					// content with the cleaned version. This prevents the UI from showing
					// the raw JSON that was already extracted into tool cards.
					yield { type: 'content_replace', content: assistantContent };

					// 向 UI 发送 tool_start 事件（前端需要 tool_start 才能渲染工具卡片）
					for (const tc of extracted) {
						startedToolIds.add(tc.id);
						yield {
							type: 'tool_start',
							toolCallId: tc.id,
							toolName: tc.name,
							displayName: tc.displayName,
							renderType: tc.renderType,
							defaultShow: tc.defaultShow,
						};
					}
				}
			}

			// Deduplicate tool calls
			effectiveToolCalls = deduplicateToolCalls(effectiveToolCalls);
			if (effectiveToolCalls.length < assistantToolCalls.length) {
				this._logService.info(`[AgentOS] Deduplicated: ${assistantToolCalls.length} → ${effectiveToolCalls.length}`);
			}

			// ─── Filter out phantom tool calls (render_type="None", default_show=false) ─────
			// These are UI indicator tools (e.g., "task_planning" showing "任务规划中")
			// that should NOT be executed as real tools. Executing them causes confusing
			// "not yet implemented" errors that derail the conversation.
			//
			// 双重判定（缺一不可的兜底）：
			//   A) 元数据明示：renderType==="None" && defaultShow===false
			//      —— Knot server 在 _meta 里正确标注时走这条
			//   B) 名称白名单：PHANTOM_TOOL_NAMES.has(name)
			//      —— Knot server 漏发 _meta 字段时的兜底（实测会发生，
			//         否则就会进入 repairToolName 失败 → tool not found
			//         → 模型生成一大段"我尝试调用了不存在的工具"道歉的循环）
			const realToolCalls = effectiveToolCalls.filter(tc => {
				const isPhantomByMeta = tc.renderType === 'None' && tc.defaultShow === false;
				const isPhantomByName = PHANTOM_TOOL_NAMES.has(tc.name);
				const isPhantom = isPhantomByMeta || isPhantomByName;
				if (isPhantom) {
					const reason = isPhantomByMeta ? 'meta(render_type=None,default_show=false)' : 'name-whitelist';
					this._logService.info(`[AgentOS] Skipping phantom tool call: ${tc.name} (${reason})`);
				}
				return !isPhantom;
			});
			if (realToolCalls.length < effectiveToolCalls.length) {
				this._logService.info(`[AgentOS] Filtered phantom tool calls: ${effectiveToolCalls.length} → ${realToolCalls.length}`);
				effectiveToolCalls = realToolCalls;
			}

			// 将助手消息添加到消息历史
			if (assistantContent || effectiveToolCalls.length > 0) {
				const assistantMessage: any = {
					role: 'assistant',
					content: assistantContent,
				};
				if (effectiveToolCalls.length > 0) {
					assistantMessage.toolCalls = effectiveToolCalls;
				}
				messages.push(assistantMessage);
			}

			if (effectiveToolCalls.length === 0) {
				// 没有工具调用，对话结束
				this._logService.info('[AgentOS] No tool calls, ending conversation');
				// Reconcile orphaned tool_starts before ending (e.g., phantom tools
				// that were filtered out had a tool_start but no execution path).
				for (const orphanId of startedToolIds) {
					if (!endedToolIds.has(orphanId)) {
						this._logService.warn(`[AgentOS] Orphaned tool_start at end-of-conversation: ${orphanId} — emitting synthetic tool_end`);
						yield { type: 'tool_end', toolCallId: orphanId, success: false };
						endedToolIds.add(orphanId);
					}
				}
				yield { type: 'done' };
				break;
			}

			// ─── 执行工具调用 ─────────────────────────────────────
			// Wrap in try/catch so any provider/internal exception cannot break the
			// generator before we have a chance to yield tool_end + done.
			//
			// CRITICAL FIX (用户反馈："工具一直在转圈，明明已经完成任务了还在执行"):
			// We previously did `await Promise.all(...)` then yielded tool_end for each
			// tool. This means a fast tool (file_read, 60ms) would have its tool_end
			// blocked for 60+ seconds waiting for a slow sibling (search_files timing
			// out at 60s). The UI saw all spinners spinning for the whole duration of
			// the slowest tool — the user's exact complaint.
			//
			// Fix: stream results as each individual tool finishes, so each tool_end
			// flushes to the UI at its real completion time. We collect into
			// `toolResults` for the message history while streaming.
			const canParallel = shouldParallelizeToolBatch(effectiveToolCalls);
			const toolResults: Array<{ toolCallId: string; content: any; success: boolean }> = [];
			try {
				if (canParallel) {
					// Streaming parallel: yield as each tool finishes, in completion order.
					for await (const toolResult of this._executeToolCallsParallelStreaming(effectiveToolCalls, request.agentId)) {
						toolResults.push(toolResult);
						// Emit tool_result + tool_end for THIS tool immediately (do not
						// wait for the rest of the batch).
						const resultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(toolResult.content)));
						messages.push({
							role: 'tool',
							content: resultStr,
							toolCallId: toolResult.toolCallId,
						});
						yield {
							type: 'tool_result',
							content: resultStr,
							toolCallId: toolResult.toolCallId,
						};
						yield {
							type: 'tool_end',
							toolCallId: toolResult.toolCallId,
							success: toolResult.success,
						};
						endedToolIds.add(toolResult.toolCallId);
					}
				} else {
					// Serial path: keep old behavior (each tool naturally finishes
					// sequentially so head-of-line blocking is not an issue here).
					const serial = await this._executeToolCalls(effectiveToolCalls, request.agentId);
					for (const toolResult of serial) {
						toolResults.push(toolResult);
						const resultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(toolResult.content)));
						messages.push({
							role: 'tool',
							content: resultStr,
							toolCallId: toolResult.toolCallId,
						});
						yield {
							type: 'tool_result',
							content: resultStr,
							toolCallId: toolResult.toolCallId,
						};
						yield {
							type: 'tool_end',
							toolCallId: toolResult.toolCallId,
							success: toolResult.success,
						};
						endedToolIds.add(toolResult.toolCallId);
					}
				}
			} catch (execErr) {
				this._logService.error(`[AgentOS] Tool execution batch threw unexpectedly:`, execErr);
				// Synthesize failed results for every tool that did NOT yet emit tool_end.
				// This guarantees every started tool_call is terminated on the wire.
				for (const tc of effectiveToolCalls) {
					if (endedToolIds.has(tc.id)) { continue; }
					const errResult = {
						toolCallId: tc.id,
						content: { error: `Tool execution failed: ${execErr instanceof Error ? execErr.message : String(execErr)}` },
						success: false,
					};
					toolResults.push(errResult);
					const resultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(errResult.content)));
					messages.push({
						role: 'tool',
						content: resultStr,
						toolCallId: tc.id,
					});
					yield { type: 'tool_result', content: resultStr, toolCallId: tc.id };
					yield { type: 'tool_end', toolCallId: tc.id, success: false };
					endedToolIds.add(tc.id);
				}
			}

			// ─── Reconcile: emit synthetic tool_end for any orphaned tool_start ──
			// IDs that received tool_start but never tool_end (lost via dedup,
			// phantom filter, missing provider, or any other early-return path)
			// must be terminated, otherwise their webview tool cards will spin
			// forever. We emit success=false so users can see they did not run.
			for (const orphanId of startedToolIds) {
				if (!endedToolIds.has(orphanId)) {
					this._logService.warn(`[AgentOS] Orphaned tool_start without tool_end: ${orphanId} — emitting synthetic tool_end (success=false)`);
					yield {
						type: 'tool_end',
						toolCallId: orphanId,
						success: false,
					};
					endedToolIds.add(orphanId);
				}
			}

			// ─── Guardrail: too many failed tool calls → break ──────
			const failedCount = toolResults.filter(r => !r.success).length;
			if (failedCount === toolResults.length && toolResults.length > 0) {
				// All tools failed — check if they are "tool not found" errors
				const allNotFound = toolResults.every(r => {
					const content = JSON.stringify(r.content);
					return content.includes('does not exist') || content.includes('not available');
				});
				if (allNotFound) {
					invalidToolNameCount++;
					if (invalidToolNameCount >= MAX_INVALID_TOOL_RETRIES) {
						this._logService.warn(`[AgentOS] Too many invalid tool name attempts (${invalidToolNameCount}), ending loop`);
						yield { type: 'done' };
						break;
					}
				}
			}
		}

		if (iteration >= MAX_TOOL_ITERATIONS) {
			this._logService.warn(`[AgentOS] Reached max tool iterations (${MAX_TOOL_ITERATIONS})`);
			yield { type: 'done' };
		}
	}

	/**
	 * 获取指定 agent 的已启用工具列表
	 */
	private async _getEnabledTools(agentId: string): Promise<IToolDefinition[]> {
		const allToolsWithState = await this.listAllToolsWithState(agentId);
		const enabled = allToolsWithState.filter(t => t.enabled);
		this._logService.info(`[AgentOS] _getEnabledTools: ${enabled.length}/${allToolsWithState.length} tools enabled for agent ${agentId}`);
		return enabled.map(({ enabled: _, ...toolDef }) => toolDef);
	}

	/**
	 * 执行一组工具调用
	 *
	 * Enhanced with:
	 *  - Multi-level tool name repair (Hermes-Agent patterns)
	 *  - Argument coercion & repair
	 *  - Error sanitization
	 *  - Result size limiting
	 *  - **[P0] Timeout protection** (AbortController + configurable timeout per tool)
	 *  - **[P0] Approval flow** (securityLevel-based user confirmation)
	 *  - **[P1] Execution metadata** (timing, truncation, timeout info)
	 */
	private async _executeToolCalls(toolCalls: IToolCallInfo[], agentId: string): Promise<Array<{ toolCallId: string; content: any; success: boolean }>> {
		const results: Array<{ toolCallId: string; content: any; success: boolean }> = [];

		// Pre-collect all available tools and build lookup structures
		const allAvailableTools: IToolDefinition[] = [];
		for (const provider of this._slotRegistry.getToolProviders()) {
			try {
				const tools = await provider.listTools(agentId);
				allAvailableTools.push(...tools);
			} catch { /* ignore */ }
		}
		const availableToolNames = allAvailableTools.map(t => t.name);
		const validNameSet = buildValidToolNameSet(allAvailableTools);
		const schemaMap = buildToolSchemaMap(allAvailableTools);
		// Build a name → definition map for approval checks
		const toolDefMap = new Map<string, IToolDefinition>();
		for (const t of allAvailableTools) { toolDefMap.set(t.name, t); }

		// Deduplicate tool calls before execution
		const uniqueCalls = deduplicateToolCalls(toolCalls);
		if (uniqueCalls.length < toolCalls.length) {
			this._logService.info(`[AgentOS] Deduplicated tool calls: ${toolCalls.length} → ${uniqueCalls.length}`);
		}

		for (const toolCall of uniqueCalls) {
			this._logService.info(`[AgentOS] Executing tool: ${toolCall.name}, callId=${toolCall.id}`);

			// ─── Step 0: Phantom (UI-indicator) tool short-circuit ───
			// Knot 服务端会下发 `task_planning` / `planning` 等纯 UI 指示器
			// （render_type="none"，仅用于显示"任务规划中"），它们不应进入
			// 真实执行路径。如果不短路，repairToolName 会找不到，进而返回
			// formatToolNotFoundResult — 一大段 "available tools" 列表喂回模型，
			// 模型又会就这条错误生成一段冗长的"我尝试调用了不存在的工具"道歉，
			// 形成视觉噪声循环。这里直接返回一个静默的成功占位即可。
			if (PHANTOM_TOOL_NAMES.has(toolCall.name)) {
				this._logService.info(`[AgentOS] Phantom tool "${toolCall.name}" silently acknowledged (UI indicator only)`);
				results.push({
					toolCallId: toolCall.id,
					content: { ok: true, phantom: true },
					success: true,
				});
				continue;
			}

			// ─── Step 1: Tool name repair ─────────────────────────
			let targetToolName = toolCall.name;
			if (!validNameSet.has(targetToolName)) {
				const repaired = repairToolName(targetToolName, availableToolNames);
				if (repaired) {
					this._logService.warn(`[AgentOS] Repaired tool name "${targetToolName}" → "${repaired}"`);
					targetToolName = repaired;
				} else {
					// Tool not found — return error with available tool names
					this._logService.warn(`[AgentOS] Tool "${toolCall.name}" not found and not repairable`);
					results.push({
						toolCallId: toolCall.id,
						content: formatToolNotFoundResult(toolCall.name, repaired, availableToolNames),
						success: false,
					});
					continue;
				}
			}

			// ─── Step 2: Argument parsing & repair ─────────────────
			const argValidity = classifyArgumentValidity(toolCall.arguments || '');
			let args: Record<string, unknown>;

			if (argValidity === 'valid') {
				args = JSON.parse(toolCall.arguments!);
			} else if (argValidity === 'empty') {
				args = {};
			} else if (argValidity === 'truncated') {
				// Truncated arguments are not recoverable — return error
				this._logService.warn(`[AgentOS] Tool arguments appear truncated: ${toolCall.arguments?.substring(0, 100)}`);
				results.push({
					toolCallId: toolCall.id,
					content: { error: `Arguments for tool "${targetToolName}" appear to be truncated. Please retry with complete arguments.` },
					success: false,
				});
				continue;
			} else if (argValidity === 'repairable') {
				const repairedArgs = repairToolArguments(toolCall.arguments || '');
				if (repairedArgs) {
					this._logService.info(`[AgentOS] Repaired tool arguments for "${targetToolName}"`);
					args = repairedArgs;
				} else {
					args = {};
				}
			} else {
				// Invalid — try repair as last resort
				const repairedArgs = repairToolArguments(toolCall.arguments || '');
				if (repairedArgs) {
					this._logService.info(`[AgentOS] Repaired invalid tool arguments for "${targetToolName}"`);
					args = repairedArgs;
				} else {
					this._logService.warn(`[AgentOS] Failed to parse tool arguments: ${toolCall.arguments?.substring(0, 200)}`);
					results.push({
						toolCallId: toolCall.id,
						content: { error: `Invalid arguments for tool "${targetToolName}". Please provide valid JSON arguments.` },
						success: false,
					});
					continue;
				}
			}

			// ─── Step 3: Argument coercion ─────────────────────────
			const toolSchema = schemaMap.get(targetToolName);
			if (toolSchema) {
				args = coerceToolArgs(args, toolSchema);
			}

			// ─── Step 3.5: Approval check (P0 - 审批机制) ─────────
			const toolDef = toolDefMap.get(targetToolName);
			const approved = await this._approvalService.checkAndApprove(
				{ id: toolCall.id, name: targetToolName, arguments: args },
				toolDef,
			);
			if (!approved) {
				this._logService.info(`[AgentOS] Tool "${targetToolName}" execution denied by user`);
				results.push({
					toolCallId: toolCall.id,
					content: { error: `Tool "${targetToolName}" execution was denied by the user. Try a different approach or ask the user for permission.` },
					success: false,
				});
				continue;
			}

			// ─── Step 4: Execute tool via provider (with timeout) ──
			let executed = false;
			const toolProviders = this._slotRegistry.getToolProviders();
			const timeoutMs = getTimeoutForTool(targetToolName, toolDef, toolDef?.source);

			for (const provider of toolProviders) {
				try {
					const tools = await provider.listTools(agentId);
					if (tools.some(t => t.name === targetToolName)) {
						// 使用带超时保护的执行
						const result: IToolResult = await executeWithTimeout(
							provider,
							agentId,
							{ id: toolCall.id, name: targetToolName, arguments: args },
							timeoutMs,
							this._loopAbortController?.signal,
						);

						// Track execution
						this._executionTracker.complete(toolCall.id);

						// Limit result size — use safeStringifyToolResult to guard
						// against pathological tool payloads (50MB+) that would OOM the
						// renderer if passed to JSON.stringify directly.
						const limitedStr = safeStringifyToolResult(result.content);
						// `wasTruncated` is true whenever safeStringifyToolResult had to
						// shrink either the object (deep-truncate) or the final string.
						// In that case we re-parse so downstream sees a structured object
						// (matching the original content shape) rather than a string blob.
						let finalContent: unknown = result.content;
						try {
							finalContent = JSON.parse(limitedStr);
						} catch {
							// limitedStr ended in a truncation marker that broke JSON parsing;
							// fall back to a wrapper object so downstream still has structure.
							finalContent = { __truncated__: true, content: limitedStr };
						}

						results.push({
							toolCallId: toolCall.id,
							content: finalContent,
							success: result.success,
						});
						executed = true;

						if (result.metadata?.timedOut) {
							this._logService.warn(`[AgentOS] Tool ${targetToolName} timed out after ${timeoutMs}ms`);
						} else if (result.success) {
							this._logService.info(`[AgentOS] Tool ${targetToolName} executed successfully via ${provider.id} (${result.metadata?.executionTimeMs ?? '?'}ms)`);
						} else {
							const errorMsg = result.error ?? 'unknown error';
							this._logService.warn(`[AgentOS] Tool ${targetToolName} returned error via ${provider.id}: ${errorMsg}`);
						}
						break;
					}
				} catch (error) {
					const sanitizedError = sanitizeToolError(error);
					this._logService.warn(`[AgentOS] Tool ${targetToolName} execution failed via ${provider.id}: ${sanitizedError}`);
					// If a provider fails, try the next one
					continue;
				}
			}

			if (!executed) {
				this._logService.warn(`[AgentOS] No provider could execute tool: ${targetToolName}`);
				results.push({
					toolCallId: toolCall.id,
					content: formatToolErrorResult(targetToolName, 'No provider available for this tool', availableToolNames),
					success: false,
				});
			}
		}

		return results;
	}

	/**
	 * Execute tool calls in parallel using Promise.allSettled.
	 * Borrowed from Hermes-Agent's concurrent tool execution pattern.
	 *
	 * - Validates each call independently (name repair, arg repair, coercion)
	 * - Executes all valid calls concurrently (up to MAX_TOOL_WORKERS)
	 * - Preserves original order in results
	 */
	/**
	 * Streaming parallel tool execution.
	 *
	 * Yields each tool result **as soon as that individual tool finishes**,
	 * in completion order (NOT input order). This is the critical fix for
	 * "工具一直在转圈" — previously we awaited Promise.all then yielded all
	 * results in input order, which meant a 60s slow tool blocked tool_end
	 * for every fast sibling in the same batch.
	 *
	 * Skipped entries (validation failures) are yielded synchronously up
	 * front so the UI can mark them done immediately.
	 */
	private async *_executeToolCallsParallelStreaming(toolCalls: IToolCallInfo[], agentId: string): AsyncGenerator<{ toolCallId: string; content: any; success: boolean }, void, unknown> {
		// Pre-collect all available tools and build lookup structures
		const allAvailableTools: IToolDefinition[] = [];
		for (const provider of this._slotRegistry.getToolProviders()) {
			try {
				const tools = await provider.listTools(agentId);
				allAvailableTools.push(...tools);
			} catch { /* ignore */ }
		}
		const availableToolNames = allAvailableTools.map(t => t.name);
		const validNameSet = buildValidToolNameSet(allAvailableTools);
		const schemaMap = buildToolSchemaMap(allAvailableTools);

		// Deduplicate
		const uniqueCalls = deduplicateToolCalls(toolCalls);
		if (uniqueCalls.length < toolCalls.length) {
			this._logService.info(`[AgentOS] [parallel] Deduplicated tool calls: ${toolCalls.length} → ${uniqueCalls.length}`);
		}

		// Prepare each tool call: validate, repair, build execution function
		const executionEntries: Array<{
			originalIndex: number;
			toolCall: IToolCallInfo;
			targetToolName: string;
			args: Record<string, unknown>;
			skip: boolean;
			skipResult?: { toolCallId: string; content: any; success: boolean };
		}> = [];

		for (let i = 0; i < uniqueCalls.length; i++) {
			const toolCall = uniqueCalls[i];

			// Phantom (UI-indicator) tool short-circuit — 见串行路径同名注释。
			if (PHANTOM_TOOL_NAMES.has(toolCall.name)) {
				this._logService.info(`[AgentOS] [parallel] Phantom tool "${toolCall.name}" silently acknowledged (UI indicator only)`);
				executionEntries.push({
					originalIndex: i,
					toolCall,
					targetToolName: toolCall.name,
					args: {},
					skip: true,
					skipResult: {
						toolCallId: toolCall.id,
						content: { ok: true, phantom: true },
						success: true,
					},
				});
				continue;
			}

			// Tool name repair
			let targetToolName = toolCall.name;
			if (!validNameSet.has(targetToolName)) {
				const repaired = repairToolName(targetToolName, availableToolNames);
				if (repaired) {
					this._logService.warn(`[AgentOS] [parallel] Repaired tool name "${targetToolName}" → "${repaired}"`);
					targetToolName = repaired;
				} else {
					executionEntries.push({
						originalIndex: i,
						toolCall,
						targetToolName,
						args: {},
						skip: true,
						skipResult: {
							toolCallId: toolCall.id,
							content: formatToolNotFoundResult(toolCall.name, repaired, availableToolNames),
							success: false,
						},
					});
					continue;
				}
			}

			// Argument parsing & repair
			const argValidity = classifyArgumentValidity(toolCall.arguments || '');
			let args: Record<string, unknown>;

			if (argValidity === 'valid') {
				args = JSON.parse(toolCall.arguments!);
			} else if (argValidity === 'empty') {
				args = {};
			} else if (argValidity === 'truncated') {
				executionEntries.push({
					originalIndex: i,
					toolCall,
					targetToolName,
					args: {},
					skip: true,
					skipResult: {
						toolCallId: toolCall.id,
						content: { error: `Arguments for tool "${targetToolName}" appear to be truncated. Please retry with complete arguments.` },
						success: false,
					},
				});
				continue;
			} else {
				const repairedArgs = repairToolArguments(toolCall.arguments || '');
				if (repairedArgs) {
					args = repairedArgs;
				} else {
					executionEntries.push({
						originalIndex: i,
						toolCall,
						targetToolName,
						args: {},
						skip: true,
						skipResult: {
							toolCallId: toolCall.id,
							content: { error: `Invalid arguments for tool "${targetToolName}". Please provide valid JSON arguments.` },
							success: false,
						},
					});
					continue;
				}
			}

			// Argument coercion
			const toolSchema = schemaMap.get(targetToolName);
			if (toolSchema) {
				args = coerceToolArgs(args, toolSchema);
			}

			executionEntries.push({
				originalIndex: i,
				toolCall,
				targetToolName,
				args,
				skip: false,
			});
		}

		// Execute all non-skipped calls in parallel (with timeout + approval)
		const entriesToExecute = executionEntries.filter(e => !e.skip);
		this._logService.info(`[AgentOS] [parallel] Executing ${entriesToExecute.length} tool calls concurrently (skipped ${executionEntries.length - entriesToExecute.length})`);

		// Build tool definition map for approval
		const toolDefMap = new Map<string, IToolDefinition>();
		for (const t of allAvailableTools) { toolDefMap.set(t.name, t); }

		// Build execution promises (with timeout protection)
		const toolProviders = this._slotRegistry.getToolProviders();
		const executionPromises = entriesToExecute.map(async (entry) => {
			const { toolCall, targetToolName, args } = entry;

			// Approval check
			const toolDef = toolDefMap.get(targetToolName);
			const approved = await this._approvalService.checkAndApprove(
				{ id: toolCall.id, name: targetToolName, arguments: args },
				toolDef,
			);
			if (!approved) {
				this._logService.info(`[AgentOS] [parallel] Tool "${targetToolName}" denied by user`);
				return {
					originalIndex: entry.originalIndex,
					toolCallId: toolCall.id,
					content: { error: `Tool "${targetToolName}" execution was denied by the user.` },
					success: false,
				};
			}

			const timeoutMs = getTimeoutForTool(targetToolName, toolDef, toolDef?.source);

			for (const provider of toolProviders) {
				try {
					const tools = await provider.listTools(agentId);
					if (tools.some(t => t.name === targetToolName)) {
						// 使用带超时保护的执行
						const result: IToolResult = await executeWithTimeout(
							provider,
							agentId,
							{ id: toolCall.id, name: targetToolName, arguments: args },
							timeoutMs,
							this._loopAbortController?.signal,
						);
						// safeStringifyToolResult: guards against pathological payloads
						// (e.g. tool returning a 50MB blob) which would otherwise blow up
						// JSON.stringify and OOM the renderer. See toolCallUtils.ts.
						const limitedStr = safeStringifyToolResult(result.content);
						let finalContent: unknown = result.content;
						try {
							finalContent = JSON.parse(limitedStr);
						} catch {
							finalContent = { __truncated__: true, content: limitedStr };
						}

						if (result.success) {
							this._logService.info(`[AgentOS] [parallel] Tool ${targetToolName} executed via ${provider.id} (${result.metadata?.executionTimeMs ?? '?'}ms)`);
						} else {
							this._logService.warn(`[AgentOS] [parallel] Tool ${targetToolName} returned error via ${provider.id}: ${result.error ?? 'unknown'}`);
						}
						return {
							originalIndex: entry.originalIndex,
							toolCallId: toolCall.id,
							content: finalContent,
							success: result.success,
						};
					}
				} catch (error) {
					const sanitizedError = sanitizeToolError(error);
					this._logService.warn(`[AgentOS] [parallel] Tool ${targetToolName} execution failed via ${provider.id}: ${sanitizedError}`);
					continue;
				}
			}

			// If we get here, no provider could execute the tool
			this._logService.warn(`[AgentOS] [parallel] No provider could execute tool: ${targetToolName}`);
			return {
				originalIndex: entry.originalIndex,
				toolCallId: toolCall.id,
				content: formatToolErrorResult(targetToolName, 'No provider available for this tool', availableToolNames),
				success: false,
			};
		});

		// ── 1. Emit all SKIPPED entries up front (synchronous results) ──
		for (const entry of executionEntries) {
			if (entry.skip && entry.skipResult) {
				yield entry.skipResult;
			}
		}

		// ── 2. Race the executing promises and yield each as it completes ──
		// We can't use `for await (Promise.race)` because race only resolves the
		// fastest *every iteration*, repeatedly returning the same already-resolved
		// promise. Instead we attach an index to each promise, and as each settles
		// we remove it from the pending pool.
		type Settled = { type: 'fulfilled'; value: { originalIndex: number; toolCallId: string; content: any; success: boolean } }
			| { type: 'rejected'; reason: unknown };

		// Wrap each promise so `race` returns the index of the one that settled.
		const wrapped: Array<Promise<{ idx: number; settled: Settled }>> = executionPromises.map((p, idx) =>
			p.then(value => ({ idx, settled: { type: 'fulfilled' as const, value } }))
				.catch(reason => ({ idx, settled: { type: 'rejected' as const, reason } }))
		);

		// Pending pool: replace settled slots with a never-resolving placeholder so
		// race won't pick them again.
		const NEVER: Promise<{ idx: number; settled: Settled }> = new Promise(() => { /* never */ });
		const pool: Array<Promise<{ idx: number; settled: Settled }>> = wrapped.slice();
		let remaining = pool.length;

		while (remaining > 0) {
			const { idx, settled } = await Promise.race(pool);
			pool[idx] = NEVER;
			remaining--;

			if (settled.type === 'fulfilled' && settled.value) {
				const { toolCallId, content, success } = settled.value;
				yield { toolCallId, content, success };
			} else if (settled.type === 'rejected') {
				this._logService.error('[AgentOS] [parallel] Tool execution promise rejected:', settled.reason);
				// Even on rejection, we must produce a tool result for the
				// corresponding entry so its tool_end gets emitted upstream.
				const entry = entriesToExecute[idx];
				if (entry) {
					yield {
						toolCallId: entry.toolCall.id,
						content: { error: `Tool execution promise rejected: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}` },
						success: false,
					};
				}
			}
		}
	}

	/**
	 * 从模型纯文本输出中尝试提取工具调用（兼容非严格 function calling 的模型）
	 *
	 * 支持的文本格式（参考 OpenClaw 的 detectToolCallShapedText）：
	 *   1. JSON in code blocks: ```json { "tool_name": "...", "arguments": {...} } ```
	 *   2. Raw JSON objects: { "function": "...", "arguments": {...} }
	 *   3. XML format: <tool_call>...</tool_call> 或 <function_call>...</function_call>
	 *   4. Bracket format: [TOOL_CALL]...[/TOOL_CALL]
	 *   5. ReAct format: Action: tool_name\nAction Input: {...}
	 *   6. Thinking inference: content = args JSON, tool name from thinking
	 */
	private _tryExtractToolCallsFromText(text: string, thinkingContent?: string, enabledTools?: IToolDefinition[]): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];
		if (!text || text.length < 5) { return results; }

		this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: attempting extraction from ${text.length} chars (thinking: ${thinkingContent?.length ?? 0} chars)`);

		// 1. 尝试从 ```json 代码块中提取（支持嵌套大括号）
		const codeBlockRegex = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/g;
		let match: RegExpExecArray | null;
		while ((match = codeBlockRegex.exec(text)) !== null) {
			const blockContent = match[1].trim();
			if (!blockContent.startsWith('{')) { continue; }
			try {
				const parsed = JSON.parse(blockContent);
				const tc = this._parseSingleToolCall(parsed, enabledTools);
				if (tc) {
					this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found tool call in code block: ${tc.name}`);
					results.push(tc);
				}
			} catch { /* ignore parse error */ }
		}

		// 2. 如果没找到代码块，尝试从文本中提取 JSON 对象（支持嵌套）
		if (results.length === 0) {
			const extracted = this._extractJsonObjects(text);
			for (const jsonStr of extracted) {
				try {
					const parsed = JSON.parse(jsonStr);
					const tc = this._parseSingleToolCall(parsed, enabledTools);
					if (tc) {
						this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found tool call in raw JSON: ${tc.name}`);
						results.push(tc);
					}
				} catch { /* ignore parse error */ }
			}
		}

		// 3. XML 格式: <tool_call>...</tool_call> 或 <function_call>...</function_call>
		if (results.length === 0) {
			// Log whether XML-like tags exist in text before attempting extraction
			const hasXmlTags = /<(?:tool_call|function_call|tool_use|invoke|tool)[\s>]/i.test(text);
			this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: XML extraction attempt, hasXmlTags=${hasXmlTags}, textLen=${text.length}`);
			const xmlResults = this._extractToolCallsFromXml(text);
			if (xmlResults.length > 0) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${xmlResults.length} tool call(s) in XML format`);
				results.push(...xmlResults);
			}
		}

		// 4. Bracket 格式: [TOOL_CALL]...[/TOOL_CALL] 或 [tool_call]...[/tool_call]
		if (results.length === 0) {
			const bracketResults = this._extractToolCallsFromBrackets(text);
			if (bracketResults.length > 0) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${bracketResults.length} tool call(s) in bracket format`);
				results.push(...bracketResults);
			}
		}

		// 5. ReAct 格式: Action: tool_name\nAction Input: {...}
		if (results.length === 0) {
			const reactResults = this._extractToolCallsFromReAct(text);
			if (reactResults.length > 0) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${reactResults.length} tool call(s) in ReAct format`);
				results.push(...reactResults);
			}
		}

		// 6. Python 函数调用格式: tool_name(arg1="val1", arg2="val2")
		//    或 ```python\ntool_name(arg1="val1")\n```
		//    常见于不支持 function calling 的模型（如 qwen3.5:9b）
		if (results.length === 0) {
			const pythonResults = this._extractToolCallsFromPythonSyntax(text);
			if (pythonResults.length > 0) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${pythonResults.length} tool call(s) in Python function-call format`);
				results.push(...pythonResults);
			}
		}

		// 7. 如果仍未找到，尝试将整个 content 解析为 JSON 参数对象，
		//    并从 thinking 中提取工具名称（兼容 qwen 等模型：thinking 包含意图，content 只有参数）
		if (results.length === 0) {
			const trimmed = text.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					// 先尝试标准解析（可能有 tool/name 字段），传入 enabledTools 支持参数推断
					const tc = this._parseSingleToolCall(parsed, enabledTools);
					if (tc) {
						results.push(tc);
					} else if (thinkingContent) {
						// content 是纯参数 JSON（无 tool name），从 thinking 中提取工具名
						const toolName = this._extractToolNameFromThinking(thinkingContent);
						if (toolName) {
							this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: inferred tool '${toolName}' from thinking, args from content`);
							results.push({
								id: `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
								name: toolName,
								arguments: trimmed,
							});
						}
					}
				} catch { /* not valid JSON */ }
			}
		}

		if (results.length > 0) {
			this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: extracted ${results.length} tool call(s) from ${text.length} chars`);
		} else {
			this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: no tool calls found in text: ${text.slice(0, 200)}`);
		}
		return results;
	}

	/**
	 * 从 XML 格式提取工具调用。
	 * 支持: <tool_call>, <function_call>, <tool_use>, <invoke>
	 */
	private _extractToolCallsFromXml(text: string): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];
		const xmlTags = ['tool_call', 'function_call', 'tool_use', 'invoke', 'tool'];

		for (const tag of xmlTags) {
			// 1. 先匹配闭合标签: <tool_call>...</tool_call>
			const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				const content = match[1].trim();
				this._logService.info(`[AgentOS] _extractToolCallsFromXml: found <${tag}> tag (closed), contentLen=${content.length}, contentPreview=${content.substring(0, 120)}`);
				// <tool> 标签使用 ▷{JSON} 头部 + <document> 子标签格式
				if (tag === 'tool') {
					const parsed = this._parseToolXMLFormat(content);
					if (parsed) { results.push(parsed); }
					else { this._logService.info(`[AgentOS] _extractToolCallsFromXml: _parseToolXMLFormat returned null for <tool> tag`); }
					continue;
				}
				this._processXmlTagContent(content, results, tag);
			}

			// 2. 兜底: 匹配未闭合标签: <tool_call>toolname (后面没有 </tool_call>)
			// 只匹配当该标签在文本中确实没有被闭合时
			const hasClosingTag = new RegExp(`</${tag}>`, 'i').test(text);
			if (!hasClosingTag) {
				const unclosedRegex = new RegExp(`<${tag}[^>]*>([\\w_\\-]+)(?=\\s*(?:<|$))`, 'gi');
				let unclosedMatch: RegExpExecArray | null;
				while ((unclosedMatch = unclosedRegex.exec(text)) !== null) {
					const content = unclosedMatch[1].trim();
					this._logService.info(`[AgentOS] _extractToolCallsFromXml: found <${tag}> tag (unclosed), content="${content}"`);
					this._processXmlTagContent(content, results, tag);
				}
			}
		}
		return results;
	}

	/**
	 * 使用 SurroundingsRemover 解析 XML 内容（参考 Void 的 parseXMLPrefixToToolCall）。
	 * 尝试从 XML 格式的内容中提取工具名称和参数。
	 * 返回 { name, args } 或 null（如果无法解析）。
	 */
	private _tryParseXmlWithSurroundingsRemover(content: string): { name: string; args: string } | null {
		try {
			const pm = new SurroundingsRemover(content);

			// 尝试查找 <name>value</name> 或 <tool_name>value</tool_name> 标签
			const allowedNames = ['name', 'tool_name', 'tool', 'function'];
			let toolName: string | null = null;
			let argsStr = '{}';

			// 先尝试查找 </think> 标签（清理被污染的标签）
			const thinkEnd = pm.value().indexOf('</think>');
			if (thinkEnd !== -1) {
				// 有 </think> 标签，截断
				pm.j = thinkEnd - 1;
			}

			// 简化实现：查找第一个 <word> 标签作为工具名
			// 格式: <terminal> 或 <name>terminal</name>
			for (const n of allowedNames) {
				const found = pm.removePrefix(`<${n}>`);
				if (found) {
					toolName = n;
					// 查找 </name> 结束标记
					const endIdx = pm.value().indexOf(`</${n}>`);
					if (endIdx !== -1) {
						pm.i = endIdx + `</${n}>`.length;
					}
					break;
				}
			}

			// 如果没找到 <name> 格式，尝试属性格式 name="xxx"
			if (!toolName) {
				const attrMatch = pm.value().match(/(?:name|tool|function)\s*[:=]\s*["']?(\w+)["']?/i);
				if (attrMatch) {
					toolName = attrMatch[1];
				}
			}

			if (!toolName) {
				return null;
			}

			// 尝试提取参数（简化：返回空 args）
			// TODO: 实现完整的参数解析
			return { name: toolName, args: argsStr };
		} catch {
			return null;
		}
	}

	/**
	 * 处理 XML 标签内容（统一处理闭合和未闭合标签的 content）。
	 */
	private _processXmlTagContent(content: string, results: IToolCallInfo[], tag: string): void {
		// XML 内部可能是 JSON
		if (content.startsWith('{')) {
			try {
				const parsed = JSON.parse(content);
				const tc = this._parseSingleToolCall(parsed);
				if (tc) { results.push(tc); }
			} catch { /* ignore */ }
		} else {
			// 清理被 </think> 等标签污染的内容（取第一个有效工具名）
			const cleanContent = content.split(/\s*<\//)[0].trim();

			// 新增：尝试使用 SurroundingsRemover 解析 XML 内容（参考 Void 的 parseXMLPrefixToToolCall）
			const xmlParsed = this._tryParseXmlWithSurroundingsRemover(cleanContent);
			if (xmlParsed) {
				this._logService.info(`[AgentOS] _processXmlTagContent: parsed via SurroundingsRemover: name=${xmlParsed.name}`);
				results.push({
					id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: xmlParsed.name,
					arguments: xmlParsed.args,
				});
				return; // 解析成功，提前返回
			}

			// XML 属性式: <tool_call name="xxx"><param key="val"/></tool_call>
			const nameMatch = cleanContent.match(/(?:name|tool|function)\s*[:=]\s*["']?(\w+)["']?/i);
			const argsMatch = cleanContent.match(/(?:arguments?|params?|input)\s*[:=]\s*({[\s\S]*})/i);
			if (nameMatch) {
				let args = '{}';
				if (argsMatch) {
					try { JSON.parse(argsMatch[1]); args = argsMatch[1]; } catch { /* use default */ }
				}
				results.push({
					id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: nameMatch[1],
					arguments: args,
				});
			} else if (/^[\w_\-]+$/.test(cleanContent)) {
				// 兜底: content 本身是纯文本工具名，如 <tool_call>terminal</tool_call>
				this._logService.info(`[AgentOS] _extractToolCallsFromXml: treating content as raw tool name: "${cleanContent}"`);
				results.push({
					id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: cleanContent,
					arguments: '{}',
				});
			} else {
				this._logService.info(`[AgentOS] _extractToolCallsFromXml: unprocessable content for <${tag}>: "${cleanContent.substring(0, 60)}"`);
			}
		}
	}

	/**
	 * 从 Bracket 格式提取工具调用。
	 * 支持: [TOOL_CALL]...[/TOOL_CALL], [FUNCTION]...[/FUNCTION]
	 */
	private _extractToolCallsFromBrackets(text: string): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];
		const bracketTags = ['TOOL_CALL', 'FUNCTION', 'TOOL', 'ACTION'];

		for (const tag of bracketTags) {
			const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[/${tag}\\]`, 'gi');
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				const content = match[1].trim();
				if (content.startsWith('{')) {
					try {
						const parsed = JSON.parse(content);
						const tc = this._parseSingleToolCall(parsed);
						if (tc) { results.push(tc); }
					} catch { /* ignore */ }
				} else if (/^[\w_\-]+$/.test(content)) {
					// 兜底: content 本身是纯文本工具名，如 [TOOL_CALL]terminal[/TOOL_CALL]
					this._logService.info(`[AgentOS] _extractToolCallsFromBrackets: treating content as raw tool name: "${content}"`);
					results.push({
						id: `bracket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: content,
						arguments: '{}',
					});
				}
			}
		}
		return results;
	}

	/**
	 * 从 ReAct 格式提取工具调用。
	 * 格式: Action: tool_name\nAction Input: { ... }
	 */
	private _extractToolCallsFromReAct(text: string): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];

		// 匹配 "Action:" 后跟工具名，然后 "Action Input:" 后跟 JSON
		const reactPattern = /Action\s*:\s*(\w+)\s*\n+\s*Action\s*Input\s*:\s*([\s\S]*?)(?=\n\s*(?:Observation|Action|Thought)|\n\n|$)/gi;
		let match: RegExpExecArray | null;
		while ((match = reactPattern.exec(text)) !== null) {
			const toolName = match[1].trim();
			let argsStr = match[2].trim();

			// 尝试解析参数
			if (!argsStr.startsWith('{')) {
				argsStr = `{"input": ${JSON.stringify(argsStr)}}`;
			} else {
				try { JSON.parse(argsStr); } catch {
					argsStr = `{"input": ${JSON.stringify(argsStr)}}`;
				}
			}

			results.push({
				id: `react_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: toolName,
				arguments: argsStr,
			});
		}
		return results;
	}

	/**
	 * 从 Python 函数调用语法中提取工具调用。
	 * 支持：
	 *   - ```python\ntool_name(arg1="val1", arg2=val2)\n```
	 *   - 行内: tool_name(command="pwd")
	 *   - 多行调用: tool_name(\n  arg1="val",\n  arg2=123\n)
	 *
	 * 这是 qwen3.5 等不支持原生 function calling 的模型常见的输出格式。
	 */
	private _extractToolCallsFromPythonSyntax(text: string): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];

		// 先提取 ```python 代码块中的内容
		const codeBlockRegex = /```(?:python|Python)?\s*\n([\s\S]*?)\n\s*```/g;
		const codeBlocks: string[] = [];
		let cbMatch: RegExpExecArray | null;
		while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
			codeBlocks.push(cbMatch[1].trim());
		}

		// 如果没有代码块，整个文本作为候选
		const candidates = codeBlocks.length > 0 ? codeBlocks : [text];

		for (const candidate of candidates) {
			// 匹配 Python 函数调用: name(key="value", key2=123, key3=True/False/None)
			// 支持多行参数、嵌套引号、数值/布尔/None 字面量
			const funcCallPattern = /(\w+)\s*\(([\s\S]*?)\)/g;
			let fcMatch: RegExpExecArray | null;
			while ((fcMatch = funcCallPattern.exec(candidate)) !== null) {
				const funcName = fcMatch[1];
				const argsStr = fcMatch[2].trim();

				// 跳过明显不是工具调用的内容（Python 关键字、print 等）
				const skipNames = new Set(['print', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
					'type', 'isinstance', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted',
					'if', 'for', 'while', 'with', 'class', 'def', 'return', 'import', 'from',
					'true', 'false', 'none', 'null', 'self', 'super']);
				if (skipNames.has(funcName.toLowerCase())) { continue; }

				// 解析参数
				const args = this._parsePythonKwargs(argsStr);
				if (args && Object.keys(args).length > 0) {
					results.push({
						id: `pyfunc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: funcName,
						arguments: JSON.stringify(args),
					});
				} else if (args !== null) {
					// 无参数的函数调用
					results.push({
						id: `pyfunc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: funcName,
						arguments: '{}',
					});
				}
			}
		}

		return results;
	}

	/**
	 * 解析 Python keyword arguments 字符串为 Record<string, unknown>。
	 * 输入如: command="pwd", timeout=180, background=False
	 */
	private _parsePythonKwargs(argsStr: string): Record<string, unknown> | null {
		if (!argsStr || argsStr.trim() === '') { return {}; }

		// 如果参数字符串是 JSON 对象格式（以 '{' 开头），直接解析为 JSON
		// 这处理了 LLM 输出 tool_name({"arg": "value"}) 格式的情况
		const trimmed = argsStr.trim();
		if (trimmed.startsWith('{')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {
				// 不是有效 JSON，继续 Python kwargs 解析
			}
		}

		const result: Record<string, unknown> = {};
		let i = 0;
		const len = argsStr.length;

		while (i < len) {
			// 跳过空白和逗号
			while (i < len && (argsStr[i] === ' ' || argsStr[i] === '\t' || argsStr[i] === '\n' || argsStr[i] === ',')) { i++; }
			if (i >= len) { break; }

			// 读取 key
			const keyStart = i;
			while (i < len && /[\w_]/.test(argsStr[i])) { i++; }
			const key = argsStr.slice(keyStart, i);
			if (!key) { break; }

			// 跳过空白
			while (i < len && argsStr[i] === ' ') { i++; }

			// 期待 '='
			if (i >= len || argsStr[i] !== '=') { return null; }
			i++; // skip '='

			// 跳过空白
			while (i < len && argsStr[i] === ' ') { i++; }

			// 读取 value
			if (i >= len) { break; }

			if (argsStr[i] === '"' || argsStr[i] === "'") {
				// 字符串值
				const quote = argsStr[i];
				i++;
				let value = '';
				while (i < len && argsStr[i] !== quote) {
					if (argsStr[i] === '\\' && i + 1 < len) {
						const next = argsStr[i + 1];
						if (next === 'n') { value += '\n'; i += 2; }
						else if (next === 't') { value += '\t'; i += 2; }
						else if (next === quote) { value += quote; i += 2; }
						else if (next === '\\') { value += '\\'; i += 2; }
						else { value += next; i += 2; }
					} else {
						value += argsStr[i];
						i++;
					}
				}
				if (i < len) { i++; }
				result[key] = value;
			} else if (argsStr[i] === '{' || argsStr[i] === '[') {
				// JSON 对象或数组
				const open = argsStr[i];
				const close = open === '{' ? '}' : ']';
				let depth = 0;
				const jsonStart = i;
				while (i < len) {
					if (argsStr[i] === open) { depth++; }
					else if (argsStr[i] === close) { depth--; }
					i++;
					if (depth === 0) { break; }
				}
				try {
					result[key] = JSON.parse(argsStr.slice(jsonStart, i));
				} catch {
					result[key] = argsStr.slice(jsonStart, i);
				}
			} else {
				// 数字、布尔、None/null 或裸字符串
				const valStart = i;
				while (i < len && argsStr[i] !== ',' && argsStr[i] !== ' ' && argsStr[i] !== '\n' && argsStr[i] !== ')') { i++; }
				const rawVal = argsStr.slice(valStart, i).trim();
				if (rawVal === 'True' || rawVal === 'true') { result[key] = true; }
				else if (rawVal === 'False' || rawVal === 'false') { result[key] = false; }
				else if (rawVal === 'None' || rawVal === 'null') { result[key] = null; }
				else if (/^-?\d+(\.\d+)?$/.test(rawVal)) { result[key] = Number(rawVal); }
				else { result[key] = rawVal; }
			}
		}

		return Object.keys(result).length > 0 ? result : null;
	}

	/**
	 * 从模型的 thinking/reasoning 内容中提取工具名称。
	 * 支持模式如："使用 terminal 工具"、"call the terminal tool"、"use terminal"
	 */
	private _extractToolNameFromThinking(thinking: string): string | null {
		if (!thinking) { return null; }

		// 模式1: "使用 xxx 工具" / "调用 xxx 工具" / "用 xxx 来"
		const zhMatch = thinking.match(/(?:使用|调用|用)\s*[`'""]?(\w+)[`'""]?\s*(?:工具|来|命令)/);
		if (zhMatch) { return zhMatch[1]; }

		// 模式2: "use the xxx tool" / "call xxx" / "invoke xxx"
		const enMatch = thinking.match(/(?:use|call|invoke|using)\s+(?:the\s+)?[`'""]?(\w+)[`'""]?\s*(?:tool|function|command)?/i);
		if (enMatch) { return enMatch[1]; }

		// 模式3: 直接匹配已知工具名模式（常见工具名如 terminal, file_read, file_write 等）
		const knownToolPattern = /\b(terminal|file_read|file_write|execute_command|search_files?|list_files?|run_command|shell|bash|exec)\b/i;
		const knownMatch = thinking.match(knownToolPattern);
		if (knownMatch) { return knownMatch[1].toLowerCase(); }

		return null;
	}

	/**
	 * 从文本中提取顶层 JSON 对象（支持嵌套大括号）
	 */
	private _extractJsonObjects(text: string): string[] {
		const results: string[] = [];
		let i = 0;
		while (i < text.length) {
			if (text[i] === '{') {
				let depth = 0;
				let inString = false;
				let escape = false;
				const start = i;
				let found = false;
				for (let j = i; j < text.length; j++) {
					const ch = text[j];
					if (escape) { escape = false; continue; }
					if (ch === '\\' && inString) { escape = true; continue; }
					if (ch === '"' && !escape) { inString = !inString; continue; }
					if (inString) { continue; }
					if (ch === '{') { depth++; }
					else if (ch === '}') {
						depth--;
						if (depth === 0) {
							const candidate = text.slice(start, j + 1);
							// Quick check: does it look like a tool call?
							if (/["'](?:tool_name|tool|function|name)["']\s*:/i.test(candidate) &&
								/["'](?:arguments|args|parameters|params|command)["']\s*:/i.test(candidate)) {
								results.push(candidate);
							}
							i = j + 1;
							found = true;
							break;
						}
					}
				}
				if (!found) {
					// Unclosed brace — skip past it
					i = start + 1;
				}
			} else {
				i++;
			}
		}
		return results;
	}

	/**
	 * 解析 <tool> 标签的特殊格式，支持两种变体：
	 *
	 * 格式 A（▷ 头部）：
	 *   ▷{"tool_call_id":"...","name":"terminal","display_name":"...","render_type":"...","default_show":true}
	 *   <document>{"command":"...","cwd":"...",...}</document>
	 *
	 * 格式 B（<tool_call> 子标签）：
	 *   <tool_call>{"tool_call_id":"...","name":"web_preview","display_name":"...","render_type":"...","default_show":true}</tool_call>
	 *   <document>{"url":"...",...}</document>
	 */
	private _parseToolXMLFormat(content: string): IToolCallInfo | null {
		// 先尝试格式 B：<tool_call> 子标签
		const toolCallMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
		if (toolCallMatch) {
			try {
				const header = JSON.parse(toolCallMatch[1].trim());
				const args = this._extractToolDocument(content);
				this._logService.info(`[AgentOS] _parseToolXMLFormat format B (tool_call): name=${header.name}, default_show=${header.default_show} (type=${typeof header.default_show}), displayName=${header.display_name}, renderType=${header.render_type}`);
				return {
					id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: header.name || header.tool_name || header.tool || '',
					arguments: args ? JSON.stringify(args) : '{}',
					displayName: header.display_name,
					renderType: header.render_type,
					defaultShow: header.default_show !== false,
				};
			} catch (e) {
				this._logService.info(`[AgentOS] _parseToolXMLFormat format B parse error: ${e}`);
				/* fall through to format A */
			}
		}

		// 格式 A：提取 ▷ 后面的 JSON 头部
		const headerMatch = content.match(/[▷►]\s*(\{[\s\S]*?\})\s*\n/);
		if (!headerMatch) {
			// 尝试无 ▷ 前缀的纯 JSON 格式（第一行 JSON）
			const plainJsonMatch = content.match(/^(\{[^<]*?\})\s*\n/);
			if (!plainJsonMatch) {
				this._logService.info(`[AgentOS] _parseToolXMLFormat: no format matched, content preview=${content.substring(0, 120)}`);
				return null;
			}
			try {
				const header = JSON.parse(plainJsonMatch[1]);
				const args = this._extractToolDocument(content);
				this._logService.info(`[AgentOS] _parseToolXMLFormat format A (plain JSON): name=${header.name}, default_show=${header.default_show} (type=${typeof header.default_show}), displayName=${header.display_name}, renderType=${header.render_type}`);
				return {
					id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: header.name || header.tool_name || header.tool || '',
					arguments: args ? JSON.stringify(args) : '{}',
					displayName: header.display_name,
					renderType: header.render_type,
					defaultShow: header.default_show !== false,
				};
			} catch { return null; }
		}

		try {
			const header = JSON.parse(headerMatch[1]);
			const args = this._extractToolDocument(content);
			this._logService.info(`[AgentOS] _parseToolXMLFormat format A (▷ prefix): name=${header.name}, default_show=${header.default_show} (type=${typeof header.default_show}), displayName=${header.display_name}, renderType=${header.render_type}`);
			return {
				id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: header.name || header.tool_name || header.tool || '',
				arguments: args ? JSON.stringify(args) : '{}',
				displayName: header.display_name,
				renderType: header.render_type,
				defaultShow: header.default_show !== false,
			};
		} catch {
			return null;
		}
	}

	/**
	 * 从 <tool> 内容中提取 <document> 子标签的 JSON 数据。
	 */
	private _extractToolDocument(content: string): Record<string, unknown> | null {
		const docMatch = content.match(/<document>([\s\S]*?)<\/document>/);
		if (!docMatch) { return null; }
		try {
			return JSON.parse(docMatch[1].trim());
		} catch {
			return null;
		}
	}


	/**
	 * 解析单个 JSON 对象为 IToolCallInfo
	 * Enhanced with OpenClaw-inspired multi-field resolution:
	 *  - Name: tool_name → function → name → tool
	 *  - Args: arguments → args → parameters → params → input (Anthropic)
	 *  - ID: id → tool_use_id → toolUseId → tool_call_id
	 *
	 * Also supports argument-only JSON inference: when a model outputs only
	 * parameters (e.g. {"command": "pwd"}), we infer the tool name from the
	 * parameter keys by matching against enabled tool schemas.
	 */
	private _parseSingleToolCall(parsed: any, enabledTools?: IToolDefinition[]): IToolCallInfo | null {
		let name = parsed.tool_name || parsed.function || parsed.name || parsed.tool;

		// Fallback 1: {"toolName": {"arg": "val"}} format
		if (!name || typeof name !== 'string') {
			const keys = Object.keys(parsed);
			const reserved = new Set(['id', 'tool_use_id', 'toolUseId', 'tool_call_id']);
			const candidateKeys = keys.filter(k => !reserved.has(k));
			if (candidateKeys.length === 1 && typeof parsed[candidateKeys[0]] === 'object' && parsed[candidateKeys[0]] !== null && !Array.isArray(parsed[candidateKeys[0]])) {
				name = candidateKeys[0];
				return {
					id: `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name,
					arguments: JSON.stringify(parsed[name]),
				};
			}
		}

		// Fallback 2: argument-only JSON — infer tool name from parameter keys
		if (!name && enabledTools && enabledTools.length > 0) {
			const parsedKeys = Object.keys(parsed).filter(k => !['id', 'tool_use_id', 'toolUseId', 'tool_call_id'].includes(k));
			if (parsedKeys.length > 0) {
				// Find the tool whose schema has the most matching parameter keys
				let bestMatch: { tool: IToolDefinition; score: number } | null = null;
				for (const tool of enabledTools) {
					const schemaKeys = Object.keys((tool.inputSchema as any)?.properties || {});
					const requiredKeys: string[] = (tool.inputSchema as any)?.required || [];
					let score = 0;
					for (const key of parsedKeys) {
						if (schemaKeys.includes(key)) { score += 2; }
						if (requiredKeys.includes(key)) { score += 3; }
					}
					if (score > 0 && (!bestMatch || score > bestMatch.score)) {
						bestMatch = { tool, score };
					}
				}
				if (bestMatch && bestMatch.score >= 3) {
					name = bestMatch.tool.name;
					this._logService.info(`[AgentOS] Inferred tool name '${name}' from parameter keys [${parsedKeys.join(', ')}] (score=${bestMatch.score})`);
				}
			}
		}

		if (!name || typeof name !== 'string') {
			return null;
		}

		// Use OpenClaw-style multi-field resolution for arguments
		let rawArgs = parsed.arguments || parsed.args || parsed.parameters || parsed.params || parsed.input;

		// Fallback: some models put args at top-level (e.g. {"tool": "terminal", "command": "pwd"})
		if (!rawArgs || (typeof rawArgs === 'object' && Object.keys(rawArgs).length === 0)) {
			const reservedKeys = new Set(['tool_name', 'function', 'name', 'tool', 'id', 'tool_use_id', 'toolUseId', 'tool_call_id']);
			const inferredArgs: Record<string, any> = {};
			for (const key of Object.keys(parsed)) {
				if (!reservedKeys.has(key)) {
					inferredArgs[key] = parsed[key];
				}
			}
			if (Object.keys(inferredArgs).length > 0) {
				rawArgs = inferredArgs;
			}
		}
		if (!rawArgs) { rawArgs = {}; }

		let argsStr: string;
		if (typeof rawArgs === 'string') {
			// Some models output arguments as a JSON string — validate/repair
			const repaired = repairToolArguments(rawArgs);
			argsStr = repaired ? JSON.stringify(repaired) : rawArgs;
		} else if (typeof rawArgs === 'object' && rawArgs !== null) {
			argsStr = JSON.stringify(rawArgs);
		} else {
			argsStr = '{}';
		}

		// Resolve ID using OpenClaw-style multi-field lookup
		const id = parsed.id || parsed.tool_use_id || parsed.toolUseId || parsed.tool_call_id
			|| `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		return {
			id: String(id),
			name,
			arguments: argsStr,
		};
	}

	/**
	 * 带 Fallback 的执行包装器
	 * @param primaryExecution 主执行函数
	 * @param request 请求参数
	 */
	private async *_executeWithFallback(
		primaryExecution: () => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
	): AsyncIterable<IChatStreamDelta> {
		let lastError: Error | undefined;
		let attempt = 0;

		// 尝试主执行
		try {
			yield* primaryExecution();
			return; // 成功，直接返回
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			this._logService.warn(`[AgentOS] Primary execution failed (attempt ${attempt + 1}):`, error);
			attempt++;
		}

		// Fallback: 尝试备用模型
		const modelProvider = this._getActiveModelProvider();
		if (!modelProvider) {
			yield {
				type: 'error',
				content: `All execution attempts failed. Last error: ${lastError?.message || 'Unknown error'}`,
			};
			return;
		}

		const primaryModelId = this.getActiveModelSelection().modelId;
		const fallbackModels = this._fallbackModels.filter(m => m !== primaryModelId);

		for (const fallbackModel of fallbackModels) {
			if (attempt >= this._maxFallbackAttempts) {
				this._logService.warn(`[AgentOS] Max fallback attempts (${this._maxFallbackAttempts}) reached`);
				break;
			}

			try {
				this._logService.info(`[AgentOS] Trying fallback model: ${fallbackModel}`);
				yield {
					type: 'text',
					content: `\n[System: Switching to fallback model: ${fallbackModel}]\n`,
				};

				// 将 systemPrompt 注入到 messages 最前面作为 system message
				let messages: any[];
				if (request.systemPrompt) {
					messages = [
						{ role: 'system', content: request.systemPrompt },
						...request.messages,
					];
				} else {
					messages = request.messages as any[];
				}
				const options = request.options as any;
				// 传递 context（包含 agentId）给 provider
				const context: { agentId?: string } = {};
				if (request.agentId) {
					context.agentId = request.agentId;
				}
				const stream = await modelProvider.chat(fallbackModel, messages, options, context);

				for await (const delta of stream) {
					yield this._adaptModelDelta(delta);
				}

				// 成功，返回
				this._logService.info(`[AgentOS] Fallback model ${fallbackModel} succeeded`);
				return;

			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				this._logService.warn(`[AgentOS] Fallback model ${fallbackModel} failed:`, error);
				attempt++;
			}
		}

		// 所有 Fallback 都失败
		this._logService.error('[AgentOS] All fallback attempts failed');
		yield {
			type: 'error',
			content: `All models failed. Last error: ${lastError?.message || 'Unknown error'}`,
		};
	}

	private _getActiveModelProvider(): IModelProvider | undefined {
		if (!this._activeSelection) {
			return undefined;
		}
		return this._modelProviders.find(p => p.id === this._activeSelection!.providerId);
	}

	private *_fallbackToDirectChat(request: IAgentTurnRequest): Generator<IChatStreamDelta, any, any> {
		// Phase 1: 直通模式 — 通过现有 agentChatService 发送
		// 此方法在 Phase 2 重构 agentChatService 后可移除
		this._logService.info('[AgentOS] Fallback: delegating to AgentChatService');
		// 返回空（Phase 1 暂时不实现直通）
		yield { type: 'error', content: 'No ModelProvider registered. Please install a Model Provider plugin.' };
	}

	private _adaptModelDelta(delta: any): IChatStreamDelta {
		// 将 IModelDelta 适配为 IChatStreamDelta。
		//
		// 防御性兜底：上游 IModelDelta（来自 BYOK / LM bridge / Knot 等多家 provider）
		// 不能保证 content 一定是 string —— 例如 vendor copilot 的 IChatResponsePart
		// 在 reasoning 阶段会送 type='text' 但 value=undefined 的占位 part。
		// 任何 undefined / non-string 内容如果直接透传到 webview，模板字符串拼接
		// 时会被 `${undefined}` 渲染成字面量 "undefined" 字符串污染 textBuffer。
		// 这里在适配层统一做 type-coercion，保证下游永远拿到 string 类型 content。
		const safeContent = (v: unknown): string => (typeof v === 'string' ? v : '');
		if (delta.type === 'text') {
			return { type: 'text', content: safeContent(delta.content) };
		}
		if (delta.type === 'thinking') {
			return { type: 'thinking', content: safeContent(delta.content) };
		}
		if (delta.type === 'tool_call' && delta.toolCall) {
			// Adapt tool_call delta to tool_start/tool_args chunks
			if (delta.toolCall.name) {
				const result: any = { type: 'tool_start' as any, content: '', toolCallId: delta.toolCall.id, toolName: delta.toolCall.name };
				// Forward display metadata if present
				if (delta.toolCall.displayName !== undefined) { result.displayName = delta.toolCall.displayName; }
				if (delta.toolCall.renderType !== undefined) { result.renderType = delta.toolCall.renderType; }
				if (delta.toolCall.defaultShow !== undefined) { result.defaultShow = delta.toolCall.defaultShow; }
				this._logService.info(`[AgentOS] _adaptModelDelta tool_start: name=${delta.toolCall.name}, defaultShow=${delta.toolCall.defaultShow}, displayName=${delta.toolCall.displayName}, renderType=${delta.toolCall.renderType}`);
				return result;
			}
			return { type: 'tool_args' as any, content: delta.toolCall.arguments || '', toolCallId: delta.toolCall.id };
		}
		if (delta.type === 'done') {
			return { type: 'done' };
		}
		if (delta.type === 'error') {
			return { type: 'error', content: safeContent(delta.error) || safeContent(delta.content) || 'Unknown error' };
		}
		// ── KV Cache: forward usage metrics (Anthropic Prompt Caching / OpenAI cached_tokens) ──
		// Without this branch, BYOK provider's `{ type: 'usage', usage: {...} }` delta would
		// fall through to the default `{ type: 'text', content: '' }` and be silently dropped
		// before reaching the host→webview boundary, leaving the UI unable to show cache hits.
		if (delta.type === 'usage' && delta.usage) {
			return { type: 'usage', usage: delta.usage };
		}
		return { type: 'text', content: '' };
	}

}

