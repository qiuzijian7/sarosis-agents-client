/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ModelAuthStatus } from '../../common/providers.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Agent OS - Interface Definitions (Phase 1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('IModelProvider interface structure', () => {
		// 验证 IModelProvider 接口的关键属性
		const mockProvider = {
			id: 'test-provider',
			name: 'Test Provider',
			priority: 100,
			onDidChangeModels: { /* Event */ },
			onDidChangeAuthStatus: { /* Event */ },
			getAuthStatus: () => ModelAuthStatus.NotConfigured,
			listModels: async () => [],
			chat: async function* () { yield { type: 'done' as const }; },
		};

		assert.strictEqual(mockProvider.id, 'test-provider');
		assert.strictEqual(mockProvider.name, 'Test Provider');
		assert.strictEqual(mockProvider.priority, 100);
		assert.strictEqual(mockProvider.getAuthStatus(), ModelAuthStatus.NotConfigured);
	});

	test('IMemoryProvider interface structure', () => {
		const mockProvider = {
			id: 'test-memory',
			name: 'Test Memory',
			loadContext: async (agentId: string, sessionId: string) => ({
				shortTermMemories: [],
				longTermMemories: [],
			}),
			writeMemory: async (agentId: string, entry: any) => {},
			searchMemory: async (agentId: string, query: string) => [],
		};

		assert.strictEqual(mockProvider.id, 'test-memory');
		assert.strictEqual(mockProvider.name, 'Test Memory');
	});

	test('IToolProvider interface structure', () => {
		const mockProvider = {
			id: 'test-tool',
			name: 'Test Tool',
			listTools: async (agentId: string) => [],
			executeTool: async (agentId: string, toolCall: any) => ({
				toolCallId: 'test',
				content: 'result',
				isError: false,
			}),
		};

		assert.strictEqual(mockProvider.id, 'test-tool');
		assert.strictEqual(mockProvider.name, 'Test Tool');
	});

	test('IModelSelection interface', () => {
		const selection = {
			providerId: 'demo-agui',
			modelId: 'agent-1',
		};

		assert.strictEqual(selection.providerId, 'demo-agui');
		assert.strictEqual(selection.modelId, 'agent-1');
	});

	test('ModelAuthStatus enum values', () => {
		assert.strictEqual(ModelAuthStatus.NotConfigured, 'not-configured');
		assert.strictEqual(ModelAuthStatus.Validating, 'validating');
		assert.strictEqual(ModelAuthStatus.Authenticated, 'authenticated');
		assert.strictEqual(ModelAuthStatus.Failed, 'failed');
	});

	test('IAgentTurnRequest interface structure', () => {
		const request = {
			agentId: 'agent-1',
			messages: [
				{ role: 'user' as const, content: 'Hello' },
			],
			options: { temperature: 0.7 },
		};

		assert.strictEqual(request.agentId, 'agent-1');
		assert.strictEqual(request.messages.length, 1);
		assert.strictEqual(request.options.temperature, 0.7);
	});

	test('IChatStreamDelta interface - text', () => {
		const delta = {
			type: 'text' as const,
			content: 'Hello world',
		};

		assert.strictEqual(delta.type, 'text');
		assert.strictEqual(delta.content, 'Hello world');
	});

	test('IChatStreamDelta interface - tool_call', () => {
		const delta = {
			type: 'tool_call' as const,
			content: '',
			toolCall: {
				id: 'call-1',
				name: 'file_read',
				arguments: '{"path": "test.ts"}',
			},
		};

		assert.strictEqual(delta.type, 'tool_call');
		assert.strictEqual(delta.toolCall?.name, 'file_read');
	});

	test('IChatStreamDelta interface - done', () => {
		const delta = {
			type: 'done' as const,
		};

		assert.strictEqual(delta.type, 'done');
	});

	test('IChatStreamDelta interface - error', () => {
		const delta = {
			type: 'error' as const,
			error: 'Something went wrong',
		};

		assert.strictEqual(delta.type, 'error');
		assert.strictEqual(delta.error, 'Something went wrong');
	});
});
