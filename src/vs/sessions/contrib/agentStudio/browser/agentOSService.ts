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
					this._activeSelection = {
						providerId: selected.id,
						modelId: models[0].id,
					};
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

	// ─── Fallback 配置 ─────────────────────────────────────────
	private readonly _fallbackModels: string[] = ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'];
	private readonly _maxFallbackAttempts: number = 3;

	// ─── 统一执行入口 ───────────────────────────────────────────

	/**
	 * 执行一次 Agent 对话轮次
	 *
	 * 完整实现 — 包含错误恢复和 Fallback 机制
	 */
	async *executeAgentTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		this._logService.info(`[AgentOS] executeAgentTurn: agentId=${request.agentId}, messages=${request.messages.length}`);

		// ─── 编排流程 ───────────────────────────────────────
		// 优先使用 ExecutionProvider（完整 Agent Loop）
		// 若无，则退化为直接 Model Provider 调用（带 Fallback）

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

		// ─── 退化模式：直接调用 Model Provider（带 Fallback）─────────────────
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

		const messages = request.messages as any[];
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

				const messages = request.messages as any[];
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

