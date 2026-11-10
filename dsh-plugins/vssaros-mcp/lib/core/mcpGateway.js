// @vssaros/dsh-mcp — 远程 MCP 的**本地凭据网关**（凭据隔离）。
//
// 问题：mcp-client 只接受静态 headers。若把 `Authorization: Bearer <真 token>` 直接写进
// config，凭据会落在组合行/覆盖层/日志里，也没法在失效时刷新。上游 DS Bot 的做法是
// 「每台远程 server 挂一个 127.0.0.1 反向代理」：mcp-client 只看到回环 URL + 一次性 nonce，
// 真凭据在网关转发时才注入。这里是同款最小实现。
//
// 纪律：
//   ① 只监听 127.0.0.1，端口由系统分配；每个进程一个随机 nonce（timingSafeEqual 校验）；
//   ② **只放行 https 上游**（离线单测可显式 allowInsecure 用本地 http 做 fixture）；
//   ③ 转发 MCP 会话头、回传 Mcp-Session-Id，响应体按流 pipe（SSE 不被缓冲）；
//   ④ 下游断开即 abort 上游；401 重新解析凭据并重试一次（失败不静默吞）；
//   ⑤ 只处理「带 headers 的 http 条目」；无凭据的远程服务仍直连，不额外占端口。
//
// 开关：`VSSAROS_MCP_GATEWAY=0` 关闭（回退到明文 headers 直连）；缺省启用。

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const FORWARD_HEADERS = ['mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'accept', 'content-type'];
const RETURN_HEADERS = ['mcp-session-id', 'mcp-protocol-version', 'content-type'];
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export const isMcpGatewayEnabled = (env = process.env) => env?.VSSAROS_MCP_GATEWAY !== '0';

/** `${env:VAR}` / `${VAR}` 解析；缺变量返回 undefined（调用方拒绝该请求，不把占位符原样传出去）。 */
export function resolveSecretRefs(text, env) {
	const missing = [];
	const out = String(text ?? '').replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
		const value = env?.[name];
		if (typeof value !== 'string') { missing.push(name); return full; }
		return value;
	});
	return missing.length ? { error: `环境变量未设置：${missing.join(', ')}` } : { value: out };
}

function safeEqual(a, b) {
	const left = Buffer.from(String(a ?? ''));
	const right = Buffer.from(String(b ?? ''));
	return left.length === right.length && timingSafeEqual(left, right);
}

function jsonRpcError(res, status, code, message) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * 创建网关（未 listen 前不占端口）。`routes` 由调用方按 mcp.json 的 http 条目注册。
 * `env` 可注入（离线守卫用固定 fixture），缺省 process.env。
 */
export function createMcpGateway({ env = process.env, warn = () => {}, allowInsecure = false, fetchImpl = globalThis.fetch } = {}) {
	const nonce = randomBytes(32).toString('hex');
	const routes = new Map();
	let server = null;
	let port = 0;

	const handler = async (req, res) => {
		const auth = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '');
		if (!safeEqual(auth, nonce)) { jsonRpcError(res, 401, -32001, 'mcp gateway: unauthorized'); return; }
		let id;
		try { id = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/c\//, '')); }
		catch { jsonRpcError(res, 404, -32602, 'mcp gateway: bad path'); return; }
		const route = routes.get(id);
		if (!route) { jsonRpcError(res, 404, -32602, `mcp gateway: no server ${id}`); return; }
		if (!/^https:\/\//i.test(route.url) && !allowInsecure) {
			jsonRpcError(res, 403, -32003, 'mcp gateway: only https upstreams are allowed'); return;
		}
		const headers = {};
		for (const name of FORWARD_HEADERS) {
			if (typeof req.headers?.[name] === 'string') { headers[name] = req.headers[name]; }
		}
		for (const [name, raw] of Object.entries(route.headers ?? {})) {
			const resolved = resolveSecretRefs(raw, env);
			if (resolved.error) { jsonRpcError(res, 400, -32002, `mcp gateway: ${resolved.error}`); return; }
			headers[name] = resolved.value;
		}
		// query 型凭据（如 Amap 的 ?key=...）：同样在**转发时**才解析，真值不进 URL 配置。
		let targetUrl = route.url;
		try {
			const query = route.query ?? {};
			if (Object.keys(query).length) {
				const u = new URL(route.url);
				for (const [name, raw] of Object.entries(query)) {
					const resolved = resolveSecretRefs(raw, env);
					if (resolved.error) { throw new Error(resolved.error); }
					u.searchParams.set(name, resolved.value);
				}
				targetUrl = u.toString();
			}
		} catch (error) {
			jsonRpcError(res, 400, -32002, `mcp gateway: ${String(error?.message ?? error)}`);
			return;
		}
		const chunks = [];
		let size = 0;
		try {
			for await (const chunk of req) {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) { jsonRpcError(res, 413, -32004, 'mcp gateway: body too large'); return; }
				chunks.push(chunk);
			}
		} catch { jsonRpcError(res, 400, -32700, 'mcp gateway: bad request body'); return; }
		const body = chunks.length ? Buffer.concat(chunks) : undefined;
		const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
		const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : undefined;
		let aborted = false;
		const onClose = () => { aborted = true; controller?.abort(); };
		res.on('close', onClose);
		try {
			let response = await fetchImpl(targetUrl, {
				method: req.method ?? 'POST', headers, body, signal: controller?.signal,
			});
			// 401：重新解析凭据后重试一次（给 token 轮换留出窗口）；仍 401 就如实回传。
			if (response.status === 401) {
				const refreshed = {};
				for (const [name, raw] of Object.entries(route.headers ?? {})) {
					const resolved = resolveSecretRefs(raw, env);
					refreshed[name] = resolved.error ? raw : resolved.value;
				}
				response = await fetchImpl(targetUrl, {
					method: req.method ?? 'POST', headers: { ...headers, ...refreshed }, body, signal: controller?.signal,
				});
			}
			const outHeaders = {};
			for (const name of RETURN_HEADERS) {
				const value = response.headers?.get?.(name);
				if (value) { outHeaders[name] = value; }
			}
			res.writeHead(response.status, outHeaders);
			if (aborted) { res.end(); return; }
			if (response.body) { Readable.fromWeb(response.body).pipe(res); }
			else { res.end(); }
		} catch (error) {
			if (!res.headersSent) { jsonRpcError(res, 502, -32000, `mcp gateway: ${String(error?.message ?? error)}`); }
			else { res.end(); }
			warn(`[mcp-gateway] ${id}: ${String(error?.message ?? error)}`);
		} finally {
			if (timer) { clearTimeout(timer); }
			res.off('close', onClose);
		}
	};

	return {
		/** 注册/更新一台远程 server 的真实上游与凭据表达式。 */
		register(id, { url, headers, query }) { routes.set(id, { url, headers: headers ?? {}, query: query ?? {} }); },
		/** 删掉配置里已不存在的 server（避免陈旧路由继续持有凭据）。 */
		prune(activeIds) {
			const keep = new Set(activeIds ?? []);
			for (const id of routes.keys()) { if (!keep.has(id)) { routes.delete(id); } }
		},
		/** mcp-client 看到的 URL —— 不含任何凭据。 */
		urlFor(id) { return `http://127.0.0.1:${port}/c/${encodeURIComponent(id)}`; },
		/** mcp-client 看到的 headers —— 只有一次性 nonce。 */
		headers() { return { Authorization: `Bearer ${nonce}` }; },
		get port() { return port; },
		get size() { return routes.size; },
		async listen() {
			if (server) { return port; }
			server = createServer(handler);
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
			});
			// 网关不该阻止进程退出：插件的 effect cleanup 可能晚于首次 tick，
			// 有引用的 server 会让测试/Host 进程挂住（真机实测）。
			server.unref?.();
			port = server.address().port;
			return port;
		},
		async close() {
			routes.clear();
			if (!server) { return; }
			const current = server;
			server = null;
			port = 0;
			await new Promise(resolve => current.close(() => resolve()));
		},
	};
}
