/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── TelegramPlatform：Telegram 平台适配器（对齐 cc-connect platform/telegram）──
// 出站：Bot API REST（sendMessage + inline_keyboard 卡片/按钮）。
// 入站：Bot API getUpdates 长轮询（无需外部 Webhook）。
// 无外部 SDK 依赖。token 经 TELEGRAM_BOT_TOKEN 注入。
//
// ★★ 2026-09-22 CORS 实测（D-14）：**出站 POST 在桌面端必失败**，入站 GET 反而能过。
//   用浏览器（透明 origin，等价于桌面端渲染进程的 `vscode-file://vscode-app`）实测 api.telegram.org：
//     ├─ `GET /getMe` / `GET /getUpdates`        → 通过（401 正常返回，说明简单请求有 ACAO）
//     └─ `POST /sendMessage`（Content-Type: application/json）
//          → `TypeError: Failed to fetch`（预检 OPTIONS 不被支持 ⇒ 被 CORS 拦死）
//   ⇒ 表现是「机器人能收到消息但永远不回话」。
//   修复：**出站 POST 走注入的 requestService（主进程出口）**；GET 仍留在渲染进程，理由有二：
//     ① 长轮询要 30s 挂着，而主进程 `httpRequest` 不支持取消（IPC 调用无法中断），
//        留在渲染进程才能让 `stop()`/热重载立刻 abort；
//     ② 附件下载要二进制字节，而适配器的文本通路会按 UTF-8 解码破坏字节。
//   注意：GET 能过是因为 Telegram 对简单请求返回了 ACAO —— 这是**对端给的宽容**，不是我们的保证；
//   若哪天收紧，症状会是 `_getUpdates` 持续失败（现已落日志 + lastError，不再静默）。

import { CancellationToken } from "../../../../../../base/common/cancellation.js";
import { asText, IRequestService } from "../../../../../../platform/request/common/request.js";
import {
	BridgeButton,
	BridgeCard,
	BridgePlatformStatus,
	BridgeReplyCtx,
	IBridgePlatform,
	InboundMessage,
	InboundAttachment,
	OutboundType,
} from "../../../common/bridge/bridgeTypes.js";

const TG_BASE = "https://api.telegram.org/bot";

/** 连续轮询失败时，日志节流（首次 + 每 N 次），避免刷屏又不静默。 */
const POLL_FAILURE_LOG_EVERY = 10;

export interface TelegramPlatformOpts {
	readonly botToken: string;
	readonly allowFrom?: string;
	/** 长轮询超时（秒），默认 30。 */
	readonly pollTimeout?: number;
	/**
	 * 出站 HTTP 出口（**装配侧必须注入主进程出口**）。
	 * 应传 `createMainProcessRequestService(mainProcessService)` 的产物；
	 * ⚠ 传 DI 注入的 `IRequestService` 无效（桌面端它就是 renderer 的 fetch，POST 仍被预检拦）。
	 * 未注入时回落 renderer fetch —— 仅供单测与非 Electron 宿主。
	 */
	readonly requestService?: IRequestService;
	/** IRequestService 的 callSite 标记（默认 'telegramPlatform'）。 */
	readonly callSite?: string;
	/** 日志出口（默认 console.error）。装配侧接 ILogService 后，轮询失败不再静默。 */
	readonly log?: (msg: string) => void;
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
	private readonly _requestService?: IRequestService;
	private readonly _callSite: string;
	private readonly _log: (msg: string) => void;
	private _handler?: (msg: InboundMessage) => void;
	private _pollOffset = 0;
	private _polling = false;
	private _pollAbort?: AbortController;
	/** 最近一次入站轮询失败原因（成功后清空）—— 让「静默拉不到消息」可诊断。 */
	private _lastError?: string;
	/** 连续失败次数（日志节流用）。 */
	private _pollFailures = 0;

	constructor(opts: TelegramPlatformOpts) {
		this._token = opts.botToken;
		this.allowFrom = opts.allowFrom;
		this._base = `${TG_BASE}${opts.botToken}`;
		this._pollTimeout = opts.pollTimeout ?? 30;
		this._requestService = opts.requestService;
		this._callSite = opts.callSite ?? "telegramPlatform";
		this._log = opts.log ?? ((msg: string) => console.error(msg));
	}

	/** 最近一次入站轮询失败原因（无失败则为 undefined）。 */
	get lastError(): string | undefined {
		return this._lastError;
	}

	/** 当前连接状态（设置页渠道条目展示用）。Telegram 无持久连接：轮询健康即「已连接」。 */
	getStatus(): BridgePlatformStatus {
		if (!this._polling) {
			return { state: "disconnected", detail: "未启动（轮询循环未运行）" };
		}
		if (this._lastError) {
			return { state: "error", detail: this._lastError };
		}
		return { state: "connected", detail: `长轮询运行中（timeout=${this._pollTimeout}s）` };
	}

	// 启动即拉起长轮询循环（无需外部 Webhook）。
	start(handler: (msg: InboundMessage) => void): void {
		this._handler = handler;
		this._polling = true;
		this._lastError = undefined;
		this._pollFailures = 0;
		this._pollLoop().catch(err => {
			// 轮询异常不致命，仅终止循环；stop() 也会置位。
			this._polling = false;
			this._lastError = err instanceof Error ? err.message : String(err);
			this._log(`[Telegram] 轮询循环终止：${this._lastError}`);
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
				// 成功即清错（含失败计数），避免「恢复后仍显示故障」
				this._lastError = undefined;
				this._pollFailures = 0;
				for (const u of updates) {
					this._handleUpdate(u);
				}
			} catch (err) {
				if (!this._polling) {
					break;
				}
				this._notePollFailure(err);
				// 网络抖动：短暂退避后继续。
				await this._sleep(2000);
			}
		}
	}

	/** 记录轮询失败（首次 + 每 N 次落日志，既不静默也不刷屏）。 */
	private _notePollFailure(err: unknown): void {
		this._pollFailures++;
		this._lastError = err instanceof Error ? err.message : String(err);
		if (this._pollFailures === 1 || this._pollFailures % POLL_FAILURE_LOG_EVERY === 0) {
			this._log(`[Telegram] getUpdates 失败（第 ${this._pollFailures} 次）：${this._lastError}`);
		}
	}

	/**
	 * 拉取更新（长轮询）。
	 * ★ 留在渲染进程 fetch：一是 30s 长轮询需要可中断（主进程出口不支持取消，stop() 会拖到超时）；
	 *   二是实测简单 GET 有 ACAO、不被 CORS 拦（见文件头实测结论）。
	 */
	private async _getUpdates(): Promise<unknown[]> {
		this._pollAbort = new AbortController();
		const url = `${this._base}/getUpdates?offset=${this._pollOffset}&timeout=${this._pollTimeout}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`;
		const res = await fetch(url, { signal: this._pollAbort.signal });
		const data = (await res.json()) as { ok?: boolean; description?: string; result?: unknown[] };
		if (!data.ok || !Array.isArray(data.result)) {
			throw new Error(`[Telegram] getUpdates 返回异常：${data.description ?? "ok=false / result 非数组"}`);
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

	/** 附件下载：走 renderer fetch（简单 GET 不受 CORS 拦；且需要二进制 arrayBuffer，
	 *  主进程出口的文本通路会按 UTF-8 解码破坏字节）。 */
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

	/**
	 * 取 chat_id：优先回包句柄；其次**从 sessionKey 解析**（`telegram:<chatId>:<userId>`）。
	 * 与飞书同策略（2026-09-22）：调度器/relay/命令等只带 sessionKey 的路径不该把出站打断。
	 */
	private _resolveChatId(ctx: BridgeReplyCtx): number {
		const rc = ctx.replyCtx as TelegramReplyCtx | undefined;
		if (rc?.chatId != null) {
			return rc.chatId;
		}
		const parts = String(ctx.sessionKey ?? "").split(":");
		const fromKey = parts.length >= 3 && parts[0] === "telegram" ? Number(parts[1]) : NaN;
		if (Number.isFinite(fromKey)) {
			return fromKey;
		}
		throw new Error(`[Telegram] 缺少 chat_id（replyCtx 与 sessionKey 都不含）：${String(ctx.sessionKey)}`);
	}

	async send(ctx: BridgeReplyCtx, content: string, _type?: OutboundType): Promise<void> {
		await this._sendMessage(this._resolveChatId(ctx), content);
	}

	async reply(ctx: BridgeReplyCtx, content: string, _type?: OutboundType): Promise<void> {
		const rc = ctx.replyCtx as TelegramReplyCtx | undefined;
		await this._sendMessage(this._resolveChatId(ctx), content, rc?.messageId);
	}

	async sendCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		const rc = ctx.replyCtx as TelegramReplyCtx | undefined;
		const { text, buttons } = this._cardToTelegram(card);
		await this._sendMessage(this._resolveChatId(ctx), text, rc?.messageId, buttons);
	}

	async replyCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		await this.sendCard(ctx, card);
	}

	async sendWithButtons(ctx: BridgeReplyCtx, content: string, buttons: BridgeButton[][]): Promise<void> {
		const rc = ctx.replyCtx as TelegramReplyCtx | undefined;
		const kb = this._buttonsToKeyboard(buttons);
		await this._sendMessage(this._resolveChatId(ctx), content, rc?.messageId, kb);
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
		// ★ 必须走主进程出口：renderer 的 POST(application/json) 会触发预检，
		//   而 api.telegram.org 不支持 OPTIONS ⇒ TypeError: Failed to fetch（见文件头实测）。
		const { status, json: data } = await this._postJson<{ ok?: boolean; description?: string }>(
			`${this._base}/sendMessage`,
			body,
		);
		if (!data.ok) {
			throw new Error(`[Telegram] sendMessage 失败：HTTP ${status} ${data.description ?? "unknown"}`);
		}
	}

	/**
	 * POST JSON：优先走注入的 HTTP 出口（主进程，无 CORS 预检），未注入时回落 renderer fetch。
	 * 与 `feishu.ts#_postJson` 同构（两处都短，暂不抽公共层，避免为一个方法引入跨平台耦合）。
	 */
	private async _postJson<T>(url: string, body: unknown): Promise<{ status: number; json: T }> {
		const payload = JSON.stringify(body);
		const headers = { "Content-Type": "application/json" };

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
			throw new Error(`[Telegram] 空响应：HTTP ${status} ${url}`);
		}
		try {
			return { status, json: JSON.parse(text) as T };
		} catch {
			throw new Error(`[Telegram] 非 JSON 响应：HTTP ${status} ${url} → ${text.slice(0, 120)}`);
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
