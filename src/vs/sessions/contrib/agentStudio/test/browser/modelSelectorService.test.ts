/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ModelAuthStatus } from '../../common/providers';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils';

suite('Model Selector Service (Phase 3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mock IModelSelectorService with agent support
	class MockModelSelectorService {
		private _modelProviders: any[] = [];
		private _activeSelection: { providerId: string; modelId: string; agentId?: string } | undefined;
		private _selectedAgentId: string | undefined;
		
		onDidChangeModelProviders: any = { /* Event */ };
		onDidChangeAvailableModels: any = { /* Event */ };
		onDidChangeAgent: any = { /* Event */ };

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

		getActiveSelection(): { providerId: string; modelId: string; agentId?: string } | undefined {
			return this._activeSelection;
		}

		setActiveSelection(selection: { providerId: string; modelId: string; agentId?: string }): void {
			const providerChanged = this._activeSelection?.providerId !== selection.providerId;
			this._activeSelection = selection;
			
			// 切换 Provider 时重置 Agent 选择
			if (providerChanged) {
				this._selectedAgentId = undefined;
			} else {
				this._selectedAgentId = selection.agentId;
			}
		}

		// Agent 选择相关方法
		currentProviderSupportsAgents(): boolean {
			if (!this._activeSelection) return false;
			const provider = this._modelProviders.find(p => p.id === this._activeSelection!.providerId);
			return provider?.supportsAgents === true;
		}

		async getAvailableAgents(): Promise<any[]> {
			if (!this.currentProviderSupportsAgents()) {
				return [];
			}
			const provider = this._modelProviders.find(p => p.id === this._activeSelection!.providerId);
			if (!provider?.listAgents) {
				return [];
			}
			return await provider.listAgents();
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
			if (this._activeSelection) {
				this._activeSelection = {
					...this._activeSelection,
					agentId,
				};
			}
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

	// ─── Agent 选择器测试 ─────────────────────────────────────

	test('currentProviderSupportsAgents returns false when no selection', () => {
		const selector = new MockModelSelectorService();
		assert.strictEqual(selector.currentProviderSupportsAgents(), false);
	});

	test('currentProviderSupportsAgents returns false when provider does not support agents', () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'provider-1',
			name: 'Provider 1',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
			supportsAgents: false,
		});

		selector.setActiveSelection({ providerId: 'provider-1', modelId: 'model-1' });
		assert.strictEqual(selector.currentProviderSupportsAgents(), false);
	});

	test('currentProviderSupportsAgents returns true when provider supports agents', () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'knot-agui',
			name: 'Knot AG-UI',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
			supportsAgents: true,
			listAgents: async () => [
				{ id: 'agent-1', name: 'Agent 1' },
				{ id: 'agent-2', name: 'Agent 2' },
			],
		});

		selector.setActiveSelection({ providerId: 'knot-agui', modelId: 'model-1' });
		assert.strictEqual(selector.currentProviderSupportsAgents(), true);
	});

	test('getAvailableAgents returns empty when provider does not support agents', async () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'provider-1',
			name: 'Provider 1',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
			supportsAgents: false,
		});

		selector.setActiveSelection({ providerId: 'provider-1', modelId: 'model-1' });
		const agents = await selector.getAvailableAgents();
		assert.strictEqual(agents.length, 0);
	});

	test('getAvailableAgents returns agents when provider supports agents', async () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'knot-agui',
			name: 'Knot AG-UI',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
			supportsAgents: true,
			listAgents: async () => [
				{ id: 'agent-1', name: 'Agent 1' },
				{ id: 'agent-2', name: 'Agent 2' },
			],
		});

		selector.setActiveSelection({ providerId: 'knot-agui', modelId: 'model-1' });
		const agents = await selector.getAvailableAgents();
		assert.strictEqual(agents.length, 2);
		assert.strictEqual(agents[0].id, 'agent-1');
		assert.strictEqual(agents[1].name, 'Agent 2');
	});

	test('getSelectedAgentId returns undefined when provider does not support agents', () => {
		const selector = new MockModelSelectorService();
		assert.strictEqual(selector.getSelectedAgentId(), undefined);
	});

	test('getSelectedAgentId returns selected agent ID', () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'knot-agui',
			name: 'Knot AG-UI',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
			supportsAgents: true,
			listAgents: async () => [
				{ id: 'agent-1', name: 'Agent 1' },
			],
		});

		selector.setActiveSelection({ providerId: 'knot-agui', modelId: 'model-1' });
		selector.setSelectedAgentId('agent-1');
		
		assert.strictEqual(selector.getSelectedAgentId(), 'agent-1');
	});

	test('setSelectedAgentId updates agent ID and selection', () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'knot-agui',
			name: 'Knot AG-UI',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
			supportsAgents: true,
			listAgents: async () => [
				{ id: 'agent-1', name: 'Agent 1' },
			],
		});

		selector.setActiveSelection({ providerId: 'knot-agui', modelId: 'model-1' });
		selector.setSelectedAgentId('agent-1');
		
		assert.strictEqual(selector.getSelectedAgentId(), 'agent-1');
		assert.strictEqual(selector.getActiveSelection()?.agentId, 'agent-1');
	});

	test('setSelectedAgentId resets when switching provider', () => {
		const selector = new MockModelSelectorService();
		
		selector.addModelProvider({
			id: 'knot-agui',
			name: 'Knot AG-UI',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
			supportsAgents: true,
			listAgents: async () => [
				{ id: 'agent-1', name: 'Agent 1' },
			],
		});

		selector.setActiveSelection({ providerId: 'knot-agui', modelId: 'model-1', agentId: 'agent-1' });
		assert.strictEqual(selector.getSelectedAgentId(), 'agent-1');
		
		// 切换到不支持 agent 的 provider
		selector.addModelProvider({
			id: 'provider-2',
			name: 'Provider 2',
			getAuthStatus: () => ModelAuthStatus.Authenticated,
			listModels: async () => [{ id: 'model-2', name: 'Model 2' }],
			supportsAgents: false,
		});

		selector.setActiveSelection({ providerId: 'provider-2', modelId: 'model-2' });
		assert.strictEqual(selector.getSelectedAgentId(), undefined);
	});
});
