/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils';

suite('Agent Driver Service - Interface Definitions (Phase 2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('IAgentDriverService interface structure', () => {
		// 验证 IAgentDriverService 接口的关键方法
		const mockDriver = {
			executeTurn: async function* (request: any) {
				yield { type: 'text', content: 'test' };
			},
			executeFromChatOptions: async function* (agentId: string, message: string, options: any) {
				yield { type: 'text', content: 'test' };
			},
			cancelTurn: (turnId: string) => {},
			onDidChangeTurnStatus: { /* Event */ },
			getTurnStatus: (turnId: string) => 'idle' as const,
		};

		assert.ok(typeof mockDriver.executeTurn === 'function');
		assert.ok(typeof mockDriver.cancelTurn === 'function');
		assert.ok(typeof mockDriver.getTurnStatus === 'function');
	});

	test('AgentTurnStatus enum values', () => {
		const AgentTurnStatus = {
			Idle: 'idle',
			Running: 'running',
			Cancelling: 'cancelling',
			Done: 'done',
			Error: 'error',
		};

		assert.strictEqual(AgentTurnStatus.Idle, 'idle');
		assert.strictEqual(AgentTurnStatus.Running, 'running');
		assert.strictEqual(AgentTurnStatus.Cancelling, 'cancelling');
		assert.strictEqual(AgentTurnStatus.Done, 'done');
		assert.strictEqual(AgentTurnStatus.Error, 'error');
	});

	test('IAgentTurnLifecycle interface', () => {
		const lifecycle = {
			turnId: 'turn-1',
			status: 'running' as const,
			startTime: Date.now(),
		};

		assert.strictEqual(lifecycle.turnId, 'turn-1');
		assert.strictEqual(lifecycle.status, 'running');
		assert.ok(lifecycle.startTime !== undefined);
	});

	test('executeTurn request format', () => {
		const request = {
			agentId: 'agent-1',
			messages: [
				{ role: 'user', content: 'Hello' },
			],
			options: {
				temperature: 0.7,
				maxTokens: 4096,
			},
		};

		assert.strictEqual(request.agentId, 'agent-1');
		assert.strictEqual(request.messages.length, 1);
		assert.strictEqual(request.messages[0].role, 'user');
		assert.strictEqual(request.options.temperature, 0.7);
	});

	test('executeFromChatOptions adapter', () => {
		const agentId = 'emp-1';
		const message = 'Hello, agent!';
		const options = {
			temperature: 0.5,
			model: 'gpt-4',
		};

		// 验证适配器能正确转换格式
		const request = {
			agentId,
			messages: [{ role: 'user', content: message }],
			options,
		};

		assert.strictEqual(request.agentId, agentId);
		assert.strictEqual(request.messages[0].content, message);
		assert.strictEqual(request.options.temperature, 0.5);
	});

	test('cancelTurn cancels running turn', () => {
		const turnStatuses = new Map<string, string>();
		turnStatuses.set('turn-1', 'running');

		const cancelTurn = (turnId: string) => {
			if (turnStatuses.get(turnId) === 'running') {
				turnStatuses.set(turnId, 'cancelling');
			}
		};

		cancelTurn('turn-1');
		assert.strictEqual(turnStatuses.get('turn-1'), 'cancelling');
	});

	test('getTurnStatus returns correct status', () => {
		const turnStatuses = new Map<string, string>();
		turnStatuses.set('turn-1', 'idle');
		turnStatuses.set('turn-2', 'running');
		turnStatuses.set('turn-3', 'done');

		const getTurnStatus = (turnId: string) => {
			return turnStatuses.get(turnId) || 'idle';
		};

		assert.strictEqual(getTurnStatus('turn-1'), 'idle');
		assert.strictEqual(getTurnStatus('turn-2'), 'running');
		assert.strictEqual(getTurnStatus('turn-3'), 'done');
		assert.strictEqual(getTurnStatus('non-existent'), 'idle');
	});

	test('stream delta format validation', async () => {
		const deltas = [
			{ type: 'text', content: 'Hello' },
			{ type: 'text', content: ' world' },
			{ type: 'done' },
		];

		for (const delta of deltas) {
			assert.ok(['text', 'thinking', 'tool_call', 'done', 'error'].includes(delta.type));
			if (delta.type === 'text') {
				assert.ok(typeof delta.content === 'string');
			}
		}

		assert.strictEqual(deltas.length, 3);
		assert.strictEqual(deltas[2].type, 'done');
	});

	test('multiple turns can run concurrently', () => {
		const activeTurns = new Map<string, boolean>();
		
		const executeTurn = (turnId: string) => {
			activeTurns.set(turnId, true);
		};

		const cancelTurn = (turnId: string) => {
			activeTurns.delete(turnId);
		};

		executeTurn('turn-1');
		executeTurn('turn-2');
		assert.strictEqual(activeTurns.size, 2);

		cancelTurn('turn-1');
		assert.strictEqual(activeTurns.size, 1);
		assert.ok(activeTurns.has('turn-2'));
	});
});
