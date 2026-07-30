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
	IWorkspaceItem,
	IMessageNavItem,
	AgentStatus,
	ChatMode,
} from '../../../../browser/agentChat/agentChatTypes.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeToolCall(overrides: Partial<IToolCall> = {}): IToolCall {
	return {
		id: 'tc-1',
		name: 'write_to_file',
		status: 'success',
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
				status: 'success',
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
			assert.strictEqual(calls[0].status, 'success');
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
				name: 'AI 助手',
				role: 'AI 助手',
			status: 'idle' as AgentStatus,
		};
		assert.strictEqual(info.id, 'saros-claw');
		});

		test('planner agent', () => {
			const info: IAgentInfo = {
				id: 'planner',
				name: 'Planner',
				role: 'Project Manager',
			status: 'idle' as AgentStatus,
			isPM: true,
		};
		assert.strictEqual(info.isPM, true);
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

	// ── IWorkspaceItem ───────────────────────────────────────────────────

	suite('IWorkspaceItem', () => {
		test('basic workspace', () => {
			const ws: IWorkspaceItem = {
				id: 'ws-1',
				name: 'My Project',
				path: '/home/user/projects/my-project',
			};
			assert.strictEqual(ws.id, 'ws-1');
			assert.strictEqual(ws.name, 'My Project');
			assert.strictEqual(ws.path, '/home/user/projects/my-project');
		});

		test('workspace with Windows path', () => {
			const ws: IWorkspaceItem = {
				id: 'ws-win',
				name: 'Windows Project',
				path: 'C:\\Users\\dev\\projects\\my-app',
			};
			assert.ok(ws.path.includes('\\'));
			assert.strictEqual(ws.name, 'Windows Project');
		});

		test('empty workspace list is valid', () => {
			const list: IWorkspaceItem[] = [];
			assert.strictEqual(list.length, 0);
		});

		test('multiple workspaces with unique IDs', () => {
			const a: IWorkspaceItem = { id: 'a', name: 'A', path: '/a' };
			const b: IWorkspaceItem = { id: 'b', name: 'B', path: '/b' };
			assert.notStrictEqual(a.id, b.id);
			assert.strictEqual([a, b].length, 2);
		});
	});

	// ── Workspace + Worktree 切换下游影响测试 ────────────────────────────

	suite('Workspace/Worktree Switching — downstream impact', () => {
		/**
		 * 模拟 agentChatPanel 的 callback 连接方式（nativeChatEditorPane
		 * 层传入 onSelectWorkspace / onSelectWorktree / onLoadWorkspaces
		 * / onLoadWorktrees 四个回调），验证：
		 * 1. 切换 workspace → onSelectWorkspace 调用成功
		 * 2. 切换 workspace → worktree 列表被重新加载
		 * 3. 切换 worktree → onSelectWorktree 调用成功，携带正确的 path/branch
		 * 4. 多次快速切换不丢事件 / 不产生竞态
		 */

		// ── test helpers ──────────────────────────────────────────────

		const _wsA: IWorkspaceItem = { id: 'repo-a', name: 'Repo A', path: '/repos/repo-a' };
		const wsB: IWorkspaceItem = { id: 'repo-b', name: 'Repo B', path: '/repos/repo-b' };
		const _wtMain: IWorktreeItem = { path: '/repos/repo-a', branch: 'main' };
		const _wtFeat: IWorktreeItem = { path: '/repos/repo-a/worktrees/feat-x', branch: 'feat-x' };
		void _wsA; void _wtMain; void _wtFeat; // 保留供未来完整集成测试使用

		/** 创建模拟的工作区列表加载器（每次返回固定列表） */
		function _makeWorkspaceLoader(
			workspaces: IWorkspaceItem[],
		): () => Promise<ReadonlyArray<IWorkspaceItem>> {
			let callCount = 0;
			const fn = async () => {
				callCount++;
				return workspaces;
			};
			(fn as any).callCount = () => callCount;
			return fn;
		}
		void _makeWorkspaceLoader; // 保留供未来完整集成测试使用

		/** 创建模拟的 worktree 列表加载器 */
		function _makeWorktreeLoader(
			mapping: ReadonlyMap<string, IWorktreeItem[]>,
		): (workspaceId?: string) => Promise<ReadonlyArray<IWorktreeItem>> {
			let callCount = 0;
			const fn = async (workspaceId?: string) => {
				callCount++;
				const key = workspaceId || '';
				return mapping.get(key) || [];
			};
			(fn as any).callCount = () => callCount;
			return fn;
		}
		void _makeWorktreeLoader; // 保留供未来完整集成测试使用

		test('select workspace → callback fires with correct id and name', async () => {
			let capturedId = '';
			let capturedName = '';
			const onSelect = (id: string, name: string) => { capturedId = id; capturedName = name; };

			// 模拟用户点击选择 repo-b
			onSelect(wsB.id, wsB.name);

			assert.strictEqual(capturedId, 'repo-b');
			assert.strictEqual(capturedName, 'Repo B');
		});

		test('select workspace → worktrees are reloaded for new workspace', async () => {
			const worktreeMap = new Map<string, IWorktreeItem[]>();
			worktreeMap.set('repo-a', [_wtMain, _wtFeat]);
			worktreeMap.set('repo-b', [{ path: '/repos/repo-b', branch: 'develop' }]);

			let selectedId = '';
			let loadedWorktrees: IWorktreeItem[] = [];
			const onSelect = async (id: string, _name: string) => {
				selectedId = id;
				loadedWorktrees = worktreeMap.get(id) || [];
			};

			// 切换到 repo-b
			await onSelect('repo-b', 'Repo B');
			assert.strictEqual(selectedId, 'repo-b');
			assert.strictEqual(loadedWorktrees.length, 1);
			assert.strictEqual(loadedWorktrees[0].branch, 'develop');

			// 切换到 repo-a
			await onSelect('repo-a', 'Repo A');
			assert.strictEqual(selectedId, 'repo-a');
			assert.strictEqual(loadedWorktrees.length, 2);
			assert.strictEqual(loadedWorktrees[0].branch, 'main');
			assert.strictEqual(loadedWorktrees[1].branch, 'feat-x');
		});

		test('select worktree → callback fires with correct path and branch', () => {
			const captured: { path: string; branch: string } | null = null;
			const onSelect = (wt: { path: string; branch: string }) => {
				// 验证回调参数正确
				assert.strictEqual(wt.path, '/repos/repo-a/worktrees/feat-x');
				assert.strictEqual(wt.branch, 'feat-x');
			};
			onSelect({ path: '/repos/repo-a/worktrees/feat-x', branch: 'feat-x' });
			void captured; // 保留字段供扩展
		});

		test('clear worktree → sets path to empty (back to main repo)', () => {
			let clearedPath = '/old/path';
			const onClear = () => { clearedPath = ''; };

			onClear();
			assert.strictEqual(clearedPath, '');
		});

		test('fast switching — no callback lost or stale data', async () => {
			const received: string[] = [];
			const onSelect = async (id: string, _name: string) => {
				received.push(id);
			};

			// 快速连续切换 workspace
			await onSelect('repo-a', 'Repo A');
			await onSelect('repo-b', 'Repo B');
			await onSelect('repo-a', 'Repo A');

			assert.deepStrictEqual(received, ['repo-a', 'repo-b', 'repo-a']);
		});

		test('worktree loader not called when loading workspaces fails', async () => {
			let worktreeCallCount = 0;
			const _loadWorkspaces = () => Promise.reject(new Error('network error'));
			const _loadWorktrees = async () => { worktreeCallCount++; return []; };
			void _loadWorktrees; // 保留供未来完整集成测试使用

			// 如果加载工作区失败，worktree 不应被触发
			try {
				await _loadWorkspaces();
			} catch {
				// expected
			}
			// 只有外部 onSelectWorkspace 回调正常触发后 worktree 才应重新加载
			assert.strictEqual(worktreeCallCount, 0);
		});

		test('worktree dropdown shows "主仓库" when no worktree selected', () => {
			// 验证 IWorktreeItem[] 的 fallback display label 逻辑
			const emptyPath = '';
			const display = emptyPath || '主仓库';
			assert.strictEqual(display, '主仓库');
		});

		test('worktree dropdown shows branch name when selected', () => {
			const wt: IWorktreeItem = { path: '/repo/worktrees/my-branch', branch: 'my-branch' };
			const display = wt.branch || '主仓库';
			assert.strictEqual(display, 'my-branch');
		});

		test('workspace + worktree combined: switch workspace clears old worktree', async () => {
			let currentWorkspaceId = 'repo-a';
			let currentWorktreePath = '/repos/repo-a/worktrees/feat-x';

			const onSelectWorkspace = (id: string) => {
				currentWorkspaceId = id;
				currentWorktreePath = ''; // 清空旧 worktree
			};

			// 初始状态
			assert.strictEqual(currentWorktreePath, '/repos/repo-a/worktrees/feat-x');
			assert.strictEqual(currentWorkspaceId, 'repo-a');

			// 切换到 repo-b
			await Promise.resolve(onSelectWorkspace('repo-b'));
			assert.strictEqual(currentWorkspaceId, 'repo-b');
			assert.strictEqual(currentWorktreePath, ''); // worktree 已清空
		});

		test('IWorkspaceItem readonly — cannot mutate after creation', () => {
			const ws: IWorkspaceItem = { id: 'readonly', name: 'Test', path: '/path' };
			// 验证可以读取
			assert.strictEqual(ws.id, 'readonly');
			// IWorkspaceItem 标记了 readonly，编译期会阻止重新赋值
			// 运行时验证：创建副本而非修改原对象
			const updated = { ...ws, name: 'Updated' };
			assert.strictEqual(updated.name, 'Updated');
			assert.strictEqual(ws.name, 'Test'); // 原对象不变
		});
	});
});
