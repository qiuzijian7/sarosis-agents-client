// @vssaros/dsh-pocket — Saros Pocket 的 Host 路由（重构 2.4，D8）。
//
// ── 这个插件是什么 ──────────────────────────────────────────────────────────
// 给 Saros-agents-pocket 扩展（手机端）一个 Host 上的 HTTP API（`/x/pocket/api/*`），
// 取代它现在经 `sarosPocket.*` 命令跨进程取的链路：
//   · `GET  /x/pocket/api/sessions` —— dsh 会话列表（读投影缓存，与 vssaros-sessions 同源）；
//   · `POST /x/pocket/api/send`     —— 往一条会话发消息（经 vssarosRuns 驱动，回传最终文本）。
//
// ── 鉴权（fail-closed）─────────────────────────────────────────────────────
// Bearer token：`config.token`（VsSaros 经 --patch 注入）→ 环境变量 `VSSAROS_POCKET_TOKEN`。
// **都没有 ⇒ 路由不注册**（没 token 的口袋路由 = 把会话操作暴露给局域网 ✗）。
// 这独立于 Host 自己的 Cookie 栅栏（`connection.requestRejection`）——两层都在 ✓。
//
// ── 依赖 ────────────────────────────────────────────────────────────────────
// webServer/connection/vssarosRuns 全走**可选注入**：缺了哪个路由就不注册，插件照常激活。

import { bindFoundation } from './foundationRef.js';
import { foundation } from './foundationRef.js';

export const name = 'vssaros-pocket';
export const inject = [];

const ROUTE_PREFIX = '/x/pocket';

/** token 解析：config → env；都没有 ⇒ undefined（路由不注册）。 */
export function tokenOf(config) {
	const fromConfig = typeof config?.token === 'string' ? config.token.trim() : '';
	if (fromConfig) { return fromConfig; }
	const fromEnv = typeof process.env.VSSAROS_POCKET_TOKEN === 'string' ? process.env.VSSAROS_POCKET_TOKEN.trim() : '';
	return fromEnv || undefined;
}

/** Bearer 校验：命中才放行。 */
export function tokenOk(req, token) {
	const auth = typeof req?.headers?.authorization === 'string' ? req.headers.authorization : '';
	return auth === `Bearer ${token}`;
}

export function apply(ctx, config = {}) {
	{
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
			let svc = null;
			try { svc = child.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
			if (svc) { bindFoundation(svc); }
		});
	}

	const token = tokenOf(config);
	if (!token) {
		(typeof ctx.logger === 'function' ? ctx.logger('vssaros-pocket') : console).warn('没有 token（config.token / VSSAROS_POCKET_TOKEN 都没给）⇒ 路由不注册（fail-closed ✓）');
		return;
	}

	ctx.inject(['webServer', 'connection'], webCtx => webCtx.effect(() => webCtx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			// 两层栅栏：Host 自己的（Cookie/来源）+ 本路由的 Bearer token ✓
			const rejected = webCtx.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			if (!tokenOk(req, token)) {
				res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ error: 'unauthorized: 缺或错 Bearer token' }));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://localhost');
			const json = (status, body) => {
				res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify(body));
			};
			if (url.pathname === `${ROUTE_PREFIX}/api/sessions` && req.method === 'GET') {
				try {
					json(200, { sessions: await listSessions(ctx, config) });
				} catch (e) {
					json(500, { error: String(e?.message ?? e) });
				}
				return;
			}
			if (url.pathname === `${ROUTE_PREFIX}/api/send` && req.method === 'POST') {
				try {
					const body = JSON.parse(await readBody(req));
					json(200, await sendMessage(ctx, body));
				} catch (e) {
					json(500, { ok: false, error: String(e?.message ?? e) });
				}
				return;
			}
			json(404, { error: `unknown pocket route: ${url.pathname}` });
		},
	})));
}

/** 列会话：读 dsh 的投影缓存（与 vssaros-sessions 同源；读不到 ⇒ 空数组，不谎报）。 */
async function listSessions(ctx, config) {
	const dir = projCacheDir(config);
	let files = [];
	try {
		const { readdir } = await import('node:fs/promises');
		files = (await readdir(dir)).filter(f => f.endsWith('.json'));
	} catch {
		return [];  // 缓存目录不存在 ⇒ 没有会话（如实的空 ✓）
	}
	const out = [];
	for (const f of files.slice(0, 300)) {
		try {
			const { readFile } = await import('node:fs/promises');
			const data = JSON.parse(await readFile(join2(dir, f), 'utf8'));
			out.push({
				sessionId: String(data?.sessionId ?? f.replace(/\.json$/, '')),
				title: String(data?.title ?? data?.displayTitle ?? ''),
				cwd: String(data?.cwd ?? ''),
				updatedAt: data?.updatedAt ?? null,
			});
		} catch { /* 单条坏了不拖垮整列 */ }
	}
	return out;
}

/** 发消息：经 vssarosRuns 驱动（等回合跑完回传最终文本）。 */
async function sendMessage(ctx, body) {
	const runs = runsOf(ctx);
	if (!runs) {
		return { ok: false, error: '回合服务不可用（vssarosRuns 未提供——bridge 0.2.26+ 才有）' };
	}
	const sessionId = String(body?.sessionId ?? '').trim();
	const text = String(body?.text ?? '').trim();
	const cwd = String(body?.cwd ?? '').trim();
	if (!sessionId) { return { ok: false, error: '缺 sessionId' }; }
	if (!text) { return { ok: false, error: '缺 text' }; }
	if (!cwd) { return { ok: false, error: '缺 cwd（dsh 会话必须有工作目录）' }; }
	const result = await runs.run({ sessionId, cwd, prompt: text, approval: { allow: [] } });
	return {
		ok: result.stopReason === 'completed',
		sessionId: result.sessionId,
		stopReason: result.stopReason,
		finalText: result.finalText,
		elapsedMs: result.elapsedMs,
	};
}

function runsOf(ctx) {
	try {
		return ctx.get?.('vssarosRuns') ?? ctx.vssarosRuns ?? undefined;
	} catch {
		return undefined;
	}
}

function projCacheDir(config) {
	const home = foundation().dshHomeOf(config);
	return join2(home, 'storages', 'session_projcache', 'sessions');
}

function join2(...parts) {
	return parts.join('/').replace(/\/+/g, '/');
}

function readBody(req) {
	return new Promise((resolveBody, reject) => {
		let buf = '';
		req.on('data', c => { buf += c; if (buf.length > 256 * 1024) { req.destroy(); reject(new Error('body too large')); } });
		req.on('end', () => resolveBody(buf));
		req.on('error', reject);
	});
}
