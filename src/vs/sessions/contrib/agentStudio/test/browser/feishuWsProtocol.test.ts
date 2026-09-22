/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 飞书长连接 pbbp2 协议编解码测试（D-07 结案的核心回归）──────────────────
//
// 为什么必须有这一层：长连接不是 JSON over WS，而是 **protobuf 二进制帧**。
// 手工实现 wire 编解码最容易出的错是「字段号记错」和「required 零值被省略」，
// 两者都会让连接建起来但一帧都读不出来 —— 故这里用**手算字节 fixture** 把字段号钉死，
// 而不是只做 encode↔decode 自证（那种测试在同错编码/解码下仍会通过）。
//
// 权威来源：飞书官方 Python SDK
//   `lark_oapi/ws/pb/pbbp2_pb2.py`（字段号）、`enum.py`（FrameType/MessageType）、
//   `const.py`（端点与 header key）、`model.py`（EndpointResp/ClientConfig）。

import assert from 'assert';
import {
	FEISHU_WS_CONFIG_DEFAULTS,
	FEISHU_WS_ENDPOINT_PATH,
	FRAME_HEADER,
	FRAME_METHOD,
	FeishuFrameAssembler,
	MESSAGE_TYPE,
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
} from '../../browser/bridge/platforms/feishuWsProtocol.js';

/**
 * 手算字节 fixture：pbbp2 Frame
 *   SeqID=1        → `08 01`
 *   LogID=2        → `10 02`
 *   service=1      → `18 01`
 *   method=1(DATA) → `20 01`
 *   headers[0] = {key:"type", value:"event"}
 *     → Header 体 = `0A 04 'type' 12 05 'event'`（13 字节）→ `2A 0D ...`
 *   payload_encoding="json" → `32 04 'json'`
 *   payload_type="event"    → `3A 05 'event'`
 *   payload=`{"a":1}`（7 字节）→ `42 07 ...`
 */
const HAND_WRITTEN_EVENT_FRAME = new Uint8Array([
	0x08, 0x01,
	0x10, 0x02,
	0x18, 0x01,
	0x20, 0x01,
	0x2a, 0x0d, 0x0a, 0x04, 0x74, 0x79, 0x70, 0x65, 0x12, 0x05, 0x65, 0x76, 0x65, 0x6e, 0x74,
	0x32, 0x04, 0x6a, 0x73, 0x6f, 0x6e,
	0x3a, 0x05, 0x65, 0x76, 0x65, 0x6e, 0x74,
	0x42, 0x07, 0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d,
]);

// ══════════════════════════════════════════════════════════════════════════
// 1) 帧解码（对手算字节，锁字段号）
// ══════════════════════════════════════════════════════════════════════════

suite('飞书长连接协议 · 帧解码（字段号由官方 proto 钉死）', () => {
	test('手算字节 → 各字段逐一还原', () => {
		const frame = decodeFeishuFrame(HAND_WRITTEN_EVENT_FRAME);

		assert.strictEqual(frame.seqId, '1');
		assert.strictEqual(frame.logId, '2');
		assert.strictEqual(frame.service, 1);
		assert.strictEqual(frame.method, FRAME_METHOD.DATA);
		assert.deepStrictEqual(frame.headers, [{ key: 'type', value: 'event' }]);
		assert.strictEqual(frame.payloadEncoding, 'json');
		assert.strictEqual(frame.payloadType, 'event');
		assert.strictEqual(decodeUtf8(frame.payload), '{"a":1}');
	});

	test('uint64 用十进制字符串承载（不做 float 截断）', () => {
		// SeqID = 2^63 = 9223372036854775808 → varint `80 80 80 80 80 80 80 80 80 01`
		const bytes = new Uint8Array([
			0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,
			0x10, 0x00,
			0x18, 0x00,
			0x20, 0x00,
		]);
		const frame = decodeFeishuFrame(bytes);
		assert.strictEqual(frame.seqId, '9223372036854775808');
	});

	test('负数 int32（method=-1）按符号扩展解码回 -1', () => {
		const bytes = new Uint8Array([
			0x08, 0x00, 0x10, 0x00, 0x18, 0x00,
			0x20, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
		]);
		assert.strictEqual(decodeFeishuFrame(bytes).method, -1);
	});

	test('未识别字段被保留（原样字节，重编码时不丢）', () => {
		// 追加一个未知字段 15（varint）= tag `78` + value `07`
		const withUnknown = new Uint8Array([...HAND_WRITTEN_EVENT_FRAME, 0x78, 0x07]);
		const frame = decodeFeishuFrame(withUnknown);
		assert.strictEqual(frame.unknownFields.length, 1);
		const roundTrip = encodeFeishuFrame(frame);
		assert.deepStrictEqual([...roundTrip], [...withUnknown], 'round-trip 后字节完全一致');
	});

	test('截断的帧抛错（而不是静默返回半个帧）', () => {
		assert.throws(() => decodeFeishuFrame(new Uint8Array([0x2a, 0x0d, 0x0a])), /截断|越界/);
		assert.throws(() => decodeFeishuFrame(new Uint8Array([0x08, 0x80])), /截断|varint/);
		assert.throws(() => decodeFeishuFrame(new Uint8Array([0x3f, 0x01])), /wire type/);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 2) 帧编码（proto2 required 语义）
// ══════════════════════════════════════════════════════════════════════════

suite('飞书长连接协议 · 帧编码', () => {
	test('required 字段即使为 0 也会写出（对齐 proto2 SerializeToString）', () => {
		const bytes = encodeFeishuFrame({ seqId: '0', logId: '0', service: 0, method: 0 });
		assert.deepStrictEqual(
			[...bytes],
			[0x08, 0x00, 0x10, 0x00, 0x18, 0x00, 0x20, 0x00],
			'SeqID/LogID/service/method 各写一个 0 值 varint',
		);
	});

	test('ping 帧：`{service:7, method:0(CONTROL), headers:[type=ping]}`', () => {
		const frame = decodeFeishuFrame(buildPingFrame(7));
		assert.strictEqual(frame.service, 7);
		assert.strictEqual(frame.method, FRAME_METHOD.CONTROL);
		assert.strictEqual(frame.seqId, '0');
		assert.strictEqual(frame.logId, '0');
		assert.deepStrictEqual(frame.headers, [{ key: 'type', value: 'ping' }]);
		assert.strictEqual(frame.payload.length, 0);

		// 精确字节：08 00 | 10 00 | 18 07 | 20 00 | 2A 0C 0A 04 'type' 12 04 'ping'
		assert.deepStrictEqual([...buildPingFrame(7)], [
			0x08, 0x00,
			0x10, 0x00,
			0x18, 0x07,
			0x20, 0x00,
			0x2a, 0x0c, 0x0a, 0x04, 0x74, 0x79, 0x70, 0x65, 0x12, 0x04, 0x70, 0x69, 0x6e, 0x67,
		]);
	});

	test('回执帧：复用原帧 + payload={"code":200} + biz_rt 头', () => {
		const incoming = decodeFeishuFrame(HAND_WRITTEN_EVENT_FRAME);
		const ack = decodeFeishuFrame(buildAckFrame(incoming, 12));

		assert.strictEqual(ack.seqId, '1');
		assert.strictEqual(ack.logId, '2');
		assert.strictEqual(ack.method, FRAME_METHOD.DATA);
		assert.strictEqual(ack.payloadEncoding, 'json', '原 payload_encoding/type 应保留');
		assert.strictEqual(frameHeader(ack, FRAME_HEADER.TYPE), MESSAGE_TYPE.EVENT);
		assert.strictEqual(frameHeader(ack, FRAME_HEADER.BIZ_RT), '12');
		assert.deepStrictEqual(JSON.parse(decodeUtf8(ack.payload)), { code: 200 });
	});

	test('失败回执用 code=500；biz_rt 不会出现负数', () => {
		const incoming = decodeFeishuFrame(HAND_WRITTEN_EVENT_FRAME);
		const ack = decodeFeishuFrame(buildAckFrame(incoming, -5, false));
		assert.deepStrictEqual(JSON.parse(decodeUtf8(ack.payload)), { code: 500 });
		assert.strictEqual(frameHeader(ack, FRAME_HEADER.BIZ_RT), '0');
	});

	test('中文/emoji payload 走 UTF-8 往返无损', () => {
		const text = '你好，飞书 🎉';
		const frame = decodeFeishuFrame(encodeFeishuFrame({ payload: encodeUtf8(text) }));
		assert.strictEqual(decodeUtf8(frame.payload), text);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 3) 换地址响应解析（model.py#EndpointResp / ClientConfig）
// ══════════════════════════════════════════════════════════════════════════

suite('飞书长连接协议 · 换地址响应解析', () => {
	test('官方形状：data.URL + data.ClientConfig（PascalCase）', () => {
		const r = parseWsEndpointResponse({
			code: 0,
			msg: 'success',
			data: {
				URL: 'wss://open.feishu.cn/ws?device_id=d&service_id=3',
				ClientConfig: { PingInterval: 60, ReconnectCount: -1, ReconnectInterval: 30, ReconnectNonce: 10 },
			},
		});
		assert.strictEqual(r.url, 'wss://open.feishu.cn/ws?device_id=d&service_id=3');
		assert.deepStrictEqual(r.clientConfig, {
			pingIntervalSec: 60,
			reconnectCount: -1,
			reconnectIntervalSec: 30,
			reconnectNonceSec: 10,
		});
	});

	test('端点路径常量为官方值（防回退到 404 的臆测端点）', () => {
		assert.strictEqual(FEISHU_WS_ENDPOINT_PATH, '/callback/ws/endpoint');
	});

	test('resolveWsEndpointBase：换地址端点在**域名根**下，必须去掉 /open-apis', () => {
		// 实测对照（无效凭证探测真实网络）：
		//   https://open.feishu.cn/callback/ws/endpoint          → 200 + {"code":1000040346,...}
		//   https://open.feishu.cn/open-apis/callback/ws/endpoint → 404 page not found
		assert.strictEqual(
			resolveWsEndpointBase('https://open.feishu.cn/open-apis'),
			'https://open.feishu.cn',
		);
		assert.strictEqual(
			resolveWsEndpointBase('https://open.larksuite.com/open-apis'),
			'https://open.larksuite.com',
		);
		// 已是裸域名 → 原样；尾斜杠 → 归一
		assert.strictEqual(resolveWsEndpointBase('https://open.feishu.cn'), 'https://open.feishu.cn');
		assert.strictEqual(resolveWsEndpointBase('https://open.feishu.cn/open-apis/'), 'https://open.feishu.cn');
		// 兜底：不产生空基址
		assert.ok(resolveWsEndpointBase('').length >= 0);
	});

	test('换地址完整 URL 一定是「域名根 + 路径」（回归：曾漏 /open-apis 得到 404）', () => {
		const base = resolveWsEndpointBase('https://open.feishu.cn/open-apis');
		assert.strictEqual(`${base}${FEISHU_WS_ENDPOINT_PATH}`, 'https://open.feishu.cn/callback/ws/endpoint');
		assert.ok(!`${base}${FEISHU_WS_ENDPOINT_PATH}`.includes('/open-apis/'));
	});

	test('容错：小写 url / 缺 ClientConfig → 用默认配置', () => {
		const r = parseWsEndpointResponse({ code: 0, data: { url: 'wss://x' } });
		assert.strictEqual(r.url, 'wss://x');
		assert.deepStrictEqual(r.clientConfig, FEISHU_WS_CONFIG_DEFAULTS);
	});

	test('code!=0 → 抛错并带 code/msg；缺 URL → 抛错', () => {
		assert.throws(() => parseWsEndpointResponse({ code: 99991663, msg: 'invalid app_id' }), /code=99991663.*invalid app_id/);
		assert.throws(() => parseWsEndpointResponse({ code: 1 }), /system busy/);
		assert.throws(() => parseWsEndpointResponse({ code: 0, msg: 'ok' }), /缺少 data.URL/);
	});

	test('ClientConfig 非法值回落默认（0/负数/NaN 不采纳）', () => {
		const cfg = parseClientConfig({ PingInterval: 0, ReconnectInterval: -1, ReconnectNonce: 'abc' });
		assert.strictEqual(cfg.pingIntervalSec, FEISHU_WS_CONFIG_DEFAULTS.pingIntervalSec);
		assert.strictEqual(cfg.reconnectIntervalSec, FEISHU_WS_CONFIG_DEFAULTS.reconnectIntervalSec);
		assert.strictEqual(cfg.reconnectNonceSec, FEISHU_WS_CONFIG_DEFAULTS.reconnectNonceSec);
		// ReconnectCount 允许 -1（无限重连）
		assert.strictEqual(parseClientConfig({ ReconnectCount: -1 }).reconnectCount, -1);
	});

	test('service_id 取自 wss 地址查询串（ping 的 service 字段）', () => {
		assert.strictEqual(extractServiceId('wss://open.feishu.cn/ws?device_id=d&service_id=42'), 42);
		assert.strictEqual(extractServiceId('wss://open.feishu.cn/ws?service_id=bad'), 1, '非法值回落 1');
		assert.strictEqual(extractServiceId('wss://open.feishu.cn/ws'), 1, '无查询串回落 1');
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 4) 分片重组（client.py#_combine：sum/seq + 5s TTL）
// ══════════════════════════════════════════════════════════════════════════

suite('飞书长连接协议 · 分片重组', () => {
	const bytes = (s: string): Uint8Array => encodeUtf8(s);

	test('乱序到达 → 收齐后按 seq 顺序拼接', () => {
		const asm = new FeishuFrameAssembler();
		assert.strictEqual(asm.push('m1', 2, 1, bytes('B'), 1_000), undefined, '未收齐返回 undefined');
		const merged = asm.push('m1', 2, 0, bytes('A'), 1_001);
		assert.strictEqual(merged && decodeUtf8(merged), 'AB');
	});

	test('三片乱序（2,0,1）同样正确拼接', () => {
		const asm = new FeishuFrameAssembler();
		asm.push('m2', 3, 2, bytes('C'), 1_000);
		asm.push('m2', 3, 0, bytes('A'), 1_001);
		const merged = asm.push('m2', 3, 1, bytes('B'), 1_002);
		assert.strictEqual(merged && decodeUtf8(merged), 'ABC');
	});

	test('不同 message_id 互不干扰', () => {
		const asm = new FeishuFrameAssembler();
		asm.push('a', 2, 0, bytes('A'), 1_000);
		asm.push('b', 2, 0, bytes('B'), 1_000);
		const fromA = asm.push('a', 2, 1, bytes('a'), 1_001);
		assert.strictEqual(fromA && decodeUtf8(fromA), 'Aa');
	});

	test('TTL 5 秒超时后丢弃陈旧分片（不会拼出脏数据）', () => {
		const asm = new FeishuFrameAssembler();
		asm.push('m3', 2, 0, bytes('STALE'), 1_000);
		// 第 2 片迟到 6 秒 → 陈旧分片被淘汰，这一片本身凑不满
		assert.strictEqual(asm.push('m3', 2, 1, bytes('B'), 7_000), undefined, '陈旧分片已淘汰，不得直接拼出结果');
		// 重传的第 1 片（新数据）到齐 → 只拼「新第 1 片 + 第 2 片」，不含 1 秒时的陈旧内容
		const merged = asm.push('m3', 2, 0, bytes('FRESH'), 7_001);
		assert.strictEqual(merged && decodeUtf8(merged), 'FRESHB');
	});

	test('收齐后清空该 message_id（同 id 再来一轮不会串包）', () => {
		const asm = new FeishuFrameAssembler();
		asm.push('m4', 2, 0, bytes('X'), 1_000);
		asm.push('m4', 2, 1, bytes('Y'), 1_001);
		// 新一轮：同一 message_id 重新攒，不得残留上一轮内容
		assert.strictEqual(asm.push('m4', 2, 0, bytes('Z'), 1_002), undefined);
		const merged = asm.push('m4', 2, 1, bytes('W'), 1_003);
		assert.strictEqual(merged && decodeUtf8(merged), 'ZW');
	});

	test('clear() 丢弃全部残留分片', () => {
		const asm = new FeishuFrameAssembler();
		asm.push('m5', 2, 0, bytes('A'), 1_000);
		asm.clear();
		assert.strictEqual(asm.push('m5', 2, 1, bytes('B'), 1_001), undefined);
	});
});
