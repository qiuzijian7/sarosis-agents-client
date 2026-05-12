/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IModelSelectorService, IModelSelectorItem, IModelSelectorProviderInfo } from '../common/modelSelector.js';
import { IModelSelection, IModelAgentInfo } from '../common/providers.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export class ModelSelectorService extends Disposable implements IModelSelectorService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSelection = this._register(new Emitter<IModelSelection>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private readonly _onDidChangeAvailableModels = this._register(new Emitter<void>());
	readonly onDidChangeAvailableModels = this._onDidChangeAvailableModels.event;

	private readonly _onDidChangeAgent = this._register(new Emitter<string | undefined>());
	readonly onDidChangeAgent = this._onDidChangeAgent.event;

	private readonly _agentOSService: IAgentOSService;
	private readonly _storageService: IStorageService;
	private readonly _logService: ILogService;
	private readonly _quickInputService: IQuickInputService;
	private readonly _commandService: ICommandService;
	private _currentSelection: IModelSelection | undefined;
	private _selectedAgentId: string | undefined;
	private _cachedModelItems: IModelSelectorItem[] = [];
	private _modelCacheValid = false;
	// Track auth status listeners per provider id to avoid duplicates
	private _authListenerDisposables = new Map<string, IDisposable>();

	constructor(
		@IAgentOSService agentOSService: IAgentOSService,
		@IStorageService storageService: IStorageService,
		@ILogService logService: ILogService,
		@IQuickInputService quickInputService: IQuickInputService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		this._agentOSService = agentOSService;
		this._storageService = storageService;
		this._logService = logService;
		this._quickInputService = quickInputService;
		this._commandService = commandService;

		// 监听 Model Provider 注册/卸载
		this._register(this._agentOSService.onDidChangeModelProviders(() => {
			this._syncAuthListeners();
			this._modelCacheValid = false;
			this._onDidChangeAvailableModels.fire();
		}));

		// 初始同步 auth 监听器
		this._syncAuthListeners();

		// 从存储中恢复选择
		this._loadSelection();
	}

	/**
	 * 同步每个 Provider 的 onDidChangeAuthStatus 监听器。
	 * 当 Provider 认证状态变化（用户在设置中保存 Token）时，
	 * 自动刷新可用模型列表，聊天框 Header 会实时更新。
	 */
	private _syncAuthListeners(): void {
		const currentIds = new Set(this._agentOSService.getModelProviders().map(p => p.id));

		// 移除已卸载 Provider 的监听器
		for (const [id, disposable] of this._authListenerDisposables) {
			if (!currentIds.has(id)) {
				disposable.dispose();
				this._authListenerDisposables.delete(id);
			}
		}

		// 为新 Provider 注册监听器
		for (const provider of this._agentOSService.getModelProviders()) {
			if (this._authListenerDisposables.has(provider.id)) {
				continue;
			}
			try {
				const disposable = provider.onDidChangeAuthStatus?.(() => {
					this._logService.info(`[ModelSelector] Auth status changed for ${provider.id}: ${provider.getAuthStatus()}`);
					this._modelCacheValid = false;
					this._onDidChangeAvailableModels.fire();
				});
				if (disposable) {
					this._authListenerDisposables.set(provider.id, this._register(disposable));
				}
			} catch (e) {
				// ignore providers that don't support auth status tracking
			}
		}
	}

	getSelection(): IModelSelection | undefined {
		if (!this._currentSelection) {
			// 尝试自动选择
			this._autoSelect();
		}
		return this._currentSelection;
	}

	setSelection(s: IModelSelection): void {
		const providerChanged = this._currentSelection?.providerId !== s.providerId;
		this._currentSelection = s;

		// 切换 Provider 时重置 Agent 选择
		if (providerChanged) {
			this._selectedAgentId = undefined;
			this._onDidChangeAgent.fire(undefined);
		} else {
			// 同一 Provider，恢复 agentId（如果从存储加载）
			this._selectedAgentId = s.agentId;
			if (s.agentId) {
				this._onDidChangeAgent.fire(s.agentId);
			}
		}

		this._saveSelection();
		this._onDidChangeSelection.fire(s);
		this._agentOSService.setActiveModelSelection(s);
		this._logService.info(`[ModelSelector] Selection changed: ${s.providerId}/${s.modelId}${s.agentId ? ` [agent: ${s.agentId}]` : ''}`);
	}

	// ─── Agent 选择（仅支持 Agent 的 Provider）────────────────────

	currentProviderSupportsAgents(): boolean {
		const sel = this._currentSelection;
		if (!sel) return false;
		const provider = this._agentOSService.getModelProviders().find(p => p.id === sel.providerId);
		return provider?.supportsAgents === true;
	}

	async getAvailableAgents(): Promise<IModelAgentInfo[]> {
		if (!this.currentProviderSupportsAgents()) {
			return [];
		}
		const sel = this._currentSelection!;
		const provider = this._agentOSService.getModelProviders().find(p => p.id === sel.providerId);
		if (!provider?.listAgents) {
			return [];
		}
		try {
			return await provider.listAgents();
		} catch (error) {
			this._logService.error('[ModelSelector] Failed to list agents', error);
			return [];
		}
	}

	getSelectedAgentId(): string | undefined {
		if (!this.currentProviderSupportsAgents()) {
			return undefined;
		}
		return this._selectedAgentId;
	}

	setSelectedAgentId(agentId: string | undefined): void {
		if (!this.currentProviderSupportsAgents()) {
			this._selectedAgentId = undefined;
			return;
		}
		this._selectedAgentId = agentId;

		// 同步更新当前选择中的 agentId
		if (this._currentSelection) {
			this._currentSelection = {
				...this._currentSelection,
				agentId,
			};
			this._agentOSService.setActiveModelSelection(this._currentSelection);
		}

		this._saveSelection();
		this._onDidChangeAgent.fire(agentId);
		this._logService.info(`[ModelSelector] Agent changed: ${agentId || '(none)'}`);
	}

	async showAgentQuickPick(): Promise<string | undefined> {
		if (!this.currentProviderSupportsAgents()) {
			this._logService.warn('[ModelSelector] Current provider does not support agents');
			return undefined;
		}

		const agents = await this.getAvailableAgents();

		if (agents.length === 0) {
			this._logService.warn('[ModelSelector] No agents available');
			return undefined;
		}

		const quickPickItems: (IQuickPickItem & { agentId: string | undefined })[] = [
			// 允许清除选择（使用默认 Agent）
			{
				label: '$(clear-all) 使用默认 Agent',
				description: '使用配置中的默认 Agent',
				agentId: undefined,
			},
			...agents.map(a => ({
				label: a.name || a.id,
				description: a.description || a.id,
				detail: a.models ? `支持模型: ${a.models.join(', ')}` : undefined,
				agentId: a.id,
			})),
		];

		const currentAgentId = this.getSelectedAgentId();
		const picked = await this._quickInputService.pick(quickPickItems, {
			placeHolder: '选择 Agent...',
			activeItem: currentAgentId
				? quickPickItems.find(i => i.agentId === currentAgentId)
				: quickPickItems[0],
		});

		if (picked) {
			this.setSelectedAgentId(picked.agentId);
			return picked.agentId;
		}

		return undefined;
	}

	async getAvailableModels(): Promise<IModelSelectorItem[]> {
		if (this._modelCacheValid && this._cachedModelItems.length > 0) {
			return this._cachedModelItems;
		}

		const providers = this._agentOSService.getModelProviders();
		const items: IModelSelectorItem[] = [];

		for (const provider of providers) {
			const providerInfo: IModelSelectorProviderInfo = {
				id: provider.id,
				name: provider.name,
				icon: provider.icon?.toString(),
				authStatus: provider.getAuthStatus(),
			};

			try {
				const models = await provider.listModels();
				for (const model of models) {
					items.push({
						provider: providerInfo,
						model,
					});
				}
			} catch (error) {
				this._logService.error(`[ModelSelector] Failed to list models for ${provider.id}`, error);
			}
		}

		this._cachedModelItems = items;
		this._modelCacheValid = true;
		return items;
	}

	async showQuickPick(): Promise<IModelSelection | undefined> {
		const items = await this.getAvailableModels();

		if (items.length === 0) {
			this._logService.warn('[ModelSelector] No models available');
			return undefined;
		}

		const quickPickItems: (IQuickPickItem & { selection: IModelSelection })[] = items.map(item => ({
			label: item.model.name || item.model.id,
			description: item.provider.name,
			detail: item.model.description || `Provider: ${item.provider.id} | Auth: ${item.provider.authStatus}`,
			selection: {
				providerId: item.provider.id,
				modelId: item.model.id,
			},
		}));

		const picked = await this._quickInputService.pick(quickPickItems, {
			placeHolder: 'Select a model...',
			activeItem: this._currentSelection
				? quickPickItems.find(i => i.selection.providerId === this._currentSelection!.providerId && i.selection.modelId === this._currentSelection!.modelId)
				: undefined,
		});

		if (picked) {
			this.setSelection(picked.selection);
			return picked.selection;
		}

		return undefined;
	}

	openSettings(providerId?: string): void {
		// 通用实现：使用 provider 自己的 settingsSearchQuery
		const provider = providerId
			? this._agentOSService.getModelProviders().find(p => p.id === providerId)
			: undefined;
		
		// 如果 provider 定义了 settingsSearchQuery，使用它；否则使用通用搜索关键字
		const searchQuery = provider?.settingsSearchQuery || 'sessions.agentStudio';
		this._commandService.executeCommand('workbench.action.openSettings', searchQuery);
		
		this._logService.info(`[ModelSelector] Opening settings for provider: ${providerId || 'all'} (query: ${searchQuery})`);
	}

	private _autoSelect(): void {
		const currentSelection = this._agentOSService.getActiveModelSelection();
		if (currentSelection) {
			this._currentSelection = currentSelection;
		}
	}

	private _saveSelection(): void {
		if (!this._currentSelection) {
			return;
		}
		try {
			const key = 'agent-studio.model-selection';
			const value = JSON.stringify(this._currentSelection);
			this._storageService.store(key, value, StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (error) {
			this._logService.error('[ModelSelector] Failed to save selection', error);
		}
	}

	private _loadSelection(): void {
		try {
			const key = 'agent-studio.model-selection';
			const value = this._storageService.get(key, StorageScope.APPLICATION);
			if (value) {
				this._currentSelection = JSON.parse(value);
				if (this._currentSelection) {
					this._logService.info(`[ModelSelector] Loaded selection: ${this._currentSelection.providerId}/${this._currentSelection.modelId}`);
				}
			}
		} catch (error) {
			this._logService.error('[ModelSelector] Failed to load selection', error);
		}
	}
}
