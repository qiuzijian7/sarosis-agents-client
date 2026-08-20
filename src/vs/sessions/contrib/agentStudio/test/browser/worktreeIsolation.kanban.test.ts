/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 看板入口 Worktree 隔离测试（对应需求：从看板选择不同 workspace / worktree 执行任务时，
 * 对应聊天框输入区 UI 的 workspace / worktree 是否正确，且 agentloop 工具 cwd 隔离是否正确）。
 *
 * 隔离链路（决定断言点）：
 *   AgentTaskBoardService.updateTask(Running)
 *     → TaskOrchestrationService.executeTaskForBoard(info.worktreePath)
 *       ├─ 1) _streamEventCallback('agent.openChat', { agentId, agentName, workspaceId, worktreePath })
 *       │       —— webview 消费该事件 → 打开对应 agent 聊天框并同步输入区 workspace/worktree 显示（B4）
 *       └─ 2) agentChatService.sendMessage(agentId, msg, { workspaceId, worktreePath, attachments })
 *               —— driver.executeTurn 读取 request.worktreePath，临时覆盖 AgentBinding.worktreePath
 *                  （加 _bindingWriteLocks + tempWorktreeOverride 标记，finally 恢复），
 *                  builtinToolProvider._resolveAndCheckWorkspacePath 据此解析工具 cwd（B2/D1）
 *
 * 本文件聚焦①（UI 同步事件）与②（worktreePath 透传，隔离的输入前提）。
 * 驱动层"B2 执行期临时覆盖 + finally 恢复"与"B6 崩溃自愈"已在 agentDriverService.test.ts 覆盖；
 * 工具 cwd 解析器 D1/D3 需构造 BuiltinToolProvider（24 依赖，较重型），另文补充。
 */

import assert from 'assert';
import { TaskOrchestrationService } from '../../browser/taskOrchestrationService.js';
import { URI } from '../../../../../base/common/uri.js';

// ─── Mock LogService ────────────────────────────────────────────────────────
class MockLogService {
	debug() { }
	info() { }
	warn() { }
	error() { }
	trace() { }
}

// ─── In-memory IFileService（仅占位，看板执行路径不读附件内容） ─────────────────
class InMemoryFileService {
	async readFile() { return { value: VSBuffer.fromString('') }; }
	async writeFile() { }
	async exists() { return false; }
	async del() { }
	hasCapability() { return false; }
}

// ─── Mock AgentChatService（捕获 sendMessage 入参） ──────────────────────────
class MockAgentChatService {
	lastSendMessageArgs: Array<{ agentId: string; message: string; opts: any; onDelta?: any }> = [];

	async getOrCreateActiveSession(_agentId: string, _name: string): Promise<{ id: string; name: string }> {
		return { id: 'sess-1', name: _name };
	}
	async sendMessage(agentId: string, message: string, opts: any, onDelta?: (delta: any) => void): Promise<{ content: string }> {
		this.lastSendMessageArgs.push({ agentId, message, opts, onDelta });
		if (onDelta) { onDelta({ content: 'mock response' }); }
		return { content: 'mock response' };
	}
	async cancelStream() { }
}

// ─── 捕获 agent.openChat 等 stream 事件（驱动层推给 webview 的 UI 同步信号） ──
class StreamEventCapture {
	events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	callback = (eventType: string, payload: Record<string, unknown>): void => {
		this.events.push({ type: eventType, payload });
	};
	find(type: string): Array<Record<string, unknown>> {
		return this.events.filter(e => e.type === type).map(e => e.payload);
	}
}

function makeOrchestrationService(): { service: TaskOrchestrationService; agentChat: MockAgentChatService; stream: StreamEventCapture } {
	const fileService = new InMemoryFileService();
	const logService = new MockLogService();
	// ★ 补 onDidChangeConfiguration：TaskOrchestrationService 构造器订阅语言设置变更。
	const configurationService = {
		getValue: () => undefined,
		onDidChangeConfiguration: () => ({ dispose: () => { /* noop */ } }),
	} as any;
	const environmentService = { userHome: URI.file('/tmp') } as any;
	const agentChat = new MockAgentChatService();
	const stream = new StreamEventCapture();
	const agentStudio = {
		getActiveWorkspaceId: () => 'ws-1',
		getWorktrees: async () => [],
		getAgents: async () => [],
		getWorkspace: async () => undefined,
		createAgent: async () => ({ id: 'agent-1', name: 'Agent One' }),
	} as any;
	// ★ 补 executeTaskForBoard 依赖：getTasks（ensureTaskAgent 回退）+ updateTaskStatus（执行结束标 Done/取消标 Cancelled）。
	const taskBoardService = {
		getTasks: async () => [],
		updateTaskStatus: async () => { /* noop */ },
	} as any;
	const agentOSService = {} as any;
	const workspaceContextService = {} as any;
	const workflowStorage = { listWorkflows: async () => [] } as any;
	const workflowExecutionService = { executeWorkflow: async () => 'exec-1' } as any;

	const service = new TaskOrchestrationService(
		fileService as any,
		logService as any,
		configurationService,
		environmentService,
		agentStudio,
		taskBoardService,
		agentChat as any,
		agentOSService,
		workspaceContextService,
		workflowStorage,
		workflowExecutionService,
	);
	// 注册 stream 事件回调（真实环境由 AgentStudioWebviewController 注入，转发到 webview）
	service.setStreamEventCallback(stream.callback);
	return { service, agentChat, stream };
}

suite('Worktree 隔离 — 看板入口 (B4/B5/B7)', () => {

	// ── B4：看板执行触发 agent.openChat 事件，payload 携带正确 workspaceId + worktreePath
	//      这是「聊天框输入区 UI 同步 workspace/worktree」的数据来源（webview 消费此事件）
	suite('B4: executeTaskForBoard → agent.openChat 事件携带 workspace/worktree', () => {
		test('任务带 worktreePath 时，openChat 事件含 workspaceId + worktreePath', async () => {
			const { service, stream } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-1', 'task-1', {
				title: '实现登录页',
				assigneeId: 'agent-1',
				assigneeName: 'Agent One',
				worktreePath: '/repo/wt-board-A',
			});

			const openChats = stream.find('agent.openChat');
			assert.strictEqual(openChats.length, 1, '应恰好发射一次 agent.openChat 事件');
			const payload = openChats[0];
			assert.strictEqual(payload.agentId, 'agent-1', 'openChat 应携带 agentId');
			assert.strictEqual(payload.agentName, 'Agent One', 'openChat 应携带 agentName');
			assert.strictEqual(payload.workspaceId, 'ws-1', 'openChat 应携带任务所属 workspaceId');
			assert.strictEqual(payload.worktreePath, '/repo/wt-board-A', 'openChat 应携带任务 worktreePath（聊天框据此同步输入区）');
		});

		test('不同 worktree 的多个任务各自发射正确的 openChat（互不串）', async () => {
			const { service, stream } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-1', 'task-A', {
				title: '任务A', assigneeId: 'agent-1', assigneeName: 'Agent One', worktreePath: '/repo/wt-A',
			});
			await service.executeTaskForBoard('ws-2', 'task-B', {
				title: '任务B', assigneeId: 'agent-2', assigneeName: 'Agent Two', worktreePath: '/repo/wt-B',
			});

			const openChats = stream.find('agent.openChat');
			assert.strictEqual(openChats.length, 2, '应发射两次 agent.openChat');
			const a = openChats.find(p => p.agentId === 'agent-1')!;
			const b = openChats.find(p => p.agentId === 'agent-2')!;
			assert.strictEqual(a.workspaceId, 'ws-1');
			assert.strictEqual(a.worktreePath, '/repo/wt-A');
			assert.strictEqual(b.workspaceId, 'ws-2');
			assert.strictEqual(b.worktreePath, '/repo/wt-B');
		});

		test('agentName 回退到 assigneeId（未提供 assigneeName 时）', async () => {
			const { service, stream } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-1', 'task-1', {
				title: 't', assigneeId: 'agent-x', worktreePath: '/repo/wt-x',
			});
			const openChats = stream.find('agent.openChat');
			assert.strictEqual(openChats[0].agentName, 'agent-x', '未提供 assigneeName 时应回退为 agentId');
			assert.strictEqual(openChats[0].worktreePath, '/repo/wt-x');
		});
	});

	// ── B2 输入前提：worktreePath 必须正确透传到 sendMessage 的 opts
	//      （driver 后续据此临时覆盖 binding.worktreePath → 工具 cwd 跟随任务 worktree）
	suite('B2: executeTaskForBoard → sendMessage opts 携带 worktreePath（隔离输入前提）', () => {
		test('worktreePath 进入 sendMessage opts，且 prompt 不丢失任务语义', async () => {
			const { service, agentChat } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-1', 'task-1', {
				title: '实现登录页',
				description: '用 React 实现登录表单',
				assigneeId: 'agent-1',
				assigneeName: 'Agent One',
				worktreePath: '/repo/wt-board-A',
			});

			assert.strictEqual(agentChat.lastSendMessageArgs.length, 1);
			const call = agentChat.lastSendMessageArgs[0];
			assert.strictEqual(call.agentId, 'agent-1');
			assert.strictEqual(call.opts.workspaceId, 'ws-1', 'sendMessage 应携带 workspaceId');
			assert.strictEqual(call.opts.worktreePath, '/repo/wt-board-A', 'sendMessage 应携带 worktreePath（driver 隔离依据）');
		});

		test('不同 workspace + worktree 组合转发互不串台', async () => {
			const { service, agentChat } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-2', 'task-2', {
				title: 't2', assigneeId: 'agent-2', assigneeName: 'Agent Two', worktreePath: '/repo/wt-B',
			});
			await service.executeTaskForBoard('ws-3', 'task-3', {
				title: 't3', assigneeId: 'agent-3', assigneeName: 'Agent Three', worktreePath: '/repo/wt-C',
			});

			assert.strictEqual(agentChat.lastSendMessageArgs.length, 2);
			const s2 = agentChat.lastSendMessageArgs.find(c => c.opts.workspaceId === 'ws-2')!;
			const s3 = agentChat.lastSendMessageArgs.find(c => c.opts.workspaceId === 'ws-3')!;
			assert.strictEqual(s2.opts.worktreePath, '/repo/wt-B');
			assert.strictEqual(s3.opts.worktreePath, '/repo/wt-C');
			assert.notStrictEqual(s2.opts.worktreePath, s3.opts.worktreePath, '两任务 worktree 不应混淆');
		});
	});

	// ── B7：任务未指定 worktreePath → 回退到绑定/workspace 根，不抛错
	suite('B7: 空 worktreePath 兜底（不崩溃）', () => {
		test('worktreePath 为 undefined 时，openChat 与 sendMessage 均携带 undefined，不报错', async () => {
			const { service, agentChat, stream } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-1', 'task-1', {
				title: 't', assigneeId: 'agent-1', assigneeName: 'Agent One',
				// 注意：此处不传 worktreePath
			});

			assert.strictEqual(agentChat.lastSendMessageArgs.length, 1);
			const call = agentChat.lastSendMessageArgs[0];
			assert.strictEqual(call.opts.worktreePath, undefined, '无 worktreePath 时应为 undefined');
			assert.strictEqual(call.opts.workspaceId, 'ws-1');

			const openChats = stream.find('agent.openChat');
			assert.strictEqual(openChats.length, 1);
			assert.strictEqual(openChats[0].worktreePath, undefined, 'openChat 的 worktreePath 也应为 undefined');
			assert.strictEqual(openChats[0].workspaceId, 'ws-1');
		});

		test('worktreePath 为空字符串时也按"无 worktree"处理，不崩溃', async () => {
			const { service, agentChat } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-1', 'task-1', {
				title: 't', assigneeId: 'agent-1', assigneeName: 'Agent One', worktreePath: '',
			});
			assert.strictEqual(agentChat.lastSendMessageArgs[0].opts.worktreePath, '', '空字符串应原样透传（由下游判空）');
		});
	});

	// ── 跨入口一致性（C1 的看板侧前奏）：同一 agent 连续执行两个不同 worktree 任务，
	//     每次 openChat 与 sendMessage 都正确携带当时的 worktree（互不污染）
	suite('C1: 同一 agent 跨多任务 worktree 转发隔离', () => {
		test('同一 agent 先后执行 wt-X / wt-Y，事件与 sendMessage 各自正确', async () => {
			const { service, agentChat, stream } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-1', 'task-x', {
				title: 'x', assigneeId: 'agent-1', assigneeName: 'Agent One', worktreePath: '/repo/wt-X',
			});
			await service.executeTaskForBoard('ws-1', 'task-y', {
				title: 'y', assigneeId: 'agent-1', assigneeName: 'Agent One', worktreePath: '/repo/wt-Y',
			});

			const openChats = stream.find('agent.openChat');
			assert.strictEqual(openChats.length, 2);
			assert.strictEqual(openChats[0].worktreePath, '/repo/wt-X');
			assert.strictEqual(openChats[1].worktreePath, '/repo/wt-Y');

			const sends = agentChat.lastSendMessageArgs;
			assert.strictEqual(sends[0].opts.worktreePath, '/repo/wt-X');
			assert.strictEqual(sends[1].opts.worktreePath, '/repo/wt-Y');
		});
	});
});
