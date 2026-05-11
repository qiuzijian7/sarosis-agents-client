/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IModelSelectorService, IModelSelectorItem, IModelSelectorProviderInfo } from '../common/modelSelector.js';
import { IModelSelection } from '../common/providers.js';
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

	private readonly _agentOSService: IAgentOSService;
	private readonly _storageService: IStorageService;
	private readonly _logService: ILogService;
	private readonly _quickInputService: IQuickInputService;
	private readonly _commandService: ICommandService;
	private _currentSelection: IModelSelection | undefined;
	private _cachedModelItems: IModelSelectorItem[] = [];
	private _modelCacheValid = false;

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

		// 监听 Model Provider 变化
		this._register(this._agentOSService.onDidChangeModelProviders(() => {
			this._modelCacheValid = false;
			this._onDidChangeAvailableModels.fire();
		}));

		// 从存储中恢复选择
		this._loadSelection();
	}

	getSelection(): IModelSelection | undefined {
		if (!this._currentSelection) {
			// 尝试自动选择
			this._autoSelect();
		}
		return this._currentSelection;
	}

	setSelection(s: IModelSelection): void {
		this._currentSelection = s;
		this._saveSelection();
		this._onDidChangeSelection.fire(s);
		this._agentOSService.setActiveModelSelection(s);
		this._logService.info(`[ModelSelector] Selection changed: ${s.providerId}/${s.modelId}`);
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
		if (providerId === 'knot-agui' || !providerId) {
			this._commandService.executeCommand('workbench.action.openSettings', 'sessions.agentStudio.knot');
		} else {
			this._commandService.executeCommand('workbench.action.openSettings', 'sessions.agentStudio');
		}
		this._logService.info(`[ModelSelector] Opening settings for provider: ${providerId || 'all'}`);
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
