/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Task Board → Agent 数据传递测试
 *
 * 验证：任务看板卡片上的「附件（文件/图片）」「工作区」「worktree」信息，
 * 在任务被置为 Running 并执行时，是否正确传递给目标 agent。
 *
 * 覆盖：
 *  1. AgentTaskBoardService._resolveAttachmentPayloads
 *     —— 附件元数据 + 磁盘内容 → IChatAttachmentSend（图片保持 base64，文本解码为原文）
 *  2. AgentTaskBoardService.updateTask(Running)
 *     —— 触发 executeTaskForBoard 时携带 attachments / workspaceId / worktreePath
 *  3. TaskOrchestrationService.executeTaskForBoard
 *     —— 将 attachments / workspaceId / worktreePath 透传到 agentChatService.sendMessage 的 options
 */

import assert from 'assert';
import { AgentTaskBoardService } from '../../browser/agentTaskBoardService.js';
import { TaskOrchestrationService } from '../../browser/taskOrchestrationService.js';
import { TaskBoardStatus } from '../../common/types.js';
import { ITaskOrchestrationService, IAgentStudioService, IChatAttachmentSend } from '../../common/agentStudio.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';

// ─── Mock ILogService ────────────────────────────────────────────────────────
class MockLogService {
	debug() { }
	info() { }
	warn() { }
	error() { }
	trace() { }
}

// ─── In-memory IFileService ───────────────────────────────────────────────────
// 根据 URI 路径返回：任务 JSON / 附件原始字节（其余抛错，被调用方 catch 成空）。
class InMemoryFileService {
	private readonly attachmentBytes = new Map<string, VSBuffer>();
	private taskboardJson = '[]';

	seedTaskboard(json: string): void { this.taskboardJson = json; }
	seedAttachment(attachmentId: string, bytes: VSBuffer): void { this.attachmentBytes.set(attachmentId, bytes); }

	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const p = uri.path;
		if (p.endsWith('taskboard.json')) {
			return { value: VSBuffer.fromString(this.taskboardJson) };
		}
		for (const [id, bytes] of this.attachmentBytes) {
			if (p.includes(`/attachments/`) && p.endsWith(`/${id}`)) {
				return { value: bytes };
			}
		}
		throw new Error(`InMemoryFileService: file not found: ${p}`);
	}
	async writeFile() { }
	async exists() { return false; }
	async del() { }
	hasCapability() { return false; }
}

// ─── Mock orchestration service (captures executeTaskForBoard calls) ──────────
class MockOrchestrationService {
	executeTaskForBoardCalls: Array<{ workspaceId: string; taskId: string; info: any }> = [];

	async ensureTaskAgent(_ws: string, _id: string, _info?: any): Promise<{ assigneeId: string; assigneeName: string }> {
		return { assigneeId: 'agent-1', assigneeName: 'Agent One' };
	}
	async executeTaskForBoard(workspaceId: string, taskId: string, info: any): Promise<void> {
		this.executeTaskForBoardCalls.push({ workspaceId, taskId, info });
	}
}

function buildTaskRecord(attachments?: Array<{ id: string; name: string; mimeType: string; size: number }>) {
	return {
		id: 'task-1',
		title: '实现登录页',
		description: '用 React 实现登录表单',
		status: TaskBoardStatus.Todo,
		source: 'task-board' as const,
		workspaceId: 'ws-1',
		worktreePath: '/repo/wt1',
		createdAt: new Date().toISOString(),
		attachments: attachments ?? [],
	};
}

suite('Task Board → Agent 数据传递', () => {

	// ── 1. 附件解析（文件 / 图片 / 文本解码） ──────────────────────────────────
	suite('AgentTaskBoardService._resolveAttachmentPayloads', () => {
		test('图片保持 base64，文本文件解码为原文，类型正确', async () => {
			const fileService = new InMemoryFileService();
			const pngBytes = VSBuffer.fromByteArray([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
			const textBytes = VSBuffer.fromString('hello agent from attachment');
			fileService.seedAttachment('att-img', pngBytes);
			fileService.seedAttachment('att-txt', textBytes);

			const task = buildTaskRecord([
				{ id: 'att-img', name: 'mock.png', mimeType: 'image/png', size: pngBytes.byteLength },
				{ id: 'att-txt', name: 'note.txt', mimeType: 'text/plain', size: textBytes.byteLength },
			]);

			const svc = makeTaskBoardService(fileService);
			const payloads = await (svc as any)._resolveAttachmentPayloads(task) as IChatAttachmentSend[];

			assert.strictEqual(payloads.length, 2, '应解析出 2 个附件 payload');

			const img = payloads.find(p => p.id === 'att-img')!;
			assert.strictEqual(img.type, 'image');
			assert.strictEqual(img.mimeType, 'image/png');
			assert.strictEqual(img.data, encodeBase64(pngBytes), '图片数据应保持 base64');

			const txt = payloads.find(p => p.id === 'att-txt')!;
			assert.strictEqual(txt.type, 'file');
			assert.strictEqual(txt.mimeType, 'text/plain');
			assert.strictEqual(txt.data, 'hello agent from attachment', '文本文件应解码为原文而非 base64');
		});

		test('无附件时返回空数组', async () => {
			const fileService = new InMemoryFileService();
			const svc = makeTaskBoardService(fileService);
			const payloads = await (svc as any)._resolveAttachmentPayloads(buildTaskRecord()) as IChatAttachmentSend[];
			assert.deepStrictEqual(payloads, []);
		});

		test('单个附件读取失败时跳过该附件，不阻断其余', async () => {
			const fileService = new InMemoryFileService();
			// att-bad 未 seed → readAttachment 抛错
			fileService.seedAttachment('att-ok', VSBuffer.fromString('ok content'));
			const task = buildTaskRecord([
				{ id: 'att-bad', name: 'missing.bin', mimeType: 'application/octet-stream', size: 1 },
				{ id: 'att-ok', name: 'ok.txt', mimeType: 'text/plain', size: 10 },
			]);
			const svc = makeTaskBoardService(fileService);
			const payloads = await (svc as any)._resolveAttachmentPayloads(task) as IChatAttachmentSend[];
			assert.strictEqual(payloads.length, 1);
			assert.strictEqual(payloads[0].id, 'att-ok');
		});
	});

	// ── 2. updateTask(Running) 触发 executeTaskForBoard 携带附件/工作区/worktree ─
	suite('AgentTaskBoardService.updateTask(Running) 转发', () => {
		test('执行任务时把 attachments / workspaceId / worktreePath 传给 orchestration', async () => {
			const fileService = new InMemoryFileService();
			const pngBytes = VSBuffer.fromByteArray([137, 80, 78, 71]);
			const textBytes = VSBuffer.fromString('design spec');
			fileService.seedAttachment('att-img', pngBytes);
			fileService.seedAttachment('att-txt', textBytes);
			fileService.seedTaskboard(JSON.stringify([buildTaskRecord([
				{ id: 'att-img', name: 'mock.png', mimeType: 'image/png', size: pngBytes.byteLength },
				{ id: 'att-txt', name: 'spec.txt', mimeType: 'text/plain', size: textBytes.byteLength },
			])]));

			const orchestration = new MockOrchestrationService();
			const svc = makeTaskBoardService(fileService, orchestration);

			await svc.updateTask('task-1', { status: TaskBoardStatus.Running });

			assert.strictEqual(orchestration.executeTaskForBoardCalls.length, 1, '应调用一次 executeTaskForBoard');
			const call = orchestration.executeTaskForBoardCalls[0];
			assert.strictEqual(call.workspaceId, 'ws-1', '应传递 workspaceId');
			assert.strictEqual(call.info.worktreePath, '/repo/wt1', '应传递 worktreePath');
			assert.ok(Array.isArray(call.info.attachments), '应传递 attachments 数组');
			assert.strictEqual(call.info.attachments.length, 2, '应传递 2 个附件');
			const img = call.info.attachments.find((a: IChatAttachmentSend) => a.id === 'att-img');
			assert.strictEqual(img.type, 'image');
			assert.strictEqual(img.data, encodeBase64(pngBytes));
			const txt = call.info.attachments.find((a: IChatAttachmentSend) => a.id === 'att-txt');
			assert.strictEqual(txt.data, 'design spec');
		});

		test('无附件的任务执行时 attachments 为 undefined（不回归）', async () => {
			const fileService = new InMemoryFileService();
			fileService.seedTaskboard(JSON.stringify([buildTaskRecord()]));
			const orchestration = new MockOrchestrationService();
			const svc = makeTaskBoardService(fileService, orchestration);

			await svc.updateTask('task-1', { status: TaskBoardStatus.Running });

			assert.strictEqual(orchestration.executeTaskForBoardCalls.length, 1);
			assert.strictEqual(orchestration.executeTaskForBoardCalls[0].info.attachments, undefined);
			assert.strictEqual(orchestration.executeTaskForBoardCalls[0].info.worktreePath, '/repo/wt1');
		});
	});

	// ── 3. executeTaskForBoard → sendMessage 透传（agent 真正收到） ─────────────
	suite('TaskOrchestrationService.executeTaskForBoard → sendMessage', () => {
		test('attachments / workspaceId / worktreePath 进入 sendMessage 的 options', async () => {
			const { service, agentChat } = makeOrchestrationService();
			const pngBytes = VSBuffer.fromByteArray([137, 80, 78, 71]);
			const attachments: IChatAttachmentSend[] = [
				{ id: 'att-img', type: 'image', name: 'mock.png', mimeType: 'image/png', data: encodeBase64(pngBytes), size: pngBytes.byteLength },
				{ id: 'att-txt', type: 'file', name: 'spec.txt', mimeType: 'text/plain', data: 'design spec', size: 11 },
			];

			await service.executeTaskForBoard('ws-1', 'task-1', {
				title: '实现登录页',
				description: '用 React 实现登录表单',
				assigneeId: 'agent-1',
				assigneeName: 'Agent One',
				worktreePath: '/repo/wt1',
				attachments,
			});

			assert.strictEqual(agentChat.lastSendMessageArgs.length, 1, '应调用一次 sendMessage');
			const call = agentChat.lastSendMessageArgs[0];
			assert.strictEqual(call.agentId, 'agent-1');
			assert.strictEqual(call.opts.workspaceId, 'ws-1', 'sendMessage 应携带 workspaceId');
			assert.strictEqual(call.opts.worktreePath, '/repo/wt1', 'sendMessage 应携带 worktreePath');
			assert.ok(Array.isArray(call.opts.attachments), 'sendMessage 应携带 attachments');
			assert.strictEqual(call.opts.attachments.length, 2);
			assert.strictEqual(call.opts.attachments[0].id, 'att-img');
			assert.strictEqual(call.opts.attachments[1].data, 'design spec');
			// prompt 应提及附件，便于 agent 知晓上下文
			assert.ok(call.message.includes('mock.png'), 'prompt 应列出附件名');
			assert.ok(call.message.includes('spec.txt'), 'prompt 应列出附件名');
		});

		test('无 attachments 时 sendMessage 的 options.attachments 为 undefined（不回归）', async () => {
			const { service, agentChat } = makeOrchestrationService();
			await service.executeTaskForBoard('ws-1', 'task-1', {
				title: '实现登录页',
				assigneeId: 'agent-1',
				worktreePath: '/repo/wt1',
			});
			assert.strictEqual(agentChat.lastSendMessageArgs.length, 1);
			assert.strictEqual(agentChat.lastSendMessageArgs[0].opts.attachments, undefined);
			assert.strictEqual(agentChat.lastSendMessageArgs[0].opts.worktreePath, '/repo/wt1');
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Test harness builders
// ═══════════════════════════════════════════════════════════════════════════════

function makeTaskBoardService(fileService: InMemoryFileService, orchestration?: MockOrchestrationService): AgentTaskBoardService {
	const mockOrchestration = orchestration ?? new MockOrchestrationService();
	const mockAgentStudio = {
		getActiveWorkspaceId: () => 'ws-1',
		getWorktrees: async () => [],
		getAgents: async () => [],
		getWorkspace: async () => undefined,
		createAgent: async () => ({ id: 'agent-1', name: 'Agent One' }),
	};

	const instantiationService = {
		invokeFunction: (fn: (accessor: any) => any) => fn({
			get: (id: any) => {
				if (id === ITaskOrchestrationService) { return mockOrchestration; }
				if (id === IAgentStudioService) { return mockAgentStudio; }
				return undefined;
			},
		}),
		createInstance: () => { throw new Error('createInstance not expected in test'); },
	};

	const environmentService = { userHome: URI.file('/tmp') } as any;
	const configurationService = { getValue: () => undefined } as any;
	const playwrightService = {} as any;

	return new AgentTaskBoardService(
		fileService as any,
		new MockLogService() as any,
		configurationService,
		environmentService,
		instantiationService as any,
		playwrightService,
	);
}

function makeOrchestrationService(): { service: TaskOrchestrationService; agentChat: MockAgentChatService } {
	const fileService = new InMemoryFileService();
	const logService = new MockLogService();
	const configurationService = { getValue: () => undefined } as any;
	const environmentService = { userHome: URI.file('/tmp') } as any;

	const agentChat = new MockAgentChatService();
	const agentStudio = {
		getActiveWorkspaceId: () => 'ws-1',
		getWorktrees: async () => [],
		getAgents: async () => [],
		getWorkspace: async () => undefined,
		createAgent: async () => ({ id: 'agent-1', name: 'Agent One' }),
	} as any;
	const taskBoardService = {} as any;
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
	return { service, agentChat };
}

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
