/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BridgeServer：本地 WebSocket 服务（对齐 cc-connect core/bridge.go BridgeServer）──
// 提供给外部调试面板 / cc-connect 的「事件回调 + 消息注入」入口：
//   · 客户端发 {type:'subscribe'} → 接收 engine 出站事件流（onPlatformOutbound）。
//   · 客户端发 {type:'inbound', sessionKey, content, replyCtx?} → 注入合成消息经引擎路由。
//   · 客户端发 {type:'ping'} → 回 {type:'pong'}。
// 门控：需 env BRIDGE_WS_PORT 或 BRIDGE_WS_ENABLE=1 才启动（默认不监听，零暴露面）。
// ws 模块经 nodeRequire('ws') 加载（渲染进程禁裸模块 import）。

import { Disposable } from "../../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { BridgeEngine } from "./bridgeEngine.js";
import { OutboundMessage } from "../../common/bridge/bridgeTypes.js";

export interface BridgeServerDeps {
	readonly engine: BridgeEngine;
	readonly logService: ILogService;
}

interface WsClient {
	send(data: string): void;
	on(event: string, cb: (...args: any[]) => void): void;
	close(): void;
}

export class BridgeServer extends Disposable {
	private readonly _engine: BridgeEngine;
	private readonly _log: ILogService;
	private readonly _clients = new Set<{ ws: WsClient; subscribed: boolean }>();

	constructor(deps: BridgeServerDeps) {
		super();
		this._engine = deps.engine;
		this._log = deps.logService;
	}

	/** 是否启用：env BRIDGE_WS_PORT 或 BRIDGE_WS_ENABLE=1。 */
	private _isEnabled(): { port: number } | undefined {
		const proc: any = (globalThis as any).process;
		const env = proc?.env;
		if (!env) {
			return undefined;
		}
		if (env.BRIDGE_WS_ENABLE === "1") {
			const port = parseInt(env.BRIDGE_WS_PORT ?? "18755", 10) || 18755;
			return { port };
		}
		if (typeof env.BRIDGE_WS_PORT === "string" && env.BRIDGE_WS_PORT !== "") {
			const port = parseInt(env.BRIDGE_WS_PORT, 10);
			if (Number.isFinite(port)) {
				return { port };
			}
		}
		return undefined;
	}

	start(): void {
		const cfg = this._isEnabled();
		if (!cfg) {
			this._log.info("[BridgeServer] 未启用（需 BRIDGE_WS_PORT 或 BRIDGE_WS_ENABLE=1），跳过");
			return;
		}
		const req: any =
			typeof (globalThis as any).require === "function" ? (globalThis as any).require : undefined;
		if (!req) {
			this._log.warn("[BridgeServer] 渲染进程无 require，无法加载 ws，跳过");
			return;
		}
		let wsMod: any;
		try {
			wsMod = req("ws");
		} catch {
			this._log.warn("[BridgeServer] 未找到 ws 模块，跳过");
			return;
		}

		const wss = new wsMod.Server({ port: cfg.port });
		this._log.info(`[BridgeServer] listening on ws://127.0.0.1:${cfg.port}`);

		const outboundSub = this._engine.onPlatformOutbound((msg: OutboundMessage) => {
			this._broadcast({ type: "outbound", msg });
		});

		wss.on("connection", (ws: any) => {
			const client = { ws, subscribed: false };
			this._clients.add(client);
			ws.on("message", (raw: any) => {
				try {
					const data = JSON.parse(raw.toString());
					this._handleClientMessage(client, data);
				} catch (err) {
					this._log.warn(`[BridgeServer] bad client message:`, err);
					ws.send(JSON.stringify({ type: "error", error: "invalid JSON" }));
				}
			});
			ws.on("close", () => {
				this._clients.delete(client);
			});
			ws.on("error", () => {
				this._clients.delete(client);
			});
		});

		wss.on("error", (err: any) => {
			this._log.error(`[BridgeServer] server error:`, err);
		});

		this._register({
			dispose: () => {
				outboundSub.dispose();
				wss.close();
				this._clients.clear();
			},
		});
	}

	private _handleClientMessage(client: { ws: WsClient; subscribed: boolean }, data: any): void {
		switch (data?.type) {
			case "subscribe":
				client.subscribed = true;
				client.ws.send(JSON.stringify({ type: "ok", subscribed: true }));
				break;
			case "inbound":
				if (typeof data.sessionKey !== "string" || typeof data.content !== "string") {
					client.ws.send(JSON.stringify({ type: "error", error: "sessionKey & content required" }));
					break;
				}
				this._engine
					.handleSynthetic(data.sessionKey, data.content, { replyCtx: data.replyCtx })
					.catch(err => this._log.error(`[BridgeServer] inbound inject failed:`, err));
				client.ws.send(JSON.stringify({ type: "ok", injected: true }));
				break;
			case "ping":
				client.ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
				break;
			default:
				client.ws.send(JSON.stringify({ type: "error", error: `unknown type: ${data?.type}` }));
		}
	}

	private _broadcast(obj: unknown): void {
		const payload = JSON.stringify(obj);
		for (const c of this._clients) {
			if (c.subscribed) {
				try {
					c.ws.send(payload);
				} catch {
					// 忽略单客户端发送失败
				}
			}
		}
	}
}
