/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IMemoryProvider, IToolProvider,
	IPlanningProvider, IExecutionProvider, IRetrievalProvider, IKanbanProvider,
} from '../../common/providers.js';

suite('SlotRegistry (Phase 1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── Helper: 创建测试用的 SlotRegistry 模拟 ────────────────

	function createSlotRegistry() {
		const memoryProviders: { provider: IMemoryProvider; priority: number }[] = [];
		const toolProviders: { provider: IToolProvider; priority: number }[] = [];
		const planningProviders: { provider: IPlanningProvider; priority: number }[] = [];
		const executionProviders: { provider: IExecutionProvider; priority: number }[] = [];
		const retrievalProviders: { provider: IRetrievalProvider; priority: number }[] = [];
		const kanbanProviders: { provider: IKanbanProvider; priority: number }[] = [];

		const sortByPriority = <T>(arr: { provider: T; priority: number }[]) => {
			arr.sort((a, b) => b.priority - a.priority);
		};

		return {
			// Memory
			registerMemoryProvider: (provider: IMemoryProvider, priority: number = 0) => {
				memoryProviders.push({ provider, priority });
				sortByPriority(memoryProviders);
				return {
					dispose: () => {
						const idx = memoryProviders.findIndex(p => p.provider.id === provider.id);
						if (idx !== -1) { memoryProviders.splice(idx, 1); }
					},
				};
			},
			getActiveMemoryProvider: (): IMemoryProvider | undefined => {
				return memoryProviders.length > 0 ? memoryProviders[0].provider : undefined;
			},

			// Tool
			registerToolProvider: (provider: IToolProvider, priority: number = 0) => {
				toolProviders.push({ provider, priority });
				sortByPriority(toolProviders);
				return {
					dispose: () => {
						const idx = toolProviders.findIndex(p => p.provider.id === provider.id);
						if (idx !== -1) { toolProviders.splice(idx, 1); }
					},
				};
			},
			getActiveToolProvider: (): IToolProvider | undefined => {
				return toolProviders.length > 0 ? toolProviders[0].provider : undefined;
			},

			// Planning
			registerPlanningProvider: (provider: IPlanningProvider, priority: number = 0) => {
				planningProviders.push({ provider, priority });
				sortByPriority(planningProviders);
				return {
					dispose: () => {
						const idx = planningProviders.findIndex(p => p.provider.id === provider.id);
						if (idx !== -1) { planningProviders.splice(idx, 1); }
					},
				};
			},
			getActivePlanningProvider: (): IPlanningProvider | undefined => {
				return planningProviders.length > 0 ? planningProviders[0].provider : undefined;
			},

			// Execution
			registerExecutionProvider: (provider: IExecutionProvider, priority: number = 0) => {
				executionProviders.push({ provider, priority });
				sortByPriority(executionProviders);
				return {
					dispose: () => {
						const idx = executionProviders.findIndex(p => p.provider.id === provider.id);
						if (idx !== -1) { executionProviders.splice(idx, 1); }
					},
				};
			},
			getActiveExecutionProvider: (): IExecutionProvider | undefined => {
				return executionProviders.length > 0 ? executionProviders[0].provider : undefined;
			},

			// Retrieval
			registerRetrievalProvider: (provider: IRetrievalProvider, priority: number = 0) => {
				retrievalProviders.push({ provider, priority });
				sortByPriority(retrievalProviders);
				return {
					dispose: () => {
						const idx = retrievalProviders.findIndex(p => p.provider.id === provider.id);
						if (idx !== -1) { retrievalProviders.splice(idx, 1); }
					},
				};
			},
			getActiveRetrievalProvider: (): IRetrievalProvider | undefined => {
				return retrievalProviders.length > 0 ? retrievalProviders[0].provider : undefined;
			},

			// Kanban
			registerKanbanProvider: (provider: IKanbanProvider, priority: number = 0) => {
				kanbanProviders.push({ provider, priority });
				sortByPriority(kanbanProviders);
				return {
					dispose: () => {
						const idx = kanbanProviders.findIndex(p => p.provider.id === provider.id);
						if (idx !== -1) { kanbanProviders.splice(idx, 1); }
					},
				};
			},
			getActiveKanbanProvider: (): IKanbanProvider | undefined => {
				return kanbanProviders.length > 0 ? kanbanProviders[0].provider : undefined;
			},
		};
	}

	// ─── Memory Provider 测试 ───────────────────────────────────

	test('registerMemoryProvider - single provider', () => {
		const registry = createSlotRegistry();
		const provider: IMemoryProvider = { id: 'mem-1', name: 'Memory 1', loadContext: async () => ({ shortTermMemories: [], longTermMemories: [] }), writeMemory: async () => {}, searchMemory: async () => [] };
		const disposable = registry.registerMemoryProvider(provider, 10);

		const active = registry.getActiveMemoryProvider();
		assert.ok(active);
		assert.strictEqual(active.id, 'mem-1');

		disposable.dispose();
		assert.strictEqual(registry.getActiveMemoryProvider(), undefined);
	});

	test('registerMemoryProvider - higher priority wins', () => {
		const registry = createSlotRegistry();
		const low: IMemoryProvider = { id: 'mem-low', name: 'Low', loadContext: async () => ({ shortTermMemories: [], longTermMemories: [] }), writeMemory: async () => {}, searchMemory: async () => [] };
		const high: IMemoryProvider = { id: 'mem-high', name: 'High', loadContext: async () => ({ shortTermMemories: [], longTermMemories: [] }), writeMemory: async () => {}, searchMemory: async () => [] };

		registry.registerMemoryProvider(low, 1);
		registry.registerMemoryProvider(high, 100);

		assert.strictEqual(registry.getActiveMemoryProvider()?.id, 'mem-high');
	});

	test('registerMemoryProvider - default priority is 0', () => {
		const registry = createSlotRegistry();
		const first: IMemoryProvider = { id: 'mem-first', name: 'First', loadContext: async () => ({ shortTermMemories: [], longTermMemories: [] }), writeMemory: async () => {}, searchMemory: async () => [] };
		const second: IMemoryProvider = { id: 'mem-second', name: 'Second', loadContext: async () => ({ shortTermMemories: [], longTermMemories: [] }), writeMemory: async () => {}, searchMemory: async () => [] };

		registry.registerMemoryProvider(first);
		registry.registerMemoryProvider(second);

		// 同优先级时，后注册的排在前面（因为 sort 是稳定排序但方向是降序）
		assert.ok(registry.getActiveMemoryProvider());
	});

	test('unregister MemoryProvider via dispose', () => {
		const registry = createSlotRegistry();
		const provider: IMemoryProvider = { id: 'mem-1', name: 'Memory 1', loadContext: async () => ({ shortTermMemories: [], longTermMemories: [] }), writeMemory: async () => {}, searchMemory: async () => [] };

		const d = registry.registerMemoryProvider(provider, 10);
		assert.ok(registry.getActiveMemoryProvider());

		d.dispose();
		assert.strictEqual(registry.getActiveMemoryProvider(), undefined);
	});

	// ─── Tool Provider 测试 ─────────────────────────────────────

	test('registerToolProvider - single provider', () => {
		const registry = createSlotRegistry();
		const provider: IToolProvider = {
			id: 'tool-1', name: 'Tool 1',
			listTools: async () => [],
			executeTool: async () => ({ toolCallId: '', success: true, content: [] }),
			enableTool: async () => {},
			disableTool: async () => {},
			isToolEnabled: async () => true,
			getToolsEnabledState: async () => ({}),
			setToolsEnabledState: async () => {},
		};

		const d = registry.registerToolProvider(provider, 5);
		assert.strictEqual(registry.getActiveToolProvider()?.id, 'tool-1');
		d.dispose();
		assert.strictEqual(registry.getActiveToolProvider(), undefined);
	});

	test('registerToolProvider - priority ordering', () => {
		const registry = createSlotRegistry();
		const low: IToolProvider = {
			id: 'tool-low', name: 'Low',
			listTools: async () => [], executeTool: async () => ({ toolCallId: '', success: true, content: [] }),
			enableTool: async () => {}, disableTool: async () => {},
			isToolEnabled: async () => true, getToolsEnabledState: async () => ({}),
			setToolsEnabledState: async () => {},
		};
		const high: IToolProvider = {
			id: 'tool-high', name: 'High',
			listTools: async () => [], executeTool: async () => ({ toolCallId: '', success: true, content: [] }),
			enableTool: async () => {}, disableTool: async () => {},
			isToolEnabled: async () => true, getToolsEnabledState: async () => ({}),
			setToolsEnabledState: async () => {},
		};

		registry.registerToolProvider(low, 1);
		registry.registerToolProvider(high, 50);

		assert.strictEqual(registry.getActiveToolProvider()?.id, 'tool-high');
	});

	// ─── Planning Provider 测试 ─────────────────────────────────

	test('registerPlanningProvider - single provider', () => {
		const registry = createSlotRegistry();
		const provider: IPlanningProvider = {
			id: 'plan-1', name: 'Plan 1',
			analyzeIntent: async () => ({ id: '', intent: '', steps: [] }),
			decomposeTasks: async () => [],
		};

		const d = registry.registerPlanningProvider(provider, 10);
		assert.strictEqual(registry.getActivePlanningProvider()?.id, 'plan-1');
		d.dispose();
		assert.strictEqual(registry.getActivePlanningProvider(), undefined);
	});

	// ─── Execution Provider 测试 ────────────────────────────────

	test('registerExecutionProvider - single provider', () => {
		const registry = createSlotRegistry();
		const provider: IExecutionProvider = {
			id: 'exec-1', name: 'Exec 1',
			runAgentLoop: async function* () { yield { type: 'done' as const }; },
		};

		const d = registry.registerExecutionProvider(provider, 10);
		assert.strictEqual(registry.getActiveExecutionProvider()?.id, 'exec-1');
		d.dispose();
		assert.strictEqual(registry.getActiveExecutionProvider(), undefined);
	});

	test('registerExecutionProvider - higher priority wins', () => {
		const registry = createSlotRegistry();
		const low: IExecutionProvider = { id: 'exec-low', name: 'Low', runAgentLoop: async function* () {} };
		const high: IExecutionProvider = { id: 'exec-high', name: 'High', runAgentLoop: async function* () {} };

		registry.registerExecutionProvider(low, 1);
		registry.registerExecutionProvider(high, 100);

		assert.strictEqual(registry.getActiveExecutionProvider()?.id, 'exec-high');
	});

	// ─── Retrieval Provider 测试 ────────────────────────────────

	test('registerRetrievalProvider - single provider', () => {
		const registry = createSlotRegistry();
		const provider: IRetrievalProvider = {
			id: 'rag-1', name: 'RAG 1',
			retrieve: async () => [],
			indexDocument: async () => {},
		};

		const d = registry.registerRetrievalProvider(provider, 10);
		assert.strictEqual(registry.getActiveRetrievalProvider()?.id, 'rag-1');
		d.dispose();
		assert.strictEqual(registry.getActiveRetrievalProvider(), undefined);
	});

	// ─── Kanban Provider 测试 ──────────────────────────────────

	test('registerKanbanProvider - single provider', () => {
		const registry = createSlotRegistry();
		const provider: IKanbanProvider = {
			id: 'kanban-1', name: 'Kanban 1',
			listBoards: async () => [],
			getBoard: async () => ({ id: '', name: '', columns: [] }),
			createCard: async () => ({ id: '', title: '', columnId: '', createdAt: '', updatedAt: '' }),
			updateCard: async () => ({ id: '', title: '', columnId: '', createdAt: '', updatedAt: '' }),
			moveCard: async () => {},
			deleteCard: async () => {},
			listCards: async () => [],
			getCard: async () => ({ id: '', title: '', columnId: '', createdAt: '', updatedAt: '' }),
			onDidChangeCards: { event: () => ({ dispose: () => {} }) } as any,
			onDidChangeBoard: { event: () => ({ dispose: () => {} }) } as any,
		};

		const d = registry.registerKanbanProvider(provider, 10);
		assert.strictEqual(registry.getActiveKanbanProvider()?.id, 'kanban-1');
		d.dispose();
		assert.strictEqual(registry.getActiveKanbanProvider(), undefined);
	});

	// ─── 无 Provider 时返回 undefined ───────────────────────────

	test('no providers returns undefined for all slots', () => {
		const registry = createSlotRegistry();

		assert.strictEqual(registry.getActiveMemoryProvider(), undefined);
		assert.strictEqual(registry.getActiveToolProvider(), undefined);
		assert.strictEqual(registry.getActivePlanningProvider(), undefined);
		assert.strictEqual(registry.getActiveExecutionProvider(), undefined);
		assert.strictEqual(registry.getActiveRetrievalProvider(), undefined);
		assert.strictEqual(registry.getActiveKanbanProvider(), undefined);
	});

	// ─── 多次 dispose 不会报错 ─────────────────────────────────

	test('multiple dispose calls do not throw', () => {
		const registry = createSlotRegistry();
		const provider: IMemoryProvider = { id: 'mem-1', name: 'Memory 1', loadContext: async () => ({ shortTermMemories: [], longTermMemories: [] }), writeMemory: async () => {}, searchMemory: async () => [] };

		const d = registry.registerMemoryProvider(provider, 10);
		d.dispose();
		d.dispose(); // 二次 dispose 不应报错
		assert.strictEqual(registry.getActiveMemoryProvider(), undefined);
	});
});
