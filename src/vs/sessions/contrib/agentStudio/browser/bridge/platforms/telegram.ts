/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── TelegramPlatform：Telegram 平台适配器（对齐 cc-connect platform/telegram）──
// 出站：Bot API REST（sendMessage + inline_keyboard 卡片/按钮）。
// 入站：Bot API getUpdates 长轮询（纯 fetch 拉取，无需外部 Webhook）。
// 无外部 SDK 依赖：仅用渲染进程全局 fetch。token 经 TELEGRAM_BOT_TOKEN 注入。

import {
	BridgeButton,
	BridgeCard,
	BridgeReplyCtx,
	IBridgePlatform,
	InboundMessage,
	InboundAttachment,
	OutboundType,
} from "../../../common/bridge/bridgeTypes.js";

const TG_BASE = "https://api.telegram.org/bot";

export interface TelegramPlatformOpts {
	readonly botToken: string;
	readonly allowFrom?: string;
	/** 长轮询超时（秒），默认 30。 */
	readonly pollTimeout?: number;
}

interface TelegramReplyCtx {
	readonly chatId: number;
	readonly messageId: number;
}

export class TelegramPlatform implements IBridgePlatform {
	readonly id = "telegram";
	readonly name = "Telegram";
	readonly allowFrom?: string;

	private readonly _token: string;
	private readonly _base: string;
	private readonly _pollTimeout: number;
	private _handler?: (msg: InboundMessage) => void;
	private _pollOffset = 0;
	private _polling = false;
	private _pollAbort?: AbortController;

	constructor(opts: TelegramPlatformOpts) {
		this._token = opts.botToken;
		this.allowFrom = opts.allowFrom;
		this._base = `${TG_BASE}${opts.botToken}`;
		this._pollTimeout = opts.pollTimeout ?? 30;
	}

	// 启动即拉起长轮询循环（纯 fetch，无需外部 Webhook）。
	start(handler: (msg: InboundMessage) => void): void {
		this._handler = handler;
		this._polling = true;
		this._pollLoop().catch(err => {
			// 轮询异常不致命，仅终止循环；stop() 也会置位。
			this._polling = false;
			console.error("[Telegram] poll loop error:", err);
		});
	}

	stop(): void {
		this._polling = false;
		this._pollAbort?.abort();
		this._handler = undefined;
	}

	// ─── 入站：长轮询 ──────────────────────────────────────────────

	private async _pollLoop(): Promise<void> {
		while (this._polling) {
			try {
				const updates = await this._getUpdates();
				for (const u of updates) {
					this._handleUpdate(u);
				}
			} catch (err) {
				if (!this._polling) {
					break;
				}
				// 网络抖动：短暂退避后继续。
				await this._sleep(2000);
			}
		}
	}

	private async _getUpdates(): Promise<unknown[]> {
		this._pollAbort = new AbortController();
		const url = `${this._base}/getUpdates?offset=${this._pollOffset}&timeout=${this._pollTimeout}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`;
		const res = await fetch(url, { signal: this._pollAbort.signal });
		const data = (await res.json()) as { ok?: boolean; result?: unknown[] };
		if (!data.ok || !Array.isArray(data.result)) {
			return [];
		}
		return data.result;
	}

	private _handleUpdate(u: any): void {
		// 推进 offset，避免重复消费。
		if (typeof u.update_id === "number") {
			this._pollOffset = u.update_id + 1;
		}
		if (u.message) {
			this._handleMessage(u.message);
		} else if (u.callback_query) {
			this._handleCallbackQuery(u.callback_query);
		}
	}

	/** 供测试或外部事件源注入单条 update（对齐 feishu.handleWebhookEvent）。 */
	handleUpdate(u: unknown): void {
		this._handleUpdate(u);
	}

	private _handleMessage(msg: any): void {
		if (!this._handler) {
			return;
		}
		const chat = msg.chat ?? {};
		const from = msg.from ?? {};
		const userId = from.id != null ? String(from.id) : "unknown";
		const userName = from.username ?? from.first_name ?? userId;
		const chatId: number = chat.id;
		const messageId: number = msg.message_id;
		const sessionKey = `telegram:${chatId}:${userId}`;
		const replyCtx: TelegramReplyCtx = { chatId, messageId };

		// 附件（照片/文档）：下载原始字节供 _routeToAgent 落盘。
		const files = this._collectAttachments(msg);

		const inbound: InboundMessage = {
			sessionKey,
			platform: this.id,
			messageId: String(messageId),
			userId,
			userName,
			chatName: chat.title ?? chat.username ?? String(chatId),
			content: typeof msg.text === "string" ? msg.text : "",
			replyCtx,
			files: files.length > 0 ? files : undefined,
		};
		this._handler(inbound);
	}

	private _collectAttachments(msg: any): InboundAttachment[] {
		const out: InboundAttachment[] = [];
		// 照片：取最后一张（最高分辨率），需先 getFile 取路径再下载。
		if (Array.isArray(msg.photo) && msg.photo.length > 0) {
			const last = msg.photo[msg.photo.length - 1];
			const att = this._fileToAttachment(last?.file_id, "image/jpeg", msg.caption);
			if (att) {
				out.push(att);
			}
		}
		if (msg.document) {
			const att = this._fileToAttachment(msg.document.file_id, msg.document.mime_type ?? "application/octet-stream", msg.document.file_name);
			if (att) {
				out.push(att);
			}
		}
		return out;
	}

	/** 同步生成占位附件，并异步下载字节（下载失败则退化为仅元数据，data 为空）。 */
	private _fileToAttachment(fileId: string | undefined, mime: string, name?: string): InboundAttachment | undefined {
		if (!fileId) {
			return undefined;
		}
		// 用可变本地类型持有，异步补齐字节后再作为 InboundAttachment 透传。
		const att: { mimeType: string; data: Uint8Array; fileName?: string } = { mimeType: mime, data: new Uint8Array(0), fileName: name };
		// 异步补充字节；不阻塞入站派发。
		this._downloadFile(fileId).then(bytes => {
			att.data = bytes;
		}).catch(() => {
			// 下载失败保留占位（无字节），路由层仍可记录缺附件。
		});
		return att;
	}

	private async _downloadFile(fileId: string): Promise<Uint8Array> {
		const infoRes = await fetch(`${this._base}/getFile?file_id=${encodeURIComponent(fileId)}`);
		const info = (await infoRes.json()) as { ok?: boolean; result?: { file_path?: string } };
		if (!info.ok || !info.result?.file_path) {
			throw new Error("[Telegram] getFile 失败");
		}
		const url = `https://api.telegram.org/file/bot${this._token}/${info.result.file_path}`;
		const res = await fetch(url);
		const buf = await res.arrayBuffer();
		return new Uint8Array(buf);
	}

	private _handleCallbackQuery(cq: any): void {
		if (!this._handler) {
			return;
		}
		const msg = cq.message ?? {};
		const from = cq.from ?? {};
		const userId = from.id != null ? String(from.id) : "unknown";
		const chatId: number = msg.chat?.id;
		const messageId: number = msg.message_id;
		const sessionKey = `telegram:${chatId}:${userId}`;
		const replyCtx: TelegramReplyCtx = { chatId, messageId };
		// 按钮回调：将 callback_data 作为指令文本回灌引擎（isPermissionResponse 置位以区分）。
		this._handler({
			sessionKey,
			platform: this.id,
			messageId: `cq_${cq.id}`,
			userId,
			userName: from.username ?? from.first_name ?? userId,
			chatName: msg.chat?.title ?? msg.chat?.username ?? String(chatId),
			content: typeof cq.data === "string" ? cq.data : "",
			replyCtx,
			isPermissionResponse: true,
		});
	}

	// ─── 出站 ───────────────────────────────────────────────────────

	async send(ctx: BridgeReplyCtx, content: string, _type?: OutboundType): Promise<void> {
		const rc = ctx.replyCtx as TelegramReplyCtx | undefined;
		if (rc?.chatId == null) {
			throw new Error("[Telegram] send 缺少 chat_id");
		}
		await this._sendMessage(rc.chatId, content);
	}

	async reply(ctx: BridgeReplyCtx, content: string, _type?: OutboundType): Promise<void> {
		const rc = ctx.replyCtx as TelegramReplyCtx | undefined;
		if (rc?.chatId == null) {
			throw new Error("[Telegram] reply 缺少 chat_id");
		}
		await this._sendMessage(rc.chatId, content, rc.messageId);
	}

	async sendCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		const rc = ctx.replyCtx as TelegramReplyCtx | undefined;
		if (rc?.chatId == null) {
			throw new Error("[Telegram] sendCard 缺少 chat_id");
		}
		const { text, buttons } = this._cardToTelegram(card);
		await this._sendMessage(rc.chatId, text, rc.messageId, buttons);
	}

	async replyCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		await this.sendCard(ctx, card);
	}

	async sendWithButtons(ctx: BridgeReplyCtx, content: string, buttons: BridgeButton[][]): Promise<void> {
		const rc = ctx.replyCtx as TelegramReplyCtx | undefined;
		if (rc?.chatId == null) {
			throw new Error("[Telegram] sendWithButtons 缺少 chat_id");
		}
		const kb = this._buttonsToKeyboard(buttons);
		await this._sendMessage(rc.chatId, content, rc.messageId, kb);
	}

	// ─── 内部：Telegram Bot API ───────────────────────────────────

	private async _sendMessage(
		chatId: number,
		text: string,
		replyTo?: number,
		inlineKeyboard?: unknown,
	): Promise<void> {
		const body: Record<string, unknown> = {
			chat_id: chatId,
			text: text.slice(0, 4096),
			parse_mode: "Markdown",
		};
		if (replyTo != null) {
			body.reply_to_message_id = replyTo;
		}
		if (inlineKeyboard) {
			body.reply_markup = inlineKeyboard;
		}
		const res = await fetch(`${this._base}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = (await res.json()) as { ok?: boolean; description?: string };
		if (!data.ok) {
			throw new Error(`[Telegram] sendMessage 失败：${data.description ?? "unknown"}`);
		}
	}

	/** 将 BridgeCard 转为「标题+正文文本 + 内联键盘按钮」。 */
	private _cardToTelegram(card: BridgeCard): { text: string; buttons?: unknown } {
		const lines: string[] = [];
		if (card.header) {
			lines.push(`*${card.header.title}*`, "");
		}
		for (const el of card.elements) {
			if (el.kind === "markdown") {
				lines.push(el.content, "");
			} else if (el.kind === "divider") {
				lines.push("────────", "");
			} else if (el.kind === "note") {
				lines.push(el.text);
			}
		}
		const buttons = this._collectCardButtons(card);
		return { text: lines.join("\n").trim().slice(0, 4096), buttons: buttons.length ? this._buttonsToKeyboard(buttons) : undefined };
	}

	private _collectCardButtons(card: BridgeCard): BridgeButton[][] {
		const rows: BridgeButton[][] = [];
		for (const el of card.elements) {
			if (el.kind === "actions" && el.buttons.length > 0) {
				rows.push(el.buttons);
			}
		}
		return rows;
	}

	/** BridgeButton[][] → Telegram inline_keyboard（每行一个 actions 块）。 */
	private _buttonsToKeyboard(rows: BridgeButton[][]): unknown {
		return {
			inline_keyboard: rows.map(row =>
				row.map((b: BridgeButton) => ({
					text: b.text,
					callback_data: b.value.slice(0, 64),
				})),
			),
		};
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
