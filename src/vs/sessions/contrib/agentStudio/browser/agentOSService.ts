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
	formatToolErrorResult,
	formatToolNotFoundResult,
	classifyArgumentValidity,
	buildValidToolNameSet,
	buildToolSchemaMap,
	MAX_INVALID_TOOL_RETRIES,
	MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES,
	shouldParallelizeToolBatch,
	StreamingToolCallAssembler,
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

		// 可选：加载 Memory 上下文（如果有 Memory Provider）
		const memoryProvider = this.getActiveMemoryProvider();
		if (memoryProvider) {
			try {
				this._logService.info(`[AgentOS] Memory provider available for agent ${request.agentId}`);
			} catch (error) {
				this._logService.error('[AgentOS] Failed to load memory context', error);
			}
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
						toolCallAssembler.start(tc.id, tc.name, tc.arguments || '');
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
						yield adapted;
					}
				}
			} catch (error) {
				this._logService.error(`[AgentOS] Model call failed on iteration ${iteration}:`, error);
				// 如果是第一次迭代失败，尝试 fallback
				if (iteration === 1) {
					yield { type: 'error', content: `Model call failed: ${error instanceof Error ? error.message : String(error)}` };
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
				yield {
					type: 'tool_start',
					toolCallId: tc.id,
					toolName: tc.name,
				};
			}
		}
	}

		// Deduplicate tool calls
		effectiveToolCalls = deduplicateToolCalls(effectiveToolCalls);
		if (effectiveToolCalls.length < assistantToolCalls.length) {
			this._logService.info(`[AgentOS] Deduplicated: ${assistantToolCalls.length} → ${effectiveToolCalls.length}`);
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
			yield { type: 'done' };
			break;
		}

		// ─── 执行工具调用 ─────────────────────────────────────
		const canParallel = shouldParallelizeToolBatch(effectiveToolCalls);
		const toolResults = canParallel
			? await this._executeToolCallsParallel(effectiveToolCalls, request.agentId)
			: await this._executeToolCalls(effectiveToolCalls, request.agentId);

			// 将工具结果添加到消息历史（带结果大小限制 + 错误清洗 + 推理标签清理）
			for (const toolResult of toolResults) {
				let resultStr = JSON.stringify(toolResult.content);
				resultStr = limitToolResultSize(resultStr);
				// Sanitize tool result: strip reasoning tags and other artifacts
				// that might leak from model responses into tool results
				resultStr = sanitizeToolResultText(resultStr);

				messages.push({
					role: 'tool',
					content: resultStr,
					toolCallId: toolResult.toolCallId,
				});

				// 向 UI yield 工具结果 + tool_end（前端需要 tool_end 才能停止转圈）
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

						// Limit result size
						const contentStr = JSON.stringify(result.content);
						const limitedStr = limitToolResultSize(contentStr);
						const wasTruncated = limitedStr !== contentStr;
						const finalContent = wasTruncated ? JSON.parse(limitedStr) : result.content;

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
	private async _executeToolCallsParallel(toolCalls: IToolCallInfo[], agentId: string): Promise<Array<{ toolCallId: string; content: any; success: boolean }>> {
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
						const contentStr = JSON.stringify(result.content);
						const limitedStr = limitToolResultSize(contentStr);
						const finalContent = limitedStr !== contentStr ? JSON.parse(limitedStr) : result.content;

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

		// Use allSettled so one failure doesn't block others
		const settled = await Promise.allSettled(executionPromises);

		// Combine results — skipped entries + executed entries, sorted by original index
		const allResults: Array<{ originalIndex: number; toolCallId: string; content: any; success: boolean }> = [];

		for (const entry of executionEntries) {
			if (entry.skip) {
				allResults.push({
					originalIndex: entry.originalIndex,
					...entry.skipResult!,
				});
			}
		}

		for (const result of settled) {
			if (result.status === 'fulfilled' && result.value) {
				allResults.push(result.value);
			} else if (result.status === 'rejected') {
				this._logService.error('[AgentOS] [parallel] Tool execution promise rejected:', result.reason);
			}
		}

		// Sort by original index to preserve order
		allResults.sort((a, b) => a.originalIndex - b.originalIndex);

		// Strip the originalIndex from output
		return allResults.map(({ toolCallId, content, success }) => ({ toolCallId, content, success }));
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
		const xmlTags = ['tool_call', 'function_call', 'tool_use', 'invoke'];

		for (const tag of xmlTags) {
			const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				const content = match[1].trim();
				// XML 内部可能是 JSON
				if (content.startsWith('{')) {
					try {
						const parsed = JSON.parse(content);
						const tc = this._parseSingleToolCall(parsed);
						if (tc) { results.push(tc); }
					} catch { /* ignore */ }
				} else {
					// XML 属性式: <tool_call name="xxx"><param key="val"/></tool_call>
					const nameMatch = content.match(/(?:name|tool|function)\s*[:=]\s*["']?(\w+)["']?/i);
					const argsMatch = content.match(/(?:arguments?|params?|input)\s*[:=]\s*({[\s\S]*})/i);
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
					}
				}
			}
		}
		return results;
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
		// 将 IModelDelta 适配为 IChatStreamDelta
		if (delta.type === 'text') {
			return { type: 'text', content: delta.content };
		}
		if (delta.type === 'thinking') {
			return { type: 'thinking', content: delta.content };
		}
		if (delta.type === 'tool_call' && delta.toolCall) {
			// Adapt tool_call delta to tool_start/tool_args chunks
			if (delta.toolCall.name) {
				return { type: 'tool_start' as any, content: '', toolCallId: delta.toolCall.id, toolName: delta.toolCall.name };
			}
			return { type: 'tool_args' as any, content: delta.toolCall.arguments || '', toolCallId: delta.toolCall.id };
		}
		if (delta.type === 'done') {
			return { type: 'done' };
		}
		if (delta.type === 'error') {
			return { type: 'error', content: delta.error || delta.content || 'Unknown error' };
		}
		return { type: 'text', content: '' };
	}

}

