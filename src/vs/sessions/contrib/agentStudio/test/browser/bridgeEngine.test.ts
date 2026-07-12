/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BridgeEngine P0 切片单测：用 mock 服务 + LoopbackPlatform 验证端到端 ──

import assert from 'assert';
import { IAgentChatService, IAgentStudioService } from '../../common/agentStudio.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { BridgeEngine } from '../../browser/bridge/bridgeEngine.js';
import { LoopbackPlatform } from '../../browser/bridge/loopbackPlatform.js';

const flush = () => new Promise<void>(r => setTimeout(r, 0));

function makeMocks() {
	const calls = {
		sendMessage: 0,
		createAgentSession: 0,
		cancelStream: 0,
		clearHistory: 0,
	};
	const chat = {
		sendMessage: async (
			_agentId: string,
			message: string,
			_options: unknown,
			onDelta: (d: any) => void,
		): Promise<any> => {
			calls.sendMessage++;
			onDelta({ type: 'text', content: `echo:${message}` });
			onDelta({ type: 'done' });
			return { id: 'm1', role: 'assistant', content: message, timestamp: new Date().toISOString() };
		},
		getOrCreateActiveSession: async () => ({ id: 'sess-active', name: 'active', createdAt: '', updatedAt: '', messageCount: 0 }),
		createAgentSession: async () => { calls.createAgentSession++; return { id: 'sess-new', name: 'new', createdAt: '', updatedAt: '', messageCount: 0 }; },
		listAgentSessions: async () => ([
			{ id: 'sess-1', name: 'S1', createdAt: '', updatedAt: '', messageCount: 3 },
			{ id: 'sess-2', name: 'S2', createdAt: '', updatedAt: '', messageCount: 1 },
		]),
		cancelStream: () => { calls.cancelStream++; },
		clearHistory: async () => { calls.clearHistory++; },
	} as unknown as IAgentChatService;
	const studio = {
		getAgents: async () => ([{ id: 'coder', name: 'Coder', model: 'gpt', role: '', description: '', icon: '', skills: [], createdAt: '', updatedAt: '' }]),
	} as unknown as IAgentStudioService;
	const log = { info() {}, warn() {}, error() {}, trace() {} } as unknown as ILogService;
	return { chat, studio, log, calls };
}

suite('BridgeEngine (P0 slice)', () => {

	test('普通消息 → 路由到 Agent 并返回流式文本', async () => {
		const { chat, studio, log, calls } = makeMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat, studio, logService: log });
		engine.registerPlatform(lb);
		await engine.start();

		lb.postInbound('hello');
		await flush();

		assert.strictEqual(calls.sendMessage, 1, 'sendMessage 应被调用一次');
		const result = lb.outbounds.find(o => o.type === 'result');
		assert.ok(result, '应有一条 result 出站');
		assert.strictEqual(result!.content, 'echo:hello');
	});

	test('/new → 新建并切换会话', async () => {
		const { studio, log, calls } = makeMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat: makeMocks().chat, studio, logService: log });
		engine.registerPlatform(lb);
		await engine.start();

		lb.postInbound('/new');
		await flush();

		assert.strictEqual(calls.createAgentSession, 1, '应新建一个会话');
		const result = lb.outbounds.find(o => o.type === 'result');
		assert.ok(result?.content.includes('已新建并切换到会话'), '应提示已切换');
	});

	test('/sessions → 列出会话', async () => {
		const { studio, log } = makeMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat: makeMocks().chat, studio, logService: log });
		engine.registerPlatform(lb);
		await engine.start();

		lb.postInbound('/sessions');
		await flush();

		const result = lb.outbounds.find(o => o.type === 'result');
		assert.ok(result?.content.includes('S1'), '应列出 S1');
		assert.ok(result?.content.includes('S2'), '应列出 S2');
	});

	test('/stop → 中断当前流', async () => {
		const { chat, studio, log, calls } = makeMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat, studio, logService: log });
		engine.registerPlatform(lb);
		await engine.start();

		lb.postInbound('hi');
		await flush();

		lb.postInbound('/stop');
		await flush();

		assert.strictEqual(calls.cancelStream, 1, '应调用 cancelStream');
	});
});
