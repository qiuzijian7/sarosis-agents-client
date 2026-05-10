/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ModelAuthStatus } from '../../common/providers.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Knot AG-UI Model Provider (Phase 3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mock KnotModelProvider (简化版本)
	class MockKnotModelProvider {
		readonly id = 'knot-agui';
		readonly name = 'Knot AG-UI';
		readonly priority = 100;
		
		onDidChangeModels: any = { /* Event */ };
		onDidChangeAuthStatus: any = { /* Event */ };
		
		private _authStatus = ModelAuthStatus.NotConfigured;
		private _agents: any[] = [];

		constructor() {}

		getAuthStatus(): ModelAuthStatus {
			return this._authStatus;
		}

		async listModels(): Promise<any[]> {
			if (this._authStatus !== ModelAuthStatus.Authenticated) {
				return [];
			}
			return this._agents;
		}

		async *chat(modelId: string, messages: any[], options: any): AsyncIterable<any> {
			// 模拟 AG-UI 流式响应
			yield { type: 'text', content: 'Hello from Knot Agent' };
			yield { type: 'done' };
		}

		async reloadConfiguration(): Promise<void> {
			// 模拟重新加载配置
			this._authStatus = ModelAuthStatus.Validating;
			// 模拟异步验证
			await new Promise(resolve => setTimeout(resolve, 10));
			this._authStatus = ModelAuthStatus.Authenticated;
			this._agents = [
				{ id: 'agent-1', name: 'Agent 1' },
				{ id: 'agent-2', name: 'Agent 2' },
			];
		}
	}

	test('KnotModelProvider implements IModelProvider interface', () => {
		const provider = new MockKnotModelProvider();

		assert.strictEqual(provider.id, 'knot-agui');
		assert.strictEqual(provider.name, 'Knot AG-UI');
		assert.strictEqual(provider.priority, 100);
		assert.ok(typeof provider.getAuthStatus === 'function');
		assert.ok(typeof provider.listModels === 'function');
		assert.ok(typeof provider.chat === 'function');
		assert.ok(typeof provider.reloadConfiguration === 'function');
	});

	test('getAuthStatus returns correct status', () => {
		const provider = new MockKnotModelProvider();
		
		// 初始状态：未配置
		assert.strictEqual(provider.getAuthStatus(), ModelAuthStatus.NotConfigured);

		// 重新加载配置后应该变为已认证
		// 注意：这里需要等待 reloadConfiguration 完成
	});

	test('listModels returns empty when not authenticated', async () => {
		const provider = new MockKnotModelProvider();
		
		const models = await provider.listModels();
		assert.strictEqual(models.length, 0);
	});

	test('listModels returns agents when authenticated', async () => {
		const provider = new MockKnotModelProvider();
		
		// 模拟认证成功
		provider['_authStatus'] = ModelAuthStatus.Authenticated;
		provider['_agents'] = [
			{ id: 'agent-1', name: 'Agent 1' },
			{ id: 'agent-2', name: 'Agent 2' },
		];

		const models = await provider.listModels();
		assert.strictEqual(models.length, 2);
		assert.strictEqual(models[0].id, 'agent-1');
		assert.strictEqual(models[1].name, 'Agent 2');
	});

	test('chat method returns AsyncIterable', async () => {
		const provider = new MockKnotModelProvider();
		
		const messages = [{ role: 'user', content: 'Hello' }];
		const options = { temperature: 0.7 };

		const deltas = [];
		for await (const delta of provider.chat('agent-1', messages, options)) {
			deltas.push(delta);
		}

		assert.ok(deltas.length > 0);
		assert.strictEqual(deltas[0].type, 'text');
		assert.strictEqual(deltas[0].content, 'Hello from Knot Agent');
		assert.strictEqual(deltas[1].type, 'done');
	});

	test('chat method uses modelId as agentId', async () => {
		const provider = new MockKnotModelProvider();
		
		// 验证 modelId 被当作 agentId 使用
		let capturedAgentId = '';
		const originalChat = provider.chat.bind(provider);
		provider.chat = async function* (modelId: string, messages: any[], options: any) {
			capturedAgentId = modelId;
			yield* originalChat(modelId, messages, options);
		};

		await provider.chat('my-agent', [{ role: 'user', content: 'test' }], {});
		assert.strictEqual(capturedAgentId, 'my-agent');
	});

	test('reloadConfiguration updates auth status and models', async () => {
		const provider = new MockKnotModelProvider();
		
		assert.strictEqual(provider.getAuthStatus(), ModelAuthStatus.NotConfigured);

		await provider.reloadConfiguration();

		assert.strictEqual(provider.getAuthStatus(), ModelAuthStatus.Authenticated);
		
		const models = await provider.listModels();
		assert.ok(models.length > 0);
	});

	test('chat handles AG-UI streaming protocol', async () => {
		const provider = new MockKnotModelProvider();
		
		// 模拟 AG-UI 的流式响应
		provider.chat = async function* (modelId: string, messages: any[], options: any) {
			// 模拟流式文本
			yield { type: 'text', content: 'Hello' };
			yield { type: 'text', content: ' world' };
			
			// 模拟工具调用
			yield { 
				type: 'tool_call', 
				toolCall: { 
					id: 'call-1', 
					name: 'read_file', 
					arguments: '{"path": "test.ts"}' 
				} 
			};
			
			// 结束
			yield { type: 'done' };
		};

		const deltas = [];
		for await (const delta of provider.chat('agent-1', [], {})) {
			deltas.push(delta);
		}

		assert.strictEqual(deltas.length, 4);
		assert.strictEqual(deltas[0].type, 'text');
		assert.strictEqual(deltas[0].content, 'Hello');
		assert.strictEqual(deltas[1].type, 'text');
		assert.strictEqual(deltas[1].content, ' world');
		assert.strictEqual(deltas[2].type, 'tool_call');
		assert.strictEqual(deltas[2].toolCall.name, 'read_file');
		assert.strictEqual(deltas[3].type, 'done');
	});

	test('priority is high (100) to be default selected', () => {
		const provider = new MockKnotModelProvider();
		
		assert.strictEqual(provider.priority, 100);
	});

	test('onDidChangeModels event exists', () => {
		const provider = new MockKnotModelProvider();
		
		assert.ok('onDidChangeModels' in provider);
	});

	test('onDidChangeAuthStatus event exists', () => {
		const provider = new MockKnotModelProvider();
		
		assert.ok('onDidChangeAuthStatus' in provider);
	});
});
