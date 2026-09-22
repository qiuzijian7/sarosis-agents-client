/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书长连接（WebSocket）协议编解码 —— `pbbp2`。
 *
 * ## 为什么需要这个文件（2026-09-22 D-07 结案）
 *
 * 此前 `feishu.ts` 用的是 `POST /event/v1/outbound_event/subscribe`，实测返回
 * `404 page not found` —— **该端点是臆测出来的，飞书并不存在**。官方长连接协议是：
 * 先 `POST /callback/ws/endpoint` 换 wss 地址，再用 **protobuf 二进制帧**（不是 JSON）通信。
 *
 * ## 权威来源（逐条对齐，勿凭记忆改）
 *
 * | 项 | 权威定义 |
 * |---|---|
 * | 端点 | `lark_oapi/ws/const.py` → `GEN_ENDPOINT_URI = "/callback/ws/endpoint"` |
 * | 请求体 | `lark_oapi/ws/client.py#_get_conn_url` → `{"AppID": ..., "AppSecret": ...}` |
 * | 响应 | `lark_oapi/ws/model.py` → `EndpointResp{code,msg,data:Endpoint{URL,ClientConfig}}` |
 * | 枚举 | `lark_oapi/ws/enum.py` → `FrameType{CONTROL=0, DATA=1}`；`MessageType{event,card,ping,pong}` |
 * | 帧结构 | `lark_oapi/ws/pb/pbbp2_pb2.py`（字段号见下，proto2，1–4 为 `required`） |
 * | 心跳 | `client.py#_new_ping_frame/_ping_loop` |
 * | 回执 | `client.py#_handle_data_frame` —— **没有 ack 帧类型**，复用原帧回写 |
 *
 * ```
 * message Header { required string key = 1; required string value = 2; }
 * message Frame {
 *   required uint64 SeqID  = 1;
 *   required uint64 LogID  = 2;
 *   required int32  service = 3;   // ping 用 URL 查询串里的 service_id
 *   required int32  method  = 4;   // FrameType: 0=CONTROL 1=DATA
 *   repeated Header headers = 5;   // type/message_id/sum/seq/trace_id/biz_rt
 *   optional string payload_encoding = 6;
 *   optional string payload_type     = 7;
 *   optional bytes  payload          = 8;   // event 帧里是 UTF-8 JSON
 *   optional string LogIDNew         = 9;
 * }
 * ```
 *
 * ## 设计约束
 *
 * - **纯函数 + 无宿主依赖**：只用 `TextEncoder/TextDecoder/Uint8Array`（Chromium 与 Node 都有），
 *   故可在纯 node 测试里直接跑；不在本文件里发网络请求，也不碰 DOM。
 * - **无损**：`SeqID`/`LogID` 是 uint64，用**十进制字符串**承载（避免 JS number 丢精度），
 *   重编码回执时按 bigint 还原；未识别字段以原始字节保存并原样回写（不丢字段）。
 * - **proto2 `required` 语义**：字段 1–4 即使值为 0 也必须写出（对齐 `SerializeToString()`）。
 */

// ─── 常量（全部来自官方 SDK，见文件头来源表）───────────────────────────────

/** 换取 wss 地址的端点路径（`const.py#GEN_ENDPOINT_URI`）。 */
export const FEISHU_WS_ENDPOINT_PATH = "/callback/ws/endpoint";

/**
 * 由 **OpenAPI 基址**推导长连接换地址的基址。
 *
 * ★★ 2026-09-22 实测（D-07 最后一环）：**该端点在域名根下，不在 `/open-apis` 下**。
 *   用无效凭证探测真实网络（可复现，不涉及任何敏感信息）：
 * ```
 * POST https://open.feishu.cn/callback/ws/endpoint
 *   → 200 {"code":1000040346,"msg":"app_id is invalid","data":{"URL":""}}     ← 端点存在
 * POST https://open.feishu.cn/open-apis/callback/ws/endpoint
 *   → 404 "404 page not found"                                              ← 错误基址（本次线上故障）
 * ```
 *   官方 SDK 同理：`url = domain + GEN_ENDPOINT_URI`，其中 domain = `https://open.feishu.cn`。
 *
 * ⚠ 注意与 REST 的区别：`/auth/v3/...`、`/im/v1/...` **必须**带 `/open-apis`，
 *   只有长连接换地址端点在根下 —— 故不能把 `_base` 直接拿来拼这个路径。
 */
export function resolveWsEndpointBase(apiBase: string): string {
	const trimmed = apiBase.replace(/\/+$/u, "");
	const stripped = trimmed.replace(/\/open-apis$/u, "");
	// 兜底：万一传入的就是空串/纯 "/open-apis"，至少不要让基址变成空
	return stripped !== "" ? stripped : trimmed;
}

/** `Frame.method` 取值（`enum.py#FrameType`）。 */
export const FRAME_METHOD = { CONTROL: 0, DATA: 1 } as const;

/** `headers.type` 取值（`enum.py#MessageType`）。 */
export const MESSAGE_TYPE = { EVENT: "event", CARD: "card", PING: "ping", PONG: "pong" } as const;

/** 帧头 key（`const.py#HEADER_*`）。 */
export const FRAME_HEADER = {
	TYPE: "type",
	MESSAGE_ID: "message_id",
	SUM: "sum",
	SEQ: "seq",
	TRACE_ID: "trace_id",
	BIZ_RT: "biz_rt",
} as const;

/**
 * 长连接服务端下发的客户端配置（`model.py#ClientConfig`）。
 * 单位均为**秒**。
 */
export interface FeishuWsClientConfig {
	/** 心跳间隔（ping 间隔） */
	readonly pingIntervalSec: number;
	/** 最大重连次数；负数为无限重连 */
	readonly reconnectCount: number;
	/** 重连间隔 */
	readonly reconnectIntervalSec: number;
	/** 首次重连随机抖动上限（避免惊群） */
	readonly reconnectNonceSec: number;
}

/** SDK 默认值（`client.go#NewClient`：nonce=30、count=-1、interval=120s、ping=120s）。 */
export const FEISHU_WS_CONFIG_DEFAULTS: FeishuWsClientConfig = {
	pingIntervalSec: 120,
	reconnectCount: -1,
	reconnectIntervalSec: 120,
	reconnectNonceSec: 30,
};

/** 分片缓存 TTL（`client.py#_combine` 用 5 秒）。 */
export const FRAME_ASSEMBLY_TTL_MS = 5_000;

// ─── 帧结构 ────────────────────────────────────────────────────────────────

export interface FeishuFrameHeader {
	readonly key: string;
	readonly value: string;
}

export interface FeishuFrame {
	/** uint64 → 十进制字符串（无损） */
	readonly seqId: string;
	/** uint64 → 十进制字符串（无损） */
	readonly logId: string;
	readonly service: number;
	/** `FRAME_METHOD` */
	readonly method: number;
	readonly headers: readonly FeishuFrameHeader[];
	readonly payloadEncoding: string;
	readonly payloadType: string;
	readonly payload: Uint8Array;
	/** 未识别字段的原始字节（重编码时原样回写） */
	readonly unknownFields: readonly Uint8Array[];
	/** 可选字段 9 */
	readonly logIdNew?: string;
}

const EMPTY = new Uint8Array(0);

/** 归一化：显式 `undefined` 与缺省同义（否则 `{payload: undefined}` 会覆盖默认值）。 */
function makeFrame(patch: Partial<FeishuFrame>): FeishuFrame {
	return {
		seqId: patch.seqId ?? "0",
		logId: patch.logId ?? "0",
		service: patch.service ?? 0,
		method: patch.method ?? FRAME_METHOD.DATA,
		headers: patch.headers ?? [],
		payloadEncoding: patch.payloadEncoding ?? "",
		payloadType: patch.payloadType ?? "",
		payload: patch.payload ?? EMPTY,
		unknownFields: patch.unknownFields ?? [],
		...(patch.logIdNew === undefined ? {} : { logIdNew: patch.logIdNew }),
	};
}

/** 取帧头值（找不到返回 undefined，不抛错——与 SDK 抛 `HeaderNotFoundException` 不同，容错优先）。 */
export function frameHeader(frame: FeishuFrame, key: string): string | undefined {
	const hit = frame.headers.find(h => h.key === key);
	return hit?.value;
}

/** 从 wss 地址的查询串取 `service_id`（ping 帧的 `service` 字段，`client.py#_connect`）。 */
export function extractServiceId(wsUrl: string, fallback = 1): number {
	try {
		const questionMark = wsUrl.indexOf("?");
		if (questionMark < 0) {
			return fallback;
		}
		const raw = new URLSearchParams(wsUrl.slice(questionMark + 1)).get("service_id");
		const value = Number(raw);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	} catch {
		return fallback;
	}
}

// ─── protobuf wire 读写（足够覆盖 pbbp2）────────────────────────────────────

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

function readVarint(bytes: Uint8Array, pos: number): { value: bigint; pos: number } {
	let result = 0n;
	let shift = 0n;
	for (;;) {
		if (pos >= bytes.length) {
			throw new Error("[Feishu] protobuf 帧截断：varint 越界");
		}
		const byte = bytes[pos++];
		result |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) {
			return { value: result, pos };
		}
		shift += 7n;
		if (shift > 63n) {
			throw new Error("[Feishu] protobuf 帧非法：varint 超过 64 位");
		}
	}
}

function writeVarint(out: number[], value: bigint): void {
	let v = value;
	while (v > 0x7fn) {
		out.push(Number(v & 0x7fn) | 0x80);
		v >>= 7n;
	}
	out.push(Number(v));
}

function writeVarintField(out: number[], fieldNo: number, value: bigint): void {
	writeVarint(out, BigInt(fieldNo * 8 + WIRE_VARINT));
	writeVarint(out, value);
}

function writeBytesField(out: number[], fieldNo: number, bytes: Uint8Array): void {
	writeVarint(out, BigInt(fieldNo * 8 + WIRE_LENGTH));
	writeVarint(out, BigInt(bytes.length));
	for (const b of bytes) {
		out.push(b);
	}
}

/** int32 → 无符号 64 位（proto2 对负数按符号扩展的 10 字节 varint 编码）。 */
function int32ToVarint(value: number): bigint {
	return BigInt.asUintN(64, BigInt(Math.trunc(value)));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export function encodeUtf8(text: string): Uint8Array {
	return textEncoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
	return textDecoder.decode(bytes);
}

// ─── Header ────────────────────────────────────────────────────────────────

function encodeHeader(header: FeishuFrameHeader): Uint8Array {
	const out: number[] = [];
	writeBytesField(out, 1, encodeUtf8(header.key));
	writeBytesField(out, 2, encodeUtf8(header.value));
	return new Uint8Array(out);
}

function decodeHeader(bytes: Uint8Array): FeishuFrameHeader {
	let key = "";
	let value = "";
	let pos = 0;
	while (pos < bytes.length) {
		const tag = readVarint(bytes, pos);
		pos = tag.pos;
		const fieldNo = Number(tag.value >> 3n);
		const wire = Number(tag.value & 7n);
		if (wire !== WIRE_LENGTH) {
			pos = skipField(bytes, pos, wire, fieldNo);
			continue;
		}
		const len = readVarint(bytes, pos);
		const end = len.pos + Number(len.value);
		const chunk = bytes.subarray(len.pos, end);
		pos = end;
		if (fieldNo === 1) {
			key = decodeUtf8(chunk);
		} else if (fieldNo === 2) {
			value = decodeUtf8(chunk);
		}
	}
	return { key, value };
}

function skipField(bytes: Uint8Array, pos: number, wire: number, fieldNo: number): number {
	switch (wire) {
		case WIRE_VARINT:
			return readVarint(bytes, pos).pos;
		case WIRE_FIXED64:
			return pos + 8;
		case WIRE_LENGTH: {
			const len = readVarint(bytes, pos);
			return len.pos + Number(len.value);
		}
		case WIRE_FIXED32:
			return pos + 4;
		default:
			throw new Error(`[Feishu] 不支持的 protobuf wire type ${wire}（字段 ${fieldNo}）`);
	}
}

// ─── Frame 编解码 ──────────────────────────────────────────────────────────

/** 解码一条 pbbp2 `Frame`。未识别字段原样保留在 `unknownFields`。 */
export function decodeFeishuFrame(bytes: Uint8Array): FeishuFrame {
	const headers: FeishuFrameHeader[] = [];
	const unknownFields: Uint8Array[] = [];
	let seqId = "0";
	let logId = "0";
	let logIdNew: string | undefined;
	let service = 0;
	let method = 0;
	let payloadEncoding = "";
	let payloadType = "";
	let payload: Uint8Array = EMPTY;

	let pos = 0;
	while (pos < bytes.length) {
		const start = pos;
		const tag = readVarint(bytes, pos);
		pos = tag.pos;
		const fieldNo = Number(tag.value >> 3n);
		const wire = Number(tag.value & 7n);

		if (wire === WIRE_LENGTH) {
			const len = readVarint(bytes, pos);
			const end = len.pos + Number(len.value);
			if (end > bytes.length) {
				throw new Error("[Feishu] protobuf 帧截断：length-delimited 越界");
			}
			const chunk = bytes.subarray(len.pos, end);
			pos = end;
			switch (fieldNo) {
				case 5: headers.push(decodeHeader(chunk)); break;
				case 6: payloadEncoding = decodeUtf8(chunk); break;
				case 7: payloadType = decodeUtf8(chunk); break;
				// payload 必须拷贝：底层 buffer 可能被复用
				case 8: payload = chunk.slice(); break;
				case 9: logIdNew = decodeUtf8(chunk); break;
				default: unknownFields.push(bytes.subarray(start, pos)); break;
			}
			continue;
		}

		if (wire === WIRE_VARINT) {
			const v = readVarint(bytes, pos);
			pos = v.pos;
			switch (fieldNo) {
				case 1: seqId = v.value.toString(); break;
				case 2: logId = v.value.toString(); break;
				case 3: service = Number(BigInt.asIntN(32, v.value)); break;
				case 4: method = Number(BigInt.asIntN(32, v.value)); break;
				default: unknownFields.push(bytes.subarray(start, pos)); break;
			}
			continue;
		}

		pos = skipField(bytes, pos, wire, fieldNo);
		unknownFields.push(bytes.subarray(start, pos));
	}

	return { seqId, logId, service, method, headers, payloadEncoding, payloadType, payload, unknownFields, logIdNew };
}

/**
 * 编码一条 pbbp2 `Frame`。
 * ★ 字段 1–4 为 proto2 `required`，即使值为 0 也会写出（对齐官方 `SerializeToString()`）。
 */
export function encodeFeishuFrame(input: Partial<FeishuFrame>): Uint8Array {
	const frame = makeFrame(input);
	const out: number[] = [];
	writeVarintField(out, 1, BigInt(frame.seqId || "0"));
	writeVarintField(out, 2, BigInt(frame.logId || "0"));
	writeVarintField(out, 3, int32ToVarint(frame.service));
	writeVarintField(out, 4, int32ToVarint(frame.method));
	for (const header of frame.headers) {
		writeBytesField(out, 5, encodeHeader(header));
	}
	if (frame.payloadEncoding) {
		writeBytesField(out, 6, encodeUtf8(frame.payloadEncoding));
	}
	if (frame.payloadType) {
		writeBytesField(out, 7, encodeUtf8(frame.payloadType));
	}
	if (frame.payload.length > 0) {
		writeBytesField(out, 8, frame.payload);
	}
	if (frame.logIdNew) {
		writeBytesField(out, 9, encodeUtf8(frame.logIdNew));
	}
	for (const raw of frame.unknownFields) {
		for (const b of raw) {
			out.push(b);
		}
	}
	return new Uint8Array(out);
}

// ─── 客户端出站帧 ──────────────────────────────────────────────────────────

/**
 * 心跳帧（`client.py#_new_ping_frame`）：
 * `{SeqID:0, LogID:0, service:service_id, method:CONTROL, headers:[{type:ping}]}`。
 */
export function buildPingFrame(serviceId: number): Uint8Array {
	return encodeFeishuFrame({
		seqId: "0",
		logId: "0",
		service: serviceId,
		method: FRAME_METHOD.CONTROL,
		headers: [{ key: FRAME_HEADER.TYPE, value: MESSAGE_TYPE.PING }],
	});
}

/**
 * 业务回执帧：**没有独立的 ack 帧类型** —— 官方做法是复用收到的 DATA 帧，
 * 把 `payload` 换成 `{"code":200}`，并追加 `biz_rt`（处理耗时毫秒）头后回写
 * （`client.py#_handle_data_frame`）。失败时用 `{"code":500}`。
 */
export function buildAckFrame(frame: FeishuFrame, elapsedMs: number, ok = true): Uint8Array {
	const headers: FeishuFrameHeader[] = [
		...frame.headers,
		{ key: FRAME_HEADER.BIZ_RT, value: String(Math.max(0, Math.round(elapsedMs))) },
	];
	return encodeFeishuFrame({
		...frame,
		headers,
		payload: encodeUtf8(JSON.stringify({ code: ok ? 200 : 500 })),
	});
}

// ─── 端点响应解析 ──────────────────────────────────────────────────────────

/**
 * 解析 `POST /callback/ws/endpoint` 的响应（`model.py#EndpointResp`）。
 *
 * 容错：字段大小写两种写法都接受（`data.URL` / `data.url`），便于在网关版本差异下存活。
 *
 * @throws 当 `code !== 0`（code=1 system busy、1000040343 internal error、其余为客户端错误）
 *         或缺少 URL 时抛错，错误信息带上 code/msg 便于现场定位。
 */
export function parseWsEndpointResponse(raw: unknown): { url: string; clientConfig: FeishuWsClientConfig } {
	const resp = (raw ?? {}) as {
		code?: number;
		msg?: string;
		data?: { URL?: string; url?: string; ClientConfig?: unknown; clientConfig?: unknown };
	};
	const code = typeof resp.code === "number" ? resp.code : undefined;
	if (code !== undefined && code !== 0) {
		const hint = code === 1 ? "（system busy，稍后重试）"
			: code === 1000040343 ? "（服务端内部错误）"
			: code === 1000040344 ? "（缺少凭证：请检查 App ID / App Secret）"
			: "";
		throw new Error(`[Feishu] 换取长连接地址失败：code=${code} msg=${resp.msg ?? "(无)"}${hint}`);
	}
	const url = resp.data?.URL ?? resp.data?.url;
	if (!url) {
		throw new Error(`[Feishu] 换取长连接地址失败：响应缺少 data.URL（msg=${resp.msg ?? "(无)"}）`);
	}
	return { url, clientConfig: parseClientConfig(resp.data?.ClientConfig ?? resp.data?.clientConfig) };
}

/**
 * 解析服务端下发的 `ClientConfig`。
 *
 * 服务端字段为 PascalCase（`model.py#ClientConfig`：`PingInterval` / `ReconnectCount` /
 * `ReconnectInterval` / `ReconnectNonce`），此处同时容忍 camelCase，非法值回落 SDK 默认值。
 */
export function parseClientConfig(raw: unknown): FeishuWsClientConfig {
	const src = (raw ?? {}) as Record<string, unknown>;
	/** 正数取值（间隔类字段必须 > 0） */
	const positive = (pascal: string, camel: string, fallback: number): number => {
		const value = Number(src[pascal] ?? src[camel]);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	};
	// ReconnectCount 允许 -1（无限重连），不能用 positive()
	const rawCount = Number(src.ReconnectCount ?? src.reconnectCount);
	return {
		pingIntervalSec: positive("PingInterval", "pingIntervalSec", FEISHU_WS_CONFIG_DEFAULTS.pingIntervalSec),
		reconnectCount: Number.isFinite(rawCount) ? Math.trunc(rawCount) : FEISHU_WS_CONFIG_DEFAULTS.reconnectCount,
		reconnectIntervalSec: positive("ReconnectInterval", "reconnectIntervalSec", FEISHU_WS_CONFIG_DEFAULTS.reconnectIntervalSec),
		reconnectNonceSec: positive("ReconnectNonce", "reconnectNonceSec", FEISHU_WS_CONFIG_DEFAULTS.reconnectNonceSec),
	};
}

// ─── 分片重组 ──────────────────────────────────────────────────────────────

/**
 * DATA 帧分片重组（`client.py#_combine`）：`sum > 1` 时按 `message_id` 缓存，
 * 按 `seq`（0 基）归位，齐了才返回完整 payload；缓存 TTL 5 秒。
 */
export class FeishuFrameAssembler {
	private readonly _pending = new Map<string, { parts: Array<Uint8Array | undefined>; at: number }>();

	/** @returns 收齐时返回完整 payload；未收齐返回 undefined。 */
	push(messageId: string, sum: number, seq: number, chunk: Uint8Array, now = Date.now()): Uint8Array | undefined {
		this._evict(now);
		const existing = this._pending.get(messageId);
		if (!existing) {
			const parts: Array<Uint8Array | undefined> = new Array(sum).fill(undefined);
			if (seq >= 0 && seq < sum) {
				parts[seq] = chunk;
			}
			this._pending.set(messageId, { parts, at: now });
			return undefined;
		}
		if (seq >= 0 && seq < existing.parts.length) {
			existing.parts[seq] = chunk;
		}
		existing.at = now;
		if (existing.parts.some(p => p === undefined)) {
			return undefined;
		}
		this._pending.delete(messageId);
		const parts = existing.parts as Uint8Array[];
		const total = parts.reduce((n, p) => n + p.length, 0);
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const p of parts) {
			merged.set(p, offset);
			offset += p.length;
		}
		return merged;
	}

	/** 清空缓存（连接断开时调用，避免残留分片污染下一次连接）。 */
	clear(): void {
		this._pending.clear();
	}

	private _evict(now: number): void {
		for (const [key, entry] of this._pending) {
			if (now - entry.at > FRAME_ASSEMBLY_TTL_MS) {
				this._pending.delete(key);
			}
		}
	}
}
