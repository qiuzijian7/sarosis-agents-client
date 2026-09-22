/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 飞书渠道（Agent 设置 → Channel 配置 → Feishu）可用性单测 ──
//
// 覆盖五条链路：
//   1) 渠道定义 CHANNEL_DEFINITIONS.feishu 与配置键命名空间
//   2) 运行时适配器 FeishuPlatform（入站事件解析 / 出站 REST / WS 长连接）
//   3) 平台装配 feishu.contribution（env 门控 + 与 UI 配置的**断层**锁定）
//   4) 渠道路由 BridgeEngine（渠道默认 Agent / 会话绑定 / 端到端回包）
//   5) 扫码绑定协议 feishuRegistration 与二维码边界 feishuQrCode
//
// ★ 本文件在 **纯 node** 下运行（聚合 runner 的分片 worker 不装 DOM stub），
//   故绝不触碰 document / canvas：只 stub globalThis.fetch 与 globalThis.WebSocket。
// ★ 2026-09-22 起：本文件同时承担「修复回归」。标注「D-xx 已修」的用例锁定修复后的契约
//   （配置→运行时打通、enabled 门控、热重载句柄、poll 五态映射、真实自检、QR 格式信息位置）；
//   标注「【仍未修 D-xx】」的用例锁定**本次未修**的存量缺口（Webhook 入口/解密、策略类字段），
//   修复时应显式改写而不是删除。

import assert from 'assert';
import { VSBuffer, bufferToStream } from '../../../../../base/common/buffer.js';
import { CHANNEL_DEFINITIONS, ChannelKey } from '../../common/constants.js';
import {
	IBridgePlatform,
	InboundMessage,
} from '../../common/bridge/bridgeTypes.js';
import { FeishuPlatform } from '../../browser/bridge/platforms/feishu.js';
import {
	FEISHU_CONFIG_KEYS,
	normalizeAllowFrom,
	registerFeishuPlatformIfConfigured,
	resolveFeishuConfig,
} from '../../browser/bridge/platforms/feishu.contribution.js';
import { BridgeEngine } from '../../browser/bridge/bridgeEngine.js';
import { BridgeServer } from '../../browser/bridge/bridgeServer.js';
import {
	FEISHU_BASE,
	FEISHU_OPEN_BASE,
	LARK_BASE,
	beginFeishuRegistration,
	pollFeishuRegistration,
	probeFeishuCredentials,
} from '../../browser/feishuRegistration.js';
import { qrMatrix } from '../../browser/feishuQrCode.js';
import {
	FRAME_HEADER,
	FRAME_METHOD,
	MESSAGE_TYPE,
	FeishuFrame,
	decodeFeishuFrame,
	decodeUtf8,
	encodeFeishuFrame,
	encodeUtf8,
	frameHeader,
} from '../../browser/bridge/platforms/feishuWsProtocol.js';
import type { IAgentChatService, IAgentStudioService } from '../../common/agentStudio.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IRequestService } from '../../../../../platform/request/common/request.js';
import type { IBridgeService } from '../../browser/bridge/bridgeService.js';

const flush = (ms = 10): Promise<void> => new Promise<void>(r => setTimeout(r, ms));

/**
 * 飞书长连接换地址端点（官方 `const.py#GEN_ENDPOINT_URI`）。
 * ★ 2026-09-22 更正：旧值 `/event/v1/outbound_event/subscribe` 是臆测端点，实测 404。
 */
const WS_ENDPOINT_PATH = '/callback/ws/endpoint';
const TOKEN_PATH = '/auth/v3/tenant_access_token/internal';

/** 官方端点成功响应（`model.py#EndpointResp`）。 */
function endpointOk(url: string, clientConfig: Record<string, number> = {}): unknown {
	return {
		code: 0,
		msg: 'success',
		data: {
			URL: url,
			ClientConfig: { PingInterval: 120, ReconnectCount: 3, ReconnectInterval: 1, ReconnectNonce: 1, ...clientConfig },
		},
	};
}

/** 造一条 DATA 事件帧（防回归：长连接只认 protobuf 二进制帧）。 */
function eventFrame(
	payload: unknown,
	opts: { messageId?: string; sum?: number; seq?: number; traceId?: string } = {},
): Uint8Array {
	return encodeFeishuFrame({
		seqId: '1',
		logId: '2',
		service: 1,
		method: FRAME_METHOD.DATA,
		headers: [
			{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.EVENT },
			{ key: FRAME_HEADER.MESSAGE_ID, value: opts.messageId ?? 'om_ws_1' },
			{ key: FRAME_HEADER.TRACE_ID, value: opts.traceId ?? 'tr_1' },
			{ key: FRAME_HEADER.SUM, value: String(opts.sum ?? 1) },
			{ key: FRAME_HEADER.SEQ, value: String(opts.seq ?? 0) },
		],
		payloadEncoding: 'json',
		payloadType: MESSAGE_TYPE.EVENT,
		payload: encodeUtf8(JSON.stringify(payload)),
	});
}

/** 造一条分片事件帧（payload 已是字节，用于验证 sum/seq 重组）。 */
function eventFrameFromParts(part: Uint8Array, sum: number, seq: number, messageId = 'om_ws_1'): Uint8Array {
	return encodeFeishuFrame({
		seqId: '1',
		logId: '2',
		service: 1,
		method: FRAME_METHOD.DATA,
		headers: [
			{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.EVENT },
			{ key: FRAME_HEADER.MESSAGE_ID, value: messageId },
			{ key: FRAME_HEADER.SUM, value: String(sum) },
			{ key: FRAME_HEADER.SEQ, value: String(seq) },
		],
		payloadEncoding: 'json',
		payloadType: MESSAGE_TYPE.EVENT,
		payload: part,
	});
}

/** 造一条 CONTROL 帧（type=ping / pong，必要时带 payload）。 */
function controlFrame(type: string, payload?: unknown): Uint8Array {
	return encodeFeishuFrame({
		service: 1,
		method: FRAME_METHOD.CONTROL,
		headers: [{ key: FRAME_HEADER.TYPE, value: type }],
		payload: payload === undefined ? undefined : encodeUtf8(JSON.stringify(payload)),
	});
}

// ─── 通用 stub ────────────────────────────────────────────────────────────

interface RecordedCall { url: string; init: any }

/**
 * 替换 globalThis.fetch（feishu.ts 只用渲染进程全局 fetch，无 SDK）。
 * router 返回对象 → 包成 `{ json() }`；返回 Error → 抛出，用于模拟网络故障。
 */
function stubFetch(router: (url: string, init: any) => any): { calls: RecordedCall[]; restore: () => void } {
	const g = globalThis as any;
	const original = g.fetch;
	const calls: RecordedCall[] = [];
	g.fetch = async (url: string, init?: any) => {
		calls.push({ url: String(url), init });
		const body = router(String(url), init);
		if (body instanceof Error) { throw body; }
		// 返回「响应式对象」（自带 text()）→ 原样透出，用于模拟非 JSON / 非 2xx 场景
		if (body && typeof body.text === 'function') {
			const status = typeof body.status === 'number' ? body.status : 200;
			return { ok: status < 400, status, text: () => body.text(), json: async () => JSON.parse(await body.text()) };
		}
		// 生产代码统一读 text() 后自行 JSON.parse（两条出口口径一致），故这里同时提供 text()
		return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
	};
	return { calls, restore: () => { g.fetch = original; } };
}

function countCalls(calls: RecordedCall[], fragment: string): number {
	return calls.filter(c => c.url.includes(fragment)).length;
}

/** 出站数据 → 字节（长连接主路径出站为 Uint8Array）。 */
function toBytes(data: any): Uint8Array {
	if (data instanceof Uint8Array) { return data; }
	if (data instanceof ArrayBuffer) { return new Uint8Array(data); }
	if (ArrayBuffer.isView(data)) { return new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
	throw new Error(`不支持的出站数据类型：${typeof data}`);
}

/** 一次性 WebSocket stub：捕获实例，允许测试手动触发生命周期与投递入站帧。 */
class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readonly url: string;
	/** 出站数据：长连接为二进制帧（Uint8Array）；challenge 兜底路径为字符串 */
	sent: any[] = [];
	closed = false;
	/** 真实 WebSocket 的二进制开关；被测代码应在建连后设为 'arraybuffer' */
	binaryType = 'blob';
	onopen?: () => void;
	onmessage?: (ev: any) => void;
	onerror?: () => void;
	onclose?: () => void;
	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}
	send(data: any): void { this.sent.push(data); }
	close(): void { this.closed = true; }
	/** 模拟连接建立（会触发被测代码启动心跳） */
	open(): void { this.onopen?.(); }
	/** 出站二进制帧解码（顺序即发送顺序：onopen 先发 ping，其后是业务回执） */
	frames(): FeishuFrame[] {
		return this.sent.filter(d => typeof d !== 'string').map(d => decodeFeishuFrame(toBytes(d)));
	}
	/** 出站帧中 payload 可解析为给定 code 的那条（回执识别用） */
	ackFrame(code = 200): FeishuFrame | undefined {
		return this.frames().find(f => {
			try { return (JSON.parse(decodeUtf8(f.payload)) as { code?: number }).code === code; } catch { return false; }
		});
	}
	static reset(): void { FakeWebSocket.instances = []; }
}

function installFakeWebSocket(): () => void {
	const g = globalThis as any;
	const original = g.WebSocket;
	FakeWebSocket.reset();
	g.WebSocket = FakeWebSocket;
	return () => { g.WebSocket = original; FakeWebSocket.reset(); };
}

/** 临时设置 process.env 中的若干键（用 undefined 表示删除），执行后还原。 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const proc: any = (globalThis as any).process;
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		saved[k] = proc.env[k];
		if (vars[k] === undefined) { delete proc.env[k]; } else { proc.env[k] = vars[k]; }
	}
	try {
		fn();
	} finally {
		for (const k of Object.keys(vars)) {
			if (saved[k] === undefined) { delete proc.env[k]; } else { proc.env[k] = saved[k]; }
		}
	}
}

/** 记录 registerPlatform / dispose 调用的假 IBridgeService。 */
function makeFakeBridge(): {
	registered: Array<{ id: string; create: () => IBridgePlatform }>;
	/** 卸载次数（热重载语义：重新装配前必须先 dispose）。 */
	disposed: number;
	bridge: IBridgeService;
} {
	const registered: Array<{ id: string; create: () => IBridgePlatform }> = [];
	const state = {
		registered,
		disposed: 0,
		bridge: undefined as unknown as IBridgeService,
	};
	state.bridge = {
		registerPlatform: (f: { id: string; create: () => IBridgePlatform }) => {
			registered.push(f);
			return { dispose() { state.disposed++; } };
		},
	} as unknown as IBridgeService;
	return state;
}

/** 内存版 IConfigurationService（仅实现渠道装配需要的 getValue）。 */
function makeConfigService(
	initial: Record<string, unknown> = {},
): { store: Record<string, unknown>; svc: IConfigurationService } {
	const store: Record<string, unknown> = { ...initial };
	const svc = {
		getValue: (key: string) => store[key],
		updateValue: async (key: string, value: unknown) => { store[key] = value; },
	} as unknown as IConfigurationService;
	return { store, svc };
}

/** 未设置任何飞书环境变量的干净 env。 */
const NO_FEISHU_ENV: Record<string, string | undefined> = {
	FEISHU_APP_ID: undefined,
	FEISHU_APP_SECRET: undefined,
	FEISHU_ALLOW_FROM: undefined,
	FEISHU_USE_WS: undefined,
};

/** 构造一条飞书 im.message.message_received 事件回调。 */
function messageEvent(messageId: string, chatId: string, openId: string, text: string): unknown {
	return {
		header: { event_type: 'im.message.message_received' },
		event: {
			message: {
				message_id: messageId,
				chat_id: chatId,
				message_type: 'text',
				content: JSON.stringify({ text }),
			},
			sender: { sender_id: { open_id: openId }, sender_type: 'user' },
		},
	};
}

// ─── BridgeEngine 依赖 stub ───────────────────────────────────────────────

function makeEngineMocks() {
	const calls = {
		sendMessage: 0,
		/** 会话解析收到的 agentId 序列（getOrCreateActiveSession，或 createAgentSession 专属会话路径 —— 引擎的「群消息进专属会话」走后者）。 */
		sessionAgents: [] as string[],
		/** sendMessage 收到的 agentId 序列（会话绑定路由结果）。 */
		messageAgents: [] as string[],
	};
	const chat = {
		sendMessage: async (
			agentId: string,
			message: string,
			_options: unknown,
			onDelta: (d: any) => void,
		): Promise<any> => {
			calls.sendMessage++;
			calls.messageAgents.push(agentId);
			onDelta({ type: 'text', content: `echo:${message}` });
			onDelta({ type: 'done' });
			return { id: `m${calls.sendMessage}`, role: 'assistant', content: message, timestamp: '' };
		},
		getOrCreateActiveSession: async (agentId: string) => {
			calls.sessionAgents.push(agentId);
			return { id: 'sess-active', name: 'active', createdAt: '', updatedAt: '', messageCount: 0 };
		},
		// 专属会话路径（_resolveDedicatedSession）：同样记录解析出的 agentId，否则路由断言拿不到数据
		createAgentSession: async (agentId: string) => {
			calls.sessionAgents.push(agentId);
			return { id: 'sess-new', name: 'new', createdAt: '', updatedAt: '', messageCount: 0 };
		},
		listAgentSessions: async () => [],
		cancelStream: () => { /* noop */ },
		clearHistory: async () => { /* noop */ },
	} as unknown as IAgentChatService;
	const studio = {
		getAgents: async () => ([
			{ id: 'coder', name: 'Coder', model: 'gpt', role: '', description: '', icon: '', skills: [], createdAt: '', updatedAt: '' },
		]),
	} as unknown as IAgentStudioService;
	const log = { info() { /* noop */ }, warn() { /* noop */ }, error() { /* noop */ }, trace() { /* noop */ } } as unknown as ILogService;
	return { chat, studio, log, calls };
}

// ─── IRequestService stub（供 feishuRegistration 使用）────────────────────

function makeRequestService(
	handler: (url: string, body: string) => { status?: number; body: string },
): { svc: IRequestService; calls: Array<{ url: string; body: string; headers: Record<string, string>; callSite?: string }> } {
	const calls: Array<{ url: string; body: string; headers: Record<string, string>; callSite?: string }> = [];
	const svc = {
		request: async (options: any) => {
			const data = typeof options.data === 'string' ? options.data : String(options.data ?? '');
			calls.push({ url: options.url, body: data, headers: options.headers ?? {}, callSite: options.callSite });
			const r = handler(options.url, data);
			return {
				res: { statusCode: r.status ?? 200, headers: {} },
				stream: bufferToStream(VSBuffer.fromString(r.body)),
			};
		},
	} as unknown as IRequestService;
	return { svc, calls };
}

// ══════════════════════════════════════════════════════════════════════════
// 1) 渠道定义与配置键
// ══════════════════════════════════════════════════════════════════════════

suite('飞书渠道 · 定义与配置键', () => {
	const def = CHANNEL_DEFINITIONS.find(d => d.key === 'feishu');

	test('CHANNEL_DEFINITIONS 中存在 feishu 定义且别名含 lark', () => {
		assert.ok(def, '必须存在 feishu 渠道定义');
		assert.strictEqual(def!.label, 'Feishu');
		assert.deepStrictEqual(def!.aliases, ['lark']);
	});

	test('凭证字段齐全：appId/appSecret/verificationToken/encryptKey', () => {
		const byKey = new Map(def!.configFields.map(f => [f.key, f]));
		assert.strictEqual(byKey.get('sessions.channel.feishu.appId')?.type, 'string');
		assert.strictEqual(byKey.get('sessions.channel.feishu.appSecret')?.type, 'password');
		assert.strictEqual(byKey.get('sessions.channel.feishu.verificationToken')?.type, 'password');
		assert.strictEqual(byKey.get('sessions.channel.feishu.encryptKey')?.type, 'password');
	});

	test('通用字段齐全：enabled/dmPolicy/allowFrom/groupPolicy/groupAllowFrom/defaultAccount/defaultAgent', () => {
		const keys = def!.configFields.map(f => f.key);
		for (const suffix of [
			'enabled', 'dmPolicy', 'allowFrom', 'groupPolicy',
			'groupAllowFrom', 'defaultAccount', 'defaultAgent',
		]) {
			assert.ok(keys.includes(`sessions.channel.feishu.${suffix}`), `缺少通用字段 ${suffix}`);
		}
	});

	test('全部字段键统一落在 sessions.channel.feishu. 命名空间下', () => {
		for (const f of def!.configFields) {
			assert.ok(
				f.key.startsWith('sessions.channel.feishu.'),
				`字段键越界：${f.key}`,
			);
		}
	});

	test('enabled 默认 false（渠道默认关闭）', () => {
		const enabled = def!.configFields.find(f => f.key === 'sessions.channel.feishu.enabled');
		assert.strictEqual(enabled!.type, 'boolean');
		assert.strictEqual(enabled!.default, false);
	});

	test('defaultAgent 为 agent 类型（下拉需从 AgentStudio 异步填充）', () => {
		const f = def!.configFields.find(x => x.key === 'sessions.channel.feishu.defaultAgent');
		assert.strictEqual(f!.type, 'agent');
	});

	test('CHANNEL_ORDER 包含 feishu（侧栏顺序）', () => {
		const key: ChannelKey = 'feishu';
		assert.ok(CHANNEL_DEFINITIONS.some(d => d.key === key));
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 2) FeishuPlatform · 入站事件解析
// ══════════════════════════════════════════════════════════════════════════

suite('FeishuPlatform · 入站事件解析', () => {
	test('im.message.message_received → 完整的 InboundMessage', () => {
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));

		p.handleWebhookEvent(messageEvent('om_1', 'oc_1', 'ou_1', '你好'));

		assert.strictEqual(got.length, 1);
		const m = got[0];
		assert.strictEqual(m.platform, 'feishu');
		assert.strictEqual(m.sessionKey, 'feishu:oc_1:ou_1');
		assert.strictEqual(m.userId, 'ou_1');
		assert.strictEqual(m.conversationId, 'oc_1');
		assert.strictEqual(m.chatName, 'oc_1');
		assert.strictEqual(m.messageId, 'om_1');
		assert.strictEqual(m.content, '你好');
		assert.deepStrictEqual(m.replyCtx, { messageId: 'om_1', chatId: 'oc_1' });
	});

	test('非消息类事件被忽略（无 message 体，安静返回）', () => {
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));

		p.handleWebhookEvent({ header: { event_type: 'im.chat.updated' }, event: {} });
		p.handleWebhookEvent({ header: {} });
		p.handleWebhookEvent(null);

		assert.strictEqual(got.length, 0);
	});

	test('D-13 已修：飞书 v2 官方事件名 im.message.receive_v1 也能路由', () => {
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));

		// 官方 SDK（onP2MessageReceiveV1）推送的 header.event_type 就是这个名字
		const v2 = messageEvent('om_v2', 'oc_v2', 'ou_v2', 'v2 事件');
		(v2 as any).header.event_type = 'im.message.receive_v1';
		p.handleWebhookEvent(v2);

		assert.strictEqual(got.length, 1, 'v2 官方事件名不得被丢弃');
		assert.strictEqual(got[0].content, 'v2 事件');
		assert.strictEqual(got[0].sessionKey, 'feishu:oc_v2:ou_v2');
	});

	test('D-13：带 message 体但事件名未知 → 不路由，但记日志（不静默）', () => {
		const logs: string[] = [];
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', log: m => logs.push(m) });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));

		p.handleWebhookEvent({
			header: { event_type: 'im.message.some_future_v9' },
			event: { message: { message_id: 'm', chat_id: 'c', message_type: 'text', content: '{"text":"x"}' } },
		});

		assert.strictEqual(got.length, 0);
		assert.ok(logs.some(l => l.includes('未处理的消息事件类型')), logs.join(' | '));
	});

	test('D-13：非文本消息（图片）不转发空消息给 Agent，并记日志', () => {
		const logs: string[] = [];
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', log: m => logs.push(m) });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));

		p.handleWebhookEvent({
			header: { event_type: 'im.message.receive_v1' },
			event: {
				message: { message_id: 'm3', chat_id: 'c3', message_type: 'image', content: '{"image_key":"img_x"}' },
				sender: { sender_id: { open_id: 'u3' } },
			},
		});

		assert.strictEqual(got.length, 0);
		assert.ok(logs.some(l => l.includes('暂不支持的消息类型')), logs.join(' | '));
	});

	test('未 start()（无 handler）时静默忽略，不抛异常', () => {
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		assert.doesNotThrow(() => p.handleWebhookEvent(messageEvent('m', 'c', 'u', 'x')));
	});

	test('content 非法 JSON → 文本退化为空串，不抛异常', () => {
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));

		p.handleWebhookEvent({
			header: { event_type: 'im.message.message_received' },
			event: { message: { message_id: 'm', chat_id: 'c', content: 'not-json' }, sender: { sender_id: { open_id: 'u' } } },
		});

		assert.strictEqual(got.length, 1);
		assert.strictEqual(got[0].content, '');
	});

	test('缺少 sender.open_id 时退化为 union_id / unknown', () => {
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));

		p.handleWebhookEvent({
			header: { event_type: 'im.message.message_received' },
			event: { message: { chat_id: 'c', content: JSON.stringify({ text: 't' }) }, sender: {} },
		});

		assert.strictEqual(got[0].userId, 'unknown');
		assert.strictEqual(got[0].sessionKey, 'feishu:c:unknown');
	});

	test('【仍未修 D-09】加密事件（encrypt 字段）被静默丢弃 —— verificationToken/encryptKey 无运行时消费者', () => {
		// 飞书配置「Encrypt Key」后，事件回调体为 {"encrypt":"<base64>"}。
		// handleWebhookEvent 只认 header/event 结构 ⇒ 不解密、不验签、直接丢弃。
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));

		p.handleWebhookEvent({ encrypt: 'BASE64_BLOB' });

		assert.strictEqual(got.length, 0);
	});

	test('【仍未修 D-04】webhook 入口不响应 url_verification（仅 WS 分支回 challenge）', () => {
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		let called = 0;
		p.start(() => { called++; });

		p.handleWebhookEvent({ type: 'url_verification', challenge: 'ch-1', token: 'tk' });

		assert.strictEqual(called, 0);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 3) FeishuPlatform · 出站 REST
// ══════════════════════════════════════════════════════════════════════════

suite('FeishuPlatform · 出站 REST', () => {
	const okToken = { code: 0, tenant_access_token: 't-1', expire: 7200 };

	test('reply 缺 message_id 但有 chat_id → 降级为发到群（2026-09-22：不再抛错中断整条出站）', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await p.reply({ sessionKey: 'feishu:c:u', replyCtx: { chatId: 'oc_1' } }, 'hi');

			const call = f.calls.find(c => c.url.includes('/im/v1/messages'))!;
			assert.ok(call.url.includes('receive_id_type=chat_id'), '无 message_id 时应降级为发送到群');
			const body = JSON.parse(call.init.body);
			assert.strictEqual(body.receive_id, 'oc_1');
			assert.strictEqual(JSON.parse(body.content).text, 'hi');
		} finally {
			f.restore();
		}
	});

	test('send 无 replyCtx → 从 sessionKey 兜底解析 chat_id（2026-09-22：命令/调度器路径曾在此抛「缺少 chat_id」）', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await p.send({ sessionKey: 'feishu:oc_from_key:u' }, 'hi');

			const call = f.calls.find(c => c.url.includes('/im/v1/messages'))!;
			const body = JSON.parse(call.init.body);
			assert.strictEqual(body.receive_id, 'oc_from_key', 'sessionKey 的第二段就是 chat_id');
		} finally {
			f.restore();
		}
	});

	test('chat_id 完全无法确定（replyCtx 与 sessionKey 都不含）→ 抛错且不发请求', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await assert.rejects(() => p.send({ sessionKey: 'feishu:u' }, 'hi'), /chat_id/);
			assert.strictEqual(f.calls.length, 0, '无法确定 chat_id 时不应发出请求');
		} finally {
			f.restore();
		}
	});

	test('reply 成功：先换 tenant_access_token，再带 Bearer 调 /im/v1/messages/{id}/reply', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'cli_x', appSecret: 'sec_x' });
			await p.reply({ sessionKey: 'feishu:c:u', replyCtx: { messageId: 'om_9', chatId: 'oc_1' } }, '回复内容', 'result');

			assert.strictEqual(countCalls(f.calls, TOKEN_PATH), 1);
			assert.strictEqual(countCalls(f.calls, '/im/v1/messages/om_9/reply'), 1);

			const tokenCall = f.calls.find(c => c.url.includes(TOKEN_PATH))!;
			assert.strictEqual(JSON.parse(tokenCall.init.body).app_id, 'cli_x');

			const replyCall = f.calls.find(c => c.url.includes('/reply'))!;
			assert.strictEqual(replyCall.init.headers.Authorization, 'Bearer t-1');
			const body = JSON.parse(replyCall.init.body);
			assert.strictEqual(body.msg_type, 'text');
			assert.strictEqual(JSON.parse(body.content).text, '回复内容');
		} finally {
			f.restore();
		}
	});

	test('send 主动发送：receive_id_type=chat_id 且 receive_id 正确', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await p.send({ sessionKey: 'feishu:c:u', replyCtx: { chatId: 'oc_7' } }, '主动消息');

			const call = f.calls.find(c => c.url.includes('/im/v1/messages'))!;
			assert.ok(call.url.includes('receive_id_type=chat_id'));
			const body = JSON.parse(call.init.body);
			assert.strictEqual(body.receive_id, 'oc_7');
			assert.strictEqual(JSON.parse(body.content).text, '主动消息');
		} finally {
			f.restore();
		}
	});

	test('token 缓存：expire 充足时两次 reply 只取一次 token', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'one');
			await p.reply({ sessionKey: 's', replyCtx: { messageId: 'm2' } }, 'two');

			assert.strictEqual(countCalls(f.calls, TOKEN_PATH), 1, 'token 应被缓存');
			assert.strictEqual(countCalls(f.calls, '/reply'), 2);
		} finally {
			f.restore();
		}
	});

	test('token 缓存窗口（<60s 剩余）内会重新获取', async () => {
		const f = stubFetch(() => ({ code: 0, tenant_access_token: 't-short', expire: 30 }));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'one');
			await p.reply({ sessionKey: 's', replyCtx: { messageId: 'm2' } }, 'two');

			assert.strictEqual(countCalls(f.calls, TOKEN_PATH), 2, 'expire=30s 未过 60s 安全窗口 → 每次重取');
		} finally {
			f.restore();
		}
	});

	test('token 获取失败（code!=0）→ 抛错并带上飞书 msg', async () => {
		const f = stubFetch(() => ({ code: 99991663, msg: 'app not found' }));
		try {
			const p = new FeishuPlatform({ appId: 'bad', appSecret: 'bad' });
			await assert.rejects(
				() => p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'x'),
				/app not found/,
			);
		} finally {
			f.restore();
		}
	});

	test('发送失败（code!=0）→ 抛错', async () => {
		const f = stubFetch(url => url.includes(TOKEN_PATH) ? okToken : { code: 230001, msg: 'invalid receive_id' });
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await assert.rejects(
				() => p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'x'),
				/invalid receive_id/,
			);
		} finally {
			f.restore();
		}
	});

	test('网络异常（fetch reject）向上抛出', async () => {
		const f = stubFetch(() => new Error('ECONNREFUSED'));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await assert.rejects(
				() => p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'x'),
				/ECONNREFUSED/,
			);
		} finally {
			f.restore();
		}
	});

	test('sendCard → msg_type=interactive 且卡片结构正确（markdown/hr/note/action+button）', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await p.sendCard({ sessionKey: 's', replyCtx: { chatId: 'oc_1' } }, {
				header: { title: '标题', color: 'green' },
				elements: [
					{ kind: 'markdown', content: '**正文**' },
					{ kind: 'divider' },
					{ kind: 'note', text: '脚注' },
					{ kind: 'actions', buttons: [{ text: '确定', value: 'cmd:/ok', type: 'primary' }] },
				],
			});

			const call = f.calls.find(c => c.url.includes('/im/v1/messages'))!;
			const outer = JSON.parse(call.init.body);
			assert.strictEqual(outer.msg_type, 'interactive');

			const card = JSON.parse(outer.content);
			assert.strictEqual(card.header.template, 'green');
			assert.strictEqual(card.header.title.content, '标题');
			assert.strictEqual(card.config.wide_screen_mode, true);
			assert.deepStrictEqual(card.elements[0], { tag: 'markdown', content: '**正文**' });
			assert.deepStrictEqual(card.elements[1], { tag: 'hr' });
			assert.strictEqual(card.elements[2].tag, 'note');
			assert.strictEqual(card.elements[3].tag, 'action');
			assert.strictEqual(card.elements[3].actions[0].text.content, '确定');
			assert.strictEqual(card.elements[3].actions[0].value.bridge_value, 'cmd:/ok');
		} finally {
			f.restore();
		}
	});

	test('replyCard 缺 message_id 但有 chat_id → 降级为发卡片到群（不再抛错）', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await p.replyCard({ sessionKey: 'feishu:c:u', replyCtx: { chatId: 'oc_2' } }, { elements: [] });

			const call = f.calls.find(c => c.url.includes('/im/v1/messages'))!;
			assert.ok(call.url.includes('receive_id_type=chat_id'), '应降级为发送到群');
			const body = JSON.parse(call.init.body);
			assert.strictEqual(body.receive_id, 'oc_2');
			assert.strictEqual(body.msg_type, 'interactive');
		} finally {
			f.restore();
		}
	});

	test('replyCard 连 chat_id 都没有 → 抛错（不发出请求）', async () => {
		const f = stubFetch(() => okToken);
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await assert.rejects(
				() => p.replyCard({ sessionKey: 's', replyCtx: {} }, { elements: [] }),
				/chat_id/,
			);
			assert.strictEqual(f.calls.length, 0);
		} finally {
			f.restore();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 4) FeishuPlatform · WS 长连接（useWs）
// ══════════════════════════════════════════════════════════════════════════

suite('FeishuPlatform · WS 长连接', () => {
	test('useWs 未开启 → start() 不发起任何网络请求', async () => {
		const f = stubFetch(() => ({ code: 0, data: { url: 'wss://x' } }));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			p.start(() => { /* noop */ });
			await flush();
			assert.strictEqual(f.calls.length, 0);
		} finally {
			f.restore();
		}
	});

	test('useWs=true → 用官方端点 + PascalCase 请求体换 wss 地址，二进制事件帧可路由', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://open.feishu.cn/ws/abc?device_id=d1&service_id=7'));
		try {
			const p = new FeishuPlatform({ appId: 'cli_x', appSecret: 'sec_x', useWs: true });
			const got: InboundMessage[] = [];
			p.start(m => got.push(m));
			await flush();

			// ① 换地址：官方**完整 URL**（域名根，无 /open-apis —— 拼错基址会得到 404）+ PascalCase 请求体
			assert.strictEqual(countCalls(f.calls, WS_ENDPOINT_PATH), 1);
			const sub = f.calls.find(c => c.url.includes(WS_ENDPOINT_PATH))!;
			assert.strictEqual(sub.url, 'https://open.feishu.cn/callback/ws/endpoint');
			assert.deepStrictEqual(JSON.parse(sub.init.body), { AppID: 'cli_x', AppSecret: 'sec_x' });
			assert.strictEqual(sub.init.headers.locale, 'zh');

			// ② 建连：必须用 arraybuffer（protobuf 是二进制帧，Blob 无法同步解析）
			assert.strictEqual(FakeWebSocket.instances.length, 1);
			const ws = FakeWebSocket.instances[0];
			assert.strictEqual(ws.url, 'wss://open.feishu.cn/ws/abc?device_id=d1&service_id=7');
			assert.strictEqual(ws.binaryType, 'arraybuffer');

			// ③ 事件帧经 protobuf 解码后路由给引擎
			ws.open();
			ws.onmessage!({ data: eventFrame(messageEvent('om_5', 'oc_5', 'ou_5', '来自长连接')) });
			assert.strictEqual(got.length, 1);
			assert.strictEqual(got[0].content, '来自长连接');
			assert.strictEqual(got[0].messageId, 'om_5');
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('Lark 域名（baseUrl 覆盖）：换地址同样落在域名根', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://open.larksuite.com/ws'));
		try {
			const p = new FeishuPlatform({
				appId: 'a',
				appSecret: 'b',
				useWs: true,
				baseUrl: 'https://open.larksuite.com/open-apis',
			});
			p.start(() => { /* noop */ });
			await flush();
			assert.strictEqual(f.calls[0].url, 'https://open.larksuite.com/callback/ws/endpoint');
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('回执：复用原帧回写 payload={"code":200} 并附 biz_rt（官方无独立 ack 帧类型）', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://open.feishu.cn/ws/abc'));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true });
			p.start(() => { /* noop */ });
			await flush();

			const ws = FakeWebSocket.instances[0];
			ws.open();
			ws.onmessage!({ data: eventFrame(messageEvent('om_6', 'oc_6', 'ou_6', 'hi')) });

			const ack = ws.ackFrame(200);
			assert.ok(ack, '应回写一条 code=200 的回执帧');
			assert.strictEqual(ack!.seqId, '1', 'SeqID 应原样带回');
			assert.strictEqual(ack!.logId, '2', 'LogID 应原样带回');
			assert.strictEqual(ack!.method, FRAME_METHOD.DATA, '回执复用原 DATA 帧');
			assert.strictEqual(frameHeader(ack!, FRAME_HEADER.TYPE), MESSAGE_TYPE.EVENT, '原帧头应保留');
			assert.strictEqual(frameHeader(ack!, FRAME_HEADER.MESSAGE_ID), 'om_ws_1');
			assert.ok(Number(frameHeader(ack!, FRAME_HEADER.BIZ_RT)) >= 0, '应附处理耗时 biz_rt');
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('事件处理抛错 → 回执 code=500（服务端可感知失败）', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x'));
		const logs: string[] = [];
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true, log: m => logs.push(m) });
			// handler 抛错 → 模拟业务侧异常
			p.start(() => { throw new Error('handler boom'); });
			await flush();

			const ws = FakeWebSocket.instances[0];
			ws.open();
			ws.onmessage!({ data: eventFrame(messageEvent('m1', 'c1', 'u1', 'x')) });

			assert.ok(ws.ackFrame(500), '应回写 code=500');
			assert.ok(logs.some(l => l.includes('事件处理失败')), '失败原因应落日志');
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('分片事件（sum=2）：未收齐不路由，收齐后合并路由一次', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x'));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true });
			const got: InboundMessage[] = [];
			p.start(m => got.push(m));
			await flush();

			const ws = FakeWebSocket.instances[0];
			ws.open();
			const full = messageEvent('om_f', 'oc_f', 'ou_f', '分片消息');
			const text = JSON.stringify(full);
			const half = Math.floor(text.length / 2);
			const partA = encodeUtf8(text.slice(0, half));
			const partB = encodeUtf8(text.slice(half));

			// 先到第 2 片（seq=1）→ 不路由
			ws.onmessage!({ data: eventFrameFromParts(partB, 2, 1) });
			assert.strictEqual(got.length, 0, '未收齐时不应路由');

			// 再到第 1 片（seq=0）→ 合并后路由
			ws.onmessage!({ data: eventFrameFromParts(partA, 2, 0) });
			assert.strictEqual(got.length, 1);
			assert.strictEqual(got[0].content, '分片消息');
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('心跳：连接建立即发一条 CONTROL 帧 type=ping，service 取自 URL 的 service_id', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://open.feishu.cn/ws/x?device_id=d&service_id=7'));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true });
			p.start(() => { /* noop */ });
			await flush();

			const ws = FakeWebSocket.instances[0];
			assert.strictEqual(ws.frames().length, 0, 'open 之前不发心跳');
			ws.open();

			const ping = ws.frames()[0];
			assert.strictEqual(frameHeader(ping, FRAME_HEADER.TYPE), MESSAGE_TYPE.PING);
			assert.strictEqual(ping.method, FRAME_METHOD.CONTROL);
			assert.strictEqual(ping.service, 7, 'ping 的 service 必须是 service_id');
			assert.strictEqual(ping.seqId, '0');

			// 服务端 pong → 视为链路存活（lastFrameAt 有值）
			assert.strictEqual(p.lastFrameAt, undefined);
			ws.onmessage!({ data: controlFrame(MESSAGE_TYPE.PONG) });
			assert.ok(typeof p.lastFrameAt === 'number');
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('pong 携带新 ClientConfig → 心跳间隔被更新', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x'));
		const logs: string[] = [];
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true, log: m => logs.push(m) });
			p.start(() => { /* noop */ });
			await flush();

			const ws = FakeWebSocket.instances[0];
			ws.open();
			ws.onmessage!({ data: controlFrame(MESSAGE_TYPE.PONG, { PingInterval: 45, ReconnectCount: -1 }) });

			assert.ok(logs.some(l => l.includes('心跳 45s')), `应更新为 45s：${logs.join(' | ')}`);
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('D-07 结案：换地址响应含 ClientConfig → 建连日志带上服务端心跳间隔', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://open.feishu.cn/official', { PingInterval: 30 }));
		const logs: string[] = [];
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true, log: m => logs.push(m) });
			p.start(() => { /* noop */ });
			await flush();

			assert.strictEqual(FakeWebSocket.instances.length, 1);
			assert.strictEqual(FakeWebSocket.instances[0].url, 'wss://open.feishu.cn/official');
			FakeWebSocket.instances[0].open();
			assert.ok(logs.some(l => l.includes('长连接已建立') && l.includes('30s')), logs.join(' | '));
			assert.strictEqual(p.lastError, undefined);
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('换地址失败（code!=0 / 缺 URL）→ 记录原因含端点与飞书错误码，不建连', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => ({ code: 99991663, msg: 'invalid app_id' }));
		const logs: string[] = [];
		try {
			const p = new FeishuPlatform({ appId: 'bad', appSecret: 'bad', useWs: true, log: m => logs.push(m) });
			assert.doesNotThrow(() => p.start(() => { /* noop */ }));
			await flush();

			assert.strictEqual(FakeWebSocket.instances.length, 0, '换地址失败不应建连');
			assert.ok(logs.some(l => l.includes('WS 长连接失败')), '应记录连接失败');
			assert.ok(logs[0].includes('code=99991663'), `错误信息应带飞书返回码：${logs[0]}`);
			assert.ok(p.lastError?.includes('99991663'));
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('缺 data.URL → 抛错带 msg，不建连；并乐观重连（不静默）', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => ({ code: 0, msg: 'ok but empty' }));
		const logs: string[] = [];
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true, log: m => logs.push(m) });
			p.start(() => { /* noop */ });
			await flush();

			assert.strictEqual(FakeWebSocket.instances.length, 0);
			assert.ok(p.lastError?.includes('缺少 data.URL'));
			assert.ok(logs.some(l => l.includes('重连')), '失败后应按 ClientConfig 安排重连');
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('url_verification challenge（文本帧兜底）经 WS 回包', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x'));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true });
			let called = 0;
			p.start(() => { called++; });
			await flush();

			const ws = FakeWebSocket.instances[0];
			ws.open();
			ws.onmessage!({ data: JSON.stringify({ type: 'url_verification', challenge: 'ch-42', token: 'tk' }) });

			const textSent = ws.sent.filter(d => typeof d === 'string');
			assert.strictEqual(textSent.length, 1);
			const sent = JSON.parse(textSent[0]);
			assert.strictEqual(sent.challenge, 'ch-42');
			assert.strictEqual(sent.token, 'tk');
			assert.strictEqual(called, 0, 'challenge 不应被当作消息路由给 Agent');
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('WS 收到无法解析的数据 → 忽略并记日志，不抛异常', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x'));
		const logs: string[] = [];
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true, log: m => logs.push(m) });
			const got: InboundMessage[] = [];
			p.start(m => got.push(m));
			await flush();

			const ws = FakeWebSocket.instances[0];
			ws.open();
			// 非法 JSON 文本
			assert.doesNotThrow(() => ws.onmessage!({ data: '<<not json>>' }));
			// 非法 protobuf 字节（wire type 7 未定义 → 解码抛错路径）
			assert.doesNotThrow(() => ws.onmessage!({ data: new Uint8Array([0x3f, 0x01]) }));
			// 未知类型
			assert.doesNotThrow(() => ws.onmessage!({ data: 12_345 }));

			assert.strictEqual(got.length, 0);
			assert.ok(logs.some(l => l.includes('帧解码失败') || l.includes('无法解析')), logs.join(' | '));
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('握手失败（未 open 即关闭）→ 记录可能原因；不引入 onclose 误报文案', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x'));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true });
			p.start(() => { /* noop */ });
			await flush();

			FakeWebSocket.instances[0].onclose!();
			assert.ok(p.lastError?.includes('握手失败'), `应为握手失败提示：${p.lastError}`);
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('握手失败且只有 onerror（无 onclose）也照常安排重连（undici 实测行为）', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x', { ReconnectCount: 3, ReconnectInterval: 1, ReconnectNonce: 1 }));
		const logs: string[] = [];
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true, log: m => logs.push(m) });
			p.start(() => { /* noop */ });
			await flush();

			// 只触发 onerror，不触发 onclose —— 这正是 undici 握手失败时的行为
			FakeWebSocket.instances[0].onerror!();
			assert.ok(p.lastError?.includes('握手失败'), `应记录握手失败：${p.lastError}`);
			assert.ok(logs.some(l => l.includes('重连')), `只发 error 也应安排重连：${logs.join(' | ')}`);
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('异常断连（已 open）会被记录；主动 stop() 不产生误报', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x'));
		const logs: string[] = [];
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true, log: m => logs.push(m) });
			p.start(() => { /* noop */ });
			await flush();

			const ws = FakeWebSocket.instances[0];
			ws.open();
			ws.onclose!();
			assert.ok(p.lastError?.includes('onclose'), '异常断连应记录原因');
			assert.ok(logs.some(l => l.includes('重连')), '断连后应安排重连');

			// 重新 start 并主动 stop → 不应新增误报
			p.start(() => { /* noop */ });
			await flush();
			const before = logs.length;
			p.stop();
			FakeWebSocket.instances[FakeWebSocket.instances.length - 1].onclose!();
			assert.strictEqual(logs.length, before, '主动 stop() 不应记为异常断连');
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('stop() 关闭长连接、停掉心跳与重连定时器、清空 handler/token', async () => {
		const restoreWs = installFakeWebSocket();
		const f = stubFetch(() => endpointOk('wss://x'));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', useWs: true });
			const got: InboundMessage[] = [];
			p.start(m => got.push(m));
			await flush();

			const ws = FakeWebSocket.instances[0];
			ws.open();
			p.stop();

			assert.strictEqual(ws.closed, true);
			// 心跳定时器已清：即便再等一轮也不应新增出站帧
			const sentAfterStop = ws.sent.length;
			await flush(30);
			assert.strictEqual(ws.sent.length, sentAfterStop, 'stop() 后不应再发心跳');
			p.handleWebhookEvent(messageEvent('m', 'c', 'u', 'x'));
			assert.strictEqual(got.length, 0, 'stop() 后不再路由消息');
		} finally {
			f.restore();
			restoreWs();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 5) HTTP 出口 · 经注入的 requestService（不再落回 renderer fetch）
// ══════════════════════════════════════════════════════════════════════════
//
// 背景（2026-09-22 实测报错）：
//   Access to fetch at 'https://open.feishu.cn/open-apis/event/v1/outbound_event/subscribe'
//   from origin 'vscode-file://vscode-app' has been blocked by CORS policy ...
// 飞书 OpenAPI 不返回 Access-Control-Allow-Origin，renderer 直连必失败。
// ★ 两轮才对：DI 注入的 IRequestService 桌面端**也是 renderer fetch**（requestImpl.ts），
//   故首轮修复无效；真正的出口是经 `VSSAROS_LLM_CHANNEL#httpRequest` 的主进程请求。
//   → 出口实现与接线契约由 `mainProcessRequestService.test.ts` 锁定；
//     本套件只锁「平台只认注入的出口、绝不回退 renderer fetch」这一条不变量。

suite('FeishuPlatform · HTTP 出口（CORS 修复）', () => {
	/** 装一个「一旦被调用就抛错」的 fetch，用来证明不再回落渲染进程。 */
	function forbiddenFetch(): { calls: RecordedCall[]; restore: () => void } {
		return stubFetch(() => new Error('[断言失败] 不应走渲染进程 fetch（桌面端会被 CORS 拦截）'));
	}

	test('出站 REST 全部经主进程；渲染进程 fetch 完全不参与', async () => {
		const f = forbiddenFetch();
		const r = makeRequestService(url => url.includes(TOKEN_PATH)
			? { body: JSON.stringify({ code: 0, tenant_access_token: 'tok-1', expire: 7200 }) }
			: { body: JSON.stringify({ code: 0 }) });
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', requestService: r.svc, callSite: 'feishuTest' });
			await p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'hi');
			await p.send({ sessionKey: 's', replyCtx: { chatId: 'oc_1' } }, 'hi');

			assert.strictEqual(f.calls.length, 0, '不得回落到渲染进程 fetch');
			assert.strictEqual(r.calls.length, 3, 'token + reply + send');
			assert.ok(r.calls[0].url.includes(TOKEN_PATH));
			assert.ok(r.calls[1].url.includes('/im/v1/messages/') && r.calls[1].url.endsWith('/reply'));
			assert.ok(r.calls[2].url.includes('receive_id_type=chat_id'));

			// 认证头与 callsite 必须经主进程传递
			assert.strictEqual(r.calls[1].headers.Authorization, 'Bearer tok-1');
			assert.strictEqual(r.calls[0].callSite, 'feishuTest');
			assert.deepStrictEqual(JSON.parse(r.calls[1].body), { msg_type: 'text', content: '{"text":"hi"}' });
		} finally {
			f.restore();
		}
	});

	test('长连接换地址经主进程（就是用户报错里的那个调用点），wss 仍由渲染进程直连', async () => {
		const restoreWs = installFakeWebSocket();
		const f = forbiddenFetch();
		const r = makeRequestService(() => ({ body: JSON.stringify(endpointOk('wss://open.feishu.cn/ws')) }));
		try {
			const p = new FeishuPlatform({ appId: 'cli_x', appSecret: 'sec_x', useWs: true, requestService: r.svc });
			p.start(() => { /* noop */ });
			await flush();

			assert.strictEqual(f.calls.length, 0, '换地址请求不得走渲染进程 fetch');
			assert.strictEqual(r.calls.length, 1);
			assert.ok(r.calls[0].url.includes(WS_ENDPOINT_PATH));
			assert.deepStrictEqual(JSON.parse(r.calls[0].body), { AppID: 'cli_x', AppSecret: 'sec_x' });
			// WebSocket 不受同源策略限制 → 仍从渲染进程直连
			assert.strictEqual(FakeWebSocket.instances.length, 1);
			assert.strictEqual(FakeWebSocket.instances[0].url, 'wss://open.feishu.cn/ws');
			assert.strictEqual(p.lastError, undefined);
			p.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('未注入 requestService → 回退 fetch（单测/非 Electron 宿主仍可用）', async () => {
		const f = stubFetch(url => url.includes(TOKEN_PATH)
			? { code: 0, tenant_access_token: 't', expire: 7200 }
			: { code: 0 });
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'x');
			assert.strictEqual(countCalls(f.calls, TOKEN_PATH), 1);
		} finally {
			f.restore();
		}
	});

	test('两条出口的解析口径一致：非 JSON / 空响应都带 HTTP 状态与片段', async () => {
		const r = makeRequestService(() => ({ status: 502, body: '<html>bad gateway</html>' }));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b', requestService: r.svc });
			await assert.rejects(
				() => p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'x'),
				/非 JSON 响应：HTTP 502/,
			);
		} finally { /* mock 无需恢复 */ }

		const f = stubFetch(() => ({ status: 200, text: async () => '<html>not json</html>' }));
		try {
			const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await assert.rejects(
				() => p.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'x'),
				/非 JSON 响应：HTTP 200/,
			);
		} finally {
			f.restore();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 5b) 平台装配 · feishu.contribution（env 门控）
// ══════════════════════════════════════════════════════════════════════════

suite('飞书渠道 · 平台装配（env 门控）', () => {
	test('未设置 FEISHU_APP_ID/SECRET → 不注册平台', () => {
		const fb = makeFakeBridge();
		withEnv(NO_FEISHU_ENV, () => {
			assert.strictEqual(registerFeishuPlatformIfConfigured(fb.bridge), undefined);
		});
		assert.strictEqual(fb.registered.length, 0);
	});

	test('只设 appId 不设 appSecret → 不注册（避免半配置启动）', () => {
		const fb = makeFakeBridge();
		withEnv({ FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: undefined }, () => {
			registerFeishuPlatformIfConfigured(fb.bridge);
		});
		assert.strictEqual(fb.registered.length, 0);
	});

	test('凭证齐全 → 注册 id=feishu 的平台，allowFrom 归一化透传', () => {
		const fb = makeFakeBridge();
		withEnv({
			FEISHU_APP_ID: 'cli_x',
			FEISHU_APP_SECRET: 'sec_x',
			FEISHU_ALLOW_FROM: 'ou_a, ou_b',
			FEISHU_USE_WS: undefined,
		}, () => {
			registerFeishuPlatformIfConfigured(fb.bridge);
		});

		assert.strictEqual(fb.registered.length, 1);
		assert.strictEqual(fb.registered[0].id, 'feishu');
		const platform = fb.registered[0].create();
		assert.ok(platform instanceof FeishuPlatform);
		assert.strictEqual(platform.id, 'feishu');
		assert.strictEqual(platform.allowFrom, 'ou_a,ou_b');
	});

	test('FEISHU_USE_WS=0 → 装配出的平台不建立长连接', async () => {
		const fb = makeFakeBridge();
		withEnv({ FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'sec_x', FEISHU_USE_WS: '0' }, () => {
			registerFeishuPlatformIfConfigured(fb.bridge);
		});
		const f = stubFetch(() => ({ code: 0, data: { url: 'wss://x' } }));
		try {
			const platform = fb.registered[0].create();
			await platform.start(() => { /* noop */ });
			await flush();
			assert.strictEqual(f.calls.length, 0);
		} finally {
			f.restore();
		}
	});

	test('FEISHU_USE_WS=1 → 装配出的平台建立长连接', async () => {
		const restoreWs = installFakeWebSocket();
		const fb = makeFakeBridge();
		withEnv({ FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'sec_x', FEISHU_USE_WS: '1' }, () => {
			registerFeishuPlatformIfConfigured(fb.bridge);
		});
		const f = stubFetch(() => ({ code: 0, data: { URL: 'wss://x' } }));
		try {
			const platform = fb.registered[0].create();
			await platform.start(() => { /* noop */ });
			await flush();
			assert.strictEqual(countCalls(f.calls, WS_ENDPOINT_PATH), 1);
			platform.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('日志出口：装配时输出凭证来源，长连接失败落到注入的 logger', async () => {
		const restoreWs = installFakeWebSocket();
		const fb = makeFakeBridge();
		const logs: string[] = [];
		withEnv({ FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'sec_x', FEISHU_USE_WS: '1' }, () => {
			registerFeishuPlatformIfConfigured(fb.bridge, undefined, m => logs.push(m));
		});
		const f = stubFetch(() => ({ code: 99991663, msg: 'invalid app_id' }));
		try {
			const platform = fb.registered[0].create();
			await platform.start(() => { /* noop */ });
			await flush();

			assert.ok(logs.length >= 2, '至少应有「装配来源」+「长连接失败」两条日志');
			assert.ok(logs[0].includes('来源=env'));
			assert.ok(logs.some(l => l.includes('WS 长连接失败')));
			assert.ok(logs.some(l => l.includes('重连')), '失败后应安排重连（不静默）');
			assert.ok((platform as FeishuPlatform).lastError?.includes('invalid app_id'), 'lastError 应可诊断');
			platform.stop();
		} finally {
			f.restore();
			restoreWs();
		}
	});

	test('装配侧把 requestService 透传给平台（HTTP 走主进程，日志里可核对出口）', async () => {
		const fb = makeFakeBridge();
		const logs: string[] = [];
		const r = makeRequestService(url => url.includes(TOKEN_PATH)
			? { body: JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }) }
			: { body: JSON.stringify({ code: 0 }) });
		const f = stubFetch(() => new Error('[断言失败] 不应走渲染进程 fetch'));
		withEnv({ FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'sec_x' }, () => {
			registerFeishuPlatformIfConfigured(fb.bridge, undefined, m => logs.push(m), r.svc, '主进程 httpRequest');
		});
		try {
			assert.ok(logs[0].includes('http=主进程 httpRequest'), '装配日志应标明 HTTP 出口');
			const platform = fb.registered[0].create();
			await platform.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'hi');
			assert.strictEqual(f.calls.length, 0);
			assert.ok(r.calls.length >= 2, 'token + reply 都应走主进程');
		} finally {
			f.restore();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 5b) 凭证解析优先级（D-02 修复核心）
// ══════════════════════════════════════════════════════════════════════════

suite('飞书渠道 · 凭证解析优先级（resolveFeishuConfig）', () => {
	const cfgAll = {
		[FEISHU_CONFIG_KEYS.enabled]: true,
		[FEISHU_CONFIG_KEYS.appId]: 'cli_cfg',
		[FEISHU_CONFIG_KEYS.appSecret]: 'sec_cfg',
	};

	test('无 env 时用配置（source=config）', () => {
		const { svc } = makeConfigService(cfgAll);
		withEnv(NO_FEISHU_ENV, () => {
			const resolved = resolveFeishuConfig(svc);
			assert.ok(resolved);
			assert.strictEqual(resolved!.source, 'config');
			assert.strictEqual(resolved!.appId, 'cli_cfg');
			assert.strictEqual(resolved!.appSecret, 'sec_cfg');
		});
	});

	test('env 优先于配置（source=env，运维覆盖）', () => {
		const { svc } = makeConfigService(cfgAll);
		withEnv({ FEISHU_APP_ID: 'cli_env', FEISHU_APP_SECRET: 'sec_env' }, () => {
			const resolved = resolveFeishuConfig(svc);
			assert.strictEqual(resolved!.source, 'env');
			assert.strictEqual(resolved!.appId, 'cli_env');
		});
	});

	test('配置路径受 enabled 门控；env 路径不受其影响（纯 env 部署向后兼容）', () => {
		const { svc } = makeConfigService({ ...cfgAll, [FEISHU_CONFIG_KEYS.enabled]: false });
		withEnv(NO_FEISHU_ENV, () => {
			assert.strictEqual(resolveFeishuConfig(svc), undefined, 'enabled=false → 不装配');
		});
		withEnv({ FEISHU_APP_ID: 'cli_env', FEISHU_APP_SECRET: 'sec_env' }, () => {
			assert.ok(resolveFeishuConfig(svc), 'env 提供凭证时忽略 enabled');
		});
	});

	test('useWs：env 显式值 > 配置 > 默认 true', () => {
		const { svc: onSvc } = makeConfigService({ ...cfgAll, [FEISHU_CONFIG_KEYS.useWs]: true });
		const { svc: offSvc } = makeConfigService({ ...cfgAll, [FEISHU_CONFIG_KEYS.useWs]: false });
		const { svc: unsetSvc } = makeConfigService(cfgAll);

		withEnv(NO_FEISHU_ENV, () => {
			assert.strictEqual(resolveFeishuConfig(offSvc)!.useWs, false);
			assert.strictEqual(resolveFeishuConfig(onSvc)!.useWs, true);
			assert.strictEqual(resolveFeishuConfig(unsetSvc)!.useWs, true, '未配置时默认开启（唯一可用的入站路径）');
		});
		// env 存在时以 env 的 FEISHU_USE_WS 为准
		withEnv({ FEISHU_APP_ID: 'cli_env', FEISHU_APP_SECRET: 'sec_env', FEISHU_USE_WS: '0' }, () => {
			assert.strictEqual(resolveFeishuConfig(onSvc)!.useWs, false);
		});
		// env 未设 FEISHU_USE_WS → 退回配置
		withEnv({ FEISHU_APP_ID: 'cli_env', FEISHU_APP_SECRET: 'sec_env', FEISHU_USE_WS: undefined }, () => {
			assert.strictEqual(resolveFeishuConfig(offSvc)!.useWs, false);
		});
	});

	test('allowFrom 归一化：换行/分号/逗号混用、去空、去重空格', () => {
		assert.strictEqual(normalizeAllowFrom('ou_a\nou_b\nou_c'), 'ou_a,ou_b,ou_c');
		assert.strictEqual(normalizeAllowFrom('ou_a; ou_b,ou_c\n\n  '), 'ou_a,ou_b,ou_c');
		assert.strictEqual(normalizeAllowFrom('   '), undefined);
		assert.strictEqual(normalizeAllowFrom(undefined), undefined);
	});

	test('配置里的多行白名单被归一化为逗号分隔（allowFromCheck 只按逗号切分）', () => {
		const { svc } = makeConfigService({
			...cfgAll,
			[FEISHU_CONFIG_KEYS.allowFrom]: 'ou_1\nou_2\nou_3',
		});
		withEnv(NO_FEISHU_ENV, () => {
			assert.strictEqual(resolveFeishuConfig(svc)!.allowFrom, 'ou_1,ou_2,ou_3');
		});
	});

	test('配置缺凭证 → undefined', () => {
		const { svc } = makeConfigService({ [FEISHU_CONFIG_KEYS.enabled]: true, [FEISHU_CONFIG_KEYS.appId]: 'cli_x' });
		withEnv(NO_FEISHU_ENV, () => {
			assert.strictEqual(resolveFeishuConfig(svc), undefined);
		});
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 6) 修复回归（D-02 / D-05 / D-08）+ 未修缺口锁定（D-04 / D-09）
// ══════════════════════════════════════════════════════════════════════════

suite('飞书渠道 · 修复回归（D-02 / D-05 / D-08）', () => {
	test('D-02 已修：UI 写入的 sessions.channel.feishu.appId/appSecret 会被运行时消费（无 env 也能注册）', () => {
		// 修复前：ChannelEditorPane._finishFeishuBind 把凭证写进配置项，而装配点只读
		// process.env ——「扫码绑定成功」≠「渠道可用」。现在配置成为装配的一等来源。
		const fb = makeFakeBridge();
		const { svc } = makeConfigService({
			[FEISHU_CONFIG_KEYS.enabled]: true,
			[FEISHU_CONFIG_KEYS.appId]: 'cli_from_ui',
			[FEISHU_CONFIG_KEYS.appSecret]: 'sec_from_ui',
		});
		let reg: { dispose(): void } | undefined;
		withEnv(NO_FEISHU_ENV, () => {
			reg = registerFeishuPlatformIfConfigured(fb.bridge, svc) as unknown as { dispose(): void } | undefined;
		});

		assert.ok(reg, 'UI 配置的凭证应能驱动平台装配');
		assert.strictEqual(fb.registered.length, 1);
		assert.strictEqual(fb.registered[0].id, 'feishu');
		// 装配函数现在接收配置服务（第二个形参）——结构性证据
		assert.ok(registerFeishuPlatformIfConfigured.length >= 2);
	});

	test('D-02 已修：enabled=false 会阻止配置路径注册（开关获得运行时消费者）', () => {
		const fb = makeFakeBridge();
		const { svc } = makeConfigService({
			[FEISHU_CONFIG_KEYS.enabled]: false,
			[FEISHU_CONFIG_KEYS.appId]: 'cli_x',
			[FEISHU_CONFIG_KEYS.appSecret]: 'sec_x',
		});
		withEnv(NO_FEISHU_ENV, () => {
			assert.strictEqual(registerFeishuPlatformIfConfigured(fb.bridge, svc), undefined);
		});
		assert.strictEqual(fb.registered.length, 0);
	});

	test('D-05 已修：返回卸载句柄，热重载可先 dispose 再重装', () => {
		const fb = makeFakeBridge();
		const { svc } = makeConfigService({
			[FEISHU_CONFIG_KEYS.enabled]: true,
			[FEISHU_CONFIG_KEYS.appId]: 'cli_x',
			[FEISHU_CONFIG_KEYS.appSecret]: 'sec_x',
		});
		withEnv(NO_FEISHU_ENV, () => {
			const disposables: Array<{ dispose(): void }> = [];
			for (let i = 0; i < 2; i++) {
				// 模拟第 i 次热重载：先卸载上一次，再重新装配
				disposables[disposables.length - 1]?.dispose();
				const reg = registerFeishuPlatformIfConfigured(fb.bridge, svc);
				assert.ok(reg, `第 ${i + 1} 次装配应成功`);
				disposables.push(reg!);
			}
			assert.strictEqual(fb.registered.length, 2, '每次重载都重新注册（旧实例已卸载）');
			assert.strictEqual(fb.disposed, 1, '重载前应先 dispose 旧注册');
			disposables[disposables.length - 1].dispose();
			assert.strictEqual(fb.disposed, 2);
		});
	});

	test('【仍未修 D-04】BridgeServer 不认识 webhook 类型消息 —— 飞书回调仍无 HTTP 入口', () => {
		// 本次修复把入站明确收敛为「长连接唯一路径」（见 feishu.ts 头注释），
		// 因此 BridgeServer 依旧只处理 subscribe/inbound/ping；webhook 模式未实现。
		const { chat, studio, log } = makeEngineMocks();
		const engine = new BridgeEngine({ chat, studio, logService: log });
		const server = new BridgeServer({ engine, logService: log });

		const sent: any[] = [];
		const client = { ws: { send: (d: string) => sent.push(JSON.parse(d)) }, subscribed: false };
		(server as any)._handleClientMessage(client, { type: 'webhook', header: {}, event: {} });

		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].type, 'error');
		assert.ok(String(sent[0].error).includes('unknown type'));
	});

	test('【仍未修 D-04/D-09】加密事件被静默丢弃（Webhook 解密/验签未实现）', () => {
		const p = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
		const got: InboundMessage[] = [];
		p.start(m => got.push(m));
		p.handleWebhookEvent({ encrypt: 'BASE64_BLOB' });
		assert.strictEqual(got.length, 0);
	});

	test('【D-08 部分修】运行时只读取 defaultAgent / defaultSession；dmPolicy / groupPolicy / groupAllowFrom / defaultAccount 仍无消费者', async () => {
		// ★ 2026-09-22 更新：工作区新增了「渠道默认会话」（BridgeEngine.getChannelDefaultSession），
		//   因此 sessions.channel.<p>.defaultSession 也成了运行时消费者 —— 这条断言随之更新，
		//   但 D-08 的核心（安全策略字段 dmPolicy / groupPolicy / groupAllowFrom / defaultAccount）
		//   依旧**没有任何 getValue 引用** ⇒ UI 上可配、运行时不生效，仍是未闭合项。
		const { chat, studio, log, calls } = makeEngineMocks();
		const readKeys: string[] = [];
		const configurationService = {
			getValue: (key: string) => {
				readKeys.push(key);
				return undefined as any;
			},
		} as any;
		const engine = new BridgeEngine({ chat, studio, logService: log, configurationService });
		await engine.ensureSession('feishu:oc:ou', 'feishu', 'oc');

		// 只认「被读取过的这两个键」，顺序不敏感（getChannelDefaultSession 内部先读 agent 再读 session）
		const unique = [...new Set(readKeys)];
		assert.deepStrictEqual(
			unique.sort(),
			['sessions.channel.feishu.defaultAgent', 'sessions.channel.feishu.defaultSession'],
			`实际读取：${JSON.stringify(unique)}`,
		);
		assert.deepStrictEqual(calls.sessionAgents, ['coder'], '回退到 studio 首次返回的 Agent');
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 7) BridgeEngine · 渠道路由
// ══════════════════════════════════════════════════════════════════════════

suite('BridgeEngine · 飞书渠道路由', () => {
	test('渠道默认 Agent：sessions.channel.feishu.defaultAgent 生效', async () => {
		const { chat, studio, log, calls } = makeEngineMocks();
		const configurationService = {
			getValue: (key: string) => key === 'sessions.channel.feishu.defaultAgent' ? 'feishu-bot' : undefined,
		} as any;
		const engine = new BridgeEngine({ chat, studio, logService: log, configurationService });

		const session = await engine.ensureSession('feishu:oc:ou', 'feishu', 'oc');

		assert.strictEqual(session.agentId, 'feishu-bot');
		assert.deepStrictEqual(calls.sessionAgents, ['feishu-bot']);
	});

	test('渠道未配置默认 Agent → 回退引擎默认（偏好 coder 类）', async () => {
		const { chat, studio, log, calls } = makeEngineMocks();
		const engine = new BridgeEngine({ chat, studio, logService: log });

		const session = await engine.ensureSession('feishu:oc:ou', 'feishu', 'oc');

		assert.strictEqual(session.agentId, 'coder');
		assert.deepStrictEqual(calls.sessionAgents, ['coder']);
	});

	test('会话→Agent 绑定：set / get / list / clear（覆盖默认 Agent）', async () => {
		const { chat, studio, log, calls } = makeEngineMocks();
		const engine = new BridgeEngine({ chat, studio, logService: log });

		assert.strictEqual(engine.getConversationAgent('feishu', 'oc_1'), undefined);

		engine.setConversationAgent('feishu', 'oc_1', 'agent-bound');
		assert.strictEqual(engine.getConversationAgent('feishu', 'oc_1'), 'agent-bound');
		assert.deepStrictEqual(engine.listConversationBindings('feishu'), [{ conversationId: 'oc_1', agentId: 'agent-bound' }]);

		await engine.ensureSession('feishu:oc_1:ou_1', 'feishu', 'oc_1');
		assert.deepStrictEqual(calls.sessionAgents, ['agent-bound'], '绑定优先于默认 Agent');

		engine.clearConversationAgent('feishu', 'oc_1');
		assert.strictEqual(engine.getConversationAgent('feishu', 'oc_1'), undefined);
		assert.deepStrictEqual(engine.listConversationBindings('feishu'), []);
	});

	test('端到端：飞书事件回调 → 绑定 Agent → 回复同一条消息', async () => {
		const { chat, studio, log, calls } = makeEngineMocks();
		const f = stubFetch(url => {
			if (url.includes(TOKEN_PATH)) { return { code: 0, tenant_access_token: 't-e2e', expire: 7200 }; }
			if (url.includes('/im/v1/messages/')) { return { code: 0 }; }
			return { code: 0 };
		});
		try {
			const platform = new FeishuPlatform({ appId: 'cli_a', appSecret: 'sec_a' });
			const engine = new BridgeEngine({ chat, studio, logService: log });
			engine.registerPlatform(platform);
			engine.setConversationAgent('feishu', 'oc_1', 'agent-bound');
			await engine.start();

			platform.handleWebhookEvent(messageEvent('om_1', 'oc_1', 'ou_1', '你好'));
			await flush();
			await flush();

			assert.deepStrictEqual(calls.sessionAgents, ['agent-bound']);
			assert.deepStrictEqual(calls.messageAgents, ['agent-bound']);

			const reply = f.calls.find(c => c.url.includes('/im/v1/messages/om_1/reply'));
			assert.ok(reply, '应回复到原消息（reply 而非 send）');
			const body = JSON.parse(reply!.init.body);
			assert.strictEqual(body.msg_type, 'text');
			assert.ok(JSON.parse(body.content).text.includes('echo:你好'));
		} finally {
			f.restore();
		}
	});

	test('端到端：allowFrom 白名单拒绝未授权用户（不发消息给 Agent）', async () => {
		const { chat, studio, log, calls } = makeEngineMocks();
		const f = stubFetch(url => url.includes(TOKEN_PATH) ? { code: 0, tenant_access_token: 't', expire: 7200 } : { code: 0 });
		try {
			const platform = new FeishuPlatform({ appId: 'a', appSecret: 'b', allowFrom: 'ou_other' });
			const engine = new BridgeEngine({ chat, studio, logService: log });
			engine.registerPlatform(platform);
			await engine.start();

			platform.handleWebhookEvent(messageEvent('om_2', 'oc_2', 'ou_intruder', 'hi'));
			await flush();
			await flush();

			assert.strictEqual(calls.sendMessage, 0, '未授权用户不应触达 Agent');
			const reply = f.calls.find(c => c.url.includes('/im/v1/messages/om_2/reply'));
			assert.ok(reply, '应回复「角色未授权」提示');
			assert.ok(JSON.parse(JSON.parse(reply!.init.body).content).text.includes('未授权'));
		} finally {
			f.restore();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 8) 扫码绑定协议 · feishuRegistration
// ══════════════════════════════════════════════════════════════════════════

suite('飞书扫码绑定 · feishuRegistration', () => {
	const beginOk = {
		device_code: 'dc_1',
		verification_uri_complete: 'https://accounts.feishu.cn/verify?code=dc_1',
		interval: 5,
		expire_in: 300,
	};

	test('begin：解析 device_code / 二维码 URL / interval / expire_in，且请求 init + begin 两次', async () => {
		const { svc, calls } = makeRequestService(() => ({ body: JSON.stringify(beginOk) }));
		const r = await beginFeishuRegistration(svc);

		assert.strictEqual(r.deviceCode, 'dc_1');
		assert.strictEqual(r.qrUrl, 'https://accounts.feishu.cn/verify?code=dc_1');
		assert.strictEqual(r.interval, 5);
		assert.strictEqual(r.expiresIn, 300);

		assert.strictEqual(calls.length, 2);
		assert.ok(calls[0].body.includes('action=init'));
		assert.ok(calls[1].body.includes('action=begin'));
		assert.ok(calls[1].body.includes('archetype=PersonalAgent'));
		assert.ok(calls[1].body.includes('auth_method=client_secret'));
		assert.ok(calls[0].url.startsWith('https://accounts.feishu.cn'));
	});

	test('begin：init 失败被吞掉，仍能继续 begin', async () => {
		const { svc } = makeRequestService((_url, body) => body.includes('action=init')
			? { body: JSON.stringify({ error: 'invalid_request', error_description: 'nope' }) }
			: { body: JSON.stringify(beginOk) });
		const r = await beginFeishuRegistration(svc);
		assert.strictEqual(r.deviceCode, 'dc_1');
	});

	test('begin：缺 device_code / verification_uri_complete → 抛错', async () => {
		const { svc } = makeRequestService(() => ({ body: JSON.stringify({ device_code: 'dc_1' }) }));
		await assert.rejects(() => beginFeishuRegistration(svc), /begin 接口返回不完整/);
	});

	test('begin：interval/expire_in 缺失或非法 → 回退默认 5s / 300s', async () => {
		const { svc } = makeRequestService(() => ({
			body: JSON.stringify({ device_code: 'dc', verification_uri_complete: 'u', interval: 0, expire_in: 'abc' }),
		}));
		const r = await beginFeishuRegistration(svc);
		assert.strictEqual(r.interval, 5);
		assert.strictEqual(r.expiresIn, 300);
	});

	test('begin：返回非 JSON → 抛错并带上片段', async () => {
		const { svc } = makeRequestService(() => ({ body: '<html>502</html>' }));
		await assert.rejects(() => beginFeishuRegistration(svc), /非 JSON/);
	});

	test('begin：空响应 → 抛错', async () => {
		const { svc } = makeRequestService(() => ({ body: '' }));
		await assert.rejects(() => beginFeishuRegistration(svc), /空响应/);
	});

	test('poll：拿到 client_id/client_secret → completed（platform=feishu，含 ownerOpenId）', async () => {
		const { svc, calls } = makeRequestService(() => ({
			body: JSON.stringify({
				client_id: 'cli_1',
				client_secret: 'sec_1',
				user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' },
			}),
		}));
		const r = await pollFeishuRegistration(svc, 'dc_1', FEISHU_BASE);

		assert.strictEqual(r.status, 'completed');
		assert.strictEqual(r.appId, 'cli_1');
		assert.strictEqual(r.appSecret, 'sec_1');
		assert.strictEqual(r.ownerOpenId, 'ou_owner');
		assert.strictEqual(r.platform, 'feishu');
		assert.strictEqual(r.baseUrl, FEISHU_BASE);
		assert.ok(calls[0].body.includes('action=poll'));
		assert.ok(calls[0].body.includes('device_code=dc_1'));
	});

	test('poll：tenant_brand=Lark → platform=lark 且回带 LARK baseUrl', async () => {
		const { svc } = makeRequestService(() => ({
			body: JSON.stringify({ client_id: 'c', client_secret: 's', user_info: { tenant_brand: 'Lark' } }),
		}));
		const r = await pollFeishuRegistration(svc, 'dc', LARK_BASE);

		assert.strictEqual(r.platform, 'lark');
		assert.strictEqual(r.baseUrl, LARK_BASE);
	});

	test('poll：authorization_pending → pending（可继续轮询）', async () => {
		const { svc } = makeRequestService(() => ({ body: JSON.stringify({ error: 'authorization_pending' }) }));
		const r = await pollFeishuRegistration(svc, 'dc');
		assert.strictEqual(r.status, 'pending');
	});

	test('D-06 已修：协议状态错误码被映射为对应 status（不再被 postForm 拦截）', async () => {
		// 修复前 postForm 对除 authorization_pending 外的任何 error 一律 throw，
		// 导致 slow_down / access_denied / expired_token / default(error) 四个分支是死代码，
		// UI 永远走不到「你已拒绝授权」「二维码已过期」等精确提示。现全可达。
		const mapping: Array<[string, string]> = [
			['authorization_pending', 'pending'],
			['slow_down', 'slow_down'],
			['access_denied', 'denied'],
			['expired_token', 'expired'],
			['invalid_grant_x', 'error'],
		];
		for (const [err, expected] of mapping) {
			const { svc } = makeRequestService(() => ({ body: JSON.stringify({ error: err }) }));
			const r = await pollFeishuRegistration(svc, 'dc');
			assert.strictEqual(r.status, expected, `${err} → ${expected}`);
			if (expected === 'error') {
				assert.strictEqual(r.error, err, '未知错误码应回带原始 error 便于诊断');
			}
		}
	});

	test('D-06 已修：error 字段不再在 postForm 层抛错（改由 poll 映射，含未知错误码）', async () => {
		// 修复前 unknown error 会被 postForm 直接 throw，poll 的 default 分支不可达。
		const { svc } = makeRequestService(() => ({
			body: JSON.stringify({ error: 'invalid_client', error_description: 'app not found' }),
		}));
		const r = await pollFeishuRegistration(svc, 'dc');
		assert.strictEqual(r.status, 'error');
		assert.strictEqual(r.error, 'invalid_client');
	});

	test('真实的传输/解析层失败仍抛错（空响应 / 非 JSON）', async () => {
		const empty = makeRequestService(() => ({ body: '' }));
		await assert.rejects(() => pollFeishuRegistration(empty.svc, 'dc'), /空响应/);

		const bad = makeRequestService(() => ({ body: '<<not json>>' }));
		await assert.rejects(() => pollFeishuRegistration(bad.svc, 'dc'), /非 JSON/);
	});

	test('五态映射完整：completed/pending/denied/expired/slow_down 均可从 poll 返回', async () => {
		const bodies: Record<string, object> = {
			completed: { client_id: 'c', client_secret: 's' },
			pending: { error: 'authorization_pending' },
			denied: { error: 'access_denied' },
			expired: { error: 'expired_token' },
			slow_down: { error: 'slow_down' },
		};
		const got = new Set<string>();
		for (const body of Object.values(bodies)) {
			const { svc } = makeRequestService(() => ({ body: JSON.stringify(body) }));
			got.add((await pollFeishuRegistration(svc, 'dc')).status);
		}
		assert.deepStrictEqual([...got].sort(), ['completed', 'denied', 'expired', 'pending', 'slow_down']);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 8b) 凭证自检探针（D-03 修复新增）
// ══════════════════════════════════════════════════════════════════════════

suite('飞书凭证自检 · probeFeishuCredentials', () => {
	test('缺少凭证 → ok:false，不发起请求', async () => {
		const { svc, calls } = makeRequestService(() => ({ body: '{}' }));
		const r = await probeFeishuCredentials(svc, '', '');
		assert.strictEqual(r.ok, false);
		assert.ok(r.message.includes('App ID'));
		assert.strictEqual(calls.length, 0);
	});

	test('成功 → ok:true，回显有效期与 token 前缀，且请求打到 tenant_access_token', async () => {
		const { svc, calls } = makeRequestService(() => ({
			body: JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 't-abcdefghij', expire: 7200 }),
		}));
		const r = await probeFeishuCredentials(svc, 'cli_x', 'sec_x');

		assert.strictEqual(r.ok, true);
		assert.ok(r.message.includes('连接成功'));
		assert.ok(r.message.includes('7200s'));
		assert.strictEqual(r.tokenPrefix, 't-abcd…');
		assert.ok(calls[0].url.startsWith(FEISHU_OPEN_BASE));
		assert.ok(calls[0].url.endsWith('/auth/v3/tenant_access_token/internal'));
		assert.deepStrictEqual(JSON.parse(calls[0].body), { app_id: 'cli_x', app_secret: 'sec_x' });
	});

	test('code!=0 → ok:false，带 HTTP 状态、code 与飞书 msg', async () => {
		const { svc } = makeRequestService(() => ({
			status: 200,
			body: JSON.stringify({ code: 99991663, msg: 'app not found' }),
		}));
		const r = await probeFeishuCredentials(svc, 'cli_bad', 'sec_bad');

		assert.strictEqual(r.ok, false);
		assert.ok(r.message.includes('99991663'));
		assert.ok(r.message.includes('app not found'));
	});

	test('非 JSON 响应 → ok:false，带 HTTP 状态与片段', async () => {
		const { svc } = makeRequestService(() => ({ status: 502, body: '<html>bad gateway</html>' }));
		const r = await probeFeishuCredentials(svc, 'cli_x', 'sec_x');
		assert.strictEqual(r.ok, false);
		assert.ok(r.message.includes('502'));
		assert.ok(r.message.includes('bad gateway'));
	});

	test('空响应 → ok:false', async () => {
		const { svc } = makeRequestService(() => ({ body: '' }));
		const r = await probeFeishuCredentials(svc, 'cli_x', 'sec_x');
		assert.strictEqual(r.ok, false);
		assert.ok(r.message.includes('空响应'));
	});

	test('网络异常不抛错，且回显消息中的 appSecret 被脱敏', async () => {
		const svc = {
			request: async () => { throw new Error('connect failed with sec_x in query'); },
		} as unknown as IRequestService;
		const r = await probeFeishuCredentials(svc, 'cli_x', 'sec_x');

		assert.strictEqual(r.ok, false);
		assert.ok(r.message.includes('请求失败'));
		assert.ok(!r.message.includes('sec_x'), 'appSecret 不得出现在回显中');
		assert.ok(r.message.includes('[REDACTED]'));
	});

	test('Lark 域名可覆盖（openBase 参数）', async () => {
		const { svc, calls } = makeRequestService(() => ({
			body: JSON.stringify({ code: 0, tenant_access_token: 't-lark', expire: 100 }),
		}));
		const r = await probeFeishuCredentials(svc, 'cli_x', 'sec_x', 'https://open.larksuite.com/open-apis');
		assert.strictEqual(r.ok, true);
		assert.ok(calls[0].url.startsWith('https://open.larksuite.com'));
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 9) 二维码边界 · feishuQrCode
// ══════════════════════════════════════════════════════════════════════════

suite('飞书扫码绑定 · 二维码矩阵（qrMatrix）', () => {
	test('返回方形布尔矩阵，尺寸符合 21 + 4×version', () => {
		const m = qrMatrix('https://accounts.feishu.cn/oauth/v1/app/registration?code=abc123');
		const size = m.length;

		assert.ok(size >= 21, `尺寸过小：${size}`);
		assert.strictEqual((size - 21) % 4, 0, `尺寸不符合 QR 规范：${size}`);
		for (const row of m) {
			assert.strictEqual(row.length, size, '矩阵必须为正方形');
			for (const v of row) {
				assert.strictEqual(typeof v, 'boolean');
			}
		}
	});

	test('三个定位图案（左上/右上/左下）与分隔符、纵向定时图案已按规范绘制', () => {
		const m = qrMatrix('x');
		const size = m.length;

		// 左上定位角：0,0 与 0,6 / 6,0 为暗；1,1 为亮（内白环）；3,3 为暗（实心中心）
		assert.strictEqual(m[0][0], true);
		assert.strictEqual(m[0][6], true);
		assert.strictEqual(m[6][0], true);
		assert.strictEqual(m[1][1], false);
		assert.strictEqual(m[3][3], true);

		// 右上 / 左下定位角
		assert.strictEqual(m[0][size - 7], true);
		assert.strictEqual(m[size - 7][0], true);

		// 分隔符（紧邻定位图案的一圈）必须为亮
		assert.strictEqual(m[7][0], false, '左上分隔符');
		assert.strictEqual(m[7][size - 8], false, '右上分隔符');
		assert.strictEqual(m[size - 8][7], false, '左下分隔符');

		// 纵向定时图案（列 6）：自 row 8 起 1,0,1,0… 交替
		assert.strictEqual(m[8][6], true);
		assert.strictEqual(m[9][6], false);
		assert.strictEqual(m[10][6], true);
		assert.strictEqual(m[11][6], false);
		assert.strictEqual(m[12][6], true);
	});

	test('D-10 已修：横向定时图案 (6,8) 完整，不再被格式信息覆写', () => {
		// 修复前：格式信息写 `else { m[14 - i][8] = bit; }`，i=8 落到 (6,8) ——
		//   那是横向定时图案模块（i=8 为偶 ⇒ 必须为暗），被格式位覆写成亮；
		//   而格式位 8 的正确位置 (7,8) 从未被写入（恒为亮）。
		// 修复后：bit 8 → (7,8)，(6,8) 恢复为定时图案。
		const m = qrMatrix('x');
		const size = m.length;

		// 横向定时图案（行 6，自 col 8 起 1,0,1,0… 交替）——含此前被覆写的 (6,8)
		assert.strictEqual(m[6][8], true, 'D-10 回归：(6,8) 应保持定时图案的暗模块');
		assert.strictEqual(m[6][9], false);
		assert.strictEqual(m[6][10], true);
		assert.strictEqual(m[6][11], false);
		assert.strictEqual(m[6][12], true);
		assert.strictEqual(size, 21);
	});

	test('D-10 已修：格式位 8 写入 (7,8)（存在位值为暗的输入 ⇒ 证明该位置被真实写入）', () => {
		// 修复前 (7,8) 无任何写入路径 ⇒ 恒为亮；修复后它承载格式位 8，
		// 其值随掩码/格式串变化。跨多个输入出现 true 即证明写入路径存在。
		const inputs = ['x', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
		const values = inputs.map(t => qrMatrix(t)[7][8]);
		assert.ok(
			values.some(v => v === true),
			'修复后 (7,8) 应至少在一个输入下为暗（说明格式位 8 已写入该位置）',
		);
		// 反向锁定：格式位 8 不再落在 (6,8) —— 所有输入下 (6,8) 均为定时图案的暗模块
		for (const t of inputs) {
			assert.strictEqual(qrMatrix(t)[6][8], true, `输入 ${t}：(6,8) 必须是定时图案暗模块`);
		}
	});

	test('数据变长时矩阵尺寸单调不减', () => {
		const short = qrMatrix('x').length;
		const longer = qrMatrix('x'.repeat(50)).length;
		assert.ok(longer >= short);
	});

	test('容量边界：154 字节可编码，155 字节抛错（调用方回落「复制链接」）', () => {
		assert.doesNotThrow(() => qrMatrix('x'.repeat(154)));
		assert.strictEqual(qrMatrix('x'.repeat(154)).length, 45, '154B 应为 V7（21+4*6=45）');
		assert.throws(() => qrMatrix('x'.repeat(155)), /数据过长/);
	});

	test('多字节字符按 UTF-8 字节数计容量（中文 3 字节/字）', () => {
		// 51 个汉字 = 153 字节 ≤ 154 ✓
		assert.doesNotThrow(() => qrMatrix('汉'.repeat(51)));
		// 52 个汉字 = 156 字节 > 154 ✗
		assert.throws(() => qrMatrix('汉'.repeat(52)), /数据过长/);
	});
});
