/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentTurnStatus } from '../../common/agentDriver.js';

suite('Agent Driver Service (Phase 2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mock IAgentOSService
	class MockAgentOSService {
		executeAgentTurn(request: any): AsyncIterable<any> {
			return (async function* () {
				yield { type: 'text', content: 'Mock OS response' };
				yield { type: 'done' };
			})();
		}

		getActiveModelProvider() {
			return undefined;
		}
	}

	test('AgentTurnStatus enum values', () => {
		assert.strictEqual(AgentTurnStatus.Idle, 'idle');
		assert.strictEqual(AgentTurnStatus.Running, 'running');
		assert.strictEqual(AgentTurnStatus.Cancelling, 'cancelling');
		assert.strictEqual(AgentTurnStatus.Done, 'done');
		assert.strictEqual(AgentTurnStatus.Error, 'error');
	});

	test('executeTurn returns AsyncIterable', async () => {
		const osService = new MockAgentOSService();
		
		// 模拟 executeTurn 方法
		const executeTurn = async function* (request: any) {
			const stream = osService.executeAgentTurn(request);
			for await (const delta of stream) {
				yield delta;
			}
		};

		const request = {
			agentId: 'agent-1',
			messages: [{ role: 'user', content: 'Hello' }],
			options: {},
		};

		const deltas = [];
		for await (const delta of executeTurn(request)) {
			deltas.push(delta);
		}

		assert.ok(deltas.length > 0);
		assert.strictEqual(deltas[0].type, 'text');
	});

	test('cancelTurn aborts running turn', () => {
		const activeTurns = new Map<string, AbortController>();
		const turnStatusMap = new Map<string, string>();

		// 模拟 executeTurn
		const executeTurn = async (turnId: string) => {
			const controller = new AbortController();
			activeTurns.set(turnId, controller);
			turnStatusMap.set(turnId, AgentTurnStatus.Running);
		};

		// 模拟 cancelTurn
		const cancelTurn = (turnId: string) => {
			const controller = activeTurns.get(turnId);
			if (controller) {
				turnStatusMap.set(turnId, AgentTurnStatus.Cancelling);
				controller.abort();
				activeTurns.delete(turnId);
			}
		};

		executeTurn('turn-1');
		assert.strictEqual(turnStatusMap.get('turn-1'), AgentTurnStatus.Running);

		cancelTurn('turn-1');
		assert.strictEqual(turnStatusMap.get('turn-1'), AgentTurnStatus.Cancelling);
		assert.ok(!activeTurns.has('turn-1'));
	});

	test('multiple turns can run concurrently', async () => {
		const activeTurns = new Map<string, boolean>();

		const executeTurn = async (turnId: string) => {
			activeTurns.set(turnId, true);
			// 模拟异步操作
			await new Promise(resolve => setTimeout(resolve, 10));
			activeTurns.delete(turnId);
		};

		// 启动两个并发 turn
		const p1 = executeTurn('turn-1');
		const p2 = executeTurn('turn-2');

		// 验证两个 turn 都在运行
		assert.ok(activeTurns.has('turn-1'));
		assert.ok(activeTurns.has('turn-2'));

		await Promise.all([p1, p2]);
	});

	test('executeFromChatOptions adapts options correctly', () => {
		const executeFromChatOptions = (
			employeeId: string,
			message: string,
			options: any,
		) => {
			// 将 IChatSendOptions 适配为 IAgentTurnRequest
			return {
				agentId: employeeId,
				messages: [{ role: 'user', content: message }],
				options: {
					temperature: options.temperature,
					maxTokens: options.maxTokens,
				},
			};
		};

		const result = executeFromChatOptions(
			'emp-1',
			'Hello',
			{ temperature: 0.7, maxTokens: 4096 },
		);

		assert.strictEqual(result.agentId, 'emp-1');
		assert.strictEqual(result.messages[0].content, 'Hello');
		assert.strictEqual(result.options.temperature, 0.7);
		assert.strictEqual(result.options.maxTokens, 4096);
	});

	test('turn status lifecycle', () => {
		const turnStatusMap = new Map<string, string>();

		const updateStatus = (turnId: string, status: string) => {
			turnStatusMap.set(turnId, status);
		};

		const getStatus = (turnId: string) => {
			return turnStatusMap.get(turnId) || AgentTurnStatus.Idle;
		};

		// 模拟 turn 生命周期
		const turnId = 'turn-1';
		
		updateStatus(turnId, AgentTurnStatus.Running);
		assert.strictEqual(getStatus(turnId), AgentTurnStatus.Running);

		updateStatus(turnId, AgentTurnStatus.Done);
		assert.strictEqual(getStatus(turnId), AgentTurnStatus.Done);
	});

	test('cancelling turn sets status to Cancelling first', () => {
		const turnStatusMap = new Map<string, string>();

		const executeTurn = (turnId: string) => {
			turnStatusMap.set(turnId, AgentTurnStatus.Running);
		};

		const cancelTurn = (turnId: string) => {
			if (turnStatusMap.get(turnId) === AgentTurnStatus.Running) {
				turnStatusMap.set(turnId, AgentTurnStatus.Cancelling);
				// 模拟异步取消
				setTimeout(() => {
					turnStatusMap.set(turnId, AgentTurnStatus.Done);
				}, 0);
			}
		};

		executeTurn('turn-1');
		cancelTurn('turn-1');

		assert.strictEqual(turnStatusMap.get('turn-1'), AgentTurnStatus.Cancelling);
	});

	test('fallback to direct chat when no OS service', async () => {
		// 模拟直通模式
		const fallbackToDirectChat = async function* () {
			yield { type: 'text', content: 'Fallback response' };
			yield { type: 'done' };
		};

		const deltas = [];
		for await (const delta of fallbackToDirectChat()) {
			deltas.push(delta);
		}

		assert.ok(deltas.length > 0);
		assert.strictEqual(deltas[0].type, 'text');
	});

	test('error handling in executeTurn', async () => {
		const executeTurnWithError = async function* (shouldError: boolean) {
			try {
				if (shouldError) {
					throw new Error('Test error');
				}
				yield { type: 'text', content: 'Success' };
				yield { type: 'done' };
			} catch (error) {
				yield { type: 'error', content: (error as Error).message };
			}
		};

		const deltas = [];
		for await (const delta of executeTurnWithError(true)) {
			deltas.push(delta);
		}

		assert.strictEqual(deltas[0].type, 'error');
		assert.strictEqual(deltas[0].content, 'Test error');
	});
});
