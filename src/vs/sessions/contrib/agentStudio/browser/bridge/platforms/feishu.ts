/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── FeishuPlatform：飞书/Lark 平台适配器（对齐 cc-connect platform/feishu）──
// 出站：REST（tenant_access_token + im/v1/messages create/reply + 交互卡片）。
// 入站：通过 handleWebhookEvent() 解析飞书事件回调（长连接 WS 监听见 P2 BridgeServer）。
// 无外部 SDK 依赖：仅用渲染进程全局 fetch。需在飞书开放平台配置事件订阅回调指向 BridgeServer。

import {
	BridgeButton,
	BridgeCard,
	BridgeReplyCtx,
	IBridgePlatform,
	InboundMessage,
} from "../../../common/bridge/bridgeTypes.js";

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

export interface FeishuPlatformOpts {
	readonly appId: string;
	readonly appSecret: string;
	readonly allowFrom?: string;
	readonly baseUrl?: string;
	/**
	 * 启用事件订阅长连接（ws）：无需外部 Webhook 回调服务器。
	 * 经 event/v1/outbound_event/subscribe 取 wss 地址后直连，事件实时推送。
	 */
	readonly useWs?: boolean;
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
	private readonly _useWs: boolean;
	private _handler?: (msg: InboundMessage) => void;
	private _token?: TokenCache;
	private _ws?: any; // WebSocket 长连接

	constructor(opts: FeishuPlatformOpts) {
		this._appId = opts.appId;
		this._appSecret = opts.appSecret;
		this.allowFrom = opts.allowFrom;
		this._base = opts.baseUrl ?? FEISHU_BASE;
		this._useWs = opts.useWs === true;
	}

	// 出站无需在此建立连接；webhook 模式无需长连接。启用 useWs 时拉起事件订阅长连接。
	start(handler: (msg: InboundMessage) => void): void {
		this._handler = handler;
		if (this._useWs) {
			this._connectWs().catch(err => console.error("[Feishu] WS 长连接失败：", err));
		}
	}

	// ─── 入站：飞书事件订阅长连接（wss，无需外部 Webhook）───

	private async _connectWs(): Promise<void> {
		const res = await fetch(`${this._base}/event/v1/outbound_event/subscribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app_id: this._appId, app_secret: this._appSecret }),
		});
		const data = (await res.json()) as { code?: number; msg?: string; data?: { url?: string } };
		if (data.code !== 0 || !data.data?.url) {
			throw new Error(`[Feishu] 订阅长连接失败：${data.msg ?? data.code}`);
		}
		const WSAny: any = (globalThis as any).WebSocket;
		if (typeof WSAny !== "function") {
			throw new Error("[Feishu] 渲染进程无 WebSocket 全局，无法建立长连接");
		}
		const ws = new WSAny(data.data.url);
		this._ws = ws;
		ws.onmessage = (ev: any) => {
			let payload: unknown;
			try {
				payload = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
			} catch {
				return;
			}
			const p = payload as { type?: string; challenge?: string; token?: string };
			if (p.type === "url_verification" && p.challenge) {
				// Webhook 校验回包（长连接下通常不需要，但兼容兜底）
				ws.send(JSON.stringify({ challenge: p.challenge, token: p.token }));
				return;
			}
			this.handleWebhookEvent(payload);
		};
		ws.onerror = () => {
			this._ws = undefined;
		};
		ws.onclose = () => {
			this._ws = undefined;
		};
	}

	stop(): void {
		this._handler = undefined;
		this._token = undefined;
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
		if (headerType !== "im.message.message_received" || !msg) {
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
			content: text,
			replyCtx,
		});
	}

	// ─── 出站 ────────────────────────────────────────────────────────

	async send(ctx: BridgeReplyCtx, content: string): Promise<void> {
		const rc = ctx.replyCtx as FeishuReplyCtx | undefined;
		const chatId = rc?.chatId;
		if (!chatId) {
			throw new Error("[Feishu] send 缺少 chat_id（无法主动发送）");
		}
		await this._postMessage("chat_id", chatId, "text", JSON.stringify({ text: content }));
	}

	async reply(ctx: BridgeReplyCtx, content: string): Promise<void> {
		const rc = ctx.replyCtx as FeishuReplyCtx | undefined;
		const messageId = rc?.messageId;
		if (!messageId) {
			throw new Error("[Feishu] reply 缺少 message_id");
		}
		await this._replyMessage(messageId, "text", JSON.stringify({ text: content }));
	}

	async sendCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		const rc = ctx.replyCtx as FeishuReplyCtx | undefined;
		const chatId = rc?.chatId;
		if (!chatId) {
			throw new Error("[Feishu] sendCard 缺少 chat_id");
		}
		await this._postMessage("chat_id", chatId, "interactive", JSON.stringify(this._cardToFeishu(card)));
	}

	async replyCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		const rc = ctx.replyCtx as FeishuReplyCtx | undefined;
		const messageId = rc?.messageId;
		if (!messageId) {
			throw new Error("[Feishu] replyCard 缺少 message_id");
		}
		await this._replyMessage(messageId, "interactive", JSON.stringify(this._cardToFeishu(card)));
	}

	// ─── 内部：token + 飞书 REST ───────────────────────────────────

	private async _ensureToken(): Promise<string> {
		if (this._token && this._token.expireAt > Date.now() + 60_000) {
			return this._token.token;
		}
		const res = await fetch(`${this._base}/auth/v3/tenant_access_token/internal`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app_id: this._appId, app_secret: this._appSecret }),
		});
		const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
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
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content }),
		});
		const data = (await res.json()) as { code?: number; msg?: string };
		if (data.code !== 0) {
			throw new Error(`[Feishu] 发送消息失败：${data.msg ?? data.code}`);
		}
	}

	private async _replyMessage(messageId: string, msgType: string, content: string): Promise<void> {
		const token = await this._ensureToken();
		const url = `${this._base}/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ msg_type: msgType, content }),
		});
		const data = (await res.json()) as { code?: number; msg?: string };
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
