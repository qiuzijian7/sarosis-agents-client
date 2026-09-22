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
import {
	BridgeReplyCtx,
	IBridgePlatform,
	InboundMessage,
} from '../../common/bridge/bridgeTypes.js';

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
		// ★ 修复：此前 `const { calls } = makeMocks()` 拿到 calls 后，又写
		//   `chat: makeMocks().chat` 调了**第二次** makeMocks() → 得到两套 mock，
		//   calls.createAgentSession 引用旧 chat 的闭包，engine 用新 chat → 计数恒 0。
		const mocks = makeMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });
		engine.registerPlatform(lb);
		await engine.start();

		lb.postInbound('/new');
		await flush();

		assert.strictEqual(mocks.calls.createAgentSession, 1, '应新建一个会话');
		const result = lb.outbounds.find(o => o.type === 'result');
		assert.ok(result?.content.includes('已新建并切换到会话'), '应提示已切换');
	});

	test('/sessions → 列出会话', async () => {
		const mocks = makeMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });
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

// ─── 命令回包句柄（2026-09-22 修复回归）──────────────────────────────────
//
// 缺陷：命令上下文 `ctx.reply` 用的是 **session.replyCtx**，而 ensureSession 从不写它
//   ⇒ 恒为 undefined ⇒ _emitOutbound 退化成 platform.send() ⇒ 飞书 send 需要 chat_id
//   ⇒ 运行期报「[Feishu] send 缺少 chat_id（无法主动发送）」（/sessions 等命令一律回不了话）。
// 判别式：命令回复必须走 platform.reply，且句柄等于触发命令的那条入站消息的 replyCtx。

/** 记录「走 send 还是 reply」+ 回包句柄的平台桩。 */
class SpyPlatform implements IBridgePlatform {
	readonly id = 'spy';
	readonly name = 'Spy';
	readonly allowFrom = '*';
	readonly calls: Array<{ via: 'send' | 'reply'; replyCtx: unknown; content: string }> = [];
	private _handler?: (msg: InboundMessage) => void;

	start(handler: (msg: InboundMessage) => void): void { this._handler = handler; }
	stop(): void { this._handler = undefined; }
	async send(ctx: BridgeReplyCtx, content: string): Promise<void> {
		this.calls.push({ via: 'send', replyCtx: ctx.replyCtx, content });
	}
	async reply(ctx: BridgeReplyCtx, content: string): Promise<void> {
		this.calls.push({ via: 'reply', replyCtx: ctx.replyCtx, content });
	}

	/** 模拟一条入站消息（可带回包句柄，如飞书的 message_id + chat_id）。 */
	postInbound(content: string, replyCtx?: unknown): void {
		this._handler!({
			sessionKey: 'spy:oc_1:u_1',
			platform: this.id,
			messageId: 'om_1',
			userId: 'u_1',
			userName: 'U',
			content,
			replyCtx,
		});
	}
}

suite('BridgeEngine · 命令回包句柄', () => {
	test('/sessions 之类命令的回复必须带走入站 replyCtx，并经 platform.reply 发出', async () => {
		const mocks = makeMocks();
		const spy = new SpyPlatform();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });
		engine.registerPlatform(spy);
		await engine.start();

		const handle = { messageId: 'om_1', chatId: 'oc_1' };
		spy.postInbound('/sessions', handle);
		await flush();

		assert.strictEqual(spy.calls.length, 1, '应有一条命令回包');
		assert.strictEqual(spy.calls[0].via, 'reply', '命令回复必须走 reply（走 send 会因缺 chat_id 抛错）');
		assert.deepStrictEqual(spy.calls[0].replyCtx, handle, '句柄必须是触发命令的那条入站消息的');
	});

	test('合成消息（无 replyCtx）仍走 send，语义不变', async () => {
		const mocks = makeMocks();
		const spy = new SpyPlatform();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });
		engine.registerPlatform(spy);
		await engine.start();

		spy.postInbound('/help');
		await flush();

		assert.strictEqual(spy.calls.length, 1);
		assert.strictEqual(spy.calls[0].via, 'send', '无回包句柄时按原语义走主动发送');
	});
});

// ─── 群专属会话测试辅助（模块级，多 suite 共享）───────────────────────

const feishuMsg = (content: string, userId = 'ou_user1') => ({
	sessionKey: `feishu:oc_group1:${userId}`,
	platform: 'feishu',
	messageId: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
	userId,
	userName: userId,
	conversationId: 'oc_group1',
	content,
	isPermissionResponse: false,
});

function makeDedicatedMocks() {
	const mocks = makeMocks();
	const counts = { create: 0, getOrCreate: 0 };
	const createdIds: string[] = [];
	const chat = mocks.chat as any;
	chat.createAgentSession = async () => {
		counts.create++;
		const id = `sess-d${counts.create}`;
		createdIds.push(id);
		return { id, name: 'dedicated', createdAt: '', updatedAt: '', messageCount: 0 };
	};
	chat.getOrCreateActiveSession = async () => {
		counts.getOrCreate++;
		return { id: 'sess-active', name: 'active', createdAt: '', updatedAt: '', messageCount: 0 };
	};
	// 存在性校验：索引里只认已创建的专属会话
	chat.listAgentSessions = async () =>
		createdIds.map(id => ({ id, name: 'dedicated', createdAt: '', updatedAt: '', messageCount: 0 }));
	return { mocks, counts, createdIds };
}

suite('BridgeEngine 群专属会话路由', () => {

	test('带 conversationId 的入站 → 新建专属会话（不调 getOrCreateActiveSession）', async () => {
		const { mocks, counts } = makeDedicatedMocks();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });

		await engine.handleInbound(feishuMsg('hi') as any);
		await flush();

		assert.strictEqual(counts.create, 1, '应新建一条专属会话');
		assert.strictEqual(counts.getOrCreate, 0, '不得复用「最近活跃」会话');
		const s = engine.getSession('feishu:oc_group1:ou_user1');
		assert.strictEqual(s?.agentSessionId, 'sess-d1');
	});

	test('重启后同群消息复用同一专属会话（sessionMap 跨实例持久化）', async () => {
		const { mocks, counts } = makeDedicatedMocks();
		const { createMemorySessionMapStore } = await import('../../browser/bridge/bridgeSessionMap.js');
		const store = createMemorySessionMapStore();

		const engine1 = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store });
		await engine1.handleInbound(feishuMsg('first') as any);
		await flush();
		assert.strictEqual(counts.create, 1);

		// 模拟进程重启：新 engine（内存 _sessions 为空），共享同一持久化 store
		const engine2 = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store });
		await engine2.handleInbound(feishuMsg('second', 'ou_user2') as any);
		await flush();

		assert.strictEqual(counts.create, 1, '第二条消息不得再建会话');
		const s = engine2.getSession('feishu:oc_group1:ou_user2');
		assert.strictEqual(s?.agentSessionId, 'sess-d1', '同群不同用户共享群专属会话');
	});

	test('换绑 Agent → 旧专属会话作废，为新 Agent 建新会话', async () => {
		const { mocks, counts } = makeDedicatedMocks();
		const { createMemorySessionMapStore } = await import('../../browser/bridge/bridgeSessionMap.js');
		const store = createMemorySessionMapStore();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store });

		await engine.handleInbound(feishuMsg('hi') as any);
		await flush();
		assert.strictEqual(counts.create, 1);

		engine.setConversationAgent('feishu', 'oc_group1', 'other-agent');
		await engine.handleInbound(feishuMsg('after rebind') as any);
		await flush();

		assert.strictEqual(counts.create, 2, '换绑后应建新专属会话');
		const s = engine.getSession('feishu:oc_group1:ou_user1');
		assert.strictEqual(s?.agentId, 'other-agent');
		assert.strictEqual(s?.agentSessionId, 'sess-d2');
	});

	test('专属会话被删（索引中不存在）→ 自动重建并更新映射', async () => {
		const { mocks, counts, createdIds } = makeDedicatedMocks();
		const { createMemorySessionMapStore } = await import('../../browser/bridge/bridgeSessionMap.js');
		const store = createMemorySessionMapStore();

		const engine1 = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store });
		await engine1.handleInbound(feishuMsg('hi') as any);
		await flush();
		assert.strictEqual(counts.create, 1);

		// 模拟用户在 UI 删掉了 sess-d1（索引清空）
		createdIds.length = 0;
		const engine2 = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store });
		await engine2.handleInbound(feishuMsg('hi again') as any);
		await flush();

		assert.strictEqual(counts.create, 2, '会话被删后应重建');
		assert.strictEqual(store.get('feishu', 'oc_group1')?.agentSessionId, 'sess-d2', '映射应更新到新会话');
	});
});

suite('BridgeEngine /list 与 /switch 会话选择', () => {

	/** loopback 入站（getOrCreateActiveSession → sess-active）+ 带 updatedAt 的会话索引。 */
	function makeListMocks() {
		const mocks = makeMocks();
		const chat = mocks.chat as any;
		chat.listAgentSessions = async () => [
			{ id: 'sess-active', name: '当前会话', createdAt: '', updatedAt: '2026-09-22T10:00:00Z', messageCount: 5 },
			{ id: 'sess-plan', name: '发布计划讨论', createdAt: '', updatedAt: '2026-09-21T10:00:00Z', messageCount: 9 },
			{ id: 'sess-note', name: '计划外笔记', createdAt: '', updatedAt: '2026-09-20T10:00:00Z', messageCount: 2 },
		];
		return mocks;
	}

	async function bootWithList() {
		const mocks = makeListMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });
		engine.registerPlatform(lb);
		await engine.start();
		lb.postInbound('hi'); // 建立会话（→ sess-active）
		await flush();
		lb.clearOutbounds();
		return { mocks, lb, engine };
	}

	test('/list 标注当前会话（●），按最近活跃排序', async () => {
		const { lb } = await bootWithList();
		lb.postInbound('/list');
		await flush();

		const result = lb.outbounds.find(o => o.type === 'result');
		assert.ok(result, '应有列表输出');
		assert.ok(result!.content.includes('● 1. 当前会话'), '当前会话应标注 ● 且排第一');
		assert.ok(result!.content.includes('○ 2. 发布计划讨论'), '其余会话标注 ○');
		assert.ok(result!.content.includes('(sess-plan)'), '列表应含会话 id');
	});

	test('/sessions 与 /list 输出等价', async () => {
		const { lb } = await bootWithList();
		lb.postInbound('/list');
		await flush();
		const listOut = lb.outbounds.find(o => o.type === 'result')?.content;
		lb.clearOutbounds();
		lb.postInbound('/sessions');
		await flush();
		const sessionsOut = lb.outbounds.find(o => o.type === 'result')?.content;
		assert.strictEqual(sessionsOut, listOut);
	});

	test('/switch 按序号切换', async () => {
		const { lb, engine } = await bootWithList();
		lb.postInbound('/switch 2');
		await flush();

		assert.ok(lb.outbounds.find(o => o.content.includes('已切换到会话：发布计划讨论')), '应提示切换成功');
		assert.strictEqual(engine.getSession('loopback:default')?.agentSessionId, 'sess-plan');
	});

	test('/switch 按名称模糊匹配（唯一命中）', async () => {
		const { lb, engine } = await bootWithList();
		lb.postInbound('/switch 笔记');
		await flush();

		assert.ok(lb.outbounds.find(o => o.content.includes('已切换到会话：计划外笔记')));
		assert.strictEqual(engine.getSession('loopback:default')?.agentSessionId, 'sess-note');
	});

	test('/switch 名称多命中 → 列出候选要求精确指定', async () => {
		const { lb, engine } = await bootWithList();
		lb.postInbound('/switch 计划');
		await flush();

		const result = lb.outbounds.find(o => o.type === 'result');
		assert.ok(result?.content.includes('匹配到多个会话'), '应提示多命中');
		assert.ok(result?.content.includes('发布计划讨论') && result?.content.includes('计划外笔记'), '应列出候选');
		assert.strictEqual(engine.getSession('loopback:default')?.agentSessionId, 'sess-active', '多命中时不应切换');
	});

	test('/switch 按会话 id 精确切换', async () => {
		const { lb, engine } = await bootWithList();
		lb.postInbound('/switch sess-plan');
		await flush();

		assert.ok(lb.outbounds.find(o => o.content.includes('已切换到会话：发布计划讨论')));
		assert.strictEqual(engine.getSession('loopback:default')?.agentSessionId, 'sess-plan');
	});

	test('bindConversationToSession → 群消息路由到指定会话并 fire 事件', async () => {
		const { mocks, counts } = makeDedicatedMocks();
		const { createMemorySessionMapStore } = await import('../../browser/bridge/bridgeSessionMap.js');
		const store = createMemorySessionMapStore();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store });

		const events: Array<{ platform: string; conversationId?: string }> = [];
		engine.onDidChangeBindings(e => events.push(e));

		// UI 绑定：chat_id → 现存会话 sess-manual（模拟 listAgentSessions 里已有）
		(mocks.chat as any).listAgentSessions = async () => [
			{ id: 'sess-manual', name: '手动会话', createdAt: '', updatedAt: '', messageCount: 1 },
		];
		engine.bindConversationToSession('feishu', 'oc_group9', 'coder', 'sess-manual');

		assert.strictEqual(events.length, 1, '绑定应 fire 一次事件');
		assert.deepStrictEqual(events[0], { platform: 'feishu', conversationId: 'oc_group9' });
		assert.strictEqual(store.get('feishu', 'oc_group9')?.agentSessionId, 'sess-manual');
		// chat→Agent 绑定同步建立
		assert.strictEqual(engine.getConversationAgent('feishu', 'oc_group9'), 'coder');

		// 入站消息应路由到 sess-manual，不新建专属会话
		await engine.handleInbound({
			sessionKey: 'feishu:oc_group9:ou_u1', platform: 'feishu', messageId: 'm1',
			userId: 'ou_u1', userName: 'u1', conversationId: 'oc_group9', content: 'hi', isPermissionResponse: false,
		} as any);
		await flush();
		assert.strictEqual(counts.create, 0, '已绑定指定会话时不得新建');
		assert.strictEqual(engine.getSession('feishu:oc_group9:ou_u1')?.agentSessionId, 'sess-manual');
	});

	test('unbindConversationSession → 解除映射，下条消息新建专属会话', async () => {
		const { mocks, counts } = makeDedicatedMocks();
		const { createMemorySessionMapStore } = await import('../../browser/bridge/bridgeSessionMap.js');
		const store = createMemorySessionMapStore();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store });

		engine.bindConversationToSession('feishu', 'oc_g', 'coder', 'sess-x');
		assert.strictEqual(engine.getConversationSession('feishu', 'oc_g')?.agentSessionId, 'sess-x');
		assert.strictEqual(engine.listSessionBindings('feishu').length, 1);

		let fired = 0;
		engine.onDidChangeBindings(() => fired++);
		engine.unbindConversationSession('feishu', 'oc_g');
		assert.strictEqual(engine.getConversationSession('feishu', 'oc_g'), undefined);
		assert.strictEqual(engine.listSessionBindings('feishu').length, 0);
		assert.strictEqual(fired, 1, '解绑应 fire 事件');

		// chat→Agent 绑定保留（会话级解绑不影响 agent 路由），下条消息新建专属会话
		assert.strictEqual(engine.getConversationAgent('feishu', 'oc_g'), 'coder');
		await engine.handleInbound({
			sessionKey: 'feishu:oc_g:ou_u1', platform: 'feishu', messageId: 'm2',
			userId: 'ou_u1', userName: 'u1', conversationId: 'oc_g', content: 'hi', isPermissionResponse: false,
		} as any);
		await flush();
		assert.strictEqual(counts.create, 1, '解绑后应新建专属会话');
	});

	test('onDidChangeBindings 在换绑/解绑/切换会话时均 fire', async () => {
		const { mocks } = makeDedicatedMocks();
		const { createMemorySessionMapStore } = await import('../../browser/bridge/bridgeSessionMap.js');
		const store = createMemorySessionMapStore();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store });
		const events: string[] = [];
		engine.onDidChangeBindings(e => events.push(`${e.platform}:${e.conversationId ?? '-'}`));

		engine.setConversationAgent('feishu', 'oc_a', 'coder');
		engine.clearConversationAgent('feishu', 'oc_a');
		// switchSession：先建内存会话再切换
		await engine.handleInbound({
			sessionKey: 'feishu:oc_b:ou_u1', platform: 'feishu', messageId: 'm1',
			userId: 'ou_u1', userName: 'u1', conversationId: 'oc_b', content: 'hi', isPermissionResponse: false,
		} as any);
		await flush();
		const before = events.length;
		engine.switchSession('feishu:oc_b:ou_u1', 'sess-other');

		assert.ok(events.includes('feishu:oc_a'), '换绑/解绑应各 fire 一次');
		assert.strictEqual(events.length, before + 1, 'switchSession 写映射应 fire');
		assert.strictEqual(events[events.length - 1], 'feishu:oc_b');
	});

	test('渠道默认会话：无精确映射的群消息进默认会话（不新建、不写映射）', async () => {
		const { mocks, counts } = makeDedicatedMocks();
		const { createMemorySessionMapStore } = await import('../../browser/bridge/bridgeSessionMap.js');
		const store = createMemorySessionMapStore();
		const configStore = new Map<string, string>([
			['sessions.channel.feishu.defaultAgent', 'coder'],
			['sessions.channel.feishu.defaultSession', 'sess-default'],
		]);
		const configurationService = {
			getValue: (k: string) => configStore.get(k),
			updateValue: (k: string, v: string) => { if (v) { configStore.set(k, v); } else { configStore.delete(k); } },
		} as any;
		// 默认会话存在于索引中
		(mocks.chat as any).listAgentSessions = async () => [
			{ id: 'sess-default', name: '默认会话', createdAt: '', updatedAt: '', messageCount: 0 },
		];
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, sessionMapStore: store, configurationService });

		await engine.handleInbound(feishuMsg('hi') as any);
		await flush();

		assert.strictEqual(counts.create, 0, '有默认会话时不得新建专属会话');
		assert.strictEqual(engine.getSession('feishu:oc_group1:ou_user1')?.agentSessionId, 'sess-default');
		assert.strictEqual(store.get('feishu', 'oc_group1'), undefined, '默认会话不得写入精确映射（保持跟随能力）');
	});

	test('渠道默认会话被删 → 回落新建专属会话', async () => {
		const { mocks, counts } = makeDedicatedMocks();
		const configStore = new Map<string, string>([
			['sessions.channel.feishu.defaultAgent', 'coder'],
			['sessions.channel.feishu.defaultSession', 'sess-gone'],
		]);
		const configurationService = {
			getValue: (k: string) => configStore.get(k),
			updateValue: (k: string, v: string) => { if (v) { configStore.set(k, v); } else { configStore.delete(k); } },
		} as any;
		// 索引为空：sess-gone 已删
		(mocks.chat as any).listAgentSessions = async () => [];
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, configurationService });

		await engine.handleInbound(feishuMsg('hi') as any);
		await flush();

		assert.strictEqual(counts.create, 1, '默认会话失效后应新建专属会话');
		assert.strictEqual(engine.getSession('feishu:oc_group1:ou_user1')?.agentSessionId, 'sess-d1');
	});

	test('换默认会话后，未精确绑定的内存会话漂移跟随', async () => {
		const { mocks } = makeDedicatedMocks();
		const configStore = new Map<string, string>([
			['sessions.channel.feishu.defaultAgent', 'coder'],
			['sessions.channel.feishu.defaultSession', 'sess-A'],
		]);
		const configurationService = {
			getValue: (k: string) => configStore.get(k),
			updateValue: (k: string, v: string) => { if (v) { configStore.set(k, v); } else { configStore.delete(k); } },
		} as any;
		(mocks.chat as any).listAgentSessions = async () => [
			{ id: 'sess-A', name: 'A', createdAt: '', updatedAt: '', messageCount: 0 },
			{ id: 'sess-B', name: 'B', createdAt: '', updatedAt: '', messageCount: 0 },
		];
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, configurationService });

		await engine.handleInbound(feishuMsg('first') as any);
		await flush();
		assert.strictEqual(engine.getSession('feishu:oc_group1:ou_user1')?.agentSessionId, 'sess-A');

		// 换默认会话 → 下条消息（内存命中）应漂移
		engine.setChannelDefaultSession('feishu', 'coder', 'sess-B');
		await engine.handleInbound(feishuMsg('second') as any);
		await flush();
		assert.strictEqual(engine.getSession('feishu:oc_group1:ou_user1')?.agentSessionId, 'sess-B', '应漂移到新默认会话');
	});

	test('session.replyCtx 持久化：合成消息（调度器/relay）经已存句柄回传', async () => {
		const mocks = makeMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });
		engine.registerPlatform(lb);
		await engine.start();

		// 入站消息带 replyCtx → 写入 session
		lb.postInbound('hello', 'loopback:g1:u1', 'CTX_1');
		await flush();
		assert.strictEqual(engine.getSession('loopback:g1:u1')?.replyCtx, 'CTX_1');
		lb.clearOutbounds();

		// 合成消息（无 replyCtx）→ 出站应回退到 session 已存句柄
		await engine.handleSynthetic('loopback:g1:u1', 'cron 触发');
		await flush();
		const out = lb.outbounds.find(o => o.type === 'result');
		assert.ok(out, '应有 result 出站');
		assert.strictEqual(out!.replyCtx, 'CTX_1', '合成消息出站应使用 session 已存 replyCtx');
	});

	test('命令回复使用入站消息的 replyCtx（回归：飞书 /list 不再缺 chat_id）', async () => {
		const mocks = makeMocks();
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });
		engine.registerPlatform(lb);
		await engine.start();

		lb.postInbound('/list', 'loopback:g1:u1', 'CTX_CMD');
		await flush();
		const out = lb.outbounds.find(o => o.type === 'result');
		assert.ok(out, '/list 应有输出');
		assert.strictEqual(out!.replyCtx, 'CTX_CMD', '命令回复必须带入站消息的 replyCtx');
		// 同时已写入 session（供后续合成消息兜底）
		assert.strictEqual(engine.getSession('loopback:g1:u1')?.replyCtx, 'CTX_CMD');
	});

	test('setChannelDefaultSession fire onDidChangeBindings', async () => {
		const { mocks } = makeDedicatedMocks();
		const configStore = new Map<string, string>();
		const configurationService = {
			getValue: (k: string) => configStore.get(k),
			updateValue: (k: string, v: string) => { if (v) { configStore.set(k, v); } else { configStore.delete(k); } },
		} as any;
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log, configurationService });
		const events: Array<{ platform: string }> = [];
		engine.onDidChangeBindings(e => events.push(e));

		engine.setChannelDefaultSession('feishu', 'coder', 'sess-X');
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].platform, 'feishu');
		assert.strictEqual(configStore.get('sessions.channel.feishu.defaultSession'), 'sess-X');
		// 清除
		engine.setChannelDefaultSession('feishu', 'coder', undefined);
		assert.strictEqual(configStore.get('sessions.channel.feishu.defaultSession'), undefined);
		assert.strictEqual(events.length, 2);
	});

	test('/new 带名称 → 新建命名会话并切换', async () => {
		const mocks = makeListMocks();
		const chat = mocks.chat as any;
		chat.createAgentSession = async (_agentId: string, name?: string) => ({
			id: 'sess-brand-new', name: name ?? '?', createdAt: '', updatedAt: '', messageCount: 0,
		});
		const lb = new LoopbackPlatform();
		const engine = new BridgeEngine({ chat: mocks.chat, studio: mocks.studio, logService: mocks.log });
		engine.registerPlatform(lb);
		await engine.start();
		lb.postInbound('hi');
		await flush();
		lb.clearOutbounds();

		lb.postInbound('/new 我的新话题');
		await flush();

		const result = lb.outbounds.find(o => o.type === 'result');
		assert.ok(result?.content.includes('已新建并切换到会话：我的新话题'), '应带名称提示');
		assert.strictEqual(engine.getSession('loopback:default')?.agentSessionId, 'sess-brand-new');
	});
});
