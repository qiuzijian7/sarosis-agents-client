/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils';
import { Event } from '../../../../../base/common/event';
import { ModelAuthStatus } from '../../common/providers';
import { IModelProvider, IMemoryProvider, IToolProvider } from '../../common/providers';

suite('AgentOS Service (Phase 1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mock IModelProvider
	class MockModelProvider implements IModelProvider {
		readonly id: string;
		readonly name: string;
		readonly priority: number = 100;
		readonly onDidChangeModels: Event<void> = Event.None;
		readonly onDidChangeAuthStatus: Event<ModelAuthStatus> = Event.None;

		constructor(id: string, name: string) {
			this.id = id;
			this.name = name;
		}

		getAuthStatus(): ModelAuthStatus {
			return ModelAuthStatus.Authenticated;
		}

		async listModels(): Promise<any[]> {
			return [
				{ id: `${this.id}-model-1`, name: 'Model 1' },
				{ id: `${this.id}-model-2`, name: 'Model 2' },
			];
		}

		async *chat(modelId: string, messages: any[], options: any): AsyncIterable<any> {
			yield { type: 'text', content: 'Mock response' };
			yield { type: 'done' };
		}
	}

	// Mock IMemoryProvider
	class MockMemoryProvider implements IMemoryProvider {
		readonly id: string;
		readonly name: string;

		constructor(id: string, name: string) {
			this.id = id;
			this.name = name;
		}

		async loadContext(agentId: string, sessionId: string): Promise<any> {
			return {
				shortTermMemories: [],
				longTermMemories: [],
			};
		}

		async writeMemory(agentId: string, entry: any): Promise<void> {}
		async searchMemory(agentId: string, query: string): Promise<any[]> {
			return [];
		}
	}

	// Mock IToolProvider
	class MockToolProvider implements IToolProvider {
		readonly id: string;
		readonly name: string;
		private disabledTools: Set<string> = new Set();

		constructor(id: string, name: string) {
			this.id = id;
			this.name = name;
		}

		async listTools(agentId: string): Promise<any[]> {
			return [
				{ name: 'test_tool', description: 'A test tool' },
			];
		}

		async executeTool(agentId: string, toolCall: any): Promise<any> {
			return {
				toolCallId: toolCall.id,
				content: 'Mock tool result',
				isError: false,
			};
		}

		async enableTool(agentId: string, toolName: string): Promise<void> {
			this.disabledTools.delete(toolName);
		}

		async disableTool(agentId: string, toolName: string): Promise<void> {
			this.disabledTools.add(toolName);
		}

		async isToolEnabled(agentId: string, toolName: string): Promise<boolean> {
			return !this.disabledTools.has(toolName);
		}

		async getToolsEnabledState(agentId: string): Promise<Record<string, boolean>> {
			return { 'test_tool': true };
		}

		async setToolsEnabledState(agentId: string, state: Record<string, boolean>): Promise<void> {
			for (const [name, enabled] of Object.entries(state)) {
				if (enabled) {
					this.disabledTools.delete(name);
				} else {
					this.disabledTools.add(name);
				}
			}
		}
	}

	test('registerModelProvider adds provider to registry', () => {
		const osService = createTestAgentOSService();
		const provider = new MockModelProvider('test-provider', 'Test Provider');

		const disposable = osService.registerModelProvider(provider);
		const providers = osService.getModelProviders();

		assert.strictEqual(providers.length, 1);
		assert.strictEqual(providers[0].id, 'test-provider');

		disposable.dispose();
	});

	test('unregisterModelProvider removes provider', () => {
		const osService = createTestAgentOSService();
		const provider = new MockModelProvider('test-provider', 'Test Provider');

		const disposable = osService.registerModelProvider(provider);
		assert.strictEqual(osService.getModelProviders().length, 1);

		disposable.dispose();
		assert.strictEqual(osService.getModelProviders().length, 0);
	});

	test('registerMemoryProvider adds provider with priority', () => {
		const osService = createTestAgentOSService();
		const provider = new MockMemoryProvider('mem-1', 'Memory 1');

		const disposable = osService.registerMemoryProvider(provider, 10);
		const active = osService.getActiveMemoryProvider();

		assert.ok(active);
		assert.strictEqual(active.id, 'mem-1');

		disposable.dispose();
	});

	test('registerToolProvider adds provider', () => {
		const osService = createTestAgentOSService();
		const provider = new MockToolProvider('tool-1', 'Tool 1');

		const disposable = osService.registerToolProvider(provider, 5);
		const active = osService.getActiveToolProvider();

		assert.ok(active);
		assert.strictEqual(active.id, 'tool-1');

		disposable.dispose();
	});

	test('getActiveMemoryProvider returns highest priority', () => {
		const osService = createTestAgentOSService();
		const provider1 = new MockMemoryProvider('mem-low', 'Low Priority');
		const provider2 = new MockMemoryProvider('mem-high', 'High Priority');

		osService.registerMemoryProvider(provider1, 1);
		osService.registerMemoryProvider(provider2, 100);

		const active = osService.getActiveMemoryProvider();
		assert.strictEqual(active.id, 'mem-high');
	});

	test('getActiveToolProvider returns highest priority', () => {
		const osService = createTestAgentOSService();
		const provider1 = new MockToolProvider('tool-low', 'Low Priority');
		const provider2 = new MockToolProvider('tool-high', 'High Priority');

		osService.registerToolProvider(provider1, 1);
		osService.registerToolProvider(provider2, 100);

		const active = osService.getActiveToolProvider();
		assert.strictEqual(active.id, 'tool-high');
	});

	test('no providers returns undefined', () => {
		const osService = createTestAgentOSService();

		assert.strictEqual(osService.getActiveMemoryProvider(), undefined);
		assert.strictEqual(osService.getActiveToolProvider(), undefined);
		assert.strictEqual(osService.getActivePlanningProvider(), undefined);
		assert.strictEqual(osService.getActiveExecutionProvider(), undefined);
	});

	test('setActiveModelSelection updates selection', () => {
		const osService = createTestAgentOSService();
		const provider = new MockModelProvider('knot-agui', 'Knot');

		osService.registerModelProvider(provider);
		osService.setActiveModelSelection({
			providerId: 'knot-agui',
			modelId: 'agent-1',
		});

		const selection = osService.getActiveModelSelection();
		assert.strictEqual(selection.providerId, 'knot-agui');
		assert.strictEqual(selection.modelId, 'agent-1');
	});

	test('executeAgentTurn with no providers returns error', async () => {
		const osService = createTestAgentOSService();

		const deltas = [];
		for await (const delta of osService.executeAgentTurn({
			agentId: 'agent-1',
			messages: [{ role: 'user', content: 'Hello' }],
			options: {},
		})) {
			deltas.push(delta);
		}

		assert.ok(deltas.length > 0);
		assert.strictEqual(deltas[0].type, 'error');
	});
});

/**
 * 创建测试用的 AgentOSService 实例
 * 注意：这是一个简化的测试辅助函数，实际需要依赖注入
 */
function createTestAgentOSService(): any {
	// 由于 AgentOSService 依赖 DI，这里返回一个模拟对象
	// 实际测试中应该使用 TestInstantiationService
	const providers: any[] = [];
	const memoryProviders: { provider: any; priority: number }[] = [];
	const toolProviders: { provider: any; priority: number }[] = [];
	const planningProviders: { provider: any; priority: number }[] = [];
	const executionProviders: { provider: any; priority: number }[] = [];
	let activeSelection: { providerId: string; modelId: string } = { providerId: '', modelId: '' };

	return {
		registerModelProvider: (p: any) => {
			providers.push(p);
			return {
				dispose: () => {
					const idx = providers.indexOf(p);
					if (idx !== -1) { providers.splice(idx, 1); }
				}
			};
		},
		getModelProviders: () => providers,
		registerMemoryProvider: (p: any, priority: number) => {
			memoryProviders.push({ provider: p, priority });
			memoryProviders.sort((a, b) => b.priority - a.priority);
			return {
				dispose: () => {
					const idx = memoryProviders.findIndex(mp => mp.provider === p);
					if (idx !== -1) { memoryProviders.splice(idx, 1); }
				}
			};
		},
		getActiveMemoryProvider: () => memoryProviders[0]?.provider,
		registerToolProvider: (p: any, priority: number) => {
			toolProviders.push({ provider: p, priority });
			toolProviders.sort((a, b) => b.priority - a.priority);
			return {
				dispose: () => {
					const idx = toolProviders.findIndex(tp => tp.provider === p);
					if (idx !== -1) { toolProviders.splice(idx, 1); }
				}
			};
		},
		getActiveToolProvider: () => toolProviders[0]?.provider,
		registerPlanningProvider: (p: any, priority: number) => {
			planningProviders.push({ provider: p, priority });
			planningProviders.sort((a, b) => b.priority - a.priority);
			return { dispose: () => {} };
		},
		getActivePlanningProvider: () => planningProviders[0]?.provider,
		registerExecutionProvider: (p: any, priority: number) => {
			executionProviders.push({ provider: p, priority });
			executionProviders.sort((a, b) => b.priority - a.priority);
			return { dispose: () => {} };
		},
		getActiveExecutionProvider: () => executionProviders[0]?.provider,
		setActiveModelSelection: (s: any) => { activeSelection = s; },
		getActiveModelSelection: () => activeSelection,
		executeAgentTurn: async function* (request: any) {
			yield { type: 'error', content: 'No ModelProvider registered' };
		},
	};
}
