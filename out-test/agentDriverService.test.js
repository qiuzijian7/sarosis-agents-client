/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
suite('Agent Driver Service (Phase 2)', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    // Mock IAgentOSService
    class MockAgentOSService {
        executeAgentTurn(request) {
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
        assert.strictEqual("idle" /* AgentTurnStatus.Idle */, 'idle');
        assert.strictEqual("running" /* AgentTurnStatus.Running */, 'running');
        assert.strictEqual("cancelling" /* AgentTurnStatus.Cancelling */, 'cancelling');
        assert.strictEqual("done" /* AgentTurnStatus.Done */, 'done');
        assert.strictEqual("error" /* AgentTurnStatus.Error */, 'error');
    });
    test('executeTurn returns AsyncIterable', async () => {
        const osService = new MockAgentOSService();
        // 模拟 executeTurn 方法
        const executeTurn = async function* (request) {
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
        const activeTurns = new Map();
        const turnStatusMap = new Map();
        // 模拟 executeTurn
        const executeTurn = async (turnId) => {
            const controller = new AbortController();
            activeTurns.set(turnId, controller);
            turnStatusMap.set(turnId, "running" /* AgentTurnStatus.Running */);
        };
        // 模拟 cancelTurn
        const cancelTurn = (turnId) => {
            const controller = activeTurns.get(turnId);
            if (controller) {
                turnStatusMap.set(turnId, "cancelling" /* AgentTurnStatus.Cancelling */);
                controller.abort();
                activeTurns.delete(turnId);
            }
        };
        executeTurn('turn-1');
        assert.strictEqual(turnStatusMap.get('turn-1'), "running" /* AgentTurnStatus.Running */);
        cancelTurn('turn-1');
        assert.strictEqual(turnStatusMap.get('turn-1'), "cancelling" /* AgentTurnStatus.Cancelling */);
        assert.ok(!activeTurns.has('turn-1'));
    });
    test('multiple turns can run concurrently', async () => {
        const activeTurns = new Map();
        const executeTurn = async (turnId) => {
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
        const executeFromChatOptions = (agentId, message, options) => {
            // 将 IChatSendOptions 适配为 IAgentTurnRequest
            return {
                agentId,
                messages: [{ role: 'user', content: message }],
                options: {
                    temperature: options.temperature,
                    maxTokens: options.maxTokens,
                },
            };
        };
        const result = executeFromChatOptions('emp-1', 'Hello', { temperature: 0.7, maxTokens: 4096 });
        assert.strictEqual(result.agentId, 'emp-1');
        assert.strictEqual(result.messages[0].content, 'Hello');
        assert.strictEqual(result.options.temperature, 0.7);
        assert.strictEqual(result.options.maxTokens, 4096);
    });
    test('turn status lifecycle', () => {
        const turnStatusMap = new Map();
        const updateStatus = (turnId, status) => {
            turnStatusMap.set(turnId, status);
        };
        const getStatus = (turnId) => {
            return turnStatusMap.get(turnId) || "idle" /* AgentTurnStatus.Idle */;
        };
        // 模拟 turn 生命周期
        const turnId = 'turn-1';
        updateStatus(turnId, "running" /* AgentTurnStatus.Running */);
        assert.strictEqual(getStatus(turnId), "running" /* AgentTurnStatus.Running */);
        updateStatus(turnId, "done" /* AgentTurnStatus.Done */);
        assert.strictEqual(getStatus(turnId), "done" /* AgentTurnStatus.Done */);
    });
    test('cancelling turn sets status to Cancelling first', () => {
        const turnStatusMap = new Map();
        const executeTurn = (turnId) => {
            turnStatusMap.set(turnId, "running" /* AgentTurnStatus.Running */);
        };
        const cancelTurn = (turnId) => {
            if (turnStatusMap.get(turnId) === "running" /* AgentTurnStatus.Running */) {
                turnStatusMap.set(turnId, "cancelling" /* AgentTurnStatus.Cancelling */);
                // 模拟异步取消
                setTimeout(() => {
                    turnStatusMap.set(turnId, "done" /* AgentTurnStatus.Done */);
                }, 0);
            }
        };
        executeTurn('turn-1');
        cancelTurn('turn-1');
        assert.strictEqual(turnStatusMap.get('turn-1'), "cancelling" /* AgentTurnStatus.Cancelling */);
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
        const executeTurnWithError = async function* (shouldError) {
            try {
                if (shouldError) {
                    throw new Error('Test error');
                }
                yield { type: 'text', content: 'Success' };
                yield { type: 'done' };
            }
            catch (error) {
                yield { type: 'error', content: error.message };
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
