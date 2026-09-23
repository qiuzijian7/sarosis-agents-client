/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── FeishuPlatform：飞书/Lark 平台适配器（对齐 cc-connect platform/feishu）──
// 出站：REST（tenant_access_token + im/v1/messages create/reply + 交互卡片）。
// 入站：**仅支持事件订阅长连接**（useWs=true）。
//   官方协议：`POST /callback/ws/endpoint` 拿 wss 地址 → 收发 **protobuf 二进制帧**（pbbp2）。
//   编解码全部在 `feishuWsProtocol.ts`（该文件头附权威来源表：端点/帧结构/ping/回执）。
//   ★ 2026-09-22 结案（D-07）：此前用的 `event/v1/outbound_event/subscribe` 是**臆测端点**，
//     实测 `HTTP 404 page not found`；且原实现按 JSON 解析消息，而长连接实际发二进制帧。
//   ★ 2026-09-22 修正（D-04）：此前注释称「需在飞书开放平台配置事件订阅回调指向 BridgeServer」，
//     但渲染进程既无 Node http 也无可被外部访问的回调监听（BridgeServer 只做本地 WS 调试协议
//     subscribe/inbound/ping），webhook 模式实际不存在入口 —— 注释与实现不符，现以长连接为唯一入站路径。
//     若未来要支持 webhook：需补 HTTP 入口 + verificationToken 校验 + encryptKey AES 解密 + challenge 应答。
//
// ★ 2026-09-22 修复（CORS，两轮才对）：**HTTP 必须走主进程出口**，禁止用渲染进程 fetch。
//   实测报错（桌面端 origin 为 `vscode-file://vscode-app`）：
//     Access to fetch at 'https://open.feishu.cn/open-apis/...' from origin 'vscode-file://vscode-app'
//     has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
//   飞书 OpenAPI 不返回 CORS 头 ⇒ 渲染进程直连的 4 个 REST 调用点（换 wss 地址 / 换 token /
//   发消息 / 回复）在桌面端**全部不可用**；单元测试因 stub 了 fetch 而没暴露这个断层。
//
//   ⚠ 注意一个反直觉点：**DI 注入的 `IRequestService` 并不能解决它** ——
//   桌面端注册的是 `NativeRequestService`（workbench/services/request/electron-browser），
//   其 `request()` 最终落到 `base/parts/request/common/requestImpl.ts` 的 `fetch`，
//   仍然在 renderer 网络栈里 ⇒ 照样 `net::ERR_FAILED`。
//   真正的主进程出口是 `browser/mainProcessRequestService.ts`（`VSSAROS_LLM_CHANNEL`
//   的 `httpRequest`），由装配侧 `bridge.contribution.ts` 注入到本类的 `requestService`。
//
//   WebSocket 不受同源策略约束，长连接（wss）仍由渲染进程直连（二进制帧用 arraybuffer）。
//
// 无外部 SDK 依赖：HTTP 走注入的 requestService（应为主进程出口），WS 用渲染进程全局 WebSocket。

import { CancellationToken } from "../../../../../../base/common/cancellation.js";
import { asText, IRequestService } from "../../../../../../platform/request/common/request.js";
import {
	BridgeButton,
	BridgeCard,
	BridgePlatformStatus,
	BridgeReplyCtx,
	IBridgePlatform,
	InboundMessage,
	OutboundType,
} from "../../../common/bridge/bridgeTypes.js";
import {
	FRAME_HEADER,
	FRAME_METHOD,
	FEISHU_WS_CONFIG_DEFAULTS,
	FEISHU_WS_ENDPOINT_PATH,
	FeishuFrame,
	FeishuFrameAssembler,
	FeishuWsClientConfig,
	MESSAGE_TYPE,
	buildAckFrame,
	buildPingFrame,
	decodeFeishuFrame,
	decodeUtf8,
	encodeUtf8,
	extractServiceId,
	frameHeader,
	parseClientConfig,
	parseWsEndpointResponse,
	resolveWsEndpointBase,
} from "./feishuWsProtocol.js";

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

/**
 * 消息事件的 `header.event_type` 取值。
 *
 * ★ 2026-09-22（D-13）：此前只认 `im.message.message_received`（cc-connect 的历史写法），
 * 而飞书 **v2 事件推送的官方事件名是 `im.message.receive_v1`**（官方 SDK `onP2MessageReceiveV1`）
 * ⇒ 真实事件会被静默丢弃（帧解出来了，却被这一行挡掉）。现两种都接受，且未知的消息类事件名会记日志。
 */
const MESSAGE_EVENT_TYPES = new Set(["im.message.receive_v1", "im.message.message_received"]);

export interface FeishuPlatformOpts {
	readonly appId: string;
	readonly appSecret: string;
	readonly allowFrom?: string;
	readonly baseUrl?: string;
	/**
	 * 启用事件订阅长连接（ws）：无需外部 Webhook 回调服务器。
	 * 官方协议：`POST /callback/ws/endpoint` 换取 wss 地址 → protobuf 二进制帧实时推送。
	 */
	readonly useWs?: boolean;
	/**
	 * 日志出口（默认 console.error）。
	 * 装配侧传入 ILogService 包装后，长连接/订阅失败会落到产品日志，而不是静默。
	 */
	readonly log?: (msg: string) => void;
	/**
	 * HTTP 出口（**装配侧必须注入主进程出口**）。
	 *
	 * 应传 `createMainProcessRequestService(mainProcessService)` 的产物
	 * （经 `VSSAROS_LLM_CHANNEL#httpRequest` 在主进程发请求，无 CORS）。
	 * ⚠ 传 DI 注入的 `IRequestService` **没有用**：桌面端它最终就是 renderer 的 `fetch`
	 * （见文件头 CORS 说明），会重现 `net::ERR_FAILED`。
	 * 未注入时本类回退到渲染进程 `fetch` —— 仅供单测与非 Electron 宿主。
	 */
	readonly requestService?: IRequestService;
	/** IRequestService 的 callSite 标记（便于主进程侧归因，默认 'feishuPlatform'）。 */
	readonly callSite?: string;
}

interface FeishuReplyCtx {
	readonly messageId?: string;
	readonly chatId?: string;
}

interface TokenCache {
	token: string;
	expireAt: number; // epoch ms
}

export class FeishuPlatform implements IBridgePlatform {
	readonly id = "feishu";
	readonly name = "Feishu (飞书)";
	readonly allowFrom?: string;

	private readonly _appId: string;
	private readonly _appSecret: string;
	private readonly _base: string;
	/** 长连接换地址基址（= `_base` 去掉 `/open-apis`；该端点在域名根下，见 resolveWsEndpointBase）。 */
	private readonly _wsBase: string;
	private readonly _useWs: boolean;
	private readonly _log: (msg: string) => void;
	private readonly _requestService?: IRequestService;
	private readonly _callSite: string;
	private _handler?: (msg: InboundMessage) => void;
	private _token?: TokenCache;
	private _ws?: any; // WebSocket 长连接
	/** 最近一次长连接失败原因（供 UI/诊断读取；成功后清空）。 */
	private _lastError?: string;
	/** 主动 stop() 期间置位：用于把「主动关闭」与「异常断连」区分开。 */
	private _stopping = false;
	/** 是否已成功 open 过（用于区分「握手失败」与「连接后断开」）。 */
	private _wsOpened = false;
	/** 服务端下发的客户端配置（心跳/重连），默认取 SDK 默认值。 */
	private _clientConfig: FeishuWsClientConfig = FEISHU_WS_CONFIG_DEFAULTS;
	/** ping 帧 `service` 字段：取自 wss 地址查询串的 `service_id`。 */
	private _serviceId = 1;
	/** 心跳定时器。 */
	private _pingTimer?: ReturnType<typeof setInterval>;
	/** 重连定时器与已尝试次数。 */
	private _reconnectTimer?: ReturnType<typeof setTimeout>;
	private _reconnectAttempt = 0;
	/** 当前连接的断线是否已处理（error/close 双事件只生效一次）。 */
	private _linkDownHandled = false;
	/** DATA 帧分片重组缓冲。 */
	private readonly _assembler = new FeishuFrameAssembler();
	/** 最近一次收到帧的时间（诊断用）。 */
	private _lastFrameAt?: number;

	constructor(opts: FeishuPlatformOpts) {
		this._appId = opts.appId;
		this._appSecret = opts.appSecret;
		this.allowFrom = opts.allowFrom;
		this._base = opts.baseUrl ?? FEISHU_BASE;
		this._wsBase = resolveWsEndpointBase(this._base);
		this._useWs = opts.useWs === true;
		this._log = opts.log ?? ((msg: string) => console.error(msg));
		this._requestService = opts.requestService;
		this._callSite = opts.callSite ?? "feishuPlatform";
	}

	/** 最近一次入站长连接失败原因（无失败则为 undefined）。 */
	get lastError(): string | undefined {
		return this._lastError;
	}

	/**
	 * 最近一次收到长连接帧的时间（epoch ms）。
	 * 用于诊断「连接活着但收不到事件」：非 undefined 说明链路在通（至少有 pong）。
	 */
	get lastFrameAt(): number | undefined {
		return this._lastFrameAt;
	}

	/** 当前连接状态（设置页渠道条目展示用）。 */
	getStatus(): BridgePlatformStatus {
		if (!this._useWs) {
			return { state: "disconnected", detail: "未启用长连接（useWs=false，仅出站可用）" };
		}
		if (this._ws && this._wsOpened) {
			const ago = this._lastFrameAt !== undefined
				? `，最近帧 ${Math.max(0, Math.round((Date.now() - this._lastFrameAt) / 1000))}s 前`
				: "（尚未收到帧）";
			return { state: "connected", detail: `长连接已建立（service_id=${this._serviceId}）${ago}` };
		}
		if (this._lastError) {
			return { state: "error", detail: this._lastError };
		}
		if (this._ws && !this._wsOpened) {
			return { state: "connecting", detail: "正在建立长连接…" };
		}
		if (this._reconnectTimer) {
			return { state: "connecting", detail: "等待重连…" };
		}
		return { state: "disconnected", detail: "未连接" };
	}

	// 出站无需在此建立连接。入站仅长连接模式（见文件头注释）。
	start(handler: (msg: InboundMessage) => void): void {
		this._handler = handler;
		this._stopping = false;
		this._reconnectAttempt = 0;
		this._wsOpened = false;
		if (this._useWs) {
			this._connectWs().catch(err => {
				// ★ 不静默：记录结构化原因并上报日志出口（装配侧转发到 ILogService）。
				this._lastError = err instanceof Error ? err.message : String(err);
				this._log(`[Feishu] WS 长连接失败：${this._lastError}`);
				this._scheduleReconnect();
			});
		}
	}

	// ─── 入站：飞书事件订阅长连接（wss，无需外部 Webhook）───

	/**
	 * 建立长连接：先换 wss 地址，再按官方 pbbp2 协议收发二进制帧。
	 *
	 * 权威契约见 `feishuWsProtocol.ts` 文件头（端点 / 帧结构 / ping / 回执）。
	 * 换地址这一步走注入的 HTTP 出口（主进程），**不经 renderer fetch**（否则 CORS）。
	 */
	private async _connectWs(): Promise<void> {
		const WSAny: any = (globalThis as any).WebSocket;
		if (typeof WSAny !== "function") {
			throw new Error("[Feishu] 渲染进程无 WebSocket 全局，无法建立长连接");
		}

		const path = FEISHU_WS_ENDPOINT_PATH;
		// ★ 用 `_wsBase`（域名根）而非 `_base`（含 /open-apis）—— 拼错基址会得到 404 page not found
		const url = `${this._wsBase}${path}`;
		// 请求体字段名为官方 PascalCase（AppID / AppSecret），不可改成 snake_case
		const { status, json } = await this._postJson<{ code?: number; msg?: string; data?: unknown }>(
			url,
			{ AppID: this._appId, AppSecret: this._appSecret },
			{ locale: "zh" },
		);
		if (status < 200 || status >= 300) {
			throw new Error(`[Feishu] 换取长连接地址失败：HTTP ${status} ${url}`);
		}
		const { url: wsUrl, clientConfig } = parseWsEndpointResponse(json);

		const ws = new WSAny(wsUrl);
		// 帧是 protobuf 二进制；必须显式声明 arraybuffer，否则浏览器给 Blob（无法同步解析）
		ws.binaryType = "arraybuffer";
		this._ws = ws;
		this._linkDownHandled = false;
		this._serviceId = extractServiceId(wsUrl);
		this._clientConfig = clientConfig;
		this._assembler.clear();
		this._lastError = undefined;

		ws.onopen = () => {
			this._lastError = undefined;
			this._wsOpened = true;
			// 连接成功即清零重连计数（下一次断连从头抖动）
			this._reconnectAttempt = 0;
			this._log(`[Feishu] WS 长连接已建立（service_id=${this._serviceId}，心跳 ${clientConfig.pingIntervalSec}s）`);
			this._startPing();
		};
		ws.onmessage = (ev: any) => this._handleWsMessage(ev?.data);
		ws.onerror = () => {
			// 浏览器 WebSocket 拿不到握手响应头（官方 SDK 会读 handshake-status / handshake-msg
			// 区分 403/514 权限问题），这里只能给出可能性提示。
			if (!this._wsOpened) {
				this._lastError = "长连接握手失败（请确认应用已开启长连接、事件已勾选、App 凭证与权限正确）";
				this._log(`[Feishu] ${this._lastError}`);
			}
			// ★ undici 在握手失败时只发 error、不发 close（联测 feishuWsLive 实测）——
			//   若只在 onclose 里重连，一次握手失败就会让渠道永久死链。
			this._linkDown("握手失败（onerror）");
		};
		ws.onclose = () => this._linkDown(this._wsOpened ? "长连接已断开（onclose）" : "握手失败（onclose，未能 open）");
	}

	/**
	 * 统一处理链路断开（error 或 close，每条连接只生效一次）。
	 *
	 * 覆盖两种路径：连接建立后断开（onclose）；握手失败（有的实现只发 onerror，
	 * 不发 onclose —— 见上）。断开即安排重连（主动 stop() 除外）。
	 */
	private _linkDown(reason: string): void {
		if (this._linkDownHandled) {
			return;
		}
		this._linkDownHandled = true;
		this._ws = undefined;
		this._stopPing();
		this._assembler.clear();
		if (this._stopping) {
			return;
		}
		if (this._wsOpened) {
			this._noteDisconnect(reason);
		} else {
			this._lastError = this._lastError ?? reason;
			this._log(`[Feishu] ${this._lastError}`);
		}
		this._scheduleReconnect();
	}

	/** 处理一条入站 WS 消息：二进制 protobuf 帧（主路径）+ 纯文本 JSON（兼容兜底）。 */
	private _handleWsMessage(data: unknown): void {
		if (typeof data === "string") {
			// 兼容兜底：理论上长连接只发二进制帧；若网关发了 JSON 文本，按 webhook 事件处理
			try {
				// 文本进文本出：回包保持同种帧型，避免对端按二进制解析失败
				this._dispatchJsonEvent(JSON.parse(data), true);
			} catch {
				this._log("[Feishu] WS 收到无法解析的文本帧，已忽略");
			}
			return;
		}

		let bytes: Uint8Array;
		if (data instanceof ArrayBuffer) {
			bytes = new Uint8Array(data);
		} else if (ArrayBuffer.isView(data)) {
			bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		} else {
			this._log("[Feishu] WS 收到未知类型帧（非二进制/文本），已忽略");
			return;
		}

		let frame;
		try {
			frame = decodeFeishuFrame(bytes);
		} catch (err) {
			this._log(`[Feishu] 帧解码失败：${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this._handleFrame(frame);
	}

	private _handleFrame(frame: FeishuFrame): void {
		const type = frameHeader(frame, FRAME_HEADER.TYPE);
		this._lastFrameAt = Date.now();

		if (frame.method === FRAME_METHOD.CONTROL) {
			// CONTROL：服务端心跳回包（可能携带更新后的 ClientConfig）
			if (type === MESSAGE_TYPE.PONG) {
				if (frame.payload.length > 0) {
					this._clientConfig = parseClientConfig(JSON.parse(decodeUtf8(frame.payload)));
					this._log(`[Feishu] WS 心跳配置已更新（心跳 ${this._clientConfig.pingIntervalSec}s）`);
				}
			}
			return;
		}
		if (frame.method !== FRAME_METHOD.DATA) {
			return;
		}

		// DATA：分片重组（sum > 1）→ 事件处理 → 回执
		const messageId = frameHeader(frame, FRAME_HEADER.MESSAGE_ID) ?? "";
		const sum = Number(frameHeader(frame, FRAME_HEADER.SUM) ?? "1");
		const seq = Number(frameHeader(frame, FRAME_HEADER.SEQ) ?? "0");
		let payload = frame.payload;
		if (Number.isFinite(sum) && sum > 1) {
			const merged = this._assembler.push(messageId, sum, Number.isFinite(seq) ? seq : 0, payload);
			if (!merged) {
				return; // 未收齐
			}
			payload = merged;
		}

		const started = Date.now();
		let ok = true;
		try {
			if (type === MESSAGE_TYPE.EVENT) {
				this._dispatchJsonEvent(JSON.parse(decodeUtf8(payload)));
			} else if (type === MESSAGE_TYPE.CARD) {
				this._log("[Feishu] 收到卡片交互帧（card），当前版本未实现处理");
			}
		} catch (err) {
			ok = false;
			this._log(`[Feishu] 事件处理失败：${err instanceof Error ? err.message : String(err)}`);
		}
		this._sendFrame(buildAckFrame(frame, Date.now() - started, ok));
	}

	/**
	 * 事件分发（长连接与 Webhook 共用）：兼容 url_verification 挑战应答。
	 * @param asText 入站为文本帧时回包也用文本（长连接主路径为二进制帧）
	 */
	private _dispatchJsonEvent(payload: unknown, asText = false): void {
		// ★ 观测：事件分发入口打 INFO。此前正常路径无日志，「服务端没推帧」与
		//   「收到但被过滤」在日志里无法分辨（2026-09-23 排查「群里发消息 agent 无反应」）。
		const kind = (payload as { header?: { event_type?: string }; type?: string })?.header?.event_type
			?? (payload as { type?: string })?.type ?? "(unknown)";
		this._log(`[Feishu] WS 收到事件帧：${kind}`);
		const p = payload as { type?: string; challenge?: string; token?: string };
		if (p?.type === "url_verification" && p.challenge) {
			const reply = JSON.stringify({ challenge: p.challenge, token: p.token });
			this._sendFrame(asText ? reply : encodeUtf8(reply));
			return;
		}
		this.handleWebhookEvent(payload);
	}

	/** 出站：二进制帧（主路径）或文本帧（challenge 兜底）。 */
	private _sendFrame(data: Uint8Array | string): void {
		const ws = this._ws;
		if (!ws) {
			return;
		}
		try {
			ws.send(data);
		} catch (err) {
			this._log(`[Feishu] WS 发送失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 按官方语义发心跳：每 PingInterval 秒一条 `type=ping` 的 CONTROL 帧（先发一次）。 */
	private _startPing(): void {
		this._stopPing();
		const intervalMs = Math.max(1_000, this._clientConfig.pingIntervalSec * 1000);
		const tick = () => this._sendFrame(buildPingFrame(this._serviceId));
		tick();
		this._pingTimer = setInterval(tick, intervalMs);
	}

	private _stopPing(): void {
		if (this._pingTimer !== undefined) {
			clearInterval(this._pingTimer);
			this._pingTimer = undefined;
		}
	}

	/**
	 * 按服务端下发的 ClientConfig 重连：首次抖动 0~ReconnectNonce 秒，其后每次间隔
	 * ReconnectInterval 秒；ReconnectCount < 0 表示无限重连（官方默认）。
	 */
	private _scheduleReconnect(): void {
		const cfg = this._clientConfig;
		if (cfg.reconnectCount >= 0 && this._reconnectAttempt >= cfg.reconnectCount) {
			this._log(`[Feishu] WS 重连次数已达上限（${cfg.reconnectCount}），停止重连；重新启用渠道或重启窗口后恢复`);
			return;
		}
		const attempt = this._reconnectAttempt++;
		const delaySec = attempt === 0
			? Math.random() * cfg.reconnectNonceSec
			: cfg.reconnectIntervalSec;
		this._log(`[Feishu] WS 将在 ${delaySec.toFixed(1)}s 后重连（第 ${attempt + 1} 次）`);
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = undefined;
			if (this._stopping) {
				return;
			}
			this._connectWs().catch(err => {
				this._lastError = err instanceof Error ? err.message : String(err);
				this._log(`[Feishu] WS 重连失败：${this._lastError}`);
				this._scheduleReconnect();
			});
		}, delaySec * 1000);
	}

	/**
	 * 记录非主动关闭的断连原因（主动 stop() 不记，避免误报）。
	 * 同时写日志出口 —— 让「渠道静默不可用」变成可诊断事件。
	 */
	private _noteDisconnect(reason: string): void {
		if (this._stopping) {
			return;
		}
		this._lastError = this._lastError ?? reason;
		this._log(`[Feishu] WS ${reason}`);
	}

	stop(): void {
		this._stopping = true;
		this._handler = undefined;
		this._token = undefined;
		// 心跳与重连定时器必须清掉：否则热重载（配置变更）后旧平台的定时器会继续跑
		this._stopPing();
		if (this._reconnectTimer !== undefined) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
		this._reconnectAttempt = 0;
		this._wsOpened = false;
		this._assembler.clear();
		if (this._ws) {
			try {
				this._ws.close();
			} catch {
				// 忽略关闭异常
			}
			this._ws = undefined;
		}
	}

	// ─── 入站：供 BridgeServer/HTTP 层调用的事件分发入口 ───────────────

	/** 解析飞书事件回调（v2 卡片），转换为 InboundMessage 并交给引擎。 */
	handleWebhookEvent(payload: unknown): void {
		if (!this._handler) {
			return;
		}
		const evt = payload as {
			header?: { event_type?: string };
			event?: {
				message?: { message_id?: string; chat_id?: string; content?: string; message_type?: string };
				sender?: { sender_id?: { open_id?: string; union_id?: string }; sender_type?: string };
			};
		};
		const headerType = evt?.header?.event_type;
		const msg = evt?.event?.message;
		if (!msg || !headerType || !MESSAGE_EVENT_TYPES.has(headerType)) {
			// 带 message 体但不是已知消息事件名 → 不静默（便于发现飞书改名/新增事件）
			if (msg && headerType) {
				this._log(`[Feishu] 忽略未处理的消息事件类型：${headerType}`);
			}
			return;
		}
		// 暂只处理文本消息：图片/文件等转发给 Agent 只会得到一条空消息（D-13 附带澄清）
		const messageType = msg.message_type ?? "text";
		if (messageType !== "text") {
			this._log(`[Feishu] 忽略暂不支持的消息类型：${messageType}（当前仅处理 text）`);
			return;
		}
		let text = "";
		try {
			const c = JSON.parse(msg.content ?? "{}");
			text = typeof c.text === "string" ? c.text : "";
		} catch {
			text = "";
		}
		const sender = evt?.event?.sender;
		const userId = sender?.sender_id?.open_id ?? sender?.sender_id?.union_id ?? "unknown";
		const sessionKey = `feishu:${msg.chat_id ?? "chat"}:${userId}`;
		const replyCtx: FeishuReplyCtx = { messageId: msg.message_id, chatId: msg.chat_id };
		this._handler({
			sessionKey,
			platform: this.id,
			messageId: msg.message_id ?? `fs_${Date.now()}`,
			userId,
			userName: userId,
			chatName: msg.chat_id,
			conversationId: msg.chat_id,
			content: text,
			replyCtx,
		});
	}

	// ─── 出站 ────────────────────────────────────────────────────────

	/**
	 * 取 chat_id：优先回包句柄；其次**从 sessionKey 解析**（`feishu:<chatId>:<userId>`）。
	 *
	 * ★ 2026-09-22：调度器/relay/命令等路径可能只带 sessionKey、不带（或不完整）replyCtx，
	 *   此前直接抛「send 缺少 chat_id」把整条出站点打断；sessionKey 里本来就编码了 chat_id，
	 *   可安全兜底（三段落式由本平台构造，见 handleWebhookEvent）。
	 */
	private _resolveChatId(ctx: BridgeReplyCtx): string {
		const rc = ctx.replyCtx as FeishuReplyCtx | undefined;
		if (rc?.chatId) {
			return rc.chatId;
		}
		const parts = String(ctx.sessionKey ?? "").split(":");
		const fromKey = parts.length >= 3 && parts[0] === "feishu" ? parts[1] : undefined;
		if (fromKey) {
			return fromKey;
		}
		throw new Error(`[Feishu] 缺少 chat_id（replyCtx 与 sessionKey 都不含）：${String(ctx.sessionKey)}`);
	}

	async send(ctx: BridgeReplyCtx, content: string, _type?: OutboundType): Promise<void> {
		const chatId = this._resolveChatId(ctx);
		await this._postMessage("chat_id", chatId, "text", JSON.stringify({ text: content }));
	}

	async reply(ctx: BridgeReplyCtx, content: string, _type?: OutboundType): Promise<void> {
		const rc = ctx.replyCtx as FeishuReplyCtx | undefined;
		if (rc?.messageId) {
			await this._replyMessage(rc.messageId, "text", JSON.stringify({ text: content }));
			return;
		}
		// 无 message_id（如仅带 chat_id 的合成消息）→ 降级为发到群，而不是抛错中断整条出站
		const chatId = this._resolveChatId(ctx);
		this._log(`[Feishu] reply 缺少 message_id，降级为发送到群（chat_id=${chatId}）`);
		await this._postMessage("chat_id", chatId, "text", JSON.stringify({ text: content }));
	}

	async sendCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		const chatId = this._resolveChatId(ctx);
		await this._postMessage("chat_id", chatId, "interactive", JSON.stringify(this._cardToFeishu(card)));
	}

	async replyCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		const rc = ctx.replyCtx as FeishuReplyCtx | undefined;
		if (rc?.messageId) {
			await this._replyMessage(rc.messageId, "interactive", JSON.stringify(this._cardToFeishu(card)));
			return;
		}
		const chatId = this._resolveChatId(ctx);
		this._log(`[Feishu] replyCard 缺少 message_id，降级为发送到群（chat_id=${chatId}）`);
		await this._postMessage("chat_id", chatId, "interactive", JSON.stringify(this._cardToFeishu(card)));
	}

	// ─── 内部：token + 飞书 REST ───────────────────────────────────

	/**
	 * 统一的 HTTP POST(JSON) 出口。
	 *
	 * 优先走主进程 IRequestService（无 CORS）；未注入时回退渲染进程 fetch（仅单测/非 Electron 宿主）。
	 * 任一实现的解析口径一致：读原始文本 → JSON.parse，失败时把 HTTP 状态与响应片段带进错误信息。
	 */
	private async _postJson<T extends Record<string, any>>(
		url: string,
		body: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<{ status: number; json: T }> {
		const payload = JSON.stringify(body);
		const headers: Record<string, string> = { "Content-Type": "application/json", ...(extraHeaders ?? {}) };

		let status: number;
		let text: string;
		if (this._requestService) {
			const ctx = await this._requestService.request(
				{ url, type: "POST", data: payload, headers, callSite: this._callSite },
				CancellationToken.None,
			);
			status = ctx.res.statusCode ?? 0;
			text = (await asText(ctx)) ?? "";
		} else {
			const res = await fetch(url, { method: "POST", headers, body: payload });
			status = res.status;
			text = await res.text();
		}

		if (!text) {
			throw new Error(`[Feishu] 空响应：HTTP ${status} ${url}`);
		}
		try {
			return { status, json: JSON.parse(text) as T };
		} catch {
			throw new Error(`[Feishu] 非 JSON 响应：HTTP ${status} ${url} → ${text.slice(0, 120)}`);
		}
	}

	private async _ensureToken(): Promise<string> {
		if (this._token && this._token.expireAt > Date.now() + 60_000) {
			return this._token.token;
		}
		const { json: data } = await this._postJson<{
			code?: number;
			msg?: string;
			tenant_access_token?: string;
			expire?: number;
		}>(`${this._base}/auth/v3/tenant_access_token/internal`, {
			app_id: this._appId,
			app_secret: this._appSecret,
		});
		if (data.code !== 0 || !data.tenant_access_token) {
			throw new Error(`[Feishu] 获取 tenant_access_token 失败：${data.msg ?? data.code}`);
		}
		this._token = {
			token: data.tenant_access_token,
			expireAt: Date.now() + (data.expire ?? 7200) * 1000,
		};
		return this._token.token;
	}

	private async _postMessage(
		receiveIdType: string,
		receiveId: string,
		msgType: string,
		content: string,
	): Promise<void> {
		const token = await this._ensureToken();
		const url = `${this._base}/im/v1/messages?receive_id_type=${receiveIdType}`;
		const { json: data } = await this._postJson<{ code?: number; msg?: string }>(
			url,
			{ receive_id: receiveId, msg_type: msgType, content },
			{ Authorization: `Bearer ${token}` },
		);
		if (data.code !== 0) {
			throw new Error(`[Feishu] 发送消息失败：${data.msg ?? data.code}`);
		}
	}

	private async _replyMessage(messageId: string, msgType: string, content: string): Promise<void> {
		const token = await this._ensureToken();
		const url = `${this._base}/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
		const { json: data } = await this._postJson<{ code?: number; msg?: string }>(
			url,
			{ msg_type: msgType, content },
			{ Authorization: `Bearer ${token}` },
		);
		if (data.code !== 0) {
			throw new Error(`[Feishu] 回复消息失败：${data.msg ?? data.code}`);
		}
	}

	/** 将 BridgeCard 转换为飞书交互卡片 JSON。 */
	private _cardToFeishu(card: BridgeCard): unknown {
		const elements: unknown[] = [];
		for (const el of card.elements) {
			switch (el.kind) {
				case "markdown":
					elements.push({ tag: "markdown", content: el.content });
					break;
				case "divider":
					elements.push({ tag: "hr" });
					break;
				case "note":
					elements.push({ tag: "note", content: el.text });
					break;
				case "actions":
					elements.push({
						tag: "action",
						actions: el.buttons.map((b: BridgeButton) => ({
							tag: "button",
							text: { tag: "plain_text", content: b.text },
							type: b.type ?? "default",
							value: { bridge_value: b.value },
						})),
					});
					break;
			}
		}
		const result: Record<string, unknown> = { config: { wide_screen_mode: true }, elements };
		if (card.header) {
			result.header = {
				template: card.header.color ?? "blue",
				title: { tag: "plain_text", content: card.header.title },
			};
		}
		return result;
	}
}
