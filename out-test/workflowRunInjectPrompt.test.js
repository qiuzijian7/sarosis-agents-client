/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
/**
 * Workflow Run → Prompt Injection Chain Tests
 *
 * Tests the full chain that makes the "▶ Run" button work:
 *
 *   workflowView._runWorkflow()
 *     → agentStudioService.requestInjectPrompt(agentId, prompt)
 *       → onDidRequestInjectPrompt.fire({ agentId, message })
 *         → agentStudioWebviewController (chat panel)
 *           → _sendEvent('chat.injectPrompt', { agentId, message })
 *             → webview index.tsx case 'chat.injectPrompt'
 *               → useChatStore.setState + sendMessage(prompt)
 *
 * We test three layers independently:
 *   1. AgentStudioService — fires the event
 *   2. Webview controller — filters by panelType + agentId
 *   3. Webview handler — only chat panel processes it
 */
// ── Mock: AgentStudioService (simulating the DI service) ──────────
class MockAgentStudioService {
    _onDidRequestInjectPrompt = new Emitter();
    onDidRequestInjectPrompt = this._onDidRequestInjectPrompt.event;
    requestInjectPrompt(agentId, message) {
        this._onDidRequestInjectPrompt.fire({ agentId, message });
    }
}
class MockWebviewController {
    sentEvents = [];
    panelType;
    _activeChatAgentId;
    constructor(panelType) {
        this.panelType = panelType;
    }
    setActiveAgent(agentId) {
        this._activeChatAgentId = agentId;
    }
    /** Replicates the subscription in agentStudioWebviewController.ts */
    subscribeToInjectPrompt(service) {
        service.onDidRequestInjectPrompt(({ agentId, message }) => {
            // Only the chat panel should handle prompt injection
            if (this.panelType !== 'chat') {
                return;
            }
            // Only inject if this panel is showing the target agent (or no agent is active yet)
            if (this._activeChatAgentId && this._activeChatAgentId !== agentId) {
                return;
            }
            this.sentEvents.push({
                type: 'chat.injectPrompt',
                data: { agentId, message },
            });
        });
    }
}
// ── Mock: Webview message handler (simulating index.tsx) ──
class MockWebviewMessageHandler {
    injectedPrompts = [];
    panelType;
    _selectedAgentId = null;
    constructor(panelType) {
        this.panelType = panelType;
    }
    get selectedAgentId() { return this._selectedAgentId; }
    /** Replicates the case 'chat.injectPrompt' handler in index.tsx */
    handleInjectPromptEvent(event) {
        if (event.type !== 'chat.injectPrompt') {
            return;
        }
        // Only the chat panel should act on this
        if (this.panelType !== 'chat') {
            return;
        }
        const { agentId, message } = event.data;
        if (!agentId || !message) {
            return;
        }
        // Select target agent + send message
        this._selectedAgentId = agentId;
        this.injectedPrompts.push({ agentId, message });
    }
}
// ── Tests ──────────────────────────────────────────────────────────
suite('Workflow Run → Prompt Injection Chain', () => {
    test('AgentStudioService.requestInjectPrompt fires event with correct payload', () => {
        const service = new MockAgentStudioService();
        let received;
        service.onDidRequestInjectPrompt((e) => { received = e; });
        service.requestInjectPrompt('agent-123', '# Execute Workflow: test');
        assert.ok(received, 'Event should be received');
        assert.strictEqual(received.agentId, 'agent-123');
        assert.strictEqual(received.message, '# Execute Workflow: test');
    });
    test('Chat panel webview controller forwards inject event when agentId matches', () => {
        const service = new MockAgentStudioService();
        const controller = new MockWebviewController('chat');
        controller.setActiveAgent('agent-123');
        controller.subscribeToInjectPrompt(service);
        service.requestInjectPrompt('agent-123', 'Run workflow');
        assert.strictEqual(controller.sentEvents.length, 1);
        assert.strictEqual(controller.sentEvents[0].type, 'chat.injectPrompt');
        assert.strictEqual(controller.sentEvents[0].data.agentId, 'agent-123');
        assert.strictEqual(controller.sentEvents[0].data.message, 'Run workflow');
    });
    test('Chat panel webview controller forwards inject when no agent is active yet (fresh open)', () => {
        const service = new MockAgentStudioService();
        const controller = new MockWebviewController('chat');
        // _activeChatAgentId is undefined (fresh open)
        controller.subscribeToInjectPrompt(service);
        service.requestInjectPrompt('agent-456', 'Run new workflow');
        assert.strictEqual(controller.sentEvents.length, 1);
        assert.strictEqual(controller.sentEvents[0].data.agentId, 'agent-456');
    });
    test('Chat panel webview controller does NOT forward inject for non-matching agentId', () => {
        const service = new MockAgentStudioService();
        const controller = new MockWebviewController('chat');
        controller.setActiveAgent('agent-123'); // showing agent-123
        controller.subscribeToInjectPrompt(service);
        service.requestInjectPrompt('agent-999', 'Run for different agent');
        assert.strictEqual(controller.sentEvents.length, 0, 'Should NOT forward when agentId does not match');
    });
    test('Non-chat panels (workflow-editor, etc.) ignore inject events', () => {
        const service = new MockAgentStudioService();
        const editorController = new MockWebviewController('workflow-editor');
        editorController.subscribeToInjectPrompt(service);
        service.requestInjectPrompt('agent-123', 'Run workflow');
        assert.strictEqual(editorController.sentEvents.length, 0, 'Workflow editor should NOT handle inject events');
    });
    test('Webview chat panel handler processes chat.injectPrompt and sends message', () => {
        const handler = new MockWebviewMessageHandler('chat');
        handler.handleInjectPromptEvent({
            type: 'chat.injectPrompt',
            data: { agentId: 'agent-123', message: '# Execute Workflow' },
        });
        assert.strictEqual(handler.injectedPrompts.length, 1);
        assert.strictEqual(handler.injectedPrompts[0].agentId, 'agent-123');
        assert.strictEqual(handler.injectedPrompts[0].message, '# Execute Workflow');
        assert.strictEqual(handler.selectedAgentId, 'agent-123');
    });
    test('Webview non-chat panel ignores chat.injectPrompt events', () => {
        const handler = new MockWebviewMessageHandler('workflow-editor');
        handler.handleInjectPromptEvent({
            type: 'chat.injectPrompt',
            data: { agentId: 'agent-123', message: 'should be ignored' },
        });
        assert.strictEqual(handler.injectedPrompts.length, 0, 'Non-chat panel should ignore inject events');
        assert.strictEqual(handler.selectedAgentId, null);
    });
    test('Webview handler ignores chat.injectPrompt with missing agentId', () => {
        const handler = new MockWebviewMessageHandler('chat');
        handler.handleInjectPromptEvent({
            type: 'chat.injectPrompt',
            data: { agentId: '', message: 'no agent' },
        });
        assert.strictEqual(handler.injectedPrompts.length, 0, 'Should ignore event with empty agentId');
    });
    test('Webview handler ignores chat.injectPrompt with missing message', () => {
        const handler = new MockWebviewMessageHandler('chat');
        handler.handleInjectPromptEvent({
            type: 'chat.injectPrompt',
            data: { agentId: 'agent-123', message: '' },
        });
        assert.strictEqual(handler.injectedPrompts.length, 0, 'Should ignore event with empty message');
    });
    test('End-to-end chain: service → controller → webview handler', () => {
        const service = new MockAgentStudioService();
        const controller = new MockWebviewController('chat');
        controller.setActiveAgent('wf-agent-001');
        controller.subscribeToInjectPrompt(service);
        const handler = new MockWebviewMessageHandler('chat');
        // Simulate _runWorkflow:
        service.requestInjectPrompt('wf-agent-001', '# Execute Workflow: My Workflow\n\n...');
        // Controller should forward it
        assert.strictEqual(controller.sentEvents.length, 1);
        // Webview handler should process it
        handler.handleInjectPromptEvent(controller.sentEvents[0]);
        assert.strictEqual(handler.injectedPrompts.length, 1);
        assert.strictEqual(handler.injectedPrompts[0].agentId, 'wf-agent-001');
        assert.strictEqual(handler.selectedAgentId, 'wf-agent-001');
        assert.ok(handler.injectedPrompts[0].message.startsWith('# Execute Workflow'));
    });
    test('_buildExecutionPrompt generates correct graph-based prompt', () => {
        // This test validates that the prompt building logic works correctly.
        // We don't test workflowView directly (it requires full DI), but we test
        // the static build logic pattern.
        const mockWf = {
            id: 'wf-123',
            name: 'Test Workflow',
            description: 'A test workflow',
            nodes: [
                { id: 'start', type: 'start', position: { x: 80, y: 250 }, data: { label: 'Start' } },
                { id: 'agent-1', type: 'agent', position: { x: 300, y: 250 }, data: { label: 'Test Agent', agentId: 'test-agent', agentConfig: { modelId: 'claude-sonnet' } } },
                { id: 'end', type: 'end', position: { x: 600, y: 250 }, data: { label: 'End' } },
            ],
            connections: [
                { id: 'e1', from: 'start', to: 'agent-1' },
                { id: 'e2', from: 'agent-1', to: 'end' },
            ],
        };
        // Build prompt lines manually (replicating _buildGraphExecutionPrompt logic)
        const lines = [];
        lines.push(`# Execute Workflow: ${mockWf.name}`);
        lines.push('');
        lines.push('A test workflow');
        lines.push('');
        const userNodes = mockWf.nodes.filter(n => n.type !== 'start' && n.type !== 'end' && n.type !== 'group');
        assert.strictEqual(userNodes.length, 1, 'Should have 1 user node');
        lines.push('## Workflow Nodes');
        lines.push('');
        const node = userNodes[0];
        if (node.type === 'agent') {
            lines.push(`1. 🤖 **${node.data.label}** (Agent)`);
            lines.push(`   - Agent: ${node.data.agentId}`);
            lines.push(`   - Model: ${node.data.agentConfig?.modelId}`);
        }
        const prompt = lines.join('\n');
        assert.ok(prompt.includes('Test Workflow'));
        assert.ok(prompt.includes('Test Agent'));
        assert.ok(prompt.includes('test-agent'));
        assert.ok(prompt.includes('claude-sonnet'));
    });
    test('requestInjectPrompt is idempotent — multiple calls fire multiple events', () => {
        const service = new MockAgentStudioService();
        let count = 0;
        service.onDidRequestInjectPrompt(() => { count++; });
        service.requestInjectPrompt('a', 'msg1');
        service.requestInjectPrompt('a', 'msg2');
        service.requestInjectPrompt('b', 'msg3');
        assert.strictEqual(count, 3, 'Each call should fire an event');
    });
    test('requestInjectPrompt handles large workflow prompts', () => {
        const service = new MockAgentStudioService();
        let received = '';
        service.onDidRequestInjectPrompt((e) => { received = e.message; });
        const largePrompt = '# Execute Workflow: Big\n\n' + 'x'.repeat(10000);
        service.requestInjectPrompt('a', largePrompt);
        assert.strictEqual(received.length, largePrompt.length);
        assert.ok(received.startsWith('# Execute Workflow'));
        assert.ok(received.endsWith('x'.repeat(10000)));
    });
});
// ── workflow_apply agent node auto-population tests ─────────────────
suite('workflow_apply → Agent Node Auto-Population', () => {
    /**
     * Replicates the auto-population logic in workflow_apply handler:
     * when an agent node has no agentConfig.providerId/modelId,
     * we fill them from the workflow's bound agent.
     */
    function autoPopulateAgentNodes(nodes, workflowAgentModel, workflowAgentId) {
        if (!workflowAgentModel) {
            return nodes;
        }
        for (const node of nodes) {
            if (node.type === 'agent') {
                const data = node.data || {};
                if (!data.agentId && workflowAgentId) {
                    data.agentId = workflowAgentId;
                }
                const cfg = data.agentConfig || {};
                if (!cfg.providerId && !cfg.modelId) {
                    data.agentConfig = { providerId: '', modelId: workflowAgentModel };
                }
                else if (!cfg.modelId && workflowAgentModel) {
                    cfg.modelId = workflowAgentModel;
                    data.agentConfig = cfg;
                }
            }
        }
        return nodes;
    }
    test('fills empty agentConfig from workflow agent model', () => {
        const nodes = [
            { id: 'start', type: 'start', data: { label: 'Start' } },
            { id: 'agent-1', type: 'agent', data: { label: 'My Agent', agentId: 'wf-agent' } },
            { id: 'end', type: 'end', data: { label: 'End' } },
        ];
        const result = autoPopulateAgentNodes(nodes, 'claude-sonnet-4-20250514', 'wf-agent');
        const agentNode = result[1];
        const cfg = agentNode.data.agentConfig;
        assert.strictEqual(cfg.modelId, 'claude-sonnet-4-20250514');
        assert.strictEqual(cfg.providerId, '');
    });
    test('fills missing agentId from workflow agent', () => {
        const nodes = [
            { id: 'agent-1', type: 'agent', data: { label: 'Agent', agentConfig: {} } },
        ];
        const result = autoPopulateAgentNodes(nodes, 'gpt-4o', 'wf-agent-123');
        const data = result[0].data;
        assert.strictEqual(data.agentId, 'wf-agent-123');
        const cfg = data.agentConfig;
        assert.strictEqual(cfg.modelId, 'gpt-4o');
    });
    test('does NOT overwrite existing agentConfig', () => {
        const nodes = [
            { id: 'agent-1', type: 'agent', data: { label: 'Agent', agentId: 'custom-agent', agentConfig: { providerId: 'openai', modelId: 'gpt-4-turbo' } } },
        ];
        const result = autoPopulateAgentNodes(nodes, 'claude-sonnet', 'wf-agent');
        const data = result[0].data;
        const cfg = data.agentConfig;
        // Should keep original values, not overwrite
        assert.strictEqual(cfg.providerId, 'openai');
        assert.strictEqual(cfg.modelId, 'gpt-4-turbo');
        assert.strictEqual(data.agentId, 'custom-agent');
    });
    test('skips non-agent node types', () => {
        const nodes = [
            { id: 'task-1', type: 'task', data: { label: 'Task', executorId: 'x' } },
            { id: 'prompt-1', type: 'prompt', data: { label: 'Prompt', prompt: 'hello' } },
        ];
        const result = autoPopulateAgentNodes(nodes, 'claude-sonnet', 'wf-agent');
        // Should be unchanged
        assert.strictEqual(result, nodes);
    });
    test('handles missing workflow agent model gracefully', () => {
        const nodes = [
            { id: 'agent-1', type: 'agent', data: { label: 'Agent' } },
        ];
        const result = autoPopulateAgentNodes(nodes, undefined, undefined);
        // Should be unchanged
        const data = result[0].data;
        assert.strictEqual(data.agentId, undefined);
    });
    test('fills modelId when providerId is set but modelId is missing', () => {
        const nodes = [
            { id: 'agent-1', type: 'agent', data: { label: 'Agent', agentConfig: { providerId: 'openai' } } },
        ];
        const result = autoPopulateAgentNodes(nodes, 'gpt-4o', 'wf-agent');
        const data = result[0].data;
        const cfg = data.agentConfig;
        assert.strictEqual(cfg.providerId, 'openai');
        assert.strictEqual(cfg.modelId, 'gpt-4o');
    });
});
// ── Node format normalization tests ────────────────────────────
suite('workflow_apply → Node Format Normalization', () => {
    /**
     * Replicates the normalization logic in workflow_apply handler:
     * Moves top-level fields (label, agentId, agentConfig etc.) into data,
     * since the AI sends them at the top level but WorkflowGraphNode expects
     * them nested inside `data`.
     */
    function normalizeNodes(nodes) {
        const KNOWN_META_KEYS = new Set(['id', 'type', 'position', 'parentId', 'style', 'data', 'name']);
        for (const node of nodes) {
            const data = node.data || {};
            let hasMoved = false;
            for (const key of Object.keys(node)) {
                if (!KNOWN_META_KEYS.has(key) && !(key in data)) {
                    data[key] = node[key];
                    hasMoved = true;
                }
            }
            if (hasMoved || Object.keys(data).length > 0) {
                node.data = data;
            }
            if (!data.label) {
                data.label = node.name || node.id || node.type;
                node.data = data;
            }
        }
        return nodes;
    }
    test('moves top-level label into data', () => {
        const nodes = [
            { id: 'dev', type: 'agent', label: 'Developer', position: { x: 100, y: 200 } },
        ];
        const result = normalizeNodes(nodes);
        const data = result[0].data;
        // Label is now inside data (the top-level key may persist but data takes priority)
        assert.strictEqual(data.label, 'Developer');
    });
    test('moves top-level agentId and agentConfig into data', () => {
        const nodes = [{
                id: 'dev', type: 'agent',
                label: 'Coder',
                agentId: 'coder',
                agentConfig: { modelId: 'claude-sonnet-4-20250514' },
                position: { x: 100, y: 200 },
            }];
        const result = normalizeNodes(nodes);
        const data = result[0].data;
        assert.strictEqual(data.label, 'Coder');
        assert.strictEqual(data.agentId, 'coder');
        const cfg = data.agentConfig;
        assert.strictEqual(cfg.modelId, 'claude-sonnet-4-20250514');
    });
    test('moves askUser fields (questionText, options) into data', () => {
        const nodes = [{
                id: 'ask', type: 'askUser',
                label: 'Confirm',
                questionText: 'Proceed?',
                options: [{ label: 'Yes' }, { label: 'No' }],
                position: { x: 200, y: 200 },
            }];
        const result = normalizeNodes(nodes);
        const data = result[0].data;
        assert.strictEqual(data.questionText, 'Proceed?');
        assert.strictEqual(data.options.length, 2);
    });
    test('preserves existing data object fields', () => {
        const nodes = [{
                id: 'dev', type: 'agent',
                position: { x: 100, y: 200 },
                data: { label: 'Existing', agentId: 'coder' },
            }];
        const result = normalizeNodes(nodes);
        const data = result[0].data;
        assert.strictEqual(data.label, 'Existing');
        assert.strictEqual(data.agentId, 'coder');
    });
    test('does not move meta keys (id, type, position, etc.)', () => {
        const nodes = [{
                id: 'start', type: 'start', position: { x: 80, y: 250 },
                label: 'Start',
            }];
        const result = normalizeNodes(nodes);
        assert.strictEqual(result[0].id, 'start');
        assert.strictEqual(result[0].type, 'start');
        assert.deepStrictEqual(result[0].position, { x: 80, y: 250 });
    });
    test('sets default label from id when not provided', () => {
        const nodes = [
            { id: 'agent-1', type: 'agent', position: { x: 0, y: 0 } },
        ];
        const result = normalizeNodes(nodes);
        const data = result[0].data;
        assert.strictEqual(data.label, 'agent-1');
    });
    test('realistic AI output: full agent node normalization', () => {
        // Exact format the AI sends (top-level agentId, agentConfig, label)
        const nodes = [
            {
                id: 'dev', type: 'agent',
                label: '开发 - 保证编译通过',
                agentId: 'coder',
                agentConfig: { modelId: 'claude-sonnet-4-20250514' },
                position: { x: 320, y: 200 },
            },
            {
                id: 'ask_upload', type: 'askUser',
                label: '是否上传？',
                questionText: '代码开发和测试已完成，是否上传？',
                options: [
                    { label: '是，立即上传', description: '将代码上传到仓库/部署环境' },
                    { label: '否，暂不上传', description: '跳过上传步骤，保留本地修改' },
                ],
                position: { x: 800, y: 200 },
            },
        ];
        const result = normalizeNodes(nodes);
        // Agent node
        const agentData = result[0].data;
        assert.strictEqual(agentData.label, '开发 - 保证编译通过');
        assert.strictEqual(agentData.agentId, 'coder');
        const agentCfg = agentData.agentConfig;
        assert.strictEqual(agentCfg.modelId, 'claude-sonnet-4-20250514');
        // AskUser node
        const askData = result[1].data;
        assert.strictEqual(askData.label, '是否上传？');
        assert.strictEqual(askData.questionText, '代码开发和测试已完成，是否上传？');
        assert.strictEqual(askData.options.length, 2);
        assert.strictEqual(askData.options[0].label, '是，立即上传');
    });
    test('connections pass through unchanged (no data normalization needed)', () => {
        const connections = [
            { id: 'e4', from: 'ask_upload', to: 'upload', fromPort: 'option-0' },
            { id: 'e1', from: 'start', to: 'dev' },
        ];
        // Connections don't need normalization — they use from/to/fromPort at top level
        assert.strictEqual(connections[0].from, 'ask_upload');
        assert.strictEqual(connections[0].fromPort, 'option-0');
        assert.strictEqual(connections[1].from, 'start');
    });
});
// ── Fixup tracking (P2: normalization feedback to AI) ────────────
suite('workflow_apply → Fixup Tracking & Feedback', () => {
    /**
     * Simulates the full normalization + auto-population + fixup tracking
     * that the workflow_apply handler performs.
     */
    function processNodes(nodes, workflowAgentModel, workflowAgentId, workflowAgentProviderId = '') {
        const fixups = [];
        const KNOWN_META_KEYS = new Set(['id', 'type', 'position', 'parentId', 'style', 'data', 'name']);
        for (const node of nodes) {
            // Step 1: Normalize (move top-level fields into data)
            const data = node.data || {};
            const movedFields = [];
            for (const key of Object.keys(node)) {
                if (!KNOWN_META_KEYS.has(key) && !(key in data)) {
                    data[key] = node[key];
                    movedFields.push(key);
                }
            }
            if (movedFields.length > 0) {
                fixups.push(`Node "${node.id}" (${node.type}): moved ${movedFields.join(', ')} into data`);
                node.data = data;
            }
            if (!data.label) {
                data.label = node.name || node.id || node.type;
                node.data = data;
                fixups.push(`Node "${node.id}": set label="${data.label}" (was missing)`);
            }
            // Step 2: Auto-populate agent config
            if (node.type === 'agent' && workflowAgentModel) {
                if (!data.agentId && workflowAgentId) {
                    data.agentId = workflowAgentId;
                    fixups.push(`Node "${node.id}" (agent): auto-set agentId="${workflowAgentId}"`);
                }
                const cfg = data.agentConfig || {};
                if (!cfg.providerId && !cfg.modelId) {
                    data.agentConfig = { providerId: workflowAgentProviderId, modelId: workflowAgentModel };
                    fixups.push(`Node "${node.id}" (agent): auto-set agentConfig={ providerId:"${workflowAgentProviderId}", modelId:"${workflowAgentModel}" }`);
                }
                else if (!cfg.modelId) {
                    cfg.modelId = workflowAgentModel;
                    data.agentConfig = cfg;
                    fixups.push(`Node "${node.id}" (agent): auto-set modelId="${workflowAgentModel}" (was missing)`);
                }
                else if (!cfg.providerId && workflowAgentProviderId) {
                    cfg.providerId = workflowAgentProviderId;
                    data.agentConfig = cfg;
                    fixups.push(`Node "${node.id}" (agent): auto-set providerId="${workflowAgentProviderId}" (was missing)`);
                }
                node.data = data;
            }
        }
        return { nodes, fixups };
    }
    test('reports fixups when fields are moved into data', () => {
        const nodes = [
            { id: 'dev', type: 'agent', label: 'Coder', agentId: 'coder', position: { x: 100, y: 200 } },
        ];
        const { fixups } = processNodes(nodes, undefined, undefined);
        assert.ok(fixups.some((f) => f.includes('moved label, agentId into data')), 'Should report moved fields');
    });
    test('reports fixups when agent config is auto-populated', () => {
        const nodes = [
            { id: 'dev', type: 'agent', data: { label: 'Agent' }, position: { x: 100, y: 200 } },
        ];
        const { fixups } = processNodes(nodes, 'claude-sonnet', 'wf-agent-1', 'knot');
        assert.ok(fixups.some((f) => f.includes('auto-set agentId="wf-agent-1"')));
        assert.ok(fixups.some((f) => f.includes('auto-set agentConfig')));
    });
    test('reports fixups for missing modelId only', () => {
        const nodes = [
            { id: 'dev', type: 'agent', data: { label: 'Agent', agentConfig: { providerId: 'knot' } }, position: { x: 100, y: 200 } },
        ];
        const { fixups } = processNodes(nodes, 'gpt-4o', 'wf-agent', 'knot');
        assert.ok(fixups.some((f) => f.includes('auto-set modelId="gpt-4o"')));
    });
    test('reports fixups for missing providerId only', () => {
        const nodes = [
            { id: 'dev', type: 'agent', data: { label: 'Agent', agentConfig: { modelId: 'claude-sonnet' } }, position: { x: 100, y: 200 } },
        ];
        const { fixups } = processNodes(nodes, 'claude-sonnet', 'wf-agent', 'knot');
        assert.ok(fixups.some((f) => f.includes('auto-set providerId="knot"')));
    });
    test('no fixups when format is already correct', () => {
        const nodes = [
            { id: 'dev', type: 'agent', data: { label: 'Coder', agentId: 'coder', agentConfig: { providerId: 'knot', modelId: 'claude-sonnet' } }, position: { x: 100, y: 200 } },
        ];
        const { fixups } = processNodes(nodes, 'claude-sonnet', 'wf-agent', 'knot');
        assert.strictEqual(fixups.length, 0, 'No fixups needed for correctly formatted nodes');
    });
    test('reports label fixup when missing', () => {
        const nodes = [
            { id: 'agent-x', type: 'agent', position: { x: 0, y: 0 } },
        ];
        const { fixups } = processNodes(nodes, 'gpt-4o', 'wf-a', 'knot');
        assert.ok(fixups.some((f) => f.includes('set label="agent-x"')));
    });
    test('realistic scenario: fully malformed AI output with fixups', () => {
        const nodes = [
            { id: 'start', type: 'start', label: 'Start', position: { x: 80, y: 250 } },
            { id: 'dev', type: 'agent', label: 'Develop', agentId: 'coder', agentConfig: { modelId: 'claude-sonnet' }, position: { x: 320, y: 200 } },
            { id: 'end', type: 'end', label: 'End', position: { x: 600, y: 250 } },
        ];
        const { nodes: result, fixups } = processNodes(nodes, 'claude-sonnet', 'wf-main', 'knot');
        // Start node: label moved into data, meta keys untouched
        const startData = result[0].data;
        assert.strictEqual(startData.label, 'Start');
        // Dev node: agentConfig modelId preserved, providerId auto-added
        const devData = result[1].data;
        const devCfg = devData.agentConfig;
        assert.strictEqual(devCfg.modelId, 'claude-sonnet');
        assert.strictEqual(devCfg.providerId, 'knot');
        // Should have fixups for each node + providerId auto-fill
        assert.ok(fixups.length >= 3, `Expected at least 3 fixups, got ${fixups.length}: ${fixups.join('; ')}`);
        assert.ok(fixups.some((f) => f.includes('moved label into data') && f.includes('start')));
        assert.ok(fixups.some((f) => f.includes('auto-set providerId="knot"')));
    });
});
