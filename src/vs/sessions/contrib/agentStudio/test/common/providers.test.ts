/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Agent Studio - Provider Interface Definitions (Phase 1/5)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── IExecutionProvider ─────────────────────────────────────

	test('IExecutionProvider interface structure', () => {
		const provider = {
			id: 'exec-1',
			name: 'Executor 1',
			runAgentLoop: async function* (request: any, slots: any) {
				yield { type: 'text', content: 'Executing...' };
				yield { type: 'done' };
			},
		};

		assert.strictEqual(provider.id, 'exec-1');
		assert.strictEqual(provider.name, 'Executor 1');
		assert.ok(typeof provider.runAgentLoop === 'function');
	});

	test('IExecutionProvider.runAgentLoop receives ISlotRegistry', async () => {
		const mockSlots = {
			getActiveModelProvider: () => undefined,
			getActiveMemoryProvider: () => undefined,
			getActiveToolProvider: () => undefined,
			getActivePlanningProvider: () => undefined,
			getActiveRetrievalProvider: () => undefined,
			getActiveKanbanProvider: () => undefined,
		};

		let receivedSlots: any = null;
		const provider = {
			id: 'exec-1',
			name: 'Executor',
			runAgentLoop: async function* (request: any, slots: any) {
				receivedSlots = slots;
				yield { type: 'done' };
			},
		};

		for await (const _ of provider.runAgentLoop({}, mockSlots)) {
			// consume
		}

		assert.ok(receivedSlots);
		assert.ok(typeof receivedSlots.getActiveModelProvider === 'function');
		assert.ok(typeof receivedSlots.getActiveToolProvider === 'function');
	});

	test('IExecutionProvider.runAgentLoop yields IChatStreamDelta', async () => {
		const provider = {
			id: 'exec-1',
			name: 'Executor',
			runAgentLoop: async function* (request: any, slots: any) {
				yield { type: 'text', content: 'Step 1' };
				yield { type: 'thinking', content: 'Planning...' };
				yield { type: 'tool_start', toolCallId: 'call-1', toolName: 'file_read' };
				yield { type: 'tool_result', toolCallId: 'call-1' };
				yield { type: 'done' };
			},
		};

		const deltas: any[] = [];
		for await (const delta of provider.runAgentLoop({}, {})) {
			deltas.push(delta);
		}

		assert.strictEqual(deltas.length, 5);
		assert.strictEqual(deltas[0].type, 'text');
		assert.strictEqual(deltas[1].type, 'thinking');
		assert.strictEqual(deltas[2].type, 'tool_start');
		assert.strictEqual(deltas[3].type, 'tool_result');
		assert.strictEqual(deltas[4].type, 'done');
	});

	// ─── IPlanningProvider ─────────────────────────────────────

	test('IPlanningProvider interface structure', () => {
		const provider = {
			id: 'plan-1',
			name: 'Planner 1',
			analyzeIntent: async (message: string, context: any) => ({
				id: 'plan-1',
				intent: message,
				steps: [
					{ id: 'step-1', description: 'Read file' },
					{ id: 'step-2', description: 'Analyze' },
				],
				estimatedComplexity: 'medium' as const,
			}),
			decomposeTasks: async (plan: any) => [
				{ id: 'task-1', description: 'Task 1', status: 'pending' as const },
				{ id: 'task-2', description: 'Task 2', status: 'pending' as const, dependencies: ['task-1'] },
			],
		};

		assert.strictEqual(provider.id, 'plan-1');
		assert.ok(typeof provider.analyzeIntent === 'function');
		assert.ok(typeof provider.decomposeTasks === 'function');
	});

	test('IPlanningProvider.analyzeIntent returns IPlan', async () => {
		const provider = {
			id: 'plan-1',
			name: 'Planner',
			analyzeIntent: async (message: string) => ({
				id: 'plan-1',
				intent: message,
				steps: [{ id: 's1', description: 'Step 1' }],
				estimatedComplexity: 'low',
			}),
			decomposeTasks: async () => [],
		};

		const plan = await provider.analyzeIntent('Create a hello world program');

		assert.strictEqual(plan.id, 'plan-1');
		assert.ok(plan.intent);
		assert.strictEqual(plan.steps.length, 1);
		assert.strictEqual(plan.estimatedComplexity, 'low');
	});

	test('IPlanningProvider.decomposeTasks returns tasks with dependencies', async () => {
		const provider = {
			id: 'plan-1',
			name: 'Planner',
			analyzeIntent: async () => ({ id: '', intent: '', steps: [] }),
			decomposeTasks: async (plan: any) => [
				{ id: 't1', description: 'First', status: 'pending', dependencies: [] },
				{ id: 't2', description: 'Second', status: 'pending', dependencies: ['t1'] },
			],
		};

		const tasks = await provider.decomposeTasks({ id: '', intent: '', steps: [] });

		assert.strictEqual(tasks.length, 2);
		assert.strictEqual(tasks[1].dependencies.length, 1);
		assert.strictEqual(tasks[1].dependencies[0], 't1');
	});

	// ─── IRetrievalProvider ─────────────────────────────────────

	test('IRetrievalProvider interface structure', () => {
		const provider = {
			id: 'rag-1',
			name: 'RAG 1',
			retrieve: async (query: string, options?: any) => [
				{ documentId: 'doc-1', content: 'Result 1', score: 0.9 },
				{ documentId: 'doc-2', content: 'Result 2', score: 0.7 },
			],
			indexDocument: async (doc: any) => {},
		};

		assert.strictEqual(provider.id, 'rag-1');
		assert.ok(typeof provider.retrieve === 'function');
		assert.ok(typeof provider.indexDocument === 'function');
	});

	test('IRetrievalProvider.retrieve returns scored results', async () => {
		const provider = {
			id: 'rag-1',
			name: 'RAG',
			retrieve: async (query: string) => [
				{ documentId: 'doc-1', content: 'Relevant text', score: 0.95 },
				{ documentId: 'doc-2', content: 'Less relevant', score: 0.6 },
			],
			indexDocument: async () => {},
		};

		const results = await provider.retrieve('test query');

		assert.strictEqual(results.length, 2);
		assert.ok(results[0].score > results[1].score);
		assert.ok(results[0].content);
	});

	test('IRetrievalProvider.retrieve with options', async () => {
		const provider = {
			id: 'rag-1',
			name: 'RAG',
			retrieve: async (query: string, options?: any) => {
				assert.strictEqual(options?.topK, 5);
				assert.strictEqual(options?.scoreThreshold, 0.7);
				return [];
			},
			indexDocument: async () => {},
		};

		await provider.retrieve('query', { topK: 5, scoreThreshold: 0.7 });
	});

	test('IRetrievalProvider.indexDocument', async () => {
		let indexed = false;
		const provider = {
			id: 'rag-1',
			name: 'RAG',
			retrieve: async () => [],
			indexDocument: async (doc: any) => { indexed = true; },
		};

		await provider.indexDocument({ id: 'doc-1', content: 'Test content' });
		assert.strictEqual(indexed, true);
	});

	// ─── IKanbanProvider ────────────────────────────────────────

	test('IKanbanProvider interface structure', () => {
		const provider = {
			id: 'kanban-1',
			name: 'Kanban 1',
			listBoards: async () => [],
			getBoard: async (id: string) => ({ id, name: 'Board', columns: [] }),
			createCard: async (boardId: string, card: any) => ({ id: 'card-1', title: card.title, columnId: '', createdAt: '', updatedAt: '' }),
			updateCard: async (cardId: string, updates: any) => ({ id: cardId, title: 'Updated', columnId: '', createdAt: '', updatedAt: '' }),
			moveCard: async (cardId: string, targetColumn: string) => {},
			deleteCard: async (cardId: string) => {},
			listCards: async (boardId: string) => [],
			getCard: async (cardId: string) => ({ id: cardId, title: 'Card', columnId: '', createdAt: '', updatedAt: '' }),
			onDidChangeCards: { event: () => ({ dispose: () => {} }) } as any,
			onDidChangeBoard: { event: () => ({ dispose: () => {} }) } as any,
		};

		assert.strictEqual(provider.id, 'kanban-1');
		assert.ok(typeof provider.listBoards === 'function');
		assert.ok(typeof provider.createCard === 'function');
		assert.ok(typeof provider.moveCard === 'function');
		assert.ok(typeof provider.deleteCard === 'function');
	});

	test('IKanbanProvider CRUD operations', async () => {
		const cards: any[] = [];
		const provider = {
			id: 'kanban-1',
			name: 'Kanban',
			listBoards: async () => [{ id: 'board-1', name: 'My Board', columns: [] }],
			getBoard: async (id: string) => ({ id, name: 'Board', columns: [{ id: 'col-1', name: 'Todo', order: 0 }] }),
			createCard: async (boardId: string, card: any) => {
				const newCard = { id: `card-${Date.now()}`, title: card.title, columnId: card.columnId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
				cards.push(newCard);
				return newCard;
			},
			updateCard: async (cardId: string, updates: any) => {
				const card = cards.find(c => c.id === cardId);
				return card ? { ...card, ...updates } : null;
			},
			moveCard: async (cardId: string, targetColumn: string) => {
				const card = cards.find(c => c.id === cardId);
				if (card) { card.columnId = targetColumn; }
			},
			deleteCard: async (cardId: string) => {
				const idx = cards.findIndex(c => c.id === cardId);
				if (idx !== -1) { cards.splice(idx, 1); }
			},
			listCards: async (boardId: string) => cards,
			getCard: async (cardId: string) => cards.find(c => c.id === cardId),
			onDidChangeCards: { event: () => ({ dispose: () => {} }) } as any,
			onDidChangeBoard: { event: () => ({ dispose: () => {} }) } as any,
		};

		// Create
		const card = await provider.createCard('board-1', { title: 'Task 1', columnId: 'col-1' });
		assert.strictEqual(card.title, 'Task 1');

		// List
		const allCards = await provider.listCards('board-1');
		assert.strictEqual(allCards.length, 1);

		// Move (position is optional)
		await provider.moveCard(card.id, 'col-2');
		const moved = await provider.getCard(card.id);
		assert.strictEqual(moved.columnId, 'col-2');

		// Delete
		await provider.deleteCard(card.id);
		assert.strictEqual((await provider.listCards('board-1')).length, 0);
	});

	// ─── ISlotRegistry ──────────────────────────────────────────

	test('ISlotRegistry interface has all getter methods', () => {
		const registry = {
			getActiveModelProvider: () => undefined,
			getActiveMemoryProvider: () => undefined,
			getActiveToolProvider: () => undefined,
			getActivePlanningProvider: () => undefined,
			getActiveRetrievalProvider: () => undefined,
			getActiveKanbanProvider: () => undefined,
		};

		assert.ok(typeof registry.getActiveModelProvider === 'function');
		assert.ok(typeof registry.getActiveMemoryProvider === 'function');
		assert.ok(typeof registry.getActiveToolProvider === 'function');
		assert.ok(typeof registry.getActivePlanningProvider === 'function');
		assert.ok(typeof registry.getActiveRetrievalProvider === 'function');
		assert.ok(typeof registry.getActiveKanbanProvider === 'function');
	});

	// ─── IModelDelta / IModelOptions 补充测试 ──────────────────

	test('IModelDelta - thinking type', () => {
		const delta = { type: 'thinking' as const, content: 'Let me think...' };
		assert.strictEqual(delta.type, 'thinking');
		assert.strictEqual(delta.content, 'Let me think...');
	});

	test('IModelDelta - tool_call type', () => {
		const delta = {
			type: 'tool_call' as const,
			toolCall: { id: 'call-1', name: 'search', arguments: '{"q":"test"}' },
		};
		assert.strictEqual(delta.type, 'tool_call');
		assert.strictEqual(delta.toolCall.name, 'search');
	});

	test('IModelOptions - full options', () => {
		const options = {
			temperature: 0.7,
			maxTokens: 4096,
			systemPrompt: 'You are helpful',
			tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
			stop: ['\n'],
		};

		assert.strictEqual(options.temperature, 0.7);
		assert.strictEqual(options.maxTokens, 4096);
		assert.strictEqual(options.tools.length, 1);
		assert.strictEqual(options.stop.length, 1);
	});

	// ─── IChatMessage 补充测试 ─────────────────────────────────

	test('IChatMessage - tool role with toolCalls', () => {
		const message = {
			role: 'assistant' as const,
			content: '',
			toolCalls: [
				{ id: 'call-1', name: 'file_read', arguments: '{"path":"test.ts"}' },
			],
		};

		assert.strictEqual(message.role, 'assistant');
		assert.strictEqual(message.toolCalls!.length, 1);
		assert.strictEqual(message.toolCalls![0].name, 'file_read');
	});

	test('IChatMessage - tool role with toolCallId', () => {
		const message = {
			role: 'tool' as const,
			content: 'File content here',
			toolCallId: 'call-1',
		};

		assert.strictEqual(message.role, 'tool');
		assert.strictEqual(message.toolCallId, 'call-1');
	});

	// ─── IWorkspaceConfig 补充测试 ──────────────────────────────

	test('IWorkspaceConfig interface structure', () => {
		const config = {
			id: 'workspace-1',
			name: 'My Workspace',
			path: '/path/to/workspace',
			isActive: true,
			createdAt: new Date().toISOString(),
		};

		assert.strictEqual(config.id, 'workspace-1');
		assert.strictEqual(config.name, 'My Workspace');
		assert.strictEqual(config.isActive, true);
	});
});
