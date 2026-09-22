/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 飞书长连接「真连」联测（D-07 的端到端收口，无需真实凭证）──
//
// 单元测试只能证明「编解码正确」与「接线正确」，证明不了「真的连得上」。
// 本文件起一个 **进程内 WebSocket 服务端**（自己实现 RFC6455 握手 + 帧编解码，
// 不依赖任何 npm 包），让生产代码 `FeishuPlatform` 走完整链路：
//
//   FeishuPlatform
//     └─ fetch POST /callback/ws/endpoint   （本地 HTTP 服务应答）
//        → wss 地址 → 真 WebSocket 握手（undici）
//        → 二进制 pbbp2 帧：client ping ⇄ server pong
//        → server 推 event → 平台路由给 handler → 平台回执（code=200 + biz_rt）
//
// 服务端按真实飞书行为模拟：ping 回 pong（可带新 ClientConfig）、事件走 DATA 帧、
// 分片 sum/seq、断连后客户端按 ClientConfig 重连。
// 由此把「连接能不能建立、心跳对不对、事件到没到、回执回没回」全部钉死在真实 socket 上。

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
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
import { FeishuPlatform } from '../../browser/bridge/platforms/feishu.js';

// ─── 进程内 WS 服务端（RFC6455 最小实现，仅够本测试用）───────────────────────────

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 服务端→客户端帧（不掩码）。 */
function wsWriteFrame(socket: Socket, bytes: Uint8Array, opcode = 0x2): void {
	const len = bytes.length;
	const head: number[] = [0x80 | opcode];
	if (len < 126) {
		head.push(len);
	} else if (len < 65536) {
		head.push(126, (len >> 8) & 0xff, len & 0xff);
	} else {
		const b = Buffer.alloc(10);
		b[0] = 0x80 | opcode;
		b[1] = 127;
		b.writeBigUInt64BE(BigInt(len), 2);
		socket.write(Buffer.concat([b, Buffer.from(bytes)]));
		return;
	}
	socket.write(Buffer.concat([Buffer.from(head), Buffer.from(bytes)]));
}

/** 客户端→服务端帧流解析（客户端帧按 RFC 必须掩码；支持 126/127 扩展长度）。 */
function createFramePump(onFrame: (opcode: number, payload: Buffer) => void): (chunk: Buffer) => void {
	let buf = Buffer.alloc(0);
	return (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			if (buf.length < 2) { return; }
			const opcode = buf[0] & 0x0f;
			const masked = (buf[1] & 0x80) !== 0;
			let len = buf[1] & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (buf.length < 4) { return; }
				len = buf.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (buf.length < 10) { return; }
				len = Number(buf.readBigUInt64BE(2));
				offset = 10;
			}
			let mask: Buffer | undefined;
			if (masked) {
				if (buf.length < offset + 4) { return; }
				mask = buf.subarray(offset, offset + 4);
				offset += 4;
			}
			if (buf.length < offset + len) { return; }
			let payload = buf.subarray(offset, offset + len);
			if (mask) {
				const unmasked = Buffer.alloc(len);
				for (let i = 0; i < len; i++) { unmasked[i] = payload[i] ^ mask[i & 3]; }
				payload = unmasked;
			}
			buf = buf.subarray(offset + len);
			onFrame(opcode, Buffer.from(payload));
		}
	};
}

interface LiveServerEvents {
	/** 收到平台 ping 帧后调用（可推事件 / 回 pong） */
	onPing?: (send: (bytes: Uint8Array) => void) => void;
	/** 收到平台回执帧后调用 */
	onAck?: (frame: FeishuFrame) => void;
	/** 连接刚建立后调用 */
	onOpen?: (send: (bytes: Uint8Array) => void) => void;
	/** 为 true 时拒绝 WS 升级（直接断 socket），用于握手失败路径 */
	refuseUpgrade?: boolean;
}

interface LiveServer {
	readonly httpBase: string;
	readonly httpRequests: Array<{ method: string; url: string; body: string }>;
	/** 平台发来的已解码帧（二进制） */
	readonly frames: FeishuFrame[];
	/** 已完成握手的连接数（重连验证用） */
	connectionCount: number;
	push(bytes: Uint8Array): void;
	closeCurrent(): void;
	close(): Promise<void>;
}

/** 启动本地 HTTP + WS 服务端：POST /callback/ws/endpoint 应答换地址，/ws 升级。 */
async function startLiveServer(events: LiveServerEvents = {}, clientConfig: Record<string, number> = {}): Promise<LiveServer> {
	const httpRequests: LiveServer['httpRequests'] = [];
	const frames: FeishuFrame[] = [];
	let current: Socket | undefined;
	const state: { connectionCount: number } = { connectionCount: 0 };

	const server = http.createServer((req, res) => {
		if (req.method === 'POST' && req.url === '/callback/ws/endpoint') {
			let body = '';
			req.on('data', c => { body += c; });
			req.on('end', () => {
				httpRequests.push({ method: req.method!, url: req.url!, body });
				const port = (server.address() as AddressInfo).port;
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({
					code: 0,
					msg: 'success',
					data: {
						URL: `ws://127.0.0.1:${port}/ws?device_id=d1&service_id=7`,
						ClientConfig: { PingInterval: 120, ReconnectCount: 3, ReconnectInterval: 1, ReconnectNonce: 1, ...clientConfig },
					},
				}));
			});
			return;
		}
		res.statusCode = 404;
		res.end('404 page not found');
	});

	server.on('upgrade', (req, socket) => {
		if (!req.url?.startsWith('/ws') || events.refuseUpgrade) {
			// 拒绝升级：模拟凭证/权限/未开启长连接等握手失败场景
			socket.destroy();
			return;
		}
		state.connectionCount++;
		current = socket as Socket;
		const key = req.headers['sec-websocket-key'];
		if (!key) {
			socket.destroy();
			return;
		}
		const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		const send = (bytes: Uint8Array) => wsWriteFrame(socket as Socket, bytes);
		const pump = createFramePump((opcode, payload) => {
			if (opcode === 0x8) { // close
				wsWriteFrame(socket as Socket, new Uint8Array(0), 0x8);
				socket.destroy();
				return;
			}
			if (opcode === 0x9) { // ping（WS 协议层心跳，非 pbbp2 帧）
				wsWriteFrame(socket as Socket, payload, 0xA);
				return;
			}
			if (opcode !== 0x2) { return; }
			let frame: FeishuFrame;
			try {
				frame = decodeFeishuFrame(new Uint8Array(payload));
			} catch {
				return; // 非 pbbp2 帧，忽略
			}
			frames.push(frame);
			const type = frameHeader(frame, FRAME_HEADER.TYPE);
			if (type === MESSAGE_TYPE.PING) {
				// 官方行为：ping 回 pong（可带更新后的 ClientConfig）
				send(encodeFeishuFrame({
					service: 1,
					method: FRAME_METHOD.CONTROL,
					headers: [{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.PONG }],
				}));
				events.onPing?.(send);
			} else if (type === MESSAGE_TYPE.EVENT || frameHeader(frame, FRAME_HEADER.BIZ_RT) !== undefined) {
				// 平台回执：payload 换成 {"code":200} 的复用帧
				events.onAck?.(frame);
			}
		});
		socket.on('data', pump);
		socket.on('error', () => { /* 断连是测试的正常一部分 */ });
		socket.on('close', () => { if (current === socket) { current = undefined; } });
		events.onOpen?.(send);
	});

	await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	return {
		httpBase: `http://127.0.0.1:${port}`,
		httpRequests,
		frames,
		get connectionCount() { return state.connectionCount; },
		set connectionCount(v: number) { state.connectionCount = v; },
		push(bytes) { if (current) { wsWriteFrame(current, bytes); } },
		closeCurrent() { if (current) { current.destroy(); current = undefined; } },
		close() { return new Promise<void>(r => { server.close(() => r()); if (current) { current.destroy(); } }); },
	};
}

/** 等待条件满足（轮询，超时抛错，让失败用例快死而不是拖到 mocha timeout）。 */
async function until(cond: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`等待超时：${what}`);
		}
		await new Promise(r => setTimeout(r, 20));
	}
}

/** 事件帧（服务端视角：构造推给平台的 DATA 帧）。 */
function serverEventFrame(text: string, opts: { messageId?: string } = {}): Uint8Array {
	return encodeFeishuFrame({
		seqId: '101',
		logId: '202',
		service: 1,
		method: FRAME_METHOD.DATA,
		headers: [
			{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.EVENT },
			{ key: FRAME_HEADER.MESSAGE_ID, value: opts.messageId ?? 'om_live_1' },
			{ key: FRAME_HEADER.TRACE_ID, value: 'tr_live' },
			{ key: FRAME_HEADER.SUM, value: '1' },
			{ key: FRAME_HEADER.SEQ, value: '0' },
		],
		payloadEncoding: 'json',
		payloadType: MESSAGE_TYPE.EVENT,
		payload: encodeUtf8(JSON.stringify({
			schema: '2.0',
			header: { event_type: 'im.message.receive_v1', message_id: opts.messageId ?? 'om_live_1' },
			event: {
				message: {
					message_id: opts.messageId ?? 'om_live_1',
					chat_id: 'oc_live',
					message_type: 'text',
					content: JSON.stringify({ text }),
				},
				sender: { sender_id: { open_id: 'ou_live' }, sender_type: 'user' },
			},
		})),
	});
}

// ══════════════════════════════════════════════════════════════════════════

describe('FeishuPlatform · 长连接「真连」联测（进程内 WS 服务端）', () => {
	let live: LiveServer;
	const platforms: FeishuPlatform[] = [];

	afterEach(async () => {
		for (const p of platforms.splice(0)) {
			p.stop();
		}
		if (live) {
			await live.close();
		}
	});

	it('完整闭环：换地址 → 握手 → ping → 事件下行路由 → 回执上行', async () => {
		// 服务端行为：收到 ping 后推一条 v2 事件
		let pushed = false;
		live = await startLiveServer({
			onPing(send) {
				if (!pushed) {
					pushed = true;
					send(serverEventFrame('live hello'));
				}
			},
		});

		const p = new FeishuPlatform({ appId: 'cli_live', appSecret: 'sec_live', useWs: true, baseUrl: `${live.httpBase}/open-apis` });
		platforms.push(p);
		const got: Array<{ content: string; messageId: string; userId: string }> = [];
		p.start(m => got.push(m));

		// ① 换地址请求体必须是官方 PascalCase
		await until(() => live.httpRequests.length > 0, '平台发起换地址请求');
		assert.equal(live.httpRequests[0].method, 'POST');
		assert.equal(live.httpRequests[0].url, '/callback/ws/endpoint');
		assert.deepEqual(JSON.parse(live.httpRequests[0].body), { AppID: 'cli_live', AppSecret: 'sec_live' });

		// ② 平台按官方协议发 ping（service 来自 URL 的 service_id）
		await until(() => live.frames.length > 0, '收到平台 ping 帧');
		const ping = live.frames.find(f => frameHeader(f, FRAME_HEADER.TYPE) === MESSAGE_TYPE.PING);
		assert.ok(ping, '应有一条 type=ping 帧');
		assert.equal(ping!.service, 7, 'ping 的 service 必须是 service_id');
		assert.equal(ping!.method, FRAME_METHOD.CONTROL);

		// ③ 服务端推事件 → 平台路由给 handler（v2 官方事件名 im.message.receive_v1）
		await until(() => got.length > 0, '事件被路由到 handler');
		assert.equal(got[0].content, 'live hello');
		assert.equal(got[0].messageId, 'om_live_1');
		assert.equal(got[0].userId, 'ou_live');

		// ④ 平台回执：复用原帧 + payload={"code":200} + biz_rt
		await until(() => live.frames.some(f => {
			try { return JSON.parse(decodeUtf8(f.payload)).code === 200; } catch { return false; }
		}), '收到平台回执帧');
		const ack = live.frames.find(f => {
			try { return JSON.parse(decodeUtf8(f.payload)).code === 200; } catch { return false; }
		})!;
		assert.equal(ack.seqId, '101', '回执应带回原帧 SeqID');
		assert.equal(ack.logId, '202', '回执应带回原帧 LogID');
		assert.ok(frameHeader(ack, FRAME_HEADER.BIZ_RT) !== undefined, '回执应附 biz_rt');
		assert.equal(frameHeader(ack, FRAME_HEADER.MESSAGE_ID), 'om_live_1');

		// ⑤ 平台状态：无错误、有帧时间戳
		assert.equal(p.lastError, undefined);
		assert.equal(typeof p.lastFrameAt, 'number');
	});

	it('断连后按 ClientConfig 自动重连（真实 socket 断线）', async () => {
		live = await startLiveServer({}, { ReconnectInterval: 0.05, ReconnectNonce: 0.05, ReconnectCount: 3 });
		const p = new FeishuPlatform({ appId: 'cli', appSecret: 'sec', useWs: true, baseUrl: `${live.httpBase}/open-apis` });
		platforms.push(p);
		p.start(() => { /* noop */ });

		await until(() => live.connectionCount >= 1, '首次建连');
		await until(() => live.frames.some(f => frameHeader(f, FRAME_HEADER.TYPE) === MESSAGE_TYPE.PING), '首次 ping');

		// 服务端主动断开 → 平台应按 ClientConfig 重连
		live.closeCurrent();
		// 第二条连接建立且收到第二条 ping ⇒ 重连后链路是活的（lastError 随之清空）
		await until(() => live.connectionCount >= 2, '重连建立第 2 条连接', 5_000);
		await until(
			() => live.frames.filter(f => frameHeader(f, FRAME_HEADER.TYPE) === MESSAGE_TYPE.PING).length >= 2,
			'重连后的第二条 ping',
			5_000,
		);
		assert.equal(p.lastError, undefined, '重连成功后 lastError 应清空');
	});

	it('握手被拒（服务端不升级）→ 平台给出可诊断的「握手失败」提示，不静默', async () => {
		live = await startLiveServer({ refuseUpgrade: true }, { ReconnectInterval: 10, ReconnectNonce: 0.05, ReconnectCount: 0 });
		const logs: string[] = [];
		const p = new FeishuPlatform({ appId: 'cli', appSecret: 'sec', useWs: true, baseUrl: `${live.httpBase}/open-apis`, log: m => logs.push(m) });
		platforms.push(p);
		p.start(() => { /* noop */ });

		// onerror 先置 lastError，「不再重连」要等 onclose 里的 _scheduleReconnect —— 两条都等
		await until(() => p.lastError !== undefined, '平台记录握手失败', 5_000);
		assert.ok(p.lastError!.includes('握手失败'), `应为握手失败提示：${p.lastError}`);
		await until(() => logs.some(l => l.includes('已达上限')), '重连上限提示', 5_000);
		assert.ok(logs.some(l => l.includes('握手失败')), logs.join(' | '));
	});
});
