/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import {
	IModelProvider, IModelSelection, IMemoryProvider, IToolProvider,
	IPlanningProvider, IExecutionProvider, IRetrievalProvider, IKanbanProvider,
	ISlotRegistry,
} from '../common/providers.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * 能力槽注册表 — 管理所有已注册的能力 Provider
 *
 * 职责：
 * - 维护各能力槽的 Provider 注册表
 * - 按优先级自动选择活跃 Provider
 * - 提供 ISlotRegistry 供 ExecutionProvider 回调
 *
 * 注意：Model Slot 由 IAgentOSService 单独管理（支持多 Provider 多模型），
 * 此处 SlotRegistry 仅管理其他 6 个能力槽。
 * AgentOSService 可以通过 setModelProviderBridge() 让 SlotRegistry 能感知
 * AgentOS 管理的 Model Providers 和当前活跃选择。
 */
export class SlotRegistry extends Disposable implements ISlotRegistry {

	private readonly _logService: ILogService;

	private readonly _modelProviders: IModelProvider[] = [];
	private readonly _memoryProviders: { provider: IMemoryProvider; priority: number }[] = [];
	private readonly _toolProviders: { provider: IToolProvider; priority: number }[] = [];
	private readonly _planningProviders: { provider: IPlanningProvider; priority: number }[] = [];
	private readonly _executionProviders: { provider: IExecutionProvider; priority: number }[] = [];
	private readonly _retrievalProviders: { provider: IRetrievalProvider; priority: number }[] = [];
	private readonly _kanbanProviders: { provider: IKanbanProvider; priority: number }[] = [];

	/**
	 * Bridge callbacks set by AgentOSService so that SlotRegistry can query
	 * the OS-level ModelProvider list and active selection.
	 */
	private _modelProviderBridge?: {
		getModelProviders: () => IModelProvider[];
		getActiveModelSelection: () => IModelSelection | undefined;
	};

	constructor(logService: ILogService) {
		super();
		this._logService = logService;
	}

	/**
	 * Set by AgentOSService to let the SlotRegistry resolve the active
	 * ModelProvider from the OS-level registry (which is separate from
	 * the SlotRegistry's own _modelProviders list).
	 */
	setModelProviderBridge(bridge: {
		getModelProviders: () => IModelProvider[];
		getActiveModelSelection: () => IModelSelection | undefined;
	}): void {
		this._modelProviderBridge = bridge;
	}

	// ── Events ───────────────────────────────────────────────────────

	private readonly _onDidChangeModelProviders = this._register(new Emitter<void>());
	readonly onDidChangeModelProviders = this._onDidChangeModelProviders.event;

	// ── Model Providers（多 Provider 管理）────────────────────────

	registerModelProvider(provider: IModelProvider): IDisposable {
		this._modelProviders.push(provider);
		this._onDidChangeModelProviders.fire();
		this._logService.info(`[SlotRegistry] Registered ModelProvider: ${provider.id}`);

		return {
			dispose: () => {
				const idx = this._modelProviders.indexOf(provider);
				if (idx !== -1) {
					this._modelProviders.splice(idx, 1);
					this._onDidChangeModelProviders.fire();
					this._logService.info(`[SlotRegistry] Unregistered ModelProvider: ${provider.id}`);
				}
			},
		};
	}

	getModelProviders(): IModelProvider[] {
		return [...this._modelProviders];
	}

	// ── Memory Providers ─────────────────────────────────────────

	registerMemoryProvider(provider: IMemoryProvider, priority: number = 0): IDisposable {
		this._memoryProviders.push({ provider, priority });
		this._memoryProviders.sort((a, b) => b.priority - a.priority);
		this._logService.info(`[SlotRegistry] Registered MemoryProvider: ${provider.id} (priority=${priority})`);

		return {
			dispose: () => {
				const idx = this._memoryProviders.findIndex(p => p.provider.id === provider.id);
				if (idx !== -1) {
					this._memoryProviders.splice(idx, 1);
					this._logService.info(`[SlotRegistry] Unregistered MemoryProvider: ${provider.id}`);
				}
			},
		};
	}

	getActiveMemoryProvider(): IMemoryProvider | undefined {
		return this._memoryProviders.length > 0 ? this._memoryProviders[0].provider : undefined;
	}

	// ── Tool Providers ───────────────────────────────────────────

	registerToolProvider(provider: IToolProvider, priority: number = 0): IDisposable {
		this._toolProviders.push({ provider, priority });
		this._toolProviders.sort((a, b) => b.priority - a.priority);
		this._logService.info(`[SlotRegistry] Registered ToolProvider: ${provider.id} (priority=${priority})`);

		return {
			dispose: () => {
				const idx = this._toolProviders.findIndex(p => p.provider.id === provider.id);
				if (idx !== -1) {
					this._toolProviders.splice(idx, 1);
					this._logService.info(`[SlotRegistry] Unregistered ToolProvider: ${provider.id}`);
				}
			},
		};
	}

	getActiveToolProvider(): IToolProvider | undefined {
		return this._toolProviders.length > 0 ? this._toolProviders[0].provider : undefined;
	}

	// ── Planning Providers ───────────────────────────────────────

	registerPlanningProvider(provider: IPlanningProvider, priority: number = 0): IDisposable {
		this._planningProviders.push({ provider, priority });
		this._planningProviders.sort((a, b) => b.priority - a.priority);
		this._logService.info(`[SlotRegistry] Registered PlanningProvider: ${provider.id} (priority=${priority})`);

		return {
			dispose: () => {
				const idx = this._planningProviders.findIndex(p => p.provider.id === provider.id);
				if (idx !== -1) {
					this._planningProviders.splice(idx, 1);
					this._logService.info(`[SlotRegistry] Unregistered PlanningProvider: ${provider.id}`);
				}
			},
		};
	}

	getActivePlanningProvider(): IPlanningProvider | undefined {
		return this._planningProviders.length > 0 ? this._planningProviders[0].provider : undefined;
	}

	// ── Execution Providers ─────────────────────────────────────

	registerExecutionProvider(provider: IExecutionProvider, priority: number = 0): IDisposable {
		this._executionProviders.push({ provider, priority });
		this._executionProviders.sort((a, b) => b.priority - a.priority);
		this._logService.info(`[SlotRegistry] Registered ExecutionProvider: ${provider.id} (priority=${priority})`);

		return {
			dispose: () => {
				const idx = this._executionProviders.findIndex(p => p.provider.id === provider.id);
				if (idx !== -1) {
					this._executionProviders.splice(idx, 1);
					this._logService.info(`[SlotRegistry] Unregistered ExecutionProvider: ${provider.id}`);
				}
			},
		};
	}

	getActiveExecutionProvider(): IExecutionProvider | undefined {
		return this._executionProviders.length > 0 ? this._executionProviders[0].provider : undefined;
	}

	// ── Retrieval Providers ─────────────────────────────────────

	registerRetrievalProvider(provider: IRetrievalProvider, priority: number = 0): IDisposable {
		this._retrievalProviders.push({ provider, priority });
		this._retrievalProviders.sort((a, b) => b.priority - a.priority);
		this._logService.info(`[SlotRegistry] Registered RetrievalProvider: ${provider.id} (priority=${priority})`);

		return {
			dispose: () => {
				const idx = this._retrievalProviders.findIndex(p => p.provider.id === provider.id);
				if (idx !== -1) {
					this._retrievalProviders.splice(idx, 1);
					this._logService.info(`[SlotRegistry] Unregistered RetrievalProvider: ${provider.id}`);
				}
			},
		};
	}

	getActiveRetrievalProvider(): IRetrievalProvider | undefined {
		return this._retrievalProviders.length > 0 ? this._retrievalProviders[0].provider : undefined;
	}

	// ── Kanban Providers ───────────────────────────────────────

	registerKanbanProvider(provider: IKanbanProvider, priority: number = 0): IDisposable {
		this._kanbanProviders.push({ provider, priority });
		this._kanbanProviders.sort((a, b) => b.priority - a.priority);
		this._logService.info(`[SlotRegistry] Registered KanbanProvider: ${provider.id} (priority=${priority})`);

		return {
			dispose: () => {
				const idx = this._kanbanProviders.findIndex(p => p.provider.id === provider.id);
				if (idx !== -1) {
					this._kanbanProviders.splice(idx, 1);
					this._logService.info(`[SlotRegistry] Unregistered KanbanProvider: ${provider.id}`);
				}
			},
		};
	}

	getActiveKanbanProvider(): IKanbanProvider | undefined {
		return this._kanbanProviders.length > 0 ? this._kanbanProviders[0].provider : undefined;
	}

	// ── ISlotRegistry 实现（供 ExecutionProvider 回调）────────

	getActiveModelProvider(): IModelProvider | undefined {
		// Prefer the AgentOS-level active selection bridge (which knows
		// which provider the user chose in the chat bar)
		if (this._modelProviderBridge) {
			const selection = this._modelProviderBridge.getActiveModelSelection();
			if (selection) {
				const provider = this._modelProviderBridge.getModelProviders()
					.find(p => p.id === selection.providerId);
				if (provider) {
					return provider;
				}
			}
			// Fall through if bridge has no valid selection
		}
		// Fallback: use the SlotRegistry's own model provider list
		return this._modelProviders.length > 0 ? this._modelProviders[0] : undefined;
	}

	getActiveModelSelection(): IModelSelection | undefined {
		if (this._modelProviderBridge) {
			return this._modelProviderBridge.getActiveModelSelection();
		}
		return undefined;
	}

	// ── 清理 ──────────────────────────────────────────────────

	override dispose(): void {
		this._modelProviders.length = 0;
		this._memoryProviders.length = 0;
		this._toolProviders.length = 0;
		this._planningProviders.length = 0;
		this._executionProviders.length = 0;
		this._retrievalProviders.length = 0;
		this._kanbanProviders.length = 0;
		super.dispose();
	}
}

