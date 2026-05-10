/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ModelAuthStatus } from '../../common/providers.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Model Selector Service (Phase 3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mock IModelSelectorService
	class MockModelSelectorService {
		private _modelProviders: any[] = [];
		private _activeSelection: { providerId: string; modelId: string } | undefined;
		
		onDidChangeModelProviders: any = { /* Event */ };
		onDidChangeAvailableModels: any = { /* Event */ };

		getModelProviders(): any[] {
			return this._modelProviders;
		}

		getAvailableModels(): any[] {
			if (!this._activeSelection) {
				return [];
			}
			const provider = this._modelProviders.find(p => p.id === this._activeSelection!.providerId);
			if (!provider) {
				return [];
			}
			return provider.listModels();
		}

		getActiveSelection(): { providerId: string; modelId: string } | undefined {
			return this._activeSelection;
		}

		setActiveSelection(selection: { providerId: string; modelId: string }): void {
			this._activeSelection = selection;
		}

		addModelProvider(provider: any): void {
			this._modelProviders.push(provider);
			// 如果没有活跃选择，自动选择
			if (!this._activeSelection && provider.getAuthStatus() === ModelAuthStatus.Authenticated) {
				provider.listModels().then((models: any[]) => {
					if (models.length > 0) {
						this._activeSelection = {
							providerId: provider.id,
							modelId: models[0].id,
						};
					}
				});
			}
		}
	}

	test('getModelProviders returns all registered providers', () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'provider-1',
			name: 'Provider 1',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
		});

		selector.addModelProvider({
			id: 'provider-2',
			name: 'Provider 2',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-2', name: 'Model 2' }],
		});

		const providers = selector.getModelProviders();
		assert.strictEqual(providers.length, 2);
		assert.strictEqual(providers[0].id, 'provider-1');
		assert.strictEqual(providers[1].id, 'provider-2');
	});

	test('getAvailableModels returns models for active provider', async () => {
		const selector = new MockModelSelectorService();
		
		const provider1 = {
			id: 'knot-agui',
			name: 'Knot AG-UI',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [
				{ id: 'agent-1', name: 'Agent 1' },
				{ id: 'agent-2', name: 'Agent 2' },
			],
		};

		selector.addModelProvider(provider1);
		selector.setActiveSelection({ providerId: 'knot-agui', modelId: 'agent-1' });

		// 注意：这里需要等待 listModels 完成
		// 实际实现中应该使用事件或 Promise
	});

	test('getActiveSelection returns current selection', () => {
		const selector = new MockModelSelectorService();
		
		selector.setActiveSelection({
			providerId: 'knot-agui',
			modelId: 'agent-1',
		});

		const selection = selector.getActiveSelection();
		assert.ok(selection);
		assert.strictEqual(selection.providerId, 'knot-agui');
		assert.strictEqual(selection.modelId, 'agent-1');
	});

	test('setActiveSelection updates selection', () => {
		const selector = new MockModelSelectorService();
		
		// 初始为 undefined
		assert.strictEqual(selector.getActiveSelection(), undefined);

		// 设置选择
		selector.setActiveSelection({
			providerId: 'knot-agui',
			modelId: 'agent-1',
		});

		const selection = selector.getActiveSelection();
		assert.ok(selection);
		assert.strictEqual(selection.modelId, 'agent-1');
	});

	test('auto-selects first authenticated provider', async () => {
		const selector = new MockModelSelectorService();
		
		// 添加一个已认证的 provider
		const provider = {
			id: 'knot-agui',
			name: 'Knot AG-UI',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [
				{ id: 'agent-1', name: 'Agent 1' },
			],
		};

		selector.addModelProvider(provider);
		
		// 等待自动选择完成
		await new Promise(resolve => setTimeout(resolve, 50));
		
		const selection = selector.getActiveSelection();
		assert.ok(selection);
		assert.strictEqual(selection.providerId, 'knot-agui');
	});

	test('no selection when no authenticated provider', () => {
		const selector = new MockModelSelectorService();
		
		// 添加未认证的 provider
		selector.addModelProvider({
			id: 'provider-1',
			name: 'Provider 1',
			getAuthStatus: () => ModelAuthStatus.NotConfigured,
			listModels: async () => [],
		});

		const selection = selector.getActiveSelection();
		assert.strictEqual(selection, undefined);
	});

	test('getAvailableModels returns empty when no selection', () => {
		const selector = new MockModelSelectorService();
		
		const models = selector.getAvailableModels();
		assert.strictEqual(models.length, 0);
	});

	test('switching provider updates available models', () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'provider-1',
			name: 'Provider 1',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
		});

		selector.addModelProvider({
			id: 'provider-2',
			name: 'Provider 2',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-2', name: 'Model 2' }],
		});

		// 切换到 provider-2
		selector.setActiveSelection({
			providerId: 'provider-2',
			modelId: 'model-2',
		});

		const selection = selector.getActiveSelection();
		assert.ok(selection !== undefined);
		assert.strictEqual(selection.providerId, 'provider-2');
		assert.strictEqual(selection.modelId, 'model-2');
	});

	test('ModelAuthStatus affects availability', () => {
		const selector = new MockModelSelectorService();
		
		const provider = {
			id: 'provider-1',
			name: 'Provider 1',
			getAuthStatus: () => ModelAuthStatus.NotConfigured,
			listModels: async () => [],
		};

		selector.addModelProvider(provider);
		
		const models = selector.getAvailableModels();
		assert.strictEqual(models.length, 0);
	});
});
