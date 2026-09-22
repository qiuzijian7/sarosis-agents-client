/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书长连接联调探针 —— 用真实凭证在真实网络上把官方协议完整跑一遍。
 *
 * ## 用法
 *
 * ```bash
 * node run-feishu-ws-probe.mjs --appId cli_xxx --appSecret yyy
 * # 或
 * FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=yyy node run-feishu-ws-probe.mjs
 * ```
 *
 * 可选参数：
 *   --base https://open.feishu.cn/open-apis     （Lark 用 https://open.larksuite.com/open-apis）
 *   --timeoutSec 30                              （建连后等帧的最长秒数，默认 30）
 *   --keep                                       （一直挂着直到 Ctrl+C，配合真实消息联调）
 *
 * ## 退出码（便于脚本化判断）
 *
 * | code | 含义 |
 * |---|---|
 * | 0 | 长连接可用（建连成功且收到 pong / 事件） |
 * | 1 | 参数缺失 |
 * | 2 | 换地址失败（带飞书 code/msg，按表对症） |
 * | 3 | WS 握手失败（应用未开启长连接 / 凭证权限 / 租户不对） |
 * | 4 | 建连成功但超时未收到任何帧（可能订阅方式未设为长连接 / 没勾选事件） |
 *
 * ## 安全
 *
 * 打印全程脱敏：AppSecret 不打；wss 地址只打 origin + path + 查询键名（签名参数不出现在日志里）。
 */

import {
	FEISHU_WS_ENDPOINT_PATH,
	FRAME_HEADER,
	FRAME_METHOD,
	MESSAGE_TYPE,
	buildAckFrame,
	buildPingFrame,
	decodeFeishuFrame,
	decodeUtf8,
	extractServiceId,
	frameHeader,
	parseClientConfig,
	parseWsEndpointResponse,
	resolveWsEndpointBase,
} from "../../browser/bridge/platforms/feishuWsProtocol.js";

const OK = 0, MISSING_ARGS = 1, ENDPOINT_FAILED = 2, HANDSHAKE_FAILED = 3, NO_FRAMES = 4;

interface ProbeArgs {
	appId?: string;
	appSecret?: string;
	base: string;
	timeoutSec: number;
	keep: boolean;
}

function parseArgs(argv: string[]): ProbeArgs {
	const out: ProbeArgs = { base: "https://open.feishu.cn/open-apis", timeoutSec: 30, keep: false };
	const take = (flag: string, set: (v: string) => void): void => {
		for (let i = 0; i < argv.length; i++) {
			// 支持两种写法：--flag=value 与 --flag value
			if (argv[i] === flag && i + 1 < argv.length) {
				set(argv[i + 1]);
			} else if (argv[i].startsWith(`${flag}=`)) {
				set(argv[i].slice(flag.length + 1));
			}
		}
	};
	take("--appId", v => { out.appId = v; });
	take("--appSecret", v => { out.appSecret = v; });
	take("--base", v => { out.base = v; });
	take("--timeoutSec", v => { out.timeoutSec = Number(v) || out.timeoutSec; });
	if (argv.includes("--keep")) { out.keep = true; }
	// 环境变量兜底
	out.appId ??= (globalThis as any).process?.env?.FEISHU_APP_ID;
	out.appSecret ??= (globalThis as any).process?.env?.FEISHU_APP_SECRET;
	return out;
}

/** 脱敏打印 wss 地址：保留 origin+path，查询串只列键名。 */
function redactWsUrl(url: string): string {
	try {
		const q = url.indexOf("?");
		const keys = q >= 0 ? [...new URLSearchParams(url.slice(q + 1)).keys()] : [];
		return `${url.slice(0, q < 0 ? url.length : q)}?${keys.map(k => `${k}=…`).join("&")}`;
	} catch {
		return "(无法解析的地址)";
	}
}

/** 事件 payload 摘要（只截片段，不打印正文全文） */
function summarizeEventPayload(raw: string): string {
	try {
		const evt = JSON.parse(raw) as { header?: { event_type?: string }; event?: { sender?: { sender_id?: { open_id?: string } }; message?: { message_type?: string } } };
		const type = evt.header?.event_type ?? "(无 event_type)";
		const msgType = evt.event?.message?.message_type;
		const sender = evt.event?.sender?.sender_id?.open_id;
		return `event_type=${type}${msgType ? ` message_type=${msgType}` : ""}${sender ? ` sender=${sender}` : ""}`;
	} catch {
		return `非 JSON（前 120 字符）：${raw.slice(0, 120)}`;
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (!args.appId || !args.appSecret) {
		console.error("缺少凭证：--appId / --appSecret（或环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）");
		return MISSING_ARGS;
	}

	console.log(`① 换地址：POST ${resolveWsEndpointBase(args.base)}${FEISHU_WS_ENDPOINT_PATH}`);
	console.log("   （端点在域名根下，不在 /open-apis 下 —— 带前缀会得到 404 page not found）");
	const res = await fetch(`${resolveWsEndpointBase(args.base)}${FEISHU_WS_ENDPOINT_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", locale: "zh" },
		body: JSON.stringify({ AppID: args.appId, AppSecret: args.appSecret }),
	});
	const text = await res.text();
	console.log(`   HTTP ${res.status}`);

	let endpoint: ReturnType<typeof parseWsEndpointResponse>;
	try {
		endpoint = parseWsEndpointResponse(JSON.parse(text));
	} catch (err) {
		console.error(`   ✗ 换地址失败：${err instanceof Error ? err.message : String(err)}`);
		console.error("   对症：code=1000040344 → 凭证缺失；code=1000040346 → app_id 无效（或不在当前租户）");
		return ENDPOINT_FAILED;
	}
	console.log(`   ✓ 拿到长连接地址：${redactWsUrl(endpoint.url)}`);
	console.log(`   ✓ ClientConfig：心跳 ${endpoint.clientConfig.pingIntervalSec}s，重连 count=${endpoint.clientConfig.reconnectCount} interval=${endpoint.clientConfig.reconnectIntervalSec}s nonce=${endpoint.clientConfig.reconnectNonceSec}s`);

	const serviceId = extractServiceId(endpoint.url);
	console.log(`② 建连：service_id=${serviceId}`);

	return new Promise<number>((resolve) => {
		const ws = new WebSocket(endpoint.url);
		ws.binaryType = "arraybuffer";
		let opened = false;
		let sawAnyFrame = false;
		let pingTimer: ReturnType<typeof setInterval> | undefined;
		let config = endpoint.clientConfig;

		const timeout = setTimeout(() => {
			if (!opened) {
				console.error("   ✗ 超时未完成握手");
				try { ws.close(); } catch { /* noop */ }
				resolve(HANDSHAKE_FAILED);
				return;
			}
			if (!sawAnyFrame) {
				console.error(`   ✗ 已建连但 ${args.timeoutSec}s 内未收到任何帧 —— 多半是没收到 pong（服务端不回包）。`);
				console.error("     请到开放平台核对：事件订阅方式 = 长连接，且已勾选 im.message.receive_v1。");
				try { ws.close(); } catch { /* noop */ }
				resolve(NO_FRAMES);
				return;
			}
			// 收到过帧 → 成功
			console.log(`✓ 长连接可用（建连成功，${args.timeoutSec}s 内有帧往来）`);
			if (!args.keep) {
				try { ws.close(); } catch { /* noop */ }
				resolve(OK);
			}
		}, args.timeoutSec * 1000);

		ws.onopen = () => {
			opened = true;
			console.log("   ✓ WS 握手成功");
			const ping = () => {
				try { ws.send(buildPingFrame(serviceId)); } catch { /* noop */ }
			};
			ping();
			pingTimer = setInterval(ping, Math.max(1_000, config.pingIntervalSec * 1000));
		};
		ws.onerror = () => {
			console.error("   ✗ WS 握手失败（浏览器/undici 读不到 handshake-status/msg 响应头，请检查：应用已开启长连接、事件已勾选、凭证与租户正确）");
			clearTimeout(timeout);
			resolve(HANDSHAKE_FAILED);
		};
		ws.onclose = (ev) => {
			clearInterval(pingTimer);
			if (!opened) {
				console.error(`   ✗ 未 open 即关闭（code=${ev.code}）`);
				clearTimeout(timeout);
				resolve(HANDSHAKE_FAILED);
				return;
			}
			console.log(`   · 连接已断开（code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ""}）`);
			if (args.keep) {
				// keep 模式下退出（不重连，探针的职责是诊断不是长跑）
				clearTimeout(timeout);
				resolve(OK);
			}
		};
		ws.onmessage = (ev) => {
			sawAnyFrame = true;
			const data = ev.data;
			if (typeof data === "string") {
				console.log(`   ← 文本帧：${data.slice(0, 160)}`);
				return;
			}
			let frame;
			try {
				frame = decodeFeishuFrame(new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer as ArrayBuffer));
			} catch (err) {
				console.log(`   ← 帧解码失败：${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			const type = frameHeader(frame, FRAME_HEADER.TYPE);
			const mid = frameHeader(frame, FRAME_HEADER.MESSAGE_ID);
			const sum = frameHeader(frame, FRAME_HEADER.SUM);
			const seq = frameHeader(frame, FRAME_HEADER.SEQ);
			console.log(`   ← 帧 method=${frame.method}(${frame.method === FRAME_METHOD.CONTROL ? "CONTROL" : "DATA"}) type=${type ?? "-"}${mid ? ` message_id=${mid}` : ""}${sum ? ` sum=${sum} seq=${seq}` : ""}`);

			if (frame.method === FRAME_METHOD.CONTROL) {
				if (type === MESSAGE_TYPE.PONG && frame.payload.length > 0) {
					const next = parseClientConfig(JSON.parse(decodeUtf8(frame.payload)));
					if (next.pingIntervalSec !== config.pingIntervalSec) {
						config = next;
						console.log(`   ↺ 服务端更新了 ClientConfig：心跳 → ${config.pingIntervalSec}s`);
					}
				}
				return;
			}
			// DATA：事件 → 打印摘要 → 回执
			if (type === MESSAGE_TYPE.EVENT) {
				console.log(`     事件：${summarizeEventPayload(decodeUtf8(frame.payload))}`);
				const start = Date.now();
				try {
					ws.send(buildAckFrame(frame, Date.now() - start, true));
					console.log("     → 已回执 {\"code\":200}");
				} catch (err) {
					console.error(`     → 回执失败：${err instanceof Error ? err.message : String(err)}`);
				}
			}
		};
	});
}

main().then(code => {
	process.exit(code);
}).catch(err => {
	console.error(`探针异常：${err instanceof Error ? err.message : String(err)}`);
	process.exit(5);
});
