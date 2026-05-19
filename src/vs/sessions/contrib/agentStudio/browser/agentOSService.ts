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
	IToolDefinition,
} from '../common/providers.js';
import { SlotRegistry } from './slotRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';

// ─── Agent OS Service Implementation ────────────────────────────────────

export class AgentOSService extends Disposable implements IAgentOSService {

	declare readonly _serviceBrand: undefined;

	private readonly _slotRegistry: SlotRegistry;
	private readonly _modelProviders: IModelProvider[] = [];
	private _activeSelection: IModelSelection | undefined;
	private readonly _logService: ILogService;

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
	 * 带 Fallback 的直接模型调用
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

		// 将 systemPrompt 注入到 messages 最前面作为 system message
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
		const options = request.options || {};

		// 可选：加载 Memory 上下文（如果有 Memory Provider）
		const memoryProvider = this.getActiveMemoryProvider();
		if (memoryProvider) {
			try {
				// TODO: 将 memory context 合并到 messages 中
				this._logService.info(`[AgentOS] Memory provider available for agent ${request.agentId}`);
			} catch (error) {
				this._logService.error('[AgentOS] Failed to load memory context', error);
			}
		}

		// 调用 Model Provider（带 Fallback）
		const logService = this._logService;
		const self = this;
		const primaryIterable: AsyncIterable<IChatStreamDelta> = async function* () {
			// 传递 context（包含 agentId）给 provider
			const context: { agentId?: string } = {};
			if (request.agentId) {
				context.agentId = request.agentId;
			}
			logService.info(`[AgentOS] Calling modelProvider.chat(modelId=${selection.modelId}, messages=${messages.length})`);
			const stream = modelProvider.chat(selection.modelId, messages, options as any, context);
			let deltaCount = 0;
			for await (const delta of stream) {
				deltaCount++;
				logService.info(`[AgentOS] ModelProvider delta #${deltaCount}: type=${delta.type}, contentLen=${(delta as any).content?.length ?? (delta as any).error?.length ?? 0}`);
				yield self._adaptModelDelta(delta);
			}
			logService.info(`[AgentOS] ModelProvider stream ended, total deltas=${deltaCount}`);
		}();
		yield* this._executeWithFallback(
			() => primaryIterable,
			request,
		);
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

