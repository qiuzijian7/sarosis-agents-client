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

// ─── Agent OS Service Implementation ────────────────────────────────────

export class AgentOSService extends Disposable implements IAgentOSService {

	declare readonly _serviceBrand: undefined;

	private readonly _slotRegistry: SlotRegistry;
	private readonly _modelProviders: IModelProvider[] = [];
	private _activeSelection: IModelSelection | undefined;
	private _logService: ILogService = console as unknown as ILogService;

	// Events
	private readonly _onDidChangeModelProviders = this._register(new Emitter<void>());
	readonly onDidChangeModelProviders = this._onDidChangeModelProviders.event;

	private readonly _onDidChangeAvailableModels = this._register(new Emitter<void>());
	readonly onDidChangeAvailableModels = this._onDidChangeAvailableModels.event;

	constructor() {
		super();
		this._slotRegistry = this._register(new SlotRegistry());
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

	// ─── 统一执行入口 ───────────────────────────────────────────

	/**
	 * 执行一次 Agent 对话轮次
	 *
	 * Phase 1: 空壳实现 — 若无 Provider 则退化为直通模式（调用现有 agentChatService）
	 * Phase 2: 将实现完整编排逻辑
	 */
	async *executeAgentTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		this._logService.info(`[AgentOS] executeAgentTurn: agentId=${request.agentId}, messages=${request.messages.length}`);

		// ─── 编排流程 ───────────────────────────────────────
		// 优先使用 ExecutionProvider（完整 Agent Loop）
		// 若无，则退化为直接 Model Provider 调用

		const executionProvider = this.getActiveExecutionProvider();
		if (executionProvider) {
			this._logService.info(`[AgentOS] Using ExecutionProvider: ${executionProvider.id}`);
			try {
				yield* executionProvider.runAgentLoop(request, this.getSlotRegistry());
			} catch (error) {
				this._logService.error('[AgentOS] ExecutionProvider failed', error);
				yield { type: 'error', content: String(error) };
			}
			return;
		}

		// ─── 退化模式：直接调用 Model Provider ─────────────────
		const modelProvider = this._getActiveModelProvider();
		if (!modelProvider) {
			this._logService.warn('[AgentOS] No ModelProvider available');
			yield* this._fallbackToDirectChat(request);
			return;
		}

		this._logService.info(`[AgentOS] Using ModelProvider directly: ${modelProvider.id}`);
		const selection = this.getActiveModelSelection();
		const messages = request.messages as any[];
		const options = request.options as any;

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

		// 调用 Model Provider
		try {
			const stream = await modelProvider.chat(selection.modelId, messages, options);
			for await (const delta of stream) {
				yield this._adaptModelDelta(delta);
			}

			// 可选：将对话写回 Memory（如果有 Memory Provider）
			if (memoryProvider) {
				// TODO: 构造 IMemoryEntry 并调用 memoryProvider.writeMemory()
				this._logService.info(`[AgentOS] Would write memory for agent ${request.agentId}`);
			}
		} catch (error) {
			this._logService.error('[AgentOS] ModelProvider chat failed', error);
			yield { type: 'error', content: String(error) };
		}
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
		if (delta.type === 'done') {
			return { type: 'done' };
		}
		if (delta.type === 'error') {
			return { type: 'error', content: delta.error };
		}
		return { type: 'text', content: '' };
	}

	// ─── 服务注入 ────────────────────────────────────────────────

	setLogService(logService: ILogService): void {
		this._logService = logService;
		this._slotRegistry.setLogService(logService);
	}
}

// Forward declarations
import { ILogService } from '../../../../platform/log/common/log.js';
