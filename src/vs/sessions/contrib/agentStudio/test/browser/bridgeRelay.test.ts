/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── P3：BridgeRelay（bot↔bot）单测 ──

import assert from 'assert';
import { IAgentChatService, ILogService } from '../../common/agentStudio.js';
import { BridgeRelay } from '../../browser/bridge/bridgeRelay.js';

function makeLog(): ILogService {
	return { debug() {}, info() {}, warn() {}, error() {}, trace() {}, dispose() {} } as unknown as ILogService;
}

function makeChat(echo: (m: string) => string): IAgentChatService {
	const calls: Array<{ agentId: string; message: string }> = [];
	return {
		createAgentSession: async (_agentId: string, _name: string) =>
			({ id: 'relay-sess', name: _name, createdAt: '', updatedAt: '', messageCount: 0 }),
		getOrCreateActiveSession: async () =>
			({ id: 'active', name: 'active', createdAt: '', updatedAt: '', messageCount: 0 }),
		sendMessage: async (_agentId: string, message: string, _opts: unknown, onDelta: (d: any) => void) => {
			calls.push({ agentId: _agentId, message });
			const out = echo(message);
			onDelta({ type: 'text', content: out });
			onDelta({ type: 'usage', usage: { inputTokens: out.length, outputTokens: out.length } });
			onDelta({ type: 'done' });
			return { id: 'm', role: 'assistant', content: out, timestamp: '' };
		},
	} as unknown as IAgentChatService;
}

suite('BridgeRelay (P3)', () => {
	test('relay 调 sendMessage 并返回纯文本', async () => {
		const chat = makeChat(m => `ACK:${m}`);
		const relay = new BridgeRelay(chat, makeLog());
		const out = await relay.relay('feishu:u1', 'coder', 'hi');
		assert.strictEqual(out, 'ACK:hi');
	});

	test('relayChain 串联 a→b，上一步输出作为下一步输入', async () => {
		const chat = makeChat(m => `[B]${m}`);
		const relay = new BridgeRelay(chat, makeLog());
		const out = await relay.relayChain('feishu:u1', ['a', 'b'], 'start');
		assert.strictEqual(out, '[B][B]start');
	});

	test('relay 失败返回错误提示而非抛异常', async () => {
		const failing = {
			createAgentSession: async () => ({ id: 'x', name: 'x', createdAt: '', updatedAt: '', messageCount: 0 }),
			sendMessage: async () => { throw new Error('boom'); },
		} as unknown as IAgentChatService;
		const relay = new BridgeRelay(failing, makeLog());
		const out = await relay.relay('feishu:u1', 'coder', 'hi');
		assert.ok(out.includes('失败') && out.includes('boom'), '应包含失败信息');
	});
});
