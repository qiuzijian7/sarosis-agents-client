/**
 * 本插件的 HTTP 路由（2026-11-07）：右栏「浏览器」页签读交接卡与授权、人点按钮写回来。
 *
 * 挂在 Host 的 web server 上（`/x/vssaros-browser/api/*`，同源相对路径），三道闸：
 *   ① `connection.requestRejection(req)`：Host 头 / Origin 围栏 + 已登录的浏览器（Host 签发的 cookie）——
 *      与其它插件（agents / bridge / chat-surface）同一道；
 *   ② 写操作只认 `POST` + `content-type: application/json` + `x-vssaros-browser: 1`（跨站表单发不出这个组合）；
 *   ③ body ≤ 16 KB。
 * 模型够不着它：它是给右栏页签（人看着的那个页面）用的，没有任何工具 op 会调它。
 */

import { GRANTABLE_OPS, GRANT_DURATIONS } from './grants.js';

export const ROUTE_PREFIX = '/x/vssaros-browser';
const API = `${ROUTE_PREFIX}/api`;
const MAX_BODY = 16 * 1024;

async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) { throw Object.assign(new Error('body too large'), { status: 413 }); }
		chunks.push(chunk);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function send(res, status, value) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(value));
}

/**
 * @param {{ grants: ReturnType<import('./grants.js').createGrantStore>, handoffs: ReturnType<import('./handoff.js').createHandoffs>,
 *   reject?: (req: unknown) => number | undefined, log?: (line: string) => void, currentUrl?: () => Promise<string | undefined> }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRouteHandler({ grants, handoffs, reject = () => undefined, log = () => {}, currentUrl = async () => undefined }) {
	return async (req, res) => {
		const rejected = reject(req);
		if (rejected) { res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String(rejected)); return; }
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const path = url.pathname;
		try {
			if (req.method === 'GET' && path === `${API}/state`) {
				let page;
				try { page = await currentUrl(); } catch { page = undefined; }
				send(res, 200, { grants: grants.list(), handoffs: handoffs.list(), grantable: GRANTABLE_OPS, durations: GRANT_DURATIONS, ...(page ? { page } : {}) });
				return;
			}
			if (req.method !== 'POST' || !path.startsWith(`${API}/`)) { send(res, 404, { error: 'not found' }); return; }
			if (!String(req.headers?.['content-type'] ?? '').startsWith('application/json') || req.headers?.['x-vssaros-browser'] !== '1') {
				send(res, 403, { error: 'write requests need content-type: application/json and x-vssaros-browser: 1' });
				return;
			}
			const body = await readJson(req);
			if (path === `${API}/grants`) {
				if (!GRANT_DURATIONS.includes(body?.duration)) { send(res, 400, { error: `duration must be one of ${GRANT_DURATIONS.join(', ')}` }); return; }
				const grant = grants.add({ host: body?.host, duration: body.duration, ...(Array.isArray(body?.ops) ? { ops: body.ops } : {}) });
				log(`[vssaros-browser] 授权：${grant.host} 的 ${grant.ops.join('/')} 免问到 ${grant.until}（右栏浏览器页签，人点的）`);
				send(res, 200, { grant });
				return;
			}
			if (path === `${API}/grants/revoke`) {
				const ok = grants.revoke(String(body?.id ?? ''));
				if (ok) { log(`[vssaros-browser] 撤销授权 ${String(body.id)}`); }
				send(res, ok ? 200 : 404, { ok });
				return;
			}
			if (path === `${API}/handoffs/act`) {
				const card = handoffs.act(String(body?.id ?? ''), String(body?.action ?? ''));
				if (card) { log(`[vssaros-browser] 交接卡 ${card.id}：${String(body.action)} ⇒ ${card.state}`); }
				send(res, card ? 200 : 404, card ? { handoff: card } : { error: 'no such open handoff' });
				return;
			}
			send(res, 404, { error: 'not found' });
		} catch (error) {
			const status = typeof error?.status === 'number' ? error.status : 400;
			send(res, status, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}

/** 挂到 Host 的 web server 上（`ctx.inject(['webServer','connection'])`，与其它插件同一写法）。没有 web server 就不挂。 */
export function registerRoutes(ctx, deps) {
	if (typeof ctx?.inject !== 'function') { return; }
	try {
		ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
			kind: 'prefix',
			path: ROUTE_PREFIX,
			handler: createRouteHandler({ ...deps, reject: req => page.connection.requestRejection(req) }),
		})));
	} catch (error) {
		deps.log?.(`[vssaros-browser] HTTP 路由没挂上（右栏的授权条 / 交接卡不可用，其余不受影响）：${error instanceof Error ? error.message : String(error)}`);
	}
}
