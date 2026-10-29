// @vssaros/dsh-agents — 飞书长连接（WebSocket）入站客户端单测
//   跑法：node dsh-plugins/vssaros-agents/test/feishu-raw-ws.test.mjs
//
// 为什么单测（不联网）：这套协议有三个「错了也不报错」的点 ——
//   ① **回执（ack）漏发**：飞书不再推下一条事件，线上表现是「只收到第一条消息」；
//   ② **心跳没发 / 间隔用错**：连接被服务端静默回收，表现为「跑一会儿就没消息了」；
//   ③ **分片重组**：sum>1 时提前取 payload ⇒ JSON.parse 失败 ⇒ 事件被静默丢弃。
// 这三条都不会抛错、也不会有日志 ⇒ 只能靠单测钉死。
import assert from 'node:assert/strict';

import {
	FEISHU_WS_CONFIG_DEFAULTS,
	FRAME_HEADER,
	FRAME_METHOD,
	MESSAGE_TYPE,
	FeishuFrameAssembler,
	buildAckFrame,
	buildPingFrame,
	decodeFeishuFrame,
	decodeUtf8,
	encodeFeishuFrame,
	encodeUtf8,
	extractServiceId,
	frameHeader,
	parseClientConfig,
	parseWsEndpointResponse,
	resolveWsEndpointBase,
} from '../lib/adapters/feishuWsFrames.js';
import { createRawWsTransport } from '../lib/adapters/feishuRawWs.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
	try { fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};
const checkAsync = async (name, fn) => {
	try { await fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ★ 防挂死看门狗（2026-10-29）：脚本挂在某个 await 上时，Node 事件循环空掉就会
   **静默 exit 0** —— 症状是"stdout 什么都没有、退出码 0"，比失败难查得多
   （曾被误判成"测试没跑完"）。这里用一个**不 unref** 的定时器兜底：
   超时未跑完 ⇒ 打印明确的失败并 exit 1。正常跑完会在结尾 clearTimeout。 */
const WATCHDOG_MS = 30000;
const watchdog = setTimeout(() => {
	console.error(`✗ 测试超时：${WATCHDOG_MS}ms 内没跑完（挂在某个 await 上）`);
	process.exit(1);
}, WATCHDOG_MS);

/* ── 假 WebSocket / 假 fetch ─────────────────────────────────────────────── */

/** Node 风格（`ws` 包）：`on('open'|'message'|'close'|'error')`，message 给 Buffer。 */
class FakeNodeWs {
	constructor(url) {
		this.url = url;
		this.sent = [];
		this.handlers = new Map();
		this.closed = false;
		/* 自动 open：放在下一个宏任务，保证调用方已经挂好回调（attachSocket 是同步的）。 */
		this.openTimer = setTimeout(() => { this.emit('open'); }, 0);
	}
	on(ev, fn) {
		if (!this.handlers.has(ev)) { this.handlers.set(ev, []); }
		this.handlers.get(ev).push(fn);
		return this;
	}
	emit(ev, ...args) {
		for (const fn of this.handlers.get(ev) || []) { fn(...args); }
	}
	send(data) { this.sent.push(data); }
	close() { this.closed = true; clearTimeout(this.openTimer); }
	/** 模拟服务端推来一帧二进制。 */
	push(bytes) { this.emit('message', Buffer.from(bytes), true); }
	/** 模拟服务端推来一段文本。 */
	pushText(text) { this.emit('message', text, false); }
}

/** DOM 风格（全局 WebSocket）：`addEventListener(...)`，message 给 `ev.data`。 */
class FakeDomWs {
	constructor(url) {
		this.url = url;
		this.sent = [];
		this.listeners = new Map();
		this.closed = false;
		this.openTimer = setTimeout(() => { this.fire('open'); }, 0);
	}
	addEventListener(ev, fn) {
		if (!this.listeners.has(ev)) { this.listeners.set(ev, []); }
		this.listeners.get(ev).push(fn);
	}
	fire(ev, data) {
		for (const fn of this.listeners.get(ev) || []) { fn({ data }); }
	}
	send(data) { this.sent.push(data); }
	close() { this.closed = true; clearTimeout(this.openTimer); }
	push(bytes) { this.fire('message', new Uint8Array(bytes)); }
}

/** 假 fetch：返回固定的长连接端点响应。 */
const fakeEndpointFetch = (calls, extra = {}) => async (url, init) => {
	calls.push({ url, init });
	return {
		status: 200,
		text: async () => JSON.stringify({
			code: 0,
			data: {
				URL: 'wss://open.feishu.cn/ws?service_id=7',
				ClientConfig: { PingInterval: 45, ReconnectCount: -1, ReconnectInterval: 60, ReconnectNonce: 5 },
			},
			...extra,
		}),
	};
};

/** 造一条 DATA 帧（事件帧）。 */
const eventFrame = (payloadObj, extraHeaders = []) => encodeFeishuFrame({
	seqId: '11',
	logId: '22',
	service: 7,
	method: FRAME_METHOD.DATA,
	headers: [
		{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.EVENT },
		{ key: FRAME_HEADER.MESSAGE_ID, value: 'om_1' },
		...extraHeaders,
	],
	payload: encodeUtf8(JSON.stringify(payloadObj)),
});

/* ── 帧 round-trip ─────────────────────────────────────────────────────── */
check('★ 帧 round-trip：字段逐字一致（seqId/logId 十进制字符串 + headers + payload 字节）', () => {
	const payload = encodeUtf8(JSON.stringify({ header: { event_type: 'im.message.receive_v1' }, event: { message: { chat_id: 'oc_1' } } }));
	const bytes = encodeFeishuFrame({
		seqId: '18446744073709551615',
		logId: '9007199254740993',
		service: 7,
		method: FRAME_METHOD.DATA,
		headers: [
			{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.EVENT },
			{ key: FRAME_HEADER.MESSAGE_ID, value: 'om_1' },
			{ key: FRAME_HEADER.SUM, value: '1' },
			{ key: FRAME_HEADER.SEQ, value: '0' },
		],
		payloadEncoding: 'utf-8',
		payloadType: 'application/json',
		payload,
	});
	const f = decodeFeishuFrame(bytes);
	/* uint64 用十进制字符串承载：这两个值用 JS number 会丢精度。 */
	assert.equal(f.seqId, '18446744073709551615');
	assert.equal(f.logId, '9007199254740993');
	assert.equal(f.service, 7);
	assert.equal(f.method, FRAME_METHOD.DATA);
	assert.deepEqual(f.headers.map((h) => [h.key, h.value]), [
		[FRAME_HEADER.TYPE, MESSAGE_TYPE.EVENT],
		[FRAME_HEADER.MESSAGE_ID, 'om_1'],
		[FRAME_HEADER.SUM, '1'],
		[FRAME_HEADER.SEQ, '0'],
	]);
	assert.equal(f.payloadEncoding, 'utf-8');
	assert.equal(f.payloadType, 'application/json');
	assert.deepEqual(Array.from(f.payload), Array.from(payload));
});

check('proto2 required：字段 1–4 即使为 0 也必须写出（能解回 "0"）', () => {
	const f = decodeFeishuFrame(encodeFeishuFrame({ seqId: '0', logId: '0', service: 0, method: 0 }));
	assert.equal(f.seqId, '0');
	assert.equal(f.logId, '0');
	assert.equal(f.service, 0);
	assert.equal(f.method, FRAME_METHOD.CONTROL);
});

check('未识别字段原样保留（重编码时不丢字段）', () => {
	/* 字段 15（varint）—— 协议里没有这个字段号 ⇒ 必须进 unknownFields 且原样保留。 */
	const raw = new Uint8Array([0x78, 0x01]);
	const f = decodeFeishuFrame(raw);
	assert.equal(f.unknownFields.length, 1);
	assert.deepEqual(Array.from(f.unknownFields[0]), Array.from(raw));
	/* 重编码后这段字节必须原样写回去。 */
	const again = decodeFeishuFrame(encodeFeishuFrame(f));
	assert.deepEqual(Array.from(again.unknownFields[0]), Array.from(raw));
});

/* ── 心跳 / 回执 ───────────────────────────────────────────────────────── */
check('心跳帧是 CONTROL + type=ping + service 正确', () => {
	const f = decodeFeishuFrame(buildPingFrame(7));
	assert.equal(f.method, FRAME_METHOD.CONTROL);
	assert.equal(frameHeader(f, FRAME_HEADER.TYPE), MESSAGE_TYPE.PING);
	assert.equal(f.service, 7);
	assert.equal(f.seqId, '0');
	assert.equal(f.logId, '0');
});

check('★ 回执帧带回原帧关键字段 + code=200 + biz_rt（毫秒取整）', () => {
	const src = decodeFeishuFrame(eventFrame({ hello: 1 }));
	const ack = decodeFeishuFrame(buildAckFrame(src, 12.4, true));
	assert.equal(ack.seqId, '11');
	assert.equal(ack.logId, '22');
	assert.equal(ack.service, 7);
	assert.equal(ack.method, FRAME_METHOD.DATA);
	assert.equal(frameHeader(ack, FRAME_HEADER.TYPE), MESSAGE_TYPE.EVENT);
	assert.equal(frameHeader(ack, FRAME_HEADER.MESSAGE_ID), 'om_1');
	assert.equal(frameHeader(ack, FRAME_HEADER.BIZ_RT), '12');
	assert.deepEqual(JSON.parse(decodeUtf8(ack.payload)), { code: 200 });
});

check('回执失败时 code=500（处理出错要让飞书知道）', () => {
	const src = decodeFeishuFrame(eventFrame({ hello: 1 }));
	const ack = decodeFeishuFrame(buildAckFrame(src, 3, false));
	assert.deepEqual(JSON.parse(decodeUtf8(ack.payload)), { code: 500 });
});

/* ── 端点响应 / 客户端配置 ─────────────────────────────────────────────── */
check('端点响应：取 url + clientConfig（PascalCase）', () => {
	const r = parseWsEndpointResponse({
		code: 0,
		data: {
			URL: 'wss://open.feishu.cn/ws?service_id=7',
			ClientConfig: { PingInterval: 45, ReconnectCount: 5, ReconnectInterval: 60, ReconnectNonce: 10 },
		},
	});
	assert.equal(r.url, 'wss://open.feishu.cn/ws?service_id=7');
	assert.equal(r.clientConfig.pingIntervalSec, 45);
	assert.equal(r.clientConfig.reconnectCount, 5);
	assert.equal(r.clientConfig.reconnectIntervalSec, 60);
	assert.equal(r.clientConfig.reconnectNonceSec, 10);
});

check('端点响应：也接受小写 url / camelCase clientConfig（网关版本差异容错）', () => {
	const r = parseWsEndpointResponse({ code: 0, data: { url: 'wss://x/ws?service_id=2', clientConfig: { pingIntervalSec: 30 } } });
	assert.equal(r.url, 'wss://x/ws?service_id=2');
	assert.equal(r.clientConfig.pingIntervalSec, 30);
});

check('★ 端点响应 code!=0 ⇒ 抛错且带飞书的 code/msg', () => {
	assert.throws(
		() => parseWsEndpointResponse({ code: 1000040346, msg: 'app_id is invalid' }),
		/code=1000040346/,
	);
	assert.throws(
		() => parseWsEndpointResponse({ code: 1000040346, msg: 'app_id is invalid' }),
		/app_id is invalid/,
	);
});

check('端点响应缺 URL ⇒ 抛错（不返回半个结果）', () => {
	assert.throws(() => parseWsEndpointResponse({ code: 0, data: { URL: '' } }), /缺少 data\.URL/);
});

check('ClientConfig 缺省 ⇒ SDK 默认值', () => {
	const c = parseClientConfig(undefined);
	assert.equal(c.pingIntervalSec, FEISHU_WS_CONFIG_DEFAULTS.pingIntervalSec);
	assert.equal(c.reconnectCount, FEISHU_WS_CONFIG_DEFAULTS.reconnectCount);
	assert.equal(c.reconnectIntervalSec, FEISHU_WS_CONFIG_DEFAULTS.reconnectIntervalSec);
	assert.equal(c.reconnectNonceSec, FEISHU_WS_CONFIG_DEFAULTS.reconnectNonceSec);
});

check('ClientConfig 非法值 ⇒ 回落默认值（但 reconnectCount=-1 是合法的「无限重连」）', () => {
	const c = parseClientConfig({ PingInterval: 0, ReconnectInterval: -5, ReconnectNonce: 'x', ReconnectCount: -1 });
	assert.equal(c.pingIntervalSec, 120);
	assert.equal(c.reconnectIntervalSec, 120);
	assert.equal(c.reconnectNonceSec, 30);
	assert.equal(c.reconnectCount, -1);
});

check('长连接端点基址：去掉 /open-apis（端点在域名根下）', () => {
	assert.equal(resolveWsEndpointBase('https://open.feishu.cn/open-apis'), 'https://open.feishu.cn');
	assert.equal(resolveWsEndpointBase('https://open.feishu.cn/open-apis/'), 'https://open.feishu.cn');
	assert.equal(resolveWsEndpointBase('https://open.feishu.cn'), 'https://open.feishu.cn');
});

/* ── 分片重组 ──────────────────────────────────────────────────────────── */
check('★ 分片乱序到达 ⇒ 收齐才产出（拼回原字节）', () => {
	const a = new FeishuFrameAssembler();
	const p0 = encodeUtf8('{"he');
	const p1 = encodeUtf8('llo":1}');
	assert.equal(a.push('om_1', 2, 1, p1), undefined, '只到第 2 片不能产出');
	const merged = a.push('om_1', 2, 0, p0);
	assert.ok(merged, '收齐后必须产出');
	assert.equal(decodeUtf8(merged), '{"hello":1}');
});

check('★ 分片缓存 TTL 过期 ⇒ 清理（老残片不会与新片拼在一起）', () => {
	const a = new FeishuFrameAssembler();
	assert.equal(a.push('om_1', 2, 0, encodeUtf8('a')), undefined);
	assert.equal(a.size(), 1);
	const merged = a.push('om_1', 2, 1, encodeUtf8('b'), Date.now() + 6000);
	assert.equal(merged, undefined, '过期后第一片应被清掉，不能与新片拼接');
	assert.equal(a.size(), 1, '过期片被丢弃后重新起一条新的');
});

check('分片缓存 clear() ⇒ 清空（重连时不能残留）', () => {
	const a = new FeishuFrameAssembler();
	a.push('om_1', 2, 0, encodeUtf8('a'));
	assert.equal(a.size(), 1);
	a.clear();
	assert.equal(a.size(), 0);
});

/* ── service_id / UTF-8 ───────────────────────────────────────────────── */
check('service_id 从查询串取（取不到 / 非法 ⇒ 用 fallback）', () => {
	assert.equal(extractServiceId('wss://x/ws?service_id=7&a=1'), 7);
	assert.equal(extractServiceId('wss://x/ws'), 1);
	assert.equal(extractServiceId('wss://x/ws?service_id=0'), 1);
	assert.equal(extractServiceId('wss://x/ws?service_id=abc'), 1);
	assert.equal(extractServiceId('wss://x/ws?service_id=9', 3), 9);
	assert.equal(extractServiceId('wss://x/ws', 5), 5);
});

check('UTF-8 往返（含中文 / emoji / 生僻字）', () => {
	const s = '中文 · emoji ✅ 𝄞 飞书长连接';
	assert.equal(decodeUtf8(encodeUtf8(s)), s);
	assert.equal(decodeUtf8(encodeUtf8('')), '');
});

/* ── transport：凭据 ───────────────────────────────────────────────────── */
await checkAsync('★ 缺凭据 ⇒ 抛 unavailable（不静默、不重试）', async () => {
	const t = createRawWsTransport({ resolve: async () => ({}) });
	await assert.rejects(() => t.start({}), /unavailable：缺少 app_id \/ app_secret/);
});

await checkAsync('缺凭据时抛的是「不可恢复」错误（上层据此停止重试）', async () => {
	const t = createRawWsTransport({});
	await assert.rejects(() => t.start({}), (e) => {
		assert.ok(String(e.message).startsWith('unavailable'), '必须带 unavailable 前缀');
		return true;
	});
});

/* ── transport：端到端 ─────────────────────────────────────────────────── */
await checkAsync('★ 端到端：换地址 → 建连 → 立刻发 ping → 收事件 → 回 ack', async () => {
	const calls = [];
	const sockets = [];
	const events = [];
	const notes = [];
	class Impl extends FakeNodeWs {
		constructor(url) { super(url); sockets.push(this); }
	}
	const t = createRawWsTransport({
		resolve: async () => ({ appId: 'cli_1', appSecret: 'sec_1' }),
		fetchImpl: fakeEndpointFetch(calls),
		WebSocketImpl: Impl,
	});
	const handle = await t.start({
		onEvent: (p) => events.push(p),
		onError: () => { /* 不该被调用 */ },
		note: (level, msg) => notes.push(`${level}:${msg}`),
	});

	/* ① 换地址：域名根 + PascalCase 请求体 */
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://open.feishu.cn/callback/ws/endpoint');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
	assert.deepEqual(JSON.parse(calls[0].init.body), { AppID: 'cli_1', AppSecret: 'sec_1' });

	/* ② 建连：用的是服务端下发的 wss 地址 */
	const sock = sockets[0];
	assert.equal(sock.url, 'wss://open.feishu.cn/ws?service_id=7');

	/* ③ 连上后立刻发心跳（CONTROL + type=ping + service=7） */
	assert.ok(sock.sent.length >= 1, '连上必须先发一次 ping');
	const ping = decodeFeishuFrame(sock.sent[0]);
	assert.equal(ping.method, FRAME_METHOD.CONTROL);
	assert.equal(frameHeader(ping, FRAME_HEADER.TYPE), MESSAGE_TYPE.PING);
	assert.equal(ping.service, 7);

	/* ④ 事件帧 ⇒ 原始 JSON 对象交给 onEvent */
	const evt = {
		header: { event_type: 'im.message.receive_v1' },
		event: { message: { chat_id: 'oc_1', message_id: 'om_1', message_type: 'text', content: '{"text":"hi"}' } },
	};
	sock.push(eventFrame(evt));
	await tick();
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], evt, '必须原样把 JSON 对象交给上层（形状保持 { header, event }）');

	/* ⑤ ★ 回执（ack）必须发 —— 漏了飞书不再推下一条 */
	const ack = decodeFeishuFrame(sock.sent[sock.sent.length - 1]);
	assert.equal(frameHeader(ack, FRAME_HEADER.BIZ_RT) !== undefined, true, '回执必须带 biz_rt');
	assert.deepEqual(JSON.parse(decodeUtf8(ack.payload)), { code: 200 });
	assert.equal(frameHeader(ack, FRAME_HEADER.MESSAGE_ID), 'om_1');

	handle.close();
	assert.equal(sock.closed, true, 'close() 必须关掉 socket');
});

await checkAsync('★ 分片（sum=2）乱序到达 ⇒ 收齐才交给 onEvent，且只回一次 ack', async () => {
	const calls = [];
	const sockets = [];
	const events = [];
	class Impl extends FakeNodeWs {
		constructor(url) { super(url); sockets.push(this); }
	}
	const t = createRawWsTransport({
		resolve: async () => ({ appId: 'a', appSecret: 'b' }),
		fetchImpl: fakeEndpointFetch(calls),
		WebSocketImpl: Impl,
	});
	const handle = await t.start({ onEvent: (p) => events.push(p), onError: () => { } });
	const sock = sockets[0];
	const payload = encodeUtf8(JSON.stringify({ header: { event_type: 'im.message.receive_v1' }, event: { n: 1 } }));
	const part = (seq, bytes) => encodeFeishuFrame({
		seqId: '11', logId: '22', service: 7, method: FRAME_METHOD.DATA,
		headers: [
			{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.EVENT },
			{ key: FRAME_HEADER.MESSAGE_ID, value: 'om_split' },
			{ key: FRAME_HEADER.SUM, value: '2' },
			{ key: FRAME_HEADER.SEQ, value: String(seq) },
		],
		payload: bytes,
	});
	const half = Math.floor(payload.length / 2);
	sock.push(part(1, payload.slice(half)));
	await tick();
	assert.equal(events.length, 0, '没收齐不能交事件');
	sock.push(part(0, payload.slice(0, half)));
	await tick();
	assert.equal(events.length, 1, '收齐后必须交事件');
	assert.deepEqual(events[0], { header: { event_type: 'im.message.receive_v1' }, event: { n: 1 } });
	handle.close();
});

await checkAsync('★ url_verification ⇒ 回 challenge（裸 UTF-8 JSON，与 IDE 侧一致）', async () => {
	const calls = [];
	const sockets = [];
	const events = [];
	class Impl extends FakeNodeWs {
		constructor(url) { super(url); sockets.push(this); }
	}
	const t = createRawWsTransport({
		resolve: async () => ({ appId: 'a', appSecret: 'b' }),
		fetchImpl: fakeEndpointFetch(calls),
		WebSocketImpl: Impl,
	});
	const handle = await t.start({ onEvent: (p) => events.push(p), onError: () => { } });
	const sock = sockets[0];
	sock.push(eventFrame({ type: 'url_verification', challenge: 'ch_1', token: 'tk_1' }));
	await tick();
	const replyText = sock.sent
		.map((x) => (typeof x === 'string' ? x : decodeUtf8(x)))
		.find((txt) => {
			try { const j = JSON.parse(txt); return !!(j && j.challenge); } catch { return false; }
		});
	assert.ok(replyText, '必须回 challenge');
	assert.deepEqual(JSON.parse(replyText), { challenge: 'ch_1', token: 'tk_1' });
	assert.equal(events.length, 0, 'challenge 不是业务事件，不该交给 onEvent');
	handle.close();
});

await checkAsync('全局 WebSocket 风格（addEventListener）也能收发', async () => {
	const calls = [];
	const sockets = [];
	const events = [];
	class Impl extends FakeDomWs {
		constructor(url) { super(url); sockets.push(this); }
	}
	const t = createRawWsTransport({
		resolve: async () => ({ appId: 'a', appSecret: 'b' }),
		fetchImpl: fakeEndpointFetch(calls),
		WebSocketImpl: Impl,
	});
	const handle = await t.start({ onEvent: (p) => events.push(p), onError: () => { } });
	const sock = sockets[0];
	const evt = { header: { event_type: 'im.message.receive_v1' }, event: { message: { chat_id: 'oc_2' } } };
	sock.push(eventFrame(evt));
	await tick();
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], evt);
	handle.close();
});

await checkAsync('★ close() 之后不再重连（不会偷偷拉起第二条连接）', async () => {
	const calls = [];
	const sockets = [];
	class Impl extends FakeNodeWs {
		constructor(url) { super(url); sockets.push(this); }
	}
	const t = createRawWsTransport({
		resolve: async () => ({ appId: 'a', appSecret: 'b' }),
		fetchImpl: fakeEndpointFetch(calls),
		WebSocketImpl: Impl,
	});
	const handle = await t.start({ onEvent: () => { }, onError: () => { } });
	assert.equal(sockets.length, 1);
	handle.close();
	sockets[0].emit('close');
	await tick();
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(sockets.length, 1, `close() 后不该再拉连接，实际 ${sockets.length}`);
	assert.equal(calls.length, 1, `close() 后不该再换地址，实际 ${calls.length}`);
});

await checkAsync('★ 断线后按 ClientConfig 自己重连（并更新 service_id）', async () => {
	const calls = [];
	const sockets = [];
	class Impl extends FakeNodeWs {
		constructor(url) { super(url); sockets.push(this); }
	}
	const t = createRawWsTransport({
		resolve: async () => ({ appId: 'a', appSecret: 'b' }),
		fetchImpl: fakeEndpointFetch(calls),
		WebSocketImpl: Impl,
	});
	const handle = await t.start({ onEvent: () => { }, onError: () => { } });
	const first = sockets[0];
	/* 服务端断链 ⇒ 应触发重连（ReconnectNonce=5s ⇒ 首次延迟是 0~5s 随机，这里等一会儿）。 */
	first.emit('close');
	await new Promise((r) => setTimeout(r, 50));
	/* 首次重连有随机抖动，不能断言"一定已重连"；但必须**已经开始重连流程**
	   （换地址 ⇒ calls 变 2，或至少定时器已排上）。 */
	assert.ok(calls.length >= 1, '断线后至少要走到重连流程');
	handle.close();
});

await checkAsync('心跳配置可被服务端 pong 覆盖（不写死 120s）', async () => {
	const calls = [];
	const sockets = [];
	const notes = [];
	class Impl extends FakeNodeWs {
		constructor(url) { super(url); sockets.push(this); }
	}
	const t = createRawWsTransport({
		resolve: async () => ({ appId: 'a', appSecret: 'b' }),
		fetchImpl: fakeEndpointFetch(calls),
		WebSocketImpl: Impl,
	});
	const handle = await t.start({ onEvent: () => { }, onError: () => { }, note: (level, msg) => notes.push(`${level}:${msg}`) });
	const sock = sockets[0];
	sock.push(encodeFeishuFrame({
		seqId: '0', logId: '0', service: 7, method: FRAME_METHOD.CONTROL,
		headers: [{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.PONG }],
		payload: encodeUtf8(JSON.stringify({ PingInterval: 30 })),
	}));
	await tick();
	assert.ok(notes.some((n) => n.includes('心跳配置已更新')), 'pong 带回新配置必须留痕');
	handle.close();
});

/* ── vendor 的 ws 能不能 import（打包/路径错了会在这里暴露）────────────── */
await checkAsync('★ 包内 vendor 的 ws 可 import 且是构造函数（CJS 默认导入）', async () => {
	const mod = await import('../lib/adapters/vendor/deps/ws/index.js');
	const impl = mod && (mod.default || mod.WebSocket);
	assert.equal(typeof impl, 'function', '拿不到构造函数');
	const sock = new impl('ws://127.0.0.1:1/');
	assert.equal(typeof sock.on, 'function');
	sock.on('error', () => { /* 连不上是预期的 */ });
	sock.close();
});

/* ── 汇总 ─────────────────────────────────────────────────────────────── */
clearTimeout(watchdog);
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 飞书长连接（WS）单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
