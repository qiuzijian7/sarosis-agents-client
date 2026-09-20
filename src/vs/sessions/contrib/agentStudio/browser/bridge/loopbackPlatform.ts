/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── LoopbackPlatform：测试/演示用适配器（无外部 IM 凭证）──
// 入站通过 postInbound() 注入；出站通过 onOutbound 事件暴露，便于单测与手动演示。

import { Emitter } from "../../../../../base/common/event.js";
import { IDisposable } from "../../../../../base/common/lifecycle.js";
import {
	BridgeButton,
	BridgeCard,
	BridgeReplyCtx,
	IBridgePlatform,
	InboundMessage,
	OutboundMessage,
} from "../../common/bridge/bridgeTypes.js";

/**
 * 本平台产生的**唯一**入站 userId（见 `postInbound()`）。
 * 与 `allowFrom` 共用此常量 ⇒ 两者不会漂移 ✓。
 */
const LOOPBACK_USER_ID = "tester";

export class LoopbackPlatform implements IBridgePlatform {
	readonly id = "loopback";
	readonly name = "Loopback (测试/演示)";

	/**
	 * ★ 2026-09-20：显式白名单（**只放行本平台自己产生的 userId** ✓）。
	 *
	 * 背景：`bridgeEngine` 会对每个注册平台跑
	 * `checkAllowFromConfig(p.id, p.allowFrom, …)`；`allowFrom` 为空 ⇒ 记一条安全告警
	 * 「[Bridge] 平台 loopback 未配置 allow_from — 将允许所有用户」✗。
	 *
	 * 取值理由 ✓：本平台**不接外部输入** —— 入站只能由进程内 `postInbound()` 注入，
	 * 且其 `userId` 恒为 `LOOPBACK_USER_ID` ⇒ 白名单填它即可：
	 *   · 告警消失（非空 ⇒ 不 warn ✓）；
	 *   · 白名单**真实且最小**（除该 id 外一律拒绝 ✓）；
	 *   · **行为不变**（`allowFromCheck("tester", "tester") === true` ✓）。
	 */
	readonly allowFrom = LOOPBACK_USER_ID;

	private _handler?: (msg: InboundMessage) => void;
	private readonly _onOutbound = new Emitter<OutboundMessage>();
	readonly onOutbound = this._onOutbound.event;

	/** 已出站消息（测试断言用）。 */
	readonly outbounds: OutboundMessage[] = [];
	private _counter = 0;

	start(handler: (msg: InboundMessage) => void): void {
		this._handler = handler;
	}

	stop(): void {
		this._handler = undefined;
		this._onOutbound.dispose();
	}

	/** 模拟一条来自 IM 的入站消息。 */
	postInbound(content: string, sessionKey = "loopback:default", replyCtx?: unknown): void {
		if (!this._handler) {
			throw new Error("LoopbackPlatform 尚未 start()");
		}
		const messageId = `lb_${Date.now()}_${this._counter++}`;
		const msg: InboundMessage = {
			sessionKey,
			platform: this.id,
			messageId,
			userId: LOOPBACK_USER_ID,
			userName: "Tester",
			content,
			replyCtx: replyCtx ?? messageId,
		};
		this._handler(msg);
	}

	private _dispatch(ctx: BridgeReplyCtx, content: string, type: OutboundMessage["type"]): void {
		const msg: OutboundMessage = {
			sessionKey: ctx.sessionKey,
			type,
			content,
			replyCtx: ctx.replyCtx,
		};
		this.outbounds.push(msg);
		this._onOutbound.fire(msg);
	}

	async send(ctx: BridgeReplyCtx, content: string, type: OutboundMessage["type"] = "text"): Promise<void> {
		this._dispatch(ctx, content, type);
	}

	async reply(ctx: BridgeReplyCtx, content: string, type: OutboundMessage["type"] = "text"): Promise<void> {
		this._dispatch(ctx, content, type);
	}

	async update(ctx: BridgeReplyCtx, content: string, type: OutboundMessage["type"] = "text"): Promise<void> {
		this._dispatch(ctx, content, type);
	}

	async sendCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		this._dispatch(ctx, JSON.stringify(card), "text");
	}

	async replyCard(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void> {
		this._dispatch(ctx, JSON.stringify(card), "text");
	}

	async sendWithButtons(ctx: BridgeReplyCtx, content: string, buttons: BridgeButton[][]): Promise<void> {
		const flat = buttons.map(row => row.map(b => b.text).join("|")).join(" / ");
		this._dispatch(ctx, `${content}\n[${flat}]`, "text");
	}

	/** 测试用：清空出站记录。 */
	clearOutbounds(): void {
		this.outbounds.length = 0;
	}

	// 便于单测：订阅出站
	onOutboundEvent(cb: (m: OutboundMessage) => void): IDisposable {
		return this._onOutbound.event(cb);
	}
}
