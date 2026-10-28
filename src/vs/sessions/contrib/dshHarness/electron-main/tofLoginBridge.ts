/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **TOF（IOA）自动登录桥**：把浏览器里的 IOA 登录变成**全自动**的网页登录。
 *
 * ## 为什么需要它（背景）
 *
 * TOF 网关把票据 302 到 `http://127.0.0.1:<cb_port>` ⇒ 票据**只能落在用户自己的机器上**；
 * 而中转站跑在服务器上（DevCloud）⇒ 它自己拿不到票据，也**够不到 IDC 的 TOF 网关**
 * （igate 未开通）⇒ 以前只能让用户**手工粘贴票据** ✗。
 *
 * ⇒ 这里在**本机**开一个只监听 `127.0.0.1` 的小 HTTP 服务：
 *
 * ```
 * ① 浏览器点「用企业身份登录」→ 打开 passport URL（带一次性 state）
 * ② IOA 登录完成 → 网关 302 到 127.0.0.1:17890/got?identity=<票据>&state=<state>
 * ③ **本机**拿票据调 IDC 网关 whoami（★ 本机够得到 IDC ⇒ 能验票）
 * ④ 身份 + state 交给中转站 → 换一个**一次性 code**
 * ⑤ 把浏览器 302 回 中转站 /api/auth/tof/callback?code=… → 换到会话令牌（fragment）
 * ```
 *
 * ⇒ 用户只需点一下 + 完成一次 IOA 登录，其余全自动；**票据不出本机**。
 *
 * ## 安全边界
 *
 * - 只监听 `127.0.0.1`（外部机器访问不到）；
 * - `state` 由中转站生成并校验（一次性、5 分钟）⇒ 票据不能被别人冒用；
 * - 会话令牌**不进 URL 查询串**（中转站把令牌放在 fragment 里）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import { IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * 中转站地址（与 dsh 侧 `vssaros-relay` 同一份 ⇒ 改一处要记得改另一处）。
 *
 * ⚠ 2026-10-28：这三个常量原先住在 `nodeAgentHost.ts` 里 —— 那份**主进程侧**的 Node Agent 宿主
 *   已按要求删除（只保留 **dsh Host 侧插件**里的那一份实现）⇒ 常量随它的唯一消费者搬到这里。
 */
export const DEFAULT_RELAY_URL = 'http://zijianqiu-any1.devcloud.woa.com:8000/';

/**
 * 自动注册密钥（**窄作用域**：只能注册节点 + 读号池摘要，换不到管理员权限）。
 *
 * ⚠ 与 `dsh-plugins/vssaros-relay/lib/index.js` 的 `DEFAULT_ENROLL_KEY` **必须逐字一致**
 *   （两边不能互相 import —— 插件是随包独立分发的 JS 包 ⇒ 由注释与人工对账保证）。
 */
export const DEFAULT_ENROLL_KEY = 'ccd6d985cdf1cfa69b124046b8784e7194ac896a17ed408b';

/**
 * TOF（IOA）身份网关（whoami / 回调）。
 *   本机（IDC 内的开发机）能访问它；**服务器**（DevCloud）不能（igate）⇒
 *   所以票据必须在**本机**验证（见 `tofLoginBridge.ts`）。
 */
export const DEFAULT_TOF_GATEWAY_URL = 'http://21.169.46.116:8080';

/** 本机回调端口（★ 与中转站 `api/auth.py` 的 `DEFAULT_TOF_CALLBACK_PORT` **必须一致**）。 */
export const TOF_CALLBACK_PORT = 17890;

export interface ITofLoginBridge extends IDisposable {
	readonly port: number;
}

export function createTofLoginBridge(options: {
	readonly relayUrl?: string;
	readonly enrollKey?: string;
	readonly gatewayBaseUrl?: string;
	readonly log?: (message: string) => void;
}): ITofLoginBridge {
	const log = options.log ?? (() => { });
	const relayUrl = (options.relayUrl ?? DEFAULT_RELAY_URL).trim().replace(/\/+$/, '');
	const enrollKey = (options.enrollKey ?? DEFAULT_ENROLL_KEY).trim();
	const gatewayBaseUrl = (options.gatewayBaseUrl ?? DEFAULT_TOF_GATEWAY_URL).trim().replace(/\/+$/, '');

	/** 本地验票：票据 → 身份（whoami 协议）。 */
	const fetchIdentity = async (ticket: string): Promise<Record<string, unknown> | undefined> => {
		const response = await fetch(`${gatewayBaseUrl}/api/v1/whoami`, {
			headers: { 'x-tai-identity': ticket },
		});
		if (!response.ok) {
			log(`[tof-bridge] whoami 失败 HTTP ${response.status}`);
			return undefined;
		}
		const body = await response.json() as Record<string, unknown>;
		return body && body.staff_id ? body : undefined;
	};

	/** 身份 + state → 一次性 code。 */
	const exchangeCode = async (identity: Record<string, unknown>, state: string): Promise<string> => {
		const response = await fetch(`${relayUrl}/api/auth/tof/client-login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-enroll-key': enrollKey },
			body: JSON.stringify({ identity, state }),
		});
		const text = await response.text();
		if (!response.ok) {
			log(`[tof-bridge] 换 code 失败 HTTP ${response.status}: ${text.slice(0, 160)}`);
			return '';
		}
		try {
			const data = JSON.parse(text) as { code?: string };
			return String(data.code || '');
		} catch {
			return '';
		}
	};

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url || '/', `http://127.0.0.1:${TOF_CALLBACK_PORT}`);
		if (url.pathname === '/health') {
			response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('ok');
			return;
		}
		if (url.pathname !== '/got') {
			response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('not found');
			return;
		}

		const ticket = String(url.searchParams.get('identity') || '').trim();
		const state = String(url.searchParams.get('state') || '').trim();
		if (!ticket || !state) {
			response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
			response.end('<meta charset="utf-8"><p>缺少票据或 state，请重新发起登录。</p>');
			return;
		}

		try {
			const identity = await fetchIdentity(ticket);
			if (!identity) {
				response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
				response.end('<meta charset="utf-8"><p>票据校验失败（whoami 未通过），请重新登录。</p>');
				return;
			}
			const code = await exchangeCode(identity, state);
			if (!code) {
				response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
				response.end('<meta charset="utf-8"><p>换取登录码失败，请重新发起登录。</p>');
				return;
			}
			const target = `${relayUrl}/api/auth/tof/callback?code=${encodeURIComponent(code)}`;
			log(`[tof-bridge] 登录成功 ⇒ ${String(identity.login_name || '')}（${String(identity.staff_id || '')}）`);
			response.writeHead(302, { location: target });
			response.end();
		} catch (error) {
			log(`[tof-bridge] 处理失败：${String(error)}`);
			response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
			response.end('<meta charset="utf-8"><p>本地登录处理失败，请重新发起登录。</p>');
		}
	};

	let server: Server | undefined;
	try {
		server = createServer((request, response) => {
			void handle(request, response);
		});
		server.on('error', (error) => {
			log(`[tof-bridge] 监听失败（端口 ${TOF_CALLBACK_PORT}）：${String(error)}`);
		});
		server.listen(TOF_CALLBACK_PORT, '127.0.0.1');
		log(`[tof-bridge] 已监听 http://127.0.0.1:${TOF_CALLBACK_PORT}/got`);
	} catch (error) {
		log(`[tof-bridge] 启动失败：${String(error)}`);
	}

	return {
		get port() { return TOF_CALLBACK_PORT; },
		dispose() {
			try {
				server?.close();
			} catch {
				/* ignore */
			}
			server = undefined;
			log('[tof-bridge] 已停止');
		},
	};
}
