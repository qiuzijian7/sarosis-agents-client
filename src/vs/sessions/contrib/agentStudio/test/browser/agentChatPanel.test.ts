/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { uniqueMsgId } from '../../../../browser/agentChat/agentChatTypes.js';
import type {
	IAgentChatMessage,
	IToolCall,
	IChatAttachment,
	ISubAgentData,
	IConfirmationData,
	IAgentInfo,
	IAgentSessionMeta,
	IWorktreeItem,
	IMessageNavItem,
	AgentStatus,
	ChatMode,
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
		content: 'Hello from native chat panel',
		timestamp: Date.now(),
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

suite('AgentChatPanel — Types & Data Structures', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ── uniqueMsgId ─────────────────────────────────────────────────────

	suite('uniqueMsgId()', () => {
		test('generates unique IDs', () => {
			const ids = new Set<string>();
			for (let i = 0; i < 1000; i++) {
				ids.add(uniqueMsgId());
			}
			assert.strictEqual(ids.size, 1000, 'All generated IDs must be unique');
		});

		test('generates string IDs', () => {
			const id = uniqueMsgId();
			assert.strictEqual(typeof id, 'string');
			assert.ok(id.length > 0, 'ID must not be empty');
		});

		test('IDs are monotonically diverse (no clustering)', () => {
			const ids: string[] = [];
			for (let i = 0; i < 20; i++) {
				ids.push(uniqueMsgId());
			}
			const sorted = [...ids].sort();
			// After sorting, first and last should differ (no all-same-value bug)
			assert.notStrictEqual(sorted[0], sorted[sorted.length - 1], 'IDs should vary');
		});
	});

	// ── IAgentChatMessage ────────────────────────────────────────────────

	suite('IAgentChatMessage', () => {
		test('basic message structure', () => {
			const msg = makeMessage();
			assert.strictEqual(typeof msg.id, 'string');
			assert.ok(['user', 'assistant', 'system'].includes(msg.role));
			assert.strictEqual(typeof msg.content, 'string');
			assert.strictEqual(typeof msg.timestamp, 'number');
		});

		test('user message', () => {
			const msg = makeMessage({ role: 'user', content: 'Help me write code' });
			assert.strictEqual(msg.role, 'user');
			assert.strictEqual(msg.content, 'Help me write code');
		});

		test('streaming assistant message', () => {
			const msg = makeMessage({
				role: 'assistant',
				content: 'Partial...',
				isStreaming: true,
				isThinking: false,
				currentStep: 'llm_streaming',
			});
			assert.strictEqual(msg.isStreaming, true);
			assert.strictEqual(msg.currentStep, 'llm_streaming');
		});

		test('thinking message', () => {
			const msg = makeMessage({
				role: 'assistant',
				thinking: 'Let me think about this...',
				isThinking: true,
				currentStep: 'thinking',
			});
			assert.strictEqual(msg.isThinking, true);
			assert.ok(msg.thinking!.length > 0);
		});

		test('message with token usage', () => {
			const msg = makeMessage({
				tokenUsage: { input: 500, output: 200, total: 700 },
			});
			assert.strictEqual(msg.tokenUsage!.input, 500);
			assert.strictEqual(msg.tokenUsage!.output, 200);
			assert.strictEqual(msg.tokenUsage!.total, 700);
		});

		test('message with tool calls', () => {
			const tc = makeToolCall();
			const msg = makeMessage({ toolCalls: [tc] });
			assert.strictEqual(msg.toolCalls!.length, 1);
			assert.strictEqual(msg.toolCalls![0].name, 'write_to_file');
		});

		test('message with attachments', () => {
			const att = makeAttachment();
			const msg = makeMessage({ role: 'user', attachments: [att] });
			assert.strictEqual(msg.attachments!.length, 1);
			assert.strictEqual(msg.attachments![0].type, 'image');
			assert.strictEqual(msg.attachments![0].name, 'screenshot.png');
		});

		test('message with sub-agents', () => {
			const sa = makeSubAgent();
			const msg = makeMessage({ subAgents: [sa] });
			assert.strictEqual(msg.subAgents!.length, 1);
			assert.strictEqual(msg.subAgents![0].status, 'running');
		});

		test('message with confirmation', () => {
			const cf: IConfirmationData = {
				id: 'cf-1',
				title: 'Run terminal command?',
				message: 'The agent wants to run: npm install',
				status: 'pending',
				buttons: [
					{ id: 'approve', label: 'Approve', primary: true },
					{ id: 'reject', label: 'Reject', danger: true },
				],
			};
			const msg = makeMessage({ confirmation: cf });
			assert.strictEqual(msg.confirmation!.status, 'pending');
			assert.strictEqual(msg.confirmation!.buttons.length, 2);
		});
	});

	// ── IToolCall ────────────────────────────────────────────────────────

	suite('IToolCall', () => {
		test('running tool call', () => {
			const tc = makeToolCall({ status: 'running', args: '{"path":"/src/app.ts"}' });
			assert.strictEqual(tc.status, 'running');
			assert.ok(tc.args!.includes('path'));
		});

		test('completed tool call with display name and render type', () => {
			const tc = makeToolCall({
				status: 'completed',
				displayName: 'Run Terminal',
				renderType: 'RunTerminal',
				result: 'Command executed successfully',
			});
			assert.strictEqual(tc.displayName, 'Run Terminal');
			assert.strictEqual(tc.renderType, 'RunTerminal');
			assert.strictEqual(tc.result, 'Command executed successfully');
		});

		test('tool call defaultShow=false (collapsed)', () => {
			const tc = makeToolCall({ defaultShow: false });
			assert.strictEqual(tc.defaultShow, false);
		});

		test('tool call with no result (running state)', () => {
			const tc = makeToolCall({ status: 'running', result: undefined });
			assert.strictEqual(tc.status, 'running');
			assert.strictEqual(tc.result, undefined);
		});

		test('multiple tool calls in sequence', () => {
			const calls: IToolCall[] = [
				makeToolCall({ id: '1', name: 'read_file' }),
				makeToolCall({ id: '2', name: 'write_to_file', status: 'running', result: undefined }),
				makeToolCall({ id: '3', name: 'terminal', renderType: 'RunTerminal' }),
			];
			assert.strictEqual(calls.length, 3);
			assert.strictEqual(calls[0].status, 'completed');
			assert.strictEqual(calls[1].status, 'running');
			assert.strictEqual(calls[2].renderType, 'RunTerminal');
		});
	});

	// ── IChatAttachment ──────────────────────────────────────────────────

	suite('IChatAttachment', () => {
		test('image attachment', () => {
			const att = makeAttachment({ type: 'image', mimeType: 'image/png' });
			assert.strictEqual(att.type, 'image');
			assert.ok(att.data.length > 0, 'Image data must have base64 content');
		});

		test('file attachment', () => {
			const att = makeAttachment({
				type: 'file',
				name: 'README.md',
				mimeType: 'text/markdown',
				data: btoa('# Hello World'),
				size: 13,
			});
			assert.strictEqual(att.type, 'file');
			assert.strictEqual(att.name, 'README.md');
		});

		test('pasted image', () => {
			const att = makeAttachment({ type: 'image', isPasted: true });
			assert.strictEqual(att.isPasted, true);
		});

		test('multiple attachments', () => {
			const attachments: IChatAttachment[] = [
				makeAttachment({ id: 'att-1', name: 'a.png' }),
				makeAttachment({ id: 'att-2', name: 'b.txt', type: 'file' }),
				makeAttachment({ id: 'att-3', name: 'c.jpg' }),
			];
			assert.strictEqual(attachments.length, 3);
			assert.strictEqual(attachments[0].name, 'a.png');
			assert.strictEqual(attachments[1].type, 'file');
			assert.strictEqual(attachments[2].name, 'c.jpg');
		});
	});

	// ── ISubAgentData ────────────────────────────────────────────────────

	suite('ISubAgentData', () => {
		test('pending sub-agent', () => {
			const sa = makeSubAgent({ status: 'pending' });
			assert.strictEqual(sa.status, 'pending');
		});

		test('running sub-agent with progress', () => {
			const sa = makeSubAgent({
				status: 'running',
				progress: 'Scanning directory...',
			});
			assert.strictEqual(sa.progress, 'Scanning directory...');
		});

		test('done sub-agent with output', () => {
			const sa = makeSubAgent({
				status: 'done',
				output: 'Found 5 relevant files.',
			});
			assert.strictEqual(sa.status, 'done');
			assert.ok(sa.output!.includes('Found'));
		});

		test('error sub-agent', () => {
			const sa = makeSubAgent({
				status: 'error',
				error: 'Permission denied accessing /root',
			});
			assert.strictEqual(sa.status, 'error');
			assert.ok(sa.error!.includes('Permission'));
		});

		test('cancelled sub-agent', () => {
			const sa = makeSubAgent({ status: 'cancelled' });
			assert.strictEqual(sa.status, 'cancelled');
		});

		test('sub-agent types', () => {
			const explore = makeSubAgent({ type: 'explore' });
			const general = makeSubAgent({ type: 'general' });
			const scout = makeSubAgent({ type: 'scout' });
			assert.strictEqual(explore.type, 'explore');
			assert.strictEqual(general.type, 'general');
			assert.strictEqual(scout.type, 'scout');
		});

		test('sub-agent with group', () => {
			const sa = makeSubAgent({ groupId: 'group-abc' });
			assert.strictEqual(sa.groupId, 'group-abc');
		});
	});

	// ── IConfirmationData ────────────────────────────────────────────────

	suite('IConfirmationData', () => {
		test('pending confirmation', () => {
			const cf: IConfirmationData = {
				id: 'cf-1',
				title: 'Approve tool execution?',
				message: 'The agent wants to delete file: /tmp/test.log',
				status: 'pending',
				buttons: [
					{ id: 'approve', label: 'Approve', primary: true },
					{ id: 'reject', label: 'Reject', danger: true },
				],
			};
			assert.strictEqual(cf.status, 'pending');
			assert.strictEqual(cf.buttons.length, 2);
			assert.strictEqual(cf.buttons[0].primary, true);
			assert.strictEqual(cf.buttons[1].danger, true);
		});

		test('approved confirmation', () => {
			const cf: IConfirmationData = {
				id: 'cf-2',
				title: 'Run command',
				message: 'Run: git push',
				status: 'approved',
				buttons: [{ id: 'ok', label: 'OK' }],
			};
			assert.strictEqual(cf.status, 'approved');
		});

		test('rejected confirmation', () => {
			const cf: IConfirmationData = {
				id: 'cf-3',
				title: 'Delete file',
				message: 'Really delete?',
				status: 'rejected',
				buttons: [{ id: 'cancel', label: 'Cancel' }],
			};
			assert.strictEqual(cf.status, 'rejected');
		});

		test('confirmation with detail', () => {
			const cf: IConfirmationData = {
				id: 'cf-4',
				title: 'Execute SQL',
				message: 'Execute DROP TABLE?',
				detail: 'DROP TABLE users CASCADE; -- This will remove all user data',
				status: 'pending',
				buttons: [
					{ id: 'approve', label: 'Execute', danger: true },
					{ id: 'reject', label: 'Cancel' },
				],
			};
			assert.ok(cf.detail!.includes('DROP TABLE'));
			assert.strictEqual(cf.buttons[0].danger, true);
		});

		test('cancelled confirmation', () => {
			const cf: IConfirmationData = {
				id: 'cf-5',
				title: 'Timeout',
				message: 'Confirmation timed out',
				status: 'cancelled',
				buttons: [],
			};
			assert.strictEqual(cf.status, 'cancelled');
			assert.strictEqual(cf.buttons.length, 0);
		});
	});

	// ── IWorktreeItem ────────────────────────────────────────────────────

	suite('IWorktreeItem', () => {
		test('branch worktree', () => {
			const wt: IWorktreeItem = { path: '/repo/worktrees/feat-x', branch: 'feat-x' };
			assert.strictEqual(wt.path, '/repo/worktrees/feat-x');
			assert.strictEqual(wt.branch, 'feat-x');
		});

		test('detached worktree', () => {
			const wt: IWorktreeItem = { path: '/repo/worktrees/detached-1', branch: '(detached @ abc1234)' };
			assert.ok(wt.branch.startsWith('(detached'));
		});
	});

	// ── IAgentSessionMeta ────────────────────────────────────────────────

	suite('IAgentSessionMeta', () => {
		test('session metadata', () => {
			const meta: IAgentSessionMeta = {
				id: 'sess-1',
				name: 'Feature discussion',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				messageCount: 42,
			};
			assert.strictEqual(meta.messageCount, 42);
			assert.strictEqual(meta.name, 'Feature discussion');
		});
	});

	// ── IMessageNavItem ──────────────────────────────────────────────────

	suite('IMessageNavItem', () => {
		test('message nav item', () => {
			const item: IMessageNavItem = {
				id: 'msg-1',
				summary: 'User asked about markdown rendering',
				timestamp: Date.now(),
			};
			assert.ok(item.summary.length > 0);
			assert.strictEqual(typeof item.timestamp, 'number');
		});
	});

	// ── IAgentInfo (selected fields) ─────────────────────────────────────

	suite('IAgentInfo', () => {
		test('basic agent info', () => {
			const info: IAgentInfo = {
				id: 'saros-claw',
				name: 'Saros Claw',
				role: 'AI Assistant',
				status: 'idle' as AgentStatus,
				agentType: 'general',
			};
			assert.strictEqual(info.id, 'saros-claw');
			assert.strictEqual(info.agentType, 'general');
		});

		test('planner agent', () => {
			const info: IAgentInfo = {
				id: 'planner',
				name: 'Planner',
				role: 'Project Manager',
				status: 'idle' as AgentStatus,
				isPM: true,
				agentType: 'planner',
			};
			assert.strictEqual(info.isPM, true);
			assert.strictEqual(info.agentType, 'planner');
		});
	});

	// ── ChatMode ─────────────────────────────────────────────────────────

	suite('ChatMode', () => {
		test('craft mode', () => {
			const mode: ChatMode = 'craft';
			assert.strictEqual(mode, 'craft');
		});

		test('ask mode', () => {
			const mode: ChatMode = 'ask';
			assert.strictEqual(mode, 'ask');
		});

		test('plan mode', () => {
			const mode: ChatMode = 'plan';
			assert.strictEqual(mode, 'plan');
		});
	});

	// ── Edge Cases ───────────────────────────────────────────────────────

	suite('Edge Cases', () => {
		test('empty content message', () => {
			const msg = makeMessage({ content: '' });
			assert.strictEqual(msg.content, '');
		});

		test('message with empty tool calls array', () => {
			const msg = makeMessage({ toolCalls: [] });
			assert.strictEqual(msg.toolCalls!.length, 0);
		});

		test('message with empty attachments array', () => {
			const msg = makeMessage({ role: 'user', attachments: [] });
			assert.strictEqual(msg.attachments!.length, 0);
		});

		test('message with empty sub-agents array', () => {
			const msg = makeMessage({ subAgents: [] });
			assert.strictEqual(msg.subAgents!.length, 0);
		});

		test('tool call with very long result', () => {
			const longResult = 'x'.repeat(10000);
			const tc = makeToolCall({ result: longResult });
			assert.strictEqual(tc.result!.length, 10000);
		});

		test('attachment with large base64 data', () => {
			const largeData = btoa('x'.repeat(1000));
			const att = makeAttachment({ data: largeData, size: 1000 });
			assert.strictEqual(att.data.length, largeData.length);
		});

		test('sub-agent with multi-line output', () => {
			const multiLine = 'file1.ts\nfile2.ts\nfile3.ts\nfile4.ts';
			const sa = makeSubAgent({ status: 'done', output: multiLine });
			assert.ok(sa.output!.includes('\n'));
			assert.strictEqual(sa.output!.split('\n').length, 4);
		});
	});
});
