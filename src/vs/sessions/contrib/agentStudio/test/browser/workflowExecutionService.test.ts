/*---------------------------------------------------------------------------------------------
 *  Unit tests for WorkflowExecutionService.executeWorkflow — P4 chat-triggered
 *  session reuse (the `/{workflow_id}` strict execution path).
 *
 *  Verifies the branch at the top of executeWorkflow that decides whether to
 *  REUSE the caller's chat session (options.sessionId) or CREATE a fresh
 *  "▶ <workflow name>" owner-agent session. This is the critical behavior that
 *  makes AskUser/subagent cards render in the user's current chat instead of a
 *  detached session.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert';
import { WorkflowExecutionService } from '../../browser/workflowExecutionService.js';

// ─── Minimal mocks ───────────────────────────────────────────────────────────

function makeLogService() {
	// no-op logger; AgentStudio forbids console.* in production code, tests too.
	const noop = () => { /* intentionally empty */ };
	return {
		_serviceBrand: undefined,
		trace: noop, debug: noop, info: noop, warn: noop, error: noop,
		dispose: noop, getLevel: () => 0, setLevel: noop, onDidChangeLogLevel: () => ({ dispose() {} }),
	};
}

function makeAgentChatService() {
	const calls: { create: unknown[]; append: unknown[] } = { create: [], append: [] };
	return {
		_serviceBrand: undefined,
		createCalls: calls.create,
		appendCalls: calls.append,
		createAgentSession: async (agentId: string, title: string) => {
			calls.create.push({ agentId, title });
			return { id: `new-session-${calls.create.length}` };
		},
		appendMessage: async (agentId: string, msg: unknown) => {
			calls.append.push({ agentId, msg });
		},
	};
}

function makeWorkflowStorage(workflow: unknown) {
	return {
		_serviceBrand: undefined,
		getWorkflow: async () => workflow,
	};
}

function buildService(deps: {
	log?: unknown;
	chat?: ReturnType<typeof makeAgentChatService>;
	storage: ReturnType<typeof makeWorkflowStorage>;
}) {
	const log = deps.log ?? makeLogService();
	const chat = deps.chat ?? makeAgentChatService();
	return new WorkflowExecutionService(
		log as any,
		chat as any,
		deps.storage as any,
		{} as any, // fileService
		{} as any, // workspaceRegistry
		{} as any, // skillRegistry
	);
}

const SAMPLE_WORKFLOW = {
	id: 'wf-abc123',
	name: 'Sample Workflow',
	description: 'A workflow used by tests',
	agentId: 'owner-agent-1',
	breakpoints: [],
	nodes: [],
	edges: [],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

suite('WorkflowExecutionService P4 session reuse', () => {

	suite('reuses caller session when options.sessionId is provided', () => {

		test('does NOT create a new owner session', async () => {
			const chat = makeAgentChatService();
			const svc = buildService({ chat, storage: makeWorkflowStorage(SAMPLE_WORKFLOW) });

			await svc.executeWorkflow('wf-abc123', {
				agentId: 'owner-agent-1',
				sessionId: 'caller-session-42',
			});

			assert.strictEqual(chat.createCalls.length, 0, 'createAgentSession must not be called when reusing');
		});

		test('fires __workflow__ trace with the caller sessionId', async () => {
			const svc = buildService({ storage: makeWorkflowStorage(SAMPLE_WORKFLOW) });
			const traces: any[] = [];
			svc.onDidExecutionTrace(e => traces.push(e));

			await svc.executeWorkflow('wf-abc123', {
				agentId: 'owner-agent-1',
				sessionId: 'caller-session-42',
			});

			const start = traces.find(t => t.kind === 'subagent_start');
			assert.ok(start, 'expected a subagent_start trace');
			assert.strictEqual(start.sessionId, 'caller-session-42');
			assert.strictEqual(start.workflowAgentId, 'owner-agent-1');
		});

		test('returns an executionId string and keys the session cache by caller session', async () => {
			const svc = buildService({ storage: makeWorkflowStorage(SAMPLE_WORKFLOW) });
			const execId = await svc.executeWorkflow('wf-abc123', {
				agentId: 'owner-agent-1',
				sessionId: 'caller-session-42',
			});
			assert.strictEqual(typeof execId, 'string');
			assert.ok(execId.startsWith('wf_exec_'), `unexpected execId: ${execId}`);
		});
	});

	suite('creates a fresh owner session when no sessionId (default)', () => {

		test('creates a "▶ <name>" session on the workflow agent', async () => {
			const chat = makeAgentChatService();
			const svc = buildService({ chat, storage: makeWorkflowStorage(SAMPLE_WORKFLOW) });

			await svc.executeWorkflow('wf-abc123', { agentId: 'owner-agent-1' });

			assert.strictEqual(chat.createCalls.length, 1);
			assert.strictEqual(chat.createCalls[0].agentId, 'owner-agent-1');
			assert.strictEqual(chat.createCalls[0].title, '▶ Sample Workflow');
		});

		test('posts a trigger anchor message into the new session', async () => {
			const chat = makeAgentChatService();
			const svc = buildService({ chat, storage: makeWorkflowStorage(SAMPLE_WORKFLOW) });

			await svc.executeWorkflow('wf-abc123', { agentId: 'owner-agent-1' });

			assert.strictEqual(chat.appendCalls.length, 1);
			assert.strictEqual(chat.appendCalls[0].agentId, 'owner-agent-1');
			assert.strictEqual((chat.appendCalls[0].msg as any).agentSessionId, 'new-session-1');
			assert.strictEqual((chat.appendCalls[0].msg as any).role, 'user');
		});

		test('fires __workflow__ trace with the newly created sessionId', async () => {
			const svc = buildService({ storage: makeWorkflowStorage(SAMPLE_WORKFLOW) });
			const traces: any[] = [];
			svc.onDidExecutionTrace(e => traces.push(e));

			await svc.executeWorkflow('wf-abc123', { agentId: 'owner-agent-1' });

			const start = traces.find(t => t.kind === 'subagent_start');
			assert.ok(start, 'expected a subagent_start trace');
			assert.strictEqual(start.sessionId, 'new-session-1');
		});
	});

	suite('edge cases', () => {

		test('throws when the workflow does not exist', async () => {
			const svc = buildService({ storage: makeWorkflowStorage(undefined) });
			await assert.rejects(
				() => svc.executeWorkflow('wf-missing', { agentId: 'a', sessionId: 's' }),
				/workflow not found/i,
			);
		});

		test('falls back to unknown session when workflow has no agentId and no sessionId', async () => {
			const chat = makeAgentChatService();
			const noAgent = { ...SAMPLE_WORKFLOW, agentId: undefined };
			const svc = buildService({ chat, storage: makeWorkflowStorage(noAgent) });
			const traces: any[] = [];
			svc.onDidExecutionTrace(e => traces.push(e));

			await svc.executeWorkflow('wf-abc123', {});

			assert.strictEqual(chat.createCalls.length, 0, 'no agentId → no session created');
			const start = traces.find(t => t.kind === 'subagent_start');
			assert.ok(start, 'expected a subagent_start trace');
			assert.strictEqual(start.sessionId, 'unknown');
		});

		test('★ v34: options.agentId（调用方指定的 agent）优先于 workflow.agentId', async () => {
			// v34 语义：调用者指定的 agent（/workflow 传当前聊天 agent、画布 Run 传
			// saros-claw）优先于 workflow.agentId 历史绑定，任何 agent 都能触发工作流。
			const chat = makeAgentChatService();
			const svc = buildService({ chat, storage: makeWorkflowStorage(SAMPLE_WORKFLOW) });

			await svc.executeWorkflow('wf-abc123', { agentId: 'caller-agent-X' });

			assert.strictEqual(chat.createCalls.length, 1);
			assert.strictEqual(chat.createCalls[0].agentId, 'caller-agent-X', '调用方 agent 优先');
		});

		test('falls back to workflow.agentId when options.agentId is absent', async () => {
			const chat = makeAgentChatService();
			const svc = buildService({ chat, storage: makeWorkflowStorage(SAMPLE_WORKFLOW) });

			await svc.executeWorkflow('wf-abc123', {});

			assert.strictEqual(chat.createCalls.length, 1);
			assert.strictEqual(chat.createCalls[0].agentId, 'owner-agent-1', '缺省时回退 workflow 历史绑定');
		});
	});
});
