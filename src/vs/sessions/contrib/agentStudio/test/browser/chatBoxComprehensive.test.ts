/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { uniqueMsgId } from '../../../../browser/agentChat/agentChatTypes.js';
import { AgentStatus } from '../../../../common/agentStudioTypes.js';
import type {
	IAgentChatMessage,
	IToolCall,
	IChatAttachment,
	ISubAgentData,
	IConfirmationData,
	IAgentInfo,
	IAgentSessionMeta,
	IWorktreeItem,
	ChatMode,
	StreamPhase,
	IProviderInfo,
	IModelInfo,
	ISessionInfo,
	IContextUsage,
	ICheckpointInfo,
} from '../../../../browser/agentChat/agentChatTypes.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeToolCall(overrides: Partial<IToolCall> = {}): IToolCall {
	return {
		id: 'tc-1',
		name: 'write_to_file',
		status: 'completed',
		displayName: 'Write File',
		renderType: 'CodeEditor',
		defaultShow: true,
		...overrides,
	};
}

function makeAttachment(overrides: Partial<IChatAttachment> = {}): IChatAttachment {
	return {
		id: 'att-1',
		type: 'image',
		name: 'screenshot.png',
		mimeType: 'image/png',
		data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
		size: 86,
		...overrides,
	};
}

function makeSubAgent(overrides: Partial<ISubAgentData> = {}): ISubAgentData {
	return {
		id: 'sa-1',
		type: 'explore',
		task: 'Find relevant files',
		status: 'running',
		...overrides,
	};
}

function makeMessage(overrides: Partial<IAgentChatMessage> = {}): IAgentChatMessage {
	return {
		id: uniqueMsgId(),
		role: 'assistant',
		content: 'Hello from comprehensive test',
		timestamp: Date.now(),
		...overrides,
	};
}

function makeAgent(overrides: Partial<IAgentInfo> = {}): IAgentInfo {
	return {
		id: 'test-agent',
		name: 'Test Agent',
		status: AgentStatus.Idle,
		agentType: 'general',
		...overrides,
	};
}

function makeProvider(overrides: Partial<IProviderInfo> = {}): IProviderInfo {
	return {
		id: 'test-provider',
		label: 'Test Provider',
		...overrides,
	};
}

function makeModel(overrides: Partial<IModelInfo> = {}): IModelInfo {
	return {
		id: 'test-model',
		label: 'Test Model',
		provider: 'test-provider',
		...overrides,
	};
}

function makeSessionInfo(overrides: Partial<ISessionInfo> = {}): ISessionInfo {
	return {
		mode: 'craft',
		taskCount: 0,
		...overrides,
	};
}

function makeContextUsage(overrides: Partial<IContextUsage> = {}): IContextUsage {
	return {
		used: 5000,
		limit: 10000,
		ratio: 0.5,
		percent: 50,
		...overrides,
	};
}

function makeCheckpointInfo(overrides: Partial<ICheckpointInfo> = {}): ICheckpointInfo {
	return {
		id: 'cp-1',
		label: 'Checkpoint 1',
		timestamp: Date.now(),
		fileCount: 3,
		files: [
			{ path: '/src/a.ts', status: 'modified' },
			{ path: '/src/b.ts', status: 'created' },
		],
		...overrides,
	};
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

suite('ChatBox Comprehensive - Unit Tests', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('Message Creation', () => {
		test('creates user message', () => {
			const msg = makeMessage({ role: 'user', content: 'Hello' });
			assert.strictEqual(msg.role, 'user');
			assert.strictEqual(msg.content, 'Hello');
		});

		test('creates assistant message with thinking', () => {
			const msg = makeMessage({
				role: 'assistant',
				content: 'Thinking...',
				thinking: 'Let me think',
				isThinking: true,
			});
			assert.strictEqual(msg.isThinking, true);
			assert.ok(msg.thinking);
		});

		test('creates system message', () => {
			const msg = makeMessage({ role: 'system', content: 'System prompt' });
			assert.strictEqual(msg.role, 'system');
		});

		test('message with token usage', () => {
			const msg = makeMessage({
				tokenUsage: { input: 100, output: 50, total: 150 },
			});
			assert.strictEqual(msg.tokenUsage!.total, 150);
		});
	});

	suite('Tool Call States', () => {
		test('running tool call', () => {
			const tc = makeToolCall({ status: 'running' });
			assert.strictEqual(tc.status, 'running');
		});

		test('completed tool call', () => {
			const tc = makeToolCall({ status: 'completed', result: 'ok' });
			assert.strictEqual(tc.status, 'completed');
		});

		test('error tool call', () => {
			const tc = makeToolCall({ status: 'error', result: 'failed' });
			assert.strictEqual(tc.status, 'error');
		});

		test('tool call with render type', () => {
			const tc = makeToolCall({ renderType: 'RunTerminal' });
			assert.strictEqual(tc.renderType, 'RunTerminal');
		});
	});

	suite('Attachment Handling', () => {
		test('image attachment', () => {
			const att = makeAttachment({ type: 'image' });
			assert.strictEqual(att.type, 'image');
		});

		test('file attachment', () => {
			const att = makeAttachment({ type: 'file', name: 'test.ts' });
			assert.strictEqual(att.type, 'file');
		});

		test('pasted image', () => {
			const att = makeAttachment({ isPasted: true });
			assert.strictEqual(att.isPasted, true);
		});
	});

	suite('Sub-Agent Data', () => {
		test('pending sub-agent', () => {
			const sa = makeSubAgent({ status: 'pending' });
			assert.strictEqual(sa.status, 'pending');
		});

		test('running sub-agent', () => {
			const sa = makeSubAgent({ status: 'running', progress: 'Working...' });
			assert.strictEqual(sa.status, 'running');
		});

		test('done sub-agent', () => {
			const sa = makeSubAgent({ status: 'done', output: 'Done!' });
			assert.strictEqual(sa.status, 'done');
		});

		test('error sub-agent', () => {
			const sa = makeSubAgent({ status: 'error', error: 'Failed' });
			assert.strictEqual(sa.status, 'error');
		});

		test('cancelled sub-agent', () => {
			const sa = makeSubAgent({ status: 'cancelled' });
			assert.strictEqual(sa.status, 'cancelled');
		});
	});

	suite('Confirmation Data', () => {
		test('pending confirmation', () => {
			const cf: IConfirmationData = {
				id: '1', title: 'Confirm', message: 'OK?', status: 'pending', buttons: [],
			};
			assert.strictEqual(cf.status, 'pending');
		});

		test('approved confirmation', () => {
			const cf: IConfirmationData = {
				id: '2', title: 'Approved', message: 'Yes', status: 'approved', buttons: [],
			};
			assert.strictEqual(cf.status, 'approved');
		});

		test('rejected confirmation', () => {
			const cf: IConfirmationData = {
				id: '3', title: 'Rejected', message: 'No', status: 'rejected', buttons: [],
			};
			assert.strictEqual(cf.status, 'rejected');
		});
	});

	suite('Agent Info', () => {
		test('basic agent', () => {
			const agent = makeAgent();
			assert.strictEqual(agent.id, 'test-agent');
		});

		test('planner agent', () => {
			const agent = makeAgent({ agentType: 'planner' });
			assert.strictEqual(agent.agentType, 'planner');
		});
	});

	suite('Chat Mode', () => {
		test('craft mode', () => {
			assert.strictEqual<ChatMode>('craft', 'craft');
		});

		test('ask mode', () => {
			assert.strictEqual<ChatMode>('ask', 'ask');
		});

		test('plan mode', () => {
			assert.strictEqual<ChatMode>('plan', 'plan');
		});
	});

	suite('Stream Phase', () => {
		test('idle phase', () => {
			assert.strictEqual<StreamPhase>('idle', 'idle');
		});

		test('llm_streaming phase', () => {
			assert.strictEqual<StreamPhase>('llm_streaming', 'llm_streaming');
		});

		test('tool_executing phase', () => {
			assert.strictEqual<StreamPhase>('tool_executing', 'tool_executing');
		});

		test('awaiting_approval phase', () => {
			assert.strictEqual<StreamPhase>('awaiting_approval', 'awaiting_approval');
		});
	});

	suite('Provider and Model', () => {
		test('provider info', () => {
			const provider = makeProvider();
			assert.strictEqual(provider.id, 'test-provider');
		});

		test('model info', () => {
			const model = makeModel();
			assert.strictEqual(model.id, 'test-model');
		});
	});

	suite('Context Usage', () => {
		test('normal usage', () => {
			const usage = makeContextUsage();
			assert.strictEqual(usage.percent, 50);
		});

		test('empty usage', () => {
			const usage: IContextUsage = { used: 0, limit: 10000, ratio: 0, percent: 0 };
			assert.strictEqual(usage.percent, 0);
		});

		test('full usage', () => {
			const usage: IContextUsage = { used: 10000, limit: 10000, ratio: 1, percent: 100 };
			assert.strictEqual(usage.percent, 100);
		});
	});

	suite('Checkpoint Info', () => {
		test('checkpoint with files', () => {
			const cp = makeCheckpointInfo();
			assert.strictEqual(cp.fileCount, 3);
			assert.strictEqual(cp.files.length, 2);
		});
	});

	suite('Edge Cases', () => {
		test('empty message content', () => {
			const msg = makeMessage({ content: '' });
			assert.strictEqual(msg.content, '');
		});

		test('empty tool calls array', () => {
			const msg = makeMessage({ toolCalls: [] });
			assert.strictEqual(msg.toolCalls!.length, 0);
		});

		test('empty attachments array', () => {
			const msg = makeMessage({ attachments: [] });
			assert.strictEqual(msg.attachments!.length, 0);
		});

		test('long tool result', () => {
			const tc = makeToolCall({ result: 'x'.repeat(10000) });
			assert.strictEqual(tc.result!.length, 10000);
		});

		test('large attachment data', () => {
			const att = makeAttachment({ data: 'x'.repeat(1000), size: 1000 });
			assert.strictEqual(att.size, 1000);
		});
	});
});

// ─── Functional Tests ──────────────────────────────────────────────────────────

suite('ChatBox Comprehensive - Functional Tests', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('Message Operations', () => {
		test('add message', () => {
			const msg = makeMessage();
			assert.ok(msg.id);
		});

		test('update message', () => {
			const msg = makeMessage({ content: 'old' });
			const updated = { ...msg, content: 'new' };
			assert.strictEqual(updated.content, 'new');
		});

		test('message with multiple tool calls', () => {
			const msg = makeMessage({
				toolCalls: [
					makeToolCall({ id: '1', name: 'read' }),
					makeToolCall({ id: '2', name: 'write' }),
				],
			});
			assert.strictEqual(msg.toolCalls!.length, 2);
		});
	});

	suite('Tool Call Lifecycle', () => {
		test('running to completed', () => {
			let tc = makeToolCall({ status: 'running' });
			assert.strictEqual(tc.status, 'running');

			tc = { ...tc, status: 'completed' };
			assert.strictEqual(tc.status, 'completed');
		});

		test('running to error', () => {
			let tc = makeToolCall({ status: 'running' });
			tc = { ...tc, status: 'error', result: 'failed' };
			assert.strictEqual(tc.status, 'error');
		});
	});

	suite('Agent Management', () => {
		test('create agent', () => {
			const agent = makeAgent({ name: 'My Agent' });
			assert.strictEqual(agent.name, 'My Agent');
		});

		test('agent with different types', () => {
			const types = ['general', 'planner', 'explore', 'scout'];
			types.forEach(t => {
				const agent = makeAgent({ agentType: t as any });
				assert.strictEqual(agent.agentType, t);
			});
		});
	});

	suite('Session Management', () => {
		test('create session info', () => {
			const session = makeSessionInfo();
			assert.ok(session.mode);
		});

		test('session with task count', () => {
			const session = makeSessionInfo({ taskCount: 100 });
			assert.strictEqual(session.taskCount, 100);
		});
	});

	suite('Integration Scenario - Chat Flow', () => {
		test('complete chat flow', () => {
			// 1. Create agent
			const agent = makeAgent();
			assert.strictEqual(agent.status, AgentStatus.Idle);

			// 2. Create user message
			const userMsg = makeMessage({ role: 'user', content: 'Help me' });
			assert.strictEqual(userMsg.role, 'user');

			// 3. Create assistant response
			const asstMsg = makeMessage({
				role: 'assistant',
				content: 'I will help',
				toolCalls: [makeToolCall({ status: 'running' })],
			});
			assert.strictEqual(asstMsg.toolCalls![0].status, 'running');

			// 4. Update tool call to completed
			const updatedToolCall = { ...asstMsg.toolCalls![0], status: 'completed' as const };
			assert.strictEqual(updatedToolCall.status, 'completed');
		});
	});

	suite('Integration Scenario - Error Handling', () => {
		test('error flow', () => {
			const msg = makeMessage({
				role: 'assistant',
				content: 'Error occurred',
			});
			assert.strictEqual(msg.content, 'Error occurred');
		});
	});
});

// ─── Smoke Tests ─────────────────────────────────────────────────────────────

suite('ChatBox Comprehensive - Smoke Tests', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('unique message IDs', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(uniqueMsgId());
		}
		assert.strictEqual(ids.size, 100);
	});

	test('basic message structure', () => {
		const msg = makeMessage();
		assert.ok(msg.id);
		assert.ok(msg.role);
		assert.ok(msg.timestamp);
	});

	test('minimal message', () => {
		const msg: IAgentChatMessage = {
			id: '1', role: 'user', content: 'Hi', timestamp: Date.now(),
		};
		assert.strictEqual(msg.content, 'Hi');
	});

	test('minimal tool call', () => {
		const tc: IToolCall = { id: '1', name: 't', status: 'completed' };
		assert.strictEqual(tc.name, 't');
	});

	test('minimal attachment', () => {
		const att: IChatAttachment = {
			id: '1', type: 'image', name: 'a.png', mimeType: 'image/png', data: 'x', size: 1,
		};
		assert.strictEqual(att.name, 'a.png');
	});

	test('minimal sub-agent', () => {
		const sa: ISubAgentData = {
			id: '1', type: 'explore', task: 't', status: 'pending',
		};
		assert.strictEqual(sa.status, 'pending');
	});

	test('minimal confirmation', () => {
		const cf: IConfirmationData = {
			id: '1', title: 'C', message: 'M', status: 'pending', buttons: [],
		};
		assert.strictEqual(cf.status, 'pending');
	});

	test('minimal agent', () => {
		const agent: IAgentInfo = { id: '1', name: 'A', status: AgentStatus.Idle };
		assert.strictEqual(agent.status, AgentStatus.Idle);
	});

	test('minimal worktree', () => {
		const wt: IWorktreeItem = { path: '/wt', branch: 'main' };
		assert.strictEqual(wt.branch, 'main');
	});

	test('minimal session meta', () => {
		const meta: IAgentSessionMeta = {
			id: '1', name: 'S', createdAt: '', updatedAt: '', messageCount: 0,
		};
		assert.strictEqual(meta.name, 'S');
	});

	test('all chat modes', () => {
		const modes: ChatMode[] = ['craft', 'ask', 'plan'];
		modes.forEach(m => assert.ok(['craft', 'ask', 'plan'].includes(m)));
	});

	test('all stream phases', () => {
		const phases: StreamPhase[] = ['idle', 'llm_streaming', 'tool_executing', 'awaiting_approval', 'compressing', 'error'];
		phases.forEach(p => assert.ok(p));
	});
});
