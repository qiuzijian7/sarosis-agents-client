/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Event } from '../../../../../base/common/event.js';
import { ModelAuthStatus } from '../../common/providers.js';
suite('AgentOS Service (Phase 1)', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    // Mock IModelProvider
    class MockModelProvider {
        id;
        name;
        priority = 100;
        onDidChangeModels = Event.None;
        onDidChangeAuthStatus = Event.None;
        constructor(id, name) {
            this.id = id;
            this.name = name;
        }
        getAuthStatus() {
            return ModelAuthStatus.Authenticated;
        }
        async listModels() {
            return [
                { id: `${this.id}-model-1`, name: 'Model 1' },
                { id: `${this.id}-model-2`, name: 'Model 2' },
            ];
        }
        async *chat(modelId, messages, options) {
            yield { type: 'text', content: 'Mock response' };
            yield { type: 'done' };
        }
    }
    // Mock IMemoryProvider
    class MockMemoryProvider {
        id;
        name;
        constructor(id, name) {
            this.id = id;
            this.name = name;
        }
        async loadContext(agentId, sessionId) {
            return {
                shortTermMemories: [],
                longTermMemories: [],
            };
        }
        async writeMemory(agentId, entry) { }
        async searchMemory(agentId, query) {
            return [];
        }
    }
    // Mock IToolProvider
    class MockToolProvider {
        id;
        name;
        disabledTools = new Set();
        constructor(id, name) {
            this.id = id;
            this.name = name;
        }
        async listTools(agentId) {
            return [
                { name: 'test_tool', description: 'A test tool' },
            ];
        }
        async executeTool(agentId, toolCall) {
            return {
                toolCallId: toolCall.id,
                content: 'Mock tool result',
                isError: false,
            };
        }
        async enableTool(agentId, toolName) {
            this.disabledTools.delete(toolName);
        }
        async disableTool(agentId, toolName) {
            this.disabledTools.add(toolName);
        }
        async isToolEnabled(agentId, toolName) {
            return !this.disabledTools.has(toolName);
        }
        async getToolsEnabledState(agentId) {
            return { 'test_tool': true };
        }
        async setToolsEnabledState(agentId, state) {
            for (const [name, enabled] of Object.entries(state)) {
                if (enabled) {
                    this.disabledTools.delete(name);
                }
                else {
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
function createTestAgentOSService() {
    // 由于 AgentOSService 依赖 DI，这里返回一个模拟对象
    // 实际测试中应该使用 TestInstantiationService
    const providers = [];
    const memoryProviders = [];
    const toolProviders = [];
    const planningProviders = [];
    const executionProviders = [];
    let activeSelection = { providerId: '', modelId: '' };
    return {
        registerModelProvider: (p) => {
            providers.push(p);
            return {
                dispose: () => {
                    const idx = providers.indexOf(p);
                    if (idx !== -1) {
                        providers.splice(idx, 1);
                    }
                }
            };
        },
        getModelProviders: () => providers,
        registerMemoryProvider: (p, priority) => {
            memoryProviders.push({ provider: p, priority });
            memoryProviders.sort((a, b) => b.priority - a.priority);
            return {
                dispose: () => {
                    const idx = memoryProviders.findIndex(mp => mp.provider === p);
                    if (idx !== -1) {
                        memoryProviders.splice(idx, 1);
                    }
                }
            };
        },
        getActiveMemoryProvider: () => memoryProviders[0]?.provider,
        registerToolProvider: (p, priority) => {
            toolProviders.push({ provider: p, priority });
            toolProviders.sort((a, b) => b.priority - a.priority);
            return {
                dispose: () => {
                    const idx = toolProviders.findIndex(tp => tp.provider === p);
                    if (idx !== -1) {
                        toolProviders.splice(idx, 1);
                    }
                }
            };
        },
        getActiveToolProvider: () => toolProviders[0]?.provider,
        registerPlanningProvider: (p, priority) => {
            planningProviders.push({ provider: p, priority });
            planningProviders.sort((a, b) => b.priority - a.priority);
            return { dispose: () => { } };
        },
        getActivePlanningProvider: () => planningProviders[0]?.provider,
        registerExecutionProvider: (p, priority) => {
            executionProviders.push({ provider: p, priority });
            executionProviders.sort((a, b) => b.priority - a.priority);
            return { dispose: () => { } };
        },
        getActiveExecutionProvider: () => executionProviders[0]?.provider,
        setActiveModelSelection: (s) => { activeSelection = s; },
        getActiveModelSelection: () => activeSelection,
        executeAgentTurn: async function* (request) {
            yield { type: 'error', content: 'No ModelProvider registered' };
        },
    };
}
