/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IModelSelectorService, IModelSelectorItem, IModelSelectorProviderInfo } from '../common/modelSelector.js';
import { IModelSelection, ModelAuthStatus } from '../common/providers.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export class ModelSelectorService extends Disposable implements IModelSelectorService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSelection = this._register(new Emitter<IModelSelection>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private readonly _onDidChangeAvailableModels = this._register(new Emitter<void>());
	readonly onDidChangeAvailableModels = this._onDidChangeAvailableModels.event;

	private _agentOSService: IAgentOSService | undefined;
	private _storageService: IStorageService | undefined;
	private _logService: ILogService | undefined;
	private _currentSelection: IModelSelection | undefined;

	constructor() {
		super();
		// 延迟注入依赖
	}

	setAgentOSService(osService: IAgentOSService): void {
		this._agentOSService = osService;
		// 监听 Model Provider 变化
		this._register(this._agentOSService.onDidChangeModelProviders(() => {
			this._onDidChangeAvailableModels.fire();
		}));
	}

	setStorageService(storageService: IStorageService): void {
		this._storageService = storageService;
		// 从存储中恢复选择
		this._loadSelection();
	}

	setLogService(logService: ILogService): void {
		this._logService = logService;
	}

	getSelection(): IModelSelection | undefined {
		if (!this._currentSelection && this._agentOSService) {
			// 尝试自动选择
			this._autoSelect();
		}
		return this._currentSelection;
	}

	setSelection(s: IModelSelection): void {
		this._currentSelection = s;
		this._saveSelection();
		this._onDidChangeSelection.fire(s);
		this._logService?.info(`[ModelSelector] Selection changed: ${s.providerId}/${s.modelId}`);
	}

	getAvailableModels(): IModelSelectorItem[] {
		if (!this._agentOSService) {
			return [];
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

			// 同步获取模型列表（简化版）
			// 注意：实际应用中应该使用 async/await，但接口是同步的
			// 这里我们先返回空数组，然后在后台加载
			provider.listModels().then(models => {
				// 模型加载完成后触发事件
				this._onDidChangeAvailableModels.fire();
			}).catch(error => {
				this._logService?.error(`[ModelSelector] Failed to list models for ${provider.id}`, error);
			});

			// 暂时返回 providerInfo，模型信息将在异步加载后更新
			items.push({
				provider: providerInfo,
				model: { id: 'loading', name: 'Loading...' },
			});
		}

		return items;
	}

	async showQuickPick(): Promise<IModelSelection | undefined> {
		// TODO: 实现真正的 QuickPick UI
		// 当前返回第一个可用的模型
		const models = this.getAvailableModels();
		if (models.length > 0) {
			const first = models[0];
			return {
				providerId: first.provider.id,
				modelId: first.model.id,
			};
		}
		return undefined;
	}

	openSettings(providerId?: string): void {
		// TODO: 打开设置页面
		this._logService?.info(`[ModelSelector] Opening settings for provider: ${providerId || 'all'}`);
	}

	private _autoSelect(): void {
		if (!this._agentOSService) {
			return;
		}

		const providers = this._agentOSService.getModelProviders();
		const authenticated = providers.filter(p => p.getAuthStatus() === ModelAuthStatus.Authenticated);

		if (authenticated.length > 0) {
			// 选择第一个已认证的 provider 的第一个模型
			authenticated[0].listModels().then(models => {
				if (models.length > 0) {
					this.setSelection({
						providerId: authenticated[0].id,
						modelId: models[0].id,
					});
				}
			});
		}
	}

	private _saveSelection(): void {
		if (!this._storageService || !this._currentSelection) {
			return;
		}
		try {
			const key = 'agent-studio.model-selection';
			const value = JSON.stringify(this._currentSelection);
			this._storageService.store(key, value, StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (error) {
			this._logService?.error('[ModelSelector] Failed to save selection', error);
		}
	}

	private _loadSelection(): void {
		if (!this._storageService) {
			return;
		}
		try {
			const key = 'agent-studio.model-selection';
			const value = this._storageService.get(key, StorageScope.APPLICATION);
			if (value) {
				this._currentSelection = JSON.parse(value);
				if (this._currentSelection) {
					this._logService?.info(`[ModelSelector] Loaded selection: ${this._currentSelection.providerId}/${this._currentSelection.modelId}`);
				}
			}
		} catch (error) {
			this._logService?.error('[ModelSelector] Failed to load selection', error);
		}
	}
}
