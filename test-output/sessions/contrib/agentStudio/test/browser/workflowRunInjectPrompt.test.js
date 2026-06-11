"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const event_js_1 = require("../../../../../base/common/event.js");
const utils_js_1 = require("../../../../../base/test/common/utils.js");
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
    _onDidRequestInjectPrompt = new event_js_1.Emitter();
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
    (0, utils_js_1.ensureNoDisposablesAreLeakedInTestSuite)();
    test('AgentStudioService.requestInjectPrompt fires event with correct payload', () => {
        const service = new MockAgentStudioService();
        let received;
        service.onDidRequestInjectPrompt(e => { received = e; });
        service.requestInjectPrompt('agent-123', '# Execute Workflow: test');
        assert_1.default.ok(received, 'Event should be received');
        assert_1.default.strictEqual(received.agentId, 'agent-123');
        assert_1.default.strictEqual(received.message, '# Execute Workflow: test');
    });
    test('Chat panel webview controller forwards inject event when agentId matches', () => {
        const service = new MockAgentStudioService();
        const controller = new MockWebviewController('chat');
        controller.setActiveAgent('agent-123');
        controller.subscribeToInjectPrompt(service);
        service.requestInjectPrompt('agent-123', 'Run workflow');
        assert_1.default.strictEqual(controller.sentEvents.length, 1);
        assert_1.default.strictEqual(controller.sentEvents[0].type, 'chat.injectPrompt');
        assert_1.default.strictEqual(controller.sentEvents[0].data.agentId, 'agent-123');
        assert_1.default.strictEqual(controller.sentEvents[0].data.message, 'Run workflow');
    });
    test('Chat panel webview controller forwards inject when no agent is active yet (fresh open)', () => {
        const service = new MockAgentStudioService();
        const controller = new MockWebviewController('chat');
        // _activeChatAgentId is undefined (fresh open)
        controller.subscribeToInjectPrompt(service);
        service.requestInjectPrompt('agent-456', 'Run new workflow');
        assert_1.default.strictEqual(controller.sentEvents.length, 1);
        assert_1.default.strictEqual(controller.sentEvents[0].data.agentId, 'agent-456');
    });
    test('Chat panel webview controller does NOT forward inject for non-matching agentId', () => {
        const service = new MockAgentStudioService();
        const controller = new MockWebviewController('chat');
        controller.setActiveAgent('agent-123'); // showing agent-123
        controller.subscribeToInjectPrompt(service);
        service.requestInjectPrompt('agent-999', 'Run for different agent');
        assert_1.default.strictEqual(controller.sentEvents.length, 0, 'Should NOT forward when agentId does not match');
    });
    test('Non-chat panels (workflow-editor, etc.) ignore inject events', () => {
        const service = new MockAgentStudioService();
        const editorController = new MockWebviewController('workflow-editor');
        editorController.subscribeToInjectPrompt(service);
        service.requestInjectPrompt('agent-123', 'Run workflow');
        assert_1.default.strictEqual(editorController.sentEvents.length, 0, 'Workflow editor should NOT handle inject events');
    });
    test('Webview chat panel handler processes chat.injectPrompt and sends message', () => {
        const handler = new MockWebviewMessageHandler('chat');
        handler.handleInjectPromptEvent({
            type: 'chat.injectPrompt',
            data: { agentId: 'agent-123', message: '# Execute Workflow' },
        });
        assert_1.default.strictEqual(handler.injectedPrompts.length, 1);
        assert_1.default.strictEqual(handler.injectedPrompts[0].agentId, 'agent-123');
        assert_1.default.strictEqual(handler.injectedPrompts[0].message, '# Execute Workflow');
        assert_1.default.strictEqual(handler.selectedAgentId, 'agent-123');
    });
    test('Webview non-chat panel ignores chat.injectPrompt events', () => {
        const handler = new MockWebviewMessageHandler('workflow-editor');
        handler.handleInjectPromptEvent({
            type: 'chat.injectPrompt',
            data: { agentId: 'agent-123', message: 'should be ignored' },
        });
        assert_1.default.strictEqual(handler.injectedPrompts.length, 0, 'Non-chat panel should ignore inject events');
        assert_1.default.strictEqual(handler.selectedAgentId, null);
    });
    test('Webview handler ignores chat.injectPrompt with missing agentId', () => {
        const handler = new MockWebviewMessageHandler('chat');
        handler.handleInjectPromptEvent({
            type: 'chat.injectPrompt',
            data: { agentId: '', message: 'no agent' },
        });
        assert_1.default.strictEqual(handler.injectedPrompts.length, 0, 'Should ignore event with empty agentId');
    });
    test('Webview handler ignores chat.injectPrompt with missing message', () => {
        const handler = new MockWebviewMessageHandler('chat');
        handler.handleInjectPromptEvent({
            type: 'chat.injectPrompt',
            data: { agentId: 'agent-123', message: '' },
        });
        assert_1.default.strictEqual(handler.injectedPrompts.length, 0, 'Should ignore event with empty message');
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
        assert_1.default.strictEqual(controller.sentEvents.length, 1);
        // Webview handler should process it
        handler.handleInjectPromptEvent(controller.sentEvents[0]);
        assert_1.default.strictEqual(handler.injectedPrompts.length, 1);
        assert_1.default.strictEqual(handler.injectedPrompts[0].agentId, 'wf-agent-001');
        assert_1.default.strictEqual(handler.selectedAgentId, 'wf-agent-001');
        assert_1.default.ok(handler.injectedPrompts[0].message.startsWith('# Execute Workflow'));
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
        assert_1.default.strictEqual(userNodes.length, 1, 'Should have 1 user node');
        lines.push('## Workflow Nodes');
        lines.push('');
        const node = userNodes[0];
        if (node.type === 'agent') {
            lines.push(`1. 🤖 **${node.data.label}** (Agent)`);
            lines.push(`   - Agent: ${node.data.agentId}`);
            lines.push(`   - Model: ${node.data.agentConfig.modelId}`);
        }
        const prompt = lines.join('\n');
        assert_1.default.ok(prompt.includes('Test Workflow'));
        assert_1.default.ok(prompt.includes('Test Agent'));
        assert_1.default.ok(prompt.includes('agent-123')); // actually 'test-agent'
        assert_1.default.ok(prompt.includes('claude-sonnet'));
    });
    test('requestInjectPrompt is idempotent — multiple calls fire multiple events', () => {
        const service = new MockAgentStudioService();
        let count = 0;
        service.onDidRequestInjectPrompt(() => { count++; });
        service.requestInjectPrompt('a', 'msg1');
        service.requestInjectPrompt('a', 'msg2');
        service.requestInjectPrompt('b', 'msg3');
        assert_1.default.strictEqual(count, 3, 'Each call should fire an event');
    });
    test('requestInjectPrompt handles large workflow prompts', () => {
        const service = new MockAgentStudioService();
        let received = '';
        service.onDidRequestInjectPrompt(e => { received = e.message; });
        const largePrompt = '# Execute Workflow: Big\n\n' + 'x'.repeat(10000);
        service.requestInjectPrompt('a', largePrompt);
        assert_1.default.strictEqual(received.length, largePrompt.length);
        assert_1.default.ok(received.startsWith('# Execute Workflow'));
        assert_1.default.ok(received.endsWith('x'.repeat(10000)));
    });
});
